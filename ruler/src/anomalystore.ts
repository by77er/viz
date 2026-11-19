/**
 * The stored form of a windowed detector's state, version 2 of `store.anomaly-state` (design D60).
 *
 * robust_z keeps the points of a trailing window and seasonal two rings of values by slot. In
 * version 1 each series' whole state is JSON (about 37 bytes a point, 39.7 at the longest number
 * encoding) and every row is rewritten at every tick. Version 2 keeps them as **Float64 values in
 * ring blocks** on the rule's interval grid, like the SLO rings (`slo.ts`):
 *
 *   head (chunk HEAD_CHUNK + i)  each series' labels, last outcome and the detector's scalars
 *   block b (chunk b)            slots b·BLOCK .. b·BLOCK + BLOCK − 1 of every series: values as
 *                                little-endian Float64, base64 in the JSON body; NaN where a slot
 *                                holds no point
 *
 * Slot n is the time `phase + n · interval` (`phase`: the grid's offset, in the head), so a point's
 * timestamp is implicit. A robust_z point off that grid (after the group's query offset changed),
 * and a series with few points in a block, are written as explicit (time, value) pairs instead. A
 * tick writes the head and the block its new points fall in (one, normally); blocks no series still
 * needs are deleted. Values are Float64, so the state read back is the state written, bit for bit
 * (−0 written as 0, as JSON writes it), and every score is the same.
 *
 * Pure: no storage, no clock. `ruler.ts` runs a plan in the tick's transaction.
 */
import type { SeriesState } from './anomaly'
import { byteLength } from './util'

/** The `store.anomaly-state` version of these rows. */
export const ANOMALY_STATE_V2 = 2
/** Slots per block: one hour at a 1-minute interval (as the SLO's fine ring). */
export const ANOMALY_BLOCK = 60
/** `anomaly_state.chunk` of head row i: far below any block number (blocks are slot / BLOCK, from a non-negative epoch). */
export const HEAD_CHUNK = -(2 ** 50)
/** A head row holds whole series entries up to about this many bytes (as a v1 row). */
export const HEAD_ROW_BYTES = 512 * 1024
/** Detectors whose state version 2 encodes; the others are written as version 1. */
export const WINDOWED: ReadonlySet<string> = new Set(['robust_z', 'seasonal'])

/** What is known of a rule's stored rows, kept beside its state: enough to write a tick's rows and count bytes without re-encoding the rest. */
export interface StoreMeta {
  /** The format of the rows as stored; null when none are. */
  version: 1 | 2 | null
  /** Version 2: the grid's offset in ms (slot n is phase + n · interval); null before any point. */
  phase: number | null
  /** Version 2: bytes of each stored row, by chunk. */
  rows: Map<number, number>
  /** Version 2: per block, each series' entry bytes. */
  entries: Map<number, Map<string, number>>
  /** Version 2: each series' head entry bytes. */
  heads: Map<string, number>
  /** The rows are to be replaced whole at the next write: read in another format, or under chunk numbers another release gave them. */
  rewrite: boolean
}

export const emptyStore = (): StoreMeta => ({ version: null, phase: null, rows: new Map(), entries: new Map(), heads: new Map(), rewrite: false })

/** One write of a rule's rows, run in a transaction: delete everything first (`purge`), upsert, then delete `deletes` and, for version 1, every chunk from `deleteFrom`. */
export interface AnomalyWrite {
  purge: boolean
  upserts: { chunk: number; body: string }[]
  deletes: number[]
  deleteFrom: number | null
  store: StoreMeta
  /** Stored bytes after the write: the rule, and each series (its head entry and its block entries; version 1, its JSON). */
  bytes: number
  perSeries: Map<string, number>
}

// ───────────────────────────── Float64 ⇄ base64 ─────────────────────────────

