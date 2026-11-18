// Load generator for the deployed ingest path. Each request is a real Remote Write body:
// SERIES series x 1 sample, one target (job, instance) per request so it routes to one shard.
import { createHash, randomBytes } from 'node:crypto'
import { writeRequest, snappyCompress } from './codec'
const [url, mode, a, b] = process.argv.slice(2)
if (mode === 'key') { // print a key record for KV:  tenant -> {keyId, key, record}
  const keyId = randomBytes(6).toString('hex'), secret = randomBytes(24).toString('base64url')
  console.log(JSON.stringify({ kvKey: `key:${keyId}`, record: { tenant: a, secretSha256: createHash('sha256').update(secret).digest('hex'), scopes: ['write'] }, key: `viz_${keyId}_${secret}` }))
  process.exit(0)
}
const key = a, SERIES = Number(process.env.SERIES ?? 200)
const body = (i: number, t: number) => snappyCompress(writeRequest(Array.from({ length: SERIES }, (_, s) => ({
  labels: [['__name__', `load_metric_${s % 20}`], ['instance', 'load-0'], ['job', 'loadgen'], ['series', String(s)]] as [string, string][],
  samples: [{ ts: t + i, value: Math.random() * 100 }],
}))))
const pct = (xs: number[], p: number) => xs.sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * p / 100))]
async function run(conc: number, seconds: number) {
  const lat: number[] = [], status: Record<string, number> = {}
  const end = Date.now() + seconds * 1000
  let i = 0
  const t0 = Date.now()
  await Promise.all(Array.from({ length: conc }, async () => {
    while (Date.now() < end) {
      const b = body(i++, Date.now())
      const s = performance.now()
      const r = await fetch(url + '/api/v1/write', { method: 'POST', body: b, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy', 'x-prometheus-remote-write-version': '0.1.0' } })
      await r.arrayBuffer()
      lat.push(performance.now() - s); status[r.status] = (status[r.status] ?? 0) + 1
    }
  }))
  const secs = (Date.now() - t0) / 1000
  console.log(JSON.stringify({ conc, seconds: +secs.toFixed(1), requests: lat.length, rps: +(lat.length / secs).toFixed(1), samples_per_s: Math.round(lat.length * SERIES / secs), bodyBytes: body(0, 0).length, status, p50: +pct(lat, 50).toFixed(0), p90: +pct(lat, 90).toFixed(0), p99: +pct(lat, 99).toFixed(0) }))
}
if (mode === 'ping') { const lat: number[] = []; for (let i = 0; i < 40; i++) { const s = performance.now(); await (await fetch(url + '/healthz')).arrayBuffer(); lat.push(performance.now() - s) } console.log(JSON.stringify({ healthz_p50: +pct(lat, 50).toFixed(0), p99: +pct(lat, 99).toFixed(0) })) }
else for (const c of b.split(',').map(Number)) await run(c, Number(process.env.SECS ?? 15))
