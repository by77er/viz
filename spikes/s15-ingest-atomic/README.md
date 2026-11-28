# Spike S15: a 429 stores nothing, and a known refusal is not decoded (D77)

The verification D77 asks for: S10's two ingest findings (`spikes/s10-signals-trial/README.md`,
"Ingest": a request refused at the end could be partly stored; a 429 cost a full decode), fixed in
`edge/` and `shard/` (D77), measured before and after.

**Status (2026-11-28): measured here (local workerd) only. The stage run on Cloudflare was not
done**: it did not fit the time box of the change (the shared machine's test lock was held by other
jobs for most of it). Nothing was deployed, created or deleted on Cloudflare for S15; no
credentials were used. The plan below is what remains, exactly.

## Files

| File | What it is |
|---|---|
| `local-bench.mjs` | Before/after on two local `wrangler dev` instances (the release at 375e9ba and this one): CPU and client time per refused request under a full buffer, acknowledgement latency of accepted requests, alternating between the builds. S10's body generator (`../s10-signals-trial/load/bodies.mjs`) |
| `local-run.sh` | Starts the two builds with `wrangler dev --local`, runs `local-bench.mjs` against them, stops them and deletes their state (paths in `BEFORE`, `AFTER`, `STATE`). Written from the scratch script that produced the numbers below; not re-run in this form |
| `rows.test.ts` | Rows written per request in the Workers test runtime, before and after: copied into `edge/test/` of each tree, run alone, deleted |

## Measured here (local workerd, this machine, 2026-11-28)

Two `wrangler dev --local` instances on this machine (4 cores, shared with other jobs; the edge
Worker with its shard, `INGEST_SIGNALS=traces,logs`, a config without the self service bindings, so
both could run at once): the release before (375e9ba) and this branch, each with its own state, the
tenants' keys and pool maps (2 shards, spread 2) written to local KV. Requests alternate between the
builds. Raw results: the scratch area's `result-run1.json` (client times and the acknowledgement
phase; its CPU column read one workerd process of the two `wrangler dev` runs and is discarded) and
`result-run2.json` (the refused phases again, CPU summed over every workerd process of each build).

**Defect 1, rows written** (`rows.test.ts`, both span shards, every `sql.exec`'s `rowsWritten`):

| Request (8,200 realistic spans, protobuf, gzip) | Before | After |
|---|---|---|
| accepted (two shards, several batches) | 24 | 24 |
| the same body again (duplicates) | 0 | 0 |
| refused, one shard full | **10 (its half stored)** | **0** |

**Defect 2, a refused request under a full buffer** (each build's two span shards filled with S10's
bodies until they refused: 37 bodies each):

| Shape | Before: client p50 / p90 ms, CPU ms per request | After |
|---|---|---|
| the same body retried at once (n = 200 each) | 135.5 / 196.8, **189.6** | 8.3 / 13.3, **9.0** |
| the same body retried after its `Retry-After` (1.05 s; n = 20) | 133.3 / 191.6, 164.0 | 16.6 / 20.7, 17.0 |
| a new body each time (n = 30) | 126.0 / 215.3, 173.0 | 145.7 / 199.6, 208.7 |

A new body is decoded by both builds (it was never refused); the difference is within the spread
of n = 30 here and includes the hash (the tenant is suspect) and the reserve and release round
trips; not separated. **What one isolate buys** is the first two rows, for retries that reach the
isolate that refused them; locally there is one isolate, so every retry did. On Cloudflare the share
of retries that land on the same isolate is the thing the stage run must measure.

**Acknowledgement latency, accepted requests** (client, alternating request by request, after 20 of
warm-up; fresh tenants as buffers filled):

| Body | Before p50 / p90 ms | After p50 / p90 ms |
|---|---|---|
| 2,000 spans over two shards, several batches (reserve path), n = 199 | 51.6 / 69.8 | 55.4 / 73.7 |
| 40 spans, one batch (no reserve), n = 200 | 10.2 / 13.6 | 10.1 / 13.0 |

The reserve round trip: about 3.8 ms at the median locally, on multi-batch requests only. Modelled
on Cloudflare: one Durable Object round trip in the same colo, a few to tens of milliseconds
against S10's 723 ms median acknowledgement of an 8,200-span request; to be measured by the stage
run.

Tuning steps: none on either side; the first local run's CPU read the wrong process (`wrangler dev`
runs the Worker and its proxy in separate workerd processes) and was redone summing both. The local
state (about 0.7 GB) was deleted after each run.

