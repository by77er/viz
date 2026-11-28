/**
 * D82: one maintenance invocation runs every tenant of its batch under ONE CPU limit, so the runs
 * share one modelled CPU budget (`MAINT_CPU_BUDGET_MS`): each run is given what the runs before it
 * left, and a run that finds it spent still expires and deletes, its merges left for a follow-up.
 */
import { createMessageBatch } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { MAINT_CPU_BUDGET_MS, MAINT_QUEUE_NAME, type MaintReport, type StackEnv, consumeMaintBatch, engine } from '../src/index'

describe('maintenance shares one CPU budget per batch (D82)', () => {
  it('gives each run what the runs before it left, and every run still runs', async () => {
    const given: [string, number | undefined][] = []
    const spend: Record<string, number> = { a: 9_000, b: 7_000, c: 0 }
    const run = async (_e: unknown, _g: unknown, tenant: string, o: { cpuBudgetMs?: number }) => {
      given.push([tenant, o.cpuBudgetMs])
      return { tenant, compaction: { steps: [], merged: 0, more: false, nextDueAt: null, modelledCpuMs: Math.min(spend[tenant]!, o.cpuBudgetMs ?? Infinity) }, more: false } as unknown as MaintReport
    }
    const batch = createMessageBatch(MAINT_QUEUE_NAME, ['a', 'b', 'c'].map((tenant, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body: { v: 1, tenant } })))
    const out = await consumeMaintBatch(batch, env as unknown as StackEnv, engine, { run: run as never })
    expect(out.map((o) => o.action)).toEqual(['done', 'done', 'done'])
    expect(given).toEqual([['a', MAINT_CPU_BUDGET_MS], ['b', MAINT_CPU_BUDGET_MS - 9_000], ['c', 0]])
  })
})
