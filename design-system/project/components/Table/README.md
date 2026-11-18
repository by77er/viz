Rows of comparable things. `vz-table` inside `vz-table-wrap`, with `vz-label` column heads on `sunken`.

- The identifying column is first, in `ui-strong` (`data-key`). If the row leads somewhere, the key holds the link, and **the link fills its cell**: the whole key cell is the target.
- Numbers are `vz-num`. A column of one unit is `vz-right` with the unit in its head ("p99, ms") and bare numbers in the cells. A column of mixed units ("912 ms", "4 min 10 s", "1.3%") is left-aligned, each cell with its unit (see Number).
- Rows are `row` tall and separated by `rule`; the hovered row is `hover`. No zebra striping, no vertical rules. **With a coarse pointer rows are `control-touch` tall**, so a link or control in a row has its 44px without reaching into the next row.
- State is a `vz-status`, never a coloured cell. Row actions go in a menu.
- **Sortable head**: a `button.vz-sort` inside the `th`; the `th` carries `aria-sort`. The sorted head is `ink` and strong with a triangle (up for ascending, down for descending); the triangle's space is always reserved, so sorting moves nothing. In a right-aligned column the triangle is on the left. Hover is `hover`, a press is `rule`, painted at once. Say the initial order under or above the table if it is not the first column's.
- **Wide table in a narrow region, two forms.** Choose per table:
  - *Scroll* (default): the wrap scrolls sideways and the first column stays in place. For tables people compare across many numeric columns.
  - *Fold* (`data-fold` on the table): below 640px of table width, columns marked `data-priority="1"` stay as columns beside the key (each `keep` wide), and every other column folds into a line under the key, in source order, each cell preceded by its `data-label` in `ink-muted`. Nothing is hidden and nothing needs a second tap. For lists a person reads row by row, especially on a phone: monitors, dashboards, keys. Mark as priority 1 the one or two columns the list exists for ("Now", "Threshold"), not the ones that are merely short.
  - Give a folding table explicit roles (`role="table"`, `row`, `columnheader`, `cell`), because the folded layout replaces the table display.
  - A row expander was considered and not used: it hides the columns behind a tap per row, which is the wrong cost for a person scanning a list at night.
- The page never scrolls sideways.
