# Re-review: viz design system, v2

Reviewed: the version rebuilt at 18:36 UTC, 2026-11-18, from a frozen copy (`src/components.css`, `project/tokens.json`, generated `dist/viz.css`). Compared with `reviews/system-v1/review.md`.

## Verdict: reject, under the rubric's own definitions

`review.md` now defines reject as "any blocker, or three or more majors". This version has one remaining blocker (Touch: tabs) and three new majors. Each has a fix of a few lines. Of the twelve v1 blockers and majors, eight are fixed and four are partly fixed; the remaining gaps are small. Nothing here questions the direction.

## How it was assessed

Same method as v1, with the compositions rebuilt on the new components (`vz-nav`, `vz-dashboard` / `vz-grid`, `vz-table-wrap`, `vz-dialog`, `vz-empty`, select, checkbox, tooltip, `vz-mark`): full screen, dialog, states, 30-row table, focus and state sheet; both themes; 1500 px and 400 px at scale 2, plus scale 1; a coarse-pointer pass at 400 px that measures every hit area and tests each pair for overlap and for clipping by a scrolling ancestor; real keyboard focus on nav, tabs and segments; the table scrolled sideways with a row hovered; the page loaded with the font files blocked to measure the fallback; contrast recomputed for the pairings in the CSS. No speed measurements: there is still no app on the system.

| File | Shows |
|---|---|
| `01-screen-light-dark-1500.png` | Full screen, scale 1, light above dark |
| `02-screen-400-fine-and-coarse.png` | Full screen at 400 px, fine pointer left, coarse right |
| `03-focus-states-marks-controls.png` | Focus rings, hover, pressed, busy, menu, hovered first row, status marks, checkbox, select, tooltip, segments; light above dark |
| `04-sticky-column-scrolled-hover-400.png` | 30-row table at 400 px, scrolled sideways, one row hovered |
| `05-dialog-tabular-punctuation-checkbox.png` | Dialog: stretched punctuation, checked checkbox, invalid field with mark |
| `06-keyboard-focus-nav-tabs-segmented.png` | Real keyboard focus on nav, tabs, segments |

## Status of the v1 findings

| v1 | Status | Evidence |
|---|---|---|
| B1 Narrow | **Fixed** | Reference page and all four compositions are exactly 400 px wide at a 400 px viewport. Tables scroll in `vz-table-wrap`; tabs and nav scroll; the grid goes to one column below 640 px of dashboard width (measured: 2 columns at 700 to 1500, 1 at 600). The chart rule now forbids scaling. See N2 for a defect in the sticky column. |
| B2 Tokens | **Fixed** | `check.mjs` lints lengths, durations and opacity and passes; components use `--text-*` properties; classes are `vz-text-*`; durations are tokens; `type.fonts` is filled. Leftovers under Minor. |
| B3 Touch | **Partly fixed, still a blocker** | Segments are no longer clipped and are at least 44 px wide; no control measures under 44 px by its pseudo-element. But `.vz-tabs` now has `overflow-x: auto`, which clips the 44 px area to the 38 px tab strip. See R1. |
| B4 Contrast | **Fixed** | Keyboard hints 7.3 to 7.9:1 on `raised` and `hover`; focus ring sits outside the segment and is 4.31 (light) and 4.52 (dark) against the chosen fill; the unmeasured track is hidden; 122 pairings checked. |
| M1 Font delivery | **Fixed** | Self-hosted WOFF2 (75 KB, 54 KB). With the font files blocked, page height is unchanged (983 px in both cases); widths differ by at most 8% (tab "Overview" 64.9 px against 59.5 px; description line 540 px against 501 px), and no line count changed. |
| M2 Typeface corrections | **Partly fixed, and regressed** | Stat tracking is `-0.02em`. `tabular-nums` was added to `.vz` but causes N1. `text-rendering: optimizeLegibility` and `antialiased` are still set. |
| M3 Pressed state | **Fixed** | `*-pressed` tokens are distinct from hover (`03`); busy holds the pressed fill and ignores presses. |
| M4 Status | **Fixed** | Five distinct shapes that survive at 8 px and scale 1 (`01`, `03`); `status-*` tokens with lighter dark values (critical 6.10, healthy 7.29, informational 5.98 on `ground`); invalid fields carry the critical mark. |
| M5 Hover and chosen segment | **Fixed, with a weak spot** | `hover` token in use; rows and menu items lighten in dark. The blue button is again the strongest object in both themes (`01`). The chosen segment is now faint: see Minor. |
| M6 Budgets and Progress | **Fixed** | Reference setup, percentile and run count are stated; press is defined from the input event; query budget is split at the network; automatic refresh, offline, live tail and a 60 s ceiling are covered. Progress stops at 31/40, hides the track when unmeasured, keeps elapsed time out of the live region and has an action slot. Leftover: the "fixture dashboard" the budgets are measured on does not exist yet. |
| M7 Missing components | **Partly fixed** | Added: select, checkbox, dialog, tooltip, empty and error block, nav, link. Still absent: a `scrim` token (the dialog has no backdrop), log line, trace waterfall, and a notice for failed background work. These can be follow-ups if listed under "Not done yet". |
| M8 Rubric | **Fixed** | Verdicts defined, floors stated, presence table and reading order required, rows added for screen reader, zoom, reduced motion and charts, waivers need a second reviewer. |

## Remaining blocker

### R1. Tabs have a 38 px touch target (rubric: Touch)

Seen: under a coarse pointer the tab button is 38 px tall and its 44 px `::after` is cut off by `.vz-tabs { overflow-x: auto }`, which also clips vertically. The coarse-pointer pass flags all five tabs and nothing else.

