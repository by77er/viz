# Accounts and teams for people (proposal)


> **Deferred (2026-11-28, the owner):** "Let's get the core system working first, then worry about
> tenantship." Nothing here is to be built until the owner picks it up again; API keys stay the only
> identity.

> **Note (2026-11-28, after this was written):** the owner moved the product to `viz.bitcru.sh` (D75), so every
> host in this proposal now reads `viz.bitcru.sh`, and decision 2 (the passkey RP ID) is settled by that choice
> unless the owner wants a different one.
Status: **proposal, 2026-11-28. Nothing is built.** This is written for the owner to decide from.
Once an option is chosen, §8 is drafted to become a `design/DECISIONS.md` entry (its number taken when it is chosen; D75 and D76 are already in use). Background,
with each outside claim tagged verified / secondary / training: `research/14-identity-and-invites.md`
(cited as "R14 §n"). Every cost and latency here is **modelled** unless it says otherwise. Each
modelled figure names the experiment that would measure it (§9).

The question: *explore individual and team setups for people, possibly with invite codes at
first.* Today viz has no people. Every identity is an API key.

---

## 1. How it works now

**Tenants.** A tenant is a string matching `TENANT_ID` (`[A-Za-z0-9_-]{1,64}`, `contracts/ledger.ts`).
Everything is per tenant:
- one `Tenant` Durable Object in viz-control: keys, dashboards, proposals, settings, the audit log,
  OAuth grants;
- one ledger, and streams in pooled shards;
- rulers and a notifier.

Nothing outside the tenant knows a list of tenants. There is no tenant record anywhere except the
objects themselves and the KV records control publishes (`key:`, `limits:`, `retention:`, `pool:`).

**How a tenant is created.** Only the operator can create one, with `deploy/bootstrap.mjs`:
1. It generates a one-time token locally.
2. It puts `{tenant, tokenSha256, expiresAt: +10 min}` on viz-gateway as the Worker secret
   `VIZ_BOOTSTRAP`.
3. It calls `POST /api/v1/bootstrap` with the token. The gateway calls `Tenant.provision(tenant)`
   over control's Durable Object binding, which refuses a tenant that already has keys.
4. It deletes the secret and prints the first admin key once.

There is deliberately no HTTP route that provisions: it would have to take the tenant from the
request (`control/README.md`, "Who is calling"). Creating a tenant needs the Cloudflare token.

**Keys.**
- Shape: `viz_<keyId>_<secret>`, a 16-character key id and 40 random base62 characters. Only the
  SHA-256 is stored, in the tenant's SQLite and in KV as `key:<keyId>` → `{tenant, secretSha256,
  scopes, disabled}`.
- Expiry and rotation overlap are KV expirations.
- Every data-path Worker verifies keys the same way, with edge's `authenticate`
  (`edge/src/auth.ts`): a KV lookup cached 60 s per isolate (10 s for misses), a constant-time
  compare, and a literal scope check. The tenant is whatever the record says. No header, path or
  body is consulted.
- Control's `identify()` (`control/src/identity.ts`) does the same, then asks the tenant's object
  (`resolveKey`), so a revoked key stops at control immediately.
- On the data path a revoked key stops after up to 60 s of cache plus KV propagation: 0–120 s,
  modelled, not measured (`control/README.md`, "How long a revoked key keeps working").

**Scopes.** `admin`, `dashboards:read|write|apply` (control); `read`, `write` (query, ingest);
`monitors:read|write|ack` (ruler). Each service checks its own scopes literally, so `admin` is
honoured only by control.

**Kinds.** A key is created as `key` or `agent`. Every mutation records `{subject, kind, name}`.
`Identity.kind` already has `'user'`, and `identify` is documented to gain a second branch for it
"without handler changes". Nothing produces it today; in the tests "Dana" is a key named Dana.

**The web app** (`app/`, development branch, not deployed).
- A person pastes an API key into a form. The app checks it with `GET /api/v1/control/whoami`.
- The key is kept in page memory and `sessionStorage` (`viz.key`) and sent as `Authorization:
  Bearer` to the same origin.
- The document's CSP is strict (`app/serve.json`: `script-src 'self'`, `connect-src 'self'`,
  `form-action 'none'`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`).
- The gateway serves the document from a variable and passes every API request through unchanged,
  `Set-Cookie` included (D74). No cookie is set or read anywhere today.

**MCP clients.** OAuth 2.1, with control as the authorization server (D44, D70):
- Registration is signed and stateless. Credentials name their tenant in clear (`vza1.<tenant>.…`)
  and carry an HMAC tag and an expiry, so a forged one reaches no object.
- Consent is a plain-text page saying "approve with `POST /api/v1/control/oauth/approve`", made by
  someone holding an `admin` **key**. The grant is backed by an agent key that follows the
  approver's key.
- `Tenant.invoke` accepts only API-key identities, and a grant whose approver is not a key counts
  as ended. D44's "would change if" names sign-in as what turns this into a real consent page.

**What a "person" is today.** A key with a human name, kind `key`. Who holds it is unknown. Several
people sharing an admin key are one subject. Leaving a team means rotating every key that person
saw.

**Gaps** (`control/README.md`, "Not implemented", and the code):
1. No people, sessions, roles or memberships; `kind: 'user'` is never produced.
2. No self-service tenant creation: only the operator, with Cloudflare credentials.
3. No tenant deletion or off-boarding. The janitor removes files by retention, by whole UTC days,
   with a 1-day minimum. It does not delete ledger log objects or shard streams, and no job
   deletes a tenant (`janitor/README.md`, "Not implemented").
