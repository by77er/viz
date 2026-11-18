import { MOD } from './commands'
import { useBackendInfo } from './AppShell'

const SHORTCUTS: [string[], string][] = [
  [[MOD, 'Enter'], 'Run the query (in the editor or anywhere on Explore)'],
  [[MOD, 'K'], 'Open the command palette'],
  [['/'], 'Focus the query editor'],
  [['T'], 'Switch between the chart and the text form'],
  [['Ctrl', 'Space'], 'Open autocomplete in the query editor'],
  [['←', '→'], 'Move the cursor along the focused chart (with Shift, 10 steps)'],
  [['Esc'], 'Close a dialog, a popover or the chart cursor'],
]

export function HelpPage() {
  const info = useBackendInfo()
  return (
    <div className="page" data-prose="">
      <h1 className="vz-text-title">Keyboard shortcuts and help</h1>
      <section className="vz-panel" aria-labelledby="help-keys">
        <div className="vz-panel-head">
          <h2 className="vz-panel-title" id="help-keys">
            Keyboard shortcuts
          </h2>
        </div>
        <div className="vz-table-wrap">
          <table className="vz-table">
            <thead>
              <tr>
                <th scope="col" className="vz-label">
                  Keys
                </th>
                <th scope="col" className="vz-label">
                  What it does
                </th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.map(([keys, text]) => (
                <tr key={text}>
                  <td>
                    <span className="keys">
                      {keys.map((k) => (
                        <span key={k} className="vz-kbd">
                          {k}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="cell-wrap">{text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="prose" aria-label="About Explore">
        <h2>Explore</h2>
        <p>
          Explore runs a PromQL range query against a Prometheus-compatible API. The query, the time range, the step and the form of the
          result are all in the URL, so the address bar is always a link you can share. Drag across the chart to zoom into a time range;
          the browser's Back button undoes it. Select a legend row to show only that series ({MOD}-click to add or remove more).
        </p>
        <p>
          Every result has four forms: the chart, a table of the latest values, a text digest (last, min, max, mean and trend per series)
          for screen readers and agents, and the raw response as JSON.
        </p>
        <p>
          When more samples are returned than the chart has pixel columns, each column draws its minimum and maximum, so spikes are never
          averaged away. Missing samples are drawn as gaps, not interpolated. A chart colours at most eight series; the rest are drawn in
          grey and named Other.
        </p>
        <h2>Backend</h2>
        <p>
          {info.data
            ? `Connected to ${info.data.version}${info.data.mock ? ', the development mock: synthetic data and a subset of PromQL.' : '.'}`
            : info.isError
              ? 'The backend did not report build information.'
              : 'Checking the backend.'}{' '}
          The API URL and token are set in Settings and kept only in this browser.
        </p>
      </section>
    </div>
  )
}
