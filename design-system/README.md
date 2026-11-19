# viz design system, version 8

The ground truth for how viz looks and behaves. Design changes are reviewed against it. The version is `version` in `project/tokens.json`; this is version 8.

| Path | Contents |
|---|---|
| `project/tokens.json` | Every value: colours in both themes, type styles, spacing, radii, the one shadow, sizes (v7: `keep` a quarter of the row and `key-min` half, for folded lists), the one angle, the two breakpoints, the inline-number scale, the lines a log message shows before it is cut. The single source. |
| `project/README.md` | The rules: colour, type, space and shape, states, motion, words, iconography, layout. |
| `project/method.md` | How to design a change: the question, the presence test, build order, hard rules. |
| `project/review.md` | The review process and rubric. |
| `src/components.css` | Component classes, written against tokens only. The source of `bundle.css`. |
| `src/press.js` | The press state for every pointer: marks the pressed control `data-pressed` from `pointerdown`, the twin of every `:active` rule, because a browser applies `:active` to a finger only at the release. Built to `dist/viz-press.js`; every page loads it. |
| `project/components/` | `bundle.css` (generated) and, per component, guidelines and a live preview. |
| `project/fonts/` | The two typefaces as variable WOFF2, limited to the weights used (about 75 KB and 54 KB). |
| `reviews/` | Design reviews of the system itself and of changes, with their images. |
| `fixtures/` | The fixture dashboard the speed budgets are measured on: a JSON specification, a seeded data generator (3, 8, 36 and 200 series, a 7-day backtest, a 30-row table) and a page built from the system's components. |
| `tools/css.mjs` | The generation of the shipped CSS from the tokens and `src/components.css`, shared by `build.mjs` and `check.mjs`. |
| `tools/build.mjs` | Generates `project/components/bundle.css`, `dist/tokens.css`, `dist/viz.css`, `dist/viz-chart.js` (the reference chart), `dist/viz-press.js` and `dist/fonts/`. |
| `tools/check.mjs` | Tokens (contrast of every pairing in both themes; the series palette as a palette; Other apart in lightness from every slot; press against hover and chosen; disabled ink apart from muted; the scrim; micro the smallest size), component CSS parsed with css-tree and checked as rules (`tools/lib/structure.mjs`: colour confined to toned buttons, status marks, series and focus; one shadow; presses never eased, each `:active` with its `[data-pressed]` twin; nothing revealed on hover; the presence of every fix the reviews asked for), a rendered audit of every preview in both themes as opened, pressed by pointer and by finger, at rest with legend rows chosen and hovered, plus every reserving chart's reserved height against its drawn height at both pointers, and the literal lint (`tools/lib/lint.mjs`, css-tree and parse5): any design value written out, at any depth of a value, in CSS (nested rules and every at-rule's declarations included, names read unescaped), `<style>` (and its `media` attribute), `style` attributes in either quote, SVG presentation attributes, and CSS written by script (`style.x =`, `style['x'] =`, `cssText`, `setProperty`, `Object.assign(el.style, …)`, `el.animate(…)`, `setAttribute('style' or a presentation attribute, …)`, `matchMedia`); keyword widths, small capitals, a looping animation or a turning keyframe, a weight or curve put in a custom property of the stylesheet's own and read where it is used, `font-variation-settings`, a system token redefined anywhere below its theme, and emoji anywhere; the main path never a link inside a sentence. Pass paths to lint other code; `--no-render` skips the audit. The lint catches spellings; what a fix does is guarded as rendered by `tools/audit.mjs`. |
| `tools/lib/` | `lint.mjs` (literal values, by parser) and `structure.mjs` (rules and presence checks, quick and static; each fix is also guarded as rendered by `tools/audit.mjs`), used by `check.mjs`. |
| `tools/mutants-corpus.mjs`, `tools/mutants.mjs` | The checks' regression corpus (153: v4's 18, v5's 13, the v5 review's 32, v6's 17, the v6 review's 20, v7's 8, the v7 review's 13, v8's 9, 15 for the chart rules, 4 for the page audit, 4 harmless edits) and its runner: each mutant applied to a copy outside the tree, each expected to be caught by the check it names with every literal it plants reported; the harmless ones must pass. |
| `tools/test/` | `npm test`: `chart-rules.test.mjs` (the Chart rules as properties over 400 random sequences, with narrowing a query and editing it back among the moves; 300 random narrowing sequences run twice, once as query edits and once as a dashboard filter, which must colour alike; the v7 review's narrowing; the v6 review's sequences D and E, each blocker example of the rubric's Many series row, the earlier reviews' sequences) and `check.test.mjs` (the corpus; `VIZ_SLOW=1` adds the mutants that need a browser). |
| `tools/audit.mjs` | The rendered page audit: every preview (`dist/preview/`), the reference, the fixture, the latest review's compositions and, reported apart, the flow screens, at 320 to 1500 px with a fine pointer, 320, 400 and 768 px with a coarse one and 200% zoom. First, that `dist/` is what the build makes of the tree (`stale`). Then: sideways overflow, heads and cells outside their table, something absolutely placed escaping a box that scrolls, folding tables that scroll, words cut by an edge, text below micro, links in sentences drawn as controls and standalone links under 44 px; **overlap** (every word hit-tested at its centre) and **key-width** (a folded key under `key-min`), at every configuration (v6 review, B1); **align** (a column of bare numbers whose figures or head do not end at the cell's right edge; v7 review, M2). **Guards**, each fix checked by what it does when rendered, in both themes, at both pointers (v7 review, M3): the focus ring on focus and with a mouse over it (its width, offset, the theme's focus, 3:1 on what is behind it, never cut by an ancestor), control borders at 3:1 as painted, every control's hit area measured at every coarse width, and what each control draws sampled for a neighbour's hit area reaching into it, a press by a real finger and by a real mouse, the table wrap positioned, dashed swatches (also hovered), emphasis (also hovered), picked members of Other told apart, a kept state that wraps, nothing that loops, and, with reduced motion at both pointers, nothing that moves. **Token trace**: every colour, length, duration, weight and curve of every element inside `.vz`, read before and after every token is moved: a value that does not move was written out somewhere; and every token on every element is its theme's (a token redefined below its theme fails). On compositions at 1500 px: figures that disagree with their chart (`data-figure`) or each other (`data-same`), captions whose count or order the rows contradict, ages beyond a day. |
| `tools/reference.mjs` | Builds `dist/reference.html`: every component in both themes on one page (a component left out of its order is appended), and `dist/preview/<Component>.html`, each preview as a page on the shipped CSS. |
| `tools/shots.mjs` | Captures a view in both themes at 1440 and 400 px, composes before/after images, and runs a scenario file: hover, pressed and focus on a selector, waiting after N ms, a coarse pointer, 200% zoom, greyscale, with hit areas, overflow and smallest text measured, and controls covered at their centre, drawn boxes reached by a neighbour's hit area and links inside sentences reported. |
| `tools/speed.mjs` | The shared speed harness: N runs at 4x CPU and Fast 4G, at a desktop layout (`fixtures/speed.json`) and a phone layout with touch (`fixtures/speed-phone.json`, every press and tap by touch events); every budget row: a press (judged by the fill actually painted), typing, crosshair (pointer and touch drag), toggles, a menu, the theme, a view whose data is not loaded, a query sent with its waiting state, response to paint, layout shift (including loads scrolled to each chart) and the worst interaction; `--compare` runs before and after alternating in one session; the load is recorded with every sample, and a timing row is judged only when most of its samples were taken at a load at or below the core count. |

`project/` is laid out so it can be published unchanged as the browsable reference.

## Using it

```
npm install       # the two parsers check.mjs uses (css-tree, parse5), as dev dependencies; Playwright comes from the machine
npm run build     # dist/: tokens.css, viz.css, viz-chart.js, viz-press.js, fonts, reference.html, preview/*.html, fixture/
npm run check     # tokens, structure, rendered audit, literal lint on the component CSS
node tools/check.mjs --no-render project/components reviews/system-v8/compositions   # lint previews and compositions
node tools/check.mjs ../app/src   # lint application code for literal values
npm test          # the chart rules as properties, and check.mjs against its corpus (VIZ_SLOW=1 for the browser mutants)
npm run audit     # every page at every width, zoom and pointer (--quick: four configurations)
node tools/mutants.mjs <scratch dir>   # the whole corpus as a table, on copies outside the tree
node tools/speed.mjs fixtures/speed-phone.json --compare <before>/dist/fixture/index.html   # the budgets, before and after alternating
node tools/shots.mjs scenario reviews/system-v8/shots.json <outDir>   # compositions, states, touch, zoom
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
- `reviews/system-v5/review.md`: **rejected** v5 on two blockers (a filtered-out series still
  returned grey, and a query edited and edited back greyed everything; the Table patterns scrolled
  the page sideways at 400 px and 200% zoom) and seven majors (the text form, open chart rules, the
  harness, the rubric, `check.mjs` passing 30 of 32 mutants, two compositions' figures).
- `reviews/system-v6/response.md`: v6, every v5 finding mapped to its change and to the check,
  test, image or measurement that shows it.
- `reviews/system-v6/review.md`: **rejected** v6 on two blockers (a folded list squeezed its key
  until pod names were drawn over the CPU figures and monitor names wrapped to five lines; the Chart
  README and the rubric gave two verdicts on two colour sequences) and one major (`check.mjs`: 17 of
  20 new mutants survived, lint gaps and later rules that override a guarded fix).
- `reviews/system-v7/response.md`: v7, every v6 finding mapped to its change and to the test, audit
  or image that shows it; the project lead's colour decision ("what a person sees wins").
- `reviews/system-v7/review.md`: **rejected** v7 on three majors, no blockers (a narrowed query in
  Explore left the series on screen grey beside colours reserved for series not in the result, with no
  way to colour them; single-unit number columns left-aligned in the Table preview and the folded-list
  composition; 12 of 13 new mutants survived, because each rendered guard ran in one context and a token
  redefined locally passed every check).
- `reviews/system-v8/response.md`: **v8, not yet reviewed.** Every v7 finding mapped to its change
  and to the test, audit or image that shows it; what was not done. Before and after images in
  `reviews/system-v8/compare/`, composed screens in `reviews/system-v8/images/`, compositions in
  `reviews/system-v8/compositions/`, speed in `reviews/system-v8/speed/`, runs in
  `reviews/system-v8/evidence/`.

## Not done yet

- No icon set. The rules say to use words until one is chosen ("Actions…" for a row's menu).
- Components are CSS classes with HTML previews; there is no React component package.
- The web app (`app/`) is on v4 and the flow screens (`flows/`) on v5 (`flows/REVISION.md`, "v5"); both
  are to be re-imaged on v8. Migration notes are in `reviews/system-v4/CHANGES.md`,
  `reviews/system-v5/response.md`, `reviews/system-v6/response.md`, `reviews/system-v7/response.md`
  and `reviews/system-v8/response.md` ("Migration": no class was renamed in v6, v7 or v8). The flow screens do not load `viz-press.js` yet, so
  the audit's press guard reports every one of them (reported apart, as their own gap).
- An outbound message (push, text, chat), stacked and bar charts and heatmaps are not specified; the
  Chart component says not to build them from it. A trace's spans (Waterfall) and log lines (Log) are
  their own components since v5.
- The budgets have been measured only on the system's own fixture page (a floor), on a shared
  machine whose load stayed above its core count in every session so far (v4 to v8), so every
  timing row is "not judged"; layout shift is judged and within budget at both layouts. The
  application has not been measured against the fixture. Behaviour other than the chart and the
  press (the Waterfall's tree, the Log's tail) ships as preview script only (flows G25).
- Fonts cover Latin, extended Latin and (mono) Greek and Cyrillic only.
- Not checked: a screen reader by ear, Safari and Firefox (the table's scroll edge uses a scroll
  timeline, which Safari and Firefox may not draw; the table still scrolls), real touch hardware,
  enlarged text as distinct from zoom.
