# 07 — Ingestion, durability, auth, multi-tenancy, retention, adapters

Research date: 2026-11-18. Scope: how telemetry gets into viz (push and pull), how it is made durable before acknowledgement, who is allowed to send/read it, how tenants are isolated and billed, how data ages out, and how external systems plug in.

> **Web access note.** Web fetch worked throughout. Web *search* hit the shared per-turn budget part-way through, so some topics (Grafana LBAC current state, Workers zstd decompression, Basin Catalog row-level-delete support, Mimir/Loki limit defaults, WarpStream numbers, protobuf decode benchmarks) could not be re-verified and rely on training knowledge (cutoff mid-2026).
>
> **Evidence labels.** **[V]** = verified this session against the cited primary page (see Sources). **[T]** = training knowledge, not re-verified. **[E]** = my own estimate/derivation; the arithmetic is shown.

---

## 0. Executive summary

1. **Cloudflare's data platform was renamed and went GA on 2026-10-01**: Pipelines, R2 Data Catalog and R2 SQL are now *Basin Pipelines*, *Basin Catalog*, *Basin SQL*; old names and configs still work. [V] All three are now billed.
2. **Basin Pipelines is not the right primary ingest path for a multi-tenant product**, though it is tempting. Reasons, all [V]: 20 streams / 20 sinks / 20 pipelines per account (no per-tenant streams); custom partitioning is still "on the roadmap" (so no tenant/day partitioning, which retention and tenant erase depend on); invalid events are "accepted but dropped" (no synchronous partial-success feedback); a sink cannot target an existing Iceberg table; input is JSON only; and it costs $0.06/GB (Parquet/Iceberg sink) + $0.04/GB (any SQL counts as a transform) on *uncompressed* bytes. Its strengths are real: free stream ingress, a `send()` promise that resolves "when records are confirmed as ingested", and exactly-once sinks.
3. **Recommended ingest path: stateless edge Worker → per-tenant buffer Durable Object (SQLite WAL, ack-after-durable) → tenant-pure Parquet files on R2 → single-writer committer DO → Iceberg commit via the Basin Catalog REST API.** Estimated marginal cost ≈ **$0.005–0.03 per uncompressed GB ingested** plus ≈ $0.0015 per raw-GB-month stored [E], against $0.12–0.40 via Pipelines [E] and $0.25/GB for Cloudflare's own Observability product from 2026-12-01 [V]. Platform floor: **$5/month** (Workers Paid).
4. **Catalog operations ($9/million) make table-per-tenant expensive**: one commit per minute per table is roughly $0.4–0.8/table-month, so 1,000 tenants × 3 signals ≈ $1,200–2,300/month of pure commit overhead [E]. Use **shared tables partitioned by tenant**, with **tenant-pure data files** so that retention and GDPR erase are metadata-only file drops.
5. **Protocols.** Launch with OTLP/HTTP (protobuf + JSON, gzip) and Prometheus Remote Write 1.0 + 2.0. PRW 2.0 is *still* experimental (2.0-rc.6, October 2026) [V]. OTLP/gRPC on Workers is in **private beta** since 2026-08-03, unary and server-streaming only (via gRPC-web translation) [V] — enough for OTLP/gRPC `Export` once GA, not enough for OTel Arrow (bidirectional streaming; containers only).
6. **Tenant-supplied adapter code**: use **Dynamic Workers (Worker Loader)** — 1,000 unique workers/month included, then $0.002 per unique worker per day [V] — rather than Workers for Platforms ($25/month base) [V], to protect the low minimum cost.
7. **Auth**: opaque prefixed API keys (hash stored, verified at edge with in-isolate cache) for agents; OAuth 2.1 via `workers-oauth-provider` for humans and MCP agents. The MCP spec (2026-07-28) **deprecates Dynamic Client Registration in favour of Client ID Metadata Documents**; the library supports both [V].

---

## 1. Platform facts that constrain the design (verified 2026-11-18)

### 1.1 Pricing

| Product | Unit | Included (Workers Paid) | Overage | Label |
|---|---|---|---|---|
| Workers | requests | 10 M/mo | $0.30/M | [V] |
| Workers | CPU | 30 M CPU-ms/mo | $0.02/M CPU-ms | [V] |
| Durable Objects | requests (incl. RPC sessions, alarms; WS msgs 20:1) | 1 M/mo | $0.15/M | [V] |
| Durable Objects | duration (128 MB billed) | 400,000 GB-s/mo | $12.50/M GB-s | [V] |
| DO SQLite | rows written | 50 M/mo | $1.00/M | [V] |
| DO SQLite | rows read | 25 B/mo | $0.001/M | [V] |
| DO SQLite | storage | 5 GB-mo | $0.20/GB-mo | [V] |
| Queues | operations (per 64 KB chunk; ~3 ops per delivered message) | 1 M/mo | $0.40/M | [V] |
| R2 Standard | storage | 10 GB-mo | $0.015/GB-mo | [V] |
| R2 Standard | Class A / Class B ops | 1 M / 10 M | $4.50/M / $0.36/M | [V] |
| R2 Infrequent Access | storage / retrieval | — | $0.01/GB-mo, $0.01/GB retrieval, 30-day minimum, Class A $9/M, B $0.90/M | [V] |
| Basin Pipelines | stream ingress | unlimited | free | [V] |
| Basin Pipelines | SQL transforms ("any query currently counts") | 50 GB/mo | $0.04/GB | [V] |
| Basin Pipelines | sink to R2 JSON / Parquet or Iceberg (uncompressed bytes) | 50 GB/mo | $0.03 / $0.06 per GB | [V] |
| Basin Catalog | catalog operations | 1 M/mo | $9.00/M | [V] |
| Basin Catalog | compaction data / objects | 10 GB / 1 M | $0.005/GB, $2.00/M objects | [V] |
| Basin Catalog | snapshot expiration | — | free | [V] |
| Basin SQL | compressed bytes scanned (10 MB minimum per query) | 10 GB/mo | $0.0025/GB | [V] |
| KV | reads / writes | 10 M / 1 M | $0.50/M / $5.00/M | [V] |
| Workflows | steps | 500 k/mo | $0.80 per 100 k (billing since 2026-08-10) | [V] |
| Dynamic Workers | unique workers created | 1,000/mo | $0.002 per worker per day (billing since 2026-05-26) | [V] |
| Workers for Platforms | base / scripts | 20 M req, 60 M CPU-ms, 1,000 scripts | $25/mo base; $0.02/script | [V] |
| Logpush (self-serve, all plans) | to R2 or Pipelines / to external / transformed | 25 GB / 25 GB / 1 GB | $0.03 / $0.10 / $0.04 per GB | [V] |
| Cloudflare Observability (from 2026-12-01) | ingest / storage | 50 GB / 10 GB-mo | $0.25/GB / $0.10/GB-mo | [V] |
| Workers VPC | — | free during beta | post-beta price unstated | [V] |

Useful reference point: Cloudflare will charge its own customers **$0.25/GB ingested + $0.10/GB-month** for logs and traces from 2026-12-01. That is the "in-platform" price viz is implicitly competing with for Cloudflare-native telemetry.

### 1.2 Limits

| Limit | Value | Label |
|---|---|---|
| Worker memory | 128 MB per isolate | [V] |
| Worker CPU per HTTP request | 30 s default, up to 5 min | [V] |
| Request body | 100 MB (Free/Pro), 200 MB (Business), 5 GB (Enterprise) | [V] |
| Subrequests | 10,000 default on Paid, configurable to 10 M | [V] |
| Simultaneous open outbound connections | 6 per invocation | [V] |
| Cron Triggers | 250 per account (Paid) | [V] |
| DO SQLite storage | 10 GB per object; unlimited objects | [V] |
| DO row / BLOB / key+value size | 8 MB | [V] |
| DO soft throughput | ~1,000 req/s per object, then queue, then overloaded error | [V] |
| DO alarm handler | 15 min wall time | [V] |
| DO SQL | 100 bound parameters per query, 100 columns per table, 100 KB statement | [V] |
| Queues | 128 KB message; 100 msgs or 256 KB per `sendBatch`; 5,000 msg/s per queue; 25 GB backlog; 250 concurrent consumers; retention ≤ 14 days | [V] |
| Basin Pipelines | 20 streams, 20 sinks, 20 pipelines per account; 5 MB per ingest request; 1 GB/s per stream (limits page) / "up to 3 GB/s" (GA blog) | [V] |
| Basin Catalog sink roll interval | default 300 s, minimum 60 s | [V] |
| Basin Catalog compaction target | 64–512 MB; Parquet only | [V] |
| Basin Catalog snapshot expiration defaults | older than 30 days AND not in last 5 | [V] |
| Rate Limiting binding | period must be 10 s or 60 s; counted per Cloudflare location; approximate | [V] |

### 1.3 Roadmap items that matter (Basin GA blog, 2026-10-01) [V]

Announced as *future*: custom partitioning in Pipelines, schema migrations, updatable pipeline SQL, Iceberg v3 (Variant), stateful stream processing, **granular namespace/table authorization in the Catalog**, **Catalog jurisdiction support**, clustered/sorted compaction. Each of these is something viz must either build itself or do without today.

---

## 2. Push ingest protocols

### 2.1 Priority matrix

| Protocol | Signals | Wire format | Feasible on Workers | Priority | Notes |
|---|---|---|---|---|---|
| OTLP/HTTP | M, L, T (profiles in development) | protobuf or JSON; gzip | Yes | **P0** | Canonical internal model |
| Prometheus Remote Write 1.0 | M | snappy-block protobuf | Yes (snappy in JS/WASM) | **P0** | Ubiquitous; no reliable metadata |
| Prometheus Remote Write 2.0 | M | snappy-block protobuf, interned symbols | Yes | **P0** | Still rc.6, experimental [V] |
| OTLP/gRPC | M, L, T | gRPC unary | Private beta (2026-08) [V] | P1 when GA | Unary `Export` fits the Workers gRPC model |
| Loki push | L | snappy protobuf or JSON | Yes | P1 | Promtail/Alloy/Fluent Bit compatibility |
| Cloudflare Workers OTel export | L, T | OTLP/HTTP | Yes | P1 | Dogfood and natural first customer segment |
| Cloudflare Logpush (HTTP destination) | L | gzip NDJSON | Yes | P1 | Zone/account datasets |
| Influx line protocol | M | text | Yes | P2 | Telegraf ecosystem |
| Zipkin v2 JSON | T | JSON | Yes | P2 | Cheap to add |
| Datadog-agent intake | M, L, (T) | protobuf/JSON/msgpack, zstd/deflate | Partly | P2/P3 | Metrics and logs tractable; traces are not |
| StatsD / DogStatsD | M | UDP text | **No** (no inbound UDP) | Never direct | Needs a local agent |
| Jaeger Thrift | T | Thrift | Yes but pointless | Never | Jaeger itself is OTLP-native now [T] |
| OTel Arrow (OTAP) | M, L, T | bidirectional gRPC stream of Arrow IPC | **No** on Workers | Watch | Containers only |

### 2.2 OTLP/HTTP — spec v1.11.1 [V]

- **Endpoints**: `POST /v1/traces`, `/v1/metrics`, `/v1/logs` (`/v1development/profiles`). Default port 4318 is irrelevant behind Cloudflare; serve on 443.
- **Content types**: `application/x-protobuf` and `application/json`; the server must echo the request's content type. JSON uses hex trace/span IDs and integer enums; receivers MUST ignore unknown fields.
- **Compression**: servers MUST support `none` and `gzip`. zstd is optional in the spec. Workers `DecompressionStream` supports gzip/deflate natively [T]; zstd would need a WASM decoder or `node:zlib` if available under the current compat date [T, unverified].
- **Status codes**: 200 for full *and* partial success; 400 = permanent, MUST NOT retry; 413 = too large; **retryable only: 429, 502, 503, 504**. `Retry-After` on 429/503 SHOULD be honoured, otherwise exponential backoff.
- **Partial success**: 200 with `partial_success.rejected_<spans|data_points|log_records>` and `error_message`. "The client MUST NOT retry the request when it receives a partial success response."
- **Size**: 64 MiB request limit *recommended*; implementations should make it configurable.
- **Duplicates**: the spec explicitly accepts that a lost ack leads to resend and duplicates — "a deliberate choice". OTLP has **no request or batch ID**, so any dedup is the receiver's own construction (see §6.5).

Mapping viz conditions onto OTLP responses:

