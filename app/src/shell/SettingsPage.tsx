import { useBackendInfo } from './AppShell'
import { useSession } from './session'
import { useTheme, type ThemePref } from './theme'

const THEMES: [ThemePref, string][] = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
]

/** What this browser holds for viz: the key it is signed in with, and the theme. Edited in place; nothing here is a dialog. */
export function SettingsPage() {
  const { session, keyLabel, signOut } = useSession()
  const { pref, setPref } = useTheme()
  const info = useBackendInfo()
  const identity = session.status === 'in' ? session.identity : null
  return (
    <div className="vz-page">
      <header className="vz-page-head">
        <div>
          <h1 className="vz-page-title">Settings</h1>
        </div>
      </header>
      <div className="vz-sections">
        <section className="vz-section" aria-labelledby="set-key" data-testid="settings-key">
          <h2 className="vz-section-title" id="set-key">
            API key
          </h2>
          {session.status === 'in' && identity ? (
            <>
              <dl className="vz-kv">
                <dt>Tenant</dt>
                <dd className="vz-num">{identity.tenant}</dd>
                <dt>Key</dt>
                <dd>
                  {identity.name ?? 'unnamed'}
                  {keyLabel ? (
                    <>
                      {' '}
                      (<span className="vz-qty">{keyLabel}</span>)
                    </>
                  ) : null}
                </dd>
                <dt>Kind</dt>
                <dd>{identity.kind === 'agent' ? 'an agent\'s key' : 'a key'}</dd>
                <dt>Scopes</dt>
                <dd className="vz-num">{identity.scopes.length ? identity.scopes.join(', ') : 'none'}</dd>
                <dt>Kept</dt>
                <dd>in this tab, until you sign out or close it</dd>
              </dl>
              <div className="vz-controls">
                <button className="vz-button" onClick={() => signOut('left')} data-testid="sign-out">
                  Sign out
                </button>
              </div>
            </>
          ) : session.status === 'in' && session.unchecked === 'no-control' ? (
            <p className="vz-text">This API has no sign-in: it answered HTTP 404 to the question of whose key this is. Requests are sent without a key.</p>
          ) : session.status === 'in' ? (
            <>
              <p className="vz-text">
                This tab holds a key{keyLabel ? <> (<span className="vz-qty">{keyLabel}</span>)</> : null}, but the API did not answer when asked whose it is. Queries are sent with it and say
                if it is refused.
              </p>
              <div className="vz-controls">
                <button className="vz-button" onClick={() => signOut('left')} data-testid="sign-out">
                  Sign out
                </button>
              </div>
            </>
          ) : session.status === 'checking' ? (
            <p className="vz-text">Asking the API who this tab's key is.</p>
          ) : (
            <p className="vz-text">Not signed in. Explore asks for a key.</p>
          )}
        </section>
        <section className="vz-section" aria-labelledby="set-theme">
          <h2 className="vz-section-title" id="set-theme">
            Theme
          </h2>
          <div className="vz-controls">
            <div className="vz-segmented" role="group" aria-labelledby="set-theme">
              {THEMES.map(([p, label]) => (
                <button key={p} type="button" aria-pressed={pref === p} onClick={() => setPref(p)} data-testid={`theme-${p}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="vz-secondary">System follows this device's setting. The choice is kept in this browser.</p>
        </section>
        <section className="vz-section" aria-labelledby="set-api">
          <h2 className="vz-section-title" id="set-api">
            API
          </h2>
          <dl className="vz-kv">
            <dt>Address</dt>
            <dd className="vz-num">{window.location.origin}/api/v1</dd>
            <dt>Version</dt>
            <dd className="vz-num" data-testid="api-version">
              {info.data ? `${info.data.version}${info.data.revision ? ` (${info.data.revision})` : ''}` : info.isError ? 'not reported' : session.status === 'in' ? 'asking' : 'shown once signed in'}
            </dd>
          </dl>
        </section>
      </div>
    </div>
  )
}
