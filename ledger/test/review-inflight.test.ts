/**
 * Adversarial review of D47 (not part of the component). The checkpoint tests mutate only
 * BETWEEN parts. Here mutations commit while a part's PUT is IN FLIGHT: they remove a key the
 * in-flight part holds, add a key that sorts inside its range, and expire; then the PUT fails
 * (or succeeds with its answer lost) and the part is built again. The checkpoint must still be
 * exactly the state at its version, and a rebuild from it must equal the live ledger.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { decodeLedgerCheckpointPart } from '../../contracts/ledger'
import type { Ledger } from '../src/ledger'
import { DAY_MS, S, T0, dayOf, dumpState, file, nm, open, pair, tenantName, type Stub } from './helpers'

type K = { checkpointEvery: number; checkpointByLogBytes: boolean; checkpointOneObjectBytes: number; checkpointPartBytes: number; bucket: R2Bucket; drainSerial(s: number, p: number): Promise<number> }
const knobs = (i: Ledger) => i as unknown as K

/** Pause the n-th part PUT inside the object: its body is kept on the instance until `release`, then it fails before / after the write, or succeeds. */
type Inflight = { body: string | null; release: (() => void) | null }
const slot = (i: Ledger) => i as unknown as { __inflight?: Inflight }
function pauseNthPart(l: Stub, n: number, outcome: 'fail' | 'lost' | 'ok') {
  const armed = runInDurableObject(l, (inst: Ledger) => {
    const real = env.BUCKET
    let seen = 0
    slot(inst).__inflight = { body: null, release: null }
    knobs(inst).bucket = new Proxy(real, {
      get(target, prop) {
        const f = Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>
        if (prop !== 'put') return typeof f === 'function' ? f.bind(target) : f
        return async (...a: unknown[]) => {
          const key = a[0] as string
          if (/\/ckpt-\d{12}-[0-9a-f]{8}\//.test(key) && ++seen === n) {
            const go = new Promise<void>((r) => { slot(inst).__inflight = { body: a[1] as string, release: r } })
            await go
            if (outcome === 'fail') throw new Error('injected: part PUT failed')
            const out = await f.apply(target, a)
            if (outcome === 'lost') throw new Error('injected: part PUT answer lost')
            return out
          }
          return f.apply(target, a)
        }
      },
    })
  })
  const atPut = async (): Promise<string> => {
    for (let t = 0; t < 2000; t++) {
      const b = await runInDurableObject(l, (i: Ledger) => slot(i).__inflight?.body ?? null)
      if (b) return b
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('the part PUT was never reached')
  }
  const release = () => runInDurableObject(l, (i: Ledger) => { slot(i).__inflight?.release?.() })
  return { armed, atPut, release }
}

const committed = (d: Awaited<ReturnType<typeof dumpState>>) => ({ version: d.version, files: d.files.map((f) => ({ ...f })), streams: d.streams.map(({ logged: _l, ...s }) => s) })

describe('review D47: mutations while a part PUT is in flight', () => {
  for (const outcome of ['fail', 'lost', 'ok'] as const) {
    for (const nth of [1, 2, 3]) {
      it(`part ${nth}, outcome ${outcome}: the checkpoint is the state at its version`, async () => {
        const { tenant, l } = open(tenantName(`inflight-${outcome}-${nth}`))
        await runInDurableObject(l, (i: Ledger) => { knobs(i).checkpointEvery = 1e9 })
        let seq = 0
        for (let u = 0; u < 20; u++) { seq++; expect((await l.addUnit(pair(seq, seq, T0 + (u % 3) * DAY_MS + u))).status).toBe('ok') }
        await l.drain()
        await runInDurableObject(l, (i: Ledger) => { Object.assign(knobs(i), { checkpointEvery: 1, checkpointByLogBytes: false, checkpointOneObjectBytes: -1, checkpointPartBytes: 2500 }) })
        seq++
        expect((await l.addUnit(pair(seq, seq, T0 + DAY_MS + 500))).status).toBe('ok')
        const atV = committed(await dumpState(l))
        // The segment ending at V begins the checkpoint.
        await runInDurableObject(l, (i: Ledger) => knobs(i).drainSerial(16, 0))
        await runInDurableObject(l, (i: Ledger) => { knobs(i).checkpointEvery = 1e9 })
        expect((await l.logStatus()).checkpoint).toMatchObject({ version: atV.version, phase: 'files' })

        const p = pauseNthPart(l, nth, outcome)
        await p.armed
        // Parts before the n-th are written; the n-th is in flight.
        const draining = runInDurableObject(l, (i: Ledger) => knobs(i).drainSerial(0, nth).then(() => 'done', (e: Error) => `threw: ${e.message}`))
        const body = await p.atPut()
        const d = decodeLedgerCheckpointPart(body, { ledgerIncarnation: (await l.logStatus()).ledgerIncarnation!, version: atV.version, attempt: (body.match(/"attempt":"([0-9a-f]{8})"/) ?? [])[1]!, part: nth - 1 })
        if (d.status !== 'ok') throw new Error(`${d.status}: ${d.reason}`)
        const inPart = d.records.flatMap((r) => ('file' in r ? [r.file] : []))
        expect(inPart.length).toBeGreaterThan(1)
        // While it is in flight: remove a samples file the part holds, add a key inside its range, expire day 0.
        const victim = inPart.find((f) => f.table === 'metric_samples')!
        const inside = { ...file(`${nm(victim.key)}~mid`, { minTs: victim.minTs, level: 1 }) }
        expect((await l.replace({ remove: [victim.key], add: [inside] })).status).toBe('ok')
        seq++
        expect((await l.addUnit(pair(seq, seq, T0 + 2 * DAY_MS + 7))).status).toBe('ok')
        await l.expire({ tables: ['metric_samples', 'metric_series'], beforeDay: dayOf(T0 + DAY_MS) })
        await p.release()
        const r = await draining
        console.log(`REVIEW inflight ${outcome} part ${nth}: drain ${r}`)
        // Restore the real bucket and let the checkpoint finish.
        await runInDurableObject(l, (i: Ledger) => { knobs(i).bucket = env.BUCKET })
        for (let n = 0; (await l.logStatus()).checkpoint?.version === atV.version; n++) {
          expect(n).toBeLessThan(500)
          await runInDurableObject(l, (i: Ledger) => { (i as unknown as { checkpointRetryAt: number }).checkpointRetryAt = 0 })
          await runInDurableObject(l, (i: Ledger) => knobs(i).drainSerial(16, 1))
        }
        // The checkpoint, read with the contract's codec.
        const inc = (await l.logStatus()).ledgerIncarnation!
        const man = await env.BUCKET.get(`${env.CELL}/ledger/tenant=${tenant}/${inc}/ckpt-${String(atV.version).padStart(12, '0')}.jsonl`)
        expect(man, 'the manifest is written').not.toBeNull()
        const m = JSON.parse((await man!.text()).split('\n')[1]!) as { attempt: string; parts: number }
        const files: Record<string, unknown>[] = []
        for (let q = 0; q < m.parts; q++) {
          const pb = await (await env.BUCKET.get(`${env.CELL}/ledger/tenant=${tenant}/${inc}/ckpt-${String(atV.version).padStart(12, '0')}-${m.attempt}/${String(q).padStart(6, '0')}.jsonl`))!.text()
          const dp = decodeLedgerCheckpointPart(pb, { ledgerIncarnation: inc, version: atV.version, attempt: m.attempt, part: q })
          if (dp.status !== 'ok') throw new Error(dp.reason)
          for (const rec of dp.records) if ('file' in rec) files.push({ key: rec.file.key, prec: rec.file.precedence })
        }
        const want = atV.files.map((f) => ({ key: f.key, prec: f.prec }))
        expect(files, 'the checkpoint holds exactly the files at its version').toEqual(want)
        // A rebuild from it (and the segments after) equals the live ledger.
        await l.drain()
        const live = await dumpState(l)
        const rb = await runInDurableObject(l, async (i: Ledger, state) => { await state.storage.deleteAll(); return i.rebuildFromLog() })
        expect(rb.checkpoint).toBe(atV.version)
        expect(await dumpState(l)).toEqual(live)
        void S
      })
    }
  }
})
