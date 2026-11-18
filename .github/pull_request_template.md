## What changed and why

## How it was verified

<!-- Commands run and their results. Say what was not tested. -->

**Durable Object migration?** If this adds a `migrations` tag, the commit that lands on main needs a `Migration: viz-<worker>@<tag>` trailer, or the deploy stops before promoting (deploy/README.md).

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
