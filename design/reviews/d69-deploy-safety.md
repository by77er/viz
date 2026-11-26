# Review of D69: format versions, rollback floors raised by a switch, run marks, rollbacks across the OAuth key

Adversarial review. The reviewer did not build D69 and had only what the repository says about its
reasoning. Read-only on the shared tree: everything was run in a scratch copy, against the
repository's own fakes (extended in the copy where noted). No Cloudflare call, no commit, at most 2
test workers.

## Scope

**Commit read: `9958cb3`** (development branch, 2026-11-19). `deploy/`, `contracts/` and `design/` are
identical there to `799ea36` ("contracts/COMPATIBILITY.md: a floor raised by a switch (D69)"); the D69
code itself last changed in `375a21f` and `e11e648`.

Under review:
- `design/DECISIONS.md` D69;
- `contracts/COMPATIBILITY.md` §6, the new bullet "A floor raised by a switch";
- `deploy/README.md`: "Rollback floors", "Rollbacks across the key", "Contract issues", "Known risks";
- code: `deploy/release.mjs`, `deploy/configure.mjs`, `deploy/lib/{floors,formats,schemas,secrets}.mjs`,
  `deploy/workers.json`, `deploy/deploy.sh`, and the workflow that runs them, `.github/workflows/deploy.yml`.

Background read:
- D46, D53, D62–D64;
- `spikes/s9-oauth-key-rollback/README.md`;
- `design/reviews/signals-end-to-end.md` (M-4, m-5);
- `design/reviews/d44-d52-d53-d60.md` (m-9, m-11, m-13);
- the `design/DESIGN.md` paragraphs that cite D69 (lines 323–327 and 793–800).

**Setup.** `SP=/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad`.
- `git archive 9958cb3 deploy contracts design/DECISIONS.md | tar -x -C $SP/rv-d69`, with `node_modules`
  linked.
- `git archive b322599 deploy | tar -x -C $SP/old-b322599`. `b322599` is `0fcdc23^`, the commit before
  D62's `checkSignal`; it is the same pre-D62 tree M-4 used.

Two knobs were added to the copy's `test/fake-wrangler.mjs`:
- `keep: n`, which models Cloudflare keeping only the n newest versions and never drops a serving one;
- `uploadSecretLag: n`, which shows an upload without the secret it inherited for its first n reads.

Both are off by default.

**Baseline in the copy.** `node --test --test-concurrency=2 test/release-checks.test.mjs
test/secrets.test.mjs test/release.test.mjs` passed 54 of 54. With the reproductions added, all 65 pass.

**Not done.**
- `configure.test.mjs` and the vitest suites were not run: the copy has no component sources.
- The authors' mutants were not re-run.
- D69's claim that 23 of 35 tests fail on the pre-D69 tool was not re-run. The test counts it cites
  (14 + 21; 36 new tests = 14 + 9 + 8 + 5) match the files.

## Findings by severity

**0 blockers, 2 majors, 9 minors.**
- Reproduced against the fakes: M-1 (a, b), M-2, m-1 to m-8.
- From the code only, not reproduced: M-1 (c), m-8's rename case, and m-7's wall-clock bound.
- m-9 is text checked against the code.

### Majors

#### M-1. Format rollbacks judge only the Workers the record names, so a partial record (the README's own way round the rotation refusal) leaves readers under a format version a left-out Worker keeps writing — **reproduced**

**Where.**
- `release.mjs:318-333`: `versionsSince` iterates `target.workers` only.
- `release.mjs:554-563`: the formats are judged on that list.
- `lib/formats.mjs:153-161`: `readsOf` intersects only the Workers that declare a format.
- `lib/secrets.mjs:290` and `README.md:247-248`: "Roll back with a record that leaves viz-control out".
- `README.md:466-467`: the tool refuses "when a format version a newer version wrote cannot be read by it".
- `DESIGN.md:796`: "refuses a rollback below the reader of a version written since".
- COMPATIBILITY §6: "T reads every format version any release since T has written".

