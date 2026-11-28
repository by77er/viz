import { describe, expect, it } from 'vitest'
import { SEED_DASHBOARDS } from '../../mock/dashboards'
import { noteBlocks, notePlain } from './Note'

describe('a text note is read as text, not printed as Markdown (D-M1)', () => {
  it('headings, paragraphs, lists and strong words are blocks and parts; no Markdown mark is left in the words', () => {
    const md = '## How to read this\n\nCPU is in cores. A pod above **1.2 cores** for an hour\nneeds a replica.\n\n- one\n- two *now*\n\n1. first\n2. second'
    const b = noteBlocks(md)
    expect(b.map((x) => x.kind)).toEqual(['heading', 'paragraph', 'list', 'list'])
    expect(b[1]!.lines[0]).toBe('CPU is in cores. A pod above **1.2 cores** for an hour needs a replica.')
    expect(b[3]!.ordered).toBe(true)
    expect(notePlain(md).join(' ')).toBe('How to read this CPU is in cores. A pod above 1.2 cores for an hour needs a replica. one two now first second')
  })
  it('the mock\'s note reads without its asterisks', () => {
    const note = SEED_DASHBOARDS.find((d) => d.spec.metadata.id === 'pod_capacity')!.spec.panels.notes as { content: string }
    expect(notePlain(note.content).join(' ')).not.toMatch(/\*|#/)
  })
})
