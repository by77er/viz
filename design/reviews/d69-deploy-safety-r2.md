# Review of the deploy tooling, round 2: the first release over production, the OAuth gate and floor, and the round-1 fixes

The reviewer and the rules are the same as in round 1 (`review-d69.md`):
- read-only on the shared tree;
- everything run in a scratch copy against the repository's own fakes;
- no Cloudflare call, no commit, at most 2 test workers.

## Scope

**Commit read: `2930782`.** `deploy/`, `contracts/`, `design/` and `.github/` are clean in the working
tree. Production is main at `fb77292` (PR #8), deployed on 2026-11-19 with that commit's own tooling.

Read:
- **The round-1 fixes.** The code is in the work-in-progress commits; `3c1a0a6` holds the README and
  REVIEW.md dispositions.
- **The OAuth gate and floor**, in `configure.mjs`, `resources.mjs`, `release.mjs`, `lib/secrets.mjs`,
  `lib/floors.mjs` and the `workers.json` rule `oauth-public` (`serving_below_floor: "forward-only"`,
  D69 point 6).
- **The gateway's `/api/echo` route.**
- **`deploy/test/upgrade-production.test.mjs`** and its fixture, `test/fixtures/production-fb77292.json`.
- **COMPATIBILITY §6**, the README sections on these changes, and the storage migrations in
  `publisher/src/schema.ts` and `shard/src/shard.ts`.

**Setup.** `R2=/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-d69-r2`.
- `git archive 2930782 | tar -x -C $R2/head` and `git archive fb77292 | tar -x -C $R2/prod`, with
  `deploy/node_modules` linked.
- **Baseline.** From `$R2/head/deploy`, `node --test --test-concurrency=2 'test/*.test.mjs'` passed
  **131 of 131**.

**Reproductions.**
- **`test/rv2-upgrade.test.mjs`.** It copies the upgrade test's own harness (the fixture and its
  fb77292 record), then runs the attacks below.
- **`test/rv1-round1.test.mjs`.** This is round 1's file, re-run against this tree. Its stage viz-control
  is marked `--oauth-without-rate-limits`, so that the new key gate does not mask the old scenarios.

**Not done.**
- The vitest suites and `tsc` were not run.
- The authors' mutants were not re-run.
- Per-RPC compatibility of every fb77292 caller with every new callee, across the deferred code update
  of up to 30 s, was spot-checked, not verified in depth (see "Held").

## Findings by severity

**0 blockers, 2 majors, 4 minors.** Round 1's three accepted risks (m-1, m-4, m-6) are listed under
"Held" with their dispositions.

### Majors

#### M2-1. After the first release, no Worker can be rolled back to fb77292, even with `--only`. The refusal rests on `r2.dead-letters`, which fb77292 itself writes at 2 and reads at 1 and 2 — **reproduced**

**Where.**
- `release.mjs` `formatRollbackProblems` (`readers = target.formats ? … : null`): a record without
  formats is "taken to read version 1 of every format".
- `versionsLeftServing`: the Workers a record leaves out are judged as writers.
- `README.md`, "The first release over the 2026-11-19 production", step 1: "A rollback to fb77292's
  record is refused (formats, and the floor)".

**Scenario.** After the first release, a defect shows in viz-query, viz-gateway, viz-mcp or viz-ruler.
None of these Workers has any real barrier back to fb77292:
- no schema crossing;
- no floor, since `oauth-public` names viz-control only and the `signal-data` switch is off;
- no format they cannot read.

Even so, `release.mjs rollback --record <fb77292 or previous.json> --only viz-query` (the workflow's new
`rollback_only`) is refused:
- viz-ingest is left serving and writes `r2.dead-letters` 2;
- fb77292's record has no formats, so its viz-query is "taken to read only 1".

fb77292's ingest wrote that format at 2 and read [1, 2] (`git show fb77292:flush/src/formats.ts`: `'r2.dead-letters': 2`,
`READS … [1, 2]`). The refusal is an artefact of the missing record, not of the code.

