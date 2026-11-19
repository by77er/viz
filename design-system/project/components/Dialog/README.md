A decision that must be made before anything else. `vz-dialog`: a title that states the decision as a question or a verb phrase, the consequences in one or two sentences (`vz-dialog-text`, `ink-secondary`), any input the decision needs, and the actions at the bottom right.

- Use it only when the person cannot sensibly continue without answering, or when an action cannot be undone. Everything else is edited in place.
- **Scrim.** The page behind a dialog is covered by `scrim`: on a native `<dialog>` opened with `showModal()` the class styles `::backdrop`; otherwise wrap the dialog in `vz-scrim`, which centres it in one column the width of the screen less the gutter, so a long key or query inside scrolls in its well instead of widening the dialog past the screen. The scrim says the page is not available; nothing is read through it, and the page's own blue button no longer competes with the dialog's.
- A closed native `<dialog>` stays hidden: the class does not override it.
- The confirming button repeats the verb from the title ("Delete dashboard"), in the tone of the action. Cancel is quiet and comes first. A toned confirm beside another toned button is `space-6` away.
- **Typed confirmation** for what cannot be undone: the label says what to type ("Type the dashboard name, Checkout latency, to confirm"), the field has no placeholder (a placeholder holding the answer turns the check into a copy), and the confirming button is disabled until the field matches.
- Focus moves into the dialog on open and returns to the control that opened it on close. Escape cancels (except in a secret shown once).
- It is `dialog` wide, never wider than the screen less the gutter, never taller than the screen (it scrolls inside); on narrow screens the actions wrap with the touch row gap.
