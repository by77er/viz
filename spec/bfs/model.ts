// An explicit-state model of the viz write/read protocol, written independently of viz.qnt.
//
// Sources: design/DESIGN.md §2, §4, §5.2, §5.3, §6.2; contracts/ledger.ts;
// contracts/LEDGER-LOG.md (the PLANNED segment log); shard/src/shard.ts; ledger/src/ledger.ts;
// flush/src/flush.ts; compact/src/compact.ts; janitor/src/janitor.ts; query/src/coordinator.ts.
//
// Every action is one atomic step of one component and names the method it stands for.
// Every protocol rule that a design or an implementation could get wrong is a field of `Cfg`,
// so that one rule at a time can be switched off (run.ts).
//
// State is plain JSON (arrays of small integers): `check.ts` hashes its canonical string.

export interface Cfg {
  // ---------------------------------------------------------------- bounds
  nt: number // tenants
  ns: number // shards (every tenant may write to every shard: one pool)
  nb: number // client batches; batch b belongs to tenant b % nt and is routed to shard floor(b / nt) % ns
  maxSend: number // sends per batch (first send + retries)
  variants: number // distinct encoder outputs for one segment (double flush with different bytes)
  maxJobs: number // flush Workers in flight at once (no bound on attempts in total)
  maxCJobs: number // compaction steps in flight at once
  maxCSteps: number // with compKey 'unique': compaction steps started in total (each gets a never-reused id)
  maxComp: number // successful compactions (replace commits) per ledger
  maxExp: number // retention removals per ledger
  maxLL: number // ledger storage losses per ledger
  maxSL: number // shard storage losses in total
  maxQ: number // queries in total (one at a time)
  maxRestarts: number // refusals per query (ignored when `liveness`)
  sameContent: boolean // with 2 tenants: batch 0 (tenant 0) and batch 1 (tenant 1) have identical bytes

  // ---------------------------------------------------------------- rules
  fence: boolean // (a) tailRead refuses aboveSeq < discardedThrough
  contiguous: boolean // (b) addUnit requires seqLo == watermark + 1 (else: watermark = highest seq)
  recAt: 'logged' | 'committed' // (c) the shard is told `recorded` at loggedWatermarks() or at the committed watermark
  dedup: boolean // (d) append de-duplicates on the batch fingerprint
  fpHorizon: boolean // (e) assumption: no client retry after its fingerprint has been forgotten (TTL > retry horizon)
  replaceLive: boolean // (f) replace succeeds only if every input is live
  delGrace: boolean // (g) a removed file is deleted only when no query in flight holds a plan naming it
  delLogged: boolean // a removed file is deleted only once its removal is logged
  missingErr: boolean // a planned file that is missing / has other bytes is an error -> re-plan (else read as empty)
  keying: 'content' | 'inm' | 'overwrite' // (h) flush keys: content hash; deterministic + If-None-Match; deterministic + overwrite
  sweep: 'off' | 'spec' | 'impl' | 'inputs' | 'any' // orphan sweeper rule (see the sweeper action)
  sweepIncLogged: boolean // with 'impl': "the ledger has a newer incarnation" counts only once that registration is logged
  sweepSteps: boolean // the sweep as janitor.ts runs it: list R2, then ONE ledger read, then one delete per doomed key, separate steps (false: one atomic step)
  sweepAge: boolean // with 'inputs': keep the age floor (an object is a candidate only if its uploader was no longer in flight when listed); false = no clock at all
  purgeSteps: boolean // purge as janitor.ts runs it: delete the object, then (separately) forget the tombstone (false: one atomic step)
  startSteps: boolean // with baseFirst: a ledger start is two steps, PUT the base, then commit; nothing is served in between, and storage can be lost again in between
  maxSweeps: number // with sweepSteps: orphan sweep runs started in total (a sweep is periodic; this bounds the state space); 99 = unbounded
  sweepGone: 'both' | 'notLive' | 'absent' // with 'inputs': an input is gone for good if absent from the listing AND not live (janitor.ts) / only not live / only absent
  sweepOrder: 'listFirst' | 'readFirst' // with sweepSteps: list R2 before the ledger read (janitor.ts) / read the ledger first, then list
  sweepNewerLogged: boolean // with 'inputs': a newer incarnation makes an old flush file dead only if it has a logged watermark > 0 (F15 fix)
  goal: 'query' | 'clean' | 'cleanComp' // liveness goal: the query completes / every object in R2 is live (no object leaks: I11's no-leak half)
  reg: 'design' | 'logged' | 'impl' // stream registration: before writes (committed) / before writes (logged) + repeat / lazily by flush (as built)
  query: 'design' | 'impl' // ask only streams in the plan / also every pool shard, unregistered streams from 0 (coordinator.ts)
  unknownStream: 'empty' | 'refuse' // tailRead for a stream the shard does not hold: ok+empty (shard.ts) / incarnation_mismatch
  f6Register: boolean // with 'refuse' and lazy registration: the refusing shard also recreates and registers the stream
  readBound: boolean // flush reads a segment bound to (incarnation, seqLo, seqHi); false = readSegment(tenant, seqLo) (shard.ts)
  log: 'perChange' | 'segments' // as built (one object per change, written in order) / LEDGER-LOG.md segments
  rebuild: 'strict' | 'skip' // replay refuses anything but version+1 (ledger.ts replay) / skips versions it already has
  drainRetrySame: boolean // a drain retried after a failure writes exactly the segment of the failed attempt first
  baseFirst: boolean // a new ledger incarnation is in R2 before it commits anything (as built: base.json first)
  baseTombstones: boolean // a base carries the tombstones, so a rebuild keeps removals made before it (ledger.ts since 2026-11-18 evening)
  compKey: 'inputs' | 'unique' // compaction output key: hash(inputs)+hash(bytes) (compact.ts) / also a fresh step id
  compConflictDelete: boolean // on `conflict` the step deletes its outputs unless one is live (compact.ts)
  fpScope: 'stream' | 'shard' // fingerprints per (shard, tenant) stream / per shard
  tailScope: 'stream' | 'shard' // tailRead returns one tenant's rows / every tenant's rows of the shard
  noRetryAcrossLoss: boolean // assumption: no client retry of a batch whose fingerprint a shard storage loss destroyed
  retain: boolean // timing: a recorded segment outlives every query attempt planned before it was recorded
  liveness: boolean // no refusal counter in the state; check.ts then checks AG EF (query done)
}

// ------------------------------------------------------------------ interning (global, deterministic)

/** A row is one physical copy of a batch: [shard, tenant, incarnation, seq, batch]. */
const rowKeys = new Map<string, number>()
export const ROWS: number[][] = []
export function rowId(s: number, t: number, inc: number, q: number, b: number): number {
  const k = `${s},${t},${inc},${q},${b}`
  let id = rowKeys.get(k)
  if (id === undefined) {
    id = ROWS.length
    ROWS.push([s, t, inc, q, b])
    rowKeys.set(k, id)
  }
  return id
}

/** A file is the bytes of one object: its rows, whether it is a compaction output, and its encoder variant. */
export interface FileRec {
  t: number
  rows: number[]
  comp: boolean
  v: number
  key: number // interned object key
  name: string
  ins: number[] // compaction output: its inputs (R2 metadata `viz-inputs`)
}
const fileKeys = new Map<string, number>()
export const FILES: FileRec[] = []
const keyIds = new Map<string, number>()
export const KEYS: string[] = []
function keyId(k: string): number {
  let id = keyIds.get(k)
  if (id === undefined) {
    id = KEYS.length
    KEYS.push(k)
    keyIds.set(k, id)
  }
  return id
}
export function fileId(t: number, rows: number[], comp: boolean, v: number, key: string, name: string, ins: number[] = []): number {
  const k = `${t}|${rows.join('.')}|${comp ? 1 : 0}|${v}|${key}`
  let id = fileKeys.get(k)
  if (id === undefined) {
    id = FILES.length
    FILES.push({ t, rows, comp, v, key: keyId(key), name, ins })
    fileKeys.set(k, id)
  }
  return id
}

// ------------------------------------------------------------------ state

