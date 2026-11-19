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
| `src/oauth.ts` | OAuth building blocks: issuer and resource, credentials and their hashes, sealing, signed registrations, PKCE, scopes, redirect URIs, the authorization request handle |
| `src/ops-oauth.ts` | OAuth grants in the Tenant object: approve (the consent step), list, get, revoke; the token endpoint's code exchange and refresh; RFC 7009 revocation; introspection for the agent surface; the alarm's sweep |
| `src/oauth-http.ts` | The authorization server's public endpoints: RFC 8414 metadata, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` |

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
| `retention` | `{ metric_samples_days, metric_5m_days?, metric_1h_days?, log_days?, trace_days? }`, 1 to 3650 days, coarser tiers not shorter than finer ones. Shortening needs `confirmShorter: true` | `retention:<tenant>`, the value as is |
| `limits` | `{ active_series, samples_per_second, query_max_series, query_max_samples, query_timeout_seconds, query_max_range_days, query_concurrency }`, any subset. `LIMIT_CEILINGS` (JSON, operator) caps them | `limits:<tenant>`, the value as is |
| `pool` | `{ pool, slots, spread }`. The pool must be `tenant/<this tenant>` or the shared pool of `DEFAULT_POOL` | `pool:<tenant>` → `{ pool, slots, spread, epoch }` |
| `notifications` | `{ email[], webhookUrl, webhookFormat, sendResolved, webhookSecret }`. `webhookFormat` is `alertmanager` (default) or `json` (`viz.notification/v1`); `webhookSecret` (16–512 characters) is **write-only**: kept in `tenant_meta`, never in the value, so no read, list or audit entry holds it; the value shows `webhookSecretSetAt` instead. Left out, the secret is kept while `webhookUrl` is unchanged and dropped when it changes; `null` removes it. The ruler's notifier sends to this webhook as its receiver `viz:default` (below). `email` is stored, not acted on | no: read over the binding (`notificationTarget`), so the secret is not in KV |

**Pool map.** The first map gets the shared map's epoch plus one; raising `spread` bumps
the epoch. Everything else (another pool, another slot count, a smaller spread) is refused
with 409 `pool-change-unsupported`, because it needs the drain-and-handover protocol of
DESIGN §4.1, which is out of scope here.

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
| `POST /oauth/register` | RFC 7591, public clients only. **Stores nothing**: the client id is the registration (name, redirect URIs, issue time), signed with HMAC-SHA-256 under the Worker secret `OAUTH_CLIENT_KEY` (format `id.oauth-client`). Redirect URIs: 1 to 5, https or http on `localhost`/`127.0.0.1`/`[::1]`, no fragment, no user info, no spaces or backslashes, at most 512 characters. Confidential auth methods, other grant or response types and unknown scopes are refused. 503 without the key |
| `GET /oauth/authorize` | Validates the request: the client id's signature, the redirect URI **exactly** equal to a registered one (else 400 and nothing is sent anywhere), `response_type=code`, a 43-character `code_challenge` with method `S256` (plain and none refused), known scopes (default `read dashboards:read monitors:read`), one `resource` equal to `<PUBLIC_URL>/mcp` (scheme and host compared without case). It answers a **plain-text page** (no markup, `no-store`, CSP `default-src 'none'; frame-ancestors 'none'`): what is asked and how a person approves it, with a request handle (format `oauth.request`). Errors the client should hear about are shown with the callback link that would deliver them; **this server never redirects by itself** (every redirect URI is the client's own claim, so an automatic redirect would make it an open redirector) |
| `POST /oauth/token` | `authorization_code` (with `code_verifier`, `redirect_uri`, `client_id`, `resource`) and `refresh_token`. Form encoding only; a parameter sent twice, an `Authorization` header or a `client_secret` is refused. Answers `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope }`, `Cache-Control: no-store` |
| `POST /oauth/revoke` | RFC 7009 with `token` and `client_id`. An access token ends alone; a refresh token ends its grant. Unknown tokens and tokens of another client: 200, nothing changes |

