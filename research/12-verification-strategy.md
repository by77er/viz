# 12 — Verification & Validation Strategy for viz

Research date: 2026-11-18. Web access worked for this session.

**Evidence labels used throughout**

- **[V]** — verified this session against a primary source (vendor docs, upstream repo, paper).
- **[V2]** — seen this session only through a secondary source (release aggregator, search summary, third-party blog). Re-check before relying on exact behaviour.
- **[T]** — training knowledge (cutoff mid-2026), not re-verified today.
- **[J]** — my engineering judgment / recommendation.

---

## 0. Executive summary

1. **The correctness of viz is dominated by one protocol**: `ack → DO WAL → Parquet PUT → Iceberg commit → WAL truncate → compaction/retention rewrite`. Almost every catastrophic bug (silent loss, duplicates, flicker, cross-tenant leak) lives at an `await` inside that pipeline. It must be (a) formally specified, (b) implemented as a sans-IO deterministic state machine, (c) simulated under faults with millions of seeds, and (d) continuously audited in production by a reconciliation ledger and black-box probers. Example-based tests alone will not find these bugs.
2. **Cloudflare's local test tooling improved a lot in 2026 but still cannot stand in for production semantics.** `@cloudflare/vitest-plugin` v1 (renamed from `vitest-pool-workers` in Aug 2026) has `evictDurableObject`, `abortAllDurableObjects`, `runDurableObjectAlarm`, Workflow introspection, and queue batch helpers [V]. There is **no local emulation of the Iceberg catalog** (R2 Data Catalog, now "Basin Catalog") [V: absent from the bindings matrix]; Workflows and DOs cannot use remote bindings [V]. So CI needs a Docker Iceberg REST catalog plus a nightly "emulator drift" suite against the real service.
3. **Query correctness is mostly a solved methodology**: reuse the upstream `promqltest` corpus in-process, run `prometheus/compliance` (PromQL, and the Remote-Write 2.0 **receiver** suite that now exists [V]) differentially against a real Prometheus, do the same against Tempo for TraceQL, then add metamorphic fuzzing. The viz-specific oracle that matters most is **storage-location invariance**: a query must return the same answer whether rows sit in the DO buffer, in uncompacted files, or in compacted files.
4. **Agentic monitors reading tenant logs are a demonstrated attack surface.** 2026 papers (LogJack, "Poisoning the Watchtower", LogInject) show log-embedded prompt injection succeeding at rates from 0% to 86% depending on model, and cloud guardrails mostly missing it [V]. Verification must treat this as a security property enforced by architecture (read-only, tenant-scoped tools; no side-effecting tool reachable from untrusted context), with an injection regression suite on top.
5. **Cost and memory are correctness properties on this platform.** 128 MB per isolate (shared across concurrent requests) [V], 10,000 subrequests per invocation on paid plans by default [V]. Assert R2 ops, subrequests, bytes scanned and peak memory per query as test invariants, not dashboards.

---

## 1. What is being verified (system model)

Assumed architecture (from the brief): per-tenant Durable Objects act as write buffer / WAL and coordinators; flushed data becomes Parquet on R2 registered in Iceberg tables; Queues/Workflows drive compaction and retention; PromQL and TraceQL engines (Rust→WASM and/or TS) run in Workers; alert evaluators and LLM-driven monitors sit on the query path; MCP exposes tools to agents.

Fault model that the design must survive, and tests must inject:

| Component | Faults to inject | Source of truth for semantics |
|---|---|---|
| Durable Object | eviction at any `await`; hard abort; exception reset; code deploy mid-flush; alarm delivered late / more than once; storage write succeeded but caller never learned | DO docs; eviction helpers in vitest plugin [V] |
| R2 | PUT fails; PUT succeeds but response lost; PUT slow (minutes); GET 5xx / truncated body; conditional PUT precondition failure; list lag | R2 docs [T] |
| Iceberg catalog | commit conflict (409); **commit state unknown** (5xx/timeout after the commit applied); stale metadata read; maintenance job (managed compaction / snapshot expiry) racing with viz's own writers | Iceberg REST spec [T]; Basin Catalog maintenance features [V] |
| Queues | duplicate delivery; reordering; delay; redelivery after partial batch ack; DLQ | at-least-once [T] |
| Workflows | step retry after side effect applied; instance restart; duplicate instance creation | Workflows docs [T] |
| Worker isolate | OOM at 128 MB (Error 1102) [V]; CPU limit; subrequest limit [V]; client disconnect mid-request | Workers limits [V] |
| Clients | retries with and without idempotency keys; out-of-order and duplicate samples; clock skew; malformed protobuf; hostile tenant IDs | — |
| Time | DO clock vs Worker clock vs client timestamps; retention boundary at the instant of a compaction | — |

---

## 2. Invariants (numbered, precise)

Notation: tenant `t`; ingest request `r` carrying record multiset `B(r)`; `ack(r)` = a 2xx returned to the client; `Buf(t)` = rows durably in DO storage and not yet truncated; `Ice(t, s)` = rows reachable from Iceberg snapshot `s`; `Vis(t, τ)` = rows a full-scan query at wall time `τ` returns; `≡` = multiset equality after the documented dedup rule (for metrics: at most one sample per `(series, timestamp)`).

**Durability and delivery**

- **I1 Ack implies durable.** At the moment `ack(r)` is sent, every row of `B(r)` is in transactional DO storage or in a committed Iceberg snapshot. No row is ever only in isolate memory after ack.
- **I2 No loss.** For every acked `r` and every time `τ ≥ ack(r) + Δ_vis` (a stated visibility bound, e.g. 5 s p99), every row of `B(r)` inside retention is in `Vis(t, τ)`.
- **I3 No duplicates.** `Vis(t, τ)` contains no row more times than it was accepted under the dedup rule, regardless of client retries, queue redelivery, alarm re-fire, Workflow step retry, or flush retry.
- **I4 Monotonic visibility (no flicker).** If a row is in `Vis(t, τ1)` and inside retention at `τ2 > τ1`, it is in `Vis(t, τ2)`. In particular the buffer→Iceberg hand-off never exposes a gap or a double count: a query reads `Ice(t, s) ⊎ Buf(t) \ flushed≤s` for one consistent cut.
- **I5 Truncate implies committed.** A WAL segment is deleted from DO storage only after the snapshot containing its flush batch is confirmed as the table's current-or-ancestor snapshot (confirmed by re-reading catalog state, never inferred from a 2xx alone).
- **I6 Exactly-once flush batches.** Every flush batch `(do_id, flush_seq)` appears in exactly one data file set referenced by the live snapshot lineage; `flush_seq` is recorded in snapshot summary / file metadata so a retry after "commit unknown" can detect its own earlier success.
- **I7 Backpressure, not loss.** When buffer bounds are hit, ingest returns a retryable error (429/503 with `Retry-After`); it never acks and drops.

**Table maintenance**

- **I8 Compaction preserves content.** For a compaction replacing file set `F` by `F'`: `rows(F') ≡ rows(F)`; per-column checksums over the logical rows are equal; sort order and schema field IDs are preserved; no row younger than the compaction's read snapshot is dropped (concurrent appends survive).
- **I9 Retention is exact.** After a retention run at `T` with policy `R(t)`: no row with `ts < T − R(t)` is queryable; no row with `ts ≥ T − R(t) + g` is deleted, where `g` is the documented granularity (e.g. partition width). No other tenant's files are touched.
- **I10 Linear snapshot history.** Each table's snapshot lineage as observed by any reader is a single chain; concurrent committers (flush, compaction, retention, managed maintenance) serialize, and a losing committer re-validates against the new base before retrying (compaction must not resurrect rows that retention deleted, nor delete rows it never read).
- **I11 No dangling or leaked files.** Every file referenced by a live snapshot exists and has the recorded length; every unreferenced file older than the orphan grace period is eventually deleted; an orphan sweep never deletes a file referenced by a live snapshot or by an in-flight commit.

**Format validity**

- **I12 Independent readability.** Every committed snapshot is readable by at least two independent engines (DuckDB and PyIceberg per PR; Spark, Trino, Basin SQL nightly) with identical row counts and identical order-independent content hashes.
- **I13 Statistics are sound bounds.** For every data file: manifest lower/upper bounds, null counts, value counts, and Parquet column/page statistics are true bounds of the data (including NaN, ±0.0, truncated strings, empty pages). Partition values in the manifest match every row in the file.
- **I14 Pruning soundness.** For every query, the result with all pruning enabled (partition, file stats, row-group, page index, bloom) equals the result with pruning disabled.

**Query semantics**

- **I15 PromQL conformance.** For every query in the conformance corpus and for fuzz-generated queries inside the supported subset, viz's result equals reference Prometheus on the same samples (same series set, same timestamps, values within relative tolerance; vectors compared as sets unless the query is order-defining). Unsupported features fail loudly with an error, never with a silently different answer.
- **I16 TraceQL conformance.** Same statement against reference Tempo for the supported subset.
- **I17 Storage-location invariance.** A query's result is independent of whether its input rows reside in DO buffer, uncompacted files, compacted files, or any mix; independent of file boundaries, row-group boundaries, and compaction history.
- **I18 Snapshot-consistent reads.** One query evaluates against one Iceberg snapshot and one buffer cut; splitting a query across Workers/shards and merging gives the same result as unsplit evaluation.
- **I19 Native ≡ WASM.** The Rust engine compiled natively and compiled to `wasm32` return identical results for the same inputs (modulo NaN payload bits).

**Tenancy and security**

