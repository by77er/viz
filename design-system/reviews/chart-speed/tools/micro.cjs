const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.goto('about:blank')
  const out = await page.evaluate(() => {
    const N = 721, S = 200
    const mk = () => Array.from({ length: S }, (_, k) => { const a = new Float64Array(N); for (let i = 0; i < N; i++) a[i] = Math.sin(i / 50 + k) * 3 + 4.123; return a })
    const variants = {
      loopIsFinite(src) { const values = new Array(src.length); for (let i = 0; i < src.length; i++) { const v = src[i]; values[i] = Number.isFinite(v) ? v * 1 : null } return values },
      loopSelf(src) { const n = src.length, values = new Array(n); for (let i = 0; i < n; i++) { const v = src[i]; values[i] = v - v === 0 ? v : null } return values },
      arrayFrom(src) { return Array.from(src) },
      spread(src) { return [...src] },
      sliceCall(src) { return Array.prototype.slice.call(src) },
      arrayFromThenFix(src) { const values = Array.from(src); for (let i = 0; i < values.length; i++) { const v = values[i]; if (v - v !== 0) values[i] = null } return values },
    }
    const stats = {
      forOf(v) { let last = null, min = Infinity, max = -Infinity; for (const x of v) if (x != null) { last = x; if (x < min) min = x; if (x > max) max = x } return [last, min, max] },
      indexed(v) { let last = null, min = Infinity, max = -Infinity; for (let i = 0, n = v.length; i < n; i++) { const x = v[i]; if (x != null) { last = x; if (x < min) min = x; if (x > max) max = x } } return [last, min, max] },
    }
    const band = {
      colMajor(other, n) { const lo = [], hi = []; for (let i = 0; i < n; i++) { let a = Infinity, b = -Infinity; for (const s of other) { const p = s[i]; if (p != null) { if (p < a) a = p; if (p > b) b = p } } lo.push(a === Infinity ? null : a); hi.push(b === -Infinity ? null : b) } return [lo, hi] },
      rowMajor(other, n) { const a = new Float64Array(n).fill(Infinity), b = new Float64Array(n).fill(-Infinity); for (let k = 0; k < other.length; k++) { const v = other[k]; for (let i = 0; i < n; i++) { const p = v[i]; if (p != null) { if (p < a[i]) a[i] = p; if (p > b[i]) b[i] = p } } } const lo = new Array(n), hi = new Array(n); for (let i = 0; i < n; i++) { lo[i] = a[i] === Infinity ? null : a[i]; hi[i] = b[i] === -Infinity ? null : b[i] } return [lo, hi] },
    }
    const fx = {
      toFixed(ys) { let d = ''; for (let i = 0; i < ys.length; i++) d += 'L' + (i * 1.7345).toFixed(1) + ' ' + ys[i].toFixed(1); return d.length },
      toFixedYonly(ys, xs) { let d = ''; for (let i = 0; i < ys.length; i++) d += 'L' + xs[i] + ' ' + ys[i].toFixed(1); return d.length },
    }
    const res = {}
    const time = (name, fn) => { const t = []; for (let r = 0; r < 4; r++) { const t0 = performance.now(); fn(); t.push(+(performance.now() - t0).toFixed(1)) } res[name] = t }
    for (const [k, f] of Object.entries(variants)) { const data = mk(); time('toArray.' + k, () => { let n = 0; for (const s of data) n += f(s).length; return n }) }
    const arrays = mk().map((s) => variants.loopSelf(s))
    for (const [k, f] of Object.entries(stats)) time('stats.' + k, () => { let n = 0; for (const s of arrays) n += f(s.slice(0, N))[1]; return n })
    for (const [k, f] of Object.entries(band)) time('band.' + k, () => f(arrays.slice(8), N)[0].length)
    const ys = Array.from({ length: 721 * 12 }, (_, i) => 30 + (i % 289) * 0.731), xs = ys.map((_, i) => (i * 1.7345).toFixed(1))
    time('path.toFixedBoth', () => fx.toFixed(ys)); time('path.toFixedYonly', () => fx.toFixedYonly(ys, xs))
    return res
  })
  for (const [k, v] of Object.entries(out)) console.log(k.padEnd(28), v.join('  '))
  await browser.close()
})()
