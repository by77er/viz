// Local check of load/bodies.mjs before anything is deployed (no network):
//
//   VIZ_TREE=/path/to/checkout node check-bodies.mjs
//
// 1. With seed 7 and bodies.mjs's NOW, the generators give the same bytes (protobuf, snappy) and
//    the same text (JSON) as edge/bench/bodies.mjs `realistic()`, which encodes with protobufjs.
// 2. Every body the trial sends (realistic with other seeds, rich, fat, markers) goes through
//    edge's own decoders and batch builder (the checkout's edge/src, bundled with esbuild), and the
//    rows and refusals are printed: the realistic, rich and marker bodies must decode whole.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as B from './load/bodies.mjs'

const TREE = process.env.VIZ_TREE
if (!TREE) throw new Error('VIZ_TREE: the checkout whose edge/ is checked against')
const edge = join(TREE, 'edge')
const { realistic, NOW } = await import(pathToFileURL(join(edge, 'bench', 'bodies.mjs')).href)
const snappy = (await import(pathToFileURL(join(edge, 'node_modules', 'snappyjs', 'index.js')).href)).default
const { build } = await import(pathToFileURL(join(edge, 'node_modules', 'esbuild', 'lib', 'main.js')).href)

let failed = 0
const same = (name, a, b) => {
  const eq = typeof a === 'string' ? a === b : a.length === b.length && a.every((x, i) => x === b[i])
  console.log(`${eq ? 'same     ' : 'DIFFERENT'} ${name} (${a.length} vs ${b.length})`)
  if (!eq) failed++
}

// 1. Identical to bodies.mjs's realistic bodies.
const cases = await realistic()
const body = (name) => cases.find((c) => c[0] === name)[4]()
const NS = BigInt(NOW) * 1_000_000n
const rnd = B.lcg(7)
const t = B.realisticTraces(rnd, NS)
same('traces protobuf', B.tracesProto(t), body('realistic traces, 8,200 spans'))
same('traces JSON', B.tracesJson(t), new TextDecoder().decode(body('realistic traces JSON, 8,200 spans')))
const l = B.realisticLogs(rnd, NS)
same('logs protobuf', B.logsProto(l), body('realistic logs, 8,200 records'))
same('logs JSON', B.logsJson(l), new TextDecoder().decode(body('realistic logs JSON, 8,200 records')))
const k = B.realisticLoki(rnd, NS)
same('Loki protobuf (snappy)', snappy.compress(B.lokiProto(k)), body('realistic Loki push (snappy), 8,200 entries'))
same('Loki JSON', B.lokiJson(k), new TextDecoder().decode(body('realistic Loki push JSON, 8,200 entries')))

// 2. Through edge's decoders.
const dir = mkdtempSync(join(tmpdir(), 's10-check-'))
const out = join(dir, 'edge.mjs')
await build({
  stdin: { contents: `export * from './src/spans'; export * from './src/logs'; export * from './src/limits'; export * from './src/snappy'`, resolveDir: edge, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error',
  plugins: [{ name: 'stubs', setup(b) {
    b.onResolve({ filter: /^cloudflare:/ }, (a) => ({ path: a.path, namespace: 'stub' }))
    b.onResolve({ filter: /shard\/src\/shard$/ }, () => ({ path: 'shard', namespace: 'shard-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'shard-stub' }, () => ({ contents: 'export const MAX_BATCH_BYTES = 1_048_576', loader: 'js' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}; export class WorkerEntrypoint {}; export const env = {}', loader: 'js' }))
  } }],
})
const E = await import(pathToFileURL(out).href)
rmSync(dir, { recursive: true, force: true })
const L = E.DEFAULT_LIMITS
const now = Date.now()
const nowNs = BigInt(now) * 1_000_000n
function decode(name, kind, json, bytes, mustBeWhole) {
  const t0 = performance.now()
  const c = kind === 'traces' ? new E.SpanCollector(L, now) : new E.LogCollector(L, now)
  if (kind === 'traces') (json ? E.decodeTracesJson : E.decodeTracesProto)(bytes, c)
  else if (kind === 'logs') (json ? E.decodeLogsJson : E.decodeLogsProto)(bytes, c)
  else (json ? E.decodeLokiJson : E.decodeLokiProto)(kind === 'loki' && !json ? E.snappyDecompress(bytes, L.maxDecompressedBytes) : bytes, c)
  const batches = c.build(new Uint32Array(c.routeOf.length), L.maxBatchBytes)
  const ms = performance.now() - t0
  const nb = [...batches.values()].flat().length
  console.log(`${name.padEnd(44)} body ${(bytes.length / 2 ** 20).toFixed(2)} MiB, ${c.nRows} rows, ${c.rejectedTotal} refused${c.rejectedTotal ? ` (${c.rejectionSummary()})` : ''}, ${nb} batches, ${ms.toFixed(0)} ms (Node)`)
  if (mustBeWhole && c.rejectedTotal > 0) failed++
}
const enc = (s) => new TextEncoder().encode(s)
for (const seed of [1001, 1002]) {
  const r = B.lcg(seed)
  const tt = B.realisticTraces(r, nowNs)
  decode(`realistic traces protobuf, seed ${seed}`, 'traces', false, B.tracesProto(tt), true)
  decode(`realistic traces JSON, seed ${seed}`, 'traces', true, enc(B.tracesJson(tt)), true)
  const ll = B.realisticLogs(r, nowNs)
  decode(`realistic logs protobuf, seed ${seed}`, 'logs', false, B.logsProto(ll), true)
  decode(`realistic logs JSON, seed ${seed}`, 'logs', true, enc(B.logsJson(ll)), true)
  const kk = B.realisticLoki(r, nowNs)
  decode(`realistic Loki snappy, seed ${seed}`, 'loki', false, snappy.compress(B.lokiProto(kk)), true)
  decode(`realistic Loki JSON, seed ${seed}`, 'loki', true, enc(B.lokiJson(kk)), true)
}
const res = B.richResources()
const t0 = nowNs - 40n * 60n * 1_000_000_000n
decode('rich spans, 2,000', 'traces', true, enc(B.richSpansJson(res, 0, 2000, t0)), true)
decode('rich spans, fat attributes, 100', 'traces', true, enc(B.richSpansJson(res, 0, 100, t0, { fat: true })), true)
decode('rich logs, 5,000', 'loki', true, enc(B.richLogsJson(0, 5000, t0, 11)), true)
decode('fat spans (180 KB resource), 2,000', 'traces', true, enc(B.fatSpansJson(0, 2000, nowNs - 4n * 3600n * 1_000_000_000n)), true)
decode('fat logs (200 KB lines), 4', 'loki', true, enc(B.fatLogsJson('a', 0, 4, nowNs - 20n * 3600n * 1_000_000_000n)), true)
decode('marker trace', 'traces', true, enc(B.markerTrace(now, 'x').body), true)
decode('marker line', 'loki', true, enc(B.markerLine(now, 'x').body), true)
console.log(failed ? `${failed} check(s) FAILED` : 'every check passed')
process.exit(failed ? 1 : 0)
