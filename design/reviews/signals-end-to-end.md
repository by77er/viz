# Adversarial review: spans and logs end to end (D57, D58, D62, D63, D64, D66, D67)

Reviewer: an agent that did not build this work and was given no reasoning beyond the
repository. Read-only on the shared tree. Every reproduction ran on a copy under
`/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-signals/`.
No Cloudflare calls, no commits.

## Scope

**Commit read.** Branch `claude/cloudflare-observability-platform-ibaqya`, HEAD
`3bd35cb9bc751e34a3b877cedf351e16662231e0` when the review started (working tree: `compact/src/compact.ts`
modified). HEAD moved to `2eb7020` and then `ac66db7` while I worked. Those commits touched
`compact/`, `control/test/`, `engine/storage/examples` and `tools`, `stack/test`, `stack/tools`, `ruler/`
and `spikes/`. None of them touched a file cited in a finding below. When I finished, the tree also held
uncommitted edits by others to `query/src/{coordinator,tail,leaf,config}.ts` (split tail reads),
`contracts/{TRACES,LOGS}.md` and `design/DECISIONS.md` (a new D68, compaction of spans and logs).
`query/src/signals.ts`, `sigroutes.ts` and `shards.ts`, which the query findings rest on, were unchanged
at that point. **Not reviewed:** D68 and the `compact/` signal merge, which were being written during the
review; `design-system/`.

**What I read.** D57, D58, D62–D67, plus D61 and D60 for context. `contracts/BATCH.md`, `TRACES.md`, `LOGS.md`,
`ledger.ts` and `engine.ts`. The code: edge (`index.ts`, `route.ts`, `spans.ts`, `logs.ts`, `otel.ts`,
`limits.ts`), shard (`pool.ts`, `tail.ts`), flush (`flush.ts`, `keys.ts`, `sweep.ts`), ledger (file
admission), engine/storage (`spans.rs`, `logs.rs` bounds), publisher (`schema.ts`, `iceberg.ts` signal
stats, `publisher.ts` publish loop, the frozen `test/d64/publisher.ts`), query (`signals.ts`,
`sigroutes.ts`, `sigparams.ts`, `shards.ts`, and the pre-D62 `tail.ts` and `coordinator.ts` from git),
the gateway, control (`ops-settings.ts`) and the janitor. I also read each component's README claims
for these features.

**What I ran** (Node 22.23.5, at most one process at a time, each under `--max-old-space-size=1200`;
the WASM modules as committed: `viz_engine.wasm` `f6889738…`, `viz_query.wasm` `bfcda39f…`, which is the
SHA-256 the query README pins): edge's decoders, the shard filter, control's validators, the janitor's
retention parser and both engines, bundled with esbuild from the scratch copy; and the publisher's
`tools/verify_signal_readers.py` (PyIceberg 0.12.0, DuckDB 2.0.0, pyarrow 26.0.1) plus a bounds check of
mine. Both Python checks ran read-only over the shared `publisher/export/signals` (written 10:43 UTC,
after the last `publisher/src` commit at 10:39). The verifier ran with `--expected` pointing at a scratch
copy, so it wrote nothing.

## Findings by severity

Counts: **1 blocker, 6 major, 5 minor.** Reproduced here: B-1, M-1 to M-5, m-1. Modelled, not reproduced: M-6, m-3. From training knowledge, unverified: m-4. Read from the docs: m-2, m-5.

### Blocker

**B-1. Changing metric retention silently shortens trace and log retention to 30 days. This is data loss,
and it gets past the `confirmShorter` guard.**
`control/src/ops-settings.ts:111` builds `shorter` only over the keys the NEW value names. `:303` and
`:318–321` then *replace* the stored record. `janitor/src/janitor.ts:105` and `:150–152` read an absent
`trace_days` or `log_days` as `DEFAULT_SIGNAL_DAYS` (30), as D63 decided.

Scenario: a tenant keeps traces 365 days and logs 400. An operator, script or agent raises metric
retention with `PUT /settings/retention {"value":{"metric_samples_days":60}}`. The PUT is accepted without
`confirmShorter`. The stored record loses `trace_days` and `log_days`, and the next janitor run expires
every span, `trace_index` and log file older than 30 days. If the PUT had named `trace_days: 30`, it would
have been refused with 422 `confirmation-required`.

