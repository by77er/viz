# viz web app

The viz frontend. First slice: an **Explore** view for metrics against a Prometheus-compatible
HTTP API (`/api/v1/query_range`, `/query`, `/labels`, `/label/<name>/values`, `/series`,
`/metadata`, `/status/buildinfo`).

> **The backend used for development and most tests is a mock** (`mock/`): synthetic data and
> a subset of PromQL. It is not the viz query backend. The UI shows a banner whenever it is
> connected to it. The app also runs against the **real viz API**, served locally by
> `wrangler dev --local` (`real/`, "The real viz API, locally"): `e2e/real.cjs` runs the app
> on it, and `e2e/contract.cjs` sends the same requests to it and to the mock and compares
> the answers ("Mock and real API").

## Design system

The app uses the viz design system (`../design-system`) and nothing else for its look.
`src/main.tsx` imports `design-system/dist/viz.css` (tokens, components and the two self-hosted
fonts; Vite copies the WOFF2 files into the build and `vite.config.ts` adds the preload link
for the sans file to `index.html`), `index.html` puts `class="vz"` on the root, and
`src/app.css` holds layout only. No literal colour, length, duration or opacity is left in
`src/`: `npm run check:tokens` (`node ../design-system/tools/check.mjs src`) must pass.
`design-system/dist/` is generated and not committed, so `npm run dev` and `npm run build`
build it first (`npm run design-system`).

Tailwind was removed rather than mapped onto the tokens: its reset and default scales emit
literal `rem`, colour and opacity values, and what the app used it for (layout) is now about
150 lines of token-only CSS.

The change that applied the system, with its before/after images, measurements and the
presence test, is described in `../design-system/reviews/app-restyle/PR.md`. The review
rejected it (`../design-system/reviews/app-restyle/review.md`); the fixes to its logic
findings, with images, measurements and mutants, are in
`../design-system/reviews/app-restyle/fixes/FIXES.md`. Its styling and chart-drawing
findings wait for the design system's revision (see "Known issues").

## Run

```sh
npm install

# development: two terminals
npm run mock          # mock API on http://127.0.0.1:8821
npm run dev           # builds the design system, then the app on http://127.0.0.1:8820, proxying /api to the mock

# on other ports (8820/8821 taken)
npx tsx mock/server.ts --port 8841
VIZ_API_TARGET=http://127.0.0.1:8841 npx vite --port 8840

# against another backend
VIZ_API_TARGET=https://prometheus.example.com npm run dev   # proxy target, or
# open Settings in the app and enter the API base URL and bearer token (needs CORS)

npm run build         # design system, tsc --noEmit, vite build  -> dist/
npm test              # vitest unit tests
npx tsc --noEmit      # typecheck
npm run check:tokens  # no literal colours, lengths, durations or opacity in src/
npm run e2e           # e2e/run.cjs, e2e/design.cjs, e2e/fixes.cjs (Playwright + axe); needs `npm run build` first
npm run measure       # the speed budgets on the built app (see "Speed"); --series 4,36,200, --phone
node e2e/summarise.cjs                      # before/after tables from e2e/measurements
node e2e/fingerprint.cjs --root <app> --label <name>   # what a build renders, to compare two builds
MUTANTS=fixes node e2e/mutants.cjs          # the review fixes' mutants (unit + e2e/fixes.cjs)
MUTANTS=real node e2e/mutants.cjs           # this change's mutants (unit + e2e/errors.cjs)
node e2e/errors.cjs                         # error, busy and retry states against the mock's failures

# the real viz API, locally (no Cloudflare account is used; see "The real viz API, locally")
node real/stack.mjs start && node real/stack.mjs seed
node e2e/contract.cjs                       # the same requests to the real API and to the mock, compared
node e2e/real.cjs                           # the app on the real API (needs `npm run build`)
node real/stack.mjs stop
```

The end-to-end scripts use the globally installed Playwright (`require('playwright')`), start
the mock and `vite preview` themselves and stop them afterwards. They use ports 8820 and 8821
unless `VIZ_E2E_APP_PORT` and `VIZ_E2E_MOCK_PORT` are set.

Mock options: `--port`, `--require-token <t>`, `VIZ_MOCK_LOG=1` (logs requests), and artificial
latency to exercise the waiting states:

| Switch | Effect |
|---|---|
| `--delay <ms>` or `VIZ_MOCK_DELAY=<ms>` | every response waits this long |
| `?delay=<ms>` on a request | that response waits this long |
| `GET /__mock/delay?ms=<ms>` | from now on, `query` and `query_range` responses wait this long; `0` turns it off |

`curl 'http://127.0.0.1:8821/__mock/delay?ms=3000'`, then press Run query, shows the progress
line and Cancel.

### Design-review images

```sh
npx tsx mock/server.ts --port 8841 &
VIZ_API_TARGET=http://127.0.0.1:8841 npx vite --config e2e/vite.shots.config.ts --port 8840 &
e2e/capture.sh after                                             # ../design-system/tools/shots.mjs, one call per view
VIZ_E2E_APP_PORT=8840 VIZ_E2E_MOCK_PORT=8841 node e2e/states.cjs ../design-system/reviews/<change>/after
node ../design-system/tools/shots.mjs compare <before> <after> <compare>
python3 e2e/encode-review-images.py ../design-system/reviews/<change>   # palette-encode, keeps token colours exact
```

