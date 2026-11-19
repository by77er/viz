import type { LedgerTable } from '../../contracts/ledger'
import { holding, type Store, type StoreObject } from '../src/log'
import { Publisher, type CommitStep, type PublishResult, type PublisherConfig, type PublisherEnv } from '../src/publisher'
import { Publisher as PublisherD64 } from './d64/publisher'
import { Publisher as PublisherN1 } from './n1/publisher'

export { Ledger } from '../../ledger/src/ledger'
export { Ledger as LedgerAsBuilt } from '../../ledger/bench/asbuilt/ledger'
/** The ledger release before checkpoints in parts (ledger/bench/before/, frozen): ledger N-1 for the publisher. */
export { Ledger as LedgerBefore } from '../../ledger/bench/before/ledger'

/**
 * R2 under the publisher's own counting store, as tests see it: how many operations are in
 * flight at once (a GET until its body has been read), the order of GETs, and a hook run before
 * each GET (to pause there, or to delete an object just before it is read).
 */
class Probe implements Store {
  inFlight = 0
  max = 0
  gets: string[] = []
  constructor(
    private readonly bucket: R2Bucket,
    private readonly before: (key: string) => Promise<void>,
  ) {}
  private enter(): () => void {
    this.inFlight++
    this.max = Math.max(this.max, this.inFlight)
    let done = false
    return () => {
      if (!done) {
        done = true
        this.inFlight--
      }
    }
  }
  async get(key: string): Promise<StoreObject | null> {
    const exit = this.enter()
    this.gets.push(key)
    try {
      await this.before(key)
      const o = await this.bucket.get(key)
      if (!o) {
        exit()
        return null
      }
      return holding(o, exit)
    } catch (e) {
      exit()
      throw e
    }
  }
  private async op<T>(f: () => Promise<T>): Promise<T> {
    const exit = this.enter()
    try {
      return await f()
    } finally {
      exit()
    }
  }
  head(key: string) {
    return this.op(() => this.bucket.head(key))
  }
  list(options: R2ListOptions) {
    return this.op(() => this.bucket.list(options))
  }
  put(key: string, value: string | Uint8Array, options?: R2PutOptions) {
    return this.op(() => this.bucket.put(key, value, options) as Promise<R2Object | null>)
  }
  delete(keys: string | string[]) {
    return this.op(() => this.bucket.delete(keys))
  }
}

/**
 * `Publisher` with the seams the tests need. None of this changes what a commit does.
 *
 * - The object name may carry a suffix after `~`, so two objects can act as two writers on
 *   one cell (`c1` and `c1~b`).
 * - `failAt` makes the next commit throw right after a step, as a crash there would.
 * - `pauseAt` holds a commit after a step until `resume` is called.
 * - `advanceClock` moves the publisher's clock (persisted, so it survives eviction).
 * - `publishes` returns what every publish since the last call reported, the alarm's included.
 */
export class TestPublisher extends Publisher {
  private results: PublishResult[] = []
  private fail: { step: CommitStep; table?: LedgerTable } | null = null
  private pause: { step: CommitStep; table?: LedgerTable } | null = null
  private waiting: (() => void) | null = null
  private reached: (() => void) | null = null
  private notifyDelayMs = 0
  private notifyFails = false
  private probe: Probe | null = null
  private onGet: { match: string; pause: boolean; fail?: boolean; del: string | null; reached: (() => void) | null; resume: Promise<void> | null } | null = null
  private seeded: number | null = null
  /** One more seeded sequence per span or log table: the metric tables draw from `seeded` alone, as releases N-1 do. */
  private seededSignal = new Map<LedgerTable, number>()
  private fixedNow: number | null = null

