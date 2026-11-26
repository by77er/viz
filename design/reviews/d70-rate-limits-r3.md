# Re-check: D70, round 2 fixes (round 3)

This is a narrow re-check of the fixes for round 2's findings (R2-M1, R2-M2 and the minors). It
was done by the reviewer of rounds 1 and 2 under the same rules: read-only on the shared tree,
reproductions in a scratch copy, at most 2 test workers, no Cloudflare calls. It was started on
2026-11-19 and finished on 2026-11-26.

**Why severity matters more now.** Production at vis.bitcru.sh is now live from `main` at PR #8,
with OAuth and no rate limits, so this change is next in line for `main`.

## Scope

- **Commit**: `200f235` ("control: D70 round 2 (R2-M1, R2-M2, minors)…"). `control/` and
  `contracts/` are unchanged since then; HEAD was `e90eee1` when the copy was taken.
- **Files read**:
  - `control/src/deadlist.ts` (all of it);
  - the round 2 diffs of `ratelimit.ts` (`firstRefusal`, `check`, `noteAbsent`), `oauth-http.ts`
    (`token`, `revoke`), `introspection.ts`, `ops-oauth.ts` (`revokeToken`, `grantView`),
    `tenant.ts` (`oauthRevoke`) and `index.ts` (`/healthz`);
  - in `contracts/oauth.ts`: `DEAD_INACTIVE_REASONS`, `RevokeResult.dead`, `refreshesLastDay`.
- **Not reviewed**: `deploy/configure.mjs` has an OAuth rate-limit gate, but only as uncommitted
  work in progress by another builder. I read enough to know it exists.

## Findings by severity

Counts: **1 blocker, 1 major (with the same one-line fix as the blocker), 3 minors.**

### R3-B1. A thief can stop reuse detection from firing, so a stolen refresh token keeps its grant alive — **reproduced**; the fix was tried as a counterfactual and works

**Where**:
- `control/src/ops-oauth.ts` `revokeToken`, in the branch where the client does not match: it
  returns `dead = … || (row.kind === 'refresh' && row.rotated_at !== null)`;
- `control/src/oauth-http.ts` `revoke`, which lists the token on `r.dead === true`;
- `oauth-http.ts` `token`, which refuses a listed refresh token before the object is asked.

**How the attack works.** Refresh-token rotation protects against theft (OAuth 2.1 §4.3.1,
RFC 9700 §4.14.2): when the owner later presents a token the thief already rotated, the object sees
the reuse and ends the grant. Round 2 lets a rotated refresh token of a **live** grant be listed
without the grant ending. The steps are:

1. The thief steals the owner's live refresh token T.
2. The thief refreshes with T and receives T2. T is now rotated.
3. The thief sends `POST /oauth/revoke` with T and any `client_id` other than the owner's. RFC 7009
   says that changes nothing, and nothing changes. But the object answers `dead: true`, because T
   is rotated, and the Worker lists T in the isolate and in KV.
4. The owner refreshes with its copy of T. The Worker refuses it as `invalid_grant` before the
   object is asked, so reuse detection never runs and the grant stays live.
5. The owner's SDK discards its tokens on `invalid_grant` and starts a new authorization. A person
   approves again, while the thief keeps rotating T2 for up to 90 days.

**Reproduced.** In `review-d70-r3.test.ts`, "R3-B1":

| Case | Owner's refresh with T | Reached the object | Grant | Thief's next refresh |
|---|---|---|---|---|
| Control, no listing | 400 | yes | `revoked` | 400 |
| Attack, after the probe | 400 | **no** | **`live`** | **200** |

**Timing.** The probe lists T in its own isolate at once and in KV within about a minute (training
knowledge). The thief chooses when to probe, and an owner refreshes about hourly, so the window
favours the thief.

**Severity.** This is a blocker: the change weakens a protection that is in production today. PR
#8's reuse detection works, because it has no list.

**Fix, tried as a counterfactual.** In the branch where the client does not match, count a refresh
token as dead only when it can never come back: expired, its grant revoked or expired. Do not count
it dead for `rotated_at`, because a rotated token of a live grant must keep reaching the object.
Applied in the scratch copy:
- both R3-B1 attack expectations flip: the owner reaches the object, the grant is revoked, and the
  thief's T2 is refused;
- R3-M1 (below) closes too;
- the author's D70 suites pass 66 of 66 with the change.

Two more steps go with it:
- a regression test of the attack, and a mutant that restores the `rotated_at` clause;
- a correction to `contracts/oauth.ts` `RevokeResult.dead`, whose doc says "rotated" counts as dead.

### R3-M1. Revoking under another client id tells an unauthenticated caller whether a refresh token is live — **reproduced**

