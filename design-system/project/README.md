## Principles

1. **Clarity over character.** The interface exists so that someone can read a system's state and act. When a choice makes the data easier to read, take it, even if it is plainer.
2. **Everything present is justified.** Before adding an element, name the question it answers for the person looking at it. If removing it loses nothing, remove it. This applies to rules, labels, icons, colours and words alike.
3. **Colour is a signal, never a surface.** The interface is neutral. `blue`, `red`, `green` and `yellow` appear only where a person can act or where state needs attention.
4. **One voice.** A single sans family carries reading and interface text; a single monospace carries data. Hierarchy comes from size, weight and space.
6. **It answers at once, and it tells the truth.** Every input is acknowledged in the same frame. Anything slower says what it is doing, measured, and never pretends.
5. **Same model for every reader.** Each view has a visual form, a text form and a structured form. Design the text form with the same care.

## Colour

- Build every screen from `ground`, `sunken`, `ink`, `ink-secondary`, `ink-muted` and `rule`. A finished screen with no data on it should contain no colour at all.
- `ground` is the page. Use `sunken` for wells that recede: table heads, code, the query editor. Use `hover` for the row, item or quiet button under the pointer; it is a highlight in both themes and is never used for wells. Use `raised` only for overlays, always with `shadow-overlay`.
- Separate regions with `rule`. Give inputs and secondary buttons a `rule-control` border; it is the only border that has to be seen to be used.
- **Action colours.** `blue` is the primary action: at most one blue button in a view. `red` deletes or destroys. `green` affirms (resolve, acknowledge). `yellow` cautions (silence, snooze). Set their labels in `on-blue`, `on-red`, `on-green`, `on-yellow`. Each has a `-hover` and a darker `-pressed` fill, so a press shows even when the pointer was already over the button. The four values are the same in both themes.
- **Status marks** have their own tokens, `status-critical`, `status-warn`, `status-ok` and `status-info`, which are lighter in the dark theme so no state dominates. Each state also has its own shape (solid square, diamond, hollow square, bar; a dash for unknown), followed by a word in `ink`. Shape and word carry the state; colour reinforces it. Never colour the word. Button colours are not used for status, and status colours are not used for buttons.
- Do not tint backgrounds with action colours, do not use them for text, borders, icons or decoration, and never use a gradient.
- Links are `ink` with an underline. Selection is `ink` in `ui-strong` on `rule`, or with an `ink` underline for tabs and navigation. Selection is never inverted and never blue: choosing a view must not outrank the primary action.
- The focus ring is `stroke` wide in `focus`, offset by `stroke`, outside the element, on every focusable element.
- **Charts** take colour from `series-1` to `series-8`, in that order, assigned to the entity and kept when filters change. A ninth series folds into "Other". Series colours never appear outside a chart, and action colours never appear as series. Chart text is `ink-secondary` or `ink-muted`, never the series colour.

## Type

- Set interface and reading text in the `sans` family (Schibsted Grotesk), and every number a person compares or identifier they copy in `mono` (JetBrains Mono). Both are served from this system's own files, never from a third party. Preload the sans file in the page head (`<link rel="preload" as="font" type="font/woff2" crossorigin>`); it has a metric-matched fallback so text does not move when it arrives. The files cover Latin and extended Latin; the mono also covers Greek and Cyrillic. Other scripts fall back to the system font.
- Any number that is compared in a column or updates in place is set in `mono`, which is fixed-width, so it does not shift as it changes. The sans is not set to tabular figures: this face widens full stops, commas and colons to digit width when asked, which breaks prose.
- Component code uses the type styles as `var(--text-<name>)` and never writes a size. `micro` (mono, 11px) is the smallest text, for keyboard hints and chart axes.
- Use `ui` for interface text and `ui-strong` for button labels and selected items. Use `body` for prose, at a measure of 60 to 72 characters (`measure`).
- Use `display` at most once per page, for the name of the thing being looked at. Use `title` for page and dialog titles, `heading` for sections.
- Column heads and field labels use `label`: sentence case, weight 500, `ink-secondary`. Do not set text in capitals anywhere, and do not letter-space anything; the negative tracking in `display`, `title` and `heading` is part of those styles.
- Numbers in tables use `mono` with tabular figures and align right. Put the unit in the column head or after the number in `ink-secondary`, once. A single large figure (`vz-stat`) is the one exception: it uses the sans at `display` size, and its container reserves the width of its longest expected value so a changing figure does not move what is beside it.
- Weights are 400, 500 and 600 for the sans (500 only for `label`), 400 and 500 for the mono. No italics for emphasis.

## Space and shape

- Spacing comes from the scale: `space-half`, `space-1`, `space-2`, `space-3`, `space-4`, `space-6`, `space-8`, `space-12`. Relatedness is distance: `space-1` inside a control, `space-2` between related controls, `space-6` between panels, `space-8` between sections.
- Controls are `control-md` tall (`control-sm` in toolbars and rows). Table rows and menu items are `row` tall. Icons are `icon`.
- Radii by role: `radius-0` for anything that tiles (tables, panels), `radius-1` for marks inside controls, `radius-2` for controls, `radius-3` for overlays. Nothing is fully rounded.
- A panel is a region with a 1px `ink` rule above its title. It has no box, fill or shadow. Do not put a panel inside a panel.
- `shadow-overlay` is the only shadow, and it means "this floats".

## States

Every interactive element defines: rest, hover, focus-visible, pressed, disabled. Every data view defines: loading (keep the previous data visible), empty (say what was asked and that nothing matched), error (the message from the system, then what to change), partial (say what is missing).

Disabled controls use `ink-disabled` on `sunken`. Invalid fields take a `status-critical` border and a help line that starts with the critical mark and says, in `ink`, how to fix the value.

