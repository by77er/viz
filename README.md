# viz

A serverless, Cloudflare-native observability platform: metrics, logs, and traces
stored as Apache Iceberg tables (Parquet on R2), queried with PromQL and TraceQL,
and consumed through composable, agent-first dashboards.

## Goals

- **Storage** — Iceberg over Parquet over R2, plus pluggable external adapters.
- **Query** — PromQL and TraceQL as the baseline query languages.
- **Dashboards** — composable, agent-first (produced and consumed by agents and humans).
- **Ingest** — authenticated push or pull.
- **Tenancy** — multi-tenant, with configurable retention.
- **Monitors** — alerting, anomaly detection, and agentic monitors.
- **Shape** — massively scalable, easy to reason about, low minimum cost.

## Repository layout

Start with `AGENTS.md` (how work is done here), then `design/DESIGN.md` (the architecture)
and `design/DECISIONS.md` (each decision, its alternatives and what would change it).

| Path | Contents |
| --- | --- |
| `contracts/` | The interfaces between components: batch format, tables, ledger, engine, rules, compatibility across releases |
| `design/` | `DESIGN.md`, `DECISIONS.md`, `VERIFICATION.md`, `UPGRADES.md`, `SELF-MONITORING.md` (proposal), `REVIEW.md` and the raw reviews |
| `research/` | Research notes that inform the design; each claim tagged verified, secondary or training knowledge |
| **Write path** | |
| `edge/` | Ingest Worker: authenticates a sender, decodes Prometheus Remote Write and OTLP, routes to shards |
| `shard/` | Pooled shard Durable Object: the write-ahead log, sealing and the tail of recent data |
| `flush/` | Turns sealed segments into tenant-pure Parquet files on R2 |
| `ledger/` | Per-tenant ledger Durable Object: the authority on which files are visible |
| `compact/` | Merges a tenant's small files into fewer, larger ones |
| `janitor/` | Retention, expiry and physical deletion |
| `stack/` | The write path deployed as one script, with its queues, cron and soak test |
| **Read path and engines** | |
| `query/` | Prometheus HTTP API Worker, with query leaves as Durable Objects; Tempo and Loki HTTP APIs behind `QUERY_SIGNALS`, which is off |
| `engine/` | Rust engine crates compiled to WebAssembly: storage, PromQL, query, TraceQL, LogQL (the last two clean-room; they read the span and log files storage writes, and the query Worker serves them behind `QUERY_SIGNALS`, which is off) |
| `publisher/` | Publishes the ledgers as Iceberg tables that external engines can read |
| **Control, monitors and agents** | |
| `control/` | Tenant control plane: keys, dashboards, settings |
| `ruler/` | Rule evaluation, notification and the monitors API |
| `anomaly/` | Anomaly detectors for monitors |
| `dashboard/` | The `viz.dashboard/v1` model, read by the renderer, agents and screen readers |
| `mcp/` | MCP server and JSON agent API over query, ruler and control |
| **Evidence and operations** | |
| `spec/` | Protocol models of the write and read path, checked against the invariants |
| `bench/` | Rust/WASM versus JavaScript engine benchmark, with results |
| `spikes/` | Experiments deployed to Cloudflare, each with its result and cleanup state |
| `deploy/` | How a push to `main` becomes a deployment at `vis.bitcru.sh`, and how to roll back |

Each component has a README with what is implemented, what is not, how it was verified
and its known risks.

Not on `main` yet, all on the development branch: the web app and its design system (`app/`,
`design-system/`), which merge after their design reviews approve.

## Licence

Apache-2.0 (`LICENSE`, `NOTICE`). Third-party material in the repository keeps its own licence;
`THIRD_PARTY.md` lists each piece and how its obligations are met.
