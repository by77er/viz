#!/usr/bin/env node
/**
 * Generates the end-to-end fixtures:
 *
 *   test/fixtures/workload.json   what two tenants write (two Remote Write requests each)
 *                                 and the table of queries
 *   test/fixtures/expected.json   what every query must return for each tenant, computed
 *                                 by `engine/query/examples/reference.rs`: viz-promql over
 *                                 its in-memory source. No storage, WASM or HTTP involved.
 *
 * Deterministic: running it again produces the same two files.
 *
 *   node tools/gen-fixtures.mjs        (needs cargo; builds the reference tool if needed)
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../test/fixtures')

/** 2026-11-18T12:00:00Z: the last sample. 30 minutes of data at 15 s. */
const END = Date.UTC(2026, 10, 18, 12)
const STEP = 15_000
const N = 121
const T0 = END - (N - 1) * STEP
/** The first request holds samples up to here; the second starts two minutes earlier (an overlap). */
const CUT = T0 + 80 * STEP
const OVERLAP_FROM = CUT - 8 * STEP

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One tenant's series: `{labels, at(i) -> value | 'stale' | 'NaN' | '+Inf' | undefined}`. */
function seriesOf(tenant) {
  const r = rng(tenant === 'a' ? 1 : 2)
  const base = tenant === 'a' ? 0 : 1000
  const out = []
  const table = (labels, values) => out.push({ labels, values })

  for (const job of ['api', 'web']) {
    for (const instance of ['i1:9100', 'i2:9100']) {
      for (const code of ['200', '500']) {
        let v = base
        const values = []
        for (let i = 0; i < N; i++) {
          v += Math.floor(r() * (code === '200' ? 20 : 3))
          if (job === 'api' && instance === 'i1:9100' && code === '200' && i === 60) v = 3 // a counter reset
          values.push(v)
        }
        table({ __name__: 'http_requests_total', job, instance, code }, values)
      }
      // `up`: web/i2 is down for a while, goes stale, and comes back.
      const up = []
      for (let i = 0; i < N; i++) {
        if (job === 'web' && instance === 'i2:9100') up.push(i < 40 ? 1 : i < 70 ? 0 : i === 70 ? 'stale' : i < 95 ? undefined : 1)
        else up.push(1)
      }
      table({ __name__: 'up', job, instance }, up)
      table({ __name__: 'memory_bytes', job, instance }, Array.from({ length: N }, (_, i) => 1e9 + base * 1e6 + i * 4096 + Math.floor(r() * 1e6)))
    }
    // A classic histogram: cumulative buckets, a sum and a count.
    const counts = [0, 0, 0, 0]
    const buckets = [[], [], [], []]
    const sum = []
    let total = 0
    for (let i = 0; i < N; i++) {
      const k = [Math.floor(r() * 5), Math.floor(r() * 4), Math.floor(r() * 3), Math.floor(r() * 2)]
      let cum = 0
      for (let b = 0; b < 4; b++) {
        counts[b] += k[b]
        cum += counts[b]
        buckets[b].push(cum + (tenant === 'a' ? 0 : 7 * (b + 1)))
      }
      total += k[0] * 0.05 + k[1] * 0.3 + k[2] * 0.75 + k[3] * 2.5
      sum.push(Math.round(total * 1000) / 1000)
    }
    ;['0.1', '0.5', '1', '+Inf'].forEach((le, b) => table({ __name__: 'http_request_duration_seconds_bucket', job, le }, buckets[b]))
    table({ __name__: 'http_request_duration_seconds_count', job }, buckets[3])
    table({ __name__: 'http_request_duration_seconds_sum', job }, sum)
  }
  for (const room of ['attic', 'cellar']) {
    table({ __name__: 'temperature', room }, Array.from({ length: N }, (_, i) => Math.round((Math.sin(i / 9 + (room === 'attic' ? 0 : 2)) * 12 + (room === 'attic' ? 3 : -4) + r() + base / 100) * 100) / 100))
  }
  table({ __name__: 'special', kind: 'inf' }, Array.from({ length: N }, (_, i) => (i % 17 === 5 ? '+Inf' : i % 23 === 7 ? 'NaN' : i % 29 === 3 ? '-Inf' : i)))
  // The SAME label set in both tenants (so the same series_id): only the values differ.
  table({ __name__: 'shared_metric', job: 'shared', instance: 's1:9100' }, Array.from({ length: N }, (_, i) => base + i))
  // Names, labels and values that exist in one tenant only.
  table({ __name__: `${tenant}_only_metric`, job: 'private', instance: 'p1:9100', [`${tenant}_only_label`]: `${tenant}-only-value`, owner: `tenant-${tenant}` }, Array.from({ length: N }, (_, i) => base + 2 * i))
  return out
}

