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
import { type Cfg, type St, PROPS, init, successors, queryDone } from './model.ts'

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
    if (this.n * 2 >= this.cap) this.grow()
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
  const edgeStart = new IntVec()
  const edges = new IntVec()
  const doneIds = new IntVec()
  const s0 = init(c)
  const str0 = JSON.stringify(s0)
  const [a0, b0] = fp(str0)
  tab.add(a0, b0)
  parent.push(-1)
  let frontier: string[] = [str0]
  let frontierIds: number[] = [0]
  let depth = 0
  let transitions = 0
  const fail = (prop: string, id: number): Result => {
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
  while (frontier.length > 0) {
    const next: string[] = []
    const nextIds: number[] = []
    for (let k = 0; k < frontier.length; k++) {
      const s = JSON.parse(frontier[k]!) as St
      const from = frontierIds[k]!
      if (keepGraph) {
        while (edgeStart.n < from) edgeStart.push(edges.n) // ids are expanded in order
        edgeStart.push(edges.n)
        if (queryDone(s)) doneIds.push(from)
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
          next.push(str)
          nextIds.push(id)
        }
      })
      if (bad) {
        depth++
        return fail((bad as { prop: string }).prop, (bad as { id: number }).id)
      }
      if (o.maxStates && tab.n > o.maxStates) return { ...finish('stopped'), note: `stopped at ${tab.n} states, depth ${depth}` }
    }
    if (next.length === 0) break
    depth++
    o.log?.(`  depth ${depth}: ${next.length} new, ${tab.n} total, ${Math.round((Date.now() - t0) / 1000)}s`)
    frontier = next
    frontierIds = nextIds
  }
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
      const r = fail('LIVE_QueryCanComplete', i)
      r.note = 'from the last state of the trace no continuation completes the query'
      return r
    }
  }
  return finish('holds')
}

/** Rebuild the labelled trace to state `id` by re-expanding along the parent chain. */
function rebuild(c: Cfg, tab: Table, parent: IntVec, id: number): string[] {
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
  return out
}
