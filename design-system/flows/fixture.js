/* The flow screens' one incident, as chart data. Clock: Wednesday 18 Nov 2026, 15:16 (the system chart's NOW).
   Deterministic: a seeded walk between anchor points, with the figures the screens state pinned exactly, so every table, stat,
   sentence and chart agrees. The times and figures are listed in REVIEW-INPUT.md; `node build.mjs --facts` prints them from here. */
;(function (root) {
  const MIN = 60000, T = (h, m, d = 18) => Date.UTC(2026, 10, d, h, m), NOW = T(15, 16)
  const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 }
  // One value per step: linear between anchors [time, value], times (1 + noise * (r - 0.5)), clamped, then the pinned [time, value] pairs.
  function walk(t0, step, n, anchors, { noise = 0.06, seed = 1, dec = 0, max = Infinity, pins = [] } = {}) {
    const r = lcg(seed), out = []
    for (let i = 0; i < n; i++) {
      const t = t0 + i * step; let k = 0; while (k < anchors.length - 2 && anchors[k + 1][0] <= t) k++
      const [ta, va] = anchors[k], [tb, vb] = anchors[k + 1], f = Math.max(0, Math.min(1, (t - ta) / (tb - ta)))
      out.push(+Math.min(max, (va + (vb - va) * f) * (1 + noise * (r() - 0.5))).toFixed(dec))
    }
    for (const [t, v] of pins) out[Math.round((t - t0) / step)] = v
    return out
  }
  const six = { t0: T(9, 16), step: 6 * MIN, n: 61 } // 09:16 to 15:16, a 6 min step
  const route = (r) => ({ service: 'checkout-api', route: r })
  // p99 by route, ms, 6 min max. POST /v2/orders: below 500 until 12:58, 531 at 13:02 (pending), 548 at 13:07 (fired), 912 now.
  const orders = walk(six.t0, six.step, six.n, [[T(9, 16), 330], [T(12, 52), 345], [T(12, 58), 384], [T(13, 4), 541], [T(13, 10), 596], [T(13, 40), 800], [T(14, 10), 880], [T(15, 16), 905]],
    { noise: 0.05, seed: 7, pins: [[T(12, 58), 384], [T(13, 4), 541], [T(13, 10), 596], [T(14, 46), 926], [T(15, 16), 912]] })
  const cart = walk(six.t0, six.step, six.n, [[T(9, 16), 330], [T(10, 40), 352], [T(11, 4), 418], [T(11, 28), 340], [T(15, 16), 318]], { noise: 0.1, seed: 8, pins: [[T(15, 16), 315]] })
  const products = walk(six.t0, six.step, six.n, [[T(9, 16), 121], [T(15, 16), 118]], { noise: 0.14, seed: 9, pins: [[T(15, 16), 117]] })
  const latency = () => ({ unit: 'ms', agg: 'max', ...six, series: [{ labels: route('POST /v2/orders'), values: orders }, { labels: route('GET /v2/cart/{id}'), values: cart }, { labels: route('GET /v2/products'), values: products }] })
  // Server errors by route, % of requests, 6 min mean. POST /v2/orders fails more from 13:05 (payments-db's connection pool is full).
  const errOrders = walk(six.t0, six.step, six.n, [[T(9, 16), 0.2], [T(13, 4), 0.2], [T(13, 10), 2.4], [T(13, 40), 7.2], [T(14, 30), 9.4], [T(15, 16), 9.6]], { noise: 0.06, seed: 11, dec: 2, max: 9.9, pins: [[T(15, 16), 9.8]] })
  const errCart = walk(six.t0, six.step, six.n, [[T(9, 16), 0.1], [T(15, 16), 0.1]], { noise: 0.5, seed: 12, dec: 2, pins: [[T(15, 16), 0.1]] })
  const errProducts = walk(six.t0, six.step, six.n, [[T(9, 16), 0.02], [T(15, 16), 0.02]], { noise: 0.8, seed: 13, dec: 2, pins: [[T(15, 16), 0.02]] })
  const errors = () => ({ unit: '%', agg: 'mean', ...six, series: [{ labels: route('POST /v2/orders'), values: errOrders }, { labels: route('GET /v2/cart/{id}'), values: errCart }, { labels: route('GET /v2/products'), values: errProducts }] })
  // p50 of POST /v2/orders, for the trace view
  const p50 = walk(six.t0, six.step, six.n, [[T(9, 16), 118], [T(12, 58), 124], [T(13, 10), 236], [T(13, 40), 298], [T(15, 16), 309]], { noise: 0.06, seed: 14, pins: [[T(15, 16), 310]] })
  const traceDurations = () => ({ unit: 'ms', agg: 'max', ...six, series: [{ labels: { quantile: 'p99' }, values: orders }, { labels: { quantile: 'p50' }, values: p50 }] })
  // Dependencies of checkout-api, p99 ms. payments-db: 40 ms until 12:58, 610 ms at 13:09 (when the agent read it), 624 ms now.
  const dep = (d) => ({ service: 'checkout-api', dependency: d })
  const payments6 = walk(six.t0, six.step, six.n, [[T(9, 16), 40], [T(12, 52), 41], [T(12, 58), 46], [T(13, 4), 452], [T(13, 10), 618], [T(15, 16), 622]], { noise: 0.08, seed: 21, pins: [[T(12, 58), 46], [T(13, 4), 452], [T(13, 10), 618], [T(15, 16), 624]] })
  const inventory6 = walk(six.t0, six.step, six.n, [[T(9, 16), 120], [T(15, 16), 118]], { noise: 0.12, seed: 22, pins: [[T(15, 16), 118]] })
  const cache6 = walk(six.t0, six.step, six.n, [[T(9, 16), 31], [T(15, 16), 30]], { noise: 0.2, seed: 23, pins: [[T(15, 16), 30]] })
  const deps = () => ({ unit: 'ms', agg: 'max', ...six, series: [{ labels: dep('payments-db'), values: payments6 }, { labels: dep('inventory'), values: inventory6 }, { labels: dep('cache'), values: cache6 }] })
  // The agent's read: 12:00 to 13:09 at a 3 min step, finished 13:09.
  const agent = { t0: T(12, 0), step: 3 * MIN, n: 24 }
  const paymentsA = walk(agent.t0, agent.step, agent.n, [[T(12, 0), 40.6], [T(12, 57), 41], [T(13, 0), 182], [T(13, 3), 431], [T(13, 6), 571], [T(13, 9), 610]], { noise: 0.03, seed: 31, pins: [[T(12, 0), 40], [T(12, 57), 42], [T(13, 0), 182], [T(13, 3), 431], [T(13, 6), 571], [T(13, 9), 610]] })
  const inventoryA = walk(agent.t0, agent.step, agent.n, [[T(12, 0), 119], [T(13, 9), 121]], { noise: 0.1, seed: 32 })
  const cacheA = walk(agent.t0, agent.step, agent.n, [[T(12, 0), 31], [T(13, 9), 30]], { noise: 0.2, seed: 33 })
  const depsAgent = () => ({ unit: 'ms', agg: 'max', ...agent, series: [{ labels: dep('payments-db'), values: paymentsA }, { labels: dep('inventory'), values: inventoryA }, { labels: dep('cache'), values: cacheA }] })
  // Error log lines per minute from checkout-api, 6 min mean. 1,300 now: 212.4 req/s x 9.8% + 842.6 req/s x 0.1%, in lines a minute.
  const logRate = walk(six.t0, six.step, six.n, [[T(9, 16), 2], [T(13, 4), 3], [T(13, 10), 330], [T(13, 40), 960], [T(14, 30), 1240], [T(15, 16), 1290]], { noise: 0.08, seed: 41, pins: [[T(15, 16), 1300]] })
  const logs = () => ({ unit: 'lines/min', agg: 'mean', ...six, series: [{ labels: { service: 'checkout-api', level: 'error' }, values: logRate }] })
  const logLines = Math.round(logRate.reduce((a, b) => a + b, 0) * 6) // lines in the range: the rate times the 6 min step
  // The backtest is the system's own fixture (vzChartDemos.backtest: cart error ratio, 7 d at 5 min max). The spans here are when the
  // rule as set (above 1% for at least 10 min) would have been firing: 10 min after each crossing until the value fell back.
  function backtest() {
    const b = root.vzChartDemos.backtest()
    return { ...b, spans: [{ from: T(5, 51, 14), to: T(5, 56, 14), label: '5 min' }, { from: T(20, 16, 16), to: T(20, 36, 16), label: '20 min' }] }
  }
  // The many-series case for New monitor: the same ratio by pod, 36 pods.
  function backtestByPod() {
    const b = root.vzChartDemos.backtest(), base = b.series[0].values, r = lcg(36), series = []
    for (let p = 0; p < 36; p++) { const k = 0.4 + 2.2 * Math.pow(r(), 4), id = Math.floor(r() * 0xfffff).toString(16).padStart(5, '0')
      series.push({ labels: { service: 'cart', pod: 'cart-6c8d9f7b4-' + id }, values: base.map((v, i) => +(v * k * (0.9 + 0.2 * ((i * (p + 3)) % 7) / 7)).toFixed(3)) }) }
    return { ...b, spans: [], series }
  }
  const T0 = { T, MIN, NOW }
  root.flows = { ...T0, latency, errors, traceDurations, deps, depsAgent, logs, logLines, backtest, backtestByPod,
    markers: { deploy: { t: T(9, 41), label: 'Deploy 09:41' }, above: { t: T(13, 2), label: 'Above 13:02' }, fired: { t: T(13, 7), label: 'Fired 13:07' }, slow: { t: T(12, 58), label: 'Slow since 12:58' }, trace: { t: T(15, 14), label: 'This trace 15:14' } },
    firing: (label = 'Firing since 13:07') => ({ from: T(13, 7), to: NOW, label }) }
})(typeof window !== 'undefined' ? window : globalThis)
