# Review of D74: viz-gateway serves the web app

Adversarial review by a reader who did not build the change and had only what the repository says.
Rules kept:
- read-only on the shared tree (this file is the only write);
- every experiment and mutant in a scratch copy;
- no deploy, no Cloudflare API call, no commit; at most 2 test workers, one heavy job at a time;
- servers started here were stopped.

**Verdict: approve with changes.** 0 blockers, 2 majors, 10 minors, 7 nits.

Locally, the serving rules hold: I found no request that gets a page where the JSON 404 belongs, no
app content without its policy, and no 404 that a cache may keep. The gateway's own tests have teeth.
The two majors are about the release path, not the serving: the build runs third-party code beside
the Cloudflare token, and the first contact with Cloudflare would be production.

## Scope

**Commit read: `7a4cdfe`**, with `deploy/`, `.github/` and `design/` clean in the working tree.
During the review the tree moved to `b554f35`; none of the files under review changed, except that
`app/serve.json` gained a fifth document, `/dashboards`, uncommitted, by the app's builder. The runs
below used the four-document file. The fifth is no API path, and the deploy tests read serve.json
when they run, so they follow it.

Read: D74 and D69 in `design/DECISIONS.md`; `deploy/gateway/src/index.ts`; `deploy/lib/app.mjs`;
`deploy/app.mjs`; the app parts of `configure.mjs`, `release.mjs`, `smoke.mjs`, `deploy.sh`,
`workers.json`; `.github/workflows/deploy.yml`; `deploy/test/app*.test.mjs`;
`deploy/scripts/mutants-app.mjs`; `deploy/README.md` ("The web app", "Not implemented", "Known
risks").

**Setup.** `R=/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/d74-review`.
- `$R/repo`: a copy of `deploy/` (its `node_modules` linked), `app/serve.json`, and the tracked files
  of the components `configure.mjs` reads. It is outside any git work tree.
- **Baseline there:** `node --test test/app.test.mjs` 22 of 22; `test/app-serve.test.mjs` passes;
  `vitest run gateway/test/app.test.ts` 67 of 67.
- **The local server:** `wrangler dev --local` (wrangler 4.164.0), Cloudflare variables removed from
  its environment, with the config and staged directory `lib/app.mjs` generates for the fixture
  build (`$R/stage.mjs`, `$R/start.sh`). Requests were written to a TCP socket as typed
  (`$R/raw.mjs`), so dot segments and encodings arrive unchanged.

**How each fact is known.** "Observed" is that local run. "Docs" is Cloudflare's Workers Static
Assets documentation, read 2026-11-27 (Headers; Worker script routing; through a summarising
fetch, so the quotations are as that tool returned them). "Training knowledge" is
marked where used. Nothing here was seen on Cloudflare.

**One thing that went wrong in this review.** The first run of the experiment for M-1 was started
with this session's real environment. Its toy build script read `CLOUDFLARE_API_TOKEN` from an
ancestor process and the value was printed into my command output and written to one file in the
scratch directory. I deleted the file at once and reran everything with a dummy value. The value is
not in this file, not in the repository, and was sent nowhere; it is in this session's transcript.
The owner should decide whether to rotate the token.

## Findings by severity

### Majors

#### M-1. The app's build runs third-party code where the Cloudflare token can be read; removing the variable from the child's environment does not prevent it — **reproduced**

**Where.** `lib/app.mjs` `run()` deletes `CLOUDFLARE_*`, `CF_API*`, `SMOKE_KEY` and `WRANGLER_*` from
the environment of `npm ci` and `npm run build`. `deploy.yml` sets both credentials at job level, so
every step has them, and `deploy.sh` requires them before it builds. `deploy/README.md` line 435:
"The build gets no Cloudflare credential in its environment".

**What happens.** The sentence is literally true and reads as isolation, which it is not. The build
runs as the same user, in the process tree of `node deploy/app.mjs`, which holds the token:
- any install script or Vite plugin can read `/proc/<ancestor>/environ`;
- it can also rewrite files that later steps run with the token: `deploy/release.mjs`,
  `deploy/node_modules/.bin/wrangler`, or the staged directory after `release.mjs` has hashed it
  (see m-7 for that window).

**Reproduction.** `env CLOUDFLARE_API_TOKEN=DUMMY-not-a-credential-123 node $R/exp/build-gate.mjs $R`,
case E2: a toy app whose `build` script walks its parent processes. Output:
`E2 build script: ran; saw {"own":null,"found":{"ancestorDepth":3,"isTheDummy":true,"length":26}}`.
The variable is gone from the script's own environment and present three processes up.

**How much is new.** Not new in kind: `deploy.sh` already runs `npm ci` for `deploy`, `stack`,
`control` and `query` with the token in the environment itself. D74 adds the app's tree (158
packages in `app/package-lock.json`, 5 in `design-system/`) and runs their code at build time, not
only at install.

