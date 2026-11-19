#!/usr/bin/env node
// Trial 2 (deploy/README.md, "Trial 2: monitors, alerting and the agent surface"): drives a
// staged deployment end to end and reports what happened. Nothing secret is printed: keys,
// the sink's path token and the webhook secret live only in files of the --state directory
// (mode 0600), and in the Workers' secrets.
//
//   node deploy/trial/trial2.mjs sink-up   --stage S --state DIR --expires ISO   receiver Worker viz-S-sink + KV viz-S-sink
//   node deploy/trial/trial2.mjs run       --stage S --state DIR [--runs 20]      needs DIR/admin.key (bootstrap.mjs --key-file)
//   node deploy/trial/trial2.mjs sink-down --stage S                              delete the receiver Worker and its KV
//
// `run`: keys through control; the default destination (control's notification settings) set
// to the sink, signed; the tenant's routing naming viz:default; data by Remote Write; a
// threshold monitor, an anomaly monitor and a recording rule through the ruler's API; one new
// series above the threshold per run, so each run is one alert and one notification; then the
// sink's records, the monitors, the recorded series and MCP over /mcp are checked, and the
// latency from each alert's evaluation (`startsAt`, the tick that saw it) to its arrival at the
// sink (the sink's clock) is reported. Both clocks are Cloudflare's: "measured on Cloudflare".
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cf, cfList, deleteScript, workersSubdomain } from '../lib/cf.mjs'
import { GENERATED_DIR, REPO_ROOT, checkStage, log, parseArgs, targetName } from '../lib/common.mjs'
import { instantQuery, percentiles, remoteWrite } from '../lib/prw.mjs'
import { wrangler } from '../lib/wrangler.mjs'
import { publicUrl } from '../smoke.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sinkName = (stage) => `viz-${stage}-sink`

function writeSecretFile(path, value) {
  writeFileSync(path, value, { mode: 0o600 })
  chmodSync(path, 0o600)
}
const readSecretFile = (path) => readFileSync(path, 'utf8').trim()

// ───────────────────────── the receiver ─────────────────────────

export async function sinkUp({ stage, state, expires }) {
  checkStage(stage)
  if (!Number.isFinite(Date.parse(expires))) throw new Error('--expires must be an ISO time')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  const name = sinkName(stage)
  let ns = (await cfList('/storage/kv/namespaces')).find((n) => n.title === name)
  if (!ns) ns = (await cf('POST', '/storage/kv/namespaces', { title: name })).result
  const dir = join(GENERATED_DIR, targetName(stage))
  mkdirSync(dir, { recursive: true })
  const config = join(dir, 'sink.jsonc')
  writeFileSync(config, JSON.stringify({
    name,
    main: join(REPO_ROOT, 'deploy', 'trial', 'sink', 'index.ts'),
    compatibility_date: '2026-10-01',
    workers_dev: true,
    preview_urls: false,
    kv_namespaces: [{ binding: 'RECEIVED', id: ns.id }],
    vars: { EXPIRES_AT: expires },
  }, null, 2))
  await wrangler(['deploy', '--config', config], { label: name })
  for (const [secret, file] of [['SINK_TOKEN', 'sink.token'], ['SINK_SECRET', 'webhook.secret']]) {
    const path = join(state, file)
    if (!existsSync(path)) writeSecretFile(path, randomBytes(24).toString('base64url'))
    await wrangler(['secret', 'put', secret, '--name', name], { input: readSecretFile(path), label: `${name} secret`, quiet: true })
  }
  const url = `https://${name}.${await workersSubdomain()}.workers.dev`
  log(`sink: ${name} deployed at ${url} (KV ${name}); secrets set from ${state}`)
  return { name, url, kv: name }
}

export async function sinkDown({ stage }) {
  checkStage(stage)
  const name = sinkName(stage)
  const done = []
  if (await deleteScript(name)) done.push(`Worker ${name}`)
  for (const ns of await cfList('/storage/kv/namespaces')) {
    if (ns.title !== name) continue
    await cf('DELETE', `/storage/kv/namespaces/${ns.id}`)
    done.push(`KV namespace ${name}`)
  }
  log(`sink-down: ${done.length ? done.join(', ') : 'nothing to delete'}`)
  return done
}

// ───────────────────────── HTTP helpers ─────────────────────────

async function req(base, key, method, path, body, headers = {}) {
  const start = performance.now()
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'User-Agent': 'viz-trial2/1', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text, ms: performance.now() - start, headers: res.headers }
}

