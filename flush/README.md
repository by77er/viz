# Flush

The flush Worker: sealed segments of one tenant in one shard become Parquet files on R2
that the tenant's ledger lists (`design/DESIGN.md` §4.3). It keeps no state.

| File | Contents |
|---|---|
| `src/flush.ts` | `flushTenant(env, engine, tenant, shardName, opts?)`: the whole procedure, with every answer of the shard, the ledger and R2 handled |
| `src/keys.ts` | `dataFileKey`: object keys exactly per `contracts/TABLES.md` |
| `src/index.ts` | The Worker: `Flush` entrypoint (RPC `flushTenant(tenant, shardName)`; `POST /flush`; `queue`), one engine per isolate |
| `src/consumer.ts` | `consumeFlushBatch`: the flush queue's consumer; `consumeDeadLetters`, `listDeadLetters` |
| `src/sweep.ts` | `sweepPending`: re-enqueue streams whose segments are still pending, found through KV markers, at most `maxShards` per sweep; `shardsFromPoolMaps`, `rotation` |
| `src/formats.ts` | `FORMATS` and `READS`: the formats flush writes and reads, by version (contracts/COMPATIBILITY.md §3.1) |
| `test/flush.test.ts` | 21 tests in workerd against the real `Shard` and `Ledger` objects and a simulated R2, one of them the protocol model's F12 |
| `test/consumer.test.ts` | 18 tests of the consumer, the dead-letter path, the sweep, and the review's R-11(b) and R-12 |
| `test/golden.test.ts`, `test/golden/` | 5 tests: golden files of every format written, and the readers' refusals |
| `test/helpers.ts` | Test fixtures shared with `compact/`, `janitor/` and `stack/`: `flushSettled`, ledger fault injection, an independent reader of the ledger's log |
| `test/read.ts` | A reference read path ("what would a query see now?") used by these tests and by `stack/` |
| `test/measure.test.ts` | Local timings (1 test) |
| `scripts/mutants.mjs` | Mutation check (run on a copy of the tree, never in the checkout) |

Bindings: `SHARD`, `LEDGER` (Durable Object namespaces), `BUCKET` (R2), `CELL` (default `cell-0`).
For now the shard and ledger classes ship in this script so the tests use the real objects.

## What it does

For each pending segment of the tenant in that shard, in sequence order:

