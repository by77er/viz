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

Started 2026-11-18 about 18:57 UTC. Not read yet.