4. No rate limits on the control API itself (OAuth's are D70).
5. Most per-tenant limits are stored but not enforced:
   - Only `active_series` (default **1,000,000**, `edge/src/route.ts`) and retention are read.
   - `samples_per_second` and control's `query_*` fields have no reader. Query reads its own field
     names (`maxSeries`, …) from the same KV record and ignores control's (`query/src/config.ts`).
   - Rules are bounded only by placement (64 shards × 1,000 rules, `ruler/src/placement.ts`).
   - There is no cap on ingest bytes a day, stored bytes, or query rate.
6. The app keeps a full-power credential in `sessionStorage`, which OWASP advises against (R14 §7).
   The app's README records it as temporary until a session cookie exists.

(Note: `control/README.md`'s "Production deployment" line says control has not run in production.
`design/DESIGN.md`'s status says production has served it since 2026-11-19, OAuth included. The
README line predates that.)

---

## 2. The model (common to all options)

### 2.1 Entities

- **Account**: a person. A random id `a` + 21 base62 characters (about 125 bits), a display name,
  and sign-in credentials (passkeys, or a provider subject). An account belongs to no tenant.
- **Workspace**: today's tenant, unchanged: same id, same objects, same keys. A workspace gains a
  display name, a status (`active`, `closing`, `closed`) and a plan (its quota template, §6).
  Self-service workspaces get a server-generated id, `w` + 20 lowercase base62 characters: no `_`
  (D38, D66), never `traces` or `logs`, unguessable but not secret.
- **Membership**: (workspace, account, role). **The workspace's `Tenant` object is authoritative.**
  The account keeps a copy for the workspace switcher, updated from the Tenant's outbox (§2.4).
- **Individual use is a workspace of one.** There is no separate "personal" type. A person signs up
  and gets a workspace whose only member is its owner. Inviting a second person makes it a team.
  This is the same rule as every product in R14 §6, and it means one code path.
- **Several workspaces per account, with switching.** Yes. A person is invited to many and can
  create as many as their sign-up allowance permits (§4.1). The app shows the current workspace and
  a switcher. One browser tab acts in one workspace at a time.

### 2.2 Roles and scopes

Roles are named sets of the existing scopes. No new scope is needed, and no service other than
control changes how it authorises.

| Role | Scopes (what the session key holds) | What it adds | Why |
|---|---|---|---|
| viewer | `read`, `dashboards:read`, `monitors:read` | Read telemetry, dashboards, monitors | Grafana's Viewer, Honeycomb's Read-Only (R14 §6) |
| editor | viewer + `dashboards:write`, `dashboards:apply`, `monitors:write`, `monitors:ack` | Change dashboards and monitors, apply agents' proposals (D29), acknowledge alerts | Grafana's Editor |
| admin | editor + `admin` | Keys, settings, the audit log, members, invites, OAuth approvals | Grafana's Admin. `admin` already gates keys, settings and audit in control |
| owner | the same scopes as admin | Owner-only operations, checked by **role** in the Tenant, not by scope: transfer ownership, delete or restore the workspace, change plan, remove or demote admins | Vercel and Honeycomb have an owner above admin; a workspace always has at least one |

- **`write` (ingest) is never in a person's session.** Senders use keys, which an admin creates as
  today. A session that could ingest would turn a browser compromise into a write path.
- **Why not finer roles.**
  - The scopes already split along these lines.
  - D29's `write` versus `apply` could make a "contributor" (propose, not apply). That role can be
    added later as one more row.
  - Label-matcher policies (DESIGN §9) are an orthogonal, later layer.
- **Open for the owner:** whether a viewer may acknowledge alerts (`monitors:ack`), for on-call
  people who otherwise only read. It is left with the editor here.

### 2.3 Where accounts live, and what that does to "tenant from the credential"

Accounts need storage outside every tenant. Two new Durable Object classes in viz-control (one
Worker, one migration):

- **`Account`**, one per account, `idFromName(accountId)`.
  - Tables: profile; credentials (passkeys: credential id, COSE public key, algorithm, sign count,
    transports, backup flags, name, created and last used); recovery codes (SHA-256 only);
    sessions (token SHA-256, created, idle and absolute expiry, last user verification, current
    workspace, a coarse `last_seen` written at most hourly); the membership copy; a security log
    (append-only, like the audit log); an outbox.
  - **Every statement names the account in its `WHERE`**, the same rule and the same source test as
    for tenants.
  - Like `Tenant`, an `Account` nobody created writes nothing, and every credential that names it is
    tag-checked in the Worker first.
- **`Directory`**, a singleton (`idFromName('directory')`): what must be unique or listed across
  accounts.
  - Slice 1: sign-up codes and their redemptions, and the list of workspaces created by sign-up
    (id, owner, plan, status), which the operator needs and which the per-cell tenant budget
    (DESIGN §3.3) needs.
  - Later: an index from provider subject to account (option B) and from email hash to account.
  - One object serves about 1,000 requests a second (soft limit, research/02 [V]). Sign-ups are far
    below that, and the Directory is never on the path of a request that is already signed in. If
    it ever has to grow, it is sharded by hash of the key.

**The rule "tenant identity comes from the credential" holds as follows.**
1. **Requests to a workspace** (data, control, ruler) carry a *workspace session key*: an ordinary
   API key in that workspace (§5). The tenant comes from its KV record, exactly as now, and nothing
   on the data path changes.
2. **Requests about the account** (`/api/v1/account/…`, `/api/v1/auth/…`) carry the account session
   and name no tenant. Their handlers touch only the `Account` and `Directory` objects.
3. **The two crossings** are *choosing a workspace* (switch, accept an invite) and *creating one*.
   - A switch names a workspace in its body. That name is a **selector, not an authority**: the
     request goes to that workspace's `Tenant`, which checks its own membership row for the account
     id taken from the account session. A forged name finds no row and gets the answer an unknown
     workspace gets.
   - An invite names its workspace inside the code (`vzi1.<tenant>.…`, the same scheme as OAuth
     credentials), tagged so it cannot be edited.
   - Creating a workspace takes the id from the server, never the request.

   This is a change to the wording of `AGENTS.md`'s rule. It should read: "the tenant comes from the
   credential, or is chosen among the credential's memberships and confirmed by that tenant's own
   object". That needs the owner's agreement and an adversarial review (§10).

### 2.4 Keeping the two copies of a membership consistent

There are no transactions across Durable Objects.
- The `Tenant` changes the membership, its audit row and an **outbox row addressed to the
  `Account`** in one transaction. That is the existing rule ("a mutation and its outbox row go in
  the same transaction"), with a new outbox target.
- The drain calls `Account.applyMembership(tenant, account, role|null, version)`, which is
  idempotent: it applies only a newer version.
- The account's copy can therefore lag by the drain's retry interval (30 s after a failure, as for
  KV). It is used only to list workspaces. Every decision is taken again in the `Tenant`.
- A workspace that was removed from someone but still shows in their switcher answers "not a
  member" when it is chosen, and the copy is then corrected.

---

## 3. Sign-in options compared

Every option shares §2, §4's invite codes and §5's sessions. They differ in how a person proves
who they are, and how they recover when they cannot.

| | Passkeys only | Email magic link | GitHub / Google (OIDC) | Cloudflare Access in front | Invite code + passkey (first stage) |
|---|---|---|---|---|---|
| Phishing resistance | Strong: origin-bound (R14 §1) | Weak: whoever reads the mailbox signs in; NIST says email SHALL NOT be an out-of-band authenticator (R14 §1, §3) | As strong as the person's provider account | As strong as the organisation's identity provider | Strong, as passkeys |
| What viz must build | WebAuthn verification, sessions, recovery codes | Email sending, token handling, scanner-safe landing page | OAuth client per provider, state and PKCE, ID token or API checks, account linking | Verify Access's JWT on one path; map its subject to an account | Passkeys + codes |
| Cloudflare pieces | Workers, Durable Objects, KV (as today) | Email Sending (**beta**, Workers Paid, sending domain onboarded = DNS records in the zone, reputation-ramped daily quota; R14 §3 [V]) | Outbound fetch to the provider; client secrets as Worker secrets | Zero Trust organisation, an Access application on `viz.bitcru.sh` paths (free to 50 users, then $7 per user per month; R14 §5 [V]) | As passkeys |
| Running cost (modelled) | Workers and Durable Object usage only: about $0 below ~10,000 sign-ins a day (§7) | + $0.35 per 1,000 emails past 3,000 a month [V price] | $0 to the provider | $0 to 50 users; 100 users ≈ $350–700 a month depending on how many need a seat [V price, modelled seats] | As passkeys |
| Operational burden | Low; the support case is the lost passkey | Deliverability, bounces, spam placement, quota ramps; Microsoft Safe Links and similar spend one-time links (R14 §3) | Register apps with each provider, rotate secrets, Google brand verification [T]; an outage at the provider stops new sign-ins | Zero Trust configuration is account-wide, beside unrelated resources (AGENTS.md: only `viz-` resources) | Low |
| Friction | One touch, on devices from 2022 on (R14 §1); Linux desktops need a phone for hybrid or a password manager | Leave the app, find the email, wait | One click for people with that provider | One click inside an organisation; strangers cannot get in without being added to Access | One touch, plus pasting the link once |
| Recovery for a lost passkey | Another passkey (synced passkeys make loss rarer); recovery codes; re-invite by an admin; operator-assisted for a sole owner | The mailbox *is* the recovery, and the weak point | The provider's recovery | The identity provider's | As passkeys |
| Fits | A hosted service for strangers and for teams | Low-value accounts | Developers (GitHub), Google Workspace teams | **One organisation deploying viz for itself**, DESIGN §1's primary target | The first, gated stage of a hosted service |

**Reading the table.**
- Email magic links lose on security (NIST), on operations (a beta sender with a reputation ramp,
  and a DNS change in a zone the owner shares) and on friction. Email is useful later for invite
  delivery and security notices ("a passkey was added"), not as a way in.
- Passkeys and federated sign-in can coexist: a provider becomes a second credential on an account.
- Cloudflare Access is a different product shape: one organisation, no strangers.
- That leaves three coherent options.

---

## 4. Invite codes (common to all options)

### 4.1 Two kinds

| | Sign-up code | Team invite |
|---|---|---|
| Lets the holder | Create an account and **one new workspace** (or N, per the code), of the code's plan | Create an account if they have none, and join one workspace with a role |
| Format | `vzs1.op.<43>` | `vzi1.<tenant>.<43>` |
| Held by | `Directory` (SHA-256 only) | The workspace's `Tenant` (SHA-256 only) |
| Who creates | Operator only in slice 1 (§4.4) | Admins and owners of the workspace (sessions); an admin *key* too, so automation and the migration (§7) work |
| Default uses | 1 | 1 |
| Multi-use | Up to 50, for a cohort or a workshop | Up to 25, role at most `viewer` unless the owner allows more; optionally "needs approval" (Honeycomb's model) |
| Expiry | Default 14 days, at most 90 | Default 7 days (Vercel's figure, R14 §6), at most 30 |
| Bound to an email | No in slice 1 (no verified email channel); optional later with Email Sending | Same |
| Revocation | Operator, immediately (`Directory` is authoritative) | Any admin; also automatic when its creator is removed or demoted below admin, and when the workspace closes |
| Audit | Directory log: created, each redemption (account, workspace), revoked | Tenant audit log: `invite.create`, `invite.accept` (account, role), `invite.revoke` |

**Format.** The 43 characters use the same layout as OAuth credentials (layout 2 in
`contracts/oauth.ts`): the marker `e`, an expiry in minutes, 22 CSPRNG characters (about 131 bits),
and a 16-character HMAC-SHA-256 tag. The tag is keyed by HKDF from a new Worker secret, `AUTH_KEY`,
which the deploy generates as D53 does for `OAUTH_CLIENT_KEY`. It covers the prefix, the issuer or
tenant, and the body.
- A guessed or edited code fails the tag in the Worker and reaches no object.
- An expired code is refused in the Worker before any limit is counted.
- Prefixes not used by OAuth (`vzc1`, `vza1`, `vzr1`, `vzk1`): `vzs1` sign-up, `vzi1` invite,
  `vzu1` account session, `vzq1` recovery code.

**What the link looks like.** `https://viz.bitcru.sh/join#vzi1.w3k…<43>`. The code is in the
**fragment**:
- the browser never sends it to the server, so it is not in any log;
- `Referrer-Policy: no-referrer` is already set;
- a mail or chat scanner that fetches the link gets only the static document.

`/join` is a new document. It reads the fragment, removes it from the address bar
(`history.replaceState`), shows what the code offers, and redeems it only when the person creates
or uses a passkey. A scanner cannot spend it, which answers the main practical failure of one-time
links (R14 §3).

What the page shows before redeeming: "Join *Acme production* as an editor. Invited by Dana. Expires
in 6 days." A preview names the workspace and the inviter's display name, which an attacker holding
the code learns anyway. A preview of an invalid code says only "This invite cannot be used", whether
it was forged, expired, revoked or used.

### 4.2 Flows

**Sign up with a code** (option A; B differs only in step 3):
1. `/join#vzs1…` → `POST /api/v1/auth/signup/options {code}`. The Worker checks the tag and the
   expiry, applies the rate limits (§4.3), and asks the `Directory` whether the code has uses left
   (a read, no write). It answers WebAuthn creation options:
   - `rp.id = viz.bitcru.sh`;
   - a fresh account id as `user.id`;
   - `residentKey: required`, `userVerification: required`, `attestation: none`;
   - ES256, EdDSA and RS256;
   - a **stateless challenge**: an HMAC over (purpose, code hash, account id, expiry 5 min,
     nonce).

   Nothing is stored until the passkey exists, so unauthenticated requests write nothing (the D44
   pattern).
2. The browser runs `navigator.credentials.create`.
3. `POST /api/v1/auth/signup/verify {code, response, displayName, workspaceName}`. The Worker checks
   the challenge's HMAC and expiry, the origin (`https://viz.bitcru.sh`, from configuration, never
   from a header), the RP ID hash, and the UP and UV flags. Then a **saga, keyed by a redemption
   id** so that a retry finishes the same work:
   - `Directory.redeem(codeHash, accountId)` atomically takes one use and records the redemption
     with a generated workspace id;
   - `Account.create(accountId, credential, displayName)`;
   - `Tenant(w…).provisionWorkspace(owner = accountId, plan, name)`: like `provision`, but it
     creates an owner membership and no key;
   - `Account.createSession`, then `Tenant.mintSessionKey` (§5);
   - both cookies are set.
4. The app shows ten recovery codes once ("Recover access" below) and suggests adding a second
   passkey on another device.

**Create a team.** No step: invite someone to the workspace. A second, empty workspace is a
sign-up allowance on the account (the code's `workspaces: N`), or a new code.

**Invite.** An admin opens Members → Invite, picks a role, uses, expiry, and "needs approval" or
not. `POST /api/v1/control/invites` returns the link **once**. The admin sends it by any channel. The
pending list shows uses left, expiry and creator, and an invite can be revoked from it.

**Accept.**
1. `/join#vzi1.<tenant>…`. A person signed in elsewhere presses Join:
   `POST /api/v1/auth/invite/accept {code}` with the account session. The tenant comes from the
   tagged code. `Tenant.acceptInvite(codeHash, accountId, displayName)`, in one transaction:
   - takes a use;
   - adds the member (or a pending member, if approval is needed);
   - writes the audit row and the outbox row to the `Account`.
2. The session switches to the workspace.
3. A person with no account goes through step 1–3 of sign-up with the invite in place of a sign-up
   code. The result is an account with **no workspace of its own**: an invite never grants
   creation.

**Switch workspace.** The switcher lists the account's membership copy.
1. `POST /api/v1/auth/session/workspace {workspace}` goes to that workspace's `Tenant`.
2. `mintSessionKey(accountId, sessionId)` checks the membership row, then creates a key with the
   role's scopes.
3. The workspace cookie is replaced, and the previous workspace's session key is deleted through the
   `Account`'s outbox.

**Remove a member** (admin; owners can remove admins; nobody can remove the last owner). One
`Tenant` transaction:
- deletes the membership;
- deletes every session key of that account in the workspace (KV deletes through the outbox);
- revokes the invites that person created;
- ends the OAuth grants that person approved (or moves them to the remover, if the owner prefers:
  an owner decision);
- writes the audit row and an outbox row to the `Account`.

API keys the person created stay by default, because they are often production senders. The removal
dialog lists them ("Dana created 3 keys: ingest-prod, ci, grafana") with "disable them too". This
default is an owner decision.
- Effect at control: immediate (`resolveKey` and the membership are read on every request).
- Effect on the data path: until edge's 60 s cache and KV propagation end, 0–120 s modelled
  (experiment S15b, §9).

**Leave.** The same as removal, done by the member. The last owner must transfer ownership or delete
the workspace first.

**Transfer ownership.** Following Vercel (R14 §6): an owner promotes another member to owner, then
may demote themselves. At least one owner always. Both steps need a fresh user verification (§5.4).

**Recover access** (option A):
1. Another passkey. Synced passkeys make this the common case.
2. A recovery code, `vzq1.<account>.<43>`, single use:
   - It opens a *recovery session* that can only register a new passkey and view the security log.
   - Every other session of the account ends, the codes left over are replaced, and the event is
     logged.
   - Attempts are limited exactly in the `Account` (10 a day), and approximately per network (§4.3).
3. Re-invite by an admin. The person makes a new account, the admin removes the old one. Workspace
   data is not personal, so nothing is lost but the old account's other memberships.
4. Operator-assisted, for a **sole owner** with nothing left. The operator mints an owner invite for
   that workspace with the existing admin-key path (§7) after checking identity out of band.
   - This is the one path without cryptography behind it, and the one social engineering targets
     (R14 §2, OWASP).
   - Proposed: a written procedure; a 72-hour delay during which any live session of an existing
     owner sees a banner and can cancel; and an audit entry by `kind: 'system'`.

### 4.3 Rate limits (D70's pattern, new bindings)

These reuse D70's rules unchanged:
- the narrowest key is asked first, and a refused call does not count;
- a wider key is asked only after every narrower one was checked;
- a network key is used only where no genuine credential is involved;
- a failing limiter lets requests through within 100 ms, and `/healthz` reports it.

Proposed limits per 60 s and per Cloudflare location (modelled, to be tuned on a stage):

| Binding | Key | Limit | Where |
|---|---|---|---|
| `AUTH_RL_SOURCE` | IPv4 address or IPv6 /64 | 30 | Every `/api/v1/auth/*` options and verify call, code previews, recovery |
| `AUTH_RL_SOURCE_48` | IPv6 /48 | 300 | The same, after the /64 |
| `AUTH_RL_CODE` | SHA-256 prefix of a tagged, unexpired code | 10 | Preview, sign-up, accept |
| `AUTH_RL_ACCOUNT` | Account id (from the user handle or the recovery code) | 20 | Sign-in verify, recovery |
| `AUTH_RL_TENANT` | The invite's tenant | 600 | Accept and session mint, a fuse for one object |

**Exact limits live in the objects**, because the binding is approximate and per location (R14 §5
[V]):
- recovery-code failures per account per day;
- invites created per workspace per hour (20) and outstanding (100);
- redemptions per sign-up code (its uses);
- workspaces per account (its allowance);
- members per workspace (plan, §6).

Turnstile (free, R14 §5) is held back for when sign-up is open to anyone. With codes, a bot holding
no code reaches no object.

### 4.4 Who creates sign-up codes

Slice 1: the operator, with a script modelled on `deploy/bootstrap.mjs`:
1. `deploy/signup-codes.mjs --count N --uses U --plan trial` sets a one-time gateway secret holding
   `{purpose: 'signup-codes', count, uses, plan, expiresAt}`.
2. It POSTs once, prints the codes once (or writes them to a 0600 file), and deletes the secret.

No long-lived operator credential exists. Later: operator accounts, listed by id in a deploy
variable (`VIZ_OPERATORS`), with step-up for code creation. Whether workspace owners may create
sign-up codes for others (a referral) is left to the owner: it multiplies the cost exposure of §6.

### 4.5 Abuse cases

| Case | What stops it |
|---|---|
| Enumeration of codes | About 131 random bits and an HMAC tag: forged codes fail in the Worker with the answer every unusable code gets, the same status and the same work (a hash). Rate limits per network and per code |
| A single-use invite passed on to someone else | Whoever redeems first joins, and the invite is spent. The inviter sees who accepted (display name, when). Short expiry. Optionally "needs approval". Remove the member if wrong. The same exposure as any bearer invite link in R14 §6 |
| A leaked multi-use code | Bounded by its uses and expiry, and revocable at once. Every redemption is in the audit log. A multi-use team invite is capped at `viewer` by default. A sign-up code's damage is at most its uses × the per-workspace cost cap (§6), which is why the cap must exist before self-service does |
| An invite to a workspace that was closed, or by a creator who was removed | Closing deletes all invites in the same transaction. Removing or demoting the creator revokes theirs. A leftover code finds no row and is refused |
| A removed member's sessions | Deleted in the removal's transaction. Control refuses at once; the data path within 0–120 s (modelled). The account session stays (it belongs to the person), but it no longer lists the workspace |
| A removed member's API keys and OAuth grants | Keys stay unless "disable them too" is chosen; they are listed. Grants they approved end (D44 already ends a grant when its approver's key is deleted; here the grant follows the membership) |
| Login CSRF (signing a victim into the attacker's account, so their typing lands in the attacker's workspace) | The sign-in endpoints refuse unless `Sec-Fetch-Site: same-origin` (or an `Origin` equal to the public URL). The passkey ceremony needs a gesture on viz's origin |
| A second browser profile or a shared computer | Sign-out ends the session on the server, along with its workspace key (OWASP, R14 §7) |
| Self-service used to host abuse (webhook spam through notifications, storage for unrelated data) | Plan caps (§6), the operator's list of workspaces in the `Directory`, and closing a workspace |

---

## 5. Sessions for the web app (common to all options)

### 5.1 The choice: a workspace key in an HttpOnly cookie, given to the backend by the gateway

**S1 (recommended).** Two cookies, both `__Host-` (Secure, Path=/, no Domain, so host-only on
`viz.bitcru.sh` and impossible to overwrite from another subdomain), `HttpOnly`, `SameSite=Strict`:

- `__Host-viz-acct` = the account session `vzu1.<account>.<43>` (tagged as in §4.1). It is read only
  by control's `/api/v1/auth/*` and `/api/v1/account/*` routes.
- `__Host-viz-ws` = a **workspace session key**: an ordinary API key `viz_<keyId>_<secret>` in the
  current workspace's `Tenant`.
  - kind `user`, subject `user:<accountId>`, name `session:<sessionId>` (reserved, like `service:`);
  - the role's scopes; an expiry of at most 12 h (a KV expiration, the existing mechanism);
  - a key id of 24 characters starting with `ses`, where ordinary key ids are 16, so the gateway can
    tell one from the other without a lookup.

The gateway does three new things (a change to its "unchanged" forwarding, §8):
1. For API paths of query, control, ruler and the agent JSON API, it adds `Authorization: Bearer
   <__Host-viz-ws>`, only when all of these hold:
   - the request has no `Authorization` header (an explicit key always wins);
   - it carries `X-Viz-Session: 1`;
   - `Sec-Fetch-Site` is `same-origin`, or `Origin` equals the public URL.
2. It removes the `Cookie` header from every forwarded request, except to control's `/api/v1/auth/`
   and `/api/v1/account/`. It passes `Set-Cookie` only from those two prefixes.
3. It refuses with 401 a bearer `viz_ses…` that arrives from outside: a session key is valid only as
   a cookie. It never translates for `/mcp`, `/oauth/*`, `/.well-known/*`, `/api/v1/bootstrap` or
   the ingest paths.

**What it buys.** `identify()` gains the `user` branch **without changing**: a session key is an
API key, `resolveKey` returns `kind: 'user'`, and the name is the person's.
- `resolveKey` gains one check: for a session key, the membership is live and its role still gives
  these scopes.
- edge, query, ruler and mcp change nothing; they already verify keys from KV and check scopes
  literally.
- The audit log says "by Dana" (kind `user`). Agents' proposals still need a person to apply them
  (D29), and a session is a person.

**What it costs.**
- One `Tenant` mutation, one KV write and later one KV delete per sign-in, switch or 12-hour renewal
  (§7).
- Revocation on the data path is the existing 0–120 s (modelled). Control is immediate.
- The secret is a bearer credential while it lives. `HttpOnly` keeps it from scripts; point 3 above
  keeps it from working outside the cookie.

**CSRF.**
- `SameSite=Strict` stops other sites.
- It does **not** stop other hosts in `bitcru.sh`, which count as the same site (R14 §7). The
  `Sec-Fetch-Site` / `Origin` check and the custom header (which needs a CORS preflight that nobody
  answers for these origins) stop those.
- No CORS response carries `Access-Control-Allow-Credentials`.
- The app sends `X-Viz-Session: 1` on every API call. A plain navigation to an API URL carries no
  authority.

**Rejected alternatives.**
- **S2: a short-lived signed workspace ticket** (60–300 s) in place of a key.
  - Every backend would gain a verifier (edge's `authenticate`, used by four Workers) and share a
    signing key.
  - Revocation would be bounded by the ticket's life, which beats KV only below about 60 s. That
    costs a control call per tab per minute.
  - It saves the KV write per session. It is what S1 becomes if revocation latency must be under
    60 s and KV cannot deliver it (§10).
- **S3: a person's key in `sessionStorage`** (today's model with a minted key). Any script injection
  takes it, and OWASP says not to (R14 §7).
- **A session table that the gateway looks up per request** (a Durable Object hop on every API
  call). It adds latency to every query to save a KV write per sign-in.

### 5.2 Lifetimes and revocation (proposed; the owner decides)

| | Idle | Absolute | Notes |
|---|---|---|---|
| Account session | 7 days | 30 days | A new token at sign-in and after recovery (no fixation). `last_seen` is written at most hourly, to bound row writes |
| Workspace session key | — | 12 h | Renewed silently: on a 401 in session mode, the app calls `POST /api/v1/auth/session/refresh`, which mints a new key if the account session and the membership are live |
| Step-up (fresh user verification) | — | 10 min | §5.4 |

OWASP's office-day figures (15–30 min idle, 4–8 h absolute, R14 §7) are tighter. A passkey makes
re-authentication one touch, so the owner may well choose them. The cost is more renewals, which
are cheap (§7).

Ending a session (sign out, or "sign out other sessions") deletes the session row and, through the
`Account`'s outbox, the session keys it minted.

A removed passkey ends every session created with it. Sessions record the credential they were made
with.

### 5.3 The "paste a key" path

It stays, for machines, operators and the period before migration:
- a key-holding tab is kind `key` and shows as now;
- the form moves behind "Use an API key" under the passkey button;
- the key is kept in page memory only, no longer in `sessionStorage` (one reload signs out). This
  is the owner's call: the app's README records `sessionStorage` as chosen so that a reload keeps
  the tab signed in.

Grafana, collectors and CI keep using keys, unaffected.

### 5.4 OAuth consent for MCP clients becomes a signed-in page

This is D44's "would change if".
1. `/oauth/authorize` validates as today, then answers **303 to `/connect#<request handle>`**.
   This is a redirect to viz's own origin, not the client's, so it is not an open redirect.
2. `/connect` is a new document. It shows what the plain-text page shows today:
   - the client name, marked unverified;
   - the redirect host, scopes, resource and lifetimes;
   - a workspace picker (the person's memberships), with the scopes limited to that membership's
     role.
3. Approve needs a fresh user verification (one touch). It POSTs `/api/v1/control/oauth/approve`
   with the session (kind `user`) and gets back the redirect. The app shows the destination host
   and navigates to it on a press. The server still never redirects to a client by itself.
4. The grant's approver is `user:<account>`. **The grant follows the membership**, not the 12-hour
   session key:
   - suspended while the member is suspended;
   - ended on removal;
   - its scopes cut when the role is lowered.

   This replaces "the grant follows that key" for person approvers. Key approvers keep today's rule.
   `Tenant.invoke`'s "key identities only" check still holds (a session key is a key). The approver
   check learns to resolve `user:` approvers against `members`.

Other step-up operations: adding or removing a passkey, creating a key with `admin` or `write`,
inviting an admin or owner, transferring ownership, closing a workspace. A step-up is a 10-minute
token, minted by a fresh assertion and sent as a header that control checks for `kind: 'user'`
identities. Keys are exempt, as they are for every operation today.

---

## 6. Workspace lifecycle and cost safety

### 6.1 What bounds a workspace today, and what is missing

Read from the code; nothing measured here.

| Bound | Today | Enforced by |
|---|---|---|
| Active series | 1,000,000 by default, `limits:<tenant>` overrides | edge and shard (D21) |
| Request size | 8 MiB decompressed, 16 MiB decoded (D71) | edge |
| Buffered tail per shard | 64 MiB per tenant per shard (backpressure, not a quota) | shard |
| One query | samples, series, bytes, files, timeout, leaves: deployment defaults (`QUERY_LIMITS`), per tenant only under query's own field names | query |
| Dashboards | 2,000, 256 KiB each, 500 revisions, 64 MiB of revisions and proposals | control caps |
| OAuth | 50 clients, 50 live grants, 20 approvals an hour | control (D44) |
| Rules | 64 shards × 1,000 rules | ruler placement |
| Retention | 1–3,650 days per signal, the tenant's choice | janitor |
| **Ingest rate** (samples, bytes, spans, log bytes per second or day) | stored (`samples_per_second`), **not read** | — |
| **Stored bytes** | none | — |
| **Query rate and concurrency per tenant** | stored (`query_concurrency`), **not read** | — |
| **Rules per tenant, minimum interval** | placement only | — |
| **Notification sends** | none (webhooks to any https URL) | — |
| **Control API rate** | none | — |
| **Members, invites, workspaces per account** | do not exist yet | — |
| **Tenants per cell** (DESIGN §3.3) | not enforced | — |

DESIGN §11 models a capped small tenant at under $1 a month pooled. An uncapped one can reach the
"team" range of **$400–800 a month** (1 M series, 100 GB of logs a day; modelled, not measured).
**A sign-up code must not be able to buy the second case.** Self-service must therefore wait for at
least:
1. a **plan** applied at `provisionWorkspace`: limits and retention written by the server, and
   `LIMIT_CEILINGS` per plan, so a workspace admin cannot raise them;
2. an **ingest byte budget** per workspace per day, enforced in the shard, which already meters per
   tenant and refuses with reasons;
3. **query rate** per workspace (a Rate Limiting binding keyed by tenant in query: approximate, but
   cost-bounding);
4. **rules per workspace** and a minimum interval;
5. a **notifications send budget** per workspace;
6. control's field names read by query (fixing today's mismatch), or one vocabulary.

A proposed trial plan, for the owner to set:
- 10,000 active series; 1 GB a day of logs and spans together; 14 days' retention;
- 50 rules at 60 s or more; 100 dashboards; 10 members; 20 keys;
- 2 queries a second per location.

Modelled cost of a workspace at that cap: about $1–5 a month, mostly storage and rule ticks. The
experiment is S15c (§9). The worst case for a leaked 50-use code is then 50 × that.

### 6.2 Leaving, removing, transferring

Covered in §4.2. Two rules: always at least one owner, and the last owner cannot leave.

### 6.3 Deleting a workspace

What exists makes deletion a staged process:

1. **Close** (owner, with step-up and the workspace's name typed). In one transaction:
   - status becomes `closing`;
   - every key is disabled (KV records, edge stops in 0–120 s modelled);
   - every session key is deleted and every invite revoked;
   - OAuth grants are ended;
   - outbox rows tell every member's `Account`.

   Every route but `GET /whoami`, export and restore answers 409 `workspace-closing`. Restore is
   possible for 30 days (an owner decision).
2. **Expire.** After 30 days the maintenance run treats a `closing` workspace as retention zero:
   every file is removed through the ledger, with tombstones, and the janitor's publisher gate and
   grace apply as for any removal (D20, D30). This is a **new janitor rule**: retention today has a
   1-day minimum and removes only whole past days.
3. **Purge.** Once the ledger holds no live file, delete:
   - the ledger's R2 log objects (**not built**);
   - the tenant's shard streams (**not built**: streams are never retired);
   - rulers and the notifier;
   - the KV records;
   - finally the `Tenant`'s storage (`deleteAll`), leaving a tombstone row in the `Directory` so the
     id is never reused.

**Physical deletion is not available today.** Slice 1 offers close and restore only. The person is
told plainly: "Data is kept until the operator purges it." Purge is its own piece of work and needs
its own review, because it deletes data.

---

## 7. Migration

- **Existing tenants and keys keep working unchanged.** A tenant with no members is exactly today's
  tenant.
  - Schema version 4 of `Tenant` adds `members`, `invites` and workspace metadata, additively
    (`readableFrom: 3`), so the release before stays a rollback target.
  - Session keys are ordinary key rows. A rollback to a release that does not know them shows them
    as keys named `session:…` that expire within 12 h.
  - The new `Account` and `Directory` classes are a migration of viz-control (`wrangler deploy` as
    for D53's first deploy). A rollback across it leaves their storage unread, and leaves people
    unable to sign in until the roll-forward.
  - The release that adds people becomes a floor only for reading memberships. D69's format floors
    say how.
- **"The last enabled admin key cannot be disabled or deleted"** must not count session keys. Once a
  workspace has an owner, the rule becomes "the last owner, or else the last admin key".
- **The operator's bootstrap tenant gets an owner account.** An admin key (the one bootstrap printed)
  may create an invite with role `owner` **only while the workspace has no owner**
  (`POST /api/v1/control/invites {role: "owner"}`). The operator:
  1. runs it with the key;
  2. opens the link, creates a passkey, and is the owner;
  3. may then disable the bootstrap key or keep it for automation.

  Every existing tenant claims its owner the same way. No Cloudflare credential is involved.
- **The app** detects whether the API has accounts (`/api/v1/auth/options` answers 404 on an older
  release) and shows the passkey button only then.

---

## 8. Options

Each option is a whole design. §2, §4 and §5 are common to all three and are not repeated.

### Option A: viz's own accounts, passkeys only, gated by invite codes (recommended)

**Data model.** §2.3: `Account` and `Directory`, `Tenant` schema 4. Credentials are passkeys and
recovery codes.

**Flows.** §4.2 as written.

**Threats and mitigations.**
- Phishing: passkeys are origin-bound.
- Credential stuffing: there are no passwords.
- Recovery is the weak point. Recovery codes (exact attempt limit; a recovery session can only add
  a passkey), admin re-invite, and operator-assisted recovery with a delay and a procedure (§4.2).
- A sole owner who loses every passkey and the codes loses the workspace, unless the operator helps.
  The app says so when it shows the codes, and keeps asking for a second passkey until one exists.
- The workspace key in a cookie (§5.1). Gateway translation is a new trust boundary and needs its
  own tests and mutants.

**Cloudflare pieces and their limits.**
- Durable Objects: `Account` and `Directory` (soft 1,000 requests a second each; sign-ins spread
  over accounts).
- KV: session keys, eventually consistent, writes $5 per million past 1 M a month.
- Rate Limiting bindings: approximate, per location. Whether one Worker can carry six (D70) plus
  five more bindings is not verified; D70's six have not yet been seen accepted by Cloudflare
  (DESIGN status).
- One new Worker secret (`AUTH_KEY`).
- No email, no DNS change, no Zero Trust.

**Cost** (modelled; experiment S15a):
- Per sign-in, switch or renewal: 2–4 Durable Object requests, 10–25 rows written (the session
  row, key row, audit row, outbox rows and alarm; no challenge row, because challenges are
  stateless), and 1 KV write plus 1 KV delete later.
- 100 people, 3 a day: about 9,000 a month. That is 0.1–0.2 M rows and 18,000 KV writes and deletes,
  inside the included amounts: **$0** past the plan fee.
- 100,000 people, 3 a day: 9 M a month. That is 90–225 M rows ($40–175), 18 M KV operations
  ($85) and 18–36 M Durable Object requests ($3–5): about $130–265 a month.
- Unauthenticated traffic costs Worker CPU only (tag checks, stateless challenges): $0.30 per
  million requests past the included 10 M.
- The real cost of self-service is the workspaces' telemetry, not sign-in (§6.1).

**Changes per component.**

| Component | Change |
|---|---|
| `contracts/` | New `accounts.ts`: roles and `ROLE_SCOPES`, the code and session formats (`vzs1`, `vzi1`, `vzu1`, `vzq1`), the `Account` and `Directory` RPCs, membership outbox messages, cookie names, the `ses` key-id convention. `control.ts`: `provisionWorkspace`, `acceptInvite`, `mintSessionKey`, `members`. `oauth.ts`: `OAuthActor` kind `user` approvers, and grants following members |
| `control` | The `Account` and `Directory` classes; `Tenant` schema 4; WebAuthn verification (a small verifier without attestation, or `@simplewebauthn/server` if it runs in workerd, MIT: R14 §1); routes `/api/v1/auth/*`, `/api/v1/account/*`, `/api/v1/control/members`, `/api/v1/control/invites`; `resolveKey`'s membership check; step-up; the approver check following `user:`; the outbox's `Account` target; new rate limits; OpenAPI |
| `edge` | None. Optionally a reader of `revocation:<tenant>`, to shorten data-path revocation (§10) |
| gateway | Cookie translation and stripping, the `viz_ses` refusal, `Set-Cookie` only from control's two prefixes; `/oauth/authorize`'s 303 to `/connect` is control's; new documents in `serve.json` |
| `app` | Sign-in (passkey, autofill UI), `/join`, `/connect`, account page (passkeys, recovery codes, sessions), workspace switcher, members and invites screens; the key form moved behind "Use an API key"; `X-Viz-Session` on every call; no credential in `sessionStorage`. **A design change**: the design system's process applies in full (AGENTS.md, "Design changes"): new flow screens, before-and-after images, expert review |
| `mcp` | None for sessions (the gateway never translates at `/mcp`). The in-app assistant, when built, must act as kind `agent`, not as the person (D29), an open point |
| `ruler`, `query` | None for sessions. Self-service needs the quotas of §6.1 (query rate, rules, notifications) |
| `janitor`, `stack` | Close, expire and purge (§6.3), later |
| `deploy` | `AUTH_KEY` generated as in D53; the new bindings and classes; `deploy/signup-codes.mjs`; refuse a production control without the auth rate-limit bindings, as D70 does |

### Option B: GitHub and Google sign-in, gated by invite codes

**Data model.** As A, with credentials being (provider, immutable subject: GitHub's numeric id,
Google's `sub`) and an index `identities` in the `Directory` for uniqueness. Email is stored only for
display, and **never used to link accounts** (R14 §4).

**Flows.**
1. Sign-up starts at `/api/v1/auth/<provider>/start`, with the code inside a signed `state`
   (and PKCE, and a nonce for Google).
2. The provider redirects to `/api/v1/auth/<provider>/callback`:
   - exchange the code (client secret as a Worker secret);
   - read the subject (GitHub `/user`, or verify Google's ID token against its JWKS);
   - discard the provider's token;
   - continue the saga as in A.
3. Sign-in is the same without a code. A new subject without a code is refused with the generic
   answer.
4. Recovery is the provider's.
5. Adding a passkey later is allowed and is how B grows into A.

**Threats.**
- An account taken over at the provider is taken over here.
- An outage at the provider stops new sign-ins.
- The redirect flow reintroduces `state` CSRF and mix-up concerns, which OAuth's own rules handle.
- The client secret is long-lived (rotation is the operator's).
- Linking accounts by email would be account takeover, so it is forbidden.

**Cloudflare pieces.** As A, plus outbound fetch to github.com, googleapis.com and accounts.google.com.
These count toward the request's six connections; one or two are used.

**Cost.** As A. $0 to the providers.

**Operational burden.**
- Register an OAuth app per provider and per stage hostname, and keep its secret.
- Google's brand verification [T].
- A person without GitHub or Google cannot join.

**Changes.** As A, minus WebAuthn, plus provider clients and their tests (against a local fake
provider). The app shows "Continue with GitHub/Google".

### Option C: Cloudflare Access in front, viz's memberships behind

**Data model.** As A, with the credential being Access's identity (its JWT `sub`; email for
display). The `Directory` maps Access subject to account. Sign-up codes are not needed: Access's
policy decides who may enter at all.

**Flows.**
- An Access application named `viz-…` covers the documents and `/api/v1/auth/access/session` only,
  never the API paths machines use. The machine paths stay on keys and need no service tokens.
- The gateway (or control) verifies `Cf-Access-Jwt-Assertion` against the team's certificates and
  creates the account session.
- Team invites still give workspace roles. Inviting a stranger also needs them added to the Access
  policy (or the one-time PIN by email) [T].
- Recovery is the identity provider's.

**Threats.**
- A path misconfiguration that leaves a document or `/api/v1/auth/access/session` outside Access
  would let a request without Access mint a session. It needs a deploy-time check that the Access
  app covers exactly those paths, and a refusal when the JWT is absent.
- The JWT's audience must be checked.

**Cloudflare pieces.** A Zero Trust organisation (account-wide, beside unrelated resources: the
owner must agree to it under AGENTS.md's rules), an Access application and policy. Free to 50 users,
then $7 per user per month (R14 §5 [V]).

**Cost.** $0 to 50 people. For 100 people, about $350–700 a month depending on how many need seats
(modelled from the list price).

**Fits.** DESIGN §1's primary deployment, *one organisation deploying viz to its own account*, very
well. It fits a hosted service for strangers poorly. It does not answer "invite codes for
self-service", which suggests the owner means the hosted shape.

**Changes.** As A, minus WebAuthn and sign-up codes, plus an Access JWT verifier, deploy steps for the
Access application, and a check of its paths.

---

## 9. Recommendation and staged plan

**Recommendation: Option A.**
- Passkeys are the only sign-in method that is phishing-resistant, needs no outside service, no DNS
  change and no per-user fee, and fits Cloudflare-only infrastructure as it already is.
- Invite codes are the gate.
- The session design (§5.1) keeps the data path exactly as it is: every backend already verifies
  keys, and `identify()` gains its `user` branch with no change.
- B is a later *additional* credential (link GitHub to an account that exists), not an alternative.
- C is documented as the answer for an operator who runs viz for one organisation, and can sit
  beside A.

**Slice 1, the smallest useful one: people for existing workspaces, no self-service yet.**
1. `contracts/accounts.ts` (own commit, first).
2. `Account` class, passkey sign-up through a **team invite** only, sign-in (autofill UI), recovery
   codes, sessions (§5), sign-out.
3. `Tenant` schema 4: members with viewer, editor, admin and owner; invites (single-use, multi-use
   viewer); remove member; leave; transfer ownership; the owner-invite migration (§7).
4. Gateway cookie translation; the app's sign-in, join, switcher, members and account screens; the
   key form behind "Use an API key".
5. The auth rate limits (§4.3) and the deploy's refusal without them.

This slice gives the operator and their team real identities, roles and off-boarding on existing
tenants. It creates no tenant, so it adds **no telemetry cost exposure**.

**Slice 2: the signed-in consent page for MCP clients** (§5.4) and step-up. This retires the
admin-key consent step of D44.

**Slice 3: self-service workspaces with sign-up codes.** `Directory`, `provisionWorkspace`, plans.
**Gated on §6.1's quotas** (ingest bytes a day, query rate, rules, notifications, plan ceilings),
each built in its own component with its own tests. Close and restore (§6.3, steps 1–2).

**Slice 4, later:**
- email through Email Sending for invite delivery, email-bound invites and security notices
  (after the owner approves the sending domain's DNS records);
- GitHub and Google as extra credentials;
- operator accounts;
- purge (§6.3, step 3);
- Option C for single-organisation operators.

**Experiments** (`spikes/s15-accounts/`; none run; each deletes what it creates, as AGENTS.md
requires):
- **S15a, sign-in cost.** One Durable Object per simulated client running N sign-ins, renewals and
  switches against a staged viz. Rows written, KV writes and Durable Object requests are read from
  Cloudflare's analytics for the window. This replaces §8 A's modelled ranges.
- **S15b, revocation latency.** Remove a member on a stage, then probe the query API from clients in
  several locations until the first 401. It measures the modelled 0–120 s, and decides whether
  S2 (§5.1) or a `revocation:` reader is needed.
- **S15c, the capped workspace.** A trial-plan workspace driven at its caps for 24 hours. It
  replaces §6.1's $1–5 a month.
- **S15d, the bindings.** Upload a control with six plus five Rate Limiting bindings and read them
  back. This shares spike S13's open question.

**What would change the recommendation.**
- The owner wants viz for one organisation only, with no strangers: then C, possibly with A for
  people outside the organisation.
- The people expected mostly lack passkey-capable devices (Linux desktops without a phone or
  password manager): then add B in slice 1.
- S15b shows data-path revocation well above 120 s, or the owner needs it under a minute: then S2
  tickets, or a `revocation:<tenant>` reader in edge.
- Cloudflare's Email Sending leaves beta and the owner accepts the DNS change: email moves earlier,
  for invites and notices, never for sign-in.
- Workers stop allowing more Rate Limiting bindings: then exact limits in the objects only, or a
  WAF rule on `viz.bitcru.sh`.

**What the owner must decide.**
1. The product shape: a hosted service for strangers (A), one organisation (C), or both.
2. The RP ID: `viz.bitcru.sh` (recommended: the narrowest, R14 §1). It cannot change later without
   everyone registering passkeys again.
3. Recovery: recovery codes + admin re-invite + the operator procedure with a 72-hour delay; and
   whether a sole owner may be told "no recovery without the operator".
4. Roles: the four in §2.2; whether a viewer may acknowledge alerts.
5. Session lifetimes (§5.2) and the step-up list.
6. On removal: keep or disable the member's keys by default; end or move the OAuth grants they
   approved.
7. The rewording of "tenant from the credential" (§2.3) in `AGENTS.md`.
8. The gateway no longer forwarding unchanged (§5.1).
9. The trial plan's numbers (§6.1), workspaces per account, and whether owners may create sign-up
   codes.
10. Closing and restore windows; that physical deletion waits for purge.
11. The "paste a key" path kept in memory only (§5.3).

### Draft decision entry (for `design/DECISIONS.md` once chosen)

> **D7x (draft). People are accounts outside every tenant, signed in with passkeys and admitted by invite
> codes; a workspace is a tenant; roles are sets of the existing scopes; the web app's session is a
> workspace key in an HttpOnly cookie that the gateway hands to the backend.**
>
> **Decision.**
> - Accounts live in a per-account `Account` Durable Object; sign-up codes and the list of
>   self-service workspaces live in a singleton `Directory`. Both are classes of viz-control.
> - Memberships are authoritative in the workspace's `Tenant`, and copied to the account through
>   the outbox.
> - Roles viewer, editor, admin and owner map to the existing scopes (§2.2). People never hold
>   `write`.
> - Sign-in is a passkey, discoverable, with user verification and no attestation, RP ID
>   `viz.bitcru.sh`. Recovery is another passkey, single-use recovery codes, re-invite by an
>   admin, or the operator's procedure.
> - Sign-up codes (operator) and team invites (admins) are tagged bearer codes in the URL fragment,
>   single-use by default, expiring, revocable and audited, and rate-limited as in D70.
> - The web app holds an account session cookie and a workspace session key cookie, both `__Host-`,
>   `HttpOnly` and `SameSite=Strict`. The gateway turns the second into `Authorization` for
>   same-origin requests that carry `X-Viz-Session`, strips cookies from everything else, and
>   refuses session keys presented as bearers.
> - MCP consent becomes a signed-in page, and grants follow the approving membership.
> - Self-service workspaces wait for per-workspace quotas.
>
> **Alternatives.**
> - Email magic links: NIST, mail scanners, a beta sender, a DNS change.
> - GitHub or Google only: the provider's account and outages become viz's.
> - Cloudflare Access in front: one organisation, per-seat price past 50 users.
> - Signed short-lived tickets verified by every backend (S2).
> - A key in `sessionStorage` (S3).
> - A per-request session lookup in the gateway.
>
> **Why.** Passkeys are the only phishing-resistant method that needs nothing outside Cloudflare.
> Turning sessions into keys reuses every backend's verification, scopes and tenancy, and makes
> `identify()`'s `user` branch real without changing it. Invite codes in the fragment survive mail
> scanners and logs.
>
> **Would change if.** See §9, "What would change the recommendation".

---

## 10. What needs an adversarial review before building

Findings and dispositions go to `design/REVIEW.md`. The reviewer gets this file, R14 and the code,
not the reasoning.

1. **The crossing of tenant boundaries** (§2.3): the switch, invite acceptance, workspace creation,
   and the proposed rewording of the AGENTS.md rule. Can any request pick a tenant it is not a
   member of? Can a forged account id reach a `Tenant`?
2. **Gateway cookie translation** (§5.1): CSRF from other `bitcru.sh` hosts, cookie tossing, a bearer
   `viz_ses` used from outside, a cookie forwarded to a backend that logs headers, `Set-Cookie` from a
   backend other than control, the interaction with `Authorization`, and the paths it must never
   touch.
3. **The sign-up and accept sagas** (§4.2) across `Directory`, `Account` and `Tenant`: retries, a
   crash between steps, two redemptions racing for the last use, the outbox to `Account`, and
   idempotency of `applyMembership`.
4. **WebAuthn verification**: origin and RP ID checks, challenge binding and single use,
   UV enforcement, algorithm handling (DER to raw for ECDSA), counters, and what a malformed
   authenticator response can make the Worker do (CPU, memory).
5. **Recovery** (§4.2): codes, the recovery session's limits, the operator procedure, and the
   72-hour delay with no notification channel.
6. **Removal and revocation** (§4.5): sessions, keys, grants and invites in one transaction; the
   0–120 s data-path window; and grants following memberships (D44's approver rule).
7. **Rate limits** (§4.3): keys chosen, the order, failing open, and what an attacker without a code
   can make the objects do (target: nothing).
8. **Cost bounds of self-service** (§6.1), before slice 3: whether the plan caps actually bound a
   workspace's monthly cost, with S15c's measurement.
