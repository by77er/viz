A secret that exists on screen once: a new API key, a signing secret. `vz-secret`, normally inside a `vz-dialog`, because the person cannot sensibly continue until they have saved it.

- **Value**: a `vz-query` well (`vz-secret-value`). It opens masked, showing the prefix and the last four characters ("viz_••••4f2a") so the key can be recognised later without being exposed to a shared screen. "Reveal" shows it and becomes "Hide" (`aria-pressed`). Selecting the well selects the whole key.
- **Copy key** copies the real value whether or not it is revealed. Copying has no visible result, so the button says "Copied" for 2 s; that is the one sanctioned confirmation in the system.
- **The warning** is a help line with the warn mark: "This is the only time the key is shown. viz keeps a hash of it and cannot show it again."
- **"I have saved the key"** is a `vz-check`. The dialog's only action, "Done" (blue), is disabled until it is ticked. There is no Cancel and Escape does not close the dialog: closing loses the key. If the person must leave, the key is revoked by "Discard this key" (a quiet button), which says so.
- After Done the key is shown everywhere else truncated in the middle: "viz_k7…4f2a".
- States: masked, revealed, copied, saved (Done enabled), copy failed (a `vz-notice` under the row: "Could not copy. Select the key and copy it by hand.").
- The well has its own line at every width and its two buttons sit together under it, so Reveal and Copy key are never split across lines. With a coarse pointer the well is `control-touch` tall and the buttons keep the touch row gap.
