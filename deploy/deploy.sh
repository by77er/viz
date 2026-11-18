#!/usr/bin/env bash
# Deploys viz: production (vis.bitcru.sh) by default, or a stage (viz-<stage>-…, workers.dev).
#
#   deploy/deploy.sh [--stage <name>] [--skip-smoke]
#
# Environment:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   required
#   VIZ_RELEASE_SHA        the release id (CI: the git SHA; default GITHUB_SHA)
#   VIZ_ACK_MIGRATIONS     acknowledged Durable Object migrations, e.g. "viz-ingest@v2"
#   SMOKE_KEY              optional: an API key with write and read scopes, for the data check
#   VIZ_WASM_PREBUILT=1    use the .wasm modules already in place (CI: built and tested by the checks)
#   VIZ_SKIP_NPM_CI=1      use node_modules as they are (a shared checkout where others are working)
#
# Steps: build both WASM engines; npm ci in each deployed component; resources; configure;
# release (upload every Worker, then promote callees first); smoke test through the public
# URL. A failed smoke test rolls back to the previous release when the release applied no
# Durable Object migration; with a migration it fails loudly instead. Exit codes: 0 deployed
# and healthy; 1 failed; 3 refused before anything was promoted (unacknowledged migration).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STAGE=""
SMOKE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2 ;;
    --skip-smoke) SMOKE=0; shift ;;
    *) echo "deploy.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
STAGE_ARGS=()
TARGET=production
if [ -n "$STAGE" ]; then STAGE_ARGS=(--stage "$STAGE"); TARGET="stage-$STAGE"; fi
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not set}"
export VIZ_RELEASE_SHA="${VIZ_RELEASE_SHA:-${GITHUB_SHA:-local-$(date -u +%Y%m%dT%H%M%S)}}"
OUT="$ROOT/deploy/generated/$TARGET"
mkdir -p "$OUT"

STEPS=()
started=$(date +%s)
step() { echo; echo "==> $*"; }
note() { STEPS+=("$1"); }
# shellcheck disable=SC2329  # invoked by the EXIT trap
finish() {
  local code=$?
  echo
  echo "==== deploy summary: $TARGET, release $VIZ_RELEASE_SHA ===="
  for s in ${STEPS[@]+"${STEPS[@]}"}; do echo "  $s"; done
  echo "  elapsed: $(( $(date +%s) - started )) s; exit $code"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "### deploy.sh: $TARGET, exit $code"; for s in ${STEPS[@]+"${STEPS[@]}"}; do echo "- $s"; done; } >> "$GITHUB_STEP_SUMMARY"
  fi
}
trap finish EXIT

step "WASM engines"
if [ "${VIZ_WASM_PREBUILT:-0}" = 1 ]; then
  for f in engine/wasm/js/viz_engine.wasm engine/wasm-query/js/viz_query.wasm; do
    [ -s "$f" ] || { echo "VIZ_WASM_PREBUILT=1 but $f is missing" >&2; exit 1; }
    echo "  $f $(sha256sum "$f" | cut -c1-16) ($(wc -c < "$f") bytes), prebuilt"
  done
  note "wasm: prebuilt modules used"
else
  CARGO_BUILD_JOBS=2 engine/wasm/build.sh
  CARGO_BUILD_JOBS=2 engine/wasm-query/build.sh
  note "wasm: both engines built"
fi

step "npm ci"
if [ "${VIZ_SKIP_NPM_CI:-0}" = 1 ]; then
  note "npm ci: skipped (VIZ_SKIP_NPM_CI=1)"
else
  for d in deploy $(node -e 'const p=require("./deploy/workers.json");console.log(p.workers.filter(w=>w.deploy!==false&&w.component!=="deploy/gateway").map(w=>w.component).join(" "))'); do
    echo "  $d"
    (cd "$d" && npm ci --no-audit --no-fund --loglevel=error)
  done
  note "npm ci: deploy and every deployed component"
fi

step "resources"
node deploy/resources.mjs ensure ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"}
note "resources: present"

step "configure"
node deploy/configure.mjs ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --release "$VIZ_RELEASE_SHA" > /dev/null
note "configure: deploy/generated/$TARGET"

step "release: upload, then promote"
set +e
node deploy/release.mjs deploy ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"}
rc=$?
set -e
if [ $rc -eq 3 ]; then note "release: REFUSED before promoting anything (unacknowledged Durable Object migration)"; exit 3; fi
if [ $rc -ne 0 ]; then note "release: FAILED during upload or promotion (see above)"; exit 1; fi
note "release: promoted; record deploy/generated/$TARGET/release.json"
# shellcheck disable=SC2016  # the single quotes hold JavaScript, not shell
MIGRATED=$(node -e 'const r=require(process.argv[1]);console.log((r.migrations||[]).map(m=>`${m.worker} ${m.from??"(none)"}→${m.to}`).join(", "))' "$OUT/release.json")

if [ $SMOKE -eq 0 ]; then note "smoke: skipped (--skip-smoke)"; exit 0; fi
step "smoke test"
if node deploy/smoke.mjs ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"}; then
  note "smoke: passed$([ -z "${SMOKE_KEY:-}" ] && echo ' (health only: SMOKE_KEY not set)')"
  exit 0
fi
note "smoke: FAILED"
if [ -n "$MIGRATED" ]; then
  echo "::error::Smoke test failed after a release that applied Durable Object migrations ($MIGRATED)." >&2
  echo "  Not rolling back: Cloudflare cannot roll back across a migration, and migrations are forward-only." >&2
  echo "  What to do: fix forward with a new commit (see deploy/README.md, 'When a deploy fails'). The release record is in the job artifacts." >&2
  note "rollback: NOT attempted (release applied migrations: $MIGRATED)"
  exit 1
fi
step "automatic rollback to the previous release"
if node deploy/release.mjs rollback ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --record "$OUT/previous.json" --reason "smoke test of $VIZ_RELEASE_SHA failed"; then
  note "rollback: previous release restored ($(node -e 'console.log(require(process.argv[1]).release??"unknown")' "$OUT/previous.json"))"
  if SMOKE_KEY="" node deploy/smoke.mjs ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --health-timeout 120; then note "after rollback: healthy"; else note "after rollback: NOT healthy"; fi
else
  note "rollback: FAILED or refused (see above)"
fi
exit 1
