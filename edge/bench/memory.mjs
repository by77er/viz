// Heap per request of edge's decoders, in Node and in workerd, for hostile and realistic bodies.
//
//   node bench/memory.mjs                    every case, Node and workerd
//   node bench/memory.mjs --node traces      only Node, only cases whose name contains "traces"
//   node bench/memory.mjs --workerd --json   workerd only, one JSON line per case
//   node bench/memory.mjs --dump DIR         write each case's body to DIR, measure nothing
//   MEM_SRC=/copy/of/src node bench/memory.mjs   measure another copy of src/ (a before/after pair)
//   MEM_MIB=2 node bench/memory.mjs          hostile bodies of 2 MiB instead of 4
//
// Each case runs in a fresh process (Node) or a fresh workerd (one isolate), with V8's
// `--expose-gc --trace-gc`: a forced GC before the request gives the baseline, a forced GC after
// it (the request's objects still held) gives what it retains, and the largest heap size any GC
// in between saw before collecting is the peak (V8's heap only grows between two GCs, so its
// maximum is reached just before one). "Peak" includes garbage not yet collected; "live" is the
// largest heap any GC in the window left behind. Both are the V8 heap only: ArrayBuffer backing
// stores (the body, collector buffers, batches) are outside it and are reported separately by
// Node as `arrayBuffers`. workerd has no API for that, so its column is the V8 heap only.
//
// The bodies are built here: hostile shapes by hand on the wire (each a few bytes per item, the
// shapes of review M-3 and the ones found while fixing it), realistic ones with protobufjs in the
// shape of an instrumented HTTP service (bench/otel.mjs) at about 8,192 items (8,200), the OpenTelemetry
// Collector batch processor's default `send_batch_size` (training knowledge, not verified here).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MiB, NOW, hostile, realistic } from './bodies.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ───────────────────────────── child (Node) ─────────────────────────────

if (process.argv[2] === '--child') {
  const [bundle, bodyFile, specJson] = process.argv.slice(3)
  const E = await import(pathToFileURL(bundle).href)
  const { runCase } = await import(pathToFileURL(join(HERE, 'memory-run.mjs')).href)
  const spec = JSON.parse(specJson)
  const body = new Uint8Array(readFileSync(bodyFile))
  const { writeSync } = await import('node:fs')
  writeSync(1, 'MARK begin\n')
  globalThis.gc()
  const ab0 = process.memoryUsage().arrayBuffers
  const t0 = performance.now()
  const r = runCase(E, { ...spec, body, now: spec.now })
  const ms = performance.now() - t0
  globalThis.gc()
  const ab1 = process.memoryUsage().arrayBuffers
  writeSync(1, `MARK end ${JSON.stringify({ outcome: r.outcome, rows: r.rows, rejected: r.rejected, reasons: r.reasons.slice(0, 200), decoded: r.decoded, ms, arrayBuffersMiB: (ab1 - ab0) / 2 ** 20 })}\n`)
  r.keep.length = 0
  process.exit(0)
}

// ───────────────────────────── bundle ─────────────────────────────

/** The sources measured: edge's own, or another copy of them (MEM_SRC=/path/to/src, to compare). */
const SRC = process.env.MEM_SRC ?? './src'

async function bundle(dir) {
  const { build } = await import('esbuild')
  const out = join(dir, 'edge.mjs')
  await build({
    stdin: {
      contents: [
        `export { SpanCollector, decodeTracesProto, decodeTracesJson } from '${SRC}/spans'`,
        `export { LogCollector, decodeLogsProto, decodeLogsJson, decodeLokiProto, decodeLokiJson } from '${SRC}/logs'`,
        `export { DEFAULT_LIMITS } from '${SRC}/limits'`,
        `export { snappyDecompress } from '${SRC}/snappy'`,
        `export { decodeOtlpProto, decodeOtlpJson } from '${SRC}/otlp'`,
        `export { Collector, buildBatches } from '${SRC}/batch'`,
      ].join('\n'),
      resolveDir: join(HERE, '..'), loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error',
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: /shard\/src\/shard$/ }, () => ({ path: 'shard', namespace: 'shard-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'shard-stub' }, () => ({ contents: 'export const MAX_BATCH_BYTES = 1_048_576', loader: 'js' }))
    } }],
  })
  return out
}

