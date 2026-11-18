/**
 * Versioned SQLite storage for Durable Objects: the shared migration runner.
 *
 * The rules this implements are in `contracts/COMPATIBILITY.md` §2. In short:
 *
 *   - Every Durable Object class keeps one row in `viz_schema`: which component owns the
 *     storage, the highest migration applied (`version`), and the lowest schema version a
 *     release must KNOW to open it (`compat`).
 *   - `openSchema` runs in the constructor inside `blockConcurrencyWhile`. It applies the
 *     missing migrations in ONE `transactionSync` (all or nothing), then records the new
 *     version in the same transaction. Local SQLite only: no R2, no network, no await.
 *   - Storage newer than this code, whose `compat` is also above what this code knows, is
 *     refused: `openSchema` returns `schema_too_new` and writes nothing. The object then
 *     answers every request with that status (or 503 over HTTP) and re-arms its alarm.
 *   - Storage newer than this code whose `compat` this code meets is opened as it is, and
 *     is NOT changed: `version` is never lowered.
 *
 * This file has no platform types and no I/O, so every component can import it, as
 * components import the rest of `contracts/` (design/DECISIONS.md D23).
 */

/** The part of `SqlStorage` the runner uses. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] }
}

/** The part of `DurableObjectStorage` the runner uses. */
export interface StorageLike {
  sql: SqlLike
  transactionSync<T>(fn: () => T): T
}

export interface Migration {
  /** 1, 2, 3, … in order, without gaps. Version 1 is the schema as it stood when versioning began. */
  version: number
  /** One line: what it changes. */
  name: string
  /**
   * The lowest schema version a release must know to open storage this migration has been
   * applied to. `version` itself when an older release would misread or break the new
   * storage: the release that adds the migration is then FORWARD-ONLY for this component.
   * Lower when the change is purely additive (COMPATIBILITY.md §2.3) and the previous release
   * may keep reading and writing it; that release stays a valid rollback target.
   */
  readableFrom: number
  /** Synchronous, local SQLite only. Runs inside the runner's transaction; must not catch its own errors. */
  up(sql: SqlLike): void
}

export interface SchemaSpec {
  /** Who owns the storage, as `<component>.<Class>`, e.g. `control.Tenant`. Checked on every open. */
  component: string
  /** Names this storage was recorded under before a class rename. */
  formerly?: readonly string[]
  migrations: readonly Migration[]
}

/** What a release declares per Durable Object class, for release records and the rollback check. */
export interface SchemaRelease {
  component: string
  /** Highest schema version this code knows (= the version it migrates storage to). */
  latest: number
  /** The `compat` that storage has after this code has opened it: the lowest `latest` that can still open it. */
  compat: number
}

export interface SchemaOk {
  status: 'ok'
  component: string
  /** Version recorded in storage after opening. Above `known` when a newer, compatible release wrote it. */
  version: number
  compat: number
  /** Highest version this code knows. */
  known: number
  /** Migrations applied by this open, in order. Empty when storage was already current (or newer). */
  migrated: number[]
  /** The storage had tables but no version row: it was made by code from before versioning. */
  adopted: boolean
}

/** The storage is newer than this code may open. Nothing was written. Retry later: a newer release owns this object. */
export interface SchemaTooNew {
  status: 'schema_too_new'
  component: string
  /** Version found in storage. */
  found: number
  /** Lowest known version that may open it. */
  compat: number
  /** Highest version this code knows. */
  known: number
  retryAfterMs: number
}

export type SchemaState = SchemaOk | SchemaTooNew

export const SCHEMA_TABLE = 'viz_schema'

/** How long a refused caller waits. Long enough for a deferred code update (COMPATIBILITY.md §1) to land. */
export const SCHEMA_RETRY_AFTER_MS = 30_000

/** A mistake that no retry fixes: a malformed spec, a foreign or corrupt version row. Thrown, never returned. */
export class SchemaError extends Error {
  override name = 'SchemaError'
}

/**
 * The refusal, for surfaces whose result is not a status union (COMPATIBILITY.md §2.4).
 * The message starts with `schema_too_new`, so a caller on the far side of an RPC boundary,
 * where only the message is reliable, can recognise it.
 */
export class SchemaTooNewError extends Error {
  override name = 'SchemaTooNew'
  readonly retryable = true
  constructor(readonly refusal: SchemaTooNew) {
    super(`schema_too_new: ${refusal.component} storage is at version ${refusal.found} (readable from ${refusal.compat}); this code knows up to ${refusal.known}. Retry in ${Math.ceil(refusal.retryAfterMs / 1000)} s.`)
  }
}

const isVersion = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1

/** Throws `SchemaError` unless the migrations are 1..n in order with sane `readableFrom`. */
export function checkSpec(spec: SchemaSpec): void {
  if (typeof spec.component !== 'string' || !/^[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9]*$/.test(spec.component)) {
    throw new SchemaError(`schema: component must look like "control.Tenant", got ${JSON.stringify(spec.component)}`)
  }
  if (spec.migrations.length === 0) throw new SchemaError(`schema ${spec.component}: no migrations`)
  spec.migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new SchemaError(`schema ${spec.component}: migration ${i} has version ${m.version}, expected ${i + 1}`)
    if (!isVersion(m.readableFrom) || m.readableFrom > m.version) {
      throw new SchemaError(`schema ${spec.component}: migration ${m.version} has readableFrom ${m.readableFrom}; it must be 1..${m.version}`)
    }
    if (typeof m.name !== 'string' || m.name === '') throw new SchemaError(`schema ${spec.component}: migration ${m.version} has no name`)
  })
}

