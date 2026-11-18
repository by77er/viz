# Deploy

How viz gets from a commit on `main` to `vis.bitcru.sh`, and back again. This directory holds
the deploy tooling, the public gateway Worker, and the record of the trial on Cloudflare. It
changes no component: everything it needs from one is under "Needed changes".

| File | What it does |
|---|---|
| `workers.json` | Which Workers exist, in dependency order (callees first), which are deployed, and why the others are not. Deployment-wide settings: domain, observability sampling, Durable Object code-update mode, resource names, shared vars |
| `configure.mjs` | Generates each Worker's production (or staged) wrangler config into `generated/` from the component's own `wrangler.jsonc` |
| `resources.mjs` | Creates the R2 bucket, KV namespace and queues (idempotent); `destroy --stage` deletes a stage |
| `release.mjs` | Upload every Worker, then promote callees first; the migration gate; release records; rollback |
| `deploy.sh` | The whole deploy: WASM, `npm ci`, resources, configure, release, smoke test, automatic rollback |
| `smoke.mjs` | `/healthz`, then a real Remote Write and a query that must return it within 60 s |
| `bootstrap.mjs` | A tenant's first API key, through a one-time token |
| `load.mjs` | Steady write and read load with a cutover report (used by the trial) |
| `gateway/` | `viz-gateway`, the Worker on `vis.bitcru.sh`, and its tests |
| `stage/` | The one shim a staged deployment needs (queue names, see "Needed changes" 1) |
| `ci/matrix.mjs` | Which components CI checks in this checkout |
| `resources.json` | KV namespace ids by title (not secret; rewritten by `resources.mjs`) |
| `generated/` | Build output: configs, manifests, release records. Git-ignored |

## How a push to main becomes a deployment

```
push to main
  └─ .github/workflows/deploy.yml   (concurrency group deploy-production; one run at a time)
       ├─ checks: ci.yml, the same jobs a pull request runs; builds both WASM engines once
       └─ deploy (GitHub environment "production"):
            1. download the WASM modules the checks built and tested
            2. acknowledgements: dispatch input + "Migration:" trailers of every commit since
               the release serving now (read from the version tag on Cloudflare)
            3. deploy/deploy.sh
                 npm ci (deploy/, stack/, control/, query/)
                 resources.mjs ensure       R2 viz-lake, KV viz-config, queues viz-flush, viz-maint,
                                            viz-flush-dlq, viz-maint-dlq
                 configure.mjs              generated/production/*.jsonc + manifest.json
                 release.mjs deploy         plan → refuse unacknowledged migrations (exit 3)
                                            phase 1: upload every Worker (serves nothing)
                                            phase 2: promote viz-ingest, viz-control, viz-query, viz-gateway
                 smoke.mjs                  /healthz; Remote Write + query with SMOKE_KEY
                 on smoke failure           no migration in the release → roll back to the previous
                                            release and fail; migration → fail loudly, no rollback
            4. upload the release record as artifact release-<sha> (90 days) and print it in the
               job summary
```

A manual run (`workflow_dispatch`) does the same with an `acknowledge_migrations` input, or,
with `rollback_to: <sha>`, restores the release recorded for that commit instead.

## Topology and routes

```
                       vis.bitcru.sh (Workers custom domain; no DNS record is created by hand)
                                   │
                              viz-gateway  ── routes by path, adds x-viz-route, nothing else
              ┌────────────────────┼────────────────────────┬───────────────────────┐
     service binding INGEST   service binding QUERY    service binding CONTROL   TENANT (DO, by script_name)
              │                    │                        │                     only for /api/v1/bootstrap
         viz-ingest            viz-query               viz-control
   edge (fetch), Shard, Ledger,   Leaf DOs; SHARD and      Tenant DO
   Flush, 4 queue consumers,      LEDGER bound from        (keys, dashboards,
   hourly cron                    viz-ingest by            settings)
                                  script_name
              └──────── R2 viz-lake, KV viz-config (shared by all three), queues ────────┘
```