**Scenario.**
1. Release a: viz-ingest's janitor reads `kv.settings` [1]; viz-control writes `kv.settings` 1.
2. Release b: the janitor reads [1, 2] and control reads [1, 2] (readers first, §3.3).
3. Release c: viz-control writes `kv.settings` 2, and rotates the key. c is not forward-only.
4. A rollback to a:
   - The whole record is refused: the rotation, and `kv.settings` 2.
   - The refusal itself advises a record without viz-control. That record is **accepted**: viz-ingest
     goes back to a janitor that reads only version 1, while viz-control keeps writing version 2.
   - The janitor refuses retention records it cannot read, so retention stops for those tenants
     ("an unreadable retention record expires nothing", `janitor/src/formats.ts`).

The same holds for any format written in one Worker and read in another, such as
`rpc.notification-target` (control writes it, the ruler reads it).

D69 saw exactly this miss and fixed it for floors (alternative (c): "the generic rollback rule judges
versions since the target of the target's Workers, which misses the cross-Worker case of a record
naming only viz-query"), but not for formats.

(c) **Not reproduced, from the code.** A Worker that reads a format without declaring it adds nothing to
`readsOf`; it is not taken to read version 1, so D69's "the side that refuses more" holds only per
release. Examples:
- viz-query, which declares no formats at all, although control's own comment says query reads the
  `kv.*` records;
- edge and shard routing inside viz-ingest, which declare only `kv.settings`.

Such a reader is never consulted when a writer bumps a format, nor when it is itself rolled back.
`README.md:1296-1299` ("Not implemented") admits the undeclared readers and "for whole releases". But
D69's Decision text, the README's Rollback paragraph and DESIGN.md claim the general rule.

**Reproduction.** RV-1a and RV-1b below.
```
RV-1b whole: exit 3
  - viz-rvtest-control: ... it crosses a rotation ...
  - kv.settings: release c (viz-rvtest-control version …113) wrote version 2, and a reads only 1. ...
RV-1b without control: exit 0
rollback to a (review), callers first:
  viz-rvtest-query: back to …105
  viz-rvtest-ingest: back to …102
  viz-rvtest-publisher: back to …101
ok 3 - RV-1b: the README's way round the rotation refusal (a record without viz-control) is the same unjudged rollback
```

**Change.**
- In `rollback()`, add to the versions judged for formats the serving version of every format-bearing
  Worker the record leaves out. Judge each format it writes against `readsOf` over the restored Workers'
  record entries. The record already carries every Worker's `formats`, even when `workers` is filtered.
- Require every deployed Worker to declare what it reads (a `READS` map, or an explicit "reads none").
  Then take an undeclaring Worker as reading version 1, as D69 claims.

#### M-2. "Redeploy an older commit" runs that commit's own pre-D69 tooling, so the floors are not checked on the path the deploy-time floor refusal claims to cover — **reproduced**

**Where.**
- `.github/workflows/deploy.yml:58-62,94-100`: it checks out `github.sha` and runs that commit's
  `deploy/deploy.sh`.
- `deploy.yml:145`: "run this workflow on that commit instead".
- `README.md:488-491` and `:1381`: "after that, go back by deploying an old commit".
- `lib/floors.mjs:182-187`: the "below its floor while the switch was seen" refusal.
- D69 point 2: "(redeploying older code …)".
- `DESIGN.md:325-327`: "from then on no release or rollback may put one of them below it. The release
  tooling enforces both".

**Scenario.** Every commit whose code is below a floor predates D69:
- D62 is `0fcdc23`;
- D63 and D64 came earlier the same day;
- `lib/floors.mjs` was added in `3f8582d`.

With D69's tooling, every release is at every floor: `configure` throws when evidence is missing, and the
publisher is at schema 6. So the refusal at `floors.mjs:182-187` can only fire when current tooling is
handed an old manifest, which is what the tests do. On the path the README prescribes, it cannot fire:
1. The switch is on in production.
2. The operator wants code from before D62. Either the 90-day record artifact expired, or no successful
   run exists.
3. The operator runs the Deploy workflow on a branch at `b322599`.
4. That commit's `release.mjs` has no floors. The migration gate passes, because query's tag was `v1`
   then and is `v1` now. viz-query from before D62 serves.
5. Every metrics read with no series filter fails, for every tenant that sent spans or logs (M-4 of the
   signals review). Nothing refuses.

The same path also skips D69's format and S9 refusals.

**Reproduction.** RV-3, the same fake account and the same manifest for both tools:
```
current tool:
release: REFUSED before uploading or promoting anything:
  - viz-oldtest-query: this release is below its floor (not stamped …) and viz-oldtest-ingest version …103 (release r2) set INGEST_SIGNALS=traces,logs …
old tool: exit 0; release: b322599 promoted.
ok 1 - RV-3: after the switch was on, the current tool refuses a pre-D62 viz-query; the tooling of that commit deploys it
```

**Change.** Any one of these:
- Run the deploy tooling (`deploy/`, and the workflow logic) from the default branch's head, or from a
  pinned tooling commit at or after D69, and take only the components from the target commit.
- Have `deploy.yml` refuse a `workflow_dispatch` deploy of a commit that is not a descendant of the
  floors commit (`git merge-base --is-ancestor`).

Whichever is chosen, correct the README's advice and DESIGN.md's "enforces both" in the same change.

### Minors

#### m-1. The switch's evidence ages out of Cloudflare's version window; "has existed" is really "is among the versions kept" — **reproduced (scaled: keep 4 for 100)**

**Where.**
- `lib/floors.mjs:156-163` (`switchSeen` lists kept versions);
- `README.md:413` ("once a version … has existed");
- COMPATIBILITY §6 ("from the first version with the switch on").

**Scenario.**
1. The switch is turned on in r2 and off in r3.
2. Runs that fail between viz-ingest's upload and viz-query's add viz-ingest versions but no viz-query
   versions. Phase 1 uploads in `workers.json` order, and a control-side SecretRefused stops it there.
3. Once r2's ingest version falls out of the window, a record naming only viz-query is accepted. Its
   target, from before D62, is still kept.

**Reproduction.** RV-4: `RV-4 before pruning: exit 3` / `RV-4 after: exit 0 … viz-rvtest-query: back to …103`.

**Note.** In production every record is at the floors (stamped), so this needs a below-floor version made
by hand.

**Change.** Carry the evidence forward. Once a rule is seen, stamp every later version of every floor
Worker (for example, `VIZ_FLOORS` gaining `seen: ["signal-data"]`), and carry `floors.seenSince` forward
in each record. The evidence then lives as long as any later version does.

#### m-2. Only a `plain_text` `INGEST_SIGNALS` is seen: the switch set as a secret, or as a JSON var, is invisible — **reproduced**

**Where.**
- `lib/floors.mjs:127,159`: `plainVar` reads `plain_text` only. `lib/formats.mjs:125` reads `json`
  bindings too.
- `lib/floors.mjs:227`: at deploy, only the generated config is read.

**Scenario.**
- `wrangler secret put INGEST_SIGNALS` on viz-ingest is a natural "turn it on without a commit". It
  creates and deploys a version, and edge reads `env.INGEST_SIGNALS` as the string it is.
- Secrets are inherited by every later upload, so the switch stays on, unseen.
- A rollback to a release below every floor is then accepted.

**Reproduction.** RV-5: `RV-5: exit 0` (viz-publisher schema 3 restored).

**Change.** Treat a binding of any type named by a rule's `var` as on (a secret's value cannot be read:
on). Refuse a release whose serving writer carries the name as a secret.

