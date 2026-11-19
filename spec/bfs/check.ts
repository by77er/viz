// Explicit-state, breadth-first model checker for model.ts.
//
// - Every reachable state within the bounds is enumerated (no sampling). States are
//   identified by a 64-bit fingerprint of their canonical JSON (two independent 32-bit
//   hashes), as TLC does; the probability that two distinct states share one is reported.
// - Breadth-first, single-threaded: the first violation found is at minimal depth, so every
//   counterexample is a shortest one in the model.
// - Traces are rebuilt by re-expanding from the initial state along the parent chain.
// - Liveness (`liveness: true` configs): the whole state graph is kept, and AG EF done is
//   checked: from every reachable state the query can still complete. In a finite graph,
//   AG EF done plus strong fairness of every transition implies that every run completes the
//   query; a reachable state from which `done` is unreachable is a run that refuses (or
//   waits) for ever under every schedule.
import { closeSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { type Cfg, type St, PROPS, init, successors, goalOf, orphans } from './model.ts'

/**
 * The breadth-first frontier lives on disk (one file per level), so memory holds only the
 * fingerprint table, the parent array and one read chunk: a run stays well under 1 GB.
 */
class LevelWriter {
  fd: number
  buf: string[] = []
  size = 0
  count = 0
  path: string
  constructor(path: string) {
    this.path = path
    this.fd = openSync(path, 'w')
  }
  add(id: number, str: string): void {
    this.buf.push(`${id}\t${str}`)
    this.size += str.length
    this.count++
    if (this.size > 1 << 22) this.flush()
  }
  flush(): void {
    if (this.buf.length) {
      // chunks are compressed (states are repetitive JSON): [length u32][deflate-raw]
      const z = deflateRawSync(Buffer.from(this.buf.join('\n') + '\n', 'latin1'), { level: 1 })
      const len = Buffer.alloc(4)
      len.writeUInt32LE(z.length)
      writeSync(this.fd, len)
      writeSync(this.fd, z)
    }
    this.buf = []
    this.size = 0
  }
  close(): void {
    this.flush()
    closeSync(this.fd)
  }
}

function* readLevel(path: string): Generator<[number, string]> {
  const fd = openSync(path, 'r')
  const len = Buffer.alloc(4)
  for (;;) {
    if (readSync(fd, len, 0, 4, null) < 4) break
    const n = len.readUInt32LE(0)
    const z = Buffer.alloc(n)
    let got = 0
    while (got < n) got += readSync(fd, z, got, n - got, null)
    const lines = inflateRawSync(z).toString('latin1').split('\n')
    lines.pop()
    for (const l of lines) {
      const tab = l.indexOf('\t')
      yield [Number(l.slice(0, tab)), l.slice(tab + 1)]
    }
  }
  closeSync(fd)
}

export interface Result {
  name: string
  props: string[]
  verdict: 'holds' | 'violated' | 'stopped'
  violated?: string
  trace?: string[]
  states: number
  transitions: number
  depth: number
  seconds: number
  collisionProb: number
  note?: string
}

// ------------------------------------------------------------------ fingerprints

function fp(str: string): [number, number] {
  let h1 = 0x811c9dc5 | 0
  let h2 = 0x9e3779b9 | 0
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 0x01000193)
    h2 = Math.imul(h2 ^ ch, 0x5bd1e995)
    h2 ^= h2 >>> 15
  }
  h1 ^= h1 >>> 16
  h1 = Math.imul(h1, 0x85ebca6b)
  h1 ^= h1 >>> 13
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0xc2b2ae35)
  h2 ^= h2 >>> 16
  return [h1 >>> 0, h2 >>> 0]
}

