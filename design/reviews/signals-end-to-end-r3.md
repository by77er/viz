# Narrow re-check of D62 (round 3): R2-M1 to R2-M4(a), and what ABI 8 added

Reviewer: the same adversarial reviewer as rounds 1 and 2, working from the repository alone. I did not
read the authors' dispositions beyond what I needed to locate the changes.

**Ground rules.** I worked read-only on the shared tree. Every run was in
`/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-signals/r3/`, one process
at a time, each under 1.4 GB of heap. I made no Cloudflare calls and no commits.

## Scope

- **Tree:** `/home/user/viz` at `5db517f`, which contains `0f314ea`. `query/`, `engine/wasm-query`,
  `engine/traceql`, `engine/logql` and `contracts/engine.ts` have not changed since `0f314ea`.
- **Module:** the module query loads, `engine/wasm-query/js/viz_query.wasm`, ABI 8, SHA-256 `f29e583a…`.
  This is the SHA the query README pins for this work. No engine source is newer than the module.
- **Flush engine:** `viz_engine.wasm` `73b2eb49…`.
- **Harness:** the engines run through their own TypeScript bindings in Node 22. `r3/lib.mjs` mirrors the
  ABI 8 `traceRounds` (ranges into `tqFilePlan`; trace by ID checked by bytes, not rows) over files made by
  edge's decoders and the flush engine.
- **Not run:** query's workerd suites and S10 itself. S10 I read, not ran.

**Code read** (changes since round 2):
- `query/src/signals.ts`;
- `engine/wasm-query/src/traces.rs`: the three extent passes, ranges and merge, the bound and window cuts;
- `engine/wasm-query/src/logs.rs`: `do_lq_labels` with its budget;
- the current D62 text, including "What volume this serves";
- the gateway's `/api/echo` route.

## Round-2 reproductions, re-run on this build

| Finding | Round 2 | Now | Verdict |
|---|---|---|---|
| R2-M1: Loki `/series`, 100 and 300 fat streams (`labels-probe.mjs`) | 200; 113 and 399 MiB WASM; 24 and 71 MiB answers | 422 `max_decoded_bytes` ("the label sets it lists…"); 33.8 and 36.1 MiB | **Fixed** |
| R2-M2: `histogram_over_time … by`, 480 spans (`hist-bypass.mjs 8 60`) | 422 after 513.7 MiB | 422 before making the series; 2.9 MiB | **Fixed** |
| R2-M2: 100 quantiles by group (`metrics-probe.mjs`) | 422 after 869.8 MiB | 422 before; 2.9 MiB | **Fixed** |
| R2-M2: `rate() by` 60 groups at 11,000 points | 422 after 65 MiB | 422 ("its answer would take…"); 11.9 MiB | **Fixed** |
| R2-M2: tag values, 500 × 60 KB (`tagvalues-probe.mjs`) | 422 after 107.7 MiB | 422; 35.6 MiB | **Fixed** |
| R2-M2: LogQL `regexp` and `label_format` labels, 14,000 rows (`logql-probe.mjs`) | 200 at 221.4 MiB | 422 ("the series its pipeline makes…"); 33.9 MiB | **Fixed** |
| R2-M3a: one-minute search at 12 and 40 traces/s (`extent-budget.mjs`) | 422 at 12/s | 200 at both, the same traces and rows as margin 0 | **Fixed** |
| R2-M3b: one long trace in a five-minute search (`hull-cost.mjs`) | 39,002 rows, 422 | two ranges, 9,002 rows, answered | **Fixed**. It costs the far piece's flush unit, not the hull. |
| R2-M4a: trace by ID in a 20,000-span row group (`byid-cap.mjs`) | 422 `max_spans` | 200, 20,000 spans decoded. At 60,000 spans in the hour, 23,999 decoded. | **Fixed** |
| Round-1 M-1 (`search-hull2.mjs`) | | Equal to the engine over every span at a 2 h margin, pruning on and off. At 1 h it differs, the same both ways. | **Holds** |
| Round-1 M-2 inputs (`fat-rerun.mjs`) | | 4.2 and 4.7 MiB answered; 422 at 38.7 MiB | **Holds** |
| R2-m4: `/api/echo` at the gateway | 404 | Routed (`deploy/gateway/src/index.ts:81`) | **Fixed** |

**Ordinary queries at the cap.** `realistic.mjs` uses 18,000 spans in traces of 12, with 50 distinct
resources of about 3 KiB and 12 attributes each. All of these answer 200 at 28 to 32 MiB of WASM memory:
a search, `rate() by`, `quantile_over_time(…, .5, .9, .99) by`, `histogram_over_time by` (1 h at 15 s) and
tags. So the meters do not refuse realistic trace queries under the caps.

## Findings by severity

Counts: **0 blockers, 0 major, 4 minor.** r3-m1, r3-m2, r3-m3 and r3-m4 were each reproduced.

### Minor