1. `shard.readSegment(tenant, seqLo, incarnation, seqHi)` — the segment's batches, **bound to
   the incarnation and range the segment was listed with**: the shard answers null unless its
   stream is still that incarnation and the segment exactly that range. After a storage loss a
   shard reuses sequence numbers in a new incarnation, and an unbound read would file the new
   incarnation's rows under the old one's name: permanent duplicates, and a loss that is not
   visible as one (the protocol model's F12). A null read whose stream has changed incarnation
   stops the run (`shard_incarnation_changed`); the next run flushes the new incarnation under
   its own name. Refused (`segment_incomplete`) if the shard no longer holds every batch of a
   segment it lists.
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
| `readSegment` → null, the stream now another incarnation | stop: `shard_incarnation_changed` (F12) |
| `recorded` → `incarnation_mismatch` | stop: `shard_incarnation_changed` |
| `recorded` → `not_contiguous` | stop: `shard_not_contiguous` |
| an `addUnit` or `recorded` status this code does not know (a newer ledger or shard) | throws: fail closed, the caller retries; never taken for success |
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

## What triggers it

Nobody calls `flushTenant` by hand any more (tests still may).

1. **The seal notification.** A shard that seals a segment puts `{ tenant, shard }` on the
   flush queue (`shard/README.md`, "Flush triggering"; why a Queue: `DECISIONS.md` D18). The
   message format is `queue.flush` v1; `v` absent means 1 (the shard writes none, the sweep
   writes `v: 1`).
2. **The consumer** (`consumeFlushBatch`, the `queue` handler of this Worker and of
   `stack/`). Messages of one batch that name the same (tenant, shard) are **one** run.
   A group is acknowledged only when its run ended `ok` with nothing left to do. Otherwise
   (an exception, an `error` status, `awaitingLog`, or `remaining > 0`) ONE message of the
   group is retried, with a delay of 5 s doubling per attempt up to 5 min, and the others
   are acknowledged, so a group never multiplies. Delivery is at-least-once and flush is
   idempotent: a redelivery after success finds no pending segment and writes nothing.
   `awaitingLog` is the case `contracts/LEDGER-LOG.md` makes normal: the unit is admitted,
   the ledger's log has not caught up (it drains about 200 ms after a commit), the shard was
   told nothing new; the retry, 5 s later, finishes it.
   - **Versions** (contracts/COMPATIBILITY.md §3.2): a message whose `v` is not 1 is retried
     with the same backoff, never flushed on a guess and never dead-lettered (a newer release
     wrote it; one that reads it will be running again). That holds even when the rest of
     the body looks invalid.
   - **Maintenance is asked for only when a run changed something** (review R-11(b)):
     `onFlushed` (the stack's `noteFlushed`, which enqueues a maintenance run) is called after
     a run with `changed: true` (it admitted a unit, created an object, or saw a segment it
     handled become recorded), whatever its status, and after ANY run of a group with a
     redelivered message (`attempts > 1`): an earlier delivery may have changed things and
     failed before or inside `onFlushed`. A duplicate delivery that finds nothing asks for
     nothing. If `onFlushed` throws, the group is retried. Nothing is lost if a request is
     still missed: the run's changes are in the ledger, and the stack's hourly cron enqueues
     every tenant whose maintenance marker is due (`stack/src/maintain.ts`).
3. **Dead letters, visibly.** After `max_retries` the queue moves a message to the
   dead-letter queue, whose consumer (`consumeDeadLetters`) writes the whole batch to R2 as
   **one** object, `{cell}/dead-letters/{queue}/{time}-{first id}.json` =
   `{"v":2,"letters":[…]}` (format `r2.dead-letters` v2; review R-12: one PUT per invocation,
   never one per message), logs an error per message, and acknowledges them; if the write
   fails, every message of the batch is retried, none acknowledged. `listDeadLetters` reads
   both versions (v1 was one letter per object, no `v`) and refuses an unknown one by name. A
   version-1 message that is not a `{tenant, shard}` at all is written there at once, all
   such messages of a batch in one object. A dead letter loses nothing: the segments are
   still pending in the shard.
4. **The sweep** (`sweepPending`, called by the hourly cron in `stack/`). It lists the
   `flush-pending:<shard>` keys in KV, asks only those shards for
   `pendingTenants(olderThanMs)` (default 10 minutes) and sends a message per stream
   found. No marker means no Durable Object is woken and no message is sent; a shard
   that is asked and has nothing pending removes its marker. **One shard that throws does not
   stop the others** (review R-7): shards are asked six at a time with `Promise.allSettled`,
   a failure is reported (`failed`) and logged, and found streams are sent in batches of 100
   as soon as there are enough, so what was found is sent even if a later step fails. **At
   most `maxShards` (500) shards per sweep**: Cloudflare documents 10,000 subrequests per
   invocation on the Paid plan, a subrequest being any request to an R2, KV or D1 service
   (developers.cloudflare.com/workers/platform/limits/, read 2026-11-18; whether a Durable
   Object call counts is not stated, so it is assumed to). With more marked shards a window
   of 500 consecutive names (sorted, wrapping) moves on by 500 each hour, so ceil(n / 500)
   hourly crons visit every marked shard, with no state kept. `{ full: true }` is the
   operator's variant for when a marker itself may be lost: it also asks every shard
   named by a pool map in KV (`pool:<tenant>`) and by `DEFAULT_POOL`. **Limitation:** a
   shard that only an older version of a map named (a renamed pool, a reduced slot
   count) is found by neither, and `full` wakes idle shards, so the cron does not use it.

## R2 operations and time per flush

Per sealed segment: one PUT per file (two per UTC day the segment covers), no GET unless a
PUT is refused as existing (then one HEAD each), and on the ledger's side one change
(`addUnit`), which the ledger answers on commit and writes to R2 later in a batch
(`contracts/LEDGER-LOG.md`); a second run (the retry of `awaitingLog`) then tells the shard.
Measured locally: see below.

On Cloudflare (`spikes/s5-r2-writes/`, measured 2026-11-18): a write of up to 1 MB costs
0.17–0.26 s at the median and up to 0.6 s at the tail, conditional or not, and writes share
the six-in-flight limit with reads. A one-day segment's two files (about 0.3 MB together
here) go out together, at most six PUTs in flight per run (`writeSegment` waits for each
group of six): about 0.25 s; `addUnit` is a Durable Object round trip and a SQLite commit,
no R2 write since the log is batched (its time on Cloudflare is being re-measured in
`spikes/s4-ledger-scale/rerun/`). **Modelled: about 0.25–0.3 s per segment (up to about 0.7 s
at the tail)**, plus a second, cheaper run about 5 s later to record it in the shard. The
segments of one run go in sequence, because each unit must extend the watermark.

## Not implemented

- Flushing several streams of one queue batch concurrently.
- The queue wiring in THIS package's `wrangler.jsonc`: the queue and its consumer are bound in `stack/`. The `queue` method here is the same code, not exercised by a real queue from this directory.
- Bindings to separately deployed shard and ledger scripts (`script_name`).
- Authentication of the `POST /flush` route. It must not be given a public route; the tenant
  in its body is trusted because the caller is viz itself.
- Cleaning up orphans: objects written by a run that stopped before `addUnit` and whose
  segment was then admitted with different bytes (cannot happen while encoding is
  deterministic), or objects of a unit the ledger lost (they are found and reused).
  `janitor/` now sweeps these.
- Rollups. (Compaction is `compact/`, retention `janitor/`.)
- Splitting a segment that is too large to encode in one isolate (segments are ~4 MB by
  the shard's `sealBytes`; nothing here enforces an upper bound).
- Metrics about flush itself. Nothing has been run on Cloudflare or under load.

## How it was verified

```
(cd ../engine/wasm && ./build.sh)       # the tests import ../engine/wasm/js/viz_engine.wasm
npm install
npx vitest run --maxWorkers=2   # 45 tests in workerd, 4 files: flush 21, consumer 18, golden 5, measure 1
npx tsc --noEmit                # clean
# mutants, from a COPY of the tree (the scripts refuse a git checkout):
node scripts/mutants.mjs            # 20 mutants against test/flush.test.ts
node scripts/mutants.mjs --stack    # the same mutants against ../stack's end-to-end suite
```

Last run 2026-11-19 against the real tree, with the ledger draining its log asynchronously:
45 of 45, tsc clean. The suite pins `LEDGER_DRAIN_DELAY_MS` to 60 s (`vitest.config.ts`), as
`ledger/` does: the ledger drains only when a test asks (`drain()`, or `flushSettled`, which
runs flush, the drain and flush again until `awaitingLog` is false, as the queue's retry does),
so what one run sees of the logged watermark never depends on when an alarm runs. Tests that
mean "a run as one delivery sees it" assert `awaitingLog: true` and `recordedThrough: 0`
after one run, and the recording after the drain.

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
- **F12** (the model's trace `F12_impl_read_unbound`): the worker lists segment `inc 1, 1..1`;
  the shard then loses its storage and seals a new batch as `inc 2, 1..1`; the run stops with
  `shard_incarnation_changed`, nothing of incarnation 2 is filed under incarnation 1, and the
  next run files it under its own name, read back exactly. Fails without the bound read (the
  run ends `ok` with the new batch admitted as `inc 1`; shown on a copy, 2026-11-19).
- **Consumer**: one run per (tenant, shard) per batch; the retry carrier and its backoff;
  `awaiting_log` retried until the log catches up, with the log healthy and with it broken;
  junk dead-lettered at once in one object; versions (`v` absent or 1 flushed; `v: 2`, `{v: 2}`
  and `v: 'x'` all retried, none flushed, none dead-lettered).
- **R-11(b)**: a duplicate delivery that finds nothing does not ask for maintenance; a
  redelivery after the request failed asks again although it changes nothing; a run that
  admitted something and then stopped with an error still asks.
- **R-12**: the dead-letter consumer makes ONE PUT for five letters, all listed back; if that
  write fails every message is retried and none acknowledged; junk on the flush queue is one
  PUT per batch.
- **Sweep** (R-7's tests are in `stack/test/cron.test.ts`): no marker, no wake; only streams
  pending long enough; a marker cleared once nothing is pending; `full` finds a shard whose
  marker was lost.

### Mutation checks

`scripts/mutants.mjs` applies one change to the source of a copy of the tree, runs
`test/flush.test.ts`, and restores the file. **20 of 20 killed** (2026-11-19, on a copy in the
scratch area). The first six are the ones the task named.

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
| 19 | F12: a segment read unbound to its incarnation and range | spec F12: … the new incarnation's batch is not filed under the old one |
| 20 | F12: a refused bound read not reported as an incarnation change | same |

The consumer's, the sweep's and the formats' mutants (R-7, R-11(b), R-12, versions, goldens)
are in `stack/scripts/mutants.mjs`; results in `stack/README.md`.

Against the end-to-end suite in `stack/` alone, 8 of the first 18 were killed (1, 2, 5, 9, 10,
16, 17, 18; not re-run since). The others need states that suite does not construct (a
squatting object, a ledger behind or ahead, a recreated shard), which is what
`test/flush.test.ts` is for.

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

## Contract issues

- **`v` belongs in `FlushMessage`** (`shard/src/shard.ts`, owned by the shard). Flush types it
  locally as `VersionedFlushMessage = FlushMessage & { v?: number }`. The shard writes no `v`,
  which reads as 1, so nothing is wrong on the wire; the type should move.
- **Key names are not one-to-one with streams** (`contracts/TABLES.md`: a shard's `/` becomes
  `_`). See `janitor/README.md`, "Contract issues": the orphan sweep cannot always tell which
  stream a flush file belongs to when pool names collide that way.

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
