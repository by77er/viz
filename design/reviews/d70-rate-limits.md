# Review: D70, rate limits in front of OAuth

This is an adversarial review of decision D70 on the development branch. It was written on
2026-11-19. The reviewer did not build D70 and was given no reasoning beyond what the tree contains.
All reproductions ran in a copy in the reviewer's scratch area. Nothing in the shared tree was
changed. No Cloudflare call was made.

## Scope (commit read)

- **Commit**: `3cbabb8` ("control: rate limits in front of OAuth (D70)"). Between it and `e11e648`
  (HEAD while the reproductions ran), `control/`, `contracts/oauth.ts` and `deploy/gateway/` did
  not change. D70 was read from `git show 3cbabb8:design/DECISIONS.md`, lines 2722–2849.
- **Files read**:
  - `control/src/ratelimit.ts`, `oauth-http.ts`, `ops-oauth.ts` (token, refresh, revocation and
    sweep), `introspection.ts`, `index.ts`, `tenant.ts` (the OAuth RPCs);
  - `contracts/oauth.ts` (`RateLimited`, `OAUTH_LIMITS`) and `contracts/COMPATIBILITY.md` §3.2 and §4;
  - in `control/README.md`: the D70 sections (lines 401–475), the D70 verification section
    (901–975), Known risks (1281–1330) and "Needed changes elsewhere" (1382–1442);
  - `control/test/ratelimit.test.ts`, `oauth-cost.test.ts` and `vitest.config.ts`;
  - `deploy/gateway/src/index.ts`, `deploy/configure.mjs` (`KNOWN_KEYS`, `workers_dev`) and
    `deploy/lib/secrets.mjs`;
  - `mcp/src/auth.ts`, both as committed and at `25321c4` (the previous port).
- **Background**: D44 and its review `design/reviews/d44-d52-d53-d60.md` (M-2 and its disposition).
- **Not reviewed**: there are uncommitted changes in the working tree, in `mcp/src/auth.ts` and
  `mcp/src/index.ts`. They map `rate_limited` to a 429 with `Retry-After`. These changes are
  someone else's work in progress. They were seen but not reviewed.
