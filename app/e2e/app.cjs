/* eslint-disable */
// End-to-end checks of the app on design system v9: the Explore view on the system's chart,
// sign-in, and every finding of the first design review (design-system/reviews/app-restyle/
// review.md) checked again on this build. Needs `npm run build`. Starts the mock and
// `vite preview` itself (ports VIZ_E2E_APP_PORT, VIZ_E2E_MOCK_PORT) and a second mock that
// requires a key (mock port + 10) with its own preview (app port + 20), and stops them.
//
//   node e2e/app.cjs            every check
//   VIZ_SLOW=1 node e2e/app.cjs also the 10 s and 60 s rows of the waiting table (about 75 s more)
//   VIZ_ONLY=signin,b1 node e2e/app.cjs   only the named sections
//
// Each check is named for what a person would see. A finding of the review is named by its
// id (B1 to B3, M1 to M8, m1 to m11) in the check's name.
const lib = require('./lib.cjs')
const { chromium, APP, MOCK, T0, T1, Q_RATE, Q_CPU, Q_P95, Q_MANY, Q_BAD, url, tokenRgb, allowedColours, makeChecker, setMockDelay, setMockFailure, axe, hitAreas } = lib
const { check, failed, results } = makeChecker()
const only = (process.env.VIZ_ONLY || '').split(',').filter(Boolean)
const want = (name) => only.length === 0 || only.includes(name)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const Q_MEM = 'pod_memory_working_set_bytes'
const Q_UP = 'up'
const Q_5XX = 'sum by (service, route, status) (rate(http_requests_total{status="500"}[5m]))'

/** The chart has drawn the result: lines in the plot and rows in the legend. */
const ready = async (page) => {
  await page.waitForSelector('[data-testid=chart] svg.vz-plot .vz-line', { state: 'attached' })
  await page.waitForSelector('[data-testid=chart] tbody tr[data-key]', { state: 'attached' })
  await page.evaluate(() => document.fonts.ready)
}
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, sel)
const legend = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid=chart] tbody tr[data-key]')].map((tr) => ({
      key: tr.dataset.key,
      name: tr.querySelector('.vz-series-name')?.textContent ?? '',
      slot: tr.querySelector('.vz-swatch')?.dataset.series ?? '',
      last: tr.querySelector('[data-c=last]')?.textContent ?? '',
      title: tr.getAttribute('title') ?? '',
      selected: tr.getAttribute('aria-selected') === 'true',
    })),
  )
