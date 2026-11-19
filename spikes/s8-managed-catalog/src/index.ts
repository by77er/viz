/**
 * Spike S8, second half: commits to the managed Iceberg REST catalog (Basin Catalog) from
 * Durable Objects, under conflicts and unknown outcomes. See README.md.
 *
 * Every endpoint needs the `x-key` header (a Worker secret). Each committer is its own Durable
 * Object (AGENTS.md: a load client inside Cloudflare is a Durable Object). Nothing runs on a
 * timer and every endpoint bounds its own work.
 */
import { DurableObject } from 'cloudflare:workers'
import type { FileEntry, Table } from '../../../contracts/ledger'
import { emptyMetadata } from '../../../publisher/src/iceberg'
import { R2NativeCatalog, RestCatalog, currentId, keyOfUri, type IcebergCatalog } from './catalog'
import { appendPlan, chainOf, checkIds, commitWithRetry, newSnapshotId, replacePlan, verifyTable, type CommitResult, type Ctx, type Publish } from './commit'

export interface Env {
  BUCKET: R2Bucket
  COMMITTER: DurableObjectNamespace<Committer>
  /** Secrets. */
  KEY: string
  CATALOG_TOKEN: string
  /** Vars. */
  CATALOG_URI: string
  WAREHOUSE: string
  BUCKET_NAME: string
}

type Which = 'rest' | 'r2-native'

interface Target {
  catalog: Which
  ns: string
  name: string
  table: Table
}

const LIMITS = { committers: 16, commits: 20, latency: 50, trials: 40, probe: 50 }

function catalogFor(env: Env, which: Which, table?: Table, fetcher?: (i: string, r?: RequestInit) => Promise<Response>): IcebergCatalog {
  if (which === 'r2-native') return new R2NativeCatalog(env.BUCKET, env.BUCKET_NAME, 'r2native', table ? emptyMetadata(table, 's3://placeholder', 'cell-0', crypto.randomUUID(), Date.now()) : null)
  return new RestCatalog({ uri: env.CATALOG_URI, warehouse: env.WAREHOUSE, token: env.CATALOG_TOKEN, bucket: env.BUCKET_NAME, ...(fetcher ? { fetch: fetcher } : {}) })
}

export function ctxFor(env: Env, t: Target, cat?: IcebergCatalog): Ctx {
  return { cat: cat ?? catalogFor(env, t.catalog, t.table), bucket: env.BUCKET, keyOf: (u) => keyOfUri(u, env.BUCKET_NAME), ns: t.ns, name: t.name, table: t.table }
}

const slim = (r: CommitResult) => ({ ...r, table: undefined })

const quantiles = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => (s.length ? (s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] as number) : null)
  return { n: s.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s.length ? s[s.length - 1] : null }
}

/** `n` copies of a data object already in the bucket, under keys of their own (one tenant per committer). */
async function copies(env: Env, template: Publish, tenant: string, tag: string, n: number): Promise<Publish[]> {
  const src = await env.BUCKET.get(template.entry.key)
  if (!src) throw new Error(`template ${template.entry.key} is not in the bucket`)
  const bytes = new Uint8Array(await src.arrayBuffer())
  const out: Publish[] = []
  for (let j = 0; j < n; j++) {
    const key = `bench/${template.entry.table}/tenant=${tenant}/day=${template.entry.day}/${tag}-${j}.parquet`
    out.push({ tenant, entry: { ...template.entry, key } as FileEntry })
  }
  for (let i = 0; i < out.length; i += 6) await Promise.all(out.slice(i, i + 6).map((p) => env.BUCKET.put(p.entry.key, bytes)))
  return out
}

type JobKind = 'contend' | 'latency' | 'unknown'
interface Job {
  kind: JobKind
  args: unknown
  state: 'pending' | 'running' | 'done' | 'failed'
  deadline: number
  error?: string
}

