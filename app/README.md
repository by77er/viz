# viz web app

The viz frontend. First slice: an **Explore** view for metrics against a Prometheus-compatible
HTTP API (`/api/v1/query_range`, `/query`, `/labels`, `/label/<name>/values`, `/series`,
`/metadata`, `/status/buildinfo`).

> **The backend used for development and tests is a mock** (`mock/`): synthetic data and a
> subset of PromQL. It is not the viz query backend. The UI shows a `MOCK` banner whenever
> it is connected to it.

## Run

```sh
npm install

# development: two terminals
npm run mock          # mock API on http://127.0.0.1:8821
npm run dev           # app on http://127.0.0.1:8820, proxies /api to the mock

# against another backend
VIZ_API_TARGET=https://prometheus.example.com npm run dev   # proxy target, or
# open Settings in the app and enter the API base URL and bearer token (needs CORS)

npm run build         # tsc --noEmit && vite build  -> dist/
npm test              # vitest unit tests
npx tsc --noEmit      # typecheck
npm run e2e           # Playwright end-to-end + axe; needs `npm run build` first
```

`npm run e2e` uses the globally installed Playwright (`require('playwright')`), starts the
mock (8821) and `vite preview` (8820) itself and stops them afterwards; both ports must be
free. Mock options: `--port`, `--require-token <t>`, `--delay <ms>`; `VIZ_MOCK_LOG=1` logs requests.

## Stack

Vite 8.3 · React 19.3 · TypeScript 7.0 · TanStack Router 1.170 and Query 5.108 ·
Tailwind CSS 4.3 · uPlot 1.6.32 · CodeMirror 6 · vitest 5 · fast-check 4 · axe-core 4.14.

- **PromQL editor package:** `@prometheus-io/codemirror-promql` 0.316.0 (the official
  Prometheus package; it installed without trouble). Autocomplete goes through an adapter
  (`src/editor/promClient.ts`) onto the app's own API client, so it uses the configured base
  URL and token.
- **Not used, deliberately, to keep the bundle small:** shadcn/Base UI, cmdk, TanStack
  Table/Virtual. Dialogs are native `<dialog>`; the command palette and tables are hand-written.
- uPlot is an npm dependency, not vendored. Only `src/charts/` imports it.

## Layout

| Path | What |
|---|---|
| `src/api/` | Typed Prometheus client: AbortSignal, error envelope, base URL, bearer token |
| `src/charts/` | Internal chart interface (`types.ts`) and the uPlot implementation |
| `src/editor/` | CodeMirror PromQL editor (lazy-loaded chunk) |
| `src/explore/` | Explore view: time picker, legend, table, JSON, text view |
| `src/shell/` | App shell, command palette, settings, theme, help page |
| `src/lib/` | Pure logic: downsampling, step selection, colours, URL state, digest, units, time |
| `mock/` | Mock backend: synthetic data, PromQL subset, HTTP handler, Node server |
| `e2e/run.cjs` | End-to-end and accessibility checks |
| `screenshots/` | Written by the e2e run |

## What is implemented

**Explore**
- Query editor: PromQL highlighting, linting, autocomplete of metric names, label names and
  label values from the API; `Ctrl/Cmd+Enter` runs.
- Time range: relative presets and absolute from/to, shift back/forward, zoom out.
- URL state: `q`, `from`, `to`, `step`, `unit`, `view`, `tab` as flat search params
  (defaults omitted). Any view is a link. Credentials are never in the URL.
- Step: automatic by default — the smallest "nice" step giving at most one point per pixel
  column, never below 15 s; chart width is bucketed to 100 px; the window is aligned to the
  step. An explicit step can be typed.
- Chart: crosshair with tooltip (cursor sync key wired for future panels), drag-to-zoom that
  writes the time range to the URL (Back undoes it), legend with last/min/max and sortable
  columns, click to isolate / Ctrl-click to toggle, hover-to-highlight, arrow-key cursor with
  a polite live region.