| Condition | Response | Client behaviour |
|---|---|---|
| Accepted and durable | 200, empty partial_success | done |
| Some points invalid (bad labels, too old, over per-series limit) | 200 + `rejected_*` count + message | no retry; visible in SDK/collector logs |
| Tenant over rate limit (transient) | 429 + `Retry-After` | retries with backoff |
| Tenant over hard quota (daily bytes, active series) | 200 + partial_success rejecting everything, or 429 with long Retry-After | Prefer partial success for series-limit (retry is futile); 429 for rate |
| Buffer DO overloaded / unavailable | 503 + `Retry-After` | retries |
| Body > limit | 413 | collector splits batches only if configured; document the limit |
| Bad auth | 401/403 | not retried |

**Body-size policy for viz [E]**: because the isolate has 128 MB, cap *decompressed* bodies at 16–32 MB and enforce it while streaming the gunzip (a gzip bomb otherwise kills the isolate). Document "set `sending_queue`/batch max size ≤ 8 MB" for collectors.

### 2.3 OTLP/gRPC on Workers

- Cloudflare announced inbound TCP and gRPC for Workers and Containers on **2026-08-03, private beta** [V]. On plain Workers, Cloudflare translates inbound gRPC to gRPC-web; handlers are written with `@connectrpc/connect`. **Unary and server-streaming only**; full bidirectional streaming requires a native gRPC server in a Container. Pricing, limits and trailer handling are not stated.
- OTLP/gRPC `Export` is unary, so it fits. gRPC throttling uses `UNAVAILABLE` + `RetryInfo`; `RESOURCE_EXHAUSTED` is retryable only with `RetryInfo` [V].
- **Design stance**: do not depend on it. Every mainstream SDK and the Collector support `otlphttp`. Add a gRPC listener when the feature is generally available; treat it as the same handler behind a different framing.

### 2.4 OTel Arrow (OTAP)

- Phase 2 (a full columnar pipeline engine in Rust, the "OTAP dataflow engine") is still being completed; the Collector `otelarrow` exporter/receiver ship in contrib but are labelled *development* in their READMEs, despite a 2024 blog calling them production-ready (search-result summary, moderately reliable). Maintainers cite ~50% less bandwidth than OTLP/gRPC + zstd at equal batch sizes.
- Transport is a long-lived bidirectional gRPC stream — **not servable from a Worker**.
- **Relevance to viz is architectural, not protocol-level**: the OTAP Arrow schemas are a well-reviewed columnar layout for OTLP data, and a reasonable reference for viz's Parquet schemas and for an internal Arrow-IPC adapter wire format. Do not implement the protocol.

### 2.5 Prometheus Remote Write

**1.0** [T]: `POST` with `Content-Encoding: snappy` (block format), `Content-Type: application/x-protobuf`, `X-Prometheus-Remote-Write-Version: 0.1.0`, body `prompb.WriteRequest`. Labels sorted; samples per series in timestamp order; no reliable metadata; stale markers as the special NaN. Retry on 5xx, not on 4xx except optionally 429.

**2.0** — version **2.0-rc.6, Experimental, dated October 2026** [V]:

- `Content-Type: application/x-protobuf;proto=io.prometheus.write.v2.Request`; snappy **block** format mandatory (framed forbidden); required headers `Content-Encoding`, `Content-Type`, `X-Prometheus-Remote-Write-Version`, `User-Agent`.
- **Symbols table**: strings interned; `symbols[0]` MUST be `""`; series carry `labels_refs`. This matters for CPU: a decoder can map symbol refs straight into dictionary-encoded Arrow columns without materialising strings per sample.
- **Metadata per series** (type, help, unit); **native histograms**; **exemplars** (must have timestamp); `start_timestamp` (the renamed "created timestamp") — 0 means unset.
- The rc.6 text introduces sender **modes** (`;mode=` parameter; `stateless` and `stateless-st`): in stateless modes `Metadata.type` MUST be set, histograms MUST be sent as native histograms, and in `stateless-st` the start timestamp MUST be set for counter-like series. This is new relative to earlier RCs and aimed at serverless/stateless senders — and receivers.
- **Response headers (MUST)**: `X-Prometheus-Remote-Write-Samples-Written`, `-Histograms-Written`, `-Exemplars-Written`.
- **No 2xx on partial write**: "Receivers MUST NOT return a 2xx HTTP status code, if any of the pieces of sent data" were not written. Success SHOULD be 204; asynchronous receivers MAY return 202. Invalid data → 400 (with the written-count headers reflecting what was accepted).
- **Retry**: MUST NOT retry 4xx except 429 (MAY); MUST retry 5xx; MAY honour `Retry-After`; MUST back off. "The Receiver MUST support idempotency as Senders MAY retry with the same request."
- 415 for unsupported content type, with `Accept`/`Accept-Encoding` hints, lets a sender fall back from 2.0 to 1.0.

Implication: PRW and OTLP **disagree on partial success** (PRW: non-2xx + counts; OTLP: 200 + rejected count). The ingest core must return a structured outcome (`accepted`, `rejected[{reason,count}]`, `retryable`) and let each protocol front-end render it.

Since viz acks after the buffer write, it is a *synchronous* receiver from the sender's viewpoint and should return 204 (not 202).

### 2.6 Loki push API [T]

`POST /loki/api/v1/push`; snappy-compressed protobuf (`logproto.PushRequest`) or JSON; streams = label set + entries `(ts_ns, line, structured_metadata)`; 204 on success; 429 on rate limit; 400 on validation. Tenant via `X-Scope-OrgID` in OSS Loki (viz derives tenant from the credential and ignores the header unless the key has a cross-tenant scope). Loki also accepts OTLP logs natively, so the Loki endpoint is purely for Promtail/Alloy/Fluent Bit/Docker-driver compatibility. Map stream labels → resource attributes; structured metadata → log attributes.

### 2.7 Zipkin, Jaeger, Influx, StatsD, Datadog [T]

- **Zipkin v2**: `POST /api/v2/spans`, JSON array (protobuf optional). Trivial mapping to OTLP spans. Worth a day's work.
- **Jaeger**: legacy Thrift-over-HTTP (`/api/traces`) and gRPC `jaeger.api_v2`. Jaeger v2 is built on the OTel Collector and its clients have been retired in favour of OTel SDKs. Skip.
- **Influx line protocol**: `POST /api/v2/write?bucket=…&precision=ns`, `Authorization: Token …`, gzip. Text parse is cheap. Map `measurement` + field key → metric name `measurement_field`, tags → labels; string fields are dropped or sent to logs.
- **StatsD/DogStatsD**: UDP (or UDS). Workers have no inbound UDP (Cloudflare lists UDP as a future direction [V]). The answer is "run an agent" (OTel Collector `statsd` receiver, Vector, Telegraf, or the Datadog Agent) which forwards over OTLP/HTTP. Client-side aggregation is the whole point of StatsD anyway.
- **Datadog-agent-compatible intake**: the agent can be repointed with `dd_url` / `logs_config.logs_dd_url` / `apm_config.apm_dd_url`. Tractable: `/api/v2/series` (protobuf or JSON, zstd/deflate), `/api/v1/series`, `/api/v2/logs` (gzip JSON), `/api/v1/validate`. Hard: `/api/beta/sketches` (DDSketch distributions → must convert to exponential histograms), trace-agent payloads (`/api/v0.2/traces`, msgpack/protobuf plus stats payloads, only loosely documented), process/container/orchestrator intakes. The OTel Collector `datadog` receiver and Vector's `datadog_agent` source are the reference implementations. Recommendation: P2 for metrics + logs behind a flag; send people to the OTel Collector `datadog` receiver for traces.

### 2.8 Cloudflare-native sources

| Source | Mechanism | Verified facts | viz stance |
|---|---|---|---|
| **Workers OTel export** | Dashboard *Observability → Destinations* with an OTLP endpoint + custom headers; enabled per Worker via `observability.traces` / `observability.logs` `destinations` | Exports Cloudflare Traces, Workers Traces, Workers Logs; delivered in batches; examples include arbitrary endpoints; **metrics export is "coming soon"**, not available [V] | P1. Publish a "viz" destination recipe: endpoint `https://<ingest>/v1/{traces,logs}` + `Authorization` header |
| **Tail Workers** | `tail_consumers` on the producer Worker | Receive status, `console.log`, exceptions, diagnostics-channel events; billed on CPU time; Paid/Enterprise only [V] | Same-account only (cross-account not documented). Ship a tiny open-source "viz tail forwarder" Worker for tenants who need per-invocation delivery |
| **Logpush** | HTTP destination | Now self-serve on all plans; **$0.10/GB to external destinations** after 25 GB, $0.03/GB to R2/Pipelines; transformers $0.04/GB; **Logpush cannot write to jurisdiction-restricted R2 buckets** [V] | P1 `POST /cf/logpush/:dataset` accepting gzip NDJSON with a header secret. Note the tenant pays Cloudflare $0.10/GB to send to viz |
| **Workers Analytics Engine / GraphQL Analytics / Observability SQL API** | Pull over HTTPS with a tenant-supplied API token | A unified SQL API (beta) now spans Workers logs, HTTP logs, analytics [V] | Built-in *pull adapter* (§3.6), query-time federation rather than ingest |
| **Cloudflare metrics → OTel** | — | "Coming soon" [V] | Wait |

One open point: the Workers export docs say "Cloudflare does not support the binary format for OTLP ingestion" [V]. The sentence is ambiguous (it may refer to a particular destination), but the safe reading is that Cloudflare's exporter may send **OTLP/JSON**. viz must treat OTLP/JSON as a first-class, performance-relevant path, not a debugging nicety.

### 2.9 Decoding cost in Workers

Nothing authoritative exists for "CPU-ms per MB of OTLP on workerd"; the search found none. What can be said:

- CPU is priced at $0.02 per million CPU-ms, i.e. **$0.02 per 1,000 CPU-seconds**. Even a slow 300 ms/MB path costs 1,024 × 0.3 s = 307 CPU-s ≈ **$0.006 per GB**. Decode CPU is therefore *not* the dominant cost; it matters for latency, the per-request CPU ceiling and DO single-thread throughput, not for the bill. [E]
- Rough expectations [T, must benchmark]: gunzip 100–300 MB/s native; generated-JS protobuf decoding (protobuf-es, protobufjs) 20–100 MB/s on numeric-heavy payloads, markedly worse on string-heavy ones because every label becomes a JS string and every data point an object; a Rust/WASM decoder (prost or hand-rolled) 200–600 MB/s but paying a copy across the JS/WASM boundary.
- **The decisive factor is avoiding JS object materialisation**, not JS-vs-WASM as such. The cheapest pipeline is a single WASM module that takes the (decompressed) request bytes and emits columnar buffers (Arrow IPC or a private row-group format) with dictionary-encoded attributes, doing validation and limit checks in the same pass. PRW 2.0's symbol table and OTLP's resource/scope nesting both map directly onto dictionary columns.
- JSON OTLP: `JSON.parse` is fast (hundreds of MB/s) but produces the object graph anyway; a streaming WASM JSON parser (simd-json style) into the same columnar builder keeps one code path.
- Snappy: no native API; a WASM or pure-JS block decoder is ~1–2 KB of logic and >500 MB/s [T].
- WASM memory counts against the 128 MB isolate; keep per-request arenas and free them deterministically.

**Benchmark to run before committing** (cheap, a day): fixed corpora (OTLP metrics 1 MB/10k points; OTLP logs 1 MB; PRW2 1 MB) × {protobuf-es → JS → Arrow, WASM → Arrow} on deployed Workers, reading CPU time from the Workers analytics, not wall clock.

---

## 3. Pull ingest

### 3.1 Prometheus scrape protocol [V for negotiation, T for the rest]

- Five negotiable formats: `PrometheusProto` (`application/vnd.google.protobuf; proto=io.prometheus.client.MetricFamily; encoding=delimited`), `PrometheusText0.0.4`, `PrometheusText1.0.0`, `OpenMetricsText0.0.1`, `OpenMetricsText1.0.0`. The scraper lists them in `Accept` with descending `q` and a trailing `*/*`.
- Text 1.0.0 and OpenMetrics 1.0.0 carry `escaping=` (`allow-utf-8`, `underscores`, `dots`, `values`) for UTF-8 metric/label names.
- If the target's `Content-Type` is missing or unparseable, use the configured fallback protocol, else `PrometheusText0.0.4`.
- `Accept-Encoding: gzip`; send `X-Prometheus-Scrape-Timeout-Seconds` [T].
- **Native histograms and start timestamps are only fully exposed via protobuf** (OpenMetrics 2.0 text support is in progress) [T]. So a viz scraper should prefer protobuf when the tenant enables native histograms, otherwise OpenMetrics text for exemplars and `_created`.
- Synthetic series per scrape: `up`, `scrape_duration_seconds`, `scrape_samples_scraped`, `scrape_samples_post_metric_relabeling`, `scrape_series_added` [T].

