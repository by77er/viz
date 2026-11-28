# Spike s12: does a reload come back to the same place on a real phone?

The v9 design-system review (`design-system/reviews/system-v9/review.md`) rejected v9 on one blocker. At 400 px with a coarse
pointer, a reload in headless Chromium often comes back at the wrong scroll position, with no layout shift. The reviewer saw it in
22 of 34 reloads after touch-scrolling to the end of the Chart preview, each landing 535 px short. When this spike was deployed nobody
had found the cause. This spike puts the same pages where a phone's browser can open them:

- If a phone does it, it is a real defect to find and fix.
- If no phone does it, it is most likely the emulator.

## Status, 26 November: the cause was found without a phone, the blocker is waived, and the phone test has still not been run

A second reviewer found the cause on this machine and waived the blocker (`design-system/reviews/system-v9/second-review.md`). The
three findings below are that review's measurements, not this spike's:

- The miss is made by the measuring tool. Playwright's `hasTouch` makes the pointer coarse through DevTools touch emulation, and the
  document a reload is replacing loses that emulation between its `beforeunload` and its `pagehide`. Its pointer turns fine, every
  `@media (pointer: coarse)` rule stops applying, the page gets shorter (9,659 px to 9,124 px on the Chart preview), and the browser
  records and restores the scroll position of that shorter page (8,859 becomes 8,324: the "535 px short").
- A page that is not viz, with one rule that depends on the pointer, does the same (8 of 8 with a recorder that reads the page at
  `pagehide`).
- With the pointer made coarse in Blink itself (a command-line switch, no touch emulation), the same pages landed where they were in 0
  of 204 reloads. `design-system/tools/audit.mjs` now makes its reload pass's coarse pointer that way.

**What is not known: no real phone has been tested, by anyone.** The switch stands in for a phone and is not one. The test below is
the check the first reviewer asked for, and a reproduction on a phone reopens the blocker, so the pages stay up until the owner has
run it or decided not to. (The blocker also reopens without a phone if the audit's changed reload pass, with the pointer coarse and no
touch emulation, sees a reload land elsewhere.)

- **A reproduction** is a reload that comes back on different content, hundreds of pixels away. A difference of about the height of the
  browser's address bar at the very end of a page is not one (the second review's note, from training knowledge and not measured: a
  phone's address bar reappears on reload).
- If a phone reproduces it, the waiver falls and it is a real defect to find and fix. If none does, nothing changes.

## What is deployed

- **URL:** https://viz-spike-s12-reload.<account-subdomain>.workers.dev (the index; it links the four pages).

> The address above is written with `<account-subdomain>` in place of the account's `workers.dev` subdomain, which is kept out of the repository. `npx wrangler deployments list --name viz-spike-s12-reload` or the Cloudflare dashboard shows the full address.
- **Created on 2026-11-26:** one Cloudflare Worker, `viz-spike-s12-reload`.
  - Static assets only: 12 files, about 720 KB.
  - No script (no `main`), no bindings, no storage, no secrets.
  - `workers.dev` on; preview URLs off; no route or custom domain on any zone.
  - Deployed with `npx wrangler deploy` from this folder (`wrangler.jsonc`). Current version `d6d1904c-ce25-40a1-8f63-d183f34a4d41`.
- **What is in `public/`:** a built design system v9, copied from `design-system/dist/` and `design-system/reviews/system-v9/compositions/`
  after `npm run build`, at the same relative paths, so each page loads exactly the CSS, fonts and scripts it loads in the review:
  - `dist/preview/Chart.html`, the Chart preview;
  - `dist/reference.html`, the reference: every component in both themes;
  - `reviews/system-v9/compositions/charts.html` and `dashboard.html`, the charts and dashboard compositions;
  - `dist/viz.css`, `dist/viz-chart.js`, `dist/viz-press.js`, `dist/fonts/` (the two typefaces and their OFL licences).

  Every figure and name on the pages is the design system's mock data. Nothing comes from the repository's secrets or the owner's
  details. The index page is plain HTML with no script, no tracking and no external requests.
- **URLs:** `html_handling` is `auto-trailing-slash`, so `/` serves the index and each page is served without its `.html`
  (`/dist/preview/Chart`). The `.html` form answers 307 to that. Relative asset paths resolve the same either way.

## The test (about two minutes, on the phone)

Open the URL above. For each of the four pages, do this three times:

1. Open the page and scroll to the very bottom with your finger.
2. Note what is at the top of the screen: the chart, the heading or the line of text.
3. Press the browser's reload button, then wait two seconds without touching the screen.
4. Note whether the page came back to the same place or somewhere else. If somewhere else, note roughly how far: half a screen, one
   screen or several.

Send back the phone, the browser, and for each page the three results. If there is time, repeat the Chart preview about 20 times:
one reload that comes back somewhere else is enough to call it real.

## Cost

- **Worst case: nothing.** Requests to static assets are free and unlimited on every Workers plan, and they do not run a Worker. This
  Worker has no script, so no request is billed as an invocation and nothing uses CPU time. There is no storage or binding to bill.
- **What I verified:**
  - The deploy uploaded assets only: 12 asset files, and a Worker upload of 0.35 KiB with no script in it (`wrangler.jsonc`
    has no `main`). The second deploy uploaded only the changed index.
  - The only trigger is the `workers.dev` address.
  - I did not read usage from the analytics API, so there is no measured usage figure here. The only traffic so far is my own
    verification fetches.

