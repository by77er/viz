import { createHash, webcrypto } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { canonicalJson, revisionOf, sha256Hex } from '../src/index.ts'
import { edit, examples, red } from './helpers.ts'

describe('sha256', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })
  it('matches node:crypto on random strings, including every length across block boundaries', () => {
    for (let n = 0; n < 200; n++) {
      const s = 'x'.repeat(n)
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'))
    }
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 500 }), (s) => sha256Hex(s) === createHash('sha256').update(Buffer.from(new TextEncoder().encode(s))).digest('hex')), { numRuns: 1000 })
  })
  it('matches WebCrypto on the examples', async () => {
    for (const d of Object.values(examples)) {
      const bytes = new TextEncoder().encode(canonicalJson(d))
      const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex')
      expect(sha256Hex(bytes)).toBe(digest)
      expect(revisionOf(d)).toBe(digest.slice(0, 32))
    }
  })
})

/** Rebuild a JSON value with object keys in a permuted order. */
function shuffleKeys(v: unknown, seed: number): unknown {
  if (Array.isArray(v)) return v.map((x, i) => shuffleKeys(x, seed + i))
  if (typeof v !== 'object' || v === null) return v
  const keys = Object.keys(v)
  const order = keys.map((k, i) => [k, Math.sin(seed * 9301 + i * 49297) ] as const).sort((a, b) => a[1] - b[1])
  const out: Record<string, unknown> = {}
  for (const [k] of order) Object.defineProperty(out, k, { value: shuffleKeys((v as Record<string, unknown>)[k], seed + 1), enumerable: true, writable: true, configurable: true })
  return out
}

describe('revision', () => {
  it('is 32 hex chars and differs between examples', () => {
    const revs = Object.values(examples).map(revisionOf)
    for (const r of revs) expect(r).toMatch(/^[0-9a-f]{32}$/)
    expect(new Set(revs).size).toBe(revs.length)
  })
  it('is stable under key reordering of the examples', () => {
    for (const d of Object.values(examples)) {
      for (let seed = 1; seed <= 20; seed++) {
        const shuffled = shuffleKeys(d, seed)
        expect(revisionOf(shuffled)).toBe(revisionOf(d))
      }
      expect(JSON.stringify(shuffleKeys(d, 3))).not.toBe(JSON.stringify(d))
    }
  })
  it('property: stable under key reordering, for arbitrary JSON', () => {
    fc.assert(fc.property(fc.jsonValue(), fc.integer({ min: 1, max: 1000 }), (v, seed) => revisionOf(shuffleKeys(v, seed)) === revisionOf(v)), { numRuns: 2000 })
  })
  it('changes with any content change, including array order and value type', () => {
    const base = revisionOf(red)
    expect(revisionOf(edit(red, [{ op: 'replace', path: '/metadata/title', value: 'Service RED overview ' }]))).not.toBe(base)
    expect(revisionOf(edit(red, [{ op: 'move', from: '/metadata/tags/0', path: '/metadata/tags/1' }]))).not.toBe(base)
    expect(revisionOf({ a: 1 })).not.toBe(revisionOf({ a: '1' }))
    expect(revisionOf({ a: [1, 2] })).not.toBe(revisionOf({ a: [2, 1] }))
  })
  it('canonical JSON sorts keys and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x', { z: 1, y: 2 }], '': -0 })).toBe('{"":0,"a":[true,null,"x",{"y":2,"z":1}],"b":1}')
  })
})
