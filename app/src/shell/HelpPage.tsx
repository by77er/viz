import { useEffect } from 'react'
import { MOD, useCommandsContext } from './commands'

const SHORTCUTS: [string[], string][] = [
  [[MOD, 'Enter'], 'Run the query, from the editor or anywhere on Explore'],
  [[MOD, 'K'], 'Open the command palette'],
  [['/'], 'Put the cursor in the query editor'],
  [['T'], 'Switch between the chart and its text form'],
  [['Ctrl', 'Space'], 'Open autocomplete in the query editor'],
  [['←', '→'], 'On the chart: move the crosshair one value (with Shift, ten)'],
  [['Home', 'End'], 'On the chart: go to the start or the end of the range'],
  [['+', '−'], 'On the chart: zoom in and out'],
  [['↑', '↓'], 'In the legend: move between series; Space or Enter shows or hides one'],
  [['Esc'], 'Close the command palette; on the chart, remove the crosshair'],
]

export function HelpPage() {
  const { setPaletteOpen } = useCommandsContext()
  useEffect(() => {
    document.title = 'Help · viz'
  }, [])
  return (
    <div className="vz-page">
      <header className="vz-page-head">
        <div>
          <h1 className="vz-page-title">Help</h1>
        </div>
      </header>
      <div className="vz-sections">
        <section className="vz-section" aria-labelledby="help-explore">
          <h2 className="vz-section-title" id="help-explore">
            Explore
          </h2>
          <p className="vz-text">
            Explore runs a PromQL range query against this tenant's metrics. The query, the time range, the step, the unit and the form of the result are in the
            address, so the address bar is always a link you can share. The API key never is.
          </p>
          <p className="vz-text">
            A result has four forms: the chart, a table of the latest value of each series, the chart's facts as sentences, and the API's answer as JSON. The eight
            largest series are drawn in colour; the rest are one grey band, Other, which the legend opens. A series keeps its colour while it stays on screen.
            Missing samples are drawn as gaps.
          </p>
          <p className="vz-text">
            Drag across the chart, or use Zoom in, to look closer at what was fetched. To fetch that range itself, at a finer step, press Query the chart's range.
            Times are typed as "18 Nov 09:16", "09:16" for today, "now" or "now - 6 h", and read in this device's time zone, which the time range states.
          </p>
        </section>
        <section className="vz-section" aria-labelledby="help-dashboards">
          <h2 className="vz-section-title" id="help-dashboards">
            Dashboards
          </h2>
          <p className="vz-text">
            Dashboards lists this tenant's dashboards and shows one at a time, read-only: its panels over a time range, with its variables as controls. The range
            and the variables' values are in the address. Each panel has a text form and a link that opens its query in Explore. A panel of a kind this app does
            not draw yet (a heatmap, a text note) is shown as its text form, and says so. Dashboards cannot be edited here yet, and the key needs the
            dashboards:read scope.
          </p>
        </section>
        <section className="vz-section" aria-labelledby="help-keys">
          <h2 className="vz-section-title" id="help-keys">
            Keyboard
          </h2>
          <div className="vz-table-wrap">
            <table className="vz-table">
              <thead>
                <tr>
                  <th scope="col" className="vz-label">
                    Keys
                  </th>
                  <th scope="col" className="vz-label">
                    What they do
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
          <p className="vz-text">
            The command palette lists the commands of the page it is opened on. Opened here it has the sections, the theme and Sign out; on Explore it also has
            running the query, the forms of the result, the time ranges and Copy link, and on a dashboard its refresh and its text form. It is a shortcut for a
            keyboard: every command is also a control on its page.
          </p>
          <div className="vz-controls">
            <button className="vz-button" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K Meta+K" data-testid="open-commands">
              Open the command palette
            </button>
          </div>
        </section>
        <section className="vz-section" aria-labelledby="help-key">
          <h2 className="vz-section-title" id="help-key">
            API keys
          </h2>
          <p className="vz-text">
            Signing in takes one of the tenant's API keys with the read scope. A key is made by someone who holds an admin key of the tenant, through the control
            API. The key is kept in the tab it was pasted into and nowhere else; Settings shows whose it is and signs out.
          </p>
        </section>
      </div>
    </div>
  )
}
