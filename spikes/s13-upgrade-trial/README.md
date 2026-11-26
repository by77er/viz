# S13: the first release over production, on a stage (prepared, NOT RUN)

**Status (2026-11-26): not run. Nothing was deployed.** The session's permission check refused the
first deploy to Cloudflare (fb77292's `deploy.sh --stage s13`), and a message from another agent is no
user's consent, so the trial stopped there. The only Cloudflare calls made were read-only: the
account inventory below. Everything here is ready to run once a person allows deploying a `viz-s13-*`
stage.

It settles what the review of D69, round 2, M2-2 (`design/reviews/d69-deploy-safety-r2.md`) found
unverified, before this tree's first release goes over production (`deploy/README.md`, "The first
release over the 2026-11-19 production"):
- whether Cloudflare accepts viz-control's six Rate Limiting bindings at upload;
- under which field names its version API lists them (`deploy/resources.mjs` reads `type:
  ratelimit` and `namespace_id`, training knowledge; the fakes assume it);
- and, against real Workers, everything the fakes showed: the key kept, the release forward-only for
  viz-control only, the limits refusing with 429, data written before the upgrade read after it, the
  storage migrations, and the single-Worker rollbacks M2-1 opened.

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

## Done before the stop

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