**No test holds even the stated property.** With the deletion removed from `run()`, all 22 tests of
`test/app.test.mjs` pass (`$R/exp/mutants.mjs`, "the build command keeps the Cloudflare credentials").

**Smallest fix.**
1. Now: correct the README sentence, add the exposure to "Known risks", and add a test that the build
   command's environment has no `CLOUDFLARE_*` (so the mutant dies).
2. The real boundary: build in a job that has no secrets. The `checks` job already builds the app.
   Hand `dist/` and the source hash over as an artifact of the same run, and let the deploy job read
   it by `readBuild`'s rules (it is then data, never executed) and compare the source hash with its
   own checkout. This replaces "production refuses a build handed in" with "production takes only
   the build of this run's checks job"; D74 point 3 would say so.
3. Independently: put the two credentials on the steps that call Cloudflare, not on the job, and set
   `persist-credentials: false` on the checkout (n-6).

#### M-2. The first time any of this meets Cloudflare would be production, in a release that cannot roll back — stated in the README, enforced by nothing

**Where.** `deploy/README.md`, "Known risks": "until a stage has passed it, production should not
take this release", and the first production release is forward-only (the `oauth-public` floor), so
a failed app check "does not roll anything back". `deploy.yml` deploys every push to main.

**What happens.** Merging the pull request is the first deploy. Everything the serving rests on is
local observation: a missing asset reaching the Worker, `_headers` replacing `Content-Type` and
`Cache-Control`, the 405, the redirects. The docs I read say `_headers` values "override what
Cloudflare ordinarily sends" and that a missing asset invokes the Worker; they do not say whether
`_headers` rules attach to the asset layer's own 404, 307 or 405. If any differs, the smoke test
fails after promotion and the job ends red with the new gateway serving.

**Smallest fix.** Make the stage deploy a recorded precondition of the merge: run
`deploy/deploy.sh --stage <name>`, record the smoke result and items 6 to 10 of "What a first deploy
to a stage should check" in the README and the pull request, then delete the stage. I agree with
the builder's own sentence; this finding is that it is a sentence only.

### Minors

#### m-1. The commit gate for production fails open when git cannot read the checkout — **reproduced**

**Where.** `lib/app.mjs` `listSources` falls back to walking the directory when
`git rev-parse --show-toplevel` fails; `app.mjs build` and `stampProblems` apply the commit and
dirty checks only when `by === 'git'`.

**Reproduction.** `$R/exp/build-gate.mjs`, cases E1 and E1b. A production build with
`--release ffff…ffff` (40 hex) in a tree that is no work tree, and in a work tree owned by another
user (git's "dubious ownership"), both give
`BUILT, via=export, sources.by=walk, commit=null` and `stampProblems: []`. The walk also exports
files git ignores: the toy's `app/.env` was copied into the build directory, where Vite would read it.

**Fix.** For production with a release that is a commit, refuse when the sources were not listed by
git, in both places.

#### m-2. `VIZ_SKIP_NPM_CI=1` is accepted for production and the stamp does not say so — **reproduced**

**Where.** `app.mjs build` (`skipInstall`), `lib/app.mjs` `exportAndBuild`.

**What happens.** The export then links the checkout's `app/node_modules` and
`design-system/node_modules`, which no lockfile check has touched. The stamp says `via: "export"`
like any build made here, and the release record is silent. `build-gate.mjs` case E3:
`BUILT via=export; … stamp mentions install: false`, `stampProblems: []`.

**Fix.** Record how dependencies were installed in the stamp and the record; refuse a linked
install for production when the release is a commit.

#### m-3. The document's entity tag and the build hash do not cover the document's headers — **reproduced**

**Where.** `lib/app.mjs` `documentEtag(build.documentSha256)`; `build.hash` covers `index.html` and
the files only.

**What happens.** A release that changes only serve.json's document headers (a tighter policy, say)
serves the same `ETag`. A browser that revalidates gets 304. `$R/exp/misc.mjs`:
`headers differ: true | etag equal: true | build equal: true`. The 304 does carry the new headers,
but Chromium does not take `X-Frame-Options` or any `X-Content-*` header from a 304 (training
knowledge of its header-update list, not checked here). The plan and the rollback note would also
print "the same build" for two versions that send different policies.

**Fix.** Hash the headers into the tag (and into `build`, or print the serve.json hash beside it).

#### m-4. "The API comes first" is enforced for documents only; serve.json can put files in front of the API — **reproduced**

**Where.** `lib/app.mjs` `readServe`. The asset layer answers a path that is a file before the
Worker runs, so `routeOf` never sees it.

**Reproduction.** `$R/exp/serve-collide.mjs`:
- `assetsPrefix` `/api/`, `/v1/`, `/oauth/`, `/loki/`: accepted, and `_headers` then gives `/api/*`
  the year-long caching;
- `files` with `/api/v1/control/openapi.svg`, `/api/v1/label/x.svg`, `/mcp.svg`: accepted;
- `documents` with `/mcp`, `/api/echo`, `/oauth/authorize`, `/healthz`: accepted by `lib/app.mjs`.
  The Worker then refuses the whole `VIZ_APP` and serves no page at all. The gateway's vitest reads
  the real serve.json and would fail in CI, so this last case is caught before a deploy; the first
  two are caught by nothing.

**Fix.** `readServe` refuses a prefix, file or document under the API's roots (`/api/`, `/v1/`,
`/loki/`, `/oauth/`, `/.well-known/`, `/mcp`, `/healthz`), with a test that holds that list to
`routeOf`.

