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

This change's images (what it alters on screen, below) are taken by `e2e/real-api-shots.cjs`
through `shots.mjs` scenarios, before and after on the same mock and the same failures:

```sh
node e2e/real-api-shots.cjs <before app dir with dist/> <after app dir with dist/> reviews/real-api
node ../design-system/tools/shots.mjs compare reviews/real-api/before reviews/real-api/after reviews/real-api/compare
python3 e2e/encode-review-images.py reviews/real-api
```

`shots.mjs` can only open a URL, so `e2e/vite.shots.config.ts` adds a script to the dev page
(never to a build) that opens the time picker, the command palette or the settings dialog when
the URL carries `#shot=timepicker|palette|settings`. `e2e/states.cjs` takes the images
`shots.mjs` cannot: waiting states, focus rings, pressed and hover, and the coarse-pointer view.

### What this change alters on screen, for design review

No new component, token or style: `src/app.css` and `design-system/` are untouched. The text
inside existing components changes, and one button's action:

- **Error state** (`vz-empty`): the line that says who answered ("The API answered bad_data
  with HTTP 400." only for the API's own error; "The answer was HTTP 503 with no API error in
  it." otherwise), the advice by kind (a missing, refused or read-less key; a step too small
  for the range; each limit; PromQL viz does not run; the time limit; a busy API with its
  tries), and the button: "Open settings" for a key, "Use the automatic step" for too many
  points (it clears the step and runs), "Go to character N" now also on the viz API (from the
  editor's parser), else "Run the query again".
- **Waiting line** (`vz-progress`): while a busy answer is retried, "The API is busy (HTTP
  503). Asking again in 1 s." or "The API is limiting requests (HTTP 429). …".
- **Warnings banner** (`vz-banner`): "The API sent a warning with this result, so it may be
  incomplete: …" before the API's words.
- **Shell banner** (`vz-banner`): "The API needs an API key." / "The API did not accept the
  API key." / "The API key in settings cannot read metrics." instead of one sentence about
  rejected credentials.

Images: `reviews/real-api/compare/real-api-<state>-<1440|400>-<light|dark>.png` (before on
the left: the app at commit `060d3bd`; after on the right), with the separate images in
`before/` and `after/`, for nine states: a parse error, no key (401), a key without the read
scope (403), an unknown key (401), the time limit (503 `timeout`), busy with `Retry-After: 1`
(the waiting line at 0.7 s), the platform's 503 after four tries (the error state), a step too
small (400) and a warning. Both themes, 1440 and 400 px. **Not reviewed yet**: no expert
design review was held in this session; the change is not ready to merge until one is
(AGENTS.md, "Design changes", 5).

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
| `e2e/contract.cjs` | The contract test: the same 60 requests to the real API and to the mock, compared (82 checks) |
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
- States: start (examples are links), empty and error as `vz-empty`, warnings as a banner.
- The error state says who answered and what to do (`src/api/errors.ts`): "The API answered
  <type> with HTTP <status>" only for the API's own error envelope; "No answer came back",
  "The answer was HTTP 503 with no API error in it" or "The answer (HTTP 200) was not an API
  response" otherwise. The advice follows the kind of failure: a key that is missing ("No API
  key is set"), refused or without the read scope (the button opens Settings); a step too
  small for the range (the advice names the step and the 11,000 points, and the button is
  "Use the automatic step"); a limit, by which one (`max_query_bytes`: shorten the query;
  `max_depth`: simplify it; `max_output_points`, `max_step_points`: a larger step or a shorter
  range; what the query reads: narrow the range or select fewer series); PromQL viz does not
  run; the API's time limit; a busy API, with how many tries over how long; a parse error,
  with "Go to character N" from the API's position or, as the viz API gives none, from the
  editor's own parser. The shell's banner says the same about the key (needed, refused,
  without the read scope).
