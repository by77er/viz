/* eslint-disable */
// Before and after images of the move to design system v9, through
// design-system/tools/shots.mjs scenarios: every view and state, both themes, 1440 and 400 px,
// the same mock, the same data and the same steps for both builds, then composed side by side.
//
//   node e2e/v9-shots.cjs <before app dir> <after app dir> <work dir> <compare dir> [only,names]
//
// Both app dirs must have a dist/ (each is served by `vite preview` from its own dir). One
// mock serves both builds, and a second, which requires a key as viz does, serves the
// sign-in states. The single images go to <work dir>/before and <work dir>/after (not kept in
// the repository: each is half of a pair), the pairs to <compare dir>, palette-encoded so that
// a token colour is never shifted (encode below, as e2e/encode-review-images.py does).
//
// A state names what a person did, and how it is done in each build where the two differ
// (the legend row, the plot, where Settings is). A state one build cannot reach has null for
// it, and its pair says "New view: nothing to compare".
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const lib = require('./lib.cjs')

const [beforeDir, afterDir, work, compare, onlyArg] = process.argv.slice(2).map((p, i) => (i < 4 ? path.resolve(p) : p))
const only = (onlyArg || '').split(',').filter(Boolean)
const SHOTS = path.resolve(lib.ROOT, '../design-system/tools/shots.mjs')
const PORT = Number(process.env.VIZ_SHOTS_PORT || 18980)
const MOCK = `http://127.0.0.1:${PORT + 2}`
const KEYED = `http://127.0.0.1:${PORT + 3}`
const KEY = 'viz_e2eReadKey0000000_goodSecret'
const WRITE = 'viz_e2eWriteKey000000_writeOnly'
const W = `from=${lib.T0}&to=${lib.T1}`
const q = (s) => encodeURIComponent(s)
const explore = (query, extra = '') => `/explore?q=${q(query)}&${W}${extra}`
const Q_MEM = 'pod_memory_working_set_bytes'

// How the same act is done in each build.
const B = { plot: '.u-over', row: '[data-testid=legend] tbody tr .series-toggle', legend: '[data-testid=legend] tbody tr', other: '[data-testid=legend-other] button, [data-testid=legend-other]', zoomIn: '[data-testid=zoom-in]' }
const A = { plot: 'svg.vz-plot', row: '[data-testid=chart] tbody tr[data-key] .vz-series', legend: '[data-testid=chart] tbody tr[data-key]', other: '[data-more]', zoomIn: '[data-testid=chart] [data-zoom=in]' }
const delay = (ms) => ({ eval: `fetch('${MOCK}/__mock/delay?ms=${ms}')` })
const typeAndRun = (query) => [{ click: '.query-well .cm-content' }, { key: 'Control+a' }, { type: ['.query-well .cm-content', query] }, { key: 'Escape' }, { key: 'Control+Enter' }]
const settle = { wait: 900 }
// The key as each build keeps it: the app before kept a token in localStorage (Settings), the app after keeps it in the tab.
const keyBefore = (k) => [{ eval: `localStorage.setItem('viz.settings', JSON.stringify({ baseUrl: '', token: '${k}' })); location.reload()` }, { wait: 1800 }]
const noKeyBefore = [{ eval: "localStorage.removeItem('viz.settings'); location.reload()" }, { wait: 1800 }]
const signIn = (k) => [{ wait: 600 }, { type: ['[data-testid=sign-in-key]', k] }, { click: '[data-testid=sign-in-submit]' }, { wait: 1500 }]

/**
 * name; url (the same for both builds unless `urls`); steps as { before, after } (a function of
 * the build's selectors, an array for both, or null where a build has no such state); `only`:
 * one width; `opts`: shots.mjs state options (coarse, zoom, greyscale, measure, height).
 */
