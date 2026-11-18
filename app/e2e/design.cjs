/* eslint-disable */
// Design-system checks for the Explore view, on the built app and the mock.
//   node e2e/design.cjs            (expects `npm run build` to have run)
// What is checked comes from design-system/project/README.md and review.md:
//   - at most one blue button in a view
//   - no computed colour outside the token set (values read from tokens.json)
//   - a running query makes the button busy and ignores a second press
//   - the progress line: absent at 150 ms, shown after 400 ms, kept 300 ms, Cancel from 2 s
//   - the main flow by keyboard alone, in reading order, with the focus ring at every stop
//   - with a coarse pointer, 44 px hit areas that do not overlap
//   - no sideways page scroll at 400 px; tables scroll inside their wrap
const lib = require('./lib.cjs')
const { chromium, APP, Q_RATE, Q_MANY, Q_BAD, url, tokenRgb, allowedColours, startServers, setMockDelay, overflow } = lib
const { check, results, failed } = lib.makeChecker()
const axe = (page, label) => lib.axe(page, label, check)

const ready = async (page) => {
  await page.waitForSelector('[data-testid=legend] tbody tr')
  await page.waitForSelector('[data-testid=chart] canvas')
  await page.evaluate(() => document.fonts.ready)
}

/** Open each state of the view in turn and call fn(name). Leaves the page on the chart. */
async function eachState(page, fn, { modal = true } = {}) {
  await page.goto(url(Q_RATE)); await ready(page); await fn('chart')
  await page.click('[data-testid=view-table]'); await page.waitForSelector('[data-testid=result-table] tbody tr'); await fn('table')
  await page.click('[data-testid=view-text]'); await page.waitForSelector('[data-testid=text-view] pre'); await fn('text')
  await page.click('[data-testid=view-json]'); await page.waitForSelector('[data-testid=result-json] pre'); await fn('json')
  await page.click('[data-testid=view-chart]'); await page.waitForSelector('[data-testid=chart] canvas')
  await page.click('[data-testid=time-range]'); await page.waitForSelector('role=dialog[name="Time range"]'); await fn('time picker')
  await page.keyboard.press('Escape')
  if (modal) {
    await page.click('[data-testid=open-commands]'); await page.waitForSelector('dialog.palette[open]'); await fn('command palette')
    await page.keyboard.press('Escape')
    await page.click('[data-testid=open-settings]'); await page.waitForSelector('dialog.vz-dialog[open]'); await fn('settings')
    await page.keyboard.press('Escape')
  }
  await page.goto(url(Q_MANY)); await ready(page); await fn('many series')
  await page.goto(url('no_such_metric_total')); await page.waitForSelector('[data-testid=empty-state]'); await fn('empty')
  await page.goto(url(Q_BAD)); await page.waitForSelector('[data-testid=error-state]'); await fn('error')
  await page.goto(`${APP}/explore`); await page.waitForSelector('[data-testid=start-state] a'); await fn('start')
  await page.goto(`${APP}/help`); await page.waitForSelector('h1'); await fn('help')
}

/** Visible elements filled with the primary action colour. */
const blueButtons = (page, blues) =>
  page.evaluate((blues) => {
    const out = []
    for (const el of document.querySelectorAll('body *')) {
      if (el.getClientRects().length === 0) continue
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
      if (el instanceof SVGElement) { if (cs.fill !== 'none') bad('fill', cs.fill); if (cs.stroke !== 'none') bad('stroke', cs.stroke) }
      for (const prop of ['boxShadow', 'backgroundImage']) for (const c of cs[prop].match(colourRe) || []) bad(prop, c)
    }
    for (const el of [document.documentElement, ...document.querySelectorAll('body, body *')]) {
      if (el.getClientRects().length === 0 || /^(SCRIPT|STYLE)$/.test(el.tagName)) continue
      visit(el)
      visit(el, '::before')
      visit(el, '::after')
      if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) visit(el, '::placeholder')
    }
    return [...new Set(out)]
  }, allowed)

