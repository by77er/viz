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

/** The status of a GET, 0 when nothing answers; never waits more than 3 s (a port held by something that does not answer counts as taken). */
function ping(u) {
  return new Promise((resolve) => {
    const req = http.get(u, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', () => resolve(0))
    req.setTimeout(3000, () => { req.destroy(); resolve(-1) })
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

/**
 * Start the mock and `vite preview` of the built app in `root`; returns a stop function. The
 * mock is always this checkout's (ROOT), so two builds measured one after the other talk to
 * the same backend.
 */
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
  start(process.execPath, ['--import', 'tsx', path.join(ROOT, 'mock/server.ts'), '--port', String(MOCK_PORT)])
  start(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(APP_PORT), '--host', '127.0.0.1'])
  const stop = () => procs.forEach((p) => { try { p.kill('SIGTERM') } catch {} })
  process.on('exit', stop)
  if (!(await waitFor(`${MOCK}/api/v1/status/buildinfo`)) || !(await waitFor(APP))) { stop(); throw new Error('servers did not start') }
  return stop
}

/**
 * Artificial latency of the mock's query endpoints, in ms (0 = off). Like the real API, the
 * mock answers 503 `timeout` at 30 s; `stall` makes the delay a stalled connection instead,
 * to which no API time limit applies (the app's own 60 s stop is then what ends the wait).
 */
const setMockDelay = (ms, { stall = false } = {}) => new Promise((resolve, reject) => {
  http.get(`${MOCK}/__mock/delay?ms=${ms}${stall ? '&stall=1' : ''}`, (res) => { res.resume(); res.on('end', resolve) }).on('error', reject)
})

/** The next `count` query requests to the mock fail as the real API fails (mock/server.ts, `/__mock/fail`). */
const setMockFailure = (kind, count = 1, base = MOCK) => new Promise((resolve, reject) => {
  http.get(`${base}/__mock/fail?kind=${kind}&count=${count}`, (res) => { res.resume(); res.on('end', resolve) }).on('error', reject)
})

// ---- the real viz API, locally (real/stack.mjs)
const REAL_PORT = Number(process.env.VIZ_REAL_PORT || 8851)
const REAL = `http://127.0.0.1:${REAL_PORT}`
const REAL_KEYS = path.join(ROOT, 'real/.wrangler/keys.json')

/**
 * Whether the real stack answers: the gateway's /healthz is 200, or 503 only because ruler and
 * MCP, which real/wrangler.jsonc does not include, do not answer (real/stack.mjs, `up`).
 */
async function realUp(base = REAL) {
  try {
    const res = await fetch(`${base}/healthz`)
    const text = await res.text()
    if (res.status === 200) return true
    if (res.status !== 503) return false
    const b = JSON.parse(text).backends || {}
    return ['ingest', 'query', 'control'].every((k) => b[k] && b[k].ok)
  } catch {
    return false
  }
}

/** Make sure the real stack is up and seeded; returns a function that stops it if this call started it. */
async function ensureRealStack() {
  if ((await realUp()) && fs.existsSync(REAL_KEYS)) return () => {}
  const { spawnSync } = require('node:child_process')
  const run = (...args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'real/stack.mjs'), ...args, '--port', String(REAL_PORT)], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`real/stack.mjs ${args.join(' ')} failed`)
  }
  run('start')
  run('seed')
  return () => run('stop')
}
const realKeys = () => JSON.parse(fs.readFileSync(REAL_KEYS, 'utf8'))

/** A local KV record of the real stack (put, or delete with value null): how the e2e makes the real API refuse. */
function realKv(key, value) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.CLOUDFLARE_API_TOKEN
  delete env.CLOUDFLARE_ACCOUNT_ID
  const args = value === null ? ['delete', key] : ['put', key, value]
  const r = spawnSync(process.execPath, [path.resolve(ROOT, '../query/node_modules/wrangler/bin/wrangler.js'), 'kv', 'key', ...args, '--local', '-c', 'wrangler.jsonc', '--persist-to', '.wrangler/state', '--binding', 'CONFIG'], { cwd: path.join(ROOT, 'real'), env, stdio: 'ignore' })
  if (r.status !== 0) throw new Error(`wrangler kv key ${args[0]} ${key} failed`)
}

/** `vite preview` of the built app on `port`, its /api proxied to `target`; returns a stop function. */
async function startPreview(port, target, root = ROOT) {
  if (await ping(`http://127.0.0.1:${port}`)) throw new Error(`port ${port} is already in use`)
  const p = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--host', '127.0.0.1'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, VIZ_API_TARGET: target } })
  p.stderr.on('data', (d) => process.stderr.write(`[preview ${port}] ${d}`))
  const stop = () => { try { p.kill('SIGTERM') } catch {} }
  process.on('exit', stop)
  if (!(await waitFor(`http://127.0.0.1:${port}`))) { stop(); throw new Error('vite preview did not start') }
  return stop
}

