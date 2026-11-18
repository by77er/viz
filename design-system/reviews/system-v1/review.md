# Review: viz design system, v1

Reviewed: the version on disk at 18:28:40 UTC, 2026-11-18 (`tokens.json` sha1 `eefb7542`, `bundle.css` sha1 `1b254772`): Schibsted Grotesk and JetBrains Mono, sentence-case labels, the "Responsiveness and feedback" section, Progress, coarse-pointer hit areas. The system changed during the review; an earlier Source Serif 4 version was rendered first and is referred to only where it informs the typeface question.

Brief used: clarity; a sans with personality and sophistication; snappy and responsive in form factor and in feedback (meaningful, accurate, useful); attention to detail; everything justified; neutral light/dark with vibrant, unbiased action colours; no generated-design clichés.

## Verdict: reject as it stands

The direction is right and should be kept. It is not approvable because it fails four rows of its own rubric that are marked blocker (Narrow, Tokens, Touch, Contrast). All four are small, mechanical fixes. With those fixed and the Major items scheduled, this is an approve.

## How it was assessed

Built from a frozen copy, then rendered with Playwright at 1500 px and 400 px, device scale 2 (and scale 1 for text rendering), in both themes, plus a coarse-pointer 400 px pass:

- the generated reference (every component, both themes);
- (a) a full screen: header, page title, tabs, query row with time range and one blue button, banner, four panels (stat, two line charts, table);
- (b) a dialog with a form, an invalid field and a destructive action;
- (c) empty, error and loading panels, controls on `sunken`, a menu, all four tones, all status marks;
- (d) a 30-row, 8-column table of mixed text and numbers;
- a type specimen (11 to 16 px, both weights) and a focus/hover/pressed sheet.

Contrast was recomputed for every pairing found in the CSS, not only the 64 the system's check lists. Hover and pressed looks were reproduced by applying the CSS values statically. Nothing was measured for speed: there is no running app that uses the system.

Images in this folder:

| File | Shows |
|---|---|
| `01-screen-light-1500.png`, `02-screen-dark-1500.png` | Composition (a), scale 1 |
| `03-screen-400-fine-and-coarse.png` | Composition (a) at 400 px: fine pointer left, coarse right |
| `04-focus-hover-pressed.png` | Focus ring on every control and surface, hover and pressed looks, hovered first table row, keyboard hints; light above dark |
| `05-states-progress-menu.png` | Composition (c): empty, error, Progress over stale data, disabled, menu, tones, marks; light left, dark right |
| `06-table-detail-2x.png` | Table at scale 2: baselines, marks, units; light above dark |

## Blockers

### B1. The system's own reference scrolls sideways at 400 px (rubric: Narrow)

Seen: at a 400 px viewport `dist/reference.html` is 627 px wide. The Table preview (five columns) is 480 px; the cover is 627 px. In the compositions the five-column table is 464 px, the eight-column table 877 px, and five tabs run off the edge (`03-screen-400-fine-and-coarse.png`, "Deploys" is cut). The README says "a wide table scrolls inside its own container with its first column fixed" and "twelve columns from 1200px, six from 640px, one below", but no CSS implements either: there is no table container, no grid class, and `.vz-tabs` has no overflow behaviour. Charts scale with their `viewBox`, so 11 px axis text renders at about 6.5 px at 400 px.

Why it matters: the rule exists and nothing produces it, so every author will fail it differently.

Change:

```css
.vz-table-wrap { overflow-x: auto; overscroll-behavior-x: contain; }
.vz-table-wrap th:first-child, .vz-table-wrap td:first-child { position: sticky; left: 0; }
.vz-table-wrap td:first-child { background: var(--ground); }
.vz-tabs { overflow-x: auto; scrollbar-width: none; }
.vz-tabs button { flex: none; white-space: nowrap; }
.vz-grid { display: grid; gap: var(--space-6); grid-template-columns: repeat(12, minmax(0, 1fr)); container-type: inline-size; }
```

