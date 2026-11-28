# Spike S0: Durable Object duration billing for periodic wakes

The cost floor depends on one unmeasured thing: when an object wakes every N seconds, does
Cloudflare bill it for the moments it runs, or for the whole time between wakes? See
`design/VERIFICATION.md` §4 (S0) and `design/DESIGN.md` §11.

## What is deployed

A Worker, `viz-spike-s0-do-billing`, in the project's Cloudflare account, with twelve
SQLite Durable Object classes, one object each, so usage can be read per class:

| Class | Woken by | Every |
|---|---|---|
| `A1`, `A5`, `A15`, `A60` | its own alarm; one SQLite write per wake | 1, 5, 15, 60 s |
| `B1`, `B5`, `B15`, `B60` | a request from a pinger; one SQLite write per wake | 1, 5, 15, 60 s |
| `P1` … `P60` | pingers that call the `B` objects (not what is being measured) | same |

Every object stops re-arming at a deadline (26 hours after start), so the experiment ends
by itself. Endpoints (`/start?hours=`, `/stop`, `/status`) need the `x-key` header; the key
is a Worker secret and is not in the repository.

## Reading the result

```
node read.mjs                      # last 24 hours
node read.mjs 2026-11-18T20:00:00Z 2026-11-19T20:00:00Z   # the 24 complete hours of the run
```

