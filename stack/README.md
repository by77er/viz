# Stack

The write path as **one script**: `edge` (the default export's `fetch`), the `Shard` and
`Ledger` Durable Objects, `flush` (the `Flush` entrypoint and the flush queue's consumer),
and the maintenance of each tenant's files (compaction, retention, deletion), behind one
wrangler config that binds `SHARD`, `LEDGER`, R2 (`BUCKET`), KV (`CONFIG`), two queues
(`FLUSH_QUEUE`, `MAINT_QUEUE`) with their dead-letter queues, and an hourly cron.

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
| `wrangler.jsonc` | The single config: queues, consumers, dead-letter queues, cron |
| `test/e2e.test.ts` | 6 end-to-end tests that drive flush by hand |
| `test/auto.test.ts` | 1 test where nothing is called: the simulated Queue delivers |
| `test/triggers.test.ts` | 8 tests of the triggers, the maintenance marker, the orphan-sweep flag and the idle deployment |
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
| A flush run ends ok | `{tenant}` on the maintenance queue, and the tenant's maintenance marker exists | `noteFlushed` |
| A maintenance message is delivered | `maintainTenant`: retention expire, up to 8 compaction merges, deletion of what the ledger calls deletable, and (at most daily, and only while objects may have been written since the last sweep that found nothing to wait for) the orphan sweep; then the marker is rewritten with the next time anything can be due, or deleted if the tenant has nothing left | `src/maintain.ts` |
| The cron fires (hourly) | (1) streams of shards with a pending marker whose segments have waited 10 minutes are re-enqueued; (2) tenants whose maintenance marker is due are enqueued | `sweepPending`, `enqueueDue` |
| A message exhausts its retries | written to `{cell}/dead-letters/{queue}/…json` and logged; the next sweep re-enqueues the work | `consumeDeadLetters` |

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
file after 24 h and only below its stream's logged watermark; a compaction step gives up
after 5 min, and an unreferenced compaction output is deleted after 24 h.

## Not implemented

- **A query Worker.** The read path here is test code; nothing serves queries.
- **Separate deployment.** In production these are several Workers bound to each other;
  that wiring (service bindings, `script_name` on the Durable Object bindings, the queue
  consumers in their own scripts) is not written.
- **The ledger ↔ shard-map epoch**, the publisher, rollups.
- **The compaction Workflow is not started from here**; the maintenance consumer calls the
  step function (see `compact/README.md`).
- **Alerting** on dead letters; they are written to R2 and to the error log only.
- **Concurrency limits** on maintenance (two messages for one tenant in different batches
  run two maintenance runs; each step is safe to run twice, it is only wasted work).
- Nothing was deployed to Cloudflare. Queue delivery, cron and KV metadata are miniflare's.

## How it was verified

```
(cd ../engine/wasm && ./build.sh)
npm install
npm test                         # 30 tests in workerd, 6 files (soak: 400 steps)
npm run soak                     # the soak with 3,000 steps
npx tsc --noEmit                 # clean
node scripts/mutants.mjs all     # mutation check, four parts
node tools/hyparquet_check.mjs   # 4 checks agree
```

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

**Result.** Last run (`npm run soak`, seed 20261118, on the final code with the stricter
per-step check of the live set): 3,000 steps, **every invariant held at every step**;
289 s. 907 acknowledged requests (and 194 repeats of samples already sent), 234 segments
admitted through 1,205 delivered flush messages (150 retried after injected failures), 425
merges (329 in maintenance runs, 96 in direct steps), 16 conflicts, 25 crashed steps,
1,420 files expired, 3,896 objects purged, 34 orphans deleted, 124 evictions, 57 ledger-log
outages, 57 old-plan readers verified, 0 dead letters; at the end each tenant's R2 prefix
is exactly its ledger's live set, all level 2. The previous engineer's three runs of 3,000
steps on earlier code also held. `npm test` runs 400 steps (about 20 s).

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
notice, and restored. Last run: **57 of 57 killed** (trigger 14, compaction 12, deletion 15,
limit 16). `flush/scripts/mutants.mjs` (18 of 18) was re-run after flush's PUTs were made
parallel.

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
| compaction | **samples and series swapped in two replaces (not paired)** | compact: one replace for both tables |
| compaction | series inputs left live after the merge | compact: ledger lists exactly the pair |
| compaction | the series file is not merged (first input reused) | stack: I8 property, all seeds |
| compaction | only the first two sample inputs are merged (rows lost) | stack: I8 property, all seeds |
| compaction | outputs of a conflicted merge are left behind | compact: conflict |
| compaction | conflict reported as merged | compact: conflict |
| compaction | the step deadline is not checked before replace | compact: guards |
| compaction | the row-count check is dropped | compact: guards |
| compaction | a day is treated as closed before it ends | compact: policy |
| compaction | the budget on pairs per merge is ignored | compact: policy |
| compaction | output keys do not carry the content hash | compact: keys per the contract |
| compaction | the engine keeps the earlier input on a duplicate | engine/storage: `cargo test --test merge` |
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

Part 5 (series-id locality) changed no code, so it has no mutants of its own; the three
existing series-id mutants in `edge/scripts/mutants.mjs` still guard the contract's
definition.

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
| `shard/src/shard.ts` (the shard's surface) | `AppendRequest.seriesIds`/`seriesLimit`; `AppendResult` gains `series_limit` and `invalid`; `pendingTenants`, `seriesCount`; `FlushMessage`, `ShardEnv`, the pending-marker key |

`design/DESIGN.md` was corrected in three places (§4.3 the trigger, §5.1 the `series_id`
sentence, §5.2 compaction and deletion as built) and `design/DECISIONS.md` gained D18–D21.
The published design page (`design/artifact/`) was not regenerated, and none of this has
had the adversarial review `AGENTS.md` asks for protocol changes.

## Known risks

- **Graces are real time in the soak**, scaled to 1–1.5 s; a deletion is checked against
  its rule when it happens, but a machine that stalls for seconds changes which
  operations a run exercises. Two runs with one seed are not identical.
- **Files that disagree.** The model sends one value per `(series, ts)`. Which value
  survives when two files hold different ones is not defined across a compaction
  (`contracts/TABLES.md`).
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
