import { MOD } from './commands'
import { useBackendInfo } from './AppShell'

const SHORTCUTS: [string[], string][] = [
  [[MOD, 'Enter'], 'Run the query (in the editor or anywhere on Explore)'],
  [[MOD, 'K'], 'Open the command palette'],
  [['/'], 'Focus the query editor'],
  [['T'], 'Toggle between the chart and the text view'],
  [['Ctrl', 'Space'], 'Open autocomplete in the query editor'],
  [['←', '→'], 'Move the cursor along the focused chart (Shift: 10 steps)'],
  [['Esc'], 'Close a dialog, popover, or the chart cursor'],
]

export function HelpPage() {
  const info = useBackendInfo()
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 p-4">
      <h1 className="text-[16px] font-semibold">Keyboard shortcuts &amp; help</h1>
      <section className="panel overflow-hidden" aria-label="Keyboard shortcuts">
        <table className="dt">
          <thead>
            <tr>
              <th scope="col">
                <span>Keys</span>
              </th>
              <th scope="col">
                <span>Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map(([keys, text]) => (
              <tr key={text}>
                <td className="w-[150px]">
                  {keys.map((k) => (
                    <span key={k} className="kbd mr-1">
                      {k}
                    </span>
                  ))}
                </td>
                <td className="!whitespace-normal">{text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="flex flex-col gap-2 text-fg-2">
        <h2 className="text-[13px] font-semibold text-fg">Explore</h2>
        <p>
          Explore runs a PromQL range query against a Prometheus-compatible API. The query, the time range, the step and the view are all in
          the URL, so the address bar is always a shareable link. Drag across the chart to zoom into a time range; the browser's Back button
          undoes it. Click a legend row to isolate one series ({MOD}-click to add or remove more).
        </p>
        <p>
          Every result has three forms: the chart, a text digest (per series last, min, max, mean and trend) for screen readers and agents,
          and the raw response as JSON.
        </p>
        <p>
          When more samples are returned than the chart has pixel columns, each column draws that column's minimum and maximum, so spikes are
          never averaged away. Missing samples are drawn as gaps, not interpolated.
        </p>
        <h2 className="mt-2 text-[13px] font-semibold text-fg">Backend</h2>
        <p>
          {info.data
            ? `Connected to ${info.data.version}${info.data.mock ? ' — the development mock: synthetic data, PromQL subset.' : '.'}`
            : info.isError
              ? 'The backend did not report build information.'
              : 'Checking the backend…'}{' '}
          The API URL and token are set in Settings and stored only in this browser.
        </p>
      </section>
    </div>
  )
}