- **I20 Tenant isolation.** For every API surface (ingest, query, metadata, dashboards, alerts, MCP, exports, admin), the response is a function only of the authenticated principal's tenant data and public constants. Every R2 key, DO name, catalog namespace, cache key, and queue message touched while serving tenant `t` is derived from `t` server-side; no tenant identifier supplied in a body, label, header other than the credential, or query string can widen scope.
- **I21 Capability-bounded agents.** An agentic monitor's reachable tool set is read-only and scoped to its tenant; no content originating in telemetry (log bodies, span attributes, label values, metric names, dashboard text) can cause a tool call outside that set or change the notification target set.
- **I22 Sandboxed adapters.** Tenant-supplied adapter code (if any) has no ambient bindings, no network other than declared hosts, and bounded CPU/memory; it cannot observe another tenant's requests.

**Alerting**

- **I23 Evaluation completeness.** Each rule is evaluated for every scheduled tick `k` exactly once in effect (idempotent on `(rule, k)`), against data complete up to an explicit watermark; a tick is never evaluated against data known to be incomplete without marking the result as such.
- **I24 Notification delivery.** A state transition produces at least one notification attempt with a stable dedup key; evaluator restarts do not lose `for:` state nor re-fire resolved alerts.

**Resource bounds (cost as correctness)**

- **I25 Query cost bound.** For a query touching `k` data files and `m` manifests: R2 GETs ≤ `a·k + b·m + c`, subrequests ≤ configured ceiling, peak isolate memory ≤ 96 MB (25% headroom under 128 MB), each asserted with concrete constants in tests.
- **I26 Ingest cost bound.** R2 class-A ops per flushed MB and DO storage ops per request are bounded by stated constants; an idle tenant costs zero requests (no alarm loops).

**Product surface**

- **I27 Dashboard spec round-trip.** `parse(serialize(spec)) = spec`; every stored or agent-authored spec validates against the published JSON Schema; old schema versions migrate forward deterministically and idempotently.
- **I28 Ledger balance.** For every tenant and window: `accepted = buffered + committed + expired_by_retention`, and `received = accepted + rejected(by reason)`; any imbalance beyond in-flight bounds pages a human.

---

## 3. Formal specification of the flush/commit/compaction protocol

### 3.1 Why spec it

The Iceberg commit path has a well-documented trap: conflict *validation* is the writing engine's job, not the catalog's. Jack Vanlightly's FizzBee model of Iceberg found that safety holds only when the writer enables the right validation checks, and called leaving them to the compute engine "a little risky" [V2, 2024 post]. viz is its own Iceberg writer, so it inherits that obligation. A 2026 example of the same class: the pgEdge ColdFront project ships a TLA+/PlusCal model of multi-writer Iceberg commit serialization with a deliberately failing config (`NoLakekeeperConflict violated`) to justify a protocol patch [V2].

### 3.2 Tool choice

| Tool | Fit for viz | Notes |
|---|---|---|
| **Quint** (+ Apalache/TLC backends) | **Recommended** | TypeScript-like syntax; `quint run --mbt` emits ITF traces; `quint-connect` replays traces against a Rust implementation and fails at the first divergence; a community TS port exists (`@firfi/quint-connect`) [V2]. This closes the spec↔code gap, which is the usual reason specs rot. |
| **FizzBee** | Good alternative | Python-like; implicit fault injection (crash at any yield point) matches "DO evicted at any await"; has a separate model-based-testing product, Rust guide "coming soon"; Go library v0.4.0 published March 2026 [V2]. Prior art for Iceberg specifically. |
| **TLA+ / PlusCal** | Fine if the team already knows it | Largest body of examples; trace validation against TLA+ is published research [V2]. |
| **P** | Reasonable | State-machine oriented; strong at AWS [T]. |
| **Alloy** | Use only for the authz/tenancy data model | Relational, good for "no path from principal of tenant A to object of tenant B" [T]. |

[J] One Quint spec, two refinement levels: (1) abstract — acked set, visible set, snapshot chain; (2) protocol — DO storage, R2 objects, catalog pointer, queue messages, with crash/duplicate/timeout actions. Keep it under ~500 lines. Run it in CI (bounded model check ≤ 2 min) and generate MBT traces replayed against the Rust core.

### 3.3 Protocol skeleton to model (actions and crash points)

```
State (per tenant table):
  wal        : Seq[Segment]                 // DO transactional storage
  flushSeq   : Nat                          // DO storage, monotonic
  pending    : Option[{seq, fileKeys, baseSnap}]   // DO storage: intent record
  r2         : Set[ObjectKey]
  catalog    : {current: SnapId, snaps: SnapId -> {parent, files, summary{do, seq}}}
  acked      : Set[Row]                     // ghost variable

Actions:
  Ingest(rows)        wal' = wal ++ rows; durable; then ack           (I1)
  BeginFlush          write pending{seq = flushSeq+1, keys = deterministic(tenant, seq)}   // intent BEFORE side effects
  PutFiles            PUT each key (idempotent: key is a function of (do, seq, part))
  Commit              catalog CAS(base -> new) with summary{do, seq}
  ConfirmAndTruncate  read catalog; if exists snap in lineage with summary{do, seq}: drop wal ≤ seq; clear pending; flushSeq++
  Recover             on wake: if pending set -> go to ConfirmAndTruncate first, else resume

Environment actions (fault injection):
  Crash               lose all volatile state at any step boundary
  PutLost             PUT applied, response lost
  CommitUnknown       CAS applied (or not), caller sees timeout/5xx
  CommitConflict      another writer (compactor, retention, managed maintenance) advanced current
  DupDeliver          queue message / alarm delivered again
  Compact(F -> F')    rewrite validated against current base; must fail if any f in F is no longer live
  Expire(cutoff)      retention delete; must not race Compact into resurrecting rows

Invariants: I2, I3, I4, I5, I6, I8, I9, I10, I11 as state predicates over acked / visible.
Liveness (under fairness): every acked row eventually reaches Ice; wal eventually empties when ingest stops.
```

The three places bugs concentrate: **(a)** `CommitUnknown` followed by a blind retry (duplicates) or blind truncate (loss); **(b)** `Compact` committing against a base where `Expire` or another `Compact` already removed its inputs (resurrection / double rows); **(c)** the query cut between `Commit` and `ConfirmAndTruncate` (double count) or between truncate and reader catalog refresh (gap). Each needs a dedicated named scenario in the simulator in addition to random exploration.

A fourth, external one: **Cloudflare's managed compaction and snapshot expiration** now exist on the catalog (snapshot expiry Dec 2025, deletes unreferenced data files since Apr 2026, manual compaction queueing Sep 2026) [V]. If enabled, they are additional writers viz does not control. The spec must include them as an environment action, or the design must turn them off and own maintenance.

---

## 4. Deterministic simulation testing (DST)

### 4.1 What is feasible on Workers

There is no first-party DST for Workers. `workerd` is a real multi-threaded runtime with real I/O; Miniflare simulators are not seed-deterministic. Known constraints of the Vitest integration: fake timers do not affect the KV/R2/cache simulators; native V8 coverage is unsupported (Istanbul only); DO WebSockets do not work with per-file storage isolation [V].

So determinism must come from **architecture**, not the runtime [J]:

**Functional core, imperative shell.** All protocol logic — WAL state machine, flush planner, commit/confirm logic, compaction planner and validator, retention planner, query planner, alert state machine — lives in a sans-IO core that takes `(state, event) → (state', effects[])`. The core never reads a clock, never generates randomness, never awaits. The TS shell in the DO/Worker performs effects and feeds results back as events.

With that split:

| Layer | Technique | Tooling |
|---|---|---|
| Rust core (if Rust) | Single-threaded seeded simulator: simulated DO storage, R2, catalog, queue, clock; scheduler picks next event from a seeded PRNG; faults from §1 injected by probability schedule; invariants checked after every step | Custom VOPR-style harness (≈1–2k lines). `madsim` or `turmoil` are alternatives if the core is async Rust on tokio [T]; a sans-IO core does not need them. |
| TS core (if TS) | Same shape: interfaces for storage/R2/catalog/clock; seeded scheduler | `fast-check` `fc.scheduler()` for interleavings and `fc.commands()` for model-based runs [T] |
| Shell in real `workerd` | Named **failpoints** compiled in for non-production builds; tests arm a failpoint then call `evictDurableObject` / `abortAllDurableObjects`, re-drive via `runDurableObjectAlarm`, and assert invariants via `runInDurableObject` | `@cloudflare/vitest-plugin` [V] |
| Whole system, black-box | Antithesis-style deterministic hypervisor running `workerd` + S3 emulator + REST catalog in containers | Antithesis Teams plan listed at $2,999/month incl. 2,400 compute hours [V2]. Defer to beta; note it would test local `workerd` semantics, not production DO placement. |

Lessons adopted from TigerBeetle's "protocol-aware DST" write-up (Aug 2026) [V]: check invariants *inside* the system (WAL contents, manifest checksums), not only at the API; define liveness per component, not only system-wide; crash on detected corruption in production and keep expensive cross-checks for tests. And the Jepsen/TigerBeetle lesson from 2025: the bug Jepsen found was in the query engine, a component believed well-fuzzed [V2] — so the simulator's workload generator must include queries, with an oracle, not only writes.

Community signal worth watching, low confidence: `celld`, a self-hosted Workers/DO-compatible runtime, claims pre-release deterministic simulation of its distributed protocol and conformance testing against Workers reference behaviour; the public repo is very early and the simulator is not evidently public [V for repo contents; V2 for the alarm-race story]. Not something to depend on.

### 4.2 Simulator oracle design

