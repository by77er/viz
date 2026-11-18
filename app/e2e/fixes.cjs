/* eslint-disable */
// End-to-end checks for the fixes to the design review of the restyle
// (design-system/reviews/app-restyle/review.md): B1, B3 (rendering part), M2, M3, M4, M5, M7.
//   node e2e/fixes.cjs            (expects `npm run build` to have run)
//   VIZ_E2E_SKIP_STOP=1 node e2e/fixes.cjs   skips the one check that waits 60 s
// What is checked:
//   B1  while a query waits, after Cancel, after an error and after the 60 s stop, everything
//       that describes data on screen (unit, legend heads and cells, chart name, digest title,
//       table, JSON, the "Automatic" unit) comes from the result on screen, and the panel head
//       says "Showing the previous query"
//   B3  typing in the editor renders nothing in React outside CodeMirror, and autocomplete
//       lookups are debounced
//   M2  eight coloured series at most, ONE Other row, survivors of a filter keep their colour,
//       a reload reproduces the colours
//   M3  document.activeElement is never the body after a control goes away
//   M4  on a coarse pointer a tap toggles a series; Zoom in, Zoom out and Reset zoom exist
//   M5  the legend shows what distinguishes the series; the full name comes with focus
//   M7  the unit is in the column head once, not on every value; CPU cores carry a unit
const lib = require('./lib.cjs')
const { chromium, APP, Q_RATE, Q_CPU, Q_MANY, Q_BAD, url, startServers, setMockDelay } = lib
const { check, results, failed } = lib.makeChecker()
const axe = (page, label) => lib.axe(page, label, check)
const Q_MEM = 'pod_memory_working_set_bytes'
const SKIP_STOP = !!process.env.VIZ_E2E_SKIP_STOP

const ready = async (page) => {
  await page.waitForSelector('[data-testid=legend] tbody tr')
  await page.waitForSelector('[data-testid=chart] canvas')
  await page.evaluate(() => document.fonts.ready)
}
const setQuery = async (page, q) => {
  await page.click('.cm-content')
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(q)
}
/** Everything on the page that describes the data on screen. */
const chrome = (page) =>
  page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() ?? null
    return {
      age: text('[data-testid=age]'),
      stale: text('[data-testid=stale]'),
      range: text('[data-testid=result-range]'),
      heads: [...document.querySelectorAll('[data-testid=legend] thead th')].map((t) => t.textContent.replace(/[↑↓]/g, '').trim()),
      names: [...document.querySelectorAll('[data-testid=legend] tbody button[data-series]')].map((b) => b.getAttribute('data-series')),
      cells: [...document.querySelectorAll('[data-testid=legend] tbody tr:first-child td')].slice(1).map((t) => t.textContent.trim()),
      chartLabel: document.querySelector('[data-testid=chart]')?.getAttribute('aria-label') ?? null,
      caption: text('[data-testid=status]'),
      automatic: text('[data-testid=unit] option'),
      panel: document.querySelector('[data-testid=result]').innerText,
      q: new URL(location.href).searchParams.get('q'),
    }
  })
