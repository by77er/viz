/* eslint-disable */
// End-to-end checks of the monitors views (the on-call slice): the list at /monitors and one
// monitor at /monitors?id=<id>, with acknowledge, unacknowledge, silence and undo, on the mock.
// Needs `npm run build`. Starts the mock and `vite preview` itself (VIZ_E2E_APP_PORT,
// VIZ_E2E_MOCK_PORT), and a second mock that requires a key (mock port + 10: `read` only,
// `monitors:read`, and `monitors:read` + `monitors:ack`) with its own preview (app port + 20).
//
//   node e2e/monitors.cjs
//   VIZ_ONLY=list,states,monitor,ack,menuplace,silence,failure,noack,superseded,key,touch node e2e/monitors.cjs
//
// The safety properties (README, "Monitors": mutants) are marked [key], [scope], [undo],
// [failed], [colour], [superseded], [touch].
const lib = require('./lib.cjs')
const { chromium, APP, MOCK, makeChecker, axe, hitAreas, overflow } = lib
const { check, failed, results } = makeChecker()
const only = (process.env.VIZ_ONLY || '').split(',').filter(Boolean)
const want = (name) => only.length === 0 || only.includes(name)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const KEYED_MOCK_PORT = lib.MOCK_PORT + 10
const KEYED_APP_PORT = lib.APP_PORT + 20
const KEYED = `http://127.0.0.1:${KEYED_APP_PORT}`
const KEYED_MOCK = `http://127.0.0.1:${KEYED_MOCK_PORT}`
const READ = 'viz_e2eReadKey0000000_readOnlySecret'
const MONREAD = 'viz_e2eMonRead0000000_monReadSecret'
const ONCALL = 'viz_e2eOncallKey00000_oncallSecretX'

