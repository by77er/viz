/**
 * Raw storage for the compatibility tests: dump an object's SQLite, or replace it wholesale
 * with a dump, so that the NEXT construction of the object (after `evictDurableObject`)
 * opens storage written by other code: the pre-versioning release, or a newer one.
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import type { DurableObject } from 'cloudflare:workers'

export interface Dump {
  schema: { type: string; name: string; tbl_name: string; sql: string }[]
  rows: Record<string, Record<string, unknown>[]>
}

const OWN = "name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"

export function dumpOf(state: DurableObjectState): Dump {
  const sql = state.storage.sql
  const schema = sql.exec(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE ${OWN} ORDER BY type, name`).toArray() as Dump['schema']
  const rows: Dump['rows'] = {}
  for (const r of schema) {
    if (r.type !== 'table') continue
    const cols = sql.exec(`PRAGMA table_info(${r.name})`).toArray().map((c) => c.name as string)
    rows[r.name] = sql.exec(`SELECT * FROM ${r.name} ORDER BY ${cols.map((_, i) => i + 1).join(', ')}`).toArray()
  }
  return { schema, rows }
}

/** Drop everything the object has, then create and fill exactly what `dump` says. The alarm is left as it was. */
export function replaceWith(state: DurableObjectState, dump: Dump, rewrite: (table: string, row: Record<string, unknown>) => Record<string, unknown> = (_t, r) => r): void {
  const sql = state.storage.sql
  state.storage.transactionSync(() => {
    for (const r of sql.exec(`SELECT type, name FROM sqlite_master WHERE ${OWN} AND type IN ('trigger', 'index')`).toArray()) {
      if (!String(r.name).startsWith('sqlite_')) sql.exec(`DROP ${r.type} IF EXISTS ${r.name}`)
    }
    for (const r of sql.exec(`SELECT name FROM sqlite_master WHERE ${OWN} AND type = 'table'`).toArray()) sql.exec(`DROP TABLE IF EXISTS ${r.name}`)
    // Tables first, then their rows, then indexes and triggers (a trigger may forbid nothing on insert, but keep the order of a real database).
    for (const s of dump.schema.filter((x) => x.type === 'table')) sql.exec(s.sql)
    for (const [table, rows] of Object.entries(dump.rows)) {
      for (const raw of rows) {
        const row = rewrite(table, raw)
        const cols = Object.keys(row)
        sql.exec(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c] as SqlStorageValue))
      }
    }
    for (const s of dump.schema.filter((x) => x.type !== 'table')) sql.exec(s.sql)
  })
}

/** Install `dump` as the object's storage and throw the instance away, so the next call constructs it on that storage. */
export async function install<O extends DurableObject>(stub: DurableObjectStub<O>, dump: Dump, rewrite?: Parameters<typeof replaceWith>[2]): Promise<void> {
  await runInDurableObject(stub, (_i, state) => replaceWith(state, dump, rewrite))
  await evictDurableObject(stub)
}

/** The version row, or null. */
export function schemaRow(state: DurableObjectState): { component: string; version: number; compat: number; updated_at: number } | null {
  const has = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'viz_schema'").toArray().length > 0
  if (!has) return null
  return (state.storage.sql.exec('SELECT component, version, compat, updated_at FROM viz_schema').toArray()[0] as never) ?? null
}

/** A dump without the version table: what the storage holds apart from versioning. */
export const withoutVersion = (d: Dump): Dump => ({ schema: d.schema.filter((s) => s.tbl_name !== 'viz_schema'), rows: Object.fromEntries(Object.entries(d.rows).filter(([t]) => t !== 'viz_schema')) })
