import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { applyOps, applyPatch, canonicalJson, deepEqual, diff, parsePointer, pointer, revisionOf, summarizeDiff, unescapeToken, validate, type Dashboard, type PatchOp } from '../src/index.ts'
import { edit, examples, readJson, red } from './helpers.ts'

interface SuiteCase {
  comment?: string
  doc: unknown
  patch: unknown[]
  expected?: unknown
  error?: string
  disabled?: boolean
}

// Official suite: https://github.com/json-patch/json-patch-tests (fetched 2026-11-18, stored verbatim).
describe.each(['tests.json', 'spec_tests.json'])('json-patch-tests/%s', (file) => {
  const suite = readJson('test/fixtures/jsonpatch/' + file) as SuiteCase[]
  const active = suite.filter((c) => !c.disabled)
  it(`has cases (${active.length} active of ${suite.length})`, () => {
    expect(active.length).toBeGreaterThan(15)
  })
  it.each(active.map((c, i) => [`${i}: ${c.comment ?? (c.error ? 'error: ' + c.error : 'no comment')}`, c] as const))('%s', (_name, c) => {
    const before = JSON.stringify(c.doc)
    const r = applyOps(c.doc, c.patch)
    if (c.error !== undefined) {
      expect(r.ok, `expected failure: ${c.error}`).toBe(false)
    } else {
      expect(r.ok, r.ok ? '' : r.error.message).toBe(true)
      if (r.ok && 'expected' in c) expect(deepEqual(r.doc, c.expected), `got ${JSON.stringify(r.doc)}`).toBe(true)
    }
    expect(JSON.stringify(c.doc)).toBe(before) // input never mutated
  })
})

