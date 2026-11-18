# Research

Twelve parallel research tracks, run on 2026-11-18, each owned by one researcher working as a
domain specialist. Each file ends with design implications, open questions and sources.

| # | File | Scope |
|---|------|-------|
| 01 | [cloudflare-data-services](01-cloudflare-data-services.md) | R2, Basin Catalog / SQL / Pipelines, Durable Object storage, D1, KV, Queues |
| 02 | [cloudflare-compute-platform](02-cloudflare-compute-platform.md) | Workers limits, Durable Objects, Containers, Workflows, AI, auth, tooling |
| 03 | [metrics-storage](03-metrics-storage.md) | TSDB designs, the Parquet movement, schema and rollups |
| 04 | [traces-logs-storage](04-traces-logs-storage.md) | Tempo, Loki, flat span schemas, trace lookup, log search |
| 05 | [iceberg-parquet](05-iceberg-parquet.md) | Iceberg v2/v3/v4, commit cadence, file sizing, libraries that run in Workers |
| 06 | [query-engines](06-query-engines.md) | PromQL and TraceQL semantics, engines, serverless fan-out |
| 07 | [ingest-auth-tenancy](07-ingest-auth-tenancy.md) | Protocols, durability, auth, tenancy, retention, adapters |
| 08 | [monitors-anomaly-agentic](08-monitors-anomaly-agentic.md) | Rule scheduling, anomaly detection, AI SRE agents |
| 09 | [frontend-agent-dashboards](09-frontend-agent-dashboards.md) | Dashboard spec, agent tool surface, charts, frontend stack |
| 10 | [cost-performance-model](10-cost-performance-model.md) | Pricing, three workload models, SLO budget, benchmark plan |
| 11 | [prior-art-architecture-lessons](11-prior-art-architecture-lessons.md) | Object-storage-native systems, Durable Object patterns, principles |
| 12 | [verification-strategy](12-verification-strategy.md) | Invariants, simulation, conformance, cost-as-invariant, CI |

## How far to trust these notes

- **Method.** Researchers fetched vendor documentation, changelogs and source repositories live.
  A shared web-search budget ran out part-way through most tracks, so each file tags claims as
  verified, secondary, or training knowledge. Cloudflare facts are mostly verified from primary
  pages; many non-Cloudflare system internals are training knowledge.
- **Corroboration.** Facts that several researchers reached independently from primary pages
  are the most reliable: the October 2026 rename of the Cloudflare data platform to "Basin"
  and its GA, the $9 per million catalog-operation price, the 60 s minimum Pipelines roll, the
  20-stream Pipelines cap, the 128 MB isolate limit, and the six-connection rule.
- **Estimates, not measurements.** Every performance number (decode CPU per MB, bytes per
  sample, R2 tail latency, query latency) and every cost total is a model. The design treats
  them as hypotheses with a named experiment each (see `design/VERIFICATION.md`).

## Where the researchers disagreed

The design resolves each of these; the reasoning is in `design/DECISIONS.md`.

| Question | Positions | Resolution |
|---|---|---|
| Tenancy in Iceberg | Shared tables (01, 05, 07, 10) vs namespace per tenant (04) | Shared tables, tenant-pure files, tenant in the partition spec; dedicated cells for large tenants |
| Engine language | Pure JS Parquet stack (05) vs Rust compiled to WASM (06, 12) | Rust core for encode, decode and evaluation; TypeScript for I/O and Iceberg metadata |
| Span clustering | Sort by service and time plus a trace index (04) vs trace-grouped storage (06) | Service and time, plus `trace_index` and bloom filters |
| Metric value layout | Flat row per sample (03) vs chunk blobs (Cortex/Thanos precedent) | Flat rows, pending a benchmark |
| Compaction | Managed first (05) vs own it (04, 11) | viz-owned; managed compaction off, so each table has one mutator |
| Freshness tier | Uncommitted-file manifest (05) vs reading buffer objects (10, 11) | One seam: snapshot plus per-shard watermark; the shard answers for everything newer |