**The consent step: `POST /api/v1/control/oauth/approve`** (route table, scope `admin`, audited,
`dryRun`). There is no sign-in and no web UI yet, so the person approves through the API with
their own key: `{ "request": "<handle from the page>", "scopes"?: [...] }`.
- Only a **person**: kind `key` (later `user`) with `admin`. An agent key is refused with 403
  `approver-not-a-person`, whatever its scopes.
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
  and `warnings` (the client's name is unverified; a loopback callback can be received by any
  program on that computer; what was withheld).
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
  refresh token went unused 30 days (`idle`), on reuse (`code-reuse`, `refresh-reuse`,
  `wrong-client`), by the client (RFC 7009, `client`) or by a person
  (`POST /oauth/grants/{id}/revoke`, `person`). Ending a grant deletes its tokens and code and
  its key (from KV too, revocation generation bumped), in one transaction, one audit entry. Ended
  grants stay listed 90 days (`GET /oauth/grants?status=all`); a client with no live grant is
  deleted after 30 days (`oauth.client.expire`).
- The grant's key may be **disabled** like any key (the grant is `suspended`: the resource refuses
  its tokens; refresh still rotates) and enabled again; it cannot be rotated or deleted on its
  own (409 `grant-key`: revoke the grant), and persons cannot create keys named `oauth:…`.
- **A grant follows its approver's key**, so it is never broader than that key later either:
  while the approver's key is disabled the grant is `suspended`; once it is deleted or expired
  the resource and the token endpoint refuse the grant at once, and the alarm, due immediately,
  ends it (`approver-gone`) with its key.

**What is stored, and the service surface.**
- Codes and tokens are stored as the SHA-256 of the whole string (format `credential.oauth`:
  `<vzc1|vza1|vzr1>.<tenant>.<43 base62>`; the tenant is in clear so the server can find the
  tenant's object, which then holds only the hash, so a credential edited to name another tenant
  matches nothing there).
- **The grant key's secret is never stored in clear.** It is sealed (AES-256-GCM, key derived by
  HKDF-SHA-256 from the credential, tenant and grant authenticated; format `oauth.sealed`) under
  each live code, access token and refresh token. Only a request presenting one of them can
  recover it, so neither a dump of the object nor a stolen database yields a working credential.
- `Tenant.oauthToken`, `oauthRevoke` and `introspectAccessToken` (`contracts/oauth.ts`
  `TenantOAuthRpc`, results `v: 1`, format `rpc.oauth`) are reachable only through the Durable
  Object binding: the first two by this Worker's `/oauth/*` handlers, the third by the agent
  surface (viz-mcp binds `Tenant` by `script_name`, as the ruler does). Introspection checks the
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
  client to forget, and an ended grant to delete. Expired and rotated tokens are deleted on the
  next refresh of their grant and by any alarm.

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
  table, and no alarm).
- **Every statement names the tenant** (a test reads the source and checks; the one
  exception reads which tenant the object is bound to).
- **Mutation, audit row and outbox rows commit in one transaction.** KV is written only
  afterwards, from the outbox, in order, by one drain at a time.
- **One alarm**, at the earliest of: an open proposal's expiry, a deleted dashboard's purge
  time, and, as a third deadline the task did not list, 30 s after a KV publication failed.
  It is deleted when none applies. The handler is idempotent.
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
  `active_series` and `metric_samples_days`.
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
- Rate limiting, metrics about this API, pruning of the audit log.
- **Production deployment.** viz-control ran on Cloudflare only in two staged trials, both
  destroyed (`deploy/README.md`, "Trial on Cloudflare (2026-11-18)" and "Trial 2", 2026-11-19);
  it is mounted behind the gateway (`deploy/`), not in `app/`. The OAuth endpoints have not run on
  Cloudflare.
- **OAuth: Client ID Metadata Documents** (the 2026-07-28 revision's preferred registration;
  dynamic registration is deprecated there): not built, `client_id_metadata_document_supported:
  false`. Also not built: a consent page and grants screen (above), OpenID Connect discovery, RFC
  7662 introspection over HTTP (introspection is an RPC only), the RFC 8252 any-port rule for
  loopback redirect URIs (redirect URIs match exactly; a client on a new port registers again), a
  grace period for a refresh retried after a lost response (it counts as reuse), DPoP, and rate
  limits on `/oauth/register`, `/oauth/authorize` and `/oauth/token` other than what stored state
  bounds (registration stores nothing; approvals are bounded per tenant).

## Verification

```
npm install
npm test             # 131 tests in 16 files, in workerd (at most 2 workers)
npx tsc --noEmit     # clean
npm run mutants      # 91 mutants, in a copy outside git only (it refuses a work tree: AGENTS.md)
npm run gen:openapi  # rewrite openapi.json from src/openapi.ts
```

