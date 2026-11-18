/* eslint-disable */
// Shared by the end-to-end suites: servers, design tokens, small helpers.
// Ports default to 8820 (app) and 8821 (mock); set VIZ_E2E_APP_PORT / VIZ_E2E_MOCK_PORT when
// those are taken. Uses the globally pre-installed Playwright.
const { chromium } = require('playwright')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

const ROOT = path.resolve(__dirname, '..')
const APP_PORT = Number(process.env.VIZ_E2E_APP_PORT || 8820)
const MOCK_PORT = Number(process.env.VIZ_E2E_MOCK_PORT || 8821)
const APP = `http://127.0.0.1:${APP_PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const AXE = fs.readFileSync(path.join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8')

// A fixed window so screenshots are reproducible: 3 h containing the mock's "incident"
// (09:40–09:52 UTC) and one pod's data gap (10:50–11:02 UTC).
const T0 = Date.UTC(2026, 10, 18, 9, 30)
const T1 = Date.UTC(2026, 10, 18, 12, 30)
const Q_RATE = 'sum by (service) (rate(http_requests_total[5m]))'
const Q_CPU = 'pod_cpu_usage_cores{service="checkout"}'
const Q_P95 = 'histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))'
const Q_MANY = 'sum by (service, route, status) (rate(http_requests_total[5m]))'
const Q_BAD = 'sum by (service) (rate(http_requests_total[5m])'
const url = (q, extra = '') => `${APP}/explore?q=${encodeURIComponent(q)}&from=${T0}&to=${T1}${extra}`

// The design system's tokens are the expected values; nothing is restated here.
const TOKENS = JSON.parse(fs.readFileSync(path.join(ROOT, '../design-system/project/tokens.json'), 'utf8'))
const tokenValue = (name, theme) => {
  const t = TOKENS.color.tokens.find((k) => k.name === name)
  return typeof t.value === 'string' ? t.value : t.value[theme]
}
const hexToRgb = (hex) => {
  const h = hex.replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`
}
const tokenRgb = (name, theme) => hexToRgb(tokenValue(name, theme))
const seriesHex = (theme) => Array.from({ length: 8 }, (_, i) => tokenValue(`series-${i + 1}`, theme))
/** Every colour a computed style may have in a theme: token colours, and the colours inside the one shadow. */
function allowedColours(theme) {
  const set = new Set(['rgba(0, 0, 0, 0)'])
  for (const t of TOKENS.color.tokens) set.add(hexToRgb(typeof t.value === 'string' ? t.value : t.value[theme]))
  const shadow = TOKENS.shadow.tokens[0].value[theme]
  for (const m of shadow.matchAll(/rgba?\(([^)]+)\)/g)) set.add(`rgba(${m[1].split(',').map((x) => String(Number(x))).join(', ')})`)
  return [...set]
}

function makeChecker() {
  const results = []
  let failed = 0
  function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok, detail })
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  }
  return { check, results, failed: () => failed }
}

function ping(u) {
  return new Promise((resolve) => {
    http.get(u, (res) => { res.resume(); resolve(res.statusCode) }).on('error', () => resolve(0))
  })
}
async function waitFor(u, ms = 20000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    if (await ping(u)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/** Start the mock and `vite preview` of the built app; returns a stop function. */
async function startServers(root = ROOT) {
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) throw new Error('dist/ missing: run `npm run build` first')
  const procs = []
  const start = (cmd, args) => {
    const p = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VIZ_API_TARGET: MOCK } })
    p.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
    procs.push(p)
    return p
  }
  if (await ping(`${MOCK}/api/v1/status/buildinfo`)) throw new Error(`port ${MOCK_PORT} is already in use (set VIZ_E2E_MOCK_PORT)`)
  if (await ping(APP)) throw new Error(`port ${APP_PORT} is already in use (set VIZ_E2E_APP_PORT)`)
  start(process.execPath, ['--import', 'tsx', 'mock/server.ts', '--port', String(MOCK_PORT)])
  start(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(APP_PORT), '--host', '127.0.0.1'])
  const stop = () => procs.forEach((p) => { try { p.kill('SIGTERM') } catch {} })
  process.on('exit', stop)
  if (!(await waitFor(`${MOCK}/api/v1/status/buildinfo`)) || !(await waitFor(APP))) { stop(); throw new Error('servers did not start') }
  return stop
}

/** Artificial latency of the mock's query endpoints, in ms (0 = off). */
const setMockDelay = (ms) => new Promise((resolve, reject) => {
  http.get(`${MOCK}/__mock/delay?ms=${ms}`, (res) => { res.resume(); res.on('end', resolve) }).on('error', reject)
})

const overflow = (page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))

async function axe(page, label, check) {
  await page.evaluate(AXE)
  const res = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } })
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').replace(/\s+/g, ' ').slice(0, 220)) }))
  })
  const bad = res.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  check(`axe (${label}): no serious/critical violations`, bad.length === 0, `${res.length} violation(s) total: ${res.map((v) => `${v.id}[${v.impact}]`).join(', ') || 'none'}`)
  for (const v of res) console.log(`      axe ${v.impact} ${v.id}: ${v.help}\n        ${v.nodes.join('\n        ')}`)
  return res
}

module.exports = {
  chromium, ROOT, APP, MOCK, T0, T1, Q_RATE, Q_CPU, Q_P95, Q_MANY, Q_BAD, url, TOKENS, tokenValue, tokenRgb, seriesHex, allowedColours,
  makeChecker, startServers, setMockDelay, overflow, axe,
}
