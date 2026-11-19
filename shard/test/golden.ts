/**
 * Golden files (contracts/COMPATIBILITY.md §8), as in control/test/golden.ts: a golden file
 * pins one VERSION of a format; the code's version number names the file to compare with.
 */
import { expect } from 'vitest'

const files = import.meta.glob('./golden/**/*.json', { eager: true, import: 'default' })

export const goldenFile = (path: string): unknown => files[`./golden/${path}`]

export const goldenDir = (dir: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith(`./golden/${dir}/`)).map(([k, v]) => [k.slice(`./golden/${dir}/`.length), v]))

export function expectGolden(path: string, actual: unknown): void {
  const g = goldenFile(path)
  if (g === undefined) {
    console.log(`GOLDEN ${path} ${JSON.stringify(actual)}`)
    throw new Error(`no golden file test/golden/${path}. If this is a new format version, review the JSON printed above and check it in under that name.`)
  }
  expect(actual, `golden file test/golden/${path}`).toEqual(g)
}