describe('RFC 6902 details', () => {
  it('A.16: "-" appends to an array', () => {
    expect(applyOps({ foo: ['bar'] }, [{ op: 'add', path: '/foo/-', value: ['abc', 'def'] }])).toEqual({ ok: true, doc: { foo: ['bar', ['abc', 'def']] } })
  })
  it('"-" is not an existing element for remove, replace, test or as a move source', () => {
    for (const op of [{ op: 'remove', path: '/a/-' }, { op: 'replace', path: '/a/-', value: 1 }, { op: 'test', path: '/a/-', value: 1 }, { op: 'move', from: '/a/-', path: '/b' }]) {
      expect(applyOps({ a: [1] }, [op]).ok).toBe(false)
    }
  })
  it('A.14: ~0 and ~1 are unescaped, in the right order', () => {
    const doc = { '/': 9, '~1': 10, 'a/b': 1, 'm~n': 2, '~01': 3 }
    expect(applyOps(doc, [{ op: 'test', path: '/~1', value: 9 }]).ok).toBe(true)
    expect(applyOps(doc, [{ op: 'test', path: '/~01', value: 10 }]).ok).toBe(true)
    expect(applyOps(doc, [{ op: 'test', path: '/a~1b', value: 1 }]).ok).toBe(true)
    expect(applyOps(doc, [{ op: 'test', path: '/m~0n', value: 2 }]).ok).toBe(true)
    expect(applyOps(doc, [{ op: 'test', path: '/~001', value: 3 }]).ok).toBe(true)
    expect(applyOps(doc, [{ op: 'replace', path: '/a~1b', value: 5 }])).toMatchObject({ ok: true, doc: { 'a/b': 5 } })
    expect(unescapeToken('~01')).toBe('~1')
    expect(parsePointer('/a~2b')).toBeNull()
    expect(parsePointer('a/b')).toBeNull()
    expect(parsePointer('/a~1b/m~0n')).toEqual(['a/b', 'm~n'])
    expect(pointer(['a/b', 'm~n', 0])).toBe('/a~1b/m~0n/0')
  })
  it('array indices: no leading zeros, no out-of-bounds, no negative', () => {
    for (const p of ['/a/01', '/a/-1', '/a/3', '/a/1e0', '/a/x']) expect(applyOps({ a: [1, 2] }, [{ op: 'add', path: p, value: 0 }]).ok, p).toBe(false)
    expect(applyOps({ a: [1, 2] }, [{ op: 'add', path: '/a/2', value: 3 }])).toEqual({ ok: true, doc: { a: [1, 2, 3] } })
    expect(applyOps({ a: [1, 2] }, [{ op: 'replace', path: '/a/2', value: 3 }]).ok).toBe(false)
  })
  it('move: cannot move into own child; from must exist; move onto itself is a no-op', () => {
    expect(applyOps({ a: { b: 1 } }, [{ op: 'move', from: '/a', path: '/a/b' }]).ok).toBe(false)
    expect(applyOps({ a: 1 }, [{ op: 'move', from: '/x', path: '/y' }]).ok).toBe(false)
    expect(applyOps({ a: 1 }, [{ op: 'move', from: '/a', path: '/a' }])).toEqual({ ok: true, doc: { a: 1 } })
    expect(applyOps({ a: [1, 2, 3] }, [{ op: 'move', from: '/a/0', path: '/a/2' }])).toEqual({ ok: true, doc: { a: [2, 3, 1] } })
  })
  it('copy makes an independent copy', () => {
    const r = applyOps({ a: { x: [1] } }, [{ op: 'copy', from: '/a', path: '/b' }, { op: 'add', path: '/b/x/-', value: 2 }])
    expect(r).toEqual({ ok: true, doc: { a: { x: [1] }, b: { x: [1, 2] } } })
  })
  it('test compares by JSON value, not key order (A.8, A.9, 4.6)', () => {
    expect(applyOps({ a: { x: 1, y: [1, { p: null }] } }, [{ op: 'test', path: '/a', value: { y: [1, { p: null }], x: 1 } }]).ok).toBe(true)
    expect(applyOps({ a: [1, 2] }, [{ op: 'test', path: '/a', value: [2, 1] }]).ok).toBe(false)
    expect(applyOps({ a: '1' }, [{ op: 'test', path: '/a', value: 1 }]).ok).toBe(false)
  })
  it('add replaces the whole document at ""', () => {
    expect(applyOps({ a: 1 }, [{ op: 'add', path: '', value: [1] }])).toEqual({ ok: true, doc: [1] })
  })
  it('never touches Object.prototype', () => {
    const r = applyOps({}, [{ op: 'add', path: '/__proto__', value: { polluted: true } }])
    expect(r.ok).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(r.ok && Object.keys(r.doc as object)).toEqual(['__proto__'])
    expect(applyOps({}, [{ op: 'add', path: '/constructor/prototype/x', value: 1 }]).ok).toBe(false)
  })
  it('is atomic: a failure at any position leaves no trace of earlier operations', () => {
    const doc = { a: [1, 2, 3], b: { c: 'x' } }
    const snapshot = JSON.stringify(doc)
    const good: PatchOp[] = [
      { op: 'add', path: '/a/-', value: 4 },
      { op: 'remove', path: '/b/c' },
      { op: 'replace', path: '/a/0', value: 'changed' },
      { op: 'move', from: '/a/1', path: '/b/moved' },
      { op: 'copy', from: '/a', path: '/copy' },
    ]
    for (let i = 0; i <= good.length; i++) {
      const ops = [...good.slice(0, i), { op: 'test', path: '/a/0', value: 'never' } as PatchOp, ...good.slice(i)]
      const r = applyOps(doc, ops)
      expect(r.ok).toBe(false)
      expect(r).not.toHaveProperty('doc')
      if (!r.ok) expect(r.error.index).toBe(i)
      expect(JSON.stringify(doc)).toBe(snapshot)
    }
    expect(applyOps(doc, good).ok).toBe(true)
    expect(JSON.stringify(doc)).toBe(snapshot)
  })
  it('errors say what exists at the failing location', () => {
    const r = applyOps({ panels: { p_rate: {} } }, [{ op: 'replace', path: '/panels/p_rat/title', value: 'x' }])
    expect(r).toMatchObject({ ok: false, error: { index: 0, message: 'Nothing exists at /panels/p_rat.', suggestion: 'Keys here: "p_rate".' } })
  })
})

