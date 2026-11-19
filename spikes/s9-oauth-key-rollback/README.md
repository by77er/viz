# Spike S9: rolling back across the release that created (or rotated) viz-control's OAuth key

**Status: done (2026-11-19, 11:01–11:26 UTC). Measured on Cloudflare; everything deployed was deleted.**

The question comes from `deploy/README.md`, "Known risks", "Rollback across the release that
created (or rotated) the OAuth key", and from D53 in `design/DECISIONS.md`. On a stage:

1. deploy release R0 of viz-control without `OAUTH_CLIENT_KEY`;
2. deploy R1 (the deploy generates the key, D53);
3. `node deploy/release.mjs rollback` to R0's record;
4. deploy R2.

## The answers

All of these were measured on Cloudflare. The created case ran twice (runs 1 and 2) and the rotated
case once (run 3). Raw evidence is below.

| Question | Answer |
|---|---|
| 1. Is the rollback's `versions deploy` refused with 10220? | **No, it is allowed, when the version being restored has no key.** `release.mjs rollback` exited 0 both times. wrangler printed `SUCCESS Deployed viz-s9-control version <R0> at 100%` (0.44 s and 0.40 s), with no error code. |
| 2. If it is allowed, which key serves afterwards? | **None. The rolled-back version does not keep the current secret.** A secret belongs to each version, and R0's version has none. `/oauth/register` answers **503 `temporarily_unavailable`**, the metadata stops advertising `registration_endpoint`, and a client id signed under R1's key gets **400 "not registered"** from `/oauth/authorize`. The Worker's secret list still names `OAUTH_CLIENT_KEY` throughout. |
| 3. Does R2 keep the key, refuse (exit 3), or create a new one? | **It keeps it, with the same value.** The plan said `keep`, the release record says `kept`, and the deploy exited 0. R2's upload inherited the key from the **newest version** (R1's), not from the version that was serving (R0, no key). The client registered under R1 verifies again under R2 (200). |
| Rotated case: a rollback to a version that has the *old* key | **Refused: API error 10220.** "A secret has changed since this version was active. If you are sure this is ok, add a ?force=true query parameter to allow the rollback. The following secrets have changed: OAUTH_CLIENT_KEY [code: 10220]". `release.mjs rollback` exited **1**, not 3. Nothing changed: the rotated release kept serving the new key. |
| Rotated case, forced (`?force=true`, as wrangler's own `rollback` does after its prompt) | Allowed. The restored version serves **its own old key**: clients registered before the rotation verify (200) and clients registered after it do not (400). The **next release** then inherits the newest version's key, the rotated one, so the old clients fail again. The record still says `kept`. |

Two more findings that were not asked for:

- **A version read straight after it is created is sometimes not there yet.** In 2 of 16 such reads
  (13 made by `release.mjs`, 3 by the driver's `lag` check), the version was not visible yet. Both
  failures came in the first release to create the key on a Worker about a minute old. Run 1, R1:
  "version 25a57f92-… does not list OAUTH_CLIENT_KEY after it was put; nothing was promoted". Run
  2, R1: "version f3dc4a39-… was not found, so its secrets cannot be checked". Each failed with
  exit 1 and promoted nothing, and running the same release again succeeded. In the 3 `lag` puts,
  made later on a Worker about 8 minutes old, the first read saw the secret 193–368 ms after
  wrangler exited.
- **The script's secret list names the secrets of the newest version, not those of the serving
  one.** After R1's failed first attempt, and all through the rollback, R0 served without the key
  while `GET …/secrets` listed `OAUTH_CLIENT_KEY`.

## What was deployed

From commit **`0663b3087b68a56afcc9804d9a0e58da90bdf639`** (HEAD of
`claude/cloudflare-observability-platform-ibaqya`), checked out as a detached git worktree in a
scratch directory. Its `node_modules` were symlinked from the shared tree. The tooling was
wrangler 4.164.0 (pinned in `deploy/package.json`) and Node 22.23.5. The shared tree was not built
from and not written, apart from this directory.

| Resource | Name | Lifetime |
|---|---|---|
| Worker | `viz-s9-control`, on workers.dev at `viz-s9-control.<account subdomain>.workers.dev`; no route, no custom domain, no cron | created three times (11:02, 11:11, 11:18) and deleted three times (11:11, 11:17, 11:26) |
| Durable Object namespace | `viz-s9-control`'s `Tenant` class (migration `v1`) | created and deleted with the Worker; no object was ever made |
| KV namespace | `viz-s9-config` (bound as `CONFIG`; nothing was written to it) | 11:01:55–11:17:15, then 11:18:47–11:26:01 |

Nothing else was created: no R2 bucket, no queue, no other Worker. `--expires
2026-11-19T13:30:00Z` was set on every release.

### Where this differs from a production deploy

1. **Only viz-control.** `configure.mjs` always generates all seven Workers. The driver narrows
   `manifest.order` to `viz-s9-control` after each configure run. `release.mjs` reads only
   `manifest.order`, so viz-control's steps (plan, upload, secret, promote, record, rollback
   checks) run unchanged. The gateway would have needed the whole stack behind it.
2. **workers.dev for viz-control.** `configure.mjs` gives a workers.dev URL only to the gateway, so
   the driver sets `workers_dev: true` in the generated `viz-control.jsonc`. That URL is a trigger,
   not part of a version, so it has no effect on what a version carries or on what a rollback
   restores.
3. **R0 without the key.** The current tooling always generates the key. For R0, the driver runs
   the real `release.mjs` `deploy()` in its own process, after emptying `GENERATED_SECRETS` from
   `lib/secrets.mjs`. That is the tooling as it was before D53. Every other release went through
   the unmodified `node deploy/release.mjs` CLI. Run 3's first release, Ra, did not use this
   change: it is the normal first deploy, with the key put in phase 2.
4. **KV namespace by the driver.** `resources.mjs ensure` would also have made an R2 bucket and four
   queues that viz-control does not bind. Teardown used the normal `resources.mjs destroy --stage s9`.
5. A stage keeps viz-control's `PUBLIC_URL` (`https://vis.bitcru.sh`), which is the issuer. Signing
   and verifying registrations do not depend on it.

### How "which key serves" was judged without seeing a key

The key was never read, printed or written by anyone but `release.mjs` and wrangler; it went
through wrangler's stdin as designed. The driver (`run.mjs probe`) works from outside, and on
each round:

- `POST /oauth/register` → 201 with a client id, which control signs with HMAC under the key it
  is serving, or 503;
- `GET /oauth/authorize` with each client id registered so far → **200 if its signature verifies
  under the key now serving**, 400 "not registered" if it does not.

A **forged** id (one signature character changed) was included as a control. It was 400 in every
round of every phase. While each probe ran, `wrangler tail --format json` recorded the version
that served each request, and the deployment API recorded which version was deployed. Client ids
are not secrets; the scratch files that held them were deleted.

## Raw evidence

All times are UTC on 2026-11-19. "Rounds" are probe rounds 10 s apart. In each round's cells,
`a/b` means a out of b requests. "Tail" shows the version that served the tail events seen.

### Run 1: created, then rolled back (no key, then key)

| Step | Result |
|---|---|
| 11:02:14–21 R0 `s9-r0` (`deploy-r0`, `--ack viz-control@v1`) | `wrangler deploy`, migration (none) → v1. Version **045d12ab** (number 1). It has no secret binding, and the secret list is empty |
| probe R0, 3 rounds, 11:02:46–11:03:07 | healthz 200; metadata without `registration_endpoint`; register **503** `temporarily_unavailable` (3/3). Tail: 9 events, all 045d12ab |
| 11:03:31 plan R1 `s9-r1` | `secret OAUTH_CLIENT_KEY on viz-s9-control: not set; would be created on the version uploaded in phase 1` |
| 11:03:31–39 deploy R1 | upload **c760d56a** (number 2, no key). Key put → **25a57f92** (number 3, `create_version_api`, message "viz s9-r1; OAUTH_CLIENT_KEY created"). Then **exit 1**: `version 25a57f92-… does not list OAUTH_CLIENT_KEY after it was put; nothing was promoted`. Seconds later, the version API listed `OAUTH_CLIENT_KEY: secret_text` on 25a57f92, and the secret list named it, while R0 still served |
| 11:04:2x plan R1 again | `set (the Worker's secret list, version 25a57f92 (number 3), newer than the one serving: a rollback left it); kept` |
| 11:04:29–42 deploy R1 again | upload **0d985d48** (number 4) **carries the key**. At that moment the newest version was 25a57f92 (key), the last plain upload was c760d56a (no key) and the deployed version was 045d12ab (no key). Record: `kept`; promoted at 100%; exit 0 |
| probe R1, 3 rounds, 11:05:13–34 | metadata advertises registration; register **201** (3/3); client "r1" saved; authorize r1 **200** (3/3). Tail: 0d985d48 |
| **11:05:54–59 rollback** to `release-s9-r0.json` | **exit 0**. `SUCCESS Deployed viz-s9-control version 045d12ab-… at 100% (0.44 sec)`. No 10220 |
| probe, 6 rounds, 11:06:22–11:07:14 | Round 1 (23 s after the command returned) was mixed: the metadata still advertised registration and r1 authorized 200, but register answered 503. **Rounds 2–6 (34–75 s after): register 503 `temporarily_unavailable`, no `registration_endpoint`, r1 400 "not registered"**, forged 400. Tail: 26 events, all 045d12ab. Secret list: `OAUTH_CLIENT_KEY` |
| 11:07:4x plan R2 `s9-r2` | `set (the Worker's secret list, version 0d985d48 (number 4), newer than the one serving: a rollback left it, version 25a57f92 (number 3), …); kept` |
| 11:07:48–59 deploy R2 | upload **f7aa30d4** (number 5) carries the key; record `kept`; promoted; **exit 0** |
| probe R2, 6 rounds, 11:08:23–11:09:15 | register 201; **r1 200 (6/6)**: the same key as R1; the client registered under R2 200; forged 400. Tail: 33 events, all f7aa30d4 |
| about 11:10, `run.mjs lag` (3 trials) | `versions secret put S9_LAG_PROBE` (a throwaway; value on stdin, never shown) took 2.35–2.67 s. The first version read after wrangler exited listed the secret in all 3 trials (the GET returned after 368, 213 and 193 ms) |

### Run 2: the created case again, on a re-created Worker

| Step | Result |
|---|---|
| 11:11:03 | `viz-s9-control` deleted (`DELETE …/scripts/viz-s9-control?force=true`) so the run starts from no Worker |
| 11:11:11–17 R0 `s9-r0-b` | version **21eb7089** (number 1), no secret |
| probe R0, 3 rounds | round 1 (24 s after the deploy): 404 from workers.dev, whose route for the re-created script was not live yet; rounds 2–3: register 503. Tail: 21eb7089 |
| 11:12:15–20 deploy R1 `s9-r1-b` | upload **f3dc4a39** (number 2), then **exit 1**: `version f3dc4a39-… was not found, so its secrets cannot be checked`. Nothing put, nothing promoted |
| 11:12:35–49 deploy R1 again | upload **38054be1** (number 3); key `created` on **642c1195** (number 4); promoted; exit 0 |
| probe R1, 3 rounds, 11:13:13–34 | round 1 mixed (metadata yes, register 503); rounds 2–3: register 201, client "r1b" 200 |
| **11:13:47–52 rollback** to `release-s9-r0-b.json` | **exit 0**. `SUCCESS Deployed viz-s9-control version 21eb7089-… at 100% (0.40 sec)`. No 10220 |
| probe, 6 rounds, 11:14:15–11:15:07 | **all 6 rounds: register 503, no `registration_endpoint`, r1b 400 "not registered"**, forged 400. Tail: 28 events, all 21eb7089 |
| 11:15:25–38 R2 `s9-r2-b` | plan `keep` (the secret list and 642c1195 newer than the one serving). Upload **30e015b6** (number 5) carries the key. The newest version was 642c1195 (key, `create_version_api`), the last plain upload was 38054be1 (no key) and the deployed one was 21eb7089 (no key). Record `kept`, exit 0 |
| probe R2, 5 rounds, 11:16:00–42 | **r1b 200 (5/5)**: the same key; r2b 200; forged 400 |

### Run 3: rotated, then rolled back (key A, then key B)

| Step | Result |
|---|---|
| 11:18:55–11:19:10 Ra `s9-ra`, the normal first deploy (plan: `not set (new Worker); would be created right after its wrangler deploy in phase 2`) | `wrangler deploy` → **6e1b440c** (number 1). Key `created` on **700dcd3b** (number 2), which was deployed before anything else. Exit 0. This is the first-production-deploy path, run on Cloudflare for the first time |
| probe Ra, 4 rounds | register 201; client "ka" 200 (4/4) |
| 11:20:20–36 Rb `s9-rb --rotate-secret OAUTH_CLIENT_KEY` (plan: `set; REPLACED as asked`) | upload **c9e889cd** (number 3, inherits key A); key `rotated` on **be109113** (number 4); promoted; exit 0 |
| probe Rb, 4 rounds | **ka 400, kb 200** (4/4): the rotation took effect |
| **11:21:42–47 rollback** to `release-s9-ra.json` | **exit 1**. `A request to the Cloudflare API (/accounts/<account>/workers/scripts/viz-s9-control/deployments) failed. A secret has changed since this version was active. If you are sure this is ok, add a ?force=true query parameter to allow the rollback. The following secrets have changed: OAUTH_CLIENT_KEY [code: 10220]`, then `release: wrangler versions deploy exited 1` |
| probe, 2 rounds, 11:22:22–32 | still Rb: ka 400, kb 200; deployment be109113 |
| 11:22:59 `run.mjs force-deploy --version 700dcd3b…` (`POST …/deployments?force=true`) | 200 |
| probe, 5 rounds, 11:23:22–11:24:04 | **ka 200, kb 400** (5/5): the restored version serves its own key A. Tail: 25 events, all 700dcd3b |
| 11:24:21–33 Rc `s9-rc` (plan: `set (…, serving version 700dcd3b, version be109113 (number 4) newer …); kept`) | upload **a04fdf58** (number 5); record `kept`; exit 0 |
| probe Rc, 5 rounds, 11:24:58–11:25:40 | **ka 400, kb 200** (5/5), and the client registered under Rc 200: Rc serves **key B**, the newest version's, not key A, which had been serving |

## What it means for D53 and `release.mjs`

**Which branch of the "Known risks" item is the real one:**

- **Created case: "if allowed, `/oauth/register` answers 503 until the next deploy".** That is
  what happened, twice. The next deploy then *keeps* the key, because uploads inherit from the
  newest version. The other branch, where the next deploy refuses with exit 3 (m-9), does not
  happen on Cloudflare: the newest-version check in `secretsNow` saw the key every time, and the
  upload carried it every time. The check stays as a guard that did not fire. The 503 is not the
  whole effect, though. While the rolled-back version serves, every registered client id fails at
  `/oauth/authorize` (measured). By reading `control/src/oauth-http.ts` and `introspection.ts` (not
  measured; there was no tenant), every code, refresh token and access token is also refused,
  because their tags are made with the key. So a rollback across the key's creation breaks every
  MCP client until the next deploy.
- **Rotated case: "if refused, the automatic rollback of that one release fails loudly and the new
  release keeps serving".** That is what happened: Cloudflare refuses with 10220. `release.mjs
  rollback` exits **1**, not 3, because the refusal comes from wrangler and is not recognised.
  `deploy.sh` then reports "rollback: FAILED or refused" and the job fails. Not measured, from
  reading `restore()`: with the whole stack, the rollback goes callers first (gateway, mcp, ruler,
  query, then control), so the four callers would already be back on the old release when
  viz-control's step fails, and viz-control, viz-ingest and viz-publisher would stay on the new
  one. Old callers against new callees is the direction `contracts/COMPATIBILITY.md` allows, but it
  is a mixed deployment that no record names.

**D53's "Would change if":**

- "a stage shows uploads not inheriting the key": **not triggered**. Uploads inherit the
  `secret_text` bindings of the newest version, whatever made it (a `versions upload` or a
  `versions secret put`). Inheritance did not come from the deployed version or from the last
  plain upload: four releases separate these cases, and in run 3 the value itself shows it (key B
  from the newest version, not key A from the serving one).
- "a rollback refused with 10220": **triggered for a rotation, not for the creation**. What was
  measured: Cloudflare allows deploying a version that lacks a secret the serving version has, and
  refuses a version whose value for a secret differs from the current one, unless `?force=true`
  is given.

**Recommended changes** (none made here; `deploy/` belongs to its owner):

1. **Rollback across a rotation**: `release.mjs rollback` could see this coming. A record newer
   than the target says `rotated`, and the versions since the target can be read. It should refuse
   before changing anything (exit 3), naming the rotation, so that the callers are not rolled back
   ahead of a viz-control step that will fail. If forcing is chosen instead, the operator must know
   two things. A forced rollback brings back the old key, so the old clients work and the new ones
   do not. The next deploy then silently switches back to the rotated key while the record says
   `kept`: names are compared and values are not, so `kept` means "the newest version's value",
   not "the serving one's".
2. **Retry the read after creating a version.** `ensureSecrets` reads the upload (and, after a put,
   the keyed version) once, immediately. It should retry for a bounded time, for example up to
   10 s, before failing. Here the failure was safe, because nothing was promoted. But the same
   read follows the phase-2 put of a first deploy, after Durable Object migrations have been
   applied. A failure there leaves viz-control serving without the key and stops the gateway from
   being deployed (see "When a deploy fails"). That path succeeded the one time it ran here (Ra).
3. **The secret list is evidence about the newest version only.** `secretsNow` treats "the Worker's
   secret list" as its own source of evidence. On Cloudflare, that list reflects the newest
   version, so it adds nothing to the newer-versions scan, and it does not say what serves.

## Cost

**Measured on Cloudflare**: GraphQL `workersInvocationsAdaptive` and
`durableObjectsInvocationsAdaptiveGroups`, window 11:00–11:30 UTC, read at 11:26:52. That was
after the last deletion, so the rows are under `__unknown__`, the name analytics gives deleted
scripts; that no other deleted script ran in the window is likely, not checked. The result:
**263 Worker requests, 0 errors, 0 subrequests, CPU p50 0.75 ms and p99 3.4 ms, 0 Durable Object
requests.** The probes sent 268 requests (counted by the client). The 3 that workers.dev answered
404 before the re-created script was routed may not count as invocations, and ingestion may lag.
At list prices, 263 requests × $0.30/M is about $0.0001. All of it is inside the plan's included
allowances, so the cost is $0. KV operations were not read; nothing on the probed paths uses KV.
No bill was read.

Stated before deploying (unchanged): **worst case under US$0.01, stated as under US$0.10.** The
plan was about 300 Worker requests, no Durable Object requests and no KV operations. Only
`viz-s9-control` and `viz-s9-config` were to be created. Nothing runs on a timer: viz-control has
no cron, and has no alarm without a tenant. The extension (run 3) was stated in this file at
11:19, before it ran, with the same names and the same bound.

## Cleanup

- `node deploy/resources.mjs destroy --stage s9`, run from the worktree, twice. At 11:17:15 it
  printed `destroy s9: Worker viz-s9-control, KV namespace viz-s9-config`, and again at 11:26:01.
  Both times the `leftovers` were empty for Workers, R2, KV, queues, domains and Durable Object
  namespaces. Between runs 1 and 2 the Worker was also deleted once on its own (11:11:03).
- **Account inventory, before (11:01:49) and after (11:26:02)**: 20 Workers, 6 R2 buckets, 7 KV
  namespaces, 0 queues, 11 custom domains and 28 Durable Object namespaces, the same both times.
  The only `viz-` resource, before and after, is `viz-spike-s0-do-billing` (Worker and its DO
  namespaces), which is not this spike's. Nothing whose name contains `s9` remains (Workers, KV,
  DO namespaces). No other resource was created, changed or deleted. The unrelated `CONFIG` KV
  namespace and every non-`viz-` resource were only listed.
- The worktree's `deploy/resources.json` got the KV id from the driver, and `destroy` removed it
  again. The worktree was then removed with `git worktree remove`. The scratch files (client ids,
  logs, release records, tail output, and wrangler's debug logs, which went to a scratch
  directory through `WRANGLER_LOG_PATH`) were deleted. Two wrangler debug logs from a `--dry-run`
  bundle check made before that variable was set (10:59, no secret involved) were deleted from
  `~/.config/.wrangler/logs/`. A scan of every scratch and spike file for the API token found it
  in none.

## Re-running it

```
T=<a git worktree of the commit to test, node_modules linked>   # never the shared tree
D=spikes/s9-oauth-key-rollback; E=<an ISO time at most 3 h ahead>; C=<scratch>/clients.json
node $D/run.mjs inventory --tree $T --out <scratch>/before.json
node $D/run.mjs kv --tree $T
node $D/run.mjs configure --tree $T --release s9-r0 --expires $E
node $D/run.mjs deploy-r0 --tree $T --ack viz-control@v1
node $D/run.mjs probe --tree $T --label r0 --state $C --register
node $D/run.mjs configure --tree $T --release s9-r1 --expires $E
(cd $T && node deploy/release.mjs plan --stage s9 && node deploy/release.mjs deploy --stage s9)   # again if it exits 1 (lag)
node $D/run.mjs probe --tree $T --label r1 --state $C --register
(cd $T && node deploy/release.mjs rollback --record deploy/generated/stage-s9/release-s9-r0.json --stage s9)
node $D/run.mjs probe --tree $T --label rollback --state $C --rounds 6
node $D/run.mjs configure --tree $T --release s9-r2 --expires $E
(cd $T && node deploy/release.mjs plan --stage s9 && node deploy/release.mjs deploy --stage s9)
node $D/run.mjs probe --tree $T --label r2 --state $C --register --rounds 6
(cd $T && node deploy/resources.mjs destroy --stage s9)
node $D/run.mjs inventory --tree $T --out <scratch>/after.json
```

For the rotated case, deploy the first release with the plain CLI (`--ack viz-control@v1`), the
second with `--rotate-secret OAUTH_CLIENT_KEY`, then roll back to the first record. `run.mjs
force-deploy --version <id>` does what wrangler's `rollback` does after its prompt. Set
`WRANGLER_LOG_PATH` to a scratch directory so that wrangler's debug logs can be deleted with it.
