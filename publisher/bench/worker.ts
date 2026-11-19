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
