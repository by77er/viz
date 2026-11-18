A control that does something now. Class `vz-button`; you provide a verb label.

- Default (no tone): a secondary action, `ink` on `ground` with a `rule-control` border.
- `data-tone="blue"`: the primary action. One per view.
- `data-tone="red"`: deletes or destroys. `data-tone="green"`: affirms. `data-tone="yellow"`: cautions.
- `data-quiet`: the least important action in a group, such as Cancel.
- `data-size="sm"` inside toolbars and banners. Do not stack small buttons in adjacent rows.

A press changes the fill to the `-pressed` token in the next frame, with no easing, so it shows even when the pointer was already over the button. While its work runs, set `aria-busy="true"`: the button keeps the pressed fill and ignores further presses. Put a keyboard hint (`vz-kbd`) inside the button when a shortcut exists. Do not use a button for navigation; use a link.