| Path | Goes to | Notes |
|---|---|---|
| `POST /api/v1/write` | viz-ingest | Remote Write 1.0 |
| `POST /v1/metrics` | viz-ingest | OTLP/HTTP metrics |
| `POST /api/v1/push` | viz-ingest | routed as asked; edge does not serve it yet (404 from edge) |
| `/api/v1/query`, `/query_range`, `/labels`, `/series`, `/metadata`, `/api/v1/label/*`, `/api/v1/status/*` | viz-query | |
| `/api/v1/control`, `/api/v1/control/*` | viz-control | |
| `GET /healthz` | the gateway | asks ingest `/healthz`, query `/healthz`, control `/api/v1/control/openapi.json` (control has no health route, "Needed changes" 4); 200 `healthy` or 503 naming the backend |
| `POST /api/v1/bootstrap` | the gateway | exists only while the one-time secret is set ("Bootstrap") |
| anything else | the gateway | 404, JSON listing the entry points. No web UI and no page: the UI comes later, through design review |

The gateway is transparent: the incoming `Request` is handed to the backend as it arrived
(method, URL with query string, headers, body stream) and the backend's `Response` comes back
with its status, status text and every header, body streamed, plus `x-viz-route:
ingest|query|control|health|bootstrap|gateway`. A backend that throws becomes a retryable
502 with `Retry-After: 1`.

**Six connections.** Spike S1 (`spikes/s1-fanout-r2/README.md`, measured on Cloudflare,
2026-11-18) found that the six-connection limit applies to R2 binding reads and that a callee
reached through a service binding spends from its caller's budget: 96 R2 reads through 96
service-bound callees took the same ~720 ms as six-at-a-time from one invocation, while
Durable Object leaves had their own budgets (96 reads in 312 ms). The spike measured a Worker
bound to *itself*; a callee that is a different script was "expected to share the budget too;
not tested". So viz-ingest, viz-query and viz-control, called through the gateway, share the
gateway request's six. That is acceptable here because none of them fans out from the
Worker itself: an ingest request makes one `Shard.append` per slot the tenant's rows land on
(a tenant spreads over `spread` = 2 slots, so 1 to 2 calls), and the query Worker reads R2
only through `Leaf` Durable Objects (its coordinator "never touches R2"), each of which has
its own six. The only way to hit the shared limit is a request with more than six
simultaneous subrequests from the Worker, which neither path makes.

## Releases: upload, then promote

What Cloudflare documents, and what the pipeline does about it. Read on 2026-11-18.

