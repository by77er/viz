/**
 * Calibration of the history memory model (`src/history.ts` `MEMORY.perPoint`): resident memory
 * of workerd while one window of a range result is held the way a warm-up or backtest holds it:
 * the engine's JSON text, parsed (`[seconds, "value"]` per point), and its per-step index
 * (`byStep`). Run with `npm run bench:history` (one worker). The peak (VmHWM) is reset before each
 * case through `HOST?reset`.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { PromMatrix } from '../../contracts/engine'
import { byStep, MEMORY } from '../src/history'
import { setup } from './helpers'

type Host = { pids: number[]; loadavg: number[]; rssKb: number; peakKb: number }
const host = async (reset = false) => (await (env as unknown as { HOST: Fetcher }).HOST.fetch(`http://host/${reset ? '?reset' : ''}`)).json() as Promise<Host>

describe('memory model calibration', () => {
  // One case per process (`-t`): a later case would reuse heap an earlier one freed.
  for (const [series, steps] of [[100, 2000], [1000, 500], [10, 20000], [1000, 70]] as const) {
    it(`bytes held per point: ${series} series × ${steps} steps`, async () => {
      const { stub } = await setup()
      const before = await host(true)
      const held = await runInDurableObject(stub, async () => {
        // As the engine sends it: one JSON document, parsed from the response, then indexed by step,
        // as streamHistory holds a window.
        const parts: string[] = []
        for (let s = 0; s < series; s++) {
          let values = ''
          for (let i = 0; i < steps; i++) values += `${i ? ',' : ''}[${4102444800 + i * 60},"${100 + ((i * 37 + s) % 7) - 3 + i / 1e3}"]`
          parts.push(`{"metric":{"svc":"s${s}","job":"checkout","viz_slo_part":"total"},"values":[${values}]}`)
        }
        const m = (await new Response(`{"resultType":"matrix","result":[${parts.join(',')}]}`).json()) as PromMatrix
        const idx = byStep(m)
        return idx.size + m.result.length
      })
      expect(held).toBeGreaterThan(0)
      const after = await host()
      const points = series * steps
      const inc = (after.peakKb - before.rssKb) * 1024
      console.log(`| ${series} × ${steps} | ${points.toLocaleString('en-US')} | ${(inc / 1048576).toFixed(1)} | ${Math.round(inc / points)} | ${MEMORY.perPoint} | ${after.loadavg.map((x) => x.toFixed(1)).join(' ')} |`)
    })
  }
})
