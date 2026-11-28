/* eslint-disable */
// The monitors views' safety properties broken one at a time, on a copy of the app OUTSIDE the
// tree (AGENTS.md, "Tests must have teeth": a mutant is never applied in place).
//
//   VIZ_MUTANT_DIR=<scratch dir> VIZ_E2E_APP_PORT=… VIZ_E2E_MOCK_PORT=… node e2e/mutants-monitors.cjs [name …]
//
// The copy is <dir>/app, with ../design-system, ../dashboard and ../ruler linked beside it and
// node_modules linked into it. For each mutant: the text is replaced (it must occur once), the
// checks it names run (`unit:<files>` the unit suite on those files; `e2e:<sections>` a build of
// the copy and those sections of e2e/monitors.cjs), and the file is restored. A mutant is killed
// when at least one of its checks fails; the record says which.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const DIR = process.env.VIZ_MUTANT_DIR
if (!DIR) throw new Error('set VIZ_MUTANT_DIR to a scratch directory outside the tree')
const SRC = path.resolve(__dirname, '..')
if (path.resolve(DIR).startsWith(path.resolve(SRC, '..'))) throw new Error('VIZ_MUTANT_DIR is inside the tree')
const APP = path.join(DIR, 'app')

const MUTANTS = [
  { name: 'key-in-url', property: 'The key never in a URL', file: 'src/api/monitors.ts', from: 'const r = await client.json(method, path, body, opts)', to: "const r = await client.json(method, path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent((client as unknown as { token: string }).token), body, opts)", checks: ['unit:src/api/monitors.test.ts', 'e2e:key'] },
  { name: 'act-without-scope', property: 'An action without monitors:ack is never sent', file: 'src/monitors/MonitorPage.tsx', from: 'if (allowed === false || busy !== null || !monitor) return', to: 'if (busy !== null || !monitor) return', checks: ['e2e:noack'] },
  { name: 'scope-not-read', property: 'An action without monitors:ack is never sent', file: 'src/monitors/model.ts', from: 'return scopes === null ? null : scopes.includes(ACK_SCOPE)', to: 'return scopes === null ? null : true', checks: ['unit:src/monitors/model.test.ts', 'e2e:noack'] },
  { name: 'undo-past-window', property: 'Undo offered only inside its window', file: 'src/monitors/model.ts', from: 'return u !== null && u.monitor === monitorId && localNowMs + u.skewMs < u.undoUntil', to: 'return u !== null && u.monitor === monitorId', checks: ['unit:src/monitors/model.test.ts', 'e2e:silence'] },
  { name: 'undo-other-token', property: 'Undo uses the token from that call', file: 'src/monitors/MonitorPage.tsx', from: 'await undoSilence(client, undo.token)', to: "await undoSilence(client, 'f'.repeat(32))", checks: ['e2e:silence'] },
  { name: 'failed-write-shown', property: 'A failed write leaves the screen unchanged', file: 'src/monitors/MonitorPage.tsx', from: 'setFailure({ action, error: err })', to: "setFailure({ action, error: err })\n        setOverride(action === 'acknowledge' ? { acknowledged: { by: me ?? 'you', at: Date.now() } } : { silencedUntil: Date.now() + 3_600_000 })", checks: ['e2e:failure'] },
  { name: 'colour-alone', property: 'State never shown by colour alone', file: 'src/monitors/Status.tsx', from: '<span className="vz-status" data-state={words.mark || undefined} data-testid={testId}>\n      <span>', to: '<span className="vz-status" data-state={words.mark || undefined} data-testid={testId}>\n      <span hidden>', checks: ['e2e:list'] },
  { name: 'superseded-painted', property: 'Superseded reads not painted', file: 'src/monitors/model.ts', from: 'return stamp === this.generation', to: 'return stamp === stamp', checks: ['unit:src/monitors/model.test.ts', 'e2e:superseded'] },
  { name: 'touch-clipped', property: '44 px targets take the tap', file: 'src/monitors/MonitorPage.tsx', from: '<div className="vz-notice-group" data-testid="monitor-actions">', to: "<div className=\"vz-notice-group\" data-testid=\"monitor-actions\" style={{ overflow: 'hidden' }}>", checks: ['e2e:touch'] },
  { name: 'dry-run-sent', property: 'dryRun is used nowhere', file: 'src/api/monitors.ts', from: "fingerprint ? { fingerprint } : {}, opts)", to: '{ dryRun: true }, opts)', checks: ['unit:src/api/monitors.test.ts', 'e2e:ack'] },
  // ---- the third design review: M-M1, M-M2 and the minors (node e2e/mutants-monitors.cjs <names>, OUT=mutants-monitors-rereview.txt)
  { name: 'chart-without-unit', property: 'M-M2: the chart in the query\'s unit', file: 'src/monitors/MonitorPage.tsx', from: 'const unit = monitorUnit(monitor)', to: "const unit = 'none' as const", checks: ['e2e:monitor'] },
  { name: 'values-without-unit', property: 'M-M2: values in the query\'s unit', file: 'src/monitors/model.ts', from: 'return unitValue(v, monitorUnit(m))', to: "return unitValue(v, 'none')", checks: ['unit:src/monitors/model.test.ts', 'e2e:list'] },
  { name: 'share-not-read', property: 'M-M2: a share is read from the query', file: 'src/monitors/model.ts', from: "if (isShare(q)) return 'percentunit'", to: '', checks: ['unit:src/monitors/model.test.ts'] },
  { name: 'late-undo-iso', property: 'M-M1: a late Undo in the app\'s words and times', file: 'src/monitors/MonitorPage.tsx', from: "const lateUndo = failure?.action === 'undo'", to: "const lateUndo = false && failure?.action === 'undo'", checks: ['e2e:silence'] },
  { name: 'threshold-as-written', property: 'o1: the threshold as the app writes durations', file: 'src/monitors/model.ts', from: "if (!m.condition) return m.thresholdText", to: 'return m.thresholdText', checks: ['unit:src/monitors/model.test.ts', 'e2e:list'] },
  { name: 'template-as-message', property: 'o2: a template is not shown as the message', file: 'src/monitors/MonitorPage.tsx', from: "const sent = monitor && monitor.message.includes('{{')", to: "const sent = false && monitor && monitor.message.includes('{{')", checks: ['e2e:monitor'] },
  { name: 'error-critical', property: 'o3: cannot be evaluated is the unknown dash', file: 'src/monitors/model.ts', from: "return words('', 'Cannot be evaluated')", to: "return words('critical', 'Cannot be evaluated')", checks: ['e2e:list'] },
  { name: 'error-lower-case', property: 'o5: the API\'s words as a sentence', file: 'src/monitors/MonitorsListPage.tsx', from: '{sentence(error.message)}', to: '{error.message}', checks: ['e2e:states'] },
  { name: 'query-cut', property: 'o6: the query is shown whole', file: 'src/monitors/MonitorPage.tsx', from: '<pre className="vz-query is-prose" aria-label="The monitor\'s query"', to: '<pre className="vz-query" style={{ maxWidth: \'20ch\' }} aria-label="The monitor\'s query"', checks: ['e2e:monitor'] },
  { name: 'mock-fixed-value', property: 'o8: the mock\'s values from its own series', file: 'mock/monitors.ts', from: 'value: a.noData ? null : f.query && !a.noData ? (valueAt(f.query, evaluatedAt(t)) ?? a.value) : a.value,', to: 'value: a.value,', checks: ['e2e:monitor'] },
  { name: 'open-after-route', property: 'M-B1: the monitor is shown in the press\'s task', file: 'src/monitors/MonitorsListPage.tsx', from: '            e.preventDefault()\n            onOpen(m.id)', to: '            void e', checks: ['e2e:monitor'] },
  { name: 'not-served', property: '/monitors is a document', file: 'serve.json', from: '"/dashboards", "/monitors",', to: '"/dashboards",', checks: ['unit:src/shell/serve.test.ts'] },
]

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: APP, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env }, ...opts })

