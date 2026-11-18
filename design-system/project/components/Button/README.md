A control that does something now. Class `vz-button`; you provide a verb label.

- Default (no tone): a secondary action, `ink` on `ground` with a `rule-control` border.
- `data-tone="blue"`: the primary action. One per view.
- `data-tone="red"`: deletes or destroys. `data-tone="green"`: affirms. `data-tone="yellow"`: cautions.
- `data-quiet`: the least important action in a group, such as Cancel.
- `data-size="sm"` inside toolbars and table rows.

Put a keyboard hint (`vz-kbd`) inside the button when a shortcut exists. Do not use a button for navigation; use a link.
