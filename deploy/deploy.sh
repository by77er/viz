#!/usr/bin/env bash
# Deploys viz: production (vis.bitcru.sh) by default, or a stage (viz-<stage>-…, workers.dev).
#
#   deploy/deploy.sh [--stage <name>] [--skip-smoke]
#   deploy/deploy.sh --install-only     npm ci in deploy/ and every deployed component, then stop.
#                                       Needs no credential: the workflow runs it in a step without
#                                       any, then the deploy itself with VIZ_SKIP_NPM_CI=1
#
# Environment:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   required (not for --install-only)
#   VIZ_RELEASE_SHA        the release id (CI: the git SHA; default GITHUB_SHA)
#   VIZ_ACK_MIGRATIONS     acknowledged Durable Object migrations, e.g. "viz-ingest@v2"
#   SMOKE_KEY              optional: an API key with write and read scopes, for the data check
#   VIZ_WASM_PREBUILT=1    use the .wasm modules already in place (CI: built and tested by the checks)
#   VIZ_SKIP_NPM_CI=1      use node_modules as they are (a shared checkout where others are working; or
#                          the workflow, after --install-only). An app build made HERE then links app/'s
#                          and design-system/'s node_modules into its export; its stamp says "linked",
#                          and production refuses that for a release that is a commit
#   VIZ_APP_BUILD=<dir>    the web app's build, handed over by `node deploy/app.mjs handover` run where
#                          no secret is (the workflow's app-build job): taken as data, verified against
#                          this checkout, never executed. Without it the app is built here, with the
#                          credentials removed from the build's environment: weaker, see below. Under
#                          GitHub Actions it is required
#   VIZ_APP_WITHOUT_STAGE_EVIDENCE="<reason>"   the owner's override for the first production release
#                          with the web app when no stage is recorded to have gone before it
#                          (deploy/records/app-stage-evidence.json); logged and recorded
#   VIZ_WITHOUT_APP=1      a stage only: viz-gateway without the web app (recorded in the release
#                          record); production always serves it (D74)
#   VIZ_APP_NO_CARRY=1     keep no file of earlier app builds in this release (a page opened before
#                          it then gets 404 for a chunk it has not loaded yet). This is how a known-bad
#                          build's files stop being served; the workflow's app_drop_kept_files input
#   VIZ_STAGE_EXPIRES_AT   a stage only: ISO time after which its ruler stops evaluating by itself
#   VIZ_OAUTH_WITHOUT_RATE_LIMITS=1   a stage only: viz-control without D70's rate limits (recorded in the
#                          release record; the key is then put without them); production never
#   VIZ_OAUTH_PUBLIC=1     a stage only: set OAUTH_PUBLIC on viz-control (raises the oauth-public
#                          rollback floor); every production viz-control has it
#   VIZ_ROTATE_SECRETS     generated Worker secrets to REPLACE in this release, e.g. "OAUTH_CLIENT_KEY"
#                          (invalidates every registered OAuth client; see deploy/README.md). Without
#                          it a generated secret is created only where it is missing, never replaced.
#
# Steps: build both WASM engines; npm ci in each deployed component (no install scripts); the web
# app: take the build handed over (VIZ_APP_BUILD), or build it here in an export of its sources
# outside the checkout, with no credential in the build's environment; verify it against this
# checkout and stage it for viz-gateway (deploy/app.mjs); resources; configure; release (upload
# every Worker, then promote callees first); smoke test through the public URL, the web app
# included.
#
# Who can read the Cloudflare token (review of D74, M-1). The app's build runs third-party code. In
# the workflow it runs in another job, which holds no secret, and only its output arrives here. Run
# from this script it gets an environment without the credentials, but it is still a child of this
# shell and runs as the same user: it could read this shell's environment from /proc, or rewrite a
# file a later step runs. That is the trust a local or stage deploy places in the app's locked
# dependencies; a production deploy should come from the workflow.
#
# A failed app build, like any failed step before the release, leaves the previous release
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
INSTALL_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2 ;;
    --skip-smoke) SMOKE=0; shift ;;
    --install-only) INSTALL_ONLY=1; shift ;;
    *) echo "deploy.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

# npm ci in deploy/ and in every deployed component, without install scripts: wrangler bundles their
# sources and needs their packages' files, not their scripts (verified from a fresh export:
# deploy/README.md, "How it was verified"). No credential is needed or wanted here.
install_all() {
  # shellcheck disable=SC2016
  for d in deploy $(node -e 'const p=require("./deploy/workers.json");console.log(p.workers.filter(w=>w.deploy!==false&&w.component!=="deploy/gateway").map(w=>w.component).join(" "))'); do
    echo "  $d"
    (cd "$d" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)
  done
}
if [ $INSTALL_ONLY -eq 1 ]; then
  for v in CLOUDFLARE_API_TOKEN SMOKE_KEY; do
    if [ -n "${!v:-}" ]; then echo "deploy.sh --install-only: $v is set, and an install is where it must not be. Run it in a step without secrets." >&2; exit 2; fi
  done
  echo "==> npm ci (deploy/ and every deployed component; no install scripts, no credentials)"
  install_all
  exit 0
fi
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
  # The app build this script made itself (not one handed over): build output, removed.
  if [ -n "${HANDOVER_TMP:-}" ]; then rm -rf "$HANDOVER_TMP"; fi
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