#### m-3. At switch-on, a floor Worker that this release does not deploy is not judged, although it serves — **reproduced**

**Where.** `lib/floors.mjs:220-226` (`.filter((f) => manifest.order.includes(f.worker))`) and
`README.md:431` ("A Worker not deployed here … has no floor here").

**Scenario.** A floor Worker set to `deploy: false` keeps serving the version it had. Example: the
publisher, which was `deploy: false` until Trial 3. The switch then goes on over a below-floor reader. The
rollback side judges Workers outside the record; the deploy side does not.

**Reproduction.** RV-6: `RV-6: exit 0; release: r2 promoted`, with viz-query unstamped and serving.

**Change.** Judge `live[floor.worker]` whenever it exists.

#### m-4. Check, then act: a rollback's checks and its restore are not atomic against a deploy that turns the switch on — **reproduced (deterministic interleaving)**

**Where.**
- `release.mjs:553-573`: problems are computed, then `api.restore`.
- `lib/floors.mjs:247-266`.

**Scenario.**
1. `release.mjs rollback` to a record with a schema-3 publisher passes its checks: the switch was never
   seen.
2. A deploy that sets `INGEST_SIGNALS` then passes its own: the serving publisher is at the floor.
3. The deploy completes.
4. The rollback restores the schema-3 publisher. The switch is on.

