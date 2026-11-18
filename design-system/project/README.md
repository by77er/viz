## Principles

1. **Clarity over character.** The interface exists so that someone can read a system's state and act. When a choice makes the data easier to read, take it, even if it is plainer.
2. **Everything present is justified.** Before adding an element, name the question it answers for the person looking at it. If removing it loses nothing, remove it. This applies to rules, labels, icons, colours and words alike.
3. **Colour is a signal, never a surface.** The interface is neutral. `blue`, `red`, `green` and `yellow` appear only where a person can act or where state needs attention.
4. **One voice.** A single sans family carries reading and interface text; a single monospace carries data. Hierarchy comes from size, weight and space.
5. **It answers at once, and it tells the truth.** Every input is acknowledged in the same frame. Anything slower says what it is doing, measured, and never pretends. Words about data describe the data on screen, never the request in flight.
6. **Same model for every reader.** Each view has a visual form, a text form and a structured form. Design the text form with the same care.

## Colour

- Build every screen from `ground`, `sunken`, `ink`, `ink-secondary`, `ink-muted` and `rule`. A finished screen with no data on it should contain no colour at all.
- `ground` is the page. Use `sunken` for wells that recede: table heads, code, the query editor. Use `hover` for the row, item or quiet button under the pointer; it is a highlight in both themes and is never used for wells. Use `pressed` for an untoned control while it is held down or busy, and `rule` for what is chosen (a segment, a legend row): a press must look different from both. Use `raised` only for overlays, always with `shadow-overlay`, and `scrim` only behind a dialog.
- Separate regions with `rule`. Give inputs and secondary buttons a `rule-control` border; it is the only border that has to be seen to be used.
- **Action colours.** `blue` is the primary action: at most one blue button in a view. `red` deletes or destroys. `green` affirms (resolve, acknowledge). `yellow` cautions (silence, snooze). Set their labels in `on-blue`, `on-red`, `on-green`, `on-yellow`. Each has a `-hover` and a darker `-pressed` fill, so a press shows even when the pointer was already over the button. The four values are the same in both themes.
- **Status marks** have their own tokens, `status-critical`, `status-warn`, `status-ok` and `status-info`, which are lighter in the dark theme so no state dominates. Each state also has its own shape (solid square, diamond, hollow square, bar; a dash for unknown), followed by a word in `ink`. Shape and word carry the state; colour reinforces it. Never colour the word. Button colours are not used for status, and status colours are not used for buttons: `status-info` is a cyan, never the action blue.
- **What a person has done** about a state is neutral, in `ink-secondary` or `ink-muted`, with its own shape and word: acknowledged (half-filled square), silenced (two bars), ruled out (a slash). The severity colour stays only while nobody has the problem (Status).
- Do not tint backgrounds with action colours, do not use them for text, borders, icons or decoration, and never use a gradient.
- Links are `ink` with an underline. Selection is `ink` in `ui-strong` on `rule`, or with an `ink` underline for tabs and navigation. Selection is never inverted and never blue: choosing a view must not outrank the primary action.
- The focus ring is `stroke` wide in `focus`, offset by `stroke`, outside the element, on every focusable element.
- **Charts** take colour from `series-1` to `series-8`. The order is fixed and the colour belongs to the series: a view hands out slots in palette order as series first appear in it (largest first), and a series keeps its slot for the life of the view, through filters, sorts, range changes and reloads; a shared link carries the map. Past eight, the rest are ONE "Other" entry in `series-other`: one band, one legend row, never a line or a row per folded series. All nine pass 3:1 on `ground`, `raised` and `sunken` in both themes and the eight pass the colour-vision validator as an ordered set; they are never drawn on `hover`, `rule` or `pressed` (the legend swatch carries its own `ground` edge). Series colours never appear outside a chart and its legend, and action and status colours never appear as series. Chart text is `ink-secondary` or `ink-muted`, never the series colour. The full rules, with the algorithm, are in Chart.

## Type

