# Control

The tenant control plane: a `Tenant` Durable Object (one per tenant, SQLite) and the Worker
that exposes it as `/api/v1/control/…`. It holds everything about a tenant that is not
telemetry: API keys, dashboards and their revisions, proposed changes, settings, and an
audit log of every change to any of them. It publishes what the data path needs to KV. The
data path never calls it.

| File | Contents |
|---|---|
| `src/index.ts` | The Worker: CORS, body and `If-Match` parsing, dispatch from the route table, problem-details errors, the `state` hook |
| `src/identity.ts` | `Identity` and `identify()`, the one function that makes one. Today: API keys, verified by edge's own `authenticate` |
| `src/routes.ts` | The route table: method, path, operation, scopes. The Worker dispatches from it and the object authorises from it |
| `src/schema.ts` | The `Tenant` storage schema as versioned migrations (`TENANT_SCHEMA`), and `FORMATS`: the version of everything this component writes for other releases |
| `src/tenant.ts` | `Tenant`: opening (and migrating) storage, the mutation wrapper (one transaction: change + audit row + KV outbox), dry run, the outbox drain, the alarm, `provision`, `resolveKey`, `recordUsage` |
| `src/ops-keys.ts` | Keys: create, list, disable/enable, rotate, delete; the KV records |
| `src/ops-dashboards.ts` | Dashboards and revisions: create, get, list/search, patch, revert, delete/restore, owner, caps |
| `src/ops-proposals.ts` | Proposed changes: create, list, review against the current revision, edit, apply (whole or part), decline, expire; proposals that create a dashboard |
| `src/ops-settings.ts` | Settings: general, retention, limits, pool, notifications |
| `src/ops-audit.ts` | The audit log's two read routes |
| `src/openapi.ts`, `openapi.json` | OpenAPI 3.1, written next to the handlers, generated to JSON, held equal to the route table by a test |
| `src/oauth.ts` | OAuth building blocks: issuer and resource, credentials (with their tag) and their hashes, sealing, signed registrations, PKCE, scopes, redirect URIs, the authorization request handle |
| `src/ops-oauth.ts` | OAuth grants in the Tenant object: approve (the consent step), list, get, revoke; the token endpoint's code exchange and refresh; RFC 7009 revocation; introspection for the agent surface; the alarm's sweep |
| `src/oauth-http.ts` | The authorization server's public endpoints: RFC 8414 metadata, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`; `readCapped`, a body read with a cap |
| `src/introspection.ts` | `OAuthIntrospection`, the named entrypoint the agent surface binds (`contracts/oauth.ts`): token introspection for one caller, the tenant from the token, nothing else |
| `src/ratelimit.ts` | Rate limits in front of OAuth (D70, as rewritten after its two reviews): the Rate Limiting binding checks (keys, order, a wider key only after every narrower one was checked, an even share of the request's budget per check, failing open, logged once per isolate, `/healthz`'s status), the client networks a request comes from, the exact per-grant refresh limit's window |
| `src/deadlist.ts` | The list of OAuth credentials found dead (D70 after its second review, R2-M2): recorded when the tenant's object says a token is dead, in the isolate and in `CONFIG` under `oauth-dead:` until the credential expires; refused before any limit or object; bounded reads and writes; failing open |

Runtime dependencies: none. It imports `../edge/src/auth` (key verification),
`../dashboard/src` (the `viz.dashboard/v1` model) and `../contracts/ledger` (`TENANT_ID`).

## What is implemented

### Who is calling

`identify(req, env) → Identity { tenant, subject, kind: 'user'|'agent'|'key', scopes, name?, keyId? }`
is the only place an identity is made, and handlers see nothing else of the request's
credentials. Its one implementation is the API key: edge's `authenticate` (imported, not
copied) proves possession of the secret against KV, then the caller's `Tenant` object says
whether that key is still live and what its kind, name and scopes are. Sign-in is added by
giving `identify` a second branch that returns `kind: 'user'`; no handler changes.
OAuth access tokens are not credentials for this API: their audience is the agent surface's
`/mcp` ("OAuth for agents" below), which calls this API with the grant's own agent key.

- **The tenant is the credential's, always.** The Worker picks the `Tenant` object in one
  line, `idFromName(identity.tenant)`. No route has a tenant in its path. A request with
  `tenant` in its query string or as a top-level body field is refused with 400
  `tenant-not-accepted` rather than silently ignored; headers that look like a tenant are
  ignored. The object refuses an identity whose tenant is not the one it is bound to, and
  re-checks the key on every call.
- **Scopes**: `admin`, `dashboards:read`, `dashboards:write`, `dashboards:apply`, plus edge's
  `write` and `read`, and the ruler's `monitors:read`, `monitors:write`, `monitors:ack`
  (`ruler/src/http.ts` `Scope`; mcp's `list_monitors` and `get_monitor` need
  `monitors:read`). A key can be created with any of them; each service checks its own
  literally, and here the others reach only `whoami`. `admin` is accepted wherever any of
  this API's scopes is. Keys, settings and the audit log need `admin`. `dashboards:write`
  may propose and dry-run; `dashboards:apply` may change dashboards and apply proposals.
- **`GET /whoami`** answers for any scope: tenant, subject, kind, name, scopes, and
  `mayApply`: whether this caller's direct dashboard writes take effect (false without
  `dashboards:apply` or `admin`, and for an agent while `agentsMayApply` is false), so a
  client such as mcp knows without a dry run.
- **Kind.** A key is created as `key` or `agent`. Every mutation stores
  `{ subject, kind, name }`, so the UI can say "by an agent" or "by Dana". There is no
  `user` identity yet; in the tests "Dana" is a key named Dana.
- **The first key** of a tenant is made by `Tenant.provision(tenant)`, reachable only
  through the Durable Object binding. There is deliberately no HTTP route for it: such a
  route would have to take a tenant from the request.

### Keys (screen 8)

| Operation | Notes |
|---|---|
| `POST /keys` | Returns `viz_<keyId>_<secret>` once. `keyId` is 16 and the secret 40 random base62 characters. Only the SHA-256 of the secret is stored, in SQLite and in KV. Name (unique), scopes, kind, optional `expiresAt` |
| `GET /keys`, `GET /keys/{key}` | Name, kind, scopes, `prefix` (`viz_<keyId>`), created by/at, expiry, disabled, last rotation, `lastUsedAt`, `samples24h`. No secret and no hash |
| `POST /keys/{key}/disable`, `/enable` | |
| `POST /keys/{key}/rotate` | New `keyId` and secret. `overlapSeconds` (default 0; otherwise 60 to 604,800) keeps the old secret valid that long |
| `DELETE /keys/{key}` | Needs `confirmName` equal to the key's name, in the body or the query |

The last enabled admin key cannot be disabled or deleted.

**KV.** Every change is written through in edge's record format, exactly:
`key:<keyId>` → `{ tenant, secretSha256, scopes, disabled }`. Expiry and a rotation overlap
are KV expirations on the record, so edge needs no new field. A rotation issues a new
`keyId`, because edge's record holds one hash per `keyId`.

**Revocation generation.** `revocation:<tenant>` → `{ generation, revokedBefore }` is
bumped whenever a credential stops being valid (disable, delete, rotation without overlap).
`revokedBefore` is Unix milliseconds: a verifier that remembers when it last checked a key
against KV can refuse anything checked earlier and look again. Nothing reads it yet.

**How long a revoked key keeps working.**

| Where | Bound | Kind of number |
|---|---|---|
| This API | None: the `Tenant` object is asked on every request | Tested here |
| Edge, in an isolate that has the key cached | Up to 60 s after KV shows the change (`HIT_TTL_MS` in `edge/src/auth.ts`) | Tested here with edge's clock parameter: accepted at 59 s, refused at 60.001 s |
| KV propagation to other locations | Cloudflare documents "up to 60 seconds or more"; there is no hard upper bound | Training knowledge, not measured |
| Total on the data path | Modelled: roughly 0 to 120 s, and longer if KV is slow | Modelled. `design/VERIFICATION.md` §4 style experiment: disable a key on a deployed viz-* stack and time the first 401 from several regions |

A deleted key is the same: edge's cached hit lives 60 s. If KV itself is down when a key
is revoked, the response says `"kv": "pending"` and the write is retried every 30 s; the
key keeps working at edge until it lands.

**Usage.** `Tenant.recordUsage(tenant, [{ keyId, at, samples }, …])` is the interface, to be
called with batches (one call per flush interval, not per request). It keeps hourly
buckets, so "samples in the last 24 h" is to the hour. Until something calls it,
`lastUsedAt` and `samples24h` are `null` for every key. Nothing calls it today.

### Dashboards (screens 1 and 7)

A revision is the whole spec, its content hash (`revisionOf`; this is `baseRevision` and
the `ETag`), and a number counting from 1 (what people say: "revision 14").

| Operation | Notes |
|---|---|
| `POST /dashboards` | `validate` errors refuse (422, each with path and suggestion); `lint` warnings are returned. Optional `owner`, `message` |
| `GET /dashboards/{id}` | `?view=spec` (default), `outline`, or `resolved` with `var.<name>=<value>`; `?revision=<n>` for an old one |
| `GET /dashboards` | `q` (name, id, intent, owner, tags), `tag`, `owner`, `deleted=true`; returns name, intent, tags, owner, panels, last changed at and by whom, `total`, and `state: null` |
| `PATCH /dashboards/{id}` | RFC 6902 `ops` against `baseRevision` or `If-Match`. Stale: 409 `stale-revision` with `currentRevision`, `currentNumber`, `changedUnderneath` (a diff summary from the base to now) and `revisionsSince` (who, when, message) |
| `POST …/revisions/{n}/revert` | A new revision with the old content |
| `DELETE /dashboards/{id}`, `POST …/restore` | Soft: not listed, restorable for 30 days, then purged by the alarm with its revisions and proposals |
| `GET …/revisions`, `GET …/revisions/{n}` | Who, when, message, kind, diff summary, proposal and proposer if any |
| `PUT …/owner` | The owner column of screen 1 is control-plane metadata, not part of the spec |

- **Dry run.** Every write takes `dryRun: true` (or `?dryRun=true`). The same code runs
  inside the same transaction, which is then rolled back, so the report (validation, lint,
  diff summary, new revision id and number) is what the real call does. A dry-run key
  creation returns `secret: null`.
- **Caps** (`src/caps.ts`, overridable with `CONTROL_CAPS`): 256 KiB per spec (413), 500
  revisions per dashboard, 64 MiB of revisions and proposals per tenant, 2,000 dashboards,
  200 keys, 50 open proposals per dashboard (all 409, each with a code and a fix).
- **The `state` hook.** `state` is computed from data, which this component never holds.
  `createWorker({ dashboardStates })` takes a function `(tenant, ids) → states`; the list
  then fills each item's `state`. The default Worker has no hook and returns `null`.

### Proposed changes (screen 7)

A proposal is a list of named changes, each a group of ops with a reason, against a base
revision, plus a message.

- **Who gets a proposal.** `POST /dashboards/{id}/proposals` always. `PATCH` when the
  caller sends `"propose": true`, lacks `dashboards:apply`, or is an agent while
  `agentsMayApply` is false: the response is then 202 with the proposal instead of 200.
- **Review.** `GET /proposals/{id}` evaluates the proposal against the dashboard as it is
  now: `moved`, per-change `applies` / `conflicts` / summary, the overall diff summary
  against the current revision, the revision it would produce, lint, and `needsRebase`.
- **`needsRebase`** is set when the dashboard moved and any of these holds: an op fails; the
  result is not a valid dashboard; a change touches a part of the dashboard that was edited
  since the base. The third is what stops a `replace` from silently overwriting someone's
  newer edit. Paths are compared up to the first array index, because indices shift.
- **Apply** (`POST /proposals/{id}/apply`): whole, or `changes: [names]` for a subset (always
  in the proposal's order). Creates a normal revision of kind `apply`, attributed to the
  approver, with the proposal id and the proposer recorded. A partial apply closes the
  proposal. Refused with 409 `needs-rebase`; with 422 `selection-invalid` when the subset
  depends on a change left out; with 409 `stale-revision` when the reviewer names the
  revision they looked at and it is no longer current.
- **Edit first** (`PUT /proposals/{id}`): the proposer or anyone who may apply replaces the
  changes with ones that fit the current revision, which also rebases it. Editors are
  recorded.
- **Decline** needs a reason. A proposer may withdraw their own.
- **Expiry**: 30 days by default (`general.proposalTtlDays`, 1 to 90). An overdue proposal
  counts as expired at once; the alarm then closes it and writes the audit entry.
- **Agents.** An agent may not apply a proposal it wrote or edited, whatever scopes its key
  has, unless `general.agentsMayApply` is true (default false). For the same reason an
  agent's direct patch becomes a proposal, and its create, revert, delete and restore are
  refused with 403 `agents-may-not-apply`.

**Proposals that create a dashboard** (`POST /proposals` with `{ spec, message }`). The same
flow for a dashboard that does not exist yet, so an agent can put a new dashboard in front of
a person for review instead of describing it in text.

- **Proposing** needs `dashboards:write`. The spec is validated with the dashboard package's
  `validate` (422 `invalid-dashboard`, each error with its pointer and suggestion, exactly as
  `validate` reports it), and its id must be free: 409 `dashboard-exists` (live) or
  `dashboard-deleted` (restorable). Size caps and the per-id cap of open proposals apply.
  Nothing else is written: no dashboard, no revision. The proposal is `kind: "create"`,
  `dashboard` = the id it would create, `baseRevision` "" and `baseNumber` 0, no `changes`;
  the spec is in the full view, not in lists.
- **Review** (`GET /proposals/{id}`) validates the stored spec again and checks the id
  against the tenant as it is now: `exists`, `reasons`, the one-line summary, and the
  revision it would become (number 1) with lint. `current` is null.
- **Apply** is whole (no `changes`, no `baseRevision`; 422 otherwise) and needs the right
  to create dashboards directly: `dashboards:apply` (or `admin`) and, for an agent,
  `agentsMayApply`. So an agent key is refused with 403 `agents-may-not-apply` whatever its
  scopes, its own proposal or another agent's, unlike a change, which an agent with the
  apply scope may apply for another. The spec is validated again; the dashboard is created by
  the same code as `POST /dashboards`, its revision 1 of kind `apply` with the proposal and
  proposer recorded, and the person who applied it as creator. One audit entry,
  `proposal.apply`, with `created: true`.
- **Idempotent.** The same caller proposing the same spec (same `revisionOf`) while its
  proposal is open gets that proposal back: 200 `outcome: "unchanged"`, nothing written,
  no audit entry, whatever the message says. Another caller, or another spec, is another
  proposal. Applying twice, or two applies at once, creates one dashboard and one revision;
  the second is 409 `proposal-closed` with `appliedNumber`. Once one proposal for an id is
  applied, another for the same id reviews as `exists: true` and is refused with 409
  `dashboard-exists`.
- **Edit** (`PUT /proposals/{id}` with `spec`) by the proposer or anyone who may apply:
  validated, same id (422 otherwise); `ops`/`changes` are refused, as `spec` is for a change.
  Decline and expiry are as for any proposal. Purging a deleted dashboard deletes its
  proposals but keeps an open proposal to create one under that id.

### Settings

`GET /settings`, `GET /settings/{section}`, `PUT /settings/{section}` with
`{ value, version?, confirmShorter?, dryRun? }`. Each section has a version, counted from 1;
`version` in the request makes the write conditional (409 `stale-version`).

| Section | Value | Published to KV |
|---|---|---|
| `general` | `{ agentsMayApply, proposalTtlDays }` | no |
| `retention` | `{ metric_samples_days, metric_5m_days?, metric_1h_days?, log_days?, trace_days? }`, 1 to 3650 days, coarser tiers not shorter than finer ones. The value replaces the stored one, so a field left out returns to its default. Any change that shortens what is kept needs `confirmShorter: true`, a field left out included (below) | `retention:<tenant>`, the value as is |
| `limits` | `{ active_series, samples_per_second, query_max_series, query_max_samples, query_timeout_seconds, query_max_range_days, query_concurrency }`, any subset. `LIMIT_CEILINGS` (JSON, operator) caps them | `limits:<tenant>`, the value as is |
| `pool` | `{ pool, slots, spread }`. The pool must be the tenant's dedicated pool, `dedicatedPool(tenant)`: `tenant/<id>` with `_` written `-`, or the shared pool of `DEFAULT_POOL`, and one edge accepts (`validBasePool`: `POOL_NAME`, and no `/traces` or `/logs` suffix; D66, below) | `pool:<tenant>` → `{ pool, slots, spread, epoch }` |
| `notifications` | `{ email[], webhookUrl, webhookFormat, sendResolved, webhookSecret }`. `webhookFormat` is `alertmanager` (default) or `json` (`viz.notification/v1`); `webhookSecret` (16–512 characters) is **write-only**: kept in `tenant_meta`, never in the value, so no read, list or audit entry holds it; the value shows `webhookSecretSetAt` instead. Left out, the secret is kept while `webhookUrl` is unchanged and dropped when it changes; `null` removes it. The ruler's notifier sends to this webhook as its receiver `viz:default` (below). `email` is stored, not acted on | no: read over the binding (`notificationTarget`), so the secret is not in KV |

**Retention.** A PUT replaces the stored value, as in every section, so a field it leaves out
returns to its reader's default: 30 days for `trace_days` and `log_days` (the janitor's
`DEFAULT_SIGNAL_DAYS`), and nothing known for a rollup tier, which has no reader yet. Whether a PUT
shortens retention is judged on what is kept before and after, field by field, with those
defaults (`KEPT_WHEN_ABSENT` in `src/ops-settings.ts`; D63, revised after review B-1 of
`design/reviews/signals-end-to-end.md`). So `{"metric_samples_days": 60}` over `{30, trace_days:
365, log_days: 400}` is refused with 422 `confirmation-required`, `shortened` and `leftOut` both
`["log_days", "trace_days"]`, and a `fix` that says to send them too. A signal set for the first
time below 30 days is a shortening as well, and so is a rollup tier that was set and is left out.
Until this change only the fields the new value named were compared: that PUT was accepted, and
the janitor then kept traces and logs 30 days.

**Pool map.** The first map gets the shared map's epoch plus one; raising `spread` bumps
the epoch. Everything else (another pool, another slot count, a smaller spread) is refused
with 409 `pool-change-unsupported`, because it needs the drain-and-handover protocol of
DESIGN §4.1, which is out of scope here. The pool must be one edge accepts as a map's pool, by
edge's own function, `validBasePool` (`shard/src/pool.ts`, moved there from `edge/src/route.ts`
so both import it; D66, revised after review M-5). That means a valid pool name (`POOL_NAME`: no
`_`, at most 120 characters) that does not end in `/traces` or `/logs`, the suffixes of the
derived span and log pools (`contracts/BATCH.md`, "Streams per signal"). Anything else is refused
with 422 `invalid`, field `pool`: edge would turn every write of the tenant into a 503. The
tenant's dedicated pool is `dedicatedPool(tenant)`: `tenant/<id>` with `_` written `-`, so tenant
`acme_prod` gets `tenant/acme-prod`. Asked for `tenant/acme_prod`, control refuses and names
`tenant/acme-prod`. Two ids that differ only there share their dedicated objects, each with its
own map, streams and epoch (D38). Tenants `traces` and `logs` can be created (tenant ids are
unchanged) and use the shared pool, but cannot have the dedicated pool `tenant/<id>`. A shared pool
(`DEFAULT_POOL`) that breaks the rule is refused for every tenant, with a fix for the operator.

### The service surface (`contracts/control.ts`, decision D39)

Two RPCs on `Tenant`, reachable only through the Durable Object binding (viz-ruler binds it by
`script_name`, as the gateway does for `provision`); no HTTP route leads to them. Both answer
`not_provisioned` for an object bound to another tenant or not provisioned, `schema_too_new`
when a newer release holds the storage, and carry `v: 1` (formats `rpc.notification-target`,
`rpc.service-key`, golden files under `test/golden/formats/`).

- **`notificationTarget(tenant)`** → `{ version, target: { url, format, sendResolved, secret } | null }`:
  the `notifications` section as the notifier needs it, secret included. The secret is given
  only while the stored value's `webhookSecretSetAt` equals the time it was set, so a value an
  older release rewrote without the field leaves requests unsigned rather than signed with a
  secret nobody set for that URL. Read only.
- **`serviceKey(tenant, service, instance)`** → a key `viz_<keyId>_<secret>` named
  `service:<service>/<instance>` with the scopes the contract fixes (`viz-ruler`: `read`,
  `write`). Created on the first call, rotated on every later one (the previous secret ends at
  once, revocation generation bumped), one audit entry `key.service` by `system:viz-ruler`. It
  is an ordinary key: listed, and a person can disable it (then the call answers `disabled` and
  issues nothing until it is enabled) or delete it (the next call issues a new one). Names
  starting with `service:` are refused for keys a person creates (422), so a person's key can
  never be taken over by a rotation. Counts against the tenant's key cap.

No schema migration: the secret is a row of the existing `tenant_meta` table (k
`notifications.webhookSecret`), and the `notifications` value only gains optional fields, which
a release that does not know them shows as they are; schema version stays 2.

### OAuth for agents (`contracts/oauth.ts`, decision D44)

The control plane is the OAuth 2.1 authorization server for the agent surface's `/mcp`, as the
MCP specification's "Authorization" section (revision 2026-07-28,
https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) describes: an MCP
client (Claude, an IDE agent) gets a token a person approved, scoped to what that person's key
holds, revocable, and good only at `/mcp`. mcp/README.md describes the resource side.

**Endpoints** (outside `/api/v1/control`, no API key; the gateway routes them here).

