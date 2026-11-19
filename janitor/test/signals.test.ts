/// <reference path="../../engine/wasm/js/wasm.d.ts" />
/**
 * Retention and deletion of the span and log tables (stage 2 of traces and logs):
 *
 *   - the record control writes names `trace_days` and `log_days` (control/src/ops-settings.ts);
 *     absent, each is the default, whatever the metric days; unreadable, the whole record is;
 *   - `expireTenant` removes spans with their trace_index files by `trace_days` and logs by
 *     `log_days`, by whole days, in ledger changes of their own after the metric one, and a ledger
 *     that refuses them (a release before these tables) costs the metric expiry nothing;
 *   - removed objects are deleted by the purge under the same rules as metric files: logged,
 *     older than the grace, and, with a publisher bound, released by it (the real publisher of
 *     this release does not know these tables and releases none of them: fail closed);
 *   - the orphan sweep lists every table's prefix of the tenant, spans keys one level deeper,
 *     and judges their flush files as it judges metric ones; another tenant's are never touched.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { encodeLogBatch, encodeSpanBatch, id } from '../../engine/wasm/test/signal'
import { engine } from '../../flush/src/index'
import { T0, flushSettled, ledgerStub, listKeys, sha256Hex, shardStub } from '../../flush/test/helpers'
import type { Ledger } from '../../ledger/src/ledger'
import { DEFAULT_SIGNAL_DAYS, type JanitorEnv, type PublisherGateNamespace, expireTenant, parseRetention, purgeTenant, sweepOrphans } from '../src/index'

const DAY = 86_400_000
const NS = (ms: number) => BigInt(ms) * 1_000_000n
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const exists = async (keys: string[]) => (await Promise.all(keys.map((k) => env.BUCKET.head(k)))).map((o) => o !== null)
let n = 0

/** A tenant with flushed span segments and log segments, one segment per day in `days` (days before T0). */
async function tenantWithSignals(prefix: string, days: number[]) {
  const tenant = `${prefix}-${Date.now().toString(36)}-${n++}`
  const pool = `pool-${tenant}`
  const traces = `${pool}/traces/0`
  const logs = `${pool}/logs/0`
  for (const [i, d] of days.entries()) {
    const at = NS(T0 - d * DAY + i * 60_000)
    const spans = encodeSpanBatch([{ resourceFp: 1n, resource: [['service.name', { s: 'api' }]] }], [{ entry: 0, traceId: id(16, i + 1), spanId: id(8, 1), start: at, end: at + 5n, name: `op ${i}` }])
    const lines = encodeLogBatch([{ labels: { service_name: 'api' } }], [{ entry: 0, ts: at, line: `line ${i}` }])
    for (const [shard, payload] of [[traces, spans], [logs, lines]] as const) {
      const s = shardStub(shard)
      const r = await s.append({ tenant, epoch: 1, fingerprint: await sha256Hex(payload), payload, rows: 1 })
      expect(r.status).toBe('ok')
      await s.seal(tenant)
    }
  }
  for (const shard of [traces, logs]) expect(await flushSettled(env, engine, tenant, shard)).toMatchObject({ status: 'ok', awaitingLog: false })
  return { tenant, traces, logs, ledger: ledgerStub(tenant) }
}

