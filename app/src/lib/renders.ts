/**
 * Render counts by component, read by the end-to-end checks (`window.__vizRenders`) to prove
 * that an interaction re-renders only what it must: a keystroke in the query editor must not
 * render the Explore page (design review B3). Counting is one increment per render.
 */
const counts: Record<string, number> = {}

export function countRender(name: string): void {
  counts[name] = (counts[name] ?? 0) + 1
}

if (typeof window !== 'undefined') (window as unknown as { __vizRenders: Record<string, number> }).__vizRenders = counts
