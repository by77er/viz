// viz-s10-load-client: the S10 trial's load Worker. Each client is its own Durable Object
// (`Client`) that sends requests to the stage's gateway through a service binding (`GATEWAY` →
// viz-s10-gateway), one after another, and reports what it saw. The driver (../driver.mjs) only
// starts operations and collects results; nothing it sends reaches the system under test.
//
// Every route needs the `x-key` header (LOAD_KEY, a secret generated at deploy time and set with
// `wrangler secret put` on stdin). The tenants' API keys are the secret TENANT_KEYS (JSON
// `{tenant: key}`), never returned. Nothing runs on a timer: no alarm, no cron. After DEADLINE
// (a var, at most 3 hours after deploy) every request is refused.
import { DurableObject } from 'cloudflare:workers'
import snappy from 'snappyjs'
import * as B from './bodies.mjs'

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = new TextEncoder()
const dec = new TextDecoder()

async function sameSecret(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))))
  return crypto.subtle.timingSafeEqual(x, y)
}

export default {
  async fetch(req, env) {
    if (!(Date.now() < Date.parse(env.DEADLINE))) return json({ error: `past the deadline ${env.DEADLINE}` }, 410)
    if (!env.LOAD_KEY || !(await sameSecret(req.headers.get('x-key') ?? '', env.LOAD_KEY))) return new Response('not found', { status: 404 })
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const text = await req.text()
    let op
    try {
      op = JSON.parse(text)
    } catch {
      return json({ error: 'body is not JSON' }, 400)
    }
    if (typeof op.client !== 'string' || op.client.length > 64) return json({ error: 'client: a name' }, 400)
    const stub = env.CLIENT.get(env.CLIENT.idFromName(op.client))
    return stub.fetch('https://client/', { method: 'POST', body: text })
  },
}

async function gzip(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
}
async function gunzip(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
}
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** OTLP partial_success from a protobuf answer: { rejected, message }, or null. */
function partialProto(bytes) {
  let p = 0
  const varint = () => {
    let v = 0
    let m = 1
    for (;;) {
      const b = bytes[p++]
      v += (b & 0x7f) * m
      m *= 128
      if (b < 0x80) return v
    }
  }
  const out = { rejected: 0, message: '' }
  while (p < bytes.length) {
    const tag = varint()
    if (tag !== 0x0a) return null
    const end = varint() + p
    while (p < end) {
      const t = varint()
      if (t === 0x08) out.rejected = varint()
      else if (t === 0x12) {
        const n = varint()
        out.message = dec.decode(bytes.subarray(p, p + n))
        p += n
      } else return out
    }
  }
  return out
}

const VIZ_HEADERS = /^x-viz-/i
const pick = (h) => Object.fromEntries([...h].filter(([k]) => VIZ_HEADERS.test(k) || k === 'retry-after' || k === 'content-type'))

