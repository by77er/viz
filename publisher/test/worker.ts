import type { Table } from '../../contracts/ledger'
import { Publisher, type CommitStep, type PublisherConfig, type PublisherEnv } from '../src/publisher'

export { Ledger } from '../../ledger/src/ledger'
export { Ledger as LedgerAsBuilt } from '../../ledger/bench/asbuilt/ledger'

/**
 * `Publisher` with the seams the tests need. None of this changes what a commit does.
 *
 * - The object name may carry a suffix after `~`, so two objects can act as two writers on
 *   one cell (`c1` and `c1~b`).
 * - `failAt` makes the next commit throw right after a step, as a crash there would.
 * - `pauseAt` holds a commit after a step until `resume` is called.
 * - `advanceClock` moves the publisher's clock (persisted, so it survives eviction).
 */
export class TestPublisher extends Publisher {
  private fail: { step: CommitStep; table?: Table } | null = null
  private pause: { step: CommitStep; table?: Table } | null = null
  private waiting: (() => void) | null = null
  private reached: (() => void) | null = null

  constructor(ctx: DurableObjectState, env: PublisherEnv) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS test_clock (k INTEGER PRIMARY KEY, offset INTEGER NOT NULL)`)
  }

  protected override cellOf(name: string): string {
    return name.split('~')[0] as string
  }

  protected override now(): number {
    const r = this.ctx.storage.sql.exec(`SELECT offset FROM test_clock WHERE k = 0`).toArray()[0]
    return Date.now() + ((r?.offset as number | undefined) ?? 0)
  }

  protected override async step(name: CommitStep, table: Table): Promise<void> {
    if (this.fail && this.fail.step === name && (!this.fail.table || this.fail.table === table)) {
      this.fail = null
      throw new Error(`injected crash after ${name} (${table})`)
    }
    if (this.pause && this.pause.step === name && (!this.pause.table || this.pause.table === table)) {
      this.pause = null
      this.reached?.()
      await new Promise<void>((resolve) => { this.waiting = resolve })
    }
  }

  async failAt(step: CommitStep, table?: Table): Promise<void> {
    this.fail = { step, table }
  }

  /** Arms a pause and resolves when a commit has reached it. */
  async pauseAt(step: CommitStep, table?: Table): Promise<void> {
    this.pause = { step, table }
    await new Promise<void>((resolve) => { this.reached = resolve })
  }

  async resume(): Promise<void> {
    this.waiting?.()
    this.waiting = null
  }

  /**
   * `publish` and `configure` for tests that expect a failure. An exception that crosses the
   * RPC boundary is reported by the test runner as unhandled even when the test catches it,
   * so the failure is returned as a value instead.
   */
  async tryPublish(tenants?: string[]): Promise<{ error: string | null }> {
    try {
      await this.publish(tenants)
      return { error: null }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  async tryConfigure(patch: Partial<PublisherConfig>): Promise<{ error: string | null }> {
    try {
      await this.configure(patch)
      return { error: null }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  async advanceClock(ms: number): Promise<void> {
    this.ctx.storage.sql.exec(`INSERT INTO test_clock (k, offset) VALUES (0, ?) ON CONFLICT (k) DO UPDATE SET offset = offset + excluded.offset`, ms)
  }
}

export default {
  fetch: () => new Response('viz publisher (test build)'),
} satisfies ExportedHandler
