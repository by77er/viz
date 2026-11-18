Work that takes long enough to notice, reported as it actually is. `vz-progress`: a `stroke`-high track, a bar whose length is a measured fraction, and a line with what is being done, the elapsed time, and one action.

- Show it only after 400 ms of waiting. Once shown, keep it for at least 300 ms so it never flashes. Never show it for an automatic refresh; update the panel's age instead.
- The bar is drawn only when there is a real numerator and denominator (files, shards, bytes), and its length is exactly that fraction, including when work stops early. Without one, add `data-unmeasured`: there is no track at all, and the sentence and the running time are the indicator.
- The sentence names the work in terms the person can act on: "Scanning 12 of 40 files", not "Loading". It is the live region (`role="status"`) and changes only when the stage changes; the elapsed time is `aria-hidden` so it is not announced every tick.
- The action is Cancel from 2 s, and Retry when work ended incomplete.
- It sits at the top edge of the region it describes, as the first child of `vz-panel-body`, where it lies over the body's top edge: no space is reserved for it, and nothing moves when it appears or goes. The previous result stays visible and usable beneath it, and the panel head says "Showing the previous query" (see Panel).
- When Cancel is pressed, focus moves to the action that replaces it (Retry).
