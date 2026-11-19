# Method

How to design a change so that it can be reviewed against this system.

## Start from the question

Write one sentence: who is looking, and what are they trying to find out or do. Every later decision is checked against it. If you cannot write the sentence, the change is not ready to design.

## The presence test

For each element on the screen, in order from largest to smallest:

1. What question does it answer for the person in that sentence?
2. Is that question already answered by something else on the screen?
3. If it were removed, what would they be unable to do or know?

An element with no answer to 1, a yes to 2, or "nothing" to 3 is removed. Rules, labels, icons, colours, helper text and whitespace are all elements.

## Build order

1. **Content first.** Write the real words and real numbers, with units. No placeholder text. For a flow of several screens, fix one clock and one set of numbers per incident before drawing any of them, and write them down (the review input): the same event has the same time, and the same figure the same value, on every screen. Mark which words an agent wrote.
2. **Hierarchy with type and space only.** Use the type styles and the spacing scale until the reading order is right in greyscale.
3. **Structure.** Add `rule` lines where grouping is still ambiguous. Add `sunken` where something must recede.
4. **Colour last.** Add the one action colour the view needs, then status marks where state requires attention.
5. **States and waiting.** Design loading, empty, error and partial before calling the view done, and first run if the view can ever have had nothing. For every control: hover, pressed, focus, busy and disabled, and for an action someone else will see, its done state with undo. For each wait, decide which row of the waiting table applies, what true thing the progress line will say, and what the head says about the data still on screen ("Showing the previous query"). For a chart, design the many-series case (36 and 200 series), the one-series case, a filter applied and cleared, and the chart in greyscale, not only the three-series picture.
6. **The second theme.** Check it; do not assume it.
7. **Touch and narrow.** Lay the view out at 400px with a coarse pointer and at 200% zoom. Check that everything a pointer or a key can do has a tap (no Shift, no drag-only zoom, no hover), that the columns the view exists for are still visible without scrolling sideways, and that no hit area is under 44px or overlaps another. The main path of a flow is never a link inside a sentence: a link in a sentence is text, exempt from the touch height, so the main path is a standalone link or a button. Load the page at 400px scrolled to its lowest region and measure layout shift.
8. **The text form.** Read the view's text digest aloud. If it does not make sense alone, the visual form is leaning on something a reader cannot see.

## Hard rules

- Only token values. No literal colour, size, radius or duration in component code. If a value is missing, propose a token.
- One blue button per view.
- No new component when an existing one, composed, does the job.
- No decoration: no gradients, glows, background patterns, illustrative icons, or shadows other than `shadow-overlay`.
- Nothing that marks generated work: no gradient heroes, no emoji bullets, no pill badges on everything, no card with a coloured edge, no capitalised eyebrow above every heading, no centred everything.

## Details that are checked

- Text baselines align across a row. Numbers align right on the decimal.
- Optical alignment over mathematical: an icon sits on the text's x-height centre.
- Every hit target is at least 24px tall with a fine pointer, 32px for primary controls, and 44px with a coarse pointer.
- A press is visible in the same frame. Measure it; do not assume it.
- Focus order follows reading order, and the focus ring is visible on every surface.
- Truncation never hides the part that distinguishes one item from another. Truncate in the middle for identifiers, and drop labels that every item shares before cutting the ones that differ (Chart, "Names").
- Empty space is the same on both sides of a boundary unless the difference means something.
- Numbers and times agree across the screens of a flow and with the chart beside them; a stated age is the age of what is drawn.
- Labels on old data are true: while a new request waits, nothing in the head, legend or text form describes the request instead of what is drawn.

## Compose before judging

Components that look right alone fail together. Before review, render the change as full screens with `tools/shots.mjs scenario` (both themes, 1440 and 400px, coarse pointer, 200% zoom, greyscale, and the hover, pressed and focus states it touches), look at every image, fix what you see and render again. Measure what can be measured: hit areas, links inside sentences, covered controls and sideways overflow (`measure` in the scenario), every page at every width, zoom and pointer (`tools/audit.mjs`: overflow, escaping heads and cells, cut words, links in sentences, and figures, captions and ages that disagree with their data), contrast and reserved heights as rendered (`tools/check.mjs`), the chart rules as properties (`npm test`), speed at both layouts with the load recorded and before and after alternating (`tools/speed.mjs --compare`). After changing `check.mjs` or the chart rules, run `tools/mutants.mjs` (on a copy outside the tree; it never edits it) and add a mutant for what you fixed. Mark every figure a composition shows that comes from a chart with `data-figure`, and figures shown twice with `data-same`, so the audit checks they agree. Measure what only shows when composed: every word hit-tested where it is drawn (`overlap`), every folded key against `key-min`, every fix by its rendered behaviour (the audit's guards) and every value against the tokens it should move with (the audit's token trace). `reviews/system-v7/` is a worked example.
