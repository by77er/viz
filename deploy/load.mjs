#!/usr/bin/env node
// Steady load through a deployed viz, for measuring a release cutover from OUTSIDE Cloudflare.
//
//   node deploy/load.mjs run    --url U --key-file F --out DIR [--rate 20] [--duration 1800]
//   node deploy/load.mjs mark   --out DIR --label "promote N+1 start"
//   node deploy/load.mjs report --url U --key-file F --out DIR
//
// run: a writer sends `rate` Remote Write requests a second, open loop (a slow answer does not
//   slow the schedule). Request i carries one sample for each of 4 series
//   (viz_trial_load{run, series="0".."3", instance="w0".."w3"}) at timestamp t0 + i·(1000/rate)
//   ms with value i, so every sample is known in advance. A refused request is retried with the
//   SAME body (as Prometheus does): on network errors, 429 and 5xx, after max(Retry-After,
//   backoff 100 ms doubling to 5 s), for up to 60 s; any other 4xx is not retried and is
//   recorded as a rejection. A reader asks `count(viz_trial_load{run})` once a second. Every
//   attempt and every read is logged to DIR/writes.jsonl and DIR/reads.jsonl. Stops at the
//   duration, on SIGTERM/SIGINT, or when DIR/STOP exists; in-flight requests are finished.
// report: statuses and latencies per window between marks, the disturbance in each window
//   (first to last refused attempt), read errors, and the check that matters: every sample
//   the writer saw acknowledged is returned by a query (read in 5-minute slices).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { log, parseArgs } from './lib/common.mjs'
import { instantQuery, percentiles, remoteWrite } from './lib/prw.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SERIES = 4
const METRIC = 'viz_trial_load'
const readKey = (file) => readFileSync(file, 'utf8').trim()
const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const retryable = (s) => s === 0 || s === 429 || s >= 500

async function run({ url, key, out, rate, durationS }) {
  mkdirSync(out, { recursive: true })
  const runId = crypto.randomUUID()
  const intervalMs = 1000 / rate
  const t0 = Date.now()
  writeFileSync(join(out, 'run.json'), JSON.stringify({ runId, url, rate, t0, intervalMs, series: SERIES, metric: METRIC }, null, 2))
  const wlog = join(out, 'writes.jsonl')
  const rlog = join(out, 'reads.jsonl')
  let stopping = false
  const stop = () => (stopping = true)
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  const inflight = new Set()

  async function send(i) {
    const ts = t0 + Math.round(i * intervalMs)
    const series = Array.from({ length: SERIES }, (_, k) => ({ labels: { __name__: METRIC, run: runId, series: String(k), job: 'viz-trial', instance: `w${k}` }, samples: [[ts, i]] }))
    const first = Date.now()
    let backoff = 100
    for (let attempt = 1; ; attempt++) {
      const at = Date.now()
      const r = await remoteWrite(url, key, series)
      appendFileSync(wlog, JSON.stringify({ i, ts, attempt, at, ms: Math.round(r.ms), status: r.status, retryAfter: r.retryAfter, error: r.error, detail: r.status >= 300 || r.status === 0 ? r.text.slice(0, 160) : undefined }) + '\n')
      if (r.status >= 200 && r.status < 300) {
        appendFileSync(wlog, JSON.stringify({ i, ts, final: 'acked', attempts: attempt, ackAt: Date.now() }) + '\n')
        return
      }
      if (!retryable(r.status)) {
        appendFileSync(wlog, JSON.stringify({ i, ts, final: 'rejected', attempts: attempt, status: r.status }) + '\n')
        return
      }
      if (Date.now() - first > 60_000) {
        appendFileSync(wlog, JSON.stringify({ i, ts, final: 'gave-up', attempts: attempt, status: r.status }) + '\n')
        return
      }
      const ra = Number(r.retryAfter)
      await sleep(Math.max(backoff, Number.isFinite(ra) ? Math.min(ra, 30) * 1000 : 0))
      backoff = Math.min(backoff * 2, 5000)
    }
  }

  const reader = (async () => {
    while (!stopping) {
      const at = Date.now()
      const q = await instantQuery(url, key, `count(${METRIC}{run="${runId}"})`)
      const value = q.body?.data?.result?.[0]?.value?.[1] ?? null
      appendFileSync(rlog, JSON.stringify({ at, ms: Math.round(q.ms), status: q.status, value, errorType: q.body?.errorType, error: q.body?.error?.slice?.(0, 160) ?? q.error }) + '\n')
      await sleep(Math.max(0, 1000 - (Date.now() - at)))
    }
  })()

  log(`load: run ${runId}, ${rate}/s × ${SERIES} series, up to ${durationS} s → ${out}`)
  for (let i = 0; ; i++) {
    const due = t0 + i * intervalMs
    const wait = due - Date.now()
    if (wait > 0) await sleep(wait)
    if (stopping || Date.now() - t0 > durationS * 1000 || existsSync(join(out, 'STOP'))) break
    if (inflight.size >= 400) {
      // Something is badly wrong; do not pile up without bound.
      appendFileSync(wlog, JSON.stringify({ i, skipped: 'too many in flight', at: Date.now() }) + '\n')
      continue
    }
    const p = send(i).finally(() => inflight.delete(p))
    inflight.add(p)
  }
  stopping = true
  log(`load: stopping; waiting for ${inflight.size} requests in flight`)
  await Promise.all([...inflight])
  await reader
  writeFileSync(join(out, 'run.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')), t1: Date.now() }, null, 2))
  log('load: stopped')
}