**r3-m1. The stated peak bound is exceeded for fat rows in flush-size row groups.**

D62 §1 says a call's peak WASM memory is at most the budget, plus what it was handed, plus "a constant
measured at under 12 MiB (… the Parquet reader's pages …)". Flush cuts `spans` row groups at 16 MiB of
data, and edge allows rows up to 256 KiB, so the reader's pages for one fat row group are larger than that
constant.

| Run (`passover-probe.mjs`; span-local metrics over spans with three 60 KB attributes) | Bound (budget + handed + 12 MiB) | Measured peak | Result |
|---|---|---|---|
| 1,200 spans, 9.84 MiB of files, 13 row groups | 53.8 MiB | **70.8 MiB** | 422 |
| 400 spans, 3.29 MiB of files | 47.3 MiB | **57.5 MiB** | 422 |
| 160 spans, 1.32 MiB of files | 45.3 MiB | **44.8 MiB** | 200 |

The isolate model (about 100 MiB with the JavaScript side) still holds with a thinner margin. S10's
measured isolate peak was 70.8 MiB.

To fix, either:
- state the constant as "up to one row group's decoded pages (16 MiB at flush's cut)", or
- cut flush row groups at 2 MiB, as compaction does (already in D62's follow-up design).

**r3-m2. Grafana's canonical LogQL metric shape is refused far below the stated log ceiling.**

The query is `sum by (level) (count_over_time({…} | logfmt [1m]))` over logfmt lines that carry a unique
field such as a request id or a duration. Run with `logfmt-legit.mjs`, 1 h at 60 s, 50 streams:

| Rows | Result |
|---|---|
| 5,000 | 200 at 18.4 MiB |
| 7,000 | 422: "the series of its vector operations would take more than…" |
| 10,000, unbounded budget | answers at a real 35.1 MiB peak |
| 30,000 | `maxSeries` (20,000) refuses, whatever the budget |

The charge is honest: the memory is real, one series per distinct label set.

D62's "Row caps" says tenants with more than about 30,000 log rows in a window are refused. For this shape
the ceiling is about 6,000, roughly 1.7 lines/s over an hour. The same query with `| keep level` answers at
30,000 rows (14.1 MiB). To fix: state this ceiling, and the `keep`/`drop` form that avoids it, next to the
span ceilings.

**r3-m3. The margin's id meter is a ceiling D62 does not list.**

Pass 1 holds 64 bytes for each trace that has a piece wholly in the 2 h after the window. That is at most
about 520,000 traces, roughly 73 traces/s.

| Run (`extent-budget.mjs`, single-span traces, a one-minute window) | Result |
|---|---|
| 100 traces/s, margin 2 h | 422 ("the ids of the traces in the margin after the window…"); `trace_index` over the bound was only about 8 MiB |
| 100 traces/s, margin 0 | the same traces as with the margin |

At S10's 27 bytes of `trace_index` per span, the 16 MiB fetch ceiling (about 43 spans/s) binds first. The id
meter binds first only where `trace_index` is smaller per trace, as with single-span traces. To fix: list the
id meter's ceiling under "What volume this serves".

**r3-m4. One window, two answers, for a span re-sent with a moved start.**

Each rule is stated on its own: span-local calls cut to their window before de-duplication (D62 §3), and
trace queries cut to their bound (§2). Together they let calls disagree about which copy of a span counts.

`moved-start.mjs`: copy A starts at 09:01; copy B, in a later unit with the same key, starts at 09:40.
Over the window 09:00–09:10:

| Call | Answer | Copy it uses |
|---|---|---|
| `count_over_time()` | 1 | A |
| tag values of `name` | lists `op` | A |
| search `{ }` | no trace | B (inside the bound, later write, starts outside the window) |

Only a sender that changes a span's start between retries reaches this (TRACES.md "What a merge does not
resolve"). To fix: state it in §3 next to the existing caveat.

### What I attacked in the new code and found held

- **Ranges cannot drop a found trace's span.**
  - A span starts inside its own unit's fragment. A fragment that overlaps the bound lies in a
    `trace_index` row group that `tqFilePlan(bound)` reads.
  - Pass 3 adds every found trace's pieces, cut to the bound. `merge` only widens.
  - A tail span is its own piece, and tails are passed whole.
  - Day compaction of `trace_index` keeps extents and hours as unions.
  - Retried copies in other units have their own fragments.
- **"Found" equals "merged extent overlaps the window".** Pass 1 finds the traces with a piece in the
  window. Pass 2 finds those with a piece wholly before it and another wholly after it. That is exactly
  the extent-overlap condition.
- **Pruning on and off.** Both produce the same answer as the engine over every span (re-run above).
- **Trace by ID passing over other traces.** On a 1,200-span fat hour (9.8 MiB of files) it answered at
  38.8 MiB. Its cost is bounded by the bytes fetched, as D62 now says.
- **The meters do not refuse realistic trace queries.** See `realistic.mjs` above.
- **Cutting to the window before de-duplication does not change log answers**, because `ts` is part of the
  log row key. For spans, the change is stated (D62 §3), apart from r3-m4.
- **An empty Loki range reads no tail** (`readSignalTail`, `bound.lo > bound.hi`).
- **The volume ceilings in D62** match the code in what they state:
  - the search's `trace_index` over the window plus 4 h against 16 MiB less the tail (checked in
    `capsBeforeFetch` on round 1);
  - the 18,000 spans of the row groups in the window or its pieces' ranges (`spanRows`);
  - trace by ID bounded by the bytes of the units overlapping its pieces (modelled there, not run on
    Cloudflare);
  - the follow-up design is marked not built.

  The gaps are r3-m2 and r3-m3.
- **Earlier minors:** R2-m1 is now stated, R2-m2 is closed (contract first, ABI 8), and R2-m3 is measured
  per call type.

## Verdict

**D62: approve.** All four round-2 majors are closed and the closures reproduce. The four remaining
minors are corrections to the text; none of them blocks the flag.

## What stands between this and turning `QUERY_SIGNALS` on for tenants under the ceilings

1. **Re-run S10's realistic block and the fat shapes on Cloudflare with this ABI 8 build.** S10 measured
   ABI 7. Read the isolate peak per call type: r3-m1 shows ABI 8's peak can reach about 71 MiB of WASM
   memory for fat rows. This is the owner's precondition, and I agree.
2. **Do the Grafana run** (query README "Grafana") against the staged gateway, which now routes
   `/api/echo`.
3. **Fold r3-m1 to r3-m4 into D62's text.** In particular, state the LogQL `logfmt` ceiling (r3-m2), so the
   tenants turned on know which of their common queries will be refused with a 422.
4. **The owner's decision that the stated ceilings serve the tenants in question.** Above the ceilings,
   every trace query is refused with a 422 and never misanswered, as S10 showed at about 690,000 spans in
   five minutes.

Nothing else from this review stands in the way.

## Reproduction index

All are in `/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-signals/r3/`.
The copies of `engine/wasm{,-query}/js`, `edge/src`, `shard/src`, `query/src` and `contracts` are at
`5db517f`. The bundle is built with `edge/node_modules/.bin/esbuild entry.ts --bundle --platform=node
--format=esm --alias:cloudflare:workers=./stub-cf.js --loader:.wasm=file --outfile=bundle.mjs`.

| What | Command | Key output |
|---|---|---|
| Round-1 M-1 | `node search-hull2.mjs` | equal at 2 h, pruning on and off; differs at 1 h, the same both ways |
| Round-1 M-2 | `node --max-old-space-size=1300 fat-rerun.mjs` | 4.2 and 4.7 MiB; 422 at 38.7 MiB |
| R2-M1 | `node --max-old-space-size=1300 labels-probe.mjs 300` | 422, 36.1 MiB |
| R2-M2 | `hist-bypass.mjs 8 60`; `metrics-probe.mjs 8 60 "<100 quantiles>"`; `metrics-probe.mjs 60 1 '{ } \| rate() by (span.g)'`; `tagvalues-probe.mjs 500`; `logql-probe.mjs 14000 2000 '<label_format query>' 20000` | all 422 before making the thing: 2.9, 2.9, 11.9, 35.6 and 33.9 MiB |
| R2-M3a | `node --max-old-space-size=1300 extent-budget.mjs 12` (and `40`) | 721 and 2,401 traces found, the same as margin 0 |
| R2-M3b | `node hull-cost.mjs` | 2 ranges, 9,002 rows, under the cap |
| R2-M4a | `node byid-cap.mjs 20000` (and `60000`) | 200 |
| Realistic | `node --max-old-space-size=1300 realistic.mjs` | five calls at the 18,000 cap, all 200 at 28 to 32 MiB |
| r3-m1 | `node --max-old-space-size=1300 passover-probe.mjs 1200 60000 metrics` (and `400`, `160`; `byid`) | 70.8 MiB against a stated 53.8 |
| r3-m2 | `node logfmt-legit.mjs 7000 'sum by (level) (count_over_time({job="a"} \| logfmt [1m]))'`; `BUDGET=1073741824 … 10000` | 422 at 7,000 rows; a real 35.1 MiB at 10,000 |
| r3-m3 | `node --max-old-space-size=1400 extent-budget.mjs 100` | 422 from the margin-id meter |
| r3-m4 | `node moved-start.mjs` | count 1 and tag value `op`, but search finds no trace |

## Line for `design/REVIEW.md`

| `reviews/signals-end-to-end-r3.md` | Narrow re-check of D62 (ABI 8): R2-M1 to R2-M4(a), ranges, cut-before-dedup, stated ceilings | 0 blockers, 0 major, 4 minor (text); all round-2 majors closed and reproduced; D62 approved; `QUERY_SIGNALS` for tenants under the ceilings after S10 is re-run on ABI 8 and the Grafana run |