It prints, per class: requests, billed active seconds, billed GB-seconds, and duty (active
time as a share of wall time). Usage is recorded in hour buckets; `since` is inclusive and
`until` is exclusive, so give whole hours. (Until 2026-11-26 `until` was inclusive and the
reader returned one hour bucket more than the window it printed; see "Correction to the
early reads" below.) **Decision rule:** if the 60-second classes show more than
about 25% duty, per-minute ruler and publisher ticks are too expensive as designed; fold
them into fewer objects and lengthen intervals for small tenants.

## Cost of running it

Estimated before the run: about 110,000 alarm wakes and the same number of row writes, and
at most a few tens of thousands of GB-seconds if every object were billed continuously. The
estimate was low for wakes and rows: it counted only the `A` objects and one row per wake.

Used by the whole run (measured on Cloudflare, hour buckets 2026-11-18T19:00Z to
2026-11-19T22:00Z, all twelve classes):

| | Used | At list price, before allowances (modelled from the measured usage) |
|---|---|---|
| Object invocations | 360,155 | $0.054 at $0.15 per million |
| Billed duration | 1,661 GB-s (12,980 s active at 128 MB) | $0.021 at $12.50 per million GB-s |
| SQLite rows written | 1,083,393 | $1.08 at $1.00 per million |
| SQLite rows read | 1,923,352 | $0.002 at $0.001 per million |
| Worker requests | 3 (two on 18 Nov, one `/status` on 26 Nov) | nothing |

About $1.16 at list price if nothing were included. What it added to the invoice is smaller
and was not read: the invoice is not available through the analytics API. The account's
Durable Object usage for 1–26 November across all its Workers (measured on Cloudflare) was
2,867,598 invocations, 68,702 GB-s, 3,935,031 rows written and 325.9 million rows read,
against monthly allowances of 1 million, 400,000 GB-s, 50 million and 25 billion
(`research/01-cloudflare-data-services.md`). Only invocations are over their allowance,
so if the billing period is the calendar month the spike's share is its 360,155 invocations,
about $0.05.

## Removing it

```
npx wrangler delete --name viz-spike-s0-do-billing
```

**Deleted on 2026-11-28** by the owner's instruction (`npx wrangler delete --name
viz-spike-s0-do-billing`, which succeeded). The measurement was done and the objects idle; deleting the
Worker also deleted its twelve objects and their stored counters (245,760 bytes of SQLite storage,
measured on Cloudflare, 24–26 November), so `/status` can no longer be read. The analytics stay, and
the result below was read from `/status` before the deletion.

## Result

Started 2026-11-18 at 19:04:20 UTC with a 26-hour deadline of 2026-11-19 21:04:20 UTC (the
objects' own records, read from `/status` on 2026-11-26; an earlier version of this file
said "about 18:57").

### Final read: 24 complete hours, 2026-11-18 20:00 to 2026-11-19 20:00 UTC (measured on Cloudflare)

Read on 2026-11-26 with `node read.mjs 2026-11-18T20:00:00Z 2026-11-19T20:00:00Z`. Every
object ran for the whole of each of these 24 hour buckets. The hour-by-hour columns come
from the same two analytics datasets grouped by hour.

| Class | Woken by | Every | Wakes counted | Billed active time | Per wake | Duty | Duty, lowest and highest hour | Billed GB-s |
|---|---|---|---|---|---|---|---|---|
| A1 | alarm | 1 s | 86,287 | 1,716.5 s | 19.9 ms | 1.987% | 1.596–3.046% | 219.71 |
| A5 | alarm | 5 s | 17,274 | 355.5 s | 20.6 ms | 0.411% | 0.267–0.815% | 45.50 |
| A15 | alarm | 15 s | 5,787 | 141.4 s | 24.4 ms | 0.164% | 0.120–0.207% | 18.10 |
| A60 | alarm | 60 s | 1,448 | 28.5 s | 19.7 ms | 0.033% | 0.014–0.057% | 3.65 |
| B1 | request | 1 s | 86,312 | 3,220.7 s | 37.3 ms | 3.728% | 2.993–6.171% | 412.25 |
| B5 | request | 5 s | 17,281 | 816.7 s | 47.3 ms | 0.945% | 0.774–1.137% | 104.54 |
| B15 | request | 15 s | 5,754 | 263.8 s | 45.8 ms | 0.305% | 0.181–0.474% | 33.76 |
| B60 | request | 60 s | 1,434 | 48.9 s | 34.1 ms | 0.057% | 0.048–0.095% | 6.26 |
| P1 | alarm, then calls `B1` | 1 s | 86,340 | 3,769.0 s | 43.7 ms | 4.362% | 3.557–7.049% | 482.44 |
| P5 | alarm, then calls `B5` | 5 s | 17,298 | 1,198.7 s | 69.3 ms | 1.387% | 1.203–1.579% | 153.43 |
| P15 | alarm, then calls `B15` | 15 s | 5,758 | 314.6 s | 54.6 ms | 0.364% | 0.289–0.531% | 40.27 |
| P60 | alarm, then calls `B60` | 60 s | 1,443 | 96.5 s | 66.9 ms | 0.112% | 0.091–0.167% | 12.35 |

"Wakes counted" is the request count of the invocations dataset, which is sampled; over the
whole run it is within 1% of the objects' own counters ("Did it stop?"). Billed GB-s is
billed active time at 128 MB in every class. The window asked for at the time, 19:00 to
19:00, gives the same figures to within 1% (A60 0.033%, B60 0.057%), but its first hour
bucket holds only the 55.7 minutes after the start, so the table uses 20:00 to 20:00.

**Conclusion against the decision rule: not triggered.** Over 24 hours the 60-second
classes ran at 0.033% duty when woken by their own alarm and 0.057% when woken by a
request, and no single hour was above 0.095%, against a threshold of about 25%: lower by a
factor of 440 to 760. **An object that wakes periodically is billed for the moments it
runs, not for the time between wakes**, and the 24 hours agree with the first two. Per-minute
ruler and publisher ticks stay as designed; nothing needs folding into fewer objects on
account of the wake.

What a wake costs, from these 24 hours:

- **Duration.** 20–24 ms per alarm wake and 34–47 ms per request wake, whatever the
  interval. An alarm wake that also makes one call to another object and waits for it (the
  `P` pingers, which were not the subject) bills 44–69 ms.
- **Per month for one object ticking once a minute** (modelled from the measured day, at
  list price, before any allowance): 110–190 GB-s, $0.0014–0.0023 of duration; 43,200
  invocations, $0.0065.
- **Rows written cost more than the duration.** Every class wrote 3.0 rows per wake as
  Cloudflare counts them (whole run: `A1` 280,059 rows for 93,511 wakes, `B1` 283,517 for
  93,509, `P1` 280,465 for 93,537). At $1.00 per million that is $0.13 a month for a
  once-a-minute object (modelled), roughly 55 to 95 times its duration, and it is the
  term to watch when a tick is designed: 50 million rows a month are included. `B` objects
  never call `setAlarm` and `A` objects call it on every wake, yet both show 3.0, so
  `setAlarm` added no visible row in this dataset. That contradicts the "one row written
  per `setAlarm`" in `research/`; this spike was not built to settle how each statement is
  counted, and it stays a lead.

These are simple wakes that do one counter update and one timestamp write. A wake that
does real work (a rule evaluation with queries) will bill for as long as that work takes;
that is still unmeasured.

Errors (measured on Cloudflare, whole run): 79 of 360,155 invocations. 78 alarm invocations
are reported `clientDisconnected` (`A1` 44, `P1` 16, `A5` 11, `A15` 3, `P15` 2, `A60` 1,
`P5` 1) and one `P1` alarm `scriptThrewException`. No request-woken (`B`) invocation
failed. The cause of `clientDisconnected` on an alarm was not investigated.

### Did it stop?

Yes, by itself, at the deadline. Checked two ways on 2026-11-26:

- `/status` at 04:37 UTC: all twelve objects have no alarm set. The last wake of each
  falls between 21:03:37 and 21:04:19 UTC on 2026-11-19, just before the deadline of
  21:04:19.875. The objects' own wake counts are `A1` 93,409, `A5` 18,708, `A15` 6,236,
  `A60` 1,559; `B1` 93,543, `B5` 18,718, `B15` 6,238, `B60` 1,559; `P1` 93,544, `P5` 18,718,
  `P15` 6,238, `P60` 1,559.
- Analytics (measured on Cloudflare, queried from 2026-11-19 22:00 UTC to 2026-11-26 04:42
  UTC): no invocation and no billed duration in any hour bucket after the one starting
  2026-11-19 21:00, except the twelve calls that this `/status` check itself made (one per
  object, 3.2 s active and 0.41 GB-s in total, no rows written).

The whole run occupies 27 hour buckets, from the one starting 2026-11-18 19:00 to the one
starting 2026-11-19 21:00.

### Correction to the early reads

Until 2026-11-26 `read.mjs` treated `until` as inclusive, so it also returned the hour
bucket starting at `until`. The first early read below therefore covers 19:04 to about
20:17 and the second 19:04 to about 21:38, not one and two full hours, and their wake
counts, active times, GB-s and duty figures are too high for the windows they name (duty
by roughly a fifth and a quarter). Their per-wake times are ratios and are not affected.
The hour bucket starting 19:00 on its own holds 3,341 `A1` wakes, not 4,382. The tables are
left as they were read; use the final read above.

### Early read: one full hour, 19:00–20:00 UTC (measured on Cloudflare)

| Class | Woken by | Every | Wakes counted | Billed active time | Per wake | Duty | Billed GB-s |
|---|---|---|---|---|---|---|---|
| A1 | alarm | 1 s | 4,382 | 84.1 s | 19 ms | 2.3% | 10.77 |
| A5 | alarm | 5 s | 877 | 18.2 s | 21 ms | 0.5% | 2.33 |
| A15 | alarm | 15 s | 292 | 7.7 s | 26 ms | 0.2% | 0.99 |
| A60 | alarm | 60 s | 75 | 1.5 s | 20 ms | 0.04% | 0.19 |
| B1 | request | 1 s | 4,379 | 167.7 s | 38 ms | 4.7% | 21.47 |
| B5 | request | 5 s | 876 | 42.4 s | 48 ms | 1.2% | 5.43 |
| B15 | request | 15 s | 292 | 13.1 s | 45 ms | 0.4% | 1.67 |
| B60 | request | 60 s | 75 | 3.2 s | 43 ms | 0.09% | 0.41 |

("Wakes counted" is the analytics request count, which is a little above the number of
intervals in an hour.)

**An object that wakes periodically is billed for the moments it runs, not for the time
between wakes.** Each wake cost about 20 ms of billed duration when woken by its own alarm
and about 40 ms when woken by a request, regardless of the interval. The 60-second classes
are at 0.04–0.09% duty, far below the 25% decision threshold.

At this rate an object ticking once a minute bills about 0.19 GB-s an hour, about 140 GB-s
a month, or roughly $0.002 at $12.50 per million GB-s, before any included allowance.

### Second early read: two full hours, 19:00–21:00 UTC (measured on Cloudflare)

| Class | Wakes counted | Billed active time | Per wake | Duty | Billed GB-s |
|---|---|---|---|---|---|
| A1 | 9,185 | 159.4 s | 17 ms | 2.2% | 20.40 |
| A5 | 1,838 | 37.5 s | 20 ms | 0.5% | 4.79 |
| A15 | 613 | 15.6 s | 25 ms | 0.2% | 2.00 |
| A60 | 155 | 4.0 s | 26 ms | 0.06% | 0.51 |
| B1 | 9,172 | 335.6 s | 37 ms | 4.7% | 42.96 |
| B5 | 1,837 | 86.4 s | 47 ms | 1.2% | 11.06 |
| B15 | 614 | 27.9 s | 45 ms | 0.4% | 3.58 |
| B60 | 155 | 5.9 s | 38 ms | 0.08% | 0.76 |

The second hour matches the first: 17–26 ms per alarm wake, 37–47 ms per request wake, and
duty in proportion to how often the object wakes. The 60-second classes stay at 0.06–0.08%,
against a decision threshold of 25%.

The final 24-hour read is above.
