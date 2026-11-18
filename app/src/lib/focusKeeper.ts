/**
 * Keeps keyboard focus when the focused control goes away (design review M3: "Keep focus and
 * scroll position where they were"; Cancel used to drop focus to the document).
 *
 * A control that is removed or hidden while it has focus leaves `document.activeElement` on
 * the body, and the next Tab starts from the top of the page. This watches for that one case
 * and moves focus to the control that stands in for the one that went:
 *
 *   1. the selector in the departed control's `data-focus-after` (Cancel names Retry),
 *   2. for something inside the result region, the pressed segment of "Show as",
 *   3. the view's main action (Run query), the current navigation link, the first control in main.
 *
 * Focus given up on purpose (a click on empty space) is left alone, and nothing happens
 * while a modal dialog is open: the dialog manages its own focus.
 */

export interface FocusOrigin {
  /** `data-focus-after` of the control that went away. */
  after?: string
  /** It was inside the result region. */
  inRegion: boolean
}

export const REGION_FALLBACK = '.vz-segmented button[aria-pressed="true"]'
export const PAGE_FALLBACKS = ['[data-testid="run"]', 'header nav a[aria-current="page"]', 'header nav a.active', 'main a[href], main button:not([disabled]), main input, main select']

/** The selectors to try, in order, for a control that went away. Pure, so the order is testable. */
export function focusFallbacks(origin: FocusOrigin): string[] {
  return [...(origin.after ? [origin.after] : []), ...(origin.inRegion ? [REGION_FALLBACK] : []), ...PAGE_FALLBACKS]
}

/**
 * Whether a batch of DOM changes can have taken the focus away from `watched`: it was removed,
 * or a class, hidden, disabled or aria-hidden attribute changed on it or on an ancestor. Pure
 * and reads no layout, so the observer can run after every change without forcing a style or
 * layout pass (design review B3: the editor's keystrokes and the crosshair readout change the
 * DOM many times a second).
 */
export function mayLoseFocus(
  records: readonly { type: string; target: { contains(other: unknown): boolean } }[],
  watched: { isConnected: boolean },
): boolean {
  if (!watched.isConnected) return true
  for (const r of records) if (r.type === 'attributes' && r.target.contains(watched)) return true
  return false
}

const shown = (el: Element) => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'

export function installFocusKeeper(doc: Document = document): () => void {
  let last: HTMLElement | null = null
  let origin: FocusOrigin = { inRegion: false }

  const restore = () => {
    // Focus is lost when it is on the body, or still on a control that was just hidden.
    const active = doc.activeElement
    if (active && active !== doc.body && shown(active)) return
    if (!last || shown(last)) return
    if (doc.querySelector('dialog[open]')) return
    const selectors = focusFallbacks(origin)
    last = null
    for (const sel of selectors) {
      let target: HTMLElement | undefined
      try {
        target = [...doc.querySelectorAll<HTMLElement>(sel)].find((el) => shown(el) && !(el as HTMLButtonElement).disabled)
      } catch {
        continue // a selector that does not parse is skipped, not fatal
      }
      if (!target) continue
      void target
      if (doc.activeElement === target) return
    }
  }

  const onFocusIn = (e: FocusEvent) => {
    const t = e.target
    if (!(t instanceof HTMLElement) || t === doc.body) return
    last = t
    origin = { after: t.dataset.focusAfter, inRegion: !!t.closest('.region') }
  }
  // Focus that leaves for nowhere while its control is still there was given up on purpose.
  const onFocusOut = (e: FocusEvent) => {
    if (e.relatedTarget !== null) return
    const t = e.target
    queueMicrotask(() => {
      if (last !== null && last === t && shown(last)) last = null
      else restore()
    })
  }
  // Only a change that can take the focused control away is looked at; everything else (the
  // editor's keystrokes, the crosshair readout, a view mounting) is skipped without reading layout.
  const observer = new MutationObserver((records) => {
    if (last && mayLoseFocus(records, last)) restore()
  })
  doc.addEventListener('focusin', onFocusIn)
  doc.addEventListener('focusout', onFocusOut)
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled', 'aria-hidden'] })
  return () => {
    doc.removeEventListener('focusin', onFocusIn)
    doc.removeEventListener('focusout', onFocusOut)
    observer.disconnect()
  }
}