- A busy answer (429, 502, 503 other than the time limit) is asked again after its
  `Retry-After`, else after 1, 2 and 4 s, at most three times and never past the 60 s stop;
  the waiting line says so over the previous result ("The API is busy (HTTP 503). Asking again
  in 1 s.") and Cancel works throughout. The API's time limit (503 `timeout`) is not retried.
- The range-query body is read as it arrives into Float64Arrays (`src/api/matrix.ts`): a
  specialised scanner for `data.result`, exact for every number (property-tested equal to
  `JSON.parse` and `Number`, the body cut into pieces anywhere); anything it does not read
  falls back to `JSON.parse` with the same answer. Series values stay in Float64Arrays from
  the parser to the chart, legend, table and digest (a gap is NaN).
- The query window is computed in whole milliseconds, as the API evaluates it (start and end
  rounded to the millisecond, the step a whole number of milliseconds), so a sub-second step
  asks for the grid the API answers on.
- Autocomplete lookups (`labels`, `label values`, `series`) carry the page's window, widened
  to whole hours; without one the viz API reads every file of the tenant.
- The `X-Viz-*` cost headers are kept with each result (`cost`); nothing shows them yet.

**Shell**
- `vz-nav` with Explore and Help, a Commands button and Settings. Light and dark follow the
  system setting; the manual choice (System, Light, Dark, in Settings or the command palette)
  sets `data-theme` on the root and is stored in localStorage.
- Command palette (`Ctrl/Cmd+K`): the system's menu with a field above it.
- Settings: API base URL and bearer token in localStorage; "Test connection".
- Help page with the keyboard shortcuts.

## What is mocked

`mock/` serves the Prometheus API from data that is a pure function of (series, time):

- 328 series: `http_requests_total{service,route,status}` (36),
  `http_request_duration_seconds_{bucket,sum,count}` (48 + 8, 12 `le` buckets),
  `pod_cpu_usage_cores` and `pod_memory_working_set_bytes` by pod (12 each), `up` (12), and
  the 200 `viz_synthetic_series` gauges of the speed harness's 200-series case.
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
  11,000-point limit, counted as the real engine counts it.
- Not in the mock: subqueries, `and/or/unless`, `group_left/right`, `@`, native histograms,
  most other functions. These return a 422 `unsupported` error that says so (as the real API
  answers PromQL it does not run); a function that does not exist is 400 `bad_data`. The
  editor's linter knows full PromQL, so it will accept queries the mock rejects.
- Its HTTP surface is the real API's, checked request by request by `e2e/contract.cjs`
  ("Mock and real API"): methods and statuses per endpoint, error types and wording (no
  position in parse errors), `WWW-Authenticate`, the 29 `X-Viz-*` cost headers (most are 0:
  the mock reads no files), CORS, gzip, sorted label sets, label endpoints bounded by `start`
  and `end`, the query-size and nesting limits, times and steps in whole milliseconds, and,
  with `--require-token` / `--readless-token`, the 401 and 403 answers. Values agree with
  the real API's for the same data to 1e-9 relative (the seed writes the mock's own data).
- It fails on request as the real API (or what is in front of it) fails, for the error
  states: `GET /__mock/fail?kind=<k>&count=<n>` makes the next n query requests answer
  `busy` (503 `unavailable` "the query service is busy; retry", `Retry-After: 1`),
  `storage` (the same with "a storage component did not answer"), `config` (an unreadable
  limits record: 503, `Retry-After: 30`), `gateway` (deploy/gateway's 502), `timeout` (503
  `timeout`), `ratelimit` (a 429 with `Retry-After: 10` and no envelope: not the viz API) or
  `platform` (a 503 HTML page with no `Retry-After`: what the platform sends when a Worker
  fails; training knowledge, not verified). `/__mock/warn` adds `warnings` to the next
  answers, which the viz API never sends. A delay longer than the query's time limit (30 s,
  or a `timeout` parameter) is answered 503 `timeout`, as the real API does.

## The real viz API, locally

The app runs against the real API: the write path, the query Worker and the control plane,
put behind `deploy/gateway` in one script (`real/worker.ts`, `real/wrangler.jsonc`) and served
by `wrangler dev --local`. Nothing is deployed and nothing reaches Cloudflare: the Cloudflare
credentials are removed from wrangler's environment and every binding is local.

```sh
node real/stack.mjs start     # wrangler dev --local on 127.0.0.1:8851; provisions tenant viz-app-e2e through the
                              # gateway's one-time bootstrap (control's Tenant.provision) and creates the keys
                              # app-read [read] and app-write [write]
node real/stack.mjs seed      # real/seed.ts: 13 Remote Write requests (snappy protobuf, through edge), 472,360
                              # samples: every series of the mock, sample for sample, 08:00 to 14:00 UTC on
                              # 2026-11-18 (counters, a classic histogram, gauges with a 12-minute gap, `up`,
                              # and the 200 `viz_synthetic_series` gauges)
VIZ_API_TARGET=http://127.0.0.1:8851 npx vite preview   # the app on it; paste the read key in Settings
node real/stack.mjs stop
```

