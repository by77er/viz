# Spike S18: the write side of traces and logs at realistic ingest (D82)

## Paused (2026-11-28, 18:45 UTC: the owner is out of budget)

- **Done:** D82's code (shard reclaim of recorded payloads, flush pipeline + log wait + concurrent runs
  under one R2 limit, compaction priced in CPU with a 15 s batch budget), tests (shard 7, flush 9,
  compact 5, stack 1 new; shard, flush, compact, stack suites green; tsc clean except query's
  pre-existing missing generated fixtures), the local profile (alternating before/after), D82, the
  READMEs, DESIGN §4.3/§5.2, UPGRADES §5, the design page source.
- **Measured on Cloudflare:** this stage run (results below): no stage is left (destroyed 18:30 UTC,
  inventory unchanged).
- **Left:** the mutant run (18 mutants on a scratch copy, never started: it waited for the machine
  lock; the READMEs say "not run"); the stack's gateway suite (`vitest.gateway.config.ts`) not re-run;
  the PR body (`pr-swrite-body.md` in the scratch area) not written; the adversarial review.

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

## Stage run: results (measured on Cloudflare, 2026-11-28)

**What ran.** Commit `b34ca10` (this branch: D82's shard, flush and compaction changes, before the
documentation) deployed as stage `s18` at 18:02 UTC (`deploy.sh` refused a first run for the fresh
stage's five unacknowledged Durable Object migrations, as designed; the second, with
`VIZ_ACK_MIGRATIONS`, exit 0 in 73 s, smoke `/healthz` healthy), `--expires 2026-11-28T20:45:00Z`.
Engines: main's prebuilt `viz_engine.wasm` (sha256 `df0ed8117e6123c2…`) and `viz_query.wasm`.
Tenant `s18-load` bootstrapped (default pool, 2 slots per signal); `viz-s18-load-client` with up to 8
client objects. `wrangler tail viz-s18-ingest --format json` throughout (a sample: the tail drops
events under load). Windows (UTC, `phases.jsonl`): run 1 traces 18:03:52–18:04:06, logs
18:05:16–18:05:25, Loki 18:06:35–18:06:43; paced 18:06:51–18:07:19; sustained 18:07:19–18:08:14; wide
(8 clients × 30) 18:08:22–18:09:30.

**Accepted and refused** (client; closed loop unless paced; a 429 or 503 retried with the same body
after its `Retry-After`, at most 8 attempts; every span new):

