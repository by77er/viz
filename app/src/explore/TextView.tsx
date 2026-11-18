import { memo } from 'react'
import { CopyButton } from './CopyButton'

/** The text form of the result: the digest an agent or a screen reader gets. */
export const TextView = memo(function TextView({ text }: { text: string }) {
  return (
    <div data-testid="text-view" className="region-part">
      <div className="caption-row">
        <p className="vz-panel-desc">The same result as text: last, min, max, mean and trend of each series.</p>
        <CopyButton text={() => text} label="Copy text" />
      </div>
      <pre className="vz-query code-scroll code-wrap" tabIndex={0} role="region" aria-label="Text digest of the query result">
        {text}
      </pre>
    </div>
  )
})
