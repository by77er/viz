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
#   VIZ_SKIP_NPM_CI=1      use node_modules as they are (a shared checkout where others are working);
#                          the app's build then links app/ and design-system/'s node_modules into its export
#   VIZ_WITHOUT_APP=1      a stage only: viz-gateway without the web app (recorded in the release
#                          record); production always serves it (D74)
#   VIZ_APP_NO_CARRY=1     keep no file of earlier app builds in this release (a page opened before
#                          it then gets 404 for a chunk it has not loaded yet)
#   VIZ_STAGE_EXPIRES_AT   a stage only: ISO time after which its ruler stops evaluating by itself
#   VIZ_OAUTH_WITHOUT_RATE_LIMITS=1   a stage only: viz-control without D70's rate limits (recorded in the
#                          release record; the key is then put without them); production never
#   VIZ_OAUTH_PUBLIC=1     a stage only: set OAUTH_PUBLIC on viz-control (raises the oauth-public
#                          rollback floor); every production viz-control has it
#   VIZ_ROTATE_SECRETS     generated Worker secrets to REPLACE in this release, e.g. "OAUTH_CLIENT_KEY"
#                          (invalidates every registered OAuth client; see deploy/README.md). Without
#                          it a generated secret is created only where it is missing, never replaced.
#
# Steps: build both WASM engines; npm ci in each deployed component; build the web app in an export
# of its sources and stage it for viz-gateway (deploy/app.mjs); resources; configure; release (upload
# every Worker, then promote callees first); smoke test through the public URL, the web app
# included. A failed app build, like any failed step before the release, leaves the previous release
# untouched (exit 1); a missing, stale or altered build is refused by the release itself (exit 3). A failed smoke test rolls back to the previous release when the release applied no
# Durable Object migration and is not forward-only; otherwise it fails loudly instead. Exit codes:
# 0 deployed and healthy; 1 failed; 3 refused before anything was promoted: an unacknowledged
# migration, a rollback floor (INGEST_SIGNALS before its readers, a floor Worker below its floor
# after the switch was on, the switch set as a secret), a web app build that is missing, stale or not
# what was staged, a rotation of a secret the release does not generate, or, for a viz-control uploaded in phase 1 (every release once it exists), its generated
# key set but missing from the upload, the newest version not this run's upload, or the key landing
# on another run's upload. The same three key refusals for a viz-control that goes out with
# `wrangler deploy` in phase 2 (new, or applying a migration) come after the Workers before it were
# promoted and while viz-control serves without its key: exit 1 (deploy/README.md, "When a deploy
# fails").
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

step "web app"
if [ "${VIZ_WITHOUT_APP:-0}" = 1 ]; then
  [ -n "$STAGE" ] || { echo "VIZ_WITHOUT_APP=1 is for a stage only: production serves the web app (D74)" >&2; exit 1; }
  note "web app: NOT built (VIZ_WITHOUT_APP=1); this stage's viz-gateway serves none"
else
  APP_ARGS=()
  if [ "${VIZ_APP_NO_CARRY:-0}" = 1 ]; then APP_ARGS=(--no-carry); fi
  # Built in an export of the sources under deploy/generated/, never in app/; a failure stops here.
  APP_BUILT=$(node deploy/app.mjs build ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --release "$VIZ_RELEASE_SHA" ${APP_ARGS[@]+"${APP_ARGS[@]}"})
  # shellcheck disable=SC2016
  note "web app: $(node -e 'const a=JSON.parse(process.argv[1]);console.log(`build ${a.build.slice(0,12)}, ${a.files} files, ${a.kept} kept from earlier builds${a.dropped?`, ${a.dropped} not kept (see above)`:""}`)' "$APP_BUILT")"
fi

step "resources"
node deploy/resources.mjs ensure ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"}
note "resources: present"

step "configure"
CONFIGURE_ARGS=()
if [ -n "${VIZ_STAGE_EXPIRES_AT:-}" ]; then CONFIGURE_ARGS=(--expires "$VIZ_STAGE_EXPIRES_AT"); fi
if [ "${VIZ_OAUTH_WITHOUT_RATE_LIMITS:-0}" = 1 ]; then CONFIGURE_ARGS+=(--oauth-without-rate-limits); fi
if [ "${VIZ_OAUTH_PUBLIC:-0}" = 1 ]; then CONFIGURE_ARGS+=(--oauth-public); fi
if [ "${VIZ_WITHOUT_APP:-0}" = 1 ]; then CONFIGURE_ARGS+=(--without-app); fi
node deploy/configure.mjs ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} ${CONFIGURE_ARGS[@]+"${CONFIGURE_ARGS[@]}"} --release "$VIZ_RELEASE_SHA" > /dev/null
note "configure: deploy/generated/$TARGET"