The bug is latent while `INGEST_SIGNALS` is off, because no span or log files exist. It becomes live the
moment the flag is on.

Repro: `repro/retention-replace.mjs`:
```
stored before                {"metric_samples_days":30,"trace_days":365,"log_days":400} -> janitor keeps {...,"trace_days":365,"log_days":400}
PUT {"metric_samples_days":60}, no confirm  {"metric_samples_days":60} -> janitor keeps {"metric_samples_days":60,"trace_days":30,"log_days":30}
PUT naming trace_days 30 explicitly: refused 422 - This shortens retention (trace_days: 365 → 30) ...
```

Must change: compare the effective policies before and after, counting an absent signal field as the
janitor's default, and require confirmation for any decrease. Alternatively, keep omitted keys from
`before`, so the PUT merges. Add a control test that runs through the janitor's `parseRetention`.

### Major

**M-1. D62's central claim is false: "every trace the answer can name is then complete".** A found trace's
fragments that lie outside the window are never read, so its hull, summary and trace-level matches come
from part of its spans.

`query/src/signals.ts:245` plans `trace_index` over the window only. `:252` computes `tqExtent` from those
files. `:255–257` plans `spans` over that partial hull. A fragment of the same trace in a unit whose
`trace_index` file (or row group) does not overlap the window is not read, so the trace's later spans are
outside the hull and are never read.

Real-world cases:
- a low-traffic tenant whose units seal by age, with a trace that straddles the end of the window;
- long or asynchronous traces whose late spans arrive in a later unit.

Repro: `repro/search-hull.mjs`, which mirrors `traceRounds` with pruning on. The input is two flush units:
trace `a`'s root at 09:00–09:05 in unit 1, and its child at 11:00 in unit 2. The window is 08:55–09:10.
- `{ }`: the query path reports `durationMs 300000` and `spanCount 1`. The engine over every span reports
  `durationMs 7260000` and `spanCount 2`.
- `{ trace:duration > 1h }`: the query path returns `{"traces":[]}`. Over every span it returns trace `a`.
- With pruning off, the hull is all time (`:255`), so the complete answer comes back. "Identical with
  pruning on and off" therefore fails on such data. The corpora in `query/test/signals.test.ts` contain no
  such trace.

Must change, before `QUERY_SIGNALS` can be enabled: either a second `trace_index` round by trace id for
the traces found (bloom filter or id ranges over a bounded lookback), or retract the claim in D62, DESIGN
§6.4 and the query README and document the Tempo-like partiality. Either way, add this case to the
corpus.

**M-2. The query caps bound rows and compressed bytes, not memory.** A tenant's own spans or logs can make
one query exceed the isolate. The defaults are `maxSpans 40,000`, `maxLogRows 60,000` and
`maxFetchBytes 16 MiB` (`query/src/config.ts`), checked in `signals.ts:79–90`. The engine copies the
resource and attributes per span and holds the log lines. Dictionary encoding and snappy make repeated
values almost free on disk.

Repro: `repro/fat-spans.mjs` and `repro/fat-logs.mjs`. All inputs are within edge's limits: a 180 KB
resource, which is under the 256 KiB entry limit, and 200 KB lines, which are under 256 KiB.

| Input | File bytes | Result | WASM memory |
|---|---|---|---|
| 1,000 spans | 0.18 MiB | `ok` | **176 MiB** |
| 2,000 spans | 0.36 MiB | `ok` | **349 MiB** |
| 400 log rows | 3.8 MiB | `ok` | **158 MiB**, plus a 19 MiB answer string |