/** shard.ts `Stream` + its tables. seq numbers are 1-based positions in `w`. inc 0: no stream row. */
export interface Strm {
  i: number // incarnation
  w: number[] // batch ids, by seq
  se: number // sealed_through
  re: number // recorded_through
  di: number // discarded_through (the fence); payloads <= di are NULL
  fg: number // fingerprints of seq <= fg forgotten (alarm step 3)
  bo: number[] // seq_hi of every segment row still present (> di)
  rg: number // design handshake: 1 once the stream may accept writes
}

/** One `LedgerChange`: [added files, removed files, watermark change [shard, inc, seq] or null, expired rows]. */
export type Entry = [number[], number[], number[] | null, number[]]

export interface Snap {
  fi: number[]
  wm: number[][] // per shard [inc, seq]; inc 0 = unknown stream
  ex: number[]
  tb: number[] // tombstoned files carried by the base (baseTombstones)
}

/** ledger.ts state for one tenant, plus its R2 change log. */
export interface Led {
  li: number // ledger incarnation
  dn: number // 1 = rebuild refused: the ledger serves nothing
  fi: number[] // live files (sorted)
  wm: number[][] // committed watermark per shard
  lg: number[] // `logged` per shard
  ex: number[] // rows removed by retention (committed)
  h: Entry[] // changes of this incarnation; h[k] has version base+1+k
  o0: number // outbox = h[o0..]; h[..o0-1] are drained (rows deleted, logged marks advanced)
  sg: number[][] // segments in R2 of this incarnation: [lo, hi] indices into h
  dr: number[] | null // a drain whose PUT has happened and whose delete transaction has not
  pl: number[] | null // drainRetrySame: bounds of the last attempted segment
  b: Snap // base: the state this incarnation started from (in R2 iff baseInR2)
  tb: number[][] // tombstones [file, index of the removing change in h, or -1: replayed from R2, 1 once a purge run has deleted its object]
  nC: number
  nE: number
  nL: number
  ru: number // ghost: this incarnation number was used before (versions reused)
  st: number // startSteps: 0 serving; 1 storage lost, state replayed, base not yet PUT; 2 base PUT, not committed. Nothing is served while st > 0
  mx: number // ghost (startSteps): the highest ledger incarnation number with a base in R2
}

/** One run of janitor.ts sweepOrphans (sweepSteps). */
export interface Sw {
  t: number
  ph: number // 0 listed; 1 ledger read done, deleting
  ls: number[][] // the listing: [key, file (bytes), 1 if old enough when listed]
  dm: number[] // doomed files (by their listed bytes), still to delete
  rd: Pick<Led, 'fi' | 'tb' | 'wm' | 'lg'> | null // sweepOrder 'readFirst': the ledger read, taken before the listing
}

export interface Job {
  id: number
  s: number
  t: number
  i: number // incarnation as listed by pendingSegments
  lo: number
  hi: number
  ph: number // 0 listed, 1 read+encoded, 2 PUT done, 3 ledger said older incarnation: register, 4 registered: addUnit once more
  f: number // file (after read)
}

export interface CJob {
  id: number
  t: number
  ins: number[]
  out: number
  ph: number // 0 read+merged, 1 PUT done
}

export interface Q {
  st: number // 0 idle, 1 reading tails, 2 done
  t: number
  fi: number[] // plan: files
  wm: number[][] // plan: watermarks
  nd: number[] // shards whose tail is still to be read
  tl: number[] // tail rows so far
  mu: number[] // ghost: batches acknowledged before the (last) plan
  ex: number[] // ghost: batches retention had removed at the planned version
  ln: number[] // coordinator `known`: incarnation learned per shard (0 = none)
  rs: number // refusals so far
  dup: number
  miss: number
  leak: number
}

export interface St {
  sh: Strm[][] // [shard][tenant]
  incN: number[][] // last incarnation number used per [shard][tenant] (a clock: never reused)
  sent: number[]
  acked: number[]
  lost: number[] // ghost: destroyed by a shard storage loss above the logged watermark (exempt)
  fpx: number[] // ghost: fingerprint forgotten by TTL
  wiped: number[] // ghost: fingerprint destroyed by a storage loss
  jobs: Job[]
  cj: CJob[]
  obj: number[][] // R2 data objects [key, file (bytes stored), uploader job id or -1]
  L: Led[]
  q: Q
  nSL: number
  nQ: number
  cN: number // compaction steps started (ids for compKey 'unique'; never reused)
  sw: Sw | null // the orphan sweep in progress (sweepSteps)
  nSw: number // orphan sweep runs started (sweepSteps)
}

// ------------------------------------------------------------------ helpers

const T = (c: Cfg, b: number) => b % c.nt
const R = (c: Cfg, b: number) => Math.floor(b / c.nt) % c.ns
const FP = (c: Cfg, b: number) => (c.nt === 2 && c.sameContent ? Math.floor(b / 2) : b)
const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const sortU = (a: number[]) => [...new Set(a)].sort((x, y) => x - y)
const has = (a: number[], x: number) => a.includes(x)
const without = (a: number[], x: number) => a.filter((y) => y !== x)
const cmpArr = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

const freshStrm = (): Strm => ({ i: 0, w: [], se: 0, re: 0, di: 0, fg: 0, bo: [], rg: 0 })
const freshSnap = (ns: number): Snap => ({ fi: [], wm: range(ns).map(() => [0, 0]), ex: [], tb: [] })
const idleQ = (): Q => ({ st: 0, t: 0, fi: [], wm: [], nd: [], tl: [], mu: [], ex: [], ln: [], rs: 0, dup: 0, miss: 0, leak: 0 })

export function init(c: Cfg): St {
  return {
    sh: range(c.ns).map(() => range(c.nt).map(freshStrm)),
    incN: range(c.ns).map(() => range(c.nt).map(() => 0)),
    sent: range(c.nb).map(() => 0),
    acked: range(c.nb).map(() => 0),
    lost: range(c.nb).map(() => 0),
    fpx: range(c.nb).map(() => 0),
    wiped: range(c.nb).map(() => 0),
    jobs: [],
    cj: [],
    obj: [],
    L: range(c.nt).map(() => ({
      li: 1, dn: 0, fi: [], wm: range(c.ns).map(() => [0, 0]), lg: range(c.ns).map(() => 0), ex: [],
      h: [], o0: 0, sg: [], dr: null, pl: null, b: freshSnap(c.ns), tb: [], nC: 0, nE: 0, nL: 0, ru: 0,
      st: 0, mx: c.startSteps && c.baseFirst ? 1 : 0,
    })),
    q: idleQ(),
    nSL: 0,
    nQ: 0,
    cN: 0,
    sw: null,
    nSw: 0,
  }
}

/** Deep copy. Committed `Entry`s, tombstone pairs and the base snapshot are never mutated, so they are shared. */
function cp(s: St): St {
  const aa = (a: number[][]) => a.map((x) => x.slice())
  return {
    sh: s.sh.map((r) => r.map((x) => ({ i: x.i, w: x.w.slice(), se: x.se, re: x.re, di: x.di, fg: x.fg, bo: x.bo.slice(), rg: x.rg }))),
    incN: aa(s.incN), sent: s.sent.slice(), acked: s.acked.slice(), lost: s.lost.slice(), fpx: s.fpx.slice(), wiped: s.wiped.slice(),
    jobs: s.jobs.map((j) => ({ id: j.id, s: j.s, t: j.t, i: j.i, lo: j.lo, hi: j.hi, ph: j.ph, f: j.f })),
    cj: s.cj.map((j) => ({ id: j.id, t: j.t, ins: j.ins, out: j.out, ph: j.ph })),
    obj: aa(s.obj),
    L: s.L.map((L) => ({
      li: L.li, dn: L.dn, fi: L.fi, wm: aa(L.wm), lg: L.lg.slice(), ex: L.ex, h: L.h.slice(), o0: L.o0, sg: L.sg.slice(),
      dr: L.dr, pl: L.pl, b: L.b, tb: L.tb, nC: L.nC, nE: L.nE, nL: L.nL, ru: L.ru, st: L.st, mx: L.mx,
    })),
    q: { st: s.q.st, t: s.q.t, fi: s.q.fi, wm: s.q.wm, nd: s.q.nd, tl: s.q.tl, mu: s.q.mu, ex: s.q.ex, ln: s.q.ln.slice(), rs: s.q.rs, dup: s.q.dup, miss: s.q.miss, leak: s.q.leak },
    nSL: s.nSL, nQ: s.nQ, cN: s.cN,
    sw: s.sw ? { t: s.sw.t, ph: s.sw.ph, ls: s.sw.ls, dm: s.sw.dm, rd: s.sw.rd } : null,
    nSw: s.nSw,
  }
}

