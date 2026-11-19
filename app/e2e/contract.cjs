/* eslint-disable */
// The contract test: the same requests to the real viz API and to the mock, compared.
//
//   node e2e/contract.cjs            starts what is not running: the real stack (real/stack.mjs
//                                    start + seed, stopped afterwards) and the mock (with keys)
//   VIZ_REAL_PORT=8851 VIZ_E2E_MOCK_PORT=8861
//
// The real stack holds the mock's own data (real/seed.ts wrote it sample for sample), so the
// two can be compared beyond shapes: the same timestamps, and values equal to 1e-9 relative.
// For every request it checks: the HTTP status; the envelope's keys; the error type; the type
// of `data` (and of each result element: metric with label names in order, [number, string]
// samples, series listed in label order); the headers a client acts on (WWW-Authenticate,
// Allow, Retry-After, Content-Type) and the set of X-Viz-* cost headers. Error messages are
// compared too, and a difference there is reported as "wording", not a failure, except where
// the app reads the text (none: it reads errorType and status).
// The real answers are written to e2e/measurements/contract-real.json (keys never included).
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const lib = require('./lib.cjs')

const ROOT = lib.ROOT
const REAL_PORT = Number(process.env.VIZ_REAL_PORT || 8851)
const MOCK_PORT = Number(process.env.VIZ_E2E_MOCK_PORT || 8861)
const REAL = `http://127.0.0.1:${REAL_PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const KEYS = path.join(ROOT, 'real/.wrangler/keys.json')
const T0 = lib.T0 / 1000
const T1 = lib.T1 / 1000

const enc = (o) => new URLSearchParams(o).toString()
/** The environment for local wrangler commands: without the Cloudflare credentials (nothing here may reach Cloudflare). */
function localEnv() {
  const env = { ...process.env }
  delete env.CLOUDFLARE_API_TOKEN
  delete env.CLOUDFLARE_ACCOUNT_ID
  return env
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function up(u) {
  try {
    const r = await fetch(u)
    await r.arrayBuffer()
    return r.status
  } catch {
    return 0
  }
}

// [name, method, path, form body | null, credential, extra headers, options]
// credential: read (a key with the read scope), readless (a valid key without it), none, bad
const CASES = [
  ['buildinfo', 'GET', '/api/v1/status/buildinfo'],
  ['metadata', 'GET', '/api/v1/metadata'],
  ['labels, all time', 'GET', '/api/v1/labels'],
  ['labels of a selector in the window', 'GET', `/api/v1/labels?${enc({ 'match[]': 'up', start: T0, end: T1 })}`],
  ['metric names in the window', 'GET', `/api/v1/label/__name__/values?${enc({ start: T0, end: T1 })}`],
  // Before 2026-01-01, where neither holds data (the mock's series start then; the real stack holds 08:00 to 14:00 of the e2e day).
  ['metric names before any data', 'GET', `/api/v1/label/__name__/values?${enc({ start: Date.UTC(2025, 11, 1) / 1000, end: Date.UTC(2025, 11, 2) / 1000 })}`],
  ['label values of a selector', 'GET', `/api/v1/label/service/values?${enc({ 'match[]': 'up', start: T0, end: T1 })}`],
  ['series', 'GET', `/api/v1/series?${enc({ 'match[]': 'up{service="auth"}', start: T0, end: T1 })}`],
  ['series without match[]', 'GET', '/api/v1/series'],
  ['series with an empty selector', 'GET', `/api/v1/series?${enc({ 'match[]': '{}' })}`],
  ['range: 4 series', 'POST', '/api/v1/query_range', { query: 'sum by (service) (rate(http_requests_total[5m]))', start: T0, end: T1, step: 60 }, 'read', {}, { values: true }],
  ['range: 36 series', 'POST', '/api/v1/query_range', { query: 'sum by (service, route, status) (rate(http_requests_total[5m]))', start: T0, end: T0 + 1800, step: 15 }, 'read', {}, { values: true }],
  ['range: 200 series', 'POST', '/api/v1/query_range', { query: 'viz_synthetic_series', start: T0, end: T1, step: 15 }, 'read', {}, { values: true }],
  ['range: p95 from a histogram', 'POST', '/api/v1/query_range', { query: 'histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))', start: T0, end: T0 + 1800, step: 60 }, 'read', {}, { values: true }],
  ['range: a series with a gap', 'POST', '/api/v1/query_range', { query: 'pod_cpu_usage_cores{pod="checkout-6b7f9-x2k4p"}', start: T0 + 4800, end: T0 + 5700, step: 60 }, 'read', {}, { values: true }],
  ['range: nothing matches', 'POST', '/api/v1/query_range', { query: 'no_such_metric_total', start: T0, end: T1, step: 15 }],
  ['range: unaligned start', 'POST', '/api/v1/query_range', { query: 'up{instance="auth-5f8a1-q9xgc"}', start: T0 + 7, end: T0 + 100, step: 30 }, 'read', {}, { values: true }],
  ['range: step of 0.5 s', 'POST', '/api/v1/query_range', { query: 'up{instance="auth-5f8a1-q9xgc"}', start: T0, end: T0 + 2, step: 0.5 }, 'read', {}, { values: true }],
  ['range: step as a duration', 'POST', '/api/v1/query_range', { query: 'up{instance="auth-5f8a1-q9xgc"}', start: T0, end: T0 + 60, step: '30s' }, 'read', {}, { values: true }],
  ['range: RFC 3339 times', 'POST', '/api/v1/query_range', { query: 'up{instance="auth-5f8a1-q9xgc"}', start: '2026-11-18T09:30:00Z', end: '2026-11-18T09:31:00Z', step: 30 }, 'read', {}, { values: true }],
  // Times and steps in whole milliseconds: start and end rounded on the fourth decimal, the step floored.
  ['range: a fractional start and a 0.25 s step', 'POST', '/api/v1/query_range', { query: 'time()', start: '1794994200.0006', end: '1794994201', step: '0.25' }, 'read', {}, { values: true }],
  ['range: a 0.1 s step', 'POST', '/api/v1/query_range', { query: 'up{instance="auth-5f8a1-q9xgc"}', start: T0, end: T0 + 0.5, step: '0.1' }, 'read', {}, { values: true }],
  ['range: a step of 1.5 ms (2 ms: the fourth decimal rounds)', 'POST', '/api/v1/query_range', { query: 'up{instance="auth-5f8a1-q9xgc"}', start: '1794994200.0004', end: '1794994200.003', step: '0.0015' }, 'read', {}, { values: true }],
  ['range: a step under 1 ms', 'POST', '/api/v1/query_range', { query: 'up', start: T0, end: T0 + 1, step: '0.0004' }],
  ['range: a step of 0.9817 s over 3 h (982 ms: 10,998 points)', 'POST', '/api/v1/query_range', { query: 'up{instance="auth-5f8a1-q9xgc"}', start: T0, end: T1, step: '0.9817' }, 'read', {}, { values: true }],
  ['range: 10,999 steps (11,000 points)', 'POST', '/api/v1/query_range', { query: '1', start: T0, end: T0 + 10999, step: 1 }, 'read', {}, { values: true }],
  ['range: 11,000 steps (11,001 points)', 'POST', '/api/v1/query_range', { query: '1', start: T0, end: T0 + 11000, step: 1 }],
  ['range: RFC 3339 with digits past the millisecond', 'POST', '/api/v1/query_range', { query: 'time()', start: '2026-11-18T09:30:00.0009Z', end: '2026-11-18T09:30:01Z', step: '0.5' }, 'read', {}, { values: true }],
  ['range: +Inf', 'POST', '/api/v1/query_range', { query: '1/0', start: T0, end: T0 + 30, step: 15 }, 'read', {}, { values: true }],
  ['range: NaN', 'POST', '/api/v1/query_range', { query: '0/0', start: T0, end: T0 + 30, step: 15 }, 'read', {}, { values: true }],
  ['range: -Inf', 'POST', '/api/v1/query_range', { query: '-1/0', start: T0, end: T0 + 30, step: 15 }, 'read', {}, { values: true }],
  ['range: GET', 'GET', `/api/v1/query_range?${enc({ query: 'up{instance="auth-5f8a1-q9xgc"}', start: T0, end: T0 + 30, step: 15 })}`],
  ['range: parse error', 'POST', '/api/v1/query_range', { query: lib.Q_BAD, start: T0, end: T1, step: 15 }],
  ['range: unknown function', 'POST', '/api/v1/query_range', { query: 'no_such_fn(up)', start: T0, end: T1, step: 15 }],
  ['range: PromQL the backend does not implement', 'POST', '/api/v1/query_range', { query: 'limitk(1, up)', start: T0, end: T0 + 60, step: 15 }],
  ['range: more than 11,000 points', 'POST', '/api/v1/query_range', { query: 'up', start: T0, end: T0 + 86400, step: 1 }],
  ['range: step 0', 'POST', '/api/v1/query_range', { query: 'up', start: T0, end: T1, step: 0 }],
  ['range: end before start', 'POST', '/api/v1/query_range', { query: 'up', start: T1, end: T0, step: 15 }],
  ['range: no query', 'POST', '/api/v1/query_range', { start: T0, end: T1, step: 15 }],
  ['range: no step', 'POST', '/api/v1/query_range', { query: 'up', start: T0, end: T1 }],
  ['range: a time that is not one', 'POST', '/api/v1/query_range', { query: 'up', start: 'yesterday', end: T1, step: 15 }],
  ['range: query text over 16 KiB', 'POST', '/api/v1/query_range', { query: 'up' + ' + up'.repeat(5000), start: T0, end: T0 + 60, step: 15 }],
  ['range: nesting deeper than 100', 'POST', '/api/v1/query_range', { query: '('.repeat(120) + 'up' + ')'.repeat(120), start: T0, end: T0 + 60, step: 15 }],
  ['range: the time limit (timeout=1ms)', 'POST', '/api/v1/query_range?delay=200', { query: 'viz_synthetic_series', start: T0, end: T1, step: 15, timeout: '1ms' }],
  ['instant: vector', 'POST', '/api/v1/query', { query: 'up{service="auth"}', time: T1 }, 'read', {}, { values: true }],
  ['instant: scalar', 'POST', '/api/v1/query', { query: '1+1', time: T1 }, 'read', {}, { values: true }],
  ['instant: string', 'POST', '/api/v1/query', { query: '"hello"', time: T1 }, 'read', {}, { values: true }],
  ['instant: range vector', 'POST', '/api/v1/query', { query: 'up{instance="auth-5f8a1-q9xgc"}[1m]', time: T1 }, 'read', {}, { values: true }],
  ['instant: no time', 'POST', '/api/v1/query', { query: '1' }],
  ['no key', 'POST', '/api/v1/query_range', { query: 'up', start: T0, end: T1, step: 15 }, 'none'],
  ['a key that does not exist', 'POST', '/api/v1/query_range', { query: 'up', start: T0, end: T1, step: 15 }, 'bad'],
  ['a key without the read scope', 'POST', '/api/v1/query_range', { query: 'up', start: T0, end: T1, step: 15 }, 'readless'],
  ['buildinfo without a key', 'GET', '/api/v1/status/buildinfo', null, 'none'],
  ['an endpoint that does not exist', 'GET', '/api/v1/status/flags'],
  ['a method an endpoint does not take', 'DELETE', '/api/v1/query'],
  ['POST to metadata', 'POST', '/api/v1/metadata', {}],
  ['a JSON body', 'POST', '/api/v1/query', 'JSON'],
  ['CORS preflight from the app', 'OPTIONS', '/api/v1/query_range', null, 'none', { Origin: 'http://127.0.0.1:8820', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }],
  ['CORS request from the app', 'POST', '/api/v1/query', { query: '1' }, 'read', { Origin: 'http://127.0.0.1:8820' }],
]

function credential(which, side, keys, mockKeys) {
  if (which === 'none') return null
  if (which === 'bad') return 'viz_AAAAAAAAAAAAAAAA_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  if (side === 'real') return which === 'readless' ? keys.write : keys.read
  return which === 'readless' ? mockKeys.readless : mockKeys.read
}

async function call(base, side, c, keys, mockKeys) {
  const [name, method, p, body, cred = 'read', extra = {}] = c
  const h = { Accept: 'application/json', ...extra }
  const key = credential(cred, side, keys, mockKeys)
  if (key) h.Authorization = `Bearer ${key}`
  let b
  if (body === 'JSON') {
    h['Content-Type'] = 'application/json'
    b = JSON.stringify({ query: '1' })
  } else if (body) {
    h['Content-Type'] = 'application/x-www-form-urlencoded'
    b = enc(body)
  }
  // The mock's per-request delay is how the time-limit case takes longer than its limit there.
  const url = base + (side === 'real' ? p.replace(/\?delay=\d+$/, '') : p)
  const res = await fetch(url, { method, headers: h, body: b })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  const headers = {}
  for (const [k, v] of res.headers) headers[k] = v
  return { status: res.status, headers, json, text }
}

/** The shape of a JSON value: types, keys, element shapes (first element), never values. */
function shape(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[${shape(v[0])}]`
  if (typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${k}:${shape(v[k])}`).join(',')}}`
  return typeof v
}