### 3.2 Staleness [T]

Prometheus writes a **stale marker** (NaN with bit pattern `0x7ff0000000000002`) when a series present in the previous scrape is absent from the current one, and for all series of a target that fails or disappears. PromQL instant-vector selection otherwise looks back 5 minutes.

For a serverless scraper this requires **per-target state: the set of series seen in the last scrape**. Store a compact set of 64-bit series hashes per target in the scrape DO's SQLite (or as one BLOB per target; 10k series = 80 KB). Without it, a disappearing series "lingers" for the lookback window and `absent()` alerts fire late. Push sources do not have this problem as long as the sender (Prometheus, Alloy) emits stale markers — PRW 2.0 says senders MUST when detectable [V] — and OTLP has its own `NoRecordedValue` flag which must be mapped to the same marker.

### 3.3 Service discovery without a control loop on the tenant side

| Mechanism | Fit | Notes |
|---|---|---|
| Static targets (API/UI/Terraform) | Excellent | Stored in the tenant's config DO |
| **HTTP SD** (`http_sd_configs` format: JSON list of `{targets, labels}`) [T] | Excellent | viz polls a tenant URL every N seconds; the tenant can back it with anything, including a Worker |
| DNS SD (A/AAAA/SRV) | Good | Via DNS-over-HTTPS (`cloudflare-dns.com/dns-query`) from a Worker; SRV gives ports |
| Cloud API SD (EC2, GCE, Azure) | Adapter | Signed HTTPS calls with tenant-supplied read-only credentials; a "discovery adapter" |
| Kubernetes SD | Poor | Needs API-server access and watches; in practice, run an agent in the cluster |
| File/Consul/etc. | No | Convert to HTTP SD |

Honest position: **scrape-as-a-service suits public or tunnel-reachable endpoints (SaaS exporters, serverless apps, status endpoints, other Prometheus servers' `/federate`). For Kubernetes and private fleets, pushing from an in-network agent (Prometheus agent mode, Alloy, OTel Collector) is simpler and cheaper for everyone.** viz should say so in its docs rather than fight it.

### 3.4 Scheduling scrapes

| Scheduler | Verdict | Reason |
|---|---|---|
| **DO alarms, one DO per target group** | **Use this** | Alarms are durable, at-least-once, retried, 15-min wall budget [V]; one pending alarm per DO, so the DO keeps a small min-heap/table of `next_due` and re-arms. State (last series set, ETag, backoff, SD cache) lives next to the timer |
| Cron Triggers | Supervisor only | 250 per account [V], 1-minute granularity; fine as a watchdog that pokes the scheduler registry |
| Workflows | Not for scrapes | $0.80 per 100 k steps [V]: one step per 30 s scrape = 86,400 steps/month ≈ **$0.69 per target-month**, versus ≈ $0.013 of DO requests. Use Workflows for multi-step, resumable jobs: backfills, bulk imports, tenant deletion |
| Queues with `delaySeconds` | No | Works, but state is elsewhere and delay ≤ 24 h; no advantage over alarms |

Shape of a scrape group DO:

- Name: `scrape:{tenant}:{job}:{shard}`; ≤ ~50–100 targets per DO so a tick finishes well within the interval (only 6 simultaneous outbound connections per invocation [V] — scrape in waves of 6).
- Spread targets across the interval by `hash(target) mod interval` (Prometheus does the same) to avoid thundering herds on tenant infrastructure.
- Each tick: fetch → parse → relabel → compute stale markers → hand a batch to the *same* ingest core as push (so limits, dedup and durability are identical).
- Failure handling: timeout → `up=0` + stale markers; exponential backoff is *not* applied to the schedule (Prometheus semantics: keep scraping), but repeated SD failures are surfaced to the tenant.
- Cost [E]: a group ticking every 30 s = 86,400 alarm invocations/month ≈ $0.013; duration at ~2 s active per tick ≈ 0.128 GB × 172,800 s ≈ 22 k GB-s ≈ $0.28/month (within included usage for the first few). Roughly **$0.3 per 50-target group-month**, i.e. well under a cent per target.

### 3.5 Private targets

| Option | How | Verdict |
|---|---|---|
| Tenant pushes from an agent | Prometheus agent / Alloy / OTel Collector inside the network | **Default recommendation** |
| Public hostname protected by auth | Tenant exposes the exporter through their own Cloudflare Tunnel + Access service token, or any reverse proxy with bearer/mTLS; viz stores the credential and presents it | Good; works today |
| Workers VPC | VPC *Services* (one host:port per binding) or VPC *Networks* (bind a whole Tunnel / Mesh / WAN on-ramp, destination chosen at runtime, HTTP and raw TCP) [V] | **Beta, free during beta** [V]. Bindings are to tunnels in *viz's* account, configured at deploy time. A multi-tenant offering would have viz provision a tunnel per tenant (tenant runs `cloudflared` with a token viz issues) and reach it through a VPC Network binding. Whether bindings can be attached dynamically per tenant is unverified. Treat as a later, enterprise-tier feature |
| Reverse-connection agent | Tenant-side agent holds an outbound WebSocket to a DO (hibernatable) and executes scrapes on request (like PushProx / Grafana "private data source connect") | Works on Cloudflare, but at that point the agent might as well push |

**SSRF**: scrape URLs and HTTP-SD URLs are tenant-controlled. Workers' `fetch` cannot reach RFC1918 addresses on Cloudflare's network, but it can reach viz's own zones and other Cloudflare-hosted services. Mitigations: resolve-and-validate against a deny-list (loopback, link-local, private ranges, viz's own hostnames), forbid redirects (`redirect: "manual"`), cap response size and time, and enable the `global_fetch_strictly_public` compatibility flag (the same flag `workers-oauth-provider` requires before fetching client metadata documents [V]).

### 3.6 Federation and pull for logs/traces

- **Prometheus federation**: `/federate?match[]=…` is just a scrape with `honor_labels: true` and `honor_timestamps: true` [T]; support both flags in scrape config. For bulk history, prefer the tenant's Prometheus `remote_write` to viz.
- **Object-store readers** (S3/GCS/R2/Azure Blob): a DO per source holding a cursor (last key / continuation token / event watermark). Prefer **event-driven** over listing: R2 event notifications → Queue (same account only), S3 → SNS → HTTPS subscription, GCS → Pub/Sub push. Formats: ALB/CloudFront/VPC flow logs, CloudTrail, NDJSON, Parquet.
- **Cloud provider telemetry**: prefer *provider-push-to-HTTPS* over polling wherever it exists — AWS CloudWatch Metric Streams and Logs subscriptions → Firehose HTTP endpoint (which already speaks OTLP 1.0 for metric streams); GCP Pub/Sub push subscriptions with OIDC tokens; Azure Event Grid webhooks [T]. Polling (`GetMetricData`, `FilterLogEvents`) is the fallback: costs the tenant API fees and needs rate-limit-aware scheduling.
- **Kafka-like**: Workers can open outbound TCP, but a consumer-group client in a serverless isolate (long polls, rebalances, heartbeats) is a poor fit. Use the broker's HTTP surface (Confluent REST Proxy, Redpanda HTTP Proxy) from a DO with stored offsets, or tell the tenant to run a Kafka Connect HTTP sink / OTel Collector `kafka` receiver that pushes to viz.

All of these are instances of the **ingest adapter** contract in §4.

---

## 4. External adapters

### 4.1 Two different things called "adapter"

| | Ingest-time connector | Query-time federation |
|---|---|---|
| Purpose | Bring data *into* viz's Iceberg tables | Leave data where it is; answer queries against it |
| Trigger | Schedule, webhook, or inbound push | A PromQL/TraceQL/log query touching the adapter's namespace |
| Latency budget | Seconds to minutes | Interactive (sub-second to seconds) |
| Failure effect | Lag (data arrives late) | Partial or failed query result |
| Cost profile | Pay once at ingest, cheap queries | No storage cost, every query pays the remote |
| Prior art | OTel Collector receivers/exporters, Vector sources/sinks, Kafka Connect | Grafana data sources, Trino connectors, Prometheus remote read, DataFusion `TableProvider`, Thanos Store API |

A third, smaller class: **sinks/exporters** (forward a copy of ingested data elsewhere — S3, a SIEM, another OTLP endpoint). Model them as ingest-pipeline *branches* consuming flushed segments, never in the ack path.

### 4.2 Prior-art contracts worth copying

- **OTel Collector** [T]: `receiver → processor → exporter` with a shared in-memory data model (pdata) and a `consumer.Consume{Traces,Metrics,Logs}` hand-off; receivers are either push (server) or pull (scraper with interval). Lesson: *one internal data model, adapters only convert to it*; backpressure is the return value of `Consume`.
- **Grafana data source plugin** [T]: frontend + optional backend; backend implements `QueryData` (returns data frames — columnar, Arrow-encoded), `CheckHealth`, `CallResource`, optional streaming; secrets live in `secureJsonData`, decrypted only server-side; the plugin runs out-of-process over gRPC. Lesson: **health check as a first-class method; secrets never reach the browser; Arrow frames as the result currency.**
- **Trino connector SPI** [T]: `ConnectorMetadata` (schemas, tables, columns, statistics), `ConnectorSplitManager` (partition the scan into splits), `ConnectorPageSource` (produce columnar pages), plus **negotiated pushdown** — `applyFilter`, `applyProjection`, `applyLimit`, `applyAggregation`, `applyTopN` — where the connector returns what it accepted and the engine applies the remainder. Lesson: **pushdown is a negotiation with a residual**, not a boolean capability.
- **DataFusion `TableProvider`** [T]: `schema()`, `scan(projection, filters, limit) → ExecutionPlan`, and `supports_filters_pushdown() → Exact | Inexact | Unsupported` per filter. The same negotiation in three words. If viz's query engine is DataFusion-shaped, external adapters literally *are* TableProviders.
- **Prometheus remote read** [T]: `POST` snappy protobuf `ReadRequest{queries[{start_ms, end_ms, matchers[], hints{step, func, grouping, range}}]}` → either `SAMPLES` (one message) or `STREAMED_XOR_CHUNKS` (framed stream of raw TSDB chunks). The engine does all PromQL evaluation locally. Lesson: **"select series by matchers and time range, hints optional" is the minimal metric federation contract**, and many systems already implement it (Thanos, Mimir, VictoriaMetrics, M3).

### 4.3 Proposed viz adapter contract

Capability-oriented, transport-agnostic (JS RPC for in-platform adapters, HTTPS for remote ones), Arrow IPC as the data currency:

```
describe()            -> { kind, signals, capabilities, config_schema, version }
check_health(config)  -> { ok, detail }

# query-time (optional)
metrics.select(matchers, start, end, hints)        -> stream<ArrowBatch>   # remote-read shape
metrics.query_range(promql, start, end, step)      -> stream<ArrowBatch>   # optional passthrough pushdown
logs.scan(selector, start, end, filters, limit, direction) -> stream<ArrowBatch>
traces.get(trace_id) / traces.search(filters, start, end, limit)
metadata.labels(...) / label_values(...) / series(...)
# every scan returns { accepted_filters: Exact|Inexact|Unsupported per filter }

# ingest-time (optional)
pull(cursor, budget)  -> { batches: stream<ArrowBatch>, next_cursor, more }  # idempotent in cursor
on_webhook(request)   -> { batches }                                        # provider push
```

Rules that keep it easy to reason about:

1. **Adapters never write to storage and never see other tenants.** They return batches; the platform applies limits, dedup, durability and metering exactly as for push.
2. **Cursors are owned by the platform** (stored in the adapter-instance DO, committed only after the batch is durable). A crashed adapter re-reads from the last committed cursor: at-least-once into an idempotent sink.
3. **Budgets are explicit**: CPU ms, wall time, response bytes, subrequests, per call.
4. **Pushdown is advisory**: the engine always re-applies filters marked `Inexact`/`Unsupported`.
5. **Passthrough PromQL** is allowed only for adapters declaring PromQL compatibility, and only for sub-expressions whose selectors all resolve to that adapter.

### 4.4 Hosting tenant-supplied adapter code on Cloudflare