- Set interface and reading text in the `sans` family (Schibsted Grotesk), and every number a person compares or identifier they copy in `mono` (JetBrains Mono). Both are served from this system's own files, never from a third party. Preload the sans file in the page head (`<link rel="preload" as="font" type="font/woff2" crossorigin>`); it has a metric-matched fallback so text does not move when it arrives. The files cover Latin and extended Latin; the mono also covers Greek and Cyrillic. Other scripts fall back to the system font.
- Any number that is compared in a column or updates in place is set in `mono`, which is fixed-width, so it does not shift as it changes. The sans is not set to tabular figures: this face widens full stops, commas and colons to digit width when asked, which breaks prose.
- A number with its unit inside a sentence is one `vz-qty`: mono at `data` size on the sentence's own line, unbreakable, with a thin space before the unit. Never `vz-num` inside prose: its full-width space and taller line open gaps in the sentence (Number).
- Component code uses the type styles as `var(--text-<name>)` and never writes a size. `micro` (mono, 11px) is the smallest text, for keyboard hints and chart axes.
- Use `ui` for interface text and `ui-strong` for button labels and selected items. Use `body` for prose, at a measure of 60 to 72 characters (`measure`).
- Use `display` at most once per page, for the name of the thing being looked at. Use `title` for page and dialog titles, `heading` for sections.
- Column heads and field labels use `label`: sentence case, weight 500, `ink-secondary`. Do not set text in capitals anywhere, and do not letter-space anything; the negative tracking in `display`, `title` and `heading` is part of those styles.
- Numbers in tables use `mono` and align right. Put the unit in the column head, once, and leave the cells bare. The one exception is a column whose cells have different units ("912 ms", "4 min 10 s", "1.3%"): it is left-aligned, each cell with its own unit. A single large figure (`vz-stat`) is the one exception: it uses the sans at `display` size, and its container reserves the width of its longest expected value so a changing figure does not move what is beside it.
- Weights are 400, 500 and 600 for the sans (500 only for `label`), 400 and 500 for the mono. No italics for emphasis.

## Space and shape

- Spacing comes from the scale: `space-half`, `space-1`, `space-2`, `space-3`, `space-4`, `space-6`, `space-8`, `space-12`. Relatedness is distance: `space-1` inside a control, `space-2` between related controls, `space-6` between panels, `space-8` between sections.
- Rows of controls that can wrap are `vz-controls` and stacks of form controls are `vz-stack`, never hand-laid flex rows: wrapped rows are at least `space-3` apart (more with a coarse pointer), and two toned buttons in one row are `space-6` apart, so a slip never reaches a destructive or cautionary action.
- Controls are `control-md` tall (`control-sm` in toolbars and rows). Table rows and menu items are `row` tall. Icons are `icon`.
- Radii by role: `radius-0` for anything that tiles (tables, panels), `radius-1` for marks inside controls, `radius-2` for controls, `radius-3` for overlays. Nothing is fully rounded.
- A panel is a region with a 1px `ink` rule above its title. It has no box, fill or shadow. Do not put a panel inside a panel.
- `shadow-overlay` is the only shadow, and it means "this floats".

## States

