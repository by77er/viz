Work that takes long enough to notice, reported as it actually is. `vz-progress`: a `stroke`-high track, a bar whose length is a measured fraction, and a line with what is being done, the elapsed time, and one action.

- Show it only after 400 ms of waiting. Once shown, keep it for at least 300 ms so it never flashes. Never show it for an automatic refresh; update the panel's age instead.
- The bar is drawn only when there is a real numerator and denominator (files, shards, bytes), and its length is exactly that fraction, including when work stops early. Without one, add `data-unmeasured`: there is no track at all, and the sentence and the running time are the indicator.
- The sentence names the work in terms the person can act on: "Scanning 12 of 40 files", not "Loading". It is the live region (`role="status"`) and changes only when the stage changes; the elapsed time is `aria-hidden` so it is not announced every tick.
- The action is Cancel from 2 s, and Retry when work ended incomplete.
- It sits at the top of the region it describes, as the first child of `vz-panel-body`, where it lies over the view's top strip (a chart's marker words, a table's caption; see Panel): no space is reserved for it, nothing moves when it appears or goes, and it never covers data, a unit or a column head. The previous result stays visible and usable beneath it, and the panel head says "Showing the previous query" (see Panel).
- When Cancel is pressed, focus moves to the action that replaces it (Retry).