export class Client extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.resources = null
  }

  key(tenant) {
    const k = JSON.parse(this.env.TENANT_KEYS)[tenant]
    if (!k) throw new Error(`no key for tenant ${tenant}`)
    return k
  }

  /** One request through the gateway; the answer read whole. */
  async send(tenant, method, path, headers = {}, body = undefined) {
    const t0 = Date.now()
    const res = await this.env.GATEWAY.fetch(`https://gateway${path}`, { method, headers: { Authorization: `Bearer ${this.key(tenant)}`, 'User-Agent': 'viz-s10-load', ...headers }, body })
    const bytes = new Uint8Array(await res.arrayBuffer())
    const t1 = Date.now()
    return { status: res.status, ms: t1 - t0, at: t1, headers: pick(res.headers), bytes }
  }

  async fetch(req) {
    const op = await req.json()
    const deadline = Date.parse(this.env.DEADLINE)
    try {
      if (op.op === 'ingest') return json(await this.ingest(op, deadline))
      if (op.op === 'markers') return json(await this.markers(op, deadline))
      if (op.op === 'query') return json(await this.query(op, deadline))
      if (op.op === 'raw') return json(await this.raw(op))
      if (op.op === 'rw') return json(await this.rw(op))
      return json({ error: `unknown op ${op.op}` }, 400)
    } catch (e) {
      return json({ error: String(e && e.stack ? e.stack : e).slice(0, 2000) }, 500)
    }
  }

  /** The body of request `i` of an ingest op: { path, headers, body, items, info }. */
  async body(op, i) {
    const p = op.params ?? {}
    const seed = (op.seed ?? 1) + i
    const nowNs = BigInt(Date.now()) * 1_000_000n
    const t0Ns = p.t0Ms !== undefined ? BigInt(p.t0Ms) * 1_000_000n : nowNs
    const per = p.per ?? 0
    const from = (p.from ?? 0) + i * per
    const gz = async (text) => ({ body: await gzip(typeof text === 'string' ? enc.encode(text) : text), ce: 'gzip' })
    switch (op.gen) {
      case 'traces':
      case 'tracesJson': {
        const t = B.realisticTraces(B.lcg(seed), nowNs)
        const first = t.resource_spans[0].scope_spans[0].spans[0]
        const info = { traceId: [...first.trace_id].map((x) => x.toString(16).padStart(2, '0')).join(''), startNs: String(first.start_time_unix_nano) }
        const json = op.gen === 'tracesJson'
        const { body, ce } = await gz(json ? B.tracesJson(t) : B.tracesProto(t))
        return { path: '/v1/traces', headers: { 'Content-Type': json ? 'application/json' : 'application/x-protobuf', 'Content-Encoding': ce }, body, items: 8200, info }
      }
      case 'logs':
      case 'logsJson': {
        const l = B.realisticLogs(B.lcg(seed), nowNs)
        const json = op.gen === 'logsJson'
        const { body, ce } = await gz(json ? B.logsJson(l) : B.logsProto(l))
        return { path: '/v1/logs', headers: { 'Content-Type': json ? 'application/json' : 'application/x-protobuf', 'Content-Encoding': ce }, body, items: 8200 }
      }
      case 'loki': {
        const k = B.realisticLoki(B.lcg(seed), nowNs)
        return { path: '/loki/api/v1/push', headers: { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy' }, body: snappy.compress(B.lokiProto(k)), items: 8200 }
      }
      case 'lokiJson': {
        const k = B.realisticLoki(B.lcg(seed), nowNs)
        const { body, ce } = await gz(B.lokiJson(k))
        return { path: '/loki/api/v1/push', headers: { 'Content-Type': 'application/json', 'Content-Encoding': ce }, body, items: 8200 }
      }
      case 'richSpans': {
        this.resources ??= B.richResources()
        const { body, ce } = await gz(B.richSpansJson(this.resources, from, per, t0Ns, { fat: Boolean(p.fat), idBase: p.idBase ?? 0 }))
        return { path: '/v1/traces', headers: { 'Content-Type': 'application/json', 'Content-Encoding': ce }, body, items: per }
      }
      case 'richLogs': {
        const { body, ce } = await gz(B.richLogsJson(from, per, t0Ns, seed))
        return { path: '/loki/api/v1/push', headers: { 'Content-Type': 'application/json', 'Content-Encoding': ce }, body, items: per }
      }
      case 'fatSpans': {
        const { body, ce } = await gz(B.fatSpansJson(from, per, t0Ns))
        return { path: '/v1/traces', headers: { 'Content-Type': 'application/json', 'Content-Encoding': ce }, body, items: per }
      }
      case 'fatLogs': {
        const { body, ce } = await gz(B.fatLogsJson(p.job ?? 'a', from, per, t0Ns))
        return { path: '/loki/api/v1/push', headers: { 'Content-Type': 'application/json', 'Content-Encoding': ce }, body, items: per }
      }
    }
    throw new Error(`unknown generator ${op.gen}`)
  }

  /**
   * `requests` requests of generator `gen`, one after another; a 429 or 503 is retried with the
   * same body after its Retry-After (at most `retryCapMs`), up to `attempts` attempts, as a sender
   * would. Stops starting requests after `maxMs`.
   */
  async ingest(op, deadline) {
    const started = Date.now()
    const out = []
    for (let i = 0; i < (op.requests ?? 1); i++) {
      if (Date.now() > deadline || Date.now() - started > (op.maxMs ?? 120_000)) break
      const b = await this.body(op, i)
      const rec = { i, path: b.path, items: b.items, wireBytes: b.body.byteLength, info: b.info, attempts: [] }
      for (let a = 0; a < (op.attempts ?? 8); a++) {
        const r = await this.send(op.tenant, 'POST', b.path, b.headers, b.body)
        const att = { status: r.status, ms: r.ms, at: r.at, retryAfter: r.headers['retry-after'] ?? null }
        const ct = r.headers['content-type'] ?? ''
        if (r.bytes.length) {
          if (ct.includes('protobuf')) att.partial = partialProto(r.bytes)
          else att.text = dec.decode(r.bytes.subarray(0, 600))
        }
        rec.attempts.push(att)
        if ((r.status === 429 || r.status === 503) && a + 1 < (op.attempts ?? 8) && Date.now() < deadline) {
          await sleep(Math.min((Number(r.headers['retry-after']) || 1) * 1000, op.retryCapMs ?? 2000))
          continue
        }
        break
      }
      const last = rec.attempts[rec.attempts.length - 1]
      rec.status = last.status
      rec.ackMs = last.ms
      rec.ackAt = last.at
      out.push(rec)
      if (op.pauseMs) await sleep(op.pauseMs)
    }
    return { client: op.client, gen: op.gen, tenant: op.tenant, started, ended: Date.now(), records: out }
  }

  /** Acknowledgement → queryable: post one marker, then ask for it every `pollMs` until it is answered. */
  async markers(op, deadline) {
    const out = []
    for (let k = 0; k < (op.count ?? 1); k++) {
      if (Date.now() > deadline) break
      const tag = `${op.tag ?? 'm'}-${k}`
      let post
      let ask
      let id
      if (op.kind === 'trace') {
        const m = B.markerTrace(Date.now(), tag)
        id = m.traceId
        post = () => this.send(op.tenant, 'POST', '/v1/traces', { 'Content-Type': 'application/json' }, m.body)
        ask = () => this.send(op.tenant, 'GET', `/api/traces/${m.traceId}`)
      } else {
        const m = B.markerLine(Date.now(), tag)
        id = m.token
        post = () => this.send(op.tenant, 'POST', '/loki/api/v1/push', { 'Content-Type': 'application/json' }, m.body)
        const ns = BigInt(Date.now()) * 1_000_000n
        const q = new URLSearchParams({ query: `{job="marker"} |= "${m.token}"`, start: String(ns - 120_000_000_000n), end: String(ns + 120_000_000_000n), limit: '10', direction: 'backward' })
        ask = () => this.send(op.tenant, 'GET', `/loki/api/v1/query_range?${q}`)
      }
      const p = await post()
      const rec = { kind: op.kind, id, ackStatus: p.status, ackMs: p.ms, ackAt: p.at, polls: 0 }
      if (p.status >= 300) {
        rec.error = dec.decode(p.bytes.subarray(0, 300))
        out.push(rec)
        continue
      }
      for (;;) {
        const r = await ask()
        rec.polls++
        const text = dec.decode(r.bytes)
        const found = r.status === 200 && (op.kind === 'trace' ? text.includes('marker-child') && text.includes('marker-root') : text.includes(id))
        if (found) {
          rec.queryableMs = r.at - p.at
          rec.lastQueryMs = r.ms
          rec.headers = r.headers
          break
        }
        rec.lastStatus = r.status
        if (r.at - p.at > (op.timeoutMs ?? 30_000)) {
          rec.timedOut = true
          rec.lastText = text.slice(0, 300)
          break
        }
        await sleep(op.pollMs ?? 100)
      }
      out.push(rec)
      if (op.pauseMs) await sleep(op.pauseMs)
    }
    return { client: op.client, tenant: op.tenant, records: out }
  }

  /** GET (or POST) `path` `repeat` times; status, time, the X-Viz-* headers, the start of the body. */
  async query(op, deadline) {
    const out = []
    for (let r = 0; r < (op.repeat ?? 1); r++) {
      if (Date.now() > deadline) break
      const x = await this.send(op.tenant, op.method ?? 'GET', op.path, op.headers ?? {}, op.body)
      out.push({ status: x.status, ms: x.ms, at: x.at, headers: x.headers, bodyBytes: x.bytes.length, body: dec.decode(x.bytes.subarray(0, op.keep ?? 400)) })
      if (op.pauseMs) await sleep(op.pauseMs)
    }
    return { client: op.client, tenant: op.tenant, path: op.path, records: out }
  }

  /** One request with a body the driver sent (base64; `gunzip`: it was sent gzipped and goes out raw). */
  async raw(op) {
    let body = op.bodyB64 !== undefined ? b64(op.bodyB64) : undefined
    if (body && op.gunzip) body = await gunzip(body)
    const x = await this.send(op.tenant, op.method ?? 'POST', op.path, op.headers ?? {}, body)
    const ct = x.headers['content-type'] ?? ''
    return { client: op.client, status: x.status, ms: x.ms, headers: x.headers, sentBytes: body?.byteLength ?? 0, partial: ct.includes('protobuf') && x.bytes.length ? partialProto(x.bytes) : null, text: ct.includes('protobuf') ? null : dec.decode(x.bytes.subarray(0, 600)) }
  }

  /** Remote Write: `series` series of one sample each (value = series index), metric `name`, label run. */
  async rw(op) {
    const now = Date.now()
    const series = Array.from({ length: op.series ?? 4 }, (_, i) => ({ labels: { __name__: op.name, run: op.run, s: String(i) }, samples: [[now, i]] }))
    const body = snappy.compress(B.remoteWrite(series))
    const x = await this.send(op.tenant, 'POST', '/api/v1/write', { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy', 'X-Prometheus-Remote-Write-Version': '0.1.0' }, body)
    return { client: op.client, status: x.status, ms: x.ms, at: now, text: dec.decode(x.bytes.subarray(0, 300)) }
  }
}
