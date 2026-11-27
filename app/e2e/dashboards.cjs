/* eslint-disable */
// End-to-end checks of the dashboards views (read-only): the list at /dashboards and one
// dashboard at /dashboards?id=<id>, on the mock. Needs `npm run build`. Starts the mock and
// `vite preview` itself (ports VIZ_E2E_APP_PORT, VIZ_E2E_MOCK_PORT), and a second mock that
// requires a key (mock port + 10: a key with `read` only, one with `read` and `dashboards:read`,
// one with `write` only) with its own preview (app port + 20), and stops them.
//
//   node e2e/dashboards.cjs
//   VIZ_ONLY=list,states node e2e/dashboards.cjs    only the named sections
//
// Each check is named for what a person would see. The safety properties (README, "Mutants of
// the dashboards change") are marked [key], [six], [superseded], [isolated], [kind].
const lib = require('./lib.cjs')
const { chromium, APP, MOCK, T0, T1, makeChecker, axe, hitAreas, overflow, tokenRgb } = lib
const { check, failed, results } = makeChecker()
const only = (process.env.VIZ_ONLY || '').split(',').filter(Boolean)
const want = (name) => only.length === 0 || only.includes(name)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const KEYED_MOCK_PORT = lib.MOCK_PORT + 10
const KEYED_APP_PORT = lib.APP_PORT + 20
const KEYED = `http://127.0.0.1:${KEYED_APP_PORT}`
const KEYED_MOCK = `http://127.0.0.1:${KEYED_MOCK_PORT}`
const READ = 'viz_e2eReadKey0000000_readOnlySecret'
const DASH = 'viz_e2eDashKey0000000_dashSecretValue'
const WRITE = 'viz_e2eWriteKey000000_writeOnly'

const RANGE = `&from=${T0}&to=${T1}`
const dash = (id, extra = '', base = APP) => `${base}/dashboards?id=${id}${RANGE}${extra}`
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, sel)
/** Every panel has its answer, its error or its stop: nothing waits. */
const settled = async (page, n) => {
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=panel]').length >= n && !document.querySelector('[data-testid=panel][data-state=waiting], [data-testid=panel][data-state=idle]'), n, { timeout: 30000 })
  await page.evaluate(() => document.fonts.ready)
}
const panels = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid=panel]')].map((p) => ({
      id: p.dataset.panel,
      kind: p.dataset.kind,
      state: p.dataset.state,
      title: p.querySelector('.vz-panel-title').textContent,
      lines: p.querySelectorAll('svg.vz-plot .vz-line').length,
      plots: p.querySelectorAll('svg.vz-plot').length,
      stats: p.querySelectorAll('.vz-stat-value').length,
      tables: p.querySelectorAll('[data-testid=panel-table] table').length,
      notDrawn: p.querySelector('[data-testid=panel-not-drawn]')?.textContent.replace(/\s+/g, ' ') ?? null,
      error: p.querySelector('[data-testid=panel-error]')?.textContent.replace(/\s+/g, ' ') ?? null,
      empty: p.querySelector('[data-testid=panel-empty]')?.textContent.replace(/\s+/g, ' ') ?? null,
      meta: p.querySelector('[data-testid=panel-meta]')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      stale: !!p.querySelector('[data-testid=panel-stale]'),
      links: [...p.querySelectorAll('[data-testid=open-in-explore]')].map((a) => a.getAttribute('href')),
      top: Math.round(p.getBoundingClientRect().top + scrollY),
      width: Math.round(p.getBoundingClientRect().width),
    })),
  )
/** Watches the page's API requests: how many are in flight at once, which were aborted, what was sent. */
function watch(page) {
  const w = { inFlight: 0, peak: 0, sent: [], aborted: [], finished: [], open: new Set() }
  const api = (r) => new URL(r.url()).pathname.startsWith('/api/')
  page.on('request', (r) => {
    if (!api(r)) return
    w.open.add(r)
    w.inFlight = w.open.size
    w.peak = Math.max(w.peak, w.open.size)
    w.sent.push({ url: r.url(), method: r.method(), body: r.postData() || '', auth: r.headers().authorization || '', at: Date.now() })
  })
  page.on('requestfinished', (r) => { if (api(r)) { w.open.delete(r); w.inFlight = w.open.size; w.finished.push({ url: r.url(), body: r.postData() || '', at: Date.now() }) } })
  page.on('requestfailed', (r) => { if (api(r)) { w.open.delete(r); w.inFlight = w.open.size; w.aborted.push({ url: r.url(), body: r.postData() || '', why: r.failure()?.errorText ?? '', at: Date.now() }) } })
  return w
}
const queries = (list) => list.filter((r) => /\/api\/v1\/query(_range)?$/.test(new URL(r.url).pathname))
const mockDelay = (ms, base = MOCK) => fetch(`${base}/__mock/delay?ms=${ms}`).then((r) => r.arrayBuffer())

