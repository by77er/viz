/**
 * Times and durations as a person types and reads them (design system, Field, "Time range",
 * and Number): "18 Nov 09:16", "09:16" for today, "now", "now - 6 h"; "30 s", "5 min",
 * "1 h 30 min". Every field echoes what it read. The URL keeps the forms it always had
 * (lib/time.ts: `now`, `now-6h`, an epoch in milliseconds), so old links stay good.
 *
 * Clock times are in one zone, stated once. A zone is passed in, so the same code is tested
 * in zones the test machine is not in.
 */
import { absoluteSpec, formatDuration, parseDuration, resolveTimeSpec, stepWords, type TimeSpec } from './time'

export interface Zone {
  /** Minutes east of UTC at an instant. */
  offsetMin(ms: number): number
}
/** The browser's zone. */
export const LOCAL: Zone = { offsetMin: (ms) => -new Date(ms).getTimezoneOffset() }
export const fixedZone = (minutes: number): Zone => ({ offsetMin: () => minutes })

/** What to add to an instant so that a UTC clock reads this zone's time at `atMs`. */
export const zoneShiftMs = (zone: Zone, atMs: number): number => zone.offsetMin(atMs) * 60_000

const MINUS = '−'
const pad = (n: number) => String(n).padStart(2, '0')

/** "UTC", "UTC+1", "UTC−5", "UTC+5:30". */
export function zoneName(zone: Zone, atMs: number): string {
  const min = zone.offsetMin(atMs)
  if (min === 0) return 'UTC'
  const abs = Math.abs(min)
  return `UTC${min > 0 ? '+' : MINUS}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ''}`
}

interface Wall {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  s: number
}

function wallOf(ms: number, zone: Zone): Wall {
  const d = new Date(ms + zoneShiftMs(zone, ms))
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
}

/** The instant a wall-clock time names in a zone (the later offset is tried once: a clock change within the day). */
function msOf(w: Wall, zone: Zone): number {
  const asUtc = Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s)
  const first = asUtc - zoneShiftMs(zone, asUtc)
  return asUtc - zoneShiftMs(zone, first)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'] as const
/** "Nov", "nov" or "November": at least three letters that start one month's name. */
const monthIndex = (name: string): number => (name.length < 3 ? -1 : MONTH_NAMES.findIndex((full) => full.startsWith(name.toLowerCase())))

const SPAN_UNITS: Record<string, number> = { ms: 0.001, s: 1, sec: 1, m: 60, min: 60, h: 3600, d: 86400, w: 604800 }
const SPAN_PART = /(\d+(?:\.\d+)?)\s*(ms|sec|s|min|m|h|d|w)(?![a-z])/gy

/**
 * A duration in any of the forms people type ("30s", "30 s", "5 min", "5m", "1 h 30 min",
 * "1h30m", "1.5 h") as seconds. Null when it is not one, or is zero.
 */
export function parseSpan(text: string): number | null {
  const s = text.trim().toLowerCase()
  if (s === '') return null
  let total = 0
  let at = 0
  while (at < s.length) {
    SPAN_PART.lastIndex = at
    const m = SPAN_PART.exec(s)
    if (!m) return null
    total += Number(m[1]) * SPAN_UNITS[m[2]!]!
    at = SPAN_PART.lastIndex
    while (s[at] === ' ') at++
  }
  // A step is a whole number of milliseconds; anything finer is not a duration the API takes.
  const ms = Math.round(total * 1000)
  return ms > 0 ? ms / 1000 : null
}

/** A duration as it is read: at most two parts, largest first, "min" for minutes ("1 h 30 min", "15 s", "2 d"). */
export function spanWords(seconds: number): string {
  return stepWords(seconds).split(' ').slice(0, 4).join(' ')
}

/** The exact Prometheus form a duration has in the URL ("1h30m"), from what was typed. Null when it is not a duration. */
export function spanSpec(text: string): string | null {
  const s = parseSpan(text)
  if (s === null) return null
  const spec = formatDuration(s)
  return parseDuration(spec) === null ? null : spec
}

const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/

function clockOf(text: string): { h: number; mi: number; s: number } | null {
  const m = CLOCK.exec(text)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  const s = Number(m[3] ?? 0)
  return h < 24 && mi < 60 && s < 60 ? { h, mi, s } : null
}

/** A calendar day that exists (31 Feb does not). */
const realDay = (y: number, mo: number, d: number) => {
  const t = new Date(Date.UTC(y, mo, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo && t.getUTCDate() === d
}

/**
 * What a time field holds, as the URL's form of it, or null when it cannot be read:
 * "now"; "now - 6 h"; "09:16" (today); "18 Nov 09:16", "18 Nov 2025 09:16", "18 Nov" (the
 * start of that day); "2026-11-18 09:16"; and the URL's own forms. A day and month without a
 * year is this year, or last year when this year's would be more than a day ahead.
 */
export function parseTime(text: string, nowMs: number, zone: Zone = LOCAL): TimeSpec | null {
  const s = text.trim().replace(/\s+/g, ' ')
  if (s === '') return null
  if (/^now$/i.test(s)) return 'now'
  const rel = /^now ?[-−–] ?(.+)$/i.exec(s)
  if (rel) {
    const span = spanSpec(rel[1]!)
    return span ? `now-${span}` : null
  }
  if (/^\d{10,16}$/.test(s)) return s
  const today = wallOf(nowMs, zone)
  const clock = clockOf(s)
  if (clock) return absoluteSpec(msOf({ ...today, ...clock }, zone) / 1000)
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](.+))?$/.exec(s)
  if (iso) {
    const c = iso[4] === undefined ? { h: 0, mi: 0, s: 0 } : clockOf(iso[4])
    const [y, mo, d] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])]
    return c && realDay(y, mo, d) ? absoluteSpec(msOf({ y, mo, d, ...c }, zone) / 1000) : null
  }
  const dm = /^(\d{1,2}) ([A-Za-z]{3,9})\.?,?(?: (\d{4}))?,?(?: (.+))?$/.exec(s)
  if (dm) {
    const mo = monthIndex(dm[2]!)
    const c = dm[4] === undefined ? { h: 0, mi: 0, s: 0 } : clockOf(dm[4])
    if (mo < 0 || !c) return null
    const d = Number(dm[1])
    let y = dm[3] === undefined ? today.y : Number(dm[3])
    if (!realDay(y, mo, d)) return null
    if (dm[3] === undefined && msOf({ y, mo, d, ...c }, zone) > nowMs + 86_400_000 && realDay(y - 1, mo, d)) y -= 1
    return absoluteSpec(msOf({ y, mo, d, ...c }, zone) / 1000)
  }
  return null
}

