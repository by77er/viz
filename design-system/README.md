# viz design system

The ground truth for how viz looks and behaves. Design changes are reviewed against it.

| Path | Contents |
|---|---|
| `project/tokens.json` | Every value: colours in both themes, type styles, spacing, radii, the one shadow, sizes. The single source. |
| `project/README.md` | The rules: colour, type, space and shape, states, motion, words, iconography, layout. |
| `project/method.md` | How to design a change: the question, the presence test, build order, hard rules. |
| `project/review.md` | The review process and rubric. |
| `src/components.css` | Component classes, written against tokens only. The source of `bundle.css`. |
| `project/components/` | `bundle.css` (generated) and, per component, guidelines and a live preview. |
| `project/fonts/` | The two typefaces as variable WOFF2, limited to the weights used (about 75 KB and 54 KB). |
| `reviews/` | Design reviews of the system itself and of changes, with their images. |
| `fixtures/` | The fixture dashboard the speed budgets are measured on: a JSON specification, a seeded data generator (3, 8, 36 and 200 series, a 7-day backtest, a 30-row table) and a page built from the system's components. |
| `tools/build.mjs` | Generates `project/components/bundle.css`, `dist/tokens.css`, `dist/viz.css`, `dist/viz-chart.js` (the reference chart) and `dist/fonts/`. |
| `tools/check.mjs` | Contrast of every text, control, mark and series pairing in both themes, series neighbours, press against hover and chosen, the swatch's ground edge, and a lint for literal colours, lengths, durations and opacity. Pass paths to lint other code. |
| `tools/reference.mjs` | Builds `dist/reference.html`: every component in both themes on one page. A component left out of its order is appended. |
| `tools/shots.mjs` | Captures a view in both themes at 1440 and 400 px, composes before/after images, and runs a scenario file: hover, pressed and focus on a selector, waiting after N ms, a coarse pointer, 200% zoom, greyscale, with hit areas, overflow and smallest text measured. |
| `tools/speed.mjs` | The shared speed harness: N runs at 4x CPU and Fast 4G, p75, median and worst for press, typing, crosshair, a named toggle, response to paint, layout shift and the worst interaction. |

`project/` is laid out so it can be published unchanged as the browsable reference.

## Using it

```
npm run build     # dist/tokens.css, dist/viz.css, dist/viz-chart.js, dist/reference.html
npm run check     # contrast + literal-value lint on the component CSS
node tools/check.mjs ../app/src   # lint application code for literal values
node fixtures/build.mjs && node tools/speed.mjs fixtures/speed.json   # the budgets, on the fixture
node tools/shots.mjs scenario reviews/system-v4/shots.json <outDir>   # compositions, states, touch, zoom
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
- **Charts are part of the system**, not a panel around a library: series colour belongs to the entity for the life of the view, everything past eight series is one "Other", the readout never covers the plot, and a finger can do what a pointer does (Chart).
- **Small radii, hairlines, one shadow.** Shape says what kind of thing something is:
  square tiles, 4px controls, 8px overlays.
- **Sentence case everywhere.** Labels differ from text by weight and ink, not by capitals
  or tracking.
- **Speed and honest feedback are part of the system**, with budgets and a waiting table in
  the rules and rows in the review rubric.

Reference points for behaviour and restraint, not for appearance: Linear (density,
keyboard-first commands), Things (one primary action, calm states), iA Writer (type doing
the work of chrome), Stripe's dashboard (tables and numbers), and the clarity and deference
principles of Apple's interface guidelines.

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
- `reviews/system-v3/review.md`: **approved**, no blockers or majors. Three minor wording
  points were then corrected. No speed budget has been verified, because nothing uses the
  system yet.
- `reviews/system-v4/CHANGES.md`: **v4, not yet reviewed.** The system changes asked for by
  the first application review (`reviews/app-restyle/`) and the flow screens' review
  (`reviews/flows-v1/`): a Chart component and series-colour rule with a re-stepped light
  palette, touch and narrow-table rules, a pressed fill and a scrim, the waiting line's
  place, inline numbers, new components (page header, key-value list, timeline, agent claim,
  change list, secret, notice, first run), the fixture dashboard and speed harness, and
  rubric rows for typing, many series, touch parity, consistency, agent text and stale
  labels. It lists migration notes for `app/src` and for the flow screens. It needs an
  independent review before anything is built on it.

## Not done yet

- No icon set. The rules say to use words until one is chosen.
- Components are CSS classes with HTML previews; there is no React component package.
- The web app (`app/`) uses the system since the app-restyle change, which was rejected in
  review on findings that v4 answers on the system's side; the app's own fixes are open.
- Log line, trace waterfall, heatmap and flame graph are not specified; they arrive with
  the traces and logs phases. Stacked charts are described in the Chart rules but not drawn
  by the reference chart.
- The budgets have been measured only on the system's own fixture page (a floor), on a
  shared machine: two rows are over budget there (a legend toggle with 36 series and
  switching seven panels from charts to tables; `reviews/system-v4/CHANGES.md`). The
  application has not been measured against the fixture.
- The application (`app/`) and the flow screens (`flows/`) do not follow v4 yet; the
  migration notes are in `reviews/system-v4/CHANGES.md`.
- Fonts cover Latin, extended Latin and (mono) Greek and Cyrillic only.
