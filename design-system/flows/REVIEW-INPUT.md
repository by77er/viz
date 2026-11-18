# Review input for the flow screens

For each screen: who is looking, what they are trying to do, and the first three things the
eye should reach, in order. Images are in `shots/` (light and dark at 1440 px, light at 400 px).

| Screen | Who and what | Reading order |
|---|---|---|
| 1 Dashboards | A service owner looking for their dashboard, or for whatever is unhealthy | 1. the count of critical dashboards in the subtitle 2. the State column 3. the name beside it |
| 2 Dashboard | A service owner or on-call engineer asking whether checkout is healthy and where it is slow | 1. the banner saying what is wrong and since when 2. the four figures 3. the latency chart's line above the dashed objective |
| 3 Monitors | An on-call engineer asking what needs attention now | 1. "2 firing, 1 pending" 2. the firing rows' state and duration 3. the current value against the threshold |
| 4 Monitor | An on-call engineer who followed a page | 1. "Firing since 13:02" 2. the chart crossing the threshold 3. the three actions |
| 5 New monitor | Someone turning a query into a rule | 1. the query and its current value 2. the threshold fields 3. how often it would have fired |
| 6 Investigation | An engineer deciding whether to trust an agent's report | 1. the first claim 2. the query under it 3. the caution that it is a starting point |
| 7 Proposed change | A dashboard owner deciding whether to accept an agent's edit | 1. the three changes and their reasons 2. the new panel with real data 3. the checks, especially the warning |
| 8 Keys | A platform owner giving a sender access | 1. the key that has never been used 2. the instructions to send with it 3. New key |

One blue button per screen: New dashboard, none on Dashboard (reading, not acting), New
monitor, none on Monitor (its actions are green and yellow), Save monitor, This was the
cause, Apply change, New key.

Known gaps: no trace or log screens; the dashboard's Text view and Edit mode are not drawn;
loading, empty and error states of these screens are not drawn (the components for them
exist in the system).