export class Committer extends DurableObject<Env> {
  /**
   * Long exercises run as a job: started by a request, run once by a one-shot alarm, polled for.
   * A start that is repeated (an HTTP client or proxy retrying the POST) finds the job and does
   * nothing, so no exercise runs twice; an alarm retried after a crash finds it `running` and
   * marks it failed instead of running it again. The alarm is never re-armed, and a job not
   * begun by its deadline is not run.
   */
  async startJob(kind: JobKind, args: unknown): Promise<{ state: Job['state']; started: boolean }> {
    const cur = await this.ctx.storage.get<Job>('job')
    if (cur) return { state: cur.state, started: false }
    await this.ctx.storage.put<Job>('job', { kind, args, state: 'pending', deadline: Date.now() + 15 * 60_000 })
    await this.ctx.storage.setAlarm(Date.now())
    return { state: 'pending', started: true }
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<Job>('job')
    if (!job || job.state !== 'pending') {
      if (job?.state === 'running') await this.ctx.storage.put<Job>('job', { ...job, state: 'failed', error: 'interrupted: the alarm ran again while the job was running; not run twice' })
      return
    }
    if (Date.now() > job.deadline) {
      await this.ctx.storage.put<Job>('job', { ...job, state: 'failed', error: 'deadline passed before the job began' })
      return
    }
    await this.ctx.storage.put<Job>('job', { ...job, state: 'running' })
    try {
      const fn = { contend: this.contend, latency: this.latency, unknown: this.unknown }[job.kind] as (a: unknown) => Promise<unknown>
      const result = await fn.call(this, job.args)
      await this.ctx.storage.put('result', result)
      await this.ctx.storage.put<Job>('job', { ...job, state: 'done' })
    } catch (e) {
      await this.ctx.storage.put<Job>('job', { ...job, state: 'failed', error: String(e).slice(0, 1000) })
    }
  }

  async jobResult(): Promise<{ state: Job['state'] | 'none'; error?: string; result?: unknown }> {
    const job = await this.ctx.storage.get<Job>('job')
    if (!job) return { state: 'none' }
    const out: { state: Job['state']; error?: string; result?: unknown } = { state: job.state }
    if (job.error) out.error = job.error
    if (job.state === 'done') out.result = await this.ctx.storage.get('result')
    return out
  }

  /** `GET /v1/config` n times: reachability and front-door latency of the catalog from here. */
  async probe(n: number) {
    const cat = new RestCatalog({ uri: this.env.CATALOG_URI, warehouse: this.env.WAREHOUSE, token: this.env.CATALOG_TOKEN, bucket: this.env.BUCKET_NAME })
    const out: { status: number; ms: number; body?: unknown }[] = []
    for (let i = 0; i < Math.min(n, LIMITS.probe); i++) {
      const r = await cat.config()
      out.push(i === 0 ? r : { status: r.status, ms: r.ms })
    }
    return { statuses: out.map((o) => o.status), ms: quantiles(out.map((o) => o.ms)), first: out[0] }
  }

  async setup(t: Target) {
    const cat = catalogFor(this.env, t.catalog, t.table)
    const config = cat instanceof RestCatalog ? await cat.config() : null
    const init = emptyMetadata(t.table, 's3://placeholder', 'cell-0', crypto.randomUUID(), Date.now())
    const loaded = await cat.create(t.ns, t.name, init)
    const m = loaded.metadata
    return {
      config,
      location: m.location,
      metadataLocation: loaded.metadataLocation,
      formatVersion: m['format-version'],
      idProblem: t.catalog === 'rest' ? checkIds(t.table, m) : null,
      schema: m.schemas,
      spec: m['partition-specs'],
      sortOrders: m['sort-orders'],
      defaultSortOrderId: m['default-sort-order-id'],
      properties: m.properties,
      calls: cat.calls,
    }
  }

  /** One stage of the publisher's end-to-end scenario: make the table's live set equal `files`. */
  async publish(t: Target & { stage: string; files: Publish[] }) {
    const c = ctxFor(this.env, t)
    const id = newSnapshotId()
    const r = await commitWithRetry(c, id, replacePlan(c, t.files, id, { 'viz.stage': t.stage, 'viz.tenants': String(new Set(t.files.map((f) => f.tenant)).size) }))
    const v = await verifyTable(c)
    const want = t.files.map((f) => f.entry.key).sort()
    const equal = JSON.stringify(v.files) === JSON.stringify(want)
    return { result: slim(r), liveEqualsStage: equal, live: v.files.length, rows: v.rows, chain: v.chain, problems: v.problems, snapshotId: currentId(r.table?.metadata ?? (await c.cat.load(t.ns, t.name))!.metadata), calls: c.cat.calls }
  }