step "release: upload, then promote"
set +e
node deploy/release.mjs deploy ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"}
rc=$?
set -e
if [ $rc -eq 3 ]; then note "release: REFUSED before promoting anything (see above: an unacknowledged Durable Object migration, a rollback floor, the web app's build, or a generated secret)"; exit 3; fi
if [ $rc -ne 0 ]; then note "release: FAILED during upload or promotion, or refused in phase 2 after promotion began (see above)"; exit 1; fi
note "release: promoted; record deploy/generated/$TARGET/release.json"
# Generated secrets, by name only (lib/secrets.mjs): kept, created or rotated.
# shellcheck disable=SC2016
SECRETS=$(node -e 'const r=require(process.argv[1]);console.log((r.secrets||[]).map(s=>`${s.name} on ${s.worker} ${s.action}`).join(", "))' "$OUT/release.json")
if [ -n "$SECRETS" ]; then note "secrets: $SECRETS"; fi
# shellcheck disable=SC2016  # the single quotes hold JavaScript, not shell
MIGRATED=$(node -e 'const r=require(process.argv[1]);console.log((r.migrations||[]).map(m=>`${m.worker} ${m.from??"(none)"}→${m.to}`).join(", "))' "$OUT/release.json")
# Forward-only for a schema, a format (contracts/COMPATIBILITY.md §6) or a rollback floor (D69 point 6): a class's storage may already
# be in a shape, or a format at a version, the previous release cannot read; release.mjs would
# refuse the rollback anyway.
# shellcheck disable=SC2016
FORWARD_ONLY=$(node -e 'const r=require(process.argv[1]);console.log((r.forwardOnlyBecause||[]).filter(f=>f.kind==="schema"||f.kind==="format"||f.kind==="floor").map(f=>f.kind==="schema"?`${f.component} readable from ${f.compat}`:f.kind==="floor"?`${f.worker} below the ${f.rule} floor before it`:`${f.format} written at ${f.writes}`).join(", "))' "$OUT/release.json")

if [ $SMOKE -eq 0 ]; then note "smoke: skipped (--skip-smoke)"; exit 0; fi
step "smoke test"
if node deploy/smoke.mjs ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --expect-release "$VIZ_RELEASE_SHA"; then
  note "smoke: passed$([ -z "${SMOKE_KEY:-}" ] && echo ' (no data check: SMOKE_KEY not set)')"
  exit 0
fi
note "smoke: FAILED"
if [ -n "$FORWARD_ONLY" ] && [ -z "$MIGRATED" ]; then
  echo "::error::Smoke test failed after a FORWARD-ONLY release ($FORWARD_ONLY)." >&2
  echo "  Not rolling back: storage this release migrated, or a format version it wrote, cannot be read by the previous release (contracts/COMPATIBILITY.md §6)." >&2
  echo "  What to do: fix forward with a new commit (see deploy/README.md, 'When a deploy fails')." >&2
  note "rollback: NOT attempted (forward-only release: $FORWARD_ONLY)"
  exit 1
fi
if [ -n "$MIGRATED" ]; then
  echo "::error::Smoke test failed after a release that applied Durable Object migrations ($MIGRATED)." >&2
  echo "  Not rolling back: Cloudflare cannot roll back across a migration, and migrations are forward-only." >&2
  echo "  What to do: fix forward with a new commit (see deploy/README.md, 'When a deploy fails'). The release record is in the job artifacts." >&2
  note "rollback: NOT attempted (release applied migrations: $MIGRATED)"
  exit 1
fi
step "automatic rollback to the previous release"
if node deploy/release.mjs rollback ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --record "$OUT/previous.json" --reason "smoke test of $VIZ_RELEASE_SHA failed"; then
  note "rollback: previous release restored"
  PREVIOUS=$(node -e 'console.log(require(process.argv[1]).release??"")' "$OUT/previous.json")
  # --no-app: the manifest describes the release just rolled back, not the web app the previous one serves.
  if SMOKE_KEY="" node deploy/smoke.mjs ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --no-app --health-timeout 180 ${PREVIOUS:+--expect-release "$PREVIOUS"}; then note "after rollback: healthy"; else note "after rollback: NOT healthy"; fi
else
  note "rollback: FAILED or refused (see above)"
fi
exit 1
