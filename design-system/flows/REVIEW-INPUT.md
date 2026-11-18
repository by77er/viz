# Review input for the flow screens (v2)

For the reviewer: the clock, the one incident and its figures that every screen uses, which text
an agent wrote, and for each screen who is looking, what they want, the first three things the
eye should reach, and its one blue button. Images are in `shots/` (`<screen>-<state>-<theme>.png`),
before/after pairs in `compare/`, measurements in `measurements.txt`. The design system is v4 as
it stood on 18 Nov 2026 (`reviews/system-v4/CHANGES.md`), itself under review.

## The clock

**Wednesday 18 Nov 2026, 15:16**, tenant **acme-prod**. Every age, "now" and chart end is this
moment. Times are 24-hour; ages follow the Number rules ("12 s ago", "14 min ago", "6 Nov").

## The incident

checkout-api's POST /v2/orders is slow because payments-db is slow; payments-db's connection pool
fills, so some orders fail.

| Time | Event | Where it appears |
|---|---|---|
| 09:41 | Deploy of checkout-api, revision 4f2a91c, by the release pipeline | Chart marker "Deploy 09:41" (screens 2, 4, 7, 10); Monitor history; Dashboard Changes; ruled out by the agent (6) |
| 12:58 | payments-db p99 starts rising (agent's claim, from 40 ms) | Agent banner (4); claim 1 (6); marker "Agent: slow since 12:58" on the agent's chart (6) |
| 13:02 | POST /v2/orders p99 crosses 500 ms, at 531 ms; monitor pending | "Above 500 ms since 13:02" (2, 4); marker "Above 13:02" (2, 4, 9); history (4) |
| 13:05 | Errors, all routes, above the 1% objective | Errors stat (2); marker "Errors above 1% 13:05" (2); log description (10) |
| 13:07 | Monitor fires at 548 ms. Page to Dana (payments on-call), message in #payments-alerts, agent starts investigating | "Firing since 13:07 (2 h 9 min)" (3, 4, 11); span "Firing since 13:07" (2, 4, 6, 10); history (4); sent list (11) |
| 13:09 | Investigation finished: 14 queries, 1 min 52 s, $0.21; payments-db suspected; reply in the channel thread | Banner and history (4); report (6); sent list (11) |
| 13:16 | Agent proposes 3 changes to the checkout-api dashboard (revision 14) | Dashboards "1 proposal waiting" (1); Changes panel (2); proposal (7) |
| 13:37 | Nobody acknowledged in 30 min: page to Kim (payments secondary) | Monitor sub-line and history (4); sent list (11); escalation rule (4, 12) |
| 15:16 | Now. Not acknowledged. Next page at 17:07 (every 4 h while firing) | 3, 4, 11 |
| 15:16 | In the "ack" states only: acknowledged by Dana (you); Kim and the channel told; 17:07 page cancelled | `4-monitor-ack-*`, `11-notification-ack-*` |

Other monitors (screen 3): ingest lag, firing since 14:40, acknowledged by Sam at 14:44, 4 min 10 s
against > 2 min for 10 min; catalog error rate, pending 4 min of 10 min, 1.3% against > 1%;
batch export failures, silenced until 16:00 by Sam (at 15:00), firing since 14:02, 7/h against
> 5/h for 1 h. 34 monitors: 2 firing (1 acknowledged), 1 pending, 1 silenced, 30 healthy.

## The figures

Chart data is `fixture.js`; `node build.mjs --facts` prints each chart's last, min and max.

| Figure | Value | Window | Agrees with |
|---|---|---|---|
| p99, POST /v2/orders | 912 ms | last 5 min; the chart's last 6 min sample | Dashboard stat and Routes table, Monitor sub-line, Monitors "Now", chart legends (2, 4, 9) |
| p99, GET /v2/cart/{id} and GET /v2/products | 315 ms, 117 ms | same | Routes table and legends (both under 500 ms, Healthy) |
| p50, POST /v2/orders | 310 ms | same | Routes table, trace chart legend |
| Requests | 1,284 req/s = 212.4 + 842.6 + 229.0 | last 5 min | Stat, Routes table, caption |
| Errors, all routes | 1.69% = (212.4 × 9.8% + 842.6 × 0.1% + 229.0 × 0.0%) / 1,284 | last 5 min | Stat, Routes caption; route figures at the legend's precision (9.8, 0.1, 0.0) |
| Error budget left | 61.4%; burning 16.9 times the 0.1% allowance, so gone in 1 d 2 h | 30-day window, 99.9% target | Stat |
| payments-db p99 | 40 ms to 610 ms by 13:09; 624 ms now | agent's read 12:00 to 13:09 at 3 min; today 09:16 to 15:16 at 6 min | Claim 1, agent's chart (6), proposed panel (7) |
| Error log lines | 1,300 a minute now (≈ 212.4 × 9.8% + 842.6 × 0.1% per second); 138,582 lines 09:16 to 15:16 | 6 min mean | Logs chart, sub-line and caption |
| Slow traces | 3,412 of 17,046 traced requests slower than 500 ms; 1 in 100 traced | 13:02 to 15:16 | Traces sub-line and caption |
| Trace 4bf9…4736 | 1,204 ms; payments-db 702 + 255 = 957 ms; the rest 247 ms | 15:14:52 | Waterfall, list, chart marker "This trace 15:14" |
| Backtest, cart error rate | value now 0.40%; would have fired Sat 14 Nov 05:51 for 5 min and Mon 16 Nov 20:16 for 20 min (above 1% for 15 and 30 min, with "for at least 10 min") | 11 Nov 15:16 to 18 Nov 15:16, 5 min max | New monitor sentence, chart spans, legend |
| Backtest by pod | 36 pods; would have fired 15 times on 10 pods | same | `5-new-monitor-many` |
| Dashboards | 24; 3 with a critical panel; checkout-api has 9 panels, last changed 6 Nov by Dana | | Dashboards list, Dashboard (9 panels drawn) |

## Text an agent wrote

Each is marked where it is read (the left rule, "Agent:" or "Agent's claim", and "Not verified"):

- Monitor banner and history, Dashboard Changes, the channel message: "Agent: payments-db has been
  slow since 12:58", "Agent: investigation finished; payments-db suspected", "Agent: proposed 3
  changes", "Agent: investigating".
- Investigation: the five claims, each with its query; "Agent: I could not check why payments-db is
  slow"; the chart marker "Agent: slow since 12:58"; the chart is "as the agent read it at 13:09".
- Proposed change: the provenance line and each "Why".
- Monitors: the "Agent's report" column only links to the agent's report.

## Each screen

| Screen | Who, and what they want | Reading order | Blue button |
|---|---|---|---|
| 11 Notifications sent | The paged engineer, or a second responder, asking who was told, what they were told, and who has it | 1. the state line "Not acknowledged, firing since 13:07" 2. the page's title and text 3. the channel message before and after acknowledgement | none: nothing here is the one thing to do; "Open the monitor to acknowledge it" is a link |
| 4 Monitor | The on-call engineer who followed the page, on a phone at night | 1. "Firing since 13:07 (2 h 9 min)" 2. who was paged and Acknowledge 3. the chart crossing the threshold at 13:02 | none: Acknowledge is green; Silence… is a default button whose yellow confirm is inside its menu |
| 6 Investigation | An engineer deciding whether to trust the agent's report | 1. claim 1's provenance line, "Not verified" 2. the claim 3. its evidence query, then the verdict buttons | none: each claim's verdict is a small button after its evidence |
| 9 Traces | The engineer following "Traces slower than 500 ms" | 1. the chart's rise at 13:02 and the marked trace 2. the two dark bars, payments-db 3. the sentence "payments-db took 957 ms of the 1,204 ms" | none |
| 10 Logs | The engineer following "Error logs" | 1. the rise from 13:05 2. the newest message, "payments-db pool exhausted" 3. the count and the paused live tail | none |
| 3 Monitors | An on-call engineer asking what needs attention now | 1. "2 firing (1 acknowledged), 1 pending, 1 silenced" 2. the first row's red mark and "not acknowledged" 3. Now against Threshold | New monitor |
| 12 Who is notified | Anyone asking who is on call tonight and where alerts go; the owner ending a silence | 1. On call now: payments, Dana and Kim 2. the payments route's escalation 3. the silence and End silence | New route |
| 2 Dashboard | A service owner or on-call engineer asking whether checkout is healthy and where it is slow | 1. the banner, above 500 ms since 13:02 2. the four figures, 912 ms first 3. the POST /v2/orders line above the dashed objective | none: a reading screen |
| 1 Dashboards | A service owner looking for their dashboard, or for whatever is unhealthy | 1. "3 have a panel in a critical state" 2. the State column, critical first 3. the name beside it | New dashboard (first run: New key) |
| 7 Proposed change | The dashboard owner deciding whether to accept the agent's edit | 1. the provenance line and the three changes with their boxes 2. each before and after, the new panel with today's data 3. the checks and the runbook warning, then Apply 2 changes | Apply 2 changes |
| 5 New monitor | Someone turning a query into a rule | 1. the query and its value now, 0.40% 2. the threshold row 3. the backtest sentence and chart | Save monitor |
| 8 Keys | A platform owner giving a sender access | 1. the never-used key 2. the instructions in the waiting panel 3. New key | New key; in the dialogs Create key and Done (behind a scrim, so the page's button does not compete) |

## Known limits of these images

- Static designs: no speed budget is measured on them (`tools/speed.mjs` was not run); the
  system's own fixture page is the floor for that.
- Not checked: a screen reader by ear, real touch hardware, Safari and Firefox, reduced motion
  (nothing on these screens animates beyond the system's own transitions).
- 200% zoom is imaged for Monitors and Monitor only; the rest were not zoomed.
