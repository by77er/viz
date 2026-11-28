/**
 * Measured here (local workerd): trace by ID, a LogQL range query and a TraceQL search over
 * synthetic data at two sizes (`engine/wasm-query/examples/signal_bench.rs`, the generator of
 * `engine/storage/examples/otel_bench.rs`), through the whole query Worker: ledger, leaves
 * reading the files from R2 (miniflare's), the shard's tail, the engine.
 *
 *   engine/wasm-query/target/release/examples/signal_bench 20000 50000 test/fixtures/signals/bench-small.json
 *   engine/wasm-query/target/release/examples/signal_bench 100000 200000 test/fixtures/signals/bench-large.json
 *   npm run measure -- test/signals.bench.ts
 *
 * Each call runs on a fresh engine instance (`engine.reset()`), so `X-Viz-Wasm-Memory-Bytes`
 * is that call's peak of WASM linear memory. The caps are raised for the tenant so that the
 * large reads are measured instead of refused.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { clearLimitsCache } from '../src/config'
import { engine } from '../src/index'
import { type SignalFx, loadSignal } from './signals-load'
import { api, cost, world } from './world'

interface Bench {
  spans: SignalFx
  logs: SignalFx
  traceIds: string[]
  startNs: string
  endNs: string
}

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!
const MiB = (b: number): string => (b / 1048576).toFixed(1)

describe('measured here: traces and logs through the Worker', () => {
  // Imported one at a time: a module is sent to the runner in one message (at most 32 MiB).
  const sizes: [string, () => Promise<{ default: unknown }>][] = [
    ['small', () => import('./fixtures/signals/bench-small.json')],
    ['large', () => import('./fixtures/signals/bench-large.json')],
  ]
  for (const [name, get] of sizes) {
    it(name, async () => {
      const fx = (await get()).default as Bench
      console.log(`MEASURE ${name}: ${fx.spans.units.length} span units, ${fx.logs.units.length} log units`)
      const w = await world()
      await loadSignal(w, w.a, 'traces', fx.spans)
      await loadSignal(w, w.a, 'logs', fx.logs)
      await env.CONFIG.put(`limits:${w.a.name}`, JSON.stringify({ maxSpans: 5_000_000, maxLogRows: 5_000_000, maxDecodedBytes: 1 << 30, maxFetchBytes: 512 << 20, maxFiles: 20_000 }))
      clearLimitsCache()
      const s = (ns: string) => String(BigInt(ns) / 1_000_000_000n)
      const cases: [string, string, [string, string][]][] = [
        ...fx.traceIds.slice(0, 4).map((id, k) => [`trace by ID #${k}`, `/api/traces/${id}`, []] as [string, string, [string, string][]]),
        ['trace by ID #0, with start/end', `/api/traces/${fx.traceIds[0]}`, [['start', s(fx.startNs)], ['end', s(fx.endNs)]]],
        ['LogQL range: sum by (service_name) (count_over_time(… | keep service_name [5m])), 1 h at 60 s', '/loki/api/v1/query_range', [['query', 'sum by (service_name) (count_over_time({service_name=~".+"} | keep service_name [5m]))'], ['start', fx.startNs], ['end', fx.endNs], ['step', '60s']]],
        ['LogQL range: {service_name="app-3"} |= "level=error", limit 100', '/loki/api/v1/query_range', [['query', '{service_name="app-3"} |= "level=error"'], ['start', fx.startNs], ['end', fx.endNs], ['limit', '100']]],
        ['TraceQL search: { status = error }, 1 h', '/api/search', [['q', '{ status = error }'], ['start', s(fx.startNs)], ['end', String(BigInt(s(fx.endNs)) + 1n)]]],
      ]
      for (const [label, path, params] of cases) {
        const wall: number[] = []
        const eng: number[] = []
        let res!: Response
        for (let run = 0; run < 3; run++) {
          engine.reset()
          const t0 = performance.now()
          res = await api(w.a.key, path, params)
          const body = await res.text()
          wall.push(performance.now() - t0)
          eng.push(cost(res, 'Engine-Ms'))
          if (res.status !== 200) console.log(`MEASURE-FAIL ${label}: ${res.status} ${body.slice(0, 300)}`)
          expect([label, res.status]).toEqual([label, 200])
        }
        console.log(
          `MEASURE ${name} | ${label} | wall ms ${wall.map((x) => x.toFixed(0)).join(', ')} (median ${median(wall).toFixed(0)}) | engine ms ${median(eng)} | files ${cost(res, 'Files-Read')}/${cost(res, 'Files-Listed')} | bytes ${MiB(cost(res, 'Bytes-Read'))} MiB | tail ${MiB(cost(res, 'Tail-Bytes'))} MiB | rows bound ${cost(res, 'Scan-Rows')} | decoded ${cost(res, 'Rows-Decoded')} | wasm ${MiB(cost(res, 'Wasm-Memory-Bytes'))} MiB`,
        )
      }
    })
  }
})