const STATES = [
  // ---- every view, opened by its address
  { name: 'explore', url: explore(lib.Q_RATE), steps: [settle] },
  { name: 'many-series-36', url: explore(lib.Q_MANY), steps: [settle] },
  { name: 'many-series-200', url: explore('viz_synthetic_series'), steps: [{ wait: 1500 }] },
  { name: 'gap', url: explore(lib.Q_CPU), steps: [settle] },
  { name: 'bytes', url: explore(Q_MEM), steps: [settle] },
  { name: 'p95-seconds', url: explore(lib.Q_P95), steps: [settle] },
  { name: 'no-unit', url: explore('up'), steps: [settle] },
  { name: 'one-series-no-labels', url: explore('sum(rate(http_requests_total[5m]))'), steps: [settle] },
  { name: 'table', url: explore(lib.Q_RATE, '&view=table'), steps: [settle] },
  { name: 'table-36', url: explore(lib.Q_MANY, '&view=table'), steps: [settle] },
  { name: 'text', url: explore(lib.Q_MANY, '&view=text'), steps: [settle] },
  { name: 'json', url: explore(lib.Q_RATE, '&view=json'), steps: [settle] },
  { name: 'empty', url: explore('no_such_metric_total'), steps: [settle] },
  { name: 'error', url: explore(lib.Q_BAD), steps: [settle] },
  { name: 'error-step-too-small', url: explore(lib.Q_RATE, '&step=500ms'), steps: [settle] },
  { name: 'start', url: '/explore', steps: [settle] },
  { name: 'help', url: '/help', steps: [{ wait: 400 }] },
  { name: 'settings', urls: { before: explore(lib.Q_RATE), after: '/settings' }, steps: { before: [settle, { click: '[data-testid=open-settings]' }, { wait: 300 }], after: [settle] } },
  // ---- what a person does
  { name: 'crosshair', url: explore(lib.Q_RATE), steps: (s) => [settle, { hover: s.plot }, { wait: 300 }], only: 1440 },
  { name: 'crosshair-36', url: explore(lib.Q_MANY), steps: (s) => [settle, { hover: s.plot }, { wait: 300 }] },
  { name: 'legend-row-chosen', url: explore(lib.Q_RATE), steps: (s) => [settle, { click: s.row }, { wait: 300 }, { hover: 'h1' }] },
  { name: 'legend-row-focus', url: explore(lib.Q_RATE), steps: (s) => [settle, { focus: s.row }, { wait: 200 }], only: 1440 },
  { name: 'legend-row-pressed', url: explore(lib.Q_RATE), steps: (s) => [settle, { press: s.row }, { wait: 150 }], only: 1440 },
  { name: 'other-opened', url: explore(lib.Q_MANY), steps: (s) => [settle, { click: s.other }, { wait: 300 }] },
  { name: 'zoomed-in', url: explore(lib.Q_RATE), steps: (s) => [settle, { click: s.zoomIn }, { wait: 1200 }] },
  { name: 'command-palette', url: explore(lib.Q_RATE), steps: [settle, { key: 'Control+k' }, { wait: 300 }] },
  { name: 'time-range', url: explore(lib.Q_RATE), steps: { before: [settle, { click: '[data-testid=time-range]' }, { wait: 300 }], after: [settle, { focus: '[data-testid=time-from]' }, { wait: 200 }] } },
  { name: 'time-range-not-read', url: explore(lib.Q_RATE), steps: { before: null, after: [settle, { click: '[data-testid=time-from]' }, { key: 'Control+a' }, { type: ['[data-testid=time-from]', 'last tuesday'] }, { key: 'Enter' }, { wait: 300 }] } },
  { name: 'focus-run-query', url: explore(lib.Q_RATE), steps: [settle, { focus: '[data-testid=run]' }], only: 1440 },
  { name: 'focus-query-editor', url: explore(lib.Q_RATE), steps: [settle, { click: '.query-well .cm-content' }, { wait: 200 }], only: 1440 },
  { name: 'error-after-a-result', url: explore(lib.Q_RATE), steps: [settle, ...typeAndRun(lib.Q_BAD), { wait: 1200 }] },
  // ---- touch, zoom, greyscale
  { name: 'touch', url: explore(lib.Q_RATE), steps: [settle], only: 400, opts: { coarse: true } },
  { name: 'touch-hit-areas', url: explore(lib.Q_MANY), steps: [settle], only: 400, opts: { coarse: true, measure: true, outline: true } },
  { name: 'touch-table', url: explore(lib.Q_MANY, '&view=table'), steps: [settle], only: 400, opts: { coarse: true } },
  { name: 'touch-320', url: explore(lib.Q_MANY), steps: [settle], only: 400, opts: { coarse: true, width: 320, measure: true } },
  { name: 'zoom-200', url: explore(lib.Q_MANY), steps: [settle], only: 1440, opts: { zoom: 2, measure: true } },
  { name: 'greyscale', url: explore(lib.Q_MANY), steps: [settle], only: 1440, opts: { greyscale: true } },
  // ---- waiting (the mock answers queries late; each state first makes it prompt again, and ends by leaving it so)
  { name: 'waiting-1s', url: explore(lib.Q_RATE), steps: [delay(0), settle, delay(3000), { wait: 150 }, { click: '[data-testid=run]' }, { wait: 1000 }] },
  { name: 'waiting-cancel-offered', url: explore(lib.Q_RATE), steps: [delay(0), settle, delay(4000), { wait: 150 }, { click: '[data-testid=run]' }, { wait: 2500 }] },
  { name: 'waiting-previous-query', url: explore(lib.Q_RATE), steps: [delay(0), { wait: 1200 }, delay(4000), { wait: 150 }, ...typeAndRun(lib.Q_CPU), { wait: 1200 }] },
  { name: 'cancelled', url: explore(lib.Q_RATE), steps: [delay(0), { wait: 1200 }, delay(4000), { wait: 150 }, ...typeAndRun(lib.Q_CPU), { wait: 2400 }, { click: '[data-testid=cancel]' }, { wait: 300 }] },
  { name: 'first-result-waiting', url: explore(lib.Q_MANY), steps: [delay(0), { wait: 1200 }, delay(2500), { wait: 150 }, { eval: 'location.reload()' }, { wait: 1300 }] },
  { name: 'prompt-again', url: '/help', steps: [delay(0), { wait: 300 }], only: 400, themes: ['light'], skipCompare: true },
  // ---- sign-in, on an API that requires a key
  { name: 'no-key', keyed: true, url: explore(lib.Q_RATE), steps: { before: noKeyBefore, after: [{ wait: 900 }] } },
  { name: 'key-refused', keyed: true, url: explore(lib.Q_RATE), steps: { before: keyBefore('viz_e2eReadKey0000000_wrongSecret'), after: signIn('viz_e2eReadKey0000000_wrongSecret') } },
  { name: 'key-without-read-scope', keyed: true, url: explore(lib.Q_RATE), steps: { before: keyBefore(WRITE), after: signIn(WRITE) } },
  { name: 'signed-in', keyed: true, url: explore(lib.Q_RATE), steps: { before: keyBefore(KEY), after: signIn(KEY) } },
  { name: 'settings-signed-in', keyed: true, urls: { before: explore(lib.Q_RATE), after: explore(lib.Q_RATE) }, steps: { before: [...keyBefore(KEY), { click: '[data-testid=open-settings]' }, { wait: 300 }], after: [...signIn(KEY), { click: '.vz-nav a[href="/settings"]' }, { wait: 600 }] } },
  { name: 'signed-out', keyed: true, url: explore(lib.Q_RATE), steps: { before: null, after: [...signIn(KEY), { click: '.vz-nav a[href="/settings"]' }, { wait: 500 }, { click: '[data-testid=sign-out]' }, { wait: 300 }, { click: '.vz-nav a[href="/explore"]' }, { wait: 500 }] } },
]

