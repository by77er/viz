# Review: D77, a 429 stores nothing (`Shard.reserve`, grants held in memory, a known refusal refused before decoding)

Reviewer: did not build D77 and was not given the builder's reasoning beyond the repository. Read-only
on the shared tree except for this file: nothing else was edited, committed, pushed or deployed.
Every reproduction and every mutant ran in a detached worktree and a copy in the scratchpad. Tests
used at most 2 workers, under the machine lock. No Rust build, no Cloudflare call, Cloudflare
credentials removed from every command. Date: 2026-11-28.

## Scope and what was run

- **Commit read.** `01e2770` on `claude/cloudflare-observability-platform-ibaqya-ingest2` (five
  commits over `origin/main`: contract `8573cf7`, shard `480e7ac`, edge `26c3559`, design `702141c`,
  spike `01e2770`). The contract change has its own commit, as AGENTS.md asks.
- **Files read.** `design/DECISIONS.md` D77 (and D37, D57, D61, D63, D66, D71, D72 for context);
  `contracts/BATCH.md` ("What a refusal stored"); `edge/src/route.ts`, `edge/src/early.ts`,
  `edge/src/index.ts`, `edge/src/recorded.ts`; `shard/src/shard.ts` (`reserve`, `release`,
  `takeGrant`, `overloaded`, `roomRefusal`, `append`, `commitGroup`); `shard/test/reserve.test.ts`,
  `edge/test/atomic.test.ts`; both `mutants.mjs`; `edge/README.md`, `shard/README.md`;
  `spikes/s15-ingest-atomic/README.md`.
- **Baseline at `01e2770`** (measured here, local workerd, the Workers test runtime):
  shard suite **130 passed of 130** (14 files); edge suite **146 passed of 146** (14 files);
  `edge` `tsc --noEmit` exit 0. `shard` `tsc` was run on a copy without `engine/` and reported only
  the missing engine modules; not re-run with `engine/` present. This matches the READMEs.
- **Run for this review:**
  - `edge/test/zz-review.test.ts` (5 tests) and `shard/test/zz-review.test.ts` (5 tests), the
    reviewer's, in the scratch worktree only (reproduction index at the end);
  - 9 mutants of the reviewer's own on a copy of `contracts/ shard/ edge/ ledger/`, each against
    `atomic`, `flow`, `overload` and `limit` (35 tests; **a subset of the edge suite, not all of it**);
  - one experiment on which `viz_engine.wasm` the shard tests load (the "ABI 2" question).

## Findings

Counts: **0 blockers, 2 majors, 6 minors, 3 nits.**

### M-1 (major): the in-flight limits now bound a request's whole share of one shard, held for its whole append sequence; a valid request can be refused 503 forever, and two large requests can no longer share a shard

- **Where.** `shard/src/shard.ts` `reserve` → `overloaded(need.size, bytes)`:
  `this.inFlight + this.grantedBatches + batches > maxInFlight || this.pendingBytes + this.grantedBytes + bytes > maxPendingBytes`,
  with `batches` and `bytes` the **sum** of every batch the request sends to that shard. Edge
  (`appendSlot`) then sends those batches one at a time, each awaiting its group commit; the
  batches not yet sent stay in `grantedBatches`/`grantedBytes` the whole time.
- **What changed.** D37's limits (64 appends, 16 MB pending) bound what an acknowledgement waits
  behind. Before D77 a request held at most one batch of them at a time (sequential appends). Now a
  multi-batch request needs its whole one-shard total free at one instant and keeps it until its last
  batch commits. Granted batches hold no payload in the shard: nothing about memory or the group
  is bounded by counting them.
