import { TENANT_ID, type Table, dataKeyPrefix } from '../../contracts/ledger'

/**
 * Object keys for data files, exactly as contracts/TABLES.md states them:
 *
 *   {cell}/data/{table}/tenant={tenant}/day={YYYY-MM-DD}/L{level}-{shard}-{incarnation}-{seqLo}-{seqHi}-{hash8}.parquet
 *
 * and for `spans`, one level deeper, the hour of the day every row's start time lies in
 * (contracts/TRACES.md, "Object keys"; contracts/ledger.ts `dataKeyPrefix`):
 *
 *   {cell}/data/spans/tenant={tenant}/day={YYYY-MM-DD}/hour={HH}/L{level}-….parquet
 *
 * `trace_index` and `logs` are keyed by day, as the metric tables are.
 * `shard` is the shard name with `/` replaced by `_`; `hash8` is the first 8 hex characters
 * of the SHA-256 of the file bytes. Everything in a key comes from the segment and from
 * the bytes, so two attempts that produce the same bytes produce the same key, and two
 * that differ cannot collide.
 */
export interface KeyParts {
  cell: string
  table: Table
  tenant: string
  day: string
  level: number
  shard: string
  incarnation: number
  seqLo: number
  seqHi: number
  /** Lowercase hex SHA-256 of the file bytes. */
  sha256Hex: string
  /** `spans` only, and required there: the UTC hour (0 to 23) of `day`. */
  hour?: number
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const HEX64 = /^[0-9a-f]{64}$/
const natural = (n: number): boolean => Number.isSafeInteger(n) && n >= 0

export function dataFileKey(p: KeyParts): string {
  // Refuse rather than build a key that could land outside the tenant's prefix.
  if (!TENANT_ID.test(p.tenant)) throw new Error('flush: tenant id must match [A-Za-z0-9_-]{1,64}')
  if (!DAY.test(p.day)) throw new Error(`flush: day must be YYYY-MM-DD, got ${p.day}`)
  if (!HEX64.test(p.sha256Hex)) throw new Error('flush: sha256 must be 64 lowercase hex characters')
  if (!natural(p.level) || !natural(p.incarnation) || !natural(p.seqLo) || !natural(p.seqHi) || p.seqLo < 1 || p.seqHi < p.seqLo) {
    throw new Error('flush: level, incarnation and sequence range must be non-negative integers with 1 <= seqLo <= seqHi')
  }
  if (p.cell === '' || p.cell.includes('/') || p.shard === '') throw new Error('flush: bad cell or shard name')
  // A spans file is keyed by its hour, and nothing else is (contracts/TRACES.md "Object keys").
  if ((p.table === 'spans') !== (p.hour !== undefined)) throw new Error(`flush: an hour is required for spans files and only for them (${p.table}, hour ${p.hour})`)
  if (p.hour !== undefined && !(Number.isInteger(p.hour) && p.hour >= 0 && p.hour <= 23)) throw new Error(`flush: hour must be 0 to 23, got ${p.hour}`)
  const shard = p.shard.replaceAll('/', '_')
  return `${dataKeyPrefix(p.cell, p.table, p.tenant, p.day, p.hour)}L${p.level}-${shard}-${p.incarnation}-${p.seqLo}-${p.seqHi}-${p.sha256Hex.slice(0, 8)}.parquet`
}

export function hex(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < b.length; i++) s += (b[i]! < 16 ? '0' : '') + b[i]!.toString(16)
  return s
}
