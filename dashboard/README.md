# @viz/dashboard — the `viz.dashboard/v1` model

One dashboard model with three readers (DESIGN §8): the renderer, an agent, and a screen reader all work from
the same spec and the same data. This package is the model and everything that can be done to it without a
network or a DOM: schema, validation, lint, JSON Patch edits against a revision, fragment and variable
resolution, text digests, and Grafana import.

Pure TypeScript, ESM, **zero runtime dependencies**. Runs in Workers, browsers and Node. The source uses only
erasable TypeScript syntax, so Node ≥ 22.18 runs `src/` directly and bundlers need no plugin; there is no build
step.

```
npm test          # 316 tests, ~10 s
npx tsc --noEmit  # clean
```

## The spec at a glance

```jsonc
{
  "apiVersion": "viz.dashboard/v1",
  "metadata": {
    "id": "checkout_overview",
    "title": "Checkout — service overview",
    "intent": "On-call view for checkout. Answers: is checkout healthy, and if not, is it traffic, errors or latency?", // required
    "tags": ["checkout", "tier-1"]
  },
  "time": { "from": "now-6h", "to": "now", "refresh": "30s" },
  "variables": {
    "env":   { "kind": "enum", "values": ["prod", "staging"], "default": "prod" },
    "route": { "kind": "query", "query": { "lang": "promql", "expr": "label_values(http_server_requests_total{env=\"$env\"}, route)" },
               "multi": true, "includeAll": true, "default": "*" }
  },
  "queries": {                                  // named; panels refer to them by id
    "err_ratio": { "lang": "promql", "expr": "sum(rate(http_server_requests_total{env=\"$env\",status=~\"5..\"}[$__rate])) / sum(rate(http_server_requests_total{env=\"$env\"}[$__rate]))" },
    "req_rate":  { "lang": "promql", "expr": "sum by (route) (rate(http_server_requests_total{env=\"$env\",route=~\"$route\"}[$__rate]))", "legend": "{{route}}" }
  },
  "panels": {                                   // a MAP keyed by stable id: /panels/p_err/title never shifts
    "p_err": {
      "kind": "stat", "title": "Error ratio",
      "description": "Share of 5xx responses. SLO is 0.1%; above 1% is an incident.",   // required
      "unit": "ratio",                                                                   // required
      "queries": ["err_ratio"],
      "options": { "sparkline": true },
      "thresholds": [{ "above": 0.001, "level": "warn" }, { "above": 0.01, "level": "crit" }]
    },
    "p_rate": { "kind": "timeseries", "title": "Requests by route", "description": "Throughput per route. Sudden drops matter more than peaks.",
                "unit": "req/s", "queries": ["req_rate"], "options": { "stack": true } }
  },
  "layout": {                                   // position lives here, not in the panels
    "kind": "rows",
    "rows": [
      { "title": "Health", "items": [{ "panel": "p_err", "span": 3 }, "p_rate"] },
      { "title": "Dependencies", "items": [{ "fragment": "dependency_red", "as": "db", "with": { "peer": "postgres", "env": "$env" } }] }
    ]
  },
  "fragments": {                                // reusable queries + panels + layout with parameters
    "dependency_red": { "description": "…", "params": { "peer": {}, "env": { "default": "prod" } }, "queries": { … }, "panels": { … }, "layout": { … } }
  }
}
```