const keysOf = async (l: DurableObjectStub<Ledger>, table: 'spans' | 'trace_index' | 'logs') => (await l.plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files.map((f) => f.key).sort()
const objects = async (tenant: string) => (await Promise.all(['spans', 'trace_index', 'logs'].map((t) => listKeys(`${env.CELL}/data/${t}/tenant=${tenant}/`)))).flat().sort()

describe('the retention record: trace_days and log_days', () => {
  it('absent: the default whatever the metric days; present: their numbers; unreadable: the whole record', () => {
    expect(DEFAULT_SIGNAL_DAYS).toBe(30)
    expect(parseRetention('{"metric_samples_days":2}')).toEqual({ status: 'ok', policy: { metric_samples_days: 2, trace_days: 30, log_days: 30 }, source: 'record' })
    expect(parseRetention('{"metric_samples_days":60,"trace_days":7,"log_days":14,"metric_5m_days":90}')).toEqual({ status: 'ok', policy: { metric_samples_days: 60, trace_days: 7, log_days: 14 }, source: 'record' })
    for (const bad of ['{"metric_samples_days":2,"trace_days":0}', '{"metric_samples_days":2,"log_days":"7"}', '{"metric_samples_days":2,"log_days":1.5}', '{"metric_samples_days":2,"trace_days":null}']) {
      expect(parseRetention(bad), bad).toMatchObject({ status: 'unreadable' })
    }
  })
})

describe('expiring spans, trace_index and logs', () => {
  it('by their own days, spans with trace_index in one change, logs on their own; objects stay until the purge', async () => {
    const t = await tenantWithSignals('exp', [10, 3, 0])
    await env.CONFIG.put(`retention:${t.tenant}`, JSON.stringify({ metric_samples_days: 30, trace_days: 5, log_days: 1 }))
    const before = { spans: await keysOf(t.ledger, 'spans'), index: await keysOf(t.ledger, 'trace_index'), logs: await keysOf(t.ledger, 'logs') }
    expect([before.spans.length, before.index.length, before.logs.length]).toEqual([3, 3, 3])
    const all = await objects(t.tenant)
    const r = await expireTenant(env, t.tenant, T0)
    expect(r.signals).toEqual([
      { tables: ['spans', 'trace_index'], beforeDay: '2026-11-13', keepDays: 5, removed: 2 },
      { tables: ['logs'], beforeDay: '2026-11-17', keepDays: 1, removed: 2 },
    ])
    // Day T0-10 of spans and trace_index; days T0-10 and T0-3 of logs.
    expect(await keysOf(t.ledger, 'spans')).toEqual(before.spans.slice(1))
    expect(await keysOf(t.ledger, 'trace_index')).toEqual(before.index.slice(1))
    expect(await keysOf(t.ledger, 'logs')).toEqual(before.logs.slice(2))
    expect(r.removed.sort()).toEqual([before.spans[0], before.index[0], ...before.logs.slice(0, 2)].sort())
    expect(await exists(all)).toEqual(all.map(() => true))
    // The ledger logged them as two changes, each with its tables.
    const tombs = await t.ledger.removedSince(0)
    expect(new Set(tombs.map((x) => x.version)).size).toBe(2)
    // The purge deletes them once logged and past the grace, as metric files.
    await t.ledger.drain()
    await sleep(150)
    const p = await purgeTenant(env, t.tenant, { graceMs: 100 })
    expect(p.deleted.sort()).toEqual(r.removed.sort())
    expect(await objects(t.tenant)).toEqual(all.filter((k) => !r.removed.includes(k)))
    // Equal days: one request for all three tables.
    await env.CONFIG.put(`retention:${t.tenant}`, JSON.stringify({ metric_samples_days: 30, trace_days: 2, log_days: 2 }))
    expect((await expireTenant(env, t.tenant, T0)).signals).toEqual([{ tables: ['spans', 'trace_index', 'logs'], beforeDay: '2026-11-16', keepDays: 2, removed: 2 }])
  })

  it('a ledger that refuses the span and log tables (a release before them) costs the metric expiry nothing', async () => {
    const t = await tenantWithSignals('old', [10])
    const oldLedger = {
      idFromName: (name: string) => env.LEDGER.idFromName(name),
      get: (lid: DurableObjectId) => {
        const real = env.LEDGER.get(lid)
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'expire') {
              return async (req: { tables?: string[] }) => {
                if (req.tables?.some((x) => !x.startsWith('metric_'))) throw new Error('ledger: unknown table')
                return target.expire(req as never)
              }
            }
            const v = Reflect.get(target, prop)
            return typeof v === 'function' ? v.bind(target) : v
          },
        })
      },
    } as unknown as JanitorEnv['LEDGER']
    const r = await expireTenant({ ...env, LEDGER: oldLedger }, t.tenant, T0)
    expect(r.beforeDay).toBe('2026-10-19')
    expect(r.signals).toEqual([{ tables: ['spans', 'trace_index', 'logs'], beforeDay: '2026-10-19', keepDays: 30, removed: 0, error: 'ledger: unknown table' }])
  })
})

