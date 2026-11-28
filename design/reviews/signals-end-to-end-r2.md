# Re-review of D62: traces and logs read under a margin and a byte budget

Reviewer: the same adversarial reviewer as `review-signals.md`, given no reasoning beyond the
repository and the coordinator's summary of the change. I was read-only on the shared tree, and every
reproduction ran in `/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-signals/r2/`.
At most one process ran at a time, each under 1.4 GB of heap. No Cloudflare calls and no commits.

## Scope

- **Commit read:** `0e75337` (which includes `d81ef84` and `a623ebb`) on
  `claude/cloudflare-observability-platform-ibaqya`.
- **Code read:**
  - D62 as rewritten, DESIGN §6.4, and `contracts/engine.ts` `SignalBudget`.
  - `query/src/signals.ts`, `sigparams.ts`, `sigroutes.ts`, `index.ts`, `config.ts`.
  - The query README sections "Memory", "Completeness" and "Grafana", and its Known risks.
  - `engine/wasm-query/src/traces.rs`, `logs.rs` and `sigfiles.rs` (charges); `engine/traceql/src/metrics.rs`
    (accumulators and histogram output).
  - The tests `query/test/completeness.test.ts` and `memory.test.ts`.
- **Modules used:** the module query uses, `engine/wasm-query/js/viz_query.wasm` SHA-256 `b3761a9c…`
  (ABI 7, built 13:06 UTC, after the last change to `engine/wasm-query/src/*.rs` that is not a test,
  12:48). This is the SHA the query README pins. Flush: `viz_engine.wasm` `73b2eb49…`.
- **How the reproductions run:** they drive the engines through their own TypeScript bindings in Node 22.
  They mirror `traceRounds` and `capsBeforeFetch` from `query/src/signals.ts` line for line (`r2/lib.mjs`),
  over files made by edge's decoders and the flush engine.
- **Not run:** query's own vitest suites (workerd), and anything on Cloudflare.

## The first review's findings, re-run

