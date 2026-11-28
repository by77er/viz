# app: monitors, the on-call slice (images for design review)

**Status: not reviewed.** These are the composed images of the app's new monitors views, for an
independent design reviewer. This file says what is shown and how it was made; it does not
judge it. What the views do, what they leave out, and how they were tested and measured is in
`app/README.md`, "Monitors, the on-call slice".

## What the change is

Two views of the web app (`app/src/monitors/`, a chunk of its own), on the ruler's monitors API:

- **`/monitors`**: every monitor with its state (the system's `vz-status`: mark and words),
  "firing since", value, threshold as written, owner and receiver; filters "Needs attention"
  (the default), "Silenced" and "All" (the API's `filter`), attention first; a text form.
- **`/monitors?id=<id>`**: one monitor: its name, the state line, who was told and when, the two
  on-call actions (Acknowledge, green; "Silence…", a menu whose confirming button is yellow),
  Refresh; its query drawn with the system's chart over a range around now (Explore's range
  controls), with the threshold as a labelled line, "Above" and "Fired" markers and the firing
  span; its alerts; what it watches (message, description, runbook, threshold, for, no-data
  policy, receiver, owner, last change); its history, newest first; a text form.

An action is replaced in place by `vz-done` ("Acknowledged by you at 09:31" with Unacknowledge;
"Silenced by you until 10:31" with Undo while the API's 60 s window is open). A refused write is
a `vz-notice` under the actions in the API's words. "Monitors" was added to the navigation, the
command palette and Help. Nothing under `design-system/` was changed except this directory; no
rule was added to `app/src/app.css`; `npm run check:tokens` passes.

## The person and the question

Someone on call, often on a phone at night, has been notified: which monitor is firing, since
when, is anyone on it, what does the query look like against its threshold, and then take it
(acknowledge) or stop the notifications for a while (silence), with a way back.

## The images

`node app/e2e/monitors-shots.cjs` wrote them from the built app on the development mock
(synthetic data; the banner at the top of every image says so and is the app's, not part of
this change), the mock reset before each image. Each state is in both themes at 1440 px (mouse)
and 400 px (touch emulation: coarse pointer), so each name is four files:
`<name>-light-1440.png`, `<name>-dark-1440.png`, `<name>-light-400.png`, `<name>-dark-400.png`.
They are whole pages, except `05-silence-menu` (the window, so the menu is where it opens).
The images were reduced by `app/e2e/encode-review-images.py --flat` (a palette holding every
token colour exactly).

| Name | What it shows |
|---|---|
| `01-list` | The list on "Needs attention" (the default): five of seven, firing first; the firing one somebody has (acknowledged and silenced) after the one nobody has |
| `02-list-all` | "All": seven monitors, attention first, the two that are not firing last |
| `03-monitor-firing` | A firing monitor nobody has acknowledged |
| `04-acknowledged` | After Acknowledge, re-read: `vz-done` in the button's place, the state line's mark now "acknowledged", the alert and the history saying who |
| `05-silence-menu` | "Silence…" open: 15 min, 1 h, 4 h, the note, "Silence for 1 h" |
| `06-silenced-undo` | After "Silence for 1 h": "Silenced by you until …" with Undo, and the line saying until when Undo is open |
| `07-undo-expired` | Undo pressed after the API's window: the API's 410 in its words, the silence kept, Undo gone |
| `08-write-failed` | Acknowledge refused by the API (503): the notice under the button; nothing else changed |
| `09-no-ack-scope` | A key that may read monitors and not act: the actions disabled with the reason, before any press |
| `10-no-permission` | A key without `monitors:read`, on the list |
| `11-list-error` | The list could not be read (503) |
| `12-empty` | A tenant with no monitors (first run) |
| `13-monitor-error` | A monitor that cannot be evaluated: the ruler's last error; the query's refusal in the chart's place |

Not imaged: the waiting states (the list's and a monitor's line after 400 ms, the chart's
"Waiting for the query." and "Showing the previous range"), focus rings, hover and pressed
states, 200% zoom, and the history of a monitor with more than 200 entries.