/** Why `now` is not a description of the `base` result (the one that was on screen before the new query). Empty when it is. */
function mislabelled(now, base, oldQ, newQ) {
  const bad = []
  if (now.age === null || !now.age.startsWith(base.unitInHead)) bad.push(`head unit: "${now.age}"`)
  if (JSON.stringify(now.heads) !== JSON.stringify(base.heads)) bad.push(`legend heads: ${now.heads.join(' | ')}`)
  if (JSON.stringify(now.cells) !== JSON.stringify(base.cells)) bad.push(`legend cells: ${now.cells.join(' | ')}`)
  if (JSON.stringify(now.names) !== JSON.stringify(base.names)) bad.push('legend names changed')
  if (!now.chartLabel || !now.chartLabel.includes(oldQ) || now.chartLabel.includes(newQ)) bad.push(`chart name: "${now.chartLabel}"`)
  if (now.automatic !== base.automatic) bad.push(`unit select: "${now.automatic}"`)
  if (now.range !== base.range) bad.push(`range: "${now.range}"`)
  if (now.stale !== 'Showing the previous query') bad.push(`head notice: "${now.stale}"`)
  if (!now.caption || !now.caption.includes(`previous query, ${oldQ}`)) bad.push(`caption: "${now.caption}"`)
  if (now.q !== newQ) bad.push(`URL q: "${now.q}"`)
  return bad
}
/** The other forms of the result, read while the old result is on screen. Leaves the page on the chart. */
async function otherForms(page, oldQ, newQ) {
  const bad = []
  await page.click('[data-testid=view-text]')
  await page.waitForSelector('[data-testid=text-view] pre')
  const digest = await page.textContent('[data-testid=text-view] pre')
  if (!digest.startsWith(`Query: ${oldQ}\n`) || digest.includes(newQ)) bad.push(`digest title: "${digest.split('\n')[0]}"`)
  if (!/: last [\d.]+\/s, min [\d.]+\/s/.test(digest)) bad.push(`digest values: "${digest.split('\n')[2]}"`)
  await page.click('[data-testid=view-table]')
  await page.waitForSelector('[data-testid=result-table] tbody tr')
  const valueHead = await page.$$eval('[data-testid=result-table] thead th', (ths) => ths.map((t) => t.textContent.trim()).find((t) => t.startsWith('Value')))
  if (valueHead !== 'Value, /s') bad.push(`table head: "${valueHead}"`)
  await page.click('[data-testid=view-json]')
  await page.waitForSelector('[data-testid=result-json] pre')
  const json = await page.textContent('[data-testid=result-json] pre')
  if (!json.includes('"service":"auth"') || json.includes('"pod"')) bad.push('JSON is not the old response')
  await page.click('[data-testid=view-chart]')
  await page.waitForSelector('[data-testid=chart] canvas')
  return bad
}
const active = (page) =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return 'body'
    if (el.closest('.query-well')) return 'query editor'
    return (el.getAttribute('data-testid') || el.getAttribute('data-series') || el.textContent || el.id || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40)
  })
const swatches = (page) =>
  page.$$eval('[data-testid=legend] tbody tr', (rows) => Object.fromEntries(rows.filter((r) => r.querySelector('button[data-series]')).map((r) => [r.querySelector('button').getAttribute('data-series'), r.querySelector('.swatch').style.background])))