`shots.mjs` can only open a URL, so `e2e/vite.shots.config.ts` adds a script to the dev page
(never to a build) that opens the time picker, the command palette or the settings dialog when
the URL carries `#shot=timepicker|palette|settings`. `e2e/states.cjs` takes the images
`shots.mjs` cannot: waiting states, focus rings, pressed and hover, and the coarse-pointer view.

## Stack

Vite 8.3 · React 19.3 · TypeScript 7.0 · TanStack Router 1.170 and Query 5.108 ·
the viz design system · uPlot 1.6.32 · CodeMirror 6 · vitest 5 · fast-check 4 · axe-core 4.14.

- **PromQL editor package:** `@prometheus-io/codemirror-promql` 0.316.0 (the official
  Prometheus package; it installed without trouble). Autocomplete goes through an adapter
  (`src/editor/promClient.ts`) onto the app's own API client, so it uses the configured base
  URL and token.
- **Not used, deliberately, to keep the bundle small:** shadcn/Base UI, cmdk, TanStack
  Table/Virtual. Dialogs are native `<dialog>`; the command palette and tables are hand-written.
- uPlot is an npm dependency, not vendored. Only `src/charts/` imports it. Its stylesheet is not
  loaded (it carries literal colours); the dozen rules it needs are in `src/app.css`.

## Layout

| Path | What |
|---|---|
| `src/api/` | Typed Prometheus client: AbortSignal, error envelope, base URL, bearer token, `Retry-After`, the `X-Viz-*` cost |
| `src/api/matrix.ts` | The range-query body read into Float64Arrays as it arrives (`JSON.parse` is the fallback) |
| `src/api/matrixWorker.ts` | The same in a dedicated worker; built and tested, not used by the app (see "Speed") |
| `src/api/errors.ts` | What a failure means for the person: its kind, the advice, whether and when to ask again |
| `src/charts/` | Internal chart interface (`types.ts`) and the uPlot implementation |
| `src/editor/` | CodeMirror PromQL editor (lazy-loaded chunk) |
| `src/explore/` | Explore view: time picker, legend, table, JSON, text view, waiting logic (`waiting.tsx`) |
| `src/shell/` | App shell, command palette, settings, theme, help page |
| `src/lib/` | Pure logic: downsampling, step selection, colours, URL state, digest, units, time |
| `src/lib/describe.ts` | What a result says about itself (query, range, unit, chart name, digest title) and whether it still answers the current request |
| `src/lib/naming.ts` | Display names of the series of one result: full, distinguishing, middle-truncated |
| `src/lib/assign.ts` | Which series get one of the eight colours, which slot, and the one Other group |
| `src/lib/focusKeeper.ts` | Moves focus to a stand-in when the focused control goes away |
| `src/lib/pointer.ts`, `src/lib/renders.ts` | Coarse pointer and tap toggling; render counts read by the e2e checks |
| `mock/` | Mock backend: synthetic data, PromQL subset, HTTP handler, Node server; fails on request as the real API fails |
| `real/` | The real viz API on one machine: `wrangler dev --local` of gateway, write path, query Worker and control plane; the seed |
| `src/app.css` | Layout, and uPlot/CodeMirror/`<dialog>` adapted to the tokens. Tokens only |
| `e2e/run.cjs` | End-to-end and accessibility checks of the behaviour |
| `e2e/design.cjs` | Design-system checks: colour, waiting, keyboard, touch, narrow |
| `e2e/fixes.cjs` | Checks of the fixes to the design review (B1, B3, M2 to M5, M7) |
| `e2e/errors.cjs` | What a person sees when the API refuses, is busy or stops a query (against the mock's failures) |
| `e2e/contract.cjs` | The contract test: the same 70 requests to the real API and to the mock, compared |
| `e2e/real.cjs` | The app on the real API: flows, the same reading of the same data as on the mock, every refusal |
| `e2e/real-api-shots.cjs` | Before/after images of what this change alters on screen |
| `e2e/measure.cjs` | Speed budgets, desktop or phone (`--phone`), for 4, 36 and 200 series (`e2e/measurements/*.json`) |
| `e2e/fingerprint.cjs` | What a build renders for the three speed cases (canvas pixels, legend, table, text, JSON), to compare builds |
| `e2e/summarise.cjs` | Prints speed tables from the measurement files, with the load of every column |
| `e2e/mutants.cjs` | Breaks one property at a time and records which check catches it (two sets) |
| `e2e/fix-shots.cjs` | Before/after images of the B1 and focus cases |
| `e2e/capture.sh`, `e2e/states.cjs` | Design-review images |
| `screenshots/` | Written by the e2e run |

## What is implemented

**Explore**
- Query editor in the system's query well: one ink (the system does not colour tokens by
  type), errors underlined in `status-critical`, autocomplete of metric names, label names and
  label values from the API; it scrolls sideways instead of wrapping; `Ctrl/Cmd+Enter` runs.
  The editor owns the text being typed: the page reads it when the query is run, so a
  keystroke renders no React component (checked by render counts in `e2e/fixes.cjs`). Its
  extensions are built once. Label and series lookups for autocomplete wait 150 ms and a newer
  lookup of the same kind replaces (and aborts) an older one; metric names and metadata are
  fetched once per connection.
