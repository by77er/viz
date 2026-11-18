import { CopyButton } from './CopyButton'

/** The text form of the result: the digest an agent or a screen reader gets. */
export function TextView({ text }: { text: string }) {
  return (
    <div data-testid="text-view" className="flex flex-col">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] text-fg-3">
        <span>Text digest of this result: last, min, max, mean and trend per series. The same data as the chart.</span>
        <CopyButton text={() => text} label="Copy text" />
      </div>
      <pre
        className="mono m-0 flex-1 overflow-auto whitespace-pre-wrap break-words border-t border-line px-2.5 py-2 text-[12px] leading-[1.6] text-fg"
        tabIndex={0}
        role="region"
        aria-label="Text digest of the query result"
        style={{ maxHeight: 520 }}
      >
        {text}
      </pre>
    </div>
  )
}