- **Reproductions** (measured here, local workerd; `edge/test/zz-review.test.ts`):
  - **R1a, permanent, configured batch size.** One-slot tenant, `INGEST_LIMITS` `maxBatchBytes:
    16384` (a supported setting; `atomic.test.ts` uses it), 3,000 spans of 400 bytes in one service
    (more than 64 batches to the one shard). Three attempts on an idle shard: **503, 503, 503**
    (`stats`: `refusedOverload` 3, `inFlight` 0, `reservations` 0). The same body with `reserve`
    removed (the pre-D77 path, as the skew test does it): **200**. The same follows whenever a shard's
    smaller `maxBatchBytes` makes edge re-split (`too_large`) into more than 64 batches per shard.
  - **R1b, permanent, default limits.** One service, 140,000 minimal spans and four resource
    attributes of 62,000 bytes; the body is 7.53 MB and decodes within every edge limit. The resource
    entry is repeated in every batch, so the batches to the one shard exceed 16 MiB: **503, 503**
    on an idle shard; with `reserve` removed, **200**. Senders retry 503 until they give up, so this
    request is never stored where before D77 it was.
  - **R1c, concurrency, default limits.** Two concurrent bodies of 7.94 MB (17,000 spans of 400
    bytes each, about 8.5 MiB of batches each) to one shard, every append delayed by 20 ms (a
    stand-in for commit latency on Cloudflare, which local workerd does not have): **200 and 503**.
    The same pair with `reserve` removed: **200 and 200**.
  - Each refusal calls `noteOverload`, so `refuseEarly` then answers every request of the tenant
    503 before decoding while its shards are "hot": for a tenant with one slot, one request that can
    never be admitted keeps all of that tenant's requests refused, one `Retry-After` after another.
- **D37's numbers do not cover this.** S3 sent 50 series per request (one batch, no `reserve`).
  Multi-batch load against the in-flight limit is not measured, here or on Cloudflare. The shard
  README's risk ("a small request can be refused `overload` a few milliseconds earlier") understates
  it.
- **Smallest fix.** Count a grant against the in-flight limits as an append of its **largest batch**
  would count: one slot and `max(bytes)`, not `batches` and `sum(bytes)`. Equivalently, `reserve`
  checks load as `inFlight + grants + 1 > maxInFlight || pendingBytes + maxBatch > maxPendingBytes`
  (each grant appends one batch at a time), and room (tenant cap, fair share, ceiling) keeps the
  sum. Add tests: a request of more than `maxInFlight` batches, and one of more than
  `maxPendingBytes`, to an idle shard are accepted; R1c gives 200 and 200.

### M-2 (major): grants of batches that were never sent are not released when an append of the request is refused; they hold room and in-flight slots of every tenant for 5 s, and the request's own next round counts them

- **Where.** `edge/src/route.ts` `appendSlot` returns at the first refusal of a slot (`series_limit`,
  `stale_epoch`, `registering` at append, `invalid`, a thrown call); the slot's remaining batches are
  never sent and their grant is never released (`release` is called only when `reserve` itself was
  refused). In the shard, `takeGrant` removes only the batch it appends.
- **Reproduction R2** (measured here; `edge/test/zz-review.test.ts`). One-slot tenant, active-series
  limit 10, a Remote Write body of 400 new series, `maxBatchBytes: 4096`. Each of the four rounds
  (0 to 3) reserves, is granted, has its first batch refused `series_limit` and leaks the rest. The
  request is answered 429 (correctly: nothing stored). **After the answer the shard still holds 4
  grants and 123,200 bytes** (`stats().reservations`, `reservedBytes`). With `maxInFlight` set to
  that count, **another tenant's append is refused `overload`** (`retryAfterMs` 1,882).
- **Effect.** A tenant at its series limit (a cardinality explosion, the case the limit exists for)
  turns each refused multi-batch request into in-flight slots held for `reservationTtlMs`. Modelled:
  at r requests per second with k leaked batches each, 5·r·k slots; at r = 4 and k = 4 that is 80,
  more than 64, and every tenant of the shard gets 503 until it stops. The same request's next round
  (re-route, re-split, series rounds) goes to the same Durable Object (`shardName` has no epoch) and
  is checked against its own leak, which can turn its next `reserve` into a refusal.
