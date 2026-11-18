import { describe, expect, it } from 'vitest'
import { focusFallbacks, mayLoseFocus, PAGE_FALLBACKS, REGION_FALLBACK } from './focusKeeper'
import { additiveToggle } from './pointer'
import { formatAge, shorterRange } from '../explore/waiting'
import { spacedDuration, zoomedIn, zoomedOut } from '../explore/TimeRangePicker'
import { stepWords } from './time'

const plain = { shiftKey: false, ctrlKey: false, metaKey: false }

describe('touch parity (M4)', () => {
  it('a tap toggles the series; a mouse needs a modifier', () => {
    expect(additiveToggle({ ...plain, pointerType: 'touch' }, true)).toBe(true)
    expect(additiveToggle({ ...plain, pointerType: 'touch' }, false)).toBe(true) // a touch screen beside a mouse
    expect(additiveToggle({ ...plain, pointerType: 'pen' }, false)).toBe(true)
    expect(additiveToggle({ ...plain, pointerType: 'mouse' }, false)).toBe(false)
    expect(additiveToggle({ ...plain, pointerType: 'mouse' }, true)).toBe(false)
    expect(additiveToggle({ ...plain, shiftKey: true, pointerType: 'mouse' }, false)).toBe(true)
    expect(additiveToggle({ ...plain, metaKey: true }, false)).toBe(true)
    expect(additiveToggle({ ...plain, pointerType: '' }, false)).toBe(false) // Enter on a desktop isolates
    expect(additiveToggle({ ...plain, pointerType: '' }, true)).toBe(true) // Enter on a phone toggles, like a tap
  })
  it('zoom in halves the range around its middle; zoom out doubles it and does not pass now', () => {
    expect(zoomedIn(1000, 5000)).toEqual([2000, 4000])
    expect(zoomedIn(1000, 1060)).toEqual([1000, 1060]) // never under a minute
    expect(zoomedOut(2000, 4000, 1e9)).toEqual([1000, 5000])
    expect(zoomedOut(2000, 4000, 4000)).toEqual([0, 4000])
    const [a, b] = zoomedIn(...zoomedOut(2000, 4000, 1e9))
    expect([a, b]).toEqual([2000, 4000])
  })
})

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
  it('a result younger than 5 s was updated "now", not "0 s ago"', () => {
    expect(formatAge(0, 0)).toEqual({ n: '', rest: 'now' })
    expect(formatAge(4.9, 0)).toEqual({ n: '', rest: 'now' })
    expect(formatAge(5, 0)).toEqual({ n: '5', rest: ' s ago' })
    expect(formatAge(125, 0)).toEqual({ n: '2', rest: ' min ago' })
  })
  it('a step reads as a number and a unit, minutes as "min"', () => {
    expect(stepWords(15)).toBe('15 s')
    expect(stepWords(60)).toBe('1 min')
    expect(stepWords(120)).toBe('2 min')
    expect(stepWords(90)).toBe('1 min 30 s')
    expect(stepWords(3600)).toBe('1 h')
  })
  it('a preset reads with a space and "min" for minutes, as a step does', () => {
    expect(spacedDuration('5m')).toBe('5 min')
    expect(spacedDuration('15m')).toBe('15 min')
    expect(spacedDuration('1h')).toBe('1 h')
    expect(spacedDuration('24h')).toBe('24 h')
    expect(spacedDuration('7d')).toBe('7 d')
    expect(spacedDuration('1h30m')).toBe('1 h 30 min')
  })
  it('after 10 s the wait offers the next shorter range, when there is one', () => {
    expect(shorterRange(3 * 3600)).toEqual({ preset: '1h', seconds: 3600 })
    expect(shorterRange(3600)).toEqual({ preset: '5m', seconds: 300 })
    expect(shorterRange(300)).toBeNull()
  })
})
