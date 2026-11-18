#!/usr/bin/env bash
# Build the engine for WebAssembly and place it next to the TypeScript binding.
#   release, fat LTO, one codegen unit, opt-level 3, panic=abort   (Cargo.toml)
#   -C target-feature=+simd128,+bulk-memory                        (.cargo/config.toml)
set -euo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="$PWD/target"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/viz_engine.wasm js/viz_engine.wasm
raw=$(wc -c < js/viz_engine.wasm)
gz=$(gzip -9 -c js/viz_engine.wasm | wc -c)
echo "js/viz_engine.wasm: $raw bytes raw, $gz bytes gzip -9"
