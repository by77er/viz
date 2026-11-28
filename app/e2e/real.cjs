/* eslint-disable */
// The app on the real viz API, locally (real/stack.mjs: gateway, edge, query and control under
// `wrangler dev --local`; nothing is deployed and no Cloudflare account is used). Needs
// `npm run build`. Starts and seeds the stack if it is not up, serves the built app with /api
// on it, and serves the same build on the mock, to read the same data both ways.
//
//   node e2e/real.cjs
//
// What it checks that the mock cannot: sign-in against control's own `whoami` with keys
// control made (a read key, a write-only key, a key it never made), and that the same data,
// which the seed writes sample for sample, is read the same from the real API as from the mock.
const lib = require('./lib.cjs')
const { chromium, T0, T1, Q_RATE, Q_CPU, Q_MANY, Q_BAD, makeChecker } = lib
const { check, failed, results } = makeChecker()
const PORT = Number(process.env.VIZ_REAL_APP_PORT || 18960)

const ready = async (page) => {
  await page.waitForSelector('[data-testid=chart] svg.vz-plot .vz-line', { state: 'attached', timeout: 60000 })
  await page.waitForSelector('[data-testid=chart] tbody tr[data-key]', { state: 'attached' })
}
const reading = (page) => page.evaluate(() => ({
  legend: [...document.querySelectorAll('[data-testid=chart] tbody tr[data-key]')].map((tr) => [...tr.cells].map((c) => c.textContent.trim()).join(' | ')),
  unit: document.querySelector('svg.vz-plot .vz-axis-unit').textContent,
  ticks: [...document.querySelectorAll('svg.vz-plot text')].map((t) => t.textContent).join(' '),
  note: document.querySelector('.vz-legend-note').textContent,
  text: [...document.querySelectorAll('#explore-text li')].map((li) => li.textContent),
}))

