# viz design system

The ground truth for how viz looks and behaves. Design changes are reviewed against it.

| Path | Contents |
|---|---|
| `project/tokens.json` | Every value: colours in both themes, type styles, spacing, radii, the one shadow, sizes. The single source. |
| `project/README.md` | The rules: colour, type, space and shape, states, motion, words, iconography, layout. |
| `project/method.md` | How to design a change: the question, the presence test, build order, hard rules. |
| `project/review.md` | The review process and rubric. |
| `project/components/` | `bundle.css` (component classes, token values only) and, per component, guidelines and a live preview. |
| `tools/build.mjs` | Generates `dist/tokens.css` and `dist/viz.css` from the tokens. |
| `tools/check.mjs` | Contrast of every text and control pairing in both themes, and a lint for literal colours. Pass paths to lint other code. |
| `tools/reference.mjs` | Builds `dist/reference.html`: every component in both themes on one page. |
| `tools/shots.mjs` | Captures a view in both themes at 1440 and 400 px, and composes before/after images. |

`project/` is laid out so it can be published unchanged as the browsable reference.

## Using it

```
npm run build     # dist/tokens.css, dist/viz.css, dist/reference.html
npm run check     # contrast + literal-colour lint on the component CSS
node tools/check.mjs ../app/src   # lint application code for literal colours
```

Application code loads `dist/viz.css`, puts `class="vz"` on its root, and uses the token
custom properties (`var(--ink)`, `var(--space-4)`) and component classes (`vz-button`).
The theme follows the system setting; set `data-theme="light"` or `"dark"` on the root to
override it.

## Position

- **Neutral interface, true greys.** The neutrals have no hue, so the only colour on a
  screen is data, state, or something to press.
- **Four action colours at full strength**: blue, red, green, yellow, the same in both
  themes. They also mark state, always beside a word.
- **One serif voice.** Source Serif 4 for interface and reading text, using its optical-size
  axis from captions to display; Source Code Pro, its sibling, for data. Two families, each
  with one job.
- **Small radii, hairlines, one shadow.** Shape says what kind of thing something is:
  square tiles, 4px controls, 8px overlays.
- **Small caps instead of capitals** for column heads and labels, sized to the lowercase
  beside them.

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

## Not done yet

- No icon set. The rules say to use words until one is chosen.
- Components are CSS classes with HTML previews; there is no React component package.
- The web app (`app/`) was started before this system existed and does not use it yet.
  Applying it is the first change to go through design review.
- Charts: the series palette and mark rules are defined; heatmap, flame graph and trace
  waterfall are not specified.
- The review has not been exercised on a real change.
