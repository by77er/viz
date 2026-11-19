import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { decodeLedgerSegment, parseLedgerLogKey, type FileEntry, type FlushUnit, type LedgerChange, type Plan, type Table } from '../../contracts/ledger'
import type { Ledger } from '../src/ledger'

export type Stub = DurableObjectStub<Ledger>

export const S = 'pool/0'
export const INC = 7001
export const DAY_MS = 86_400_000
export const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10)
export const T0 = Date.UTC(2026, 10, 10)

let n = 0
/** The tenant the last `open` returned: `file` builds keys under its prefix. */
let current = ''
export const tenantName = (label = 'tenant') => `${label}-${Date.now().toString(36)}-${n++}`
export const open = (tenant = tenantName()): { tenant: string; l: Stub } => {
  current = tenant
  return { tenant, l: env.LEDGER.get(env.LEDGER.idFromName(tenant)) }
}

/** The data-file prefix a ledger accepts (contracts/ledger.ts `FileEntry.key`). */
export const prefixOf = (tenant: string, table: Table, day: string) => `${env.CELL}/data/${table}/tenant=${tenant}/day=${day}/`
const registry = new Map<string, string>()

/**
 * A file named `name` of the current tenant (or `tenant`), its key under the prefix the ledger
 * requires. `k(name)` gives the key back; `nm(key)` the name. `file('')` has the empty key.
 */
export const file = (name: string, over: Partial<FileEntry> = {}, tenant = current): FileEntry => {
  const minTs = over.minTs ?? T0
  const table = over.table ?? 'metric_samples'
  const day = over.day ?? dayOf(minTs)
  const key = name === '' ? '' : `${prefixOf(tenant, table, day)}${name}`
  registry.set(`${tenant}\u0000${name}`, key)
  return { table, day, key, bytes: 100, rows: 10, minTs, maxTs: minTs + 999, level: 0, index: `idx:${name}`, ...over }
}
export const k = (name: string, tenant = current): string => {
  const key = registry.get(`${tenant}\u0000${name}`)
  if (key === undefined) throw new Error(`test: no file named ${name} for ${tenant}`)
  return key
}
export const nm = (key: string): string => key.slice(key.lastIndexOf('/') + 1)

export const unit = (seqLo: number, seqHi: number, files: FileEntry[], shard = S, incarnation = INC): FlushUnit => ({ shard, incarnation, seqLo, seqHi, files })
/** A unit with one samples file and one series file, the way a flush produces them. */
export const pair = (seqLo: number, seqHi: number, ts = T0, shard = S, incarnation = INC): FlushUnit =>
  unit(seqLo, seqHi, [
    file(`samples-${shard.replaceAll('/', '_')}-${incarnation}-${seqLo}-${seqHi}`, { minTs: ts }),
    file(`series-${shard.replaceAll('/', '_')}-${incarnation}-${seqLo}-${seqHi}`, { minTs: ts, table: 'metric_series' }),
  ], shard, incarnation)

export const everything = async (l: Stub, table: Table = 'metric_samples') => l.plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })
export const keys = (p: Plan) => p.files.map((f) => nm(f.key))
export const seqOf = async (l: Stub, shard = S) => (await everything(l)).watermarks.find((w) => w.shard === shard)?.seq
export const loggedOf = async (l: Stub, shard = S) => (await l.loggedWatermarks()).find((w) => w.shard === shard)?.seq

export const logPrefix = (tenant: string) => `${env.CELL}/ledger/tenant=${tenant}/`

/** Every key under a prefix, in key order. */
export async function listAll(prefix: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ prefix, cursor })
    for (const o of page.objects) out.push(o.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

export interface SegmentRead {
  key: string
  ledgerIncarnation: number
  first: number
  last: number
  changes: LedgerChange[]
}

/** Every segment of a tenant's log in R2, decoded and checked against its key, in incarnation and key order. */
export async function readSegments(tenant: string): Promise<SegmentRead[]> {
  const out: SegmentRead[] = []
  for (const key of await listAll(logPrefix(tenant))) {
    const p = parseLedgerLogKey(key)
    if (p?.type !== 'segment') continue
    const body = await (await env.BUCKET.get(key))!.text()
    const d = decodeLedgerSegment(body, { ledgerIncarnation: p.ledgerIncarnation, firstVersion: p.firstVersion, lastVersion: p.lastVersion, tenant })
    if (d.status !== 'ok') throw new Error(`${key}: ${d.status}: ${d.reason}`)
    out.push({ key, ledgerIncarnation: p.ledgerIncarnation, first: p.firstVersion, last: p.lastVersion, changes: d.changes })
  }
  return out.sort((a, b) => a.ledgerIncarnation - b.ledgerIncarnation || a.first - b.first)
}

/**
 * Every change (not bases) in R2 for a tenant, in incarnation and version order. With `l`,
 * the ledger drains first (what its alarm would do).
 */
export async function readLog(tenant: string, l?: Stub): Promise<LedgerChange[]> {
  if (l) await l.drain()
  return (await readSegments(tenant)).flatMap((s) => s.changes).filter((c) => c.kind !== 'base')
}

/** Make the ledger's R2 writes fail for keys the predicate selects. Lasts until eviction or `heal`. */
export const breakR2 = (l: Stub, fails: (key: string) => boolean = () => true, mode: 'before' | 'after' = 'before') =>
  runInDurableObject(l, (inst: Ledger) => {
    const real = env.BUCKET
    const broken = new Proxy(real, {
      get(target, prop) {
        if (prop === 'put') {
          return async (key: string, ...rest: unknown[]) => {
            if (fails(key) && mode === 'before') throw new Error('injected R2 failure')
            const r = await (target.put as (...a: unknown[]) => unknown)(key, ...rest)
            // The write happened, but its answer is lost: the caller cannot tell.
            if (fails(key) && mode === 'after') throw new Error('injected: R2 answer lost after the write')
            return r
          }
        }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    ;(inst as unknown as { bucket: R2Bucket }).bucket = broken
  })
export const heal = (l: Stub) => runInDurableObject(l, (inst: Ledger) => { (inst as unknown as { bucket: R2Bucket }).bucket = env.BUCKET })

/**
 * The message a call fails with. Called inside the object: a rejection crossing the RPC
 * boundary is also reported by the test runner as unhandled.
 */
export const failure = <R>(l: Stub, call: (inst: Ledger) => Promise<R>): Promise<string> =>
  runInDurableObject(l, (inst: Ledger) => call(inst).then(() => 'did not fail', (e: Error) => e.message))

/** The object loses its storage and restarts. */
export const loseStorage = async (l: Stub) => {
  await runInDurableObject(l, async (_i, state) => { await state.storage.deleteAll() })
  await evictDurableObject(l)
}

/**
 * Everything the ledger's storage says, except what a new incarnation changes by design
 * (its number, and the log bookkeeping of `meta`): what "the same state" means.
 */
export async function dumpState(l: Stub) {
  // Through the gate first: an object that is still starting answers only once it has.
  await everything(l)
  return runInDurableObject(l, (_i: Ledger, state) => {
    const sql = state.storage.sql
    const rows = (q: string) => sql.exec(q).toArray()
    return {
      version: (sql.exec(`SELECT v FROM meta WHERE k = 'version'`).toArray()[0]?.v as number | undefined) ?? 0,
      files: rows(`SELECT * FROM file ORDER BY key`),
      streams: rows(`SELECT * FROM stream ORDER BY shard`),
      tombstones: rows(`SELECT * FROM tombstone ORDER BY key`),
    }
  })
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
