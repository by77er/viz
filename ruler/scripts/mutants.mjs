// Mutation checks (AGENTS.md, "Tests must have teeth").
//
// Each mutant breaks one safety property in the source, on purpose. The script applies it,
// runs the named test files, requires at least one test to fail, and restores the source.
// A mutant that survives is printed as SURVIVED and makes the script exit non-zero.
//
//   node scripts/mutants.mjs            run all
//   node scripts/mutants.mjs 3 7        run mutants 3 and 7

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const MUTANTS = [
  {
    name: 'advance `for` on a replayed tick (evaluate at wall-clock time instead of the aligned tick time)',
    file: 'src/ruler.ts',
    find: 'const ts = alignedTick(now, g.spec.intervalMs, g.offsetMs)\n        // Not started yet',
    replace: 'const ts = now\n        // Not started yet',
    tests: ['test/ruler.test.ts', 'test/prometheus.test.ts'],
  },
  {
    name: 'drop the replay guard (the same group and evaluation time is evaluated again)',
    file: 'src/ruler.ts',
    find: 'if (ts < g.notBefore || (g.lastEvalMs !== null && ts <= g.lastEvalMs)) continue',
    replace: 'if (ts < g.notBefore) continue',
    tests: ['test/ruler.test.ts'],
  },
  {
    name: 'resolve on evaluator error (treat a failed query as an empty result)',
    file: 'src/ruler.ts',
    find: '          g.evaluatorErrors++\n          setHealth(rule, errorText(e))\n          continue\n',
    replace: '          g.evaluatorErrors++\n          setHealth(rule, errorText(e))\n          series = []\n',
    tests: ['test/ruler.test.ts'],
  },
  {
    name: 'notify before the transaction commits (send from inside the flush transaction)',
    file: 'src/notifier.ts',
    find: "              t, nextId++, g.key, g.route.receiver, d.integration.key, d.integration.url, idem, JSON.stringify(body), now, now)\n",
    replace:
      "              t, nextId++, g.key, g.route.receiver, d.integration.key, d.integration.url, idem, JSON.stringify(body), now, now)\n" +
      "            void this.fetcher()(d.integration.url, { method: 'POST', headers: { [IDEMPOTENCY_HEADER]: idem }, body: JSON.stringify(body) }).catch(() => {})\n",
    tests: ['test/exactly-once.test.ts'],
  },
  {
    name: 'drop the idempotency key header',
    file: 'src/notifier.ts',
    find: "headers: { 'content-type': 'application/json', 'user-agent': 'viz-notifier', [IDEMPOTENCY_HEADER]: row.idem_key },",
    replace: "headers: { 'content-type': 'application/json', 'user-agent': 'viz-notifier' },",
    tests: ['test/exactly-once.test.ts'],
  },
  {
    name: 'make the idempotency key depend on the attempt',
    file: 'src/notifier.ts',
    find: '[IDEMPOTENCY_HEADER]: row.idem_key },',
    replace: '[IDEMPOTENCY_HEADER]: hash64(row.idem_key + row.attempts) + hash64(row.idem_key) },',
    tests: ['test/exactly-once.test.ts'],
  },
  {
    name: 'ignore silences',
    file: 'src/notifier.ts',
    find: 'if (silencedBy(this.compiledSilences(), a.labels, tick).length > 0) return true',
    replace: 'if (silencedBy(this.compiledSilences(), a.labels, tick).length < 0) return true',
    tests: ['test/notifier.test.ts'],
  },
  {
    name: 'wrong group key (group labels left out of the key)',
    file: 'src/amconfig.ts',
    find: "return `${route.key}:{${Object.keys(group).sort().map((n) => `${n}=${JSON.stringify(group[n])}`).join(',')}}`",
    replace: 'return `${route.key}:{}`',
    tests: ['test/notifier.test.ts'],
  },
  {
    name: 'catch up missed ticks in a loop',
    file: 'src/ruler.ts',
    find: '        due.push({ g, ts })\n',
    replace: '        for (let t = previous + g.spec.intervalMs; t <= ts; t += g.spec.intervalMs) due.push({ g, ts: t })\n',
    tests: ['test/prometheus.test.ts', 'test/ruler.test.ts'],
  },
  {
    name: 'persist on every tick (a refreshed value counts as a transition)',
    file: 'src/statemachine.ts',
    find: '        next.set(fp, { ...existing, value: a.value, annotations: a.annotations })\n      }\n      continue',
    replace: '        next.set(fp, { ...existing, value: a.value, annotations: a.annotations })\n      }\n      dirty.add(fp)\n      continue',
    tests: ['test/ruler.test.ts', 'test/property.test.ts'],
  },
  {
    name: 'memory ahead of storage (adopt the new alert state before the transaction commits)',
    file: 'src/ruler.ts',
    find: "    if (staged.some((s) => s.result.dirty.size > 0)) {\n      const t = this.tenant\n",
    replace: "    for (const { rule, result } of staged) g.alerts.set(rule.key, result.alerts)\n    if (staged.some((s) => s.result.dirty.size > 0)) {\n      const t = this.tenant\n",
    tests: ['test/exactly-once.test.ts'],
  },
  {
    name: 'hand-off row written outside the transition transaction (dropped on a crash in between)',
    file: 'src/ruler.ts',
    find: '        this.enqueueHandoff(updates, ts)\n        this.fault(\'commit\')\n      })\n      this.noteHandoff(updates, ts)',
    replace: "        this.fault('commit')\n      })\n      this.fault('after-commit')\n      this.enqueueHandoff(updates, ts)\n      this.noteHandoff(updates, ts)",
    tests: ['test/exactly-once.test.ts'],
  },
  {
    name: 'treat a retryable receiver failure as delivered (at-most-once)',
    file: 'src/notifier.ts',
    find: '      if (ok) {\n        this.exec(`DELETE FROM outbox WHERE tenant = ? AND id = ?`, t, row.id)',
    replace: '      if (ok || !permanent) {\n        this.exec(`DELETE FROM outbox WHERE tenant = ? AND id = ?`, t, row.id)',
    tests: ['test/exactly-once.test.ts', 'test/notifier.test.ts'],
  },
  {
    name: 'reset `for` timers on restore (do not load stored alerts)',
    file: 'src/ruler.ts',
    find: '      m.set(row.fp, JSON.parse(row.body) as Alert)\n',
    replace: '      void m\n',
    tests: ['test/prometheus.test.ts'],
  },
  {
    name: 'inhibit without checking the `equal` labels',
    file: 'src/amconfig.ts',
    find: 'if (labelValue(s.labels, n) !== labelValue(target, n)) {',
    replace: 'if (n === "\\u0000") {',
    tests: ['test/unit.test.ts', 'test/notifier.test.ts'],
  },
  {
    name: 'serve any tenant (drop the tenant check in the ruler)',
    file: 'src/ruler.ts',
    find: "return this.tenant !== '' && tenant === this.tenant ? null : { status: 'wrong_tenant' }",
    replace: 'return tenant === undefined ? { status: \'wrong_tenant\' } : null',
    tests: ['test/ruler.test.ts'],
  },
  {
    name: 'a "firing" redelivered after the "resolved" re-opens the alert (drop the ordering check in ingest)',
    file: 'src/notifier.ts',
    find: '        if (u.at < cur.at) continue\n',
    replace: '',
    tests: ['test/notifier.test.ts', 'test/exactly-once.test.ts'],
  },
  {
    name: 'group_interval ignored (flush a changed group as soon as an alarm runs)',
    file: 'src/notifier.ts',
    find: "      if (!a || a.receivedAt > tick) continue\n      if (this.muted(a, tick)) continue\n      if (this.firingAsOf(a, tick)) firing.push(fp)",
    replace: "      if (!a) continue\n      if (this.muted(a, tick)) continue\n      if (a.status === 'firing') firing.push(fp)",
    tests: ['test/notifier.test.ts'],
  },
]

