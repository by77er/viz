# Final check: D70, round 3 fixes (round 4)

This is a narrow check of the fixes for round 3's findings. It was done by the reviewer of rounds 1
to 3, under the same rules: read-only on the shared tree, reproductions in a scratch copy, at most 2
test workers, no Cloudflare calls. It was written on 2026-11-26.

## Scope

- **Commit**: `4e039b3` ("control: D70 round 3…"). `control/` and `contracts/` are unchanged at
  HEAD `2930782`.
- **What I read** is the diff `200f235..4e039b3` of:
  - `control/src/ops-oauth.ts` (`revokeToken`);
  - `control/src/ratelimit.ts` (`firstRefusal` with its `listed` hook, `LISTED`, `limitCredential`,
    `limitBearer`);
  - `control/src/oauth-http.ts` (`token` and `revoke`);
  - `control/src/introspection.ts`;
  - `control/src/deadlist.ts` (the per-key timeout);
  - `contracts/oauth.ts`;
  - `control/vitest.config.ts`.
- **The scratch copy** is
  `/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-d70-r4/`. It
  holds `control` and its sibling sources at `4e039b3`, with `node_modules` symlinked to the shared
  tree.
- **Context**: production at vis.bitcru.sh runs PR #8. It serves OAuth with no rate limits, no
  dead-credential list and no expiry check.

## Findings by severity

Counts: **0 blockers, 0 majors, 2 minors, 1 nit.**

### m-1. No test in control checks the `ratelimits` block that ships against the source; with the block bound, 18 tests fail, all for reasons of the test setup — **reproduced**

**Where**: `control/vitest.config.ts` (`testWranglerConfig`) and the `ratelimits` block in
`control/wrangler.jsonc`.

**What I did.** I pointed the copy's config back at `./wrangler.jsonc`, so the six production
limiters were bound in every test file, and ran the whole control suite. Out of 210 tests, 18
failed. `settings.test.ts` could not load, because the copy lacked `flush/`; that is an artifact of
the copy. I classified every failure:

| Number | What failed | Cause |
|---|---|---|
| 12 | `register: 429 … from your network` (`oauth.test.ts` and others) | The tests send no `CF-Connecting-IP`, so every registration shares the key `s:none` at 120 a minute. In production the gateway always forwards the header. |
| 3 | 429 where the test expects 400 or 200 (`forged-cost`, `oauth-cost`, `oauth.test.ts` "malformed requests") | Forged and malformed requests with no header are counted against that same shared network key. |
| 1 | 429 where the test expects 200 (`deadlist.test.ts` "one write per dead credential…, however often it is replayed") | It replays one credential more than 5 times a minute; the per-credential limit applies first, as intended since round 3. |
| 2 | `ratelimit.test.ts` (`/healthz`, "absent … logged once") | The tests assert that the limiters are absent. |

**Conclusion.** No real defect is hidden: every failure comes from the test setup or from intended
behaviour. The workaround is sound.

**What is still missing.** Nothing in control checks that the shipped block matches the source:
- its names are exactly `LIMITERS`;
- its periods are `RATE_PERIOD_S`;
- the credential and fuse limits keep the ratio D70 relies on, fuse ÷ credential ≥ 1,200.

The deploy's `configure.mjs` checks names and period, but only as uncommitted work in progress, and
it does not check the ratio.

**Recommended**: a small control test that parses `wrangler.jsonc` and asserts those three facts.

### m-2. While the narrow limiter is down, reads of the dead list are unbounded again — from reading; carried from round 3 m-1, now bounded only conditionally

Since round 3, `listedDead` runs after the per-credential check. So once an isolate's memory evicts
a credential (more than 10,000 entries), the KV reads for it are bounded by that limiter: 5 a minute
per credential per location.

When the credential limiter is `unchecked` (absent, failed, or skipped for 10 s), the list is still
consulted, which is right. But then nothing bounds the reads. An attacker cycling more than about
10,000 dead credentials causes one KV read per request for as long as the limiter is down. This
needs a limiter fault, and a stock that takes days to collect at layer 2's cap. The cost is reads
only; nothing is written.

### n-1. A legitimate client retrying a dead refresh token more than 5 times a minute gets 429, not `invalid_grant`

This follows from the m-1 order (credential limit, then the list), which is what closed R3-M1. The
TS SDK keeps the dead token on 429 and gets `invalid_grant` within a minute. Write it down; no
change needed.

## Verdict

**Approve.** D70's control side is ready for `main`. R3-B1 and R3-M1 are closed. The new order keeps
both R2-M1 (no fuse asked alone) and B-1 (no dead credential spends a fuse). The per-key timeout
cannot keep a listed token unlisted for more than one object request per isolate. The test-config
workaround hides no defect.

Two things fall outside this approval:
- **The deploy side (round 1 M-2)** is uncommitted and was not reviewed. Until the bindings and the
  gate ship, production keeps serving OAuth without layer 1.
