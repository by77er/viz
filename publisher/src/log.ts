/**
 * Reading a tenant's ledger change log from R2 (layout: ledger/src/ledger.ts, keys:
 * contracts/ledger.ts). The log is the publisher's only input and its whole backlog.
 *
 * Two readers, kept separate on purpose:
 *
 *   readTenantLog   what `publish` uses: the changes after a cursor, in version order, up
 *                   to the first hole.
 *   replayAt        what `verify` uses: the ledger's whole live set at a cursor, rebuilt
 *                   from the incarnation's base with every change checked against the
 *                   state before it.
 */
import { ledgerBaseKey, ledgerLogKey, type FileEntry, type LedgerChange } from '../../contracts/ledger'

export interface Cursor {
  ledgerIncarnation: number
  version: number
}

export const cursorCompare = (a: Cursor, b: Cursor): number => a.ledgerIncarnation - b.ledgerIncarnation || a.version - b.version

/** The parts of R2 the publisher uses. `CountingBucket` implements it. */
export interface Store {
  get(key: string): Promise<R2ObjectBody | null>
  head(key: string): Promise<R2Object | null>
  list(options: R2ListOptions): Promise<R2Objects>
  put(key: string, value: string | Uint8Array, options?: R2PutOptions): Promise<R2Object | null>
  delete(keys: string | string[]): Promise<void>
}

export type LogStatus =
  /** Everything after the cursor was read. */
  | 'ok'
  /** A version is missing; `changes` stops before it and `gapAt` names it. */
  | 'gap'
  /** More changes exist than one publish reads; `changes` is a contiguous prefix. */
  | 'more'
  /** The tenant has no ledger log in R2. */
  | 'no_log'
  /** The newest incarnation has change objects but no `base.json`. */
  | 'no_base'
  /** The cursor names an incarnation newer than anything in R2. */
  | 'cursor_ahead'
  /** An object does not say what its key says, or is not a change. */
  | 'corrupt'

export interface TenantLog {
  tenant: string
  status: LogStatus
  detail?: string
  /** Newest ledger incarnation in R2. */
  incarnation: number
  /** Loaded when the reader started from the base (no cursor, or an older incarnation). */
  base: LedgerChange | null
  /** The version `changes` starts after. */
  start: number
  /** Contiguous: `changes[i].version === start + 1 + i`. */
  changes: LedgerChange[]
  gapAt?: number
}

const CHANGE_OBJECT = /\/(\d{12,})\.json$/
const READ_FANOUT = 6

export async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

const tenantPrefix = (cell: string, tenant: string) => `${cell}/ledger/tenant=${tenant}/`