describe('applyPatch (dashboard edit)', () => {
  const rev = revisionOf(red)
  const retitle: PatchOp[] = [{ op: 'replace', path: '/panels/error_ratio/title', value: '5xx ratio' }]

  it('applies a valid edit and returns the new revision', () => {
    const r = applyPatch(red, retitle, { baseRevision: rev })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.panels.error_ratio!.title).toBe('5xx ratio')
    expect(r.revision).toBe(revisionOf(r.spec))
    expect(r.revision).not.toBe(rev)
    expect(red.panels.error_ratio!.title).toBe('Error ratio') // input untouched
  })
  it('rejects a stale base revision with a conflict, applying nothing', () => {
    const first = applyPatch(red, retitle, { baseRevision: rev })
    if (!first.ok) throw new Error('setup')
    const second = applyPatch(first.spec, [{ op: 'remove', path: '/panels/notes' }], { baseRevision: rev })
    expect(second).toMatchObject({ ok: false, conflict: { expected: rev, actual: first.revision } })
    expect(second).not.toHaveProperty('spec')
  })
  it('rejects a missing or empty base revision', () => {
    expect(applyPatch(red, retitle, {} as never)).toHaveProperty('conflict')
    expect(applyPatch(red, retitle, { baseRevision: '' })).toHaveProperty('conflict')
    expect(applyPatch(red, retitle, undefined as never)).toHaveProperty('conflict')
  })
  it('a patch can never produce an invalid dashboard', () => {
    const bad: PatchOp[][] = [
      [{ op: 'remove', path: '/panels/error_ratio' }], // still in layout
      [{ op: 'remove', path: '/queries/err_ratio' }], // still used
      [{ op: 'remove', path: '/metadata/intent' }],
      [{ op: 'add', path: '/panels/error_ratio/color', value: 'red' }],
      [{ op: 'replace', path: '/panels/error_ratio/unit', value: 'seconds' }],
      [{ op: 'add', path: '/layout/rows/0/items/-', value: 'nope' }],
      [{ op: 'add', path: '', value: null }],
    ]
    for (const ops of bad) {
      const r = applyPatch(red, ops, { baseRevision: rev })
      expect(r.ok, JSON.stringify(ops)).toBe(false)
      expect('errors' in r && r.errors.length).toBeGreaterThan(0)
      expect(r).not.toHaveProperty('spec')
    }
    // the same removal done completely is accepted
    const ok = applyPatch(red, [{ op: 'remove', path: '/layout/rows/0/items/3' }, { op: 'remove', path: '/panels/notes' }], { baseRevision: rev })
    expect(ok.ok).toBe(true)
  })
  it('reports a failing operation with its index and path', () => {
    const r = applyPatch(red, [...retitle, { op: 'replace', path: '/panels/nope/title', value: 'x' }], { baseRevision: rev })
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'patch-failed', path: '/panels/nope/title' }] })
    if ('errors' in r) expect(r.errors[0]!.message).toMatch(/Operation 1 failed.*No changes were applied/)
  })
  it('test ops guard an edit against a concurrent change', () => {
    const guarded: PatchOp[] = [{ op: 'test', path: '/panels/error_ratio/title', value: 'Something else' }, ...retitle]
    expect(applyPatch(red, guarded, { baseRevision: rev }).ok).toBe(false)
  })
})

