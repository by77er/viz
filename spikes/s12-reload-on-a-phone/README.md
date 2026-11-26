# Spike s12: does a reload come back to the same place on a real phone?

The v9 design-system review (`design-system/reviews/system-v9/review.md`) rejected v9 on one blocker. At 400 px with a coarse
pointer, a reload in headless Chromium often comes back at the wrong scroll position, with no layout shift. The reviewer saw it in
22 of 34 reloads after touch-scrolling to the end of the Chart preview, each landing 535 px short. Nobody has found the cause. This
spike puts the same pages where a phone's browser can open them:

- If a phone does it, it is a real defect to find and fix.
- If no phone does it, it is most likely the emulator, and a second reviewer can waive it with this as the record.

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

Not deleted yet: the owner tests first. Delete it once the phone result is recorded in the v9 review's response.

## What narrows the cause (headless Chromium, 400 x 800, mobile emulation with touch)

Measured with a scratch probe on a local server. It is not committed. For each try, the probe opens a fresh context, then
touch-scrolls to the end, then reloads, then reads the scroll position 1.8 s later.

Reaching the bottom with `Input.synthesizeScrollGesture` reproduced nothing: 0 of 36 tries over three stylesheets. Reaching it with
touch drags that end in a fling, as the reviewer did (`Input.dispatchTouchEvent`), reproduced the miss.

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
- How the page was scrolled matters: a drag with a fling reproduces it, a synthetic gesture does not. That points at the emulator's
  touch and fling handling as much as at the page.
- The rates are noisy: 4 of 12 and 11 of 12 on near-identical stylesheets. So bisecting single rules by rate is not reliable, and the
  bisection stopped here.

The phone result decides what happens next. If a phone reproduces it, continue the bisection on the phone or on remote-debugged Chrome
for Android, starting from the two halves of the main coarse block.