function run(tests) {
  const r = spawnSync('npx', ['vitest', 'run', ...tests], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const failed = [...new Set([...out.matchAll(/^ FAIL  (.*)$/gm)].map((m) => m[1].trim()))]
  return { code: r.status, failed, out }
}

const only = process.argv.slice(2).map(Number)
const results = []
let survived = 0
for (const [i, m] of MUTANTS.entries()) {
  if (only.length > 0 && !only.includes(i + 1)) continue
  const path = join(root, m.file)
  const original = readFileSync(path, 'utf8')
  const count = original.split(m.find).length - 1
  if (count !== 1) {
    console.log(`${i + 1}. NOT APPLIED (pattern found ${count} times): ${m.name}`)
    survived++
    continue
  }
  let r
  try {
    writeFileSync(path, original.replace(m.find, m.replace))
    r = run(m.tests)
  } finally {
    writeFileSync(path, original)
  }
  const killed = r.code !== 0 && r.failed.length > 0
  if (!killed) survived++
  results.push({ i: i + 1, m, killed, failed: r.failed })
  console.log(`${i + 1}. ${killed ? 'KILLED  ' : 'SURVIVED'} ${m.name}`)
  for (const f of r.failed.slice(0, 4)) console.log(`      by: ${f}`)
  if (r.failed.length > 4) console.log(`      ... and ${r.failed.length - 4} more`)
  if (!killed) console.log(r.out.split('\n').slice(-25).join('\n'))
}
console.log(`\n${results.filter((r) => r.killed).length} killed, ${survived} survived or not applied, of ${only.length || MUTANTS.length}`)
process.exit(survived === 0 ? 0 : 1)
