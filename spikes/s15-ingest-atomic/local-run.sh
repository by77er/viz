#!/usr/bin/env bash
# Runs local-bench.mjs against two local builds (no credentials, nothing deployed):
#   BEFORE=/copy/of/375e9ba AFTER=/copy/of/this/branch STATE=/scratch/dir bash local-run.sh [--only refused]
# Each tree needs edge/wrangler.bench.jsonc: edge/wrangler.jsonc without `services` (the self
# bindings, whose sockets collide when two instances run) and with its own `name`. Run it under the
# shared machine's lock (AGENTS.md); it stops both servers and deletes their state at the end.
set -euo pipefail
trap 'pkill -f "wrangler dev --config wrangler.bench.jsonc --local --port 1878" || true' EXIT
export WRANGLER_SEND_METRICS=false
HERE=$(cd "$(dirname "$0")" && pwd)
rm -rf "$STATE/state-before" "$STATE/state-after"; mkdir -p "$STATE/state-before" "$STATE/state-after"
desc() { local out=""; for c in $(pgrep -P "$1"); do out="$out $c $(desc "$c")"; done; echo $out; }
workerd_of() { local out=""; for p in $(desc "$1"); do grep -q workerd /proc/$p/comm 2>/dev/null && out="$out,$p"; done; echo "${out#,}"; }
start() { (cd "$2/edge" && exec npx wrangler dev --config wrangler.bench.jsonc --local --port "$3" --ip 127.0.0.1 --persist-to "$STATE/state-$1" --var INGEST_SIGNALS:traces,logs --show-interactive-dev-session=false > "$STATE/dev-$1.log" 2>&1) & LAST=$!; }
node "$HERE/local-bench.mjs" setup --before x --after x --before-state "$STATE/state-before" --after-state "$STATE/state-after" --before-config "$BEFORE/edge/wrangler.bench.jsonc" --after-config "$AFTER/edge/wrangler.bench.jsonc"
start before "$BEFORE" 18787; RB=$LAST
start after "$AFTER" 18788; RA=$LAST
for p in 18787 18788; do for i in $(seq 1 120); do curl -sf "http://127.0.0.1:$p/healthz" >/dev/null && break; sleep 1; done; done
node "$HERE/local-bench.mjs" run --before http://127.0.0.1:18787 --after http://127.0.0.1:18788 --before-state "$STATE/state-before" --after-state "$STATE/state-after" \
  --before-pid "$(workerd_of $RB)" --after-pid "$(workerd_of $RA)" "$@" > "$STATE/result.json"
kill $(desc $RB) $(desc $RA) $RB $RA 2>/dev/null || true
rm -rf "$STATE/state-before" "$STATE/state-after"