const hook = (q, base = MOCK) => fetch(`${base}/__mock/monitors?${q}`).then((r) => r.json())
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, sel)
const ids = async (base = MOCK) => {
  const r = await fetch(`${base}/api/v1/monitors?filter=all`, base === MOCK ? {} : { headers: { authorization: `Bearer ${ONCALL}` } }).then((r) => r.json())
  return Object.fromEntries(r.monitors.map((m) => [m.name, m]))
}
/** Every API request of a page: what was sent, with which header. */
function watch(page) {
  const w = { sent: [], answers: [] }
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) w.sent.push({ url: r.url(), method: r.method(), body: r.postData() || '', auth: r.headers().authorization || '', at: Date.now() }) })
  page.on('response', async (r) => { if (/\/api\/v1\/monitors/.test(r.url())) { let body = null; try { body = await r.json() } catch {} w.answers.push({ url: r.url(), method: r.request().method(), status: r.status(), body }) } })
  return w
}
const writes = (w) => w.sent.filter((r) => r.method === 'POST' && /\/api\/v1\/monitors/.test(r.url))
const settled = (page) => page.waitForFunction(() => document.querySelector('[data-testid=monitor-chart]')?.dataset.state && !['waiting', 'idle'].includes(document.querySelector('[data-testid=monitor-chart]').dataset.state) && document.querySelector('[data-testid=history-line]'), null, { timeout: 30000 }).catch(async (e) => { console.log('settled timed out on', page.url(), (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 600)); throw e })
/** The parts of a monitor's page that describe it (not the actions): what a failed write must leave as it was. */
const facts = (page) => page.evaluate(() => ({
  mark: document.querySelector('[data-testid=monitor-mark]')?.dataset.state ?? '',
  state: document.querySelector('[data-testid=monitor-state]')?.textContent.replace(/\s+/g, ' ').replace(/ \(.*\)$/, '').trim(), // without its duration, which the clock moves
  alerts: [...document.querySelectorAll('[data-testid=alert-row]')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
  history: [...document.querySelectorAll('[data-testid=history-line]')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
  done: !!document.querySelector('[data-testid=ack-done], [data-testid=silence-done]'),
  ack: !!document.querySelector('[data-testid=acknowledge]'),
}))

async function main() {
  const stops = [await lib.startServers()]
  stops.push(await lib.startMock(KEYED_MOCK_PORT, ['--require-token', READ, '--monitors-token', MONREAD, '--oncall-token', ONCALL]))
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
  const M = await ids()
  const FIRING = M['Checkout 5xx ratio']
  const SILENCED = M['Catalog p99 latency']

  try {
    // ------------------------------------------------ the list
    if (want('list')) {
      await hook('reset=1')
      const { ctx, page, errors } = await newPage()
      const w = watch(page)
      await page.goto(`${APP}/explore`)
      await page.waitForSelector('nav.vz-nav')
      const nav = await page.evaluate(() => [...document.querySelectorAll('nav.vz-nav a')].map((a) => a.textContent))
      check('the navigation has Monitors, after Dashboards', nav.join(',') === 'Explore,Dashboards,Monitors,Help,Settings', nav.join(','))
      await page.keyboard.press('Control+k')
      await page.waitForSelector('dialog.palette[open]')
      await page.keyboard.type('go to monitors')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=monitor-row]')
      check('the command palette\'s "Go to Monitors" opens the list at /monitors', new URL(page.url()).pathname === '/monitors', page.url())
      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid=monitor-row]')].map((tr) => ({ state: tr.dataset.state, cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()), mark: tr.querySelector('.vz-status')?.dataset.state ?? '' })))
      check('the list opens on "Needs attention" (the API\'s filter=attention): firing first, the one someone has after the one nobody has, then no data, cannot be evaluated, pending', rows.map((r) => r.state).join(',') === 'firing,firing,no_data,error,pending' && rows[0].cells[0] === 'Checkout 5xx ratio' && rows[1].cells[0] === 'Catalog p99 latency' && w.sent.some((r) => /\/api\/v1\/monitors\?filter=attention$/.test(r.url)), JSON.stringify(rows.map((r) => [r.cells[0], r.state])))
      check('each row has its state with "firing since", its value, its threshold as written, its owner and who it notifies', /^Firing since \d\d:\d\d$/.test(rows[0].cells[1]) && rows[0].cells[3] === '> 2% for 5 min' && /^\d+(\.\d)?%$/.test(rows[0].cells[2]) && rows[0].cells[4] === 'checkout' && rows[0].cells[5] === 'checkout-oncall (Slack #checkout-oncall)' && /^Silenced until \d\d:\d\d, firing since \d\d:\d\d$/.test(rows[1].cells[1]) && rows[2].cells[2] === 'no data', JSON.stringify(rows.slice(0, 3).map((r) => r.cells)))
      const payments = rows.find((r) => r.cells[0] === 'Payments errors')
      check('[o3] a monitor that cannot be evaluated has the unknown dash, not the critical mark of a firing one', payments && payments.mark === '' && payments.cells[1] === 'Cannot be evaluated', JSON.stringify(payments))
      // [colour] the state is a shape and a word: every status has words, and the five states drawn are five different marks.
      const marks = await page.evaluate(() => [...document.querySelectorAll('[data-testid=monitor-row] .vz-status')].map((s) => { const b = getComputedStyle(s, '::before'); return { state: s.dataset.state ?? '', words: s.innerText.trim(), shape: [b.width, b.height, b.borderTopWidth, b.borderRadius, b.transform, b.clipPath, b.backgroundImage, b.borderLeftWidth].join('|') } }))
      check('[colour] every state in the list is a mark and words in ink, never colour alone: each has its word, and the marks differ in shape where the states differ', marks.every((m) => m.words.length > 5) && new Set(marks.map((m) => m.shape)).size === new Set(marks.map((m) => m.state)).size && (await page.evaluate(() => [...document.querySelectorAll('[data-testid=monitor-row] .vz-status')].every((s) => getComputedStyle(s).color === getComputedStyle(document.body).color))), JSON.stringify(marks.map((m) => [m.state, m.words.slice(0, 20)])))
      check('the caption and the head say how many and in what order', (await text(page, '[data-testid=monitors-caption]')) === '5 of 7 monitors need attention, firing first.' && /^7 monitors: 2 firing, 1 without data, 1 cannot be evaluated, 1 pending, 2 not firing\. Evaluated (just now|\d+ s ago)\.$/.test(await text(page, '[data-testid=monitors-sub]')), `${await text(page, '[data-testid=monitors-caption]')} | ${await text(page, '[data-testid=monitors-sub]')}`)
      check('the nav marks Monitors as the current section; the page is titled', (await page.evaluate(() => document.querySelector('nav.vz-nav a[aria-current=page]')?.textContent)) === 'Monitors' && (await page.title()) === 'Monitors · viz')
      await page.click('[data-testid=monitors-text] summary')
      const digest = await page.waitForSelector('[data-testid=monitors-digest]').then((e) => e.textContent())
      check('the text form carries the same facts as the rows', digest.startsWith('5 of 7 monitors need attention, firing first.\nCheckout 5xx ratio: Firing since') && digest.includes('Catalog p99 latency: Silenced until') && digest.split('\n').length === 6, digest.slice(0, 160))
      await axe(page, 'monitors list', check)
      await page.click('[data-filter=silenced]')
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=monitor-row]').length === 1)
      check('"Silenced" asks the API for filter=silenced and keeps it in the address', w.sent.some((r) => /filter=silenced$/.test(r.url)) && new URL(page.url()).searchParams.get('filter') === 'silenced' && (await text(page, '[data-testid=monitors-caption]')) === '1 of 7 monitors are silenced, firing first.')
      await page.click('[data-filter=all]')
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=monitor-row]').length === 7)
      const all = await page.evaluate(() => [...document.querySelectorAll('[data-testid=monitor-row]')].map((tr) => tr.dataset.state))
      check('"All" lists every monitor, attention first and the quiet last', all.join(',') === 'firing,firing,no_data,error,pending,ok,ok', all.join(','))
      await page.reload()
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=monitor-row]').length === 7)
      check('a reload keeps the filter', new URL(page.url()).searchParams.get('filter') === 'all')
      check('no script error on the list', errors.length === 0, errors.join(' | '))
      await ctx.close()
    }

    // ------------------------------------------------ its states
    if (want('states')) {
      await hook('reset=1')
      const { ctx, page } = await newPage()
      await hook('empty=1')
      await page.goto(`${APP}/monitors`)
      await page.waitForSelector('[data-testid=monitors-first-run]')
      check('no monitors at all: a first run that says what a monitor is and, truthfully, that this app cannot make one', /cannot make a monitor yet/.test(await text(page, '[data-testid=monitors-first-run]')) && !(await page.$('[data-testid=monitors-filter]')))
      check('[o7] the first run is sentences, not a numbered list of one step', !(await page.$('[data-testid=monitors-first-run] ol')))
      await hook('empty=0')
      await hook('fail=list&status=503')
      await page.reload()
      await page.waitForSelector('[data-testid=monitors-error]')
      check('the list cannot be read: the API\'s own words, its status, and Ask again', (await text(page, '[data-testid=monitors-error-message]')) === 'The ruler did not answer in time; nothing was changed.' && (await text(page, '[data-testid=monitors-error]')).split(/nothing was changed/i).length === 2 && /The API answered unavailable with HTTP 503\./.test(await text(page, '[data-testid=monitors-error]')), await text(page, '[data-testid=monitors-error]'))
      await page.click('[data-testid=monitors-retry]')
      await page.waitForSelector('[data-testid=monitor-row]')
      check('Ask again reads the list', (await page.$$('[data-testid=monitor-row]')).length === 5)
      await hook('delay=1500&route=list')
      await page.reload()
      const t0 = Date.now()
      await page.waitForSelector('[data-testid=monitors-progress]', { timeout: 5000 })
      const shownAfter = Date.now() - t0
      check('waiting: after 400 ms a line says what is asked and for how long (no bar, no skeleton)', shownAfter >= 350 && /Asking the API for the monitors\.\s*\d\.\d s/.test(await text(page, '[data-testid=monitors-progress]')) && !(await page.$('[data-testid=monitors-progress] [role=progressbar]')), `${shownAfter} ms`)
      await page.waitForSelector('[data-testid=monitor-row]')
      await hook('delay=0&route=list')
      await page.goto(`${APP}/monitors?filter=silenced`)
      await page.waitForSelector('[data-testid=monitor-row]')
      await ctx.close()
      // No permission: a key without monitors:read.
      const k = await lib.contextWithKey(browser, READ)
      const p2 = await k.newPage()
      await p2.goto(`${KEYED}/monitors`)
      await p2.waitForSelector('[data-testid=monitors-no-permission]')
      const np = await text(p2, '[data-testid=monitors-no-permission]')
      check('no permission (403): the ruler\'s words, the scopes the key has, the scope it needs, and Sign in with another key', /The API said: API key lacks the monitors:read scope\. The key this tab signed in with has read\./.test(np) && np.includes('monitors:read scope') && !!(await p2.$('[data-testid=monitors-sign-in]')), np)
      await axe(p2, 'monitors, no permission', check)
      await k.close()
    }

    // ------------------------------------------------ one monitor
    if (want('monitor')) {
      await hook('reset=1')
      const { ctx, page, errors } = await newPage()
      const w = watch(page)
      await page.goto(`${APP}/monitors`)
      await page.waitForSelector('[data-testid=monitor-row]')
      // [speed] M-B1: the monitor's page is drawn in the press's own task, from the list's row (read in a listener that runs after the page's).
      await page.evaluate(() => addEventListener('click', () => { window.__opened = { title: document.querySelector('[data-testid=monitor-title]')?.textContent ?? null, mark: !!document.querySelector('[data-testid=monitor-mark]'), list: !!document.querySelector('[data-testid=monitor-row]'), addressed: new URL(location.href).searchParams.get('id') !== null } }, { once: true }))
      await page.click(`[data-testid=open-${FIRING.id}]`)
      const opened = await page.evaluate(() => window.__opened)
      check('[speed] a press on a monitor in the list shows its name and state line in the press\'s own task, and the router\'s change of address comes after that frame', opened && opened.title === 'Checkout 5xx ratio' && opened.mark && !opened.list && !opened.addressed, JSON.stringify(opened))
      const shown = await page.waitForFunction(() => document.querySelector('[data-testid=monitor-title]')?.textContent.trim().length > 1 && document.querySelector('[data-testid=monitor-mark]'), null, { timeout: 5000 }).then(() => true, () => false)
      check('opening a monitor from the list shows its name and state from the list at once, at /monitors?id=…', shown && new URL(page.url()).searchParams.get('id') === FIRING.id && (await text(page, '[data-testid=monitor-title]')) === 'Checkout 5xx ratio')
      await settled(page)
      const state = await text(page, '[data-testid=monitor-state]')
      check('the state line: the critical mark and "Firing since HH:MM (duration)", the time the API gave', /^Firing since \d\d:\d\d \(\d+ (h|min)( \d+ min)?\)$/.test(state) && (await page.evaluate(() => document.querySelector('[data-testid=monitor-mark]').dataset.state)) === 'critical', state)
      const sub = await text(page, '[data-testid=monitor-sub]')
      check('the sub-line: nobody has it, who was told and when, when it repeats, how fresh the page is', /^Not acknowledged\. Notified checkout-oncall \(Slack #checkout-oncall\) at \d\d:\d\d; repeats at (\d+ [A-Z][a-z]{2} )?\d\d:\d\d\. Read (just now|\d+ s ago)\.$/.test(sub), sub)
      const def = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid=monitor-definition] dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent.replace(/\s+/g, ' ').trim()])))
      check('what it watches: message, description, runbook link, threshold as written, for, receiver, owner, last change', /^Checkout is failing \d+(\.\d)?% of requests$/.test(def[Object.keys(def).find((k) => k.startsWith('Message, as sent at'))] ?? '') && def['Message template'] === 'Checkout is failing {{ $value | humanizePercentage }} of requests' && def.Threshold === '> 2%' && def.For === '5 min' && def.Receiver === 'checkout-oncall (Slack #checkout-oncall)' && def.Owner === 'checkout' && /^By key:lee, \d+ Nov \d\d:\d\d$/.test(def.Changed) && (await page.getAttribute('[data-testid=runbook]', 'href')) === 'https://runbooks.example.com/checkout/5xx', JSON.stringify(def))
      const chart = await page.evaluate(() => { const svg = document.querySelector('[data-testid=monitor-chart] svg.vz-plot'); return { lines: svg?.querySelectorAll('.vz-line').length ?? 0, threshold: !!svg?.querySelector('.vz-threshold'), markers: svg?.querySelectorAll('.vz-marker').length ?? 0, words: svg?.textContent ?? '' } })
      check('the query is drawn with the system\'s chart, the threshold as a labelled line, the two markers (above, fired: the chart drops the later word where they collide) and the firing span', chart.lines >= 1 && chart.threshold && chart.markers === 2 && chart.words.includes('> 2% threshold') && /Above \d\d:\d\d/.test(chart.words) && /Firing since \d\d:\d\d/.test(chart.words), JSON.stringify(chart))
      const units = await page.evaluate(() => ({ ticks: [...document.querySelectorAll('[data-testid=monitor-chart] svg.vz-plot text')].map((t) => t.textContent), head: document.querySelector('[data-testid=monitor-chart] thead')?.textContent ?? '', last: document.querySelector('[data-testid=monitor-chart] tbody td[data-c=last]')?.textContent ?? '' }))
      check('[unit] the monitor\'s chart is in the query\'s unit, as the list, the threshold and the history are (M-M2): its axis and legend in %', units.ticks.some((t) => /%$/.test(t)) && /%/.test(units.head + units.last), JSON.stringify(units))
      const well = await page.evaluate(() => { const q = document.querySelector('[data-testid=monitor-query]'); return { sw: q.scrollWidth, cw: q.clientWidth, text: q.textContent } })
      check('[o6] the query is shown whole: it wraps, nothing of it behind a sideways scroll', well.sw <= well.cw + 1 && well.text === FIRING.query, JSON.stringify(well))
      // [o8] the value the monitor reports is its query's at the last evaluation, as the chart of the same query reads it at its end.
      const agree = await page.evaluate(() => ({ alert: document.querySelector('[data-testid=alert-row] td:nth-child(3)')?.textContent.trim() ?? '', last: document.querySelector('[data-testid=monitor-chart] tbody td[data-c=last]')?.textContent.trim() ?? '' }))
      const pct = (t) => Number(t.replace('%', ''))
      check('[o8] the alert\'s value agrees with the chart of its own query (the mock reads its own series)', Number.isFinite(pct(agree.alert)) && Number.isFinite(pct(agree.last)) && Math.abs(pct(agree.alert) - pct(agree.last)) <= Math.max(0.3, 0.25 * pct(agree.last)), JSON.stringify(agree))
      const q = w.sent.filter((r) => /query_range$/.test(r.url))
      check('the chart asks query_range for the monitor\'s query over the last 3 h by default', q.length === 1 && new URLSearchParams(q[0].body).get('query') === FIRING.query && Number(new URLSearchParams(q[0].body).get('end')) - Number(new URLSearchParams(q[0].body).get('start')) >= 3 * 3600 - 60, q.map((r) => r.body.slice(0, 80)).join(' '))
      const alerts = await page.evaluate(() => [...document.querySelectorAll('[data-testid=alert-row] td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()))
      check('its alerts: labels, state with since, value, acknowledged', alerts[0].includes('service=checkout') && /^Firing since \d\d:\d\d$/.test(alerts[1]) && alerts[3] === 'Nobody yet' && /^\d+(\.\d)?%$/.test(alerts[2]), JSON.stringify(alerts))
      const hist = await page.evaluate(() => [...document.querySelectorAll('[data-testid=history-line]')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()))
      check('its history: transitions and notifications merged, newest first', hist.length === 10 && /^\d\d:\d\dNotified checkout-oncall in #checkout-oncall\.$/.test(hist[0]) && /Fired at \d+(\.\d)?%\./.test(hist[1]) && /Created by key:dana\.$/.test(hist.at(-1)), JSON.stringify(hist.slice(0, 3)))
      check('[n-o5] the history says the comparison in words: "Went above 2% (8.4%)", no symbol where the verb\'s object goes', hist.some((h) => /Went above 2% \(\d+(\.\d)?%\)\. Pending for 5 min\./.test(h)) && !hist.some((h) => /Went [<>]/.test(h)), JSON.stringify(hist.filter((h) => /Went/.test(h))))
      await page.click('[data-testid=monitor-text] summary')
      const digest = await page.waitForSelector('[data-testid=monitor-digest]').then((e) => e.textContent())
      check('the text form carries the head\'s facts, the definition, the alerts and the history', digest.split('\n')[0] === `Checkout 5xx ratio. ${state}.` && digest.includes('Threshold: > 2% for 5 min.') && digest.includes('Message template: Checkout is failing {{') && digest.includes('Not acknowledged.') && digest.includes('History, newest first:'), digest.slice(0, 200))
      const explore = await page.getAttribute('[data-testid=open-in-explore]', 'href')
      check('"Open in Explore" carries the query and the range', new URL(explore, APP).pathname === '/explore' && new URL(explore, APP).searchParams.get('q') === FIRING.query && new URL(explore, APP).searchParams.get('from') === 'now-3h', explore)
      await page.click('[data-testid=range-controls] button:has-text("6 h")')
      await page.waitForFunction(() => new URL(location.href).searchParams.get('from') === 'now-6h')
      await settled(page)
      check('the range control asks again and keeps the range in the address', w.sent.filter((r) => /query_range$/.test(r.url)).length === 2)
      await axe(page, 'a firing monitor', check)
      check('the page has no blue button: acknowledge is green, silence is cautionary in its menu', (await page.evaluate(() => document.querySelectorAll('main [data-tone=blue]').length)) === 0 && (await page.getAttribute('[data-testid=acknowledge]', 'data-tone')) === 'green')
      // The monitor in error, and the one without data.
      await page.goto(`${APP}/monitors?id=${M['Payments errors'].id}`)
      await page.waitForSelector('[data-testid=chart-error]')
      check('a monitor that cannot be evaluated: says so, shows the ruler\'s last error and the query\'s refusal, and offers no action', (await text(page, '[data-testid=monitor-state]')) === 'Cannot be evaluated' && (await text(page, '[data-testid=last-error]')).includes('unknown function') && /rate_over_time/.test(await text(page, '[data-testid=chart-error-message]')) && /no alert of this monitor is firing/.test(await text(page, '[data-testid=nothing-to-act]')) && !(await page.$('[data-testid=acknowledge]')))
      await page.goto(`${APP}/monitors?id=${M['Ingest batches stalled'].id}`)
      await page.waitForSelector('[data-testid=chart-empty]')
      check('a monitor without data: the state line says since when, the chart says the query returned nothing', /^No data, firing since \d\d:\d\d/.test(await text(page, '[data-testid=monitor-state]')) && /no series/.test(await text(page, '[data-testid=chart-empty]')))
      await page.goto(`${APP}/monitors?id=mon_0000000000000000`)
      await page.waitForSelector('[data-testid=monitor-error]')
      check('an id no monitor has: says so, and leads back to the list', /There is no such monitor/.test(await text(page, '[data-testid=monitor-error]')) && !!(await page.$('[data-testid=to-list]')))
      check('no script error on the monitor pages', errors.length === 0, errors.join(' | '))
      await ctx.close()
    }

    // ------------------------------------------------ acknowledge
    if (want('ack')) {
      await hook('reset=1')
      const { ctx, page } = await newPage()
      const w = watch(page)
      await page.goto(`${APP}/monitors?id=${FIRING.id}`)
      await settled(page)
      const before = await facts(page)
      const reads = () => w.sent.filter((r) => r.method === 'GET' && r.url.endsWith(`/api/v1/monitors/${FIRING.id}`)).length
      const readsBefore = reads()
      await page.click('[data-testid=acknowledge]')
      await page.waitForSelector('[data-testid=ack-done]')
      const done = await text(page, '[data-testid=ack-done-words]')
      const post = writes(w)
      check('Acknowledge sends one POST …/acknowledge for every firing alert (no fingerprint, no dryRun)', post.length === 1 && post[0].url.endsWith(`/api/v1/monitors/${FIRING.id}/acknowledge`) && post[0].body === '{}', JSON.stringify(post.map((p) => [p.url, p.body])))
      check('it is replaced in place by what is now true, who and when, with Unacknowledge, which has the focus', /^Acknowledged by you at \d\d:\d\d$/.test(done) && (await page.evaluate(() => document.activeElement?.dataset.testid)) === 'unacknowledge', `${done} / ${await page.evaluate(() => document.activeElement?.dataset.testid)}`)
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid=history-line]').length > n, before.history.length)
      const after = await facts(page)
      check('the page is read again after the write: the state line keeps its words and takes the acknowledged mark; the alert and the history say who', reads() > readsBefore && after.state === before.state && after.mark === 'ack' && after.alerts[0].includes('By you at') && /Acknowledged by you\. Repeats stop until it resolves\./.test(after.history[0]) && /no repeats while someone has it/.test(await text(page, '[data-testid=monitor-sub]')), JSON.stringify([after.mark, after.history[0], after.alerts[0]]))
      await page.click('[data-testid=unacknowledge]')
      await page.waitForSelector('[data-testid=acknowledge]')
      await page.waitForFunction(() => /taken back/.test(document.querySelector('[data-testid=history-line]')?.textContent ?? ''))
      const back = await facts(page)
      check('Unacknowledge brings Acknowledge back, focused, the critical mark back, and the history says so', back.mark === 'critical' && (await page.evaluate(() => document.activeElement?.dataset.testid)) === 'acknowledge' && writes(w).at(-1).url.endsWith('/unacknowledge'))
      // The list says both facts in the row once someone has it.
      await page.click('[data-testid=acknowledge]')
      await page.waitForSelector('[data-testid=ack-done]')
      await page.goto(`${APP}/monitors`)
      await page.waitForSelector('[data-testid=monitor-row]')
      const row = await page.evaluate((id) => document.querySelector(`[data-monitor="${id}"] [data-testid=monitor-state]`).textContent, FIRING.id)
      check('the list then says "Acknowledged, firing since …" with the neutral mark, and puts it after what nobody has', /^Acknowledged, firing since \d\d:\d\d$/.test(row) && (await page.evaluate((id) => document.querySelector(`[data-monitor="${id}"] .vz-status`).dataset.state, FIRING.id)) === 'ack', row)
      await ctx.close()
    }

    // ------------------------------------------------ where the silence menu opens (review round 4, M-B2)
    if (want('menuplace')) {
      await hook('reset=1')
      // 640, 1024 and 1500 px with a mouse, and 200% zoom (a 1500 x 900 window at device scale 2: 750 x 450 CSS px).
      const sizes = [['640 px', { viewport: { width: 640, height: 900 } }], ['1024 px', { viewport: { width: 1024, height: 900 } }], ['1500 px', { viewport: { width: 1500, height: 900 } }], ['200% zoom', { viewport: { width: 750, height: 450 }, deviceScaleFactor: 2 }]]
      for (const [name, opts] of sizes) {
        const { ctx, page } = await newPage(opts)
        await page.goto(`${APP}/monitors?id=${FIRING.id}`)
        await settled(page)
        await page.click('[data-testid=silence]')
        await page.waitForSelector('[data-testid=silence-menu][data-open]')
        await sleep(150)
        const m = await page.evaluate(() => { const r = document.querySelector('[data-testid=silence-menu]').getBoundingClientRect(); const d = document.documentElement; return { left: Math.round(r.left), right: Math.round(r.right), cw: d.clientWidth, sw: d.scrollWidth, iw: innerWidth, sx: scrollX } })
        // A press at the window's right edge scrolls nothing sideways either (the page has no width to scroll into).
        await page.evaluate(() => scrollTo(10000, scrollY))
        const sx = await page.evaluate(() => scrollX)
        check(`[menu] at ${name} the silence menu opens inside the window: no sideways scroll with it open, its right edge at or inside the window's`, m.right <= m.cw && m.left >= 0 && m.sw <= m.cw && sx === 0, JSON.stringify({ ...m, sx }))
        await ctx.close()
      }
    }

    // ------------------------------------------------ silence and undo
    if (want('silence')) {
      await hook('reset=1')
      const { ctx, page } = await newPage()
      const w = watch(page)
      await page.goto(`${APP}/monitors?id=${FIRING.id}`)
      await settled(page)
      await page.click('[data-testid=silence]')
      await page.waitForSelector('[data-testid=silence-menu][data-open]')
      const note = await text(page, '.vz-menu-note')
      check('Silence… opens a menu of durations with what will happen and a yellow button that says the choice; nothing is sent yet', /^Notifications stop until \d\d:\d\d\./.test(note) && (await text(page, '[data-testid=silence-confirm]')) === 'Silence for 1 h' && (await page.getAttribute('[data-testid=silence-confirm]', 'data-tone')) === 'yellow' && writes(w).length === 0, note)
      await page.click('[data-duration="15m"]')
      check('choosing a row moves the tick and the button\'s words only', (await text(page, '[data-testid=silence-confirm]')) === 'Silence for 15 min' && writes(w).length === 0)
      await page.click('[data-testid=silence-confirm]')
      await page.waitForSelector('[data-testid=undo]')
      const answer = w.answers.find((a) => a.url.endsWith('/silence'))
      check('[undo] Silence for 15 min sends the duration; the answer\'s undo token is offered as Undo, focused, for its window', JSON.parse(writes(w)[0].body).duration === '15m' && !!answer?.body?.undoToken && (await page.evaluate(() => document.activeElement?.dataset.testid)) === 'undo' && /^Undo is open until \d\d:\d\d \((59|60) s left\)\.$/.test(await text(page, '[data-testid=undo-window]')), await text(page, '[data-testid=undo-window]'))
      check('it is replaced in place by "Silenced by you until HH:MM"', /^Silenced by you until \d\d:\d\d$/.test(await text(page, '[data-testid=silence-done-words]')) || /^Silenced until \d\d:\d\d$/.test(await text(page, '[data-testid=silence-done-words]')), await text(page, '[data-testid=silence-done-words]'))
      await page.waitForFunction(() => /Silenced by you/.test(document.querySelector('[data-testid=history-line]')?.textContent ?? ''))
      check('after the re-read the state line takes the silenced mark and the history says who', (await facts(page)).mark === 'silenced' && /^Silenced by you until \d\d:\d\d$/.test(await text(page, '[data-testid=silence-done-words]')))
      const sub = await text(page, '[data-testid=monitor-sub]')
      check('[n-o1] silenced, not acknowledged: the line under the state says no repeats while it is silenced, and until when; not that someone has it', /no repeats while it is silenced \(until \d\d:\d\d\)\./.test(sub) && !/someone has it/.test(sub), sub)
      await page.click('[data-testid=undo]')
      await page.waitForSelector('[data-testid=silence]')
      const undoReq = writes(w).at(-1)
      check('[undo] Undo sends the token of that call, and the silence is gone: Silence… is back, focused', undoReq.url.endsWith('/api/v1/monitors/silences/undo') && JSON.parse(undoReq.body).undoToken === answer.body.undoToken && (await page.evaluate(() => document.activeElement?.dataset.testid)) === 'silence', undoReq.body)
      await page.waitForFunction(() => /Silence undone by you/.test(document.querySelector('[data-testid=history-line]')?.textContent ?? ''))
      check('the history says it was undone, and the state line has the critical mark again', (await facts(page)).mark === 'critical')
      // After the API's window: 410, explained.
      await page.click('[data-testid=silence]')
      await page.click('[data-testid=silence-confirm]')
      await page.waitForSelector('[data-testid=undo]')
      await hook('advance=61000')
      await page.click('[data-testid=undo]')
      await page.waitForSelector('[data-testid=action-failure]')
      const f = await text(page, '[data-testid=action-failure]')
      check('[undo] Undo after the API\'s window: said once, in the app\'s words and the page\'s times (M-M1): when Undo closed, that the silence stays and until when, that ending it early is not here; no ISO time, no advice the app cannot follow; Undo is gone', /^Undo had closed at \d\d:\d\d, so the silence stays until \d\d:\d\d\. Ending a silence early is not in this app yet\. \(The API answered undo_expired, HTTP 410\.\)/.test(f) && !/\d{4}-\d\d-\d\dT|expire the silence/.test(f) && !(await page.$('[data-testid=undo]')) && !!(await page.$('[data-testid=silence-done]')) && !(await page.$('[data-testid=undo-closed]')), f)
      await ctx.close()
      // The window closing by this tab's clock: Undo goes away by itself, and the page says when it closed.
      await hook('reset=1')
      const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const p2 = await c2.newPage()
      await p2.clock.install()
      await p2.goto(`${APP}/monitors?id=${FIRING.id}`)
      await settled(p2)
      await p2.click('[data-testid=silence]')
      await p2.click('[data-testid=silence-confirm]')
      await p2.waitForSelector('[data-testid=undo]')
      await p2.clock.fastForward(30_000)
      await sleep(400)
      const mid = !!(await p2.$('[data-testid=undo]'))
      await p2.clock.fastForward(31_000)
      await p2.waitForSelector('[data-testid=undo-closed]', { timeout: 5000 }).catch(() => {})
      check('[undo] Undo is offered inside its 60 s and not after: then the page says when the window closed and that the silence stays', mid && !(await p2.$('[data-testid=undo]')) && /^The undo window closed at \d\d:\d\d\. The silence ends at \d\d:\d\d; ending it early is not in this app yet\.$/.test((await text(p2, '[data-testid=undo-closed]')) ?? ''), `${mid} ${await text(p2, '[data-testid=undo-closed]')}`)
      await c2.close()
    }

    // ------------------------------------------------ a write that fails
    if (want('failure')) {
      await hook('reset=1')
      const { ctx, page } = await newPage()
      await page.goto(`${APP}/monitors?id=${FIRING.id}`)
      await settled(page)
      const before = await facts(page)
      await hook('fail=acknowledge&status=503')
      await page.click('[data-testid=acknowledge]')
      await page.waitForSelector('[data-testid=action-failure]')
      await sleep(600)
      const after = await facts(page)
      const f = await text(page, '[data-testid=action-failure]')
      check('[failed] a refused acknowledge: the API\'s words under the button, and nothing else on screen changed', /^Could not acknowledge the monitor\. The API said: the ruler did not answer in time; nothing was changed \(unavailable with HTTP 503\)\. It is still not acknowledged\./.test(f) && (f.match(/nothing (was )?changed/gi) || []).length === 1 && JSON.stringify(after) === JSON.stringify(before) && after.ack && !after.done, `${f} ${JSON.stringify(after) === JSON.stringify(before)}`)
      await page.click('[data-testid=action-retry]')
      await page.waitForSelector('[data-testid=ack-done]')
      check('Try again acknowledges, and the notice goes with no success message', !(await page.$('[data-testid=action-failure]')))
      await page.click('[data-testid=unacknowledge]')
      await page.waitForSelector('[data-testid=acknowledge]')
      await sleep(300)
      const b2 = await facts(page)
      await hook('fail=silence&status=500')
      await page.click('[data-testid=silence]')
      await page.click('[data-testid=silence-confirm]')
      await page.waitForSelector('[data-testid=action-failure]')
      await sleep(600)
      check('[failed] a refused silence: the API\'s words, no undo offered, nothing else changed', /Could not silence the monitor\. The API said: internal error/.test(await text(page, '[data-testid=action-failure]')) && !(await page.$('[data-testid=undo]')) && JSON.stringify(await facts(page)) === JSON.stringify(b2))
      await ctx.close()
    }

    // ------------------------------------------------ a key that may not act
    if (want('noack')) {
      await hook('reset=1', KEYED_MOCK)
      const KM = await ids(KEYED_MOCK)
      const k = await lib.contextWithKey(browser, MONREAD)
      const page = await k.newPage()
      const w = watch(page)
      await page.goto(`${KEYED}/monitors?id=${KM['Checkout 5xx ratio'].id}`)
      await settled(page)
      const why = await text(page, '[data-testid=act-why]')
      check('[scope] without monitors:ack the actions say why they are unavailable, before any press', /^This key cannot acknowledge or silence: it lacks the monitors:ack scope \(it has read, monitors:read\)\. Sign in with an on-call key to act\.$/.test(why) && (await page.getAttribute('[data-testid=acknowledge]', 'aria-disabled')) === 'true' && (await page.getAttribute('[data-testid=silence]', 'aria-disabled')) === 'true', why)
      // A press as a person makes it: the controls are focusable and pressable (aria-disabled, not disabled).
      await page.click('[data-testid=acknowledge]', { force: true })
      await page.click('[data-testid=silence]', { force: true })
      await page.focus('[data-testid=acknowledge]')
      await page.keyboard.press('Enter')
      await sleep(500)
      check('[scope] pressing them sends nothing and opens nothing', writes(w).length === 0 && !(await page.$('[data-testid=silence-menu][data-open]')) && !(await page.$('[data-testid=action-failure]')), JSON.stringify(writes(w)))
      await page.keyboard.press('Control+k')
      await page.waitForSelector('dialog.palette[open]')
      const cmds = await page.evaluate(() => [...document.querySelectorAll('dialog.palette [role=option], dialog.palette [role=menuitem]')].map((e) => e.textContent))
      check('[scope] the command palette does not offer them either', !cmds.some((c) => /Acknowledge this monitor|Silence this monitor/.test(c)), cmds.join(' | '))
      await k.close()
    }

    // ------------------------------------------------ superseded reads
    if (want('superseded')) {
      await hook('reset=1')
      const { ctx, page } = await newPage()
      await page.goto(`${APP}/monitors?id=${FIRING.id}`)
      await settled(page)
      await page.evaluate(() => { window.__marks = []; const rec = () => { const m = document.querySelector('[data-testid=monitor-mark]')?.dataset.state; if (m && window.__marks.at(-1) !== m) window.__marks.push(m) }; new MutationObserver(rec).observe(document.body, { subtree: true, attributes: true, childList: true }); rec() })
      const w = watch(page)
      const t0 = Date.now()
      await hook('delay=3000&route=get&count=1')
      await page.click('[data-testid=refresh]') // a read of the monitor before it is acknowledged, answered 3 s later
      await sleep(150)
      await page.click('[data-testid=acknowledge]')
      await page.waitForFunction(() => /Acknowledged by you/.test(document.querySelector('[data-testid=history-line]')?.textContent ?? '')) // the read after the write, answered at once
      await sleep(3500) // the read from before the write has answered too
      const marks = await page.evaluate(() => window.__marks)
      const gets = w.sent.filter((r) => r.method === 'GET' && r.url.endsWith(`/api/v1/monitors/${FIRING.id}`)).map((r) => r.at - t0)
      const done = (await facts(page))
      check('[superseded] a read that started before the acknowledgement and answered after it is not painted: the mark goes critical to acknowledged, never back, and the page still says who acknowledged it', marks.join(',') === 'critical,ack' && done.mark === 'ack' && /Acknowledged by you/.test(done.history[0]) && gets.length >= 2, `${marks.join(',')}; reads sent at ${gets.join(', ')} ms; ${done.history[0]}`)
      await hook('delay=0&route=get')
      await ctx.close()
    }

    // ------------------------------------------------ the key, with a mock that needs one
    if (want('key')) {
      await hook('reset=1', KEYED_MOCK)
      const KM = await ids(KEYED_MOCK)
      const k = await lib.contextWithKey(browser, ONCALL)
      const page = await k.newPage()
      const w = watch(page)
      await page.goto(`${KEYED}/monitors`)
      await page.waitForSelector('[data-testid=monitor-row]')
      await page.click(`[data-testid=open-${KM['Checkout 5xx ratio'].id}]`)
      await settled(page)
      await page.click('[data-testid=acknowledge]')
      await page.waitForSelector('[data-testid=ack-done]')
      await page.click('[data-testid=silence]')
      await page.click('[data-testid=silence-confirm]')
      await page.waitForSelector('[data-testid=undo]')
      await page.click('[data-testid=undo]')
      await page.waitForSelector('[data-testid=silence]')
      const api = w.sent
      const inUrl = api.filter((r) => r.url.includes(ONCALL) || r.url.includes('oncallSecret') || r.body.includes('oncallSecret'))
      check('[key] the key is in the Authorization header of every monitors request and in no address or body', api.length >= 8 && api.every((r) => r.auth === `Bearer ${ONCALL}`) && inUrl.length === 0 && !page.url().includes('oncallSecret'), `${api.length} requests, ${inUrl.length} with the key elsewhere`)
      check('dryRun is sent nowhere', api.every((r) => !/dryRun/i.test(r.url + r.body)))
      const stored = await page.evaluate(() => [...Array(sessionStorage.length).keys()].map((i) => sessionStorage.key(i)).filter((k) => sessionStorage.getItem(k).includes('oncallSecret')).concat([...Array(localStorage.length).keys()].map((i) => localStorage.key(i)).filter((k) => localStorage.getItem(k).includes('oncallSecret'))))
      check('[key] the key is kept where sign-in keeps it and nowhere else', stored.join(',') === 'viz.key', stored.join(','))
      check('"you" is the key\'s own subject from whoami', /Acknowledged by you at/.test(await text(page, '[data-testid=ack-done-words]')))
      await k.close()
    }

    // ------------------------------------------------ the phone: 44 px that take the tap
    if (want('touch')) {
      await hook('reset=1')
      const { ctx, page } = await newPage(phone)
      await page.goto(`${APP}/monitors`)
      await page.waitForSelector('[data-testid=monitor-row]')
      const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
      const listAreas = await hitAreas(page)
      const ov = await overflow(page)
      check('[touch] the list at 400 px with a coarse pointer: every control in view takes a 44 px tap, none covered, no sideways scroll', coarse && listAreas.small.length === 0 && listAreas.covered.length === 0 && ov.sw <= ov.iw, JSON.stringify({ coarse, ...listAreas, ov }))
      await page.tap(`[data-testid=open-${FIRING.id}]`)
      await settled(page)
      // The whole page in the viewport, so that every control is measured where it is, none cut by the viewport's edge (as e2e/dashboards.cjs does).
      await page.setViewportSize({ width: 400, height: await page.evaluate(() => document.documentElement.scrollHeight) })
      await sleep(300)
      const areas = await hitAreas(page)
      check('[touch] the monitor at 400 px, the whole page: every control takes a 44 px tap, none covered', areas.small.length === 0 && areas.covered.length === 0 && areas.count > 20, JSON.stringify(areas))
      await page.setViewportSize({ width: 400, height: 800 })
      await page.evaluate(() => scrollTo(0, 0))
      await sleep(300)
      // A tap 20 px under the centre of Acknowledge (outside its 32 px drawing, inside its 44 px area) acknowledges.
      const box = await page.evaluate(() => { const r = document.querySelector('[data-testid=acknowledge]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height } })
      await page.touchscreen.tap(box.x, box.y + 20)
      const took = await page.waitForSelector('[data-testid=ack-done]', { timeout: 5000 }).then(() => true, () => false)
      check('[touch] a tap at the edge of Acknowledge\'s 44 px area (20 px under its centre) takes it', took, JSON.stringify(box))
      await page.tap('[data-testid=silence]')
      await page.waitForSelector('[data-testid=silence-menu][data-open]')
      const sheet = await page.evaluate(() => { const m = document.querySelector('[data-testid=silence-menu]').getBoundingClientRect(); return { bottom: Math.round(m.bottom), left: Math.round(m.left), width: Math.round(m.width) } })
      const menuAreas = await hitAreas(page)
      check('[touch] Silence… opens as a sheet across the bottom of the screen, its rows and button taking 44 px taps', sheet.bottom === 800 && sheet.left === 0 && sheet.width === 400 && [...menuAreas.small, ...menuAreas.covered].filter((c) => /^(15 min|1 h|4 h|silence-confirm)/.test(c)).length === 0, JSON.stringify({ sheet, ...menuAreas }))
      await page.tap('[data-testid=silence-confirm]')
      await page.waitForSelector('[data-testid=undo]')
      const undoBox = await page.evaluate(() => { const r = document.querySelector('[data-testid=undo]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
      await page.touchscreen.tap(undoBox.x, undoBox.y - 19)
      const undid = await page.waitForSelector('[data-testid=silence]', { timeout: 5000 }).then(() => true, () => false)
      check('[touch] a tap 19 px above the centre of the small Undo takes it', undid)
      await axe(page, 'a monitor, 400 px, coarse pointer', check)
      await ctx.close()
      // The second theme.
      await hook('reset=1')
      const d = await newPage({ colorScheme: 'dark' })
      await d.page.goto(`${APP}/monitors?id=${SILENCED.id}`)
      await settled(d.page)
      await axe(d.page, 'a silenced monitor, dark theme', check)
      await d.page.goto(`${APP}/monitors`)
      await d.page.waitForSelector('[data-testid=monitor-row]')
      await axe(d.page, 'the list, dark theme', check)
      await d.ctx.close()
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
