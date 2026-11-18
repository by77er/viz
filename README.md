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

| Path        | Contents                                              |
| ----------- | ----------------------------------------------------- |
| `research/` | State-of-the-art research notes that inform the design |
| `design/`   | `DESIGN.md` (architecture), `DECISIONS.md`, `VERIFICATION.md`, `REVIEW.md` and the raw reviews |

Status: research and design phase.
