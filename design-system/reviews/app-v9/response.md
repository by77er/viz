# The app on design system v9

**Status: awaiting re-review.** The independent review of 2026-11-27 (`review.md`) rejected
the app: three blockers, three majors, thirteen minors. This file is the author's answer to it,
finding by finding, for the next reviewer. **B1 is not answered here**: it is in progress
separately (the design system's chart, by another builder), and nothing below claims it; by
the rubric the app cannot be approved while it stands. Everything else the review required
(its "Required before the next review", 2 to 7) is done and verified on one tree, below.

Below that, from "The change as first reviewed", is the account the first reviewer read, kept
as it was except where it described images, waits or states that this round changed (each such
place says so).

## The second review: disposition

Checks are in `app/e2e/app.cjs` (sections `review2`, `reload`, `touch`) and
`app/e2e/dashboards.cjs` (`reload`, `narrow`) unless named otherwise; each fix is undone by a
mutant on a copy of the app outside the tree, and the checks named must fail
(`app/e2e/measurements/mutants-review2.txt`). Images are `compare/app-v9-<state>-<width>-<theme>.png`.
The detail of each cause and fix is in `app/README.md`, "The second design review: fixes".

| Finding | Disposition | What a person sees now | Evidence |
|---|---|---|---|
| **B1** a result with many series is painted late | **In progress separately** (the design system's chart). Not worked on here; nothing claimed | (unchanged by this round) | none from this round |
| **B2** "Show 50 more of 200" takes a tap on 34.5 px of 44 | **Fixed** | What follows the table (the shared labels, the button) is a `vz-stack` with it, `space-4` clear of the last row: the whole 44 px is the button's, with either pointer | A tap 16 px above and 16 px below the button's centre each show 50 more, at 400, 320 and 1500 px with a coarse pointer; the page's hit-area measure passes with the table of 200 in it. Mutant "no stack": killed. Image `touch-table-200-show-more` (every hit area outlined; `shots.mjs` reports the button 148.8 x 42.5 px before and nothing after). **Same row, the system's:** the chart legend's "Min" sort head is 43 px wide at 1500 px with a coarse pointer on every dashboard with a chart; `dashboards.cjs` counts it (6, 1 and 4 on the three dashboards) and fails on anything else, which a mutant shows (a panel's links out of `vz-links`: killed by the 1500 px check). A follow-up for the system's owner |
| **B3** a reload lands at the top | **Fixed** | A reload (or a return through the history to the same address) lands where the page was, in the first frame tall enough to hold it, and holds there for 1 s; the person's first wheel, touch, pointer or key ends it. A link opened afresh starts at the top | Four pages (the chart of 36, the table of 200, Explore signed in, Help) at 1500 and 400 px fine and 400 px coarse (coarse in Blink, not touch emulation): same position, anchor within 1 px (0 in every case), shift 0.0000; two dashboards and the list (landed 0 px off). In place before a late answer; a wheel meanwhile not undone; a reset made 150 ms after landing undone (added in this round: without it, "placed once, not held" survived). Six mutants: all killed |
| **M1** the palette opens only by keyboard; "Copy a link" had no control | **Fixed** | "Copy link", a small button in Explore's page head; says "Copied" or "Could not copy". Help says the palette lists the page's commands and that each is also a control | All 19 commands the palette lists on Explore matched to a visible control; Copy link copies the address with the form shown. Three mutants killed. Images: every Explore pair's head (e.g. `explore`, `command-palette`) |
| **M2** the text form and the chart's name leave out the day and the warning | **Fixed** | The name and the text form's first line say "18 Nov, 09:30 to 12:30" as the head does (also zoomed, and under "The latest query failed"); with a warning the name ends "The API sent a warning: the result may be incomplete." and the text form's second line is the head's sentence; the next whole answer removes both | `review2` (7 checks) and unit cases in `charts/spec.test.ts`. Five mutants killed. Image `partial-answer` |
| **M3** five designed states not imaged | **Fixed** | | `partial-answer`, `waiting-10s-alternative`, `stopped-at-60s`, `busy-asking-again`, `api-unreachable`, and `sign-in-api-unreachable`: both themes, 1440 and 400 px, each with the build before except the last (that build had no sign-in) |
| Required 7: images from the final build | **Done** | | `compare/` remade 2026-11-28 from the build this file reports on: 196 pairs ("Images", below) |
| m1 empty head's range | **Fixed** | "18 Nov, 09:30 to 12:30 · every 15 s · …" | `review2`, unit `rangeWords`; mutant killed; image `empty` |
| m2 Step placeholder "30 s" | **Fixed** | No placeholder; the help line says the step in use | `review2`; mutant killed; image `explore` |
| m3 Tab stops on the palette's list | **Fixed** | Tab leaves the field for the next control, not the list | `review2`; mutant killed |
| m4 "Copy a link" says nothing; placeholder names a command | **Fixed** | The command presses Copy link, which takes the focus and says "Copied"; the field has no placeholder | `review2`; two mutants killed; image `command-palette` |
| m5 the table's "< 1" | Follow-up | | A decision for the system's Number rules (the table's own precision) |
| m6 Table, Text, JSON after a failure | Follow-up | | More than a few lines; one rule for the Unit select is needed first |
| m7 320 px: legend label dropped; empty band; tenant breaks | Follow-up | | The legend is the system's chart; the kept place is not decided here |
| m8 Other cannot be closed | Follow-up | | The system's chart |
| m9 the address does not carry the colour map | Follow-up | | The system's algorithm, and a question for its owner |
| m10 sign-in checkbox label | **Fixed** | "Show the key" | `review2`; mutant killed; images `no-key`, `key-refused` |
| m11 a range across midnight in the head | Follow-up (half) | Where the page writes a range (a result with no series) both days are said; the chart's own head does not | Unit `rangeWords` |
| m12 an unreachable API raises no banner and nothing asks again | **Fixed** | A query that gets no answer asks the probe again at once; if that fails the banner shows and the probe is asked every 10 s; when it answers, the failed query is asked again by itself. A query that fails alone is not repeated | `review2` (banner within 5 s; asked again 10.4 s after the API came back; 2 requests while it was away); three mutants killed; image `api-unreachable`. The banner is inserted above the page, so the page moves down when it appears (as before) |
| m13 15 px fields with a coarse pointer | Follow-up | | Needs a device |

**Found by this verification, not by the review:** "Show 50 more" to 100 rows painted is over
its 100 ms budget at p75, by 2 ms (desktop) and 5 ms (phone) ("Speed", below). The fix did not
change that path's code; it was not measured before the fixes and is not tuned here. It is a
follow-up in `app/README.md`.

### Suites, on one tree

@@SUITES@@

### Mutants

@@MUT@@

### Images

`compare/` holds **196 pairs** (15,351,182 bytes, 14.6 MiB), made 2026-11-28 08:14 to 08:45
UTC by `app/e2e/v9-shots.cjs` from the final build and from commit `5db517f` built again
(whose assets came out byte for byte as the 26 Nov build's). The same mock, data (the fixed
window 18 Nov 2026, 09:30 to 12:30 UTC) and steps for both. 26 pairs are new since 26 Nov
(the six states above and `touch-table-200-show-more`); none was dropped. "New view: nothing
to compare" (the build before could not reach the state): `time-range-not-read`,
`signed-out`, `sign-in-api-unreachable`. Stored with a palette that holds every token colour
exactly, then recompressed losslessly (oxipng; each file checked pixel for pixel). Measured
by `shots.mjs` on the after build at 400 and 320 px with a coarse pointer: sideways overflow
0 px; one hit area under 44 px per image, the query editor's inner box (22.8 px tall, inside
the 44 px well; the first review settled that it is its box and not what a finger gets).
Looked at one by one: two (`stopped-at-60s-1440-light`, `partial-answer-1440-dark`).

### Speed of the two paths this round touched

**Measured here** (Chromium on this machine, 4x CPU, Fast 4G, 20 runs at each layout, p75
(median, worst), load read at every run's start, 2026-11-28 09:10 to 09:19 UTC; after only):

| Path | Budget | Desktop | Phone | Within? |
|---|---|---|---|---|
| "Show 50 more" to 100 rows painted | 100 ms | 102 (77, 117) | 105 (93, 192) | **no** |
| "Copy link" to "Copied" painted | 100 ms | 46 (43, 62) | 59 (56, 78) | yes |

Load at run start: desktop median 2.0 (1.4 to 2.2), phone 1.6 (1.4 to 2.0), on 4 cores; all
40 runs judged. Nothing here was measured on Cloudflare or a device. The speed of a result
with many series is B1's and is not measured by this round.

### What this round did not do

- B1 (above). m5 to m9, m11's chart half and m13: follow-ups, listed with reasons in
  `app/README.md`.
- No device, Safari or Firefox; no screen reader by ear; `e2e/real.cjs` and
  `e2e/contract.cjs` (the real API) were not run again (no source on the API path changed).
- Of the 196 pairs, two were looked at one by one.

## The change as first reviewed

What follows is the account the first reviewer read (2026-11-27), describing the move to v9.
Where it described the images, or states then not imaged, it is updated and says so; its
check counts and speed tables are of that state.

- Change: the web app (`app/`) moved from design system v4 to v9, made servable in production
  behind the gateway, with sign-in by API key. Scope: the Explore view that existed, Help and
  Settings. No dashboards or monitors screens.
- Author's sentence (method.md): *someone on call who holds one of the tenant's API keys is
  asking a metrics question in PromQL, and wants to read the answer (which series, how large,
  when it changed) and narrow the time range until they see it, on a laptop or a phone.*
- The earlier review of this app: `../app-restyle/review.md` (reject: three blockers, eight
  majors, eleven minors), whose logic findings were fixed in `../app-restyle/fixes/FIXES.md`.
  Every one of its findings is listed below with its state on this build.
- Running view: `cd app && npm run build && npm run mock` and `npx vite preview` (port 8820;
  the mock needs no key), or `npx tsx mock/server.ts --port 8841 --require-token <key>` and
  `VIZ_API_TARGET=http://127.0.0.1:8841 npx vite preview --port 8840` for sign-in.
- Design system: untouched. What the app needs from it and does not have is in
  `app/README.md`, "Needed changes in the design system" (fifteen items), and summarised
  under "What is not the system's" below.

## What changed on screen, and why

| Where | Before (the app as it was, built on v9's stylesheet) | After | Why |
|---|---|---|---|
| The chart | uPlot canvas drawn by the app; labels on the plot; a floating readout that followed the pointer; the app's own legend | The design system's chart (`viz-chart.js`): SVG plot, direct labels in a gutter with leaders, the readout as one line in the foot, Zoom in and Zoom out in the foot, the legend as a table of toggles, a legend note | The Chart rules are the system's and are tested and audited there. A second implementation in the app produced the first review's chart findings (M1, M2, M4, M5, M7) |
| Past eight series | Eight coloured, the rest listed under one legend row and not drawn | Eight coloured, the rest ONE band (lowest to highest) and one legend row that opens 20 at a time; up to three members picked out in ink | Chart, "Series colour", 6 and 8 |
| Colours | Slots in palette order as series appeared; survivors kept | The system's map: by size on first sight, kept while a series stays on screen, an open slot to the largest series in Other; "Colour the eight largest" offered only when one of the eight largest is not coloured | Chart, "The algorithm"; D73 |
| Waiting | A line of its own between the head and the plot, its space reserved | The waiting line lies over the strip above the plot, right of the value axis (over a table's caption in the table form); nothing is reserved, nothing moves | Panel, "Where the waiting line sits"; the first review's M8 |
| An error after a result | The result was removed; the error stood alone | The message lies over the plot at its height; the legend keeps the previous figures, inert, swatches hollow; the head says "Showing the previous query"; the text form says the latest query failed | Chart, "States" |
| The panel head | Title; range; "per second (/s) · updated now" | Title; "(Showing the previous query ·) 18 Nov, 09:30 to 12:30 · every 15 s · updated just now"; the form of the result (Chart, Table, Text, JSON) as a segmented control in the head; under it one line with the query the data answers | Panel (meta: range, step, age); the form control where the system's fixture has it; the query line because the editor may hold other text than what is drawn |
| The unit | In the head and in each legend column head | Once at the top of the value axis and once in the legend's first figure head ("Last, /s") | Number, "Where the unit goes" |
| Time range | A button opening a menu of ten presets and two browser date pickers; Show earlier, Show later, Zoom in, Zoom out, Reset zoom | Two typed fields, From and To ("18 Nov 09:16", "09:16", "now", "now - 6 h"), with a help line that echoes what was read, its length and the zone; five ranges as one segmented control ("Last 15 min … 7 d"); Show earlier and Show later as small buttons; zoom is the chart's | Field, "Time range" (the first review's m4); Button (`data-size="sm"` in toolbars; M8); Chart (zoom by the foot's buttons) |
| Zoom | A drag or a toolbar button changed the queried range | A drag, the foot's buttons, plus and minus zoom within the result; "Query the chart's range" appears beside Show later while the chart is zoomed and asks the API for that range | Chart: "Never past the data". The button keeps what a drag used to do; its place is kept so nothing moves |
| Step | Placeholder "auto, 15 s" | Empty field; help line "Empty: automatic, now 15 s." or "One value every 1 min." | Field: a placeholder shows an example, never a value |
| A change of form on a scrolled page | (the form control was on the first screen at both widths) | The page stays where it is. On a phone the result's forms are now below the first screen, and for a while in this change every tap on Table, Text or Chart threw the page back to the top 300 ms later, when the address followed (the router's default); found by the speed runs, fixed, and checked at 400 px | A view change must not move what the person is looking at |
| Table form | Caption sentence; rows in label order | Caption "4 of 4 series, highest value first. The latest value of each, at 18 Nov 12:30."; opens highest first; figures in the chart's unit and number format; shared labels in a line under it | Table, "Caption"; Number (one precision per result) |
| Text form | The app's digest in a code well (last, min, max, mean, trend) | The chart's own text form (the same model as the plot, the legend and the readout), as a list of sentences | Chart, "Text form" |
| Start | An empty state with examples in a two-column list | First run: "No query yet", what will appear, two steps, example links as a list of standalone links | FirstRun |
| Page | A hidden h1; a toolbar | Page head "Explore"; a stack: query and Run query, the range row, a grid of three fields | Layout: a page starts with `vz-page-head` |
| Navigation | Explore, Help; Commands and Settings as quiet buttons | Explore, Help; the tenant (text) and Settings (a link) at the right | Nav. The command palette opens with Ctrl K and from a button on Help |
| Settings | A dialog: API base URL, bearer token (kept in localStorage), theme, Test connection | A page: whose key this is, Sign out, theme, the API's address and version | Dialog: "Use it only when the person cannot sensibly continue without answering" |
| Sign-in | None: a banner and an error state told the person to open Settings | A form in Explore's place: what is missing, one field, what happens to the key, Sign in (the page's one blue button) | The app is to be served to people who have only a key |
| The mock's banner | Its space reserved while the backend was being identified | Shown from the first frame (the mock says what it is with the key's identity), without its version | Nothing reserved, nothing moves |
| Words | "updated now"; "one point every 15 s" | "updated just now"; "every 15 s"; "Waiting for the query." | Number, "Age of data" |
| Touch | Legend rows and inputs at fine-pointer sizes in places; the query well 32 px | Everything a system component: 44 px hit areas, the well 44 px with body-size text | Every form factor |

## The first review's findings, on this build

"Check" names the check in `app/e2e/app.cjs` (130 checks, all passing) or the image under
`compare/` (`app-v9-<name>-<width>-<theme>.png`). "By the system" means the fix is the design
system's component, which the app now uses, not code of the app's.

| Finding | State | How it is now, and where it is checked |
|---|---|---|
| **B1** old data under the new query's unit and name | Fixed earlier (logic); **verified again** on the new chart, and extended | The panel's title, query line, range, step, age, the legend's unit, the axis unit, the chart's accessible name, the unit select and the text form all come from the result on screen; the head says "Showing the previous query" while waiting, after Cancel, after the 60 s stop and after an error. Checks "B1 waiting", "B1 cancelled", "B1 settled", "B1 after an error" (9 checks); mutants; images `waiting-previous-query`, `cancelled`, `error-after-a-result` |
| **B2** the query editor below the touch size | **Fixed** (by the system, and one app change) | The well is `vz-query`: 44 px tall with body-size text on a coarse pointer; the editor now inherits the well's type instead of setting its own. Check "B2"; image `touch`. Open: the system's body size is 15 px, and iOS Safari is understood to zoom a focused field under 16 px (README, need 9; not checked on a device) |
| **B3** typing budget missed and not measured | Fixed earlier; **verified again and measured** | A keystroke renders no React component (check "B3"); typing is measured key by key at both layouts ("Speed") |
| **M1** direct labels on the wrong line, colliding at 400 px | **Fixed** by the system | Labels in the right gutter, each joined by a leader to its own line's end, within two lines of it, or none; none below 640 px. Check "M1" (each label's leader starts at its own line's end); images `explore`, `gap`, `p95-seconds` |
| **M2** colour order and Other | Fixed earlier (logic); now **the system's algorithm** | Largest first into slots 1 to 8 on first sight; kept while on screen; Other is one band and one legend row; "Colour the eight largest" per D73. Checks "M2" (4), "D73" (3); images `many-series-36`, `many-series-200`, `other-opened` |
| **M3** Cancel drops keyboard focus | Fixed earlier; **verified again** | Focus goes to Retry. Check "M3"; the keyboard walk never reaches the body |
| **M4** touch cannot do what the pointer can | **Fixed** (the readout, by the system; the rest earlier, now the system's) | A tap toggles a legend row; Zoom in and Zoom out are buttons in the foot; the readout is a line under the plot. Checks "M4" (3), by touch events; images `touch`, `crosshair-36-400` |
| **M5** long label sets hide what distinguishes them | **Fixed** by the system, with one difference | Rows show the labels that differ, most distinguishing first, the same labels on every row, cut in the middle; shared labels once in the note; at 400 px the Name and Last columns stay. The full label set is the row's title and accessible name; it does not wrap onto a second line (the chart's rows are one line by rule: reserved height). Checks "M5", "M1, M5" at 400 px; images `gap`, `many-series-36-400` |
| **M6** pressed state missing on three control types | **Fixed** by the system | `pressed` on legend rows, sortable heads, small buttons and segments, painted from `pointerdown` by `viz-press.js`. Check "M6" (a held finger, four controls); image `legend-row-pressed` |
| **M7** units | Fixed earlier; now **the system's number format** | Unit once on the axis and once in the legend head; bare ticks and cells in one precision; one binary unit and binary-round ticks for bytes; cores in one scale. Checks "M7" (4); images `bytes`, `gap`, `p95-seconds`, `no-unit` |
| **M8** the toolbar outranks the chart | **Fixed** | Show earlier and Show later are small buttons; zoom left the toolbar; the waiting line reserves nothing; the form control is in the panel head. Check "M8"; image `greyscale` |
| m1 "returned in 118 ms" | Fixed earlier; verified | With the JSON form. Check "m1" |
| m2 the table's "At" column | Fixed earlier; verified | Said once in the caption. Check "m2" |
| m3 words | **Fixed** | "updated just now" under 5 s (the system's words); the range is in the head; steps and ranges read "15 s", "1 min"; after 10 s the wait offers "Show the last 1 h" as a control |
| m4 browser date inputs | **Fixed** | Typed fields in the system's forms, echoed, zone stated once. Check "m4"; images `time-range`, `time-range-not-read` |
| m5 centred range button | Gone | There is no range button |
| m6 the chart announces three series and does not say so | **Fixed** by the system | The plot's name says how many series and how they are drawn; an arrow key announces the time and the highest series by name. Check "m6" |
| m7 every segment and legend row a tab stop | **Half**: the legend is one tab stop with arrow keys (the system); a segmented control is still one stop per segment (the system defines no arrow keys for it; README, need 12). Check "m7" |
| m8 ring clipped on the last legend row | **Fixed** by the system | Drawn inside the row by its cells. Check "m7, m8"; image `legend-row-focus` |
| m9 Settings' gap and missing scrim | Gone | Settings is a page; the only dialog is the command palette, on the scrim. Check "m9" |
| m10 the palette's field has no visible label | **Fixed** | "Command". Check "m10"; image `command-palette` |
| m11 the 10 s and 60 s waits not imaged | **Checked; imaged since 2026-11-28** (`waiting-10s-alternative`, `stopped-at-60s`) | `VIZ_SLOW=1 node e2e/app.cjs`: the control at 10 s and the stop at 60 s |
| Leftovers named in "The six questions" | Gone | Hashed colours, the per-series legend, full-height toolbar controls, date pickers, "15s", the "At" column, the dashed crosshair, Settings as a dialog |

## Presence test

| Element | The question it answers |
|---|---|
| Navigation: Explore, Help | Where am I, and where is the manual |
| Navigation: the tenant | Whose data is this (the key decides it; there is no switch, so it is text) |
| Navigation: Settings | Where do I sign out or change the theme |
| Mock banner (development only) | Is this real data |
| "Explore" | What page is this (the page head the Layout rules ask for; the navigation marks it too) |
| Query well | What am I asking |
| Run query | Ask it (the one blue button) |
| "Last" 15 min to 7 d | The ranges people ask for most, one press away; which one is in force |
| Show earlier, Show later | Move the window without typing (anything a drag does has a button) |
| Query the chart's range (only while zoomed) | Fetch what I zoomed into, at a finer step |
| From, To, and their echo | Exactly which time, read how, in which zone |
| Step, and its echo | At what resolution; what "automatic" is now |
| Unit | In what unit, when the guess is wrong |
| Panel title "Query result", with the query for a screen reader | What region is this, and of what |
| Meta: the note, range, step, age | Is this the answer to what I asked; of when; how old |
| Chart, Table, Text, JSON | In which form |
| The query line | Which query the data on screen answers (the editor may say otherwise) |
| The strip, the unit, the plot | The answer |
| Readout | The value at this time, for the nearest and the highest series |
| Zoom in, Zoom out | Look closer without a drag |
| Legend rows and figures | Which line is which, and how large |
| Legend note | What every series shares; how the colours were chosen |
| Table caption | How many rows of how many, in what order, at what time |
| Sign-in: title, sentence | What is missing and what to paste |
| Sign-in: the field's help | What happens to the key |
| Sign-in: "The key is shown as typed" | Let me check what I pasted |

Removed by the test: the Commands button in the navigation (every command has a control, and
the shortcut is on Help), Reset zoom (Zoom out until it is disabled), the legend's hint
sentence about Shift, the "returned in" line, the Settings dialog's base URL (the API is the
page's own origin), Test connection (sign-in tests it), the mock's version in its banner
(it is on Settings).

## Reading order

On Explore with a result: (1) the plot's lines, (2) the legend's names and figures, (3) the
head's range and age. Run query is the one colour outside the chart and is meant to be found
when looked for, not first. See `compare/app-v9-greyscale-light.png`.


## What is not the system's

No token and no component class was added, and `design-system/` was not edited. The app's own
CSS is `app/src/app.css`, 12 rules: the body's margin; the query well around an editor (its
width, and the ring when the editor inside has focus); the result's query on one line; a
parked chart; the waiting line's left edge when the chart is not the panel body's own child;
the JSON well's height; keyboard hints side by side; a cell that wraps; the command palette's
dialog and its scrim; a place kept for something not shown (`.is-reserved`). The editor's
theme (`src/editor/PromqlEditor.tsx`) is tokens only.

Around the system's chart the app does five things the chart does not do for an application
(`src/charts/Chart.tsx`, `fixups.ts`; README, needs 1 to 5): it moves the chart's UTC clock to
the device's zone; it rewrites "every 0.25 min, <aggregate>" in the text form to "one value
every 15 s"; it removes the comma before a missing unit; it gives a legend row an accessible
name that holds the words the row shows (WCAG 2.5.3) and puts a space between Other's two
words; it puts its own error message into the chart's error state. The reviewer may want to
judge those as changes to what the system's chart shows.

New compositions, from existing components only:

- **Sign-in**: FirstRun's block (`vz-start`: a `vz-section-title` that says what is missing,
  one sentence), a Field, a `vz-check`, a `vz-controls` with the blue button, and a Notice
  under it when the key could not be checked. The system has no sign-in pattern (need 13).
