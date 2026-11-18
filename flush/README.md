# Flush

The flush Worker: sealed segments of one tenant in one shard become Parquet files on R2
that the tenant's ledger lists (`design/DESIGN.md` §4.3). It keeps no state.

| File | Contents |
|---|---|
| `src/flush.ts` | `flushTenant(env, engine, tenant, shardName, opts?)`: the whole procedure, with every answer of the shard, the ledger and R2 handled |
| `src/keys.ts` | `dataFileKey`: object keys exactly per `contracts/TABLES.md` |
| `src/index.ts` | The Worker: `Flush` entrypoint (RPC `flushTenant(tenant, shardName)`; `POST /flush`), one engine per isolate |
| `test/flush.test.ts` | 20 tests in workerd against the real `Shard` and `Ledger` objects and a simulated R2 |
| `test/read.ts` | A reference read path ("what would a query see now?") used by these tests and by `stack/` |
| `test/measure.test.ts` | Local timings (1 test) |
| `scripts/mutants.mjs` | Mutation check |

Bindings: `SHARD`, `LEDGER` (Durable Object namespaces), `BUCKET` (R2), `CELL` (default `cell-0`).
For now the shard and ledger classes ship in this script so the tests use the real objects.

## What it does

For each pending segment of the tenant in that shard, in sequence order:

1. `shard.readSegment` — the segment's batches. Refused (`segment_incomplete`) if the shard
   no longer holds every batch of a segment it lists.
2. `engine.encodeSegment` — one `metric_samples` and one `metric_series` file per UTC day.
3. For each file: SHA-256, then the key
   `{cell}/data/{table}/tenant={tenant}/day={day}/L0-{shard}-{incarnation}-{seqLo}-{seqHi}-{hash8}.parquet`
   and a `PUT` with `If-None-Match: *` (`onlyIf: { etagDoesNotMatch: '*' }`), sending the
   SHA-256 so R2 verifies the upload and keeps the digest. If the object exists it counts
   as written **only if its size and SHA-256 equal this file's** (R2's stored digest, or the
   object is read and hashed when it has none); otherwise the run stops with `object_conflict`.
4. `ledger.addUnit` — **all files of the segment as one unit**.
5. `ledger.loggedWatermarks()`.
6. `shard.recorded(tenant, incarnation, logged)` with the **logged** watermark, never the
   committed one. If the log has not caught up the shard is told nothing new, the result
   says `awaitingLog: true`, and a later run finishes the job without reporting anything twice.

Before any of that, one cheap `ledger.plan` (empty range) gives the committed watermark:
segments at or below it are skipped (already admitted by an earlier or concurrent run), and
a first pending segment that does not start right after it is a `gap`.

Every answer is handled explicitly:

| Answer | What flush does |
|---|---|
| `addUnit` → `ok` | continue to step 5 |
| `addUnit` → `not_contiguous`, watermark at or past the segment | already admitted: continue to step 5 |
| `addUnit` → `not_contiguous`, watermark inside the segment | stop: `overlap` |
| `addUnit` → `not_contiguous`, watermark before the segment | the ledger went back (rebuilt from its log without an unlogged unit). Re-read the shard's pending list and the ledger's watermark and report again from the segment that extends it; at most twice, then `no_progress` |
| `addUnit` → `incarnation_mismatch`, ledger's incarnation is **lower** | `ledger.registerStream` with the shard's incarnation, then `addUnit` once more; a second mismatch stops with `incarnation_mismatch` |
| `addUnit` → `incarnation_mismatch`, ledger's incarnation is **higher** | stop: `stale_incarnation` (the shard reported an old stream; registering it would be refused) |
| `addUnit` → `invalid` | stop: `invalid_unit`, with the ledger's reason |
| `recorded` → `incarnation_mismatch` | stop: `shard_incarnation_changed` |
| `recorded` → `not_contiguous` | stop: `shard_not_contiguous` |
| R2 or an object throws | the exception propagates; the caller retries the run |

A stop is `status: 'error'` with `reason` and `detail` (HTTP 409 on the fetch route). It
never acknowledges the shard for the segment it stopped on.

### Why it is safe to run twice at once, and to stop between any two steps

- Encoding is deterministic, so the same segment gives the same bytes and the same keys.
  A second `PUT` is refused by `If-None-Match` and accepted as done after comparison.
  If two attempts ever produced different bytes they would have different keys, and the
  ledger would list exactly the bytes of the unit it admitted.
