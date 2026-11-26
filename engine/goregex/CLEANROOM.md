# Sources for `viz-goregex`

viz is Apache-2.0. This crate reproduces the regular-expression dialect of Go's `regexp`
package (Go is BSD-3-Clause, a compatible licence) as Tempo (AGPL-3.0) and Loki (AGPL-3.0)
use it. Nothing in it is copied, transcribed or ported from Go, Tempo or Loki. It started as
`engine/logql/src/goregex.rs` (written clean-room for viz-logql, `engine/logql/CLEANROOM.md`)
and was moved here and extended on 2026-11-19 by one engineer (an AI agent, Claude).

## Rules followed

1. **No Tempo or Loki source was read.** Tempo was run only as a separate program
   (`engine/traceql/tools/godiff`, built at test time in a scratch directory from the Go module
   proxy, deleted afterwards), on probe data (`engine/traceql/tools/probes/regex_dialect.py`).
   No file of Tempo's or Loki's module was opened, listed for content or searched.
2. **Go's `regexp` was used as documentation and as a black box.** Its source was not opened in
   this work. Its behaviour was observed by running small programs against the local Go 1.24.7
   standard library (scratch directory, not committed) and `tools/godiff` here.
3. Behaviour was paraphrased into rules and tests; error wording follows the messages Go
   returns (observed), not its code.

## Sources consulted

| Source | Used for |
|---|---|
| `go doc regexp/syntax` (Go 1.24.7, local) | the syntax: Perl classes as ASCII sets (`\s` = `[\t\n\f\r ]`), ASCII classes, escapes (`\123` octal "up to three digits", `\x7F`, `\x{10FFFF}`, `\Q…\E`, "`\*` literal `*`, for any punctuation character"), flags `i m s U`, `(?P<name>…)` and `(?<name>…)`, and "the counting forms `x{n,m}`, `x{n,}`, and `x{n}` reject forms that create a minimum or maximum repetition count above 1000" |
| `go doc unicode.Version` (local) | Go 1.24.7's Unicode tables are 15.0.0 |
| Go 1.24.7's `regexp`, run as a black box (scratch programs) | the rules the documentation leaves open: a single-digit octal is refused, a `{` that starts no repetition (including a leading zero, `{01}`) is literal, 8-digit counts are refused, nested counts multiply (`(?:x{2}){500}` accepted, `{501}` refused; `(?:x{1000}){0,1}` accepted, `{1,2}` refused), a repetition after an empty construct (`a(?i)*`) repeats the atom before it, assertions repeat (`^*`), `(?P<1>a)` and repeated names are accepted, `[[:a]` is literal while `[[:a]b:]` is refused, `-` after a class escape is literal, surrogate escapes and their engine-dependent answers |
| Tempo v3.1.1 via `engine/traceql/tools/godiff`, black box | that TraceQL's `=~` is Go's dialect, fully anchored with `.` matching `\n`, anchored on the parsed pattern (`\Qa)` matches `a)`; `a)|(b` is refused), and the 289 answers in `engine/traceql/testdata/regex_dialect.json` |
| https://grafana.com/docs/tempo/latest/traceql/construct-traceql-queries/ | "TraceQL uses Golang regular expressions"; regexes "are treated as fully anchored" |
| `regex-syntax` 0.8.12 (MIT/Apache-2.0) in the local cargo registry | only the header of a generated table, for its Unicode version (16.0.0) |
| Training knowledge (not re-checked against a document) | that Rust's `\p{Greek}` means Script Extensions and accepts loose names, the reason Unicode classes are not translated |

Go's parser rule for nested counts was first recalled from general knowledge of how Go
implements it; it was then established only from Go's documentation sentence above and the
black-box results listed, which are what the code and `tests/go_rules.rs` follow.

### Follow-up of 2026-11-19: group names and re-wrapping (PR #4 review nits)

Same rules, same engineer. No Tempo, Loki or Go implementation source was read.

| Source | Used for |
|---|---|
| https://pkg.go.dev/regexp/syntax (the page documents go1.27.4) and `go doc -all regexp/syntax` (Go 1.24.7, local) | `(?P<name>re)` and `(?<name>re)` are "named & numbered capturing group"; the error code `invalid named capture`. Neither says which names are valid or whether one may start with a digit |
| `go doc regexp.Regexp.SubexpIndex` and `SubexpNames` (local) | "multiple subexpressions can be written using the same name, as in `(?P<bob>a+)(?P<bob>b+)`" |
| Go 1.24.7's `regexp`, run as a black box (a scratch program printing `Compile`'s error or `SubexpNames` for 58 patterns, not committed) | a name is one or more of `[A-Za-z0-9_]`: `1`, `0`, `123`, `1a`, `01`, `_` are accepted; `é`, `١`, `a.b`, `a b`, `a-b`, `a[0]` and the empty name are refused; a repeated name is accepted; `(?<=a)` and `(?<!a)` are refused as `invalid named capture` (not as Perl syntax); a pattern ending in `(?P<` or `(?<` is refused as Perl syntax; the wording of each refusal; and the answers of four nested re-wrap patterns (three of them, `(?:a*(?i)*)*(?i)*` among them, are in `tests/go_rules.rs`) |
| `tools/godiff` (Go 1.24.7, standard library), extended to compare group names with `SubexpNames` | 100,000 generated patterns, with group-name tokens (README, Verification) |
| `engine/traceql/testdata/regex_dialect.json` (Tempo v3.1.1's recorded answers, no Tempo code) | Tempo accepts `(?P<1>a)` and `(?P<a>x)(?P<a>y)` and refuses `(?P<é>a)` and `(?P<a.b>x)` |

The review note said a name that starts with a digit is an error in Go; the documentation does
not say so and both black boxes accept it, so the rule followed is the observed one. That Go
accepts `[A-Za-z0-9_]+`, a leading digit included, was also recalled from general knowledge of
Go before the probes; as with nested counts above, the rule was established only from the
black-box results listed, which are what the code and `tests/go_rules.rs` follow.

## Statement

I followed the rules above: I did not read Tempo's, Loki's or Go's implementation source in
this work; Tempo and Go were run only as separate programs at test time; nothing from them is
stored in this crate.
