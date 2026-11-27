import { NO_AGGREGATE } from './spec'

/**
 * Words the chart writes that an application's result needs otherwise. Each is a gap in the
 * reference chart, listed in README.md under "Needed changes in the design system"; this is
 * the whole of what the app changes in what the chart writes.
 *
 * - A result with no unit: the chart writes "Last, " and "title, , range". The comma that
 *   introduces the missing unit is removed.
 * - A legend row's accessible name is its full label set (`route="/product", service="catalog"`)
 *   while it shows "/product · catalog": someone who speaks what they see ("click /product
 *   catalog") is not understood (WCAG 2.5.3, Label in Name). The name starts with the words
 *   shown, then the full label set.
 *   Other's row shows "Other" and "28 series" with no space between the two elements; one is put there.
 * - The text form says "every 0.25 min, <aggregate>" (it assumes steps of whole minutes and an
 *   aggregate per step). A range query has neither: it says "one value every 15 s".
 * - The chart writes a range inside one day as clock times ("09:30 to 12:30"), in its name and
 *   in its text form, and the panel's head says the day before it ("18 Nov, "). The name and the
 *   text form are read without the head (a screen reader, a copy pasted into a note days later):
 *   the day is put before the range there too (design review M2).
 * - The chart knows nothing of the API's warnings. When the head says a result may be
 *   incomplete, the name says so and the text form has a line with the head's own sentence (M2).
 */
export const fixHead = (text: string) => (text.endsWith(', ') ? text.slice(0, -2) : text)
export const fixName = (text: string) => text.replace(', , ', ', ')
export function fixText(line: string, step: string): string {
  return line.replace(', , ', ', ').replace(new RegExp(`, every [^,]+ min, ${NO_AGGREGATE}\\.`), `, one value every ${step}.`)
}

/** "18 Nov" before the first range of clock times in `text`, as the head has it; nothing when the head states no day. */
export function withDay(text: string, day: string): string {
  if (day === '' || text.includes(`${day}, `)) return text
  return text.replace(/\d\d:\d\d to \d\d:\d\d/, (range) => `${day}, ${range}`)
}
/** What the chart's accessible name ends with while its result carries a warning. */
export const PARTIAL_NAME = ' The API sent a warning: the result may be incomplete.'
export const withPartial = (name: string, partial: boolean) => (!partial || name.endsWith(PARTIAL_NAME) ? name : name + PARTIAL_NAME)

/**
 * A legend row's accessible name: what the row shows, then its full label set, unless the name
 * already holds what is shown. Other's row shows "Other" and "28 series" and is named "Other:
 * 28 series as one band": it becomes "Other 28 series, as one band".
 */
export function fixRowName(shown: string, name: string): string {
  const words = shown.trim().replace(/\s+/g, ' ')
  if (words === '' || name.includes(words)) return name
  const other = /^Other: (\d+ series) (.+)$/.exec(name)
  if (other && words === `Other ${other[1]}`) return `${words}, ${other[2]}`
  return `${words}: ${name}`
}