- **External sources**, each labelled with how it was checked:
  - Cloudflare, "Rate Limiting" binding page
    (developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). Read 2026-11-19; the
    page's `dateModified` is 2026-11-12. **Verified** there:
    - "A call that returns `success: false` does not add to the count";
    - the count is local to a location and eventually consistent ("Other Cloudflare locations
      maintain separate counts"; "Requests can exceed your configured limit before those updates
      arrive");
    - `period` must be 10 or 60;
    - `namespace_id` counters are shared across the account;
    - the key "can be any `string`", and IP keys are "not recommended";
    - the only documented throw is a `delta` that is not a positive integer;
    - the page names no price.
  - Cloudflare, "HTTP request headers" page
    (developers.cloudflare.com/fundamentals/reference/http-headers/). Read 2026-11-19;
    `dateModified` 2026-11-15. **Verified** there:
    - "When no Worker subrequest is triggered, `cf-connecting-ip` reflects the client's IP
      address";
    - "In cross-zone subrequests … the `CF-Connecting-IP` value will be set to the Worker client IP
      address `'2a06:98c0:3600::103'`";
    - "In same-zone Worker subrequests, the value of `CF-Connecting-IP` reflects the value of
      `x-real-ip` … `x-real-ip` can be altered by the user in their Worker script".
  - `@modelcontextprotocol/sdk` 1.32.2, as installed in `mcp/node_modules`. **Verified by
    reading**:
    - `client/auth.js` 126–140: `parseErrorResponse` maps an unknown code to `ServerError`;
    - `client/auth.js` 186–202: `auth()` discards credentials only on
      `InvalidClient`/`UnauthorizedClient` (all) and `InvalidGrant` (tokens);
    - `client/auth.js` 366–375: a `ServerError` during refresh falls through to a new
      authorization, and any other `OAuthError` is re-thrown;
    - `server/auth/errors.js` 123–125 and 175: `too_many_requests` maps to `TooManyRequestsError`;
    - the client has no handling of `Retry-After` or of revocation.
  - The Python `mcp` SDK 2.3.0: the wheel PyPI served on 2026-11-19, unpacked and read but not
    executed. **Verified by reading** `mcp/client/auth/oauth2.py` 533–537 and 618–620: *any*
    non-200 refresh response calls `clear_tokens()`, after which the client does a full
    re-authorization.
  - **Training knowledge, used as leads only**:
    - hosted MCP clients broker OAuth from their own servers' egress addresses;
    - tunnel brokers hand out routed IPv6 /48s for free.

## Findings by severity

Counts: **1 blocker, 2 majors, 8 minors.**

### B-1. A tenant's OAuth can be shut down by anyone who ever held one of its credentials, live or dead — **reproduced** (R1, R1b, R2, R3)

**Where**:
- `control/src/ratelimit.ts:177-178`: `limitToken` keys `OAUTH_RL_CLIENT` on
  `digest(clientId)`, the *presented* `client_id`.
- `control/src/oauth-http.ts:314,324`: only the shape (`CLIENT_ID.test`) is checked before
  `limitToken`. The MAC is not verified.
- `ratelimit.ts:181` and `oauth-http.ts:352`: revocation counts only against `OAUTH_RL_TENANT`.
- `ratelimit.ts:184-187` and `introspection.ts:45-47`: introspection counts against the token and
  then against `OAUTH_RL_BEARER_TENANT`.
- `contracts/oauth.ts:124-140`: a credential's tag never expires.

**What is claimed.** D70 (DECISIONS.md:2755) and README:425 say: "The narrower key is asked first
and a refused call does not count, so one client's or token's flood spends at most its own allowance
of the tenant's budget." The "Why" section (DECISIONS.md:2836) says a tenant's OAuth "can be denied
in one location only by someone holding its genuine credentials". README:1297–1301 bounds such a
holder at "at most 20 a minute per client id and 600 per token", with victims getting 429 "for up
to a minute".

**What the code does.** The tag proves only that this deployment once minted the credential. It
says nothing about whether the credential is live. Three paths spend a tenant's budget:

- **Token endpoint.** The per-client key is attacker-chosen text. Each request can name a new
  shape-valid `client_id`, so the narrower limit never applies. One dead credential spends the whole
  token-and-revocation budget of its tenant: R1 sends six requests with six made-up client ids, and
  all six reach the object. Naming the victim client's own `client_id` spends *that* client's
  allowance instead (R1b). That needs only 20 requests a minute at the proposed limits, which is
  under the source limit from one address. Client ids are not secrets: they sit in the authorize
  URL, in browser history and in the approval `curl`.
- **Revocation.** There is no narrower key at all. R2 sends one dead access token six times. That
  spends the tenant budget, after which the live client can neither refresh nor revoke (429
  "Nothing was revoked").
- **Introspection.** The bearer-tenant budget is reached with five dead access tokens at the
  proposed limits (R3: two at the test limits). After that, every live token of the tenant is
  refused before its object.

**Who can do it.** Any one tagged credential of tenant X is enough, at any time after it was
issued. Examples:
- a revoked or distrusted client;
- a debug log;
- a code from the approval's redirect link, which is kept in browser or shell history (a code goes
  to `/oauth/token` with a made-up `client_id`).

A former client holds thousands of these, about two an hour of its grant's life. So the "per token"
bound multiplies as well.

**Failure scenario, at the proposed limits, per Cloudflare location.**
- Token endpoint: 5 requests a second with one dead token or code, from 3 networks to stay under
  the source limit (3 IPv6 /64s are enough). Every refresh, code exchange and revocation of tenant X
  served in that location is refused for as long as the attack runs, not "for up to a minute".
- `/mcp`: 50 requests a second with 5 dead access tokens. Every agent call of tenant X there gets
  `rate_limited`. Today that is a 503 from viz-mcp.

**What the refusal does to clients.**
- The TS SDK keeps its credentials and fails each call.
- The Python SDK 2.3.0 discards its tokens on **any** non-200 refresh (oauth2.py:533–537). Each of
  its clients therefore needs a person to approve again. That approval's code exchange is refused
  by the same tenant budget.
