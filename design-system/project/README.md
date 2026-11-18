## Principles

1. **Clarity over character.** The interface exists so that someone can read a system's state and act. When a choice makes the data easier to read, take it, even if it is plainer.
2. **Everything present is justified.** Before adding an element, name the question it answers for the person looking at it. If removing it loses nothing, remove it. This applies to rules, labels, icons, colours and words alike.
3. **Colour is a signal, never a surface.** The interface is neutral. `blue`, `red`, `green` and `yellow` appear only where a person can act or where state needs attention.
4. **One voice.** A single serif family carries reading and interface text; a single monospace carries data. Hierarchy comes from size, weight and space.
5. **Same model for every reader.** Each view has a visual form, a text form and a structured form. Design the text form with the same care.

## Colour

- Build every screen from `ground`, `sunken`, `ink`, `ink-secondary`, `ink-muted` and `rule`. A finished screen with no data on it should contain no colour at all.
- `ground` is the page. Use `sunken` for wells that recede: table heads, code, hovered rows. Use `raised` only for overlays, always with `shadow-overlay`.
- Separate regions with `rule`. Give inputs and secondary buttons a `rule-control` border; it is the only border that has to be seen to be used.
- **Action colours.** `blue` is the primary action: at most one blue button in a view. `red` deletes or destroys. `green` affirms (resolve, acknowledge). `yellow` cautions (silence, snooze). Set their labels in `on-blue`, `on-red`, `on-green`, `on-yellow`. The four values are the same in both themes.
- **Status marks.** The same four hues mark state: `red` critical, `yellow` warning, `green` healthy, `blue` informational. A status is an 8px square in that colour followed by a word in `ink`. Never colour the word, and never rely on the square alone.
- Do not tint backgrounds with action colours, do not use them for text, borders, icons or decoration, and never use a gradient.
- Links are `ink` with an underline. Selection is `ink` on `sunken` in weight 600, or an inverted segment (`ink` fill, `ground` text). Selection is not blue.
- The focus ring is 2px `focus`, offset 2px, on every focusable element.
- **Charts** take colour from `series-1` to `series-8`, in that order, assigned to the entity and kept when filters change. A ninth series folds into "Other". Series colours never appear outside a chart, and action colours never appear as series. Chart text is `ink-secondary` or `ink-muted`, never the series colour.

## Type

- Set interface and reading text in the `serif` family, and every number a person compares or identifier they copy in `mono`.
- Use `ui` for interface text and `ui-strong` for button labels and selected items. Use `body` for prose, at a measure of 60 to 72 characters (`measure`).
- Use `display` at most once per page, for the name of the thing being looked at. Use `title` for page and dialog titles, `heading` for sections.
- Column heads and field labels use `label`: true small caps, tracked 0.05em, sized so the capitals match the lowercase height of `ui` text. It is the only tracked style. Do not set text in capitals anywhere.
- Numbers in tables and stats use tabular lining figures and align right. Put the unit in the column head or after the number in `ink-secondary`, once.
- Weights are 400 and 600 for the serif, 400 and 500 for the mono. No other weights, no italics for emphasis in the interface (italic is for titles of things in prose).
- Let the optical size axis follow the font size. Do not letter-space anything except `label` and the negative tracking built into `display`, `title` and `heading`.

## Space and shape

- Spacing comes from the scale: `space-half`, `space-1`, `space-2`, `space-3`, `space-4`, `space-6`, `space-8`, `space-12`. Relatedness is distance: `space-1` inside a control, `space-2` between related controls, `space-6` between panels, `space-8` between sections.
- Controls are `control-md` tall (`control-sm` in toolbars and rows). Table rows and menu items are `row` tall. Icons are `icon`.
- Radii by role: `radius-0` for anything that tiles (tables, panels), `radius-1` for marks inside controls, `radius-2` for controls, `radius-3` for overlays. Nothing is fully rounded.
- A panel is a region with a 1px `ink` rule above its title. It has no box, fill or shadow. Do not put a panel inside a panel.
- `shadow-overlay` is the only shadow, and it means "this floats".

## States

Every interactive element defines: rest, hover, focus-visible, pressed, disabled. Every data view defines: loading (keep the previous data visible), empty (say what was asked and that nothing matched), error (the message from the system, then what to change), partial (say what is missing).

Disabled controls use `ink-disabled` on `sunken`. Invalid fields take a `red` border and a help line in `ink` that says how to fix the value.

## Motion

- 100ms for changes the pointer causes (hover, press). 180ms for things that enter or leave (menus, dialogs). Easing `cubic-bezier(0.2, 0, 0, 1)`.
- Animate opacity and position only. Nothing loops, bounces or draws attention to itself. Data never animates into place.
- Honour `prefers-reduced-motion` by removing transitions.

## Words

- Write from the reader's side: what happened, then what to do. "The query touched 2.1 million series and was stopped. Add a label matcher."
- Buttons are verbs that say what will happen: "Run query", "Delete dashboard". Not "OK", not "Submit".
- Sentence case everywhere. No exclamation marks, no emoji, no apologies.
- Numbers carry units. Times are relative under a day ("12 s ago") and absolute beyond it.
- State how complete a result is. If it was sampled, truncated or rolled up, say so next to it.

## Iconography

Use icons only where they are recognised faster than the word they replace, and pair them with a text label or tooltip. One set, drawn at `icon` with a 1.5px stroke in the text colour beside them. No filled icons, no coloured icons, no emoji. This system ships no icon files yet; until it does, use words.

## Layout

- The page gutter is `space-6` on wide screens and `space-4` below 640px. Content is left-aligned. Nothing is centred except empty states.
- Dashboards are a 12-column grid with `space-6` gaps. Panels align to it; their titles share a baseline across a row.
- Density is a feature. Prefer showing more rows to adding space, as long as rows stay `row` tall and text stays at `ui` or `small`.