| Endpoint | What it does |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414: issuer `PUBLIC_URL`, the endpoints below, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, the five grantable scopes, `authorization_response_iss_parameter_supported: true` (RFC 9207). `registration_endpoint` only when the signing key is set |
| `POST /oauth/register` | RFC 7591, public clients only. **Stores nothing**: the client id is the registration (name, redirect URIs, issue time), signed with HMAC-SHA-256 under the Worker secret `OAUTH_CLIENT_KEY` (format `id.oauth-client`). Redirect URIs: 1 to 5, https or http on `localhost`/`127.0.0.1`/`[::1]`, no fragment, no user info, no spaces or backslashes, **ASCII only** (a bidirectional or invisible character could make the URI read as another on the consent page; percent-encode, and write an IDN host as punycode: review of D44, m-3), at most 512 characters. Confidential auth methods, other grant or response types and unknown scopes are refused. 503 without the key |
| `GET /oauth/authorize` | Validates the request: the client id's signature, the redirect URI **exactly** equal to a registered one (else 400 and nothing is sent anywhere), `response_type=code`, a 43-character `code_challenge` with method `S256` (plain and none refused), known scopes (default `read dashboards:read monitors:read`), one `resource` equal to `<PUBLIC_URL>/mcp` (scheme and host compared without case). It answers a **plain-text page** (no markup, `no-store`, CSP `default-src 'none'; frame-ancestors 'none'`): what is asked and how a person approves it, with a request handle (format `oauth.request`). Errors the client should hear about are shown with the callback link that would deliver them; **this server never redirects by itself** (every redirect URI is the client's own claim, so an automatic redirect would make it an open redirector) |
| `POST /oauth/token` | `authorization_code` (with `code_verifier`, `redirect_uri`, `client_id`, `resource`) and `refresh_token`. Form encoding only; a parameter sent twice, an `Authorization` header or a `client_secret` is refused. A code or refresh token without this deployment's tag (below) is `invalid_grant` **without asking any tenant's object**. Answers `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope }`, `Cache-Control: no-store` |
| `POST /oauth/revoke` | RFC 7009 with `token` and `client_id`. An access token ends alone; a refresh token ends its grant. Unknown tokens and tokens of another client: 200, nothing changes; one without the tag reaches no object |