function copy() {
  fs.rmSync(APP, { recursive: true, force: true })
  fs.mkdirSync(APP, { recursive: true })
  for (const entry of fs.readdirSync(SRC)) {
    if (['node_modules', 'dist', 'screenshots', 'reviews'].includes(entry)) continue
    fs.cpSync(path.join(SRC, entry), path.join(APP, entry), { recursive: true, filter: (p) => !p.includes(`${path.sep}measurements${path.sep}`) })
  }
  fs.symlinkSync(fs.realpathSync(path.join(SRC, 'node_modules')), path.join(APP, 'node_modules'))
  for (const sib of ['design-system', 'dashboard', 'ruler']) {
    const at = path.join(DIR, sib)
    if (!fs.existsSync(at)) fs.symlinkSync(path.resolve(SRC, '..', sib), at)
  }
}

function runChecks(checks) {
  const out = []
  let built = false
  for (const c of checks) {
    const [kind, what] = c.split(':')
    if (kind === 'unit') {
      const r = sh('npx', ['vitest', 'run', '--maxWorkers=2', ...what.split(',')])
      const failedTests = [...(r.stdout + r.stderr).matchAll(/(?:×|FAIL)\s+([^\n]+)/g)].map((m) => m[1].trim()).slice(0, 3)
      out.push({ check: c, failed: r.status !== 0, detail: failedTests.join(' | ') || (r.status !== 0 ? (r.stdout + r.stderr).slice(-300) : '') })
    } else if (kind === 'e2e') {
      if (!built) {
        const b = sh(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'error'])
        if (b.status !== 0) { out.push({ check: 'build', failed: true, detail: (b.stdout + b.stderr).slice(-300) }); return out }
        built = true
      }
      const r = sh(process.execPath, ['e2e/monitors.cjs'], { env: { ...process.env, VIZ_ONLY: what } })
      const fails = (r.stdout.match(/^FAIL .*/gm) || []).map((l) => l.slice(0, 160))
      out.push({ check: c, failed: r.status !== 0, detail: fails.join(' | ') || (r.status !== 0 ? (r.stdout + r.stderr).slice(-300) : '') })
    }
  }
  return out
}

