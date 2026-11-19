# viz design system, version 5

The ground truth for how viz looks and behaves. Design changes are reviewed against it. The version is `version` in `project/tokens.json`; this is version 5.

| Path | Contents |
|---|---|
| `project/tokens.json` | Every value: colours in both themes, type styles, spacing, radii, the one shadow, sizes, the one angle, the two breakpoints, the inline-number scale, the lines a log message shows before it is cut. The single source. |
| `project/README.md` | The rules: colour, type, space and shape, states, motion, words, iconography, layout. |
| `project/method.md` | How to design a change: the question, the presence test, build order, hard rules. |
| `project/review.md` | The review process and rubric. |
| `src/components.css` | Component classes, written against tokens only. The source of `bundle.css`. |
| `project/components/` | `bundle.css` (generated) and, per component, guidelines and a live preview. |
| `project/fonts/` | The two typefaces as variable WOFF2, limited to the weights used (about 75 KB and 54 KB). |
| `reviews/` | Design reviews of the system itself and of changes, with their images. |
| `fixtures/` | The fixture dashboard the speed budgets are measured on: a JSON specification, a seeded data generator (3, 8, 36 and 200 series, a 7-day backtest, a 30-row table) and a page built from the system's components. |
| `tools/css.mjs` | The generation of the shipped CSS from the tokens and `src/components.css`, shared by `build.mjs` and `check.mjs`. |
| `tools/build.mjs` | Generates `project/components/bundle.css`, `dist/tokens.css`, `dist/viz.css`, `dist/viz-chart.js` (the reference chart) and `dist/fonts/`. |
| `tools/check.mjs` | Tokens (contrast of every pairing in both themes; the series palette as a palette: lightness steps, colour-vision separation within each dash group, distance from status and action colours; press against hover and chosen; the scrim), component CSS read as CSS (the swatch ring, the dot edge, no fill on a chart, slots 5 to 8 dashed, the ring round a row that is one control drawn by its cells, breakpoints are tokens), a rendered audit of every preview in both themes as opened and pressed, then at rest, hovered and pressed with legend rows chosen (text against the fill behind it, series and waterfall bars against their surface), and a lint for literal colours, lengths, durations, opacity, angles, percentages, weights and line clamps, including `<style>` and `style=""` in HTML. Pass paths to lint other code; `--no-render` skips the audit. |
| `tools/mutants.mjs` | Breaks each property `check.mjs` guards on a copy in a temporary folder (never the tree) and confirms the check fails; confirms a harmless reformatting passes. Run it after changing `check.mjs`. |
| `tools/reference.mjs` | Builds `dist/reference.html`: every component in both themes on one page. A component left out of its order is appended. |
| `tools/shots.mjs` | Captures a view in both themes at 1440 and 400 px, composes before/after images, and runs a scenario file: hover, pressed and focus on a selector, waiting after N ms, a coarse pointer, 200% zoom, greyscale, with hit areas, overflow and smallest text measured, and controls covered at their centre, drawn boxes reached by a neighbour's hit area and links inside sentences reported. |
| `tools/speed.mjs` | The shared speed harness: N runs at 4x CPU and Fast 4G, at a desktop layout (`fixtures/speed.json`) and a phone layout with touch (`fixtures/speed-phone.json`); p75, median and worst for press, typing, crosshair (pointer and touch drag), toggles, response to paint, layout shift (including a load scrolled to a chart) and the worst interaction; the load average and a calibration task recorded with every result, and timing rows not judged when the load exceeded the cores. |

`project/` is laid out so it can be published unchanged as the browsable reference.

## Using it

```
npm run build     # dist/tokens.css, dist/viz.css, dist/viz-chart.js, dist/reference.html
npm run check     # contrast + literal-value lint on the component CSS
node tools/check.mjs ../app/src   # lint application code for literal values
node fixtures/build.mjs && node tools/speed.mjs fixtures/speed.json && node tools/speed.mjs fixtures/speed-phone.json   # the budgets, desktop and phone
node tools/mutants.mjs            # check.mjs against its mutants, on a copy
node tools/shots.mjs scenario reviews/system-v5/shots.json <outDir>   # compositions, states, touch, zoom
```

Application code loads `dist/viz.css`, puts `class="vz"` on its root, and uses the token
custom properties (`var(--ink)`, `var(--space-4)`) and component classes (`vz-button`).
The theme follows the system setting; set `data-theme="light"` or `"dark"` on the root to
override it.

## Position