/** The mock server on `port` with extra arguments; returns a stop function. */
async function startMock(port, args = []) {
  if (await ping(`http://127.0.0.1:${port}/__mock/delay`)) throw new Error(`port ${port} is already in use`)
  const p = spawn(process.execPath, ['--import', 'tsx', 'mock/server.ts', '--port', String(port), ...args], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
  p.stderr.on('data', (d) => process.stderr.write(`[mock ${port}] ${d}`))
  const stop = () => { try { p.kill('SIGTERM') } catch {} }
  process.on('exit', stop)
  if (!(await waitFor(`http://127.0.0.1:${port}/__mock/delay`))) { stop(); throw new Error('mock did not start') }
  return stop
}

/**
 * A browser context signed in with `key`: the key is in the tab's sessionStorage before the
 * app starts (shell/session.tsx, KEY_STORE), as it is after a person signs in and reloads.
 * It is put there once per tab, so that signing out in a test stays signed out.
 */
async function contextWithKey(browser, key, options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', ...options })
  await ctx.addInitScript((k) => { if (!sessionStorage.getItem('viz.e2e.keyed')) { sessionStorage.setItem('viz.key', k); sessionStorage.setItem('viz.e2e.keyed', '1') } }, key)
  return ctx
}

/**
 * What a finger can reach, for every control in the viewport: found by asking the page which
 * element is at each point (as design-system/tools/shots.mjs measures it), so an area clipped
 * by a scrolling strip or covered by a neighbour is measured as it behaves. Returns the
 * controls under 44 px, those covered at their centre, and whether the pointer is coarse.
 */
const hitAreas = (page) => page.evaluate(() => {
  const sel = 'a[href], button, input, select, textarea, summary, [role^="menuitem"], label.vz-check, [tabindex="0"]'
  const owner = (x, y) => { const e = document.elementFromPoint(x, y); return e && e.closest(sel) }
  const name = (el) => (el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.textContent || el.value || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 32)
  const out = { count: 0, small: [], covered: [], coarse: matchMedia('(pointer: coarse)').matches }
  const modal = document.querySelector('dialog:modal')
  for (const el of document.querySelectorAll(sel)) {
    if (el.disabled || el.closest('[inert], [aria-hidden="true"]') || getComputedStyle(el).visibility !== 'visible') continue
    if (modal && !modal.contains(el)) continue
    if (el.matches('input[type="checkbox"]') && el.closest('label')) continue
    if (el.matches('a') && el.closest('p')) continue // a link inside a sentence is text
    const r = el.getBoundingClientRect()
    if (r.width <= 1 || r.height <= 1 || r.bottom < 0 || r.top > innerHeight - 22) continue
    let strip = el.parentElement
    while (strip && strip !== document.body && !/(auto|scroll)/.test(getComputedStyle(strip).overflowX)) strip = strip.parentElement
    if (strip && strip !== document.body) { const s = strip.getBoundingClientRect(); if (r.left < s.left - 0.5 || r.right > s.right + 0.5) continue }
    const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), cy = r.top + r.height / 2
    if (owner(cx, cy) !== el) { out.covered.push(name(el)); continue }
    let top = cy, bottom = cy, left = cx, right = cx
    const q = 0.25
    while (top > cy - 60 && owner(cx, top - q) === el) top -= q
    while (bottom < cy + 60 && owner(cx, bottom + q) === el) bottom += q
    while (left > cx - 60 && owner(left - q, cy) === el) left -= q
    while (right < cx + 60 && owner(right + q, cy) === el) right += q
    out.count++
    const w = right - left + q, h = bottom - top + q
    if (h < 44 || w < 44) out.small.push(`${name(el)} ${w.toFixed(0)}x${h.toFixed(0)}`)
  }
  return out
})

/**
 * Makes the pointer coarse in Blink itself, with no touch emulation: the only way to read a
 * position or a pointer-dependent size across a reload at the phone layout
 * (design-system/reviews/system-v9/second-review.md; tools/audit.mjs does the same). Used with
 * a context that has `isMobile` and NOT `hasTouch`. A Chromium internal: whoever uses it checks
 * that `(pointer: coarse)` matches, and fails if it does not.
 */
const COARSE_IN_BLINK = '--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1'

/**
 * Where a reload lands (design review B3). For each case [name, address, anchor selector, wait]:
 * a page of its own is loaded, scrolled until the anchor is 120 px under the top of the window,
 * reloaded, and read 1.5 s after it has drawn again. Returns, per case, the scroll position
 * before and after, how far the anchor is from where it was, every layout-shift entry of the
 * reload summed, and whether the pointer was coarse before and after. No input is given.
 */
async function reloadLandings(ctx, cases) {
  await ctx.addInitScript(() => { window.__shift = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shift += e.value }).observe({ type: 'layout-shift', buffered: true }) } catch {} })
  // An anchor is a selector, or [selector, n] for the n-th match (from the end when negative).
  const read = (page, sel) => page.evaluate((sel) => { const el = Array.isArray(sel) ? [...document.querySelectorAll(sel[0])].at(sel[1]) : document.querySelector(sel); return { y: Math.round(scrollY), top: el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null, shift: window.__shift, coarse: matchMedia('(pointer: coarse)').matches, height: document.documentElement.scrollHeight } }, sel)
  const rows = []
  for (const [name, address, anchor, wait] of cases) {
    const page = await ctx.newPage()
    try {
      await page.goto(address)
      await wait(page)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(400)
      await page.evaluate((sel) => { const el = Array.isArray(sel) ? [...document.querySelectorAll(sel[0])].at(sel[1]) : document.querySelector(sel); scrollTo(0, Math.round(el.getBoundingClientRect().top + scrollY - 120)) }, anchor)
      await page.waitForTimeout(400)
      const before = await read(page, anchor)
      await page.reload()
      await wait(page)
      await page.waitForTimeout(1500)
      const after = await read(page, anchor)
      rows.push({ name, y0: before.y, y: after.y, moved: after.top === null || before.top === null ? null : Math.round((after.top - before.top) * 10) / 10, shift: Math.round(after.shift * 10000) / 10000, coarse: before.coarse && after.coarse, fine: !before.coarse && !after.coarse })
    } finally {
      await page.close()
    }
  }
  return rows
}

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
  makeChecker, startServers, setMockDelay, setMockFailure, overflow, axe, ping, waitFor,
  REAL, realUp, ensureRealStack, realKeys, realKv, startPreview, startMock, contextWithKey, hitAreas, APP_PORT, MOCK_PORT, COARSE_IN_BLINK, reloadLandings,
}
