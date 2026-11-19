/* eslint-disable */
// Before/after images of what this change alters on screen (the error states, the waiting
// line when the API is busy, the warnings banner), through design-system/tools/shots.mjs
// scenarios: both themes, 1440 and 400 px, the same mock and the same failures for both builds.
//
//   node e2e/real-api-shots.cjs <before app dir> <after app dir> <out dir>
//
// Both app dirs must have a dist/ (each is served by `vite preview` from its own dir). One
// mock serves both, requiring a key as the real API does (`e2e-read`, and `e2e-write` without
// the read scope), and is told to fail as the real API fails (mock/server.ts, /__mock/fail).
// Then: node ../design-system/tools/shots.mjs compare <out>/before <out>/after <out>/compare
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const lib = require('./lib.cjs')

const [beforeDir, afterDir, out] = process.argv.slice(2).map((p) => path.resolve(p))
const SHOTS = path.resolve(lib.ROOT, '../design-system/tools/shots.mjs')
const PORT = Number(process.env.VIZ_SHOTS_PORT || 18980)
const MOCK = `http://127.0.0.1:${PORT + 2}`
const W = `from=${lib.T0}&to=${lib.T1}`
const q = (s) => encodeURIComponent(s)

/** The key the app sends (Settings, in localStorage), then a reload so it is used from the start. */
const key = (k) => ({ eval: `localStorage.setItem('viz.settings', JSON.stringify({ baseUrl: '', token: '${k}' })); setTimeout(() => location.reload(), 50)` })
const fail = (kind, count) => ({ eval: `fetch('${MOCK}/__mock/fail?kind=${kind}&count=${count}')` })
// Every state starts by clearing the mock's queued failures: the app before this change does
// not retry, so failures queued for one state (four `platform` answers) would otherwise be
// answered to the next state's queries. The clearing step runs before the key's reload.
const clear = { eval: `fetch('${MOCK}/__mock/fail?count=0')` }
const states = (name, steps) => [1440, 400].map((width) => ({ name: `${name}-${width}`, width, steps: [clear, { wait: 200 }, ...steps] }))
const STATES = [
  // A parse error: the API gives no position; the editor's parser does (after).
  ...states('parse-error', [key('e2e-read'), { wait: 2500 }]).map((s) => ({ ...s, url: `/explore?q=${q(lib.Q_BAD)}&${W}` })),
  // No key: 401. A key without the read scope: 403.
  ...states('no-key-401', [{ eval: "localStorage.removeItem('viz.settings')" }, { wait: 2500 }]),
  ...states('readless-key-403', [key('e2e-write'), { wait: 2500 }]),
  // The API's time limit: 503 timeout.
  ...states('timeout-503', [key('e2e-read'), { wait: 2500 }, fail('timeout', 1), { wait: 300 }, { click: '[data-testid=run]' }, { wait: 2000 }]),
  // Busy: the real API's 503 with Retry-After: 1, four times; the image at 0.7 s, while the first retry waits.
  ...states('busy-503', [key('e2e-read'), { wait: 2500 }, fail('busy', 4), { wait: 300 }, { click: '[data-testid=run]' }, { wait: 700 }]),
  // A 503 page that is not the API's (no envelope, no Retry-After), four times: the error state after 1 + 2 + 4 s.
  ...states('platform-503', [key('e2e-read'), { wait: 2500 }, fail('platform', 4), { wait: 300 }, { click: '[data-testid=run]' }, { wait: 9000 }]),
  // A key the API does not know: 401 (the banner and the error state say the key was not accepted).
  ...states('unknown-key-401', [key('e2e-unknown'), { wait: 2500 }]),
  // A step too small for the range: 400 "exceeded maximum resolution" (about the step, not the query).
  ...states('step-too-small-400', [key('e2e-read'), { wait: 2500 }]).map((s) => ({ ...s, url: `/explore?q=${q(lib.Q_RATE)}&${W}&step=500ms` })),
  // A warning with the result (a Prometheus-compatible store answering in part).
  ...states('warning', [key('e2e-read'), { wait: 2500 }, { eval: `fetch('${MOCK}/__mock/warn?text=${q('partial response: 1 of 4 stores did not answer')}&count=1')` }, { wait: 300 }, { click: '[data-testid=run]' }, { wait: 2500 }]),
]

async function main() {
  const stops = [await lib.startMock(PORT + 2, ['--require-token', 'e2e-read', '--readless-token', 'e2e-write'])]
  try {
    for (const [label, dir, port] of [['before', beforeDir, PORT], ['after', afterDir, PORT + 1]]) {
      const stop = await lib.startPreview(port, MOCK, dir)
      try {
        const scenario = { url: `http://127.0.0.1:${port}/explore?q=${q(lib.Q_RATE)}&${W}`, name: 'real-api', states: STATES.map((s) => ({ ...s, ...(s.url ? { url: `http://127.0.0.1:${port}${s.url}` } : {}) })) }
        const file = path.join(out, `scenario-${label}.json`)
        fs.mkdirSync(path.join(out, label), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(scenario, null, 2))
        const r = spawnSync(process.execPath, [SHOTS, 'scenario', file, path.join(out, label)], { stdio: 'inherit', cwd: lib.ROOT })
        if (r.status !== 0) throw new Error(`shots.mjs scenario failed for ${label}`)
      } finally {
        stop()
      }
    }
  } finally {
    for (const s of stops) s()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
