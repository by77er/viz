import { memo, useMemo } from 'react'
import type { PromMatrixData } from '../api/types'
import { CopyButton } from './CopyButton'

const MAX_CHARS = 60_000

/** Compact pretty-printer: one sample per line would be too long, so values stay inline. */
export function formatResponse(data: PromMatrixData): string {
  const series = data.result.map(
    (s) => `      {\n        "metric": ${JSON.stringify(s.metric)},\n        "values": ${JSON.stringify(s.values)}\n      }`,
  )
  return `{\n  "status": "success",\n  "data": {\n    "resultType": "matrix",\n    "result": [${series.length ? `\n${series.join(',\n')}\n    ` : ''}]\n  }\n}`
}

/** One rendering per response, kept while the response is: the form can be left and shown again without redoing it. */
const rendered = new WeakMap<PromMatrixData, string>()
function cachedResponse(data: PromMatrixData): string {
  let text = rendered.get(data)
  if (text === undefined) rendered.set(data, (text = formatResponse(data)))
  return text
}

export const JsonView = memo(function JsonView({ data, elapsedMs }: { data: PromMatrixData; elapsedMs?: number }) {
  const text = useMemo(() => cachedResponse(data), [data])
  const truncated = text.length > MAX_CHARS
  return (
    <div data-testid="result-json" className="region-part">
      <div className="caption-row">
        <p className="vz-panel-desc">
          The response of <span className="app-num">/api/v1/query_range</span>, <span className="app-num">{(text.length / 1024).toFixed(1)}</span> KiB
          {elapsedMs !== undefined && (
            <>
              , answered in <span className="app-num">{elapsedMs < 10 ? elapsedMs.toFixed(1) : Math.round(elapsedMs).toLocaleString('en-US')}</span> ms
            </>
          )}
          {truncated ? `. Showing the first ${Math.round(MAX_CHARS / 1024)} KiB; Copy JSON copies all of it.` : '.'}
        </p>
        <CopyButton text={() => text} label="Copy JSON" />
      </div>
      <pre className="vz-query code-scroll code-wrap" tabIndex={0} aria-label="Raw JSON response">
        {truncated ? `${text.slice(0, MAX_CHARS)}\n…` : text}
      </pre>
    </div>
  )
})