**Where**: the same branch of `revokeToken`, plus the order in `revoke`: `listedDead` runs before
`limitCredential`.

**What happens.** A token that has been listed is answered 200 and is never counted. A live token
goes to the per-credential limit and gets 429 after its allowance.

**Reproduced.** In "R3-M1", five revocations under another client id:

| Token | Responses |
|---|---|
| Live refresh token | `[200, 200, 200, 429, 429]` |
| Rotated refresh token | `[200, 200, 200, 200, 200]` |

Neither probe changes anything: the grant stays `live` and the live token still refreshes.

**Who gains.** Before round 2, every revocation was counted alike, so there was no signal. A thief
holding a mix of stolen refresh tokens (for example an old backup of a client's token store) can now
sort live from rotated without presenting any of them at the token endpoint. Presenting a rotated
one there would trigger reuse detection and alert the owner.

**Fix.** The R3-B1 counterfactual closes this as well: rotated tokens of live grants are no longer
listed, so both get `[200 × 3, 429 × 2]`. After that fix, a listed token is one whose grant has
ended, and knowing that leaks nothing of value.

### Minors

**m-1. More than 10,000 dead credentials per isolate force a KV read on every request — modelled.**
`deadlist.ts` evicts from `ISOLATE_ENTRIES` (10,000 each for dead and not-listed entries), oldest
first. `listedDead` runs before any rate limit. So an attacker cycling more than about 10,000
distinct dead, unexpired refresh tokens costs one KV read per request, at the attacker's own rate.

That stock takes about 1.2 days at the per-grant cap for one grant (`refreshesLastDay` would show
8,640), or fewer days with several grants. The cost is about $0.50 per million reads on top of the
$0.30 per million Worker requests (list prices, training knowledge). There are no KV writes, because
the reads find the keys.

Recommended: run the per-credential check before the KV read. A listed credential spending only its
own allowance is harmless.

**m-2. One slow KV read switches off the list for the whole isolate for 10 s — not reproduced; KV latency is unmeasured.**
A read over `DEAD_READ_MS` (100 ms) sets `skipReadsUntil` for the isolate. The first read of each
fresh key in a location is a cold read, which KV documents as possibly slow (training knowledge).
An attacker presenting fresh credentials could therefore keep isolates skipping.

While an isolate skips, credentials it has not met fall back to counting once per isolate, which is
the propagation-window behaviour. Isolate memory still applies, so each credential is still counted
at most once per isolate.

Recommended: time out the key alone (treat it as not listed) instead of skipping the whole list, and
measure cold-read latency in the Cloudflare experiment.

**m-3. Inside the propagation window, the residual is real but bounded — modelled.**
In its first minute, a stock reaches the object once per isolate that has not met it. A stock of
1,200 credentials trips a location's 6,000 fuse only if at least 5 isolates there meet the whole
stock within a minute. A single isolate needs a stock of 6,000 (about 16.7 h at the cap). After the
first minute, the global KV record refuses the stock in every location. So the round 2 residual
drops from 30 days to a burst of about a minute per stock, as D70 now states. Record the
five-isolate condition in D70.

## Verdict

**Reject until R3-B1 is fixed. With the one-line fix tried here, plus its test and mutant, approve
with changes.**

- **R2-M1 is closed.** The fuse is never asked alone.
- **R2-M2 is closed** apart from m-1 to m-3, which are bounded.
- **m-1 and m-2 of round 2 are closed.**
- **R3-B1 is new and was introduced by the round 2 fix.** Since production runs PR #8 with working
  reuse detection, this change must not reach `main` until the `rotated_at` clause is removed.
- **M-2 (the deploy gate)** is uncommitted work in progress in `deploy/configure.mjs`, not reviewed
  here. Production at PR #8 already serves OAuth with no limits. "Required before public exposure"
  was not met, and that should be recorded as such, not as pending.

## What was attacked and held

- **No fuse is asked alone (R2-M1).** `firstRefusal` returns at the first `unchecked`, whatever the
  cause: absent, skipped, thrown, rejected, malformed or out of its share. `limitCredential` and
  `limitBearer` are the only callers of the fuses, so the rule holds on every path. For the source
  keys, a failed /64 check also skips the /48 check, which fails open as intended.
- **Per-check share (round 2 m-1).** Each check now gets `CHECK_BUDGET_MS / checks.length` and its
  own timer, so the slow binding is the one blamed. The `Date.now()` arithmetic is gone (n-2).
- **Forging or mixing tenants in list keys.** A key is `oauth-dead:<tenant>:<sha256 of the whole
  credential>`, and the tenant comes from the credential. The tag and the expiry are checked before
  any list read or write, so only minted, unexpired credentials reach the list. Tenant ids contain
  no `:`.
- **Listing a live token at the token endpoint.** Every `invalid_grant` on the refresh grant follows
  a permanent death: no row, rotated (the grant ended), expired, not issuable, wrong client (the
  grant ended), or spent by this request. `invalid_scope`, `invalid_target`, `rate_limited` and
  `schema_too_new` do not list. Codes are never listed.
- **Listing a live token at introspection.** Only `unknown`, `expired` and `revoked` are listed;
  `suspended` and `audience` (the second depends on the caller's resource) are excluded.
- **Listing at revocation.** With the matching client, the token is ended by the call itself. With
  another client, the only non-permanent case is `rotated_at`, which is R3-B1.
- **Write bounds.** One write per credential per isolate (`dead.has`). A credential with less than
  KV's 60 s minimum TTL left is not written. The expiry is absolute and equal to the credential's.
  Writes are off the response path through `waitUntil`. A failed write is logged once and not
  retried.
- **Read bounds.** A live token costs one read per isolate per minute (`notListed`). A dead one costs
  one read per isolate until it expires, short of eviction (m-1).
- **The `dead` field in responses.** The HTTP response to `/oauth/revoke` is `200 null` in every
  case, and the field never leaves control. The only leak is the rate-limit side channel (R3-M1).
- **Release skews.**
  - A previous-release object returns no `dead`; the Worker reads that as unknown and never lists.
  - A previous-release Worker ignores the field.
  - Layout 1 credentials are not listed, because they carry no expiry.
  - The author's skew tests pass in the copy.
- **Nothing new fails open that should fail closed.** Without `CONFIG`, or after a read failure,
  the list fails open and the rate limits and the object still apply. Isolate memory still refuses
  what the isolate has met.
- **The author's suites**: `deadlist`, `ratelimit-review-r2`, `ratelimit-review`, `ratelimit`,
  `oauth-cost` and `http` pass 66 of 66 in the copy, and 66 of 66 with the R3-B1 counterfactual
  applied. An earlier run with the counterfactual showed 4 unrelated failures in timing-sensitive
  tests while the machine's load average was 11; a rerun under the same load passed. The full
  control suite, mcp, `tsc` and mutants were **not** rerun.

## Reproductions

All runs were in
`/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-d70-r3/`, a copy
with `control/` and `contracts/` at `200f235` and `node_modules` symlinked.

**Commands and results**:
- `cd rv-d70-r3/control && npx vitest run test/review-d70-r3.test.ts --maxWorkers=2 --reporter=verbose`
  gave 3 of 3. The tests assert the vulnerable behaviour, so passing means the attacks work. Output
  is in `rv-d70-r3/run-r3.txt`.
- **Counterfactual fix.** The `rotated_at` clause was removed from the branch of `revokeToken` where
  the client does not match, and the source was restored afterwards and diffed equal to the shared
  tree.
  - The R3 attack expectations fail as intended.
  - The author's six D70 files pass 66 of 66 (`rv-d70-r3/run-r3-fix2.txt`).
- **Unmodified copy**: the author's six D70 files pass 66 of 66 (`rv-d70-r3/run-r3-author.txt`).

| Id | Test (`review-d70-r3.test.ts`) | Output (unmodified) | Output (with the fix) |
|---|---|---|---|
| R3-B1 control | "without the listing, the owner presenting its rotated token ends the thief's grant" | owner 400, thief 400, grant `revoked` | same |
| R3-B1 attack | "the thief lists the rotated token with a revocation under another client id…" | probe 200; owner 400 without reaching the object; grant `live`; thief 200 | owner reaches the object; grant `revoked`; thief 400 |
| R3-M1 | "a live token is counted (429 after its allowance); a rotated one is listed and never counted…" | live `[200,200,200,429,429]`, rotated `[200×5]`, grant `live` | both `[200,200,200,429,429]` |

Not reproduced, from reading: m-1, m-2, m-3.

## One-line update for design/REVIEW.md

> Round 3 (2026-11-26, at `200f235`): **reject until fixed**. R2-M1, R2-M2 (bounded residual,
> m-1 to m-3) and round 2's m-1 and m-2 are closed. New blocker R3-B1: a revocation under another
> client id lists a rotated refresh token of a live grant, so the owner's later presentation is
> refused in the Worker and reuse detection never ends the thief's grant (reproduced). R3-M1: the
> same path is an unauthenticated liveness oracle (reproduced). One fix covers both: drop the
> `rotated_at` clause from `revokeToken`'s branch for a client that does not match. It was tried:
> the author's suites pass 66 of 66. Approve with changes once it lands with a test and a mutant.
> The M-2 gate is uncommitted; production at PR #8 serves OAuth without limits.
