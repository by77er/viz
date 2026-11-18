# viz web app

The viz frontend. First slice: an **Explore** view for metrics against a Prometheus-compatible
HTTP API (`/api/v1/query_range`, `/query`, `/labels`, `/label/<name>/values`, `/series`,
`/metadata`, `/status/buildinfo`).

> **The backend used for development and tests is a mock** (`mock/`): synthetic data and a
> subset of PromQL. It is not the viz query backend. The UI shows a banner whenever it is
> connected to it.

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
presence test, is described in `../design-system/reviews/app-restyle/PR.md`.

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
npm run e2e           # e2e/run.cjs then e2e/design.cjs (Playwright + axe); needs `npm run build` first
npm run measure       # the speed budgets on the built app (see "Speed")
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
| `src/api/` | Typed Prometheus client: AbortSignal, error envelope, base URL, bearer token |
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
| `mock/` | Mock backend: synthetic data, PromQL subset, HTTP handler, Node server |
| `src/app.css` | Layout, and uPlot/CodeMirror/`<dialog>` adapted to the tokens. Tokens only |
| `e2e/run.cjs` | End-to-end and accessibility checks of the behaviour |
| `e2e/design.cjs` | Design-system checks: colour, waiting, keyboard, touch, narrow |
| `e2e/fixes.cjs` | Checks of the fixes to the design review (B1, B3, M2 to M5, M7) |
| `e2e/measure.cjs` | Speed budgets, before or after, for 4, 36 and 200 series (`e2e/measurements/*.json`) |
| `e2e/summarise.cjs` | Prints the before/after speed table from the measurement files |
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

Run on 2026-11-18, Node 22.23, on a machine shared with other jobs.

| Check | Result |
|---|---|
| `npm test` | 71 tests in 5 files pass |
| `npx tsc --noEmit` | passes |
| `npm run build` | passes |
| `node ../design-system/tools/check.mjs src` | contrast 122/122; 0 literal values in 37 files |
| `node e2e/run.cjs` | 54 of 54 checks pass |
| `node e2e/design.cjs` | 52 of 52 checks pass |
| axe-core 4.14 | 0 violations of any impact in 13 runs (5 in `run.cjs`, 8 in `design.cjs`) |
| `node e2e/mutants.cjs` | 12 mutants killed, 1 survived because it does not break the property (below) |

Unit tests cover what they did before (downsampling, step selection, URL round-trip, digest,
API client, the mock's PromQL), with the colour tests rewritten for the eight tokens and the
fold into Other, and a test for the four result forms and the old `tab=json` links.

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

Each line of `e2e/measurements/mutants.txt` is one property broken in the source, the app
rebuilt, and `e2e/design.cjs` run:

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

### Speed

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

- Colour: a series keeps its hashed token only while no series earlier in sort order claims
  it in the same result, so a series can change colour between two different queries. With
  more than eight series, which eight are coloured is decided by sort order, not by value, so
  the largest series can be one of the grey ones. Selecting it isolates it but does not give
  it a colour.
- Adding or removing a series from the selection needs Shift or Ctrl, which a touch screen
  does not have; on touch a row can only be isolated or shown with all the others.
- The first visit to a backend that is not the mock reserves the mock banner's space and
  then gives it back, which moves the page once. After that the browser remembers
  (`viz.backend.mock` in localStorage).
- CPU cores and plain numbers are shown without a unit after the value ("1.42", "500m"); the
  unit is stated once, in the panel head.
- The favicon is an inline SVG and cannot read the tokens; it repeats the two `ink` values.
- "Commands" and "Settings" in the navigation are nouns, not verbs.
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
