# Clean-room record for `viz-traceql`

viz is Apache-2.0. Grafana Tempo, the reference implementation of TraceQL, is AGPL-3.0. This
crate is a clean-room implementation: it was written from Tempo's public documentation and
from Tempo's behaviour observed by running it as a black box. This file is the record that
the licensing decision (D35, root `AGENTS.md` "Licensing") relies on.

Author: one engineer (an AI agent, Claude), 2026-11-19, working alone on this crate.

## Rules followed

1. **Tempo's implementation source was not read.** No Go file of Tempo's parser, grammar,
   lexer, evaluator or storage was opened, on GitHub or anywhere else, and no file of Tempo's
   module (downloaded into the Go module cache to build the black-box harness) was opened,
   listed for content, searched or diffed. The harness was written against the exported API
   as documented on pkg.go.dev (signatures and doc comments only).
2. **The earlier viz TraceQL crate was not read.** It was removed in commit `6b5e5bb`; no
   `git show`, `git log -p` or checkout of `engine/traceql` before that commit was run, and
   no copy of it on GitHub or in any scratch directory was opened. (One incident, recorded
   for completeness: a mistyped `ls` of a path in the shared scratch area printed a directory
   listing of an unrelated older harness directory, file names and sizes only; no file in it
   was opened, and the path was not used again.)
3. **Tempo's tests were used only as a behavioural oracle**, fetched at test time into a
   git-ignored directory, at the level "this query is accepted / rejected at parse /
   rejected at validation / unsupported". No test was consulted for implementation strategy
   or internal structure; AST-shape and internal-structure tests were not fetched.
4. **Tempo was run only as a separate program** (`tools/godiff`), built at test time from
   the Go module proxy at a pinned release, never committed and never part of any viz
   artifact. Its answers on generated data are the "observed behaviour" referred to below.
5. Documentation was paraphrased, never copied. No grammar, table or text from Tempo is in
   this crate.

## Pinned Tempo release (black box)

- Tag **v3.1.1**, commit `9db7df79d2af105a90d96484e6403e1fda0d011e` (resolved from the tag
  with an HTTP request to `https://github.com/grafana/tempo.git/info/refs?service=git-upload-pack`,
  which lists refs; no source was fetched that way).
- Go module version `github.com/grafana/tempo v1.5.1-0.20261021152436-9db7df79d2af`
  (Tempo's go.mod declares `module github.com/grafana/tempo`, so release tags are reachable
  only as pseudo-versions). Its `go 1.27.3` line makes the Go command fetch toolchain
  go1.27.3 through the module proxy.
- Fetched by `go mod tidy` / `go build` in `tools/godiff` with `GOMODCACHE` and `GOCACHE`
  pointed at a scratch directory outside the repository, deleted after use.

## Sources consulted

Public documentation (read, paraphrased):

| URL | Used for |
|---|---|
| https://grafana.com/docs/tempo/latest/traceql/ | overview |
| https://grafana.com/docs/tempo/latest/traceql/construct-traceql-queries/ | the language: intrinsics, scopes, quoted names, literals, operators, spanset operators, structural operators, aggregates, `by`, `select`, arithmetic, arrays, `nil`, `most_recent` |
| https://grafana.com/docs/tempo/latest/traceql/trace-structure/ | query model (one trace at a time, spansets, limits) |
| https://grafana.com/docs/tempo/latest/traceql/tune-traceql-queries/ | unscoped attributes, trace-level intrinsics, sampling hint |
| https://grafana.com/docs/tempo/latest/metrics-from-traces/metrics-queries/ | TraceQL metrics overview, exemplars, comparisons, arithmetic |
| https://grafana.com/docs/tempo/latest/metrics-from-traces/metrics-queries/functions/ | metrics functions, `by`, `topk`/`bottomk`, comparisons, arithmetic between metrics queries and scalars, NaN rules, sampling hints, `compare` |
| https://grafana.com/docs/tempo/latest/metrics-from-traces/metrics-queries/configure-traceql-metrics/ | limits (max duration) |
| https://grafana.com/docs/tempo/latest/metrics-from-traces/metrics-queries/sampling-guide/ | sampling hints |
| https://grafana.com/docs/tempo/latest/api_docs/ | HTTP API: `/api/search` parameters and response shape, `/api/metrics/query_range` and `/api/metrics/query` parameters |
| https://grafana.com/docs/tempo/v2.9.x/traceql/construct-traceql-queries/ | older wording of the same page (compared with latest) |
| https://grafana.com/docs/tempo/v2.6.x/traceql/ | older reference page: unscoped attributes (`.name`) |
| https://grafana.com/docs/tempo/v2.4.x/traceql/ | older reference page: unscoped intrinsics (`status`, `duration`, `name`, `kind`, `statusMessage`, `traceDuration`, `rootName`, `rootServiceName`) |