#### m-5. A build with more than about 50 files silently loses "Update in place" — **reproduced**

**Where.** `lib/app.mjs` `appFilesVar`: when the build's own list exceeds 4,500 bytes it writes
`files: null`.

**Reproduction.** `serve-collide.mjs`, a 67-file build: `VIZ_APP_FILES files=null, 105 bytes`,
nothing logged, `dropped=[]`, and `next release would keep: 0 files`. The largest list that fits is
52 files with 35-character paths. Today's build has 7; one chunk per route would pass 52.

**Fix.** Log a WARNING and record it in the stamp and the release record; D74's "would change if"
should name this limit beside the document's.

#### m-6. A known-bad build's files cannot be dropped through the production workflow, and "three builds" has no bound in time

**Where.** `carryPlan` ages kept files only when the build changes. `VIZ_APP_NO_CARRY` is read by
`deploy.sh` but `deploy.yml` has no input for it.

**What happens.** After a bad app build is reverted, its files stay served, `immutable`, at their
addresses until three further app-changing releases; releases that do not change the app do not
count, and a gateway rollback to an older version rewinds the ages. What is trusted is sound: the
hashes come from the serving version's variable through the authenticated API, so nothing on the
network path can substitute bytes, and a build cannot extend its own life beyond `keep_builds`
(ages that are not integers from 1 are discarded; mutants on the hash check and the ageing are
caught). The gap is the operator's remedy.

**Fix.** A `workflow_dispatch` input that sets `VIZ_APP_NO_CARRY=1`, and a README paragraph saying
this is how a bad build's files are dropped.

#### m-7. The smoke test compares the document's bytes with the release's but not the assets'

**Where.** `smoke.mjs` `checkApp` checks status and headers of each file; `appSummary` puts only the
file count in the manifest.

**What happens.** `release.mjs` hashes the staged directory in `appProblems`, then uploads every
other Worker first: viz-gateway is last in the order, so the directory is uploaded only after all
of those uploads (not timed here), and nothing compares what Cloudflare serves with the stamp
afterwards. A zone feature
that rewrites JavaScript would also pass the smoke test, and show only later as kept files dropped
for "other bytes".

**Fix.** Carry each file's SHA-256 in the manifest and compare the fetched body in `checkApp`.

#### m-8. A failed app check hides the data check, and its hint does not say what the suggested rollback costs

**Where.** `smoke.mjs` `smoke()` returns at the failed app check, before `writeAndRead`. Its log
line recommends `rollback --only viz-gateway`.

**What happens.** On the first production release (no automatic rollback, M-2) the operator learns
that the page failed and not whether writes and reads work. The recommended rollback takes the
gateway to fb77292's version, which also removes every route added since (`/api/echo` is the
README's example); the hint says only "The API is not affected".

**Fix.** Run both checks and report both; let the hint name the routes the older gateway lacks, or
point to the README paragraph that does.

#### m-9. Safety properties with no test: mutants that survive — **reproduced**

Run with `$R/exp/mutants.mjs` (the `node --test` suites) and `$R/exp/mutants-gw.mjs` (vitest), on the
scratch copy; each file was restored and compared with the shared tree afterwards.

| Mutant | Result |
|---|---|
| the build command keeps the Cloudflare credentials (`run()`) | **survives** (M-1) |
| a stamp that names another staged directory is accepted (`stampProblems`) | **survives**. This check is what ties the directory that was hashed to the directory the config uploads |
| files are carried although two versions serve at once (`servingAppFiles`) | **survives** |
| production fetches kept files from the workers.dev pattern, not the domain | **survives** (the stage direction is caught) |
| a kept file is fetched following redirects; from any HTTP status; over 25 MiB | **survive**: `defaultFetchFile` is never run by a test. The hash check behind it is caught |
| a link among the sources is exported and hashed (`listSources`) | **survives** |
| git is asked with the inherited `GIT_` environment | **survives** |
| the smoke test follows redirects; does not ask `/explore/`; does not POST to a document | **survive** |
| the document is tried before the API router (`handle`) | survives, equivalent: `parseApp` refuses a document that is an API path, and that mutant is caught |
| gateway: a header value with a line break; no entity tag; not `text/html`; another `v`; the parsed app never refreshed; a 304 without the headers | caught |
| listed: kept bytes not compared; staged directory not compared; Worker first except under `/assets/`; `index.html` staged; an API path as a document; any method served | caught, as the README says |

