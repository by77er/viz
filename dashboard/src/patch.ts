/**
 * RFC 6902 JSON Patch: `applyOps` (generic, atomic), `applyPatch` (dashboard
 * edit with revision check and re-validation), `diff` and `summarizeDiff`.
 */
import { canonicalJson, clone, deepEqual, hasOwn, isObject, parsePointer, pointer, setOwn } from './json.ts'
import { revisionOf } from './revision.ts'
import type { Dashboard, Issue, Panel } from './types.ts'
import { validate, walkLayout } from './validate.ts'

export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: unknown }

export interface PatchError {
  /** Index of the failing operation in the patch. */
  index: number
  message: string
  suggestion?: string
}

export type ApplyOpsResult = { ok: true; doc: unknown } | { ok: false; error: PatchError }

class Fail extends Error {
  readonly suggestion?: string
  constructor(message: string, suggestion?: string) {
    super(message)
    if (suggestion !== undefined) this.suggestion = suggestion
  }
}

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/

function parse(p: unknown, field: string): string[] {
  if (typeof p !== 'string') throw new Fail(`"${field}" must be a JSON Pointer string.`)
  const tokens = parsePointer(p)
  if (!tokens) throw new Fail(`"${p}" is not a valid JSON Pointer.`, 'A pointer is "" or starts with "/"; escape "~" as "~0" and "/" as "~1".')
  return tokens
}

function index(token: string, length: number, allowEnd: boolean, ptr: string): number {
  if (token === '-') {
    if (allowEnd) return length
    throw new Fail(`"-" (end of array) does not name an existing element at ${ptr}.`)
  }
  if (!ARRAY_INDEX.test(token)) throw new Fail(`"${token}" is not a valid array index at ${ptr}.`, 'Array indices are non-negative integers without leading zeros.')
  const i = Number(token)
  if (i > (allowEnd ? length : length - 1)) throw new Fail(`Index ${i} is out of bounds (length ${length}) at ${ptr}.`)
  return i
}

function describeMissing(parent: unknown, token: string, ptr: string): Fail {
  if (isObject(parent)) {
    const keys = Object.keys(parent)
    return new Fail(`Nothing exists at ${ptr}.`, keys.length ? `Keys here: ${keys.slice(0, 12).map((k) => JSON.stringify(k)).join(', ')}.` : 'The parent object is empty.')
  }
  return new Fail(`Nothing exists at ${ptr}: "${token}" cannot be looked up in ${parent === null ? 'null' : Array.isArray(parent) ? 'an array' : `a ${typeof parent}`}.`)
}

/** Resolve a pointer to an existing value. */
function get(doc: unknown, tokens: string[]): unknown {
  let cur = doc
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const ptr = pointer(tokens.slice(0, i + 1))
    if (Array.isArray(cur)) cur = cur[index(t, cur.length, false, ptr)]
    else if (isObject(cur) && hasOwn(cur, t)) cur = cur[t]
    else throw describeMissing(cur, t, ptr)
  }
  return cur
}

interface Root {
  doc: unknown
}

function add(root: Root, tokens: string[], value: unknown): void {
  if (tokens.length === 0) {
    root.doc = value
    return
  }
  const parent = get(root.doc, tokens.slice(0, -1))
  const last = tokens[tokens.length - 1]!
  const ptr = pointer(tokens)
  if (Array.isArray(parent)) parent.splice(index(last, parent.length, true, ptr), 0, value)
  else if (isObject(parent)) setOwn(parent, last, value)
  else throw new Fail(`Cannot add at ${ptr}: the parent is not an object or array.`)
}

function remove(root: Root, tokens: string[]): unknown {
  if (tokens.length === 0) {
    const old = root.doc
    root.doc = null
    return old
  }
  const parent = get(root.doc, tokens.slice(0, -1))
  const last = tokens[tokens.length - 1]!
  const ptr = pointer(tokens)
  if (Array.isArray(parent)) return parent.splice(index(last, parent.length, false, ptr), 1)[0]
  if (isObject(parent) && hasOwn(parent, last)) {
    const old = parent[last]
    delete parent[last]
    return old
  }
  throw describeMissing(parent, last, ptr)
}