At the caps (40,000 spans, or 16 MiB of logs), modelled memory runs to gigabytes. WASM32 tops out at
4 GiB, so the module would trap first. The 1.5 KiB per span that D62 quotes ("the caps make one place
safe") comes from synthetic spans with 6–8 attributes. OTel auto-instrumentation resources are often
2–4 KiB, so a real 40,000-span query would also exceed 128 MB (modelled).

Effect: the query isolate dies, and every other tenant's query in flight on that isolate fails with it.

Must change: a cap on decoded bytes, either estimated from fragments or counted by the engine against a
hard budget and refused with 422. Ideally also hold each resource once per entry instead of once per
span. Re-derive the caps from it.

**M-3. Edge's OTLP and Loki decoders allocate far more memory than any limit allows before they check
one.** This applies to all three new ingest paths, and the same flaw already exists on `/v1/metrics`.

Where the decoders materialise everything before checking a limit:
- `edge/src/spans.ts:425` and `edge/src/logs.ts:495` push every resource `KeyValue` before the 128
  attribute limit is checked.
- `edge/src/otel.ts:124–133` materialises every element of an array value as a JS object before the
  65,536-byte value limit is checked.
- `edge/src/otlp.ts:461` does the same on the metrics path.

`edge/README.md:694–697` claims a request holds "about three times the decompressed size".

Repro: `repro/mem-otlp.mjs`, `mem-logs.mjs` and `mem-otlp-metrics.mjs`. The hostile input is a resource
of empty KeyValues (`0a 00`).

| Body (decompressed) | gzip size | Path | Heap growth |
|---|---|---|---|
| 2 MiB | 2,076 bytes | traces | **117 MiB** |
| 4 MiB | | traces | 229 MiB |
| 4 MiB | | OTLP logs | 229 MiB |
| 4 MiB | | metrics | 179 MiB |
| 4 MiB | | array-value variant | 111 MiB |

The default `maxDecompressedBytes` is 32 MiB; a 32 KB gzip body reaches it. Extrapolated, that is about
1.8 GB of heap. Any key with `write` scope can kill an ingest isolate, along with the other requests on
it.

Must change: count attributes, array items and value bytes while decoding, and refuse at the limit
before materialising. Lower `maxDecompressedBytes`, as the README already advises. Measure in workerd.

**M-4. The rollback floor for `INGEST_SIGNALS` is incomplete and only written down.** D64's rule names
viz-publisher only, and `deploy/release.mjs` refuses rollbacks only on storage schemas.

The rule misses viz-query. Suppose viz-query is rolled back below D62 while the flag is on:
- The pre-D62 query (`git show 0fcdc23^:query/src/coordinator.ts`, `:524–527`) reads every shard the
  plan's watermarks name, span and log shards included.
- Its tail filter (`0fcdc23^:query/src/tail.ts:31–50`) never carries `signals`.
- This release's shard returns a span or log batch whole to any filter that names no series
  (`shard/src/tail.ts:186`).

So `{__name__=~"http_.*"}`, `count({__name__=~".+"})`, and `/api/v1/status/tsdb` (filter `{}`, `:1369`)
hand signal-2 batches to the metrics engine. The metrics engine refuses them, so every such metrics query
of a tenant that has sent spans or logs fails.

Repro: `repro/rollback-query.mjs`:
```
up                     filter {"minTs":…,"maxTs":…,"metrics":["up"]}   -> nothing (skipped)
{__name__=~"http_.*"}  filter {"minTs":…,"maxTs":…}                    -> span batch returned to the metrics read (signal 2, 1 rows)
count({__name__=~".+"})filter {"minTs":…,"maxTs":…}                    -> span batch returned to the metrics read
```

Not reproduced, but follows from the code: rolling flush, the ledger or the janitor back below D63 stalls
span and log flush (`invalid_unit`, or `encodeSegment` throwing) and retention. That is stuck, not lost.

Must change: state the floors for viz-query (D62) and for flush, the ledger and the janitor (D63) beside
D64's, and make the release record enforce a per-flag floor. One way is for `release.mjs` to refuse a
rollback below the release that first set `INGEST_SIGNALS`. Another is to mark that release forward-only
for those Workers. D64 itself says "rests on an operator, not on the release tooling".

**M-5. Control accepts dedicated pools that edge refuses. D66 is incomplete, and the dedicated-pool naming
is inconsistent.**

- `control/src/ops-settings.ts:163` requires exactly `tenant/${t.tenant}`, and `:170` checks only the
  derived suffix. Control never checks `POOL_NAME`.
- `TENANT_ID` allows `_`; `POOL_NAME` does not.
- Edge's `parseMap` refuses such a pool (`edge/src/route.ts:168`, 503 for every signal, metrics included).
- `shard/src/pool.ts:81` `dedicatedPool` maps `_` to `-`, which control would refuse.

Repro: `repro/pool-underscore.mjs`:
```
control PUT /settings/pool for acme_prod: accepted -> {"pool":"tenant/acme_prod","slots":4,"spread":4,"epoch":4}
edge poolMap for acme_prod: 503 shard pool map is invalid -> every write of this tenant, metrics included, is answered 503
control PUT /settings/pool for traces: refused (422 ...)
```

The `_` part predates D66. But D66 says it "refuses exactly the maps edge refuses", and its rejection of
alternative (c) applies word for word. Must change: validate with edge's `validBasePool`, and accept or
suggest `dedicatedPool(t.tenant, …).pool`.

**M-6. D67's upgrade re-bases every tenant in one publish attempt, with no per-publish cap** (unreproduced;
modelled). `publisher/src/publisher.ts:774–830` reads every pending tenant's log. A tenant with no cursor
for the new tables (every tenant, right after the upgrade, `:796`) is re-based from its checkpoint into
`stage`, and only then is each table committed.

