#!/usr/bin/env bash
# Build the query engine for WebAssembly and place it next to the TypeScript binding.
#   release, fat LTO, one codegen unit, opt-level 3, panic=abort   (Cargo.toml)
#   -C target-feature=+simd128,+bulk-memory                        (.cargo/config.toml)
set -euo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="$PWD/target"
# Two jobs unless told otherwise: the machine is shared (AGENTS.md).
cargo build -j "${CARGO_BUILD_JOBS:-2}" --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/viz_query_engine.wasm js/viz_query.wasm
raw=$(wc -c < js/viz_query.wasm)
gz=$(gzip -9 -c js/viz_query.wasm | wc -c)
echo "js/viz_query.wasm: $raw bytes raw, $gz bytes gzip -9"
