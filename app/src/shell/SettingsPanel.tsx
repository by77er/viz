import { useEffect, useRef, useState } from 'react'
import { PromApiError, PromClient } from '../api/client'
import { useSettings } from './settings'
import { useTheme, type ThemePref } from './theme'

type TestState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string }

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, setSettings } = useSettings()
  const { pref, setPref } = useTheme()
  const ref = useRef<HTMLDialogElement>(null)
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [token, setToken] = useState(settings.token)
  const [showToken, setShowToken] = useState(false)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setBaseUrl(settings.baseUrl)
      setToken(settings.token)
      setShowToken(false)
      setTest({ kind: 'idle' })
      d.showModal()
    } else if (!open && d.open) d.close()
  }, [open, settings])

  const runTest = async () => {
    setTest({ kind: 'busy' })
    try {
      const info = await new PromClient({ baseUrl, token }).buildInfo()
      setTest({ kind: 'ok', text: `Connected: ${info.version}${info.mock ? ' (mock backend, synthetic data)' : ''}` })
    } catch (e) {
      // A backend without buildinfo still answers label queries.
      if (e instanceof PromApiError && e.status === 404) {
        try {
          const labels = await new PromClient({ baseUrl, token }).labels()
          setTest({ kind: 'ok', text: `Connected (${labels.length} label names)` })
          return
        } catch (e2) {
          setTest({ kind: 'error', text: e2 instanceof Error ? e2.message : String(e2) })
          return
        }
      }
      setTest({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="settings-title"
      className="fixed left-1/2 top-[14vh] m-0 w-[480px] -translate-x-1/2"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <form
        method="dialog"
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          setSettings({ baseUrl: baseUrl.trim(), token: token.trim() })
          onClose()
        }}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 id="settings-title" className="text-[14px] font-semibold">
            Settings
          </h2>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close settings" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="flex flex-col gap-4 px-4 py-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="set-base" className="label">
              API base URL
            </label>
            <input
              id="set-base"
              className="input mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="same origin (e.g. https://viz.example.com)"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-[12px] text-fg-3">
              A Prometheus-compatible API is expected under <span className="mono">/api/v1</span>. Leave empty to use this origin.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="set-token" className="label">
              Bearer token
            </label>
            <div className="flex gap-2">
              <input
                id="set-token"
                className="input mono flex-1"
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="none"
                spellCheck={false}
                autoComplete="off"
              />
              <button type="button" className="btn" aria-pressed={showToken} onClick={() => setShowToken((s) => !s)}>
                {showToken ? 'Hide' : 'Show'}
              </button>
            </div>
            <p className="text-[12px] text-fg-3">
              Stored in this browser's localStorage and sent only as an <span className="mono">Authorization</span> header. It is never put
              in a URL, so shared links do not contain it.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="label" id="set-theme">
              Theme
            </span>
            <div className="seg self-start" role="group" aria-labelledby="set-theme">
              {(['system', 'light', 'dark'] as ThemePref[]).map((p) => (
                <button key={p} type="button" aria-pressed={pref === p} onClick={() => setPref(p)}>
                  {p[0]!.toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div role="status" className="min-h-[18px] text-[12px]">
            {test.kind === 'busy' && <span className="text-fg-3">Testing…</span>}
            {test.kind === 'ok' && <span className="text-fg-2">✓ {test.text}</span>}
            {test.kind === 'error' && <span className="text-danger">✕ {test.text}</span>}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          <button type="button" className="btn" onClick={runTest} disabled={test.kind === 'busy'}>
            Test connection
          </button>
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Save
            </button>
          </div>
        </div>
      </form>
    </dialog>
  )
}