const head = (page) =>
  page.evaluate(() => ({
    meta: document.querySelector('[data-testid=result-meta]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    note: document.querySelector('[data-testid=stale]')?.textContent ?? null,
    lastHead: document.querySelector('[data-testid=chart] thead [data-col=last]')?.textContent ?? '',
    name: document.querySelector('[data-testid=chart] svg.vz-plot')?.getAttribute('aria-label') ?? '',
    query: document.querySelector('[data-testid=result-query]')?.textContent ?? '',
    unit: document.querySelector('[data-testid=chart] .vz-axis-unit')?.textContent ?? '',
    unitOption: document.querySelector('[data-testid=unit] option')?.textContent ?? '',
    form: document.querySelector('#explore-text li')?.textContent ?? '',
    title: document.querySelector('#result-title')?.textContent ?? '',
  }))
const blueButtons = (page, blues) =>
  page.evaluate((blues) => {
    const out = []
    for (const el of document.querySelectorAll('body *')) {
      if (el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden') continue
      if (blues.includes(getComputedStyle(el).backgroundColor)) out.push((el.textContent || el.tagName).trim().slice(0, 30))
    }
    return out
  }, blues)
/** Every rendered element's colours (and its ::before, ::after, ::placeholder) that are not token values. */
const offTokenColours = (page, allowed) =>
  page.evaluate((allowed) => {
    const ok = new Set(allowed)
    const out = []
    const colourRe = /rgba?\([^)]+\)/g
    const sides = ['Top', 'Right', 'Bottom', 'Left']
    const name = (el, pseudo) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}${pseudo || ''}`
    const visit = (el, pseudo) => {
      const cs = getComputedStyle(el, pseudo)
      if ((pseudo === '::before' || pseudo === '::after') && (cs.content === 'none' || cs.content === 'normal')) return
      const bad = (prop, v) => { if (!ok.has(v)) out.push(`${name(el, pseudo)} ${prop} ${v}`) }
      bad('color', cs.color)
      bad('background-color', cs.backgroundColor)
      for (const s of sides) if (parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none') bad(`border-${s.toLowerCase()}-color`, cs[`border${s}Color`])
      if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) bad('outline-color', cs.outlineColor)
      if (cs.textDecorationLine !== 'none') bad('text-decoration-color', cs.textDecorationColor)
      if (cs.caretColor !== 'auto') bad('caret-color', cs.caretColor)
      if (el instanceof SVGElement && el.tagName !== 'svg') { if (cs.fill !== 'none' && /^(text|tspan|rect|circle|path|polygon|ellipse)$/.test(el.tagName)) bad('fill', cs.fill); if (cs.stroke !== 'none') bad('stroke', cs.stroke) } // a line and a group paint no fill
      for (const prop of ['boxShadow', 'backgroundImage']) for (const c of cs[prop].match(colourRe) || []) bad(prop, c)
    }
    for (const el of [document.documentElement, ...document.querySelectorAll('body, body *')]) {
      if (el.getClientRects().length === 0 || /^(SCRIPT|STYLE)$/.test(el.tagName) || getComputedStyle(el).visibility === 'hidden') continue
      visit(el)
      visit(el, '::before')
      visit(el, '::after')
      if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) visit(el, '::placeholder')
    }
    return [...new Set(out)]
  }, allowed)
/** The focused element, and whether the system's ring is drawn for it: its own outline, the query well's, or a legend row's inset shadow. */
const focusStop = (page, focusRgb) =>
  page.evaluate((focusRgb) => {
    const el = document.activeElement
    if (!el || el === document.body) return { name: 'body', ring: false }
    const well = el.closest('.query-well')
    const cs = getComputedStyle(well || el)
    let ring = cs.outlineStyle === 'solid' && cs.outlineWidth === '2px' && cs.outlineColor === focusRgb
    if (!ring && el.matches('.vz-series')) ring = getComputedStyle(el.closest('td')).boxShadow.includes(focusRgb)
    return { name: (well ? 'query editor' : el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40), ring }
  }, focusRgb)
const typeQuery = async (page, q) => {
  await page.click('.query-well .cm-content')
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(q)
}
const runQuery = async (page, q) => {
  await typeQuery(page, q)
  await page.keyboard.press('Control+Enter')
}

async function main() {
  const stop = await lib.startServers()
  // A second API that needs a key, as viz does, for the sign-in checks.
  const KEYED_MOCK = `http://127.0.0.1:${lib.MOCK_PORT + 10}`
  const KEYED = `http://127.0.0.1:${lib.APP_PORT + 20}`
  const stopKeyedMock = await lib.startMock(lib.MOCK_PORT + 10, ['--require-token', 'viz_e2eReadKey0000000_goodSecret', '--readless-token', 'viz_e2eWriteKey000000_writeOnly'])
  const stopKeyed = await lib.startPreview(lib.APP_PORT + 20, KEYED_MOCK)
  const browser = await chromium.launch()
  const pageErrors = []
  const newPage = async (options = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', ...options })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => pageErrors.push(e.message))
    return { ctx, page }
  }
  try {
    // ------------------------------------------------ the main flow
    if (want('flow')) {
      const { ctx, page } = await newPage()
      await page.goto(url(Q_RATE))
      await ready(page)
      const rows = await legend(page)
      const h = await head(page)
      check('a link opens the chart: four lines, four legend rows, largest first in slot 1', rows.length === 4 && rows[0].name === 'catalog' && rows.map((r) => r.slot).join() === '1,2,3,4', JSON.stringify(rows.map((r) => [r.name, r.slot])))
      check('the head states the range of what is drawn, its step and its age (Panel)', /^18 Nov, 09:30 to 12:30 ?· every 15 s ?· updated just now$/.test(h.meta), h.meta)
      check('the panel names the query its data answers, visibly and in the title a screen reader hears', h.query === Q_RATE && h.title === `Query result: ${Q_RATE}`, `${h.query} | ${h.title}`)
      check('the page has one h1, "Explore", and the navigation marks the section', (await text(page, 'h1')) === 'Explore' && (await text(page, '.vz-nav a[aria-current=page]')) === 'Explore')
      check('the tenant of the key is in the navigation, as text', (await text(page, '[data-testid=tenant]')) === 'viz-mock')
      const state = await page.evaluate(() => ({ ls: Object.keys(localStorage), ss: Object.keys(sessionStorage) }))
      check('nothing but the theme (localStorage) and the key, its identity, the colour map and the reserved height (this tab) is stored', state.ls.every((k) => ['viz.theme'].includes(k)) && state.ss.every((k) => ['vz-series8:explore', 'viz.chart.reserve:explore', 'viz.key', 'viz.identity'].includes(k)), JSON.stringify(state))

      // The forms of the result.
      await page.click('[data-testid=view-table]')
      await page.waitForSelector('[data-testid=result-table] tbody tr')
      const table = await page.evaluate(() => ({
        caption: document.querySelector('[data-testid=table-caption]').textContent.replace(/\s+/g, ' ').trim(),
        heads: [...document.querySelectorAll('[data-testid=result-table] th')].map((th) => th.textContent.trim()),
        rows: [...document.querySelectorAll('[data-testid=result-table] tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent)),
        right: getComputedStyle(document.querySelector('[data-testid=result-table] tbody td:last-child')).textAlign,
      }))
      check('table: the caption says how many rows of how many and their order, and the rows are in it (Table)', table.caption.startsWith('4 of 4 series, highest value first.') && table.rows.map((r) => r[0]).join() === 'catalog,auth,orders,checkout', `${table.caption} | ${table.rows.map((r) => r[0])}`)
      check('m2: the one timestamp every row shares is said once, in the caption; there is no "At" column', /at 18 Nov 12:30\.$/.test(table.caption) && !table.heads.includes('At'), table.caption)
      check('M7: the table states the unit once, in the head; cells are bare numbers, right-aligned, the legend\'s figures', table.heads.join('|') === 'service|Value, /s' && table.rows.every((r) => /^[\d,.]+$/.test(r[1])) && table.right === 'right' && table.rows.map((r) => r[1]).join() === rows.map((r) => r.last).join(), JSON.stringify(table.rows))
      await page.click('[data-testid=result-table] th:first-child .vz-sort')
      const sortedCaption = await text(page, '[data-testid=table-caption]')
      const sortedRows = await page.evaluate(() => [...document.querySelectorAll('[data-testid=result-table] tbody tr')].map((tr) => tr.cells[0].textContent))
      check('table: sorting by a label re-states the order', sortedCaption.includes('by service, A to Z') && sortedRows.join() === 'auth,catalog,checkout,orders', `${sortedCaption} | ${sortedRows}`)

      await page.click('[data-testid=view-text]')
      await page.waitForSelector('[data-testid=text-view]:not([hidden]) li')
      const lines = await page.evaluate(() => [...document.querySelectorAll('#explore-text li')].map((li) => li.textContent))
      check('text form: the chart\'s own sentences, titled with the result\'s query, the step said as it is', lines[0] === `Query result: ${Q_RATE}, /s, 18 Nov, 09:30 to 12:30, one value every 15 s. 4 series.` && lines.length === 5 && lines[1].startsWith('catalog: last 572, lowest 427, highest 593'), lines.slice(0, 2).join(' | '))
      await page.click('[data-testid=view-json]')
      await page.waitForSelector('[data-testid=result-json] pre')
      const json = await page.evaluate(() => ({ caption: document.querySelector('[data-testid=result-json] .vz-table-caption').textContent, body: document.querySelector('[data-testid=result-json] pre').textContent.slice(0, 60) }))
      check('m1: how long the API took is said with the JSON form, not in the panel head', /KiB in [\d,.]+ ms\./.test(json.caption) && json.body.includes('"status": "success"') && !/ ms/.test(h.meta), json.caption)
      await page.waitForFunction(() => new URLSearchParams(location.search).get('view') === 'json')
      await page.reload()
      await page.waitForSelector('[data-testid=result-json] pre')
      check('the form of the result is in the address: a reload opens the JSON form', (await page.getAttribute('[data-testid=view-json]', 'aria-pressed')) === 'true')
      await page.goto(url(Q_RATE, '&view=text'))
      await page.waitForSelector('[data-testid=text-view]:not([hidden]) li')
      check('a link to the text form opens it with its sentences, though the chart was never shown', (await text(page, '#explore-text li')).includes('one value every 15 s'))

      // Empty, error and start states.
      await page.goto(url('no_such_metric_total'))
      await page.waitForSelector('[data-testid=empty-state]')
      const empty = await text(page, '[data-testid=empty-state]')
      check('empty: says what was asked, between which times, and offers the nearest thing; no mark', empty.includes('No series matched') && empty.includes('no_such_metric_total') && empty.includes('18 Nov 09:30') && empty.includes('Show the last 24 h') && (await page.locator('[data-testid=empty-state] .vz-mark').count()) === 0, empty)
      await page.goto(`${APP}/explore`)
      await page.waitForSelector('[data-testid=start-state] a')
      check('first run: no query yet says what will appear and how to ask; the examples are standalone links', (await text(page, '[data-testid=start-state] h2')) === 'No query yet' && (await page.locator('[data-testid=start-state] .vz-steps li').count()) === 2 && (await page.locator('[data-testid=start-state] .vz-links a').count()) === 5)
      await page.click('[data-testid=start-state] .vz-links a')
      await ready(page)
      check('an example link runs its query', new URL(page.url()).searchParams.get('q') === Q_RATE)
      // The table's rows are prepared in idle time after a result is painted: the table shows the result on screen, not the one it was prepared for.
      {
        const t = await newPage()
        await t.page.goto(url(Q_RATE))
        await ready(t.page)
        await sleep(400) // idle time: the table of the four series is prepared, unseen
        await runQuery(t.page, Q_MANY)
        await t.page.waitForFunction((q) => document.querySelector('[data-testid=result-query]')?.textContent.trim() === q, Q_MANY)
        await t.page.click('[data-testid=view-table]')
        await t.page.waitForSelector('[data-testid=result-table] tbody tr')
        const second = await t.page.evaluate(() => ({ rows: document.querySelectorAll('[data-testid=result-table] tbody tr').length, caption: document.querySelector('[data-testid=table-caption]').textContent.replace(/\s+/g, ' ').trim() }))
        await runQuery(t.page, Q_RATE)
        await t.page.waitForFunction((q) => document.querySelector('[data-testid=result-query]')?.textContent.trim() === q, Q_RATE)
        await sleep(300)
        const third = await t.page.evaluate(() => ({ rows: document.querySelectorAll('[data-testid=result-table] tbody tr').length, caption: document.querySelector('[data-testid=table-caption]').textContent.replace(/\s+/g, ' ').trim() }))
        check('table: after another query it shows that query\'s series, whether the table was asked for before or after the result came', second.rows === 36 && second.caption.startsWith('36 of 36 series') && third.rows === 4 && third.caption.startsWith('4 of 4 series'), JSON.stringify([second, third]))
        await t.ctx.close()
      }
      await ctx.close()

      // Something in a page throws (here: the chart's script, replaced by one that fails): the page says so; it is not left empty.
      const broken = await newPage()
      pageErrors.length = 0
      await broken.ctx.addInitScript(() => { window.vzChart = () => { throw new Error('the chart could not draw this') } })
      await broken.page.goto(url(Q_RATE))
      await broken.page.waitForSelector('[data-testid=page-error]')
      const stopped = await broken.page.evaluate(() => ({ text: document.querySelector('[data-testid=page-error]').textContent.replace(/\s+/g, ' '), nav: !!document.querySelector('.vz-nav a[href="/help"]'), button: document.querySelector('[data-testid=page-error] button').textContent }))
      await broken.page.click('.vz-nav a[href="/help"]')
      await broken.page.waitForSelector('h1')
      check('a page in which something throws says what happened and offers to load it again; the navigation stays, and another page works', stopped.text.includes('This page stopped working') && stopped.text.includes('the chart could not draw this') && stopped.nav && stopped.button === 'Load the page again' && (await text(broken.page, 'h1')) === 'Help', JSON.stringify(stopped))
      pageErrors.length = 0 // that error was the test's own
      await broken.ctx.close()
    }

    // ------------------------------------------------ colour, both themes, every state
    if (want('colour')) {
      for (const theme of ['light', 'dark']) {
        const { ctx, page } = await newPage({ colorScheme: theme })
        const blues = [tokenRgb('blue', theme), tokenRgb('blue-hover', theme), tokenRgb('blue-pressed', theme)]
        const allowed = allowedColours(theme)
        const off = []
        const blue = []
        const visit = async (name) => {
          const b = await blueButtons(page, blues)
          if (b.length > 1) blue.push(`${name}: ${b.join(', ')}`)
          for (const c of await offTokenColours(page, allowed)) off.push(`${name}: ${c}`)
        }
        await page.goto(url(Q_RATE)); await ready(page); await visit('chart')
        const b = await page.locator('svg.vz-plot').boundingBox()
        await page.mouse.move(b.x + 600, b.y + 100); await visit('crosshair'); await page.mouse.move(5, 5)
        await page.click('[data-testid=view-table]'); await page.waitForSelector('[data-testid=result-table] tbody tr'); await visit('table')
        await page.click('[data-testid=view-text]'); await visit('text')
        await page.click('[data-testid=view-json]'); await page.waitForSelector('[data-testid=result-json] pre'); await visit('json')
        await page.keyboard.press('Control+k'); await page.waitForSelector('dialog.palette[open]'); await visit('command palette'); await page.keyboard.press('Escape')
        await page.goto(url(Q_MANY)); await ready(page); await page.click('[data-more]'); await visit('36 series, Other open')
        await page.goto(url('no_such_metric_total')); await page.waitForSelector('[data-testid=empty-state]'); await visit('empty')
        await page.goto(url(Q_BAD)); await page.waitForSelector('[data-testid=error-state]'); await visit('error')
        await page.goto(`${APP}/explore`); await page.waitForSelector('[data-testid=start-state] a'); await visit('start')
        await page.goto(`${APP}/help`); await page.waitForSelector('h1'); await visit('help')
        await page.goto(`${APP}/settings`); await page.waitForSelector('[data-testid=sign-out]'); await visit('settings')
        await page.goto(KEYED + '/explore'); await page.waitForSelector('[data-testid=sign-in]'); await visit('sign-in')
        await page.fill('[data-testid=sign-in-key]', 'viz_nope_nope'); await page.click('[data-testid=sign-in-submit]'); await page.waitForSelector('[data-testid=sign-in-error]'); await visit('sign-in refused')
        check(`${theme}: at most one blue button in every view (14 states)`, blue.length === 0, blue.join(' | '))
        check(`${theme}: no computed colour outside the tokens, in every state (text, fills, borders, outlines, SVG paint, shadows)`, off.length === 0, off.slice(0, 6).join(' | '))
        await ctx.close()
      }
    }

    // ------------------------------------------------ B1: old data keeps its own labels
    if (want('b1')) {
      const { ctx, page } = await newPage()
      await page.goto(url(Q_RATE))
      await ready(page)
      const before = await head(page)
      await setMockDelay(3000)
      await runQuery(page, Q_CPU)
      await page.waitForSelector('[data-testid=progress]')
      const waiting = await head(page)
      const same = (a, b) => a.lastHead === b.lastHead && a.name === b.name && a.query === b.query && a.unit === b.unit && a.unitOption === b.unitOption && a.form === b.form && a.title === b.title
      check('B1 waiting: the unit, the legend head, the chart\'s name, the query line, the unit select and the text form still describe the result on screen', same(before, waiting) && waiting.lastHead === 'Last, /s' && waiting.name.includes(Q_RATE) && !JSON.stringify(waiting).includes('pod_cpu'), JSON.stringify(waiting))
      check('B1 waiting: the head says "Showing the previous query", then the range and age of what is drawn', waiting.note === 'Showing the previous query' && /^Showing the previous query ?· 18 Nov, 09:30 to 12:30 ?· every 15 s ?· updated/.test(waiting.meta), waiting.meta)
      await page.waitForSelector('[data-testid=cancel]')
      await page.click('[data-testid=cancel]')
      await page.waitForSelector('[data-testid=halted]')
      const cancelled = await head(page)
      check('B1 cancelled: the labels and the note stay; the line says the previous result is shown', same(before, cancelled) && cancelled.note === 'Showing the previous query' && (await text(page, '[data-testid=halted] [role=status]')) === 'Cancelled. The previous result is shown.')
      await setMockDelay(0)
      await page.click('[data-testid=retry]')
      await page.waitForFunction(() => document.querySelector('[data-testid=chart] thead [data-col=last]')?.textContent === 'Last, cores')
      const after = await head(page)
      check('B1 settled: the new result brings its own unit, name and query, and the note goes', after.note === null && after.unit === 'cores' && after.name.includes(Q_CPU) && after.query === Q_CPU && after.unitOption === 'Automatic: CPU cores', JSON.stringify(after))

      // An error after a result was drawn: the system's chart keeps the legend, inert, under the message.
      await runQuery(page, Q_BAD)
      await page.waitForSelector('[data-testid=chart] [data-testid=error-state]')
      const errored = await page.evaluate(() => ({
        note: document.querySelector('[data-testid=stale]')?.textContent ?? null,
        inert: document.querySelector('[data-testid=chart] .vz-table-wrap').inert,
        dataError: document.querySelector('[data-testid=chart]').hasAttribute('data-error'),
        rows: document.querySelectorAll('[data-testid=chart] tbody tr[data-key]').length,
        lastHead: document.querySelector('[data-testid=chart] thead [data-col=last]').textContent,
        plot: getComputedStyle(document.querySelector('[data-testid=chart] svg.vz-plot')).visibility,
        message: document.querySelector('[data-testid=error-message]').textContent,
        form: document.querySelector('#explore-text li').textContent,
        states: document.querySelectorAll('[data-testid=error-state]').length,
      }))
      check('B1 after an error: the message lies over the plot; the legend keeps the previous figures and unit, inert; the head says whose they are (Chart, States)', errored.note === 'Showing the previous query' && errored.inert && errored.dataError && errored.rows === 3 && errored.lastHead === 'Last, cores' && errored.plot === 'hidden' && errored.states === 1, JSON.stringify(errored))
      check('B1 after an error: the text form says first that the latest query failed and whose result follows', errored.form.startsWith('The latest query failed: parse error') && errored.form.includes("previous query's result"), errored.form)
      await page.click('[data-testid=error-fix]')
      check('the error\'s button goes to the character the editor\'s parser points at', (await text(page, '[data-testid=error-fix]')).startsWith('Go to character') && (await page.evaluate(() => !!document.activeElement.closest('.query-well'))))
      await page.click('[data-testid=view-table]')
      check('after an error the other forms show the error, not the previous result\'s rows', (await page.locator('[data-testid=result-table]').count()) === 0 && (await page.locator('[data-testid=error-state]:visible').count()) === 1 && (await page.locator('[data-testid=result-meta]').count()) === 0)
      await page.click('[data-testid=view-chart]')
      await runQuery(page, Q_RATE)
      await page.waitForFunction(() => document.querySelector('[data-testid=chart] thead [data-col=last]')?.textContent === 'Last, /s' && !document.querySelector('[data-testid=chart]').hasAttribute('data-error'))
      check('a result after an error clears it: the plot is back and the legend answers again', (await page.evaluate(() => !document.querySelector('[data-testid=chart] .vz-table-wrap').inert && !document.querySelector('[data-testid=error-state]'))))
      await ctx.close()

      // An error with nothing drawn: no age, no note, the message in the plot's place.
      const fresh = await newPage()
      await fresh.page.goto(url(Q_BAD))
      await fresh.page.waitForSelector('[data-testid=error-state]')
      const first = await fresh.page.evaluate(() => ({ meta: !!document.querySelector('[data-testid=result-meta]'), parent: document.querySelector('[data-testid=error-state]').parentElement.className, advice: document.querySelector('[data-testid=error-advice]').textContent }))
      check('an error with nothing drawn states no age and no range; it takes the plot\'s place', !first.meta && first.parent === 'vz-chart' && first.advice.startsWith('The API answered bad_data with HTTP 400.'), JSON.stringify(first))
      await fresh.ctx.close()
    }

    // ------------------------------------------------ the waiting table
    if (want('waiting')) {
      const { ctx, page } = await newPage()
      await page.goto(url(Q_RATE))
      await ready(page)
      const plotTop = () => page.evaluate(() => document.querySelector('svg.vz-plot').getBoundingClientRect().top)
      const top0 = await plotTop()
      // 150 ms: nothing new in the region; the button is busy.
      await setMockDelay(150)
      const seen = { progress: false, busy: false }
      await page.click('[data-testid=run]')
      for (let i = 0; i < 12; i++) {
        const s = await page.evaluate(() => ({ p: !!document.querySelector('[data-testid=progress]'), b: document.querySelector('[data-testid=run]').getAttribute('aria-busy') === 'true' }))
        seen.progress = seen.progress || s.p
        seen.busy = seen.busy || s.b
        await sleep(25)
      }
      check('a 150 ms wait shows no waiting line; Run query is busy meanwhile', !seen.progress && seen.busy, JSON.stringify(seen))
      // 800 ms: the line appears after 400 ms, over the strip, and moves nothing.
      await setMockDelay(800)
      const requests = []
      page.on('request', (r) => { if (r.url().includes('query_range')) requests.push(r.url()) })
      // Times are taken in the page, from the press itself, so the harness's own waits are not in them.
      await page.evaluate(() => {
        const log = (window.__wait = { press: 0, shown: 0, gone: 0 })
        document.querySelector('[data-testid=run]').addEventListener('click', () => { if (!log.press) log.press = performance.now() }, { capture: true })
        new MutationObserver(() => { const on = !!document.querySelector('[data-testid=progress]'); if (on && !log.shown) log.shown = performance.now(); if (!on && log.shown && !log.gone) log.gone = performance.now() }).observe(document.body, { childList: true, subtree: true })
      })
      await page.click('[data-testid=run]')
      await page.keyboard.press('Control+Enter') // a second press while it runs
      await page.waitForSelector('[data-testid=progress]')

      const during = await page.evaluate(() => {
        const p = document.querySelector('[data-testid=progress]'), plot = document.querySelector('svg.vz-plot').getBoundingClientRect(), r = p.getBoundingClientRect()
        const strip = parseFloat(getComputedStyle(document.querySelector('[data-testid=chart]')).getPropertyValue('--strip'))
        return { position: getComputedStyle(p).position, top: plot.top, lineTop: r.top - plot.top, lineBottom: r.bottom - plot.top, strip, left: r.left - plot.left, words: p.querySelector('[role=status]').textContent, cancel: !!document.querySelector('[data-testid=cancel]'), requests: 0 }
      })
      const sentBefore = requests.length

      check('M8: the waiting line lies over the strip above the plot, right of the value axis; nothing is reserved for it and nothing moves', during.position === 'absolute' && Math.abs(during.top - top0) < 0.5 && during.lineTop >= -0.5 && during.lineBottom <= during.strip + 0.5 && during.left >= 43, JSON.stringify(during))
      check('a second press while the query runs is ignored: one request was sent', sentBefore === 1, `${sentBefore} requests`)
      check('the line says what is waited for, with no Cancel before 2 s', during.words === 'Waiting for the query.' && !during.cancel, during.words)
      await page.waitForSelector('[data-testid=progress]', { state: 'detached' })
      const w = await page.evaluate(() => window.__wait)
      check('an 800 ms wait shows the line only after 400 ms', w.shown - w.press >= 395 && w.shown - w.press < 700, `${Math.round(w.shown - w.press)} ms`)
      check('an 800 ms wait: the line stays until the answer', w.gone - w.shown >= 295, `${Math.round(w.gone - w.shown)} ms`)
      // 480 ms: the answer comes just after the line appeared; the line is kept 300 ms all the same, so it never flashes.
      await setMockDelay(480)
      await page.evaluate(() => Object.assign(window.__wait, { press: 0, shown: 0, gone: 0 }))
      await page.click('[data-testid=run]')
      await page.waitForFunction(() => document.querySelector('[data-testid=run]').getAttribute('aria-busy') === 'false')
      await page.waitForFunction(() => window.__wait.shown === 0 || window.__wait.gone > 0, null, { timeout: 5000 })
      const brief = await page.evaluate(() => window.__wait)
      check('a line that was shown is kept at least 300 ms, also when the answer comes 80 ms after it appeared', brief.shown > 0 && brief.gone - brief.shown >= 295, `shown ${Math.round(brief.shown - brief.press)} ms after the press, kept ${Math.round(brief.gone - brief.shown)} ms`)
      // 3 s: Cancel from 2 s, which aborts the request.
      await setMockDelay(3000)
      const aborted = []
      page.on('requestfailed', (r) => { if (r.url().includes('query_range')) aborted.push(r.failure()?.errorText) })
      const t1 = Date.now()
      await page.click('[data-testid=run]')
      await page.waitForSelector('[data-testid=cancel]')
      const cancelAt = Date.now() - t1
      await page.focus('[data-testid=cancel]')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=halted]')
      await sleep(100)
      const focus = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
      check('Cancel is offered from 2 s and aborts the request', cancelAt >= 1900 && cancelAt < 2600 && aborted.some((e) => /ABORTED/.test(e || '')), `${cancelAt} ms, ${aborted.join()}`)
      check('M3: after Cancel by keyboard, focus is on Retry, which stands in its place', focus === 'retry', String(focus))
      if (process.env.VIZ_SLOW) {
        await setMockDelay(75_000, { stall: true })
        await page.click('[data-testid=retry]')
        await page.waitForSelector('[data-testid=alternative]', { timeout: 15_000 })
        check('from 10 s the line offers the cheaper range as a control', (await text(page, '[data-testid=alternative]')) === 'Show the last 1 h' && (await text(page, '[data-testid=progress-text]')) === 'Still waiting for the query.')
        await page.waitForSelector('[data-testid=halted]', { timeout: 70_000 })
        check('at 60 s the wait is stopped and says so, with Retry', (await text(page, '[data-testid=halted] [role=status]')).startsWith('Stopped after 60 s without an answer.'))
      }
      await setMockDelay(0)
      await ctx.close()
    }

    // ------------------------------------------------ the chart: labels, colours, Other, units (M1, M2, M5, M7)
    if (want('chart')) {
      const { ctx, page } = await newPage()
      await page.goto(url(Q_RATE))
      await ready(page)
      const labels = await page.evaluate(() => {
        const svg = document.querySelector('svg.vz-plot')
        const ends = [...svg.querySelectorAll('[data-layer=lines] > g')].map((g) => { const d = g.querySelector('path').getAttribute('d'); const m = /([\d.]+) ([\d.]+)$/.exec(d); return { key: g.dataset.key, x: +m[1], y: +m[2] } })
        const leaders = [...svg.querySelectorAll('.vz-leader')].map((l) => l.getAttribute('points').split(' ').map((p) => p.split(',').map(Number)))
        const texts = [...svg.querySelectorAll('text.vz-direct')].map((t) => ({ text: t.textContent, x: +t.getAttribute('x'), y: +t.getAttribute('y') }))
        // each label is joined by its leader to one line's end; which line?
        return texts.map((t, i) => { const from = leaders[i][0], to = leaders[i][2]; const end = ends.reduce((a, e) => (Math.abs(e.y - from[1]) < Math.abs(a.y - from[1]) ? e : a)); return { text: t.text, key: end.key, off: Math.abs(to[1] - from[1]), right: t.x > end.x } })
      })
      check('M1: each direct label sits in the gutter right of the plot, joined by a leader to the end of its own line, within two lines of it', labels.length === 4 && labels.every((l) => l.key.includes(`service=${l.text}`) && l.off <= 36 && l.right), JSON.stringify(labels))
      const unit = await page.evaluate(() => ({ axis: [...document.querySelectorAll('svg.vz-plot .vz-axis-unit')].map((t) => t.textContent), ticks: [...document.querySelectorAll('svg.vz-plot text')].filter((t) => t.getAttribute('text-anchor') === 'end' && !t.classList.contains('vz-axis-unit')).map((t) => t.textContent).filter((t) => /^[\d.,]+$/.test(t)), heads: [...document.querySelectorAll('[data-testid=chart] thead th')].map((t) => t.textContent), cells: [...document.querySelectorAll('[data-testid=chart] tbody td.vz-num')].map((t) => t.textContent) }))
      check('M7: the unit is written once on the axis and once in the legend head; ticks and cells are bare numbers in one precision', unit.axis.join() === '/s' && unit.heads.join('|') === 'Series|Last, /s|Min|Max' && unit.ticks.join() === '0,200,400,600' && unit.cells.every((c) => /^\d+$/.test(c)), JSON.stringify(unit))
      const b = await page.locator('svg.vz-plot').boundingBox()
      await page.mouse.move(b.x + 600, b.y + 100)
      const readout = await page.evaluate(() => ({ text: document.querySelector('.vz-readout').textContent, top: document.querySelector('.vz-readout').getBoundingClientRect().top, plotBottom: document.querySelector('svg.vz-plot').getBoundingClientRect().bottom, lastHead: document.querySelector('[data-testid=chart] thead [data-col=last]').textContent, live: document.querySelector('[data-testid=chart] .vz-sr').textContent }))
      check('the readout is one line under the plot, never over it, and names the nearest and the highest series with the legend\'s precision (M4, M7)', readout.top >= readout.plotBottom - 0.5 && /^\d\d:\d\d\s*nearest: \w+ \d+ \/s\s*highest: catalog \d+ \/s$/.test(readout.text.replace(/\s+/g, ' ')) && /^At \d\d:\d\d, \/s$/.test(readout.lastHead), JSON.stringify(readout))
      check('the readout is not announced on every pointer move', readout.live === '')
      await page.mouse.move(5, 5)

      // CPU: a gap drawn as a gap, the unit by name.
      await page.goto(url(Q_CPU))
      await ready(page)
      const cpu = await page.evaluate(() => ({ head: document.querySelector('[data-testid=chart] thead [data-col=last]').textContent, moves: Math.max(...[...document.querySelectorAll('svg.vz-plot .vz-line')].map((p) => (p.getAttribute('d').match(/M/g) || []).length)), note: document.querySelector('.vz-legend-note').textContent, names: [...document.querySelectorAll('.vz-series-name')].map((n) => n.textContent), titles: [...document.querySelectorAll('[data-testid=chart] tbody tr[data-key]')].map((tr) => tr.title), cells: [...document.querySelectorAll('[data-testid=chart] tbody td[data-c=last]')].map((t) => t.textContent) }))
      check('M7: CPU cores carry their unit in the head, one scale and one precision in the cells (never "357m" beside "1.42")', cpu.head === 'Last, cores' && cpu.cells.every((c) => /^\d\.\d$/.test(c)), JSON.stringify(cpu.cells))
      check('missing samples are drawn as a gap: the line is broken, not joined', cpu.moves === 2, `${cpu.moves} segments`)
      check('M5: legend names are the labels that differ, the shared ones said once in the note; the row\'s title is the full label set', cpu.names.every((n) => /^node-\w · checkout-/.test(n)) && cpu.note === 'All series: job="kubelet", service="checkout"' && cpu.titles.every((t) => t.includes('__name__="pod_cpu_usage_cores"') && t.includes('pod="checkout-')), JSON.stringify([cpu.names, cpu.note]))
      // Bytes: one binary unit, ticks on binary-round values.
      await page.goto(url(Q_MEM))
      await ready(page)
      const mem = await page.evaluate(() => ({ unit: document.querySelector('svg.vz-plot .vz-axis-unit').textContent, ticks: [...document.querySelectorAll('svg.vz-plot text')].filter((t) => t.getAttribute('text-anchor') === 'end' && /^[\d,.]+$/.test(t.textContent)).map((t) => +t.textContent.replace(/,/g, '')) }))
      check('M7: bytes are shown in one binary unit and tick on binary-round values (not 667.6 MiB)', /^(KiB|MiB|GiB)$/.test(mem.unit) && Number.isInteger(Math.log2(mem.ticks[1] - mem.ticks[0])) && mem.ticks.every((t, i) => t === i * (mem.ticks[1] - mem.ticks[0])), JSON.stringify(mem))
      // No unit: no dangling comma anywhere.
      await page.goto(url(Q_UP))
      await ready(page)
      const up = await head(page)
      await page.locator('svg.vz-plot').hover({ position: { x: 600, y: 100 } })
      const upHover = await text(page, '[data-testid=chart] thead [data-col=last]')
      check('a result with no unit leaves no empty place for one: "Last", the chart\'s name and the text form read whole', up.lastHead === 'Last' && /^At \d\d:\d\d$/.test(upHover) && !up.name.includes(', ,') && !up.form.includes(', ,') && up.unitOption === 'Automatic: number', JSON.stringify([up.lastHead, upHover, up.name, up.form]))
      // A result with no labels is named by its query.
      await page.goto(url('sum(rate(http_requests_total[5m]))'))
      await ready(page)
      const one = await legend(page)
      check('a series with no labels is named by the query it is the value of, and its row has an accessible name', one.length === 1 && one[0].name.startsWith('sum(rate(') && one[0].title.startsWith('query="sum(rate('), JSON.stringify(one))

      // 36 series: eight coloured by size, one Other, the colour action per D73.
      await page.goto(url(Q_MANY))
      await ready(page)
      const many = await page.evaluate(() => ({ rows: [...document.querySelectorAll('[data-testid=chart] tbody tr')].map((tr) => tr.dataset.key === 'other' ? 'other' : tr.dataset.key ? tr.querySelector('.vz-swatch').dataset.series : tr.textContent.trim()), lines: document.querySelectorAll('svg.vz-plot [data-layer=lines] .vz-line').length, band: document.querySelectorAll('svg.vz-plot .vz-other-band').length, other: document.querySelector('tr[data-key=other]').textContent, note: document.querySelector('.vz-legend-note').textContent, lasts: [...document.querySelectorAll('[data-testid=chart] tbody tr[data-key]:not([data-key=other]) td:last-child')].map((t) => +t.textContent), reserve: document.querySelector('[data-testid=chart]').style.cssText }))
      check('M2: with 36 series the eight largest are coloured, each on its own slot, listed in palette order; the rest are ONE band and ONE legend row', many.rows.slice(0, 9).join() === '1,2,3,4,5,6,7,8,other' && many.lines === 8 && many.band === 1 && /Other ?28 series/.test(many.other) && [...many.lasts].sort((a, b) => b - a).join() === '312,175,141,96,83,61,44,27', JSON.stringify([many.rows, many.lines, many.band, many.other, many.lasts]))
      check('D73: at load the eight largest are already coloured, so "Colour the eight largest" is not offered; the note says how the colours were chosen', many.rows.slice(9).join() === 'Show 20 more of Other' && many.note === '8 coloured by size; 28 in Other', JSON.stringify([many.rows.slice(9), many.note]))
      check('the chart reserves the height of its legend from its own rows (Chart, Reserved height)', /--legend-rows:\s*10/.test(many.reserve) && /--legend-notes:\s*1/.test(many.reserve), many.reserve)
      const coloursBefore = Object.fromEntries((await legend(page)).filter((r) => /^\d$/.test(r.slot)).map((r) => [r.key, r.slot]))
      await page.click('[data-more]')
      const opened = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-testid=chart] tbody tr[data-key]').length, tab: document.querySelectorAll('[data-testid=chart] .vz-series[tabindex="0"]').length }))
      check('m7: Other opens 20 at a time, and the whole legend is one tab stop', opened.rows === 29 && opened.tab === 1, JSON.stringify(opened))
      // Colours are the series', not the rank's: a narrower query keeps them, a wider one does not repaint what is on screen.
      await page.goto(url(Q_5XX))
      await ready(page)
      await page.goto(url(Q_MANY))
      await ready(page)
      const kept = await page.evaluate(() => ({ note: document.querySelector('.vz-legend-note').textContent, actions: [...document.querySelectorAll('.vz-legend-actions')].map((t) => t.textContent.trim()), slots: Object.fromEntries([...document.querySelectorAll('[data-testid=chart] tbody tr[data-key]')].filter((tr) => /^\d$/.test(tr.querySelector('.vz-swatch').dataset.series)).map((tr) => [tr.dataset.key, tr.querySelector('.vz-swatch').dataset.series])) }))
      const held = Object.keys(kept.slots).filter((k) => k.includes('status=500')).length
      check('M2: series on screen keep their colours when the query widens; the larger ones arrive in Other and the note says so', held === 8 && /in Other (is|are) now larger than a coloured series/.test(kept.note), JSON.stringify([held, kept.note]))
      check('D73: now that one of the eight largest is not coloured, "Colour the eight largest" is offered', kept.actions.join('|') === 'Show 20 more of Other|Colour the eight largest', kept.actions.join('|'))
      await page.click('[data-recolour]')
      const recoloured = await page.evaluate(() => ({ maxes: [...document.querySelectorAll('[data-testid=chart] tbody tr[data-key]:not([data-key=other]) td:last-child')].map((t) => +t.textContent), note: document.querySelector('.vz-legend-note').textContent, actions: [...document.querySelectorAll('.vz-legend-actions')].map((t) => t.textContent.trim()), slots: Object.fromEntries([...document.querySelectorAll('[data-testid=chart] tbody tr[data-key]')].filter((tr) => /^\d$/.test(tr.querySelector('.vz-swatch').dataset.series)).map((tr) => [tr.dataset.key, tr.querySelector('.vz-swatch').dataset.series])) }))
      check('D73: pressed, it colours the eight largest, slot 1 the largest, and is no longer offered', recoloured.maxes.every((v, i, a) => i === 0 || v <= a[i - 1]) && Object.keys(recoloured.slots).sort().join() === Object.keys(coloursBefore).sort().join() && recoloured.actions.join('|') === 'Show 20 more of Other' && recoloured.note === '8 coloured by size; 28 in Other', JSON.stringify([recoloured, coloursBefore]))
      await page.reload()
      await ready(page)
      const reloaded = Object.fromEntries((await legend(page)).filter((r) => /^\d$/.test(r.slot)).map((r) => [r.key, r.slot]))
      check('M2: a reload in the same tab reproduces every colour', JSON.stringify(reloaded) === JSON.stringify(recoloured.slots), JSON.stringify(reloaded))
      await ctx.close()

      // 200 series, and a narrow chart.
      const wide = await newPage()
      await wide.page.goto(url('viz_synthetic_series'))
      await ready(wide.page)
      const two = await wide.page.evaluate(() => ({ rows: document.querySelectorAll('[data-testid=chart] tbody tr[data-key]').length, other: document.querySelector('tr[data-key=other]').textContent, lines: document.querySelectorAll('svg.vz-plot [data-layer=lines] .vz-line').length }))
      check('200 series: eight lines, one band, nine legend rows', two.rows === 9 && two.lines === 8 && /192 series/.test(two.other), JSON.stringify(two))
      await wide.ctx.close()
      const narrow = await newPage({ viewport: { width: 400, height: 900 } })
      await narrow.page.goto(url(Q_P95))
      await ready(narrow.page)
      const n = await narrow.page.evaluate(() => ({ direct: document.querySelectorAll('svg.vz-plot .vz-direct').length, lastRight: document.querySelector('[data-testid=chart] thead [data-col=last]').getBoundingClientRect().right, width: innerWidth, heads: [...document.querySelectorAll('[data-testid=chart] thead th')].filter((t) => t.getClientRects().length).map((t) => t.textContent), unit: document.querySelector('svg.vz-plot .vz-axis-unit').textContent }))
      check('M1, M5: at 400 px there are no direct labels to collide, and the legend keeps its name and its Last column on screen', n.direct === 0 && n.lastRight <= n.width && n.heads.length === 2 && /^Last, (ms|s)$/.test(n.heads[1]), JSON.stringify(n))
      await narrow.ctx.close()
    }

    // ------------------------------------------------ keyboard and focus
    if (want('keyboard')) {
      const { ctx, page } = await newPage()
      await page.goto(url(Q_RATE))
      await ready(page)
      const focusRgb = tokenRgb('focus', 'light')
      const stops = []
      await page.keyboard.press('Tab')
      for (let i = 0; i < 40; i++) {
        const s = await focusStop(page, focusRgb)
        if (stops.length && (s.name === stops[0].name || s.name === 'body')) break // the end of the page
        stops.push(s)
        await page.keyboard.press('Tab')
      }
      const names = stops.map((s) => s.name)
      const order = ['Skip to content', 'Explore', 'Dashboards', 'Help', 'Settings', 'copy-link', 'query editor', 'run', 'preset-15m', 'preset-1h', 'preset-6h', 'preset-24h', 'preset-7d', 'earlier', 'later', 'time-from', 'time-to', 'step', 'unit', 'view-chart', 'view-table', 'view-text', 'view-json']
      check('keyboard: the stops come in reading order, from the skip link through the query, the range and the forms to the chart', order.every((n, i) => names[i] === n), names.join(' > '))
      check('keyboard: the plot is one stop, the zoom buttons follow, each sortable head is one, and the legend is one', names.slice(order.length).join(' > ') === [names[order.length], 'Zoom in', 'Series', 'Last, /s', 'Min', 'Max', names[names.length - 1]].join(' > ') && names[order.length].startsWith('Query result: ') && names.length === order.length + 7, names.slice(order.length).join(' > '))
      check('keyboard: the ring is drawn at every stop, and focus never falls to the document', stops.every((s) => s.ring && s.name !== 'body'), stops.filter((s) => !s.ring).map((s) => s.name).join(', '))
      // The chart by keyboard: the readout is announced, and says which series it names (m6).
      await page.focus('svg.vz-plot')
      await page.keyboard.press('ArrowLeft')
      const live = await text(page, '[data-testid=chart] .vz-sr')
      check('m6: an arrow key on the plot announces the time and the highest series by name, at once', /^\d\d:\d\d, highest catalog \d+ \/s$/.test(live), live)
      await page.keyboard.press('Escape')
      // The legend: arrows move between rows, Space toggles, the ring is round the row (m7, m8).
      await page.focus('[data-testid=chart] .vz-series[tabindex="0"]')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      const last = await page.evaluate((focusRgb) => { const el = document.activeElement, tr = el.closest('tr'), cells = [...tr.cells]; return { row: [...tr.parentElement.rows].indexOf(tr), shadows: cells.map((c) => getComputedStyle(c).boxShadow.includes(focusRgb)), emph: document.querySelector('svg.vz-plot').getAttribute('data-emph') } }, focusRgb)
      check('m7, m8: arrow keys move within the legend; the ring is drawn round the whole last row, inside it, where nothing clips it; the row\'s line comes forward', last.row === 3 && last.shadows.every(Boolean) && last.emph === 'series', JSON.stringify(last))
      await page.keyboard.press('Space')
      const toggled = await legend(page)
      check('Space on a legend row draws that series alone; it stays listed with its colour', toggled[3].selected && toggled.filter((r) => r.selected).length === 1 && toggled.map((r) => r.slot).join() === '1,2,3,4' && (await page.evaluate(() => document.querySelectorAll('svg.vz-plot [data-layer=lines] > g:not([display=none])').length)) === 1)
      await page.keyboard.press('Space')
      // Typing renders no React component (B3).
      await page.click('.query-well .cm-content')
      await page.keyboard.press('Escape')
      const renders0 = await page.evaluate(() => ({ ...window.__vizRenders }))
      await page.keyboard.type(' + sum(rate(http_requests_total{status="500"}[5m]))', { delay: 5 })
      await page.keyboard.press('Escape')
      const renders1 = await page.evaluate(() => ({ ...window.__vizRenders }))
      const changed = Object.keys(renders1).filter((k) => renders1[k] !== renders0[k])
      check('B3: typing 50 characters renders no React component (the page, the query row, the table)', renders0.ExplorePage > 0 && renders0.QueryRow > 0 && changed.length === 0, changed.join(', ') || JSON.stringify(renders1))
      // The time fields.
      await page.fill('[data-testid=time-from]', 'now - 6 h')
      await page.keyboard.press('Enter')
      const refusedOrder = await page.evaluate(() => ({ help: document.querySelector('[data-testid=time-error]')?.textContent, from: new URLSearchParams(location.search).get('from') }))
      check('a From after To is refused in words, and the range stays', refusedOrder.help === 'To is not after From. Set From earlier, or To later.' && refusedOrder.from === String(Date.UTC(2026, 10, 18, 9, 30)), JSON.stringify(refusedOrder))
      await page.fill('[data-testid=time-to]', 'now')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => new URLSearchParams(location.search).get('from') === 'now-6h' && new URLSearchParams(location.search).get('to') === null)
      // The last six hours are of the clock at the time of the run: within one day ("26 Nov, 09:14 to 15:14 (now)") or across midnight ("26 Nov 18:14 to 27 Nov 00:14 (now)").
      check('m4: the time range is typed in the system\'s forms and echoed with its length and zone; there is no browser date picker', /^Read as (\d+ [A-Z][a-z]{2}, \d\d:\d\d to \d\d:\d\d|\d+ [A-Z][a-z]{2} \d\d:\d\d to \d+ [A-Z][a-z]{2} \d\d:\d\d) \(now\), 6 h, UTC\.$/.test(await text(page, '[data-testid=time-read]')) && (await page.locator('input[type=datetime-local]').count()) === 0 && (await page.getAttribute('[data-testid=preset-6h]', 'aria-pressed')) === 'true', await text(page, '[data-testid=time-read]'))
      await page.fill('[data-testid=time-from]', 'last tuesday')
      await page.keyboard.press('Enter')
      const bad = await page.evaluate(() => ({ invalid: document.querySelector('[data-testid=time-from]').getAttribute('aria-invalid'), help: document.querySelector('[data-testid=time-error]')?.textContent, from: new URLSearchParams(location.search).get('from') }))
      check('a time that cannot be read keeps the range, marks the field and says what it takes', bad.invalid === 'true' && bad.help.startsWith('From was not read. Use a time such as') && bad.from === 'now-6h', JSON.stringify(bad))
      await page.fill('[data-testid=step]', '1 min')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => new URLSearchParams(location.search).get('step') === '1m')
      check('the step is typed as a duration in any form and echoed in the system\'s', (await text(page, '[data-testid=step-read]')) === 'One value every 1 min.')
      // The command palette (m10).
      await page.keyboard.press('Control+k')
      await page.waitForSelector('dialog.palette[open]')
      const palette = await page.evaluate(() => ({ label: document.querySelector('dialog.palette .vz-label')?.textContent, visible: (() => { const r = document.querySelector('dialog.palette .vz-label')?.getBoundingClientRect(); return !!r && r.width > 8 && r.height > 8 })(), focus: document.activeElement.getAttribute('data-testid') }))
      check('m10: the command palette\'s field has a visible label, and takes the focus', palette.label === 'Command' && palette.visible && palette.focus === 'palette-input', JSON.stringify(palette))
      await page.keyboard.type('text form')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=text-view]:not([hidden])')
      check('a command chosen in the palette runs: the text form is shown', true)
      check('m9: settings are a page, edited in place; no dialog but the palette exists', (await page.locator('dialog').count()) === 1 && (await page.locator('dialog.vz-dialog').count()) === 0)
      await ctx.close()
    }

    // ------------------------------------------------ touch: a phone (B2, M4, M6)
    if (want('touch')) {
      const { ctx, page } = await newPage({ viewport: { width: 400, height: 1600 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
      await page.goto(url(Q_RATE))
      await ready(page)
      const well = await page.evaluate(() => { const w = document.querySelector('.query-well'), c = w.querySelector('.cm-content') || w; return { h: w.getBoundingClientRect().height, size: getComputedStyle(c).fontSize, body: getComputedStyle(document.documentElement).getPropertyValue('--text-body-size').trim(), coarse: matchMedia('(pointer: coarse)').matches } })
      check('B2: with a coarse pointer the query well is 44 px tall with body-size text, as the system sets a text input', well.coarse && well.h >= 44 && well.size === well.body, JSON.stringify(well))
      const small = []
      const covered = []
      let measured = 0
      const fine = [] // a state measured while the pointer was not coarse is not a measurement of touch
      const visit = async (name) => { const h = await hitAreas(page); if (!h.coarse) fine.push(name); measured += h.count; for (const s of h.small) small.push(`${name}: ${s}`); for (const c of h.covered) covered.push(`${name}: ${c}`) }
      await visit('chart')
      await page.tap('[data-testid=view-table]'); await page.waitForSelector('[data-testid=result-table] tbody tr'); await visit('table')
      await page.tap('[data-testid=view-text]'); await visit('text')
      await page.tap('[data-testid=view-json]'); await page.waitForSelector('[data-testid=result-json] pre'); await visit('json')
      await page.tap('[data-testid=view-chart]')
      await page.goto(url(Q_MANY)); await ready(page); await visit('36 series')
      await page.goto(url(Q_BAD)); await page.waitForSelector('[data-testid=error-state]'); await visit('error')
      await page.goto(`${APP}/explore`); await page.waitForSelector('[data-testid=start-state] a'); await visit('start')
      await page.goto(`${APP}/help`); await page.waitForSelector('h1'); await visit('help')
      await page.goto(`${APP}/settings`); await page.waitForSelector('[data-testid=sign-out]'); await visit('settings')
      await page.goto(KEYED + '/explore'); await page.waitForSelector('[data-testid=sign-in]'); await visit('sign-in')
      // The second review's B2: "Show 50 more of 200" under the table of a result with more than 50 series, at 400, 320 and 1500 px.
      const more = []
      for (const w of [400, 320, 1500]) {
        await page.setViewportSize({ width: w, height: 1600 })
        await page.goto(url('viz_synthetic_series', '&view=table')); await page.waitForSelector('[data-testid=table-more]')
        await page.locator('[data-testid=table-more]').evaluate((b) => b.scrollIntoView({ block: 'center' }))
        await sleep(200)
        await visit(`table of 200, ${w} px`)
        // A tap 16 px above the button's centre, inside its declared 44 px and above its drawn 24 px: the review's taps there did nothing.
        const box = await page.locator('[data-testid=table-more]').boundingBox()
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2 - 16)
        await sleep(300)
        const rows = await page.locator('[data-testid=result-table] tbody tr').count()
        await page.locator('[data-testid=table-more]').evaluate((b) => b.scrollIntoView({ block: 'center' }))
        await sleep(200)
        const next = await page.locator('[data-testid=table-more]').boundingBox()
        await page.touchscreen.tap(next.x + next.width / 2, next.y + next.height / 2 + 16)
        await sleep(300)
        more.push({ w, drawn: box.height, above: rows, below: await page.locator('[data-testid=result-table] tbody tr').count() })
      }
      await page.setViewportSize({ width: 400, height: 1600 })
      check('review 2, B2: "Show 50 more of 200" takes a tap 16 px above and 16 px below its centre (its whole 44 px), at 400, 320 and 1500 px with a coarse pointer', more.every((m) => m.above === 100 && m.below === 150), JSON.stringify(more))
      check(`touch: every control has a 44 px hit area that is its own, in thirteen states (${measured} measured)`, small.length === 0 && covered.length === 0 && measured > 100 && fine.length === 0, [...fine.map((n) => `${n}: the pointer was not coarse`), ...small, ...covered].slice(0, 8).join(' | '))
      // A tap toggles a legend row; a held finger shows the press; zoom is two buttons; the readout is under the plot.
      await page.goto(url(Q_RATE)); await ready(page)
      await page.tap('[data-testid=chart] tbody tr[data-key] .vz-series')
      const tapped = await legend(page)
      check('M4: a tap on a legend row toggles that series, with no modifier key anywhere', tapped[0].selected && tapped.filter((r) => r.selected).length === 1)
      await page.tap('[data-testid=chart] tbody tr[data-key] .vz-series')
      const zoom = await page.evaluate(() => [...document.querySelectorAll('[data-testid=chart] [data-zoom]')].map((b) => `${b.textContent}${b.disabled ? ' (off)' : ''}`))
      check('M4: zoom in and out are buttons in the chart\'s foot', zoom.join() === 'Zoom in,Zoom out (off)', zoom.join())
      const plot = await page.locator('svg.vz-plot').boundingBox()
      const cdp = await ctx.newCDPSession(page)
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
      await touch('touchStart', plot.x + 120, plot.y + 100)
      await touch('touchMove', plot.x + 200, plot.y + 104)
      await sleep(100)
      const drag = await page.evaluate(() => ({ text: document.querySelector('.vz-readout').textContent, top: document.querySelector('.vz-readout').getBoundingClientRect().top, plotBottom: document.querySelector('svg.vz-plot').getBoundingClientRect().bottom, cursor: !!document.querySelector('svg.vz-plot .vz-crosshair') }))
      await touch('touchEnd', 0, 0)
      check('M4: a finger dragged across the plot moves the crosshair, and the readout is under the plot, not over the line it reports', drag.cursor && /nearest/.test(drag.text) && drag.top >= drag.plotBottom - 0.5, JSON.stringify(drag))
      // Pressed states, by a held finger (M6): legend row, sortable head, nav link, a small button.
      const pressedRgb = tokenRgb('pressed', 'light')
      const pressed = {}
      for (const [name, sel, painted] of [['legend row', '[data-testid=chart] tbody tr[data-key] .vz-series', '[data-testid=chart] tbody tr[data-key] td'], ['sortable head', '[data-testid=chart] thead [data-col=min] .vz-sort, [data-testid=chart] thead [data-col=name] .vz-sort', null], ['small button', '[data-testid=earlier]', null], ['segment', '[data-testid=view-table]', null]]) {
        const box = await page.locator(sel).first().boundingBox()
        await touch('touchStart', box.x + box.width / 2, box.y + box.height / 2)
        await sleep(60)
        pressed[name] = await page.evaluate(([sel, painted]) => getComputedStyle(document.querySelector(painted || sel)).backgroundColor, [sel.split(',')[sel.includes(',') ? 1 : 0].trim(), painted])
        await touch('touchCancel', 0, 0).catch(() => touch('touchEnd', 0, 0))
        await sleep(30)
      }
      check('M6: a held finger shows the pressed fill on a legend row, a sortable head, a small button and a segment', Object.values(pressed).every((c) => c === pressedRgb), JSON.stringify(pressed))
      for (const w of [400, 320]) {
        await page.setViewportSize({ width: w, height: 1600 })
        const o = []
        for (const u of [url(Q_RATE), url(Q_MANY), url(Q_BAD), `${APP}/explore`, `${APP}/help`, `${APP}/settings`]) {
          await page.goto(u)
          await page.waitForSelector('h1')
          await sleep(300)
          const m = await page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, smallest: Math.min(...[...document.querySelectorAll('body *')].filter((el) => el.getClientRects().length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((el) => parseFloat(getComputedStyle(el).fontSize))) }))
          if (!m.coarse || m.over > 0 || m.smallest < 11) o.push(`${u.replace(APP, '').slice(0, 30)}: over ${m.over}, smallest ${m.smallest}${m.coarse ? '' : ', the pointer was not coarse'}`)
        }
        check(`${w} px: nothing scrolls the page sideways and no text is under 11 px, on six pages`, o.length === 0, o.join(' | '))
      }
      await ctx.close()
    }

    // ------------------------------------------------ zoom, and asking for the chart's range
    if (want('zoom')) {
      const { ctx, page } = await newPage()
      await page.goto(url(Q_RATE))
      await ready(page)
      const hiddenBefore = await page.evaluate(() => { const b = document.querySelector('[data-testid=query-shown]'); return { vis: getComputedStyle(b).visibility, tab: b.tabIndex, top: document.querySelector('svg.vz-plot').getBoundingClientRect().top } })
      await page.click('[data-testid=chart] [data-zoom=in]')
      const zoomed = await page.evaluate(() => { const b = document.querySelector('[data-testid=query-shown]'); return { vis: getComputedStyle(b).visibility, range: document.querySelector('[data-range]').textContent, url: location.search, top: document.querySelector('svg.vz-plot').getBoundingClientRect().top } })
      check('Zoom in halves the range within the result, keeping its end; the head follows; the address does not change', zoomed.range === '11:00 to 12:30' && !zoomed.url.includes('to=1795005000000&from') && zoomed.url.includes(`from=${T0}`), JSON.stringify(zoomed))
      check('"Query the chart\'s range" is offered only while the chart is zoomed, in a place kept for it, so nothing moves', hiddenBefore.vis === 'hidden' && hiddenBefore.tab === -1 && zoomed.vis === 'visible' && zoomed.top === hiddenBefore.top, JSON.stringify([hiddenBefore, zoomed.vis]))
      await page.click('[data-testid=query-shown]')
      await page.waitForFunction(() => new URLSearchParams(location.search).get('from') === String(Date.UTC(2026, 10, 18, 11, 0)))
      await page.waitForFunction(() => document.querySelector('[data-range]')?.textContent === '11:00 to 12:30' && getComputedStyle(document.querySelector('[data-testid=query-shown]')).visibility === 'hidden')
      check('pressed, it asks the API for that range (the address has it, Back undoes it) and withdraws', new URLSearchParams(new URL(page.url()).search).get('to') === String(T1))
      await page.goBack()
      await page.waitForFunction(() => document.querySelector('[data-range]')?.textContent === '09:30 to 12:30')
      check('Back returns to the range before', true)
      await ctx.close()
    }

    // ------------------------------------------------ time zone: the chart reads local time
    if (want('zone')) {
      const { ctx, page } = await newPage({ timezoneId: 'America/New_York' })
      await page.goto(url(Q_RATE))
      await ready(page)
      const z = await page.evaluate(() => ({ axis: [...document.querySelectorAll('svg.vz-plot text')].map((t) => t.textContent).filter((t) => /^\d\d:\d\d$/.test(t)), meta: document.querySelector('[data-testid=result-meta]').textContent, from: document.querySelector('[data-testid=time-from]').value, read: document.querySelector('[data-testid=time-read]').textContent, form: document.querySelector('#explore-text li').textContent }))
      check('in New York the axis, the head, the fields and the text form all read local time, and the zone is stated once', z.axis[0] === '04:30' && z.axis.includes('07:30') && z.meta.startsWith('18 Nov, 04:30 to 07:30') && z.from === '18 Nov 04:30' && z.read === 'Read as 18 Nov, 04:30 to 07:30, 3 h, UTC\u22125.' && z.form.includes('04:30 to 07:30'), JSON.stringify(z))
      await ctx.close()
    }

    // ------------------------------------------------ nothing moves: layout shift on load, on a run, on a reload
    if (want('shift')) {
      const { ctx, page } = await newPage()
      const countShifts = () => { window.__shift = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shift += e.value }).observe({ type: 'layout-shift', buffered: true }) }
      // Every entry is summed, those marked hadRecentInput too: this section gives no input, and the mark is set for the first 460 ms or so
      // after a load under isMobile whether or not there was any (design-system/reviews/system-v9/confirmation.md).
      await ctx.addInitScript(countShifts)
      await page.goto(url(Q_MANY))
      await ready(page)
      await sleep(600)
      const first = await page.evaluate(() => window.__shift)
      await setMockDelay(900)
      await page.reload()
      await page.waitForSelector('[data-testid=chart-reserved]')
      const reserved = await page.evaluate(() => ({ style: document.querySelector('[data-testid=chart-reserved]').style.cssText, h: document.querySelector('[data-testid=chart-reserved]').getBoundingClientRect().height, progress: !!document.querySelector('[data-testid=progress]') }))
      await ready(page)
      await sleep(600)
      const drawn = await page.evaluate(() => ({ h: document.querySelector('[data-testid=chart]').getBoundingClientRect().height, shift: window.__shift }))
      await setMockDelay(0)
      check('a first visit to a result shifts nothing (layout shift under 0.005, every entry counted; the budget is 0.05)', first < 0.005, first.toFixed(4))
      // The phone layout, first visit only. No reload here: under touch emulation the outgoing document loses its coarse pointer
      // during a reload, so nothing may be read across one (the same review); the pointer is checked where the figure is read.
      const phoneShift = await newPage({ viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
      await phoneShift.ctx.addInitScript(countShifts)
      await phoneShift.page.goto(url(Q_MANY))
      await ready(phoneShift.page)
      await sleep(900)
      const onPhone = await phoneShift.page.evaluate(() => ({ shift: window.__shift, coarse: matchMedia('(pointer: coarse)').matches }))
      check('phone layout (400 px, coarse pointer): a first visit shifts nothing, every entry counted', onPhone.coarse && onPhone.shift < 0.005, JSON.stringify(onPhone))
      // The address follows a change of form 300 ms later, and a change of unit at once: the page stays where it was scrolled to.
      // (Found by the speed runs: on a phone the forms are below the first screen, and the router's default for a navigation is the top of the page.)
      const kept = {}
      for (const [name, act] of [['table', (p) => p.tap('[data-testid=view-table]')], ['text', (p) => p.tap('[data-testid=view-text]')], ['unit', (p) => p.selectOption('[data-testid=unit]', 'none')]]) {
        await phoneShift.page.locator(name === 'unit' ? '[data-testid=unit]' : `[data-testid=view-${name}]`).scrollIntoViewIfNeeded()
        await sleep(500)
        const y0 = await phoneShift.page.evaluate(() => Math.round(scrollY))
        await act(phoneShift.page)
        await sleep(700)
        kept[name] = { y0, y: await phoneShift.page.evaluate(() => Math.round(scrollY)), address: new URL(phoneShift.page.url()).search.replace(/^.*?(&view=[a-z]+)?(&unit=[a-z]+)?$/, '$1$2') }
      }
      check('phone layout: a change of form or of unit leaves the page where it was scrolled to, also once the address has followed', Object.values(kept).every((k) => k.y0 > 100 && k.y === k.y0) && /view=table/.test(kept.table.address) && /view=text/.test(kept.text.address) && /unit=none/.test(kept.unit.address), JSON.stringify(kept))
      await phoneShift.ctx.close()
      check('a reload reserves the chart\'s height from its last result before the data arrives, to the pixel, and shows the waiting line over it', /--legend-rows:\s*10/.test(reserved.style) && Math.abs(reserved.h - drawn.h) < 1 && drawn.shift < 0.05, JSON.stringify([reserved, drawn]))
      await ctx.close()
    }

    // ------------------------------------------------ the second review (design-system/reviews/app-v9/review.md): M1, M2, m1 to m4, m10
    if (want('review2')) {
      const { ctx, page } = await newPage()
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP })
      // M2: the text form and the chart's name say the day the head says, and that the result may be incomplete when the head does.
      await page.goto(url(Q_MANY)); await ready(page)
      const whole = await head(page)
      check('review 2, M2: the head, the chart\'s accessible name and the text form\'s first line all say the day and the range ("18 Nov, 09:30 to 12:30")', /^18 Nov, 09:30 to 12:30\s*· every 15 s/.test(whole.meta) && whole.name.includes(', /s, 18 Nov, 09:30 to 12:30. 36 series') && whole.form.includes(', /s, 18 Nov, 09:30 to 12:30, one value every 15 s.'), JSON.stringify([whole.meta, whole.name, whole.form]))
      check('review 2, M2: a whole result says nothing of a warning, in the head, the name or the text form', (await page.locator('[data-testid=warnings]').count()) === 0 && !/warning|incomplete/.test(whole.name) && !/warning|incomplete/.test(await text(page, '#explore-text')))
      await page.click('[data-testid=chart] [data-zoom=in]')
      const zoomedIn = await head(page)
      check('review 2, M2: zoomed in, the name and the text form keep the day before the range the chart now shows', zoomedIn.name.includes('18 Nov, 11:00 to 12:30') && zoomedIn.form.includes('18 Nov, 11:00 to 12:30') && !zoomedIn.form.includes('18 Nov, 18 Nov'), JSON.stringify([zoomedIn.name, zoomedIn.form]))
      const WARN = 'store-2 did not answer within 5 s; its series are missing.'
      await fetch(`${MOCK}/__mock/warn?count=1&text=${encodeURIComponent(WARN)}`)
      await page.click('[data-testid=run]')
      await page.waitForSelector('[data-testid=warnings]')
      await sleep(300)
      const partial = await page.evaluate(() => ({ banner: document.querySelector('[data-testid=warnings]').textContent.replace(/\s+/g, ' ').trim(), name: document.querySelector('[data-testid=chart] svg.vz-plot').getAttribute('aria-label'), lines: [...document.querySelectorAll('#explore-text li')].map((li) => li.textContent) }))
      const sentence = `The API sent a warning with this result, so it may be incomplete: ${WARN}`
      check('review 2, M2: when the API sends a warning the head\'s banner says the result may be incomplete, and the text form says it in the same words, straight after its first line, once', partial.banner === sentence && partial.lines[1] === sentence && partial.lines.filter((l) => l === sentence).length === 1 && partial.lines[0].includes('18 Nov, 09:30 to 12:30'), JSON.stringify([partial.banner, partial.lines.slice(0, 2)]))
      check('review 2, M2: and the chart\'s accessible name says the result may be incomplete', partial.name.includes('18 Nov, 09:30 to 12:30') && partial.name.endsWith(' The API sent a warning: the result may be incomplete.') && partial.name.split('may be incomplete').length === 2, partial.name)
      await page.click('[data-testid=view-text]')
      await page.click('[data-testid=text-view] .vz-button')
      await page.waitForFunction(() => document.querySelector('[data-testid=text-view] .vz-button').textContent === 'Copied')
      const copiedText = await page.evaluate(() => navigator.clipboard.readText())
      check('review 2, M2: the copied text form carries the day and the warning', copiedText.split('\n')[0].includes('18 Nov, 09:30 to 12:30') && copiedText.split('\n')[1] === sentence, copiedText.slice(0, 300))
      await page.click('[data-testid=view-chart]')
      await page.click('[data-testid=run]')
      await page.waitForSelector('[data-testid=warnings]', { state: 'detached' })
      await sleep(300)
      const wholeAgain = await head(page)
      check('review 2, M2: the next answer without a warning takes the sentence out of the name and the text form again', !/incomplete/.test(wholeAgain.name) && !/incomplete/.test(await text(page, '#explore-text')), wholeAgain.name)
      // m1: the head of an empty result states the range itself (no chart writes it).
      await page.goto(url('no_such_metric_total')); await page.waitForSelector('[data-testid=empty-state]')
      check('review 2, m1: the head of a result with no series states its range ("18 Nov, 09:30 to 12:30 · every 15 s")', /^18 Nov, 09:30 to 12:30\s*· every 15 s\s*· updated/.test((await head(page)).meta), (await head(page)).meta)
      // m2: the empty Step field shows no example that reads as the step.
      const stepField = await page.evaluate(() => ({ placeholder: document.querySelector('[data-testid=step]').getAttribute('placeholder'), value: document.querySelector('[data-testid=step]').value, help: document.querySelector('[data-testid=step-read]').textContent }))
      check('review 2, m2: the empty Step field shows nothing beside "Empty: automatic, now 15 s."', stepField.placeholder === null && stepField.value === '' && stepField.help === 'Empty: automatic, now 15 s.', JSON.stringify(stepField))
      // M1: every command of the palette is also a control on the page, for a pointer and a finger; the one that was not is "Copy link".
      await page.goto(url(Q_RATE)); await ready(page)
      const CONTROL = [
        [/^Go to Explore$/, '.vz-nav a[href="/explore"]'], [/^Go to Dashboards$/, '.vz-nav a[href="/dashboards"]'], [/^Go to Help$/, '.vz-nav a[href="/help"]'], [/^Go to Settings$/, '.vz-nav a[href="/settings"]'],
        [/^Use the (light|dark) theme$|^Follow the system theme$|^Sign out$/, '.vz-nav a[href="/settings"]'], // on the Settings page, one press away
        [/^Run query$/, '[data-testid=run]'], [/^Focus the query editor$/, '[data-testid=query-well]'], [/^Copy a link to this view$/, '[data-testid=copy-link]'],
        [/^Switch between the chart and the text form$/, '[data-testid=view-text]'], [/^Show the result as a table$/, '[data-testid=view-table]'], [/^Show the raw JSON$/, '[data-testid=view-json]'],
        [/^Show the last 15 min$/, '[data-testid=preset-15m]'], [/^Show the last 1 h$/, '[data-testid=preset-1h]'], [/^Show the last 6 h$/, '[data-testid=preset-6h]'], [/^Show the last 24 h$/, '[data-testid=preset-24h]'], [/^Show the last 7 d$/, '[data-testid=preset-7d]'],
      ]
      await page.keyboard.press('Control+k'); await page.waitForSelector('dialog.palette[open]')
      const titles = await page.evaluate(() => [...document.querySelectorAll('dialog.palette [role=menuitem] > span:first-child')].map((s) => s.textContent))
      // m3: Tab does not move the ring to the list; the arrow keys and Enter still act.
      await page.keyboard.press('Tab')
      const afterTab = await page.evaluate(() => ({ list: document.activeElement.id === 'cmdk-list', tab: document.querySelector('#cmdk-list').tabIndex, inside: !!document.activeElement.closest('dialog.palette') || document.activeElement === document.body }))
      check('review 2, m3: in the palette Tab does not stop on the list of commands', !afterTab.list && afterTab.tab === -1, JSON.stringify(afterTab))
      await page.keyboard.press('Escape'); await page.waitForSelector('dialog.palette[open]', { state: 'detached' })
      const without = []
      for (const t of titles) {
        const m = CONTROL.find(([re]) => re.test(t))
        const ok = m && (await page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 8 && r.height > 8 && getComputedStyle(el).visibility === 'visible' && !el.disabled }, m[1]))
        if (!ok) without.push(t)
      }
      check(`review 2, M1: every command the palette lists on Explore (${titles.length}) is also a control on the page, so none needs a keyboard`, titles.length >= 16 && without.length === 0, without.join(' | ') || titles.join(' | '))
      await page.click('[data-testid=view-table]')
      await page.click('[data-testid=copy-link]')
      await page.waitForFunction(() => document.querySelector('[data-testid=copy-link]').textContent === 'Copied')
      const link = await page.evaluate(() => navigator.clipboard.readText())
      // The address as the app reads it: the router writes a space as "+" where a typed address has "%20".
      const reads = (href, view) => { const u = new URL(href), p = u.searchParams; return u.origin + u.pathname === `${APP}/explore` && p.get('q') === Q_RATE && p.get('from') === String(T0) && p.get('to') === String(T1) && p.get('view') === view && [...p.keys()].length === (view ? 4 : 3) }
      check('review 2, M1: "Copy link" in Explore\'s head copies this view\'s address, with the form shown, and says "Copied"', reads(link, 'table'), link)
      await sleep(1700)
      await page.click('[data-testid=view-chart]')
      await page.evaluate(() => navigator.clipboard.writeText(''))
      await page.keyboard.press('Control+k'); await page.waitForSelector('dialog.palette[open]')
      await page.keyboard.type('copy a link')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('[data-testid=copy-link]').textContent === 'Copied')
      const byCommand = await page.evaluate(async () => ({ clip: await navigator.clipboard.readText(), focus: document.activeElement.getAttribute('data-testid') }))
      check('review 2, m4: the palette\'s "Copy a link to this view" presses that button: the focus is on it and it says "Copied"', reads(byCommand.clip, null) && byCommand.focus === 'copy-link', JSON.stringify(byCommand))
      check('review 2, m4: the palette\'s field has no placeholder that names a command some pages lack', (await page.getAttribute('[data-testid=palette-input]', 'placeholder')) === null)
      await page.goto(`${APP}/help`); await page.waitForSelector('[data-testid=open-commands]')
      const help = await text(page, 'main')
      check('review 2, M1: Help says the palette lists the commands of the page it is opened on, and that each is also a control', help.includes('The command palette lists the commands of the page it is opened on.') && help.includes('every command is also a control on its page'))
      // m12: a query that finds the API unreachable raises the page's banner, and is asked again by itself when the API answers.
      await page.goto(url(Q_RATE)); await ready(page)
      let sentWhileDown = 0
      const cut = (route) => { sentWhileDown++; return route.abort('connectionrefused') }
      await page.route('**/api/v1/**', cut)
      await page.click('[data-testid=run]')
      await page.waitForSelector('[data-testid=error-state][data-kind=network]')
      await page.waitForSelector('[data-testid=offline-banner]', { timeout: 5000 })
      const down = await page.evaluate(() => ({ banner: document.querySelector('[data-testid=offline-banner]').textContent.replace(/\s+/g, ' ').trim(), legend: document.querySelectorAll('[data-testid=chart] tbody tr[data-key]').length, note: document.querySelector('[data-testid=stale]')?.textContent ?? null }))
      check('review 2, m12: a query that finds the API unreachable raises the banner at the top of the page; what was on screen stays', down.banner.includes('does not answer') && down.legend === 4, JSON.stringify(down))
      await page.unroute('**/api/v1/**', cut)
      const t0 = Date.now()
      await page.waitForSelector('[data-testid=offline-banner]', { state: 'detached', timeout: 15000 })
      await page.waitForSelector('[data-testid=error-state]', { state: 'detached', timeout: 5000 })
      await ready(page)
      check('review 2, m12: when the API answers again (asked every 10 s) the banner goes and the query is asked again by itself', Date.now() - t0 < 14000 && sentWhileDown >= 2 && sentWhileDown <= 4 && (await page.locator('[data-testid=error-state]').count()) === 0, `${Date.now() - t0} ms; ${sentWhileDown} requests while the API was away`)
      await ctx.close()
      // m10: the sign-in form's checkbox is labelled with what it does.
      const anon = await newPage()
      await anon.page.goto(KEYED + '/explore'); await anon.page.waitForSelector('[data-testid=sign-in]')
      const box = await anon.page.evaluate(() => ({ label: document.querySelector('[data-testid=sign-in] label.vz-check').textContent.trim(), checked: document.querySelector('[data-testid=sign-in] label.vz-check input').checked, type: document.querySelector('[data-testid=sign-in-key]').type }))
      await anon.page.click('[data-testid=sign-in] label.vz-check')
      check('review 2, m10: the sign-in checkbox says what it does ("Show the key"), unchecked while the key is dots', box.label === 'Show the key' && !box.checked && box.type === 'password' && (await anon.page.getAttribute('[data-testid=sign-in-key]', 'type')) === 'text', JSON.stringify(box))
      await anon.ctx.close()
    }

    // ------------------------------------------------ a reload lands where the page was (the second review's B3)
    if (want('reload')) {
      const cases = [
        ['Explore, the chart of 36 series', url(Q_MANY), '[data-testid=chart] svg.vz-plot', ready],
        ['Explore, the table of 200 series', url('viz_synthetic_series', '&view=table'), '[data-testid=result-table] tbody tr:nth-child(12)', (p) => p.waitForSelector('[data-testid=result-table] tbody tr:nth-child(12)')],
        ['Explore signed in with a key, the chart', `${KEYED}/explore?q=${encodeURIComponent(Q_MANY)}&from=${T0}&to=${T1}`, '[data-testid=chart] svg.vz-plot', ready],
        ['Help', `${APP}/help`, '#help-keys', (p) => p.waitForSelector('#help-keys')],
      ]
      for (const L of [{ w: 1500, name: '1500 px, fine pointer' }, { w: 400, name: '400 px, fine pointer' }, { w: 400, coarse: true, name: '400 px, coarse pointer (coarse in Blink, no touch emulation)' }]) {
        // The phone's pointer is made coarse in the browser itself, never by touch emulation, which does not survive a reload (lib.cjs, COARSE_IN_BLINK).
        const b = L.coarse ? await chromium.launch({ args: [lib.COARSE_IN_BLINK] }) : browser
        const ctx = await lib.contextWithKey(b, 'viz_e2eReadKey0000000_goodSecret', { viewport: { width: L.w, height: 700 }, ...(L.coarse ? { isMobile: true } : {}) })
        try {
          const rows = await lib.reloadLandings(ctx, cases)
          const bad = rows.filter((r) => !(r.y0 >= 100 && r.y === r.y0 && r.moved !== null && Math.abs(r.moved) <= 1 && r.shift < 0.05 && (L.coarse ? r.coarse : r.fine)))
          check(`review 2, B3: a reload lands where the page was scrolled to, with nothing shifting (${L.name}; ${rows.length} pages, scrolled ${Math.min(...rows.map((r) => r.y0))} to ${Math.max(...rows.map((r) => r.y0))} px)`, rows.length === cases.length && bad.length === 0, JSON.stringify(bad.length ? bad : rows.map((r) => [r.y0, r.y, r.moved, r.shift])))
        } finally {
          await ctx.close()
          if (L.coarse) await b.close()
        }
      }
      // A link opened afresh starts at the top, also in a tab that remembers a position for the same page.
      const { ctx, page } = await newPage({ viewport: { width: 400, height: 700 } })
      await page.goto(url(Q_MANY)); await ready(page)
      await page.evaluate(() => scrollTo(0, 600)); await sleep(200)
      await page.goto(`${APP}/help`); await page.waitForSelector('#help-keys')
      await page.goto(url(Q_MANY)); await ready(page); await sleep(1200)
      check('review 2, B3: an address opened afresh starts at the top, also in a tab that was scrolled on that page before', (await page.evaluate(() => Math.round(scrollY))) === 0)
      // A person who scrolls while the reloaded page is still waiting for its answer is left where they went.
      await page.evaluate(() => scrollTo(0, 600)); await sleep(200)
      const was = await page.evaluate(() => Math.round(scrollY))
      await setMockDelay(1500)
      await page.reload(); await page.waitForSelector('[data-testid=chart-reserved]')
      const held = await page.evaluate(() => Math.round(scrollY))
      await page.mouse.wheel(0, -350); await sleep(300)
      const wheeled = await page.evaluate(() => Math.round(scrollY))
      await ready(page); await sleep(1300)
      const left = await page.evaluate(() => Math.round(scrollY))
      await setMockDelay(0)
      check('review 2, B3: the reloaded page is in place before its answer arrives (the chart\'s reserved height), and a wheel turned meanwhile is not undone', was === 600 && held === 600 && wheeled === 250 && left === 250, JSON.stringify({ was, held, wheeled, left }))
      await ctx.close()
    }

    // ------------------------------------------------ sign-in
    if (want('signin')) {
      const GOOD = 'viz_e2eReadKey0000000_goodSecret'
      const { ctx, page } = await newPage()
      const sent = []
      page.on('request', (r) => sent.push({ url: r.url(), auth: r.headers().authorization || '' }))
      await ctx.addInitScript(() => { if (!sessionStorage.getItem('e2e.once')) { localStorage.setItem('viz.settings', JSON.stringify({ baseUrl: '', token: 'old-token-from-before' })); sessionStorage.setItem('e2e.once', '1') } })
      const deep = `${KEYED}/explore?q=${encodeURIComponent(Q_RATE)}&from=${T0}&to=${T1}`
      await page.goto(deep)
      await page.waitForSelector('[data-testid=sign-in]')
      const form = await page.evaluate(() => ({ title: document.querySelector('[data-testid=sign-in] h1').textContent, reason: document.querySelector('[data-testid=sign-in]').dataset.reason, type: document.querySelector('[data-testid=sign-in-key]').type, name: document.querySelector('[data-testid=sign-in-key]').name, method: document.querySelector('[data-testid=sign-in] form').method, legacy: localStorage.getItem('viz.settings'), data: !!document.querySelector('[data-testid=result]'), tenant: !!document.querySelector('[data-testid=tenant]') }))
      check('without a key the page shows the sign-in form in Explore\'s place, and no data', form.title === 'No API key in this tab' && form.reason === 'none' && !form.data && !form.tenant, JSON.stringify(form))
      check('the key field is masked and has no name, and the form posts: a key cannot reach an address even without script', form.type === 'password' && form.name === '' && form.method === 'post')
      check('a token an earlier version of the app left in localStorage is removed on start, and never sent', form.legacy === null && !sent.some((r) => r.auth.includes('old-token')))
      await axe(page, 'sign-in', check)
      await page.fill('[data-testid=sign-in-key]', 'viz_e2eReadKey0000000_wrongSecret')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=sign-in-error]')
      const refused = await page.evaluate(() => ({ error: document.querySelector('[data-testid=sign-in-error]').textContent, invalid: document.querySelector('[data-testid=sign-in-key]').getAttribute('aria-invalid'), ss: sessionStorage.getItem('viz.key'), focus: document.activeElement.getAttribute('data-testid') }))
      check('a key the API refuses is said at the field, with what to check; it is not stored; focus returns to the field', refused.error.startsWith('The API did not accept this key (HTTP 401).') && refused.invalid === 'true' && refused.ss === null && refused.focus === 'sign-in-key', JSON.stringify(refused))
      await page.fill('[data-testid=sign-in-key]', 'viz_e2eWriteKey000000_writeOnly')
      await page.click('[data-testid=sign-in-submit]')
      await page.waitForFunction(() => document.querySelector('[data-testid=sign-in-error]')?.textContent.includes('cannot read metrics'))
      check('a valid key without the read scope is refused with its scopes, and not stored', (await text(page, '[data-testid=sign-in-error]')).includes('it has the write scope') && (await page.evaluate(() => sessionStorage.getItem('viz.key'))) === null)
      await page.fill('[data-testid=sign-in-key]', `  ${GOOD}  `)
      await page.click('[data-testid=sign-in-submit]')
      await ready(page)
      const inside = await page.evaluate(() => ({ url: location.href, ss: sessionStorage.getItem('viz.key'), ls: JSON.stringify(localStorage), cookie: document.cookie, tenant: document.querySelector('[data-testid=tenant]').textContent, focus: document.activeElement.getAttribute('data-testid'), html: document.documentElement.outerHTML.includes('goodSecret') }))
      check('a key that can read signs in: the page that was asked for is shown, at its address, with the tenant named', inside.url === deep && inside.tenant === 'viz-mock' && (await legend(page)).length === 4, inside.url)
      check('the key is kept in sessionStorage only: not in localStorage, a cookie, the address or the page', inside.ss === GOOD && !inside.ls.includes('goodSecret') && inside.cookie === '' && !inside.url.includes('goodSecret') && !inside.html)
      check('after sign-in the focus is on Run query, not lost', inside.focus === 'run', String(inside.focus))
      const leaks = sent.filter((r) => /goodSecret|wrongSecret|writeOnly/.test(r.url))
      const withKey = sent.filter((r) => r.auth.includes(GOOD))
      check('no request ever carried a key in its address; the key went only as an Authorization header to this origin\'s API', leaks.length === 0 && withKey.length > 0 && withKey.every((r) => r.url.startsWith(`${KEYED}/api/`)), `${withKey.length} requests with the key`)
      await page.reload()
      await ready(page)
      check('a reload stays signed in', (await text(page, '[data-testid=tenant]')) === 'viz-mock')
      const other = await ctx.newPage()
      await other.goto(deep)
      await other.waitForSelector('[data-testid=sign-in]')
      check('another tab is not signed in: the key lives in the tab it was pasted into', (await other.evaluate(() => sessionStorage.getItem('viz.key'))) === null)
      await other.close()
      await page.goto(`${KEYED}/settings`)
      await page.waitForSelector('[data-testid=sign-out]')
      const who = await text(page, '[data-testid=settings-key] dl')
      check('Settings says whose key this is by its public part, never its secret', who.includes('Tenantviz-mock') && who.includes('read key (viz_e2eReadKey0000000_…)') && who.includes('Scopesread') && !who.includes('goodSecret'), who)
      await axe(page, 'settings', check)
      await page.click('[data-testid=sign-out]')
      await page.waitForFunction(() => sessionStorage.getItem('viz.key') === null)
      await page.goto(deep)
      await page.waitForSelector('[data-testid=sign-in]')
      check('Sign out forgets the key; Explore asks for one again and says why', (await text(page, '[data-testid=sign-in] h1')) === 'Signed out' || (await text(page, '[data-testid=sign-in] h1')) === 'No API key in this tab')
      await ctx.close()
      // A key that stopped working: the tab's key is refused on load.
      const stale = await lib.contextWithKey(browser, 'viz_e2eReadKey0000000_rotatedAway')
      const sp = await stale.newPage()
      await sp.goto(deep)
      await sp.waitForSelector('[data-testid=sign-in]')
      check('a key the API no longer accepts is removed from the tab, and the form says so', (await text(sp, '[data-testid=sign-in] h1')) === "The API no longer accepts this tab's key" && (await sp.evaluate(() => sessionStorage.getItem('viz.key'))) === null)
      await stale.close()
      // Help needs no key.
      const anon = await newPage()
      await anon.page.goto(`${KEYED}/help`)
      await anon.page.waitForSelector('h1')
      check('Help is readable without a key, and Settings says "Not signed in"', (await text(anon.page, 'h1')) === 'Help')
      await anon.page.goto(`${KEYED}/settings`)
      await anon.page.waitForSelector('[data-testid=settings-key]')
      check('Settings without a key shows no identity and keeps the theme choice', (await text(anon.page, '[data-testid=settings-key] p')).startsWith('Not signed in') && (await anon.page.locator('[data-testid=theme-dark]').count()) === 1)
      await anon.ctx.close()
    }

    // ------------------------------------------------ accessibility, and the second theme
    if (want('axe')) {
      for (const theme of ['light', 'dark']) {
        const { ctx, page } = await newPage({ colorScheme: theme })
        await page.goto(url(Q_MANY)); await ready(page); await axe(page, `chart, 36 series, ${theme}`, check)
        await page.click('[data-testid=view-table]'); await page.waitForSelector('[data-testid=result-table] tbody tr'); await axe(page, `table, ${theme}`, check)
        await page.click('[data-testid=view-text]'); await axe(page, `text form, ${theme}`, check)
        await page.goto(url(Q_BAD)); await page.waitForSelector('[data-testid=error-state]'); await axe(page, `error, ${theme}`, check)
        await page.goto(`${APP}/explore`); await page.waitForSelector('[data-testid=start-state] a'); await axe(page, `start, ${theme}`, check)
        await page.goto(`${APP}/help`); await page.waitForSelector('h1'); await axe(page, `help, ${theme}`, check)
        await page.keyboard.press('Control+k'); await page.waitForSelector('dialog.palette[open]'); await axe(page, `command palette, ${theme}`, check)
        await ctx.close()
      }
      const phone = await newPage({ viewport: { width: 400, height: 900 }, hasTouch: true, isMobile: true })
      await phone.page.goto(url(Q_RATE)); await ready(phone.page); await axe(phone.page, 'chart, 400 px, touch', check)
      check('the phone run of axe had a coarse pointer', await phone.page.evaluate(() => matchMedia('(pointer: coarse)').matches))
      await phone.ctx.close()
      // The theme: chosen on the Settings page, applied before first paint from a script file.
      const dark = await newPage()
      await dark.page.goto(`${APP}/settings`)
      await dark.page.click('[data-testid=theme-dark]')
      const applied = await dark.page.evaluate(() => ({ attr: document.documentElement.dataset.theme, ground: getComputedStyle(document.documentElement).backgroundColor, stored: localStorage.getItem('viz.theme') }))
      await dark.page.reload()
      const early = await dark.page.evaluate(() => ({ attr: document.documentElement.dataset.theme, inline: [...document.scripts].filter((s) => !s.src).length }))
      check('the theme is chosen on the Settings page, kept in this browser, and applied on the next load by a script file (the page has no inline script)', applied.attr === 'dark' && applied.ground === tokenRgb('ground', 'dark') && applied.stored === 'dark' && early.attr === 'dark' && early.inline === 0, JSON.stringify([applied, early]))
      await dark.ctx.close()
      const calm = await newPage({ reducedMotion: 'reduce' })
      await calm.page.goto(url(Q_RATE)); await ready(calm.page)
      const moving = await calm.page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => { const cs = getComputedStyle(el); return cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0) }).map((el) => el.className).slice(0, 5))
      check('with reduced motion requested, no element keeps a transition', moving.length === 0, moving.join(', '))
      await calm.ctx.close()
    }

    check('no uncaught error on any page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } finally {
    await setMockDelay(0).catch(() => {})
    await setMockFailure('busy', 0).catch(() => {})
    await browser.close()
    stopKeyed()
    stopKeyedMock()
    stop()
  }
  console.log(`\n${results.length - failed()} of ${results.length} checks pass`)
  process.exit(failed() ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
