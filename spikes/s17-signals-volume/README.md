# Spike S17: traces and logs at realistic volume, after D81

## Paused (2026-11-28, the owner's budget ran out)

- **No stage was deployed**: nothing named `viz-s17-…` exists, no credential was used, nothing to
  destroy. Grafana was not run.
- **Done**: D81 (`design/DECISIONS.md`), the contract change (`bf`, trace_index bloom, ABI 9), the
  writer (`engine/storage`), the reader (`engine/wasm-query` `tqProbe`, ranges cut, certain rows),
  `query/` wiring and tests, docs. Green: `engine/storage` all suites; `engine/wasm-query` 28 tests;
  `query` full suite 174 of 177 on fixtures regenerated with the D81 writer (the 3 failures were
  tests whose expectations D81 changes; updated, not yet rerun); `tsc --noEmit` clean.
- **Measured here** (native, 66 units = one hour at 700,000 single-span traces): trace by ID
  41.7 MB fetched without filters (refused) vs 2.8–3.4 MB with them; engine 3.6–3.9 s vs 55–106 ms.
- **Left**: rerun the three updated query tests (`signals.test.ts` max_fetch_bytes and
  certain-rows cases, `review-r2.test.ts` long-trace case); Rust and TypeScript mutants on a
  scratch copy (not run); this spike as planned below; Grafana; searches paging `trace_index` in
  waves (search ceiling unchanged); the PR body.

**Status (2026-11-28): planned, not run. Nothing was deployed, nothing was created in the
account, and no credential was used.** The work it verifies (D81, `design/DECISIONS.md`) was built
and measured here first; the session's time-box ran out before the stage. This README is the exact
plan, written before anything is deployed, as AGENTS.md asks.

## What it measures

S10's findings that D81 answers, on Cloudflare (`spikes/s10-signals-trial/README.md`, "The margin",
"Where the read path stops", "What it means"):

1. Trace by ID, with and without a time hint, over a tenant holding about 700,000 single-span
   traces in one hour (S10's run 2 shape, distinct ids, `lcg32`): answered (200, the right trace)
   or refused, bytes and files read (`X-Viz-Bytes-Read`, `X-Viz-Bloom-Files`, `X-Viz-Bloom-Bytes`,
   `X-Viz-Bloom-Skipped`), latency from a client object, query Worker CPU from the tail.
2. The same at S10's realistic shape (12 spans a trace, s10-q) and fat shapes (s10-fat,
   s10-fatattr): answers and `X-Viz-Wasm-Memory-Bytes`, against S10's table.
3. Search over 2 s, 10 s, 1 min and the last hour at that volume: expected to be refused by
   `trace_index` over the margins for single-span traces (D81 does not change it; the refusal's
   bytes are the number to record), and answered at 12 spans a trace for short windows.
4. Logs: S10's blocks C (30,000 rows) and D (45,000), sent at the same moment with timestamps
   hours apart; `{namespace}` over block C's range (refused 422 `max_log_rows` before D81 by the
   pre-check; expected now: answered if C's rows in the window fit 30,000, else refused by the
   engine, never by D's rows), and `count_over_time` over C.
5. TraceQL `rate()` over 10 s at that volume (refused by `max_spans` for 235,913 rows in S10).
6. **Grafana** against the staged gateway (D62's condition for `QUERY_SIGNALS`): Grafana OSS run
   as a separate program in the scratch area (a release tarball fetched at test time, never
   committed; AGPL, so never in the tree), Tempo and Loki data sources provisioned with the stage
   tenant's read key in a 0600 file, pointed at `https://viz-s17-gateway.<account>.workers.dev`.
   Checked through Grafana's own API (`/api/ds/query`, `/api/datasources/uid/<uid>/health`): the
   data sources' health checks, a Tempo search, trace by ID from a search result (Grafana's default
   sends no time range: the hintless path), TraceQL metrics, Loki `query_range`, label names and
   values, `/series`. Each answer compared with the same call made directly to the gateway.

## Names, timers, worst case (to be confirmed before the deploy)

- From a detached worktree of this branch at the commit the report names, `deploy/deploy.sh
  --stage s17 --expires <now + 3 h>` with `VIZ_SKIP_NPM_CI=1 VIZ_WASM_PREBUILT=1` (both modules
  built from that commit with `CARGO_BUILD_JOBS=2`), `VIZ_STAGE_VARS` setting only viz-s17-ingest
  `INGEST_SIGNALS=traces,logs` and viz-s17-query `QUERY_SIGNALS=traces,logs`. Every resource named
  `viz-s17-…`, workers.dev only, no route, no custom domain; production untouched.
- S10's load Worker as `viz-s17-load-client` (`spikes/s10-signals-trial/driver.mjs load-up` with
  the stage name changed), `DEADLINE` the stage's expiry; no alarm, no cron.
- Inventory before and after with `spikes/s11-large-ledger/inventory.mjs` (read-only).
- **Worst case, modelled** (Workers Paid list prices as read for S10, ignoring allowances), S10's
  bound scaled by the larger load (two realistic runs of 700,000 spans, the query matrix above
  repeated 5 times, Grafana's calls): Worker requests 150,000 (US$0.05), CPU 8 M ms (0.16), DO
  requests 700,000 (0.11), DO duration 120,000 GB-s (1.50), SQLite rows 700,000 written and 70 M
  read (0.70, 0.07), R2 80,000 class A and 300,000 class B (0.36, 0.11), R2 storage 3 GB for 3 h
  (< 0.01), queues 90,000 (0.04), KV 0.30: **under US$3.50**. S10 cost US$0.064 against a
  US$2.50 bound.
- Afterwards: `driver.mjs load-down`; `resources.mjs destroy --stage s17` from the worktree; the
  inventory difference recorded here; cost for the window from the analytics API
  (`spikes/s10-signals-trial/analytics.mjs`), labelled "measured on Cloudflare" with its window;
  keys shredded; Grafana's directory deleted.

## Results

None yet.