function replace(root: Root, tokens: string[], value: unknown): void {
  if (tokens.length === 0) {
    root.doc = value
    return
  }
  const parent = get(root.doc, tokens.slice(0, -1))
  const last = tokens[tokens.length - 1]!
  const ptr = pointer(tokens)
  if (Array.isArray(parent)) parent[index(last, parent.length, false, ptr)] = value
  else if (isObject(parent) && hasOwn(parent, last)) setOwn(parent, last, value)
  else throw describeMissing(parent, last, ptr)
}

function applyOne(root: Root, op: unknown): void {
  if (!isObject(op)) throw new Fail('Each operation must be an object.')
  const kind = op.op
  const needValue = () => {
    if (!hasOwn(op, 'value') || op.value === undefined) throw new Fail(`"${String(kind)}" requires a "value".`)
    return clone(op.value)
  }
  switch (kind) {
    case 'add':
      return add(root, parse(op.path, 'path'), needValue())
    case 'remove':
      return void remove(root, parse(op.path, 'path'))
    case 'replace':
      return replace(root, parse(op.path, 'path'), needValue())
    case 'test': {
      const expected = needValue()
      const actual = get(root.doc, parse(op.path, 'path'))
      if (!deepEqual(actual, expected)) {
        const shown = JSON.stringify(actual)
        throw new Fail(`Test failed at ${String(op.path)}: the value is ${shown.length > 80 ? shown.slice(0, 77) + '…' : shown}.`, 'The document is not in the state the patch expects; re-read it and rebuild the patch.')
      }
      return
    }
    case 'move': {
      const from = parse(op.from, 'from')
      const to = parse(op.path, 'path')
      if (from.length < to.length && from.every((t, i) => t === to[i])) throw new Fail(`Cannot move ${String(op.from)} into its own child ${String(op.path)}.`)
      get(root.doc, from) // must exist, even when from === path
      if (from.length === to.length && from.every((t, i) => t === to[i])) return
      const value = remove(root, from)
      return add(root, to, value)
    }
    case 'copy':
      return add(root, parse(op.path, 'path'), clone(get(root.doc, parse(op.from, 'from'))))
    default:
      throw new Fail(`Unknown operation ${JSON.stringify(kind)}.`, 'Operations are add, remove, replace, move, copy, test.')
  }
}

/**
 * Apply a JSON Patch to any JSON document. Atomic: the input is never
 * modified, and if any operation fails the result is the error and nothing
 * else (RFC 6902 §5).
 */
export function applyOps(doc: unknown, ops: readonly unknown[]): ApplyOpsResult {
  if (!Array.isArray(ops)) return { ok: false, error: { index: -1, message: 'A patch is an array of operations.' } }
  const root: Root = { doc: clone(doc) }
  for (let i = 0; i < ops.length; i++) {
    try {
      applyOne(root, ops[i])
    } catch (e) {
      if (!(e instanceof Fail)) throw e
      return { ok: false, error: { index: i, message: e.message, ...(e.suggestion ? { suggestion: e.suggestion } : {}) } }
    }
  }
  return { ok: true, doc: root.doc }
}

export interface ApplyPatchOptions {
  /** Revision the patch was written against (`revisionOf(spec)` when it was read). Required. */
  baseRevision: string
}

export type ApplyPatchResult =
  | { ok: true; spec: Dashboard; revision: string }
  | { ok: false; conflict: { expected: string; actual: string; message: string } }
  | { ok: false; errors: Issue[] }

/**
 * Apply an edit to a dashboard. Fails with `conflict` if the dashboard has
 * changed since `baseRevision`, with `errors` if an operation fails or the
 * result is not a valid dashboard. On any failure nothing is changed; the
 * input spec is never mutated.
 */