- **The range row**: a `vz-label` ("Last"), a `vz-segmented`, two small buttons, and a third
  whose place is kept, in one `vz-controls`.
- **The fields row**: the Field preview's own grid (`vz-dashboard` > `vz-grid`): the time range
  `fieldset` (span 6; its legend is for a screen reader only, so that From, To, Step and Unit
  share one line of labels and one line of inputs), Step (3), Unit (3).
- **Settings**: a page of three sections: a `vz-kv`, a segmented control, a `vz-kv`.

## Checks

| Check | Result |
|---|---|
| `node design-system/tools/check.mjs --no-render app/src app/index.html` | contrast and structure 759/759; **0 literal values** in 58 files (it failed on four before this change) |
| `npm test` (in `app/`) | 168 tests in 15 files pass |
| `npx tsc --noEmit` | passes |
| `npm run build` | passes; the shell script is 146.0 kB compressed (limit 200 kB) |
| `node e2e/app.cjs` | 130 of 130 checks pass (132 of 132 with `VIZ_SLOW=1`, which adds the 10 s and 60 s rows of the waiting table) |
| `node e2e/errors.cjs` | 14 of 14 |
| `node e2e/prod.cjs` (the build served as the gateway is to serve it, the app driven under the content security policy) | 19 of 19 |
| `node e2e/real.cjs` (the real API under `wrangler dev --local`: sign-in against control, the same data read as on the mock) | 15 of 15 |
| `node e2e/contract.cjs` (mock against real API) | 82 of 82 |
| axe-core 4.14 | 0 serious or critical violations in 17 runs (both themes; the chart at 400 px with touch; sign-in; Settings) |
| Mutants (`e2e/mutants.cjs`, on a copy outside the tree) | 60: first run (58) 53 killed, 5 survived; all answered; two added; run again on the final source, 60 of 60 killed (`app/README.md`, "Mutants of this change") |

