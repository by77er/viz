/**
 * Golden formats (contracts/COMPATIBILITY.md §3, §8): what this component writes that another
 * release reads, produced by the real code with fixed inputs; times replaced by a placeholder
 * after their shape is checked. Each file is `test/golden/formats/<format>.v<N>.json`, where N is
 * `FORMATS[<format>]` in `src/formats.ts`. Old versions' files stay: the readers must still read them.
 */
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { FORMATS } from '../src/formats'
import { type DeadLetter, consumeDeadLetters, consumeFlushBatch, dataFileKey, engine, listDeadLetters, sweepPending } from '../src/index'
import { expectGolden, goldenDir, goldenFile } from './golden'

type Format = keyof typeof FORMATS
const file = (f: Format, v: number = FORMATS[f]) => `formats/${f}.v${v}.json`

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

  it('queue.flush: the message the sweep sends', async () => {
    await env.CONFIG.put('flush-pending:golden-pool/0', '{}')
    const sent: unknown[] = []
    const SHARD = { idFromName: (n: string) => n, get: () => ({ pendingTenants: async () => [{ tenant: 'golden-tenant', segments: 1, oldestSealedAt: 0 }] }) } as unknown as typeof env.SHARD
    const FLUSH_QUEUE = { sendBatch: async (bs: { body: unknown }[]) => void sent.push(...bs.map((b) => b.body)) } as unknown as Queue<never>
    await sweepPending({ SHARD, CONFIG: env.CONFIG, FLUSH_QUEUE }, { olderThanMs: 0 })
    await env.CONFIG.delete('flush-pending:golden-pool/0')
    expectGolden(file('queue.flush'), { format: 'queue.flush', version: FORMATS['queue.flush'], message: JSON.stringify(sent[0]) })
  })

  it('r2.dead-letters: one object per batch, as written; and every version still reads', async () => {
    const puts: { key: string; body: string }[] = []
    const BUCKET = { put: async (key: string, body: string) => void puts.push({ key, body }) } as unknown as R2Bucket
    const batch = createMessageBatch<unknown>('viz-flush-dlq', [
      { id: 'm-1', timestamp: 0, attempts: 9, body: { v: 1, tenant: 't1', shard: 'p/0' } },
      { id: 'm-2', timestamp: 0, attempts: 9, body: 'garbage' },
    ])
    const ctx = createExecutionContext()
    expect(await consumeDeadLetters(batch, { BUCKET, CELL: 'cell-0' })).toBe(2)
    await getQueueResult(batch, ctx)
    expect(puts).toHaveLength(1)
    const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/
    expect(puts[0]!.key).toMatch(ISO)
    expect(puts[0]!.body).toMatch(/"at":\d{13}/)
    expectGolden(file('r2.dead-letters'), {
      format: 'r2.dead-letters',
      version: FORMATS['r2.dead-letters'],
      key: puts[0]!.key.replace(ISO, '<iso time>'),
      body: puts[0]!.body.replace(/"at":\d{13}/g, '"at":"<ms>"'),
    })
    // The reader reads every version's golden object, oldest first, and refuses a newer one.
    const queue = `golden-dlq-${Date.now().toString(36)}`
    const prefix = `${env.CELL}/dead-letters/${queue}/`
    for (const v of [1, 2]) {
      const g = goldenFile(file('r2.dead-letters', v)) as { body: string }
      await env.BUCKET.put(`${prefix}v${v}.json`, g.body.replaceAll('"<ms>"', '1700000000000'))
    }
    const letters: DeadLetter[] = await listDeadLetters(env, queue)
    expect(letters.map((l) => l.id)).toEqual(['m-0', 'm-1', 'm-2'])
    await env.BUCKET.put(`${prefix}v3.json`, JSON.stringify({ v: 3, letters: [] }))
    await expect(listDeadLetters(env, queue)).rejects.toThrow(/version 3/)
  })

  it('key.flush-file: the key of fixed parts, content hash included', () => {
    const key = dataFileKey({ cell: 'cell-0', table: 'metric_samples', tenant: 'golden-tenant', day: '2026-11-18', level: 0, shard: 'pool/3', incarnation: 1763467200000123, seqLo: 7, seqHi: 9, sha256Hex: '0123456789abcdef'.repeat(4) })
    expectGolden(file('key.flush-file'), { format: 'key.flush-file', version: FORMATS['key.flush-file'], key })
  })

  it('reader: a flush message of an unknown version is retried, never flushed or dead-lettered', async () => {
    const dead: unknown[] = []
    const batch = createMessageBatch('viz-flush', [{ id: 'u', timestamp: 0, attempts: 1, body: { v: 99, tenant: 'x', shard: 'y' } }])
    const ctx = createExecutionContext()
    const out = await consumeFlushBatch(batch, env, engine, { flush: async () => { throw new Error('must not run') }, deadLetter: async (l) => void dead.push(...l) })
    expect(out).toEqual([])
    expect(dead).toEqual([])
    expect((await getQueueResult(batch, ctx)).retryMessages.map((m) => m.msgId)).toEqual(['u'])
  })
})