## Responsiveness and feedback

**Budgets.** These are requirements. Each is measured on the reference setup: a mid-range phone profile (4x CPU slowdown, Fast 4G), the fixture dashboard, the 75th percentile of 20 runs. A change that touches interaction reports them before and after.

| What the person does | The interface must | Limit |
|---|---|---|
| Presses, types, focuses, drags | Paint the pressed state, the character, the ring or the crosshair in the first frame after the input event | input delay plus processing at most 50 ms |
| Changes something local: chart / table / text, opens a menu, changes theme, switches to a tab whose data is already loaded | Finish. No waiting state is allowed | 100 ms |
| Moves to a view, or a tab, whose data is not loaded | Show the shell and anything cached, and the region's waiting state | 100 ms |
| Runs a query | Send the request and show the region's waiting state | 100 ms |
| Receives a result | Paint it; coarse data first, refined in place | 100 ms after it arrives |
| Interacts at all | Interaction to Next Paint | 200 ms |

The shell loads in at most 200 KB of compressed script. Layout shift stays under 0.05: every region reserves its final size before its data arrives, including on first load, when it shows its title and an empty plot area of the right height. Chart crosshairs and brushes follow the pointer without triggering layout. Fonts are self-hosted, so first paint never waits on another host.

**Feedback has to be meaningful, accurate and useful.**

- *Meaningful.* Give feedback only for a change the person caused or needs to know about. If the result is visible, the result is the feedback: no success toast, no checkmark animation. Nothing under 100 ms gets an indicator.
- *Accurate.* Never draw progress that is not measured. A bar needs a real numerator and denominator; without one, show the stage and elapsed time. Do not show skeleton shapes that differ from what will arrive. Do not present old data as current: say how old it is. An optimistic change is allowed only when it can be undone, and a failure is shown where the change was made, with the old value restored.
- *Useful.* Say what the system is doing in terms the person can act on ("Scanning 12 of 40 files"), and offer the next step (Cancel, Narrow the range, Retry). Keep the previous result visible and interactive while the next one loads. Keep focus and scroll position where they were.

**Waiting, by duration.**

| Wait | Show |
|---|---|
| under 100 ms | nothing but the result |
| 100 to 400 ms | nothing new in the region; the control that started it is `aria-busy`: it holds its pressed fill and ignores a second press |
| over 400 ms | `vz-progress` at the top of the region, kept at least 300 ms once shown |
| over 2 s | the same, plus Cancel |
| over 10 s | the same, plus the cheaper alternative (a shorter range, a rollup) |
| over 60 s | stop, keep what arrived, and say so: "Showing 31 of 40 files. 9 timed out." with Retry |

- **Automatic refresh never shows progress.** It replaces the data and the age in the panel head. If it fails, the old data stays and the age keeps growing; after three failures the panel head says "Not updating" with the reason.
- **Offline or stalled.** Say so once, at the top of the page, in a banner; keep everything already loaded usable; retry by itself and remove the banner when the connection returns.
- **Live tail** shows the newest line's time and a count of lines not yet shown when the person has scrolled away; it never moves the view by itself.

**Every form factor.**

- Lay out by the space a region has, not by device: panels reflow with container queries. Twelve columns from 1200px, six from 640px, one below.
- Nothing scrolls the page sideways. A wide table scrolls inside its own container with its first column fixed.
- With a coarse pointer every control has a `control-touch` hit area. Drawn sizes do not change, with two exceptions. Text inputs and selects become `control-touch` tall with `body`-size text, because smaller text makes mobile browsers zoom the page on focus. Tabs and navigation links gain `space-3` of vertical padding, because a scrolling strip clips any hit area larger than itself. Small controls are not stacked in adjacent rows, where their hit areas would overlap.
- Nothing depends on hover. Anything revealed on hover is also reachable by focus and by tap.
- Charts read by touch: drag for the crosshair, pinch or the range control to zoom. Charts are drawn at the size of their region; they are never scaled like images.
- The interface works at 200% zoom and with enlarged text.

## Motion

- A press changes state in the next frame, with no transition. Hover eases over `duration-fast`. Things that enter or leave (menus, dialogs) take `duration-slow`. The only curve is `ease`. Easing `cubic-bezier(0.2, 0, 0, 1)`.
- Animate opacity and position only. Nothing loops, bounces or draws attention to itself. Data never animates into place.
- Honour `prefers-reduced-motion` by removing transitions.

## Words

- Write from the reader's side: what happened, then what to do. "The query touched 2.1 million series and was stopped. Add a label matcher."
- Buttons are verbs that say what will happen: "Run query", "Delete dashboard". Not "OK", not "Submit".
- Sentence case everywhere. No exclamation marks, no emoji, no apologies.
- Numbers carry units. Times are relative under a day ("12 s ago") and absolute beyond it.
- State how complete a result is. If it was sampled, truncated or rolled up, say so next to it.

## Iconography

Use icons only where they are recognised faster than the word they replace, and pair them with a text label. One set, drawn at `icon` with a 1.5px stroke in the text colour beside them. No filled icons, no coloured icons, no emoji. This system ships no icon files yet; until it does, use words.

## Layout

- The page gutter is `space-6` on wide screens and `space-4` below 640px. Content is left-aligned. Nothing is centred except empty states.
- Dashboards are a 12-column grid (`vz-grid` in `vz-dashboard`) with `space-6` gaps, six columns below 1200px of dashboard width and one below 640px. Panels align to it; their titles share a baseline across a row.
- Density is a feature. Prefer showing more rows to adding space, as long as rows stay `row` tall and text stays at `ui` or `small`.