describe('diff', () => {
  const same = (a: unknown, b: unknown) => {
    const ops = diff(a, b)
    const r = applyOps(a, ops)
    expect(r.ok, JSON.stringify({ a, b, ops })).toBe(true)
    if (r.ok) expect(deepEqual(r.doc, b), JSON.stringify({ a, b, ops, got: r.doc })).toBe(true)
    return ops
  }
  it('is empty for equal documents, including reordered keys', () => {
    expect(diff({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toEqual([])
  })
  it('is minimal for a single field change', () => {
    const b = edit(red, [{ op: 'replace', path: '/panels/error_ratio/title', value: 'X' }])
    expect(diff(red, b)).toEqual([{ op: 'replace', path: '/panels/error_ratio/title', value: 'X' }])
  })
  it('array edits: insert, delete, append, element change', () => {
    expect(same([1, 2, 3, 4], [1, 2, 9, 3, 4])).toEqual([{ op: 'add', path: '/2', value: 9 }])
    expect(same([1, 2, 3, 4], [1, 3, 4])).toEqual([{ op: 'remove', path: '/1' }])
    expect(same([1, 2], [1, 2, 3])).toEqual([{ op: 'add', path: '/2', value: 3 }])
    expect(same([{ a: 1, b: 'long string value here' }, { a: 2 }], [{ a: 5, b: 'long string value here' }, { a: 2 }])).toEqual([{ op: 'replace', path: '/0/a', value: 5 }])
    same([1, 2, 3], [3, 2, 1])
    same([], [1])
    same([1], [])
  })
  it('escapes keys in paths', () => {
    expect(same({ 'a/b': 1, 'm~n': 2 }, { 'a/b': 2 })).toEqual([{ op: 'remove', path: '/m~0n' }, { op: 'replace', path: '/a~1b', value: 2 }])
  })
  it('between examples round-trips', () => {
    const all = Object.values(examples)
    for (const a of all) for (const b of all) same(a, b)
  })
  it('property: applyOps(a, diff(a, b)) deep-equals b, for arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        const r = applyOps(a, diff(a, b))
        return r.ok && deepEqual(r.doc, b) && canonicalJson(r.doc) === canonicalJson(b)
      }),
      { numRuns: 2000 },
    )
  })
  it('property: holds for near-identical documents (b is an edited copy of a)', () => {
    const edits = fc.array(fc.tuple(fc.nat(), fc.constantFrom('delete', 'set', 'insert'), fc.jsonValue()), { minLength: 1, maxLength: 6 })
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), edits, (a, es) => {
        const b = JSON.parse(JSON.stringify(a)) as unknown
        const nodes: unknown[] = []
        const walk = (n: unknown) => {
          if (typeof n === 'object' && n !== null) {
            nodes.push(n)
            Object.values(n).forEach(walk)
          }
        }
        walk(b)
        for (const [pick, kind, value] of es) {
          if (!nodes.length) break
          const node = nodes[pick % nodes.length] as Record<string, unknown> | unknown[]
          if (Array.isArray(node)) {
            const i = node.length ? pick % node.length : 0
            if (kind === 'delete') node.splice(i, 1)
            else if (kind === 'set' && node.length) node[i] = value
            else node.splice(i, 0, value)
          } else {
            const keys = Object.keys(node)
            if (kind === 'delete' && keys.length) delete node[keys[pick % keys.length]!]
            else if (kind === 'set' && keys.length) node[keys[pick % keys.length]!] = value
            else node[`k${pick % 7}`] = value
          }
        }
        const ops = diff(a, b)
        const r = applyOps(a, ops)
        return r.ok && deepEqual(r.doc, b)
      }),
      { numRuns: 2000 },
    )
  })
  it('property: applyPatch(a, diff(a, b)) yields b for valid dashboards', () => {
    const all = Object.values(examples)
    const variants: Dashboard[] = [
      ...all,
      edit(red, [{ op: 'remove', path: '/layout/rows/0/items/3' }, { op: 'remove', path: '/panels/notes' }]),
      edit(red, [{ op: 'replace', path: '/metadata/title', value: 'Other' }, { op: 'add', path: '/metadata/tags/-', value: 'new' }]),
      edit(red, [{ op: 'move', from: '/layout/rows/2', path: '/layout/rows/0' }]),
    ]
    fc.assert(
      fc.property(fc.constantFrom(...variants), fc.constantFrom(...variants), (a, b) => {
        const r = applyPatch(a, diff(a, b), { baseRevision: revisionOf(a) })
        return r.ok && deepEqual(r.spec, b) && r.revision === revisionOf(b) && validate(r.spec).ok
      }),
      { numRuns: 100 },
    )
  })
})

describe('summarizeDiff', () => {
  it('describes an edit in words', () => {
    const b = edit(red, [
      { op: 'replace', path: '/panels/error_ratio/title', value: '5xx ratio' },
      { op: 'remove', path: '/layout/rows/0/items/3' },
      { op: 'remove', path: '/panels/notes' },
      { op: 'add', path: '/queries/saturation', value: { lang: 'promql', expr: 'avg(process_cpu_utilization{service="$service"})' } },
      { op: 'add', path: '/panels/saturation', value: { kind: 'timeseries', title: 'CPU saturation', description: 'CPU use of the service pods; above 0.8 is saturated.', unit: 'ratio', queries: ['saturation'] } },
      { op: 'add', path: '/layout/rows/1/items/-', value: 'saturation' },
      { op: 'replace', path: '/queries/latency_p50/expr', value: 'vector(1)' },
      { op: 'replace', path: '/metadata/title', value: 'Checkout RED' },
    ])
    const lines = summarizeDiff(red, b)
    expect(lines).toContain('~ metadata title: Service RED overview → Checkout RED')
    expect(lines).toContain('+ query saturation: avg(process_cpu_utilization{service="$service"})')
    expect(lines).toContain('+ panel saturation (timeseries) "CPU saturation"')
    expect(lines).toContain('- panel notes removed')
    expect(lines).toContain('~ panel error_ratio: title: Error ratio → 5xx ratio')
    expect(lines).toContain('~ layout: placed saturation; unplaced notes')
    expect(lines.find((l) => l.startsWith('~ query latency_p50: expr:'))).toMatch(/→ vector\(1\)$/)
    expect(lines).toHaveLength(7)
  })
  it('says so when nothing changed, and when only the order changed', () => {
    expect(summarizeDiff(red, JSON.parse(JSON.stringify(red)))).toEqual(['No changes.'])
    const moved = edit(red, [{ op: 'move', from: '/layout/rows/1/items/0', path: '/layout/rows/1/items/1' }])
    expect(summarizeDiff(red, moved)[0]).toMatch(/^~ layout: order is now /)
  })
})
