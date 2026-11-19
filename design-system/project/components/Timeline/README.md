What happened to one thing, in order. An `ol` with class `vz-timeline`; each `li` holds a `time` (`vz-qty`), a `vz-mark`, a `p`, and at most one standalone `vz-link` after the `p`.

- Newest first when the page is about now (a firing monitor); oldest first when it is a record (an investigation's steps). Say which in the section title if it is not obvious.
- The time column is one format for the whole list: clock times within a day, dates beyond. The times are the same ones the page head and the chart markers use: one event has one time everywhere.
- The mark is the status mark of the event (fired: critical; pending: warn; a deploy, a note, a notification sent or an escalation: info; acknowledged: ack; silenced: silenced; written by an agent: agent; no state: the dash).
- The sentence says what happened and what followed from it ("Fired at 548 ms. Paged Dana."). A value in it takes `vz-qty`.
- **A line may end with one link to what it describes** ("Read the report", "See the change"). It stands alone under the sentence, never inside it: it is often the main path of the flow (the agent's report in a firing monitor's history), so it is a control with a whole hit area, 44px with a coarse pointer. A sentence holds no links.
- A line written by an agent has the `agent` mark (the agent's rule, in the mark column, so it is not stacked on another mark), starts with "Agent:" and says whether a person has verified it.
- Use it for events that are not comparable row by row. If every event has the same fields and people sort or scan a column, it is a table.
