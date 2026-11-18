import { useMemo } from 'react'
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

export function JsonView({ data }: { data: PromMatrixData }) {
  const text = useMemo(() => formatResponse(data), [data])
  const truncated = text.length > MAX_CHARS
  return (
    <div data-testid="result-json">
      <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5 text-[12px] text-fg-3">
        <span>
          Response of <span className="mono">/api/v1/query_range</span> · <span className="tnum">{(text.length / 1024).toFixed(1)}</span> KiB
          {truncated && ` · showing the first ${Math.round(MAX_CHARS / 1024)} KiB (Copy copies all of it)`}
        </span>
        <CopyButton text={() => text} label="Copy JSON" />
      </div>
      <pre className="mono max-h-[420px] overflow-auto whitespace-pre-wrap break-all p-2.5 text-[11.5px] leading-[1.5] text-fg-2" tabIndex={0} aria-label="Raw JSON response">
        {truncated ? `${text.slice(0, MAX_CHARS)}\n…` : text}
      </pre>
    </div>
  )
}
