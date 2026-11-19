/* eslint-disable */
// The app against the REAL viz API (real/stack.mjs: wrangler dev --local of the gateway, the
// write path, the query Worker and the control plane), holding the mock's own data (real/seed.ts).
//
//   node e2e/real.cjs     needs `npm run build`; starts the real stack if it is not running (and
//                         stops it after), the mock, and two `vite preview`s: one on each backend
//
// Ports: VIZ_REAL_PORT (8851), VIZ_E2E_APP_PORT (8872, the app on the real API), +1 (the app on
// the mock), +2 (the mock).
//
// What it checks, through the UI only:
//   - the flows that make sense on real data: run, legend, chart, table, text, JSON, 36 and
//     200 series, autocomplete (bounded by the window), Settings and the key
//   - the same data gives the same picture: the legend, the table and the text digest are
//     identical, character for character, on the real API and on the mock
//   - the real API's refusals, as a person meets them: a parse error (and where it is), an
//     unknown function, PromQL viz does not run (422), too many points (400), a query over
//     16 KiB (422), no key (401), a key without the read scope (403), an unreadable limits
//     record (503 with Retry-After: 30), and the API's time limit (503 timeout)
const lib = require('./lib.cjs')
const { chromium, T0, T1, Q_RATE, Q_CPU, Q_P95, Q_MANY, Q_BAD } = lib

const APP_PORT = Number(process.env.VIZ_E2E_APP_PORT || 8872)
const APP_REAL = `http://127.0.0.1:${APP_PORT}`
const APP_MOCK = `http://127.0.0.1:${APP_PORT + 1}`
const MOCK_PORT = APP_PORT + 2
const Q_SYNTH = 'viz_synthetic_series'
const at = (base, q, extra = '') => `${base}/explore?q=${encodeURIComponent(q)}&from=${T0}&to=${T1}${extra}`
const { check, results, failed } = lib.makeChecker()

async function ready(page) {
  await page.waitForSelector('[data-testid=legend] tbody tr', { timeout: 30000 })
  await page.waitForSelector('[data-testid=chart] canvas')
  await page.waitForSelector('.cm-content')
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '')
const errorState = async (page) => {
  await page.waitForSelector('[data-testid=error-state]', { timeout: 30000 })
  return { message: await text(page, '[data-testid=error-message]'), advice: await text(page, '[data-testid=error-advice]'), fix: await text(page, '[data-testid=error-fix]'), kind: await page.getAttribute('[data-testid=error-state]', 'data-kind') }
}

/** What a person reads of a result: the legend (with Other opened), the table (all rows), the text digest. */
async function reading(page, url) {
  await page.goto(url)
  await ready(page)
  const out = {}
  if (await page.$('[data-testid=legend-other]')) await page.click('[data-testid=legend-other]')
  for (let i = 0; i < 10 && (await page.$('[data-testid=legend-more]')); i++) await page.click('[data-testid=legend-more]')
  out.status = await text(page, '[data-testid=status]')
  out.legend = await page.$eval('[data-testid=legend] table', (t) => t.innerText)
  await page.click('[data-testid=view-table]')
  await page.waitForSelector('[data-testid=result-table] tbody tr')
  for (let i = 0; i < 10 && (await page.$('[data-testid=table-more]')); i++) await page.click('[data-testid=table-more]')
  out.table = await page.$eval('[data-testid=result-table]', (t) => t.innerText)
  await page.click('[data-testid=view-text]')
  await page.waitForSelector('[data-testid=text-view] pre')
  out.text = await page.$eval('[data-testid=text-view] pre', (t) => t.textContent)
  await page.click('[data-testid=view-chart]')
  return out
}