- **Smallest fix.** In `attempt`, after the appends, release every slot's token whose slot returned
  before sending all its batches (the slot knows how many it sent); or in the shard, drop the whole
  grant when an append under it is refused for anything but a duplicate. Test: `reservations` is 0
  on every shard after each outcome of `appendAll` (ok, 429, 503, series rounds, stale epoch).
- **Seen in passing, not D77's.** R2's request is 429 although no buffer is full: the series rounds
  learn one slot's refusals one batch per round, so a request with more new series than its share in
  more than three batches never converges. Present before D77 (the loop is unchanged); D77 only makes
  that 429 truthful.

### m-1 (minor): a request larger than its fair share is refused whole while the shard is over budget; before D77 it made progress batch by batch

- **Where.** `roomRefusal` at `reserve`: `held + bytes > fairShare` with `bytes` the request's whole
  total for the shard. "A tenant at or below its share is always admitted, so one tenant cannot
  starve another" (the comment it keeps) now holds only for requests smaller than the share.
- **Reproduction** (shard, `zz-review` "fair share"): `shardMaxBytes` 1,000, tenants b and c hold
  330 each; a reserves two batches of 200: refused `shard`; the first of the same batches appended
  alone (pre-D77) is admitted. While other tenants keep the shard over budget at their own shares, a
  tenant whose request exceeds `shardMaxBytes / sharers − held` is never admitted. With production
  values (512 MiB, requests up to about 16 MiB per shard) that needs more than about 32 active
  tenants on one shard over budget: an overload state, but the property D21's fair share promises.
- **Smallest fix.** At `reserve`, admit a tenant that holds nothing (`held === 0`) up to its cap
  whatever its share, bounded by the hard ceiling (twice the budget), which is what the per-batch
  rule allowed in effect.

### m-2 (minor): a tenant that holds only a grant is not counted among the sharers

`activeStreams()` counts streams with `bufferedBytes > 0`; `sharers = activeStreams() + (held === 0 ? 1 : 0)`.
A tenant whose `held` is a grant (or bytes waiting in the group) is in neither term, so every fair
share computed meanwhile, its own included, is too large. Reproduced at the shard (`zz-review`):
with b and c holding 330 each of a 1,000 budget and a holding a 300-byte grant, a's further
`reserve` of 100 is granted (share computed as 500, not 333); and with a holding a 900-byte grant on
an empty shard, tenant b's append of 900 is admitted (share computed as 1,000 for one sharer), so the
grant does not keep its room against another tenant's fair-share admission (the total reaches 1,800,
inside the 2x ceiling). Count a tenant with `held > 0` as a sharer.

### m-3 (minor): a grant lives 5 s from `reserve`, not from its last use

`appendSlot` awaits each append's commit, and `commitGroup` awaits `deliver()` (on a seal) and
`arm()` before answering. A slot with many batches on a slow shard can outlive its grant: the rest
are admitted as appends without a token and, if refused, the request is a 503 with part stored
(reproduced at the shard with a 100 ms TTL, `zz-review` "expires 5 s after reserve"). Extend
`expires` on each `takeGrant`, or scale the TTL by the batch count. Not measured on Cloudflare.

### m-4 (minor): eight properties of the edge side have no test that fails when they are broken

Mutants of the reviewer's own, on a copy, each against `atomic`, `flow`, `overload` and `limit` (35
tests; the whole edge suite was not run per mutant):

