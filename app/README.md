# viz web app

The viz frontend: an **Explore** view for metrics and **Dashboards, read-only** (the list, and
one dashboard at a time), with sign-in by API key, built to be served as static files by the
gateway at `vis.bitcru.sh/` and to call the API on the same origin (`/api/v1/query_range`,
`/query`, `/labels`, `/label/<name>/values`, `/series`, `/metadata`, `/status/buildinfo`, and
control's `/api/v1/control/whoami`, `/api/v1/control/dashboards` and
`/api/v1/control/dashboards/<id>`).

> **Dashboards (2026-11-27) is the newest slice and its design is not reviewed.** What it is,
> how it was checked, its mutants, its speed and what it leaves out are under "Dashboards,
> read-only"; the images for the design reviewer are in
> `../design-system/reviews/app-dashboards/`. The sections after it describe the app as it
> was before (Explore, sign-in, the move to design system v9), and where they say "the one
> working view" or count tests, they count that state.

> **It is not deployed.** The build is ready to serve and this README says exactly what the
> gateway has to do with it ("Needed changes in deploy/", and `serve.json` as data); `deploy/`
> is another builder's, who is building the gateway to serve the app by `serve.json`
> (`../deploy/README.md`). The app was not run behind that gateway here.
> **Its design is not approved.** The move to design system v9 was rejected by an independent
> review (`../design-system/reviews/app-v9/review.md`, 2026-11-27); the fixes are verified and
> `../design-system/reviews/app-v9/response.md` is the disposition, status "awaiting
> re-review". Its blocker B1 (a result with many series painted late) is being handled
> separately in the design system's chart, so it is not ready to merge until that lands and a
> reviewer approves (AGENTS.md, "Design changes", 5).
>
> **The backend used for development and most tests is a mock** (`mock/`): synthetic data and
> a subset of PromQL. It is not the viz query backend, and the UI shows a banner whenever it
> is connected to it. The app also runs against the **real viz API**, served locally by
> `wrangler dev --local` (`real/`): `e2e/real.cjs` runs the app on it, sign-in included, and
> `e2e/contract.cjs` sends the same requests to it and to the mock and compares the answers
> ("Mock and real API").

## Design system

The app is on the viz design system, version 9 (`../design-system`), and takes its look and
its chart from it:

- `src/main.tsx` imports `design-system/dist/viz.css` (tokens, components, the two
  self-hosted fonts; Vite copies the WOFF2 files into the build and `vite.config.ts` adds the
  preload link for the sans file). `index.html` puts `class="vz"` on the root.
- **The chart is the system's own** (`design-system/dist/viz-chart.js`, the reference chart
  built from the Chart component's preview), not a chart of the app's. `src/charts/` hands it
  a result and listens to it; it draws nothing. So the Chart rules hold by construction: the
  colour map ("what a person sees wins"), one Other band and one legend row past eight
  series, "Colour the eight largest" offered only when it would change a colour (D73), direct
  labels in a gutter, the readout in the foot, zoom by button, the legend as a table of
  toggles, the text form, and the height the chart reserves for itself. uPlot is gone.
- `design-system/dist/viz-press.js` is loaded with it: a press is painted from `pointerdown`,
  for a finger as for a mouse.