  /** One committer of the contention exercise: `commits` appends as fast as it can from `startAt`. */
  async contend(t: Target & { index: number; commits: number; startAt: number; template: Publish; run: string }) {
    const c = ctxFor(this.env, t)
    const files = await copies(this.env, t.template, `c${t.index}`, `${t.run}-c${t.index}`, Math.min(t.commits, LIMITS.commits))
    const wait = t.startAt - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const results: ReturnType<typeof slim>[] = []
    const firstAt = Date.now()
    for (const f of files) {
      const id = newSnapshotId()
      results.push(slim(await commitWithRetry(c, id, appendPlan(c, [f], id, { 'viz.committer': `c${t.index}` }))))
    }
    return { index: t.index, startedLateMs: Math.max(0, -wait), firstAt, lastAt: Date.now(), results, calls: c.cat.calls.length }
  }

  /** Uncontended appends one after another: the latency of a publish and of its parts. */
  async latency(t: Target & { n: number; template: Publish; run: string }) {
    const c = ctxFor(this.env, t)
    const files = await copies(this.env, t.template, 'lat', t.run, Math.min(t.n, LIMITS.latency))
    const results: ReturnType<typeof slim>[] = []
    for (const f of files) {
      const id = newSnapshotId()
      results.push(slim(await commitWithRetry(c, id, appendPlan(c, [f], id, { 'viz.run': t.run }))))
    }
    const first = results.map((r) => r.attempts[0]).filter((a) => a !== undefined)
    return {
      n: results.length,
      commit: quantiles(first.map((a) => a.ms)),
      load: quantiles(first.map((a) => a.loadMs)),
      build: quantiles(first.map((a) => a.buildMs)),
      total: quantiles(results.map((r) => r.ms)),
      notFirstTime: results.filter((r) => r.attempts.length !== 1 || r.status !== 'committed').length,
      ids: results.filter((r) => r.status === 'committed' || r.status === 'landed').map((r) => r.snapshotId),
      raw: results.map((r) => r.attempts.map((a) => [a.kind, a.status, a.loadMs, a.buildMs, a.ms])),
    }
  }

  /**
   * Commits whose first response is lost: the request is aborted `delay` ms after it starts.
   * With `interfere`, a second writer commits on the same parent right after the loss, which a
   * late copy of the first request must then be fenced by.
   */
  async unknown(t: Target & { trials: number; delays: number[]; interfere: boolean; template: Publish; run: string; settleMs: number }) {
    const c = ctxFor(this.env, t)
    const n = Math.min(t.trials, LIMITS.trials)
    const files = await copies(this.env, t.template, 'unk', t.run, n * (t.interfere ? 2 : 1))
    const trials: unknown[] = []
    const intended: number[] = []
    for (let i = 0; i < n; i++) {
      const id = newSnapshotId()
      const delay = t.delays[i % t.delays.length] as number
      let interferer: { outcome: string; id: number; status?: number } | null = null
      const afterUnknown = async (parent: number | null) => {
        if (!t.interfere || interferer) return
        const other = newSnapshotId()
        const now = await c.cat.load(t.ns, t.name)
        if (!now) throw new Error('table vanished')
        if (currentId(now.metadata) !== parent) {
          interferer = { outcome: 'not sent: main had already moved (the lost commit landed first)', id: other }
          return
        }
        const body = await appendPlan(c, [files[n + i] as Publish], other, { 'viz.interferer': String(i) })(now)
        const out = await c.cat.commit(t.ns, t.name, { base: now, snapshot: body.snapshot })
        interferer = { outcome: out.kind, id: other, status: out.status }
        if (out.kind === 'committed') intended.push(other)
      }
      const r = await commitWithRetry(c, id, appendPlan(c, [files[i] as Publish], id, { 'viz.trial': String(i) }), { abortFirstAfterMs: delay, afterUnknown })
      if (r.status === 'committed' || r.status === 'landed') intended.push(id)
      trials.push({ trial: i, delay, status: r.status, landedLate: r.landedLate, attempts: r.attempts.map((a) => [a.kind, a.status, a.ms]), interferer })
    }
    // A request that is still somewhere would show up now as a duplicate or a fork.
    await new Promise((r) => setTimeout(r, Math.min(t.settleMs, 30_000)))
    const v = await verifyTable(c, intended)
    return { trials, intended: intended.length, verify: { ok: v.ok, problems: v.problems, chain: v.chain.length, files: v.files.length, rows: v.rows }, calls: c.cat.calls.length }
  }

  async verify(t: Target & { intended?: number[] }) {
    return verifyTable(ctxFor(this.env, t), t.intended)
  }

