What happened to one thing, in order. An `ol` with class `vz-timeline`; each `li` holds a `time` (`vz-qty`), a `vz-mark` and a `p`.

- Newest first when the page is about now (a firing monitor); oldest first when it is a record (an investigation's steps). Say which in the section title if it is not obvious.
- The time column is one format for the whole list: clock times within a day, dates beyond. The times are the same ones the page head and the chart markers use: one event has one time everywhere.
- The mark is the status mark of the event (fired: critical; pending: warn; a deploy or note: info; acknowledged: ack; silenced: silenced; no state: the dash).
- The sentence says what happened and what followed from it ("Fired at 548 ms. Paged Dana."). A value in it takes `vz-qty`.
- A line written by an agent carries `vz-agent`, starts with "Agent:" and says whether a person has verified it.
- Use it for events that are not comparable row by row. If every event has the same fields and people sort or scan a column, it is a table.