/** The ledger serves nothing: its rebuild refused, or (startSteps) a new incarnation is starting. */
function off(L: Led): boolean {
  return L.dn === 1 || L.st > 0
}

function segLo(x: Strm, hi: number): number {
  let lo = x.di
  for (const b of x.bo) if (b < hi && b > lo) lo = b
  return lo + 1
}

function wmOf(m: number[][], s: number, inc: number): number {
  const w = m[s]!
  return w[0] === inc ? w[1]! : 0
}

/** Apply one change to a snapshot (ledger.ts `apply` without its checks). */
function applyEntry(sn: Snap, e: Entry): Snap {
  const [add, rem, wm, exp] = e
  const fi = sortU([...sn.fi.filter((f) => !has(rem, f)), ...add])
  const w = sn.wm.map((x) => [...x])
  if (wm) w[wm[0]!] = [wm[1]!, wm[2]!]
  return { fi, wm: w, ex: exp.length ? sortU([...sn.ex, ...exp]) : sn.ex, tb: sn.tb }
}

/** The R2 log of the current incarnation in key order. */
function segsInKeyOrder(L: Led): number[][] {
  return [...L.sg].sort(cmpArr)
}

/** Is anything of this incarnation in R2? As built the base is written before anything commits. */
function baseInR2(c: Cfg, L: Led): boolean {
  return c.baseFirst || L.sg.length > 0
}

/**
 * Replay the R2 log: base, then the segments in key order. `strict` refuses anything but the
 * next version (ledger.ts replay); otherwise versions already applied are skipped. A gap is
 * always refused. Returns the state replayed so far and whether the replay refused.
 */
function replay(L: Led, strict: boolean): { sn: Snap; upTo: number; refused: boolean; removed: number[] } {
  let sn: Snap = { fi: [...L.b.fi], wm: L.b.wm.map((x) => [...x]), ex: [...L.b.ex], tb: L.b.tb }
  let next = 0
  const removed: number[] = []
  for (const [lo, hi] of segsInKeyOrder(L)) {
    if (lo! > next) return { sn, upTo: next, refused: true, removed }
    if (lo! < next && strict) return { sn, upTo: next, refused: true, removed }
    for (let k = Math.max(lo!, next); k <= hi!; k++) {
      sn = applyEntry(sn, L.h[k]!)
      removed.push(...L.h[k]![1])
    }
    next = Math.max(next, hi! + 1)
  }
  return { sn, upTo: next, refused: false, removed }
}

/** Watermark per shard that survives the loss of the ledger's storage (skip semantics). */
function durableWm(L: Led): number[][] {
  return replay(L, false).sn.wm
}

function commit(L: Led, e: Entry): void {
  L.h.push(e)
}

function live(L: Led, f: number): boolean {
  return has(L.fi, f)
}
function liveKey(L: Led, key: number): boolean {
  return L.fi.some((f) => FILES[f]!.key === key)
}
function readable(s: St, f: number): boolean {
  const k = FILES[f]!.key
  return s.obj.some((o) => o[0] === k && o[1] === f)
}

function r2put(c: Cfg, s: St, f: number, uploader: number): void {
  const k = FILES[f]!.key
  const i = s.obj.findIndex((o) => o[0] === k)
  if (i >= 0) {
    if (c.keying === 'overwrite' && !FILES[f]!.comp) s.obj[i] = [k, f, uploader]
    // otherwise If-None-Match: * refuses; flush.ts / compact.ts accept an identical object as written
    return
  }
  s.obj.push([k, f, uploader])
  s.obj.sort(cmpArr)
}

function r2delete(s: St, key: number): void {
  s.obj = s.obj.filter((o) => o[0] !== key)
}

function endJob(s: St, id: number): void {
  for (const o of s.obj) if (o[2] === id) o[2] = -1
}

function freeId(s: St): number {
  const used = new Set([...s.jobs.map((j) => j.id), ...s.cj.map((j) => j.id)])
  let i = 0
  while (used.has(i)) i++
  return i
}

function flushFile(c: Cfg, t: number, rows: number[], v: number, sh: number, inc: number, lo: number, hi: number): number {
  const key = c.keying === 'content' ? `F${rows.join('.')}#${v}` : `F${t}/${sh}/${inc}/${lo}-${hi}`
  return fileId(t, rows, false, v, key, `L0(s${sh} inc${inc} ${lo}..${hi}${c.variants > 1 ? ` v${v}` : ''})`)
}

function compFile(c: Cfg, t: number, ins: number[], jobId: number): number {
  const rows = sortU(ins.flatMap((f) => FILES[f]!.rows))
  const key = `C${ins.join('.')}${c.compKey === 'unique' ? `@${jobId}` : ''}`
  return fileId(t, rows, true, 1, key, `L1(${ins.map((f) => FILES[f]!.name).join('+')}${c.compKey === 'unique' ? ` step${jobId - 100}` : ''})`, ins)
}

function inFlightPlan(s: St, t: number, key: number): boolean {
  return s.q.st === 1 && s.q.t === t && s.q.fi.some((f) => FILES[f]!.key === key)
}

function batchesOfRows(rows: number[]): number[] {
  return rows.map((r) => ROWS[r]![4]!)
}

function plan(c: Cfg, s: St, t: number, keep: Q | null): Q {
  const L = s.L[t]!
  const nd =
    c.query === 'impl'
      ? range(c.ns) // every shard of the tenant's pool, and every registered stream
      : range(c.ns).filter((x) => L.wm[x]![0] !== 0)
  return {
    st: 1, t, fi: [...L.fi], wm: L.wm.map((x) => [...x]), nd, tl: [],
    mu: range(c.nb).filter((b) => T(c, b) === t && s.acked[b]),
    ex: sortU([...batchesOfRows(L.ex), ...range(c.nb).filter((b) => s.lost[b])]),
    ln: keep ? keep.ln : range(c.ns).map(() => 0),
    rs: keep ? (c.liveness ? 0 : keep.rs + 1) : 0, dup: 0, miss: 0, leak: 0,
  }
}

/** Mark rows of a stream that a shard storage loss destroys before the ledger has logged them. */
function exemptOnLoss(s: St, sh: number, t: number): void {
  const x = s.sh[sh]![t]!
  if (x.i === 0) return
  const safe = wmOf(durableWm(s.L[t]!), sh, x.i)
  for (let q = Math.max(x.di, safe) + 1; q <= x.w.length; q++) {
    s.lost[x.w[q - 1]!] = 1
    // a query in flight is exempt from returning it even if the client re-sends it later
    if (s.q.st === 1 && s.q.t === t) s.q.ex = sortU([...s.q.ex, x.w[q - 1]!])
  }
  for (let q = x.fg + 1; q <= x.w.length; q++) s.wiped[x.w[q - 1]!] = 1
}

// ------------------------------------------------------------------ actions

export type Emit = (label: string, next: St) => void