| Part | Rules |
|---|---|
| ids | `^[a-z][a-z0-9_]{0,47}$`; map keys, so JSON Pointers are stable |
| panel kinds (closed) | `timeseries`, `stat`, `table`, `heatmap`, `text`. Each has a small closed `options` object |
| required text | `metadata.intent`; `title` on every panel; `description` and `unit` on timeseries/stat/heatmap; `description` on table (unit per panel or per column, lint-enforced) |
| units (closed enum) | none, count, percent, ratio, s, ms, us, ns, bytes, bits, bytes/s, bits/s, req/s, ops/s, events/s, rows/s, errors/s, cores, celsius, usd |
| query languages | `promql`, `traceql`, `logql` |
| variables | `enum`, `query`, `text`, `interval`; built-ins `$__rate`, `$__interval`, `$__range` |
| thresholds | `{above|below, level: info|warn|crit, label?}`; state = most severe breached level |
| layout | tree of `rows` (items: panel id, `{panel, span}`, fragment instance, nested layout) and `grid` (`{panel, x, y, w, h}`) |
| fragments | self-contained: fragment panels use fragment queries; fragment queries see only the fragment's `params` and built-ins. Instantiated from a layout row with `{fragment, as, with}`; expanded ids are `<as>.<id>` |
| closed | every object is `additionalProperties: false` or an id-keyed map. Unknown keys are errors |

Sizes: the three examples are 9–15 panels and about 1.6–2.4 K tokens each (chars/4). The full schema is 13.8 K
chars; the `stat` slice from `getSchema('stat')` is 2.0 K.

The schema is published at `schema/viz.dashboard.v1.schema.json` (generated from `src/schema.ts` by
`npm run gen:schema`; a test fails if they differ).

## API

| Function | What it does |
|---|---|
| `validate(spec) → { ok, errors[] }` | Schema, then references, duplicates, cycles, variable use. Each error: `path` (JSON Pointer), `code`, `message`, `suggestion` |
| `lint(spec, { maxPanels?, disable? }) → warnings[]` | 16 non-fatal rules, listed in `LINT_RULES` |
| `getSchema(kind?) → { schema, example, catalog, units, builtins, kinds }` | A self-contained schema slice plus one valid example. Kinds: dashboard, timeseries, stat, table, heatmap, text, panel, query, variable, layout, fragment, threshold |
| `revisionOf(spec) → string` | 32 hex chars: SHA-256 of canonical JSON, truncated to 128 bits |
| `applyPatch(spec, ops, { baseRevision }) → { ok, spec, revision } \| { ok:false, conflict } \| { ok:false, errors }` | RFC 6902 edit; rejects a stale revision; re-validates the result |
| `applyOps(doc, ops)` | Generic, atomic RFC 6902 on any JSON |
| `diff(a, b) → ops`, `summarizeDiff(a, b) → string[]` | Patch from a to b; one line per change in words |
| `resolve(spec, { variables, builtins }) → ResolvedDashboard` | Expands fragments, substitutes variables with context-aware escaping |
| `digestPanel(panel, data, opts) → PanelDigest` | Per-series last/min/max/mean, trend, outlier, threshold state, gaps; top-k |
| `digestDashboard(resolved, dataByPanel, opts)`, `renderDigest(digest, { format, maxTokens, cursor })` | Markdown or TSV within a token budget, most important first, with `truncated` and `cursor` |
| `fromGrafana(json) → { spec, warnings, errors }` | Classic Grafana dashboard JSON importer |
| helpers | `findVariables`, `substitute`, `escapeRegex`, `escapeString`, `thresholdState`, `robustZ`, `canonicalJson`, `deepEqual`, `walkLayout` |

What an error looks like:

```json
{ "path": "/panels/error_ratio/unit", "code": "enum", "message": "\"seconds\" is not an allowed value.",
  "suggestion": "Did you mean \"s\"? Allowed: \"none\", \"count\", …" }
{ "path": "/panels/throughput/titel", "code": "unknown-key", "message": "Unknown property \"titel\". Unknown properties are errors, not ignored.",
  "suggestion": "Did you mean \"title\"? Allowed keys: \"kind\", \"title\", \"description\", \"unit\", \"queries\", \"options\", \"thresholds\"." }
```

What a digest looks like (`renderDigest(…, { format: 'markdown', maxTokens: 350 })`):