- **Merging this is still a net gain**, even without bindings: the expiry check and the dead list
  need only `CONFIG`. PR #8 has neither.

Track m-1 and m-2 in `control/README.md`.

## What was attacked and held

- **R3-B1 is closed. The answer to "does any recording point still list a token reuse detection
  needs to see?" is no.**
  - **Revocation under another client id**: this branch now says dead only for an ended or expired
    grant, or an unrotated token past its expiry. A rotated token of a live grant is not dead, and
    neither is a rotated row past its own expiry.
  - **Revocation by the owning client**: the call itself ends the grant, so the token is dead.
  - **The token endpoint**: it lists on `invalid_grant`, and reuse detection runs before any other
    refresh check, so a rotated token always ends its grant first. The one way a rotated token of a
    live grant gets listed is `issue()` failing to unseal after the same request spent the token.
    That needs damaged sealed data, which no request can cause.
  - **Introspection**: it lists only access tokens, which have no reuse detection.
  - **Reproduced**: with round 3's test run against this commit, the probe still answers 200, but
    the owner's rotated copy now reaches the object. The grant is `revoked` and the thief's next
    refresh is refused.
- **R3-M1 is closed.** Live and rotated tokens revoked under another client id both answer
  `[200, 200, 200, 429, 429]`. A listed token (grant ended) is counted against itself before the
  list is read, so it answers the same way.
- **R2-M1 still holds under the new order.** `firstRefusal` consults the list only after the first
  (narrow) check, and returns `null` before the fuse whenever that check was `unchecked`. A listed
  credential returns `LISTED` before the fuse.
  - Round 2's N2 and N2b now serve the victim: one object request, and the fuse is untouched.
  - In my new test, with the narrow limiter rejecting every call, a listed dead token sent 20 times
    reached the object 0 times and the victim was served. So the list is consulted even while the
    narrow limiter is down.
- **B-1 still holds.** Round 2's N1 and N1b: farmed tokens replayed after revocation each reach the
  object once, and the victim refreshes and revokes.
- **The per-key timeout cannot keep a listed token unlisted.** In my test, KV held the token as dead
  but never answered in time. That cost 1 slow read, 1 object request, and 1 count against the fuse
  in that isolate. After that, the object's answer put the token in the isolate's memory, so it was
  refused without I/O. Replays beyond its allowance got 429. The victim was served.
  - A read that throws is not request-driven, so the whole-isolate skip that remains for throws
    cannot be caused by an attacker.
- **Release skews and fail-open behaviour** did not change since round 3. The author's suites, run
  against the copy as configured, pass 210 of 210. The only failure in that run was
  `settings.test.ts` not loading, because the copy lacked `compact/`; that is an artifact of the
  copy.

## Reproductions

All runs used `--maxWorkers=2`, from `rv-d70-r4/control`. Paths below are relative to the scratch
directory above.

| Run | Result | Output |
|---|---|---|
| Full suite as configured | 210 of 210 tests pass; `settings.test.ts` fails to load (the copy lacked `compact/`) | `rv-d70-r4/run-full-stripped.txt` |
| Full suite with the production `ratelimits` block bound (the copy's config pointed at `./wrangler.jsonc`, then restored and diffed equal) | 18 failures, classified in m-1; `settings.test.ts` fails to load (the copy lacked `flush/`) | `rv-d70-r4/run-full-prodlimits.txt` |
| Round 2 and round 3 attack tests (`review-d70-r2.test.ts`, `review-d70-r3.test.ts`, copied in) | 7 of 8 fail, meaning the attacks no longer work. The 1 that passes is the R3-B1 control case, which expects the grant revoked and still gets it. Logged: R3-B1 owner reaches the object and the grant is `revoked`; R3-M1 both `[200,200,200,429,429]`; N1, N1b, N2 and N2b victims served | `rv-d70-r4/run-prior-attacks.txt` |
| `review-d70-r4.test.ts` | "R4-timeout": statuses `[400,400,400,429×10]`, 1 slow read, 1 object request, victim 200 (passed). "R4-narrow-down": 20 × 400, 0 object requests, victim 200 (failed only because I expected 1 object request; with the list already in KV it needed 0) | `rv-d70-r4/run-r4.txt` |

## One-line update for design/REVIEW.md

> Round 4 (2026-11-26, at `4e039b3`): **approve** (control side). R3-B1 and R3-M1 are closed
> (reproduced: the owner's rotated copy reaches reuse detection again, and revocation answers
> alike). The new order (credential limit, then the dead list, then the fuse) keeps R2-M1 and B-1
> closed, also with the narrow limiter down, and the per-key KV timeout costs one object request
> per isolate. The test config's stripped `ratelimits` hides no defect: 18 failures with the
> production block bound, all from the test setup. 2 minors (no control test ties the shipped block
> to `LIMITERS`, `RATE_PERIOD_S` and the 1,200 ratio; reads unbounded while the narrow limiter is
> down) and 1 nit. The deploy gate (M-2) is still uncommitted, and production at PR #8 serves OAuth
> without limits.