/** Controls whose hit area (the element, or its centred ::after) is under `min` px, and pairs whose hit areas overlap. */
const hitAreas = (page, min = 44) =>
  page.evaluate((min) => {
    const modal = document.querySelector('dialog[open]')
    const scope = modal || document
    // Controls lying under an open popover cannot be hit; they are not measured against it.
    const pop = document.querySelector('.popover')?.getBoundingClientRect()
    const covered = (el) => {
      if (!pop || el.closest('.popover')) return false
      const r = el.getBoundingClientRect()
      return r.left < pop.right && r.right > pop.left && r.top < pop.bottom && r.bottom > pop.top
    }
    const controls = [...scope.querySelectorAll('button, a[href], input, select, [role=menuitem], label.vz-check')].filter((el) => {
      if (el.getClientRects().length === 0 || el.disabled || el.classList.contains('app-skip') || covered(el)) return false
      if (el.tagName === 'INPUT' && el.closest('label.vz-check')) return false // the label is the control
      return true
    })
    const area = (el) => {
      const r = el.getBoundingClientRect()
      let { left, top, right, bottom } = r
      const a = getComputedStyle(el, '::after')
      if (a.content !== 'none' && a.content !== 'normal' && a.position === 'absolute') {
        const w = parseFloat(a.width), h = parseFloat(a.height), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2
        left = Math.min(left, cx - w / 2); right = Math.max(right, cx + w / 2); top = Math.min(top, cy - h / 2); bottom = Math.max(bottom, cy + h / 2)
      }
      return { left, top, right, bottom, w: right - left, h: bottom - top }
    }
    const label = (el) => (el.getAttribute('data-testid') || el.textContent || el.getAttribute('aria-label') || el.id || el.tagName).trim().slice(0, 28)
    const items = controls.map((el) => ({ el, a: area(el), label: label(el) }))
    const small = items.filter((i) => i.a.w < min - 0.5 || i.a.h < min - 0.5).map((i) => `${i.label} ${i.a.w.toFixed(0)}×${i.a.h.toFixed(0)}`)
    const overlaps = []
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const p = items[i], q = items[j]
      if (p.el.contains(q.el) || q.el.contains(p.el)) continue
      const dx = Math.min(p.a.right, q.a.right) - Math.max(p.a.left, q.a.left)
      const dy = Math.min(p.a.bottom, q.a.bottom) - Math.max(p.a.top, q.a.top)
      if (dx > 0.5 && dy > 0.5) overlaps.push(`${p.label} / ${q.label} (${dx.toFixed(0)}×${dy.toFixed(0)})`)
    }
    return { count: items.length, small, overlaps, coarse: matchMedia('(pointer: coarse)').matches }
  }, min)

/** The focused element, and whether the design system's ring is drawn on it (or, for the editor, on its well). */
const focusStop = (page, focusRgb) =>
  page.evaluate((focusRgb) => {
    const el = document.activeElement
    if (!el || el === document.body) return { name: 'body', ring: false }
    const well = el.closest('.query-well')
    const cs = getComputedStyle(well || el)
    const ring = cs.outlineStyle === 'solid' && cs.outlineWidth === '2px' && cs.outlineColor === focusRgb
    const name = well ? 'query editor' : (el.getAttribute('data-testid') || el.getAttribute('data-series') || el.textContent || el.id || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 30)
    const r = el.getBoundingClientRect()
    return { name, ring, top: Math.round(r.top + scrollY), left: Math.round(r.left) }
  }, focusRgb)

/** Timestamps (ms, page clock) of the press, the busy state, the progress line and Cancel. */
const watchWait = (page) =>
  page.evaluate(() => {
    const w = (window.__wait = { press: null, busy: null, shown: null, hidden: null, cancel: null, text: '' })
    const run = document.querySelector('[data-testid=run]')
    run.addEventListener('click', () => { if (w.press === null) w.press = performance.now() }, { capture: true, once: true })
    window.__waitObserver?.disconnect()
    window.__waitObserver = new MutationObserver(() => {
      const now = performance.now()
      const p = document.querySelector('[data-testid=progress]')
      if (run.getAttribute('aria-busy') === 'true' && w.busy === null) w.busy = now
      if (p && w.shown === null) { w.shown = now; w.text = p.textContent; w.rows = document.querySelectorAll('[data-testid=legend] tbody tr').length }
      if (!p && w.shown !== null && w.hidden === null) w.hidden = now
      if (document.querySelector('[data-testid=cancel]') && w.cancel === null) w.cancel = now
    })
    window.__waitObserver.observe(document.querySelector('.page'), { subtree: true, childList: true, attributes: true, characterData: true })
  })
