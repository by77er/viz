# User flows and screens

What a person does in viz, and the screens that support it, designed against the design
system before anything is built. Screens are static HTML in `screens/`, composed only from
system components; `node build.mjs` writes `dist/flows/` and the images in `shots/`.

Only **Explore** exists as working software today. Everything else here is a design.

## Who uses it

- **The on-call engineer**, paged at night, needs to know what is wrong and since when.
- **The service owner**, in daylight, wants to know whether their service is healthy and why not.
- **The platform owner** sets up tenants, keys, retention and cost limits.
- **An agent**, working for any of them through the tool surface, reads the same views as text
  and proposes changes that a person approves.

## Flows

| # | Flow | Starts from | Ends when | Screens |
|---|---|---|---|---|
| 1 | Answer a question | A hunch, a link, a page | The chart or table answers it, and the link is shareable | Explore |
| 2 | Check a service | The dashboards list | State, traffic, errors and latency are read in one screen | Dashboards, Dashboard |
| 3 | Respond to an alert | A notification link | The alert is understood, then silenced, acknowledged or resolved | Monitor |
| 4 | See what is wrong everywhere | Navigation | Firing and pending monitors are read in order of urgency | Monitors |
| 5 | Turn a query into a monitor | Explore or a panel | A rule is saved, with its cost class shown | New monitor |
| 6 | Review an agent's investigation | An alert, or a schedule | Each claim is checked against the query behind it | Investigation |
| 7 | Review an agent's proposed dashboard change | A notification | The change is applied, edited or declined, with the diff seen first | Proposed change |
| 8 | Give a sender access | Settings | A key exists, was shown once, and its first data has arrived | Keys |

## Rules the screens follow

- One blue button per screen: the thing most people came to do.
- The first three things the eye reaches are listed for each screen in `REVIEW-INPUT.md`.
- Every screen states how fresh its data is.
- Anything an agent wrote says so, and links to the evidence.
- Destructive and cautionary actions are red and yellow buttons with verbs; nothing is hidden
  in a hover.

## Not designed yet

Trace view and log view (their components, the waterfall and the log line, are not in the
system yet), dashboard editing by hand, tenant and retention settings, sign-in.