export function successors(c: Cfg, s: St, emit: Emit): void {
  // ------------------------------------------------ client + Shard.append
  for (let b = 0; b < c.nb; b++) {
    const n = s.sent[b]!
    if (n >= c.maxSend) continue
    if (n === 0 && b > 0 && s.sent[b - 1] === 0) continue // symmetry: first sends in batch order
    if (n > 0 && c.fpHorizon && s.fpx[b]) continue
    if (n > 0 && c.noRetryAcrossLoss && s.wiped[b]) continue
    const t = T(c, b)
    const sh = R(c, b)
    const x0 = s.sh[sh]![t]!
    if (c.reg !== 'impl' && !(x0.i > 0 && x0.rg)) continue // the stream must have registered first
    const ns = cp(s)
    const x = ns.sh[sh]![t]!
    if (x.i === 0) {
      // shard.ts stream(): a new incarnation on first use or after storage loss
      ns.incN[sh]![t]! += 1
      x.i = ns.incN[sh]![t]!
    }
    let held = false
    if (c.dedup) {
      const streams = c.fpScope === 'stream' ? [x] : ns.sh[sh]!
      held = streams.some((y) => y.w.some((bb, i) => i + 1 > y.fg && FP(c, bb) === FP(c, b)))
    }
    if (!held) {
      x.w.push(b)
      ns.lost[b] = 0
    }
    ns.sent[b] = n + 1
    ns.acked[b] = 1
    emit(`append(b${b}${c.nt > 1 ? ` t${t}` : ''} -> s${sh})${held ? '=duplicate' : ` seq ${x.w.length}`}${n > 0 ? ' [retry]' : ''}`, ns)
  }

  for (let sh = 0; sh < c.ns; sh++) {
    for (let t = 0; t < c.nt; t++) {
      const x = s.sh[sh]![t]!
      const L = s.L[t]!
      const tag = `s${sh}${c.nt > 1 ? ` t${t}` : ''}`
      // ------------------------------------------ design handshake: registerStream before writes
      // the shard registers when a write for the stream arrives, or (fix F6) when a query asks for it
      const wanted = range(c.nb).some((b) => T(c, b) === t && R(c, b) === sh && s.sent[b]! < c.maxSend) ||
        (c.unknownStream === 'refuse' && s.q.st === 1 && s.q.t === t && has(s.q.nd, sh))
      if (c.reg !== 'impl' && x.i === 0 && !off(L) && wanted) {
        const ns = cp(s)
        const y = ns.sh[sh]![t]!
        ns.incN[sh]![t]! += 1
        y.i = ns.incN[sh]![t]!
        regCommit(ns.L[t]!, sh, y.i)
        if (c.reg === 'design') y.rg = 1 // answered after the commit
        emit(`registerStream(${tag}, inc ${y.i})`, ns)
      }
      if (c.reg === 'logged' && x.i > 0 && !x.rg && !off(L) && durableWm(L)[sh]![0] === x.i) {
        const ns = cp(s)
        ns.sh[sh]![t]!.rg = 1
        emit(`registration logged -> ${tag} accepts writes`, ns)
      }
      if (c.reg === 'logged' && x.i > 0 && !off(L) && L.wm[sh]![0]! < x.i) {
        // fix F1: the shard repeats its (idempotent) registration when the ledger does not know it
        const ns = cp(s)
        regCommit(ns.L[t]!, sh, x.i)
        emit(`reRegister(${tag}, inc ${x.i})`, ns)
      }
      // fix F6, as built (lazy registration): a tail read naming an incarnation the shard no
      // longer holds makes the shard create the stream and register it, so the next plan names it
      if (c.unknownStream === 'refuse' && c.f6Register && c.reg === 'impl' && x.i === 0 && !off(L) &&
        s.q.st === 1 && s.q.t === t && has(s.q.nd, sh) && s.q.wm[sh]![0] !== 0) {
        const ns = cp(s)
        const y = ns.sh[sh]![t]!
        ns.incN[sh]![t]! += 1
        y.i = ns.incN[sh]![t]!
        regCommit(ns.L[t]!, sh, y.i)
        emit(`shard recreates stream (${tag}, inc ${y.i}) and registers it`, ns)
      }
      if (x.i === 0) continue
      // ------------------------------------------ Shard.seal
      if (x.w.length > x.se) {
        const ns = cp(s)
        const y = ns.sh[sh]![t]!
        y.se = y.w.length
        y.bo = sortU([...y.bo, y.se])
        emit(`seal(${tag}, ..${y.se})`, ns)
      }
      // ------------------------------------------ Shard.recorded(inc, loggedWatermarks()) — flush step 5-6, or the sweep
      if (!off(L)) {
        const w = c.recAt === 'logged' ? (L.wm[sh]![0] === x.i ? L.lg[sh]! : 0) : wmOf(L.wm, sh, x.i)
        if (w > x.re && has(x.bo, w) && w <= x.se) {
          const ns = cp(s)
          ns.sh[sh]![t]!.re = w
          emit(`recorded(${tag}, ..${w})`, ns)
        }
      }
      // ------------------------------------------ Shard.alarm step 2: discard through a recorded boundary
      for (const h of x.bo) {
        if (h > x.re) continue
        if (c.retain && s.q.st === 1 && s.q.t === t && has(s.q.nd, sh) && wmOf(s.q.wm, sh, x.i) < h) continue
        const ns = cp(s)
        const y = ns.sh[sh]![t]!
        y.di = h
        y.bo = y.bo.filter((v) => v > h)
        emit(`discard(${tag}, ..${h})`, ns)
      }
      // ------------------------------------------ Shard.alarm step 3: forget fingerprints of discarded batches
      if (x.fg < x.di) {
        const ns = cp(s)
        const y = ns.sh[sh]![t]!
        for (let q = y.fg + 1; q <= y.di; q++) ns.fpx[y.w[q - 1]!] = 1
        y.fg = y.di
        emit(`fingerprintsExpire(${tag}, ..${y.di})`, ns)
      }
      // ------------------------------------------ flush step 0: pendingSegments() lists a sealed, unrecorded segment
      if (s.jobs.length < c.maxJobs) {
        for (const h of x.bo) {
          if (h <= x.re) continue
          const lo = segLo(x, h)
          const ns = cp(s)
          ns.jobs.push({ id: freeId(s), s: sh, t, i: x.i, lo, hi: h, ph: 0, f: -1 })
          ns.jobs.sort((a, b) => a.id - b.id)
          emit(`flush: pendingSegments(${tag}) -> inc ${x.i} ${lo}..${h}`, ns)
        }
      }
    }
    // ---------------------------------------------- shard storage loss: every stream of the shard
    if (s.nSL < c.maxSL && s.sh[sh]!.some((x) => x.i > 0)) {
      const ns = cp(s)
      for (let t = 0; t < c.nt; t++) {
        exemptOnLoss(ns, sh, t)
        ns.sh[sh]![t] = freshStrm()
      }
      ns.nSL++
      emit(`SHARD STORAGE LOSS(s${sh})`, ns)
    }
  }

  // ------------------------------------------------ flush Worker steps
  for (let ji = 0; ji < s.jobs.length; ji++) {
    const j = s.jobs[ji]!
    const tag = `s${j.s}${c.nt > 1 ? ` t${j.t}` : ''} inc ${j.i} ${j.lo}..${j.hi}`
    const L = s.L[j.t]!
    // crash between any two steps
    {
      const ns = cp(s)
      ns.jobs.splice(ji, 1)
      endJob(ns, j.id)
      emit(`flush crash (${tag})`, ns)
    }
    if (j.ph === 0) {
      // readSegment + encode
      const x = s.sh[j.s]![j.t]!
      let rows: number[] | null = null
      if (c.readBound) {
        if (x.i === j.i && j.lo > x.di && (has(x.bo, j.hi) || false) && segLo(x, j.hi) === j.lo) {
          rows = range(j.hi - j.lo + 1).map((k) => rowId(j.s, j.t, j.i, j.lo + k, x.w[j.lo + k - 1]!))
        }
      } else if (x.i > 0) {
        // shard.ts readSegment(tenant, seqLo): the CURRENT stream's segment starting at seqLo, whatever its incarnation
        const seg = x.bo.find((h) => segLo(x, h) === j.lo)
        if (seg !== undefined && j.lo > x.di && seg - j.lo === j.hi - j.lo) {
          // flush.ts complete-check passes (same count, consecutive seqs); the unit is labelled with the LISTED incarnation
          rows = range(j.hi - j.lo + 1).map((k) => rowId(j.s, j.t, j.i, j.lo + k, x.w[j.lo + k - 1]!))
        }
      }
      if (rows === null) {
        const ns = cp(s)
        ns.jobs.splice(ji, 1)
        endJob(ns, j.id)
        emit(`flush readSegment(${tag}) -> segment gone, stop`, ns)
      } else {
        for (let v = 1; v <= c.variants; v++) {
          const ns = cp(s)
          const nj = ns.jobs[ji]!
          nj.ph = 1
          nj.f = flushFile(c, j.t, rows, v, j.s, j.i, j.lo, j.hi)
          const mixed = x.i !== j.i
          emit(`flush readSegment(${tag})${mixed ? ` [rows of inc ${x.i}]` : ''}${c.variants > 1 ? ` encode v${v}` : ''}`, ns)
        }
      }
    }
    if (j.ph === 1) {
      const ns = cp(s)
      r2put(c, ns, j.f, j.id)
      ns.jobs[ji]!.ph = 2
      emit(`flush PUT ${FILES[j.f]!.name}`, ns)
    }
    if ((j.ph === 2 || j.ph === 4) && !off(L)) {
      // ledger.addUnit (ledger.ts), as flush.ts report() handles its answers
      const ns = cp(s)
      const nL = ns.L[j.t]!
      const known = nL.wm[j.s]![0]!
      const w = nL.wm[j.s]![1]!
      let label: string
      let done = true
      if (known === 0) {
        if (j.lo === 1) {
          regCommitNoEntry(nL, j.s, j.i)
          admit(nL, j)
          label = `addUnit(${tag}) admitted (registers the stream)`
        } else label = `addUnit(${tag}) = not_contiguous`
      } else if (known !== j.i) {
        if (known < j.i && j.ph === 2 && c.reg === 'impl') {
          done = false
          ns.jobs[ji]!.ph = 3
          label = `addUnit(${tag}) = incarnation_mismatch(${known})`
        } else label = `addUnit(${tag}) = incarnation_mismatch(${known}), stop`
      } else if (j.hi <= w) label = `addUnit(${tag}) = ok (replay, no change)`
      else if (j.lo !== w + 1 && !(c.contiguous === false && j.lo > w)) label = `addUnit(${tag}) = not_contiguous(${w})`
      else if (liveKey(nL, FILES[j.f]!.key)) label = `addUnit(${tag}) = invalid (key live)`
      else {
        admit(nL, j)
        label = `addUnit(${tag}) admitted`
      }
      if (done) {
        ns.jobs.splice(ji, 1)
        endJob(ns, j.id)
      }
      emit(label, ns)
    }
    if (j.ph === 3 && !off(L)) {
      // flush.ts: the shard was recreated -> registerStream(its incarnation), then addUnit once more
      const ns = cp(s)
      const nL = ns.L[j.t]!
      if (nL.wm[j.s]![0]! < j.i) regCommit(nL, j.s, j.i)
      if (nL.wm[j.s]![0]! > j.i) {
        ns.jobs.splice(ji, 1)
        endJob(ns, j.id)
        emit(`flush registerStream(s${j.s}, inc ${j.i}) refused (lower), stop`, ns)
      } else {
        ns.jobs[ji]!.ph = 4
        emit(`flush registerStream(s${j.s}${c.nt > 1 ? ` t${j.t}` : ''}, inc ${j.i})`, ns)
      }
    }
  }

  // ------------------------------------------------ ledger per tenant: log, loss, compaction, retention, deletion
  for (let t = 0; t < c.nt; t++) {
    const L = s.L[t]!
    const tt = c.nt > 1 ? ` t${t}` : ''
    if (L.dn) continue
    const steps = c.startSteps && c.baseFirst
    if (L.st > 0) {
      // ledger.ts startIncarnation, as two steps: the base segment is PUT (If-None-Match) BEFORE
      // SQLite commits the incarnation, and every request waits in gate() until the commit.
      const ns = cp(s)
      const nL = ns.L[t]!
      if (L.st === 1) {
        if (nL.li <= nL.mx) nL.ru = 1 // a base for a number R2 already has: the number is reused
        nL.mx = Math.max(nL.mx, nL.li)
        nL.st = 2
        emit(`ledger${tt} start: PUT base segment of incarnation ${nL.li}`, ns)
      } else {
        nL.st = 0
        emit(`ledger${tt} start: commit incarnation ${nL.li}, serve`, ns)
      }
    }
    // drain step 1: PUT the pending changes to R2 (one object per change, or one segment)
    if (!L.dr && L.o0 < L.h.length) {
      let lo = L.o0
      let hi = c.log === 'perChange' ? L.o0 : L.h.length - 1
      if (c.drainRetrySame && L.pl) [lo, hi] = [L.pl[0]!, L.pl[1]!]
      const ns = cp(s)
      const nL = ns.L[t]!
      if (!nL.sg.some((g) => g[0] === lo && g[1] === hi)) nL.sg.push([lo, hi]) // If-None-Match: same key = same bytes
      nL.sg.sort(cmpArr)
      nL.dr = [lo, hi]
      if (c.drainRetrySame) nL.pl = [lo, hi]
      emit(`ledger${tt} drain: PUT ${c.log === 'perChange' ? 'change' : 'segment'} v${lo + 1}..v${hi + 1}`, ns)
    }
    if (L.dr) {
      // drain step 2: in one transaction delete those outbox rows and advance `logged`
      const ns = cp(s)
      const nL = ns.L[t]!
      const [lo, hi] = nL.dr as [number, number]
      for (let k = lo; k <= hi; k++) {
        const w = nL.h[k]![2]
        if (w && nL.wm[w[0]!]![0] === w[1]) nL.lg[w[0]!] = Math.max(nL.lg[w[0]!]!, w[2]!)
      }
      nL.o0 = Math.max(nL.o0, hi + 1)
      nL.dr = null
      nL.pl = null
      emit(`ledger${tt} drain: delete outbox rows v${lo + 1}..v${hi + 1}, advance logged`, ns)
      // the isolate dies (or the PUT's answer is lost) before that transaction
      const ns2 = cp(s)
      ns2.L[t]!.dr = null
      emit(`ledger${tt} drain crash after PUT`, ns2)
    }
    // ledger storage loss + rebuild from R2 (new ledger incarnation). With startSteps a loss
    // before the new base is PUT changes nothing (the storage held nothing yet), so it is skipped.
    if (L.nL < c.maxLL && L.st !== 1) {
      const ns = cp(s)
      const nL = ns.L[t]!
      const r = replay(nL, c.rebuild === 'strict')
      const inR2 = baseInR2(c, nL)
      const sn = inR2 ? r.sn : { fi: [...nL.b.fi], wm: nL.b.wm.map((x) => [...x]), ex: [...nL.b.ex], tb: nL.b.tb }
      // as built: max(newest incarnation in R2, the storage's own) + 1; the lost storage has none
      // planned log without base-first: R2's newest incarnation is the previous one
      const newLi = steps ? nL.mx + 1 : inR2 ? nL.li + 1 : nL.li
      const tomb = sortU([...(c.baseTombstones ? nL.b.tb : []), ...(inR2 ? r.removed : [])]).filter((f) => !has(sn.fi, f))
      Object.assign(nL, {
        li: newLi, dn: r.refused && inR2 ? 1 : 0, fi: sn.fi, wm: sn.wm, lg: sn.wm.map((w) => w[1]), ex: sn.ex,
        h: [], o0: 0, sg: [], dr: null, pl: null, b: { fi: [...sn.fi], wm: sn.wm.map((x) => [...x]), ex: [...sn.ex], tb: c.baseTombstones ? tomb : [] },
        tb: tomb.map((f) => [f, -1]), nL: nL.nL + 1, ru: nL.ru || (!inR2 && nL.h.length > 0 ? 1 : 0), st: steps && !(r.refused && inR2) ? 1 : 0,
      })
      emit(`LEDGER${tt} STORAGE LOSS -> rebuild from R2${r.refused && inR2 ? ' REFUSED (log not contiguous)' : ''}${inR2 ? '' : ' (nothing of this incarnation in R2: incarnation number reused)'}${steps ? `, start incarnation ${newLi}` : ''}`, ns)
    }
    if (L.st > 0) continue // nothing else is served while an incarnation starts
    // compaction step: plan, GET two live inputs, merge
    if (s.cj.length < c.maxCJobs && L.nC < c.maxComp && (c.compKey !== 'unique' || s.cN < c.maxCSteps)) {
      for (let a = 0; a < L.fi.length; a++) {
        for (let b = a + 1; b < L.fi.length; b++) {
          const ins = [L.fi[a]!, L.fi[b]!]
          if (!ins.every((f) => readable(s, f))) continue
          const ns = cp(s)
          // a step-unique key takes a fresh id that no earlier step had; otherwise ids are reused
          const id = c.compKey === 'unique' ? 100 + ns.cN++ : freeId(s)
          const out = compFile(c, t, ins, id)
          ns.cj.push({ id, t, ins, out, ph: 0 })
          ns.cj.sort((x, y) => x.id - y.id)
          emit(`compact${tt}: read ${FILES[ins[0]!]!.name} + ${FILES[ins[1]!]!.name}`, ns)
        }
      }
    }
    // retention: ledger.expire removes one whole file
    if (L.nE < c.maxExp) {
      for (const f of L.fi) {
        const ns = cp(s)
        const nL = ns.L[t]!
        nL.fi = without(nL.fi, f)
        bury(nL, [f])
        nL.ex = sortU([...nL.ex, ...FILES[f]!.rows])
        commit(nL, [[], [f], null, FILES[f]!.rows])
        nL.nE++
        emit(`expire${tt} ${FILES[f]!.name}`, ns)
      }
    }
    // janitor purgeTenant: ledger.deletable (removal logged, grace passed, not live) -> R2 delete -> forget
    for (const [f, k, d] of L.tb) {
      if (live(L, f!)) continue
      if (c.purgeSteps && d === 1) {
        // forget(keys), after the delete returned (a later purge run deletes again first)
        const ns = cp(s)
        ns.L[t]!.tb = ns.L[t]!.tb.filter((x) => x[0] !== f)
        emit(`purge${tt}: forget ${FILES[f!]!.name}`, ns)
      }
      if (c.delLogged && !(k! < L.o0)) continue // k = -1 (replayed) counts as logged
      if (c.delGrace && inFlightPlan(s, t, FILES[f!]!.key)) continue
      if (c.purgeSteps) {
        if (d === 1 && !s.obj.some((o) => o[0] === FILES[f!]!.key)) continue // deleting again changes nothing
        const ns = cp(s)
        r2delete(ns, FILES[f!]!.key)
        ns.L[t]!.tb = ns.L[t]!.tb.map((x) => (x[0] === f ? [f!, k!, 1] : x))
        emit(`purge${tt}: delete ${FILES[f!]!.name}`, ns)
        continue
      }
      const ns = cp(s)
      r2delete(ns, FILES[f!]!.key)
      ns.L[t]!.tb = ns.L[t]!.tb.filter((x) => x[0] !== f)
      emit(`purge${tt}: delete ${FILES[f!]!.name}`, ns)
    }
  }

  // ------------------------------------------------ compaction steps in flight (compact.ts)
  for (let ci = 0; ci < s.cj.length; ci++) {
    const cj = s.cj[ci]!
    const L = s.L[cj.t]!
    const name = FILES[cj.out]!.name
    {
      const ns = cp(s)
      ns.cj.splice(ci, 1)
      endJob(ns, cj.id)
      emit(`compact crash (${name})`, ns)
    }
    if (cj.ph === 0) {
      const ns = cp(s)
      r2put(c, ns, cj.out, cj.id)
      ns.cj[ci]!.ph = 1
      emit(`compact PUT ${name}`, ns)
    }
    if (cj.ph === 1 && !off(L)) {
      const ns = cp(s)
      const nL = ns.L[cj.t]!
      const missing = cj.ins.filter((f) => !live(nL, f))
      let label: string
      if (live(nL, cj.out) && missing.length === cj.ins.length) label = `replace(${name}) = ok (replay)`
      else if (missing.length > 0 && c.replaceLive) {
        label = `replace(${name}) = conflict`
        // compact.ts: delete the outputs unless orphanCheck says one is live or tombstoned
        const k = FILES[cj.out]!.key
        if (c.compConflictDelete && !liveKey(nL, k) && !nL.tb.some((x) => FILES[x[0]!]!.key === k)) {
          r2delete(ns, FILES[cj.out]!.key)
          label += ', output deleted'
        }
      } else if (liveKey(nL, FILES[cj.out]!.key)) label = `replace(${name}) = invalid`
      else {
        const rem = cj.ins.filter((f) => live(nL, f))
        nL.fi = sortU([...nL.fi.filter((f) => !has(rem, f)), cj.out])
        bury(nL, rem)
        commit(nL, [[cj.out], rem, null, []])
        nL.nC++
        label = `replace(${name}) committed`
      }
      ns.cj.splice(ci, 1)
      endJob(ns, cj.id)
      emit(label, ns)
    }
  }

  // ------------------------------------------------ orphan sweeper
  if (c.sweep !== 'off' && !c.sweepSteps) {
    // one object at a time, the listing, the ledger read and the delete in one atomic step
    for (const [k, f, up] of s.obj) {
      const L = s.L[FILES[f!]!.t]!
      if (off(L)) continue
      if (!doomed(c, L, k!, f!, up === -1, (key) => s.obj.some((o) => o[0] === key))) continue
      const ns = cp(s)
      r2delete(ns, k!)
      emit(`orphan sweep: delete ${FILES[f!]!.name}`, ns)
    }
  }
  if (c.sweep !== 'off' && c.sweepSteps) {
    // janitor.ts sweepOrphans: 1. list the tenant's prefix (keys, metadata, upload time);
    // 2. ONE ledger read (orphanCheck) about the listed keys and the inputs absent from the
    // listing; 3. delete the doomed keys. Separate steps; the run can stop at any point.
    const w = s.sw
    // the age flag matters only to a rule with an age floor; elsewhere it is not state
    const aged = c.sweep === 'impl' || c.sweepAge
    const listing = (t: number) => s.obj.filter((o) => FILES[o[1]!]!.t === t).map((o) => [o[0]!, o[1]!, !aged || o[2] === -1 ? 1 : 0])
    const judge = (L: Pick<Led, 'fi' | 'tb' | 'wm' | 'lg'>, ls: number[][]) =>
      ls.filter((x) => doomed(c, L as Led, x[0]!, x[1]!, x[2] === 1, (key) => ls.some((y) => y[0] === key))).map((x) => x[1]!)
    if (!w && s.nSw < c.maxSweeps) {
      for (let t = 0; t < c.nt; t++) {
        if (c.sweepOrder === 'readFirst') {
          // the (wrong) other order: one ledger read, then the listing, judged together
          const L = s.L[t]!
          if (off(L) || !s.obj.some((o) => FILES[o[1]!]!.t === t)) continue
          const ns = cp(s)
          ns.sw = { t, ph: 2, ls: [], dm: [], rd: { fi: L.fi, tb: L.tb, wm: L.wm.map((x) => [...x]), lg: L.lg.slice() } }
          if (c.maxSweeps < 99) ns.nSw++ // 99 = unbounded: not counted, so not state
          emit(`orphan sweep${c.nt > 1 ? ` t${t}` : ''}: orphanCheck first`, ns)
          continue
        }
        const ls = listing(t)
        if (ls.length === 0) continue
        const ns = cp(s)
        ns.sw = { t, ph: 0, ls, dm: [], rd: null }
        if (c.maxSweeps < 99) ns.nSw++ // 99 = unbounded: not counted, so not state
        emit(`orphan sweep${c.nt > 1 ? ` t${t}` : ''}: list ${ls.map((x) => FILES[x[1]!]!.name).join(', ')}`, ns)
      }
    } else if (w) {
      {
        const ns = cp(s)
        ns.sw = null
        emit('orphan sweep: stops', ns)
      }
      const L = s.L[w.t]!
      if (w.ph === 0 && !off(L)) {
        const dm = judge(L, w.ls)
        const ns = cp(s)
        ns.sw = dm.length ? { t: w.t, ph: 1, ls: [], dm, rd: null } : null
        emit(`orphan sweep: orphanCheck -> ${dm.length ? `doomed ${dm.map((f) => FILES[f]!.name).join(', ')}` : 'nothing to delete'}`, ns)
      }
      if (w.ph === 2) {
        const dm = judge(w.rd!, listing(w.t))
        const ns = cp(s)
        ns.sw = dm.length ? { t: w.t, ph: 1, ls: [], dm, rd: null } : null
        emit(`orphan sweep: list -> ${dm.length ? `doomed ${dm.map((f) => FILES[f]!.name).join(', ')}` : 'nothing to delete'}`, ns)
      }
      if (w.ph === 1) {
        for (const f of w.dm) {
          const ns = cp(s)
          r2delete(ns, FILES[f]!.key)
          const dm = without(w.dm, f)
          ns.sw = dm.length ? { t: w.t, ph: 1, ls: [], dm, rd: null } : null
          emit(`orphan sweep: delete ${FILES[f]!.name}`, ns)
        }
      }
    }
  }

  // ------------------------------------------------ query (coordinator.ts gather / readTail)
  if (s.q.st !== 1 && s.nQ < c.maxQ) {
    for (let t = 0; t < c.nt; t++) {
      if (off(s.L[t]!)) continue
      const ns = cp(s)
      ns.q = plan(c, ns, t, null)
      ns.nQ++
      emit(`query${c.nt > 1 ? ` t${t}` : ''}: plan (${ns.q.fi.map((f) => FILES[f]!.name).join(', ') || 'no files'}; wm ${ns.q.wm.map((w, i) => `s${i}:${w[0] ? `inc${w[0]}@${w[1]}` : '-'}`).join(' ')})`, ns)
    }
  }
  if (s.q.st === 1) {
    const q = s.q
    const canRefuse = c.liveness || q.rs < c.maxRestarts
    for (const sh of q.nd) {
      const r = tailRead(c, s, q, sh)
      if (r.kind === 'ok') {
        const ns = cp(s)
        ns.q.nd = without(ns.q.nd, sh)
        ns.q.tl = sortU([...ns.q.tl, ...r.rows])
        if (r.learn) ns.q.ln[sh] = r.learn
        emit(`query: tailRead(s${sh}, ${r.what}) = ok ${r.rows.length ? r.rows.map((x) => `b${ROWS[x]![4]}`).join(',') : 'nothing'}`, ns)
      } else if (canRefuse && !off(s.L[q.t]!)) {
        const ns = cp(s)
        const keep = { ...ns.q, ln: [...ns.q.ln] }
        if (r.learn) keep.ln[sh] = r.learn
        ns.q = plan(c, ns, q.t, keep)
        emit(`query: tailRead(s${sh}, ${r.what}) = ${r.why} -> re-plan`, ns)
      }
    }
    if (q.nd.length === 0) {
      const unread = q.fi.filter((f) => !readable(s, f))
      if (unread.length > 0 && c.missingErr) {
        if (canRefuse && !off(s.L[q.t]!)) {
          const ns = cp(s)
          ns.q = plan(c, ns, q.t, { ...ns.q })
          emit(`query: ${FILES[unread[0]!]!.name} missing -> re-plan`, ns)
        }
      } else {
        const ns = cp(s)
        const rows = [...q.fi.filter((f) => readable(s, f)).flatMap((f) => FILES[f]!.rows), ...q.tl]
        const cnt = new Map<number, number>()
        for (const r of rows) cnt.set(ROWS[r]![4]!, (cnt.get(ROWS[r]![4]!) ?? 0) + 1)
        const exempt = (b: number) => s.lost[b] || has(q.ex, b) || has(batchesOfRows(s.L[q.t]!.ex), b)
        ns.q.st = 2
        ns.q.dup = [...cnt.values()].some((n) => n > 1) ? 1 : 0
        ns.q.miss = q.mu.some((b) => !exempt(b) && !cnt.has(b)) ? 1 : 0
        ns.q.leak = rows.some((r) => ROWS[r]![1] !== q.t) ? 1 : 0
        const got = [...cnt.entries()].map(([b, n]) => `b${b}${n > 1 ? `x${n}` : ''}`).join(',') || 'nothing'
        emit(`query: read files, merge -> ${got}${unread.length ? ` (${unread.map((f) => FILES[f]!.name).join(', ')} unreadable, read as empty)` : ''}`, ns)
      }
    }
  }
}