- `src/app.css` is 40 lines of what the system leaves to an application (the query well
  around an editor, the parked chart, the command palette's dialog, a reserved place).
  Every value is a token: `npm run check:tokens`
  (`node ../design-system/tools/check.mjs --no-render src index.html`) must pass, and does.
- `design-system/dist/` is generated and not committed. `npm run dev` and `npm run build`
  first run `scripts/ensure-design-system.mjs`, which generates it only when a file the app
  takes from it is missing or older than its source, so a build of the app does not rewrite
  the design system's files under someone else's work. `npm run design-system` generates it
  unconditionally.

What the app adds around the system's chart, and why, is in "Needed changes in the design
system". Every such addition is in `src/charts/Chart.tsx` and `src/charts/fixups.ts`.

## Run

```sh
npm install

# development: two terminals
npm run mock          # mock API on http://127.0.0.1:8821 (needs no key)
npm run dev           # the app on http://127.0.0.1:8820, /api proxied to the mock

# a mock that needs a key, as viz does (then sign in with the key)
npx tsx mock/server.ts --port 8841 --require-token viz_devKey00000000000_devSecret
VIZ_API_TARGET=http://127.0.0.1:8841 npx vite --port 8840

npm run build         # design system if needed, tsc --noEmit, vite build  -> dist/
npm test              # vitest unit tests (two workers at most)
npx tsc --noEmit      # typecheck
npm run check:tokens  # no literal colours, lengths, durations or opacity in src/ and index.html
npm run e2e           # e2e/app.cjs, errors.cjs, dashboards.cjs, prod.cjs (Playwright + axe); needs `npm run build`
node e2e/dashboards.cjs                     # the dashboards views alone (VIZ_ONLY=list,states,dashboard,panels,variables,requests,key,narrow)
node e2e/measure-dashboards.cjs [--phone]   # the speed budgets on the dashboards views (20 runs)
VIZ_MUTANT_DIR=<scratch dir> node e2e/mutants-dashboards.cjs          # the dashboards views' mutants, on a copy outside the tree
node e2e/dashboards-shots.cjs               # the design-review images of the dashboards views
VIZ_SLOW=1 node e2e/app.cjs                 # also the 10 s and 60 s rows of the waiting table
node e2e/prod.cjs                           # the build served as the gateway is to serve it, under the policy
SET=review2 VIZ_MUTANT_DIR=<scratch dir> node e2e/mutants.cjs   # the mutants of the second review's fixes
node e2e/measure-review2.cjs                # one 20-run timing of the two paths those fixes touch
npm run measure -- --series 4,36,200        # the speed budgets on the built app (--phone; --ui v4 --root <dir> for the app before v9)
node e2e/summarise.cjs --before v9-before --after v9-after            # before/after tables from e2e/measurements
VIZ_MUTANT_DIR=<scratch dir> node e2e/mutants.cjs                     # this change's mutants, on a copy outside the tree

# the real viz API, locally (no Cloudflare account is used; see "The real viz API, locally")
node real/stack.mjs start && node real/stack.mjs seed
node e2e/contract.cjs                       # the same requests to the real API and to the mock, compared
node e2e/real.cjs                           # the app on the real API, sign-in included (needs `npm run build`)
node real/stack.mjs stop
```

The end-to-end scripts use the globally installed Playwright (`require('playwright')`), start
the mock and `vite preview` (or their own static server) themselves and stop them afterwards.
`e2e/app.cjs` and `e2e/errors.cjs` use ports 8820 and 8821 unless `VIZ_E2E_APP_PORT` and
`VIZ_E2E_MOCK_PORT` are set (plus app port + 20 and mock port + 10 for a mock that requires a
key); `e2e/prod.cjs` uses `VIZ_PROD_PORT` (18940) and the two after it.

Mock options: `--port`, `--require-token <t>` (a key that reads metrics only), `--readless-token <t>`
(a key that is valid but lacks the read scope), `--dashboards-token <t>` (a key with `read` and
`dashboards:read`), `VIZ_MOCK_LOG=1` (logs requests), `GET /__mock/inflight[?reset=1]` (how many
API requests the mock is answering now, and the most at once), and artificial latency to
exercise the waiting states:

| Switch | Effect |
|---|---|
| `--delay <ms>` or `VIZ_MOCK_DELAY=<ms>` | every response waits this long |
| `?delay=<ms>` on a request | that response waits this long |
| `GET /__mock/delay?ms=<ms>` | from now on, `query` and `query_range` responses wait this long; `0` turns it off |

### Design-review images

```sh
node e2e/v9-shots.cjs <before app dir with dist/> <after app dir with dist/> <work dir> ../design-system/reviews/<change>/compare
```

runs one `design-system/tools/shots.mjs` scenario per build (every state in the script, both
themes, 1440 and 400 px, the same mock and the same steps), composes the pairs with
`shots.mjs compare`, and stores them with a palette that holds every token colour exactly.
A state names how the same act is done in each build where they differ; a state one build
cannot reach has no "before".

## Stack

Vite 8.3 · React 19.3 · TypeScript 7.0 · TanStack Router 1.170 and Query 5.108 ·
the viz design system 9 (its stylesheet, its chart, its press script) · CodeMirror 6 ·
vitest 5 · fast-check 4 · axe-core 4.14.

- **PromQL editor package:** `@prometheus-io/codemirror-promql` 0.316.0 (the official
  Prometheus package). Autocomplete goes through an adapter (`src/editor/promClient.ts`) onto
  the app's own API client, so it carries the key.
- **Not used, deliberately, to keep the bundle small:** shadcn/Base UI, cmdk, TanStack
  Table/Virtual, any chart library. The command palette is a native `<dialog>`; tables are
  hand-written on the system's classes.

## Layout

| Path | What |
|---|---|
| `src/api/` | Typed Prometheus client: AbortSignal, error envelope, bearer key, `Retry-After`, the `X-Viz-*` cost; `whoami` |
| `src/api/matrix.ts` | The range-query body read into Float64Arrays as it arrives (`JSON.parse` is the fallback) |
| `src/api/matrixWorker.ts` | The same in a dedicated worker; built and tested, not used by the app |
| `src/api/errors.ts` | What a failure means for the person: its kind, the advice, whether and when to ask again |
| `src/charts/systemChart.ts` | The design system's chart and press script, imported and typed; one chart per element |
| `src/charts/spec.ts` | A result as the chart takes it (null gaps, a unit it knows, the zone's clock), and the chart's number format for the table |
| `src/charts/Chart.tsx`, `fixups.ts` | The React element around the chart: a new result, an error, the range it shows; the words of the chart's that a query result needs otherwise |
| `src/editor/` | CodeMirror PromQL editor (a lazy-loaded chunk) |
| `src/explore/` | Explore: the page, the time range and step fields, the table, the text and JSON forms, the waiting logic |
| `src/dashboards/` | Dashboards, read-only: the list, one dashboard, its panels; `model.ts` (between the `viz.dashboard/v1` model in `../dashboard/src` and the views), `scheduler.ts` (what is sent, cancelled and delivered), `store.ts` (each panel's state) |
| `src/api/limiter.ts` | At most six requests in flight: the one limiter every request of the page goes through |
| `src/shell/session.tsx`, `SignIn.tsx` | Sign-in: the key, where it is kept, who gets in |
| `src/shell/` | Navigation, command palette, Settings and Help pages, theme |
| `src/lib/timeInput.ts` | Times and durations as typed and read ("18 Nov 09:16", "now - 6 h", "1 h 30 min"), in a zone |
| `src/lib/` | Step selection, URL state, series alignment and names, what a result says about itself, the focus keeper |
| `src/theme-init.js` | The stored theme applied before first paint; built as a file of its own |
| `serve.json` | What a server must do with `dist/`: document paths, asset prefix, headers. The statement `deploy/` is asked to implement |
| `scripts/ensure-design-system.mjs` | Generates `design-system/dist` when it is missing or stale |
| `mock/` | Mock backend: synthetic data, PromQL subset, the real API's HTTP surface, control's `whoami`; fails on request as the real API fails |
| `mock/dashboards.ts` | Four `viz.dashboard/v1` dashboards over the mock's series, and control's dashboard read routes; the same specs are what `real/seed.ts` creates in the real control plane |
| `real/` | The real viz API on one machine: `wrangler dev --local` of gateway, write path, query Worker and control plane; the seed |
| `e2e/app.cjs` | End-to-end checks of the app on v9: flows, colour, B1, the waiting table, the chart, keyboard, touch, zoom, time zone, layout shift, sign-in, axe |
| `e2e/errors.cjs` | What a person sees when the API refuses, is busy or stops a query, and when the key stops working mid-session |
| `e2e/dashboards.cjs` | The dashboards views end to end: the list and its states, a dashboard, panel kinds and failures, variables, what is sent and cancelled, the key, the phone layout, the second theme |
| `e2e/measure-dashboards.cjs` | The speed budgets on the dashboards views, desktop or phone |
| `e2e/mutants-dashboards.cjs` | The dashboards views' safety properties broken one at a time, on a copy outside the tree |
| `e2e/dashboards-shots.cjs` | The images for design review of the dashboards views |
| `e2e/prod.cjs` | The build served by `serve.json`'s rules, with the app driven under the content security policy |
| `e2e/contract.cjs` | The contract test: the same requests to the real API and to the mock, compared: 60 to the query API and 37 to control's dashboard read routes |
| `e2e/real.cjs` | The app on the real API: sign-in against control, the same reading of the same data as on the mock, refusals |
| `e2e/measure.cjs`, `summarise.cjs` | The speed budgets, desktop or phone, for 4, 36 and 200 series, on either build; tables with the load of every column |
| `e2e/mutants.cjs` | Breaks one property at a time, on a copy outside the tree, and records which check catches it |
| `e2e/v9-shots.cjs` | Before/after images for design review |
| `e2e/measure-review2.cjs` | One timing of "Show 50 more" and "Copy link" at both layouts (the second review's fixes) |
| `src/lib/scrollKeeper.ts` | A reload lands where the page was scrolled to |

## The views that exist

| Address | What it is |
|---|---|
| `/` | goes to `/explore` |
| `/dashboards` | **Dashboards**, read-only: the tenant's dashboards (name, intent, tags, owner, last change and by whom), searched and filtered by tag; empty, first-run, waiting, error and no-permission states |
| `/dashboards?id=<id>` | **One dashboard**, read-only: title and intent, the time range, its variables as controls, its panels as the spec lays them out; `from`, `to` and `var.<name>` in the address. The same document path as the list: a dashboard is never named in the path |
| `/explore` | **Explore**: a PromQL query over a time range, its result as a chart, a table, the chart's text form or the API's JSON; the start state before any query; empty, waiting, cancelled and error states. Without an accepted key the **sign-in form** stands here, at this address |
| `/help` | what Explore does, the keyboard, which commands the palette has on which page, API keys, and the button that opens the command palette |
| `/settings` | whose key this is, Sign out, the theme, the API's address and version |
| (anywhere) | the command palette (`Ctrl/Cmd+K`), the app's only dialog |

There is no monitors, alerts, logs or traces view, no editing of dashboards and no key
management ("Not implemented"). The gateway serves five document paths (`serve.json`): `/`,
`/explore`, `/dashboards`, `/help`, `/settings`.

## The second design review: fixes (2026-11-27)

The independent review of the app on v9 (`../design-system/reviews/app-v9/review.md`) rejected
it: three blockers, three majors, thirteen minors. This section is what was changed for it, how
each fix is held, and what is left. The finding-by-finding disposition for the re-review is
`../design-system/reviews/app-v9/response.md`, "The second review". **B1 (a result with many
series is painted late) is not fixed here**: the design system's chart is being changed for it
by another builder (`../design-system/reviews/chart-speed/`), and nothing in this section
claims it.

### What was changed

| Finding | Cause | Fix | Where |
|---|---|---|---|
| **B2** "Show 50 more of 200" took a tap on 34.5 px of its 44 | The row of controls stood straight under the table (`vz-table-wrap`, a positioned box that scrolls): the upper 9.5 px of the small button's hit area lay over the table's last row, which took the tap | What follows the table (the shared labels, the button) is a `vz-stack` with it: `space-4` clear of the last row, with either pointer. No new component, no app CSS | `src/explore/ResultTable.tsx` |
| **B3** a reload landed at the top | Two causes. (1) The browser restores a scroll position while the document loads, and at `load` this page is one window tall: the app draws after its script has run and the API has said whose key the tab holds. (2) The router scrolls the window to the top when its first page has rendered (`@tanstack/router-core`, `scroll-restoration.js`: `scroll.n` starts true and the `onRendered` handler is installed whether or not `scrollRestoration` is set); `resetScroll: false` on the app's own navigations does not reach the first render. `content-visibility` and the reserved heights were not a cause: the reserved layout is to the pixel, which is what makes the fix land exactly | `src/lib/scrollKeeper.ts`: the position is written to the tab's `sessionStorage` at `pagehide` and when the page is hidden; after a reload (or a return through the history to the same address) it is put back in the first frame in which the page is tall enough to hold it (a `ResizeObserver`, which runs after layout and before paint), and held for 1 s against the router's reset. The person's first input (wheel, touch, pointer, key) ends it at once. A link opened afresh starts at the top | `src/lib/scrollKeeper.ts`, `src/main.tsx` |
| **M1** the palette opened only with Ctrl/Cmd K, and "Copy a link to this view" had no control | The command was registered with no control on the page; Help did not say which commands the palette has where | Explore's page head has **Copy link** (the system's small button, in the head's actions; it says "Copied" or "Could not copy" as the two Copy buttons do), which copies the address with the form now shown. The palette's command presses that button. Help says the palette lists the commands of the page it is opened on and that every command is also a control. The palette stays a keyboard shortcut: no "Commands" button was added to Explore, because with Copy link every command it lists is a control on the page (checked by listing them, below) | `src/explore/ExplorePage.tsx`, `CopyButton.tsx`, `src/shell/HelpPage.tsx` |
| **M2** the text form and the chart's name left out the day and a warning | The chart writes a range inside one day as clock times and knows nothing of the API's warnings; the head added both, the name and the text form did not | The day the head states is put before the range in the chart's accessible name and in the text form's first line (also when zoomed, and under "The latest query failed"); when the API sent a warning the name ends "The API sent a warning: the result may be incomplete." and the text form has the head's own sentence as its second line. The copied text carries both | `src/charts/fixups.ts`, `src/charts/Chart.tsx`, `src/explore/ExplorePage.tsx` |
| **M3** five designed states were not in the images | They were checked and not pictured | `e2e/v9-shots.cjs` pictures them: `partial-answer`, `waiting-10s-alternative`, `stopped-at-60s`, `busy-asking-again`, `api-unreachable`, and `sign-in-api-unreachable`; and `touch-table-200-show-more` (B2's control, measured and outlined) | `e2e/v9-shots.cjs` |
| m1 the empty result's head read "18 Nov, · every 15 s" | The range in the head is written by the chart, and an empty result has none | The page writes the range where no chart does (`rangeWords`: the chart's form, and both days when they differ) | `src/lib/timeInput.ts`, `ExplorePage.tsx` |
| m2 the Step field's placeholder "30 s" beside "now 15 s" | An example that read as the value | No placeholder; the help line says the step in use | `src/explore/TimeRangeField.tsx` |
| m3 Tab stopped on the palette's list | A scroller is a tab stop of the browser's making | `tabIndex={-1}` on the list | `src/shell/CommandPalette.tsx` |
| m4 "Copy a link" said nothing; the palette's placeholder named a command some pages lack | The command copied without a word and swallowed a refusal | The command presses the page's Copy link button, which takes the focus and says what happened; the field has no placeholder | `ExplorePage.tsx`, `CommandPalette.tsx` |
| m10 a checkbox labelled with a statement | | "Show the key" | `src/shell/SignIn.tsx` |
| m12 an unreachable API raised no banner and nothing asked again | The banner hung on the build-information probe alone, asked once in five minutes | A query that gets no answer asks the probe again at once: if that fails too the banner is shown and the probe is asked every 10 s (as before); when it answers after having failed, the query that failed for want of it is asked again by itself. A query that fails alone while the probe answers is not repeated | `ExplorePage.tsx` |

**`src/charts/` (for the chart-speed patch).** Against commit `7469d5a`, `git diff -U0`:
`fixups.ts`: 6 comment lines added after line 16; `withDay`, `PARTIAL_NAME` and `withPartial`
added after `fixText` (9 lines after line 23). `Chart.tsx`: line 3 (the import); 4 lines added
after line 32 (the props `day` and `partial`); line 65 (the destructuring); 2 lines added after
line 69 (`live.current.day`, `.partial`, and `live`'s initial value); lines 87 to 89 (the
accessible name: the two unit-less lines became four that also add the day and the warning);
lines 114 to 117 (`fixForm`: the line that names the result, then the warning's line).
`spec.test.ts`: the import and one `describe` at the end. Nothing else in `src/charts/` was
touched; `systemChart.ts`, `spec.ts` and `index.ts` are as they were.

### How each fix is held

New checks: section `review2` of `e2e/app.cjs` (18 checks: M1, M2, m1 to m4, m10, m12),
section `reload` (7 checks: B3), one check and three more states in section `touch` (B2), and
in `e2e/dashboards.cjs` section `reload` (3 checks) and the hit-area measure at 1500 px with a
finger on each dashboard (3 checks). Unit: `src/lib/scrollKeeper.test.ts`, and cases in
`timeInput.test.ts` and `charts/spec.test.ts`.

- **B2**: at 400, 320 and 1500 px with a coarse pointer, on the table of 200 series, a tap
  16 px above the button's centre and one 16 px below each show the next 50 rows; and the
  page's hit-area measure (`lib.cjs` `hitAreas`: what the page says is at each point) passes
  with that table among its states. The same measure ran over the dashboards views: at 400 px
  it was already there and passes; **at 1500 px with a finger it found one control under 44
  px on every dashboard that has a chart: the legend's "Min" sort head, 43 px wide.** That is
  the design system's chart, the same 1 px the review recorded under B2 ("Same row, the
  design system's component"); the app does not draw it. The check says so in its name and
  counts them, and fails on anything else. It is a follow-up for the system's owner.
- **B3**: four pages (Explore's chart of 36 series, the table of 200, Explore signed in with
  a key on the API that needs one, Help), each loaded in a page of its own, scrolled until an
  anchor is 120 px under the top, reloaded, read 1.5 s after it has drawn: the same scroll
  position, the anchor within 1 px, layout shift under 0.05 with every entry counted. At
  1500 px and 400 px with a fine pointer, and at 400 px with a coarse pointer made coarse in
  Blink (`--blink-settings`, `isMobile`, no `hasTouch`), with the guard that the pointer is
  coarse before and after (`lib.cjs`, `COARSE_IN_BLINK`, `reloadLandings`; as
  `design-system/tools/audit.mjs` does). The same for two dashboards (the last panel and one
  in the middle of `services_overview`, the last of `pod_capacity`) and the list. Also: an
  address opened afresh starts at the top in a tab that remembers a position; the reloaded
  page is in place before its answer arrives (the mock answering 1.5 s late); a wheel turned
  meanwhile is not undone. And (added 2026-11-28, when the mutant that places the position
  once and does not hold it survived every other check): on Help and on the chart, a scroll
  to the top that no input made, 150 ms after the reloaded page is in place, is undone. That
  is what the router's reset does when its first page renders after the page is already
  tall; on this machine it comes first, so only a reset made by the check shows the hold.
  The wheel check now waits up to 1.2 s for the wheel's scroll instead of reading it at
  300 ms: in one whole run of 2026-11-28 the scroll had not been applied at 300 ms (600, then
  250 when read later), which is the page's main thread being late, not the keeper.
- **M1**: the palette is opened on Explore and every command it lists (19) is matched to a
  control that is on the page and visible; a command with no control fails the check. Copy
  link copies the address with the form shown and says "Copied"; the palette's command leaves
  the focus on that button, which says "Copied". Its hit area is measured with every other
  control's in section `touch`.
- **M2**: the head, the name and the text form's first line all say "18 Nov, 09:30 to 12:30";
  zoomed in, the day stays before the new range, once; with a warning from the mock
  (`/__mock/warn`) the banner's sentence is the text form's second line, once, the name ends
  with the warning, the copied text has both, and the next whole answer removes them.

### Mutants of these fixes

@@MUTANTS@@

### Images

`../design-system/reviews/app-v9/compare/` was made again on 2026-11-28, 08:14 to 08:45 UTC,
from the final build (`dist/` built 07:50 UTC from the source as it is now; no source file of
the app changed after it), by

```sh
node e2e/v9-shots.cjs <before app dir> . <work dir> ../design-system/reviews/app-v9/compare
```

(a whole run: no `VIZ_SHOTS_KEEP_BEFORE`, every state pictured for both builds). **Before** is
commit `5db517f` built again in the scratch area against this tree's `design-system/dist`
(v9; no commit has changed `design-system/src` or `tokens.json` since 26 Nov 07:00) with this
tree's `node_modules` plus `uplot` 1.6.32, which the app no longer depends on, fetched with
the integrity its lockfile records. Its `dist/assets` came out byte for byte under the same
hashed names as the build the 26 Nov pairs were made from. Its own `prebuild` (which writes
`design-system/dist`) was not run.

- **196 pairs**, both themes, 1440 and 400 px (single-width states as in the table above
  them in `response.md`), the same mock, data and steps for both builds. 26 more than on
  26 Nov: the five states of the review's M3 (`partial-answer`, `waiting-10s-alternative`,
  `stopped-at-60s`, `busy-asking-again`, `api-unreachable`; 4 each), `sign-in-api-unreachable`
  (4) and `touch-table-200-show-more` (B2's control at 400 px with a coarse pointer, every
  hit area outlined and measured; 2). No state of 26 Nov was dropped.
- **"New view: nothing to compare"** (the build before cannot reach the state):
  `time-range-not-read`, `signed-out`, `sign-in-api-unreachable` (12 images). Every other
  pair, the five M3 states included, has a picture of the build before.
- Stored as `v9-shots.cjs` stores them: a 256-colour palette that holds every token colour
  exactly (the algorithm of `e2e/encode-review-images.py`, which the script runs itself; the
  `.py` file was **not** run on the review directory, whose non-`--flat` mode deletes a pair
  with no `before/` single beside it, and this directory keeps none). Then recompressed
  losslessly with oxipng (level 6, `pyoxipng` in a scratch virtualenv), every file checked
  pixel for pixel against the encoded one before it replaced it: 16,285,129 to 15,351,182
  bytes (**14.6 MiB**; `du -sh` prints 15M). The 26 Nov directory was 14 MB for 170 pairs.
- `shots.mjs measure` on the after build, 400 px and 320 px with a coarse pointer: sideways
  overflow 0 px; one hit area under 44 px in each measured image, the query editor's inner
  box (240.3 x 22.8 px), which is its box and not what a finger gets (the well around it is
  44 px; the first review's B2 and this review's "author's claims" say the same); "Show 50
  more of 200" is no longer reported (before: 148.8 x 42.5 px in the same state).
- Looked at: `stopped-at-60s-1440-light` and `partial-answer-1440-dark` (both right). The
  other 194 were not looked at one by one.

### Speed of the two paths touched

**Measured here**, 2026-11-28 09:10 to 09:19 UTC, `node e2e/measure-review2.cjs` once, under
the machine lock (another builder's speed runs took turns with it; none ran at the same time
as it): Chromium headless, CPU slowed 4x, Fast 4G, the built app on the mock, a fresh context
per run, 20 runs at each layout (1440 x 900 with a mouse; 400 x 800 with touch, a coarse
pointer and device scale 2). From the input's own timestamp to the end of the frame in which
the result is on screen. The 1-minute load (what `uptime` prints) was read at the start of
every run and is in `e2e/measurements/review2-touched-paths.json` with each time; 4 cores;
calibration 420 ms. After the build only: the fixes did not change the code of either path
but for one wrapper's class (B2) and a new button (M1), so there is no "before" run.

| Path | Budget | Desktop: p75 (median, worst) | Phone: p75 (median, worst) | Within? |
|---|---|---|---|---|
| "Show 50 more" under the table of 200 series, to 100 rows painted | 100 ms (a local change) | **102** (77, 117) | **105** (93, 192) | **no**, by 2 and 5 ms at p75 |
| "Copy link" in Explore's head, to "Copied" painted | 100 ms | 46 (43, 62) | 59 (56, 78) | yes |

Load at run start: desktop median 2.0 (1.4 to 2.2), phone 1.6 (1.4 to 2.0); every run judged
(at or below the core count). **"Show 50 more" is over its budget at both layouts** by a
margin smaller than the spread between runs (desktop 51 to 117 ms); it renders 50 more rows
of the system's table in one React commit. It was not measured before the fixes and was not
tuned here: a follow-up (below). Not measured: the reload's landing time (B3 is held by
position and shift checks, not by a time budget), the banner of m12.

### Follow-ups left (the review's ids)

| Id | What | Why not now |
|---|---|---|
| **B1** | A result with many series is painted late | In progress elsewhere: the design system's chart (`../design-system/reviews/chart-speed/`). Not worked on here |
| B2, second part | The legend's "Min" sort head is 43 px wide at 1500 px with a coarse pointer | The design system's chart. Now also counted by `e2e/dashboards.cjs` at 1500 px |
| m5 | The table gives values under 1 as "< 1" (it takes the chart's number format) | A decision for the system's Number rules: the table's own precision |
| m6 | After a failure, Table, Text and JSON show the message alone; the Unit select follows the failed query there | More than a few lines: the previous table kept under the message, one rule for the select |
| m7 | At 320 px the legend drops the label that tells rows apart; the kept place of "Query the chart's range" leaves an empty band; the tenant's name breaks | The legend is the design system's chart. The kept place: dropping it below `breakpoint-narrow` trades the band for a row that appears and moves the page when the chart is zoomed; not decided here |
| m8 | Other cannot be closed until every member is listed | The design system's chart |
| m9 | The address does not carry the colour map | The system's algorithm and a question for its owner; more than a few lines in the app |
| m11 | A range across midnight reads "18:49 to 00:49" in the head | The chart writes that range. Where the page writes it (a result with no series) both days are now said (`rangeWords`) |
| m13 | Fields are 15 px with a coarse pointer; iOS zooms a focused field under 16 px | Needs a device; then the system's decision |
| (speed) | "Show 50 more" to 100 rows painted: p75 102 ms desktop, 105 ms phone, against 100 ms ("Speed of the two paths touched") | Found by this verification; not tuned. Rendering fewer rows per press, or the rows in two commits with the first 50 at once, are the candidates; each needs its own before and after |

Known limits of the B3 fix: a position past the end of the reloaded page is not restored (a
table lengthened by "Show 50 more", Other opened in the legend: neither is in the address, so
the reloaded page is shorter); a scrollbar dragged within the 1 s the position is held is
pulled back once (a drag gives the page no input event in every browser; `mousedown` is not
among the events that end it); the position is kept per tab and per path, one at a time.
Known limit of m12: the banner is inserted above the page as before, so the page moves down
by its height when the API stops answering.

## Dashboards, read-only

Added 2026-11-27. **Not reviewed for design** (the images for the reviewer are in
`../design-system/reviews/app-dashboards/`, with `PR.md` saying what each shows) and **not
deployed**. The question the views answer: *someone on call wants to open their service's
dashboard and read, panel by panel, whether it is healthy over a time range*.

### What exists

**The list, `/dashboards`.** From control's `GET /api/v1/control/dashboards` (`limit=200`):

- A table of the tenant's dashboards: name (the link, which fills its cell), intent, tags,
  owner ("nobody" when there is none), and when it last changed and by whom, an agent marked
  as one ("18 Nov 13:20 by incident-agent (agent)"). Below 1200 px of table width it folds
  (`data-fold="wide"`): the name and "Changed" stay as columns, the rest become labelled
  lines under the name, and the whole row is the name's target.
- The caption says what is under it: "4 dashboards, by name" (every dashboard is here, so the
  app orders them by name), "1 of 4 dashboards match, by name" for a search, and "200 of 431
  dashboards, the first by id. Search to narrow the list." when the answer is one page of more
  (the API's order then; paging is not built).
- **Search** (the API's `q`: name, id, intent, owner, tags) is asked 250 ms after the last
  keystroke and kept in the address; **Tag** is a select of the tags of every dashboard. The
  previous rows stay while a search is being answered, the caption saying so.
- **States.** *Waiting*: nothing new for 400 ms but a busy region, then a line "Asking the
  API for the dashboards." with the seconds (unmeasured work: no bar, no skeleton, no
  spinner). *Empty* (a search that matches nothing): what was asked, how many dashboards there
  are in all, "Show every dashboard". *First run* (no dashboards at all): what a dashboard is,
  and, truthfully, that this app cannot make one yet and what can. *Error*: the API's own
  words, its status, "Ask again". *No permission* (403 `missing-scope`): control's refusal,
  the scopes the key has, the scope it needs, that Explore still works, "Sign in with another
  key". The app asks the API rather than judge from the stored identity, which may be old.

**One dashboard, `/dashboards?id=<id>`.** From `GET /api/v1/control/dashboards/<id>`:

- The spec is given to the model's `validate` (`../dashboard/src`); a spec it refuses is not
  drawn at all, and the page shows the model's first three errors with their pointers. Its
  `resolve` expands fragments and writes the variables' values into the queries (with its own
  escaping); the page resolves again, locally, when the range or a variable changes.
- Head: the title, the intent, "Revision 1, changed 24 Nov 16:12 by Dana.", and a measured
  count: "12 panels, 7 answered so far." / "all answered." / "5 answered and 1 not.". The name
  and intent are shown from the list's answer, if this tab has one, before the dashboard's own
  arrives. Actions: Panels | Text (the whole dashboard as the model's digest), and Refresh
  (busy while panels are being asked; a second press is ignored). No blue button: nothing here
  is the view's one action.
- **Time range**: the spec's own (`time.from`, `time.to`) unless the address has `from` and
  `to`; Explore's controls unchanged (`RangeControls`, `TimeRangeField`: presets, earlier,
  later, two typed times read back with their zone).
- **Variables** as controls beside the range, values in the address as `var.<name>`: an
  `enum` (or `interval`) of up to six choices is a segmented control, a longer one a select; a
  `query` variable is a select whose values are asked of the API in the window on screen
  (`label_values(<selector>, <label>)` and `label_values(<label>)` only: any other expression
  gets a help line saying its values cannot be listed, and the value in use stays). "All" is
  offered where the model allows it. A `text` variable is shown, not editable.
- **Panels** in the spec's layout: a row is a section with its heading, a fragment instance
  continues as its own rows, an explicit grid is one section in reading order. Widths are the
  design system's grid (twelve columns from 1200 px of dashboard width, six from 640, one
  below): a span is rounded to the 3, 4, 6 or 12 the grid has.
  - `timeseries`: the design system's chart through `src/charts/` (`toSpec`, `Chart`), in the
    panel's declared unit; several queries share one chart, each series also named by its
    query (a fixed legend such as "p95", else the query id).
  - `stat`: `vz-stat` per series (four at most, the rest counted and in the text form): the
    model's reduced value in the chart's number format, and a context line that starts with
    what the figure covers ("Last value of 18 Nov, 09:30 to 12:30.") and, with thresholds, the
    state as a status mark and words; the figure stays `ink`.
  - `table`: one row per label set, one column per query (the model's reduced values), the
    unit once in each column head, sorted and cut as the spec says, the caption saying both
    ("8 of 12 rows, highest Requests first").
  - **Every other kind of the model's catalog (`heatmap`, `text`)**: the title, a sentence
    ("This panel is a heatmap, a kind this app does not draw yet. This is its text form.") and
    the model's digest of the panel. It is never drawn as another kind.
  - Every drawn panel has "Text form" (a disclosure: the block the model's `renderDigest`
    writes for that panel, computed when opened) and, per query, "Open in Explore" with the
    resolved query and the dashboard's range.
  - What a panel says about its data (queries, step, age, range, figures, text) comes from
    the answer that is drawn, which carries its own resolution and window. While a new range
    or value waits, the previous answer stays, the head says "Showing the previous range"
    (in a place that both wordings share, so nothing moves), and after 400 ms a line says
    "Waiting for the query." with the seconds, and from 2 s offers Cancel for that panel.
  - **A panel's failure is that panel's**: the API's message, its error type and status, what
    it means, and "Run this panel again" where asking again can change the answer (not for a
    query viz does not run, or one the model could not write). A query that matches nothing is
    an empty state with the range, not an error. The 60 s stop of the waiting table ends each
    panel still waiting, and says so.
- **Requests.** Every panel query goes through `PromClient` (`queryRangeMatrix`; `query` for
  a query marked `instant`), one window and one step for the whole dashboard (the automatic
  step of a chart 600 px wide). **At most six requests are in flight, in total**: the API
  client has one limiter of six for everything the page sends (`src/api/limiter.ts`, from the
  request leaving until its body is read), and the dashboard's own loader has another of six,
  which keeps the order. A change of range or of a variable, and leaving the view, abort what
  is in flight and never send what was waiting; an answer or failure of an earlier load is
  dropped by its generation, also when its request ignored the abort (`scheduler.ts`).

### Not implemented (dashboards)

- **No editing, no proposals, no revisions UI.** Nothing is written to control; a dashboard's
  earlier revisions, its proposals and "who may apply" are not shown. The list has no "New
  dashboard", no delete or restore, no owner change.
- **No paging of the list** past the first 200, no sorting by column, no "Mine" filter, and no
  state column (control's `state` is `null` until something computes it).
- **Variables**: one value or all, never several at once (`multi`); `text` variables cannot be
  typed; a `query` variable that is not `label_values(…)` cannot be listed.
- **Panel options are not honoured**: `stack`, `style` (area, bars), `yScale`, `yMin`/`yMax`,
  `maxSeries`, `legend` on a timeseries; `sparkline` and `decimals` on a stat. **Thresholds
  are not drawn on charts** (a stat states its threshold state; a table does not). A query's
  `legend` template does not name chart series: the chart names them by the labels that
  differ, as in Explore.
- **`heatmap` and `text` panels are not drawn** (shown as their digest; a text note's
  markdown is not rendered, and the model's digest cuts it at 400 characters).
- **TraceQL and LogQL queries are not run** (the panel says so); the spec's `time.refresh` is
  ignored: nothing refreshes by itself.
- **The waiting table's 10 s row** (a cheaper alternative) is not offered on a dashboard, and
  **a busy answer (503, 429) is not retried** for a panel as Explore retries it: it is that
  panel's error with "Run this panel again".
- A chart's zoom stays inside its panel: there is no "apply this range to the dashboard", and
  no shared crosshair between panels.
- Not run against a deployed viz, Safari or Firefox, real touch hardware, a screen reader by
  ear, or at 200% zoom.

### Verification (dashboards)

Run on 2026-11-27 between 01:48 and 02:05 UTC on the final source (last source change
01:48:33, `src/dashboards/PanelView.tsx`; built 01:48:37), Node 22.23, Chromium (Playwright's
headless shell), on a machine of 4 cores and 16 GB shared with other builders; one browser job
of this work at a time, two test workers at most. Ports were moved off the defaults
(`VIZ_E2E_APP_PORT=18720 VIZ_E2E_MOCK_PORT=18721`, `VIZ_REAL_PORT=18851`) because another
session's servers held them.

| Check | Result |
|---|---|
| `npm test` | 224 tests in 20 files pass (56 new, in five new files: `mock/dashboards.test.ts` 8, `src/dashboards/` model 23, scheduler 15, store 8, `src/api/limiter.test.ts` 2) |
| `npx tsc --noEmit` | passes (`allowImportingTsExtensions` was added: the dashboard model imports its own files as `.ts`) |
| `npm run check:tokens` | passes: 0 literal values in 69 files; contrast and structure 759 of 759 |
| `npm run build` | passes. The shell is 175.7 kB compressed (gzip 9, as `e2e/prod.cjs` counts it; the limit is 200 kB): 29.7 kB more than before this change (146.0), the dashboard model and the views. 24 kB are left |
| `node e2e/dashboards.cjs` (new) | **100 of 100** checks pass, in eight sections: the list, its states, a dashboard, panel kinds and failures, variables, requests, the key, the phone layout and the second theme; axe (WCAG 2.2 AA and best practice) finds no serious or critical violation on the list, the first run, no permission, a twelve-panel dashboard, a dashboard with failed, empty and undrawn panels, and both in the dark theme |
| `node e2e/app.cjs` | 130 of 130 (one expectation changed: the tab order now passes "Dashboards" in the navigation) |
| `node e2e/errors.cjs` | 14 of 14 |
| `node e2e/prod.cjs` | 21 of 21 (two more than before: `/dashboards` is served as a document, and under the content security policy the list and a twelve-panel dashboard work; `/dashboards/`, `/dashboards/services_overview`, `/dashboard` and `/monitors` are the JSON 404). Its mock key now has `read` and `dashboards:read` |
| `node e2e/contract.cjs` | **116 of 116**: the 82 checks of the query API as before, and 34 new ones on control's dashboard read routes (33 requests sent to the real control plane and to the mock, bodies compared whole except who created a dashboard and when; and the second page by each side's own cursor). No difference was found, so the mock was not changed by it |
| `node e2e/real.cjs` | 25 of 25 (9 new): on the real API (control, query, the write path, `wrangler dev --local`) the key with `read` only is refused dashboards in control's words; the list is the mock's list; each of the four dashboards reads the same on the real API as on the mock, panel by panel (state, figures, table, legend, text); the query viz does not run fails its panel only (422 `unsupported`); a query variable's values come from the real label-values endpoint |
| `real/seed.ts` | the real control plane accepted the mock's four specs (`POST /api/v1/control/dashboards`, 201 each, no lint warning): control's own validation is an implementation of the check the mock's unit test makes |
| `e2e/mutants-dashboards.cjs` | 23 of 23 killed, on a copy in the scratch area (below) |
| `cd ../deploy && npx vitest run --maxWorkers=2` | 255 of 255 in 4 files, with the changed `serve.json` (`deploy/` was not edited by this change) |
| `cd ../deploy && node --test --test-concurrency=2 'test/*.test.mjs'` | 189 of 189 (`deploy`'s own `test:scripts`). `node --test test/`, as the task wrote it, does not start on Node 22.23 ("Cannot find module …/deploy/test": a directory is read as a module there); that is not a failure of a test. A first run at 01:56 had one failure, `app/serve.json is read as the specification…`, expecting `app.needs` to be `['design-system']` and finding `['design-system', 'dashboard/src']`: `deploy/workers.json` and `deploy/test/app.test.mjs` were being changed by `deploy/`'s own builder during that run (both written at 01:56:01, to export `dashboard/src` for this app's build); the rerun at 01:57 is the 189 |

Not run: the suites against a deployed viz; Safari and Firefox; a real phone; 200% zoom.

### Mutants of the dashboards change

`VIZ_MUTANT_DIR=<scratch>/app-dash/mutants node e2e/mutants-dashboards.cjs` copies the app to
the scratch area, breaks one property at a time there, runs the checks the mutant names (the
whole unit suite; sections of `e2e/dashboards.cjs` on a build of the copy; `e2e/prod.cjs`) and
restores the file. Nothing is edited in the shared tree. The record is
`e2e/measurements/mutants-dashboards.txt` (01:32 UTC, on the source as it was then; the two
later source changes are a series' name and a reserved line, in neither a mutant's text).
**23 of 23 killed, none survived.** Where two kinds of check are named, each caught it alone.

| Property | Mutant | Caught by |
|---|---|---|
| The key | It is sent in the address of the dashboards list (`?key=`) | unit (`the key goes in the Authorization header of every request and in no URL or body`) and e2e (`the key is in no address…`) |
| | It is sent in the address of a dashboard | unit and e2e, the same two |
| | The dashboard page keeps the client, key included, in `sessionStorage` | e2e (`the key is kept where it was before this change and nowhere else…`) |
| | "Open in Explore" carries the key in its address | e2e, the same check (it finds the key in the page: the link's address) |
| Six in flight | The limiter starts every request at once | unit (10 tests) and e2e (the server's count of requests it is answering: 6 at most) |
| | The limit is twelve | unit (7) |
| | A place that frees lets one too many start | unit (6) |
| | The client sends past the page's limiter | unit (`ten requests from two clients: six are sent…`). The dashboard's own limiter still holds its six, so no e2e check can see this one |
| | The dashboard has no limiter of its own | unit (the store's own count). The client's limiter still holds the page's six: no e2e check can see this one either |
| Superseded | An answer for an earlier range is delivered to the panel | unit (8, among them a request that ignores its abort and answers after the new one) and e2e |
| | A new range does not cancel the requests of the one before | unit (5) and e2e (`changing the range again cancels the requests of the range before…`) |
| | Leaving the dashboard does not cancel its requests | unit and e2e (`leaving the dashboard aborts its requests in flight…`) |
| | While a new range waits, the old answer is shown as if current | unit and e2e (`…says "Showing the previous range"…`) |
| | "The last hour" is dropped from a dashboard's address (it would then mean the dashboard's own range) | unit and e2e |
| Isolated | One panel's failure cancels the whole load | unit (6) and e2e (the suite stops at a 30 s wait: the other panels never settle) |
| | One panel's failure takes the page down | e2e (stops at the same wait) |
| | A failed panel shows nothing | e2e (`one panel's query is refused: that panel shows the API's message…`) |
| | A failure is recorded on every panel | unit and e2e |
| Kind | Every kind counts as drawn (a heatmap gets an empty body) | unit and e2e |
| | A heatmap is drawn as a line chart | e2e (`a heatmap is not drawn as anything else: no plot, no figure, no table…`) |
| | A spec is drawn without the model's validation | unit and e2e (stops: the page never says the spec is invalid) |
| | A panel that is not drawn does not say so | e2e (two checks) |
| Served | `/dashboards` is not in `serve.json` | unit (`lists every route of the router as a document`) and `e2e/prod.cjs` |

What the run showed about the checks themselves: three mutants were first caught by
`e2e/dashboards.cjs` *stopping* on an element that was not there, not by a named check; the
checks were made to fail by name and those three run again alone (the note at the end of the
record). Four e2e catches are still a 30 s timeout, not a sentence. Two halves of one
condition are equivalent and were not counted as mutants: the loader drops an outcome when its
generation is old **or** its load was aborted, and a superseded load is always both (removing
either half alone changes nothing; removing both is the first "Superseded" mutant). No mutant
breaks the model's escaping of a variable's value: that is `../dashboard/`'s own property and
its own mutants; here one e2e check sends a hostile value through the address and reads the
query that was sent.

### Speed (dashboards)

**Measured here**, by `e2e/measure-dashboards.cjs`: the built app on the mock, 4x CPU slowdown
and Fast 4G (165 ms latency) as `e2e/measure.cjs` sets them, 20 runs a layout, the 75th
percentile with the median and the worst run in brackets; milliseconds, layout shift as a
score. One run is a fresh tab: the list is loaded, "Services overview" (12 panels, 14 queries,
its own range: the last 3 h) is opened from it, and when it has drawn "1 h" is pressed. The
phone layout is 400 x 800 with touch emulation; nothing is read across a reload or another
change of document (`design-system/reviews/system-v9/confirmation.md`), every run checks that
the pointer is coarse, and layout shift is given with **every** entry counted, those the
browser marks as following input included. The figures are the application's, not the
system's fixture page.

| What | Limit | desktop, before the fix | desktop, after the fix | desktop, final build | phone, after the fix | phone, final build |
|---|---|---|---|---|---|---|
| Opens a dashboard from the list: the page with its name, intent and waiting region is painted (`viewChange`) | 100 ms | 91 (77, 106) | 77 (69, 113) | 87 (73, 174) | 98 (87, 164) | 108 (95, 145) |
| That press, as the browser reports it (Interaction to Next Paint) (`viewInp`) | 200 ms | 88 (72, 104) | 72 (64, 104) | 88 (72, 160) | 96 (80, 152) | 112 (88, 144) |
| The first panel answered: its body arrived to painted (`firstPaint`) | 100 ms | 48 (33, 73) | 40 (34, 160) | 44 (30, 74) | 41 (31, 137) | 38 (32, 64) |
| The slowest of the twelve panels on that load: body arrived to painted (`paintWorst`) | 100 ms | 197 (145, 263) | 180 (144, 336) | 168 (100, 326) | 144 (72, 202) | 156 (76, 266) |
| Presses "1 h": the first request of the new range is sent (`rangeSend`) | 100 ms | 66 (49, 91) | 54 (47, 70) | 62 (54, 104) | 72 (63, 118) | 71 (62, 103) |
| Presses "1 h": the frame in which all twelve panels are marked waiting and say "Showing the previous range" (`rangeBusy`) | 100 ms | 148 (122, 172) | 127 (122, 191) | 165 (132, 453) | 159 (134, 237) | 155 (130, 260) |
| That press, as the browser reports it (`rangeInp`) | 200 ms | 160 (128, 184) | 144 (128, 200) | 168 (136, 448) | 160 (136, 232) | 152 (128, 256) |
| The slowest of the twelve panels of the new range: body arrived to painted (`rangePaintWorst`) | 100 ms | 107 (77, 189) | 72 (45, 93) | 83 (68, 131) | 85 (62, 113) | 72 (53, 96) |
| Layout shift from the press on the list until the dashboard has drawn, every entry counted (worst run) (`clsView.all`) | 0.05 | 0.0095 (0.0095) | 0.0095 (0.0095) | 0.0032 (0.0032) | 0.0000 (0.0000) | 0.0000 (0.0000) |
| Layout shift from the press on "1 h" until every panel has drawn, every entry counted (worst run) (`clsRange.all`) | 0.05 | 0.2836 (0.2864) | 0.0008 (0.0010) | 0.0009 (0.0011) | 0.0010 (0.0010) | 0.0011 (0.0011) |
| Context, no budget: press to the panels standing in their places (the spec has arrived: one round trip at 165 ms latency) (`panelsShown`) |  | 425 (396, 461) | 403 (378, 514) | 400 (380, 494) | 423 (407, 550) | 425 (396, 528) |
| Context: press to the first answered panel painted (`firstVisible`) |  | 651 (620, 697) | 624 (587, 731) | 628 (590, 749) | 636 (613, 804) | 642 (630, 778) |
| Context: press to all twelve panels painted (`allPainted`) |  | 1497 (1398, 1620) | 1423 (1315, 1739) | 1448 (1300, 1813) | 1302 (1264, 1569) | 1349 (1287, 1647) |
| Context: press on "1 h" to all twelve painted (`rangeAllPainted`) |  | 882 (835, 1122) | 830 (803, 917) | 841 (819, 1373) | 832 (793, 939) | 834 (781, 1196) |
| 1-minute load at the samples (median); samples above 4 | | 1.12 to 3.33 (1.85); 0 of 20 | 1.66 to 3.24 (2.32); 0 of 20 | 1.96 to 4.05 (3.42); 2 of 20 | 1.00 to 2.09 (1.83); 0 of 20 | 3.71 to 6.01 (4.82); 20 of 20 |
| Judged by the load rule | | yes | yes | yes | yes | **no: timing rows not judged** |
| When (UTC), calibration task | | 01:12, 344 ms | 01:17, 334 ms | 02:02, 332 ms | 01:24, 336 ms | 02:04, 442 ms |
| Runs void; the page stayed where it was scrolled on the range change | | 0; 20 of 20 | 0; 20 of 20 | 0; 20 of 20 | 0; 20 of 20 | 0; 20 of 20 |

Five runs, and why. The desktop layout was measured once (01:10), which found two rows over
their limit and a layout shift of 0.28 on a range change when every entry is counted; **one
fix was made** (the head's meta keeps one place for both of its wordings, need D7) and
both layouts were measured after it (01:14 and 01:21). Two small changes followed (an
unlabelled series is named by the dashboard's word for its query; the "Text form" line keeps
its place before the first answer), so both layouts were measured once more on the final
build (01:59 and 02:02). The machine was not quiet: another session's `e2e/measure.cjs` ran
during the whole of "desktop, after the fix" and from 13 s into "phone, after the fix" (I
waited for it to end before each run, 13 minutes the first time, and it was started again
after my check), and `deploy/`'s tests ran during the final runs. **The final phone run was
taken at a load of 3.7 to 6.0 and its timing rows are not judged**; its layout shift is.

**Met** (in every judged run): opening a dashboard paints its page within 100 ms (77 to 98;
the worst single runs are 106 to 174); the first panel is painted 40 to 48 ms after its body
arrives; the first request of a new range leaves 54 to 72 ms after the press; Interaction to
Next Paint is 72 to 96 ms for opening and 144 to 168 ms for the range (limit 200; single runs
reached 232 on the phone, and 448 once on the desktop at a load of 3.4 to 3.6); layout shift is
0.01 at most on opening and 0.001 on a range change after the fix, with every entry counted,
at both layouts; the page stays where it was scrolled on a range change in 100 of 100 runs.

**Open, over the limit:**

1. **The slowest panel of twelve is painted 144 to 197 ms after its body arrives** (limit
   100; the median panel takes 5 to 7 ms). Six answers arrive together (six are in flight)
   and each chart is built by the design system's chart script in the task that receives it
   (its model, its SVG, its legend table), so the last of a burst waits for the others: the
   slow ones are always charts (`errors_by_service`, `latency_by_service`). No fix was tried.
   The candidate is not to build a chart that is off screen in the same task as those on
   screen (build it when the page is idle or when it nears the viewport); it changes what an
   off-screen panel's head may say about a chart not yet redrawn, which is a design decision,
   and it needs the harness to time the drawing separately. After the range change the same
   row is 72 to 107 (met in three of four judged runs).
2. **The frame in which all twelve panels say they are waiting comes 127 to 165 ms after the
   press** (limit 100, if that frame is what "show the region's waiting state" means; the
   request itself leaves in time, and the pressed segment is painted by the system's press
   script at `pointerdown`). The fix that was tried, keeping the head's height, took the
   relayout of every panel out of that frame (148 to 127 on the desktop in the next run; 165
   in the final one, at a higher load) and did not bring it under the limit. What remains is
   the router's navigation, the model's `resolve` (which hashes the spec for its revision on
   every call) and twelve panels rendering again; none was profiled.

Not measured: the list's search (a round trip), a change of variable, the "Panels | Text"
switch, the first load of `/dashboards?id=…` as a document, and anything on a real phone or
behind the gateway.

### Known risks (dashboards)

- **Over HTTP/1.1, six slow queries hold every connection the browser gives the origin.**
  Seen while capturing the review images on `vite preview` with a 20 s artificial delay: a
  dashboard opened as a new document waited 19 s for a font (the preview server makes the
  browser revalidate it) behind its own six queries. Behind the gateway (HTTP/2, assets
  served `immutable`) connections are not the limit and nothing is revalidated; it was not
  tried there. A limit of five, or the mono font preloaded as the sans is, would remove it
  locally.
- **The shell grew by 29.7 kB to 175.7 kB of 200 kB.** The dashboard model is in the entry
  chunk (so that opening a dashboard from the list costs no chunk load); the next view of this
  size does not fit, and one of them will have to be a lazy chunk.
- **A page of twelve panels is long** (3,335 px at 1440 px, 8,173 px at 400 px for "Services
  overview"): every chart carries the system's legend table (need D9).
- **The app now imports `../dashboard/src`**, so a build of the app needs that directory
  beside it ("Needed from deploy/ (dashboards)").
- **One step for every panel** (30 s over 3 h): a stat's "last value" is the last 30 s step's,
  and a table reduces 361 points a series where one instant query would do.
- The mock's "changed by" and "changed at" are fixed values; on the real stack every
  dashboard was changed by the key that seeded it. `state` is always `null` on both.
- The phone layout's timing on the final build is not judged (above).

### Needed from deploy/ (dashboards)

`deploy/` was not edited.

- **`serve.json` lists a fifth document, `/dashboards`.** Nothing else in it changed. The
  gateway's tests pass with it (above); `deploy/README.md` asks that `serve.json` and
  `deploy/` change together (its item 6), and this is that change's other half.
- **A dashboard is `/dashboards?id=<id>`: the query string must reach the document**
  unchanged (it does in `e2e/prod.cjs`'s server, which follows `serve.json`), and
  `/dashboards/<anything>` stays the JSON 404.
- **The app's build needs `dashboard/src`** next to `app/` and `design-system/` (it is
  imported by relative path, with no build step of its own). `deploy/`'s builder had already
  added it to `deploy/workers.json` (`app.needs`) in their working tree when this was written.
- The policy is unchanged: the dashboards views add no inline script and load nothing from
  another origin; they do set style attributes (a reserved table's row count), which the
  policy's existing allowance for inline styles covers.

### Needed from the design system (dashboards)

Nothing under `design-system/` was edited. Where the views needed something the system does
not have, the closest existing thing is used and the rule that fills the gap is in
`src/app.css` (five rules, token values only) or in `src/dashboards/PanelView.tsx`.

| # | What the views needed | What the app does meanwhile |
|---|---|---|
| D1 | **The tenant in the navigation folds.** `span.vz-nav-end` is not `flex: none; white-space: nowrap` as the links are; with a fifth item ("Dashboards") a tenant name wrapped onto two lines at 400 px instead of the strip scrolling | One rule in `app.css` gives the span what the links have |
| D2 | **Grid spans other than 3, 4, 6 and 12.** The dashboard model gives a span in twelfths (1 to 12) and a grid item any width; `vz-grid` has `data-span` 3, 4 and 12 and a default of 6 | A span is rounded to the nearest the grid has (`gridSpan`): 5 to 8 are 6, 9 and more are 12 |
| D3 | **A panel's foot**: where a panel's own text form and its links go. Panel has a head, a description and a body; Chart has a text form of its own (sentences in `vz-text-form`), and nothing says where a link out of a panel stands | Under the body: `vz-details` "Text form", then `vz-links`. With a coarse pointer both are 44 px tall and do not overlap (measured, `e2e/dashboards.cjs`) |
| D4 | **A digest as text.** The model's digest is preformatted (a markdown table); `vz-text-form` styles a list of sentences | It is a `pre` in `vz-query` (the code well, which scrolls sideways); a text note's digest wraps (`.vz-query.is-prose`) |
| D5 | **A panel of a kind that is not drawn**: no pattern for "this exists and is not shown as a picture" | A `vz-secondary` sentence, then the digest. No mark: it is not an error |
| D6 | **Reserving a stat's and a table's height before their data.** "Before its data arrives a panel reserves its body's final height (… a table from its row count)", with no class or property for either | A hidden `vz-stat` with a figure and a context line; `.panel-rows` (`min-height` from `--strip`, `--row` and a `--rows` property) |
| D7 | **"Showing the previous query" in a narrow panel.** The note makes the meta longer; in a three-column panel it wraps and the head grows, so every panel under it moves when a wait begins and again when it ends (measured: a layout shift of 0.28 on a range change, counted with the entries the browser marks as following input) | Both wordings of the meta lie in one grid cell sized by the longer (`.meta-hold`); the note replaces the step and age instead of joining them, and the previous range is its `title` and its text for a screen reader. Measured after: 0.001 |
| D8 | **Thresholds on a chart from an application.** The chart can draw markers and thresholds in the system's previews; nothing documents how an application hands it one | Not drawn ("Not implemented") |
| D9 | **A compact legend.** Every chart has the legend as a table of toggles; six charts, four stats and two tables make a page 3,335 px tall at 1440 px, much of it legends. The model has `legend: list | table | hidden` | The legend is always the system's table |
| D10 | **A dashboard's controls**: no pattern for a range and variables together | `RangeControls`, then a `vz-grid` of fields: the range (six columns) and each variable (three) |
| D11 | **`tools/shots.mjs` captures with `fullPage`**, and `.vz-chart` is `content-visibility: auto`: on a page taller than a few screens the charts far from the viewport are not painted in the capture | `e2e/dashboards-shots.cjs` makes the viewport as tall as the page before it captures |

### Decisions in the dashboards change, for `design/DECISIONS.md`

Not yet entered there (this change edits `app/` only).

| Decision | Alternatives | Why | Would change if |
|---|---|---|---|
| A dashboard's address is `/dashboards?id=<id>` | `/dashboards/<id>` | The gateway serves only the exact document paths of `serve.json`; a path per dashboard would need a pattern there and in `deploy/` | The gateway learns path patterns |
| The app fetches the spec (`view=spec`) and resolves it itself with `../dashboard/src` | Ask control for `view=resolved&var.…` on every change | A change of variable or range must not cost a round trip before the panels are asked, and the app needs the model anyway (validation, digests). The same `resolve` runs in control, so the two cannot disagree; the contract test compares `view=resolved` too | The model becomes too large for the shell (it added about 29 kB compressed) |
| One window and one step for the whole dashboard (the automatic step of a 600 px chart) | A step per panel from its width | Every panel on one grid; a resize does not ask twelve panels again | Panels as wide as the page lose visible detail |
| One limiter of six for everything the page sends, in the API client | A limiter for the dashboard only | "At most six in flight, in total" is then true for the shell's requests and Explore's too, and cannot be forgotten by the next view | HTTP/2 from the gateway and a backend budget above six |
| A kind that is not drawn is shown as its digest and says so | Hide the panel; draw the nearest kind | A dashboard that silently lacks a panel, or shows a heatmap as lines, misleads | The kind is drawn |
| Permission is the API's answer (403), not read from the stored identity | Hide "Dashboards" for keys without the scope | The identity in the tab can be older than the key's scopes; the refusal carries control's own reason | Scopes become part of a session the app can trust |
| A busy answer is the panel's error, not retried | Retry as Explore does (three times) | Twelve panels retrying together is a load the API asked not to have; kept simple for this slice | The API says how a client should spread retries |

## What is implemented

**Sign-in**
- A viz API key, typed into a form that stands in Explore's place, at Explore's address, until
  a key is accepted: a shared link opens what it names once the reader has signed in.
- The key is checked with control's `GET /api/v1/control/whoami` (which any valid key may
  ask). A key the API refuses (401) is said at the field; a valid key without the `read`
  scope is refused with its tenant and scopes named (the query API checks `read` literally;
  `admin` is not `read`); an API that does not answer is said as that, and nothing is stored.
- **Where the key lives:** in the page's memory and in `sessionStorage` (`viz.key`), beside
  what the API said the key is (`viz.identity`: tenant, key name, kind, scopes; no secret).
  A reload stays signed in; closing the tab forgets; another tab is not signed in. It is never
  in `localStorage`, a cookie, a URL, a query key or a log line, and it is sent only as an
  `Authorization` header to the origin the page came from. The field has no `name` and the
  form's method is POST, so the key cannot reach an address even if the script fails; the
  policy's `form-action 'none'` then blocks the post as well.
- A tab that holds a key starts signed in and sends its query at once, while the API is asked
  again who the key is; a refusal then removes the key and shows the form, which says "The
  API no longer accepts this tab's key". A tab without a key asks first, because the
  development mock needs none. If the API does not answer, a tab with a key carries on (each
  query says whether the key is accepted) and a tab without one gets the form and "Ask the
  API again".
- A query answered 401 or 403 in the middle of a session says what happened to the key, and
  its button, "Sign in again", forgets the key and shows the form.
- The token the app before this one kept in `localStorage` (`viz.settings`) is removed on
  start and never sent.
- Settings (a page, `/settings`): whose key this is (tenant, key name with its public part
  `viz_<keyId>_…`, kind, scopes), Sign out, the theme, the API's address and version. The
  navigation shows the tenant as text.

**Explore**
- The page is the system's: navigation, page head, a stack of controls, one panel. The query
  editor sits in the system's query well beside Run query, the view's one blue button; under
  it the ranges one press away ("Last 15 min, 1 h, 6 h, 24 h, 7 d" as one segmented control),
  Show earlier and Show later; then the time range, the step and the unit as labelled fields.
- Query editor: one ink (the system does not colour tokens by type), errors underlined in
  `status-critical`, autocomplete of metric names, label names and label values from the API,
  bounded by the page's time range; it scrolls sideways instead of wrapping; `Ctrl/Cmd+Enter`
  runs. The editor owns the text being typed: the page reads it when the query is run, so a
  keystroke renders no React component. With a coarse pointer the well is 44 px tall with
  body-size text, which the editor inherits.
- Time range: two typed fields, From and To, in the system's forms ("18 Nov 09:16", "09:16"
  for today, "now", "now - 6 h"; also ISO dates), with a help line that echoes what was read,
  its length and the zone, once ("Read as 18 Nov, 09:30 to 12:30, 3 h, UTC+1."). A field that
  cannot be read keeps the range, is marked, and says what it takes. No browser date picker.
  Times are in the device's zone. The step is typed as a duration in any form ("30 s",
  "1 min", "5m") and echoed in the system's; empty is automatic, and the help line says what
  that is now.
- URL state: `q`, `from`, `to`, `step`, `unit`, `view` as flat search params (defaults
  omitted), in the forms they always had (`now-6h`, an epoch in milliseconds, `1m`), so old
  links stay good. Credentials are never in the URL.
- Run query: while a query runs the button is `aria-busy`, keeps its pressed fill and ignores
  further presses. Waiting follows the system's table: nothing new under 400 ms; then an
  unmeasured `vz-progress` line ("Waiting for the query." and the running time) kept at least
  300 ms; Cancel from 2 s, wired to the request's `AbortSignal`; from 10 s "Still waiting for
  the query." and the cheaper range as a control; at 60 s the request is stopped and the line
  says so, with Retry. **The line lies over the strip of words every form of the result starts
  with** (a chart's strip above its plot, right of the value axis; a table's caption): nothing
  is reserved for it and nothing moves. The mock reports nothing measurable, so there is never
  a bar.
- **The panel describes the data on screen** (`src/lib/describe.ts`): its title is "Query
  result" with the result's query (heard by a screen reader, and used by the chart for its
  accessible name and its text form), a line under the head shows that query, and the meta
  states the range that is drawn, its step and its age ("18 Nov, 09:30 to 12:30 · every 15 s ·
  updated 12 s ago"; "just now" under 5 s). While the result is not the answer to the current
  request (a query waits, was cancelled, stopped at 60 s or failed, or the range changed) the
  meta starts with "Showing the previous query" (or "time range"). The head and the query
  line keep their place while nothing is drawn, so nothing moves when a result lands.
- **Chart: the system's** (Chart component). At most eight series in colour, in the system's
  slots (1 to 4 solid, 5 to 8 dashed), given by size as series first appear and kept while a
  series stays on screen; the rest are one Other band and one legend row that opens 20 at a
  time and lets up to three members be picked out in ink; "Colour the eight largest" is
  offered only when one of the eight largest is not coloured (D73). Direct labels in a gutter
  at the right, each joined to its own line, or none (and none below 640 px). The unit once
  on the axis and once in the legend's head; ticks and figures bare, in one precision; bytes
  in one binary unit with binary-round ticks. Gaps drawn as gaps. The readout is one line
  under the plot (time, the nearest series, the highest), by pointer, touch drag or arrow
  keys; a legend row is a toggle for every pointer, and the legend is one tab stop with arrow
  keys. Zoom in and Zoom out, a drag across the plot, plus and minus zoom **within the
  result**; while the chart is zoomed, "Query the chart's range" (beside Show later, its
  place kept) asks the API for that range itself and puts it in the address. The colour map
  is kept for the tab's session, so a reload reproduces the colours.
- The chart reserves its height: it sets its legend's rows and note lines on itself whenever
  it draws, and the app remembers them for the tab (`viz.chart.reserve:explore`), so the next
  load reserves the same height before its data arrives.
- An error after a result was drawn is the chart's error state: the message lies over the
  plot at its height, the legend keeps the previous figures, inert, with hollow swatches, the
  head says "Showing the previous query", and the text form says first that the latest query
  failed. An error with nothing drawn takes the plot's place and states no age.
- Forms of the result, one segmented control in the panel head: chart; table (the latest
  value of each series, one column per label that tells the series apart, the value in the
  chart's unit and number format, sortable, opening highest value first; the caption says how
  many rows of how many and in what order; 50 rows, then "Show 50 more"); text (the chart's
  own text form: the same model as the plot, the legend and the readout, with the step said
  as it is); JSON (the API's answer, with its size and the time it took). The chart stays laid
  out and drawn while another form is shown. The URL's `view` follows 300 ms after the last
  switch (on `pagehide` at once). **The page stays where it was scrolled to** when the address
  follows a change of form, range, step or unit (the router's default for a navigation is the
  top of the page, which on a phone, where the forms are below the first screen, threw the
  reader back to the top 300 ms after every change of form: found by the speed runs, fixed,
  checked at 400 px).
- The table's rows (names, the latest value and its time for every series) are prepared in
  idle time after a result has been painted, so that neither the result's first paint nor the
  change to the table pays for them; a table asked for before that is prepared at once
  ("Speed", the table's rows).
- States: before any query, the system's first-run block (what will appear, two steps, and on
  the mock five example links); empty ("No series matched", what was asked and between which
  times, "Show the last 24 h"); error; a warning the API sent with a result as a banner.
- The error state says who answered and what to do (`src/api/errors.ts`), as before: the
  API's own error type and status only for its own envelope; advice by kind (the key; a step
  too small for the range, with "Use the automatic step"; each limit by name; PromQL viz does
  not run; the time limit; a busy API with its tries); a parse error with "Go to character N".
- A busy answer (429, 502, 503 other than the time limit) is asked again after its
  `Retry-After`, else after 1, 2 and 4 s, at most three times and never past the 60 s stop;
  the waiting line says so over the previous result.
- The range-query body is read as it arrives into Float64Arrays (`src/api/matrix.ts`), exact
  for every number (property-tested against `JSON.parse`); the chart is handed plain arrays
  with `null` gaps, which is what it takes.
- The `X-Viz-*` cost headers are kept with each result (`cost`); nothing shows them yet.

**Shell**
- `vz-nav`: the name, Explore, Help, then the tenant and Settings at the right. A skip link.
  Light and dark follow the system setting; the choice (System, Light, Dark, on the Settings
  page or in the command palette) sets `data-theme` on the root, is stored in localStorage,
  and is applied before first paint by a script file of its own.
- Command palette (`Ctrl/Cmd+K`, or the button on the Help page): the system's menu with a
  labelled field above it, in a native dialog with the scrim.
- Help page: what Explore does, the keyboard, API keys.
- While the API cannot be reached, one banner at the top says so, what is on screen stays,
  and the page asks again every 10 s by itself.
- A page in which something throws (a component, or the chart's script on a result it cannot
  draw) shows "This page stopped working", the message and "Load the page again"; the
  navigation stays and another page works.
- Focus never falls to the document when the control that had it goes away
  (`src/lib/focusKeeper.ts`): Cancel hands it to Retry, a removed button to the control named
  in its `data-focus-after`, the sign-in form to Run query.

**The build**
- `npm run build` writes `dist/`: `index.html`, `favicon.svg`, and `assets/` holding, each
  with a content hash in its name, the shell script, the editor chunk, the stylesheet, the
  theme script and the two fonts. `index.html` has no inline script and no inline style and
  asks for nothing from another origin.

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
  position in parse errors), `WWW-Authenticate`, the 34 `X-Viz-*` cost headers (most are 0:
  the mock reads no files), CORS, gzip with `Vary: Origin, Accept-Encoding`, sorted label sets, label endpoints bounded by `start`
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
- control's dashboard read routes (`mock/dashboards.ts`): `GET /api/v1/control/dashboards`
  (`q`, `tag`, `owner`, `deleted`, `limit`, `cursor`) and `GET /api/v1/control/dashboards/<id>`
  (`view=spec|outline|resolved` with `var.<name>`, `revision`), with control's statuses,
  problem bodies and wording (401, 403 `missing-scope`, 404, 400 `bad-view`, `bad-limit`,
  `tenant-not-accepted`) and the `ETag`. Four dashboards over the mock's series: **Services
  overview** (twelve panels: four stats, six charts, two tables), **Service: rate, errors,
  duration** (a `query` variable and an `enum`), **Pod capacity** (an explicit grid with a
  heatmap and a text note, a query viz does not run, a query that matches nothing) and
  **Checkout path** (one fragment used twice). Validation, resolution and the revision hash
  are the model's own (`../dashboard/src`). **Not in the mock:** every write (answered 405;
  the real API takes them), revisions and proposals; each dashboard has one revision, and who
  changed it and when are fixed values. `real/seed.ts` creates the same four specs in the real
  control plane, and `e2e/contract.cjs` compares the answers.
- control's `GET /api/v1/control/whoami`, which sign-in asks: the identity
  (`{ tenant: "viz-mock", subject, kind, name, scopes, mayApply }`, and the mock's own
  `mock: true`) for any valid key whatever its scopes, or control's problem body with 401
  (`application/problem+json`, `WWW-Authenticate: Bearer realm="viz"`). Without
  `--require-token` the mock needs no key and answers for a key of its own, so the app opens
  without sign-in in development (that key has `read` and `dashboards:read`). With
  `--require-token` the key has `read` only, as the real stack's `app-read` key; with
  `--dashboards-token` a second key has `read` and `dashboards:read`; with `--readless-token`
  that key is told who it is and has the `write` scope only. The shapes are the real control's, seen on the local stack
  (`e2e/real.cjs` signs in against it).

## The real viz API, locally

The app runs against the real API: the write path, the query Worker and the control plane,
put behind `deploy/gateway` in one script (`real/worker.ts`, `real/wrangler.jsonc`) and served
by `wrangler dev --local`. Nothing is deployed and nothing reaches Cloudflare: the Cloudflare
credentials are removed from wrangler's environment and every binding is local.

```sh
node real/stack.mjs start     # wrangler dev --local on 127.0.0.1:8851; provisions tenant viz-app-e2e through the
                              # gateway's one-time bootstrap (control's Tenant.provision) and creates the keys
                              # app-read [read], app-write [write] and app-dash [read, dashboards:read]
node real/stack.mjs seed      # real/seed.ts: 13 Remote Write requests (snappy protobuf, through edge), 472,360
                              # samples: every series of the mock, sample for sample, 08:00 to 14:00 UTC on
                              # 2026-11-18 (counters, a classic histogram, gauges with a 12-minute gap, `up`,
                              # and the 200 `viz_synthetic_series` gauges); then the mock's four
                              # dashboards, created through control's POST /api/v1/control/dashboards
VIZ_API_TARGET=http://127.0.0.1:8851 npx vite preview   # the app on it; sign in with the read key (real/.wrangler/keys.json)
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
difference. The first column says which pass found it: 1 and 2 are the two changes of 2026-11-19, 3
is the move to design system v9 (2026-11-26).

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
| 3 | Who the key is | `GET /api/v1/control/whoami` (control, through the gateway): 200 `{ tenant, subject, kind, name, scopes, mayApply }` for any valid key whatever its scopes; 401 `application/problem+json` for a key that is missing, malformed, unknown, disabled or expired | not served (404) | app: sign-in asks it; mock: the same route and answers, plus its own `mock: true`. Checked on the real stack by `e2e/real.cjs`, not by the contract test (it compares the query API) |
| 3 | Cost | 34 `X-Viz-*` headers: five more since 2026-11-19 (`X-Viz-Pruning`, `X-Viz-Tail-Mode`, `X-Viz-Series-Reads`, `X-Viz-Scan-Rows`, `X-Viz-Rows-Decoded`) | 29 | mock: the same 34 names |
| 3 | Compression | `Vary: Origin, Accept-Encoding` on every answer (item 8 of "Needed changes in query/", since done there) | `Vary: Origin` | mock: the same |
| 3 | Time limit, the words | `query timed out after 0.001 s (the timeout parameter)`: the limit is now said (item 4, since done) | `query timed out` | reported by the contract test as a difference of wording, not failed; the mock's words were left |
| 4 | Dashboards, the read routes (pass 4 is the dashboards change, 2026-11-27) | control's `GET /api/v1/control/dashboards` and `/dashboards/<id>`: the list (`items`, `total`, `next`), `q`, `tag`, `owner`, `deleted`, `limit`, the cursor; `view=spec|outline|resolved` with `var.<name>`; `revision`; the `ETag`; 400 `bad-limit`, `bad-view`, `tenant-not-accepted`; 404 `not-found` for a dashboard and for a revision; 401 `unauthenticated`; 403 `missing-scope` with the scopes needed and held | not served (404) | mock: `mock/dashboards.ts`, written from control's source and README and then compared: 33 requests, bodies whole (but who created a dashboard and when), and a second page by each side's cursor. **No difference found** |
| 4 | Dashboards, who may read | a key needs `dashboards:read` (or `dashboards:write`, `dashboards:apply`, `admin`); `read` alone is 403 | the mock's keys had `read` or `write` only | mock: `--dashboards-token` (a key with `read` and `dashboards:read`); without `--require-token` its own key has both. real: `real/stack.mjs` makes `app-dash` with both; `app-read` stays `read` only and is the no-permission case on both sides |
| 4 | Dashboards, PromQL the API does not run, in a panel | `limitk(3, …)`: 422 `unsupported` "limitk / limit_ratio aggregations" | 422 `unsupported` "aggregation "limitk" (not implemented by the viz mock backend)" | a difference of wording, reported and left: the panel shows the API's own words under the same kind of error on both |

## Needed changes in query/

`query/` was not edited. The list is from 2026-11-19; two items have been done there since
and are struck through; the others were not checked again. Each item is a request to the real stack (`real/stack.mjs`, tenant
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
4. ~~A timeout does not say the limit.~~ **Done in `query/` since** (seen 2026-11-26: "query timed
   out after 0.001 s (the timeout parameter)"). As it was written: `query=viz_synthetic_series&step=15&timeout=1ms`
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
8. ~~Compressed answers do not vary on `Accept-Encoding`.~~ **Done since**: every answer of the
   local stack carries `Vary: Origin, Accept-Encoding` (2026-11-26). As it was written: Under `wrangler dev` every answer
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

## Needed changes in deploy/

`deploy/` was not edited. This is what the gateway (`deploy/gateway`, `vis.bitcru.sh`) has to
do to serve the app. The same statement is in `serve.json`, as data; `e2e/prod.cjs` serves
`dist/` by exactly these rules from a small static server and drives the app in a browser
under them (19 checks, "Verification"), and `src/shell/serve.test.ts` fails if the router gains
a route the list lacks.

**Since 2026-11-27 `serve.json` lists five documents** (`/dashboards` was added; a dashboard
is `/dashboards?id=<id>`, never a path of its own) and the app's build also needs
`dashboard/src` beside it: "Needed from deploy/ (dashboards)".

**What is served.** The output of `npm run build` in `app/` (`app/dist/`): `index.html`,
`favicon.svg`, and `assets/` (six files today, each with a content hash in its name:
`index-*.js`, `PromqlEditor-*.js`, `index-*.css`, `theme-*.js`, two `.woff2`; 1.1 MB on
disk). Building needs `design-system/dist`, which `npm run build` generates if it is
missing. Nothing in `dist/` is a secret or names a tenant.

**Paths.** `GET` and `HEAD` only. Every other path, and every other method on these paths,
stays exactly as the gateway answers it today (its JSON 404, or a backend).

| Path | Answer |
|---|---|
| `/`, `/explore`, `/help`, `/settings` (exactly; a query string is the app's) | 200, `dist/index.html`, the document headers below |
| `/assets/<file>` for a file that exists in `dist/assets/` | 200, that file, the asset headers below |
| `/assets/<anything else>` | the gateway's JSON 404. **Never `index.html`**: a script URL from an older deploy must fail as a 404, not parse as HTML |
| `/favicon.svg` | 200, that file, the file headers below |
| everything else (`/explore/`, `/index.html`, `/dashboards`, …) | unchanged: the gateway's JSON 404 |

The API's paths are decided first, as now (`routeOf`): no document or asset path overlaps
one (`/api/…`, `/v1/…`, `/loki/…`, `/mcp`, `/oauth/…`, `/.well-known/…`, `/healthz`), and
none may be added under `/assets/` or at the four document paths. The list of documents is
`serve.json`'s `documents`; when the app gains a page, that list gains a path and the gateway
needs it too (the unit test fails until `serve.json` has it).

**Headers on the document** (`index.html`, at each of the four paths):

```
Content-Type: text/html; charset=utf-8
Cache-Control: no-cache
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
```

- `no-cache` with a validator (an `ETag`): the document is revalidated on every load, so a
  deploy is picked up by the next navigation, and a 304 costs one round trip.
- The policy, by directive: scripts only from this origin, and **no inline script** (the
  build has none: the theme script is a file); styles from this origin **and inline**, because
  the query editor (CodeMirror) writes its styles as `<style>` elements and the design
  system's chart writes its legend's column widths as `style` attributes, and neither can
  carry a nonce from a static file; images (the icon), fonts and requests (`fetch` to
  `/api/…`) from this origin only; no `<base>`; no form may post anywhere (the sign-in form
  is handled by script; this stops the key leaving if the script fails); no framing.
  `e2e/prod.cjs` runs the app under this exact string with no violation, and under the same
  string without `'unsafe-inline'` it reports violations, so the check can fail.
- `Referrer-Policy: no-referrer`: the address holds the query, which is a tenant's own.
- `Strict-Transport-Security` if the zone does not already send it (not checked here).

**Headers on `/assets/*`:** `Cache-Control: public, max-age=31536000, immutable`,
`X-Content-Type-Options: nosniff`, and the type by extension: `.js` `text/javascript;
charset=utf-8`, `.css` `text/css; charset=utf-8`, `.woff2` `font/woff2`. A file's name changes
when its content does, so it is kept for good. **On `/favicon.svg`:** `Cache-Control: public,
max-age=86400`, `Content-Type: image/svg+xml`, `nosniff`. Compressed (Brotli or gzip) by
whatever serves them, except the fonts, which already are.

**The API, as the app uses it** (nothing to change; stated so that it stays so): same origin,
so no CORS; the key as `Authorization: Bearer …` on every `/api/v1/…` request, and nowhere
else; no cookie is set or read; `GET /api/v1/control/whoami` must reach control and answer
200 with `{ tenant, subject, kind, name, scopes }` or 401, without a redirect; the `X-Viz-*`
headers are read from the response. A 401 carries `WWW-Authenticate: Bearer`, which opens no
browser prompt.

**Releases.** The document and the assets must go out together: `index.html` names the
hashed files of its own build. With `Cache-Control: no-cache` on the document, a browser
holding an old document asks again and gets the new one; a tab that is open across a deploy
keeps working from files it has already loaded, but its editor chunk (`PromqlEditor-*.js`,
fetched when Explore first shows the editor) is requested by its old name, so the old assets
should stay reachable for a while after a deploy, or that tab's editor does not load until it
is reloaded (the query is then shown as text in the well, and Run query still works). Keeping
the previous release's `assets/` files answers this; how is `deploy/`'s choice.

**How, on Cloudflare** (training knowledge, not verified here: no Cloudflare call was made).
A Worker's static assets (`assets: { directory, binding }` in its wrangler configuration) can
be bound as `env.ASSETS` and fetched from the Worker's own `fetch`, with the Worker run first
for every request, so that `routeOf` still decides; the asset server's own handling of
missing paths and of `index.html` must not be what answers (no single-page fallback for
unknown paths; the headers above are the Worker's to set, since the asset server chooses its
own `Cache-Control`). `deploy/` owns whether that is how it is done.

**What a smoke test can ask of a deployed app** (as `e2e/prod.cjs` asks locally): the four
document paths answer 200 with the policy; an asset named in `index.html` answers 200 and
`immutable`; `/assets/nope.js` is a JSON 404; `GET /api/v1/control/whoami` without a key is
401 and with a read key names the tenant.

### What `deploy/README.md` asks of the app ("Needed changes in app/", eight items)

Written by the gateway's builder; read on 2026-11-27. **None was started.** The state of each
on this tree:

| # | Asked | State |
|---|---|---|
| 1 | A chunk that fails to load is "viz was updated", with a reload offered once | **Not done.** The app has one lazy chunk, the editor. If it cannot be loaded the query stays readable as plain text in the well and nothing says why or offers a reload; no `vite:preloadError` listener, no guard against a reload loop |
| 2 | Notice a new build by the document's `ETag` before a chunk is missing | **Not done** |
| 3 | The entry script can be the 404: the first script reloads once | **Not done.** `theme-*.js` only applies the theme |
| 4 | Tolerate the API of the release before (a new route is optional for one release) | **Partly, by construction.** The only route newer than the query API that the app calls is control's `whoami`: a 404 from it is "this API has no sign-in" (a tab with a key carries on unchecked; a tab without one is told the key could not be checked), and `/status/buildinfo` is optional. Nothing states it as a rule for routes to come |
| 5 | Version what the app stores in the browser, and ignore what it does not know | **Not done as versions.** What is stored (`viz.key`, `viz.identity`, `viz.chart.reserve:<view>` and the chart's `vz-series8:<view>` in `sessionStorage`; `viz.theme` in `localStorage`) is read defensively (a value of the wrong shape is ignored) and carries no version; the earlier app's `viz.settings` is removed on start. The address's parameters are unchanged from the earlier app |
| 6 | `serve.json` is read strictly: change it and `deploy/` together | **Holds today.** `serve.json` has been unchanged since early in this change (one change then: the policy's `style-src 'self' 'unsafe-inline'` in place of `style-src 'self'; style-src-attr 'unsafe-inline'`, because the editor adds `<style>` elements); `e2e/prod.cjs` fails if the build writes a file `serve.json` does not cover; the build writes no source map |
| 7 | The document must fit a variable (about 3.6 kB) | **Holds today**: `dist/index.html` is 921 bytes, with no inline script or style. Nothing in the build enforces the limit |
| 8 | The browser the suites need is in no `package.json` | **Not done.** `e2e/` uses the Playwright installed on this machine; no lockfile installs it, so CI cannot run `e2e/app.cjs`, `errors.cjs` or `prod.cjs` |

## Needed changes in the design system

`design-system/` was not edited. The app uses the closest existing thing in each case; every
workaround is in `src/charts/Chart.tsx`, `src/charts/fixups.ts` or `src/app.css` and is
listed here so that it can be deleted when the system covers it.

| # | What an application needs | What the app does meanwhile |
|---|---|---|
| 1 | **A time zone for the reference chart.** `viz-chart.js` formats every time in UTC (`getUTCHours`): the axis, the readout, the legend's "At 13:02", the head's range, the text form. An application shows the reader's zone, or must say UTC everywhere | `spec.ts` adds the zone's offset at the window's end to every time it hands the chart, so the chart's UTC clock reads local time, and takes it off what it reads back. A window that spans a clock change is off by the change before it (twice a year, an hour) |
| 2 | **The text form assumes steps of whole minutes and an aggregate**: "every 0.25 min, max". A range query's step is often 15 s, and it has no aggregate over the step | The app gives the chart a placeholder aggregate and rewrites that phrase of the first line to "one value every 15 s" (`fixText`) |
| 3 | **A result with no unit**: the chart writes "Last, " (and "At 13:02, "), an accessible name "title, , range" and the same in the text form | The comma that introduces the missing unit is removed (`fixHead`, `fixName`, `fixText`) |
| 4 | **A legend row's accessible name does not hold the words it shows** (it is the full label set, `route="/product", service="catalog"`, while the row shows "/product · catalog"): WCAG 2.5.3, and axe-core's `label-content-name-mismatch` (serious) on every chart with more than one distinguishing label. Other's row is two elements with no space between: its text reads "Other28 series" | The name is made "words shown: full label set" (`fixRowName`), Other's "Other 28 series, as one band", and a space is put between Other's two elements |
| 5 | **No way to hear what the chart did or tell it what to do**: the range it shows after a zoom, its error's button, a new result's reservation | The app listens for `click`, `pointerup` and `keydown` on the chart after the chart's own handlers and reads `state.t0`/`t1`; it puts its own error message into the chart's `.vz-empty` (found by a MutationObserver, because the chart makes a new one on every draw) |
| 6 | **No rule for more samples than pixel columns.** The chart draws every sample. The app's automatic step asks for at most one per column, but a typed step can ask for 11,000 a series | Nothing: they are drawn, slowly ("Speed", the typed step of 1 s: 10,801 samples a series). The app before reduced each column to its minimum and maximum, which the Chart rules do not describe |
| 7 | **`.vz-panel-body:has(> .vz-chart) > .vz-progress`** starts the waiting line right of the axis only when the chart is the body's own child; a chart inside any wrapper loses it, and so does a body that holds a table while the chart is parked | One rule in `app.css` does the same by the form shown (`.vz-panel-body[data-view="chart"]`) |
| 8 | **A parked chart**: an application that keeps the chart drawn while another form is shown (the text form is written by the chart; coming back is a style change) has no class for it; `hidden` stops the chart drawing | `.is-parked` in `app.css` (absolute, no height, not seen), with `inert` |
| 9 | **`text-body-size` is 15 px.** The system gives inputs and the query well body-size text with a coarse pointer "because smaller text makes mobile browsers zoom the page on focus"; the threshold in iOS Safari is 16 px (training knowledge, not checked on a device), so 15 px would still zoom | Nothing: the app follows the system (B2 below is "fixed as the system specifies") |
| 10 | **The chart writes `style` attributes** (`<col style="width:…">`), so a page's content security policy must allow inline styles for it (CodeMirror needs the same for its `<style>` elements) | The policy allows inline styles; scripts stay strict |
| 11 | **A shared link carrying the colour map** (Chart, "Series colour", 2) needs a way to read the map from the chart and give it one | Not done: the same link opened in a fresh tab colours by size afresh |
| 12 | **Segmented: arrow keys within the group** (the first review's m7, its second half). The legend is one tab stop in v9; a segmented control is still one stop per segment | Nothing: each segment is a tab stop, as in the system's own pages |
| 13 | **A sign-in pattern.** The system has Secret (a key shown once) and FirstRun, and no screen that asks for a credential | The form is composed from FirstRun (`vz-start`: what is missing, one sentence), Field, a `vz-check` and Notice |
| 14 | **A chart cannot be removed**: `vzChart(root)` adds listeners to the root, a ResizeObserver and a `document.fonts` listener with no way to take them off | One chart per element for the element's life (`drawChart`); a new result is `setData` |
| 15 | **The chart's cost on a result of Explore's size.** The fixture's charts have 61 samples a series; Explore's automatic step asks for one per pixel column (721 at 1440 px). After the last byte the chart's model (a copy of every series, its figures, the Other band over every folded series) and its SVG and legend are most of the script the app runs, and the browser then parses, styles, lays out and paints them: response to paint is slower than with the app's canvas chart was ("Speed") | The app prepares its table's rows in idle time after the result is painted, and passes over the values for the unit only for bytes per second. Nothing in the chart |

## Decisions in this change, for `design/DECISIONS.md`

`design/` is not this component's, so these are recorded here for the lead to enter or
overrule. Each is a choice between real alternatives.

1. **The app's chart is the design system's reference chart, not a chart of its own.**
   Alternatives: keep uPlot (canvas) and implement the Chart rules on it; write an SVG chart
   in the app from the rules' pure functions. Why: the rules (colour map, Other, D73, labels,
   readout, reserved height, text form) are 500 lines that the system tests as properties and
   audits as rendered; a second implementation is a second set of findings, and the first
   review's chart findings (M1, M2, M4, M5, M7) were all of that kind. Cost: the fifteen
   needs above, the slower first paint of a result among them ("Speed"). Would change if the chart must draw what the reference does not (stacked
   charts, heatmaps), if a typed step's 11,000 points a series prove too slow in SVG, or if
   the system ships a chart package with a zone and events.
2. **The key is kept in `sessionStorage`**, with the identity the API gave it. Alternatives:
   memory only (a reload signs out, and a reload is how a link is opened); `localStorage`
   (survives the tab; the app before did this). Why: a link and a reload are Explore's main
   path, and a tab is the smallest lifetime that keeps them. Would change when control's
   `identify` gains its second branch (a person signing in): then a session cookie the page
   cannot read.
3. **The content security policy allows inline styles.** Alternatives: a nonce (the document
   would have to be rewritten per request and could not be revalidated to a 304); the editor
   in a shadow root, where CodeMirror uses constructed stylesheets, plus a chart that sets
   widths through the CSSOM. Why: scripts are what the policy is for, and they are strict.
   Would change if either dependency stops writing inline styles.
4. **Times are shown in the device's zone**, as before, by moving the chart's clock (need 1).
   Alternative: UTC everywhere, stated. Would change if the lead prefers UTC for an
   operations tool, or when the chart takes a zone.
5. **A zoom on the chart stays inside the result**, as the Chart rules say, and a separate
   control asks the API for that range. Before, a drag asked the API at once. Would change if
   people expect the drag to refetch (the evidence: how often "Query the chart's range" is
   pressed right after a zoom).
6. **The gateway serves the document at a fixed list of paths**, not for every unknown path.
   Why: the gateway's JSON 404 for an unknown API path is part of the API's behaviour, and a
   mistyped API path must not answer 200 with HTML.

## Not implemented

- **Everything outside metrics Explore and read-only dashboards: monitors, logs, traces,
  alerts, the agent surface, and every change to a dashboard** (what the dashboards views
  leave out is under "Not implemented (dashboards)"). The design system's flow screens for
  monitors, investigations, proposed changes and keys (`../design-system/flows/`) are not built.
- **Deployment.** The build is ready and the gateway's part is specified ("Needed changes in
  deploy/"); nothing was deployed and no Cloudflare call was made. The eight things
  `deploy/README.md` asks of the app (a failed chunk load as "viz was updated", noticing a
  new build, versioned storage, a browser for CI and the rest) are not done; their state is
  listed under "Needed changes in deploy/".
- **Speed is not measured on the final build** except at the desktop layout for 36 and 200
  series in one tuning run; the phone layout of the final build is unmeasured ("Speed").
- **Sign-in by a person.** There is only the API key; control has no user identity yet. No key
  can be made, listed or revoked from the app (control's Keys API is not used).
- No auto-refresh, query history, multiple queries per view, exemplars, thresholds, markers
  or annotations (the chart can draw the last three; nothing feeds them).
- The table is derived from the range result (the last sample of each series), not from an
  instant query. Scalar and string instant results have no rendering; `/api/v1/query` is in
  the client and no view uses it.
- A shared link does not carry the colour map (need 11): the same link in a fresh tab
  colours by size afresh.
- More samples than pixel columns are drawn as they are (need 6); the app before reduced each
  column to its minimum and maximum, and said so in a caption.
- The legend's full label set for a row is its title and its accessible name; on a touch
  screen it is not shown as such. Every label is on screen somewhere: the ones that differ in
  the row (or as columns of the table), the shared ones in the legend's note.
- Neither the legend nor the table is virtualised; both are capped (the legend: eight rows,
  Other, and its members 20 at a time; the table: 50 rows at a time).
- The range-query body is read on the main thread; the worker reader
  (`src/api/matrixWorker.ts`) is built, tested and not used. No Arrow transport, no
  coarse-then-refine loading.
- The `X-Viz-*` cost of a query is kept and shown nowhere, and the app does not ask
  `/api/v1/plan` what a query would cost before running it.
- Not run against: a deployed (Cloudflare) viz; Grafana-style clients; Safari and Firefox;
  real touch hardware; a screen reader by ear; 200% zoom beyond the one image.

## Verification

### The fixes for the second design review (2026-11-28)

@@VERIF@@

### The move to design system v9 (2026-11-26 and 27; the state the second review saw)

Run on 2026-11-26 and 27 (UTC), Node 22.23, Chromium (Playwright's headless shell), on a
machine of 4 cores and 16 GB shared with other builders. Every suite in this table was run on
the final source and build (after the last source change, 2026-11-27 00:13 UTC), one browser
of this work at a time; `e2e/contract.cjs` compares the mock with the real API and does not
load the app, and was not run again after 22:36.

| Check | Result |
|---|---|
| `npm test` | 168 tests in 15 files pass (two workers at most) |
| `npx tsc --noEmit` | passes |
| `npm run build` | passes: `dist/` is `index.html`, `favicon.svg` and six hashed files under `assets/` |
| `node ../design-system/tools/check.mjs --no-render src index.html` (`npm run check:tokens`) | **passes**: contrast and structure 759/759, 0 literal values in 58 files. Before this change it failed on four values in `src/app.css` |
| `node e2e/app.cjs` | 130 of 130 checks pass |
| `VIZ_SLOW=1 node e2e/app.cjs` | 132 of 132: the same, and the cheaper range offered as a control at 10 s and the stop at 60 s |
| `node e2e/errors.cjs` | 14 of 14 checks pass |
| `node e2e/prod.cjs` | 19 of 19 checks pass: the build's shape, every path and header of `serve.json`, the app driven under the content security policy with no violation, and the same flow under the policy without `'unsafe-inline'` for styles reporting violations (so the check can fail) |
| `node e2e/real.cjs` | 15 of 15 checks pass on the real API under `wrangler dev --local` (the working tree of `query/`, `edge/`, `control/` and the gateway at 2026-11-27 00:18 UTC; the stack starts empty, so it was started and seeded first): sign-in against control's `whoami` with a read key, a write-only key and a key control never made; the same legend, unit, axis, note and text form for the same data from the real API and from the mock (4 series, a gap, 36 series); a parse error, a step too small, an empty result, PromQL viz does not run |
| `node e2e/contract.cjs` | 82 of 82 checks pass, after the mock was brought up to the real API (five more cost headers, `Vary: Origin, Accept-Encoding`; it failed 59 of 82 before that); one difference of wording reported, not failed (the time limit's message) |
| axe-core 4.14 | 0 serious or critical violations in 17 runs (`e2e/app.cjs`: chart with 36 series, table, text form, error, start, help and the command palette in both themes; the chart at 400 px with touch; sign-in; Settings). One was found and fixed on the way: the legend rows' accessible names (need 4) |
| `e2e/mutants.cjs` | 60 mutants, each applied to a copy in the scratch area. First run (58): 53 killed, 5 survived; every survivor answered (four with a stronger check; one was not a violation and was replaced); two added for the two late changes; both parts run again whole on the final source: 60 of 60 killed (below) |
| Images | 170 before/after pairs in `../design-system/reviews/app-v9/compare/` (14 MB): every view and state, both themes, 1440 and 400 px, the same mock, data and steps; `shots.mjs` measured no sideways overflow, no text under 11 px and no hit area under 44 px at 400 and 320 px with a coarse pointer. **Made at 20:37 to 20:45 UTC on 26 Nov and not made again after the later source changes** ("Known issues and risks") |

**What the checks of the earlier suites became.** `e2e/run.cjs` (54 checks), `e2e/design.cjs`
(52) and `e2e/fixes.cjs` (37) drove the app's own chart, legend, time picker and Settings
dialog, which are gone; they were removed, and `e2e/app.cjs` (130 checks) checks the same
properties on what replaced them:

| Property | Before | Now (`e2e/app.cjs`) |
|---|---|---|
| Flows: a link opens the chart; the four forms; reload keeps the form; empty, error, start | `run.cjs` | section `flow` (18 checks, with a page in which something throws, and the table after a second and a third query) |
| One blue button; no computed colour outside the tokens, every state, both themes | `design.cjs` | section `colour`: 14 states a theme, SVG paint included |
| B1: old data keeps its own labels (waiting, cancelled, after an error, 60 s stop) | `fixes.cjs` | section `b1` (9 checks); the 60 s stop under `VIZ_SLOW=1` |
| The waiting table: 150 ms, 800 ms, held 300 ms (an answer at 480 ms), Cancel at 2 s and its abort, a second press ignored | `design.cjs` | section `waiting` (9 checks), timed in the page from the press |
| M2: colours in palette order, kept by survivors and by a reload, never more than eight, one Other | `fixes.cjs`, on the app's own assignment | section `chart`: the system's algorithm as rendered, and D73 (offered only when it would change a colour; pressed; withdrawn) |
| M1, M5, M7: labels, names, units | `fixes.cjs` | section `chart` (12 checks) |
| Keyboard: reading order, the ring at every stop, focus never on the body | `design.cjs` (27 stops) | section `keyboard`: 28 stops; the plot and the legend are one stop each, with their arrow keys |
| B3: typing renders no React component | `fixes.cjs` | section `keyboard` |
| Touch: 44 px hit areas with no overlap; tap toggles; zoom by button | `design.cjs`, `fixes.cjs`, from computed boxes | section `touch`: hit areas found by asking the page what is at each point (as `shots.mjs` does), ten states; a held finger's pressed fill on four controls |
| No sideways scroll at 400 px; no text under 11 px | `design.cjs` | section `touch`, at 400 and 320 px, six pages |
| Reduced motion | `design.cjs` | section `axe` |
| Autocomplete debounce and abort | `fixes.cjs` and unit | unit only (`promClient.test.ts`); autocomplete appearing under the policy in `e2e/prod.cjs` |
| The URL's form after a quick round trip and Back | `fixes.cjs` | **not carried over** (the code is unchanged; `flow` checks that the address follows the form and a reload opens it) |
| Focus after 27 interactions | `fixes.cjs` | **partly**: Cancel to Retry, sign-in to Run query, the error's button to the editor, and the keyboard walk; the long walk of interactions was not rewritten |

New in this change: sign-in (section `signin`, 15 checks), the time fields and the step
(`keyboard`), zoom and "Query the chart's range" (`zoom`), the time zone (`zone`), layout
shift on a first visit at both layouts and on a reload with the reserved height, and the
scroll position kept through a change of form at 400 px (`shift`), the page under the
content security policy (`e2e/prod.cjs`).

**One check depended on the clock and failed once.** "m4" read the echo of "the last 6 h" with
a pattern for a range inside one day; run at 00:14 UTC the echo was "26 Nov 18:14 to 27 Nov
00:14 (now), 6 h, UTC", which is right, and the check failed. The pattern now takes both
forms and any month. No other check reads today's date.

Unit tests added: `src/lib/timeInput.test.ts` (times and durations as typed and read, in six
zones, with two properties: what a field shows is read back as the same instant; a relative
time is read back as itself), `src/charts/spec.test.ts` (a result as the chart takes it; the
table's figures by the design system's own rules, loaded from the file the app bundles; the
words the app rewrites), `src/shell/session.test.ts` (who gets in; what a typed key comes to;
`whoami` through the client against the mock), `src/shell/serve.test.ts` (the gateway's list
against the router; the policy), `src/explore/ResultTable.test.ts` (the order the caption
states). Removed with the code they tested: `assign.test.ts`, `digest.test.ts`,
`downsample.test.ts`, `units.test.ts`, and the colour and formatting cases of `lib.test.ts`
(the design system tests colour assignment and number formats as properties of its own).

### Touch emulation and layout shift: what the phone figures are

Two properties of the browser's emulation, found by the design system's v9 confirmation
review (`../design-system/reviews/system-v9/confirmation.md`), decide what a phone figure
means. Both were checked against every script here after the review said so.

1. **A touch context loses its coarse pointer on the outgoing document during a reload.**
   Nothing here reads a size, a scroll position or a pointer-dependent style across a
   navigation or reload under touch emulation:
   - `e2e/app.cjs`, section `touch`: one touch context; each of the ten states is a document
     reached by `goto` and measured after it loaded; no reload. Every measurement now reads
     `(pointer: coarse)` in the same call as its figures, and a state measured with a fine
     pointer fails the check (hit areas, the query well, the two narrow widths; the phone run
     of axe has a check of its own).
   - `e2e/app.cjs`, section `shift`: the phone first visit is a fresh touch context and one
     `goto`. **The reload half of that section (the chart's height reserved from the last
     result, to the pixel) runs at the desktop layout with a fine pointer only: it is not
     checked at the phone layout**, because a reload is exactly what the emulation gets wrong.
     The audit's pointer (`../design-system/tools/audit.mjs`: its own browser with the
     blink-settings switch, `isMobile`, no `hasTouch`) would be the way to check it; that was
     not done.
   - `e2e/measure.cjs --phone`: a fresh context and one `goto` a run; no reload. From the
     retake on, a run whose page does not match `(pointer: coarse)` throws; the main run's
     phone runs had no such guard (same context options, same single `goto`).
   - `e2e/v9-shots.cjs`: the states pictured with a coarse pointer (`touch`, `touch-table`,
     `touch-hit-areas`, `touch-320`) have no reload in their steps; the states that reload
     (the waiting states, the "before" build's key) are pictured with a fine pointer.
2. **Layout-shift entries are marked `hadRecentInput` for about the first 460 ms after a
   load under `isMobile`, with no input given.** A sum of unmarked entries can therefore
   read 0 while the page moved. Where the harness gave no input, every entry is counted:
   - `e2e/app.cjs`, section `shift`, sums every entry (it summed unmarked entries until this
     was reported), at the desktop layout and now on a phone first visit.
   - `e2e/measure.cjs`: "Layout shift, first load" is every entry (no input precedes it).
     "Layout shift, query run" follows a press, so marked entries there may be the press's
     own; both sums are printed, and the one to judge the phone layout on is "every entry".

### Mutants of this change

`VIZ_MUTANT_DIR=<scratch> node e2e/mutants.cjs`: one property broken at a time **in a copy of
the app in the session's scratch area** (the script refuses a directory inside the
repository), the checks named for it run there, the copy restored. Results:
`e2e/measurements/mutants-v9-unit.txt` and `mutants-v9-e2e.txt`.

60 mutants: 26 that only unit tests are asked to catch, 34 that need the built app in a
browser (sections of `e2e/app.cjs`, or `e2e/prod.cjs`). **First run (58 mutants): 53 killed, 5
survived** (24 of 26, and 29 of 32). Each survivor was answered, two mutants were added for
the two late changes (the scroll position kept; the table prepared in idle time), and both
parts were run again whole on the final source (2026-11-27, 00:18 to 00:26 UTC): **60 of 60
killed.**

- "time: 24:30 is read as a time" survived: the tests fed `25:00`, not `24:00`. Now `24:00`,
  `24:30`, `09:60` and `09:16:60` are refused.
- "chart: bytes per second in decimal steps" survived: the tested values were far from a
  step. Now 1000 B/s stays B/s, 1024 B/s is KiB/s, and a million is 977 KiB/s.
- "the waiting line is not held for 300 ms" survived: with an answer after 800 ms the line
  stays 400 ms whatever the minimum is. A check with an answer after 480 ms was added, where
  only the minimum keeps the line (this was a check of the old suite that had not been
  carried over).
- "the palette's field has no visible label" survived: the check took a hairline-sized,
  clipped box for visible. The label's box must now be more than 8 px each way.
- "a second blue button (Sign out)" survived because it broke nothing: one blue button on a
  page is what the system allows. It was replaced by a real violation, a second blue button
  in Explore, which is killed.

Not covered by a mutant: the layout itself (it is pictured, and measured for overflow, hit
areas and layout shift); the gateway's part (it is not built); the chart's own rules (the
design system tests them as properties and runs its own mutants).


| Mutant | Checks run | Result | Caught by |
|---|---|---|---|
| session: a 401 for a tab with no key is reported as a refused key | unit | killed | unit: “a 401 is the sign-in form: "no key" without one, "refused" with one” |
| session: when the API does not answer, a tab without a key is let in | unit | killed | unit: “when the API does not answer, a tab with a key carries on and a tab without one is asked for one” |
| session: an API without a control plane (404) shows the sign-in form | unit | killed | unit: “an API with no control plane (404) has nothing to sign in to” |
| sign-in: a key without the read scope is accepted | unit | killed | unit: “a valid key without the read scope is refused at the field, with its scopes, and never stored” |
| sign-in: the admin scope counts as read | unit | killed | unit: “a valid key without the read scope is refused at the field, with its scopes, and never stored” |
| sign-in: a refused key is reported as "could not be checked" | unit | killed | unit: “a key the API refuses is a problem with the key; an API that does not answer is not” |
| sign-in: the key's whole text is shown as its label | unit | killed | unit: “shows a key by its public part only” |
| whoami: the key is sent in the address | unit | killed | unit: “asks /api/v1/control/whoami with the key in the Authorization header and nowhere else” |
| whoami: any 200 is trusted as an identity | unit | killed | unit: “an answer that is not an identity is refused, not trusted” |
| mock whoami: a key without the read scope is not told who it is | unit | killed | unit: “a key without the read scope is still told who it is” |
| time: "now - 6 h" loses its unit (hours read as minutes) | unit | killed | unit: “reads every form people type”; “reads the system's forms” and 1 more |
| time: a day without a year is always this year | unit | killed | unit: “takes a day without a year as this year, or last year when this year's is more than a day ahead” |
| time: a field shows a day without its year even when it is not this year's | unit | killed | unit: “shows a spec in a form it reads back”; “property: what a field shows is read back as the same instant, in any zone” |
| time: a clock time is read in UTC whatever the zone | unit | killed | unit: “reads a clock time in the zone it is given, not the machine's”; “property: what a field shows is read back as the same instant, in any zone” |
| time: 24:30 is read as a time | unit | killed | unit: “refuses what is not a time” |
| time: 31 Feb is read as a day | unit | killed | unit: “refuses what is not a time” |
| time: the zone is not stated | unit | killed | unit: “says the day once, the length, and the zone once” |
| time: a preset is chosen only when spelt the same ("24 h" is not "1 d") | unit | killed | unit: “a preset stays chosen however its length is spelt” |
| chart: times are not moved to the zone | unit | killed | unit: “times are milliseconds, moved by the zone's offset so that the chart's UTC clock reads local time” |
| chart: a ratio is drawn as a fraction under a % sign | unit | killed | unit: “hands the chart a unit it knows, and scales what it does not”; “values are multiplied into the chart's unit” and 1 more |
| chart: bytes per second in decimal steps | unit | killed | unit: “hands the chart a unit it knows, and scales what it does not” |
| table: figures in the raw unit, not the chart's | unit | killed | unit: “bytes: one binary unit from the largest value”; “seconds are moved to the unit the largest value reads in” |
| the table's caption says "highest value first" whatever the order | unit | killed | unit: “highest value first is the order it opens in; a series with no value comes last either way” |
| the table puts series with no value first | unit | killed | unit: “highest value first is the order it opens in; a series with no value comes last either way” |
| serve.json: /settings is not a document (a reload there would be a 404) | unit | killed | unit: “lists every route of the router as a document” |
| serve.json: the policy allows inline scripts | unit | killed | unit: “the policy allows scripts, styles, fonts and requests from the page's own origin only, and no inline script” |
| sign-in: the key is kept in localStorage | signin | killed | e2e: “the key is kept in sessionStorage only: not in localStorage, a cookie, the address or the page” |
| sign-in: the key field has a name and the form is a GET | signin | killed | e2e: “the key field is masked and has no name, and the form posts: a key cannot reach an address even without script” |
| sign-in: the token an earlier version left in localStorage stays | signin | killed | e2e: “a token an earlier version of the app left in localStorage is removed on start, and never sent” |
| sign-in: Explore is shown without a key | signin | killed | e2e: “the run stopped (page.waitForSelector: Timeout 30000ms exceeded.)” |
| sign-in: a refused key stays in the tab | signin | killed | e2e: “a key the API no longer accepts is removed from the tab, and the form says so” |
| sign-in: Sign out leaves the key in the tab | signin | killed | e2e: “the run stopped (page.waitForFunction: Timeout 30000ms exceeded.)” |
| time: the chart reads UTC in every zone (no shift) | zone | killed | e2e: “in New York the axis, the head, the fields and the text form all read local time, and the zone is stated once” |
| chart: a gap is 0, not a break in the line | unit, chart | killed | unit: “a gap, NaN and an infinity are null: the chart breaks the line there”; “missing samples are drawn as a gap: the line is broken, not joined” |
| chart: a series with no labels has no name | unit, chart | killed | unit: “a series with no labels is named by the query it is the value of”; “a series with no labels is named by the query it is the value of, and its row has an accessible name” |
| text form: the step stays "every 0.25 min, instant" | unit, flow | killed | unit: “a step is said as it is, not as a fraction of a minute, and a range query has no aggregate”; “a result with no unit leaves no empty place for one” and 2 more |
| chart: a result with no unit keeps "Last, " | chart | killed | e2e: “a result with no unit leaves no empty place for one: "Last", the chart's name and the text form read whole” |
| legend: a row is named by its label set only, not the words it shows | unit, axe | killed | unit: “a legend row is named by the words it shows, then its full label set”; “axe (chart, 36 series, light): no serious/critical violations” and 1 more |
| B1: the panel names the query that is waiting, not the one drawn | b1 | killed | e2e: “B1 waiting: the unit, the legend head, the chart's name, the query line, the unit select and the text form still describ”; “B1 cancelled: the labels and the note stay; the line says the previous result is shown” |
| B1: the head does not say "Showing the previous query" | unit, b1 | killed | unit: “says plainly when the result is not the answer to the current request”; “B1 waiting: the head says "Showing the previous query", then the range and age of what is drawn” and 2 more |
| B1: after an error nothing of the result that was drawn is kept | b1 | killed | e2e: “the run stopped (page.waitForSelector: Timeout 30000ms exceeded.)” |
| B1: the chart is not told of the error (the plot stays as if current) | b1 | killed | e2e: “the run stopped (page.waitForSelector: Timeout 30000ms exceeded.)” |
| nothing reserved for the query line: the chart moves when a result lands | shift | killed | e2e: “a first visit to a result shifts nothing (layout shift under 0.005, every entry counted; the budget is 0.05)” |
| the chart's height is not remembered for the next load | shift | killed | e2e: “a reload reserves the chart's height from its last result before the data arrives, to the pixel, and shows the waiting l” |
| "Query the chart's range" is always offered | zoom | killed | e2e: “"Query the chart's range" is offered only while the chart is zoomed, in a place kept for it, so nothing moves” |
| a zoom on the chart is not noticed | zoom | killed | e2e: “"Query the chart's range" is offered only while the chart is zoomed, in a place kept for it, so nothing moves” |
| the waiting line is shown after 100 ms | waiting | killed | e2e: “a 150 ms wait shows no waiting line; Run query is busy meanwhile”; “an 800 ms wait shows the line only after 400 ms” and 1 more |
| the waiting line is not held for 300 ms | waiting | killed | e2e: “a line that was shown is kept at least 300 ms, also when the answer comes 80 ms after it appeared” |
| a second press while the query runs sends it again | waiting | killed | e2e: “a second press while the query runs is ignored: one request was sent” |
| Cancel does not abort the request | waiting | killed | e2e: “Cancel is offered from 2 s and aborts the request” |
| B2: the editor keeps its own type size in the touch-height well | touch | killed | e2e: “B2: with a coarse pointer the query well is 44 px tall with body-size text, as the system sets a text input” |
| a literal colour in the app's CSS | colour | killed | e2e: “light: no computed colour outside the tokens, in every state (text, fills, borders, outlines, SVG paint, shadows)” |
| a second blue button in Explore (Show earlier) | colour | killed | e2e: “light: at most one blue button in every view (14 states)”; “dark: at most one blue button in every view (14 states)” |
| no focus ring on the query editor | keyboard | killed | e2e: “keyboard: the ring is drawn at every stop, and focus never falls to the document” |
| the palette's field has no visible label | keyboard | killed | e2e: “m10: the command palette's field has a visible label, and takes the focus” |
| a page in which something throws is left empty | flow | killed | e2e: “the run stopped (page.waitForSelector: Timeout 30000ms exceeded.)” |
| an empty page box stands while the API is asked who the key is (the banner then moves it) | shift | killed | e2e: “a first visit to a result shifts nothing (layout shift under 0.005, every entry counted; the budget is 0.05)”; “phone layout (400 px, coarse pointer): a first visit shifts nothing, every entry counted” |
| the address is written with the router's default: the page goes to the top after a change of form | shift | killed | e2e: “phone layout: a change of form or of unit leaves the page where it was scrolled to, also once the address has followed” |
| the table prepared for an earlier result is shown for a later one | flow | killed | e2e: “table: after another query it shows that query's series, whether the table was asked for before or after the result came” |
| the theme is applied by an inline script | prod | killed | prod: “index.html has no inline script and no inline style”; “under the policy: no content security policy violation, no console error, no uncaught error” |

### Speed

**There is no complete before-and-after run of the final build.** Two source changes came out
of the speed work itself (the page no longer jumps to the top after a change of form; the
table's rows are prepared in idle time), and the run that was to measure the build with both
was not started: the work was stopped first. What follows says for each table which build it
measured. Every figure is **measured here** (Chromium on this machine, emulated CPU and
network); nothing was measured on Cloudflare or on a device.

**How it was taken** (`e2e/measure.cjs`, tables by `e2e/summarise.cjs`): Chromium headless,
CPU slowed 4x, Fast 4G (165 ms latency), a fresh context per run, the development mock on
localhost; desktop 1440 x 900 with a fine pointer, phone 400 x 800 with touch, a coarse
pointer and device scale 2. "Before" is the app at commit `5db517f` built against the v9
stylesheet; "after" is this change; the same mock, data and window. Before and after
alternate in batches of five runs. A cell is the 75th percentile, then (median, maximum).
The machine's load is read at the start of every run and printed under each table; a row is
judged only when most of its runs had a load at or below the core count (4). The machine was
shared throughout: other builders' browsers and test runs were on it in every window below.

| Runs | When (UTC) | Build measured as "after" | Files | Use |
|---|---|---|---|---|
| A | 26 Nov, 21:52 to 22:10 | before four later changes (first-load shift, error boundary, the table at the change of form) | `v9a-*` | the record only |
| B, desktop | 26 Nov, 22:37 to 23:35 | **the final build but for the two changes above**; neither can act in a desktop run except on "Chart to table" and "Response to paint" (below) | `v9b-*` | the desktop tables below |
| B, phone | the same | the same, **with the jump to the top** | `v9jump-*` | **not judged** (below) |
| Table tuning | 26 Nov, 23:52 to 27 Nov, 00:13 | three variants; "in idle time" **is the final build** | `tune-table-*` | the only timings of the final build: desktop, 36 and 200 series |

**Overlapped windows.** Run A and run B both overlapped other builders' browser runs. In run
B, 23:11 to 23:20 UTC shared the machine with another browser job (a reload audit): that is
the third phone batch (before at 4, 36 and 200 series; after at 4 and 36, and the batch that
died at 200), and possibly the last desktop "after" runs of the third batch at 200 series.
The tuning runs had a load of about 2 to 3 at the median (a gateway builder's test and
mutant runs; the figure is under each table), higher than runs A and B (1.2 to 1.9). No row was taken again on a quiet machine.

#### What the phone runs found: the page jumped to the top

Two phone "after" batches of run B died, and a third in a repeat of 54 runs: a tap on Table
(once on Text) never showed the table. The harness was made to say why (what the touch
became, where the page was scrolled to, what stood at the point): 49 ms after the tap was
aimed the page had scrolled from 435 px to 0, and the tap landed on the From field. The
cause was the app: the address follows a change of form 300 ms later, and the router's
default for a navigation is the top of the page. On a phone the forms of the result are
below the first screen, so **every change of form threw the reader to the top**; the harness
usually aimed its next tap before or after that moment and so passed. Fixed
(`resetScroll: false` on the address writes of Explore), checked at 400 px (section `shift`)
and by a mutant. The "before" build makes the same call, but its form control was on the
first screen, so it did not show there; it was not checked further.

Because the phone "after" runs of run B were scrolled back to the top between their steps,
they are **not judged**, and the phone layout of the final build is **not measured**. For
the record, with that defect and partly in the overlapped window (20, 15 and 10 "after" runs
at 4, 36 and 200 series; `v9jump-*`):

##### 4 series (sum by (service) (rate(http_requests_total[5m]))), phone

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 22 (16, 24) | 21 (18, 33) | yes |
| Click on Run query to the busy state painted | 100 ms | 66 (54, 86) | 46 (45, 69) | yes |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 30 (28, 31) | 26 (25, 28) | yes |
| Typing: the slowest key of a run (not a budget figure) |  | 48 (44, 60) | 39 (36, 53) |  |
| Typing: keys over 50 ms, of 60 |  | 0 (0, 1) | 0 (0, 1) |  |
| Crosshair: pointer move to the next frame | 50 ms | 44 (42, 52) | 44 (44, 49) | yes |
| Chart to table | 100 ms | 60 (56, 93) | 68 (63, 103) | yes |
| Table to text | 100 ms | 64 (50, 84) | 51 (47, 60) | yes |
| Text to chart | 100 ms | 53 (50, 71) | 51 (48, 70) | yes |
| Legend row chosen: release to the chosen row painted | 100 ms | 109 (100, 141) | 54 (51, 60) | yes |
| Open the time picker (a menu; the app on v9 has none in this view) | 100 ms | 77 (73, 105) | not measured |  |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 39 (33, 52) | 39 (35, 61) | yes |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 49 (42, 77) | 49 (40, 69) | yes |
| Release of Run query to the result painted, network included (not a budget figure) |  | 530 (521, 552) | 531 (522, 547) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 96 (88, 128) | 72 (64, 104) | yes |
| Worst interaction, Event Timing, the whole run | 200 ms | 96 (88, 128) | 72 (64, 104) | yes |
| Layout shift, first load (every entry: no input is given) | 0.05 | 0.0031 (0.0031, 0.0031) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (entries not marked as following input) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (every entry, those marked as following the press included) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 20 runs, load at run start median 1.4 (1.1 to 2.2) on 4 cores, 20 of 20 runs judged, calibration 333 ms (median of 4 batches)
- After: 20 runs, load at run start median 1.4 (1.1 to 2.2) on 4 cores, 20 of 20 runs judged, calibration 339 ms (median of 4 batches)

##### 36 series (sum by (service, route, status) (rate(http_requests_total[5m]))), phone

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 19 (17, 24) | 19 (19, 22) | yes |
| Click on Run query to the busy state painted | 100 ms | 57 (53, 85) | 52 (48, 66) | yes |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 32 (29, 34) | 28 (26, 32) | yes |
| Typing: the slowest key of a run (not a budget figure) |  | 56 (45, 123) | 45 (43, 50) |  |
| Typing: keys over 50 ms, of 60 |  | 1 (0, 2) | 0 (0, 0) |  |
| Crosshair: pointer move to the next frame | 50 ms | 61 (59, 67) | 49 (48, 52) | yes |
| Chart to table | 100 ms | 91 (83, 121) | 104 (92, 121) | **no**, 104 ms |
| Table to text | 100 ms | 68 (60, 93) | 52 (49, 60) | yes |
| Text to chart | 100 ms | 54 (50, 71) | 52 (50, 61) | yes |
| Legend row chosen: release to the chosen row painted | 100 ms | 120 (109, 172) | 65 (59, 95) | yes |
| Open the time picker (a menu; the app on v9 has none in this view) | 100 ms | 85 (76, 110) | not measured |  |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 57 (51, 86) | 86 (65, 98) | yes |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 73 (65, 148) | 101 (83, 116) | **no**, 101 ms |
| Release of Run query to the result painted, network included (not a budget figure) |  | 600 (589, 662) | 625 (612, 645) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 112 (104, 160) | 104 (96, 120) | yes |
| Worst interaction, Event Timing, the whole run | 200 ms | 112 (104, 160) | 104 (96, 120) | yes |
| Layout shift, first load (every entry: no input is given) | 0.05 | 0.0031 (0.0031, 0.0031) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (entries not marked as following input) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (every entry, those marked as following the press included) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 20 runs, load at run start median 1.4 (1.0 to 2.2) on 4 cores, 20 of 20 runs judged, calibration 333 ms (median of 4 batches)
- After: 15 runs, load at run start median 1.6 (1.1 to 2.3) on 4 cores, 15 of 15 runs judged, calibration 342 ms (median of 3 batches)

##### 200 series (viz_synthetic_series), phone

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 20 (17, 24) | 20 (18, 20) | yes |
| Click on Run query to the busy state painted | 100 ms | 71 (58, 83) | 53 (47, 70) | yes |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 29 (29, 32) | 26 (25, 27) | yes |
| Typing: the slowest key of a run (not a budget figure) |  | 52 (43, 73) | 53 (42, 54) |  |
| Typing: keys over 50 ms, of 60 |  | 1 (0, 2) | 1 (0, 1) |  |
| Crosshair: pointer move to the next frame | 50 ms | 59 (49, 63) | 50 (46, 52) | yes |
| Chart to table | 100 ms | 100 (88, 134) | 114 (109, 142) | **no**, 114 ms |
| Table to text | 100 ms | 70 (65, 85) | 51 (48, 60) | yes |
| Text to chart | 100 ms | 60 (53, 74) | 49 (43, 51) | yes |
| Legend row chosen: release to the chosen row painted | 100 ms | 105 (100, 130) | 67 (60, 94) | yes |
| Open the time picker (a menu; the app on v9 has none in this view) | 100 ms | 78 (76, 100) | not measured |  |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 79 (72, 108) | 94 (86, 109) | yes |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 137 (124, 186) | 153 (132, 170) | **no**, 153 ms |
| Release of Run query to the result painted, network included (not a budget figure) |  | 1092 (1070, 1169) | 1112 (1095, 1141) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 112 (104, 128) | 112 (112, 144) | yes |
| Worst interaction, Event Timing, the whole run | 200 ms | 112 (104, 128) | 112 (112, 144) | yes |
| Layout shift, first load (every entry: no input is given) | 0.05 | 0.0016 (0.0016, 0.0016) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (entries not marked as following input) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (every entry, those marked as following the press included) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 20 runs, load at run start median 1.5 (1.1 to 2.4) on 4 cores, 20 of 20 runs judged, calibration 333 ms (median of 4 batches)
- After: 10 runs, load at run start median 1.1 (0.8 to 1.7) on 4 cores, 10 of 10 runs judged, calibration 332 ms (median of 2 batches)

#### Desktop (run B)

At 1440 x 900 every target of a run is on the first screen (Run query at 200 px, the form
control at 408 px, the first legend row at 741 px; measured), so a desktop run never scrolls
and the jump could not act in it. The table's rows were prepared at the change to the table
in this build; the final build prepares them in idle time (next section), which moves
"Chart to table" and "Response to paint" and nothing else.

##### 4 series (sum by (service) (rate(http_requests_total[5m]))), desktop

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 15 (11, 31) | 15 (13, 18) | yes |
| Click on Run query to the busy state painted | 100 ms | 39 (30, 60) | 36 (30, 48) | yes |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 24 (22, 27) | 22 (21, 26) | yes |
| Typing: the slowest key of a run (not a budget figure) |  | 41 (39, 70) | 49 (37, 68) |  |
| Typing: keys over 50 ms, of 60 |  | 0 (0, 1) | 0 (0, 1) |  |
| Crosshair: pointer move to the next frame | 50 ms | 25 (24, 27) | 27 (27, 29) | yes |
| Chart to table | 100 ms | 37 (31, 45) | 48 (41, 63) | yes |
| Table to text | 100 ms | 30 (27, 38) | 28 (25, 33) | yes |
| Text to chart | 100 ms | 30 (26, 37) | 29 (25, 36) | yes |
| Legend row chosen: release to the chosen row painted | 100 ms | 67 (63, 92) | 38 (35, 55) | yes |
| Open the time picker (a menu; the app on v9 has none in this view) | 100 ms | 53 (43, 82) | not measured |  |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 49 (42, 62) | 48 (42, 79) | yes |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 63 (50, 79) | 55 (49, 95) | yes |
| Release of Run query to the result painted, network included (not a budget figure) |  | 528 (518, 555) | 524 (518, 551) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 64 (56, 80) | 56 (48, 64) | yes |
| Worst interaction, Event Timing, the whole run | 200 ms | 72 (64, 80) | 72 (64, 72) | yes |
| Layout shift, first load (every entry: no input is given) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (entries not marked as following input) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (every entry, those marked as following the press included) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 20 runs, load at run start median 1.2 (1.0 to 2.7) on 4 cores, 20 of 20 runs judged, calibration 340 ms (median of 4 batches)
- After: 20 runs, load at run start median 1.5 (1.2 to 2.8) on 4 cores, 20 of 20 runs judged, calibration 337 ms (median of 4 batches)

##### 36 series (sum by (service, route, status) (rate(http_requests_total[5m]))), desktop

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 13 (11, 17) | 14 (12, 20) | yes |
| Click on Run query to the busy state painted | 100 ms | 32 (29, 53) | 32 (31, 43) | yes |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 25 (24, 27) | 23 (21, 31) | yes |
| Typing: the slowest key of a run (not a budget figure) |  | 45 (38, 115) | 40 (37, 135) |  |
| Typing: keys over 50 ms, of 60 |  | 0 (0, 1) | 0 (0, 2) |  |
| Crosshair: pointer move to the next frame | 50 ms | 29 (28, 30) | 30 (29, 34) | yes |
| Chart to table | 100 ms | 63 (52, 93) | 97 (69, 143) | yes |
| Table to text | 100 ms | 37 (32, 45) | 32 (27, 38) | yes |
| Text to chart | 100 ms | 32 (30, 47) | 30 (26, 45) | yes |
| Legend row chosen: release to the chosen row painted | 100 ms | 78 (74, 105) | 42 (31, 56) | yes |
| Open the time picker (a menu; the app on v9 has none in this view) | 100 ms | 53 (49, 79) | not measured |  |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 68 (59, 89) | 85 (79, 97) | yes |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 96 (85, 114) | 111 (102, 127) | **no**, 111 ms |
| Release of Run query to the result painted, network included (not a budget figure) |  | 659 (652, 680) | 683 (677, 724) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 88 (80, 112) | 96 (72, 144) | yes |
| Worst interaction, Event Timing, the whole run | 200 ms | 96 (80, 112) | 104 (80, 144) | yes |
| Layout shift, first load (every entry: no input is given) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (entries not marked as following input) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (every entry, those marked as following the press included) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 20 runs, load at run start median 1.4 (0.8 to 3.1) on 4 cores, 20 of 20 runs judged, calibration 340 ms (median of 4 batches)
- After: 20 runs, load at run start median 1.5 (1.2 to 2.2) on 4 cores, 20 of 20 runs judged, calibration 337 ms (median of 4 batches)

##### 200 series (viz_synthetic_series), desktop

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 13 (11, 16) | 13 (12, 35) | yes |
| Click on Run query to the busy state painted | 100 ms | 34 (28, 46) | 31 (26, 56) | yes |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 24 (23, 29) | 23 (21, 27) | yes |
| Typing: the slowest key of a run (not a budget figure) |  | 48 (38, 53) | 43 (39, 99) |  |
| Typing: keys over 50 ms, of 60 |  | 0 (0, 1) | 0 (0, 1) |  |
| Crosshair: pointer move to the next frame | 50 ms | 29 (28, 30) | 30 (29, 31) | yes |
| Chart to table | 100 ms | 86 (65, 120) | 101 (90, 144) | **no**, 101 ms |
| Table to text | 100 ms | 43 (35, 57) | 28 (25, 39) | yes |
| Text to chart | 100 ms | 31 (29, 46) | 30 (27, 45) | yes |
| Legend row chosen: release to the chosen row painted | 100 ms | 75 (70, 91) | 46 (36, 52) | yes |
| Open the time picker (a menu; the app on v9 has none in this view) | 100 ms | 63 (52, 79) | not measured |  |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 86 (82, 120) | 154 (145, 204) | **no**, 154 ms |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 177 (170, 243) | 262 (237, 315) | **no**, 262 ms |
| Release of Run query to the result painted, network included (not a budget figure) |  | 1721 (1698, 1767) | 1813 (1769, 1968) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 88 (80, 120) | 104 (88, 144) | yes |
| Worst interaction, Event Timing, the whole run | 200 ms | 88 (80, 120) | 104 (96, 144) | yes |
| Layout shift, first load (every entry: no input is given) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (entries not marked as following input) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (every entry, those marked as following the press included) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 20 runs, load at run start median 1.6 (1.0 to 2.3) on 4 cores, 20 of 20 runs judged, calibration 340 ms (median of 4 batches)
- After: 20 runs, load at run start median 1.3 (1.1 to 1.7) on 4 cores, 20 of 20 runs judged, calibration 337 ms (median of 4 batches)

#### When the table's rows are prepared (the final build is the third column)

Run A prepared the rows with every result; a profile showed 10 ms of the result's first
paint going to them at 200 series (4x CPU), so they were moved to the change to the table,
and run B then showed "Chart to table" slower by 10 to 30 ms and over 100 ms at 200 series.
Three variants of the same build were then measured alternating, four rounds of five runs,
desktop, typing and crosshair left out: with every result; at the change to the table; in
idle time after the result is painted (`requestIdleCallback`, at once if the table is asked
for first). Not tried: scheduling the idle work after the frame that paints the result (an
idle callback can run before that frame).

##### 36 series (sum by (service, route, status) (rate(http_requests_total[5m]))), desktop

| What | Budget | With every result | At the change to the table | In idle time (chosen) | Within budget (In idle time (chosen))? |
|---|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 18 (12, 27) | 15 (11, 21) | 15 (11, 23) | yes |
| Click on Run query to the busy state painted | 100 ms | 34 (30, 49) | 38 (29, 56) | 32 (29, 60) | yes |
| Chart to table | 100 ms | 63 (59, 97) | 79 (70, 103) | 62 (58, 99) | yes |
| Table to text | 100 ms | 34 (27, 38) | 28 (25, 36) | 28 (24, 38) | yes |
| Text to chart | 100 ms | 32 (26, 52) | 32 (28, 42) | 35 (29, 47) | yes |
| Legend row chosen: release to the chosen row painted | 100 ms | 39 (33, 65) | 33 (30, 67) | 41 (33, 51) | yes |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 107 (89, 124) | 85 (77, 133) | 83 (80, 120) | yes |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 137 (117, 157) | 115 (100, 167) | 119 (102, 168) | **no**, 119 ms |
| Release of Run query to the result painted, network included (not a budget figure) |  | 705 (690, 729) | 692 (669, 718) | 685 (681, 743) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 72 (64, 96) | 80 (72, 112) | 72 (64, 104) | yes |
| Layout shift, first load (every entry: no input is given) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (entries not marked as following input) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (every entry, those marked as following the press included) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- With every result: 20 runs, load at run start median 2.5 (1.5 to 3.7) on 4 cores, 20 of 20 runs judged, calibration 338 ms (median of 4 batches)
- At the change to the table: 20 runs, load at run start median 2.3 (1.3 to 3.1) on 4 cores, 20 of 20 runs judged, calibration 334 ms (median of 4 batches)
- In idle time (chosen): 20 runs, load at run start median 2.1 (1.3 to 2.7) on 4 cores, 20 of 20 runs judged, calibration 342 ms (median of 4 batches)

##### 200 series (viz_synthetic_series), desktop

| What | Budget | With every result | At the change to the table | In idle time (chosen) | Within budget (In idle time (chosen))? |
|---|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 12 (11, 17) | 13 (11, 32) | 14 (12, 23) | yes |
| Click on Run query to the busy state painted | 100 ms | 36 (27, 51) | 29 (24, 45) | 32 (28, 43) | yes |
| Chart to table | 100 ms | 85 (69, 111) | 88 (83, 112) | 69 (65, 89) | yes |
| Table to text | 100 ms | 34 (28, 49) | 28 (26, 55) | 29 (24, 41) | yes |
| Text to chart | 100 ms | 33 (30, 46) | 33 (30, 41) | 30 (26, 35) | yes |
| Legend row chosen: release to the chosen row painted | 100 ms | 39 (33, 59) | 37 (30, 48) | 38 (31, 61) | yes |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 157 (150, 182) | 136 (127, 199) | 150 (135, 221) | **no**, 150 ms |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 245 (237, 285) | 231 (210, 285) | 244 (222, 316) | **no**, 244 ms |
| Release of Run query to the result painted, network included (not a budget figure) |  | 1813 (1781, 1902) | 1792 (1749, 1954) | 1788 (1753, 1955) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 88 (72, 112) | 88 (88, 112) | 72 (72, 88) | yes |
| Layout shift, first load (every entry: no input is given) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (entries not marked as following input) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (every entry, those marked as following the press included) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- With every result: 20 runs, load at run start median 2.6 (1.4 to 4.0) on 4 cores, 20 of 20 runs judged, calibration 338 ms (median of 4 batches)
- At the change to the table: 20 runs, load at run start median 2.4 (1.3 to 4.3) on 4 cores, 19 of 20 runs judged, calibration 334 ms (median of 4 batches)
- In idle time (chosen): 20 runs, load at run start median 2.3 (1.5 to 3.5) on 4 cores, 20 of 20 runs judged, calibration 342 ms (median of 4 batches)

Idle time has the first variant's "Chart to table" (62 and 69 ms against 79 and 88) and the
second's "Response to paint" at 36 series (83 against 107); at 200 series the three do not
separate on "Response to paint" (150, 136 and 157 ms; the medians 134, 127 and 150). It was
chosen. These columns have no "before" beside them: run B's "before" (63 and 86 ms for
"Chart to table", 68 and 86 ms and 96 and 177 ms for the two "Response to paint" rows) was
taken two hours earlier at a lower load.

#### What is met and what is not

- **Met at the desktop layout** (run B, all 20 runs of every cell judged): press 13 to 15 ms,
  the busy state 31 to 36 ms, typing 22 to 23 ms a key, the crosshair 27 to 30 ms, table to
  text and text to chart 28 to 32 ms, a legend row 38 to 46 ms (67 to 78 before), the worst
  interaction 72 to 104 ms, layout shift 0 on a first load and on a query run with every
  entry counted.
- **Not met: a result's first paint with many series.** From the last byte, 36 series: 111
  ms in run B (before: 96) and 119 ms on the final build (tuning run); 200 series: 262 ms
  (before: 177) and 244 ms. After the harness's own copy of the body resolved: 85 and 83 ms
  at 36 series (within), 154 and 150 ms at 200 (before: 86). The regression at 200 series is
  the cost of the design system's SVG chart on a result of this size ("Needed changes in
  the design system", 15): a profile at 4x CPU put about 34 ms in the chart's model, 23 ms
  in drawing, 17 ms in aligning the series and 15 ms in garbage collection after the body
  had arrived, and about 130 ms of reading the body while it downloads.
- **Thin margins, not taken again:** "Chart to table" at the desktop layout was 97 ms (36
  series) and 101 ms (200 series) in run B and 62 and 69 ms on the final build, in one
  series of 20 runs each at a load above 2; "Response to paint" from the last byte at
  36 series is within 20 ms of the limit on both sides of it.
- **Not measured on the final build:** the phone layout, all of it (in run B, with the
  jump: the crosshair 44 to 50 ms against a limit of 50; "Chart to table" 104 and 114 ms at
  36 and 200 series against 91 and 100 before; a legend row 54 to 67 ms against 105 to 120
  before); the desktop layout at 4 series; typing and the crosshair (the two changes do not
  touch them).
- **Layout shift on a phone.** A first load gives no input, and every entry is counted: 0 in
  every "after" run of run B (20, 15 and 10 runs), 0.0031 and 0.0016 before; `e2e/app.cjs`
  now checks a phone first visit the same way (0). A query run follows a press: both sums
  were 0 in run B.

#### A typed step (run B's build, five runs each: an indication, not a judgment)

One second over three hours is 10,801 samples a series, more than the chart has pixel
columns (four series):

##### 4 series (sum by (service) (rate(http_requests_total[5m]))), desktop

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 17 (13, 21) | 12 (11, 12) | yes |
| Click on Run query to the busy state painted | 100 ms | 46 (33, 50) | 45 (38, 49) | yes |
| Chart to table | 100 ms | 37 (37, 44) | 51 (49, 52) | yes |
| Table to text | 100 ms | 25 (24, 28) | 24 (23, 31) | yes |
| Text to chart | 100 ms | 36 (28, 40) | 32 (31, 40) | yes |
| Legend row chosen: release to the chosen row painted | 100 ms | 97 (86, 114) | 127 (125, 169) | **no**, 127 ms |
| Open the time picker (a menu; the app on v9 has none in this view) | 100 ms | 67 (55, 78) | not measured |  |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 80 (80, 80) | 147 (143, 147) | **no**, 147 ms |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 147 (141, 162) | 242 (234, 253) | **no**, 242 ms |
| Release of Run query to the result painted, network included (not a budget figure) |  | 1169 (1140, 1211) | 1246 (1220, 1366) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 104 (104, 104) | 192 (152, 200) | yes |
| Layout shift, first load (every entry: no input is given) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (entries not marked as following input) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (every entry, those marked as following the press included) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 5 runs, load at run start median 2.5 (2.4 to 2.7) on 4 cores, 5 of 5 runs judged, calibration 341 ms (median of 1 batch)
- After: 5 runs, load at run start median 2.7 (2.6 to 2.8) on 4 cores, 5 of 5 runs judged, calibration 337 ms (median of 1 batch)

One minute is 181 samples a series (36 series), a quarter of what the automatic step asks
for at this width:

##### 36 series (sum by (service, route, status) (rate(http_requests_total[5m]))), desktop

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 13 (13, 14) | 14 (13, 14) | yes |
| Click on Run query to the busy state painted | 100 ms | 40 (39, 71) | 33 (27, 37) | yes |
| Chart to table | 100 ms | 87 (66, 117) | 82 (69, 99) | yes |
| Table to text | 100 ms | 50 (43, 61) | 33 (27, 36) | yes |
| Text to chart | 100 ms | 34 (32, 35) | 32 (32, 35) | yes |
| Legend row chosen: release to the chosen row painted | 100 ms | 76 (72, 121) | 35 (32, 51) | yes |
| Open the time picker (a menu; the app on v9 has none in this view) | 100 ms | 56 (55, 76) | not measured |  |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 40 (32, 41) | 61 (56, 79) | yes |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 70 (62, 81) | 69 (66, 94) | yes |
| Release of Run query to the result painted, network included (not a budget figure) |  | 566 (551, 587) | 547 (545, 563) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 112 (104, 120) | 88 (72, 104) | yes |
| Layout shift, first load (every entry: no input is given) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (entries not marked as following input) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run (every entry, those marked as following the press included) | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 5 runs, load at run start median 2.5 (2.4 to 3.0) on 4 cores, 5 of 5 runs judged, calibration 397 ms (median of 1 batch)
- After: 5 runs, load at run start median 2.4 (2.0 to 2.8) on 4 cores, 5 of 5 runs judged, calibration 338 ms (median of 1 batch)


### Bundle (built assets)

Before is the app at commit `5db517f`, after is this change, both built against the same
design-system files (gzip level 9, as `e2e/measure.cjs` computes it).

| File | Before raw | Before gzip | After raw | After gzip |
|---|---|---|---|---|
| `index-*.js` and `theme-*.js` (app, React, router, query, the chart): the shell | 476.0 kB | 156.6 kB | 456.5 kB | 146.0 kB |
| `PromqlEditor-*.js` (CodeMirror + PromQL, lazy) | 449.7 kB | 142.2 kB | 449.7 kB | 142.2 kB |
| `index-*.css` | 64.2 kB | 11.5 kB | 57.9 kB | 10.4 kB |
| `index.html` | 1.4 kB | 0.8 kB | 0.9 kB | 0.5 kB |
| Fonts (WOFF2, already compressed) | 128.8 kB | | 128.8 kB | |

The shell's script is 146.0 kB compressed (the limit is 200 kB): 10.6 kB less than before, uPlot and the app's own chart, legend, colour and number code having gone and the system's chart having come.

## Known issues and risks

- **Not reviewed and not deployed.** The design change waits for an independent review
  (`../design-system/reviews/app-v9/response.md`). The app was not run behind the gateway
  that `deploy/` is building: that the gateway serves it rightly rests on `serve.json` and on
  `e2e/prod.cjs`'s own static server, not on a run against it.
- **The images.** The pairs under `../design-system/reviews/app-v9/compare/` were made again
  from the final build on 2026-11-28 (196 pairs; "The second design review: fixes", "Images").
  Only two were looked at one by one.
- **Speed.** **A result's first paint is over the 100 ms limit with many series** (from the last byte: 119 ms at 36 series and 244 ms at 200 on the final build, desktop; 96 and 177 ms before), which is the cost of the design system's SVG chart on a result of this size (need 15). **The phone layout of the final build was not measured at all**, and there is no complete before-and-after run of the final build: the last two source changes (the scroll position kept, the table prepared in idle time) were measured only by the desktop tuning run at 36 and 200 series, on a busy machine. Thin margins were not taken again ("Speed").
- **The chart is the design system's script, and the app depends on what it writes.** The
  fix-ups in `src/charts/` find things by the chart's own class names and words (`thead
  [data-col="last"] .vz-sort`, ", every … min, instant.", `.vz-empty`, `.vz-series-rest`). A
  change to the chart's markup or wording can undo one silently; each has an end-to-end check
  (no unit, the text form's step, the row names through axe, the error over the plot), and a
  mutant that removes it. The chart cannot be removed from an element once made (need 14): each time Explore is left and
  opened again in one tab, the chart that was left stays in memory with its last result (a
  few megabytes for 200 series) until the tab is closed or reloaded.
- **Time zone.** The chart's clock is moved by one offset per result (the zone's at the
  window's end). A window that spans a clock change shows the times before the change an
  hour off on the chart, its head and its text form; the time range fields, which do their
  own arithmetic, stay right. Checked in one zone other than UTC (New York), not across a
  clock change.
- **The key.** `sessionStorage` can be read by any script on the origin; the policy allows
  scripts from the origin only and the build has no inline script, which is what stands
  between a key and an injected script. A tab that holds a key starts signed in: after a key
  is disabled, a reload shows Explore and sends one query with the dead key before the form
  appears (the query is refused by the API; nothing of the tenant's is shown). If control
  does not answer, a tab without a key cannot sign in even while the query path is up.
- **The policy allows inline styles** (the editor and the chart need them); scripts are
  strict. A stricter policy needs a change in both dependencies (README, decisions, 3).
- **A deploy while a tab is open**: the editor chunk is fetched by its old name when Explore
  first shows the editor; if the old asset is gone, that tab shows the query as plain text in
  the well until it is reloaded ("Needed changes in deploy/", Releases).
- **More samples than pixel columns** (a typed step) are drawn as they are: with a step of 1 s over three hours (10,801 samples a series, four series) a result took 242 ms from the last byte to paint (147 ms before) and choosing a legend row 127 ms (97 ms before), in five runs each on the build before the last two changes (need 6).
- **`text-body-size` is 15 px**: on iOS Safari a focused field under 16 px is understood to
  zoom the page (training knowledge, not checked on a device). The app follows the system.
- A shared link does not carry the colour map; the same link in a fresh tab colours by size
  afresh, so two tabs with different histories can colour the same address differently.
- The range-query parser (`src/api/matrix.ts`, about 600 lines) is specialised: a body it
  misreads would draw wrong numbers without an error. It is property-tested against
  `JSON.parse` on 1,000 random bodies cut anywhere and gives up its fast path on anything it
  does not expect.
- "The real API" in `e2e/real.cjs` and `e2e/contract.cjs` is the working tree of `query/`,
  `edge/`, `control/` and the gateway under `wrangler dev --local` at the moment of the run,
  other builders' edits in progress included. It is not a deployed viz.
- Unit inference is a naming heuristic and can be wrong (ratios fall back to plain numbers);
  the Unit field overrides it.
- With a typed step the query can exceed 11,000 points; the API's refusal is shown, with
  "Use the automatic step".
- Relative ranges re-resolve "now" when the page's width crosses a 100 px bucket, which
  refetches on resize.
- The favicon is an SVG file and cannot read the tokens; it repeats the two `ink` values.
- The page jumped to the top after every change of form on a phone until late in this change
  (fixed, checked, a mutant). It was found by a speed run dying, not by a check or a review:
  other positions that matter (a long table, a reload) have no check of their own beyond the
  layout-shift ones.
- The URL's `view` follows 300 ms after the last change of form. A Back press inside those
  300 ms keeps the form on screen and writes it into the entry Back went to.
- `e2e/measurements/` still holds the earlier changes' files (`fixes-*`, `rapi-*`, `cand-*`,
  `tune-*`, `fingerprint-*`, `mutants*.txt`): their tables are under "Earlier changes".
- Not tested: Safari and Firefox, real touch hardware, a screen reader by ear, enlarged text
  as distinct from zoom, a deployed viz, a clock change inside the window.

## Earlier changes: their verification and speed (2026-11-19, before v9)

Kept as it was written, for the decisions it carries (the streaming parser, the retry rules,
the mock's contract). **It describes the app before the move to design system v9**: the
suites `e2e/run.cjs`, `e2e/design.cjs` and `e2e/fixes.cjs`, the uPlot chart, the legend, the
time picker and the Settings dialog it names no longer exist (what replaced each check is in
"Verification" above), and its mutants broke code that is gone; `e2e/errors.cjs`,
`e2e/contract.cjs`, `src/api/` and the mock are as it says, with the differences this change
made stated above. No figure here was judged: every run started above the core count.


Run on 2026-11-19, Node 22.23, on a machine shared with other builders (load average 9 to
26 on 4 cores), the real stack under `wrangler dev --local` on port 8851. The four mock suites
ran last at 03:24 to 03:28 UTC, and the unit tests, typecheck and build at 03:30 to 03:32,
on the final source.
Two edits came after the 01:43 run of the two real-API suites: the grid's point count in
`src/lib/series.ts` (found by the mutation run, below) and the stack's readiness check in
`e2e/lib.cjs` and `real/stack.mjs`; their re-run could not be counted (the table says why).

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
| `node e2e/contract.cjs` | 82 of 82 checks pass (01:43 UTC): 59 requests to both, compared, 22 of them value by value, and the limits-record refusal (one wording difference, reported, not failed: the mock's "aggregation "limitk" (not implemented …)" against the real "limitk / limit_ratio aggregations"). The answers file is that run's. **Re-run at 03:27 on the final source: not counted**: the real API answered 500 `internal` "the query engine could not be loaded" to every query, because `engine/wasm-query/js/index.ts` (changed 03:24) expects module ABI 3 and `viz_query.wasm` (00:50) is ABI 2, another engineer's change in progress; 9 of 60 checks passed, and it also found a 30th cost header in the working tree of `query/` |
| `node e2e/real.cjs` | 28 of 28 checks pass on the real API (01:44 UTC; one page error is expected and checked for: the PromQL linter's stack overflow on a 5,000-term query). The 03:28 re-run stopped at its first page for the same engine mismatch |
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

### Mutants of the earlier changes

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

### Speed of this change (the real API, and the response path)

Measured here with `e2e/measure.cjs` (`node e2e/summarise.cjs` prints the tables): Chromium,
CPU throttled 4x, network shaped to DevTools' Fast 4G, a fresh context per run, the 75th
percentile of 20 runs (median, maximum), in alternating batches of five runs. Desktop is
1440 x 900 with a fine pointer; phone is 400 x 800 with touch, a coarse pointer and device
scale 2 (presses are touches, the crosshair a touch drag), as `design-system/tools/speed.mjs`
sets them. The page is Explore over the fixed three-hour window; the 36- and 200-series
bodies come from the mock over the shaped network, gzip-compressed as the real API sends them
(0.88 MB and 3.4 MB of JSON; 0.84 MB on the wire for 200 series). This is the application, not
the system's fixture page.

**Load.** The machine was shared with other builders throughout (mutation runs, model
checkers, Rust builds): the 1-minute load average at the start of every run is in the files
and under every table, and **no run was judged**: the load was above the 4 cores in every
one of the 380 runs, between 4.8 and 26.3. Every timing figure below is printed, not judged
(design-system README, "Load"); layout shift is judged. The calibration task (the loop of
`tools/speed.mjs`, timed in Node before each batch) took 294 to 894 ms over the 35 batches;
no idle figure could be taken here. On a quieter machine
every timing would be lower; the comparisons hold because the columns alternated in batches
and share the load.

**Two harness corrections** made before these runs. (1) "Response to paint, from the last
byte" now starts at the last byte also for a body read in a worker (the worker's own
Resource Timing, moved to the page's clock); the earlier partial files (`cand-*` at the
restart) had no such figure for the worker. (2) DevTools' CPU throttling does not throttle a
dedicated worker as it throttles the page: the same loop ran 3.5 to 4.4 times slower on the
page at 4x and 1.4 to 1.6 times slower in a worker (measured here, two rounds). Work moved
into a worker is therefore measured at roughly a third of its throttled cost, and candidate W
below cannot be compared fairly with the others.

#### Reading the body: four candidates

The same workload four ways, each built from the same source but for the one step, against
the same design-system snapshot, and each rendering exactly the same thing: before any time
was compared, `e2e/fingerprint.cjs` recorded for 4, 36 and 200 series the chart's pixels
(SHA-256 of the canvas), the legend with Other opened, every table row, the text digest and
the JSON form, and the four builds were identical in all fifteen (the JSON form shows its
first 60,000 characters; those were compared). The parsers also read each other's output:
`src/api/matrix.test.ts` checks the streaming parser against `JSON.parse` and `Number` on
1,000 random bodies cut into pieces anywhere, and `src/lib/series.test.ts` checks that both
align to what the previous implementation gave.

- **A**: the app before this change (commit `060d3bd`): `JSON.parse` of the whole body, then
  every sample a boxed number in `(number | null)[]` columns.
- **B**: this change, but the body read whole (`res.text()`) and `JSON.parse`d, then copied
  into Float64Arrays (`fromJson`).
- **C**: this change: the body read as it arrives into Float64Arrays (`src/api/matrix.ts`),
  on the main thread.
- **W**: C in a dedicated worker (`src/api/matrixWorker.ts`): the worker fetches and parses,
  the arrays come back by transfer and the text by copy. **Not comparable** (above): the
  worker is not throttled like the page.

Desktop, 20 runs each, typing and crosshair left out (they do not touch the body), in
alternating batches of five (A, B, C, W, A, …). Files `e2e/measurements/cand-{A,B,C,W}-{36,200}.json`;
they replace the partial files of the same names left at the container restart (at most 8
runs each, the earlier timing, no figure from the last byte for W).

#### 36 series (sum by (service, route, status) (rate(http_requests_total[5m]))), desktop

| What | Budget | A | B | W | C | Within budget (C)? |
|---|---|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 23 (19, 90) | 26 (16, 96) | 28 (22, 74) | 30 (20, 138) | within, not judged (load > cores) |
| Click on Run query to the busy state painted | 100 ms | 45 (35, 215) | 50 (44, 107) | 43 (37, 415) | 48 (43, 363) | within, not judged (load > cores) |
| Chart to table | 100 ms | 116 (73, 552) | 104 (78, 475) | 105 (61, 285) | 143 (80, 194) | over, not judged (load > cores) |
| Table to text | 100 ms | 90 (72, 255) | 54 (45, 128) | 55 (46, 310) | 61 (46, 173) | within, not judged (load > cores) |
| Text to chart | 100 ms | 46 (35, 136) | 54 (42, 178) | 41 (39, 58) | 43 (38, 157) | within, not judged (load > cores) |
| Open the time picker | 100 ms | 79 (68, 270) | 84 (66, 206) | 62 (58, 514) | 79 (61, 282) | within, not judged (load > cores) |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 261 (136, 330) | 170 (101, 270) | 195 (122, 282) | 138 (79, 266) | over, not judged (load > cores) |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 290 (176, 390) | 266 (173, 661) | 214 (128, 286) | 190 (135, 392) | over, not judged (load > cores) |
| Release of Run query to the result painted, network included (not a budget figure) |  | 1015 (868, 1738) | 1040 (924, 1700) | 1049 (886, 1513) | 1121 (780, 2199) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 144 (128, 464) | 112 (104, 448) | 176 (88, 472) | 152 (112, 336) | within, not judged (load > cores) |
| Layout shift, first load | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- A: 20 runs, load at run start median 18.1 (9.8 to 22.7) on 4 cores, 0 of 20 runs judged, calibration 723 ms (median of 4 batches)
- B: 20 runs, load at run start median 16.8 (10.1 to 22.1) on 4 cores, 0 of 20 runs judged, calibration 557 ms (median of 4 batches)
- W: 20 runs, load at run start median 17.6 (10.7 to 23.1) on 4 cores, 0 of 20 runs judged, calibration 773 ms (median of 4 batches)
- C: 20 runs, load at run start median 17.8 (12.0 to 26.3) on 4 cores, 0 of 20 runs judged, calibration 584 ms (median of 4 batches)

#### 200 series (viz_synthetic_series), desktop

| What | Budget | A | B | W | C | Within budget (C)? |
|---|---|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 37 (22, 137) | 34 (20, 79) | 29 (21, 64) | 35 (20, 78) | within, not judged (load > cores) |
| Click on Run query to the busy state painted | 100 ms | 59 (35, 416) | 49 (42, 196) | 58 (35, 132) | 46 (35, 121) | within, not judged (load > cores) |
| Chart to table | 100 ms | 118 (66, 227) | 109 (67, 338) | 91 (63, 406) | 80 (68, 211) | within, not judged (load > cores) |
| Table to text | 100 ms | 85 (69, 140) | 53 (44, 175) | 46 (40, 120) | 55 (46, 154) | within, not judged (load > cores) |
| Text to chart | 100 ms | 50 (42, 177) | 39 (33, 157) | 49 (39, 169) | 65 (38, 188) | within, not judged (load > cores) |
| Open the time picker | 100 ms | 69 (60, 158) | 74 (63, 364) | 80 (64, 277) | 96 (74, 506) | within, not judged (load > cores) |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 175 (142, 590) | 119 (92, 318) | 141 (106, 437) | 107 (79, 854) | over, not judged (load > cores) |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 426 (383, 1381) | 398 (357, 1191) | 190 (139, 607) | 240 (191, 1951) | over, not judged (load > cores) |
| Release of Run query to the result painted, network included (not a budget figure) |  | 3152 (2591, 5276) | 2884 (2348, 4479) | 2785 (2431, 3829) | 2819 (2257, 4531) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 152 (80, 408) | 176 (104, 360) | 120 (80, 392) | 136 (88, 576) | within, not judged (load > cores) |
| Layout shift, first load | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run | 0.05 | 0.0000 (0.0000, 0.0002) | 0.0000 (0.0000, 0.0002) | 0.0000 (0.0000, 0.0002) | 0.0000 (0.0000, 0.0002) | yes |

- A: 20 runs, load at run start median 18.0 (8.9 to 23.3) on 4 cores, 0 of 20 runs judged, calibration 723 ms (median of 4 batches)
- B: 20 runs, load at run start median 17.7 (12.1 to 22.8) on 4 cores, 0 of 20 runs judged, calibration 557 ms (median of 4 batches)
- W: 20 runs, load at run start median 18.9 (12.4 to 22.1) on 4 cores, 0 of 20 runs judged, calibration 773 ms (median of 4 batches)
- C: 20 runs, load at run start median 17.1 (11.4 to 25.4) on 4 cores, 0 of 20 runs judged, calibration 584 ms (median of 4 batches)

**What the candidates show** (all not judged, load 9 to 26): from the last byte to the
painted result, C took 190 ms at 36 series and 240 ms at 200 series at the 75th percentile,
against 290 and 426 ms for A and 266 and 398 ms for B; W's 214 and 190 ms are not comparable
(its parsing ran about three times too fast). B shows that typed arrays alone (A to B: 290 to
266, 426 to 398 ms) are not what helps at 200 series; reading the body while it downloads
(B to C) is. All three fair candidates are over the 100 ms budget at this load. C was kept.

**Tuning, each candidate on its own** (steps in order; "measured" says how):

- **C, the streaming parser** (the previous session's steps are as its code comments record
  them; their figures were not kept):
  1. The unit cut at the end of one piece is finished on a short junction string (the cut
     unit plus the next piece's first 1,024 characters), and the rest of the piece is read
     from the piece itself: reading through `pending + chunk` (a V8 cons string) was "about
     twice as slow" (code comment; no figure kept).
  2. The compact pair `[t,"v"]` is found with `indexOf` (native) before the general loop
     (code comment: "faster than a loop here"; no figure kept).
  3. The text digest is prepared when the browser is idle after a result arrives
     (`requestIdleCallback`), so the first switch to the text form only renders it (about
     15 ms at 4x for 200 series, code comment).
  4. This session: the body's text (3.4 MB for 200 series) is joined when the JSON form
     first reads it, not in `finish()`. Measured with the CPU profiler at 4x CPU and Fast 4G
     (two runs, load about 20): the join took 10 and 55 ms of main thread in the 100 ms after
     the last byte; in Node, unthrottled, one `finish()` took 12 ms. Then measured in the
     harness, C against C with this step (C2), 200 series, 10 runs each, alternating (load
     median 5.8 and 7.6, 4.8 to 12.7; not judged): from the last byte 218 (163, 292) ms
     against 213 (179, 224) ms; release to paint 2,057 against 1,867 ms. **No difference the
     harness can show at this load.** Kept: the profile shows the join gone from the response
     path, the rendered result is identical (fingerprints), and the join now happens only if
     the JSON form is opened. Files `e2e/measurements/tune-{C,C2}-200.json`.
  5. Considered, not adopted: aligning in place, i.e. using the parser's own Float64Array as
     the column when a series has every grid point and every value finite. In Node, warm, it
     took `alignSeries` for 200 series from 1.1 to 0.5 ms (median of 50); in the page it runs
     once per result and cold (17 to 40 ms at 4x in the profiles), so the saving there is
     unknown and below what this machine's noise lets the harness see, and it would share
     the result's arrays with the parser.
  6. Observed, not acted on: the parser costs more the smaller the pieces. In Node,
     unthrottled, 200 series: 44 ms in one piece, 58 ms in 64 KiB pieces, 76 ms in 4 KiB
     pieces (medians of 35, load about 13; minima 19, 23 and 26 ms). The browser hands the
     reader pieces of 4 to 130 KB (seen in the timeline below).
- **B, `JSON.parse` into typed arrays**: one indexed pass over the parsed pairs, the special
  values compared before `Number()`. Nothing else was tried: its cost is `JSON.parse` of the
  whole body after the last byte, which no loop around it can move.
- **W, the worker**: the arrays are transferred, not copied; the text is posted (a copy). Not
  tuned further, because its figures cannot be compared (above).
- **A** is the app before this change and was not changed.

**Where the time after the last byte goes** (C, 200 series, an instrumented copy of the
build, 4x CPU, Fast 4G, three runs, load about 20; times from the last byte): the body
arrives over about 0.85 s in 180 to 260 pieces and parsing keeps up with it (160 to 210 ms
of parsing in all, under 2 ms after the last byte); `finish()` 9 to 34 ms (the join, since
removed); then 70 to 80 ms in which the profiler sees mostly native work ("(program)") and
the query library's notification; then the render of the new result (aligning 10 to 40 ms,
names, statistics, colours, the chart's redraw) in one task of 70 to 100 ms; the next frame
comes 185 to 315 ms after the last byte. What the native work is was not found.

#### Before and after: desktop

Before is the app at commit `060d3bd` (the review fixes), after is this change; both built against the same
design-system snapshot, each rendering the three cases identically (`e2e/fingerprint.cjs`: `fingerprint-cand-A.json`,
`fingerprint-after.json`). 20 runs each, alternating batches of five, typing and crosshair included. Files
`e2e/measurements/rapi-{before,after}-{4,36,200}.json`.

#### 4 series (sum by (service) (rate(http_requests_total[5m]))), desktop

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 36 (22, 172) | 27 (19, 111) | within, not judged (load > cores) |
| Click on Run query to the busy state painted | 100 ms | 104 (42, 382) | 55 (44, 162) | within, not judged (load > cores) |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 34 (30, 51) | 33 (30, 47) | within, not judged (load > cores) |
| Typing: the slowest key of a run (not a budget figure) |  | 142 (66, 278) | 148 (93, 235) |  |
| Typing: keys over 50 ms, of 60 |  | 8 (2, 16) | 5 (2, 14) |  |
| Crosshair: pointer move to the next frame | 50 ms | 29 (26, 62) | 27 (26, 54) | within, not judged (load > cores) |
| Chart to table | 100 ms | 81 (48, 201) | 53 (40, 172) | within, not judged (load > cores) |
| Table to text | 100 ms | 63 (39, 117) | 34 (30, 57) | within, not judged (load > cores) |
| Text to chart | 100 ms | 45 (38, 146) | 41 (37, 87) | within, not judged (load > cores) |
| Open the time picker | 100 ms | 94 (77, 253) | 68 (57, 286) | within, not judged (load > cores) |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 72 (51, 182) | 60 (41, 104) | within, not judged (load > cores) |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 87 (63, 243) | 73 (58, 190) | within, not judged (load > cores) |
| Release of Run query to the result painted, network included (not a budget figure) |  | 585 (536, 852) | 550 (526, 626) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 112 (88, 368) | 112 (64, 184) | within, not judged (load > cores) |
| Worst interaction, Event Timing, the whole run | 200 ms | 160 (112, 368) | 160 (112, 232) | within, not judged (load > cores) |
| Layout shift, first load | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 20 runs, load at run start median 14.7 (6.8 to 19.0) on 4 cores, 0 of 20 runs judged, calibration 602 ms (median of 4 batches)
- After: 20 runs, load at run start median 13.6 (10.1 to 16.0) on 4 cores, 0 of 20 runs judged, calibration 749 ms (median of 4 batches)

#### 36 series (sum by (service, route, status) (rate(http_requests_total[5m]))), desktop

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 33 (21, 118) | 30 (25, 57) | within, not judged (load > cores) |
| Click on Run query to the busy state painted | 100 ms | 50 (43, 212) | 51 (42, 202) | within, not judged (load > cores) |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 33 (31, 50) | 33 (30, 41) | within, not judged (load > cores) |
| Typing: the slowest key of a run (not a budget figure) |  | 135 (112, 237) | 151 (104, 294) |  |
| Typing: keys over 50 ms, of 60 |  | 7 (5, 14) | 7 (4, 10) |  |
| Crosshair: pointer move to the next frame | 50 ms | 35 (31, 54) | 31 (29, 62) | within, not judged (load > cores) |
| Chart to table | 100 ms | 102 (55, 298) | 86 (63, 294) | within, not judged (load > cores) |
| Table to text | 100 ms | 93 (58, 161) | 51 (44, 205) | within, not judged (load > cores) |
| Text to chart | 100 ms | 43 (38, 164) | 51 (38, 250) | within, not judged (load > cores) |
| Open the time picker | 100 ms | 72 (64, 108) | 76 (65, 270) | within, not judged (load > cores) |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 206 (127, 272) | 155 (85, 298) | over, not judged (load > cores) |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 243 (183, 438) | 199 (140, 420) | over, not judged (load > cores) |
| Release of Run query to the result painted, network included (not a budget figure) |  | 1036 (779, 2577) | 852 (761, 1430) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 144 (72, 264) | 136 (88, 224) | within, not judged (load > cores) |
| Worst interaction, Event Timing, the whole run | 200 ms | 184 (144, 296) | 224 (144, 264) | over, not judged (load > cores) |
| Layout shift, first load | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 20 runs, load at run start median 15.6 (6.3 to 18.0) on 4 cores, 0 of 20 runs judged, calibration 602 ms (median of 4 batches)
- After: 20 runs, load at run start median 13.9 (10.9 to 18.2) on 4 cores, 0 of 20 runs judged, calibration 749 ms (median of 4 batches)

#### 200 series (viz_synthetic_series), desktop

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 30 (22, 67) | 22 (17, 138) | within, not judged (load > cores) |
| Click on Run query to the busy state painted | 100 ms | 63 (40, 170) | 49 (37, 184) | within, not judged (load > cores) |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 35 (34, 44) | 33 (31, 36) | within, not judged (load > cores) |
| Typing: the slowest key of a run (not a budget figure) |  | 132 (101, 212) | 222 (94, 305) |  |
| Typing: keys over 50 ms, of 60 |  | 8 (4, 12) | 6 (3, 12) |  |
| Crosshair: pointer move to the next frame | 50 ms | 34 (29, 54) | 31 (29, 48) | within, not judged (load > cores) |
| Chart to table | 100 ms | 106 (68, 302) | 71 (66, 566) | within, not judged (load > cores) |
| Table to text | 100 ms | 75 (60, 301) | 60 (39, 210) | within, not judged (load > cores) |
| Text to chart | 100 ms | 43 (35, 64) | 44 (38, 208) | within, not judged (load > cores) |
| Open the time picker | 100 ms | 64 (55, 478) | 68 (59, 388) | within, not judged (load > cores) |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 155 (123, 495) | 105 (86, 276) | over, not judged (load > cores) |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 449 (378, 1332) | 233 (188, 353) | over, not judged (load > cores) |
| Release of Run query to the result painted, network included (not a budget figure) |  | 2637 (2377, 3329) | 2474 (2289, 5374) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 152 (80, 368) | 112 (72, 472) | within, not judged (load > cores) |
| Worst interaction, Event Timing, the whole run | 200 ms | 184 (160, 368) | 232 (152, 472) | over, not judged (load > cores) |
| Layout shift, first load | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |
| Layout shift, query run | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0002) | yes |

- Before: 20 runs, load at run start median 14.4 (8.0 to 16.8) on 4 cores, 0 of 20 runs judged, calibration 602 ms (median of 4 batches)
- After: 20 runs, load at run start median 14.0 (10.6 to 20.3) on 4 cores, 0 of 20 runs judged, calibration 749 ms (median of 4 batches)

#### Before and after: phone (400 x 800, touch)

The same builds and alternation, 36 and 200 series. Files
`e2e/measurements/rapi-{before,after}-phone-{36,200}.json`.

#### 36 series (sum by (service, route, status) (rate(http_requests_total[5m]))), phone

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 23 (20, 51) | 32 (23, 67) | within, not judged (load > cores) |
| Click on Run query to the busy state painted | 100 ms | 77 (61, 150) | 76 (62, 260) | within, not judged (load > cores) |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 35 (33, 84) | 37 (31, 47) | within, not judged (load > cores) |
| Typing: the slowest key of a run (not a budget figure) |  | 146 (107, 246) | 167 (129, 319) |  |
| Typing: keys over 50 ms, of 60 |  | 5 (3, 30) | 8 (5, 13) |  |
| Crosshair: pointer move to the next frame | 50 ms | 62 (56, 117) | 59 (55, 73) | over, not judged (load > cores) |
| Chart to table | 100 ms | 89 (82, 164) | 91 (80, 221) | within, not judged (load > cores) |
| Table to text | 100 ms | 78 (75, 175) | 73 (62, 214) | within, not judged (load > cores) |
| Text to chart | 100 ms | 59 (55, 139) | 64 (53, 120) | within, not judged (load > cores) |
| Open the time picker | 100 ms | 94 (80, 176) | 92 (85, 180) | within, not judged (load > cores) |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 104 (71, 355) | 66 (53, 202) | within, not judged (load > cores) |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 141 (93, 389) | 87 (72, 341) | within, not judged (load > cores) |
| Release of Run query to the result painted, network included (not a budget figure) |  | 748 (642, 1036) | 663 (616, 816) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 136 (88, 160) | 136 (88, 216) | within, not judged (load > cores) |
| Worst interaction, Event Timing, the whole run | 200 ms | 160 (136, 240) | 192 (136, 320) | within, not judged (load > cores) |
| Layout shift, first load | 0.05 | 0.0032 (0.0031, 0.0033) | 0.0032 (0.0031, 0.0033) | yes |
| Layout shift, query run | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 20 runs, load at run start median 12.5 (10.1 to 15.2) on 4 cores, 0 of 20 runs judged, calibration 476 ms (median of 4 batches)
- After: 20 runs, load at run start median 12.5 (9.4 to 14.6) on 4 cores, 0 of 20 runs judged, calibration 443 ms (median of 4 batches)

#### 200 series (viz_synthetic_series), phone

| What | Budget | Before | After | Within budget (After)? |
|---|---|---|---|---|
| Press on Run query: pointerdown to the pressed frame | 50 ms | 25 (21, 88) | 29 (23, 138) | within, not judged (load > cores) |
| Click on Run query to the busy state painted | 100 ms | 79 (60, 115) | 84 (68, 270) | within, not judged (load > cores) |
| Typing: keydown to the next frame, 75th percentile of the 60 keys of a run | 50 ms | 34 (30, 78) | 37 (32, 41) | within, not judged (load > cores) |
| Typing: the slowest key of a run (not a budget figure) |  | 143 (80, 281) | 214 (113, 304) |  |
| Typing: keys over 50 ms, of 60 |  | 5 (2, 21) | 7 (3, 12) |  |
| Crosshair: pointer move to the next frame | 50 ms | 51 (46, 64) | 57 (54, 118) | over, not judged (load > cores) |
| Chart to table | 100 ms | 106 (89, 133) | 119 (90, 530) | over, not judged (load > cores) |
| Table to text | 100 ms | 86 (80, 175) | 71 (61, 140) | within, not judged (load > cores) |
| Text to chart | 100 ms | 59 (52, 123) | 79 (58, 125) | within, not judged (load > cores) |
| Open the time picker | 100 ms | 96 (84, 140) | 112 (89, 212) | over, not judged (load > cores) |
| Response to paint, after the harness's copy of the body resolved (or the worker's message) | 100 ms | 147 (119, 360) | 86 (77, 124) | within, not judged (load > cores) |
| Response to paint, from the last byte (includes reading and parsing the body) | 100 ms | 323 (246, 701) | 185 (123, 922) | over, not judged (load > cores) |
| Release of Run query to the result painted, network included (not a budget figure) |  | 1591 (1425, 4508) | 1445 (1297, 2180) |  |
| Worst interaction, Event Timing, before typing and crosshair | 200 ms | 112 (96, 168) | 144 (104, 512) | within, not judged (load > cores) |
| Worst interaction, Event Timing, the whole run | 200 ms | 144 (112, 272) | 200 (144, 512) | within, not judged (load > cores) |
| Layout shift, first load | 0.05 | 0.0016 (0.0016, 0.0016) | 0.0016 (0.0016, 0.0019) | yes |
| Layout shift, query run | 0.05 | 0.0000 (0.0000, 0.0003) | 0.0000 (0.0000, 0.0000) | yes |

- Before: 20 runs, load at run start median 11.7 (10.4 to 16.6) on 4 cores, 0 of 20 runs judged, calibration 476 ms (median of 4 batches)
- After: 20 runs, load at run start median 12.7 (9.6 to 14.2) on 4 cores, 0 of 20 runs judged, calibration 443 ms (median of 4 batches)

**What changed, and what is still missed** (every timing not judged: load 4.8 to 26.3 on 4 cores).

- **Response to paint, from the last byte** (the budget's "100 ms after it arrives"): desktop,
  36 series 243 → 199 ms, 200 series 449 → 233 ms; phone, 36 series 141 → 87 ms (inside the
  budget at the 75th percentile, not judged), 200 series 323 → 185 ms. **Still over the
  100 ms budget on desktop at both sizes and on the phone at 200 series.** Where the remaining time goes (the timeline above): about
  70 to 80 ms of native work and the query library's notification after `finish()`, then one
  task of 70 to 100 ms that aligns, names, colours and draws the new result. The next steps
  are not in this change: the result's preparation split from its first paint (draw the
  coloured series first, then the legend, statistics and colours of the rest, which is
  "coarse data first, refined in place" in the budget table), and the cause of the native
  work, which the profiler cannot attribute.
- **36 series, the boxed-sample garbage collection** the review fixes named: series values are
  Float64Arrays from the parser to every view (the chart converts only the series it draws), so
  no sample of the result is a boxed number. In the 200-series
  profiles (two runs) garbage collection after the last byte was 3 to 4 ms in a 25 ms slice;
  36 series was not profiled after the change, so whether its 10 to 55 ms pauses are gone is
  not shown, only that its figure fell from 243 to 199 ms and is still over the budget.
- **200 series, `JSON.parse` of 3.4 MB** (about 125 ms at 4x, after the last byte): gone from
  the response path. The body is parsed while it downloads (160 to 210 ms of parsing in all
  at 4x, under 2 ms of it after the last byte).
- **Chart to table, 200 series**: desktop 106 → 71 ms, within the budget; phone 106 → 119 ms,
  **over** (medians 89 → 90 ms: no change the runs can show). **Table to text, 200 series**:
  desktop 75 → 60 ms, phone 86 → 71 ms, within. Single runs still reach 566 ms (desktop) and
  530 ms (phone). The digest prepared in idle time (tuning step 3) is what changed for the
  text form; the 50-row table is still rendered on the switch, and making it cheaper (render
  it parked in idle time, as the chart is kept) is the next step for the phone.
- **On the phone at 200 series several local figures are higher after** (not judged): text
  to chart 59 → 79 ms, the time picker 96 → 112 ms (over), the worst interaction before
  typing 112 → 144 ms. One candidate cause, not tested: the digest prepared with
  `requestIdleCallback` (timeout 5 s) runs during the first switches the harness makes
  700 ms after the result. The 36-series phone figures did not move.
- **The crosshair on the phone** is over 50 ms before and after (36 series 62 → 59 ms, 200
  series 51 → 57 ms; a touch drag, pointer move to the next frame). Not addressed here.
- **Worst interaction over the whole run** (typing and crosshair included) is over 200 ms after
  at the 75th percentile on desktop (36 series 184 → 224 ms, 200 series 184 → 232 ms), with
  the medians unchanged (144 → 152, 168 → 160 ms), and at 200 ms on the phone at 200 series
  (144 → 200 ms); the slowest key of a run at 200 series is higher (desktop median 110 →
  161 ms, phone 143 → 214 ms at the 75th percentile). Typing itself is unchanged at the 75th percentile (33 to 35
  ms). Whether this is the load or the change was not found: the runs alternated, but the
  tail is where a shared machine shows most. Measure again on a quiet machine.
- Everything else is within its budget at the 75th percentile, as before, and layout shift
  is 0 on load and on a run at both layouts.

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

### Bundle of the earlier changes

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