Also: `scripts/mutants-app.mjs` says what the copy needs and omits `dashboard/`, without which
`configure` fails (`Could not resolve "../../dashboard/src/index.ts"`) and two tests fail for that
reason, which would count as kills.

#### m-10. The export is built inside the checkout, so lookups that walk up directories leave it — **observed**

**Where.** `buildDir` is `deploy/generated/<target>/app-build/`.

**Reproduction.** From `deploy/generated/production/app-build/app`, `require.resolve('wrangler')`,
`'typescript'` and `'vitest'` resolve to `deploy/node_modules`. A dependency missing from the app's
lockfile can therefore build here and nowhere else, and it is not in the source hash. Tool
configuration found by walking up (PostCSS, browserslist) has the same reach.

**Fix.** Build under a directory outside the repository (the system's temporary directory), and
keep only the staged result under `generated/`.

### Nits

- **n-1.** The asset layer's 307 and 405 carry the asset headers (observed):
  `GET /assets//index-Fx1EntrY.js` gives `307`, `Location: /assets/index-Fx1EntrY.js`,
  `Cache-Control: public, max-age=31536000, immutable`; `POST` and `OPTIONS` on a file give 405 with
  the same header. The redirect only ever points at a file of the build (a missing name goes to the
  Worker), and no open redirect was found, so this is harmless; the README's table should say it,
  since "a 404 with the asset's caching" is why D74 rejected alternative (b).
- **n-2.** `index.ts` says a document path "is compared as it was sent". It is compared after the
  URL parser removed dot segments (observed): `/api/v1/%2e%2e/%2e%2e/explore`, `/assets/..` and
  `/favicon.svg/..` answer the document, with its policy. Correct the comment; the same parsing
  routes `/assets/../api/v1/query` to the API, as before D74.
- **n-3.** `readBuild` checks references with `(?:src|href)="…"` only. A single-quoted or unquoted
  reference to another origin passes the build check; the policy still blocks it in the browser.
- **n-4.** A kept path under a directory that the new build has as a file
  (`/assets/index-X.js/chunk.js`) makes `stampBuild` throw `EEXIST` (`misc.mjs`): the build step
  fails instead of dropping the file. Vite's flat output makes this unlikely.
- **n-5.** The policy is on the documents only. Assets carry none, so `/favicon.svg` opened as a
  page would run a script if it held one; and under `script-src 'self'` every same-origin 200 is a
  candidate script, while the gateway's JSON and forwarded API answers carry no `nosniff`. Both are
  serve.json's and the backends' to decide. `style-src 'unsafe-inline'` is acceptable as written:
  with `img-src`, `font-src` and `connect-src` at `'self'` an injected style has nowhere to send
  what it reads. Not checked in a browser against the gateway, as the README says.
- **n-6.** `actions/checkout` in the deploy job persists the workflow token on the runner by
  default (`persist-credentials`; training knowledge of the action), where the build can read it;
  the token is read-only on contents.
- **n-7.** A gateway rollback restores an older app with no "not below build X" check. That is
  right today. D74's "would change if" should add: an app release that fixes a security defect.

## Held under attack

**1. Paths (observed, about 150 raw requests; `$R/t1.txt` holds the first set).**
- **The gateway's JSON 404, `no-store`:** `/assets`, `/assets/`, `/_headers`, `/assets/_headers`,
  `/favicon.svg/`, `/index.html`, `/index`, `/explore/`, `/explore/.`, `//explore`, `/%65xplore`,
  `/explore;x`, `/explore%00`, `/Explore`, `/FAVICON.SVG`, `/ASSETS/…`, a missing asset under every
  spelling (`//`, `./`, `%6e`, trailing slash, `%20`, `%00`, `%ff`, a malformed `%`), and each of
  them with `Accept: text/html` and `Sec-Fetch-Mode: navigate`.
- **Methods:** HEAD of a document and of an asset has the headers and no body; OPTIONS, TRACE, POST,
  PUT, DELETE on a document are the JSON 404, on a file 405 with no body.
- **Range:** the whole file, 200.
- **Conditional:** `If-None-Match` with the tag, the weak tag or `*` gives 304 with the full header
  set on a document; `If-Match` and `If-Modified-Since` give 200 (another tag giving 200 is the
  vitest suite's, which passed here).
- **`_headers` and the stamp:** neither is served; the stamp lies outside the uploaded directory.
- **Alternative (b):** I reproduced the builder's observation.
  `run_worker_first: ["/*", "!/assets/*", "!/favicon.svg"]` answers `GET /assets/nope.js` with an
  empty 404 carrying `Cache-Control: public, max-age=31536000, immutable`. D74's reason for not
  taking the owner's configuration stands, locally.

**2. Kept files.**
- The hash list is trusted from the serving version's `VIZ_APP_FILES`, read through the API with
  the token, never from the public URL. Bytes fetched are kept only on a SHA-256 match (mutant
  caught). The token is sent to `api.cloudflare.com` only; the public fetch carries no credential.
- Only paths under the prefix with plain segments, a known extension and a 64-hex hash are taken
  (mutants caught), so no kept file can be a document, `_headers` or anything outside `/assets/`.
- A kept file never overwrites the new build's file of that name (listed mutant).
- First release, a serving version without the app, a Worker that does not exist yet, and a fetch
  that fails all end as "nothing kept", with the reason in the stamp.
- A stage and production cannot be mixed: Worker name, origin, target directory and the stamp's
  target are all derived from the stage, and the stamp's target is checked.

**3. The build gate.** A stale stamp, another release's or target's, changed sources, a changed
serve.json, an altered, added or removed staged file, a prebuilt build for production, another
commit, and dirty app sources are each refused by `configure.mjs` and again by `release.mjs`
(tests read; the listed mutant on the staged directory re-run and caught). A link in `dist/` is refused; the real build in
`app/dist` reads cleanly by the rules (7 files, `VIZ_APP` 1,623 bytes, `VIZ_APP_FILES` 658).

**4. D69.** No floor is needed for the gateway: it writes no format and has no schema. The rollback
note and record are read from the restored version's own variable, so they say what will serve. No
backend depends on the app's paths (control's OAuth page has its own policy; viz-mcp only builds
links to `/explore`).

## Not checked

- Anything on Cloudflare: that a deployed version sends a missing asset to the Worker; that
  `_headers` replaces `Content-Type` and `Cache-Control` there; the 405 and the redirects; edge path
  normalisation in front of the Worker; compression and the `ETag` forms; that a rollback serves
  the older version's assets; that `wrangler versions upload` uploads assets with this token's
  permissions; that a 4,500-byte variable holding quotes and line breaks is accepted; that the
  version API returns `VIZ_APP_FILES` as the code reads it; request billing for assets.
- The app in a browser under the policy as the gateway sends it.
- A real `npm ci` and Vite build through `app.mjs` (heavy; another builder was in `app/`); the build
  path was exercised with toy repositories only.
- The full `mutants-app.mjs` run (94 mutants) and the full gateway suite; I ran 19 script mutants and
  9 gateway mutants.
- Chromium's handling of headers on a 304 (m-3) is from memory.
- `deploy/test/release.test.mjs`, `upgrade-production.test.mjs` and the other suites were not rerun.

## Suggested row for design/REVIEW.md

| `reviews/d74-gateway-app.md` | Adversarial review of D74 (2026-11-27, at `7a4cdfe`): viz-gateway serves the web app's build by `app/serve.json`; raw requests against local workerd, the kept-files chain, the build gate, D69 interplay, mutants on a scratch copy | 0 blockers, 2 majors (M-1: the app's build runs third-party code that can read the Cloudflare token from a parent process and rewrite files later steps run, although the variable is removed from its environment; reproduced with a dummy, and no test holds even the stated property; M-2: the first contact with Cloudflare would be production, in a forward-only release, and "a stage first" is enforced by nothing), 10 minors (the commit gate fails open without git; a linked install accepted for production unrecorded; the entity tag ignores the document's headers; serve.json can put files in front of the API; a build over about 50 files silently keeps nothing; no way to drop a bad build's files from the workflow; asset bytes not compared after upload; a failed app check hides the data check; twelve mutants survive; the export is built inside the checkout), 7 nits; locally no path gets a page in place of the JSON 404 and no 404 is cacheable; approve with changes | (the builder's dispositions) |

## Dispositions

By the builder, 2026-11-27, after the review; not by the reviewer. Changes are in `deploy/`,
`.github/` and `design/`; nothing in `app/` or `design-system/` was edited. Nothing was deployed
and no Cloudflare API call was made; every command ran with `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` removed from its environment, and every credential in a test is the dummy
`DUMMY-not-a-credential-123` or the fakes' `fake-token-not-a-credential`. No test, script or
experiment reads another process's environment. Commands, results and the mutant table:
`deploy/README.md`, "How it was verified", first entry. Mutants ran on a copy of the tracked tree
in the scratch directory, never in the shared tree.

Tests named below are in `deploy/test/` unless a path says otherwise.

### Majors

**M-1. Fixed: the build runs in a job that holds no secret; the job that holds the token takes its
output as data.**
- *The boundary.* `.github/workflows/deploy.yml` has a job `app-build` (no `secrets.`, no
  `environment`, no `env`, `contents: read`, `persist-credentials: false`) that runs
  `node deploy/app.mjs handover` and uploads `dist/` and `build.json` as an artifact. The `deploy`
  job downloads it outside the checkout and `deploy.sh` runs `app.mjs build --from`, which reads,
  hashes and copies it and runs no `npm` and no code of `app/` or `design-system/`.
- *What the deploy job verifies* (`lib/app.mjs` `readHandover`, then `stampProblems` in
  `configure.mjs` and `release.mjs` as before): the description is of this release; its source
  hash is the hash of the deploy job's own checkout (git lists the files, SHA-256 of their bytes;
  nothing of the app is executed); its serve.json hash is the checkout's; for production with a
  commit it says that commit, clean, listed by git, installed from the lockfiles; `dist/` reads by
  serve.json's rules and every file has the path, size and SHA-256 the description names, the
  document and the build hash too.
