# 02 — Cloudflare compute, orchestration, AI and security platform (for viz)

Research date: 2026-11-18. Author role: Workers platform engineer.

**Verification status.** Web access worked for `developers.cloudflare.com` and `blog.cloudflare.com` page fetches. The web *search* budget ran out after two searches, so discovery was done by fetching known doc URLs directly. Every claim is tagged:

- **[V]** read on a Cloudflare docs/blog page today (URL in Sources).
- **[T]** from training knowledge (cutoff mid-2026), not re-verified today. Treat as a lead, not a fact.

Where a docs page contradicted another docs page or my prior knowledge, it is called out in section 12.

---

## 0. Headline findings

1. **The hard walls moved, but the 128 MB wall did not.** Paid Workers: 5 min CPU per invocation (default 30 s), subrequests 10,000 default and configurable up to 10 M, bundle 64 MiB uncompressed with no compressed limit, startup 1 s, memory still 128 MB per isolate including WASM. [V] Memory is now the single binding constraint for a Parquet/Iceberg engine in isolates.
2. **Containers and Sandbox SDK are GA (2026-04-13)**: up to 4 vCPU / 12 GiB / 20 GB disk per instance, scale to zero, active-CPU billing, 1-3 s cold start, account concurrency 15,000 vCPU / 60 TiB. [V] This is the escape hatch for compaction and large queries.
3. **Workflows now bill per step** ($0.80 per 100k steps after 500k/month, from 2026-08-10). [V] Fine for compaction/retention orchestration; wrong for per-minute rule evaluation (use DO alarms).
4. **Dynamic Workers (Worker Loader)** are a billed, documented product: run LLM- or tenant-written JS/Python/WASM in a fresh isolate with controlled bindings and egress. [V] This is the right substrate for Code Mode agents and agentic monitors.
5. **Cloudflare now sells its own "Cloudflare Observability"** (logs + traces, SQL API, alerts, dashboards, MCP server): $0.25/GB ingested, $0.10/GB-month stored, from 2026-12-01. It covers Cloudflare-emitted telemetry only; no external OTLP ingest, no native metrics/PromQL/TraceQL were described. [V] It is both a price anchor and the dogfooding sink for viz's own Workers.
6. **Durable Objects are cheap when idle and expensive when written row-by-row**: $1.00 per million SQLite rows written. [V] Buffer telemetry as batched blobs, never one row per sample.
7. **`McpAgent` is deprecated**; remote MCP servers are now built with stateless `createMcpHandler` + `OAuthResourceServer`. [V]
8. Tooling is mid-transition: a new **`cf` CLI is at 1.0 RC** (2026-11-17) alongside Wrangler 4.16x; the Vitest integration was renamed **`@cloudflare/vitest-plugin`**. [V]

---

## 1. Workers

### 1.1 Limits [V unless marked]

| Limit | Free | Paid |
|---|---|---|
| CPU per HTTP request | 10 ms | default 30 s, up to 5 min via `limits.cpu_ms` (max 300,000) |
| CPU per Cron Trigger | 10 ms | 30 s if interval < 1 h; 15 min if interval >= 1 h |
| Wall time, HTTP | no hard limit while client connected | same |
| Wall time, cron / DO alarm / queue consumer | 15 min | 15 min |
| `waitUntil()` after response | up to 30 s | up to 30 s |
| Memory per isolate (JS heap + WASM) | 128 MB | 128 MB |
| Subrequests per invocation | 50 | 10,000 default, configurable up to 10,000,000 via `limits` |
| Subrequests to Cloudflare services | 1,000 | follows configured limit |
| Simultaneous connections waiting for headers | 6 | 6 (shared with Workers called over service bindings) |
| Worker size | 64 MiB uncompressed, no compressed limit | same |
| Startup time (global scope) | 1 s | 1 s |
| Env vars | 64 x 5 KB | 128 x 5 KB |
| Workers per account | 100 | 500 |
| Cron Triggers per account | 5 | 250 |
| Log data per request | 256 KB | 256 KB |
| Cache API calls per request | 50 | 1,000 (shares subrequest quota); object 512 MB |
| Static asset files per version | 20,000 | 100,000; 25 MiB per file |
| Request body | by zone plan: 100 MB Free/Pro, 200 MB Business, up to 5 GB Enterprise | same |
| Response body | no enforced limit (CDN cache limits apply) | same |

Behaviour at the walls [V]:

- **Memory**: on exceeding 128 MB the runtime lets in-flight requests finish and starts a new isolate; under pressure it cancels requests with error 1102 "Worker exceeded resource limits". Buffering a body past the limit raises "Memory limit would be exceeded before EOF". The isolate is shared by concurrent requests, so the budget per request is less than 128 MB.
- **Connections**: the 7th concurrent outbound fetch queues until one of the six receives response headers. A connection stops counting once headers arrive, so streaming many R2 range reads is possible but header-latency bound.
- **Runtime updates**: old processes get up to 20 minutes to drain.
- Outbound request bodies from Durable Objects and Container outbound handlers are capped at 100 MiB.

### 1.2 Pricing (Standard) [V]

- $5/month account minimum. 10 M requests + 30 M CPU-ms included; then $0.30/M requests and $0.02/M CPU-ms. No duration charge.
- Service binding / RPC calls between Workers: no extra request fee; CPU of both Workers is summed.
- Static asset requests: free and unlimited.
- New (2026-11-13): per-product spending limits with alerts or hard block for Workers and Durable Objects.

Worked numbers: 1 billion ingest requests/month at 2 ms CPU = $297 requests + $39.4 CPU. Request count, not CPU, dominates ingest cost, so encourage client-side batching.

### 1.3 Streaming, WASM, languages

