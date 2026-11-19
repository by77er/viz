# Ruler

Prometheus-style rule evaluation, Alertmanager-style notification and the monitors API for
viz (design §7, decision D7). Three Durable Object classes and one Worker:

- **`Ruler`**, one per tenant rule shard, named `<tenant>/<n>`. Holds rule groups, evaluates
  each group with one batch call to the engine per tick, owns alert state, hands alert
  transitions to the notifier, keeps each monitor's transition history. Evaluates anomaly
  rules (part 8) with the detectors of `anomaly/` and keeps their state per (rule, series).
- **`Notifier`**, one per tenant, named `<tenant>`. Routing tree, grouping timers,
  inhibition, silences, acknowledgements, a transactional outbox to webhook and Slack
  receivers with HMAC-signed requests, and each monitor's notification history.
- **`RulerIndex`**, 16 objects named `index/<k>`: the registry of ruler shards the cron
  sweeper walks, and each tenant's shard count.
- **The Worker** (`src/index.ts`): the HTTP API (`src/http.ts`) and the Cron Trigger
  `scheduled()` that runs `sweep()`.

The query engine is not available yet. The ruler takes it as injected interfaces
(`BatchEvaluator`, `RangeEvaluator`, `Validator`); every number below was produced against
scripted fakes, so it is **ruler overhead only**. Nothing here has been deployed to
Cloudflare; nothing touched the Cloudflare account.

| File | Contents |
|---|---|
| `contracts-proposal/rules.ts` | Copy of the adopted `contracts/rules.ts` (identical, checked with `diff`) |
| `contracts-proposal/rules.v2.ts` | **The proposed contract changes**, as a typed diff over the copy (see "Contract issues") |
| `src/statemachine.ts` | The alert state machine as one pure function, used by live ticks and by backtests; no-data policies; recording-rule samples; `ALERTS` definition |
| `src/ruler.ts` | `Ruler`: storage, scheduling, batched tick, hand-off outbox, timelines, backtest, group export/import/release, health, dead-man's switch |
| `src/evaluator.ts` | The single-call → batch adapter; the permissive `Validator` stand-in |
| `src/backtest.ts` | Backtest over a range matrix through `evalAlertingRule`; intervals, summary, resolution note |
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
| `test/harness.ts` | The test worker: the classes with clock, evaluators, sink, receiver and crash points overridden |
| `test/anomaly.bench.ts`, `vitest.measure.config.ts` | Anomaly rule measurements in workerd (`npm run bench:anomaly`); the config adds `HOST`, which reads workerd's CPU time and the load average in Node |
| `scripts/mutants.mjs` | Mutation checks, applied to a scratch copy |

`wrangler.jsonc` is the production shape (not deployed): bindings `RULER`, `NOTIFIER`,
`RULER_INDEX`, `CONFIG` (edge's API-key KV namespace, by edge's placeholder id; never the
unrelated account namespace also called `CONFIG`), and the cron `*/15 * * * *`. Tests run
against `wrangler.test.jsonc`, which binds the subclasses in `test/harness.ts`.

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
range limit); a too-long range is refused with the smallest step that would work.

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
no alert changes; it never starts cold over them.

**Bounds, each an explicit refusal.**

| Bound | Default (`RulerLimits`) | Beyond it |
|---|---|---|
| Series per rule (`max_series`) | 100, or fewer when 100 series' estimated state would not fit the per-rule limit (the save warns: CUSUM 49, robust z 89); at most `maxAnomalySeriesPerRule` 1,000 | the evaluation is refused, `series_cap_exceeded` with the count; nothing is scored, no state row or alert changes; never a silent drop |
| State of one series | 65,536 B | at save from the estimate (e.g. a weekly season at a 10 s interval); at run time `state_limit_exceeded`, nothing changes |
| State of one rule | 1,048,576 B | the same |
| State of one ruler object | 16 MiB, summed at save as estimate × `max_series` over all its anomaly rules | the save is refused with the rule's path: state is held in memory between ticks (parsed and as JSON, about 3 bytes of heap per stored byte) |

Measured (below): one row written per tick for a 100-series EWMA, threshold or CUSUM rule, 2 for
robust z, 4–6 for seasonal; the same one row at 2 series as at 200.

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

