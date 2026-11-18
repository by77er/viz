# Fixture dashboard

The dashboard the speed budgets in `project/README.md` ("Responsiveness and feedback") are measured on.

| File | What it is |
|---|---|
| `dashboard.json` | The specification: eight panels (four figures, charts of 3, 8, 36 and 200 series, a second 8-series chart, a 7-day backtest, a 30-row table), the fixed clock (15:16 on 18 Nov 2026), range and step. |
| `generate.mjs` | The data: a seeded generator, the same recipes the Chart preview draws. `node fixtures/generate.mjs pods` prints one panel's JSON. The same seed always gives the same numbers. |
| `build.mjs` | Writes `dist/fixture/index.html` and `dist/fixture/data/*.json`: the dashboard built from the system's components and the reference chart, with a query field, a Run button that fetches every panel again, and a charts/tables switch. |
| `speed.json` | The scenario `tools/speed.mjs` runs on it: every budget row, including typing, the crosshair, and the 36- and 200-series cases. |

```
node tools/build.mjs && node fixtures/build.mjs
node tools/speed.mjs fixtures/speed.json            # 20 runs, 4x CPU, Fast 4G; prints p75, median, worst against each budget
```

**What a number from here means.** Measured on `dist/fixture/` it is the cost of the design system's own CSS and reference chart: a floor, and a regression check for the system. It is not the application's number. An application is measured by serving the same specification and data under its own route (`/fixture`) and running the same scenario file with its selectors; report which of the two a number is.

The many-series cases are required: the first application review found every budget met at 4 series and three missed at 36.
