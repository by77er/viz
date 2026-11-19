# Contracts

The interfaces every component builds against. If a component needs something different,
change it here first; nothing else may redefine these.

| File | Contract |
|---|---|
| `BATCH.md` | The columnar batch: what `edge` produces, a shard stores opaquely, and the engine decodes. Signal 1 (metrics) is built; signals 2 (spans) and 3 (log records) are settled and encoded and decoded, not yet stored by shards (stage 2), with their routing to per-signal pools proposed |
| `TABLES.md` | Parquet schemas, sort orders, partitioning and object keys for the metrics tables |
| `TRACES.md` | The `spans` table and `trace_index`: layout, sort, promoted attributes and index fragments settled and written by `engine/storage`; the read plan the TraceQL engine (`engine/traceql`) produces, and how missing values read. Flush, ledger, query and publication of these tables are proposed |
| `LOGS.md` | The log-records table (stream id, labels, line, structured metadata, OTLP severity and trace ids), the OTLP and Loki push mappings, its sort, index fragment and token-filter format, and the `LogSource` read seam the LogQL engine (`engine/logql`) uses. Layout settled and written by `engine/storage`; flush, ledger, query and the token filter are proposed |
| `ledger.ts` | The tenant ledger's RPC surface: file precedence (`LiveFile`, which file wins a duplicate sample), the tombstone surface used for physical deletion, and (D61, registration before writes) whether a registration is logged (`RegisterResult.logged`) and each stream's logged incarnation (`LoggedWatermark`), both additive |
| `LEDGER-LOG.md` | The ledger's change log as batched segments written in the background: format, drain, checkpoints, truncation, readers. Built; replaced one object per change (whose keys `ledger.ts` keeps for readers) |
| `rules.ts` | Rule groups, alert state, notification routing, and the evaluator the ruler calls |
| `ingest.ts` | The ingest Worker's service surface for other viz Workers: the `RecordedSamples` entrypoint, where the ruler writes recording-rule samples, authenticated by its service binding (D45) |
| `control.ts` | The control plane's service surface over its Durable Object binding: the tenant's default notification destination and service keys (D39) |
| `oauth.ts` | OAuth 2.1 for agents (MCP clients): clients, grants, codes, access and refresh tokens as the control plane holds them, their formats and lifetimes, and the token, revocation and introspection RPCs the agent surface and control's OAuth endpoints use (D44) |
| `engine.ts` | The JavaScript face of the Rust/WASM engine. Since 2026-11-19 also the TraceQL and LogQL result shapes (the bodies of Tempo's and Loki's HTTP APIs) and the span and log operations of the read path's module (`SignalEngine`, ABI 6 of `engine/wasm-query`) |
| `COMPATIBILITY.md` | What every component does so that release N and N±1 can run side by side: versioned storage, versioned formats, readers before writers, expand then contract, rollback rules |
| `schema.ts` | The migration runner every Durable Object opens its storage with (`openSchema`), and the rollback test (`canOpen`, `schemaRelease`) |
| `../shard/src/shard.ts` | The shard's RPC surface (already implemented). Since D61 also the `registering` backpressure scope, `ensureStream`, and a tail read that names a fresh stream after a loss |
| `../shard/src/pool.ts` | Pool maps and routing (already implemented) |

Scope of the first build: **metrics** (float samples). Traces and logs, stage 1
(2026-11-19): their batches, ingest decoding (behind `INGEST_SIGNALS`) and Parquet layout;
stage 2 wires them through shards, flush, the ledger and query.
