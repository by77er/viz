# Density of dashboards and controls: investigation and proposal

Status: **proposal, not implemented in the product.** Prototypes were built in a scratch worktree
(detached at `683f9bf`); nothing under `app/` or `design-system/` other than this directory was
changed. Date: 2026-11-28.

## 1. The question

The owner asked: *investigate improving the density of dashboards and controls while remaining
intuitive.*

The sentence from the method: **someone on call opens a service's dashboard (or Explore) and wants
to read, panel by panel, whether it is healthy over a time range, and change the range or a
variable to look closer.** Density is judged against that person: more of the data in the first
screen and fewer screens to scroll, without hiding what a first-time reader needs, and without
giving up anything the v9 reviews made the system promise (44 px targets that take the tap, every
command reachable by pointer, keyboard and finger, a text form, no colour-only meaning, a reload
that keeps its place, the speed budgets).

Background research, with sources and how far each claim is trusted:
`research/13-dashboard-density.md`.

## 2. How this was done

- **Builds.** The app's production build (`vite build`) served by `vite preview` on the app's own
  mock (`app/mock/`), one build per option, all from the same worktree and mock. Fixed range
  18 Nov 09:30 to 12:30 UTC (the e2e suites' window).
- **Layouts.** 1440 x 900 with a fine pointer (mouse); 400 x 800 with a coarse pointer made coarse
  in Blink by `--blink-settings` with `isMobile` (as `tools/audit.mjs` does for its reload pass), so
  every `@media (pointer: coarse)` rule applies across navigation. Images in both themes.
- **Views.** Explore with a 4-series result (`sum by (service) (rate(http_requests_total[5m]))`) and
  a 36-series result (`sum by (service, route, status) (…)`); the dashboards list; the 12-panel
  "Services overview"; "Service: rate, errors, duration" with Service = orders, Status = 500.
- **What is counted** (script: `tools/measure.cjs` beside this file, run in the page at scroll 0):
  - *first data mark*: the top of the first plot (`svg.vz-plot`, which includes the plot's strip),
    stat figure or data-table row, from the top of the document;
  - *panels fully in the first screen* and *begun in it*; *page height* (`scrollHeight`);
  - *data share*: the area of plots, stat figures and data-table cells inside the first screen,
    over the screen's area; *legend share* likewise for the chart legends' cells;
  - *control rows above the first panel* (controls outside the navigation, grouped by their
    vertical centre), *tab stops* from the top of the page to the first focus inside a panel
    (real Tab presses, fine pointer only), *controls in the first screen*;
  - *per-panel chrome*: head, description, foot (text form and links), legend, and the data
    itself (plot, figure or table body), from each panel's boxes.
- **Kind of number.** Every figure in this file is **measured here** (this machine, headless
  Chromium, the mock), unless it says otherwise. The development mock shows a banner on every
  page (about 70 px at 1440 and 110 px at 400, measured from the images); it is in every build
  alike, so it shifts every "first data mark" equally and cancels in comparisons.
- **Tools beside this file** (`tools/`): `measure.cjs` (section-1 measurements and the
  first-screen and whole-page images), `states.cjs` (opened states, focus, and the timings of
  section 7), `compose.py` (side-by-side images, reduced to a 128-colour palette to keep this
  directory small: series colours in them are close to, not exactly, the tokens), `table.py`
  (the tables below from `measurements/*.json`). They name the scratch worktree's path at the top;
  change it to run them elsewhere. Every browser run was made under the shared machine lock, with
  the Cloudflare variables removed from the environment.

## 3. The baseline (v9 as it is)

Measured here, 18 Nov 09:30 to 12:30 on the mock; full table with every view in section 4.

| View | Layout | First data mark | Page height | Panels fully in first screen | Data share of first screen | Control rows above first panel | Tab stops to first panel | Controls in first screen |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Explore, 4 series | 1440 fine | 473 px | 900 px | 1 of 1 | 22% | 5 | 19 | 33 |
| Explore, 36 series | 1440 fine | 473 px | 1,038 px | 0 of 1 | 22% | 5 | 19 | 36 |
| Explore, 4 series | 400 coarse | 885 px (below the screen) | 1,407 px | 0 of 1 | 0% | 9 | n/a | 19 |
| Explore, 36 series | 400 coarse | 885 px | 1,703 px | 0 of 1 | 0% | 9 | n/a | 19 |
| Dashboards list | 1440 fine | 341 px | 900 px | (4 rows, all) | 17% | 0 | 7 | 11 |
| Dashboards list | 400 coarse | 481 px | 991 px | | 30% | 0 | n/a | 10 |
| Services overview (12 panels) | 1440 fine | 537 px | **3,335 px** | 4 of 12 | 10% | 4 | 17 | 27 |
| Services overview | 400 coarse | 793 px | **8,173 px** | 0 of 12 | 1% | 6 | n/a | 17 |
| Service RED (5 panels, 2 variables) | 1440 fine | 499 px | 1,695 px | 1 of 5 | 17% | 4 | 22 | 26 |
| Service RED | 400 coarse | 865 px (below the screen) | 3,631 px | 0 of 5 | 0% | 8 | n/a | 22 |

The page heights of "Services overview" agree with `app/README.md` (D9: 3,335 and 8,173 px).

**Where the height goes** (Services overview, median per kind of panel, px):

| Layout | Kind | Panel | Head | Description | Foot ("Text form", "Open in Explore") | Legend | Data (plot, figure or table body) | Chrome share |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1440 fine | stat (4) | 234 | 20 | 27 | 44 | 0 | 48 | 79% |
| 1440 fine | time series (6) | 668 | 20 | 18 | 44 | 209 | 200 | 70% |
| 1440 fine | table (2) | 464 | 20 | 18 | 68 | 0 | 192 | 59% |
| 400 coarse | stat (4) | 251 | 20 | 27 | 88 | 0 | 48 | 81% |
| 400 coarse | time series (6) | 843 | 20 | 36 | 88 | 370 | 220 | 73% |
| 400 coarse | table (2) | 484 | 20 | 18 | 132 | 0 | 192 | 61% |

What the baseline says, in plain terms:

- **Above the first panel** a dashboard spends four rows of controls at 1440 (Panels/Text and
  Refresh; the facts line; the five presets with Show earlier and later; From and To with the
  "Read as" line) and six at 400. At 400 the first data mark is below the first screen on every
  view except the list.
- **A stat is 79–81% chrome**: a 48 px figure under a title, a two-line description, a context line,
  a state line, "Text form" and "Open in Explore".
- **A chart's legend is as tall as its plot** (209 px median at 1440 against a 200 px plot; 370 px
  against 220 at 400), also for four series, where the table's Min and Max columns are the only
  thing direct labels and the readout do not already give.
- **The foot of every panel** ("Text form", "Open in Explore") costs 44 px at 1440 and 88–132 px at
  400, twelve times on one page; at 1440 it sits under the legend, usually below the fold.
- In a row of panels, each panel is its own height, so a 4-series chart beside a 36-series one
  leaves a hole under the smaller (image `all-services-1440-fine-light-page.png`, left).

Images: `images/A-<view>-<layout>-<theme>-screen.png` and the B and C pairs all show the baseline on
the left; `images/all-*-page.png` show whole pages of all four builds side by side.

## 4. The options, prototyped against the system

Three options, each a coherent set of changes. B and C include A (A's scale is cheap and keeps
the coarse layout untouched, so measuring B and C without it would only add noise); B and C differ
in one thing: whether a panel's commands and description stay visible (B) or move behind one menu
per panel (C).

### Option A: a fine-pointer scale (system only, no app change)

One step down the spacing scale with a fine pointer, as component variables set on `.vz` (as
`--strip` is), never by redefining a token: between panels `space-6` to `space-4`, between
sections `space-8` to `space-6`, a stack of controls `space-4` to `space-3`, the page's own gap
`space-6` to `space-4`, the gap under a panel's rule `space-3` to `space-2`, and a table row
`row` (32 px) to 28 px. **Nothing changes with a coarse pointer.** Patch:
`patches/system-A-scale-only.diff`.

### Option B: quiet chrome, every command visible (system and app)

- **Dashboard controls in one row** (`vz-bar`): the range as **one button whose words are the
  range as it was read** ("18 Nov, 09:30 to 12:30, 3 h, UTC…", or "Last 6 h · …"), which opens the
  presets and the two typed times (the echo line under them stays); **Show earlier** and **Show
  later** beside it; each variable as a label and its control inline; at the right end
  **Panels | Text** and **Refresh** (small). The revision and "12 panels, all answered" join the
  page head's sub-line.
- **Panel head on one line**: title, meta, and the panel's commands as **quiet small buttons**:
  "Text form" (opens the text form under the body) and "Explore" ("Explore…" with a menu when the
  panel has several queries). The foot is gone. The description stays.
- **Stat**: figure, unit and the state's mark and word on one line ("Within thresholds"), then one
  context line ("Last value at 18 Nov 12:30.").
- **Legend by number of series**: a chart with at most eight series and no Other gets a **list
  legend** (swatch, name, last value; each entry still a toggle; the table's head kept for screen
  readers; Min and Max only in the text form and Explore). Charts with Other keep the table.
- **Explore**: the range button, Show earlier and later, Step and Unit inline, on one row under the
  query.
- Patches: `patches/system-v10-density.diff` (A plus the components) and
  `patches/app-density-prototypes.diff` (both B and C, chosen at build time by `VITE_DENSITY`).

### Option C: one menu per panel, and a sticky bar

B, except:

- each panel has one quiet **"Actions…"** button (accessible name "Actions for <panel>") opening a
  menu: "Show what it is for", "Show the text form", then "Open in Explore" per query;
- **descriptions are hidden** until "Show what it is for";
- **a panel's meta is shown only when the panel differs from the dashboard** (waiting, showing the
  previous range, failed); the bar states the step and the oldest answer's age once
  ("every 30 s · updated just now");
