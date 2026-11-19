# Contracts

The interfaces every component builds against. If a component needs something different,
change it here first; nothing else may redefine these.

| File | Contract |
|---|---|
| `BATCH.md` | The columnar batch: what `edge` produces, a shard stores opaquely, and the engine decodes |
| `TABLES.md` | Parquet schemas, sort orders, partitioning and object keys for the metrics tables |
| `TRACES.md` | Proposed: the `spans` table and `trace_index`, the read plan the TraceQL engine (`engine/traceql`) produces, and how missing values read. Storage does not implement it yet |
| `LOGS.md` | Proposed: the log-records table (stream id, labels, line, structured metadata, OTLP severity and trace ids), its sort and token filter, and the `LogSource` read seam the LogQL engine (`engine/logql`) uses. Storage does not implement it yet |
| `ledger.ts` | The tenant ledger's RPC surface: file precedence (`LiveFile`, which file wins a duplicate sample), and the proposed tombstone surface used for physical deletion |
| `LEDGER-LOG.md` | The ledger's change log as batched segments written in the background: format, drain, checkpoints, truncation, readers. Built; replaced one object per change (whose keys `ledger.ts` keeps for readers) |
| `rules.ts` | Rule groups, alert state, notification routing, and the evaluator the ruler calls |
| `ingest.ts` | The ingest Worker's service surface for other viz Workers: the `RecordedSamples` entrypoint, where the ruler writes recording-rule samples, authenticated by its service binding (D44) |
| `control.ts` | The control plane's service surface over its Durable Object binding: the tenant's default notification destination and service keys (D39) |
| `oauth.ts` | OAuth 2.1 for agents (MCP clients): clients, grants, codes, access and refresh tokens as the control plane holds them, their formats and lifetimes, and the token, revocation and introspection RPCs the agent surface and control's OAuth endpoints use (D44) |
| `engine.ts` | The JavaScript face of the Rust/WASM engine |
| `COMPATIBILITY.md` | What every component does so that release N and N±1 can run side by side: versioned storage, versioned formats, readers before writers, expand then contract, rollback rules |
| `schema.ts` | The migration runner every Durable Object opens its storage with (`openSchema`), and the rollback test (`canOpen`, `schemaRelease`) |
| `../shard/src/shard.ts` | The shard's RPC surface (already implemented) |
| `../shard/src/pool.ts` | Pool maps and routing (already implemented) |

Scope of this first build: **metrics only** (float samples). Traces and logs follow the
same shapes later.
