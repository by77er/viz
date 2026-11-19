#!/usr/bin/env bash
# Fetch the Numenta Anomaly Benchmark (github.com/numenta/NAB, MIT licence) into bench/data/nab/.
#
#   bash bench/fetch-nab.sh            data, labels, profiles, published final scores
#   bash bench/fetch-nab.sh --results  also the published per-row outputs of NAB's own detectors,
#                                      reduced to their anomaly_score column (about 45 MB kept,
#                                      about 450 MB transferred)
#
# Everything lands under bench/data/ (git-ignored). bench/nab-manifest.json (committed) records
# the SHA-256 of every data and label file used for the README's numbers; the run script refuses
# to score if they differ, because NAB is fetched from `master` and could change underneath us.
set -euo pipefail
cd "$(dirname "$0")"
BASE=https://raw.githubusercontent.com/numenta/NAB/master
OUT=data/nab
mkdir -p "$OUT/labels" "$OUT/config" "$OUT/results"

get() { # url dest
  mkdir -p "$(dirname "$2")"
  curl -sSf --retry 4 --retry-delay 2 -o "$2.tmp" "$1" && mv "$2.tmp" "$2"
}

get "$BASE/labels/combined_windows.json" "$OUT/labels/combined_windows.json"
get "$BASE/labels/combined_labels.json" "$OUT/labels/combined_labels.json"
get "$BASE/config/profiles.json" "$OUT/config/profiles.json"
get "$BASE/config/thresholds.json" "$OUT/config/thresholds.json"
get "$BASE/results/final_results.json" "$OUT/results/final_results.json"
get "$BASE/nab/sweeper.py" "$OUT/src/sweeper.py"   # NAB's own scorer, for scripts/nab-sweeper-fixture.py

# The file list is the keys of the windows file (58 files in 7 categories).
FILES=$(node -e 'for (const k of Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")))) console.log(k)' "$OUT/labels/combined_windows.json")

export BASE OUT
echo "$FILES" | xargs -P 8 -I{} bash -c 'f={}; mkdir -p "$OUT/data/$(dirname $f)"; [ -s "$OUT/data/$f" ] || curl -sSf --retry 4 --retry-delay 2 -o "$OUT/data/$f" "$BASE/data/$f"'
echo "data: $(echo "$FILES" | wc -l) files, $(du -sh "$OUT/data" | cut -f1)"

if [ "${1:-}" = "--results" ]; then
  DETECTORS=$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))).join(" "))' "$OUT/results/final_results.json")
  for d in $DETECTORS; do
    export d
    # Keep only the anomaly_score column (found by header name); rows stay in data-file order.
    echo "$FILES" | xargs -P 8 -I{} bash -c 'f={}; dir=$(dirname $f); base=$(basename $f .csv); dest="$OUT/results/$d/$dir/${base}.scores";
      [ -s "$dest" ] && exit 0; mkdir -p "$OUT/results/$d/$dir";
      curl -sSf --retry 4 --retry-delay 2 "$BASE/results/$d/$dir/${d}_${base}.csv" |
        awk -F, "NR==1{for(i=1;i<=NF;i++) if(\$i==\"anomaly_score\") c=i; next} {print \$c}" > "$dest.tmp" && mv "$dest.tmp" "$dest"'
    echo "results/$d: $(du -sh "$OUT/results/$d" | cut -f1)"
  done
fi