/** Open-addressing set of 64-bit fingerprints -> dense ids. */
class Table {
  cap = 1 << 20
  a = new Uint32Array(this.cap)
  b = new Uint32Array(this.cap)
  id = new Int32Array(this.cap).fill(-1)
  n = 0
  get(h1: number, h2: number): number {
    let i = (h1 ^ Math.imul(h2, 0x9e3779b1)) & (this.cap - 1)
    for (;;) {
      const v = this.id[i]!
      if (v === -1) return -1 - i
      if (this.a[i] === h1 && this.b[i] === h2) return v
      i = (i + 1) & (this.cap - 1)
    }
  }
  add(h1: number, h2: number): number {
    if (this.n * 5 >= this.cap * 3) this.grow()
    const r = this.get(h1, h2)
    if (r >= 0) return r
    const i = -1 - r
    this.a[i] = h1
    this.b[i] = h2
    this.id[i] = this.n
    return this.n++
  }
  grow(): void {
    const { a, b, id } = this
    this.cap *= 2
    this.a = new Uint32Array(this.cap)
    this.b = new Uint32Array(this.cap)
    this.id = new Int32Array(this.cap).fill(-1)
    for (let i = 0; i < a.length; i++) {
      if (id[i] === -1) continue
      let j = (a[i]! ^ Math.imul(b[i]!, 0x9e3779b1)) & (this.cap - 1)
      while (this.id[j] !== -1) j = (j + 1) & (this.cap - 1)
      this.a[j] = a[i]!
      this.b[j] = b[i]!
      this.id[j] = id[i]!
    }
  }
}

class IntVec {
  d = new Int32Array(1 << 16)
  n = 0
  push(v: number): void {
    if (this.n === this.d.length) {
      const x = new Int32Array(this.d.length * 2)
      x.set(this.d)
      this.d = x
    }
    this.d[this.n++] = v
  }
}

// ------------------------------------------------------------------ search

/** Above this the fingerprint table would pass ~1 GB (the machine is shared): stop and say so. */
export const DEFAULT_MAX_STATES = 19_000_000

export interface Opts {
  name: string
  props: string[]
  /** Stop after this many distinct states (verdict 'stopped'; reported, never claimed exhaustive). */
  maxStates?: number
  log?: (s: string) => void
}