```
# Service RED overview (service_red, rev 5cfaa44856d4)
On-call view for one HTTP service. Answers: is the service healthy right now, …
range 2023-11-14T22:13:20.000Z → 2023-11-14T22:23:20.000Z; variables env=prod service=checkout route=*
16 panels: 1 crit, 0 warn, 0 with outliers, 13 no data

## [CRIT] Error ratio — error_ratio (stat, ratio)
Share of requests answered with 5xx. The SLO is 0.1%; above 1% is an incident and pages.
1 series.
| series | value | min | max | mean | trend | state | notes |
|---|---|---|---|---|---|---|---|
| err_ratio | 0.022 | 0.002 | 0.022 | 0.012 | up +1000% | CRIT >0.01 |  |
…
_Truncated: 12 of 16 panels not shown in full. Continue with cursor "o:4"._
```

### Variable substitution: the escaping rule

A value is never pasted in verbatim. What is written depends on where the reference sits (`src/expr.ts`):

| Where `$x` is | One value | Several values | "All" (`*`) |
|---|---|---|---|
| in a quoted string after `=~`, `!~`, `\|~` | regex-escaped (`\.+*?()\|[]{}^$` get a backslash), then string-escaped | each escaped, joined `a\|b\|c`; wrapped `(?:…)` unless the reference is the whole string | `.*` |
| in any other quoted string (`=`, `!=`, function arguments) | string-escaped: `\` → `\\`, the quote → `\"`, control chars → `\n`, `\u00XX` | fails | fails |
| outside a string (`[$w]`, `topk($k, …)`, metric name) | written only if it is a number, a duration or an identifier; otherwise fails | fails | fails |

Inside backtick strings there are no escapes, so a backtick in a value becomes `\x60` in a regex and fails in a
plain string. A failed substitution does not throw: the query keeps its unsubstituted `$x` (so it cannot parse or
run), gets an `error`, and `resolve` lists it in `issues`. `validate` rejects, statically, a `multi` variable used
anywhere but a regex matcher, and `${x:format}` suffixes. `$$` is a literal `$`; `$1` and a regex end anchor are
left alone. Fragment arguments are either a literal or exactly one reference (`"$env"`), which passes the binding
through, multi-value and all.

### Digest definitions

- `value`: the panel's reducer over the window (`options.reduce` on stat/table, default `last`). Thresholds are evaluated on it (`state`); `worst` is the worst state of min/max in the window.
- `trend`: least-squares slope (units per second); direction is `flat` when the fitted change over the window is within 5% of the series' magnitude; `relChange` = (last − first) / |first|.
- `outlier`: robust z-score of the series' mean among its peers, `0.6745·(x − median)/MAD` (falls back to mean absolute deviation when MAD = 0), flagged above 3.5; needs at least 4 series.
- `gaps`: spacing above 1.5 × step (given, or the median spacing); `stale` when the last sample is more than 1.5 steps before the range end.
- top-k (default 5): breaching series first, then outliers, then largest value. The panel `state` and `omitted` counts cover the series that were cut.
- Rendering order: crit, warn, info, panels with outliers, no data, the rest in layout order. Whole panels are written until one does not fit; the rest get one-line summaries while space lasts. The output never exceeds `maxTokens × 4` characters, and a call always advances the cursor by at least one panel.
- Timestamps are Unix seconds, as in the Prometheus HTTP API.

## Implemented / not implemented

Implemented: everything in the list above; three examples in `examples/` (service RED with a fragment used
twice, Kubernetes node overview on an explicit grid, viz ingest-pipeline self-monitoring), each valid with zero
lint warnings.

Not implemented:

- **Perses import**: skipped.
- **Grafana v2 (schemaVersion 42+, `elements`/`layout`) import**: only the classic model is read.
- **Query parsing and type-checking**: `validate` checks variables and references, not PromQL syntax; that needs the engine. The same goes for dry-run against real data and cost estimates (research/09 §1.5 item 9). `lint`'s rate-window rule is a regular expression, not a parse.
- **Provenance and revision history**: the spec carries no author or revision number; `revisionOf` is a content hash. Who made a revision belongs to whatever stores revisions.
- **`outline` projection**, `showIf`, tabs, annotations, panel links, logs/traces/flame panel kinds, variables in panel titles: not in v1 of this schema.
- **Heatmap digests** treat bucket series like any other series (no quantile reconstruction). `PromScalar` results are not accepted by `digestPanel`.
- **Variable chaining at runtime**: `resolve` substitutes values it is given; evaluating a `query` variable's own expression is the caller's job. (Cycles between variables are rejected by `validate`.)
- The example dashboards for viz itself use plausible metric names (`viz_ingest_samples_total`, …), not names taken from the other components, which did not exist yet.