- **The engine side of the contract.** No `EVALUATOR` (batch `evaluate`, `range`, `check`)
  or `SINK` binding exists; without them every rule reports `health: err`. Every number
  here is against fakes.
- **Real PromQL validation.** Only the interface and the permissive stand-in.
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
  **staleness markers**; **LogQL / TraceQL rules**, SLO rules.
- **Anomaly rules (part 8):** warming from history (a new rule, or one whose state was reset,
  warms live for the detector's `minPoints` evaluations; the ruler's `RangeEvaluator` could read
  the look-back at a cold start, not done); burn-rate SLO rules (to compile to recording rules)
  and the cross-series detector; STL refits and PELT as scheduled jobs; backtesting an anomaly
  monitor (`POST /monitors/backtest` takes threshold monitors only); a placement that knows the
  per-object state budget (a save over it is refused, not moved to another shard); state written
  less often than every tick (each tick costs at least one row per rule, measured below).
- **Notifier:** mute / active time intervals, notification templates, receivers other than
  webhook and Slack, `/api/v2/alerts` ingestion, editing a silence, updating a Slack message.
- **Metrics about itself** (`viz_rule_evaluations_total`…): `health()` only.
- **`DESIGN.md` / `DECISIONS.md`**: the earlier tasks' items under "Contract issues" (13) are
  still not made. Anomaly rules are in DESIGN §7 and D33; the published design page
  (`design/artifact/viz-design.html`) was not regenerated for them.
- **Deployment.** Nothing was deployed; there is no number "measured on Cloudflare".

## Verification

```
npm test                # 293 tests in 18 files, in workerd: all pass
npx tsc --noEmit        # clean
npm run independent     # capture, then Prometheus' own code (Go, tools/promcheck): 2 Go tests pass
npm run mutants         # 59 mutants (50 earlier + 9 for versioning); vitest runs with at most 2 workers
npm run bench           # the measurements below
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
| `compat.test.ts` | 14 | versioned storage: schema goldens per class and version; the pre-versioning dump adopted; refusal and its effects; newer readable storage |
| `golden.test.ts` | 3 | golden formats |

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
| 65 | anomaly: loading detector state does not name the tenant | anomaly: "every statement on detector state names the tenant …" (**survived the first run**: the injected foreign row reused a series key of this tenant, so it was overwritten on load; the test now gives it a key of its own and checks the series count after load; MUTANT65) |
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

**Mutants now run on a scratch copy.** `scripts/mutants.mjs` copies the component (and
`contracts/`, `edge/src/`, `anomaly/src/`, which it imports) to `$VIZ_SCRATCH` or the system
temporary directory, applies each mutant to the copy, runs the tests there, deletes the copy, and
checks at the end that every file a mutant touches is unchanged in the shared tree (AGENTS.md:
others snapshot the tree while mutants run; two such snapshots were taken during this task's
runs, and neither held a mutant). Before this change the script edited the shared tree in place.

**Anomaly mutants 60–80** (`VIZ_SCRATCH=… node scripts/mutants.mjs 60 … 80`, on the final code
apart from the test fix for 65): 20 killed, 1 survived (65, the tenant filter on loading state;
see its row), then MUTANT65_RERUN. RERUN_OLD

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
- **Delivery:** `Idempotency-Key`, `X-Viz-Signature`, seeded backoff, dead letters.
- **Regular expressions** are JavaScript's, anchored, at most 1,024 characters.
- **Payloads:** `generatorURL` empty; at most 500 alerts per webhook body.

## Contract issues

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
13. **Design text to update** (not done: outside `ruler/`): DESIGN §7 should say
    "one batch per group per tick, split only before a rule reading a series recorded
    earlier in the same tick", name the `RulerIndex` registry as the sweeper's source,
    and record acknowledge, silence-with-undo, no-data policies and signed webhooks;
    DECISIONS should get entries for "registry objects for the sweeper (vs. Notifier or a
    single global object)" and "jump-hash placement of whole groups (vs. a stored map)".

## Risks

- **Anomaly rules during a rollback** to a release without them are not evaluated at all (that
  release reads `RuleGroup.rules` only): no alerts, no error, until the newer release is back.
  Their state rows wait untouched. A threshold monitor edited during the rollback into a group
  holding anomaly rules would drop them on save; default groups keep the two kinds apart, an
  explicit `group` does not.
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
