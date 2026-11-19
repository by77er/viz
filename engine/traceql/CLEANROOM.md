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
2. **The earlier viz TraceQL crate was not read.** It was removed from the tree in the
   commit the brief named (`6b5e5bb`), and the owner later removed it, and the Tempo checkout
   it came with, from the repository history altogether. No `git show`, `git log -p` or
   checkout of an older `engine/traceql` was run, and no copy of it on GitHub or in any
   scratch directory was opened. The only git commands run in this work were one
   `git log --oneline` (commit subjects) at the start, before the instruction not to run git
   was noticed, and later one `git status --short` whose output was discarded (a slip);
   neither reads file contents from history. One incident, for completeness: an `ls -la` of the path
   where the harness binary was to go printed the listing of a pre-existing directory of
   that name in the shared scratch area (file names `cases.json`, `diff_test.go`, `go.mod`,
   `go.sum`, `out1.txt`, `out2.txt` and sizes, dated the day before). No file in it was
   opened; all later work used a fresh subdirectory.
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

Dependencies (not Tempo): the source of the `regex` 1.13.2 and `regex-syntax` 0.8.12 crates
(MIT/Apache-2.0) in the local cargo registry, read for their default limits (compiled size
10 MiB, lazy-DFA cache 2 MiB, nesting 250) when the regex limits were set.

### Follow-up of 2026-11-19: regex dialect and nesting bound

The same rules held (one engineer, an AI agent, Claude). Tempo's source was not read; no git
command was run. Sources added:

| Source | Used for |
|---|---|
| https://grafana.com/docs/tempo/latest/traceql/construct-traceql-queries/ (fetched again) | its statements on regexes: "TraceQL uses Golang regular expressions", regexes "are treated as fully anchored" |
| Tempo v3.1.1 through `tools/godiff`, rebuilt from the Go module proxy in a scratch directory (`GOMODCACHE`, `GOCACHE` outside the repository; deleted afterwards) | the regex probes: `tools/probes/regex_dialect.py` built one trace whose spans carry 70 subject strings and ran 289 patterns in four query forms (plain, `\|\|`, structural, `!~`); the answers are recorded in `testdata/regex_dialect.json` (Tempo's output on viz's data, not Tempo material) |
| `go doc regexp/syntax` and Go 1.24.7's `regexp` run as a black box (scratch programs) | Go's dialect, which Tempo's answers matched (`engine/goregex/CLEANROOM.md`) |
| Tempo's example list (`tools/fetch_tempo_tests.sh`, git-ignored) | as before, accept/reject oracle; also measured for nesting depth with `nesting()` (query strings only) |

The regex translation itself lives in `engine/goregex` (shared with viz-logql), whose
`CLEANROOM.md` lists its own sources.

## Fetched at test time (never committed)

| What | From | Where it lives | Use |
|---|---|---|---|
| `pkg/traceql/test_examples.yaml` at the pinned commit | `https://raw.githubusercontent.com/grafana/tempo/9db7df79d2af105a90d96484e6403e1fda0d011e/pkg/traceql/test_examples.yaml` by `tools/fetch_tempo_tests.sh` | `testdata/upstream/` (git-ignored by `engine/traceql/.gitignore`) | oracle: lists of queries Tempo accepts, rejects at parse, rejects at validation, or calls unsupported; `tests/conformance.rs` reads only the query strings and which list each is in |
| Tempo module and its dependencies at the pinned version, toolchain go1.27.3 | Go module proxy | `GOMODCACHE`/`GOCACHE` in a scratch directory outside the repository, deleted after use | building `tools/godiff` |

## What was learned from observed behaviour

Tempo was run only through `tools/godiff` (its exported API over a vParquet5 block). Two
kinds of observation shaped the code:

- **Probes** (`tools/probes/`): small hand-made data sets and targeted queries, written
  while building the engine, to settle what the documentation leaves open: operator
  precedence, comparison of missing and mixed-type values, array matching, event and link
  scoping, structural operators over incomplete traces, result keys and value encodings,
  the metrics time grid, empty points, `by` labels, log2 buckets and quantile
  interpolation, request alignment. `README.md`, "Semantics settled by observing Tempo",
  lists each rule with the query that showed it.
- **The differential run** (`tests/differential.rs`, `tools/compare.py`): generated data and
  queries; every difference was either fixed in viz or explained by a rule checked against
  the data (`README.md`, section 2).

Nothing was inferred from Tempo's source, and the Tempo-specific defects listed in the
README were established only from its answers.

### Follow-up of 2026-11-19: the regex corpus's metadata (PR #4 review nit)

The `about` and `tempo` fields of `testdata/regex_dialect.json` were rewritten from the file
itself (its subjects, patterns and recorded answers), `tools/probes/regex_dialect.py` and
`tools/godiff/` (`README.md`, `go.mod`): viz's own files. No Tempo source was read and Tempo
was not run again; the recorded answers are unchanged. `engine/goregex`'s group-name rule was
checked against Go's documentation and Go run as a black box (`engine/goregex/CLEANROOM.md`).
For a conformance run, Tempo's `test_examples.yaml` was fetched by `tools/fetch_tempo_tests.sh`
into a scratch copy of this crate, used as an accept/reject oracle, and deleted with the copy.

## Statement

I followed the rules above for the whole of this work: I did not read Tempo's
implementation source or the earlier viz TraceQL crate; I used Tempo's tests only as an
accept/reject oracle fetched at test time into a git-ignored directory; I ran Tempo only as
a separate, test-only program built from the Go module proxy at the pinned release; and
nothing from Tempo is stored in this crate.