Every interactive element defines: rest, hover, focus-visible, pressed, disabled, and busy if it starts work. That includes the small ones: legend rows, sortable heads, menu rows, quiet buttons, a link. A press is `pressed` (or the tone's `-pressed`), painted in the next frame, never eased, and it outranks hover. Busy (`aria-busy`) holds the pressed fill, never eases, and ignores a second press. A choice that holds (a checked menu row, a chosen segment or legend row) is marked by weight and a tick or underline on `rule`, never blue.

Every data view defines: loading (keep the previous data visible), empty (say what was asked and that nothing matched), error (the message from the system, then what to change), partial (say what is missing). A page that has never had data is a first run, not an empty state (FirstRun). A background action that failed after the person looked away is a failure notice at the control that started it (Notice).

Disabled controls use `ink-disabled` on `sunken`. Invalid fields take a `status-critical` border and a help line that starts with the critical mark and says, in `ink`, how to fix the value.

**Chrome that describes data belongs to the data on screen.** A panel's title, unit, range, step, legend, accessible name and text form come from the result that is drawn. While a different query waits, or after it was cancelled or failed, the head says "Showing the previous query" and everything else stays the previous query's. An age is the age of what is shown.

## Responsiveness and feedback

**Budgets.** These are requirements. Each is measured on the reference setup with `tools/speed.mjs`: a mid-range phone profile (4x CPU slowdown, Fast 4G), the fixture dashboard (`fixtures/`), the 75th percentile of 20 runs, with the worst run reported beside it. The fixture includes a 36-series and a 200-series chart; a figure measured only on a few series is not a pass. A change that touches interaction reports them before and after, and says whether each number was measured on the system's fixture page (a floor) or on the application.

| What the person does | The interface must | Limit |
|---|---|---|
| Presses, types, focuses, drags | Paint the pressed state, the character, the ring or the crosshair in the first frame after the input event. Typing is measured in the real editor, key by key | input delay plus processing at most 50 ms |
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
| over 400 ms | `vz-progress` over the top strip of the region (below), kept at least 300 ms once shown; the panel head says "Showing the previous query" if the query changed |
| over 2 s | the same, plus Cancel |
| over 10 s | the same, plus the cheaper alternative (a shorter range, a rollup) |
| over 60 s | stop, keep what arrived, and say so: "Showing 31 of 40 files. 9 timed out." with Retry |

- **Where the waiting line goes.** Every view in a panel starts with a `space-6` strip of words about the data, never the data: a chart's strip above the plot (marker words), a table's caption (count and order). The waiting line lies over that strip, right of a chart's value axis. Nothing is reserved for it alone, nothing moves when it comes or goes, and it never covers data, a unit, a tick or a column head.
- **Automatic refresh never shows progress.** It replaces the data and the age in the panel head. If it fails, the old data stays and the age keeps growing; after three failures the panel head says "Not updating" with the reason.
- **Offline or stalled.** Say so once, at the top of the page, in a banner; keep everything already loaded usable; retry by itself and remove the banner when the connection returns.
- **Live tail** shows the newest line's time and a count of lines not yet shown when the person has scrolled away; it never moves the view by itself.

**Every form factor.**

- Lay out by the space a region has, not by device: panels reflow with container queries. Twelve columns from 1200px, six from 640px, one below.
- Nothing scrolls the page sideways. A wide table scrolls inside its own container with its first column fixed.
- With a coarse pointer every control has a `control-touch` hit area, with no overlap. Drawn sizes do not change, with these exceptions, each because a hit area cannot reach past its own box there. Text inputs, selects, `data-mono` inputs and the query well become `control-touch` tall with `body`-size text, because smaller text makes mobile browsers zoom the page on focus. Tabs and navigation links gain `space-3` of vertical padding, because a scrolling strip clips any hit area larger than itself. Table rows, legend rows, menu rows and checkboxes become `control-touch` tall, so neighbouring targets cannot overlap; a row's key link fills its cell. A link that stands alone is a control and gets the touch height; a link inside a sentence is text and keeps its line.
- Wrapped rows of controls keep their hit areas apart (`vz-controls`, `vz-stack`). Small controls are not stacked in adjacent rows by hand.
- Nothing depends on hover or on a modifier key a phone lacks. Anything revealed on hover is also reachable by focus and by tap; anything done with Shift or a drag has a button.
- Charts read by touch as well as by pointer: drag for the crosshair, "Zoom in" and "Zoom out" buttons, a tap on a legend row toggles that series. The readout is under the plot, never over it. Charts are drawn at the size of their region with fixed text sizes; they are never scaled like images.
- A table that a person reads row by row (monitors, dashboards, keys) folds below 640px of width: its key and its one or two priority columns stay as columns and the rest become a second line under the key (Table). A table people compare across many numeric columns scrolls inside its region with the first column fixed.
- The interface works at 200% zoom and with enlarged text.

## Motion

- A press changes state in the next frame, with no transition. Hover eases over `duration-fast`. Things that enter or leave (menus, dialogs) take `duration-slow`. The only curve is `ease`. Easing `cubic-bezier(0.2, 0, 0, 1)`.
- Animate opacity and position only. Nothing loops, bounces or draws attention to itself. Data never animates into place.
- Honour `prefers-reduced-motion` by removing transitions.

## Words

- Write from the reader's side: what happened, then what to do. "The query touched 2.1 million series and was stopped. Add a label matcher."
- Buttons are verbs that say what will happen: "Run query", "Delete dashboard". Not "OK", not "Submit".
- Sentence case everywhere. No exclamation marks, no emoji, no apologies.
- Numbers carry units. Ages are "just now" under 5 s, then seconds, minutes and hours ("12 s ago", "14 min ago", "3 h ago"), and the absolute time beyond a day ("17 Nov, 09:30"). Never "0 s ago". Minutes are "min", never "m". Durations have at most two parts, largest first: "2 h 9 min".
- One event has one time everywhere: the page head, the list, the chart marker and the timeline say the same "13:07", and figures shown together agree with each other.
- State how complete a result is. If it was sampled, truncated or rolled up, say so next to it.
- **Anything an agent wrote says so where it is read**, not once per page: a claim carries "Agent's claim" and "Not verified" until a person confirms it, and links to the query behind it; a shorter sentence starts "Agent:". Agent text is marked by a `stroke` rule down its left edge in `ink-muted`, which nothing else uses (Claim). It never appears as a status word, a stat, a title or a measured figure without that marking.

## Iconography

Use icons only where they are recognised faster than the word they replace, and pair them with a text label. One set, drawn at `icon` with a 1.5px stroke in the text colour beside them. No filled icons, no coloured icons, no emoji. This system ships no icon files yet; until it does, use words.

## Layout

- The page gutter is `space-6` on wide screens and `space-4` below 640px (`vz-page`, and the navigation's own gutter). Content is left-aligned. Nothing is centred except a dialog on its scrim.
- A page starts with `vz-page-head`: the title, a state line for a thing that has a state, a sub-line that says how fresh the page is, and the actions, which drop below the title as one row rather than squeeze it (PageHeader).
- Dashboards are a 12-column grid (`vz-grid` in `vz-dashboard`) with `space-6` gaps, six columns below 1200px of dashboard width and one below 640px. Panels align to it; their titles share a baseline across a row.
- Density is a feature. Prefer showing more rows to adding space, as long as rows stay `row` tall and text stays at `ui` or `small`.