async function main() {
  const stops = [await lib.startServers()]
  stops.push(await lib.startMock(KEYED_MOCK_PORT, ['--require-token', READ, '--readless-token', WRITE, '--dashboards-token', DASH]))
  stops.push(await lib.startPreview(KEYED_APP_PORT, KEYED_MOCK))
  const browser = await chromium.launch()
  const newPage = async (options = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', ...options })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    return { ctx, page, errors }
  }
  const phone = { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true }

  try {
    // ------------------------------------------------ the list
    if (want('list')) {
      const { ctx, page, errors } = await newPage()
      const w = watch(page)
      await page.goto(`${APP}/explore`)
      await page.waitForSelector('nav.vz-nav')
      const nav = await page.evaluate(() => [...document.querySelectorAll('nav.vz-nav a')].map((a) => a.textContent))
      check('the navigation has Dashboards, between Explore and Help', nav.join(',') === 'Explore,Dashboards,Help,Settings', nav.join(','))
      await page.keyboard.press('Control+k')
      await page.waitForSelector('dialog.palette[open]')
      await page.keyboard.type('dashboards')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=dashboard-row]')
      check('the command palette\'s "Go to Dashboards" opens the list at /dashboards', new URL(page.url()).pathname === '/dashboards' && new URL(page.url()).search === '', page.url())
      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid=dashboard-row]')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim())))
      check('the list shows every dashboard by name, with its intent, tags, owner and who changed it last and when', rows.length === 4 && rows.map((r) => r[0]).join('|') === 'Checkout path|Pod capacity|Service: rate, errors, duration|Services overview' && rows[1][1].startsWith('Capacity review.') && rows[1][2] === 'capacity, platform' && rows[1][3] === 'platform' && rows[1][4] === '2 Nov 08:01 by Lee', JSON.stringify(rows.map((r) => [r[0], r[2], r[3], r[4]])))
      check('a dashboard nobody owns says so, and a change by an agent says it was an agent', rows[0][3] === 'nobody' && rows[2][4] === '18 Nov 13:20 by incident-agent (agent)', `${rows[0][3]} / ${rows[2][4]}`)
      check('the caption says how many dashboards and in what order, and the rows are in that order', (await text(page, '[data-testid=list-caption]')) === '4 dashboards, by name.', await text(page, '[data-testid=list-caption]'))
      check('the nav marks Dashboards as the current section; the page is titled', (await page.evaluate(() => document.querySelector('nav.vz-nav a[aria-current=page]')?.textContent)) === 'Dashboards' && (await page.title()) === 'Dashboards · viz')
      const listReq = w.sent.filter((r) => r.url.includes('/api/v1/control/dashboards'))
      check('the list is asked of control\'s GET /api/v1/control/dashboards', listReq.length >= 1 && listReq.every((r) => r.method === 'GET'), listReq.map((r) => new URL(r.url).pathname + new URL(r.url).search).join(' '))
      const blues = await page.evaluate((blue) => [...document.querySelectorAll('main *')].filter((el) => getComputedStyle(el).backgroundColor === blue).length, tokenRgb('blue', 'light'))
      check('the list has no blue button: nothing here is the view\'s one action (read-only)', blues === 0)
      await axe(page, 'dashboards list', check)

      // search
      w.sent.length = 0
      await page.fill('[data-testid=dashboards-search]', 'capacity')
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=dashboard-row]').length === 1)
      check('typing in Search asks the API (q=…) and shows what matched, with the count of all', (await text(page, '[data-testid=list-caption]')) === '1 of 4 dashboards match, by name.' && w.sent.some((r) => /dashboards\?q=capacity&limit=200$/.test(r.url)) && new URL(page.url()).searchParams.get('q') === 'capacity', `${await text(page, '[data-testid=list-caption]')} ${page.url()}`)
      check('the search field keeps the focus while the list changes', (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'dashboards-search')
      await page.fill('[data-testid=dashboards-search]', 'zzz-nothing')
      await page.waitForSelector('[data-testid=list-empty]')
      const emptyText = await text(page, '[data-testid=list-empty]')
      check('a search that matches nothing says what was asked and how many dashboards there are, and is not an error', emptyText.startsWith('No dashboard matched') && emptyText.includes('zzz-nothing') && emptyText.includes('There are 4 dashboards in all.') && !(await page.$('[data-testid=list-empty] .vz-mark')), emptyText)
      await page.click('[data-testid=list-clear]')
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=dashboard-row]').length === 4)
      check('"Show every dashboard" clears the search, the address and the field, and focus goes to the field', (await page.inputValue('[data-testid=dashboards-search]')) === '' && new URL(page.url()).search === '' && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'dashboards-search', page.url())
      // tag
      const tags = await page.evaluate(() => [...document.querySelectorAll('[data-testid=dashboards-tag] option')].map((o) => o.textContent))
      await page.selectOption('[data-testid=dashboards-tag]', 'on-call')
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=dashboard-row]').length === 3)
      check('the Tag filter offers the tags of every dashboard and keeps the dashboards that carry the chosen one', tags.join(',') === 'Any tag,capacity,checkout,on-call,platform,red,services' && new URL(page.url()).searchParams.get('tag') === 'on-call' && (await text(page, '[data-testid=list-caption]')) === '3 of 4 dashboards match, by name.', `${tags.join(',')} ${await text(page, '[data-testid=list-caption]')}`)
      // a deep link to a filtered list
      await page.goto(`${APP}/dashboards?q=checkout&tag=on-call`)
      await page.waitForSelector('[data-testid=dashboard-row]')
      check('a link to a filtered list opens it filtered, the field and the select showing the filter', (await page.inputValue('[data-testid=dashboards-search]')) === 'checkout' && (await page.inputValue('[data-testid=dashboards-tag]')) === 'on-call' && (await page.$$('[data-testid=dashboard-row]')).length >= 1)
      check('no script error on the list', errors.length === 0, errors.join(' | '))
      await ctx.close()
    }

    // ------------------------------------------------ the list's states
    if (want('states')) {
      const { ctx, page } = await newPage()
      // waiting: nothing for 400 ms, then what is being waited for and for how long; never a skeleton or a spinner
      await page.route('**/api/v1/control/dashboards*', async (route) => { await sleep(1300); await route.continue() })
      await page.goto(`${APP}/dashboards`)
      await page.waitForSelector('[data-testid=dashboards-list]')
      const early = await page.evaluate(() => ({ progress: !!document.querySelector('[data-testid=list-progress]'), rows: document.querySelectorAll('[data-testid=dashboard-row]').length, busy: document.querySelector('[data-testid=dashboards-region]').getAttribute('aria-busy') }))
      await page.waitForSelector('[data-testid=list-progress]', { timeout: 3000 })
      const waitingText = await text(page, '[data-testid=list-progress]')
      const decorative = await page.evaluate(() => document.querySelectorAll('[class*=skeleton], [class*=spinner], [class*=shimmer], .vz-progress-bar').length)
      check('while the list is asked for: nothing but a busy region before 400 ms, then a line that says what is waited for and for how long', early.progress === false && early.rows === 0 && early.busy === 'true' && /^Asking the API for the dashboards\.\s?\d\.\d s$/.test(waitingText), `${JSON.stringify(early)} "${waitingText}"`)
      check('no skeleton, spinner or progress bar is drawn for work that is not measured', decorative === 0)
      await page.waitForSelector('[data-testid=dashboard-row]')
      await sleep(400)
      check('the waiting line goes when the list arrives', !(await page.$('[data-testid=list-progress]')))
      await page.unroute('**/api/v1/control/dashboards*')

      // error: the API fails; Ask again recovers
      let fail = true
      await page.route('**/api/v1/control/dashboards*', async (route) => {
        if (!fail) return route.continue()
        await route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ type: 'https://vis.bitcru.sh/problems/internal', title: 'Internal error', status: 500, code: 'internal', detail: 'Something went wrong on our side. Nothing was changed.', fix: 'Retry. If it keeps failing, report the time of the request.' }) })
      })
      await page.goto(`${APP}/dashboards`)
      await page.waitForSelector('[data-testid=list-error]')
      const err = await text(page, '[data-testid=list-error]')
      check('when the API fails, the list\'s place says so with the API\'s own words, its status, and what to do', err.includes('The dashboards could not be listed') && err.includes('Something went wrong on our side. Nothing was changed.') && err.includes('The API answered internal with HTTP 500.') && !!(await page.$('[data-testid=list-error] .vz-mark[data-state=critical]')) && !(await page.$('[data-testid=dashboard-row]')), err)
      check('the shell stays: navigation and title are there under an error', (await text(page, 'h1')) === 'Dashboards' && !!(await page.$('nav.vz-nav')))
      fail = false
      await page.click('[data-testid=list-retry]')
      await page.waitForSelector('[data-testid=dashboard-row]')
      check('"Ask again" asks again and the list comes back', (await page.$$('[data-testid=dashboard-row]')).length === 4 && !(await page.$('[data-testid=list-error]')))
      await page.unroute('**/api/v1/control/dashboards*')

      // first run: a tenant with no dashboards
      await page.route('**/api/v1/control/dashboards*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, next: null }) }))
      await page.goto(`${APP}/dashboards`)
      await page.waitForSelector('[data-testid=list-first-run]')
      const first = await text(page, '[data-testid=list-first-run]')
      check('a tenant with no dashboards sees what a dashboard is and how one is made, truthfully (this app cannot make one), and no search', first.startsWith('No dashboards yet') && first.includes('cannot make one yet') && first.includes('POST /api/v1/control/dashboards') && !(await page.$('[data-testid=dashboards-search]')) && !(await page.$('[data-testid=list-empty]')), first)
      await axe(page, 'dashboards, first run', check)
      await page.unroute('**/api/v1/control/dashboards*')

      // partial: more dashboards than one answer holds
      await page.route('**/api/v1/control/dashboards*', async (route) => {
        const res = await route.fetch()
        const body = await res.json()
        await route.fulfill({ response: res, body: JSON.stringify({ ...body, total: 431, next: 'abc' }) })
      })
      await page.goto(`${APP}/dashboards`)
      await page.waitForSelector('[data-testid=dashboard-row]')
      const partial = await text(page, '[data-testid=list-caption]')
      const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid=dashboard-row] td[data-key]')].map((td) => td.textContent))
      check('a list that is not whole says how many of how many, in the order the API gave them, and how to narrow it', partial === '4 of 431 dashboards, the first by id. Search to narrow the list.' && order.join('|') === 'Checkout path|Pod capacity|Service: rate, errors, duration|Services overview', `${partial} ${order.join('|')}`)
      await ctx.close()

      // no permission: a key that reads metrics and not dashboards
      const keyed = await lib.contextWithKey(browser, READ)
      const kp = await keyed.newPage()
      await kp.goto(`${KEYED}/dashboards`)
      await kp.waitForSelector('[data-testid=no-permission]')
      const refused = await text(kp, '[data-testid=no-permission]')
      check('a key without dashboards:read sees why: the API\'s refusal, the scopes the key has, the scope it needs, and the way to another key', refused.includes('This key cannot read dashboards') && refused.includes('This needs one of the scopes: admin, dashboards:read, dashboards:write, dashboards:apply.') && refused.includes('has read.') && refused.includes('Explore still works with this key') && !(await kp.$('[data-testid=dashboard-row]')) && !(await kp.$('[data-testid=dashboards-search]')), refused)
      await kp.goto(dash('service_red', '', KEYED))
      await kp.waitForSelector('[data-testid=no-permission]')
      check('the same key on a dashboard\'s own address is told the same, and no panel is asked for', !(await kp.$('[data-testid=panel]')))
      await kp.goto(`${KEYED}/explore?q=up&from=${T0}&to=${T1}`)
      await kp.waitForSelector('[data-testid=chart] svg.vz-plot .vz-line', { state: 'attached' })
      check('Explore still works with that key', true)
      await kp.goto(`${KEYED}/dashboards`)
      await kp.waitForSelector('[data-testid=no-permission-sign-in]')
      await axe(kp, 'dashboards, no permission', check)
      await kp.click('[data-testid=no-permission-sign-in]')
      await kp.waitForSelector('[data-testid=sign-in]')
      check('"Sign in with another key" forgets the key and shows the sign-in form at this address', (await kp.evaluate(() => sessionStorage.getItem('viz.key'))) === null && new URL(kp.url()).pathname === '/dashboards')
      await keyed.close()
    }

    // ------------------------------------------------ one dashboard
    if (want('dashboard')) {
      const { ctx, page, errors } = await newPage()
      const w = watch(page)
      await page.goto(`${APP}/dashboards`)
      await page.waitForSelector('[data-testid=open-services_overview]')
      await page.click('[data-testid=open-services_overview]')
      await page.waitForSelector('[data-testid=dashboard-page]')
      check('a dashboard\'s address is /dashboards?id=<id>: the document path stays /dashboards', new URL(page.url()).pathname === '/dashboards' && new URL(page.url()).searchParams.get('id') === 'services_overview', page.url())
      await page.goto(dash('services_overview'))
      w.sent.length = 0
      w.peak = 0
      await page.reload()
      await settled(page, 12)
      const ps = await panels(page)
      const head = await page.evaluate(() => ({ title: document.querySelector('[data-testid=dashboard-title]').textContent, intent: document.querySelector('[data-testid=dashboard-intent]').textContent, facts: document.querySelector('[data-testid=dashboard-facts]').textContent.replace(/\s+/g, ' ').trim(), doc: document.title, sections: [...document.querySelectorAll('.vz-section-title')].map((h) => h.textContent), read: document.querySelector('[data-testid=time-read]').textContent }))
      check('the dashboard shows its title and its intent, and who changed it last', head.title === 'Services overview' && head.intent.startsWith('On-call view of the four API services.') && head.facts.startsWith('Revision 1, changed 24 Nov 16:12 by Dana.') && head.doc === 'Services overview · Dashboards · viz', JSON.stringify(head))
      check('it says how many panels it has and how many have answered: a measured count', head.facts.endsWith('12 panels, all answered.'), head.facts)
      check('its time range is in the same fields Explore has, read back the same way', head.read === 'Read as 18 Nov, 09:30 to 12:30, 3 h, UTC.' && !!(await page.$('[data-testid=range-controls] [data-testid=preset-6h]')), head.read)
      check('the panels are laid out as the spec says: its rows as headed sections, in its reading order', head.sections.join('|') === 'Health|Traffic|Latency and routes|Pods|Detail' && ps.map((p) => p.id).join(',') === 'requests,error_ratio,latency,pods,rate_by_service,errors_by_service,latency_by_service,rate_by_route,cpu,memory,routes,capacity', ps.map((p) => p.id).join(','))
      const health = ps.slice(0, 4)
      check('at 1440 px a row of four stats is four columns, and a row of two charts is two', new Set(health.map((p) => p.top)).size === 1 && health.every((p) => Math.abs(p.width - health[0].width) <= 1) && ps[4].top === ps[5].top && ps[4].width > health[0].width * 1.9, JSON.stringify(ps.slice(0, 6).map((p) => [p.top, p.width])))
      check('every panel is answered: timeseries drawn by the system\'s chart, stats as figures, tables as tables', ps.every((p) => p.state === 'answered') && ps.filter((p) => p.kind === 'timeseries').every((p) => p.plots === 1 && p.lines >= 4) && ps.filter((p) => p.kind === 'stat').every((p) => p.stats === 1 && p.plots === 0) && ps.filter((p) => p.kind === 'table').every((p) => p.tables === 1 && p.plots === 0), JSON.stringify(ps.map((p) => [p.id, p.state, p.lines, p.stats, p.tables])))
      const sentQueries = queries(w.sent)
      check('[six] fourteen queries for twelve panels, each sent once, through POST /api/v1/query_range', sentQueries.length === 14 && sentQueries.every((r) => r.method === 'POST' && r.url.endsWith('/api/v1/query_range')), `${sentQueries.length} queries`)
      const windows = new Set(sentQueries.map((r) => { const b = new URLSearchParams(r.body); return `${b.get('start')}-${b.get('end')}-${b.get('step')}` }))
      check('every panel is asked over the same window and step', windows.size === 1 && [...windows][0] === `${T0 / 1000}-${T1 / 1000}-30`, [...windows].join(' '))

      // stats
      const stats = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid=panel][data-kind=stat]')].map((p) => [p.dataset.panel, { value: p.querySelector('[data-testid=stat-value]').textContent, context: p.querySelector('[data-testid=stat-context]').textContent.replace(/\s+/g, ' ').trim(), state: p.querySelector('[data-testid=stat-state]')?.dataset.state ?? null }])))
      check('a stat is one figure with its unit, and a context line that starts with what the figure covers', /^\d+(\.\d+)?req\/s$/.test(stats.requests.value) && /^\d\.\d+%$/.test(stats.error_ratio.value) && stats.pods.value === '12' && stats.requests.context.startsWith('Last value of 18 Nov, 09:30 to 12:30.'), JSON.stringify(stats))
      check('a stat with thresholds says its state as a status mark and words; the figure itself is not coloured', stats.error_ratio.state === 'ok' && stats.error_ratio.context.endsWith('Within its thresholds') && (await page.evaluate((ink) => [...document.querySelectorAll('[data-testid=stat-value]')].every((el) => getComputedStyle(el).color === ink), tokenRgb('ink', 'light'))), JSON.stringify(stats.error_ratio))

      // tables
      const table = await page.evaluate(() => {
        const p = document.querySelector('[data-testid=panel][data-panel=routes]')
        return { caption: p.querySelector('[data-testid=panel-table-caption]').textContent.replace(/\s+/g, ' ').trim(), heads: [...p.querySelectorAll('th')].map((th) => th.textContent), rows: [...p.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)), right: [...p.querySelectorAll('td.vz-right')].every((td) => getComputedStyle(td).textAlign === 'right') }
      })
      const reqs = table.rows.map((r) => Number(r[2].replace(/,/g, '')))
      check('a table panel has one row per series and one column per query, the unit once in the column head, figures right-aligned', table.heads.join('|') === 'route|service|Requests, req/s|Errors, req/s' && table.rows.length === 8 && table.right && table.rows.every((r) => /^[\d.,]+$/.test(r[2]) && /^[\d.,]+$/.test(r[3])), JSON.stringify([table.heads, table.rows[0]]))
      check('its caption says how many rows of how many and in what order, and the rows are in that order', table.caption === '8 of 12 rows, highest Requests first.' && reqs.every((v, i) => i === 0 || reqs[i - 1] >= v), `${table.caption} ${reqs.join(',')}`)

      // text form
      await page.click('[data-testid=panel][data-panel=rate_by_service] [data-testid=panel-text] summary')
      await page.waitForSelector('[data-testid=panel][data-panel=rate_by_service] [data-testid=panel-digest]')
      const digest = await page.evaluate(() => document.querySelector('[data-testid=panel][data-panel=rate_by_service] [data-testid=panel-digest]').textContent)
      check('every panel has its text form: the model\'s digest of that panel, with its kind, unit, description and series', /^## (\[[A-Z ]+\] )?Requests by service — rate_by_service \(timeseries, req\/s\)/.test(digest) && digest.includes('Throughput per service.') && /\n4 series[,.]/.test(digest) && digest.includes('| catalog |') && (await page.$$('[data-testid=panel-text]')).length === 12, digest.slice(0, 200))
      await page.click('[data-testid=form-text]')
      await page.waitForSelector('[data-testid=dashboard-digest]')
      const whole = await page.evaluate(() => document.querySelector('[data-testid=dashboard-digest]').textContent)
      check('the whole dashboard has a text form too: the model\'s digest, with the range and every panel', /^# Services overview \(services_overview, rev [0-9a-f]{12}\)/.test(whole) && whole.includes('range 2026-11-18T09:30:00.000Z → 2026-11-18T12:30:00.000Z') && whole.includes('12 panels: ') && (whole.match(/^## /gm) || []).length === 12, whole.slice(0, 300))
      await page.click('[data-testid=form-panels]')
      await page.waitForSelector('[data-testid=panel]')

      // Open in Explore
      const link = (await panels(page)).find((p) => p.id === 'errors_by_service').links[0]
      const lu = new URL(link, APP)
      check('"Open in Explore" carries the panel\'s resolved query and the dashboard\'s range', lu.pathname === '/explore' && lu.searchParams.get('q') === 'sum by (service) (rate(http_requests_total{status="500"}[5m]))' && lu.searchParams.get('from') === String(T0) && lu.searchParams.get('to') === String(T1), link)
      check('every panel that has a query has the link; a panel with two queries has one per query, named', (await panels(page)).every((p) => p.links.length === (p.kind === 'table' ? 2 : 1)) && (await page.evaluate(() => [...document.querySelectorAll('[data-panel=routes] [data-testid=open-in-explore]')].map((a) => a.textContent).join('|'))) === 'Open Requests in Explore|Open Errors in Explore')
      await page.click('[data-testid=panel][data-panel=errors_by_service] [data-testid=open-in-explore]')
      await page.waitForSelector('[data-testid=chart] svg.vz-plot .vz-line', { state: 'attached' })
      check('the link opens Explore on that query and range, and the chart draws', new URL(page.url()).pathname === '/explore' && (await text(page, '[data-testid=result-query]')) === 'sum by (service) (rate(http_requests_total{status="500"}[5m]))' && (await text(page, '[data-testid=time-read]')) === 'Read as 18 Nov, 09:30 to 12:30, 3 h, UTC.', await text(page, '[data-testid=time-read]'))
      await page.goBack()
      await settled(page, 12)
      check('Back returns to the dashboard', (await text(page, '[data-testid=dashboard-title]')) === 'Services overview')
      await axe(page, 'dashboard, 12 panels', check)
      check('no script error on the dashboard', errors.length === 0, errors.join(' | '))

      // a dashboard that does not exist
      await page.goto(`${APP}/dashboards?id=no_such_board`)
      await page.waitForSelector('[data-testid=dashboard-error]')
      const missing = await text(page, '[data-testid=dashboard-error]')
      check('an id no dashboard has says so, with the id, and leads to the list', missing.includes('There is no such dashboard') && missing.includes('no_such_board') && !!(await page.$('[data-testid=to-list]')), missing)
      await page.click('[data-testid=to-list]')
      await page.waitForSelector('[data-testid=dashboard-row]')
      check('"See every dashboard" opens the list', new URL(page.url()).search === '')

      // a spec the model refuses is not drawn
      await page.route('**/api/v1/control/dashboards/service_red', async (route) => {
        const res = await route.fetch()
        const body = await res.json()
        body.spec.panels.cpu.kind = 'gauge'
        await route.fulfill({ response: res, body: JSON.stringify(body) })
      })
      const queriesBefore = queries(w.sent).length
      await page.goto(dash('service_red'))
      await page.waitForSelector('[data-testid=dashboard-invalid]')
      await sleep(500)
      const invalid = await text(page, '[data-testid=dashboard-invalid]')
      check('[kind] a spec with a panel kind the model does not have is refused by the model\'s validation: nothing of it is drawn, and the page says where the problem is', invalid.includes('not a valid viz.dashboard/v1') && invalid.includes('/panels/cpu/kind') && !(await page.$('[data-testid=panel]')) && queries(w.sent).length === queriesBefore, `${invalid}; queries sent: ${queries(w.sent).length - queriesBefore}`)
      await ctx.close()
    }

    // ------------------------------------------------ kinds not drawn, a failing query, a query that matches nothing
    if (want('panels')) {
      const { ctx, page, errors } = await newPage()
      await page.goto(dash('pod_capacity'))
      await settled(page, 6)
      const ps = Object.fromEntries((await panels(page)).map((p) => [p.id, p]))
      const facts = await text(page, '[data-testid=load-summary]')
      check('[isolated] one panel\'s query is refused: that panel shows the API\'s message, its error type and status, and what it means', ps.sample.state === 'failed' && ps.sample.error.includes('This panel\'s query could not run') && ps.sample.error.includes('limitk') && ps.sample.error.includes('The API answered unsupported with HTTP 422.') && ps.sample.error.includes('viz does not run this part of PromQL yet'), ps.sample.error)
      check('[isolated] the other five panels are answered and drawn, and the page says five answered and one not', ['cpu', 'durations', 'memory', 'notes', 'restarts'].every((id) => ps[id].state === 'answered' && ps[id].error === null) && ps.cpu.lines >= 8 && ps.memory.stats === 1 && facts === '6 panels, 5 answered and 1 not.' && (await text(page, '[data-testid=dashboard-title]')) === 'Pod capacity', facts)
      check('[isolated] a refusal that asking again would not change offers no "Run this panel again"; the panel keeps its link to Explore', !(await page.$('[data-panel=sample] [data-testid=panel-retry]')) && ps.sample.links.length === 1)
      check('[kind] a heatmap is not drawn as anything else: no plot, no figure, no table; it says it is a heatmap this app does not draw, and shows the model\'s text for it', ps.durations.kind === 'heatmap' && ps.durations.plots === 0 && ps.durations.stats === 0 && ps.durations.tables === 0 && ps.durations.notDrawn.includes('This panel is a heatmap, a kind this app does not draw yet.') && ps.durations.notDrawn.includes('Request duration distribution — durations (heatmap, s)') && ps.durations.notDrawn.includes('12 series'), ps.durations.notDrawn.slice(0, 220))
      check('[kind] a text note is shown as the model\'s text for it, and says so', ps.notes.kind === 'text' && ps.notes.plots === 0 && ps.notes.notDrawn.includes('This panel is a text note, a kind this app does not draw yet.') && ps.notes.notDrawn.includes('CPU is in cores, memory in bytes.') && ps.notes.links.length === 0, ps.notes.notDrawn)
      check('a query that matches nothing is an empty state, not an error: what was asked, over which range, and what to check', ps.restarts.state === 'answered' && ps.restarts.empty.startsWith('No series matched') && ps.restarts.empty.includes('18 Nov, 09:30 to 12:30') && ps.restarts.plots === 0 && !(await page.$('[data-panel=restarts] .vz-mark')), ps.restarts.empty)
      check('an explicit grid is laid out in its reading order, each panel as wide as its share', Object.keys(ps).join(',') === 'cpu,durations,memory,sample,notes,restarts' && ps.cpu.top === ps.durations.top && ps.memory.top === ps.sample.top && ps.sample.top === ps.notes.top && ps.sample.width > ps.memory.width * 1.9, JSON.stringify(Object.values(ps).map((p) => [p.id, p.top, p.width])))
      await axe(page, 'dashboard with a failed, an empty and two undrawn panels', check)

      // a failure that asking again can change: the API is busy for one panel
      await page.route('**/api/v1/query_range', async (route) => {
        if ((route.request().postData() || '').includes('sum%28pod_memory')) return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Retry-After': '1' }, body: JSON.stringify({ status: 'error', errorType: 'unavailable', error: 'the query service is busy; retry' }) })
        return route.continue()
      })
      await page.reload()
      await settled(page, 6)
      const busy = Object.fromEntries((await panels(page)).map((p) => [p.id, p]))
      check('[isolated] a busy answer for one stat fails that stat only, and offers "Run this panel again"', busy.memory.state === 'failed' && busy.memory.error.includes('the query service is busy; retry') && busy.cpu.state === 'answered' && !!(await page.$('[data-panel=memory] [data-testid=panel-retry]')), busy.memory.error)
      await page.unroute('**/api/v1/query_range')
      await page.click('[data-panel=memory] [data-testid=panel-retry]')
      await page.waitForSelector('[data-panel=memory] [data-testid=stat-value]')
      check('"Run this panel again" asks that panel again and it is answered; the count follows', (await text(page, '[data-testid=load-summary]')) === '6 panels, 5 answered and 1 not.' && /GiB$/.test(await text(page, '[data-panel=memory] [data-testid=stat-value]')), await text(page, '[data-testid=load-summary]'))
      check('no script error', errors.length === 0, errors.join(' | '))

      // fragments
      await page.goto(dash('checkout_path'))
      await settled(page, 4)
      const frag = await panels(page)
      const sections = await page.evaluate(() => [...document.querySelectorAll('.vz-section-title')].map((h) => h.textContent))
      check('a fragment used twice is drawn twice, each under its row, with its own queries', sections.join('|') === 'checkout|orders' && frag.map((p) => p.id).join(',') === 'checkout.rate,checkout.latency,orders.rate,orders.latency' && new URL(frag[2].links[0], APP).searchParams.get('q').includes('service="orders"') && frag.every((p) => p.state === 'answered' && p.lines >= 1), JSON.stringify(frag.map((p) => [p.id, p.lines])))
      await ctx.close()
    }

    // ------------------------------------------------ variables
    if (want('variables')) {
      const { ctx, page, errors } = await newPage()
      const w = watch(page)
      await page.goto(dash('service_red'))
      await settled(page, 5)
      await page.waitForFunction(() => document.querySelectorAll('#var-service option').length >= 5)
      const vars = await page.evaluate(() => ({ service: [...document.querySelectorAll('#var-service option')].map((o) => o.textContent), chosen: document.querySelector('#var-service').value, label: document.querySelector('label[for=var-service]').textContent, status: [...document.querySelectorAll('[data-testid=variable-status] button')].map((b) => `${b.textContent}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`) }))
      check('a query variable is a select whose values the API listed (label values in the window), with the spec\'s default chosen', vars.label === 'Service' && vars.service.join(',') === 'All,auth,catalog,checkout,orders' && vars.chosen === 'checkout' && w.sent.some((r) => /\/api\/v1\/label\/service\/values\?match%5B%5D=http_requests_total&start=\d+&end=\d+$/.test(r.url)), JSON.stringify(vars))
      check('an enum variable with a few values is a segmented control, "All" chosen as the spec says', vars.status.join(',') === 'All*,200,400,500', vars.status.join(','))
      const before = queries(w.sent).map((r) => new URLSearchParams(r.body).get('query'))
      check('the queries carry the variables\' values as the model wrote them', before.includes('pod_cpu_usage_cores{service="checkout"}') && before.includes('sum by (status) (rate(http_requests_total{service="checkout",status=~".*"}[5m]))'), before.join(' ; '))
      w.sent.length = 0
      await page.selectOption('#var-service', 'orders')
      await page.waitForFunction(() => new URL(location.href).searchParams.get('var.service') === 'orders')
      await settled(page, 5)
      await page.waitForFunction(() => !document.querySelector('[data-testid=panel-stale]'))
      const after = queries(w.sent).map((r) => new URLSearchParams(r.body).get('query'))
      const cpu = (await panels(page)).find((p) => p.id === 'cpu')
      check('choosing another value puts it in the address, asks every panel again with it, and the links to Explore carry it', after.length === 6 && after.every((q) => q.includes('service="orders"')) && new URL(cpu.links[0], APP).searchParams.get('q') === 'pod_cpu_usage_cores{service="orders"}' && (await page.evaluate(() => { const rows = [...document.querySelectorAll('[data-panel=cpu] tbody tr[data-key]')]; return rows.length === 3 && rows.every((tr) => tr.dataset.key.includes('service=orders')) })), after.join(' ; '))
      w.sent.length = 0
      await page.click('[data-testid=variable-status] button[data-value="500"]')
      await page.waitForFunction(() => new URL(location.href).searchParams.get('var.status') === '500')
      await settled(page, 5)
      const narrowed = queries(w.sent).map((r) => new URLSearchParams(r.body).get('query'))
      check('pressing a segment of an enum does the same', narrowed.includes('sum by (status) (rate(http_requests_total{service="orders",status=~"500"}[5m]))') && (await page.evaluate(() => document.querySelector('[data-testid=variable-status] button[data-value="500"]').getAttribute('aria-pressed'))) === 'true', narrowed.join(' ; '))
      await page.reload()
      await settled(page, 5)
      check('a reload, or the link sent to someone, shows the same values', (await page.inputValue('#var-service')) === 'orders' && (await page.evaluate(() => document.querySelector('[data-testid=variable-status] button[aria-pressed=true]').textContent)) === '500')
      await page.goto(dash('service_red', '&var.service=' + encodeURIComponent('x"} or up{a="') + '&var.nope=1'))
      await settled(page, 5)
      const hostile = queries(w.sent.slice(-12)).map((r) => new URLSearchParams(r.body).get('query'))
      check('a value from the address is escaped by the model, never pasted into a query; a value for a variable the dashboard lacks is said, not ignored', hostile.some((q) => q === 'pod_cpu_usage_cores{service="x\\"} or up{a=\\""}') && (await text(page, '[data-testid=dashboard-issues]')).includes('"nope", which is not a variable of this dashboard'), `${hostile.find((q) => q.startsWith('pod_cpu'))} / ${await text(page, '[data-testid=dashboard-issues]')}`)
      check('no script error', errors.length === 0, errors.join(' | '))
      await ctx.close()
    }

    // ------------------------------------------------ requests: six in flight, cancelled, never superseded
    if (want('requests')) {
      const { ctx, page } = await newPage()
      const w = watch(page)
      await mockDelay(350)
      try {
        await fetch(`${MOCK}/__mock/inflight?reset=1`).then((r) => r.arrayBuffer())
        await page.goto(dash('services_overview'))
        await page.waitForSelector('[data-testid=panel]')
        // Sampled while the load runs: what is in flight, and what the page says of itself.
        const samples = []
        for (let i = 0; i < 60; i++) {
          samples.push({ inFlight: w.inFlight, summary: await text(page, '[data-testid=load-summary]') })
          if (!(await page.$('[data-testid=panel][data-state=waiting]'))) break
          await sleep(60)
        }
        await settled(page, 12)
        // Counted by the server (requests received and not yet answered): the page's own count of its requests would be the page's word for it.
        const server = await fetch(`${MOCK}/__mock/inflight`).then((r) => r.json())
        check('[six] with a slow API, the server never has more than six of the page\'s requests to answer at once, and it has six', server.peak === 6 && samples.some((s) => s.inFlight >= 6), `server peak ${server.peak}; the browser's own count, sampled: ${samples.map((s) => s.inFlight).join(',')}`)
        const counts = samples.map((s) => Number(/, (\d+) answered so far/.exec(s.summary || '')?.[1] ?? -1)).filter((n) => n >= 0)
        check('while panels wait, the page counts the ones answered so far, and the count only grows', counts.length >= 2 && counts.every((n, i) => i === 0 || counts[i - 1] <= n) && counts[0] < 12 && (await text(page, '[data-testid=load-summary]')) === '12 panels, all answered.', counts.join(','))

        // the range changes while the first range is still being answered
        await mockDelay(900)
        w.sent.length = 0
        w.aborted.length = 0
        w.finished.length = 0
        await page.click('[data-testid=preset-6h]')
        await sleep(450)
        const mid = await panels(page)
        const midProgress = await text(page, '[data-testid=panel-progress]')
        check('while a new range waits, every panel keeps its previous answer, says "Showing the previous range" with that range, and after 400 ms a line says what is waited for', mid.every((p) => p.state === 'waiting' && p.stale && p.meta.startsWith('Showing the previous range· 18 Nov, 09:30 to 12:30 ·')) && mid.filter((p) => p.kind === 'timeseries').every((p) => p.lines >= 4) && /^Waiting for (the query|2 queries)\.\s?\d\.\d s$/.test(midProgress), `${mid[0].meta} / ${midProgress}`)
        const firstRange = queries(w.sent).length
        await page.click('[data-testid=preset-15m]')
        await sleep(100)
        const abortedFirst = queries(w.aborted).filter((r) => { const b = new URLSearchParams(r.body); return Number(b.get('end')) - Number(b.get('start')) > 3600 })
        check('[superseded] changing the range again cancels the requests of the range before: those in flight are aborted, those waiting are never sent', firstRange === 6 && abortedFirst.length === 6 && abortedFirst.every((r) => /ABORTED/.test(r.why)), `sent for the first range ${firstRange}, aborted ${abortedFirst.length}`)
        await settled(page, 12)
        await page.waitForFunction(() => !document.querySelector('[data-testid=panel-stale]'))
        await sleep(1200)
        const end = await panels(page)
        const longAnswers = queries(w.finished).filter((r) => { const b = new URLSearchParams(r.body); return Number(b.get('end')) - Number(b.get('start')) > 3600 })
        const windows = new Set(queries(w.sent).map((r) => { const b = new URLSearchParams(r.body); return Number(b.get('end')) - Number(b.get('start')) }))
        check('[superseded] what is painted in the end is the last range\'s answer in every panel: its step, no "previous range", and no answer of the range before ever arrived', end.every((p) => p.state === 'answered' && !p.stale && p.meta.startsWith('every 15 s')) && longAnswers.length === 0 && windows.has(900), `${end[0].meta}; answers of the cancelled range: ${longAnswers.length}`)
        check('the address carries the range, also when it is Explore\'s default', new URL(page.url()).searchParams.get('from') === 'now-15m' && new URL(page.url()).searchParams.get('to') === 'now', page.url())
        await page.click('[data-testid=preset-1h]')
        await page.waitForFunction(() => new URL(location.href).searchParams.get('from') === 'now-1h')
        check('"the last hour" stays in a dashboard\'s address (left out, it would mean the dashboard\'s own three hours)', new URL(page.url()).searchParams.get('from') === 'now-1h' && new URL(page.url()).searchParams.get('id') === 'services_overview', page.url())
        await settled(page, 12)

        // leaving the view
        w.sent.length = 0
        w.aborted.length = 0
        w.finished.length = 0
        await page.click('[data-testid=refresh]')
        await sleep(250)
        const inFlightBefore = w.inFlight
        await page.click('nav.vz-nav a[href="/help"]')
        await page.waitForSelector('h1')
        await sleep(1500)
        check('[superseded] leaving the dashboard aborts its requests in flight and sends none of the ones that waited', inFlightBefore === 6 && queries(w.aborted).length === 6 && queries(w.sent).length === 6 && queries(w.finished).length === 0, `in flight ${inFlightBefore}, aborted ${queries(w.aborted).length}, sent ${queries(w.sent).length}, finished ${queries(w.finished).length}`)

        // Cancel on one panel, after 2 s
        await mockDelay(6000)
        await page.goto(dash('checkout_path'))
        await page.waitForSelector('[data-testid=panel-cancel]', { timeout: 8000 })
        await page.click('[data-panel="checkout.rate"] [data-testid=panel-cancel]')
        await page.waitForSelector('[data-panel="checkout.rate"] [data-testid=panel-halted]')
        const others = (await panels(page)).filter((p) => p.id !== 'checkout.rate')
        check('after 2 s a waiting panel offers Cancel; it ends that panel\'s wait only, says so, and focus goes to "Run this panel again"', others.every((p) => p.state === 'waiting') && (await text(page, '[data-panel="checkout.rate"] [data-testid=panel-halted]')).startsWith('Cancelled') && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'panel-retry')
        await mockDelay(0)
        await page.click('[data-panel="checkout.rate"] [data-testid=panel-retry]')
        await settled(page, 4)
        check('"Run this panel again" after a cancel answers it', (await panels(page)).every((p) => p.state === 'answered'))
      } finally {
        await mockDelay(0)
      }
      await ctx.close()
    }

    // ------------------------------------------------ the key
    if (want('key')) {
      const ctx = await lib.contextWithKey(browser, DASH)
      const page = await ctx.newPage()
      const w = watch(page)
      const all = []
      page.on('request', (r) => all.push(r.url()))
      await page.goto(`${KEYED}/dashboards`)
      await page.waitForSelector('[data-testid=dashboard-row]')
      await page.fill('[data-testid=dashboards-search]', 'payments')
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=dashboard-row]').length === 1)
      await page.click('[data-testid=open-service_red]')
      await settled(page, 5)
      await page.selectOption('#var-service', 'auth')
      await settled(page, 5)
      await page.click('[data-testid=preset-6h]')
      await settled(page, 5)
      await page.click('[data-panel=rate] [data-testid=panel-text] summary')
      await page.click('[data-panel=rate] [data-testid=open-in-explore]')
      await page.waitForSelector('[data-testid=chart] svg.vz-plot .vz-line', { state: 'attached' })
      await page.goBack()
      await settled(page, 5)
      const secret = DASH.split('_')[2]
      const state = await page.evaluate((key) => {
        const ss = Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]))
        return { ssWithKey: Object.keys(ss).filter((k) => ss[k].includes(key)), ls: JSON.stringify(localStorage), cookie: document.cookie, html: document.documentElement.outerHTML.includes(key), url: location.href, history: history.length }
      }, secret)
      const withKey = w.sent.filter((r) => r.auth === `Bearer ${DASH}`)
      const apiSent = w.sent.filter((r) => new URL(r.url).pathname.startsWith('/api/'))
      check('[key] on the dashboards views every API request carries the key as an Authorization header, to this origin\'s API only', apiSent.length > 20 && withKey.length === apiSent.length && apiSent.every((r) => r.url.startsWith(`${KEYED}/api/`)) && apiSent.some((r) => r.url.includes('/api/v1/control/dashboards/service_red')), `${withKey.length} of ${apiSent.length} API requests`)
      check('[key] the key is in no address (of the page or of any request) and in no request body', all.every((u) => !u.includes(secret) && !u.includes('viz_e2eDashKey')) && w.sent.every((r) => !r.body.includes(secret)) && !state.url.includes(secret), `${all.length} requests`)
      check('[key] the key is kept where it was before this change and nowhere else: sessionStorage\'s viz.key only; not localStorage, a cookie or the page', state.ssWithKey.join(',') === 'viz.key' && !state.ls.includes(secret) && state.cookie === '' && state.html === false, JSON.stringify({ ss: state.ssWithKey, ls: state.ls.length, cookie: state.cookie }))
      await ctx.close()
    }

    // ------------------------------------------------ narrow, touch, dark
    if (want('narrow')) {
      const { ctx, page } = await newPage(phone)
      await page.goto(`${APP}/dashboards`)
      await page.waitForSelector('[data-testid=dashboard-row]')
      const list = await page.evaluate(() => {
        const row = document.querySelector('[data-testid=dashboard-row]')
        const key = row.querySelector('td[data-key] a').getBoundingClientRect()
        return { coarse: matchMedia('(pointer: coarse)').matches, rowH: row.getBoundingClientRect().height, keyW: key.width, changed: getComputedStyle(row.querySelector('td[data-priority]')).display, intentLabel: getComputedStyle(row.querySelector('td[data-label=Intent]'), '::before').content }
      })
      const lo = await overflow(page)
      const lh = await hitAreas(page)
      check('at 400 px the list folds: the name and when it changed stay as columns, the rest becomes lines under the name, each with its label; nothing scrolls sideways', list.coarse && lo.sw <= lo.iw && list.rowH >= 44 && /Intent/.test(list.intentLabel), JSON.stringify({ ...list, ...lo }))
      check('at 400 px with a finger every control of the list has a 44 px area that nothing covers', lh.coarse && lh.small.length === 0 && lh.covered.length === 0 && lh.count >= 6, JSON.stringify(lh))
      await page.tap('[data-testid=open-pod_capacity]')
      await page.waitForSelector('[data-testid=dashboard-page]')
      check('a tap on a dashboard\'s name opens it', new URL(page.url()).searchParams.get('id') === 'pod_capacity')
      for (const id of ['services_overview', 'pod_capacity', 'service_red']) {
        await page.goto(dash(id))
        await settled(page, id === 'services_overview' ? 12 : 5)
        const o = await overflow(page)
        const ps = await panels(page)
        // The whole page in the viewport, so that every control is measured where it is, none cut by the viewport's edge.
        await page.setViewportSize({ width: 400, height: await page.evaluate(() => document.documentElement.scrollHeight) })
        await sleep(300)
        const h = await hitAreas(page)
        const small = h.small
        const covered = h.covered
        const measured = h.count
        await page.setViewportSize({ width: 400, height: 800 })
        check(`at 400 px ${id} is one column and never scrolls sideways`, o.sw <= o.iw && ps.every((p) => p.width === ps[0].width) && new Set(ps.map((p) => p.top)).size === ps.length, JSON.stringify(o))
        check(`at 400 px with a finger every control of ${id} has a 44 px area that nothing covers`, small.length === 0 && covered.length === 0 && measured > 10, `${measured} measured; small: ${[...new Set(small)].slice(0, 6).join(' | ')}; covered: ${[...new Set(covered)].slice(0, 6).join(' | ')}`)
      }
      await ctx.close()

      const dark = await newPage({ colorScheme: 'dark' })
      await dark.page.goto(dash('pod_capacity'))
      await settled(dark.page, 6)
      const colours = await dark.page.evaluate(() => ({ ground: getComputedStyle(document.documentElement).backgroundColor, ink: getComputedStyle(document.querySelector('[data-testid=dashboard-title]')).color }))
      check('the second theme: the dashboard is drawn on the dark ground in the dark ink', colours.ground === tokenRgb('ground', 'dark') && colours.ink === tokenRgb('ink', 'dark'), JSON.stringify(colours))
      const allowed = lib.allowedColours('dark')
      const stray = await dark.page.evaluate((allowed) => {
        const out = new Set()
        for (const el of document.querySelectorAll('main *')) {
          if (el.closest('svg')) continue
          const s = getComputedStyle(el)
          for (const c of [s.color, s.backgroundColor, s.borderTopColor]) if (!allowed.includes(c) && !/^color\(/.test(c)) out.add(`${el.className || el.tagName}: ${c}`)
        }
        return [...out].slice(0, 6)
      }, allowed)
      check('every colour on the dashboard is a token\'s (dark theme)', stray.length === 0, stray.join(' | '))
      await axe(dark.page, 'dashboard, dark', check)
      await dark.page.goto(`${APP}/dashboards`)
      await dark.page.waitForSelector('[data-testid=dashboard-row]')
      await axe(dark.page, 'dashboards list, dark', check)
      await dark.ctx.close()
    }
  } finally {
    await browser.close()
    for (const stop of stops.reverse()) stop()
  }
  console.log(`\n${results.length - failed()} of ${results.length} checks pass`)
  process.exit(failed() ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
