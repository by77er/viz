# S13: the first release over production, on a stage

**Status (2026-11-28): done; the stage is destroyed.** The owner authorised stage deploys on 2026-11-28 (standing, recorded in
`AGENTS.md`). The two earlier refusals (2026-11-26) were this session's permission check, before that
authorisation. Results are recorded step by step below as they come; numbers are measured on Cloudflare
from outside (this sandbox, through its proxy) unless said otherwise.

It settles what the review of D69, round 2, M2-2 (`design/reviews/d69-deploy-safety-r2.md`) found
unverified, before this tree's first release goes over production (`deploy/README.md`, "The first
release over the 2026-11-19 production"):
- whether Cloudflare accepts viz-control's six Rate Limiting bindings at upload;
- under which field names its version API lists them (`deploy/resources.mjs` reads `type:
  ratelimit` and `namespace_id`, training knowledge; the fakes assume it);
- and, against real Workers, everything the fakes showed: the key kept, the release forward-only for
  viz-control only, the limits refusing with 429, data written before the upgrade read after it, the
  storage migrations, and the single-Worker rollbacks M2-1 opened.

## Results

### Step 1: fb77292 with its own tooling (2026-11-28, 07:56 to 08:10 UTC)

| Check | Result |
|---|---|
| `deploy.sh --stage s13` from fb77292's worktree (prebuilt engines, its own `npm ci`) | exit 0 in 104 s; seven Workers promoted; `OAUTH_CLIENT_KEY` created on `viz-s13-control`; smoke `/healthz` healthy (ingest 63 ms, query 50, control 32, ruler 42, mcp 79) |
| `bootstrap.mjs --tenant s13-trial --stage s13` | admin and smoke keys written to 0600 files in the session's scratch directory; nothing printed |
| `trial.mjs seed` (this directory) | Remote Write 204; the series read back (42); `POST /oauth/register` 201; one grant (authorize, approve with the admin key: 201, code exchanged with its PKCE verifier); the access token answers `tools/list` at `/mcp` (200) |

**Finding S13-1 (minor, all releases so far): a stage advertises production's OAuth issuer.** On a
stage, `configure.mjs` leaves `PUBLIC_URL` as the component's own (`https://vis.bitcru.sh`), so
`viz-s13-gateway`'s `/.well-known/oauth-authorization-server` names `https://vis.bitcru.sh` as issuer and
endpoints, and `/oauth/authorize` accepts only the resource `https://vis.bitcru.sh/mcp`. Tokens are still
the stage's (tagged under its own `OAUTH_CLIENT_KEY`, so production refuses them), but a client that
follows the stage's metadata is sent to production. The trial takes the resource from the metadata. Fix
(later release): a stage's `PUBLIC_URL` is its gateway's workers.dev URL.

### Step 2: pull request #9's tree over it (f93806e, 08:04 to 08:15 UTC)

| Check | Result |
|---|---|
| `resources.mjs ensure --stage s13` | the six Rate Limiting ids allocated (7886 to 7891) |
| `VIZ_OAUTH_PUBLIC=1 deploy.sh --stage s13` (prebuilt engines, `SMOKE_KEY` from its file) | **Cloudflare accepted the six `ratelimits` at upload.** exit 0 in 111 s; record forward-only by `oauth-public` for viz-s13-control only, as designed; `OAUTH_CLIENT_KEY` kept; smoke healthy, Remote Write 204 in 377 ms and all 9 samples read 275 ms after the acknowledgement. (A first attempt stopped at `npm ci` with the session's disk full; nothing was uploaded.) |
| Version API, `GET …/workers/scripts/viz-s13-control/versions/<id>` | each binding listed as `{"name":"OAUTH_RL_SOURCE","namespace_id":"7886","simple":{"limit":120,"period":60},"type":"ratelimit"}`: **`type: ratelimit` and `namespace_id` as a string**, the field `resources.mjs` reads first. M2-2 is settled |
| `resources.mjs ensure --stage s13` again | passes; all six ids `kept (bound by viz-s13-control)` |
| `trial.mjs after` | the series written before read after (42); the client registered before passes `/oauth/authorize`; the access token issued before answers at `/mcp`; the refresh token issued before refreshes once and is refused the second time (`invalid_grant`) |
| Credential limit: one fresh code presented 30 times at `/oauth/token` (wrong verifiers) | 6 answered 400, then 24 answered **429 `too_many_requests` with `Retry-After: 60`** (limit 5 a minute; one more than the limit got through, as a per-location limiter allows) |
| Source limit: 150 `POST /oauth/register` in 4.6 s | **all 201**. This sandbox's outbound address rotates (12 requests to Cloudflare's trace page came from 8 addresses in one /16), so no single address reached 120 |
| Source limit again: 1,300 `POST /oauth/register` in 10.7 s, four at a time | 630 answered 201, then **670 answered 429 `too_many_requests` with `Retry-After: 60`**, the first at request 518: consistent with a limit of 120 per address over about five addresses |
| Workers' invocations, 07:55 to 08:17 UTC (analytics API, `spikes/s10-signals-trial/analytics.mjs`) | fetch 3,082, cron 1, rpc 4, queue 4, **every one with status `success`** (no exception over the cutover, the publisher's 3 → 7 and the shard's 1 → 3 migrations included). The rows are under `__unknown__` rather than script names, so they are not split per Worker. List price of the window: US$0.001 |

