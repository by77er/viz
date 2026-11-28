# Flush

The flush Worker: sealed segments of one tenant in one shard become Parquet files on R2
that the tenant's ledger lists (`design/DESIGN.md` §4.3). It keeps no state.

| File | Contents |
|---|---|
| `src/flush.ts` | `flushTenant(env, engine, tenant, shardName, opts?)`: the whole procedure, with every answer of the shard, the ledger and R2 handled |
| `src/keys.ts` | `dataFileKey`: object keys exactly per `contracts/TABLES.md` (and the `hour=HH/` level of a `spans` key, `contracts/TRACES.md`) |
| `src/index.ts` | The Worker: `Flush` entrypoint (RPC `flushTenant(tenant, shardName)`; `POST /flush`; `queue`), one engine per isolate |
| `src/consumer.ts` | `consumeFlushBatch`: the flush queue's consumer; `consumeDeadLetters`, `listDeadLetters` |
| `src/sweep.ts` | `sweepPending`: re-enqueue streams whose segments are still pending, found through KV markers, at most `maxShards` per sweep; `shardsFromPoolMaps` (with the derived pools of the signals `INGEST_SIGNALS` enables), `rotation` |
| `src/formats.ts` | `FORMATS` and `READS`: the formats flush writes and reads, by version (contracts/COMPATIBILITY.md §3.1) |
| `test/flush.test.ts` | 21 tests in workerd against the real `Shard` and `Ledger` objects and a simulated R2, one of them the protocol model's F12 |
| `test/consumer.test.ts` | 18 tests of the consumer, the dead-letter path, the sweep, and the review's R-11(b) and R-12 |
| `test/golden.test.ts`, `test/golden/` | 5 tests: golden files of every format written, and the readers' refusals |
| `test/helpers.ts` | Test fixtures shared with `compact/`, `janitor/` and `stack/`: `flushSettled`, ledger fault injection, an independent reader of the ledger's log |
| `test/read.ts` | A reference read path ("what would a query see now?") used by these tests and by `stack/` |
| `test/measure.test.ts` | Local timings (1 test) |
| `test/signals.test.ts` | 8 tests of span and log segments (stage 2): units, keys, bytes, crashes, refusals, the full sweep |
| `test/measure-signals.test.ts` | Local timings and bytes of span and log flushes (2 tests) |
| `test/throughput.test.ts` | 9 tests of D82: the `Limiter`, the pipeline (overlap, order, depth), the wait for the log, the consumer's concurrent runs and its one R2 limit |
| `test/profile.prof.ts`, `vitest.profile.config.ts` | D82's profile, not in `npm test`: `npm run profile` (see "Throughput (D82)") |
| `test/instrument.ts`, `test/workload.ts` | An `env` that times (and can delay) every R2 and Durable Object call; the span and log workloads |
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
   For a segment of a span or log stream (stage 2 of traces and logs; the shards of
   `{pool}/traces` and `{pool}/logs`), chosen by the batches' signal byte (offset 4):
   `engine.encodeSpans` (one `spans` file per UTC hour of start time, then one `trace_index`
   file per UTC day of the fragments' first start) or `engine.encodeLogs` (one `logs` file per
   UTC day), `engine/wasm` ABI 3. A segment whose batches are not all of one signal flush knows
   (1, 2, 3), an engine without the encoder (an older binding), or an encoder output of another
   signal's table stops the run before any PUT: `unreadable_segment` (retried; nothing guessed).
   The ledger's `minTs`/`maxTs` for these files are the floor in milliseconds of their
   nanosecond bounds (`EncodedSignalFile`).
3. For each file: SHA-256, then the key
   `{cell}/data/{table}/tenant={tenant}/day={day}/L0-{shard}-{incarnation}-{seqLo}-{seqHi}-{hash8}.parquet`
   (a `spans` file one level deeper, `…/day={day}/hour={HH}/L0-…`; `dataKeyPrefix` in
   `contracts/ledger.ts`; `dataFileKey` refuses an hour on any other table, or none on spans)
   and a `PUT` with `If-None-Match: *` (`onlyIf: { etagDoesNotMatch: '*' }`), sending the
   SHA-256 so R2 verifies the upload and keeps the digest. If the object exists it counts
   as written **only if its size and SHA-256 equal this file's** (R2's stored digest, or the
   object is read and hashed when it has none); otherwise the run stops with `object_conflict`.