| Platform fact | Source | What the pipeline does |
|---|---|---|
| A version is code + bindings + compatibility settings; a deployment says which version(s) serve. `wrangler deploy` creates a version and deploys it at 100%; the two steps can be decoupled. Storage state (KV, R2, Durable Objects) is not versioned | [Versions & deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/) | Phase 1 `wrangler versions upload --tag <sha>` for every Worker; nothing serves it. Phase 2 `wrangler versions deploy <id>@100%` in order |
| Two Workers joined by a service binding "may be at different points in their own gradual deployment"; overrides do not work for RPC | [Gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/), [Version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/) | Promote callees before callers (viz-ingest, viz-control, viz-query, viz-gateway) so a caller never runs ahead of what it calls; roll back in the reverse order. Both directions of skew still happen while a deployment propagates, so every RPC and format must work across one release (`contracts/COMPATIBILITY.md` §1, §3) |
| Each Durable Object is assigned one version per deployment, "will not change until you create a new deployment", and "will only be reset when it is assigned a different version" | [Gradual deployments with Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/) | Deploy at 100%, never a percentage split: every object moves once per release |
| An active object adopts new code when it hibernates or when `max_delay` expires (default `deferred`, 300 s); `immediate` resets it at once; the reset affects in-memory state only and callers see "Durable Object reset because its code was updated." | [Durable Objects code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/), [Troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/) | `--durable-objects-code-update-mode "deferred 30s"` (workers.json): in-flight requests get up to 30 s, and the old code stops serving within about half a minute instead of five. What a caller sees at that reset is not documented beyond the message: measured in the trial |
| Versions that change a Durable Object class's lifecycle (the `migrations` array or `exports`) "cannot be uploaded"; apply them with `wrangler deploy`; migrations "are atomic operations and cannot be gradually deployed" | [With Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/#durable-object-class-lifecycle-changes), [Migrations (legacy)](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/) | A Worker whose config adds a migration (or that does not exist yet) is only bundled in phase 1 and goes out with `wrangler deploy` at its turn in phase 2 |
| Rollback cannot go "to any version prior to the one that included" a class lifecycle change; rollback is blocked when a binding's resource no longer exists; "errors could occur" if data structures changed | [Rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/), [With Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/) | `release.mjs rollback` refuses when any Worker's migration tag in force differs from the recorded one |
| Only the 100 most recent versions can be deployed or rolled back to | [Rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/) | The rollback checks the version still exists and says so if it does not |
| The script list carries `migration_tag`, "the tag of the Durable Object migration that was most recently applied" | [API: list scripts](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/) | How the pipeline learns the migration in force |
| Version affinity (`Cloudflare-Workers-Version-Key`) only holds "while the deployment configuration stays the same" and needs a zone route for header rules | [Version affinity](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/) | Not used: no split deployments, nothing to stick to |
| Routes, custom domains, crons and queue consumers are not part of a version | wrangler 4.164.0 (`triggers deploy` updates routes, custom domains, workers.dev, crons and queue consumers) | After each `versions deploy`, `wrangler triggers deploy` with the same config. A rollback restores versions (code, bindings, vars), not triggers |
| A pending run in a concurrency group is replaced by a newer one ("at most one … pending") | [GitHub: control concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) | The newest commit is the one deployed after a running deploy |

Not documented, so measured in the trial below: what an ingest client and a query client see
while the write path's Durable Objects move to a new version under load, and whether any
acknowledged sample is lost across it.

Every release sets `VIZ_RELEASE=<sha>` in every Worker's vars, so every Worker gets a new
version and every Durable Object moves to it, even when a Worker's code did not change. This
keeps "which release is serving" a single answer (also shown by `/healthz`), and it means the
cutover the trial measures happens on every deploy.

## Durable Object migrations

Detection: for each Worker, the newest `migrations` tag in its generated config is compared
with the `migration_tag` Cloudflare reports for the deployed script. A difference is a
migration; a deployed tag missing from the config is an error (a config may not drop an
applied migration).

A release that applies a migration deploys only if it is acknowledged, by name and tag:

- a commit trailer `Migration: viz-ingest@v2` on any commit between the release serving now
  and the pushed commit (all of them are read, so a push whose own run was replaced still
  counts), or
- the `acknowledge_migrations` input of a manual run: `viz-ingest@v2 viz-query@v2`.

Otherwise `release.mjs` stops before uploading or promoting anything, lists each migration
and the exact trailer it needs, and the job fails with exit code 3. Names are always the
production names (`viz-ingest@v2`), also for a stage. Per `contracts/COMPATIBILITY.md` §7, a
release that changes a class's lifecycle should contain nothing else.

**The first production deploy is such a release**: viz-ingest, viz-control and viz-query go
from no migration to `v1`. Start it by hand: Actions → Deploy → Run workflow on `main`, with
`acknowledge_migrations` = `viz-ingest@v1 viz-control@v1 viz-query@v1` (or put the three
trailers on the merge commit).

## Release record

`generated/<target>/release.json` (also `release-<sha>.json`), and in CI the artifact
`release-<sha>` plus the job summary:

```json
{ "kind": "release", "release": "<git sha>", "target": "production", "previousRelease": "<sha>",
  "migrations": [{ "worker": "viz-ingest", "from": "v1", "to": "v2" }],
  "via": { "viz-ingest": "deploy", "viz-control": "versions", "...": "..." },
  "workers": [{ "name": "viz-ingest", "versionId": "…", "migrationTag": "v2", "release": "<sha>" }, "…"] }
```

