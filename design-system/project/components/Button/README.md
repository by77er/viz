A control that does something now. Class `vz-button`; you provide a verb label.

- Default (no tone): a secondary action, `ink` on `ground` with a `rule-control` border.
- `data-tone="blue"`: the primary action. One per view.
- `data-tone="red"`: deletes or destroys. `data-tone="green"`: affirms. `data-tone="yellow"`: cautions.
- `data-quiet`: the least important action in a group, such as Cancel. Its press is `pressed`, like any untoned button, and outranks its hover.
- `data-size="sm"` inside toolbars, chart feet and banners, so the tools never outrank the data.
- Lay buttons out with `vz-controls` (see Controls): it keeps wrapped rows apart and toned buttons `space-6` from each other. A yellow button carries a `yellow-edge` border.

A press changes the fill to the `-pressed` token (`pressed` for an untoned button) in the next frame, with no easing, so it shows even when the pointer was already over the button. While its work runs, set `aria-busy="true"`: the button takes the pressed fill at once (busy never eases, whether it started from a pointer or a key) and ignores further presses. Put a keyboard hint (`vz-kbd`) inside the button when a shortcut exists. Do not use a button for navigation; use a link.