- *"Handed in for production"* now means: taken only with a stamp whose source hash is this
  commit's (`via` `export` or `handover`); a bare `dist/` (`prebuilt`) stays refused. D74 point 3
  is rewritten to say so.
- *The other installs.* No job has a secret in its `env`; the Cloudflare credentials are on the
  steps that call Cloudflare (`Migration acknowledgements`, `deploy/deploy.sh`; in `rollback`,
  `Roll back`), and `SMOKE_KEY` on the two smoke steps. The deploy job's installs are
  `deploy.sh --install-only` in a step without secrets, with `--ignore-scripts`; checked from a
  fresh export that wrangler, workerd and esbuild start and that every deployed Worker bundles
  (`wrangler deploy --dry-run`) after such an install.
- *`deploy.sh` by hand.* It runs `handover` and the installs with every credential removed from
  their environment by name, then stages from the handover exactly as the workflow does. The
  README says this is weaker than the job boundary and why. Under `GITHUB_ACTIONS` it refuses to
  build at all.
- *The README sentence* is gone; "Who can read the Cloudflare token" replaces it and states the
  remaining trust: the app's locked dependencies decide what the page is (the handover shows an
  intact output of the job that says it built these sources, not a faithful one); the deploy
  tooling's locked dependencies run beside the token (no install scripts, but wrangler loads their
  files); GitHub's separation of jobs is taken from its documentation.