The same artefact marks viz-ingest forward-only. So a phase-2 failure anywhere after viz-ingest's
promotion puts nothing back (RV2-2). The re-run release is still forward-only while any fb77292 Worker
serves.

**Consequence.** On the one release that goes over a live system without an automatic rollback, the
per-Worker rollback the owner would reach for is closed for every Worker. The only lever left is a
fix-forward commit through the whole CI. The README says the way back is refused, but not that `--only`
is refused too, nor that the format reason is not real.

**Reproduction.** RV2-1. Four Workers × two targets (fb77292's record and `previous.json`), all exit 3:
```
RV2-1 --only viz-query to release: exit 3
  - r2.dead-letters: viz-ingest is left serving by this rollback (the record does not restore it), and its version …1002 (release rel-a, serving now) writes version 2, and fb7729280d79… reads only 1 (its record predates fo…
```

**Change.**
- Ship fb77292's format reads with this tree, and have rollback use them for that record. For example, a
  supplementary `formats` entry made by this tree's `lib/formats.mjs` from `git archive fb77292`; the
  authors already regenerate fb77292's configure for the fixture.
- Or derive a recordless target's reads from its commit's sources. The rollback job would then need
  `fetch-depth: 0`.

Then only viz-control is held back, by its real `oauth-public` floor. In any case, say in the README's
owner notes that `--only` to fb77292 is refused for every Worker, and why.

#### M2-2. D70's Rate Limiting bindings have never been uploaded to Cloudflare or read back from it, and production is their first contact. If the version API names the id differently, the first release goes out and every later deploy stops — **reproduced against a modelled shape**

**Where.**
- `resources.mjs:70-84` (`rateLimitsOf`: `type === 'ratelimit'`, `namespace_id ?? namespaceId`, else
  throw).
- `rateLimitIdsInUse` reads viz-control itself too.
- `README.md` Known risks: "The Rate Limiting binding's shape in Cloudflare's version API is not
  verified" (it names the experiment, but it was not run).
- `README.md`, "Per-location limits are modelled; none of the six has run on Cloudflare".

**Scenario.**
1. Before the first release, no script on the account binds a rate limit in the unknown shape, so the
   scan passes.
2. The first release uploads viz-control with six bindings and promotes it.
3. Every later `resources.mjs ensure`, which `deploy.sh` runs on every deploy, now reads viz-control's
   own serving version. If the API shows the id under another key (or as something other than digits),
   ensure throws: "whose namespace id cannot be read … none is allocated". **Every later deploy fails,
   including the fix-forward that the forward-only first release depends on.** Only a commit that
   changes `resources.mjs` gets past it.

The other shapes:
- **A type the regular expression `rate.?limit` catches:** the same stop.
- **A type it does not catch:** the bindings are invisible, and collisions with unrelated scripts go
  unseen. viz's own ids stay stable, because allocation is deterministic.
- **Cloudflare refusing the binding at upload** (shape, plan, limit range): phase 1 fails before anything
  is promoted, which is safe. But no production flag skips the gate, so production can take no release of
  this tree until code changes.

**Reproduction.** RV2-5. After the first release, the fake is changed to show `namespace` in place of
`namespace_id`:
```
RV2-5 next ensure: viz-control: a Rate Limiting binding OAUTH_RL_SOURCE whose namespace id cannot be read (undefined): which ids are in use is unknown, so none is allocated
```

**Change.** Before merging to main, run the README's own experiment on a stage:
1. Deploy viz-control with the six bindings: `--stage`, which costs nothing and touches only `viz-`
   names.
2. Read the version back through the API.
3. Record the shape in the README as "measured on Cloudflare", and make the fakes match it.

Independently, when viz-control's own serving version is the unreadable one, its ids could be taken from
the last generated config, or from resources.json, rather than stopping. That keeps fix-forward deploys
possible.

### Minors

#### m2-1. Any script on the account that is not viz's can stop every viz deploy — **reproduced**

**Where.** `resources.mjs:93-113`. Every deploy reads the serving and newest versions of every script on
the account. A rate-limit binding in any of them whose id is unreadable throws, as does any API error
other than 404 that survives the retries.

**Scenario.** The account holds unrelated Workers (AGENTS.md). One of them with an odd binding stops
production deploys, and nothing on viz's side can override it.

**Reproduction.** RV2-4: `someone-elses-app: a Rate Limiting binding L whose namespace id cannot be read
(undefined|"abc") …`.

**Change.**
- Skip, with a loud log, a script that is not viz's and whose binding cannot be read. Treat its readable
  ids as taken, and refuse only when viz's own ids are in doubt.
- Or allow the scan of other scripts to be skipped when viz-control already binds six ids in the range
  that no readable foreign binding names.

#### m2-2. COMPATIBILITY §6 contradicts D69 point 6

**Where.** §6, "A floor raised by a switch": "Every release with the switch on is refused unless each of
them is at its floor in that release and as it serves". `oauth-public` instead goes out
**forward-only** over a viz-control below the floor (`lib/floors.mjs` `floorForwardOnly`, and the
`!(w.now && rule.servingBelow === 'forward-only')` exemption).

The contract was not updated for point 6, which is the same "contracts first" slip that round 1's m-9
recorded. **Change:** add the option to §6, in its own commit.

#### m2-3. Production already issued layout-1 OAuth credentials, so the new reader can expire a few of them early; the contract says none had been issued

**Where.** `contracts/oauth.ts:144-152`: "… about 1 in 13,000 of them could be read as expired early (none
had been issued in production when layout 2 began)". The consumers are `control/src/oauth.ts:182` and
`deadlist.ts:197,219` (`credentialExpiresAt`).

