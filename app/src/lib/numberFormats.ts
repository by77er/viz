/**
 * One `Intl.NumberFormat` per locale and options for the document (review round 4, M-B1 and D-B3).
 *
 * The system's chart makes its number formats anew on every draw (its `numberFormat` caches them
 * within one call only: README, "Needed from the chart", C7), and constructing one is the costly
 * part of formatting: a profile of a chart's paint at 4x CPU found it a few milliseconds of every
 * draw. A number format holds no state that formatting changes, so one made with the same
 * arguments formats every number the same way: the constructor is wrapped so that it returns the
 * one already made for those arguments. Nothing drawn changes; `instanceof`, the static methods
 * and a call without `new` behave as before. Installed once, before any module makes a format.
 */
const made = new Map<string, Intl.NumberFormat>()
let installed = false

/** The key of a constructor call's arguments, or null when they cannot be keyed (then a new format is made, as before). */
function keyOf(args: unknown[]): string | null {
  try {
    return JSON.stringify(args)
  } catch {
    return null
  }
}

export function shareNumberFormats(): void {
  if (installed || typeof Intl === 'undefined' || typeof Proxy === 'undefined') return
  installed = true
  const Original = Intl.NumberFormat
  Intl.NumberFormat = new Proxy(Original, {
    construct(target, args: unknown[], newTarget) {
      // A subclass (newTarget is not the wrapper) is made as it asks.
      if (newTarget !== Intl.NumberFormat) return Reflect.construct(target, args, newTarget) as object
      const key = keyOf(args)
      if (key === null) return Reflect.construct(target, args) as object
      let f = made.get(key)
      if (!f) {
        f = Reflect.construct(target, args) as Intl.NumberFormat
        made.set(key, f)
      }
      return f
    },
  })
}

/** For checks: how many formats the document holds. */
export const numberFormatsMade = () => made.size