const waitTimes = (page) => page.evaluate(() => window.__wait)
const idle = (page) => page.waitForFunction(() => document.querySelector('[data-testid=run]').getAttribute('aria-busy') !== 'true' && !document.querySelector('[data-testid=progress]'), null, { timeout: 20000 })

async function main() {
  const stop = await startServers()
  try {
    const browser = await chromium.launch()
    const errors = []
    const watch = (page) => page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    // ------------------------------------------------ colour: one blue button, tokens only
    for (const theme of ['light', 'dark']) {
      // Reduced motion: colours are sampled at rest, never part-way through a hover transition.
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      watch(page)
      const blues = ['blue', 'blue-hover', 'blue-pressed'].map((t) => tokenRgb(t, theme))
      const allowed = allowedColours(theme)
      const blueCounts = []
      const offenders = []
      await eachState(page, async (state) => {
        await page.mouse.move(0, 0)
        const b = await blueButtons(page, blues)
        blueCounts.push(`${state}:${b.length}`)
        const expected = state === 'help' ? 0 : 1
        if (b.length !== expected) offenders.push(`${state}: ${b.length} blue (${b.join(', ')})`)
        const off = await offTokenColours(page, allowed)
        for (const o of off) offenders.push(`${state}: ${o}`)
        if (theme === 'light' && ['table', 'time picker', 'command palette', 'settings', 'error', 'empty'].includes(state)) await axe(page, `${state}, light`)
      })
      const blueBad = offenders.filter((o) => / blue \(/.test(o))
      const colourBad = offenders.filter((o) => !/ blue \(/.test(o))
      check(`one blue button per view, in every state (${theme})`, blueBad.length === 0, blueBad.join(' | ') || blueCounts.join(' '))
      check(`no computed colour outside the token set, in every state (${theme})`, colourBad.length === 0, colourBad.slice(0, 8).join(' | ') || `${allowed.length} allowed values`)
      // The focus ring and the pressed fill are states too.
      await page.goto(url(Q_RATE)); await ready(page)
      await page.focus('[data-testid=run]'); await page.keyboard.press('Tab')
      const box = await page.locator('[data-testid=view-table]').boundingBox()
      await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down()
      const pressed = await offTokenColours(page, allowed)
      const pressedFill = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=view-table]')).backgroundColor)
      await page.mouse.up()
      check(`a press paints the pressed token fill with no transition (${theme})`, pressed.length === 0 && pressedFill === tokenRgb('rule', theme), `${pressedFill} ${pressed.slice(0, 3).join(' | ')}`)
      await ctx.close()
    }

    // ------------------------------------------------ busy, second press, progress thresholds
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
      const page = await ctx.newPage()
      watch(page)
      const sent = []
      const aborted = []
      page.on('request', (r) => { if (r.url().includes('query_range')) sent.push(r) })
      page.on('requestfailed', (r) => { if (r.url().includes('query_range')) aborted.push(r.failure()?.errorText || '') })
      await page.goto(url(Q_RATE)); await ready(page)

      // 150 ms: nothing but the busy button.
      await setMockDelay(150)
      await watchWait(page)
      await page.click('[data-testid=run]')
      await page.waitForTimeout(700)
      await idle(page)
      let w = await waitTimes(page)
      check('150 ms wait: no progress line, only the busy button', w.shown === null && w.busy !== null, `busy ${(w.busy - w.press).toFixed(0)} ms after the press; progress ${w.shown === null ? 'never shown' : 'shown'}`)

      // 800 ms: busy at once, second presses ignored, progress after 400 ms.
      await setMockDelay(800)
      await watchWait(page)
      const n0 = sent.length
      await page.click('[data-testid=run]')
      const busyNow = await page.getAttribute('[data-testid=run]', 'aria-busy')
      const fill = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=run]')).backgroundColor)
      const rb = await page.locator('[data-testid=run]').boundingBox()
      await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2) // a second pointer press
      await page.keyboard.press('Control+Enter') // a second press by shortcut
      await page.evaluate(() => document.querySelector('[data-testid=run]').click()) // and one that bypasses pointer-events
      await page.focus('[data-testid=run]'); await page.keyboard.press('Enter') // and by keyboard on the button
      // Read from the page's own record: on a busy machine the line can come and go between two calls from here.
      await page.waitForFunction(() => window.__wait.hidden !== null, null, { timeout: 20000 })
      await idle(page)
      w = await waitTimes(page)
      const legendDuring = w.rows
      check('running a query sets the button aria-busy with the pressed fill', busyNow === 'true' && fill === tokenRgb('blue-pressed', 'light'), `aria-busy=${busyNow} fill=${fill}`)
      check('a second press while the query runs is ignored (pointer, shortcut, script, keyboard)', sent.length === n0 + 1, `${sent.length - n0} request(s) for five presses`)
      const shownAfter = w.shown - w.press
      check('800 ms wait: the progress line appears after 400 ms, not before', shownAfter >= 400 && shownAfter < 700, `shown ${shownAfter.toFixed(0)} ms after the press`)
      check('800 ms wait: the line says what is happening and offers no Cancel yet', /Waiting for the query/.test(w.text) && /\d\.\d\s*s/.test(w.text) && w.cancel === null, w.text.replace(/\s+/g, ' ').trim())
      check('800 ms wait: the line stays at least 300 ms', w.hidden - w.shown >= 300, `${(w.hidden - w.shown).toFixed(0)} ms`)
      check('the previous result stays visible while the next loads', legendDuring === 4, `${legendDuring} legend rows during the wait`)

      // 450 ms: the answer arrives just after the line appears; the line must not flash.
      await setMockDelay(450)
      await watchWait(page)
      await page.click('[data-testid=run]')
      await page.waitForTimeout(600)
      await idle(page)
      w = await waitTimes(page)
      check('450 ms wait: a line that was shown is kept 300 ms, so it never flashes', w.shown === null || w.hidden - w.shown >= 300, w.shown === null ? 'not shown' : `shown for ${(w.hidden - w.shown).toFixed(0)} ms`)

      // 3 s: Cancel from 2 s, the old result usable meanwhile, Cancel aborts the request.
      await setMockDelay(3000)
      await watchWait(page)
      const n1 = sent.length
      await page.click('[data-testid=run]')
      await page.waitForSelector('[data-testid=progress]')
      await page.click('[data-testid=legend] button[data-series=\'{service="checkout"}\']')
      const usable = await page.$$eval('[data-testid=legend] button[aria-pressed=true]', (b) => b.length)
      await page.click('[data-testid=legend] button[data-series=\'{service="checkout"}\']')
      const cancelEarly = await page.$('[data-testid=cancel]')
      await page.waitForSelector('[data-testid=cancel]')
      w = await waitTimes(page)
      const cancelAfter = w.cancel - w.press
      check('3 s wait: Cancel appears at 2 s, not before', cancelAfter >= 2000 && cancelAfter < 2400 && !cancelEarly, `Cancel ${cancelAfter.toFixed(0)} ms after the press`)
      check('3 s wait: the previous result is usable while waiting (a legend row isolates)', usable === 1, `${usable} series shown after selecting one`)
      const age = await page.textContent('[data-testid=age]')
      check('the panel head states the unit and the age of the data shown', /per second \(\/s\) · updated (now|\d+ (s|min) ago)/.test(age), age)
      await page.click('[data-testid=cancel]')
      await page.waitForSelector('[data-testid=halted]')
      const halted = await page.textContent('[data-testid=halted]')
      await page.waitForTimeout(100)
      check('Cancel aborts the request and says so, with Retry', aborted.length === 1 && /Cancelled\. The previous result is shown\./.test(halted) && /Retry/.test(halted), `${aborted.join(',')} — ${halted.replace(/\s+/g, ' ').trim()}`)
      check('after Cancel the previous result is still shown and the button is free', (await page.$$eval('[data-testid=legend] tbody tr', (r) => r.length)) === 4 && (await page.getAttribute('[data-testid=run]', 'aria-busy')) !== 'true')
      await setMockDelay(0)
      await page.click('[data-testid=halted] button')
      await page.waitForSelector('[data-testid=halted]', { state: 'detached' })
      check('Retry runs the query again', sent.length === n1 + 2, `${sent.length - n1} requests`)
      // "updated 0 s ago" is now "updated now" for the first 5 s (review m3); the count starts after that.
      await page.waitForFunction(() => /updated now/.test(document.querySelector('[data-testid=age]')?.textContent || ''))
      const age1 = await page.textContent('[data-testid=age]')
      await page.waitForTimeout(5600)
      const age2 = await page.textContent('[data-testid=age]')
      await page.waitForTimeout(1500)
      const age3 = await page.textContent('[data-testid=age]')
      check('the age keeps counting', age1 !== age2 && /updated [5-9] s ago/.test(age2) && age3 !== age2 && /updated ([6-9]|1\d) s ago/.test(age3), `${age1} → ${age2} → ${age3}`)
      await ctx.close()
    }

    // ------------------------------------------------ keyboard only, with the ring at every stop
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
      const page = await ctx.newPage()
      watch(page)
      const sent = []
      page.on('request', (r) => { if (r.url().includes('query_range')) sent.push(r) })
      const focusRgb = tokenRgb('focus', 'light')
      await page.goto(`${APP}/explore?from=${lib.T0}&to=${lib.T1}`)
      await page.waitForSelector('[data-testid=start-state] a')
      await page.waitForSelector('.cm-content')
      const stops = []
      const tab = async () => { await page.keyboard.press('Tab'); const s = await focusStop(page, focusRgb); stops.push(s); return s }
      for (let i = 0; i < 6; i++) await tab() // skip link, Explore, Help, Commands, Settings, editor
      await page.keyboard.type(Q_RATE)
      await page.keyboard.press('Control+Enter')
      await ready(page)
      check('keyboard: the query is typed and run without a pointer', sent.length === 1 && new URL(page.url()).searchParams.get('q') === Q_RATE)
      await tab() // Run query
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('[data-testid=run]').getAttribute('aria-busy') !== 'true')
      check('keyboard: Enter on Run query runs it', sent.length === 2, `${sent.length} requests`)
      await tab() // time range
      await page.keyboard.press('Enter')
      await page.waitForSelector('role=dialog[name="Time range"]')
      const inMenu = await focusStop(page, focusRgb)
      await page.keyboard.press('ArrowDown')
      const second = await focusStop(page, focusRgb)
      await page.keyboard.press('Escape')
      const back = await focusStop(page, focusRgb)
      check('keyboard: the time picker opens, its first item takes the ring, Escape returns focus', /Last 5 m/.test(inMenu.name) && inMenu.ring && /Last 15 m/.test(second.name) && second.ring && back.name === 'time-range' && back.ring, `${inMenu.name} → ${back.name}`)
      for (let i = 0; i < 8; i++) await tab() // Show earlier, Show later, Zoom in, Zoom out, Reset zoom, Step, Unit, Chart
      await tab() // Table
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid=result-table] tbody tr')
      const tableStop = await focusStop(page, focusRgb)
      check('keyboard: Enter on Table shows the table and keeps focus and ring', tableStop.name === 'view-table' && tableStop.ring)
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Enter') // back to Chart
      await page.waitForSelector('[data-testid=chart] canvas')
      for (let i = 0; i < 3; i++) await tab() // Table, Text, JSON
      const chartStop = await tab() // chart
      await page.keyboard.press('ArrowRight')
      const live = await page.textContent('[data-testid=chart] [aria-live]')
      check('keyboard: the chart takes focus and arrow keys read values', chartStop.name === 'chart' && /\d\d:\d\d:\d\d\. /.test(live), live.slice(0, 50))
      for (let i = 0; i < 8; i++) await tab() // four column heads, four legend rows
      await page.keyboard.press('Enter')
      const isolated = await page.$$eval('[data-testid=legend] button[aria-pressed=true]', (b) => b.length)
      check('keyboard: Enter on a legend row isolates the series', isolated === 1)
      const names = stops.map((s) => s.name)
      const expected = ['Skip to content', 'Explore', 'Help', 'open-commands', 'open-settings', 'query editor', 'run', 'time-range', 'Show earlier', 'Show later', 'zoom-in', 'zoom-out', 'zoom-reset', 'step', 'unit', 'view-chart', 'view-table', 'view-table', 'view-text', 'view-json', 'chart', 'Series ↑', 'Last, /s', 'Min, /s', 'Max, /s', '{service="auth"}', '{service="catalog"}', '{service="checkout"}', '{service="orders"}']
      check('keyboard: focus order follows reading order', JSON.stringify(names) === JSON.stringify(expected), names.join(' › '))
      const noRing = stops.filter((s) => !s.ring).map((s) => s.name)
      check('keyboard: the focus ring (2 px, focus token) is drawn at every stop', noRing.length === 0, noRing.length ? `no ring on: ${noRing.join(', ')}` : `${stops.length} stops`)
      // Dialogs: focus moves in, Escape returns it.
      await page.focus('[data-testid=open-settings]')
      await page.keyboard.press('Enter')
      await page.waitForSelector('dialog.vz-dialog[open]')
      const inDialog = await page.evaluate(() => !!document.activeElement.closest('dialog[open]'))
      await page.keyboard.press('Escape')
      const after = await focusStop(page, focusRgb)
      check('keyboard: the settings dialog takes focus and Escape returns it to its button', inDialog && after.name === 'open-settings', after.name)
      await ctx.close()
    }

    // ------------------------------------------------ coarse pointer and 400 px
    {
      const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'light' })
      const page = await ctx.newPage()
      watch(page)
      const small = []
      const overlaps = []
      const sideways = []
      let coarse = true
      let controls = 0
      await eachState(page, async (state) => {
        const h = await hitAreas(page)
        coarse = coarse && h.coarse
        controls += h.count
        for (const s of h.small) small.push(`${state}: ${s}`)
        for (const o of h.overlaps) overlaps.push(`${state}: ${o}`)
        const o = await overflow(page)
        if (o.sw > o.iw) sideways.push(`${state}: ${o.sw} > ${o.iw}`)
      })
      check('the emulated device has a coarse pointer', coarse)
      check('coarse pointer: every control has a 44 px hit area, in every state', small.length === 0, small.slice(0, 8).join(' | ') || `${controls} controls measured`)
      check('coarse pointer: no two hit areas overlap, in every state', overlaps.length === 0, overlaps.slice(0, 8).join(' | '))
      check('coarse pointer, 400 px: nothing scrolls the page sideways, in every state', sideways.length === 0, sideways.join(' | '))
      // A tap works where hover would have been needed: the crosshair readout.
      await page.goto(url(Q_RATE)); await ready(page)
      const over = await page.locator('[data-testid=chart] .u-over').boundingBox()
      await page.touchscreen.tap(over.x + over.width * 0.5, over.y + over.height * 0.5)
      await page.waitForSelector('.chart-tip', { state: 'visible', timeout: 5000 }).catch(() => {})
      check('touch: a tap on the chart shows the crosshair readout (nothing depends on hover)', await page.isVisible('.chart-tip'))
      const inputFont = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-testid=step]')).fontSize))
      check('coarse pointer: text inputs use body-size text, so the page does not zoom on focus', inputFont >= 15, `${inputFont}px`)
      await ctx.close()
    }
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, colorScheme: theme })
      const page = await ctx.newPage()
      watch(page)
      const sideways = []
      const tiny = []
      await eachState(page, async (state) => {
        const o = await overflow(page)
        if (o.sw > o.iw) sideways.push(`${state}: ${o.sw} > ${o.iw}`)
        const t = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getClientRects().length && e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 11).map((e) => e.textContent.trim().slice(0, 20)))
        for (const x of t) tiny.push(`${state}: ${x}`)
        if (theme === 'light' && (state === 'chart' || state === 'table')) await axe(page, `${state}, 400 px light`)
      })
      check(`400 px: nothing scrolls the page sideways, in every state (${theme})`, sideways.length === 0, sideways.join(' | '))
      check(`400 px: no text below the micro size (${theme})`, tiny.length === 0, tiny.slice(0, 5).join(' | '))
      await page.goto(url(Q_MANY, '&view=table')); await page.waitForSelector('[data-testid=result-table] tbody tr')
      const wrap = await page.evaluate(() => { const w = document.querySelector('[data-testid=result-table] .vz-table-wrap'); return { scrolls: w.scrollWidth > w.clientWidth, page: document.documentElement.scrollWidth <= innerWidth } })
      check(`400 px: a wide table scrolls inside its wrap, not the page (${theme})`, wrap.scrolls && wrap.page)
      await ctx.close()
    }

    // ------------------------------------------------ reduced motion
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      await page.goto(url(Q_RATE)); await ready(page)
      const moving = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getClientRects().length && getComputedStyle(e).transitionDuration.split(',').some((d) => parseFloat(d) > 0)).map((e) => e.className).slice(0, 5))
      check('reduced motion: no transition remains', moving.length === 0, moving.join(' | '))
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