| # | Mutant | Result |
|---|---|---|
| M1 | an append that throws does not mark the request as stored (`stored.any = true` in `appendSlot`'s catch removed) | **survived** |
| M2 | the probe ignores a changed pool or epoch | **survived** |
| M3 | the body key without path, content type and encoding | **survived** |
| M4 | a duplicate counts as stored (a retry becomes 503 instead of 429) | **survived** |
| M5 | series rounds exhausted: 429 even after a stored part (the exact defect D77 fixes, in its third-round form) | **survived** |
| M6 | an accepted body is not forgotten | **survived** |
| M7 | every body hashed, no suspect gate | killed (`atomic` "Remote Write … refused before decoding", `flow` "OTLP gets 429 …") |
| M8 | the probe's `overload` answer ignored (429 where the shard said overload; Prometheus does not retry 429 by default, D37) | **survived** |
| M9 | an early refusal's `Retry-After` fixed at 1 s | survived; equivalent while the shard's room `Retry-After` is 1,000 ms |

M5 and M1 matter most: they are the 503 rule on paths the tests never take (the third series round
after a stored round; a thrown append followed by a re-route). The builder's 22 mutants (E1–E10,
S1–S12) were read, not re-run.

### m-5 (minor): the refused-body cache is bounded by count, not bytes

`early.ts` keeps at most 1,000 plans, each a list of every batch's fingerprint (64 characters) and
size, keyed by strings that include the request's raw `Content-Type` and `Content-Encoding`. With
default batches a plan is about 1–3 KB (D77's "about 1 KB"). With small batches (R1a's shape has
about 90 per request; a 16 KiB `maxBatchBytes` and an 8 MiB body about 500) a plan is tens of KB,
so 1,000 of them are tens of MB in an isolate where S10 measured up to 78.5 MiB per invocation.
Remember no plan over a fixed number of batches (64), or bound the cache by bytes.

### m-6 (minor): the stale-`viz_engine.wasm` failures are vitest's module cache in the shared `node_modules`

The builder saw 15 shard tests fail with `engine: module ABI 2, binding expects 4` in their worktree
and pass on a copy. Cause, demonstrated here: vitest's filesystem module cache
(`node_modules/.vitest-cache`, inside `/home/user/viz/shard/node_modules`, which every worktree
links) keys a module by its id and source text, and the cached transform of a test file holds the
**resolved absolute path** of `../../engine/wasm/js/viz_engine.wasm`, symlinks followed. A cache hit
does not resolve the import again. Experiment (`bounds.edge.test.ts`, which instantiates the engine
and checks its ABI): with an ABI-2 build copied into the worktree, **7 of 7 passed**; with no file
there at all, **7 of 7 passed**. Both loaded `/home/user/viz/engine/wasm/js/viz_engine.wasm`
(ABI 4), the target of the symlink the worktree had when the cache entry was written. The cache holds
entries pointing at 15 different trees' engines, 8 of them deleted (among them `ingest-before` and
`ingest-after`). The builder's worktree presumably met an entry written when its path resolved to an
ABI-2 build; that exact entry was not identified. Consequence beyond D77: a test run in a worktree
with linked `node_modules` can test against another tree's engine and pass or fail for that reason.
Fix: give each tree its own cache (`test.fsModuleCachePath`, or `--no-cache` /
`experimental.fsModuleCache: false` in the vitest configs) or delete `.vitest-cache` before a run
that is evidence; say so in AGENTS.md "Shared machine".

### n-1 (nit): `reserve` and the probe create a stream row and start a registration for requests that never append

In `logged` mode `reserve` calls `createStream` and `kick` for an unknown tenant, `hold: false`
included (shard `zz-review` "probe": the probe answers `registering` and `describe` then shows a
stream with `registered: false`). An append refused for room did the same before D77, so only the
probe and grants released after another shard's refusal are new. One stream row and one Ledger call;
no data.

### n-2 (nit): a probe answers for the plan of the earlier decode

The body key does not include `INGEST_LIMITS` or the tenant's active-series limit, and decoding
depends on the time (`new Collector(limits, Date.now())`, the accept window). Within the 5 minutes a
plan is kept, a probe can refuse a body whose fresh decode would be smaller (a lowered
`maxBatchBytes`, rows aged out of the window). Only while a shard refuses for room; harmless in
practice.

### n-3 (nit): an early refusal inside the `Retry-After` rounds up to a whole second

`retryAfter()` renders `ceil(ms / 1000)` with a minimum of 1, so an early refusal with 50 ms left
tells the sender 1 s. The same holds for any 429; within D77's "never longer" only to the second.