- Run query is the view's one blue button. While a query runs it is `aria-busy`, keeps its
  pressed fill and ignores further presses (pointer, shortcut or keyboard).
- Waiting follows the system's table: nothing new under 400 ms; then an unmeasured
  `vz-progress` line ("Waiting for the query" and the running time) kept at least 300 ms;
  Cancel from 2 s, wired to the request's `AbortSignal`; from 10 s the line suggests a shorter
  range; at 60 s the request is stopped and the line says so, with Retry. The previous result
  stays visible and usable throughout. The mock reports nothing measurable, so there is never
  a bar.
- A result carries what describes it (`src/lib/describe.ts`): the request it answers (query
  text, from, to, step), the window that was queried, the unit its query implies and when it
  arrived. Everything that describes the data on screen is derived from that, never from the
  editor or the URL: the panel head (range, unit, age), the axis format, the legend and table
  heads and cells, the crosshair readout, the chart's accessible name, the text digest's
  title, the JSON, the "Automatic" unit option and the caption. While the result on screen is
  not the answer to the current request (a query waits, was cancelled, stopped at 60 s, or
  the range changed), the head says "Showing the previous query" (or "time range") and the
  caption names that query. After an error nothing of the earlier result is shown.
- The head's age counts once a second and reads "updated now" under 5 s. The waiting line and
  the result region keep their height with or without content, and the mock banner's space is
  reserved while the backend is being identified, so nothing moves when data arrives.
- Focus never falls to the document when the control that had it goes away
  (`src/lib/focusKeeper.ts`): Cancel hands it to Retry, Retry to Run query, a removed button
  to the control named in its `data-focus-after`, anything inside the result region to the
  pressed "Show as" segment, and otherwise Run query. The keeper reads layout only when a DOM
  change can have removed or hidden the focused control.
- Time range: relative presets and absolute from/to in a menu, show earlier / later, zoom in
  (half the range around its middle), zoom out (twice, never past now) and reset zoom (back to
  the range before the first zoom). The three zoom buttons sit in the time-range group; that
  placement is provisional until the system defines the chart's range control.
- URL state: `q`, `from`, `to`, `step`, `unit`, `view` as flat search params (defaults
  omitted). `view` is `chart`, `table`, `text` or `json`; old `tab=json` links still open the
  JSON form. Credentials are never in the URL.
- Step: automatic by default (the smallest "nice" step giving at most one point per pixel
  column, never below 15 s; chart width bucketed to 100 px). An explicit step can be typed.
- Chart: drawn at the size of its region in device pixels from the tokens (2 px lines, `rule`
  gridlines, `rule-control` baseline, `micro` axis text); up to four series are labelled
  directly at the line ends; crosshair readout by pointer, touch drag or arrow keys;
  drag-to-zoom writes the time range to the URL (Back undoes it); legend table with
  last/min/max and sortable columns; select a row to isolate, Shift/Ctrl-select to toggle. On
  a coarse pointer (or any touch or pen press) a tap toggles the row with no modifier, and
  the hint does not mention Shift. The crosshair and its readout are drawn outside React.
