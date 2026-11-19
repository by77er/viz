/**
 * Review S-2's full fix, the counterfactual (AGENTS.md, "Evidence"): what a checkpoint and a
 * rebuild cost at 8,000, 32,000, 100,000 and 300,000 live files, for the release before
 * checkpoints in parts (`bench/before/`, frozen) and for this one, on the SAME data. Measured
 * here, in local workerd: the test, the objects, SQLite and a simulated R2 in one process, on a
 * shared machine (times ±2× with its load; the load is printed). Times are taken from outside
 * the objects (inside one the clock stands still while code runs).
 *
 * Before any time is compared: both ledgers are filled with the same units and must hold the
 * identical state (a digest of every row, tenant name aside); each must rebuild that state from
 * its own log (its own checkpoint); and each must rebuild it from the OTHER one's log (the base
 * the other wrote when it rebuilt). test/checkpoint.test.ts also has the older release pass over
 * a format-2 checkpoint and this one read a format-1 checkpoint.
 *
 *   BENCH=checkpoint BENCH_SIZES=8000,32000 BENCH_VARIANTS=before,after npm run bench
 *   node bench/rss.mjs -- npm run bench     (the same, sampling the processes' resident memory)
 *
 * "Blocked" is the longest time a trivial call (`logStatus`) waited while the checkpoint was
 * being written: the longest synchronous step, as a caller sees it.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Ledger } from '../src/ledger'
import { unitFor } from './worker'

type Stub = DurableObjectStub<Ledger>
const E = env as unknown as {
  LEDGER: DurableObjectNamespace<Ledger>
  LEDGER_BEFORE: DurableObjectNamespace<Ledger>
  CELL: string
  BENCH: string
  BENCH_SIZES: string
  BENCH_VARIANTS: string
}
const only = (name: string) => E.BENCH === '' || E.BENCH === name
const SIZES = (E.BENCH_SIZES || '8000,32000,100000').split(',').map(Number)
const VARIANTS = (E.BENCH_VARIANTS || 'before,after').split(',') as ('before' | 'after')[]
const PER_UNIT = 4_000
const ns = (v: 'before' | 'after') => (v === 'before' ? E.LEDGER_BEFORE : E.LEDGER)
type Knobs = { stateMaxBytes: number; checkpointEvery: number; checkpointByLogBytes: boolean }
const set = (l: Stub, k: Partial<Knobs>) => runInDurableObject(l, (i: Ledger) => { Object.assign(i as unknown as Knobs, k) })
const phase = (name: string, extra: Record<string, unknown> = {}) => console.log(`PHASE ${Date.now()} ${name} ${JSON.stringify(extra)}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** SHA-256 over every row of the state, in key order, with the tenant name replaced: equal for equal states. */
const digest = (l: Stub, tenant: string) =>
  runInDurableObject(l, async (_i: Ledger, state) => {
    const sql = state.storage.sql
    let h = new Uint8Array(0)
    const enc = new TextEncoder()
    const chain = async (text: string) => {
      const b = enc.encode(text)
      const both = new Uint8Array(h.length + b.length)
      both.set(h)
      both.set(b, h.length)
      h = new Uint8Array(await crypto.subtle.digest('SHA-256', both))
    }
    const counts: Record<string, number> = {}
    for (const [t, order, cols] of [['file', 'key', 'key, tbl, day, bytes, rows, min_ts, max_ts, level, idx, u_shard, u_inc, u_lo, u_hi, prec, prec_lo'], ['stream', 'shard', 'shard, incarnation, watermark, logged, prev_incarnation'], ['tombstone', 'key', 'key, tbl, version, at']] as const) {
      counts[t] = 0
      for (let after = '', more = true; more;) {
        const rows = sql.exec(`SELECT ${cols} FROM ${t} WHERE ${order} > ? ORDER BY ${order} LIMIT 2000`, after).toArray()
        more = rows.length === 2000
        if (rows.length === 0) break
        after = rows.at(-1)![order] as string
        counts[t] += rows.length
        await chain(JSON.stringify(rows).replaceAll(tenant, 'T'))
      }
    }
    const version = sql.exec(`SELECT v FROM meta WHERE k = 'version'`).toArray()[0]?.v
    await chain(`version ${String(version)}`)
    return { sha: [...h].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16), version, ...counts }
  })

/** Run `work` while a trivial call is made every few ms; the longest such call is how long the object was blocked. */
async function whileProbing(l: Stub, work: () => Promise<unknown>): Promise<{ ms: number; blockedMs: number; probes: number }> {
  let done = false
  let blockedMs = 0
  let probes = 0
  const probe = (async () => {
    while (!done) {
      const t = Date.now()
      await l.logStatus()
      blockedMs = Math.max(blockedMs, Date.now() - t)
      probes++
      await sleep(5)
    }
  })()
  const t0 = Date.now()
  try {
    await work()
  } finally {
    done = true
  }
  const ms = Date.now() - t0
  await probe
  return { ms, blockedMs, probes }
}

async function fill(l: Stub, tenant: string, files: number): Promise<number> {
  let seq = 0
  for (let admitted = 0; admitted < files; admitted += PER_UNIT) {
    const r = await l.addUnit(unitFor(E.CELL, tenant, 0, seq + 1, seq + 1, Math.min(PER_UNIT, files - admitted)))
    expect(r.status).toBe('ok')
    seq++
  }
  return seq
}

