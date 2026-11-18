# Re-review: viz design system, v3

Reviewed: the version rebuilt at 18:47 UTC, 2026-11-18, from a frozen copy. Scope: the four findings from `reviews/system-v2/review.md`, plus a rerun of every v2 check to catch regressions.

## Verdict: approve

Under `review.md`: no blockers and no majors. All four v2 findings are fixed, nothing that passed in v2 has regressed, and what remains is minor. The items listed under "Follow-ups" are not defects in what exists; they are things the system does not have yet.

Not verified: any speed budget. No application uses the system, so there is nothing to measure.

## The four findings

| v2 | Status | Evidence |
|---|---|---|
| R1 Tabs 38 px touch target; wrapped rows overlap | **Fixed** | Coarse pointer, 400 px: tab buttons measure 46 px tall, nav links 44 px, and neither is clipped by its scrolling strip (`01-tabs-nav-400-fine-and-coarse.png`). The full-screen and dialog compositions report no hit area under 44 px, none clipped and none overlapping. A dialog footer forced to wrap puts its rows 44 px apart (tops at 48 and 92) with no overlap; a banner with two wrapped buttons has none either. |
| N1 Stretched punctuation | **Fixed** | Computed `font-variant-numeric` is `normal` on every element sampled. Prose reads normally: "firing history. Silences", "This range is too long for raw samples." (`02-dialog-prose-checkbox.png`, `01`). The README now explains why the sans is not tabular and sets compared or changing numbers in mono; the panel age is in `vz-num`. |
| N2 Marks painted over the sticky column | **Fixed** | Table scrolled 150 px at 400 px wide with a row hovered: the first column covers what passes beneath it, has a hairline edge, and takes the hover fill, in both themes (`03-sticky-column-scrolled-hover-400.png`). |
| N3 Checked checkbox | **Fixed** | An ink box with a tick in `ground`; unmistakable beside the hollow green "Healthy" mark, in both themes, and with a focus ring (`04-marks-checkbox-segments.png`, `02`). |

Also confirmed: the chosen segment now carries an ink underline and is clearly distinct from a hovered neighbour (`04`).

## Regression check

Rerun and unchanged from v2: reference page and all compositions are 400 px wide at a 400 px viewport; the grid is two columns from 700 to 1500 px of dashboard width and one at 600; with the font files blocked the page height is the same (983 px); status marks keep their five shapes; `check.mjs` passes 122 pairings and the literal-value lint.

## Minor

- Under a coarse pointer the tab strip is now drawn 8 px taller (39 to 47 px), so content below it moves (`01`). That is the right trade, but the README still says drawn sizes change only for text inputs and selects. Add tabs and nav links to that sentence.
- `vz-stat-value` is a number that updates in place and is still proportional sans, which the new README rule says should not shift. Either reserve its width (`min-width` in `ch`) or say in the rule that the stat is the exception and why.
- The README says the sans "is preloaded". CSS cannot preload; nothing in the system emits the `<link rel="preload">`. Document the tag for application code or remove the claim.
- A hand-laid row of buttons that wraps with `space-2` between rows still overlaps by 8 px under a coarse pointer (states composition, my own markup). The components are correct; the README rule covers small controls only. Widen it to "wrapped rows of controls are at least `space-3` apart".
- Still open from earlier reviews: status text 1 px below the key-column baseline; status inside `vz-stat-context` is `ink-secondary`; "ms" repeated on every row of the Table preview; no extra gutter after a right-aligned column; untoned buttons at weight 600; the tab focus ring touches the letters; the nav's right-hand item scrolls out of view at 400 px; the select arrow is drawn with `linear-gradient`; principles numbered 1, 2, 3, 4, 6, 5; the `blue` token text still mentions selection; `space-8`, `space-12`, `radius-0`, `data-strong` unused; `optimizeLegibility` and `antialiased` still set.

## Follow-ups (not blocking)

- A `scrim` token and backdrop for the dialog.
- Log line and trace waterfall components.
- A notice for failed background work.
- The fixture dashboard that the speed budgets are measured against.
- The first real change through this review, with measurements.