**Scenario.**
- fb77292's viz-control has issued layout-1 credentials since 2026-11-19. Layout 2 reaches production
  with the first release.
- A layout-1 body that starts with `e` (1 in 62) is decoded as an expiry spread uniformly over 28 years
  from 2026-11-01.
- About 1 in 11,600 of them reads as already expired by 2026-12-26 (arithmetic, not reproduced). A
  client whose refresh token is refused that way must be authorised again, by a person.

**Change.** Correct the comment. Either accept the rate, or stop reading a body as layout 2 when the
expiry it decodes is later than the layout's start plus 30 days, which no real layout-2 credential can
exceed.

#### m2-4. M-2's closure rests on an owner setting the repository cannot check, and it is open until this tree is merged

**Where.**
- `.github/workflows/deploy.yml`: both credentialed jobs refuse a ref other than `refs/heads/main`.
- `README.md`, one-time setup, item 1, "Required: the production environment deploys from main only".

**Scenario.** The workflow of an older commit has no such step: fb77292's, which is main's today, and
every branch made before the fix. Until the environment rule is set, dispatching such a workflow on such
a ref deploys with pre-D69 tooling.

**Change.** Have the new workflow read the environment's deployment-branch policy through the API
(`GET /repos/{owner}/{repo}/environments/production`) and fail, or at least warn, when it is not
main-only. That turns the owner step into something checked on every deploy.

## Verdict

**Approve with changes.** The first release over production is not refused, needs no migration
acknowledgement, keeps `OAUTH_CLIENT_KEY`, passes the gate, and goes out forward-only, as the README
says. The storage claims hold. The forward-only floor option cannot be used to walk under a floor. The
round-1 fixes are real.

Before this tree is merged to main and so deployed over production:
- **M2-1.** Give fb77292's record its real format reads, so that the way back is refused only for
  viz-control; at least document that `--only` is closed too.
- **M2-2.** Run the stage experiment that settles the Rate Limiting binding's shape, at upload and when
  read back.

The owner must set the `production` environment rule (m2-4). m2-1 to m2-3 can be tracked.

## What was attacked and held

**The fixture is a faithful model of what fb77292's tooling left.**
- Running fb77292's own `configure.mjs` (in `$R2/prod`, production, `--ids-optional`) gives vars identical
  to the fixture's for all seven Workers; only the release id differs, because I passed the short SHA.
- The migration tags are identical too (viz-ruler [v1, v2], the others v1 or none).
- The versions carry `VIZ_SCHEMAS` and no `VIZ_FORMATS`, `VIZ_FLOORS` or `VIZ_DEPLOY_RUN`; the record has
  schemas and no formats; viz-control has no `ratelimits`.
