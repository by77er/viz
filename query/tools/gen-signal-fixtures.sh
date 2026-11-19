#!/usr/bin/env bash
# Fixtures for test/signals.test.ts: for each seed, a corpus of spans and logs decoded by edge's
# own decoders (edge/scripts/otel-corpus.mjs), flushed by the stage-1 encoders, with the answers
# of the engines' in-memory sources (engine/wasm-query/examples/signal_fixtures.rs).
# Output: test/fixtures/signals/seed-N.json (git-ignored; tens of MB). Run before the tests.
#
#   tools/gen-signal-fixtures.sh [seeds…]     (default: 1 2 3)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/.." && pwd)"
seeds=("$@")
[ ${#seeds[@]} -gt 0 ] || seeds=(1 2 3)
scale="${SIGNAL_FIXTURE_SCALE:-0.3}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$here/test/fixtures/signals"
export CARGO_TARGET_DIR="$root/engine/wasm-query/target"
(cd "$root/engine/wasm-query" && cargo build -j "${CARGO_BUILD_JOBS:-2}" --release --example signal_fixtures)
for s in "${seeds[@]}"; do
  node "$root/edge/scripts/otel-corpus.mjs" "$work/corpus-$s" "$s" "$scale" >/dev/null
  "$CARGO_TARGET_DIR/release/examples/signal_fixtures" "$work/corpus-$s" "$here/test/fixtures/signals/seed-$s.json" "$s"
done