// ───────────────────────────── GC trace ─────────────────────────────

const GC = /(Scavenge|Mark-Compact|Mark-Sweep|Minor Mark-Sweep|Minor Mark-Compact)\S*\s+([\d.]+) \(([\d.]+)\) -> ([\d.]+) \(([\d.]+)\) MB, [^\n]*?([\d.]+) \/ [\d.]+ ms/
const STAMP = /\]\s+(\d+) ms:/

/** Peak, live and retained heap (MiB) between `MARK begin` and `MARK end`. */
function window(text) {
  const lines = text.split('\n')
  const b = lines.findIndex((l) => l.includes('MARK begin'))
  const e = lines.findIndex((l, i) => i > b && l.includes('MARK end'))
  if (b < 0 || e < 0) return null
  const gcs = lines.slice(b + 1, e).map((l) => [l.match(GC), l.match(STAMP)]).filter(([m]) => m).map(([m, s]) => ({ before: +m[2], after: +m[4], ms: s ? +s[1] : 0 }))
  if (gcs.length < 2) return null
  const base = gcs[0].after
  const last = gcs[gcs.length - 1]
  const peak = Math.max(...gcs.slice(1).map((g) => g.before)) - base
  const live = Math.max(...gcs.slice(1).map((g) => g.after)) - base
  const end = lines[e].slice(lines[e].indexOf('MARK end') + 9).trim()
  let info = {}
  try {
    info = JSON.parse(end)
  } catch {}
  return { peak, live, retained: last.after - base, gcs: gcs.length - 2, wallMs: last.ms - gcs[0].ms, ...info }
}

function runNode(bundlePath, bodyFile, spec) {
  const r = spawnSync(process.execPath, ['--expose-gc', '--trace-gc', '--max-old-space-size=1400', fileURLToPath(import.meta.url), '--child', bundlePath, bodyFile, JSON.stringify(spec)], { encoding: 'utf8', maxBuffer: 64 << 20 })
  return window(r.stdout) ?? { error: (r.stderr || r.stdout).slice(-300) }
}

const WORKERD = join(HERE, '..', 'node_modules', '.bin', 'workerd')

