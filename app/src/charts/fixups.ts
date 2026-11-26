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
 */
export const fixHead = (text: string) => (text.endsWith(', ') ? text.slice(0, -2) : text)
export const fixName = (text: string) => text.replace(', , ', ', ')
export function fixText(line: string, step: string): string {
  return line.replace(', , ', ', ').replace(new RegExp(`, every [^,]+ min, ${NO_AGGREGATE}\\.`), `, one value every ${step}.`)
}

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