CI serialises both in `deploy-production`; a laptop run does not (the same premise as m-11).

**Reproduction.** RV-10: `RV-10: rollback exit 0`. Afterwards the serving publisher is at schema 3 and the
serving ingest has `INGEST_SIGNALS=traces,logs`.

**Change.** Re-check the floors (`switchSeen`) immediately before each restore step, and stop if the
answer changed. Or document that local rollbacks must not overlap a deploy.

#### m-5. An m-11 refusal on the `wrangler deploy` path is exit 1 with Workers promoted, not "nothing is promoted (exit 3)" — **reproduced**

**Where.**
- `lib/secrets.mjs:240-244`, raised inside phase 2 (`release.mjs:463-478`), caught and re-thrown at
  `:482-505`.
- Contradicted: D69 point 3 and `deploy.sh:22-24`.

**Scenario.** A new viz-control, or one applying a migration, meets another run between the check and the
put.
- deploy() throws, so the CLI exits 1.
- viz-publisher and viz-ingest are promoted.
- viz-control serves its unkeyed version, so `/oauth/register` answers 503.
- "A Durable Object migration has been applied, so nothing is rolled back".

The README's failure table row "Phase 2, a new viz-control's key could not be put" is right; D69 and
deploy.sh are not. From `secretsNow`, not reproduced: the next deploy inherits the key from the newest
version and recovers.

**Reproduction.** RV-7: `deploy() threw (CLI exit 1): … built on an upload of another run …` / `A Durable
Object migration has been applied, so nothing is rolled back`.

#### m-6. Liveness: "set but missing from the upload" has no non-destructive way out, and the README's remedies do not lift it — **reproduced**

