#!/usr/bin/env bash
# Fetch Loki's own test files at the pinned tag into testdata/loki-oracle/ (git-ignored:
# Loki is AGPL-3.0 and its tests are never committed here), and extract their test tables
# into testdata/loki-oracle/cases.json for `cargo test --test conformance`.
#
# The files are used only as a behavioural oracle (see ../../CLEANROOM.md). Needs curl and
# a Go toolchain (any version; only the standard library is used).
set -euo pipefail
TAG=v3.7.10
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../testdata/loki-oracle"
mkdir -p "$OUT"
for f in pkg/logql/syntax/parser_test.go pkg/logql/log/parser_test.go pkg/logql/log/fmt_test.go; do
  curl -sSf -m 60 "https://raw.githubusercontent.com/grafana/loki/$TAG/$f" -o "$OUT/$(echo "$f" | tr '/' '_')"
done
(cd "$HERE" && GOTOOLCHAIN=local GOFLAGS=-mod=mod go run extract.go "$OUT") > "$OUT/cases.json"
echo "wrote $OUT/cases.json from grafana/loki $TAG"