## Plan for the stage run (not done)

**From where.** A detached worktree of this branch in the scratch area, `node_modules` linked where
the lock files match, both WASM engines built with `CARGO_BUILD_JOBS=2` into a target directory in
the scratch area (deleted afterwards), deployed with `deploy/deploy.sh --stage s15`
(`VIZ_SKIP_NPM_CI=1`, `VIZ_WASM_PREBUILT=1`, `VIZ_STAGE_VARS` with `INGEST_SIGNALS=traces,logs`,
`--expires` at most 3 hours after the deploy), so the shared tree's `deploy/resources.json` is never
written. Only `viz-s15-*` names: the stage's Workers, Durable Object namespaces, `viz-s15-lake`,
`viz-s15-config`, the four `viz-s15-*` queues, and the load Worker `viz-s15-load-client` (S10's
`load/worker.mjs` with its names changed; its `x-key` and tenant keys generated in the scratch area,
0600, set with `wrangler secret put` on stdin; `DEADLINE` the stage's expiry). Inventory before and
after with `spikes/s11-large-ledger/inventory.mjs`.

**Load.** S10's run 1 shape exactly: tenant `s15-load`, 4 clients (one Durable Object each) × 12
requests of 8,200 spans (OTLP traces protobuf, gzip, `lcg32` so every span is new), closed loop,
a 429 or 503 retried with the same body after its `Retry-After`, at most 8 attempts; then the same
with JSON bodies, OTLP logs and Loki push (the six variants of S10, at most 6 × 48 requests).

**What to read, and what would count.**
1. **Partial storage after refusals (expect none).** For each request finally refused, the trace ids
   that appear only in refused requests: trace by ID for each (S10 found 4 of 10 before the fix;
   expected 0), and `count_over_time` of distinct spans equal to the spans of the accepted requests
   (S10: 5,946 stored against 5,524 accepted). Also no 429 whose request has any span stored.
2. **CPU per refused attempt.** `wrangler tail` on the ingest Worker during the run (S10's
   `tails.mjs`: `cpuTime` by response status; the analytics API counts a chain started in a Durable
   Object under the `Client` namespace, so per-Worker CPU comes from the tail, as in S10), and the
   same bodies sent once each from outside (`outside.mjs`) for analytics rows of their own. Before
   (S10): refused p50 198 ms, accepted 204 ms. Expected after: refused attempts of a remembered body
   at a few ms; the share of refused attempts answered before decoding is what one isolate buys on
   Cloudflare (count from the tail: refused invocations under 10 ms of CPU against all refused).
3. **Acknowledgement latency** of accepted requests (client) against S10's run 1 (p50 723 ms), and
   503s (expected: none, or a few, each a grant lost to an eviction).

**Worst-case cost, modelled** (Workers Paid list prices as S10 read them on 2026-11-19, ignoring
the included allowances): S10's stage and load bound, about half of its load (no query, fat or
marker phases): **under US$2.50**; S10's whole trial measured US$0.064.

**Delete.** `driver.mjs load-down` (the load Worker and its namespace), `resources.mjs destroy
--stage s15` from the worktree (its leftover check must find nothing named `viz-s15-`), the
inventory difference must be exactly the `viz-s15-…` names, then the worktree, the WASM target, the
keys and tails removed from the scratch area.