/** Stored with a 256-colour palette that holds every token colour exactly (see e2e/encode-review-images.py). */
function encode(dir) {
  const py = `
import glob, json, os, re, sys
import numpy as np
from PIL import Image
tokens = json.load(open(sys.argv[2]))
forced = []
for t in tokens['color']['tokens']:
    for v in ([t['value']] if isinstance(t['value'], str) else t['value'].values()):
        if re.fullmatch(r'#[0-9a-fA-F]{6}', v):
            rgb = tuple(int(v[i:i + 2], 16) for i in (1, 3, 5))
            if rgb not in forced: forced.append(rgb)
for path in sorted(glob.glob(os.path.join(sys.argv[1], '*.png'))):
    im = Image.open(path).convert('RGB')
    px = np.asarray(im).reshape(-1, 3)
    uniq, inverse, counts = np.unique(px, axis=0, return_inverse=True, return_counts=True)
    colours = list(forced); seen = set(forced)
    for i in np.argsort(-counts):
        c = tuple(int(x) for x in uniq[i])
        if c not in seen:
            colours.append(c); seen.add(c)
        if len(colours) >= 256: break
    pal = np.array(colours, dtype=np.int32)
    lut = np.empty(len(uniq), dtype=np.uint8)
    for s in range(0, len(uniq), 4096):
        chunk = uniq[s:s + 4096].astype(np.int32)
        lut[s:s + 4096] = np.argmin(((chunk[:, None, :] - pal[None, :, :]) ** 2).sum(axis=2), axis=1)
    out = Image.fromarray(lut[inverse].reshape(im.height, im.width), 'P')
    out.putpalette([v for c in colours for v in c] + [0] * (768 - 3 * len(colours)))
    out.save(path, optimize=True)
`
  const r = spawnSync('python3', ['-c', py, dir, path.resolve(lib.ROOT, '../design-system/project/tokens.json')], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('encoding the images failed')
}

async function main() {
  const stops = [await lib.startMock(PORT + 2), await lib.startMock(PORT + 3, ['--require-token', KEY, '--readless-token', WRITE])]
  try {
    for (const [label, dir, port, sel] of [['before', beforeDir, PORT, B], ['after', afterDir, PORT + 1, A]]) {
      // Two previews of the build: one on the mock that needs no key, one on the mock that does.
      const stopOpen = await lib.startPreview(port, MOCK, dir)
      const stopKeyed = await lib.startPreview(port + 4, KEYED, dir)
      try {
        const states = []
        for (const s of STATES) {
          if (only.length && !only.some((o) => s.name.startsWith(o)) && s.name !== 'prompt-again') continue
          const steps = typeof s.steps === 'function' ? s.steps(sel) : Array.isArray(s.steps) ? s.steps : s.steps[label]
          if (steps === null) continue
          const origin = `http://127.0.0.1:${s.keyed ? port + 4 : port}`
          const url = origin + (s.urls ? s.urls[label] : s.url)
          for (const width of [1440, 400]) {
            if (s.only && s.only !== width) continue
            const opts = { ...(s.opts || {}) }
            const w = opts.width || width
            delete opts.width
            states.push({ name: `${s.name}-${opts.zoom || opts.coarse || opts.greyscale ? '' : `${width}`}`.replace(/-$/, ''), url, width: w, scale: 1, steps, ...(s.themes ? { themes: s.themes } : {}), ...opts })
          }
        }
        const scenario = { url: `http://127.0.0.1:${port}/explore`, name: 'app-v9', states }
        fs.mkdirSync(path.join(work, label), { recursive: true })
        const file = path.join(work, `scenario-${label}.json`)
        fs.writeFileSync(file, JSON.stringify(scenario, null, 1))
        const r = spawnSync(process.execPath, [SHOTS, 'scenario', file, path.join(work, label)], { cwd: lib.ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        fs.writeFileSync(path.join(work, `scenario-${label}.log`), r.stdout + r.stderr)
        process.stdout.write(r.stdout.split('\n').filter((l) => /page error|SMALL|COVERED|OVERLAP|overflow [1-9]|hit areas/.test(l)).map((l) => `[${label}] ${l}`).join('\n') + '\n')
        if (r.status !== 0) throw new Error(`shots.mjs scenario failed for ${label}: ${r.stderr.slice(-600)}`)
      } finally {
        stopOpen()
        stopKeyed()
      }
    }
    for (const dir of ['before', 'after']) for (const f of fs.readdirSync(path.join(work, dir))) if (f.includes('prompt-again')) fs.rmSync(path.join(work, dir, f))
    const r = spawnSync(process.execPath, [SHOTS, 'compare', path.join(work, 'before'), path.join(work, 'after'), compare, 'Before (the app as it was, on v9\'s stylesheet)', 'After (this change)'], { stdio: 'inherit', cwd: lib.ROOT })
    if (r.status !== 0) throw new Error('shots.mjs compare failed')
    encode(compare)
    console.log(`${fs.readdirSync(compare).filter((f) => f.endsWith('.png')).length} pairs in ${compare}`)
  } finally {
    for (const s of stops) s()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
