# Spike S9: rolling back across the release that created viz-control's OAuth key

**Status: in progress (2026-11-19).** This file was written before anything was deployed.
Results follow once measured.

The question comes from `deploy/README.md`, "Known risks", "Rollback across the release that
created (or rotated) the OAuth key", and from D53 in `design/DECISIONS.md`. On a stage:

1. deploy release R0 of viz-control without `OAUTH_CLIENT_KEY`;
2. deploy R1 (the deploy generates the key, D53);
3. `node deploy/release.mjs rollback` to R0's record;
4. deploy R2.

Measured on Cloudflare:

- is the rollback's `versions deploy` refused (API error 10220, "secrets have changed"), or allowed?
- if allowed, which key serves afterwards: does `/oauth/register` answer 503, or does the
  rolled-back version keep the current secret?
- does R2's upload inherit the key from the newest version (kept), or does the tooling refuse
  (exit 3), or does it create a new key?

## Worst-case cost (stated before anything was deployed)

Stage `s9`. **Only viz-control is deployed**, plus the one KV namespace its config binds. That is
all it needs to start and to serve `/healthz`, `/.well-known/oauth-authorization-server`,
`/oauth/register` and `/oauth/authorize`. None of these paths touches a Durable Object or KV.
Exact names:

| Resource | Name | Notes |
|---|---|---|
| Worker | `viz-s9-control` | on workers.dev (`viz-s9-control.<account subdomain>.workers.dev`); no route, no custom domain, no cron |
| Durable Object namespace | the `Tenant` class of `viz-s9-control` | created by its migration `v1`; no object is ever made (no tenant exists) |
| KV namespace | `viz-s9-config` | bound as `CONFIG`; nothing is written to it |

No R2 bucket, no queue and no other Worker is created. Nothing runs on a timer: viz-control has
no cron and no alarm unless a tenant exists. The stage also carries `--expires
2026-11-19T13:30:00Z` (`VIZ_STAGE_EXPIRES_AT`, under 3 hours from the start), although only the
ruler reads that variable.

| Item | Planned | Worst case | Price (Workers Paid) | Worst-case cost |
|---|---|---|---|---|
| Worker requests (probes from outside) | about 300 | 2,000 | $0.30/M beyond the included 10M/month | under $0.001 |
| Worker CPU | under 10 ms per request | 2,000 × 50 ms | $0.02/M CPU-ms | under $0.01 |
| Durable Object requests and duration | 0 | 0 (no path that is probed reaches one) | — | $0 |
| KV operations | 0 | a few reads | $0.50/M reads | $0 |
| KV namespace, DO namespace, Worker versions (about 6) | — | — | no charge | $0 |
| `wrangler tail` sessions (to see which version served each probe) | 5 | 10 | no charge | $0 |

**Worst case: under US$0.01, stated as under US$0.10.** All of it fits inside the plan's
included allowances. Prices are from developers.cloudflare.com/workers/platform/pricing/ as viz's
earlier spikes read them.