The README's risk "CPU time of a re-base at the limit" covers one tenant. The upgrade spends the sum over
the cell. A publish cut off by the invocation's CPU limit is retried from nothing, because `stage` is
cleared. The alarm can therefore keep failing, and metric publication stops for the whole cell. Rolling
back to D64 restores metrics but stops span and log publication.

Modelled from the README's own local times (0.7 s per 32k-file tenant, 2.4 s per 100k-file tenant): 100
tenants of 100k files is about 240 s, against a Durable Object default of 30 s CPU (training knowledge, as
the README says). Must change: re-base at most K tenants, or N staged files, per publish and leave the
rest pending. Measure on Cloudflare (the README already names the experiment).

### Minor

**m-1. One bad signal field stops metric retention too.** `parseRetention` refuses the whole record when
`trace_days` or `log_days` is unreadable (`janitor/src/janitor.ts:150–156`). That contradicts
`janitor.ts:200–201` ("so the metric expiry never depends on them") and D63 ("in ledger requests of their
own after the metric one"). Repro: `{"metric_samples_days":30,"trace_days":0}` gives `unreadable`, and
nothing expires, metrics included. Control never writes 0 (1–3650), so a newer or older writer is needed
to trigger it.

**m-2. Docs drift.**
- DESIGN.md §5.1 (`:310–313`) says "Not yet: their compaction" and calls the token filter "not built".
  TRACES.md, LOGS.md and compact/ say they are built.
- TRACES.md `:12` and LOGS.md `:14` say "the query path does not use them yet", and TRACES.md `:60` says
  "no reader exists yet". D62's reader exists.
- `query/src/shards.ts:31–32` says "edge allows such a base pool today", which has been stale since
  stage 3.
- `edge/README.md:694–697` gives a memory model (see M-3).

**m-3. A span or log query reads the whole signal tail, whatever its window** (modelled). D63's cost names
this but not its effect. Seal is 4 MiB or 10 minutes per shard, and `tenantMaxBytes` is 64 MiB. For a
tenant whose spread S is 4 or more, with segments near seal, the tail alone approaches `maxFetchBytes`
(16 MiB), so every trace or log query is refused with 422. The tail's spans also count against `maxSpans`
whatever the window. Together with D62's acknowledged 40,000-span window, that is about 11 spans per
second for Tempo's default one-hour search. State this in D62/D63 and in the README as a usability limit.

**m-4. Loki and Grafana compatibility is not shown** (unverified, from training knowledge).
`query/src/sigparams.ts:47` reads every integer as nanoseconds. Loki reads integers of up to 10 digits as
seconds, so a client sending seconds gets a range from 1970 instead of an error. Loki errors are wrapped
in the Prometheus JSON envelope; Loki answers plain text, and Grafana's Loki source shows a non-JSON body
verbatim. Neither Grafana data source has been pointed at this code (`deploy/README.md` "A client run"),
and Tempo's `/api/echo`, which Grafana's "Save & test" may call, is 404.

**m-5. The D64-to-D67 rollback guarantee depends on D64 shipping as its own release.** If D64 and D67
reach production together (nothing is in production yet, per D60), D67 is in effect forward-only once
`INGEST_SIGNALS` is on. The tested D67→D64 rollback then targets a release that never served. Say in
deploy/README that D64 must be released and serve first, or restate the floor as D67.

## Verdicts per decision

| Decision | Verdict | What must change before merging (flags stay off) / before the flag goes on |
|---|---|---|
| **D57** per-signal pools | **Approve with changes** | The pool and name rule held every attack (see below). Before `INGEST_SIGNALS`: bound decoder memory (M-3). |
| **D58** OTLP log stream labels | **Approve** | Nothing found against the mapping itself. |
| **D62** Tempo and Loki read APIs | **Reject as written** | The completeness guarantee (M-1) and the cap model (M-2) are both false, as reproduced. The code may merge dark only if D62, DESIGN §6.4 and the query README stop claiming them and record that `QUERY_SIGNALS` must stay off until they are fixed. Re-review after the fixes. Also m-3 and m-4. |
| **D63** write side | **Approve with changes** | Fix B-1 (retention: interacts with control) before `INGEST_SIGNALS`. Fix m-1. Add the D63 floors to the rollout rule (M-4). |
| **D64** publisher reads, rollout rule | **Approve with changes** | Extend the floor to viz-query, flush, the ledger and the janitor, and make it enforceable (M-4). m-5. |
| **D66** control refuses `/traces`, `/logs` | **Approve with changes** | Check the whole of edge's base-pool rule, `POOL_NAME` included, and align with `dedicatedPool` (M-5). |
| **D67** Iceberg tables | **Approve with changes** | Cap re-bases per publish before deploying over D64's storage in a cell with many tenants (M-6). The independent readers held on re-run. |

## What was attacked and held

- **Tenant isolation.** The tenant comes from the credential on all three ingest paths and on every query
  path. `X-Scope-OrgID` is never read. The ledger admits a key only under its own tenant, table and day
  (and for `spans`, the hour of `[minTs, maxTs]`), with no further `/`. The janitor's prefixes end in `/`,
  so `tenant=a/` never matches `tenant=ab/`. Trace by ID, the tails and the fragments are all addressed by
  `c.tenant`. The gateway forwards unchanged and makes no tenant decision. Shard streams are per tenant,
  so two tenants that share a derived shard object stay apart.
- **Pool and shard naming.**
  - A pool named exactly `traces`: its metric shard `traces/0` is classified metrics, because `DERIVED`
    needs a prefix.
  - A pool `p/traces/5`: its metric shards are `p/traces/5/{slot}` (classified metrics), distinct from
    `p`'s span shard `p/traces/5`. Flush keys `p_traces_5` and `p_traces_5_0` differ.
  - Base pools ending in `/traces` or `/logs` are refused by edge and by control.
  - Derived names over 120 characters give 503, never a truncated name.
- **Signal confusion.**
  - Flush dispatches on the batch's signal byte, refuses a mixed or unknown segment, and checks the tables
    each encoder may produce (`flush.ts` `SIGNAL_TABLES`).
  - The shard's `signals` filter skips other signals.
  - The query checks every tail batch's header (503 on mismatch).
  - An older shard ignores `signals`, and the header check catches it.
  - An older flush or engine throws on signal 2 or 3, so the failure is closed.
  - A file of one signal cannot enter another table through flush.
- **Hour and day keys at boundaries.** The engine's `div_euclid` hour, the ledger's `spanHour` (millisecond
  floor) and the publisher's key hour agree. `trace_index` files that cross midnight are admitted (the
  ledger checks only the hour, and only for `spans`). Log files are split by the day of `ts`.
