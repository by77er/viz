# Fixture dashboard

The dashboard the speed budgets in `project/README.md` ("Responsiveness and feedback") are measured on.

| File | What it is |
|---|---|
| `dashboard.json` | The specification: eight panels (four figures, charts of 3, 8, 36 and 200 series, a second 8-series chart, a 7-day backtest, a 30-row table), the fixed clock (15:16 on 18 Nov 2026), range and step. |
| `generate.mjs` | The data: a seeded generator, the same recipes the Chart preview draws. `node fixtures/generate.mjs pods` prints one panel's JSON. The same seed always gives the same numbers. |
| `build.mjs` | Writes `dist/fixture/index.html` and `dist/fixture/data/*.json`: the dashboard built from the system's components, the reference chart and the press script, with a query field, a Run button that fetches every panel again, a theme switch, a Share… menu, a second view (Pods) whose data loads when it opens, stats read from the charts beside them (marked `data-figure`), and on each chart panel a Chart/Table switch (the control screens have; v4's page-wide switch was not). Each chart reserves its height from `--legend-rows` and `--legend-notes`; a panel's age appears only once something is drawn; tables state how many rows of how many. `?delay=ms` holds every response that long. |
| `speed.json` | The scenario `tools/speed.mjs` runs on it at 1440 x 900 with a fine pointer, one or more rows per budget row: a press on Run (the fill as painted), typing, the crosshair at 3, 36 and 200 series, legend toggles and one panel's form at 36 and 200 series, opening the Share… menu, changing the theme, moving to the Pods view (its shell and waiting state; its data is not loaded until it opens), running a query (the request sent and the button busy), response to paint at 36 and 200 series, layout shift on load and when the page loads scrolled to the 36-series chart with its data 800 ms late, and the worst interaction. |
| `speed-phone.json` | The same at 400 x 800 with a coarse pointer and touch: every press and tap by touch events (a finger's press is judged by the fill painted while it is held), the crosshair by touch drag, and layout shift loaded scrolled to each chart. |

```
node tools/build.mjs && node fixtures/build.mjs
node tools/speed.mjs fixtures/speed.json            # 20 runs, 4x CPU, Fast 4G; prints p75, median, worst and the load against each budget
node tools/speed.mjs fixtures/speed-phone.json      # the same on a phone layout
```

**What a number from here means.** Measured on `dist/fixture/` it is the cost of the design system's own CSS and reference chart: a floor, and a regression check for the system. It is not the application's number. An application is measured by serving the same specification and data under its own route (`/fixture`) and running the same scenario file with its selectors; report which of the two a number is.

The many-series cases are required: the first application review found every budget met at 4 series and three missed at 36.

**v9: what the page draws changed without a change to this folder.** Before v9 the `hidden` attribute did not hide a `.vz-chart` or a `.vz-page` (their own `display` won over the browser's), so this page drew the table panel's hidden chart as an empty box 265 px tall above its table, and the Pods view, hidden, below the dashboard (the page was 4,792 px tall at 1440 px; it is 3,294 px). `.vz [hidden]` now hides (`project/README.md`, Layout). So the page restyles and lays out fewer elements than v8's did, and "Move to a view whose data is not loaded" now shows a view that was hidden, where before it was already drawn: a v8 and a v9 number on this page are not the same page. `reviews/system-v9/response.md` measures both and separates this from the other changes.
