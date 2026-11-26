import { NO_AGGREGATE } from './spec'

/**
 * Words the chart writes that an application's result needs otherwise. Each is a gap in the
 * reference chart, listed in README.md under "Needed changes in the design system"; this is
 * the whole of what the app changes in what the chart writes.
 *
 * - A result with no unit: the chart writes "Last, " and "title, , range". The comma that
 *   introduces the missing unit is removed.
 * - The text form says "every 0.25 min, <aggregate>" (it assumes steps of whole minutes and an
 *   aggregate per step). A range query has neither: it says "one value every 15 s".
 */
export const fixHead = (text: string) => (text.endsWith(', ') ? text.slice(0, -2) : text)
export const fixName = (text: string) => text.replace(', , ', ', ')
export function fixText(line: string, step: string): string {
  return line.replace(', , ', ', ').replace(new RegExp(`, every [^,]+ min, ${NO_AGGREGATE}\\.`), `, one value every ${step}.`)
}