/** What this code declares for its release record. */
export function schemaRelease(spec: SchemaSpec): SchemaRelease {
  checkSpec(spec)
  return { component: spec.component, latest: spec.migrations.length, compat: Math.max(...spec.migrations.map((m) => m.readableFrom)) }
}

/**
 * May code that knows versions up to `known` open storage recorded as `stored`? This is the
 * whole rule, used by `openSchema` and by the deploy tool's rollback check: a rollback to a
 * release whose `latest` is L is safe for this component iff `canOpen(L, newest release's
 * {latest, compat})` holds for the newest release that ever ran since the floor.
 */
export function canOpen(known: number, stored: { version: number; compat: number }): boolean {
  return stored.version <= known || stored.compat <= known
}

interface Row {
  component: string
  version: number
  compat: number
}

function readRow(sql: SqlLike): Row | null {
  const exists = sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${SCHEMA_TABLE}'`).toArray().length > 0
  if (!exists) return null
  const rows = sql.exec(`SELECT component, version, compat FROM ${SCHEMA_TABLE} WHERE one = 1`).toArray()
  if (rows.length === 0) return null
  const r = rows[0]!
  if (typeof r.component !== 'string' || !isVersion(r.version) || !isVersion(r.compat) || r.compat > r.version) {
    throw new SchemaError(`schema: the ${SCHEMA_TABLE} row is corrupt: ${JSON.stringify(r)}`)
  }
  return { component: r.component, version: r.version, compat: r.compat }
}

/** Any table of the component's own (not SQLite's, not Cloudflare's, not the version table). */
function hasTables(sql: SqlLike): boolean {
  return (
    sql
      .exec(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name <> '${SCHEMA_TABLE}'
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' LIMIT 1`,
      )
      .toArray().length > 0
  )
}

/**
 * Open (and if need be migrate) this object's storage. Call it in the constructor, inside
 * `ctx.blockConcurrencyWhile`, before anything else touches SQLite:
 *
 *     ctx.blockConcurrencyWhile(async () => { this.schema = openSchema(ctx.storage, SCHEMA) })
 *
 * Returns `schema_too_new` (having written nothing) when the storage is newer than this code
 * may open. Throws `SchemaError` for a spec or row that no retry can fix, and rethrows a
 * migration's error after its transaction has rolled back; either way, thrown inside
 * `blockConcurrencyWhile`, the object is reset and the next request tries again.
 */
export function openSchema(storage: StorageLike, spec: SchemaSpec, now: number = Date.now()): SchemaState {
  checkSpec(spec)
  const sql = storage.sql
  const known = spec.migrations.length
  const row = readRow(sql)
  if (row && row.component !== spec.component && !(spec.formerly ?? []).includes(row.component)) {
    throw new SchemaError(`schema: this storage belongs to ${row.component}, not ${spec.component} (a binding points at the wrong class)`)
  }
  if (row && row.version > known) {
    if (row.compat > known) {
      return { status: 'schema_too_new', component: spec.component, found: row.version, compat: row.compat, known, retryAfterMs: SCHEMA_RETRY_AFTER_MS }
    }
    // Newer, but declared readable by this code: open it as it is. Never lower the version.
    return { status: 'ok', component: spec.component, version: row.version, compat: row.compat, known, migrated: [], adopted: false }
  }
  if (row && row.version === known && row.component === spec.component) {
    return { status: 'ok', component: spec.component, version: known, compat: row.compat, known, migrated: [], adopted: false }
  }

  const from = row?.version ?? 0
  const adopted = row === null && hasTables(sql)
  const pending = spec.migrations.slice(from)
  const compat = Math.max(row?.compat ?? 1, ...pending.map((m) => m.readableFrom))
  storage.transactionSync(() => {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (one INTEGER PRIMARY KEY CHECK (one = 1), component TEXT NOT NULL,
         version INTEGER NOT NULL, compat INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    )
    for (const m of pending) m.up(sql)
    sql.exec(
      `INSERT INTO ${SCHEMA_TABLE} (one, component, version, compat, updated_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (one) DO UPDATE SET component = excluded.component, version = excluded.version, compat = excluded.compat, updated_at = excluded.updated_at`,
      spec.component,
      known,
      compat,
      now,
    )
  })
  return { status: 'ok', component: spec.component, version: known, compat, known, migrated: pending.map((m) => m.version), adopted }
}

/** The refusal in `state`, or null when the object may serve. */
export const refusalOf = (state: SchemaState): SchemaTooNew | null => (state.status === 'schema_too_new' ? state : null)

/**
 * For migration 1 and later additive steps: the columns a table has (`PRAGMA table_info`,
 * which Durable Object SQLite allows; `PRAGMA user_version` it does not). Use it to make a
 * step idempotent over storage made by code from before versioning.
 */
export function columnsOf(sql: SqlLike, table: string): Set<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new SchemaError(`schema: bad table name ${table}`)
  return new Set(sql.exec(`PRAGMA table_info(${table})`).toArray().map((r) => r.name as string))
}

/** A whole schema as text, for golden tests: every table, index and trigger's SQL, in name order. */
export function describeSchema(sql: SqlLike): { type: string; name: string; sql: string }[] {
  return sql
    .exec(
      `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
         ORDER BY type, name`,
    )
    .toArray()
    .map((r) => ({ type: r.type as string, name: r.name as string, sql: (r.sql as string).replace(/\s+/g, ' ').trim() }))
}