describe('the publisher gate applies to the span and log tables', () => {
  async function expired(prefix: string) {
    const t = await tenantWithSignals(prefix, [40])
    const r = await expireTenant(env, t.tenant, T0)
    expect(r.removed).toHaveLength(3)
    await t.ledger.drain()
    await sleep(150)
    return { ...t, removed: r.removed }
  }

  it('the real publisher of this release does not know these tables: it releases none of them, and nothing is deleted', async () => {
    const t = await expired('gate-real')
    const cell = `gs${Date.now().toString(36)}${n++}`
    // The publisher reads the tenant's log under its own cell (a copy), as publisher/'s tests do.
    const from = `${env.CELL}/ledger/tenant=${t.tenant}/`
    for (const o of (await env.BUCKET.list({ prefix: from })).objects) await env.BUCKET.put(`${cell}/ledger/tenant=${t.tenant}/${o.key.slice(from.length)}`, await (await env.BUCKET.get(o.key))!.arrayBuffer())
    const publisher = env.TEST_PUBLISHER.get(env.TEST_PUBLISHER.idFromName(cell))
    const pub = await publisher.publish([t.tenant])
    expect(pub.tenants[0]).toMatchObject({ status: 'unsupported' })
    // The janitor asks the publisher of its cell: here, the one that read the copy.
    const gate: PublisherGateNamespace = { idFromName: () => env.TEST_PUBLISHER.idFromName(cell), get: (x) => env.TEST_PUBLISHER.get(x) }
    const p = await purgeTenant({ ...env, PUBLISHER: gate }, t.tenant, { graceMs: 100 })
    expect(p.deleted).toEqual([])
    expect(p.unpublished).toBe(3)
    expect(await exists(t.removed)).toEqual([true, true, true])
  })

  it('a publisher that releases them lets them go, and only them', async () => {
    const t = await expired('gate-fake')
    const released = t.removed.slice(0, 2)
    const ns: PublisherGateNamespace = {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ safeToDelete: async () => released, acknowledgeDeleted: async () => undefined }),
    }
    const p = await purgeTenant({ ...env, PUBLISHER: ns }, t.tenant, { graceMs: 100 })
    expect(p.deleted.sort()).toEqual([...released].sort())
    expect(await exists(t.removed)).toEqual(t.removed.map((k) => !released.includes(k)))
  })
})

describe('the orphan sweep over the span and log tables', () => {
  it('lists every table of the tenant, spans keys under their hour; deletes a dead flush file, keeps live ones, leaves other tenants alone', async () => {
    const t = await tenantWithSignals('orph', [0])
    const other = await tenantWithSignals('orph-other', [0])
    const live = [...(await keysOf(t.ledger, 'spans')), ...(await keysOf(t.ledger, 'trace_index')), ...(await keysOf(t.ledger, 'logs'))]
    expect(live.filter((k) => /\/spans\/.+\/hour=\d\d\/L0-/.test(k))).toHaveLength(1)
    // A leftover of a run that died after its PUT: same unit range, other bytes (a different hash), never admitted.
    const dead = live.map((k) => k.replace(/-[0-9a-f]{8}\.parquet$/, '-deadbeef.parquet'))
    for (const k of dead) await env.BUCKET.put(k, new Uint8Array([1, 2, 3]))
    await sleep(50)
    const o = await sweepOrphans(env, t.tenant, { graceMs: 10 })
    expect(o.listed).toBe(6)
    expect(o.deleted.sort()).toEqual(dead.sort())
    expect(await exists(live)).toEqual(live.map(() => true))
    const otherLive = [...(await keysOf(other.ledger, 'spans')), ...(await keysOf(other.ledger, 'logs'))]
    expect(await exists(otherLive)).toEqual(otherLive.map(() => true))
  })
})
