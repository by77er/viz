// Where to keep a batch's time bounds (review of D72, M-1): bytes SQLite reads and time to decide
// that batches are skipped, and rows written per append, for each layout, in workerd's SQLite
// through a Durable Object (Miniflare, local workerd; measured here, not on Cloudflare).
//   node --experimental-strip-types --no-warnings bench/skipread.node.mjs [run] [large|small]
//
// Bytes read: /proc/<workerd pid>/io `rchar` around one call (every read() the process makes;
// with no I/O of its own besides SQLite's page reads in that call, an empty call reads 0 B). Each
// read is measured COLD: before it, the object reads 16 MiB of other pages through SQLite's page
// cache (a column after a 1 MiB blob: reading a blob itself bypasses the cache, so it cannot
// evict anything). Time: `performance.now()` inside the object, which moves in whole
// milliseconds in workerd: cold reads are single calls (so "0" means under 1 ms), warm ones a
// loop of many reads divided. Rows written: the cursor's `rowsWritten`, the quantity Durable
// Objects bill.
//
// The tails: "large", 48 span batches of 0.4 to 1 MB, one per ten minutes, plus two small ones
// without bounds (written by the release before); "small", 2,000 batches of about 200 B (whose
// payload lives in the B-tree leaf itself), plus two without bounds. The reads: a range no batch
// overlaps (every bounded batch skipped), one hour, everything. Before anything is compared every
// layout must return exactly the same batches for every read.
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { TIMED_TAIL_SQL } from '../src/tail.ts'

const require = createRequire(import.meta.url)
const { Miniflare, convertV4MiniflareOptions } = require('miniflare')

const script = `
import { DurableObject } from 'cloudflare:workers'
const T0 = 1_795_046_400_000
function fill(b, seed) { const u = new Uint32Array(b.buffer, 0, b.byteLength >> 2); let x = seed >>> 0 || 1; for (let i = 0; i < u.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; u[i] = x } return b }
export class Probe extends DurableObject {
  sql(q, ...a) { return this.ctx.storage.sql.exec(q, ...a) }
  async setup(L, n, small) {
    for (const s of L.ddl) this.sql(s)
    this.sql('CREATE TABLE junk (k INTEGER PRIMARY KEY, b BLOB, x INTEGER)')
    for (let k = 0; k < 16; k++) this.sql('INSERT INTO junk (k, b, x) VALUES (?, ?, ?)', k, fill(new Uint8Array(1 << 20), 1000 + k), k)
    let r = 1
    const w = []
    let bytes = 0
    const step = Math.floor(48 * 600_000 / (n - 2))
    for (let i = 0; i < n; i++) {
      const nul = i === 10 || i === Math.floor(n * 0.62)
      r = (r * 1103515245 + 12345) >>> 0
      const size = small ? 160 + (r % 80) : nul ? 1000 : 400_000 + (r % 600_000)
      const p = fill(new Uint8Array(size & ~3), i + 7)
      const k = nul ? null : i - (i > Math.floor(n * 0.62) ? 2 : i > 10 ? 1 : 0)
      const lo = k === null ? null : T0 + k * step
      const hi = k === null ? null : lo + step - 1
      let rw = 0
      this.ctx.storage.transactionSync(() => {
        for (const [q, args] of L.insert) { const c = this.sql(q, ...args.map((a) => ({ seq: i + 1, fp: 'fp' + i, rows: 1000, bytes: size, at: 0, p, lo, hi, tenant: 'tenant-0123456789' })[a])); c.toArray(); rw += c.rowsWritten }
      })
      w.push(rw)
      bytes += p.byteLength
    }
    return { rowsWritten: [w[0], w[10]], bytes }
  }
  // Fills SQLite's page cache with other pages (reading x walks the blob's overflow chain through the pager).
  async thrash() { let n = 0; for (const r of this.sql('SELECT x FROM junk')) n += r.x; return n }
  async read(q, args) {
    const t0 = performance.now()
    const c = this.sql(q, ...args)
    const seqs = []
    let bytes = 0
    for (const r of c) { if (r.payload === null) continue; seqs.push(r.seq); bytes += r.payload.byteLength }
    return { seqs, bytes, rowsRead: c.rowsRead, ms: performance.now() - t0 }
  }
  async loop(q, args, reps) {
    const t0 = performance.now()
    for (let k = 0; k < reps; k++) { for (const r of this.sql(q, ...args)) void r.payload }
    return (performance.now() - t0) / reps
  }
  async plan(q, args) { return this.sql('EXPLAIN QUERY PLAN ' + q, ...args).toArray().map((r) => r.detail) }
  async later(L) {
    const res = {}
    for (const [name, stmts] of Object.entries(L.later)) {
      let rw = 0
      this.ctx.storage.transactionSync(() => { for (const [q, args] of stmts) { const c = this.sql(q, ...args); c.toArray(); rw += c.rowsWritten } })
      res[name] = rw
    }
    return res
  }
  async noop() { return 0 }
}
export default { async fetch(req, env) { const { obj, method, args } = await req.json(); const stub = env.PROBE.get(env.PROBE.idFromName(obj)); return Response.json(await stub[method](...args)) } }
`