Every body here (and the control API's own) is read from the stream with a cap: one sent without
`Content-Length` is never buffered past the limit (16 KiB for the form endpoints, 8 KiB for
registration, 1 MiB for the API; review of D44, m-2).

**The gateway** (`deploy/gateway/src/index.ts`) forwards exactly these five paths here and
`/.well-known/oauth-protected-resource` and `…/mcp` to viz-mcp; near misses (`/oauth`, `/oauth/x`,
`/oauth/token/`, `/.well-known/openid-configuration`, `…/oauth-authorization-server/x`,
`…/oauth-protected-resource/x`, …) are 404 (`gateway.test.ts`, 7 routed paths and 11 near
misses; the gateway suite passed 95 of 95). Its three OAuth mutants (paths not routed; matched as
prefixes; the resource metadata sent to control) were run in a scratch copy on 2026-11-19
(`node gateway/scripts/mutants.mjs "OAuth:"`): 3 of 3 killed. `deploy/README.md`'s route table
does not list these paths yet (another engineer's file).

**The consent step: `POST /api/v1/control/oauth/approve`** (route table, scope `admin`, audited,
`dryRun`). There is no sign-in and no web UI yet, so the person approves through the API with
their own key: `{ "request": "<handle from the page>", "scopes"?: [...] }`.
- Only a **person**: kind `key` (later `user`) with `admin`. An agent key is refused with 403
  `approver-not-a-person`, whatever its scopes. Until a person signed in can be followed the way a
  key is, **only an API key approves**: an approver whose subject is not `key:<id>` is refused
  (403 `approver-not-a-key`; review of D44, M-1), and `Tenant.invoke` accepts no identity without
  an API key in the first place.
- The grant holds the requested scopes (or the subset in `scopes`; a scope not asked for is 422)
  **that the approving key itself holds**; `admin` counts for the dashboards scopes it stands for
  in this API, never for `read` or `monitors:read`, and is never granted itself. The rest are
  `withheld` and named. Nothing in common: 403 `nothing-to-grant`.
- The handle is checked again in full (it is not trusted from the page): signature, age of an
  unbound registration (24 h), exact redirect URI, resource, scopes.
- `dryRun: true` is the consent preview: the grant exactly as it would be, `redirect: null`,
  nothing stored.
- Approval stores the client in the tenant (first time), the grant, the grant's key
  `oauth:<grantId>` (kind `agent`, the grant's scopes, expiring with the grant; published to KV
  like any key) and the code; one audit entry `oauth.grant.approve`. The answer carries
  `redirect`: the client's callback with `code`, `state` and `iss`, which the person opens in
  the browser that started the connection (within 10 minutes), plus `returnsTo` (host and URI)
  and `warnings` (the client's name is unverified; approve only a connection you started
  yourself, since anyone can make an authorization link and send it, said for every redirect,
  review of D44, m-5; a loopback callback can be received by any program on that computer; what
  was withheld). The authorize page says the same for every redirect.
- Bounds per tenant: 20 approvals in any hour (429 with `Retry-After`), 50 clients, 50 live
  grants, and each grant's key counts against the 200-key cap.

**What the UI must later show** (and what this step stands in for until then):
1. A consent page for a signed-in person, after `/oauth/authorize` validated the request: the
   client's name **marked as its own unverified claim**; the redirect URI's **host**, prominently
   (MCP "Localhost Redirect URI Risks": MUST), with the loopback warning; each scope in plain words,
   which of them the person's own access lacks (withheld) and a way to untick any; the resource;
   the lifetimes (1 h tokens, renewed for at most 90 days, revocable); which tenant is granted.
2. Approve and Deny. Deny sends `error=access_denied` with `state` and `iss`; approval sends the
   code. Once a signed-in person has decided, the page may redirect to the validated callback.
3. Protection for the form: CSRF token bound to the session, `frame-ancestors 'none'`, and a
   fresh sign-in for approval.
4. A grants screen (settings): client, scopes, approved by, created, last used, expires, status
   (`live`, `suspended`, `revoked`, `expired`) and why it ended; revoke; suspend and resume (the
   grant's key disabled and enabled). Grant-related audit entries alongside.
The interface goes through design review (AGENTS.md, "Design changes"); none is built here.

**Grants, tokens and their lifecycle.**
- Codes: single use, 10 minutes, bound to the client, the exact redirect URI, the PKCE challenge
  and the resource. **Any failed exchange spends the code**; a second use of a code (also after a
  failed one) **revokes the grant**, and with it any tokens it issued (OAuth 2.1 §4.1.3).
- Access tokens: 1 hour, the grant's resource as audience. Refresh tokens: 30 days, **rotated on
  every use**; a used one is kept a day, and presenting it again (or presenting any refresh token
  with another client's id) **revokes the grant**. A refresh may narrow the scope, never widen it.
- A grant ends at 90 days, when its code was never exchanged (alarm, `not-exchanged`), when its
  refresh token went unused 30 days (`idle`), when its code is spent by a failed exchange
  (`exchange-failed`: wrong verifier, client, redirect URI or resource; nothing was issued, so it
  could never issue), on reuse (`code-reuse`, `refresh-reuse`, `wrong-client`), by the client (RFC 7009, `client`) or by a person
  (`POST /oauth/grants/{id}/revoke`, `person`). Ending a grant deletes its tokens and code and
  its key (from KV too, revocation generation bumped), in one transaction, one audit entry. Ended
  grants stay listed 90 days (`GET /oauth/grants?status=all`); a client with no live grant is
  deleted after 30 days (`oauth.client.expire`).
- The grant's key may be **disabled** like any key (the grant is `suspended`: the resource refuses
  its tokens; refresh still rotates) and enabled again; it cannot be rotated or deleted on its
  own (409 `grant-key`: revoke the grant), and persons cannot create keys named `oauth:…`.
- **A grant follows its approver's key**, so it is never broader than that key later either:
  while the approver's key is disabled the grant is `suspended`; once it is deleted or expired
  the resource and the token endpoint refuse the grant at once, and the alarm ends it
  (`approver-gone`) with its key: at once for a deletion, and at the key's `expiresAt` for an
  expiry (an alarm deadline since the review of D44, m-1). **It fails closed**: a grant whose
  recorded approver is not a key counts as ended (`revoked` at introspection, `approver-gone` at
  the next alarm).

**What is stored, and the service surface.**
- Codes and tokens are stored as the SHA-256 of the whole string (format `credential.oauth`:
  `<vzc1|vza1|vzr1>.<tenant>.<43 base62>`; the tenant is in clear so the server can find the
  tenant's object, which then holds only the hash, so a credential edited to name another tenant
  matches nothing there).
- **The 43 characters are a 27-character body and a 16-character tag** (`contracts/oauth.ts`
  `CREDENTIAL_TAG`): HMAC-SHA-256 under a key derived by HKDF from `OAUTH_CLIENT_KEY` (its own
  salt, so not the registration key itself), over prefix, tenant and body, each of the first 16
  bytes as `BASE62[byte % 62]` (about 95 bits). Since the review of D70 the body is layout 2: the
  marker `e`, the credential's expiry in 4 characters, and 22 random ones (about 131 bits); the
  Worker refuses one past its expiry like a made-up one ("Rate limits in front of OAuth", 0).
  Layout 1, issued before, is 27 random characters (about 160 bits) and still served. The
  token endpoint, revocation and `OAuthIntrospection` check it in the Worker, before any tenant's
  object is asked: a made-up credential, for a tenant that exists or not, reaches no object and
  writes nothing (review of D44, M-2). The tag makes nothing valid; the object's hash does.
  Without `OAUTH_CLIENT_KEY` nothing is minted (approve answers 503 `oauth-unavailable`) and every
  credential is refused before the object. **Replacing the key ends every code and token too.**
- **The grant key's secret is never stored in clear.** It is sealed (AES-256-GCM, key derived by
  HKDF-SHA-256 from the credential, tenant and grant authenticated; format `oauth.sealed`) under
  each live code, access token and refresh token. Only a request presenting one of them can
  recover it, so neither a dump of the object nor a stolen database yields a working credential.
- `Tenant.oauthToken`, `oauthRevoke` and `introspectAccessToken` (`contracts/oauth.ts`
  `TenantOAuthRpc`, results `v: 1`, format `rpc.oauth`) are reachable only through the Durable
  Object binding, which only this Worker uses for them: the first two from its `/oauth/*`
  handlers, the third from **`OAuthIntrospection`** (`src/introspection.ts`), a named
  `WorkerEntrypoint` export of this Worker and the one thing the agent surface binds here
  (`{ "binding": "OAUTH", "service": "viz-control", "entrypoint": "OAuthIntrospection", "props":
  { "caller": "viz-mcp" } }`, review of D44, M-1). Its whole surface is
  `introspectAccessToken(token, resource)`: a caller whose `props.caller` is not in
  `OAUTH_INTROSPECTION_CALLERS` (`viz-mcp`) gets `{ v: 1, status: "unauthorized" }`; the tenant is
  the one the token names (no tenant argument); a token not shaped like an access token, or
  without the tag, is `inactive` (`unknown`) and reaches no object. viz-mcp holds no binding to
  the `Tenant` class any more, which could call every method of every tenant's object (`invoke`
  with a made-up identity, `provision`, `serviceKey`, `notificationTarget`). Introspection checks the
  token's expiry, its grant's state, the audience (the resource the caller names must be the
  grant's), and the key's state, then returns the identity (`key:<id>`, kind `agent`, the
  grant's scopes, `mayApply` as `whoami` computes it) and the grant's key for downstream calls.
  It answers `inactive` with a reason (`unknown`, `expired`, `revoked`, `suspended`,
  `audience`), and `not_provisioned` for another tenant.
- **Storage: schema version 3** adds four tables (`oauth_clients`, `oauth_grants`, `oauth_codes`,
  `oauth_tokens`), `readableFrom: 1`: additive; the previous release opens it unchanged and
  ignores them (tested). Rolled back to it, OAuth stops (no token endpoint, no introspection),
  and each grant's key stays an ordinary agent key that expires with its grant.
- The alarm also wakes for: a grant's end, an unexchanged code's expiry, a grant going idle, a
  client to forget, an ended grant to delete, and an approver key's expiry. Expired and rotated
  tokens are deleted on the next refresh of their grant and by any alarm.
- **A token request or a revocation that changed nothing writes nothing.** The alarm is set (and
  KV published) only after one that wrote a row (`Tenant.rowsWritten`, a counter of this
  instance's own statements, compared before and after): each `setAlarm` is billed as a row
  written, and before the review of D44 (M-2) every such request, a made-up one included, set
  it twice.

### Rate limits in front of OAuth (D70)

**Production has served OAuth without any of this since 2026-11-19**, when the owner deployed `main`
at PR #8 (`vis.bitcru.sh`): the endpoints are public with the tag and the object's checks, reuse
detection included, and without layer 1, the expiry check in the Worker or the list. "Required
before OAuth is exposed publicly" (review of D44, M-2) **was not met**; this change, with the deploy's
gate ("Needed changes elsewhere"), is the remedy. Revised again on 2026-11-26 after the third look
(`design/reviews/d70-rate-limits-r3.md`, reject until R3-B1 is fixed): dispositions under "Round 3"
in "How it was verified".

Required before OAuth is exposed publicly (review of D44, M-2). Rewritten after D70's adversarial
review (`design/reviews/d70-rate-limits.md`). The review rejected the first layer as first built:
one dead credential of a tenant could spend that tenant's budgets (B-1). The first layer also
counted genuine credentials by network, and every client on Cloudflare Workers shares one address
(M-1). **Changed again after the second review** (`design/reviews/d70-rate-limits-r2.md`, approve
with changes): a wider key is asked only while every narrower one was checked (R2-M1); a list of
credentials found dead (R2-M2, the owner's choice over accepting the residual); an even share of
the budget per check (m-1); expired genuine credentials not counted by network (m-2); and the
grant view counts refreshes (R2-M2). The dispositions are under "Round 2" in "How it was verified".

The tag already keeps a made-up credential away from every object. What is left is cost and abuse.
Its measured shape decided the keys ("How it was verified", the cost table):
- Registration, the authorization page and a made-up credential cost the Worker alone (0.2–0.5 ms
  here, nothing written), and anyone can send them.
- What reaches a tenant's object is a credential this deployment made. An exchange or a refresh
  writes 9 rows and 2 `setAlarm`. A replay of a spent or revoked one costs an object request and
  writes nothing.

**0. Credentials carry their expiry** (`contracts/oauth.ts`, layout 2; `src/oauth.ts`
`mintCredential`, `credentialExpired`). The 27 characters before a code's or token's tag are now
the marker `e`, its expiry and 22 random characters. The expiry is in whole minutes since
2026-11-01, rounded up: never earlier than the expiry its row stores. The tag covers it.
- `/oauth/token`, `/oauth/revoke` and `OAuthIntrospection` refuse a tagged credential once its
  expiry and `EXPIRY_GRACE_MS` (60 s, for the Worker's clock against the object's) have passed. A
  code dies in the Worker 10 minutes after issue, an access token after an hour.
- The refusal is the answer the object would give: `invalid_grant`, 200 at revocation, `inactive`
  `expired` at introspection. It comes before any rate limit counts the request and before any
  object is asked, and it is not counted against the sender's network either: the credential is
  genuine and its HMAC is paid (round 2, m-2; before, the token endpoint and revocation counted it
  there, so a broker presenting its users' month-old tokens could get 429 instead of `invalid_grant`).
- The shape and the tag are unchanged, so a release that knows only layout 1 reads layout 2.
- A layout 1 credential, issued by the previous release, carries no expiry. It goes to its object as
  before until it expires there.

**0b. Credentials found dead are listed** (`src/deadlist.ts`; round 2, R2-M2). A dead credential
that has not expired (a rotated refresh token, one of a revoked grant, an access token of an ended
grant) has a good tag and a future expiry; only its tenant's object knows it is dead. Without a
record, each replay reached the object and counted against the tenant's fuse for the credential's
whole life, 30 days for a refresh token. Anyone holding one live refresh token of a grant, its
client or a thief of an idle grant's token, can collect them at layer 2's limit (6 a minute) and
replay the stock after the grant has ended.
- **When**: the tenant's object says so (contracts/oauth.ts, a promise of the contract):
  `invalid_grant` on the `refresh_token` grant; `inactive` with `unknown`, `expired` or `revoked`
  at introspection (`DEAD_INACTIVE_REASONS`; never `suspended` or `audience`, which can come back);
  `dead: true` from revocation, a field added to `RevokeResult` because RFC 7009 answers 200
  either way (a stock replayed at `/oauth/revoke` would otherwise never be listed). The object sets
  `dead` when the token was unknown or of an ended grant, an unrotated one had expired, or this
  revocation ended it; any token of a live grant that another client presented is `dead: false`,
  **a rotated refresh token included** (round 3, R3-B1).
- **The rule** (round 3, R3-B1): nothing is listed whose later presentation must still reach the
  object. Reuse detection ends a stolen grant only when the other holder of a rotated refresh token
  presents it; round 2 listed such a token when anyone revoked it under another client id, so a thief
  could list the owner's copy and keep the grant (reproduced by the review). Each place that lists is
  checked against the rule in `src/deadlist.ts`'s header: the token endpoint (no row; a grant ended or
  unable to issue, a rotated token having just ended its grant; or a token this request spent with
  nothing issued, which leaves the grant no unrotated refresh token), introspection (access tokens,
  which reuse detection does not watch) and revocation (only what is ended; not a rotated row past
  its own expiry either, which inside the Worker's grace still reaches reuse detection).
- **Where**: in the isolate at once (a map of hashes to expiries, at most `ISOLATE_ENTRIES`, 10,000,
  oldest dropped first), and in `CONFIG`, the viz KV namespace this Worker already binds (titled
  `viz-config` by the deploy, `deploy/workers.json`; not the account's unrelated namespace titled
  `CONFIG`), under a prefix of its own: `oauth-dead:<tenant>:<SHA-256 of the credential, hex>` →
  `{"v":1,"reason":…}` (format `kv.oauth-dead` 1, `test/golden/formats/kv.oauth-dead.v1.json`). KV's
  absolute `expiration` is the credential's encoded expiry plus `EXPIRY_GRACE_MS`, so the list never
  holds what the expiry check refuses anyway. Nothing is written for layout 1, or with less than
  KV's 60 s minimum left.
- **Checked** at `/oauth/token` (refresh tokens; codes die within 12 minutes and each needs a
  person's approval), `/oauth/revoke` and introspection, after the tag, the expiry and the
  credential's own limit, and before its tenant's fuse (round 3, m-1; `firstRefusal`'s `listed`):
  answered as the object answered (`invalid_grant`, 200, `inactive` with the recorded reason), counted
  against its own allowance only, its network not at all. So cycling dead credentials costs at most
  one KV read per allowed request (5 a minute per credential per location), and a listed and a live
  token are counted alike (R3-M1). Consulted whatever the narrow limiter's verdict but a refusal.
- **Reads**: the isolate's map, then one KV read of at most `DEAD_READ_MS` (100 ms). A credential KV
  does not list is remembered so for `NOT_LISTED_MS` (60 s): a live token costs at most one KV read
  per isolate a minute.
- **Writes**: one per dead credential per isolate (an isolate that recorded or read it never asks
  the object again; concurrent replays write once), through `ctx.waitUntil` off the response's path
  when there is a context (the tests have none and await it). Every write is of a credential this
  deployment minted, so writes follow what layer 2 lets be minted, never what a request asks.
- **Eventually consistent**: about 60 s for a write to be seen elsewhere, and up to 60 s of a cached
  absent read (training knowledge; not measured). Until then each isolate of another location may ask
  the object once more and learns it there. The window's consequences and the costs are in D70.
- **Fails open**: without `CONFIG`, or when a read throws or overruns, the credential counts as not
  listed and the failure is logged once per isolate. A read over 100 ms affects its key only (not
  listed for 60 s in that isolate; round 3, m-2: a cold key is slow, and anyone can make one); a read
  that throws is KV failing, and KV reads are then skipped for 10 s in that isolate (its own map
  still applies). A failed write is logged once and not retried. `/healthz` says
  `OAUTH_DEAD_LIST: bound|absent|skipped`.
- **What it shows**: `refreshesLastDay` in the grant view (`GET /oauth/grants`, contracts/oauth.ts
  `OAuthGrantView`, an additive field), counted from the refresh-token rows reuse detection keeps a
  day: about 24 for a client refreshing hourly, up to 8,640 for one rotating at the limit, which is
  how a stock is collected. The revocation's audit entry keeps the last count (its `before`). Keys
  under `oauth-dead:<tenant>:` count a tenant's replayed dead credentials.

**1. Approximate, before any object: Cloudflare's Rate Limiting binding** (`src/ratelimit.ts`).
Per Cloudflare location, eventually consistent, a 60 s window each. The limits are the bindings'
configuration, which the deploy does not create yet ("Needed changes elsewhere"):

| Binding | Counted per | Where, and when | Proposed limit / 60 s | In the tests |
|---|---|---|---|---|
| `OAUTH_RL_SOURCE` | client network: IPv4 address, IPv6 /64 (an IPv4-mapped address as IPv4), from `CF-Connecting-IP`; without one, one shared key; Cloudflare's Workers address (`2a06:98c0:3600::103`) not at all | `/oauth/register` (POST) and `/oauth/authorize` (GET, HEAD), first thing, before the body is read; `/oauth/token` and `/oauth/revoke` only for a request without a genuine credential (malformed, or no tag) | 120 | 5 |
| `OAUTH_RL_SOURCE_48` | the IPv6 /48 | the same, after the /64 | 1,200 | 8 |
| `OAUTH_RL_CREDENTIAL` | the presented code, refresh token or access token (SHA-256 prefix), tagged, not expired, not listed dead | `/oauth/token` and `/oauth/revoke`, before the object | 5 | 3 |
| `OAUTH_RL_TENANT` | its tenant: a fuse | the same, after the credential | 6,000 | 12 |
| `OAUTH_RL_BEARER` | the access token (SHA-256 prefix), tagged, not expired, not listed dead | `OAuthIntrospection`, before the object | 1,200 | 3 |
| `OAUTH_RL_BEARER_TENANT` | its tenant: a fuse | the same, after the token | 30,000 | 12 |

- **After the tag and the expiry**: only a credential this deployment made, and that has not
  expired, is counted against a credential or a tenant. A made-up or expired credential naming a
  tenant spends nothing of it.
- **The credential first**, and a refused call does not count. So one credential spends its own
  allowance and at most that much of its tenant's fuse. A fuse takes (fuse ÷ per-credential) distinct
  credentials that stay countable to spend: 1,200 at the token endpoint and 25 at introspection, in
  production; a dead one counts until the list reaches where it is sent, then never.
- **A wider key only while every narrower one was checked** (round 2, R2-M1). When the credential's
  (or bearer's, or /64's) binding is absent, failed or is skipped, the request is not counted
  against the wider key either: the chain fails open together. So while a narrow limiter is down in
  an isolate (10 s per failure), its fuse counts nothing there; dead credentials reach the object
  once each and are listed, live ones as often as they are sent, and layer 2 still bounds writes.
  The version before asked the fuse alone, and one dead credential spent it again (reproduced by
  the review, N2 and N2b).
- **No per-client key.** The first version keyed the token endpoint on the presented `client_id`,
  which the request chooses (R1). A verified one would be no better, since client ids are public and
  any dead credential sent with one spends it (R1b).
- **A genuine credential is never counted by its network** (M-1), expired or listed dead included
  (round 2, m-2). Registration and the authorization page count every request's network. The token
  endpoint and revocation count only the requests they refuse by themselves without a genuine
  credential, after reading them: a missing or malformed parameter, a code at revocation, or a
  credential without the tag. Such a request costs one HMAC (0.28–0.33 ms here).
- **Cloudflare's Workers address is not counted at all.** Every cross-zone subrequest from a Worker
  arrives as `2a06:98c0:3600::103` (Cloudflare's headers page, read 2026-11-19), so counting it would
  let anyone with a Workers account refuse every Worker-hosted client. What it can reach without a
  genuine credential costs Worker CPU only.
- **IPv6 by /64, then /48** (m-6): one host with a routed /48 holds 65,536 /64s.
- **Not counted**: the RFC 8414 metadata (static, `max-age=300`), CORS preflights (the first version
  counted one of the authorization page, m-3), and a method an endpoint does not serve.
- **The proposed limits** (modelled, not measured on real traffic):
  - A person connecting makes 3 to 5 requests, and a client presents a code or refresh token once.
    5 per credential leaves room for retries after a 429 or 503.
  - An agent's parallel tool calls fit in 20 a second per access token (m-5).
  - The token fuse, 100 a second, is 20 times the most live refreshes layer 2 lets a whole tenant
    make (300 a minute) and 8–21% of one object answering replays (0.75–2.1 ms each, measured here).
  - The bearer fuse, 500 a second, is 10 times 50 grants at one `/mcp` call a second (m-5) and
    45–75% of the introspections one object served here (0.9–1.5 ms each).
  - **Per location** (round 2, m-4): two locations at the bearer fuse are 90–150% of one object's
    introspection rate, which saturates it; five at the token fuse are 38–105% of its replay rate,
    fourteen exceed it. A client holding 25 live access tokens per location can do the first while
    approved (and for a minute or two after); since the list, the token fuse is reachable only by a
    stock of dead credentials in the minutes after its first replay, because a tenant's live
    credentials make at most about 850 token requests a minute per location (14% of the fuse).
- **Assumed**: viz-control and viz-mcp have no Smart Placement (m-8). Placement would gather their
  invocations in few locations and make the per-location fuses nearly global.
  `test/ratelimit.test.ts` checks both `wrangler.jsonc` files.

**2. Exact, in the tenant's object, where rows are written.** At most
`OAUTH_LIMITS.refreshesPerGrantPerMinute` (6) refresh tokens per grant in any 60 s, the code
exchange's included.
- It is counted from the `oauth_tokens` rows the object already keeps: one read, no new state.
- It is checked after reuse detection (a rotated token presented again still ends the grant) and
  before the presented token is spent.
- From any number of locations, a client stuck in a refresh loop writes at most 6 times a minute per
  grant.
- With D44's exact bounds (20 approvals an hour, 50 clients, 50 live grants, all per tenant) this
  bounds what OAuth can make an object store.
- The worst case per tenant (modelled; review m-7) is 50 grants × 6 refreshes a minute × about 11
  billed rows: 3,300 row writes a minute. That is about 4.75 million a day ($4.75 a day at list
  price, training knowledge), and about 432,000 rotated refresh-token rows kept a day. Only the
  tenant's own approved clients can drive it.

**A refusal** is 429 with `Retry-After`, `Cache-Control: no-store`, the endpoints' CORS headers, and
`{ "error": "too_many_requests", "error_description": … }` naming which budget is spent (never a
key).
- `Retry-After` is 60 for a binding, which does not say where in its window it is. For the per-grant
  limit it is the moment its oldest refresh leaves the window.
- The authorization page answers a plain-text page with the same code and header.
- No credential is spent and nothing in the object changes: a refused code, refresh token or
  revocation can be sent again. The narrower keys asked before the one that refused have counted the
  request (m-3). A request the token endpoint or revocation refused by itself has had its body read.
- Why `too_many_requests`: RFC 6749 §5.2 has no rate-limit code, and it is what the MCP TypeScript
  SDK's authorization server sends with 429 at these endpoints.
  - That SDK's client (`@modelcontextprotocol/sdk` 1.32.2 `client/auth.js`, read in
    `mcp/node_modules`) maps it to `TooManyRequestsError` and keeps its credentials.
  - An unknown code becomes a `ServerError`, after which it abandons the refresh and starts a new
    authorization (a person approves again). `invalid_grant` makes it discard its tokens.
  - The Python SDK (`mcp` 2.3.0, `mcp/client/auth/oauth2.py` `_handle_refresh_response`, read in the
    wheel the review unpacked) discards its tokens on any refresh answer that is not 200. For its clients every refusal of a live refresh means a person approves
    again, whatever the code. That is why only the client itself, or someone holding many of the
    tenant's unexpired credentials, can make this Worker refuse a live refresh (above).
- Introspection answers `{ v: 1, status: 'rate_limited', retryAfterMs: 60000 }`, which the agent
  surface maps to 429 with `Retry-After`.

**Every binding check fails open**, deliberately, for every endpoint. A binding that is absent,
throws, rejects, answers without a boolean `success`, or has not answered in time lets the request
through.
- **Time** (m-1): one request's checks have `CHECK_BUDGET_MS` (100 ms), **split evenly** since round 2
  (50 ms for a credential and 50 for its fuse; 100 for an IPv4 source). A binding that has not
  answered within its own share has failed; a slow narrow check can no longer use the fuse's time and
  get the fuse blamed (round 2, m-1, reproduced by the review as N3). The share is a timer, not
  arithmetic on `Date.now()` (n-2). A binding that failed is skipped by that isolate for
  `SKIP_AFTER_FAILURE_MS` (10 s). A limiter brownout therefore makes one request per isolate wait up
  to 50 ms every 10 s, where the first version added 3 s to every refresh and 2 s to every `/mcp`
  request. The list's KV read has its own 100 ms (above).
- **Logs** (m-2): an absent binding (`control: rate limiter <binding> is not bound; …`) and a failing
  one (`… failed; …`, with the reason, never the key) are each logged once per isolate, not per
  request. An absent one is logged whether or not a request comes to ask it (a wider one is not
  asked while a narrower one is absent). The list logs the same way (`control: the OAuth
  dead-credential list …`).
- **`/healthz`** lists, after `ok`, `OAUTH_CLIENT_KEY: set|absent` (never its value), each
  limiter as `bound`, `absent`, or `skipped` (failed in this isolate in the last 10 s), and
  `OAUTH_DEAD_LIST` the same way. An absent limiter does not make it 503; the gateway reads only the
  status.

| Endpoint | Limiter fault | Why |
|---|---|---|
| `/oauth/register`, `/oauth/authorize` | open | they store nothing and reach no object: failing closed would refuse onboarding and protect nothing |
| `/oauth/token` | open | the tag and the expiry still keep made-up and expired credentials from every object, and layer 2 still bounds writes exactly; failing closed would end every agent's access within the hour its token lasts |
| `/oauth/revoke` | open | a revocation ends access; a limiter fault must not keep a grant alive the client wants ended |
| introspection (OAuth bearers at `/mcp`) | open | read only; failing closed would refuse every OAuth request at `/mcp` |
| the expiry check | cannot fail | a comparison in the Worker, under the tag |
| the list of dead credentials | open | a KV fault must not refuse live credentials; the limits, the expiry and layer 2 still apply, and each isolate's own memory of dead credentials still holds |
| the per-grant refresh limit | cannot fail open | it is a statement in the refresh's own transaction |

That the bindings exist is the deploy's to make sure of ("Needed changes elsewhere", the gate), not
something the Worker finds out request by request. Until the deploy creates them, every check is
skipped as absent, logged once per isolate, and `/healthz` says `absent`. Every other test file runs
without them, as such a deployment does.

**The contract** (`contracts/oauth.ts`):
- With the first version, additive within version 1 by COMPATIBILITY.md §4: the status
  `rate_limited` (`RateLimited`) in `TokenResult` and `OAuthIntrospectionResult`, and
  `OAUTH_LIMITS.refreshesPerGrantPerMinute`. The agent surface maps the status to a 429 with
  `Retry-After` (`mcp/src/auth.ts`).
- With the review's fixes: layout 2 of a credential's body (`CREDENTIAL_LAYOUT`, `BASE62`,
  `credentialExpiresAt`). Its shape is unchanged and every version 1 reader reads it, so
  `FORMATS['credential.oauth']` stays 1, and the deploy's format check (D69) has nothing to refuse
  on a rollback.
- With round 2 (contracts first; additive within version 1 by COMPATIBILITY.md §4, new response
  fields): `RevokeResult`'s optional `dead` (absent from older objects: read as unknown, never as
  dead), `OAuthGrantView.refreshesLastDay`, and `DEAD_INACTIVE_REASONS` with the promises the list
  relies on (which answers mean dead for good). `test/golden/formats/rpc.oauth.v1.json` now shows
  `dead: true` on the revocation sample; the previous release's Worker ignores the field, and this
  one lists a revoked token only on `dead: true` (an older object's answer, without it, lists
  nothing; read in `src/oauth-http.ts`, not tested against an older object). New format `kv.oauth-dead` 1, written and read by viz-control only (the
  deploy's format records take it from `FORMATS`; an older release does not read the prefix).

### Audit log

`GET /audit` (filters: `action`, `targetType`, `targetId`, `subject`, `kind`, `since`,
`until`) and `GET /audit/{id}`. Each entry: who (subject, kind, name), when, action, target,
before and after. It is written only inside the transaction of the mutation it describes;
the mutation wrapper throws unless the handler wrote exactly one row. No route writes to
it, no code updates or deletes it, and two SQLite triggers abort any `UPDATE` or `DELETE`
on the table. System actions (provisioning, proposal expiry, purge) are entries by
`kind: 'system'`. Usage reports are not configuration changes and are not audited.

### HTTP

- JSON under `/api/v1/control/…`; `GET /api/v1/control/openapi.json` needs no credential.
- **`GET /healthz`** (and `HEAD`), outside the API and without a credential, as viz-ingest
  and viz-query serve it: what the gateway's `/healthz` calls through its service binding
  (the gateway never forwards `/healthz`, so it is not public). 200 `ok` when the Worker runs
  with its `TENANT` and `CONFIG` bindings; 503 naming a missing one; 405 for other methods. It
  calls no Tenant object and no KV: without a credential there is no tenant to ask, and a
  probe object would be storage of its own to migrate on every release.
- Errors are problem details (`application/problem+json`) with `code` and `fix`.
- Lists return `items` and `next`, an opaque cursor.
- `ETag` on dashboard reads and writes; `If-Match: "<revision>"` instead of `baseRevision`.
- CORS: `CORS_ALLOW_ORIGINS`, a comma-separated allow-list; other origins get no CORS headers.
- Bodies up to 1 MiB, `application/json`. Unknown body fields are refused, not ignored.

### Durable Object rules

- **All state is SQLite.** In memory there is the configuration, the bound tenant (read
  back in the constructor) and a promise that serialises outbox drains. No caches.
- **An object nobody provisioned writes nothing.** A brand-new object (no tables) is not
  migrated on construction; `provision` opens its storage. Until then every entry point answers
  "not provisioned" without touching SQLite. Added with OAuth: an OAuth credential names its
  tenant in clear, so a forged one could otherwise create storage under any name it chose
  (tested: three such names through introspection, the token endpoint and revocation leave no
  table, and no alarm). Since the review of D44 a made-up credential does not reach the object
  at all (the tag, above).
- **A request that changes nothing writes nothing**, alarm included: the OAuth token endpoint and
  revocation re-arm the alarm only after a write (tested with a counter of `setAlarm` and
  `deleteAlarm` calls and of rows written, for unknown codes, refresh and access tokens that carry
  the tag, at the object itself). Mutations already did (`NoChange`, dry runs).
- **Every statement names the tenant** (a test reads the source and checks; the one
  exception reads which tenant the object is bound to).
- **Mutation, audit row and outbox rows commit in one transaction.** KV is written only
  afterwards, from the outbox, in order, by one drain at a time. (The Worker, outside any object,
  writes one other kind of record: the list of dead OAuth credentials, `oauth-dead:`, which holds no
  tenant state, only what an object answered; `src/deadlist.ts`, checked by `test/rules.test.ts`.)
- **One alarm**, at the earliest of: an open proposal's expiry, a deleted dashboard's purge
  time, and, as a third deadline the task did not list, 30 s after a KV publication failed
  (and the OAuth deadlines above). It is deleted when none applies. The handler is idempotent.
- **Tenant identity only from the credential, also over the binding.** `invoke` accepts an
  identity only with an API key id, and replaces what the caller says about the key (subject,
  kind, name, scopes) with the object's own record of it: a holder of the binding cannot make an
  identity up (review of D44, M-1; tested with `key:nobody`, `system:anything`, `user:dana` and a
  real key id given admin scopes it does not have).
- `blockConcurrencyWhile` is used once: in the constructor, around opening (migrating) local
  SQLite, with no await inside. Handlers do not await between reading and writing.

### Versioned storage and formats (`contracts/COMPATIBILITY.md`)

- **Storage.** The constructor opens SQLite with `openSchema(ctx.storage, TENANT_SCHEMA)`
  (`contracts/schema.ts`). Version 1 is the schema exactly as the code before versioning
  created it, so such storage is adopted without a row changing.
  **Version 2** adds one nullable column, `proposals.spec`, for proposals that create a
  dashboard (`readableFrom: 1`, additive: the previous release stays a valid rollback
  target). **Version 3** adds the four OAuth tables (`readableFrom: 1`, "OAuth for agents"
  above); `schemaRelease` is `{ latest: 3, compat: 1 }`. A creation is a row with
  `base_number` 0 and `spec` set; both conditions, because a release that does not know the
  column may rewrite the row. What release 1 does with such a row, read from its handlers
  (not run; see "Known risks"): lists it as a proposal with no changes; shows it with no
  review; declines and expires it. While no dashboard has the id, apply and edit answer 404
  (no such dashboard). Once one has, get and apply answer 404 (they look for revision 0),
  and an edit by the proposer turns the row into an ordinary proposal with `base_number` ≥ 1,
  which this release reads as one (tested by writing such a row). It never creates a
  dashboard from it. Migration 2
  needs the first versioned release to be the rollback floor (COMPATIBILITY.md §6); no
  control from before versioning was ever deployed (the trial in `deploy/README.md` was
  deleted, production has not been deployed), so that holds. A newer release's storage
  is served when its `compat` allows this code; otherwise the object **refuses**: every route
  answers 503 `schema-too-new` with `Retry-After: 30` (also through `identify`, so a valid key
  is never turned into a 401), `resolveKey` and `recordUsage` return the `schema_too_new`
  status, `provision` throws `SchemaTooNewError`, and the alarm only re-arms itself. Nothing
  else is read or written. The OpenAPI document lists 503 on every operation.
- **Formats** (`FORMATS` in `src/schema.ts`, each pinned by `test/golden/formats/`): the KV
  records `key:`, `revocation:`, `retention:`/`limits:`, `pool:`; the API key's shape; list
  cursors; dashboard revision ids. None of them carries a version field yet: their readers
  (edge, shard routing, janitor, query) would ignore one, so a `v` is useful only once they
  check it (`design/UPGRADES.md` §7). Until then these records may only gain optional fields.
- Revisions are stored whole with their content hash; the caps above bound them.
- Ids of keys, proposals and audit entries are 22 random base62 characters (about 131
  bits) with a type prefix. Dashboard ids are the spec's `metadata.id`; they are names
  inside one tenant's object and resolve nowhere else.

## Not implemented

- **A version field in the KV records.** `FORMATS` numbers them and golden files pin them,
  but no reader checks a version yet, so adding `v` now would protect nothing.

- **People.** No session or SSO identity; `kind: 'user'` is never produced. No roles or
  label-matcher policies (DESIGN §9).
- **Provisioning over HTTP**, tenant deletion and off-boarding.
- **The pool drain-and-handover protocol** (DESIGN §4.1); pool changes that need it are refused.
- **Anything that needs data.** `state` (hook only); screen 7's checks "the new query runs
  and returns 3 series" and "linked from 1 runbook"; the panel preview with today's data.
  The checks returned are validation, lint and the diff.
- **A caller of `recordUsage`.** The shard does not know which key a batch came from.
- **A reader of `revocation:<tenant>`**, and of every `limits` and `retention` field except
  `active_series`, `metric_samples_days`, `trace_days` and `log_days` (the janitor reads the last
  three).
- **A partial update of a settings section.** PUT replaces the section's value; a client sends
  every field it wants kept (a retention field left out is a shortening, confirmed or refused).
- **Replacing a stored pool map that edge refuses** (one published by an earlier control: an id
  with `_`, or tenants `traces` and `logs` before D66). It is a pool change, refused with 409 until
  the drain-and-handover protocol exists.
- **Proposals to delete a dashboard**; accepting the rest of a proposal after a partial
  apply; extending a proposal's expiry; an owner on a proposal that creates a dashboard
  (set it after applying, `PUT …/owner`).
- **Pruning old revisions.** A dashboard at its revision cap has to be copied to a new id.
- **Idempotency keys.** A retry after a lost response is refused (name taken, dashboard
  exists, stale revision) rather than recognised as the same request. The exceptions are
  proposals that create a dashboard (the same caller and spec get the open proposal back)
  and applying any proposal twice (409 `proposal-closed` says `applied` and `appliedNumber`).
- **Editing a key's name or scopes**; create a new key instead.
- **Email notifications** are stored only (the webhook is used by the ruler's notifier, above).
  **Rule definitions**, which DESIGN §3.1 lists under `Tenant`, are not here.
- **A test notification** when the webhook is saved, and a check that the URL answers.
- **Grafana import** over HTTP (the dashboard package has the importer).
- Rate limiting of the control API itself (`/api/v1/control/…`, API keys); OAuth's endpoints and
  bearers are limited (D70). Metrics about this API, pruning of the audit log.
- **The rate-limit bindings in a deployment** (D70): the Worker reads them, the deploy does not create
  them yet and does not refuse a release without them ("Needed changes elsewhere"), so every
  deployment today would run OAuth without layer 1 (logged once per isolate, `absent` in `/healthz`).
  A WAF rate-limiting rule on `vis.bitcru.sh` (the only layer that saves the request charge of a
  refused request) is recommended, not built. A per-network limit for OAuth bearers at `/mcp` is the
  agent surface's (the network is known there, not in the entrypoint).
- **A per-tenant "not before"** (D70 alternative (p), the second review's option (b)): a person's
  switch that would end every credential of one tenant issued before a moment. Not built: the list
  of dead credentials ends each stock after its first window without a person. To build if a stock
  is ever seen used in a way the list does not stop.
- **The list of dead credentials does not cover codes or layout 1 credentials** (codes die in the
  Worker within 12 minutes and each needs an approval; layout 1 has no expiry to bound a record, and
  none was issued in production), and nothing measures its KV latency or propagation on Cloudflare.
- **A metric of grants collecting refresh tokens**: the grant view's `refreshesLastDay` and the
  revocation's audit entry show it; no alert or metric is emitted (a log line would be sampled at
  1% by the deploy's observability setting).
- **Production deployment.** viz-control ran on Cloudflare only in two staged trials, both
  destroyed (`deploy/README.md`, "Trial on Cloudflare (2026-11-18)" and "Trial 2", 2026-11-19);
  it is mounted behind the gateway (`deploy/`), not in `app/`. The OAuth endpoints have not run on
  Cloudflare.
- **OAuth: Client ID Metadata Documents** (the 2026-07-28 revision's preferred registration;
  dynamic registration is deprecated there): not built, `client_id_metadata_document_supported:
  false`. Also not built: a consent page and grants screen (above), OpenID Connect discovery, RFC
  7662 introspection over HTTP (introspection is an RPC only), the RFC 8252 any-port rule for
  loopback redirect URIs (redirect URIs match exactly; a client on a new port registers again), a
  grace period for a refresh retried after a lost response (it counts as reuse), and DPoP. (Rate
  limits on the OAuth endpoints: D70, above.)

## Verification

```
npm install
npm test             # 214 tests in 23 files, in workerd (at most 2 workers)
npx tsc --noEmit     # clean
npm run mutants      # 189 mutants, in a copy outside git only (it refuses a work tree: AGENTS.md)
npm run gen:openapi  # rewrite openapi.json from src/openapi.ts
```

Measured here: vitest 5.1 in workerd, TypeScript 5.9, Node 22.23. The suite takes 11 to 75 s
on a shared machine (75 s on a cold cache with the load average above 6). Last run
2026-11-19, after the pool rule of D66 (`npx vitest run --maxWorkers=2`): 132 of 132 pass in 31 s,
`tsc` clean.

2026-11-19, the review of D44 ported onto the development branch (with D66): 148 of 148 pass,
`tsc` clean. The first run failed one test, `isolation.test.ts`'s fuzz property, on a false alarm:
B sent `var.env=<A's tenant id>` to `GET /dashboards/beta_dash?view=resolved`, and the resolved
view's issue (`"<value>" given but not among the variable's values; ignored`) echoed B's own input,
which the leak check read as A's tenant id. The check now removes exactly that echo, and only when
the request carried that value; every other occurrence of A's tenant id, ids or marker still fails
it. Not specific to this change (the fuzzer reached it at run 155 of 400); five further runs of the
file passed.

**After the review of D44** (`design/reviews/d44-d52-d53-d60.md`; dispositions there):
`test/oauth-review.test.ts`, 15 tests, and `test/forged-cost.test.ts`, 1. The entrypoint is
bound in `vitest.config.ts` (miniflare service bindings to this Worker itself) as three callers:
viz-mcp's props, the ruler's, and none. *Tags*: codes, access and refresh tokens carry the tag; one
edited in its random part, its tag or its tenant, made up, or tagged under another key has none.
*M-1*: the entrypoint answers viz-mcp exactly as the object does and `unauthorized` to the other two;
`invoke`, `provision`, `serviceKey`, `notificationTarget`, `resolveKey`, `recordUsage` and
`oauthToken` are not implemented on it (its prototype holds one method) and no key appears; a token
edited to name another tenant, or made up, reaches no object (a namespace that counts `get()`);
the review's R1 inverted: `invoke` with `key:nobody`, `system:anything`, `user:dana` (no key id) is
401 and creates nothing, and a real key id given admin scopes it lacks is 403; approve refuses a
`user:` approver (`approver-not-a-key`), and a grant recorded with one is `revoked` at
introspection, its refresh refused, the alarm due now, and ended `approver-gone`. *M-2*: 20 rounds
of forged codes, refresh tokens and revocations (refresh and access) for a tenant with a live grant
reach no object, write no row, call neither `setAlarm` nor `deleteAlarm`, and leave the alarm where
it was; for a tenant nobody provisioned, the same, and that object has no table and no alarm; at
the object itself, tagged but unknown codes, refresh and access tokens (revoke and introspect too)
write nothing and set no alarm, and a ghost tenant answers `not_provisioned` with no storage; a
revocation of a real refresh token does write, re-arm and delete the grant key's KV record, and a
rotating refresh re-arms. *Minors*: an approver key expiring in 6 minutes sets the alarm no later
than its expiry (R6 inverted); 4 MiB chunked bodies to `/oauth/token`, `/oauth/revoke` and
`/oauth/register` are refused after at most 3 of 64 chunks, and to the API (413) after at most 6 of
16 (R5 inverted); U+202E, U+200B, an IDN host and a non-ASCII path are refused at registration,
punycode and percent-encoding accepted (R4 inverted); the page and the approval's warnings say
"Approve only a connection you started yourself" for an https redirect. Without `OAUTH_CLIENT_KEY`,
approve answers `oauth-unavailable` and the token endpoint reaches no object.

**What a made-up credential costs, measured here** (`test/forged-cost.test.ts`; local workerd,
one test file, sequential, 300 requests of each kind against a tenant with a live grant; "before"
is the same file in a scratch copy of the tree the review read, with introspection called on the
object as viz-mcp did; a shared 4-core machine):

| 300 sequential requests of each | Before: ms each (3 runs) | objects asked | `setAlarm` + `deleteAlarm` | rows written | After: ms each (3 runs) | objects asked | alarm calls | rows written |
|---|---|---|---|---|---|---|---|---|
| forged code at `/oauth/token` | 1.50–1.69 | 300 | 600 | 0 | 0.13–0.18 | 0 | 0 | 0 |
| forged refresh token at `/oauth/token` | 1.53–2.33 | 300 | 600 | 0 | 0.11–0.20 | 0 | 0 | 0 |
| forged refresh token at `/oauth/revoke` | 1.39–1.63 | 300 | 600 | 0 | 0.09–0.11 | 0 | 0 | 0 |
| forged access token, introspection as viz-mcp asks it | 0.41–0.55 (the object, by its binding) | 300 | 0 | 0 | 0.58–0.89 through the `OAUTH` service binding; 0.017–0.027 for the entrypoint's own work | 0 | 0 | 0 |

Each `setAlarm` is billed as a row written (Cloudflare's Durable Objects pricing, read by the
review), so before, every forged token or revocation request cost two billed writes and a request
to the tenant's object, whose one thread also serves that tenant's whole control plane; after, it
costs the Worker one HMAC. In local workerd the service-binding hop costs more than the object call
it replaced for a made-up token (0.58–0.89 against 0.41–0.55 ms), and for a **live** token, measured
the same way in a scratch copy (300 calls, 3 rounds), introspection through the binding took
1.76–2.42 ms against 0.90–1.62 ms on the object directly: the price of the narrow entrypoint is
one hop per `/mcp` request, about 0.6–0.9 ms here. Not measured on Cloudflare (a spike with clients
as Durable Objects, AGENTS.md, would; review M-2's modelled throughput is unchanged as a model).
The machine's load average was about 10 during these runs.

What the tests establish:

- **Keys** (`keys.test.ts`, 9 tests). The KV record equals edge's four fields exactly and
  its hash is WebCrypto's SHA-256 of the secret. Edge's `authenticate`, imported from
  `edge/src`, accepts a created key for its tenant and scope, refuses a disabled or deleted
  one, and switches on rotation (old refused and new accepted without overlap; both accepted
  with one, the old record carrying a KV expiration). A dump of every row of every table
  does not contain the secret; no list, get or audit response contains the secret or its
  hash. Usage is null until `recordUsage` is called, then exact, and cannot be reported
  across tenants.
- **Dashboards** (`dashboards.test.ts`, 12 tests). The three examples in
  `dashboard/examples` round-trip byte for byte with the revision `revisionOf` gives.
  Create, get in three views, search and paging, patch, stale base, revert, soft delete,
  restore, purge, owner, caps, scopes.
- **Concurrency.** 2 and then 8 patches sent together against the same base: exactly one
  200 each time, every other a 409 naming the winner's revision and describing the
  winner's change; a loser that rebuilds against `currentRevision` succeeds and both edits
  are in the result.
- **Dry run.** For create, patch, owner, revert, delete and restore the dry-run response
  equals the real one (ignoring timestamps), and a snapshot of the tenant is unchanged
  after the dry run and changed after the real call. Dry runs of keys, proposals, apply and
  settings are checked in their own files.
- **Proposals** (`proposals.test.ts`, 8 tests). The flow of screen 7 with three named
  changes; partial application; a selection that depends on a change left out; four
  proposals against a dashboard that then moves (overwrite of a newer edit, an op on a
  removed panel, an append to an array edited underneath: all `needsRebase` and refused;
  one on an untouched panel: clean, applied, both edits kept); rebase by editing; edit then
  apply; decline; expiry; an agent applying its own proposal, with and without the apply
  scope, after editing someone else's, and with `agentsMayApply` on.
- **Proposals that create a dashboard** (`creation.test.ts`, 11 tests). An agent proposes
  a new dashboard: 202, nothing created; listed without the spec, shown with it; the review
  gives revision 1 and the summary; a dry-run apply equals the real one and writes nothing; a
  person applies: the spec is the dashboard, revision 1 of kind `apply` names the proposal,
  approver and proposer, one audit entry each for create and apply. *Authorisation*: an agent
  key with the apply scope is refused (403 `agents-may-not-apply`) for its own proposal and
  another agent's, an agent without it and a write-only person get 403 `missing-scope`, with
  and without `dryRun`, and a snapshot of the tenant is unchanged; with `agentsMayApply` the
  agent may, and `whoami` says so before and after. *Validation*: an enum error, a misspelt
  key, a missing intent and three non-specs are refused with exactly the errors the
  dashboard package's `validate` gives (pointer and suggestion included); a missing message,
  an empty one, and unknown fields are 422; an id held by a live or a deleted dashboard is
  409; edits are validated, keep the id and take only a spec; a change takes no spec; a
  stored spec made invalid underneath is shown with its errors and refused on apply.
  *Idempotency*: proposing the same spec again (also with another message, also as a dry
  run) returns the same proposal with no audit entry, while another caller or another spec
  makes a new one; two applies sent together give one 200 and one 409 `proposal-closed` with
  `appliedNumber`, then a retry the same 409, and there is one dashboard, one revision, one
  apply entry; once one of two proposals for an id is applied the other reviews as
  `exists` and is refused with 409 and nothing changed. Also: edit, decline, expiry, a
  creation row rewritten by a release without the column read as a change, and a purge that
  keeps an open proposal to create a dashboard under the purged id.
- **Scopes and whoami** (`scopes.test.ts`, 4 tests). The scopes the ruler checks (read from
  `ruler/src/http.ts`: its `Scope` type and every route) and mcp's (`mcp/src/auth.ts`) are all
  in `SCOPES`. A key with each monitors scope is created, published to KV with it, and
  accepted by edge's `authenticate` for that scope (as the ruler calls it) and refused (403)
  for the others; unknown scopes are 422. A key with all three monitors scopes gets `whoami`
  and a 403 `missing-scope` on each of the other 33 routes. `mayApply` is right for six
  kinds of key with `agentsMayApply` off and on, and each key's dry-run `PATCH` is applied
  (200) exactly when `mayApply` is true and proposed (202) otherwise.
- **The service surface** (`service.test.ts`, 8 tests). Notifications: format stored; the
  secret appears in no settings read, list, audit entry, key list or KV record (all KV keys and
  values are read); a dry run stores nothing; the secret is kept when the value read is sent
  back, dropped when the URL changes, removed with null, and five malformed values are 422;
  a value rewritten without `webhookSecretSetAt` gives `secret: null`; `notificationTarget`
  answers only for the bound tenant. Service keys: issued with exactly the contract's scopes,
  accepted by edge's `authenticate` for `read` and `write` with this tenant, listed as
  `service:viz-ruler/0` by `system:viz-ruler`, no secret readable anywhere; a second call
  rotates (the first key 401 at edge, its KV record gone, one key row, two audit entries); a
  disabled key answers `disabled` with every table unchanged; a deleted one is issued again;
  `service:` names are refused for persons; another tenant, an unknown service (also
  `toString`) and four malformed instances are refused with every table unchanged. The ruler's
  own tests (`ruler/test/wiring.test.ts`) use this real object too.
- **OAuth** (`oauth.test.ts`, 28 tests; helpers in `test/oauth.ts`, an OAuth client speaking to
  the real Worker). Every threat below is checked in stored state (SQLite rows, KV records,
  introspection), not only by status code.
  *Metadata and registration*: the RFC 8414 document exactly; registration stores nothing, two
  registrations are two clients, no secret; without the signing key 503 and not advertised; ten
  bad redirect URIs (plain http to a remote host, fragment, user info, a custom scheme,
  `javascript:`, a space, a backslash trick, relative, empty, too long), none or six URIs, and
  confidential or odd metadata refused.
  *Redirect URI exact match, no open redirect*: ten mismatches (another host, a trailing slash,
  another port, an added query, `localhost` for `127.0.0.1`, upper case, a payload edited to
  another URI under the original MAC, a registration signed by another deployment's key, garbage,
  empty) are 400 with no `Location` and no echo; a parameter sent twice too; across every
  endpoint and outcome, no answer is a 3xx or carries `Location`; client-facing errors carry only
  the registered callback, with `state` and `iss`.
  *PKCE*: missing method, `plain`, a malformed challenge refused at authorize; a verifier mismatch
  at the token endpoint is `invalid_grant`, spends the code, and the right verifier afterwards
  revokes the grant; four malformed verifiers refused.
  *Consent*: the dry run is the preview and leaves a dump of every table unchanged; an agent key
  with `admin` and every scope gets 403 `approver-not-a-person`, a key without `admin` 403
  `missing-scope`, both with nothing stored; a registration nobody approved for 24 h and a handle
  whose redirect URI was edited after the page are refused; the per-hour, client and live-grant
  bounds.
  *A token cannot exceed the approver's scopes*: an admin-only key asked for four scopes grants
  the two dashboards ones and names the other two withheld, and the grant, the grant key's KV
  record, the token response and introspection all say exactly that; a key with `read` but not
  `monitors:read` grants `read`; nothing in common is 403; a person may narrow, never widen; a
  forged handle asking for `admin` is refused.
  *Code reuse*: refused, and the access token, the refresh token, every token row and the grant
  key's KV record are gone, the grant `revoked` with `code-reuse` by `system:oauth`, audited. Codes
  are bound to client, redirect URI and resource; an expired code is refused. A failed exchange
  (PKCE mismatch, another client, redirect URI or resource) ends the grant at once
  (`exchange-failed`, key gone), so nothing lingers live against the grant and key limits; found by
  the review of #6, and the mutant that skips that revocation is caught by both tests.
  *Refresh rotation and reuse detection*: each refresh issues a new pair; the first refresh token
  presented again revokes the grant (the newest access and refresh tokens die); narrowing works,
  widening is `invalid_scope`; a refresh token presented by another client revokes its grant.
  *Tenant isolation*: A's code, access and refresh tokens are unknown to B, also edited to name B,
  and A's grant keeps working; B's object asked about A answers `not_provisioned`; B sees and can
  revoke none of A's grants; an access token is not an API key at control or at edge's verifier.
  *Introspection*: the identity and a grant key that edge's real verifier accepts with exactly
  the grant's scopes and that `whoami` describes; the audience (another path, another host
  refused; upper-case scheme and host accepted); a refresh token is not an access token.
  *Expired and revoked*: expiry; a person's revocation (dry run first), effective at once, the
  key gone from KV, `unchanged` the second time; RFC 7009 for an access token (alone) and a
  refresh token (the grant), another client's revocation ignored; suspension through the key
  and resumption. The grant's key cannot be rotated or deleted alone, nor its name taken.
  *Alarm*: it is set at the code's expiry; an unexchanged code, an expired grant and an idle grant
  are ended with their audit entries; clients with nothing live are forgotten after 30 days;
  ended grants stay listed and the alarm stays for their deletion.
  *No credential at rest, in a log line or in an error body*: after a flow with eight failure
  paths, no code, token, verifier or grant-key secret (whole or its secret part) is in any row of
  any table, any KV value, any console line (a line logged inside the object is shown to reach the
  spy), any error body, the audit log, the grants list or the keys list.
  *Rollback*: the previous release's runner opens storage holding grants and tokens at version 3
  and changes nothing.
  *The approver's key*: disabled, the grant is suspended at once; enabled, it works again;
  deleted, the token and the refresh token are refused at once, the alarm is due now and ends the
  grant (`approver-gone`) and its key's KV record.
  *Unknown tenants*: codes, access and refresh tokens naming three tenants nobody provisioned are
  refused (`not_provisioned`, `invalid_grant`, revocation 200) and leave those objects with no
  table and no alarm; provisioning one afterwards works.
  Also in other files: the audit-completeness test now approves and revokes (one entry each,
  dry runs none); tenant A in the isolation test holds a grant and its tokens (B tries A's grant
  id on every route, and the fuzz draws grant ids); golden files for the five new formats
  (`credential.oauth`, `id.oauth-client`, `oauth.request`, `oauth.sealed` with a fixed IV,
  `rpc.oauth`), each read back by its decoder; the house rules cover the three OAuth sources
  (every statement names the tenant, KV only through the outbox, one `idFromName`, on the
  credential's tenant, and one log line, without request data).
- **Health** (`http.test.ts`). `GET /healthz` without a credential is 200 `ok`, `HEAD` 200,
  `POST` 405; 503 naming `TENANT` or `CONFIG` when that binding is missing; only that path.
- **Settings and audit** (`settings.test.ts`, 12 tests). KV shapes for retention, limits and
  pool; the published pool map is accepted by `shard/src/pool`'s routing; the refused pool
  changes. Tenants `traces` and `logs` are provisioned, and their dedicated pools `tenant/traces`
  and `tenant/logs` are refused (422, field `pool`, dry run and real), with no KV record, no
  version and no audit entry; each can still take the shared pool. Ids that only resemble them
  (`Traces`, `xlogs`, `traces-1`, `logs-traces-x`) get their dedicated pool. The oracle for every
  pool is edge's own: `validBasePool` (`shard/src/pool.ts`, the function edge reads maps with) and
  edge's `poolMap` reading the record control published, which routes on each map control
  published and refuses each pool control refuses for the rule. Review M-5: for ten ids with `_`
  (and `acme-prod`), `tenant/<id>` verbatim is refused naming `dedicatedPool(id)`, and
  `dedicatedPool(id)` is accepted and routed on by edge; `acme_prod` and `acme-prod` get the same
  pool; a shared pool outside `POOL_NAME` (`shared/c_1`, 127 characters) or ending in `/logs` is
  refused here and answered 503 by edge as `DEFAULT_POOL`. Review B-1: the review's scenario (a PUT
  naming only `metric_samples_days` over traces 365 and logs 400 days) is refused, dry run and
  real, with `leftOut`, and the janitor's `readRetention` still reads 365 and 400; dropping one
  field, a rollup tier left out, a signal set below the default for the first time, and the
  confirmed replace. A property over 60 random PUT sequences (fast-check, fixed seed; days 1, 29,
  30, 31 and 400 around the janitor's `DEFAULT_SIGNAL_DAYS`): judged by the janitor's own
  `readRetention` and `parseRetention`, no PUT without `confirmShorter` shortens what the janitor
  keeps, and every refusal names exactly the fields the janitor would shorten (plus a rollup tier
  left out), so control and the janitor cannot drift apart. The first retention test now confirms
  its first record (logs 14 and traces 7 days are shorter than the 30-day default). Audit completeness: each of the 17 mutating routes is called once (the test
  fails if the route table gains one it does not call) and adds exactly one entry; its dry
  run, every read, and refused or unchanged writes add none. Every non-GET method on the
  audit routes is 405, and `UPDATE` and `DELETE` on the table fail inside the object.
- **Tenant isolation** (`isolation.test.ts`, 6 tests). Tenant A holds one of everything,
  each carrying a marker string. Tenant B, with an admin key and an all-scopes agent key:
  calls covering every id-bearing route with each of A's ids (A now also holds a proposal to
  create a dashboard) return 404; 82 list, search, filter and stolen-cursor queries return
  only B's things; all 30 routes refuse `tenant` in the query and the body; 240
  unauthenticated or wrong-secret calls return
  401; and a fast-check fuzz of 400 random combinations of route, ids (A's, B's, guessed,
  hostile strings), queries, headers and bodies never returns a 2xx for an id of A's.
  After each part a snapshot of A (keys, dashboards, specs, revisions, proposals and their
  reviews, settings, audit log, and A's six KV records) is unchanged, and no response to B
  contains the marker, A's tenant id or any of A's ids.
- **Durability** (`durability.test.ts`, 6 tests). The object is evicted after each of 12
  steps of a lifecycle and the tenant's state and alarm are identical afterwards. Eviction
  while 12 key creations are in flight: every acknowledged key exists and works at edge,
  and each existing key has exactly one audit entry. KV failing: the change commits, the
  response says `pending`, later changes queue behind it, and after an eviction the alarm
  publishes them in order and then removes itself. A failure injected into the transaction
  leaves nothing in SQLite, the outbox or KV, and the retry is audited once. Twenty
  concurrent enable/disable calls leave KV equal to the object.
- **Property** (`property.test.ts`). 40 fast-check runs of up to 14 steps (patches,
  reverts, an invalid patch, a stale patch) against a model: revision numbers are 1..n
  without a gap, every stored spec equals the model's, validates, and hashes to its stored
  revision.
- **OpenAPI** (`openapi.test.ts`, 4 tests). `openapi.json` equals what `src/openapi.ts`
  generates; the documented operations and the route table are the same set; scopes, path
  parameters and `dryRun` agree per operation; every `$ref` resolves; five response
  schemas' required fields are present in real responses. Full response validation against
  the schemas is not done.
- **Versioned storage** (`compat.test.ts`, 11 tests). A fresh object records `control.Tenant`
  version 3 with `compat` 1, and its schema equals `test/golden/schema/v3.json` (v2 plus the
  four OAuth tables and their three indexes; nothing of v2 changed); applying migrations 1..N
  to empty storage gives the golden schema of N, for N = 1, 2 and 3; version 1 equals the
  `sqlite_master` of the
  pre-versioning code (`test/fixtures/storage-v0.json`, a dump with 3 keys, 2 dashboards and 3
  revisions, a proposal, 2 settings and 10 audit entries, made by that code). That dump,
  installed into an object and opened by this code, is adopted as version 1 and migrated to
  the latest with every row unchanged except a NULL `spec` on its proposal (the schema is the
  old one plus that column and the OAuth tables, empty, exactly as the latest golden file has
  them), serves its keys, dashboards, settings and audit log, takes a write, and
  is not migrated again after eviction. Upgrade: the same data at each earlier version is
  migrated to the latest by the real class, every row kept, its old proposal read as a change, a new dashboard
  proposed and applied on it, and not migrated again after eviction. Rollback target: the
  previous release's runner (migrations 1 only) opens storage this release wrote, with a
  proposal to create a dashboard in it, at version 2 with nothing changed; every migration
  is `readableFrom: 1`. Storage migrated by a simulated release N+1 with a breaking
  migration is refused: four HTTP routes answer 503 `schema-too-new` with `Retry-After: 30`,
  the three RPCs refuse, the alarm re-arms itself, and a dump of every table (version row
  included) is identical before and after. Storage of an N+1 with an additive migration
  (`compat` 1) is served and written, and keeps version 2. A migration that throws half way
  leaves storage as it was. The runner refuses a spec with a gap, a migration readable from
  the future, and storage that belongs to another class.
- **Golden formats** (`golden.test.ts`, 9 tests). Every format in `FORMATS` has a file for
  its current version under `test/golden/formats/`, produced through the API with fixed
  inputs (random parts replaced after their shape is checked): the `key:` record enabled and
  disabled, `revocation:`, `retention:` and `limits:`, `pool:`, the API key's shape, a list
  cursor (and that it still decodes), the revision ids of the three example dashboards.
- **House rules** (`rules.test.ts`, 2 tests), read from the source: every SQL statement
  names the tenant; the audit table is only inserted into; KV is written only in the
  outbox drain; the Worker has one `idFromName`, on `identity.tenant`.

### Rate limits in front of OAuth (D70)

**Round 3: the third look's findings** (`design/reviews/d70-rate-limits-r3.md`, reject until R3-B1
is fixed; fixed 2026-11-26). Runs (`npx tsc --noEmit && npx vitest run --maxWorkers=2` in
`control/`): `tsc` clean; @@FINAL@@. In `mcp/`: @@MCP@@.

| Finding | Disposition | Evidence |
|---|---|---|
| R3-B1 (blocker: a revocation under another client id lists a rotated refresh token of a live grant, so the owner's copy is refused in the Worker, reuse detection never runs and the thief keeps the grant) | **Fixed**, contract first: `RevokeResult.dead` no longer counts "rotated", and `revokeToken`'s branch for another client says dead only for a grant that has ended or an unrotated token that has expired (a rotated row past its own expiry is not dead either: inside the Worker's grace it still reaches reuse detection). The wider rule, nothing listed whose later presentation must still reach the object, is checked for every place that lists (`src/deadlist.ts` header, D70) | `test/ratelimit-review-r3.test.ts`: the review's attack, the owner's copy now reaches the object, the grant is revoked and the thief's token refused (also in a new isolate); the rotated-and-expired case. Mutants 190, 191 |
| R3-M1 (major: the same path tells whether a refresh token is live) | **Fixed** by the same change, and by m-1 below: a live, a rotated and a listed (ended grant) refresh token all answer `[200, 200, 200, 429, 429]` | the two R3-M1 tests; mutant 192 |
| m-1 (the list is read before any limit, so cycling more than 10,000 dead credentials forces a KV read per request) | **Fixed**: the per-credential limit first, then the list, then the fuse (`firstRefusal`'s `listed`). A listed credential spends its own allowance and never its tenant's fuse | the m-1 tests (3 KV reads for 10 replays in fresh isolates; the fuse counted once; at introspection `inactive` × 3 then `rate_limited`). Mutants 192–194 |
| m-2 (one slow KV read switches the list off for the isolate for 10 s) | **Fixed**: a read over 100 ms times out its key only (not listed for 60 s in that isolate); a read that throws, which only a KV fault causes, still skips the isolate's reads for 10 s | `deadlist.test.ts`, the slow and the throwing read. Mutant 195 |
| m-3 (the residual's conditions) | **Recorded** in D70: about a minute per stock; tripping a location's fuse with a stock of 1,200 needs at least 5 isolates there to meet all of it within the minute, one isolate a stock of 6,000 | modelled |
| Production served OAuth without limits (the verdict's note) | **Recorded** in D70 and here: since 2026-11-19 (PR #8); "required before public exposure" was not met | |

**Before and after.** `test/ratelimit-review-r3.test.ts` (@@R3N@@ tests) was run against a copy of
`control/` and `contracts/` at `200f235`, the commit the review read: **5 of 7 fail** (the file as it
then was: the attack, both R3-M1 tests and both m-1 tests); the 2 that pass there are controls
(reuse detection with no probe, and a revocation by the client itself). The rotated-and-expired test
was added after that run. Against this code, all pass.

**Tests changed deliberately**, each because it asserted what this round changes:
- `ratelimit-review.test.ts` R1 and R2: `[400 × 13]` and `[200 × 13]` in round 2 are round 1's
  `[400 × 3, 429 × 10]` and `[200 × 3, 429 × 10]` again (a listed credential spends its own allowance),
  still with 0 and 1 object requests;
- `ratelimit-review-r2.test.ts`, the new-isolate test: the listed token is now counted against its own
  allowance (two requests there, the third 429), never the fuse; N2 now also asserts the dead token
  reached its object once (the list is consulted while the narrow limiter is skipped);
- `deadlist.test.ts`: the hanging read is now its own test (per-key timeout, the list stays `bound`),
  apart from the throwing one (isolate skip).

**`vitest.config.ts`** now hands the test plugin `wrangler.jsonc` without its `ratelimits`, which the
deploy builder added there (Known risks): with them, every test file ran with production limits on
placeholder namespaces, and 22 tests failed on the first run (registrations from the shared `none`
key refused at 120, "absent" bindings present), none because of this change.

@@MUT3@@

**Round 2: the second review's findings** (`design/reviews/d70-rate-limits-r2.md`, approve with
changes; fixed 2026-11-19). Runs (`npx tsc --noEmit && npx vitest run --maxWorkers=2` in `control/`):
`tsc` clean; **214 of 214 in 23 files**, 31–43 s, machine load average 3–6 from other builders. In
`mcp/` after the contract change: `npx tsc --noEmit` clean, `npx vitest run test/oauth.test.ts` 15
of 15.

| Finding | Disposition | Evidence |
|---|---|---|
| R2-M1 (fuse asked alone when the narrow limiter is skipped or absent) | **Fixed**: a wider key is asked only while every narrower one was checked (`firstRefusal`); absent bindings are still each logged once. While a narrow limiter is down, its fuse counts nothing in that isolate (D70 says so) | `ratelimit-review-r2.test.ts` N2 (hang, throw) and N2b: the victim is served and the fuse counted none of the 13 requests; before, 12 counted and the victim got 429. Mutant 166 |
| R2-M2 (farmed refresh tokens trip the token fuse for 30 days after revocation; no per-tenant remedy; D70's "live tokens anyway" false for the token fuse) | **Fixed** by the list of dead credentials (the owner's decision over the residual; D70 (p), the per-tenant not-before, recorded and not chosen), the grant view's `refreshesLastDay`, and D70 rewritten: the false sentence corrected, the thief of an idle grant's token added, the remedy (revoke the grant) and the remaining window stated | N1 at `/oauth/token` and at `/oauth/revoke`, N1b (thief), a new isolate reading the list from KV with the record's expiration checked, 5 dead access tokens × 3 at introspection, the farming count in the grant view and the revocation's audit entry; `deadlist.test.ts`, 13 tests. Mutants 169–189 |
| M-2 (carried: no deploy gate) | **Open**, the deploy's: restated in "Needed changes elsewhere" 3, with m-3's floor as 6 | none here |
| m-1 (a slow narrow check eats the shared budget; the healthy fuse is blamed) | **Fixed**: each check has an even share of `CHECK_BUDGET_MS` as its own timer, and only a binding that overran its share is skipped | N3 in `ratelimit-review-r2.test.ts` (80/30 and 60/60 ms: the credential is skipped and the fuse not asked; 20/75 ms: the fuse is skipped, the credential bound; 30/30: both bound) and a share test in `ratelimit.test.ts`. Mutant 160 (re-anchored) |
| m-2 (genuine expired credentials counted by network) | **Fixed**: answered as the object would, counted against nothing; a listed one too | `ratelimit-review-r2.test.ts` m-2 (10 + 10 expired from one network, then its budget whole); `ratelimit.test.ts`'s network test changed accordingly. Mutants 167, 168 |
| m-3 (rollback below the fix once OAuth is public) | **Written** for the deploy: a `rollback_floors` rule keyed on a plain `OAUTH_PUBLIC` var, with evidence exports only this release has ("Needed changes elsewhere" 6) | none here |
| m-4 (per-location fuse headroom) | **Recorded** with the numbers in D70 and above: two locations at the bearer fuse are 90–150% of one object, five at the token fuse 38–105% | modelled |
| n-1 (who pays for Worker-hosted senders) | **Fixed** wording in D70 and `src/ratelimit.ts` | |
| n-2 (`Date.now()` budget arithmetic) | **Gone**: the share is a timer | |

**The reproductions, before and after.** `test/ratelimit-review-r2.test.ts` (14 tests) makes the
review's N1, N1b, N2, N2b and N3 again, plus the variants this round had to close (the stock
replayed at revocation and at introspection, a new isolate, the farming signal), each asserting that
the victim is served. Run against a copy of `control/` and `contracts/` at `3f68591` (the code the
review read, unchanged since `122229b`), with the same file, `vitest.config.ts` and `test/env.d.ts`:
**13 of 14 fail** (N1: victim 429 "this tenant"; at revocation: 429; N1b: 429; new isolate: no KV
record; introspection: `rate_limited`; farming: no field; N2: the fuse counted 12 and the victim got
429; N2b: `rate_limited`; N3: `[bound, skipped]` for 80/30 and 60/60, `[bound, bound]` for 20/75;
m-2: 429). The one that passes there is N3's 30/30 ms control, where nothing should change. Against
this code: 14 of 14 pass.

**Tests changed deliberately**, each because it asserted what this round changes:
- `ratelimit.test.ts`:
  - "each binding is logged once" now expects the narrowest binding of each chain logged once as
    failing and the wider ones never asked (R2-M1); absent ones are still each logged once;
  - "a binding that hangs takes the whole request's budget … tried by the next request" became "takes
    only its own share; while it is skipped the wider binding is not asked at all" (R2-M1, m-1), and
    a share test was added;
  - "made-up credentials and bad requests from one network" no longer counts two expired credentials
    by network (m-2): it presents three of each, uncounted, and two other bad requests;
  - "the tenant fuse takes 12 ÷ 3 = 4 distinct unexpired credentials" spent the fuse with dead access
    tokens, which are now listed after one request: it now spends it with four live refresh tokens
    held at layer 2's limit (the object refuses them without calling them dead), and a new test shows
    four dead credentials × 3 revocations and × 3 refreshes reach the object 4 times and the live
    client is served.
- `ratelimit-review.test.ts`: R1 was `[400 × 3, 429 × 10]` with 3 objects asked, now `[400 × 13]`
  with none (its client's revocation listed the token); R2 was `[200 × 3, 429 × 10]`, now
  `[200 × 13]` with one object request. A new test keeps the per-token key at revocation covered: a
  live token revoked 13 times by another client (nothing changes, so it is never listed) is
  `[200 × 3, 429 × 10]` and the victim is served (added after mutant 122 survived, below).
- `oauth-review.test.ts`: revoking tagged unknown tokens at the object now answers `dead: true`.
- `golden.test.ts`: `rpc.oauth`'s revocation sample has `dead: true`; a new golden file for
  `kv.oauth-dead`, with the key's shape, the value and the expiration rule.
- `oauth-cost.test.ts`: replays of dead credentials are split into the first (reaches the object,
  lists it: one Worker KV write) and later ones (no object, nothing written; one KV read in a new
  isolate), and the Worker's own KV reads and writes are counted (table below).
- `rules.test.ts`: the list is the one KV writer outside the object's outbox (one `put`, under its
  prefix, with an expiration, never a delete), and the rate limits and the list log fixed messages
  only.

`test/deadlist.test.ts`, 13 tests: what is listed (a refresh refused for its scope or resource is
not, and one refused by layer 2 is not either, `ratelimit.test.ts`; at introspection `suspended` and `audience` are not and the token comes back,
`unknown` is, and a new isolate answers it from KV; a live token revoked by another client is not,
by its own client is); nothing written with less than 60 s left or for layout 1; one write per dead
credential per isolate, also for 5 concurrent replays; one KV read per live token per isolate for 50
introspections; the isolate's map holds at most 10,000 and drops the oldest; a KV read that throws or
hangs is served within the budget, logged once, skipped for 10 s and shown `skipped` by `/healthz`; a
failed write is logged once and the isolate still remembers; without `CONFIG` only the isolate
refuses; keys carry the prefix and the tenant and never the credential.

**What each OAuth endpoint costs, round 2** (`test/oauth-cost.test.ts` as changed; local workerd, one
test file, sequential, three runs, the machine's load average 7.2–7.4; Worker plus object, not
Cloudflare; no rate-limit bindings but in the last two rows; counts per request). The first replay
of a dead credential reaches its object once and the Worker lists it (one KV write); every later
replay is answered from the isolate's memory (no I/O) or, in a new isolate, from one KV read, and
reaches no object. A live token at introspection, and each refresh, read the list once (a live
access token then not again in that isolate for a minute). The rotated token presented again reads
nothing: its own refresh a moment before left it remembered as not listed.

| Per request | n | ms (3 runs) | Objects | Rows | Alarm writes | Object KV writes | Worker KV reads | Worker KV writes |
|---|---|---|---|---|---|---|---|---|
| `register` | 100 | 0.29–0.39 | 0 | 0 | 0 | 0 | 0 | 0 |
| `authorize page` | 100 | 0.21–0.31 | 0 | 0 | 0 | 0 | 0 | 0 |
| `token: forged code (no tag)` | 100 | 0.15–0.33 | 0 | 0 | 0 | 0 | 0 | 0 |
| `approve (control API, admin key)` | 40 | 9.50–11.35 | 0 | 17.1 | 2 | 1 | 0 | 0 |
| `token: code exchange` | 40 | 3.90–4.88 | 1 | 9 | 2 | 0 | 0 | 0 |
| `introspection: live token (entrypoint logic)` | 20 | 1.85–2.25 | 1 | 0 | 0 | 0 | 1 | 0 |
| `introspection: live token (through the OAUTH binding)` | 20 | 1.55–2.00 | 0 | 0 | 0 | 0 | 0 | 0 |
| `token: refresh` | 20 | 4.50–6.05 | 1 | 9 | 2 | 0 | 1 | 0 |
| `revoke: live access token` | 20 | 5.60–8.75 | 1 | 1 | 2 | 0 | 1 | 1 |
| `token: rotated refresh token presented again (ends the grant; listed)` | 20 | 11.80–15.55 | 1 | 18.05 | 2 | 2 | 0 | 1 |
| `token: first replay of a genuine refresh token whose grant ended (listed)` | 20 | 3.85–4.35 | 1 | 0 | 0 | 0 | 1 | 1 |
| `token: replay of a listed refresh token (this isolate)` | 20 | 0.20–0.25 | 0 | 0 | 0 | 0 | 0 | 0 |
| `token: replay of a listed refresh token (a new isolate: read from KV)` | 20 | 1.00–1.20 | 0 | 0 | 0 | 0 | 1 | 0 |
| `revoke: live refresh token (ends the grant; listed)` | 20 | 9.95–11.50 | 1 | 17.05 | 2 | 2 | 1 | 1 |
| `revoke: replay of a listed token (this isolate)` | 20 | 0.10–0.20 | 0 | 0 | 0 | 0 | 0 | 0 |
| `introspection: first replay of a genuine token whose grant ended (listed)` | 20 | 3.95–4.30 | 1 | 0 | 0 | 0 | 1 | 1 |
| `introspection: replay of a listed token (this isolate)` | 20 | 0.00–0.05 | 0 | 0 | 0 | 0 | 0 | 0 |
| `register, source limit asked and allowing` | 100 | 2.43–4.36 | 0 | 0 | 0 | 0 | 0 | 0 |
| `register, refused by the source limit` | 100 | 0.70–0.83 | 0 | 0 | 0 | 0 | 0 | 0 |

**Brownout, round 2** (`test/ratelimit-review.test.ts` R5: every limiter hangs; local workerd, three
runs, load average about 8): the first refresh took 59–64 ms (its credential check's 50 ms share,
and the fuse not asked), then 3–7 ms; introspections 56–58 ms, then 2–3 ms. After round 1 they were
105–129 and 104–105 ms, then 14 and 2.

**Mutants, round 2** (2026-11-19, in a copy of `control/` and `contracts/` from the shared tree and
`dashboard edge engine janitor ledger mcp ruler shard compact flush` at the commit then current, in a
scratch directory outside git, `node_modules` linked; its unmutated suite passed 213 of 213, and 214
of 214 after the test added below; the machine's load average 3–9 from other builders). Run: the
whole D70 set, `node scripts/mutants.mjs "rate limit (D70"` (66: 114–135, 146–165 and this round's
166–189), and `"review M-2"` (7), because this round moved code those mutate.
- Eight anchors no longer matched the source and were re-anchored before the run: 107, 128, 153,
  154, 160 (now "each check gets the whole budget, not its share"), 164 (moved with this round's
  edits), and **102 and 103, which had not matched since round 1**: their anchors named the token
  endpoint and revocation as they were before `refusedHere` existed, so they would have been
  reported `NOT APPLIED` and were not run then (1–113 were not re-run in round 1). All eight were run.
- **65 of 66 killed in the first pass. 122 survived** ("revocation has no per-token key"): its old
  killers revoked a dead token 13 times, which the list now stops after one request, so nothing
  exercised the per-token key at revocation. The key still matters for a token that is not dead: a
  test now revokes a live token 13 times as another client (nothing changes, so it is never listed)
  and expects `[200 × 3, 429 × 10]`. Run again: **killed** (`ratelimit-review`). So **66 of 66**.
- **7 of 7** of the review of D44's M-2 group killed.
- The run was stopped once after 14 mutants (the machine was slow and the background limit is two
  hours), the copy restored from the shared tree and checked green, and resumed with a skip count
  added to the copy's script only; no mutant was run twice except 122.
- The script's report named a failing file only if its name had no digit, so kills in
  `ratelimit-review-r2` were counted but not always named in the first two parts; the regex is fixed
  (`[a-z0-9-]+`), and the table names what the later parts printed.
- Afterwards the copy's `control/src`, `control/test` and `contracts/oauth.ts` were compared with the
  shared tree: equal (only `scripts/mutants.mjs` differs, by the skip count). Not re-run this round:
  1–101, 104–106, 108–113, 136–145.

**Runs after the review's fixes** (2026-11-19, `npx tsc --noEmit && npx vitest run --maxWorkers=2`
in `control/`): `tsc` clean; 183 of 183 in 21 files, 46 s, with the machine's load average about 7–9
from other builders' runs; the count includes the settings tests another builder is changing. 31
of the tests are D70's:
- `ratelimit.test.ts`: 19;
- `ratelimit-review.test.ts`: 12;
- `oauth-cost.test.ts`: 1, which measures as well as tests.

In `mcp/`, after the contract change: `npx tsc --noEmit` clean, and `npx vitest run
test/oauth.test.ts` 15 of 15. That suite runs control's real `OAuthIntrospection`, with its own
`OAUTH_RL_BEARER`.

**The review's reproductions, before and after** (`test/ratelimit-review.test.ts`). The review's R1
to R5 are made again, scaled to spend the test bindings' limits, and each test asserts that the
victim is served. The file also binds `OAUTH_RL_CLIENT` as the reviewed release did (per client id,
3), so that R1b reaches the release it was found in.
- **Before**: the same file, with the same `vitest.config.ts` and `test/env.d.ts`, was run in a
  copy of `control/`, `contracts/` and their imports taken before any edit. **8 of 12 failed**:
  - R1: the victim's refresh was 429 "this tenant".
  - R1b: 429 "this client".
  - R2: the victim's refresh was 429.
  - R3 with expired tokens: they counted and reached the object.
  - R3 at the token endpoint: 429.
  - R4 from the Workers address: the 6th registration was 429.
  - R4 with a genuine refresh from a spent network: 429 "your network".
  - R5: refreshes took 3,013–3,031 ms and introspections 2,005–2,022 ms.
- **The 4 that pass there**:
  - the review's own R3 numbers (two dead tokens, 3 + 2 checks), which the fuse's ratio now absorbs;
  - the header-less shared key, recorded, not changed;
  - the two release skews.
- **After**: 12 of 12 pass. R5 measured refreshes at 105, 129 and 14 ms, and introspections at 104,
  105 and 2 ms (local workerd, limiters that never answer, machine load average about 6).

`test/ratelimit-review.test.ts`, 12 tests:
- **B-1, R1**: one dead refresh token sent 13 times with made-up client ids (the tenant fuse is 12).
  Statuses are `[400 × 3, 429 × 10]`, it reaches the object 3 times, and the live client refreshes.
- **B-1, R1b**: the same with the victim's own client id; the victim refreshes.
- **B-1, R2**: one dead access token revoked 13 times, `[200 × 3, 429 × 10]`; the victim refreshes and
  revokes.
- **B-1, R3**:
  - the review's two dead access tokens (3 + 2 checks): the live token is served;
  - 5 expired access tokens × 3 checks are each `inactive` `expired`, with no object asked, and the
    live token is served;
  - 13 expired refresh tokens, 13 expired codes and 13 expired revocations ask no object, and the
    live client refreshes.
- **M-1, R4**:
  - 10 registrations from `2a06:98c0:3600::103` are all 201, and a genuine refresh from it is 200;
  - from a network whose 5 made-up refreshes spent its budget (the 6th is 429 "your network"), a
    genuine refresh and revocation are served;
  - recorded, unchanged: header-less requests share one key.
- **m-1, R5**: with all limiters hanging, each refresh and introspection is under 600 ms, and the
  third of each is under 100 ms.
- **Skews**:
  - Layout 1 credentials, minted by the previous release's code (`test/fixtures/
    previous-release-oauth.ts`) with rows as it wrote them, are served by this release: introspected,
    refreshed (the answer is layout 2), revoked. One past its row's expiry is `inactive` `expired` by
    the object.
  - The previous release's checks (its regex and tag computation, frozen in that fixture) accept the
    code, access and refresh token this release issues. The object's RPCs serve them as that
    release's Worker would call them.

`test/ratelimit.test.ts`, 19 tests:
- **Source**:
  - Register and authorize (GET and HEAD) share one budget per network. The sixth counted request
    is 429 with `Retry-After: 60`, JSON, `no-store`, CORS and `too_many_requests`, and a plain-text
    page at `/oauth/authorize` with no request handle. Another network is served.
  - Not counted: the metadata, an `OPTIONS` at each of the four endpoints, `GET /oauth/register` and
    `POST /oauth/authorize`.
  - A refused registration pulls nothing from its body stream.
  - IPv6 counts by /64 and then /48: after 5 from one /64 that /64 is refused, the /48 has counted 5,
    three more from another /64 of it pass, and the next is refused by the /48. Another /48 is
    served.
  - IPv4-mapped addresses count as IPv4. A missing or unreadable header is one shared key (8 bad
    inputs). The Workers address, however written, is no key; its neighbour is.
- **Token and revocation by network**:
  - From one network, 5 requests the Worker refuses by itself (a made-up refresh token and a made-up
    revocation, a missing `client_id`, an expired refresh token, an expired revocation) ask no
    object. The sixth made-up request is 429 "your network" without "Nothing was read".
  - A genuine refresh and a genuine revocation from the same network are then served and reach the
    object.
- **Per credential, then the fuse**:
  - A live refresh token that layer 2 refuses, retried, reaches the object 3 times. Then come five
    429s "this code or token" that ask no object. Another client refreshes, and once the grant's
    minute has passed the refused token refreshes.
  - The fuse:
    - 20 made-up and 20 expired credentials of each kind naming tenant X ask no object and count
      nothing;
    - four dead credentials × 3 then fill the fuse of 12, each one's fourth request being refused at
      its own allowance;
    - X's live client is then 429 "this tenant", before the object;
    - tenant Y is served.
- **Introspection**:
  - One token's flood is `rate_limited` before the object after 3.
  - Three more tokens spend 9, so the fuse of 12 then refuses a fifth token.
  - Another tenant is served.
  - 30 made-up and 30 expired tokens count nothing and ask no object, expired ones as `expired`.
- **Layout 2**:
  - The code, access and refresh token of a real flow carry the marker, and an expiry no earlier than
    their rows' (less a few seconds for the code, minted before its row's clock) and less than a
    minute later.
  - The encoding is pinned with fixed inputs: `AAAA`, `AAAB`, `AABA`, `ALa7` for 2026-12-01T12:34:05Z,
    clamped to `9999`.
  - A minted credential decodes to its minute, and the tag covers the expiry: changing one of its
    characters breaks the tag.
  - Layout 1 and non-credentials carry none. `B62` equals the contract's `BASE62`.
  - Grace: a token 55 s past its expiry still goes to the object; one 120 s past does not.
- **Fails open**:
  - With the bindings absent, throwing, rejecting, or answering `{ ok: true }`, every endpoint and
    introspection serve, twice.
  - Each of the six bindings is logged exactly once per case ("is not bound" or "failed"), not per
    request.
  - Hanging: the first register and introspection give up within the budget, the second pair skips
    the failed bindings and the third pair takes under 100 ms. `/healthz` then says `skipped`.
- **One budget per request**: with the credential and tenant limiters hanging, the first refresh
  calls only the first, and the second refresh tries the second.
- **`/healthz`**: `ok`, `OAUTH_CLIENT_KEY: set` (never the value), each limiter `bound` or `absent`,
  still 200; `absent` when the key is.
- **Placement**: neither `control/wrangler.jsonc` nor `mcp/wrangler.jsonc` sets `placement`.
- **Reset**: a real binding with a 10 s window refuses at its limit and serves again in the next
  window.
- **Exact per-grant limit**, unchanged from the first version:
  - After the exchange and 5 refreshes, the sixth refresh in the minute is 429 with `Retry-After`
    between 1 and 60. It writes no row and no alarm, and does not spend the token.
  - Another grant of the same tenant is served, and with the grant's tokens dated back 61 s the same
    token refreshes.
  - A rotated refresh token presented while the grant is at its limit still ends the grant (reuse
    detection first).

**Does the test runner have the binding?** Yes. `@cloudflare/vitest-plugin` 1.8.4 passes miniflare's
`ratelimits` option through, and miniflare 5.20261117.0-beta implements it: a SQLite-backed object
per namespace, windows aligned to the clock, exact counts, and a refused call does not count, as on
Cloudflare.
- `vitest.config.ts` declares seven such bindings under test names with small limits. The tenant
  fuses are 4 times the per-credential limits, as in production they are many times them.
- The two rate-limit test files put them in place of the `OAUTH_RL_*` bindings in the environment
  they hand the Worker. Only limiters that fail are stubs.
- Every other test file runs without the bindings.

**Before the review** (the first version, for the record): 164 of 164 in 20 files. 13 tests were
that change's; 22 of 22 mutants were killed.

**What each OAuth endpoint costs, measured here** (`test/oauth-cost.test.ts`; local workerd, one test
file, sequential; three runs before D70, on the unchanged tree, three after its first version, the
machine's load average 4–8, and three after the review's fixes, load average 8.6–9.4; Worker plus
object, not Cloudflare). Rows are as the object's SQLite counts them
(`rowsWritten`, indexes included); each `setAlarm` or `deleteAlarm` is billed as a row written too.

| Per request | n | Before D70: ms (3 runs) | D70 first version: ms (3 runs) | After the review's fixes: ms (3 runs) | Objects | Rows | Alarm writes | KV writes |
|---|---|---|---|---|---|---|---|---|
| `POST /oauth/register` | 100 | 0.18–0.22 | 0.22–0.41 | 0.32–0.38 | 0 | 0 | 0 | 0 |
| `GET /oauth/authorize` (the page) | 100 | 0.23–0.26 | 0.25–0.52 | 0.27–0.32 | 0 | 0 | 0 | 0 |
| `/oauth/token`, made-up code (no tag) | 100 | 0.16–0.20 | 0.28–0.33 | 0.27–0.37 | 0 | 0 | 0 | 0 |
| approve (control API, a person's admin key) | 40 | 11.70–25.48 | 12.43–14.10 | 12.55–27.60 | not counted (the API's path) | 17.1 | 2 | 1 |
| `/oauth/token`, code exchange | 40 | 6.08–8.10 | 5.83–6.40 | 6.38–8.63 | 1 | 9 | 2 | 0 |
| `/oauth/token`, refresh | 20 | 5.75–7.85 | 4.30–8.35 | 3.70–7.45 | 1 | 9 | 2 | 0 |
| `/oauth/revoke`, live access token | 20 | 3.20–4.80 | 2.65–3.55 | 2.35–7.15 | 1 | 1 | 2 | 0 |
| `/oauth/token`, rotated refresh token again (ends the grant) | 20 | 14.10–28.80 | 9.65–31.00 | 10.15–17.10 | 1 | 18.1 | 2 | 2 |
| `/oauth/revoke`, live refresh token (ends the grant) | 20 | 19.65–23.10 | 10.65–17.10 | 9.65–20.35 | 1 | 17.1 | 2 | 2 |
| `/oauth/token`, replay of a genuine refresh token, grant ended | 20 | 1.10–2.10 | 1.00–1.65 | 1.60–3.30 | 1 | 0 | 0 | 0 |
| `/oauth/revoke`, replay of a genuine token, grant ended | 20 | 0.85–1.45 | 0.95–1.20 | 0.80–1.15 | 1 | 0 | 0 | 0 |
| introspection, live token (the entrypoint's logic) | 20 | 0.90–1.50 | 0.90–1.35 | 0.95–1.35 | 1 | 0 | 0 | 0 |
| introspection, live token (through the `OAUTH` binding) | 20 | 1.40–3.15 | 1.60–1.75 | 1.20–1.45 | 1 | 0 | 0 | 0 |
| introspection, replay of a genuine token, grant ended | 20 | 0.80–1.45 | 0.75–1.80 | 0.50–0.70 | 1 | 0 | 0 | 0 |
| register with the source limit asked and allowing (miniflare's binding) | 100 | | 2.13–3.96 | 2.15–4.29 | 0 | 0 | 0 | 0 |
| register refused by the source limit (miniflare's binding) | 100 | | 0.62–0.99 | 0.61–0.88 | 0 | 0 | 0 | 0 |

The two "after" columns have no bindings but those two rows (as a deployment without them); the
refresh row includes the per-grant count, one read; since the review's fixes, every row with a
genuine credential also decodes its expiry (four characters, no I/O). A "replay" row's credential is
dead but not yet expired, so it still reaches its object; an expired one is refused in the Worker
like a made-up one (`test/ratelimit.test.ts`). The limiter rows are miniflare's implementation, which
writes a SQLite row per allowed call: an upper bound here, not what Cloudflare's locally cached count
costs. The ranges overlap before and after; the machine is shared, so differences under about 2x are
noise.

**Modelled billing per request** (Cloudflare list prices as training knowledge, not read here:
Workers $0.30 a million requests and $0.02 a million CPU-ms; Durable Objects $0.15 a million
requests, $1.00 a million rows written, $12.50 a million GB-s; KV $5.00 a million writes; a
service-binding call is not billed as a request): anything without a genuine credential, about
$0.30–0.31 a million (the gateway's request; refused or not); a replay of a genuine credential, about
$0.45 a million (plus an object request); a refresh or exchange, about $11.5 a million (11 billed
rows); an approval, about $24 a million. A client looping on refresh at 1 a second would cost about
$1 a day per grant and keep 86,400 rotated rows a day; at the exact limit, 6 a minute, about $0.10 a
day and 8,640 rows. Settled only by billing on Cloudflare (the analytics API), for a stage with the
bindings.

**Neighbours**: `mcp/` imports this Worker and the entrypoint in its tests and uses the contract:
`npx tsc --noEmit` clean there, and `npx vitest run test/oauth.test.ts` 12 of 12 (2026-11-19).

### Review of spans and logs: retention and pools (B-1, M-5)

2026-11-19, after `design/reviews/signals-end-to-end.md` B-1 and M-5 (D63 and D66 revised):
`npx vitest run --maxWorkers=2` **164 of 164** in 20 files (settings 12, three of them new), `npx
tsc --noEmit` clean. The suite imports the janitor's `readRetention`, `parseRetention` and
`DEFAULT_SIGNAL_DAYS` (and, through them, compaction and flush sources, for the test only) and
edge's `poolMap`, so the oracles are the real readers.

The review's reproductions, bundled with esbuild from copies of the tree before and after
(`retention-replace.mjs`, `pool-underscore.mjs`, plus two of mine for the sibling cases):

| Case | Before | After |
|---|---|---|
| `{metric_samples_days: 60}` over traces 365, logs 400, unconfirmed | accepted; the janitor then keeps traces and logs 30 days | 422 `confirmation-required`, `log_days: 400 → 30 (left out: the default)`, `trace_days: 365 → 30 …` |
| `trace_days: 7` added to a stored `{metric_samples_days: 45}`, unconfirmed | accepted (no stored field to compare) | 422, `shortened: ["trace_days"]` |
| `log_days: 1` as a tenant's first record, unconfirmed | accepted | 422, `shortened: ["log_days"]` |
| tenant `acme_prod`, pool `tenant/acme_prod` | accepted, published; edge: 503 for every write | 422, naming `tenant/acme-prod` |
| tenant `acme_prod`, pool `tenant/acme-prod` | 422 (not its own pool) | accepted; edge routes on it |
| shared pool `shared/c_1` | accepted, published; edge: 503 | 422, fix: rename `DEFAULT_POOL` |

### Mutation checks

`scripts/mutants.mjs` applies each change on its own, runs the suite and restores the
files; the last column names the test files that failed and, in brackets, how many tests.
It runs vitest with at most 2 workers, counts a mutant as killed only when a test ran and
failed (a suite that crashed or hung is reported as `NO RESULT` and counts as not killed),
and refuses to run inside a git work tree: run it from `control/` in a copy of the
repository (its header lists what the copy needs).

**66–93** (OAuth, D44) were run on 2026-11-19 in a copy in a scratch directory outside git, in
two batches, each taken from the shared tree after its unmutated suite passed there (129 of 129,
then 131 of 131): `node scripts/mutants.mjs "oauth:"` (26), then the ones added or changed after
the first copy. **28 of 28 killed in the end. One survived first and is reported here:** 88 (a
code stored in clear) lived because every flow in the at-rest test ended in a code reuse, which
deletes the grant's code rows before the dump; the test now keeps a spent code and an unexchanged
one stored, checks two code rows exist, and 88 is killed. 85's text was updated when the
approver check (92) changed the line it mutates, and it was run again: killed. 41, 42 (the refusal
paths beside the changed constructor) and 58 (its anchor moved) were run again: killed. After the
second batch the copy's `src/`, `contracts/`, `openapi.json`, mcp's `src/` and the gateway's were
compared with the shared tree byte for byte: equal. 1–40, 43–57 and 59–65 were not re-run.

**59–65** (the service surface, an earlier change) were run on 2026-11-19 in a copy in a scratch
directory (`node scripts/mutants.mjs "service:"`): **7 of 7 killed**; the copy was taken from
the shared tree after its suite passed 100 of 100. 1–58 were not re-run in this change.

**All 58 were run as one set on the final code on 2026-11-19, in a copy in a scratch
directory whose unmutated suite was first checked green (92 of 92): 58 of 58 killed.**
Afterwards the copy's `control/src`, `contracts/schema.ts` and `openapi.json` were compared
with the shared tree byte for byte: equal. 46–58 are this change's (proposals that create a
dashboard, scopes for other services, `whoami`, schema version 2, the health route); their
first run, before a container restart, did not report, so this is their only result.

| # | Mutant | Caught by (tests failing) |
|---|---|---|
| 1 | Tenant taken from a request parameter (`?tenant=`) | isolation, rules (3) |
| 2 | The same, and the Tenant object trusting the tenant it is told (since the review of D44: and taking the caller's word for the key) | isolation, rules (3); re-run after the review: isolation, oauth-review, rules (4) |
| 3 | Secret stored in clear | isolation, compat, creation, dashboards, durability, golden, http, keys, openapi, property, proposals, scopes, settings (68) |
| 4 | List returning the stored secret material | keys (2) |
| 5 | Base-revision check skipped on patch | dashboards, http, property, settings (6) |
| 6 | Apply without the apply scope | creation, openapi, proposals (3) |
| 7 | Agent self-apply allowed | proposals (1) |
| 8 | Proposal applied against a moved dashboard without the rebase check | proposals (1) |
| 9 | Mutation not atomic with its audit row: a failure part-way, then a retry, leaves a change with no entry | creation, dashboards, durability, keys, proposals, scopes, settings (11) |
| 10 | KV written before the transaction commits | durability, keys, rules, settings (4) |
| 11 | Soft-deleted dashboard still listed | dashboards, durability, isolation (3) |
| 12 | Dry run commits | creation, dashboards, keys, proposals, scopes, settings (9) |
| 13 | A mutation without an audit row, structural guard removed | settings (2) |
| 14 | Disabled key still accepted by the Tenant object | keys (2) |
| 15 | Disabled key published to KV as enabled | golden, keys (2) |
| 16 | Old secret kept in KV after a rotation without overlap | durability, keys (2) |
| 17 | Revocation generation not bumped on disable | durability, golden, keys (4) |
| 18 | Key deleted without its name as confirmation | keys (1) |
| 19 | Last admin key may be disabled or deleted | keys (1) |
| 20 | Usage accepted for another tenant | keys (1) |
| 21 | Rebase check ignores edits made underneath | proposals (1) |
| 22 | Expired proposal can still be applied | creation, proposals (2) |
| 23 | Partial apply applies every change | proposals (1) |
| 24 | Proposer not recorded on the applied revision | proposals (3) |
| 25 | An agent with the apply scope may write directly | creation, proposals, scopes (3) |
| 26 | `If-Match` ignored | dashboards (3) |
| 27 | Revision cap not enforced | dashboards (1) |
| 28 | Tenant byte cap not enforced | dashboards (1) |
| 29 | Pool epoch not bumped when spread grows | settings (1) |
| 30 | Pool slot-count change not refused | settings (1) |
| 31 | Shortening retention needs no confirmation | settings (1) |
| 32 | A statement that does not name the tenant | rules (1) |
| 33 | Alarm left set when there is nothing to do | dashboards, durability, proposals (4) |
| 34 | CORS answers any origin | http (1) |
| 35 | A route without documentation | openapi (2) |
| 36 | Runner: storage a newer release wrote is opened although it is not readable (refusal removed) | compat (1) |
| 37 | Runner: newer storage that IS readable is refused (`compat` ignored) | compat (2) |
| 38 | Runner: opening newer, readable storage lowers its version | compat (2) |
| 39 | Runner: migrations not in one transaction (a failing step leaves half a migration) | compat (1) |
| 40 | Runner: the new version is not recorded (every open migrates again) | compat (6) |
| 41 | `Tenant` serves storage a newer release wrote (its refusal ignored) | compat (1) |
| 42 | A refusing `Tenant` lets its alarm lapse | compat (1) |
| 43 | A released migration edited in place (version 1 no longer creates the append-only trigger) | compat, settings (3) |
| 44 | The KV key record edge reads changes shape without a format version | golden, keys (2) |
| 45 | The list cursor encoding changes without a format version | golden (1) |
| 46 | Creation: an agent may apply a proposal that creates a dashboard | creation (1) |
| 47 | Creation: the proposed spec is not validated | creation (1) |
| 48 | Creation: the stored spec is not validated again when applied | creation (1) |
| 49 | Creation: a retry stores a second proposal (idempotency removed) | creation (1) |
| 50 | Creation: an id held by a live dashboard is not checked | creation, dashboards, settings (4) |
| 51 | Creation: a row an older release rewrote into a change is still read as a creation | creation (1) |
| 52 | Creation: purging a dashboard deletes an open proposal to create one under its id | creation (1) |
| 53 | Scopes: control cannot issue the ruler's scopes | openapi, scopes (4) |
| 54 | Scopes: a monitors scope opens the dashboards API | openapi, scopes (2) |
| 55 | `whoami`: `mayApply` ignores the tenant setting (an agent with the scope always may) | creation, scopes (2) |
| 56 | Migration 2 declared forward-only (`readableFrom: 2`) | compat (3) |
| 57 | Released migration 2 edited in place (the column is not added) | isolation, compat, creation, dashboards, durability, proposals, scopes, settings (32) |
| 58 | `/healthz` not served (or behind a credential) | http (1) |
| 59 | service: `notificationTarget` answers for any tenant | service (1) |
| 60 | service: `serviceKey` issues for any tenant | service (1) |
| 61 | service: the webhook secret stored in the settings value (reads and audit carry it) | service (2) |
| 62 | service: a webhook secret follows the webhook to a new URL | service (1) |
| 63 | service: a service key a person disabled is replaced | service (1) |
| 64 | service: a rotation keeps the previous secret live | service (1) |
| 65 | service: a person may create a key under the reserved `service:` prefix | service (1) |
| 66 | oauth: a grant holds scopes its approver's key does not | oauth (1) |
| 67 | oauth: `admin` stands for every grantable scope | oauth (1) |
| 68 | oauth: an agent key may approve | oauth (1) |
| 69 | oauth: approving needs only `dashboards:write`, not `admin` | oauth, openapi (2) |
| 70 | oauth: the PKCE verifier is not checked at the token endpoint | oauth (1) |
| 71 | oauth: plain PKCE (or none) accepted at `/oauth/authorize` | oauth (1) |
| 72 | oauth: a used code is accepted again | oauth (3) |
| 73 | oauth: code reuse refused but what it issued not revoked | oauth (2) |
| 74 | oauth: refresh tokens not rotated (a used one stays valid) | oauth (1) |
| 75 | oauth: refresh token reuse refused but the grant not revoked | oauth (1) |
| 76 | oauth: redirect URI matched as a prefix at `/oauth/authorize` (open redirect) | oauth (1) |
| 77 | oauth: redirect URI not checked at the token endpoint | oauth (1) |
| 78 | oauth: an error redirected to the client's callback automatically (302) | oauth (1) |
| 79 | oauth: the client id's signature not checked (tampered or forged registrations accepted) | oauth (1) |
| 80 | oauth: an unapproved registration never expires | oauth (1) |
| 81 | oauth: an expired access token is accepted | oauth (1) |
| 82 | oauth: the audience is not checked | oauth (1) |
| 83 | oauth: revoking a grant leaves its tokens | oauth (1) |
| 84 | oauth: revoking a grant leaves its key (live in KV for the data path) | oauth (3) |
| 85 | oauth: a suspended grant (its key disabled) still works at the resource | oauth (1) |
| 86 | oauth: introspection answers for another tenant's object | golden, oauth (2) |
| 87 | oauth: the token endpoint takes the tenant from a form field | rules (1) |
| 88 | oauth: a code stored in clear, not hashed | **survived the first run**; after the test was strengthened: oauth (1) |
| 89 | oauth: an error body repeats the presented code | oauth (1) |
| 90 | oauth: a code nobody exchanged leaves its grant (and key) live | oauth (1) |
| 91 | oauth: a grant's key can be rotated through the keys API | oauth (1) |
| 92 | oauth: introspection ignores the approver's key | oauth (1) |
| 93 | oauth: a credential naming an unprovisioned tenant creates storage for it | oauth (1) |
| 94 | pool: a pool ending in `/traces` or `/logs` is published (D66) | settings (1) |
| 95 | pool: only `/traces` is refused, `/logs` is published | settings (1) |
| 96 | pool: any pool containing a derived signal's name is refused (too broad) | settings (1) |
| 97 | pool: the suffix is compared without case (too broad) | settings (1) |

**94–97** (D66) were run on 2026-11-19 in a copy in a scratch directory outside git, taken from the
shared tree after its suite passed there (132 of 132) and checked green in the copy (132 of 132):
`node scripts/mutants.mjs "pool:"`, **4 of 4 killed**, each by the new settings test alone.
Afterwards the copy's `control/src` and `contracts/` were compared with the shared tree byte for
byte: equal. 1–93 were not re-run in this change.

| 98 | review M-1: `OAuthIntrospection` answers any caller (`props.caller` not checked) | oauth-review (1) |
| 99 | review M-1: `invoke` accepts an identity without a key, as the caller states it | oauth-review (1) |
| 100 | review M-1: a grant whose approver is not a key counts as live (the approver check fails open) | oauth-review (1) |
| 101 | review M-1: `approve` accepts an approver that is not a key | oauth-review (1) |
| 102 | review M-2: the token endpoint asks the object without checking the tag | forged-cost, oauth-review (4) |
| 103 | review M-2: revocation asks the object without checking the tag | forged-cost, oauth-review (3) |
| 104 | review M-2: `OAuthIntrospection` asks the object without checking the tag | forged-cost, oauth-review (3) |
| 105 | review M-2: any credential of the right shape passes the tag check | forged-cost, oauth-review (5) |
| 106 | review M-2: the token endpoint re-arms the alarm after a request that wrote nothing | oauth-review (1) |
| 107 | review M-2: revocation re-arms the alarm after a request that wrote nothing | oauth-review (1) |
| 108 | review M-2: a request that wrote something does not re-arm the alarm or publish (the fix overdone) | oauth-review, oauth (3) |
| 109 | review m-1: an approver key's expiry is no alarm deadline | oauth-review (1) |
| 110 | review m-2: a body without `Content-Length` is read whole before its size is checked | oauth-review (1) |
| 111 | review m-3: a redirect URI may carry non-ASCII (bidirectional, invisible) characters | oauth-review (1) |
| 112 | review m-5: the approval warns to approve only what one started for loopback redirects only | oauth-review (1) |
| 113 | review m-5: the authorize page warns for loopback redirects only | oauth-review (1) |

**98–113** (the review of D44, `design/reviews/d44-d52-d53-d60.md`) were run on 2026-11-19 in a
copy of the whole tree in a scratch directory outside git, after its unmutated suite passed 147 of
147 there (`node scripts/mutants.mjs "review"`): **16 of 16 killed, first run**. They were run a
second time, with the same result, because the first run's report named no files: the runner's
pattern for a failing file did not accept a hyphen (`oauth-review`); it does now. Two earlier
mutants whose text this change moved were brought up to date and run again: 2 ("tenant taken from
a request parameter, and the Tenant object trusting what it is told": the object now checks every
identity's key, so trusting means taking the caller's word for the key's subject, kind and scopes)
**killed** by isolation, oauth-review and rules (4); 88 ("a code stored in clear, not hashed": `p.code!`)
**killed** by oauth (1). 106 and 107 are each caught by one test only, the one that calls the
object directly with tagged but unknown credentials: through HTTP the tag check (102, 103) stops a
forged credential first. 1, 3–87 and 89–93 were not re-run. The copy's `src/`, `scripts/`, `test/`
and `contracts/` were compared with the worktree's afterwards: equal, but for one comment line in
`contracts/oauth.ts` and one table row in `contracts/README.md`, written after the copy was taken.

Mutants 36–40 break `contracts/schema.ts`, the runner every component shares; they are run
here because this suite tests it most fully.

Mutant 6 survived the functional tests on the first run and was caught only by the
OpenAPI scope comparison: the one test that applied without the scope used an agent, which
is refused for another reason. A test with a write-only person's key was added.

Mutant 9 is the closest faithful form of "audit entry skipped on failure then retry" this
design allows: the audit row cannot be skipped separately, because it is in the same
transaction as the change. The test that pins it: a create that is refused after its first
insert, then retried, yields one dashboard and one entry.

| # | Mutant | Caught by (tests failing) |
|---|---|---|
| 114 | rate limit (D70): registration and the authorization page do not ask the source limit | oauth-cost, ratelimit, ratelimit-review (8) |
| 115 | rate limit (D70): registration reads its body before the source limit | oauth-review, ratelimit (2) |
| 116 | rate limit (D70): an IPv6 source is counted by its whole address, not its /64 | ratelimit (1) |
| 117 | rate limit (D70): the source is taken from `X-Forwarded-For`, a header the client writes | oauth-cost, ratelimit, ratelimit-review (7) |
| 118 | rate limit (D70): the token endpoint counts a credential before its tag is checked (a made-up one spends the tenant's fuse) | ratelimit, ratelimit-review (6) |
| 119 | rate limit (D70) B-1: the narrow key at the token endpoint is the presented `client_id` again | ratelimit-review (2) |
| 120 | rate limit (D70) B-1: the tenant fuse is asked before the credential (one credential spends it) | ratelimit, ratelimit-review (5) |
| 121 | rate limit (D70): the token endpoint and revocation have no per-tenant fuse | ratelimit (3) |
| 122 | rate limit (D70) B-1: revocation has no per-token key (each request a fresh one) | ratelimit, ratelimit-review (2); round 2: **survived** the first pass, killed after a test was added: ratelimit-review (1) |
| 123 | rate limit (D70): introspection has no per-token limit | ratelimit (3) |
| 124 | rate limit (D70): introspection has no per-tenant fuse | ratelimit (2) |
| 125 | rate limit (D70): introspection counts a token before its tag is checked (a made-up one spends the tenant's fuse) | ratelimit, ratelimit-review (5) |
| 126 | rate limit (D70): a bearer over its limit is told its token is inactive (the client discards it) | ratelimit (1) |
| 127 | rate limit (D70): a limiter that fails, fails closed | ratelimit, ratelimit-review (4) |
| 128 | rate limit (D70): an absent limiter fails closed | forged-cost, golden, isolation, oauth, oauth-cost, oauth-review, ratelimit, ratelimit-review, settings (70) |
| 129 | rate limit (D70): a limiter call has no time limit (a hung limiter hangs every OAuth request) | ratelimit, ratelimit-review (3) |
| 130 | rate limit (D70): the refusal carries no `Retry-After` | ratelimit (8) |
| 131 | rate limit (D70): the refusal uses an error code clients do not know (`rate_limited`) | ratelimit (8) |
| 132 | rate limit (D70): refreshes per grant are not limited in the object | ratelimit (3) |
| 133 | rate limit (D70): the per-grant limit is checked after the presented token is spent | ratelimit (2) |
| 134 | rate limit (D70): the per-grant limit is checked before reuse detection (a rotated token at the limit no longer ends the grant) | ratelimit (2) |
| 135 | rate limit (D70): the per-grant limit counts every grant of the tenant (one loop refuses the others) | oauth-cost, ratelimit (4) |

**114–135** (rate limits in front of OAuth, D70) were first run with D70's first version (22 of 22
killed). After its review, 114–129 were rewritten for the code as changed (the keys, the order, the
budget) and 146–165 added below; 130–135 (the refusal and layer 2) are unchanged. Positions in
`scripts/mutants.mjs` are now the table's numbers (counted by evaluating the list); the review's
mutants were appended after 136–145 so that no other mutant moved. All 42 were run on 2026-11-19 in
a copy of `control/`, `contracts/`, `edge/src`, `shard/src`, `ruler/src`, `mcp/src` (and
`mcp/wrangler.jsonc`), `janitor/src`, `compact/src`, `flush/src` and `dashboard/` in a scratch
directory outside git, after its unmutated suite passed 183 of 183 there (`node scripts/mutants.mjs
"rate limit (D70"`, with the machine's load average 6–10 from other builders' runs): **40 of 41
killed in the first run.** The survivor was 158 ("no grace"): the test computed its two
credentials' expiries from `EXPIRY_GRACE_MS` itself, so with the constant at 0 its inputs moved
with it. The test now uses whole-minute expiries fixed in the test (one 0–60 s ago, one 60–120 s ago).
Run again: **killed**. 129 ("no time limit"), added after the run began, was run on its own:
**killed**. So **42 of 42**. Afterwards the copy's `control/src` and `contracts/` were compared with
the worktree's: equal; `control/test` differed only in that grace test, which was copied in before
the second run. 1–113 and 136–145 were not re-run in this change.

| # | Mutant | Caught by (tests failing) |
|---|---|---|
| 136 | signals review B-1: shortening is judged only on the fields both values name (the fix undone) | settings (3): the first retention test, "a field left out returns to its default…", the property |
| 137 | signals review B-1: a field left out counts as unchanged (a PUT that drops `trace_days` or `log_days` passes) | settings (2): "a field left out…", the property |
| 138 | signals review B-1: a signal set for the first time is not compared with its default | settings (3): the first retention test, "a field left out…", the property |
| 139 | signals review B-1: control's signal default is 29 days, the janitor's 30 (they drift: shortenings pass) | settings (2): "a field left out…", the property |
| 140 | signals review B-1: control's signal default is 31 days, the janitor's 30 (they drift: lengthenings refused) | settings (2): "a field left out…", the property |
| 141 | signals review B-1: a rollup tier that was set and is left out passes | settings (1): "a field left out…" |
| 142 | signals review M-5: the dedicated pool is `tenant/<id>` verbatim, with its `_` (edge refuses it) | settings (1): "the dedicated pool is dedicatedPool(tenant)…" |
| 143 | signals review M-5: only the derived suffixes are checked, not `POOL_NAME` (D66 as first built) | settings (1): the same |
| 144 | signals review M-5: the shared base-pool rule drops `POOL_NAME` (`shard/src/pool.ts`) | settings (1): the same |
| 145 | signals review M-5: `dedicatedPool` keeps `_` (`shard/src/pool.ts`) | settings (1): the same |

**136–145** (review B-1 and M-5 of `design/reviews/signals-end-to-end.md`; positions 136–145 in
`scripts/mutants.mjs`, counted by evaluating the list) were run on 2026-11-19 in a copy of
`contracts/`, `control/`, `janitor/`, `shard/`, `edge/`, `compact/`, `flush/`, `ledger/`,
`publisher/`, `dashboard/`, `ruler/src`, `mcp/src` and `engine/wasm` in a scratch directory outside
git, after its unmutated suite passed 164 of 164 there (`node scripts/mutants.mjs "signals review"`):
**10 of 10 killed, first run.** The run of 142 also failed `ratelimit.test.ts` once; that file's
windows are timed, and a second run against `settings.test.ts` alone named the settings test, so
142 counts as killed by settings only. The anchors of **94–97** (D66) moved with M-5: the gate is now
`validBasePool`, so 94 removes the call in `src/ops-settings.ts` and 95–97 break the shared function
in `shard/src/pool.ts` (only `/traces`; `includes`; case-blind). Run again in the same copy: **4 of 4
killed** (94, 95: the D66 test and the M-5 test; 96, 97: the D66 test). 31 ("shortening retention
needs no confirmation") was run again: **killed** by settings (3). The test names above come from a
second run of each against `settings.test.ts` alone, with the same results. Afterwards the copy's
`control/src`, `control/test`, `control/scripts/mutants.mjs`, `janitor/src`, `janitor/test`,
`shard/src`, `shard/test` and `edge/src/route.ts` were compared with the worktree's: equal. After
that, only the description of `PUT /settings/{section}` in `src/openapi.ts` (and the generated
`openapi.json`) changed; no mutant touches it, and the suite passed again. 1–30, 32–93 and
98–135 were not re-run.

| # | Mutant | Caught by (tests failing) |
|---|---|---|
| 146 | rate limit (D70) m-6: no /48 key (one host's routed /48 is 65,536 budgets) | ratelimit (2) |
| 147 | rate limit (D70) M-1: the token endpoint counts every request's network again, genuine credentials included | ratelimit, ratelimit-review (2) |
| 148 | rate limit (D70) M-1: revocation counts genuine tokens by network | ratelimit, ratelimit-review (2) |
| 149 | rate limit (D70) M-1: the Workers address is counted (anyone on Workers refuses every Worker-hosted client) | ratelimit, ratelimit-review (2) |
| 150 | rate limit (D70) M-1: a request the token endpoint refuses by itself is not counted by network | ratelimit, ratelimit-review (2) |
| 151 | rate limit (D70) m-3: a CORS preflight of the authorization page is counted | ratelimit (1) |
| 152 | rate limit (D70) B-1: the bearer fuse is asked before the token | ratelimit (1) |
| 153 | rate limit (D70) B-1: an expired code or refresh token is not refused at the token endpoint | ratelimit, ratelimit-review (4) |
| 154 | rate limit (D70) B-1: an expired token is not refused at revocation | ratelimit, ratelimit-review (3) |
| 155 | rate limit (D70) B-1: an expired access token is not refused at introspection | ratelimit, ratelimit-review (3) |
| 156 | rate limit (D70) B-1: credentials are minted without an expiry (layout 1) | ratelimit, ratelimit-review (8) |
| 157 | rate limit (D70) B-1: the expiry is rounded down (the Worker could refuse a live credential early) | ratelimit (3) |
| 158 | rate limit (D70) B-1: no grace for a Worker clock ahead of the object's | ratelimit (1) |
| 159 | rate limit (D70) B-1: an access token carries its issue time as its expiry (refused a minute after issue) | ratelimit (1) |
| 160 | rate limit (D70) m-1: each check gets its own budget (a request's waits add up). Since round 2: each check gets the whole budget, not its share (a slow check is not the one blamed) | ratelimit (1); round 2: ratelimit, ratelimit-review-r2 (4) |
| 161 | rate limit (D70) m-1: a failed binding is not skipped (every request waits for it) | ratelimit, ratelimit-review (3) |
| 162 | rate limit (D70) m-1: the budget is 1 s, as before the review | ratelimit-review (1) |
| 163 | rate limit (D70) M-2: an absent limiter is logged on every request | ratelimit (1) |
| 164 | rate limit (D70) M-2: an absent limiter is not logged | ratelimit (1) |
| 165 | rate limit (D70) M-2: `/healthz` does not report the limiters | ratelimit (2) |

**146–165** (the review of D70, `design/reviews/d70-rate-limits.md`: each undoes one fix of B-1, M-1,
M-2, m-1, m-3 or m-6) ran in the same run as 114–135, above. All of 114–135 and 146–165 ran again in
round 2 with 166–189 ("Mutants, round 2", under "Rate limits in front of OAuth (D70)" in
"Verification"): 65 of 66, then 66 of 66.

**166–189** (the second review of D70, `design/reviews/d70-rate-limits-r2.md`: each undoes one fix of
R2-M1, R2-M2 or m-2, or one property of the list of dead credentials), 2026-11-19: **24 of 24
killed** in the round 2 run.

| # | Mutant | Caught by (tests failing) |
|---|---|---|
| 166 | R2-M1: a wider key is asked after a narrower one was skipped (the fuse alone counts a dead credential again) | ratelimit, ratelimit-review-r2 (7) |
| 167 | R2 m-2: an expired refresh token or code is counted against its network again | ratelimit, ratelimit-review-r2 (2) |
| 168 | R2 m-2: an expired token at revocation is counted against its network again | ratelimit, ratelimit-review-r2 (2) |
| 169 | R2-M2: the token endpoint does not consult the list | deadlist, oauth-cost, ratelimit, ratelimit-review, ratelimit-review-r2 (8) |
| 170 | R2-M2: revocation does not consult the list | oauth-cost, ratelimit, ratelimit-review, ratelimit-review-r2 (5) |
| 171 | R2-M2: introspection does not consult the list | oauth-cost, ratelimit-review-r2 (2) |
| 172 | R2-M2: the token endpoint does not list a refresh token its object calls dead | deadlist, oauth-cost, ratelimit-review-r2 (6) |
| 173 | R2-M2: revocation ignores the object's `dead` (a stock replayed at `/oauth/revoke` is never listed) | deadlist, golden, oauth-cost, ratelimit, ratelimit-review, ratelimit-review-r2 (7) |
| 174 | R2-M2: introspection does not list a token its object calls dead | deadlist, oauth-cost, ratelimit-review-r2 (5) |
| 175 | R2-M2: introspection lists a suspended or wrong-audience token (it would not come back) | deadlist (1) |
| 176 | R2-M2: the token endpoint lists a refresh token on any error (one refused for its scope or resource would never work again) | deadlist, oauth (2) |
| 177 | R2-M2: the object calls a live token dead when another client revokes it | deadlist, oauth, ratelimit-review (3) |
| 178 | R2-M2: the object never says a revoked token is dead | deadlist, golden, oauth-cost, oauth-review, ratelimit, ratelimit-review, ratelimit-review-r2 (9) |
| 179 | R2-M2: a listed credential's KV record never expires | golden, ratelimit-review-r2, rules (3) |
| 180 | R2-M2: the list forgets a credential before the Worker's expiry check refuses it (no grace) | deadlist, golden, ratelimit-review-r2 (3) |
| 181 | R2-M2: a credential with less than KV's 60 s left is written anyway | deadlist (1) |
| 182 | R2-M2: no once-per-isolate guard on writes (concurrent replays write each) | deadlist (1) |
| 183 | R2-M2: the isolate ignores what it already knows is dead (every replay reads KV) | deadlist, oauth-cost (6) |
| 184 | R2-M2: a credential KV did not list is read again on every request | deadlist (1) |
| 185 | R2-M2: the isolate's memory of credentials is unbounded | deadlist (1) |
| 186 | R2-M2: a failed KV read fails closed (every credential refused as listed) | deadlist (2) |
| 187 | R2-M2: a KV read has no time limit (a hung KV hangs every token request and `/mcp` call) | deadlist (1) |
| 188 | R2-M2: a failed KV read is not skipped (every request waits for KV again) | deadlist (2) |
| 189 | R2-M2: the grant view's refresh count counts every grant of the tenant | ratelimit-review-r2 (1) |

Re-anchored in round 2 and run (each killed): 102, 103 (stale since round 1, above), 107, 128, 153,
154, 160, 164. 102: forged-cost, oauth-cost, oauth-review, ratelimit, ratelimit-review,
ratelimit-review-r2 (9); 103: forged-cost, oauth-review, ratelimit (5); 107: oauth-review (1); 128:
eleven files (95); 153 and 154: ratelimit, ratelimit-review, ratelimit-review-r2 (4 each); 164:
ratelimit (1).

## Known risks

- **A refusal is an outage for that tenant's control plane**, until the newer release serves
  the object again: safe (nothing written), not available. It happens only after a rollback
  across a forward-only release (`contracts/COMPATIBILITY.md` §6).
- **The first versioned release must become the rollback floor** before any migration 2:
  code from before it does not check the version row.

- **Revocation on the data path is bounded by caches, not by this component** (table above),
  and the KV half of the bound is not a guarantee. "Revocable at the shard" (DESIGN §9)
  does not exist yet.
- **KV write limits.** Cloudflare limits writes to one KV key to about one per second
  (training knowledge). Rapid changes to one key or setting would then fail in the drain
  and be retried by the alarm 30 s later, in order. Local KV does not enforce the limit, so
  this path is tested only with a KV that fails entirely.
- **Two agents can approve each other's changes.** The rule is that an agent may not apply
  its own proposal; an agent with the apply scope may apply another's change. (Not a
  proposal that creates a dashboard: that needs `agentsMayApply`, as a direct create does.)
  Do not give agents `dashboards:apply` until that is wanted.
- **Release 1 against a proposal that creates a dashboard was not run.** That the previous
  release fails closed on such a row ("Versioned storage" above) rests on reading its
  handlers. What is tested: its runner opens version 2 storage unchanged, and this release
  reads a row release 1 would have rewritten as a change.
- **The health route is shallow.** It proves the Worker runs with its bindings, not that a
  `Tenant` object or KV answers; a KV or Durable Object outage shows only in real requests.
- **Scopes for other services are issued here, checked there.** A key with `monitors:ack`
  is created without this component knowing whether the ruler is deployed; a scope renamed
  in the ruler or mcp is caught by `scopes.test.ts`, which reads their source.
- **`admin` is total.** An admin key can create a key of any scope and kind, set
  `agentsMayApply`, and raise the tenant's own limits unless `LIMIT_CEILINGS` is set. An
  agent with `admin` can therefore get around the agent rules. On a hosted deployment
  limits and retention need an operator surface, which does not exist.
- **The rebase check is syntactic.** It is conservative for arrays (any edit in the same
  array is a conflict, so layout changes often need a rebase) and blind to meaning (a
  proposal that adds a panel on a query whose expression was changed underneath is clean).
- **The audit log and the revisions of live dashboards are never pruned.** The tenant byte
  cap bounds revisions; nothing bounds the audit log but the object's 10 GB.
- **Audit entries for dashboards hold revision ids and summaries, not specs.** After a
  purge the specs are gone and the entries point at nothing.
- **Three round trips per request**: a KV read (cached by edge's code for 60 s per isolate)
  and two Durable Object calls. Not measured.
- **Edge's verifier is called once per known scope** until one fits (up to nine SHA-256
  computations), because its signature insists on a scope. See "Needed changes".
- **Clock.** Expiry, overlap and purge use the object's `Date.now()`.
- **Tenants whose ids differ only in `_` and `-` share their dedicated shard objects**
  (`acme_prod` and `acme-prod` both get `tenant/acme-prod`, D66 as revised after review M-5, and
  D38). Streams, epochs and keys stay per tenant, so nothing mixes, but a noisy one slows the
  other, as on a shared pool. (Before the revision a tenant id with `_` got `tenant/<id>` verbatim,
  which edge refuses: every write a 503.)
- **A pool map published by an earlier control that edge refuses** is not withdrawn: one whose
  pool ends in `/traces` or `/logs` (tenants `traces` or `logs`, before D66) or has a `_` (a tenant
  id with `_`, before the revision of D66). Edge answers 503 to every write of such a tenant.
  Replacing it is a pool change, refused with 409 (and raising `spread` is refused too, since the
  stored pool is no longer one control accepts); it needs the drain-and-handover protocol (DESIGN
  §4.1) or an operator. None is known to exist: no viz-control has served in production.
- **Control's copy of the janitor's retention defaults** (`KEPT_WHEN_ABSENT`, 30 days for spans
  and logs) is a second statement of `DEFAULT_SIGNAL_DAYS`. The settings property test fails if
  they disagree in this tree; it cannot see a janitor deployed at another release with another
  default.
- **The first own pool map moves the tenant's writes** from the shared pool to the new one
  with no handover. The task allows it; a tenant with data in flight would see the effects
  edge's README describes for `stale_epoch`.
- **Run on Cloudflare only in two staged trials** (`deploy/README.md`): keys, settings, the
  notification settings and the service key through the gateway. KV expirations (60 s
  minimum), SQLite triggers in Durable Objects, alarm behaviour and everything OAuth were
  exercised in local workerd only.
- **OAuth: a grant's key reaches KV when the person approves.** The agent surface calls the query
  service, the control plane and the ruler with it; a location whose KV has not seen the new
  record yet refuses it (401), and edge remembers a miss for 10 s. The time from approval to the
  first call (the person opens the link, the client exchanges the code) usually covers it, but
  that is modelled, not measured. Experiment: approve on a deployed stack and time the first
  successful downstream call from several regions.
- **OAuth: a refresh retried after a lost response counts as reuse** and ends the grant (the
  person approves again). Strict by choice; a grace window would let a copied token through.
- **OAuth: the tenant id is readable in codes and tokens.** Only their holder, the client acting
  for that tenant, sees them; they are never logged.
- **OAuth is public in production without the rate limits (D70)**: since 2026-11-19, when the owner
  deployed `main` at PR #8, which has none of D70. "Required before public exposure" was not met. This
  change and the deploy's gate ("Needed changes elsewhere") are the remedy, and only a deploy can
  enforce the gate. The Worker checks the bindings and fails open without them, logging each
  absent one once per isolate and listing it as `absent` in `/healthz`. The deploy does not create
  the bindings. Until it does, OAuth runs without layer 1:
  - a made-up credential costs one HMAC in the Worker and reaches no object (since the review of
    D44, M-2);
  - an expired one costs the same (since the review of D70);
  - a dead one is listed at its first answer and refused before any object afterwards, since round 2:
    the list needs only `CONFIG`, which every deployment binds;
  - layer 2, the exact per-grant refresh limit, works already.
- **OAuth: a stock of dead credentials still has one window** (D70, "What an attacker can still do";
  modelled). Refresh tokens collected at layer 2's limit while a grant was live (by its client, or a
  thief of one live refresh token of an idle grant), replayed after the grant ends, each reach the
  object once in every isolate that has not learned they are dead: until KV shows the record in that
  location (about 60 s, training knowledge, unmeasured), plus up to 60 s in an isolate that read it
  as absent before. At most 5 a minute per credential per location (1,200 for access tokens).
  - Tripping the token fuse takes about 1,200 such refresh tokens (3 h 20 min of rotating at the
    limit), and the bearer fuse 25 access tokens less than an hour old. Either lasts a minute or two
    in each location replayed at once, and then the stock is spent. Before round 2 it lasted 30 days
    and repeated every minute (reproduced by the review, N1, N1b; turned around in
    `test/ratelimit-review-r2.test.ts`).
  - While it lasts, the tenant's refreshes and revocations (or `/mcp` calls) in those locations get
    429: TypeScript-SDK clients keep their tokens, Python-SDK clients (`mcp` 2.3.0) discard them and
    a person approves again.
  - A client the tenant approved can still trip the bearer fuse with 25 **live** access tokens (about
    4 minutes of refreshes) for as long as it is approved, and two locations at that fuse can saturate
    the object (round 2, m-4). The grant view's `refreshesLastDay` shows a grant rotating faster than
    a client needs; revoking it is the remedy.
- **OAuth: the list of dead credentials rests on KV** (`src/deadlist.ts`). Not run on Cloudflare: a
  cold read's latency (one per refresh, and one per isolate a minute per access token at `/mcp`) and
  the propagation time are training knowledge. The list shares `viz-config` with edge, the janitor
  and the others under its own prefix `oauth-dead:`; a reader listing other prefixes is unaffected
  (`flush` lists `pool:`, the stack lists its markers). Its cost is modelled in D70: $0.02–0.22 a
  month per client working all day, a few writes a month per tenant, $0.006–0.30 per stock of 1,200
  replayed; the ceiling, every credential layer 2 lets be minted later replayed dead, $4.32 a day per
  tenant beside the $4.75 of rows the minting costs.
- **OAuth: while a narrow limiter is down in an isolate, its fuse counts nothing there** (round 2,
  R2-M1, by design): dead credentials reach the object once each, live ones as often as they are
  sent, for 10 s per failure. If the list cannot be read at the same time, dead credentials the
  isolate does not remember reach the object as often as they are sent too. Both fail open: a fault
  costs protection of the object, never a refusal.
- **OAuth: credentials issued by the previous release (layout 1) carry no expiry.** Until they expire
  in their object (30 days at most) they spend their allowance and the fuse as any unexpired
  credential does. None was issued in production.
  - A layout 1 body begins with layout 2's marker one time in 62. It is then read with an expiry
    uniform over 28 years, so about 1 in 13,000 of them could be refused as expired early in the
    month after the change.
  - Layout 2's random part is 22 characters, about 131 bits (27 and 160 before). RFC 6749 §10.10 asks
    for at most 2^-128, and the 16-character tag, which only `OAUTH_CLIENT_KEY` makes, adds to it for
    anyone without the key.
  - The expiry field runs out in 2054-12: a later credential would carry the last minute it can
    hold, and the Worker would never refuse it early.
- **OAuth: the binding's limits are per Cloudflare location and approximate** (its documentation,
  read 2026-11-19: "Requests can exceed your configured limit before those updates arrive"; "Other
  Cloudflare locations maintain separate counts").
  - A client served from N locations gets N budgets, and a burst overshoots.
  - A botnet gets 120 registrations and authorization pages a minute per network. A host with a
    routed /48 gets 1,200 per /48, not 65,536 × 120 (m-6; training knowledge that tunnel brokers hand
    them out).
  - People behind one NAT or carrier-grade NAT share one network's budget at those two endpoints.
    That is why the page advises against IP keys; the source limit sits well above what a group
    connecting at once needs.
  - A broker that registers a client for each of its users from one egress address shares 120 a
    minute per location (modelled; brokers' egress is training knowledge). Its users' refreshes are
    not counted by network.
  - What reaches objects without an unexpired genuine credential is nothing, whatever the counts;
    what is stored is bounded exactly (layer 2).
- **OAuth: the limits assume no Smart Placement for viz-control and viz-mcp** (m-8).
  `test/ratelimit.test.ts` fails if either `wrangler.jsonc` sets `placement`. The deploy's generated
  configs are not checked here ("Needed changes elsewhere").
- **OAuth: requests from Cloudflare Workers are not counted by network at all.** Every cross-zone
  Worker subrequest arrives as `2a06:98c0:3600::103` (Cloudflare's headers page, read 2026-11-19).
  Counting it would let anyone with a Workers account refuse every Worker-hosted MCP client (M-1).
  - Registrations and authorization pages from Workers are bounded only by their senders' own Worker
    spend. They cost this Worker 0.2–0.5 ms of CPU each (measured here) and store nothing.
  - If Cloudflare uses other addresses for this, they are counted as ordinary networks.
- **OAuth: a refused request is still a billed Worker request** (the gateway's). A Worker-side limit
  saves CPU and object work, not the request charge. Only a WAF rate-limiting rule on `vis.bitcru.sh`
  in front of the four paths would; not built (outside what the deploy manages; AGENTS.md allows
  rules for that host only).
- **OAuth: the limits are proposed, not measured against traffic**, and the tests run miniflare's
  implementation of the binding (an exact counter in a SQLite-backed object, windows aligned to the
  clock), not Cloudflare's. Nothing of D70 has run on Cloudflare: not the binding, and not the
  100 ms budget against how long `limit()` really takes.
  - Experiment: a stage with the bindings and clients as Durable Objects in two locations
    (AGENTS.md), counting how far a flood gets past each limit and timing `limit()`.
  - If `limit()` often takes more than its 50 ms share, that binding is skipped in the isolate for
    10 s at a time, and its fuse with it (R2-M1). It fails open, so this costs protection, not
    service.
- **OAuth: the network comes from `CF-Connecting-IP`.** Cloudflare sets it on every request that
  reaches the zone without a Worker subrequest, and the gateway forwards it unchanged.
  - A caller can choose it in two ways (m-3, m-4). A Worker in the same zone sets it from its own
    `x-real-ip` (Cloudflare's headers page; `bitcru.sh` holds unrelated hostnames). A caller by
    service binding sends whatever it likes, and without the header it shares one key, `none`, with
    every other.
  - Neither the gateway nor this Worker reads `x-real-ip`.
  - Either way the caller can evade the source limit, or spend a chosen network's registration and
    authorization budget, such as a broker's egress. Since M-1 it cannot refuse a refresh.
- **D70's round 3 fixes are not reviewed.** The third look (`design/reviews/d70-rate-limits-r3.md`)
  rejected round 2 until R3-B1 was fixed and tried the one-line fix as a counterfactual; the rest of
  this revision (the list after the per-credential limit, the per-key timeout, the rotated-and-expired
  refinement) has not been read by someone who has not seen the reasoning (AGENTS.md, "Review before
  building on it").
- **The tests run without the deploy's limiter bindings.** `control/wrangler.jsonc` now declares the
  six `ratelimits` (the deploy's change), and the test plugin would bind them in every file; so
  `vitest.config.ts` hands the plugin a copy of `wrangler.jsonc` without `ratelimits`
  (`.wrangler/test/wrangler.json`, git-ignored). The production limits themselves are therefore not
  exercised here; the rate-limit tests use the small `RL_TEST_*` bindings as before.
- **OAuth: the ruler and the gateway still bind the `Tenant` class** (`deploy/workers.json`
  `binds_classes` lists both with why), so either can call any method of any tenant's object.
  Neither handles untrusted text the way viz-mcp does, and `invoke` no longer accepts an identity
  without a key, but `serviceKey` (a rotation without overlap) and `notificationTarget` (webhook
  secrets) are reachable from both. Open: named entrypoints of viz-control for the ruler's two
  questions and the gateway's bootstrap, as for viz-mcp (review of D44, M-1).
- **OAuth: a concurrent refresh of the same token ends the grant, and one answer can be a 200
  with tokens that are already dead** (review of D44, m-4, reproduced): the request that rotated
  first stores its tokens before the other sees the reuse and revokes the grant with them. The
  strictness is documented above and RFC 9700 §4.14.2 permits it; the client learns at its next
  request (401). Open; a grace window would let a copied token through.
- **OAuth: consent is not tied to the browser that started the flow** (review of D44, m-5).
  Anyone can make an authorization link and ask an admin to run the `curl`; the warning to
  approve only a connection one started is now shown for every redirect, but the real fix is a
  sign-in (D44 "Would change if"). The `kind` of an approver key is a label: an agent given a
  person's admin key can approve itself. Open.
- **OAuth: `localhost` is accepted as a loopback redirect host** (RFC 8252 §8.3: NOT
  RECOMMENDED; review of D44, m-7), because MCP clients register `http://localhost:<port>/…`;
  and a signed registration does not name its issuer, so two deployments sharing
  `OAUTH_CLIENT_KEY` would accept each other's client ids (the deploy generates one per Worker,
  D53, so defence in depth only). Both open.
- **OAuth: registration is open and stateless.** Anyone can register any https or loopback
  callback; the person's consent (with the host shown and the name marked unverified) is the
  gate, as with any dynamic registration. Rotating `OAUTH_CLIENT_KEY` invalidates every client
  id, and, since the credential tag (review of D44, M-2), every code and token: clients connect
  again and a person approves again. A rotation should therefore be what it is meant for, a
  response to a leaked key.

## Needed changes

Things outside this directory that this component needs or exposes. Only the gateway part of 7
(in `deploy/gateway`) and 8's §3.1 were made; of 9, the gateway's routes were made.

1. **`edge/src/auth.ts`**: `authenticate`'s `scope` is typed `'write' | 'read'` and is
   mandatory. The control plane needs to verify a key without naming a scope, and to ask for
   other scopes. It casts and retries per scope. Wanted: `scope: string`, or an exported
   `verify(req, kv) → Principal`.
2. **`edge/src/auth.ts`**: `Principal` should carry `verifiedAt` (when the record was last
   read from KV), and edge or the shard should compare it with
   `revocation:<tenant>.revokedBefore`. That is what would make a revocation take effect
   faster than the 60 s cache.
3. **Usage reporting**: something on the data path has to call
   `Tenant.recordUsage`. Today the key id stops at edge; the shard sees only the tenant.
4. **`edge/README.md`** lists "any tooling to create keys" as not implemented; it now exists here.
5. **`dashboard/`**: the `outline` projection is implemented locally in
   `src/ops-dashboards.ts`; it belongs in the dashboard package, which lists it as not
   implemented.
6. **`stack/` and `app/`**: mount this Worker, bind `TENANT` and the shared `CONFIG`, and
   supply the `dashboardStates` hook from the query layer.
7. **Readers of the KV records** (edge, shard routing, janitor, query) should check a `v`
   field, absent meaning 1, and refuse a newer one (`design/UPGRADES.md` §7); only then can
   this component bump a record's version. (**deploy/gateway**, done: the bootstrap route
   answers 503 with `Retry-After` when `provision` throws `schema_too_new`, tested.)
8. **`design/DESIGN.md`**: §3.1's `Tenant` row now says what this implementation holds (no
   read cache, no rule definitions: rule groups are the ruler's), done. §9's "revocable at
   the shard" is still open.
9. **OAuth (D44)**: (**deploy/**, done, D53: the release creates `OAUTH_CLIENT_KEY` for
   viz-control when it is missing, with `wrangler versions secret put` from stdin before anything
   is promoted, and never rotates it on its own; rotation is by hand, `deploy/README.md`. Not yet
   run on Cloudflare.) `PUBLIC_URL` (the issuer and the resource are built from it) is set for viz-control and
   viz-mcp from the deployment's domain by `deploy/configure.mjs`, done. Still open, `app/`: the consent page and the grants screen ("What the UI must later show"), through
   design review.

### Needed changes elsewhere (rate limits, D70)

Not made here: `deploy/` is another builder's. Until the deploy part lands, D70's first layer is
skipped in every deployment: absent bindings fail open, logged once per isolate, `absent` in
`/healthz`. The review of D70 (M-2) found "required before public exposure" enforced nowhere, and
its second review found it still unbuilt. Item 3 is that enforcement, and **it is needed before any
production release that carries `OAUTH_CLIENT_KEY`**. Item 6 (round 2, m-3) is needed from the same
release on. Production already carries the key and serves OAuth without either (PR #8, since
2026-11-19); the deploy builder's `ratelimits` block in `control/wrangler.jsonc` and the gate in
`deploy/configure.mjs` are in progress as this is written (not read or tested here).

**`deploy/`** (all together, then the `control/wrangler.jsonc` block below):

1. **`configure.mjs`**: add `'ratelimits'` to `KNOWN_KEYS`. In `generateWorker`, for each entry of
   `out.ratelimits`:
   - require `name` to be one of the six bindings below;
   - require `simple.limit` to be a positive integer, and `simple.period` to be 60 (the Worker's
     `Retry-After` assumes 60; the platform also allows 10);
   - replace `namespace_id` with the id recorded for `<staged worker name>/<binding name>`, as KV
     ids are replaced;
   - refuse a placeholder `"0"` that survives (unless `idsOptional`), and refuse two bindings of
     one deployment with the same id.

   A stage gets ids of its own, never production's: the counters would be shared.
2. **`resources.mjs`** (and `resources.json`): allocate those ids once per deployment and record
   them.
   - `namespace_id` "uniquely defines this rate limiting namespace within your Cloudflare account",
     and the account holds unrelated Workers. Before choosing, list the account's Workers' bindings
     (read only) and exclude every `ratelimit` namespace id another script uses.
   - Take ids from a range recorded as viz's (for example 7000–7999), and refuse to reuse an id seen
     on a script whose name does not start with `viz-`.
   - Deleting a stage frees its ids. There is nothing to delete on Cloudflare: a namespace exists
     only as bindings name it.
3. **The gate** (review M-2). `configure.mjs` refuses, with a non-zero exit before anything is
   uploaded, to generate a **production** config for viz-control unless it has all six of
   `OAUTH_RL_SOURCE`, `OAUTH_RL_SOURCE_48`, `OAUTH_RL_CREDENTIAL`, `OAUTH_RL_TENANT`,
   `OAUTH_RL_BEARER` and `OAUTH_RL_BEARER_TENANT`. Each must have period 60, a positive integer
   limit and an allocated `namespace_id`. The message names the missing ones.
   - `lib/secrets.mjs` refuses, as defence in depth, to put `OAUTH_CLIENT_KEY` on a production
     viz-control version whose generated config lacks them. That key is what turns OAuth on: without
     it, registration answers 503 and no code or token can be issued.
   - A stage may leave them out only when asked (`--oauth-without-rate-limits`), and then its
     release record says so.
   - Tests in `configure.test.mjs`, next to the `binds_classes` ones:
     - production without the block is refused;
     - production with five of the six is refused, naming the sixth;
     - a period of 10 is refused;
     - the six with allocated ids pass;
     - a stage without them passes only with the flag.
4. **Placement** (review m-8): `configure.mjs` refuses `placement` on viz-control and viz-mcp while
   D70's binding layer stands, with a test. Their per-location budgets assume each request is
   counted where it arrives. Smart Placement would gather viz-control's and viz-mcp's invocations
   in a few locations, making the tenant fuses nearly global. `control/test/ratelimit.test.ts`
   checks the two components' own `wrangler.jsonc`, not what the deploy generates.
5. **`README.md`**: the bindings and their ids. Also: the gateway must keep forwarding the request
   unchanged. `forward` passes `req`, so `CF-Connecting-IP` arrives, and the gateway reads no
   `x-real-ip`; no gateway change is needed.
6. **A rollback floor for viz-control once OAuth is public** (second review, m-3; D69's
   `rollback_floors`, deploy/README.md "Rollback floors"). Rolling viz-control back to `3cbabb8` or
   earlier would mint layout 1 credentials again (no expiry the Worker can see, so dead access tokens
   and codes count for ever) and restore the first version's keys (B-1); rolling it back to any
   release before this one would restore R2-M1 and the 30-day stock (R2-M2). D69's rules key on a
   **var** of the writer: `deployFloorProblems` refuses a secret as a switch (review of D69, m-2), so
   `OAUTH_CLIENT_KEY` itself cannot be the switch. Wanted:
   - `configure.mjs` sets a plain var **`OAUTH_PUBLIC`** (`"1"`) in every production viz-control
     config that the gate (item 3) passes, that is, every release that carries or will carry
     `OAUTH_CLIENT_KEY`; a stage only when asked. From the first such release on, D69's history read
     (`switchSeen`) finds it in the versions Cloudflare keeps.
   - A rule in `deploy/workers.json` `rollback_floors` (never rename it once released):

     ```json
     {
       "name": "oauth-public",
       "writer": "viz-control",
       "var": "OAUTH_PUBLIC",
       "why": "with it, anyone reaches control's OAuth endpoints through the gateway, and clients hold codes and tokens control issued (D44, D70). Turning it off leaves those credentials valid until they expire, 30 days for a refresh token",
       "floors": {
         "viz-control": {
           "evidence": ["contracts/oauth.ts#CREDENTIAL_LAYOUT", "contracts/oauth.ts#DEAD_INACTIVE_REASONS", "control/src/deadlist.ts#recordDead", "control/src/ratelimit.ts#LISTED"],
           "why": "D70 after its two reviews: the first viz-control whose credentials carry their expiry (an older one mints credentials the Worker can never refuse as expired, and keys the token endpoint per presented client_id: B-1), asks a tenant's fuse only after the credential's own limit (R2-M1), and lists credentials found dead (R2-M2: an older one lets a stock of refresh tokens trip the token fuse for 30 days, revocation included)"
         }
       }
     }
     ```

     `LISTED` exists only from round 3 on (the other three since round 2), so the stamp marks the
     release with R3-B1 fixed; a release with round 2 alone would let a thief stop reuse detection.
   - Tests in `configure.test.mjs` and `release.test.mjs`, beside the `signal-data` ones: the rule
     parses; a production config with the gate passed carries `OAUTH_PUBLIC`; a release setting it
     while the serving viz-control is unstamped is refused; a rollback to an unstamped viz-control
     after a version with the var is refused.
   - The alternative: a rule option that treats a secret's presence as the switch being on
     (`"on": "present"`), so `OAUTH_CLIENT_KEY` itself is the switch. It needs `deployFloorProblems`
     to skip its secret refusal for that rule only; the var is simpler and keeps one meaning of a
     switch.
   - Until then, any rollback of viz-control in a deployment that has issued credentials should be
     to this release or later, by hand.
7. **Nothing for the list of dead credentials**: it uses `CONFIG`, which every generated viz-control
   config already binds to `viz-config` (`deploy/workers.json` `resources.kv`). Its KV writes are
   modelled in D70 ("What the list costs"); state the worst case with the release that turns OAuth
   on: $4.32 a day per tenant at the ceiling, cents per attack.

Then, in `control/wrangler.jsonc`. It is not added now: today `configure.mjs` refuses an unknown
key, which would fail deploy's configure tests and any release.

```jsonc
  // Rate limits in front of OAuth (D70, src/ratelimit.ts). namespace_id: placeholders, replaced by
  // deploy/configure.mjs with ids it allocated for this deployment; never deploy with them.
  "ratelimits": [
    { "name": "OAUTH_RL_SOURCE", "namespace_id": "0", "simple": { "limit": 120, "period": 60 } },
    { "name": "OAUTH_RL_SOURCE_48", "namespace_id": "0", "simple": { "limit": 1200, "period": 60 } },
    { "name": "OAUTH_RL_CREDENTIAL", "namespace_id": "0", "simple": { "limit": 5, "period": 60 } },
    { "name": "OAUTH_RL_TENANT", "namespace_id": "0", "simple": { "limit": 6000, "period": 60 } },
    { "name": "OAUTH_RL_BEARER", "namespace_id": "0", "simple": { "limit": 1200, "period": 60 } },
    { "name": "OAUTH_RL_BEARER_TENANT", "namespace_id": "0", "simple": { "limit": 30000, "period": 60 } }
  ],
```

The binding names changed with the review of D70. The first version proposed `OAUTH_RL_CLIENT` and
no `OAUTH_RL_SOURCE_48` or `OAUTH_RL_CREDENTIAL`. Nothing was deployed with either set.

Worst-case cost of the deploy change: none on Cloudflare's side that the page names. It gives no
price for the binding (read 2026-11-19), and no resource is created, only bindings.

Optional, by hand, outside the deploy: a WAF rate-limiting rule on `vis.bitcru.sh` only, for
`/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, counted by IP, above the
Worker's source limit (for example 300 a minute), so that a flood is refused before any Worker runs.
Such a rule should leave Cloudflare's Workers address alone, or count it by the field
`cf.worker.upstream_zone`, which the headers page recommends instead of the `CF-Worker` header;
otherwise it refuses every Worker-hosted client together (M-1).

**`mcp/`**: done there. `identifyOAuth` maps `rate_limited` to a 429 with `Retry-After`, tested
(mcp/README.md). The review's fixes change no status: an expired access token is now answered
`inactive` `expired` by control's entrypoint without asking the object, which `mcp/` already maps to
401 `invalid-token`. The agent surface's `parseCredential` accepts layout 2 (the shape is
unchanged). mcp's tests bind `OAUTH_RL_BEARER`, which keeps its name. Round 2 changes nothing
there: a listed access token is answered `inactive` with the reason its object gave (`unknown`,
`expired` or `revoked`), which mcp already maps to 401 (`npx tsc --noEmit` clean and
`test/oauth.test.ts` 15 of 15 after the contract change, 2026-11-19).

**`design/`** (the lead's): the `reviews/d70-rate-limits-r2.md` row of `design/REVIEW.md` ("Being
fixed") and the OAuth row of `design/artifact/viz-design.html` ("a re-review is pending") are out of
date once this change lands; dispositions are in "Round 2" under "How it was verified" here.

## Contract issues

1. **Who owns the pool-map epoch.** DESIGN §4.1 says "The shard map has an epoch, owned by
   the ledger" and `shard/src/pool.ts` says "Bumped by the ledger on every change". This
   component was asked to bump it in `pool:<tenant>`. Two writers of one epoch is a bug
   waiting; it needs an entry in `design/DECISIONS.md`. Until then the control plane only
   makes the two changes that need no handover.
2. **The KV records are not in `contracts/`.** `key:`, `pool:`, `limits:` and `retention:`
   are defined by their readers' source (`edge/src/auth.ts`, `shard/src/pool.ts`,
   `edge/src/route.ts`, `janitor/src/janitor.ts`); `revocation:` is defined here. A
   `contracts/config.ts` with the five shapes would let writer and readers share one type, and,
   for `retention:`, the defaults of absent fields, which control now copies from the janitor
   (`KEPT_WHEN_ABSENT`, tied by a test; D63). The pool map's validity rule is shared code since
   review M-5 (`validBasePool` in `shard/src/pool.ts`), not a contract text.
3. **`limits:<tenant>` has one reader field, `retention:<tenant>` three** (`active_series`;
   `metric_samples_days`, `trace_days`, `log_days`, the last two read by the janitor since D63).
   The other field names published here (`samples_per_second`, `query_*`, `metric_5m_days`,
   `metric_1h_days`) are this component's proposal, not an agreed contract.
4. **Key expiry is not in edge's record.** It is carried as a KV expiration, which cannot
   be less than 60 s away; a key within 61 s of its end is removed from KV instead.