- **Idempotency and crash points.** The flush path is unchanged for signals 2 and 3: content-addressed
  keys, `If-None-Match`, one unit per segment. A span unit holds at most 26 + 2 files, under
  `PRECEDENCE_PER_VERSION`.
- **Publisher rollback D67 → D64.** D64 refuses to release a table's removed files once
  `{cell}/iceberg/{table}/` exists, and it never sweeps or expires the signal tables. Its `safeToDelete`
  returns only rows D67 had freed by the snapshot rule. Migration 5 is additive. I found no
  delete-while-referenced path.
- **Independent readers.** I re-ran `tools/verify_signal_readers.py` read-only on the shared export:
  **1,542 checks, 0 failed** (PyIceberg 0.12.0, DuckDB 2.0.0). That covers schema equality, nested name
  mapping, partition columns, tenant, hour and day pruning, and content hashes. My own bounds check
  (`pub/bounds_check.py`) ran equality predicates on `spans.service_name`, `spans.start_unix_nano`,
  `logs.ts`, `logs.service_name`, `trace_index.min_start_unix_nano` and `max_end_unix_nano` through
  PyIceberg and DuckDB, against the files read directly: **244 checks, 0 failed**. Lower and upper bounds
  never pruned a matching row.
- **Flags off.** With the flags off, edge answers 404 on `/v1/traces`, `/v1/logs` and `/loki/api/v1/push`,
  and query answers 404 on the Tempo and Loki paths. Metric reads send `signals:[1]`, and a cursor
  without `signals` keeps its old canonical text.