  /** The publisher's expiry: an append that also drops every snapshot but the newest `keep`. */
  async expire(t: Target & { keep: number; template: Publish; run: string }) {
    const c = ctxFor(this.env, t)
    const [f] = await copies(this.env, t.template, 'exp', t.run, 1)
    const id = newSnapshotId()
    const plan = appendPlan(c, [f as Publish], id, { 'viz.run': t.run })
    const r = await commitWithRetry(c, id, async (tl) => {
      const body = await plan(tl)
      // The new snapshot and the newest `keep - 1` of the current chain survive.
      const chain = chainOf(tl.metadata).chain
      return { ...body, expire: chain.slice(Math.max(0, t.keep - 1)) }
    })
    const v = await verifyTable(c)
    const after = await c.cat.load(t.ns, t.name)
    return { result: slim(r), snapshotsAfter: after?.metadata.snapshots.length, chain: v.chain.length, problems: v.problems }
  }

  /**
   * Two probes of what the catalog itself does about a repeated commit:
   *  (a) the same request sent twice with the same Idempotency-Key (honoured: the second gets
   *      the first's 200 replayed; not honoured: 409, since main has moved);
   *  (b) the snapshot that is already current, added again with a requirement that holds
   *      (a correct catalog refuses a duplicate snapshot id).
   */
  async idempotency(t: Target & { template: Publish; run: string }) {
    const c = ctxFor(this.env, t)
    const [f] = await copies(this.env, t.template, 'idem', t.run, 1)
    const base = await c.cat.load(t.ns, t.name)
    if (!base) throw new Error('no table')
    const id = newSnapshotId()
    const body = await appendPlan(c, [f as Publish], id, { 'viz.run': t.run })(base)
    const key = crypto.randomUUID()
    const first = await c.cat.commit(t.ns, t.name, { base, snapshot: body.snapshot, idempotencyKey: key })
    const second = await c.cat.commit(t.ns, t.name, { base, snapshot: body.snapshot, idempotencyKey: key })
    const now = await c.cat.load(t.ns, t.name)
    const dup = now ? await c.cat.commit(t.ns, t.name, { base: now, snapshot: body.snapshot }) : null
    const v = await verifyTable(c)
    const pick = (o: Awaited<ReturnType<IcebergCatalog['commit']>> | null) => (o ? { kind: o.kind, status: o.status, detail: 'detail' in o ? o.detail : undefined } : null)
    return { first: pick(first), sameKeyAgain: pick(second), duplicateSnapshotId: pick(dup), chainProblems: v.problems }
  }

  async drop(t: { ns: string; names: string[]; purge: boolean }) {
    const cat = catalogFor(this.env, 'rest') as RestCatalog
    const out: Record<string, number> = {}
    for (const n of t.names) out[n] = await cat.drop(t.ns, n, t.purge)
    out['namespace'] = await cat.dropNamespace(t.ns)
    return out
  }
}

