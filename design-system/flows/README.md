# User flows and screens

What a person does in viz, and the screens that support it, designed against the design system
(**v5**, `reviews/system-v5/response.md`) before anything is built. Screens are static HTML in
`screens/`, composed from system components only; the one incident they all show is in `fixture.js`
and `REVIEW-INPUT.md`. Only **Explore** exists as working software today. Everything else here is
a design. What changed, revision by revision and finding by finding, is in `REVISION.md` (the v5
migration is its first section).

```
node build.mjs                    # pages into flows/dist/ (ignored by git); open flows/dist/<screen>.html
node build.mjs --facts            # every chart's last, min and max, and the trace's own times: the figures the screens state
node build.mjs --shots [n ...]    # scenarios/*.json through tools/shots.mjs into shots/, and measurements.txt
node build.mjs --shift            # layout shift on every chart at 400 px, touch, data drawn 800 ms late: shift.txt
node build.mjs --compare <v4dir>  # v4 -> v5 pairs into compare-v5/ (every image in <v4dir> with a namesake in shots/)
node ../tools/check.mjs .         # literal values and contrast (run from flows/)
```

A state is a URL fragment: `4-monitor.html#ack`, `#silence-menu`, `#silenced`, `#notice`, `#error`,
`#nodata`. The buttons on the built pages move between states (Acknowledge, Undo, Silence…, End
silence, Confirm claim, Apply 2 changes, New key, Create key). Two query parameters exist for
measuring only: `?delay=800` draws the charts 800 ms after the page paints, and `?at=<id>` opens the
page scrolled to that region (`--shift` uses both).

## For the reviewer: what to look at, in this order

1. `REVIEW-INPUT.md`: the clock, the incident and its figures, the agent's text, and for each screen
   who is looking, the reading order and the blue button.
2. `compare-v5/`: v4 beside v5 for every screen, both themes, 1440 and 400 px, plus the states v5
   changed most (Monitor acknowledged, silenced, Silence menu, failed acknowledgement; Keys menu and
   secret; Traces and Logs errors; Dashboard waiting; New monitor with 36 series; a confirmed claim).
   Judge these first: they show what moved onto v5.
3. Flow 1, phone first: `shots/4-monitor-400-{light,dark}.png`, then `4-monitor-silence-menu-400-*`
   (the menu is a sheet at the foot of a phone screen), `4-monitor-ack-400-*`,
   `4-monitor-silenced-400-light`, `4-monitor-notice-400-light`, `4-monitor-400-hit-areas-light`.
4. Flow 2, the screens that were hand-built in v4: `shots/9-traces-*` (Waterfall, including
   `9-traces-waterfall-focus-*`, the keyboard moving down the tree) and `shots/10-logs-*` (Log).
5. The rest, in the flow order below, then the greyscale and focus images (`*-grey-light`,
   `*-focus-light`) and `3-monitors-zoom-200-light`, `4-monitor-zoom-200-light`.
6. `REVISION.md`, "v5": the measurements (touch, overflow, layout shift with the load beside every
   timing), which of the 16 system gaps v5 closed, and the gaps that remain or are new.

## Who uses it

- **The on-call engineer**, paged at night on a phone, needs to know what is wrong, since when,
  whether anyone else has it, and what to look at first.
- **The service owner**, in daylight, wants to know whether their service is healthy and why not.
- **The platform owner** sets up tenants, keys, routes, retention and cost limits.
- **An agent**, working for any of them through the tool surface, reads the same views as text,
  investigates, and proposes changes that a person approves. Everything it wrote is marked where
  it is read.

## Flows

In the order a team meets them. Flow 1 is designed phone first.

