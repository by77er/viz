# app: monitors, the on-call slice (images for design review)

**Status: rejected by the re-review (`../app-v9/rereview.md`, part 3); fixed, awaiting a re-review.** The dispositions are at the end ("Third design review"). These are the composed images of the app's new monitors views, for an
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

**Checked against the merged build** (commit `67d9d73`, 2026-11-28 11:16 UTC) and not remade: the 52
images were made again from it and compared pixel for pixel. 11 are identical; the other 41 differ
where the page follows the clock (the mock's monitors are computed relative to now: "Firing since …",
durations, "Evaluated … ago", the values and the chart's time axis), and in the palette's
anti-aliased edges; checked by eye on `01-list-light-1440` and `03-monitor-firing-light-1440`. The
navigation, Explore's chart path and the layout are as these images show them.

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

## Third design review: dispositions (2026-11-28)

The re-review (`../app-v9/rereview.md`, part 3) rejected this view. Each finding and what was
done; the author's account in full is `app/README.md`, "The third design review". This list does
not judge the result.

| Finding | Disposition |
|---|---|
| **M-B1** opening a monitor and its chart paint over budget | Fixed in the code, measured: `app/README.md`, "Speed (third review)". A press on a monitor in the list shows its page from the list's row in the press's own task, while the router changes the address (one element: nothing is asked twice); the chart's section is memoised and its spec no longer changes with every read of the monitor (the condition was a new object each read, so each read drew the chart again). Nothing a person sees changes |
| **M-M1** one event, two times; advice the app lacks | Fixed: "Undo had closed at 10:26, so the silence stays until 11:25. Ending a silence early is not in this app yet. (The API answered undo_expired, HTTP 410.)", once; the help line about the window is not repeated under it. Image `07-undo-expired` |
| **M-M2** no unit | Fixed: the unit comes from the condition, else the message template (`humanizePercentage`), else a share read from the query (part of one metric over all of it), else Explore's "Automatic" guess. The list's Value and Threshold, the alerts, the threshold line, the chart's axis and legend, the history and the text form all say "8.4%", "> 2% for 5 min". Images `01-list`, `03-monitor-firing` |
| o1 "for 5m" | Fixed: "> 2% for 5 min" in the list; "> 2%" beside "For 5 min" on the page |
| o2 unrendered template | Fixed: "Message, as sent at 09:47" (filled with the value it fired at) and "Message template" |
| o3 critical mark on "Cannot be evaluated" | Fixed: the unknown dash |
| o4 the notice's mark and Dismiss | Follow-up: the system's Notice |
| o5 "changed by", "not acknowledged", lower-case API words, repeated "Nothing was changed" | Fixed. Image `11-list-error` |
| o6 the query cut at its right edge | Fixed: the query wraps |
| o7 first run as a list of one | Fixed. Image `12-empty` |
| o8 the mock's value disagrees with the chart | Fixed in the mock: an alert's value is its query's at the last evaluation, from the mock's own series. **Still the mock's:** its alert states are fixed when it starts, so a monitor can be "firing" while its query is under the threshold (the images say what the series says: the value is under 2%). A mock that evaluates its rules is a follow-up |

### Images of the third review

Remade 2026-11-28 15:12 UTC by `node app/e2e/monitors-shots.cjs` from a build of this change in a worktree of
`6c76fc4` (the committed chart, not the chart another builder is changing), encoded with
`app/e2e/encode-review-images.py --flat`, and compared pixel for pixel with the images they
replace. Changed and replaced: `01-list`, `02-list-all`, `03-monitor-firing`, `04-acknowledged`, `05-silence-menu`, `06-silenced-undo`, `07-undo-expired`, `08-write-failed`, `09-no-ack-scope`, `11-list-error`, `12-empty`, `13-monitor-error` (several also by the clock: the mock's monitors are relative to now). Identical: `10-no-permission`. The table of states above still says
what each image shows; where a state's words changed, the dispositions say how. Not imaged: the
panels' text forms open (one is, in `09`), the colour map across panels other than in `08`.