/** The checkpoint objects of a tenant's newest incarnation. */
async function checkpointObjects(tenant: string): Promise<{ objects: number; bytes: number; largest: number }> {
  const prefix = `${E.CELL}/ledger/tenant=${tenant}/`
  let objects = 0
  let bytes = 0
  let largest = 0
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ prefix, cursor })
    for (const o of page.objects) {
      if (!o.key.includes('/ckpt-')) continue
      objects++
      bytes += o.size
      largest = Math.max(largest, o.size)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return { objects, bytes, largest }
}

async function segmentBytes(tenant: string): Promise<{ segments: number; bytes: number }> {
  let segments = 0
  let bytes = 0
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ prefix: `${E.CELL}/ledger/tenant=${tenant}/`, cursor })
    for (const o of page.objects) if (o.key.includes('/seg-')) { segments++; bytes += o.size }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return { segments, bytes }
}

describe.skipIf(!only('checkpoint'))('checkpoints and rebuilds: the release before vs this one (review S-2; measured here, workerd)', () => {
  it('same data, identical states, each rebuilt from its own log and from the other\'s; then the times', async () => {
    const rows: Record<string, unknown>[] = []
    const run = Date.now().toString(36)
    for (const files of SIZES) {
      const tenants: Partial<Record<'before' | 'after', string>> = {}
      const digests: Partial<Record<'before' | 'after', Awaited<ReturnType<typeof digest>>>> = {}
      for (const v of VARIANTS) {
        const tenant = `ck${v}-${files}-${run}`
        tenants[v] = tenant
        const l = ns(v).get(ns(v).idFromName(tenant))
        await l.logStatus()
        // No checkpoint while filling; the older release's 16 MiB limit lifted, as the benchmark of review S-2 did.
        await set(l, { stateMaxBytes: Number.MAX_SAFE_INTEGER, checkpointEvery: 1e9 })
        phase('fill', { v, files })
        const seq = await fill(l, tenant, files)
        await l.drain()
        digests[v] = await digest(l, tenant)
        const segs = await segmentBytes(tenant)
        // One checkpoint of the whole state: after the next segment, whatever its size.
        await set(l, { checkpointEvery: 1, checkpointByLogBytes: false })
        await l.addUnit(unitFor(E.CELL, tenant, 0, seq + 1, seq + 1, 2))
        phase('checkpoint', { v, files })
        const ck = await whileProbing(l, () => l.drain())
        phase('checkpoint-end', { v, files })
        const objects = await checkpointObjects(tenant)
        expect(objects.objects).toBeGreaterThan(0)
        const live = await digest(l, tenant)
        await set(l, { checkpointEvery: 1e9 })
        // A rebuild from its own log, into emptied storage.
        phase('rebuild', { v, files })
        const t0 = Date.now()
        const r = (await runInDurableObject(l, async (i: Ledger, state) => {
          await state.storage.deleteAll()
          return i.rebuildFromLog()
        })) as { checkpoint: number | null; changesReplayed: number; segmentsRead: number }
        const rebuildMs = Date.now() - t0
        phase('rebuild-end', { v, files })
        expect(r.checkpoint, `${v} ${files}: rebuilt from its checkpoint`).not.toBeNull()
        const rebuilt = await digest(l, tenant)
        expect(rebuilt, `${v} ${files}: the rebuild holds the live state`).toEqual(live)
        rows.push({
          v, files, stateDigest: digests[v]!.sha, logSegments: segs.segments, logMB: +(segs.bytes / 1e6).toFixed(1),
          checkpointMs: ck.ms, blockedMs: ck.blockedMs, checkpointObjects: objects.objects, checkpointMB: +(objects.bytes / 1e6).toFixed(1), largestObjectMB: +(objects.largest / 1e6).toFixed(2),
          rebuildMs, rebuildFrom: r.checkpoint, segmentsAfter: r.segmentsRead,
        })
        console.log(`ROW ${JSON.stringify(rows.at(-1))}`)
      }
      if (digests.before && digests.after) {
        // The same units gave the same state in both.
        expect(digests.after.sha, `${files}: identical states`).toBe(digests.before.sha)
        // Each reads the other's log: the newest incarnation of each tenant is the one its own
        // rebuild started, whose base the other release now reads (this release streams the older
        // one's base line; the older one reads this one's, which was written in pieces).
        for (const [reader, writer] of [['after', 'before'], ['before', 'after']] as const) {
          const tenant = tenants[writer]!
          const writerState = await digest(ns(writer).get(ns(writer).idFromName(tenant)), tenant)
          const other = ns(reader).get(ns(reader).idFromName(tenant))
          phase('cross', { reader, writer, files })
          const t0 = Date.now()
          await set(other, { stateMaxBytes: Number.MAX_SAFE_INTEGER, checkpointEvery: 1e9 })
          // A caller is refused, retryably, while the object starts; it retries.
          for (let tries = 0; ; tries++) {
            const r = await other.plan({ table: 'metric_samples', minTs: 0, maxTs: 1 }).then(() => 'served', (e: Error) => e.message)
            if (r === 'served') break
            expect(r).toMatch(/^ledger_unavailable/)
            expect(tries).toBeLessThan(600)
            await sleep(100)
          }
          const ms = Date.now() - t0
          phase('cross-end', { reader, writer, files })
          const got = await digest(other, tenant)
          expect({ ...got, version: 0 }, `${reader} reading ${writer}'s log at ${files}`).toEqual({ ...writerState, version: 0 })
          rows.push({ cross: `${reader} reads ${writer}'s log`, files, ms })
          console.log(`ROW ${JSON.stringify(rows.at(-1))}`)
        }
      }
    }
    console.log(`BENCH ${JSON.stringify(rows)}`)
  })
})