4. `ledger.addUnit` — **all files of the segment as one unit** (a span segment's `spans` and
   `trace_index` files together; the unit and watermark rules are the metric ones).
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

## Throughput (D82, 2026-11-28)

S10 measured on Cloudflare that flush bounded trace ingest (queue lag up to 58 s, the groups of a
batch one after another, every run's last segment left for a retry). Three changes, none of a
format or protocol (`design/DECISIONS.md` D82):

1. **A run pipelines its segments.** Up to `PIPELINE_DEPTH` (2) segments are read, encoded and
   written at once (`FlushOptions.pipeline`; 1 is the order before D82). Each is still admitted only
   after every one before it, and `afterPut`, `afterAddUnit` and `afterRecorded` still run per
   segment in sequence order. Whatever is in flight when an attempt ends (a `Stop`, a `Restart`, a
   hook that throws) is awaited before the run goes on. After a crash, up to two segments' objects
   may exist unadmitted (the orphan sweep keeps them as pending units; the retry adopts them).
2. **A run waits for the ledger's log.** After its last unit it polls `loggedWatermarks` every
   `logPollMs` (250 ms) for up to `logWaitMs` and tells the shard `recorded` in the same run. The
   consumer passes `LOG_WAIT_MS` (3 s); a direct caller (`flushTenant`, the RPC, `POST /flush`)
   passes nothing and is answered at once, as before.
3. **The consumer runs a batch's streams at once**, at most `MAX_CONCURRENT_RUNS` (3;
   `ConsumerOptions.maxConcurrentRuns`), every R2 request of the invocation under ONE `Limiter` of
   six (`FlushOptions.r2`). Outcomes and acknowledgements are per group, as before.

**Profile** (`npm run profile`; "here": local workerd; "modelled": the same code with S10's
Cloudflare latencies in front of each call, R2 PUT 335 ms, a ledger RPC 32 ms, `addUnit` 47 ms, the
ledger draining 535 ms after a commit). One consumer batch, 3 streams × 4 segments of about 4 MiB;
"before" is this code with the three changes turned off (`maxConcurrentRuns: 1, pipeline: 1,
logWaitMs: 0`), run alternately with "after", twice each (2026-11-28):

| | spans, ms a segment (MiB/s) | logs, ms a segment (MiB/s) | streams recorded through their last segment in the run |
|---|---|---|---|
| modelled, before | 604–610 (6.6) | 588–604 (6.6–6.8) | 0 of 3 (all `awaiting_log`) |
| modelled, after | **191–233 (17.2–20.9)** | **171–206 (19.5–23.4)** | **3 of 3** |
| here, before | 82–89 (45–49) | 68–70 (57–59) | 1 of 3, 0 of 3 |
| here, after | 96–100 (40–42) | 84–88 (45–47) | 3 of 3 |

Per segment before (modelled): read 40 ms, encode 40–63 (CPU), PUTs 363 (two files in parallel),
`addUnit` 52, `loggedWatermarks` 35, `recorded` 35. Without latencies the work is CPU and the
change is slightly slower (the wait for the log is inside the invocation).

**On Cloudflare** (S18, `spikes/s18-signals-write/README.md`): flush invocations' wall p50 2.8 s, max
4.9 s (S10: max 16.6 s); the flush queue's lag 2.8–6.3 s per minute (S10: 7–58 s); one tenant took
28,800 spans/s for 68 s with 5 of 245 attempts 429 (S10: its buffer full at about 20,000 spans/s).
The buffer bound that mattered most was the shard's (D82, item 1: `shard/README.md`).

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

- **Splitting a span segment by hour into several units**: one unit holds every hour's spans
  file of a segment (up to 26 files for a segment spanning the 24 h accept window), well under
  the ledger's 4,096 files a unit.