## Verification

All numbers from this directory on Node 22.23, vitest 5.1, TypeScript 5.9.

| Check | Result |
|---|---|
| `npm test` | 316 tests in 9 files, all pass |
| `npx tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`) | clean |
| Official JSON Patch suite, fetched from `json-patch/json-patch-tests` (stored verbatim in `test/fixtures/jsonpatch/`) | `tests.json` 92/92 active cases pass (3 disabled upstream); `spec_tests.json` 16/16 (1 disabled upstream). 108/108 |
| Invalid-spec table | 48 cases; each yields exactly one error with the expected code, pointer and suggestion |
| Differential vs Ajv 8 (draft 2020-12, strict) on the same schema | 48 table cases + 6,000 seeded random mutations of the examples (2,025 valid / 3,975 invalid): 0 disagreements |
| `applyOps(a, diff(a, b))` deep-equals `b` | 2,000 runs on arbitrary JSON + 2,000 on edited copies + 100 on dashboards through `applyPatch` |
| Revision stable under key reordering | 2,000 runs on arbitrary JSON + 20 shuffles of each example; SHA-256 checked against `node:crypto` (200 lengths + 1,000 random strings), FIPS vectors and WebCrypto |
| `resolve` never throws on valid specs | 1,500 runs with arbitrary variable values + 500 runs on randomly edited valid specs |
| Escaping | 2,000 runs: an arbitrary string value leaves exactly the original string literals and round-trips; 1,000 runs: a multi-value alternation, compiled as a real regex, matches exactly the selected values |
| Digest | statistics checked against hand-computed values (linear series, known MAD, known gaps); budgets of 0–1,200 tokens never exceeded; paging by cursor shows every panel exactly once |
| Grafana import | 13-panel hand-written fixture: 8 panels imported, 2 unsupported → warnings, 3 rows → layout; every panel, target and variable is in the spec or named in a warning |
| Workers constraint | the whole API is exercised in a Node child process started with `--disallow-code-generation-from-strings`; a source scan asserts no `eval`/`Function`, no Node or DOM globals, no imports outside `src/` |

### Mutation checks

Each behaviour was broken in the source, one at a time; `npm test` was run; the source was restored. All 20
mutants were killed (number of failing tests in brackets).

1. Skip the `baseRevision` check in `applyPatch` [2]
2. Allow a dangling panel reference in the layout [4]
3. Patch not atomic: operate on the input instead of a copy [131 — the atomicity test, and everything that shares a fixture afterwards]
4. Unescape `~0` before `~1` [3, including RFC A.14 from the official suite]
5. Substitute a string value without escaping [4]
6. Digest ignores thresholds [12]
7. Do not re-validate the patched spec [1]
8. Do not regex-escape values in a regex matcher [4]
9. Do not check values written outside a string [3]
10. Canonical JSON does not sort keys [4]
11. Allow a dangling query reference [3]
12. Do not detect fragment (and variable) cycles [3]
13. Accept unknown keys [8]
14. Digest rendering ignores the token budget [7]
15. Digest rendering does not order by importance [6]
16. Grafana importer drops unsupported panels without a warning [1]
17. Accept array indices with leading zeros [3, from the official suite]
18. Top-k ranking ignores threshold state [1]
19. Do not report undefined variables [4]
20. Never set the outlier flag [3]

## Dependencies

Runtime: none. Dev: `typescript`, `vitest`, `fast-check` (property tests), `ajv` (reference JSON Schema
implementation for the differential test only; it is never imported from `src/`), `@types/node`.