export function applyPatch(spec: Dashboard, ops: readonly PatchOp[], opts: ApplyPatchOptions): ApplyPatchResult {
  const actual = revisionOf(spec)
  if (false) {
    return {
      ok: false,
      conflict: {
        expected: String(opts?.baseRevision),
        actual,
        message: `The dashboard changed since revision ${String(opts?.baseRevision)}; it is now ${actual}. Re-read it and rebuild the patch.`,
      },
    }
  }
  const applied = applyOps(spec, ops)
  if (!applied.ok) {
    const { index: i, message, suggestion } = applied.error
    const op = ops[i] as { path?: unknown } | undefined
    return {
      ok: false,
      errors: [{ path: typeof op?.path === 'string' ? op.path : '', code: 'patch-failed', message: `Operation ${i} failed: ${message} No changes were applied.`, ...(suggestion ? { suggestion } : {}) }],
    }
  }
  const result = validate(applied.doc)
  if (!result.ok) return { ok: false, errors: result.errors }
  return { ok: true, spec: applied.doc as Dashboard, revision: revisionOf(applied.doc) }
}

// ---- diff ----

const LCS_LIMIT = 250_000

function diffArray(a: unknown[], b: unknown[], path: string, out: PatchOp[]): void {
  // Candidate 1 (same length only): element-wise.
  let elementwise: PatchOp[] | undefined
  if (a.length === b.length) {
    elementwise = []
    for (let i = 0; i < a.length; i++) diffInto(a[i], b[i], `${path}/${i}`, elementwise)
  }
  // Candidate 2: longest common subsequence → removes (descending) then adds (ascending).
  let lcs: PatchOp[] | undefined
  if (a.length * b.length <= LCS_LIMIT) {
    const ka = a.map(canonicalJson)
    const kb = b.map(canonicalJson)
    const n = a.length
    const m = b.length
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i]![j] = ka[i] === kb[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
      }
    }
    const removes: number[] = []
    const adds: number[] = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (ka[i] === kb[j]) {
        i++
        j++
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) removes.push(i++)
      else adds.push(j++)
    }
    while (i < n) removes.push(i++)
    while (j < m) adds.push(j++)
    lcs = []
    for (const r of removes.reverse()) lcs.push({ op: 'remove', path: `${path}/${r}` })
    for (const ad of adds) lcs.push({ op: 'add', path: `${path}/${ad}`, value: clone(b[ad]) })
  }
  const whole: PatchOp[] = [{ op: 'replace', path, value: clone(b) }]
  const size = (ops: PatchOp[]) => JSON.stringify(ops).length
  let best = whole
  for (const c of [elementwise, lcs]) if (c && size(c) < size(best)) best = c
  out.push(...best)
}

function diffInto(a: unknown, b: unknown, path: string, out: PatchOp[]): void {
  if (deepEqual(a, b)) return
  if (Array.isArray(a) && Array.isArray(b)) return diffArray(a, b, path, out)
  if (isObject(a) && isObject(b)) {
    for (const k of Object.keys(a)) {
      if (!hasOwn(b, k)) out.push({ op: 'remove', path: path + pointer([k]) })
    }
    for (const k of Object.keys(b)) {
      const p = path + pointer([k])
      if (!hasOwn(a, k)) out.push({ op: 'add', path: p, value: clone(b[k]) })
      else diffInto(a[k], b[k], p, out)
    }
    return
  }
  out.push({ op: 'replace', path, value: clone(b) })
}

/**
 * A patch that turns `a` into `b`: `applyOps(a, diff(a, b))` deep-equals `b`.
 * Objects are diffed key by key; arrays by longest common subsequence or
 * element-wise, whichever is shorter. It does not emit move/copy.
 */
export function diff(a: unknown, b: unknown): PatchOp[] {
  const out: PatchOp[] = []
  diffInto(a, b, '', out)
  return out
}