- fb77292's `lib/secrets.mjs` had no re-read (`readFresh`), so production's first deploy may have hit
  S9's lag and been re-run. RV2-3 models that history: an unkeyed deployed version, a keyed version never
  promoted, and an upload that inherits the key and serves. **The key is still kept**.

**The first release.**
- **No refusal midway.** Every Worker goes as `versions`, so there is no phase-2 put and no refusal after
  promotion.
- **A wrangler failure mid-phase-2 strands a mix** (RV2-2: publisher, ingest, control and query new; the
  rest fb77292). The README's failure table documents this, and deploying again exits 0. The mix is the
  skew COMPATIBILITY allows. I spot-checked it:
  - fb77292's janitor and maintain call `safeToDelete` and `notify`, which still exist on the new
    Publisher;
  - the Tenant object keeps the same nine methods;
  - the credential layout is readable by fb77292's `parseCredential`;
  - `TAIL_READ_VERSION` is 1 on both sides.
- **Smoke failure.** `deploy.sh` does not roll back (FORWARD_ONLY names `r2.dead-letters` and the
  oauth-public floor), the job exits 1, and the new release keeps serving (the authors' test). Fix
  forward is the only way out (M2-1).
- **The key** is kept, with no put, and the gate is not asked for a kept key. A rotation needs
  `VIZ_ROTATE_SECRETS`, which the workflow never passes.
- **Un-deployable?** Not by the tool's own refusals: plan exit 0. It would be only through M2-2's
  Cloudflare-side unknowns.

**Storage migrations (publisher 3→7, shard 1→3).**
- Publisher migrations 4–7 are only `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`.
- Shard migrations 2–3 are `ADD COLUMN` (nullable or defaulted) and a partial index.
- fb77292's shard names its columns in every INSERT. Its only read of the stream table is
  `SELECT * FROM stream`, which tolerates the extra column.
- fb77292's `openSchema` opens storage newer than it knows when its compat is at or below what it knows,
  "never lower the version".
- During the deferred update, an object runs either the old code or the new code. Once the new code has
  migrated it, no tool path puts the old code back: a phase-2 restore only happens before a forward-only
  Worker is promoted, and the rollbacks to fb77292 are refused. A manual rollback would still open it,
  since everything is readable from 1.

**The forward-only option.**
- It applies only when this release's own floor Worker is at the floor. A release whose own viz-control is
  below the floor is refused, and `configure` cannot produce one.
- Once a version with `OAUTH_PUBLIC` is kept, a rollback to an unstamped viz-control is refused.
- It is per rule: `signal-data` keeps `refuse` (the authors' test).
- It cannot walk under a floor; at most it moves a below-floor serving Worker up to the floor.

**Id allocation.**
- It never takes an id a readable script that is not viz's binds (the authors' tests, and RV2-1's state).
- It keeps the id viz-control binds, so ids are stable across releases. Otherwise it is deterministic, so
  it is stable across CI runs with an empty `resources.json`.
- Production and stages never share an id, whether the other's is bound or only recorded.
- It only reads the account; nothing is created.

**The gate.**
- `--oauth-without-rate-limits` and `--oauth-public` are refused for production, in both `configure` and
  `generateWorker`.
- A manifest configured with `--ids-optional` is refused by `release.mjs`.
- `OAUTH_PUBLIC` cannot come from a component or from `VIZ_STAGE_VARS`.
- The key is never put on a config without the six bindings.
- A rollback to a viz-control without them (fb77292's) is refused by the floor.
- The phase-2 restore of the first release is skipped.

No tool path ships a production viz-control without the six bindings. Hand-edited generated configs and
`wrangler` run by hand are outside the tool.

**The gateway's `/api/echo`** is an exact path forwarded to viz-query (Tempo's data-source check).
Nothing else is opened.

**Round 1, checked against this tree** (`rv1-round1.test.mjs` and the authors' `review-d69.test.mjs`):

| Round 1 | Now |
|---|---|
| M-1 (a, b) | **Closed.** RV-1a and RV-1b exit 3, naming `kv.settings` written by the viz-control left serving. |
| M-1 (c) | **Closed.** Configure refuses a deployed Worker without `formats`; an undeclaring serving Worker is taken to read 1. |
| M-2 | **Closed in the repository** (workflow guard; `workflow.test.mjs`). Open until merge and the environment rule (m2-4). |
| m-2 | **Closed.** RV-5 exits 3, and a secret on the writer is refused. |
| m-3 | **Closed.** RV-6 exits 3. |
| m-5 | **Closed.** Exit 1 is now stated, with what serves. |
| m-7 | **Closed.** The upload is re-read until the inherited key shows; `""` means the default; the API timeout is `VIZ_CF_TIMEOUT_MS`. RV-11 still "reproduces" only because my file sets the budget to 0. |
| m-8 | **Closed.** `--only` and `rollback_only`. |
| m-9 | **Closed** (text corrected). §6 now needs point 6 (m2-2). |
| m-1 (the version window), m-4 (the check-then-act race), m-6 (no non-destructive exit) | **Accepted** as Known risks. RV-4 and RV-10 still reproduce; RV-8's refusal now says what lifts it and what does not. |

## Reproduction index

From `$R2/head/deploy`:

```
node --test --test-concurrency=1 test/rv2-upgrade.test.mjs   # 5/5 pass; full output: $R2/rv2-upgrade.txt
node --test --test-concurrency=1 test/rv1-round1.test.mjs    # round 1 re-run; output: $R2/rv1-round1.txt
```

In both files each passing test is a reproduction. In the round-1 file, a test that now fails with exit 3
where 0 was expected shows a closure.

| ID | Finding | Test | Key output |
|---|---|---|---|
| RV2-1 | M2-1 | "RV2-1: after the first release, no Worker can go back to fb77292…" | `--only viz-query` (and viz-gateway, viz-mcp, viz-ruler) to fb77292 and `previous.json`: exit 3, `r2.dead-letters … reads only 1 (its record predates fo…)` |
| RV2-5 | M2-2 | "RV2-5: … every later deploy stops at resources.mjs ensure" | `viz-control: a Rate Limiting binding OAUTH_RL_SOURCE whose namespace id cannot be read` |
| RV2-4 | m2-1 | "RV2-4: a Rate Limiting binding of a script that is not viz's…" | `someone-elses-app: … namespace id cannot be read`, for both shapes |
| RV2-2 | held (stranding) | "RV2-2: a promotion that fails after viz-ingest…" | after the failure, publisher, ingest, control and query are rel-a and the rest fb77292; deploy again exit 0, still forward-only (viz-ingest format) |
| RV2-3 | held (key) | "RV2-3: production … after the S9 failure…" | `secrets: kept`; the same key serves |
| — | fixture | fb77292's `configure.mjs` run in `$R2/prod` | vars identical to the fixture for all seven Workers (only `VIZ_RELEASE` differs) |
| — | m2-3 | arithmetic (`node -e`) | `overall 1 in 11567` early by 2026-12-26 |
| RV-1a/1b, 5, 6, 7 | round 1 closures | `rv1-round1.test.mjs` | now exit 3 (or the new phase-2 message) |
| RV-4, RV-10 | round 1, accepted | `rv1-round1.test.mjs` | still reproduce (Known risks) |

## Update to the design/REVIEW.md index

The row for `reviews/d69-release-floors-formats.md` should append: "Round 2 (2026-11-26, at `2930782`):
0 blockers, 2 majors (M2-1: after the first release over fb77292, no Worker, even with `--only`, can be
rolled back, because of `r2.dead-letters`, which fb77292 itself reads at 2; M2-2: the Rate Limiting
bindings meet Cloudflare first in production, and if the version API names their id otherwise, every
deploy after the first stops at `resources.mjs`), 4 minors; round 1's M-1, M-2 (pending the
environment rule) and m-2, m-3, m-5, m-7, m-8, m-9 closed, m-1, m-4 and m-6 accepted; approved with
changes."