async function main() {
  const stops = []
  const stopReal = await lib.ensureRealStack()
  stops.push(stopReal)
  const keys = lib.realKeys()
  stops.push(await lib.startMock(MOCK_PORT))
  stops.push(await lib.startPreview(APP_PORT, lib.REAL))
  stops.push(await lib.startPreview(APP_PORT + 1, `http://127.0.0.1:${MOCK_PORT}`))
  const browser = await chromium.launch()
  try {
    const ctx = await lib.contextWithKey(browser, keys.read)
    const page = await ctx.newPage()
    const pageErrors = []
    // With the script that threw (the chunk names say whose code it was).
    page.on('pageerror', (e) => pageErrors.push(`${e.message} [${[...new Set((e.stack || '').match(/assets\/[\w-]+\.js/g) || [])].join(', ')}]`))
    const lookups = []
    page.on('request', (r) => { if (/\/api\/v1\/(labels|label\/|series)/.test(r.url())) lookups.push(r.url()) })

    // ---- the main flow
    await page.goto(at(APP_REAL, Q_RATE))
    await ready(page)
    const notices = await text(page, '.app-notices')
    const names = await page.$$eval('[data-testid=legend] tbody button[data-series]', (b) => b.map((x) => x.textContent.trim()))
    check('real API: the result is drawn, with no mock banner and no error banner', notices === '' && JSON.stringify(names) === '["auth","catalog","checkout","orders"]', `notices "${notices}"; ${names.join(' ')}`)
    check('real API: 4 series, one point every 15 s', /^4 series, one point every 15 s\.$/.test(await text(page, '[data-testid=status]')), await text(page, '[data-testid=status]'))

    // Autocomplete, from the real label endpoints, within the page's window.
    await page.click('.cm-content')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.keyboard.type('http_requests_t')
    await page.waitForSelector('.cm-tooltip-autocomplete', { timeout: 15000 })
    let options = await page.$$eval('.cm-tooltip-autocomplete li', (els) => els.map((e) => e.textContent))
    check('real API: autocomplete offers metric names', options.some((o) => o.includes('http_requests_total')), options.slice(0, 4).join(' | '))
    await page.keyboard.press('Enter')
    await page.keyboard.type('{')
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].some((e) => e.textContent.includes('service')), null, { timeout: 15000 })
    await page.keyboard.type('service="')
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].some((e) => e.textContent.includes('checkout')), null, { timeout: 15000 })
    options = await page.$$eval('.cm-tooltip-autocomplete li', (els) => els.map((e) => e.textContent))
    await page.keyboard.press('Escape')
    const unbounded = lookups.filter((u) => !/[?&]start=\d+/.test(u) || !/[?&]end=\d+/.test(u))
    check('real API: label names and values complete, and every lookup carries start and end (all time reads every file)', ['auth', 'catalog', 'checkout', 'orders'].every((l) => options.some((o) => o.startsWith(l))) && lookups.length >= 3 && unbounded.length === 0, `${lookups.length} lookups, ${unbounded.length} without a window`)

    // The other forms.
    await page.goto(at(APP_REAL, Q_RATE)); await ready(page)
    await page.click('[data-testid=view-json]')
    await page.waitForSelector('[data-testid=result-json] pre')
    const json = await text(page, '[data-testid=result-json] pre')
    check('real API: the JSON form shows the real response', json.includes('"resultType": "matrix"') && json.includes('"service":"auth"') && /answered in [\d.,]+ ms/.test(await text(page, '[data-testid=result-json] .vz-panel-desc')))
    await page.click('[data-testid=view-chart]')

    // ---- the same data, the same picture: real and mock read alike, character for character
    const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
    const mpage = await mctx.newPage()
    for (const [label, q] of [['4 series', Q_RATE], ['36 series', Q_MANY], ['a gap', Q_CPU], ['p95 of a histogram', Q_P95], ['200 series', Q_SYNTH]]) {
      const r = await reading(page, at(APP_REAL, q))
      const m = await reading(mpage, at(APP_MOCK, q))
      const diff = Object.keys(r).filter((k) => r[k] !== m[k])
      check(`same data, same reading (${label}): legend, table and text digest identical on the real API and the mock`, diff.length === 0, diff.length ? `differ: ${diff.join(', ')}; real "${r[diff[0]].slice(0, 120)}" / mock "${m[diff[0]].slice(0, 120)}"` : `${r.status}`)
      if (q === Q_MANY) check('real API: 36 series, eight coloured and ONE Other row of 28', /Other, 28 series/.test(r.legend), r.legend.split('\n').find((l) => /Other/.test(l)) || '')
      if (q === Q_SYNTH) check('real API: 200 series, the table shows them 50 at a time', /^200 series/.test(r.status) && (r.table.match(/\n/g) || []).length > 200, r.status)
    }
    await mctx.close()

    // ---- the real API's refusals
    // A parse error: the API gives no position; the editor's parser says where it is.
    await page.goto(at(APP_REAL, Q_BAD))
    await page.waitForSelector('.cm-content')
    let e = await errorState(page)
    check('real API, parse error: the API\'s words, bad_data with HTTP 400, and "Go to character 48" from the editor', e.message === 'parse error: unclosed left parenthesis' && /bad_data with HTTP 400\. Change the query/.test(e.advice) && e.fix === 'Go to character 48', `${e.message} | ${e.fix}`)
    await page.waitForSelector('.cm-content')
    await page.click('[data-testid=error-fix]')
    const caret = await page.evaluate(() => { const s = getSelection(); return document.activeElement?.closest('.cm-editor') ? s.focusOffset : -1 })
    check('real API, parse error: the button puts the cursor in the editor', caret >= 0, `focus offset ${caret}`)
    await page.goto(at(APP_REAL, 'no_such_fn(up)'))
    e = await errorState(page)
    check('real API, unknown function: 400 bad_data, "change the query"', /unknown function with name 'no_such_fn'/.test(e.message) && /HTTP 400\. Change the query/.test(e.advice), e.message)
    await page.goto(at(APP_REAL, 'limitk(1, up)'))
    e = await errorState(page)
    check('real API, PromQL viz does not run: 422 unsupported, and the advice says so', e.kind === 'unsupported' && /unsupported with HTTP 422\. viz does not run this part of PromQL yet/.test(e.advice), `${e.message} | ${e.advice}`)
    await page.goto(at(APP_REAL, Q_RATE, '&step=500ms'))
    e = await errorState(page)
    check('real API, more than 11,000 points: 400, and the button runs the query again', /exceeded maximum resolution of 11000 points/.test(e.message) && e.fix === 'Run the query again', e.message)
    // Typed, not in the address: a 25 KB URL is refused by the server before the app loads (431).
    await page.goto(at(APP_REAL, Q_RATE)); await ready(page)
    await page.click('.cm-content')
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText('up' + ' + up'.repeat(5000))
    await page.click('[data-testid=run]')
    e = await errorState(page)
    check('real API, a query over 16 KiB: 422, a limit, and the advice says so', e.kind === 'limit' && /max_query_bytes/.test(e.message) && /asks for more than the API allows/.test(e.advice), e.advice)

    // No key; a key without the read scope.
    for (const [label, key, kind, re] of [
      ['no key: 401', '', 'auth', /unauthorized with HTTP 401\. The API did not accept the API key/],
      ['a key without the read scope: 403', keys.write, 'scope', /forbidden with HTTP 403\. The API key in Settings cannot read metrics/],
    ]) {
      const c = await lib.contextWithKey(browser, key)
      const p = await c.newPage()
      await p.goto(at(APP_REAL, Q_RATE))
      const s = await errorState(p)
      const banner = await p.waitForSelector('.app-notices [role=alert]', { timeout: 10000 }).then((b) => b.textContent(), () => '')
      await p.click('[data-testid=error-fix]')
      const opened = await p.waitForSelector('dialog[open] #set-token', { timeout: 3000 }).then(() => true, () => false)
      check(`real API, ${label}: the advice names the key, the button opens Settings, and the shell says the credentials were refused`, s.kind === kind && re.test(s.advice) && opened && /rejected the credentials/.test(banner), `${s.message} | ${s.advice}`)
      if (key === '') {
        await p.fill('#set-token', keys.read)
        await p.click('dialog[open] button[type=submit]')
        await ready(p)
        check('real API: a read key entered in Settings, and the same query runs', true)
      }
      await c.close()
    }

    // An unreadable limits record: the real API refuses every query with 503 and Retry-After: 30.
    await page.goto(at(APP_REAL, Q_RATE)); await ready(page)
    lib.realKv(`limits:${keys.tenant}`, '{"maxSamples":-1}')
    try {
      // The query Worker keeps limits for 30 s: run until the refusal arrives.
      let line = ''
      for (let i = 0; i < 12 && !/Asking again/.test(line); i++) {
        await page.waitForTimeout(3000)
        await page.waitForFunction(() => document.querySelector('[data-testid=run]')?.getAttribute('aria-busy') === 'false', null, { timeout: 70000 })
        await page.click('[data-testid=run]')
        line = await page.waitForFunction(() => { const t = document.querySelector('[data-testid=progress-text]')?.textContent || ''; return /Asking again/.test(t) ? t : false }, null, { timeout: 2500 }).then((h) => h.jsonValue(), () => '')
      }
      check('real API, 503 with Retry-After: 30: the line says the API is busy and asks again in 30 s, over the previous result', /^The API is busy \(HTTP 503\)\. Asking again in (30|29) s\.$/.test(line) && (await page.$$('[data-testid=legend] tbody tr')).length === 4, line)
      await page.waitForSelector('[data-testid=cancel]', { timeout: 5000 })
      await page.click('[data-testid=cancel]')
      await page.waitForSelector('[data-testid=halted]')
    } finally {
      lib.realKv(`limits:${keys.tenant}`, null)
    }

    // The API's time limit, set to 1 ms for the tenant: 503 timeout, not retried.
    lib.realKv(`limits:${keys.tenant}`, '{"timeoutMs":1}')
    try {
      let s = null
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(3000)
        await page.goto(at(APP_REAL, Q_RATE, `&step=${15 + i}s`))
        s = await errorState(page).catch(() => null)
        if (s && s.kind === 'timeout') break
      }
      check('real API, its time limit (503 timeout): the advice names the time limit; not retried', !!s && s.kind === 'timeout' && /The API stopped the query at its time limit/.test(s.advice), s ? `${s.message} | ${s.advice}` : 'no error state')
    } finally {
      lib.realKv(`limits:${keys.tenant}`, null)
    }
    // The PromQL linter of @prometheus-io/codemirror-promql recurses once per operator: the
    // 5,000-term query overflows its stack (a page error; the query still runs). Known issue.
    const unexpected = pageErrors.filter((m) => !/Maximum call stack size exceeded/.test(m))
    check('no page errors but the linter\'s on the 5,000-term query', unexpected.length === 0, `${pageErrors.length - unexpected.length} from the linter; ${unexpected.join(' | ')}`)
    await ctx.close()
  } finally {
    await browser.close()
    for (const stop of stops.reverse()) stop()
  }
  console.log(`\n${results.length - failed()}/${results.length} checks passed`)
  process.exit(failed() ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