function windows(out) {
  const marks = readJsonl(join(out, 'marks.jsonl'))
  const runInfo = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))
  const edges = [{ label: 'start', at: runInfo.t0 }, ...marks, { label: 'end', at: runInfo.t1 ?? Date.now() }]
  return edges.slice(0, -1).map((e, k) => ({ label: `${e.label} → ${edges[k + 1].label}`, from: e.at, to: edges[k + 1].at }))
}

function summarise(attempts, finals, reads, w) {
  const inW = (x) => x.at >= w.from && x.at < w.to
  const att = attempts.filter(inW)
  const ok = att.filter((a) => a.status >= 200 && a.status < 300)
  const bad = att.filter((a) => !(a.status >= 200 && a.status < 300))
  const byStatus = {}
  for (const a of bad) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1
  const rd = reads.filter(inW)
  const rbad = rd.filter((r) => r.status !== 200)
  const rByStatus = {}
  for (const r of rbad) rByStatus[`${r.status}${r.errorType ? ` ${r.errorType}` : ''}`] = (rByStatus[`${r.status}${r.errorType ? ` ${r.errorType}` : ''}`] ?? 0) + 1
  const reqIds = new Set(att.map((a) => a.i))
  const retriedReqs = new Set(att.filter((a) => a.attempt > 1).map((a) => a.i))
  return {
    window: w.label,
    seconds: Math.round((w.to - w.from) / 1000),
    requests: reqIds.size,
    attempts: att.length,
    refusedAttempts: bad.length,
    refusedByStatus: byStatus,
    requestsRetried: retriedReqs.size,
    disturbanceS: bad.length ? Math.round((Math.max(...bad.map((a) => a.at + a.ms)) - Math.min(...bad.map((a) => a.at))) / 100) / 10 : 0,
    firstRefusedAt: bad.length ? new Date(Math.min(...bad.map((a) => a.at))).toISOString() : null,
    lastRefusedAt: bad.length ? new Date(Math.max(...bad.map((a) => a.at))).toISOString() : null,
    refusedDetails: [...new Set(bad.map((a) => `${a.status} ${a.detail ?? a.error ?? ''}`.trim()))].slice(0, 6),
    writeAckMs: percentiles(ok.map((a) => a.ms)),
    reads: rd.length,
    readErrors: rbad.length,
    readErrorsByStatus: rByStatus,
    readErrorDetails: [...new Set(rbad.map((r) => `${r.status} ${r.errorType ?? ''} ${r.error ?? ''}`.trim()))].slice(0, 6),
    queryMs: percentiles(rd.filter((r) => r.status === 200).map((r) => r.ms)),
  }
}

