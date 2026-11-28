/**
 * The re-base benchmark's script (bench/rebase.bench.test.ts): this publisher with fixed ids and
 * clock (so two runs can be compared byte for byte), and the frozen publisher from before the
 * streaming re-base (bench/before/), the counterfactual. Not deployed.
 */
import { Publisher, type PublisherEnv } from '../src/publisher'
import { Publisher as Before } from './before/publisher'

/** `cell~anything` publishes into `cell`: one cell, a fresh publisher (SQLite) per run. */
const cellOf = (name: string) => name.split('~')[0] as string

export class BenchPublisher extends Publisher {
  private seed = 20261119
  protected override cellOf(name: string): string {
    return cellOf(name)
  }
  protected override now(): number {
    return Date.UTC(2026, 10, 19)
  }
  protected override random(n: number): Uint8Array {
    const out = new Uint8Array(n)
    let x = this.seed
    for (let i = 0; i < n; i++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      x >>>= 0
      out[i] = x & 0xff
    }
    this.seed = x || 1
    return out
  }
  /**
   * What the D64 release leaves (`bench/upgrade.bench.test.ts`): the span and log tables never
   * published, so no cursor, file, manifest or snapshot of them here and no object of them in R2.
   */
  async forgetSignalTables(cell: string): Promise<void> {
    const signal = ['spans', 'trace_index', 'logs']
    const sql = this.ctx.storage.sql
    for (const t of signal) {
      for (const tbl of ['cursor', 'live', 'manifest', 'snap', 'removed']) sql.exec(`DELETE FROM ${tbl} WHERE tbl = ?`, t)
      sql.exec(`DELETE FROM tbl WHERE name = ?`, t)
      sql.exec(`DELETE FROM signal_due WHERE job = ?`, `expire:${t}`)
      for (;;) {
        const page = await this.env.BUCKET.list({ prefix: `${cell}/iceberg/${t}/`, limit: 1000 })
        if (page.objects.length === 0) break
        await this.env.BUCKET.delete(page.objects.map((o) => o.key))
      }
    }
    sql.exec(`DELETE FROM signal_orphan`)
  }

  /** Rows in a table of this object's SQLite (for the checks after a run). */
  async rows(table: string): Promise<number> {
    return this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n as number
  }
}

export class PublisherBefore extends Before {
  constructor(ctx: DurableObjectState, env: PublisherEnv) {
    super(ctx, env)
  }
  protected override cellOf(name: string): string {
    return cellOf(name)
  }
}

export default { fetch: () => new Response('viz publisher bench') } satisfies ExportedHandler
