// Mutation checks (AGENTS.md, "Tests must have teeth").
//
// Each mutant breaks one property in the source, on purpose. The script copies the component
// (and the sibling sources it imports: contracts/, edge/src/, anomaly/src/, control/src/,
// dashboard/src/) to a fresh scratch
// directory, applies the mutant to the COPY, runs the named test files there, requires at least
// one test to fail, and deletes the copy at the end. The shared tree is only read: others commit
// and snapshot it while this runs (AGENTS.md, Evidence), and the script checks at the end that
// every file it mutated is byte-identical in the shared tree to what it was at the start.
// A mutant that survives, or whose pattern no longer matches the source, is printed and
// makes the script exit non-zero: a stale pattern is a check that silently stopped running.
// The scratch directory is $VIZ_SCRATCH if set, else the system temporary directory.
//
// A mutant is one or more edits: { file, find, replace }. `find` must occur exactly once.
// Kills are read from vitest's JSON report, not from its console output.
//
//   node scripts/mutants.mjs            run all
//   node scripts/mutants.mjs 3 7        run mutants 3 and 7
//   node scripts/mutants.mjs --list     print the list

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The component in the shared tree: read, never written. */
const source = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(source, '..')

const one = (file, find, replace) => [{ file, find, replace }]

export const MUTANTS = [
  // ───────────── evaluation, state, hand-off (the first 18, patterns brought up to date) ─────────────
  {
    name: 'advance `for` on a replayed tick (evaluate at wall-clock time instead of the aligned tick time)',
    edits: one('src/ruler.ts', 'const ts = alignedTick(now, g.spec.intervalMs, g.offsetMs)\n        // Not started yet', 'const ts = now\n        // Not started yet'),
    tests: ['test/ruler.test.ts', 'test/prometheus.test.ts'],
  },
  {
    name: 'drop the replay guard (the same group and evaluation time is evaluated again)',
    edits: one('src/ruler.ts', 'if (ts < g.notBefore || (g.lastEvalMs !== null && ts <= g.lastEvalMs)) continue', 'if (ts < g.notBefore) continue'),
    tests: ['test/ruler.test.ts'],
  },
  {
    name: 'resolve on evaluator error (treat a failed query as an empty result)',
    edits: one('src/ruler.ts', '            setHealth(rule, error, res?.durationMs ?? null)\n            continue\n', '            setHealth(rule, error, res?.durationMs ?? null)\n            series = []\n'),
    tests: ['test/ruler.test.ts', 'test/batch.test.ts'],
  },
  {
    name: 'notify before the transaction commits (send from inside the flush transaction)',
    edits: one('src/notifier.ts',
      't, nextId++, g.key, g.route.receiver, d.integration.key, d.integration.url, idem, JSON.stringify(body), now, now, subjects.size > 0 ? JSON.stringify([...subjects.keys()]) : null)\n',
      't, nextId++, g.key, g.route.receiver, d.integration.key, d.integration.url, idem, JSON.stringify(body), now, now, subjects.size > 0 ? JSON.stringify([...subjects.keys()]) : null)\n' +
        "            void this.fetcher()(d.integration.url, { method: 'POST', headers: { [IDEMPOTENCY_HEADER]: idem }, body: JSON.stringify(body) }).catch(() => {})\n"),
    tests: ['test/exactly-once.test.ts'],
  },
  {
    name: 'drop the idempotency key header',
    edits: one('src/notifier.ts', "'user-agent': 'viz-notifier', [IDEMPOTENCY_HEADER]: row.idem_key }", "'user-agent': 'viz-notifier' }"),
    tests: ['test/exactly-once.test.ts'],
  },
  {
    name: 'make the idempotency key depend on the attempt',
    edits: one('src/notifier.ts', '[IDEMPOTENCY_HEADER]: row.idem_key }', '[IDEMPOTENCY_HEADER]: hash64(row.idem_key + row.attempts) + hash64(row.idem_key) }'),
    tests: ['test/exactly-once.test.ts'],
  },
  {
    name: 'ignore silences',
    edits: one('src/notifier.ts', 'if (silencedBy(this.compiledSilences(), a.labels, tick).length > 0) return true', 'if (silencedBy(this.compiledSilences(), a.labels, tick).length < 0) return true'),
    tests: ['test/notifier.test.ts'],
  },
  {
    name: 'wrong group key (group labels left out of the key)',
    edits: one('src/amconfig.ts', "return `${route.key}:{${Object.keys(group).sort().map((n) => `${n}=${JSON.stringify(group[n])}`).join(',')}}`", 'return `${route.key}:{}`'),
    tests: ['test/notifier.test.ts'],
  },
  {
    name: 'catch up missed ticks in a loop',
    edits: one('src/ruler.ts', '        due.push({ g, ts })\n', '        for (let t = previous + g.spec.intervalMs; t <= ts; t += g.spec.intervalMs) due.push({ g, ts: t })\n'),
    tests: ['test/prometheus.test.ts', 'test/ruler.test.ts'],
  },
  {
    name: 'persist on every tick (a refreshed value counts as a transition)',
    edits: one('src/statemachine.ts', '        next.set(fp, { ...existing, value: a.value, annotations: a.annotations })\n      }\n      continue', '        next.set(fp, { ...existing, value: a.value, annotations: a.annotations })\n      }\n      dirty.add(fp)\n      continue'),
    tests: ['test/ruler.test.ts', 'test/property.test.ts'],
  },
  {
    name: 'memory ahead of storage (adopt the new alert state before the transaction commits)',
    // Pattern brought up to date (the anomaly change added `|| s.anomaly?.changed === true`, the SLO change `|| s.slo?.ev.changed === true`).
    edits: one('src/ruler.ts', '    if (staged.some((s) => s.result.dirty.size > 0 || s.anomaly?.changed === true || s.slo?.ev.changed === true)) {\n      const t = this.tenant\n', '    for (const { rule, result } of staged) g.alerts.set(rule.key, result.alerts)\n    if (staged.some((s) => s.result.dirty.size > 0 || s.anomaly?.changed === true || s.slo?.ev.changed === true)) {\n      const t = this.tenant\n'),
    tests: ['test/exactly-once.test.ts'],
  },
  {
    name: 'hand-off row written outside the transition transaction (dropped on a crash in between)',
    edits: one('src/ruler.ts', "        this.enqueueHandoff(updates, ts)\n        this.fault('commit')\n      })\n      this.noteHandoff(updates, ts)", "        this.fault('commit')\n      })\n      this.fault('after-commit')\n      this.enqueueHandoff(updates, ts)\n      this.noteHandoff(updates, ts)"),
    tests: ['test/exactly-once.test.ts'],
  },
  {
    name: 'treat a retryable receiver failure as delivered (at-most-once)',
    edits: one('src/notifier.ts', '      if (ok) {\n        this.ctx.storage.transactionSync(() => {\n          this.exec(`DELETE FROM outbox', '      if (ok || !permanent) {\n        this.ctx.storage.transactionSync(() => {\n          this.exec(`DELETE FROM outbox'),
    tests: ['test/exactly-once.test.ts', 'test/notifier.test.ts'],
  },
  {
    name: 'reset `for` timers on restore (do not load stored alerts)',
    edits: one('src/ruler.ts', '      m.set(row.fp, reviveAlert(row.body))\n', '      void m\n'),
    tests: ['test/prometheus.test.ts'],
  },
  {
    name: 'inhibit without checking the `equal` labels',
    edits: one('src/amconfig.ts', 'if (labelValue(s.labels, n) !== labelValue(target, n)) {', 'if (n === "\\u0000") {'),
    tests: ['test/unit.test.ts', 'test/notifier.test.ts'],
  },
  {
    name: 'serve any tenant (drop the tenant check in the ruler)',
    edits: one('src/ruler.ts', "return this.tenant !== '' && tenant === this.tenant ? null : { status: 'wrong_tenant' }", "return tenant === undefined ? { status: 'wrong_tenant' } : null"),
    tests: ['test/ruler.test.ts'],
  },
  {
    name: 'a "firing" redelivered after the "resolved" re-opens the alert (drop the ordering check in ingest)',
    edits: one('src/notifier.ts', '        if (u.at < cur.at) continue\n', ''),
    tests: ['test/notifier.test.ts', 'test/exactly-once.test.ts'],
  },
  {
    name: 'group_interval ignored (flush a changed group as soon as an alarm runs)',
    edits: one('src/notifier.ts', "      if (!a || a.receivedAt > tick) continue\n      if (this.muted(a, tick)) continue\n      if (this.firingAsOf(a, tick)) firing.push(fp)", "      if (!a) continue\n      if (this.muted(a, tick)) continue\n      if (a.status === 'firing') firing.push(fp)"),
    tests: ['test/notifier.test.ts'],
  },

  // ───────────── this task: the ten asked for, and the ones around them ─────────────
  {
    name: 'acknowledge does not stop repeats',
    edits: one('src/notifier.ts', 'payloadFiring = firing.filter((fp) => !this.alerts.get(fp)?.ack)', 'payloadFiring = firing'),
    tests: ['test/ack.test.ts'],
  },
  {
    name: 'un-acknowledge does not resume repeats (it is a no-op)',
    edits: one('src/notifier.ts', 'const changes = hit.filter((a) => Boolean(a.ack) !== on)', 'const changes = hit.filter((a) => on && Boolean(a.ack) !== on)'),
    tests: ['test/ack.test.ts'],
  },
  {
    name: 'acknowledge hides the alert (the notifier stops listing acknowledged alerts)',
    edits: one('src/notifier.ts', 'const alerts: NotifierAlert[] = [...this.alerts.values()].map((a) => ({', 'const alerts: NotifierAlert[] = [...this.alerts.values()].filter((a) => !a.ack).map((a) => ({'),
    tests: ['test/ack.test.ts'],
  },
  {
    name: 'acknowledge hides the alert (the monitor view drops acknowledged alerts)',
    edits: one('src/monitors.ts', "    .filter((a) => a.state !== 'inactive')\n    .map((a) => {\n      const n = states.get(a.fingerprint)", "    .filter((a) => a.state !== 'inactive' && !states.get(a.fingerprint)?.acknowledged)\n    .map((a) => {\n      const n = states.get(a.fingerprint)"),
    tests: ['test/monitors.test.ts'],
  },
  {
    name: 'silence undo leaves the silence (reports it removed, keeps it)',
    edits: [
      { file: 'src/notifier.ts', find: '      for (const id of ids) {\n        this.exec(`DELETE FROM silence WHERE tenant = ? AND id = ?`, this.tenant, id)\n', replace: '      for (const id of ids) {\n' },
      { file: 'src/notifier.ts', find: '    for (const id of ids) this.silences.delete(id)\n', replace: '' },
    ],
    tests: ['test/ack.test.ts', 'test/http.test.ts'],
  },
  {
    name: 'backtest uses a different state machine (a second implementation: pending, firing after `for`, gone = resolved)',
    edits: [
      { file: 'src/backtest.ts', find: "import { formatDuration, parseSampleValue } from './util'", replace: "import { fingerprint, formatDuration, parseSampleValue } from './util'" },
      // Pattern brought up to date (the step moved into `IntervalTracker` when backtests began to stream).
      { file: 'src/backtest.ts', find: '    const r = evalAlertingRule(this.rule, this.compiled, this.alerts, input.series, ts, this.opts, input.presence)', replace: '    const r = secondStateMachine(this.rule, this.alerts, input.series, ts)' },
      {
        file: 'src/backtest.ts',
        find: '/** The summary is a function of the intervals and nothing else. */',
        replace: `function secondStateMachine(rule, prev, series, ts) {
  const alerts = new Map()
  for (const s of series) {
    const labels = {}
    for (const k in s.metric) if (k !== '__name__') labels[k] = s.metric[k]
    Object.assign(labels, rule.labels)
    labels.alertname = rule.name
    const fp = fingerprint(labels)
    const old = prev.get(fp)
    const activeAt = old && old.state !== 'inactive' ? old.activeAt : ts
    const firing = ts - activeAt >= rule.forMs
    alerts.set(fp, { fingerprint: fp, labels, annotations: {}, state: firing ? 'firing' : 'pending', activeAt, firedAt: firing ? (old?.firedAt ?? ts) : null, resolvedAt: null, keepFiringSince: null, value: s.value })
  }
  return { ok: true, alerts, dirty: new Set(), notify: [], noData: false }
}

/** The summary is a function of the intervals and nothing else. */`,
      },
    ],
    tests: ['test/backtest.test.ts'],
  },
  {
    name: 'one failure fails the batch (the ruler fails every rule when any result is an error)',
    edits: one('src/ruler.ts', '        if (!current()) return\n        for (const i of indexes) {', "        if (!current()) return\n        if ([...results.values()].some((r) => !r.ok)) batchError = 'a request in the batch failed'\n        for (const i of indexes) {"),
    tests: ['test/batch.test.ts'],
  },
  {
    name: 'one failure fails the batch (the single-call adapter rejects the whole call)',
    edits: one('src/evaluator.ts', '            out.push({ id: r.id, ok: false, error: errorText(e), durationMs: Date.now() - started })', '            throw e'),
    tests: ['test/batch.test.ts'],
  },
  {
    name: 'no data treated as resolve under `keep`',
    edits: one('src/statemachine.ts', "const noData = policy !== undefined && policy.mode !== 'ok' && (presence ?? series).length === 0", "const noData = policy !== undefined && policy.mode === 'alerting' && (presence ?? series).length === 0"),
    tests: ['test/nodata.test.ts'],
  },
  {
    name: 'an absent series keeps its pending alert (Prometheus drops it at once)',
    edits: one('src/statemachine.ts', "if (a.state === 'pending' || (a.resolvedAt !== null && ts - a.resolvedAt > opts.resolvedRetentionMs)) {", 'if (a.resolvedAt !== null && ts - a.resolvedAt > opts.resolvedRetentionMs) {'),
    tests: ['test/nodata.test.ts', 'test/prometheus.test.ts'],
  },
  {
    name: 'write without scope (writes are checked against monitors:read)',
    edits: one('src/http.ts', 'const principal = await authenticate(req, env.CONFIG, def.scope as never)', "const principal = await authenticate(req, env.CONFIG, (def.method === 'GET' ? def.scope : 'monitors:read') as never)"),
    tests: ['test/http.test.ts'],
  },
  {
    name: 'tenant from path (a /t/<tenant> prefix selects the tenant)',
    edits: [
      {
        file: 'src/http.ts',
        find: "      const segments = url.pathname.split('/').slice(1)\n",
        replace: "      let segments = url.pathname.split('/').slice(1)\n      let pathTenant = null\n      if (segments[0] === 't' && segments.length > 2) {\n        pathTenant = decodeURIComponent(segments[1])\n        segments = segments.slice(2)\n      }\n",
      },
      { file: 'src/http.ts', find: 'new Call(req, env, principal.tenant,', replace: 'new Call(req, env, pathTenant ?? principal.tenant,' },
    ],
    tests: ['test/http.test.ts'],
  },
  {
    name: 'tenant from the query string (?tenant=)',
    edits: one('src/http.ts', 'new Call(req, env, principal.tenant,', "new Call(req, env, url.searchParams.get('tenant') ?? principal.tenant,"),
    tests: ['test/http.test.ts'],
  },
  {
    name: 'tenant from a header (X-Scope-OrgID)',
    edits: one('src/http.ts', 'new Call(req, env, principal.tenant,', "new Call(req, env, req.headers.get('X-Scope-OrgID') ?? principal.tenant,"),
    tests: ['test/http.test.ts'],
  },
  {
    name: 'dryRun ignored on writes',
    edits: one('src/http.ts', "    const q = this.url.searchParams.get('dryRun')\n", "    return false\n    const q = this.url.searchParams.get('dryRun')\n"),
    tests: ['test/http.test.ts', 'test/monitors.test.ts'],
  },
  {
    name: 'unbounded timeline (the ruler keeps every transition)',
    edits: one('src/ruler.ts', 'const over = log.entries.length - this.cfg.timelineLimit', 'const over = 0'),
    tests: ['test/monitors.test.ts'],
  },
  {
    name: 'unbounded notification log (the notifier keeps every entry)',
    edits: one('src/notifier.ts', 'const over = log.entries.length - DEFAULT_NOTIFIER_LIMITS.logLimit', 'const over = 0'),
    tests: ['test/monitors.test.ts'],
  },
  {
    name: 'sweeper double-arms (ensureArmed re-arms a ruler that has an alarm)',
    edits: one('src/ruler.ts', "if ((this.groups.size === 0 && this.handoffDepth === 0) || (await this.ctx.storage.getAlarm()) !== null) return { status: 'ok' as const, rearmed: false }", "if (this.groups.size === 0 && this.handoffDepth === 0) return { status: 'ok' as const, rearmed: false }"),
    tests: ['test/robust.test.ts'],
  },
  {
    name: 'sweeper pages overlap (a ruler on a page boundary is visited twice)',
    edits: one('src/registry.ts', 'WHERE (tenant, shard) > (?, ?) ORDER BY tenant, shard LIMIT ?', 'WHERE (tenant, shard) >= (?, ?) ORDER BY tenant, shard LIMIT ?'),
    tests: ['test/robust.test.ts'],
  },
  {
    name: 'YAML anchors accepted',
    edits: [
      { file: 'src/yaml.ts', find: "    if (c === '&') throw new YamlError('anchors (&name) are not supported', n, 'Write the value out where it is used.')\n", replace: '' },
      { file: 'src/yaml.ts', find: "    if (c === '&') throw new YamlError('anchors (&name) are not supported', this.n, 'Write the value out where it is used.')\n", replace: '' },
    ],
    tests: ['test/yaml.test.ts', 'test/monitors.test.ts'],
  },
  {
    name: 'YAML aliases accepted',
    edits: [
      { file: 'src/yaml.ts', find: "    if (c === '*') throw new YamlError('aliases (*name) are not supported', n, 'Write the value out instead of referring to an anchor.')\n", replace: '' },
      { file: 'src/yaml.ts', find: "    if (c === '*') throw new YamlError('aliases (*name) are not supported', this.n, 'Write the value out instead of referring to an anchor.')\n", replace: '' },
    ],
    tests: ['test/yaml.test.ts'],
  },
  {
    name: 'a moved group loses its alert state (import ignores the bundle\'s alerts)',
    edits: one('src/ruler.ts', '        for (const a of alerts) {\n          m.set(a.fingerprint, a)', '        for (const a of alerts.slice(alerts.length)) {\n          m.set(a.fingerprint, a)'),
    tests: ['test/robust.test.ts'],
  },
  {
    name: 'a moved group re-notifies (release resolves its alerts, as delete does)',
    edits: one('src/ruler.ts', "    if (!g || name === DEADMAN_GROUP) return { status: 'ok' as const, existed: false }\n    this.ctx.storage.transactionSync(() => {", "    if (!g || name === DEADMAN_GROUP) return { status: 'ok' as const, existed: false }\n    if (g) return this.deleteGroup(tenant, name)\n    this.ctx.storage.transactionSync(() => {"),
    tests: ['test/robust.test.ts'],
  },
  {
    name: 'placement depends on arrival order (least-loaded shard instead of the hash)',
    edits: one('src/placement.ts', '      const s = shardOf(g.name, n)', '      const s = count.indexOf(Math.min(...count))'),
    tests: ['test/robust.test.ts'],
  },
  {
    name: 'the webhook secret is returned by the API (redaction removed)',
    edits: one('src/amconfig.ts', '      delete w.secret\n      w.has_secret = had\n', '      w.has_secret = had\n'),
    tests: ['test/monitors.test.ts'],
  },
  {
    name: 'the signature does not cover the idempotency key',
    edits: [
      { file: 'src/signature.ts', find: 'return `t=${t},v1=${await mac(secret, `${t}.${idempotencyKey}.${body}`)}`', replace: 'return `t=${t},v1=${await mac(secret, `${t}.${body}`)}`' },
      { file: 'src/signature.ts', find: 'const want = await mac(secret, `${t}.${idempotencyKey}.${body}`)', replace: 'const want = await mac(secret, `${t}.${body}`)' },
    ],
    tests: ['test/monitors.test.ts'],
  },
  {
    name: 'a retry is signed with the time of the first attempt (a replayable signature)',
    edits: one('src/notifier.ts', 'await signatureHeader(secret, now, row.idem_key, row.body)', 'await signatureHeader(secret, row.created_at, row.idem_key, row.body)'),
    tests: ['test/monitors.test.ts'],
  },

  // ───────────── caught by the independent readers (tools/promcheck, needs Go) ─────────────
  // `independent: true` runs `npm run independent` (the capture test, then Prometheus' own
  // code reading the captures) instead of vitest files.
  {
    name: 'Prometheus API times printed as JavaScript prints them (".000Z"), not as Go prints a time.Time',
    edits: one('src/http.ts', "  return rfc3339(ms).replace(/\\.?0+Z$/, 'Z')", '  return rfc3339(ms)'),
    independent: true,
  },
  {
    name: 'a field Prometheus does not have leaks into /api/v1/rules (the rule\'s cost class)',
    edits: one('src/http.ts', "          alerts: excludeAlerts ? null : promAlerts(snap),\n", "          alerts: excludeAlerts ? null : promAlerts(snap),\n          cost: r.cost.class,\n"),
    independent: true,
  },
  {
    name: 'a required group field left out of /api/v1/rules (limit)',
    edits: one('src/http.ts', 'out.push({ name: group.name, file, rules, interval: group.intervalMs / 1000, limit: group.limit, evaluationTime', 'out.push({ name: group.name, file, rules, interval: group.intervalMs / 1000, evaluationTime'),
    independent: true,
  },
  {
    name: 'an alert value printed as JavaScript prints a number, not as strconv.FormatFloat(v, \'e\', -1, 64)',
    edits: one('src/http.ts', '      out.value = promFloat(a.value)', '      out.value = String(a.value)'),
    independent: true,
  },
  {
    name: 'the rule-file export drops keep_firing_for',
    edits: one('src/rulefile.ts', '        if (r.keepFiringForMs > 0) rule.keep_firing_for = formatDuration(r.keepFiringForMs)\n', ''),
    independent: true,
  },
  // ───────────── versioned storage and formats (contracts/COMPATIBILITY.md) ─────────────
  {
    name: 'Ruler serves storage a newer release wrote (the refusal dropped from the RPC guard)',
    edits: one('src/ruler.ts', "    const refused = refusalOf(this.schema)\n    if (refused) return refused\n    return this.tenant !== ''", "    return this.tenant !== ''"),
    tests: ['test/compat.test.ts'],
  },
  {
    name: 'Notifier accepts hand-offs onto storage a newer release wrote (refusal dropped)',
    edits: one('src/notifier.ts', "    const refused = refusalOf(this.schema)\n    if (refused) return refused\n    return this.tenant !== ''", "    return this.tenant !== ''"),
    tests: ['test/compat.test.ts'],
  },
  {
    name: 'a refusing Ruler runs its tick from the alarm (and so drops the alarm the newer release needs)',
    // Pattern brought up to date (the stage deadline now sits between the refusal and the tick).
    edits: one('src/ruler.ts', "    if (refused) {\n      // Keep the alarm for the release that owns this storage; touch nothing else.\n      await this.ctx.storage.setAlarm(Date.now() + refused.retryAfterMs)\n      return\n    }\n    // A staged trial past its deadline", '    // A staged trial past its deadline'),
    tests: ['test/compat.test.ts'],
  },
  {
    name: 'RulerIndex serves storage a newer release wrote (guard removed)',
    edits: one('src/registry.ts', '    if (refused) throw new SchemaTooNewError(refused)\n', ''),
    tests: ['test/compat.test.ts'],
  },
  {
    name: 'the HTTP API passes a refusal through as if it were an answer (no 503)',
    edits: one('src/http.ts', "  if (r.status === 'schema_too_new') throw schemaTooNew((r as unknown as SchemaTooNew).retryAfterMs)\n", ''),
    tests: ['test/compat.test.ts'],
  },
  {
    name: 'a released migration edited in place (timeline loses WITHOUT ROWID)',
    edits: one('src/schema.ts', "CREATE TABLE IF NOT EXISTS timeline (tenant TEXT NOT NULL, monitor TEXT NOT NULL, body TEXT NOT NULL,\n  PRIMARY KEY (tenant, monitor)) WITHOUT ROWID;", 'CREATE TABLE IF NOT EXISTS timeline (tenant TEXT NOT NULL, monitor TEXT NOT NULL, body TEXT NOT NULL,\n  PRIMARY KEY (tenant, monitor));'),
    tests: ['test/compat.test.ts'],
  },
  {
    name: 'the idempotency key derivation changes without a format version (a receiver would process a retry twice)',
    edits: one('src/notifier.ts', 'const idem = hash64(seed) + hash64(`viz-notification\\n${seed}`)', 'const idem = hash64(`viz-notification\\n${seed}`) + hash64(seed)'),
    tests: ['test/golden.test.ts'],
  },
  {
    name: 'the hand-off to the notifier gains a field without a format version',
    edits: one('src/ruler.ts', "      expiresAt: heartbeat && status === 'firing'", "      severity: 'unset',\n      expiresAt: heartbeat && status === 'firing'"),
    tests: ['test/golden.test.ts'],
  },
  {
    name: 'the registry partition hash changes (a tenant\'s rulers move to another index object)',
    edits: one('src/registry.ts', 'hash64(`viz-ruler-index\\n${tenant}`)', 'hash64(`viz-ruler-index/2\\n${tenant}`)'),
    tests: ['test/golden.test.ts'],
  },

  // ───────────── anomaly rules (60–80) ─────────────
  {
    name: 'anomaly: series beyond max_series are dropped silently (the first max_series are scored) instead of refusing the evaluation',
    edits: one('src/anomaly.ts', '  if (series.length > spec.maxSeries) {\n', '  if (series.length > spec.maxSeries) series = series.slice(0, spec.maxSeries)\n  if (false) {\n'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: detector state is never written to SQLite (memory only)',
    // Pattern brought up to date (the rows are a planned write, `AnomalyWrite`, since store.anomaly-state v2).
    edits: one('src/ruler.ts', 'for (const { rule, anomaly } of staged) if (anomaly?.changed && anomaly.write) this.writeAnomalyState(g.spec.name, rule.key, anomaly.write)', 'void staged'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: the constructor does not rebuild detector state from SQLite',
    // Pattern brought up to date (store.anomaly-state v2 adds what is known of the rows, `rt.store`).
    edits: one('src/ruler.ts', '      rt.series = read.series\n      rt.json = read.json\n      rt.store = read.store\n      rt.status = { ...rt.status, stateSeries', '      rt.status = { ...rt.status, stateSeries'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: a replayed tick advances each detector again (per-series replay guard removed)',
    edits: one('src/anomaly.ts', 'if (before?.last && before.last.ts >= ts) {', 'if (false) {'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: state rows of a newer release are scored over (the rule starts cold) instead of refused',
    edits: one('src/anomaly.ts', 'if (prev.unreadable !== null) {', 'if (false) {'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: loading detector state does not name the tenant',
    edits: one('src/ruler.ts', 'FROM anomaly_state WHERE tenant = ? ORDER BY grp, rule_key, chunk', 'FROM anomaly_state WHERE ? IS NOT NULL ORDER BY grp, rule_key, chunk'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: the alert does not carry the detector\'s sentence',
    edits: one('src/anomaly.ts', '        annotations[ANOMALY_ANNOTATION] = e.text\n', ''),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: the severity label is not set from anomaly.severity (routing by severity breaks)',
    edits: one('src/rules.ts', 'const ruleLabels = { ...labels, severity: spec.severity }', 'const ruleLabels = { ...labels }'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: the ruler\'s evidence-based defaults dropped (the library\'s own: robust z with the MAD, EWMA 30 / 4, which scored 0.0 on NAB)',
    edits: one('src/anomaly.ts', '{ ...libraryDefaults(detector), ...guide.defaults }', '{ ...libraryDefaults(detector) }'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: severity page without a detector gets the non-paging default, not the static threshold',
    edits: one('src/anomaly.ts', "detector = givenSeverity === 'page' ? DEFAULT_PAGE_DETECTOR : DEFAULT_DETECTOR", 'detector = DEFAULT_DETECTOR'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: CUSUM may page',
    edits: one('src/anomaly.ts', "if (severity === 'page' && !guide.pageAllowed) {", 'if (false) {'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: no per-series state limit at run time',
    edits: one('src/anomaly.ts', 'if (bytes > limits.maxAnomalyStateBytesPerSeries) {', 'if (false) {'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: no per-object state budget at save',
    edits: one('src/ruler.ts', 'const budget = anomalyLimits(this.cfg).maxAnomalyStateBytesPerObject', 'const budget = Infinity'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: a row per series (state rows of one byte, so every series gets its own)',
    // Pattern brought up to date (version 1 rows are planned in anomaly.ts since store.anomaly-state v2).
    edits: one('src/anomaly.ts', 'function planV1(json: Map<string, string>, prev: StoreMeta): AnomalyWrite {\n  const rows = stateRows(json)', 'function planV1(json: Map<string, string>, prev: StoreMeta): AnomalyWrite {\n  const rows = stateRows(json, 1)'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: state carried over an interval change (the detector\'s step changed)',
    // Pattern brought up to date (the interval comparison became `sameStep`, shared with the SLO rings).
    edits: one('src/ruler.ts', '            if (kept.has(key) && sameStep) g.anomaly.set(key, rt)', '            if (kept.has(key)) g.anomaly.set(key, rt)'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: the rule key leaves out the detector and parameters (state carried into another detector)',
    edits: one('src/anomaly.ts', "return `${expr}\\u0000${spec.detector}\\u0000${JSON.stringify(params)}`", 'return expr'),
    tests: ['test/anomaly.test.ts', 'test/golden.test.ts'],
  },
  {
    name: 'anomaly: a missing (NaN) point clears the series\' flag (a gap treated as a recovery)',
    edits: one('src/anomaly.ts', "{ ...before.last, ts, status: 'missing' }", "{ ...before.last, ts, status: 'missing', flag: false }"),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: migration 2 declared breaking (readableFrom 2: the previous release is no longer a rollback target)',
    edits: one('src/schema.ts', "      name: 'anomaly rules: per-(rule, chunk) detector state',\n      readableFrom: 1,", "      name: 'anomaly rules: per-(rule, chunk) detector state',\n      readableFrom: 2,"),
    tests: ['test/compat.test.ts'],
  },
  {
    name: 'anomaly, through the monitors API: write without scope (as mutant 29)',
    edits: one('src/http.ts', 'const principal = await authenticate(req, env.CONFIG, def.scope as never)', "const principal = await authenticate(req, env.CONFIG, (def.method === 'GET' ? def.scope : 'monitors:read') as never)"),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly, through the monitors API: tenant from the query string (as mutant 31)',
    edits: one('src/http.ts', 'new Call(req, env, principal.tenant,', "new Call(req, env, url.searchParams.get('tenant') ?? principal.tenant,"),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly, through the monitors API: tenant from a header (as mutant 32)',
    edits: one('src/http.ts', 'new Call(req, env, principal.tenant,', "new Call(req, env, req.headers.get('X-Scope-OrgID') ?? principal.tenant,"),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'anomaly: a stored rule naming a detector this release does not know is run anyway',
    edits: one('src/anomaly.ts', 'if (!(ANOMALY_DETECTORS as readonly string[]).includes(spec.detector)) {', 'if (false) {'),
    tests: ['test/anomaly.test.ts'],
  },

  // ───────────── production wiring (82–93): query and ingest over HTTP with a service key, control's destination ─────────────
  {
    name: 'wiring, tenant isolation: one service credential shared by every Ruler object of the isolate (tenant B evaluates with tenant A\'s key)',
    edits: [
      { file: 'src/ruler.ts', find: 'const ABORT_GRACE_MS = 25\n', replace: 'const ABORT_GRACE_MS = 25\nlet sharedCredential: ServiceCredential | null = null\n' },
      { file: 'src/ruler.ts', find: 'this.credentialRt ??= new ServiceCredential({', replace: 'this.credentialRt = sharedCredential ??= new ServiceCredential({' },
    ],
    tests: ['test/wiring.test.ts'],
  },
  {
    name: 'wiring, tenant isolation: the notifier keeps one control destination for the isolate (tenant B\'s alerts go to tenant A\'s webhook)',
    edits: [
      { file: 'src/notifier.ts', find: 'export const CONTROL_REFRESH_MS = 60_000\n', replace: 'export const CONTROL_REFRESH_MS = 60_000\nlet lastTarget: NotificationTargetResult | null = null\n' },
      { file: 'src/notifier.ts', find: '      r = await this.controlTarget()\n', replace: '      r = lastTarget ??= await this.controlTarget()\n' },
    ],
    tests: ['test/wiring.test.ts'],
  },
  {
    name: 'wiring, no secret in bodies: the plain JSON body carries the receiver URL (as externalURL)',
    edits: one('src/notifier.ts', ": d.integration.format === 'json' ? jsonPayload(group, alerts, idem, cap)", ": d.integration.format === 'json' ? jsonPayload({ ...group, externalUrl: d.integration.url }, alerts, idem, cap)"),
    tests: ['test/wiring.test.ts'],
  },
  {
    name: 'wiring, no secret in what is stored and shown: a delivery error keeps the URL it quotes',
    edits: one('src/notifier.ts', ".replace(/[a-z][a-z0-9+.-]*:\\/\\/[^\\s\"'<>]*/gi, '<url>')", ''),
    tests: ['test/wiring.test.ts'],
  },
  {
    name: 'wiring, no secret in logs: each delivery is logged with its URL',
    edits: one('src/notifier.ts', '        const res = await this.fetcher()(row.url, {', "        console.log('notifier: delivering', row.receiver, row.integration, row.url)\n        const res = await this.fetcher()(row.url, {"),
    tests: ['test/wiring.test.ts'],
  },
  {
    name: 'wiring, no secret in logs: the service key is logged when issued',
    edits: one('src/credential.ts', "      case 'ok':\n", "      case 'ok':\n        console.info('ruler: service key issued', r.name, r.key)\n"),
    tests: ['test/wiring.test.ts'],
  },
  {
    name: 'wiring, retries: the JSON body is rebuilt for each attempt (an attempt counter in it), so a retry is not the same notification',
    edits: one('src/notifier.ts', '          body: row.body,\n', "          body: row.body.replace('{\"version\"', `{\"attempt\":${row.attempts},\"version\"`),\n"),
    tests: ['test/wiring.test.ts'],
  },
  {
    name: 'wiring, retries: the JSON body names another key than the Idempotency-Key header',
    edits: one('src/notifier.ts', "jsonPayload(group, alerts, idem, cap)", "jsonPayload(group, alerts, hash64(`${idem}#body`), cap)"),
    tests: ['test/wiring.test.ts', 'test/golden.test.ts'],
  },
  {
    name: 'wiring, six connections: four engine calls in flight per Ruler object',
    edits: one('src/engine.ts', 'export const ENGINE_CALLS_IN_FLIGHT = 1', 'export const ENGINE_CALLS_IN_FLIGHT = 4'),
    tests: ['test/wiring.test.ts'],
  },
  {
    name: 'wiring, six connections: a gate per evaluator instead of one per object',
    edits: one('src/ruler.ts', 'return q ? httpEngine(q, this.credential(), this.engineGate) : null', 'return q ? httpEngine(q, this.credential(), new Gate(ENGINE_CALLS_IN_FLIGHT)) : null'),
    tests: ['test/wiring.test.ts'],
  },
  {
    name: 'wiring, credential: a refused key is replaced at once (a rotation, and an audit entry, per 401 while KV propagates)',
    edits: one('src/credential.ts', 'now - stored.issuedAt >= PROPAGATION_GRACE_MS', 'now - stored.issuedAt >= 0'),
    tests: ['test/wiring.test.ts'],
  },
  {
    name: 'wiring, control destination: a tenant config may define viz:default itself (shadowing the control plane\'s destination)',
    edits: one('src/amconfig.ts', '      if (r.name === CONTROL_RECEIVER) return c.err(', '      if (r.name === CONTROL_RECEIVER && false) return c.err('),
    tests: ['test/wiring.test.ts'],
  },

  // ───────────── SLO burn-rate rules, warm-up, backtests (contract version 4) ─────────────
  {
    name: 'SLO thresholds: a burn rate equal to the threshold counts as burning (`>=` in the scratch copy of anomaly/\'s evaluateWindows, which the rule calls)',
    edits: one('../anomaly/src/detectors/burnrate.ts', 'longBurn > rule.burnRate && shortBurn > rule.burnRate', 'longBurn >= rule.burnRate && shortBurn >= rule.burnRate'),
    tests: ['test/slo.test.ts'],
  },
  {
    name: 'SLO thresholds: the short window is ignored (both windows of an alert read the long one)',
    edits: one('src/slo.ts', '      const w = Math.max(1, Math.round(ms / intervalMs))', '      const w = Math.max(1, Math.round(a.longMs / intervalMs))'),
    tests: ['test/slo.test.ts'],
  },
  {
    name: 'SLO thresholds: min_coverage ignored (a window counts whatever share of its buckets has data)',
    edits: one('src/slo.ts', '      if (coverage >= spec.minCoverage) agg.set(ms', '      if (true) agg.set(ms'),
    tests: ['test/slo.test.ts'],
  },
  {
    name: 'SLO thresholds: the default alerts lose the 6 h / 30 m page (three of the workbook\'s four)',
    edits: one('src/slo.ts', 'SRE_WORKBOOK_RULES.map((r) => ({ severity: r.severity', 'SRE_WORKBOOK_RULES.filter((r) => r.longMs !== 6 * 3_600_000).map((r) => ({ severity: r.severity'),
    tests: ['test/slo.test.ts'],
  },
  {
    name: 'SLO windows: the current bucket is left out of every window (sums start one bucket back)',
    edits: one('src/slo.ts', '    let q = s\n', '    let q = s - 1\n'),
    tests: ['test/slo.test.ts'],
  },
  {
    name: 'SLO windows: a block\'s cached sums are not invalidated when one of its buckets is set',
    edits: one('src/slo.ts', '    this.bad[i] = b\n    this.tot[i] = t\n    this.cOk[Math.floor(i / this.block)] = 0\n', '    this.bad[i] = b\n    this.tot[i] = t\n'),
    tests: ['test/slo.test.ts'],
  },
  {
    name: 'SLO state: the rings are not rebuilt from SQLite when the object is constructed',
    edits: one('src/ruler.ts', '      this.adoptSloRows(g, rule, rows)\n', '      void rows\n'),
    tests: ['test/slo.test.ts'],
  },
  {
    name: 'SLO state: a replayed tick advances the rings again (replay guard off by one)',
    edits: one('src/slo.ts', '  if (rt.lastTs !== null && ts <= rt.lastTs) {', '  if (rt.lastTs !== null && ts < rt.lastTs) {'),
    tests: ['test/slo.test.ts'],
  },
  {
    name: 'tenant isolation: SLO state is loaded without the tenant in the WHERE clause',
    edits: one('src/ruler.ts', 'FROM slo_state WHERE tenant = ? ORDER BY grp, rule_key, part, block', 'FROM slo_state WHERE (tenant = ? OR 1 = 1) ORDER BY grp, rule_key, part, block'),
    tests: ['test/slo.test.ts'],
  },
  {
    name: 'tenant isolation: deleting a group deletes its SLO state without naming the tenant',
    edits: one('src/ruler.ts',
      '      this.exec(`DELETE FROM slo_state WHERE tenant = ? AND grp = ?`, this.tenant, name)\n      this.exec(`DELETE FROM warmup WHERE tenant = ? AND grp = ?`, this.tenant, name)\n      for (const [key, alerts] of g.alerts)',
      '      this.exec(`DELETE FROM slo_state WHERE (tenant = ? OR 1 = 1) AND grp = ?`, this.tenant, name)\n      this.exec(`DELETE FROM warmup WHERE tenant = ? AND grp = ?`, this.tenant, name)\n      for (const [key, alerts] of g.alerts)'),
    tests: ['test/slo.test.ts'],
  },
  {
    name: 'warm-up budget: the planned cost is never compared with the budget (fetched whatever the plan says)',
    // Pattern brought up to date (the plans are summed and checked twice, before anything is fetched and before the windows).
    edits: one('src/history.ts', '  const over = (p: PlanSum) => p.scanSamples > budget.scanSamples || p.bytesToRead > budget.bytesToRead', '  const over = (_p: PlanSum) => false'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'warm-up budget: the budget is checked only after the fetch (an over-budget read is made, then refused)',
    edits: [
      { file: 'src/history.ts', find: '  const over = (p: PlanSum) => p.scanSamples > budget.scanSamples || p.bytesToRead > budget.bytesToRead', replace: '  const over = (_p: PlanSum) => false' },
      // Pattern brought up to date (history is read in windows by `streamHistory`).
      { file: 'src/history.ts', find: '  return { ok: true, plan: total, sizing, points, cpu:', replace: "  if (total.scanSamples > budget.scanSamples || total.bytesToRead > budget.bytesToRead) return { ok: false, refused: 'over budget (after the fetch)', plan: total, sizing }\n  return { ok: true, plan: total, sizing, points, cpu:" },
    ],
    tests: ['test/history.test.ts'],
  },
  {
    name: 'warm-up budget: a read the engine\'s plan refuses is made anyway',
    edits: one('src/history.ts', '      if (p.refusal) return', '      if (p.refusal && false) return'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'warm-up budget: warm-ups are held to the (larger) backtest budget',
    edits: one('src/ruler.ts', '    const budget = budgets.warmup\n', '    const budget = budgets.backtest\n'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'warm-up: the state is written outside the warm-up\'s transaction (a crash leaves it half-written)',
    // Pattern brought up to date (the warm-up's rows are a planned write since store.anomaly-state v2).
    edits: one('src/ruler.ts', '        finish(done, () => this.writeAnomalyState(g.spec.name, rule.key, write))', '        this.writeAnomalyState(g.spec.name, rule.key, write)\n        finish(done)'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'warm-up: a finished warm-up is not recorded (it is read again after an eviction)',
    edits: one('src/ruler.ts', '          write?.()\n          this.putWarmup(g.spec.name, rule.key, w)', "          write?.()\n          if (w.status !== 'done') this.putWarmup(g.spec.name, rule.key, w)"),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'backtest/live: an anomaly backtest starts cold (no warm-up before fromMs)',
    edits: one('src/ruler.ts', 'run = await backtestAnomaly(parsedRule, warmFromMs, ', 'run = await backtestAnomaly(parsedRule, fromMs, '),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'backtest/live: an SLO backtest leaves out the coarse history (the budget from the fine read only)',
    edits: one('src/ruler.ts', 'run = await backtestSlo(parsedRule, { ...w.fine, toMs }, w.coarse, input, io)', 'run = await backtestSlo(parsedRule, { ...w.fine, toMs }, null, input, io)'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'backtest/live: an SLO backtest feeds each step the previous step\'s buckets',
    edits: [
      { file: 'src/history.ts', find: "  let warmPoints = 0\n  const onFine: Stream['feed'] = (ts, series, c) => {\n", replace: "  let warmPoints = 0\n  let prevFine = []\n  const onFine: Stream['feed'] = (ts, series, c) => {\n    const cur = series\n    series = prevFine\n    prevFine = cur\n" },
    ],
    tests: ['test/history.test.ts'],
  },
  {
    name: 'backtest/live: an interval\'s annotations are taken at its end, not when the alert entered the state',
    edits: one('src/backtest.ts', '      if (cur && cur.state === state) continue', '      if (cur && cur.state === state) {\n        cur.annotations = a!.annotations\n        continue\n      }'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'tenant isolation: the backtest-by-id route looks the monitor up for a tenant named in the query string',
    edits: one('src/http.ts', 'async function backtestMonitor(c: Call): Promise<Response> {\n  const f = await findMonitor(c)', "async function backtestMonitor(c: Call): Promise<Response> {\n  const named = c.url.searchParams.get('tenant')\n  const f = await findMonitor(named ? (Object.assign(Object.create(Object.getPrototypeOf(c)), c, { tenant: named }) as Call) : c)"),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'compatibility: a save warms a kept rule over state rows a newer release wrote (both guards removed: at the job and at the warm-up)',
    edits: [
      { file: 'src/ruler.ts', find: 'return rt !== undefined && (rt.lastTs !== null || rt.rawRows !== null)', replace: 'return rt !== undefined && rt.lastTs !== null' },
      { file: 'src/ruler.ts', find: '      if (unreadable) {\n', replace: '      if (unreadable && false) {\n' },
    ],
    tests: ['test/slo.test.ts'],
  },

  // ───────────── streaming history in memory-sized windows ─────────────
  {
    name: 'window boundary: each window starts a step late (a step between windows is never read)',
    edits: one('src/history.ts', '  for (let from = r.fromMs; from <= r.toMs; from += steps * r.stepMs) {', '  for (let from = r.fromMs; from <= r.toMs; from += (steps + 1) * r.stepMs) {'),
    tests: ['test/history.test.ts', 'test/backtest.test.ts'],
  },
  {
    name: 'window boundary: windows overlap by a step (the step at each boundary is read twice)',
    edits: one('src/history.ts', '    out.push({ ...r, fromMs: from, toMs: Math.min(r.toMs, from + (steps - 1) * r.stepMs) })', '    out.push({ ...r, fromMs: from, toMs: Math.min(r.toMs, from + steps * r.stepMs) })'),
    tests: ['test/history.test.ts', 'test/backtest.test.ts'],
  },
  {
    name: 'window boundary: the last step of every window is not fed to the rule',
    edits: one('src/history.ts', '      for (let ts = w.fromMs; ts <= w.toMs; ts += w.stepMs) {', '      for (let ts = w.fromMs; ts < w.toMs; ts += w.stepMs) {'),
    tests: ['test/history.test.ts', 'test/backtest.test.ts'],
  },
  {
    name: 'memory refusal: the rule\'s state is left out of the window sizing (windows sized as if the state cost nothing)',
    edits: one('src/history.ts', 'Math.floor((budgetBytes - fixedBytes) / perStep)', 'Math.floor(budgetBytes / perStep)'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'memory refusal: windows sized without the series count (one point a step)',
    edits: one('src/history.ts', '    const perStep = boundOf(s) * MEMORY.perPoint', '    const perStep = (1 + (s.companions ?? []).length) * MEMORY.perPoint'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'memory refusal: an SLO backtest\'s model leaves out its bucket rings',
    edits: one('src/history.ts', '  const fixed = backtestFixed(2 * rule.slo.maxSeries) + sloStateBytes(rule, I)', '  const fixed = backtestFixed(2 * rule.slo.maxSeries)'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'memory refusal: a window holding more points than it was sized for is evaluated anyway',
    edits: one('src/history.ts', '      } else if (held > stepsOf(w) * boundOf(s)) {', '      } else if (false) {'),
    tests: ['test/history.test.ts'],
  },
  // ───────────── CPU: refused on the model's projection, never cut off ─────────────
  {
    name: 'CPU refusal: the projection is never checked (a run goes on whatever it would cost)',
    edits: one('src/history.ts', '  if (projected > budgetUs) {', '  if (false) {'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'CPU refusal: the projection leaves out the windows\' points (their allowances only)',
    edits: one('src/history.ts', '      projected += n * Math.max(', '      projected += 0 * Math.max('),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'CPU refusal: a window not counted is priced at no points, not at the rule\'s bound',
    edits: one('src/history.ts', '      const n = w.points ?? stepsOf(w.read) * boundOf(streams[i]!)', '      const n = w.points ?? 0'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'CPU model: an SLO backtest\'s evaluated points priced as warm-up points',
    edits: one('src/history.ts', 'const evaluated = evaluatedFromMs === undefined ? {}', 'const evaluated = true ? {}'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'per-alarm warm-up CPU: a warm-up\'s reservation is not taken from what the alarm has left',
    edits: one('src/ruler.ts', '      this.warmupCpuLeftMs -= room\n', ''),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'per-alarm warm-up CPU: spent is subtracted after the run, not reserved before it (concurrent groups both read)',
    edits: [
      { file: 'src/ruler.ts', find: '      this.warmupCpuLeftMs -= room\n', replace: '' },
      { file: 'src/ruler.ts', find: '        this.warmupCpuLeftMs += room - Math.min(room, used)', replace: '        this.warmupCpuLeftMs -= Math.min(room, used)' },
    ],
    tests: ['test/history.test.ts'],
  },
  {
    name: 'per-alarm warm-up CPU: a warm-up that fits a warm-up\'s budget but not the alarm\'s rest is refused, not deferred',
    edits: one('src/ruler.ts', "      if (!run.ok && 'refused' in run && run.defer) {", '      if (false) {'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'per-alarm warm-up CPU: a budget below the model\'s base defers every warm-up forever',
    edits: one('src/ruler.ts', '      if (room < budgets.warmupCpuMs && room < CPU.base / 1000) {', '      if (room < CPU.base / 1000) {'),
    tests: ['test/history.test.ts'],
  },

  // ───────────── recorded samples through viz-ingest's RecordedSamples entrypoint (D45, D52) ─────────────
  {
    name: 'entrypoint, tenant: the tenant argument is dropped (the batches are passed first)',
    edits: one('src/recorded.ts', 'await binding.write(tenant, batches)', 'await (binding as any).write(batches)'),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, tenant: one tenant per isolate (the first Ruler object\'s tenant is passed for every object)',
    edits: [
      { file: 'src/recorded.ts', find: 'export function recordedSamplesSink(', replace: 'let firstTenant: string | null = null\nexport function recordedSamplesSink(' },
      { file: 'src/recorded.ts', find: 'await binding.write(tenant, batches)', replace: 'await binding.write((firstTenant ??= tenant), batches)' },
    ],
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, acknowledgement: the sink returns before the RPC resolves (its result is not awaited)',
    edits: one('src/recorded.ts', 'await binding.write(tenant, batches)', 'void binding.write(tenant, batches).catch(() => {})'),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, acknowledgement: the tick does not wait for the sink (the next batch is evaluated before the samples are written)',
    edits: one('src/ruler.ts', 'await Promise.race([this.sink().write(batch.map((p) => p.batch)), timeout])', 'void this.sink().write(batch.map((p) => p.batch)).catch(() => {})'),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, refusals: every refusal is retryable (unauthorized, invalid, series_limit retried)',
    edits: one('src/recorded.ts', 'RECORDED_SAMPLES_RETRYABLE.includes(refusal)', 'true'),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, refusals: the tick retries a refusal the sink says is permanent',
    edits: one('src/ruler.ts', '          if (e instanceof SinkError && !e.retryable) break\n', ''),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, refusals: overload and backpressure are not retried (only unavailable is)',
    edits: one('src/recorded.ts', 'RECORDED_SAMPLES_RETRYABLE.includes(refusal)', "refusal === 'unavailable'"),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, refusals: an overloaded ingest is retried at once (the hint is ignored)',
    edits: one('src/recorded.ts', ', retryHintMs(message))', ', 0)'),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, refusals: too_large is not split (reported like invalid)',
    edits: one('src/recorded.ts', "if (refusal === 'too_large' && batches.length > 1) {", 'if (false) {'),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, refusals: a split stops at the first half that fails (the batches after it are not sent)',
    edits: one('src/recorded.ts', 'first ??= e', 'throw e'),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, fallback: every rejection, refusals included, goes to Remote Write',
    edits: one('src/recorded.ts', 'if (refusal === null) {', 'if (refusal === null || fallback) {'),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, fallback: none (an ingest release without the entrypoint loses the samples of a rollback window)',
    edits: one('src/recorded.ts', 'if (!fallback) throw', 'if (true) throw'),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, fallback: Remote Write whenever INGEST is bound (the entrypoint is never used)',
    edits: one('src/ruler.ts', 'if (binding) return recordedSamplesSink(binding, this.tenant, remote)', 'if (binding && !remote) return recordedSamplesSink(binding, this.tenant, remote)'),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, duplicates: a replayed tick names its batches by wall-clock time (not the same batch again)',
    edits: one('src/ruler.ts', 'batch: { id: `${this.tenant}/${this.shard}/${g.spec.name}/${rule.key}@${ts}`', 'batch: { id: `${this.tenant}/${this.shard}/${g.spec.name}/${rule.key}@${ts}#${Date.now()}`'),
    tests: ['test/recorded.test.ts'],
  },
  {
    name: 'entrypoint, health: /healthz does not count a missing sink',
    edits: one('src/index.ts', "  if (!env.SINK && !env.INGEST) missing.push('SINK')\n", ''),
    tests: ['test/wiring.test.ts'],
  },
  // ───────────── anomaly defaults (D33 replaced, 2026-11-19): robust z with the quantile spread ─────────────
  {
    name: 'default (D33): flipped back to EWMA',
    edits: one('src/anomaly.ts', "export const DEFAULT_DETECTOR: AnomalyDetector = 'robust_z'", "export const DEFAULT_DETECTOR: AnomalyDetector = 'ewma'"),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'default (D33): robust z without a spread defaults to the MAD',
    edits: one('src/anomaly.ts', "export const ROBUST_Z_DEFAULTS = { windowPoints: 1500, k: 2, spread: 'quantile',", "export const ROBUST_Z_DEFAULTS = { windowPoints: 1500, k: 2, spread: 'mad',"),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'default (D33): seasonal without a spread defaults to the MAD',
    edits: one('src/anomaly.ts', "export const SEASONAL_DEFAULTS = { seasons: 1, k: 2, adapt: 'robust', spread: 'quantile',", "export const SEASONAL_DEFAULTS = { seasons: 1, k: 2, adapt: 'robust', spread: 'mad',"),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'upgrade: a stored rule that named no detector is resolved at evaluation (today\'s default runs instead of the stored EWMA)',
    edits: one('src/anomaly.ts', 'const det = DETECTORS[spec.detector] as unknown as { detect(', 'const det = DETECTORS[spec.given.length === 0 ? DEFAULT_DETECTOR : spec.detector] as unknown as { detect('),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'upgrade: today\'s defaults merged over the stored parameters at evaluation (a stored MAD rule runs the quantile spread)',
    edits: one('src/anomaly.ts', 'const params = { ...spec.params, stepMs: intervalMs, unit: spec.unit }', 'const params = { ...spec.params, ...(DETECTOR_GUIDE[spec.detector]?.defaults ?? {}), stepMs: intervalMs, unit: spec.unit }'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'upgrade: a rule saved again takes today\'s defaults (the stored rule is not consulted)',
    edits: one('src/ruler.ts', 'parseRuleFile(file, this.cfg, (group) => this.groups.get(group)?.spec.anomalyRules)', 'parseRuleFile(file, this.cfg)'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'upgrade: a rule saved again keeps the stored detector but takes today\'s parameter defaults',
    edits: one('src/anomaly.ts', 'for (const [k, old] of Object.entries(PREVIOUS_DEFAULTS.params[detector] ?? {})) {', 'for (const [k, old] of Object.entries({} as Record<string, AnomalyParamValue>)) {'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'upgrade: a monitor saved again is matched by name, not by its id (renamed, it takes today\'s default)',
    edits: one('src/rules.ts', 'if (monitorId !== null) return stored.find((r) => r.monitor?.id === monitorId) ?? null', 'if (monitorId === null && false) return null'),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'default window: 1,781 points (the save-time estimate\'s edge, 36 bytes a point) instead of 1,500',
    edits: one('src/anomaly.ts', "export const ROBUST_Z_DEFAULTS = { windowPoints: 1500,", "export const ROBUST_Z_DEFAULTS = { windowPoints: 1781,"),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'evidence: the default window\'s SMD score labelled confirmed (it is post hoc: only 4,000 was frozen)',
    edits: one('src/anomaly.ts', "{ kind: 'post_hoc', data: 'SMD', config: 'quantile spread, window 1,500, k 2 (this default)'", "{ kind: 'confirmed', data: 'SMD', config: 'quantile spread, window 1,500, k 2 (this default)'"),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'the 4,000-point configuration: refused without saying what it is',
    edits: one('src/anomaly.ts', "(confirmed ? `. This is the configuration frozen on NAB and confirmed on SMD", "(false ? `. This is the configuration frozen on NAB and confirmed on SMD"),
    tests: ['test/anomaly.test.ts'],
  },
  {
    name: 'PREVIOUS_DEFAULTS: robust z\'s earlier k wrong (3 instead of 3.5)',
    edits: one('src/anomaly.ts', "robust_z: { spread: 'mad', windowPoints: 288, k: 3.5 },", "robust_z: { spread: 'mad', windowPoints: 288, k: 3 },"),
    tests: ['test/anomaly.test.ts'],
  },
  // ───────────── PR #3's last fix, ported (were 131–141 on main; 158–168 here) ─────────────
  // planning what is fetched: counts, windows by points, every window planned
  {
    name: 'window plans: the run is checked against the whole read and the counts only, not the windows as fetched (the finding: each window re-reads its look-back and files)',
    edits: one('src/history.ts', '  if (over(total)) {', '  if (over(first)) {'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'window plans: a group\'s plan counted once, not for every window in it',
    edits: one('src/history.ts', '      add(total, main, group.length)', '      add(total, main)'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'window plans: a group\'s plan spans its first window only',
    edits: one('src/history.ts', 'toMs: group.at(-1)!.read.toMs }', 'toMs: group[0]!.read.toMs }'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'counting: no read is counted (windows are the engine\'s pieces, sized by nothing)',
    edits: one('src/history.ts', '  const counted = streams.map((s, i) => bound.windowSteps[i]! < Math.min(MAX_STEPS_PER_QUERY, stepsOf(s.read)))', '  const counted = streams.map(() => false)'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'counting: counted windows cut at the rule\'s bound, not by the points counted (hundreds of windows again)',
    edits: one('src/history.ts', '(pts + n > pointsPerWindow ||', '((ts - from) / s.read.stepMs >= bound.windowSteps[i]! ||'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'counting: a count above the rule\'s bound accepted (windows cut for more series than the rule allows)',
    edits: one('src/history.ts', '          if (n > bounds[j]!) return', '          if (n > bounds[j]! && false) return'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'counting: a window holding more points than its count said evaluated anyway',
    edits: one('src/history.ts', '        if (held > Math.ceil(win.points * 1.1) + stepsOf(w)) return', '        if (held > Math.ceil(win.points * 1.1) + stepsOf(w) && false) return'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'window boundary (counted windows): a step skipped at every boundary',
    edits: one('src/history.ts', '        close(ts - s.read.stepMs)\n        from = ts\n', '        close(ts - 2 * s.read.stepMs)\n        from = ts\n'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'window boundary (counted windows): windows overlap by a step',
    edits: one('src/history.ts', '        close(ts - s.read.stepMs)\n        from = ts\n', '        close(ts - s.read.stepMs)\n        from = ts - s.read.stepMs\n'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'SLO state: a series first evaluated at query time 0 treated as never evaluated',
    edits: one('src/slo.ts', '    const fresh = s.seenAt === null', '    const fresh = s.seenAt === null || s.seenAt === 0'),
    tests: ['test/slo.test.ts'],
  },
  {
    name: 'SLO validation: a severity label from the group\'s labels reported at the rule',
    edits: one('src/rules.ts', 'ownSeverity ? `${rp}.labels.severity` : `${gp}.labels.severity`', '`${rp}.labels.severity`'),
    tests: ['test/slo.test.ts'],
  },
  // ───────────── over_budget names its budget (`exceeded`, contract version 5) ─────────────
  {
    name: 'exceeded: a plan over in samples named bytes (the plan\'s two budgets confused)',
    edits: one('src/history.ts', "    exceeded: p.scanSamples > budget.scanSamples ? 'scan_samples' : 'bytes',", "    exceeded: 'bytes',"),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'exceeded: more than 1,000 range queries named memory',
    edits: one('src/history.ts', "exceeded: 'queries', plan: null,", "exceeded: 'memory', plan: null,"),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'exceeded: the HTTP answer leaves it out (null whatever the run said)',
    edits: one('src/http.ts', "exceeded: r.exceeded ?? null,", 'exceeded: null,'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'exceeded: a refused warm-up does not say which budget',
    edits: one('src/ruler.ts', "plan: run.plan, exceeded: run.exceeded, message:", 'plan: run.plan, message:'),
    tests: ['test/history.test.ts'],
  },
  {
    name: 'the queries refusal says nothing was fetched though the series counts were read',
    edits: one('src/history.ts', ", ...(counted.some((x) => x) ? { countsRead: true } : {}) }", ' }'),
    tests: ['test/history.test.ts'],
  },
  // ───────────── windowed detector state as Float64 ring blocks (store.anomaly-state v2, D60) ─────────────
  {
    name: 'ring blocks: values stored at the wrong float width (Float32 precision)',
    edits: one('src/anomalystore.ts', 'view.setFloat64(i * 8, v === 0 ? 0 : v, true)', 'view.setFloat64(i * 8, v === 0 ? 0 : Math.fround(v), true)'),
    tests: ['test/anomalystore.test.ts'],
  },
  {
    name: 'ring blocks: the block boundary off by one (a block\'s last slot taken for the next block\'s)',
    edits: one('src/anomalystore.ts', 'const blockOf = (slot: number, B: number) => Math.floor(slot / B)', 'const blockOf = (slot: number, B: number) => Math.floor((slot + 1) / B)'),
    tests: ['test/anomalystore.test.ts'],
  },
  {
    name: 'ring blocks: every block written at every tick (not only the head and the current block)',
    edits: one('src/anomalystore.ts', '      if (dirty.has(b)) continue\n', '      dirty.add(b)\n      if (dirty.has(b)) continue\n'),
    tests: ['test/anomalystore.test.ts'],
  },
  {
    name: 'ring blocks: the reader keeps points the window evicted since their block was written',
    edits: one('src/anomalystore.ts', 'if (ti <= after || (lastTs !== null && ti > lastTs)) continue', 'if (lastTs !== null && ti > lastTs) continue'),
    tests: ['test/anomalystore.test.ts'],
  },
  {
    name: 'ring blocks: a block is rewritten only for a pruned series (one series gone quiet keeps every other series\' old entries)',
    edits: one('src/anomalystore.ts', '        if (!l || l.lo === null || blockOf(l.lo, B) > b) {\n          dirty.add(b)', '        if (!l) {\n          dirty.add(b)'),
    tests: ['test/anomalystore.test.ts'],
  },
  {
    name: 'version gate ignored: version 2 written whatever the gate says',
    edits: one('src/anomaly.ts', '  const v2 = writeVersion === 2 && WINDOWED.has(spec.detector)', '  const v2 = WINDOWED.has(spec.detector)'),
    tests: ['test/anomalystore.test.ts'],
  },
  {
    name: 'conversion: version 1 rows left beside version 2 ones (not deleted when the format changes)',
    edits: one('src/anomalystore.ts', '  const purge = full || prev.version !== 2 || prev.rewrite', '  const purge = full || prev.rewrite'),
    tests: ['test/anomalystore.test.ts'],
  },
  {
    name: 'rows renumbered by a release without version 2 are not rewritten under their own chunks',
    edits: [
      { file: 'src/anomalystore.ts', find: '      if (chunk !== HEAD_CHUNK + (body.i as number)) store.rewrite = true', replace: '      if (false) store.rewrite = true' },
      { file: 'src/anomalystore.ts', find: '      if (chunk !== body.b) store.rewrite = true', replace: '      if (false) store.rewrite = true' },
    ],
    tests: ['test/anomalystore.test.ts'],
  },
  {
    name: 'CPU model: robust z priced by its stored (ring block) size, not by the points it scans',
    edits: one('src/history.ts', '  const bytes = cpuStateBytes(rule, intervalMs)', '  const bytes = rule.anomaly.stateBytesPerSeries'),
    tests: ['test/anomalystore.test.ts'],
  },
  {
    name: 'save-time estimate: the blocks a window spans counted one short',
    edits: one('src/anomaly.ts', 'const blocksSpanned = (slots: number) => Math.ceil(Math.max(0, slots - 1) / ANOMALY_BLOCK) + 1', 'const blocksSpanned = (slots: number) => Math.ceil(slots / ANOMALY_BLOCK)'),
    tests: ['test/anomaly.test.ts', 'test/anomalystore.test.ts'],
  },
  {
    name: 'readers first broken: this release writes version 2 while gated off (the gate shipped on)',
    edits: one('src/schema.ts', 'export const ANOMALY_STATE_WRITE: 1 | 2 = 1', 'export const ANOMALY_STATE_WRITE: 1 | 2 = 2'),
    tests: ['test/anomalystore.test.ts'],
  },
  {
    name: 'readers first broken: gated off, this release cannot read version 2 (the next release\'s rows refused after a rollback)',
    edits: one('src/anomaly.ts', '    if (v !== ANOMALY_STATE_VERSION && v !== 2) return', '    if (v !== ANOMALY_STATE_VERSION) return'),
    tests: ['test/anomalystore.test.ts'],
  },
]

const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0

/**
 * A throw-away copy of the component and of what it imports from its siblings, at the same
 * relative paths; node_modules is linked (read only). Mutants are applied here and only here.
 */
function makeCopy() {
  const base = process.env.VIZ_SCRATCH ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'ruler-mutants-'))
  // control/src and dashboard/src: the tests bind control's real Tenant object (test/harness.ts), which imports the dashboard package.
  for (const d of ['contracts', 'edge/src', 'anomaly/src', 'control/src', 'control/openapi.json', 'dashboard/src']) cpSync(join(repo, d), join(dir, d), { recursive: true })
  const skip = new Set(['node_modules', '.capture', '.wrangler'].map((d) => join(source, d)))
  cpSync(source, join(dir, 'ruler'), { recursive: true, filter: (p) => ![...skip].some((s) => p === s || p.startsWith(`${s}/`)) })
  symlinkSync(join(source, 'node_modules'), join(dir, 'ruler', 'node_modules'), 'dir')
  return dir
}
const copy = process.argv.includes('--list') ? null : makeCopy()
/** Where the tests run: the copy. */
const root = copy ? join(copy, 'ruler') : source

/** `npm run independent`: killed when a Go check fails (or the capture itself fails). */
function runIndependent() {
  const r = spawnSync('npm', ['run', 'independent'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, GOTOOLCHAIN: 'local' } })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const failed = [...new Set([...out.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => `tools/promcheck > ${m[1]}`))]
  const reasons = [...out.matchAll(/^\s+check_test\.go:\d+: (.*)$/gm)].map((m) => m[1]).filter((x) => !/^(read|checked|upstream|.*identical as read)/.test(x))
  const broken = r.status !== 0 && failed.length === 0 ? ['the capture or the build failed before any Go check ran'] : []
  return { code: r.status, failed: failed.map((f, i) => (i === 0 && reasons[0] ? `${f} (${reasons[0].slice(0, 140)})` : f)), broken, out }
}

function run(tests) {
  const dir = mkdtempSync(join(tmpdir(), 'viz-mutant-'))
  const report = join(dir, 'report.json')
  try {
    const r = spawnSync('npx', ['vitest', 'run', '--maxWorkers=2', '--reporter=json', `--outputFile=${report}`, ...tests], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
    // Only a failing test counts as a kill. A file that did not even load says the mutant
    // broke the build, which proves nothing about the tests: it is reported, not counted.
    let failed = []
    let broken = []
    try {
      const j = JSON.parse(readFileSync(report, 'utf8'))
      for (const f of j.testResults) {
        if (f.status === 'failed' && f.assertionResults.length === 0) broken.push(`${f.name.slice(root.length + 1)}: ${(f.message ?? '').split('\n')[0].slice(0, 160)}`)
        for (const a of f.assertionResults) if (a.status === 'failed') failed.push(`${f.name.slice(root.length + 1)} > ${a.fullName}`)
      }
    } catch {
      failed = []
      broken = ['no JSON report']
    }
    return { code: r.status, failed, broken, out: (r.stdout ?? '') + (r.stderr ?? '') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv.includes('--list')) {
  MUTANTS.forEach((m, i) => console.log(`${i + 1}. ${m.name}`))
  process.exit(0)
}

const only = process.argv.slice(2).map(Number).filter((n) => n > 0)
let bad = 0
let killed = 0
/** Every shared-tree file a mutant edits, as it was before the run: checked unchanged at the end. */
const sharedAtStart = new Map()
for (const m of MUTANTS) for (const e of m.edits) if (!sharedAtStart.has(e.file)) sharedAtStart.set(e.file, readFileSync(join(source, e.file), 'utf8'))
for (const [i, m] of MUTANTS.entries()) {
  if (only.length > 0 && !only.includes(i + 1)) continue
  const originals = new Map()
  for (const e of m.edits) if (!originals.has(e.file)) originals.set(e.file, readFileSync(join(root, e.file), 'utf8'))
  const texts = new Map(originals)
  if (m.independent && !hasGo) {
    console.log(`${i + 1}. SKIPPED  ${m.name} (no Go toolchain: the independent readers cannot run)`)
    bad++
    continue
  }
  let stale = null
  for (const e of m.edits) {
    const text = texts.get(e.file)
    const count = text.split(e.find).length - 1
    if (count !== 1) {
      stale = `pattern found ${count} times in ${e.file}: ${JSON.stringify(e.find.slice(0, 80))}`
      break
    }
    texts.set(e.file, text.replace(e.find, () => e.replace))
  }
  if (stale) {
    console.log(`${i + 1}. NOT APPLIED  ${m.name}\n      ${stale}`)
    bad++
    continue
  }
  let r
  try {
    for (const [file, text] of texts) writeFileSync(join(root, file), text)
    r = m.independent ? runIndependent() : run(m.tests)
  } finally {
    for (const [file, text] of originals) writeFileSync(join(root, file), text)
  }
  const dead = r.code !== 0 && r.failed.length > 0
  if (dead) killed++
  else bad++
  console.log(`${i + 1}. ${dead ? 'KILLED  ' : 'SURVIVED'} ${m.name}`)
  for (const f of r.failed.slice(0, 3)) console.log(`      by: ${f}`)
  if (r.failed.length > 3) console.log(`      ... and ${r.failed.length - 3} more`)
  for (const b of r.broken) console.log(`      did not load: ${b}`)
  if (!dead) console.log(r.out.split('\n').slice(-25).join('\n'))
}
const total = only.length || MUTANTS.length
if (copy) rmSync(copy, { recursive: true, force: true })
let touched = 0
for (const [file, text] of sharedAtStart) {
  if (readFileSync(join(source, file), 'utf8') !== text) {
    // Someone else changed it meanwhile, or a bug wrote here: either way, say so.
    console.log(`shared tree: ${file} changed during the run (this script never writes there; check who did)`)
    touched++
  }
}
console.log(`\n${killed} killed, ${bad} survived or not applied, of ${total}; mutants applied in a scratch copy, deleted; shared tree ${touched === 0 ? 'unchanged' : `changed in ${touched} file(s)`}`)
process.exit(bad === 0 && touched === 0 ? 0 : 1)
