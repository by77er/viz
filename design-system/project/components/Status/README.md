The state of one thing: a mark, then a word in `ink`. `vz-status` with `data-state`; no state means unknown.

**Severity**, coloured, each with its own shape so a column scans without colour: `critical` a solid square, `warn` a diamond, `ok` a hollow square, `info` a short bar, unknown a dash. Colours are `status-critical`, `status-warn`, `status-ok` and `status-info`, lighter in the dark theme. They are not the button colours: `status-info` is a cyan, so an informational mark beside a blue button cannot be read as part of it.

**Disposition**: what a person (or an agent) has done about it. Neutral, because once someone has it the severity colour should stop calling:

- `ack`, a half-filled square in `ink-secondary`: acknowledged, confirmed, applied. "Acknowledged by Dana at 15:16".
- `silenced`, two upright bars in `ink-secondary`: paused. "Silenced until 16:16".
- `ruled-out`, a slash in `ink-muted`: considered and excluded. "Ruled out". Never use the unknown dash for this: unknown means nobody looked.

A monitor that is firing and acknowledged shows the `ack` mark and says both: "Acknowledged, firing since 13:07". An unacknowledged one keeps the critical square, so the red marks in a list are exactly the ones nobody has.

The word is required and is never coloured. If the words contain another element (a `vz-qty`), wrap them all in one `span`, so they stay one run of text. Use the word that says what is wrong ("Burning budget"), not the level ("Critical"). `vz-mark` draws the mark alone, for banners, help lines and timelines. In a timeline, `data-state="agent"` draws the agent's rule as the mark of a line an agent wrote, and `info` (the bar) marks an event that informed someone: a deploy, a note, a notification sent, an escalation. There is no separate "notified" mark: who was told is in the sentence.