- *Tests.* `app.test.mjs` "M-1: the build's own environment holds no credential…" (a toy build
  notes which names in its own environment look like credentials and whether any value is the
  dummy: none; `handover` refuses beside one and prints no value); "M-1: a build handed over … is
  taken as data and only when it verifies…" (17 ways it may not be what it says, each refused,
  nothing staged, no build run); `workflow.test.mjs` "M-1: the web app is built in a job that is
  given no secret…" (the workflow's text, job by job and step by step) and "D74, M-1: deploy.sh,
  run…" (the real script with stub `node` and `npm` that record whether a dummy credential was in
  their environment).
- *Not shown, and why.* The workflow has not run on GitHub in this shape. That a runner per job
  and environment-scoped secrets separate the two jobs is GitHub's to guarantee.

**M-2. Fixed with a mechanism, and its limit said: the first production release with the app is
refused unless a stage is recorded to have gone before it, or the owner overrides.** No stage was
deployed.
- `release.mjs` `appStageProblems`, asked by `deploy` and `plan` for production when the
  viz-gateway serving now has no app: refused (exit 3, nothing uploaded) unless
  `deploy/records/app-stage-evidence.json` has a complete entry (stage, release, passed smoke test
  with the app checked, by-hand checks 6 to 10 each `pass` with a note, who vouches) whose
  `serving` equals this release's serving fingerprint (the gateway's source, the asset
  configuration, `_headers`, the document's headers, wrangler's version).
- Override: `VIZ_APP_WITHOUT_STAGE_EVIDENCE="<reason>"`, the workflow's
  `app_without_stage_evidence` input; logged as a WARNING, written to the release record
  (`appStage.override`) and the job summary.
- `scripts/app-stage-evidence.mjs` writes a stage's entry from what its deploy left in
  `generated/` (`release.json`, and `smoke.json`, which `smoke.mjs` now writes), with the by-hand
  checks empty, so it does not count until a person has made them.
- *Is it theatre?* The entry is a statement a person commits; the tool checks its shape and its
  fingerprint and cannot prove the stage existed. I judged it worth having because the default
  changed: with no file (today) the first release is refused, so "a stage first" is what happens
  unless someone writes a reason into a release record. **Consequence the owner should expect:
  the push that merges this will not deploy; its job ends red at the plan, production
  untouched**, until evidence is committed or the workflow is dispatched with the override.
- Also put where the owner sees it: the pull-request template has the four boxes; README "A
  stage before production"; D74 point 6 and "would change if" (when to widen the rule, and what
  would show it to be theatre).
- *Tests.* `app.test.mjs` "M-2: what counts as a stage that went before…", "M-2: the first
  production release with the web app is refused…" (through `planOnly` and `deploy` against the
  fake account: refused with nothing uploaded; with evidence; with the override; the next release
  and a stage not asked), "M-2: the entry of a stage is written…"; `upgrade-production.test.mjs`
  now shows the first release over fb77292 refused by this one problem and passing with the
  override, which its record carries.