- **Streaming**: request and response bodies stream through `ReadableStream`/`TransformStream`; an HTTP Worker stays alive while it is still streaming. [V]
- **WASM**: SIMD supported; no threads; feature set tracks Chrome; WASI experimental; `WebAssembly.instantiate()` only on pre-compiled (bundled) modules; WASM memory counts against 128 MB. [V] Large WASM modules slow startup against the 1 s limit; use `wasm-opt`, LTO, strip. [V]
- **Rust (`workers-rs`)**: bindings for DO, R2, KV, D1, Queues (producer; consumer behind a feature flag), service bindings, Workers AI, Hyperdrive, Analytics Engine, dynamic dispatch, Secrets Store, Rate Limiting. Docs state no stability level and do not mention RPC. [V] No tokio multi-thread runtime; panics poison the instance unless handled. [T]
- **Python**: Pyodide (CPython on WASM) inside the isolate, deploy-time memory snapshots for cold start, `pyproject.toml` packages. Docs give no GA/beta label and no cold-start figures. [V] Python Workers stay on the legacy module registry (2026-11-02 changelog). [V] Was beta at my cutoff. [T]
- Recommendation: TypeScript for all control paths; Rust-to-WASM only for hot kernels (Parquet encode/decode, PromQL evaluation, compression), loaded as a module inside a TS Worker.

### 1.4 Placement, RPC, deployments