- The abandoned grant stays live, because its refresh token was not spent. It counts against
  `liveGrantsPerTenant` (50) until the 30-day idle sweep, so repeated lockouts can end in
  `too-many-grants` for the tenant.

**Why this is a blocker.** D70 rejected failing closed because a closed failure "would end every
agent's access within the hour its access token lasts, and would block revocations, which a client
sends to end access" (DECISIONS.md:2783–2786). As built, the tenant-wide keys let an outsider with
one stale credential produce exactly that outcome, cheaply and continuously. Without the
tenant-wide keys, the same replays would cost the object about 1 ms each and write nothing
(README cost table, measured locally). That is about 0.5% of one object at 5 a second.

**What must change.** All of these:
1. On `/oauth/token` and `/oauth/revoke`, key the narrower limit per *credential* (a SHA-256 prefix
   of the presented code or token), and ask it before any wider key. If a per-client key is kept,
   take it only from a `client_id` whose MAC `verifyClientId` accepts.
2. A dead credential must not be able to spend a tenant-wide budget. Two options:
   - (a) Put an expiry the Worker can check into the credential format. This is a format version
     in `contracts/oauth.ts`. Codes expire after 10 minutes and access tokens after 1 hour, so
     nearly every stale one would be refused before it counts. Add a per-location negative cache
     (Cache API, keyed by the credential hash, TTL of at least one window) for credentials an
     object has called dead.
   - (b) Until (a) exists, drop `OAUTH_RL_TENANT` and `OAUTH_RL_BEARER_TENANT`. Alternatively, set
     them near the object's measured capacity as last-resort object protection, not at 5 or 50 a
     second.
3. Rewrite D70's "narrower key" and "Why" claims and the README Known risk to match.
4. Turn R1–R3 into tests: after the change, the victim is served.

### M-1. The source limit counts genuine credentials, and every MCP client hosted on Cloudflare Workers shares one source key — **reproduced at unit level** (R4); the shared address is verified from Cloudflare's documentation; the hosted-client aggregate is modelled

**Where**: `oauth-http.ts:369-372` (the source limit on `/oauth/token` and `/oauth/revoke` runs
before the tag), and `ratelimit.ts:139-148` (`sourceNetwork`).

**Workers-hosted clients.** Cloudflare sets `CF-Connecting-IP` to `2a06:98c0:3600::103` on every
cross-zone Worker subrequest (verified). So every MCP client running in a Worker or Durable Object,
in any account, lands on the one key `s:v6:2a06:98c0:3600:0::/64`. Examples are clients built on
Cloudflare's agents tooling, or any `workers.dev` agent.

Anyone with a free Workers account can keep that key spent at 2 requests a second, for example
with registrations. That refuses every Worker-hosted client's registration, code exchange and
**refresh with a genuine token** in that location (R4: five registrations from that address, then
a genuine refresh from it is 429 "from your network").

**Hosted clients.** These broker OAuth from their servers' egress addresses (training knowledge,
a lead). They concentrate *all their users'* refreshes and registrations of every viz tenant behind
a few addresses. At one hourly refresh per connected user, about 7,200 users behind one egress
address in one location reach 120 a minute with no attacker at all (modelled). The README's
"about ten times what the flows need" sizes the limit for one person connecting, not for a broker.

**Impact.** Refusals of live refreshes are exactly the ones that make Python-SDK clients discard
their tokens (B-1).

**What must change.**
- On `/oauth/token` and `/oauth/revoke`, count against the source key only requests whose
  credential fails the shape or tag check. That costs one HMAC, 0.28–0.33 ms (measured here).
  Genuine credentials are counted per credential instead.
- Keep the source limit before the body only on `/oauth/register` and `/oauth/authorize`.
- Record the shared Worker address and broker egress in D70, Known risks and "Would change if".

### M-2. "Required before public exposure" is enforced nowhere, and a release today turns OAuth on without layer 1 — **verified by reading**; not run

