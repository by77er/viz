// zoom.cjs: a new window of the same series (the chart's own Zoom in / Zoom out), timed in the page: the click's handler (the draw) and
// the style and layout forced right after it, at CPU 4x. Two builds, alternated round by round, each in its own page and server.
//   node zoom.cjs --lib <app>/e2e/lib.cjs --builds a=<app>,b=<app> [--series 36] [--n 30] [--phone] [--rounds 4]
const path = require('node:path'); const { spawn } = require('node:child_process'); const http = require('node:http')
const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : f }
const lib = require(path.resolve(arg('lib'))); const SERIES = Number(arg('series', '36')); const N = Number(arg('n', '30')); const ROUNDS = Number(arg('rounds', '4')); const PHONE = process.argv.includes('--phone')
const Q = { 4: lib.Q_RATE, 36: lib.Q_MANY, 200: 'viz_synthetic_series' }[SERIES]
const MOCK = Number(process.env.VIZ_E2E_MOCK_PORT); const BASE = Number(process.env.VIZ_AB_PORT)
const BUILDS = arg('builds').split(',').map((x, k) => ({ name: x.split('=')[0], root: path.resolve(x.split('=')[1]), port: BASE + k }))
const get = (u) => new Promise((res) => { const r = http.get(u, (x) => { x.resume(); x.on('end', () => res(x.statusCode)) }); r.on('error', () => res(0)) })
const up = async (u) => { for (let i = 0; i < 200; i++) { if (await get(u)) return; await new Promise((r) => setTimeout(r, 150)) } throw new Error(u) }
const T0 = Date.UTC(2026, 10, 18, 9, 30), T1 = Date.UTC(2026, 10, 18, 12, 30)
;(async () => {
  const procs = []; const start = (cwd, args) => { const p = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, VIZ_API_TARGET: `http://127.0.0.1:${MOCK}` } }); procs.push(p) }
  start(lib.ROOT, ['--import', 'tsx', path.join(lib.ROOT, 'mock/server.ts'), '--port', String(MOCK)])
  for (const B of BUILDS) start(B.root, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(B.port), '--host', '127.0.0.1', '--strictPort'])
  await up(`http://127.0.0.1:${MOCK}/api/v1/status/buildinfo`); for (const B of BUILDS) await up(`http://127.0.0.1:${B.port}/`)
  const browser = await lib.chromium.launch(); const all = Object.fromEntries(BUILDS.map((b) => [b.name, []]))
  try {
    for (let r = 0; r < ROUNDS; r++) for (const B of r % 2 ? [...BUILDS].reverse() : BUILDS) {
      const ctx = await browser.newContext(PHONE ? { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } })
      const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${B.port}/explore?q=${encodeURIComponent(Q)}&from=${T0}&to=${T1}`)
      await page.waitForSelector('[data-testid=chart] tbody tr[data-key]'); await page.waitForTimeout(1200)
      const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      const xs = await page.evaluate(async (N) => {
        const root = document.querySelector('[data-testid=chart]'), zin = root.querySelector('[data-zoom="in"]'), zout = root.querySelector('[data-zoom="out"]'), out = []
        for (let i = 0; i < N; i++) for (const b of [zin, zout]) {
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)))
          const t0 = performance.now(); b.click(); const t1 = performance.now(); void document.documentElement.offsetHeight; const t2 = performance.now()
          out.push({ draw: t1 - t0, layout: t2 - t1, total: t2 - t0 })
        }
        return out
      }, N)
      all[B.name].push(...xs); await ctx.close()
    }
  } finally { await browser.close(); procs.forEach((p) => p.kill()) }
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.ceil(p * s.length) - 1].toFixed(1) }
  for (const [k, xs] of Object.entries(all)) console.log(k.padEnd(8), `n ${xs.length}`, ['draw', 'layout', 'total'].map((f) => `${f} median ${q(xs.map((x) => x[f]), 0.5)} p75 ${q(xs.map((x) => x[f]), 0.75)}`).join('; '))
  console.log(JSON.stringify(all))
})().catch((e) => { console.error(e); process.exit(1) })
