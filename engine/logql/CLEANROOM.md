# Clean-room record for `viz-logql`

viz is Apache-2.0. Grafana Loki, LogQL's reference implementation, is AGPL-3.0. This crate
was written clean-room: from Loki's public documentation and from Loki's behaviour observed
by running it as a black box, **without reading Loki's implementation source** (its Go code
for `pkg/logql`, the syntax package, the log pipeline, the parsers or the template
functions), on GitHub or anywhere else. Nothing in this crate is copied, transcribed or
ported from Loki.

Session: 2026-11-19. Loki version used as a black box: **v3.7.10** (tag commit
`c792f58577a46c64b0a8e808d7c643ed0e8c5e83`, released 2026-11-13).

## Rules followed

1. Loki's implementation source was not read. Loki's module was downloaded by the Go
   toolchain into a scratch module cache only to compile the differential harness; no file
   of it was opened. The pruning step of the harness build used `go list -deps` output
   (module paths and versions only).
2. Documentation was paraphrased, never copied into code or docs here. Short error strings
   and label names that Loki *returns* (for example `JSONParserErr`, `logfmt syntax error at
   pos N : unexpected '='`, `pipeline error: '…' for series: …`) were learned by observing
   Loki's responses and are reproduced as observed behaviour.
3. Loki's own tests were used **only as a behavioural oracle**: fetched at test time by
   `tools/oracle/fetch.sh` into `testdata/loki-oracle/` (git-ignored by
   `engine/logql/.gitignore`), turned into "accepted / rejected" and "this stage over this
   line and these labels gives this line and labels" expectations by `tools/oracle/extract.go`
   (Go standard library `go/parser`; it compiles nothing of Loki), and never committed. The
   `exp` fields (expected syntax trees) are ignored. To write the extractor, the field
   declarations of the test tables and the body of one test (how `TestLogfmtParser_parse`'s
   strict variant treats an empty `wantStrict`) were read; that is test-harness semantics,
   not implementation. No test was consulted for implementation strategy or data structures.
4. The differential harness (`tools/lokidiff/`) builds Loki's query engine at the pinned tag
   as a separate program, fetched through the Go module proxy into a scratch directory
   (`$LOKIDIFF_WORK`), calls it only through its exported API as documented on pkg.go.dev,
   and is never committed or shipped. Its README says that it links AGPL code and is
   test-only. No viz artifact contains or links it.
5. Reused instead of reimplemented: `engine/promql` (`viz-promql`, Apache-2.0, part of viz)
   evaluates vector aggregations, binary operators, `label_replace` and `vector()`.

## Sources consulted

### Loki documentation (grafana.com, fetched this session)

| Page | URL |
|---|---|
| Query Loki (overview) | https://grafana.com/docs/loki/latest/query/ and https://grafana.com/docs/loki/v3.7.x/query.md |
| Log queries | https://grafana.com/docs/loki/latest/query/log_queries/ and https://grafana.com/docs/loki/v3.7.x/query/log_queries.md |
| Metric queries | https://grafana.com/docs/loki/latest/query/metric_queries/ and https://grafana.com/docs/loki/v3.7.x/query/metric_queries.md |
| LogQL template functions | https://grafana.com/docs/loki/latest/query/template_functions/ and https://grafana.com/docs/loki/v3.7.x/query/template_functions.md |
| Matching IP addresses | https://grafana.com/docs/loki/latest/query/ip/ and https://grafana.com/docs/loki/v3.7.x/query/ip.md |
| Query examples | https://grafana.com/docs/loki/latest/query/query_examples/ and https://grafana.com/docs/loki/v3.7.x/query/query_examples.md |
| LogQL (older overview pages with the binary-operator, pipeline-error and pattern-match-filter sections) | https://grafana.com/docs/loki/v3.0.x/query/ and https://grafana.com/docs/loki/v3.2.x/query/ |
| Log queries, older versions (checked for the `|>` / `or` filter forms) | https://grafana.com/docs/loki/v3.0.x/query/log_queries.md, https://grafana.com/docs/loki/v3.3.x/query/log_queries.md, https://grafana.com/docs/loki/v3.5.x/query/log_queries.md |
| Loki HTTP API | https://grafana.com/docs/loki/latest/reference/loki-http-api/ and https://grafana.com/docs/loki/v3.7.x/reference/loki-http-api.md |
| Release notes 3.0 to 3.7 (LogQL changes) | https://grafana.com/docs/loki/latest/release-notes/v3-0/ … /v3-7/ |
| Documentation index | https://grafana.com/llms.txt (navigation only) |

