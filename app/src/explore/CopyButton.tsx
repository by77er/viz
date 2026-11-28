import { useState, type Ref } from 'react'

/** Copying has no visible result, so the label says what happened for a moment. */
export function CopyButton({ text, label = 'Copy', buttonRef, testId }: { text: () => string; label?: string; buttonRef?: Ref<HTMLButtonElement>; testId?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  return (
    <button
      ref={buttonRef}
      data-testid={testId}
      className="vz-button"
      data-size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text())
          setState('done')
        } catch {
          setState('failed')
        }
        setTimeout(() => setState('idle'), 1500)
      }}
    >
      <span aria-live="polite">{state === 'done' ? 'Copied' : state === 'failed' ? 'Could not copy' : label}</span>
    </button>
  )
}