| Shape | Requests | Accepted | Attempts: 2xx, 429, other | Spans accepted, window | Ack ms p50 / p90 / p99 | Before (S10 run 1 / paced on its stage; S15 on main with D77, today) |
|---|---|---|---|---|---|---|
| run 1, traces protobuf, 4 × 12 | 48 | 47 | 47, 2, **1 × 502** | 385,400 in 13.9 s (27,700/s) | 942 / 1,297 / 1,877 | S10: 33 of 48, 132 of 165 attempts 429; S15: 33 of 48, 138 of 171 |
| run 1, logs protobuf | 48 | 48 | 48, 0, 0 | 393,600 | 543 / 911 / 1,123 | S10: 40 of 48, 69 of 109; S15: 40 of 48, 64 of 104 |
| run 1, Loki protobuf | 48 | 48 | 48, 0, 0 | 393,600 | 468 / 755 / 866 | S10, S15: 48 of 48 |
| paced, traces, 4 × 15, 1 s apart | 60 | **60** | 60, **0**, 0 | 492,000 in 27.9 s | 715 / 1,127 / 1,576 | S10: 50 of 60, 99 of 149 attempts 429 |
| sustained, traces, 4 × 40 | 160 | **160** | 160, **0**, 0 | **1,312,000 in 55.5 s: 23,600 spans/s** | 1,089 / 1,589 / 1,839 | not run before (S10's buffer filled within 5.4 s) |
| wide, traces, 8 × 30 | 240 | **240** | 240, 5, 0 | **1,968,000 in 68.2 s: 28,800 spans/s** | 1,562 / 2,529 / 2,956 | not run before |

- **Sustained spans/s per tenant before the buffer fills: about 29,000** (8 clients; two span shards,
  the default pool's 2 slots): the first 429s appear there (5 of 245 attempts, all accepted on retry).
  With 4 clients (23,600/s) none; the clients' closed loop, not the stage, was the limit there. S10's
  stage filled at about 2.5 requests/s (20,000 spans/s) and stayed refusing for about 33 s; here no
  request of the paced, sustained or wide shapes was finally refused.
- **The one 502** ("ingest did not answer; retry", run 1 traces, from the gateway) is not a refusal
  of the shard: the driver does not retry a 502, so it counts as finally refused. Its cause was not
  found in the tail sample (every sampled ingest invocation ended `ok`); analytics show 0 errors for
  the window's fetch invocations as counted (under the load clients' namespace). Not reproduced in the
  four later shapes (520 requests).

**Flush** (tail, viz-s18-ingest's `queue viz-s18-flush`, n = 110 sampled): **wall p50 2.8 s, p90 4.5 s,
max 4.9 s** (S10: p90 1.3–7 s, max 16.6 s); CPU p50 518 ms, max 2,073 ms (S10: max 2,169). **Queue lag**
of viz-s18-flush (analytics, `lagTime`, per minute): **2.8–6.3 s**, average 4.2 s over the window, no
retries (S10: 7–58 s). `addUnit` wall p50 33 ms; `loggedWatermarks` p50 83 ms, 101 calls (the wait for
the log); `recorded` p50 73 ms.

**Compaction** (tail, `queue viz-s18-maint`, n = 136 sampled, 18:04–18:20): **none killed, no
`exceededResources`** (analytics: 0 errors for 242 queue invocations); **CPU p50 6.1 s, p90 10.6 s,
max 15.7 s** (S10: runs of 8 merges at 21.0 and 28.4 s, one killed at 32 s). From each invocation's log
line (`maintenance …: merged n (modelled CPU m ms, input b bytes)`), 131 invocations that merged:
actual CPU over modelled **0.45–0.59 for most, 0.21–0.22 for two, 0.98–0.99 for three** (14.7, 10.9
and 10.85 s of CPU against about 15 and 11 s modelled); actual CPU per MiB of input mostly 335–420 ms
(spans), with outliers at 700–2,000 ms. So `CPU_MS_PER_MIB` (700 for spans and logs) is about twice the
typical cost and about right for the worst; the 15 s batch budget kept every invocation at or under
15.7 s, against the 30 s limit. Most runs ended `more` (each spent its budget) and the backlog of the
run was worked off by 18:20, about 10 minutes after the last request. Several invocations ran the same
tenant at once and did the same merges (identical modelled figures at 18:08:47–51), the later ones
answered `conflict` (D30): CPU spent, nothing wrong; see D82, "Cost". Queue invocations' isolate memory
(analytics, as reported): p50 76.5 MB, p99 147.0 MB, **max 149.6 MB**, above the documented 128 MB
without an `exceededMemory` error, as S10 saw (158.1 MiB); WASM memory max 65.9 MB. Not explained here;
flush and maintenance share the `queue` event type in analytics, so which it was is not known.

**R2** (analytics): PutObject p50 287 ms, p90 370, p99 742 (n = 1,639); GetObject p50 187, p99 542
(n = 2,471).

**Cost** (analytics API, list prices as S10 read them, ignoring allowances; measured on Cloudflare),
window 18:01–18:22 UTC, read 18:21: 1,546 Worker invocations as counted, 1,152 s of Worker CPU (most of
it compaction), 9,308 Durable Object requests, 119.7 GB-s, 27,808 SQLite rows written, 601,783 read, R2
2,408 class A and 3,121 class B, 3,082 queue operations: **US$0.068**, against the stated worst case of
US$1.10. No bill was read.

**Deleted** (18:21:59–18:30:29 UTC): `driver.mjs load-down` (viz-s18-load-client and its namespace;
"still listed: false"), `resources.mjs destroy --stage s18` (exit 0): the four queue consumers, the
seven Workers, the four queues, `viz-s18-config`, `viz-s18-lake` (1,603 objects), the six rate-limit ids
freed; its leftover check found nothing named `viz-s18-`. **Inventory** after (18:31) against before
(18:01): Workers 28 → 28, R2 buckets 7 → 7, KV namespaces 8 → 8, queues 4 → 4, Durable Object
namespaces 28 → 28, custom domains 14 → 14, nothing added or removed. The keys were shredded; the
generated stage config (it names the account's workers.dev subdomain) deleted; the tail and the
analytics reads are kept in the scratch area only.

**Not done here.** A same-day run of main on a stage of its own (the "before" figures are S10's and
S15's stages, S15 today, same driver and shapes); a closed-day compaction (the stage lived 30
minutes; its merges were open-hour level-1 merges, which are what S10's 8-merge runs were too); reads
of what was stored (the suites check that; the D62 caps refuse trace queries at this volume anyway,
S10); a multi-tenant load (fair share between tenants reclaiming each other's recorded payloads).

## Files

| File | What it is |
|---|---|
| `../s10-signals-trial/driver.mjs`, `load/` | The load Worker and its driver, run with `SPIKE_STAGE=s18 SPIKE_TENANTS=s18-load` |
| `../s10-signals-trial/analytics.mjs`, `tails.mjs` | The analytics reads and the tail summaries |
| `../s11-large-ledger/inventory.mjs` | The inventory before and after |
| `flush/test/profile.prof.ts` | The local profile behind D82 (`npm run profile` in `flush/`) |