**Where.** `README.md:205-208` ("promote the release that has the key again (`release.mjs rollback
--record` to its record, or deploy its commit)") and `lib/secrets.mjs:202-206`.

**Scenario.**
- The refusal fires only when the newest version lacked the key at upload, since uploads inherit from the
  newest (S9).
- The refused upload then becomes the newest version itself. A rollback does not change which version is
  newest, and redeploying uploads from it again.
- So every later release is refused, even once Cloudflare inherits normally again.
- The only exit the tool offers is `VIZ_ROTATE_SECRETS`: the very invalidation the refusal exists to
  prevent, and which the README says never to use "to make it pass".

**Reproduction.** RV-8: `RV-8 k2: exit 3; rollback to k1: exit 0; k3: exit 3`, and k4 is refused too.

**Change.** On this refusal, make the next upload inherit the key from the keyed version by id. The
README's own citation says the version API's `inherit` binding takes a version, defaulting to "latest";
this is not verified here, and wrangler does not expose it. Otherwise, document that rotation is the only
exit.

#### m-7. The upload is re-read until it exists, not until its inherited key shows; and the re-read is bounded only in its sleeps — **reproduced (modelled lag)**

**Where.** `lib/secrets.mjs:191` (`readFresh(api, worker, current)` with `ready = Boolean(info)`) and
`:197-206`.

**Scenario.**
- S9 saw a fresh version shown without a secret it carried, on a put version. If an upload's inherited key
  lags the same way, the release is refused (exit 3) with a message that invites rotation. The next run
  goes through.
- The bound: `readFresh` caps its sleeps at the budget. But each read is a `cf()` call with up to 4
  retries (7.5 s of backoff), and `fetch` has no timeout (`lib/cf.mjs:35`), so the wall-clock bound is the
  job's 45 minutes.
- `VIZ_FRESH_READ_MS=""`, an unset CI variable, silently gives a 0 ms budget (`secrets.mjs:73-76`;
  `Number("") === 0`).

**Reproduction.** RV-11: `RV-11: exit 3 … does not carry it` (the upload did carry it), then u2 deploys.
`node -e` prints `VIZ_FRESH_READ_MS="" -> 0 ms budget`.

**Change.** For the upload, wait for `has || !known` within the budget before refusing. Give `fetch` an
`AbortSignal.timeout`, and treat an empty variable as unset.

#### m-8. Liveness: with the switch in every release, one floor Worker off its floor as it serves refuses every release; the documented remedy turns ingestion of spans and logs off — **reproduced (rename: not reproduced)**

**Where.**
- `lib/floors.mjs:178-180`: every release with the switch on judges the serving Workers.
- `release.mjs:134-140`: two serving versions give `floors: null`.
- `README.md:501`.

**Scenario.** A gradual deployment of viz-query started by hand (the README: the tooling "refuses nothing
about it"), or a `wrangler rollback`.
- Every push to main is refused (exit 3).
- The README's remedy is "release the Workers at their floors without the switch first", which means a
  commit that turns `INGEST_SIGNALS` off.
- `release.mjs rollback` of that Worker alone, to its last record, is safe and works, but is not
  documented.

**Not reproduced, from the code.** Renaming the rule in `workers.json` would leave every serving stamp naming
the old rule, with the same effect.

**Reproduction.** RV-9: `RV-9 r3: exit 3`, `RV-9 r4: exit 3 … the viz-rvtest-query serving now is below its
floor`; the one-Worker rollback then exits 0, and r5 deploys.

**Change.** Document the one-Worker rollback (or `wrangler versions deploy <stamped>@100%`) as the remedy.

#### m-9. Claims that the code does not bear out (text)

- `release.mjs:44-47` (header): a switch-on release "is refused unless its viz-publisher and the one
  serving now read the span and log tables". This omits viz-query and viz-ingest.
- `README.md:1314-1321` ("Contract issues") still says §6 has no such floor and was "Not edited from
  here". But `799ea36` edited §6, after the implementation; AGENTS.md says "Contracts first".
- COMPATIBILITY §6, the new bullet:
  - "a switch that makes a writer start a format version": D69 (c) rejected modelling it as one, so no
    version is recorded.
  - "every reader of that version": a hand list in `workers.json`.
  - "from the first version with the switch on": the code uses any kept version (m-1).
  - "unless every such reader is at its floor … as it serves": only readers in this release (m-3). The
    code also applies this to every release with the switch on, which is stricter.
- D69 point 1, "formats a release does not declare are taken to read version 1 only … the side that
  refuses more": true per release, not per Worker (M-1 (c)).
- `DESIGN.md:325-327` ("no release or rollback may put one of them below it … enforces both") and `:796`:
  see M-1, M-2 and m-1 to m-4.
- `deploy.sh:22-24` lists "another run's upload under this run's key" among the exit-3 refusals before
  anything is promoted (m-5).
- The README's failure table has no row for "a serving viz-control version that cannot be read"
  (`secrets.mjs:144`, exit 1, nothing changed).

## Verdict for D69

**Approve with changes.** The mechanisms are sound inside the tool:
- per-version evidence in vars;
- refusals before anything moves;
- uploads counted as "seen";
- fail closed on unknown or unstamped versions;
- a run mark checked after the put.

The defects are at the edges D69 itself names as its purpose: other Workers, older commits, and versions
Cloudflare forgets.

Must change before `INGEST_SIGNALS` goes on in production, or before partial records are offered as the
way round the rotation refusal:
- **M-1**: judge the Workers a record leaves out; make undeclared readers count.
- **M-2**: the deploy tooling must not come from the commit being redeployed. Correct the README's advice
  and DESIGN.md.

Fix the text now: m-5, m-9. Track m-1 to m-4 and m-6 to m-8 in `deploy/README.md` "Known risks", m-6
with its real remedy.

## What was attacked and held

**Floors.**
- The switch on, then off, within the window: a later release or rollback below a floor is refused. This
  includes the case where the newest ingest version has the switch off (authors' test, and RV-4's control
  step).
- A switch-on version that was uploaded but never promoted counts, which is conservative.
- A rollback naming only some Workers: the floor Workers it leaves out are judged as they serve, including
  one put below its floor by hand.
- A version without the `VIZ_FLOORS` stamp is below the floor; an unreadable stamp is too.
- Gradual deployments: two serving versions give `schemas`/`floors` null, judged below the floor, so they
  fail closed. A record taken during one has no single version, so it is refused.
- The automatic rollback goes through `release.mjs rollback` (`deploy.sh:140`), so every check applies.
- Phase 2's restore puts back only the serving versions. When the switch is on in the release, the deploy
  check requires those versions to be at the floor.
- **"Every release a rollback could reach = serving + new"** is sound for the tool's own paths, because
  `release.mjs rollback` re-judges against every kept version, uploads included. It does not hold for:
  - `wrangler rollback` or the dashboard (acknowledged);
  - the older-commit workflow (M-2);
  - the version window (m-1);
  - a secret-typed switch (m-2);
  - Workers outside the release (m-3);
  - a concurrent run (m-4).
- A floor raised by schema is judged from `VIZ_SCHEMAS`, which every version since D46 carries;
  `versions secret put` and dashboard edits keep vars.
- `stampedFloors` refuses a declaration without its export. Evidence proves the repository has the export,
  not that the Worker bundles it; acknowledged in "Known risks".

**Formats.**
- Old records without `formats` are taken to read 1: allowed while only 1 was written, refused once 2 was.
- A newer version without `VIZ_FORMATS`, or with an unreadable one, is refused as unknown. Its liveness
  cost is that rollbacks past one hand-made version are blocked for up to 100 versions; fixing forward
  works.
- The bootstrapping claim ("absent means 1") is consistent with the two formats that have a second
  version (`r2.dead-letters`, `store.anomaly-state`).
- "The first release with format records over an older deployment is forward-only" is **acceptable for the
  first production deploy**:
  - `forwardOnlyReasons` skips Workers that do not exist (`release.mjs:166`), and D69 states nothing is in
    production, so that deploy is not forward-only;
  - its `previous.json` names no versions, so it has no automatic rollback in any case.

  The cost falls on stages only, as stated.

**Run marks (m-11).**
- Under the fakes' atomic model, two runs cannot both promote a key built on the other's upload:
  - the check of the newest version stops the earlier run's put;
  - the mark check after the put stops a put that landed on the other run's upload;
  - the other run then finds its upload is no longer the newest.
- The mark cannot be forged across runs. It is a UUID per run (with the GitHub run and attempt), and the
  command line's `--var` wins over the config's vars.
- A crash between the put and the promotion: the keyed version stays newest and the next run inherits and
  keeps that key ("held" test). After a crashed **rotation**, the next record says `kept` for a key that
  changed. The Known risks entry describes this for the race only.
- **Not verifiable here.** A Cloudflare-side race between an upload's secret inheritance and a concurrent
  PATCH could give two runs two different created keys. The fakes apply each call atomically.

**The OAuth key (S9).**
- Across creation (the target lacks the key, a newer version carries it), the rollback is refused before
  anything moves. Across a rotation, detected from the deploy's own message, it is refused always,
  `--accept-secret-loss` included.
- Both are skipped only when the record leaves viz-control out.
- `--accept-secret-loss` is explicit and per name. It lifts only the creation refusal. deploy.sh and the
  workflow never pass it, and the workflow has no input for it. Nit: unknown names are ignored silently,
  whereas `--rotate-secret` refuses them.
- "An unreadable serving version stops the release": exit 1, nothing changed. No persistent case was found
  (a 404 is transient per S9, an auth error throws anyway), so it is not a way to brick deploys. Its
  documentation gap is in m-9.

**Liveness, refusal by refusal.**
- Unacknowledged migration: add the acknowledgement.
- Switch on over a serving floor Worker below its floor: a one-Worker rollback, or a release without the
  switch (m-8 for the documentation).
- A release below its floor after the switch: unreachable with current tooling.
- A rollback below a floor, a format, or an unknown version: choose another record, or fix forward.
- Across the key's creation: `--accept-secret-loss`, run locally.
- Across a rotation: a partial record (see M-1), or fix forward.
- A run-mark race: run again.
- Set but missing from the upload: **no safe way out (m-6)**.
- Unreadable serving version: run again.

## Reproduction index

All commands run from `$SP/rv-d69/deploy`:

```
node --test --test-concurrency=1 test/review-d69.test.mjs test/review-d69-oldcommit.test.mjs
```

That gives `# tests 12 / # pass 12 / # fail 0`; each pass is a reproduction (full output in
`$SP/rv-d69/review-run.txt`). Baseline: `node --test --test-concurrency=2 test/release-checks.test.mjs
test/secrets.test.mjs test/release.test.mjs`, 54/54.

