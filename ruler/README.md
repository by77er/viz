# Ruler

Prometheus-style rule evaluation, Alertmanager-style notification and the monitors API for
viz (design §7, decision D7). Three Durable Object classes and one Worker:

- **`Ruler`**, one per tenant rule shard, named `<tenant>/<n>`. Holds rule groups, evaluates
  each group with one batch call to the engine per tick, owns alert state, hands alert
  transitions to the notifier, keeps each monitor's transition history. Evaluates anomaly
  rules (part 8) with the detectors of `anomaly/` and keeps their state per (rule, series), and
  SLO burn-rate rules (part 10) from per-series bucket rings; warms new rules of both kinds from
  history (part 11) and backtests every kind (part 12).
- **`Notifier`**, one per tenant, named `<tenant>`. Routing tree, grouping timers,
  inhibition, silences, acknowledgements, a transactional outbox to webhook and Slack
  receivers with HMAC-signed requests, and each monitor's notification history.
- **`RulerIndex`**, 16 objects named `index/<k>`: the registry of ruler shards the cron
  sweeper walks, and each tenant's shard count.
- **The Worker** (`src/index.ts`): the HTTP API (`src/http.ts`) and the Cron Trigger
  `scheduled()` that runs `sweep()`.

The ruler takes the engine as injected interfaces (`BatchEvaluator`, `RangeEvaluator`,
`Validator`). **In production they are viz-query's Prometheus HTTP API** over the `QUERY`
service binding, recording rules go to viz-ingest's Remote Write over `INGEST`, both with a
service key the tenant's control plane issues, and notifications go to the destination set in
control (part 9, decision D39). The measurements of parts 1–8 were produced against scripted
fakes, so they are **ruler overhead only**; part 9's trial is the first run on Cloudflare
(`deploy/README.md`, "Trial 2").

