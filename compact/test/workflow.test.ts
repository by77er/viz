import { introspectWorkflowInstance } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { flushTenant } from '../../flush/src/flush'
import { DAY_MS, Sent, T0, append, liveKeys, read, someSamples, stream } from '../../flush/test/helpers'
import { engine } from '../src/index'

describe('CompactWorkflow', () => {
  it('runs one merge per step until the tenant is idle, and reports what it did', async () => {
    const s = stream('wf')
    const sent = new Sent()
    for (let i = 0; i < 7; i++) {
      await append(s.shard, s.tenant, someSamples(s.tenant, T0 - DAY_MS + i * 50 * 60_000, 24, i), sent)
      await s.shard.seal(s.tenant)
    }
    await flushTenant(env, engine, s.tenant, s.shardName)
    expect(await liveKeys(s.ledger)).toHaveLength(14)

    const id = `compact-${s.tenant}`
    const instance = await introspectWorkflowInstance(env.COMPACT, id)
    try {
      await env.COMPACT.create({ id, params: { tenant: s.tenant, now: T0 + 2 * DAY_MS, policy: { maxInputPairs: 3 } } })
      // The first step's result is the step function's status, a few bytes; no file crosses Workflow state.
      expect(await instance.waitForStepResult({ name: 'merge 0' })).toEqual({ status: 'merged', detail: '' })
      await instance.waitForStatus('complete')
      const out = (await instance.getOutput()) as { merged: number; conflicts: number; stopped: string }
      expect(out.stopped).toBe('idle')
      expect(out.merged).toBeGreaterThanOrEqual(3)
      expect(out.conflicts).toBe(0)
    } finally {
      await instance.dispose()
    }
    const plan = await s.ledger.plan({ table: 'metric_samples', minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
    expect(plan.files.every((f) => f.level === 2)).toBe(true)
    expect(plan.files.length).toBeLessThan(7)
    expect((await read(s.tenant, [s.shardName])).canon).toEqual(sent.canon())
  })
})