Add to the Panel rules: "Chart text is drawn at its token size at every width. Never scale a chart by its viewBox. Below 480 px of panel width show two x ticks and three y ticks." Make the reference page itself pass at 400 px and add that to `npm run check`.

### B2. The component CSS breaks the "only token values" hard rule (rubric: Tokens)

Seen: `bundle.css` holds 17 literal font sizes (11, 13, 14, 16, 20, 44 px), literal mark sizes (8 px, 12 px, 2 px), `margin-top: 6px`, `min-width: 220px`, `opacity: 0.72`, and the durations and easing as local `--vz-*` properties that are not in `tokens.json`. The type styles are generated as bare global classes (`.title`, `.body`, `.label`, `.code`, `.small`) that no component uses and that will collide with application class names. `check.mjs` lints colours only, so it reports a pass. `type.fonts` is an empty array.

Why it matters: the rubric would reject the system's own CSS, and a reviewer cannot hold authors to a rule the reference breaks.

Change: emit each type style as custom properties (`--text-ui-size`, `--text-ui-line`, `--text-ui-weight`) and use them in components; rename the generated classes to `.vz-text-<name>`; add tokens `mark: 8px`, a `micro` type style (mono 11/16, for keyboard hints and chart axes), `duration-fast: 100ms`, `duration-slow: 180ms`, `ease`; extend the lint to `px`, `ms` and `opacity` literals with the existing ignore comment for true exceptions.

### B3. Coarse-pointer hit areas do not deliver 44 px (rubric: Touch)

Seen in the CSS and the coarse-pointer render:

- `.vz-segmented { overflow: hidden }` clips the 44 px `::after` of its buttons, so the real target stays 30 px tall. Segments are also 40 to 52 px wide ("1 h" is 40).
- The `::after` areas are 44 px tall on 24 px and 32 px controls. Controls stacked with `space-2` between them (wrapped button rows, a small button in each 32 px table row) have overlapping targets; the later element takes the tap meant for its neighbour.
- Inputs become 44 px tall and 16 px text, while buttons beside them stay 32 px. The README says "drawn sizes do not change".

Change: remove `overflow: hidden` from `.vz-segmented` and round the first and last segment instead; under `(pointer: coarse)` give segments `min-width: var(--control-touch)`; state the rule as "with a coarse pointer, targets are 44 px and never overlap: stacked controls are `control-md` with at least `space-3` between them; `control-sm` is not used in stacks"; reword to "drawn sizes do not change, except inputs, which grow to `control-touch` with any button on the same row".

### B4. Contrast failures the system's check does not cover (rubric: Contrast)

Computed (WCAG ratio):

| Pairing | Light | Dark | Floor |
|---|---|---|---|
| Keyboard hint in a menu (`ink-muted` at 0.72 opacity on `raised`) | 3.03 | 3.39 | 4.5 |
| Same on the active menu row (`sunken`) | 2.85 | 3.66 | 4.5 |
| Keyboard hint on the blue button (white at 0.72) | 3.56 | 3.56 | 4.5 |
| Focus ring inside the chosen segment (`focus` on `ink`) | 3.45 | 2.80 | 3 |
| Focus ring against a blue button's own fill | 1.00 | 1.75 | relies on the 2 px gap only |
| Unmeasured progress track (`rule` on `ground`) | 1.27 | 1.32 | 3 if it carries meaning |

The hints are 11 px text, visibly faint in `04-focus-hover-pressed.png`; the delete glyph is unreadable.

Change: `.vz-kbd { opacity: 1; color: inherit; }` and in menus `color: var(--ink-secondary)` (8.5:1 and 10:1). For segments, put the ring outside: `.vz-segmented button:focus-visible { outline-offset: 1px; position: relative; z-index: 1; }` (possible once B3 removes the clipping). Add these pairings, and `focus` against every action fill, to `check.mjs`.

