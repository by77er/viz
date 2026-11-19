# Re-review: D70, rate limits in front of OAuth (round 2)

This is the adversarial re-review of D70 as rewritten after its first review
(`design/reviews/d70-rate-limits.md`). It was written on 2026-11-19 by the reviewer of round 1,
in the same role. The author's dispositions were used only to find where the changes are, and each
fix was checked against the code. Everything was reproduced in a scratch copy. Nothing in the
shared tree was changed. No Cloudflare call was made.

## Scope

- **Commit**: `122229b` ("control: D70 rewritten after its review; credentials carry their
  expiry"). The source changes reached the branch through earlier snapshots, so the review read the
  diff `3cbabb8..122229b`. When the copy was taken, HEAD was `e5b2361` and `control/` and
  `contracts/` matched `122229b`.
- **Files read**:
  - `contracts/oauth.ts`: layout 2, `CREDENTIAL_LAYOUT`, `credentialExpiresAt`, `BASE62`;
  - in `control/src/`: `ratelimit.ts` (all of it), `oauth.ts` (`expiryChars`, `mintCredential`,
    `credentialExpired`, `credentialTagValid`), `oauth-http.ts` (`refusedHere`, `token`, `revoke`,
    `serveOAuth`), `introspection.ts`, `index.ts` (`/healthz`), `ops-oauth.ts` (minting with
    expiry, approval order), `tenant.ts` (`invoke` ordering of `now` and `prepare`), `util.ts`
    (`randomId`);
  - `control/test/ratelimit-review.test.ts` and the previous-release fixture;
  - D70 in `design/DECISIONS.md` (line 3057 onward);
  - in `control/README.md`: "Needed changes elsewhere";
  - the `mcp/src` mapping of `rate_limited`;
  - `deploy/configure.mjs`, to see whether the gate or `ratelimits` was added. Neither was.
- **External sources**: the round 1 sources stand. The Cloudflare headers page and binding page were
  checked against D70's quotations and agree.
- **Runs**:
  - the author's D70 suites (`ratelimit`, `ratelimit-review`, `oauth-cost`, `http`) passed 36 of 36
    in the copy;
  - the full control suite, the mcp suite, `tsc` and the mutation run were **not** rerun.

## Findings by severity

Counts: **0 blockers, 3 majors (2 new, 1 carried open from round 1), 4 minors, 2 nits.**

### R2-M1. A fault in a narrow binding leaves the fuse asked alone, so one credential spends the tenant's fuse again — **reproduced** (N2, N2b); fix tried as a counterfactual

**Where**: `control/src/ratelimit.ts:153-157` (`firstRefusal`) and `:121-150` (`check`, with the
10 s `skipUntil`).

**What happens.** When `OAUTH_RL_CREDENTIAL` (or `OAUTH_RL_BEARER`) is `unchecked`, `firstRefusal`
goes on and asks the tenant fuse alone. That happens in three cases:
- it threw, rejected or ran out of the 100 ms budget once in this isolate, after which it is
  skipped for 10 s;
- it is unbound;
- its answer was malformed.

This is exactly the first version's configuration that B-1 was about. One dead but unexpired
credential is then counted only against the fuse:
- a rotated or revoked grant's refresh token, which the Worker treats as alive for 30 days;
- or an access token less than an hour old.

**Reproduced.** One timeout or one throw of the credential binding, then one dead refresh token
sent 13 times, spends the tenant fuse (12 in the tests). The tenant's live client is then refused:
429 "Too many token and revocation requests for this tenant". The same holds at introspection: one
throw of the bearer binding, then one dead access token, and every live token of the tenant gets
`rate_limited`.

**Failure scenario.** The fuse counter is shared by every isolate in a location, but the skip is
per isolate. An attacker sends one dead refresh token continuously; normally the credential key
refuses it after 5 a minute. Any isolate in that location whose credential check exceeds the
budget once then counts the flood only against the fuse for 10 s. At 100 requests a second, that
trips the location's fuse for up to a minute. Every live refresh and revocation of the tenant in
that location is refused, and Python-SDK clients discard their tokens. So sporadic latency spikes
in any isolate turn into tenant-wide denials. How often `limit()` exceeds 100 ms on Cloudflare is
unmeasured (D70 names that experiment).

The deploy gate (unbuilt) would require all six bindings. That removes the "unbound" case, but not
the skip after a fault.

**Fix, tried.** In `firstRefusal`, stop when a narrower key is `unchecked`, so the chain fails open
together. Applied to the scratch copy:
- N2 and N2b no longer reproduce: the victim is served;
- every `ratelimit-review` test passes;
- two `ratelimit.test.ts` tests fail, because they assert the current semantics that the fix
  changes: "each binding is logged once" in the absent case, and "the next binding … is tried by
  the next request".

A mutant should go with it.

### R2-M2. Farmed refresh tokens give a 30-day lever on the token fuse that survives revocation — **reproduced** (N1, N1b); the author's residual, with a false justification and a wider adversary

**Where**:
- `control/src/ops-oauth.ts:459-461`: a refresh token carries `now + 30 days`, and rotation cannot
  shorten that;
- `ratelimit.ts:261-262`;
- D70, "What an attacker can still do", first bullet.

**What was verified.**
- **Farming works.** An approved client rotated its refresh token 3 times, keeping all 4 tokens.
  A person then revoked the grant through the control API. All 4 tokens still read as unexpired
  (`credentialExpired(t, now + 29 days)` is false). Sending each 3 times spent the fuse, and the
  tenant's live client could neither refresh nor revoke (N1: 429, 429). At the proposed limits that
  takes 1,200 tokens, which is 3 h 20 min at layer 2's cap. It works from one address, because
  genuine credentials are no longer counted by network (the M-1 fix).
- **D70's justification is false for the token fuse.** D70 says "while approved it could spend the
  fuse with live tokens anyway". That holds for the bearer fuse: 25 live access tokens, about
  4 minutes of refreshes. It does not hold for the token fuse. A live client has one unrotated
  refresh token per grant, which is 5 requests a minute against a 6,000 fuse. The token-fuse lever
  exists *only* through a stockpile, and it outlives revocation by 30 days.
- **Not only an approved client can farm.** Anyone holding one live refresh token of an *idle*
  grant can farm too, for example from a client vendor's token store. They rotate it at the cap.
  When the owner returns, reuse detection ends the grant, but the thief's stock stays usable
  (N1b: the victim was refused). Python-SDK clients refresh only when used, so idle grants are
  common.
- **There is no per-tenant remedy.** A tenant whose fuse is being tripped can only wait 30 days.
  Otherwise the operator rotates `OAUTH_CLIENT_KEY`, which ends every tenant's grants, and every
  person approves again. Nothing records that a grant refreshed at its cap for hours, which is the
  only visible signature of farming.

**What should change.** One of the following, or the owner's explicit acceptance of the residual
as corrected here:
- **(a) A KV list of dead refresh tokens.** When the object answers `invalid_grant` to a tagged,
  unexpired refresh token, write its hash to `CONFIG` with `expirationTtl` equal to its remaining
  life, and refuse listed hashes before any limit.
  - On the refresh path every `invalid_grant` means the token is permanently dead: row missing,
    rotated (the grant ends), expired, grant not issuable, or wrong client (the grant ends).
    Listing is therefore safe.
  - A stock of 1,200 tokens costs 1,200 writes once (about $0.006 at list price, training
    knowledge). Each token request pays one KV read; refreshes happen about once an hour per
    client.
  - D70's alternatives (i) and (j) considered the Cache API and isolate memory, but not KV.
- **(b) A per-tenant "not before" in KV,** compared with the issue time the encoded expiry already
  implies (expiry minus the kind's lifetime). It is set by a person as an emergency remedy that
  ends that tenant's credentials only.
- **In any case:**
  - correct the token-fuse sentence in D70;
  - add the thief-of-an-idle-grant variant;
  - record in the grant view, or as a metric, that a grant hit its refresh cap repeatedly.

### M-2 (carried from round 1). The deploy gate is still not built — verified by reading

Control's side is done and was verified:
- an absent or failing binding is logged once per isolate (`ratelimit.ts:94-100,124,145`);
- `/healthz` lists each limiter and whether `OAUTH_CLIENT_KEY` is set (`index.ts`);
- the README restates the gate in "Needed changes elsewhere" 3, now for six bindings, with
  `secrets.mjs` refusing the key as defence in depth.

`deploy/configure.mjs` still has no `ratelimits` key and no gate, and `deploy/lib/secrets.mjs`
still generates the key. Nothing reads the new `/healthz` lines: the gateway reads only the status.
A production release today still turns OAuth on without layer 1.

The exposure is less harmful than in round 1: made-up and expired credentials still reach no
object, and layer 2 bounds writes. But it remains "required before public exposure" and is
unenforced. It must be done before any production release that carries `OAUTH_CLIENT_KEY`.

### Minors

**m-1. The shared budget blames the wrong binding — reproduced (N3).**
In `ratelimit.ts:129-145`, when a slow narrow check uses most of the 100 ms, the next binding gets
the remainder as its timeout. When that times out, it is logged "failed", shown `skipped` by
`/healthz`, and skipped for 10 s, even though it answered in 30 ms.

N3 calls `limitCredential` with stub bindings:

| Credential check | Tenant check | Result |
|---|---|---|
| 80 ms | 30 ms | tenant `skipped`, credential `bound` |
| 60 ms | 60 ms | same |

The fuse is then off for 10 s (the safe direction), but diagnostics point at a healthy binding.
Recommended:
- treat "the request's budget ran out" as `unchecked` without a skip or log for that binding;
- skip only a binding whose own call exceeded a fair share.

**m-2. A genuine but expired credential is counted against the network — modelled.**
`oauth-http.ts` `refusedHere` counts a credential that carries the tag but has expired. Consider a
broker whose egress presents more than 120 such tokens a minute: users idle past 30 days, plus its
malformed requests. Those requests get 429 instead of `invalid_grant`. The TS SDK keeps a dead token
on `TooManyRequestsError` and retries, instead of reconnecting, until the count drops. Recommended:
answer a tag-verified expired credential with `invalid_grant` uncounted, since its HMAC is already
paid, or count it on its own key.

**m-3. Nothing protects the rollback floor once OAuth is public — not reproduced; from reading.**
Rolling viz-control back to `3cbabb8` or earlier would do two things:
- mint layout 1 credentials again, with no expiry the Worker can see, so dead access tokens and
  codes count for ever;
- restore the first version's keys, which brings B-1 back.

No such release ran in production. Once OAuth is public, D69's rollback floor for viz-control should
be at least this release.

**m-4. Two locations at the bearer fuse can saturate one object — modelled.**
Per location, the bearer fuse is 45–75% of one object's measured introspection rate. An approved
client with 25 live access tokens (about 4 minutes of refreshes) in two locations can therefore keep
the tenant's object, and its control plane, busy. D70 (h) says the fuses protect the control plane;
that is true only against a flood in one location. The text should say so. The same holds for the
token fuse at 5 or more locations.

### Nits

- **n-1.** "Their senders pay for their own Worker requests" (D70, Workers address) is imprecise.
  One Worker invocation can make many subrequests (training knowledge), so one paid request can
  become many billed gateway requests. The source limit never saved the request charge, so the
  real cost of the exemption is CPU, as D70 says elsewhere.
- **n-2.** The budget is measured with `Date.now()`, which in Workers advances only at I/O. In an
  instrumented full-path run here, a check reported 127 ms elapsed while its 100 ms timer had not
  fired. The cause is inferred to be a clock that had not advanced since the previous I/O. The
  effect was benign: the fuse was `unchecked`. Production gaps between I/O are sub-millisecond, so
  this is a note for the Cloudflare latency experiment, not a fix.

## Verdict for D70 (round 2)

**Approve with changes.** B-1 as reported is closed, and M-1 is closed. The credential format change
is sound. Before public exposure:

1. **R2-M1**: wider keys are asked only while every narrower key was checked, with a test and a
   mutant. Update the two `ratelimit.test.ts` expectations that encode the current semantics.
2. **R2-M2**:
   - correct D70's token-fuse justification;
   - add the thief-of-an-idle-grant variant and the "no per-tenant remedy" consequence;
   - then either build the dead-refresh-token list (KV, (a)) or a per-tenant not-before (b), or
     record the owner's explicit acceptance of the 30-day residual;
   - record farming in the grant view or a metric.
3. **M-2**: the deploy gate (and `ratelimits` in configure) before any production release that
   carries `OAUTH_CLIENT_KEY`.
4. Minors m-1 to m-4 are tracked in `control/README.md`; the nits are optional.

## What was attacked and held

- **Forgery.** The tag is HMAC-SHA-256 under an HKDF key from `OAUTH_CLIENT_KEY`. It covers the
  whole body, expiry included, and is compared in constant time (`oauth.ts` `credentialTagValid`,
  `sameString`). It has 16 characters, about 95 bits. Nothing changed here.
- **Expiry tampering.** The expiry cannot be changed without the key. At `/oauth/token`,
  `/oauth/revoke` and introspection, the tag is checked before the expiry is decoded.
- **Random part.** 22 characters from `randomId`, which uses rejection sampling with no modulo
  bias, give about 131 bits. Together with the tag this meets RFC 6749 §10.10.
- **Expiry never earlier than the object's.**
  - Access and refresh tokens are minted with the same `now` that their rows get.
  - A code's encoded expiry is taken in `prepareApprove`, after `invoke` took `c.now`, so the
    stored expiry is the same or earlier.
  - Rounding up to the minute and the 60 s grace absorb a Worker clock up to a minute ahead.
  - A Worker clock behind only sends an expired credential to the object, which refuses it.
- **Release skews.**
  - The previous release accepts layout 2: the shape and tag are unchanged, and its fixture test
    passes in the copy.
  - This release serves layout 1 until it expires (tested).
- **The `e` marker ambiguity.** The arithmetic checks out:

  | Point in time | Minutes since the epoch | Share of the 62^4 range | Chance a layout 1 credential is refused early |
  |---|---|---|---|
  | Today | 26,700 | 0.18% | about 1 in 34,000 (× 1/62) |
  | A month on | about 69,000 | — | about 1 in 13,000 |

  It cannot be steered: the first character is under the tag. No layout 1 credential exists in
  production.
- **B-1 as reported in round 1.** R1, R1b, R2 and R3 no longer reproduce. The author's regression
  tests (`ratelimit-review.test.ts`) pass in the copy.
  - Dead codes die in the Worker within 12 minutes and dead access tokens within about 62 minutes.
    Made-up client ids no longer matter.
  - Revocation counts the token first.
- **M-1.**
  - `limitSource` is reached at `/oauth/token` and `/oauth/revoke` only through `refusedHere`, so a
    genuine credential is never counted by network.
  - `WORKERS_EGRESS` is matched exactly and not counted.
  - IPv6 is also counted per /48.
  - Only the method each endpoint serves is counted, so preflights are not.
- **Round 1 m-1.** A brownout costs at most about 100 ms a request; the N3 probe confirms the budget
  in isolation.
- **Round 1 m-2.** Logging is once per isolate, and `/healthz` lists the limiters.
- **Round 1 m-8.** A placement test exists. It checks the components' own `wrangler.jsonc`; the
  deploy-side check is a needed change.
- **Layer 2** is unchanged and still exact.
- **Fuse arithmetic.** 6,000/5 = 1,200 credentials; 30,000/1,200 = 25; 1,200/6 = 200 min; 25/6 is
  about 4 min. The token fuse is 20 times the live tenant maximum of 300 a minute. The 8–21% and
  45–75% object shares follow from the measured 0.75–2.1 ms and 0.9–1.5 ms. No live client trips
  either fuse.
- **mcp.** `rate_limited` maps to 429 with `Retry-After` (committed). A 429 at `/mcp` does not make
  either SDK discard tokens: Python re-authorizes only on 401 or `insufficient_scope`.

## Reproduction index

All runs were in
`/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-d70-r2/`, a copy of
`control contracts dashboard edge janitor mcp ruler shard ledger` with `control/` and `contracts/`
at `122229b`, and `node_modules` symlinked. The test bindings are those of `vitest.config.ts`:
credential 3, tenant 12, bearer 3 and bearer-tenant 12 per 60 s.

**Commands and results**:
- `cd rv-d70-r2/control && npx vitest run test/review-d70-r2.test.ts test/review-d70-r2-budget.test.ts --maxWorkers=2 --reporter=verbose`
  gave 6 of 6. The tests assert the *vulnerable* behaviour, so passing means each attack works.
  Output is in `rv-d70-r2/run-r2.txt`.
- `npx vitest run test/ratelimit.test.ts test/ratelimit-review.test.ts test/oauth-cost.test.ts test/http.test.ts --maxWorkers=2`
  gave 36 of 36. Output is in `rv-d70-r2/run-author-suites.txt`.
- **Counterfactual for R2-M1.** `firstRefusal` was changed in the copy to return `null` on the
  first `unchecked`, the tests were run (`rv-d70-r2/run-r2-fix.txt`), and then the source was
  restored and diffed equal to the shared tree.
  - N2 and N2b: the victim is served.
  - `ratelimit-review`: all tests pass.
  - `ratelimit.test.ts`: the two tests that encode the current semantics fail.

| Id | Finding | Test | Output |
|---|---|---|---|
| N1 | R2-M2 | `review-d70-r2.test.ts`, "an approved client rotates 3 times (4 tokens), a person revokes its grant…" | stock 4; attacker `[400×12]`, 12 object requests; victim refresh 429, revoke 429 ("…for this tenant") |
| N1b | R2-M2 | "a thief of one live refresh token of an idle grant farms the same way" | owner's return ends the grant (400); victim refresh 429 |
| N2 | R2-M1 | "credential binding hangs once (100 ms budget)…" and "…throws once…" | credential `skipped`; one dead token × 13 spends the fuse; victim 429 |
| N2b | R2-M1 | "bearer binding throws once…" | dead access token: 12 × `inactive`, then the live token `rate_limited` |
| N3 | m-1 | `review-d70-r2-budget.test.ts`, budget probe on `limitCredential` with stub bindings | 80/30 ms and 60/60 ms: tenant `skipped`, credential `bound`; 110/0 and 150/0 ms: credential `skipped` |
| n-2 | n-2 | the same N3 scenario through `worker.fetch`, with `console.log` temporarily added to the copy's `check()` (restored after) | "check OAUTH_RL_CREDENTIAL left 100", "answered … 127" with no timeout |

Not reproduced, from reading: M-2 (carried), m-2, m-3, m-4, n-1.

## One-line update for design/REVIEW.md

In the `reviews/d70-rate-limits.md` row's status column, replace "re-review pending" with:

> Re-reviewed 2026-11-19 at `122229b`: **approve with changes**. B-1 and M-1 closed. The credential
> format change (layout 2 within version 1) held, as did both skews, the marker ambiguity, tag
> coverage of the expiry and clock skew. New majors:
> - R2-M1: when the narrow binding is skipped after one fault (10 s per isolate) or is unbound, the
>   fuse is asked alone and one credential spends it (reproduced; a one-line cascade fix was tried);
> - R2-M2: refresh tokens farmed at layer 2's cap, by an approved client or by a thief of an idle
>   grant's token, trip the token fuse for 30 days after revocation with no per-tenant remedy; D70's
>   "could spend it with live tokens anyway" is false for the token fuse (reproduced).
>
> M-2's deploy gate is still unbuilt. 4 minors, 2 nits. Review in `reviews/d70-rate-limits.md`,
> round 2.