- `addUnit` for a range at or below the watermark answers `ok` and changes nothing
  (contract replay rule), so a segment is one unit however many runs report it.
- Stop after PUT: objects exist, nothing is visible, the shard still holds the rows. The
  next run finds the objects (`exists`) and reports them.
- Stop after `addUnit`: files are visible, the shard still holds the rows; a query asks the
  shard only for rows above the watermark, so nothing is counted twice. The next run skips
  the segment and records it.
- The shard discards only after `recorded`, and `recorded` carries only the logged
  watermark, so a ledger that loses its storage and rebuilds from R2 never comes back
  below what a shard has discarded.

## What will trigger it in production

Nothing triggers it here: the caller decides (tests call it directly). The intended wiring:

1. **A seal notification.** When a shard seals a segment (on size in `append`, on age in its
   alarm), it sends `{ tenant, shard }` to a Queue; a consumer in this Worker calls
   `flushTenant`. The message is only a nudge: flush reads the pending list from the shard,
   so a duplicated or late message does no harm.
2. **A sweep.** A Cron Trigger (or the shard's own alarm) re-issues the nudge for streams
   with pending or `awaitingLog` segments, so a lost message delays a flush and loses nothing.

Neither exists yet. The shard does not emit anything on seal, and nothing enumerates
`(tenant, shard)` pairs with pending segments.

## Not implemented

- The Queue consumer, the sweep, and any retry policy around a failed run.
- Bindings to separately deployed shard and ledger scripts (`script_name`).
- Authentication of the `POST /flush` route. It must not be given a public route; the tenant
  in its body is trusted because the caller is viz itself.
- Cleaning up orphans: objects written by a run that stopped before `addUnit` and whose
  segment was then admitted with different bytes (cannot happen while encoding is
  deterministic), or objects of a unit the ledger lost (they are found and reused).
  The orphan sweeper of the design does not exist.
- Compaction, rollups, retention.
- Splitting a segment that is too large to encode in one isolate (segments are ~4 MB by
  the shard's `sealBytes`; nothing here enforces an upper bound).
- Metrics about flush itself. Nothing has been run on Cloudflare or under load.

## How it was verified

```
(cd ../engine/wasm && ./build.sh)       # the tests import ../engine/wasm/js/viz_engine.wasm
npm install
npm test            # 21 tests in workerd, 2 files: flush.test.ts 20, measure.test.ts 1
npx tsc --noEmit    # clean
node scripts/mutants.mjs            # 18 mutants against test/flush.test.ts
node scripts/mutants.mjs --stack    # the same mutants against ../stack's end-to-end suite
```

What the tests establish (each on a fresh tenant and shard):

- **Keys** equal the contract string, recomputed from each object's own bytes; shard names
  with `/` become `_`; malformed parts are refused.
- **One unit per segment**: the ledger's log holds one `add_unit` per sealed segment with
  the segment's exact `unit: {seqLo, seqHi}`; every samples file is listed with its series
  file; a segment crossing midnight yields files for both days in the same unit.
- **Reads are exact at three moments** (all tail; lake + tail, also with the whole tail
  overlapping the lake; after the shard discards), including a staleness marker and an
  in-batch duplicate.
- **Tenants**: flushing tenant A in a shared shard writes nothing for B, records nothing
  for B, and A's objects hold only A's series.
- **Three concurrent runs**: each object created exactly once, each segment one unit.
- **Crash after PUT / after addUnit / after recorded**: the next run converges; object
  versions are unchanged (nothing was overwritten); no second unit.
- **Eviction** of the shard and the ledger between every two steps of a run.
- **Logged, not committed**: with the ledger's log unwritable, flush admits the units and
  tells the shard nothing; the ledger then loses its storage; the shard still has every
  row and the next run re-admits them. With the log healed instead, the next run only records.
- **`not_contiguous`** (ledger lost an unlogged unit mid-run; a racing run already admitted
  the segment), **`gap`**, **`incarnation_mismatch`** (shard storage loss), **`stale_incarnation`**,
  **`invalid`**, and an existing object with the same size and other bytes, another size,
  or identical bytes but no stored checksum.
- **Entry points**: RPC `Flush.flushTenant`, `POST /flush` (200, 400, 404, 405, 409).

### Mutation checks

`scripts/mutants.mjs` applies one change to the source, runs `test/flush.test.ts`, and
restores the file. **18 of 18 killed.** The first six are the ones the task named.

| # | Mutant | A test that fails |
|---|---|---|
| 1 | Shard acknowledged with the committed watermark instead of the logged one | tells the shard only what the ledger has LOGGED… |
| 2 | PUT without `If-None-Match` | converges after a crash between PUT and addUnit, without rewriting any object |
| 3 | Contiguity handling dropped (`not_contiguous` taken as admitted) | not_contiguous: re-reads the watermark and reports again what the ledger no longer has |
| 4 | Two segments in one unit | turns each sealed segment into one unit… |
| 5 | Series file omitted from the unit | turns each sealed segment into one unit… |
| 6 | A refused PUT trusted without comparing the existing object | an existing object counts as written only if its size and hash match |
| 7 | Existing object compared by size only | same |
| 8 | Existing object without a stored checksum trusted unread | same |
| 9 | Key hash not derived from the file bytes | turns each sealed segment into one unit… |
| 10 | Shard name not sanitised in the key | builds the key of contracts/TABLES.md exactly |
| 11 | New shard incarnation not registered on `incarnation_mismatch` | incarnation_mismatch: registers the shard's new incarnation and retries once |
| 12 | An older shard incarnation registered over a newer one | stale_incarnation: stops when the ledger knows a NEWER incarnation… |
| 13 | `invalid` from the ledger ignored | invalid: stops and surfaces the ledger's reason… |
| 14 | Already-admitted segments encoded and reported again | converges after a crash between addUnit and recorded, without a second unit |
| 15 | Gap in front of the first pending segment not detected | gap: stops when rows … are in neither |
| 16 | Shard never told `recorded` | turns each sealed segment into one unit… |
| 17 | Shard told `recorded` before the unit is reported | converges after a crash between addUnit and recorded… |
| 18 | One unit per file instead of one per segment | turns each sealed segment into one unit… |

Against the end-to-end suite in `stack/` alone, 8 of the 18 are killed (1, 2, 5, 9, 10, 16,
17, 18). The other ten need states that suite does not construct (a squatting object, a
ledger behind or ahead, a recreated shard), which is what `test/flush.test.ts` is for.

### Measurements (local workerd under vitest, 1 ms timers; not Cloudflare)

`npx vitest run test/measure.test.ts --reporter=verbose`. One hour for 2,000 series at 15 s:
480,000 samples in 12 batches of 1,007,032 bytes, sealed every 4 batches.

Flush of one sealed segment of **4,028,128 bytes** of batches (160,000 rows → 231 KB of
samples Parquet + 41 KB of series Parquet):

| | first run (cold instance) | second run |
|---|---|---|
| wall time of `flushTenant` | 203 ms | 89 ms |
| `encodeSegment` (synchronous WASM, so CPU) | 146 ms | 59 ms |
| the rest: 2 PUTs, SHA-256, 6 RPCs to local objects | 57 ms | 30 ms |
| WASM linear memory after the run | 14.8 MB | 15.0 MB |

CPU time other than the encode call was not measured (workerd exposes no CPU clock);
SHA-256 of 272 KB and the RPC serialisation of 4 MB are in the "rest" line.

`select` over the whole hour for all 2,000 series, from the lake (2 units = 4 files,
507,071 bytes: the first 40 minutes) plus the tail (4 batches, 4,028,128 bytes: the last
20 minutes), 5 runs, a fresh engine instance each:

| | |
|---|---|
| `engine.select`, 2,000 series, 480,000 samples | 49–81 ms (median 62) |
| fetching: 2 plans, 4 R2 GETs, 1 `tailRead` | 13–30 ms |
| WASM linear memory | 33.0 MB |
| `select` of one metric (100 series, 24,000 samples), same inputs | 7–23 ms |

## Known risks

- **One isolate, one segment at a time, synchronously.** A 4 MB segment costs 60–150 ms of
  CPU here. A much larger segment, or many pending segments in one run (`maxSegments`
  defaults to 64), can exceed a Worker's CPU limit; the run then dies between steps, which
  is safe, but it would die at the same place again.
- **`recorded` lags a slow ledger log.** With R2 failing, units are admitted and visible but
  shards keep the rows (and their byte budget) until the log catches up and flush runs again.
- **A `gap` or `object_conflict` needs a person.** Flush stops and says so; nothing repairs it.
- **The read path in `test/read.ts` is test code.** It makes two `plan` calls and compares
  versions; the real query path needs one call that returns both tables.
- **Tail batches from several shards** are passed to the engine in shard order. If the same
  `(series, ts)` sits in two shards (a retry after a pool-map change) the later shard in
  that order wins; nothing defines which is right.
- **R2 conditional PUT** was exercised against the local R2 simulator only.