async function latestIncarnation(store: Store, cell: string, tenant: string): Promise<number | null> {
  const prefix = tenantPrefix(cell, tenant)
  let latest: number | null = null
  let cursor: string | undefined
  do {
    const page = await store.list({ prefix, delimiter: '/', cursor })
    for (const p of page.delimitedPrefixes) {
      const name = p.slice(prefix.length, -1)
      if (/^\d+$/.test(name)) latest = Math.max(latest ?? 0, Number(name))
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return latest
}

async function readBase(store: Store, cell: string, tenant: string, incarnation: number): Promise<LedgerChange | null | 'corrupt'> {
  const o = await store.get(`${cell}/${ledgerBaseKey(tenant, incarnation)}`)
  if (!o) return null
  const base = await o.json<LedgerChange>()
  if (base.kind !== 'base' || base.ledgerIncarnation !== incarnation || !Array.isArray(base.added) || !Number.isSafeInteger(base.version)) return 'corrupt'
  return base
}

/** Versions of an incarnation's change objects that are greater than `after`, ascending. */
async function listVersions(store: Store, cell: string, tenant: string, incarnation: number, after: number): Promise<number[]> {
  const prefix = `${tenantPrefix(cell, tenant)}${incarnation}/`
  const versions: number[] = []
  let cursor: string | undefined
  do {
    // `startAfter` skips what is already published; zero-padded names list in version order.
    const page = await store.list({ prefix, cursor, startAfter: cursor ? undefined : `${cell}/${ledgerLogKey(tenant, incarnation, after)}` })
    for (const o of page.objects) {
      const m = CHANGE_OBJECT.exec(o.key)
      if (m && Number(m[1]) > after) versions.push(Number(m[1]))
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  // Never trust listing order for correctness: sort by number.
  return versions.sort((a, b) => a - b)
}

async function readChange(store: Store, cell: string, tenant: string, incarnation: number, version: number): Promise<LedgerChange | null> {
  const o = await store.get(`${cell}/${ledgerLogKey(tenant, incarnation, version)}`)
  if (!o) return null
  const c = await o.json<LedgerChange>()
  if (c.ledgerIncarnation !== incarnation || c.version !== version || c.kind === 'base' || !Array.isArray(c.added) || !Array.isArray(c.removed)) return null
  return c
}

/**
 * The changes a tenant's ledger logged after `from`, in version order.
 *
 * With no cursor, or a cursor from an older incarnation, the reader starts again from the
 * newest incarnation's `base` (the contract's rule for a new incarnation). A hole in the
 * versions ends the result there: nothing after a hole is ever returned.
 */
export async function readTenantLog(store: Store, cell: string, tenant: string, from: Cursor | null, maxChanges: number): Promise<TenantLog> {
  const none = (status: LogStatus, incarnation: number, detail?: string): TenantLog => ({ tenant, status, detail, incarnation, base: null, start: 0, changes: [] })
  const incarnation = await latestIncarnation(store, cell, tenant)
  if (incarnation === null) return none('no_log', 0)
  if (from && from.ledgerIncarnation > incarnation) {
    return none('cursor_ahead', incarnation, `cursor is at incarnation ${from.ledgerIncarnation}, R2 has ${incarnation}`)
  }
  let base: LedgerChange | null = null
  let start: number
  if (!from || from.ledgerIncarnation < incarnation) {
    const b = await readBase(store, cell, tenant, incarnation)
    if (b === null) return none('no_base', incarnation, `incarnation ${incarnation} has no base.json`)
    if (b === 'corrupt') return none('corrupt', incarnation, `base.json of incarnation ${incarnation} is not a base change`)
    base = b
    start = b.version
  } else {
    start = from.version
  }

  const listed = await listVersions(store, cell, tenant, incarnation, start)
  // The contiguous run start+1, start+2, ... A hole ends it.
  let run = 0
  while (run < listed.length && listed[run] === start + 1 + run) run++
  let status: LogStatus = run < listed.length ? 'gap' : 'ok'
  let gapAt = run < listed.length ? start + 1 + run : undefined
  if (run > maxChanges) {
    run = maxChanges
    status = 'more'
    gapAt = undefined
  }
  const wanted = listed.slice(0, run)
  const read = await inBatches(wanted, READ_FANOUT, (v) => readChange(store, cell, tenant, incarnation, v))
  const changes: LedgerChange[] = []
  for (const [i, c] of read.entries()) {
    if (!c) {
      // Listed a moment ago, unreadable or wrong now: stop before it, as for a hole.
      return { tenant, status: 'corrupt', detail: `change ${wanted[i]} of incarnation ${incarnation} is missing or not what its key says`, incarnation, base, start, changes }
    }
    changes.push(c)
  }
  const log: TenantLog = { tenant, status, incarnation, base, start, changes }
  if (gapAt !== undefined) {
    log.gapAt = gapAt
    log.detail = `version ${gapAt} of incarnation ${incarnation} is missing; ${listed[listed.length - 1]} exists`
  }
  return log
}

/** Tenants that have a ledger log under the cell. */
export async function listTenants(store: Store, cell: string): Promise<string[]> {
  const prefix = `${cell}/ledger/`
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await store.list({ prefix, delimiter: '/', cursor })
    for (const p of page.delimitedPrefixes) {
      const name = p.slice(prefix.length, -1)
      if (name.startsWith('tenant=')) out.push(name.slice('tenant='.length))
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

/**
 * The ledger's live set at `cursor`, rebuilt from R2: the incarnation's base, then every
 * change up to the cursor, each checked against the state before it. Throws with the
 * reason if the log cannot produce that state.
 */
export async function replayAt(store: Store, cell: string, tenant: string, cursor: Cursor): Promise<Map<string, FileEntry>> {
  const inc = cursor.ledgerIncarnation
  const base = await readBase(store, cell, tenant, inc)
  if (base === null || base === 'corrupt') throw new Error(`incarnation ${inc} of ${tenant} has no usable base.json`)
  if (cursor.version < base.version) throw new Error(`cursor version ${cursor.version} of ${tenant} is before the base of incarnation ${inc} (${base.version})`)
  const files = new Map<string, FileEntry>()
  for (const f of base.added) files.set(f.key, f)
  const versions: number[] = []
  for (let v = base.version + 1; v <= cursor.version; v++) versions.push(v)
  const changes = await inBatches(versions, READ_FANOUT, (v) => readChange(store, cell, tenant, inc, v))
  for (const [i, c] of changes.entries()) {
    if (!c) throw new Error(`change ${versions[i]} of incarnation ${inc} of ${tenant} is missing from the log`)
    for (const k of c.removed) {
      if (!files.delete(k)) throw new Error(`change ${c.version} of ${tenant} removes ${k}, which is not live`)
    }
    for (const f of c.added) {
      if (files.has(f.key)) throw new Error(`change ${c.version} of ${tenant} adds ${f.key}, which is already live`)
      files.set(f.key, f)
    }
  }
  return files
}