## Reproduction index

All under `/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/rv-signals/`.
Copies of `edge/`, `shard/`, `contracts/`, `control/src`, `janitor/src`, `compact/src`, `flush/src`,
`ledger/src`, `publisher/src`, `dashboard/src` and the two engines' `js/`, as of the commits above. The
bundles are built with `edge/node_modules/.bin/esbuild <entry>.ts --bundle --platform=node --format=esm
--alias:cloudflare:workers=./stub-cf.js` (and `--loader:.wasm=file` for the engines).

| Finding | Command (in `repro/`) | Key output |
|---|---|---|
| B-1 | `node retention-replace.mjs` | `{"metric_samples_days":60}` gives the janitor `trace_days 30, log_days 30`; naming `trace_days:30` gives 422 |
| M-1 | `node search-hull.mjs` | `durationMs 300000` against `7260000`; `{ trace:duration > 1h }` gives `[]` against trace `a` |
| M-2 | `node --max-old-space-size=1200 fat-spans.mjs 1000` / `2000`; `fat-logs.mjs 400` | WASM 176 / 349 / 158 MiB; files 0.18 / 0.36 / 3.8 MiB |
| M-3 | `node --expose-gc --max-old-space-size=1200 mem-otlp.mjs empty-kvs 2` (and `4`, `array 4`); `mem-logs.mjs otlp-logs-empty-kvs 4`; `mem-otlp-metrics.mjs empty-kvs 4` | 117 / 229 / 111 / 229 / 179 MiB heap; a 2 MiB body is 2,076 bytes gzipped |
| M-4 | `node rollback-query.mjs` (pre-D62 `tail.ts` extracted to `query-pre-d62/` with `git show 0fcdc23^:query/src/tail.ts`) | the span batch is returned to filters without series |
| M-5 | `node pool-underscore.mjs` | control accepts `tenant/acme_prod`; edge gives 503 |
| M-6 | none (modelled from `publisher/README.md` "Re-base: memory and time") | |
| m-1 | `node retention-signal-field.mjs` | `trace_days:0` makes the whole record `unreadable` |
| Readers | `cd pub && python3 -I verify_signal_readers.py /home/user/viz/publisher/export/signals --expected ./expected.json` | `checks run: 1542 … failed: 0` (`pub/verify.out`) |
| Bounds | `cd pub && python3 -I bounds_check.py /home/user/viz/publisher/export/signals ./expected.json` | `bounds checks: 244, failed: 0` |

## Row for `design/REVIEW.md`'s index

| Review | Lens | Findings |
|---|---|---|
| `reviews/signals-end-to-end.md` (this file) | Spans and logs end to end (D57, D58, D62–D64, D66, D67): tenant isolation, signal confusion, loss, upgrade and rollback, resource bounds, outside readers | 1 blocker, 6 major, 5 minor; D62 rejected as written, D58 approved, the rest approved with changes |
