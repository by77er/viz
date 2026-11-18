# Ruler

Prometheus-style rule evaluation and Alertmanager-style notification for one tenant
(design §7, decision D7). Two Durable Object classes:

- **`Ruler`**, one per tenant rule shard, named `<tenant>/<n>`. Holds rule groups, evaluates
  them on one alarm, owns alert state, hands alert transitions to the notifier.
- **`Notifier`**, one per tenant, named `<tenant>`. Routing tree, grouping timers,
  inhibition, silences, and a transactional outbox to webhook and Slack receivers.

The query engine is not available yet. The ruler takes it as an injected `Evaluator`
(`instant(promql, timeMs)`); every number below was produced against a scripted fake, so it
is **ruler overhead only**. Nothing here has been deployed to Cloudflare.

| File | Contents |
|---|---|
| `contracts-proposal/rules.ts` | Proposed contract (rule file, normalized rules, alert state, both RPC surfaces, `Evaluator`, `Sink`, notifier config, webhook payload). Meant to move to `contracts/` |
| `src/statemachine.ts` | The alert state machine as a pure function; recording-rule samples; the `ALERTS` / `ALERTS_FOR_STATE` definition |
| `src/ruler.ts` | `Ruler`: storage, scheduling, tick, hand-off outbox, health, dead-man's switch |
| `src/notifier.ts` | `Notifier`: grouping, flush decisions, outbox, delivery, silences RPC |
| `src/amconfig.ts` | Notifier config validation, routing, matchers, inhibition, silence matching (pure) |
| `src/rules.ts` | Rule-file validation with paths and fixes |
| `src/template.ts` | The template subset: parser, interpreter, Go-compatible number formatting |
| `src/classify.ts` | Duration extractor over PromQL text; `tail` / `recent` / `rollup` |
| `src/payload.ts` | Alertmanager webhook body (version "4"); Slack incoming-webhook message |
| `test/harness.ts` | The test worker: both classes with clock, evaluator, sink, receiver and crash points overridden |
| `scripts/mutants.mjs` | Mutation checks |

`wrangler.jsonc` is the production shape; tests run against `wrangler.test.jsonc`, which
binds the subclasses in `test/harness.ts`.

## What is implemented

**Rule model.** The Prometheus rule-file shape as JSON: groups (`name`, `interval`,
`query_offset`, `limit`, group `labels`), alerting rules (`alert`, `expr`, `for`,
`keep_firing_for`, `labels`, `annotations`), recording rules (`record`, `expr`, `labels`).
Unknown fields are rejected, as Prometheus does. Every error has a path
(`groups[0].rules[2].annotations.summary`), a message and a fix; nothing is saved unless
the whole file is valid. `checkGroups` validates without saving.

**Templates.** `{{ $labels.x }}`, `{{ $value }}`, `{{ $externalLabels.x }}` and the dotted
forms, string and number literals, pipelines, and `humanize`, `humanize1024`,
`humanizeDuration`, `humanizePercentage`, `humanizeTimestamp`, `printf` (`%v %s %d %f %e
%g %q`), `toUpper`, `toLower`, `title`, `{{-` / `-}}` trimming. Anything else is rejected at
save time with the character offset and a fix. Templates are parsed to a small tree and
interpreted; there is no `eval` or `new Function`. `$value` prints as Go prints a float64
(`1e+06`, not `1000000`).

**Ruler object.** SQLite storage; one alarm at the earliest group deadline, deleted when
there are no groups (an untouched object has no rows and no alarm). On a tick every due
group is evaluated once: rules in order, all at the group's aligned evaluation time
(`offset + k * interval`, offset = hash of tenant, shard and group name modulo the
interval). Groups due together run concurrently, at most `maxConcurrentGroups` (default 4).
A late alarm evaluates only the latest due time and counts the gap; it never loops.

**Alert state machine.** A transcription of `AlertingRule.Eval` (prometheus/rules/
alerting.go, fetched 2026-11-18): inactive → pending from `activeAt` → firing after `for`;
`keep_firing_for`; resolved alerts kept 15 minutes; identity is the fingerprint of the label
set (series labels without `__name__`, rule labels over them, an empty expanded label
removes the label, `alertname` last); duplicate label sets are an error; lengthening `for`
puts a too-young firing alert back to pending.