| # | Flow | Starts from | Ends when | Screens |
|---|---|---|---|---|
| 1 | Respond to an alert | The page on a phone, or the message in the team's channel | The responder has acknowledged it (or silenced it, with undo), knows who else was told, and has the agent's lead with its evidence | Notifications sent, Monitor |
| 2 | Follow an alert to traces and logs | Monitor's Related links, an agent's claim | The slow span and the error lines that explain the alert are found | Traces, Logs |
| 3 | Review an agent's investigation | The alert's banner or history, the channel message | Each claim is confirmed or rejected after its query is read; the owner, the traces and the proposal are one tap away | Investigation |
| 4 | See what is wrong everywhere | Navigation | Firing, acknowledged, pending and silenced monitors are read in order of urgency, value against threshold | Monitors |
| 5 | Decide who is notified | A monitor's rule, Monitors, a failed page | Who is on call, where each team's alerts go, how they escalate and what is silenced are read; a silence can be ended | Who is notified |
| 6 | Check a service | The dashboards list | State, traffic, errors, latency and what changed are read in one screen | Dashboards, Dashboard |
| 7 | Review an agent's proposed dashboard change | "1 proposal waiting" on Dashboards, the dashboard's Changes panel | Each change is taken or left after its before and after are seen; applying makes a revision that can be restored | Proposed change |
| 8 | Turn a query into a monitor | Explore | A rule is saved with its message, runbook, no-data behaviour and route, after its backtest and cost are seen | New monitor |
| 9 | Give a sender access, from nothing | The first-run page of an empty tenant, or Settings | A key was made and saved once, and its first data has arrived | Dashboards (first run), Keys |
| 10 | Answer a question | A hunch, a link, a page | The chart or table answers it, and the link is shareable | Explore (exists; not in this set) |

## Screens

| File | Screen | States imaged (`shots/`) |
|---|---|---|
| `1-dashboards` | Dashboards | default, focus, error, search with no match, first run (tenant with no data) |
| `2-dashboard` | Dashboard: checkout-api | default, focus, a panel not updating, waiting on a longer range, an empty panel (Goroutines) |
| `3-monitors` | Monitors | default, focus, evaluator stalled, first run, hit areas, 200% zoom |
| `4-monitor` | Monitor: checkout p99 latency | default, focus, Silence menu open (400 both themes, 1440), acknowledged with Undo, silenced with End silence, acknowledge failed, query failing, no data, hit areas, 200% zoom |
| `5-new-monitor` | New monitor | default, focus, invalid threshold, query returning 36 series (1440 and 400) |
| `6-investigation` | Investigation: Why is checkout slow? | default, focus, a claim confirmed, investigating again, second investigation failed |
| `7-proposed-change` | Proposed change to checkout-api | default, focus, applied, apply failed |
| `8-keys` | Keys | default, focus, row menu (1440, and 400 as a sheet), New key, key shown once (masked), revealed and saved, copy failed, revoke, first data arrived |
| `9-traces` | Traces, with one trace's waterfall | default, focus, trace detail failed to load, keyboard in the waterfall (both themes) |
| `10-logs` | Logs | default, focus, query too broad (previous result kept) |
| `11-notification` | Notifications sent (the page and the channel message) | default, focus, acknowledged, a page not delivered |
| `12-routes` | Who is notified (on call, routes, silences) | default, focus, paging service not answering |

Every screen also has light and dark at 1440 px and at 400 px with a coarse pointer (hit areas,
covered controls, overlaps, links inside sentences and overflow measured, `measurements.txt`), and a
greyscale copy. `compare-v5/` pairs v4 and v5; `compare/` is the earlier v1 -> v4 record.

## Rules the screens follow

- System components and token values only. No inline style except the two the system documents as
  data: a chart's `--legend-rows` and `--legend-notes` (counts, so the chart reserves its height on
  every pointer before its data arrives) and a waterfall bar's `--at` and `--len` (a span's start and
  length as fractions of the trace). `build.mjs` adds only state switching to the system's CSS.
- One blue button per screen at most: the thing most people came to do (listed in `REVIEW-INPUT.md`).
- One clock (Wed 18 Nov 2026, 15:16) and one incident on every screen; every figure agrees with
  the chart beside it and states its window.
- Every screen states how fresh its data is.
- Anything an agent wrote says so where it is read, is "Not verified" until a person confirms it,
  and links to the query behind it.
- The main path of a flow is a button or a standalone link, never a link inside a sentence.
- A cautionary action asks for its choice before it acts and can be undone; nothing is hidden in
  a hover; nothing depends on a modifier key.
- Lists a person reads row by row fold at 400 px and keep the columns they exist for on screen.

## Not designed yet

See `REVISION.md`, "Still not designed": Explore and what arrives in it, dashboard editing and the
Text view, compare and share, cost and cardinality, tenant settings and sign-in, lists of agent
work, a resolved alert and its timeline, editing routes and rotas.