/** Every acknowledged sample, read back in 5-minute slices of a range selector. */
async function verify(url, key, runInfo, acked) {
  const want = new Map() // `${series}@${ts}` → value
  for (const f of acked) for (let k = 0; k < SERIES; k++) want.set(`${k}@${f.ts}`, f.i)
  const got = new Map()
  const errors = []
  const sliceMs = 5 * 60_000
  const end = (runInfo.t1 ?? Date.now()) + 1000
  for (let t = runInfo.t0 - 1000 + sliceMs; t - sliceMs < end; t += sliceMs) {
    for (let attempt = 0; ; attempt++) {
      const q = await instantQuery(url, key, `${METRIC}{run="${runInfo.runId}"}[5m]`, t / 1000)
      if (q.status === 200 && q.body?.status === 'success') {
        for (const r of q.body.data.result ?? []) for (const [ts, v] of r.values ?? []) got.set(`${r.metric.series}@${Math.round(ts * 1000)}`, Number(v))
        break
      }
      if (attempt >= 4) {
        errors.push(`slice ending ${new Date(t).toISOString()}: ${q.status} ${JSON.stringify(q.body).slice(0, 200)}`)
        break
      }
      await sleep(2000)
    }
  }
  const missing = []
  const wrong = []
  for (const [k, v] of want) {
    if (!got.has(k)) missing.push(k)
    else if (got.get(k) !== v) wrong.push(`${k}: ${got.get(k)} ≠ ${v}`)
  }
  return { ackedSamples: want.size, returnedSamples: got.size, missing: missing.length, missingExamples: missing.slice(0, 10), wrongValues: wrong.length, wrongExamples: wrong.slice(0, 5), queryErrors: errors }
}

async function report({ url, key, out }) {
  const runInfo = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))
  const writes = readJsonl(join(out, 'writes.jsonl'))
  const attempts = writes.filter((w) => w.attempt !== undefined)
  const finals = writes.filter((w) => w.final)
  const reads = readJsonl(join(out, 'reads.jsonl'))
  const acked = finals.filter((f) => f.final === 'acked')
  const totals = {
    runId: runInfo.runId,
    requests: new Set(attempts.map((a) => a.i)).size,
    acked: acked.length,
    rejected: finals.filter((f) => f.final === 'rejected').map((f) => ({ i: f.i, status: f.status })),
    gaveUp: finals.filter((f) => f.final === 'gave-up').length,
    unresolved: new Set(attempts.map((a) => a.i)).size - finals.length,
  }
  const perWindow = windows(out).map((w) => summarise(attempts, finals, reads, w))
  const check = await verify(url, key, runInfo, acked)
  const r = { measured: 'on Cloudflare from outside (this machine, through its egress proxy)', totals, perWindow, check }
  writeFileSync(join(out, 'report.json'), JSON.stringify(r, null, 2))
  console.log(JSON.stringify(r, null, 2))
  return r
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { options: ['url', 'key-file', 'out', 'rate', 'duration', 'label'] })
    const cmd = args._[0]
    if (cmd === 'run') await run({ url: args.url, key: readKey(args['key-file']), out: args.out, rate: Number(args.rate ?? 20), durationS: Number(args.duration ?? 1800) })
    else if (cmd === 'mark') {
      appendFileSync(join(args.out, 'marks.jsonl'), JSON.stringify({ label: args.label, at: Date.now() }) + '\n')
      log(`mark: ${args.label} at ${new Date().toISOString()}`)
    } else if (cmd === 'report') await report({ url: args.url, key: readKey(args['key-file']), out: args.out })
    else throw new Error('usage: load.mjs run|mark|report …')
  } catch (e) {
    log(`load: ${e.message}`)
    process.exit(1)
  }
}