## Major

### M1. Font delivery contradicts the speed and layout-shift budgets

Seen: fonts load through a CSS `@import` of Google Fonts with `display=swap`; the fallbacks are Helvetica and Arial with no metric overrides; only the basic Latin subset loaded.

Why: a render-blocking chain to a third party, a visible reflow when the font arrives (the system's own budget is shift under 0.05), no service when that host is unreachable, which is exactly when an on-call engineer opens this product, and fallback glyphs for any non-Latin service or user name.

Change: self-host variable WOFF2 (Schibsted Grotesk 400 to 600, JetBrains Mono 400 to 500), preload the sans, declare a fallback face with `size-adjust` and `ascent-override` matched to it, record the files in `type.fonts`, and decide the script coverage on purpose.

### M2. Typeface: keep Schibsted Grotesk, with three corrections

It holds up at 13 and 14 px in dense tables at scale 1 and 2, in both themes; I, l and 1 are distinct; it does not read as the default Inter or Geist look. JetBrains Mono at 13 px matches its x-height (ten `x` measure 78.0 px in both). It is the right call over the serif: in the serif render the small-caps column heads had a cap height of about 7 px and erased case in units (ms and Ms, MB and Mb), which an observability product cannot afford.

Corrections:

- Figures are proportional by default and very uneven: ten `1`s measure 48 px, ten `0`s 88 px; with `tabular-nums` both are 88.9 px. Relative times, counts in panel heads and legends will jitter as they update. Add `font-variant-numeric: tabular-nums` to `.vz`.
- The stat rule asks for proportional figures at `-0.025em`. "61.4" nearly touches (`01-screen-light-1500.png`) and the unit moves when the value changes. Use tabular figures and `-0.02em`.
- Drop `text-rendering: optimizeLegibility` (it costs layout time on large tables, against the speed budget) and `-webkit-font-smoothing: antialiased` in the dark theme, where it thins 400-weight text.

If non-Latin coverage is required, Schibsted Grotesk cannot provide it; IBM Plex Sans is the nearest alternative with character and wide coverage. That alternative was not rendered here.

### M3. A press on a toned button shows nothing when the pointer is already over it

Seen: `:active` uses the same `*-hover` fill as `:hover` (`04-focus-hover-pressed.png`, "Blue hover=pressed"). With a mouse the pointer is always hovering first, so the "pressed state within one frame" budget is failed by design on the primary action.

Change: add `blue-pressed #0935ad`, `red-pressed #96110b`, `green-pressed #054f21`, `yellow-pressed #d9b100` and use them for `:active`. Style `[aria-busy="true"]` beyond a cursor (see M6).

### M4. Status relies on hue; the four marks are the same shape and the same lightness

Computed luminance: red 0.171, green 0.158, blue 0.142, unknown grey 0.147 (light). Red against green is 1.06:1. In the 30-row table the state column cannot be scanned in greyscale or with red-green colour blindness; every word has to be read. Only critical gets a second cue (weight 600), and that competes with the bold key column (`06-table-detail-2x.png`).

The same four values in both themes also unbalance dark: yellow is 13.3:1 on `ground`, blue 3.4, green 3.7, so yellow dominates and healthy recedes. In light, yellow is 1.41:1 and needs a ring that makes its mark 10 px beside 8 px neighbours.

Using action colours as status causes real collisions: a green "Resolve" button beside green "Healthy" marks, and in the dialog a red invalid-field border directly above a red "Delete rule" button.

Change: add `status-critical`, `status-warn`, `status-ok`, `status-info` tokens. Light: the current values. Dark: `#ff5a52`, `#ffd60a`, `#2fb866`, `#5c8dff`. Buttons keep the action tokens. Give each state a shape: critical a solid square, warning a solid square rotated 45 degrees, healthy a hollow square (1.5 px border), informational a solid 8 by 4 bar, unknown an 8 by 2 dash. Draw the yellow edge as an inset shadow, light theme only. Invalid fields: keep the red border and add the critical mark before the help line.

### M5. Hover borrows `sunken`, and the chosen segment outranks the primary action

- A hovered first table row is the same fill as the header and merges with it; in dark, hover makes a row or menu item darker than its surroundings, a hole rather than a highlight (`04-focus-hover-pressed.png`). Add `hover`: light `#ededed`, dark `#262626`, and use it for rows, menu items, quiet and secondary buttons. Keep `sunken` for wells.
- In greyscale the chosen segment (ink fill, 18.9:1 against the page) is the strongest object on the screen; the blue button is 5.5:1. In dark it is the brightest thing on the page. The eye lands on "6 h", not "Run query" (`01`, `02`). Use the system's other selection form: `background: var(--rule); color: var(--ink); font-weight: 600`.

### M6. Responsiveness and feedback: right intent, several rows cannot be tested or contradict each other

- "One frame (16 ms)" is wrong on 120 Hz displays and names no start or end. Write: "the pressed state is painted in the first frame after the input event; input delay plus processing is at most 50 ms at the 75th percentile".
- "Mid-range phone", "warm", and every budget except INP lack a device, a percentile and a method. Add one line: "measured on the reference device (4x CPU throttle, Fast 4G), 75th percentile of 20 runs, with the fixture dashboard".
- "Paint the first result in 300 ms" depends on the backend. Split it: "the request is sent and the region shows its waiting state within 100 ms; the first result paints within 100 ms of its arrival".
- "Switches a tab: finish in 100 ms, no loading state allowed" conflicts with tabs whose content is not loaded. Say which wins: "a tab whose data is not cached is a view change".
- 100 to 400 ms: "a progress cursor" does nothing on touch, against "nothing depends on hover". Specify a visible busy state on the control and that a busy button ignores a second press.
- Not covered: first load with no previous data (what the reserved region shows), automatic refresh (must never show Progress; update the age stamp only), offline and stalled connections, a timeout ceiling, and live tail.
- "Do not present old data as current: say how old it is" has no component. Add an age stamp to `vz-panel-meta`.

Progress itself:

- The third preview draws a full bar for "31 of 40 files, 9 timed out". That is the inaccuracy the rule forbids. Stop the bar at 31/40.
- Unmeasured: an empty track is indistinguishable from a measured 0% and is nearly invisible in dark. Hide the track when unmeasured; the sentence and the ticking time are the indicator.
- The elapsed time sits inside `role="status"`, so a screen reader announces every tick. Mark it `aria-hidden` and announce the sentence only when the stage changes. Add `aria-valuetext` to the measured form.
- There is no place for Cancel or Retry in the layout, although the rules require both. Add a `vz-progress-action` slot.

### M7. What is missing for day one, in order

1. Select / menu button (data source, custom range, variables). A dashboard cannot be operated without it.
2. Dialog and a `scrim` token. Composition (b) needed hand-written overlay CSS.
3. Checkbox and switch (`radius-1` already cites checkboxes that do not exist).
4. Tooltip and the chart crosshair readout.
5. App header, navigation and a link style. The README defines links; the CSS has no rule for `a`.
6. Empty and error state block (composition (c) improvised both).
7. Log line and trace waterfall: two of the three product pillars have no component.
8. A notice for failures of background work (the system rightly bans success toasts, but a failed save made elsewhere needs somewhere to appear).
9. Pagination or "show more", breadcrumbs, heatmap: can follow.

### M8. The rubric will not give the same verdict twice

- "Approve with changes" is undefined. Define: no blockers; every major has an agreed fix; no second review needed.
- Contrast floors are not in the rubric. State them: 4.5 text, 3 for marks, control borders and the focus ring; disabled exempt.
- "Is the reading order the intended one?" has no intended order to compare with. Require the author to list the first three things the eye should reach.
- "Sameness: like a template?" and "Words: minor to major" have no criteria. Replace Sameness with "uses only existing components and tokens, or lists the new ones"; give Words one example per level.
- Speed and Touch are blockers with no protocol (see M6, B3).
- Missing rows: dark theme judged on its own images; 200% zoom and text resize; screen-reader names and roles; reduced motion; chart honesty (axis baseline, sampling stated).
- Each finding should cite an image and a rule; say how many majors amount to a reject; a single reviewer plus automatic merge needs at least a recorded second look for blockers that were waived.
- The Purpose row cannot be answered from images; require the author's presence-test table.

## Minor

- Status text sits 1 px below the key-column and numeric baselines (`06-table-detail-2x.png`). Use `align-items: baseline` and lift the mark with `transform: translateY(-1px)`.
- A status inside `vz-stat-context` inherits `ink-secondary`; the rule says the word is `ink`. Set `color: var(--ink)` on `.vz-status`.
- The Table preview repeats "ms" on every row in `ink` mono; the rule says once, in the head or in `ink-secondary`.
- A right-aligned number column followed by a left-aligned column leaves 16 px between "40 ms" and the trace id. Give the cell after a right-aligned column `padding-left: var(--space-6)`.
- The tab focus ring touches the letters. Add `padding-inline: var(--space-1); margin-inline: calc(-1 * var(--space-1))`.
- Placeholder (`ink-muted`, 5.3:1) reads as an entered value in the confirm field of the dialog. Keep the colour, and forbid placeholders that could be a valid value.
- Secondary buttons are weight 600, the same as the primary and destructive ones; in the dialog footer "Save changes" and "Delete rule" carry equal weight. Use 500 for untoned buttons.
- The query well is 40 px tall beside 32 px controls. Give a single-line well `min-height: var(--control-md)` and `padding-block: var(--space-1)`.
- The banner does not wrap at 400 px; the button squeezes the sentence to three lines. Add `flex-wrap: wrap`.
- The banner's default mark is blue, but its README says no state is informational. Remove the default or document it.
- The `blue` token says "also the selected state of a control"; the README says selection is not blue. Delete the clause.
- Principles are numbered 1, 2, 3, 4, 6, 5.
- Unused tokens: `space-8`, `space-12`, `radius-0`, `icon`, `data-strong`; `raised` equals `ground` in light. Use them in a shipped component or remove them until needed.
- The cover uses the four action colours as decoration, which the colour rules forbid.
- In dark, the hover fills of blue, red and green fall to 2.5 to 2.8:1 against `ground`: the button gets fainter when pointed at.

## Generated-design tells

Few in the interface, which is to its credit. What remains: a keyboard-hint chip inside the primary button and on every menu row; the hairline-topped panel with mono numerals, which is the current house style of this kind of tool; and in the documents, aphorisms in place of criteria ("Colour is a signal, never a surface"), a roll-call of admired products, and a claim that ten typefaces were compared with no record of the comparison in the repository. Keep the hint only where a shortcut exists and is not already taught elsewhere; add the comparison images or drop the claim.

## Working: do not change

- True-grey neutrals and the surface model (`ground`, `sunken`, `raised`); the dark theme is its own set of values, not an inversion, and the text ramp passes on all three surfaces (lowest 4.89:1).
- Panels as a ruled region, not a card. The dashboard reads as one sheet.
- Mono, tabular, right-aligned numbers; at scale 1 the 30-row table is easy to run down.
- Sentence-case labels, no capitals, no tracking.
- One blue button per view, and status as a mark plus a word in `ink`.
- The invalid field: red border, help line in `ink` that says how to fix it.
- The banner's wording pattern and its inline fix button.
- The principle behind Progress: no bar without a numerator and denominator, previous data kept visible.
- The 2 px offset focus ring on `ground`, `sunken` and `raised` (5.0 to 6.3:1).