async function main() {
  const stop = await startServers()
  try {
    const browser = await chromium.launch()
    const errors = []
    const watch = (page) => page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    // ------------------------------------------------ B1: the result on screen describes itself
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
      const page = await ctx.newPage()
      watch(page)
      await page.goto(url(Q_RATE)); await ready(page)
      const base = await chrome(page)
      base.unitInHead = 'per second (/s)'
      check('B1 baseline: the request-rate result states its unit once in the head and in each column head', base.age.startsWith('per second (/s) · updated') && base.heads.join('|') === 'Series|Last, /s|Min, /s|Max, /s' && base.cells.every((c) => /^[\d.]+k?$/.test(c)) && base.stale === null, `${base.age} — ${base.heads.join(' | ')} — ${base.cells.join(' | ')}`)

      // Waiting: a CPU query is sent and takes 4 s.
      await setMockDelay(4000)
      await setQuery(page, Q_CPU)
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('[data-testid=progress]')
      let now = await chrome(page)
      let bad = mislabelled(now, base, Q_RATE, Q_CPU)
      check('B1 waiting: unit, legend, chart name, range and the unit select describe the result on screen, and the head says "Showing the previous query"', bad.length === 0, bad.join('; ') || `${now.stale} · ${now.age}`)
      check('B1 waiting: nothing in the panel is shown in the pending query\'s unit', !/\b(cores|millicores|CPU)\b/.test(now.panel), (now.panel.match(/.{0,20}\b(cores|millicores|CPU)\b.{0,20}/) || [''])[0])
      const over = await page.locator('[data-testid=chart] .u-over').boundingBox()
      await page.mouse.move(over.x + over.width * 0.5, over.y + over.height * 0.5)
      await page.waitForSelector('.chart-tip', { state: 'visible' })
      const tip = await page.textContent('.chart-tip')
      check('B1 waiting: the crosshair readout keeps the result\'s unit', /\d\/s/.test(tip) && !/cores/.test(tip), tip.slice(19, 70))
      await page.mouse.move(2, 2)
      bad = await otherForms(page, Q_RATE, Q_CPU)
      check('B1 waiting: the digest title, the table head and the JSON are the result\'s, not the pending query\'s', bad.length === 0, bad.join('; '))

      // Cancelled.
      await page.waitForSelector('[data-testid=cancel]')
      await page.click('[data-testid=cancel]')
      await page.waitForSelector('[data-testid=halted]')
      now = await chrome(page)
      bad = [...mislabelled(now, base, Q_RATE, Q_CPU), ...(await otherForms(page, Q_RATE, Q_CPU))]
      check('B1 cancelled: the previous result keeps its own unit, names and titles, and the head still says so', bad.length === 0, bad.join('; ') || `${now.stale} · ${now.age}`)
      await axe(page, 'cancelled, previous query shown')

      // The new query answers: the description follows the new result, and the notice goes.
      await setMockDelay(0)
      await page.click('[data-testid=retry]')
      await page.waitForFunction(() => /cores/.test(document.querySelector('[data-testid=age]')?.textContent || ''))
      now = await chrome(page)
      const baseCpu = { ...now, unitInHead: 'CPU cores' }
      check('B1 answered: the new result describes itself and the notice is gone', now.stale === null && /^CPU cores/.test(now.age) && now.chartLabel.includes(Q_CPU) && !now.chartLabel.includes(Q_RATE) && /^Last, (cores|millicores)$/.test(now.heads[1]), `${now.age} — ${now.heads.join(' | ')}`)

      // Errored after success: nothing of the old result may be left to mislabel.
      await setQuery(page, Q_BAD)
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('[data-testid=error-state]')
      const afterError = await page.evaluate(() => ({ age: !!document.querySelector('[data-testid=age]'), meta: !!document.querySelector('[data-testid=result-meta]'), legend: !!document.querySelector('[data-testid=legend]'), chart: !!document.querySelector('[data-testid=chart]'), status: !!document.querySelector('[data-testid=status]'), panel: document.querySelector('[data-testid=result]').innerText }))
      check('B1 errored after success: no unit, age, legend or chart of the old result is shown under the failed query', !afterError.age && !afterError.meta && !afterError.legend && !afterError.chart && !afterError.status && !/cores|\/s\b/.test(afterError.panel), JSON.stringify({ ...afterError, panel: undefined }))
      // A query that waits after the error brings back the last result that did arrive (the CPU
      // one), and it must be described as itself: not in bytes, and marked as the previous query.
      await setMockDelay(2500)
      await setQuery(page, Q_MEM)
      await page.keyboard.press('Control+Enter')
      await page.waitForSelector('[data-testid=progress]')
      now = await chrome(page)
      bad = mislabelled(now, baseCpu, Q_CPU, Q_MEM)
      check('B1 waiting after an error: the last result that arrived is shown again as itself (CPU cores, not bytes) and marked as the previous query', bad.length === 0 && !/\d (B|KiB|MiB|GiB)\b/.test(now.panel), bad.join('; ') || `${now.stale} · ${now.age}`)
      await setMockDelay(0)
      await page.waitForFunction(() => /bytes/.test(document.querySelector('[data-testid=age]')?.textContent || ''), null, { timeout: 20000 })
      now = await chrome(page)
      check('B1: the memory result states its unit once (head and column heads), with one scale per column', /^bytes, in [KMG]iB · updated/.test(now.age) && /^Last, [KMG]iB$/.test(now.heads[1]) && now.cells.every((c) => /^[\d.]+$/.test(c)), `${now.age} — ${now.heads.join(' | ')} — ${now.cells.join(' | ')}`)

      // Stopped at 60 s.
      if (!SKIP_STOP) {
        await page.goto(url(Q_RATE)); await ready(page)
        const base2 = { ...(await chrome(page)), unitInHead: 'per second (/s)' }
        await setMockDelay(70000)
        await setQuery(page, Q_MEM)
        await page.keyboard.press('Control+Enter')
        await page.waitForSelector('[data-testid=halted]', { timeout: 70000 })
        const halted = await page.textContent('[data-testid=halted]')
        now = await chrome(page)
        bad = [...mislabelled(now, base2, Q_RATE, Q_MEM), ...(await otherForms(page, Q_RATE, Q_MEM))]
        check('B1 stopped at 60 s: the line says so, and the previous result is not shown in bytes', /Stopped after 60 s without an answer\. The previous result is shown\./.test(halted) && bad.length === 0 && !/\d (B|KiB|MiB|GiB)\b/.test(now.panel), bad.join('; ') || halted.replace(/\s+/g, ' ').trim())
        await setMockDelay(0)
      }
      await ctx.close()
    }

    // ------------------------------------------------ M3: focus is never left on the body
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
      const page = await ctx.newPage()
      watch(page)
      const lost = []
      const where = []
      const step = async (name, expected) => {
        await page.waitForTimeout(120)
        const a = await active(page)
        where.push(`${name}: ${a}`)
        if (a === 'body' || (expected && a !== expected)) lost.push(`${name}: focus on ${a}${expected ? `, expected ${expected}` : ''}`)
        return a
      }
      await page.goto(url(Q_RATE)); await ready(page)

      // Cancel, by keyboard and by pointer; then Retry.
      await setMockDelay(5000)
      await page.focus('[data-testid=run]'); await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=cancel]')
      await page.focus('[data-testid=cancel]'); await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=halted]')
      const afterCancel = await step('Cancel (keyboard)', 'retry')
      const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return cs.outlineStyle === 'solid' && cs.outlineWidth === '2px' })
      check('M3: after Cancel by keyboard, focus is on Retry, with the ring', afterCancel === 'retry' && ring, `focus on ${afterCancel}, ring ${ring}`)
      await setMockDelay(0)
      await page.keyboard.press('Enter') // Retry
      await page.waitForSelector('[data-testid=halted]', { state: 'detached' })
      await step('Retry (keyboard)', 'run')
      await setMockDelay(5000)
      await page.click('[data-testid=run]')
      await page.waitForSelector('[data-testid=cancel]')
      await page.click('[data-testid=cancel]')
      await page.waitForSelector('[data-testid=halted]')
      await step('Cancel (pointer)', 'retry')
      await setMockDelay(0)
      await page.click('[data-testid=retry]')
      await page.waitForSelector('[data-testid=halted]', { state: 'detached' })
      await step('Retry (pointer)', 'run')
      await ready(page)

      // Command palette: Escape, and a command that changes the view.
      await page.focus('[data-testid=open-commands]'); await page.keyboard.press('Enter')
      await page.waitForSelector('dialog.palette[open]')
      await page.keyboard.press('Escape')
      await step('close the palette (Escape)', 'open-commands')
      await page.keyboard.press('Enter')
      await page.waitForSelector('dialog.palette[open]')
      await page.keyboard.type('as a table'); await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=result-table] tbody tr')
      await step('run a command from the palette')
      // Settings: Escape, and Save.
      await page.focus('[data-testid=open-settings]'); await page.keyboard.press('Enter')
      await page.waitForSelector('dialog.vz-dialog[open]')
      await page.keyboard.press('Escape')
      await step('close settings (Escape)', 'open-settings')
      await page.keyboard.press('Enter')
      await page.waitForSelector('dialog.vz-dialog[open]')
      await page.focus('dialog[open] button[type=submit]'); await page.keyboard.press('Enter')
      await page.waitForFunction(() => !document.querySelector('dialog[open]'))
      await step('save settings', 'open-settings')

      // Forms of the result: by their buttons, and by the T key while focus is inside the form that goes away.
      for (const v of ['chart', 'text', 'json', 'table']) {
        await page.focus(`[data-testid=view-${v}]`); await page.keyboard.press('Enter')
        await step(`switch to ${v}`, `view-${v}`)
      }
      await page.focus('[data-testid=result-table] .th-button')
      await page.keyboard.press('t') // table -> text: the focused column head is removed
      await page.waitForSelector('[data-testid=text-view] pre')
      await step('T with focus in the table', 'view-text')
      await page.keyboard.press('t') // text -> chart
      await page.waitForSelector('[data-testid=chart] canvas')
      await page.focus('[data-testid=legend] button[data-series]')
      await page.keyboard.press('t') // chart -> text: the focused legend row is hidden
      await page.waitForSelector('[data-testid=text-view] pre')
      await step('T with focus in the legend', 'view-text')
      await page.keyboard.press('t')
      await page.waitForSelector('[data-testid=chart] canvas')

      // Series: isolate, then the button that shows them all again (it removes itself).
      await page.focus('[data-testid=legend] button[data-series=\'{service="checkout"}\']'); await page.keyboard.press('Enter')
      await step('isolate a series', '{service="checkout"}')
      await page.focus('[data-testid=show-all]'); await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=show-all]', { state: 'detached' })
      await step('show all series', '{service="auth"}')

      // Time range: a preset, the absolute form, and the zoom buttons.
      await page.focus('[data-testid=time-range]'); await page.keyboard.press('Enter')
      await page.waitForSelector('role=dialog[name="Time range"]')
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
      await page.waitForSelector('role=dialog[name="Time range"]', { state: 'detached' })
      await step('choose a time preset', 'time-range')
      await page.keyboard.press('Enter')
      await page.waitForSelector('role=dialog[name="Time range"]')
      await page.focus('role=dialog[name="Time range"] >> button[type=submit]'); await page.keyboard.press('Enter')
      await page.waitForSelector('role=dialog[name="Time range"]', { state: 'detached' })
      await step('apply an absolute range', 'time-range')
      for (const z of ['zoom-in', 'zoom-out', 'zoom-reset']) {
        await page.focus(`[data-testid=${z}]`); await page.keyboard.press('Enter')
        await step(z, z)
      }

      // The Other row and its members.
      await page.goto(url(Q_MANY)); await ready(page)
      await page.focus('[data-testid=legend-other]'); await page.keyboard.press('Enter')
      await step('open the Other group', 'legend-other')
      await page.keyboard.press('Enter')
      await step('close the Other group', 'legend-other')

      // States whose only control goes away when it is used.
      // An error with no position in the query (too many points) offers "Run the query again";
      // one with a position offers "Go to character N", which moves focus into the editor.
      await page.goto(url(Q_RATE, '&step=500ms')); await page.waitForSelector('[data-testid=error-fix]')
      const fixLabel = (await page.textContent('[data-testid=error-fix]')).trim()
      await page.focus('[data-testid=error-fix]'); await page.keyboard.press('Enter')
      await step(`"${fixLabel}" from the error state`, 'run')
      await page.waitForSelector('[data-testid=error-fix]')
      await page.goto(url(Q_BAD)); await page.waitForSelector('[data-testid=error-fix]'); await page.waitForSelector('.cm-content')
      await page.focus('[data-testid=error-fix]'); await page.keyboard.press('Enter')
      await step('"Go to character" from the error state', 'query editor')
      await page.goto(url('no_such_metric_total')); await page.waitForSelector('[data-testid=empty-state] button')
      await page.focus('[data-testid=empty-state] button'); await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=empty-state] button', { state: 'detached' })
      await step('show the last 24 h from the empty state', 'time-range')
      await page.goto(`${APP}/explore`); await page.waitForSelector('[data-testid=start-state] a'); await page.waitForSelector('.cm-content')
      await page.focus('[data-testid=start-state] a'); await page.keyboard.press('Enter')
      await ready(page)
      await step('open an example from the start state', 'run')

      check('M3: document.activeElement is never the body after a control goes away or changes', lost.length === 0, lost.join(' | ') || `${where.length} interactions: ${where.join('; ')}`)
      await ctx.close()
    }

    // ------------------------------------------------ B3: typing renders nothing outside the editor
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
      const page = await ctx.newPage()
      watch(page)
      const lookups = []
      page.on('request', (r) => { if (/\/api\/v1\/(labels|label\/|series)/.test(r.url())) lookups.push(r.url()) })
      await page.goto(url(Q_RATE)); await ready(page)
      await page.waitForSelector('.cm-content')
      await page.click('.cm-content')
      await page.keyboard.press('Control+a'); await page.keyboard.press('Delete')
      await page.waitForTimeout(300)
      const before = await page.evaluate(() => ({ ...window.__vizRenders }))
      const n0 = lookups.length
      const typed = 'sum by (route) (rate(http_requests_total{status="500"}[5m]))'
      await page.keyboard.type(typed, { delay: 25 })
      await page.waitForTimeout(600)
      const after = await page.evaluate(() => ({ ...window.__vizRenders }))
      const doc = await page.evaluate(() => document.querySelector('.cm-content').textContent)
      const changed = Object.keys(after).filter((k) => after[k] !== before[k]).map((k) => `${k} +${after[k] - (before[k] || 0)}`)
      check('B3: typing 60 characters renders no React component (the page, the query row, the chart, the legend)', before.ExplorePage > 0 && before.QueryRow > 0 && changed.length === 0 && doc.includes('http_requests_total'), changed.join(', ') || `counts unchanged: ${JSON.stringify(after)}`)
      // 25 ms apart, every label lookup but the last falls inside the debounce of the next.
      const sent = lookups.length - n0
      check('B3: autocomplete lookups are debounced (keys 25 ms apart ask the API at most twice, not once per key)', sent <= 2, `${sent} label lookups for 60 keys`)
      // The text typed is what runs.
      await page.keyboard.press('Control+Enter')
      await page.waitForFunction((q) => new URL(location.href).searchParams.get('q') === q, typed)
      check('B3: the page reads the editor when the query is run', true)
      await ctx.close()
    }

    // ------------------------------------------------ M2: colours; M5 names; M7 units
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
      const page = await ctx.newPage()
      watch(page)
      await page.goto(url(Q_RATE)); await ready(page)
      const all = await swatches(page)
      check('M2: slots are given in palette order as series appear (series-1 to series-4)', JSON.stringify(Object.values(all)) === JSON.stringify([1, 2, 3, 4].map((i) => `var(--series-${i})`)), JSON.stringify(all))
      await setQuery(page, 'sum by (service) (rate(http_requests_total{service=~"catalog|orders"}[5m]))')
      await page.keyboard.press('Control+Enter')
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=legend] tbody button[data-series]').length === 2)
      const survivors = await swatches(page)
      check('M2: survivors keep their colour when a filter removes other series', Object.keys(survivors).length === 2 && Object.entries(survivors).every(([k, v]) => all[k] === v), `${JSON.stringify(survivors)} from ${JSON.stringify(all)}`)
      await page.reload(); await ready(page)
      const reloaded = await swatches(page)
      check('M2: a reload reproduces the assignment', JSON.stringify(reloaded) === JSON.stringify(survivors), JSON.stringify(reloaded))

      await page.goto(url(Q_MANY)); await ready(page)
      const many = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid=legend] tbody tr')]
        const series = rows.filter((r) => r.querySelector('button[data-series]'))
        return {
          coloured: series.map((r) => r.querySelector('.swatch').style.background),
          other: rows.filter((r) => r.querySelector('[data-testid=legend-other]')).map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
          rows: rows.length,
          caption: document.querySelector('[data-testid=legend-caption]').textContent,
          last: series.map((r) => Number(r.querySelectorAll('td')[1].textContent)),
        }
      })
      check('M2: never more than eight coloured series, each on its own series token', many.coloured.length === 8 && new Set(many.coloured).size === 8 && many.coloured.every((c) => /^var\(--series-[1-8]\)$/.test(c)), many.coloured.join(' '))
      check('M2: the other 28 series are ONE legend row, "Other, 28 series"', many.other.length === 1 && /^Other, 28 series/.test(many.other[0]) && many.rows === 9, `${many.rows} rows; ${many.other.join(' / ')}`)
      await page.click('[data-testid=legend-other]')
      const members = await page.$$eval('[data-testid=legend] tbody button[data-series]', (b) => b.map((x) => ({ swatch: x.querySelector('.swatch').style.background, last: Number(x.closest('tr').querySelectorAll('td')[1].textContent) })))
      const smallestColoured = Math.min(...many.last)
      check('M2: the coloured eight are the largest; every member of Other is listed in the neutral ink', members.length === 36 && members.slice(8).every((m) => m.swatch === 'var(--ink-muted)'), `${members.length} rows; smallest coloured last ${smallestColoured}, largest Other last ${Math.max(...members.slice(8).map((m) => m.last))}`)
      await axe(page, '36 series, Other open')
      await page.click('[data-testid=legend-other]')

      // M5: names. Three label values differ, so the name leads with the one that has most values.
      const names = await page.$$eval('[data-testid=legend] tbody button[data-series]', (b) => b.map((x) => ({ shown: x.querySelector('.vz-num').textContent, full: x.getAttribute('data-series'), label: x.getAttribute('title') })))
      check('M5: legend names drop what every series shares and lead with the most distinguishing label; the full label set is the row\'s title', names.every((n) => /^\{route="[^"]+", (service|status)="[^"]+", (service|status)="[^"]+"\}$/.test(n.shown) && n.label === n.full) && new Set(names.map((n) => n.shown)).size === names.length, names[0].shown + ' ← ' + names[0].full)
      await page.goto(url(Q_CPU)); await ready(page)
      const cpu = await page.$$eval('[data-testid=legend] tbody button[data-series]', (b) => b.map((x) => ({ shown: x.querySelector('.vz-num').textContent, full: x.getAttribute('data-series') })))
      await page.focus('[data-testid=legend] tbody button[data-series]')
      const fullLine = await page.textContent('[data-testid=legend-full]').catch(() => null)
      check('M5: a long label set is shown by what distinguishes it, and the full name appears when the row has focus', cpu.every((n) => n.shown.length < n.full.length && !n.shown.includes('pod_cpu_usage_cores')) && new Set(cpu.map((n) => n.shown)).size === cpu.length && !!fullLine && fullLine.includes(cpu[0].full), `${cpu[0].shown} ← ${cpu[0].full}`)

      // M7: CPU cores carry a unit, once per column; no cell repeats it.
      const cores = await chrome(page)
      const table = await page.evaluate(() => [...document.querySelectorAll('[data-testid=legend] tbody td.vz-right')].map((t) => t.textContent.trim()))
      check('M7: CPU cores state their unit in the panel head and once in each column head; the cells are numbers in one scale', /^CPU cores/.test(cores.age) && cores.heads.slice(1).every((h) => /^(Last|Min|Max), (cores|millicores)$/.test(h)) && table.every((c) => /^[\d.]+$|^–$/.test(c)), `${cores.age} — ${cores.heads.join(' | ')} — ${table.slice(0, 6).join(' ')}`)
      const over = await page.locator('[data-testid=chart] .u-over').boundingBox()
      await page.mouse.move(over.x + over.width * 0.3, over.y + over.height * 0.4)
      await page.waitForSelector('.chart-tip', { state: 'visible' })
      const tip = await page.$$eval('.chart-tip .tip-value', (v) => v.filter((x) => x.offsetParent).map((x) => x.textContent))
      check('M7: a value that stands alone (the crosshair readout) carries its unit, at the legend\'s precision', tip.length > 0 && tip.every((t) => /^[\d.]+ (cores|millicores)$/.test(t) && t.replace(/[^\d]/g, '').replace(/^0+/, '').length <= 3), tip.join(' | '))
      await page.goto(url(Q_RATE, '&view=table')); await page.waitForSelector('[data-testid=result-table] tbody tr')
      const t = await page.evaluate(() => ({ heads: [...document.querySelectorAll('[data-testid=result-table] thead th')].map((x) => x.textContent.trim()), cells: [...document.querySelectorAll('[data-testid=result-table] tbody td.vz-right')].map((x) => x.textContent.trim()), caption: document.querySelector('[data-testid=table-caption]').textContent.replace(/\s+/g, ' ') }))
      check('M7: the table states the unit in the Value head, and the shared timestamp once in its caption', t.heads.join('|') === 'service|Value, /s' && t.cells.every((c) => /^[\d.]+$/.test(c)) && /at 2026-11-18 \d\d:\d\d:\d\d\./.test(t.caption), `${t.heads.join(' | ')} — ${t.cells.join(' ')} — ${t.caption}`)
      await ctx.close()
    }

    // ------------------------------------------------ M4: touch
    {
      const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'light' })
      const page = await ctx.newPage()
      watch(page)
      await page.goto(url(Q_RATE)); await ready(page)
      const pressed = () => page.$$eval('[data-testid=legend] button[data-series][aria-pressed=true]', (b) => b.map((x) => x.getAttribute('data-series')))
      const row = '[data-testid=legend] button[data-series=\'{service="checkout"}\']'
      await page.tap(row)
      const off = await pressed()
      await page.tap(row)
      const on = await pressed()
      check('M4: on a coarse pointer a tap on a legend row toggles that series, with no modifier key', off.length === 3 && !off.includes('{service="checkout"}') && on.length === 4, `after one tap ${off.length} shown, after two ${on.length}`)
      const hint = await page.textContent('[data-testid=legend-caption]')
      check('M4: the hint on touch does not mention Shift', /Tap a series to hide or show it/.test(hint) && !/Shift/.test(hint), hint.trim())
      const range = () => page.evaluate(() => { const p = new URL(location.href).searchParams; return [Number(p.get('from')), Number(p.get('to'))] })
      const [f0, t0] = await range()
      await page.tap('[data-testid=zoom-in]')
      await page.waitForFunction((f) => Number(new URL(location.href).searchParams.get('from')) !== f, f0)
      const [f1, t1] = await range()
      await page.tap('[data-testid=zoom-out]')
      await page.waitForFunction((f) => Number(new URL(location.href).searchParams.get('from')) !== f, f1)
      const [f2, t2] = await range()
      await page.tap('[data-testid=zoom-in]')
      await page.waitForFunction((f) => Number(new URL(location.href).searchParams.get('from')) !== f, f2)
      await page.tap('[data-testid=zoom-reset]')
      await page.waitForFunction((f) => Number(new URL(location.href).searchParams.get('from')) === f, f0)
      const [f3, t3] = await range()
      check('M4: Zoom in halves the range around its middle, Zoom out doubles it, Reset zoom returns to the range before zooming', Math.abs((t1 - f1) - (t0 - f0) / 2) < 2 && Math.abs((f1 + t1) - (f0 + t0)) < 4 && Math.abs((t2 - f2) - (t0 - f0)) < 2 && f3 === f0 && t3 === t0, `${(t0 - f0) / 60000} min → ${(t1 - f1) / 60000} → ${(t2 - f2) / 60000} → ${(t3 - f3) / 60000}`)
      await ready(page)
      await axe(page, 'coarse pointer, 400 px')
      await ctx.close()
    }

    check('no page errors', errors.length === 0, errors.slice(0, 5).join(' || '))
    await browser.close()
  } finally {
    await setMockDelay(0).catch(() => {})
    stop()
  }
  console.log(`\n${results.length - failed()}/${results.length} checks passed`)
  process.exit(failed() ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
