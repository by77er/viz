# Spike S18: the write side of traces and logs at realistic ingest (D82)

S10 (`spikes/s10-signals-trial/`) measured on Cloudflare that a tenant's trace buffer filled at about
2.5 requests a second of 8,200 spans, then refused everything for about 33 s; that flush messages
waited 7 to 58 s in the queue; and that a closed-day compaction run was killed at the 30 s CPU limit.
D82 (`design/DECISIONS.md`) changes the shard (recorded payloads no longer hold a tenant's room),
flush (a pipeline, a wait for the ledger's log, concurrent runs under one R2 limit) and compaction
(merges priced in CPU before they start, runs and batches bounded by a CPU budget). This spike runs
S10's load shapes against a stage with D82 and reads the same figures.

## Plan, names and worst-case cost (written before anything was deployed)

**From where.** The branch's worktree in the scratch area at the commit that adds this README,
`node_modules` linked from the shared tree where `package.json` and `package-lock.json` match. No Rust
build: `engine/` does not differ from `main` (`git diff --stat origin/main -- engine` is empty), so
the engines built for main's sources are copied in (`VIZ_WASM_PREBUILT=1`). Deployed with
`deploy/deploy.sh --stage s18` (`VIZ_SKIP_NPM_CI=1`, `VIZ_WASM_PREBUILT=1`, `VIZ_STAGE_VARS` with
`INGEST_SIGNALS=traces,logs` for viz-ingest and `QUERY_SIGNALS=traces,logs` for viz-query), so only
this worktree's `deploy/resources.json` is written (not committed).

**Exact names.** Only `viz-s18-*`: the stage's Workers (`viz-s18-publisher`, `-ingest`, `-control`,
`-query`, `-ruler`, `-mcp`, `-gateway`; only the gateway on workers.dev, no route, no custom domain,
`vis.bitcru.sh` and `viz.bitcru.sh` untouched), their Durable Object namespaces, `viz-s18-lake`,
`viz-s18-config`, the four `viz-s18-*` queues, the rate-limit ids the deploy allocates, and the load
Worker `viz-s18-load-client` (S10's `load/worker.mjs`, deployed by S10's `driver.mjs` with
`SPIKE_STAGE=s18`: a service binding to `viz-s18-gateway`, a Durable Object class `Client`, one object
per client). Tenant `s18-load`. Secrets: viz-s18-control's generated `OAUTH_CLIENT_KEY`,
viz-s18-gateway's `VIZ_BOOTSTRAP` (deleted by `bootstrap.mjs`), viz-s18-load-client's `LOAD_KEY` and
`TENANT_KEYS`: generated here, in 0600 files in the scratch area, set on wrangler's stdin, never
printed, shredded at the end. Inventory of the account before and after
(`spikes/s11-large-ledger/inventory.mjs`).

**Expiry.** `--expires` (`VIZ_STAGE_EXPIRES_AT`, and the load Worker's `DEADLINE`) at most 3 hours
after the deploy. The load Worker has no alarm or cron and refuses every request after its deadline;
the ruler stops at it; the stage is deleted at the end of the run (S10's lesson: `--expires` stops the
ruler, not the stage, so deletion is the stop).

**Load** (from inside Cloudflare, one client Durable Object each, closed loop, a 429 or 503 retried
with the same body after its `Retry-After`, at most 8 attempts, every span new: `--uniq`):

1. S10's run-1 shape: 4 clients × 12 requests of 8,200 items, OTLP traces protobuf, then OTLP logs
   protobuf, then Loki protobuf.
2. S10's paced shape: 4 clients × 15 requests of 8,200 spans, 1 s between a client's requests.
3. Sustained: 4 clients × 40 requests of 8,200 spans, closed loop (about 330,000 spans).

**What is read, and what would count.**
- Sustained spans/s per tenant before the buffer fills: accepted spans over the window, attempts
  answered 429 (S10 run 1: 132 of 165 attempts 429; paced: 99 of 149; S15, main with D77, run 1: 138
  of 171). D82 counts if the paced shape and the sustained shape are accepted without a final refusal.
- Queue lag of `viz-s18-flush` (analytics, `lagTime`; S10: 7–58 s).
- Compaction: every maintenance invocation's CPU (tail and analytics), none `exceededResources`, and
  its modelled CPU from the run's log line, to calibrate `CPU_MS_PER_MIB`.
- Flush invocations: wall and CPU (tail), isolate memory (analytics).

**Worst-case cost, modelled** (Workers Paid list prices as S10 read them, ignoring the included
allowances): at most 600 ingest requests with retries (about 3,000 attempts), 100 queries, and the
stage's own flush, compaction and publication:

| Item | Bound | US$ |
|---|---|---|
| Worker requests | 50,000 | 0.02 |
| Worker CPU | 3 M CPU-ms (3,000 ingest attempts at 0.5 s, flush and compaction 1.5 M) | 0.06 |
| Durable Object requests | 200,000 | 0.03 |
| Durable Object duration | 40,000 GB-s | 0.50 |
| SQLite rows written / read | 200,000 / 10 M | 0.20 / 0.01 |
| R2 class A / class B | 20,000 / 50,000 | 0.09 / 0.02 |
| R2 storage | 3 GB for 3 h | < 0.01 |
| Queue operations | 30,000 | 0.01 |
| KV reads / writes | 50,000 / 5,000 | 0.03 / 0.03 |
| **Total** | | **under US$1.10 worst case**; S15's similar run cost US$0.009 |

**Delete.** `driver.mjs load-down`, `deploy/resources.mjs destroy --stage s18` (its leftover check must
find nothing named `viz-s18-`), the inventory difference must be exactly nothing, then the keys, tails
and state shredded or removed from the scratch area.