/** Little-endian Float64 values as base64. −0 is written as 0 (as JSON writes it). */
export function f64ToBase64(values: ArrayLike<number>): string {
  const view = new DataView(new ArrayBuffer(values.length * 8))
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    view.setFloat64(i * 8, v === 0 ? 0 : v, true)
  }
  const bytes = new Uint8Array(view.buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export function base64ToF64(text: string): Float64Array {
  const bin = atob(text)
  if (bin.length % 8 !== 0) throw new Error('not a whole number of Float64 values')
  const view = new DataView(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) view.setUint8(i, bin.charCodeAt(i))
  const out = new Float64Array(bin.length / 8)
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat64(i * 8, true)
  return out
}

// ───────────────────────────── the detectors' states ─────────────────────────────

/** `anomaly/` robust_z state, version 1: the window's points, oldest first. */
interface RobustState {
  v: 1
  lastTs: number | null
  stepMs: number
  t: number[]
  x: number[]
}
/** `anomaly/` seasonal state, version 1: two rings indexed by slot (from the series' first point) modulo their length. */
interface SeasonalState {
  v: 1
  periodMs: number
  stepMs: number
  seasons: number
  origin: number | null
  lastTs: number | null
  lastSlot: number | null
  run: number
  vals: (number | null)[]
  res: (number | null)[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const numOrNull = (v: unknown) => v === null || typeof v === 'number'
const isRobust = (s: unknown): s is RobustState => isObj(s) && s.v === 1 && numOrNull(s.lastTs) && typeof s.stepMs === 'number' && Array.isArray(s.t) && Array.isArray(s.x) && s.t.length === s.x.length
const isSeasonal = (s: unknown): s is SeasonalState =>
  isObj(s) && s.v === 1 && typeof s.periodMs === 'number' && typeof s.stepMs === 'number' && typeof s.seasons === 'number' && numOrNull(s.origin) && numOrNull(s.lastTs) && numOrNull(s.lastSlot) && typeof s.run === 'number' && Array.isArray(s.vals) && Array.isArray(s.res) && s.vals.length > 0 && s.res.length > 0

const mod = (a: number, n: number) => ((a % n) + n) % n
const residue = (t: number, m: number) => ((t % m) + m) % m
const NaNs = (n: number) => new Float64Array(n).fill(NaN)

/** One series laid out on the grid: the slots its stored content spans, and its content for one block. */
interface Layout {
  /** Lowest and highest slot with content; null when it has none. */
  lo: number | null
  hi: number | null
  /** The slot its newest content is at (what a tick changes). */
  newest: number | null
  /** Its entry for block b (without the key), or null when it has nothing there. */
  entry(b: number, B: number): { x?: string; e?: string; r?: string } | null
}

function robustLayout(st: RobustState, phase: number, I: number): Layout {
  const slot = (t: number) => Math.floor((t - phase) / I)
  const onGrid = (t: number) => Number.isSafeInteger(t) && Number.isSafeInteger(phase) && Number.isSafeInteger(I) && (t - phase) % I === 0
  const n = st.t.length
  /** First index with t ≥ bound. */
  const first = (bound: number) => {
    let lo = 0, hi = n
    while (lo < hi) {
      const m = (lo + hi) >>> 1
      if (st.t[m]! < bound) lo = m + 1
      else hi = m
    }
    return lo
  }
  return {
    lo: n > 0 ? slot(st.t[0]!) : null,
    hi: n > 0 ? slot(st.t[n - 1]!) : null,
    newest: n > 0 ? slot(st.t[n - 1]!) : null,
    entry(b, B) {
      const a = first(phase + b * B * I)
      const z = first(phase + (b + 1) * B * I)
      if (a >= z) return null
      let grid = true
      for (let i = a; i < z && grid; i++) grid = onGrid(st.t[i]!)
      // Implicit times where every point is on the grid and they fill the block at least half
      // (8 bytes a slot); otherwise explicit (time, value) pairs (16 bytes a point).
      if (grid && 2 * (z - a) >= B) {
        const x = NaNs(B)
        for (let i = a; i < z; i++) x[slot(st.t[i]!) - b * B] = st.x[i]!
        return { x: f64ToBase64(x) }
      }
      const e = new Float64Array(2 * (z - a))
      for (let i = a; i < z; i++) {
        e[2 * (i - a)] = st.t[i]!
        e[2 * (i - a) + 1] = st.x[i]!
      }
      return { e: f64ToBase64(e) }
    },
  }
}

/** A seasonal series' slot q (from its own first point) is grid slot q + o. */
function seasonalShift(st: SeasonalState, phase: number, I: number): number {
  return st.origin === null ? 0 : Math.round((st.origin - phase) / I)
}

function seasonalLayout(st: SeasonalState, phase: number, I: number): Layout {
  const R = st.vals.length
  const Rr = st.res.length
  const o = seasonalShift(st, phase, I)
  if (st.lastSlot === null) return { lo: null, hi: null, newest: null, entry: () => null }
  const last = st.lastSlot
  // The rings hold slots (last − R, last] and (last − Rr, last]; none before the series' first point (slot 0).
  const qlo = Math.max(0, last - Math.max(R, Rr) + 1)
  return {
    lo: qlo + o,
    hi: last + o,
    newest: last + o,
    entry(b, B) {
      const x = NaNs(B)
      const r = NaNs(B)
      let any = false
      for (let q = Math.max(qlo, b * B - o); q <= Math.min(last, (b + 1) * B - 1 - o); q++) {
        const v = q > last - R ? st.vals[mod(q, R)] : null
        const w = q > last - Rr ? st.res[mod(q, Rr)] : null
        if (v !== null && v !== undefined) {
          x[q + o - b * B] = v
          any = true
        }
        if (w !== null && w !== undefined) {
          r[q + o - b * B] = w
          any = true
        }
      }
      return any ? { x: f64ToBase64(x), r: f64ToBase64(r) } : null
    },
  }
}

/** The head entry of a series: everything but the windows. */
function headEntry(key: string, s: SeriesState, detector: string, phase: number, I: number): Record<string, unknown> {
  const base = { k: key, l: s.labels, last: s.last, seen: s.seenAt }
  if (detector === 'robust_z') {
    const st = s.state as RobustState
    return { ...base, s: { v: st.v, lastTs: st.lastTs, stepMs: st.stepMs } }
  }
  const st = s.state as SeasonalState
  return { ...base, s: { v: st.v, periodMs: st.periodMs, stepMs: st.stepMs, seasons: st.seasons, origin: st.origin, lastTs: st.lastTs, lastSlot: st.lastSlot, run: st.run }, R: st.vals.length, Rr: st.res.length, o: seasonalShift(st, phase, I) }
}

// ───────────────────────────── writing ─────────────────────────────

const blockOf = (slot: number, B: number) => Math.floor(slot / B)

/**
 * The rows a rule's state needs written, as version 2. `full`: every row (a warm-up, a move, a
 * conversion from version 1, rows to renumber); otherwise the head, the block each `touched`
 * series' newest point falls in, and the blocks holding an entry no series needs any more
 * (rewritten without it, or deleted). `windowMs`: robust_z's window, written in the head (the
 * decoder drops points the window has evicted from a block not rewritten since). Null when a
 * series' state is not one this version encodes: the caller writes version 1.
 */
export function planV2(
  detector: string,
  intervalMs: number,
  windowMs: number | null,
  prev: StoreMeta,
  series: ReadonlyMap<string, SeriesState>,
  touched: ReadonlySet<string>,
  full: boolean,
  B = ANOMALY_BLOCK,
): AnomalyWrite | null {
  const I = intervalMs
  const keys = [...series.keys()].sort()
  for (const k of keys) {
    const st = series.get(k)!.state
    if (detector === 'robust_z' ? !isRobust(st) : detector === 'seasonal' ? !isSeasonal(st) : true) return null
  }
  // The grid's offset: kept once set; else from the first point on record.
  let phase = prev.version === 2 ? prev.phase : null
  for (const k of keys) {
    if (phase !== null) break
    const st = series.get(k)!.state as RobustState | SeasonalState
    const t = 't' in st ? st.t[0] : st.origin
    if (t !== undefined && t !== null) phase = residue(t, I)
  }
  const ph = phase ?? 0
  const layouts = new Map<string, Layout>()
  for (const k of keys) {
    const st = series.get(k)!.state
    layouts.set(k, detector === 'robust_z' ? robustLayout(st as RobustState, ph, I) : seasonalLayout(st as SeasonalState, ph, I))
  }
  const purge = full || prev.version !== 2 || prev.rewrite
  const dirty = new Set<number>()
  if (purge) {
    // Every block a series holds content in.
    for (const l of layouts.values()) {
      if (l.lo === null || l.hi === null) continue
      for (let b = blockOf(l.lo, B); b <= blockOf(l.hi, B); b++) dirty.add(b)
    }
  } else {
    // The block each changed series' newest point is in (one, normally)...
    for (const k of touched) {
      const n = layouts.get(k)?.newest
      if (n !== null && n !== undefined) dirty.add(blockOf(n, B))
    }
    // ...and every block holding an entry its series no longer needs (a series pruned, or whose
    // window has moved past the block): rewritten without it, or deleted when nothing is left.
    // One series gone quiet does not keep the other series' old entries.
    for (const [b, m] of prev.entries) {
      if (dirty.has(b)) continue
      for (const k of m.keys()) {
        const l = layouts.get(k)
        if (!l || l.lo === null || blockOf(l.lo, B) > b) {
          dirty.add(b)
          break
        }
      }
    }
  }
  const store: StoreMeta = {
    version: 2,
    phase,
    rows: purge ? new Map() : new Map(prev.rows),
    entries: purge ? new Map() : new Map(prev.entries),
    heads: new Map(),
    rewrite: false,
  }
  const upserts: AnomalyWrite['upserts'] = []
  const deletes: number[] = []
  for (const b of [...dirty].sort((x, y) => x - y)) {
    const parts: string[] = []
    const sizes = new Map<string, number>()
    for (const k of keys) {
      const l = layouts.get(k)!
      // A series' content before its own oldest needed block is not written again.
      if (l.lo === null || blockOf(l.lo, B) > b) continue
      const e = l.entry(b, B)
      if (!e) continue
      const j = JSON.stringify({ k, ...e })
      parts.push(j)
      sizes.set(k, byteLength(j) + 1)
    }
    if (parts.length === 0) {
      if (store.rows.delete(b) && !purge) deletes.push(b)
      store.entries.delete(b)
      continue
    }
    const body = `{"v":${ANOMALY_STATE_V2},"part":"block","b":${b},"series":[${parts.join(',')}]}`
    upserts.push({ chunk: b, body })
    store.rows.set(b, byteLength(body))
    store.entries.set(b, sizes)
  }
  // The head: every series' entry, in rows of whole entries.
  const head = { detector, stepMs: I, phase, block: B, w: windowMs }
  const chunks: string[][] = []
  let cur: string[] = []
  let size = 0
  for (const k of keys) {
    const j = JSON.stringify(headEntry(k, series.get(k)!, detector, ph, I))
    store.heads.set(k, byteLength(j) + 1)
    if (cur.length > 0 && size + byteLength(j) + 1 > HEAD_ROW_BYTES) {
      chunks.push(cur)
      cur = []
      size = 0
    }
    cur.push(j)
    size += byteLength(j) + 1
  }
  chunks.push(cur)
  const prefix = JSON.stringify({ v: ANOMALY_STATE_V2, part: 'head', ...head }).slice(0, -1)
  chunks.forEach((c, i) => {
    const body = `${prefix},"i":${i},"n":${chunks.length},"series":[${c.join(',')}]}`
    upserts.push({ chunk: HEAD_CHUNK + i, body })
    store.rows.set(HEAD_CHUNK + i, byteLength(body))
  })
  for (const c of [...store.rows.keys()]) {
    if (c >= HEAD_CHUNK + chunks.length && c < HEAD_CHUNK + 1e6) {
      store.rows.delete(c)
      if (!purge) deletes.push(c)
    }
  }
  let bytes = 0
  for (const n of store.rows.values()) bytes += n
  // Each series: its head entry and its entries in the blocks it still needs.
  const perSeries = new Map<string, number>(store.heads)
  for (const [b, m] of store.entries) {
    for (const [k, n] of m) {
      const l = layouts.get(k)
      if (l && l.lo !== null && blockOf(l.lo, B) <= b) perSeries.set(k, perSeries.get(k)! + n)
    }
  }
  return { purge, upserts, deletes, deleteFrom: null, store, bytes, perSeries }
}

// ───────────────────────────── reading ─────────────────────────────

interface HeadRow {
  v: 2
  part: 'head'
  i: number
  n: number
  detector: string
  stepMs: number
  phase: number | null
  block: number
  w: number | null
  series: Record<string, unknown>[]
}
interface BlockRow {
  v: 2
  part: 'block'
  b: number
  series: { k: string; x?: string; e?: string; r?: string }[]
}

/**
 * A rule's state from its version 2 rows (`chunk`, and the body parsed). Refused (an error) when a
 * row is not what version 2 says, or a head row is missing: never guessed. A row stored under
 * another chunk than its own (moved by a release that numbers rows 0, 1, …) is read by what it
 * says, and the rows are rewritten whole at the next write.
 */
export function readV2(rows: { chunk: number; body: Record<string, unknown>; text: string }[]): { series: Map<string, SeriesState>; store: StoreMeta } | { error: string } {
  const heads: HeadRow[] = []
  const blocks: BlockRow[] = []
  const store = emptyStore()
  store.version = 2
  for (const { chunk, body, text } of rows) {
    if (body.part === 'head' && Number.isInteger(body.i) && Number.isInteger(body.n) && Array.isArray(body.series)) {
      heads.push(body as unknown as HeadRow)
      if (chunk !== HEAD_CHUNK + (body.i as number)) store.rewrite = true
      store.rows.set(HEAD_CHUNK + (body.i as number), byteLength(text))
    } else if (body.part === 'block' && Number.isInteger(body.b) && Array.isArray(body.series)) {
      blocks.push(body as unknown as BlockRow)
      if (chunk !== body.b) store.rewrite = true
      store.rows.set(body.b as number, byteLength(text))
    } else return { error: 'an anomaly_state row of version 2 is neither a head nor a block' }
  }
  const series = new Map<string, SeriesState>()
  if (heads.length === 0) return blocks.length === 0 ? { series, store } : { error: 'anomaly_state has blocks but no head row' }
  heads.sort((a, b) => a.i - b.i)
  const h = heads[0]!
  if (heads.some((x, i) => x.i !== i || x.n !== heads.length || x.detector !== h.detector || x.stepMs !== h.stepMs || x.phase !== h.phase || x.block !== h.block || x.w !== h.w)) return { error: `anomaly_state head rows are incomplete or disagree (${heads.length} of ${h.n})` }
  if (!WINDOWED.has(h.detector) || !(h.stepMs > 0) || !Number.isInteger(h.block) || h.block < 1) return { error: `anomaly_state head describes ${JSON.stringify(h.detector)} at step ${h.stepMs}, block ${h.block}: not something version 2 encodes` }
  const B = h.block
  const I = h.stepMs
  const phase = h.phase ?? 0
  store.phase = h.phase
  // Each series' content by block, decoded once.
  const byKey = new Map<string, { b: number; x: Float64Array | null; e: Float64Array | null; r: Float64Array | null }[]>()
  try {
    for (const blk of blocks.sort((a, b) => a.b - b.b)) {
      const sizes = new Map<string, number>()
      for (const e of blk.series) {
        const x = typeof e.x === 'string' ? base64ToF64(e.x) : null
        const ex = typeof e.e === 'string' ? base64ToF64(e.e) : null
        const r = typeof e.r === 'string' ? base64ToF64(e.r) : null
        if ((x && x.length !== B) || (r && r.length !== B) || (ex && ex.length % 2 !== 0)) return { error: `anomaly_state block ${blk.b} holds a series entry of the wrong length` }
        let list = byKey.get(e.k)
        if (!list) byKey.set(e.k, (list = []))
        list.push({ b: blk.b, x, e: ex, r })
        sizes.set(e.k, byteLength(JSON.stringify(e)) + 1)
      }
      store.entries.set(blk.b, sizes)
    }
  } catch {
    return { error: 'an anomaly_state block is not base64 Float64 values' }
  }
  for (const head of heads) {
    for (const ent of head.series) {
      const k = ent.k as string
      const s = ent.s as Record<string, unknown>
      if (typeof k !== 'string' || !isObj(s) || s.v !== 1) return { error: `anomaly_state head entry ${String(k).slice(0, 40)} holds no detector state version 1` }
      const content = byKey.get(k) ?? []
      let state: unknown
      if (h.detector === 'robust_z') {
        const lastTs = s.lastTs as number | null
        const t: number[] = []
        const x: number[] = []
        // Points the window has evicted since their block was written are still in it: drop them as the detector did (t ≤ lastTs − window).
        const after = lastTs === null || h.w === null ? -Infinity : lastTs - h.w
        for (const c of content) {
          const pts: [number, number][] = []
          if (c.x) for (let j = 0; j < B; j++) if (c.x[j] === c.x[j]) pts.push([phase + (c.b * B + j) * I, c.x[j]!])
          if (c.e) for (let j = 0; j < c.e.length; j += 2) pts.push([c.e[j]!, c.e[j + 1]!])
          if (c.x && c.e) pts.sort((p, q) => p[0] - q[0])
          for (const [ti, xi] of pts) {
            if (ti <= after || (lastTs !== null && ti > lastTs)) continue
            t.push(ti)
            x.push(xi)
          }
        }
        state = { v: s.v, lastTs, stepMs: s.stepMs, t, x }
      } else {
        const R = ent.R as number
        const Rr = ent.Rr as number
        const o = ent.o as number
        if (!(Number.isInteger(R) && R > 0 && Number.isInteger(Rr) && Rr > 0 && Number.isInteger(o))) return { error: `anomaly_state head entry ${k.slice(0, 40)} has no ring geometry` }
        const vals: (number | null)[] = new Array(R).fill(null)
        const res: (number | null)[] = new Array(Rr).fill(null)
        const last = s.lastSlot as number | null
        if (last !== null) {
          for (const c of content) {
            for (let j = 0; j < B; j++) {
              const q = c.b * B + j - o
              if (q < 0 || q > last) continue
              const v = c.x ? c.x[j]! : NaN
              const w = c.r ? c.r[j]! : NaN
              if (q > last - R && v === v) vals[mod(q, R)] = v
              if (q > last - Rr && w === w) res[mod(q, Rr)] = w
            }
          }
        }
        state = { v: s.v, periodMs: s.periodMs, stepMs: s.stepMs, seasons: s.seasons, origin: s.origin, lastTs: s.lastTs, lastSlot: s.lastSlot, run: s.run, vals, res }
      }
      series.set(k, { labels: ent.l as SeriesState['labels'], state, last: ent.last as SeriesState['last'], seenAt: ent.seen as number })
      store.heads.set(k, byteLength(JSON.stringify(ent)) + 1)
    }
  }
  return { series, store }
}