export function check(c: Cfg, o: Opts): Result {
  const t0 = Date.now()
  const props = o.props.map((p) => {
    const x = PROPS[p]
    if (!x) throw new Error(`no property ${p}`)
    return x
  })
  const tab = new Table()
  const parent = new IntVec()
  const keepGraph = c.liveness
  const goal = goalOf(c)
  const edgeStart = new IntVec()
  const edges = new IntVec()
  const doneIds = new IntVec()
  const s0 = init(c)
  const str0 = JSON.stringify(s0)
  const [a0, b0] = fp(str0)
  tab.add(a0, b0)
  parent.push(-1)
  const dir = join(process.env.BFS_TMP ?? join(import.meta.dirname, '..', 'build'), `bfs-${process.pid}-${o.name}`)
  mkdirSync(dir, { recursive: true })
  let level = new LevelWriter(join(dir, 'level-0'))
  level.add(0, str0)
  level.close()
  let depth = 0
  let transitions = 0
  const fail = (prop: string, id: number): Result => {
    rmSync(dir, { recursive: true, force: true })
    const r = finish('violated')
    r.violated = prop
    r.trace = rebuild(c, tab, parent, id)
    return r
  }
  const finish = (verdict: Result['verdict']): Result => ({
    name: o.name, props: o.props, verdict, states: tab.n, transitions, depth,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    collisionProb: Number(((tab.n * tab.n) / 2 ** 65).toPrecision(2)),
  })
  for (const p of props) if (!p.holds(c, s0)) return fail(p.name, 0)
  for (;;) {
    const cur = level.path
    const next = new LevelWriter(join(dir, `level-${depth + 1}`))
    for (const [from, line] of readLevel(cur)) {
      const s = JSON.parse(line) as St
      if (keepGraph) {
        while (edgeStart.n < from) edgeStart.push(edges.n) // ids are expanded in order
        edgeStart.push(edges.n)
        if (goal(s)) doneIds.push(from)
      }
      let bad: { prop: string; id: number } | null = null
      successors(c, s, (_label, ns) => {
        if (bad) return
        transitions++
        const str = JSON.stringify(ns)
        const [h1, h2] = fp(str)
        const before = tab.n
        const id = tab.add(h1, h2)
        if (keepGraph) edges.push(id)
        if (id === before) {
          parent.push(from)
          for (const p of props) if (!p.holds(c, ns)) { bad = { prop: p.name, id }; return }
          next.add(id, str)
        }
      })
      if (bad) {
        next.close()
        depth++
        return fail((bad as { prop: string }).prop, (bad as { id: number }).id)
      }
      if (tab.n > (o.maxStates ?? DEFAULT_MAX_STATES)) {
        next.close()
        rmSync(dir, { recursive: true, force: true })
        return { ...finish('stopped'), note: `memory bound: stopped at ${tab.n.toLocaleString('en')} states; every state reachable in at most ${depth} steps checked, no violation` }
      }
    }
    next.close()
    rmSync(cur, { force: true })
    if (next.count === 0) break
    depth++
    o.log?.(`  depth ${depth}: ${next.count} new, ${tab.n} total, ${Math.round((Date.now() - t0) / 1000)}s, rss ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB`)
    level = next
  }
  rmSync(dir, { recursive: true, force: true })
  if (!keepGraph) return finish('holds')

  // ---------------------------------------------------------------- AG EF done
  while (edgeStart.n < tab.n) edgeStart.push(edges.n)
  edgeStart.push(edges.n)
  const n = tab.n
  const indeg = new Int32Array(n + 1)
  for (let i = 0; i < edges.n; i++) indeg[edges.d[i]! + 1]!++
  for (let i = 0; i < n; i++) indeg[i + 1]! += indeg[i]!
  const rev = new Int32Array(edges.n)
  const fill = indeg.slice()
  for (let u = 0; u < n; u++) for (let e = edgeStart.d[u]!; e < edgeStart.d[u + 1]!; e++) rev[fill[edges.d[e]!]!++] = u
  const good = new Uint8Array(n)
  const queue: number[] = []
  for (let i = 0; i < doneIds.n; i++) { good[doneIds.d[i]!] = 1; queue.push(doneIds.d[i]!) }
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi]!
    for (let e = indeg[v]!; e < indeg[v + 1]!; e++) {
      const u = rev[e]!
      if (!good[u]) { good[u] = 1; queue.push(u) }
    }
  }
  for (let i = 0; i < n; i++) {
    if (!good[i]) {
      // ids are assigned in breadth-first order: the first bad id is a shallowest one
      const r = fail(c.goal === 'clean' ? 'LIVE_NoLeak' : 'LIVE_QueryCanComplete', i)
      if (c.goal === 'clean') {
        const last = rebuildState(c, tab, parent, i)
        r.note = `from the last state of the trace no continuation deletes every unlisted object; unlisted then: ${orphans(c, last).join('; ')}`
      } else r.note = 'from the last state of the trace no continuation completes the query'
      return r
    }
  }
  return finish('holds')
}

/** The state with id `id`, by re-expanding along the parent chain. */
function rebuildState(c: Cfg, tab: Table, parent: IntVec, id: number): St {
  let last = init(c)
  rebuild(c, tab, parent, id, (s) => { last = s })
  return last
}

/** Rebuild the labelled trace to state `id` by re-expanding along the parent chain. */
function rebuild(c: Cfg, tab: Table, parent: IntVec, id: number, end?: (s: St) => void): string[] {
  const chain: number[] = []
  for (let x = id; x !== -1; x = parent.d[x]!) chain.push(x)
  chain.reverse()
  const out: string[] = []
  let s = init(c)
  for (let k = 1; k < chain.length; k++) {
    let found: { label: string; ns: St } | null = null
    successors(c, s, (label, ns) => {
      if (found) return
      const [h1, h2] = fp(JSON.stringify(ns))
      if (tab.get(h1, h2) === chain[k]) found = { label, ns }
    })
    if (!found) throw new Error('trace reconstruction failed')
    out.push((found as { label: string }).label)
    s = (found as { ns: St }).ns
  }
  end?.(s)
  return out
}
