/**
 * Golden formats (contracts/COMPATIBILITY.md §3, §8): what the maintenance code writes that
 * another release reads, produced by the real code; times replaced by a placeholder after their
 * shape is checked. Each file is `test/golden/formats/<format>.v<N>.json`, N = `FORMATS[...]`
 * in `src/formats.ts`. Also the readers: a marker or message of an unknown version is not acted on.
 */
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { FORMATS } from '../src/formats'
import { MAINT_QUEUE_NAME, type MaintMessage, type StackEnv, consumeMaintBatch, engine, enqueueDue, maintMarkerKey, maintainTenant, noteFlushed } from '../src/index'
import { expectGolden, goldenDir } from './golden'

type Format = keyof typeof FORMATS
const file = (f: Format) => `formats/${f}.v${FORMATS[f]}.json`

function recording() {
  const sent: MaintMessage[] = []
  const MAINT_QUEUE = { send: async (b: MaintMessage) => void sent.push(b), sendBatch: async (bs: { body: MaintMessage }[]) => void sent.push(...bs.map((b) => b.body)) } as unknown as Queue<MaintMessage>
  return { sent, env: { ...(env as unknown as StackEnv), MAINT_QUEUE } }
}
const scrubMs = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, (k === 'due' || k === 'orphansAt') && typeof v === 'number' ? '<ms>' : v]))

describe('golden formats: every format this component writes has a golden file for its current version', () => {
  it('no format is missing a file, and no file claims a version the code does not', () => {
    const files = goldenDir('formats')
    for (const f of Object.keys(FORMATS) as Format[]) {
      expect(files[`${f}.v${FORMATS[f]}.json`], `test/golden/${file(f)}`).toMatchObject({ format: f, version: FORMATS[f] })
    }
    for (const [name, g] of Object.entries(files)) {
      const { format, version } = g as { format: Format; version: number }
      expect(name).toBe(`${format}.v${version}.json`)
      expect(version, `${name} is newer than the code's ${format}`).toBeLessThanOrEqual(FORMATS[format])
    }
  })

  it('queue.maint and kv.maint-marker: what a flush, the cron and a maintenance run write', async () => {
    const tenant = `golden-m-${Date.now().toString(36)}`
    const q = recording()
    await noteFlushed(q.env, { tenant })
    const afterFlush = (await env.CONFIG.getWithMetadata<Record<string, unknown>>(maintMarkerKey(tenant))).metadata!
    await enqueueDue(q.env, Date.now() + 1000)
    // A run on a tenant with no data and an unreadable retention record: the marker says so.
    await env.CONFIG.put(`retention:${tenant}`, '{"metric_samples_days": 365,}')
    await maintainTenant(q.env, engine, tenant, { orphanEveryMs: 0 })
    const afterRefusal = (await env.CONFIG.getWithMetadata<Record<string, unknown>>(maintMarkerKey(tenant))).metadata!
    for (const m of [afterFlush, afterRefusal]) for (const k of ['due', 'orphansAt']) expect(m[k]).toBeGreaterThan(1.7e12)
    expectGolden(file('queue.maint'), { format: 'queue.maint', version: FORMATS['queue.maint'], afterFlush: JSON.stringify(q.sent[0]).replace(tenant, '<tenant>'), fromCron: JSON.stringify(q.sent[1]).replace(tenant, '<tenant>') })
    expectGolden(file('kv.maint-marker'), { format: 'kv.maint-marker', version: FORMATS['kv.maint-marker'], afterFlush: JSON.stringify(scrubMs(afterFlush)), afterRefusal: JSON.stringify(scrubMs(afterRefusal)) })
    await env.CONFIG.delete(`retention:${tenant}`)
    await env.CONFIG.delete(maintMarkerKey(tenant))
  })

  it('reader: a marker of an unknown version is not acted on, not overwritten, and refuses the run', async () => {
    const tenant = `golden-u-${Date.now().toString(36)}`
    const newer = { v: 2, due: 0, orphansAt: 0, sweep: true, somethingNew: 1 }
    await env.CONFIG.put(maintMarkerKey(tenant), '1', { metadata: newer })
    const q = recording()
    const due = await enqueueDue(q.env)
    expect(due.unsupported).toContain(tenant)
    expect(due.enqueued).not.toContain(tenant)
    await noteFlushed(q.env, { tenant })
    expect(q.sent).toEqual([{ v: 1, tenant, wrote: true }])
    expect((await env.CONFIG.getWithMetadata(maintMarkerKey(tenant))).metadata).toEqual(newer)
    await expect(maintainTenant(q.env, engine, tenant)).rejects.toThrow(/version 2/)
    expect((await env.CONFIG.getWithMetadata(maintMarkerKey(tenant))).metadata).toEqual(newer)
    // The message that run came from is retried, not acknowledged or dead-lettered.
    const batch = createMessageBatch(MAINT_QUEUE_NAME, [{ id: 'g', timestamp: 0, attempts: 1, body: { v: 1, tenant } }])
    const ctx = createExecutionContext()
    const out = await consumeMaintBatch(batch, q.env, engine)
    expect(out[0]).toMatchObject({ action: 'again', why: expect.stringContaining('version 2') })
    expect((await getQueueResult(batch, ctx)).retryMessages.map((m) => m.msgId)).toEqual(['g'])
    await env.CONFIG.delete(maintMarkerKey(tenant))
  })
})
