# godiff: Grafana Tempo as a black-box oracle

**This harness links Grafana Tempo, which is AGPL-3.0.** It is a test tool only. It is
fetched and built at test time through the Go module proxy, it is never part of any viz
artifact, and no Tempo code is stored in this repository (only `go.mod`/`go.sum`, which
name the version). It was written against Tempo's exported Go API as documented on
pkg.go.dev, without reading Tempo's implementation (`../../CLEANROOM.md`).

Pinned release: **Tempo v3.1.1**, commit `9db7df79d2af105a90d96484e6403e1fda0d011e`, Go
module version `github.com/grafana/tempo v1.5.1-0.20261021152436-9db7df79d2af` (Tempo's
`go.mod` declares `module github.com/grafana/tempo`, so its release tags are reachable only as
pseudo-versions). Tempo's `go 1.27.3` line makes the Go command fetch toolchain go1.27.3.

What it does, per data set in the case file: converts the spans to OTLP protobuf traces
(Tempo's own `tempopb` types), writes them into a real **vParquet5** block with the local
backend (`vparquet5.CreateBlock`), opens the block (`encoding.OpenBlock`), and evaluates every
case with Tempo's engine over the block's fetcher, as a querier does:

- search: `traceql.NewEngine().ExecuteSearch`;
- metrics: `CompileMetricsQueryRange` (raw, over the block) then
  `CompileMetricsQueryRangeNonRaw(…, AggregateModeFinal)` (the frontend's final stage), for
  range and instant (`QueryRangeRequest.Instant`) requests.

It writes Tempo's responses with gogo `jsonpb`, and decodes viz's own JSON for each case
into Tempo's `SearchResponse` / `QueryRangeResponse` with unknown fields rejected (an
independent reader of viz's output). `-probe` prints Tempo's request alignment and default
step for a few ranges.

```sh
# from engine/traceql; caches outside the repository, 2 CPUs (shared machine)
export GOMODCACHE=$SCRATCH/gomod GOCACHE=$SCRATCH/gocache GOPATH=$SCRATCH/gopath \
       GOMAXPROCS=2 GOFLAGS=-p=2 GOTOOLCHAIN=auto
(cd tools/godiff && go build -o $SCRATCH/godiff .)          # ~8 min here; largest process 916 MB
VIZ_DIFF_OUT=$SCRATCH/cases.json VIZ_DIFF_SEED=1 VIZ_DIFF_DATASETS=10 VIZ_DIFF_QUERIES=60 \
  VIZ_DIFF_DEPTH=0 cargo test --release --test differential -- --ignored
$SCRATCH/godiff -cases $SCRATCH/cases.json -out $SCRATCH/tempo.json
python3 -I tools/compare.py $SCRATCH/cases.json $SCRATCH/tempo.json
```

Delete `$SCRATCH/gomod`, `$SCRATCH/gocache` and the binary afterwards; the module cache
holds Tempo's source (about 1.1 GB with dependencies).