Go package API documentation on pkg.go.dev, version `v1.5.1-0.20261021152436-9db7df79d2af`
(signatures and doc comments only, to call Tempo from the harness):

| URL | Used for |
|---|---|
| https://pkg.go.dev/github.com/grafana/tempo@v1.5.1-0.20261021152436-9db7df79d2af/pkg/traceql | `Engine.ExecuteSearch`, `CompileMetricsQueryRange`, `CompileMetricsQueryRangeNonRaw`, `AggregateMode*`, `MetricsEvaluator`, `MetricsFrontendEvaluator`, `SeriesSet.ToProto`, `SpansetFetcher`, `NewSpansetFetcherWrapperBoth`, `AlignRequest`, `DefaultQueryRangeStep` |
| …/pkg/tempopb, …/pkg/tempopb/trace/v1, …/pkg/tempopb/common/v1 | request and response types (`SearchRequest`, `SearchResponse`, `QueryRangeRequest`, `QueryRangeResponse`, `TimeSeries`, OTLP span types) |
| …/pkg/api | HTTP path names (to confirm endpoint paths) |
| …/tempodb/encoding, …/tempodb/encoding/vparquet5, …/tempodb/encoding/common, …/tempodb/backend, …/tempodb/backend/local | writing and opening a block: `vparquet5.CreateBlock`, `encoding.OpenBlock`, `common.Iterator`, `common.BlockConfig`, `common.DefaultSearchOptions`, `backend.NewBlockMeta`, `local.New` |

The pkg.go.dev index pages list every exported identifier of a package, including some whose
names hint at internals (for example exported helpers named after log2 buckets in
`pkg/traceql`). Their doc comments were not used for implementation; where this crate's
behaviour matches such a detail, it was established from Tempo's observed output in the
differential run, and the README says which outputs settled it.

Module metadata (no source): `https://proxy.golang.org/github.com/grafana/tempo/@v/*.info`
and `*.mod` (versions, the `go` and `replace` lines of Tempo's go.mod).

Other specifications: the OpenTelemetry trace data model and OTLP/JSON encoding
(https://opentelemetry.io/docs/specs/otel/trace/api/, https://opentelemetry.io/docs/specs/otlp/),
known from training and not re-fetched.

## Fetched at test time (never committed)

| What | From | Where it lives | Use |
|---|---|---|---|
| `pkg/traceql/test_examples.yaml` at the pinned commit | `https://raw.githubusercontent.com/grafana/tempo/9db7df79d2af105a90d96484e6403e1fda0d011e/pkg/traceql/test_examples.yaml` by `tools/fetch_tempo_tests.sh` | `testdata/upstream/` (git-ignored by `engine/traceql/.gitignore`) | oracle: lists of queries Tempo accepts, rejects at parse, rejects at validation, or calls unsupported; `tests/conformance.rs` reads only the query strings and which list each is in |
| Tempo module and its dependencies at the pinned version, toolchain go1.27.3 | Go module proxy | `GOMODCACHE`/`GOCACHE` in a scratch directory outside the repository, deleted after use | building `tools/godiff` |

## What was learned from observed behaviour

Recorded in `README.md`, "Differential run", with the queries that showed each point.
