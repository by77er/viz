What a page shows when it has never had anything to show: no data sent, no dashboards, no monitors. `vz-start`: a `vz-section-title` that says what is missing, one sentence that says what will appear and how soon, and `vz-steps`, a short numbered list of what to do.

- It is different from `vz-empty`. Empty answers "your question matched nothing" and offers a change to the question. First run answers "there is nothing here yet" and shows how to make the first thing.
- Each step is a sentence and, where it helps, the control or the text to copy: a button, a `vz-query` with "Copy". At most four steps. The first step that can be done here carries the page's one blue button.
- The last step says truthfully what the system is waiting for and when it last looked ("No samples received yet. Checked 3 s ago."), with an unmeasured `vz-progress` line. When the first sample arrives the block is replaced by the data and by a link to the first useful view ("See it in Explore"); nothing celebrates.
- It is left-aligned at the top of the region, `measure` wide, with no illustration.
- A list page with no items (Dashboards, Monitors) uses the same block with one step: what the thing is for, and the button that makes one.
- States: nothing yet, waiting (key made, no samples), first data arrived (replaced), and failed to check (the line says "Could not check. Retrying in 10 s.").
