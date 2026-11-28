# Review, round 2: D77's fixes after `reviews/d77-ingest-reservations.md`

Reviewer: the author of the first review (did not build D77 or its fixes, was not given the builder's
reasoning beyond the repository). A narrow re-check of the fixes for the first review's findings, not a
fresh review of D77. Read-only on the shared tree except for this file: nothing else was edited,
committed, pushed or deployed. Every run was in a detached worktree of
`claude/cloudflare-observability-platform-ibaqya-ingest2` at **`7fb102b`**, every mutant on a copy of
it in the scratch area, `node_modules` linked from the shared tree, each vitest run with a module
cache of the worktree's own (`--fsModuleCachePath`), engines `viz_engine.wasm` sha256 `df0ed811…` (ABI
4) and `viz_query.wasm` copied in. Cloudflare credentials removed from every command, no Cloudflare
call, at most 2 test workers, heavy runs under the machine lock. Date: 2026-11-28.

## What was run (measured here, local workerd, the Workers test runtime)

| Run | Result |
|---|---|
| shard suite (excluding the reviewer's file) | **138 passed of 138** (14 files) |
| edge suite (excluding the reviewer's file) | **162 passed of 162** (15 files), `admission.test.ts` included |
| `npx tsc --noEmit`, shard and edge | exit 0, exit 0 (shard with `engine/` present, which round 1 could not do) |
| reviewer's `shard/test/zz-review2.test.ts` (6 tests: N1a, N1b, N2, N3, N4, N5) | 6 passed; their logged answers are the findings below |
| reviewer's `edge/test/zz-review2.test.ts` (N1 at the HTTP level, fixed vs. the pre-D77 path) | see N-1 |
| 11 mutants on a copy (4 of the builder's, 7 of the reviewer's), see "Mutants" | 9 killed, 2 survived (also against the whole shard suite) |

The suite counts match the dispositions (shard 138, edge 162). Commits after `e8cea6f` (the release S15
deployed) touch only design text, READMEs and spike files; no source changed between what was measured
on Cloudflare and what was reviewed.

## Round-1 findings: state

| Finding | State | Why |
|---|---|---|
| **M-1** | **Fixed** | See below. A grant counts one append slot and its largest batch; the review's R1a, R1b and R1c are tests in `admission.test.ts` (3,000 spans at 16 KiB batches: 200 ×3, more than 64 batches stored; 7.5 MB body with more than 16 MiB of batches: 200; two ~8.5 MiB requests with appends slowed: 200 and 200) and pass here. The bounds still hold (argument below). The double count it keeps is real and measurable (new N-1, minor). |
| **M-2** | **Fixed** | Both ends: the shard drops what is left of a grant on any non-`ok` answer or throw under it; edge's `appendSlot` releases on every early exit (refusal, unknown status, `invalid`, throw). R2 is a test and passes (no grant left after the series rounds; another tenant admitted at `maxInFlight` = the grants taken). Every path read releases or drops (list below). The builder's F1 and S15, and the reviewer's Y2, Y3, are killed. |
| m-1 | Fixed; agree with the widening | At `reserve`, held nothing **or** first batch fits the share. This is the pre-D77 per-batch rule's effect on a request's first batch. The cost is that a tenant just under its share can now take a whole request (up to its cap) beyond it, where before it took one batch; the 2x ceiling bounds the total and the tenant's next request is refused while it is over. Acceptable. Killed: S19 (builder), X4 (reviewer). |
| m-2 | Fixed; agree | Sharers are every tenant holding buffered, waiting or granted bytes plus the asker. Equivalent to the old count where it was right. **The "waiting in the group" term has no test** (mutant X3 survives the whole shard suite). |
| m-3 | Fixed; agree. **No grant can live for ever** | `expires` is extended only inside `takeGrant`, which removes one batch each time; a re-sent or duplicate batch under the token (not in the grant) does not extend it (N5: 0 reservations 300 ms after the last take with a 200 ms TTL, after a duplicate re-send at 150 ms). A grant lives at most its request's append sequence plus `reservationTtlMs`; an edge that dies mid-request leaves it for 5 s after its last append. Killed: S17. |
| m-4 | Fixed (by the builder's rerun) | Not re-run in full here; the builder's F1 re-run and the reviewer's Y2, Y3 on edge's new release path are killed. |
| m-5 | Fixed; agree | `planCost` charges 160 bytes per batch plus the key; 4 MiB per isolate; a plan over 256 KiB (about 1,600 batches) is not remembered. The estimate is in the right range for a `{fingerprint: 64-char string, bytes}` object per batch; not measured with a heap snapshot. |
| m-6 | Resolved | AGENTS.md "Shared machine" now names `--fsModuleCachePath` and says `--no-cache` is not enough; the shared tree's `engine/wasm/js/viz_engine.wasm` is now `df0ed811…` (ABI 4, rewritten 13:22), so the builder's "the shared engine is ABI 2" no longer holds. |
| n-1 | Fixed; agree | A probe of an unknown tenant creates no stream. It can now answer `ok` where the append would answer `registering`; the probe only decides whether to decode, so a wrong `ok` costs a decode. |
| n-2 | Not fixed; agree | The plan is the earlier decode's, but a probe refuses only while those exact batches are refused for room, within 5 minutes. |
| n-3 | Not fixed; agree | `Retry-After` is delay-seconds (RFC 9110); rounding up keeps "never shorter". |

### Why the bounds still hold (M-1)

Write N for unreserved appends in flight, G for live grants, and P for the real appends in flight. The
check made for an unreserved append and for `reserve` is `inFlight + G + 1 ≤ maxInFlight`, and granted
appends skip it. Each grant has at most one append in flight. That append is counted in `inFlight`,
and in G while the grant has more batches. When the last batch is taken, the grant drops and only
`inFlight` counts it. So at each check, `inFlight + G` is at least P plus the appends the live grants
can still add, and no grant ever adds more than one at a time. P ≤ `maxInFlight` follows. The same
argument holds for bytes, since each grant's in-flight batch is at most its `load`. **This depends on
edge sending a grant's batches one at a time, and the shard does not check it** (N-2). Every path read
for M-2 releases or drops the grant:

- refused at `reserve`: the others are released;
- refused mid-slot (any status): the shard drops the grant, and edge releases it again (a no-op);
- unknown status or `invalid`: edge releases;
- an append that throws in the shard: dropped;
- a throw edge sees but the shard did not (`thrown` in `admission.test.ts`): edge releases;
- a twin's group transaction failing: the joiner is rejected, so the grant is dropped;
- the last batch taken: dropped in `takeGrant`;
- edge gone mid-request: expires 5 s after its last use.

The one leftover is a `reserve` whose answer is lost after the shard granted (N-3).

## New findings

Counts: **0 blockers, 0 majors, 2 minors, 2 nits.**

### N-1 (minor): the double count halves the in-flight limits for multi-batch traffic, and refuses a request's own duplicates for load

- **Where.** `shard/src/shard.ts` `overloaded`: `inFlight + grants.size + 1 > maxInFlight || pendingBytes + grantedLoad + bytes > maxPendingBytes`. A grant whose batch waits in the group is counted once in `inFlight`/`pendingBytes` and again in `grants.size`/`grantedLoad`.
- **Reproductions** (measured here):
  - **N1a, shard.** `maxInFlight` 4, `groupWindowMs` 300. Two grants of two batches each, with each grant's first batch waiting in the group (`inFlight` 2, `reservations` 2): a third tenant's unreserved append is refused **`overload`**, and so is a third `reserve`. Real appends in flight: 2 of 4.
  - **N1b, shard.** `maxPendingBytes` 1,000. Two grants of 2 × 300, each with its first batch waiting (`pendingBytes` 600): an append of 100 is refused `overload`. Real pending bytes: 600 of 1,000.
  - **N1, edge, HTTP.** One-slot tenant, `maxInFlight` 4, `groupWindowMs` 30, `maxBatchBytes` 16 KiB. Two traces requests of about 10 batches each are mid-sequence (`inFlight` 2, `reservations` 2), then a third arrives: **200, 200, 503** ("ingest shard is overloaded; retry the whole request"). The same three requests with `reserve` throwing, which is the pre-D77 path: **200, 200, 200**.
  - **N3, a request's own duplicate.** `maxInFlight` 2. Batch `f1` is already stored. The retry reserves `[f1, f2]`, and the grant holds `f2` only. Another append is in flight. Edge then sends `f1` under the token. `takeGrant` does not find it (it is not in the grant), so it goes through the load check, which counts the request's own grant: refused **`overload`** where the pre-D77 path would have answered `duplicate`. The shard keeps the grant (unreserved path), and edge releases it. This is the retry D77 now asks for after a 503 with part stored.
- **Effect, modelled.** With every request multi-batch, the effective limits are about `maxInFlight / 2` concurrent requests mid-sequence per shard (32 at default) and, with full 1 MiB batches, about `maxPendingBytes / 2` (8 concurrent requests of 1 MiB batches, against 16 before D77). Past that, valid requests get a retryable 503 and `noteOverload` makes edge refuse the tenant's next requests early while the shard is "hot". This is safe and conservative, and documented in D77 ("would change if the double count is seen to refuse requests under load (then (ii))"). The condition is now seen, locally. It was not seen on Cloudflare: S15's load (4 clients, 2 shards) made no 503.
- **Smallest fix.** The builder's alternative (ii), with the dedup gap closed too. Mark a grant busy in `takeGrant` and clear the mark when that append settles. Count only idle grants in `overloaded` (`grants.size − busy`, `grantedLoad − busyLoad`). An append under a busy grant is admitted as one without a token, which also gives N-2's guard. An append carrying a live token of the tenant for a fingerprint the grant does not hold skips the load check, since the request's grant already counts its slot. Tests: N1a, N1b and N3 as written here, inverted.

### N-2 (minor): two properties of the new accounting have no test that fails when they are broken

- **X2**: `dropGrant` stops subtracting `grantedLoad`. Every grant's largest batch then stays counted against `maxPendingBytes` for ever, and after about 16 MiB of grants' largest batches a shard refuses every append `overload` until it restarts. This **survived the whole shard suite (138 of 138)**. `stats()` exposes `reservedBytes` but not the load, so no test can see it. Expose it (`reservedLoad`) and assert 0 wherever `reservations: 0` is asserted (`noGrants` in edge, the reserve tests).
- **X3**: the fair share's denominator omits tenants waiting in the open group. This **survived the whole shard suite**. Add a case where a tenant's only holding is a batch in the group (`groupWindowMs` > 0).
- **Seen in passing (nit, not a test gap):** the shard does not check that a grant is used one batch at a time. N2: six appends under one token sent at once with `maxInFlight` 2: **6 in flight**, all `ok`. Edge sends sequentially, so this is not reachable from edge today. But the in-flight bound now rests on a caller property that only BATCH.md's prose states. N-1's busy mark closes it.

### N-3 (nit): a `reserve` whose answer is lost after the shard granted leaves an orphan that refuses its own request

When `reserveSlot` catches a throw it returns `null`, and the slot appends without a token. If the shard had granted, the orphan grant holds the request's room and slot until it expires (5 s from `reserve`). The request's own appends are checked against it. N4: `tenantMaxBytes` 1,000, an orphan of 2 × 400, the same tenant's append of 400 without the token: refused `tenant` (`reservations` 1). The answer is truthful: 429 if nothing was stored, 503 otherwise. The cost is a self-inflicted refusal for up to 5 s after an RPC failure, which is rare. Left as is unless S15-like runs show `reserve` throws.

### N-4 (nit): `(ii)`'s stated saving is understated in D77

D77 says exact counting would save "at most one slot per large request". That is true per request. Under multi-batch load, though, the saving is half the shard's in-flight capacity (N-1). The "would change if" is right. The sentence should say what is at stake.

## Mutants (spot-check, on a copy; shard against `reserve` + `groupcommit`, edge against `admission`, `atomic`, `flow`, `overload`, `limit`)

| # | Mutant | Result |
|---|---|---|
| B-S15 | builder's: a refusal under a grant keeps the rest (shard) | killed (`reserve` "M-2: a refusal under a grant drops what is left") |
| B-S17 | builder's: expiry from `reserve`, not last use | killed (`reserve` "m-3") |
| B-S19 | builder's: the fair share against the whole request | killed (`reserve` "m-1") |
| B-F1 | builder's: edge does not release a stopped slot | killed (`admission` "after every outcome") |
| X1 | a used-up grant is not dropped (lingers until expiry) | killed (4 `reserve` tests) |
| X2 | `dropGrant` forgets `grantedLoad` | **survived**, also against the whole shard suite (138 of 138) |
| X3 | sharers omit tenants waiting in the group | **survived**, also against the whole shard suite |
| X4 | the held-nothing exemption also applies to appends | killed (`reserve` "m-2") |
| X5 | a grant counts no append slot (load only) | killed (`reserve` in-flight tests) |
| Y2 | edge: a thrown append does not release its slot | killed (`admission` "after every outcome", the thrown case) |
| Y3 | edge: no mid-slot release on any path | killed (same) |

The builder's README lists S13–S21 and F1–F3 as killed. The four re-run here agree.

## S15 on Cloudflare: does the evidence support the claims?

Read from `spikes/s15-ingest-atomic/README.md` and `refused.mjs`. Not re-run (no Cloudflare calls in
this review).

- **"0 of 323 attempts 503."** The arithmetic holds (33 + 138 + 40 + 64 + 48). It supports "no refusal after a stored part at S10's run-1 load". With n = 323 the 95 % upper bound on the 503 rate is about 1 % (rule of three). It says nothing about the shapes M-1 and N-1 are about: the load had 4 clients, 2 shards, and requests of a few batches per shard. R1c and N-1 were not run there, and no eviction was forced, so "no grant was lost" is an absence of evidence.
- **"Refused requests left nothing findable" (15 of 15 → 404).** Mostly supported. Trace by ID reads `trace_index` fragments **and the shards' unflushed tails** (`query/src/signals.ts`, `traceRounds`). A 404 therefore means no fragment and no tail span holds the id. The accepted controls' 422 ("data files to read are 17.7–19.2 MB") came after the id's extent was found, so 404 against 422 does discriminate. Two limits:
  - Only each refused request's **first** trace was asked for. With 2 shards a partly stored request is caught about half the time. 0 of 15 rules out "most refused requests partly stored" (S10's 4 of 10), since 0.5^15 ≈ 3·10⁻⁵ if all were, but not an occasional one.
  - No control was actually served (all 422), so the read path's positive answer was not shown end to end on this stage. The local `rows.test.ts` (0 rows for a refused request) is the direct evidence. The span count against accepted spans was not run.
- **"CPU per refused attempt p50 4 ms."** Supported as a sample. n = 77 tail events of 138 refused traces attempts, from a tail that drops events under load, so the sample may be biased in either direction. "Under 20 ms ⇒ answered without a decode" is inferred from CPU time, not logged. p99 287 ms: the decoded minority. Logs: n = 7.
- **Not shown on Cloudflare:**
  - Prometheus Remote Write and the series-limit path, M-2's trigger: `INGEST_SIGNALS=traces,logs`, so metrics were not ingested at all.
  - Many batches to one shard: R1a, R1b, R1c, N-1.
  - The Durable Object request overhead against a before figure: 1,389 requests were measured, but S10 has no per-run figure, so plan item 4 is bounded by the model, not measured.
  - The `reserve` round trip's p90 of 74 ms (traces) and 158 ms (logs) inside the object, far above local's 3.8 ms median, is reported but not explained: is it waiting behind a group commit's output gate? It does not show in acknowledgement latency at n = 33 to 48.

## Not checked

- The builder's whole mutant sets (S13–S21, F1–F3, E1–E10), beyond the four re-run.
- The whole edge suite under the reviewer's edge mutants (a five-file subset).
- m-5's estimate against a heap measurement.
- Anything on Cloudflare.

## Verdict

**Approve with changes.**
- M-1 and M-2 are fixed as the first review meant. The bounds hold (conditional on edge's one-at-a-time sending), and every outcome path read releases or drops its grant. The minors' dispositions are sound.
- Fix N-1 before multi-batch load reaches a shard at more than about half its in-flight limits. It is the builder's own "would change if", now reproduced: a third request refused 503 with 2 of 4 slots really used, and a request's own duplicate refused for load. N-1 and N-2's guard share one fix (a busy mark on the grant).
- N-2's two surviving mutants need a test each. X2 is a slow leak that would shut a shard for good, and nothing can observe it today.
- Neither N-1 nor N-2 blocks building on D77.

## Reproduction index

Copies of the reviewer's test files and logs are in the scratch area (`d77-r2/repro/`, `d77-r2/logs/`);
the worktree was removed.

| Id | Test | Result here |
|---|---|---|
| N1a | `shard/test/zz-review2.test.ts` "N1a" | 2 real in flight of 4, `inFlight` 2, `reservations` 2: append and `reserve` refused `overload` |
| N1b | same, "N1b" | `pendingBytes` 600 of 1,000: append of 100 refused `overload` |
| N1 edge | `edge/test/zz-review2.test.ts` | fixed: 200, 200, **503**; pre-D77 path: 200, 200, 200 |
| N2 | shard "N2" | 6 in flight with `maxInFlight` 2, all `ok` |
| N3 | shard "N3" | duplicate under the token refused `overload`; grant kept by the shard |
| N4 | shard "N4" | orphan grant: own append refused `tenant` |
| N5 | shard "N5" | grant gone 300 ms after its last take (TTL 200); a duplicate re-send does not extend it |
| mutants | `d77-r2/scripts/mut2.mjs` on a copy | 9 of 11 killed; X2, X3 survive the whole shard suite |

## Summary row for design/REVIEW.md

| `reviews/d77-ingest-reservations-r2.md` | Re-check of D77's fixes (`7fb102b`) for the first review's findings, and S15's stage evidence | M-1 and M-2 fixed (bounds hold given edge's one-at-a-time sending; every outcome releases or drops its grant; R1a–c, R2 pass); m-1, m-2, m-3 (no grant outlives its last append by more than its TTL), m-5, n-1 fixed and agreed; m-6 resolved; n-2, n-3 agreed. New: 0 blockers, 0 majors, 2 minors (N-1 the double count halves the in-flight limits for multi-batch traffic, reproduced: a third request 503 with 2 of 4 slots really in use, a retry's own duplicate refused for load; N-2 two surviving mutants, a `grantedLoad` leak that nothing observes and the group term of the fair share), 2 nits (an orphaned grant after a lost `reserve` answer refuses its own request for up to 5 s; D77 understates what exact counting saves). Suites 138/138 and 162/162, `tsc` clean in both. S15 supports "no 503 and nothing findable at S10's load" with first-trace-only sampling; metrics, many batches per shard and evictions not exercised on Cloudflare. Approve with changes | |
