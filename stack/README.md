# Stack

The write path as **one script**: `edge` (the default export's `fetch`, and the
`RecordedSamples` entrypoint for the ruler), the `Shard` and `Ledger` Durable Objects, `flush`
(the `Flush` entrypoint and the flush queue's consumer), and the maintenance of each tenant's
files (compaction, retention, deletion), behind one wrangler config that binds `SHARD`,
`LEDGER`, `PUBLISHER` (the cell's publisher, in the viz-publisher Worker), R2 (`BUCKET`), KV
(`CONFIG`), two queues (`FLUSH_QUEUE`, `MAINT_QUEUE`) with their dead-letter queues, and an
hourly cron. It is deployed as viz-ingest (`deploy/`).

```
 senders ─► edge ─► Shard ──seal──► [flush queue] ─► flush ─► R2 Parquet ─► Ledger
                      ▲  │                              │                      ▲ │
                      │  └─ pending marker (KV) ◄─ cron │                      │ │
 test read path ──────┴── rows above watermark          └─► [maintenance queue]│ │
                                         cron (due markers) ─►   compact ──────┘ │
                                                                 janitor ◄───────┘
```

| File | Contents |
|---|---|
| `src/index.ts` | `default`: `fetch` = edge, `queue` = flush / maintenance / dead letters by queue name, `scheduled` = both sweeps. Re-exports `Flush`, `Shard`, `Ledger` |
| `src/maintain.ts` | `maintainTenant` (expire → compact → purge → orphan sweep), its KV marker, `noteFlushed`, `enqueueDue`, `consumeMaintBatch` |
| `wrangler.jsonc` | The single config: queues, consumers, dead-letter queues, cron; what `deploy/configure.mjs` generates viz-ingest's config from |
| `wrangler.test.jsonc`, `test/worker.ts` | The test script: the same config with the publisher's class (with a test clock) in the script as `TEST_PUBLISHER` instead of `PUBLISHER` bound to viz-publisher; `deploy/test/configure.test.mjs` holds the two configs equal otherwise |
| `test/publisher.test.ts` | 5 tests: the publisher wired into maintenance, against the real `Publisher` and against ones that hang or refuse |
| `test/e2e.test.ts` | 6 end-to-end tests that drive flush by hand |
| `test/auto.test.ts` | 1 test where nothing is called: the simulated Queue delivers |
| `test/triggers.test.ts` | 8 tests of the triggers, the maintenance marker, the orphan-sweep flag and the idle deployment |
| `test/cron.test.ts` | 7 tests: the cron with a failing shard, listing or send (review R-7), the bound on shards per cron, the marker under KV's write rate (R-11(c)), maintenance message versions |
| `test/golden.test.ts`, `test/golden/` | 3 tests: golden files of the maintenance message and marker, and the marker reader's refusal of an unknown version |
| `test/compaction.property.test.ts` | 8 seeded runs of the I8 property test |
| `test/precedence.property.test.ts` | 6 seeded runs: random rewrites of the same samples always read back as the latest write |
| `test/soak.test.ts` | The soak (400 steps in `npm test`; `npm run soak` for 3,000) |
| `test/sim.ts`, `test/world.ts` | Simulated deployments: tenants, real requests, queues under test control, the model, the invariants |
| `scripts/mutants.mjs` | Mutation check for the four new parts |
| `tools/hyparquet_check.mjs` | Reads one produced Parquet file with hyparquet, in Node |

## What now happens without anyone calling it

| Event | What follows | Where |
|---|---|---|
| A shard seals a segment (size, or age in its alarm) | `{tenant, shard}` on the flush queue, written with the seal | `shard/` |
| A flush message is delivered | `flushTenant` for that stream; acknowledged only when everything sealed is recorded; otherwise retried with backoff, then dead-lettered to R2 | `flush/src/consumer.ts` |
| A flush run changed something (admitted a unit, created an object, or saw a segment recorded), or a redelivered flush message ran | `{v:1, tenant, wrote:true}` on the maintenance queue, and the tenant's maintenance marker exists. A duplicate delivery that found nothing asks for nothing (review R-11(b)); a request that is still missed is made up by the cron, because every run leaves a marker due at its next work | `noteFlushed`, `flush/src/consumer.ts` |
| A maintenance message is delivered | `maintainTenant`: retention expire, up to 8 compaction merges, deletion of what the ledger calls deletable, and (at most daily, and only while objects may have been written since the last sweep that found nothing to wait for) the orphan sweep; then the marker is rewritten with the next time anything can be due, or deleted if the tenant has nothing left | `src/maintain.ts` |
| The cron fires (hourly) | (1) streams of shards with a pending marker whose segments have waited 10 minutes are re-enqueued, at most 500 shards per cron (a window that moves on each hour); (2) tenants whose maintenance marker is due are enqueued. The two sweeps run independently; a shard, a listing or a send that fails stops neither the other sweep nor the rest of its own, and every failure (and every retention record that cannot be read) is logged and fails the invocation after everything else ran (review R-7) | `handleScheduled`, `sweepPending`, `enqueueDue` |
| A message exhausts its retries | the batch is written to ONE object `{cell}/dead-letters/{queue}/…json` (review R-12) and logged; the next sweep re-enqueues the work | `consumeDeadLetters` |
| A message of a version this release does not know (`v` other than 1) | retried with backoff, never run and never dead-lettered (contracts/COMPATIBILITY.md §3.2) | `consumeFlushBatch`, `consumeMaintBatch` |
| A maintenance run ends (with a publisher bound) | `nudge(PUBLISHER, CELL, [tenant])`: the publisher records the tenant and a `publish` deadline (2 min); its own alarm publishes. At most 2 s, never throws; not recorded → the tenant is due again within the hour. One log line per run (`maintenance <tenant>: merged …, deleted …, waiting … (for publication …), nudged …`) | `maintainTenant`, `summary` |

**Idle means free.** Both sweeps read KV only. A shard has a `flush-pending:` key only
while it has unrecorded segments; a tenant's `maint:` key carries the time it is next due
in its metadata, so the cron needs one KV list and no read. That time is the earliest of:
an hour going quiet, a day closing, a grace ending, the moment the tenant's **oldest** live
day passes its retention (not every midnight), and the next orphan sweep **only while one
is needed** (a flush wrote objects, a merge ran or crashed, or the last sweep left young or
pending objects to look at again; the flush's maintenance message says `wrote`, and the
marker keeps it). Nothing due: no Durable Object is woken and no message is sent. No
object keeps an alarm when it has nothing to do. `test/triggers.test.ts` counts this over
a simulated week of hourly crons after the work has settled: 168 crons, 0 Durable Object
calls, 0 messages; the cron at the first expiry date then enqueues exactly the tenants due.

Limitation: a retention policy changed in KV is applied by the tenant's next maintenance
run, which for an idle tenant is the expiry date computed with the old policy (a shortened
policy takes effect then, or at the tenant's next flush). The `Tenant` object that will own
policies should enqueue `{tenant}` on the maintenance queue when it changes one.

**The two graces and the step deadline** (defaults; `MAINTENANCE` JSON overrides):
a removed file's object is deleted 1 h after its removal is logged; an unreferenced flush
file after 24 h and only below its stream's logged watermark (or once a newer incarnation
of its stream has a logged unit); a compaction step gives up after 5 min; an unreferenced
compaction output is deleted only once one of its inputs is gone for good (not live, its
object deleted), and not before it is 24 h old (`DECISIONS.md` D30; `janitor/README.md`).

**The marker and KV's write rate** (review R-11(c)). KV takes one write per second per key
and answers more with 429, advising retries with exponential backoff
(developers.cloudflare.com/kv/platform/limits/ and …/kv/api/write-key-value-pairs/, read
2026-11-19). Two maintenance runs of one tenant can finish within a second (a flush's
message and the cron's, in different batches). A run writes its marker only if it changed,
and retries a refused write after 1 s, 2 s and 4 s before failing (then the message is
retried). `noteFlushed`'s write is best effort, because its message carries the same facts.

## The publisher wired in (2026-11-19)

publisher/README.md "Needed changes" 1 and 3, design/DECISIONS.md D34 and D15.

- **Binding.** `wrangler.jsonc` binds `PUBLISHER` = class `Publisher` of script `viz-publisher`.
  `deploy/workers.json` deploys viz-publisher before viz-ingest (callee first).
- **The nudge** (`src/maintain.ts`, end of `maintainTenant`, after the run's own ledger changes,
  before the marker is settled): `nudge(env.PUBLISHER, CELL, [tenant], publisherTimeoutMs)` from
  `publisher/src/nudge.ts`, at most `publisherTimeoutMs` (default `NUDGE_TIMEOUT_MS`, 2 s), never
  throws. Not recorded (a timeout, a refusal, a publisher that is gone): the tenant is due again
  within the hour, so the cron runs it and it nudges again. Only with the binding: without one,
  `nudged` is null and nothing is made due. `MaintReport.nudged` says which.
- **Never on an ingest or flush acknowledgement path** (D15). The edge's `fetch`, the flush
  consumer (`consumeFlushBatch`, `noteFlushed`) and the cron do not touch `PUBLISHER`; the
  maintenance consumer is a separate queue invocation that acknowledges only its own messages.
- **Deletion waits for publication** (`janitor/README.md`): `purgeTenant` gets the same env, so
  with a publisher bound it deletes only what the ledger AND the publisher release. Tombstones
  waiting only for the publisher (`PurgeResult.unpublished`) make the tenant due again after
  `PUBLICATION_RECHECK_MS` (6 h; `publicationRecheckMs`) instead of every delete grace (1 h): a
  release comes at the earliest a day after the removal is published (a snapshot is kept 24 h,
  and at least until a newer commit). A publisher that could not be asked: due within the grace.

| Test (`test/publisher.test.ts`, `test/triggers.test.ts`) | What it shows |
|---|---|
| a flush leads to a maintenance run … nobody calls publish | ingest, seal, the flush queue through the script's handler, the maintenance queue: `nudged: true`; the publisher has a `publish` deadline and an alarm and has published nothing; its alarm then publishes and the current snapshot lists exactly the ledger's live files for the tenant |
| a publisher that hangs or refuses never slows or fails ingest or flush | with a stand-in that never answers, and one that throws `schema_too_new`: every Remote Write 204 in less than the nudge bound; every flush message acknowledged, nothing pending; **the stand-in was asked nothing** by either path; the maintenance run is acknowledged (not retried), `nudged: false`, deleted nothing, took at least the bound (hang) and well under twice it plus slack; the tenant is due within the hour; every acknowledged row still reads back (`checkTenant`) |
| without a publisher bound | `nudged: null`, no `unpublished`: today's behaviour |
| a nudge that may not have been recorded … | a tenant with nothing to do: no marker after a run whose nudge was recorded; due in (59 min, 60 min] after one that hung or was refused |
| a removal waiting only for publication | compaction's inputs are deletable by the ledger, not released: nothing deleted, `unpublished = waiting`, due more than 5 h later |
| an idle deployment (triggers) | the counted env now binds the real publisher: 168 hourly crons make **0 publisher calls** (and 0 shard, 0 ledger calls, 0 messages) |

The four tests in `test/publisher.test.ts` that existed before the code was changed **failed
against it** (no `nudged`, no recheck interval), and pass after it. Mutants: below, part
"publication".

## Not implemented

- **A query Worker.** The read path here is test code; nothing serves queries.
- **Separate deployment.** In production these are several Workers bound to each other;
  that wiring (service bindings, `script_name` on the Durable Object bindings, the queue
  consumers in their own scripts) is not written.
- **The ledger ↔ shard-map epoch**, rollups. (The publisher is wired in: above.)
- **The compaction Workflow is not started from here**; the maintenance consumer calls the
  step function (see `compact/README.md`).
- **Alerting** on dead letters; they are written to R2 and to the error log only.
- **Concurrency limits** on maintenance (two messages for one tenant in different batches
  run two maintenance runs; each step is safe to run twice, it is only wasted work. Before
  D30 that was not true together with the orphan sweep: review R-2).
- **No production deployment yet.** This script has run on Cloudflare as viz-ingest in three
  staged trials (`deploy/README.md`: Trial 1 under load across four cutovers, Trial 2, and
  Trial 3 with the publisher wired in, its maintenance runs and deletion gate on their own);
  everything in "How it was verified" below is local (queue delivery, cron and KV metadata are
  miniflare's).

## How it was verified

```
(cd ../engine/wasm && ./build.sh)
npm install
npx vitest run --maxWorkers=2    # 41 tests in workerd, 8 files (soak: 400 steps)
npm run soak                     # the soak with 3,000 steps
npx tsc --noEmit                 # clean
node scripts/mutants.mjs all     # mutation check, four parts
node tools/hyparquet_check.mjs   # 4 checks agree
```

Last run, 2026-11-19: **41 passed, 0 failed**; `tsc --noEmit` clean.

### Wiring for the ledger's background log (2026-11-19)

The ledger now answers at its SQLite commit and logs to R2 in segments about 200 ms later
(`contracts/LEDGER-LOG.md`, D36), so a flush run that admits units usually ends
`awaitingLog` and the flush queue's retry is what tells the shard `recorded`. The script's
bindings did not change (the drain delay is the ledger's default). The tests that expected
one flush run to record changed with it, the way production gets there:

- `test/world.ts` `flushAll` and `drainLedger`: flush through the `Flush` entrypoint; while a
  run ends `awaitingLog`, run the ledger's drain (what its alarm does; inside the object, so a
  drain failing on a broken log is a result, not an unhandled rejection) and flush again, at
  most five times. `test/compaction.property.test.ts` and the hooked runs of `e2e.test.ts`
  use `flushSettled` (`flush/test/helpers.ts`), the same loop.
- `test/e2e.test.ts` `loggedUnits` reads the change log as segments (`decodeLedgerSegment`,
  each checked against its key) instead of one object per change; the concurrent-flush test
  settles the units the concurrent runs admitted before it asks a later run to find nothing.
- `test/triggers.test.ts`: the simulated queue redelivers a retried message at once, where
  the real one waits `retryDelaySeconds` (5 s at least); before a redelivery the drain of that
  tenant's ledger runs, as the wait would have let it. The idle test drains each ledger before
  each settling maintenance run (a removal is deletable once it is logged).
- The idle test then found a ledger alarm left behind after an explicit drain had written
  everything. AGENTS.md wants an alarm deleted when there is nothing to do; the ledger now
  does that (`ledger/test/segments.test.ts`, "a drain that writes everything deletes the
  alarm").

### Leftovers stop keeping the sweep due (review S-6 of `design/reviews/segment-log-and-compaction.md`)

`maintainTenant` used to keep the orphan sweep due for as long as the sweep kept any object
for a reason other than an unjudgeable name, so a leftover that only the ledger or a shard
could ever settle (a flush file of a unit that will never be reported, a stream the ledger
never saw) woke an idle tenant's ledger and listed its prefix every day for ever. Now the
sweep stays due only while the youngest such object (`OrphanResult.waitingSince`, janitor) is
younger than `stalledAfterMs` (default seven days); after that only a write makes it due
again. `test/cron.test.ts`, "review S-6": failed before the change (the marker kept
`sweep: true`), passes after; the leftover is kept, never deleted.

`scripts/mutants.mjs`: six patterns for ledger, shard and edge code no longer matched the code
after refactors (they would have printed NOT APPLIED) and were updated on 2026-11-19: the
pending marker never removed, the series window saved on every append, a rebuilt ledger
forgetting precedence, `expire` and `replace` recording no tombstone, an unreadable limits
record meaning no limit. Run again on a copy of the tree in a scratch directory
(2026-11-19): all six **killed**, four through this script (shard trigger and series tests,
the ledger's precedence test, edge's limit test) and the two tombstone mutants against
`ledger/test/tombstone.test.ts` ("replace and expire record what they removed…"), because in
the copy the janitor suite could not import control's golden file (its baseline failed there,
so it could not judge them). With them, the `trigger` part's six sweep mutants, including a
new one for S-6 ("a leftover that waits on the ledger keeps the sweep due for ever", killed by
`cron.test.ts` "review S-6"): 6 of 6 killed.

### Triggers (`test/auto.test.ts`, `test/triggers.test.ts`)

- **Nobody calls flush**: with small `sealBytes`, two tenants' Remote Write and OTLP
  requests seal inside `append`; the test then only waits. The simulated Queue delivers to
  the script's `queue` handler, files appear in each ledger, every sealed segment is
  recorded, the rows read back exactly, and each tenant has a maintenance marker.
- A seal → flush → maintenance chain through the script's own queue handler: files merged,
  query result unchanged, the merged inputs waiting for their grace, the marker's `due`
  equal to the run's `nextDueAt` and in the future; the cron does not enqueue the tenant
  before that time and does at it.
- A failing maintenance run is retried by one message of its group; a run that stopped at
  its step limit sends a follow-up; junk is dead-lettered; dead letters of a `-dlq` queue
  are written where `listDeadLetters` finds them.
- A tenant whose data has all expired and been deleted loses its marker.
- **Idle**: after three tenants' work is consumed and housekeeping alarms have run, the
  first cron asks each of the two shards once (they remove their markers). Each tenant's
  remaining time-driven work then runs once (a policy clock two days ahead: hours quiet,
  the day closed and merged to level 2, the inputs past their grace, one orphan sweep), and
  its marker then says exactly "the day your oldest data expires" (31 days after it, at the
  default policy) with no sweep needed. **168 hourly crons (a simulated week) make 0
  Durable Object calls and send 0 messages** (namespaces and queues wrapped in counters),
  no shard or ledger has an alarm, no pending marker is left, and the cron at the first
  expiry date enqueues exactly the tenants due then.
- **The orphan sweep's flag**: a flush's maintenance message says `wrote` and the run sweeps;
  the next run, with nothing written, does not list the prefix; a run whose merge crashes
  marks the sweep as needed before it fails, and the next run sweeps; a flush whose message
  is lost leaves the flag in the marker.
- `noteFlushed` still asks for a run when KV refuses the marker, and that run still sweeps
  (the message carries `wrote`).

### Compaction preserves the rows, I8 (`test/compaction.property.test.ts`)

Eight seeded runs of 40 operations on a tenant whose data spans four UTC days: ingest
(with repeats of samples already sent), seal and flush, one or two concurrent compaction
steps under random policies and policy clocks (so open hours, closed days and budgets are
taken in every order), and a retention expire injected between a step's plan and its
`replace` or between its PUTs and its `replace`. After every step the query result must
be unchanged: the same lines, the same row count, and the same checksum (wrapping sum of
timestamps, XOR of value bits); a merge's output never has more rows than its inputs.
With an expire in the middle the result must be the model minus the expired days and no
file of an expired day may be live. Last run: 8 of 8 pass; per seed 10–16 merges, 1–3
conflicts, 2–5 expires, 149–383 rows.

### The latest write wins (`test/precedence.property.test.ts`)

Found by the query Worker's engineer and fixed here (`contracts/ledger.ts` `LiveFile`,
`DECISIONS.md` D22): which file wins a duplicate `(series, ts)` used to be key order, and
keys sort as text. Six seeded runs of 70 operations on one tenant over two shards: writes
of 1–4 keys from a pool of 48 `(series, ts)` (six series, eight times over two days) with
values never used before, mostly each in its own segment; flushes; one or two compaction
steps at once under random policies, budgets and clocks (open hours, closed days); and
discards, so a key's rows move between tail, flush files and outputs. After every step a
query must return each key's LAST acknowledged value, plus every `checkTenant` invariant.
Last run: 6 of 6 pass; per seed 76–112 writes, 39–69 of them rewrites, streams reaching
sequence 22–43 (past the tenth, where text order and sequence order part), 28–38 merges,
0–4 conflicts. Restoring key order in `plan`, merging in key order, or giving an output the
newest precedence each fails it.

**What `query/` should change now** (not edited here): drop `byPrecedence` and read
`Plan.files` in the order given, or sort by `LiveFile.precedence`. Its rule "compaction
outputs first" is wrong under the new contract: a flush file of a neighbouring hour can be
older than an overlapping output and must lose to it. `query/test/leaves.test.ts` line 113
asserts that the ledger lists the 11th flush before the 2nd; it now lists them in
precedence order, so that assertion fails and should be inverted. Of its "needed changes"
3–5: nothing built here makes tail paging or filtering (3) or reading a stream without its
incarnation (4) harder; one `plan` call for both tables (5) is no harder, but note that a
pair's samples and series files differ in precedence by their position in the unit, so a
combined answer should keep one list per table.

### Soak (`test/soak.test.ts`)

Three tenants sharing two shards; data over four UTC days (retention two days). Each step
is one random operation: ingest through the edge; seal by hand; the shard's alarm (age
seal, discard, fingerprint expiry); delivery of a random batch from the flush queue, one
message sometimes twice, with crashes injected after PUT, after `addUnit` or after
`recorded` in 30% of some deliveries; the flush sweep; delivery from the maintenance queue
(15% of runs fail); a compaction step alone, sometimes two at once, sometimes crashing
after its PUTs; retention with a compaction step running across it; purge; orphan sweep;
eviction of a shard or a ledger; the ledger's log broken, then healed; a reader that
takes a plan, lets four compaction steps, a purge and an orphan sweep run, and then reads
the files of its old plan.

Checked after every step for the tenants it touched, and for all tenants every 20 steps
(`checkTenant`): a query returns exactly the model (no acknowledged row lost, none twice,
none invented); every row belongs to the tenant; every samples file is listed with its
series file; every tombstone younger than the grace still has its object; and the ledger's
live set is exactly what it references: every live key is an object of the listed size, no
key is both live and tombstoned, and every other object under the tenant's prefix is
tombstoned (the janitor's) or has a name the orphan sweep can judge (nothing leaked). Checked at each deletion: a purged key had a tombstone, older than the grace
and with a logged removal; an orphan was unreferenced, old enough, and (a flush file)
below its stream's logged watermark. At the end, after flushing, compacting, expiring and
deleting everything: the objects in R2 are exactly the ledger's live set, all level 2, no
tombstone and no pending segment left.

**Result.** Last run (`npm run soak`, seed 20261118, on the final code: file precedence and
the stricter per-step check of the live set): 3,000 steps, **every invariant held at every
step**; 220 s; peak memory 1,010 MB for the whole process tree, 582 MB for the largest
process (sampled every 3 s). 898 acknowledged requests (and 200 repeats of samples already
sent), 244 segments admitted through 1,168 delivered flush messages (125 retried after
injected failures), 413 merges (309 in maintenance runs, 104 in direct steps), 16
conflicts, 27 crashed steps, 1,502 files expired, 3,872 objects purged, 20 orphans deleted,
98 evictions, 54 ledger-log outages, 62 old-plan readers verified, 0 dead letters; at the
end each tenant's R2 prefix is exactly its ledger's live set, all level 2. Two earlier
3,000-step runs in this review (before the precedence change) also held, as did the
previous engineer's three. `npm test` runs 400 steps (about 20 s).

**Run of 2026-11-19** (after the write-path review's fixes: D30's compaction-output rule, F12,
F15, R-7, R-11(b)/(c), R-12; the ledger draining its log in the background at its default
200 ms; run alone among this engineer's jobs, on a machine loaded by others, load average
about 11 on 4 cores): `SOAK_STEPS=3000 npx vitest run --maxWorkers=1 test/soak.test.ts`, seed
20261118: 3,000 steps, **every invariant held at every step**; 666 s; peak memory 1,004 MB for
the whole process tree, 568 MB for the largest process (sampled every 3 s). 901 acknowledged
requests (193 repeats), 584 segments admitted through 1,297 delivered flush messages (508
retried, injected failures and `awaiting_log`), 510 merges, 15 conflicts and 32 more under a
concurrent retention, 30 crashed steps, 3,440 files expired, 8,508 objects purged, 134 orphans
deleted (each checked against its rule when deleted, compaction outputs against D30's inputs
rule), 100 evictions, 57 ledger-log outages, 59 old-plan readers verified, 0 dead letters.

**Run of 2026-11-19, final code of the storage-path work** (the segment-log review's fixes:
the stuck and self-healing log, the state limit, checkpoints by log volume, no empty start over
data, the stalled-leftover rule; early refusal and group commit; the name rule; run alone among
this engineer's jobs, machine load average 12–14 from others):
`SOAK_STEPS=3000 npx vitest run --maxWorkers=1 test/soak.test.ts`, seed 20261118: 3,000
steps, **every invariant held at every step**; 367 s; peak memory 996 MB for the process tree
and 563 MB for the largest process (sampled every 3 s, threads not counted twice). 881
acknowledged requests (180 repeats), 586 segments admitted through 1,427 delivered flush
messages (535 retried), 391 merges, 4 conflicts and 12 more under a concurrent retention, 26
crashed steps, 1,724 files expired, 5,214 objects purged, 66 orphans deleted, 106 evictions,
58 ledger-log outages, 60 old-plan readers verified, 0 dead letters. An earlier 3,000-step run
the same night, before the review's fixes, also held (228 s); its memory figure for the whole
tree was wrong (the sampler summed threads) and is not reported.

**What failed during development.** In this review, one 3,000-step run passed every
step and then failed its final sanity check that every tenant still has rows: a maintenance
run with a policy clock three days ahead had expired all of one tenant's data after its
last request. That is allowed; the end phase now sends one request per tenant first, so
the end-state checks always run on data. Earlier, one soak run stopped at step 1,441: "deleted inside
the grace: 1499 ms, expected ≥ 1500". That was the test's clock, not the janitor: the
test took its timestamp before calling `purgeTenant`, the ledger judged the age a
millisecond later. The check now uses the time after the call. No invariant failure
caused by the code under test was seen in the soak or the property test; the bugs found
while building were caught earlier, by the unit suites (a tombstone's time differing by
1 ms from its logged change after a rebuild; a native ABI test crashing on a 32-bit
pointer field).

### Mutation checks (`node scripts/mutants.mjs all`)

Each mutant is one text replacement in the source, run against the suite that should
notice, and restored. Last run, on the final code of this review: **73 of 73 killed**
(trigger 18, compaction 13, precedence 9, deletion 17, limit 16), each by a named failing
test (cargo failures are now reported by test name). The previous engineer's 57 were also
re-run unchanged before this review's changes: 57 of 57. `flush/scripts/mutants.mjs`: 18 of
18 on the final code; `edge/scripts/mutants.mjs`: 35 of 35.

**Run of 2026-11-19 (the write-path review's fixes in compact, janitor, flush and this
script's cron and maintenance).** On a copy of the tree in a scratch area (the script refuses a
git checkout), `MUTANT_FILES=compact/,janitor/,flush/,stack/ node scripts/mutants.mjs all`:
**74 of 74 killed** (trigger 12, compaction 11, precedence 3, deletion 10, review 38), every
one by a named test. Baseline first: every suite the mutants run was green unmutated on that
copy. The 36 mutants in `shard/`, `ledger/`, `edge/` and `engine/` were not run (their owners').
Two patterns were updated for code that had changed (series files not expired: one `expire`
for both tables; retention one day short: `retentionCutoffDay`), and two F12 mutants added.
`flush/scripts/mutants.mjs`, same copy: 20 of 20. Since D30 two rows of the table below read
differently: a conflicted step's outputs being left behind is intended, and the mutant is "a
conflicted step deletes its outputs" (killed by compact: conflict); "a compaction output is an
orphan as soon as a flush file would be" is now "a compaction output's age floor is only the
flush files' grace" (killed by janitor: true orphans).

| Part | Mutant (review part) | Killed by |
|---|---|---|
| review | R-1: an unreadable retention record falls back to the default | janitor: retention policy |
| review | R-1: no record is refused instead of meaning the default | janitor: retention policy |
| review | R-1: a retention record of an unknown version is read | janitor: retention policy |
| review | R-1: a refusal is not written to the marker | stack golden: queue.maint and kv.maint-marker |
| review | R-1: a refused tenant is not looked at again within the hour | stack golden: same |
| review | **R-2/F13: the sweep ignores a compaction output's inputs (age only)** | compact: conflict (the sweep deletes the outputs while the expired inputs remain) |
| review | R-2: a tombstoned input whose object is still there counts as gone | compact: conflict |
| review | R-2: a live input whose object is missing counts as gone | janitor: a live input whose object is missing |
| review | R-2: the inputs record is not checked against the key | compact golden: reader refusals |
| review | R-2: an inputs record of an unknown version is read | janitor golden: a newer record keeps the object |
| review | R-2: inputs outside the output's tenant and day are accepted | compact golden: reader refusals |
| review | R-2: outputs are written without their inputs record | compact: conflict |
| review | F14: a `replace` answer this code does not know is taken for a conflict | compact: fails closed on an unknown answer |
| review | **F15: a newer incarnation counts before its registration is logged** | janitor: spec F15 |
| review | **F12: flush reads a segment unbound to its incarnation and range** | flush: spec F12 |
| review | F12: a refused bound read is not reported as an incarnation change | flush: spec F12 |
| review | **R-7: one shard that throws stops the flush sweep** | stack cron: shards before and after a failing one |
| review | R-7: the maintenance sweep waits on the flush sweep | stack cron: a listing that fails stops only its own sweep |
| review | R-7: no bound on the shards asked per cron | stack cron: at most maxShards per cron |
| review | R-7: the window of shards never moves on | stack cron: same |
| review | **R-11(b): maintenance after every run, changed or not** | flush consumer: a duplicate delivery asks for nothing |
| review | R-11(b): a redelivery after a failed request does not ask again | flush consumer: a redelivery asks again |
| review | R-11(b): a run that admitted something and then stopped does not ask | flush consumer: a run that admitted and stopped still asks |
| review | R-11(b): a flush never reports a change | flush consumer: onFlushed after a run that changed something |
| review | **R-11(c): the marker write is not retried** | stack cron: two runs that finish together both succeed |
| review | R-11(c): an unchanged marker is written again | stack cron: an unchanged marker is not written |
| review | **R-12: one dead-letter object per message** | flush consumer: ONE object for the whole batch |
| review | R-12: a batch whose dead-letter write failed is acknowledged | flush consumer: every message retried |
| review | versions: a flush message of an unknown version is flushed / is dead-lettered (2) | flush consumer: v absent or 1 is flushed, any other retried |
| review | versions: a maintenance message of an unknown version is run | stack cron: v absent or 1 runs, any other retried |
| review | versions: a marker of an unknown version is acted on by the run / by the cron (2) | stack golden: reader refusals |
| review | versions: a dead-letter object of an unknown version is read as version 1 | flush golden: r2.dead-letters |
| review | encoding: the flush message, the marker lose their version; `inputs16` with another separator; a flush key with nine hex digits (4) | the golden test of each format |

| Part | Mutant | Killed by |
|---|---|---|
| trigger | a seal writes no notification | shard: announces once on size |
| trigger | a notification that could not be sent is dropped | shard: unsent notification kept and retried across eviction |
| trigger | a seal on age (alarm) is not announced | shard: announces on age |
| trigger | the shard never removes its pending marker | shard: marker life |
| trigger | the pending marker is not written at a seal | shard: marker life |
| trigger | `pendingTenants` lists recorded segments too | shard: pending tenants |
| trigger | **the sweep enqueues when idle** (asks every shard of every pool map) | stack: idle deployment, zero wakes |
| trigger | the sweep ignores how long a segment has been pending | flush: sweep, "and only those" |
| trigger | a failed flush is acknowledged | flush: retries one message when the run throws |
| trigger | admitted-but-unlogged is acknowledged as done | flush: retries while not logged |
| trigger | every message of a failed group is retried | flush: retries ONE message |
| trigger | junk is acknowledged without a dead letter | flush: dead letters |
| trigger | the cron enqueues tenants that are not due | stack: seal → flush → maintenance |
| trigger | a flush does not ask for maintenance | stack: seal → flush → maintenance |
| trigger | the orphan sweep stays due after a sweep that found nothing (idle tenants wake daily) | stack: idle deployment, a week of crons; a tenant whose data has all expired loses its marker |
| trigger | the maintenance message after a flush does not say it wrote | stack: the orphan sweep runs only while objects may have been written |
| trigger | the marker written after a flush does not say the sweep is needed | stack: same (the lost-message case) |
| trigger | a merge that crashed does not mark the orphan sweep as needed | stack: same (the crashed-merge case) |
| compaction | **samples and series swapped in two replaces (not paired)** | compact: one replace for both tables |
| compaction | series inputs left live after the merge | compact: ledger lists exactly the pair |
| compaction | the series file is not merged (first input reused) | stack: I8 property, all seeds |
| compaction | only the first two sample inputs are merged (rows lost) | stack: I8 property, all seeds |
| compaction | outputs of a conflicted merge are left behind | compact: conflict |
| compaction | **a conflicted step deletes outputs an identical step made live and a later change removed** (within their grace) | compact: conflict after an identical step won |
| compaction | conflict reported as merged | compact: conflict |
| compaction | the step deadline is not checked before replace | compact: guards |
| compaction | the row-count check is dropped | compact: guards |
| compaction | a day is treated as closed before it ends | compact: policy |
| compaction | the budget on pairs per merge is ignored | compact: policy |
| compaction | output keys do not carry the content hash | compact: keys per the contract |
| compaction | the engine keeps the earlier input on a duplicate | engine/storage: `cargo test --test merge` |
| precedence | **`plan` lists files in key (text) order again** | stack: the latest write wins, all six seeds; ledger: precedence order |
| precedence | compaction merges its inputs in key order | stack: the latest write wins |
| precedence | a compaction output ranks as new instead of covering its inputs | stack: the latest write wins |
| precedence | the files of one unit all rank the same (no position) | ledger: precedence order |
| precedence | the ledger admits a merge that jumps over a file overlapping it | ledger: refuses a merge whose range would jump over a file |
| precedence | the policy picks groups that jump over a file overlapping them | compact: precedence policy |
| precedence | the policy ignores live files without a partner | compact: precedence policy |
| precedence | a rebuilt ledger forgets precedence | ledger: keeps precedence across a rebuild |
| precedence | (the same text-order mutant, through the ledger's own suite) | ledger: precedence order |
| deletion | **deletable before the removal is logged** | ledger: committed but not logged; janitor: same |
| deletion | deletable inside the grace | janitor: reader holding the old plan |
| deletion | a live key is deletable | ledger: a key that is live again |
| deletion | the janitor deletes every tombstone without asking | janitor: grace; not logged |
| deletion | expire / replace record no tombstone (2 mutants) | janitor: purge finds nothing to delete |
| deletion | **the orphan sweep ignores pending units** | janitor: pending unit (the race) |
| deletion | the orphan sweep takes an unknown stream for a dead one | janitor: first unit of a stream |
| deletion | the orphan sweep judges by the committed watermark | janitor: logged, not committed |
| deletion | the orphan sweep deletes live and tombstoned objects | janitor: several |
| deletion | a compaction output is an orphan as soon as a flush file would be | janitor: merge in flight; true orphans |
| deletion | series files are not expired | janitor: expires both tables |
| deletion | retention keeps one day too few | janitor: policy, expire |
| deletion | retention is due at every midnight (idle tenants wake daily) | stack: idle deployment, a week of crons |
| deletion | retention is due a day before the oldest day expires | stack: idle deployment (the marker names the expiry date) |
| deletion | an unreadable retention record means one day | janitor: policy |
| limit | **the limit refuses existing series** | shard: window; edge: Remote Write at the limit |
| limit | the limit is not enforced | shard: refuses the new ones that do not fit |
| limit | a refused batch is counted anyway | shard: same |
| limit | every new series is refused, not only those that do not fit | shard: same |
| limit | series ids are not checked against the batch header | shard: inconsistent request |
| limit | the window never forgets | shard: forgets after a whole window |
| limit | above the threshold nothing is known | shard: sketch mode, existing accepted |
| limit | the sketch estimate uses the wrong constant | shard: accuracy within 5% |
| limit | the series window is saved on every append | shard: saved from the alarm only |
| limit | edge does not leave the refused series out | edge: 7 samples written |
| limit | edge answers 204 although series were refused | edge: 429 |
| limit | edge sends the whole limit to every shard | edge: share |
| limit | an unreadable limits record means no limit | edge: default |
| limit | OTLP partial_success does not count the refused points | edge: OTLP |
| limit | edge sends no series ids | edge: nothing is metered |

Part 5 (series-id locality) changed no code: the decision keeps `series_id` as it is
(`DECISIONS.md` D19). Its mutation checks are the ones that pin that definition, re-run in
this review with `edge/scripts/mutants.mjs` (whole edge suite): labels not sorted;
empty-valued labels kept; the series id without the separator after a value; without the
carry between its 32-bit halves; labels sorted in JavaScript string order instead of UTF-8
bytes; plus `engine/storage`'s mutant 21 (id without the `0x00` separators, killed by the
Python-computed vector). The locality experiment itself refuses to report unless both
encodings return identical results and the locality ids do not collide.

### End to end, driven by hand (`test/e2e.test.ts`)

Each test builds its own world: two tenants (`tenant-a-…`, `tenant-b-…`) with API keys in
KV and the **same** pool map of two shards, so both tenants have a stream in both shard
objects. Each tenant sends one Remote Write request (snappy protobuf: 11 series spread over both
slots, a staleness marker, a NaN with a payload, `-0`, `Infinity`, a denormal, an
empty-valued label, and two series whose labels are byte-identical in both tenants) and one
OTLP/HTTP protobuf request (a gauge, a monotonic sum, a `NO_RECORDED_VALUE` point, a point
attribute named `job`). "Exactly the samples sent" means the sorted list of
`labels @ts =value-bits` strings returned equals the list built from the requests.

| Test | What it asserts |
|---|---|
| returns exactly what two tenants sent, before flush, after flush and after the shard discards | tail reads equal what was sent (all tail); sealing writes nothing; after flush the objects exist under keys matching `contracts/TABLES.md` with the content hash recomputed from their bytes, the incarnation and sequence range of their shard stream; each tenant's ledger lists exactly its own objects and none of the other's; the objects read on their own hold only that tenant's series; lake + empty tail and lake + the whole overlapping tail both equal what was sent (rows counted once); after the shards discard, lake only equals what was sent and a reader with the old watermark is refused |
| is read back identically by an independent Parquet reader (hyparquet) | hyparquet, running in the test, reads every samples file of tenant A: footer and decoded row counts equal `FileEntry.rows`; the wrapping sum of `ts`, the wrapping sum of `series_id` (FNV-1a computed in the test), the XOR of non-NaN value bits and the NaN count equal those of the samples sent; rows are sorted and unique; series files have canonical labels of this tenant only |
| two concurrent flushes of every stream leave no duplicate file and identical query results | 8 runs at once (2 per tenant and shard): no key listed twice, no orphan, one unit per stream, results unchanged, a later run rewrites nothing |
| converges after a failure between PUT and addUnit, and between addUnit and recorded | one stream fails at each point; queries stay exact in the half-done state (also with the overlapping tail); shards discard nothing; re-running converges with no object rewritten and no second unit |
| loses nothing when the shard and ledger objects are evicted mid-way, or when a ledger loses its storage | all four objects evicted after ingest, after seal, and between every two steps of every flush; then tenant A's ledger cannot log, admits units, loses its storage and rebuilds; tenant B is not held back; every row is still returned and the next flush re-admits |
| a retried Remote Write request, and the same samples batched differently, change no result | the identical request stores nothing (fingerprints); the same samples with a 600-byte batch cap and in reverse series order are stored again and are invisible: in the tail, after flush, retried again after the flush, flushed again (duplicates across two generations of files), and after discard |

`node tools/hyparquet_check.mjs` runs the second test, takes one produced file out of it and
reads it with hyparquet in Node. Last run: file of 31 rows, **4 of 4 checks agree** (footer
row count against the ledger's `rows`; decoded row count and wrapping sum of `ts` against
the shard's own batches for that segment; sort order).

The flush mutants (`flush/scripts/mutants.mjs --stack`) run against this suite killed 8 of
18 when it was written (see `flush/README.md`); that run was not repeated for this work.

## Contract changes made during integration

Two comments in `contracts/ledger.ts` and one sentence in `contracts/BATCH.md`. No type,
key or behaviour changed.

1. **`ledgerBaseKey`: "sorts before its first version" was false.** `…/{incarnation}/base.json`
   sorts *after* `…/{incarnation}/000000000001.json` in a key listing (`b` > digits). The
   comment now says the base is logically first (its `version` is the version the
   incarnation starts from) and that a reader fetches it by key instead of relying on list
   order. `ledger/test` asserts the listing order so the statement stays true.
2. **`registerStream` and a lower incarnation.** `StreamRef` says the ledger refuses a lower
   incarnation, but `registerStream`'s return type has no refusal. The comment now says it
   throws. (A status would be cleaner; that is a type change and was left for the owner.)
3. **`BATCH.md`, Size:** one sentence added naming where the number lives in code
   (`MAX_BATCH_BYTES` in `shard/src/shard.ts`, imported by `edge`).

Also seen, not changed by this work: `contracts/engine.ts` was edited by someone else while
this was in progress (`selectors` gained `stepMs`; `queryInstant` may return a matrix or a
string). The binding in `engine/wasm/js` compiles against the new text.

## Contract changes made for the automatic write path

| File | Change |
|---|---|
| `contracts/BATCH.md` | New section "Active series": `seriesIds` and `seriesLimit` on `Shard.append`, the `series_limit` and `invalid` answers, the window, the KV record. One sentence added to the `series_id` rule: all 64 bits distinguish series (D19). No change to the batch bytes or to `series_id` |
| `contracts/TABLES.md` | Object keys of compaction outputs (`L{level}-{span}-{inputs16}-{hash8}`), the pairing rule, and the statement that precedence between FILES that disagree on a value is by key order and is not preserved by compaction |
| `contracts/engine.ts` | `mergeFiles(table, files)` |
| `contracts/ledger.ts` | A marked "PROPOSED ADDITION" block: `Tombstone`, `OrphanCheck`, `LedgerJanitorRpc` (`deletable`, `forget`, `removedSince`, `orphanCheck`) |
| `contracts/ledger.ts` (this review) | **File precedence**: `LiveFile` (`FileEntry` + `precedence`, `precedenceLow`, assigned by the ledger) and `PRECEDENCE_PER_VERSION`; `Plan.files` and `LedgerChange.added` are `LiveFile[]`, `plan` lists in ascending precedence; `ReplaceResult`'s `conflict` gains `blocking`; `replace` refuses a merge that jumps over an overlapping file. Requests are unchanged (`FileEntry`) |
| `contracts/TABLES.md` (this review) | "When files disagree … the one later in key order wins" replaced by the precedence rule |
| `contracts/engine.ts` (this review) | Comments only: `sampleFiles` and `mergeFiles` inputs go in ascending precedence |
| `shard/src/shard.ts` (the shard's surface) | `AppendRequest.seriesIds`/`seriesLimit`; `AppendResult` gains `series_limit` and `invalid`; `pendingTenants`, `seriesCount`; `FlushMessage`, `ShardEnv`, the pending-marker key |

`design/DESIGN.md` was corrected in three places (§4.3 the trigger, §5.1 the `series_id`
sentence, §5.2 compaction and deletion as built) and `design/DECISIONS.md` gained D18–D21.
The published design page (`design/artifact/`) was not regenerated, and none of this has
had the adversarial review `AGENTS.md` asks for protocol changes.

## Known risks

- **Graces are real time in the soak**, scaled to 1–1.5 s; a deletion is checked against
  its rule when it happens, but a machine that stalls for seconds changes which
  operations a run exercises. Two runs with one seed are not identical.
- **Files that disagree** are now ordered by the ledger's precedence (D22) and tested with
  rewrites (`test/precedence.property.test.ts`); the soak's model still sends one value per
  `(series, ts)`. Admission order equals write order across streams only once the
  shard-map handover is built; a series moved between shards before that could, in
  principle, have an older write admitted later.
- **The query Worker** (`query/`, not edited) still sorts files itself (`byPrecedence`) and
  one of its tests asserts the old key order; see "What `query/` should change now".
- **The cron is the only clock.** A tenant's time-driven work (a day closing, retention, a
  grace ending) happens at the first cron after it is due: up to an hour late.

- **One script hides binding mistakes.** Everything shares one `env`; a production wiring
  error (a missing binding, the wrong bucket) cannot show up here.
- **Local simulators.** R2 conditional writes, KV, Durable Object storage and eviction are
  miniflare's. Nothing here says how the real services behave under failure or load.
- **Small data.** The end-to-end tests send about 60 samples per tenant; the larger runs are
  the measurements in `flush/` and `engine/wasm/`.
- **A test run near UTC midnight** produces files for two days; the assertions allow for
  it but that path has only been exercised in `flush/test`.