- **Smart Placement** (`placement.mode = "smart"`): still labelled beta. Affects only `fetch` handlers, not RPC methods or named entrypoints. New explicit hints: `region` (for example `aws:us-east-1`), and experimental `host` / `hostname` probes. [V]
- **Service bindings / RPC**: serialized payload cap 32 MiB; pass `ReadableStream` (byte streams only) for larger data; functions and `RpcTarget` subclasses pass as stubs; promise pipelining; Smart Placement ignored for RPC (callee runs on the caller's machine). [V]
- **Gradual deployments**: percentage split between versions, version affinity and overrides, from the last 100 uploaded versions. Only one version of a Durable Object class runs at a time; DO migrations need `wrangler deploy`. [V]
- New (2026-10-30): **deferred DO code updates** — active objects can keep old code for 300 s by default (`code_update_strategy`, max 24 h). [V]
- New (2026-11-05): **automatic DO retries** — failed stub `fetch()`/RPC retried up to four times within 10 s by default. [V] Ingest RPCs into DOs must therefore be idempotent.

### 1.5 Workers for Platforms (dispatch namespaces) [V]

- $25/month; 20 M requests and 60 M CPU-ms included; 1,000 scripts included then $0.02/script; same overage rates as Workers. Dispatch + user + outbound Worker chain bills as one request.
- Unlimited scripts; max 8 tags per script; `caches.default` disabled; no gradual deployments for user Workers; custom CPU/subrequest limits set from the dispatch Worker; outbound Worker for egress control.
- Fit: only needed if tenants upload long-lived code. viz multi-tenancy is data isolation, not code isolation. Dynamic Workers cover the "tenant/LLM-supplied snippet" case at lower fixed cost.

### 1.6 Workers Logs, traces, Tail Workers, and "Cloudflare Observability"

- **Workers Logs** today: 20 M events/month included then $0.60/M; 7-day retention; 5 billion logs/day/account then 1% head sampling; 256 KB per log. [V]
- **From 2026-12-01**: Workers Logs, Workers Traces, Cloudflare Traces, Containers logs, R2 access logs, AI Gateway logs and Issues share one allowance: Paid includes 50 GB ingest + 10 GB-month storage; overage $0.25/GB ingested and $0.10/GB-month; 7-day retention, with 30/90/365-day options "planned". Free: 0.5 GB/day. [V]
- Platform additions (blog, "8 major updates"): unified SQL API (beta) with a Workers binding, Alerts (beta; threshold, anomaly, SLO; webhooks on all plans), custom dashboards, Observability MCP server, Cloudflare Traces (open beta), Logpush on self-serve plans (25 GB included; $0.03/GB to Cloudflare destinations, $0.10/GB external). Metrics export to OTel is "coming". [V]
- **OTel export from Workers**: traces and logs (not metrics) to any OTLP endpoint with headers; binary OTLP (protobuf) is not supported, so JSON. [V]
- **Tail Workers**: Paid/Enterprise; billed on CPU; receive logs, exceptions, request metadata, diagnostics-channel events, including from service-binding and dynamic-dispatch subrequests. [V]

---

## 2. Durable Objects as compute

### 2.1 Model

- One single-threaded instance per ID, globally unique, co-located with its storage. Each object is an actor; requests are processed with **input gates** (no new event delivered while a storage operation is pending) and **output gates** (responses and outbound messages held until writes are durable). [V]
- Writes with no intervening `await` coalesce into one atomic transaction. Non-storage I/O (`fetch`, R2) opens the input gate, so other requests interleave: use check-and-set around it. `blockConcurrencyWhile()` only for init/migrations; a 5 ms critical section caps the object near 200 req/s. [V]
- No shutdown hook. Objects are evicted on inactivity, deploys and runtime updates; in-memory state is lost. Idle eviction after roughly 70-140 s without events. [V] Hibernatable-WebSocket objects can hibernate after about 10 s of quiet. [T]
- Isolate memory (128 MB) may be shared by several objects of the same class. [V]

### 2.2 Limits [V]

| Item | Value |
|---|---|
| Throughput per object | soft 1,000 req/s simple; 500-750 moderate; 200-500 with storage writes; "overloaded" error when the queue backs up |
| CPU | 30 s default, up to 5 min; budget resets on each incoming request / WebSocket message |
| SQLite storage per object | 10 GB; account total unlimited on Paid |
| Row / string / BLOB size | 8 MB (docs today; 2 MB at my cutoff [T]) |
| SQL statement / bound params | 100 KB / 100 |
| KV-API on SQLite | key + value up to 8 MB |
| WebSocket received message | 32 MiB |
| WebSocket attachment (hibernation) | 16,384 bytes |
| Hibernatable WebSockets per object | 32,768 [T]; docs today only say "thousands" |
| Alarm | one per object; at-least-once; retries with exponential backoff from 2 s, up to 6; handler wall time 15 min |
| Outbound connections | 6 simultaneous; 100 MiB outbound body |
| Classes per account | 500 Paid / 100 Free |
| Objects | unlimited |
| Dynamic Workers in flight per object | 10 distinct |

- **Location**: placed near the first `get()`; `locationHint` (`wnam`, `enam`, `weur`, `eeur`, `apac`, `apac-ne`, `apac-se`, `oc`; `sam`/`afr`/`me` map to neighbours) honoured only on first access; best effort; objects do not move after creation. Jurisdictions: `eu`, `us`, `fedramp`. [V]
- **Outbound WebSockets do not hibernate.** [V]

### 2.3 Pricing [V]

| Meter | Included (Paid) | Overage |
|---|---|---|
| Requests (HTTP, RPC sessions, alarms, WS messages at 20:1) | 1 M/month | $0.15/M |
| Duration (wall-clock while active, at 128 MB) | 400,000 GB-s/month | $12.50/M GB-s |
| SQLite rows read | 25 B/month | $0.001/M |
| SQLite rows written (incl. deletes, `setAlarm`) | 50 M/month | $1.00/M |
| SQLite stored | 5 GB-month | $0.20/GB-month |

- One RPC session = one request regardless of calls inside it.
- A DO pinned awake for a month = 0.128 GB x 2.59 M s = 332k GB-s, which is about $4.15 and fits inside the included 400k GB-s. A thousand always-awake DOs cost about $4,150/month: the write buffer must be allowed to sleep for idle tenants.
- Hibernated or evicted objects bill no duration. Free plan can use SQLite-backed DOs.

### 2.4 Sharding patterns

- One object per coordination unit; never a global singleton. Required shards = req/s / per-object capacity. [V]
- Deterministic routing with `getByName(tenant:signal:shard)`; creating a stub does not wake the object. [V]
- Parent/child index: a per-tenant "directory" object knows its shards so they can be enumerated without waking them. [V]
- Global read-mostly config belongs in KV, not a DO. [V]

---

## 3. Containers (GA 2026-04-13) [V]

| Type | vCPU | Memory | Disk |
|---|---|---|---|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

- Custom instance types exist (changelog 2026-01-05, not read in detail). Account defaults: 15,000 concurrent vCPU, 60 TiB memory, 300 TB disk, 50 GB image storage.
- **Model**: each instance is a Firecracker microVM fronted by exactly one Durable Object (`this.ctx.container`); addressed by DO name. Getting the stub does not start the container. All traffic enters through a Worker; no inbound TCP/UDP from end users. `linux/amd64` images, Docker Hub supported, SSH for debugging.
- **Cold start**: "often 1-3 s", image-size dependent; images are pre-fetched across the network.
- **Scale to zero**: `setInactivityTimeout()`, `signal()`, `destroy()`; SIGTERM then up to 15 min before SIGKILL.
- **Disk is ephemeral.** Snapshots (free during their beta) and R2 FUSE mounts exist; FUSE is "not SSD-like".
- **Scaling**: no managed autoscaler. Scale by addressing more named DOs or a fixed random pool. The DO and its container are not guaranteed co-located.
- **Pricing** (10 ms increments while running): memory $0.0000025/GiB-s (provisioned), CPU $0.000020/vCPU-s (**active usage only**), disk $0.00000007/GB-s. Included: 25 GiB-h, 375 vCPU-min, 200 GB-h. Egress $0.025/GB NA+EU after 1 TB; $0.04-0.05 elsewhere after 500 GB. Plus Workers request and DO charges.

Worked cost: standard-4 at full CPU = 12 x 2.5e-6 + 4 x 2e-5 + 20 x 7e-8 = $0.000111/s, about **$0.40/hour**. standard-1 at full CPU is about $0.074/hour. A 30 s compaction on standard-4 costs about $0.003. Idle cost is zero.

---

## 4. Orchestration

### 4.1 Workflows [V]

| Limit | Free | Paid |
|---|---|---|
| Steps per instance | 1,024 | 10,000 default, up to 25,000 (`step.sleep` not counted) |
| CPU per step | 10 ms | 30 s default, up to 5 min |
| Wall time per step | unlimited | unlimited |
| Step result | 1 MiB | 1 MiB |
| Persisted state per instance | 100 MB | 1 GB |
| Concurrent instances | 100 | 50,000 per account; per-Workflow `concurrency.limit` (2026-11-10) |
| Creation rate | 100/s | 300/s account, 100/s per Workflow |
| Queued instances | 100,000 | 2,000,000 |
| `step.sleep` | 365 days | 365 days |
| Retention of finished instances | 3 days | 7 days default, up to 30 |
| Event payload | 1 MiB | 1 MiB |
| Subrequests | 50 | 10,000 default, up to 10 M |

Pricing: Workers request + CPU rates, **steps $0.80 per 100,000 after 500,000/month** (billing since 2026-08-10), storage $0.20/GB-month after 1 GB. Sleeping bills storage only. Retries are not counted as steps. Jurisdictions supported (2026-10-27). "Dynamic Workflows" run per-tenant workflow logic through Dynamic Workers.

Cost check: 1,000 alert rules evaluated every minute as one step each = 43.2 M steps/month = about $342/month. The same on DO alarms = 43.2 M DO requests = about $6.50 plus duration. Workflows are for low-frequency, multi-step, must-finish jobs.

### 4.2 Cron Triggers [V]

- 1-minute minimum granularity, UTC; 250 per account (Paid); changes take up to 15 min to propagate; run on underutilised machines; CPU 30 s (interval < 1 h) or 15 min (>= 1 h); 15 min wall.
- Retry/at-least-once semantics are not documented on the page. Treat cron as a best-effort tick and make the handler idempotent.

### 4.3 Queues [V]

| Limit | Value |
|---|---|
| Message size | 128 KB |
| `sendBatch` | 100 messages or 256 KB |
| Consumer batch | up to 100 messages, wait up to 60 s |
| Throughput | 5,000 messages/s per queue |
| Backlog | 25 GB per queue |
| Push consumer concurrency | 250 invocations |
| Consumer wall / CPU | 15 min / 30 s default, up to 5 min |
| Retries | 100; delay up to 24 h |
| Retention | 4 days default, up to 14 (Free: 24 h) |
| Pull consumers | HTTP short-poll, batch up to 100, visibility timeout up to 12 h, API token auth |
| Queues per account | 10,000 included, then $0.10/queue/month |

Pricing: $0.40/M operations after 1 M; each 64 KB chunk written, read or deleted is one operation, so a delivered message costs about 3 ops = $1.20/M messages. Queues are for work items and pointers (for example "flush file X written", "compact partition Y"), not for raw telemetry.

---

## 5. AI and agents

### 5.1 Workers AI [V]

- $0.011 per 1,000 neurons; 10,000 neurons/day free.
- Sample per-M-token prices (input / output): `gpt-oss-120b` $0.35 / $0.75; `llama-3.3-70b-instruct-fp8-fast` $0.293 / $2.253; `llama-4-scout` $0.27 / $0.85; `kimi-k2.5` $0.60 / $3.00 (cached input $0.10); `nemotron-3-120b` $0.50 / $1.50; `glm-5.2` $1.40 / $4.40; `kimi-k2.6` $0.95 / $4.00. Embeddings from $0.0017/M (`embeddinggemma-2`) to $0.204/M.
- Newer models require Paid or prepaid AI Gateway credits.

### 5.2 AI Gateway [V]

- Core features free on all plans: analytics, caching, rate limiting, model fallback, dynamic routing, DLP (two profiles without Zero Trust). Guardrails bill as Workers AI inference.
- **Unified Billing**: one credit balance for OpenAI/Anthropic/Google and others; 5% fee on credit purchase, no inference markup. Secrets Store holds BYOK provider keys.
- Logs for gateways created from 2026-09-24 bill as Workers Logs (so Observability pricing from December).
- Fit: every LLM call from agentic monitors goes through one gateway per environment, with tenant ID as metadata, for per-tenant cost attribution, caching and rate limits.

### 5.3 Agents SDK [V]

- An Agent is a Durable Object with lifecycle plus capabilities: state sync, SQLite, WebSockets, Scheduler, MCP client manager, sessions, streams. Harnesses: Think, Pi, OpenCode, Claude Code, Codex and others. Channels: chat, voice, email, Slack, webhooks, push notifications.
- **Scheduling**: `schedule(delaySeconds | Date | cron, "method", payload)`, `scheduleEvery()`, `listSchedules()`, `cancelSchedule()`. Stored in SQLite, multiplexed on the single DO alarm, idempotent for cron strings, survives eviction.
- **Durable execution ("fibers")**: `runFiber` / `startFiber` (idempotency key), `stash()` checkpoints, `onFiberRecovered()`. No automatic retries; closures are not replayed. `keepAliveWhile()` holds a 30 s alarm heartbeat. Use Workflows for work that needs per-step retries.
- Sub-agents, agents-as-tools, human-in-the-loop approvals, Workflows integration.
- Limits: 30 s CPU per event (resets per request/message/schedule), unlimited wall time, state 1 GB per agent (the page also says scripts 10 MB, which conflicts with section 1.1).
- Pricing: no separate charge; pays DO + Workers + model rates.

### 5.4 MCP [V]

- **Server**: `createMcpHandler` (stateless, Streamable HTTP, fresh `McpServer` per request). `McpAgent` is deprecated; migration guide to MCP SDK v2 exists.
- **Auth**: `OAuthAuthorizationServer` + `OAuthResourceServer` from the Workers OAuth Provider; identity via GitHub/Google/Cloudflare Access; `getMcpAuthContext()` inside tools for per-user/tenant scoping. Access "MCP server portals" exist for governance.
- **Client**: `MCPClientManager` in agents, with OAuth handling.
- "Build a Code Mode MCP server" guide: expose one `execute(code)` tool over a typed API instead of N tools.

### 5.5 Dynamic Workers (Worker Loader) and Code Mode [V]

- `env.LOADER.load({ compatibilityDate, mainModule, modules, globalOutbound })` or `.get(id, ...)` for a stable cached ID. JS, Python, WASM. You choose which bindings and RPC stubs the code receives; `globalOutbound: null` blocks all network; egress can be intercepted. Custom CPU and subrequest limits per load. Logs via Tail Workers. **Durable Object Facets** give loaded code its own isolated SQLite.
- Concurrency: 4 distinct dynamic Workers in flight per Worker request; 10 per Durable Object (raised 2026-08-20).
- Pricing: Paid only. 1,000 unique dynamic Workers/month included, then **$0.002 per unique Worker per day** (unique = ID + code); requests and CPU at Workers rates. Billing since 2026-05-26.
- Code Mode: the LLM writes code against a typed API instead of emitting tool calls; docs claim up to 80% token savings.

### 5.6 Sandbox SDK (GA) [V]

- `@cloudflare/sandbox`: exec, files, processes, PTY, code interpreters (Python/JS/TS), preview URLs, backup/restore snapshots, file watching, R2 bucket mounts, `enableInternet: false`. Runs on Containers (microVM) or Dynamic Workers. Priced as the underlying product.
- Fit: only for agent tasks that need a real Linux toolchain (for example running `promtool`, DuckDB CLI). Default to Dynamic Workers: millisecond start, near-zero cost.

### 5.7 AI Search (formerly AutoRAG) [V]

- Managed hybrid (semantic + keyword) search with auto-indexing, metadata filtering, namespaces, Workers binding, REST, built-in MCP endpoint per instance; D1 as a data source (beta, 2026-11-12). All plans. Pricing and limits not read.
- Fit: optional. Index runbooks, dashboard definitions and metric/label catalogs per tenant for agents. Not a log search engine.

---

## 6. Security and authentication

| Service | Status / facts | Fit for viz |
|---|---|---|
| **Access service tokens** | `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers, or a single header (for example `Authorization`) via `read_service_tokens_from_header`; new `cfast_` secret format with checksum (2026-08-26); rotation grace 1 h-30 d; leaked-token detection via GitHub secret scanning (2026-11-11). [V] Access issues a JWT in `Cf-Access-Jwt-Assertion`, validated against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`; free up to 50 users. [T] | Human SSO for the UI and admin API. Not for tenant ingest keys: tokens are account-scoped objects managed through the Cloudflare API, with no per-tenant self-service. |
| **Own API keys in the Worker** | Hash lookup in KV or a per-tenant DO, cached in isolate memory. | Primary ingest auth. Supports Prometheus remote-write `Authorization: Bearer`, OTLP headers, basic auth. |
| **Rate Limiting binding** | `limit({ key, delta })`; `period` must be 10 or 60 s; counters are per Cloudflare location and eventually consistent; weighted `delta` (2026-11-04); pricing not stated on the page (no separate charge [T]). [V] | First-line per-tenant/per-key abuse limiter in the ingest Worker. Not a quota system. |
| **WAF rate limiting rules** | Free 1 rule (IP, 10 s); Pro 2; Business 5; Enterprise 100 with header/cookie/custom keys; counters are per data centre. [V] | Coarse IP flood protection only. Tenant-aware limiting must be in the Worker. |
| **Strict quotas** | Docs recommend a DO for strict global limits. [V] | Per-tenant quota DO (or the tenant write-buffer DO itself) tracks ingested bytes/series. |
| **API Shield** | Schema validation, JWT validation, mTLS, sequence analytics; mostly Enterprise add-on. [T] New metric views (2026-11-11). [V] | Optional for enterprise tenants. Do not depend on it. |
| **mTLS** | Client certificates at the edge via API Shield; `mtls_certificates` binding for Worker-to-origin. [T] Workers VPC services now support custom CA + client certs (2026-11-18). [V] Cloudflare for SaaS mTLS is Enterprise only. [V] | Optional ingest auth for collectors; pull-scrape of private targets through Workers VPC / Tunnel. |
| **Secrets Store** | Open beta; integrates with Workers and AI Gateway. [V] | Account-level secrets (LLM provider keys, signing keys). Per-tenant secrets (scrape credentials, webhook URLs) should be envelope-encrypted in tenant DO/D1 with a key from Secrets Store. |
| **Turnstile** | Free CAPTCHA alternative. [T] | Sign-up and login forms only. |
| **Cloudflare for SaaS** | 100 custom hostnames included, $0.10 each after, max 50,000 on Free/Pro/Business; wildcard hostnames, custom certs and mTLS are Enterprise only. [V] | Offer `tenant.viz.example` under one wildcard zone for free; custom hostnames as an opt-in feature. |

---

## 7. Frontend, realtime, notifications

- **Workers Static Assets** is the default: assets served without invoking the Worker (free), `run_worker_first` (boolean or route patterns), `not_found_handling = "single-page-application"`, `env.ASSETS.fetch()`, `assets.base_path` (2026-11-11). [V] Pages is still mentioned alongside Workers in dashboards and changelog but new work targets Workers; Pages was already in maintenance posture at my cutoff. [T]
- **Frameworks with guides**: React + Vite, React Router, Remix 3, TanStack Start, SvelteKit, Astro, Next.js (OpenNext adapter), Vue, Nuxt, RedwoodSDK, Vike, Hono, Solid, Qwik, Angular, Analog, Waku. [V] vinext is not on the framework list. [V]
- **Vite plugin**: `@cloudflare/vite-plugin` 1.64+ (2.0.0-rc for the `cf` CLI), runs the Worker in workerd during `vite dev`, uploads source maps by default. [V]
- **Realtime**: no general managed pub/sub. Cloudflare Realtime is WebRTC (RealtimeKit, SFU). [V] The MQTT Pub/Sub beta is absent from current docs navigation; presumed gone. [T] The native pattern is a Durable Object with hibernatable WebSockets (or SSE from a Worker). Agents SDK state sync is built on it.
- **Notifications**: **Email Service** sending is beta: Workers binding, REST and SMTP; Paid includes 3,000 emails/month then $0.35 per 1,000; 50 recipients and 25 MiB per message; daily quota ramps with reputation; free to verified addresses. [V] Everything else (Slack, PagerDuty, Opsgenie, Teams, generic webhooks) is an outbound `fetch`, best driven from a Queue consumer for retries. Agents SDK ships Slack, email, webhook and push-notification channels. [V] No native SMS. [T]

Recommendation for the UI: a client-rendered SPA (React + Vite, TanStack Router/Query) on Static Assets with an API Worker behind `run_worker_first: ["/api/*", "/mcp", "/v1/*"]`. Dashboards are interactive and auth-gated; SSR adds CPU cost and complexity without benefit.

---

## 8. Dev and deploy tooling

- **Wrangler 4.16x** is current; **`cf` CLI 1.0.0-rc.1** (2026-11-17) is the unified Cloudflare CLI with `cf deploy`, `cf previews deploy`, `cf observability tail`, `cf billing spend-policies`, `cf docs search`, a `cloudflare.config.ts` format and "Build Output v1". Wrangler is still required by many features' minimum-version notes. [V] Relationship (replace vs coexist) not confirmed; the RC page 404ed.
- **Local**: Miniflare/workerd under `wrangler dev` and `vite dev`; Local Explorer can fire cron invocations (2026-10-17); Containers run locally with Docker. [V]
- **Tests**: `@cloudflare/vitest-plugin` (successor of `@cloudflare/vitest-pool-workers`): tests run inside workerd, per-file isolated storage, `runInDurableObject`, `runDurableObjectAlarm`, multi-Worker projects. [V]
- **Workers Builds**: Git-connected CI (GitHub, GitLab, Artifacts). Paid: 6,000 build minutes/month then $0.005/min, 6 concurrent builds, 20 min timeout, 4 vCPU / 8 GB / 20 GB. Preview builds on non-production branches produce preview URLs; preview builds do not update container images. Logs kept 90 days. [V]
- **Versions / previews / environments**: `wrangler versions upload` + `versions deploy`, preview URLs, version overrides. [V] Wrangler environments (`env.staging`) remain. [T]
- **IaC**: Terraform provider v5.29.0 is current (covers AI Search namespaces, AI Security). [V] Pulumi and Alchemy (TypeScript-native IaC) exist. [T] Wrangler can auto-provision KV/R2/D1 from bindings. [T]
- **Spending limits** per product (2026-11-13). [V]

Recommended practice:

1. One monorepo, one Worker per role (section 9), each with its own `wrangler.jsonc`; Worker-attached resources (DO classes and migrations, queues, R2 buckets, workflows, containers) declared there so config and code version together.
2. Terraform only for account/zone-level things that are not Worker-attached: DNS, zone settings, WAF rules, Access apps and policies, custom hostnames, Secrets Store, Logpush.
3. Separate Cloudflare accounts for prod and non-prod (limits such as 500 Workers, 250 crons and spending caps are per account); preview URLs per PR in non-prod.
4. Gradual deployments for stateless Workers; for DO classes rely on deferred code updates and keep storage schema migrations backward compatible, because only one DO version is live.
5. Pin on Wrangler until `cf` is 1.0 final.

---

## 9. Design implications for viz

### 9.1 Role-to-primitive mapping

| Role | Primitive | Why | Wall and mitigation |
|---|---|---|---|
| **Ingest gateway** (OTLP/HTTP, Prom remote-write, Loki push) | Stateless Worker on a zone route | Scales to any rate, zero idle cost, runs at the edge next to the sender | Decode in a streaming fashion; cap body size (a few MB) well below the 100 MB zone limit; Rate Limiting binding per key; reject with 429 before parsing. Auth by hashed API key cached in isolate memory. |
| **Per-tenant write buffer / WAL** | SQLite Durable Object per `(tenant, signal, shard)` with a location hint near the R2 bucket | Single writer gives ordering, dedupe and an atomic "batch is durable" acknowledgement via the output gate | 1,000 req/s soft cap per object: shard by hash and grow shard count per tenant from a directory object. $1/M rows written: store each ingest batch as one compressed BLOB row (limit 8 MB), not one row per sample. Keep in-memory state under about 50 MB. Must go idle to stop duration billing. Automatic stub retries mean writes need an idempotency key. |
| **Flusher** | The buffer DO's own alarm | No extra moving part; alarm is at-least-once with retries; 15 min wall, 5 min CPU | Encode Parquet in bounded row groups and stream to R2 multipart; one flush must fit in 128 MB. Flush on size or age. Commit to the Iceberg catalog with optimistic concurrency, then delete WAL rows. Set alarms only when data is pending. |
| **Compactor / retention / rewrite** | Workflow as orchestrator; Worker steps for small partitions; a Container (standard-2 to standard-4, scale to zero) for large merges | Workflows give durable, retried, resumable multi-step jobs at low frequency; Containers give 6-12 GiB RAM and real threads | A step returns at most 1 MiB, so steps pass R2 keys, never data. Workflow step fee is negligible at this frequency. Container cold start 1-3 s and about $0.40/h for standard-4 only while running. Retention by Iceberg snapshot expiry and file deletes is metadata-heavy and fits a Worker step. |
| **Query coordinator** | Stateless Worker (HTTP API: PromQL, TraceQL, LogQL-ish, SQL) | Parses, plans against Iceberg metadata, prunes files, fans out, merges streams | Planning must not load full manifests into memory: keep a compact per-tenant index (in a DO or cached in KV/Cache API). Stream the merged result to the client. |
| **Query workers / fan-out** | The same Worker invoked over a service binding (RPC returning a `ReadableStream`), one invocation per file or file group | Each invocation gets its own CPU budget (up to 5 min) and usually its own memory; no extra request fee for service bindings | 6-connection wall applies to the caller including service-binding calls: use a fan-out tree (coordinator calls k sub-coordinators, each calls k leaves) or route leaves through DO stubs. 32 MiB RPC payload cap: return streams of partial aggregates, not rows. Leaves read R2 with range requests and decode one row group at a time. Raise the subrequest limit explicitly. Spill very large or high-cardinality queries to a Container running a native engine (DuckDB/DataFusion). |
| **Rule evaluator / scheduler** | One "rule group" Durable Object per tenant (or per group) driven by its alarm; a single 1-minute Cron Trigger as a watchdog that re-arms groups whose alarm is missing | Alarms are per-object, precise and cost $0.15/M; state (pending/firing, `for:` durations) lives beside the scheduler | Do not use one cron per tenant (250 per account) or Workflows per evaluation (step billing). The rule DO calls the query coordinator via RPC and enqueues notifications. |
| **Notification dispatch** | Queue + consumer Worker | Retries with backoff and delay, dead-letter queue, isolates slow webhooks from evaluation | 128 KB message limit: send IDs and a small rendered payload. Email through Email Service (beta); everything else via `fetch`. |
| **Scraper for pull ingest** | A "scrape pool" Durable Object per tenant (sharded per N targets) on alarms, fetching targets and writing straight into the tenant's ingest path | Alarms give per-target intervals down to seconds; state holds target health and staleness markers | 6 concurrent outbound connections per object and subrequest limits bound targets per shard: about 50-100 targets per shard at 15-60 s intervals. Private targets need Workers VPC / Tunnel. A DO that scrapes every 15 s never sleeps, so each active scrape shard costs up to about $4/month in duration: pull ingest has a real idle cost and should be priced or pooled accordingly. |
| **Agent runtime** (chat, investigations, agentic monitors) | Agents SDK agent (one DO per conversation or per monitor); scheduled runs through the agent scheduler; LLM calls through AI Gateway; data access through Code Mode in a Dynamic Worker with a narrow, tenant-scoped RPC binding to the query API and `globalOutbound: null` | Hibernates when idle; wall time unlimited while awaiting the model; generated code runs in an isolate with no ambient authority | 30 s CPU per event is plenty (LLM wait is not CPU). Use fibers or a Workflow for investigations that must survive deploys. Reuse stable Dynamic Worker IDs to stay within the 1,000/month included. Budget LLM spend per tenant at the gateway. |
| **MCP server** | Stateless `createMcpHandler` in the API Worker, OAuth via Workers OAuth Provider | Agent-first surface for external agents; no DO needed | Expose few tools (query, list metrics/labels, manage dashboards/monitors) or one Code Mode `execute` tool. |
| **UI** | SPA on Workers Static Assets + API Worker; live updates via a per-dashboard or per-tenant DO with hibernatable WebSockets | Static requests are free; hibernation makes idle live dashboards free | Incoming WS messages bill 20:1; outgoing are free. Push refresh hints, let clients re-query through the cached HTTP API. |
| **Control plane** (tenants, keys, dashboards, monitors) | Per-tenant SQLite DO (source of truth) plus KV as a read-through cache for the ingest hot path | Tenant isolation by construction; no shared database to scale | Global listing needs a small directory (D1 or a directory DO). |

### 9.2 Designing around the hard walls

**128 MB memory**

- Treat 128 MB as about 60-80 MB of usable working set per invocation; isolates are shared across concurrent requests and across DO instances of a class.
- Parquet files written by viz must be readable in an isolate: small row groups (for example 8-32 MB uncompressed), page indexes and bloom filters so readers fetch only needed column chunks with R2 range reads.
- Never buffer request or response bodies. Stream decode, stream encode, stream to R2 multipart.
- Push aggregation down to leaves and merge partial aggregates; high-cardinality group-bys need either two-level hashing across leaves or a Container.
- WASM linear memory counts against the limit and does not shrink: prefer short-lived leaf invocations over long-lived WASM heaps.

**CPU time (30 s default, 5 min max)**

- Set `limits.cpu_ms` per Worker by role: low for ingest (protects cost), high for query leaves and flush.
- CPU is billed at $0.02/M ms, so 5 min of CPU costs $0.006. CPU is cheap; the constraint is the per-invocation cap, which fan-out removes.
- In Durable Objects the budget resets per incoming event, so long work should be chunked across alarms.

**Subrequests and connections**

- Default 10,000 subrequests is already enough for most queries; raise to the needed value for coordinators. The effective wall is **6 connections waiting for headers**, shared with service-binding callees.
- Fan-out tree with a small branching factor per level, or enqueue leaf tasks and collect through a coordinator DO, gives parallelism beyond six.
- R2 through the binding counts as a Cloudflare-service subrequest.

**Request and payload sizes**

- RPC 32 MiB, Workflow step result 1 MiB, queue message 128 KB, DO row 8 MB, WS message 32 MiB. Rule: data moves through R2 or streams; control messages carry keys.

**Startup time (1 s) and bundle (64 MiB)**

- Keep WASM kernels small and instantiate lazily per role. Separate Workers per role keep the ingest Worker tiny and fast.

**Placement**

- Ingest Workers run at the edge; buffer DOs should be created with a location hint matching the R2 bucket region, and query Workers can use an explicit placement `region` hint so that file reads are local. DOs never move, so the tenant's region is a create-time decision.

### 9.3 Idle cost floor

- Fixed: Workers Paid $5/month. Everything in the default architecture (Workers, DOs, Queues, Workflows, Containers, static assets) bills zero when idle. R2 storage is the only other standing cost.
- Things that break scale-to-zero and need explicit design: pull scraping (DOs kept awake), frequently evaluated rules (alarm per interval), WebSocket dashboards that send frequent client messages, containers without an inactivity timeout, `keepAlive()` in agents.
- A tenant with 20 rules at 1-minute intervals in one rule-group DO = 43,200 alarm requests/month (under one cent) plus a few seconds of duration per run.

### 9.4 Positioning against Cloudflare Observability

- Cloudflare's own product ingests only Cloudflare-generated datasets at $0.25/GB + $0.10/GB-month with SQL, alerts and dashboards. viz differentiates on external OTLP/Prometheus ingest, metrics, PromQL/TraceQL, open Iceberg tables in the customer's R2, and long retention at R2 prices.
- viz should ingest its own platform telemetry by configuring Workers OTel export (OTLP/JSON traces and logs) to its own ingest endpoint, and should accept OTLP/JSON for that reason.

---

## 10. Quick reference: unit prices [V]

| Item | Price |
|---|---|
| Workers | $0.30/M requests; $0.02/M CPU-ms |
| Durable Objects | $0.15/M requests; $12.50/M GB-s; $1.00/M rows written; $0.001/M rows read; $0.20/GB-month |
| Queues | $0.40/M operations (64 KB units; about 3 per message) |
| Workflows | Workers rates + $0.80/100k steps + $0.20/GB-month state |
| Containers | $0.0000025/GiB-s memory; $0.000020/vCPU-s active; $0.00000007/GB-s disk |
| Dynamic Workers | $0.002 per unique Worker per day after 1,000/month |
| Workers for Platforms | $25/month base; $0.02 per script after 1,000 |
| Workers AI | $0.011 per 1,000 neurons |
| AI Gateway | free; 5% fee on Unified Billing credits |
| Email Service | $0.35 per 1,000 after 3,000/month |
| Workers Builds | $0.005/min after 6,000 min/month |
| Cloudflare for SaaS | $0.10 per hostname after 100 |
| Cloudflare Observability (from 2026-12-01) | $0.25/GB ingested; $0.10/GB-month |

---

## 11. Open questions / unverified

1. **Bundle size conflict**: Workers limits page says 64 MiB uncompressed and no compressed limit; Agents limits page says 10 MB per script. Could not find the changelog entry (search budget exhausted). Test with a real upload before committing to a large WASM engine in a Worker.
2. **Subrequests "up to 10M"**: the config key name under `limits` and any cost or plan condition were not shown.
3. **DO BLOB/row limit 8 MB** (was 2 MB at my cutoff) and **max hibernatable WebSockets per DO** (32,768 from training; docs today say "thousands").
4. **Per-invocation memory isolation for fan-out**: whether N concurrent service-binding calls to the same Worker land in separate isolates is not guaranteed by docs. Needs a load test; routing leaves through distinct DO IDs or Containers is the deterministic fallback.
5. **DO eviction timing**: 70-140 s idle figure comes from the Agents docs; hibernation delay for WebSocket objects is from training.
6. **Containers**: custom instance type limits; whether container-to-R2 traffic counts as billed egress; R2 FUSE throughput; snapshot pricing; whether a container can be pinned near an R2 bucket region.
7. **Cron Trigger delivery semantics** (retries, duplicates, skew) are undocumented on the page.
8. **Rate Limiting binding** pricing and GA label not on the page.
9. **Python Workers** GA status not stated; **workers-rs** RPC support not stated.
10. **Access**: JWT validation details, free seat count and whether service tokens can be scoped per application at scale are from training. **API Shield**, **Turnstile**, **mTLS** details are from training.
11. **Pages** lifecycle status and **Pub/Sub (MQTT)** fate are not confirmed from current docs.
12. **`cf` CLI** vs Wrangler: is Wrangler being retired, and is `cloudflare.config.ts` the future config format?
13. **Cloudflare Observability roadmap**: external OTLP ingest or native metrics would overlap viz directly; the blog only promises metrics *export*.
14. **Email Service** is beta with reputation-ramped daily quotas: not yet a dependable sole alert channel.
15. **AI Search** pricing and limits not read.
16. **Queue pull from inside a Worker**: pull consumers are an HTTP API with an API token; no binding-based pull was documented.

---

## 12. Sources

All fetched 2026-11-18.

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Workers platform changelog: https://developers.cloudflare.com/workers/platform/changelog/
- Workers product changelog: https://developers.cloudflare.com/changelog/product/workers/
- Global changelog: https://developers.cloudflare.com/changelog/
- Placement: https://developers.cloudflare.com/workers/configuration/placement/
- RPC: https://developers.cloudflare.com/workers/runtime-apis/rpc/
- WebAssembly: https://developers.cloudflare.com/workers/runtime-apis/webassembly/
- Rust: https://developers.cloudflare.com/workers/languages/rust/
- Python: https://developers.cloudflare.com/workers/languages/python/ and https://developers.cloudflare.com/workers/languages/python/how-python-workers-work/
- Gradual deployments: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/
- Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Workers Logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Tail Workers: https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- OTel export: https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/
- Observability pricing: https://developers.cloudflare.com/observability/pricing/
- Blog, "8 major updates to Cloudflare Observability": https://blog.cloudflare.com/one-observability-platform/
- Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Worker Loader binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/
- Dynamic Workers index, pricing, limits: https://developers.cloudflare.com/dynamic-workers/llms.txt , https://developers.cloudflare.com/dynamic-workers/pricing/ , https://developers.cloudflare.com/dynamic-workers/platform/limits/
- Static Assets: https://developers.cloudflare.com/workers/static-assets/
- Framework guides: https://developers.cloudflare.com/workers/framework-guides/web-apps/
- Vitest integration: https://developers.cloudflare.com/workers/testing/vitest-integration/
- Workers Builds: https://developers.cloudflare.com/workers/ci-cd/builds/ and https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- Workers for Platforms pricing and limits: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/ , https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/
- Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Rules of Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- DO alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- DO data location: https://developers.cloudflare.com/durable-objects/reference/data-location/
- DO WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- DO in-memory state: https://developers.cloudflare.com/durable-objects/reference/in-memory-state/
- Containers overview, limits, pricing, architecture, scaling: https://developers.cloudflare.com/containers/ , https://developers.cloudflare.com/containers/platform-details/limits/ , https://developers.cloudflare.com/containers/pricing/ , https://developers.cloudflare.com/containers/platform-details/architecture/ , https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/
- Containers and Sandboxes GA: https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
- Sandbox SDK: https://developers.cloudflare.com/sandbox/
- Workflows limits and pricing: https://developers.cloudflare.com/workflows/reference/limits/ , https://developers.cloudflare.com/workflows/reference/pricing/
- Queues limits and pull consumers: https://developers.cloudflare.com/queues/platform/limits/ , https://developers.cloudflare.com/queues/configuration/pull-consumers/
- Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- AI Gateway overview and pricing: https://developers.cloudflare.com/ai-gateway/ , https://developers.cloudflare.com/ai-gateway/reference/pricing/
- AI Search: https://developers.cloudflare.com/ai-search/
- Agents overview, index, limits, scheduling, fibers, remote MCP: https://developers.cloudflare.com/agents/ , https://developers.cloudflare.com/agents/llms.txt , https://developers.cloudflare.com/agents/platform/limits/ , https://developers.cloudflare.com/agents/agent-class/schedule-tasks/ , https://developers.cloudflare.com/agents/agent-class/durable-execution/ , https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- Access service tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- WAF rate limiting rules: https://developers.cloudflare.com/waf/rate-limiting-rules/
- Secrets Store: https://developers.cloudflare.com/secrets-store/
- Cloudflare for SaaS plans: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/
- Email Service overview, pricing, limits: https://developers.cloudflare.com/email-service/ , https://developers.cloudflare.com/email-service/platform/pricing/ , https://developers.cloudflare.com/email-service/platform/limits/
- Artifacts: https://developers.cloudflare.com/artifacts/

Pages that returned 404 (so not used): `/agents/runtime/scheduler/`, `/agents/tools/mcp-servers/`, `/changelog/post/2026-11-17-cf-cli-1-0-rc/`. `/pub-sub/` returned a generic page with no Pub/Sub content.
