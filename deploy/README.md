# Deploy

How viz gets from a commit on `main` to `vis.bitcru.sh`, and back again. This directory holds
the deploy tooling, the public gateway Worker, and the record of the trial on Cloudflare. It
changes no component: everything it needs from one is under "Needed changes".

| File | What it does |
|---|---|
| `workers.json` | Which Workers exist, in dependency order (callees first), which are deployed, and why the others are not. Deployment-wide settings: domain, observability sampling, Durable Object code-update mode, resource names, shared vars |
| `configure.mjs` | Generates each Worker's production (or staged) wrangler config into `generated/` from the component's own `wrangler.jsonc`; D70's gate on viz-control's rate limits, `OAUTH_PUBLIC`, and no `placement` on viz-control and viz-mcp ("Rate limits in front of OAuth") |
| `resources.mjs` | Creates the R2 bucket, KV namespace and queues (idempotent), and gives viz-control's Rate Limiting bindings namespace ids of their own (reads the account's bindings; creates nothing); `destroy --stage` deletes a stage and frees its ids |
| `release.mjs` | Upload every Worker, then promote callees first; the migration gate; release records (with schema and format versions, rollback floors, and whether the release is forward-only); rollback of a record (or `--only` some of its Workers, the others judged as they serve), refused across a forward-only release, under a format version a restored Worker does not read, below a rollback floor, or across the OAuth key's creation or rotation; `plan` |
| `lib/formats.mjs` | Reads each Worker's format versions (written and read) from its components' `FORMATS` maps and read lists, for the manifest, the `VIZ_FORMATS` var of each version, and the rollback check (D69) |
| `lib/floors.mjs` | Rollback floors a switch raises (`INGEST_SIGNALS`; `OAUTH_PUBLIC`): which Workers, how each is judged (schema version or a `VIZ_FLOORS` stamp), and the deploy and rollback refusals, or a forward-only mark where a rule says so (D64, D69) |
| `lib/secrets.mjs` | Worker secrets the deploy generates (viz-control's `OAUTH_CLIENT_KEY`): put on the release's upload only where missing, value on wrangler's stdin, replaced only when asked, never on another run's upload, never on a viz-control without its rate limits (D70); rollbacks across its creation or rotation refused ("Worker secrets the deploy generates") |
| `lib/schemas.mjs` | Reads every Durable Object class's `SchemaSpec` from the component sources (esbuild, no Worker run) for the manifest, the `VIZ_SCHEMAS` var of each version, and the rollback check |
| `deploy.sh` | The whole deploy: WASM, `npm ci`, resources, configure, release, smoke test, automatic rollback |
| `smoke.mjs` | `/healthz` until the release just promoted answers, then a real Remote Write and a query that must return it within 60 s |
| `bootstrap.mjs` | A tenant's first API key, through a one-time token |
| `load.mjs` | Steady write and read load with a cutover report (used by the trial) |
| `gateway/` | `viz-gateway`, the Worker on `vis.bitcru.sh`, and its tests |
| `stage/` | The one shim a staged deployment needs (queue names, see "Needed changes" 1) |
| `trial/` | Trial 2: `sink/index.ts`, a webhook receiver Worker for a stage, and `trial2.mjs`, which drives a stage end to end (monitors, alerting, MCP) and reports. Trial 3: `probe/index.ts`, a stand-in for the ruler's `SINK` binding |
| `ci/matrix.mjs` | Which components CI checks in this checkout |
| `scripts/mutants-release.mjs` | Mutation check of the schema, format and floor rules in `release.mjs`, `configure.mjs`, `lib/schemas.mjs`, `lib/formats.mjs`, `lib/floors.mjs`, of the class-binding allowlist and viz-mcp's bindings, of the workflow's main-only gate, of D70's gate in `configure.mjs` and of the rate-limit ids in `resources.mjs` (run on a copy) |
| `scripts/mutants-secrets.mjs` | Mutation check of the generated secrets (`lib/secrets.mjs`, its use in `release.mjs`, stdin in `lib/wrangler.mjs`, the API timeout in `lib/cf.mjs`, D70's gate on the key; run on a copy) |
| `test/fake-wrangler.mjs` | A stand-in for wrangler that the end-to-end tests (`secrets`, `release-checks`, `review-d69`, `workflow`, `oauth-gate`, `upgrade-production`) run as a real child process (`VIZ_WRANGLER_BIN`, tests only), with `test/fake-account.mjs` answering the Cloudflare API from the same state (versions show their vars, secrets and Rate Limiting bindings) |
| `test/upgrade-production.test.mjs`, `test/fixtures/production-fb77292.json` | The first release this tool makes over production as deployed on 2026-11-19 from fb77292 ("The first release over the 2026-11-19 production"); the fixture holds the vars fb77292's own configure.mjs generates for production |
| `test/oauth-gate.test.mjs`, `test/resources.test.mjs` | D70's gate on the key and the oauth-public floor, end to end; the rate-limit id allocation |
| `records/<sha>.formats.json`, `scripts/record-formats.mjs` | The format versions a release from before format records writes and reads, made from its own sources (`git archive`) by this tree's `lib/formats.mjs`; release.mjs uses one wherever a record or version of that release declares none. Today: fb77292 (review of D69, round 2, M2-1) |
| `resources.json` | KV namespace ids by title (not secret; rewritten by `resources.mjs`) |
| `generated/` | Build output: configs, manifests, release records. Git-ignored |

## How a push to main becomes a deployment

```
push to main
  └─ .github/workflows/deploy.yml   (concurrency group deploy-production; one run at a time)
       ├─ checks: ci.yml, the same jobs a pull request runs; builds both WASM engines once
       └─ deploy (GitHub environment "production"):
            0. refuse any ref but main (an older commit's own tooling never runs: "Rollback")
            1. download the WASM modules the checks built and tested
            2. acknowledgements: dispatch input + "Migration:" trailers of every commit since
               the release serving now (read from the version tag on Cloudflare)
            3. deploy/deploy.sh
                 npm ci (deploy/, stack/, control/, query/, ruler/, mcp/)
                 resources.mjs ensure       R2 viz-lake, KV viz-config, queues viz-flush, viz-maint,
                                            viz-flush-dlq, viz-maint-dlq; viz-control's six Rate Limiting
                                            namespace ids (the account's bindings read, nothing created)
                 configure.mjs              generated/production/*.jsonc + manifest.json; refuses a
                                            viz-control without its rate limits (D70)
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
with `rollback_to: <sha>`, restores the release recorded for that commit instead. Either only on
`main`: a run on any other ref is refused before checkout (D69; review of D69, M-2).

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
 hourly cron,    viz-ingest   settings);        INGEST service     own key; OAUTH: control's
 RecordedSamples              OAuthIntrospection bindings; TENANT  OAuthIntrospection
 entrypoint                   entrypoint        (control's         entrypoint (no DO binding)
                                                Tenant) by script_name;
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
| `/api/v1/plan` (exactly) | viz-query | what a query would read, without running it (added 2026-11-19; the ruler and mcp reach it through their own `QUERY` bindings) |
| `POST /v1/traces`, `POST /v1/logs` (exactly) | viz-ingest | OTLP/HTTP traces and logs, the OTLP default paths (opentelemetry.io/docs/specs/otlp/, "OTLP/HTTP Request", read 2026-11-19). edge serves them only while `INGEST_SIGNALS` names the signal, else 404 (added 2026-11-19, stage 3 of traces and logs) |
| `POST /loki/api/v1/push` (exactly) | viz-ingest | Loki push (grafana.com/docs/loki/latest/reference/loki-http-api/, read 2026-11-19); edge serves it only while `INGEST_SIGNALS` names `logs` |
| Tempo: `/api/traces/<id>`, `/api/v2/traces/<id>`, `/api/search`, `/api/search/tags`, `/api/v2/search/tags`, `/api/search/tag/<tag>/values`, `/api/v2/search/tag/<tag>/values`, `/api/metrics/query_range`, `/api/metrics/query`, `/api/echo` | viz-query | the paths of the "Query" section of grafana.com/docs/tempo/latest/api_docs/ (read 2026-11-19) that viz-query serves (`query/src/sigroutes.ts`); exact paths, a path parameter is one non-empty segment. viz-query answers them only while `QUERY_SIGNALS` names `traces`, else 404. `GET /api/echo` ("Returns status code 200 and body `echo` when the query frontend is up"), the check a Grafana Tempo data source may make, answers `echo` behind the key like every path (D62; query review m-4; routed 2026-11-26). Tempo's `POST /api/v2/traces/diff` has the shape of a trace id and reaches viz-query, which does not serve it (an invalid id) |
| Loki: `/loki/api/v1/query`, `/query_range`, `/labels`, `/label/<name>/values`, `/series` | viz-query | the query paths of grafana.com/docs/loki/latest/reference/loki-http-api/ that viz-query serves; only while `QUERY_SIGNALS` names `logs`, else 404. Every other `/loki/…` path (tail, index stats and volume, patterns, detected fields, rules, delete, format_query, status), Loki's `/otlp/v1/logs`, the deprecated `/api/prom/…` and Tempo's `/api/status/buildinfo`, `/api/overrides` are 404 at the gateway |
| `/api/v1/control`, `/api/v1/control/*` | viz-control | |
| `GET /api/v1/rules`, `GET /api/v1/alerts`, `/api/v1/monitors`, `/api/v1/monitors/*` | viz-ruler | Prometheus' rule and alert reads, and the monitors API (monitors, groups, rule files, backtest, detectors, notifier config, silences): `ruler/src/http.ts` `ROUTES`. `/api/v2/alerts` (Alertmanager ingestion) is not served |
| `/mcp` (exactly), `/api/v1/agent`, `/api/v1/agent/*` | viz-mcp | MCP over Streamable HTTP, and the same tools as JSON. `/mcp/` and `/mcp/x` are 404 at the gateway |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` (exactly) | viz-mcp | OAuth protected resource metadata of `/mcp` (RFC 9728, D44) |
| `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` (exactly) | viz-control | The OAuth authorization server for MCP clients (D44; methods in `control/README.md`). `/oauth/register` answers 503 and is not advertised while viz-control has no `OAUTH_CLIENT_KEY`, which the deploy generates ("Worker secrets the deploy generates"), and only on a viz-control with its six Rate Limiting bindings ("Rate limits in front of OAuth"). In production `configure.mjs` sets `PUBLIC_URL` for viz-control (the issuer) and viz-mcp (the resource's origin) from `workers.json`'s `domain`, overriding a component that disagrees with a warning, so the two cannot differ; a stage keeps the component's value |
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
| `versions secret put` patches the **newest** version (`PATCH …/versions/latest` with the secret in `env`), tags it with `--tag` and `--message`, reads the value from stdin when stdin is not a terminal, and fails (10222) on a Worker with no version | wrangler source, `src/versions/secrets/put.ts` and `index.ts` | Runs right after viz-control's upload, once the newest version is checked to be that upload and to carry this run's `VIZ_DEPLOY_RUN`; the new version must then list the secret and carry this release's `VIZ_RELEASE` and this run's `VIZ_DEPLOY_RUN` (below); it is tagged with the release |
| `secret put` is refused (10214, 10215) while the newest version is not the deployed one, "to prevent accidental deployment when using Worker versions and secrets together"; on a Worker that does not exist it creates one whose code is `export default { fetch() {} }`, answering yes by itself in CI | wrangler source, `src/secret/index.ts` | Not used here. (`bootstrap.mjs` uses it on the gateway, which exists by then) |
| "secrets are never deleted by deployments"; wrangler uploads with `keep_bindings: ["secret_text", "secret_key"]`, which the API calls "binding types to keep from previous_upload"; an `inherit` binding's version "Defaults to "latest"" | [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/); [API: upload a version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/); wrangler source. **Measured on Cloudflare, 2026-11-19, S9**: an upload inherits the **newest** version's secrets, whatever made it, not the deployed version's | Once made, the key rides along on every later version and the deploy only checks it is there |
| The API lists "the names of secrets bound to a Worker script" (from which version is not said); a version's `resources.bindings` list secrets by name and type | [API: list secrets](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/list/); the version API. **Measured, S9**: the list names the **newest** version's secrets, not the serving one's | Presence is judged by name only, on versions: the one to be promoted, and, for the refusal below, the serving ones and every one newer. The secret list is not read (it adds nothing to that scan) |
| A version read straight after it is created is sometimes not there yet | **Measured, S9**: 2 of 16 such reads failed, a 404 and a version without the secret just put, both on a Worker about a minute old; later reads saw it after 193–368 ms | The upload (or the version just deployed) and the keyed version are read again, backing off from 250 ms, for up to 10 s (`VIZ_FRESH_READ_MS`) |
| The rollback documentation says nothing about secrets. wrangler's `rollback` handles an API error 10220 ("The following secrets have changed") by asking and retrying with `force`; `versions deploy`, which `release.mjs` rolls back with, has no `force` | [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/); wrangler source, `src/versions/rollback/index.ts`; `wrangler versions deploy --help`. **Measured, S9**: a rollback to a version **without** the key is allowed and serves without it until the next deploy; one to a version whose value **differs** (across a rotation) is refused with 10220 | Both refused by `release.mjs rollback` before any Worker moves ("Rollbacks across the key", below) |

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

**Never over one that exists.** If viz-control has the key now (a version serving now, or a
version newer than every serving one; a serving version that cannot be read stops the release) but
the version to be promoted does not carry it, the release is **refused, exit 3, before anything is promoted**, naming where it was
seen: a new value would invalidate every registered client, and since the credential tag (D44,
review M-2) every code and token too. The upload is read again, within the 10 s budget, until the
key it inherited shows, not only until the upload exists (review of D69, m-7: S9 saw a fresh
version shown for a read without a secret it carried). A version newer than the serving one is what
a rollback across the release that created the key leaves behind (review of D53, m-9): before, an
upload that then did not inherit the key was given a new one silently. **What lifts this refusal**
(review of D69, m-6): neither a rollback nor deploying again. The refused upload is now the newest
version, a rollback does not change which version is newest, and the next upload inherits from it,
so every later release is refused the same way. The exit the tool offers is replacing the key on
purpose (`VIZ_ROTATE_SECRETS=OAUTH_CLIENT_KEY`), which invalidates every registered client; one
that would keep the key, an upload that inherits the secret from the keyed version by id, is not
verified ("Known risks"). Reading the newer versions costs one list call and one read per newer
version (none normally; up to the 100 Cloudflare keeps). A put is also refused when the newest
version is not this release's upload (it would build on code that is not this release).

Why not the alternatives (D53): `wrangler secret put` before phase 1 deploys the serving code plus
the key outside any release record, is refused whenever an undeployed version is newest, and
creates a placeholder Worker on the first deploy; after phase 2 it is a second deployment (the
Tenant objects move twice, and the new release serves for a while without the key);
`--secrets-file` needs the value in a file; by hand, it is forgotten and the symptom is a quiet
503. **Would change if** control verifies under two keys (then rotation can overlap and be automatic,
and a rollback across one stops breaking clients); wrangler takes secrets on stdin for `versions
upload` (then code and key in one version); or `versions deploy` takes `force` (D53).

**Another run of the same release** (review of D53, m-11; D69). Every version a run uploads or
deploys carries `VIZ_DEPLOY_RUN`, a UUID made for that run (`--var`; prefixed with the GitHub run id
in CI), and the record names it (`run`). `versions secret put` patches whatever version is newest
when Cloudflare applies it, and the keyed version keeps that version's vars, so: before the put, the
newest version must be this run's upload and carry this run's mark (else exit 3, nothing put); after
it, the keyed version must carry this run's mark, or the key went on another run's upload (one that
uploaded between the check and the put) and nothing is promoted (exit 3). The tag and message cannot
do this: the put overwrites both. What it cannot do: stop the key from **landing** on the other
run's version (the PATCH has no condition). That version is never promoted by either run (the other
promotes its own upload, or refuses because its upload is no longer the newest), but as the newest
version it is what the next upload inherits from: if the refused run was rotating, that next upload
carries the rotated key and its record says `kept` ("Known risks").

**Rollbacks across the key** (measured on Cloudflare, 2026-11-19, spike S9; D53, D69).
`release.mjs rollback` reads the restored version of viz-control and every version newer than it,
and refuses, exit 3, before any Worker moves:

- **across the release that created the key** (the restored version lacks it, a newer one carries
  it): Cloudflare allows that rollback, and the restored version serves **without** the key until
  the next deploy: `/oauth/register` 503, no `registration_endpoint`, every registered client 400
  "not registered" at `/oauth/authorize`, and (from control's code, not measured) its codes and
  tokens refused. Done anyway with `--accept-secret-loss OAUTH_CLIENT_KEY`; the next deploy brings the
  key back (uploads inherit the newest version's). deploy.sh's automatic rollback never passes it.
- **across a rotation** (a newer version was made by the deploy's put of the key, read from its
  message `…; OAUTH_CLIENT_KEY rotated|created`): Cloudflare refuses that rollback (10220) and
  `versions deploy` cannot force it; before this check the tool rolled the callers back first and
  then failed at viz-control (exit 1, a mixed deployment no record names). Refused always. Fix
  forward; or restore the other Workers only (`release.mjs rollback --record … --only
  viz-publisher,viz-ingest,…`): viz-control keeps serving, a callee newer than its callers, and
  that rollback is judged like any other, with viz-control **as it serves** (review of D69, M-1):
  refused when a format version viz-control wrote or writes is one the restored Workers do not read
  (format versions, below), or when it leaves a Worker below a rollback floor. A forced rollback
  through the API would serve the old key only until the next release took the rotated one back
  while its record says `kept` (measured): `kept` compares names, not values.

A failed promotion (phase 2) leaves a viz-control whose key the release created or rotated on that
version, and puts back only the others.

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
`rotated`, and every registered client must register again. A failed smoke test does **not**
roll back: the rollback across the rotation is refused before anything moves (Cloudflare would
refuse it with 10220, measured in S9), so the rotated release keeps serving and the job fails. A name the deploy does not generate is
refused, exit 3, before anything is uploaded. The workflow has no input for this yet ("Needed
changes").

**Never shown.** The value exists in the deploy process's memory and in the pipe to wrangler's
stdin. It is not on a command line, in an environment variable, in a log (wrangler's output for
the put is not relayed, and is scrubbed before it can appear in an error), in a file, or in the
release record, which says `secrets: [{ worker, name, action, versionId }]`. **Wrangler's own
debug log**: wrangler 4.164.0 writes every log level, request bodies included, to a file under
`~/.config/.wrangler/logs/` (or `WRANGLER_LOG_PATH`) unless `WRANGLER_WRITE_LOGS` is false, and
redacts bodies only while `WRANGLER_LOG_SANITIZE` is true (its default); with sanitising off in
the deploy's environment the review of D53 (m-10) found the key's PATCH body in that file with
the real wrangler. `lib/wrangler.mjs` therefore runs every wrangler command that gets something on
stdin (this put, and `bootstrap.mjs`'s `secret put`) with `WRANGLER_LOG_SANITIZE=true` and
`WRANGLER_WRITE_LOGS=false` (`SECRET_RUN_ENV`), whatever the environment says; other commands keep
the environment's settings.

## Rate limits in front of OAuth (D70)

viz-control serves OAuth publicly only behind D70's first layer: six Cloudflare Rate Limiting
bindings (`control/README.md`, "Rate limits in front of OAuth (D70)"; the review of D70, M-2, found
"required before public exposure" enforced nowhere; done here 2026-11-26). `control/wrangler.jsonc`
declares them with placeholder ids; the limits are **modelled, not measured on real traffic**:

| Binding | Limit / 60 s, per Cloudflare location |
|---|---|
| `OAUTH_RL_SOURCE` | 120 |
| `OAUTH_RL_SOURCE_48` | 1,200 |
| `OAUTH_RL_CREDENTIAL` | 5 |
| `OAUTH_RL_TENANT` | 6,000 |
| `OAUTH_RL_BEARER` | 1,200 |
| `OAUTH_RL_BEARER_TENANT` | 30,000 |

`workers.json` gives viz-control an `oauth` block: the binding names and the period are read from
control's own source (`control/src/ratelimit.ts` `LIMITERS` and `RATE_PERIOD_S`, evaluated as schemas
are), so the deploy follows control if it adds one.

**What each check refuses** (all before anything is uploaded):

| Where | Refused |
|---|---|
| `configure.mjs`, any deployment | a `ratelimits` entry whose name is not in `LIMITERS`; one bound twice; a key other than `name`, `namespace_id`, `simple`; a limit that is not a positive integer; a period other than 60 (the Worker's `Retry-After` assumes it; the platform also allows 10); a missing id (`resources.mjs` not run) unless `--ids-optional`; a placeholder that survives; an id outside viz's range; two bindings of one deployment with one id; `ratelimits` on a Worker with no `oauth` block |
| `configure.mjs`, production | a viz-control without all six, naming the missing ones (exit 1: `deploy.sh` stops before the release); `--oauth-without-rate-limits` and `--oauth-public` (stage flags) |
| `configure.mjs`, a stage | the same, unless configured `--oauth-without-rate-limits` (`VIZ_OAUTH_WITHOUT_RATE_LIMITS=1` for `deploy.sh`): the bindings are dropped, and the manifest and release record say `oauthWithoutRateLimits: true` |
| `configure.mjs` | `placement` on viz-control or viz-mcp (`no_placement` in `workers.json`: per-location budgets assume each request is counted where it arrives; review of D70, m-8); `OAUTH_PUBLIC` set by a component config or `VIZ_STAGE_VARS` |
| `release.mjs deploy` and `plan` (exit 3) | a manifest configured `--ids-optional` (its ids are placeholders); creating or rotating `OAUTH_CLIENT_KEY` on a viz-control whose generated config lacks any of the bindings its manifest records as required, each with period 60, a positive limit and an allocated id, or binds one id twice, or whose manifest records no gate at all; a stage passes only when its manifest and viz-control both say `--oauth-without-rate-limits` |
| `lib/secrets.mjs` at the put | the same check again, just before `versions secret put` (defence in depth; a `SecretRefused`) |

A key that is already there is **kept** whatever the gate says (nothing is put): the gate decides
whether OAuth is turned on, and configure has already refused a production config without the
bindings.

**Namespace ids** (`resources.mjs ensure`, every deploy). A `namespace_id` "uniquely defines this rate
limiting namespace within your Cloudflare account" (the binding page, read 2026-11-19), and the
account holds unrelated Workers. Nothing is created on Cloudflare: a namespace exists only as bindings
name it. So:

1. **Read the account, read only.** List the scripts, and for each its deployment's serving versions
   and its newest version, and collect every binding of type `ratelimit` (`namespace_id`). One script
   list, then a deployment read, a version list and one to three version reads per script, four
   scripts at a time: about 110 GET calls for the 28 scripts the account had on 2026-11-26. The
   `ratelimit` type and `namespace_id` field are wrangler's upload shape (training knowledge): **not
   read from Cloudflare's version API**; the fakes assume it (the stage trial that settles it is
   prepared, not run). What cannot be read no longer stops every deploy (review of D69, round 2,
   m2-1), but **no id is ever taken that cannot be proven free**:
   - an id that is there but cannot be a decimal number (`"abc"`) can equal no viz id: ignored,
     with a WARNING line;
   - anything else (no id, a field this does not know, a binding type that names a rate limit in
     another shape, a script whose versions cannot be read): **in doubt**. Then only ids this
     deployment's own viz-control already binds are kept (they are in use already; nothing new is
     taken), with a WARNING; an id only recorded in `resources.json` is not kept, and any new id is
     refused, naming the script (exit 1 at `resources.mjs`, before configure). So an odd binding of an
     unrelated script refuses only a deployment's first allocation (a new stage; production's first
     release) until that script is fixed or gone;
   - viz-control's own binding unreadable (the shape risk on viz's side, review M2-2) is not a doubt:
     its ids come from `resources.json`, else the same deterministic pick, with a WARNING, so a
     fix-forward deploy is not stopped.
2. **Keep** the id this deployment's own viz-control already binds under that name (its serving
   version, else its newest), else the one recorded in `resources.json`, unless another script binds
   it: an id seen on a script whose name does not start with `viz-` is **refused** (logged, a new one
   taken, the counters reset), and so is one another viz deployment (production, another stage, a
   spike) binds or has recorded.
3. **Otherwise allocate** from viz's range, `workers.json` `resources.ratelimit_ids` (7000–7999): the
   lowest free id at or after a start that the deployed name picks (FNV-1a), wrapping. Allocation is
   deterministic for one account state, so a CI checkout, whose `resources.json` starts empty, gets
   the same ids every run; two stages allocated at once from different checkouts rarely pick alike.
4. Record them in `resources.json` `ratelimit_namespaces` under `<deployed worker>/<binding>`
   (`viz-control/OAUTH_RL_SOURCE`, `viz-trial-control/OAUTH_RL_SOURCE`). `destroy --stage` removes
   the stage's entries: nothing to delete on Cloudflare.

**`OAUTH_PUBLIC`.** Every production viz-control config that passes the gate gets the plain var
`OAUTH_PUBLIC=1`; a stage only with `--oauth-public` (`VIZ_OAUTH_PUBLIC=1`), which needs the bindings.
It is the switch of the rollback floor `oauth-public` ("Rollback floors"). The record's `oauth` says,
for viz-control, the bindings' ids, whether a stage left them out as asked, and whether `OAUTH_PUBLIC`
is set.

The gateway forwards each request unchanged (`forward` passes `req`), so `CF-Connecting-IP` reaches
viz-control, and it reads no `x-real-ip`: nothing changed there. Optional and by hand, outside the
deploy: a WAF rate-limiting rule on `vis.bitcru.sh` for the four `/oauth/` paths, above the Worker's
source limit, that leaves Cloudflare's Workers address alone (`control/README.md`).

## Class bindings across Workers (`binds_classes`)

A Durable Object binding to another Worker's class (by `script_name`) can call every method of
every object of that class, for any tenant. `configure.mjs` deploys one only where
`workers.json` lists it under the binding Worker's `binds_classes` as `<worker>:<class>`, with
why (review of D44, M-1). Today: viz-ingest → viz-publisher's `Publisher`, viz-query →
viz-ingest's `Shard` and `Ledger`, viz-ruler and viz-gateway → viz-control's `Tenant`. viz-mcp has
none: it binds viz-control's `OAuthIntrospection` entrypoint (`OAUTH`, with `props: { caller:
"viz-mcp" }`), which answers one question. A Worker that needs one answer from another binds a
named entrypoint that gives that answer; the existing entrypoint check makes sure the callee
exports it before the caller is deployed.

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
  "formats": { "viz-ruler": { "store.anomaly-state": { "writes": 1, "reads": [1, 2] }, "…": "…" }, "viz-ingest": { "r2.dead-letters": { "writes": 2, "reads": [1, 2] }, "kv.settings": { "writes": null, "reads": [1] }, "…": "…" }, "viz-gateway": {}, "…": "…" },
  "formatsComplete": true,
  "floors": [{ "name": "signal-data", "writer": "viz-ingest", "var": "INGEST_SIGNALS", "value": null, "on": false,
    "workers": [{ "worker": "viz-publisher", "atFloor": true, "servingAtFloor": true }, "…"] },
    { "name": "oauth-public", "writer": "viz-control", "var": "OAUTH_PUBLIC", "value": "1", "on": true,
    "workers": [{ "worker": "viz-control", "atFloor": true, "servingAtFloor": true }] }],
  "via": { "viz-ingest": "deploy", "viz-control": "versions", "...": "..." },
  "secrets": [{ "worker": "viz-control", "name": "OAUTH_CLIENT_KEY", "action": "kept", "versionId": "…" }],
  "run": "<the VIZ_DEPLOY_RUN of every version this run uploaded>",
  "oauth": [{ "worker": "viz-control", "ratelimits": { "OAUTH_RL_SOURCE": "7594", "…": "…" }, "withoutRateLimits": false, "public": true }],
  "oauthWithoutRateLimits": false,
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

**Format versions** (contracts/COMPATIBILITY.md §6; D69; review of D60, m-13; review of D69, M-1).
`workers.json` says, for **every** deployed Worker and **completely**, what its code writes and
reads: the `FORMATS` maps of its components (`"writes": ["ruler/src/schema.ts#FORMATS"]`), their read
lists (`"reads": ["janitor/src/formats.ts#READS"]`; `"reads_of": { "store.anomaly-state":
"ruler/src/schema.ts#ANOMALY_STATE_READS" }`, which also takes a reader's one-version constant such
as `edge/src/auth.ts#KEY_RECORD_VERSION` or `contracts/control.ts#CONTROL_SERVICE_VERSION`), and
the formats its code reads with no version of its own (`"reads_v1": { "kv.pool":
"edge/src/route.ts: …" }`, read as version 1 only, with where; "Needed changes in components" lists them). A
Worker that reads none says so (`"formats": {}`, the gateway); configure refuses a deployed Worker
without a `formats` block. A format a Worker does not list, it does not read. `lib/formats.mjs` reads
them from the sources as schemas are read, into the manifest, the record (`formatsComplete: true`)
and **every version's `VIZ_FORMATS` var** (`complete: true`, also when empty). Declared today
(read from the sources on 2026-11-19): viz-publisher (5 written), viz-ingest (flush, compact, janitor
and stack: 7 written, among them `r2.dead-letters` at 2, read at 1 and 2; and 4 of control's read
only: `kv.settings`, `kv.key`, `kv.pool`, the API key), viz-control (15 written), viz-query (4 read:
`kv.key`, `kv.pool`, `kv.settings`, the API key), viz-ruler (14 written, `store.anomaly-state` at the
gate `ANOMALY_STATE_WRITE`, 1 now, read at 1 and 2; 4 read: `kv.key`, the API key and control's two
RPC answers), viz-mcp (4 read: `kv.key`, the API key, `rpc.oauth`, `credential.oauth`), viz-gateway
(none). Two tests hold the declarations to the
code: a `FORMATS` map in a deployed component that is not declared fails one; the other bundles each
Worker's main as wrangler does (esbuild's list of inputs) and fails if its sources read one of
control's KV records (`` `key:${…}` ``, `pool:`, `limits:`/`retention:`, `revocation:`), parse the
API key or an OAuth credential, or call control's RPCs, without the Worker declaring that format. Rules:

- A Worker reads a format it writes at the version it writes, unless a read list says more; two read
  lists for one format intersect; a Worker that writes a version it does not read is refused at
  configure (§3.3 applied to the release itself). The publisher's `read.…` entries name formats the
  ledger writes, which no writer declares: not recorded.
- **What a release reads** of a format is what every Worker of it that reads the format reads, per
  Worker: a Worker that **declares nothing** (a version without `VIZ_FORMATS`, a record without its
  entry) is taken to read **version 1 of every format** (§3.1 "absent means 1"); a declaration from
  before they were complete (D69's: a var without `complete`, a record without `formatsComplete`),
  version 1 of every format it does not list; a complete one, exactly what it lists.
- **Forward-only** (kind `format`) when this release writes a version that not every Worker serving
  now reads, any Worker the deploy asked about (this release's and the others of `workers.json`),
  not only those declaring the format (review of D69, M-1 (c)). deploy.sh does not roll it back
  automatically, and a failed promotion does not put back a Worker it is forward-only for.
- **Rollback refusal**, judged against what the Workers the rollback **restores** read (their record
  entries; a record entry of a Worker left out is no reader):
  - any version newer than the target's, of a restored Worker that writes formats, wrote a version
    they do not read: the ruler's gate on, then a rollback below the release with the version 2
    reader, is refused, also after a rollback to that reader (everything that ran since the target
    is judged);
  - **a Worker the record leaves out** (a record without it, or `--only`) keeps serving, so what it
    wrote and writes stays under the restored ones (review of D69, M-1): every version Cloudflare
    keeps of each such Worker that writes formats is judged, those newer than its version in the
    record when the record names one (`--only` keeps it), all of them otherwise, and its serving
    version always. Before this, a record without viz-control (the way round the rotation refusal
    this README offered) put viz-ingest's janitor back to a `kv.settings` reader of version 1 while
    viz-control kept writing 2 (reproduced, RV-1);
  - a version that declares no formats, of a Worker that writes them, is refused as unknown. A
    Worker that writes none (viz-query, viz-mcp, viz-gateway) is judged only as a reader.
- **Old records** (no `formats`), a record's Worker without an entry, and formats an incomplete
  declaration does not list, are taken to read **version 1 only** (§6 Bootstrapping): the side that
  refuses more. **Except a release with a formats record** (`deploy/records/<sha>.formats.json`,
  made by `scripts/record-formats.mjs` from that commit's own sources: its `FORMATS` maps, `READS`
  lists and version constants, read through this tree's declarations): its record, and every version
  that declares nothing but carries its `VIZ_RELEASE` (or tag), read what the file says. Today one,
  fb77292, what production first served (review of D69, round 2, M2-1). What it costs today: viz-ingest writes `r2.dead-letters` 2, so the first release with
  format records over a deployment without them is forward-only, and a rollback to a record from
  before them across a viz-ingest upload is refused (tested). The same holds once more for this
  change: over a deployment whose viz-query, viz-mcp and viz-gateway versions declare nothing (all
  from before it), the first release with complete declarations is forward-only, and a rollback to a
  record from before it across a viz-ingest upload is refused. Nothing is in production, so only
  stages pay it.

**Rollback floors** (D64, D69; review of traces and logs, M-4; review of D69). `workers.json`
`rollback_floors`: once a version of viz-ingest whose `INGEST_SIGNALS` names anything has existed
(any name: a value edge does not know counts too; a JSON var counts, and so does a **secret** of that
name, whose value cannot be read: review of D69, m-2), span and log data may be in the deployment
whatever the switch says later, and each of these must stay at its floor. "Has existed" is read from
the versions Cloudflare keeps, the 100 newest of viz-ingest: once the switch-on version ages out of
them, it is no longer seen ("Known risks", m-1):

| Worker | Floor | Judged by | What an older one does with the data |
|---|---|---|---|
| viz-publisher | D64 | `publisher.Publisher` schema ≥ 4 (VIZ_SCHEMAS; pinned against the frozen releases `publisher/test/n1` (3, metric tables only) and `test/d64` (4, reads the three); D67's migration 5 is additive) | stops every tenant whose log names a span or log table, metrics included (stuck, not lost) |
| viz-query | D62 | `VIZ_FLOORS` stamp, given by configure only when `query/src/shards.ts` exports `checkSignal` and `signalOfShard` | reads every shard a plan names; a metrics read with no series filter (`{__name__=~"…"}`, cardinality, `/api/v1/status/tsdb`) is handed span and log batches whole and fails (M-4, reproduced by the reviewer) |
| viz-ingest | D63 | `VIZ_FLOORS` stamp, when `janitor/src/janitor.ts#DEFAULT_SIGNAL_DAYS` and `contracts/ledger.ts#TRACE_TABLES`, `#LOG_TABLES` exist | stalls span and log flush (`invalid_unit`, `encodeSegment` throwing on a span batch) and their retention (M-4, from the code) |

Refused, exit 3, before anything is uploaded or moved:

- a release that **sets the switch** unless each of the three is at its floor **in this release and
  as it serves now**. "Every release a rollback could reach" is read as: the serving release (what
  deploy.sh's automatic rollback and phase 2's restore put back without asking) and this one; every
  older release is reached only through `release.mjs rollback`, which refuses a Worker below its
  floor from the moment this release's viz-ingest is uploaded (an uploaded version counts, as for
  schemas). Requiring every version Cloudflare keeps to be at the floor would hold the switch off
  for about 100 releases. A floor Worker this release does not deploy (`deploy: false`, or left out
  of the manifest) is judged **as it serves**: it would read what the switch lets in (review of D69,
  m-3; before, it was not judged at all). One that does not exist in the deployment has no floor
  there. This applies to **every** release with the switch on, not only the one that turns it on;
- a release with one of its own Workers **below its floor while any viz-ingest version Cloudflare
  keeps set the switch** (redeploying older code; turning the switch off leaves the data). The
  history is read (one list, then reads until one with the switch) only when a Worker is below its
  floor, never normally;
- a release while viz-ingest's serving or newest version carries `INGEST_SIGNALS` **as a secret**
  (`wrangler secret put` is a natural way to turn it on without a commit): every upload inherits the
  newest version's secrets, so the switch would be on whatever the release's config says, and its
  value cannot be read. Remove the secret and set the switch as a var in a release. Checking costs
  one list and a read or two per deploy (review of D69, m-2);
- a **rollback**, of the whole release or of any Workers a record names (the others are judged as
  they serve, also one put below its floor by hand), that would leave one below its floor while any
  kept viz-ingest version set the switch.

**One floor Worker off its floor, with the switch on** (review of D69, m-8): since every release
with the switch on judges the serving floor Workers, a viz-query (say) left below its floor as it
serves (a gradual deployment started by hand, a `wrangler rollback`, the dashboard) refuses every
release, each push to main included. The way out keeps the switch on: restore that Worker alone, from
a record in which it is at its floor: the workflow with `rollback_to` and `rollback_only: viz-query`,
or `node deploy/release.mjs rollback --record <release.json> --only viz-query` (judged like any
rollback; the others keep what serves), or deploy a stamped
version of it at 100% by hand (`wrangler versions deploy <version>@100% --name viz-query`). Turning
the switch off in a release is not needed. **Never rename a rule** in `workers.json`: every version
is stamped with the rule's name, so a renamed rule finds every serving version below its floor and
refuses the same way; add a rule instead.

Allowed: every rollback that keeps each at its floor, among them to the release just before the
switch (the switch goes off, the data stays readable) and viz-publisher from D67 to D64. The record's
`floors` says what each floor saw. A stamp needs a release with this check to have served before the
switch can go on (fail closed: an unstamped version is below the floor).

**The review's m-5 (of traces and logs): D64 must ship as its own release for the D67 → D64 rollback to exist.** The floor is "schema 4
or later", whatever served. The tool cannot make D64 ship alone: it deploys the commit it is given,
and D64 and D67 are on the same branch now. If they reach a deployment in one release, no publisher
at exactly 4 ever serves there, the oldest publisher a rollback can reach once the switch is on is
the first with D67, and the D67 → D64 rollback that `publisher/test/signals.test.ts` shows does not
exist there; nothing is lost by that. To have it, deploy a commit with D64 and without D67 first.

**The second rule, `oauth-public`** (D69, point 6; second review of D70, m-3; added 2026-11-26).
Once OAuth is public, rolling viz-control back to `3cbabb8` or earlier (PR #8, what production first
served, among them) would mint credentials without an expiry the Worker can see and bring B-1 back;
to a release with D70's second round but not its third, R3-B1. The switch is `OAUTH_PUBLIC` on
viz-control, which configure sets on every production viz-control ("Rate limits in front of OAuth").
viz-control is both the writer and the one floor Worker:

| Worker | Floor | Judged by | What an older one does |
|---|---|---|---|
| viz-control | D70, third round | `VIZ_FLOORS` stamp, given by configure only when `contracts/oauth.ts` exports `CREDENTIAL_LAYOUT` and `DEAD_INACTIVE_REASONS`, `control/src/deadlist.ts` `recordDead` and `control/src/ratelimit.ts` `LISTED` | mints credentials the Worker can never refuse as expired (B-1), lets one dead credential spend a tenant's fuse after a limiter fault (R2-M1) or a stock of refresh tokens trip it for 30 days (R2-M2), or lets a thief stop reuse detection (R3-B1) |

It is judged as `signal-data` is, with one difference (`"serving_below_floor": "forward-only"` on the
rule): a release that sets `OAUTH_PUBLIC` while the viz-control **it replaces** serves below the floor
is not refused but goes out **forward-only** for viz-control (kind `floor` in `forwardOnlyBecause`):
`deploy.sh` does not roll it back automatically, and a failed promotion does not put that viz-control
back. Refusing, as `signal-data` does, would strand production: configure sets the switch on every
production release, so the "release it at its floor without the switch first" remedy does not exist,
and production's viz-control, deployed on 2026-11-19 by fb77292's tooling, is unstamped ("The first
release over the 2026-11-19 production"). From the moment this release's viz-control is uploaded,
`release.mjs rollback` refuses that older viz-control as any rollback below a floor. Everything else is
as for `signal-data`: once a kept viz-control version had the switch, a release or a rollback that
leaves viz-control below its floor is refused (exit 3), and so is a release while `OAUTH_PUBLIC` is a
secret on viz-control. **Never rename the rule.**

`previous.json` is the same shape, captured from Cloudflare just before phase 1: what an
automatic rollback restores. Every version is also tagged with the release SHA on
Cloudflare (`workers/tag`), which is how a later deploy finds the release serving now.

## Rollback

**By hand**: Actions → Deploy → Run workflow on `main`, `rollback_to` = the full SHA of a commit
whose deploy run succeeded (and `rollback_only`, to restore only some of its Workers). The job
downloads that run's release record and runs `release.mjs rollback`: every Worker back to its recorded version id, callers first (viz-gateway,
viz-query, viz-control, viz-ingest), then the smoke test. Locally:
`node deploy/release.mjs rollback --record <release.json> [--stage S] [--only viz-query,…]`;
`--only` restores just the Workers it names (production or deployed names; an unknown one is
refused), and every other Worker keeps what serves now and is judged as it serves, exactly as for a
record with fewer Workers. Run a local rollback only while no deploy runs: CI serialises its own runs
in `deploy-production`, but a laptop is outside that group, and the checks and the restore are not
atomic against a deploy that turns `INGEST_SIGNALS` on in between ("Known risks", m-4).

It refuses, changing nothing (exit 3), when a recorded version no longer exists (Cloudflare keeps
100), when any Worker's Durable Object migration tag in force differs from the recorded one, when
storage a newer version wrote cannot be opened by the target (schema versions, above), when a
format version that a newer version of a restored Worker wrote, or that a Worker it leaves serving
wrote or writes, cannot be read by the Workers it restores (format versions, above), when it would
leave a Worker below its rollback floor after `INGEST_SIGNALS` was on (above), or when it crosses
the creation (unless `--accept-secret-loss OAUTH_CLIENT_KEY`) or a rotation of viz-control's OAuth
key ("Rollbacks across the key").
Cloudflare refuses the same thing itself (measured in the trial: `versions deploy` of a
pre-migration version answers code 10210, "the version depends on Durable Object migration
"v1", but the current deployment is using migration "v2""); the tool's check says why before
anything is attempted, and also covers Workers rolled back as a set.
**Migrations are forward-only**: once a release has applied migration `v2` to a class,
Cloudflare will not run code from before it on that class's objects, and their storage may
already be in the new shape; no version from before the migration can serve again. A bad
release that applied a migration is repaired by a new commit (fix forward), never by a
rollback. `contracts/COMPATIBILITY.md` §6 extends this to schema versions inside SQLite, which
this tool checks too (above), and to wire formats, which it checks since D69 (above).

**Automatically**: when the smoke test fails after a deploy that applied no migration and is
not forward-only, `deploy.sh` restores `previous.json` (through `release.mjs rollback`, so every
refusal above applies), checks health again, and fails the job. When the release applied a
migration, or is forward-only for a schema or a format, it does not roll back; it fails with an
error naming the migrations, classes or formats and the instruction to fix forward.

**Older code, without a record** (the record's artifact expired after 90 days, or its versions
aged out of the 100 Cloudflare keeps): restore the code in a **new commit on main** (`git revert`,
or check out the components' directories from the older commit) and let it deploy. Main's tooling
then builds new versions of the old code and judges them like any release: the migration gate
(refused if the old config lacks a migration that is now applied), the rollback floors (a viz-query
from before D62 is refused once `INGEST_SIGNALS` has been on; and configure refuses a floor's
evidence the old code does not have, until `workers.json` says otherwise in the same commit), the
format versions and the OAuth key. **Never run the Deploy workflow on an older commit, or that
commit's `deploy.sh`** (review of D69, M-2): either runs that commit's own tooling, and a commit from
before D69 judges none of these (the review deployed a viz-query from before D62 over span and log
data that way, with `b322599`'s tooling). The workflow refuses any ref but main as the first step of
both jobs that hold the Cloudflare credentials; an older commit's own workflow has no such step,
which is why the `production` environment allows deployments from main only ("One-time setup").
`deploy.sh` run by hand from an older checkout cannot be stopped from here: do not.

A rollback restores versions: code, bindings and vars, and the secrets each version carries (a
version from before viz-control's generated key has none, which is why such a rollback is refused
unless accepted). It does not restore routes, crons or queue consumers (not versioned), nor data.

## When a deploy fails

| Where | What is left serving | What to do |
|---|---|---|
| Refused (exit 3): unacknowledged migration | the previous release, untouched | add the trailer or the dispatch input, if the migration is intended |
| Refused (exit 3): a rollback floor, the switch about to go on (`INGEST_SIGNALS` set while a floor Worker in this release, or serving, is below its floor) | the previous release, untouched | release the Workers at their floors without the switch first, let them serve, then set it ("Rollback floors") |
| Refused (exit 3): a rollback floor with the switch already on in the serving release (a floor Worker off its floor as it serves: a gradual deployment or a `wrangler rollback` by hand) | the previous release, untouched; every later release is refused the same way | restore that Worker alone: the workflow with `rollback_to` and `rollback_only: viz-query`, or `release.mjs rollback --record <a record where it is at its floor> --only viz-query` ("Rollback floors", m-8); turning the switch off is not needed |
| Refused (exit 3): a floor Worker of this release below its floor after the switch was on, or `INGEST_SIGNALS` (or `OAUTH_PUBLIC`) a secret on its writer | the previous release, untouched | deploy that Worker at or above its floor; remove the secret and set the switch as a var |
| configure.mjs failed (exit 1, before the release): a viz-control without its six rate limits, a bad limit, period or id, `placement` on viz-control or viz-mcp, `OAUTH_PUBLIC` set by a component | the previous release, untouched | fix `control/wrangler.jsonc` (or the component); for a missing id run `resources.mjs ensure` ("Rate limits in front of OAuth") |
| Refused (exit 3): the key would be created or rotated on a viz-control without its rate limits, or the manifest was configured `--ids-optional` | the previous release, untouched | configure again without `--ids-optional`, after `resources.mjs ensure`; a stage that is to run without the rate limits: `--oauth-without-rate-limits` |
| Stopped (exit 1) before anything changed: a serving viz-control version could not be read, so whether its key is set is unknown | the previous release, untouched | deploy again (S9 saw such reads fail for a moment) |
| Phase 1 (upload) | the previous release, untouched (uploaded versions serve nothing) | fix the build |
| Phase 1, generated secret: refused (exit 3: set now but missing from the upload after the 10 s re-read, the newest version is not this run's upload, or the key went on another run's upload) or the put failed (exit 1, also when the new version did not show within 10 s) | the previous release, untouched | read the reason; another run: let it finish, then deploy again. "Set but missing" is not lifted by a rollback or a new deploy: only by rotating, which invalidates every registered client ("Known risks"); never rotate to make it pass unless that is accepted ("Worker secrets the deploy generates") |
| Phase 2, a new (or migrating) viz-control's key could not be put, or one of the three key refusals above on it (exit 1, not 3: logged "REFUSED in phase 2, after promotion began") | the Workers before it promoted; viz-control serving its `wrangler deploy` version without the key (`/oauth/register` 503); nothing after it promoted; with a migration applied, nothing rolled back | deploy again: the next release puts the key on its upload, or inherits it from the newest version |
| Phase 2, before any migration was applied | Workers promoted so far are put back automatically, except one the release is forward-only for (then nothing is put back) and a viz-control whose key the release created or rotated (it stays) | read the wrangler error in the log |
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

0. **Rate limits need no Cloudflare resource, only ids.** viz-control's six Rate Limiting bindings
   (D70) take namespace ids that `resources.mjs ensure` allocates from 7000–7999 on every deploy,
   after reading which ids the account's scripts bind (read only; "Rate limits in front of OAuth").
   Nothing is created and there is nothing to set by hand; reading other scripts' versions needs no
   permission beyond Workers Scripts edit (training knowledge: edit includes read; not checked on
   the account). The only resource-like choice is the range, in
   `workers.json` `resources.ratelimit_ids`; if a script that is not viz's ever binds an id in it, the
   next deploy moves viz off it (logged).
1. **Before this tree is merged to main**, set the `production` environment's rule below (main only,
   with the two Cloudflare secrets as its own): main's workflow until then (fb77292's) has no
   main-only step (review of D69, round 2, m2-4).
   **Repository secrets** (Settings → Secrets and variables → Actions):
   `CLOUDFLARE_API_TOKEN` (Workers Scripts edit, Workers R2 Storage edit, Workers KV edit,
   Queues edit, and Workers custom domains on the bitcru.sh zone; no DNS permission is
   needed) and `CLOUDFLARE_ACCOUNT_ID`. The workflow uses the GitHub environment
   `production`, which GitHub creates on first use; add protection rules to it if a person
   should approve each deploy.
   **Required: the `production` environment deploys from `main` only** (Settings → Environments →
   production → Deployment branches and tags → Selected branches: `main`), and the two Cloudflare
   secrets are that environment's secrets rather than the repository's. The workflow's own first
   step refuses any other ref, but an older commit's workflow has no such step: without the rule, a
   run of the Deploy workflow on an older branch would get the credentials and run that commit's
   tooling, which may predate the release-safety checks (D69; review of D69, M-2). Nothing in the
   repository can check this setting.
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

## The first release over the 2026-11-19 production

The owner deployed production on 2026-11-19 from main at fb77292 (PR #8) with that commit's own
tooling, which predates D69: `vis.bitcru.sh/healthz` reports that release, viz-control has
`OAUTH_CLIENT_KEY` and advertises `/oauth/register`, with no Rate Limiting bindings. Its versions carry
`VIZ_SCHEMAS` but no `VIZ_FORMATS`, `VIZ_FLOORS` or `VIZ_DEPLOY_RUN`, its record has schemas and no
formats, and viz-control has no `OAUTH_PUBLIC`. The first release of this tree goes over that.

**How it was checked.** `test/upgrade-production.test.mjs`, against the fakes, not Cloudflare. The
fake account holds production as fb77292's tool leaves it: every Worker's vars exactly as fb77292's
own `configure.mjs` generates them for production (run on a `git archive` of fb77292 in a scratch
directory on 2026-11-26; `test/fixtures/production-fb77292.json`), each Worker created by `wrangler
deploy`, viz-control's key put and deployed, the gateway's bootstrap secret put and deleted, and two
scripts of the account that are not viz's, plus a viz spike, binding Rate Limiting ids where viz would
otherwise take its first two. What versions Cloudflare keeps is **modelled** from fb77292's
`release.mjs` and `bootstrap.mjs`, not read from the account. Then the real `resources.mjs`
(rate-limit ids), `configure.mjs` (production, this tree's component configs) and `release.mjs` (plan,
deploy, rollback), twice. What it shows, step by step:

| Step | Result |
|---|---|
| Durable Object migrations | **none**: the newest tags are fb77292's (viz-publisher v1, viz-ingest v1, viz-control v1, viz-query v1, viz-ruler v2), so nothing to acknowledge; every Worker is uploaded, then promoted |
| Schemas | additive only: `publisher.Publisher` 3 → 7 and `shard.Shard` 1 → 3, both readable from 1; `ledger.Ledger` 3/2, `control.Tenant` 3/1 and the ruler's three unchanged |
| `resources.mjs ensure` | six ids for `viz-control/OAUTH_RL_*`, none bound by the unrelated scripts or the spike; only GET calls |
| `configure.mjs` | **the gate passes** with the six bindings and their ids; viz-control gets `OAUTH_PUBLIC=1` and is stamped `oauth-public` |
| Format versions | fb77292's Workers declare none, so their reads come from `deploy/records/fb7729280d79f41e4f9fa40be1867c0fd2491352.formats.json`, made from fb77292's own sources (review of D69, round 2, M2-1): every format version this tree writes is one fb77292 reads (its ingest already wrote `r2.dead-letters` 2 and read 1 and 2) |
| `release.mjs plan` | not refused; the key `set (serving version …); kept`; **FORWARD-ONLY** once: `oauth-public` (the serving viz-control is below the floor), and by nothing else |
| `release.mjs deploy` | exit 0; **the key is kept** (no put; the same value serves, so every registered client stays registered); viz-control serves with the six bindings and `OAUTH_PUBLIC`; the record says `forwardOnly: true` (viz-control, kind `floor`), `oauth-public` on, viz-control at the floor, serving one not |
| Automatic rollback | **not attempted**: `deploy.sh`'s own forward-only expression, run on the record, gives `viz-control below the oauth-public floor before it` |
| A failed promotion | puts back what it promoted before viz-control (viz-publisher, viz-ingest), and nothing once viz-control is promoted |
| Rollback of the whole release, to `previous.json` or to fb77292's record | **refused**, nothing moved, by one problem: `viz-control … below its floor … set OAUTH_PUBLIC=1` |
| Rollback of one Worker (`--only`, the workflow's `rollback_only`), to either record | **allowed** for viz-publisher, viz-ingest, viz-query, viz-ruler, viz-mcp and viz-gateway, each alone, the others left as they serve; **refused** for viz-control (its floor). Several of the six together are judged the same way (each by its schemas, formats and floors, the others as they serve) |
| The next release | ids kept (bound by viz-control); not forward-only; viz-control at its floor here and serving; the key kept; a rollback to the first release is allowed |

Before this change's forward-only option, the same run is **refused at the plan** (exit 3: "this
release sets OAUTH_PUBLIC=1, and the viz-control serving now is below its floor"), and every later
release with it: production could not have taken any release of this tree. That is the mutant
"oauth-public: workers.json no longer says forward-only", which the test kills. Before fb77292's
formats record (round 2 of the review of D69, M2-1, RV2-1), the release was also forward-only for
viz-ingest, and every rollback to fb77292, `--only` any Worker included, was refused by
`r2.dead-letters`, which fb77292's ingest itself writes at 2 and reads at 1 and 2.

**What the owner must know or do before merging this to main:**

0. **First: the `production` environment must allow `main` only, and hold the two Cloudflare
   secrets** (one-time setup, 1), before this tree is merged. fb77292's workflow, which is main's
   until then, has no main-only step, so until the rule is set a dispatch on another ref runs that
   ref's own tooling; and from this release on, an older commit's tooling would not judge the
   `oauth-public` floor or the gate either. Nothing in the repository can check the setting.
1. **It is forward-only, for viz-control only.** If its smoke test fails, `deploy.sh` does not roll
   back: the job fails, the new release keeps serving. A rollback of the whole release, or of
   viz-control, to fb77292 is refused (viz-control's floor: fb77292's viz-control mints credentials
   without an expiry and has none of D70's fixes). **Every other Worker can go back alone**:
   `rollback_to: fb7729280d79f41e4f9fa40be1867c0fd2491352` with `rollback_only: viz-query` (or
   viz-gateway, viz-mcp, viz-ruler, viz-ingest, viz-publisher; locally `release.mjs rollback --record
   <its release.json, or previous.json> --only viz-query`). The workflow finds fb77292's record only
   if fb77292's deploy run uploaded its `release-<sha>` artifact (90 days); `previous.json` of the
   first release is in that release's artifact. Nothing else in the path refuses: no migration to
   acknowledge (no `acknowledge_migrations`, no `Migration:` trailer), no secret to set, nothing to
   create.
2. **OAuth's key is kept.** Codes and tokens fb77292's viz-control issued (layout 1, no expiry the
   Worker can see) keep working until they expire at their objects; new ones carry their expiry.
3. **The rate-limit ids** come from the real account at that deploy, through the GETs above. The
   binding shape the scan reads (`type: ratelimit`, `namespace_id`) is training knowledge. This is a
   first allocation: if any other script shows a rate-limit binding whose id cannot be read,
   `resources.mjs` refuses to allocate (it cannot prove an id free), names the script, and nothing is
   deployed; if one shows under an unrelated type name, a collision with an unrelated script would go
   unseen ("Known risks").
4. **Not yet run on Cloudflare** (review of D69, round 2, M2-2): whether Cloudflare accepts the six
   bindings at upload, and the field names its version API lists them under. The stage trial that
   settles both, `spikes/s13-upgrade-trial/`, is prepared and not run.
5. After it, every production release carries the six bindings and `OAUTH_PUBLIC`, and viz-control
   cannot go back below D70's third round.

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

- **The review of D69, round 2, its findings fixed (2026-11-26)** (`design/reviews/d69-deploy-safety-r2.md`,
  approve with changes: 2 majors, 4 minors). Nothing deployed; the Cloudflare API only read (an
  inventory). **M2-1**: `deploy/records/fb77292….formats.json` from fb77292's own sources
  (`scripts/record-formats.mjs`; the same maps as an independent run of this tree's reader over a
  `git archive` of fb77292). The review's RV2-1 is now a test that passes for viz-query, viz-gateway,
  viz-mcp, viz-ruler, viz-ingest and viz-publisher (`--only`, to fb77292's record and to
  `previous.json`) and still refuses viz-control, by its floor alone; the upgrade test now expects the
  first release forward-only by `oauth-public` only, and a whole rollback refused by that one problem;
  a unit test holds the file and its lookup (by record, by `VIZ_RELEASE`, by tag). **m2-1**: the scan
  reports what it cannot read; tests for an id that cannot be a number (ignored), a missing id and an
  unreadable script (a first allocation refused, naming it; nothing recorded), ids viz-control already
  binds kept in doubt, a recorded-only id not kept in doubt, viz-control's own unreadable binding (not a
  doubt), and the review's RV2-4 end to end against the fake account. **m2-2**: COMPATIBILITY §6 states
  the forward-only option. **m2-3**: `contracts/oauth.ts` and D70 say about 1 in 11,600 (checked:
  1/62 × 79,200 / 62^4 minutes, 1 in 11,567 by 2026-12-26) and that production issued layout 1.
  **m2-4**: one-time setup and the owner notes put the environment rule first. **M2-2**: the stage
  trial `spikes/s13-upgrade-trial/` is prepared and **not run** (the session's permission check
  refused deploying to Cloudflare).

  Mutants (scratch copy, at most 2 workers): **9 of 9 new killed** (M2-1 4: the record not used for a
  target, nor for a version, a version known by its tag only, the record's ingest reading 1 only; m2-1
  5: new ids taken in doubt, a recorded id kept in doubt, a non-numeric id a doubt, viz-control's own a
  doubt, an unreadable script stopping the scan). Suites (`cd deploy`): `npx tsc --noEmit` clean; `npx
  vitest run --maxWorkers=2` 183 of 183; `node --test --test-concurrency=2 'test/*.test.mjs'` **135 of
  135** (4 new: RV2-1, the formats record, m2-1's two); `bash -n deploy.sh` clean; `control` and `mcp`
  `npx tsc --noEmit` clean (the contract comment).

- **D70's gate, the rate-limit ids, the `oauth-public` floor and `/api/echo` (2026-11-26).** Nothing
  deployed; the Cloudflare API not called. New tests: `test/configure.test.mjs` 9 (the gate's six
  bindings and period read from control's source and declared by `control/wrangler.jsonc`;
  production with all six passes, ids replaced, `OAUTH_PUBLIC` set, stamped; production without the
  block refused naming all six, each one of the six removed in turn refused naming it, and the
  command's exit 1 without ids; period 10, limits 0, −5, 1.5 and "5", an unknown name, a binding
  twice, an unknown key, an id `"0"`, one outside the range and two bindings with one id refused; a
  stage without them only with `--oauth-without-rate-limits`, recorded, refused for production and
  with `--oauth-public`; `OAUTH_PUBLIC` from a component or `VIZ_STAGE_VARS` refused; `placement`
  refused on viz-control and viz-mcp, in production and a stage, viz-query's kept; `kv.oauth-dead` 1
  declared for viz-control only; the rule parses with its four exports, a missing one refused);
  `test/resources.test.mjs` 6 (allocation excludes every id an unrelated script binds, even in
  viz's range; refuses to reuse a recorded or own id an unrelated script binds; production and two
  stages, recorded or bound, never collide, a spike's ids excluded; production keeps its own ids;
  deterministic; out of range not kept; range exhausted; the scan reads serving and newest versions,
  GET only, skips Durable Object namespace ids, refuses an unreadable id or an unknown rate-limit
  type; `ensure` against the fake account records, reuses and `destroy` frees a stage's ids);
  `test/oauth-gate.test.mjs` 9 (end to end: the key refused on production without the bindings, one
  missing, all missing, no gate record, on rotation, and in `plan`, nothing uploaded; created with
  all six; a stage refused without the flag or with it on only one side, passed with both and
  recorded; production ignores it; an `--ids-optional` manifest refused; the put itself refuses;
  `OAUTH_PUBLIC` over an unstamped viz-control forward-only and its rollback refused; over a
  stamped one ordinary; once seen, an unstamped viz-control refused as a release and as a rollback;
  `signal-data` still refuses); `test/upgrade-production.test.mjs` 1 ("The first release over the
  2026-11-19 production"). The existing fixtures of `secrets`, `review-d69` and `release-checks`
  now carry what configure writes since the gate (viz-control's bindings and stamp; the
  `oauth-public` floor in the record), and one lag count in `secrets` rose by one read (the new
  rule's look for a secret switch). Gateway: `/api/echo` routed, `GET` with its key reaching query
  exactly as sent, and `/api/echo/`, `/api/echox`, `/api/echo/x`, `/api/v2/echo` 404.

  **Counterfactual.** With `serving_below_floor` removed from `workers.json` (a scratch copy), the
  upgrade test fails at the plan: "this release sets OAUTH_PUBLIC=1, and the viz-control serving now
  is below its floor" (exit 3), which is what the rule as `control/README.md` first wrote it would do
  to production.

  **control** (`control/wrangler.jsonc` gained the block): `npx tsc --noEmit` clean. The block made
  control's test plugin bind the production limits in every control test, and 22 unrelated tests
  failed; control's builder made `control/vitest.config.ts` hand the plugin a copy of the config
  without `ratelimits` (reported by the coordinator; control passes 222 of 222 since its round 3).
  My own run of control's suite in a scratch copy (0fe7684, already with that workaround) gave 220 of
  221, the one failure (`ratelimit-review-r2.test.ts`, "the list is shared …") the same with the
  committed `wrangler.jsonc`, 2 runs of 2: round 3 in progress then, not this change.

  **Mutants**, in scratch copies of the tree (no git; node_modules linked; the copy now also needs
  `engine/wasm/js` and `engine/wasm-query/js`, which the bundling test resolves), at most 2 test
  workers. `mutants-release.mjs` now runs `oauth-gate`, `resources` and `upgrade-production` too, and
  takes `re:<pattern>` to choose mutants; `mutants-secrets.mjs` runs `oauth-gate` too.
  - **Release, the 30 new** (the gate 10, `OAUTH_PUBLIC` 3, placement 2, one across Workers, the
    floor 5, `deploy.sh` 1, `--ids-optional` 1, ids 7): first run **27 of 30 killed**. *Two bindings
    of one deployment with one id, across Workers* survived: unreachable, since only a Worker with an
    `oauth` block may carry `ratelimits` and only viz-control has one; the check and the mutant were
    removed. *Another deployment's recorded ids are not excluded* survived: the test recorded ids
    stage a1 would never pick; it now records exactly the ids a1 would take first. *An id a script
    that is not viz's binds is not excluded* did not apply (its pattern assumed a line break). On a
    fresh copy of the final tree, both remaining ones: **2 of 2 killed**. So 29 of 29 in the end.
  - **Release, the 60 older ones**, on a copy of the final tree: **59 of 60 killed**, one not applied
    (*the switch goes on while a Worker serving now is below its floor*: its line now carries the
    forward-only condition); rewritten, **1 of 1 killed**. So 60 of 60.
  - **Secrets, all 46** (8 new for the gate): **44 of 46 killed**, every new one among them. Two
    older patterns did not apply (lines this change extended: the refusal list, and the `gate`
    argument): rewritten, and on a fresh copy **2 of 2 killed**.
  - **Gateway, all 30** (2 new: `/api/echo` not routed, and matched as a prefix): **30 of 30 killed**.

  Each kill is a named test failing; the lists with the test that killed each are in the scripts'
  output. **Suites at the end** (`cd deploy`): `npx tsc --noEmit` clean; `npx vitest run
  --maxWorkers=2` **183 of 183** (5 more: `/api/echo` routed, its GET test, and four near misses in
  place of `/api/echo` as a 404); `node --test --test-concurrency=2 'test/*.test.mjs'` **131 of 131**
  (106 before: 25 new); `bash -n deploy.sh` clean (shellcheck not installed here). `cd control && npx
  tsc --noEmit` clean.

- **The review of D69, its findings fixed (2026-11-19)** (`design/reviews/d69-deploy-safety.md`,
  approve with changes: 2 majors, 9 minors). Nothing deployed; the Cloudflare API not called. The
  review's two fake extensions are now the tree's: `keep` (Cloudflare keeps only the n newest
  versions, never a serving one) and `uploadSecretLag` (an upload shown without the secret it
  inherited for its first n reads); `test/fake-account.mjs` also shows a non-string var as a JSON var.

  | Finding | Disposition | Evidence |
  |---|---|---|
  | M-1 (a, b): format rollbacks judged only the Workers the record names | **Fixed.** The restored Workers are the only readers under the target (a record entry of a Worker left out is no reader); every kept version of each Worker that writes formats and is left out (since its version in the record, all when the record does not name it, its serving one always) is judged against them. `--only` (and the workflow's `rollback_only`) restores some Workers of a whole record. The rotation refusal and this README no longer offer a bare record without viz-control; they offer `--only`, judged | RV-1a, RV-1b, and a left-out viz-control rolled back since (its newer kept version counts); unit tests of the rule |
  | M-1 (c): undeclared readers never counted | **Fixed.** Every deployed Worker declares, completely, what it reads (configure refuses one without a `formats` block); one that declares nothing reads version 1 of every format, per Worker; D69's declarations (no `complete`) read version 1 of what they do not list. Forward-only asks every serving Worker. Components declare where they had a constant (edge's `KEY_RECORD_VERSION`, contracts' `CONTROL_SERVICE_VERSION` and `OAUTH_VERSION`); elsewhere `workers.json` declares version 1 for them (`reads_v1`), listed under "Needed changes in components" | M-1 (c) end to end (a viz-query that declares nothing: the release writing `kv.settings` 2 forward-only, the rollback refused); configure tests: every Worker declares; each Worker's bundled sources (esbuild's inputs from its main) against the declarations, for control's KV records, the API key and OAuth credential layouts and control's RPC answers |
  | M-2: an older commit's own tooling ran | **Fixed** (decision in D69, point 5): only main is deployed, with main's tooling. Both jobs with the credentials refuse any other ref first; the `production` environment allows main only (one-time setup, a setting); older code goes out again as a commit on main | `test/workflow.test.mjs`: the gate is the first step of both jobs and refuses `refs/heads/rv-b322599` (the review's RV-3), a `claude/…` branch and a tag; no checkout of another ref; no advice to run an older commit; and the release `b322599` makes is refused by main's tooling once the switch was on |
  | m-1: the switch's evidence ages out of the 100 kept versions | **Known risk**, not fixed (the review's scenario and remedy under "Known risks"); the text now says "among the kept versions" | RV-4 not ported (it reproduces the risk) |
  | m-2: a secret or JSON `INGEST_SIGNALS` unseen | **Fixed.** A binding of any type with the switch's name counts (a secret as on); a release is refused while viz-ingest's serving or newest version carries it as a secret | RV-5 (rollback refused, the next release refused, nothing uploaded); a JSON var seen |
  | m-3: a floor Worker outside the release not judged at switch-on | **Fixed.** Judged as it serves | RV-6: refused, nothing uploaded |
  | m-4: check, then act against a concurrent deploy | **Known risk**, not fixed; documented (local rollbacks must not overlap a deploy) | RV-10 not ported |
  | m-5: the run-mark refusal on the `wrangler deploy` path is exit 1 with Workers promoted | **Text and messages made true**: that path cannot refuse before promotion (viz-control has no version before phase 2). D69 point 3, `deploy.sh` and the failure table say exit 3 in phase 1 and exit 1 in phase 2; the messages say what serves, and the log says "REFUSED in phase 2, after promotion began (exit 1)" | RV-7: exit 1, the message names what serves and no longer says "Nothing is promoted" |
  | m-6: "set but missing from the upload" has no non-destructive exit | **Known risk**, documented with the review's scenario; the README's remedy (rollback or redeploy) corrected, and the refusal says neither lifts it | RV-8 now pins the message (k3 still refused) |
  | m-7: re-read waits for existence; `fetch` has no timeout; `VIZ_FRESH_READ_MS=""` is 0 | **Fixed.** The upload is read until the key it inherited shows; the budget is wall-clock; every API request times out after 30 s (`VIZ_CF_TIMEOUT_MS`) and is retried; an empty variable is the default | RV-11 with budgets `300` and `""`: kept, no new put; a request that never answers is abandoned at 200 ms and retried |
  | m-8: one off-floor Worker refuses every release; the remedy undocumented | **Fixed** in documentation and as a command: `--only` / `rollback_only` restores that Worker alone; never rename a rule | RV-9: refused, then `--only viz-query` restores viz-query alone (no other Worker moved), and the next release with the switch goes out |
  | m-9: claims the code does not bear out | **Corrected**: `release.mjs`'s header, this README's "Contract issues" (§6 was edited in 799ea36, after the code), COMPATIBILITY §6's bullet (its own change), DESIGN.md's two paragraphs, `deploy.sh`'s exit codes, and the failure table's missing row (a serving viz-control version that cannot be read: exit 1, nothing changed) | text |

  **Before and after.** The regression tests (`test/review-d69.test.mjs`, 12, and
  `test/workflow.test.mjs`, 2) were copied, with the fakes, into a scratch copy of `deploy/`,
  `contracts/` and `.github/` as the review read them (9958cb3, identical to this branch's head before
  the change) and run there: **13 of 14 fail**, 12 on their assertions (exit 0 where 3 is expected:
  RV-1a, RV-5, the JSON var, RV-6; not forward-only and the rollback allowed: M-1 (c); the old
  messages: RV-1b, RV-7, RV-8; exit 3 where 0 is expected: RV-11; three Workers restored where one was
  asked: RV-9; the left-out viz-control rolled back since: refused for another reason; no gate step:
  the workflow), and one, the API timeout, hangs until the event loop drains and is cancelled, which
  is the fault. The one that passes there is RV-3's half that already held: the tool of that commit
  refuses the release `b322599` would make; what failed was that the workflow ran `b322599`'s own
  tool. After the change all 14 pass. Not ported: RV-4 (m-1) and RV-10 (m-4), which reproduce risks
  left open, and the review's "held" test.

  **Mutants**, in a copy of the tree in a scratch directory (no git; node_modules linked; the copy
  needs `.github/`, `dashboard/` and `anomaly/src/` too, which the bundling test reads), at most 2
  test workers. `mutants-release.mjs` now also runs `review-d69` and `workflow`; `mutants-secrets.mjs`
  also runs `review-d69`. **`mutants-release.mjs`: 60 of 60 killed** (19 new: 12 for M-1, 2 for M-2, 3
  for m-2, 1 each for m-3 and m-8; 10 earlier patterns rewritten to the new code). The first run, on a
  copy taken before two earlier patterns were rewritten, applied 57 of 59 and killed all 57; the two
  rewritten ones and one added after it were run on a fresh copy of the final tree and killed (3 of
  3). **`mutants-secrets.mjs`: 38 of 38 killed** (7 new: 2 for m-5, 1 for m-6, 3 for m-7, 1 for M-1's
  message; one earlier pattern rewritten). Every kill is a named test failing; none survived.

  | Mutant (new) | Killed by |
  |---|---|
  | M-1: the Workers a record leaves out are not judged | RV-1a; RV-1b; the left-out viz-control rolled back since |
  | M-1: a left-out Worker judged by its serving version only | the left-out viz-control rolled back since |
  | M-1: a left-out Worker's own record entry still reads | the M-1 unit test of the rule |
  | M-1: a left-out kept version declaring nothing ignored | the same |
  | M-1 (c): a Worker that declares nothing reads nothing | `readsOf`'s unit test; M-1 (c) end to end |
  | M-1 (c): forward-only asks only serving Workers that declare | the forward-only unit test; M-1 (c) end to end |
  | M-1 (c): an incomplete var, or record, taken as complete | `VIZ_FORMATS` unit test; M-1 (c); the format rollback unit tests |
  | M-1 (c): configure deploys a Worker without `formats`; one declaring none carries no `VIZ_FORMATS`; `reads_v1` not read; viz-query's `kv.pool` dropped from `workers.json` | the configure tests (every Worker declares; formats into each version's var; the bundled-sources test) |
  | M-2: either job's gate lets any ref through (2) | the workflow test |
  | m-2: a secret switch, a JSON-var switch, or a secret on the writer at deploy, not seen (3) | RV-5; the JSON var |
  | m-3: a floor Worker outside the release not judged | RV-6 |
  | m-8: `--only` ignored | RV-9; RV-1a |
  | m-5: the deploy-path refusal says nothing is promoted; logged as a promotion failure (2) | RV-7 |
  | m-6: the refusal no longer says rollback and redeploy do not lift it | RV-8 |
  | m-7: read until it exists only; `""` a 0 ms budget; no API timeout (3) | RV-11 (both budgets); the API timeout test |
  | M-1: the rotation refusal advises a bare record without viz-control | RV-1b |

  **Suites, at the end** (`cd deploy`): `npx tsc --noEmit` clean; `npx vitest run --maxWorkers=2`
  **178 of 178**; `node --test --test-concurrency=2 'test/*.test.mjs'` **106 of 106** (88 before:
  review-d69 12 and workflow 2 new, release 19 → 21, configure 27 → 29; release-checks' and secrets'
  fixtures follow configure's complete `VIZ_FORMATS`). `bash -n deploy.sh` clean; shellcheck and
  actionlint are not installed here; the workflow was parsed as YAML and its two gate scripts run by
  the workflow test.

- **D69: format versions, rollback floors, run marks, and S9's measurements in the secret steps
  (2026-11-19).** Nothing deployed; the Cloudflare API not called (another builder's stage
  experiment ran from a separate checkout). The fakes follow what S9 measured on Cloudflare: the
  secret list names the newest version's secrets; `versions deploy` of a version that served before
  and whose value of a secret differs from the serving one is refused with 10220, one that lacks the
  secret is allowed, a new version (a rotation's promotion) is allowed; a version just created can
  answer 404, or show without the secret just put, for its first reads (`readLag`, `secretLag`);
  `racePut` lets another run of the same release upload between the checks and the put; `ignoreVar`
  uploads without `--var`. Shared by the end-to-end tests in `test/fake-account.mjs`.

  **Tests that fail without the change.** The two end-to-end files that drive the real `deploy`,
  `plan` and `rollback` (`test/release-checks.test.mjs`, 14 tests, and `test/secrets.test.mjs`, 21)
  were copied, with the fakes, into a scratch copy of the tree as it was before this change and run
  there: **23 of 35 fail**, each on its assertion (exit 0 where 3 is expected, a record without
  `floors` or `formats`, the old restore across a rotation hitting 10220 after the gateway was rolled
  back). The 12 that pass there are the 11 earlier secrets tests and the floors' negative control
  ("while the switch was never on, they refuse nothing"). One earlier test, m-9's refusal, fails
  there too, on its message only: the old code cites the secret list, which the fake now models as
  the newest version's (S9). The 13 unit tests of new functions (`release.test.mjs` 8,
  `configure.test.mjs` 5) cannot run against code that lacks them.

  What each new test shows (the end-to-end ones):

  | Test | Before this change |
  |---|---|
  | floors: the switch refused while the serving publisher (schema 3), query or ingest (unstamped) is below its floor; nothing uploaded; `plan` says the same | exit 0 |
  | floors: the switch refused with one of the release's own Workers below its floor (query unstamped; publisher schema 3) | exit 0 |
  | floors: allowed once a release at every floor has served; the record's `floors` | no `floors` |
  | floors: once a kept viz-ingest version set the switch, a release with a Worker below its floor is refused with the switch off, also when the newest viz-ingest version has it off | exit 0 |
  | floors: a rollback below a floor after the switch, whole or of one Worker (query, publisher, ingest each alone), refused; nothing restored | exit 0 |
  | floors: a rollback at every floor allowed (to the release before the switch; publisher schema 5 → 4), then below refused | the second exit 0 |
  | floors: a Worker the record does not name is judged as it serves (query put below its floor by hand) | exit 0 |
  | floors: while the switch was never on, nothing refused | passes (control) |
  | m-13: a → b (reads 2) → c (writes 2): to b allowed, then to a refused, b serving | exit 0, no `formats` |
  | m-13: c over a (reads 1 only) is forward-only (kind `format`), and its automatic rollback target refused | not forward-only |
  | m-13: a record from before format versions: allowed while only 1 was written since, refused once 2 was | exit 0 |
  | m-13: what it costs today (`r2.dead-letters` 2 refuses a rollback to an old record) | exit 0 |
  | m-13: a newer version that declares no formats is refused as unknown | exit 0 |
  | a failed promotion after a Worker the release is forward-only for was promoted puts nothing back | restored |
  | m-11: another run uploads between the check and the put: the key is on its version, exit 3, nothing promoted | exit 0, that version promoted |
  | m-11: every upload carries `VIZ_DEPLOY_RUN`; two runs differ; the record names its run | no mark |
  | m-11: an upload without this run's mark gets no put (refused before it) | put made |
  | S9: a version not seen yet (404, or without the secret just put) is read again, and the deploy goes on | exit 1 |
  | S9: a version that does not show within the budget stops the release, nothing promoted | other message |
  | S9, created: rollback across the key's creation refused up front; accepted, it serves without the key; the next deploy keeps the key | exit 0 |
  | S9, rotated: rollback across a rotation refused up front, also when accepting the loss; a record without viz-control goes ahead | gateway rolled back, then 10220 at viz-control |
  | S9: a failed promotion leaves a viz-control with a rotated key on it | restore hits 10220 |
  | a serving version that cannot be read stops the release, no key made | went on (a new key over the existing one) |

  Unit tests: `release.test.mjs` (format rollback rule, `readsOf`, forward-only by format,
  `VIZ_FORMATS` parsing, the floor rule as `workers.json` states it, malformed rules refused, the
  deploy and rollback floor rules); `configure.test.mjs` (formats read from the real components into
  the manifest and each version's `VIZ_FORMATS`, with the ruler's gate read from its source; every
  `FORMATS` map in a deployed component declared; a Worker writing what it does not read, one format
  at two versions, and read lists with nothing in common refused; viz-query and viz-ingest stamped
  `VIZ_FLOORS`, a declaration without its evidence refused, a schema floor naming no class refused;
  the publisher's floor pinned against `publisher/test/n1` (schema 3, metric tables only),
  `test/d64` (schema 4, reads the three) and `src/` (schema ≥ 4, publishes them)).

  **Suites, at the end** (`cd deploy`): `npx tsc --noEmit` clean; `npx vitest run --maxWorkers=2`
  **178 of 178**; `node --test --test-concurrency=2 'test/*.test.mjs'` **88 of 88** (52 before this change:
  release-checks 14 new, secrets 12 → 21, release 11 → 19, configure 22 → 27). `bash -n deploy.sh`
  clean; shellcheck is not installed here, so deploy.sh's changed lines were not linted. One gateway
  test had started to fail meanwhile through no change here: control's `/healthz` now answers `ok`
  and then lines on OAuth's key and rate limiters (D70, committed by control's builder), and the
  test pinned the whole body `ok\n`; it now checks the status and the first line, which is what
  control documents ("the gateway reads only the status"). The gateway's mutants were not re-run
  (its source did not change; the test still checks the path asked and the 503s).

  **Mutants**, each run in a fresh copy of the tree in a scratch directory (node_modules linked; the
  scripts refuse a git work tree), whose unmutated tests the scripts check first; at most 2 test
  workers. First runs: `node scripts/mutants-release.mjs` **40 of 41 killed**; the survivor, *a
  schema floor naming no class of its Worker is not refused by configure()*, lived because
  `configure()` read `workers.json` only from disk and the test called the check directly: it now
  takes a `plan`, and a test configures one with a wrong floor (killed on re-run). `node
  scripts/mutants-secrets.mjs` **30 of 31**: the earlier mutant *plan mode puts the secret* survived
  because its injected `ensureSecrets` call has no run id, which the new run check refuses before
  any put (the guard made that form equivalent); it now puts directly (killed on re-run). One kill
  was not a kill: *the secret check of a rollback is never run* left a parenthesis unbalanced, the
  test file did not load, and the script counted its failure; the replacement is fixed, and both
  scripts now count a test file that does not load as NO RUN. Final runs, on the final code:
  `mutants-release.mjs` **41 of 41 killed**, `mutants-secrets.mjs` **31 of 31 killed**, every kill
  a named test failing. The new mutants and the tests that killed them:

  | Mutant (release, 26 new; 15 earlier) | Killed by |
  |---|---|
  | formats: forward-only by format not marked | m-13 forward-only; the failed promotion that puts nothing back |
  | formats rollback: the check never run / a version written since accepted / only schema-bearing Workers' versions read | m-13: a → b → c, to b allowed, to a refused (and 4 others) |
  | formats rollback: a newer version declaring no formats ignored | m-13: unknown version refused |
  | formats rollback: workers.json's format Workers not judged for an old record | m-13: old record; what it costs today |
  | formats: a release declaring nothing taken to read every version | m-13: old record; what it costs today (5) |
  | formats: what a release reads is the union over its Workers | formats: what every Worker of it reads |
  | formats: two read lists in one Worker united | formats: … read lists with nothing in common refused |
  | formats: a Worker writing what it does not read accepted | the same |
  | formats: `read.` entries recorded as written | formats read from the components; the same |
  | configure: no VIZ_FORMATS on versions | formats read from the components, into each version's VIZ_FORMATS |
  | floors: the switch on while a serving Worker is below its floor | the switch refused while the serving publisher, query or ingest is below; the pure deploy rule |
  | floors: the switch on while the release's own Worker is below its floor | own Worker below its floor; the pure deploy rule |
  | floors: history never read with the switch off | a kept viz-ingest version set the switch |
  | floors: only the newest writer version looked at | the same (the newest has the switch off, an older one had it on) |
  | floors rollback: the check never run / allowed whatever the switch did | rollback below a floor refused, whole or one Worker (3, 4) |
  | floors rollback: a Worker the record does not name not judged / its live state not read | a Worker the record does not name is judged as it serves |
  | floors: only the signal names edge knows count | the floor rule as workers.json states it (`metrics2`) |
  | floors: schema floor off by one | 7 tests |
  | configure: a floor stamped without its evidence / no VIZ_FLOORS on versions | stamped on the evidence of their sources |
  | configure: a schema floor naming no class not refused | the same test, through `configure({ plan })` (after the fix above) |
  | phase 2: a failed promotion restores across a forward-only Worker | the failed promotion that puts nothing back |

  | Mutant (secrets, 12 new; 19 earlier, two of them rewritten) | Killed by |
  |---|---|
  | m-11: the keyed version's VIZ_DEPLOY_RUN not checked after the put | another run uploads between the check and the put |
  | m-11: the newest version's mark not checked before the put | an upload without this run's mark gets no put |
  | m-11: uploads without the mark | absent, a failed put, rotation, … (every keyed deploy) |
  | m-11: phase 2's `wrangler deploy` without the mark | a first deploy |
  | m-11: every run has the same mark | two runs carry different values |
  | S9: a just-created version read once | a version not seen yet is read again |
  | S9: a rollback across the key's creation not refused | S9, created |
  | S9: `--accept-secret-loss` ignored | S9, created |
  | S9: a rollback across a rotation not refused | S9, rotated |
  | S9: the secret check of a rollback never run | S9, created; S9, rotated (after the fix above) |
  | S9: a failed promotion restores viz-control across its own rotation | S9: a failed promotion leaves viz-control on its rotated key |
  | a serving version that cannot be read taken as not carrying the key | a serving version that cannot be read stops the release |
  | (rewritten) m-9: newer versions not scanned (the scan, not the old `newestServing` guard) | m-9 (2) |
  | (rewritten) plan mode puts the secret (directly) | plan |

- **After the review of D44, D52, D53 and D60** (`design/reviews/d44-d52-d53-d60.md`,
  2026-11-19; nothing deployed, the Cloudflare API not called). `test/secrets.test.mjs` **12 of
  12**, three new: **m-9**, a rollback across the key's creation (the serving version without the
  key, a newer one with it) followed by an upload that does not inherit it: exit 3, the log names
  the newer version, nothing put or promoted, and `plan` says `keep`, not `create` (before: exit 0
  and a new key, the review's `D53-1`); the same rollback with an upload that inherits from the
  newest version keeps the key, no put; **m-10**, with `WRANGLER_LOG=debug`,
  `WRANGLER_LOG_SANITIZE=false` and `WRANGLER_WRITE_LOGS=true` in the deploy's environment, the
  fake wrangler (`test/fake-wrangler.mjs` now records the three for every call) sees `true` and
  `false` on the put, and the upload keeps the environment's values. `test/configure.test.mjs`
  **22 of 22**, two new: viz-mcp's generated config (production and a stage) has the `OAUTH`
  binding to viz-control's `OAuthIntrospection` with `props: { caller: "viz-mcp" }`, a caller
  `contracts/oauth.ts` allows, and no Durable Object binding; control's main module exports the
  entrypoint and a main without it is refused; viz-mcp with control's `Tenant` class bound again
  is refused, in production and a stage, naming `binds_classes`; the four listed class bindings
  are exactly those the components have, each with a reason, and an alias (`viz-edge`) is resolved
  before the check. Whole suite: `npx vitest run --maxWorkers=2` 95 of 95, `node --test
  --test-concurrency=2 'test/*.test.mjs'` 52 of 52, `npx tsc --noEmit` clean. Mutants, run in a
  copy of the whole tree in a scratch directory (node_modules linked), whose unmutated tests the
  scripts check first: `node scripts/mutants-secrets.mjs` **19 of 19 killed**, the two new ones
  first time: *m-10, a run with a secret on stdin keeps the deploy's own log settings* (killed by
  "m-10: a secret on stdin runs wrangler with …"), *m-9, a key on a version newer than the serving
  one is not seen* (killed by "m-9: after a rollback across the key's creation …"); the 17 earlier
  ones are killed as before, several now also by the m-9 and m-10 tests. `node
  scripts/mutants-release.mjs` **15 of 15 killed**, three new: *a class of another Worker bound
  without being listed in `binds_classes`* (killed by "a Durable Object class of another Worker is
  bound only where workers.json lists it …"), *viz-mcp binds control's `Tenant` class again* (every
  configure test that generates viz-mcp in production, among them "production: the gateway …"),
  *viz-mcp's `OAUTH` binding without the entrypoint* ("every service a Worker binds …" and "viz-mcp:
  control's OAuthIntrospection entrypoint …"). The 2026-11-19 failure that kept the release
  mutants from starting (`stack/wrangler.test.jsonc`) is gone: that test passes now.
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

- **Stage 3 of traces and logs (2026-11-19): the span, log, Tempo, Loki and plan routes.**
  Nothing deployed. `npx vitest run --maxWorkers=2`: **178 of 178** (3 files; 83 more than the
  last count above: 22 newly routed paths and 61 near misses that must 404, among them `/v1/logs`,
  which was a 404 before, `/api/traces/`, `/api/traces/abc/x`, `/api/search/tag//values`,
  `/loki/api/v1/label/x/values/y`, `/loki/api/v1/tail`, `/loki/api/v1/index/stats`, `/otlp/v1/logs`,
  `/api/echo`, `/api/v1/planx`). `node --test --test-concurrency=2 'test/*.test.mjs'`: **47 of 47**.
  `npx tsc --noEmit` clean. Through the gateway in front of the real ingest and query Workers:
  `stack/README.md`, "Through the gateway". `node gateway/scripts/mutants.mjs`, run from `deploy/`
  in a copy of the tree in a scratch directory after the copy's suite passed unmutated (178 of
  178): **28 of 28 killed**; the copy's `gateway/src/index.ts` equal to the shared tree's afterwards.
  This change's seven, and how many tests failed for each:

  | Mutant | Killed by (tests failing) |
  |---|---|
  | a trace path goes to ingest (OTLP traces and Tempo share `/api/traces/…`) | the Tempo trace-by-ID rows (5) |
  | every `/loki/` path goes to ingest (where the push is served) | the Loki rows and Loki near misses (29) |
  | the span and log ingest paths are not routed | `/v1/traces`, `/v1/logs`, `/loki/api/v1/push` rows (4) |
  | the Tempo and Loki read paths are not routed | their rows (18) |
  | a trace id matched as a prefix (`/api/traces/abc/x` reaches query) | the trace-id near misses (4) |
  | `/api/v1/plan` is not routed | its row (2) |
  | every `/loki/` path goes to query (`/loki/api/v1/tail`, index, rules reach it) | the Loki near misses (23) |

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
Per deploy: about 8 to 12 API calls and 4 to 8 version uploads; no charge beyond requests. Since
D70's ids, `resources.mjs ensure` also reads the account's scripts' bindings: about 4 GET calls per
script (about 110 for the 28 scripts on the account on 2026-11-26), modelled, not counted on Cloudflare. The Rate
Limiting binding itself has no price on its page (read 2026-11-19): worst case of the bindings,
unknown and not modelled.
The trial (below) was stated before it ran as under US$1 worst case: at most 30 minutes of
20 Remote Write requests and 1 query a second through four Workers, a few hundred R2 writes
from flushes, a few thousand queue operations, one KV namespace and one small bucket, at
Workers Paid rates. What it sent, counted by the client: 16,306 Remote Write requests and 813
queries under load, 400 more for the latency measurement, about 20 for smoke tests and
bootstrap, five releases and two manual rollbacks. Cloudflare's GraphQL analytics, queried
right after the trial for 23:10–23:50 UTC, returned no rows for the `viz-trial-*` scripts
(already deleted, or not yet ingested), so there is no measured bill for it here.

## Needed changes in components

From stage 3 of traces and logs (2026-11-19): what is still needed before `INGEST_SIGNALS` and
`QUERY_SIGNALS` are set in a production deployment (the gateway routes their paths already; both
Workers answer them 404 until then):

- **The rollback floors (D64, D69): done here.** The release tooling refuses `INGEST_SIGNALS` until
  viz-publisher, viz-query and viz-ingest are at their floors in the release and as they serve, and
  then refuses any release or rollback below them ("Rollback floors"). Before the switch: a release
  with this check must have served (the stamps), and, for the D67 → D64 rollback to exist, D64 must
  have served on its own (m-5).
- **Floors declared by the components themselves.** viz-query's and viz-ingest's floors are
  declared in `workers.json`, with exports as evidence. Wanted: a constant in each (e.g. a `READS`
  entry for the span and log data in `query/src/` and in the write path), which `workers.json` would
  then point at, as it points at the `FORMATS` maps.
- **Read versions declared by the components themselves** (review of D69, M-1 (c)). Every Worker now
  declares in `workers.json` what it reads. Where a component has a version constant for it,
  `workers.json` points at it (edge's `KEY_RECORD_VERSION` for `kv.key`; `contracts/control.ts`'s
  `CONTROL_SERVICE_VERSION` for control's two RPC answers the ruler reads; `contracts/oauth.ts`'s
  `OAUTH_VERSION` for `rpc.oauth`, which viz-mcp reads). Where it has none, `workers.json` declares
  version 1 on its behalf (`reads_v1`): `edge/src/route.ts` (`pool:` and `limits:`, in viz-ingest and
  viz-query), `flush/src/sweep.ts` (`pool:`), `stack/src/index.ts` (`retention:`), `query/src/config.ts`
  (`limits:`), `edge/src/auth.ts`'s `KEY_RE` (the API key's layout, in every Worker that authenticates)
  and `contracts/oauth.ts`'s `parseCredential` (the OAuth credential's layout, in viz-mcp). Wanted: a
  `READS` entry or a version constant in each, as the janitor's `READS` has for `kv.settings`, which
  `workers.json` would then point at instead.
- **A trial on Cloudflare.** Nothing of stages 1 to 3 has run there: OTLP and Loki decode CPU in
  workerd (`edge/README.md`, "Known risks"), the flush of span and log segments against real R2
  latencies, the query caps (`maxSpans` 40,000, `maxLogRows` 60,000) against a 128 MB isolate, and
  the service bindings in production shape (`script_name`; the test puts every Worker in one
  script). A stage release with both flags in `VIZ_STAGE_VARS`, OTLP and Loki load through the
  gateway, and Tempo and Loki queries back is the experiment.
- **Where the flags are set.** Neither is in `workers.json` or a component config; setting them is
  a var on viz-ingest and on viz-query (a release). They are per deployment, not per tenant.
- **A client run.** No Grafana Tempo or Loki data source, and no OTLP SDK exporter, has been
  pointed at the gateway. Tempo's `/api/echo` is routed to viz-query since 2026-11-26 (it answers
  `echo` behind the key while `QUERY_SIGNALS` names `traces`); `/api/status/buildinfo` is not served
  (whether Grafana's data source check needs it was not verified). `query/README.md`, "Grafana",
  describes the run.

From D70's gate (2026-11-26), for `control/`'s owner (not edited here):

- **`control/README.md`, "Needed changes elsewhere (rate limits, D70)"**: items 1 to 6 and the
  `control/wrangler.jsonc` block are done here; its "It is not added now" paragraph and the opening
  "in progress" sentence are out of date. Item 6's test "a release setting it while the serving
  viz-control is unstamped is refused" was not built as written: such a release is forward-only
  instead (D69, point 6), because refusing would strand production.
- **`control/README.md`** (line about layout 1 read early): "about 1 in 13,000" is about 1 in 11,600 by
  2026-12-26, and production has issued layout 1 since 2026-11-19 (corrected in `contracts/oauth.ts`
  and D70 by the review of D69, round 2, m2-3).
- **`control/vitest.config.ts`** now strips `ratelimits` from the config it hands the test plugin
  (control's builder, after the block made 22 tests fail): a test of control that wants the real
  bindings has to add them itself.

From the generated OAuth key (D53; none made here):

- **`.github/workflows/deploy.yml`: an input to rotate a generated secret** (`rotate_secrets`,
  passed to `deploy.sh` as `VIZ_ROTATE_SECRETS`), so a rotation can run in CI rather than from a
  workstation ("Worker secrets the deploy generates", Rotation); and one for `rollback_to` to accept
  losing the key (`accept_secret_loss`, passed as `--accept-secret-loss`), so that a refused rollback
  across the key's creation can be done on purpose from CI.
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

- **A WAF rate-limiting rule** on `vis.bitcru.sh` for the `/oauth/` paths (D70 (c)): by hand, outside
  the deploy; not made.
- **A check that the account's rate-limit ids stay clear between deploys**: the scan runs at each
  `resources.mjs ensure`, not continuously; an unrelated script that starts binding viz's id is seen
  only at the next deploy.
- **The gate on a key that is kept**: `lib/secrets.mjs` refuses to create or rotate
  `OAUTH_CLIENT_KEY` without the bindings, not to keep one; configure already refuses a production
  viz-control without them, so only a manifest written by hand could promote one.

- **Formats no component lists.** Format versions are recorded from the components' `FORMATS`
  maps and read lists, and from `workers.json`'s `reads_v1` (D69; review of D69, M-1); readers are
  judged per Worker, including Workers a rollback leaves out. Formats no writer keeps in a `FORMATS`
  map are not recorded at all, so neither their writers nor their readers are judged: the ledger's
  segments and checkpoints (which the publisher reads, its `read.…` entries), shard's `series-window`
  byte, shard's tail pages (`TAIL_READ_VERSION`, `shard/src/tail.ts`, which viz-query reads), edge's
  records, and `Tenant.provision`'s answer (the gateway's bootstrap).
- **A partial rollback does not judge the Workers it leaves out as readers** of what the restored
  ones write (an older writer under a newer reader, which matters only after a reader dropped an old
  version, §4's contract step). §6 asks only that the target read what was written.
- **Gradual (percentage) rollouts.** Every promotion is 100%. Splitting would put two
  versions of the write path's objects in service at once; the tooling refuses nothing about
  it but never does it.
- **Alerting** on a failed deploy beyond the failed job and its summary.
- **The workflows have not run on GitHub** (see above).
- **Generated secrets on Cloudflare** were measured by spike S9 (2026-11-19: created case twice,
  rotated case once, first deploy once) on viz-control alone. Not run there: the up-front refusals
  and the read retries added since (modelled by the fakes, which now follow S9), m-11's run marks,
  and a whole stack's rollback.
- **Rotation without a deploy, or with overlap.** A rotation is a release; control verifies under
  one key only, so every registered client is invalidated at once. No workflow input yet.

## Contract issues

- **COMPATIBILITY.md §6, "A floor raised by a switch", was written after the code** (also
  publisher/README.md, contract issue 16). D69's floors were implemented first (`lib/floors.mjs` from 3f8582d) and
  the bullet added to §6 afterwards (799ea36), against AGENTS.md's "contracts first"; the review of D69
  (m-9) found the bullet said more than the code: it spoke of a format version the switch starts
  (D69 (c) rejected modelling it as one, and none is recorded), of "every reader" (the readers are a
  hand list in `workers.json`), of "the first version with the switch on" (the code sees any version
  Cloudflare still keeps, m-1), and of the readers "in it and as it serves" (only those in the
  release, m-3; and the code judges every release with the switch on, not only the one turning it
  on). This change corrects the bullet in its own commit, to what the code does now (m-3 fixed; m-1
  stated as the window it is), keeps D69's per-Worker floors, and adds to §6 what M-1 made the code
  do: formats are read per Worker (one that declares nothing reads version 1 of every format), and a
  rollback of some Workers judges the others as they wrote and write.
- **§6 "per format the versions it reads and writes"** is implemented from the components' `FORMATS`
  maps, the read lists three keep (the janitor's and flush's `READS`, the ruler's
  `ANOMALY_STATE_READS`), the version constants three readers use (edge's `KEY_RECORD_VERSION`,
  `contracts/control.ts`'s `CONTROL_SERVICE_VERSION`, `contracts/oauth.ts`'s `OAUTH_VERSION`), and, for
  readers with no version in their code, `workers.json`'s `reads_v1`, taken as version 1 ("Needed
  changes in components" lists them). §3.1 asks only for the written versions in one place; a
  `READS` map in every component would make "what a release reads" come from the code rather than
  from a declaration a test holds to a few signatures.

## Known risks

- **The Rate Limiting binding's shape in Cloudflare's version API is not verified** (D70's ids; review
  of D69, round 2, M2-2). The scan reads bindings of type `ratelimit` with `namespace_id` (or
  `namespaceId`), wrangler's upload shape (training knowledge; the fakes assume it). Since round 2
  an unreadable binding on viz-control itself no longer stops later deploys, and one elsewhere stops
  only a first allocation; but a shape under an unrelated type name would make other scripts' ids
  invisible, so a collision with an unrelated script would go unseen and the counters would be
  shared. Whether Cloudflare accepts the six bindings at upload is unknown too (if not, phase 1 fails
  before anything is promoted, and production can take no release of this tree until code changes).
  The experiment: `spikes/s13-upgrade-trial/` (prepared; not run, the session's permission check
  refused deploying to Cloudflare).
- **Two allocations at once can pick the same id.** Two stages ensured at the same time from different
  checkouts see the same free ids; the start each name picks makes a clash unlikely, not impossible.
  The next `ensure` of either sees the other's bound id and moves off it (the counters reset).
- **Per-location limits are modelled** (control's README); none of the six has run on Cloudflare.
- **The first release over the 2026-11-19 production is forward-only** ("The first release over the
  2026-11-19 production"): no automatic rollback; fix forward.

- **A run refused after its put leaves its key on the newest version** (m-11, D69). When another run
  uploaded between the check and the put, the key lands on that run's version (the PATCH has no
  condition); nothing promotes it, but the next upload inherits the newest version's secrets
  (measured, S9), so that key becomes the key at the next deploy. On a creation that is harmless (no
  client was registered under another key); on a rotation it completes the rotation one release
  late, with the record saying `kept`. CI runs are serialised by the `deploy-production` group.
- **`kept` compares names, not values.** It means "the newest version's value" (S9). A rollback across
  a rotation forced outside the tool (the API's `?force=true`, wrangler's `rollback`, the dashboard)
  brings the old key back until the next release, which returns to the rotated one silently. The
  tool refuses such a rollback; nothing stops one done by hand.
- **A rotation is detected by the deploy's own message** (`…; OAUTH_CLIENT_KEY rotated`). A key put by
  hand without it is not seen as one; Cloudflare's 10220 then still refuses the rollback, after the
  callers were rolled back (exit 1), as before.
- **Floors by evidence rest on a declaration.** viz-query's and viz-ingest's floors are stamps that
  configure gives when the named exports exist; the exports show the code has D62's and D63's
  readers, not that they behave. The declaration was added after D62 and D63, so a commit from
  before them has none and its versions are below the floors (fail closed).
- **Old records cannot be rolled back to across a viz-ingest upload** (D69): they are taken to read
  version 1 of every format, and viz-ingest writes `r2.dead-letters` 2. Since the review of D69 the
  same holds for D69's records, whose viz-query, viz-mcp and viz-gateway declare nothing. Fix forward,
  or restore that code in a new commit on main. The first release with format records over a
  deployment without them, and the first with complete declarations over one with D69's, are
  forward-only for the same reason (no automatic rollback).
- **The switch's evidence ages out with the versions Cloudflare keeps** (review of D69, m-1; not
  fixed). "Once a version with `INGEST_SIGNALS` on has existed" is read from viz-ingest's kept
  versions, the 100 newest. The review's scenario (RV-4, reproduced with the fakes keeping 4): the
  switch goes on in r2 and off in r3; runs that fail between viz-ingest's upload and viz-query's add
  viz-ingest versions and no viz-query version (phase 1 uploads in `workers.json` order); once r2's
  viz-ingest version falls out of the window, a record naming only viz-query, whose target is from
  before D62 and still kept, is accepted. In practice every record the tool writes is at the floors
  (stamped), so this needs a below-floor version made by hand, or kept from before the stamps. The
  review's remedy, not built: carry the evidence forward (once seen, stamp every later version of
  every floor Worker, e.g. `VIZ_FLOORS` with `seen: ["signal-data"]`, and carry it in each record),
  so it lives as long as any later version.
- **Check, then act: a local rollback is not atomic against a deploy** (review of D69, m-4; not
  fixed). `release.mjs rollback` computes every refusal, then restores. The review's scenario
  (RV-10, a deterministic interleaving with the fakes): a rollback to a record with a schema-3
  publisher passes its checks (the switch was never seen); a deploy that sets `INGEST_SIGNALS` then
  passes its own (the serving publisher is at its floor) and completes; the rollback restores the
  schema-3 publisher, under the switch. CI serialises its deploys and rollbacks in `deploy-production`;
  a laptop run is outside that group. Run a local rollback only while no deploy runs ("Rollback").
  The review's remedy, not built: re-check the floors immediately before each restore step.
- **A key set but missing from the upload has no non-destructive way out** (review of D69, m-6; not
  fixed; the README advised a rollback or a redeploy, which do not lift it, and no longer does). The
  refusal fires only when the newest version lacked the key at upload; the refused upload then becomes
  the newest version, a rollback does not change which version is newest, and redeploying uploads from
  it again. The review's scenario (RV-8): one upload that did not inherit the key (k2, refused); a
  rollback to k1 (allowed); k3 and k4 refused all the same, after Cloudflare inherits normally again.
  The only exit the tool offers is `VIZ_ROTATE_SECRETS=OAUTH_CLIENT_KEY`, the invalidation of every
  registered client that the refusal exists to prevent. A way that keeps the key, not verified here:
  an upload whose secret binding inherits from the keyed version by id (the version API's `inherit`
  binding takes a version, "Defaults to latest"; wrangler does not expose it), or the dashboard. The
  m-7 re-read (the upload read again until its inherited key shows) removes the case where only the
  read lagged.
- **Only main deploys, but only the workflow and a setting enforce it** (review of D69, M-2). The
  Deploy workflow refuses any ref but main as the first step of the jobs that hold the credentials;
  an older commit's own workflow has no such step, and only the `production` environment's branch
  rule ("One-time setup") keeps it from the credentials. That rule is a repository setting nothing
  here can check. `deploy.sh` run by hand from an older checkout, with the two Cloudflare variables,
  runs that checkout's tooling; nothing can refuse that from here.
- **Complete read declarations rest on `workers.json` and a test of signatures** (review of D69,
  M-1 (c)). "A format a Worker does not list, it does not read" is as true as the declarations; the
  test that bundles each Worker checks only control's KV records, the API key and OAuth credential
  layouts and control's RPC answers. A new cross-Worker read of another kind is caught only if its
  writer's `FORMATS` map names it and someone adds the reader; until then, nothing judges it.
- **A Worker whose `versions deploy` succeeded and whose `triggers deploy` failed is not put back**
  after a failed promotion: it is not yet counted as promoted, so it keeps the new version (found
  while writing the phase-2 tests; not changed here).
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
  keeps 100 versions; after that, older code goes out again only as a new commit on main, judged by
  main's tooling ("Rollback": never by running the workflow, or `deploy.sh`, of the older commit).
- **The trial ran from a snapshot of a working tree that others were editing**, with the WASM
  built from that snapshot; CI builds and deploys one commit, which cannot have that problem
  (see the trial, release N0).