| Finding | Re-run on `0e75337` | Status |
|---|---|---|
| M-1 (completeness) | `search-hull2.mjs` | **Fixed as now stated.** With the 2 h margin, `{ }` and `{ trace:duration > 1h }` equal the engine over every span, pruning on and off. With a 1 h margin both differ, identically on and off, as D62 says. |
| M-2 (memory, the review's inputs) | `fat-rerun.mjs` | **Fixed for those inputs.** 1,000 and 2,000 spans with a 180 KB resource: 200 at 4.6 and 5.4 MiB of WASM memory (were 176 and 349). 400 lines of 200 KB: 422 `max_decoded_bytes` at 38.7 MiB (was 158 MiB and a 200). See R2-M1 and R2-M2 for what the budget still misses. |
| m-3 (whole tail) | reading | **Now stated** as a limit in D62 "Cost of it" and DESIGN §6.4. The behaviour is unchanged. |
| m-4 (Loki and Grafana) | reading, `sigparams.ts` | Loki integers of ten or fewer digits are seconds (cited to Loki's v2.8 reference). Loki errors are plain text (secondary sources, labelled). `/api/echo` answers, but the gateway does not route it yet (R2-m4). |
| Outside D62, for the record | `rerun-*.mjs` | Fixed in code: the first review's M-3 (edge decode: 2 MiB and 4 MiB hostile bodies now grow the heap 5.3 MiB, were 117 and 229), M-5 (control refuses `tenant/acme_prod` and names `tenant/acme-prod`), B-1 (dropping `trace_days` or `log_days` now needs `confirmShorter`) and m-1 (a bad signal field no longer stops metric retention). M-4 is now D69, which I did not review here. |

## Findings by severity

Counts: **0 blockers, 4 major, 5 minor.**
- Reproduced here: R2-M1, R2-M2, R2-M3 and R2-M4(a).
- Modelled: R2-M4(b).
- From reading: R2-m1 to R2-m5.

### Major

**R2-M1. Loki `/labels`, `/label/<name>/values` and `/series` run with no byte budget at all.**
Where:
- `query/src/signals.ts` `logLabels` calls `c.engine.lqLabels(…)` without a budget.
- `engine/wasm-query/src/logs.rs:354–414` `do_lq_labels` holds every distinct stream's labels in a
  `BTreeSet`, then copies them into a `serde_json::Value`, then into text. Nothing is charged.
- `SignalBudget` in `contracts/engine.ts` does not cover `lqLabels`.

The only bounds are the pre-fetch caps: 30,000 rows and 16 MiB of files. Edge's limits allow 32 labels of
8,000 bytes per stream, which compress to almost nothing.

Repro: `labels-probe.mjs`, `/series` for `{job="a"}`:

| Streams (one row each) | File bytes | Result | WASM memory | JS heap |
|---|---|---|---|---|
| 100 | 1.15 MiB | 200, 23.7 MiB answer | **113.3 MiB** | 32 MiB |
| 300 | 3.45 MiB | 200, 71.0 MiB answer | **399.1 MiB** | 80 MiB |

Effect: Grafana's label browser and autocomplete call these endpoints constantly. A tenant with such
streams kills the query isolate, along with every other tenant's queries on it, PromQL included.

Must change: give `lqLabels` the budget (in the contract first), charge streams as they are added and
the answer before it is serialised, and test it in `memory.test.ts`.

**R2-M2. Within the calls that have a budget, derived structures and metric answers are not charged until
too late.** The budget counts rows held and the answer, but not what the evaluation derives from them.
- TraceQL metrics charge their answer only after `to_json()` has built it (`traces.rs` `counts`).
- `fit` limits accumulator series by points, but `histogram_over_time` writes one output series per
  (group, bucket), and `quantile_over_time` one per (group, quantile). Every point is written, zeros
  included for histograms (`engine/traceql/src/metrics.rs:396–404`).
- Tag values copy every value into a set before the text is charged.
- LogQL metric series' labels (from `regexp`, `label_format`) are never charged; only the final answer is.

Repro (default 32 MiB budget, files of 0.1 to 1.8 MiB, everything under every row cap):

| Call (data) | Script | Result | WASM memory |
|---|---|---|---|
| `{ } \| histogram_over_time(duration) by (span.g)`, 11,000 points (480 spans, 8 groups × 60 durations) | `hist-bypass.mjs 8 60` | 422, refused **after** | **513.7 MiB** (1 group 66, 2 groups 130, 4 groups 259) |
| `quantile_over_time(duration, <100 quantiles>) by (span.g)` (same 480 spans) | `metrics-probe.mjs 8 60 "<q>"` | 422, after | **869.8 MiB** |
| `rate() by (span.g)`, 11,000 points (60 spans) | `metrics-probe.mjs 60 1` | 422, after | 65 MiB |
| tag values of `span.blob` (500 spans with 60 KB values) | `tagvalues-probe.mjs 500` | 422, after | **107.7 MiB** |
| `count(sum by (x, y, z) (count_over_time({job="a"} \| regexp "(?P<x>.+)" \| label_format y="{{.x}}{{.x}}", z="{{.y}}{{.y}}" [1h])))` (14,000 rows of 2 KB, 1.38 MiB of files) | `logql-probe.mjs 14000 2000 "<q>"` | **200** | **221.4 MiB** |

The memory is spent during the call, before the refusal. Query drops an instance above 48 MiB after the
request (`query/src/index.ts:435`), so the memory is not kept across requests. But the isolate peaks at
these sizes during the call, and Cloudflare's 128 MB isolate limit applies at the peak.

This falsifies three statements:
- query/README "Memory": "the isolate holds at most the budget plus what was fetched plus the engine's
  few MiB";
- D62 §1: "a metric query's series are charged per point";
- DESIGN §6.4: "memory is bounded by bytes".

The README's Known risks mention histograms vaguely, as "could hold more than it is charged"; the
measured factor is 16 to 27 times the budget.

Must change:
- charge output series (buckets times groups, quantiles times groups) against `fit` before evaluating;
- charge every answer before it is serialised (LogQL log queries already do, with `answer_bytes`);
- charge the derived sets and labels as they grow;
- extend `memory.test.ts` to TraceQL metrics, tag values, LogQL metrics and the label endpoints.

**R2-M3. The margin's cost is larger than stated, and it refuses legitimate searches that narrowing the
window cannot fix.** D62 prices the margin as `trace_index` reads ("about a fifth of the hour's span
bytes", "24 S more R2 reads"). Two costs are missing.

*(a) Every trace in the bound is held, not just those in the window.* `do_tq_extent` (`traces.rs`, ABI 7)
makes an extent entry, charged 192 bytes plus 32 per hour, for every trace with a fragment in the bound.
For a one-minute search the bound is the window plus 4 h. So any search is refused 422
`max_decoded_bytes` once the tenant has about 150,000 traces in 4 h, roughly 10 traces/s, whatever the
window.

Repro `extent-budget.mjs` (single-span traces, 10-minute units, a 1-minute window):

| Traces/s | Margin 2 h | Margin 0 |
|---|---|---|
| 6 | 200 | 200 |
| 12 | **422 `max_decoded_bytes`** | answers: 721 traces, 7,200 rows planned |

The 422's advice, "Narrow the time range", cannot help, because the bound is never shorter than 4 h.

*(b) One trace that reaches into the margin stretches the whole search's span read to the bound.* The
hull is one interval over all found traces. A tenant's spans files are not prunable by trace, so every
tenant span in the hull counts.

Repro `hull-cost.mjs`: a tenant at 5 spans/s, a 5-minute window, and one trace whose child, in a later
unit, starts 1 h 50 min after its root.

| Margin | Hull | Rows planned | Span files | Result |
|---|---|---|---|---|
| 0 | 5 min | 3,001 | | answered |
| 1 h | 5 min | 6,001 | | answered |
| **2 h (default)** | **111 min** | **39,002** | 15 | **422 `max_spans` before any span is read** |

The same search without the long trace plans 6,000 rows. Long traces (batch jobs, consumers, clock skew
within edge's 24 h window) need not be rare.

Must change, before `QUERY_SIGNALS`:
- hold extents only for traces whose fragments reach the window, for example two passes over the
  fragments, or a filter by window before `add`;
- either read the margin's spans only for the traces that need them (bloom filters on `spans.trace_id`
  are written but not read), or bound the hull's growth and say what is then partial;
- state both costs in D62 and §6.4;
- make the refusal text say when the margin, not the window, is what does not fit.

**R2-M4. Trace by ID, Grafana's most frequent Tempo call, is refused for ordinary tenants.**

*(a) Reproduced.* A trace's hour is read by row groups. A flush unit's spans file is one row group, and
the query README's own benchmark units are 20,000 spans. `capsBeforeFetch` counts those rows against
`maxSpans` (now 18,000) before the fetch. The engine also counts every span in the bound that it reads,
held or not (`traces.rs` `each_span` calls `take()` before `latest_records` filters by id).

Repro `byid-cap.mjs`:

| Spans in the trace's row group | Result |
|---|---|
| 17,000 | 200 |
| 20,000 | **422 `max_spans` before fetch**, and the engine also refuses ("more than 18000 spans decoded … Narrow the time range") |

A trace-by-ID request with no `start`/`end` has no time range to narrow. Once D68 compaction rewrites an
hour sorted by service, every row group spans the hour, so the condition becomes "more than 18,000 spans
in the hour": about 5 spans/s.

*(b) Modelled.* Without a hint, the trace is looked up over all time. `trace_index` flush files are one
row group spanning the id space (D62's own reason for rejecting a second round), so every uncompacted
`trace_index` file of the retention is read whole. That runs into `maxFiles` (2,000) after about 14 days
at one shard and a 10-minute seal, and into `maxFetchBytes` (16 MiB) at about 1.8 M spans retained (9 bytes
of `trace_index` per span, from the README's ratio).

Also, D62 §1 says the engine counts "the rows it holds". For trace by ID and for tags it counts and
charges every span read in the bound.

Must change: for trace by ID, count and charge only the trace's spans, and cap the pre-fetch check by
bytes rather than by rows of other traces. Read `spans.trace_id`'s bloom filters, or row-group id ranges
once compaction sorts by id. State the all-time cost of a hintless lookup and its refusal threshold.

### Minor

**R2-m1. At the retention edge, a stored span can be unreachable by search, which D62 does not state.**
TRACES.md: "a `trace_index` file can leave a day before spans of its unit that started after midnight".
A trace found only through fragments of the expired day is not found, so its spans that remain in the
next day are invisible to search and whole-trace metrics. Span-local metrics and tags still see them.
State it under "Cost of it", or expire `trace_index` by `max_end`'s day.

**R2-m2. The contract followed the implementation.** `a623ebb` says "The contract follows the
implementation here (another builder held the file …)". AGENTS.md, "Changing things" 1, says contracts
first, in their own commit. The result is recorded, and `lqLabels` is missing from `SignalBudget`'s
operations (R2-M1).

**R2-m3. The cap derivation is honest in what it states, but narrow in scope.**
- Honest: the resource shape is labelled as training knowledge, and per-row growth was measured and
  compared with the charge.
- Narrow: it was measured on search (and log queries) only. Per call type, the peak differs:
  - trace by ID and tags charge spans they do not hold (R2-M4);
  - metrics and the label endpoints hold far more than they are charged (R2-M1, R2-M2).
- The "about 100 MiB with the module" isolate model is modelled, and the measurements above contradict
  it.
- `maxSpans` 18,000 halves what any search or trace by ID can read. D62 states that for search windows,
  not for trace by ID.

**R2-m4. `/api/echo` is still 404 at the gateway** (`deploy/gateway/src/index.ts:69` lists it as not
served). Grafana's "Save & test" through the public host therefore still fails; the query README
records this as needed change 5. That Loki answers errors as plain text rests on secondary sources, as
labelled.

**R2-m5. Several refusal messages give advice that cannot work.** The `max_decoded_bytes` and
`max_spans` messages say "Narrow the time range" where neither window nor hint affects what was counted:
the margin's extents (R2-M3a), a hintless trace by ID (R2-M4).

## Verdict for D62

**Approve with changes.** The decision's direction holds:
- the bound and margin make completeness deterministic and testable;
- the engine-counted budget is the right kind of bound;
- the first review's reproductions pass;
- the text now says what the bound does and that a longer trace is answered in part. I checked
  D62 §2 and DESIGN §6.4 against `traceRounds` and `do_tq_extent`: they match, except as noted
  under R2-M4 ("rows it holds").

**`QUERY_SIGNALS` must not go on merely because a Cloudflare trial and a Grafana run pass.** Neither run
would exercise R2-M1 or R2-M2. Those let any tenant with a read key, over a few hundred of its own rows,
grow a shared query isolate to 0.1–0.9 GB, PromQL queries included. Before the flag:
1. Fix R2-M1 and R2-M2, with tests for each call type.
2. Fix R2-M3, or lower the default margin to what the trial shows affordable and state the
   traces-per-second ceiling.
3. Fix R2-M4(a).
4. Run the Cloudflare trial and the Grafana run, with the gateway routing `/api/echo`.

A narrow re-check of those four findings is enough; a full re-review is not needed.

## What was attacked and held

- **Completeness within the margin.**
  - Every span of a found trace that starts in the bound starts in the hull: a span lies within its own
    unit's fragment extent, and that fragment overlaps the bound, so it is read.
  - Fragments are filtered by bound in `do_tq_extent`, so pruning off (whole files) and pruning on find
    the same traces.
  - Spans outside the bound are dropped before de-duplication in both modes.
  - Neither mode lets the engine select a trace that `tqExtent` did not: a trace's held spans lie within
    its fragments' extents.
  - The ledger version is checked between the two plans, and the tail is read once, in the first round.
  - `search-hull2.mjs` confirms the behaviour under both margins.
- **The first review's memory inputs** are now 4.6, 5.4 and 38.7 MiB (422).
- **The edge decoders** now hold 5.3 MiB for the hostile bodies that grew them to 117–229 MiB.
- **Loki time parsing** follows the cited v2.8 rule, and negatives are refused.
- **`/api/echo`** answers behind the key.
- **The tail rule (m-3)** is now stated in D62 and DESIGN §6.4.
- **The margin's own per-tenant settings** (`traceMarginMs`, `maxDecodedBytes`) come only from the
  operator's `QUERY_LIMITS` or the `limits:<tenant>` record. Control's settings API does not expose them,
  so a tenant cannot widen its own budget.

## Reproduction index

All are in `/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-signals/r2/`.
- **Bundles:** `bundle.mjs` (engines, edge decoders) and `old-bundle.mjs` (the first review's targets),
  built with `edge/node_modules/.bin/esbuild <entry>.ts --bundle --platform=node --format=esm
  --alias:cloudflare:workers=./stub-cf.js --loader:.wasm=file`.
- **Copies:** `engine/wasm{,-query}/js` (modules as above), `edge/src`, `shard/src`, `query/src`,
  `contracts`, `control/src` (with test exports appended), `janitor/src` and their imports, all at
  `0e75337`.
- **`lib.mjs`** mirrors `traceRounds` and `capsBeforeFetch`.

| Finding | Command | Key output |
|---|---|---|
| M-1 (first review) | `node search-hull2.mjs` | equals every span at 2 h, pruning on and off; differs at 1 h, the same on and off |
| M-2 (first review) | `node --max-old-space-size=1300 fat-rerun.mjs` | 4.6 / 5.4 MiB (200); 38.7 MiB (422) |
| R2-M1 | `node --max-old-space-size=1300 labels-probe.mjs 100` (and `300`) | 200, 113.3 / 399.1 MiB WASM, 23.7 / 71.0 MiB answer |
| R2-M2 | `node --max-old-space-size=1400 hist-bypass.mjs 8 60`; `metrics-probe.mjs 8 60 "<100 quantiles>"`; `metrics-probe.mjs 60 1 '{ } \| rate() by (span.g)'`; `tagvalues-probe.mjs 500`; `logql-probe.mjs 14000 2000 '<label_format query>' 20000` | 513.7 / 869.8 / 65 / 107.7 MiB (all 422 after the fact); 221.4 MiB (200) |
| R2-M3a | `node --max-old-space-size=1300 extent-budget.mjs 12` (and `6`) | margin 2 h: 422 `max_decoded_bytes`; margin 0: 721 traces |
| R2-M3b | `node --max-old-space-size=1200 hull-cost.mjs` | hull 111 min, 39,002 rows, 422 before fetch, against 5 min and 3,001–6,001 rows |
| R2-M4a | `node --max-old-space-size=1200 byid-cap.mjs 20000` (and `17000`) | 422 `max_spans` before fetch, and by the engine; 200 at 17,000 |
| First review, outside D62 | `node --expose-gc rerun-mem-otlp.mjs empty-kvs 4`, `rerun-pool-underscore.mjs`, `rerun-retention-replace.mjs`, `rerun-retention-signal-field.mjs`, `rerun-rollback-query.mjs` | 5.3 MiB; refused with the right pool; `confirmShorter` required; metric retention kept; shard behaviour unchanged (D69's floor) |

## Line for `design/REVIEW.md`

| `reviews/signals-end-to-end-r2.md` | Re-review of D62 (margin and byte budget): completeness, budget bypasses, the margin's cost, trace by ID | 0 blockers, 4 major, 5 minor; M-1 fixed as stated; D62 approved with changes; `QUERY_SIGNALS` stays off until R2-M1 to R2-M4(a) are fixed, then the Cloudflare trial and Grafana run |