`previous.json` is the same shape, captured from Cloudflare just before phase 1: what an
automatic rollback restores. Every version is also tagged with the release SHA on
Cloudflare (`workers/tag`), which is how a later deploy finds the release serving now.

## Rollback

**By hand**: Actions → Deploy → Run workflow, `rollback_to` = the full SHA of a commit whose
deploy run succeeded. The job downloads that run's release record and runs `release.mjs
rollback`: every Worker back to its recorded version id, callers first (viz-gateway,
viz-query, viz-control, viz-ingest), then the smoke test. Locally:
`node deploy/release.mjs rollback --record <release.json> [--stage S]`.

It refuses, changing nothing, when a recorded version no longer exists (Cloudflare keeps 100)
or when any Worker's Durable Object migration tag in force differs from the recorded one.
**Migrations are forward-only**: once a release has applied migration `v2` to a class,
Cloudflare will not run code from before it on that class's objects, and their storage may
already be in the new shape; no version from before the migration can serve again. A bad
release that applied a migration is repaired by a new commit (fix forward), never by a
rollback. `contracts/COMPATIBILITY.md` §6 extends this to schema versions inside SQLite and
to wire formats; this tool checks only the Cloudflare migration tag (see "Not implemented").

**Automatically**: when the smoke test fails after a deploy that applied no migration,
`deploy.sh` restores `previous.json`, checks health again, and fails the job. When the
release applied a migration it does not roll back; it fails with an error naming the
migrations and the instruction to fix forward.

**Redeploying an older commit** (instead of restoring its versions): run the workflow on
that commit. That builds new versions of old code and goes through the same migration gate,
which refuses if the old config lacks a migration that is now applied.

A rollback restores versions: code, bindings and vars. It does not restore routes, crons or
queue consumers (not versioned), nor data.

## When a deploy fails

| Where | What is left serving | What to do |
|---|---|---|
| Refused (exit 3): unacknowledged migration | the previous release, untouched | add the trailer or the dispatch input, if the migration is intended |
| Phase 1 (upload) | the previous release, untouched (uploaded versions serve nothing) | fix the build |
| Phase 2, before any migration was applied | Workers promoted so far are put back automatically | read the wrangler error in the log |
| Phase 2, after a migration was applied | a mix; nothing is rolled back | fix forward |
| Smoke test, no migration | the previous release, restored automatically | the job fails; read the smoke output |
| Smoke test, with migration | the new release | fix forward |

## Concurrency

The whole Deploy workflow is in concurrency group `deploy-production` with
`cancel-in-progress: false`: a running deploy is never cancelled. GitHub keeps at most one
run pending in a group and a newer one replaces it, so pushes that arrive during a deploy
collapse into one run of the newest commit, which then deploys with its own checks. A
manual rollback queued behind a running deploy can likewise be replaced by a later push; if
that happens, dispatch it again.

## One-time setup (the owner)

1. **Repository secrets** (Settings → Secrets and variables → Actions):
   `CLOUDFLARE_API_TOKEN` (Workers Scripts edit, Workers R2 Storage edit, Workers KV edit,
   Queues edit, and Workers custom domains on the bitcru.sh zone; no DNS permission is
   needed) and `CLOUDFLARE_ACCOUNT_ID`. The workflow uses the GitHub environment
   `production`, which GitHub creates on first use; add protection rules to it if a person
   should approve each deploy.
2. **First deploy**: run the Deploy workflow on `main` with `acknowledge_migrations` =
   `viz-ingest@v1 viz-control@v1 viz-query@v1` (see above). It creates `viz-lake`,
   `viz-config` and the four queues, deploys the four Workers and attaches `vis.bitcru.sh`.
   Without `SMOKE_KEY` the smoke test checks health only.
3. **First tenant**, from a machine with the two Cloudflare variables set and `npm ci` done
   in `deploy/`:
   ```
   node deploy/configure.mjs --ids-optional > /dev/null     # the manifest names the gateway
   node deploy/bootstrap.mjs --tenant <tenant-id>            # prints the admin key once
   ```
   To also make the smoke key: add `--smoke-key-file ./smoke.key` (a key named `smoke` with
   the `write` and `read` scopes, written with mode 0600, never printed).
4. **Optional `SMOKE_KEY`**: store that key as the repository secret `SMOKE_KEY` and delete
   the file. From then on every deploy writes and reads real samples (under
   `viz_smoke_samples{run=<uuid>}` of that tenant).

### Bootstrap, and why it holds no long-lived secret

`bootstrap.mjs` generates a 32-byte token on the operator's machine and sets the gateway
secret `VIZ_BOOTSTRAP` = `{tenant, tokenSha256, expiresAt: now + 10 min}` with `wrangler
secret put`, value on stdin. It calls `POST /api/v1/bootstrap` with the token as a bearer
credential; the gateway compares SHA-256 digests in constant time and calls
`Tenant.provision(tenant)` on viz-control's Tenant object, which refuses a tenant that
already has a key (409). The tenant is part of the secret, never of the request: a body or a
query string is refused (400), as control refuses a tenant in a request. The script then
deletes the secret (also when anything failed) and checks it is gone; with no secret the path
is the ordinary 404. The token never appears on a command line or in a log, and only its hash
is stored. A version created while the secret existed would carry it, but it expires after 10
minutes regardless.

## CI

`.github/workflows/ci.yml` runs on pull requests to `main`, pushes to `claude/**`, and is
called by the deploy. Jobs: `discover` (runs `deploy/ci/matrix.mjs` on the checkout),
`wasm` (both engines built once with `CARGO_BUILD_JOBS=2`, cached, uploaded as artifact
`wasm-engines`), `rust` (`cargo test -j 2` per crate: engine/storage, promql, query,
traceql, wasm, wasm-query), and `typescript` (per component: `npm ci`, `npx tsc --noEmit`,
`npm test`; the WASM artifact for flush, compact, janitor, stack, query, engine/wasm).
Components not in the checkout are skipped with a notice: on `main` today that is `app/`
and `design-system/` (and `app/` also needs `design-system/`). Two test files import from
directories that may be absent and are excluded, with a warning, when they are:
`query/test/http.test.ts` (imports `app/src/api/client.ts`) and `stack/test/e2e.test.ts`
(imports hyparquet from `bench/node_modules`, so `bench/` is `npm ci`'d for stack).
Actions are pinned to full commit SHAs (checkout v7.0.1, setup-node v7.1.0, cache v6.1.0,
upload-artifact v7.0.2, download-artifact v8.0.2; SHAs read from the tags through the Go
module proxy and cross-checked against GitHub's tag pages). Rust comes from the runner's
`rustup` (toolchain 1.97.0), so no third-party action is involved.

## How it was verified

All measured here unless it says Cloudflare.

- `cd deploy && npm test`: vitest in workerd, 3 files, 53 tests (gateway routing for every
  listed path and 11 that must 404; method, headers and a 3 MiB body byte-for-byte; a
  request body that is still being written; 12 status codes with status text, `Retry-After`,
  `WWW-Authenticate` and two `Set-Cookie`; a response whose first chunk arrives 600 ms before
  its second is delivered in under 450 ms; a throwing backend gives 502; health with a
  failing and a throwing backend; bootstrap against control's real `Tenant`: no secret,
  right token twice, six wrong tokens, expired, body and query string, GET, malformed
  secret, a second token for a provisioned tenant), then `node --test`, 20 tests (configure
  against the real component configs, the migration gate, acknowledgement parsing, the
  Remote Write body decoded by snappyjs and protobufjs, the CI matrix with and without
  `app/`, `design-system/` and `bench/`).
- `npx tsc --noEmit` in deploy/: clean (includes the stage shim against stack/'s types).
- `node gateway/scripts/mutants.mjs`: **11 of 11 mutants killed**:

  | Mutant | Killed by |
  |---|---|
  | bootstrap accepts any token | refuses a wrong, missing or malformed token |
  | bootstrap ignores the expiry | refuses after the window closes |
  | bootstrap accepts a body or query string | takes no tenant from the request |
  | bootstrap exists without the secret | does not exist while no secret is set |
  | no `x-viz-route` on forwarded answers | 27 routing and transparency tests |
  | the response body is buffered | streams the response |
  | status text dropped | 12 status tests |
  | `/api/v1/label` prefix too wide | `/api/v1/label` is a 404 |
  | control prefix matches `/api/v1/controls` | `/api/v1/controls` is a 404 |
  | healthy when any backend is | unhealthy when one fails |
  | a throwing backend crashes the gateway | retryable 502 |

- `wrangler deploy --dry-run` of all four generated production configs: bundles (viz-ingest
  2,642.54 KiB / 799.96 KiB gzip, viz-control 303.48 / 58.00, viz-query 2,625.71 / 824.97,
  viz-gateway 7.15 / 2.75).
- actionlint 1.7.12 (built from source through the Go module proxy) with shellcheck 0.11.0
  on both workflows: no findings. shellcheck on `deploy.sh`: clean.
- The workflows themselves have not run: this checkout has no GitHub remote access. What
  they call was run locally (the matrix script, every deploy step); the trial below ran
  `deploy.sh` itself.

@@TRIAL@@

## Needed changes in components

None of these were made here.

@@NEEDED@@

## Not deployed yet, and why

| Worker | Why not |
|---|---|
| viz-ruler | Its `EVALUATOR` and `SINK` service bindings do not exist yet, so every rule would report `health: err` (`ruler/README.md`, "Not implemented") |
| viz-publisher | Nothing triggers it: no queue consumer, no cron, no nudge from the ledger (`publisher/README.md`) |
| viz-mcp | Binds viz-ruler, which is not deployed; `mcp/wrangler.jsonc` says it was never deployed, and mcp has no README yet |

`configure.mjs` still generates their configs on every run (so a binding they need that the
deployment lacks is caught early), and `workers.json` records the reasons. Deploying one
later is `"deploy": true` plus its place in the order; viz-ruler and viz-mcp would also need
their migrations acknowledged. The UI (`app/`, `design-system/`) is not part of this
deployment and nothing here needs it: the gateway has no page and no static assets.

## Not implemented

- **Schema versions in the rollback check.** `contracts/COMPATIBILITY.md` §6 asks the release
  tool to record each Durable Object class's `schemaRelease` (`contracts/schema.ts`) and to
  refuse a rollback across a forward-only release (the rollback floor). The record has the
  Cloudflare migration tag only; the components do not yet expose their `SchemaSpec` in a
  form the deploy can read without importing their TypeScript (see "Needed changes").
- **Gradual (percentage) rollouts.** Every promotion is 100%. Splitting would put two
  versions of the write path's objects in service at once; the tooling refuses nothing about
  it but never does it.
- **Alerting** on a failed deploy beyond the failed job and its summary.
- **The workflows have not run on GitHub** (see above).

## Known risks

- **A deploy is not atomic across Workers.** Between viz-ingest's promotion and
  viz-gateway's, callers run the previous release against new callees (a minute or so in the
  trial). That is the documented skew; it is safe only while every component keeps the
  one-release compatibility of `contracts/COMPATIBILITY.md`.
- **Old Durable Object code keeps serving up to 30 s after promotion** (deferred mode), and
  a rollback is itself a new deployment that moves every object again.
- **Rollback is only as good as the record.** Artifacts expire after 90 days and Cloudflare
  keeps 100 versions; after that, go back by deploying an old commit.
- **The trial ran from a snapshot of a working tree that others were editing**, with the WASM
  built from that snapshot; CI builds and deploys one commit, which cannot have that problem
  (see the trial, release N0).
