/* eslint-disable */
// What a person sees when the API refuses, is busy or stops a query: the error states, against
// the mock, which fails on request exactly as the real API fails (mock/server.ts, /__mock/fail;
// e2e/contract.cjs checks those answers against the real stack where it can produce them).
//
//   node e2e/errors.cjs        needs `npm run build`; starts the mock and vite preview itself
//
// Checks:
//   busy, no Retry-After      a 503 page from the platform (no envelope): the line says the API is
//                             busy and when it asks again (1, 2, 4 s); the previous result stays;
//                             after four tries, the error state says how many tries over how long,
//                             that the answer was not the API's, and never "change the query"
//   busy, Retry-After: 1      the real API's "the query service is busy": asked again after 1 s each time
//   busy, then an answer      a 503 with Retry-After: 1, then success: the result, no error
//   429 with Retry-After: 10  "limiting requests … Asking again in 10 s", and Cancel works
//   502 from the gateway      retried like a 503
//   503 timeout               not retried; the advice names the time limit
//   401, 403                  the advice names the key; the button opens Settings
//   a warning                 the banner says the result may be incomplete
const lib = require('./lib.cjs')
const { chromium, APP, MOCK, Q_RATE, Q_CPU, url, startServers, setMockFailure } = lib

const { check, results, failed } = lib.makeChecker()

async function ready(page) {
  await page.waitForSelector('[data-testid=legend] tbody tr')
  await page.waitForSelector('[data-testid=chart] canvas')
  await page.waitForSelector('.cm-content')
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '')
const queryRanges = (requests) => requests.filter((r) => r.url().includes('/api/v1/query_range')).length
/** Until the run button is no longer busy: the wait (and its retries) is over. */
async function settled(page, timeout = 15000) {
  await page.waitForFunction(() => document.querySelector('[data-testid=run]')?.getAttribute('aria-busy') === 'true', null, { timeout: 2000 }).catch(() => {})
  await page.waitForFunction(() => document.querySelector('[data-testid=run]')?.getAttribute('aria-busy') === 'false', null, { timeout })
}

