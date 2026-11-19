/**
 * Golden files (contracts/COMPATIBILITY.md §8). A golden file pins what one VERSION of a
 * format looks like. The code's version number for the format names the file to compare
 * with, so changing an encoding without bumping its number fails, and bumping the number
 * without checking in the new version's file fails too. Old versions' files stay: they are
 * what the decoders must still read.
 */
import { expect } from 'vitest'

const files = import.meta.glob('./golden/**/*.json', { eager: true, import: 'default' })

export const goldenFile = (path: string): unknown => files[`./golden/${path}`]

/** All golden files under a directory, by file name. */
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
