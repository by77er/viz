import { describe, expect, expectTypeOf, it } from 'vitest'
import type { PromMatrix as EngineMatrix, PromVector as EngineVector } from '../../contracts/engine.ts'
import { digestPanel, type PromMatrix, type PromVector } from '../src/index.ts'

describe('contracts/engine.ts result shapes', () => {
  it('are the same types as the ones this package declares (checked by tsc)', () => {
    expectTypeOf<EngineMatrix>().toEqualTypeOf<PromMatrix>()
    expectTypeOf<EngineVector>().toEqualTypeOf<PromVector>()
  })
  it('an engine result can be passed to digestPanel as is', () => {
    const fromEngine: EngineMatrix = { resultType: 'matrix', result: [{ metric: { __name__: 'up' }, values: [[1700000000, '1'], [1700000060, '1']] }] }
    expect(digestPanel({ kind: 'timeseries', title: 'Up', description: 'Whether the target is up.', unit: 'none', queries: ['q'] }, fromEngine).series[0]).toMatchObject({ name: 'up', last: 1, points: 2 })
  })
})
