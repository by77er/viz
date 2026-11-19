# Deploy

How viz gets from a commit on `main` to `vis.bitcru.sh`, and back again. This directory holds
the deploy tooling, the public gateway Worker, and the record of the trial on Cloudflare. It
changes no component: everything it needs from one is under "Needed changes".

| File | What it does |
|---|---|
| `workers.json` | Which Workers exist, in dependency order (callees first), which are deployed, and why the others are not. Deployment-wide settings: domain, observability sampling, Durable Object code-update mode, resource names, shared vars |
| `configure.mjs` | Generates each Worker's production (or staged) wrangler config into `generated/` from the component's own `wrangler.jsonc` |
| `resources.mjs` | Creates the R2 bucket, KV namespace and queues (idempotent); `destroy --stage` deletes a stage |
| `release.mjs` | Upload every Worker, then promote callees first; the migration gate; release records (with schema versions and whether the release is forward-only); rollback, refused across a forward-only release; `plan` |
| `lib/secrets.mjs` | Worker secrets the deploy generates (viz-control's `OAUTH_CLIENT_KEY`): put on the release's upload only where missing, value on wrangler's stdin, replaced only when asked ("Worker secrets the deploy generates") |
| `lib/schemas.mjs` | Reads every Durable Object class's `SchemaSpec` from the component sources (esbuild, no Worker run) for the manifest, the `VIZ_SCHEMAS` var of each version, and the rollback check |
| `deploy.sh` | The whole deploy: WASM, `npm ci`, resources, configure, release, smoke test, automatic rollback |
| `smoke.mjs` | `/healthz` until the release just promoted answers, then a real Remote Write and a query that must return it within 60 s |
| `bootstrap.mjs` | A tenant's first API key, through a one-time token |
| `load.mjs` | Steady write and read load with a cutover report (used by the trial) |
| `gateway/` | `viz-gateway`, the Worker on `vis.bitcru.sh`, and its tests |
| `stage/` | The one shim a staged deployment needs (queue names, see "Needed changes" 1) |
| `trial/` | Trial 2: `sink/index.ts`, a webhook receiver Worker for a stage, and `trial2.mjs`, which drives a stage end to end (monitors, alerting, MCP) and reports. Trial 3: `probe/index.ts`, a stand-in for the ruler's `SINK` binding |
| `ci/matrix.mjs` | Which components CI checks in this checkout |
| `scripts/mutants-release.mjs` | Mutation check of the schema rules in `release.mjs`, `configure.mjs`, `lib/schemas.mjs` (run on a copy) |
| `scripts/mutants-secrets.mjs` | Mutation check of the generated secrets (`lib/secrets.mjs`, its use in `release.mjs`, stdin in `lib/wrangler.mjs`; run on a copy) |
| `test/fake-wrangler.mjs` | A stand-in for wrangler that `test/secrets.test.mjs` runs as a real child process (`VIZ_WRANGLER_BIN`, tests only) |
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
                 npm ci (deploy/, stack/, control/, query/, ruler/, mcp/)
                 resources.mjs ensure       R2 viz-lake, KV viz-config, queues viz-flush, viz-maint,
                                            viz-flush-dlq, viz-maint-dlq
                 configure.mjs              generated/production/*.jsonc + manifest.json
                 release.mjs deploy         plan → refuse unacknowledged migrations (exit 3)
                                            phase 1: upload every Worker (serves nothing); viz-control's
                                                     OAUTH_CLIENT_KEY put on its upload if missing
                                            phase 2: promote viz-publisher, viz-ingest, viz-control,
                                                     viz-query, viz-ruler, viz-mcp, viz-gateway
                 smoke.mjs                  /healthz until the new release answers; Remote Write +
                                            query with SMOKE_KEY
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
     ┌───────────────┬─────────────┼──────────────┬─────────────────┬──────────────┬──────────────────────┐
  INGEST           QUERY         CONTROL          RULER             MCP          TENANT (DO, by script_name)
     │               │             │                │                 │          only for /api/v1/bootstrap
 viz-ingest      viz-query    viz-control       viz-ruler          viz-mcp
 edge, Shard,    Leaf DOs;    Tenant DO         Ruler, Notifier,   stateless; QUERY, CONTROL,
 Ledger, Flush,  SHARD and    (keys,            RulerIndex DOs;    RULER service bindings,
 4 consumers,    LEDGER from  dashboards,       QUERY, SINK and    each call with the caller's
 hourly cron,    viz-ingest   settings)         INGEST service     own key
 RecordedSamples                                bindings; TENANT (control's
 entrypoint                                     Tenant) by script_name;
     │ PUBLISHER (DO, by script_name): nudged by    cron */15
     │ maintenance runs, asked before deletion
 viz-publisher: Publisher DO, one per cell (Iceberg metadata in viz-lake); no route, no cron
     └──── R2 viz-lake, KV viz-config (ingest, query, control, ruler and mcp read it), queues ────┘
```

| Path | Goes to | Notes |
|---|---|---|
| `POST /api/v1/write` | viz-ingest | Remote Write 1.0 |
| `POST /v1/metrics` | viz-ingest | OTLP/HTTP metrics |
| `POST /api/v1/push` | viz-ingest | routed as asked; edge does not serve it yet (404 from edge) |
| `/api/v1/query`, `/query_range`, `/labels`, `/series`, `/metadata`, `/api/v1/label/*`, `/api/v1/status/*` | viz-query | |
| `/api/v1/control`, `/api/v1/control/*` | viz-control | |
| `GET /api/v1/rules`, `GET /api/v1/alerts`, `/api/v1/monitors`, `/api/v1/monitors/*` | viz-ruler | Prometheus' rule and alert reads, and the monitors API (monitors, groups, rule files, backtest, detectors, notifier config, silences): `ruler/src/http.ts` `ROUTES`. `/api/v2/alerts` (Alertmanager ingestion) is not served |
| `/mcp` (exactly), `/api/v1/agent`, `/api/v1/agent/*` | viz-mcp | MCP over Streamable HTTP, and the same tools as JSON. `/mcp/` and `/mcp/x` are 404 at the gateway |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` (exactly) | viz-mcp | OAuth protected resource metadata of `/mcp` (RFC 9728, D44) |
| `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` (exactly) | viz-control | The OAuth authorization server for MCP clients (D44; methods in `control/README.md`). `/oauth/register` answers 503 and is not advertised while viz-control has no `OAUTH_CLIENT_KEY`, which the deploy generates ("Worker secrets the deploy generates") |
| `GET /healthz` | the gateway | asks each backend's own `GET /healthz` through its service binding (ingest, query, control, ruler, mcp; none is public, since the gateway answers `/healthz` itself); 200 `healthy` or 503 naming the backend. The ruler's and mcp's say 503 when a binding they need is missing |
| `POST /api/v1/bootstrap` | the gateway | exists only while the one-time secret is set ("Bootstrap") |
| anything else | the gateway | 404, JSON listing the entry points. No web UI and no page: the UI comes later, through design review |

The gateway is transparent: the incoming `Request` is handed to the backend as it arrived
(method, URL with query string, headers, body stream) and the backend's `Response` comes back
with its status, status text and every header, body streamed, plus `x-viz-route:
ingest|query|control|ruler|mcp|health|bootstrap|gateway`. A backend that throws becomes a retryable
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

The two Workers added later are different. **viz-ruler** is called through the gateway only
for its API (one or a few Durable Object calls per request), but its rule ticks run in `Ruler`
Durable Objects, each with its own six, and call viz-query through a service binding, which
then spends from the Ruler object's six; one query can itself open several connections (the
ledger, then shards and leaves in parallel). So the ruler lets **one engine call per Ruler
object be in flight at a time** (`ruler/src/engine.ts`, decision D39), and its webhooks go out
from the `Notifier`, another object. **viz-mcp** behind the gateway shares the gateway
request's six with everything it calls: `read_dashboard` runs up to six queries at once
(`MCP_LIMITS.maxParallel`), and their own fan-out then queues inside the platform rather than
failing (the measured behaviour of spike S1 is waiting, not errors). Not measured for mcp; see
"Known risks".

## Releases: upload, then promote

What Cloudflare documents, and what the pipeline does about it. Read on 2026-11-18.

| Platform fact | Source | What the pipeline does |
|---|---|---|
| A version is code + bindings + compatibility settings; a deployment says which version(s) serve. `wrangler deploy` creates a version and deploys it at 100%; the two steps can be decoupled. Storage state (KV, R2, Durable Objects) is not versioned | [Versions & deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/) | Phase 1 `wrangler versions upload --tag <sha>` for every Worker; nothing serves it. Phase 2 `wrangler versions deploy <id>@100%` in order |
| Two Workers joined by a service binding "may be at different points in their own gradual deployment"; overrides do not work for RPC | [Gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/), [Version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/) | Promote callees before callers (viz-ingest, viz-control, viz-query, viz-gateway) so a caller never runs ahead of what it calls; roll back in the reverse order. Both directions of skew still happen while a deployment propagates, so every RPC and format must work across one release (`contracts/COMPATIBILITY.md` §1, §3) |
| Each Durable Object is assigned one version per deployment, "will not change until you create a new deployment", and "will only be reset when it is assigned a different version" | [Gradual deployments with Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/) | Deploy at 100%, never a percentage split: every object moves once per release |
| An active object adopts new code when it hibernates or when `max_delay` expires (default `deferred`, 300 s); `immediate` resets it at once; the reset affects in-memory state only and callers see "Durable Object reset because its code was updated." | [Durable Objects code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/), [Troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/) | `--durable-objects-code-update-mode "deferred 30s"` (workers.json): in-flight requests get up to 30 s, and the old code stops serving within about half a minute instead of five minutes. What a caller sees at that reset is not documented beyond the message, so it was measured: objects moved 29.7 to 29.9 s after their Worker, and at 20 requests a second no caller saw an error (trial) |
| Versions that change a Durable Object class's lifecycle (the `migrations` array or `exports`) "cannot be uploaded"; apply them with `wrangler deploy`; migrations "are atomic operations and cannot be gradually deployed" | [With Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/#durable-object-class-lifecycle-changes), [Migrations (legacy)](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/) | A Worker whose config adds a migration (or that does not exist yet) is only bundled in phase 1 and goes out with `wrangler deploy` at its turn in phase 2 |
| Rollback cannot go "to any version prior to the one that included" a class lifecycle change; rollback is blocked when a binding's resource no longer exists; "errors could occur" if data structures changed | [Rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/), [With Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/) | `release.mjs rollback` refuses when any Worker's migration tag in force differs from the recorded one |
| Only the 100 most recent versions can be deployed or rolled back to | [Rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/) | The rollback checks the version still exists and says so if it does not |
| The script list carries `migration_tag`, "the tag of the Durable Object migration that was most recently applied" | [API: list scripts](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/) | How the pipeline learns the migration in force |
| Version affinity (`Cloudflare-Workers-Version-Key`) only holds "while the deployment configuration stays the same" and needs a zone route for header rules | [Version affinity](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/) | Not used: no split deployments, nothing to stick to |
| Routes, custom domains, crons and queue consumers are not part of a version | wrangler 4.164.0: `versions upload` prints "Changes to triggers (routes, custom domains, cron schedules, etc) must be applied with the command wrangler triggers deploy"; its source shows `triggers deploy` also updates workers.dev and queue consumers. Wrangler calls `triggers deploy` "an experimental command" | After each `versions deploy`, `wrangler triggers deploy` with the same config. A rollback restores versions (code, bindings, vars), not triggers |
| A pending run in a concurrency group is replaced by a newer one ("at most one … pending") | [GitHub: control concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) | The newest commit is the one deployed after a running deploy |

Not documented, so measured in the trial below: what an ingest client and a query client see
while the write path's Durable Objects move to a new version under load, and whether any
acknowledged sample is lost across it.

Every release sets `VIZ_RELEASE=<sha>` in every Worker's vars, so every Worker gets a new
version and every Durable Object moves to it, even when a Worker's code did not change. This
keeps "which release is serving" a single answer (also shown by `/healthz`), and it means the
cutover the trial measures happens on every deploy.

## Worker secrets the deploy generates

One today: **`OAUTH_CLIENT_KEY` on viz-control**, the HMAC-SHA-256 key that signs the OAuth client
registrations of MCP clients (`control/src/oauth.ts`, D44). Without it (or with fewer than 32
characters) `/oauth/register` answers 503 and is not advertised. Replacing it invalidates every
registered client: they register again; grants and tokens are unaffected. Decision D53.

What Cloudflare and wrangler do, read 2026-11-19 (wrangler is read in the pinned 4.164.0, whose
licence is MIT OR Apache-2.0):

| Fact | Source | What the deploy does |
|---|---|---|
| "`wrangler secret put` creates a new version of the Worker and deploys it immediately." "If using gradual deployments, instead use the `wrangler versions secret put` command": it "will only create a new version of the Worker, that can then be deployed using `wrangler versions deploy`" | [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/); [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/) ("This action creates a new version of the Worker and deploys it immediately") | `versions secret put`, never `secret put`: nothing is deployed outside phase 2 |
| `versions secret put` patches the **newest** version (`PATCH …/versions/latest` with the secret in `env`), tags it with `--tag` and `--message`, reads the value from stdin when stdin is not a terminal, and fails (10222) on a Worker with no version | wrangler source, `src/versions/secrets/put.ts` and `index.ts` | Runs right after viz-control's upload, once the newest version is checked to be that upload; the new version must then list the secret and carry this release's `VIZ_RELEASE`; it is tagged with the release |
| `secret put` is refused (10214, 10215) while the newest version is not the deployed one, "to prevent accidental deployment when using Worker versions and secrets together"; on a Worker that does not exist it creates one whose code is `export default { fetch() {} }`, answering yes by itself in CI | wrangler source, `src/secret/index.ts` | Not used here. (`bootstrap.mjs` uses it on the gateway, which exists by then) |
| "secrets are never deleted by deployments"; wrangler uploads with `keep_bindings: ["secret_text", "secret_key"]`, which the API calls "binding types to keep from previous_upload"; an `inherit` binding's version "Defaults to "latest"" | [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/); [API: upload a version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/); wrangler source | Once made, the key rides along on every later version and the deploy only checks it is there. That uploads inherit from the newest version is read into "previous_upload", not stated, and not measured ("Known risks") |
| The API lists "the names of secrets bound to a Worker script" (from which version is not said); a version's `resources.bindings` list secrets by name and type | [API: list secrets](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/list/); the version API (read back on Cloudflare in Trial 3 for `VIZ_SCHEMAS`) | Presence is judged by name only: on the version to be promoted, and, for the refusal below, in the secret list and the serving versions |
| The rollback documentation says nothing about secrets. wrangler's `rollback` handles an API error 10220 ("The following secrets have changed") by asking and retrying with `force`; `versions deploy`, which `release.mjs` rolls back with, does not | [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/); wrangler source, `src/versions/rollback/index.ts` | Nothing special. Whether a rollback to a version without the key is refused is not known ("Known risks") |

**The step.** `versions secret put` on the version this release just made, only when that version
does not carry the key:

- **viz-control uploaded in phase 1** (every release once it exists): after its `versions
  upload`, the key goes on that upload, and phase 2 promotes the keyed version in viz-control's
  turn instead of the upload. Nothing serves early, nothing but this release's code is promoted,
  a failure stops the release before phase 2 with the previous release untouched, and
  `previous.json`, the release record and any rollback name versions exactly as they served.
- **viz-control deployed with `wrangler deploy` in phase 2** (new, as on the **first production
  deploy**, or applying a Durable Object migration): there is no version to put it on before, so
  it goes on the version just deployed, and the keyed version is deployed (`versions deploy`, the
  same code-update mode) before the next Worker. On the first deploy that is before the gateway
  exists, so no request reaches viz-control without the key; a failure there stops the release
  before the gateway.

**Never over one that exists.** If viz-control has the key now (its secret list, or a version
serving now) but the version to be promoted does not carry it, the release is **refused, exit 3,
before anything is promoted**, naming where it was seen: a new value would invalidate every
registered client. A put is also refused when the newest version is not this release's upload
(it would build on code that is not this release).

Why not the alternatives (D53): `wrangler secret put` before phase 1 deploys the serving code plus
the key outside any release record, is refused whenever an undeployed version is newest, and
creates a placeholder Worker on the first deploy; after phase 2 it is a second deployment (the
Tenant objects move twice, and the new release serves for a while without the key);
`--secrets-file` needs the value in a file; by hand, it is forgotten and the symptom is a quiet
503. **Would change if** a stage shows uploads not inheriting the key, or a rollback refused with
10220; control verifies under two keys (then rotation can overlap and be automatic); or wrangler
takes secrets on stdin for `versions upload` (then code and key in one version).

**Plan.** `release.mjs plan`, and the plan `deploy` prints first, have one line per generated
secret: `secret OAUTH_CLIENT_KEY on viz-control: not set; would be created on the version uploaded
in phase 1, before anything is promoted (32 random bytes, handed to wrangler on stdin)`, or `set
(…); kept`, or `REPLACED as asked`. The plan creates nothing: it runs no wrangler command and only
reads the API. Its JSON line carries `secrets: [{worker, name, action}]`.

**Rotation, by hand only.** No deploy replaces the key by itself. To replace it on purpose (it
leaked, say), name it in a deploy, from a clean checkout of the commit to deploy (normally
`main`), with the two Cloudflare variables set:

```
VIZ_ROTATE_SECRETS=OAUTH_CLIENT_KEY deploy/deploy.sh
node deploy/release.mjs deploy --rotate-secret OAUTH_CLIENT_KEY      # the same, after configure.mjs
node deploy/release.mjs plan --rotate-secret OAUTH_CLIENT_KEY        # what it would do; changes nothing
```

The new key goes on that release's upload exactly as a first one would, the record says
`rotated`, and every registered client must register again. A failed smoke test rolls back as for
any release, to versions that carry the old key (so the old registrations work again; see "Known
risks" for whether Cloudflare allows that rollback). A name the deploy does not generate is
refused, exit 3, before anything is uploaded. The workflow has no input for this yet ("Needed
changes").

**Never shown.** The value exists in the deploy process's memory and in the pipe to wrangler's
stdin. It is not on a command line, in an environment variable, in a log (wrangler's output for
the put is not relayed, and is scrubbed before it can appear in an error), in a file, or in the
release record, which says `secrets: [{ worker, name, action, versionId }]`.

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

**The first production deploy is such a release**: viz-publisher, viz-ingest, viz-control and
viz-query go from no migration to `v1`, and viz-ruler from none to `v2` (its config has two
steps, `v1` `Ruler` and `Notifier`, `v2` `RulerIndex`; the gate compares the newest tag, and
`wrangler deploy` applies both). viz-ingest only *binds* the publisher's class (by
`script_name`), which is no migration of its own. viz-mcp and viz-gateway have no Durable Object
class. Start it by hand: Actions → Deploy → Run workflow on `main`, with
`acknowledge_migrations` = **`viz-publisher@v1 viz-ingest@v1 viz-control@v1 viz-query@v1
viz-ruler@v2`** (or put the five trailers on the merge commit). Measured in Trial 3: without them
the release is refused, exit 3, before anything is uploaded, and the refusal lists exactly
these five (Trial 2 measured the four before viz-publisher was deployed).

## Release record

`generated/<target>/release.json` (also `release-<sha>.json`), and in CI the artifact
`release-<sha>` plus the job summary:

```json
{ "kind": "release", "release": "<git sha>", "target": "production", "previousRelease": "<sha>",
  "migrations": [{ "worker": "viz-ingest", "from": "v1", "to": "v2" }],
  "schemas": { "ledger.Ledger": { "worker": "viz-ingest", "latest": 3, "compat": 2, "by": "2: the change log in segments …" }, "…": "…" },
  "forwardOnly": true,
  "forwardOnlyBecause": [{ "worker": "viz-ingest", "kind": "schema", "component": "ledger.Ledger", "previousKnows": 1,
    "latest": 3, "compat": 2, "migrations": [{ "version": 2, "readableFrom": 2, "name": "…" }, "…"], "why": "…" }],
  "via": { "viz-ingest": "deploy", "viz-control": "versions", "...": "..." },
  "secrets": [{ "worker": "viz-control", "name": "OAUTH_CLIENT_KEY", "action": "kept", "versionId": "…" }],
  "workers": [{ "name": "viz-ingest", "versionId": "…", "migrationTag": "v2", "release": "<sha>" }, "…"] }
```

**Schema versions and forward-only releases** (contracts/COMPATIBILITY.md §6; design/DECISIONS.md
D46; added 2026-11-19). `deploy/workers.json` declares, for every Durable Object class a Worker defines,
its `SchemaSpec` (`"schemas": {"Ledger": "ledger/src/ledger.ts#LEDGER_SCHEMA"}`) or why it keeps
no storage (`"unversioned"`: query's `Leaf`); `configure.mjs` refuses a class declared neither
way, and a test checks that each declared spec is the one its class opens storage with.
`lib/schemas.mjs` reads the specs from the sources (esbuild bundles just them, tree-shaken, and
a Node `vm` evaluates the bundle with the platform modules stubbed; contracts/schema.ts's own
`schemaRelease` and `checkSpec` run on them). Each class's `{latest, compat}` goes into the
manifest, the release record, and **every version's `VIZ_SCHEMAS` var**, so Cloudflare itself
keeps what each version knows for as long as it keeps the version.

- **Forward-only.** At deploy, for each class: `compat` (its highest `readableFrom`) above the
  `latest` that the version serving now declares is forward-only, and the record lists each
  such migration and why. A serving version that declares nothing (from before this) is taken
  to know version 1 (COMPATIBILITY.md §6, Bootstrapping). A Durable Object migration tag change
  on an existing Worker is listed too (`kind: lifecycle`). The ledger's migration 2 (the segment
  log, `readableFrom` 2) makes the first release that carries it forward-only for any
  deployment that ran an older ledger. `deploy.sh` does not roll a forward-only release back
  automatically; it fails and says to fix forward.
- **Rollback refusal.** `release.mjs rollback` (and `rollback_to` in the workflow) lists, for
  each Worker with versioned classes in the target record, every version Cloudflare keeps that
  is newer than the target's, reads each one's `VIZ_SCHEMAS`, and refuses, changing nothing,
  when any of them ran a class at `{latest, compat}` that the target cannot open (`canOpen`,
  contracts/schema.ts). The message names the component, the release and version that ran it,
  and the migration that raised `compat`. Judging every version since the target, not only the
  one serving now, is what COMPATIBILITY.md asks ("the newest release that ever ran since T"):
  A → B (additive) → C (`readableFrom` 2) → back to B → back to A is refused at the second step
  although B, serving then, is additive. A target record without schema versions, or a newer
  version that declares none, is refused too (never guessed).

`previous.json` is the same shape, captured from Cloudflare just before phase 1: what an
automatic rollback restores. Every version is also tagged with the release SHA on
Cloudflare (`workers/tag`), which is how a later deploy finds the release serving now.

## Rollback

**By hand**: Actions → Deploy → Run workflow, `rollback_to` = the full SHA of a commit whose
deploy run succeeded. The job downloads that run's release record and runs `release.mjs
rollback`: every Worker back to its recorded version id, callers first (viz-gateway,
viz-query, viz-control, viz-ingest), then the smoke test. Locally:
`node deploy/release.mjs rollback --record <release.json> [--stage S]`.

It refuses, changing nothing, when a recorded version no longer exists (Cloudflare keeps 100),
when any Worker's Durable Object migration tag in force differs from the recorded one, or when
storage a newer version wrote cannot be opened by the target (schema versions, above).
Cloudflare refuses the same thing itself (measured in the trial: `versions deploy` of a
pre-migration version answers code 10210, "the version depends on Durable Object migration
"v1", but the current deployment is using migration "v2""); the tool's check says why before
anything is attempted, and also covers Workers rolled back as a set.
**Migrations are forward-only**: once a release has applied migration `v2` to a class,
Cloudflare will not run code from before it on that class's objects, and their storage may
already be in the new shape; no version from before the migration can serve again. A bad
release that applied a migration is repaired by a new commit (fix forward), never by a
rollback. `contracts/COMPATIBILITY.md` §6 extends this to schema versions inside SQLite, which
this tool checks too (above), and to wire formats, which it does not (see "Not implemented").

**Automatically**: when the smoke test fails after a deploy that applied no migration and is
not forward-only, `deploy.sh` restores `previous.json`, checks health again, and fails the job.
When the release applied a migration, or is forward-only for a schema, it does not roll back; it
fails with an error naming the migrations or classes and the instruction to fix forward.

**Redeploying an older commit** (instead of restoring its versions): run the workflow on
that commit. That builds new versions of old code and goes through the same migration gate,
which refuses if the old config lacks a migration that is now applied.

A rollback restores versions: code, bindings and vars, and the secrets each version carries (a
version from before viz-control's generated key has none: "Known risks"). It does not restore
routes, crons or queue consumers (not versioned), nor data.

## When a deploy fails

| Where | What is left serving | What to do |
|---|---|---|
| Refused (exit 3): unacknowledged migration | the previous release, untouched | add the trailer or the dispatch input, if the migration is intended |
| Phase 1 (upload) | the previous release, untouched (uploaded versions serve nothing) | fix the build |
| Phase 1, generated secret: refused (exit 3: set now but missing from the upload, or the newest version is not this release's) or the put failed (exit 1) | the previous release, untouched | read the reason; never rotate to make it pass unless replacing the key is intended ("Worker secrets the deploy generates") |
| Phase 2, a new viz-control's key could not be put | viz-control without the key (`/oauth/register` 503); nothing after it was promoted | deploy again: the next release puts the key on its upload |
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
   `viz-publisher@v1 viz-ingest@v1 viz-control@v1 viz-query@v1 viz-ruler@v2` (see above). It
   creates `viz-lake`, `viz-config` and the four queues, deploys the seven Workers and attaches
   `vis.bitcru.sh`. It also generates viz-control's `OAUTH_CLIENT_KEY` right after viz-control's
   first `wrangler deploy` ("Worker secrets the deploy generates"); nothing to set by hand.
   Without `SMOKE_KEY` the smoke test checks health only.
3. **First tenant**, from a machine with the two Cloudflare variables set and `npm ci` done
   in `deploy/`:
   ```
   node deploy/configure.mjs --ids-optional > /dev/null     # the manifest names the gateway
   node deploy/bootstrap.mjs --tenant <tenant-id>            # prints the admin key once
   ```
   The first key has the `admin` scope only: it manages the tenant through
   `/api/v1/control/…` but cannot send or read data (edge and query require the `write` and
   `read` scopes literally). To also make a data key: add `--smoke-key-file ./smoke.key` (a
   key named `smoke` with the `write` and `read` scopes, written with mode 0600, never
   printed); other keys are made with `POST /api/v1/control/keys`.
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
query string is refused (400), as control refuses a tenant in a request. If that object's
storage belongs to a newer release (a rollback across a forward-only control release,
`contracts/COMPATIBILITY.md` §2.4), `provision` refuses with `schema_too_new` and the route
answers a retryable 503 with `Retry-After: 30`, having created nothing. The script then
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
and `design-system/` (and `app/` also needs `design-system/`). One test file imports from a
directory that may be absent and is excluded, with a warning, when it is:
`stack/test/e2e.test.ts` (imports hyparquet from `bench/node_modules`, so `bench/` is
`npm ci`'d for stack). Each exclusion names the import that justifies it, and
`test/matrix.test.mjs` fails once the file no longer contains it (commit 587f3df, which
also dropped the exclusion of `query/test/http.test.ts`: it no longer imports `app/`).
Actions are pinned to full commit SHAs (checkout v7.0.1, setup-node v7.1.0, cache v6.1.0,
upload-artifact v7.0.2, download-artifact v8.0.2; SHAs read from the tags through the Go
module proxy and cross-checked against GitHub's tag pages). Rust comes from the runner's
`rustup` (toolchain 1.97.0), so no third-party action is involved.

## How it was verified

All measured here unless it says Cloudflare.

- **Generated secrets (viz-control's `OAUTH_CLIENT_KEY`, 2026-11-19).** Not run on Cloudflare:
  nothing was deployed for this change. `node --test test/secrets.test.mjs`: **9 of 9**, through
  the real `release.mjs` `deploy` and `plan`, with `lib/wrangler.mjs` spawning a fake wrangler as
  a real child process (`test/fake-wrangler.mjs`: it records every argv, the bytes it got on stdin
  and whether any environment variable held them) and the Cloudflare API answered by a stubbed
  `fetch` from the same state (any other request: 400; the token is a dummy). The tests: the
  value is 43 base64url characters from 32 CSPRNG bytes, never twice the same; **absent**: one
  `versions secret put` on the version phase 1 uploaded, value on stdin, before anything is
  promoted, and the keyed version (this release's `VIZ_RELEASE` and tag) is what serves and what
  the record names; **present**: no put, and the new version inherits the same value; **a failed
  put** stops the release with nothing promoted, and what the fake echoed back (the value) is in
  neither the log nor the error; **set now but missing from the upload**: exit 3, nothing put or
  promoted; **the newest version is not this release's**: exit 3, nothing put or promoted;
  **rotation** only when named (a new value; an unknown name refused, exit 3, with no wrangler
  call at all); **a first deploy**: `wrangler deploy` of viz-control, then the put, then
  `versions deploy` of the keyed version, then the gateway; **plan**: "would be created" or
  "kept", and no wrangler call. In every run that made or kept a value, it is checked to be in no
  argv, no wrangler environment, no log line, no file under `generated/`, and not in this
  process's environment. The whole suite afterwards (with the other engineers' changes of the
  day): `npx vitest run --maxWorkers=2` **95 of 95**; `node --test --test-concurrency=2
  'test/*.test.mjs'` **45 of 46**: the one failure is `configure.test.mjs` "stack/wrangler.test.jsonc
  differs … only by the publisher binding and the test main", which also failed before this change
  (stack's config gained `LEDGER_STATE_MAX_BYTES` that its test config lacks: stack/'s business, in
  progress). `npx tsc --noEmit` clean. `bash -n deploy.sh` clean; shellcheck is not installed here
  now, so `deploy.sh`'s new lines were not linted.
- `node scripts/mutants-secrets.mjs` in a copy of `deploy/` in a scratch directory (node_modules
  linked), after the copy's suite passed unmutated: **17 of 17 killed**, first run. The copy's
  sources were equal to the shared tree's afterwards, and the copy was deleted.

  | Mutant | Killed by (tests failing) |
  |---|---|
  | always regenerate: a key that is set is replaced | present: left alone; set now but missing from the upload (2) |
  | skip when absent: a missing key is never created | absent; a failed put; the newest version is not this release's; a first deploy (4) |
  | the value on the command line | absent; a failed put; rotation; a first deploy (4) |
  | the value in wrangler's environment | the same four |
  | the value in the log | the same four |
  | wrangler's output not scrubbed when the put fails | a failed put (1) |
  | a failed put ignored, the upload promoted anyway | a failed put (1) |
  | fail-closed dropped: a key set now but missing from the upload is replaced | set now but missing from the upload (1) |
  | the newest-version check dropped | the newest version is not this release's (1) |
  | a constant value instead of the CSPRNG | the generated value (1) |
  | a short value (8 random bytes) | the generated value; absent; a failed put; rotation; a first deploy (5) |
  | plan: a missing key reported as kept | plan (1) |
  | phase 1: the upload promoted instead of the keyed version | absent; rotation (2) |
  | phase 2: a new viz-control keeps serving the version without the key | a first deploy (1) |
  | plan mode puts the secret | plan (1) |
  | an unknown name to rotate is ignored | rotation (1) |
  | `lib/wrangler.mjs`: the value not written to stdin | absent; a failed put; rotation; a first deploy (4) |

  `scripts/mutants-release.mjs` was not re-run: its patterns are in code this change did not
  touch, and it refuses to start while `configure.test.mjs` has the failure above.
- `cd deploy && npm test`: vitest in workerd, 3 files, 55 tests (gateway routing for every
  listed path and 11 that must 404; method, headers and a 3 MiB body byte-for-byte; a
  request body that is still being written; 12 status codes with status text, `Retry-After`,
  `WWW-Authenticate` and two `Set-Cookie`; a response whose first chunk arrives 600 ms before
  its second is delivered in under 450 ms; a throwing backend gives 502; health with a
  failing and a throwing backend; control's health is its own `/healthz`, the one path asked,
  run by control's real Worker code on the test bindings, and unhealthy (503) when that code
  lacks its `TENANT` binding; bootstrap against control's real `Tenant`: no secret,
  right token twice, six wrong tokens, expired, body and query string, GET, malformed
  secret, a second token for a provisioned tenant, and storage a newer release holds (a
  `viz_schema` row at version 99: 503 with `Retry-After`, no key, storage unchanged)), then
  `node --test`, 22 tests (configure
  against the real component configs, the migration gate, acknowledgement parsing, the
  Remote Write body decoded by snappyjs and protobufjs, the CI matrix with and without
  `app/`, `design-system/` and `bench/`, and the health path `workers.json` records for each
  backend equal to the one the gateway asks, read from `gateway/src/index.ts`; that test
  fails against the `workers.json` that still named control's OpenAPI document).
  Re-run 2026-11-19: 55 and 22 pass (one matrix test added since by 587f3df); `npx tsc
  --noEmit` clean.
  **With viz-ruler and viz-mcp (2026-11-19): 77 and 25 pass** (`npx vitest run
  --maxWorkers=2`, then `node --test`). The 25 include the ruler's own Remote Write encoder
  (`ruler/src/remote.ts`, loaded in Node) read back by snappyjs and protobufjs: labels sorted,
  `3.5`, `+Inf` and `NaN` values, millisecond timestamps. Added: routing of `/api/v1/rules`, `/api/v1/alerts`,
  `/api/v1/monitors` and five paths below it to the ruler, `/mcp`, `/api/v1/agent` and two paths
  below it to mcp (11 more routed paths), 11 near misses that must 404 (`/api/v1/monitorsx`,
  `/api/v1/monitor`, `/api/v1/rules/x`, `/api/v1/alerts/x`, `/api/v1/rulesx`, `/mcpx`, `/mcp/`,
  `/mcp/x`, `/api/v1/agents`, `/api/v1/agentx`, `/api/v2/alerts`); health over five backends,
  unhealthy naming the ruler or mcp when either fails or throws; the order and stage names of
  the six deployed Workers; every service a deployed Worker binds is deployed before it and in
  the same stage (the ruler's `TENANT`, `QUERY`, `INGEST`; mcp's `QUERY`, `CONTROL`, `RULER`;
  the gateway's `RULER`, `MCP`); `--expires` sets `VIZ_STAGE_EXPIRES_AT` in every staged Worker
  and is refused for production and for a non-ISO time. `npx tsc --noEmit` clean (now also
  over `trial/sink`).
- **The publisher, schema versions and forward-only releases (2026-11-19):** `node --test
  'test/*.test.mjs'`: **35 of 35** (configure: viz-publisher deployed first with its health route
  and the publisher's own `/healthz` source; viz-ingest's `PUBLISHER` resolves to the stage's
  viz-publisher, deployed before it; every Durable Object class declared, each declared spec the
  one its class opens storage with, an undeclared class refused; the seven specs read from the
  sources with the ledger's migration 2 `readableFrom` 2, into the manifest and `VIZ_SCHEMAS`;
  `VIZ_STAGE_VARS` stage-only; `stack/wrangler.test.jsonc` equal to `stack/wrangler.jsonc` but for
  the publisher binding and the test main. release: forward-only marking (a readableFrom above
  what the serving version declares, an additive step that is not, a serving version that
  declares nothing, a first deploy, a lifecycle change); the rollback refusal naming release
  and migration, its positive cases, a record or a newer version without schema versions; A →
  B → C → B → A refused by the pure check and through `rollback()` with B serving; nothing
  restored when refused). `npx vitest run --maxWorkers=2`: 95 of 95 (the gateway's suite, which
  others have extended since). `npx tsc --noEmit` clean (now also over `trial/probe`).
  `node scripts/mutants-release.mjs` on a copy of the tree in a scratch directory, after the
  copy's tests passed unmutated: **12 of 12 killed** (a first run: 11 of 12; "only the version
  serving now is judged" survived until the rolled-back-release test above was added). The
  mutants: forward-only not marked, an undeclared serving version taken to know the new
  version, a lifecycle change not marked; `canOpen` dropped, off by one, the schema check never
  run, a newer undeclared version ignored, a record without schemas accepted, only the serving
  version judged; an undeclared class deployed, versions without `VIZ_SCHEMAS`, `compat`
  recorded as `latest`. `deploy.sh`'s new branch was not run (shellcheck is not installed here
  now); on Cloudflare, Trial 3.
- `npx tsc --noEmit` in deploy/: clean. It covers the gateway and the stage queue-name
  mapping, not `stage/ingest.ts`: typing that file means type-checking the whole write path
  (stack/, ledger/, …), which is their CI job's business and was mid-edit by others while this
  was written. The shim is checked by bundling it (`wrangler deploy --dry-run`, phase 1 of every
  stage release) and ran through the whole trial.
- `node gateway/scripts/mutants.mjs`, run from `deploy/` in a copy of the tree in a scratch
  directory (it refuses a git work tree; its header lists what the copy needs), after the
  copy's unmutated suite passed 55 of 55: **13 of 13 mutants killed** (2026-11-19). A mutant
  counts as killed only when a test ran and failed; a suite that did not load or finish is
  reported as such and counts as not killed. The copy's `gateway/src/index.ts` was equal to
  the shared tree's afterwards.

  | Mutant | Killed by (tests failing) |
  |---|---|
  | bootstrap accepts any token | refuses a wrong, missing or malformed token (1) |
  | bootstrap ignores the expiry | refuses after the window closes (1) |
  | bootstrap accepts a body or query string | takes no tenant from the request (1) |
  | bootstrap exists without the secret | does not exist while no secret is set (1) |
  | no `x-viz-route` on forwarded answers | the routing and transparency tests (27) |
  | the response body is buffered | streams the response (1) |
  | status text dropped | the status tests (12) |
  | `/api/v1/label` prefix too wide | `/api/v1/label` is a 404 (2) |
  | control prefix matches `/api/v1/controls` | `/api/v1/controls` is a 404 (2) |
  | healthy when any backend is | unhealthy when one fails (2) |
  | control's health probes the OpenAPI document again | control's health is its own `/healthz` (1) |
  | bootstrap answers a `schema_too_new` refusal with 500 | a retryable 503, nothing created (1) |
  | a throwing backend crashes the gateway | retryable 502 (1) |
  | monitors prefix matches `/api/v1/monitorsx` | `/api/v1/monitorsx` is a 404 (2) |
  | `/mcp` matched as a prefix (`/mcpx`, `/mcp/x` reach the agent surface) | the three `/mcp…` near misses are 404 (4) |
  | agent prefix matches `/api/v1/agents` | `/api/v1/agents`, `/api/v1/agentx` are 404 (3) |
  | the ruler is left out of `/healthz` | healthy over five backends; unhealthy naming the ruler (2) |
  | the ruler's paths go to the query service (both speak the Prometheus API) | the ruler's routing rows (8) |

  The five above are this change's: run on 2026-11-19 with the other 13, in a scratch copy
  whose `gateway/` was equal to the shared tree's: **18 of 18 killed** (the script now runs
  vitest with at most 2 workers).

- `wrangler deploy --dry-run` of all four generated production configs: bundles (viz-ingest
  2,642.54 KiB / 799.96 KiB gzip, viz-control 303.48 / 58.00, viz-query 2,625.71 / 824.97,
  viz-gateway 7.15 / 2.75).
- The CI exclusion as first built (query's `test/http.test.ts`, then importing `app/`), on a
  copy of the sources without `app/`: query's `npx tsc --noEmit` failed with 4 errors, all in
  that file, and was clean with the `tsconfig.ci.json` the workflow writes. That exclusion
  has since been removed (above); the `tsconfig.ci.json` mechanism is unchanged and now
  serves stack's exclusion only.
- actionlint 1.7.12 (built from source through the Go module proxy) with shellcheck 0.11.0
  on both workflows: no findings. shellcheck on `deploy.sh`: clean.
- The workflows themselves have not run: this checkout has no GitHub remote access. What
  they call was run locally (the matrix script, every deploy step); the trial below ran
  `deploy.sh` itself.

## Trial on Cloudflare (2026-11-18)

`deploy.sh --stage trial` against the real account: Workers `viz-trial-ingest`,
`viz-trial-control`, `viz-trial-query`, `viz-trial-gateway` (only the gateway on
workers.dev), R2 `viz-trial-lake`, KV `viz-trial-config`, queues `viz-trial-flush`,
`viz-trial-maint`, `viz-trial-flush-dlq`, `viz-trial-maint-dlq`. Nothing was deployed to
production and `vis.bitcru.sh` was not touched. Every resource was created by these scripts
and deleted by `resources.mjs destroy --stage trial` at the end (see "Cleanup").

Client numbers below are **measured on Cloudflare from outside**: from this sandbox, through
its egress proxy, so they include that path. For scale, a request the gateway answers by
itself (a 404) took p50 41 ms, p90 80 ms, p99 181 ms (n = 100).

### What ran

| Step | Result |
|---|---|
| `resources.mjs ensure` twice | created the bucket, the namespace and four queues; the second run: "all present" |
| N0 deploy without acknowledgement | **refused, exit 3**, before anything was uploaded: three migrations `(none) → v1` listed with the trailer each needs; no Worker created |
| N0 deploy with `viz-ingest@v1 viz-control@v1 viz-query@v1` | all four via `wrangler deploy` (three migrations, one new Worker), healthy, 47 s |
| `bootstrap.mjs --tenant trial-tenant` | admin key created and written to a 0600 file; secret deleted and confirmed gone; a smoke key (write, read) created through `/api/v1/control/keys`. A second bootstrap of the same tenant: **409, nothing created**. `POST /api/v1/bootstrap` with no secret set: 404 |
| Smoke with the key, on N0 | Remote Write 204, then every query **503** (see "Needed changes" 8): N0 was deployed from the shared working tree while another engineer was changing the query engine's ABI, and the bundled `viz_query.wasm` was older than its binding. CI cannot produce this mix (one commit, WASM built from it); the rest of the trial deployed from a snapshot of the sources, built by `deploy.sh` itself |
| N1 from the snapshot, `deploy.sh` building both engines | upload four versions, then promote; 467 s including the two release builds. Its smoke test passed on health, but the answer came from N0's gateway still serving at that location; `smoke.mjs` now waits until `/healthz` reports the release just promoted (`--expect-release`) |
| Smoke on N1 with the key | Remote Write 204 in 571 ms; all 9 samples returned by a query 820 ms after the acknowledgement |
| Latency, sequential, n = 200 each | write acknowledgement (4 series × 1 sample, 204): **p50 96 ms, p90 133 ms, p99 334 ms**; query `sum(viz_trial_latency{run})` (tail rows, 200): **p50 223 ms, p90 303 ms, p99 477 ms**; no errors |
| Upgrade, rollback and failed deploy under load | below |
| How the trial ran `deploy.sh` | always with `VIZ_SKIP_NPM_CI=1` (other engineers were running tests in stack/, query/ and control/; `npm ci` there would have replaced their node_modules mid-run) and, after N1, `VIZ_WASM_PREBUILT=1` with N1's modules |
| Cleanup | below |

### Upgrade under load

A writer sent 20 Remote Write requests a second (each one sample for each of 4 series,
values known in advance), open loop, retrying refusals with the same body as Prometheus does;
a reader asked `count(viz_trial_load{run})` every second. While it ran:

1. **N1 → N2**: `deploy.sh` with release N2, which is N1's code with one trivial change
   (`VIZ_RELEASE`), so every Worker got a new version and every Durable Object had to move.
   Upload, then promote callees first, then the smoke test with the key.
2. **N2 → N1 rollback**: `release.mjs rollback --record release-N1.json`, callers first.
3. **N1 → N3 → N1, automatic**: `deploy.sh` with release N3 and a smoke key that does not
   exist, so the smoke test fails (401) after N3 is live and `deploy.sh` restores N1 by itself.

Measured on Cloudflare from outside, one run of 13.6 minutes (run id kept in the trial's
report, not committed). Write requests are counted in the window their first attempt fell in;
"refused" is any answer other than 2xx, including network errors.

| Window | s | Write requests | Refused attempts | Requests retried | Disturbance | Write ack ms p50 / p90 / p99 / max | Reads | Read errors | Query ms p50 / p99 |
|---|---|---|---|---|---|---|---|---|---|
| baseline (N1 serving) | 90 | 1,801 | 0 | 0 | none | 87 / 108 / 236 / 603 | 90 | 0 | 258 / 732 |
| N1 → N2: upload, promote, smoke | 77 | 1,537 | 0 | 0 | none | 88 / 111 / 298 / 492 | 77 | 0 | 305 / 580 |
| N2 serving (its object cutover falls here) | 150 | 3,003 | 0 | 0 | none | 83 / 101 / 221 / 408 | 150 | 0 | 357 / 637 |
| rollback N2 → N1 | 30 | 591 | 0 | 0 | none | 90 / 118 / 213 / 382 | 29 | 0 | 412 / 757 |
| N1 serving (object cutover) | 150 | 3,002 | 0 | 0 | none | 86 / 111 / 274 / 469 | 150 | 0 | 375 / 574 |
| N1 → N3 → smoke fails (401) → automatic rollback to N1 | 199 | 3,972 | 0 | 0 | none | 88 / 115 / 245 / 541 | 198 | 0 | 298 / 707 |
| N1 serving (object cutover), to the end | 120 | 2,400 | 0 | 0 | none | 90 / 109 / 271 / 395 | 119 | 0 | 332 / 616 |
| **whole run** | 816 | **16,306** | **0** | **0** | | | **813** | **0** | |

**Acknowledged samples afterwards: 65,224 acknowledged, 65,224 returned by queries with the
values sent; 0 missing, 0 wrong** (read back in 5-minute slices of `viz_trial_load{run}[5m]`,
covering lake files and the tail: by then three sample files, three series files and six
ledger log objects had been flushed to the bucket through the queues, with no dead letter).

So across four cutovers (two promotions, a manual rollback, an automatic rollback, each moving
every Worker and both write-path Durable Object classes) no write was refused or retried, no
query failed, and no acknowledged sample was lost. Latency did not visibly move: write p99
stayed between 213 and 298 ms in every window.

**When the objects actually moved** (from `wrangler tail` on viz-trial-ingest, which reports
each invocation's version; tail samples events): after the manual rollback, the Worker's
fetch handler ran the restored version from 23:37:02.0; Shard events kept arriving on the
previous version, about two a second, until 23:37:30.9, and on the restored one from
23:37:31.8, so **29.7 s later**, which is the 30 s `max_delay` (the objects never went idle,
so they did not move early). The first Shard request after the reset took 364 ms of wall time
against about 40 ms for the others. The automatic rollback showed the same: fetch at
23:42:50.9, Shard at 23:43:20.7 (29.9 s). Ledger moved within a second of Shard each time. No
invocation in the tail had an exception or an error log. The caller-visible error Cloudflare
documents for a reset ("Durable Object reset because its code was updated") did not appear in
any client answer or tail event. Why (for example, that a deferred reset waits for in-flight
requests) is not shown by this run; the tail samples, and one run at 20 requests a second is
not proof that it never happens. If it does, edge answers 503 with `Retry-After` and nothing
is acknowledged (`edge/src/route.ts`), which the writer here would have retried.

**Promotion timing**: `versions deploy` took 0.85 s per Worker and `triggers deploy` about 3 s;
a whole N1 → N2 release (upload four, promote four, smoke with data) took 76 s, the manual
rollback 30 s, and N3 with its failing smoke test and automatic rollback 199 s (90 s of that
is the smoke test retrying a 401, as it does for a key that KV has not propagated yet).

### Migration gate and forward-only rollback, live

With no load, on the same stage: the snapshot's `stack/wrangler.jsonc` was given an empty
migration step `{ "tag": "v2" }` (in the snapshot only, to exercise the gate; the component
was not changed).

| Step | Result |
|---|---|
| deploy N4 without acknowledgement | **refused, exit 3**, in 4 s: "viz-trial-ingest: this release applies Durable Object migration v1 → v2. Acknowledge it with … "Migration: viz-ingest@v2"". Nothing uploaded |
| deploy N4 with `Migration: viz-ingest@v2` | viz-trial-ingest bundled in phase 1 and deployed with `wrangler deploy` (migration v2) at its turn; the other three uploaded and promoted; smoke with data passed; 72 s |
| `release.mjs rollback` to N1's record | **refused, exit 3, nothing changed**: "the release being restored ran under Durable Object migration v1, and v2 is in force now …" |
| the same by hand, `wrangler versions deploy <N1 ingest version>@100%` | **Cloudflare refuses too**: `Invalid deployment: The version … cannot be deployed because it has a resource that was modified: the version depends on Durable Object migration "v1", but the current deployment is using migration "v2"` [code 10210] |

### Cleanup

`node deploy/resources.mjs destroy --stage trial`. The first run stopped at viz-trial-ingest:
`10064 Cannot delete this Worker as it is a consumer for a Queue` (gateway, query and control
were already deleted). `destroy` now removes the stage queues' consumers first; the second run
deleted the four consumers, viz-trial-ingest, the four queues, the KV namespace, and the
bucket's 21 objects and then the bucket. Then, listing the account: **no Worker, bucket, KV
namespace, queue, custom domain or Durable Object namespace whose name contains
`viz-trial`**; the Worker count was back to 22, the number before the trial; the only `viz-`
resources left are the three spike Workers and the spike bucket that were there before. The
trial's KV id was removed from `resources.json`; the API keys written to files during the
trial were deleted with it.



## Trial 2: monitors, alerting and the agent surface on Cloudflare (2026-11-19)

`deploy.sh --stage trial2` against the real account, then `trial/trial2.mjs`, then
`resources.mjs destroy --stage trial2` and `trial2.mjs sink-down`. Workers `viz-trial2-ingest`,
`-control`, `-query`, `-ruler`, `-mcp`, `-gateway` (only the gateway on workers.dev), and
`viz-trial2-sink` (a webhook receiver, `trial/sink/index.ts`, workers.dev, KV `viz-trial2-sink`);
R2 `viz-trial2-lake`, KV `viz-trial2-config`, queues `viz-trial2-flush`, `-maint`, `-flush-dlq`,
`-maint-dlq`. Production and `vis.bitcru.sh` were not touched.

**Cost, stated before it ran** (modelled, Workers Paid rates): at most 2 hours (the stage's
`VIZ_STAGE_EXPIRES_AT` stops the ruler's alarms and cron and the sink by themselves), about
1,100 ruler alarms an hour with one or two queries each (about 15,000 Durable Object requests an
hour across rulers, query leaves, shards and the ledger), about 1,000 Remote Write requests, a
few hundred R2 writes and KV writes: well under US$0.10 modelled, **stated as under US$1 worst
case**. It ran about 14 minutes from the first deploy to the last deletion (02:25–02:39 UTC). No bill was read from Cloudflare's
analytics for it.

**How it ran.** From a snapshot of the working tree in a scratch directory (others were editing
it), with `VIZ_SKIP_NPM_CI=1` (node_modules linked from the shared tree) and
`VIZ_WASM_PREBUILT=1` (the modules in the tree, each newer than its binding; the smoke test's
query proved the read path's module and binding agree). Since the snapshot, two files changed
without changing behaviour: `ruler/src/remote.ts` inlines a one-line helper (so Node can load it
for the encoder test), and `trial/trial2.mjs` reports `urlShownToAdmin` where it reported a
constant `urlTokenInAnswer: false`.

| Step | Result |
|---|---|
| deploy without acknowledgement | **refused, exit 3**, before anything was uploaded; the refusal listed exactly `viz-ingest@v1`, `viz-control@v1`, `viz-query@v1`, `viz-ruler@v2` |
| deploy with those four | five Workers deployed (migrations applied: ingest, control, query `v1`, ruler `v2`; mcp new); the gateway's first `wrangler deploy` failed **after** its upload with `This Worker does not exist on your account [code: 10007]` (Cloudflare's API, right after creating the script). Nothing was rolled back (migrations had been applied), as designed |
| deploy again, same release | fix forward: every Worker uploaded and promoted, the gateway too; smoke on health: **all five backends 200** through the gateway (ingest, query, control, ruler, mcp); 111 s |
| bootstrap `trial2-tenant` | admin and smoke keys written to 0600 files in the scratch directory, never printed; secret deleted and confirmed gone |
| smoke with data | Remote Write 204 in 577 ms; all 9 samples returned 1,292 ms after the acknowledgement |
| sink | deployed; its path token and the webhook secret generated here, set with `wrangler secret put` on stdin |
| keys and settings, through the gateway | data (`write`, `read`), monitors (`monitors:*`) and agent (`read`, `monitors:read`, `dashboards:read`, kind `agent`) keys through `/api/v1/control/keys`; **control's notification settings** set to the sink's URL, `webhookFormat: json`, a signing secret: 200, `webhookSecretSetAt` set, the secret not in the answer |
| routing | `PUT /api/v1/monitors/notifier` with `route: { receiver: viz:default, group_by: [alertname, run], group_wait: 0s, group_interval: 10s }`, no receivers of its own: 200 |
| rules, through the ruler's API on the gateway | threshold monitor `max by (run) (viz_trial2_value) > 100`, `for: 0s`, interval 10 s, cost class `tail`: 201; anomaly monitor on `viz_trial2_wave` (EWMA): 201; recording rule `viz_trial2:value:max = max(viz_trial2_value)`, 10 s: 200 |
| 20 runs, 15 s apart | one new series `viz_trial2_value{run="rk"} = 150` each (Remote Write 204 every time) |
| **webhook** | **20 of 20 runs notified, one firing notification each, 0 duplicate requests**; every request's `X-Viz-Signature` verified by the sink with the shared secret; `Idempotency-Key` equal to the body's `idempotencyKey`; **no secret, key or path token in any body**. Content of `r1`: `version: viz.notification/v1`, receiver `viz:default`, `name: trial2 value high`, `labels.run: r1`, `value: 150`, `annotations.summary: "run r1 at 150"`, `endsAt: null`, `Content-Type: application/json`, `User-Agent: viz-notifier`. Also the dead-man's switch (one firing notification) and resolutions as each run's series went stale |
| the Alertmanager form | `webhookFormat` switched to `alertmanager` in control (URL unchanged, so the secret kept); after the notifier's refresh (≤ 60 s) the next run (`ram`) arrived as Alertmanager's version "4" body, signed, `groupLabels {alertname, run}`, `endsAt 0001-01-01T00:00:00Z`; later resolutions too |
| anomaly rule | **evaluates**: `health: ok`, state `ok`, detector status `ok`, 1 series scored, 0 warming, 352 B of state, `lastEvaluationMs` set; `/api/v1/rules` evaluation time 0.068 s |
| recording rule | **through Remote Write and back**: the query `viz_trial2:value:max` returned `150` (the ruler's Remote Write body, decoded by edge on Cloudflare) |
| Prometheus reads | `/api/v1/rules`: four groups (`anomalies/10s`, `monitors/10s`, `trial2-recorded`, `viz:deadman`), all `health: ok`, evaluation time 0.003–0.17 s; `/api/v1/alerts`: 200, 12 alerts |
| service key | one key `service:viz-ruler/0` (`read`, `write`, created by `system:viz-ruler`) in the tenant's key list, one `key.service` audit entry: no rotation was needed |
| what the APIs show | `GET /api/v1/monitors/notifier`: `viz:default` with one signed webhook integration; neither it nor `GET /api/v1/monitors` contains the URL's path token or the secret |
| **MCP over `/mcp`** (JSON-RPC, 2025-06-18, agent key) | `tools/list`: 11 tools (those the key's scopes allow); `list_monitors`: "2 monitor(s): 1 firing, 1 ok" naming both; `get_monitor`: 11 active alerts, 62 history entries; `query`: the runs' series over 30 minutes; `validate_query`: valid, with the **query service's plan** in the structure (`execution: single`, 0 files listed: everything was still in the shards' tails); `search_telemetry`: 3 metrics. 279–915 ms per call from outside |

**Latency from rule evaluation to webhook, measured on Cloudflare** (the alert's `startsAt`,
which is the evaluation time of the tick that first saw the series, to the sink Worker's clock
when the request arrived; both Cloudflare's clocks; one sample per run, nearest rank):
**n = 20: p50 174 ms, p90 187 ms, p99 266 ms** (min 149, max 266). It includes the alarm
running after its tick, the query, the hand-off to the notifier, its flush (`group_wait: 0s`) and
the delivery. Resolutions arrive on the group's next `group_interval` tick, by Alertmanager's
rules: n = 4 in the plain form, 172 ms to 10.1 s (`group_interval: 10s`).

### Cleanup (Trial 2)

`resources.mjs destroy --stage trial2` deleted the four queue consumers, the six Workers
(callers first), the four queues, `viz-trial2-config` and the bucket with its one object; it
then reported the sink Worker and its KV namespace as left over (exit 1: they are not stage
resources); `trial2.mjs sink-down` deleted both. Listing the account afterwards: **no Worker, KV
namespace, R2 bucket, queue, custom domain or Durable Object namespace whose name contains
`viz-trial2`**; the `viz-` resources left are two spike Workers and one spike bucket that are not
this trial's. The API keys, the sink token and the webhook secret were deleted from the scratch
directory; the shared tree's `resources.json` was never written (the trial ran from the snapshot).

## Trial 3: the publisher wired in, deletion gated on publication, recorded samples, forward-only releases (2026-11-19)

`deploy.sh --stage trial3` against the real account: Workers `viz-trial3-publisher`, `-ingest`,
`-control`, `-query`, `-ruler`, `-mcp`, `-gateway` (only the gateway on workers.dev) and
`viz-trial3-probe` (workers.dev, a path that answers 404 without a token generated for the trial
and set with `wrangler secret put` on stdin); R2 `viz-trial3-lake`, KV `viz-trial3-config`, queues
`viz-trial3-flush`, `-maint`, `-flush-dlq`, `-maint-dlq`. Production and `vis.bitcru.sh` were not
touched. 03:58–04:37 UTC.

**Cost, stated before it ran** (modelled, Workers Paid rates): at most 90 minutes of the stage
(`VIZ_STAGE_EXPIRES_AT` two hours out stops the ruler; the stage was to be destroyed at the end),
a writer at 1 Remote Write request a second for at most 45 minutes and a reader at one query a
second, seven Workers and the probe, at most a few thousand queue operations, 1,000 R2 class A
and 10,000 class B operations, 50,000 Durable Object requests and 1,000 KV writes: well under
US$0.10, **stated as under US$1 worst case**. **Measured on Cloudflare** (GraphQL
`workersInvocationsAdaptive`, 03:58–04:38 UTC, read after the deletion): 7,282 Worker invocations,
4 errors, 17,627 subrequests, all under `__unknown__`, the name analytics gives deleted scripts
(the trial's were deleted at 04:37; that no other deleted script ran then is likely, not
checked). No bill was read.

**How it ran.** From a snapshot of the working tree in a scratch directory (others were editing
it), with `VIZ_SKIP_NPM_CI=1` and `VIZ_WASM_PREBUILT=1`. The first two attempts stopped in phase 1,
before anything was uploaded: the snapshot's `ruler/` was mid-edit by its engineer (`wrangler
deploy --dry-run`: no export `fetchHistory` in `ruler/src/history.ts`); `ruler/` was copied again
a minute later and bundled. One stage var for the trial (`VIZ_STAGE_VARS`): viz-ingest's
`MAINTENANCE` = `{"deleteGraceMs":120000}`, so the **ledger** releases a removed file after
2 minutes instead of an hour, and anything the publisher still holds back is visible within the
trial. Everything else at its defaults (shards seal after 10 minutes; compaction merges an hour
once it has four level-0 pairs; the publisher publishes 2 minutes after a nudge, keeps snapshots
24 h and at least two, releases a file an hour after its last snapshot expired).

| Step | Result |
|---|---|
| deploy without acknowledgement | **refused, exit 3**, before anything was uploaded; the refusal listed exactly `viz-publisher@v1`, `viz-ingest@v1`, `viz-control@v1`, `viz-query@v1`, `viz-ruler@v2` |
| deploy with those five | the seven Workers by `wrangler deploy` in order, viz-publisher first (viz-ingest's `PUBLISHER → viz-trial3-publisher:Publisher`); health through the gateway, all five backends 200; 65 s. Release record: not forward-only (nothing older existed), the seven classes' `{latest, compat}` (ledger 3/2, publisher 2/1, …). **Each version's `VIZ_SCHEMAS` read back from Cloudflare's version API** (`resources.bindings`) |
| bootstrap `trial3-tenant`, smoke with data | keys written to 0600 files in the scratch directory, never printed, deleted afterwards; Remote Write 204 in 439 ms, all 9 samples returned 980 ms after the acknowledgement |
| writer, 30 minutes (`load.mjs`, 1 request a second × 4 series) | **1,800 requests, 0 refused, 0 retried**; acknowledgement p50 72 ms, p90 89, p99 288, max 1,170 (from outside, through this sandbox's proxy); 1,798 reads, 0 errors, p50 81 ms, p99 319; **7,200 acknowledged samples, 7,200 returned with the values sent, 0 missing, 0 wrong** |
| **publication on its own** | nobody called the publisher. 04:11:57–04:12:08: three maintenance runs (after the first flushes) each ended `nudged true` (viz-ingest's log line); viz-publisher's tail shows a `safeToDelete` and a `notify` per run and nothing else; **04:13:57 its alarm** committed `v1.metadata.json` of both tables (the two level-0 pairs; format version 2, `viz.format-version` 1); 04:23:57 and 04:33:58 the next alarms committed v2 and v3 after the next rounds of flushes and maintenance. The tables read back from R2 (`metadata.json`, manifest lists and manifests decoded with `publisher/src/avro.ts`): every data file of every retained snapshot is in the bucket |
| **a deleted file waits for publication** | 04:22: the second round of flushes made four level-0 pairs; the maintenance run merged them (`merged 1`, 8 tombstones). 04:23:58 the publisher's snapshot 2 lists the two published samples files (and the two series files) as DELETED; snapshot 1, retained, still names them. 04:31:57, 04:32:03, 04:32:11 (the next maintenance runs, the ledger's 2-minute grace long past): **`deleted 0, waiting 8 (for publication 8)`**: the ledger offered all 8 objects for deletion and the publisher released none (4 are still named by snapshot 1; 4 were added and compacted away between publications, released by the publisher an hour after it saw them). At 04:36, listing the bucket: all 8 objects present (14 data objects = 6 live + 8 waiting), both DELETED entries' objects present, nothing any retained snapshot names missing. Without the gate (`janitor/test/publication.test.ts`, the same scenario unbound) they would have been deleted at the first run after 04:24. Their release (a day after a later commit expires snapshot 1) was not waited for |
| **recorded samples through a service binding** | the probe, bound to viz-trial3-ingest's `RecordedSamples` as `viz-ruler` and as `viz-mcp`: as the ruler, two batches (`42`, `+Inf`) written, 38 ms inside the probe, and returned by a query through the gateway with the tenant's key (`+Inf` and `42` at their timestamps); the same call again: written, nothing doubled. As `viz-mcp`: `unauthorized: this service binding does not name a caller …`; another tenant's batch: `invalid: batch "someone-else/…" is not one of tenant trial3-tenant's; nothing was written`; tenant `../x`: `invalid: tenant id …`; value `0x10`: `invalid: … nothing was written`. Without the probe's token: 404 |
| **forward-only release, live** | in the snapshot only (never in the repository), the ledger's spec got an empty migration 4 with `readableFrom` 4; release N2 deployed (no Durable Object migration, so uploaded then promoted, 103 s; smoke with data passed). The plan printed and the record says **`forwardOnly: true`**: "ledger.Ledger: migration 4 (…) has readableFrom 4, above version 3, which the release serving before it knew" (version 3 read from N1's `VIZ_SCHEMAS` on Cloudflare) |
| `release.mjs rollback` to N1's record | **refused, exit 3, nothing changed**: "ledger.Ledger: release trial3-n2 (viz-trial3-ingest version d06427fe-…) ran schema version 4, readable from 4, and trial3-n1 knows only up to 3: that release is forward-only (migration 4: …). Fix forward instead." viz-ingest still served N2 afterwards. Positive control: `rollback` to N2's own record (nothing newer) passed every check and restored the seven versions, exit 0 |

**What did not go as expected.** viz-ingest's tail showed three invocations of `RecordedSamples`
ending `exception` with "The Workers runtime canceled this request because it detected that
your Worker's code had hung …": the refused calls. The caller had already received each refusal,
with its message, in 2–4 ms, and nothing was written; the two successful calls ended `ok`. Not
understood (one guess, not tested: the refusal is a thrown error and the probe never disposes
the RPC stub, so the callee's invocation is closed when the probe's request ends). It counts
refused recorded-sample writes as ingest errors (the 4 errors above are probably these and one
more). Not seen locally.

### Cleanup (Trial 3)

`resources.mjs destroy --stage trial3` (from the snapshot) deleted the four queue consumers, the
seven Workers (callers first), the four queues, `viz-trial3-config` and the bucket with its 50
objects, then reported `viz-trial3-probe` as left over (not a stage resource, exit 1); it was
deleted through the API. Listing the account afterwards (Workers, KV namespaces, R2 buckets,
queues, Durable Object namespaces): **nothing whose name contains `viz-trial3`** (nor
`viz-trial`); the counts were back to those listed before the trial (20 Workers, 7 namespaces,
6 buckets, 0 queues, 28 Durable Object namespaces); the only `viz-` resource is a spike Worker
that is not this trial's. The keys, the probe token, the tails and the snapshot were deleted from
the scratch directory; the shared tree's `resources.json` was never written.

## Cost

Modelled, not read from Cloudflare's analytics (Trial 3 read invocation counts from it, above). Production idle: three Durable Object
Workers and the gateway cost nothing while unused; the hourly cron reads KV only
(`stack/README.md`, "Idle means free"); storage is whatever `viz-lake` and the queues hold.
Per deploy: about 8 to 12 API calls and 4 to 8 version uploads; no charge beyond requests.
The trial (below) was stated before it ran as under US$1 worst case: at most 30 minutes of
20 Remote Write requests and 1 query a second through four Workers, a few hundred R2 writes
from flushes, a few thousand queue operations, one KV namespace and one small bucket, at
Workers Paid rates. What it sent, counted by the client: 16,306 Remote Write requests and 813
queries under load, 400 more for the latency measurement, about 20 for smoke tests and
bootstrap, five releases and two manual rollbacks. Cloudflare's GraphQL analytics, queried
right after the trial for 23:10–23:50 UTC, returned no rows for the `viz-trial-*` scripts
(already deleted, or not yet ingested), so there is no measured bill for it here.

## Needed changes in components

From the generated OAuth key (D53; none made here):

- **`.github/workflows/deploy.yml`: an input to rotate a generated secret** (`rotate_secrets`,
  passed to `deploy.sh` as `VIZ_ROTATE_SECRETS`), so a rotation can run in CI rather than from a
  workstation ("Worker secrets the deploy generates", Rotation).
- **`control/README.md` "Needed changes" 9**: the deploy now generates `OAUTH_CLIENT_KEY`; that
  item's owner can mark the key part done. Its other part, `PUBLIC_URL` equal for viz-control and
  viz-mcp, is not enforced by the deploy: both component configs say `https://vis.bitcru.sh`, which
  is right for production and wrong for a stage (whose gateway is on workers.dev).

From Trial 2 and the ruler (none made here):

- **`query/src/index.ts`: an RPC entrypoint (`QueryService`) for the ruler**, so a group's tick
  is one call with one plan instead of N HTTP requests with a stored key. The exact shape is in
  `ruler/README.md`, "Needed changes" 1; the deploy then binds it as the ruler's `EVALUATOR`.
- **Cloudflare 10007 on a new Worker's first `wrangler deploy`** (Trial 2, the gateway): not a
  component change; re-running the deploy fixed it. If it recurs in CI, `release.mjs` could
  retry `wrangler deploy` once on that code.

From the first trial:

None of these were made here; 3 was made since in query/, and 4 in control/ and the gateway.

1. **`stack/src/index.ts`: queue names are hard-coded.** `handleQueue` compares
   `batch.queue` with the literals `viz-flush` and `viz-maint` (`FLUSH_QUEUE_NAME`,
   `MAINT_QUEUE_NAME`) and treats every other queue as a dead-letter queue. Any deployment
   whose queues are named otherwise (every stage: `viz-trial-flush`) would write each flush
   message off as a dead letter, and nothing would ever reach the lake. Wanted: route by a
   configured name (a var such as `FLUSH_QUEUE_NAME`) or by the binding the consumer was
   declared for. Workaround, stage only: `deploy/stage/ingest.ts` hands the stack the batch
   under its production name and changes nothing else; production deploys
   `stack/src/index.ts` directly.
2. **One shared pool map, three values.** `stack/wrangler.jsonc` has `DEFAULT_POOL` with
   `slots: 2`; `edge/`, `query/` and `control/` have `slots: 8`. Split into Workers, ingest
   would route a tenant without a `pool:<tenant>` record to 2 slots while the query Worker
   asked 8-slot shards for its tail: recent samples would be invisible until flushed.
   Workaround: `workers.json` `shared_vars` pins one value (edge's, 8 slots) for every
   Worker that declares the var, and `configure.mjs` prints the disagreement on every run.
   Wanted: one source for the shared pool (a contract constant or a KV record), and a test
   config for stack/ separate from the one production is generated from.
3. **`query/test/http.test.ts` imported `app/src/api/client.ts`.** Done in `query/`: the test
   has its own client, and CI no longer excludes it (commit 587f3df).
4. **`control/`: no health route.** Done: control serves `GET /healthz` without a credential,
   as ingest and query do (200 `ok` when the Worker runs with its `TENANT` and `CONFIG`
   bindings, 503 naming a missing one; it asks no Durable Object or KV), and the gateway
   probes it instead of `/api/v1/control/openapi.json`; `workers.json` records it as
   viz-control's health path (a test holds the two equal).
5. **`query/wrangler.jsonc` names the write path `viz-edge` and `viz-flush`**, Workers that
   no longer exist as such; the deploy maps both (and `viz-stack`) to viz-ingest through
   `script_aliases`. Wanted: `viz-ingest` in the component config.
6. **`stack/test/e2e.test.ts` imports hyparquet from `bench/node_modules`**, so stack's CI
   job has to `npm ci` in bench/. Wanted: hyparquet as a dev dependency of stack.
7. **Schema versions the deploy can read.** Done here instead (2026-11-19): `lib/schemas.mjs`
   bundles the specs `workers.json` names with esbuild and evaluates them in a Node `vm`; no
   component changed. A spec module that does more than define values at load time would fail
   that read, loudly.
8. **`query/`: an engine that cannot start is reported as a storage outage.** In release N0
   of the trial (below) the query module and its binding disagreed (`engine: module ABI 1,
   binding expects 2`); every query answered **503 `unavailable`, "a storage component did
   not answer; retry"** with `Retry-After: 1`. The binding's refusal is right; the
   classification is not: a client is told to retry something that cannot succeed. Wanted:
   engine initialisation errors as `internal` (500).
9. **`edge/`: `/api/v1/push` is not served.** The gateway routes it to viz-ingest as asked;
   edge answers 404 until it exists.
10. Nothing else. Under load, across four cutovers, no component refused a request, failed a
    query or lost an acknowledged sample (the trial, above).

## Not deployed yet, and why

Every Worker is deployed. **viz-publisher** is since 2026-11-19: viz-ingest binds its
`Publisher` class (`PUBLISHER`, by `script_name`), every maintenance run nudges it, and the
janitor's purge deletes only what it releases (`stack/README.md`, `janitor/README.md`). It deploys
first (callees first), has no route and no cron, and its health route (`GET /healthz`) is
recorded in `workers.json` but not asked by the gateway, which has no binding to it. viz-ruler and
viz-mcp are deployed since Trial 2 (below): viz-ruler after viz-control, viz-query and
viz-ingest, which it calls; viz-mcp after viz-ruler; the gateway last. A test
(`test/configure.test.mjs`) fails if any deployed Worker binds one that is not deployed
before it. The UI (`app/`, `design-system/`) is not part of this
deployment and nothing here needs it: the gateway has no page and no static assets.

## Not implemented

- **Wire-format versions in the rollback check.** Schema versions are checked (above); the
  versions of formats a release reads and writes (queue messages, R2 objects, KV records:
  COMPATIBILITY.md §6) are not recorded, so a rollback below the reader of a format is not
  refused by the tool.
- **Gradual (percentage) rollouts.** Every promotion is 100%. Splitting would put two
  versions of the write path's objects in service at once; the tooling refuses nothing about
  it but never does it.
- **Alerting** on a failed deploy beyond the failed job and its summary.
- **The workflows have not run on GitHub** (see above).
- **Generated secrets on Cloudflare.** Never run there: the inheritance of the key by later
  uploads, the put on a version that serves nothing, and rollbacks across the release that
  created the key are modelled by the fake, not measured ("Known risks" has the experiment).
- **Rotation without a deploy, or with overlap.** A rotation is a release; control verifies under
  one key only, so every registered client is invalidated at once. No workflow input yet.

## Known risks

- **Rollback across the release that created (or rotated) the OAuth key** (D53). The versions
  restored do not carry the key (or carry the old one). Not documented, not measured: whether
  `versions deploy` of such a version is refused (wrangler's own `rollback` handles an API error
  10220, "secrets have changed", by asking; `release.mjs` uses `versions deploy`, which does not),
  and, if allowed, which value serves (secondary sources say a rollback keeps the current secret
  values). If refused, the automatic rollback of that one release fails loudly and the new release
  keeps serving; if allowed, `/oauth/register` answers 503 until the next deploy. And whether the
  next deploy then keeps the key depends on uploads inheriting from the newest version, which is
  read from the documentation, not measured; if they inherit from the deployed version instead, it
  either refuses (exit 3, the key seen in the secret list) or makes a new key, which only clients
  that registered while the rolled-back release served would notice. **Experiment**: on a stage,
  deploy R0 without the key, R1 (creates it), `release.mjs rollback` to R0's record, then R2;
  record whether the rollback is refused (10220), what `/oauth/register` answers, and whether R2
  keeps or creates the key. Cost: three releases of a stage, cents.
- **Reading the schemas runs component code in Node.** `lib/schemas.mjs` evaluates the bundle of
  the spec modules (and what they import) in a `vm` context; a spec module that does more than
  define values at load time (a top-level call to a platform API) makes configure fail, loudly.
- **A rollback lists versions.** It reads every version Cloudflare keeps that is newer than the
  target's (one API call each); far back, that is up to 100 calls per Worker.
- **Refused recorded-sample writes show as ingest exceptions on Cloudflare** (Trial 3, "What did
  not go as expected"): the caller gets the refusal; the callee's invocation ends "hung". Not
  understood.

- **viz-mcp behind the gateway shares the gateway request's six connections** with everything
  it calls (Six connections, above): `read_dashboard`'s six queries in flight then wait on each
  other inside the platform. Not measured; the trial's MCP calls took 279–915 ms from outside.
- **The ruler evaluates through HTTP one query at a time** (decision D39): fine for groups of
  tens of rules, too slow for a 1,000-rule group until query exports an RPC entrypoint.
- **Right after a destination is set in control, the notifier shows `viz:default` without its
  integration** until its first refresh (on the next hand-off or alarm; Trial 2's routing step
  showed `integrations: []`); notifications are not affected, since a refresh precedes every
  hand-off it processes.

- **A deploy is not atomic across Workers.** Between viz-ingest's promotion and
  viz-gateway's, callers run the previous release against new callees (a minute or so in the
  trial). That is the documented skew; it is safe only while every component keeps the
  one-release compatibility of `contracts/COMPATIBILITY.md`.
- **Old Durable Object code keeps serving up to 30 s after promotion** (deferred mode;
  measured in the trial: the write path's Worker code switched at once, its Shard and Ledger
  objects 29.7 s later), so for that half minute new Worker code calls old object code. A
  rollback is itself a new deployment and moves every object again.
- **Rollback is only as good as the record.** Artifacts expire after 90 days and Cloudflare
  keeps 100 versions; after that, go back by deploying an old commit.
- **The trial ran from a snapshot of a working tree that others were editing**, with the WASM
  built from that snapshot; CI builds and deploys one commit, which cannot have that problem
  (see the trial, release N0).
