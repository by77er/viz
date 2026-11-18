import { useState } from 'react'

export function CopyButton({ text, label = 'Copy' }: { text: () => string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  return (
    <button
      className="btn"
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
      <span aria-live="polite">{state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}</span>
    </button>
  )
}
