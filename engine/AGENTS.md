# Working in `engine/`

The Rust core. See the root `AGENTS.md` for rules that apply everywhere.

- **No I/O.** Engine crates take bytes and return bytes: no filesystem, network, clock,
  randomness or async runtime. This is what lets the same code run as WASM in Workers,
  natively in Containers, and inside a deterministic simulator. If a function needs the
  time or a random value, the caller passes it in.
- **Never panic on input.** Malformed batches, files and queries return errors. Build with
  `panic = "abort"` for WASM, so a panic is a crashed request.
- **Return `Unsupported`, never a wrong answer.** A query feature that is not implemented
  must say so.
- **Two targets, every change.** `cargo test` on the host, and
  `cargo build --release --target wasm32-unknown-unknown` must both succeed.
- **WASM build settings that measured faster:** release profile with fat LTO, one codegen
  unit and `opt-level = 3`; `RUSTFLAGS="-C target-feature=+simd128,+bulk-memory"`. Running
  `wasm-opt -O3` afterwards shrank the module but did not speed it up.
- **Parquet.** Use the `parquet` crate with `default-features = false`. Compression
  features that need a C toolchain (zstd) do not build for `wasm32-unknown-unknown` without
  extra setup; snappy does. When reading string columns that are filtered or grouped, keep
  them dictionary-encoded (Arrow reader with a dictionary schema) instead of building one
  string per row.
- **Memory is a correctness property.** The engine runs in 128 MB isolates. Stream row
  groups; do not hold a whole file's decoded columns unless the file is known to be small.
  Keep row groups at or below the sizes in `contracts/TABLES.md`.
- **Results must not depend on where rows live.** Any read path is tested for identical
  output whether rows are in Parquet files, in tail batches, or split between them, and
  with pruning on and off.
- **Query semantics follow the reference implementation.** PromQL behaviour is checked
  against the upstream Prometheus test corpus; a failing upstream case is a bug to fix or
  to list, never to delete.
- When several builds run at once, give each its own `CARGO_TARGET_DIR`.