**Write discipline.** An alert row is written when the alert changes state. The hand-off
row for the notifier is written in the same transaction. Group cursors and counters are
written as one row at the heartbeat (default 5 minutes). Sample values and annotations of
a steady alert are refreshed in memory only. In-memory state is swapped only after the
transaction commits and is rebuilt from SQLite in the constructor.

**Recording rules.** Samples `(labels, timeMs, value)` go to the injected `Sink` in
batches with the id `<tenant>/<shard>/<group>/<rule key>@<evaluation time>`. A replayed tick
sends the same id again. Pending samples are written before a later rule whose expression
mentions the recorded name, otherwise once at the end of the group. The value is passed as
the evaluator's text, never parsed and re-printed.

**Notifications** live in a sibling `Notifier` object per tenant, not in the ruler.
Reason: routing, grouping and inhibition are defined over all of a tenant's alerts, and a
tenant's rules are spread over several ruler shards; one owner of group state per tenant
also removes the need for Alertmanager's gossip. The cost is a hop, made safe by an outbox
in the ruler and an idempotent `ingest` in the notifier (an update is applied only if its
evaluation time is not older than what is held; at equal times a resolve outranks a
firing). Implemented: routing tree with `match`, `match_re`, `matchers` and `continue`;
`group_by` (including `['...']`); `group_wait`, `group_interval`, `repeat_interval`;
inhibition with `equal` and the no-self-inhibition rule; silences created and expired
through RPC; resolved notifications; `send_resolved`; webhook (Alertmanager JSON, version
"4") and Slack-compatible receivers.

**Outbox.** The decision to notify, the notification-log update and the outbox row are one
SQLite transaction. The drain step POSTs with `fetch`; a row is deleted only after a 2xx.
Retries use exponential backoff with jitter derived from the idempotency key (no
`Math.random`). The `Idempotency-Key` header is
`hash(tenant, receiver, integration, group key, group creation time, state hash, notification number)`:
the same for every attempt, different for a repeat. After `max_attempts` (default 8), or at
once on a 4xx other than 408/429, the row becomes a dead letter, listed by `outbox()`,
re-queued by `retryDeadLetter()` with its original key, or dropped by `discardDeadLetter()`.

**Dead-man's switch and health.** Shard 0 of every activated tenant carries a built-in
group `viz:deadman` with the rule `DeadMansSwitch` (`vector(1)`). It goes through the
evaluator, the hand-off, routing and delivery like any rule. The ruler refreshes it at each
heartbeat with an expiry; if the refresh stops, the notifier resolves the alert by itself.
`Ruler.health()` reports per group: last evaluation time, last duration, next evaluation,
evaluations, skipped ticks, evaluator errors and rules in error; plus hand-off outbox depth,
oldest undelivered age, dropped sample batches and billed-write counters.
`Notifier.health()` reports outbox depth, oldest undelivered age and dead letters. A failed
evaluation marks the rule `err` with the message and leaves its alerts untouched. A group
tick gives up on its remaining rules after `groupTimeoutMs` (default 120 s).