- Ghost state: the set of acked rows per tenant, with ack time.
- After every step: I5, I6, I10, I11 (structural).
- At quiescence and at random points: issue a full-scan query through the real query path and check I2, I3, I4, I17; run the stats checker for I13.
- Seeds: every failure prints `seed`, step count, and a minimized event trace. A failing seed becomes a permanent regression test.
- Budget: 1k seeds per PR (~2 min), 100k on merge, 10M+ nightly on a large runner.
- Coverage feedback: track which (state, fault) pairs were hit; alarm if a named crash point has zero hits in a nightly run ("swarm testing" of fault mixes helps here [T]).

### 4.3 Jepsen-style history checking against a deployed stack

Complements DST by testing real Cloudflare semantics.

- **Workload:** N client Workers (or a k6 script) write uniquely identified rows (`tenant, writer, seq`) and record `invoke/ok/fail/info` operations with timestamps; readers issue full-scan and range queries concurrently.
- **Faults in staging:** failpoint binding armed via an admin route; forced DO resets (throwing / `ctx.abort()` [T]); **deploy storms** (redeploy every 30–60 s, which restarts DOs); synthetic R2/catalog failures via an injected fetch wrapper; queue consumer that randomly `retry()`s.
- **Checkers:**
  - *Set-full style* check (Jepsen's checker for add/read-all workloads [T]): classifies every element as stable, lost, stale, or never-read, and reports visibility latency distribution. This is the natural checker for append-only telemetry and directly measures I2, I3, I4 and `Δ_vis`.
  - *Porcupine* [T] for linearizability of the small register-like pieces: catalog pointer wrapper, tenant config, token revocation, alert state.
  - *Elle* [T] only if viz ever exposes multi-key transactions; likely unnecessary.
- Any `info` (indeterminate) write must be handled as "may or may not appear, but at most once".

---

## 5. Query correctness

### 5.1 PromQL

| Layer | What | How |
|---|---|---|
| Parser | Accept/reject parity | Reuse upstream parser test tables and `promql/fuzz.go` corpora [V2: file exists]; `cargo-fuzz` round-trip `parse → print → parse`. If the Rust `promql-parser` crate (GreptimeDB) is used, it already targets upstream compatibility [T]. |
| Engine, in-process | Upstream semantics | **`promqltest` scripts** from `prometheus/prometheus/promql/promqltest/testdata/*.test` [V2: package exists]. Format: `load <step>` blocks with series expansion notation, `eval instant at <t> <expr>`, `eval range from..to step`, expected series, plus `eval_fail`, `eval_ordered`, `eval_warn`/`eval_info` and newer `expect` lines [T]. Write a small parser for this format in the engine's language and run the corpus natively in `cargo test`/Vitest: thousands of cases in seconds. Pin the upstream commit; track a skip-list with a reason per skipped case. |
| System, differential | End-to-end vs reference | **`prometheus/compliance` `promql/`**: an in-process scrape replayer serves 174 deterministic snapshots covering 70 minutes; reference is a Prometheus 3.x binary; cases come from `promql-test-queries.yml` covering selectors, aggregations, binary ops, range functions, subqueries, classic and native histogram functions; other Go projects can implement `promql.Target` and call `promql.RunTests` [V]. Note the loader **scrapes** — viz must either accept scrape-like ingestion in the test harness or use a small shim that forwards the same samples via remote write. There is also `promqle2e/` for quick per-PR Docker tests [V]. |
| Own differential | Larger, nastier data | Deterministic generator → remote-write the same payload to Prometheus (Docker) and viz → run query list → compare. Datasets must include: counter resets, staleness markers, gaps longer than lookback, out-of-order within window, duplicate timestamps, NaN/±Inf, native histograms with schema changes, UTF-8 metric/label names, label churn, exemplars. |
| Fuzz | Random valid queries | **promqlsmith** (Cortex; `WalkInstantQuery`, `WalkRangeQuery`, offset and `@` options; last push April 2025, so check maintenance) [V2]. Feed generated queries through the differential harness. Used this way by Cortex/Thanos [T]. |
| Metamorphic | Oracle-free bug finding | See below. I found no published PromQL-specific metamorphic testing work [V: search negative], so this is adapted from SQLancer's TLP/NoREC [T]. |

**Comparison rules** [J, consistent with upstream tester behaviour as I recall it [T]]: relative tolerance around 1e-5 for floats (Prometheus uses compensated summation, so order of addition changes low bits); NaN equals NaN; vectors as sets keyed by label set unless `sort*`/`topk` semantics apply; compare warnings/annotations separately and non-blocking; timestamps exact.

**Metamorphic relations for PromQL**

1. **Ternary partition (TLP):** `sum(m)` ≈ `sum(m{l="a"}) + sum(m{l!="a"})` (each side `or vector(0)`); and by regex: `m{l=~"p"}` ∪ `m{l!~"p"}` = `m`. A missing label equals the empty string in PromQL, so two partitions suffice — and that edge is exactly where bugs hide.
2. **Time split:** range query `[a, c]` = concatenation of `[a, b]` and `[b+step, c]`.
3. **Step subsampling:** range query at step `k·s` equals every k-th point of the query at step `s` (same alignment).
4. **Range = instants:** each point of a range query equals the instant query at that time.
5. **Offset shift:** `expr offset d` at `t` = `expr` at `t − d`; `expr @ T` constant over the range.
6. **Algebraic:** `sum by (a) (sum by (a, b) (x))` ≈ `sum by (a) (x)`; `avg` ≈ `sum / count`; `max(x)` = `-min(-x)`; `increase(x[w])` ≈ `rate(x[w]) * w`; `x and x` = `x`; `x unless x` = ∅; `count(x)` = `sum(x * 0 + 1)`.
7. **NoREC (optimized vs naive):** the same query with pushdown, pruning, caching, and sharding disabled by a test flag.
8. **Storage-location (I17):** same data ingested then (a) left in buffer, (b) flushed as 1 file, (c) flushed as N files, (d) compacted — all four give equal results.
9. **Shard merge (I18):** evaluate per series-hash shard and merge vs unsharded.
10. **Ingest-order invariance:** permuting ingest order within the out-of-order window does not change results.

Relations 7–10 target viz-specific code (pruning, hand-off, merge) that no upstream corpus exercises. These are where I expect the real bugs.

### 5.2 TraceQL

- **Corpus:** Tempo's `pkg/traceql/test_examples.yaml` is loaded by the engine tests, and `parse_test.go` holds parser cases; a 2026 PR added valid examples for metrics pipelines with math and second-stage combinations [V2]. Vendor these files at a pinned commit as accept/reject parity tests.
- **Differential:** Tempo single binary in Docker; send identical OTLP traces to both; compare trace-ID sets, matched span-ID sets, and for TraceQL metrics the series values. Tempo search is best-effort and limit-bounded, so compare with limits set above corpus size and treat result *sets*, not order. TraceQL metrics queries have a default 24 h range limit [V2].
- **Generator:** own deterministic trace generator (control over tree shapes, missing parents, duplicate span IDs, late spans, huge attributes, arrays, nil attributes, clock-skewed children). `xk6-client-tracing` (Grafana) generates tracing load [V2]; `telemetrygen` (collector-contrib) is a simple OTLP generator [T]. Both suit load, not adversarial structure.
- **Metamorphic:** `{A || B}` = `{A}` ∪ `{B}`; `{A && B}` ⊆ `{A}`; three-way partition `{A && B}` ∪ `{A && !B}` ∪ `{A && B = nil}` = `{A}` (nil semantics matter); structural operators (`>>`, `>`, `~`) vs a brute-force tree walk in the test; time-range split; storage-location invariance; `{…} | count() > 0` = `{…}` at trace level.
- TraceQL has no formal spec and evolves quickly [T]; pin a Tempo version as "the reference" and publish a supported-subset table.

### 5.3 Ingest protocol conformance

- **Remote Write 2.0:** `prometheus/compliance/remotewrite` now has **sender and receiver** suites. The receiver suite is configured with Prometheus-style `remote_write` blocks and tests float samples incl. `start_timestamp`, native histograms (integer, float, NHCB, reset hints, schemas), exemplars, metadata, symbol tables and label validation, headers, Snappy, Content-Type negotiation, RFC 7694 `415` handling, `X-Prometheus-Remote-Write-*-Written` response headers, and partial writes; tests are tagged MUST/SHOULD/MAY/RECOMMENDED. **Caveat: it does not read data back and accepts both 200 and 400, so a pass does not prove feature support** [V]. Pair it with viz's own write-then-query checks.
- **OTLP:** no OTLP directory in the compliance repo [V], and I know of no official OTLP receiver conformance suite [T]. Build one: golden protobuf and JSON payloads from `opentelemetry-proto` examples; a real OpenTelemetry Collector as the reference sender (`otlphttp`, gzip, both encodings); assert partial-success responses, retryable status codes with `Retry-After`, and size limits [T]. If OTLP metrics are queryable through PromQL, do differential tests against Prometheus's own OTLP ingestion for name/label translation, temporality, and resource-attribute handling [T].
- **Golden files:** store request bytes and canonicalized expected rows; regenerate only via an explicit, reviewed command.

---

## 6. Storage correctness

### 6.1 Independent read-back (I12)

| Engine | Role | When |
|---|---|---|
| DuckDB (`iceberg` extension, REST catalog support [V2]) | Fast cross-check, runs in seconds | Every PR |
| PyIceberg + PyArrow | Different metadata and Parquet implementation; easy scripting for stats checks | Every PR |
| `parquet-java` CLI (`parquet-cli`) / Arrow | Strict footer, page, and encoding validation [T] | Every PR on sample files |
| Spark + Iceberg runtime | Reference implementation; strictest on field IDs, manifests, v2/v3 features [T] | Merge / nightly |
| Trino | Third independent reader [T] | Nightly |
| Basin SQL (formerly R2 SQL) | The engine tenants will actually point at the tables; GA with Basin on 2026-10-01 [V] | Nightly against real account |

The check per snapshot: `count(*)`, per-column `count/nulls/min/max`, and an order-independent content hash (e.g. sum of per-row 64-bit hashes mod 2^64) — equal across engines and equal to the writer's own ledger.

New local enabler: Miniflare 4.20260722.1 added a local **S3-compatible endpoint for R2 buckets** (SigV4, at `/cdn-cgi/local/r2/s3/<bucket-id>`), exposed in Wrangler 4.115.0 as experimental `local_dev.experimental_s3_credentials` [V2]. If this holds up, DuckDB/PyIceberg can read exactly what the Worker wrote to local R2 in the same CI job, with no MinIO mirror. Validate before depending on it; fall back to MinIO/SeaweedFS behind an R2-shaped interface.

### 6.2 Catalog in CI

No local emulation of R2 Data Catalog / Basin Catalog exists in the Workers bindings matrix [V]. Options:

- `apache/iceberg-rest-fixture` (reference REST catalog image over JDBC; simplest) [T].
- **Lakekeeper** (Rust, single binary + Postgres; fast startup) [V2].
- **Apache Polaris** (heavier; closest to Snowflake-style behaviour) [V2].
- Iceberg's own **REST Compatibility Kit (RCK)** is a TCK run through Gradle with knobs such as `rck.requires-namespace-create` and `rck.supports-serverside-retry`, precisely because not all behaviours are defined by the spec [V2].

[J] Use Lakekeeper or the fixture for PR CI, and write an **emulator-drift suite**: one catalog contract test file (create/commit/conflict/unknown-state recovery/pagination/auth scoping/maintenance interaction) executed against both the CI catalog and the real Basin Catalog nightly. Different REST base paths per catalog (`/api/catalog`, `/catalog`, `/iceberg`) [V2] are a reminder that the client must be parameterised. Any behavioural difference found goes into the simulator's catalog model.

### 6.3 Property-based and model-based tests

- **Writer round-trip:** arbitrary record batches (proptest / fast-check) → viz Parquet writer → read with Arrow and DuckDB → equal. Generators must cover: empty batch, single row, all-null columns, NaN and ±0.0, max-length strings, invalid UTF-8 rejection, dictionary overflow, row-group and page boundaries at ±1 row, nested/list/map attributes, schema evolution (add column, widen type).
- **Stats soundness (I13):** recompute every statistic from the data and compare with footer and manifest.
- **Compaction (I8):** random file sets with overlapping key ranges and duplicates → compact → multiset equality + sort order.
- **Retention (I9):** random timestamps around the cutoff ± granularity, across partition boundaries and time zones.
- **Stateful model test:** reference model = an in-memory multiset per tenant; commands = ingest, retry-ingest, flush, crash, compact, expire, query; after each command the real system (in-process core + fake IO) must agree with the model. This is the cheap sibling of DST and runs on every PR.

### 6.4 Tenant isolation at the storage layer

- Structural: R2 key construction and catalog namespace derivation go through one function taking a typed `TenantId`; lint rule forbids string-concatenated keys elsewhere.
- Dynamic: an instrumented R2/catalog wrapper in tests records every key touched per request and asserts the tenant prefix (enforces I20 in every integration test for free).
- Production: per-tenant canary rows containing a unique secret marker; an auditor queries every *other* canary tenant for that marker continuously.

---

## 7. Cloudflare-specific tooling: capabilities and fidelity gaps

### 7.1 Vitest integration (current state)

- Package is **`@cloudflare/vitest-plugin`** v1 since 2026-08-19 (renamed from `@cloudflare/vitest-pool-workers`; codemod available; config API unchanged) [V]. Vitest 4 support arrived in pool-workers 0.13.0, with `defineWorkersConfig` replaced by a `cloudflareTest()` Vite plugin [V2].
- Test APIs [V]:
  - `cloudflare:workers`: `env`, `exports` (replaces `SELF`).
  - Events: `createExecutionContext`, `waitOnExecutionContext`, `createScheduledController`, `createMessageBatch`, `getQueueResult`.
  - Durable Objects: `runInDurableObject`, `runDurableObjectAlarm`, `listDurableObjectIds`, **`evictDurableObject(stub, {webSockets})`**, **`evictAllDurableObjects`**, **`abortAllDurableObjects`**, `reset()`. Eviction helpers landed in 0.16.20 (June 2026).
  - Workflows: `introspectWorkflowInstance`, `introspectWorkflow` (step mocking/introspection; `introspector.get()` async since 0.17.0 [V2]; flakiness reports on slow CI [V2]).
  - D1 migrations, Secrets Store admin.
  - Outbound mocking: `@msw/cloudflare` is now the documented path [V].
- Known issues [V]: Istanbul coverage only; fake timers do not affect KV/R2/cache simulators; dynamic `import()` fails in handlers invoked via `exports.default.fetch()` and in DO handlers; DO WebSockets incompatible with per-file storage isolation; storage is rolled back per test **file**; RPC results need `using`; response bodies must be consumed.

### 7.2 Bindings matrix [V]

| Binding | Local sim | Remote binding | `wrangler dev --remote` |
|---|---|---|---|
| R2 | yes | yes | yes |
| Queues | yes | yes | no |
| Workflows | yes | **no** | no |
| Durable Objects | yes | **no** | yes |
| D1 / KV / Analytics Engine | yes | yes | yes |
| AI / Vectorize | no | yes | yes |
| Rate Limiting | yes | no | yes |
| Basin Catalog / Basin SQL / Pipelines | not listed | not listed | not listed |

### 7.3 Fidelity gaps to assume until proven otherwise [J, partly T]

| Area | Local behaviour | Production behaviour | Mitigation |
|---|---|---|---|
| DO eviction and placement | Only when a test asks | Any time; on deploy; on host failure | Failpoints + eviction helpers; staging deploy storms |
| DO alarms | Fire on demand, once | At-least-once, retried with backoff | Simulator models re-fire; idempotent alarm handler tested by double `runDurableObjectAlarm` |
| Queues | In-order, no spontaneous duplicates | At-least-once, reordering | Test harness delivers each batch twice and shuffled |
| Memory limit | Historically not enforced locally; a mid-2026 Miniflare release reportedly made V8 heap limit configurable [V2] | 128 MB per isolate, shared by concurrent requests [V] | Set the local heap limit; cap WASM linear memory at build time; real-edge memory tests in staging |
| CPU / subrequest limits | Not enforced [T] | Enforced; 10k subrequests default on paid, raisable to 10M [V] | Count in an instrumented fetch/binding wrapper and assert |
| R2 | Strongly consistent local store, no latency, no errors | Latency tail, 5xx, rate limits | Fault-injecting wrapper |
| Catalog | None | Real service + managed maintenance | Docker catalog + drift suite |
| Workflows | Local simulator only | Durable, step retries | Introspection mocks + staging runs |

### 7.4 Environments and delivery

- **Worker Previews** (2026-09-22; `wrangler preview`, Wrangler ≥ 4.135.0): each Preview has its own code, config, URL and observability; **Durable Objects get separate namespaces and storage per Preview automatically; KV, D1, R2 and other account-level resources do not** and must be bound to separate resources via the `previews` config block. Workers Builds creates Previews for PRs and posts URLs; Access can protect them [V]. For viz: per-PR Preview + a per-PR R2 bucket/prefix and catalog namespace, created and garbage-collected by CI.
- Older versioned preview URLs run against production resources by default and are public unless protected [V2] — do not use those for testing against a shared staging data plane.
- **Gradual deployments:** percentage rollouts of Worker versions exist; my recollection is that DO instances are pinned to one version at a time and that DO migrations cannot be part of a gradual rollout [T — re-verify]. Consequence either way: **WAL and storage formats must be forward- and backward-compatible across adjacent versions**, and that needs an explicit upgrade/downgrade test (write with N, read with N+1, roll back, read with N).
- **Workers Builds vs GitHub Actions** [J]: use GitHub Actions (or equivalent) for the test pipeline — it needs Docker services (Prometheus, Tempo, catalog, Spark), large runners for DST, and artifact retention. Use Workers Builds only for the Preview deploy and PR URL comment, or drive `wrangler preview` from Actions for a single source of truth.
- **WASM testing:** run the Rust suite natively (fast, sanitizers, Miri on unsafe-free subsets), then again as `wasm32` inside `workerd` through the Vitest plugin (I19). Track `.wasm` size and cold-start time as budgets. Set a hard maximum linear memory at link time so an over-allocation fails deterministically in tests instead of as Error 1102 in production. WASM linear memory does not shrink, so memory tests must run many queries in one instance, not one each [T].

---

## 8. Performance, memory and cost verification

### 8.1 Load generation

| Tool | Use | Status |
|---|---|---|
| `xk6-client-prometheus-remote` (Grafana) | Remote-write load against viz ingest | Exists, Apache-2.0 [V2]. Check for RW 2.0 support. |
| `xk6-client-tracing` | OTLP trace load | Exists [V2] |
| `telemetrygen` | Simple OTLP traces/metrics/logs | [T] |
| Prometheus `avalanche` | Series cardinality and churn shapes | [T] |
| `tsbs` | Dated; DevOps dataset still useful as a fixed corpus | [T] |
| `prombench` | Prometheus's own k8s benchmark rig; borrow query mixes, not the infrastructure | [T] |
| OpenTelemetry Demo | Realistic mixed signal traffic with fault flags | [V2] |
| Own deterministic generator | Required for read-back verification under load (payload derivable from seed) | [J] |

### 8.2 Continuous benchmarking

- **CodSpeed**: works with Criterion via `codspeed-criterion-compat` (docs recommend divan for new Rust suites) and with Vitest bench via `@codspeed/vitest-plugin` [V2]. Instrumentation-based measurement reduces CI noise. I found no explicit statement of WASM-target support [V: negative].
- **Bencher**: tracks Criterion, libtest, Iai, Vitest results with statistical thresholds [V2]; suited to custom metrics such as "R2 GETs per query".
- [J] Use CodSpeed for micro-benchmarks of the native Rust core (decode, aggregate, merge, encode), and Bencher (or a metrics table in viz itself) for **custom, deterministic counters**: R2 ops, subrequests, bytes fetched, rows decoded, peak memory. Counters are noise-free and can gate PRs with zero tolerance; wall-clock gates need ±10% tolerance.

### 8.3 Cost as a test invariant (I25, I26)

Wrap every binding (`R2Bucket`, `fetch`, DO stub, Queue producer, catalog client) in a metering proxy that is always on. Every integration test for a query ends with:

```
expect(meter).toMatchObject({ r2Get: ≤ N, r2List: 0, subrequests: ≤ M, bytesFetched: ≤ B, peakWasmBytes: ≤ P })
```

Snapshot these numbers per canonical query (a "cost golden file"); a PR that changes them must update the golden and explain why. In production the same meter emits per-query cost into the meta-tenant, giving a cost SLO (e.g. p99 R2 GETs per dashboard panel).

### 8.4 Memory-ceiling tests

- Adversarial queries: high-cardinality `sum by`, `topk` over millions of series, `count_values`, long-range subqueries, regex on high-cardinality labels, traces with 100k spans, wide log lines.
- Expected outcome is a **typed "query exceeds limits" error** well before the isolate dies; an isolate death is a test failure.
- Concurrency: memory is per isolate, not per request [V], so run k concurrent heavy queries against one isolate.
- Ingest side: maximum body sizes, decompression bombs (Snappy/gzip ratio limits), huge label sets.

### 8.5 Latency gates and soak

- PR gate: k6 short run against the Preview; thresholds on p50/p95 for canonical queries and ingest; compare with main's last run rather than absolute numbers.
- Nightly soak (4–8 h) and weekly long soak (48 h+): steady ingest + query mix + periodic deploys; watch for monotonic growth in DO storage, WAL length, file counts, manifest counts, orphan files, alarm frequency, isolate memory, and query cost. Alarm-loop bugs have produced five-figure bills for others [V2]; "idle tenant costs zero" (I26) is asserted by a soak with silent tenants.

---

## 9. Security verification

### 9.1 Threat model (STRIDE, abbreviated)

| Asset / flow | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| Ingest tokens | stolen/replayed token; tenant confusion via header vs token | forged samples, backfill poisoning | no audit trail of who wrote | token in logs/URLs | cardinality bombs, decompression bombs | write token used on query/admin API |
| Query API / MCP | session fixation; MCP client impersonation | cache poisoning across tenants | — | cross-tenant read via crafted matcher, label, path, cache key, error message, timing | expensive queries, regex DoS | read token reaching admin routes |
| DO / R2 / catalog | — | direct object overwrite if credentials leak | — | shared bucket prefix traversal; catalog token scope too wide | storage exhaustion | vended credentials wider than tenant |
| Agentic monitors | attacker text posing as system/operator instruction | manipulated conclusions, suppressed alerts | agent actions not attributable | exfiltration via tool calls, links, notification text | token/cost exhaustion via bait | injected instructions reaching side-effecting tools |
| Tenant adapters | adapter claims other tenant | tampering with shared code/cache | — | SSRF to internal endpoints; reading env/bindings | CPU/memory abuse | sandbox escape to host Worker |
| Dashboards / UI | — | stored XSS via label values, log lines, markdown panels | — | shared-link overexposure | — | CSRF on admin actions |

### 9.2 Tests

- **Authz matrix:** a table of `principal kind × route × method × resource owner → expected status`, generated from the route registry so a new route without a matrix row fails CI. Run with real tokens against the Preview.
- **Tenant-ID fuzzing:** for every API parameter and for every ingested field that later becomes part of a key or a query (labels named like tenant columns, `__tenant__`, path separators, `..`, unicode confusables, very long IDs, empty, case variants), assert no change in scope. Property: `response(tenantA, anything) ∩ markers(tenantB) = ∅`.
- **Differential isolation test:** run tenant A's workload alone, then alongside a noisy/hostile tenant B; A's results must be byte-identical (catches cache and shard leaks) and A's latency within SLO (noisy neighbour).
- **Catalog/R2 credential scope:** Basin Catalog has read-only API tokens since July 2026 [V]; test that any credential handed to a tenant for direct Iceberg access cannot list or read another tenant's namespace or prefix.
- **Sandbox tests for adapters:** attempt network to non-declared hosts, access to globals/bindings, CPU spin, memory growth, timing side channels on shared isolates; assert containment and termination.
- **Supply chain:** `cargo-deny`/`cargo-audit`, `npm audit`/OSV-Scanner, lockfile-only installs, secret scanning (gitleaks or the platform's native scanner), pinned GitHub Action SHAs, SBOM for the WASM artifact [T for tool names].
- **Web:** CSP with no inline script; all telemetry-derived strings rendered as text; markdown panels sanitized; Playwright tests that ingest `<script>`/`javascript:` payloads as label values and log lines and assert inert rendering.

### 9.3 Prompt injection through telemetry (I21)

Evidence from 2026 [V]:

- **LogJack** (arXiv 2604.15368): 42 payloads across five cloud log categories against LLM debugging agents; verbatim command execution from 0% (Claude Sonnet 4.6) to 86.2% (Llama 3.3 70B); AWS/GCP/Azure guardrails mostly missed log-embedded injections that they caught when sent alone.
- **Poisoning the Watchtower** (arXiv 2605.24421): attacker-controlled log fields (user agents, URLs, DNS queries, usernames); summarization was the riskiest task at 96% success undefended; the best defense reduced average success from 26.6% to 11.8%.
- **LogInject** (arXiv 2607.14493): systematic study across models, formats and defenses.
- A vendor case study describes a crafted telemetry record steering an AI SRE agent into deploying a privileged container [V2, not peer-reviewed].

Implications for verification:

1. **Architectural tests first.** Enumerate the tool set reachable while untrusted telemetry is in context; assert by static check that it contains no side-effecting tool, no cross-tenant tool, no arbitrary-URL fetch, and that notification destinations come only from rule configuration. A model-level defense that is right 88% of the time is not a control.
2. **Injection regression corpus.** Port LogJack-style payloads into every untrusted field viz stores: log body, span name, attribute keys and values, label values, metric names and help text, exemplars, dashboard titles, annotation text. Run the monitors over these and assert: no out-of-policy tool call attempted (count attempts, not only successes), no attacker-specified string or URL in the outgoing notification, conclusions unchanged relative to the clean twin incident.
3. **Exfiltration channels.** Markdown image/link rendering in agent output, notification webhooks, and MCP responses returned to a *user's* agent (viz becomes the injection vector into the customer's agent). MCP tool results should mark telemetry-derived content as untrusted data and keep it structurally separate from instructions.
4. Track **attack success rate per model version** as a release metric; re-run on every model or prompt change.

---

## 10. Frontend verification

| Concern | Technique | Tooling |
|---|---|---|
| Chart correctness | Separate pure `data → geometry` (scales, paths, stacking, downsampling) from rendering. Golden tests on geometry JSON; property tests: every point maps inside the plot rect, x is monotonic, **downsampling preserves per-pixel-column min and max** (M4 property), stacked series sum to total, null gaps are gaps not zeros, log scale rejects ≤ 0 | Vitest + fast-check [J] |
| Visual regression | A small set of pixel snapshots per chart type and theme, rendered in one pinned browser in Docker, fonts bundled, animations off | Playwright `toHaveScreenshot` [T] |
| Components | Stories as test cases with interaction tests | Storybook + its Vitest integration [T] |
| E2E | Seeded tenant in a Preview: ingest known data → open dashboard → assert displayed numbers equal the query API values | Playwright against Worker Preview [V for Previews] |
| Accessibility | Automated axe scan on every route and story; keyboard-only flows; charts expose a data-table alternative | `@axe-core/playwright` [T] |
| Performance | Budgets on LCP/INP/CLS and JS bytes; dashboard with 20 panels × 1k series as the stress page | Lighthouse CI [T] |
| Dashboard spec | JSON Schema is the contract; fast-check generates arbitrary valid specs → serialize → parse → equal (I27); every historical schema version has fixtures and a forward migration test; unknown fields are preserved, not dropped | Ajv + fast-check [J] |
| Agent-authored dashboards | Schema-valid; every panel query parses and executes against the seeded tenant; rendered without console errors; no empty panels | Same harness, driven from the eval suite |

---

## 11. Agent / LLM verification

### 11.1 Benchmarks to borrow from

- **SREGym** (arXiv 2605.07161, NeurIPS 2026 poster): live cloud-native benchmark, 90 problems (34 ported from AIOpsLab/ITBench), fault injectors plus ambient noise; reported best end-to-end ≈ 60.7% without noise, dropping 7–30 points with noise; hardware and metastable failures below 30% [V2, author-reported].
- **ORCA-bench** (arXiv 2607.28545): root-cause localization under on-call conditions; reports hallucinated root causes in 7–40% of incident reports depending on model [V2].
- **Cloud-OpsBench** (arXiv 2603.00468): 452 fault cases, 40 root-cause types, reproducible state snapshots [V2].
- **OpenRCA**: historical telemetry with human-verified ground truth [V2]. **ITBench**: live environments [V2].
- **OpenTelemetry Demo**: failure scenarios toggled by flagd feature flags defined in `src/flagd/demo.flagd.json` (e.g. product catalog failure, recommendation cache leak, ad service high CPU / manual GC, payment failure, Kafka queue problems) [V2 for specific flag names].

Takeaway: state-of-the-art agents are far from reliable, noise hurts a lot, and hallucinated root causes are common. viz's evals must include **noise, no-fault controls, and abstention scoring**.

### 11.2 viz eval harness

1. **Incident replay corpus.** Record OTel Demo runs (and one or two other apps) with each fault flag on, plus fault-free controls and multi-fault runs; store as replayable telemetry with ground truth `{fault, service, start, end}`. Replays are deterministic and cheap; no live cluster needed per eval.
2. **Tasks.**
   - Monitor detection: time-to-detect, false positives on controls, false negatives.
   - Root cause: service and fault-class accuracy; **explicit credit for "insufficient evidence"** and a penalty for confident wrong answers.
   - Dashboard authoring: golden tasks ("build a RED dashboard for checkout") scored by programmatic checks first (schema-valid, queries execute, required signals present), then rubric-based LLM judging for layout and usefulness.
   - Evidence grounding: every claim in an agent report must cite a query; re-execute cited queries and check the claim against the result.
3. **Judging.** Programmatic checks wherever possible. LLM-as-judge only with a written rubric, a held-out human-labelled calibration set (target agreement stated up front, e.g. Cohen's κ ≥ 0.7), judge model pinned and different from the agent model where possible, and periodic human spot audits.
4. **Variance.** Run each task n ≥ 5 times; report mean and spread; gate on lower confidence bound, not a single run.
5. **Budgets.** Per task: max tokens, max tool calls, max wall time, max query cost (reusing the meter from §8.3). Budget overrun is a failure.
6. **Regression tracking.** Scores stored per (agent prompt version, model version, tool schema version). Model upgrades are treated as deployments with a canary.
7. **Record/replay of tool I/O** for cheap PR-level smoke evals; full live-model runs nightly.

### 11.3 MCP tool contract tests

- Official **`@modelcontextprotocol/conformance`** runner tests servers against the spec by connecting to a running URL, with scenario suites such as `auth` [V2]. Run it against the Preview deployment.
- Contract tests per tool: input JSON Schema rejects unknown/invalid arguments; output validates against a declared schema; errors are typed and actionable for an agent (what to change), never raw stack traces; pagination and truncation are explicit; responses are bounded in tokens; descriptions are snapshot-tested because changing them changes agent behaviour.
- Every tool call is tenant-scoped by the credential, covered by the authz matrix (§9.2).

---

## 12. Dogfooding and continuous production verification

- **Meta-tenant.** viz's own Workers, DOs, queues and Workflows emit OTLP into a `viz-internal` tenant. Because the monitored system and the monitor share fate, a minimal **out-of-band path** is required: Workers Observability / Logpush plus an external uptime check, so an ingest outage is still visible.
- **SLOs** (examples to be set from measurements): ingest availability, ack latency, `Δ_vis` freshness, query latency by class, query cost by class, alert evaluation lateness, compaction lag, ledger imbalance = 0.
- **Black-box probers (canary tenants).** A scheduled Worker per region writes rows whose values are a deterministic function of `(prober, seq, time)` over remote write and OTLP, then reads back through PromQL/TraceQL at several ages (5 s, 1 min, 1 h, 1 d, retention − ε, retention + ε). Verifies I2, I3, I4, I9, I15 continuously, and yields real visibility-latency and correctness-rate SLIs. Probe data crossing a compaction and a retention boundary is the whole point; keep probers running for longer than the longest retention tier.
- **Reconciliation ledger (I28).** At ingest, each DO increments durable counters per `(tenant, signal, time bucket)`: received, accepted, rejected by reason. Each flush records rows per file; each commit records rows added/removed in the snapshot summary. An auditor Workflow periodically compares `accepted` with `count(*)` from Iceberg metadata plus buffered counts, per tenant and bucket. Compaction must be count-neutral; retention must remove exactly whole expired buckets. Imbalances page.
- **Background scrubber.** Samples data files, re-reads them with an independent reader (DuckDB-WASM in a Workflow, or an off-platform job), recomputes checksums and stats against manifests (I11, I13). Detects bit rot and writer regressions on real data.
- **Shadow evaluation.** Sample production queries (with consent/for internal tenants) and re-run them with pruning disabled; compare (I14 in production).
- **Game days.** Quarterly: failpoint-driven faults in production-like staging with real traffic replay; verify alerts fire and the ledger stays balanced.

---

## 13. Definition-of-done ladder

| Milestone | Evidence required to exit |
|---|---|
| **Design** | Invariants I1–I28 agreed and numbered in the design doc. Quint spec of flush/commit/compaction/retention model-checks with crash, duplicate, commit-unknown and concurrent-maintenance actions; at least one seeded-bug variant is shown to be caught. STRIDE table reviewed. Each of the top-10 risky assumptions (§16) has an owner and a planned experiment. Supported PromQL/TraceQL subset declared. |
| **Prototype** | Sans-IO core exists; simulator runs ≥ 100k seeds green with all §1 faults. Upstream `promqltest` corpus ≥ 90% passing with an explained skip-list. Files readable by DuckDB + PyIceberg. Spikes done on real Cloudflare for assumptions A1–A5. Cost meter in place with first goldens. |
| **Alpha (internal + design partners)** | `prometheus/compliance` PromQL ≥ 99% on supported subset; RW 2.0 receiver suite MUST-level clean plus read-back tests. TraceQL differential green on supported subset. Vitest-plugin integration suite with failpoints at every protocol await. Emulator-drift suite nightly against real Basin Catalog. Authz matrix generated from routes, 100% coverage. Probers and ledger live in staging for ≥ 30 days with zero unexplained imbalance. Memory-ceiling tests produce typed errors, never 1102. Meta-tenant dashboards and out-of-band alerting exist. Injection corpus running; architectural check for I21 in CI. |
| **Beta (external tenants)** | Jepsen-style staging campaign (deploy storms + failpoints) with set-full checker: zero lost, zero duplicated, `Δ_vis` p99 within target. 10M-seed nightly DST green for 30 consecutive days. Spark + Trino + Basin SQL read-back nightly. Upgrade/downgrade format tests. Load test at 10× expected peak; 48 h soak with flat resource curves. Third-party penetration test of tenancy. Agent evals meet stated thresholds with variance reported; attack success rate reported per model. Canary + automatic rollback exercised for real. Retention verified on real aged data. |
| **GA** | 90 days of production prober data meeting SLOs; ledger balanced for 90 days. Restore/DR drill passed (rebuild from R2 + catalog; recover a tenant to a prior snapshot). Cost model validated against actual invoices within ±15%. Public compatibility page (compliance scores, supported subset). Runbooks tested in a game day. Optional: Antithesis or external Jepsen-style review commissioned and findings closed. |

---

## 14. CI pipeline layout

| Stage | Trigger | Budget | Contents |
|---|---|---|---|
| 0. Local / pre-commit | save / commit | < 30 s | fmt, lint (incl. "no raw R2 key concat" rule), typecheck, JSON Schema validation of dashboard fixtures |
| 1. PR fast | every push | ≤ 5 min | Rust + TS unit tests; property tests (bounded cases, seed printed); stateful model test; `promqltest` corpus in-process; TraceQL example corpus; parser fuzz regression corpus; Quint bounded model check; DST 1k seeds; geometry golden tests |
| 2. PR integration | every push, parallel | ≤ 15 min | WASM build, size budget, native≡WASM subset; Vitest plugin suite in `workerd` (DO eviction/abort, alarms, queue duplicate/shuffle, Workflow introspection, failpoints); Docker: REST catalog + S3 (or Miniflare local S3) → DuckDB + PyIceberg read-back and stats checker; PromQL differential subset vs Prometheus; TraceQL differential subset vs Tempo; RW 2.0 receiver suite; cost goldens; memory-ceiling tests; authz matrix (in-process); MCP contract tests; Storybook/a11y; CodSpeed micro-benchmarks; dependency and secret scans |
| 3. PR preview | PR open/update | ≤ 20 min | `wrangler preview` (isolated DOs) + per-PR bucket and namespace; smoke e2e; 5-minute prober; Playwright e2e + visual; short k6 latency gate vs main; MCP conformance runner against Preview; recorded-tool agent smoke evals |
| 4. Merge / main | merge queue | ≤ 45 min | Full compliance suites; DST 100k seeds; metamorphic query fuzz (10 min, fixed seed set + fresh seeds); Spark read-back; deploy to staging; gradual rollout to production with prober and SLO gates and auto-rollback |
| 5. Nightly | schedule | hours | DST 10M seeds; `cargo-fuzz`/promqlsmith long runs; Jepsen-style staging chaos with deploy storms; Trino + Basin SQL read-back; emulator-drift suite on real catalog; upgrade/downgrade tests; 4–8 h soak; full agent evals with live models; injection suite; load test at target scale; cost regression report |
| 6. Weekly / release | schedule / tag | — | 48 h soak; OTel Demo incident replays refreshed; retention audit on aged data; DR drill (monthly); dependency update batch; compatibility page regenerated |

Rules: every randomized test prints its seed and is reproducible with one command; flaky tests are quarantined within a day and tracked as bugs (a flaky concurrency test is usually a real race); failing seeds and fuzz inputs are committed as regressions.

---

## 15. Test pyramid and tooling choices

```
                     Production: probers, ledger, scrubber, shadow queries, canary rollouts
                  Staging: Jepsen-style histories, deploy storms, soak, load, pen test
               Preview per PR: e2e, visual, MCP conformance, short load
            Integration in workerd: Vitest plugin + failpoints + Docker reference systems
         Differential + metamorphic: Prometheus, Tempo, DuckDB/PyIceberg/Spark/Trino
      Deterministic simulation: millions of seeded fault schedules over the sans-IO core
   Property + model-based: proptest / fast-check, stateful model
Unit + upstream corpora: promqltest scripts, Tempo examples, golden files
Spec: Quint model checked + MBT traces replayed against code
```

| Concern | Choice | Fallback |
|---|---|---|
| Spec | Quint + `quint-connect` | FizzBee; TLA+ |
| Property testing | `proptest` (Rust), `fast-check` (TS) | — |
| DST | Custom seeded simulator over sans-IO core | madsim / turmoil; Antithesis at beta |
| Workers integration | `@cloudflare/vitest-plugin` v1 + `@msw/cloudflare` | `startDevWorker` for asset/e2e cases |
| History checking | Set-full-style checker (own, small) + Porcupine for registers | Elle if transactions appear |
| PromQL | `promqltest` corpus + `prometheus/compliance` + promqlsmith + metamorphic | — |
| TraceQL | Tempo example corpus + Tempo differential + metamorphic | — |
| Iceberg/Parquet | DuckDB + PyIceberg per PR; Spark, Trino, Basin SQL nightly | — |
| CI catalog | Lakekeeper or `iceberg-rest-fixture` + drift suite on Basin Catalog | Polaris |
| Benchmarks | CodSpeed (micro), Bencher or internal table (deterministic cost counters) | Criterion locally |
| Load | k6 + `xk6-client-prometheus-remote` + `xk6-client-tracing`; own seeded generator | telemetrygen, avalanche |
| Frontend | Vitest + fast-check (geometry), Playwright (+axe), Storybook, Lighthouse CI | — |
| Agents | Replay corpus from OTel Demo; programmatic checks + calibrated LLM judge; `@modelcontextprotocol/conformance` | SREGym/ORCA-bench tasks as external yardstick |
| Security | Generated authz matrix, tenant-ID fuzzing, injection corpus, `cargo-deny`, OSV-Scanner, secret scanning | External pen test |

---

## 16. Top 10 riskiest assumptions and the experiment that falsifies each

| # | Assumption | Falsifying experiment | If falsified |
|---|---|---|---|
| A1 | **A DO can ack only after a durable write and still meet ingest latency and throughput targets** (I1). | On real Cloudflare: sustained remote-write load to one DO at target tenant rate with a storage write per request (and with batched writes under the output gate); measure ack p99, max rows/s per DO, storage op cost. Kill/redeploy mid-load and count acked-but-missing rows. | Shard tenants across DOs; batch with explicit fsync-before-ack windows; or ack from a different durable primitive. |
| A2 | **"Commit unknown" is always recoverable**: after a timeout/5xx on catalog commit, viz can determine whether its commit applied (I5, I6). | Against real Basin Catalog: inject client-side aborts at random times during commit (thousands of trials); afterwards look for the `(do, seq)` marker in snapshot summaries; verify summaries/properties persist and are queryable; test with concurrent committers. | Use deterministic file names + a manifest-level idempotency check; or route all commits through a single coordinator with its own durable intent log. |
| A3 | **Catalog commit throughput and conflict rate are acceptable** with flush + compaction + retention + managed maintenance as concurrent writers, per table (I10). No published concurrent-commit limits were found [V: negative]. | Measure commits/s per table and per catalog, conflict/retry rates and tail latency with 1, 10, 100 concurrent committers; repeat with managed compaction enabled. | Fewer, larger tables with a single committer per table; commit batching across tenants; disable managed maintenance. |
| A4 | **Managed compaction/snapshot expiry never violates viz invariants** (I4, I8, I11) — e.g. it will not remove files that an in-flight query or a buffer cut still needs, and it preserves row multisets and sort order for viz's schemas. | Run probers + ledger + scrubber against tables with managed maintenance on, under continuous ingest and long-running queries, for weeks; diff content hashes before/after each maintenance job. | Own maintenance entirely; or lengthen snapshot retention beyond max query duration and re-verify. |
| A5 | **PromQL/TraceQL over Parquet fits in 128 MB and the subrequest budget** for realistic queries (I25). | Build the worst plausible tenant (e.g. 1M active series, 30 d) and run the canonical dashboard and alert queries on the real edge; record peak memory, subrequests, R2 GETs, wall time; run 4 concurrently in one isolate. | Mandatory pre-aggregation/rollups; query fan-out across Workers with streaming merge; hard cardinality limits per query; Containers for heavy queries. |
| A6 | **Local test semantics are close enough to production** for DO eviction, alarms, queues and Workflows that tests passing locally predict production behaviour. | Run the identical Jepsen-style workload locally (with duplicate/shuffle injection) and on staging with deploy storms; compare the classes of anomalies observed. Any anomaly seen only in production is a fidelity gap. | Expand the simulator's environment model with each gap; weight staging campaigns more heavily. |
| A7 | **The buffer→Iceberg hand-off can be made flicker-free** (I4): a query can obtain a consistent cut across a DO buffer and a catalog snapshot without holding a lock that blocks ingest. | Model the cut protocol in Quint and model-check I4; then on staging, hammer a tenant with ingest while a reader repeatedly runs `count_over_time` over a fixed closed window and asserts the count is non-decreasing and finally exact. | Version the buffer by flush sequence and have readers pass the snapshot's high-water `flush_seq` to the DO; or serve recent data only from the DO until a grace period after commit. |
| A8 | **A Rust→WASM (or TS) engine can reach upstream compatibility at acceptable effort**, and native ≡ WASM (I15, I19). | Time-boxed spike: run the full `promqltest` corpus and `prometheus/compliance` against the candidate engine; count failures by category; compare native vs WASM outputs bit-for-bit on the corpus. | Narrow the supported subset and publish it; or adopt an existing engine compiled to WASM; or translate PromQL to a SQL engine with differential tests as the gate. |
| A9 | **Agentic monitors can be made safe by construction** against telemetry-borne injection while remaining useful (I21). | Run the LogJack-style corpus against the monitor with the restricted tool set; measure attempted out-of-policy tool calls, attacker strings in notifications, and conclusion drift vs clean twins. Then check utility on the replay corpus with the same restrictions. | Remove free-text telemetry from agent context (structured summaries only); human approval for any notification content derived from raw logs; drop the feature for untrusted tenants. |
| A10 | **Tenant isolation holds under shared infrastructure** — shared buckets/prefixes, caches, isolates, and any tenant-adapter sandbox (I20, I22). | Tenant-ID fuzzing across all routes and ingested fields; differential isolation test (A alone vs A + hostile B, byte-identical results); marker-leak auditor in production; sandbox escape attempts; external pen test. | Per-tenant buckets and catalog namespaces with scoped credentials; cache keys with mandatory tenant component enforced by type; isolate-per-tenant for adapters. |

Two further assumptions worth recording as runners-up: **(A11)** retention by file/partition drop is exact enough for the contractual policy and does not interact badly with compaction (I9); **(A12)** per-tenant idle cost is truly zero — no alarm, queue or Workflow activity without data (I26).

---

## 17. Design implications for viz

1. **Make the core sans-IO and deterministic from day one.** Clock, randomness, storage, R2, catalog and queue enter only as events and effects. This single decision is what makes DST, model-based testing, native≡WASM testing and cheap fuzzing possible. Retrofitting it later is a rewrite.
2. **Write an intent record before any side effect, and derive object keys deterministically from `(do_id, flush_seq, part)`.** PUT retries become idempotent; recovery becomes "check, then decide".
3. **Stamp `(do_id, flush_seq)` into the Iceberg snapshot summary** (and/or file metadata) and never truncate WAL on a 2xx alone — re-read and confirm. This is the only robust answer to "commit unknown".
4. **Readers pass a flush high-water mark.** Queries read snapshot `s`, learn the highest `flush_seq` per DO that `s` contains, and ask the DO for rows strictly above it. That gives a gap-free, double-count-free cut (I4) without locking.
5. **One committer per table at a time, with validation.** Either a coordinator DO serializes flush/compaction/retention commits per table, or every committer implements Iceberg-style conflict validation against the refreshed base. Decide explicitly whether Cloudflare's managed maintenance is on; if on, model it.
6. **Build the failpoint mechanism into the shell** (named points at every await in the protocol, compiled out or binding-gated in production) and a small admin route to arm them in staging.
7. **Build the metering proxy into every binding wrapper** and make cost goldens part of the query test suite. The same meter feeds per-tenant billing and the meta-tenant.
8. **Typed `TenantId` everywhere, with one key-derivation function**, a lint against bypasses, and a test-time recorder that asserts prefixes. Prefer scoped credentials and separate catalog namespaces per tenant so isolation does not rest on application code alone.
9. **Limits are part of the API.** Every query has a pre-execution estimate (files, bytes, series) and fails with a typed error rather than OOM. Limits are tested.
10. **Publish a supported-subset table for PromQL and TraceQL and fail loudly outside it.** Track compliance scores per release.
11. **Agents get capabilities, not trust.** Tools reachable with telemetry in context are read-only and tenant-scoped; notification targets come from configuration only; MCP outputs label telemetry-derived text as untrusted.
12. **WAL and file formats are versioned with forward/backward compatibility** across adjacent releases, because rollouts and rollbacks mix versions.
13. **The ledger, probers and scrubber are product features, not test scaffolding.** Design their counters and canary tenants into the schema early; expose a per-tenant "data integrity" view.
14. **Per-PR environments need per-PR data resources.** Worker Previews isolate DOs but not R2/KV/D1; CI must provision and reap buckets/prefixes and catalog namespaces.
15. **Keep an out-of-band observability path** for viz itself; the meta-tenant cannot report its own ingest outage.

---

## 18. Open questions / unverified

- **Gradual deployments and Durable Objects:** exact current semantics (per-DO version pinning, whether migrations can participate) not re-verified today [T].
- **Basin Catalog limits:** no published figures found for commits per second, concurrent committers, conflict behaviour, or snapshot-summary size limits. Manual compaction has an unspecified daily request limit and can be blocked by conflicting jobs [V]. Needs measurement (A2, A3).
- **Basin rename churn:** R2 Data Catalog / R2 SQL / Pipelines were renamed Basin Catalog / Basin SQL / Basin Pipelines with GA on 2026-10-01; old resources "will be deprecated over time" with no timeline [V]. API names, Wrangler commands and bindings may still move.
- **Miniflare local S3 endpoint for R2** and **configurable V8 heap limit**: seen via release aggregators only [V2]; both are marked experimental or recent. Miniflare 5 is in alpha and reshapes config [V2].
- **Local enforcement of CPU/subrequest limits:** believed absent [T].
- **`prometheus/compliance` details:** float tolerance, `query_tweaks`, exact case count and recent commit activity not confirmed from the README [V: not stated]. The PromQL loader is scrape-based; an adapter for a remote-write-only system needs design.
- **`promqltest` script syntax details** (`expect` lines, annotations) from memory [T]; read the pinned upstream README before writing the parser.
- **Tempo corpus layout** (`test_examples.yaml` sections for valid / parse-fail / validate-fail) inferred, not read [V2/T].
- **promqlsmith maintenance:** last push April 2025 [V2]; may lack Prometheus 3.x features (UTF-8 names, newer functions, native histogram functions).
- **CodSpeed on `wasm32` targets:** no confirmation found.
- **Antithesis pricing** differs between its site ($2,999/month Teams beta) and AWS Marketplace listings [V2]; and whether a `workerd`-in-container setup gives meaningful coverage of production DO semantics is untested.
- **OTel Demo flag names** taken from third-party posts; check `demo.flagd.json` at the pinned version.
- **SREGym / ORCA-bench numbers** are author-reported; one ORCA-bench abstract mentions model names I could not verify.
- **celld's simulator** is not evidently public; the alarm-race story came from an aggregator.
- **OTLP conformance:** I found no official receiver conformance suite; if one appeared in 2026, adopt it.
- Whether **Workflows local introspection** is stable enough for CI gating given reported flakiness on slow runners [V2].
- Whether **DuckDB-WASM or another independent reader can run inside a Worker/Workflow** within limits for the production scrubber, or whether the scrubber must run off-platform.

---

## 19. Sources

Cloudflare testing and platform

- Workers Vitest integration — test APIs: https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- Known issues: https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
- `@cloudflare/vitest-pool-workers` is now `@cloudflare/vitest-plugin` (2026-08-19): https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/
- Durable Object eviction test helpers (2026-06-25): https://developers.cloudflare.com/changelog/post/2026-06-25-durable-object-eviction-test-helpers/
- Migrate from Vitest 3 to Vitest 4: https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/
- Testing Durable Objects: https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects
- Supported bindings per development mode: https://developers.cloudflare.com/workers/development-testing/bindings-per-env/
- Worker Previews (2026-09-22): https://developers.cloudflare.com/changelog/post/2026-09-22-worker-previews/
- Preview URLs: https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits
- Subrequest limit change (2026-02-11): https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/
- Basin changelog (GA 2026-10-01; renames): https://developers.cloudflare.com/changelog/product/basin/
- R2 Data Catalog table maintenance: https://developers.cloudflare.com/r2/data-catalog/table-maintenance/
- Snapshot expiration (2025-12-18): https://developers.cloudflare.com/changelog/post/2025-12-18-r2-data-catalog-snapshot-expiration/
- Table maintenance dashboard (2026-09-16): https://developers.cloudflare.com/changelog/post/2026-09-16-table-maintenance-dashboard/
- Miniflare 4.20260722.1 release notes (local S3 API for R2), via aggregator: https://newreleases.io/project/github/cloudflare/workers-sdk/release/miniflare@4.20260722.1
- Wrangler 4.115.0 summary (local S3 credentials), via aggregator: https://releases.sh/release/rel_Ep-sFGOtu356Mx2P2iRwq
- Miniflare 5 alpha notes, via aggregator: https://newreleases.io/project/github/cloudflare/workers-sdk/release/miniflare@5.20260825.0-alpha
- Better testing for Workflows (Cloudflare blog): https://blog.cloudflare.com/better-testing-for-workflows/
- DO alarm-loop billing incident write-up (third party): https://dev.to/riversea/my-durable-objects-alarm-loop-burned-cpu-for-3-days-before-i-noticed-heres-what-the-docs-miss-27fg
- celld repository: https://github.com/losfair/celld

Query and protocol conformance

- prometheus/compliance: https://github.com/prometheus/compliance
- PromQL tester README: https://github.com/prometheus/compliance/blob/main/promql/README.md
- Remote-Write 2.0 suites README: https://github.com/prometheus/compliance/blob/main/remotewrite/README.md
- promqltest package: https://pkg.go.dev/github.com/prometheus/prometheus/promql/promqltest
- PromLabs, comparing PromQL correctness across vendors: https://promlabs.com/blog/2020/08/06/comparing-promql-correctness-across-vendors/
- promqlsmith: https://github.com/cortexproject/promqlsmith
- GreptimeDB, Prometheus in Rust (PromCon talk write-up, 2026): https://greptime.com/blogs/2026-01-14-promcon-engage-prometheus-in-rust
- Tempo PR touching `pkg/traceql/test_examples.yaml`: https://github.com/grafana/tempo/pull/6866
- TraceQL query examples: https://grafana.com/docs/grafana/latest/datasources/tempo/query-editor/traceql-query-examples/

Storage, specs, simulation

- Jack Vanlightly, Apache Iceberg's consistency model part 3 (FizzBee model): https://jack-vanlightly.com/analyses/2024/8/6/apache-icebergs-consistency-model-part-3
- pgEdge ColdFront formal model (TLA+ of Iceberg commit serialization): https://docs.pgedge.com/coldfront/development/formal/
- Quint: https://quint-lang.org/ ; quint-connect (Rust): https://docs.rs/quint-connect ; Emerald case study: https://quint-lang.org/posts/quint_connect_emerald
- FizzBee: https://fizzbee.io ; fault injection: https://fizzbee.io/tutorials/fault-injection ; model-based testing: https://fizzbee.io/testing/
- Validating traces of distributed programs against TLA+ specs: https://arxiv.org/pdf/2404.16075
- TigerBeetle, Protocol-Aware Deterministic Simulation Testing (2026-08-20): https://tigerbeetle.com/blog/2026-08-20-protocol-aware-dst
- TigerBeetle, Fuzzer Blind Spots (Meet Jepsen!): https://tigerbeetle.com/blog/2025-06-06-fuzzer-blind-spots-meet-jepsen/
- Jepsen, TigerBeetle 0.16.11: https://jepsen.io/analyses/tigerbeetle-0.16.11
- Jepsen, Bufstream 0.1.0: https://jepsen.io/analyses/bufstream-0.1.0
- Jepsen analyses index: https://jepsen.io/analyses
- Polar Signals, (Mostly) DST in Go: https://polarsignals.com/blog/posts/2024/05/28/mostly-dst-in-go
- Antithesis plans and pricing: https://antithesis.com/quickstart/
- Iceberg REST catalog compatibility test write-up: https://datalakehousehub.com/blog/iceberg-rest-catalog-compatibility-test
- Iceberg open-api / RCK: https://apache.googlesource.com/iceberg/+/refs/heads/main/open-api
- DuckDB Iceberg REST catalogs: https://duckdb.org/docs/current/core_extensions/iceberg/iceberg_rest_catalogs

Performance tooling

- CodSpeed Criterion integration: https://codspeed.io/docs/benchmarks/rust/criterion
- Bencher: https://bencher.dev/
- xk6-client-prometheus-remote: https://pkg.go.dev/github.com/grafana/xk6-client-prometheus-remote ; API docs: https://remotewrite.x.k6.io/

Agents and security

- SREGym: https://arxiv.org/abs/2605.07161
- ORCA-bench: https://arxiv.org/pdf/2607.28545
- Cloud-OpsBench: https://arxiv.org/html/2603.00468
- LogJack: https://arxiv.org/html/2604.15368
- Poisoning the Watchtower (summary): https://www.emergentmind.com/papers/2605.24421
- LogInject (summary): https://www.alphaxiv.org/abs/2607.14493.md
- Vendor case study on AI SRE agent injection: https://www.straiker.ai/blog/ai-sre-agent-prompt-injection-kubernetes-ransomware
- OpenTelemetry Demo feature flags: https://opentelemetry.io/docs/demo/feature-flags
- MCP conformance runner: https://github.com/modelcontextprotocol/conformance