function metricShape(json) {
  // Label sets: names in sorted order, and series in label order (the real API's).
  const r = json && json.data && Array.isArray(json.data.result) ? json.data.result : Array.isArray(json && json.data) && json.data.length && typeof json.data[0] === 'object' ? json.data.map((m) => ({ metric: m })) : null
  if (!r || !r.every((s) => s && typeof s === 'object' && s.metric)) return 'n/a'
  const sortedNames = r.every((s) => { const k = Object.keys(s.metric); return k.join() === [...k].sort().join() })
  const key = (m) => Object.keys(m).sort().map((k) => `${k}\u0000${m[k]}`).join('\u0001')
  const keys = r.map((s) => key(s.metric))
  const ordered = keys.every((k, i) => i === 0 || keys[i - 1] <= k)
  return `${r.length} series; names sorted ${sortedNames}; series ordered ${ordered}`
}

const costNames = (h) => Object.keys(h).filter((k) => k.startsWith('x-viz-') && k !== 'x-viz-route' && k !== 'x-viz-mock').sort().join(',')

function compareValues(a, b) {
  const ra = a.json && a.json.data, rb = b.json && b.json.data
  if (!ra || !rb) return 'no data'
  const norm = (d) => {
    if (d.resultType === 'scalar' || d.resultType === 'string') return [{ metric: {}, values: [d.result] }]
    return d.result.map((s) => ({ metric: s.metric, values: s.values || [s.value] }))
  }
  const A = norm(ra), B = norm(rb)
  if (A.length !== B.length) return `series ${A.length} vs ${B.length}`
  let worst = 0
  for (let i = 0; i < A.length; i++) {
    if (JSON.stringify(Object.entries(A[i].metric).sort()) !== JSON.stringify(Object.entries(B[i].metric).sort())) return `labels differ at ${i}`
    if (A[i].values.length !== B[i].values.length) return `points ${A[i].values.length} vs ${B[i].values.length} in series ${i}`
    for (let k = 0; k < A[i].values.length; k++) {
      const [ta, va] = A[i].values[k], [tb, vb] = B[i].values[k]
      if (ta !== tb) return `timestamp ${ta} vs ${tb}`
      if (ra.resultType === 'string') { if (va !== vb) return `"${va}" vs "${vb}"`; continue }
      const x = Number(va === '+Inf' ? Infinity : va), y = Number(vb === '+Inf' ? Infinity : vb)
      if (Number.isNaN(x) && Number.isNaN(y)) continue
      if (x === y) continue
      const rel = Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y))
      worst = Math.max(worst, rel)
    }
  }
  return worst <= 1e-9 ? `equal (worst relative difference ${worst.toExponential(1)})` : `values differ: worst relative ${worst.toExponential(2)}`
}