**Classification.** At save time each rule gets `{ class, windowMs, reason }`, returned
with the save result. The window is the largest, over the expression's selectors, of (range
or 5-minute lookback) + enclosing subquery ranges + offsets, found by a tokenizer and a
bracket-aware walk over the PromQL text. `tail` if the window fits `hotWindowMs` (default
10 minutes, the shard's `sealAgeMs`), `recent` up to `recentWindowMs` (default 24 h), else
`rollup`. An `@ <timestamp>` modifier forces `rollup`. Where the walk cannot be sure it
over-estimates. Changing the thresholds re-classifies stored rules.

**Limits and isolation.** Max groups (64), rules per group (1,000), alerts per rule
(1,000, also the cap on a group `limit`), annotation bytes (4,096, enforced on the template
and on the expanded text), stored group bytes, minimum interval (10 s); in the notifier,
alerts (5,000; over it `ingest` answers `overloaded` with a retry delay) and silences
(1,000). Every RPC takes the tenant and answers `wrong_tenant` unless it is the tenant in
the object's name. Every SQL statement on tenant data names the tenant.

## Not implemented

- **YAML.** Rule files and notifier config are accepted as JSON only.
- **PromQL validation.** Save-time checks are balanced brackets, strings and durations. A
  syntactically wrong expression is accepted and reports `health: err` at its first
  evaluation.
- **One plan per group with shared scans** (design §7). The `Evaluator` interface is one
  call per rule; see "Contract issues".
- **`ALERTS` and `ALERTS_FOR_STATE`** are defined and tested (`syntheticSeries`) but not
  written anywhere.
- **Staleness markers** for a recorded series that disappears.
- **Template features** outside the subset: `if`, `range`, `with`, variables, `query`,
  `$externalURL`, `args`, `reReplaceAll` and the rest of Prometheus' function list.
- **Annotation refresh at the notifier.** A notification carries the annotations from the
  moment the alert fired (see "Deviations").
- **Notifier:** mute and active time intervals; notification templates; receivers other
  than webhook and Slack; authentication or custom headers on outbound requests;
  Alertmanager's `/api/v2/alerts` HTTP ingestion; updating a Slack message in place;
  expiry of alerts whose ruler shard went silent (only the dead-man's switch has an expiry).
- **Shard management:** placing rules into shards, splitting a shard, the tenant control
  object, and the cron sweeper. `ensureArmed()` is the RPC a sweeper would call.
- **HTTP API and authentication.** Both objects are RPC only.
- **Metrics about itself** (`viz_rule_evaluations_total` and so on). `health()` only.
- **Persisted rule health.** After a restart a rule is `unknown` until its next tick.
- **LogQL / TraceQL rules, SLO rules, anomaly detection, no-data policies.**
- **Deployment.** Nothing was deployed; there is no number "measured on Cloudflare".

## Verification

```
npm test             # 123 tests in 7 files, in workerd: all pass (about 30 s)
npx tsc --noEmit     # clean
npm run mutants      # 18 mutants, 18 killed
npm run bench        # prints the measurements below
```

| File | Tests | What |
|---|---|---|
| `test/unit.test.ts` | 22 | durations, tick alignment, backoff, templates, classification, rule-file and notifier-config validation, routing, inhibition, silences, payloads |
| `test/prometheus.test.ts` | 27 | Prometheus semantics, each test names the upstream test it encodes |
| `test/ruler.test.ts` | 32 | scheduling, replays, write counts, evaluator errors, limits, sink, health, isolation, dead-man's switch |
| `test/notifier.test.ts` | 25 | Alertmanager behaviour on a fake clock |
| `test/exactly-once.test.ts` | 12 | crashes, evictions, receiver failures; a de-duplicating receiver |
| `test/property.test.ts` | 3 | fast-check against an independent reference model |
| `test/bench.test.ts` | 2 | measurements |

**Upstream reference.** `rules/alerting.go`, `rules/alerting_test.go`,
`rules/manager_test.go`, `rules/group.go`, `template/template.go` and
`template/template_test.go` from prometheus/prometheus, and `dispatch/dispatch.go`,
`dispatch/route.go`, `notify/notify.go`, `inhibit/inhibit.go`, `notify/webhook/webhook.go`
from prometheus/alertmanager, were fetched from raw.githubusercontent.com (main, 2026-11-18)
and read. They were not vendored. Upstream tests drive a real PromQL engine over loaded
series; the ports write out by hand the query result those series produce at each step.

Ported, by upstream name: `TestAlertingRule`, `TestAlertingRuleState`,
`TestAlertingRuleLabelsUpdate` (adapted: upstream templates the label with `if`, which is
outside the subset; the port uses `{{ $value }}`), `TestAlertingRuleExternalLabelsInTemplate`
(adapted: no `len`), `TestAlertingRuleEmptyLabelFromTemplate`, `TestAlertingRuleDuplicate`,
`TestAlertingRuleLimit`, `TestKeepFiringFor`, `TestPendingAndKeepFiringFor`,
`TestFiringAlertResetToPendingOnHoldDurationIncrease`, `TestQueryForStateSeries`,
`TestForStateRestore` (with `evictDurableObject`; identical to a run without eviction),
`TestRuleHealthUpdates`, `TestCopyState` / `TestUpdate`, `TestGroup_QueryOffset`,
`TestRuleEvalDuplicate`, `TestRecordingRuleLimit`, resolved retention, group evaluation
order, and missed iterations. The `humanize*` expectations are the strings in
`template_test.go`. Not ported: histogram templating, `query` in templates,
`ExternalURL`, dependency analysis and concurrent rule evaluation, staleness on rule
removal, metadata appends: all concern features listed under "Not implemented".

**Recording rule visible to a later rule.** The test passes with a fake evaluator that
reads what the sink wrote. That is the limitation: the ruler guarantees the write happens
before the dependent rule is evaluated; whether the evaluator then sees it depends on the
ingest path making a sample queryable at once, which this component cannot check.

**Alertmanager behaviour** (fake clock; the notifier is stepped only at the alarm times it
armed): `group_wait` batches co-firing alerts and is skipped for an alert already firing
longer than it; a change waits for the next `group_interval` tick; an unchanged group
repeats after `repeat_interval` with a new key and arms no alarm and writes no row in
between; `group_by`; resolved notifications, including the group that is forgotten
afterwards and the alert that fires and resolves inside `group_wait`; `send_resolved:
false`; `continue`; first match wins; re-routing on a new config; inhibition with `equal`,
release when the source resolves, no self-inhibition; silences by RPC, natural start and
end; retries, backoff bounds, dead letters, 4xx; idempotent `ingest`; and one scenario run
twice, once with the notifier evicted before every step, producing identical requests at
identical times.

**Exactly-once effect.** The fake receiver records every request; the assertions are on
what a receiver that de-duplicates by `Idempotency-Key` would have processed.

| Case | Requests seen | Processed |
|---|---|---|
| Same alarm tick replayed 3× in memory, 3× after eviction; notifier alarm replayed 6× | 1 | 1 |
| Crash inside the ruler's transition transaction (no alert row, no hand-off row, memory not ahead) | 1 | 1 |
| Crash between "transition persisted" and "outbox drained" | 1 | 1 |
| Crash after the notifier accepted the hand-off, before the ruler recorded it | 1 (hand-off sent twice, second applied nothing) | 1 |
| Notifier unreachable across fire, resolve, fire | 1 | 1, updates arrived in order |
| Crash inside the notifier's flush transaction | 0 before the retry, then 1 | 1 |
| Crash after the decision committed, before the drain | 1 | 1 |
| Evicted mid-drain after the receiver processed the request | 2, same key, same body | 1 |
| Receiver answers 500 then 200 | 2, same key | 1 |
| Receiver times out twice after processing | 3, same key | 1 |
| Fire, resolve, fire again, two repeats | 5, five keys | 5 |
| 6 seeds × 30 ticks of flapping alerts, with random crashes at six crash points, random evictions, 20% 500s and 15% timeouts-after-processing, compared with the same seed without faults | 139 crashes injected, 130 extra requests | identical set of 148 notifications, identical alert state, identical recorded batches, empty outboxes |

In the last row a crashed alarm is retried at the same clock time, which is how the test
keeps the faulty and the clean run comparable; real platform retry timing is not exercised.

**Property tests** (fast-check). The reference model in `test/property.test.ts` is a
per-series transition table written from the documented alert states, not from
`statemachine.ts`. 1,500 random runs (up to 40 evaluations, 4 series, random `for`,
`keep_firing_for`, retention and missed ticks): same states, same notifications, and the
set of alerts marked for persistence equals the set the reference changed. 500 runs:
re-evaluating the same (state, result, time) changes nothing and never mutates its input.
40 runs through the real object with random evictions: state equals the reference after
every tick, and SQL rows written = transitions + 2 per tick that notified (hand-off row
inserted, then deleted) + 1 per heartbeat, exactly.

**Mutants.** `scripts/mutants.mjs` applies each, runs the named test files, requires a
failure, and restores the source. All 18 were killed.

| # | Mutant | Killed by (first of) |
|---|---|---|
| 1 | Advance `for` on a replayed tick (evaluate at wall-clock time, not the aligned tick) | ruler: "a retry that arrives later in the same interval ... `for` does not advance" |
| 2 | Drop the replay guard | ruler: "the same (group, evaluation time) is not evaluated twice" |
| 3 | Resolve on evaluator error | ruler: "a failed evaluation ... resolves nothing" |
| 4 | Notify before the transaction commits | exactly-once: "crash inside the flush transaction: the receiver has seen nothing" |
| 5 | Drop the idempotency key | exactly-once: all 12 |
| 6 | Idempotency key depends on the attempt | exactly-once: "500 then 200", "times out after processing" |
| 7 | Ignore silences | notifier: both silence tests |
| 8 | Wrong group key (labels left out) | notifier: "group_by makes one group ... per label value" |
| 9 | Catch up missed ticks in a loop | prometheus: "iterations missed ... counted, not replayed" |
| 10 | Persist on every tick | ruler: "100 steadily firing alerts cost zero SQL row writes"; property tests |
| 11 | Memory ahead of storage | exactly-once: "crash inside the transition transaction" |
| 12 | Hand-off row outside the transition transaction | exactly-once: "crash between transition persisted and outbox drained" |
| 13 | Retryable receiver failure treated as delivered | exactly-once: "500 then 200" |
| 14 | Stored alerts not loaded (`for` timers reset on restore) | prometheus: `TestForStateRestore` |
| 15 | Inhibit without checking `equal` | unit and notifier inhibition tests |
| 16 | Serve any tenant | ruler: "every RPC refuses a tenant other than ..." |
| 17 | Redelivered "firing" re-opens a resolved alert | notifier: "a redelivered batch applies nothing" |
| 18 | `group_interval` ignored | notifier: "a change ... waits for the next interval tick" |

**Defects the tests found in this code while it was written** (all fixed): template
function lookup reached `Object.prototype` (`{{ constructor }}` was accepted);
`AbortSignal.timeout` left a timer that kept the notifier in memory for the full timeout
after every send; the idempotency key repeated when a group emptied and was recreated;
a resolved inhibitor was forgotten before every group had flushed past its resolution, so
an inhibited alert was released one interval early; an overdue but muted repeat re-armed
the alarm for the present in a loop; a group's first tick was not scheduled when an update
arrived exactly on it.

### Measurements

Measured here: workerd 1.20261117.1 under vitest, a 4-core machine with a load average
near 12 from other builds, four runs. 1,000 rules (950 alerting with two labels and three
templated annotations, 50 recording), 100 firing alerts, fake evaluator answering from a
table. Wall time is taken in the test around `runDurableObjectAlarm`, so it includes that
call; the clock has 1 ms resolution.

| Quantity | 1 group × 1,000 | 10 groups × 100 |
|---|---|---|
| Tick wall time, steady state, 40 ticks: median | 11–17 ms | 11–13 ms |
| p95 / max | 22–48 / 33–58 ms | 22–30 / 29–50 ms |
| Tick in which 100 alerts start firing | 54–94 ms, 102 rows | 57–228 ms, 120 rows |
| SQL rows written per steady tick | 0 (1 on the 8 heartbeat ticks) | 0 (1 on the 8 heartbeat ticks) |
| `setAlarm` calls per tick | 1 | 1 |
| Storage, `databaseSize` | 737,280 bytes | 753,664 bytes |
| Evict, rebuild from SQLite, first RPC | 38–105 ms | 28–57 ms |
| Save 1,000 rules (validate, classify, store) | 110–186 ms | 56–94 ms |

One fire-and-resolve incident, measured: 8 rows in the ruler, 10 rows and 3 `setAlarm` in
the notifier, 2 webhook requests.

### Cost model

**Modelled**, not measured on Cloudflare. 1,000 rules in one `Ruler` object, 60 s interval,
30 days = 43,200 ticks; prices from research/10 §1 (requests $0.15/M, duration $12.50/M
GB-s at 128 MB, rows written $1.00/M, rows read $0.001/M, storage $0.20/GB-month), before
the plan's included allowances.

| Item | Basis | Low | High |
|---|---|---|---|
| Alarm invocations | 43,200 requests | $0.006 | $0.006 |
| `setAlarm` | 43,200 rows (measured: 1 per tick) | $0.043 | $0.043 |
| Heartbeat | 8,640 rows (measured: 1 per 5 min) | $0.009 | $0.009 |
| Duration, ruler overhead | 15–50 ms per tick (measured here) | $0.001 | $0.004 |
| Duration, waiting for the evaluator | 1,000 sequential calls at 0.2–10 ms each (assumed) | $0.014 | $0.69 |
| Rows read on rebuild | 0 to every tick × about 115 rows | $0 | $0.005 |
| Alert incidents | 0–10,000 per month × 21 billed rows (measured) | $0 | $0.21 |
| Storage | 0.74 MB (measured) | $0.0002 | $0.0002 |
| **Total, ruler and notifier objects** | | **≈ $0.07** | **≈ $1.0** |

So **$0.07–$1.0 per 1,000 rules per month**, dominated by how long a tick waits for the
evaluator. It excludes everything the evaluator itself costs (query CPU, shard reads, R2
reads), which D7 puts at cents for tail-class rules and dollars for the rest. It also
assumes a call to the evaluator is not a billed request: if the evaluator is a Durable
Object and each of the 1,000 calls per tick is its own RPC session, that alone is
43.2 M requests, about $6.5 a month (see "Contract issues"). What would settle it: spike
S0 (`design/VERIFICATION.md` §4) for how a 60 s wake is billed, then this ruler deployed
against the real evaluator for a day with the bill read from Cloudflare analytics.

## Deviations from Prometheus

- **A failing rule keeps its alerts indefinitely.** In Prometheus a rule that errors stops
  re-sending its alerts, so Alertmanager expires them after a few intervals. Here alerts
  are resolved only by an evaluation that succeeds. This is what the task asked for; it
  means a rule broken for good holds its alerts until someone fixes or deletes it.
- **Over the limit, state is kept.** Prometheus clears the rule's active alerts when the
  limit is exceeded; here the rule is `err` and its alerts stay.
- **Explicit transitions, no re-send.** The ruler tells the notifier "firing" and
  "resolved" once each, through an outbox, instead of re-sending every minute with an
  `endsAt`. Only the dead-man's switch uses refresh-with-expiry.
- **Annotations are frozen at the firing transition** as far as notifications go. The
  ruler's own view (`rules()`) follows the latest sample, in memory.
- **Restoring `for`.** `activeAt` is stored when the alert is created, so restoration is
  exact. Prometheus' outage tolerance and grace period do not exist.
- **Fingerprints** are a 64-bit hash of the sorted label set, not Prometheus' xxhash, so
  they differ from the ones Prometheus prints. Group offsets likewise use this hash.
- **Templates** are a subset; a file using anything else is rejected at save time.
- **Recorded samples** are written before a dependent rule only when that rule's text
  contains the recorded name; other samples go out at the end of the group. No staleness
  markers. A sink that fails three times in a tick loses that batch (counted in
  `samplesDropped`, rule marked `err`); there is no backfill, as in Prometheus.
- **Rule identity** across saves is the hash of name, expression and labels.
- **Minimum interval** of 10 s; the alerts-per-rule cap applies even with `limit: 0`.
- **Missed ticks are skipped and counted**, as Prometheus does. research/08 §3.5 proposed
  a bounded replay; the task ruled it out.

## Deviations from Alertmanager

- **Flush ticks are a fixed grid**, `group creation + group_wait + k * group_interval`, and
  a flush decides from the state as of its tick. Alertmanager restarts the timer after each
  flush, so its ticks drift. A change that arrives exactly on a tick is included in it.
- **Repeat** fires when `repeat_interval` or more has passed since the last notification;
  Alertmanager requires strictly more.
- **The notification log lives in the group** and goes when the group empties.
  Alertmanager keeps it 120 h.
- **A resolved alert may appear again** as "resolved" in a later notification of the same
  group until every group holding it has flushed past the resolution (plus one
  `group_interval` when inhibition rules exist).
- **Delivery:** an `Idempotency-Key` header, seeded backoff, dead letters with manual retry.
  Alertmanager retries within the flush and then drops.
- **Regular expressions** are JavaScript's, anchored, at most 1,024 characters; not RE2.
- **Silences** can be created and expired, not edited. Matching an alert with no labels is
  refused, as in Alertmanager.
- **Payloads:** `generatorURL` is empty; at most 500 alerts per webhook body (the rest are
  counted in `truncatedAlerts`); the Slack message has one fixed layout.
- **No expiry by `endsAt`** except for the dead-man's switch.

## Contract issues

Recorded here because this component may not edit `contracts/`.

1. **`Evaluator` is per expression.** `instant(promql, timeMs)` forces one call per rule
   per tick (1,000 calls a tick here). Design §7 wants one plan per group with shared
   scans, and research/08 §3 wants one batched RPC per data shard. The contract needs a
   batch form, for example `instantBatch(queries: string[], timeMs)`, returning a result
   or an error per query. Without it the ruler cannot share scans and the request count is
   the largest line in the cost model.
2. **No tenant in `Evaluator`.** The ruler binds the tenant in an adapter and expects the
   production binding as `EVALUATOR.instant(tenant, promql, timeMs)` (and
   `SINK.write(tenant, batches)`). Who authenticates the ruler to the engine is not
   written anywhere.
3. **Result shapes.** `Engine.queryInstant` may return a matrix or a string; a rule needs a
   vector or scalar, so the ruler treats the others as an evaluation error. Result
   timestamps (Unix seconds) are ignored; the ruler stamps samples with its own evaluation
   time in milliseconds.
4. **Read-your-writes for recording rules** is not expressible: `Evaluator` has no way to
   be handed samples that are not yet queryable.
5. **`Sink` has no staleness marker.** `RecordedSample.value` is the evaluator's text so
   nothing is re-encoded in JavaScript (contracts/engine.ts forbids that), but a stale
   marker for a series that vanished cannot be sent as text.
6. **No PromQL validation or exact classification without the engine.**
   `Engine.selectors()` would give exact ranges; the ruler cannot reach it at save time, so
   it classifies from the text and over-estimates when unsure.
7. **`hotWindowMs` is a copy.** Its default equals the shard's `sealAgeMs`, but nothing
   ties them together; the control plane must set it per tenant.
8. **LogQL and TraceQL rules** (design §7) have no result shape in `contracts/engine.ts`.
9. **The proposal itself** changed two details of the brief: `Sink.write` takes batches
   `{ id, samples }` rather than bare samples, so the id travels with them; and the
   notifier RPC is `listAlerts`, not `alerts`.

## Risks

- **Skipped ticks are only known while the object stays in memory.** The cursor is
  persisted at the heartbeat, as required ("not every tick"). After an eviction the ticks
  since the last heartbeat are reported as `unobservedTicks`, which may or may not have
  run. In production an object can be evicted between most ticks, so `skippedTicks` will
  under-report. `heartbeatMs: 0` writes the cursor every tick and makes the count exact,
  for 43,200 more rows a month ($0.043) per object. This should be the owner's decision.
- **Alarm retry behaviour is assumed.** If a tick throws, the ruler arms its own retry
  (five times, seeded backoff from 1 s) and rethrows. How that combines with the
  platform's retry was not tested on Cloudflare; a double retry is harmless because of
  the replay guard and the pure state machine.
- **`ctx.id.name` on an alarm wake-up.** Measured here: a real alarm waking an evicted
  object had its name. Both objects also store their name on first write and fall back to
  it. Not checked on Cloudflare.
- **Sequential evaluation makes tick time the sum of query latencies.** A 1,000-rule group
  with a 60 ms evaluator takes the whole interval; ticks are then skipped. The 120 s group
  timeout bounds a hung evaluator, not a slow one.
- **Memory.** Everything is loaded in the constructor. The default limits (64 groups of up
  to 1.5 MB) allow far more than one object should hold; shard splitting, which would keep
  an object near 1,000 rules, is not implemented.
- **Notifier cost grows with alerts × (silences + inhibition rules)** at each alarm and
  each `ingest`. The 5,000-alert cap bounds it; it was not measured.
- **JavaScript regular expressions can backtrack.** A tenant can write a slow `match_re`
  or silence; only the length is limited.
- **Outbound requests go wherever the tenant's config says**, with no authentication and
  no allowlist.
- **The dead-man's switch proves the path to the receiver, not the receiver's watchdog.**
  A notifier that is itself dead sends nothing, including no "resolved"; an external
  watchdog that alarms on silence is still required, and so is the platform-level monitor
  of research/08 §3.5.
- **A permanently broken rule never resolves its alerts** (first deviation above).
- **Crash tests compress time.** Faults are injected at six named points and the alarm is
  retried at once; partial failures inside SQLite or the runtime are not simulated.
- **Write counters count statements that were later rolled back.** They are diagnostics.
- **Fingerprint collisions** (64 bits) would surface as a spurious "same labelset" error.