async function wipe(env: Env, prefix: string) {
  let deleted = 0
  for (;;) {
    const l = await env.BUCKET.list({ prefix, limit: 1000 })
    if (l.objects.length === 0) return deleted
    await env.BUCKET.delete(l.objects.map((o) => o.key))
    deleted += l.objects.length
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.KEY || req.headers.get('x-key') !== env.KEY) return new Response('forbidden', { status: 403 })
    const url = new URL(req.url)
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })
    try {
      if (req.method === 'PUT' && url.pathname === '/object') {
        const key = url.searchParams.get('key') ?? ''
        if (!/^(cell-0|bench)\//.test(key)) return new Response('key outside the spike prefixes', { status: 400 })
        await env.BUCKET.put(key, await req.arrayBuffer())
        return json({ key })
      }
      if (req.method === 'GET' && url.pathname === '/colo') return json({ colo: (req as unknown as { cf?: { colo?: string } }).cf?.colo })
      if (req.method !== 'POST') return new Response('not found', { status: 404 })
      const args = (await req.json()) as Record<string, unknown> & Target
      const stub = (name: string) => env.COMMITTER.get(env.COMMITTER.idFromName(name))
      switch (url.pathname) {
        case '/probe':
          return json(await stub('probe').probe(Number(args.n ?? 10)))
        case '/setup':
          return json(await stub('setup').setup(args))
        case '/publish':
          return json(await stub(`publisher-${args.ns}`).publish(args as unknown as Parameters<Committer['publish']>[0]))
        // The long exercises are jobs (Committer.startJob): a POST starts them, idempotently, and
        // the driver polls `/result`. A retried POST never runs an exercise twice.
        case '/contend': {
          const n = Math.min(Number(args.committers), LIMITS.committers)
          const startAt = Date.now() + 5_000
          const run = String(args.run)
          const names = Array.from({ length: n }, (_, index) => `contend-${run}-${index}`)
          const started = await Promise.all(names.map((nm, index) => stub(nm).startJob('contend', { ...args, index, startAt, run })))
          return json({ names, started })
        }
        case '/latency': {
          const nm = `latency-${args.catalog}-${args.run}`
          return json({ names: [nm], started: [await stub(nm).startJob('latency', args)] })
        }
        case '/unknown': {
          const nm = `unknown-${args.run}`
          return json({ names: [nm], started: [await stub(nm).startJob('unknown', args)] })
        }
        case '/result':
          return json(await Promise.all((args.names as unknown as string[]).map((nm) => stub(nm).jobResult())))
        case '/contend-summary': {
          type Part = Awaited<ReturnType<Committer['contend']>>
          const res = (await Promise.all((args.names as unknown as string[]).map((nm) => stub(nm).jobResult()))) as unknown as { state: string; error?: string; result?: unknown }[]
          const failed = res.filter((r) => r.state !== 'done')
          if (failed.length > 0) return json({ error: `jobs not done: ${JSON.stringify(failed.map((f) => [f.state, f.error]))}` })
          const parts = res.map((r) => r.result as Part)
          const all = parts.flatMap((p) => p.results)
          const ids = all.filter((r) => r.status === 'committed' || r.status === 'landed').map((r) => r.snapshotId)
          const verify = await stub('verifier').verify({ ...args, intended: [...((args.baseline as unknown as number[]) ?? []), ...ids] })
          const firstStart = Math.min(...parts.map((p) => p.firstAt)), lastEnd = Math.max(...parts.map((p) => p.lastAt))
          return json({
            committers: parts.length,
            commits: all.length,
            succeeded: ids.length,
            gaveUp: all.filter((r) => r.status === 'gave-up').length,
            rejected: all.filter((r) => r.status === 'rejected').length,
            conflicts: all.reduce((a, r) => a + r.conflicts, 0),
            unknowns: all.reduce((a, r) => a + r.unknowns, 0),
            attemptsPerCommit: quantiles(all.map((r) => r.attempts.length)),
            msToSuccess: quantiles(all.map((r) => r.ms)),
            commitRequestMs: quantiles(all.flatMap((r) => r.attempts.map((a) => a.ms))),
            statuses: all.flatMap((r) => r.attempts.map((a) => a.status)).reduce<Record<string, number>>((m, st) => ((m[st] = (m[st] ?? 0) + 1), m), {}),
            // What an attempt with an unknown outcome or a refusal said, by message.
            details: all.flatMap((r) => r.attempts.filter((a) => a.kind === 'unknown' || a.kind === 'rejected').map((a) => `${a.kind} ${a.status}: ${(a.detail ?? '').slice(0, 160)}`)).reduce<Record<string, number>>((m, d) => ((m[d] = (m[d] ?? 0) + 1), m), {}),
            names: args.names,
            wallMs: lastEnd - firstStart,
            commitsPerSecond: +(ids.length / ((lastEnd - firstStart) / 1000)).toFixed(2),
            startedLateMs: parts.map((p) => p.startedLateMs),
            verify: { ok: verify.ok, problems: verify.problems.slice(0, 20), problemCount: verify.problems.length, chain: verify.chain.length, files: verify.files.length, rows: verify.rows },
          })
        }
        case '/verify':
          return json(await stub('verifier').verify(args))
        case '/expire':
          return json(await stub('expire').expire(args as unknown as Parameters<Committer['expire']>[0]))
        case '/idempotency':
          return json(await stub('idempotency').idempotency(args as unknown as Parameters<Committer['idempotency']>[0]))
        case '/drop':
          return json(await stub('drop').drop(args as unknown as Parameters<Committer['drop']>[0]))
        case '/wipe':
          return json({ deleted: await wipe(env, String(args.prefix ?? '')) })
        default:
          return new Response('not found', { status: 404 })
      }
    } catch (e) {
      return json({ error: String(e), stack: (e as Error).stack?.split('\n').slice(0, 5) })
    }
  },
} satisfies ExportedHandler<Env>