async function main() {
  const stopStack = await lib.ensureRealStack()
  const keys = lib.realKeys()
  const real = `http://127.0.0.1:${PORT}`
  const mock = `http://127.0.0.1:${PORT + 1}`
  const stopMock = await lib.startMock(PORT + 2)
  const stopReal = await lib.startPreview(PORT, lib.REAL)
  const stopOnMock = await lib.startPreview(PORT + 1, `http://127.0.0.1:${PORT + 2}`)
  const browser = await chromium.launch()
  const at = (origin, q, extra = '') => `${origin}/explore?q=${encodeURIComponent(q)}&from=${T0}&to=${T1}${extra}`
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const sent = []
    page.on('request', (r) => sent.push(r.url()))

    // ---- sign-in against control
    await page.goto(at(real, Q_RATE))
    await page.waitForSelector('[data-testid=sign-in]')
    check('real API: without a key the page is the sign-in form (control answers 401 to whoami)', (await page.textContent('[data-testid=sign-in] h1')) === 'No API key in this tab')
    await page.fill('[data-testid=sign-in-key]', 'viz_0000000000000000_0000000000000000000000000000000000000000')
    await page.click('[data-testid=sign-in-submit]')
    await page.waitForSelector('[data-testid=sign-in-error]')
    check('real API: a key control never made is refused at the field (HTTP 401)', (await page.textContent('[data-testid=sign-in-error]')).includes('did not accept this key (HTTP 401)'))
    await page.fill('[data-testid=sign-in-key]', keys.write)
    await page.click('[data-testid=sign-in-submit]')
    await page.waitForFunction(() => document.querySelector('[data-testid=sign-in-error]')?.textContent.includes('cannot read metrics'))
    const writeOnly = await page.textContent('[data-testid=sign-in-error]')
    check('real API: a write-only key is valid, named by its tenant and scope, and refused for Explore; it is not stored', writeOnly.includes('valid for viz-app-e2e') && writeOnly.includes('the write scope') && (await page.evaluate(() => sessionStorage.getItem('viz.key'))) === null, writeOnly)
    await page.fill('[data-testid=sign-in-key]', keys.read)
    await page.click('[data-testid=sign-in-submit]')
    await ready(page)
    check('real API: the read key signs in and the query that was asked for runs', (await page.textContent('[data-testid=tenant]')) === 'viz-app-e2e' && (await page.locator('[data-testid=mock-banner]').count()) === 0)
    await page.goto(`${real}/settings`)
    await page.waitForSelector('[data-testid=sign-out]')
    const who = (await page.textContent('[data-testid=settings-key] dl')).replace(/\s+/g, ' ')
    check('real API: Settings shows control\'s answer: tenant, key name with its public part, scopes; never the secret', who.includes('Tenantviz-app-e2e') && /Keyapp-read \(viz_[A-Za-z0-9]+_…\)/.test(who) && who.includes('Scopesread') && !who.includes(keys.read.split('_')[2]), who.replace(/viz_\w+/g, 'viz_…'))
    check('real API: Settings shows the API\'s version', /viz/.test(await page.textContent('[data-testid=api-version]')))
    check('real API: the key was in no address', !sent.some((u) => u.includes(keys.read.split('_')[2]) || u.includes(keys.write.split('_')[2])))

    // ---- the same data, read from the real API and from the mock
    const other = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const mp = await other.newPage()
    for (const [name, q] of [['4 series', Q_RATE], ['a gap', Q_CPU], ['36 series', Q_MANY]]) {
      await page.goto(at(real, q))
      await ready(page)
      await mp.goto(at(mock, q))
      await ready(mp)
      const a = await reading(page)
      const b = await reading(mp)
      check(`real API and mock, ${name}: the same legend (names, colours' order, figures), unit, axis, note and text form`, JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a.legend.slice(0, 2)) + ' / ' + JSON.stringify(b.legend.slice(0, 2)))
    }
    await other.close()

    // ---- refusals of the real API, as a person meets them
    await page.goto(at(real, Q_BAD))
    await page.waitForSelector('[data-testid=error-state]')
    const parse = { message: await page.textContent('[data-testid=error-message]'), advice: await page.textContent('[data-testid=error-advice]'), fix: await page.textContent('[data-testid=error-fix]') }
    check('real API: a parse error is the API\'s message, who answered, and a button to the character (from the editor\'s parser: the API gives no position)', /parse error/.test(parse.message) && parse.advice.startsWith('The API answered bad_data with HTTP 400.') && /^Go to character \d+$/.test(parse.fix), JSON.stringify(parse))
    await page.goto(at(real, Q_RATE, '&step=500ms'))
    await page.waitForSelector('[data-testid=error-state]')
    const step = { message: await page.textContent('[data-testid=error-message]'), fix: await page.textContent('[data-testid=error-fix]') }
    await page.click('[data-testid=error-fix]')
    await ready(page)
    check('real API: a step too small for the range is refused with advice about the step, and "Use the automatic step" runs the query', /maximum resolution/.test(step.message) && step.fix === 'Use the automatic step' && new URL(page.url()).searchParams.get('step') === null, JSON.stringify(step))
    await page.goto(at(real, 'no_such_metric_total'))
    await page.waitForSelector('[data-testid=empty-state]')
    check('real API: a query that matches nothing is the empty state', true)
    await page.goto(at(real, 'limitk(1, up)'))
    await page.waitForSelector('[data-testid=error-state]')
    check('real API: PromQL viz does not run is said as such', (await page.textContent('[data-testid=error-advice]')).includes('viz does not run this part of PromQL yet'), await page.textContent('[data-testid=error-advice]'))
    // ---- dashboards: control's list and specs, and every panel's queries on the real query API
    await page.goto(`${real}/dashboards`)
    await page.waitForSelector('[data-testid=no-permission]')
    const refusedText = (await page.textContent('[data-testid=no-permission]')).replace(/\s+/g, ' ')
    check('real API: the key that reads metrics only is told, in control\'s words, that it cannot read dashboards', refusedText.includes('This needs one of the scopes: admin, dashboards:read, dashboards:write, dashboards:apply.') && refusedText.includes('has read.'), refusedText)
    const dashCtx = await lib.contextWithKey(browser, keys.dash)
    const onReal = await dashCtx.newPage()
    onReal.on('pageerror', (e) => errors.push(e.message))
    const mockCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const onMock = await mockCtx.newPage()
    const list = (p) => p.evaluate(() => [...document.querySelectorAll('[data-testid=dashboard-row]')].map((tr) => [...tr.querySelectorAll('td')].slice(0, 4).map((td) => td.textContent.replace(/\s+/g, ' ').trim()).join(' | ')))
    await onReal.goto(`${real}/dashboards`)
    await onReal.waitForSelector('[data-testid=dashboard-row]')
    await onMock.goto(`${mock}/dashboards`)
    await onMock.waitForSelector('[data-testid=dashboard-row]')
    const lists = [await list(onReal), await list(onMock)]
    check('real API: the dashboards list from control is the mock\'s list: the same four names, intents, tags and owners', lists[0].length === 4 && JSON.stringify(lists[0]) === JSON.stringify(lists[1]), lists[0].map((r) => r.split(' | ')[0]).join(', '))
    const changed = await onReal.evaluate(() => document.querySelector('[data-testid=dashboard-row] td[data-priority]').textContent.replace(/\s+/g, ' ').trim())
    check('real API: who changed a dashboard last is the key that created it, by name', /by /.test(changed) && !/undefined|null/.test(changed), changed)
    // What a person reads off a dashboard: each panel's state, figures, table, legend and text. Ages and the mock's banner are not part of it.
    const board = async (p, origin, id, n) => {
      await p.goto(`${origin}/dashboards?id=${id}&from=${T0}&to=${T1}`)
      await p.waitForFunction((n) => document.querySelectorAll('[data-testid=panel]').length >= n && !document.querySelector('[data-testid=panel][data-state=waiting], [data-testid=panel][data-state=idle], [data-testid=panel-deferred]'), n, { timeout: 60000 })
      return p.evaluate(() => [...document.querySelectorAll('[data-testid=panel]')].map((el) => ({
        id: el.dataset.panel,
        kind: el.dataset.kind,
        state: el.dataset.state,
        stats: [...el.querySelectorAll('[data-testid=stat-value], [data-testid=stat-context]')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
        table: [...el.querySelectorAll('[data-testid=panel-table] tr')].map((tr) => [...tr.cells].map((c) => c.textContent.trim()).join(' | ')),
        legend: [...el.querySelectorAll('tbody tr[data-key]')].map((tr) => [...tr.cells].map((c) => c.textContent.trim()).join(' | ')),
        digest: el.querySelector('[data-testid=panel-not-drawn]')?.textContent ?? '',
        empty: !!el.querySelector('[data-testid=panel-empty]'),
        error: el.querySelector('[data-testid=panel-error]')?.textContent.replace(/\s+/g, ' ') ?? '',
      })))
    }
    for (const [id, n] of [['services_overview', 12], ['service_red', 5], ['checkout_path', 4], ['pod_capacity', 6]]) {
      const [r, m] = [await board(onReal, real, id, n), await board(onMock, mock, id, n)]
      const same = (x) => JSON.stringify(x.map((p) => ({ ...p, error: p.error ? 'an error' : '' })))
      const differing = r.filter((p, i) => same([p]) !== same([m[i]])).map((p) => p.id)
      check(`real API: ${id} reads the same on the real API as on the mock, panel by panel (state, figures, table, legend, text)`, r.length === n && differing.length === 0, differing.length ? `differs in ${differing.join(', ')}: real ${JSON.stringify(r.find((p) => p.id === differing[0])).slice(0, 300)} / mock ${JSON.stringify(m.find((p) => p.id === differing[0])).slice(0, 300)}` : r.map((p) => `${p.id}:${p.state}`).join(' '))
      if (id === 'pod_capacity') {
        const failedPanel = r.find((p) => p.id === 'sample')
        check('real API: the query viz does not run fails its panel only, with the API\'s own answer; the query that matches nothing is an empty state', failedPanel.state === 'failed' && failedPanel.error.includes('The API answered unsupported with HTTP 422.') && r.filter((p) => p.state === 'answered').length === 5 && r.find((p) => p.id === 'restarts').empty, failedPanel.error)
      }
    }
    await onReal.goto(`${real}/dashboards?id=service_red&from=${T0}&to=${T1}`)
    await onReal.waitForFunction(() => document.querySelectorAll('#var-service option').length >= 5, null, { timeout: 30000 })
    check('real API: a query variable\'s values come from the real label-values endpoint', (await onReal.evaluate(() => [...document.querySelectorAll('#var-service option')].map((o) => o.textContent).join(','))) === 'All,auth,catalog,checkout,orders')
    check('real API: the dashboards key was sent only as a header, to this origin', !sent.some((u) => u.includes(keys.dash.split('_')[2])))
    await dashCtx.close()
    await mockCtx.close()
    check('real API: no uncaught error', errors.length === 0, errors.join(' | '))
    await ctx.close()
  } finally {
    await browser.close()
    stopOnMock()
    stopReal()
    stopMock()
    stopStack()
  }
  console.log(`\n${results.length - failed()} of ${results.length} checks pass`)
  process.exit(failed() ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
