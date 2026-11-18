# Contracts

The interfaces every component builds against. If a component needs something different,
change it here first; nothing else may redefine these.

| File | Contract |
|---|---|
| `BATCH.md` | The columnar batch: what `edge` produces, a shard stores opaquely, and the engine decodes |
| `TABLES.md` | Parquet schemas, sort orders, partitioning and object keys for the metrics tables |
| `ledger.ts` | The tenant ledger's RPC surface |
| `engine.ts` | The JavaScript face of the Rust/WASM engine |
| `../shard/src/shard.ts` | The shard's RPC surface (already implemented) |
| `../shard/src/pool.ts` | Pool maps and routing (already implemented) |

Scope of this first build: **metrics only** (float samples). Traces and logs follow the
same shapes later.
