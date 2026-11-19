#!/bin/sh
# Fetches Grafana Tempo's TraceQL query examples at the pinned release into testdata/upstream/
# (git-ignored). They are used ONLY as a behavioural oracle: which queries Tempo accepts,
# rejects at parse time, rejects at validation, or marks unsupported. Tempo is AGPL-3.0;
# these files are never committed and never consulted for implementation strategy.
set -eu
TAG=v3.1.1
COMMIT=9db7df79d2af105a90d96484e6403e1fda0d011e
cd "$(dirname "$0")/.."
mkdir -p testdata/upstream
curl -fsS -o testdata/upstream/test_examples.yaml \
  "https://raw.githubusercontent.com/grafana/tempo/$COMMIT/pkg/traceql/test_examples.yaml"
echo "$TAG $COMMIT" > testdata/upstream/REF
echo "fetched test_examples.yaml at $TAG ($COMMIT)"
