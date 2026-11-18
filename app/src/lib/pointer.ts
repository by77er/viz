import { useSyncExternalStore } from 'react'

/**
 * Whether a press on a legend row adds or removes that one series (true) or shows it alone
 * (false). With a mouse that takes Shift, Ctrl or Cmd; a finger has no modifier key, so a tap
 * always toggles (design review M4). The keyboard on a touch device toggles too.
 */
export function additiveToggle(
  e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; pointerType?: string },
  coarse: boolean,
): boolean {
  if (e.shiftKey || e.ctrlKey || e.metaKey) return true
  if (e.pointerType === 'touch' || e.pointerType === 'pen') return true
  return coarse && e.pointerType !== 'mouse'
}

const QUERY = '(pointer: coarse)'
const subscribe = (onChange: () => void) => {
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/** True when the primary pointer is a finger. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}