async function main() {
  const started = []
  const { check, failed, results } = lib.makeChecker()
  // ---- the real stack
  if ((await up(`${REAL}/healthz`)) !== 200) {
    const s = spawnSync(process.execPath, [path.join(ROOT, 'real/stack.mjs'), 'start', '--port', String(REAL_PORT)], { stdio: 'inherit' })
    if (s.status !== 0) throw new Error('could not start the real stack')
    started.push(() => spawnSync(process.execPath, [path.join(ROOT, 'real/stack.mjs'), 'stop'], { stdio: 'inherit' }))
    const seed = spawnSync(process.execPath, [path.join(ROOT, 'real/stack.mjs'), 'seed', '--port', String(REAL_PORT)], { stdio: 'inherit' })
    if (seed.status !== 0) throw new Error('could not seed the real stack')
  }
  const keys = JSON.parse(fs.readFileSync(KEYS, 'utf8'))
  // ---- the mock, with a key and a key without the read scope (random: these are not secrets of anything)
  const mockKeys = { read: `mock_${crypto.randomBytes(8).toString('hex')}`, readless: `mock_${crypto.randomBytes(8).toString('hex')}` }
  if (await up(`${MOCK}/__mock/delay`)) throw new Error(`port ${MOCK_PORT} is in use (set VIZ_E2E_MOCK_PORT)`)
  const mock = spawn(process.execPath, ['--import', 'tsx', 'mock/server.ts', '--port', String(MOCK_PORT), '--require-token', mockKeys.read, '--readless-token', mockKeys.readless], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
  started.push(() => mock.kill('SIGTERM'))
  for (let i = 0; i < 100 && !(await up(`${MOCK}/__mock/delay`)); i++) await sleep(100)

  const record = []
  try {
    for (const c of CASES) {
      const [name] = c
      const opts = c[6] || {}
      const [r, m] = await Promise.all([call(REAL, 'real', c, keys, mockKeys), call(MOCK, 'mock', c, keys, mockKeys)])
      record.push({ name, request: { method: c[1], path: c[2].replace(/\?delay=\d+$/, ''), body: c[3] === 'JSON' ? '{"query":"1"}' : c[3] ? enc(c[3]) : null, credential: c[4] || 'read', headers: c[5] || {} }, status: r.status, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !/^(date|content-length|transfer-encoding|connection|keep-alive)$/.test(k))), body: r.text.length > 2000 ? `${r.text.slice(0, 2000)}… (${r.text.length} bytes)` : r.text })
      const diffs = []
      if (r.status !== m.status) diffs.push(`status ${r.status} vs mock ${m.status}`)
      const rj = r.json, mj = m.json
      if (!!rj !== !!mj) diffs.push(`JSON ${!!rj} vs mock ${!!mj}`)
      // The mock says it is the mock (buildinfo `mock: true`, the app's banner); nothing else may differ.
      if (mj && mj.data && mj.data.mock === true) delete mj.data.mock
      if (rj && mj) {
        if (shape(rj) !== shape(mj)) diffs.push(`shape ${shape(rj)} vs mock ${shape(mj)}`)
        if (rj.errorType !== mj.errorType) diffs.push(`errorType ${rj.errorType} vs mock ${mj.errorType}`)
        if (metricShape(rj) !== metricShape(mj)) diffs.push(`label sets: ${metricShape(rj)} vs mock ${metricShape(mj)}`)
      }
      for (const h of ['www-authenticate', 'allow', 'retry-after']) if ((r.headers[h] ?? null) !== (m.headers[h] ?? null)) diffs.push(`${h}: ${r.headers[h]} vs mock ${m.headers[h]}`)
      if (/json/.test(r.headers['content-type'] || '') !== /json/.test(m.headers['content-type'] || '') && r.status !== 204) diffs.push(`content-type ${r.headers['content-type']} vs mock ${m.headers['content-type']}`)
      if (costNames(r.headers) !== costNames(m.headers)) diffs.push(`cost headers: real ${costNames(r.headers).split(',').filter(Boolean).length}, mock ${costNames(m.headers).split(',').filter(Boolean).length}`)
      for (const h of ['access-control-allow-origin', 'access-control-expose-headers', 'vary']) if ((r.headers[h] ?? null) !== (m.headers[h] ?? null)) diffs.push(`${h}: ${r.headers[h]} vs mock ${m.headers[h]}`)
      check(`contract: ${name}`, diffs.length === 0, diffs.join('; ') || `${r.status}${rj && rj.errorType ? ` ${rj.errorType}` : ''}`)
      if (rj && mj && rj.error !== mj.error && (rj.error || mj.error)) console.log(`      wording: real "${rj.error}" / mock "${mj.error}"`)
      if (opts.values && r.status === 200 && m.status === 200) {
        const v = compareValues(r, m)
        check(`same data, same answer: ${name}`, /^equal/.test(v), v)
      }
    }
    // A refusal with Retry-After, from the real API itself: an unreadable limits record makes
    // it refuse every query with 503 and Retry-After: 30 (query/src/config.ts). The record is
    // put in the stack's local KV, and the mock is told to fail the same way.
    if (!process.env.VIZ_CONTRACT_SKIP_KV) {
      const wrangler = (args) => spawnSync(process.execPath, [path.resolve(ROOT, '../query/node_modules/wrangler/bin/wrangler.js'), 'kv', 'key', ...args, '--local', '-c', 'wrangler.jsonc', '--persist-to', '.wrangler/state', '--binding', 'CONFIG'], { cwd: path.join(ROOT, 'real'), env: localEnv(), stdio: 'ignore' })
      wrangler(['put', `limits:${keys.tenant}`, '{"maxSamples":-1}'])
      try {
        // The query Worker keeps a tenant's limits for 30 s.
        const c = ['an unreadable limits record (real), /__mock/fail?kind=config (mock)', 'POST', '/api/v1/query_range', { query: 'up', start: T0, end: T0 + 60, step: 15 }]
        let r
        for (let i = 0; i < 40; i++) {
          r = await call(REAL, 'real', c, keys, mockKeys)
          if (r.status === 503) break
          await sleep(1000)
        }
        await fetch(`${MOCK}/__mock/fail?kind=config&count=1`).then((x) => x.arrayBuffer())
        const m = await call(MOCK, 'mock', c, keys, mockKeys)
        record.push({ name: c[0], request: { method: 'POST', path: c[2], body: enc(c[3]), credential: 'read', headers: {} }, status: r.status, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !/^(date|content-length|transfer-encoding|connection|keep-alive)$/.test(k))), body: r.text })
        const diffs = []
        if (r.status !== m.status) diffs.push(`status ${r.status} vs mock ${m.status}`)
        if ((r.json && r.json.errorType) !== (m.json && m.json.errorType)) diffs.push(`errorType ${r.json && r.json.errorType} vs mock ${m.json && m.json.errorType}`)
        if ((r.headers['retry-after'] ?? null) !== (m.headers['retry-after'] ?? null)) diffs.push(`retry-after ${r.headers['retry-after']} vs mock ${m.headers['retry-after']}`)
        if (costNames(r.headers) !== costNames(m.headers)) diffs.push('cost headers differ')
        if ((r.json && r.json.error) !== (m.json && m.json.error)) diffs.push(`error "${r.json && r.json.error}" vs mock "${m.json && m.json.error}"`)
        check(`contract: ${c[0]}`, diffs.length === 0, diffs.join('; ') || `${r.status} ${r.json.errorType}, Retry-After ${r.headers['retry-after']}`)
      } finally {
        wrangler(['delete', `limits:${keys.tenant}`])
      }
    }
  } finally {
    const out = path.join(ROOT, 'e2e', 'measurements', 'contract-real.json')
    fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), real: 'real/stack.mjs (wrangler dev --local: deploy/gateway, stack, query, control)', cases: record }, null, 2) + '\n')
    for (const stop of started.reverse()) stop()
  }
  console.log(`\n${results.length - failed()} of ${results.length} checks pass`)
  process.exit(failed() ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
