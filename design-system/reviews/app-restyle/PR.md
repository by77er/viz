# Make the web app use the design system

## What changed and why

`app/` was written before `design-system/` existed and had its own colours, type, spacing,
radii, shadow and motion. It now takes all of them from the system, and follows the system's
rules for speed and feedback. This is the first design change to go through the process in
`AGENTS.md`.

- **Tokens and components.** `app/src/main.tsx` imports `design-system/dist/viz.css`; the
  build copies the two WOFF2 files, so the app serves its own fonts, and `vite.config.ts`
  writes the preload link for the sans file into `index.html`. The root has `class="vz"`.
  Every control is a system component: `vz-button`, `vz-input`, `vz-select`, `vz-check`,
  `vz-segmented`, `vz-table` in `vz-table-wrap`, `vz-status`, `vz-panel`, `vz-banner`,
  `vz-menu`, `vz-dialog`, `vz-empty`, `vz-nav`, `vz-query`, `vz-progress`, `vz-kbd`,
  `vz-num`, `vz-label`, `vz-link`, `vz-field`, `vz-help`, `vz-mark`. (`vz-tabs`, `vz-stat`
  and `vz-tooltip` are not used: the view has no peer sections, no single figure, and nothing
  that exists only on hover.)
- **Tailwind is removed**, not mapped. Its reset and default scales emit literal `rem`, colour
  and opacity values; what the app used it for is now `app/src/app.css`, about 150 lines of
  layout written against tokens only. uPlot's own stylesheet is not loaded either, for the
  same reason.
- **The view was put through the presence test** (table below). The table and the JSON are
  now forms of the result beside chart and text, in one segmented control, instead of a
  second boxed panel under the first.
- **Chart colour.** Colours are the tokens `series-1` to `series-8`, read from the style, in
  that fixed order as hash slots: a series prefers the slot its label set hashes to and keeps
  it across reloads and themes. I read the Colour rule ("a ninth series folds into Other")
  and the Panel guideline and chose to fold, not to cycle: a result colours at most eight
  series, the first eight in sorted key order; every later one is drawn as a hairline in
  `ink-muted` beneath the coloured lines and marked "Other" in the legend. The Other series
  are not summed into one line, because a sum is wrong for quantiles and ratios; they stay
  individually listed and can be isolated. The dash patterns that used to tell a ninth
  series apart are gone. Up to four series are labelled directly at the line ends.