/**
 * The sweeper's verdict on one listed object (key `k`, listed bytes `f`), at one ledger read.
 * `old`: its uploader was no longer in flight when it was listed (the untimed age rule);
 * `present`: the key was in the listing.
 */
function doomed(c: Cfg, L: Led, k: number, f: number, old: boolean, present: (key: number) => boolean): boolean {
  const F = FILES[f]!
  if (liveKey(L, k)) return false
  if (c.sweep === 'any') return true
  if (c.sweep === 'spec') {
    // DESIGN §4.3: unreferenced AND its sequence range is below the stream's logged watermark
    return !F.comp && F.rows.every((r) => { const [sh, , inc, q] = ROWS[r]!; return L.wm[sh!]![0] === inc && q! <= L.lg[sh!]! })
  }
  if (L.tb.some((x) => FILES[x[0]!]!.key === k)) return false // tombstoned keys are purge's
  const [sh, , inc] = ROWS[F.rows[0]!]!
  const hi = Math.max(...F.rows.map((r) => ROWS[r]![3]!))
  if (c.sweep === 'inputs') {
    // janitor.ts sweepOrphans since D30. A compaction output is doomed when one of its inputs
    // (R2 metadata `viz-inputs`) is absent from the listing AND not live in this read. A flush
    // file is doomed when its stream's LOGGED watermark covers it, or the ledger's (committed)
    // incarnation of the stream is newer and has a logged watermark above 0 (F15 fix). The age
    // floor is kept only with `sweepAge` (the code keeps one; it is not what makes this safe).
    if (c.sweepAge && !old) return false
    if (F.comp) {
      return F.ins.some((i) => {
        const k = FILES[i]!.key
        return c.sweepGone === 'notLive' ? !liveKey(L, k) : c.sweepGone === 'absent' ? !present(k) : !present(k) && !liveKey(L, k)
      })
    }
    const w = L.wm[sh!]!
    return (w[0]! > inc! && (!c.sweepNewerLogged || L.lg[sh!]! > 0)) || (w[0] === inc && L.lg[sh!]! >= hi)
  }
  // 'impl', janitor.ts before D30: flush file dead by the LOGGED watermark (or a newer
  // incarnation); compaction output by age. Age is untimed here: the object's uploader is no
  // longer in flight (that is what the age rule establishes).
  if (!old) return false
  if (F.comp) return true
  // flushFileState: dead if the ledger has a newer incarnation of the stream (orphanCheck
  // reports the COMMITTED incarnation), or the same one logged past the range
  const newer = (c.sweepIncLogged ? durableWm(L)[sh!]![0]! : L.wm[sh!]![0]!) > inc!
  return newer || (L.wm[sh!]![0] === inc && L.lg[sh!]! >= hi)
}