async function main() {
  const stop = await startServers()
  const browser = await chromium.launch()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
    const page = await ctx.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    const requests = []
    page.on('request', (r) => requests.push(r))

    // ---- busy with no Retry-After (the platform's 503 page), four times: retried at 1, 2 and 4 s, then the error state.
    await page.goto(url(Q_RATE)); await ready(page)
    await setMockFailure('platform', 4)
    let n0 = queryRanges(requests)
    let t0 = Date.now()
    await page.click('[data-testid=run]')
    await page.waitForSelector('[data-testid=progress-text]')
    await page.waitForFunction(() => /Asking again in/.test(document.querySelector('[data-testid=progress-text]')?.textContent || ''))
    const line = await text(page, '[data-testid=progress-text]')
    const kept = (await page.$$('[data-testid=legend] tbody tr')).length
    check('busy (503, no Retry-After): the line says the API is busy and when it asks again, over the previous result', /^The API is busy \(HTTP 503\)\. Asking again in [12] s\.$/.test(line) && kept === 4, `${line}; ${kept} legend rows kept`)
    await page.waitForSelector('[data-testid=error-state]', { timeout: 20000 })
    const took = Date.now() - t0
    const advice = await text(page, '[data-testid=error-advice]')
    const tries = queryRanges(requests) - n0
    check('busy four times: four tries in about 7 s (1 + 2 + 4), then the error state says so, and that the answer was not the API\'s', tries === 4 && took > 6500 && took < 12000 && /^The answer was HTTP 503 with no API error in it\. The API stayed busy: the query was sent 4 times over [78] s/.test(advice) && !/Change the query/.test(advice), `${tries} tries in ${took} ms; "${advice}"`)
    check('busy: the error state offers to run the query again', /Run the query again/.test(await text(page, '[data-testid=error-fix]')))

    // ---- the real API's own busy refusal carries Retry-After: 1: every retry goes after 1 s.
    await setMockFailure('busy', 4)
    n0 = queryRanges(requests)
    t0 = Date.now()
    await page.click('[data-testid=error-fix]')
    await page.waitForFunction(() => /Asking again in/.test(document.querySelector('[data-testid=progress-text]')?.textContent || ''))
    const busyLine1 = await text(page, '[data-testid=progress-text]')
    await page.waitForSelector('[data-testid=error-state]', { timeout: 20000 })
    const took1 = Date.now() - t0
    check('busy with Retry-After: 1 (the real API\'s): asked again after 1 s each time, four tries in about 3 s', /^The API is busy \(HTTP 503\)\. Asking again in 1 s\.$/.test(busyLine1) && queryRanges(requests) - n0 === 4 && took1 > 2500 && took1 < 7000, `${busyLine1}; ${queryRanges(requests) - n0} tries in ${took1} ms`)

    // ---- busy once with Retry-After: 1, then an answer: the result, and no error.
    await setMockFailure('storage', 1)
    n0 = queryRanges(requests)
    await page.click('[data-testid=error-fix]')
    await settled(page)
    await page.waitForSelector('[data-testid=legend] tbody tr', { timeout: 10000 })
    check('busy once (503, Retry-After: 1), then an answer: the result is shown and no error', queryRanges(requests) - n0 === 2 && !(await page.$('[data-testid=error-state]')), `${queryRanges(requests) - n0} tries`)

    // ---- 429 with Retry-After: 10: the line says so; Cancel stops the wait and keeps the result.
    await setMockFailure('ratelimit', 1)
    await page.click('[data-testid=run]')
    await page.waitForFunction(() => /limiting requests/.test(document.querySelector('[data-testid=progress-text]')?.textContent || ''))
    const limited = await text(page, '[data-testid=progress-text]')
    check('429 (not the viz API: a rate limit in front of it): "limiting requests", asking again after Retry-After', /^The API is limiting requests \(HTTP 429\)\. Asking again in (10|9) s\.$/.test(limited), limited)
    await page.waitForSelector('[data-testid=cancel]', { timeout: 5000 })
    await page.click('[data-testid=cancel]')
    await page.waitForSelector('[data-testid=halted]')
    check('Cancel during a retry stops it; the previous result stays', /Cancelled\. The previous result is shown\./.test(await text(page, '[data-testid=halted]')) && (await page.$$('[data-testid=legend] tbody tr')).length === 4)
    await setMockFailure('busy', 0)
    await settled(page)

    // ---- 502 from the gateway: retried like a 503.
    await setMockFailure('gateway', 1)
    n0 = queryRanges(requests)
    await page.click('[data-testid=run]')
    await page.waitForFunction(() => /HTTP 502/.test(document.querySelector('[data-testid=progress-text]')?.textContent || ''))
    await settled(page)
    check('502 from the gateway (Retry-After: 1): retried, then the answer', queryRanges(requests) - n0 === 2 && !(await page.$('[data-testid=error-state]')))

    // ---- 503 timeout: the API's time limit. Not retried; the advice says what to change.
    await setMockFailure('timeout', 1)
    n0 = queryRanges(requests)
    await page.click('[data-testid=run]')
    await page.waitForSelector('[data-testid=error-state]')
    const tAdvice = await text(page, '[data-testid=error-advice]')
    check('503 timeout: not retried, and the advice names the time limit and what to narrow', queryRanges(requests) - n0 === 1 && /timeout with HTTP 503\. The API stopped the query at its time limit\. Narrow the time range or select fewer series/.test(tAdvice), tAdvice)
    await page.click('[data-testid=error-fix]')
    await ready(page)

    // ---- a warning: the banner says the result may be incomplete, then the API's words.
    await page.route('**/api/v1/query_range', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      body.warnings = ['partial response: store 3 of 4 did not answer']
      await route.fulfill({ response: res, body: JSON.stringify(body) })
    })
    await page.click('[data-testid=run]')
    await page.waitForSelector('[data-testid=warnings]')
    const warn = await text(page, '[data-testid=warnings]')
    check('a warning: the banner says the result may be incomplete, then gives the API\'s words', /^The API sent a warning with this result, so it may be incomplete: partial response: store 3 of 4 did not answer$/.test(warn), warn)
    await page.unroute('**/api/v1/query_range')
    await ctx.close()

    // ---- 401 and 403, from a mock that requires a key, as the real API does.
    stop()
    for (let i = 0; i < 50 && ((await lib.ping(APP)) || (await lib.ping(`${MOCK}/__mock/delay`))); i++) await new Promise((r) => setTimeout(r, 100))
    const stopMock = await lib.startMock(Number(new URL(MOCK).port), ['--require-token', 'e2e-read', '--readless-token', 'e2e-write'])
    const stopApp = await lib.startPreview(Number(new URL(APP).port), MOCK)
    try {
      for (const [label, key, kind, re] of [
        ['401 (no key)', '', 'auth', /unauthorized with HTTP 401\. No API key is set\. Enter a key with the read scope in Settings\./],
        ['401 (a key the API does not know)', 'e2e-unknown', 'auth', /unauthorized with HTTP 401\. The API did not accept the API key\. Enter a valid key in Settings\./],
        ['403 (a key without the read scope)', 'e2e-write', 'scope', /forbidden with HTTP 403\. The API key in Settings cannot read metrics\. Use a key with the read scope\./],
      ]) {
        const c = await lib.contextWithKey(browser, key)
        const p = await c.newPage()
        await p.goto(url(Q_CPU))
        await p.waitForSelector('[data-testid=error-state]')
        const a = await text(p, '[data-testid=error-advice]')
        const k = await p.getAttribute('[data-testid=error-state]', 'data-kind')
        await p.click('[data-testid=error-fix]')
        const settingsOpen = await p.waitForSelector('dialog[open] #set-token', { timeout: 3000 }).then(() => true, () => false)
        check(`${label}: the advice names the key, and the button opens Settings`, k === kind && re.test(a) && settingsOpen, a)
        if (key === '') {
          await p.fill('#set-token', 'e2e-read')
          await p.click('dialog[open] button[type=submit]')
          await p.waitForSelector('[data-testid=legend] tbody tr', { timeout: 10000 })
          check('401: with a key entered in Settings the same query runs', true)
        }
        await c.close()
      }
    } finally {
      stopApp()
      stopMock()
    }
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    await browser.close()
    stop()
  }
  console.log(`\n${results.length - failed()}/${results.length} checks passed`)
  process.exit(failed() ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