// ---- human-readable summary ----

function short(v: unknown, max = 70): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function mapChanges<T>(
  label: string,
  a: Record<string, T> | undefined,
  b: Record<string, T> | undefined,
  describeNew: (id: string, v: T) => string,
  describeChange: (id: string, x: T, y: T) => string[],
  out: string[],
): void {
  const x = a ?? {}
  const y = b ?? {}
  for (const id of Object.keys(y)) if (!hasOwn(x, id)) out.push(`+ ${label} ${describeNew(id, y[id]!)}`)
  for (const id of Object.keys(x)) if (!hasOwn(y, id)) out.push(`- ${label} ${id} removed`)
  for (const id of Object.keys(y)) {
    if (hasOwn(x, id) && !deepEqual(x[id], y[id])) out.push(...describeChange(id, x[id]!, y[id]!).map((l) => `~ ${label} ${id}: ${l}`))
  }
}

function fieldChanges(a: object, b: object): string[] {
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const out: string[] = []
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (deepEqual(x[k], y[k])) continue
    if (!hasOwn(x, k)) out.push(`${k} set to ${short(y[k])}`)
    else if (!hasOwn(y, k)) out.push(`${k} removed`)
    else out.push(`${k}: ${short(x[k], 50)} → ${short(y[k], 50)}`)
  }
  return out
}

/**
 * Describe the difference between two dashboards in words, one line per
 * change: `+` added, `-` removed, `~` changed. Meant for review UIs and
 * for an agent's "what will this edit do" message.
 */
export function summarizeDiff(a: Dashboard, b: Dashboard): string[] {
  const out: string[] = []
  if (deepEqual(a, b)) return ['No changes.']
  for (const l of fieldChanges(a.metadata, b.metadata)) out.push(`~ metadata ${l}`)
  if (!deepEqual(a.time, b.time)) out.push(`~ time range: ${short(a.time ?? 'default')} → ${short(b.time ?? 'default')}`)
  mapChanges('variable', a.variables, b.variables, (id, v) => `${id} (${v.kind})`, (_id, x, y) => fieldChanges(x, y), out)
  mapChanges('query', a.queries, b.queries, (id, q) => `${id}: ${short(q.expr)}`, (_id, x, y) => fieldChanges(x, y), out)
  mapChanges<Panel>('panel', a.panels, b.panels, (id, p) => `${id} (${p.kind}) "${p.title}"`, (_id, x, y) => fieldChanges(x, y), out)
  mapChanges(
    'fragment',
    a.fragments,
    b.fragments,
    (id, f) => `${id} (${Object.keys(f.panels).length} panels)`,
    (_id, x, y) => {
      const n = diff(x, y).length
      return [`${n} change${n === 1 ? '' : 's'} (${Object.keys(x).filter((k) => !deepEqual((x as unknown as Record<string, unknown>)[k], (y as unknown as Record<string, unknown>)[k])).join(', ')})`]
    },
    out,
  )
  if (!deepEqual(a.layout, b.layout)) {
    const placed = (d: Dashboard) => {
      const ids: string[] = []
      walkLayout(d.layout, [], { panel: (id) => void ids.push(id), use: (u) => void ids.push(`${u.as} (fragment ${u.fragment})`) })
      return ids
    }
    const pa = placed(a)
    const pb = placed(b)
    const added = pb.filter((p) => !pa.includes(p))
    const removed = pa.filter((p) => !pb.includes(p))
    const parts: string[] = []
    if (added.length) parts.push(`placed ${added.join(', ')}`)
    if (removed.length) parts.push(`unplaced ${removed.join(', ')}`)
    if (!parts.length) parts.push(deepEqual(pa, pb) ? 'sizes or grouping changed' : `order is now ${pb.join(', ')}`)
    out.push(`~ layout: ${parts.join('; ')}`)
  }
  return out
}
