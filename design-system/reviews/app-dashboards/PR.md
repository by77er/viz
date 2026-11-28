# app: dashboards, read-only (images for design review)

**Status: rejected by the re-review (`../app-v9/rereview.md`, part 2); fixed, awaiting a re-review.** The dispositions are at the end ("Third design review"). These are the composed images of the app's new dashboards views, for
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

**Remade 2026-11-28 11:18 UTC from the merged build** (commit `67d9d73`: the app's fixes for the
second review, the chart speed change and the monitors view): the navigation now has "Monitors", which
is the only difference from the earlier set apart from times shown while waiting and the palette's
anti-aliased edges (compared pixel for pixel before replacing them).

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

## Third design review: dispositions (2026-11-28)

The re-review (`../app-v9/rereview.md`, part 2) rejected this view. Each finding, what was done,
and where the check that fails without it is. The author's account in full is `app/README.md`,
"The third design review"; this list does not judge the result. Images remade: see "Images of
the third review" below.

| Finding | Disposition |
|---|---|
| **D-B1** agent content unmarked | Fixed. While the dashboard's last change is an agent's, every word of its spec is marked where it is read, by Claim's pattern: the head's title and intent inside the agent's rule (`vz-agent`) under Claim's provenance line (`vz-claim-by`: "Agent's dashboard, written by incident-agent" and `vz-status` "Not verified", the unknown dash); each panel title ruled; each explanation ruled and reading "Agent: … Not verified."; a stat's thresholds on a ruled line "Agent's thresholds: … Not verified."; the list's Intent cell ruled with "Agent: … Not verified."; the text forms say the same. Nothing can be confirmed in a read-only app: a person's next revision lifts it. Images `01-list`, `09-dashboard-variables`. Checks `[agent]` in `app/e2e/dashboards.cjs` |
| **D-B2** panels painted late; waiting state late | Fixed in the code, measured: `app/README.md`, "Speed (third review)" (before and after alternating, paired differences, sessions). A chart off screen waits in its reserved place (the height it draws) until its panel nears the viewport or the page is idle; the press on a range marks every panel waiting in its own task. Nothing a person sees changes. Checks `[speed]` |
| **D-M1** raw Markdown digest | Fixed. The heatmap's buckets are the system's table (bound with its unit; Last, Lowest, Highest with the unit in the head; no outlier notes, no capitals); the note's Markdown is text (strong words in weight); each panel's text form and the dashboard's Text are sentences in the page's units and dates, every series, wrapped at the measure; the model's digest is only "Copy the digest for an agent". Images `10-dashboard-panel-states`, `13-dashboard-text`, `09-dashboard-variables` (a text form open). Checks `[text]` |
| **D-M2** one service, three colours | Fixed as a proposal for the system's owner (`app/README.md`, decisions): one map per dashboard by series identity (labels without `__name__`, grouped by label names), handed to each panel's chart before its first draw. Image `08-dashboard`. Check `[colour]`, unit `colours.test.ts`. Needs C1 from the chart (an input for a starting map) |
| d1 thresholds unnamed | Fixed: "Thresholds: above 2% (warning) and above 5% (critical)." |
| d2 baselines in a row | Follow-up: the system's Panel (C3) |
| d3 which previous range | Fixed: "Showing 18 Nov, 09:30 to 12:30, the previous range". Image `11-dashboard-waiting` |
| d4 summary without marker | Follow-up: the system's `vz-details` (C4) |
| d5 "Nothing was changed" twice | Fixed. Image `05-list-error` |
| d6 first run as a list of one | Fixed. Image `04-list-first-run` |
| d7 two readings of an empty panel | Fixed: one sentence; the explanation above says what nothing means |
| d8 no way to see the cut rows | Fixed: "Show 4 more" |
| d9 placeholder | Fixed: none |

### Images of the third review

Remade 2026-11-28 15:12 UTC by `node app/e2e/dashboards-shots.cjs` from a build of this change in a worktree of
`6c76fc4` (the committed chart, not the chart another builder is changing), encoded with
`app/e2e/encode-review-images.py --flat`, and compared pixel for pixel with the images they
replace. Changed and replaced: `01-list`, `04-list-first-run`, `05-list-error`, `06-list-waiting` (its seconds only), `08-dashboard`, `09-dashboard-variables`, `10-dashboard-panel-states`, `11-dashboard-waiting`, `12-dashboard-first-load`, `13-dashboard-text`, `15-dashboard-fragments`. Identical: `02-list-filtered`, `03-list-empty`, `07-list-no-permission`, `14-dashboard-missing`. The table of states above still says
what each image shows; where a state's words changed, the dispositions say how. Not imaged: the
panels' text forms open (one is, in `09`), the colour map across panels other than in `08`.
