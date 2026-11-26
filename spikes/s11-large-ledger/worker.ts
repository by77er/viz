/**
 * Spike S11: the ledger's state above 16 MiB on Cloudflare (see README.md).
 *
 * One Worker, `viz-s11-ledger`, with:
 *   Ledger                      the growing tenant ledger (G0), the ledger as built, its R2 calls timed
 *   LedgerR16/R64/R150/R150B/R300/R300B  the same class under other names: one object of the same tenant on
 *                               EMPTY storage per measurement, i.e. a ledger whose storage was lost;
 *                               it rebuilds from R2 on its first request
 *   Publisher                   the publisher as built; `cellOf` (its test seam) maps `cell-0~pNN` to
 *                               cell-0, so each measurement is a publisher on empty storage
 *   Writer                      one per stream, admits 2-file flush units with `addUnit` (as S4)
 *   Driver                      runs one job at a time from its alarm and writes results to R2
 *
 * Nothing here changes what the ledger or the publisher do. Additions, all outside their code:
 * the R2 binding is wrapped to time each call; the replicas keep their start's `RebuildResult`;
 * every alarm (ledger, replica, publisher, driver) does nothing after `S11_DEADLINE`, and the
 * publisher's alarm does nothing at all (it is driven by RPC here, so a failed publication can
 * never be retried by itself).
 *
 * Routes (header x-key, a secret set at deploy): POST /job, GET /result?id=, GET /status,
 * GET /list?prefix=, POST /purge?prefix=, GET /deadline.
 */
import { DurableObject } from 'cloudflare:workers'
import type { FileEntry, FlushUnit, Plan } from '../../contracts/ledger'
import { Ledger as LedgerAsBuilt, type LedgerEnv, type LogStatus, type RebuildResult } from '../../ledger/src/ledger'
import { Publisher as PublisherAsBuilt, type PublisherEnv, type PublishResult } from '../../publisher/src/publisher'
import type { Store, StoreObject } from '../../publisher/src/log'

const TENANT = 's11big'
const DAY0 = Date.UTC(2026, 9, 20)
const DAY_MS = 86_400_000
/** S4's index fragment: three row groups, about 500 characters (ledger/README.md, publisher/bench). */
const INDEX = JSON.stringify({
  v: 1,
  groups: Array.from({ length: 3 }, (_, g) => ({ rows: 100000, offset: 4 + g * 4_000_000, length: 4_000_000, minName: 'http_requests_total', maxName: 'process_cpu_seconds_total', minTs: 1795000000000, maxTs: 1795003600000 })),
})

interface Env extends LedgerEnv, PublisherEnv {
  LEDGER: DurableObjectNamespace<Ledger>
  LEDGER_R16: DurableObjectNamespace<LedgerR16>
  LEDGER_R64: DurableObjectNamespace<LedgerR64>
  LEDGER_R300: DurableObjectNamespace<LedgerR300>
  LEDGER_R300B: DurableObjectNamespace<LedgerR300B>
  LEDGER_R150: DurableObjectNamespace<LedgerR150>
  LEDGER_R150B: DurableObjectNamespace<LedgerR150B>
  PUBLISHER: DurableObjectNamespace<Publisher>
  WRITER: DurableObjectNamespace<Writer>
  DRIVER: DurableObjectNamespace<Driver>
  BUCKET: R2Bucket
  KEY: string
  CELL: string
  S11_DEADLINE: string
}

const pastDeadline = (env: Env) => !env.S11_DEADLINE || Date.now() > Date.parse(env.S11_DEADLINE)

// ───────────────────────────── timing R2 calls ─────────────────────────────

/** One R2 call: start (ms since epoch), duration, kind, bytes. Times inside a Durable Object advance only on I/O. */
type Op = [t0: number, ms: number, op: string, kind: string, bytes: number]

