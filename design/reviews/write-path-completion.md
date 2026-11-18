# Adversarial review: the completed write path (snapshot `dc2a1c3`)

Reviewer stance: adversarial, not the author. Scope: `shard/`, `ledger/`, `edge/`, `flush/`,
`compact/`, `janitor/`, `stack/` against `contracts/` and `design/VERIFICATION.md` §2. The
findings below were formed from the code and the contracts; `DESIGN.md` and `DECISIONS.md`
D18–D22 were read afterwards (last section).

**Summary.** No blocker. Four majors: a malformed retention record expires data the tenant's
policy keeps (I9); a compaction output that a retry *adopts* can be deleted by a concurrent
orphan sweep between its PUT and its `replace`, after which the ledger lists a missing object
and the inputs are purged (I1, I2, I11); the ledger's rebuild cannot finish for a tenant older
than about a week and holds `blockConcurrencyWhile` across R2 while it tries; the active-series
limit answers Remote Write with 429, which a sender that retries 429 can never get past. Eight
minors. Two majors (R-1, R-2) and two minors (R-6, R-7) were shown with failing tests (below,
"How to reproduce").

| # | Severity | Invariant / rule | Where | Shown by a failing test |
|---|---|---|---|---|
| R-1 | major | I9 | `janitor/src/janitor.ts:47-58` | yes |
| R-2 | major | I1, I2, I11 | `flush/src/flush.ts:153-167` with `janitor/src/janitor.ts:139-173`, `compact/src/compact.ts:389-396` | yes |
| R-3 | major | AGENTS "never hold `blockConcurrencyWhile` across R2"; I1/I2 recovery | `ledger/src/ledger.ts:179`, `209-214`, `633-757` | no (modelled) |
| R-4 | major | D21 aim; I7 spirit | `edge/src/index.ts:105-108` | no (sender behaviour, training knowledge) |
| R-5 | minor | `TABLES.md` "a pair leaves the ledger in one change" | `janitor/src/janitor.ts:75-78` | no |
| R-6 | minor | D18 safety net | `shard/src/shard.ts:475-482` | yes |
| R-7 | minor | D18 safety net; I9 (retention stops) | `stack/src/index.ts:63-67`, `flush/src/sweep.ts:77-83` | yes |
| R-8 | minor | I9 (defence in depth) | `ledger/src/ledger.ts:103-125` | no |
| R-9 | minor | I1 (acknowledged, never flushed) | `edge/src/auth.ts:65` | no |
| R-10 | minor | "refuse rather than guess" | `shard/src/shard.ts:536` | no |
| R-11 | minor | cost | `shard/src/shard.ts:375-378`; `flush/src/consumer.ts:99`; `stack/src/maintain.ts:157` | no |
| R-12 | minor | AGENTS rules | see entry | no |

---

## Major

### R-1. A retention record that cannot be read is replaced by the 30-day default (I9)

`retentionPolicy` (`janitor/src/janitor.ts:47-58`) returns `DEFAULT_RETENTION` (30 days) for a
record that does not parse or whose number is not a positive integer. Its comment says
"never a shorter one", and the existing test checks only bad records that would have been
*shorter* than 30 days. For a tenant whose policy is longer than the default, the fallback is
shorter.

**Sequence.**
1. An operator writes `retention:acme` = `{"metric_samples_days": 365,}` (trailing comma), or
   `{"metric_samples_days": "365"}`. There is no policy API yet; KV is edited by hand.
2. The next maintenance run (`stack/src/maintain.ts:111`, `expireTenant`) computes
   `beforeDay` from 30 days and calls `ledger.expire` for both tables.
3. Days 31–365 leave the ledger; one hour later `purgeTenant` deletes their objects.

A second, smaller path to the same result: KV is eventually consistent, so a just-written
longer policy can read as absent (null → default) at another location for up to about a
minute (training knowledge).

**Test** (`janitor/test/review.test.ts` in the scratch copy): a tenant with a file 100 days
old and the record `{"metric_samples_days": 365,}`; `expireTenant` must remove nothing. It
removes both files of that day:

```
AssertionError: expected [ …(2) ] to deeply equal []
+   ".../tenant=rv-ret-…/day=2026-08-10/L0-pool-…-1-1-45884590.parquet",
+   ".../metric_series/tenant=rv-ret-…/day=2026-08-10/L0-pool-…-1-1-8788f8bb.parquet",
```

**Fix.** Distinguish "no record" from "a record I cannot read": the second refuses to expire
(and reports it), it does not guess. Optionally keep the last policy that was read
successfully in the maintenance marker and never apply a shorter one without an explicit
change.

### R-2. An adopted compaction output is deleted by a concurrent orphan sweep (I1, I2, I11)

The orphan sweep protects a compaction output only by its R2 `uploaded` age
(`janitor/src/janitor.ts:139-141`, `171-173`: deleted when unknown to the ledger and older
than `max(24 h, 2 × maxStepMs)`). The step's deadline (`compact/src/compact.ts:392`) makes that
safe for an object the step *created*. But `putFile` (`flush/src/flush.ts:153-167`) answers
`exists` when the same bytes are already there and does not touch the object, so its `uploaded`
time stays that of the attempt that first wrote it. Output keys are a function of the inputs,
so every retry of the same job adopts the leftover of an earlier attempt. The comment at
`compact/src/compact.ts:31-33` ("it can never delete an output a step is about to make live")
does not hold for an adopted object.

**Sequence** (tenant T, hour H with four level-0 pairs I):
1. Attempt 1 of the job "merge I" PUTs outputs O (`created`, `uploaded = t0`), then does not
   call `replace`: it ran past `maxStepMs` (`too_slow`), or the `replace` RPC threw (ledger
   reset by a deploy), or the isolate died. O stays, unlisted.
2. The job keeps not completing for a day (every attempt is `too_slow`, or the ledger is
   unreachable through retries, dead-lettering and hourly crons). Each attempt's PUT answers
   `exists`; `uploaded` stays `t0`.
3. At `t0 + 24 h + ε`, attempt k PUTs O → `exists`, passes its deadline check.
4. Concurrently, a second maintenance run of T (the stack runs two when two messages for T are
   in different batches; `stack/README.md` "Not implemented") is in `sweepOrphans`: it listed
   O, and its `orphanCheck` runs before attempt k's `replace` commits: O is neither live nor
   tombstoned, and `now − uploaded ≥ 24 h`. O is doomed.
5. Attempt k's `replace` commits: O is live, I is tombstoned.
6. The sweep's `BUCKET.delete` removes O. The ledger lists two keys with no object.
7. One hour later `purgeTenant` deletes I (removal logged, grace passed, not live). The rows of
   hour H are in no object. Every later compaction that picks O throws in `fetchAll`
   (`compact/src/compact.ts:307`), so maintenance of T fails from then on.

The window in step 4 is the adopting step's PUT→`replace` interval, so this is a narrow race,
but its outcome is silent loss of acknowledged rows, and the conditions (a job that keeps
failing; overlapping maintenance runs) are ones the design says it tolerates. Flush files do
not have this problem: they are protected by the stream's logged watermark, not by age.

**Test** (`compact/test/review.test.ts`): four flushed segments; attempt 1 throws from its
`afterPut` hook; attempt 2 of the same job runs `sweepOrphans` from its `afterPut` hook with the
sweep's clock 25 h ahead (standing in for an object 25 h old). Attempt 2 reports `merged`
with `put: ['exists','exists']`, the sweep deleted exactly the leftover keys, and then:

```
AssertionError: listed outputs exist in R2: expected [ false, false ] to deeply equal [ true, true ]
AssertionError: some object holds the rows: expected [ false, false, false, … ] to include true   (after purgeTenant)
```