| File | Contents |
|---|---|
| `contracts-proposal/rules.ts` | Copy of the adopted `contracts/rules.ts` (identical, checked with `diff`) |
| `contracts-proposal/rules.v2.ts` | **The proposed contract changes**, as a typed diff over the copy (see "Contract issues") |
| `src/statemachine.ts` | The alert state machine as one pure function, used by live ticks and by backtests; no-data policies; recording-rule samples; `ALERTS` definition |
| `src/ruler.ts` | `Ruler`: storage, scheduling, batched tick, hand-off outbox, timelines, backtest, group export/import/release, health, dead-man's switch |
| `src/evaluator.ts` | The single-call → batch adapter; the permissive `Validator` stand-in |
| `src/engine.ts` | Production engine: viz-query's HTTP API (`/query`, `/query_range`, `/plan`) behind one gate per object (one call in flight) |
| `src/credential.ts` | The shard's service key from control (`contracts/control.ts` `serviceKey`): stored, refreshed, never shown |
| `src/remote.ts` | Production sink: Remote Write 1.0 to viz-ingest (protobuf + snappy encoder) |
| `src/backtest.ts` | `trackIntervals`: any rule's per-step result through `evalAlertingRule`, as intervals with the annotations each alert entered with; summary, resolution note |
| `src/slo.ts` | SLO rules (part 10): the `slo` block, defaults, the per-tick expression, the bucket rings with block-cached window sums, one evaluation (pure), the sentence, the stored rows |
| `src/history.ts` | Parts 11 and 12: plan-checked range reads (`fetchHistory`), warm-ups of anomaly and SLO rules, backtests of anomaly and SLO rules, the budgets (pure apart from the engine calls) |
| `src/notifier.ts` | `Notifier`: grouping, flush decisions, acknowledge, silences with undo, outbox, signing, delivery, notification log |
| `src/amconfig.ts` | Notifier config validation, routing, matchers, inhibition, silence matching, secret redaction (pure) |
| `src/http.ts` | The HTTP API: routes, auth through edge's verifier, Prometheus-compatible reads, monitors, groups, rule files, backtest, placement and shard moves |
| `src/monitors.ts` | Monitor document → alerting or anomaly rule, error paths in the monitor's own field names, views, history merge (pure) |
| `src/anomaly.ts` | Anomaly rules (part 8): the `anomaly` block, defaults and the detector guide, one evaluation (pure), the stored form of detector state |
| `src/registry.ts` | `RulerIndex` and `sweep()` |
| `src/schema.ts` | The three classes' storage as versioned migrations, and `FORMATS`: the version of everything the ruler writes for other releases |
| `src/placement.ts` | Jump-hash assignment of groups to shards (pure) |
| `src/signature.ts` | `X-Viz-Signature` HMAC-SHA256 signing and a reference verifier |
| `src/yaml.ts`, `src/rulefile.ts` | Subset YAML parser and emitter; rule-file import/export |
| `src/rules.ts`, `src/template.ts`, `src/classify.ts`, `src/payload.ts` | Rule-file validation; template subset; cost classification; webhook and Slack bodies |
| `openapi.json` | OpenAPI 3.1 description of every route (checked against `ROUTES` by `test/http.test.ts`) |
| `tools/promcheck/` | Go: Prometheus' own code reading what the ruler writes (see parts 2 and 5) |
| `test/harness.ts` | The test worker: the classes with clock, evaluators, sink, receiver and crash points overridden; `FakeQuery` and `FakeIngest` entrypoints (edge's real `authenticate`, tenant from the key) and control's real `Tenant` for the production wiring |
| `test/anomaly.bench.ts`, `vitest.measure.config.ts` | Anomaly rule measurements in workerd (`npm run bench:anomaly`); the config adds `HOST`, which reads workerd's CPU time, its resident memory and the load average in Node |
| `test/slo.bench.ts` | SLO tick, warm-up and 7-day backtest measurements in workerd (`npm run bench:history`) |
| `scripts/mutants.mjs` | Mutation checks, applied to a scratch copy |

`wrangler.jsonc` is the production shape, from which `deploy/configure.mjs` generates the
deployed config: bindings `RULER`, `NOTIFIER`, `RULER_INDEX`, `CONFIG` (edge's API-key KV
namespace, by edge's placeholder id; never the unrelated account namespace also called
`CONFIG`), `QUERY` (viz-query) and `INGEST` (viz-ingest) service bindings, `TENANT` (control's
`Tenant` object by `script_name`), the cron `*/15 * * * *`, and the compatibility flag
`global_fetch_strictly_public` (webhooks always leave over the public internet). It is deployed
after viz-control, viz-query and viz-ingest and before viz-mcp and viz-gateway
(`deploy/workers.json`). Tests run against `wrangler.test.jsonc`, which binds the subclasses in
`test/harness.ts`, the fake query and ingest services, and control's real `Tenant`.

## What is implemented

The seven parts of the earlier task, in order, then anomaly rules (part 8), then what was there before.

### 1. Batch evaluation

`BatchEvaluator.evaluate(requests[]) → results[]` (proposed contract). A group tick sends
**all of the group's expressions in one call**, each request with the rule key as `id` and
the group's evaluation time (minus `query_offset`). A rule with a no-data expression adds a
second request (`<key>#presence`) to the same call. Results may come in any order.

- **One failing expression does not fail the batch.** A result `{ ok: false }`, or a
  missing result, marks only its rule `health: err` with the engine's message and leaves
  that rule's alerts exactly as they were; every other rule of the call is evaluated and
  may transition in the same tick. Only a rejected call (engine unreachable) or the group
  time budget (`groupTimeoutMs`, with an `AbortSignal` to the engine and a 25 ms grace)
  fails every rule of the call, again without touching alert state.
- **The single-call form is kept** as `batchFromSingle(Evaluator)`: requests run one after
  another in order, each failure stays on its own request, an abort returns what finished.
  A ruler whose `EVALUATOR` binding has only `instant` uses it; one with `evaluate` uses the
  batch form directly.
- **Recording rules read in the same tick.** In Prometheus (v0.308.0 `rules/group.go`,
  read from the module cache) rules of a group run one after another by default, and each
  rule's samples are committed (`app.Commit()` in a deferred call inside `eval`) before
  the next rule runs, so a later rule queries the series an earlier rule recorded at the
  same timestamp. With `--enable-feature=concurrent-rule-eval`, `buildDependencyMap`
  parses each expression and treats a selector whose metric-name matcher (equality *or*
  regex) matches an earlier rule's name as a dependency; a selector with no name matcher
  makes the whole group sequential. Viz keeps one batch per group except where a rule's
  text (or its no-data expression) **contains the name of a series recorded earlier in the
  same batch**: there a new batch starts, after the recorded samples were handed to the
  sink. So the visible dependency behaves as in Prometheus (`batch.test.ts`: two calls,
  `[x, sum(up)]` then `[job:up:sum > 5, y]`, the second sees the value). **Difference:** the
  check is a substring search, not a parse. It over-splits harmlessly (a name inside a
  longer name), and it misses a dependency the text does not show, such as
  `{__name__=~"job:up:.+"}`: that rule reads the previous tick's value, one interval late,
  where Prometheus' sequential default would see this tick's (`batch.test.ts`, "THE
  LIMITATION"). Whether the engine can see a sample the sink just accepted is the engine's
  read-your-writes, which this component cannot check (contract issue 4).

### 2. HTTP API

Every route, its scope and whether it takes `dryRun` are in `ROUTES` (`src/http.ts`) and in
`openapi.json` (OpenAPI 3.1). Authentication imports `authenticate` from
`edge/src/auth.ts` (no copy): `Authorization: Bearer viz_<id>_<secret>` or Basic, checked
against edge's key store `CONFIG`; scopes `monitors:read`, `monitors:write`,
`monitors:ack`. **The tenant comes only from the key record**: no path segment, query
parameter, header or body field is read for it, and every object call passes it on, so a
Durable Object reached for another tenant answers `wrong_tenant`.

**Prometheus-compatible, read-only.** `GET /api/v1/rules` (with `type`, `rule_name[]`,
`rule_group[]`, `file[]`, `exclude_alerts`, `group_limit`, `group_next_token`) and
`GET /api/v1/alerts`, in Prometheus' envelope `{status, data}` and error form
`{status: "error", errorType, error}`. Groups from every shard; `file` is `shard-<n>`.
Values print as `strconv.FormatFloat(v, 'e', -1, 64)`, times as Go prints a `time.Time`.
*How it was checked:* by Prometheus' own code, not by transcription alone. The test
`test/independent.test.ts` captures the real responses in 22 situations (before the first
evaluation; pending; firing; `health: err` with `lastError`; `keep_firing_for` with
`keepFiringSince`; a no-data alert whose value is `NaN`; the watchdog; every filter;
both pages of a paged answer; five error answers; times with trailing zeros), and
`tools/promcheck` (Go) then (a) reads the field names, `omitempty` and Go types of
`Response`, `RuleDiscovery`, `RuleGroup`, `AlertingRule`, `RecordingRule`, `Alert`,
`AlertDiscovery` **from the source of `web/api/v1/api.go`** in the prometheus v0.308.0
module and requires every object to have exactly those fields with those JSON kinds;
(b) decodes every response with client_golang v1.23.2's `api/prometheus/v1` (whose
`RuleGroup` decoder dispatches on `type`); (c) re-prints every value with
`strconv.FormatFloat` and every time with Go's JSON encoding and compares bytes; (d) reads
the `errorType` table and `getDefaultErrorCode` from the same source and requires each
error to carry an upstream type with its upstream HTTP status, or one of viz's two
additions `unauthorized` (401) and `forbidden` (403), which exist because Prometheus has
no authentication. The vitest tests (`http.test.ts`) also hold the field lists and query
behaviour. **Deviation:** `match[]` on `/api/v1/rules` is refused with `bad_data` rather
than ignored (Prometheus filters rules by their labels with it).

**Viz's monitors API** (`/api/v1/monitors…`). A monitor *is* one alerting rule: its
message, description and runbook are the `summary`, `description` and `runbook_url`
annotations, its receiver is the `viz_receiver` label (routed ahead of the tree), the rest
(id `mon_<16 hex>`, owner, `startInvestigation`, the threshold as written, who created and
last changed it) is the rule's `monitor` block.

| Route | Scope | What |
|---|---|---|
| `GET /monitors?filter=all\|attention\|silenced` | read | Every alerting rule as a monitor: state (`firing`, `pending`, `no_data`, `error`, `ok`, `unknown`), **firing since** (`for` satisfied) and **activeAt** ("above threshold since"), current value, threshold text (`> 500 ms for 5m`), who would be notified (receivers and integrations, never a URL), per alert `lastNotifiedAt` / `nextRepeatAt` / `firesAt` / `handedOff`, **acknowledged by and at**, **silenced until**; counts; last evaluation; watchdog state |
| `POST /monitors`, `PUT /monitors/{id}` | write | Name, description, message template, runbook URL, owner, notify (receiver), `noData` `ok\|alerting\|keep` with `noDataFor`, `startInvestigation`, `for`, `keepFiringFor`, interval, labels, annotations; either `expr` or `query` + `condition {op, threshold, unit}`. Answers the **cost class** and **warnings**; problems come back `422` with a **path in the monitor's own field names and a fix**. Monitors with the same interval share the group `monitors/<interval>` (so one batch) |
| `DELETE /monitors/{id}` | write | Resolves its firing alerts (the receivers are told), drops its history |
| `GET /monitors/{id}` | read | The monitor and its **history**: the ruler's transitions (created/edited, pending, firing, resolved, cleared) merged with the notifier's log (notified: receiver, integration, channel, repeat or not, idempotency key, delivered at or failed; acknowledged/unacknowledged by; silenced by until; silence undone/expired). **Bounded**: 200 transitions per monitor in the ruler, 200 entries in the notifier, the oldest dropped and counted in `dropped` |
| `POST /monitors/{id}/acknowledge`, `…/unacknowledge` | ack | All firing alerts of the monitor, or one by `fingerprint`. Acknowledging records who and when, **stops repeat notifications until the alert resolves, and hides nothing** (the alert stays listed and firing; a change in its notification group still notifies). The first acknowledgement stands. Un-acknowledging resumes repeats, at once if one is overdue |
| `POST /monitors/{id}/silence` | ack | One silence per alert matching exactly its labels, for `duration`; returns an **undo token** valid 60 s, shown once |
| `POST /monitors/silences/undo` | ack | Deletes the silences of that call (as if never made); after the window `410` |
| `GET /monitors/silences`, `DELETE /monitors/silences/{id}` | read / ack | List; expire now |
| `GET /monitors/groups`, `PUT\|DELETE /monitors/groups/{name}` | read / write | Rule groups as rule-file JSON, placed on shards |
| `GET\|POST /monitors/rulefile` | read / write | Prometheus rule-file YAML (or JSON) import; YAML export, `?extensions=false` for a file Prometheus loads |
| `POST /monitors/backtest` | read | Part 4, for the monitor about to be saved |
| `GET /monitors/detectors` | read | Part 8: what each anomaly detector is for, its defaults and the held-out evidence, each line labelled held out, post hoc or not scorable |
| `GET\|PUT /monitors/notifier` | read / write | Alertmanager-shaped config; secrets and secret-bearing URLs redacted on the way out |

**`dryRun` on every write** (query parameter or body field): the answer says what would
happen (`dryRun: true`) and nothing changes; tested route by route against everything the
API can show.

### 3. No data and absent series

Default (`no_data: ok`) is Prometheus: a pending alert whose series disappears is dropped
at once and `for` starts again when it returns; a firing alert resolves at that evaluation
unless `keep_firing_for` holds it (`keepFiringSince` set, resolution once the hold has
passed). `keep` leaves pending and firing alerts exactly as they are while data is missing
(a pending one is neither dropped nor promoted; nothing is resolved or notified; retained
resolved alerts still age out). `alerting` turns missing data into a synthetic series
`{viz_no_data="true"}` that goes through the same pending → firing path with `no_data_for`
as its hold, while the real alerts follow Prometheus. "Missing" is decided by
`no_data_expr` when given: a comparison (`x > 1`) is empty whenever the system is healthy,
so a monitor written as query + condition sends its bare query, in the same batch; without
it a warning says so. A failing no-data check fails the rule instead of guessing. Changing
the policy does not change the rule key, so alert state survives the edit.

### 4. Backtest

`Ruler.backtest(rule, from, to, step)` gets the range matrix from the injected
`RangeEvaluator` (and the presence matrix for a no-data expression), then feeds each step,
in time order, through **`evalAlertingRule`, the function a live tick calls**. One list of
intervals (`fingerprint`, labels, `pending|firing`, start, end, `open`, `noData`) is
produced; the summary (firing count, pending count, firing time, longest firing, pending
spans that cleared, firing at the end, series) is computed **from that list only**
(`summarize`), so a chart that shades the intervals and a sentence quoting the numbers
cannot disagree (review finding B4). **Resolution limits, stated in every result:** each
edge is within `max(step, live interval)` of where live evaluation would put it; a breach
shorter than the step can be missed and firings closer than a step are joined; `for`
shorter than the step counts as one step, otherwise it is rounded up to a whole number of
steps; a step finer than the live interval can show firings live evaluation would not
have seen; history is read as stored now, not as it was. At most 11,000 steps (Prometheus'
range limit); a too-long range is refused with the smallest step that would work. Since contract
version 4 every backtest is planned first and refused whole past a budget, and anomaly and SLO
rules are backtested too (part 12).

### 5. Rule files

`src/yaml.ts` is a subset YAML parser and emitter (no dependency, no `eval`): block maps and
sequences, plain / single / double-quoted scalars incl. multi-line, `|` and `>` with
chomping and indentation indicators, comments, one-line flow collections. **Refused with
the line and a fix:** anchors, aliases, merge keys, tags, directives, several documents,
complex keys, tabs in indentation, duplicate keys, multi-line flow collections. The rule-file
schema is applied as Prometheus' typed decoder does (`expr: 1` is the string "1"). Export
writes stable YAML; with `?extensions=false` viz's own fields (`no_data*`, `monitor`) are
left out and listed in a header comment and `x-viz-dropped-fields`. Round trips:
`yaml.test.ts` against the `yaml` npm package as reference parser (property test on the
emitter, kube-prometheus-style fixtures), and `tools/promcheck` through **Prometheus'
`rulefmt.Parse`** with unknown fields refused: for each of the four fixtures, the rules
Prometheus reads from viz's export equal the rules Prometheus reads from the file viz
imported (group labels applied, default interval made explicit); the extended export is
refused by strict `rulefmt` and accepted with unknown fields ignored.

### 6. Sweeper, shards, signed webhooks

**Where the sweeper's registry lives, and why.** A Durable Object whose alarm was lost never
runs again and cannot notice; something outside must know it exists. A cron invocation
starts with no tenant in hand, so the list must be reachable without one: a per-tenant
object (the Notifier) cannot hold it, and sweeping through Notifiers would wake every
tenant's Notifier every 15 minutes. So the list lives in `RulerIndex` objects
`index/<hash(tenant) mod 16>`: a fixed fan-out for the cron, no single object every tenant
writes to, and a row written only when a shard gains or loses all of its work (a ruler
remembers its registration; re-checked at heartbeats). `sweep()` pages each partition and
calls `ensureArmed`, which arms an alarm only on a ruler that has work and no alarm; a
second sweep changes nothing; an unreachable ruler is counted and left for the next run.
The one cross-tenant statement (`sweepPage`) is reachable from the cron only. Cost per run:
16 index requests plus one per registered shard.

**Shards.** `shard(group) = jump_consistent_hash(hash(group), N)`; `N` is the smallest count
not below the stored one at which no shard exceeds 1,000 rules or 64 groups. Pure and
order-independent, so every caller computes the same placement; `N` is stored in the index
and only grows; a group is never split (a group larger than a shard is refused with "Split
the group."). Growing from N to N+1 moves only groups that land on the new shard. A move is
`exportGroup` (rules, every alert with its times, the monitors' histories) → `importGroup`
on the target → `releaseGroup` at the source (forgets without resolving or notifying):
alert state, `for` timers and history continue, the notifier hears nothing. A move cut
between copy and release is finished by the next write; reads meanwhile use the assigned
shard.

**Signed webhooks.** A webhook config may carry `secret` (≥ 16 characters). Each attempt is
sent with `X-Viz-Signature: t=<unix s>,v1=hex(HMAC-SHA256(secret, "<t>.<Idempotency-Key>.<body>"))`;
`t` is the attempt's time, so a retry is re-signed under the same key. The secret is read
from the config at send time, never copied into the outbox, and never returned: the config
comes back with `has_secret`, URLs with their query or token path cut; sending the shown
config back keeps the stored secret and URLs; `secret: ""` removes it.
`verifySignature` (exported) is the receiver's side.

### 7. Validator

`Validator.check(promql) → { ok, errors[{message, offset?, fix?}], selectors[] }` is called
at save for every `expr` and `no_data_expr`, before the transaction; errors come back with
the expression's path. `permissiveValidator` (used until the engine binding has `check`)
accepts every non-empty expression and reports no selectors; a validator that cannot be
reached does not block saving. So a wrong expression is still found at its first
evaluation: re-verified that it becomes `health: err` with the engine's message (in
`/api/v1/rules` as `lastError`), keeps its state, stays `err` across eviction, and
recovers when the query works.

### 8. Anomaly rules (contract version 2)

An **anomaly rule** watches every series of one PromQL expression with a detector from
`anomaly/` (imported from `../../anomaly/src/index.ts`, not copied). The contract is
`contracts/rules.ts`, "anomaly rules (contract version 2)": additive, so every rule file and
stored group valid before means the same. Code: `src/anomaly.ts` (parsing, defaults, the guide,
one evaluation, the stored form), `src/rules.ts` (the `anomaly` block of a rule-file entry),
`src/ruler.ts` (tick, commit, load, moves), `src/monitors.ts` and `src/http.ts` (the API).

**Writing one.** In a rule file, an alerting entry with an `anomaly` block:

```yaml
- alert: CheckoutLatencyAnomaly
  expr: sum by (service) (rate(http_request_duration_ms_sum{service="checkout"}[5m]))
  keep_firing_for: 10m
  anomaly: { detector: ewma, unit: ms, max_series: 20 }   # all optional
```

Through the monitors API, `query` plus `anomaly: { detector?, params?, unit?, severity?,
maxSeries? }` instead of `condition`; such monitors go in their own default groups,
`anomalies/<interval>`, so that a rollback to a release without anomaly rules never rewrites a
group holding them when a threshold monitor is edited. The detector and every parameter are
resolved at save and written out (`given` lists what the author chose), so a later change of a
default changes no stored rule; a new detector or parameter is a new rule key, with fresh state.
Unknown parameters, wrong types, `stepMs` (the interval is the step) and impossible values are
refused with a path and a fix. The save answers the expression's cost class and the detector's
`history` (tick class, cold-start class, look-back, points before scoring).

**Defaults follow the evidence** (decision D33; the guide is `DETECTOR_GUIDE` in
`src/anomaly.ts`, served at `GET /api/v1/monitors/detectors`; numbers from
`anomaly/README.md`, held-out NAB, standard profile, nothing measured on viz's own data):

| Detector | In rules | Default | Held-out NAB | What the guide says |
|---|---|---|---|---|
| `ewma` | yes | **the default**: half-life 100, k 8 (chosen on held-out folds; the library's own 30 / 4 scored 0.0), severity `ticket` | 30.1 (threshold 21.8) | validated on NAB only; below the threshold in the low-FP profile, so `ticket` |
| `threshold` | yes | **with `severity: page` and no detector** (the author gives `above` / `below`) | 21.8; low-FP 5.5 vs EWMA 3.9 | the baseline; best where false alarms cost most |
| `robust_z` | yes, with a warning | none (MAD spread) | −105.9 | below a static threshold; the quantile spread (44.8) is post hoc, warned as unvalidated, never a default |
| `seasonal` | yes, with a warning | none; needs `periodMs` | −76.4 | below a static threshold in aggregate; the only one that sees phase-wrong values |
| `cusum` | yes, with a warning; **may not page** | severity `info` | 15.1 | an explanation ("mean shifted from A to B at T"), not a pager |
| `stl`, `pelt` | **refused** | | −352.2, −123.5 | explanations for scheduled jobs, not pagers |
| `burn_rate` | **refused** | | not scorable on NAB | SLOs are to compile to recording rules (not built) |

**Each tick.** The anomaly rules of a group are evaluated in the group's batch call, after its
other rules (`RuleGroup.anomalyRules`, kept out of `rules` so that an older release never runs one
as a plain alerting rule). For each series of the result: the detector's `detect` on that one
point from the series' in-memory state. A flagged series becomes the rule's result with the
detector's sentence in the `anomaly` annotation, its numbers as `AnomalyDetail` JSON in
`anomaly_detail` (format `annotation.anomaly-detail` v1), and the sentence as `description` when
the author wrote none; the rule's `severity` label comes from `anomaly.severity`, for routing.
From there `for`, `keep_firing_for` (the monitors API defaults to `0s` and `10m`: alarms are
onsets), no-data policies, alert state, the hand-off outbox and the notifier are the alerting
rule's, unchanged. A `warming` point is not returned and the rule says what it needs; a NaN point
is not scored and keeps the series' previous flag (a gap is not a recovery); a series absent
longer than the detector's look-back has its state dropped and counted (`pruned`). Monitors show
state `warming` until the detector scores.

**State.** Per (rule, series) in the table `anomaly_state` (migration 2: additive, `readableFrom`
1, so the previous release stays a rollback target): one row per (rule, chunk), each row a batch
of series as `{"v":1,"series":[…]}` (format `store.anomaly-state` v1) of at most 512 KiB. It is
written **in the transaction that commits the tick's alerts**, so a replay finds both or neither,
and only when something changed; the constructor rebuilds memory from these rows alone. Each
series remembers how its last point was scored, so a tick replayed after an eviction (the
heartbeat cursor is behind) reproduces its alerts and status and advances no detector twice. An
edit that keeps the detector, its parameters and the interval keeps the state; otherwise it is
deleted. A shard move carries the rows in `GroupBundle.anomalyState`. Rows in a version this
release does not read (a newer release wrote them) are **refused**: the rule is
`state_unreadable`, nothing is scored, the rows are kept as they are (also through a move), and
no alert changes; it never starts cold over them. A stored rule naming a detector this release
does not know is refused the same way (`unsupported_detector` in its error), never run as
another detector.

**Bounds, each an explicit refusal.**

| Bound | Default (`RulerLimits`) | Beyond it |
|---|---|---|
| Series per rule (`max_series`) | 100, or fewer when 100 series' estimated state would not fit the per-rule limit (the save warns: CUSUM 49, robust z 89); at most `maxAnomalySeriesPerRule` 1,000 | the evaluation is refused, `series_cap_exceeded` with the count; nothing is scored, no state row or alert changes; never a silent drop |
| State of one series | 65,536 B | at save from the estimate (e.g. a weekly season at a 10 s interval); at run time `state_limit_exceeded`, nothing changes |
| State of one rule | 1,048,576 B | the same |
| State of one ruler object | 16 MiB, summed at save as estimate × `max_series` over all its anomaly rules | the save is refused with the rule's path: state is held in memory between ticks (parsed and as JSON, about 3 bytes of heap per stored byte) |

Measured (below): one row written per tick for a 100-series EWMA, threshold or CUSUM rule, 2 for
robust z, 4–6 for seasonal; the same one row at 2 series as at 200.

### 9. Production wiring (decision D39)

**Evaluation** (`src/engine.ts`). viz-query has no RPC entrypoint, so the batch evaluator is
its Prometheus HTTP API over the `QUERY` service binding: each request of a batch is one
`POST /api/v1/query` with `query` and `time` (the evaluation time in seconds, exact to the
millisecond), in order; a failing request fails alone (its rule `err`, alerts untouched); a
request after the group's budget is spent fails with the abort reason. Backtests use
`/api/v1/query_range`; save-time validation uses `/api/v1/plan` (parse and plan, one ledger
read, nothing fetched or evaluated): `bad_data` and `unsupported` refuse the save with the
engine's message at the expression's path; any other failure (an outage, a key not yet
propagated) saves without blocking, as before. Matrices and strings are refused as a rule
result. `EVALUATOR` / `SINK` RPC bindings, when they exist, win.

**Six connections.** A Worker reached through a service binding spends from its caller's six
simultaneous connections (AGENTS.md, spike S1), and one query of viz-query may open several
itself (the ledger, then shards and leaves in parallel). So every engine call of one Ruler
object, from every group due at the same alarm (up to `maxConcurrentGroups`, 4) and from
save-time validation, passes one gate that admits **one call at a time**
(`ENGINE_CALLS_IN_FLIGHT`); the ruler adds no connection of its own while query works. The
notifier's webhooks run in the `Notifier`, another object with its own six, one at a time.
Cost: a group's tick takes the sum of its queries' latencies (see "Risks").

**Credential** (`src/credential.ts`, `contracts/control.ts`). The query API and Remote Write
take the tenant from an API key. A tick has no caller to borrow one from, so each Ruler object
holds a **service key** issued by the tenant's `Tenant` object over the `TENANT` binding:
`service:viz-ruler/<shard>`, scopes `read` and `write` (fixed by the contract), listed among the
tenant's keys, audited (`key.service`), revocable. The ruler asks for one when it has none, and
again only when the query service refused its key **and** the key is older than 3 minutes (a
fresh key may not have reached every KV location: `PROPAGATION_GRACE_MS`) **and** the last
request is 5 minutes old (`REISSUE_MIN_INTERVAL_MS`; each request rotates the key). Concurrent
callers share one request. A key a person disabled is not replaced: the rules report "the tenant
disabled the ruler's service key …" until it is enabled. The key is stored in `meta`
(k `service_key`), the only copy in clear: never logged, never in an RPC or HTTP answer, never
exported with a group. The tenant is the Ruler object's own (from its name, which the HTTP API
derived from a credential); every callee takes it from the key.

**Recording rules** (`src/remote.ts`): one Remote Write 1.0 request per sink call to viz-ingest
over `INGEST`, with the same key (`write`). Values are parsed from Prometheus' text form
(`+Inf`, `-Inf`, `NaN` included); a series and timestamp written again is the same row, so the
ruler's retries are harmless.

**Notifications to the destination set in control.** The tenant's control plane holds a default
webhook (`PUT /api/v1/control/settings/notifications`: URL, `webhookFormat` `alertmanager` or
`json`, write-only `webhookSecret`, `sendResolved`). The notifier reads it with
`Tenant.notificationTarget` over `TENANT`, at most once a minute while it has work (on a
hand-off and at its alarm; `CONTROL_REFRESH_MS`), keeps a copy in `meta` (k `control_target`)
so a control outage changes no routing, and offers it as the reserved receiver **`viz:default`**
(`contracts/rules.ts` `CONTROL_RECEIVER`, contract version 3): with no notifier config of the
tenant's own, everything routes there with Alertmanager's default timers; with one, routes and
monitors (`notify`) may name it; a tenant config may not define it (422). When control's
destination changes, groups are re-derived as on `setConfig`.

- **Bodies.** `format: alertmanager` is Alertmanager's webhook JSON (version "4", as before).
  `format: json` is viz's plain form, `viz.notification/v1` (`JsonNotification`): status,
  receiver, group key and labels, and per alert its name, labels, annotations, `startsAt`,
  `endsAt` (null while firing), `value` and fingerprint, plus `idempotencyKey`, equal to the
  `Idempotency-Key` header. Both are built once, when the notification is decided, and stored
  in the outbox: every attempt sends the same bytes under the same key, signed again with the
  attempt's time (`X-Viz-Signature`). Neither carries the URL, the secret or a key (golden
  `test/golden/formats/http.webhook-json.v1.json`).
- **Retries** are the existing outbox's: seeded exponential backoff, a 4xx other than 408/429
  is permanent, dead letters after `max_attempts`. At least once; a receiver that de-duplicates
  on the key processes each notification once.
- **No secret in what is stored or shown.** A delivery error is stored (`last_error`, the
  monitors' history, the outbox RPC) as the error's kind and message with every URL cut out
  (`<url>`): a runtime's network error may quote the URL, and a URL can carry a credential.
  Nothing in the ruler or the notifier logs a URL, a key or a secret.

**Health.** `GET /healthz` (and `HEAD`), outside the API and without a credential, as the other
viz Workers serve it: 200 `ok` with `CONFIG`, `RULER`, `NOTIFIER`, `RULER_INDEX`, `TENANT` and
`QUERY` (or an `EVALUATOR`) bound, 503 naming the missing ones; it calls nothing. The gateway asks
it through its `RULER` binding.

**A staged trial stops by itself.** `VIZ_STAGE_EXPIRES_AT` (set by `deploy/configure.mjs
--expires` for a stage only): after it the Ruler's and the Notifier's alarms delete themselves
and the cron sweeper does nothing.

**On Cloudflare (Trial 2, `deploy/README.md`; measured on Cloudflare, 2026-11-19).** A staged
deployment of the six Workers, since destroyed: a threshold monitor, an anomaly monitor and a
recording rule through the API on the gateway; 20 runs each made one alert, and the sink set in
control's notification settings received **20 firing notifications, 0 duplicates, every one
signed and with `Idempotency-Key` equal to the body's key, no secret in any body**; switching
the format in control turned the next one into Alertmanager's body. **Rule evaluation
(`startsAt`) to webhook arrival: n = 20, p50 174 ms, p90 187 ms, p99 266 ms.** The anomaly rule
evaluated (`ok`, one series scored); the recorded series came back through Remote Write and
the query path; one service key was issued for the whole run (no rotation).

### 10. SLO burn-rate rules (contract version 4)

An **SLO rule** is an objective, a compliance window and an SLI; the ruler raises the Google SRE
Workbook's multi-window, multi-burn-rate alerts (chapter 5, approach 6). The contract is
`contracts/rules.ts`, "SLO burn-rate rules (contract version 4)", changed first and on its own
(contract issue 16): additive, so every rule file, stored group and config valid under version 3
means the same. Code: `src/slo.ts`, `src/rules.ts` (the `slo` block of an entry), `src/ruler.ts`
(tick, commit, load, moves), `src/monitors.ts` and `src/http.ts` (the API).

```yaml
- alert: CheckoutAvailability
  slo:
    objective: 0.999                 # required
    sli:                             # { bad, total }, { good, total } or { error_ratio }
      bad: sum(increase(http_requests_total{job="checkout",code=~"5.."}[$window]))
      total: sum(increase(http_requests_total{job="checkout"}[$window]))
    # window: 30d, alerts: the workbook's four, min_events: 0, min_coverage: 0.9, max_series: 10
```

Through the monitors API: `POST /api/v1/monitors` with `slo: { objective, sli: { bad, total } |
{ good, total } | { errorRatio }, window?, alerts?: [{ severity, longWindow, shortWindow, burnRate }],
minEvents?, minCoverage?, maxSeries? }` and no `query` or `condition`; default group `slos/<interval>`
(kept apart from threshold monitors for the rollback reason of part 8). Problems come back in the
monitor's own field names (`slo.sli.errorRatio`, `slo.alerts[0].longWindow`).

- **The SLI is written with `$window`**, which the ruler replaces with the bucket width: the group
  interval each tick, a coarse width when it reads the compliance window. An expression without
  it is refused (a `[5m]` range evaluated every minute would count events five times). `rate()`
  works as well as `increase()`; only `min_events` sees the unit. With `{ bad, total }` a missing
  bad series means no errors; with `{ good, total }` a missing good series means all bad, and a
  good series without a total one is refused (`invalid_result`: the two aggregate by different
  labels); `{ error_ratio }` weighs every bucket equally (time, not events).
- **Defaults are written out at save** (`given` lists what the author chose): the workbook's four
  alerts as `anomaly/` defines them (`SRE_WORKBOOK_RULES`: page 1 h / 5 m at 14.4× and 6 h / 30 m at
  6×, ticket 1 d / 2 h at 3× and 3 d / 6 h at 1×; the task named three, the library's table and the
  workbook's alert expressions have the fourth, D42), window 30 d, `min_coverage` 0.9,
  `max_series` 10 (at most `RulerLimits.maxSloSeriesPerRule`, 100). Any change of objective,
  window, SLI, alerts, `min_events` or `min_coverage` is a new rule key, with fresh state and a
  warm-up. Refused at save with a path and a fix: an objective outside (0, 1) (99.9 is answered
  "write 99.9% as 0.999"), an SLI form other than the three, a short window not shorter than its
  long one or shorter than the interval, a long window longer than the compliance window, a
  `severity` label (it is the burn-rate alert's), `expr`. Warned: windows that are not whole
  numbers of buckets, and an alert that can never fire (`burn_rate × (1 − objective) ≥ 1`, the
  workbook's "90% SLO" case).
- **One query per rule per tick**, in the group's one batch call: `label_replace(<total>,
  "viz_slo_part", "total", "", "") or label_replace(<bad or good>, "viz_slo_part", "bad", "", "")`
  with `$window` = the interval (the derived expression is `SloRule.expr`, shown in `/api/v1/rules`
  as the rule's `query`). Each series' bucket goes into a **fine ring** (the longest alert window
  in interval buckets: 4,320 at 1 minute) and a **coarse ring** (the compliance window in about
  720 buckets: one hour for 30 days). Window sums are taken backwards from the current bucket in a
  fixed order, whole blocks of 60 buckets from a cache, so equal buckets give equal sums however
  they arrived; `evaluateWindows` from `anomaly/` judges each alert (both windows strictly above,
  `min_events`), a window with less than `min_coverage` of its buckets does not count (the rule
  is `warming` and says which window), and every series with state is judged every tick, a
  missing bucket as missing.
- **Alerts**: one per series and severity (`severity="page"`, `severity="ticket"`), firing while any
  alert of that severity holds; its value is the burn rate; its `slo` annotation the sentence,
  its `slo_detail` annotation the numbers (`SloDetail`, format `annotation.slo-detail` v1), and
  the sentence is the `description` when the author wrote none. The sentence is the library's
  (`explainRule`) followed by the budget left over the compliance window, how much history that
  covers, and how long it lasts at the long window's rate:
  `error budget burning at 16.7× over 1 hour and 200× over 5 minutes (page threshold 14.4×); 2.31%
  of the 30 days budget for a 99.9% objective was spent in the last 1 hour; 97.7% of the budget is
  left over the last 30 days, spent in 1.76 days at this rate` (from `slo.test.ts`). With less
  history: `… over the 4 minutes on record (the window is 1 day)`; overspent: `the budget is spent
  … (-2470% left)`. `for`, `keep_firing_for`, no-data policies (the SLI returning no series), alert
  state, the hand-off and the notifier are the alerting rule's, unchanged.
- **State** (`Ruler` migration 3, table `slo_state`): per rule a head row (slot counters, the earliest
  bucket on record, each series' labels and last outcome, so a replayed tick reproduces its alerts)
  and blocks of 60 fine / 24 coarse buckets for all of its series, format `store.slo-state` v1. A
  tick writes the head and the current block of each ring (**three rows**, measured; a fourth when a
  block leaves a ring and is deleted), in the transaction that commits the tick's alerts; memory is
  a working copy adopted after the commit, rebuilt from these rows in the constructor. Rows a newer
  release wrote are refused (`state_unreadable`), kept, and carried by a shard move; a move carries
  the rings and the warm-up status (`GroupBundle.sloState`, `.warmup`). Bounds, each an explicit
  refusal that changes nothing: `series_cap_exceeded`, `invalid_result`; the per-object state budget
  (part 8) counts SLO rules too (about 150 KB estimated per series at 1 minute).

### 11. Warming new anomaly and SLO rules from history (contract version 4)

A new anomaly or SLO rule (a new rule key) gets a warm-up job (table `warmup`, one row per rule,
format `store.warmup` v1) in the save's transaction. At its group's first tick, before the batch:

1. **The reads**: an anomaly rule's detector look-back at the interval (`max(minPoints,
   lookbackMs / interval)` points ending one interval before the tick: 20 for EWMA with half-life 10,
   the window for the robust z-score, `seasons` periods for the seasonal baseline); an SLO rule's fine ring (from the start of the coarse bucket its
   window begins in) and the rest of the compliance window as coarse buckets, each with `$window` at
   its own width. A detector without history (the threshold) is `not_needed`.
2. **The cost, first**: every read, cut into pieces of at most 11,000 steps, is planned with
   viz-query's `/api/v1/plan` (`start`, `end`, `step`; one ledger read, nothing fetched). Over
   `RulerLimits.maxWarmupScanSamples` (3,000,000) or `maxWarmupBytes` (16 MiB) summed, or when any
   plan carries the engine's own refusal, the warm-up is **refused whole**: nothing is fetched, the
   rule starts cold, and its status says why with the plan's numbers and the budget. A plan without
   the numbers is refused too (the cost could not be checked).
3. **The fetch and the feed**: the reads are fetched whole and fed, in time order, through the
   rule's own evaluation (`evalAnomaly` / `evalSlo`, the functions a tick calls), so the state is
   what it would hold had the rule run all along; a result over `max_series` or a state over the
   limits refuses the warm-up the same way.
4. **The commit**: the state rows (whole batches: one `anomaly_state` row for three EWMA series; a
   head, ~73 fine and ~30 coarse blocks for an SLO) and the status in **one transaction**; then the
   rule is evaluated at this tick as usual.

An engine failure leaves the job `pending` (attempt counted) and the rule **waits this tick out**,
saying so (`warming: the engine failed the read (…); tried again at the next tick`); after three
attempts it is `failed` and the rule starts cold. A crash inside the commit writes nothing and the
retried alarm warms again to the same state; a finished warm-up is never read again (not after an
eviction, not after a move). The status is `RuleStatus.anomaly.warmup` / `.slo.warmup`
(`WarmupStatus`: status, reads, plan, budget, points, attempts, message), in `/api/v1/rules`'s
object form and in the monitor views; a pending warm-up shows the rule as `warming`. Both budgets
are `RulerLimits` (`configure` changes them). Rules saved before this release, and rules carried
over a save with their state, are not warmed.

### 12. Backtests of threshold, anomaly and SLO rules

`Ruler.backtest` and `POST /api/v1/monitors/backtest` take an alerting entry, an anomaly entry or
an SLO entry (or a monitor document of any kind); **`POST /api/v1/monitors/{id}/backtest`** (new,
`monitors:read`) takes a saved monitor as stored, at its group's interval. Every read is planned
first, as in part 11, against `RulerLimits.maxBacktestScanSamples` (20,000,000) and
`maxBacktestBytes` (128 MiB): past them the answer is `over_budget` (HTTP 422 `over_budget` with
`plan` and `budget`) and nothing is fetched; an engine failure is `failed` (502).

- **Alerting rules** as before (part 4), now planned first.
- **Anomaly and SLO rules** run at their interval (a step other than the interval is refused: a
  detector's step is the interval). One read covers the warm-up part and the range (`[from −
  look-back, to]`; an SLO adds its coarse read); the warm-up part is fed exactly as a warm-up at
  `fromMs` would feed it (no alerts), then every step from `fromMs` goes through `evalAnomaly` /
  `evalSlo` and `evalAlertingRule`, in time order: no second implementation.
- **The result** is part 4's, plus `kind`, `warmup` (the reads before `fromMs` and the points fed),
  `cost` (the plan's sums and the budget), and on each interval the `annotations` its alert carried
  when it entered the state: for an anomaly or SLO alert, the explanation it would have been sent
  with.
- **Live equivalence** (tested): for a rule that ran live from its creation, a backtest from the
  creation tick over the same data gives the same intervals (start, end, state) with the same
  annotations, for an EWMA rule with `for` and a templated summary, and for an SLO rule that paged
  and ticketed. A backtest that starts at another time can differ in the budget figure's last
  digits (its older coarse buckets come from a coarse read rather than sums of fine ones).

### 13. Streaming history: bounded memory for warm-ups and backtests

Warm-ups (part 11) and backtests (part 12) read history **in time windows, one at a time, in
order**: each window is fetched, fed step by step through the rule's evaluation, and dropped;
only the rule's state crosses a window boundary (detector state, the SLO's bucket rings, the alert
state machine's alerts, the intervals found so far). Where the windows fall changes nothing in the
result: the evaluation is the same function, called on the same steps in the same order (tested
across hundreds of boundaries, and against live evaluation).

**The memory model** (`src/history.ts`, `MEMORY`; bytes):

```
peak = fixed + window steps × series per step × 768
fixed (backtest) = 2 MiB (the call) + alerts × 3 KiB + 4 MiB (intervals, a cap) + the rule's state
  anomaly state  = max_series × the stored estimate per series × 3 (heap per stored byte, part 8)
  SLO state      = max_series × (16 × (fine + coarse ring buckets) + 4 KiB)   (80 KB a series at 1 minute)
fixed (warm-up)  = 2 MiB (the state built is the rule's own, held live afterwards and bounded by the
                   per-object state budget)
series per step  = the bound the rule's own evaluation enforces: max_series (twice for an SLO's two
                   parts; the no-data expression adds its own), or an alerting rule's alert limit
```

Windows are as long as `(budget − fixed) / (series per step × 768)` steps allows, at most 11,000.
The budgets are `RulerLimits` fields proposed in `rules.v2.ts` (`maxWarmupMemoryBytes` 16 MiB,
`maxBacktestMemoryBytes` 32 MiB; contract issue 18). **Refused before any plan or fetch** when the
fixed bytes and one step do not fit, or when the windows would take more than 1,000 range queries:
`over_budget` with the model's `memory: { peakBytes, budgetBytes }` (a warm-up: `refused`, the rule
starts cold). A window holding more points than it was sized for (the engine returned more series
than the rule allows) stops the run (`failed`, with that reason) instead of being evaluated. The
intervals of a backtest stop at 4 MiB (modelled: labels and annotations at two bytes a character).
The answer's `cost.memory` gives the modelled peak, the budget, the steps per window of each read
and the queries the windows took. Plans are still asked per 11,000-step piece of each whole read,
before the first window.

768 bytes a point is above every measurement of resident memory per point held (a window's JSON
parsed and indexed by step: 440–710 bytes, `test/memory.bench.ts`, below), not the live objects'
size, so the model is conservative about live memory by construction; what the checks below show is
that runs sized by it complete under a V8 heap limit like a Durable Object's.

### Versioned storage and formats (`contracts/COMPATIBILITY.md`)

- **Storage.** `Ruler`, `Notifier` and `RulerIndex` open SQLite in the constructor, inside
  `blockConcurrencyWhile`, with `openSchema` (`contracts/schema.ts`) and their spec in
  `src/schema.ts` (`ruler.Ruler`, `ruler.Notifier`, `ruler.RulerIndex`). Version 1 of each is
  the schema exactly as the pre-versioning constructors created it, so their storage is
  adopted without a row changing. The JSON in `spec`, `body`, `updates` and `v` columns is part
  of the schema.
- **Refusal.** Storage a newer release migrated past what this code may read: every Ruler and
  Notifier RPC answers `{ status: 'schema_too_new', … retryAfterMs }` (the guard that already
  answered `wrong_tenant` asks first), the registry's methods throw `SchemaTooNewError` (their
  results have one shape), the HTTP API answers 503 (`schema_too_new`, `Retry-After`; the
  Prometheus routes `errorType: unavailable`), and the alarms only re-arm themselves. A ruler
  whose notifier refuses keeps the transition in its hand-off outbox and retries it, as for an
  unreachable notifier.
- **Contract.** `contracts/rules.ts` gains `Refused = WrongTenant | SchemaTooNew`, and every
  RPC result that could be `WrongTenant` can now be `Refused` (`contracts-proposal/rules.ts`
  copies it; `rules.v2.ts` uses it).
- **Formats** (`FORMATS` in `src/schema.ts`, each pinned by `test/golden/formats/`): the
  hand-off to the notifier (as sent and as stored), the hashes that name stored state (rule
  keys, alert fingerprints, `hash64`), the notification idempotency key, the registry
  partition and group placement, the webhook body with its `X-Viz-Signature`, and the rule-file
  export. A change to any of them is caught by a golden test (mutants 57–59).
- **SLO rules and warm-ups** add, additively: `Ruler` migration 3 (tables `slo_state` and `warmup`,
  `readableFrom` 1: `compat` stays 1, so releases knowing migrations 1 or 1–2 can open it and stay
  rollback targets; golden `test/golden/schema/ruler.v3.json`; storage at version 1 or 2 with data
  upgrades without a row changing, `compat.test.ts`), the optional `sloRules` field of a stored
  group (absent when none), and four formats: `store.slo-rule`, `store.slo-state`, `store.warmup`
  and `annotation.slo-detail`, each v1 with a golden file. During a rollback to a release without
  them, SLO rules are not evaluated and their rows wait; an anomaly rule a rolled-back release
  evaluated is warmed when this release returns only if its job was still pending.
- **Anomaly rules** add, additively: `Ruler` migration 2 (the table `anomaly_state`,
  `readableFrom` 1: `compat` stays 1, so the previous release can open the storage and stays a
  rollback target; golden `test/golden/schema/ruler.v2.json`; storage at version 1 with data
  upgrades without a row changing, `compat.test.ts`), the optional `anomalyRules` field of a
  stored group (absent when a group has none, so such groups are stored byte for byte as
  before), and three formats: `store.anomaly-rule` (the stored rule, its key and its export),
  `store.anomaly-state` and `annotation.anomaly-detail`, each v1 with a golden file. During a
  rollback to a release without them, anomaly rules are not evaluated (that release reads
  `rules` only) and their state rows wait untouched.

### Kept from before (unchanged in behaviour)

**Rule model and templates.** The Prometheus rule-file shape; unknown fields rejected; every
error with a path and a fix; nothing saved unless the whole file is valid. The template
subset (`$labels`, `$value`, `$externalLabels`, `humanize*`, `printf`, `toUpper`,
`toLower`, `title`, trimming) parsed to a tree and interpreted; no `eval`.

**Scheduling and state.** One alarm at the earliest group deadline; aligned evaluation times
(`offset + k·interval`); groups due together run concurrently (at most 4); a late alarm
evaluates the latest due time once and counts the gap. The alert state machine transcribes
`AlertingRule.Eval` (prometheus/rules/alerting.go). Alert rows are written only on
transitions, in the same transaction as the hand-off row and the monitor's history entry;
memory is swapped after commit and rebuilt from SQLite in the constructor.

**Notifier.** Routing (`match`, `match_re`, `matchers`, `continue`), `group_by`,
`group_wait` / `group_interval` / `repeat_interval`, inhibition with `equal`, silences,
resolved notifications, `send_resolved`, webhook (Alertmanager v4 body) and Slack. Decision,
notification log and outbox row in one transaction; `Idempotency-Key` =
hash(tenant, receiver, integration, group key, group creation time, state hash,
notification number); seeded backoff; dead letters.

**Dead-man's switch, health, classification, limits** as before: shard 0 carries
`DeadMansSwitch`; `health()` per group; cost class `tail` / `recent` / `rollup` at save;
limits on groups, rules, alerts, annotations, silences; every SQL statement on tenant
data names the tenant.

## Not implemented

- **503 in `openapi.json`.** Every route can answer 503 `schema_too_new` during a rollback
  across a forward-only release; the OpenAPI document does not list it yet.

- **The engine side of the contract as an RPC.** viz-query exports no entrypoint, so there is
  no `EVALUATOR` binding: a group's batch is N HTTP requests in sequence, not one plan with
  shared scans (DESIGN §7), and the ruler needs a stored service key (part 9; "Needed
  changes"). No `SINK` RPC either: recording rules go through Remote Write.
- **Selectors from validation.** `/api/v1/plan` parses and plans but reports no selectors, so
  `Validator.selectors` stays empty and same-tick dependencies are still found by text.
- **Email notifications** (control's `notifications.email`): stored there, sent by nothing.
- **A test notification when a destination is saved**, and a check that it answers.
- **Same-tick dependencies the text does not show** (regex or wildcard name matchers), see
  part 1. A parse-based analysis needs `Validator.selectors` from the engine.
- **`match[]` on `/api/v1/rules`** (refused, not ignored).
- **`startInvestigation`** is stored and shown; nothing starts an investigation (the
  Workflow does not exist).
- **From review M11:** a "test notification on save" option and a page / message-only
  severity field. Severity can be a label today; neither is a monitor field.
- **Escalation, on-call schedules, notifying people by name.** "Who was notified" is the
  receiver and integration (and channel), not a person.
- **Authentication other than API keys** (OAuth/OIDC for people, design §9), rate limits
  per key, and pagination of `GET /monitors`.
- **A background reconciler for interrupted shard moves**: the next write finishes them.
  Shard count never shrinks; there is no merge of under-used shards.
- **`ALERTS` / `ALERTS_FOR_STATE`** are defined (`syntheticSeries`) but not written;
  **staleness markers**; **LogQL / TraceQL rules** (and so LogQL / TraceQL SLIs).
- **Anomaly rules (part 8):** the cross-series detector; STL refits and PELT as scheduled jobs; a
  placement that knows the per-object state budget (a save over it is refused, not moved to
  another shard); state written less often than every tick (each tick costs at least one row per
  rule, measured below).
- **SLO rules (part 10):** OpenSLO or Sloth file import; a Prometheus export of an SLO rule (with
  `?extensions=false` it is left out whole and listed; Sloth-style recording and alerting rules
  could be generated from it); a latency SLO written as a histogram threshold (the author writes
  the bucket counts as good and total); the burn rates or the remaining budget as series (nothing
  is recorded; the budget is in the alert, `slo_detail` and the rule's status only); a label naming
  the window that burned (it is in the annotations); the budget figure's far edge moves one coarse
  bucket (an hour for 30 days) at a time; rings for intervals finer than 100,000 buckets in the
  longest window (refused at save).
- **Warm-ups (part 11):** a warm-up that was refused or failed is not tried again later (the rule
  warms live); the cost is asked at the first tick, not at save (the save answers the class of the
  read, not its planned cost); the plan does not count the shards' tail; a warm-up runs inside its
  group's tick, so that tick's batch waits for it (one engine call at a time per object), and big
  warm-ups are not spread over several ticks.
- **Backtests (part 12):** anomaly and SLO rules at a step other than their interval; recording
  rules; a CPU budget (the plan's samples and bytes, and memory, are bounded; see the measured cost
  of 7-day backtests below); asynchronous backtests (the request holds the object for its duration);
  windows sized by the series a read really returns (they are sized by the rule's bound, part 13);
  a plan per window (plans price each whole read).
- **Notifier:** mute / active time intervals, notification templates, receivers other than
  webhook and Slack, `/api/v2/alerts` ingestion, editing a silence, updating a Slack message.
- **Metrics about itself** (`viz_rule_evaluations_total`…): `health()` only.
- **`DESIGN.md` / `DECISIONS.md`**: the earlier tasks' items under "Contract issues" (13) are
  still not made. Anomaly rules are in DESIGN §7 and D33; SLO rules, warm-ups and backtests in
  DESIGN §7, D42 and D43; the published design page (`design/artifact/viz-design.html`) was not
  regenerated for either (outside this component).
- **Production deployment.** The pipeline deploys viz-ruler (`deploy/workers.json`); it has run
  on Cloudflare only as a staged trial, since destroyed (`deploy/README.md`, "Trial 2").

## Verification

```
npm test                # 368 tests in 22 files, in workerd, at most 2 workers (npx vitest run --maxWorkers=2): all pass (the `*.bench.ts` files run only under `bench:*`)
npx tsc --noEmit        # clean
npm run independent     # capture, then Prometheus' own code (Go, tools/promcheck): 2 Go tests pass (not re-run in the anomaly change)
npm run mutants         # 122 mutants (50 earlier + 9 for versioning + 22 for anomaly rules + 12 for the production wiring + 22 for SLO rules, warm-ups and backtests + 7 for streaming), on a scratch copy; vitest runs with at most 2 workers
npm run bench           # the measurements below
npm run bench:anomaly   # anomaly rules in workerd (one worker): the "Anomaly rules" measurements below
npm run bench:history   # SLO ticks, warm-ups and 7-day backtests in workerd (one worker; run each `B.` case alone with -t, and MINIFLARE_WORKERD_V8_FLAGS=--max-old-space-size=128 for the heap limit): the "SLO rules, warm-ups and backtests" and "Streaming" measurements below
npx vitest run --config vitest.measure.config.ts --maxWorkers=1 test/memory.bench.ts -t "<case>"   # the per-point calibration, one case per process
```

`npm run independent` needs Go 1.24 and the modules in `tools/promcheck/go.sum` (they were
in the module cache here, plus one fetched from the Go proxy for `go mod tidy`).

| File | Tests | What |
|---|---|---|
| `unit.test.ts` | 22 | durations, alignment, backoff, templates, classification, validation, routing, inhibition, silences, payloads |
| `prometheus.test.ts` | 27 | Prometheus semantics, each test named after the upstream test it encodes |
| `ruler.test.ts` | 32 | scheduling, replays, write counts, evaluator errors, limits, sink, health, isolation, dead-man's switch |
| `notifier.test.ts` | 25 | Alertmanager behaviour on a fake clock |
| `exactly-once.test.ts` | 12 | crashes, evictions, receiver failures; a de-duplicating receiver |
| `property.test.ts` | 3 | fast-check against an independent reference model |
| `bench.test.ts` | 4 | measurements, single-call and batch form |
| `batch.test.ts` | 17 | part 1 and part 7 |
| `http.test.ts` | 19 | auth and scopes on every route, Prometheus shapes and parameters, OpenAPI agreement (routes, scopes, `dryRun`, `$ref`s, response schemas), `dryRun` on every write, tenant isolation and fuzz |
| `monitors.test.ts` | 20 | the Monitors / Monitor / New monitor screens end to end, edits, deletes, rule files over HTTP, backtest over HTTP, signing and secrets |
| `ack.test.ts` | 12 | exactly-once with acknowledge and silence |
| `nodata.test.ts` | 19 | part 3, in the pure function and in the object |
| `backtest.test.ts` | 10 | part 4 |
| `yaml.test.ts` | 37 | part 5 |
| `robust.test.ts` | 15 | registry, sweeper, placement, shard splits and moves |
| `independent.test.ts` | 2 | captures for `tools/promcheck` |
| `compat.test.ts` | 17 | versioned storage: version 2 storage with anomaly state upgraded to 3 without a row changing, then SLO state surviving eviction; releases knowing 1 or 1–2 still rollback targets; schema goldens per class and version; the pre-versioning dump adopted; refusal and its effects; newer readable storage; version 1 storage with data upgraded to 2; the previous release still a rollback target |
| `golden.test.ts` | 5 | golden formats, including the stored anomaly rule and key, its state rows and the `anomaly_detail` annotation; the stored SLO rule, its key and per-tick expression, its rows, the warm-up status and the `slo_detail` annotation |
| `wiring.test.ts` | 14 | warm-ups and backtests ask `/api/v1/plan` (start, end, step) for every read before any `/api/v1/query_range`, and an over-budget backtest fetches nothing; part 9, against fake query and ingest services behind real service bindings (edge's real `authenticate`, tenant from the key) and control's real `Tenant`: every tick's queries carry the shard's one service key and the tick time; two tenants in one isolate each read only their own data with their own key; a key a person disabled: `unauthorized` within the propagation grace with nothing asked of control, then "disabled" with no new key, then after enabling a new key and the rule `ok` again (two `key.service` audit entries); one engine call in flight with four groups due at once (12 queries); `/api/v1/plan` refuses a parse error with its message and a 503 does not block the save; recording rules through Remote Write decoded with edge's snappy decoder (labels, `+Inf`, tick time); backtests through `query_range`; `/healthz`; notifications to control's destination: the plain JSON body's content and signature, no URL, secret or key in it; the Alertmanager form through a route naming `viz:default`, `viz:default` refused as a tenant receiver, and a URL change in control followed after the refresh; 500, a dropped connection, then 200: three attempts, one key, identical bytes, and no secret in any API answer, outbox, health or console output; a stored delivery error with the URL cut out; two tenants' alerts each at their own destination, each signed with its own secret |
| `slo.test.ts` | 20 | part 10: detection within one bucket of the SRE Workbook's formula for 100% to 0.1% error ratios (never where it says never), the library's table (1, 9, 44 and 217 minutes; 865 and 2,161), agreement with the library's own `burnRate.detect` at every point of 7,320 buckets (sentence included), the strict threshold with exactly representable numbers, coverage; the sentence and every number of `slo_detail` against an independent computation; in the object: one query per tick in the batch, page at the first bad minute and ticket at the fifth routed by severity, the page resolving 30 minutes after the outage; three rows a steady tick; evictions and replayed ticks, and a crash in the commit, giving exactly the state of a pure reference run; refusals (series cap, unpaired parts, a newer release's rows) changing nothing; a shard move; another tenant's rows neither loaded nor touched; validation with paths, fixes and warnings |
| `history.test.ts` | 14 | parts 11, 12 and 13: windowed backtests across hundreds of boundaries equal to one window and to live evaluation (anomaly and SLO); the memory refusal before any plan or fetch (an SLO's rings over a small budget; 1,000 series of SLO state at the default budget, over HTTP); a warm-up refused by its memory budget; a window holding more points than sized for; an anomaly warm-up reads exactly the look-back and leaves the library's state; over budget (and through the monitors API), an engine refusal, engine failures retried then given up, a crash in the warm-up's commit; an SLO warm-up's two reads planned before either is fetched; backtests equal to live alerts with their annotations (anomaly and SLO); every kind refused whole past the budget; the monitors API routes, 422 `over_budget`, and tenant isolation of `POST /monitors/{id}/backtest` |
| `anomaly.test.ts` | 22 | part 8: alert content against the library run on its own; NaN and pruning; the series cap, state limits per series, rule and object, rows per tick; state across evictions, a replayed tick, a crash in the commit, a newer release's rows and detector names, another tenant's rows; edits, intervals, rule files, `/api/v1/rules`; the monitors API: defaults, errors and warnings, the detectors guide, authorisation, tenant isolation, documented schemas |

The first seven files held the 123 tests that existed before this task; all still pass.
Checked by per-file count (unchanged except `bench.test.ts`, which gained the two
batch-form runs: 125 in those files now); the test bodies were not diffed against the
earlier commit, because git was not used in this task. Repeating the
randomized files (`ack`, `backtest`, `robust`, `monitors`, `exactly-once`) six times gave
six passes.

### Exactly-once (inherited cases, unchanged and passing)

| Case | Requests seen | Processed |
|---|---|---|
| Same alarm tick replayed 3× in memory, 3× after eviction; notifier alarm replayed 6× | 1 | 1 |
| Crash inside the ruler's transition transaction | 1 | 1 |
| Crash between "transition persisted" and "outbox drained" | 1 | 1 |
| Crash after the notifier accepted the hand-off, before the ruler recorded it | 1 (hand-off sent twice, second applied nothing) | 1 |
| Notifier unreachable across fire, resolve, fire | 1 | 1, in order |
| Crash inside the notifier's flush transaction | 0 before the retry, then 1 | 1 |
| Crash after the decision committed, before the drain | 1 | 1 |
| Evicted mid-drain after the receiver processed the request | 2, same key, same body | 1 |
| Receiver answers 500 then 200 | 2, same key | 1 |
| Receiver times out twice after processing | 3, same key | 1 |
| Fire, resolve, fire again, two repeats | 5, five keys | 5 |
| 6 seeds × 30 ticks of flapping alerts, random crashes at six points, evictions, 20% 500s, 15% timeouts-after-processing, against the same seed without faults | many extra | identical notifications, alert state, recorded batches; empty outboxes |

### Exactly-once with acknowledge and silence

Same method as before: the fake receiver records every request, assertions are on what a
receiver that de-duplicates by `Idempotency-Key` processed (`ack.test.ts`).

| Case | Result |
|---|---|
| Acknowledged, then two hours of repeat ticks, every alarm replayed 3×, the notifier evicted before each | 1 request in total (control without the acknowledgement: 13 notifications) |
| Crash (eviction) right after the acknowledgement, and the next flush crashes too | no repeat, acknowledgement intact |
| Crash *inside* the acknowledgement transaction | caller gets an error, nothing recorded (no ack, no history entry), the due repeat is sent once; the retried acknowledgement then holds for 90 minutes |
| Late alarm: the repeat tick passed before the acknowledgement arrived, its alarm had not run | no repeat sent |
| A repeat already decided and stuck in the outbox (500s) when the acknowledgement arrives | delivered once (decided before the ack, the history says so), nothing after it |
| Un-acknowledge | the overdue repeat once, at once; then every 10 minutes again |
| Resolve, then fire again | the acknowledgement ends with the alert; the new firing notifies and repeats |
| Group of two, one acknowledged | repeats name only the other; a new alert joining still notifies with both |
| Silenced, with replays and evictions, then resolved under the silence | 1 request in total |
| Silence undone in the window | deleted, not ended; the muted repeat goes out; one request per notification |
| 6 seeds × 45 minutes, two monitors, people acknowledging, un-acknowledging, silencing and undoing at random; random crashes at seven points (including inside the acknowledgement), evictions, 20% 500s, 15% timeouts after processing; compared with the same seed without faults | identical set of processed notifications and identical history in every seed, empty outboxes, and no logged repeat names an alert that was acknowledged when it was decided. One run: 195 notifications (12 repeats), 47 acknowledgements, 21 un-acknowledgements, 40 silences (24 undone), 160 crashes injected (33 inside an acknowledgement), 154 extra requests. Counts vary between runs because tenant names, and so group offsets, are random |

### Mutants

`scripts/mutants.mjs` applies each mutant, runs the named test files (or `npm run
independent`), reads vitest's JSON report, requires a failing test (a file that does not
load is not a kill), and restores the source. A pattern that no longer matches the source
is reported as a failure: six of the eighteen earlier patterns had gone stale with the code
changes of this task and were rewritten (3, 4, 5, 6, 13, 14).

Mutants 1–18 are the earlier ones; 19–45 are this task's (the ten asked for are 19, 23,
24, 25, 27, 29, 30, 34, 36 and 38; the rest guard the properties around them); 46–50 break
what only the independent readers check. Final run on the final code: **50 killed, 0
survived**. Two of them were caught only after a test was strengthened in this task: 30
(no request in the inherited fuzz carried another tenant in a path prefix; the fuzz now
does, and covers every route by name instead of by chance) and 46 (every captured time
happened to have a non-zero last millisecond digit, where JavaScript and Go print alike;
the capture now includes times on the second and the half second). Mutant 33 is killed by
the new "dryRun on every write" test.

| # | Mutant | Killed by (first of) |
|---|---|---|
| 1 | advance `for` on a replayed tick (evaluate at wall-clock time instead of the aligned tick time) | prometheus: "group evaluation in the Ruler object (prometheus/rules/manager_test.go, group.go) iterations missed (promet…" (+5 more) |
| 2 | drop the replay guard (the same group and evaluation time is evaluated again) | ruler: "at-least-once alarms: a replayed tick changes nothing the same (group, evaluation time) is not evaluated tw…" |
| 3 | resolve on evaluator error (treat a failed query as an empty result) (pattern rewritten) | batch: "one failing expression does not fail the batch the failed rule is err with the engine message and keeps its…" (+7 more) |
| 4 | notify before the transaction commits (send from inside the flush transaction) (pattern rewritten) | exactly-once: "replayed ticks replaying the alarm tick that made a transition, in memory and after eviction, yields one no…" (+5 more) |
| 5 | drop the idempotency key header (pattern rewritten) | exactly-once: "replayed ticks replaying the alarm tick that made a transition, in memory and after eviction, yields one no…" (+11 more) |
| 6 | make the idempotency key depend on the attempt (pattern rewritten) | exactly-once: "crashes and failures in the notifier receiver answers 500 then 200: one notification processed" (+2 more) |
| 7 | ignore silences | notifier: "silences a silenced alert is not notified; expiring the silence through RPC lets it through at the next tick" (+1 more) |
| 8 | wrong group key (group labels left out of the key) | notifier: "grouping timers group_wait: the first notification waits, so alerts that fire together arrive together" (+3 more) |
| 9 | catch up missed ticks in a loop | prometheus: "group evaluation in the Ruler object (prometheus/rules/manager_test.go, group.go) iterations missed (promet…" (+1 more) |
| 10 | persist on every tick (a refreshed value counts as a transition) | property: "property: the state machine equals the reference model for random result sequences, parameters and missed t…" (+6 more) |
| 11 | memory ahead of storage (adopt the new alert state before the transaction commits) | exactly-once: "crashes in the ruler crash inside the transition transaction: nothing is persisted or handed off; the retry…" |
| 12 | hand-off row written outside the transition transaction (dropped on a crash in between) | exactly-once: "crashes in the ruler crash between "transition persisted" and "outbox drained": the hand-off survives and i…" (+1 more) |
| 13 | treat a retryable receiver failure as delivered (at-most-once) (pattern rewritten) | exactly-once: "crashes and failures in the notifier receiver answers 500 then 200: one notification processed" (+5 more) |
| 14 | reset `for` timers on restore (do not load stored alerts) (pattern rewritten) | prometheus: "group evaluation in the Ruler object (prometheus/rules/manager_test.go, group.go) TestForStateRestore: pend…" (+1 more) |
| 15 | inhibit without checking the `equal` labels | notifier: "inhibition a firing source mutes matching targets with equal labels; they are notified once the source reso…" (+1 more) |
| 16 | serve any tenant (drop the tenant check in the ruler) | ruler: "tenant isolation every RPC refuses a tenant other than the one the object is named for" (+1 more) |
| 17 | a "firing" redelivered after the "resolved" re-opens the alert (drop the ordering check in ingest) | notifier: "ingest is idempotent and ordered by evaluation time a redelivered batch applies nothing; a stale or same-ti…" |
| 18 | group_interval ignored (flush a changed group as soon as an alarm runs) | notifier: "grouping timers group_interval: a change to a group that was already notified waits for the next interval tick" (+4 more) |
| 19 | acknowledge does not stop repeats | ack: "an acknowledged alert never sends a repeat two hours of repeat ticks, every alarm replayed three times and …" (+8 more) |
| 20 | un-acknowledge does not resume repeats (it is a no-op) | ack: "an acknowledged alert never sends a repeat un-acknowledge resumes: the overdue repeat is sent once, then re…" (+1 more) |
| 21 | acknowledge hides the alert (the notifier stops listing acknowledged alerts) | ack: "an acknowledged alert never sends a repeat two hours of repeat ticks, every alarm replayed three times and …" (+2 more) |
| 22 | acknowledge hides the alert (the monitor view drops acknowledged alerts) | monitors: "the Monitors and Monitor screens pending, firing, notified, acknowledged, silenced, resolved: every field t…" (+1 more) |
| 23 | silence undo leaves the silence (reports it removed, keeps it) | ack: "silence from an alert, with undo undo inside the window removes the silence entirely: the alert that fired …" (+1 more) |
| 24 | backtest uses a different state machine (a second implementation: pending, firing after `for`, gone = resolved) | backtest: "live evaluation and backtest agree a recorded sequence of 90 ticks, three flapping series, for + keep_firin…" (+5 more) |
| 25 | one failure fails the batch (the ruler fails every rule when any result is an error) | batch: "one failing expression does not fail the batch the failed rule is err with the engine message and keeps its…" (+2 more) |
| 26 | one failure fails the batch (the single-call adapter rejects the whole call) | batch: "the single-call form is an adapter runs requests in order, one at a time, and reports each failure on its o…" (+1 more) |
| 27 | no data treated as resolve under `keep` | nodata: "no_data: keep (leave the last state as it is) a firing alert stays firing through missing data and no resol…" (+3 more) |
| 28 | an absent series keeps its pending alert (Prometheus drops it at once) | nodata: "absent series, as Prometheus handles them (no_data: ok, the default) a pending alert whose series disappear…" (+3 more) |
| 29 | write without scope (writes are checked against monitors:read) | http: "authentication and scopes (edge's API-key verification, imported) every route refuses a key that has every …" (+1 more) |
| 30 | tenant from path (a /t/<tenant> prefix selects the tenant) | http: "tenant isolation on every route fuzz: whatever one tenant's key sends (the other tenant in paths, queries, …" |
| 31 | tenant from the query string (?tenant=) | http: "tenant isolation on every route fuzz: whatever one tenant's key sends (the other tenant in paths, queries, …" |
| 32 | tenant from a header (X-Scope-OrgID) | http: "tenant isolation on every route fuzz: whatever one tenant's key sends (the other tenant in paths, queries, …" |
| 33 | dryRun ignored on writes | http: "tenant isolation on every route dryRun on every write: a well-formed request answers 2xx, says dryRun, and …" (+7 more) |
| 34 | unbounded timeline (the ruler keeps every transition) | monitors: "the Monitors and Monitor screens the history is bounded: the oldest entries are dropped and counted, in the…" |
| 35 | unbounded notification log (the notifier keeps every entry) | monitors: "the Monitors and Monitor screens the history is bounded: the oldest entries are dropped and counted, in the…" |
| 36 | sweeper double-arms (ensureArmed re-arms a ruler that has an alarm) | robust: "the sweeper (a Cron Trigger calls sweep()) re-arms exactly the rulers whose alarm was lost, and a second sw…" (+2 more) |
| 37 | sweeper pages overlap (a ruler on a page boundary is visited twice) | robust: "the registry of ruler objects every statement in the registry names the tenant, except the one platform swe…" (+1 more) |
| 38 | YAML anchors accepted | monitors: "rule groups and rule files over HTTP a YAML file with an anchor, and a file with a bad rule, are refused wi…" (+3 more) |
| 39 | YAML aliases accepted | yaml: "what the subset refuses, with the line and a fix an alias as a value" (+1 more) |
| 40 | a moved group loses its alert state (import ignores the bundle's alerts) | robust: "shard splitting through the API moving a group preserves its alert state: pending and firing alerts keep th…" |
| 41 | a moved group re-notifies (release resolves its alerts, as delete does) | robust: "shard splitting through the API moving a group preserves its alert state: pending and firing alerts keep th…" |
| 42 | placement depends on arrival order (least-loaded shard instead of the hash) | robust: "placement of groups on shards (pure) the assignment is the same whatever order the groups come in, keeps ev…" (+3 more) |
| 43 | the webhook secret is returned by the API (redaction removed) | monitors: "outbound webhook authentication: a per-route secret, never returned no API response and no RPC returns the …" |
| 44 | the signature does not cover the idempotency key | monitors: "outbound webhook authentication: a per-route secret, never returned signs each request with HMAC-SHA256 ove…" |
| 45 | a retry is signed with the time of the first attempt (a replayable signature) | monitors: "outbound webhook authentication: a per-route secret, never returned a retry is signed again with the time o…" |
| 46 | Prometheus API times printed as JavaScript prints them (".000Z"), not as Go prints a time.Time | promcheck `TestPrometheusAPIShapes` |
| 47 | a field Prometheus does not have leaks into /api/v1/rules (the rule's cost class) | promcheck `TestPrometheusAPIShapes` |
| 48 | a required group field left out of /api/v1/rules (limit) | promcheck `TestPrometheusAPIShapes` |
| 49 | an alert value printed as JavaScript prints a number, not as strconv.FormatFloat(v, 'e', -1, 64) | promcheck `TestPrometheusAPIShapes` |
| 50 | the rule-file export drops keep_firing_for | promcheck `TestRuleFilesRoundTripThroughPrometheusLoader` (+1 more) |
| 51 | Ruler serves storage a newer release wrote (the refusal dropped from the RPC guard) | compat: "Ruler: refused on every RPC and over HTTP …" |
| 52 | Notifier accepts hand-offs onto storage a newer release wrote | compat: "Notifier: refused, and a current ruler handing alerts to it keeps them in its outbox" |
| 53 | a refusing Ruler runs its tick from the alarm (dropping the alarm the newer release needs) | compat: "Ruler: refused on every RPC …" (alarm and storage dump) |
| 54 | RulerIndex serves storage a newer release wrote (guard removed) | compat: "RulerIndex: refused by an exception …" |
| 55 | the HTTP API passes a refusal through as if it were an answer (no 503) | compat: "Ruler: refused on every RPC and over HTTP …" |
| 56 | a released migration edited in place (timeline loses `WITHOUT ROWID`) | compat: "ruler.Ruler: a fresh object is at the latest version …" (+1) |
| 57 | the idempotency key derivation changes without a format version | golden: "the hand-off, the webhook, its signature and idempotency key …" |
| 58 | the hand-off to the notifier gains a field without a format version | golden: same |
| 59 | the registry partition hash changes | golden: "id.placement …" |
| 60 | anomaly: series beyond `max_series` dropped silently (the first ones scored) instead of refusing | anomaly: "more series than max_series: the evaluation is refused …" |
| 61 | anomaly: detector state never written to SQLite | anomaly: "only the anomalous series fires …" (+7 more) |
| 62 | anomaly: the constructor does not rebuild detector state from SQLite | anomaly: "evicted every few ticks, the stored state … equal a batch run of the library" (+2 more) |
| 63 | anomaly: a replayed tick advances each detector again (per-series replay guard removed) | anomaly: "a tick replayed after an eviction … advances no detector twice" |
| 64 | anomaly: a newer release's state rows scored over (start cold) instead of refused | anomaly: "state rows a newer release wrote are refused (state_unreadable) …" |
| 65 | anomaly: loading detector state does not name the tenant | anomaly: "every statement on detector state names the tenant …" (**survived the first run**: the injected foreign row reused a series key of this tenant, so it was overwritten on load; the test now gives it a key of its own and checks the series count after load; then killed) |
| 66 | anomaly: the alert does not carry the detector's sentence | anomaly: "only the anomalous series fires; the receiver gets the library's sentence …" |
| 67 | anomaly: the `severity` label not set from `anomaly.severity` | anomaly: "… severity routes" (+2 more) |
| 68 | anomaly: the default EWMA uses the library's parameters (30 / 4) instead of the held-out ones | anomaly: "… severity routes" (+3 more, including the monitors API defaults) |
| 69 | anomaly: `severity: page` without a detector defaults to EWMA, not the static threshold | anomaly: "… severity routes" (+1 more) |
| 70 | anomaly: CUSUM may page | anomaly: "problems come back in the monitor's own field names …" |
| 71 | anomaly: no per-series state limit at run time | anomaly: "a series whose state outgrows the per-series limit at run time is refused …" |
| 72 | anomaly: no per-object state budget at save | anomaly: "the anomaly rules of one object may reserve at most maxAnomalyStateBytesPerObject …" |
| 73 | anomaly: a row per series (state rows of one byte) | anomaly: "state is written as whole batches: one row per rule per tick …" (+2 more) |
| 74 | anomaly: state carried over an interval change | anomaly: "an edit that keeps the detector and parameters keeps the state; a new parameter or interval …" |
| 75 | anomaly: the rule key leaves out the detector and parameters | anomaly: same (+1 more, golden) |
| 76 | anomaly: a NaN point clears the series' flag (a gap treated as a recovery) | anomaly: "a NaN point is not scored and keeps the series' flag …" |
| 77 | anomaly: migration 2 declared breaking (`readableFrom` 2) | compat: "is adopted as version 1 by all three classes …" (+3 more) |
| 78 | anomaly monitors: write without scope (as 29) | anomaly: "authorisation: creating, editing and deleting an anomaly monitor needs monitors:write …" |
| 79 | anomaly monitors: tenant from the query string (as 31) | anomaly: "tenant isolation: the tenant is the credential's …" |
| 80 | anomaly monitors: tenant from a header (as 32) | anomaly: same |
| 81 | anomaly: a stored rule naming a detector this release does not know is run anyway | anomaly: "a stored rule naming a detector this release does not know … is refused" |
| 82 | wiring, tenant isolation: one service credential shared by every Ruler object of the isolate (tenant B evaluates with A's key) | wiring: "tenant isolation: two tenants in one isolate each read only their own data …" |
| 83 | wiring, tenant isolation: the notifier keeps one control destination for the isolate (B's alerts go to A's webhook) | wiring: "tenant isolation: each tenant's alerts reach only its own destination" |
| 84 | wiring, no secret in bodies: the plain JSON body carries the receiver URL | wiring: "the plain JSON form … no secret or URL in the body …" |
| 85 | wiring, no secret stored or shown: a delivery error keeps the URL it quotes | wiring: "a stored delivery error never quotes the receiver URL" |
| 86 | wiring, no secret in logs: each delivery is logged with its URL | wiring: "at least once, never twice processed … no URL or secret is stored, shown or logged" |
| 87 | wiring, no secret in logs: the service key is logged when issued | wiring: same |
| 88 | wiring, retries: the JSON body rebuilt per attempt (an attempt counter in it) | wiring: same ("the same bytes under one key") |
| 89 | wiring, retries: the JSON body names another key than the `Idempotency-Key` header | wiring: "the plain JSON form …" (+ golden) |
| 90 | wiring, six connections: four engine calls in flight per Ruler object | wiring: "six connections: one engine call in flight per Ruler object …" |
| 91 | wiring, six connections: a gate per evaluator instead of one per object | wiring: same |
| 92 | wiring, credential: a refused key replaced at once (a rotation and an audit entry per 401 while KV propagates) | wiring: "a refused key is kept while KV may still be propagating …" (**survived the first run**: the in-memory minimum interval between requests to control hid the missing propagation grace; the test now evicts the object, after which only the key's stored age protects; then killed) |
| 93 | wiring, control destination: a tenant config may define `viz:default` itself | wiring: "the Alertmanager form through a tenant route that names viz:default …" |
| 94 | SLO thresholds: a burn rate equal to the threshold counts as burning (`>=`, applied to the scratch copy of `anomaly/`'s `evaluateWindows`, which the rule calls) | slo: "the threshold is strict: a burn rate exactly at it does not fire …" |
| 95 | SLO thresholds: the short window ignored (both windows read the long one) | slo: "error ratio 0.01 … within one bucket of the formula's time" (+5 more, incl. the library agreement) |
| 96 | SLO thresholds: `min_coverage` ignored | slo: "a window counts only once min_coverage of its buckets have data …" (+2 more) |
| 97 | SLO thresholds: the default alerts lose the 6 h / 30 m page | slo: "the table the library reproduces …" (+3 more) |
| 98 | SLO windows: the current bucket left out of every window | slo: "error ratio 1 …" (+ every other ratio) |
| 99 | SLO windows: a block's cached sums not invalidated when a bucket in it is set | slo: "error ratio 0.02 …" (+ more) |
| 100 | SLO state: the rings not rebuilt from SQLite in the constructor | slo: "state is rows … with evictions and replays the stored state is exactly a run without them" (+2 more) |
| 101 | SLO state: a replayed tick advances the rings again (replay guard off by one) | slo: same |
| 102 | tenant isolation: SLO state loaded without the tenant in the `WHERE` clause | slo: "every statement on SLO state names the tenant …" (**survived the first run**: the foreign head held one series, as many as the tenant's own, and the loader reads one head; the test now adds a foreign block for the tenant's own series key and compares the stored state with a pure reference run; then killed) |
| 103 | tenant isolation: deleting a group deletes SLO state without naming the tenant | slo: same |
| 104 | warm-up budget: the planned cost never compared with the budget | history: "over the budget nothing is fetched …" (+2 more, backtests) |
| 105 | warm-up budget: the budget checked only after the fetch (an over-budget read made, then refused) | history: same (+2 more) |
| 106 | warm-up budget: a read the engine's plan refuses made anyway | history: "a read the engine's own limits would refuse is refused too …" |
| 107 | warm-up budget: warm-ups held to the larger backtest budget | history: "over the budget nothing is fetched …" (+1 more) |
| 108 | warm-up: the state written outside the warm-up's transaction | history: "a crash in the warm-up's transaction writes nothing …" |
| 109 | warm-up: a finished warm-up not recorded (read again after an eviction) | history: "an anomaly rule: the first tick plans then reads exactly …" (+1 more) |
| 110 | backtest/live: an anomaly backtest starts cold | history: "an anomaly rule: over data it fired on live, a backtest from its creation gives the same alerts …" |
| 111 | backtest/live: an SLO backtest without the coarse history | history: "an SLO rule: over data it paged and ticketed on live …" |
| 112 | backtest/live: an SLO backtest feeds each step the previous step's buckets | history: same |
| 113 | backtest/live: an interval's annotations taken at its end, not when the alert entered the state | history: same |
| 114 | tenant isolation: `POST /monitors/{id}/backtest` looks the monitor up for a tenant named in the query string | history: "… only the caller's own monitors and data" |
| 115 | compatibility: a save warms a kept rule over state rows a newer release wrote (both guards removed) | slo: "refusals change nothing … a newer release's rows are refused, kept …" |
| 116 | window boundary: each window starts a step late (a step between windows never read) | backtest: "a recorded sequence of 90 ticks … identical intervals" (the windows' partition, every seed) (+ history) |
| 117 | window boundary: windows overlap by a step (the boundary step read and fed twice) | backtest: same |
| 118 | window boundary: the last step of every window not fed to the rule | backtest: same |
| 119 | memory refusal: the rule's state left out of the window sizing | history: "across many window boundaries …" (+2 more: the refusals) |
| 120 | memory refusal: windows sized without the series count | history: "across many window boundaries …" |
| 121 | memory refusal: an SLO backtest's model leaves out its bucket rings | history: "refused before any plan or fetch when the modelled peak cannot fit …" |
| 122 | memory refusal: a window holding more points than it was sized for evaluated anyway | history: "a window holding more points than the model sized it for …" |

**Streaming mutants 116–122** (window boundaries and the memory refusal; `VIZ_SCRATCH=… node
scripts/mutants.mjs 116 … 122`, on a scratch copy): 7 of 7 killed on the first run; shared tree
unchanged.

**SLO, warm-up and backtest mutants 94–115** (`VIZ_SCRATCH=… node scripts/mutants.mjs 94 … 115`, on a
scratch copy): 94–114 on the first run, 20 killed and 102 survived (see its row); after the test
was strengthened, 102 killed. 115 was added with the fix it guards (a save could warm a rule over
a newer release's rows; found by reading the code, not by a test) and killed. Mutant 94 edits the
copy of `anomaly/` in the scratch directory, never `anomaly/` itself. Mutants 1–93 were not
re-run in this change; the whole suite passes (counts below).

**Production wiring mutants 82–93** (`VIZ_SCRATCH=… node scripts/mutants.mjs 11 53 82 … 93`, a
scratch copy that now also holds `control/src` and `dashboard/src`, which the tests bind):
13 of 14 killed on the first run; 92 survived (see its row); after the test was strengthened, 92
killed. Mutants 11 and 53 had stale patterns (11 since the anomaly change, 53 since this one put
the stage deadline after the refusal); both rewritten and killed. Mutants 1–10, 12–52, 54–81
were not re-run in this change; the whole suite (331) passes.

**Mutants now run on a scratch copy.** `scripts/mutants.mjs` copies the component (and
`contracts/`, `edge/src/`, `anomaly/src/`, which it imports) to `$VIZ_SCRATCH` or the system
temporary directory, applies each mutant to the copy, runs the tests there, deletes the copy, and
checks at the end that every file a mutant touches is unchanged in the shared tree (AGENTS.md:
others snapshot the tree while mutants run; two such snapshots were taken during this task's
runs, and neither held a mutant). Before this change the script edited the shared tree in place.

**Anomaly mutants 60–81** (`VIZ_SCRATCH=… node scripts/mutants.mjs 60 … 81`): 60–80 on the
code before the last two fixes (the unknown-detector refusal and the test for 65): 20 killed,
1 survived (65, the tenant filter on loading state; see its row). After the fixes: 65 killed,
81 killed. Through the new scratch-copy runner, 1, 16 and 51–59 were re-run (the compat and
golden tests they rely on changed in this task): 11 of 11 killed. Mutants 2–15, 17–50 were not
re-run in this task; 46–50 need Go.

Mutants 51–59 were run on the final code (`node scripts/mutants.mjs 51 52 53 54 55 56 57 58
59`): 9 of 9 killed. Two patterns (57, 59) did not apply on the first try because of an
escaping mistake in the script, which reported them as NOT APPLIED rather than passing; fixed
and re-run. Mutants 1–50 were not re-run after this change; the ruler's own suite (293 tests)
passes.

### Measurements

Measured here: workerd 1.20261117.1 under vitest, 4 cores, load average 14–15 from other
work, three runs; ranges are min–max of the three. 1,000 rules (950 alerting with two
labels and three templated annotations, 50 recording), 100 firing alerts, **in-process
fake evaluator** (no network, no query cost). Wall time is taken around
`runDurableObjectAlarm`; workerd's clock moves only across I/O, so these are coarse.

| Quantity | 1 × 1,000, single-call | 10 × 100, single-call | 1 × 1,000, batch | 10 × 100, batch |
|---|---|---|---|---|
| Evaluator calls per tick | 1,000 | 1,000 | **1** | **10** |
| Tick wall time, steady state, median (40 ticks) | 11–14 ms | 5–15 ms | 10 ms | 6–10 ms |
| p95 / max | 26–37 / 30–65 ms | 16–46 / 22–159 ms | 22–25 / 27–46 ms | 35–48 / 41–72 ms |
| Tick in which 100 alerts start firing | 53–94 ms, 102 rows | 73–216 ms, 120 rows | 41–58 ms, 102 rows | 93–142 ms, 120 rows |
| SQL rows per steady tick / `setAlarm` per tick | 0 (1 on 8 heartbeat ticks) / 1 | same | same | same |
| Storage | 741,376 B | 757,760 B | 741,376 B | 757,760 B |
| Save 1,000 rules | 160–327 ms | 122–222 ms | 79–89 ms | 73–121 ms |

**Reading it.** With an in-process fake the two forms cost the same ruler time: the
difference is not visible at this clock resolution under this load, and the overhead per
tick is unchanged from before (11–17 ms then). What the batch form changes is the
**number of calls**: 1,000 → 1 per group per tick. With a remote engine, the single-call
form waits 1,000 sequential round trips per tick (0.2–10 ms each: 0.2–10 s, **modelled**),
and if each call is a billed request that is 43.2 M requests a month per 1,000 rules,
about $6.5 (**modelled**, $0.15/M); the batch form is 43,200 (one group) to 432,000 (ten
groups) calls a month, $0.006–0.065. What would settle it: the engine's batch binding
deployed and the bill read from Cloudflare analytics (spike S0, `design/VERIFICATION.md` §4).

#### Anomaly rules (`npm run bench:anomaly`)

**Measured here (workerd, local)**: workerd 1.20261117.1 under the vitest pool, one worker,
4 cores shared with other sessions' builds and benchmarks: **load average 17–21** during the
run below (12–13 during an earlier run on the code before the last fixes, whose CPU figures
agree within the ranges below except where noted). CPU is the workerd process's thread time
read from `/proc/<pid>/task/*/schedstat` by the `HOST` binding (`vitest.measure.config.ts`),
so it includes the RPC into the object; wall time is `Date.now()` around each call (it moves
in workerd across the call's I/O) and is inflated by the load. 100 series per rule, the
ruler's defaults (EWMA half-life 100, k 8), the library's synthetic series (daily sine + noise,
seeded), warm state computed by the library from history so every measured evaluation scores
(CUSUM excepted, below). Ranges are min–max of 3 runs.

A. The library alone, one batch call over 100,000 points, against its Node figures
(`anomaly/README.md`, Node 22.23; median of 5; an empty call's 1.45 ms CPU taken off):

| detector | workerd, ms CPU per 1,000 points | Node, ms CPU per 1,000 points |
|---|---|---|
| threshold | 0.56 | 0.59 |
| ewma | 0.26 (0.29 in the earlier run) | 0.14 |
| robust_z (288 points) | 3.2 | 3.6 |
| seasonal, daily at 5 min, k = 4 | 10.3 | 9.8 |
| seasonal, weekly at 1 h, k = 4 | 6.3 | 5.8 |
| cusum | 0.59 | 0.61 |

B. The ruler's evaluation function (`evalAnomaly`): one point per series from in-memory state,
each changed series' state serialised as stored, limits checked; 40 evaluations:

| detector | ms CPU per evaluation (100 series) | ms CPU per 1,000 points | state per series | Node, one tick through JSON state, per 1,000 points |
|---|---|---|---|---|
| threshold | 0.89–1.00 | 8.9–10.0 | 265 B | 6.3 |
| ewma | 0.96–1.66 | 9.6–16.6 (7.2–9.2 earlier) | 335 B | 8.9 |
| robust_z (288 points) | 10.0–11.1 | 100–111 | 9.6 KB | 193 |
| seasonal, daily at 5 min | 19.7–20.9 | 197–209 | 27 KB | 523 |
| seasonal, weekly at 1 h | 12.9–13.4 | 129–134 | 15.9 KB | 285 |
| cusum | 1.26–1.85 | 12.6–18.5 | 740 B | 21 |

C. The whole alarm tick of a group with one such rule (fake evaluator answering from a table,
alert state machine, state rows written in the commit), against the counterfactual of the same
group with one alerting rule whose result is empty; 30 ticks after 3 unmeasured:

| rule | ms CPU per tick | wall per tick, median / p95 | SQL rows written per tick | state rows |
|---|---|---|---|---|
| counterfactual: alerting rule, empty result | 1.12–1.23 | 7–8 / 22–31 ms | 0 | 0 |
| threshold | 2.54–2.93 | 10–12 / 17–80 ms | 1 | 1 |
| ewma | 2.11–2.59 | 13–16 / 28–59 ms | 1 | 1 |
| robust_z (288 points) | 17.5–18.0 | 52–62 / 125–232 ms | 2 | 2 |
| seasonal, daily at 5 min | 40.2–42.2 | 134–139 / 376–464 ms | 6.4 | 6 |
| seasonal, weekly at 1 h | 22.7–24.7 | 58–84 / 94–304 ms | 4 | 4 |
| cusum | 5.0–5.7 | 18–41 / 40–89 ms | 12 | 1 |

**Reading it.** The detectors cost in workerd what they cost in Node (A), EWMA aside (about
twice, at a cost too small to matter). In the ruler the detector is not the cost: serialising
each series' state every tick is (B: EWMA 10–17 ms per 1,000 points against 0.26 for the
detector; robust z and seasonal 100–209 ms, their states being 9.6–27 KB). B is below Node's
"one tick through JSON" because the ruler keeps state in memory and only serialises it. A whole
tick of a 100-series EWMA rule costs about 1–1.5 ms CPU more than the empty counterfactual and
writes one row; daily seasonal costs about 40 ms CPU and 6 rows (2.7 MB of state rewritten each
tick), which is why seasonal rules belong on coarse rollups. CUSUM's row is not the steady
state of the others: on this sine most series alarm and then re-learn their reference (all 100
were re-learning at the end), so it also writes alert, hand-off and history rows (12 a tick).
Nothing here is measured on Cloudflare; what would settle it is the same rule deployed with
the engine binding, its duration and rows read from Cloudflare's analytics (spike S0).

#### SLO rules, warm-ups and backtests (`npm run bench:history`)

**Measured here (workerd, local)**: workerd 1.20261117.1 under the vitest pool, one worker, 4 cores
shared with other sessions' work: **load average 6.9–8.2** (1-minute) during the three runs below.
CPU is the workerd process's thread time (`HOST`, as above), so it includes the RPC into the object
and the fake engine building each tick's result in the same isolate; the warm-ups' and backtests'
history was built before the measured call. Peak memory is the workerd process's VmHWM, which also
holds the test's own copies of the matrices. Ranges are min–max over 3 runs (each tick figure the
median of 30 ticks). SLO rule: 99.9% over 30 days, the workbook's four alerts, 1-minute interval
(a 4,320-bucket and a 720-bucket ring per series); SLI `sum by (svc)`, 1,000 events a minute per
series, a trickle of errors and bursts that page.

T. One alarm tick of a group holding one rule, warm (after its warm-up and 3 unmeasured ticks):

| rule | series | ms CPU per tick | warm-up (first tick), ms CPU | SQL rows per tick | peak RSS, MB |
|---|---|---|---|---|---|
| counterfactual: alerting rule, empty result | 1 | 1.98–2.28 | – | 0 | 149–150 |
| SLO | 1 | 2.28–2.51 | 67–82; streamed: 70 | 3 | 178–180 |
| SLO | 10 | 3.60–3.71 | 209–232; streamed: 170 | 3 (up to 6 with transitions) | 213–234 |
| SLO | 100 | 9.8–11.2 (single ticks up to 147) | 883–1,000; streamed: 1,002 | 3 (up to 7) | 360–389 |

(The warm-up figures before ";" were taken with each read fetched whole; "streamed" is one further
run after part 13, under a 128 MB heap, its reads in 54 windows sized for the rule's `max_series`
100, the fake engine's CPU measured alone and taken off; load average 9.1–10.3.)

B. Backtests: see "Streaming" below (the measurements of this table's first version, with each
read fetched whole, held 0.4–0.6 GB; they are kept there as the counterfactual).

**Reading T.** A burn-rate tick costs about 0.3 ms CPU more than the empty counterfactual at one
series, 1.5 ms at 10 and 8–9 ms at 100 (about 0.09 ms a series: window sums over cached blocks,
`evaluateWindows`, the working copy of the rings), and writes **3 rows whatever the number of
series**. A warm-up is a one-off of 70–80 ms at one series and about 1 s at 100. Nothing here is
measured on Cloudflare; what would settle the production cost is the same rules deployed, CPU and
rows read from Cloudflare's analytics.

#### Streaming (`npm run bench:history`, `test/memory.bench.ts`)

**Measured here (workerd, local)**, one worker, each case in its own workerd process (a later case
would reuse heap an earlier one freed), the process's peak resident memory (VmHWM) reset before the
case through `HOST?reset`; **load average 5.3–11.3** (1-minute) across the runs. CPU is the workerd
threads' time with the fake engine's own CPU (building each window's matrix in the same isolate,
measured alone afterwards over the same windows) taken off and shown beside it. V8's old space was
limited with `MINIFLARE_WORKERD_V8_FLAGS=--max-old-space-size=<MB>`: 128 MB is a Durable Object's
memory, 64 MB half of it. Rules as in T (SLO) and part 12; a week at 1 minute (10,080 steps), ending
2099-12-31; EWMA half-life 10 with a spike per series about weekly; threshold `latency_ms > 0` for
2 m (every series fires and holds).

C. Calibration, bytes of resident memory per point held (a window's engine JSON, parsed, indexed by
step), one case per process, two runs each:

| series × steps | points | peak increase, MB | bytes per point |
|---|---|---|---|
| 100 × 2,000 | 200,000 | 94.7–108.5 | 496–569 |
| 1,000 × 500 | 500,000 | 208.9–211.1 | 438–443 |
| 10 × 20,000 | 200,000 | 121.9–125.7 | 639–659 |
| 1,000 × 70 | 70,000 | 45.8–47.6 | 686–712 |

The model takes 768, above all of them.

S. A 7-day backtest at 1 minute, streamed (the default 32 MiB budget):

| rule | series | ms CPU (fake engine) at 128 MB heap | at 64 MB heap | windows | points read | model peak / budget, MiB | peak RSS increase, MB (128 / 64 heap) | intervals |
|---|---|---|---|---|---|---|---|---|
| threshold | 100 | 920–1,011 (+52–75) | 1,007 (+50) | 31 steps × 326 queries | 1,008,000 | 31.6 / 32 | 60.8 / 59.3 | 200 |
| threshold | 1,000 | 11,050–12,400 (+670–704) | 14,624 (+950) | 31 steps × 326 queries | 10,080,000 | 31.6 / 32 | 100.9–103.6 / 76.6 | 2,000 |
| EWMA | 100 | 4,579 (+75) | 4,472 (+82) | 345 steps × 30 queries | 1,010,000 | 32.0 / 32 | 112.3 / 88.1 | 100 |
| EWMA | 1,000 | 49,646 (+780) | 55,451 (+810) | 26 steps × 389 queries | 10,100,000 | 32.0 / 32 | 121.6 / 107.3 | 1,005 |
| SLO | 100 | 8,614–8,720 (+239–252) | 9,239 (+227) | 118 + 118 steps × 129 queries | 3,009,600 | 32.0 / 32 | 109.6–113.3 / 82.6 | 316 |
| SLO | 1,000 | **refused** before any plan or fetch: state 92.7 MiB, model peak 94.1 MiB > 32 MiB | same | – | – | 94.1 / 32 | 0.4 | – |

(The 1,000-series EWMA rule needs `maxAnomalyStateBytesPerRule` raised to be saved at all, and the
1,000-series SLO rule `maxSloSeriesPerRule`; both were, so that the backtest is what is measured.
With spikes twice a week, the 1,000-series EWMA backtest stopped at the 4 MiB the intervals may
hold: 2,445 alerts with their explanations, an explicit `failed`.)

X. The counterfactual, each read fetched whole (one window, as before this change: a 4 GiB budget),
the same cases at a 128 MB heap:

| rule | series | outcome | ms CPU | peak RSS increase, MB |
|---|---|---|---|---|
| threshold | 100 | completed | 1,291 | 134.3 |
| threshold | 1,000 | **V8 fatal error: reached heap limit, JavaScript heap out of memory**; the runtime crashed and was restarted | – | – |
| EWMA | 100 | completed, 4× the CPU of the streamed run (garbage collection near the limit) | 19,289 | 164.2 |
| SLO | 100 | **V8 fatal error: ineffective mark-compacts near heap limit, out of memory**; the runtime crashed | – | – |

**Reading it.** Streamed, every case completed under a 128 MB V8 heap and under a 64 MB one, and the
1,000-series SLO backtest, whose bucket rings alone the model puts at 92.7 MiB, was refused before
anything was read. Fetched whole, the 1,000-series threshold and the 100-series SLO backtests killed
the runtime at the same 128 MB limit: on Cloudflare the object would have been reset, not refused.
Resident memory is not what the model counts (V8 keeps garbage and reserves heap while it can): the
peak RSS increase, 60–122 MB at 128 MB, falls to 59–107 MB at 64 MB with the same budget, and the
runs still complete; the check is that a run sized by the model survives a heap limit, and that the
counterfactual does not. **CPU is not bounded**: 12 s for a week of 1,000 threshold series and 50 s
for 1,000 EWMA series (the per-point bookkeeping of the live evaluation function), over a Durable
Object's default 30 s per request; a 1,000-series week should be backtested at a coarser step or
over a shorter range. The alerting rule's windows are sized for 1,000 series however few there are
(31 steps, 326 queries for a week).

### Cost model

**Modelled**, not measured on Cloudflare; unchanged in method from the previous version.
1,000 rules in one `Ruler` object, 60 s interval, 30 days = 43,200 ticks; prices from
research/10 §1.

| Item | Basis | Low | High |
|---|---|---|---|
| Alarm invocations | 43,200 requests | $0.006 | $0.006 |
| `setAlarm` | 43,200 rows (measured: 1 per tick) | $0.043 | $0.043 |
| Heartbeat | 8,640 rows (measured) | $0.009 | $0.009 |
| Duration, ruler overhead | 5–50 ms per tick (measured here), 128 MB | $0.0003 | $0.003 |
| Duration, waiting for the evaluator | batch: 1–10 calls of 5–200 ms each, in sequence (assumed): 27–10,800 GB-s | $0.0003 | $0.135 |
| Evaluator calls, if billed as requests | 43,200 (one group) – 432,000 (ten groups) | $0.006 | $0.065 |
| Alert incidents | 0–10,000 a month × 21 billed rows (measured before) | $0 | $0.21 |
| Sweeper, this shard's share | 2,880 `ensureArmed` calls (cron every 15 min) | $0.0004 | $0.0004 |
| **Total, ruler and notifier objects** | | **≈ $0.07** | **≈ $0.47** |

Platform-wide, not per 1,000 rules: the sweeper's 16 index requests per run, 46,080 a month,
about $0.007. The single-call form, for comparison, was $0.07–$1.0 before counting
evaluator calls as requests and about $6.5 more if they are (previous version of this file).

**SLO rules, per rule, modelled** from the measurements above (rows at $1 per million): a
1-minute SLO rule writes 3 rows a tick, 129,600 a month, about $0.13, whatever its series; it adds
0.3–9 ms CPU a tick (1–100 series); its warm-up is one read of the longest window and the
compliance window, read in memory-sized windows (70 ms–1 s CPU here). To settle: the same rules on
Cloudflare, rows and duration from the analytics API.

**Anomaly rules, per rule, modelled** from the measurements above (rows at $1 per million):
a 1-minute EWMA rule of 100 series writes one row a tick, 43,200 a month, about $0.04, and adds
about 1–1.5 ms CPU (a few ms of wall time) to its group's tick; a daily seasonal rule at a
5-minute interval writes 6–7 rows a tick, about 56,000 a month, $0.06, and adds about 40 ms CPU
a tick. Its stored state (2.7 MB for 100 series) is the larger cost driver for memory, not money.
To settle: the same rules on Cloudflare, rows and duration from the analytics API.

Excludes everything the engine itself costs (query CPU, shard and R2 reads), which D7 puts
at cents for tail-class rules and dollars for the rest.

## Deviations from Prometheus

- **A failing rule keeps its alerts indefinitely**; Prometheus stops re-sending and
  Alertmanager expires them. Here alerts resolve only by a successful evaluation.
- **Over the limit, state is kept** (Prometheus clears the rule's alerts).
- **Explicit transitions, no re-send**: "firing" and "resolved" once each through an outbox;
  only the dead-man's switch uses refresh-with-expiry.
- **Annotations are frozen at the firing transition** for notifications.
- **Restoring `for`** is exact (`activeAt` is stored); no outage tolerance or grace period.
- **Fingerprints and group offsets** use a 64-bit hash of their own, not xxhash.
- **Templates** are a subset; anything else is refused at save.
- **Recorded samples** go to the sink before a rule whose text names them, else at the end
  of the group; no staleness markers; a sink failing three times loses the batch (counted).
- **Same-tick dependencies** are found by text, not by parsing (part 1).
- **No-data policies** `keep` and `alerting` are viz's; `ok` is Prometheus.
- **`/api/v1/rules`**: `match[]` refused; `file` is `shard-<n>`; `evaluationTime` of a rule
  is the engine's reported time for its request (or the adapter's measurement), 0 if unknown.
  Errors `unauthorized` / `forbidden` are viz's additions.
- **Rule identity** across saves is the hash of name, expression and labels.
- **Minimum interval** 10 s; missed ticks are skipped and counted, as Prometheus does.

## Deviations from Alertmanager

- **Flush ticks are a fixed grid** (`creation + group_wait + k·group_interval`).
- **Repeat** fires when `repeat_interval` *or more* has passed.
- **The notification log lives in the group** and goes when the group empties.
- **Acknowledgement** is viz's: it suppresses repeats of that alert until it resolves.
  Alertmanager has none (it is usually done in the paging tool).
- **Silences from an alert** match every label of that alert exactly and can be undone
  (deleted) for 60 s; other silences can be created and expired, not edited.
- **Delivery:** `Idempotency-Key`, `X-Viz-Signature`, seeded backoff, dead letters; besides
  Alertmanager's body, a plain JSON form (`format: json`, `viz.notification/v1`) with each
  alert's value; the receiver `viz:default` is the destination set in the control plane.
- **Regular expressions** are JavaScript's, anchored, at most 1,024 characters.
- **Payloads:** `generatorURL` empty; at most 500 alerts per webhook body.

## Needed changes

Outside `ruler/`; not made here.

1. **`query/src/index.ts`: an RPC entrypoint for the ruler** (query/ was under another
   engineer's mutation checks, so not edited). Exactly:
   ```ts
   import { WorkerEntrypoint } from 'cloudflare:workers'
   import { TENANT_ID } from '../../contracts/ledger'
   /** contracts/rules.ts (proposal) BatchEvaluator / RangeEvaluator / Validator, for viz-ruler. The tenant is the caller's binding context. */
   export class QueryService extends WorkerEntrypoint<Env> {
     async evaluate(tenant: string, requests: { id: string; promql: string; timeMs: number }[]): Promise<EvalResult[]>
     async range(tenant: string, promql: string, startMs: number, endMs: number, stepMs: number): Promise<PromMatrix>
     async check(tenant: string, promql: string): Promise<{ ok: boolean; errors: { message: string; offset?: number; fix?: string }[]; selectors: { text: string; rangeMs: number; offsetMs: number }[] }>
   }
   ```
   Each method refuses a tenant not matching `TENANT_ID`, builds the `Context` the HTTP
   handlers build (`tenantLimits(env, tenant)`, `newCost()`, a deadline, a query id), and for
   `evaluate` plans **all** requests together: `engine.plan` per expression, one `gather` over the
   merged ranges (one ledger version, one fetch, one tail read), then `queryInstantJson` per
   expression over the same `ScanInput`, each failure in its own result (that is DESIGN §7's
   "a single plan with shared scans"). `check` returns `engine.selectors`. Then the ruler binds
   `{ "binding": "EVALUATOR", "service": "viz-query", "entrypoint": "QueryService" }`, which
   `batchEvaluator()` already prefers, and the service key needs only `write` (for Remote Write)
   until edge gets the same kind of entrypoint for recorded samples (`SINK.write(tenant, batches)`).
2. **edge: an RPC entrypoint for recorded samples** (`SINK.write(tenant, batches)`), the same
   way, so the ruler needs no stored key at all.
3. **mcp/: a `backtest_monitor` tool** (not made: mcp/ is not this component's). `MonitorsClient`
   (`mcp/src/clients.ts`) gains `backtest(id, { fromMs, toMs, step? })` →
   `POST /api/v1/monitors/{id}/backtest` and `backtestDraft(monitor, { fromMs, toMs, step })` →
   `POST /api/v1/monitors/backtest`; the tool (`mcp/src/tools/misc.ts`, scope `monitors:read`,
   beside `list_monitors` / `get_monitor`) takes `id` (or a draft monitor), `from`, `to` and an
   optional `step`, and answers each interval as one line (state, start, end, the `anomaly` or `slo`
   sentence), the summary, and `cost` against `budget`. A 422 `over_budget` becomes a tool error
   `over-budget` quoting the plan's samples and bytes and the budget, with the fix "shorten the
   range"; nothing is fetched. A warm-up's status needs no tool: `get_monitor` already returns the
   monitor view, which carries `anomaly.status.warmup` / `slo.status.warmup` once its subset type
   (`MonitorView` in `clients.ts`) lists them.
4. **query/: the plan of a range read could estimate the shards' tail** (`/api/v1/plan` reads the
   ledger only, so warm-up and backtest budgets miss up to the hot window's samples per series),
   and could take several queries at once (an SLO's two reads are two plan requests now).

## Contract issues

0. **Done in `contracts/`, before this component (AGENTS.md, contracts first):**
   `contracts/control.ts` (new: `notificationTarget`, `serviceKey`, `SERVICE_KEYS`) and
   `contracts/rules.ts` version 3 (`WebhookConfig.format`, `JsonNotification`,
   `CONTROL_RECEIVER`), copied to `contracts-proposal/rules.ts` (identical apart from import
   paths, checked with `diff`).

Recorded here because this component may not edit `contracts/`. The proposal is
`contracts-proposal/rules.v2.ts`: it re-exports the adopted contract and marks each
declaration ADDED, CHANGED or EXTENDED, so the diff to apply is that file.

1. **`BatchEvaluator`** (ADDED): `evaluate(requests[{id, promql, timeMs}], {signal}) →
   [{id, ok, result | error, durationMs?}]`; one failing request does not fail the call; a
   missing result is a failure; a rejected promise fails every request. `Evaluator` stays as
   the adapter's input. Production binding expected as
   `EVALUATOR.evaluate(tenant, requests)`.
2. **`RangeEvaluator`** and **`Validator`** (ADDED) for backtests and save-time checks;
   `ValidatedSelector` mirrors `Engine.selectors()` in milliseconds.
3. **No-data policy and monitor metadata** on alerting rules (EXTENDED; neither is part of
   the rule key), `NO_DATA_LABEL`, `RECEIVER_LABEL`, `RulerConfig.timelineLimit`.
4. **Ruler RPC** (EXTENDED): `snapshot`, `timeline`, `backtest`, `saveRule`, `removeRule`,
   `exportGroup` / `importGroup` / `releaseGroup`, `dropTimelines`.
5. **Notifier RPC** (EXTENDED): `acknowledge`, `unacknowledge`, `silenceAlerts`,
   `undoSilence`, `describe`, `notificationLog`, `getConfig` (redacted), `dropLogs`;
   `expireSilence` gains `by` and `dryRun`; `NotifierAlert` gains `acknowledged` and
   `silencedUntil`.
6. **`WebhookConfig.secret`** (EXTENDED, write-only) and `SIGNATURE_HEADER`.
7. **`AlertUpdate.generator.monitor`** (CHANGED) so the notifier keys its log by monitor.
8. **`RulerIndexRpc`** and `INDEX_PARTITIONS` (ADDED).
9. **HTTP types** `MonitorInput`, `MonitorView`, `MonitorAlertView`, `TimelineEntry`,
   `BacktestResult` (ADDED); `openapi.json` is their wire form.
10. **edge's `authenticate` takes `scope: 'write' | 'read'`.** The ruler passes its
    `monitors:*` scopes through a cast; the function only checks membership, so it works,
    but the signature should take `string` (edge's change, not made here).
11. **The adopted `contracts/rules.ts` imports `'../../contracts/engine'`**, which is the
    path from `ruler/contracts-proposal/`, not from `contracts/` (should be `./engine`).
12. Still open from before: read-your-writes for recording rules is not expressible
    (`Sink` → engine); `Sink` has no staleness marker; `hotWindowMs` is a copy of the
    shard's `sealAgeMs`; LogQL / TraceQL results have no shape in `contracts/engine.ts`;
    who authenticates the ruler to the engine is not written anywhere.
14. **Anomaly rules are contract version 2 of `contracts/rules.ts`** ("anomaly rules"; the
    proposal copy here is identical apart from import paths). Additive: `RuleGroup.anomalyRules`,
    `AnomalyRuleInput` / `AnomalyRule` / `AnomalySpec` / `AnomalyHistory` / `AnomalyDetail` /
    `AnomalyRuleStatus`, `ANOMALY_DETECTORS`, the two annotation names, three optional
    `RulerLimits`, and the enum value `'anomaly'` in `RuleStatus.kind` and `SavedRule.kind`
    (callers fail closed on a kind they do not know). This change added `state_unreadable`,
    `maxAnomalyStateBytesPerObject`, `given` and the default rules for `detector`, `severity`
    and `max_series` to it. The first part of the contract change went into the
    work-in-progress commit 30f3ab9 together with component code, not in a commit of its own as
    AGENTS.md asks; whoever commits this should split the contract hunk out first. The
    monitors API's own additions (`MonitorInput.anomaly`, `MonitorAnomalyView`, `DetectorGuide`,
    `MonitorState` `warming`, `GroupBundle.anomalyState`) are in `rules.v2.ts`.
15. **`RuleCost` has one class**; an anomaly rule's is the larger of its expression's and its
    detector's tick class, and the cold-start class is only in `AnomalyHistory` (shown at save).
16. **SLO rules and warm-ups are contract version 4 of `contracts/rules.ts`**, changed before any
    component code (AGENTS.md, contracts first): `RuleGroupInput.rules` may hold an `SloRuleInput`;
    `RuleGroup.sloRules`; `SloRule` / `SloSpec` / `SloSli` / `SloBurnAlert` / `SloHistory` /
    `SloDetail` / `SloRuleStatus`; `SLO_PART_LABEL`, `SLO_ANNOTATION`, `SLO_DETAIL_ANNOTATION`;
    `WarmupStatus` on `AnomalyRuleStatus` and `SloRuleStatus`; the enum value `'slo'` in
    `RuleStatus.kind` and `SavedRule.kind` (callers fail closed on a kind they do not know);
    `SavedRule.slo`; five optional `RulerLimits` (`maxSloSeriesPerRule`, `maxWarmup*`,
    `maxBacktest*`). `contracts-proposal/rules.ts` is the copy (identical apart from import paths,
    checked with `diff`). Whoever commits should put the `contracts/rules.ts` hunk in its own commit,
    first. The ruler's own additions are in `rules.v2.ts`, marked "with contract version 4":
    `HistoryPlan` / `HistoryPlanner`, `SloRuleInputV2` / `SloRuleV2`, `RuleSnapshot.slo`,
    `GroupBundle.sloState` / `.warmup`, `BacktestInterval.annotations`, `BacktestResult.kind` /
    `.warmup` / `.cost`, the `over_budget` answer, `MonitorInput.slo`, `MonitorSloView`.
17. **`EVALUATOR.plan(tenant, promql, start, end, step)`** is what the ruler would call on an RPC
    engine binding (`RulerEnv`); viz-query's HTTP `/api/v1/plan` stands in for it.
18. **The memory budgets of part 13 are proposed, not in `contracts/rules.ts`**: `RulerLimitsV2`
    (`rules.v2.ts`) adds `maxWarmupMemoryBytes` and `maxBacktestMemoryBytes`, which `configure`
    accepts; they belong in `RulerLimits` as a contract version 5 (additive), not made here because
    this change was confined to `ruler/`. A memory refusal of a warm-up is reported in its status's
    `message` (with the model's numbers), not in a field, so the stored format `store.warmup` v1 is
    unchanged; a backtest's answer carries `cost.memory` and `over_budget.memory` (`rules.v2.ts`).
13. **Design text to update** (not done: outside `ruler/`): DESIGN §7 should say
    "one batch per group per tick, split only before a rule reading a series recorded
    earlier in the same tick", name the `RulerIndex` registry as the sweeper's source,
    and record acknowledge, silence-with-undo, no-data policies and signed webhooks;
    DECISIONS should get entries for "registry objects for the sweeper (vs. Notifier or a
    single global object)" and "jump-hash placement of whole groups (vs. a stored map)".

## Risks

- **Serial evaluation through HTTP** (part 9, until "Needed changes" 1): a group's tick takes
  the sum of its queries' latencies. At 0.1–0.3 s a query (modelled from the deploy trial's
  query latency, not measured for the ruler), a 1,000-rule group would need minutes and exceed
  `groupTimeoutMs` (120 s): rules after the budget report `err` and keep their state. Groups of
  tens of rules are what this wiring is for.
- **A stored bearer key per rule shard** (`meta` `service_key`), with `read` and `write` on the
  tenant's data. It never leaves the object but in `Authorization` headers to viz-query and
  viz-ingest; a person can disable it in the control plane, which stops evaluation.
- **KV propagation of a new key**: right after a key is issued (first use, or a rotation), the
  query service in another location may refuse it for up to a minute or more; rules report
  `unauthorized` for those ticks and keep their state.
- **control's destination is read at most once a minute** while the notifier has work, so a
  changed URL or secret applies to notifications decided after the next refresh; one decided
  before keeps the URL stored in its outbox row (and is signed with the current secret).

- **Anomaly rules during a rollback** to a release without them are not evaluated at all (that
  release reads `RuleGroup.rules` only): no alerts, no error, until the newer release is back.
  Their state rows wait untouched. A threshold monitor edited during the rollback into a group
  holding anomaly rules would drop them on save; default groups keep the two kinds apart, an
  explicit `group` does not.
- **SLO state is written every tick**: three rows per SLO rule (head and two blocks), 129,600 a
  month for a 1-minute rule, about $0.13 at $1 per million rows (modelled from the measured row
  count). One row would do (the current blocks inside the head, completed blocks written once):
  not done.
- **The SLI must read one bucket.** `$window` is required, but nothing checks that the expression
  around it is a counter's increase or rate; a gauge in the SLI gives buckets that mean nothing.
  The interval must be at least about twice the scrape interval, or `increase(x[$window])`
  extrapolates from too few samples (Prometheus' usual caveat).
- **Coverage gates alerting.** With `min_coverage` 0.9, an SLI that returns no series for quiet
  periods (no requests at all) leaves its windows uncovered, and the rule does not alert until 90%
  of a window has data again; a rule that could not be warmed (over budget) cannot ticket for
  most of three days.
- **A warm-up holds its group's tick** (and, through the one-call gate, every engine call of the
  object) while it reads; a rule whose history is large but within the budget delays the first
  evaluation of the group's other rules by the read's duration (not measured on Cloudflare).
- **Backtests run in the request.** Memory is bounded by the model (part 13), CPU is not: a 7-day
  backtest over 1,000 series costs seconds of CPU in the object (measured below). The model is
  calibrated on local workerd's resident memory, not on Cloudflare's accounting.
- **An alerting rule's backtest is sized for its alert limit** (1,000 series a step), however few
  series it returns: a week at 1 minute is 326 range queries, sequential through the one-call gate
  (D39). A coarser step, or a lower `maxAlertsPerRule`, means fewer. The windows' queries may read
  boundary files twice, so a run can cost somewhat more than its plans said.
- **Anomaly state is written every tick**: at least one row per anomaly rule per tick (43,200 a
  month for a 1-minute rule, about $0.04 at $1 per million rows, modelled), more for large
  states (6 rows a tick for 100 daily seasonal series). A rule whose state changes every tick
  cannot be cheaper without giving up "rebuilt from SQLite alone".
- **The per-object state budget is an estimate** (`estimateStateBytes`, from sizes measured in
  `anomaly/`), not a measurement of the heap; labels much longer than the 1,200-byte envelope it
  assumes are caught only by the run-time per-series limit.
- **The detector guide's numbers are copies** of `anomaly/README.md`'s held-out table; a re-run
  of the benchmark must update both. They are NAB numbers, not viz's.
- **EWMA widens its band after clipped anomalies**: a slow climb stops being flagged after a few
  points (`anomaly.test.ts` shows it); with `keep_firing_for` 0 the alert then resolves while the
  value is still high. The monitors API defaults to `keepFiringFor: 10m` for that reason.

- **A refusal is an outage** for the refused tenant's rules and notifications until the newer
  release serves the objects again; transitions wait in the ruler's outbox, nothing is lost.
  A refusing ruler does not evaluate, so alerts are late for that long.

- **All performance numbers are against an in-process fake.** The batch form's benefit is
  the call count; its real latency depends on how the engine plans a batch.
- **Text-based dependency splitting** can leave a regex-named dependency one interval late.
- **Shard moves are driven by API writes.** Two concurrent writes compute the same
  placement, and moves are idempotent, but they are not serialized; a crash mid-move is
  repaired only by the next write. Reads tolerate a group on two shards (assigned shard
  wins).
- **Every monitor read fans out to all shards** (4 at a time) and to the notifier; cost
  and latency grow with the shard count.
- **Skipped ticks are only known while the object stays in memory** (cursor at the
  heartbeat; `unobservedTicks` after eviction). `heartbeatMs: 0` makes it exact for
  43,200 more rows a month per object.
- **Alarm retry behaviour on Cloudflare is assumed**, not tested; double retries are
  harmless (replay guard, pure state machine).
- **The undo token is a bearer secret** for 60 s, returned once; anyone holding it and an
  `ack` key of the same tenant can undo.
- **Outbound requests go wherever the tenant's config says**; signing authenticates viz to
  the receiver, not the receiver to viz; there is no allowlist.
- **JavaScript regular expressions can backtrack** (length is limited, time is not).
- **The dead-man's switch proves the path to the receiver, not the receiver's watchdog.**
- **Crash tests compress time**: faults at named points, the alarm retried at once.
- **Fingerprint collisions** (64 bits) would surface as a spurious duplicate-labelset error.
- **The independent readers pin Prometheus v0.308.0 and client_golang v1.23.2**; a later
  Prometheus that adds a field to these structs will be reported as a missing field.