**Where**:
- `deploy/lib/secrets.mjs` (committed, `GENERATED_SECRETS`): the deploy generates
  `OAUTH_CLIENT_KEY` on release.
- `deploy/gateway/src/index.ts:94,103`: the gateway routes the five OAuth paths publicly.
- `deploy/configure.mjs:49,144`: `KNOWN_KEYS` has no `ratelimits`, and an unknown key is refused.
  No deployment can carry the bindings even by hand through the release.
- `ratelimit.ts:73`: an absent binding returns `unchecked` **without logging**.

**Failure scenario.** The next production release serves registration, the authorization page,
the token endpoint, revocation and OAuth bearers at `/mcp` with no layer 1, and nothing in logs or
`/healthz` says so. Review of D44, M-2 made a rate limit a condition of public exposure, and D70
(DECISIONS.md:2787) puts the gate in the deploy ("a needed change"). Today it exists only as prose
in `control/README.md` "Needed changes elsewhere" 3.

Mitigating: with the tag and layer 2, exposure without layer 1 costs Worker CPU, not object writes.
Given B-1, shipping the tenant-wide keys as designed would be worse than shipping none.

**What must change.** Before any production release that carries `OAUTH_CLIENT_KEY`, add one of:
- the deploy gate, with its test;
- a static check in control: with no bindings, OAuth counts as not configured (registration 503
  and not advertised; token endpoint and introspection 503), which a stage can override by a var;
- at minimum, the release refusing to generate `OAUTH_CLIENT_KEY` for a production viz-control
  without the bindings.

### Minors

**m-1. A limiter brownout adds 3 s to each token request and 2 s to each `/mcp` request — reproduced (R5).**
At `ratelimit.ts:65,95-98`, the checks run one after another, each with its own 1 s timeout.
Measured here: a refresh took 3,035 ms and an introspection 2,005 ms with hanging limiters. The
attacker cannot cause this, but every agent call pays it during a binding fault. Use one deadline
per request (for example 250 ms total), not one per check. `limit()` latency on Cloudflare is
unmeasured. That is the experiment the README already names.

**m-2. Absent bindings fail open silently, but D70 and the README say "it logs".**
`ratelimit.ts:73` returns `unchecked` with no log for `undefined`. Compare DECISIONS.md:2778–2779
("when the binding is absent, … ; it logs") and README:455–457. This is the production state today
(M-2). Either log once per isolate when a binding is absent, or correct both texts. Also: nothing in
`/healthz` reports the limiters, and a binding whose `namespace_id` collides with an unrelated
script's would distort counts with no signal.

**m-3. Claims the code does not keep, besides those in B-1.**
- "a refusal changes nothing and spends nothing" (`ratelimit.ts:42`). When `OAUTH_RL_CLIENT`
  allows and `OAUTH_RL_TENANT` refuses, the client's allowance was spent.
- "CORS preflights are not counted" (DECISIONS.md:2789; README:427). An `OPTIONS /oauth/authorize`
  is counted (`oauth-http.ts:363` exempts every path but that one).
- "A route to viz-control that bypassed the gateway would let a caller choose its network key"
  (README:1311). This is imprecise: Cloudflare sets the header on any public route. The paths that
  let a caller choose it are a same-zone Worker subrequest (`x-real-ip`) and a service binding.
- "its client maps it to `TooManyRequestsError` and keeps its credentials" holds for the TS SDK
  only. The Python SDK 2.3.0 discards tokens on any non-200 refresh, so no refusal code is safe
  for it, and D70 should say so.

**m-4. The source key can be chosen through any same-zone Worker — not reproduced; a lead.**
The `bitcru.sh` zone holds unrelated hostnames (AGENTS.md). A Worker on one of them that fetches
`vis.bitcru.sh` for its users sets `CF-Connecting-IP` from its own `x-real-ip` (verified as
documented behaviour). It would let a caller evade the source limit, or *spend a chosen victim
network's budget*, such as a broker's egress. Also: any future internal caller of `/oauth/*` by
service binding shares the one key `none`. Record both. The remedy in M-1 removes most of the
consequence for genuine credentials.