## Verified after deploying

Every page and asset was fetched from the deployed address with `curl`.

| What | Status | Bytes |
|---|---|---|
| `/` and the four pages, at their extensionless addresses | 200 `text/html` | — |
| `viz.css`, `viz-chart.js`, `viz-press.js` | 200, correct content type | — |
| Both `.woff2` fonts and both licence files | 200, correct content type | — |
| Each of the 12 files, at its `.html` address (first deploy, `html_handling: none`) | 200 | identical to the local file (md5 compared) |
| An unknown path | 404 | — |

## Delete it

```
cd spikes/s12-reload-on-a-phone && npx wrangler delete --name viz-spike-s12-reload
```

Not deleted yet (26 November): the phone test has not been run. Keep the pages up until the owner has run it or has decided not to;
then delete the Worker with the command above, and record the phone's result, or the decision not to test, in
`design-system/reviews/system-v9/response.md` and here.

## What narrows the cause (headless Chromium, 400 x 800, mobile emulation with touch)

Measured with a scratch probe on a local server. It is not committed. For each try, the probe opens a fresh context, then
touch-scrolls to the end, then reloads, then reads the scroll position 1.8 s later.

**Corrected on 26 November: the synthetic-gesture result is void.** This section first said that reaching the bottom with
`Input.synthesizeScrollGesture` "reproduced nothing: 0 of 36 tries over three stylesheets". Under touch emulation that gesture does not
scroll the page at all. The second review ran this probe with one line changed to print positions and got "from 0 to 0" in 3 of 3
tries, and its own probe read position 0 at every step on the Chart preview and on a plain page (its E2). The probe here never checked
that the page had moved. So those 36 reloads were made at the top of the page, where a reload cannot land anywhere else, and the 0 of
36 says nothing about the miss. It is not evidence for or against anything.

Measured again here on 26 November with the same probe, one line changed to print the positions, on the Chart preview, three tries
each: the synthetic gesture, "from 0 to 0" in 3 of 3; the touch drags, "from 8859 to 8324" in 3 of 3
(`design-system/reviews/system-v9/evidence/second-review-gesture-positions.txt`).

Reaching the bottom with touch drags that end in a fling, as the first reviewer did (`Input.dispatchTouchEvent`), reproduced the miss.
The table below is from those runs and stands as measured.

| Stylesheet (Chart preview) | Came back elsewhere | Where |
|---|---|---|
| v9 as built | 4 of 12 | 535 px short, at 8,324 (the review's number) |
| the four `@media (pointer: coarse)` blocks removed | **0 of 12**, twice | — |
| only the hit-area rule kept (`.vz-button::after` and the like, 44 px) | 0 of 12 | — |
| every coarse rule kept except the hit-area rule | 11 of 12 | 535 px short |
| the first half of the main coarse block removed (the hit-area rule kept) | 12 of 12 | 143 px short |
| the second half of the main coarse block removed | 9 of 12 | 439 px short, again at 8,324 |
| the scroll-driven edge on strips removed | 9 of 12 | 535 px short |
| scroll anchoring off (`overflow-anchor: none` everywhere) | 2 of 12 | 535 px short |

What this says:

- The miss needs the coarse-pointer rules. No single rule causes it: either half of them is enough, and the hit-area rule alone is
  not. This matches the reviewer's finding that it never happens at a fine pointer, where those rules do not apply.
- The rules set where it lands, not whether it happens at all. The landing positions repeat exactly (8,324 in two different variants),
  and the distance changes with which rules are kept.
- The scroll-driven strip edge is not the cause, and neither is scroll anchoring.
- The rates are noisy: 4 of 12 and 11 of 12 on near-identical stylesheets. So bisecting single rules by rate is not reliable, and the
  bisection stopped here.

**A reading withdrawn on 26 November.** This list also said: "How the page was scrolled matters: a drag with a fling reproduces it, a
synthetic gesture does not. That points at the emulator's touch and fling handling as much as at the page." Both halves were wrong.
The synthetic gesture did not scroll (above). And the fling is not needed, nor is a touch. The second review (its E2) measured the miss:

- 11 of 12 with 3 s between the last drag and the reload, and 5 of 12 with 8 s, long after any fling has ended;
- 6 of 6 after a drag that stops before the finger lifts, with no fling;
- 7 of 40 with no touch input at all, the page moved by `scrollTo` from script.

**What the table means, now that the cause is known** (second review, E4 and E6). The first three points are what the mechanism
predicts. The rules that matter are the ones that change the page's height with the pointer type: when the outgoing document's pointer
turns fine they stop applying, and the reload lands short by the difference between the page's coarse height and its fine height. That
is why removing the coarse blocks removes the miss, why the hit-area rule alone (which changes no height) is not enough, and why each
variant lands at its own fixed distance. The rates are noisy because the miss also needs the outgoing document to be laid out once
more before it is gone, and whether that happens depends on what else the page is doing; with anything that reads layout at
`pagehide` it happened on every run. That last condition is described and not explained.

The phone result is what could still change this. If a phone reproduces the miss, the mechanism above is not the whole story: continue
on the phone or on remote-debugged Chrome for Android, starting from the two halves of the main coarse block.
