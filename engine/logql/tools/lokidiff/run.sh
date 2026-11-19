#!/usr/bin/env bash
# Build the lokidiff harness against Grafana Loki at a pinned tag, in a scratch
# directory, and run it on a case file.
#
#   LOKIDIFF_WORK=/path/to/scratch ./run.sh build
#   LOKIDIFF_WORK=/path/to/scratch ./run.sh run cases.json report.json
#   LOKIDIFF_WORK=/path/to/scratch ./run.sh clean
#
# The harness LINKS AGPL-3.0 CODE (Loki). Everything it fetches or builds lives under
# $LOKIDIFF_WORK (module cache, build cache, toolchain, binary), never in the repository.
set -euo pipefail

LOKI_VERSION=v3.7.10   # pinned: released 2026-11-13, commit c792f58577a46c64b0a8e808d7c643ed0e8c5e83
GO_TOOLCHAIN=go1.26.10 # the go directive of Loki v3.7.10's go.mod
PUSH_VERSION=v0.0.0-20261113001030-c792f58577a4 # pkg/push at the same commit

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${LOKIDIFF_WORK:?set LOKIDIFF_WORK to a scratch directory outside the repository}"
mkdir -p "$WORK"
export GOMODCACHE="$WORK/gomod" GOCACHE="$WORK/gocache" GOPATH="$WORK/gopath"
export GOTOOLCHAIN="$GO_TOOLCHAIN" GOMAXPROCS="${GOMAXPROCS:-2}" GOFLAGS="-p=2"
export GOTELEMETRY=off

BUILD="$WORK/build"

fetch() {
  mkdir -p "$BUILD"
  cp "$HERE/main.go" "$BUILD/main.go"
  cat > "$BUILD/go.mod" <<EOF
module vizlokidiff

go 1.26.10

require github.com/grafana/loki/v3 $LOKI_VERSION

// The replace directives of Loki's go.mod (they do not apply to dependents).
replace github.com/Azure/azure-sdk-for-go => github.com/Azure/azure-sdk-for-go v68.0.0+incompatible
replace github.com/Azure/azure-storage-blob-go => github.com/MasslessParticle/azure-storage-blob-go v0.14.1-0.20240322194317-344980fda573
replace github.com/gocql/gocql => github.com/grafana/gocql v0.0.0-20200605141915-ba5dc39ece85
exclude k8s.io/client-go v8.0.0+incompatible
replace github.com/hashicorp/memberlist => github.com/grafana/memberlist v0.3.1-0.20260921102813-8c522db348af
replace github.com/grafana/regexp => github.com/grafana/regexp v0.0.0-20250905093917-f7b3be9d1853
// Loki replaces its push module with ./pkg/push; the same commit, as a module version:
replace github.com/grafana/loki/pkg/push => github.com/grafana/loki/pkg/push $PUSH_VERSION
replace github.com/influxdata/go-syslog/v3 => github.com/leodido/go-syslog/v4 v4.6.0
replace github.com/thanos-io/objstore => github.com/grafana/objstore v0.0.0-20250728171719-b5d3b766d1b0
EOF
  (cd "$BUILD" && go mod tidy)
}

case "${1:-}" in
fetch)
  fetch
  ;;
build)
  fetch
  (cd "$BUILD" && go build -o "$WORK/lokidiff" .)
  echo "built $WORK/lokidiff against grafana/loki $LOKI_VERSION"
  ;;
run)
  "$WORK/lokidiff" "$2" "$3"
  ;;
probe)
  "$WORK/lokidiff" probe "$2" "$3"
  ;;
clean)
  chmod -R u+w "$WORK" 2>/dev/null || true
  rm -rf "$WORK"
  ;;
*)
  echo "usage: $0 fetch|build|run <cases> <report>|clean" >&2
  exit 2
  ;;
esac