### Step 3: an ordinary second release, then single-Worker rollbacks (08:15 to 08:25 UTC)

| Check | Result |
|---|---|
| The same tree released again | exit 0 in 82 s; **not forward-only** ("the previous release can open everything this one writes"); key kept; smoke healthy with the data check |
| `release.mjs rollback --record <step 1's record> --only <w>` for viz-query, viz-gateway, viz-mcp, viz-ruler, viz-ingest, viz-publisher | **each allowed**, exit 0, one Worker restored to fb77292's version each time |
| The same for viz-control | **refused**, exit 3, nothing changed: "below its floor … oauth-public" |
| The mixed stage (six Workers of fb77292, viz-control of #9) | `/healthz` healthy, every backend 200; the series read back; the old client passes `/oauth/authorize`; a **fresh grant** made through #9's viz-control answers at fb77292's `/mcp` (200) |
| The grant from step 1 | its access token answered 401 and its refresh token `invalid_grant` after the limit test. That is the limit test's doing, not the rollback's: the 30 wrong-verifier exchanges ended that client's grant, which is what D44's fix (`e63859e`) specifies for a failed exchange. Not separated by a further test |

### Step 4: cleanup (08:25 UTC)

`resources.mjs destroy --stage s13` (from #9's tree): every Worker, the bucket, the KV namespace, the four
queues and their consumers deleted, the six rate-limit ids freed; its leftover check lists nothing. The
inventory after, diffed with the one before (`spikes/s11-large-ledger/inventory.mjs --diff`): no `viz-s13-`
name remains; the viz names that changed are `viz-preview-app` (spike S14, added 2026-11-27) and
`viz-spike-s0-do-billing` with its twelve object namespaces (deleted 2026-11-28 on the owner's word); one
Worker and one custom domain not of viz changed in the account, which this trial did not touch. The trial's
keys and tokens were shredded; the fb77292 worktree's build directories were removed.

**Cost** (analytics API, 07:55 to 08:17 UTC): US$0.001 at list price; the rest of the trial was a few
hundred more requests. Within the stated worst case of US$1.

### What this says about merging #9

- The bindings are accepted and read back as the tooling expects; the first production release will not
  stop at upload or at `resources.mjs` for this reason.
- The upgrade keeps the key, the clients, issued tokens and data, and is forward-only for viz-control alone.
- Both limits refuse with 429 and `Retry-After` on Cloudflare.
- Not shown here: production's own custom domain in front (the stage is on workers.dev), and real traffic.

## What would be deployed

Stage `s13`, names `viz-s13-*` only:
- Workers `viz-s13-publisher`, `-ingest`, `-control`, `-query`, `-ruler`, `-mcp`, `-gateway` (only the
  gateway on workers.dev), and `viz-s13-probe` (workers.dev, a path that answers 404 without a token
  made for the trial; it asks `viz-s13-control`'s `/healthz` through a service binding, since that
  route is not public);
- R2 `viz-s13-lake`, KV `viz-s13-config`, queues `viz-s13-flush`, `-maint`, `-flush-dlq`, `-maint-dlq`.

Production (`viz-control`, `viz-ingest` and the rest, `viz-lake`, `viz-config`, `vis.bitcru.sh`),
`viz-spike-s0-do-billing` and `viz-spike-s12-reload` are never touched.

**Worst-case cost, stated before anything runs** (modelled, Workers Paid rates):
- at most 4 hours: `VIZ_STAGE_EXPIRES_AT` stops the ruler's alarms and cron by itself;
- three releases and a few rollbacks;
- about 200 OAuth requests (registrations past the source limit, a code past the credential limit),
  about 50 Remote Write and query requests;
- Durable Object requests in the low thousands, KV writes under 100, R2 operations under 1,000.

Under US$0.05 modelled; **stated as under US$1 worst case**. The Rate Limiting binding's page names
no price. Usage is to be read from the analytics API afterwards.

## Done before the first stop (2026-11-26)

| What | Result |
|---|---|
| `git worktree add --detach <scratch>/wt-fb77292 fb77292` | made (outside the repository, in the session's scratch directory) |
| fb77292's two WASM engines, built in the worktree (`CARGO_BUILD_JOBS=2`) | built: `viz_query.wasm` 3,161,304 bytes raw, 986,609 gzip -9 (fb77292 does not commit them; CI built production's) |
| Account inventory before (`spikes/s11-large-ledger/inventory.mjs`, read only, 2026-11-26) | 28 Workers (viz: the seven of production, `viz-spike-s12-reload`), 7 R2 buckets (`viz-lake`), 8 KV namespaces (`viz-config`), 4 queues (production's), 36 Durable Object namespaces, 12 custom domains (`vis.bitcru.sh → viz-gateway`). No `viz-s13-` name |

## The steps (to run)

Each step's numbers are to be labelled measured on Cloudflare (from outside, through this sandbox's
proxy), or read from the analytics API with its window.

1. **fb77292, with its own tooling** (as the owner's production deploy): from the worktree,
   `VIZ_WASM_PREBUILT=1 VIZ_RELEASE_SHA=fb7729280d79f41e4f9fa40be1867c0fd2491352
   VIZ_STAGE_EXPIRES_AT=<now + 4 h> VIZ_ACK_MIGRATIONS="viz-publisher@v1 viz-ingest@v1 viz-control@v1
   viz-query@v1 viz-ruler@v2" deploy/deploy.sh --stage s13` (its own `npm ci`). Its release creates
   `OAUTH_CLIENT_KEY` on `viz-s13-control`. Then its `bootstrap.mjs --stage s13 --key-file …
   --smoke-key-file …` (keys in 0600 files in the scratch directory, never printed); Remote Write of
   a known series and a query reading it back; `POST /oauth/register`; one grant (`/oauth/authorize`,
   then `POST /api/v1/control/oauth/approve` with the admin key, then the code exchanged with its PKCE
   verifier) so a real layout 1 access and refresh token exist (kept in 0600 files).
2. **This tree, with its tooling**, from a snapshot of the working tree (others edit it) with its own
   WASM built: `resources.mjs ensure --stage s13`, then `VIZ_OAUTH_PUBLIC=1 deploy/deploy.sh --stage
   s13`. Record:
   - whether the upload with the six `ratelimits` is accepted;
   - `GET …/workers/scripts/viz-s13-control/versions/<id>`: the exact fields of the six bindings (fix
     `resources.mjs` `NAMESPACE_FIELDS` and the fakes if they differ);
   - `resources.mjs ensure --stage s13` again: passes, ids `kept (bound by viz-s13-control)`;
   - the key kept (the record says `kept`; the old client registration still passes
     `/oauth/authorize`; the old access token still answers at `/mcp`; the old refresh token still
     refreshes once, then is dead);
   - the record: `forwardOnly: true`, by `oauth-public` (viz-s13-control) only;
   - `/healthz` of viz-s13-control through the probe: each `OAUTH_RL_*` `bound`;
   - the limits: about 150 `POST /oauth/register` in a minute from this address (source limit 120)
     and one fresh layout 2 code presented 30 times at `/oauth/token` (credential limit 5): 429 with
     `Retry-After` and `too_many_requests`, counted per answer;
   - the series written in step 1 read back;
   - the publisher's (schema 3 → 7) and the shard's (1 → 3) migrations: no exception in the Workers'
     invocation analytics or a `wrangler tail` of the two objects over the cutover.
3. **An ordinary second release** from the same snapshot: ids unchanged, not forward-only. Then the
   single-Worker rollbacks to step 1's record (`release.mjs rollback --stage s13 --record … --only
   viz-query`, and viz-gateway, viz-mcp, viz-ruler, viz-ingest, viz-publisher): allowed; `--only
   viz-control`: refused by its floor.
4. **Cleanup**: `resources.mjs destroy --stage s13` (from this tree: it also frees the stage's
   rate-limit ids), the probe deleted, the inventory taken again and diffed (`inventory.mjs --diff`):
   only `viz-s13-*` names may have come and gone. Worktrees removed. If step 2 failed in a way that
   would strand production, the stage stays for inspection until its expiry, and that is reported
   instead.

## Cleanup of what was made

The fb77292 worktree (`git worktree list`) is the only thing made; it stays for the trial (its built
engines save the rebuild) and is removed with `git worktree remove --force <path>` at the end, or now
if the trial is not to run. No Cloudflare resource was created.