- Show earlier and later move **into** the range popover;
- with a fine pointer the bar is **sticky** at the top of the window, with `scroll-padding-top` so
  a focused control is never under it (WCAG 2.4.11);
- **Explore**: the query, the range button, "Step 15 s (auto) · unit auto…" (a popover with the two
  fields) and Run query on **one row**.

### A user setting "Comfortable / Compact"?

Not prototyped, and not recommended. A setting doubles every state a design must be imaged and
reviewed in (this system already reviews two themes, two pointers and every waiting state), makes
two people's screenshots of the same dashboard disagree, and puts a second set of reserved heights
behind every chart. The input already tells the interface what density it can afford: a fine
pointer can take 24 px targets (WCAG 2.5.8), a finger needs 44 (2.5.5). One density for everyone,
adapted by pointer, gets the benefit without the cost. It would change if people asked for a TV or
wall display mode (Grafana's kiosk): that is a mode with its own purpose, not a density.

## 5. Measurements per option

Measured here, same data, same range, same views as the baseline.

| View | Layout | Build | First data mark, px | Page height, px | Panels fully in first screen | Panels begun in first screen | Data share of first screen | Legend share | Control rows above first panel | Tab stops to first panel | Controls in first screen |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| explore-4 | 1440-fine | baseline | 473 | 900 | 1 of 1 | 1 | 22% | 11% | 5 | 19 | 33 |
| explore-4 | 1440-fine | A | 445 | 900 | 1 of 1 | 1 | 22% | 11% | 5 | 19 | 33 |
| explore-4 | 1440-fine | B | 359 | 900 | 1 of 1 | 1 | 22% | 11% | 4 | 13 | 27 |
| explore-4 | 1440-fine | C | 315 | 900 | 1 of 1 | 1 | 22% | 11% | 3 | 10 | 24 |
| explore-4 | 400-coarse | baseline | 885 | 1407 | 0 of 1 | 1 | 0% | 0% | 9 | n/a | 19 |
| explore-4 | 400-coarse | A | 885 | 1407 | 0 of 1 | 1 | 0% | 0% | 9 | n/a | 19 |
| explore-4 | 400-coarse | B | 653 | 1175 | 0 of 1 | 1 | 17% | 0% | 7 | n/a | 18 |
| explore-4 | 400-coarse | C | 537 | 1059 | 0 of 1 | 1 | 25% | 0% | 5 | n/a | 16 |
| explore-36 | 1440-fine | baseline | 473 | 1038 | 0 of 1 | 1 | 22% | 18% | 5 | 19 | 36 |
| explore-36 | 1440-fine | A | 445 | 1010 | 0 of 1 | 1 | 22% | 20% | 5 | 19 | 37 |
| explore-36 | 1440-fine | B | 359 | 924 | 1 of 1 | 1 | 22% | 24% | 4 | 13 | 33 |
| explore-36 | 1440-fine | C | 315 | 900 | 1 of 1 | 1 | 22% | 24% | 3 | 10 | 30 |
| explore-36 | 400-coarse | baseline | 885 | 1703 | 0 of 1 | 1 | 0% | 0% | 9 | n/a | 19 |
| explore-36 | 400-coarse | A | 885 | 1703 | 0 of 1 | 1 | 0% | 0% | 9 | n/a | 19 |
| explore-36 | 400-coarse | B | 653 | 1471 | 0 of 1 | 1 | 17% | 0% | 7 | n/a | 18 |
| explore-36 | 400-coarse | C | 537 | 1355 | 0 of 1 | 1 | 25% | 0% | 5 | n/a | 16 |
| list | 1440-fine | baseline | 341 | 900 | 0 of 0 | 0 | 17% | 0% | 0 | 7 | 11 |
| list | 1440-fine | A | 325 | 900 | 0 of 0 | 0 | 16% | 0% | 0 | 7 | 11 |
| list | 1440-fine | B | 325 | 900 | 0 of 0 | 0 | 16% | 0% | 0 | 7 | 11 |
| list | 1440-fine | C | 325 | 900 | 0 of 0 | 0 | 16% | 0% | 0 | 7 | 11 |
| list | 400-coarse | baseline | 481 | 991 | 0 of 0 | 0 | 30% | 0% | 0 | n/a | 10 |
| list | 400-coarse | A | 481 | 991 | 0 of 0 | 0 | 30% | 0% | 0 | n/a | 10 |
| list | 400-coarse | B | 481 | 991 | 0 of 0 | 0 | 30% | 0% | 0 | n/a | 10 |
| list | 400-coarse | C | 481 | 991 | 0 of 0 | 0 | 30% | 0% | 0 | n/a | 10 |
| services | 1440-fine | baseline | 537 | 3335 | 4 of 12 | 6 | 10% | 0% | 4 | 17 | 27 |
| services | 1440-fine | A | 505 | 3223 | 4 of 12 | 6 | 15% | 0% | 4 | 17 | 27 |
| services | 1440-fine | B | 439 | 2730 | 4 of 12 | 6 | 23% | 0% | 2 | 11 | 33 |
| services | 1440-fine | C | 398 | 2549 | 6 of 12 | 8 | 23% | 2% | 2 | 9 | 31 |
| services | 400-coarse | baseline | 793 | 8173 | 0 of 12 | 1 | 1% | 0% | 6 | n/a | 17 |
| services | 400-coarse | A | 793 | 8173 | 0 of 12 | 1 | 1% | 0% | 6 | n/a | 17 |
| services | 400-coarse | B | 611 | 6741 | 1 of 12 | 2 | 2% | 0% | 3 | n/a | 15 |
| services | 400-coarse | C | 579 | 6026 | 2 of 12 | 2 | 3% | 0% | 4 | n/a | 11 |
| red | 1440-fine | baseline | 499 | 1695 | 1 of 5 | 3 | 17% | 0% | 4 | 22 | 26 |
| red | 1440-fine | A | 467 | 1639 | 1 of 5 | 3 | 22% | 0% | 4 | 22 | 26 |
| red | 1440-fine | B | 401 | 1258 | 3 of 5 | 5 | 22% | 1% | 2 | 16 | 39 |
| red | 1440-fine | C | 360 | 1165 | 3 of 5 | 5 | 30% | 1% | 2 | 14 | 34 |
| red | 400-coarse | baseline | 865 | 3631 | 0 of 5 | 1 | 0% | 0% | 8 | n/a | 22 |
| red | 400-coarse | A | 865 | 3631 | 0 of 5 | 1 | 0% | 0% | 8 | n/a | 22 |
| red | 400-coarse | B | 651 | 2714 | 1 of 5 | 2 | 1% | 0% | 5 | n/a | 18 |
| red | 400-coarse | C | 637 | 2450 | 1 of 5 | 2 | 1% | 0% | 6 | n/a | 16 |

**The headline, Services overview (12 panels):**

| | Baseline | A | B | C |
|---|---:|---:|---:|---:|
| Page height at 1440 | 3,335 px | 3,223 (−3%) | 2,730 (−18%) | 2,549 (−24%) |
| Page height at 400 | 8,173 px | 8,173 (0%) | 6,741 (−18%) | 6,026 (−26%) |
| First data mark at 1440 | 537 px | 505 | 439 | 398 |
| First data mark at 400 | 793 px | 793 | 611 | 579 |
| Panels fully in the first screen, 1440 | 4 | 4 | 4 | 6 |
| Tab stops to the first panel | 17 | 17 | 11 | 9 |

Service RED: 1,695 px at 1440 to 1,639 (A), 1,258 (B, −26%), 1,165 (C, −31%); at 400 3,631 to
2,714 (B, −25%) and 2,450 (C, −33%); the first data mark comes into the 400 px phone's first screen
in B and C (651 and 637 px) and not in the baseline (865 px). Explore: the first data mark moves up
114 px (B) and 158 px (C) at 1440 and 232 px (B) and 348 px (C) at 400; tab stops 19 to 13 (B) and
10 (C). The dashboards list barely changes (A's 28 px rows; 16 px).

**Per-panel chrome, Services overview** (median per kind, px):

| Layout | Build | Kind | Panel height | Head | Description | Foot (text form, Explore) | Legend | Data (plot / figure / rows) | Chrome share |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1440-fine | baseline | stat (4) | 234 | 20 | 27 | 44 | 0 | 48 | 79% |
| 1440-fine | baseline | timeseries (6) | 668 | 20 | 18 | 44 | 209 | 200 | 70% |
| 1440-fine | baseline | table (2) | 464 | 20 | 18 | 68 | 0 | 192 | 59% |
| 1440-fine | A | stat (4) | 230 | 20 | 27 | 44 | 0 | 48 | 79% |
| 1440-fine | A | timeseries (6) | 664 | 20 | 18 | 44 | 209 | 200 | 70% |
| 1440-fine | A | table (2) | 428 | 20 | 18 | 68 | 0 | 168 | 61% |
| 1440-fine | B | stat (4) | 187 | 56 | 27 | 0 | 0 | 48 | 74% |
| 1440-fine | B | timeseries (6) | 608 | 24 | 18 | 0 | 159 | 200 | 67% |
| 1440-fine | B | table (2) | 348 | 24 | 18 | 0 | 0 | 168 | 52% |
| 1440-fine | C | stat (4) | 111 | 24 | 0 | 0 | 0 | 48 | 57% |
| 1440-fine | C | timeseries (6) | 582 | 24 | 0 | 0 | 159 | 200 | 66% |
| 1440-fine | C | table (2) | 322 | 24 | 0 | 0 | 0 | 168 | 48% |
| 400-coarse | baseline | stat (4) | 251 | 20 | 27 | 88 | 0 | 48 | 81% |
| 400-coarse | baseline | timeseries (6) | 843 | 20 | 36 | 88 | 370 | 220 | 73% |
| 400-coarse | baseline | table (2) | 484 | 20 | 18 | 132 | 0 | 192 | 61% |
| 400-coarse | A | stat (4) | 251 | 20 | 27 | 88 | 0 | 48 | 81% |
| 400-coarse | A | timeseries (6) | 843 | 20 | 36 | 88 | 370 | 220 | 73% |
| 400-coarse | A | table (2) | 484 | 20 | 18 | 132 | 0 | 192 | 61% |
| 400-coarse | B | stat (4) | 202 | 76 | 27 | 0 | 0 | 48 | 76% |
| 400-coarse | B | timeseries (6) | 727 | 76 | 36 | 0 | 302 | 220 | 67% |
| 400-coarse | B | table (2) | 392 | 76 | 18 | 0 | 0 | 192 | 52% |
| 400-coarse | C | stat (4) | 135 | 44 | 0 | 0 | 0 | 48 | 64% |
| 400-coarse | C | timeseries (6) | 651 | 44 | 0 | 0 | 302 | 220 | 62% |
| 400-coarse | C | table (2) | 334 | 44 | 0 | 0 | 0 | 192 | 44% |

In B the head is taller in narrow panels (56 px at 1440 in a three-column stat, 76 px at 400):
the title, the meta and the two buttons do not fit one line and wrap. C's one button fits.

Images (left: baseline, right: the option; same data, state, viewport and theme):
`images/{A,B,C}-services-{1440-fine,400-coarse}-{light,dark}-screen.png`, the same for `red`,
`explore-4`, `explore-36` and `list`; whole pages of all four:
`images/all-services-1440-fine-light-page.png`, `images/all-services-400-coarse-light-page.png`,
`images/all-red-*-page.png`. Opened states (baseline, B, C): `images/state-range-*.png` (the range
control; the baseline's is always open), `images/state-panel-commands-*.png` (the text form opened
from the panel, and C's menu), `images/state-focus-1440-fine-*.png` (keyboard focus on the range).

## 6. Does it remain intuitive? Tasks

Steps are presses (a typed value counts as one step). "Visible" means the control that starts the
task is drawn without hover, at rest. Keyboard and touch were checked by the prototype's markup
(every control is a `button`, `a`, `input` or `select`; menus close on Escape and return focus) and,
for touch, by the 400 px coarse images; neither was tested with a screen reader or a real phone.

| # | Task | Baseline (v9) | A: scale | B: quiet chrome, all visible | C: menus and a sticky bar |
|---|---|---|---|---|---|
| 1 | Range to the last 6 h | 1: "6 h" is on screen | 1 | 2: the range button (its words are the range, ending "…"), then "6 h"; the popover closes | 2, as B |
| 2 | Type an exact range | 2 typed fields, visible | 2 | 3: open the range, then the two fields; the button's words change to the range read back | 3, as B |
| 3 | Exact value of a series at a time | Pointer on the plot, or Tab to the plot and arrows, or a finger dragging: the readout in the foot. Unchanged in every build | same | same | same |
| 4 | Which service had the most errors | 1: sort the legend by Max (the table has Last, Min, Max) | 1 | 1: "Text form" on the panel's head (Max is in it); the list legend shows Last only; the plot's peak and direct labels answer it by eye | 2: "Actions…", "Show the text form" |
| 5 | Open a panel's query in Explore | 1: "Open in Explore" under the legend (at 1440 it is below the fold for most charts) | 1 | 1: "Explore" on the panel's head line | 2: "Actions…", "Open in Explore" |
| 6 | Read what a panel is for | 0: the description is shown | 0 | 0 | 2: "Actions…", "Show what it is for" (or the whole dashboard as Text) |
| 7 | Switch a variable | 1: segmented control under the range block | 1 | 1: the same control, inline in the bar | 1, as B |
| 8 | Read the dashboard as text | 1: "Text" in the page head | 1 | 1: "Text" at the right end of the bar | 1, as B |
| 9 | Move the range one step earlier | 1: "Show earlier" | 1 | 1: "Show earlier" beside the range button | 2: inside the range popover |

**How a first-time on-call person discovers each control.**

- *The range as one button (B, C).* Its words are the range itself ("18 Nov, 09:30 to 12:30, 3 h,
  UTC…"), so it answers "what am I looking at" before it is pressed; the "…" says it opens
  something (Menu rule). Grafana, Datadog and New Relic use this shape [research 13, §1], so an
  on-call person who has used any of them expects it. The cost is one press for a preset, and
  the presets are no longer seen at a glance.
- *Panel commands on the head line (B).* Worded quiet buttons, "Text form" and "Explore", on every
  panel, in `ink-secondary`. Found by reading; they repeat on every panel, so seen once, known
  everywhere.
- *"Actions…" (C).* One worded button per panel; what is behind it is not visible until it is
  opened. NN/g's study of hidden navigation (on desktop: used in 27% of cases against 48–50% when
  visible, at least 39% slower) is the closest evidence that a first-time reader finds less of
  what is hidden [research 13, §4]. "Open in Explore" is the main path out of a panel for on-call;
  in C it is behind a menu.
- *The description (C).* Hidden by default. A first-time reader is the person it is written for.
- *The list legend (B, C).* Each entry is still a toggle (press to show only that series), as the
  table rows are; nothing says so on screen in either form. Min and Max are gone from it.
- *The sticky bar (C, fine pointer only).* Always at hand when scrolled; it costs a rule and 49 px
  of every screen after the first.

## 7. The rubric rows density threatens

Checked on the prototypes by reading their CSS and markup and from the images; the rendered
audits (`tools/audit.mjs`, the hit-area guard, the reload pass) were **not** run on them (see
"What was not checked").

| Rubric row | A: scale | B: quiet chrome | C: menus, sticky bar |
|---|---|---|---|
| **Touch** (44 px, no overlap) | Unchanged by construction: every change is inside `@media (pointer: fine)`; the coarse block is untouched. | New controls: the range button and quiet small buttons get the system's `::after` 44 px area (they are `vz-button`); the head line that holds them is `control-touch` tall with a coarse pointer, so their areas reach neither the panel's rule nor its body. The list legend's rows keep `--legend-row` (45 px coarse). Not measured by the hit-area guard. | As B, with one button per panel instead of two. |
| **Touch parity** | Unchanged. | Every command is a press; nothing on hover. | Every command is a press; the panel's are one press further away. |
| **Narrow and zoom** | Unchanged at 400. At 1440 nothing moves out of its box. | The bar wraps (`vz-controls`) at 400 px: range button and Show earlier on one row, Show later, Panels/Text and Refresh on the next; nothing scrolls sideways in the images. The range popover is a bottom sheet with a coarse pointer below 640 px (Menu); with a **fine** pointer below 640 px it is `dialog` wide (480 px) and could overflow a 400 px window: not handled. 200% zoom not checked. | As B. The sticky bar is fine-pointer only, so it never covers a phone's screen; at 200% zoom on a desktop (a 720 px CSS viewport) it would take one or two rows of a short screen: not checked. |
| **Keyboard** | Unchanged. | Tab stops from the top to the first panel fall (measured; section 4): the range is one stop instead of five presets, two fields and two buttons. The popover takes focus on open and returns it on Escape. | Fewer stops again. The sticky bar has `scroll-padding-top` so a focused control is not hidden under it (WCAG 2.4.11), checked in the focus image only. |
| **Screen reader** | Unchanged. | The range button's name says the range and "Change the range"; the popover is a labelled non-modal dialog; the list legend keeps the table's roles and its head (visually hidden). Not heard with a screen reader. | The menu is `role="menu"` with `menuitemcheckbox` rows; arrow keys move between rows. Not heard. |
| **Text form** | Unchanged. | Unchanged: each panel's text form is one press, on its head. | Unchanged in content; one press further. |
| **Contrast** | Unchanged (no colour changes). | The quiet buttons' words are `ink-secondary` on `ground` (a pairing the system already checks for text). | As B. |
| **Speed** | A shorter page paints no slower (section 7). | One more press for a preset; opening the popover is a local change (budget 100 ms) and measured in section 7. | As B; opening the panel menu is a local change. |
| **Reserved height** | Every reserved height comes from the same variables, which change by pointer together with what is drawn: reservation and drawing stay equal. | The list legend reserves `--legend-lines` lines, counted on the last draw and kept for the tab's session as the table's rows are; before any draw it reserves one line, so a first load with no memory can grow (as the table does today without memory). A stat reserves a figure and one context line (the app's hidden placeholder), which is what B and C draw; the v9 stat drew a second line for its state, so this is closer than before. | As B. The panel meta that disappears in C when a panel agrees with the bar is replaced by nothing, so the head is the button's height in every state. |
| **Stale data** | Unchanged. | Unchanged: the meta still holds "Showing the previous range" in the same place. | Changed: a panel's meta is shown only when the panel differs from the bar (waiting, showing the previous range, failed); when every panel agrees the bar states the step and the oldest age once. True while a dashboard has one window and one step for all panels (as it does, app README); it would be false the day panels have their own. |

## 8. Speed: an indication, not a judgement

`tools/states.cjs`, 5 runs per build and layout (the budgets ask for 20 with `tools/speed.mjs`;
this is the cheap check that density does not cost speed, not the measurement a design pull
request needs), Chromium at 4x CPU slowdown, no network throttling, on the mock, measured here
between 09:03 and 09:15 UTC with other builders' jobs on the machine. 4 cores; the 1-minute load
of every run is recorded (`measurements/*-timings.json`) and was at or below 4 in every run (1.1 to
3.4). Median, worst in brackets.

| Build | Layout | Navigation to the first stat figure | to all 12 panels answered | Open the range control (input to the frame that shows it) | Open the panel's commands | Layout shift of a reload scrolled to "CPU by pod" |
|---|---|---:|---:|---:|---:|---:|
| baseline | 1440 fine | 1,355 ms (1,492) | 1,375 (1,515) | always open | 44 ms (52), text form | 0.0002 (0.0002) |
| B | 1440 fine | 1,363 (1,585) | 1,374 (1,618) | 43 (64) | 43 (61), text form | 0 (0) |
| C | 1440 fine | 1,362 (1,511) | 1,409 (1,559) | 38 (63) | 33 (55), menu | 0 (0) |
| baseline | 400 coarse | 1,374 (1,563) | 1,385 (1,570) | always open | 27 (56), text form | 0.0023 (0.0023) |
| B | 400 coarse | 1,430 (1,455) | 1,442 (1,476) | 36 (71) | 66 (92), text form | 0.0002 (0.0002) |
| C | 400 coarse | 1,413 (1,527) | 1,433 (1,535) | 35 (56) | 27 (35), menu | 0.0002 (**0.0858**) |

- Opening the range control and a panel's commands are local changes (budget: 100 ms): every run
  was under it. The first result's paint is the mock's answer plus drawing; it does not differ
  between builds by more than the run-to-run spread.
- **One C run at 400 shifted 0.086 on reload**, above the 0.05 budget; the other four were 0.0002.
  Not investigated. A builder must run `tools/audit.mjs`'s reload pass on whatever is built.
- The harness also recorded how far "CPU by pod" landed from where it was before the reload: −198 px
  at 1440 and −216 px at 400 in the **baseline** too. That is this harness (it scrolls twice within
  300 ms before reloading, faster than the app's scroll keeper records), not a finding; the audit's
  reload pass is the measure, and it was not run here.
- Not measured: typing, crosshair, the 36- and 200-series rows, theme change, INP over a session;
  `tools/speed.mjs --compare` on the fixture and `app/e2e/measure-dashboards.cjs` on the app.

## 9. Independent judgement: not obtained

The brief asked for one independent reviewer, given only the images, the task list and the rubric.
**It was not run.** This investigation ran as a subagent without a tool to start another agent,
and a separate cloud session would not have the uncommitted images. Nothing here should be read as
an independent verdict; the judgements in sections 6 and 7 are the author's.

To run it, give a reviewer who has not seen this README:

- the images in `images/` (pairs are labelled "baseline" and "option A/B/C", nothing else);
- `tasks.md` (the nine tasks, with the person);
- `design-system/project/review.md` (the rubric) and `project/README.md`;
- the instruction: rank options A, B and C (against the baseline) for clarity at a glance and for
  discoverability for a first-time on-call person; tie every finding to an image and a rubric
  row; say which option they would merge, with which changes.

Record the verdict here, verbatim-summarised, with where it disagrees with section 10.

## 10. Recommendation

**Adopt option B, with A's fine-pointer scale (B as prototyped includes it), and C's single-row
Explore.** Do not adopt C's menus, hidden descriptions or sticky bar now.

Why:

- **Structure, not scale, is where the space is.** A alone saves 3% of the 12-panel page and
  nothing on a phone (by design). B saves 18% at both widths, 26% on the variables dashboard, brings
  the first data mark into the phone's first screen on Service RED and Explore, and cuts tab stops
  to the first panel from 17 to 11. C's further 6–8% comes almost entirely from hiding the
  descriptions and the per-panel meta.
- **What C hides is what a first-time on-call reader needs.** "Open in Explore" and the description
  go from zero or one press to two, behind a button that says "Actions…" (section 6, tasks 5 and 6).
  NN/g's evidence on hidden navigation points the same way (research 13, §4). B keeps every command
  as a worded control on the panel's own line, visible without hover, which is the system's rule.
- **C's per-panel meta rule is true only while a dashboard has one window and one step**, which is
  an implementation fact of the app today, not a property of the model; B keeps the meta where the
  Panel rules put it.
- **Explore is different.** It is the place where a person sets a step and a unit on purpose; the
  button that opens them shows their values ("Step 15 s (auto) · unit auto…"), so nothing is
  hidden that is not stated, and the query, range and Run fit one row at 1440. That is C's Explore.

### What it changes in the system (v10)

- `tokens.json`: **a density family**, values by pointer, emitted by `tools/css.mjs` the way theme
  colours are emitted by theme: `gap-panel` (coarse `space-6`, fine `space-4`), `gap-section`
  (`space-8` / `space-6`), `gap-stack` (`space-4` / `space-3`), `gap-page` (`space-6` / `space-4`),
  `panel-rule-gap` (`space-3` / `space-2`), `row-dense` (32 / 28 px). The prototype set them as
  component variables on `.vz` (no new token, as `--strip` is); making them tokens lets
  `check.mjs` and the audit's token trace see them, and the rule "a token is defined once, by its
  theme" becomes "by its theme and pointer". No colour changes; no contrast pairing changes except
  the quiet buttons' `ink-secondary` on `ground`, which is already checked.
- **Panel**: the head holds the panel's commands (`vz-panel-tools`, quiet small buttons; with a
  coarse pointer the head line is `control-touch` tall); the foot goes; the rule text changes from
  "the description" to the same, and "A panel's own commands sit on its head line, never revealed
  by hover".
- **Controls**: `vz-bar` (one row: the range, its shifts, inline fields, a spacer, the view's form
  and Refresh). **Field**: `data-inline` (label before control). **Time range** (Field): the range as
  one button whose words are the range as read, opening `vz-popover` with the presets and the two
  typed times; the echo line stays inside.
- **Menu**: `vz-popover`, a menu's surface holding controls (role `dialog`), the same anchoring and
  the same bottom sheet with a coarse pointer below 640 px.
- **Chart**: `data-legend="list"` for at most eight series without Other, reserving
  `--legend-lines` as the table reserves `--legend-rows`; the rules for when each legend is used
  (Legend section), and that Min and Max then live in the text form. This needs the owner's
  decision (Min and Max leave the screen for small charts).
- **Stat**: `vz-stat-line` (figure with its state), one context line.
- `README.md` "Density is a feature" gains: "With a fine pointer the spacing steps down once and
  table rows are 28 px; a coarse pointer keeps every v9 size. Density comes from structure first:
  one row of controls, commands on the panel's own line, a legend sized to its series."

### What it changes in the app

`DashboardsPage` (the bar, facts in the head), `PanelView` (head tools, stat line, list legend),
`TimeRangeField` (`RangePicker`, `ShiftButtons`), `ExplorePage` (one row), `Chart` (the list
legend's reservation), a small `Popover` in `shell/`. The prototype diff is
`patches/app-density-prototypes.diff`; drop the `VITE_DENSITY` switch and the C branches.

### What it costs (an estimate, not measured)

System: two to three days including `check.mjs` pairings and structure checks for the new
components, guards in `tools/audit.mjs` (hit areas in panel heads, the list legend's reservation),
mutants for each, previews and the reference. App: one to two days including e2e updates (tests
that click "Open in Explore" in the foot, the range presets and the text form disclosure will need
new selectors). Review: one design review round, likely two.

### Risks

- **One more press for a preset** (task 1) and the presets are no longer visible; the button's
  words are the range, which is the more important fact.
- **The list legend drops Min and Max** at a glance for small charts.
- **A first load with no stored reservation** can grow by the list legend's extra lines (as the
  table grows today).
- **The popover's width** (`dialog`, 480 px) is not handled with a fine pointer below 640 px.
- **The C reload shift** (0.086 in one run of five at 400): B shares most of C's code; the reload
  pass must be run on B as built.
- Nothing here was tested with people; the task counts are walk-throughs.

### What would change the recommendation

- An independent reviewer (section 9) finding B's head buttons noisy or C's menu as discoverable:
  then C's menu with "Open in Explore" kept visible would be the next candidate.
- Usage data showing on-call readers rarely read descriptions: then hide them as C does, with a
  dashboard-level toggle rather than per panel.
- The dashboard model gaining per-panel windows: then C's bar-level meta is ruled out for good.
- A measured cost of the list legend (people needing Min and Max at a glance): keep the table and
  take only B's other changes (about 13% of the 12-panel page at 1440, estimated from the legend
  heights above, not measured).

## 11. Build plan: design system v10, as AGENTS.md requires

1. **Contracts first**: none; this is the design system and the app.
2. **System change** in `design-system/`: the density tokens (`tokens.json`, `tools/css.mjs`,
   `check.mjs` rule "defined once by theme and pointer"); components from
   `patches/system-v10-density.diff` without the C-only parts (`vz-bar[data-sticky]`); README rules
   (Panel, Controls, Field, Menu, Chart legend, Stat, "Density is a feature"); previews for each;
   `node tools/check.mjs` (with the render audit), `npm test`, `tools/audit.mjs` (every width, zoom
   and pointer, and the reload pass), `tools/mutants.mjs` with new mutants (a hit area in the panel
   head under 44 px; the list legend reserving no lines; a fine-pointer variable leaking into the
   coarse block).
3. **App change** in `app/`: from `patches/app-density-prototypes.diff`, B for dashboards and C's
   Explore row; `npm test`, `npx tsc --noEmit`, `npm run check:tokens`, `npm run e2e` (selectors
   updated), the dashboards mutants.
4. **Before and after images** with `tools/shots.mjs` / `app/e2e/dashboards-shots.cjs` and
   `v9-shots.cjs`: every changed view, both themes, 1440 and 400 px, same data and state, under
   `design-system/reviews/density-v10/compare/`; plus loading, empty, error, partial, focus, the
   opened range control and the text form opened from a panel; compositions at 1500 and 400 px and
   a coarse pointer, a dialog, an empty and an error state and a long table.
5. **Speed before and after**: `tools/speed.mjs --compare` at both layouts on the fixture (20 runs,
   36 and 200 series), and `app/e2e/measure-dashboards.cjs` (desktop and `--phone`) on the app,
   with the load recorded.
6. **Independent design review** (rubric `project/review.md`), kept under
   `design-system/reviews/density-v10/`; blockers and majors fixed and re-imaged.
7. **Decisions** for `design/DECISIONS.md`: one density adapted by pointer, not a user setting; the
   legend chosen by series count; the range as one control.

## 12. What was not checked, and defects in the prototypes

- **No independent judgement** (section 9).
- `tools/check.mjs --no-render` passed on the changed system (759/759 contrast and structure
  checks, 0 literal values) and on the changed app sources (0 literal values in 73 files);
  **the rendered audit (`check.mjs` without `--no-render`, `tools/audit.mjs`) and `npm test` were
  not run** on the prototypes, nor the app's e2e suites (which would fail on the moved controls).
- Hit areas with a coarse pointer were not measured by the guard; they follow from the
  components' CSS and the images.
- Not tested: 200% zoom, 320 px, a fine pointer at 400 px (the popover's width), a screen reader by
  ear, real touch hardware, Safari and Firefox, the 200-series case, Explore's table, text and JSON
  forms, any waiting, error or empty state in the new layouts, the dashboards with fragments and
  with kinds not drawn.
- **Prototype defects seen in the images**: with a coarse pointer the panel's buttons sit 10 px
  below the title's line (the head aligns by baseline, the tools box is 44 px tall; centre the head
  when it holds tools); in B's narrow panels the head wraps to two lines; "Query the chart's
  range" (Explore, after a zoom) was left out of B and C; the list legend's focus ring is drawn per
  cell, not round the entry; C's "Show what it is for" and "Show the text form" are checkable rows
  that close the menu.
- Every figure is from one machine and one mock; page heights and positions are deterministic for
  a given build, the timings are not.