## What I attacked and found held

- **"A 429 stored nothing of the request."** No interleaving found in which `appendAll` answers 429
  after a batch of the same request was newly stored. `stored` is shared by every attempt of the
  request (re-route, re-split, series rounds), set by every non-duplicate `ok` and by every append
  that throws, and read only after `Promise.all` of the attempt's slots, so every fate is known when
  the status is chosen. Paths checked by reading and, where named, by test:
  - concurrent requests of the same body or of another sender: a twin in the open group answers the
    joiner `duplicate: true`, and if the group's transaction fails the joiner gets the error (stored
    counted);
  - the alarm, flush and seal between `reserve` and `append`: none refuses an append for room; a
    duplicate counted at `reserve` and then flushed keeps its fingerprint row (`payload IS NULL`, 15
    min), so it stays a duplicate;
  - a grant expired (m-3) or lost to eviction (`reserve.test.ts` "a grant is memory only", with
    `evictDurableObject`: after the restart the granted append is checked as one without a token and
    refused once the room is gone) is an append without a token, and a refusal after a stored part is
    a 503 (`atomic` "a grant lost between the two calls", which fakes the lost grant rather than
    evicting between edge's two calls, and the mutant E4 the builder lists). The reviewer's own
    eviction test failed on its premise (see m-2: the grant did not keep the room from tenant b even
    before the eviction) and was not re-run;
  - epoch changes (`stale_epoch` at `reserve` releases the other grants; at `append` the request
    re-routes with `stored` carried), `too_large`, registration (`registering` is answered 503);
  - a request whose batches go to one shard (one `reserve` for all of them, `atomic` "one shard,
    several batches"), and a request of one batch (no `reserve`; one append is all or nothing);
  - metrics, traces, logs, Loki push and the recorded-samples entrypoint all go through `appendAll`.
- **Expiry without an alarm.** Grants are swept at `reserve`, `append` and `stats`, the only places
  they are read. Each grant holds at least one batch counted in `grantedBatches`, which the overload
  check bounds by `maxInFlight`, so at most 64 grants exist: memory is bounded under churn.
- **Storage is the only source of truth.** Nothing durable is decided from a grant: it only lets an
  append skip the load and room checks, and losing it re-imposes them. Eviction loses nothing stored
  (`reserve.test.ts` and the reviewer's eviction test).
- **The cache in edge** is keyed by the tenant from the credential (`authenticate`), the signal, the
  path, the content type and encoding, and SHA-256 of the wire bytes; the same bytes from another
  tenant are decoded (`atomic`). A collision needs SHA-256's. An early refusal is never longer than
  the shard's `Retry-After` but for n-3 (mutant E6 kills the longer form), and after it only a fresh
  answer of the shards refuses.
- **Rows written.** None added by a grant (the builder's `rows.test.ts`: 24 and 24 per accepted
  request, 10 and 0 per refused one; read, not re-run).

## Cost (item 5), modelled unless said

- **Durable Object requests per accepted request of B batches over N shards** (B ≥ 2): before D77, B
  appends; after, B appends + N reserves. On a refusal at `reserve`: N reserves + up to N − 1
  releases, no appends. A resend after its `Retry-After` that edge remembers: N probes, then (if they
  pass) N reserves + B appends. N is 1 to 4 for the pools in use (`spread`), B is 2 to about 20 at
  default batch sizes.
- **Relative:** +N/B, that is **+10 % to +100 %** Durable Object requests on multi-batch requests
  (one-batch requests unchanged), more on the refusal and probe paths.
- **Absolute**, at the list price S10 read (US$0.15 per million Durable Object requests, ignoring
  allowances): **US$0.15 to US$0.60 per million accepted multi-batch requests**, plus up to US$0.45 per
  million refusals at `reserve`. At S10's load (about 130 requests over 2 shards) the extra is at most
  about 400 requests, **under US$0.0001**. Duration: the shards are active under load anyway; edge
  waits one more round trip of wall time, not CPU. Rows read: one index seek per batch at `reserve`
  (`batch_fp`), negligible at US$0.001 per million.
- **To settle it:** S15's stage run (planned, not done) with the Durable Object request count read
  from the analytics API for the window, against S10's run 1.

## Not checked, and why

- Anything on Cloudflare: how often a shard restarts between `reserve` and `append`, the round
  trip's cost in a colo, the share of retries that reach the isolate that refused them, the 503 rate
  of S10's load after D77, and R1c with real commit latency instead of a 20 ms stand-in. These need
  S15's stage run.
- The whole edge suite under each mutant (a 35-test subset was used); the builder's 22 mutants were
  not re-run.
- `shard` `tsc --noEmit` with `engine/` present (run only on a copy without it).
- The pre-existing series-round non-convergence (M-2, "seen in passing") was not investigated.

## Verdict

**Approve with changes.** The promise D77 makes holds: no path was found on which a 429 follows a
newly stored batch of the same request, and the 503 rule covers the lost-grant, skew and expiry
cases. M-1 and M-2 must be fixed before this is built on: M-1 turns valid requests into 503s that
never end (and, through `refuseEarly`, the rest of a small tenant's requests with them), and M-2
lets a tenant at its series limit fill a shard's in-flight limit for everyone. Both have a small fix
and a test that shows it. m-4's surviving mutants M1 and M5 should get tests with the fix.

## Reproduction index

All in the scratch worktree (`git worktree add --detach … 01e2770`), engine linked from
`/home/user/viz/engine/wasm/js/viz_engine.wasm` (ABI 4), `node_modules` linked from the shared tree.

| Id | File, test | Result here |
|---|---|---|
| R1a | `edge/test/zz-review.test.ts` "more batches to one shard than maxInFlight" | 503 ×3 idle; 200 without `reserve` |
| R1b | same, "default limits … exceed maxPendingBytes" | 503 ×2 idle; 200 without `reserve` |
| R1c | same, "two concurrent large requests" | 200 + 503; 200 + 200 without `reserve` |
| R2 | same, "a metrics request at the active-series limit leaves grants held" | 429; 4 grants, 123,200 bytes held after; another tenant refused `overload` |
| m-1, m-2, m-3, n-1 | `shard/test/zz-review.test.ts` (5 tests: 4 passed, the eviction test failed on its premise, which is m-2's second reproduction) | see the findings |
| m-4 | `scripts/mut.mjs` on a copy | 8 of 9 survived |
| m-6 | `scripts/abi-exp.sh` | 7 of 7 passed with an ABI-2 file and with none |

## Summary row for design/REVIEW.md

| `reviews/d77-ingest-reservations.md` | D77: room reserved on every shard before a multi-batch request appends (`Shard.reserve`, grants in memory for 5 s), a 429 stores nothing, a refused body refused before decoding while its shards still refuse it | 0 blockers, 2 majors (M-1 grants count a request's whole one-shard total against D37's in-flight limits for its whole append sequence: a request of more than 64 batches or 16 MiB to one shard is refused 503 forever, reproduced at default limits, and two ~8.5 MiB requests can no longer share a shard; M-2 grants of batches never sent after a mid-slot refusal (series limit, stale epoch) are not released: 4 grants and 123 KB held after a 429, another tenant refused `overload`), 6 minors (fair share starves requests larger than the share; grant-only tenants not sharers; TTL from reserve; 8 of 9 edge mutants survive, among them a 429 after a stored part in the third series round; the refused-body cache bounded by count; the "ABI 2" failures are vitest's module cache in the shared `node_modules`, which serves another tree's engine), 3 nits. Held: no 429 after a stored batch on any path read or tested, eviction covered by the 503 rule, grants bounded by `maxInFlight`, cache keyed by the credential's tenant. Approve with changes | |

## Dispositions (2026-11-28, by the builder, after the review)

Commits on `claude/cloudflare-observability-platform-ibaqya-ingest2` after `01e2770`: contract
`cd3b09b`, this review copied unchanged `4d119f8`, shard `6eee4c3`, edge `e8cea6f`, then the design
text, READMEs and S15. Every M-1, M-2, minor and n-1 test named here was run against a copy of
`01e2770` with the same test file and **failed there**, then passed on the fixed tree (measured here,
local workerd; logs in the scratch area). The m-4 tests pin properties that already held at
`01e2770`; mutants check them instead. Suites after the fixes: shard **138 of 138**, edge **162 of 162** (with the m-4 tests),
`tsc --noEmit` clean in both, each vitest run with `--no-cache` **and a module cache of its own**
(`--fsModuleCachePath`, see m-6: `--no-cache` alone does not turn the module cache off).

| Finding | Disposition | Test (fails on 01e2770, passes now) |
|---|---|---|
| **M-1** | **Fixed as suggested.** A live grant counts against D37's limits as one append in flight and its largest batch's bytes (`Grant.load`, `grantedLoad`, `grants.size`); room keeps the sum. While one of its batches waits in the group the grant still counts, so a request counts for at most two appends: conservative, chosen over exact tracking (D77, "Revised after the review", gives the alternatives and what would change it). | edge `admission.test.ts` R1a (3,000 spans at 16 KiB batches: 200 ×3, more than 64 batches stored; before 503 ×3), R1b (default limits, 7.5 MB body, more than 16 MiB of batches to one shard: 200 twice; before 503), R1c (two concurrent ~8.5 MiB requests, appends slowed 20 ms: 200 and 200; before 200 and 503); shard `reserve.test.ts` "M-1: … one append of its largest batch" (100 batches; 5 × 400 bytes against `maxPendingBytes` 1,000) and "M-1: the in-flight bound still holds" |
| **M-2** | **Fixed at both ends.** The shard drops what is left of a grant when an append under it is answered anything but `ok` (a duplicate is an `ok`) or throws; edge releases a slot's grant when the slot stops before its last batch (refusal, unknown status, throw). | edge R2 (series limit 10, 400 series, 4 KiB batches: no grant left after the answer, another tenant's append admitted at `maxInFlight` = the grants taken; before: grants held, refused `overload`); edge "after every outcome" (ok; a thrown append after the shard took its batch; `stale_epoch`, an unknown status, `overload`, `registering`, `invalid` mid-slot: 0 reservations on both shards; before: grants left); shard "a refusal under a grant drops what is left of it" (`stale_epoch`, `too_large`, `invalid`, `series_limit`; a twin duplicate keeps it) and "an append under a grant that throws" (the group's transaction failing) |
| **m-1** | **Fixed** (the suggestion, widened): at `reserve` a request is admitted when the tenant holds nothing **or its first batch fits its share**, which is what batch-by-batch appending gave its first batch before D77; the tenant's cap and the 2x ceiling still bound the whole. | shard "m-1: a request larger than its fair share is admitted when…" (the review's shape; a tenant holding nothing whose first batch is over its share; a tenant holding 300 whose first batch fits and whole does not; the ceiling still refuses) |
| **m-2** | **Fixed.** The fair share's denominator is every tenant holding anything on the shard (buffered, waiting in the group, or granted) plus the tenant asking. | shard "m-2: a tenant that holds only a grant is counted among the sharers" (both of the review's reproductions) |
| **m-3** | **Fixed.** Each append under a grant extends it to `reservationTtlMs` from that append. | shard "m-3: a grant lives reservationTtlMs from its last use" (300 ms TTL, appends 200 ms apart, the third 400 ms after `reserve`) |
| **m-4** | **Rerun against the whole edge suite** (not a subset), on a copy: before the new tests **7 of the 9 survived** (M1–M5, M8, M9; M6 was killed by the new m-5 test, M7 as in the review). A test was added for each survivor (`admission.test.ts`, "m-4"), M9 included (a unit test of `refuseKnown` with a 5 s `Retry-After`: equivalent at the HTTP level only while the shard's room `Retry-After` is 1 s). Rerun on a fresh copy: **9 of 9 killed** (killers in `edge/README.md`, "The review of D77"), with the fixes' own F1–F3. The builder's E1–E10 against the whole suite: 10 of 10 killed. Shard: S13–S21 added for the fixes; S19 survived the first run and was killed after a test case was added (`shard/README.md`). | `admission.test.ts` "m-4: …" R1–R6, R8, R9 |
| **m-5** | **Fixed.** Remembered plans are counted in estimated bytes (`planCost`: key, and 160 bytes per batch), at most 4 MiB per isolate, oldest forgotten first; a plan over a sixteenth of that (about 1,600 batches) is not remembered (its retries are decoded). | edge "m-5: the refused-body cache is bounded by bytes" (2 tests) |
| **m-6** | **Confirmed, and worse than described.** In this worktree, `npx vitest run --no-cache` still loaded an ABI-2 `viz_engine.wasm` (15 shard tests failed with `engine: module ABI 2, binding expects 4`) with the right file (ABI 4, sha256 `df0ed811…`) in place: in vitest 5.1.1 `--no-cache` turns off the *results* cache only; the module cache is `fsModuleCache` (`--no-fsModuleCache`, `--fsModuleCachePath <dir>`, or `VITEST_FS_MODULE_CACHE_PATH`). With `--fsModuleCachePath` set to a directory of this tree's own, shard passed 138 of 138. Also: the shared tree's own `engine/wasm/js/viz_engine.wasm` (sha256 `35419c5b…`, built 2026-11-19) is the ABI-2 build, not ABI 4, so a worktree that links to it, or a cache entry that points at it, tests the old engine. AGENTS.md's new rule (in the shared tree, not this branch) says `--no-cache`; it should say `--fsModuleCachePath` (or `--no-fsModuleCache`). Reported to the owner; not changed here. | the suite runs above |
| **n-1** | **Fixed for the probe.** `reserve(..., hold: false)` of a tenant the shard has no stream for creates none and starts no registration. A holding `reserve` still creates the stream and starts its registration, as the append it stands for would (it is what lets the retry be admitted). | shard "n-1: a probe (hold: false) of a tenant the shard does not know…" |
| **n-2** | **Not fixed.** The probe still asks the shards about the batches of the earlier decode. It refuses only while those exact batches are refused for room, and only within the 5 minutes a plan is kept; a fresh decode under a lowered `maxBatchBytes` or a moved accept window would meet the same full buffer. Keying by the limits would buy nothing measurable. | none |
| **n-3** | **Not fixed.** `Retry-After` is whole seconds (RFC 9110, delay-seconds); rounding up keeps "never shorter than the shard said". Every 429 has the same rounding. | none |
| Seen in passing: the series rounds learn one batch's refusals per round | **Not fixed** (pre-existing, outside D77). With M-2 fixed it no longer leaks grants; the request now ends 503 when a round had stored a part (R5's test) and 429 when none had. | edge R5 |

**Stage run (S15), measured on Cloudflare** (`spikes/s15-ingest-atomic/README.md`, "Stage run:
results"; 2026-11-28 12:56–13:05 UTC; deleted, inventory unchanged; about US$0.009): S10's run-1 load
from 4 client objects, 144 requests of 8,200 items over traces, logs and Loki. **No 503** in 323
attempts; the first trace of each of the 15 traces requests refused at the end was **not found**
(15 of 15 answered 404; S10 found 4 of 10); refused attempts cost **p50 4 ms of CPU** (S10: 198 ms),
70 of 77 sampled under 20 ms; the shard's `reserve` p50 3 ms, p90 74 ms inside the object; accepted
traces acknowledged in p50 752 ms (S10: 723). The review's R1c with real commit latency (two
concurrent ~8.5 MiB requests to one shard) was not run on Cloudflare.