Measured here: vitest 5.1 in workerd, TypeScript 5.9, Node 22.23. The suite takes 11 to 75 s
on a shared machine (75 s on a cold cache with the load average above 6). Last run
2026-11-19: 131 of 131 pass, `tsc` clean.

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
  are bound to client, redirect URI and resource; an expired code is refused.
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
- **Settings and audit** (`settings.test.ts`, 8 tests). KV shapes for retention, limits and
  pool; the published pool map is accepted by `shard/src/pool`'s routing; the refused pool
  changes. Audit completeness: each of the 17 mutating routes is called once (the test
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

### Mutation checks

`scripts/mutants.mjs` applies each change on its own, runs the suite and restores the
files; the last column names the test files that failed and, in brackets, how many tests.
It runs vitest with at most 2 workers, counts a mutant as killed only when a test ran and
failed (a suite that crashed or hung is reported as `NO RESULT` and counts as not killed),
and refuses to run inside a git work tree: run it from `control/` in a copy of the
repository (its header lists what the copy needs).

**59–65** (the service surface, this change) were run on 2026-11-19 in a copy in a scratch
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
| 2 | The same, and the Tenant object trusting the tenant it is told | isolation, rules (3) |
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

Mutants 36–40 break `contracts/schema.ts`, the runner every component shares; they are run
here because this suite tests it most fully.

Mutant 6 survived the functional tests on the first run and was caught only by the
OpenAPI scope comparison: the one test that applied without the scope used an agent, which
is refused for another reason. A test with a write-only person's key was added.

Mutant 9 is the closest faithful form of "audit entry skipped on failure then retry" this
design allows: the audit row cannot be skipped separately, because it is in the same
transaction as the change. The test that pins it: a create that is refused after its first
insert, then retried, yields one dashboard and one entry.

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
- **OAuth: a forged, well-formed credential costs one Durable Object request** (at `/mcp`,
  `/oauth/token`, `/oauth/revoke`): the object of the tenant it names is asked, and refuses. It
  writes nothing (above), but there is no rate limit in front of these paths yet.
- **OAuth: registration is open and stateless.** Anyone can register any https or loopback
  callback; the person's consent (with the host shown and the name marked unverified) is the
  gate, as with any dynamic registration. Rotating `OAUTH_CLIENT_KEY` invalidates every client
  id: clients register again (grants and tokens are unaffected; the token endpoint compares the
  stored client id, not the signature).

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
9. **OAuth (D44)**: `deploy/` must generate the Worker secret `OAUTH_CLIENT_KEY` for viz-control
   once (32 or more random characters, `wrangler secret put` from stdin, kept across deploys;
   without it registration answers 503 and is not advertised) and keep `PUBLIC_URL` equal for
   viz-control and viz-mcp (the issuer and the resource are built from it); `deploy/README.md`'s
   route table needs the OAuth paths (the gateway routes them, `deploy/gateway`, done; that README
   is another engineer's). `app/`: the consent page and the grants screen ("What the UI must
   later show"), through design review.

## Contract issues

1. **Who owns the pool-map epoch.** DESIGN §4.1 says "The shard map has an epoch, owned by
   the ledger" and `shard/src/pool.ts` says "Bumped by the ledger on every change". This
   component was asked to bump it in `pool:<tenant>`. Two writers of one epoch is a bug
   waiting; it needs an entry in `design/DECISIONS.md`. Until then the control plane only
   makes the two changes that need no handover.
2. **The KV records are not in `contracts/`.** `key:`, `pool:`, `limits:` and `retention:`
   are defined by their readers' source (`edge/src/auth.ts`, `shard/src/pool.ts`,
   `edge/src/route.ts`, `janitor/src/janitor.ts`); `revocation:` is defined here. A
   `contracts/config.ts` with the five shapes would let writer and readers share one type.
3. **`limits:<tenant>` and `retention:<tenant>` have one reader field each**
   (`active_series`, `metric_samples_days`). The other field names published here
   (`samples_per_second`, `query_*`, `metric_5m_days`, `metric_1h_days`, `log_days`,
   `trace_days`) are this component's proposal, not an agreed contract.
4. **Key expiry is not in edge's record.** It is carried as a KV expiration, which cannot
   be less than 60 s away; a key within 61 s of its end is removed from KV instead.
