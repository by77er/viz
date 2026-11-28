A proposal shown as separate changes, each of which can be taken or left. `vz-changes`: a list of `vz-change` rows.

Each row, in order:

1. A `vz-check` whose label is a sign in mono (`+`, `~`, `−`), a verb (Add, Change, Remove) and the thing. The word carries the kind; the sign helps scanning; there is no colour.
2. `vz-change-why`: one sentence, starting "Why:".
3. `vz-diff`: "Before" and "After" side by side (one column below 640px). What was removed is struck through in `ink-muted` (`del`); what is new is strong on `rule` (`ins`). For a panel, the before and after are the panels themselves, drawn with the same data.
4. If a check found a problem with this change, a help line with the warn or critical mark that names it and links to what is affected.

Rules:

- Every change is selectable by itself. A change with a warning starts unselected and says so.
- The confirming button counts what is selected: "Apply 2 changes". With nothing selected it is disabled. Next to it, one sentence says what applying does and how to undo it ("Creates revision 15. You can restore revision 14.").
- Unrelated changes are separate rows, never bundled.
- When the proposal was written by an agent, the list sits under a `vz-claim-by` provenance line, and each "Why" is the agent's.
- States: selected, not selected, warned, applied (the row's checkbox is replaced by the acknowledged mark and "Applied in revision 15"), failed (a `vz-notice` under the row; the row stays selected).