const TENANT = 'tenant-0123456789'
// Schema 2's batch table and index (shard/src/shard.ts V1), then migration 3's columns.
const BASE = [
  `CREATE TABLE batch (tenant TEXT NOT NULL, seq INTEGER NOT NULL, fingerprint TEXT NOT NULL, rows INTEGER NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL, payload BLOB, PRIMARY KEY (tenant, seq))`,
  `CREATE UNIQUE INDEX batch_fp ON batch (tenant, fingerprint)`,
]
const ADD = [`ALTER TABLE batch ADD COLUMN min_ts INTEGER`, `ALTER TABLE batch ADD COLUMN max_ts INTEGER`]
const INSERT = [[`INSERT INTO batch (tenant, seq, fingerprint, rows, bytes, at, payload, min_ts, max_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['tenant', 'seq', 'fp', 'rows', 'bytes', 'at', 'p', 'lo', 'hi']]]
const HULL = `(min_ts IS NULL OR max_ts IS NULL OR (max_ts >= ? AND min_ts <= ?))`
// Discard (payload set NULL, the shard's alarm) and fingerprint expiry (row deleted), one batch each.
const LATER = {
  discard: [[`UPDATE batch SET payload = NULL WHERE tenant = ? AND seq <= ? AND payload IS NOT NULL`, [TENANT, 1]]],
  expire: [[`DELETE FROM batch WHERE tenant = ? AND payload IS NULL AND seq <= ?`, [TENANT, 1]]],
}
// Migration 3's index, as shard/src/shard.ts creates it (test/golden/schema/v3.json pins it).
const PARTIAL = `CREATE INDEX batch_time ON batch (tenant, seq, min_ts, max_ts) WHERE min_ts IS NOT NULL AND max_ts IS NOT NULL`
const LAYOUTS = {
  'as built: bounds in the row, after the payload': {
    ddl: [...BASE, ...ADD], insert: INSERT, later: LATER,
    q: (n, lo, hi) => [`SELECT seq, rows, payload FROM batch WHERE tenant = ? AND seq BETWEEN ? AND ? AND payload IS NOT NULL AND ${HULL} ORDER BY seq`, [TENANT, 1, n, lo, hi]],
  },
  'CHOSEN: partial index batch_time, the shard\'s TIMED_TAIL_SQL': {
    ddl: [...BASE, ...ADD, PARTIAL], insert: INSERT, later: LATER,
    q: (n, lo, hi) => [TIMED_TAIL_SQL, [TENANT, 1, n, TENANT, lo, hi]],
  },
  'the same, with payload IS NOT NULL in its WHERE': {
    ddl: [...BASE, ...ADD, PARTIAL], insert: INSERT, later: LATER,
    q: (n, lo, hi) => [TIMED_TAIL_SQL.replace('ORDER BY b.seq', 'AND b.payload IS NOT NULL ORDER BY b.seq'), [TENANT, 1, n, TENANT, lo, hi]],
  },
  'full covering index (every row), INDEXED BY': {
    ddl: [...BASE, ...ADD, `CREATE INDEX batch_time ON batch (tenant, seq, min_ts, max_ts)`], insert: INSERT, later: LATER,
    q: (n, lo, hi) => [`SELECT seq, rows, payload FROM batch INDEXED BY batch_time WHERE tenant = ? AND seq BETWEEN ? AND ? AND ${HULL} ORDER BY seq`, [TENANT, 1, n, lo, hi]],
  },
  'a table of bounds (WITHOUT ROWID), one row per bounded batch': {
    ddl: [...BASE, `CREATE TABLE batch_time (tenant TEXT NOT NULL, seq INTEGER NOT NULL, min_ts INTEGER NOT NULL, max_ts INTEGER NOT NULL, PRIMARY KEY (tenant, seq)) WITHOUT ROWID`],
    insert: [[`INSERT INTO batch (tenant, seq, fingerprint, rows, bytes, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`, ['tenant', 'seq', 'fp', 'rows', 'bytes', 'at', 'p']], [`INSERT INTO batch_time (tenant, seq, min_ts, max_ts) SELECT ?, ?, ?, ? WHERE ? IS NOT NULL`, ['tenant', 'seq', 'lo', 'hi', 'lo']]],
    later: { discard: [...LATER.discard, [`DELETE FROM batch_time WHERE tenant = ? AND seq <= ?`, [TENANT, 1]]], expire: LATER.expire },
    q: (n, lo, hi) => [`SELECT seq, rows, payload FROM batch AS b WHERE b.tenant = ? AND b.seq BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM batch_time AS t WHERE t.tenant = ? AND t.seq = b.seq AND (t.max_ts < ? OR t.min_ts > ?)) ORDER BY seq`, [TENANT, 1, n, TENANT, lo, hi]],
  },
  'bounds before the payload (the table rebuilt)': {
    ddl: [`CREATE TABLE batch (tenant TEXT NOT NULL, seq INTEGER NOT NULL, fingerprint TEXT NOT NULL, rows INTEGER NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL, min_ts INTEGER, max_ts INTEGER, payload BLOB, PRIMARY KEY (tenant, seq))`, BASE[1]],
    insert: INSERT, later: LATER,
    q: (n, lo, hi) => [`SELECT seq, rows, payload FROM batch WHERE tenant = ? AND seq BETWEEN ? AND ? AND payload IS NOT NULL AND ${HULL} ORDER BY seq`, [TENANT, 1, n, lo, hi]],
  },
}
const T0 = 1_795_046_400_000
const RANGES = { 'skip all': [1, 2], 'one hour': [T0 + 4 * 3_600_000, T0 + 5 * 3_600_000 - 1], all: [0, Number.MAX_SAFE_INTEGER] }
const DATASETS = { large: { n: 50, small: false }, small: { n: 2002, small: true } }

const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'probe', modules: true, script, compatibilityDate: '2026-10-01', durableObjects: { PROBE: { className: 'Probe', useSQLite: true } } }] }))
await mf.ready
const pid = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).find((d) => {
  try {
    const st = readFileSync(`/proc/${d}/stat`, 'utf8')
    return st.includes('(workerd)') && st.split(') ')[1].split(' ')[1] === String(process.pid)
  } catch {
    return false
  }
})
if (!pid) throw new Error('no workerd child process')
const rchar = () => Number(readFileSync(`/proc/${pid}/io`, 'utf8').match(/rchar: (\d+)/)[1])
const call = async (obj, method, ...args) => {
  const r = await mf.dispatchFetch('http://probe/', { method: 'POST', body: JSON.stringify({ obj, method, args }) })
  const j = await r.json()
  if (r.status !== 200) throw new Error(JSON.stringify(j))
  return j
}
const run = process.argv[2] ?? '0'
const only = process.argv[3]
const REPS = 5
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
for (let i = 0; i < 3; i++) await call('noop', 'noop')
let base = Infinity
for (let i = 0; i < 5; i++) {
  const a = rchar()
  await call('noop', 'noop')
  base = Math.min(base, rchar() - a)
}
console.log(`# run ${run}, ${new Date().toISOString()}, load ${readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')}, rchar of an empty call ${base} B`)
let failed = false
for (const [ds, D] of Object.entries(DATASETS)) {
  if (only && only !== ds) continue
  const results = {}
  for (const [name, L] of Object.entries(LAYOUTS)) {
    const obj = `${ds}:${name}#${run}`
    const s = await call(obj, 'setup', { ddl: L.ddl, insert: L.insert }, D.n, D.small)
    const row = { tail: ds, layout: name, batches: D.n, MB: +(s.bytes / 1e6).toFixed(2), rowsWrittenPerAppend: { bounded: s.rowsWritten[0], unbounded: s.rowsWritten[1] } }
    for (const [rn, [lo, hi]] of Object.entries(RANGES)) {
      const [q, args] = L.q(D.n, lo, hi)
      await call(obj, 'read', q, args)
      const reads = []
      const ms = []
      let r
      for (let k = 0; k < REPS; k++) {
        await call(obj, 'thrash')
        const a = rchar()
        r = await call(obj, 'read', q, args)
        reads.push(rchar() - a - base)
        ms.push(r.ms)
      }
      const warm = await call(obj, 'loop', q, args, rn === 'all' ? 10 : D.small ? 50 : 200)
      row[rn] = { kept: r.seqs.length, returnedMB: +(r.bytes / 1e6).toFixed(3), coldReadKB: +(med(reads) / 1024).toFixed(1), coldMs: med(ms), warmMs: +warm.toFixed(3), rowsRead: r.rowsRead }
      results[name] = { ...results[name], [rn]: r.seqs }
      if (rn === 'skip all' && run === '0') row.plan = (await call(obj, 'plan', q, args)).join(' / ')
    }
    row.rowsWrittenLater = await call(obj, 'later', { later: L.later })
    console.log(`LAYOUT ${JSON.stringify(row)}`)
  }
  const names = Object.keys(results)
  let same = true
  for (const rn of Object.keys(RANGES)) {
    for (const n of names) {
      if (JSON.stringify(results[n][rn]) !== JSON.stringify(results[names[0]][rn])) {
        same = false
        console.log(`MISMATCH ${ds} ${n} ${rn}`)
      }
    }
  }
  failed ||= !same
  console.log(`SAME ${ds}: every layout returned the same batches for every read: ${same} (kept: ${Object.keys(RANGES).map((rn) => `${rn} ${results[names[0]][rn].length}`).join(', ')})`)
}
await mf.dispose()
process.exit(failed ? 1 : 0)