**m-5. The introspection budgets have no "ten times" headroom — modelled.**
`OAUTH_RL_BEARER_TENANT` 3,000 a minute equals 50 live grants (the tenant maximum) at one `/mcp`
call a second each, in one location. That is one times the load, not ten (README:428). Per token,
10 a second is reachable by an agent issuing parallel tool calls. Tied to B-1's fix.

**m-6. The IPv6 /64 grouping understates one host's reach — training knowledge; affects Worker CPU only.**
A routed /48 (free from tunnel brokers) is 65,536 source budgets, and a /56 home allocation is 256.
"A botnet gets 120 a minute per network" (DECISIONS.md:2802) should say a single host can hold
thousands of networks.

**m-7. Layer 2's tenant-level worst case is not stated — modelled.**
50 grants × 6 refreshes a minute × about 11 billed rows comes to about 3,300 row writes a minute.
That is about 4.75 M a day, or about $4.75 a day per tenant at list price (training knowledge), plus
432,000 rotated rows kept a day. Only the tenant's own approved clients can drive it, so this is
correct as "bounded". The number belongs in D70 next to the per-grant $0.10 a day.

**m-8. "Per location" depends on control and mcp having no Smart Placement, and nothing guards that.**
`query/wrangler.jsonc` already uses `"placement": { "mode": "smart" }`. With placement on control
or mcp, their invocations collapse into a few locations, so the "per-location" tenant budgets become
nearly global, and B-1 with them. Add a note to D70 "Would change if", or a configure test that
refuses placement on viz-control and viz-mcp while the binding layer stands.

## Verdict for D70

**Reject as it stands (layer 1); re-review after the changes below.** Layer 2, the refusal shape
and the contract addition can stand as written.

What must change before D70 is accepted or OAuth is exposed:
1. **B-1**: narrower keys per presented credential on token and revoke, and any per-client key
   only from a verified `client_id`. Dead credentials must not spend tenant-wide budgets:
   credential expiry checked in the Worker plus a negative cache, or no tenant-wide keys until
   then. The review's R1–R3 become regression tests in which the victim is served.
2. **M-1**: on `/oauth/token` and `/oauth/revoke`, count against the source key only credentials
   that fail the shape or tag check. Record the shared Worker address and broker egress.
3. **M-2**: an enforced gate, in the deploy or in control, so that no production release exposes
   OAuth without the bindings. Log or report absent bindings (m-2).
4. Correct the D70 and README claims listed in B-1, m-2 and m-3. Add the tenant-level worst case
   (m-7) and the placement condition (m-8).

## What was attacked and held

- **Made-up credentials spend no tenant budget.** The tag is checked before every per-tenant,
  per-client and per-token key (`oauth-http.ts:322-324,349-352`; `introspection.ts:45-46`). Their
  tests and the reviewer's reading agree.
- **No cross-tenant spending.** Every key after the tag carries the tenant from the credential, and
  tenant ids cannot contain `:`. The only cross-tenant key is the source key (M-1).
- **Hashing.** `client_id` and the token go into keys as 128-bit SHA-256 prefixes. No input sets a
  key's length or forces a collision. R1b is not a collision: it names the same `client_id`.
- **`CF-Connecting-IP` cannot be set by a client on the public route.** Cloudflare sets it when no
  Worker subrequest is involved (verified). The gateway forwards the request unchanged
  (`forward`). viz-control has no route of its own and `workers_dev` is false outside a stage
  (`configure.mjs:160`).
- **Address parsing.** IPv4-mapped addresses map to IPv4, in both dotted and hex forms, through the
  WHATWG URL parser. Unparsable input goes to a fixed shared key, never one the client chooses.
- **Fail-open.** No request content can make `limit()` throw: the key may be any string and
  `delta` is not used. The binding fault is not attacker-inducible. Nothing that must fail closed
  fails open: the tag and layer 2 do not depend on the bindings.