Change:

```css
@media (pointer: coarse) { .vz-tabs button { padding-block: var(--space-3); } }
```

Related, same row: wrapped rows of buttons overlap. Two rows of 32 px buttons with `space-2` between them have hit areas that overlap by 4 px; a 32 px row above a 24 px row overlaps by 8 px (measured in the states composition). `vz-dialog-actions` and `vz-banner` both wrap with that gap. Add `row-gap: var(--space-3)` to both under `(pointer: coarse)`, and extend the README sentence from "small controls are not stacked" to "wrapped rows of controls are at least `space-3` apart".

## New majors

### N1. Tabular figures stretch punctuation in prose, and are switched off where they are needed (rubric: Type)

Seen: in this font the tabular feature widens the period, comma and colon to a digit's width. Ten periods measure 34 px normally and 89 px with `tabular-nums`. Because `.vz` now sets it, every paragraph that inherits shows gaps: "firing history . Silences", "2 . 1 million series", "09 : 00 to 15 : 00" (`05`, and the banner in `01`). Meanwhile every element that sets `font: var(--text-…)` resets it: computed `font-variant-numeric` is `normal` on `vz-panel-meta`, `vz-stat-value`, `vz-legend`, labels and buttons, which is where changing numbers live. So the fix reaches the wrong text and misses the right text.

This also corrects my v1 advice: the font's tabular figures cannot be used for anything containing a period, comma or colon, so they cannot be used for decimals or times.

Change: remove `font-variant-numeric: tabular-nums` from `.vz`. Add the rule "a number that updates in place is set in `mono`" and apply it: the age in a panel head (`updated <span class="vz-num">12 s</span> ago`), counts, elapsed times. For `vz-stat-value`, keep proportional sans figures and reserve the width (`min-width` in `ch` for the longest expected value). If sans tabular figures are wanted later, rebuild the self-hosted file so the feature covers digits only.

### N2. Content paints over the sticky first column (rubric: Detail in name, but it corrupts the key column)

Seen: with the table scrolled sideways, the warning diamond from the State column is drawn on top of the sticky Service cell: "cart ◆" and "inventory◆-sync" (`04`). The mark has a `transform`, which lifts it above the sticky cell; `vz-button` is `position: relative` and will do the same for any button in a row. There is also no edge on the sticky column, so text is sliced mid-letter ("wner", "atform team").

Change:

```css
.vz-table th:first-child, .vz-table td:first-child { z-index: 1; box-shadow: var(--hairline) 0 0 var(--rule); }
```

Hover on the sticky cell itself is correct in both themes.

### N3. A checked checkbox does not look checked (rubric: States)

Seen: checked is an ink square with an inner ring, a box inside a box (`03`, `05`). It reads as an icon, not as a tick, and it is close to the hollow square that now means "Healthy". In dark it is a white box with a dark ring, which looks more like an empty box than the unchecked one does.

Change: draw a tick in `ground` on the `ink` fill and drop the inner ring.

```css
.vz-check input:checked { background: var(--ink); border-color: var(--ink); box-shadow: none; }
.vz-check input:checked::before { content: ""; display: block; width: 9px; height: 5px; margin: 3px 0 0 2px;
  border: solid var(--ground); border-width: 0 0 var(--stroke) var(--stroke); transform: rotate(-45deg); }
```

(Tokenise the three lengths.) Add an indeterminate state while there: table row selection will need it.

## Minor

- Chosen segment: its fill is 1.27:1 against the page (1.32 in dark) and 1.09:1 against a hovered neighbour, so in a two-option control hovering the other option makes both look chosen (`03`, bottom right). Weight carries the state, which is enough to pass, but the time range deserves a firmer mark. Add `box-shadow: inset 0 calc(-1 * var(--stroke)) 0 var(--ink)`, the same language as the current tab.
- Hovered first row against the header is 1.07:1 in light; distinguishable, barely. Acceptable now that hover lightens in dark (1.31).
- Tab focus ring is inside and touches the first and last letters (`06`). Add `padding-inline: var(--space-1)` with a matching negative margin.
- Pressed and busy fills in dark are 1.9 to 2.1:1 against `ground`; the label stays above 8.8:1, so the button is still readable.
- At 400 px the nav scrolls and its last item (Search) is off-screen with no cue (`02`). Keep the right-hand item outside the scrolling part.
- The select's arrow is built from `linear-gradient`, which the colour rules forbid and the lint does not catch; `scale(0.85)`, `45deg` and `55%` are literals. Use a mask or a rotated border.
- Still open from v1: status text sits 1 px below the key-column baseline; a status inside `vz-stat-context` is `ink-secondary`, not `ink`; the Table preview repeats "ms" on every row; no extra gutter after a right-aligned column; untoned buttons are weight 600; a placeholder can pass for a value; principles are numbered 1, 2, 3, 4, 6, 5; the `blue` token still says "also the selected state of a control"; `space-8`, `space-12`, `radius-0` and `data-strong` are unused; `optimizeLegibility` and `antialiased` remain.

## Working: do not change

- The status shapes. They hold at 8 px, scale 1, both themes, and the hollow healthy mark rightly recedes.
- The segment ring outside the control, and the `hover` token.
- Self-hosted fonts with the metric-matched fallback: no vertical shift measured.
- The budgets table split at the network boundary, and the waiting table with its 60 s ceiling.
- Progress as now specified.
- The rubric's verdict definitions and floors.
- Everything listed under "Working" in the v1 review.