function main() {
  copy()
  const pick = process.argv.slice(2)
  const lines = [`mutants of the monitors views, ${new Date().toISOString()}, on a copy at ${APP}`]
  let killed = 0
  const list = MUTANTS.filter((m) => pick.length === 0 || pick.includes(m.name))
  for (const m of list) {
    const file = path.join(APP, m.file)
    const orig = fs.readFileSync(file, 'utf8')
    const n = orig.split(m.from).length - 1
    if (n !== 1) { lines.push(`${m.name}: NOT APPLIED (the text occurs ${n} times)`); console.log(lines.at(-1)); continue }
    fs.writeFileSync(file, orig.replace(m.from, m.to))
    let res
    try {
      res = runChecks(m.checks)
    } finally {
      fs.writeFileSync(file, orig)
    }
    const by = res.filter((r) => r.failed)
    if (by.length) killed++
    lines.push(`${m.name} [${m.property}]: ${by.length ? 'KILLED' : 'SURVIVED'} by ${by.map((r) => r.check).join(', ') || 'nothing'}; ${res.map((r) => `${r.check} ${r.failed ? 'failed' : 'passed'}${r.detail ? ` (${r.detail})` : ''}`).join('; ')}`)
    console.log(lines.at(-1))
  }
  lines.push(`${killed} of ${list.length} killed`)
  console.log(lines.at(-1))
  fs.mkdirSync(path.join(SRC, 'e2e/measurements'), { recursive: true })
  fs.writeFileSync(path.join(SRC, 'e2e/measurements', process.env.OUT || 'mutants-monitors.txt'), lines.join('\n') + '\n')
}

main()