type TailR = { kind: 'ok'; rows: number[]; what: string; learn: number } | { kind: 'refused'; why: string; what: string; learn: number }

/** coordinator.ts readTail + shard.ts tailRead, as one step per shard. */
function tailRead(c: Cfg, s: St, q: Q, sh: number): TailR {
  const w = q.wm[sh]!
  let inc = w[0]!
  let above = w[1]!
  const registered = inc !== 0
  if (c.query === 'impl' && q.ln[sh]! > inc) {
    inc = q.ln[sh]!
    above = 0
  }
  for (let call = 0; call < 2; call++) {
    const what = `inc ${inc}, above ${above}`
    const x = s.sh[sh]![q.t]!
    const r = shardTail(c, s, sh, q.t, inc, above)
    if (r.kind === 'ok') return { kind: 'ok', rows: r.rows, what, learn: inc !== w[0] ? inc : 0 }
    if (r.kind === 'stale') return { kind: 'refused', why: `stale_watermark(${x.di})`, what, learn: 0 }
    // incarnation_mismatch
    if (c.query === 'design') return { kind: 'refused', why: `incarnation_mismatch(${r.inc})`, what, learn: 0 }
    if (r.inc < inc) return { kind: 'refused', why: `incarnation_mismatch(${r.inc}) behind`, what, learn: 0 }
    if (registered) return { kind: 'refused', why: `incarnation_mismatch(${r.inc})`, what, learn: r.inc }
    inc = r.inc
    above = 0
  }
  return { kind: 'refused', why: 'changed twice', what: '', learn: 0 }
}

