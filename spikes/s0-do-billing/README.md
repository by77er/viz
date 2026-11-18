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
node read.mjs 2026-11-18T19:00:00Z 2026-11-19T19:00:00Z
```

It prints, per class: requests, billed active seconds, billed GB-seconds, and duty (active
time as a share of wall time). **Decision rule:** if the 60-second classes show more than
about 25% duty, per-minute ruler and publisher ticks are too expensive as designed; fold
them into fewer objects and lengthen intervals for small tenants.

## Cost of running it

About 110,000 alarm wakes and the same number of row writes over the run, and at most a few
tens of thousands of GB-seconds if every object were billed continuously: inside the
plan's included allowances.

## Removing it

```
npx wrangler delete --name viz-spike-s0-do-billing
```

## Result

Started 2026-11-18 about 18:57 UTC.

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

These are simple wakes that do one SQLite write. The final 24-hour read
is still to come, and a wake that does real work (a rule evaluation with queries) will bill
for as long as that work takes.
