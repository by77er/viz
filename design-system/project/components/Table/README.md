Rows of comparable things. `vz-table` inside `vz-table-wrap`, with `vz-label` column heads on `sunken`.

- The wrap scrolls sideways when the table is wider than its region; the first column stays in place. The page never scrolls sideways.
- The identifying column is first, in `ui-strong` (`data-key`).
- Numbers are `vz-num vz-right`: monospace, tabular, right-aligned, with the unit in the head or after the value.
- Rows are `row` tall and separated by `rule`; the hovered row is `hover`. No zebra striping, no vertical rules.
- State is a `vz-status`, never a coloured cell. Do not put `control-sm` controls in adjacent rows: their touch areas would overlap. Put row actions in a menu.
