#!/usr/bin/env bash
# Fetch SMD, the Server Machine Dataset (github.com/NetManAIOps/OmniAnomaly, MIT licence: the
# repository LICENSE, Copyright (c) 2021 NetManAIOps-OmniAnomaly), into bench/data/smd/.
#
#   bash bench/fetch-smd.sh
#
# 28 machines × {train, test, test_label, interpretation_label}, about 120 files, plus the
# repository's LICENSE and README for the record. Everything lands under bench/data/ (git-ignored);
# nothing from SMD is stored in the repository. bench/smd-run.ts writes bench/smd-manifest.json
# (committed: the SHA-256 of every file) on its first run and refuses to score if the files differ.
#
# Refuses to run before bench/smd-frozen.json exists: every parameter is fixed on NAB first
# (bench/freeze.ts), and the time of the first fetch is kept in data/smd/FETCHED_AT so the run
# can check that the freeze came first.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -s smd-frozen.json ]; then
  echo "bench/smd-frozen.json is missing: run 'node --experimental-strip-types bench/freeze.ts' first (parameters are frozen on NAB before SMD is fetched)" >&2
  exit 2
fi
REPO=https://raw.githubusercontent.com/NetManAIOps/OmniAnomaly/master
BASE=$REPO/ServerMachineDataset
OUT=data/smd
mkdir -p "$OUT/train" "$OUT/test" "$OUT/test_label" "$OUT/interpretation_label"
[ -s "$OUT/FETCHED_AT" ] || date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/FETCHED_AT"

get() { # url dest
  curl -sSf --retry 4 --retry-delay 2 -o "$2.tmp" "$1" && mv "$2.tmp" "$2"
}
get "$REPO/LICENSE" "$OUT/LICENSE"
get "$REPO/README.md" "$OUT/README.md"

MACHINES=""
for i in 1 2 3 4 5 6 7 8; do MACHINES="$MACHINES machine-1-$i"; done
for i in 1 2 3 4 5 6 7 8 9; do MACHINES="$MACHINES machine-2-$i"; done
for i in 1 2 3 4 5 6 7 8 9 10 11; do MACHINES="$MACHINES machine-3-$i"; done

export BASE OUT
for m in $MACHINES; do
  for part in train test test_label interpretation_label; do echo "$part/$m.txt"; done
done | xargs -P 4 -I{} bash -c 'f={}; [ -s "$OUT/$f" ] || { curl -sSf --retry 4 --retry-delay 2 -o "$OUT/$f.tmp" "$BASE/$f" && mv "$OUT/$f.tmp" "$OUT/$f"; }'
echo "smd: $(find "$OUT" -name 'machine-*.txt' | wc -l) files, $(du -sh "$OUT" | cut -f1), first fetched $(cat "$OUT/FETCHED_AT")"