## Images

*(Updated 2026-11-28: `compare/` was made again from the final build, 196 pairs; see "Images" under the disposition at the top. The table of states below is the same with the additions marked.)*

`compare/` is made by `app/e2e/v9-shots.cjs` through
`tools/shots.mjs` scenarios and `shots.mjs compare`: left, the app as it was (commit `5db517f`,
built against the same v9 stylesheet, which is what a build of it gives today); right, this
change. The same mock, the same data (the fixed window 18 Nov 2026, 09:30 to 12:30 UTC), the
same steps. Names are `app-v9-<state>-<1440|400>-<light|dark>.png`; states taken at one size
have no width in the name. Pairs are stored with a palette that holds every token colour
exactly. The single images are not kept (each is half of a pair); the scenario files that
made them are written beside the work directory by the script.

| States | Names |
|---|---|
| Views by address | `explore`, `many-series-36`, `many-series-200`, `gap`, `bytes`, `p95-seconds`, `no-unit`, `one-series-no-labels`, `table`, `table-36`, `text`, `json`, `empty`, `error`, `error-step-too-small`, `start`, `help`, `settings` |
| What a person does | `crosshair` (1440), `crosshair-36`, `legend-row-chosen`, `legend-row-focus` (1440), `legend-row-pressed` (1440), `other-opened`, `zoomed-in`, `command-palette`, `time-range`, `time-range-not-read` (after only), `focus-run-query` (1440), `focus-query-editor` (1440), `error-after-a-result` |
| Waiting | `waiting-1s`, `waiting-cancel-offered`, `waiting-previous-query`, `cancelled`, `first-result-waiting` (a reload with the answer 2.5 s late); added 2026-11-28: `waiting-10s-alternative`, `stopped-at-60s`, `busy-asking-again` |
| Added 2026-11-28 (the second review's M3, B2) | `partial-answer`, `api-unreachable`, `sign-in-api-unreachable` (after only), `touch-table-200-show-more` (400, coarse; every hit area outlined) |
| Touch, zoom, greyscale | `touch`, `touch-table`, `touch-hit-areas` (36 series; every hit area outlined), `touch-320`, `zoom-200` (200%: 720 px at twice the scale), `greyscale` |
| Sign-in, on an API that needs a key | `no-key`, `key-refused`, `key-without-read-scope`, `signed-in`, `settings-signed-in`, `signed-out` (after only) |

In "before", the sign-in states are what that build did with the same key in its Settings
(a banner and an error state); `settings` is its dialog, `time-range` its menu.

Measured by `shots.mjs` on the after build (`measure`): at 400 px and at 320 px with a coarse
pointer, sideways overflow 0 px, smallest text 11 px (`micro`), every hit area at least 44 px
(21 to 33 measured per image; on 2026-11-28 the measure also reports the query editor's inner box, 22.8 px tall inside its 44 px well, in each image), none covered, no drawn box reached by a neighbour's hit area,
no link inside a sentence; at 200% zoom, overflow 0 px.

Not imaged: hover states of single controls (they are the system's). (The 10 s and 60 s rows,
the "API does not answer" banner and the sign-in form when the API could not be asked were
not imaged on 27 Nov; they are since 2026-11-28.)

## Speed

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

### What the phone runs found: the page jumped to the top

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

#### 4 series (sum by (service) (rate(http_requests_total[5m]))), phone

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

#### 36 series (sum by (service, route, status) (rate(http_requests_total[5m]))), phone

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

#### 200 series (viz_synthetic_series), phone

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

### Desktop (run B)

At 1440 x 900 every target of a run is on the first screen (Run query at 200 px, the form
control at 408 px, the first legend row at 741 px; measured), so a desktop run never scrolls
and the jump could not act in it. The table's rows were prepared at the change to the table
in this build; the final build prepares them in idle time (next section), which moves
"Chart to table" and "Response to paint" and nothing else.

#### 4 series (sum by (service) (rate(http_requests_total[5m]))), desktop

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

#### 36 series (sum by (service, route, status) (rate(http_requests_total[5m]))), desktop

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

#### 200 series (viz_synthetic_series), desktop

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

### When the table's rows are prepared (the final build is the third column)

Run A prepared the rows with every result; a profile showed 10 ms of the result's first
paint going to them at 200 series (4x CPU), so they were moved to the change to the table,
and run B then showed "Chart to table" slower by 10 to 30 ms and over 100 ms at 200 series.
Three variants of the same build were then measured alternating, four rounds of five runs,
desktop, typing and crosshair left out: with every result; at the change to the table; in
idle time after the result is painted (`requestIdleCallback`, at once if the table is asked
for first). Not tried: scheduling the idle work after the frame that paints the result (an
idle callback can run before that frame).

#### 36 series (sum by (service, route, status) (rate(http_requests_total[5m]))), desktop

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

#### 200 series (viz_synthetic_series), desktop

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

### What is met and what is not

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

### A typed step (run B's build, five runs each: an indication, not a judgment)

One second over three hours is 10,801 samples a series, more than the chart has pixel
columns (four series):

#### 4 series (sum by (service) (rate(http_requests_total[5m]))), desktop

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

#### 36 series (sum by (service, route, status) (rate(http_requests_total[5m]))), desktop

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


## What is not done

- **Awaiting re-review** (this document's status). **Not deployed**: the gateway's part is specified
  in `app/README.md` ("Needed changes in deploy/") and checked locally by `app/e2e/prod.cjs`;
  nothing was deployed.
- Dashboards and monitors screens, logs, traces: not built (out of scope).
- **Speed on the final build**: measured only at the desktop layout for 36 and 200 series, in
  one tuning run on a busy machine; the phone layout of the final build is not measured, and
  no thin-margin row was taken again ("Speed").
- The images were made again from the final build on 2026-11-28 (top of this file).
- m7, second half: a segmented control is one tab stop per segment (need 12).
- B2's remainder: body size is 15 px (need 9).
- A shared link does not carry the colour map (need 11).
- More samples than pixel columns are drawn as they are (need 6; "Speed", the typed step).
- A window that spans a clock change shows times before the change an hour off on the chart
  (need 1).
- Not checked: Safari and Firefox, real touch hardware, a screen reader by ear, enlarged
  text as distinct from zoom, a deployed viz.