- **Layer 2 is exact.** The count and the spend share one transaction (`ops-oauth.ts:406-445`). A
  grant has one code and at most one unrotated refresh token at a time, so concurrent refreshes
  cannot pass the check together. A second use of the same token is reuse and ends the grant
  (m-4 of the D44 review, unchanged). Further:
  - reuse detection runs first;
  - a refused refresh writes nothing and does not rotate (their test, and the reviewer's reading);
  - `Retry-After` is exact;
  - the window slides;
  - rotated rows are kept a day by both the refresh path and the sweep, so the count cannot be
    undercut;
  - no state locks a client out for longer than the window it keeps filling.
- **Nothing is acknowledged and then dropped.** Every refusal happens before any read of state or
  any write. A 429 at revocation says "Nothing was revoked."
- **The contract is additive.** The previous control Worker answers an unknown `TokenResult` status
  with 503 `temporarily_unavailable` (`25321c4:control/src/oauth-http.ts:306`). The TS SDK maps
  that to `TemporarilyUnavailableError` and keeps its credentials. The previous viz-mcp answers an
  unknown introspection status with a retryable 503 (`mcp/src/auth.ts:125`). This meets
  COMPATIBILITY.md §4 ("new statuses that callers already fail closed on").
- **The TS SDK statements are verified.** `too_many_requests` maps to `TooManyRequestsError`,
  which is re-thrown with credentials kept. An unknown code maps to `ServerError`, which leads to a
  new authorization. `invalid_grant` makes the SDK discard its tokens.
- **The binding-page statements are verified.** These hold as D70 states them: a refused call does
  not count; counting is per location and approximate; the period is 10 or 60; `namespace_id` is
  account-wide; IP keys are advised against; the page gives no price.
- **The measured numbers trace to the README cost table.** D70's 0.18–0.41, 0.23–0.52, 0.16–0.33,
  4.3–8.4, 0.9–1.5, 0.75–2.1, 2.1–4.0 and 0.62–0.99 ms all appear there as ranges across runs. The
  modelled $1 a day per grant at 1 a second and $0.10 a day at the cap check out arithmetically.
- **Their D70 suites pass in the reviewer's copy**: `ratelimit.test.ts` and `oauth-cost.test.ts`,
  13 of 13.

## Reproduction index

All runs were in
`/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-d70/`, a copy of
`control contracts dashboard edge janitor mcp ruler shard ledger` taken at `e11e648`, with
`node_modules` symlinked to the shared tree. The test harness is the one in
`control/test/ratelimit.test.ts`: miniflare's Rate Limiting bindings with source 5, client 3,
tenant 6, bearer 3 and bearer-tenant 5 per 60 s.

**Commands and results**:
- `cd rv-d70/control && npx vitest run test/review-d70.test.ts --maxWorkers=2 --reporter=verbose`
  gave 7 of 7. Every test asserts the *vulnerable* behaviour and passed, so each attack works.
  Output is in `rv-d70/run-review.txt`.
- `npx vitest run test/ratelimit.test.ts test/oauth-cost.test.ts --maxWorkers=2` gave 13 of 13.
  Output is in `rv-d70/run-d70-suites.txt`.
- `npx tsc --noEmit` was not clean in the copy. The only errors come from `janitor/` importing
  `compact/` and `publisher/`, which were not copied (`publisher/` is mid-edit by another builder).
  There were none in `control/src` or in the review test.
- The full control suite and the mutation run were **not** rerun.

| Id | Finding | Test (`rv-d70/control/test/review-d70.test.ts`) | Output |
|---|---|---|---|
| R1 | B-1 | "one dead refresh token + made-up client ids spends the whole tenant budget…" | attacker `[400×6]`, 6 object requests; victim refresh 429 "Too many token and revocation requests for this tenant." |
| R1b | B-1 | "a dead credential + the victim client's id spends that client's own allowance" | victim refresh 429 "Too many token requests from this client for this tenant." |
| R2 | B-1 | "one dead access token, sent to /oauth/revoke 6 times…" | attacker `[200×6]`; victim refresh 429, victim revoke 429 "Nothing was revoked." |
| R3 | B-1 | "two dead access tokens (3 + 2 checks) refuse every live token of the tenant" | dead tokens `inactive×5` (each reached the object); live token `{v:1,status:'rate_limited',retryAfterMs:60000}` |
| R4 | M-1, m-4 | "every cross-zone Worker subrequest arrives as 2a06:98c0:3600::103…" and "a request without CF-Connecting-IP shares the key none" | key `v6:2a06:98c0:3600:0::/64`; a genuine refresh from it is 429 "from your network" after 5 registrations; the 6th header-less request is 429 |
| R5 | m-1 | "with limiters that never answer, a refresh waits about 3 s…" | `refreshMs` 3035, `introMs` 2005 |
| SDK-py | B-1, m-3 | read only: the PyPI `mcp` 2.3.0 wheel, `mcp/client/auth/oauth2.py:533-537, 618-620` | any non-200 refresh calls `clear_tokens()`, then a full re-authorization |
| M-2 | M-2 | read only: `deploy/lib/secrets.mjs` `GENERATED_SECRETS`, `deploy/configure.mjs:49,144`, `deploy/gateway/src/index.ts:94,103`, `control/src/ratelimit.ts:73` | not run |

Unreproduced and labelled as such:
- m-4's same-zone spoof (documented behaviour; no such Worker was looked for in the account);
- M-1's broker aggregate, m-5, m-6 and m-7 (modelled);
- anything on Cloudflare itself (no call was made).

## Row for design/REVIEW.md's index

| `reviews/d70.md` | Rate limits in front of OAuth (D70): the Rate Limiting binding keys (source, client, tenant, bearer, bearer tenant), failing open, the exact per-grant refresh limit, the `too_many_requests` / `rate_limited` refusal, on the development branch at `3cbabb8` | 1 blocker (B-1: anyone holding one dead credential of a tenant spends its tenant-wide budgets — the per-client key is the unverified presented `client_id`, revocation has no narrower key, tags never expire — denying all its agents token refresh, revocation and `/mcp` in a location at 5 req/s (50 for `/mcp`), and Python-SDK clients then discard their tokens; reproduced), 2 majors (M-1: the source limit counts genuine credentials and every Worker-hosted MCP client shares `2a06:98c0:3600::103`, reproduced at unit level; M-2: "required before public exposure" is enforced nowhere and a release turns OAuth on without layer 1), 8 minors (m-1: 3 s/2 s added per request during a limiter brownout, reproduced; m-2: absent bindings fail open silently despite "it logs"). Layer 2 (exact per-grant limit), the refusal shape for the TS SDK, the contract's additivity and the measured numbers held | Open |

## Dispositions (2026-11-19, by the builder of the fixes)

D70 was rewritten (`design/DECISIONS.md`; it says it replaces the first version), and D44 was
amended for the credential format. The code is in `control/src/{ratelimit,oauth-http,introspection,
oauth,ops-oauth,index}.ts` and `contracts/oauth.ts`. The review's reproductions are turned into
regression tests in `control/test/ratelimit-review.test.ts`, in which the victim is served. Against
the code this review read, 8 of its 12 tests fail. The 4 that pass there are:
- the review's own R3 numbers, now below the fuse, which the change of ratio fixes;
- the header-less key, recorded and not changed;
- the two release skews.

Against the fixed code, all 12 pass. Mutants of each fix were run on a scratch copy
(`control/README.md`, "Mutation checks" 114–135 and 146–165): 42 of 42 killed. In the first run
40 of 41 were killed: the survivor, "no grace", exposed a test that derived its inputs from the
constant under test, and was killed once that test was fixed; one mutant was added after the run
began and run on its own. The full control suite passes, 183 of 183, with `tsc` clean, and `mcp/`'s
`tsc` and its OAuth suite, 15 of 15. Nothing was run on Cloudflare.

- **B-1, fixed** (no format version; a layout of version 1). The measures:
  - **Expiry in the credential.** Codes and tokens carry their expiry in the 27 characters before
    the tag (`contracts/oauth.ts`, layout 2: marker, expiry in minutes, 22 random characters). The
    Worker refuses one past it before any limit and any object, at the token endpoint, revocation and
    introspection.
  - **The credential first.** The narrow key on token and revoke is the presented credential itself
    (`OAUTH_RL_CREDENTIAL`, a SHA-256 prefix), asked first. There is no per-client key: a verified
    one would still be spent with a public client id (R1b).
  - **Fuses.** The tenant keys stay as fuses near one object's measured capacity: 6,000 and 30,000
    a minute proposed, against 300 and 3,000.
  - **What a dead credential can spend now.** One spends at most its own allowance of a fuse.
    Spending a fuse takes 1,200 (token) or 25 (introspection) distinct unexpired credentials.
  - **Old credentials.** Previous-release (layout 1) credentials are served until they expire. The
    previous release's checks accept layout 2 (both skews tested).
  - **The negative cache was not built**: D70 alternative (i) says why. The residual is a client the
    tenant approved farming credentials, in D70 and the README's Known risks.
  - **Regression evidence**: R1, R1b, R2 and R3 (expired tokens) are tests in which the victim is
    served.
- **M-1, fixed.** Token and revoke count a network only for requests they refuse by themselves (no
  credential with the tag, malformed, or expired), after reading them. A genuine credential is never
  counted by network.
  - Registration and the authorization page keep counting before the body. They do not count
    `2a06:98c0:3600::103` at all: verified on the headers page, 2026-11-19, modified 2026-11-15.
  - Brokers' egress and the Workers address are recorded in D70 and Known risks.
  - Regression evidence: R4 is a test in which a genuine refresh from the Workers address, and from
    a network whose budget made-up credentials spent, is served.
- **M-2, control side fixed; the gate is still a deploy change.**
  - An absent or failing binding is logged once per isolate.
  - `/healthz` lists each limiter (`bound`, `absent`, `skipped`) and whether `OAUTH_CLIENT_KEY` is
    set.
  - The gate is restated precisely in `control/README.md`, "Needed changes elsewhere" 3: configure
    refuses a production viz-control config without the six bindings; `lib/secrets.mjs` refuses to put
    `OAUTH_CLIENT_KEY` on such a version; a stage may skip only with a flag; tests listed. It is needed
    before any production release that carries `OAUTH_CLIENT_KEY`.
- **m-1, fixed.** One 100 ms budget per request, and a failed binding is skipped by the isolate for
  10 s.
  - Measured here (local workerd, limiters that never answer): refreshes 105, 129 and 14 ms;
    introspections 104, 105 and 2 ms; against 3,035 and 2,005 ms before.
  - `limit()` latency on Cloudflare is still unmeasured.
- **m-2, fixed** with M-2. The `namespace_id` collision stays with the deploy's id allocation (Needed
  changes 2).
