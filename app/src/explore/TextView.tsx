import { memo, useRef } from 'react'
import { CopyButton } from './CopyButton'

/**
 * The text form of the result: the chart's own facts in sentences (Chart, "Text form"), which
 * the chart writes into the element with `id` whenever it draws. It is the same model as the
 * plot, the legend and the readout, so the three cannot disagree. The element is always in the
 * page; `hidden` shows it only when this form is chosen.
 */
export const TextView = memo(function TextView({ id, hidden }: { id: string; hidden: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div data-testid="text-view" hidden={hidden}>
      <p className="vz-table-caption">What the chart shows, in sentences: for reading aloud, for copying, for an agent.</p>
      <div className="vz-text-form" id={id} ref={ref} tabIndex={0} role="region" aria-label="Text form of the query result" />
      <div className="vz-controls">
        <CopyButton text={() => [...(ref.current?.querySelectorAll('li') ?? [])].map((li) => li.textContent).join('\n')} label="Copy text" />
      </div>
    </div>
  )
})