function kindOf(key: string): string {
  if (key.includes('/iceberg/')) return key.endsWith('.avro') ? 'iceberg-avro' : 'iceberg-meta'
  if (/\/ckpt-\d{12}-[0-9a-f]{8}\//.test(key)) return 'ckpt-part'
  if (/\/ckpt-\d{12}\.jsonl$/.test(key)) return 'ckpt-manifest'
  if (/\/seg-/.test(key)) return 'segment'
  return 'other'
}

/** An R2 binding that records each call. The ledger reads `get`, `head`, `list`, `put`, `delete`. */
function timedBucket(b: R2Bucket, ops: Op[]): R2Bucket {
  const rec = async <T>(op: string, key: string, run: () => Promise<T>, size: (r: T) => number): Promise<T> => {
    const t0 = Date.now()
    const r = await run()
    ops.push([t0, Date.now() - t0, op, kindOf(key), size(r)])
    return r
  }
  return {
    get: (key: string, o?: R2GetOptions) => rec('get', key, () => b.get(key, o as R2GetOptions), (r) => (r ? (r as R2Object).size : 0)),
    head: (key: string) => rec('head', key, () => b.head(key), (r) => (r ? r.size : 0)),
    list: (o?: R2ListOptions) => rec('list', String(o?.prefix ?? ''), () => b.list(o), (r) => r.objects.length),
    put: (key: string, v: Parameters<R2Bucket['put']>[1], o?: R2PutOptions) => rec('put', key, () => b.put(key, v, o), (r) => (r ? r.size : -1)),
    delete: (keys: string | string[]) => rec('delete', Array.isArray(keys) ? (keys[0] ?? '') : keys, () => b.delete(keys), () => (Array.isArray(keys) ? keys.length : 1)),
    createMultipartUpload: b.createMultipartUpload.bind(b),
    resumeMultipartUpload: b.resumeMultipartUpload.bind(b),
  } as unknown as R2Bucket
}

/** The same for the publisher's `Store`. */
function timedStore(s: Store, ops: Op[]): Store {
  const rec = async <T>(op: string, key: string, run: () => Promise<T>, size: (r: T) => number): Promise<T> => {
    const t0 = Date.now()
    const r = await run()
    ops.push([t0, Date.now() - t0, op, kindOf(key), size(r)])
    return r
  }
  return {
    get: (key) => rec('get', key, () => s.get(key), (r: StoreObject | null) => (r ? r.size : 0)),
    head: (key) => rec('head', key, () => s.head(key), (r) => (r ? r.size : 0)),
    list: (o) => rec('list', String(o.prefix ?? ''), () => s.list(o), (r) => r.objects.length),
    put: (key, v, o) => rec('put', key, () => s.put(key, v, o), () => (typeof v === 'string' ? v.length : v.byteLength)),
    delete: (keys) => rec('delete', Array.isArray(keys) ? (keys[0] ?? '') : keys, () => s.delete(keys), () => (Array.isArray(keys) ? keys.length : 1)),
  }
}

/** Ops grouped by (op, kind): count, total and largest duration, bytes, first start and last end. */
function summarise(ops: Op[]) {
  const g: Record<string, { n: number; ms: number; max: number; bytes: number; first: number; last: number }> = {}
  for (const [t0, ms, op, kind, bytes] of ops) {
    const k = `${op}:${kind}`
    const x = (g[k] ??= { n: 0, ms: 0, max: 0, bytes: 0, first: t0, last: t0 + ms })
    x.n++
    x.ms += ms
    x.max = Math.max(x.max, ms)
    x.bytes += Math.max(0, bytes)
    x.first = Math.min(x.first, t0)
    x.last = Math.max(x.last, t0 + ms)
  }
  return g
}

// ───────────────────────────── the ledger and its replicas ─────────────────────────────

/** The ledger as built; its R2 calls are timed. */
export class Ledger extends LedgerAsBuilt {
  private s11ops: Op[] = []
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Replaced before anything reaches R2: `open()` first awaits `getAlarm()`.
    this.bucket = timedBucket(env.BUCKET, this.s11ops)
  }
  /** The calls since the last read; R2 operations only, nothing of the ledger's state. */
  async s11Ops(): Promise<Op[]> {
    const out = this.s11ops.splice(0)
    return out
  }
  async alarm(): Promise<void> {
    if (pastDeadline(this.env as Env)) return void (await this.ctx.storage.deleteAlarm())
    return super.alarm()
  }
}

