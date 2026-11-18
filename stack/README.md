# Stack

The write path as **one script**, for testing: `edge` (the default export), the `Shard` and
`Ledger` Durable Objects, and `flush` (the `Flush` entrypoint), behind one wrangler config
that binds `SHARD`, `LEDGER`, an R2 bucket (`BUCKET`) and KV (`CONFIG`).

```
 senders ─► edge ─► Shard ──seal──► flush ──► R2 Parquet ──► Ledger
                      ▲                                         │
 test read path ──────┴──── rows above watermark ◄── files + watermarks
```

| File | Contents |
|---|---|
| `src/index.ts` | Re-exports only: `default` = edge, `Flush`, `Shard`, `Ledger`. No behaviour of its own |
| `wrangler.jsonc` | The single config |
| `test/e2e.test.ts` | 6 end-to-end tests in workerd |
| `test/world.ts` | Two tenants sharing one pool of two shards; real Remote Write and OTLP requests |
| `tools/hyparquet_check.mjs` | Reads one produced Parquet file with hyparquet, in Node |

## What is implemented

Nothing new: this directory connects `edge/`, `shard/`, `ledger/`, `flush/` and
`engine/wasm/` and tests them together. A request goes in through the stack's default
export (`exports.default.fetch`), flush runs through the `Flush` entrypoint over RPC
(`exports.Flush.flushTenant`), and results are read by `flush/test/read.ts`: one ledger
version, each shard asked only for rows above its watermark, a refusal when a shard has
discarded past the watermark it is asked about, and the WASM engine's `select` over lake
files and tail batches.

## Not implemented

- **A query Worker.** The read path here is test code; nothing serves queries.
- **A trigger for flush.** Tests seal with `shard.seal` and call `flushTenant` themselves.
- **Separate deployment.** In production these are four Workers bound to each other; that
  wiring (service bindings, `script_name` on the Durable Object bindings) is not written.
  Flush has no HTTP route in this script.
- **The ledger ↔ shard-map epoch**, compaction, the publisher, retention: not in the path yet.
- Nothing was deployed to Cloudflare. Under `wrangler dev --port 8830` the script booted,
  `GET /healthz` answered 200 and an unauthenticated write 401; no data was sent that way.

## How it was verified

```
(cd ../engine/wasm && ./build.sh)
npm install
npm test                         # 6 tests in workerd, 1 file
npx tsc --noEmit                 # clean
node tools/hyparquet_check.mjs   # 4 checks agree
```

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
