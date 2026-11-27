# app: dashboards, read-only (images for design review)

**Status: not reviewed.** These are the composed images of the app's new dashboards views, for
an independent design reviewer. This file says what is shown and how it was made; it does not
judge it. What the views do, what they leave out, how they were tested and measured is in
`app/README.md`, "Dashboards, read-only".

## What the change is

Two views of the web app (`app/src/dashboards/`), both read-only:

- **`/dashboards`**: the tenant's dashboards: name, intent, tags, owner, last change and by
  whom, with a search and a tag filter.
- **`/dashboards?id=<id>`**: one dashboard: title and intent, the time range (Explore's own
  controls), its variables as controls, its panels in the spec's layout. `timeseries` panels
  are the design system's chart, `stat` panels `vz-stat`, `table` panels `vz-table`; a
  `heatmap` or `text` panel is shown as its title, a sentence saying this kind is not drawn
  yet, and the dashboard model's text digest. Every drawn panel has a "Text form" disclosure
  and an "Open in Explore" link.

"Dashboards" was added to the navigation and to the command palette. Nothing under
`design-system/` was changed; the views use the system's tokens and component classes
(`npm run check:tokens` passes: no literal colour, length, duration or opacity in `app/src`).
`app/src/app.css` gained five rules, each a layout rule with token values only; what the
views needed and the system lacks is listed in `app/README.md`, "Needed from the design
system (dashboards)".

## The person and the question

Someone on call wants to open their service's dashboard and read, panel by panel, whether it
is healthy over a time range. On the list they are looking for the dashboard by name or by
what it is for.

## The images

`node app/e2e/dashboards-shots.cjs` wrote them from the built app on the development mock
(synthetic data; the yellow-marked banner at the top of every image says so and is the
app's, not part of this change). Each state is captured in both themes at 1440 px (mouse) and
at 400 px (touch emulation: coarse pointer), so each name below is four files:
`<name>-light-1440.png`, `<name>-dark-1440.png`, `<name>-light-400.png`, `<name>-dark-400.png`.
Every image is the whole page at device scale 1, stored with a 256-colour palette that holds
every token colour exactly (`app/e2e/encode-review-images.py --flat`; as captured the sixty
were 10.3 MB, stored 3.3 MB): flat colours and text are exact, the anti-aliased edges of
lines and letters are the nearest of the palette's colours. The dashboards are shown over a fixed range, 18 Nov 2026 09:30 to 12:30 UTC, so
two captures draw the same data; the 12-minute rise in checkout's errors and latency at
09:40 and the gap in one pod's CPU line at 10:50 are in the mock's data. `images.json` lists
every file with its size and the page height.

| Name | What is shown |
|---|---|
| `01-list` | The list: four dashboards, by name |
| `02-list-filtered` | The list searched for "capacity": one of four |
| `03-list-empty` | Empty: a search and tag that match no dashboard |
| `04-list-first-run` | First run: a tenant with no dashboards (the list's answer replaced by an empty one) |
| `05-list-error` | Error: the API answered 500 for the list (the answer replaced by control's 500 problem) |
| `06-list-waiting` | Loading: the list about 0.9 s into a slow answer. Nothing is shown before 0.4 s |
| `07-list-no-permission` | No permission: a key with the `read` scope and no dashboards scope |
| `08-dashboard` | A full dashboard, "Services overview": twelve panels (four stats, six charts of 4 to 36 series, two tables) |
| `09-dashboard-variables` | A dashboard with variables: Service (a query variable, a select) set to orders, Status (an enum, a segmented control) set to 500; the first chart's "Text form" open |
| `10-dashboard-panel-states` | Panel states on one dashboard ("Pod capacity", an explicit grid): a heatmap and a text note (kinds not drawn), a query the API refuses (the panel's error), a query that matches nothing (the panel's empty state), beside a chart of 12 series and a stat |
| `11-dashboard-waiting` | Waiting on a new range: "6 h" was pressed and the API is slow; about 2.6 s in, every panel keeps its previous answer, its head says "Showing the previous range", and the waiting line offers Cancel |
| `12-dashboard-first-load` | Waiting on a first load: "Services overview" opened from the list on a slow API, about 1.6 s in (its own range, the last 3 h): the panels' places are reserved and each says what it waits for |
| `13-dashboard-text` | The whole dashboard as text (the dashboard model's digest), with the panel that failed named as not in it |
| `14-dashboard-missing` | Error: an address with an id no dashboard has |
| `15-dashboard-fragments` | A dashboard made of one fragment used twice, each under its row's heading |

## What the images do not show

- Hover, pressed and focus states of the controls (they are the system's own classes, unchanged).
- 200% zoom, greyscale, and a real phone: 400 px is Chromium's touch emulation.
- The 60 s stop of a panel's wait, a cancelled panel, a panel after "Run this panel again", a
  spec the model refuses, and a variable whose values cannot be listed: these states exist
  and are checked by `app/e2e/dashboards.cjs` or the unit tests, and are not imaged.
- Before and after: these are new views, so there is no "before".
- At 400 px the navigation scrolls sideways (the system's rule for a strip); the images show
  its start.