function shardTail(c: Cfg, s: St, sh: number, t: number, inc: number, above: number):
  { kind: 'ok'; rows: number[] } | { kind: 'stale' } | { kind: 'mismatch'; inc: number } {
  const x = s.sh[sh]![t]!
  // A caller that names no incarnation (the ledger never registered a stream here) is told
  // "nothing"; one that names an incarnation the shard no longer holds is refused (fix F6).
  if (x.i === 0) return c.unknownStream === 'empty' || inc === 0 ? { kind: 'ok', rows: [] } : { kind: 'mismatch', inc: 0 }
  if (x.i !== inc) return { kind: 'mismatch', inc: x.i }
  if (c.fence && above < x.di) return { kind: 'stale' }
  const from = Math.max(above, x.di) + 1
  const rows: number[] = []
  const streams = c.tailScope === 'stream' ? [t] : range(c.nt)
  for (const tt of streams) {
    const y = s.sh[sh]![tt]!
    const f = tt === t ? from : y.di + 1
    for (let q = f; q <= y.w.length; q++) rows.push(rowId(sh, tt, y.i, q, y.w[q - 1]!))
  }
  return { kind: 'ok', rows }
}

function regCommit(L: Led, sh: number, inc: number): void {
  L.wm[sh] = [inc, 0]
  L.lg[sh] = 0
  commit(L, [[], [], [sh, inc, 0], []])
}
function regCommitNoEntry(L: Led, sh: number, inc: number): void {
  // addUnit for an unknown stream registers it in the same transaction (ledger.ts register + record)
  regCommit(L, sh, inc)
}
function admit(L: Led, j: Job): void {
  L.fi = sortU([...L.fi, j.f])
  L.wm[j.s] = [j.i, j.hi]
  commit(L, [[j.f], [], [j.s, j.i, j.hi], []])
}
function bury(L: Led, fs: number[]): void {
  const k = L.h.length // index the removing change is about to get
  for (const f of fs) L.tb = [...L.tb.filter((x) => x[0] !== f), [f, k]].sort(cmpArr)
}

