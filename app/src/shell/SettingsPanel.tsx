import { useEffect, useRef, useState } from 'react'
import { PromApiError, PromClient } from '../api/client'
import { useSettings } from './settings'
import { useTheme, type ThemePref } from './theme'

type TestState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string }

const THEMES: [ThemePref, string][] = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
]

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
    if (test.kind === 'busy') return
    setTest({ kind: 'busy' })
    try {
      const info = await new PromClient({ baseUrl, token }).buildInfo()
      setTest({ kind: 'ok', text: `Connected to ${info.version}${info.mock ? ', the mock backend with synthetic data' : ''}` })
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
      className="vz-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <form
        method="dialog"
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault()
          setSettings({ baseUrl: baseUrl.trim(), token: token.trim() })
          onClose()
        }}
      >
        <h2 id="settings-title" className="vz-dialog-title">
          Change settings
        </h2>
        <div className="vz-field">
          <label htmlFor="set-base" className="vz-label">
            API base URL
          </label>
          <input
            id="set-base"
            className="vz-input"
            data-mono=""
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://viz.example.com"
            aria-describedby="set-base-help"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="vz-help" id="set-base-help">
            <span>
              A Prometheus-compatible API is expected under <span className="app-num">/api/v1</span>. Leave empty to use this origin.
            </span>
          </span>
        </div>
        <div className="vz-field">
          <label htmlFor="set-token" className="vz-label">
            Bearer token
          </label>
          <input
            id="set-token"
            className="vz-input"
            data-mono=""
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-describedby="set-token-help"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="vz-help" id="set-token-help">
            <span>
              Kept in this browser's local storage and sent only as an <span className="app-num">Authorization</span> header. It is never
              put in a URL, so shared links do not contain it.
            </span>
          </span>
          <label className="vz-check">
            <input type="checkbox" checked={showToken} onChange={(e) => setShowToken(e.target.checked)} />
            Show the token
          </label>
        </div>
        <div className="vz-field">
          <span className="vz-label" id="set-theme">
            Theme
          </span>
          <div className="field-row">
            <div className="vz-segmented" role="group" aria-labelledby="set-theme">
              {THEMES.map(([p, label]) => (
                <button key={p} type="button" aria-pressed={pref === p} onClick={() => setPref(p)} data-testid={`theme-${p}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div role="status" className="status-line" data-testid="test-result">
          {test.kind === 'ok' && <span className="vz-status" data-state="ok">{test.text}</span>}
          {test.kind === 'error' && <span className="vz-status" data-state="critical">{test.text}</span>}
        </div>
        <div className="vz-dialog-actions">
          <button type="button" className="vz-button" data-quiet="" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="vz-button" onClick={runTest} aria-busy={test.kind === 'busy'}>
            Test connection
          </button>
          <button type="submit" className="vz-button">
            Save settings
          </button>
        </div>
      </form>
    </dialog>
  )
}