- **Neutral interface, true greys.** The neutrals have no hue, so the only colour on a
  screen is data, state, or something to press.
- **Four action colours at full strength**: blue, red, green, yellow, the same in both
  themes, for buttons only. State has its own colours and, more importantly, its own shapes.
- **One sans voice.** Schibsted Grotesk for interface and reading text: a grotesk with enough
  character to be recognisable (a serifed capital I, so I, l and 1 never blur) and enough
  restraint for dense tables. JetBrains Mono for data. Two families, each with one job. It was
  chosen by rendering the same dense screen in a serif and nine sans candidates and comparing.
- **Charts are part of the system**, not a panel around a library: series colour belongs to the entity for the life of the view, never to its rank; everything past eight series is one "Other"; slots alternate darker and lighter and 5 to 8 are dashed, so hue is never the only channel; the readout never covers the plot; and a finger can do what a pointer does (Chart).
- **Small radii, hairlines, one shadow.** Shape says what kind of thing something is:
  square tiles, 4px controls, 8px overlays.
- **Sentence case everywhere.** Labels differ from text by weight and ink, not by capitals
  or tracking.
- **Speed and honest feedback are part of the system**, with budgets, a waiting table and a
  harness that records the machine's load in the rules, and rows in the review rubric.

## What it deliberately leaves out

Gradients, glows, tinted backgrounds, coloured text, pill shapes, card boxes, icons as
decoration, emoji, capitalised eyebrows, centred layouts, and any second accent hue.

## Before/after images for a pull request

```
# on the base branch, with the app running
node tools/shots.mjs capture http://localhost:8820/explore reviews/<change>/before explore
# on the change
node tools/shots.mjs capture http://localhost:8820/explore reviews/<change>/after explore
node tools/shots.mjs compare reviews/<change>/before reviews/<change>/after reviews/<change>/compare
```

Commit `reviews/<change>/compare/` on the change's branch and reference each image in the
pull request description by commit, so it stays valid after merge:
`https://github.com/<owner>/<repo>/blob/<commit-sha>/design-system/reviews/<change>/compare/<file>.png?raw=true`.

## Review history

- `reviews/system-v1/review.md`: an independent review rejected the first sans version on
  four blockers (overflow at 400px, literal values in the component CSS, clipped touch
  targets, two contrast failures the check missed) and eight majors. All were applied.
- `reviews/system-v2/review.md`: rejected again on one remaining blocker (tab hit areas
  clipped by the scrolling strip) and three new majors (tabular figures widening
  punctuation, the sticky column's layering, a checkbox that resembled a status mark).
- `reviews/system-v3/review.md`: **approved**, no blockers or majors.
- `reviews/system-v4/review.md`: **rejected** v4 (the Chart component, touch and narrow rules,
  `pressed`, new components, the fixture and harness) on two blockers (series promoted into
  reserved slots after a filter round trip; the chart's reserved height wrong on phones) and
  six majors (hue-only series identity, an open chart specification, the main path inside a
  sentence, the harness, the rubric, missing pieces).
- `reviews/system-v5/response.md`: **v5, not yet reviewed.** Every v4 finding, what changed,
  where, and the image or measurement that shows it; the 16 system gaps from the flow screens'
  second revision (Waterfall, Log and the textarea among them); what was not done. Before and after
  images in `reviews/system-v5/compare/`, speed before and after in `reviews/system-v5/speed/`.

## Not done yet

- No icon set. The rules say to use words until one is chosen ("Actions…" for a row's menu).
- Components are CSS classes with HTML previews; there is no React component package.
- The web app (`app/`) and the flow screens (`flows/`) are on v4; migration notes are in
  `reviews/system-v4/CHANGES.md` and `reviews/system-v5/response.md` ("Migration").
- An outbound message (push, text, chat), stacked and bar charts and heatmaps are not specified; the
  Chart component says not to build them from it. A trace's spans (Waterfall) and log lines (Log) are
  their own components since v5.
- The budgets have been measured only on the system's own fixture page (a floor), on a shared
  machine whose load stayed above its core count, so the harness reports every timing row as
  "not judged"; layout shift is judged and within budget at both layouts. The application has
  not been measured against the fixture.
- Fonts cover Latin, extended Latin and (mono) Greek and Cyrillic only.
- Not checked: a screen reader by ear, Safari and Firefox (the table's scroll edge uses a scroll
  timeline, which Safari and Firefox may not draw; the table still scrolls), real touch hardware,
  enlarged text as distinct from zoom.
