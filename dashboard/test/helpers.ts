import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyOps, type Dashboard, type PatchOp } from '../src/index.ts'

export const root = fileURLToPath(new URL('..', import.meta.url))
export const readJson = (rel: string): unknown => JSON.parse(readFileSync(root + rel, 'utf8'))

export const exampleFiles = readdirSync(root + 'examples').filter((f) => f.endsWith('.json')).sort()
export const examples: Record<string, Dashboard> = Object.fromEntries(exampleFiles.map((f) => [f, readJson('examples/' + f) as Dashboard]))
export const red = examples['service-red.json']!

/** Apply ops to a copy of `doc`; throws if the patch itself fails. */
export function edit<T>(doc: T, ops: PatchOp[]): T {
  const r = applyOps(doc, ops)
  if (!r.ok) throw new Error(`fixture patch failed: ${r.error.message}`)
  return r.doc as T
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
