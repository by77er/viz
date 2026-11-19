import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { createEngine } from '../../engine/wasm/js/index'
import wasm from '../../engine/wasm/js/viz_engine.wasm'
import { type CompactEnv, type CompactPolicy, type CompactRun, compactStep, compactTenant } from './compact'

export { Shard } from '../../shard/src/shard'
export { Ledger } from '../../ledger/src/ledger'
export * from './compact'

/** One engine per isolate. `reset()` after a large merge returns its linear memory. */
export const engine = createEngine(wasm)

/** RPC: `env.COMPACT_SERVICE.compactTenant(tenant)` runs steps until idle or `maxSteps`. */
export class Compact extends WorkerEntrypoint<CompactEnv> {
  compactTenant(tenant: string, maxSteps = 8): Promise<CompactRun> {
    return compactTenant(this.env, engine, tenant, { maxSteps })
  }
  override fetch(): Response {
    return new Response('viz compact')
  }
}

export interface CompactParams {
  tenant: string
  maxSteps?: number
  policy?: Partial<CompactPolicy>
  /** Policy clock override, for tests. */
  now?: number
}

export interface CompactSummary {
  merged: number
  conflicts: number
  stopped: 'idle' | 'max_steps' | 'error'
  detail?: string
}

/**
 * The same step function as a Workflow: one `step.do` per merge, so a large backlog is
 * worked off across as many invocations as it needs, each merge retried by the Workflows
 * runtime, and every step's outcome is in the instance's history. A step returns a few
 * hundred bytes; the files never pass through Workflow state.
 */
export class CompactWorkflow extends WorkflowEntrypoint<CompactEnv, CompactParams> {
  override async run(event: WorkflowEvent<CompactParams>, step: WorkflowStep): Promise<CompactSummary> {
    const { tenant, policy, now } = event.payload
    const maxSteps = event.payload.maxSteps ?? 64
    const out: CompactSummary = { merged: 0, conflicts: 0, stopped: 'max_steps' }
    for (let i = 0; i < maxSteps; i++) {
      const r = await step.do(`merge ${i}`, { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '5 minutes' }, async () => {
        const s = await compactStep(this.env, engine, tenant, { policy, now })
        return { status: s.status, detail: s.status === 'error' ? `${s.reason}: ${s.detail}` : '' }
      })
      if (r.status === 'merged') out.merged++
      else if (r.status === 'conflict') out.conflicts++
      else {
        out.stopped = r.status === 'idle' ? 'idle' : 'error'
        if (r.detail) out.detail = r.detail
        break
      }
    }
    return out
  }
}

export default Compact