| ID | Finding | Test (file) | Key output |
|---|---|---|---|
| RV-1a | M-1 | "RV-1a: a record without viz-control rolls viz-ingest back below a kv.settings version…" (`review-d69.test.mjs`) | whole record exit 3 (`kv.settings: release c … wrote version 2, and a reads only 1`); without viz-control exit 0; ingest serves a, control serves c |
| RV-1b | M-1 | "RV-1b: the README's way round the rotation refusal…" | `RV-1b whole: exit 3` (rotation + kv.settings) / `RV-1b without control: exit 0` |
| RV-3 | M-2 | "RV-3: … the tooling of that commit deploys it" (`review-d69-oldcommit.test.mjs`, uses `$SP/old-b322599`) | current tool `REFUSED … viz-oldtest-query: this release is below its floor`; old tool `exit 0; release: b322599 promoted` |
| RV-4 | m-1 | "RV-4: once the switch-on viz-ingest version is no longer kept…" (fake `keep: 4`) | `before pruning: exit 3` / `after: exit 0 … viz-rvtest-query: back to` |
| RV-5 | m-2 | "RV-5: INGEST_SIGNALS set as a Worker secret…" | `RV-5: exit 0` (publisher schema 3 restored) |
| RV-6 | m-3 | "RV-6: the switch goes on while viz-query serves below its floor…" | `RV-6: exit 0; release: r2 promoted` |
| RV-10 | m-4 | "RV-10: a rollback … checked before another run sets INGEST_SIGNALS…" | `RV-10: rollback exit 0`; publisher schema 3 with `INGEST_SIGNALS=traces,logs` |
| RV-7 | m-5 | "RV-7: m-11 race on a viz-control that goes out with wrangler deploy…" (fake `racePut`) | `deploy() threw (CLI exit 1)`; publisher and ingest promoted; control serves without the key |
| RV-8 | m-6 | "RV-8: one upload that did not inherit the key poisons every later upload…" (fake `inherit: none` once) | `k2: exit 3; rollback to k1: exit 0; k3: exit 3` (k4: 3) |
| RV-11 | m-7 | "RV-11: an upload shown for one read without the key it inherited…" (fake `uploadSecretLag: 1`) | `RV-11: exit 3 … does not carry it`; the upload carried it; u2 deploys |
| RV-9 | m-8 | "RV-9: with the switch on in every release, a viz-query in a gradual deployment…" | `r3: exit 3`, `r4: exit 3 … serving now is below its floor`; one-Worker rollback 0; r5 0 |
| held | run marks | "held: a run that dies after the put and before any promotion…" | next record `kept`, serving the rotated key |
| — | m-7 | `node -e` on `secrets.mjs:73-76`'s parsing | `VIZ_FRESH_READ_MS="" -> 0 ms budget` |

