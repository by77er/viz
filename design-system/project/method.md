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

1. **Content first.** Write the real words and real numbers, with units. No placeholder text.
2. **Hierarchy with type and space only.** Use the type styles and the spacing scale until the reading order is right in greyscale.
3. **Structure.** Add `rule` lines where grouping is still ambiguous. Add `sunken` where something must recede.
4. **Colour last.** Add the one action colour the view needs, then status marks where state requires attention.
5. **States and waiting.** Design loading, empty, error and partial before calling the view done. For each wait, decide which row of the waiting table applies and what true thing the progress line will say.
6. **The second theme.** Check it; do not assume it.
7. **The text form.** Read the view's text digest aloud. If it does not make sense alone, the visual form is leaning on something a reader cannot see.

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
- Truncation never hides the part that distinguishes one item from another. Truncate in the middle for identifiers.
- Empty space is the same on both sides of a boundary unless the difference means something.
