# viz-goregex

Go's regular expressions (Go's `regexp` package, RE2 syntax) on Rust's `regex` crate. TraceQL
and LogQL both define their regexes as Go's, and Tempo and Loki compile them with Go's
`regexp`; `engine/traceql` and `engine/logql` compile every pattern through this crate, so
the two engines share one dialect. No I/O; native and `wasm32-unknown-unknown`. The only
dependency is `regex` (MIT/Apache-2.0) with `std`, `perf` and `unicode-case`.

```rust
use viz_goregex::{compile, translate, Limits, Wrap};

let re = compile(r"\w+\.\d{1,3}", Wrap::Anchored, false, &Limits::default())?; // ^(?s:…)$, ASCII \w \d
let rust = translate(r"\Qa.b\E", true)?;                                      // "a\.b"
```

| Item | Purpose |
|---|---|
| `translate(pattern, names) -> Result<String, Error>` | Go pattern to Rust pattern with the same meaning, or Go's refusal. `names = false` turns named groups into plain ones (Go accepts names Rust does not: `1`, a repeated name) |
| `compile(pattern, Wrap, names, &Limits)` | Translate, wrap (`Plain`, `DotNl` = `(?s:…)`, `Anchored` = `^(?s:…)$`) and build with size, lazy-DFA and nesting limits |
| `compile_anchored`, `compile_unanchored`, `compile_plain` | The forms viz-logql uses (names kept, `Limits::default()`: 16 MiB compiled, 2 MiB cache, 250 levels) |
| `Error::Invalid(msg)`, `Error::Unsupported(msg)` | Go refuses it (or it exceeds a limit); valid in Go but not translated |

## Implemented

The translator is one left-to-right pass with an explicit group stack: no recursion over the
pattern, linear time. Each rule below was checked against Go's `regexp` (black box) and, for
TraceQL, against Tempo v3.1.1 (black box, `engine/traceql/testdata/regex_dialect.json`).

| Go | Rust needs | Translation |
|---|---|---|
| `\d \w \s` ASCII (`\s` = `[\t\n\f\r ]`, no `\v`); `\D \W \S` | Unicode-aware by default | explicit ASCII classes, inside classes too (`[^\D]` = `\d`) |
| `\b \B` ASCII word boundary | Unicode | `(?-u:\b)`, `(?-u:\B)` |
| `\Q…\E` literal (to the end without `\E`) | unsupported | escaped literals, one atom per character |
| octal `\0`, `\012`, `\101` (a single `\1`–`\7` is refused) | unsupported | `\x{…}` |
| escaped ASCII punctuation is literal (`\<`, `\>`, `\_`, `\%`, `\ `) | `\<` `\>` are word boundaries | the literal |
| `{` that does not start `{n}`, `{n,}`, `{n,m}` (no leading zeros) is literal: `x{,5}`, `x{01}`, `a\b{start}` | an error, or `\b{start}` | `\{` |
| `[`, `&&`, `~~`, `--` in a class are literal; `-` after a class escape is literal (`[\d-z]`) | nested classes, set operations, a range error | every class member escaped (`\x{…}`) |
| `[:name:]` up to the next `:]`; an unknown name is an error | | validated, copied |
| flags `i m s U`, repeated or cancelled (`(?ii)`, `(?i-i)`), empty `(?)` | a repeated flag is an error | normalised (last mention wins) or dropped |
| a repetition after an empty construct repeats the atom before it (`a(?i)*`, `a*\Q\E*`); assertions repeat (`^*`, `\b+`) | an error | the atom wrapped in `(?:…)`, the flag group moved after it |
| a surrogate code point (`\x{D800}`) matches U+FFFD; in a class a single one does, a range of them matches nothing | not a scalar value | `\x{FFFD}`, or cut out of ranges |
| refuses: flags other than `i m s U` (`(?x)`, `(?u)`), `\u`, `\U`, `\e`, `\Z`, `\cA`, `\N`, `\C`, `\8`, `\1`; `\Q`, `\E` or `\b` in a class; stacked repetitions (`a**`, `x{2}{3}`, `x*??`, `a?*`); counts above 1000 and nested counts whose product is above 1000 (`(?:a{10}){101}`); `[a-\d]`, `[z-a]`; group names other than `[A-Za-z0-9_]+`; unbalanced parentheses | most of these are accepted | `Error::Invalid` with Go's wording |

Unbalanced parentheses are refused by the translator itself, so a caller that wraps the
result (`^(?s:` … `)$`) cannot turn `a)|(b` into a valid, differently anchored pattern; an
unterminated `\Q` is translated to escaped literals for the same reason (Tempo matches `\Qa)`
against `a)`).

## Not implemented

- **Unicode classes** (`\pL`, `\p{Greek}`, `\PN`, `[\p{L}]`): `Error::Unsupported`. Go accepts
  only its own names (case-sensitive; `\p{greek}` is an error in Tempo) and means Script by a
  script name, while Rust accepts loose names and means Script Extensions; the tables also
  add to the WASM module. Translating them would need Go's name list and Unicode version.
- Go's nesting depth bound (1000) and its "expression too large" check are not reproduced;
  callers set `Limits::nest` and `Limits::size`, which are stricter (TraceQL: 64 levels and
  1 MiB; LogQL: 250 levels and 16 MiB), so a pattern Go accepts can be refused here.