- **Speed and feedback.** Run query is `aria-busy` while a query runs and ignores a second
  press. The progress line appears after 400 ms, stays 300 ms, offers Cancel from 2 s (wired
  to the request's `AbortSignal`), names a shorter range from 10 s and stops at 60 s. It is
  the unmeasured form, "Waiting for the query" with the running time, because the mock
  reports nothing that could be drawn as a fraction. The previous result stays visible and
  usable. The panel head states the unit and the age of the data and keeps the age current.
  The waiting line, the result region and the mock banner reserve their space.
- **The mock has a latency switch**: `--delay` / `VIZ_MOCK_DELAY`, `?delay=<ms>` on a request,
  and `GET /__mock/delay?ms=<ms>` at run time.
- **One behaviour change that is not design**: pressing Run with a changed query used to send
  the old query once more before the new one. It now sends only the new one.

## How it was verified

Run on 2026-11-18 on a machine shared with other jobs. Commands are from `app/`.

| Check | Result |
|---|---|
| `npm test` | 71 tests in 5 files pass |
| `npx tsc --noEmit` | passes |
| `npm run build` | passes |
| `node ../design-system/tools/check.mjs src` | contrast 122/122; 0 literal values in 37 files |
| `node e2e/run.cjs` (the existing suite, selectors updated, nothing deleted) | 54 of 54 pass |
| `node e2e/design.cjs` (new) | 52 of 52 pass |
| axe-core 4.14, WCAG 2.0 to 2.2 A and AA plus best practice | 0 violations of any impact in 13 runs |
| `node e2e/mutants.cjs` | 12 of 12 real mutants caught; a 13th survived because it breaks nothing |

`e2e/design.cjs` checks, in every state of the view and in both themes where colour is
involved: one blue button; no computed colour outside the values in `tokens.json`; the
pressed fill; busy and the ignored second press (pointer, shortcut, script, keyboard); the
progress line at 150, 450, 800 and 3000 ms of latency; Cancel aborting the request; the age
counting; the main flow by keyboard alone in reading order with the ring at each of 27 stops;
with an emulated touch device, 44 px hit areas with no overlap; no sideways page scroll at
400 px; no text under 11 px; no transition left under reduced motion.

Three existing checks changed meaning; the reasons are in `app/README.md`: syntax
highlighting is now asserted to be absent (the system's query well is one ink), the automatic
step for 24 h at 1440 px is 2 m instead of 1 m (the system's gutters make the panel 24 px
narrower, which is one width bucket), and the table and JSON are reached through the
segmented control.

Not tested: 200% zoom as such (400 px is the narrowest layout tested), real touch hardware,
a screen reader by ear, Safari and Firefox. The speed numbers were taken on a loaded machine
and on Explore, because the fixture dashboard the system names does not exist. I also ran
`git status` once, by mistake, against the instruction not to run git; it changes nothing.

## Design change?

**Who is looking, and what are they trying to do:** An engineer who has been paged, or is
chasing a regression, is looking at the result of one PromQL query to find out which series
changed, when, and by how much, and then to change the query or the time range and look
again.

### Presence test: the Explore view

Largest first. An element stays only if it answers a question nothing else answers.

| Element | The question it answers |
|---|---|
| Chart (lines, value axis, time axis, baseline, gridlines) | Which series changed, when, and by how much? |
| Direct labels at the line ends (up to four series) | Which line is which, without looking away from it? |
| Legend table: series, last, min, max | What is the exact figure for each series, and which is highest? |
| Legend row as a toggle; "Show all series" when some are hidden | Can I look at one series alone, and get the rest back? |
| Caption under the chart: series count, step, time taken, rollup, how many are grey | How complete and how fine is what I am looking at? |
| Query well | What exactly was asked, and how do I change it? |
| Run query (blue, with its shortcut) | How do I ask? The one primary action. |
| Time range button and its menu | Which period is this, and how do I pick another? |
| Show earlier, Show later, Zoom out | What happened just before, just after, and around this window? One press each; nothing else does it in one press. |
| Step field | How fine is the sampling, and can I force it? |
| Unit select | Is this number seconds, bytes or a rate, when the guess is wrong? |
| Show as: chart, table, text, JSON | Can I read the same result as rows, as text for a screen reader or an agent, or as what the API sent? |
| Panel rule and title "Query result" | Where does the result begin? It is also the region's accessible name. |
| Unit and age in the panel head | What are these numbers in, and how old is what I am looking at? |
| Waiting line (only while waiting over 400 ms) | Is it still working, for how long, and can I stop it? |
| Mock banner | Can I trust this data? (No: it is synthetic.) |
| Navigation: viz, Explore, Help | Where am I, and where is the help? |
| Commands button | How do I reach every command without knowing a shortcut, or on a touch screen? |
| Settings button | Which backend is this talking to, and how do I change that or the theme? |
| Field labels: Time range, Step, Unit, Show as | What is this control for? |
| Empty, error and start states | Why is there no chart, and what do I change? |

**Removed, because they had no answer or repeated another element's:**

- The logo mark and the home link (the Explore link is next to it).
- The theme button in the header (the same choice is in Settings and in the command palette),
  and all icons: theme, settings, search, clock, chevrons, magnifier, warning triangle, close
  cross, tick and cross glyphs. The system has no icon set and says to use words.
- The MOCK pill in capitals; the banner's sentence says it.
- Syntax colours in the query, and the autocomplete's type icons.
- "721 steps" and the repeated time range in the status line: the range is in the control
  directly above, and the step count follows from range and step.
- The second boxed panel with its Table and JSON tabs and its caption; the swatches in the
  result table (series colours do not appear outside the chart).
- The card boxes, fills and rounded corners around both panels, the tinted banner, the tinted
  selected segment, the tinted error box and its bordered badge.
- The animated indeterminate loading bar, the "Loading…" text and the dimming of the old
  result: none of them was measured or said anything true. The busy button, the waiting line
  and the age replace them.
- Hover-only behaviour: `title` tooltips, and dimming the other lines when a legend row is
  hovered.
- The dash patterns for a ninth series and beyond.
- In the command palette: group headings (separators divide the groups) and the footer of key
  hints. In settings: the close cross (Cancel and Escape exist) and the Show/Hide button (now
  a checkbox).
- The step field's list of suggestions; its placeholder shows the form.
- Line wrapping in the query editor: the query well scrolls sideways.

### Reading order

The first three things the eye should reach, in order:

1. The query and Run query: top of the page, the only colour in the interface.
2. The chart: the largest area, with its labelled lines.
3. The legend's figures: last, min and max, right-aligned in monospace under the chart.

Checked on greyscale copies: `after/greyscale-explore-light-1440.png` and
`after/greyscale-explore-dark-1440.png`.

### Before and after

Both themes, 1440 and 400 px, same query, same fixed three-hour window, same mock data.
Captured with `design-system/tools/shots.mjs` through `app/e2e/capture.sh`; each cell is four
composed images, `compare/<name>-{light,dark}-{1440,400}.png`. The "before" was captured from
the untouched app before any edit. Paths are relative to this file.

| View | Before / after |
|---|---|
| Explore with a result | [light 1440](compare/explore-light-1440.png) · [dark 1440](compare/explore-dark-1440.png) · [light 400](compare/explore-light-400.png) · [dark 400](compare/explore-dark-400.png) |
| Many series (36) | [light 1440](compare/many-series-light-1440.png) · [dark 1440](compare/many-series-dark-1440.png) · [light 400](compare/many-series-light-400.png) · [dark 400](compare/many-series-dark-400.png) |
| Table view (before: the table sat under the chart) | [light 1440](compare/table-light-1440.png) · [dark 1440](compare/table-dark-1440.png) · [light 400](compare/table-light-400.png) · [dark 400](compare/table-dark-400.png) |
| Text view | [light 1440](compare/text-light-1440.png) · [dark 1440](compare/text-dark-1440.png) · [light 400](compare/text-light-400.png) · [dark 400](compare/text-dark-400.png) |
| Empty result | [light 1440](compare/empty-light-1440.png) · [dark 1440](compare/empty-dark-1440.png) · [light 400](compare/empty-light-400.png) · [dark 400](compare/empty-dark-400.png) |
| Error | [light 1440](compare/error-light-1440.png) · [dark 1440](compare/error-dark-1440.png) · [light 400](compare/error-light-400.png) · [dark 400](compare/error-dark-400.png) |
| No query yet | [light 1440](compare/start-light-1440.png) · [dark 1440](compare/start-dark-1440.png) · [light 400](compare/start-light-400.png) · [dark 400](compare/start-dark-400.png) |
| Rolled up to min/max, with a gap in one series | [light 1440](compare/rollup-and-gap-light-1440.png) · [dark 1440](compare/rollup-and-gap-dark-1440.png) · [light 400](compare/rollup-and-gap-light-400.png) · [dark 400](compare/rollup-and-gap-dark-400.png) |
| Time picker open | [light 1440](compare/time-picker-light-1440.png) · [dark 1440](compare/time-picker-dark-1440.png) · [light 400](compare/time-picker-light-400.png) · [dark 400](compare/time-picker-dark-400.png) |
| Command palette open | [light 1440](compare/command-palette-light-1440.png) · [dark 1440](compare/command-palette-dark-1440.png) · [light 400](compare/command-palette-light-400.png) · [dark 400](compare/command-palette-dark-400.png) |
| Settings open | [light 1440](compare/settings-light-1440.png) · [dark 1440](compare/settings-dark-1440.png) · [light 400](compare/settings-light-400.png) · [dark 400](compare/settings-dark-400.png) |

The images are palette-encoded to keep the directory at 15 MB (`app/e2e/encode-review-images.py`):
`before/` and `after/` are stored at half the captured size, `compare/` at the size
`shots.mjs` wrote. Token colours are kept exact; anti-aliased edges are approximated. They are
referenced by path here; when the change is committed the links should be rewritten to the
commit, as `design-system/README.md` describes.

**States covered:** loading · empty · error · partial · focus · hover · pressed · busy

These exist only after the change, so they are in `after/` with nothing to compare. Each name
has `-light-` and `-dark-` versions; full views have `-1440` and `-400`, crops `-1440` only.

| State | Image (`after/…`) |
|---|---|
| Waiting 150 ms: the busy button, nothing else | `waiting-150ms-*` |
| Waiting 800 ms: the progress line, no Cancel | `waiting-800ms-*` |
| Waiting 3 s (pictured at 2.5 s): the line with Cancel, the old result and its age beneath | `waiting-3s-*` |
| Cancelled: says so, the previous result is shown, Retry | `cancelled-*` |
| Empty, error, no query yet | `empty-*`, `error-*`, `start-*` |
| Partial: rolled up to min/max per pixel column; 28 of 36 series folded into Other | `rollup-and-gap-*`, `many-series-*` |
| Invalid field (step "15x"), and one series isolated in the legend | `invalid-step-isolated-*` |
| Focus ring on each kind of control | `focus-nav-link`, `focus-quiet-button`, `focus-primary-button`, `focus-button`, `focus-input`, `focus-select`, `focus-segment`, `focus-query-editor`, `focus-chart`, `focus-column-head`, `focus-legend-row`, `focus-menu-item`, `focus-checkbox`, `focus-error-action` |
| Hover and pressed | `hover-…` and `pressed-…` for `primary-button`, `button`, `segment` |
| Busy | the Run query button in every `waiting-*` image |
| Coarse pointer at 400 px, as drawn and with each control's hit area outlined | `coarse-*-400`, `coarse-hit-areas-*-400`, `coarse-time-picker-*-400`, `coarse-time-picker-hit-areas-*-400` |
| Greyscale, for the reading order | `greyscale-explore-*-1440` |

Disabled is not imaged: the view has no disabled control any more (Test connection is busy,
not disabled, while it runs). The 10 s and 60 s rows of the waiting table are implemented
and not imaged or tested end to end.

I compared the after images with `design-system/reviews/reference-v2.png` in two rounds and
changed, among other things: a closed dialog that was showing (see proposed system changes),
direct labels that covered the line ends, monospace gaps inside sentences, the wrap order of
the time controls at 400 px, the Other lines drawing over the coloured ones, the empty
state's distance from the panel head, a native dropdown arrow in the step field, and review
images whose palette had turned the yellow warning mark pink.

**New tokens or components, with reasons:** none were added, and nothing in the app is styled
outside the tokens. Where the system has no component, the app composes the nearest ones and
the gap is listed here as a proposal:

| What the app needed | What it uses meanwhile | Proposed addition |
|---|---|---|
| The crosshair readout (time and one row per series) | the `vz-menu` surface with `vz-num` rows | a chart readout component |
| A sortable column head | a plain button in the `vz-label` style, a text arrow, `aria-sort` | a sortable `vz-table` head |
| The current choice in a menu (the active time preset) | `aria-current` in the `ui-strong` type style | a checked state for a menu row |
| How to draw the series folded into Other | hairlines in `ink-muted`, under the coloured lines | a rule, and perhaps a `series-other` token |
| A number or identifier inside a sentence | `.app-num`: the `data` font on the sentence's own line height | let `vz-num` be used inline (its 20 px line height makes an 18 px line taller) |
| The chart's drag selection | two `ink` hairlines, no fill (a fill would need a translucent colour) | a brush style in the Panel guideline |
| A scrim behind a dialog | none; the dialog floats on its shadow alone | the scrim token the system's README already lists as missing |
| A skip link | a `vz-button` shown on focus | a skip-link pattern |

**Proposed system changes** (bugs and gaps found in `design-system/`; nothing there was
edited):

1. **`.vz-dialog` shows a closed `<dialog>`.** It sets `display: flex`, which overrides the
   element's own `display: none` when it is not open. The app adds
   `dialog:not([open]) { display: none }`. Fix: scope the rule to `[open]`.
2. **Monospaced inputs stay small on touch.** The coarse-pointer rule gives `.vz-input`
   body-size text, but `.vz-input[data-mono]` is more specific and keeps 13 px, which makes
   phones zoom the page on focus. The app repeats the coarse rule for `[data-mono]`, with
   the system's own token.
3. **`.vz-menu [role="menuitem"]` assumes the row is not a button.** A real `<button>` row
   keeps its border, fill and centred text; the app resets them.
4. **`.vz-nav` keeps `space-6` padding and gap at every width**, while the Layout rule says
   the gutter is `space-4` below 640 px. The app overrides it in a container query.
5. **`.vz-empty` has `space-6` of padding above it**, while its guideline says it sits at the
   top of the region, where the result would have started. The app sets it to zero.
6. **The waiting line's space.** The rules ask for `vz-progress` at the top of the region and
   for layout shift under 0.05, but do not say that its line must be reserved. The app
   reserves one `small` line under the panel head, which is empty when idle. The system
   should say whether that is the intended answer.
7. **`tools/shots.mjs`** can only open a URL and wait for the network to go idle, so it
   cannot picture an open menu, a pending request, a focus ring or a coarse pointer. The app
   carries a dev-only script and `e2e/states.cjs` for those. A full-page capture also resets
   the device emulation, so a touch context loses its coarse pointer; `states.cjs` uses a
   tall viewport instead.
8. **`tools/check.mjs`** lints TypeScript for colours only, so a literal length in an inline
   style or a class string passes; I searched for those by hand. It does not look at
   `index.html` (the favicon).
9. **Words.** The reference writes minutes as "15 m"; "15 min" would not be read as metres.
   The app follows the reference.

**Speed** (input response, view change, first result paint; before and after, and how
measured):

Measured here with `app/e2e/measure.cjs` on the built app and the mock: Chromium, CPU
throttled 4x (CDP `Emulation.setCPUThrottlingRate`), network shaped to DevTools' Fast 4G,
1440x900, a fresh browser context per run, the 75th percentile of 20 runs, with the median
and the maximum in brackets. "Before" is the app as it was, built from a copy made before
any edit. The two builds were measured in alternating batches of five runs, because the
machine was shared and its load drifted (load average 8 to 12 during the runs); on an idle
machine every figure is lower. A press is a real one: pointerdown, held 60 ms, pointerup.
Raw runs: `app/e2e/measurements/before.json` and `after.json`.

| What | Budget | Before | After |
|---|---|---|---|
| Press on Run query: pointerdown to the end of the frame with the pressed fill | 50 ms | 18 ms (13, 37) | 23 ms (20, 84) |
| Click on Run query to the busy state painted | 100 ms | no busy state | 51 ms (39, 86) |
| Chart to table | 100 ms | not a form | 64 ms (54, 150) |
| Table to text (before: chart to text) | 100 ms | 69 ms (62, 88) | 61 ms (47, 75) |
| Text to chart | 100 ms | 132 ms (108, 155) | 59 ms (53, 83) |
| Open the time picker | 100 ms | 82 ms (67, 109) | 73 ms (67, 94) |
| Response arrived to result painted | 100 ms | 93 ms (82, 134) | 68 ms (62, 238) |
| Worst interaction in a run (Event Timing duration, 8 ms steps) | 200 ms | 112 ms (96, 144) | 64 ms (56, 80) |
| Longest input delay in a run | within the 50 ms | 11 ms (6, 28) | 16 ms (7, 44) |
| Layout shift, first load | 0.05 | 0.0175 | 0.0000 |
| Layout shift, query run: the standard metric, and counting shifts within 500 ms of input | 0.05 | 0.0000 and 0.0000 | 0.0000 and 0.0000 |
| Shell script, compressed (gzip 9) | 200 kB | 145.9 kB | 146.1 kB |

| Bytes | Before raw | Before gzip | After raw | After gzip |
|---|---|---|---|---|
| Initial JS | 443.7 kB | 145.9 kB | 443.2 kB | 146.1 kB |
| Lazy editor JS | 451.9 kB | 143.0 kB | 448.4 kB | 141.7 kB |
| CSS | 24.4 kB | 6.3 kB | 26.4 kB | 5.7 kB |
| Fonts (WOFF2) | none | | 128.8 kB | sans 74.7 kB, mono 54.1 kB |

Plainly:

- Every 75th percentile is inside its budget. Single runs are not: of the 20 "after" runs,
  one press took 84 ms, two chart-to-table changes took 102 and 150 ms, and two results took
  135 and 238 ms to paint.
- Before the restyle, text to chart missed its budget (132 ms); it now takes 59 ms.
- The press is 5 ms slower than before at the 75th percentile, and the longest input delay
  5 ms longer. Both are inside the budget; I did not find the cause.
- The first version of the restyle missed two budgets on this harness: text to chart (146
  ms) and, under load, response to paint (121 ms). The causes were fixed, not covered: the
  chart now stays mounted and laid out while another form is shown; new data for the same
  series goes into the existing plot instead of a new canvas; the chart draws in the same
  frame as the rest of the result; the form changes in local state and the URL follows after
  the frame; the tokens are read from the style once per theme; the crosshair readout reuses
  its rows, moves by transform and measures its width once.
- No waiting state appears on a local change. The progress line appears only for a query
  and only after 400 ms.
- The fonts are 128.8 kB that were not there before. The sans file is preloaded and has the
  system's metric-matched fallback; first-load layout shift measured 0.
- Differences from the reference setup: no fixture dashboard exists, so the page is Explore;
  the preview server does not compress, so under Fast 4G the load is slower than it would be
  in production, which does not affect the interaction figures.

**Token check** (`node design-system/tools/check.mjs app/src`):

```
contrast: 122/122 pairings pass
literal values: 0 in 37 file(s)
```

Exit status 0. By hand, because the tool checks TypeScript for colours only:
`grep -rnE "[0-9]+(px|rem|em)\b|#[0-9a-fA-F]{3,8}\b|opacity|rgba?\(" app/src --include=*.ts --include=*.tsx`
finds nothing outside the tests. Numbers that remain in the source are not style values: the
waiting thresholds from the rules (400, 300, 2000, 10000, 60000 ms, in
`app/src/explore/waiting.tsx`), the 1.5 s "Copied" label, and chart arithmetic on values read
from tokens. One literal colour pair remains outside `app/src`: the favicon in
`app/index.html` is an inline SVG that cannot read custom properties and repeats the two
`ink` values.

**What I believe still falls short of the rubric:**

- *Words, minor.* "Commands" and "Settings" in the navigation are nouns. Verbs made the
  navigation scroll sideways at 400 px.
- *Words.* CPU cores and plain numbers carry no unit after the value ("1.42", "500m"); the
  unit is stated once, in the panel head. The formatting library was not changed.
- *Charts.* With more than eight series, which eight are coloured follows sort order, not
  size, so the largest series can be grey. With five to eight series there are no direct
  labels, and three of the series tokens are below 3:1 on the light ground; the legend and
  the table are the relief the token notes ask for.
- *Touch.* Adding or removing one series from the selection needs Shift or Ctrl. On touch a
  row can only be isolated or shown with the rest.
- *Speed.* The 75th percentiles pass, on a loaded machine, on Explore, with outliers above
  the limits as listed.
- *Narrow and zoom.* 200% zoom was not tested as such.
- *Screen reader.* Roles, names and live regions were checked with axe and by reading the
  markup, not by listening.
- *Dialog.* Settings is a dialog although one can continue without answering it; the Dialog
  guideline would prefer editing in place. There is no scrim.
- *Layout shift, one case.* The first visit to a backend that is not the mock gives back the
  space reserved for the mock banner, which moves the page once.
- *Detail.* An empty reserved line sits under the panel head when nothing is waiting.

**Design review verdict:** <!-- approve / approve with changes / reject, by a reviewer who did not write the change; findings against design-system/project/review.md -->