## Design choices worth a second opinion

1. **Flat document, no `kind`/`spec` envelope.** research/09 §7.1 sketches `{apiVersion, kind, metadata, spec}`
   with revision and provenance in `metadata`. This package follows the task description instead: top-level
   `metadata`, `variables`, `queries`, `panels`, `layout`, `fragments`, and `intent` inside `metadata`. Revision is
   a content hash, so it is not stored in the document.
2. **Validator: a hand-written interpreter of the JSON Schema** (`src/schema-validate.ts`, ~250 lines) rather
   than Ajv. Ajv's default mode uses `new Function` (not allowed in Workers); its standalone mode needs a
   build step and its messages would need rewriting anyway. The schema object is the single source of truth and
   the interpreter supports exactly the keywords it uses. The differential test against Ajv is what keeps the two
   honest. Semantic checks run only when the structure is valid, so one mistake gives one error.
3. **Revision: SHA-256 of canonical JSON, truncated to 128 bits, computed synchronously** by a small in-package
   SHA-256, not WebCrypto. WebCrypto is async and would make `applyPatch` async for every caller, including UI
   undo. The implementation is checked against `node:crypto` and WebCrypto.
4. **Fragments live inside the dashboard** (`fragments` map), not as separately versioned `viz.fragment/v1`
   resources referenced as `id@version` (research/09 §7.1 notes). A shared fragment library can be layered on by
   copying a fragment in at a pinned version; cross-document references would make `validate` need I/O.
5. **Fragments are instantiated from the layout** (`{fragment, as, with}` in a row), not as a panel of
   `kind: "fragment"`, because a fragment is several panels plus their arrangement. Fragments cannot see dashboard
   variables; everything comes in through `with`. Stricter than the research sketch, but it makes a fragment
   checkable on its own.
6. **Panel `queries` is an array of ids** (unique), not a map of `{ref}` objects, and inline queries are not
   allowed. Simpler to write; the pointer `/panels/p/queries/0` is index-based, the one place where that is so
   besides layout items and thresholds.
7. **`unit` is on the panel** (and table columns), not on the query.
8. **Escaping is chosen from context, with no format suffixes** (`${x:regex}` is an error). A value used outside a
   string must be a number, duration or identifier. Substitution failures fail closed rather than throwing.
   The context scanner knows string literals and `=~ !~ |~`; it does not parse the query language.
9. **`"*"` means "all"** and resolves to `.*`. A `query` variable with no default and no given value also
   resolves to "all".
10. **Digest trend** uses a least-squares slope for direction and (last − first)/|first| for the percentage;
    the two can disagree on a noisy series. Outliers compare series means, not last values.
11. **`diff` never emits `move`/`copy`** and array diffs are LCS on whole elements, so reordering a long array
    of large objects produces remove + add with the full value.
12. **Grafana threshold steps are imported as given**, including Grafana's default "red above 80" that many
    panels carry without anyone having chosen it. Colours map to levels (red → crit, orange/yellow → warn,
    green/blue → info).
13. **`package.json` exports the TypeScript source.** Fine for Workers (wrangler/esbuild), Vite and Node ≥ 22.18;
    a consumer on an older Node would need a build.

## Contract issues

- `contracts/engine.ts` does not state the unit of the timestamps in `PromMatrix`/`PromVector`. This package
  assumes Unix **seconds**, as in the Prometheus HTTP API (`queryRange` itself takes milliseconds, which makes
  the question worth settling in the contract).
- `PromMatrix`/`PromVector` are redeclared in `src/types.ts` so the package has no import outside its
  directory; `test/contract.test.ts` asserts the two declarations are the same types. A shared types package
  would remove the duplication.
- `queryInstant` can return `PromScalar`; `digestPanel` does not accept it (a caller can wrap it as a one-series
  vector).
- The contract has no result shape for TraceQL or LogQL queries, which the dashboard schema allows as query
  languages; digests are defined for Prometheus shapes only.