async function runWorkerd(dir, bundlePath, bodyFile, spec, port) {
  const d = mkdtempSync(join(dir, 'wd-'))
  writeFileSync(join(d, 'edge.mjs'), readFileSync(bundlePath))
  writeFileSync(join(d, 'memory-run.mjs'), readFileSync(join(HERE, 'memory-run.mjs')))
  writeFileSync(join(d, 'body.bin'), readFileSync(bodyFile))
  writeFileSync(join(d, 'spec.json'), JSON.stringify(spec))
  writeFileSync(join(d, 'worker.mjs'), `
import * as E from './edge.mjs'
import { runCase } from './memory-run.mjs'
import raw from './body.bin'
import spec from './spec.json'
export default {
  async fetch() {
    const body = new Uint8Array(raw.slice(0))
    console.log('MARK begin')
    gc()
    const r = runCase(E, { ...spec, body })
    gc()
    console.log('MARK end ' + JSON.stringify({ outcome: r.outcome, rows: r.rows, rejected: r.rejected, reasons: r.reasons.slice(0, 200) }))
    r.keep.length = 0
    return new Response('done')
  },
}
`)
  writeFileSync(join(d, 'c.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .w) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
  v8Flags = ["--expose-gc", "--trace-gc"],
);
const w :Workerd.Worker = (
  modules = [
    (name = "worker.mjs", esModule = embed "worker.mjs"),
    (name = "edge.mjs", esModule = embed "edge.mjs"),
    (name = "memory-run.mjs", esModule = embed "memory-run.mjs"),
    (name = "body.bin", data = embed "body.bin"),
    (name = "spec.json", json = embed "spec.json"),
  ],
  compatibilityDate = "2026-11-01",
);
`)
  const child = spawn(WORKERD, ['serve', join(d, 'c.capnp'), '--verbose'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  child.stderr.on('data', (b) => (out += b))
  try {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(600_000) })
        await res.text()
        break
      } catch (e) {
        if (i > 100 || e.name === 'TimeoutError') throw e
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  } catch (e) {
    child.kill('SIGKILL')
    return { error: String(e).slice(0, 200) + ' ' + out.slice(-300) }
  }
  child.kill('SIGKILL')
  return window(out) ?? { error: out.slice(-300) }
}

// ───────────────────────────── main ─────────────────────────────

const args = process.argv.slice(2)
const wantNode = !args.includes('--workerd') || args.includes('--node')
const wantWorkerd = !args.includes('--node') || args.includes('--workerd')
const asJson = args.includes('--json')
const dumpAt = args.indexOf('--dump')
const dump = dumpAt >= 0 ? args.splice(dumpAt, 2)[1] : null
const filters = args.filter((a) => !a.startsWith('--'))
const mib = Number(process.env.MEM_MIB ?? 4)

const dir = mkdtempSync(join(tmpdir(), 'viz-edge-mem-'))
const bundlePath = await bundle(dir)
const cases = [...hostile(mib), ...(await realistic())].filter(([name]) => filters.length === 0 || filters.some((f) => name.includes(f)))
if (!asJson && !dump) {
  console.log(`| Case | Body | Outcome | Decoded | Node peak / live / retained (MiB) | Node ArrayBuffers retained | workerd peak / live / retained (MiB) | Node ms |`)
  console.log('|---|---|---|---|---|---|---|---|')
}
let port = 18900
for (const [name, path, json, snappy, make] of cases) {
  const body = make()
  if (dump) {
    writeFileSync(join(dump, `${name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.bin`), body)
    continue
  }
  const bodyFile = join(dir, 'body.bin')
  writeFileSync(bodyFile, body)
  const spec = { path, json, snappy, now: NOW }
  const n = wantNode ? runNode(bundlePath, bodyFile, spec) : null
  const w = wantWorkerd ? await runWorkerd(dir, bundlePath, bodyFile, spec, port++) : null
  if (asJson) {
    console.log(JSON.stringify({ name, bodyBytes: body.length, node: n, workerd: w }))
    continue
  }
  const f = (x) => (x == null ? '–' : x.error ? `error: ${x.error.replace(/\n/g, ' ').slice(0, 80)}` : `${x.peak.toFixed(1)} / ${x.live.toFixed(1)} / ${x.retained.toFixed(1)}`)
  const outcome = (n && !n.error ? n : w && !w.error ? w : {}).outcome ?? '?'
  const rows = (n && !n.error ? n : w && !w.error ? w : {}).rows ?? '?'
  const rej = (n && !n.error ? n : w && !w.error ? w : {}).rejected ?? '?'
  const size = body.length >= MiB ? `${(body.length / MiB).toFixed(2)} MiB` : `${(body.length / 1024).toFixed(0)} KiB`
  const dec = (n && !n.error ? n : {}).decoded
  console.log(`| ${name} | ${size} | ${outcome}, ${rows} rows, ${rej} refused | ${dec == null ? '–' : `${(dec / MiB).toFixed(2)} MiB`} | ${f(n)} | ${n && !n.error ? n.arrayBuffersMiB.toFixed(1) : '–'} | ${f(w)} | ${n && !n.error ? n.ms.toFixed(0) : '–'} |`)
}
