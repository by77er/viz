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
| `test/triggers.test.ts` | 7 tests of the triggers, the maintenance marker and the idle deployment |
| `test/compaction.property.test.ts` | 8 seeded runs of the I8 property test |
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
| A maintenance message is delivered | `maintainTenant`: retention expire, up to 8 compaction merges, deletion of what the ledger calls deletable, and (at most daily) the orphan sweep; then the marker is rewritten with the next time anything can be due, or deleted if the tenant has nothing left | `src/maintain.ts` |
| The cron fires (hourly) | (1) streams of shards with a pending marker whose segments have waited 10 minutes are re-enqueued; (2) tenants whose maintenance marker is due are enqueued | `sweepPending`, `enqueueDue` |
| A message exhausts its retries | written to `{cell}/dead-letters/{queue}/…json` and logged; the next sweep re-enqueues the work | `consumeDeadLetters` |

**Idle means free.** Both sweeps read KV only. A shard has a `flush-pending:` key only
while it has unrecorded segments; a tenant's `maint:` key carries the time it is next due
(a quiet hour, a day closing, the next UTC midnight for retention, a grace ending, the
next orphan sweep) in its metadata, so the cron needs one KV list and no read. Nothing
due: no Durable Object is woken and no message is sent. No object keeps an alarm when it
has nothing to do. `test/triggers.test.ts` counts this.

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
npm test                         # 23 tests in workerd, 5 files (soak: 400 steps)
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
  first cron asks each of the two shards once (they remove their markers); the next five
  crons make **0 Durable Object calls and send 0 messages** (namespaces and queues wrapped
  in counters), no shard or ledger has an alarm, and no pending marker is left.
- `noteFlushed` still asks for a run when KV refuses the marker.

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
none invented); every row belongs to the tenant; every live file is in R2; every samples
file is listed with its series file; every tombstone younger than the grace still has
its object. Checked at each deletion: a purged key had a tombstone, older than the grace
and with a logged removal; an orphan was unreferenced, old enough, and (a flush file)
below its stream's logged watermark. At the end, after flushing, compacting, expiring and
deleting everything: the objects in R2 are exactly the ledger's live set, all level 2, no
tombstone and no pending segment left.

SOAK_RESULTS

MUTANT_RESULTS

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

The flush mutants (`flush/scripts/mutants.mjs --stack`) run against this suite kill 8 of
18; see `flush/README.md` for which and why.

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

## Known risks

- **One script hides binding mistakes.** Everything shares one `env`; a production wiring
  error (a missing binding, the wrong bucket) cannot show up here.
- **Local simulators.** R2 conditional writes, KV, Durable Object storage and eviction are
  miniflare's. Nothing here says how the real services behave under failure or load.
- **Small data.** The end-to-end tests send about 60 samples per tenant; the larger runs are
  the measurements in `flush/` and `engine/wasm/`.
- **A test run near UTC midnight** produces files for two days; the assertions allow for
  it but that path has only been exercised in `flush/test`.