const clockText = (w: Wall) => `${pad(w.h)}:${pad(w.mi)}${w.s ? `:${pad(w.s)}` : ''}`
const dayText = (w: Wall, nowYear: number) => `${w.d} ${MONTHS[w.mo]}${w.y === nowYear ? '' : ` ${w.y}`}`

/** What a time field shows for a spec, in a form `parseTime` reads back to the same spec: "now", "now - 6 h", "18 Nov 09:16". */
export function timeText(spec: TimeSpec, nowMs: number, zone: Zone = LOCAL): string {
  if (spec === 'now') return 'now'
  if (spec.startsWith('now-')) return `now - ${stepWords(parseDuration(spec.slice(4)) ?? 0)}`
  // The year is left out only where parseTime puts the same one back: this year, and not more than a day ahead.
  const w = wallOf(Number(spec), zone)
  const sameYear = w.y === wallOf(nowMs, zone).y && Number(spec) <= nowMs + 86_400_000
  return `${dayText(w, sameYear ? w.y : NaN)} ${clockText(w)}`
}

/** A date and time standing alone in a sentence: "18 Nov 09:16". */
export function momentText(epochSec: number, nowMs: number, zone: Zone = LOCAL): string {
  const w = wallOf(epochSec * 1000, zone)
  return `${dayText(w, wallOf(nowMs, zone).y)} ${clockText(w)}`
}

export interface ReadRange {
  /** "18 Nov, 09:16 to 15:16 (now), 6 h, UTC": what the two fields were read as. */
  text: string
  startSec: number
  endSec: number
}

/** The range two specs name, in words, with its length and the zone, stated once. */
export function readRange(from: TimeSpec, to: TimeSpec, nowMs: number, zone: Zone = LOCAL): ReadRange {
  const startSec = resolveTimeSpec(from, nowMs / 1000)
  const endSec = resolveTimeSpec(to, nowMs / 1000)
  const a = wallOf(startSec * 1000, zone)
  const b = wallOf(endSec * 1000, zone)
  const y = wallOf(nowMs, zone).y
  const sameDay = a.y === b.y && a.mo === b.mo && a.d === b.d
  // A time that follows the clock is read to the minute: its seconds change as it is read.
  const clock = (w: Wall, spec: TimeSpec) => (spec.startsWith('now') ? `${pad(w.h)}:${pad(w.mi)}` : clockText(w))
  const end = `${clock(b, to)}${to === 'now' ? ' (now)' : ''}`
  const span = endSec > startSec ? `, ${spanWords(endSec - startSec)}` : ''
  const text = sameDay ? `${dayText(a, y)}, ${clock(a, from)} to ${end}${span}` : `${dayText(a, y)} ${clock(a, from)} to ${dayText(b, y)} ${end}${span}`
  return { text: `${text}, ${zoneName(zone, endSec * 1000)}`, startSec, endSec }
}

/** The day a window is on, for a head that shows only clock times: "18 Nov", or "" when the window ends today or spans more than a day. */
export function dayPrefix(startSec: number, endSec: number, nowMs: number, zone: Zone = LOCAL): string {
  if (endSec - startSec > 86400) return '' // the chart then writes both dates itself
  const b = wallOf(endSec * 1000, zone)
  const n = wallOf(nowMs, zone)
  if (b.y === n.y && b.mo === n.mo && b.d === n.d) return ''
  return dayText(wallOf(startSec * 1000, zone), n.y)
}

/**
 * A window as a panel's head states it where no chart writes it (a result with no series): the
 * chart's own form, "18 Nov, 09:30 to 12:30" ("09:30 to 12:30" when it ends today), and both
 * days when it starts on one and ends on another.
 */
export function rangeWords(startSec: number, endSec: number, nowMs: number, zone: Zone = LOCAL): string {
  const a = wallOf(startSec * 1000, zone)
  const b = wallOf(endSec * 1000, zone)
  const hm = (w: Wall) => `${pad(w.h)}:${pad(w.mi)}`
  if (a.y === b.y && a.mo === b.mo && a.d === b.d) {
    const day = dayPrefix(startSec, endSec, nowMs, zone)
    return `${day ? `${day}, ` : ''}${hm(a)} to ${hm(b)}`
  }
  const y = wallOf(nowMs, zone).y
  return `${dayText(a, y)} ${hm(a)} to ${dayText(b, y)} ${hm(b)}`
}
