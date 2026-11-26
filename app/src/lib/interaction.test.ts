import { describe, expect, it } from 'vitest'
import { focusFallbacks, mayLoseFocus, PAGE_FALLBACKS, REGION_FALLBACK } from './focusKeeper'
import { formatAge, shorterRange } from '../explore/waiting'
import { presetWords, sameSpec } from '../explore/TimeRangeField'
import { stepWords } from './time'

describe('focus after a control goes away (M3)', () => {
  it('looks only at changes that can take the focus away, so ordinary changes read no layout (B3)', () => {
    // A tiny tree: region > legend row (focused); the readout row is elsewhere.
    const node = (parent: Node | null) => {
      const n: Node = { isConnected: true, contains: (o: unknown) => o === n || (o as Node).parent === n || ((o as Node).parent?.parent ?? null) === n, parent }
      return n
    }
    interface Node { isConnected: boolean; contains(o: unknown): boolean; parent: Node | null }
    const page = node(null)
    const region = node(page)
    const row = node(region)
    const readout = node(page)
    const attr = (target: Node) => ({ type: 'attributes', target })
    const child = (target: Node) => ({ type: 'childList', target })
    expect(mayLoseFocus([attr(readout), attr(readout), child(readout)], row)).toBe(false) // the crosshair readout
    expect(mayLoseFocus([child(region), child(page)], row)).toBe(false) // something added beside it
    expect(mayLoseFocus([attr(region)], row)).toBe(true) // the region is parked (class) or hidden
    expect(mayLoseFocus([attr(row)], row)).toBe(true) // the control itself is disabled or hidden
    expect(mayLoseFocus([child(page)], { ...row, isConnected: false })).toBe(true) // the control was removed
  })
  it('tries the control’s own stand-in first, then the region’s, then the page’s', () => {
    expect(focusFallbacks({ after: '[data-testid=retry]', inRegion: false })).toEqual(['[data-testid=retry]', ...PAGE_FALLBACKS])
    expect(focusFallbacks({ inRegion: true })).toEqual([REGION_FALLBACK, ...PAGE_FALLBACKS])
    expect(focusFallbacks({ inRegion: false })[0]).toBe('[data-testid="run"]')
  })
})

describe('words (minors)', () => {
  it('a result younger than 5 s was updated "just now", not "0 s ago"', () => {
    expect(formatAge(0, 0)).toEqual({ n: '', rest: 'just now' })
    expect(formatAge(4.9, 0)).toEqual({ n: '', rest: 'just now' })
    expect(formatAge(5, 0)).toEqual({ n: '5 s', rest: ' ago' })
    expect(formatAge(125, 0)).toEqual({ n: '2 min', rest: ' ago' })
    expect(formatAge(3 * 3600 + 5, 0)).toEqual({ n: '3 h', rest: ' ago' })
    // Beyond a day: the time itself, never an age.
    expect(formatAge(2 * 86400, Date.UTC(2026, 10, 17, 9, 30) / 1000, Date.UTC(2026, 10, 19, 9, 30)).rest).toBe('')
  })
  it('a step reads as a number and a unit, minutes as "min"', () => {
    expect(stepWords(15)).toBe('15 s')
    expect(stepWords(60)).toBe('1 min')
    expect(stepWords(120)).toBe('2 min')
    expect(stepWords(90)).toBe('1 min 30 s')
    expect(stepWords(3600)).toBe('1 h')
  })
  it('a preset reads with a space and "min" for minutes, as a step does', () => {
    expect(presetWords('15m')).toBe('15 min')
    expect(presetWords('1h')).toBe('1 h')
    expect(presetWords('24h')).toBe('24 h')
    expect(presetWords('7d')).toBe('7 d')
  })
  it('a preset stays chosen however its length is spelt', () => {
    expect(sameSpec('now-24h', 'now-1d')).toBe(true)
    expect(sameSpec('now-1h', 'now-60m')).toBe(true)
    expect(sameSpec('now-1h', 'now-6h')).toBe(false)
    expect(sameSpec('now', 'now')).toBe(true)
    expect(sameSpec('1795000000000', '1795000000001')).toBe(false)
  })
  it('after 10 s the wait offers the next shorter range, when there is one', () => {
    expect(shorterRange(3 * 3600)).toEqual({ preset: '1h', seconds: 3600 })
    expect(shorterRange(3600)).toEqual({ preset: '15m', seconds: 900 })
    expect(shorterRange(900)).toBeNull()
  })
})
