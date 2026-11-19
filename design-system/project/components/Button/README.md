A control that does something now. Class `vz-button`; you provide a verb label.

- Default (no tone): a secondary action, `ink` in `ui` on `ground` with a `rule-control` border.
- `data-tone="blue"`: the primary action. One per view. Toned buttons are `ui-strong`, so the action outranks the tools beside it.
- `data-tone="red"`: deletes or destroys. `data-tone="green"`: affirms. `data-tone="yellow"`: cautions, and in a menu that confirms a cautionary choice (Menu).
- `data-quiet`: the least important action in a group, such as Cancel. Its press is `pressed`, like any untoned button, and outranks its hover.
- `data-size="sm"` inside toolbars, chart feet, banners and table rows, so the tools never outrank the data.
- Lay buttons out with `vz-controls` (see Controls): it keeps wrapped rows apart and toned buttons `space-6` from each other. A yellow button carries a `yellow-edge` border.
- An `a` may carry `vz-button` when it navigates and must look like a button (a first-run step); it is never underlined.

A press changes the fill to the `-pressed` token (`pressed` for an untoned button) in the next frame, with no easing, so it shows even when the pointer was already over the button. While its work runs, set `aria-busy="true"`: the button takes the pressed fill at once (busy never eases, whether it started from a pointer or a key) and ignores further presses. `aria-disabled="true"` looks like `disabled` but keeps the button focusable when it must explain itself.

**Done, with undo** (`vz-done`). An action someone else will see (Acknowledge, Silence, Confirm claim, Apply) replaces its button, in place, with what is now true and the way back: `<span class="vz-done"><span class="vz-status" data-state="ack">Acknowledged by you at 15:16</span><button class="vz-button" data-size="sm">Undo</button></span>`. It is at least `control-md` tall (`control-touch` with a coarse pointer), so nothing beside it moves; focus moves to Undo; the state word follows Status. For a silence the way back is "End silence". If the server refuses, the original button returns with a Notice under it.

Keyboard shortcuts are shown in menus and tooltips (`vz-kbd`), never inside a button: the label is the verb, and a chip in the primary action is decoration. Do not use a button for navigation; use a link.
