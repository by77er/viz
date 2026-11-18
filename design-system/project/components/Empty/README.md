What a region shows when it has no result: nothing matched, or something failed. `vz-empty`: a title that says which, a sentence that says what was asked and what to change, and at most one small button that makes that change.

- Empty is not an error. It has no mark. Say what was looked for and offer the nearest thing that exists.
- An error starts with the critical mark, gives the system's message in plain words with the exact position or value, and offers the fix.
- It is left-aligned in the region, at the top, where the result would have started, with no space above it. No illustration.
- A page or region that has never had anything in it is not empty in this sense: use FirstRun.
- A region that has never had data and is waiting for its first result reserves its final height and shows `vz-progress` once the wait passes 400 ms.