The fake extensions are in `$SP/rv-d69/deploy/test/fake-wrangler.mjs`, marked `REVIEW EXTENSION
(rv-d69)` (the `keep` and `uploadSecretLag` knobs).

## Row for design/REVIEW.md's index

| Review | Scope | Findings | Disposition |
|---|---|---|---|
| `reviews/d69-release-floors-formats.md` | D69: format versions in release records, the rollback floor `INGEST_SIGNALS` raises (COMPATIBILITY §6 "a floor raised by a switch"), run marks (m-11), rollbacks across the OAuth key (S9), on the development branch at `9958cb3` | 0 blockers, 2 majors (M-1: format rollbacks judge only the record's Workers, so a record without viz-control, the README's way round the rotation refusal, rolls readers back under a format viz-control keeps writing, and undeclared readers are never judged; M-2: "redeploy an older commit" runs that commit's pre-D69 tooling, so no floor is checked on the path the deploy-time floor refusal claims to cover), 9 minors (switch evidence ages out of the 100-version window; a secret-typed switch unseen; floor Workers outside the release unjudged at switch-on; check-then-act against a concurrent deploy; m-11 refusal in phase 2 is exit 1 with Workers promoted; "set but not carried" has no non-destructive exit; upload re-read waits for existence only; one off-floor Worker refuses every release, remedy undocumented; claims drift). All but M-1 (c), m-8's rename case and m-7's wall-clock bound reproduced against the fakes; D69 approved with changes | Open |