// ------------------------------------------------------------------ properties

export interface Prop {
  name: string
  holds: (c: Cfg, s: St) => boolean
}

function inShard(c: Cfg, s: St, b: number): boolean {
  const x = s.sh[R(c, b)]![T(c, b)]!
  return x.w.some((bb, i) => bb === b && i + 1 > x.di)
}
function inLedger(c: Cfg, s: St, b: number): boolean {
  const L = s.L[T(c, b)]!
  return L.fi.some((f) => readable(s, f) && FILES[f]!.rows.some((r) => ROWS[r]![4] === b))
}
function expiredB(c: Cfg, s: St, b: number): boolean {
  return s.L[T(c, b)]!.ex.some((r) => ROWS[r]![4] === b)
}

export const PROPS: Record<string, Prop> = {
  /** I1 + I2 (storage half): every acknowledged batch is in a shard payload or in a live, readable ledger file. */
  I1_AckedIsDurable: {
    name: 'I1_AckedIsDurable',
    holds: (c, s) => range(c.nb).every((b) => !s.acked[b] || s.lost[b] || expiredB(c, s, b) || inShard(c, s, b) || inLedger(c, s, b)),
  },
  /** Liveness proxy: no query attempt is refused (holds only under the `retain` timing assumption). */
  L2_NoRefusal: { name: 'L2_NoRefusal', holds: (_c, s) => s.q.rs === 0 },
  /** I3: a completed query returns no batch more often than once. */
  I3_NoDuplicates: { name: 'I3_NoDuplicates', holds: (_c, s) => !(s.q.st === 2 && s.q.dup) },
  /** I4 (+I2, query half): a completed query returns every batch acknowledged before its plan. */
  I4_NoGapAtSeam: { name: 'I4_NoGapAtSeam', holds: (_c, s) => !(s.q.st === 2 && s.q.miss) },
  /** I5: a shard has recorded / discarded only what the ledger has committed AND logged (what survives a rebuild). */
  I5_DiscardOnlyLogged: {
    name: 'I5_DiscardOnlyLogged',
    holds: (c, s) => range(c.ns).every((sh) => range(c.nt).every((t) => {
      const x = s.sh[sh]![t]!
      if (x.i === 0) return true
      const L = s.L[t]!
      return x.di <= x.re && x.re <= wmOf(durableWm(L), sh, x.i) && (L.dn || x.re <= wmOf(L.wm, sh, x.i))
    })),
  },
  /** I9/I10: no row removed by retention is live again. */
  I9_NoResurrection: {
    name: 'I9_NoResurrection',
    holds: (_c, s) => s.L.every((L) => L.fi.every((f) => !FILES[f]!.rows.some((r) => has(L.ex, r)))),
  },
  /** I11: every file the ledger lists exists in R2 with the bytes its metadata describes. */
  I11_LiveFilesReadable: { name: 'I11_LiveFilesReadable', holds: (_c, s) => s.L.every((L) => L.dn || L.fi.every((f) => readable(s, f))) },
  /** I20: a query of one tenant returns only that tenant's rows. */
  I20_TenantIsolation: { name: 'I20_TenantIsolation', holds: (_c, s) => !(s.q.st === 2 && s.q.leak) },
  /** LEDGER-LOG.md: segments of one incarnation never overlap and never leave a gap. */
  LOG_SegmentsDisjoint: {
    name: 'LOG_SegmentsDisjoint',
    holds: (_c, s) => s.L.every((L) => {
      const g = segsInKeyOrder(L)
      return g.every((x, i) => i === 0 || g[i - 1]![1]! < x[0]!)
    }),
  },
  /** A rebuild from R2 never refuses (the ledger stays available). */
  AV_RebuildSucceeds: { name: 'AV_RebuildSucceeds', holds: (_c, s) => s.L.every((L) => !L.dn) },
  /** §4.3: "a rebuilt ledger starts a new ledger incarnation, so versions are never reused". */
  V_IncarnationNotReused: { name: 'V_IncarnationNotReused', holds: (_c, s) => s.L.every((L) => !L.ru) },
}

export const SAFETY = ['I1_AckedIsDurable', 'I3_NoDuplicates', 'I4_NoGapAtSeam', 'I5_DiscardOnlyLogged', 'I9_NoResurrection',
  'I11_LiveFilesReadable', 'I20_TenantIsolation', 'LOG_SegmentsDisjoint', 'AV_RebuildSucceeds', 'V_IncarnationNotReused']

/** For the liveness check: the query has completed. */
export const queryDone = (s: St): boolean => s.q.st === 2

/**
 * For the no-leak check (I11, second half): every object in R2 is live in its tenant's ledger,
 * so nothing is left for purge or the orphan sweep. AG EF clean: from every reachable state
 * some continuation deletes (or makes live) every object nobody lists; a state from which none
 * does holds an object that is never deleted.
 */
export const clean = (s: St): boolean => s.obj.every((o) => liveKey(s.L[FILES[o[1]!]!.t]!, o[0]!))

/** As `clean`, for compaction outputs only (what D30 changed; flush files leak alike under both rules). */
export const cleanComp = (s: St): boolean => s.obj.every((o) => !FILES[o[1]!]!.comp || liveKey(s.L[FILES[o[1]!]!.t]!, o[0]!))

export const goalOf = (c: Cfg): ((s: St) => boolean) => (c.goal === 'clean' ? clean : c.goal === 'cleanComp' ? cleanComp : queryDone)

/** The objects of a state that no ledger lists, with what the sweeper would say about each now. */
export function orphans(c: Cfg, s: St): string[] {
  return s.obj.filter((o) => !liveKey(s.L[FILES[o[1]!]!.t]!, o[0]!)).map((o) => {
    const L = s.L[FILES[o[1]!]!.t]!
    const tomb = L.tb.some((x) => FILES[x[0]!]!.key === o[0])
    const d = doomed(c, L, o[0]!, o[1]!, true, (key) => s.obj.some((x) => x[0] === key))
    return `${FILES[o[1]!]!.name}${tomb ? ' (tombstoned)' : d ? ' (sweep would delete it)' : ' (sweep keeps it)'}`
  })
}
