import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { dayPrefix, fixedZone, parseSpan, parseTime, readRange, spanSpec, spanWords, timeText, zoneName, zoneShiftMs, type Zone } from './timeInput'

const UTC = fixedZone(0)
const BERLIN = fixedZone(60)
const NEW_YORK = fixedZone(-300)
const KOLKATA = fixedZone(330)
/** 26 Nov 2026 19:14:00 UTC. */
const NOW = Date.UTC(2026, 10, 26, 19, 14)
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => String(Date.UTC(y, mo - 1, d, h, mi, s))

describe('durations as typed and as read', () => {
  it('reads every form people type', () => {
    expect(parseSpan('30s')).toBe(30)
    expect(parseSpan('30 s')).toBe(30)
    expect(parseSpan('5 min')).toBe(300)
    expect(parseSpan('5m')).toBe(300)
    expect(parseSpan('1 h 30 min')).toBe(5400)
    expect(parseSpan('1h30m')).toBe(5400)
    expect(parseSpan('1.5 h')).toBe(5400)
    expect(parseSpan('500ms')).toBe(0.5)
    expect(parseSpan('2 d')).toBe(172800)
    expect(parseSpan('1 w')).toBe(604800)
  })
  it('refuses what is not a duration, and zero', () => {
    for (const bad of ['', '5', 'min', '5 mins ago', '5 x', '0 s', '-5 min', '5 min and more', 'h 5']) expect(parseSpan(bad), bad).toBeNull()
  })
  it('writes at most two parts, largest first, with min for minutes', () => {
    expect(spanWords(5400)).toBe('1 h 30 min')
    expect(spanWords(15)).toBe('15 s')
    expect(spanWords(120)).toBe('2 min')
    expect(spanWords(93784)).toBe('1 d 2 h')
  })
  it('gives the URL the exact Prometheus form', () => {
    expect(spanSpec('90 min')).toBe('1h30m')
    expect(spanSpec('30 s')).toBe('30s')
    expect(spanSpec('soon')).toBeNull()
  })
})