/** A ledger on empty storage: remembers when its start began and ended, and what it returned. */
export class LedgerReplica extends Ledger {
  private s11start: { t0: number; t1?: number; result?: RebuildResult; error?: string } | null = null
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const self = this as unknown as { startIncarnation: (mode: 'r2' | 'sqlite') => Promise<RebuildResult> }
    const original = self.startIncarnation.bind(this)
    self.startIncarnation = async (mode) => {
      const rec: { t0: number; t1?: number; result?: RebuildResult; error?: string } = { t0: Date.now() }
      this.s11start = rec
      try {
        rec.result = await original(mode)
        return rec.result
      } catch (e) {
        rec.error = String(e).slice(0, 400)
        throw e
      } finally {
        rec.t1 = Date.now()
      }
    }
  }
  async s11Start() {
    return this.s11start
  }
}
export class LedgerR16 extends LedgerReplica {}
export class LedgerR64 extends LedgerReplica {}
export class LedgerR300 extends LedgerReplica {}
export class LedgerR300B extends LedgerReplica {}
export class LedgerR150 extends LedgerReplica {}
export class LedgerR150B extends LedgerReplica {}

type Gen = 'G0' | 'R16' | 'R64' | 'R150' | 'R150B' | 'R300' | 'R300B'
function ledgerOf(env: Env, gen: Gen): DurableObjectStub<LedgerReplica> {
  const ns = { G0: env.LEDGER, R16: env.LEDGER_R16, R64: env.LEDGER_R64, R150: env.LEDGER_R150, R150B: env.LEDGER_R150B, R300: env.LEDGER_R300, R300B: env.LEDGER_R300B }[gen] as unknown as DurableObjectNamespace<LedgerReplica>
  return ns.get(ns.idFromName(TENANT))
}

// ───────────────────────────── the publisher ─────────────────────────────

export class Publisher extends PublisherAsBuilt {
  private s11ops: Op[] = []
  private s11store: Store | null = null
  /** The test seam: `cell-0~p16` publishes cell-0, on its own storage. */
  protected cellOf(name: string): string {
    return name.split('~')[0]!
  }
  protected bucket(): Store {
    return (this.s11store ??= timedStore(super.bucket(), this.s11ops))
  }
  /** Driven by RPC only: its own alarm never publishes (so nothing retries by itself). */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
  }
  async s11Ops(): Promise<Op[]> {
    return this.s11ops.splice(0)
  }
}

// ───────────────────────────── writers ─────────────────────────────

function unitFor(cell: string, id: number, incarnation: number, seqLo: number, seqHi: number, filesPerUnit: number): FlushUnit {
  const day = new Date(DAY0 + ((id * 7 + Math.floor(seqLo / 4)) % 30) * DAY_MS).toISOString().slice(0, 10)
  const files: FileEntry[] = Array.from({ length: filesPerUnit }, (_, f) => {
    const table = f % 2 === 0 ? 'metric_samples' : 'metric_series'
    return {
      table,
      day,
      key: `${cell}/data/${table}/tenant=${TENANT}/day=${day}/L0-pool_s11_${id}-${incarnation}-${seqLo}-${seqHi}-${f}${((seqLo * 2654435761) >>> 0).toString(16).padStart(8, '0')}.parquet`,
      bytes: 8_000_000,
      rows: 300_000,
      minTs: Date.parse(day),
      maxTs: Date.parse(day) + 86_399_000,
      level: 0,
      index: INDEX,
    }
  })
  return { shard: `pool/s11/${id}`, incarnation, seqLo, seqHi, files }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]!
}