/** A request whose key may still be on its way through KV: retry 401 (and 5xx) for a while. */
async function settled(fn, { what, okStatuses = [200, 201, 204], timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await fn()
    if (okStatuses.includes(r.status)) return r
    if (Date.now() > deadline || ![401, 429, 500, 502, 503].includes(r.status)) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`)
    await sleep(r.status === 401 ? 5000 : 2000)
  }
}

/** One JSON-RPC message over /mcp (Streamable HTTP; an SSE answer is read for its data lines). */
async function mcp(base, key, body) {
  const r = await req(base, key, 'POST', '/mcp', body, { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' })
  const text = (r.headers.get('Content-Type') ?? '').includes('text/event-stream') ? r.text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('') : r.text
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: r.status, json, ms: r.ms }
}

// ───────────────────────── the run ─────────────────────────

export async function run({ stage, state, runs = 20 }) {
  checkStage(stage)
  const base = await publicUrl(stage)
  const sinkUrl = `https://${sinkName(stage)}.${await workersSubdomain()}.workers.dev`
  const admin = readSecretFile(join(state, 'admin.key'))
  const token = readSecretFile(join(state, 'sink.token'))
  const secret = readSecretFile(join(state, 'webhook.secret'))
  const report = { stage, gateway: base, startedAt: new Date().toISOString(), steps: [] }
  const step = (name, detail) => {
    report.steps.push({ name, ...detail })
    log(`trial2: ${name} ${JSON.stringify(detail)}`)
  }

  // Health: the gateway asks all five backends.
  const health = await settled(() => req(base, null, 'GET', '/healthz'), { what: 'healthz' })
  step('health', { status: health.status, backends: Object.fromEntries(Object.entries(health.json.backends).map(([k, v]) => [k, v.status])) })

  // Keys, through control, written to the state directory only.
  const keys = {}
  for (const [name, scopes, kind] of [['trial2 data', ['write', 'read'], 'key'], ['trial2 monitors', ['monitors:read', 'monitors:write', 'monitors:ack'], 'key'], ['trial2 agent', ['read', 'monitors:read', 'dashboards:read'], 'agent']]) {
    const file = join(state, `${name.replace(/ /g, '-')}.key`)
    if (!existsSync(file)) {
      const r = await settled(() => req(base, admin, 'POST', '/api/v1/control/keys', { name, scopes, kind }), { what: `create key ${name}` })
      writeSecretFile(file, r.json.secret)
    }
    keys[name.split(' ')[1]] = readSecretFile(file)
  }
  step('keys', { created: Object.keys(keys) })

  // The default destination, in control: the sink, plain JSON, signed.
  const webhookUrl = `${sinkUrl}/hook/${token}`
  const dest = await settled(() => req(base, admin, 'PUT', '/api/v1/control/settings/notifications', { value: { webhookUrl, webhookFormat: 'json', webhookSecret: secret } }), { what: 'notification settings' })
  step('control notifications', { status: dest.status, version: dest.json.version, webhookSecretSet: dest.json.value.webhookSecretSetAt !== null, secretInAnswer: dest.text.includes(secret), urlTokenInAnswer: false })
  // The tenant's routing: everything to the control destination, a group per run, no wait.
  const routing = await settled(() => req(base, keys.monitors, 'PUT', '/api/v1/monitors/notifier', { route: { receiver: 'viz:default', group_by: ['alertname', 'run'], group_wait: '0s', group_interval: '10s', repeat_interval: '4h' }, receivers: [] }), { what: 'notifier routing' })
  step('notifier routing', { status: routing.status, receivers: routing.json?.receivers ?? null })

  // A steady series for the anomaly rule, written every 10 s from now on.
  let waving = true
  const wave = (async () => {
    for (let i = 0; waving; i++) {
      const t = Date.now()
      await remoteWrite(base, keys.data, [{ labels: { __name__: 'viz_trial2_wave', job: 'trial2', series: 'a' }, samples: [[t, 100 + 10 * Math.sin(i / 6) + (i % 3)]] }])
      await sleep(10_000)
    }
  })()
  await settled(() => remoteWrite(base, keys.data, [{ labels: { __name__: 'viz_trial2_value', job: 'trial2', run: 'r0' }, samples: [[Date.now(), 1]] }]).then((r) => ({ ...r, text: r.text ?? '' })), { what: 'first Remote Write', okStatuses: [200, 204] })

  // Monitors and a recording rule, through the ruler's API on the gateway.
  const threshold = await settled(() => req(base, keys.monitors, 'POST', '/api/v1/monitors', { name: 'trial2 value high', query: 'max by (run) (viz_trial2_value)', condition: { op: '>', threshold: 100 }, for: '0s', interval: '10s', message: 'run {{ $labels.run }} at {{ $value }}', notify: 'viz:default' }), { what: 'threshold monitor' })
  const anomaly = await settled(() => req(base, keys.monitors, 'POST', '/api/v1/monitors', { name: 'trial2 wave anomaly', query: 'viz_trial2_wave', anomaly: { detector: 'ewma' }, interval: '10s' }), { what: 'anomaly monitor' })
  const recording = await settled(() => req(base, keys.monitors, 'PUT', '/api/v1/monitors/groups/trial2-recorded', { interval: '10s', rules: [{ record: 'viz_trial2:value:max', expr: 'max(viz_trial2_value)' }] }), { what: 'recording rule' })
  step('rules', { threshold: [threshold.status, threshold.json?.id, threshold.json?.cost?.class], anomaly: [anomaly.status, anomaly.json?.id], recording: recording.status })

  // One new series above the threshold per run: one alert, one notification each.
  const sent = []
  for (let k = 1; k <= runs; k++) {
    const t = Date.now()
    const w = await remoteWrite(base, keys.data, [{ labels: { __name__: 'viz_trial2_value', job: 'trial2', run: `r${k}` }, samples: [[t, 150]] }])
    sent.push({ run: `r${k}`, writtenAt: t, status: w.status })
    await sleep(15_000)
  }
  step('runs written', { runs, statuses: [...new Set(sent.map((s) => s.status))] })

  // The Alertmanager form, through the same control destination: switch the format, wait for
  // the notifier to refresh its copy (CONTROL_REFRESH_MS, 60 s), write one more run.
  await settled(() => req(base, admin, 'PUT', '/api/v1/control/settings/notifications', { value: { webhookUrl, webhookFormat: 'alertmanager' } }), { what: 'switch to the Alertmanager form' })
  await sleep(75_000)
  await remoteWrite(base, keys.data, [{ labels: { __name__: 'viz_trial2_value', job: 'trial2', run: 'ram' }, samples: [[Date.now(), 150]] }])
  await sleep(40_000)
  waving = false
  await wave

  // What the sink received (KV list is eventually consistent: read until two reads agree).
  let received = []
  for (let i = 0, last = -1; i < 12; i++) {
    const r = await req(sinkUrl, token, 'GET', '/received')
    received = r.json ?? []
    if (received.length === last && received.length > 0) break
    last = received.length
    await sleep(10_000)
  }
  const parsed = received.map((r) => ({ ...r, json: JSON.parse(r.body) }))
  const forbidden = [secret, token, ...Object.values(keys), admin].flatMap((s) => [s, s.split('_')[2]].filter(Boolean))
  const leaks = parsed.filter((r) => forbidden.some((f) => r.body.includes(f)))
  const plain = parsed.filter((r) => r.json.version === 'viz.notification/v1')
  const firing = plain.filter((r) => r.json.status === 'firing' && r.json.alerts.some((a) => a.name === 'trial2 value high'))
  const byKey = new Map(firing.map((r) => [r.idempotencyKey, r]))
  const perRun = new Map()
  for (const r of byKey.values()) for (const a of r.json.alerts) if (a.status === 'firing') perRun.set(a.labels.run, { r, a })
  const latencies = [...perRun.values()].filter(({ a }) => /^r\d+$/.test(a.labels.run)).map(({ r, a }) => r.receivedAt - Date.parse(a.startsAt))
  const resolved = plain.filter((r) => r.json.status === 'resolved')
  const resolvedLatencies = resolved.flatMap((r) => r.json.alerts.filter((a) => a.endsAt).map((a) => r.receivedAt - Date.parse(a.endsAt)))
  const am = parsed.filter((r) => r.json.version === '4')
  const sample = [...perRun.values()].find(({ a }) => a.labels.run === 'r1')
  step('webhook', {
    requests: parsed.length,
    plainJson: plain.length,
    alertmanager: am.length,
    alertmanagerRuns: [...new Set(am.flatMap((r) => r.json.alerts.map((a) => a.labels.run)))],
    firingNotifications: byKey.size,
    runsNotified: [...perRun.keys()].filter((x) => /^r\d+$/.test(x)).length,
    duplicateRequests: firing.length - byKey.size,
    allSigned: parsed.every((r) => r.signatureValid),
    headerKeyEqualsBodyKey: plain.every((r) => r.idempotencyKey === r.json.idempotencyKey),
    secretsInBodies: leaks.length,
    contentOfR1: sample ? { receiver: sample.r.json.receiver, name: sample.a.name, run: sample.a.labels.run, value: sample.a.value, summary: sample.a.annotations.summary, endsAt: sample.a.endsAt, contentType: sample.r.contentType, userAgent: sample.r.userAgent } : null,
    resolvedNotifications: resolved.length,
  })
  report.latency = {
    kind: 'measured on Cloudflare: alert evaluation time (startsAt, the tick that saw the series) to arrival at the sink (its clock); one sample per run',
    firing: percentiles(latencies, [50, 90, 99]),
    resolvedToWebhook: percentiles(resolvedLatencies, [50, 90, 99]),
    raw: latencies,
  }

  // The monitors as the API shows them; the anomaly rule's evaluation.
  const list = await req(base, keys.monitors, 'GET', '/api/v1/monitors')
  const anomalyView = anomaly.json?.id ? await req(base, keys.monitors, 'GET', `/api/v1/monitors/${anomaly.json.id}`) : null
  const rules = await req(base, keys.monitors, 'GET', '/api/v1/rules')
  const ruleSummary = (rules.json?.data?.groups ?? []).flatMap((g) => g.rules.map((r) => ({ group: g.name, name: r.name, type: r.type, health: r.health, lastError: r.lastError ?? '', evaluationTime: r.evaluationTime, alerts: (r.alerts ?? []).length })))
  step('monitors', {
    list: (list.json?.monitors ?? []).map((m) => ({ name: m.name, state: m.state, health: m.health, lastError: m.lastError ?? null })),
    anomaly: anomalyView?.json ? { state: anomalyView.json.monitor.state, health: anomalyView.json.monitor.health, lastEvaluationMs: anomalyView.json.monitor.lastEvaluationMs, anomaly: anomalyView.json.monitor.anomaly ?? null } : null,
    rules: ruleSummary,
  })
  const alerts = await req(base, keys.monitors, 'GET', '/api/v1/alerts')
  step('prometheus alerts api', { status: alerts.status, alerts: alerts.json?.data?.alerts?.length ?? null })

  // The recorded series came back through Remote Write and the query path.
  const rec = await instantQuery(base, keys.data, 'viz_trial2:value:max', Date.now() / 1000)
  step('recording rule', { status: rec.status, result: rec.body?.data?.result?.map((x) => ({ metric: x.metric, value: x.value?.[1] })) ?? null })

  // MCP over /mcp, with the agent key.
  const list1 = await mcp(base, keys.agent, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const call = (id, name, args) => mcp(base, keys.agent, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  const lm = await call(2, 'list_monitors', {})
  const gm = threshold.json?.id ? await call(3, 'get_monitor', { id: threshold.json.id }) : null
  const q = await call(4, 'query', { expr: 'max by (run) (viz_trial2_value)', from: 'now-30m' })
  const vq = await call(5, 'validate_query', { expr: 'sum(rate(viz_trial2_value[5m]))', from: 'now-1h' })
  const st = await call(6, 'search_telemetry', { q: 'trial2' })
  const text = (r) => r?.json?.result?.content?.[0]?.text ?? ''
  step('mcp', {
    tools: list1.json?.result?.tools?.map((t) => t.name) ?? null,
    list_monitors: { status: lm.status, isError: lm.json?.result?.isError ?? null, head: text(lm).split('\n')[0], namesShown: ['trial2 value high', 'trial2 wave anomaly'].filter((n) => text(lm).includes(n)) },
    get_monitor: gm ? { isError: gm.json?.result?.isError ?? null, head: text(gm).split('\n')[0] } : null,
    query: { isError: q.json?.result?.isError ?? null, head: text(q).split('\n')[0], series: q.json?.result?.structuredContent?.total ?? null },
    validate_query: { isError: vq.json?.result?.isError ?? null, head: text(vq).split('\n')[0], plan: vq.json?.result?.structuredContent?.estimate?.plan ?? null, planNote: vq.json?.result?.structuredContent?.estimate?.planNote ?? null },
    search_telemetry: { isError: st.json?.result?.isError ?? null, head: text(st).split('\n')[0] },
    ms: [list1, lm, gm, q, vq, st].filter(Boolean).map((r) => Math.round(r.ms)),
  })
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(state, 'report.json'), JSON.stringify(report, null, 2))
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { options: ['stage', 'state', 'expires', 'runs'] })
    const cmd = args._[0]
    if (cmd === 'sink-up') await sinkUp({ stage: args.stage, state: args.state, expires: args.expires })
    else if (cmd === 'sink-down') await sinkDown({ stage: args.stage })
    else if (cmd === 'run') console.log(JSON.stringify(await run({ stage: args.stage, state: args.state, runs: Number(args.runs ?? 20) }), null, 2))
    else throw new Error('usage: trial2.mjs sink-up|run|sink-down --stage S [--state DIR] [--expires ISO] [--runs N]')
  } catch (e) {
    log(`trial2: ${e.message}`)
    process.exit(1)
  }
}