# The names of this shell's variables that are credentials, as `env -u NAME` arguments: what the
# installs and the app's build run without.
SCRUB=()
for v in $(compgen -e); do
  case "$v" in
    CLOUDFLARE_*|CF_API*|WRANGLER_*|ACTIONS_*|SMOKE_KEY|*TOKEN*|*SECRET*|*PASSWORD*|*CREDENTIAL*|*_KEY|*_KEY_*|KEY_*) SCRUB+=(-u "$v") ;;
  esac
done
export -f install_all

step "npm ci"
if [ "${VIZ_SKIP_NPM_CI:-0}" = 1 ]; then
  note "npm ci: skipped (VIZ_SKIP_NPM_CI=1)"
else
  # Without the credentials in the installs' environment, and without install scripts. Weaker than
  # the workflow, where the installs run in a step that was never given a secret.
  env ${SCRUB[@]+"${SCRUB[@]}"} bash -c 'set -euo pipefail; install_all'
  note "npm ci: deploy and every deployed component (no install scripts, no credentials in their environment)"
fi

step "web app"
if [ "${VIZ_WITHOUT_APP:-0}" = 1 ]; then
  [ -n "$STAGE" ] || { echo "VIZ_WITHOUT_APP=1 is for a stage only: production serves the web app (D74)" >&2; exit 1; }
  note "web app: NOT built (VIZ_WITHOUT_APP=1); this stage's viz-gateway serves none"
else
  APP_ARGS=()
  if [ "${VIZ_APP_NO_CARRY:-0}" = 1 ]; then APP_ARGS=(--no-carry); fi
  if [ -n "${VIZ_APP_BUILD:-}" ]; then
    # Built by a job that holds no secret (the workflow's app-build): data, verified below.
    HANDOVER="$VIZ_APP_BUILD"
    [ -d "$HANDOVER" ] || { echo "VIZ_APP_BUILD=$HANDOVER is not a directory" >&2; exit 1; }
    APP_HOW="handed over in $HANDOVER"
  else
    if [ "${GITHUB_ACTIONS:-}" = true ]; then
      echo "deploy.sh: under GitHub Actions the web app is built by the job that holds no secret (app-build) and handed over: VIZ_APP_BUILD is not set, and this job, which holds the Cloudflare token, does not build it." >&2
      exit 1
    fi
    # Built here: in an export of the sources outside the checkout (never in app/), by a process
    # whose environment has no credential. Its output is then taken as data, exactly as in the workflow.
    HANDOVER_TMP=$(mktemp -d "${TMPDIR:-/tmp}/viz-app-handover.XXXXXX")
    HANDOVER="$HANDOVER_TMP"
    env ${SCRUB[@]+"${SCRUB[@]}"} node deploy/app.mjs handover ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --release "$VIZ_RELEASE_SHA" --out "$HANDOVER" > /dev/null
    APP_HOW="built here without credentials in the build's environment"
  fi
  # Verified against this checkout (source hash, serve.json, every file's SHA-256) and staged; runs
  # no npm and no code of app/. A failure of either step stops here.
  APP_BUILT=$(node deploy/app.mjs build ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"} --release "$VIZ_RELEASE_SHA" --from "$HANDOVER" ${APP_ARGS[@]+"${APP_ARGS[@]}"})
  # shellcheck disable=SC2016
  note "web app: $(node -e 'const a=JSON.parse(process.argv[1]);console.log(`build ${a.build.slice(0,12)}, ${a.files} files, ${a.kept} kept from earlier builds${a.dropped?`, ${a.dropped} not kept (see above)`:""}${a.install&&a.install!=="ci"?`, dependencies ${a.install}`:""}${a.filesNamed===false?"; ITS FILE LIST DOES NOT FIT VIZ_APP_FILES: the next release keeps none of its files":""}`)' "$APP_BUILT") ($APP_HOW)"
  if [ "${VIZ_APP_NO_CARRY:-0}" = 1 ]; then note "web app: NO file of earlier builds kept, as asked (VIZ_APP_NO_CARRY=1)"; fi
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
if [ $rc -eq 3 ]; then note "release: REFUSED before promoting anything (see above: an unacknowledged Durable Object migration, a rollback floor, the web app's build, a first production release with the web app that no stage went before, or a generated secret)"; exit 3; fi
if [ $rc -ne 0 ]; then note "release: FAILED during upload or promotion, or refused in phase 2 after promotion began (see above)"; exit 1; fi
note "release: promoted; record deploy/generated/$TARGET/release.json"
# Generated secrets, by name only (lib/secrets.mjs): kept, created or rotated.
# shellcheck disable=SC2016
SECRETS=$(node -e 'const r=require(process.argv[1]);console.log((r.secrets||[]).map(s=>`${s.name} on ${s.worker} ${s.action}`).join(", "))' "$OUT/release.json")
if [ -n "$SECRETS" ]; then note "secrets: $SECRETS"; fi
# The first production release with the web app: the stage that went before it, or the owner's override (review of D74, M-2).
# shellcheck disable=SC2016
APP_STAGE=$(node -e 'const s=require(process.argv[1]).appStage;console.log(!s?"":s.override?`OVERRIDE, no stage before it: "${s.override}"`:`stage ${s.evidence.stage} went before it (vouched for by ${s.evidence.by})`)' "$OUT/release.json")
if [ -n "$APP_STAGE" ]; then note "first production release with the web app: $APP_STAGE"; fi
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