| Option | Isolation | Cost | Fit |
|---|---|---|---|
| **Built-in, declarative adapters** (config only) | N/A — viz code | none | Covers ~90%: Prometheus-compatible, Loki, Tempo/Jaeger, ClickHouse HTTP, S3-compatible, CloudWatch, Cloudflare APIs |
| **Remote HTTP adapter** hosted by the tenant | Network boundary | none to viz | Tenant implements the contract at a URL (possibly their own Worker). Signed requests (HMAC or mTLS) both ways |
| **MCP server as adapter** | Network boundary + OAuth | none to viz | Tools returning structured content. Good for *agent-facing* enrichment and low-volume lookups; poor as a bulk data plane (JSON-RPC, no columnar streaming) |
| **Dynamic Workers (Worker Loader)** | V8 isolate, loaded at runtime, parent controls bindings and outbound | 1,000 unique workers/month included, then **$0.002 per unique worker per day**; normal request/CPU rates; billing since 2026-05-26 [V] | **Recommended for tenant code.** Open beta since 2026-03-24, Paid plan only, JavaScript only [V]. Use a stable ID per (tenant, adapter, code hash) to avoid re-creation charges [V] |
| **Workers for Platforms** dispatch namespace | Separate Worker scripts in an untrusted-mode namespace; outbound Worker; custom CPU/subrequest limits | **$25/month base**, 1,000 scripts included then $0.02/script; one request billed across dispatch + user + outbound Workers [V] | Mature and GA; better when adapters are long-lived deployed artefacts with their own versions and logs. Costs the minimum-cost goal $25/month |
| Containers / Sandbox | microVM | per-second compute | Only for non-JS adapters (e.g. a JDBC driver). Avoid |

Sandbox configuration for tenant code (Dynamic Workers or WfP), applying the capability model:

- **No ambient authority.** The loaded Worker gets *no* viz bindings except a narrow RPC stub (`env.HOST`) exposing `emit(batch)`, `getSecret(name)` (scoped to that adapter instance), `log()`. It never receives R2, DO namespaces, KV or other tenants' stubs.
- **All egress through an outbound Worker / `globalOutbound`** that enforces a per-adapter host allow-list declared in the adapter manifest and approved by a tenant admin, blocks viz's own hostnames and private ranges, injects credentials (so the adapter code never holds raw secrets where avoidable), and meters bytes.
- **Hard limits** per invocation (CPU ms, subrequests, response size); kill and mark unhealthy on breach; circuit-break after N consecutive failures.
- **Provenance**: adapter code is content-addressed (hash in the worker ID), stored in R2, and every load is audit-logged with the approving principal.
- **Query-path adapters run with a deadline** and their failure degrades to a partial result with a warning, never a hung query.

**Supply-chain caution**: adapter manifests, READMEs and code are untrusted input. Nothing in an adapter's own metadata should be able to widen its permissions; the host allow-list and scopes come only from an explicit admin action.

---

## 5. Durability and buffering

### 5.1 What "ack" must mean

Agents (Collector, Prometheus, Alloy) keep data in a bounded in-memory or WAL queue and drop it once the receiver returns success. So **a 2xx is a promise that the data survives any single failure on viz's side**. Three honest ways to keep that promise on Cloudflare, and one dishonest one:

| Pattern | Ack point | Honest? |
|---|---|---|
| Ack after DO SQLite commit | Storage write confirmed (output gate) | Yes |
| Ack after `stream.send()` resolves (Pipelines) | "records are confirmed as ingested" [V] | Yes, for records that pass schema validation |
| Ack after R2 PUT | Object durable | Yes |
| Ack after `queue.send()` | Message persisted | Yes |
| Ack then `ctx.waitUntil(write)` | Before durability | **No** — data loss on isolate eviction; do not do this |

### 5.2 Options compared

Assumptions for the cost column [E]: 1 GB = uncompressed telemetry bytes as decoded from the wire; rates from §1.1; ignoring included allowances; "typical" = 1 MB uncompressed per request (≈1,024 requests/GB), "chatty" = 64 KB per request (≈16,400 requests/GB).

| Option | Ack latency (expected) | Buffering cost per GB | Ordering / dedup | Hard limits | Fit |
|---|---|---|---|---|---|
| **A. DO SQLite WAL buffer** (per tenant-shard) | few ms to tens of ms (storage confirm + one intra-colo/region hop) [T] | Typical: DO requests $0.00015 + rows (2/request) $0.002 ≈ **$0.002**. Chatty: $0.0025 + $0.033 ≈ $0.035, or ≈ $0.005 with group commit | Single-writer ⇒ total order per shard; dedup via UNIQUE key | ~1,000 req/s per DO; 10 GB; 8 MB rows; single-threaded CPU | **Primary** |
| **B. Queues** | tens of ms | 3 ops per 64 KB chunk: 16,384 × 3 × $0.40/M ≈ **$0.020** raw; ≈ $0.003 if payloads are compressed ~7× first | At-least-once, unordered; consumer must dedup | 128 KB messages; 5,000 msg/s per queue; 25 GB backlog | Good as a *secondary* path (overflow, async fan-out to sinks), awkward as primary because of the 128 KB message cap |
| **C. Basin Pipelines stream** | unspecified; `send()` resolves on confirmation | Ingress free; sink **$0.06/GB** + transform **$0.04/GB** on uncompressed *JSON* bytes (JSON is plausibly 2–4× the protobuf size) ⇒ **≈ $0.12–0.40 per protobuf-GB** | Exactly-once to sink [V] | 20 streams/account; 5 MB/request; no custom partitioning; invalid rows silently dropped; 60 s minimum roll | "Easy mode" / internal usage tables; not the multi-tenant data plane |
| **D. Direct R2 object per request** (stateless "diskless") | R2 PUT latency, ~50–200 ms [T] | One Class A per request: typical **$0.0046**, chatty **$0.074**; plus later LIST/GET/compaction of many tiny objects | Idempotent if key = content hash; no ordering | None relevant | Simple and stateless; cost collapses with small requests; produces a small-file problem |
| **E. DO as batching agent, ack after R2 flush** (WarpStream style) | flush interval, 250 ms–1 s | No SQLite rows. R2 PUTs: one per flush per active shard ⇒ at 1 flush/s ≈ 2.6 M PUTs/month ≈ **$11.7 per continuously-active shard-month**, independent of volume | Per-shard order | In-flight requests held open; DO memory 128 MB bounds batch | Attractive at very high per-shard throughput; wasteful for many small tenants |

Notes:

- **WarpStream's lesson** [T]: agents are stateless, batch all producers' data for ~250 ms into one object, and acknowledge only after the object-store PUT and a metadata commit; latency is traded for zero local disks. Option E is the literal port; option A is the Cloudflare-idiomatic variant, because a Durable Object *already is* a small replicated disk with a single writer, so the ack does not have to wait for object storage.
- **DO durability model** [T]: SQLite-backed DOs persist the WAL to several storage followers and hold the response behind an *output gate* until the write is confirmed, so "await the write, then return" yields ack-after-durable without extra code. This is the property the whole design leans on; it should be re-read in current docs during design (see Open questions).
- **Rows-written is the cost driver of option A, not bytes.** One 1 MB BLOB row costs the same $1/M as a 100-byte row. So: store each accepted request (or each coalesced group of requests) as **one BLOB row**; avoid secondary indexes on the WAL table (each index entry is another row write); keep dedup keys in the same row (primary key) rather than a side table.
- **Group commit** for chatty senders: the DO coalesces requests arriving within ~20–50 ms into one row and acknowledges all of them when that single write confirms. Cuts row writes ~10× at a small latency cost.
- **DO duration** [E]: a shard active 100% of the month costs 0.128 GB × 2.63 M s ≈ 337 k GB-s ≈ $4.2 (the first one is inside the 400 k included). A shard moving 2 MB/s handles ~5 TB/month, so duration adds < $0.001/GB at load and **zero for idle tenants** — this is what makes per-tenant DOs compatible with "low minimum cost".

### 5.3 Flush path (buffer → Parquet → Iceberg)

1. **Flush trigger** (alarm in the buffer DO): size ≥ 32–64 MB decoded, or age ≥ T (30–60 s for interactive tiers; several minutes for tiny/free tenants to avoid micro-files), or memory pressure.
2. **Encode** the WAL rows for one (tenant, signal, day) into a Parquet file (WASM encoder; sort by series/stream key then timestamp; zstd).
3. **PUT to R2 at a deterministic key**: `data/{signal}/tenant={id}/day={d}/{shard}-{first_seq}-{last_seq}.parquet`. A retried flush overwrites the same key with identical content — idempotent.
4. **Announce** `{key, tenant, signal, partition, row_count, bytes, column stats, seq range}` to the **committer DO** (one per table per cell) by RPC; the committer persists the announcement in its own SQLite.
5. **Commit**: the committer batches all announcements for ≤ 30–60 s into **one Iceberg append** (write manifest, manifest list, then REST `commit`), recording the highest committed `(shard, seq)` watermarks in the snapshot summary. Single writer per table ⇒ no optimistic-concurrency retries among viz's own writers; it still must handle conflicts with catalog-managed compaction (retry on 409 with refreshed metadata).
6. **Truncate**: the buffer DO deletes WAL rows ≤ committed watermark only after the committer confirms. Until then the rows stay queryable.
7. **Hot read path**: queries for the most recent minutes fan out to the buffer DOs of the tenant (exactly the role of ingesters in Cortex/Mimir/Loki), so freshness does not depend on flush cadence.

Why a committer DO instead of each buffer committing itself: catalog operations cost $9/M and concurrent committers conflict. One commit per table per minute is ~43,800 commits/month; at 1–2 catalog operations per commit that is ≈ $0.4–0.8 per table-month — and it fits inside the 1 M included operations for a handful of shared tables [E].

### 5.4 Why not Pipelines as the primary path — and where it does fit

Against (all [V] unless noted): account-level cap of 20 streams/sinks/pipelines; no custom partitioning yet; sink cannot attach to an existing table; "Invalid events will be accepted but dropped" (viz would have to validate perfectly up-front and reconcile via dropped-event metrics); JSON-only input (viz would decode protobuf, re-encode JSON, and pay per uncompressed JSON byte); 5 MB per request; 60 s minimum roll; pipeline SQL not yet updatable; no tenant-pure files, hence no metadata-only retention or erase. Cost 10–40× the DIY path [E].

For: zero code for buffering, Parquet encoding and commits; exactly-once sink; free ingress; maintained by Cloudflare; throughput to 1–3 GB/s per stream.

Where it fits in viz:

- **Bootstrap / MVP**: a single-tenant or internal deployment can run entirely on Pipelines to validate schemas and the query layer before the DIY writer exists.
- **Low-volume internal tables**: audit log, usage/metering events, adapter run history — volumes comfortably inside the 50 GB/month included tier.
- **Logpush**: Cloudflare Logpush → Pipelines → Iceberg is a native path at $0.03/GB + sink cost, for viz's *own* zone logs.
- Re-evaluate when custom partitioning and updatable SQL ship.

### 5.5 Exactly-once / dedup

No push protocol here carries an idempotency key (OTLP: none; PRW: "senders MAY retry with the same request", receiver MUST be idempotent [V]). Build effectively-once from three idempotent hops:

| Hop | Duplicate source | Mechanism |
|---|---|---|
| Client → buffer DO | Lost ack, client retry; Worker→DO retry | **Request fingerprint** = hash(tenant, signal, body bytes) — computed over the *compressed* body so it is nearly free. `INSERT … ON CONFLICT DO NOTHING` on the fingerprint as primary key, retained for a window (10–15 min, longer than client max backoff). Retries of the same payload are absorbed; honour an optional `Idempotency-Key`/`X-Viz-Batch-Id` header for clients that can send one |
| Buffer DO → R2 | Flush retried after crash | Deterministic object key from `(shard, seq range)`; overwrite is harmless |
| R2 → Iceberg | Commit retried after timeout (did it land?) | Committer stores per-shard committed watermark in snapshot summary properties (the technique Flink's Iceberg sink uses with its checkpoint ID [T]); on restart it reads the latest snapshot and skips already-committed files |
| Query time (metrics) | Same (series, timestamp) from HA Prometheus pairs or replays | Last-write-wins on `(series_id, ts)`; optional HA-pair dedup on `cluster`/`__replica__` labels à la Cortex/Mimir [T] |

Caveat: fingerprint dedup only catches byte-identical retries. A collector that re-batches before retrying produces different bytes; the metric path is protected by (series, ts) semantics, logs and spans by an optional content-derived row ID at compaction time (span: `trace_id+span_id`; logs: hash(stream, ts, body)). Decide per signal whether that is worth the compaction cost — see Open questions.

### 5.6 Backpressure and load shedding

Layered, cheapest first; each layer names its response:

1. **Edge Worker, before reading the body**: auth, `Content-Length` cap (413), tenant suspended (403), coarse per-key rate check with the Rate Limiting binding. The binding is per-location and approximate, 10 s or 60 s periods only [V] — good as a shield, not as the quota of record.
2. **Edge Worker, while streaming**: decompressed-size cap; abort early.
3. **Tenant buffer DO — the quota of record.** All of a tenant's traffic for a signal passes through its DO shard(s), so token buckets (bytes/s, samples/s, spans/s, lines/s), daily byte quotas and active-series counts are exact per shard and need no distributed coordination (multi-shard tenants split limits by shard count, as Mimir divides global limits across ingesters [T]). Over rate → 429 + `Retry-After`; over hard quota → protocol-appropriate rejection.
4. **Buffer depth**: if WAL bytes exceed a threshold (flush or commit is behind), the DO first lengthens `Retry-After` (503), then sheds by priority (debug logs before metrics; configurable), and above a hard ceiling rejects all writes for that shard. The 10 GB SQLite cap is the last backstop; the configured ceiling should sit far below it (e.g. 1–2 GB).
5. **DO overload** (the ~1,000 req/s soft limit [V]): the Worker treats the overloaded error as 503 + jittered `Retry-After` and reports it; sustained overload triggers a shard split for that tenant.

Always send `Retry-After`; both OTLP and PRW clients honour it [V].

### 5.7 Limits, validation, transforms at the edge

Typical limits in Mimir/Loki (names and defaults from memory — [T], verify before copying): ingestion rate and burst (samples/s), max global active series per tenant and per metric name, max label names per series (~30), max label name length (~1,024) and value length (~2,048), max exemplars, out-of-order window, "sample too old/too far in future" windows; Loki: ingestion rate MB/s and burst, max streams per tenant, max line size (~256 KB), max label names per stream (~15), per-stream rate limit, reject-old-samples age.

For viz:

- **Limit catalogue** per tenant per signal, with plan defaults and overrides, held in the tenant config DO and cached in buffer DOs: bytes/s, items/s, bytes/day, active series, max attributes per item, max attribute key/value length, max body size, max timestamp skew (past/future), retention.
- **Active-series / cardinality limiting**: exact set of 64-bit series hashes per shard up to the limit (a 1 M-series tenant needs 8 MB — fits in DO memory and can be persisted as a periodic BLOB snapshot, not row-per-series), plus HyperLogLog sketches per metric name and per label for *cardinality analysis* surfaced to the tenant. New series beyond the limit are rejected with a specific reason; existing series keep flowing (Mimir behaviour [T]).
- **Validation in the decode pass**: names/units, UTF-8, timestamps in window, histogram bucket sanity, trace/span ID lengths.
- **Relabel / transform**: a small declarative rule set (Prometheus `relabel_config` semantics for metrics; attribute keep/drop/rename/hash for all signals) compiled per tenant and executed in the same WASM pass. Resist embedding a general language (OTTL, VRL) at the edge initially; tenants needing arbitrary transforms can run a Collector, or use a tenant-code adapter (§4.4).
- **PII scrubbing**: built-in detectors (emails, card numbers with Luhn check, bearer tokens/JWTs, IPs) plus tenant regexes with a **CPU budget per request** — regex over every log body is the one place where CPU per MB can genuinely explode; use a linear-time engine (Rust `regex` in WASM) and never tenant-supplied backtracking patterns.
- **Sampling**:
  - *Head sampling* is stateless and belongs in the edge Worker: deterministic by trace ID threshold (the W3C/OTel consistent-probability scheme with `ot=th:` in `tracestate` [T]) so that sampled traces stay complete and adjusted counts remain correct.
  - *Tail sampling* needs all spans of a trace in one place for a decision window. On Cloudflare that means routing by `hash(trace_id)` to a DO and holding spans 10–30 s — doable, but it multiplies DO traffic and state. **Better fit for viz: "tail sampling at compaction"** — ingest everything into a short-retention raw tier, and let the compactor decide which traces graduate to long retention (errors, slow, rare routes, a baseline %). Decisions are made with the whole trace on disk, cost is batch CPU, and it unifies with retention tiering (§9).
  - *Log sampling/dedup*: per-stream rate caps and "drop repeated identical lines" are cheap and stateful only within the buffer DO.

---

## 6. Authentication and authorization

### 6.1 Machine credentials (ingest and API)

**Key format** (GitHub/Stripe style [T]): `viz_<kind>_<keyId>_<secret><checksum>`

- `kind`: `ing` (ingest-only), `qry` (read), `adm` (management), `agt` (agent/MCP personal token) — lets the edge reject wrong-plane usage before any lookup and makes leaked-key triage easier.
- `keyId`: ~12 chars, public, the lookup handle and the thing shown in UIs and audit logs.
- `secret`: ≥ 160 bits of CSPRNG entropy, base62. `checksum`: CRC32 suffix so secret scanners (GitHub secret scanning partner programme, gitleaks) can validate offline and cheaply reject typos at the edge.
- **Store only `SHA-256(secret)`** (optionally HMAC with a server pepper). Slow password hashes (bcrypt/argon2) are unnecessary for high-entropy random secrets and would burn edge CPU on every request.
- Record: `{key_id, tenant_id, hash, scopes, signals, label_policy, limits_override, ip_allow, created_by, expires_at, revoked_at, last_used_bucket}`.

**Verification at the edge**:

1. Parse key from `Authorization: Bearer`, or HTTP Basic (`username = tenant or instance id`, `password = key` — what Prometheus `remote_write`, Grafana Agent/Alloy and Loki clients expect), or a protocol-specific header (`DD-API-KEY`, `X-Amz-Firehose-Access-Key`, Logpush custom header).
2. Verify checksum (rejects garbage with zero I/O).
3. Look up by `keyId`: **in-isolate LRU cache (30–60 s TTL, including negative entries) → KV → source of truth** (tenant control DO / D1).
4. Constant-time compare of hashes.

Cost and consistency [E]: an uncached KV read per request would cost $0.50/M — on a chatty workload up to ~$0.008/GB, comparable to the whole rest of the path — hence the in-isolate cache. KV is eventually consistent (changes propagate in up to ~60 s [T]), so **revocation takes up to cache TTL + KV propagation ≈ 1–2 minutes** unless the edge consults the tenant's buffer DO, which already sits in the write path and can hold a revoked-key set for *immediate* revocation at no extra hop. Recommended: edge cache for the happy path, authoritative revocation check in the DO.

Alternative considered: **stateless signed tokens** (JWT/PASETO, Ed25519 via WebCrypto) embedding tenant, scopes and limits — zero lookups, but revocation needs a deny-list anyway and limits become stale. Good for *short-lived* credentials (browser sessions, agent tokens, federated workload identity); not for long-lived agent keys.

**Rotation**: multiple active keys per tenant; create-new → deploy → revoke-old; optional expiry with pre-expiry notifications; `last_used` tracked at coarse granularity (hour bucket, written at most once per bucket per key) so write costs stay negligible.

**Workload identity (keyless)**: accept OIDC JWTs from trusted issuers per tenant (GitHub Actions, Kubernetes service-account issuers, cloud IAM) verified against cached JWKS, mapped to scopes by claim rules. Removes long-lived secrets from CI and clusters; high value for SOC 2-minded customers.

**mTLS for agents**: Cloudflare terminates TLS; with API Shield mTLS the Worker reads `request.cf.tlsClientAuth` (verification status, cert fingerprint, subject DN) [T]. Offer it as an *additional* factor bound to a key (`cnf`-style: key valid only with certificate fingerprint X) for enterprise tenants. Bring-your-own-CA availability by plan is unverified.

### 6.2 Humans (UI) and SSO

| Option | Pros | Cons |
|---|---|---|
| **Cloudflare Access** in front of the app | Zero code; SAML/OIDC IdPs; device posture; free tier for small teams [T] | Designed for *one organisation's* workforce. Per-customer IdP mapping (customer A → Okta A, customer B → Entra B) is awkward; ties customers' identities into viz's Zero Trust org. Fine for viz's own admin/back-office plane |
| **Managed auth vendor** (WorkOS, Clerk, Auth0, Stytch) | Enterprise SSO/SCIM per customer organisation out of the box; audit trails; quick | External dependency contradicts "purely Cloudflare"; per-connection pricing; another sub-processor |
| **Self-contained OAuth/OIDC on Workers** | Pure Cloudflare; `workers-oauth-provider` gives an OAuth 2.1 authorization server with PKCE, token exchange, hashed tokens in KV, encrypted props [V]; upstream identity via generic OIDC federation (Google, GitHub, Entra, Okta) | viz owns the security surface: session management, account recovery, SAML (non-trivial; a SAML library on Workers needs care with XML signature validation), SCIM |

Recommendation: **self-contained, OIDC-first**. viz is an OAuth 2.1 *authorization server* for its own API/UI/MCP (via `workers-oauth-provider`) and an OIDC *relying party* to upstream IdPs; per-tenant "bring your own OIDC issuer" covers most enterprise SSO today. Defer SAML and SCIM to an enterprise tier, where plugging in a vendor behind the same interface is an acceptable, optional dependency. Use Cloudflare Access for viz's operator plane.

### 6.3 Agents and MCP

- The MCP authorization spec's **2026-07-28 revision deprecates Dynamic Client Registration**: "New implementations should use Client ID Metadata Documents instead"; DCR remains for backwards compatibility. Client priority: pre-registered → CIMD → DCR (deprecated) → prompt the user. The 2025-11-25 revision had already made CIMD a SHOULD. (Search-result summary of the spec page; consistent across several sources.)
- With **CIMD**, `client_id` is an HTTPS URL serving the client's metadata JSON; the authorization server fetches, validates and caches it and advertises `client_id_metadata_document_supported`. The fetch is an SSRF surface — `workers-oauth-provider` requires the `global_fetch_strictly_public` flag for it [V].
- `@cloudflare/workers-oauth-provider` supports PKCE, DCR **and** CIMD, token exchange, RFC 8414 (AS metadata), RFC 9728 (protected-resource metadata), RFC 8707 (resource indicators), RFC 7591; tokens and codes stored only as hashes in KV; `props` encrypted; recommended split of authorization server and resource server joined by a service binding [V].
- **Design for viz**: the MCP endpoint is a resource server. Tokens are audience-bound (RFC 8707) to it; scopes are fine-grained (`metrics:read`, `logs:read`, `traces:read`, `dashboards:write`, `monitors:write`, `ingest:write`, `admin`); an agent's token carries *the delegating user's* tenant and label policy, intersected with the granted scopes — an agent can never see more than its user. Consent screens show the client's verified metadata URL. Long-running headless agents get `agt` personal access tokens or OAuth client-credentials with a service-account principal.
- **Agent safety**: telemetry content is untrusted input to an LLM (log lines can contain prompt injection). Read-only scopes by default; write scopes (dashboards, monitors, adapter config) granted explicitly; every agent action audit-logged with the client ID and delegating user.

### 6.4 Authorization models

Prior art [T]:

- **Grafana**: basic org roles (Viewer/Editor/Admin) + fine-grained RBAC of *action × scope* (`datasources:query` on `datasources:uid:x`), teams, folder permissions; Grafana Cloud **access policies** = scopes + optional **label selectors** (LBAC) restricting which series/streams a token can read; data-source-level LBAC per team for Loki, and later Mimir. Multiple selectors are OR-ed; each is injected into every query.
- **Datadog**: custom roles composed of permissions; **restriction queries** for logs (a role sees only logs matching a query); Data Access Controls generalising that to other telemetry; teams as ownership scopes.
- **prom-label-proxy / Mimir / Loki**: enforce a label matcher by rewriting every selector in the query AST.

For viz — **RBAC for actions, ABAC (label policy) for data, enforced in one place each**:

- *Principals*: user, service account, API key, OAuth client acting for a user.
- *Roles* (bundles of `action` on `resource-type`), bound at org → tenant (environment/project) → folder level. Ship four built-ins (owner, admin, editor, viewer) plus custom roles later.
- *Data policy* per binding: `{signals, label_matchers[], max_range, max_lookback}`. Matchers use PromQL matcher syntax over resource attributes (`service.namespace="payments"`, `env=~"prod|stage"`).
- **Enforcement**: the query planner *injects* the matchers into every selector (PromQL vector selectors, TraceQL span-sets, log stream selectors) and into the partition/row filter of the scan; adapters receive the already-restricted matchers. Enforce at the AST level, never by string concatenation. Label-values/metadata endpoints must apply the same policy or they leak names.
- **Write-side LBAC**: an ingest key can be restricted to stamping/requiring certain labels (e.g. `team="a"` forcibly set), which is what makes read-side LBAC trustworthy.
- **Tenant boundary is not LBAC.** `tenant_id` comes from the credential, is set by the platform, and is a partition predicate that no user-supplied query or label can override.

### 6.5 Audit, encryption, residency, SOC 2

- **Audit log**: append-only events `{ts, tenant, actor, actor_type, client, action, resource, before/after hash, ip, request_id, outcome}` for auth events, key lifecycle, config/limit/retention changes, role bindings, adapter approval and loads, data deletion, cross-tenant operator access ("break-glass", with reason), and optionally query audit. Store in a tenant-partitioned Iceberg table with its own retention (≥ 1 year), exportable to the tenant; the infrastructure plane is covered by Cloudflare's own account audit logs.
- **Encryption**: R2 encrypts at rest by default (AES-256-GCM, Cloudflare-managed keys) and in transit [T]. **Per-tenant keys**: R2 supports SSE-C (customer-provided keys per request) [T]; tenant-pure objects make "one data key per tenant, wrapped by a tenant master key" possible, enabling crypto-shredding on deletion. **Conflict**: managed compaction and Basin SQL cannot read SSE-C objects (they do not hold the key) [E, unverified], so per-tenant encryption implies viz runs its own compaction and query for those tenants. Parquet modular encryption has the same trade-off. Offer as an enterprise "silo" feature, not the default.
- **Secrets** (adapter credentials, scrape credentials, upstream IdP secrets): envelope-encrypt per tenant; store ciphertext in the tenant config DO; master key in Workers Secrets / Secrets Store; decrypt only inside the adapter egress path.
- **Data residency**: R2 jurisdictions are `eu`, `us`, `fedramp`; fixed at bucket creation; Workers bindings need a `jurisdiction` field; jurisdictional S3 endpoints are separate; Logpush cannot target jurisdiction buckets [V]. Durable Objects support jurisdiction-restricted namespaces (`eu`, `fedramp`) [T]. **Basin Catalog jurisdiction support is on the roadmap, not shipped** [V] — so an EU-resident *Iceberg catalog* is not available from Cloudflare today, though EU-resident data files and buffers are. Edge Workers still terminate TLS and decode at the nearest PoP globally unless Regional Services / the Data Localization Suite is used (enterprise add-on [T]). Be precise in marketing: "stored in the EU" is achievable now; "processed only in the EU" needs DLS.
- **SOC 2-relevant controls the architecture should make easy** (Security, Availability, Confidentiality criteria): unique identities and SSO/MFA for operators; least-privilege scoped tokens for CI/deploy; no standing operator access to tenant data (break-glass with audit); key rotation and expiry; encryption in transit/at rest; tenant isolation tests in CI (attempted cross-tenant reads must fail); change management through reviewed IaC; audit log immutability and retention; backup/restore evidence (Iceberg snapshots + R2 bucket-level protections); documented deletion procedure with verifiable completion (§8.5); monitoring/alerting on the ingest SLO; sub-processor list (just Cloudflare, if the design stays pure — a selling point).

---

## 7. Tenancy isolation

### 7.1 Storage layout options

| Model | Isolation | Catalog/commit cost | Small-tenant efficiency | Erase/retention | Verdict |
|---|---|---|---|---|---|
| **Shared tables, partitioned by tenant** | Logical (partition predicate + path prefix) | A few tables: one commit stream each | Excellent | Metadata-only **if files are tenant-pure** | **Default ("pool")** |
| Table per tenant (shared namespace/bucket) | Stronger (separate metadata) | ~$0.4–0.8 per table-month at 1 commit/min, ×signals ×tenants [E]; maintenance jobs per table | Poor (idle tables still need maintenance decisions) | `DROP TABLE` + purge | Only for large tenants |
| Namespace per tenant | As above + naming | Same | Poor | Drop namespace | Organisational nicety on top of the previous row |
| **Bucket + catalog per tenant** | Strongest: separate credentials, jurisdiction, lifecycle, optional BYO bucket | Same per-table costs; buckets are free up to 100,000 per account [V] | Poor | Delete bucket | **"Silo" tier**: regulated, EU-resident, very large, or BYO-storage tenants |

Additional arguments for pooling: Basin Catalog has **no namespace/table-granular authorization yet** [V], so table-per-tenant buys no extra *access* isolation from the catalog today — the enforcing boundary is viz's own query layer either way. And cross-tenant operator analytics (fleet health, billing) are single-table scans.

**Tenant-pure files** are the key refinement. Because each tenant has its own buffer DO, every flushed Parquet file contains exactly one tenant. With `identity(tenant_id)` as a partition field, Iceberg compaction (which never merges across partitions) preserves that. Consequences:

- Retention and tenant erase become **file drops** — no rewrite, no delete files, no read-time merge cost.
- Per-tenant storage metering is an exact sum over manifest entries, no scan.
- Per-tenant encryption keys become possible.
- A tenant can be **moved** between pool and silo, or between cells, by re-registering files — no data rewrite.
- The price: tiny tenants produce tiny files. Mitigate with longer flush intervals for low-volume tenants, and optionally a `pool-NN` pseudo-partition (hash-bucketed long tail of free-tier tenants) where files are *not* tenant-pure and erase falls back to row-level deletes. Start without the long-tail pool; add it only if file counts hurt.

Suggested partition spec per signal table: `identity(tenant_id), day(timestamp)` (add `hour` only for very large tenants via partition evolution). Whether viz's own writer can use partition specs that Basin's managed compaction and Basin SQL handle well is a question for the storage research note; the specs themselves are standard Iceberg.

### 7.2 Compute isolation and noisy neighbours

Durable Objects give something Cortex/Mimir had to engineer: **a per-tenant single-threaded unit that costs nothing while idle**.

| Resource | Isolation mechanism |
|---|---|
| Edge Worker CPU | Stateless and horizontally elastic; per-request CPU cap; body-size caps. A tenant cannot starve others, only run up viz's bill — bounded by rate limits |
| Ingest buffering | **Per-tenant buffer DOs** `buf:{cell}:{tenant}:{signal}:{shard}`. A flood from tenant A queues in A's DO and returns 429/503 to A only |
| Large tenants | k shards per (tenant, signal), chosen by hashing the *series/stream/trace key* so related data stays together; k grows by split (double and rehash new writes; old shards drain) |
| Commit path | Shared committer per table per cell — the one shared choke point. Protect with per-tenant fairness on the announcement queue and a cap on files per tenant per commit |
| Catalog | Shared; commit cadence is controlled by viz, not by tenants |
| Query | Per-tenant concurrency and scanned-bytes budgets (the query research note's territory); adapters have deadlines |
| Scrape and adapters | Per-tenant DOs with budgets; outbound concurrency caps |

**Shuffle sharding** (Cortex/Mimir [T]): each tenant is assigned a pseudo-random subset of *k* of *N* instances so that two tenants rarely share all their instances, shrinking the blast radius of a poison tenant from 100% to a small fraction. With per-tenant DOs, the ingest path is already "shard size 1, never shared" — strictly better. Shuffle sharding becomes relevant again only for **pooled resources**: the committer DOs, query-executor pools, and compaction workers. If those are ever partitioned (several committers per table), assign tenants to them by shuffle shard.

**Cell-based architecture**: a *cell* = one set of {DO namespaces, R2 bucket(s), catalog, committer set, KV namespace}, ideally one Cloudflare account per cell at large scale because several limits are per account (Pipelines' 20 streams, Queues' per-queue throughput, catalog maintenance quotas, the 250 cron triggers). A thin global router maps `tenant → cell` (cached at the edge from KV). Reasons to have more than one cell: jurisdiction (EU cell with `eu` R2 bucket and `eu` DO namespace), blast-radius containment, safe rollout (deploy cell by cell), and enterprise single-tenant cells. Start with one cell but put the `cell` component in every DO name and object key from day one — retrofitting it is painful.

### 7.3 Tenant hierarchy, federation, metering, lifecycle

- **Hierarchy**: `organization` (billing, SSO, users) → `tenant` (the isolation and retention unit; think environment or project) → streams/services. Keys and data policies bind at tenant level; roles can bind at org level and inherit.
- **Cross-tenant queries** (Mimir tenant federation [T]: `X-Scope-OrgID: a|b`, results labelled `__tenant_id__`): in viz, a principal whose bindings cover several tenants of the same org can list them in the query context; the planner unions their partitions and exposes a reserved `__tenant__` label. Never across organisations; never across cells in v1 (a cross-cell query is a federated query through the adapter interface, which is a neat reuse).
- **Metering** (what to count, where it is exact and cheap):
  - *Ingest*: bytes (uncompressed, post-validation), samples/data points, spans, log records — counted in the buffer DO, emitted as usage events at each flush. Because a flush is idempotent by seq range, usage events are too (key = shard + seq range).
  - *Active series*: per-shard exact set / HLL, sampled every N minutes; billing metric = p95 or mean over the month (Grafana Cloud bills on p95 active series [T]).
  - *Storage*: GB-months from Iceberg manifest file sizes per tenant partition — exact thanks to tenant-pure files; computed at commit time, no scan.
  - *Query*: bytes scanned and CPU per tenant from the query layer.
  - *Rejections*: discarded items by reason — essential for support and for tenants' own trust.
  - Sink: a `usage_events` Iceberg table (a good Pipelines use, well within the free 50 GB) and/or Workers Analytics Engine for cheap near-real-time dashboards.
- **Cost attribution**: with the per-GB costs in §10 and tenant-pure storage, COGS per tenant ≈ ingest GB × marginal ingest cost + stored GB-months × $0.015 + compaction GB × $0.005 + query scanned GB × rate. Tag flush/compaction/commit work with tenant IDs so the shared remainder (committer, catalog ops) can be apportioned by file count.
- **Lifecycle**: `active → suspended` (ingest returns 403/429, queries allowed) `→ pending_deletion` (grace period, e.g. 7–30 days; everything blocked; reversible) `→ deleted` (data erased, §8.5; keys and config purged; a tombstone with the deletion certificate retained in the audit log).

---

## 8. Retention and deletion

### 8.1 Policy model

`retention(tenant, signal, selector?) → {raw_days, rollup tiers…}` with precedence stream-selector > signal > tenant > plan default, bounded by plan maximum. Examples: metrics raw 30 d → 5 m rollup 13 months; logs 14 d except `{level="debug"}` 3 d and `{audit="true"}` 400 d; traces raw 3 d → "interesting" 30 d.

Loki's model [T] — a global period plus per-stream overrides by selector with priorities, applied by the compactor — is the closest prior art and maps directly.

### 8.2 Mechanics on Iceberg + R2

| Granularity | Mechanism | Cost |
|---|---|---|
| Per tenant, per signal | Drop whole data files of partitions `(tenant, day < cutoff)` via an Iceberg delete/overwrite commit that removes manifest entries | Metadata-only; one commit per table per day covers *all* tenants |
| Per stream selector (shorter than tenant default) | Route such streams to a **retention class** at ingest (`retention_class` column and partition field, or separate files per class), so they again expire by file drop | Metadata-only, at the price of more files. Preferred |
| Per stream selector (retroactive/arbitrary) | Row-level delete: rewrite affected files (copy-on-write) or write position/equality delete files (merge-on-read) | Rewrite I/O; whether Basin's compaction and Basin SQL honour delete files is **unverified** — do it copy-on-write with viz's own compactor |
| Physical removal | **Snapshot expiration**: files leave R2 only when no retained snapshot references them. Basin Catalog defaults: older-than 30 days *and* not among the last 5; configurable per catalog or table; free of charge [V] | Set to something like 1–3 days / 20–50 snapshots for telemetry tables: with a commit per minute, "last 5" is five minutes, so the age threshold is what governs |
| Orphans | Files written to R2 but never committed (crashed flush). Basin's maintenance explicitly does **not** clean files never referenced by a snapshot [V] | viz needs its own orphan sweeper: list `data/` prefixes older than N hours and diff against the manifests (or track every PUT in the committer's SQLite and delete unreferenced ones — cheaper than listing) |

**R2 lifecycle rules** [T for rule semantics]:

- Do **not** point an expiration rule at Iceberg `data/` or `metadata/` prefixes as the retention mechanism: R2 would delete files that live snapshots still reference and corrupt the table. Acceptable only as a *backstop* with an age far beyond the maximum retention plus snapshot age.
- Do use lifecycle rules for: aborting incomplete multipart uploads; expiring staging/WAL-spill prefixes; expiring query-result caches and export files; **transitioning old partitions to Infrequent Access** — keys do not change, so Iceberg is unaffected.
- IA economics [V]: $0.010 vs $0.015 per GB-month, 30-day minimum, $0.01/GB retrieval, pricier operations. It only pays for data that is rarely scanned: one full read per month wipes out the saving. Sensible for logs/traces older than ~30 days and for compliance archives; not for metric rollups that dashboards hit.

### 8.3 Tiering raw → downsampled

- **Metrics**: compactor-driven rollups into separate tables (`metrics_5m`, `metrics_1h`) holding per-series, per-window `min/max/sum/count/last` (+ merged histograms/sketches), each with its own retention; the query planner picks the coarsest tier satisfying `step` (Thanos/Mimir/VictoriaMetrics practice [T]). Rollup correctness for counters needs reset-aware aggregation — a query-layer concern, noted here because retention promises depend on it.
- **Logs**: no downsampling; tier by retention class and storage class; optionally keep pattern/volume aggregates (counts per stream per minute) long-term as metrics.
- **Traces**: "tail sampling at compaction" (§5.7) — raw tier short, curated tier long; plus span-derived RED metrics kept as metrics.
- Tier transitions run in the compactor as idempotent jobs keyed by (table, tenant, day, tier); use Workflows for the orchestration (retries, resumability).

### 8.4 Retention reductions and increases

- Increase: only future expirations change; already-expired data is gone — say so in the UI.
- Decrease: takes effect at the next retention run; show the tenant the date at which bytes will actually leave storage (cutoff + snapshot age).

### 8.5 Tenant deletion and GDPR erasure

Procedure (a Workflow, each step idempotent and audit-logged):

1. Mark `pending_deletion`; revoke keys; stop scrapes/adapters; purge edge caches.
2. Flush or discard buffer DOs; `deleteAll()` their storage.
3. For each table: one Iceberg commit removing every file in `tenant_id = X` partitions (tenant-pure ⇒ metadata-only), including rollup, audit (per policy), and usage tables.
4. Force snapshot expiration past that commit (or wait the configured age); verify by listing the tenant's R2 prefixes — expect empty; sweep orphans under the tenant prefix.
5. Delete config, secrets, KV entries, OAuth grants, adapter code objects.
6. Emit a deletion certificate (what was removed, when, verification results) into the operator audit log.

**Erasure SLA** = grace period + time to commit + snapshot-expiration age + sweep. With a 1–3 day snapshot age this fits comfortably within GDPR's one-month window; state the number contractually.

**Data-subject erasure inside a tenant** (delete all telemetry mentioning user U) is a row-level delete by predicate — expensive on columnar immutable storage for every vendor. Offer it as an asynchronous job with copy-on-write rewrites, and steer customers to the cheaper alternatives: PII scrubbing/hashing at ingest, short raw retention, and per-tenant crypto-shredding in the silo tier. Backups/time-travel: expired snapshots are the only "backup", so erasure completes when they expire.

---

## 9. Recommended design for viz

### 9.1 Ingest path

```
agents / SDKs / Prometheus / Cloudflare OTel export / Logpush
        │  HTTPS (OTLP-HTTP, PRW 1/2, Loki, …)
        ▼
[Edge Worker: ingest gateway]            stateless, global
  auth (key cache) → size caps → coarse rate limit → streaming gunzip/snappy
  → WASM decode + validate + relabel/scrub → columnar batch + fingerprint
        │  JS RPC (1 call per request, per (tenant, signal, shard))
        ▼
[Buffer DO  buf:{cell}:{tenant}:{signal}:{shard}]   single-writer, SQLite WAL
  exact quotas / active series → dedup by fingerprint → INSERT blob → ACK
  serves "hot" reads to the query layer
        │  alarm: size ≥ 32–64 MB or age ≥ T
        ▼
  Parquet (zstd, sorted) ──PUT──► R2  data/{signal}/tenant=…/day=…/{shard}-{seq}.parquet
        │  announce(file, stats, seq range)
        ▼
[Committer DO  commit:{cell}:{table}]   one Iceberg append per 30–60 s
        │  REST commit (watermarks in snapshot summary)
        ▼
[Basin Catalog]  ← managed compaction + snapshot expiration
        ▲
[Scrape DOs / adapter DOs] feed the same gateway core (pull = push from inside)
```

Properties:

- **Ack-after-durable**, single hop to durability, ack latency dominated by one DO storage confirmation.
- **Effectively-once** end to end (§5.5).
- **Per-tenant isolation** at the only stateful ingest component, with zero idle cost.
- **Freshness** independent of flush cadence (hot reads from buffer DOs).
- **One code path** for push, pull and adapters.
- Pipelines used only for low-volume internal tables and as an optional MVP shortcut.

### 9.2 Tenancy and auth model

- **Pool by default**: shared Iceberg tables per signal per cell, partitioned by `tenant_id` and day, tenant-pure files; **silo tier** (own bucket + catalog, optional jurisdiction/BYO bucket/per-tenant key) for regulated or very large tenants; **cells** from day one in naming.
- **Org → tenant → stream** hierarchy; tenant is the unit of isolation, limits, retention and billing.
- **Machine auth**: prefixed, checksummed opaque API keys, SHA-256 at rest, scoped by plane and signal, edge-cached with authoritative revocation in the tenant DO; Basic-auth compatibility for Prometheus-ecosystem clients; optional OIDC workload identity and mTLS binding.
- **Human/agent auth**: self-hosted OAuth 2.1 (`workers-oauth-provider`), OIDC federation to customer IdPs, CIMD-first MCP client registration with DCR as deprecated fallback; Cloudflare Access for viz operators.
- **Authorization**: RBAC for actions; label-matcher data policies injected by the query planner; tenant ID always platform-assigned.
- **Retention**: per tenant/signal/retention-class by partition/file drop + short snapshot expiration + own orphan sweeper; rollup tiers for metrics; compaction-time curation for traces; IA transition for cold log/trace partitions.
- **Adapters**: built-in declarative connectors first; remote HTTP/MCP adapters second; tenant code in Dynamic Workers with capability-only bindings and a mediated egress last.

### 9.3 Cost per GB ingested [E]

Unit: 1 GB of *uncompressed* telemetry as decoded from the wire (the wire is typically 5–10× smaller after gzip/snappy; the resulting Parquet is assumed ≈ 0.1 GB — 10:1, plausible for metrics and structured logs, unverified for viz's schemas). Overage rates, no included allowances.

| Component | Typical (1 MB/request; 1,024 req/GB) | Chatty (64 KB/request; 16,384 req/GB) | Basis |
|---|---|---|---|
| Worker requests | $0.0003 | $0.0049 | $0.30/M |
| Worker CPU (assume 60 ms/MB; range 20–300) | $0.0012 (0.0004–0.006) | $0.002–0.008 | $0.02/M CPU-ms |
| DO requests (1 RPC/request) | $0.00015 | $0.0025 | $0.15/M |
| DO rows written (2/request; chatty with 10× group commit) | $0.002 | $0.003 (0.033 without group commit) | $1.00/M |
| DO duration (busy shard ≈ 2 MB/s) | < $0.001 | < $0.001 | $12.50/M GB-s |
| R2 PUTs (data + manifests, ~10/GB) | $0.00005 | $0.00005 | $4.50/M |
| Catalog commits | ≈ $0.4–0.8 per table-month, fixed | same | $9/M ops |
| Managed compaction (0.1 GB) | $0.0005 | $0.0005 | $0.005/GB + $2/M objects |
| **Marginal total** | **≈ $0.005–0.01** | **≈ $0.015–0.03** | |
| Storage, per month retained | $0.0015 | $0.0015 | 0.1 GB × $0.015 |

So: **about one cent per raw GB ingested, plus about 0.15 cents per raw-GB-month retained**, with a realistic envelope of **$0.005–0.03/GB** depending mostly on request size. At 30-day retention, all-in ≈ $0.007–0.03 per GB.

Comparisons:

| Path | $/GB ingested | Note |
|---|---|---|
| viz DIY path (above) | ≈ 0.005–0.03 | [E] |
| Queues as buffer instead of DO | + ≈ 0.003–0.02 | 3 ops per 64 KB chunk [E] |
| Basin Pipelines as the data plane | ≈ 0.12–0.40 | $0.06 sink + $0.04 transform per *JSON* GB, JSON 2–4× protobuf [E]; first 50 GB/month free |
| Cloudflare Observability (their own product) | 0.25 + 0.10/GB-month | [V], from 2026-12-01 |
| Typical SaaS list prices | ~0.10–0.50+ | [T] e.g. Grafana Cloud logs ≈ $0.50/GB, Datadog log ingest ≈ $0.10/GB before indexing |

**Minimum cost**: $5/month (Workers Paid). Included allowances cover a small deployment entirely: 10 M requests, 30 M CPU-ms, 1 M DO requests, 50 M row writes, 400 k GB-s, 10 GB R2, 1 M Class A ops, 1 M catalog operations (≈ 3 tables at one commit per minute fits only if each commit is ≤ ~7 operations; **lengthen the commit interval when idle** — skip empty commits entirely), 10 GB compaction. Avoiding Workers for Platforms saves a fixed $25/month.

Where the estimate is weakest: CPU per MB (unbenchmarked), Parquet compression ratio, the number of catalog operations per commit, and whether DO-to-R2 flush CPU is as cheap as assumed (DOs bill duration, not CPU-ms, which favours doing the Parquet encode in the DO).

### 9.4 Failure-mode analysis

| # | Failure | Effect | Detection | Mitigation / recovery | Data loss? |
|---|---|---|---|---|---|
| 1 | Edge Worker crashes or is evicted mid-request | Client sees error or timeout | Client retry metrics | Client retries; fingerprint dedup absorbs a duplicate if the first attempt had committed | No |
| 2 | Ack lost after DO commit | Client retries same payload | Dedup-hit counter | Fingerprint primary key → no-op, return success | No (no duplicate) |
| 3 | Client re-batches before retry | Different bytes, overlapping content | — | Metrics: (series, ts) last-write-wins; logs/spans: optional row-ID dedup at compaction | Possible duplicates for logs/spans |
| 4 | Buffer DO overloaded (>~1,000 req/s or CPU-bound) | Overloaded errors | DO error rate, queue depth | 503 + jittered Retry-After; auto-split tenant into more shards | No, if client buffers; agent-side drop if its queue overflows |
| 5 | Buffer DO restarts / moves | In-memory state gone (rate buckets, series set, coalescing buffer) | — | WAL rows are durable; rebuild series set from periodic BLOB snapshot + WAL; un-acked coalesced requests fail and are retried by clients | No |
| 6 | Poison payload crashes the decoder | Request fails repeatedly | Exception telemetry by key | Decode in the *edge Worker*, not the DO, so a crash cannot wedge the tenant's DO; 400 after bounded attempts; quarantine sample of body to R2 for debugging (with tenant consent/TTL) | Rejected data only |
| 7 | R2 PUT fails or is slow | Flush stalls; WAL grows | WAL bytes/age gauges | Retry with backoff (idempotent key); beyond threshold → backpressure (§5.6) | No until hard ceiling, then rejects (never silent drops) |
| 8 | Committer DO down or slow | Files written but uncommitted; data visible only via hot path | Commit lag metric | Buffer DOs keep rows until committed watermark advances; committer state is durable; on recovery it commits the backlog in batches | No |
| 9 | Catalog unavailable / commit timeouts | Same as 8 | Catalog error rate | Same; on ambiguous commit, read latest snapshot's watermarks before retrying | No |
| 10 | Commit conflict with managed compaction | 409 on commit | Conflict counter | Refresh metadata and retry (appends rebase trivially) | No |
| 11 | Crash between R2 PUT and announcement | Orphan data file | Orphan sweeper | Flush retried from WAL → same key overwritten → announced | No |
| 12 | Crash between commit and WAL truncate | Rows both in table and WAL | — | Hot-path reads filter by committed watermark; truncate on next cycle | No (no duplicate if the watermark filter is applied) |
| 13 | Tenant flood / runaway cardinality | That tenant throttled | Per-tenant rejects | Per-tenant DO quotas; active-series cap; other tenants unaffected | Tenant's excess only, reported by reason |
| 14 | Key compromised | Unauthorised writes (or reads) | Anomalous source/volume; secret-scanning alerts | Immediate revocation via tenant DO; edge caches expire ≤ 60 s; rotate | — |
| 15 | KV stale / unavailable | Auth cache misses | Lookup error rate | Fall back to tenant DO lookup; serve from in-isolate cache within TTL; fail *closed* for unknown keys | No |
| 16 | Regional Cloudflare incident affecting the DO's location | Tenant's ingest fails until the DO is reachable or relocated | Synthetic probes per cell | Clients buffer and retry; the platform relocates DOs; viz cannot multi-home a DO. Document the agent-side queue sizing that rides out N minutes | Only beyond agent buffers |
| 17 | Scrape target down / SD endpoint down | `up=0`; or target list frozen | Scrape health per target | Stale markers; keep last-known SD result with staleness flag; surface to tenant | N/A |
| 18 | Tenant adapter code misbehaves (loop, exfiltration attempt, huge output) | Adapter invocation killed | Limit breaches, egress denials | CPU/subrequest/size limits; egress allow-list; circuit breaker; audit event | No impact on others |
| 19 | Retention job deletes too much (bug or bad policy) | Data removed from current snapshot | Row/file-count deltas per commit; guard rails ("refuse to drop > X% without confirmation") | Roll back to previous snapshot within the snapshot-expiration window — a reason not to set that window to hours | Recoverable within window |
| 20 | Clock skew / bad timestamps from clients | Data lands in wrong day partitions or far future | Skew counters | Reject outside accept window (partial success); never trust client time for retention decisions older than window | Rejected data only |
| 21 | Platform limit or price change (beta features: gRPC, VPC, Dynamic Workers pricing) | Feature or cost regression | Changelog watch | Keep OTLP/HTTP + DO + R2 (all GA) as the core; treat beta features as optional edges | — |

Residual risks worth stating plainly: (a) a single DO is a single point of *availability* (not durability) for its tenant-shard; (b) the committer is a shared choke point per table; (c) viz must own an Iceberg writer (manifests in Avro, REST commits) in JS/WASM, which is the largest piece of bespoke correctness-critical code in this path.

---

## 10. Design implications for viz

1. **Build the ingest core around a per-tenant buffer Durable Object with a SQLite WAL**; it provides ack-after-durable, exact quotas, dedup, hot reads and noisy-neighbour isolation in one primitive that costs nothing when idle.
2. **Do not use Basin Pipelines as the multi-tenant data plane today** (20-stream cap, no custom partitioning, silent drops, JSON-only, 10–40× cost). Use it for internal low-volume tables and possibly the MVP; revisit when partitioning ships.
3. **Shared Iceberg tables + tenant-pure files + `identity(tenant_id), day(ts)` partitioning.** Table-per-tenant is ruled out by catalog-operation pricing except for a silo tier.
4. **Single committer per table** batching appends every 30–60 s, skipping empty commits; watermarks in snapshot properties for idempotency.
5. **One internal columnar batch model** (Arrow-shaped) shared by push decoders, the scraper and adapters; protocol front-ends only parse and render responses. The ingest core returns a structured outcome that OTLP renders as 200 + partial_success and PRW as non-2xx + written-count headers.
6. **Decode in WASM straight to columnar buffers**; treat OTLP/JSON as a first-class path; benchmark CPU per MB before finalising body-size and shard-throughput limits.
7. **Protocols**: P0 OTLP/HTTP + PRW 1.0/2.0 (track rc changes: modes, `start_timestamp`); P1 Loki, Cloudflare OTel export recipe, Logpush HTTP; gRPC when Workers gRPC is GA; never StatsD/UDP, Jaeger Thrift or OTel Arrow directly.
8. **Pull = DO alarms per target group** with persisted last-series sets for stale markers; HTTP SD and DNS SD; private targets via agent-push first, authenticated public endpoints second, Workers VPC later.
9. **Adapter contract** modelled on remote-read + TableProvider pushdown negotiation, Arrow as currency, platform-owned cursors; host tenant code in Dynamic Workers with capability-only bindings and mediated egress; keep MCP for agent-facing use, not bulk data.
10. **Auth**: prefixed/checksummed opaque keys with edge cache and DO-side revocation; `workers-oauth-provider` for users and MCP with CIMD first; RBAC + label-matcher policies injected at the query AST; tenant ID never user-controlled.
11. **Retention by file drop**, short snapshot expiration (1–3 days), own orphan sweeper (Basin does not clean never-referenced files), retention classes assigned at ingest for per-stream policies, R2 lifecycle only for staging prefixes and IA transitions.
12. **Cells in every name from day one**; EU residency is achievable for buffers and data files now but not for the catalog — be accurate about it.
13. **Meter at the buffer DO and at commit time** (exact, idempotent), and publish rejection reasons to tenants.

---

## 11. Open questions / unverified

Verification gaps (search budget exhausted or docs silent):

1. **DO durability semantics today**: confirm in current docs that a SQLite-backed DO write is replicated before the output gate releases the response, and what "durable" means under a regional failure. The whole ack contract rests on this. [T]
2. **CPU per MB** for OTLP/PRW decode → columnar in workerd, JS vs WASM; and Parquet encode throughput in a DO within 128 MB. No published benchmark found.
3. **zstd request decompression** in Workers natively (`DecompressionStream`/`node:zlib`) vs WASM. [T]
4. **Basin Catalog behaviours**: Iceberg spec versions; whether managed compaction and Basin SQL honour position/equality delete files; catalog operations consumed per commit; daily maintenance request limits; interaction between external writers' partition specs and managed compaction; behaviour of `DROP TABLE … PURGE`. The limits page 404'd.
5. **Basin Pipelines**: latency from `send()` to confirmation; behaviour under backpressure; whether a plain `INSERT INTO sink SELECT * FROM stream` is billed as a transform ("any query currently counts" suggests yes); 1 GB/s (limits page) vs 3 GB/s (GA blog) per stream.
6. **Workers OTel export wire format**: OTLP/JSON vs protobuf, batch sizes, retry behaviour, and whether arbitrary endpoints are officially supported; meaning of "does not support the binary format for OTLP ingestion".
7. **Workers gRPC** (private beta): GA timing, pricing, limits, trailers/status mapping, whether client-streaming works.
8. **Workers VPC**: GA date, pricing, and whether bindings can be attached per tenant dynamically (e.g. passed into a Dynamic Worker).
9. **Dynamic Workers**: GA status (docs show billing since 2026-05-26 but beta label unclear), exact Worker Loader API surface for `globalOutbound` and binding pass-through, limits on concurrent loaded workers.
10. **R2 SSE-C** with Basin Catalog compaction/Basin SQL (assumed incompatible); R2 lifecycle transition semantics for objects under Iceberg tables.
11. **mTLS**: BYO-CA availability by plan; exposure of client-cert details to Workers on non-Enterprise plans.
12. **Grafana LBAC** current scope (metrics/logs/traces) and Datadog Data Access Control details; Mimir/Loki default limit values quoted in §5.7. [T]
13. **MCP spec 2026-07-28** details were taken from search summaries, not the spec text itself.

Design questions to settle:

14. Flush cadence vs file count for small tenants: is a long-tail `pool-NN` partition needed, and at what tenant count?
15. Row-level dedup for logs/spans at compaction — worth the cost, or document at-least-once for those signals?
16. Should the Parquet encode happen in the buffer DO (duration-billed, 128 MB) or in a stateless Worker fed by the DO (CPU-billed, parallel)?
17. Commit interval and hot-read design: how far can commits be stretched (cost) before hot-buffer queries become the dominant query cost?
18. How much of the transform language (relabel/scrub) to expose before pointing users to a Collector or a tenant-code adapter.
19. SAML/SCIM: build, or accept an optional external vendor for the enterprise tier?
20. Tail sampling at compaction: retention semantics and UX ("this trace was dropped after 3 days") need product definition.
21. Per-tenant encryption tier: is owning compaction and query for those tenants acceptable?

---

## 12. Sources

Cloudflare — data platform:

- Basin GA announcement (2026-10-01): https://blog.cloudflare.com/cloudflare-basin/
- Basin GA changelog: https://developers.cloudflare.com/changelog/post/2026-10-01-basin-ga/
- Pipelines pricing: https://developers.cloudflare.com/pipelines/platform/pricing/
- Pipelines pricing announced (2026-05-11): https://developers.cloudflare.com/changelog/post/2026-05-11-pipelines-pricing-announced/
- Pipelines billing enabled (2026-08-03): https://developers.cloudflare.com/changelog/post/2026-08-03-pipelines-billing-enabled/
- Pipelines limits: https://developers.cloudflare.com/pipelines/platform/limits/
- Writing to streams: https://developers.cloudflare.com/pipelines/streams/writing-to-streams/
- Sinks (exactly-once statement): https://developers.cloudflare.com/pipelines/sinks/
- Iceberg (Catalog) sink: https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2-data-catalog/
- Catalog overview: https://developers.cloudflare.com/r2/data-catalog/
- Catalog pricing: https://developers.cloudflare.com/r2/data-catalog/platform/pricing/
- Catalog table maintenance: https://developers.cloudflare.com/r2/data-catalog/table-maintenance/
- Basin SQL pricing: https://developers.cloudflare.com/r2-sql/platform/pricing/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- R2 data location / jurisdictions: https://developers.cloudflare.com/r2/reference/data-location/

Cloudflare — compute and platform:

- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Queues pricing: https://developers.cloudflare.com/queues/platform/pricing/
- Queues limits: https://developers.cloudflare.com/queues/platform/limits/
- KV pricing: https://developers.cloudflare.com/kv/platform/pricing/
- Workflows pricing: https://developers.cloudflare.com/workflows/reference/pricing/
- Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Dynamic Workers pricing: https://developers.cloudflare.com/dynamic-workers/pricing/
- Dynamic Workers open beta (2026-03-24): https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta
- Dynamic Workers blog: https://blog.cloudflare.com/dynamic-workers
- Workers for Platforms pricing: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/
- Inbound TCP and gRPC for Workers and Containers (2026-08-03): https://blog.cloudflare.com/grpc-workers/
- Workers VPC: https://developers.cloudflare.com/workers-vpc/
- VPC Networks changelog (2026-04-14): https://developers.cloudflare.com/changelog/post/2026-04-14-vpc-networks/
- Workers VPC open beta blog: https://blog.cloudflare.com/workers-vpc-open-beta/

Cloudflare — observability and logs:

- Exporting OpenTelemetry data from Workers: https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/
- Tail Workers: https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- Cloudflare Observability pricing (effective 2026-12-01): https://developers.cloudflare.com/observability/pricing/
- "8 major updates to Cloudflare Observability": https://blog.cloudflare.com/one-observability-platform/
- Logpush pricing: https://developers.cloudflare.com/logs/logpush/pricing/

Auth and MCP:

- workers-oauth-provider: https://github.com/cloudflare/workers-oauth-provider
- MCP authorization, client registration (2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
- WorkOS on DCR vs CIMD: https://workos.com/blog/mcp-client-identity-dcr-cimd-auth-md

Protocols:

- OTLP specification 1.11.1: https://opentelemetry.io/docs/specs/otlp/
- Prometheus Remote-Write 2.0 (rc.6, experimental): https://prometheus.io/docs/specs/prw/remote_write_spec_2_0/
- Prometheus Remote-Write 1.0: https://prometheus.io/docs/specs/remote_write_spec/
- Prometheus scrape content negotiation: https://prometheus.io/docs/instrumenting/content_negotiation/
- OTel Arrow repository: https://github.com/open-telemetry/otel-arrow
- OTel-Arrow Phase 2 (2026): https://opentelemetry.io/blog/2026/otel-arrow-phase-2/
- OTel-Arrow in production (2024): https://opentelemetry.io/blog/2024/otel-arrow-production/

Referenced from training knowledge without re-fetching this session (listed so claims marked [T] can be checked): Loki HTTP push API and retention docs (grafana.com/docs/loki), Mimir limits, shuffle sharding and tenant federation docs (grafana.com/docs/mimir), Grafana RBAC and access-policy/LBAC docs (grafana.com/docs), Datadog RBAC and Data Access Control docs (docs.datadoghq.com), Prometheus HTTP SD and federation docs (prometheus.io/docs), Trino connector SPI (trino.io/docs), DataFusion `TableProvider` (datafusion.apache.org), Prometheus remote read (prometheus.io/docs/specs/prw/remote_read_spec), WarpStream architecture docs (docs.warpstream.com), Cloudflare "Zero-latency SQLite storage in every Durable Object" (blog.cloudflare.com/sqlite-in-durable-objects), Cloudflare API Shield mTLS and Data Localization Suite docs (developers.cloudflare.com).
