# Paused 2026-11-27, resumed 2026-11-28: where everything stands

Written for whoever resumes this work (the owner said about a week). It lives on the development
branch only and is deleted when the work it lists is done; it is not for `main`. The session's
scratch directory does not survive the pause, so everything needed is in the repository.

## Waiting on the owner

1. ~~A stage deploy, or an override~~: the owner allowed stage deploys, standing (2026-11-28, in
   `AGENTS.md`). S13 ran and passed; pull request #9 merged (`375e9ba`) and deploys from `main`.
2. ~~The GitHub `production` environment~~: set up by the owner (2026-11-28).
3. **Rotate the Cloudflare API token** (printed in one agent's output on 2026-11-27). Not yet confirmed.
4. ~~Delete `viz-spike-s0-do-billing`~~: done 2026-11-28.
5. Optional: open the S12 page on a real phone (`spikes/s12-reload-on-a-phone/README.md`); it is the
   one thing that would reopen the waived design-system blocker. Then that Worker is deleted.
6. Asked 2026-11-28: whether the product should move from `vis.bitcru.sh` to `viz.bitcru.sh`.
7. Exploring (2026-11-28): people, individual and team workspaces, invite codes
   (`design/proposals/accounts-and-teams.md`, being written).

## What is deployed on Cloudflare

| Name | What | Until |
|---|---|---|
| production (`viz-gateway` and six more, `vis.bitcru.sh`) | release fb77292 (pull request #8): the API only, OAuth without rate limits | replaced when #9 merges and deploys |
| `viz-preview-app` (workers.dev) | spike S14: the web app's build (Explore, dashboards read-only, Help, Settings) on the app's **mock** API | answers 410 after 2026-12-04; delete when the gateway serves the app |
| `viz-spike-s12-reload` (workers.dev) | static pages for the phone test | until the owner has tested or declined |
| `viz-spike-s0-do-billing` | deleted 2026-11-28 | |

No stage exists. Nothing runs on a timer.

## Pull requests

- **#9** (`claude/cloudflare-observability-platform-ibaqya-release2`, head `f93806e`): OAuth rate limits,
  deploy safety, traces and logs behind a flag. CI green on that head. Not merged: items 1 and 2
  above. The session is no longer subscribed to its events; subscribe again on resuming.
- **The web UI: not opened yet.** It stacks on #9 and carries `app/`, `design-system/`, the D74 changes
  in `deploy/` and `.github/`, `design/` (which on this branch is #9's text plus what is new since:
  commit `7a4cdfe`), `dashboard/` as the app now imports `dashboard/src`, `spikes/s12` and `s14`,
  `THIRD_PARTY.md`. Its description must record the design system's waived blocker with its residual
  uncertainty (`design-system/reviews/system-v9/confirmation.md`, c8). When assembling, compare with
  `git diff --no-renames`, and take each directory from the green commit named below.

## Green states on this branch (each reported by its builder; commit names the evidence)

| What | Commit | Notes |
|---|---|---|
| design system v9 | `54f524c` | approved by a confirmation review; blocker B1 waived, not withdrawn; minors c1 to c8 open (`reviews/system-v9/confirmation.md`) |
| web app on v9 (Explore, Help, Settings, sign-in by key) | `cc50ea2` | **design review: reject** (`design-system/reviews/app-v9/review.md`, `58f459e`) |
| dashboards, read-only | `7469d5a` | not design-reviewed; two rows over the speed budget (`app/README.md`) |
| gateway serves the app (D74), with the review's dispositions | `3134cbc` | adversarial review `design/reviews/d74-gateway-app.md`; nothing deployed; the new workflow shape has not run on GitHub |
| design text | `7a4cdfe`, then `384e513`, `3134cbc` | `design/artifact/viz-design.html` is edited but the published page was not republished (do it after the merge) |

Commits titled "Work in progress" are snapshots and are not green.

## Resumed 2026-11-28

Three builders run under a shared lock for heavy jobs (`flock` on the scratch directory's
`machine.lock`), so browser timings do not overlap: the app's review fixes are being verified (mutants,
suites, images, response.md); B1 is being re-measured with a harness that no longer counts DevTools'
own copy of the body, and fixed with identical rendering (or a waiver request written); the monitors
view (list, one monitor, acknowledge, silence with undo) is built in a separate worktree and merged
afterwards as a patch. The owner's decisions above are still open.

## In progress when paused

- **App fixes for the design review** (commit `aa120dc`, not green): B2, B3, M1, M2 and six minors are
  written and pass their new checks (tsc, 230 unit tests, token check and build pass). Not done: the 23
  mutants are written and not run, the before/after images are not remade (M3), `e2e/app.cjs` was not
  rerun whole, `errors` and `prod` not run, no speed measurement. State and the steps to resume:
  `design-system/reviews/app-v9/response.md`, "Paused 2026-11-27".
- **B1, results with many series paint late: not fixed.** Nothing was applied to the chart or the app.
  `design-system/reviews/chart-speed/` holds the profile, the measurements and unproven patches
  (`PR.md`, "Paused 2026-11-27"). The patch in hand moves desktop 200 series from 135 to 118 ms after the
  body is read (budget 100; measured here under load), and pixel identity is not proven (5 stray pixels
  unexplained). The builder's view of the real fix: fewer passes over the values (align each series to
  the grid as the body streams; typed arrays through the chart interface, which is a contract change),
  and even then the 200-series row is near the limit. About 70 ms of "from the last byte" at 200 series
  is DevTools' own copy of the body under the harness; whether that definition should count it is a
  decision for the owner. If the budget cannot be met at 200 series, the route the rubric allows is a
  waiver by a second reviewer, stated in the pull request.

## Next, in order

1. Finish the app fixes and B1; apply `chart-speed/app.patch` if there is one; run every app suite once.
2. One design re-review covering Explore and dashboards (images: `design-system/reviews/app-v9/compare/`,
   `design-system/reviews/app-dashboards/`), by a reviewer who did not write them. Only blockers and
   majors hold the pull request.
3. Open the UI pull request on top of #9; after the owner's decisions, stage, merge, check
   `https://vis.bitcru.sh/` and `/healthz`, republish the design page, delete `viz-preview-app`.
4. Then: a monitors and alerts view (the ruler's `/api/v1/monitors` API exists); `deploy/README.md`,
   "Needed changes in app/" (a failed chunk shown as "viz was updated", noticing a new build, versioned
   browser storage, Playwright in a lockfile); the design system's tool minors (the reload pass exits 0
   on zero reloads; `shots.mjs` still uses touch emulation; re-measure the desktop theme change, which
   sits at its 100 ms budget); dashboards' two over-budget rows and the eleven needs it lists for the
   design system.
5. Queued behind #9: the S10 follow-ups, turning on `QUERY_SIGNALS` (S10 on ABI 8, Grafana against a
   stage), the ledger cap to 64 MiB with a rollback floor, strict shard registration.

## Working rules learned this week (beyond `AGENTS.md`)

- Run every command of a builder or reviewer with the Cloudflare credentials removed
  (`env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID`), never read `/proc/*/environ`, and use dummy
  values in tests about secrets. Only an actual deploy holds the token.
- Never read a scroll position or size across a reload under Playwright's `hasTouch`
  (`design-system/reviews/system-v9/second-review.md`); count every layout-shift entry.
- Time-box builders (about two hours) and take each speed measurement once, alternating before and
  after; hours of repeated series on a shared machine produced little.
- `node --test test/` does not start on Node 22.23 in `deploy/`; use
  `node --test --test-concurrency=2 'test/*.test.mjs'`.
- CI runs on every push to `claude/**` branches.