**Fix.** Make "this output may be about to become live" a ledger fact, as D20 did for
removals: the step records an intent (key list, expiry) in the ledger before its PUTs, and
`orphanCheck` reports keys under a live intent as known. A cheaper mitigation, not a
closure: after `replace` succeeds, HEAD the outputs and re-PUT any that are missing (the bytes
are in memory; the inputs are not purged for an hour). Refreshing `uploaded` on `exists` alone
does not close it, because the sweep decided on the old listing and R2 deletes are not
conditional.

### R-3. Rebuild runs inside `blockConcurrencyWhile` with unbounded R2 I/O

`ctx.blockConcurrencyWhile(() => this.init())` (`ledger/src/ledger.ts:179`) runs
`startIncarnation` → `latestIncarnation` (R2 list), `replay` (one R2 GET per change since the
incarnation's base, six at a time, `704-757`) and a base PUT (`657`). `rebuildFromLog` does the
same explicitly (`618`). AGENTS.md forbids holding `blockConcurrencyWhile` across R2. There is
no checkpoint: a base is written only when an incarnation starts, so the number of objects to
replay grows by one per change forever.

**Why it matters.** The runtime limits `blockConcurrencyWhile` to about 30 s and resets the
object when it is exceeded (the ledger README says so; training knowledge). Modelled: at
0.05–0.1 s per round of six GETs, 30 s replays about 1,800–3,600 changes. A tenant on two
slots that seals every 10 minutes writes about 300 `add_unit` changes a day, plus a
`replace` per merge and two `expire`s: roughly 400–700 a day, so **about a week**. After
storage loss, every request re-runs the constructor, replays from scratch, times out and
resets: the tenant's ledger never serves again, flush stops, shards fill to their tenant cap
and answer 429 indefinitely. No data is lost (it is in R2 and in shards), but the recovery path
the invariants I1/I2 rely on does not complete. On a fresh tenant the same path holds the
object for an R2 list and a PUT on its first request.

The ledger README lists "bounded time" as not guaranteed; `DESIGN.md` §4.3 says "periodic
checkpoints bound rebuild time", which is not true as built (AGENTS rule 3).

**Experiment that settles it.** On Cloudflare, a ledger with 5,000 change objects, storage
wiped (`deleteAll`), first request timed. **Fix.** Rebuild outside `blockConcurrencyWhile`:
refuse requests with a retryable status while a rebuild is in progress, persist replay
progress in SQLite so a reset resumes, and write checkpoints (a `base` every N changes, which
`LEDGER-LOG.md` segments make cheap).

### R-4. Remote Write is answered 429 for the active-series limit

`edge/src/index.ts:105-108`: when the shard refused new series, the rest of the request is
stored and the sender gets **429** with `Retry-After: 60`. A sender that retries 429 resends
the whole request; the stored part is deduplicated, the new series are refused again, and the
answer is 429 again, for as long as the tenant stays at its limit. Prometheus-compatible
senders retry a recoverable error indefinitely and do not send newer data from that queue
shard meanwhile, so the series the tenant already has stop arriving too, which defeats the
point of D21 ("series the tenant already has are never refused"). As I know it (training
knowledge, not verified here): Grafana Alloy retries 429 by default, Prometheus does when
`retry_on_http_429` is set, the OpenTelemetry Collector's exporter retries 429 for its
`max_elapsed_time`; Mimir and Cortex answer per-tenant series limits with 400 for this reason.
Without retry the 429 is harmless.

**Check.** Point Prometheus with `retry_on_http_429: true` and Alloy (defaults) at a tenant
whose limit is reached, and watch `prometheus_remote_storage_samples_pending` and whether
samples of existing series keep arriving. **Fix.** 400 with the same body (Remote Write does
not retry 4xx other than 429), and D21 and `edge/README.md` updated. OTLP's `partial_success`
is already right.

---

## Minor

**R-5. `expire` removes a pair in two ledger changes.** `expireTenant` calls `ledger.expire`
for samples, then series (`janitor/src/janitor.ts:75-78`), so a pair leaves the ledger in two
versions, against `TABLES.md` ("a pair enters and leaves the ledger in one change"). Between
the two, `plan` lists series files without samples, `compact`'s `pairFiles` sees strays, and a
log reader (the publisher) sees an unpaired removal. Harmless for queries; either the contract
says expiry is per table, or `ExpireRequest` takes both tables in one transaction.

**R-6. The pending marker can be lost with the shard believing it is there.**
`pendingTenants` (`shard/src/shard.ts:475-482`) deletes the marker, sees that a seal happened
meanwhile, and puts it back. If that put throws (it is the second write to one key within a
round trip; KV allows about one write per second per key, training knowledge), the exception
leaves `marked = true` and no marker. From then on no seal writes it (`deliver` checks
`!this.marked`) and `arm` schedules no retry (`561`), so the hourly sweep never finds this
shard again; a dead-lettered flush of it waits for the tenant's next seal. **Test**
(`shard/test/review.test.ts`): KV wrapped so the re-put fails once, a seal injected during the
delete; afterwards, with KV healthy and a second seal: `marked === true`, two pending
segments, `CONFIG.get(marker) === null`. **Fix:** `setMarked(false)` before the delete, or in a
`finally` when the re-put fails, so the alarm path rewrites it.

**R-7. One failing shard stops the whole cron.** `handleScheduled` awaits `sweepPending`, then
`enqueueDue` (`stack/src/index.ts:63-67`); `sweepPending` awaits each marked shard in turn and
sends nothing until the loop ends (`flush/src/sweep.ts:77-83`). One shard whose
`pendingTenants` throws (R-6's path, a shard on an old schema, a reset object) means no stream
is re-enqueued, not even those found before it, and no tenant's maintenance is enqueued, so
retention, deletion and compaction of idle tenants stop, every hour, until that shard is
fixed. The same happens if the number of marked shards exceeds the invocation's subrequest
limit (1,000 on the paid plan as I last knew it; it may now be higher). **Test**
(`stack/test/review.test.ts`): one marked shard that throws, one tenant whose marker is due;
`MAINT_QUEUE` receives nothing. **Fix:** catch per shard, send what was found, run the two
sweeps independently, and bound the shards visited per cron.

**R-8. The ledger accepts any key.** `fileProblem` (`ledger/src/ledger.ts:103-112`) checks
shape, not that a key lies under `{cell}/data/{table}/tenant={this tenant}/day={day}/`. Purge
deletes whatever keys the ledger tombstones. Today every caller builds keys correctly, but I9's
"only that tenant's files" then rests on every caller; the one authority could refuse.

**R-9. A key record with an invalid tenant id is accepted at ingest.** `parseRecord` requires
only a non-empty string (`edge/src/auth.ts:65`). Writes for tenant `acme.prod` are acknowledged
and stored in shards, but its flush messages are dead-lettered at once
(`flush/src/consumer.ts:54-56`), the sweep skips it (`sweep.ts:80`), and its ledger cannot be
constructed: acknowledged rows that can never be flushed or read, then 429 at the tenant cap.
Refuse such a record in `authenticate` (`TENANT_ID`).

**R-10. `tailRead` on an unknown stream answers `ok` with the caller's incarnation**
(`shard/src/shard.ts:536`). After a shard loses its storage and before its first new append,
a query reads an empty tail for the old incarnation and silently omits that incarnation's
unflushed rows, where `DESIGN.md` §4.3 says the loss "must be visible". Answer
`incarnation_mismatch` when the caller names an incarnation the shard does not have.

**R-11. Cost.** (a) Every metered append marks the series window dirty
(`shard/src/shard.ts:377`) even when no id was new, so the alarm rewrites both buckets every
minute while a tenant writes: about 2 MiB per stream per minute once the buckets are sketches
(1 MiB Bloom filter each at a 500,000 share). Mark dirty only when `add` changed something.
(b) Every flush run that ends `ok`, including duplicate deliveries that found nothing pending,
triggers a full maintenance run (`flush/src/consumer.ts:99`): two `expire`s, at least four
whole-live-set `plan`s with every index fragment, `deletable`, a KV read and write. (c) That
final `writeMarker` (`stack/src/maintain.ts:157`) is not tolerant of KV's per-key write rate,
so two runs of one tenant finishing within a second make one fail after doing all its work,
and it is retried.

**R-12. Rule deviations (AGENTS.md).** The shard's fingerprint expiry
`DELETE FROM batch WHERE payload IS NULL AND at + ? <= ?` (`shard/src/shard.ts:607`) names no
tenant (housekeeping, benign, but the rule has no exception). `consumeDeadLetters` issues one
R2 PUT per message in a loop (`flush/src/consumer.ts:121-129`); during an incident that is
hundreds of sequential 0.2–0.4 s writes. The ledger's R2 log PUT on the `addUnit` path and the
queue send / KV put on the sealing `append`'s path are known (ledger and shard READMEs).

---

## Suspected, checked, and safe

- **Seal and its outbox row** (`shard.ts:388-403`): the batch insert, segment, stream update
  and `notify` row are written with no `await` between them, so they commit together. (This
  relies on the runtime's implicit transaction for writes between awaits, training
  knowledge; `transactionSync` would make it explicit.)
- **Duplicate, reordered and concurrent flush deliveries; a cron sweep racing a live flush;
  a replayed dead letter.** Encoding is deterministic, PUTs are `If-None-Match` with a size and
  SHA-256 check, `addUnit` at or below the watermark is a replay, `recorded` is idempotent.
  A message carries no range, so any delivery flushes whatever is pending.
- **I5.** Flush tells the shard only the ledger's *logged* watermark (`flush.ts:326-333`), and
  `drainNow` advances `logged` only after the PUT returned, per incarnation (`ledger.ts:577-585`).
  A rebuilt ledger comes back at the logged watermark; the shard still holds everything above it.
- **I4 seam.** Queries read the tail above the *committed* watermark; the shard discards only up
  to the logged one, 30 s after recording, and answers `stale_watermark` below its fence.
- **Ledger alarm and drain interleavings.** A mutation sets the alarm before draining; a drain
  that fails leaves it set; a drain that empties the outbox deletes it only after its last
  `SELECT`, and no mutation can commit between those two. No outbox row is left without an
  alarm, and an idle ledger has none.
- **Precedence (D22).** Only `replace` can create overlapping ranges, and it refuses any that
  intersect a time-overlapping live file of the same table and day, in the same transaction
  as the swap. Nested ranges arise only between time-disjoint files, and the time range of a
  file never changes, so `ORDER BY prec` is a total order over every pair that can share a
  row. A `blocking` conflict never resolves while the inputs are live (a later merge of the
  blocker only widens its range), so two identical steps either both succeed (replay) or both
  conflict; the conflict path's delete therefore never removes a twin's live output, and a
  tombstoned twin output is left to the janitor.
- **Purge.** `deletable` requires logged, grace and not live in one read; `forget` runs after
  the delete. A tombstoned key cannot become live again without a ledger rebuild that loses
  the change that created it, and that change is logged before the removal can be.
- **Flush files and the orphan sweep.** Protected by the logged watermark, not by age, so a
  flush stopped between PUT and `addUnit` keeps its files however old they are (unlike R-2).
- **Expire racing compaction.** `replace` needs every input live; an output of an expired day
  cannot be admitted.
- **Tenant identity.** `edge` takes the tenant from the key record only; flush, compaction and
  janitor get it from a shard's own row or a queue message viz wrote; every shard statement
  on a request path names the tenant.
- **Overload (I7).** Every append status other than `ok` and `backpressure` maps to 503; the
  series-limit loop is bounded and ends in 429; nothing is acknowledged that a shard refused.
- **Active series.** `check` and `add` run with no `await` between; a duplicate batch returns
  before metering; an eviction under-counts by at most `seriesPersistMs` of new series
  (documented).
- **Idle.** No shard or ledger alarm survives once there is nothing to discard, send or save.
- **Known and agreed:** cross-stream precedence needs the shard-map handover (not built;
  `stack/README.md`); tombstones of older ledger incarnations are left to the orphan sweep.

## Does the stated reasoning hold (DESIGN.md, D18–D22)

- **D18.** Holds for the queue path. "Dead letters … the sweep re-enqueues the stream" holds
  only while the marker is right and the cron completes: R-6 and R-7.
- **D20.** Holds for removals. It argues that "removed, logged, live" belong in the ledger
  because a second place could miss or reorder them; the protection of an *in-flight*
  compaction output was instead left to R2's clock, which is where R-2 is.
- **D21.** The metering and filtering hold; the choice of 429 for Remote Write does not (R-4).
- **D22.** The disjoint-ranges argument holds (checked above). The caveat for cross-stream
  order is stated.
- **`DESIGN.md` §4.3** says "periodic checkpoints bound rebuild time" (R-3: none exist) and
  "the orphan sweeper deletes only files that are unreferenced *and* below the stream's
  logged watermark" (compaction outputs are deleted by age, R-2). Both sentences need
  updating (AGENTS rule 3). `stack/README.md` "each step is safe to run twice, it is only
  wasted work" is not true together with the orphan sweep (R-2).

## How to reproduce

The snapshot was extracted with `git archive dc2a1c3 … | tar -x` into the scratchpad. Not in
the snapshot, so taken from the working tree: `node_modules` (symlinked per component) and
`engine/wasm/js/viz_engine.wasm` (built 22:02, before the commit at 23:25; the engine source
at `dc2a1c3` may differ from the one that built it). One read-only `git log -1` was run to
learn the commit time, beyond the `git archive` the brief allowed. Each test was run alone
with `npx vitest run test/review.test.ts --maxWorkers=1` in its component directory; all four
fail as quoted. No fix was tried, so no test was shown to pass against a corrected source.

The R-2 test, whole, because it is the strongest evidence (`compact/test/review.test.ts`):

```ts
const s = stream('rv-adopt')
for (let i = 0; i < 4; i++) {
  await append(s.shard, s.tenant, someSamples(s.tenant, T0 + i * 60_000, 24, i), new Sent())
  await s.shard.seal(s.tenant)
}
expect(await flushTenant(env, engine, s.tenant, s.shardName)).toMatchObject({ status: 'ok', awaitingLog: false })
const inputs = await live(s.tenant)                       // 8 keys
let leftover: string[] = []
await expect(compactStep(env, engine, s.tenant, { now: QUIET, hooks: { afterPut: (o) => {
  leftover = o.map((f) => f.key); throw new Error('crash after PUT') } } })).rejects.toThrow()
let swept: string[] = []
const r = await compactStep(env, engine, s.tenant, { now: QUIET, hooks: { afterPut: async () => {
  swept = (await sweepOrphans(env as JanitorEnv, s.tenant, { now: Date.now() + 25 * HOUR })).deleted } } })
expect(r.status).toBe('merged')                           // put: ['exists', 'exists']
expect(swept.sort()).toEqual([...leftover].sort())
const listed = await live(s.tenant)                        // == leftover
expect.soft(await exists(listed)).toEqual([true, true])    // FAILS: [false, false]
await purgeTenant(env as JanitorEnv, s.tenant, { graceMs: 0 })
expect(await exists([...listed, ...inputs])).toContain(true) // FAILS: no object holds the rows
```

R-1: a stream with one segment at `T0 − 100 d` and one at `T0`, flushed; KV
`retention:<tenant>` = `{"metric_samples_days": 365,}`; `expireTenant(env, tenant, T0)` must
return `removed: []`. R-6: inside `runInDurableObject`, replace `instance.env` with a KV wrapper
whose `delete` runs an append and `seal` for tenant `b` and whose next `put` throws; call
`pendingTenants(0)` (rejects); then append and seal `b` again with KV healthy, run the alarm,
and assert the marker exists. R-7: an env whose `SHARD.get(...).pendingTenants` throws, a
`flush-pending:` marker for it, a `maint:<t>` marker with `due: 0`, and a recording
`MAINT_QUEUE`; `handleScheduled` must enqueue `{ tenant: t }`.