  constructor(ctx: DurableObjectState, env: PublisherEnv) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS test_clock (k INTEGER PRIMARY KEY, offset INTEGER NOT NULL)`)
  }

  protected override cellOf(name: string): string {
    return name.split('~')[0] as string
  }

  protected override now(): number {
    const r = this.ctx.storage.sql.exec(`SELECT offset FROM test_clock WHERE k = 0`).toArray()[0]
    return (this.fixedNow ?? Date.now()) + ((r?.offset as number | undefined) ?? 0)
  }

  protected override bucket(): Store {
    this.probe ??= new Probe(this.env.BUCKET, (key) => this.beforeGet(key))
    return this.probe
  }

  /**
   * A seeded generator (xorshift32) instead of `crypto`, so two publications can be compared byte
   * for byte. The metric tables (and a call that names no table) draw from one sequence, as the
   * releases before do; each span or log table from its own, so the metric tables' ids are the same
   * whether or not the log has span or log changes (production draws from `crypto` either way).
   */
  protected override random(n: number, table?: LedgerTable): Uint8Array {
    if (this.seeded === null) return super.random(n, table)
    const signal = table === 'spans' || table === 'trace_index' || table === 'logs'
    let x = signal ? (this.seededSignal.get(table) ?? (((this.seeded0 ^ hashOf(table)) >>> 0) || 1)) : this.seeded
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      x >>>= 0
      out[i] = x & 0xff
    }
    if (signal) this.seededSignal.set(table, x || 1)
    else this.seeded = x || 1
    return out
  }
  private seeded0 = 1

  /** Fixed ids and a fixed clock for this instance: what a byte-for-byte comparison needs. */
  async determinism(seed: number, now: number): Promise<void> {
    this.seeded = seed >>> 0 || 1
    this.seeded0 = this.seeded
    this.seededSignal = new Map()
    this.fixedNow = now
  }

  private async beforeGet(key: string): Promise<void> {
    const h = this.onGet
    if (!h || !key.includes(h.match)) return
    this.onGet = null
    if (h.del) await this.env.BUCKET.delete(h.del)
    if (h.fail) throw new Error(`injected: R2 failed reading ${key}`)
    if (h.pause) {
      h.reached?.()
      await h.resume
    }
  }

  /** The next GET of a key containing `match` first deletes `key`. */
  async deleteOnGet(match: string, key: string): Promise<void> {
    this.onGet = { match, pause: false, del: key, reached: null, resume: null }
  }

  /** The next GET of a key containing `match` fails, as R2 can. */
  async failOnGet(match: string): Promise<void> {
    this.onGet = { match, pause: false, fail: true, del: null, reached: null, resume: null }
  }

  /** The next GET of a key containing `match` waits forever (until the instance is evicted). Resolves when it is reached. */
  async pauseOnGet(match: string): Promise<void> {
    await new Promise<void>((resolve) => {
      this.onGet = { match, pause: true, del: null, reached: resolve, resume: new Promise<void>(() => {}) }
    })
  }

  /** R2 operations in flight at most, and the GETs in order, since the last call (this instance only). */
  async r2(): Promise<{ max: number; gets: string[] }> {
    const p = this.probe
    const out = { max: p?.max ?? 0, gets: p?.gets ?? [] }
    if (p) {
      p.max = p.inFlight
      p.gets = []
    }
    return out
  }

  override async publish(tenants?: string[]): Promise<PublishResult> {
    const r = await super.publish(tenants)
    this.results.push(r)
    return r
  }

  /** The results of the publishes since the last call (this instance only: an eviction forgets them). */
  async publishes(): Promise<PublishResult[]> {
    const out = this.results
    this.results = []
    return out
  }

  /** Reset the object now, as the runtime does when it evicts or loses it: whatever it was doing stops where it is. */
  async abortNow(): Promise<void> {
    this.ctx.abort('injected: the object is reset')
  }

  /** When each tenant waiting for a re-base last had one started (table `rebase`), in the publisher's clock. */
  async rebaseQueue(): Promise<Record<string, number>> {
    return Object.fromEntries(this.ctx.storage.sql.exec(`SELECT tenant, started FROM rebase ORDER BY tenant`).toArray().map((r) => [r.tenant as string, r.started as number]))
  }

  /** Rows of a scratch table (`stage`, `live_next`). */
  async scratch(): Promise<{ stage: number; liveNext: number }> {
    const n = (t: string) => this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).one().n as number
    return { stage: n('stage'), liveNext: n('live_next') }
  }

  protected override async step(name: CommitStep, table: LedgerTable): Promise<void> {
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

  /** A publisher that is slow to answer a nudge, or refuses it (as one refusing newer storage would). */
  async misbehave(opts: { notifyDelayMs?: number; notifyFails?: boolean }): Promise<void> {
    this.notifyDelayMs = opts.notifyDelayMs ?? 0
    this.notifyFails = opts.notifyFails ?? false
  }

  override async notify(tenants: string[]): Promise<void> {
    if (this.notifyFails) throw new Error('injected: notify refused')
    if (this.notifyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.notifyDelayMs))
    return super.notify(tenants)
  }

  /** The deadlines the alarm serves, by job (the `due` table), and the alarm itself. */
  async schedule(): Promise<{ due: Record<string, number>; alarm: number | null; now: number }> {
    const due: Record<string, number> = {}
    for (const r of this.ctx.storage.sql.exec(`SELECT job, at FROM due UNION ALL SELECT job, at FROM signal_due ORDER BY job`).toArray()) due[r.job as string] = r.at as number
    return { due, alarm: await this.ctx.storage.getAlarm(), now: this.now() }
  }

  async failAt(step: CommitStep, table?: LedgerTable): Promise<void> {
    this.fail = { step, table }
  }

  /** Arms a pause and resolves when a commit has reached it. */
  async pauseAt(step: CommitStep, table?: LedgerTable): Promise<void> {
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

/**
 * The publisher release before this one read the span and log tables (`test/n1/`, frozen at
 * 9292abb), with only the seams a side-by-side comparison needs: two writers' names on one cell,
 * a persisted clock offset, and fixed ids and clock for byte-for-byte comparison. Nothing else.
 */
export class TestPublisherN1 extends PublisherN1 {
  private seeded: number | null = null
  private fixedNow: number | null = null

  constructor(ctx: DurableObjectState, env: PublisherEnv) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS test_clock (k INTEGER PRIMARY KEY, offset INTEGER NOT NULL)`)
  }

  protected override cellOf(name: string): string {
    return name.split('~')[0] as string
  }

  protected override now(): number {
    const r = this.ctx.storage.sql.exec(`SELECT offset FROM test_clock WHERE k = 0`).toArray()[0]
    return (this.fixedNow ?? Date.now()) + ((r?.offset as number | undefined) ?? 0)
  }

  protected override random(n: number): Uint8Array {
    if (this.seeded === null) return super.random(n)
    const out = new Uint8Array(n)
    let x = this.seeded
    for (let i = 0; i < n; i++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      x >>>= 0
      out[i] = x & 0xff
    }
    this.seeded = x || 1
    return out
  }

  async determinism(seed: number, now: number): Promise<void> {
    this.seeded = seed >>> 0 || 1
    this.fixedNow = now
  }

  async advanceClock(ms: number): Promise<void> {
    this.ctx.storage.sql.exec(`INSERT INTO test_clock (k, offset) VALUES (0, ?) ON CONFLICT (k) DO UPDATE SET offset = offset + excluded.offset`, ms)
  }
}