- Gaps: results are put on the evaluation grid; a missing step is a null and is not bridged.
- Downsampling: when points exceed 2× the pixel columns, each column is reduced to its
  minimum and maximum in order of occurrence (`src/lib/downsample.ts`). The status line says
  so when it happens.
- Colour: FNV-1a hash of the canonical label set picks one of eight colour-blind-validated
  slots (separate light and dark steps). Collisions within one result move to the next free
  slot; beyond eight series, slots repeat with a dash pattern.
- Units: seconds, bytes, percent, per-second, cores, plain SI; inferred from metric naming,
  overridable.
- Below the chart: a table (latest value per series, one column per label, sortable) and the
  raw JSON.
- States: error (Prometheus `errorType` and message), loading (previous result stays
  visible, dimmed, with a progress bar), empty ("The query returned no series"), start
  (example queries when connected to the mock).
- Text view: a toggle (`T`) replaces the chart with a digest — per series last, min, max,
  mean, trend and gap count. Computed by `digestSeries` / `renderDigest` in
  `src/lib/digest.ts`, which is the narrow interface the dashboard package can replace.

**Shell**
- Light and dark themes from the system preference, with a manual toggle (system → light →
  dark) stored in localStorage.
- Command palette (`Ctrl/Cmd+K`): navigation, run query, focus editor, copy link, text view,
  table/JSON, time presets, theme, settings.
- Settings: API base URL and bearer token in localStorage; "Test connection".
- Help page with the keyboard shortcuts.

## What is mocked

`mock/` serves the Prometheus API from data that is a pure function of (series, time):

- 128 series: `http_requests_total{service,route,status}` (36),
  `http_request_duration_seconds_{bucket,sum,count}` (48 + 8, 12 `le` buckets),
  `pod_cpu_usage_cores` and `pod_memory_working_set_bytes` by pod (12 each), `up` (12).
- 15 s scrape grid, data from 2026-01-01 UTC. Counters are exact prefix sums of a 24 h
  increment table, so they are monotonic and repeat daily. The histogram count equals the sum
  of the request counters.
- Built-in events: `checkout` degrades for 12 minutes from minute 40 of every third hour; pod
  `checkout-6b7f9-x2k4p` has no samples for 12 minutes from minute 50 of every even hour (a
  real gap); rare one-sample CPU spikes.
- PromQL subset: selectors with `= != =~ !~` and `offset`; `rate`, `irate`, `increase`,
  `delta`, `{avg,min,max,sum,count,last}_over_time`; `sum avg min max count topk bottomk
  quantile` with `by`/`without`; `histogram_quantile`; `abs ceil floor round clamp_min
  clamp_max time vector scalar`; arithmetic and comparison operators, `bool`, one-to-one
  `on`/`ignoring`. `rate`/`increase` use Prometheus' extrapolation; 5 minute lookback;
  11,000-point limit.
- Not in the mock: subqueries, `and/or/unless`, `group_left/right`, `@`, native histograms,
  most other functions. These return a `bad_data` error that says so. The editor's linter
  knows full PromQL, so it will accept queries the mock rejects.

## Not done

- Everything outside metrics Explore: dashboards, logs, traces, alerts, the agent surface.
- No Worker/Hono/Cloudflare deployment config; this is a static SPA build only.
- No auto-refresh, query history, multiple queries per view, exemplars or annotations.
- The table is derived from the range result (last sample per series), not from a separate
  instant query. Scalar and string instant results have no dedicated rendering.