- **m-3, corrected.**
  - "A refusal spends nothing" now says the narrower keys asked before it have counted the request.
  - A preflight of the authorization page is no longer counted (tested), and neither is a method an
    endpoint does not serve.
  - The "bypassing route" sentence now names a same-zone Worker's `x-real-ip` and a service binding.
  - The SDK sentence says the Python SDK discards tokens on any non-200 refresh.
- **m-4, recorded.** Neither the gateway nor control reads `x-real-ip` (checked). A same-zone Worker
  can still choose the source key, and so evade or spend a chosen network's registration and
  authorization budget. Since M-1 it cannot refuse a refresh. Internal service-binding callers share
  `none`. Both are in D70 and Known risks.
- **m-5, fixed.** Proposed per-token limit 1,200 a minute (20 a second). The bearer fuse is 30,000
  a minute: 10 times 50 grants at 1 a second.
- **m-6, fixed.** IPv6 is also counted per /48 (`OAUTH_RL_SOURCE_48`, 1,200 a minute, after the
  /64), tested.
- **m-7, fixed in D70**: 3,300 row writes a minute per tenant, about 4.75 million a day, about $4.75
  a day, and 432,000 rotated rows kept a day.
- **m-8, fixed on control's side.**
  - D70 and the README state the assumption.
  - A control test fails if `control/wrangler.jsonc` or `mcp/wrangler.jsonc` sets `placement`.
  - A configure check is a deploy needed change (4).