- Series names (`src/lib/naming.ts`, property-tested): labels every series shares are dropped
  and stated once (the table's caption); the rest are ordered by how many distinct values
  they take, most first; when one label tells the series apart its value is the whole name
  ("checkout"). Long values are cut in the middle, and only when no two series end up with the
  same name. One series, and series that differ only in the metric name, keep the full name.
  The legend shows the short form, the full label set in the row's title and under the table
  for the row that has focus or was tapped; the text digest and the JSON carry full names.
- Colour (`src/lib/assign.ts`, a pure `assignSeries(series, previous, policy)`): a series that
  already has a slot keeps it; the others take free slots in palette order (`series-1`
  first) in the order they appear; when more want a slot than are free, they are ranked by a
  size measure (default: mean over the result's window, ties by name) and the rest fold into
  ONE Other group. By default Other is listed under one legend row ("Other, 28 series", which
  opens to list its members 50 at a time) and its members are not drawn until selected; the
  policy can instead carry their sum for drawing, which is right only for values that add up.
  The assignment is kept in `sessionStorage`, so a filter does not repaint the survivors and
  a reload reproduces the colours. Never more than eight coloured series.
- Units (`src/lib/units.ts`): the formatter returns the number and the unit apart. The unit
  is stated once per legend column head ("Last, /s"), table column head, axis (in the panel
  head: "bytes, in MiB") and readout value; cells and ticks are numbers in one scale. A
  column whose values need different scales (2 ms beside 3 h) keeps the unit on every value
  instead. CPU cores carry their unit ("1.42 cores", "357 millicores"). Byte axes tick on
  powers of two.
- Gaps and downsampling as before; when columns are reduced to min/max the caption under
  the chart says so with the point counts.
- Forms of the result, one segmented control: chart, table (latest value per series, one
  column per distinguishing label, most distinguishing first, sortable; the shared timestamp
  and the labels every series has are said once in the caption; 50 rows, then "Show 50
  more"), text digest, raw JSON (with the response time, moved here from the panel). The
  chart stays mounted while another form is shown; the digest and the JSON text are computed
  the first time their form is shown for a result and kept for that result. The URL's `view`
  follows 300 ms after the last switch (on `pagehide` at once), so the router's work does
  not land in the frames right after the press.
- States: start (examples are links), empty and error as `vz-empty` (the error offers "Go to
  character N" when the API gives a position), warnings as a banner.

**Shell**
- `vz-nav` with Explore and Help, a Commands button and Settings. Light and dark follow the
  system setting; the manual choice (System, Light, Dark, in Settings or the command palette)
  sets `data-theme` on the root and is stored in localStorage.
- Command palette (`Ctrl/Cmd+K`): the system's menu with a field above it.
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
- Neither the legend nor the table is virtualised; both are capped instead. The legend has at
  most eight coloured rows and one Other row whose members are listed 50 at a time; the table
  shows 50 rows at a time.
- The JSON body is parsed on the main thread (no worker, no Arrow): about 32 ms unthrottled for
  the 3.6 MB of a 200-series, 3-hour result, so about 125 ms at 4x CPU.
- No Arrow transport, no coarse-then-refine loading.
- No login flow; the token is a pasted bearer token.

## Verification

Run on 2026-11-18 after the review fixes, Node 22.23, on a machine shared with other jobs
(ports 8910 and 8911).

| Check | Result |
|---|---|
| `npm test` | 129 tests in 12 files pass (two workers) |
| `npx tsc --noEmit` | passes |
| `npm run build` | passes (its prebuild regenerates `design-system/dist` and `bundle.css` from the system's sources) |
| `node ../design-system/tools/check.mjs src` | contrast 240/240; 0 literal values in 50 files |
| `node e2e/run.cjs` | 54 of 54 checks pass |
| `node e2e/design.cjs` | 52 of 52 checks pass |
| `node e2e/fixes.cjs` | 37 of 37 checks pass, including the 60 s stop |
| axe-core 4.14 | 0 violations of any impact in 16 runs (5 in `run.cjs`, 8 in `design.cjs`, 3 in `fixes.cjs`) |
| `MUTANTS=fixes node e2e/mutants.cjs` | 15 of 15 killed (unit tests and `e2e/fixes.cjs`; table below) |
| `node e2e/mutants.cjs` (the restyle's set) | not re-run after the review fixes; the results below are the restyle's |

One existing check changed: `e2e/design.cjs` expected the segmented control's pressed fill to
be the `rule` token. While this work ran, the system added a `pressed` token and moved
`:active` to it, so the check now expects `pressed` when the system defines one and `rule`
before. No check was deleted.

Unit tests cover what they did before (downsampling, step selection, URL round-trip, digest,
API client, the mock's PromQL), and for the review fixes: what a result says about itself
(`describe.test.ts`), series names with three properties over random label sets
(`naming.test.ts`), the colour assignment with two properties (`assign.test.ts`), value and
unit apart and where a column's unit goes (`units.test.ts`), `alignMatrix` property-tested
equal to its previous implementation (`series.test.ts`), autocomplete debounce and abort
(`promClient.test.ts`), and tap toggling, zoom, focus fallbacks, the focus keeper's filter
and the wording of ages, steps and presets (`interaction.test.ts`).

`e2e/fixes.cjs` (37 checks) covers B1 while waiting, cancelled, after an error, waiting after
an error and stopped at 60 s; focus after 27 interactions (never the body); typing renders no
React component and autocomplete is debounced; the URL's form after a quick round trip and
Back; colours in palette order, kept by survivors of a filter and by a reload, never more
than eight, one Other row; names, full names on focus, tap and in the text view; units once
per head; tap toggling, the touch hint and the zoom buttons on an emulated phone; and axe in
three of those states.

`e2e/run.cjs` is the earlier suite with its selectors updated. Three checks changed meaning,
none was deleted:
- "PromQL syntax highlighting is applied" is now "the query is one ink": the system's query
  well does not colour tokens by type.
- "24 h resolves to a 1 m step at 1440 px" is now 2 m: with the system's 24 px gutters the
  panel is 1392 px wide, one 100 px bucket lower than before.
- The table and JSON checks select them through the segmented control (`view=`), not tabs.
It also gained a check that the ninth series and beyond fold into Other.

`e2e/design.cjs` checks, in every state of the view (chart, table, text, JSON, time picker,
command palette, settings, 36 series, empty, error, start, help) and in both themes where
colour is involved: one blue button; no computed colour outside the values in `tokens.json`
(every rendered element and its `::before`, `::after`, `::placeholder`: text, background,
border, outline, decoration, caret, SVG paint, shadow and gradient colours); the pressed fill;
busy and the ignored second press; the progress line at 150, 450, 800 and 3000 ms of mock
latency; Cancel aborting the request; the age counting; the main flow by keyboard alone in
reading order with the ring at each of 27 stops; with an emulated touch device, 44 px hit
areas with no overlap; no sideways page scroll at 400 px; no text under 11 px; no transition
left under reduced motion.

axe ran on: main view light, main view dark, text view light, help dark, start state at
400 px (in `run.cjs`); table, time picker, command palette, settings, empty and error at
1440 px, chart and table at 400 px (in `design.cjs`). Two serious findings appeared while
restyling and were fixed: the query well and the editor inside it were both scroll regions
with nothing focusable by axe's rules.

### Mutants

**The review fixes** (`MUTANTS=fixes node e2e/mutants.cjs`, results in
`e2e/measurements/mutants-fixes.txt`): one property broken at a time, the app rebuilt, the
unit tests and `e2e/fixes.cjs` (without its 60 s case) run. 15 of 15 killed:

| Mutant | Result | Caught by |
|---|---|---|
| B1: the unit comes from the pending query (the editor's text), not the result on screen | killed | 3 unit tests, e.g. “a result describes itself (B1) takes the unit from the result on screen, not fro”; 7 e2e checks, e.g. “B1 waiting: unit, legend, chart name, range and the unit select describe the res” |
| B1: the digest is titled with the pending query | killed | 2 unit tests, e.g. “a result describes itself (B1) titles the digest and names the chart with the re”; 2 e2e checks, e.g. “B1 waiting: the digest title, the table head and the JSON are the result's, not ” |
| B1: the chart is named after the pending query (in the page, past the derivation) | killed | 3 e2e checks, e.g. “B1 waiting: unit, legend, chart name, range and the unit select describe the res” |
| B1: the head does not say "Showing the previous query" | killed | 1 unit test, e.g. “a result describes itself (B1) says plainly when the result is not the answer to”; 3 e2e checks, e.g. “B1 waiting: unit, legend, chart name, range and the unit select describe the res” |
| B3: typing re-renders the page (the draft is page state again) | killed | 1 e2e check, e.g. “B3: typing 60 characters renders no React component (the page, the query row, th” |
| B3: the deferred URL update leaves its guard set after a quick round trip (Back is then ignored) | killed | 1 e2e check, e.g. “B3: the URL's view follows a change of form, and Back after a quick round trip s” |
| B3: the focus keeper reads layout after every DOM change | killed | 1 unit test, e.g. “focus after a control goes away (M3) looks only at changes that can take the foc” |
| M3: focus is left on the body after Cancel (the keeper moves nothing) | killed | 2 e2e checks, e.g. “M3: after Cancel by keyboard, focus is on Retry, with the ring” |
| M5: duplicate display names (shortening ignores collisions) | killed | 2 unit tests, e.g. “series names (M5) does not shorten when shortening would make two series look th” |
| M7: every cell repeats the unit | killed | 3 unit tests, e.g. “where the unit goes: once in the head, or on every value (M7) a column with one ”; 4 e2e checks, e.g. “B1 baseline: the request-rate result states its unit once in the head and in eac” |
| M2: a survivor is repainted (the previous assignment is ignored) | killed | 4 unit tests, e.g. “series assignment (M2) survivors keep their colour when a filter removes other s”; 1 e2e check, e.g. “M2: survivors keep their colour when a filter removes other series” |
| M2: a ninth coloured series | killed | 5 unit tests, e.g. “series assignment (M2) never colours more than eight series; the rest are ONE Ot”; 3 e2e checks, e.g. “M2: never more than eight coloured series, each on its own series token” |
| M2: every member of Other is its own legend row | killed | 2 e2e checks, e.g. “M2: never more than eight coloured series, each on its own series token” |
| M4: a tap on a legend row does nothing on touch | killed | 1 e2e check, e.g. “M4: on a coarse pointer a tap on a legend row toggles that series, with no modif” |
| M4: a tap isolates instead of toggling (a modifier is needed on touch) | killed | 1 unit test, e.g. “touch parity (M4) a tap toggles the series; a mouse needs a modifier”; 1 e2e check, e.g. “M4: on a coarse pointer a tap on a legend row toggles that series, with no modif” |

This run found two weaknesses, fixed and re-run: after Cancel with focus lost, the e2e run
stopped at its next step, so the 27-interaction focus check never ran; and the random-label
property did not find the duplicate names (a property over long values that differ only in
the middle now does). The focus keeper's layout mutant changes speed, not behaviour, and is
caught only by the unit test of its filter.

**The restyle** (`node e2e/mutants.cjs`), not re-run after the review fixes. Each line of
`e2e/measurements/mutants.txt` is one property broken in the source, the app rebuilt, and
`e2e/design.cjs` run:

| Mutant | Caught by |
|---|---|
| a second blue button (Save settings) | one blue button per view (light, dark) |
| a literal colour in `app.css` | no computed colour outside the token set (light, dark); axe contrast |
| the second press is not ignored | a second press while the query runs is ignored |
| progress shown after 100 ms | 150 ms wait: no progress line; 800 ms wait: appears after 400 ms |
| progress not held for 300 ms | 450 ms wait: a line that was shown is kept 300 ms |
| Cancel offered after 500 ms | 800 ms wait: no Cancel yet; 3 s wait: Cancel at 2 s |
| Cancel does not abort the request | Cancel aborts the request and says so |
| rows of controls 4 px apart | coarse pointer: no two hit areas overlap |
| no focus ring on the query editor | keyboard: the ring is drawn at every stop |
| toolbar fields do not shrink or wrap | 400 px: nothing scrolls the page sideways (light, dark) |
| the popover does not take focus | keyboard: the time picker takes focus and returns it |
| legend rows stay 32 px with a coarse pointer | coarse pointer: every control has a 44 px hit area |
| the toolbar does not wrap (`flex-wrap: nowrap`) | survived: the fields shrink and the group wraps inside itself, so nothing scrolls sideways and no property is broken |

One weakness found this way: the coarse-pointer version of the sideways-scroll check did not
fail on the "toolbar fields" mutant; the fine-pointer 400 px checks did. Why was not
investigated.

### Speed after the review fixes (4, 36 and 200 series, with typing)

Measured here with `e2e/measure.cjs` (then `node e2e/summarise.cjs`): Chromium, CPU throttled
4x, network shaped to DevTools' Fast 4G, 1440x900, a fresh context per run, 75th percentile of
20 runs (median, maximum). Three cases: 4 series and 36 series from the mock, and 200
synthetic series answered by the harness through request interception (the mock has 128).
Each run also types a 60-character query one key at a time (keydown to the end of the next
frame, each key waited for) and moves the crosshair 30 times. Before is the app as the
review saw it (a copy kept in the session), after is this change; both were built against
the same snapshot of `design-system/dist`, because the system was being edited during the
session, and measured in alternating batches of five runs because the machine was shared:
load average 3.2 to 13.7 on 4 cores. On an idle machine every figure is lower. The files are
`e2e/measurements/fixes-{before,after}-{4,36,200}.json`.

"Response to paint" as the harness first defined it starts after the app has parsed the body:
the harness's copy of the body (`res.clone().text()`) resolves after the app's own `text()`
and `JSON.parse` (checked in a page). `responseFull` is measured from the last byte (Resource
Timing `responseEnd`) and includes reading and parsing.

#### 4 series (sum by (service) (rate(http_requests_total[5m])))

Runs: before 20, after 20.

| What | Budget | Before | After | Within budget after? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 25 (22, 97) | 24 (21, 36) | yes |
| Click on Run query to the busy state painted | 100 ms | 59 (37, 105) | 48 (38, 159) | yes |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 40 (33, 75) | 33 (27, 40) | yes |
| Typing: the slowest key of a run (not a budget figure) |  | 109 (65, 8003) | 56 (49, 115) |  |
| Typing: keys over 50 ms, of 60 |  | 7 (5, 27) | 2 (0, 9) |  |
| Crosshair: pointer move to the next frame | 50 ms | 32 (29, 46) | 29 (25, 34) | yes |
| Chart to table | 100 ms | 79 (59, 240) | 49 (39, 80) | yes |
| Table to text | 100 ms | 65 (55, 159) | 44 (36, 64) | yes |
| Text to chart | 100 ms | 58 (47, 104) | 42 (36, 90) | yes |
| Open the time picker | 100 ms | 105 (75, 159) | 81 (62, 176) | yes |
| Response to paint, after the body is parsed (the harness's original figure) | 100 ms | 67 (52, 189) | 42 (38, 74) | yes |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 77 (65, 199) | 54 (48, 82) | yes |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 96 (72, 152) | 64 (56, 136) | yes |
| Worst interaction, Event Timing, the whole run | 200 ms | 120 (72, 7944) | 80 (64, 136) | yes |
| Layout shift, first load | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

#### 36 series (sum by (service, route, status) (rate(http_requests_total[5m])))

Runs: before 20, after 20.

| What | Budget | Before | After | Within budget after? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 22 (20, 34) | 23 (19, 46) | yes |
| Click on Run query to the busy state painted | 100 ms | 56 (43, 196) | 43 (35, 55) | yes |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 42 (38, 47) | 33 (29, 46) | yes |
| Typing: the slowest key of a run (not a budget figure) |  | 77 (62, 148) | 64 (53, 122) |  |
| Typing: keys over 50 ms, of 60 |  | 6 (4, 11) | 2 (1, 10) |  |
| Crosshair: pointer move to the next frame | 50 ms | 44 (42, 55) | 32 (31, 38) | yes |
| Chart to table | 100 ms | 98 (89, 133) | 69 (56, 86) | yes |
| Table to text | 100 ms | 90 (73, 125) | 89 (61, 107) | yes |
| Text to chart | 100 ms | 66 (55, 91) | 46 (37, 63) | yes |
| Open the time picker | 100 ms | 76 (59, 141) | 80 (70, 160) | yes |
| Response to paint, after the body is parsed (the harness's original figure) | 100 ms | 116 (105, 134) | 116 (87, 169) | **no**, 116 ms |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 166 (149, 241) | 160 (132, 250) | **no**, 160 ms |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 96 (72, 136) | 96 (80, 112) | yes |
| Worst interaction, Event Timing, the whole run | 200 ms | 96 (88, 136) | 104 (88, 144) | yes |
| Layout shift, first load | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

#### 200 series (viz_synthetic_series)

Runs: before 20, after 20.

| What | Budget | Before | After | Within budget after? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 29 (21, 44) | 32 (24, 38) | yes |
| Click on Run query to the busy state painted | 100 ms | 48 (38, 93) | 51 (43, 142) | yes |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 47 (42, 68) | 41 (38, 46) | yes |
| Typing: the slowest key of a run (not a budget figure) |  | 143 (108, 237) | 146 (123, 232) |  |
| Typing: keys over 50 ms, of 60 |  | 13 (8, 29) | 9 (7, 15) |  |
| Crosshair: pointer move to the next frame | 50 ms | 81 (70, 114) | 35 (31, 42) | yes |
| Chart to table | 100 ms | 330 (228, 897) | 135 (77, 194) | **no**, 135 ms |
| Table to text | 100 ms | 124 (106, 289) | 108 (74, 160) | **no**, 108 ms |
| Text to chart | 100 ms | 129 (114, 178) | 46 (41, 107) | yes |
| Open the time picker | 100 ms | 77 (67, 153) | 89 (76, 283) | yes |
| Response to paint, after the body is parsed (the harness's original figure) | 100 ms | 424 (349, 966) | 156 (118, 1085) | **no**, 156 ms |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 761 (620, 1226) | 489 (403, 2276) | **no**, 489 ms |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 296 (216, 512) | 160 (112, 264) | yes |
| Worst interaction, Event Timing, the whole run | 200 ms | 296 (216, 512) | 168 (144, 264) | yes |
| Layout shift, first load | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

**Still missed, and why.** 36 series, response to paint (116 ms; 160 ms from the last byte),
not improved: about 30 ms of script at 4x to prepare and draw a new result, then a minor GC
of 10 to 55 ms because every sample is a boxed number, plus about 45 ms to read and parse the
body. 200 series, response to paint (156 ms; 489 ms from the last byte): `JSON.parse` of the
3.6 MB body alone is about 125 ms at 4x, before 144,000 samples are aligned. 200 series,
chart to table (135 ms) and table to text (108 ms): a 50-row table to render and lay out, and
the digest of 200 series computed the first time the text form is shown for a result. The
next steps are typed arrays through the chart interface, a worker or the Arrow transport, and
coarse data first. Typing meets the budget at the 75th percentile (33, 33, 41 ms) but not
key by key: 2, 2 and 9 keys of 60 per run are over 50 ms, all in CodeMirror's own work
(autocomplete list, measure cycle, syntax tree); no React component renders while typing.
The harness's typing figure before the fixes (40 to 47 ms) is lower than the review's 82 ms
because the harness waits for each key's frame before the next key and the review did not.

**What made the difference** (found with Chrome traces and the CPU profiler on an
unminified build): the focus keeper no longer forces a style and layout pass after every DOM
change; the router's URL update for a change of form runs 300 ms later instead of in the
task before the next frame; `alignMatrix` is one indexed pass (about 3x faster at 200
series, property-tested equal to the old one); `nameSeries` skips truncation lengths that cut
nothing; the digest and the JSON text are kept per result; the coarse-pointer media query is
one object. From earlier in this change: the draft lives in the editor, at most eight series
are drawn by default, the legend and table are capped, and the crosshair is drawn outside
React.

### Speed of the restyle (four series, no typing)

The table the restyle was submitted with, kept as it was. The review found that its claim
("every 75th percentile is inside its budget") held only for four series and without typing;
the section above measures typing and 36 and 200 series.

Measured here with `e2e/measure.cjs` on the built app and the mock: Chromium, CPU throttled 4x,
network shaped to DevTools' Fast 4G, 1440x900, a fresh context per run, 75th percentile of 20
runs (median, maximum). Before is the app as it was before the restyle, built from an
untouched copy. The two were measured in alternating batches of five runs because the
machine was shared (load average 8 to 12 during the runs); on an idle machine every figure
is lower. The fixture dashboard the design system names does not exist yet, so the page is
Explore with a four-series query over three hours.

| What | Budget | Before | After |
|---|---|---|---|
| Press on Run query: pointerdown to the frame with the pressed fill | 50 ms | 18 ms (13, 37) | 23 ms (20, 84) |
| Click on Run query to the busy state painted | 100 ms | no busy state | 51 ms (39, 86) |
| Chart to table | 100 ms | not a form | 64 ms (54, 150) |
| Table to text (before: chart to text) | 100 ms | 69 ms (62, 88) | 61 ms (47, 75) |
| Text to chart | 100 ms | 132 ms (108, 155) | 59 ms (53, 83) |
| Open the time picker | 100 ms | 82 ms (67, 109) | 73 ms (67, 94) |
| Response arrived to result painted | 100 ms | 93 ms (82, 134) | 68 ms (62, 238) |
| Worst interaction in the run (Event Timing duration) | 200 ms | 112 ms (96, 144) | 64 ms (56, 80) |
| Longest input delay | part of the 50 ms | 11 ms (6, 28) | 16 ms (7, 44) |
| Layout shift, first load | 0.05 | 0.0175 | 0.0000 |
| Layout shift, query run (standard, and counting shifts within 500 ms of input) | 0.05 | 0.0000, 0.0000 | 0.0000, 0.0000 |

Every 75th percentile is inside its budget. Single runs are not: of 20 "after" runs on the
loaded machine, one press took 84 ms, two chart-to-table changes took 102 and 150 ms, and two
results took 135 and 238 ms to paint. The press is 5 ms slower than before at the 75th
percentile and the longest input delay 5 ms longer; the cause was not found.

What made the difference: the chart stays mounted and laid out while another form is shown;
new data for the same series goes into the existing plot instead of a new canvas; the chart
draws in the same frame as the rest of the result; the form changes in local state and the
URL is updated after the frame; tokens are read from the style once per theme; the crosshair
readout reuses its rows and moves by transform.

### Bundle (built assets)

| File | Before raw | Before gzip | After raw | After gzip |
|---|---|---|---|---|
| `index-*.js` (app, React, router, query, uPlot): the shell | 443.7 kB | 145.9 kB | 443.2 kB | 146.1 kB |
| `PromqlEditor-*.js` (CodeMirror + PromQL, lazy) | 451.9 kB | 143.0 kB | 448.4 kB | 141.7 kB |
| `index-*.css` | 24.4 kB | 6.3 kB | 26.4 kB | 5.7 kB |
| `index.html` | 1.0 kB | 0.6 kB | 1.4 kB | 0.8 kB |
| Fonts (WOFF2, already compressed) | none | | 128.8 kB | sans 74.7 kB, mono 54.1 kB |

gzip level 9, as `e2e/measure.cjs` computes it. The shell's script is 146.1 kB compressed,
under the 200 kB limit. The fonts are new bytes: the sans file is preloaded, the mono file is
not preloaded.

## Known issues

- Speed: the budgets missed after the review fixes are listed under "Speed after the review
  fixes" (36 series: response to paint; 200 series: response to paint, chart to table, table
  to text; single slow keys while typing). The JSON body is parsed on the main thread.
- Colour memory is per browser tab (`sessionStorage`) and holds the assignment of the last
  result shown. A reload reproduces it, but the same link opened in a fresh tab assigns slots
  afresh by order of appearance, so two tabs with different histories can colour the same
  URL differently. A member of Other that is selected is drawn as a hairline in `ink-muted`;
  it does not get a colour.
- The Other group is listed, not drawn: the review asks for a min-to-max band in a neutral
  token, which needs a `series-other` token from the system.
- Left for the design-system migration (the system is being revised separately; these are
  styling or chart-drawing findings of the review, not logic): direct labels still use the
  old placement and can sit on the wrong line (M1); the query well is 32 px tall with 13 px
  text on a coarse pointer (B2); at 400 px the touch readout covers the plot (M4, third
  point); legend rows, sortable heads and quiet buttons have no distinct pressed state (M6);
  toolbar controls are full height and the waiting line's space is reserved (M8); the legend
  does not wrap a long full name onto a second line (M5, layout part); native date inputs,
  the centred range button at 400 px, arrow-key movement within the segmented control and the
  legend, the clipped ring on the last legend row, the settings dialog's gap and scrim and the
  palette field's visible label (m4, m5, m7 to m10). The zoom buttons' placement is
  provisional.
- The first visit to a backend that is not the mock reserves the mock banner's space and
  then gives it back, which moves the page once. After that the browser remembers
  (`viz.backend.mock` in localStorage).
- Plain numbers (unit "number") carry no unit, by definition; an SI prefix is kept ("1.5k").
- The favicon is an inline SVG and cannot read the tokens; it repeats the two `ink` values.
- "Commands" and "Settings" in the navigation are nouns, not verbs. The review calls them an
  acceptable minor and gives no wording, so they are left for the navigation component.
- The URL's `view` follows 300 ms after the last change of form (it replaces the entry, as
  before). A Back press inside those 300 ms keeps the form on screen and writes it into the
  entry Back went to; a reload inside them is covered by `pagehide`.
- A dialog has no scrim: the system has no scrim token yet.
- The nav hides nothing at 400 px today, but it scrolls sideways (by the system's design)
  once more sections are added.
- `aria-current="true"` marks the current preset in the time menu with the `ui-strong` type
  style; the system defines no checked state for a menu row.
- Downsampling shares one x axis across series, so a column's min and max are drawn at the
  column's first and last timestamps, up to one pixel column from where they occurred.
- Unit inference is a naming heuristic and can be wrong (ratios fall back to plain numbers).
- NaN and ±Inf samples are drawn as gaps; the JSON view shows them as returned.
- The absolute time inputs are `datetime-local`, so their display format follows the browser
  locale; all other times are local, 24-hour, ISO order. The text digest uses UTC.
- The token is in localStorage, readable by any script on the origin.
- With an explicit step the query can exceed 11,000 points; the backend's error is shown
  rather than the step being clamped.
- Relative ranges re-resolve "now" when the chart width crosses a 100 px bucket, which
  triggers a refetch on resize.
- Not tested: 200% zoom as such (400 px is the narrowest layout tested), real touch
  hardware, screen readers by ear, Safari and Firefox.
