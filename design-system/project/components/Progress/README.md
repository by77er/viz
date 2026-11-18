Work that takes long enough to notice, reported as it actually is. `vz-progress`: a 2px track, a bar whose length is a measured fraction, and one line that says what is being done, with elapsed time at the right.

- Show it only after 400 ms of waiting. Once shown, keep it for at least 300 ms so it never flashes.
- The bar is drawn only when there is a real numerator and denominator (files, shards, bytes). Otherwise add `data-unmeasured`: the track stays empty and the line shows the stage and elapsed time. Never animate a bar that is not measuring anything.
- The line names the work in terms the person can act on: "Scanning 12 of 40 files", not "Loading".
- After 2 s, offer Cancel beside it. When work ends incomplete, say what is shown, what is missing, and offer Retry.
- It sits at the top edge of the region it describes; the previous result stays visible and usable beneath it.