- Surrogate escapes: Go's own answer depends on the shape of the pattern (`\x{D800}` and
  `[\x{D800}a]` match U+FFFD; `^\x{D800}` and `[\x{D800}ſA]` do not, Go 1.24). This crate
  applies one rule (a single surrogate matches U+FFFD), which agrees with Tempo on the simple
  forms; the differential run lists the other shapes apart (below).

## Verification

Measured here: Linux x86-64, 4 shared cores (load average 5 to 10), rustc 1.97.0, Go 1.24.7
(standard library only). Not on Cloudflare.

`cargo test -j 2 --offline`: unit tests 3 (moved from viz-logql with the translator),
`tests/go_rules.rs` 9 (each rule above, with Go's and Tempo's answers; Unicode classes are
Unsupported; surrogates; a 128 KiB pathological input), the doc build; the Go differential
exporter is `#[ignore]`d. All pass.

**Differential run against Go's `regexp`** (`tests/go_differential.rs` writes generated
patterns with this crate's answers; `tools/godiff` (Go standard library only, built at test
time) compiles each pattern with Go and runs it fully anchored on 53 subjects):

```sh
GOREGEX_DIFF_OUT=$SCRATCH/cases.json GOREGEX_DIFF_SEED=1 GOREGEX_DIFF_N=20000 \
  cargo test --release --test go_differential -- --ignored
(cd tools/godiff && go run . $SCRATCH/cases.json)
```

| Seeds | Patterns | Both accept, identical matches | Both refuse | Unsupported here (Go refuses) | Surrogate shapes | **Differ** |
|---|---:|---:|---:|---:|---:|---:|
| 1–5, 20,000 each | 100,000 | 36,388 | 60,005 | 3,542 (1,551) | 65 | **0** |

Patterns are 1–7 tokens drawn from everything the translator treats specially (classes,
escapes, flags, counts, `\Q…\E`, stray brackets); subjects include ASCII, Latin, Greek,
Arabic-Indic digits, the Kelvin sign and long s, control characters and U+FFFD. Go's side
anchors with `^(?s:` + pattern + `)$` and `MatchString`, which is what Tempo's answers agree
with, and falls back to a leftmost-longest match spanning the subject only where an
unterminated `\Q` makes the wrapped text invalid. Two problems were found on the way, both in
the harness, not the translator: the textual wrapper breaks on an unterminated `\Q`, and Go's
leftmost-longest search disagrees with its own `MatchString` on surrogate escapes (which is
how the surrogate-shape class was found). The generator first lacked the `\u0041` token (an
editing slip turned it into `A`); the run above is the one after it was restored.

**Against Tempo** (through `engine/traceql`, which uses this crate): 289 patterns on 70
subjects, recorded from Tempo v3.1.1; viz gives the same answer for all of them except the
Unicode-class patterns, which are Unsupported by design (`engine/traceql/README.md`).

**viz-logql's results are unchanged** by the move: its suites pass with the same counts, its
oracle conformance table is identical (371 pass, 10 pinned failures), and its differential
exports for the five seeds of its README are byte-identical before and after
(`engine/logql/README.md`).

**Linear time.** The translator viz-logql had before searched the rest of the pattern for `:]`
at every `[:` inside a class, so a 128 KiB pattern `[[:a[:a…]` cost O(n²) (measured: see
`engine/logql/README.md`); this one keeps one forward search position. A repetition that
re-wraps the same atom (`a*(?i)*(?i)*…`) is refused after 1000 wraps, as Go refuses nesting
deeper than 1000.

**WebAssembly.** Built inside `engine/traceql/tools/wasm-probe` and
`engine/logql/wasm-check` (0 imports in both; their READMEs have the numbers). TraceQL's
module no longer links the Unicode Perl-class tables.

**Mutation checks** are run from the two engines' scripts on scratch copies (this crate is
copied next to the engine's copy): `engine/traceql/tools/mutate.py` mutants 27–32 change this
crate and are run against its own suite too (Unicode `\d \w \s`, Unicode `\b`, the nested-count
bound dropped, `{` as an error, parentheses unbalanced: all caught by `tests/go_rules.rs` or the
unit tests and by TraceQL's Tempo test; mutant 31, one of the two balance checks removed, is
equivalent and survives); `engine/logql/tools/mutate.py` mutant 30 (nesting limit lifted:
caught by LogQL's `limits` and `props`).

## Known risks

- The rules come from Go 1.24's behaviour and Tempo v3.1.1's. A later Go release could change
  an edge (Go added `(?<name>…)` in 1.22); the differential run would show it.
- Case folding is Rust's simple case folding, which agreed with Go on every probe (Kelvin sign,
  long s, ß/ẞ, final sigma, Ohm sign, titlecase digraphs, dotted and dotless i). The Unicode
  versions differ: Go 1.24.7's tables are 15.0.0 (`go doc unicode.Version`), `regex-syntax`
  0.8.12's are 16.0.0 (its table headers); characters assigned in between can fold differently.
  The version of the Go toolchain Tempo v3.1.1 builds with (1.27.3) was not checked.
- The `regex` crate's size limit is counted in its own memory units, which depend on pointer
  width: in wasm32 a pattern about twice as large fits under the same limit as natively.

## Layout

```
src/lib.rs                 translator, compile, limits; unit tests (moved from viz-logql)
tests/go_rules.rs          the rules, with Go's and Tempo's answers
tests/go_differential.rs   exporter for the differential run against Go (ignored test)
tools/godiff/              Go side of that run (standard library only; BSD-licensed Go)
```

The crate has its own `[workspace]` table so that it builds standalone.