### API documentation used to call Loki as a black box (pkg.go.dev, signatures and doc comments)

- https://pkg.go.dev/github.com/grafana/loki/v3/pkg/logql@v3.7.10 (`NewEngine`, `EngineOpts`,
  `NewLiteralParams`, `NewMockQuerier`, `NoLimits`, `Querier`, `Query`)
- https://pkg.go.dev/github.com/grafana/loki/v3/pkg/logproto@v3.7.10 (`Stream`, `Entry`,
  `Direction`), https://pkg.go.dev/github.com/grafana/loki/pkg/push (`Stream`, `Entry`,
  `LabelAdapter`)
- https://pkg.go.dev/github.com/grafana/loki/v3/pkg/util/marshal@v3.7.10
  (`WriteQueryResponseJSON`), https://pkg.go.dev/github.com/grafana/loki/v3/pkg/logqlmodel@v3.7.10
  (`Result`), https://pkg.go.dev/github.com/grafana/loki/v3/pkg/util/httpreq@v3.7.10
- https://pkg.go.dev/github.com/grafana/dskit/user (`InjectOrgID`)
- Also fetched, not used: the pkg.go.dev pages of `pkg/logql/syntax`, `pkg/logql/log`,
  `pkg/logql/log/pattern` and `pkg/iter` at v3.7.10.
- Module metadata from the Go module proxy: `https://proxy.golang.org/github.com/grafana/loki/v3/@v/list`,
  `…/@v/v3.7.10.info`, `…/@v/v3.7.10.mod` (the go.mod: Go version and `replace` directives,
  repeated in the harness's generated go.mod), and
  `https://proxy.golang.org/github.com/grafana/loki/pkg/push/@v/c792f58577a46c64b0a8e808d7c643ed0e8c5e83.info`.

### Other specifications

- Go's `text/template`, `fmt`, `strconv`, `time` and `regexp/syntax` package documentation
  (Go is BSD-licensed; its documented behaviour was used for the template engine, `printf`,
  number parsing and printing, duration and layout handling, and the RE2 dialect). Not
  fetched this session; from knowledge of the published documentation.
- The documented behaviour of go-humanize's `ParseBytes` and of the Sprig functions that
  Loki's template documentation lists (both MIT); no code of either was copied.
- RFC 8259 (JSON), ECMA-48 (ANSI escape sequences), the logfmt convention.

### Loki's behaviour, observed

- 14 probe files (about 320 queries over hand-made data, `tools/lokidiff` in probe mode)
  established details the documentation leaves open: window edges, error-label wording and
  precedence, parser corner cases, label-name sanitising, pattern-filter anchoring, the
  order Loki runs `__error__` filters and line filters after `decolorize`, `rate_counter`'s
  arithmetic, and where the oracle's mock querier differs from the HTTP API. The findings are listed in
  the README ("Verification" and "Differences from Loki") and noted in code comments where
  they shape the code.
- The differential run (`tools/lokidiff`, README "Verification").

### Loki's tests, as oracle only (fetched at test time, git-ignored, never committed)

From `https://raw.githubusercontent.com/grafana/loki/v3.7.10/`: `pkg/logql/syntax/parser_test.go`,
`pkg/logql/log/parser_test.go`, `pkg/logql/log/fmt_test.go`, saved in `testdata/loki-oracle/`
with the extracted `cases.json`. During development these were also fetched, listed by test
function name only, and deleted: `pkg/logql/log/label_filter_test.go`, `filter_test.go`,
`ip_test.go`, `drop_labels_test.go`, `keep_labels_test.go`, `pattern/pattern_test.go`,
`pkg/logql/syntax/lex_test.go`.

### Follow-up of 2026-11-19: the regex translator moved to `engine/goregex`

`src/goregex.rs` moved, with its tests, into the shared crate `engine/goregex`, which
viz-traceql uses too, and was extended there (one engineer, an AI agent, Claude). Its sources
are listed in `engine/goregex/CLEANROOM.md`: Go's `regexp/syntax` documentation, Go's
`regexp` run as a black box, and Tempo v3.1.1 run as a black box. No Loki source was read and
Loki was not run in this follow-up (the Loki harness was not rebuilt). Loki's three test files
were fetched again by `tools/oracle/fetch.sh` into the git-ignored `testdata/loki-oracle/` and
used as before, as an accept/reject and expected-output oracle. No git command was run.

## Statement

I followed the rules above. I did not read Loki's implementation source. Where this crate
matches Loki in a detail the documentation does not state, the detail was observed from
Loki's responses or taken from its test tables' expected results, and is recorded as such in
the code comments and the README.