/** The two Remote Write requests of a tenant, as `[{labels, samples: [[ts, value], …]}]`. */
function requestsOf(tenant) {
  const all = seriesOf(tenant)
  const first = []
  const second = []
  for (const s of all) {
    const a = []
    const b = []
    for (let i = 0; i < N; i++) {
      const ts = T0 + i * STEP
      const v = s.values[i]
      if (v === undefined) continue
      if (ts <= CUT) a.push([ts, v])
      if (ts >= OVERLAP_FROM) {
        // Most of the overlap repeats the first request exactly. `temperature` is REWRITTEN
        // in the overlap: the second request's value must win wherever the first is stored.
        const rewritten = ts <= CUT && s.labels.__name__ === 'temperature' && typeof v === 'number'
        b.push([ts, rewritten ? v + 100 : v])
      }
    }
    if (a.length) first.push({ labels: s.labels, samples: a })
    if (b.length) second.push({ labels: s.labels, samples: b })
  }
  return [first, second]
}

const S = END - 20 * 60_000
const range = (id, query, extra = {}) => ({ id, kind: 'range', query, start: S, end: END, step: 30_000, ...extra })
const instant = (id, query, time = END) => ({ id, kind: 'instant', query, time })
const AT = (END - 10 * 60_000) / 1000

const queries = [
  // selectors
  range('sel-name', 'up'),
  range('sel-eq', 'http_requests_total{job="api"}'),
  range('sel-re', 'http_requests_total{code=~"5.."}'),
  range('sel-neq-nre', 'http_requests_total{job!="api",instance!~"i1.*"}'),
  range('sel-name-re', '{__name__=~"up|temperature"}'),
  range('sel-rewritten', 'temperature'),
  range('sel-special', 'special'),
  range('sel-shared', 'shared_metric'),
  range('sel-none', 'no_such_metric'),
  // rate and friends
  range('rate', 'rate(http_requests_total[5m])'),
  range('rate-sum-by', 'sum by (job)(rate(http_requests_total[5m]))'),
  range('irate', 'irate(http_requests_total[1m])'),
  range('increase', 'increase(http_requests_total[2m])'),
  range('resets', 'resets(http_requests_total[10m])'),
  range('changes', 'changes(up[10m])'),
  range('delta', 'delta(temperature[5m])'),
  range('deriv', 'deriv(memory_bytes[5m])'),
  range('predict', 'predict_linear(memory_bytes[5m], 600)'),
  range('avg-over-time', 'avg_over_time(temperature[3m])'),
  range('minmax-over-time', 'max_over_time(temperature[10m]) - min_over_time(temperature[10m])'),
  range('count-over-time-stale', 'count_over_time(up[5m])'),
  // aggregations
  range('sum', 'sum(up)'),
  range('count-by', 'count by (job)(up)'),
  range('avg-without', 'avg without (instance)(memory_bytes)'),
  range('topk', 'topk(2, http_requests_total)'),
  range('quantile', 'quantile(0.9, temperature)'),
  range('stddev', 'stddev by (job)(http_requests_total)'),
  range('sum-special', 'sum(special)'),
  // binary operators
  range('bin-scalar', 'http_requests_total * 2 + 1'),
  range('bin-ratio', 'sum by (job)(rate(http_requests_total{code="500"}[5m])) / sum by (job)(rate(http_requests_total[5m]))'),
  range('bin-cmp', 'up == 0'),
  range('bin-bool', 'http_requests_total > bool 100'),
  range('bin-group-left', 'memory_bytes * on (job, instance) group_left () up'),
  range('bin-and', 'up and on (job, instance) (memory_bytes > 0)'),
  range('bin-or', 'up or temperature'),
  range('bin-unless', 'up unless on (instance) http_requests_total{code="500",job="web"}'),
  range('bin-minmax', 'min(temperature) / max(temperature)'),
  // offset and @
  range('offset', 'http_requests_total offset 5m'),
  range('offset-rate', 'rate(http_requests_total[5m] offset 2m)'),
  range('at', `temperature @ ${AT}`),
  range('at-end', 'sum(up @ end())'),
  // subqueries
  range('subquery-max-rate', 'max_over_time(rate(http_requests_total[1m])[5m:30s])'),
  range('subquery-avg-sum', 'avg_over_time(sum(up)[4m:1m])'),
  // histograms
  range('hq-sum-by', 'histogram_quantile(0.9, sum by (le, job)(rate(http_request_duration_seconds_bucket[5m])))'),
  range('hq-plain', 'histogram_quantile(0.5, rate(http_request_duration_seconds_bucket[5m]))'),
  range('hist-avg', 'http_request_duration_seconds_sum / http_request_duration_seconds_count'),
  // functions, literals
  range('label-replace', 'label_replace(up, "host", "$1", "instance", "(.*):.*")'),
  range('absent', 'absent(no_such_metric)'),
  range('time', 'time()'),
  range('vector', 'vector(1)'),
  range('scalar', 'scalar(sum(up))'),
  range('literal', '1 + 1'),
  range('step-15s', 'sum by (job)(rate(http_requests_total[5m]))', { step: 15_000 }),
  range('step-odd', 'up', { start: S + 1234, end: END - 777, step: 47_000 }),
  // errors
  range('err-many-to-many', 'up + on (job) up'),
  range('err-parse', 'sum('),
  range('err-not-range', 'rate(up)'),
  range('err-unsupported', 'limitk(1, up)'),
  // instant
  instant('i-up', 'up'),
  instant('i-rate-sum-by', 'sum by (job)(rate(http_requests_total[5m]))'),
  instant('i-matrix', 'http_requests_total{job="api"}[1m]'),
  instant('i-scalar', '42'),
  instant('i-string', '"a string"'),
  instant('i-scalar-fn', 'scalar(sum(up))'),
  instant('i-sort', 'sort_desc(http_requests_total)'),
  instant('i-earlier', 'up', END - 7 * 60_000 - 500),
  instant('i-stale', 'up{job="web"}', T0 + 75 * STEP),
  instant('i-hq', 'histogram_quantile(0.99, sum by (le)(rate(http_request_duration_seconds_bucket[10m])))'),
  instant('i-err', 'up + on (job) up'),
]