### Minors

| | Disposition | Held by |
|---|---|---|
| m-1 | **Fixed.** `sourceGateProblems`: production with a commit refuses sources git did not list, before a build (`app.mjs`, both commands) and on the stamp (`stampProblems`: the checkout now, and how the stamped build's sources were listed). The message carries git's own reason | `app.test.mjs` "m-1: production with a release that is a commit fails closed…" (no work tree; no usable git; a stage and a non-commit release still allowed) |
| m-2 | **Fixed, both ways.** The stamp, the handover, the manifest and the record say `install: "ci"` or `"linked"`; production with a commit refuses a linked install before building, in a handed-over build, and on the stamp | "m-2: a linked install … is recorded as what it is, and refused…"; the stamp case in "a stamp is refused when…" |
| m-3 | **Fixed.** The entity tag is a hash of the document's bytes and its headers; the build hash covers serve.json's rules (documents, prefix, files, the three header blocks, content types; not the comment). A headers-only release is another build: it also ages kept files by one, which is said | "staging: … the document goes into VIZ_APP…" (a tighter policy: same bytes, another tag, another build; a comment: the same) |
| m-4 | **Fixed, from one list.** `deploy/gateway/src/api-roots.json` is the API's part of the path space. The gateway's `routeOf` routes nothing outside it and `parseApp` refuses a document inside it; `readServe` reads the same file and refuses an asset prefix, file or document inside it. `/mcp.svg`, which the review listed, is accepted: it is not under `/mcp` and sits in front of no route | "serve.json: nothing of the app lies in the API's part of the path space…"; vitest `gateway/test/app.test.ts` "the API has a part of the path space of its own…" (the same table of paths in both) |
| m-5 | **Fixed.** `appFilesVar` says `named: false`; `app.mjs` logs a WARNING with what is lost and when; the stamp (`filesVar`), manifest, record (`filesNamed`), `plan`, `deploy.sh`'s summary and the job summary carry it; the kept files that had to go are in `dropped` with that reason. D74 "would change if" names the limit | "a build whose own file list does not fit VIZ_APP_FILES says so loudly…" |
| m-6 | **Fixed.** Workflow input `app_drop_kept_files` sets `VIZ_APP_NO_CARRY=1`; README says this is how a bad build's files are dropped. A bound in time: each kept file carries the day it stopped being current and leaves `keep_days` (30, `workers.json`) later, judged at every release, also one of the same build; a day in the future or no day counts as today | "which files a new build keeps…", the keep_days part of "app.mjs build keeps the serving version's files…"; `workflow.test.mjs` (the input reaches `deploy.sh`; `--no-carry` is passed and said in the summary) |
| m-7 | **Fixed.** The manifest carries every file's SHA-256 (`fileHashes`) and the kept files'; `checkApp` fetches every file of the version, lazy chunks and kept files included, and compares bytes and headers | `app-http.test.mjs` "smoke checkApp: every file of the version is asked for and compared byte for byte…" |
| m-8 | **Fixed.** `smoke()` runs the data check whatever the app check found and reports both; the hint says the previous gateway comes back whole, names `/api/echo` and "no web app at all" for the first release, and points to "Rolling viz-gateway back alone" | `app-http.test.mjs` "smoke: a failed app check does not hide the data check…" |
| m-9 | **Tests added for each named survivor; one reported equivalent** (table below). `scripts/mutants-app.mjs` now says to copy the whole tracked tree (`git archive`), names why (`dashboard/`), has a `--check` mode, and holds 200 mutants (94 before) | below |
| m-10 | **Fixed.** The export is built in a new directory under the system's temporary directory, refused if that lies inside the checkout, and removed afterwards (also after a failed build); only the staged result is under `generated/` | "m-10: the export is built outside the checkout…" |

**m-9, survivor by survivor.**

| Mutant the review found alive | Now |
|---|---|
| the build command keeps the Cloudflare credentials | killed: "M-1: the build's own environment holds no credential…" |
| a stamp that names another staged directory is accepted | killed: "a stamp is refused when…" (a faithful copy elsewhere, named by the stamp). Also changed: the directory hashed is the one that is uploaded, whatever the stamp names (its own mutant, killed by the same test) |
| files are carried although two versions serve at once | killed: "what serves now is read for its files only when one version serves…" |
| production fetches kept files from the workers.dev pattern | killed: "app.mjs build keeps the serving version's files…" (production asks `https://<domain>` and never asks for the subdomain) |
| a kept file is fetched following redirects; from any HTTP status | killed: `app-http.test.mjs` "a kept file is asked for as a browser would get it…" (`defaultFetchFile` itself, against a local server: 307, 206, 500, 404) |
| a kept file over 25 MiB | killed: "a kept file is fetched from the deployment serving now…" (25 MiB + 1 with the recorded hash) |
| a link among the sources is exported and hashed | killed, with git and without: "sources: a link is never a source…" |
| git is asked with the inherited `GIT_` environment | killed: the same test (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`) |
| the smoke test follows redirects; does not ask `/explore/`; does not POST to a document | killed: `app-http.test.mjs` "smoke checkApp: redirects are not followed…" |
| the document is tried before the API router (`handle`) | **equivalent, not killed**: `parseApp` refuses any `VIZ_APP` that names a document in the API's roots, so no path can be both; the mutant on that refusal is killed (vitest) |

**Mutants after the fixes** (`deploy/README.md`, "How it was verified", has the table). `scripts/mutants-app.mjs`: 200 of 200 killed, not in one run (106 new; the 94 from before in two passes). Three things on the way are reported rather than hidden:
- One new mutant first gave no result: with it, a test's failed comparison printed a 25 MiB buffer and the run was killed for memory. The test was fixed; rerun: killed.
- One mutant from before this change survived both passes: "smoke: asset headers and content types are not compared". The smoke test's new second loop had made the existing cases insufficient; three per-file cases were added; rerun: killed.
- `gateway/scripts/mutants.mjs`: 52 of 52 killed (3 new). Two further mutants, tried by hand, **survive and are equivalent**: `routeOf` without its `underApiRoot` guard, and `parseApp` without `routeOf(p) === null`. Every route of today's table lies inside the roots, so each condition implies the other; the guard holds a route added later.

### Nits

| | Disposition |
|---|---|
| n-1 | **Fixed (text).** README's table says the asset layer's 307 and 405 carry the path's `_headers`, that this is the mechanism behind D74 (b)'s cacheable 404, and why it is harmless here |
| n-2 | **Fixed (text).** `index.ts` no longer says "as it was sent": the path is compared after the URL parser removed dot segments; the README table has a row for it |
| n-3 | **Fixed.** `readBuild` refuses a `src` or `href` that is not double-quoted (it could not be checked), and reads one with spaces around `=`. Test: "a build is read by serve.json's rules…" |
| n-4 | **Fixed.** A kept path that needs a directory where the build has a file (or the reverse) is dropped and named; the build does not fail. Test: "a kept file that does not fit VIZ_APP_FILES…" |
| n-5 | **Left open**, as the review says it is serve.json's and the backends' to decide: no policy on assets, no `nosniff` on the gateway's JSON and forwarded answers. Listed in README "Not implemented"; not checked in a browser |
| n-6 | **Fixed.** `persist-credentials: false` on all three checkouts of `deploy.yml`; `workflow.test.mjs` holds it |
| n-7 | **Fixed (text).** D74 "would change if": an app release that fixes a security defect adds a floor for the build; README "Not implemented" says there is none today |

### What changed besides the findings

- `STAMP_VERSION` is 2 (a stamp left in `generated/` by an older run is refused as such).
- `gateway/test/app.test.ts` listed `/dashboards` among paths that are never a document; the
  app's serve.json made it one during the review. The list now leaves out whatever serve.json
  lists.
- `deploy/workers.json` `app.needs` gained `dashboard/src`, and `deploy/ci/matrix.mjs` says the
  app needs `dashboard/` ("Open", below).
- Two snapshot commits of the shared tree (`0aa0f7a`, `4b6e024`, "Work in progress") took
  `deploy/` and `.github/` while this work was under way. Neither holds a mutant, and neither is
  the state reported here; a pull request takes these directories from the working tree as it
  stood when the suites last passed, which is later than both.

### Open, and unverifiable until a stage deploy

- Everything under "Not checked" above still stands; no stage was deployed.
- The deploy workflow in its new shape has not run on GitHub: that `upload-artifact` takes a path
  under `runner.temp` and `download-artifact` restores `dist/` and `build.json` at the same
  relative paths (training knowledge of both actions); that `inputs.app_drop_kept_files && '1' ||
  '0'` evaluates as intended on a push (where `inputs` is empty) and on a dispatch; that a run
  step of the build job has no deploy credential in its environment (it would make `handover`
  refuse, loudly, not leak).
- The stage rule cannot be exercised for real until a stage exists: the evidence script was run
  on fixture files only.
- The mutants were not run as one uninterrupted set; see above.
- **The app's sources moved while this was done**: its dashboards views now import
  `dashboard/src` by relative path. The release's build exports only what `deploy/workers.json`
  lists, so the first real build failed (closed: nothing would have been deployed).
  `app.needs` now lists `dashboard/src`, the CI matrix says the app needs `dashboard/`, and a
  test fails when `app/src` imports from an unlisted directory. The app's builder should know
  that an import from outside `app/` is a change in `deploy/workers.json` too.
- Chromium's handling of headers on a 304 (m-3) remains training knowledge; the fix does not
  depend on it (the tag changes, so the answer is a 200).