- No cap or "other" folding for very high series counts; the legend is not virtualized
  (fine at the mock's 128 series), the table renders the first 500 rows.
- No Arrow transport, no coarse-then-refine loading.
- No login flow; the token is a pasted bearer token.

## Verification

Run on 2026-11-18, Node 22.23.

| Check | Result |
|---|---|
| `npm test` | 70 tests in 5 files pass (~1.3 s) |
| `npx tsc --noEmit` | passes |
| `npm run build` | passes |
| `npm run e2e` | 53 of 53 checks pass |
| axe-core | 0 violations of any impact in 5 runs (see below) |

Unit tests cover: downsampling (fast-check property, 300 runs: per-column min and max equal
the input's, every output value occurs in the same input column, gaps neither created nor
filled, at most two points per column); step selection (including a minimality property);
colour hash stability and assignment; URL state round-trip (including arbitrary query
strings); digest statistics on hand-checked data; API client (error envelope, HTTP and
network failures, abort, bearer header, token never in URL or body); the mock's PromQL on
hand-computed cases (rate/increase extrapolation, counter reset, lookback, aggregation,
`histogram_quantile` interpolation, operator precedence, vector matching, parse errors).

End-to-end (Chromium, built app + mock) covers: redirect; mock banner; autocomplete of
metric names, label names and label values; Ctrl+Enter; highlighting; legend contents; canvas
pixels (about 58,000 painted pixels, the four expected palette colours); colours identical after
reload; tooltip; table and JSON; isolate; drag-zoom → URL range within 2% of the selection;
Back undoes zoom; presets; auto step (3 h → 15 s, 24 h → 1 m at 1440 px; 3 h → 30 s at 400 px);
downsampling label (10,801 → 5,400 points); text view; previous data visible while loading;
unit formatting; error text; empty state; command palette run and navigation; token in
localStorage and `Authorization` header and in no URL; chart keyboard cursor; dark palette on
canvas; manual theme toggle; 36 series; no horizontal overflow at 1440 px and 400 px in both
themes; no console or page errors.

axe-core 4.14 (WCAG 2.0/2.1/2.2 A and AA plus best-practice rules) ran on: main view light,
main view dark, text view light, help dark, main view at 400 px light. Earlier runs found
three serious findings, all fixed: accessible name not containing the visible text on the
Commands button, legend row targets 23.4 px high, and 4.31:1 contrast on the Run button's
shortcut hint in dark.

The categorical palette was checked with the dataviz validator against both surfaces: all
gates pass. In light mode three slots (aqua, yellow, magenta) are below 3:1 against the
surface; the legend, table and text view are the required relief.

### Bundle (built assets)

| File | Raw | Gzip |
|---|---|---|
| `index-*.js` (app, React, router, query, uPlot) | 443.7 kB | 147.7 kB |
| `PromqlEditor-*.js` (CodeMirror + PromQL, lazy) | 451.9 kB | 144.7 kB |
| `index-*.css` | 24.4 kB | 6.3 kB |
| `index.html` | 1.0 kB | 0.6 kB |
| **Total** | **921.0 kB** | **299.3 kB** |

The editor chunk loads in parallel after first paint; the shell renders without it.

## Known issues

- Colour: a series keeps its hashed slot only while no series earlier in sort order claims
  it in the same result, so a series can change colour between two different queries. It is
  always the same for the same result set and across reloads.
- Downsampling shares one x axis across series, so a column's min and max are drawn at the
  column's first and last timestamps — up to one pixel column from where they occurred.
- Unit inference is a naming heuristic and can be wrong (ratios fall back to plain numbers).
- NaN and ±Inf samples are drawn as gaps; the JSON view shows them as returned.
- The absolute time inputs are `datetime-local`, so their display format follows the browser
  locale; all other times are local, 24-hour, ISO order.
- The token is in localStorage, readable by any script on the origin.
- With an explicit step the query can exceed 11,000 points; the backend's error is shown
  rather than the step being clamped.
- Autocomplete shows `counter` for histogram `_count`/`_bucket` series (from the editor
  package's metadata matching).
- Relative ranges re-resolve "now" when the chart width crosses a 100 px bucket, which
  triggers a refetch on resize.
