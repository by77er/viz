## What changed and why

## How it was verified

<!-- Commands run and their results. Say what was not tested. -->

**Durable Object migration?** If this adds a `migrations` tag, the commit that lands on main needs a `Migration: viz-<worker>@<tag>` trailer, or the deploy stops before promoting (deploy/README.md).

**First release with the web app?** Merging to main deploys production. While the viz-gateway serving there has no web app, the deploy is refused before anything is uploaded unless a stage went first (deploy/README.md, "A stage before production"). Delete this paragraph once production serves the app.

- [ ] Deployed to a stage from this branch (`deploy/deploy.sh --stage <name>`), smoke test passed with the web app checked: <!-- stage, release, date -->
- [ ] By-hand checks 6 to 10 made, each with what was seen, and the entry committed in `deploy/records/app-stage-evidence.json` (`node deploy/scripts/app-stage-evidence.mjs --stage <name> --by "<who>"`), for the serving code as it is in this pull request
- [ ] Stage deleted (`node deploy/resources.mjs destroy --stage <name>`)
- [ ] Or: the owner will dispatch the Deploy workflow with `app_without_stage_evidence` and this reason: <!-- reason; it is logged and recorded in the release -->

## Design change?

<!-- Delete this section if the change does not alter what a person sees or how they operate the interface. -->

**Who is looking, and what are they trying to do:**

**Before and after** (both themes, 1440 and 400 px, same data and state; see `design-system/README.md`):

| View | Before / after |
|---|---|
| | |

**States covered:** loading · empty · error · partial · focus

**New tokens or components, with reasons:**

**Speed** (input response, view change, first result paint; before and after, and how measured):

**Token check** (`node design-system/tools/check.mjs <paths>`):

**Design review verdict:** <!-- approve / approve with changes / reject, by a reviewer who did not write the change; findings against design-system/project/review.md -->
