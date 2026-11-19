#!/usr/bin/env bash
# SMD score of the ruler's default anomaly configuration (robust z, quantile spread, window 1,500,
# k 2), POST HOC: only the 4,000-point configuration was frozen before SMD was fetched
# (anomaly/bench/smd-frozen.json). Runs anomaly/'s own SMD harness on a scratch COPY of anomaly/,
# never on anomaly/ itself, with one change (smd-window.patch): one more post hoc configuration
# outside the frozen grid, built as anomaly/bench/adapters.ts builds that grid's entries. The
# library, the adapters, the scorer and the frozen file are copied byte for byte, so the harness's
# own integrity checks (code hashes, fetch time, data manifest) still pass, and every published row
# must come out unchanged beside the new one.
#
#   bash ../../../anomaly/bench/fetch-smd.sh   once (464 MB, git-ignored), after the freeze
#   VIZ_SCRATCH=/some/scratch bash smd-window.sh   about 5 minutes on 4 shared cores; one process
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
anomaly="$(cd "$here/../../../anomaly" && pwd)"
work="$(mktemp -d "${VIZ_SCRATCH:-${TMPDIR:-/tmp}}/smd-window-XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/anomaly/bench/out"
cp -r "$anomaly/src" "$anomaly/package.json" "$work/anomaly/"
cp "$anomaly"/bench/*.ts "$anomaly"/bench/*.json "$work/anomaly/bench/"
ln -s "$anomaly/bench/data" "$work/anomaly/bench/data"
ln -s "$anomaly/node_modules" "$work/anomaly/node_modules"
# Earlier runs' per-machine results, so that only the new configuration runs (the harness checks they match the frozen file).
if [ -d "$anomaly/bench/out/smd-cache" ]; then cp -r "$anomaly/bench/out/smd-cache" "$work/anomaly/bench/out/"; fi
(cd "$work/anomaly" && patch -p1 --quiet < "$here/smd-window.patch")
(cd "$work/anomaly" && node --max-old-space-size=1400 --experimental-strip-types bench/smd-run.ts --only=posthoc) 2>&1 | grep -v ExperimentalWarning | tail -20
cp "$work/anomaly/bench/out/smd-results.md" "$here/out/smd-results.md"
echo "wrote $here/out/smd-results.md"