/**
 * The D64 release (`test/d64/`, frozen at bcfe8db): it reads the span and log tables and does not
 * publish them, the release before this one and, by D64's rollout rule, the oldest viz-publisher a
 * rollback can reach once `INGEST_SIGNALS` is on. The same seams as `TestPublisherN1`, nothing else.
 */
export class TestPublisherD64 extends PublisherD64 {
  private seeded: number | null = null
  private fixedNow: number | null = null

  constructor(ctx: DurableObjectState, env: PublisherEnv) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS test_clock (k INTEGER PRIMARY KEY, offset INTEGER NOT NULL)`)
  }

  protected override cellOf(name: string): string {
    return name.split('~')[0] as string
  }

  protected override now(): number {
    const r = this.ctx.storage.sql.exec(`SELECT offset FROM test_clock WHERE k = 0`).toArray()[0]
    return (this.fixedNow ?? Date.now()) + ((r?.offset as number | undefined) ?? 0)
  }

  protected override random(n: number): Uint8Array {
    if (this.seeded === null) return super.random(n)
    const out = new Uint8Array(n)
    let x = this.seeded
    for (let i = 0; i < n; i++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      x >>>= 0
      out[i] = x & 0xff
    }
    this.seeded = x || 1
    return out
  }

  async determinism(seed: number, now: number): Promise<void> {
    this.seeded = seed >>> 0 || 1
    this.fixedNow = now
  }

  async advanceClock(ms: number): Promise<void> {
    this.ctx.storage.sql.exec(`INSERT INTO test_clock (k, offset) VALUES (0, ?) ON CONFLICT (k) DO UPDATE SET offset = offset + excluded.offset`, ms)
  }
}

/** A 32-bit FNV-1a of a table name: the seed offset of that table's sequence. */
function hashOf(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export default {
  fetch: () => new Response('viz publisher (test build)'),
} satisfies ExportedHandler