const requests = { a: requestsOf('a'), b: requestsOf('b') }
writeFileSync(join(fixtures, 'workload.json'), JSON.stringify({ t0: T0, end: END, stepMs: STEP, cut: CUT, requests, queries }) + '\n')

// The reference sees every write of a tenant in order (later wins on the same timestamp).
const dir = mkdtempSync(join(tmpdir(), 'viz-query-fixtures-'))
const input = join(dir, 'reference-input.json')
// Numbers go to the reference as decimal TEXT (JavaScript prints the shortest decimal that
// reads back to the same double), so both sides hold bit-identical values.
const exact = (series) => series.map((s) => ({ labels: s.labels, samples: s.samples.map(([ts, v]) => [ts, String(v)]) }))
writeFileSync(input, JSON.stringify({ tenants: { a: exact(requests.a.flat()), b: exact(requests.b.flat()) }, queries }))
const engine = join(here, '../../engine/query')
const expected = execFileSync('cargo', ['run', '--quiet', '--release', '--example', 'reference', '--', input], {
  cwd: engine,
  env: { ...process.env, CARGO_TARGET_DIR: join(engine, 'target') },
  maxBuffer: 1 << 30,
})
writeFileSync(join(fixtures, 'expected.json'), expected)

const parsed = JSON.parse(expected.toString())
for (const t of ['a', 'b']) {
  const ok = Object.values(parsed[t]).filter((r) => r.status === 'success')
  const empty = ok.filter((r) => Array.isArray(r.data.result) && r.data.result.length === 0).length
  console.log(`tenant ${t}: ${queries.length} queries, ${ok.length} succeed (${empty} with an empty result), ${queries.length - ok.length} must fail`)
}
for (const q of queries) {
  const [ra, rb] = [parsed.a[q.id], parsed.b[q.id]]
  const show = (r) => (r.status === 'error' ? `${r.errorType}: ${r.error.slice(0, 60)}` : `${r.data.resultType}${Array.isArray(r.data.result) && typeof r.data.result[0] === 'object' ? `[${r.data.result.length}]` : ''}`)
  console.log(`  ${q.id.padEnd(24)} ${show(ra).padEnd(40)} ${JSON.stringify(ra) === JSON.stringify(rb) ? 'SAME IN BOTH TENANTS' : ''}`)
}