describe('a time field', () => {
  it('reads the system\'s forms', () => {
    expect(parseTime('now', NOW, UTC)).toBe('now')
    expect(parseTime('Now', NOW, UTC)).toBe('now')
    expect(parseTime('now - 6 h', NOW, UTC)).toBe('now-6h')
    expect(parseTime('now-6h', NOW, UTC)).toBe('now-6h')
    expect(parseTime('now − 90 min', NOW, UTC)).toBe('now-1h30m')
    expect(parseTime('09:16', NOW, UTC)).toBe(at(2026, 11, 26, 9, 16))
    expect(parseTime('09:16:30', NOW, UTC)).toBe(at(2026, 11, 26, 9, 16, 30))
    expect(parseTime('18 Nov 09:16', NOW, UTC)).toBe(at(2026, 11, 18, 9, 16))
    expect(parseTime('18 nov 9:16', NOW, UTC)).toBe(at(2026, 11, 18, 9, 16))
    expect(parseTime('18 November 2025 09:16', NOW, UTC)).toBe(at(2025, 11, 18, 9, 16))
    expect(parseTime('18 Nov', NOW, UTC)).toBe(at(2026, 11, 18))
    expect(parseTime('2026-11-18 09:16', NOW, UTC)).toBe(at(2026, 11, 18, 9, 16))
    expect(parseTime('2026-11-18T09:16:05', NOW, UTC)).toBe(at(2026, 11, 18, 9, 16, 5))
    expect(parseTime('1795512960000', NOW, UTC)).toBe('1795512960000')
  })
  it('refuses what is not a time', () => {
    for (const bad of ['', 'yesterday', '25:00', '09:61', '31 Feb 09:00', '18 Nov 25:00', '18 Xyz 09:00', 'now + 1 h', 'now - soon', '2026-13-01 00:00', '18 No 09:00', '11/18/2026, 09:30:00 AM'])
      expect(parseTime(bad, NOW, UTC), bad).toBeNull()
  })
  it('reads a clock time in the zone it is given, not the machine\'s', () => {
    // 09:16 in Berlin (UTC+1) is 08:16 UTC; in New York (UTC−5), 14:16 UTC; in Kolkata (UTC+5:30), 03:46 UTC.
    expect(parseTime('26 Nov 09:16', NOW, BERLIN)).toBe(at(2026, 11, 26, 8, 16))
    expect(parseTime('26 Nov 09:16', NOW, NEW_YORK)).toBe(at(2026, 11, 26, 14, 16))
    expect(parseTime('26 Nov 09:16', NOW, KOLKATA)).toBe(at(2026, 11, 26, 3, 46))
    // "today" is the zone's day: at 19:14 UTC it is already the 27th in Kolkata (00:44).
    expect(parseTime('00:30', NOW, KOLKATA)).toBe(at(2026, 11, 26, 19, 0))
  })
  it('takes a day without a year as this year, or last year when this year\'s is more than a day ahead', () => {
    const jan2 = Date.UTC(2027, 0, 2, 10, 0)
    expect(parseTime('30 Dec 09:00', jan2, UTC)).toBe(at(2026, 12, 30, 9, 0))
    expect(parseTime('2 Jan 23:00', jan2, UTC)).toBe(at(2027, 1, 2, 23, 0))
  })
  it('shows a spec in a form it reads back', () => {
    expect(timeText('now', NOW, UTC)).toBe('now')
    expect(timeText('now-6h', NOW, UTC)).toBe('now - 6 h')
    expect(timeText('now-15m', NOW, UTC)).toBe('now - 15 min')
    expect(timeText(at(2026, 11, 18, 9, 30), NOW, UTC)).toBe('18 Nov 09:30')
    expect(timeText(at(2025, 11, 18, 9, 30, 5), NOW, UTC)).toBe('18 Nov 2025 09:30:05')
    expect(timeText(at(2026, 11, 18, 9, 30), NOW, BERLIN)).toBe('18 Nov 10:30')
  })
  it('property: what a field shows is read back as the same instant, in any zone', () => {
    const zones: Zone[] = [UTC, BERLIN, NEW_YORK, KOLKATA, fixedZone(-570), fixedZone(840)]
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2020, 0, 1) / 1000, max: Date.UTC(2032, 0, 1) / 1000 }), fc.integer({ min: 0, max: zones.length - 1 }), (sec, z) => {
        const spec = String(sec * 1000)
        const zone = zones[z]!
        expect(parseTime(timeText(spec, NOW, zone), NOW, zone)).toBe(spec)
      }),
      { numRuns: 500 },
    )
  })
  it('property: a relative time is shown and read back as itself', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 * 86400 }), (sec) => {
        const spec = `now-${spanSpec(`${sec} s`)}`
        expect(parseTime(timeText(spec, NOW, UTC), NOW, UTC)).toBe(spec)
      }),
      { numRuns: 300 },
    )
  })
})

describe('what a range was read as', () => {
  it('says the day once, the length, and the zone once', () => {
    expect(readRange(at(2026, 11, 18, 9, 30), at(2026, 11, 18, 12, 30), NOW, UTC).text).toBe('18 Nov, 09:30 to 12:30, 3 h, UTC')
    expect(readRange('now-1h', 'now', NOW, UTC).text).toBe('26 Nov, 18:14 to 19:14 (now), 1 h, UTC')
    expect(readRange(at(2026, 11, 17, 22, 0), at(2026, 11, 18, 2, 0), NOW, UTC).text).toBe('17 Nov 22:00 to 18 Nov 02:00, 4 h, UTC')
    expect(readRange('now-1h', 'now', NOW, BERLIN).text).toBe('26 Nov, 19:14 to 20:14 (now), 1 h, UTC+1')
    expect(readRange('now-1h', 'now', NOW, NEW_YORK).text).toBe('26 Nov, 13:14 to 14:14 (now), 1 h, UTC−5')
  })
  it('names zones by their offset', () => {
    expect(zoneName(UTC, NOW)).toBe('UTC')
    expect(zoneName(KOLKATA, NOW)).toBe('UTC+5:30')
    expect(zoneName(fixedZone(-570), NOW)).toBe('UTC−9:30')
    expect(zoneShiftMs(BERLIN, NOW)).toBe(3_600_000)
  })
  it('gives a head the day when the window is not today\'s', () => {
    const s = Date.UTC(2026, 10, 18, 9, 30) / 1000
    expect(dayPrefix(s, s + 3 * 3600, NOW, UTC)).toBe('18 Nov')
    expect(dayPrefix(NOW / 1000 - 3600, NOW / 1000, NOW, UTC)).toBe('')
    expect(dayPrefix(s, s + 3 * 86400, NOW, UTC)).toBe('')
  })
})