export class Writer extends DurableObject<Env> {
  /** Admit up to `units` 2-file units on stream `id` of the G0 ledger, until `untilMs`; stops at the first answer other than ok. */
  async run(id: number, units: number, untilMs: number) {
    const ledger = ledgerOf(this.env, 'G0')
    const st = (await this.ctx.storage.get<{ incarnation: number; seq: number }>('st')) ?? { incarnation: 1000 + id, seq: 0 }
    const lat: number[] = []
    const status: Record<string, number> = {}
    let err: string | undefined
    try {
      for (let u = 0; u < units && Date.now() < untilMs; u++) {
        const t = Date.now()
        const r = await ledger.addUnit(unitFor(this.env.CELL, id, st.incarnation, st.seq + 1, st.seq + 4, 2))
        lat.push(Date.now() - t)
        status[r.status] = (status[r.status] ?? 0) + 1
        if (r.status !== 'ok') break
        st.seq += 4
      }
    } catch (e) {
      err = String(e).slice(0, 300)
    }
    await this.ctx.storage.put('st', st)
    return { n: lat.length, status, err, seq: st.seq, p50: pct(lat, 50), p90: pct(lat, 90), p99: pct(lat, 99), max: Math.max(0, ...lat) }
  }
  async seq() {
    return (await this.ctx.storage.get<{ incarnation: number; seq: number }>('st')) ?? null
  }
}

// ───────────────────────────── the driver ─────────────────────────────

type Job =
  | { op: 'fill'; targetBytes: number; writers: number; maxMs: number }
  | { op: 'quiesce'; maxMs: number }
  | { op: 'rebuild'; gen: Gen; probeMs: number; maxMs: number }
  | { op: 'publish'; name: string }
  | { op: 'drop'; incarnation: number }
  | { op: 'snapshot'; gen: Gen }

const EMPTY = { table: 'metric_samples' as const, minTs: 0, maxTs: 0 }
const oneDay = (d: number, table: 'metric_samples' | 'metric_series') => ({ table, minTs: DAY0 + d * DAY_MS, maxTs: DAY0 + d * DAY_MS + 86_399_000 })

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

/** What must be equal after a rebuild: version, watermarks, state estimate, and the files of two days of each table. */
async function fingerprint(ledger: DurableObjectStub<LedgerReplica>) {
  const p: Plan = await ledger.plan(EMPTY)
  const st: LogStatus = await ledger.logStatus()
  const days: Record<string, { files: number; sha: string }> = {}
  for (const d of [3, 17]) {
    for (const t of ['metric_samples', 'metric_series'] as const) {
      const q = await ledger.plan(oneDay(d, t))
      days[`${t}@${d}`] = { files: q.files.length, sha: await sha(JSON.stringify(q.files)) }
    }
  }
  return { incarnation: p.ledgerIncarnation, version: p.version, watermarks: await sha(JSON.stringify(p.watermarks)), streams: p.watermarks.length, stateBytes: st.stateBytes, days }
}