Everything it writes is under `real/.wrangler/` (git-ignored): the local Durable Object, R2,
KV and queue state, the log, and `keys.json` (mode 0600). Keys are never printed. One setting
differs from production: `INGEST_LIMITS` lets edge accept any timestamp (the e2e window is
older than edge's one-hour acceptance window), as `query/test/wrangler.jsonc` does. The queues
are real (local): segments are sealed and flushed to Parquet, so queries read lake files and
shard tails. **`wrangler dev` reloads when the source of the components changes**, so the
"real API" is the working tree of `query/`, `edge/`, `control/` and the rest as they are at
that moment, other engineers' edits in progress included (two appeared while this change was
being checked: a new cost header, and a gateway `/healthz` that also asks the ruler and MCP
backends, which this local stack does not include; `real/stack.mjs` and `e2e/lib.cjs` now
count the stack as up when ingest, query and control answer).

## Mock and real API

Found by sending the same requests to both (`e2e/contract.cjs`: 60 requests, 82 checks; the
real answers are kept in `e2e/measurements/contract-real.json`) and by running the app on
both (`e2e/real.cjs`). "Mock" is the mock as it was before the change that found the
difference. The first column says which pass found it: 1 is the first pass (the change
before this one), 2 is this one.

| Pass | Where | Real API | Mock (before) | Done |
|---|---|---|---|---|
| 1 | Authentication | every `/api/v1/` path needs a key with the `read` scope: no key 401 `unauthorized` "missing API key", a wrong one 401 "invalid API key", both with `WWW-Authenticate: Bearer realm="viz"`; a key without `read` 403 `forbidden` "API key lacks the read scope" | no key needed; `--require-token` gave 401 "missing or invalid bearer token" with no challenge, and no 403 | app: the error state says what to do with the key and its button opens Settings (it said "Change the query"); mock: the same answers in `--require-token` mode, plus `--readless-token` for 403 |
| 2 | Authentication, as a person reads it | a missing key and an unknown key are both 401 | (same) | app: a 401 with no key in Settings now says "No API key is set" (it said the API "did not accept the API key"), and the shell's banner tells the three cases apart (it said "rejected the credentials" for all of them, a missing key and a key without the read scope included) |
| 1 | Busy | 503 `unavailable` with `Retry-After: 1` (a storage component, a leaf), `Retry-After: 30` (an unreadable limits record); the gateway answers 502 `unavailable` with `Retry-After: 1` when the Worker throws | never | app: retries a busy answer after its `Retry-After` (else 1, 2, 4 s), at most three times and never past the 60 s stop; the waiting line says what happened and when it asks again; the error state after the last try says how many tries over how long |
| 2 | Busy, the isolate's byte budget | "the query service is busy; retry" now carries `Retry-After: 1`: `query/src/index.ts` sends it with every `unavailable` since 2026-11-19 | no `Retry-After`, as the real API answered when the mock was written | mock: `Retry-After: 1`; the no-`Retry-After` path (the app's own 1, 2, 4 s) is now exercised by `kind=platform`, a 503 page with no envelope, which is the only busy answer without one the app can meet |
| 1 | Rate limit | never 429 (not in `query/`); a rate limit in front of it (Cloudflare) would send one, with `Retry-After` and no envelope | never | app: 429 is "busy", retried after `Retry-After`, the line says "limiting requests"; mock: `kind=ratelimit` (marked as not the viz API) |
| 1 | Time limit | 30 s (`timeoutMs`), lowered by `timeout`: 503 `timeout` "query timed out", no `Retry-After` | no limit | app: not retried; the advice names the time limit; mock: the same 503 at 30 s or at `timeout`; `stall=1` delays as a stalled connection (the app's own 60 s stop) |
| 1 | Query limits | 422 `execution` "query exceeded limit max_query_bytes …", "… max_depth …" and the other limits | a 25 KB query was a 500 "Maximum call stack size exceeded"; no depth limit | mock: both limits, same words |
| 2 | Query limits, as a person reads them | each limit names itself (`max_query_bytes`, `max_depth`, `max_output_points`, `max_samples`, …) | (same) | app: the advice depends on the limit; it told a person whose query text was over 16 KiB to "narrow the time range or select fewer series" |
| 2 | Too many points | 400 `bad_data` "exceeded maximum resolution of 11000 points per timeseries" when ⌊(end − start) / step⌋ + 1 > 11,000 (`engine/query` `check_range`): 11,000 steps, 11,001 points, are refused | refused only above 11,000 steps, on the unrounded seconds | mock: counted as the real engine counts; app: the advice is about the step ("The step is too small for this time range …") and the button clears it ("Use the automatic step"); it said "Change the query" and offered "Run the query again", which is refused again |
| 2 | Times and steps | start and end rounded to the millisecond on the digits (the fourth decimal rounds half up), RFC 3339 cut after the millisecond, the step floored to a whole millisecond (0.4 ms is a step of 0: 400), evaluation on a grid of whole milliseconds (`1794994200.1`) | float seconds: a 0.1 s step from `1794994200.0000002` (what the app sent then) answered `1794994200.0000002`, `1794994200.1000001`, …, five points where the API gives six; a 0.4 ms step was accepted; a 0.9817 s step over 3 h was refused (the API rounds it to 982 ms: 10,998 points) | mock: the real parsing and grid; app: the window is computed in whole milliseconds, and a sample is on the grid when within 5 µs of a grid time (a tolerance of 1e-6 *steps* put the API's answers to steps of a few milliseconds off the grid, where a missing step is not drawn as a gap; at a 0.1 s step the window computed in fractional seconds was what moved the grid) |
| 1 | PromQL it does not run | 422 `unsupported` ("limitk / limit_ratio aggregations") | 400 `bad_data` "… is not supported by the viz mock backend" | app: advice "viz does not run this part of PromQL yet"; mock: 422 `unsupported` for valid PromQL it lacks, 400 for a function that does not exist |
| 1 | Parse errors | `parse error: unclosed left parenthesis`: **no position** | `invalid parameter "query": 1:48: parse error: …` | app: "Go to character N" asks the editor's own parser where the error is when the API gives no position; mock: the real API's form and words. Needed in `query/` (below) |
| 1 | Parameter errors | `invalid parameter "step": zero or negative …`, `invalid parameter "end": end timestamp must not be before start time`, `invalid parameter "query": the query is empty` | other words | mock: the real words |
| 1 | Methods, paths, body | `query`, `query_range`, `labels`, `series` take GET and POST; `label/<n>/values`, `metadata`, `status/buildinfo` GET only (405 with `Allow`); unknown paths 404; only form bodies (a JSON body is 400) | any GET or POST; other errors | mock: the same table |
| 1 | Label endpoints | bounded by `start` and `end`; without them, all time, which reads every data file of the tenant | ignored `start` and `end` | app: every autocomplete lookup sends the page's window, widened to whole hours; mock: honours them |
| 1 | Label sets | label names sorted in every label set; series listed in label order | insertion order | mock: sorted |
| 1 | `metadata`, `buildinfo` | `{}`; `version`, `revision`, `branch`, `buildUser`, `buildDate`, `goVersion` | metadata for every metric; three fields | mock: `{}` and the six fields, plus `mock: true` (the banner) |
| 1, 2 | Cost | `X-Viz-*` headers on every answer after authentication, exposed through CORS: 28, then 29 (`X-Viz-Series-Estimate`, added to `query/src` while this change was checked, uncommitted then) | none, then 28 | app: the client keeps them with each result, shown nowhere yet; mock: the same 29 names, most 0 |
| 1 | CORS | the request's origin echoed when on the allow-list, `Vary: Origin`, cost headers exposed; never `*` | `*` | mock: the same |
| 1, 2 | Compression | gzip when the client accepts it, with `Vary: Origin` only (under `wrangler dev`) | none; then gzip with `Vary: Origin, Accept-Encoding` | mock: gzip, `Vary: Origin` as the real API sends it |
| 1 | `warnings`, `infos` | never sent: a part of an answer is refused (503), never returned as partial | never | app: the warnings banner says the result may be incomplete before the API's words; `infos` are read (not shown); mock: `/__mock/warn` |
| 1 | Values, timestamps | for the same data, equal to 1e-14 relative; times to the millisecond | equal | the contract compares values for 22 requests |

## Needed changes in query/

`query/` was not edited. Each item is a request to the real stack (`real/stack.mjs`, tenant
`viz-app-e2e`, a key with the `read` scope as `Authorization: Bearer …`, window
`start=1794994200&end=1795005000` unless said) and its answer (`e2e/measurements/contract-real.json`
holds every answer of the last contract run). Prometheus' behaviour is training knowledge
from its source and documentation, not checked against a running Prometheus.

1. **Parse errors carry no position.** `query=sum by (service) (rate(http_requests_total[5m])`
   answers `400 bad_data "parse error: unclosed left parenthesis"`; Prometheus says
   `invalid parameter "query": 1:49: parse error: unclosed left parenthesis`. Without
   `line:column` a client cannot point at the error; the app asks its editor's parser
   instead, which can disagree with the engine's. Some messages say nothing: `query=foo bar`
   answers `parse error: invalid promql query`, where Prometheus names the unexpected token.
2. **One point fewer than Prometheus allows.** `query=1&step=1&end=start+11000` (11,000 steps,
   11,001 points) answers `400 "exceeded maximum resolution of 11000 points per timeseries"`;
   Prometheus refuses only when `(end − start) / step > 11000`, so it answers this one.
   `engine/query/src/lib.rs` `check_range` counts points (`steps + 1 > max_steps`). A Grafana
   panel that asks for exactly 11,000 intervals works on Prometheus and fails on viz. Wanted:
   Prometheus' rule, or the message saying "more than 11,000 steps".
3. **`unsupported` messages are fragments.** `query=limitk(1, up)` answers
   `422 unsupported "limitk / limit_ratio aggregations"`: no verb. Wanted: a sentence, e.g.
   "limitk and limit_ratio are not supported by viz".
4. **A timeout does not say the limit.** `query=viz_synthetic_series&step=15&timeout=1ms`
   answers `503 timeout "query timed out"`; after the tenant's 30 s limit a person sees the
   same words and cannot tell a limit from a stall. Wanted: "query timed out after 30 s (the
   tenant's limit)".
5. **A top-level subquery in a range query is 422, not 400.** `query=up[5m:1m]&step=15`
   answers `422 execution "range vector is only allowed as a function argument or at the top
   level of an instant query"`; Prometheus answers 400 `bad_data` ("invalid expression type
   "range vector" for range query, must be Scalar or instant Vector"). A client switching on
   the status sees an evaluation failure for a query that never ran.
6. **The label endpoints without a window.** `GET /api/v1/labels` with no `start` and `end`
   took 553 ms and 151 ms here, against 187 ms and 74 ms with the e2e window (measured here,
   local, 4 small files, load average 11 on 4 cores); on a real tenant it reads every file of
   the tenant or is refused by the limits (`query/README.md`, "Cheap label endpoints"). The
   app always sends a window; Grafana's metric browser with no range will not. Wanted: a
   default window (the last day, say), documented. These answers also report
   `X-Viz-Samples-Loaded: 0` (known in `query/README.md`).
7. **`/api/v1/metadata` is always `{}`.** The editor completes metric names without type or
   help text on the real API. Known in `query/README.md`; listed because the app runs on it.
8. **Compressed answers do not vary on `Accept-Encoding`.** Under `wrangler dev` every answer
   is gzip with `Vary: Origin` only. A shared cache keyed by `Vary` could hand gzip to a
   client that did not ask for it. Probably workerd's automatic compression rather than
   `query/` (not checked on Cloudflare, where the edge compresses); listed so that the
   deployed answer is checked.
9. **Nothing is said about a partial answer, because there is none.** Not a change: the app's
   warnings banner is worded for Prometheus-compatible stores that answer in part; the viz
   API refuses instead (503), which the app handles as busy.

Also seen, outside `query/` (read in the source, not run): control publishes `limits:<tenant>`
with snake-case fields (`query_max_series`, `query_timeout_seconds`, …; `control/src/ops-settings.ts`),
while the query Worker reads camel-case fields (`maxSeries`, `timeoutMs`) from the same key
and ignores unknown ones (`query/src/config.ts`), so query limits set through control never
reach queries.

An earlier draft of this list (in the session before this one) said the isolate-budget
refusal "the query service is busy" has no `Retry-After`. That was true when written and is
no longer: `query/` now sends `Retry-After: 1` with it, and the item was dropped.

## Not implemented

- Everything outside metrics Explore: dashboards, logs, traces, alerts, the agent surface.
- No Worker/Hono/Cloudflare deployment config; this is a static SPA build only.
- No auto-refresh, query history, multiple queries per view, exemplars or annotations.
- The table is derived from the range result (last sample per series), not from a separate
  instant query. Scalar and string instant results have no dedicated rendering.
- Neither the legend nor the table is virtualised; both are capped instead. The legend has at
  most eight coloured rows and one Other row whose members are listed 50 at a time; the table
  shows 50 rows at a time.
- The range-query body is read on the main thread, as it arrives (`src/api/matrix.ts`); the
  worker that would read it off the main thread (`src/api/matrixWorker.ts`) is built and
  tested but not used (see "Speed": the harness cannot measure it fairly). Instant queries,
  label endpoints and every error are read with `JSON.parse`.
- No Arrow transport, no coarse-then-refine loading.
- No login flow; the key is pasted into Settings and sent as a bearer token.
- The `X-Viz-*` cost of a query is kept but shown nowhere (where it belongs is a design
  question), and the app cannot ask what a query would cost before running it (the viz API
  has no plan-only endpoint).
- Instant queries (`/api/v1/query`) are in the client but no view uses them.
- Not run against the real API: Grafana-style clients other than the app, a deployed
  (Cloudflare) viz, and the refusals that need concurrent load (the isolate's byte budget)
  or a broken component (a missing file, a leaf failing twice); the mock's `busy` and
  `storage` failures stand in for them, with the answers read from `query/src`.

## Verification

Run on 2026-11-19 on the final source of this change, Node 22.23, on a machine shared with
other builders (load average 9 to 26 on 4 cores), the real stack under `wrangler dev --local`
on port 8851.

| Check | Result |
|---|---|
| `npm test` | 160 tests in 14 files pass (two workers) |
| `npx tsc --noEmit` | passes |
| `npm run build` | passes (its prebuild regenerates `design-system/dist` and `bundle.css`; nothing in `design-system/` changed) |
| `node ../design-system/tools/check.mjs src` | **fails**: contrast and structure 552/552, but 4 literal values, all in `src/app.css` (lines 6, 23, 90, 122: an ignore without a reason, `100vh`, `100vw`, `90%`). `app.css` is unchanged since 2026-11-18 20:03; the check's rules were tightened since (`design-system/tools/check.mjs`, 2026-11-19). This change may not edit `app.css`; the four are left for the system migration (Known issues) |
| `node e2e/run.cjs` | 54 of 54 checks pass |
| `node e2e/design.cjs` | 52 of 52 checks pass |
| `node e2e/fixes.cjs` | 37 of 37 checks pass, including the 60 s stop |
| `node e2e/errors.cjs` | 15 of 15 checks pass |
| `node e2e/contract.cjs` | 82 of 82 checks pass: 59 requests to both, compared, 22 of them value by value, and the limits-record refusal (one wording difference, reported, not failed: the mock's "aggregation "limitk" (not implemented …)" against the real "limitk / limit_ratio aggregations") |
| `node e2e/real.cjs` | 28 of 28 checks pass on the real API (one page error is expected and checked for: the PromQL linter's stack overflow on a 5,000-term query) |
| axe-core 4.14 | 0 serious or critical violations in 16 runs (5 in `run.cjs`, 8 in `design.cjs`, 3 in `fixes.cjs`) |
| `MUTANTS=real node e2e/mutants.cjs` | first run 23 of 25 killed; the 2 survivors answered with tests (one found a bug, fixed) and re-run with a new mutant: 26 of 26 killed (table below) |
| `MUTANTS=fixes node e2e/mutants.cjs`, `node e2e/mutants.cjs` | not re-run in this change; their results below are from the changes that wrote them |

Changed checks in this change (none deleted): `e2e/errors.cjs` tests the 1, 2, 4 s retries
with the `platform` failure (the real API's busy refusal now carries `Retry-After: 1`, which
gained its own check), and checks that an answer that is not the API's is not called the
API's; the 401 checks expect "No API key is set" without a key and gained an unknown-key
case. `e2e/real.cjs` expects the step advice and "Use the automatic step" for too many points
(and that the button runs the query with the automatic step), the query-text advice for a
16 KiB query, the banner's three wordings, and gained a 100 ms step and a `max_samples`
refusal. `e2e/fixes.cjs`'s focus walk reaches "Run the query again" through `limitk(1, up)`
(PromQL the mock does not run) and "Use the automatic step" through too many points; both
hand focus to Run query. `e2e/contract.cjs` gained eight requests on times and steps.

Unit tests added in this change: the error kinds, advice and answer line for every answer of
the real API and the platform's 503 (`errors.test.ts`); the window in whole milliseconds,
with a property over random windows and steps (`lib.test.ts`); a sub-second step kept on the
grid with its gap (`series.test.ts`); the mock's millisecond grid, its resolution count and
its time and step parsing against the real stack's answers (`mock/promql.test.ts`).

From the review fixes, one existing check changed: `e2e/design.cjs` expected the segmented control's pressed fill to
be the `rule` token. While this work ran, the system added a `pressed` token and moved
`:active` to it, so the check now expects `pressed` when the system defines one and `rule`
before. No check was deleted.

Unit tests cover what they did before (downsampling, step selection, URL round-trip, digest,
API client, the mock's PromQL), the typed-array parser (`matrix.test.ts`: properties against
`JSON.parse` over bodies cut anywhere, the fast path for the bodies APIs send, the fallback),
and for the review fixes: what a result says about itself
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

**This change** (`MUTANTS=real node e2e/mutants.cjs`, results in
`e2e/measurements/mutants-real.txt`): one property broken at a time in a copy of the app in
the session's scratch area (never in the checkout), the copy rebuilt, the unit tests and
`e2e/errors.cjs` run. First run: 25 mutants, **23 killed, 2 survived**. Both survivors were
answered with a test, and those two and one mutant added for the bug the second test found
were run again alone: **26 of 26 killed**.

| Mutant | Caught by |
|---|---|
| parser: a number is scaled by multiplying by a power of ten below 1 (inexact) | the parser's properties against `JSON.parse` and `Number`; the real API's and the mock's bodies; the alignment property |
| parser: digits past 2^53 are computed, not read by `Number()` | the parser's properties; `readNumber` against `Number` |
| parser: "+Inf" is read as NaN | the parser's properties and fixed bodies |
| parser: a sample cut in two by the network loses its first character | the property over bodies cut anywhere |
| parser: an escaped quote in a label value ends the metric object early | the parser's properties |
| parser: a time that is not a JSON number is accepted | **survived the first run**: no test fed a leading zero (`01`) through the compact path. Now killed by the check that `01`, `00`, `-01`, `0123`, `.5`, `5.`, `1.e3` and `-` are refused as `JSON.parse` refuses them, compact and spaced |
| parser: the body text the JSON form reads is the first piece only (the lazy join) | the property that the text is the body, cut anywhere |
| alignment: a gap is 0, not NaN | alignment and gap tests; `e2e/errors.cjs` page checks |
| alignment: the grid tolerance is a fraction of a step | **survived the first run**: the test used a 0.1 s step, which at this epoch stays within 1e-6 of a step (9.5e-7 at worst), so it could not tell. Now killed by the same test at 2 ms and 1 ms steps, which also found that the grid's point count used a 1e-9-of-a-step margin and could drop the last point of a millisecond step (fixed: the count uses the same 5 µs) |
| alignment: the grid's points are counted with 1e-9 of a step | the millisecond-step test (added with the fix above) |
| window: computed in fractional seconds | the window property (`lib.test.ts`) |
| chart: a NaN gap reaches the renderer as a value | the downsampling tests |
| statistics: a NaN gap counts as a value | the statistics tests |
| errors: the API's time limit (503 `timeout`) is retried as if busy | the kinds of every real answer; retry rules; `e2e/errors.cjs` (not retried) |
| errors: `Retry-After` is ignored | the delay tests; `e2e/errors.cjs` (asked again in 1 s, 10 s) |
| errors: retries ignore the 60 s stop | the retry rules |
| errors: the waiting line does not say the API is busy | `e2e/errors.cjs` |
| errors: a refused key is told to change the query | the advice tests; `e2e/errors.cjs` |
| errors: the button of a refused key runs the query again instead of opening Settings | `e2e/errors.cjs` |
| errors: `Retry-After` as an HTTP date is not read | `parseRetryAfter` tests |
| warnings: the banner does not say the result may be incomplete | `e2e/errors.cjs` |
| autocomplete: lookups are not bounded by the page's time range | the lookup-window test (`promClient.test.ts`) |
| errors: a step too small for the range is advised as a change to the query | the kinds and the step advice tests |
| errors: every limit is advised as "narrow the time range" | the limit advice test |
| errors: a 401 with no key set says the key was refused | the key advice test; `e2e/errors.cjs` (no key) |
| errors: an answer that is not the API's is reported as "the API answered" | `e2e/errors.cjs` (the platform's 503) |

The full "caught by" lists are in the results file. What the mutation run does not cover:
the mock's own changes, which the contract test checks against the real API instead: run
against the mock as it stood at the restart (commit `6488856`; HTTP only, the limits-record
case left out), it passes 27 of 80 checks and fails on `Vary`, the set of cost headers, the
timestamps of the fractional-start and 1.5 ms cases, and the status of the sub-millisecond
step, the 0.9817 s step and 11,000 steps; and the shell's banner wording (checked by
`e2e/real.cjs`, not by a mutant).

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

### Earlier measurements

The review fixes' before/after tables (4, 36 and 200 series, with typing; Chromium, 4x CPU,
Fast 4G, 1440 x 900, 20 runs, load 3.2 to 13.7) are in
`../design-system/reviews/app-restyle/fixes/FIXES.md` and in
`e2e/measurements/fixes-{before,after}-{4,36,200}.json` (`node e2e/summarise.cjs`). The
restyle's table (four series, no typing) is in `../design-system/reviews/app-restyle/PR.md`.
What the review fixes left, as they recorded it (this change's section above says what
became of it):

**Still missed after the review fixes, and why.** 36 series, response to paint (116 ms; 160 ms from the last byte),
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

### Bundle (built assets)

Before is the app at commit `060d3bd`, after is this change, both built against the same
design-system snapshot (the sizes `e2e/measure.cjs` records in `rapi-{before,after}-4.json`).

| File | Before raw | Before gzip | After raw | After gzip |
|---|---|---|---|---|
| `index-*.js` (app, React, router, query, uPlot): the shell | 458.4 kB | 150.9 kB | 476.0 kB | 156.6 kB |
| `PromqlEditor-*.js` (CodeMirror + PromQL, lazy) | 448.9 kB | 141.9 kB | 449.7 kB | 142.2 kB |
| `index-*.css` | 51.6 kB | 9.8 kB | 51.6 kB | 9.8 kB |
| `index.html` | 1.4 kB | 0.8 kB | 1.4 kB | 0.8 kB |
| Fonts (WOFF2, already compressed) | 128.8 kB | | 128.8 kB | |

gzip level 9, as `e2e/measure.cjs` computes it. The shell's script grows by 5.7 kB
compressed (the parser, the error kinds and advice, the retries) to 156.6 kB, under the
200 kB limit. The worker reader is not in the build (nothing imports it but its type).

## Known issues

- Speed: SPEED_KNOWN_ISSUE
- No timing in this README was judged: every run started with the load average above the
  core count (9 to 26 on 4 cores). They need measuring again on a quiet machine.
- `node ../design-system/tools/check.mjs src` fails on four values in `src/app.css` (an
  ignore without a reason, `100vh`, `100vw`, `90%`), which the tightened check now counts;
  this change may not edit `app.css`. For the system migration.
- The range-query parser (`src/api/matrix.ts`, about 600 lines) is specialised: it reads
  `data.result` itself and leaves everything else to `JSON.parse`. A body it misreads would
  draw wrong numbers without an error. It is property-tested against `JSON.parse` and
  `Number` on 1,000 random bodies cut anywhere and gives up its fast path on anything it does
  not expect, but it is new code on the path every result takes.
- The JSON form joins the body's text the first time it is shown for a result (3.4 MB for 200
  series, about 12 ms unthrottled in Node), not when the result arrives.
- "The real API" here is the working tree of `query/`, `edge/`, `control/` and the rest under
  `wrangler dev`, which reloads on every edit: the contract test can fail because another
  component is mid-edit, and its answers file records what the tree answered at that moment.
- The worker reader (`src/api/matrixWorker.ts`) is kept, tested and not used: whether it helps
  on a phone cannot be measured with DevTools throttling (it does not throttle workers).
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
- With an explicit step the query can exceed 11,000 points; the API's refusal is shown, with
  the advice and the button "Use the automatic step", rather than the step being clamped.
- Relative ranges re-resolve "now" when the chart width crosses a 100 px bucket, which
  triggers a refetch on resize.
- Not tested: 200% zoom as such (400 px is the narrowest layout tested), real touch
  hardware, screen readers by ear, Safari and Firefox.