- Fanning R2 writes out to Durable Objects beyond the invocation's six connections (D82 (f)): not
  needed at the measured rates.
- Memory of a run with the pipeline (up to two segments and their files, three runs at once: about
  30 MiB of JavaScript memory more than before, modelled) was not measured; S18 read the queue
  invocations' isolate memory at up to 149.6 MB as reported, flush and maintenance together.
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
- Metrics about flush itself. (Run on Cloudflare under load since: S10, S18.)

## How it was verified

```
(cd ../engine/wasm && ./build.sh)       # the tests import ../engine/wasm/js/viz_engine.wasm
npm install
npx vitest run --maxWorkers=2 --fsModuleCachePath <a dir of this tree's own>   # 68 tests, 8 files (2026-11-28: all pass)
npm run profile                 # D82's profile, prints PROFILE lines (not a pass/fail suite)
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

**Registration before writes (D61), 2026-11-19: 49 of 49, tsc clean.** No code here changed:
flush keeps its lazy registration (`addUnit` of a stream's first unit; `registerStream` after
`incarnation_mismatch`) for shards in mode `lazy` and of earlier releases; a shard in mode
`logged` registers before it accepts, so flush meets those paths only for streams it never
held. `test/registration.test.ts` (4) replays the protocol model's traces against the real
shard (mode `logged`), ledger, flush and engine, with a reader that follows the query
coordinator's protocol statement for statement (`test/coordinator.ts`: which shards it asks,
with which incarnation, what it learns from a refusal, its cap of three refusals):

- **spec R1** (`R1_safety`, 15 steps): with the drain held back a new stream's append is
  refused twice, nothing stored (the shard and the ledger evicted); once logged it is
  accepted; then a flush Worker PUTs, the ledger loses its storage, a query plans (the rebuilt
  ledger names the stream, `inc @ 0`, no file), the unit is admitted and logged, the shard loses
  its storage, the query's tail read is refused and its re-plan returns b0 from the file.
- **spec F6(b)** (`F6b_impl_now` with the registration first): the query plans before the
  stream's first unit is admitted and names the stream; after the shard's storage loss the read
  is refused, never `ok` and empty; the second attempt returns b0 and reads the fresh stream from
  0. **The same steps in mode `lazy`** (the release before D61) answer **without** b0 in one
  attempt: F6(b) reproduced against the code, the test's built-in counterfactual.
- **spec F6 liveness** (`LIVE_R2_teeth_no_read_trigger`, 6 steps): registered and logged, two
  appends, the shard loses its storage, nothing more is written: the first attempt is refused,
  the shard holds a fresh incarnation that the ledger already names, the second attempt
  completes (without the two batches: the declared loss), later queries in one attempt, and the
  fresh stream takes writes once logged.

Mutants of the shard and the ledger that these tests kill are listed in `shard/README.md` and
`ledger/README.md` ("acknowledge before logged", "a read naming a lost stream does not start
and register a fresh one"). The same traces against the real coordinator are for query/ to add
(`shard/README.md`, "Needed changes elsewhere" 2).

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

**D82** (2026-11-28, on a copy of the tree in the scratch area, never in the checkout; each mutant
against `test/throughput.test.ts`, F8 also `test/flush.test.ts`): see the table in "Mutants of D82"
below.

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

### Spans and logs (stage 2, 2026-11-19)

```
npx vitest run --maxWorkers=2 test/signals.test.ts                                  # 8 tests
npx vitest run --maxWorkers=1 test/measure-signals.test.ts --reporter=verbose       # MEASURE lines
```

**Tests** (`test/signals.test.ts`, 8; batches from the engine's independent test encoder
`engine/wasm/test/signal.ts`, files read back with **hyparquet**, which shares no code with
viz): a span stream (`pool-…/traces/0`) with two sealed segments, rows across an hour and a day
boundary: two units, the first of three `spans` files (hours 22, 23 of one day and 00 of the
next) and two `trace_index` files, each key exactly the prescribed one built from the object's
own bytes, each object's SHA-256 that of `engine.encodeSpans` over the segment's batches; every
span read once by hyparquet; the ledger plans the hour's file for a millisecond range inside it
and lists every trace_index file; the watermark at 4, nothing pending, a second run changes
nothing. A crash after the PUTs and one after `addUnit` converge to the same objects and one
unit. A log stream: one unit of two `logs` files across midnight, day keys (no hour level),
the repeated batch stored once, rows and metadata as sent. Refused with `unreadable_segment`,
nothing written or admitted and the segment still pending: spans and metrics in one segment,
spans and logs in one segment, a signal flush does not know (9), and an engine without the span
encoder (the same segment then flushes with the full engine). The full sweep lists
`{pool}/traces/*` and `{pool}/logs/*` only for the signals `INGEST_SIGNALS` enables, and none
for a base pool too long for derived names.

**Last run (2026-11-19): 59 passed, 0 failed (7 files; 49 before, plus 8 and 2); `tsc --noEmit`
clean.** The metric tests and the golden files of every format are unchanged and pass.

**Mutants (2026-11-19)**, each on a scratch copy of the tree (never this checkout), against
the test files named: a span segment flushed as metrics (`encodeSegment` for signal 2): killed
by "one unit per segment: spans files by hour…" and three more; a log file keyed by hour
(`hour=00/`): killed by "one unit per segment of logs files by day…" (the ledger refuses the key);
a segment of mixed signals flushed by its first batch: killed by the two mixed-segment refusal
tests. The other stage-2 mutants are in `shard/`, `ledger/` and `janitor/`'s READMEs.

**Measured here** (local workerd under vitest, 1 ms timers; NOT Cloudflare; the machine shared,
load average 8 on 4 cores; `test/measure-signals.test.ts`, two runs of three segments each).
Segments of 4 batches of about 0.85 MB (3.38 MB of span batches, 10,788 spans; 3.23 MB of log
batches, 10,929 records), the workload described in the test's header. "Flush" is the wall
time of `flushTenant` for one segment (read, encode, SHA-256, PUTs to local R2, `addUnit`, the
logged mark); "encode" the synchronous WASM call inside it.

| | spans (with their trace_index) | log records |
|---|---|---|
| flush, rows per second (six segments) | 28,000 – 80,000 | 50,000 – 127,000 |
| encode alone, rows per second | 41,000 – 159,000 | 110,000 – 341,000 |
| flush wall time per ~3.3 MB segment | 134 – 388 ms | 86 – 218 ms |
| bytes in R2 per row (Parquet, snappy) | **94** (spans 89, trace_index 5) | **158** |
| batch bytes per row (what edge sends the shard) | 314 | 295 |
| WASM linear memory after the runs | 23 – 26 MB | 17 MB |

The first segment of each run was the slowest (a cold instance). Bytes per row depend on the
workload: these log lines carry a random request id and random words (little to compress);
spans carry a high-cardinality user id and SQL in 30%. Not measured: CPU other than the encode
call, R2 latency on Cloudflare.

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

### Mutants of D82

Not run: the mutant run (18 mutants, listed in the PR body draft) was waiting for the machine lock when the work was paused (2026-11-28).

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
  shards keep the rows (and their byte budget) until the log catches up and flush runs again. A run
  waits up to 3 s for it (D82), then leaves it to the retry as before.
- **Three runs and a pipeline share one isolate** (D82): the CPU of their encodes adds up in one
  invocation (S18: flush CPU max 2.1 s, against the 30 s limit), and so does their memory (not
  measured on its own).
- **A `gap` or `object_conflict` needs a person.** Flush stops and says so; nothing repairs it.
- **The read path in `test/read.ts` is test code.** It makes two `plan` calls and compares
  versions; the real query path needs one call that returns both tables.
- **Tail batches from several shards** are passed to the engine in shard order. If the same
  `(series, ts)` sits in two shards (a retry after a pool-map change) the later shard in
  that order wins; nothing defines which is right.
- **R2 conditional PUT** was exercised against the local R2 simulator only.