async function listAll(b: R2Bucket, prefix: string) {
  const out: { key: string; size: number; uploaded: number }[] = []
  let cursor: string | undefined
  do {
    const page = await b.list({ prefix, cursor, limit: 1000 })
    for (const o of page.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded.getTime() })
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

/** The G0 log in R2, by kind: counts, bytes, the checkpoints there now (format 2: parts per attempt). */
async function logInR2(env: Env) {
  const objs = await listAll(env.BUCKET, `${env.CELL}/ledger/tenant=${TENANT}/`)
  const incs: Record<string, { segments: number; segBytes: number; checkpoints: Record<string, { manifestBytes?: number; parts: number; partBytes: number; firstPut: number; lastPut: number }> }> = {}
  for (const o of objs) {
    const m = /tenant=[^/]+\/(\d+)\/(.*)$/.exec(o.key)
    if (!m) continue
    const inc = (incs[m[1]!] ??= { segments: 0, segBytes: 0, checkpoints: {} })
    const rest = m[2]!
    let c: RegExpExecArray | null
    if (rest.startsWith('seg-')) {
      inc.segments++
      inc.segBytes += o.size
    } else if ((c = /^ckpt-(\d{12})-([0-9a-f]{8})\//.exec(rest))) {
      const k = `${Number(c[1])}-${c[2]}`
      const x = (inc.checkpoints[k] ??= { parts: 0, partBytes: 0, firstPut: o.uploaded, lastPut: o.uploaded })
      x.parts++
      x.partBytes += o.size
      x.firstPut = Math.min(x.firstPut, o.uploaded)
      x.lastPut = Math.max(x.lastPut, o.uploaded)
    } else if ((c = /^ckpt-(\d{12})\.jsonl$/.exec(rest))) {
      const v = Number(c[1])
      const key = Object.keys(inc.checkpoints).find((k) => k.startsWith(`${v}-`)) ?? `${v}-?`
      const x = (inc.checkpoints[key] ??= { parts: 0, partBytes: 0, firstPut: o.uploaded, lastPut: o.uploaded })
      x.manifestBytes = o.size
      x.lastPut = Math.max(x.lastPut, o.uploaded)
    }
  }
  return incs
}

export class Driver extends DurableObject<Env> {
  private running = false

  async start(id: string, job: Job): Promise<{ id: string }> {
    if (pastDeadline(this.env)) throw new Error('past the spike deadline')
    await this.ctx.storage.put(`job:${id}`, { job, state: 'queued', at: Date.now() })
    await this.ctx.storage.setAlarm(Date.now())
    return { id }
  }

  async alarm(): Promise<void> {
    if (pastDeadline(this.env) || this.running) return
    const queued = [...(await this.ctx.storage.list<{ job: Job; state: string }>({ prefix: 'job:' })).entries()].filter(([, v]) => v.state !== 'done')
    if (queued.length === 0) return
    const [key, rec] = queued[0]!
    const id = key.slice(4)
    if (rec.state === 'running') {
      // An alarm retried after this job started (the handler died): never run a job twice.
      await this.ctx.storage.put(key, { ...rec, state: 'done' })
      await this.write(id, { id, error: 'the driver alarm was retried while this job ran; not run again' })
    } else {
      await this.ctx.storage.put(key, { ...rec, state: 'running' })
      this.running = true
      let out: unknown
      const t0 = Date.now()
      try {
        out = await this.run(rec.job)
      } catch (e) {
        out = { error: String(e).slice(0, 600) }
      } finally {
        this.running = false
      }
      await this.write(id, { id, job: rec.job, startedAt: new Date(t0).toISOString(), endedAt: new Date().toISOString(), out })
      await this.ctx.storage.put(key, { ...rec, state: 'done' })
    }
    if (queued.length > 1) await this.ctx.storage.setAlarm(Date.now())
  }

  private async write(id: string, body: unknown) {
    await this.env.BUCKET.put(`s11/results/${id}.json`, JSON.stringify(body))
  }

  private run(job: Job): Promise<unknown> {
    switch (job.op) {
      case 'fill': return this.fill(job)
      case 'quiesce': return this.quiesce(job.maxMs)
      case 'rebuild': return this.rebuild(job)
      case 'publish': return this.publish(job.name)
      case 'drop': return this.drop(job.incarnation)
      case 'snapshot': return this.snapshot(job.gen)
    }
  }

  /** Admit units on G0 with `writers` writers until its state reaches `targetBytes`; logStatus sampled every second. */
  private async fill(job: Extract<Job, { op: 'fill' }>) {
    const g0 = ledgerOf(this.env, 'G0')
    const t0 = Date.now()
    const until = t0 + job.maxMs
    const timeline: unknown[] = []
    let lastCk = ''
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        try {
          const s = await g0.logStatus()
          const ck = JSON.stringify(s.checkpoint ? { v: s.checkpoint.version, phase: s.checkpoint.phase } : null)
          if (ck !== lastCk || timeline.length === 0) {
            timeline.push({ t: Date.now(), version: s.version, stateBytes: s.stateBytes, pending: s.pending, segmentsWritten: s.segmentsWritten, segmentsSinceCheckpoint: s.segmentsSinceCheckpoint, checkpoint: s.checkpoint, lastError: s.lastError })
            lastCk = ck
          }
        } catch (e) {
          timeline.push({ t: Date.now(), error: String(e).slice(0, 200) })
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    })()
    const batches: unknown[] = []
    let state = (await g0.logStatus()).stateBytes
    const before = state
    let full = false
    const per = 2 * (INDEX.length + 120 + 448) // bytes of state per unit, about
    while (state < job.targetBytes && Date.now() < until && !full) {
      const units = Math.max(1, Math.min(400, Math.ceil((job.targetBytes - state) / per / job.writers)))
      const bt = Date.now()
      const rs = await Promise.all(Array.from({ length: job.writers }, (_, i) => this.env.WRITER.get(this.env.WRITER.idFromName(`w${i}`)).run(i, units, until)))
      const n = rs.reduce((a, r) => a + r.n, 0)
      const status: Record<string, number> = {}
      for (const r of rs) for (const [k, v] of Object.entries(r.status)) status[k] = (status[k] ?? 0) + v
      full = (status.full ?? 0) > 0
      state = (await g0.logStatus()).stateBytes
      batches.push({ ms: Date.now() - bt, units: n, status, errors: rs.map((r) => r.err).filter(Boolean).slice(0, 2), p50: Math.max(...rs.map((r) => r.p50)), p99: Math.max(...rs.map((r) => r.p99)), max: Math.max(...rs.map((r) => r.max)), stateBytes: state })
      if (rs.every((r) => r.n === 0)) break
    }
    sampling = false
    await sampler
    const ops = (await g0.s11Ops()) as unknown as Op[]
    return { ms: Date.now() - t0, stateBefore: before, stateAfter: state, full, batches, timeline, ops: summarise(ops), ckptOps: ops.filter((o) => o[3].startsWith('ckpt')) }
  }

  /** Wait until G0 has nothing pending and no checkpoint in progress; checkpoint progress sampled meanwhile. */
  private async quiesce(maxMs: number) {
    const g0 = ledgerOf(this.env, 'G0')
    const t0 = Date.now()
    const timeline: unknown[] = []
    let last = ''
    for (;;) {
      const s = await g0.logStatus()
      const k = JSON.stringify([s.pending, s.checkpoint?.version, s.checkpoint?.phase, s.checkpoint?.parts])
      if (k !== last) timeline.push({ t: Date.now(), pending: s.pending, inFlight: s.inFlight, checkpoint: s.checkpoint, segmentsSinceCheckpoint: s.segmentsSinceCheckpoint, lastError: s.lastError })
      last = k
      if (s.pending === 0 && s.inFlight === null && s.checkpoint === null) break
      if (Date.now() - t0 > maxMs) return { quiet: false, ms: Date.now() - t0, timeline, status: s }
      await new Promise((r) => setTimeout(r, 500))
    }
    const ops = (await g0.s11Ops()) as unknown as Op[]
    return { quiet: true, ms: Date.now() - t0, timeline, status: await g0.logStatus(), ops: summarise(ops), ckptOps: ops.filter((o) => o[3].startsWith('ckpt')), log: await logInR2(this.env) }
  }

  private async snapshot(gen: Gen) {
    const l = ledgerOf(this.env, gen)
    return { gen, fingerprint: await fingerprint(l), status: await l.logStatus(), log: await logInR2(this.env) }
  }

  /**
   * The replica `gen` (empty storage, same tenant) rebuilds from R2. G0 must be quiet. The first
   * request starts it. With `probeMs` > 0, a plan and an addUnit are sent every `probeMs` (what a
   * query and a flush meet) until a plan is answered. With `probeMs` = 0, nothing is sent after
   * the first request: R2 is watched for the new incarnation's base, and one plan is sent 2 s
   * after it appears (each request resets a Durable Object's CPU budget, so this run shows
   * whether the rebuild fits the budget of the one request that started it).
   */
  private async rebuild(job: Extract<Job, { op: 'rebuild' }>) {
    const g0 = ledgerOf(this.env, 'G0')
    const s0 = await g0.logStatus()
    if (s0.pending !== 0 || s0.checkpoint !== null) return { error: 'G0 is not quiet', status: s0 }
    const before = await fingerprint(g0)
    const r = ledgerOf(this.env, job.gen)
    const probes: { t: number; op: string; ms: number; outcome: string }[] = []
    const probe = async (op: 'plan' | 'addUnit') => {
      const t = Date.now()
      try {
        if (op === 'plan') {
          await r.plan(EMPTY)
          probes.push({ t, op, ms: Date.now() - t, outcome: 'ok' })
          return true
        }
        // A unit of a stream the ledger has never seen, starting at 2: refused as not_contiguous
        // once serving, so it never writes; before that it meets the start like any flush.
        const res = await r.addUnit(unitFor(this.env.CELL, 99, 99, 5, 8, 2))
        probes.push({ t, op, ms: Date.now() - t, outcome: res.status })
        return false
      } catch (e) {
        const m = String(e)
        probes.push({ t, op, ms: Date.now() - t, outcome: m.includes('ledger_unavailable') ? 'ledger_unavailable' : m.slice(0, 160) })
        return false
      }
    }
    const t0 = Date.now()
    let ready = await probe('plan') // the first request: constructs the object, which starts the rebuild
    let baseSeenAt: number | null = null
    const nextInc = before.incarnation + 1
    while (!ready && Date.now() - t0 < job.maxMs) {
      if (job.probeMs > 0) {
        await new Promise((res) => setTimeout(res, job.probeMs))
        await probe('addUnit')
        ready = await probe('plan')
      } else {
        await new Promise((res) => setTimeout(res, 1000))
        const seen = await this.env.BUCKET.list({ prefix: `${this.env.CELL}/ledger/tenant=${TENANT}/${nextInc}/`, limit: 1 })
        if (seen.objects.length > 0 && baseSeenAt === null) baseSeenAt = Date.now()
        if (baseSeenAt !== null && Date.now() - baseSeenAt >= 2000) ready = await probe('plan')
      }
    }
    const readyMs = Date.now() - t0
    if (!ready) return { error: `not serving after ${job.maxMs} ms`, gen: job.gen, readyMs, probes, before }
    const start = await r.s11Start()
    const after = await fingerprint(r)
    const ops = (await r.s11Ops()) as unknown as Op[]
    const base = (await listAll(this.env.BUCKET, `${this.env.CELL}/ledger/tenant=${TENANT}/${after.incarnation}/`))[0]
    const same = before.version === after.version && before.watermarks === after.watermarks && before.stateBytes === after.stateBytes && JSON.stringify(before.days) === JSON.stringify(after.days)
    return {
      gen: job.gen, probeMs: job.probeMs, triggeredAt: t0, readyMs, baseSeenAfterMs: baseSeenAt === null ? null : baseSeenAt - t0,
      same, before, after, start: start ? { ...start, msInside: start.t1 && start.t0 ? start.t1 - start.t0 : null } : null,
      base: base ? { key: base.key, size: base.size, uploadedAfterMs: base.uploaded - t0 } : null,
      refusals: probes.filter((p) => p.outcome === 'ledger_unavailable').length,
      probes, ops: summarise(ops), opsFirst: ops.length ? ops[0]![0] - t0 : null, opsLast: ops.length ? ops[ops.length - 1]![0] + ops[ops.length - 1]![1] - t0 : null,
      opTimeline: ops.filter((o, i) => i % 25 === 0 || o[2] === 'put' || o[2] === 'list').map((o) => [o[0] - t0, o[1], o[2], o[3], o[4]]),
    }
  }

  /** A first publication of the tenant by a publisher on empty storage, with no Iceberg metadata in R2. */
  private async publish(name: string) {
    const icebergPrefix = `${this.env.CELL}/iceberg/`
    let cleared = 0
    for (let i = 0; i < 50; i++) {
      const page = await this.env.BUCKET.list({ prefix: icebergPrefix, limit: 1000 })
      if (page.objects.length === 0) break
      await this.env.BUCKET.delete(page.objects.map((o) => o.key))
      cleared += page.objects.length
    }
    const p = this.env.PUBLISHER.get(this.env.PUBLISHER.idFromName(name))
    const t0 = Date.now()
    let result: PublishResult | null = null
    let error: string | null = null
    try {
      result = await p.publish([TENANT])
    } catch (e) {
      error = String(e).slice(0, 600)
    }
    const ms = Date.now() - t0
    let ops: Op[] = []
    try {
      ops = (await p.s11Ops()) as unknown as Op[]
    } catch (e) {
      error ??= `ops: ${String(e).slice(0, 200)}`
    }
    const written = await listAll(this.env.BUCKET, icebergPrefix)
    return {
      name, cleared, triggeredAt: t0, ms, error, result,
      ops: summarise(ops), opTimeline: ops.filter((o, i) => i % 25 === 0 || o[2] === 'put').map((o) => [o[0] - t0, o[1], o[2], o[3], o[4]]),
      iceberg: { objects: written.length, bytes: written.reduce((a, o) => a + o.size, 0), lastPutAfterMs: written.length ? Math.max(...written.map((o) => o.uploaded)) - t0 : null },
    }
  }

  /** Delete a replica's incarnation from R2, so that G0's is again the newest. */
  private async drop(incarnation: number) {
    const prefix = `${this.env.CELL}/ledger/tenant=${TENANT}/${incarnation}/`
    const objs = await listAll(this.env.BUCKET, prefix)
    for (let i = 0; i < objs.length; i += 1000) await this.env.BUCKET.delete(objs.slice(i, i + 1000).map((o) => o.key))
    return { prefix, deleted: objs.length }
  }
}

// ───────────────────────────── the Worker ─────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.KEY || req.headers.get('x-key') !== env.KEY) return new Response('not found', { status: 404 })
    const u = new URL(req.url)
    const driver = env.DRIVER.get(env.DRIVER.idFromName('driver'))
    if (u.pathname === '/deadline') return Response.json({ deadline: env.S11_DEADLINE, past: pastDeadline(env) })
    if (u.pathname === '/purge' && req.method === 'POST') {
      // Teardown, allowed after the deadline too: every object under the prefix (default all), 1,000 per page.
      const prefix = u.searchParams.get('prefix') ?? ''
      let deleted = 0
      for (let i = 0; i < 40; i++) {
        const page = await env.BUCKET.list({ prefix, limit: 1000 })
        if (page.objects.length === 0) break
        await env.BUCKET.delete(page.objects.map((o) => o.key))
        deleted += page.objects.length
      }
      const left = (await env.BUCKET.list({ prefix, limit: 1 })).objects.length
      return Response.json({ deleted, empty: left === 0 })
    }
    if (u.pathname === '/list') {
      const objs = await listAll(env.BUCKET, u.searchParams.get('prefix') ?? '')
      return Response.json({ objects: objs.length, bytes: objs.reduce((a, o) => a + o.size, 0), sample: objs.slice(0, 3).map((o) => o.key) })
    }
    if (pastDeadline(env)) return Response.json({ error: 'past the spike deadline' }, { status: 410 })
    if (u.pathname === '/job' && req.method === 'POST') {
      const job = (await req.json()) as Job
      const id = `${Date.now().toString(36)}-${job.op}`
      return Response.json(await driver.start(id, job))
    }
    if (u.pathname === '/result') {
      const o = await env.BUCKET.get(`s11/results/${u.searchParams.get('id')}.json`)
      return o ? new Response(o.body, { headers: { 'content-type': 'application/json' } }) : Response.json({ pending: true }, { status: 202 })
    }
    if (u.pathname === '/status') return Response.json(await ledgerOf(env, (u.searchParams.get('gen') ?? 'G0') as Gen).logStatus())
    if (u.pathname === '/log') return Response.json(await logInR2(env))
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
