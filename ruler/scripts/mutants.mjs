// Mutation checks (AGENTS.md, "Tests must have teeth").
//
// Each mutant breaks one property in the source, on purpose. The script applies it, runs
// the named test files, requires at least one test to fail, and restores the source.
// A mutant that survives, or whose pattern no longer matches the source, is printed and
// makes the script exit non-zero: a stale pattern is a check that silently stopped running.
//
// A mutant is one or more edits: { file, find, replace }. `find` must occur exactly once.
// Kills are read from vitest's JSON report, not from its console output.
//
//   node scripts/mutants.mjs            run all
//   node scripts/mutants.mjs 3 7        run mutants 3 and 7
//   node scripts/mutants.mjs --list     print the list

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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
    edits: one('src/ruler.ts', '    if (staged.some((s) => s.result.dirty.size > 0)) {\n      const t = this.tenant\n', '    for (const { rule, result } of staged) g.alerts.set(rule.key, result.alerts)\n    if (staged.some((s) => s.result.dirty.size > 0)) {\n      const t = this.tenant\n'),
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
      { file: 'src/backtest.ts', find: '    const r = evalAlertingRule(rule, compiled, alerts, seriesAt(main, ts), ts, input.opts, presence ? seriesAt(presence, ts) : null)', replace: '    const r = secondStateMachine(rule, alerts, seriesAt(main, ts), ts)' },
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
    tests: ['test/http.test.ts'],
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
]

function run(tests) {
  const dir = mkdtempSync(join(tmpdir(), 'viz-mutant-'))
  const report = join(dir, 'report.json')
  try {
    const r = spawnSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${report}`, ...tests], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
    let failed = []
    try {
      const j = JSON.parse(readFileSync(report, 'utf8'))
      for (const f of j.testResults) {
        if (f.status === 'failed' && f.assertionResults.length === 0) failed.push(`${f.name.slice(root.length + 1)} (did not load: ${(f.message ?? '').split('\n')[0].slice(0, 120)})`)
        for (const a of f.assertionResults) if (a.status === 'failed') failed.push(`${f.name.slice(root.length + 1)} > ${a.fullName}`)
      }
    } catch {
      failed = []
    }
    return { code: r.status, failed, out: (r.stdout ?? '') + (r.stderr ?? '') }
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
for (const [i, m] of MUTANTS.entries()) {
  if (only.length > 0 && !only.includes(i + 1)) continue
  const originals = new Map()
  for (const e of m.edits) if (!originals.has(e.file)) originals.set(e.file, readFileSync(join(root, e.file), 'utf8'))
  const texts = new Map(originals)
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
    r = run(m.tests)
  } finally {
    for (const [file, text] of originals) writeFileSync(join(root, file), text)
  }
  const dead = r.code !== 0 && r.failed.length > 0
  if (dead) killed++
  else bad++
  console.log(`${i + 1}. ${dead ? 'KILLED  ' : 'SURVIVED'} ${m.name}`)
  for (const f of r.failed.slice(0, 3)) console.log(`      by: ${f}`)
  if (r.failed.length > 3) console.log(`      ... and ${r.failed.length - 3} more`)
  if (!dead) console.log(r.out.split('\n').slice(-25).join('\n'))
}
const total = only.length || MUTANTS.length
console.log(`\n${killed} killed, ${bad} survived or not applied, of ${total}`)
process.exit(bad === 0 ? 0 : 1)
