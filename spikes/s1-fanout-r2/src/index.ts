// Spike S1: how much runs in parallel from one Worker invocation, and how fast are R2 range reads?
//   /seed                      writes one 32 MiB object of incompressible bytes
//   /r2?n=&bytes=              n parallel range reads through the R2 binding, from one invocation
//   /fan?n=&mode=&wait=        n parallel calls to this Worker through a service binding; each leaf waits `wait` ms
//                              mode=late: leaf responds after waiting; mode=early: leaf sends headers first, then waits
//   /do?n=&wait=               n parallel calls to n different Durable Objects, each waits `wait` ms
//   /latency?n=&bytes=&hedge=  n sequential range reads at random offsets; optional hedge after `hedge` ms
// Wall-clock in a Worker only advances across I/O, which is all that is timed here.
import { DurableObject } from 'cloudflare:workers'

interface Env { BUCKET: R2Bucket; SELF: Fetcher; WAITER: DurableObjectNamespace<Waiter>; KEY: string }
const OBJ = 'blob-32m', SIZE = 32 * 1024 * 1024

export class Waiter extends DurableObject<Env> {
  async wait(ms: number): Promise<number> { await scheduler.wait(ms); return Date.now() }
  async read(per: number, bytes: number): Promise<{ ttfb: number; total: number }[]> { return Promise.all(Array.from({ length: per }, () => rangeRead(this.env, bytes))) }
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p90: pct(xs, 90), p99: pct(xs, 99), max: Math.max(...xs) })

async function rangeRead(env: Env, bytes: number): Promise<{ ttfb: number; total: number }> {
  const offset = Math.floor(Math.random() * (SIZE - bytes))
  const t0 = Date.now()
  const o = await env.BUCKET.get(OBJ, { range: { offset, length: bytes } })
  const t1 = Date.now()
  const buf = await o!.arrayBuffer()
  if (buf.byteLength !== bytes) throw new Error('short read')
  return { ttfb: t1 - t0, total: Date.now() - t0 }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url), q = (k: string, d: number) => Number(url.searchParams.get(k) ?? d)
    if (url.pathname === '/leaf') { // called through the service binding; no key needed from outside because SELF is internal
      const wait = q('wait', 200)
      if (url.searchParams.get('mode') === 'r2') { // each leaf does `per` range reads of its own
        const rs = await Promise.all(Array.from({ length: q('per', 1) }, () => rangeRead(env, q('bytes', 65536))))
        return Response.json(rs)
      }
      if (url.searchParams.get('mode') === 'early') {
        const { readable, writable } = new TransformStream()
        const w = writable.getWriter()
        ;(async () => { await scheduler.wait(wait); await w.write(new TextEncoder().encode('done')); await w.close() })()
        return new Response(readable)
      }
      await scheduler.wait(wait)
      return new Response('done')
    }
    if (req.headers.get('x-key') !== env.KEY) return new Response('not found', { status: 404 })
    const colo = (req as unknown as { cf?: { colo?: string } }).cf?.colo
    if (url.pathname === '/seed') {
      const chunk = new Uint8Array(1024 * 1024)
      const up = await env.BUCKET.createMultipartUpload(OBJ)
      const parts: R2UploadedPart[] = []
      for (let i = 0; i < 4; i++) {
        const part = new Uint8Array(8 * 1024 * 1024)
        for (let j = 0; j < 8; j++) { for (let k = 0; k < chunk.length; k += 65536) crypto.getRandomValues(chunk.subarray(k, k + 65536)); part.set(chunk, j * chunk.length) }
        parts.push(await up.uploadPart(i + 1, part))
      }
      await up.complete(parts)
      return Response.json({ seeded: SIZE, colo })
    }
    if (url.pathname === '/r2') {
      const n = q('n', 6), bytes = q('bytes', 65536)
      const t0 = Date.now()
      const rs = await Promise.all(Array.from({ length: n }, () => rangeRead(env, bytes)))
      return Response.json({ colo, n, bytes, wall: Date.now() - t0, ttfb: summary(rs.map((r) => r.ttfb)), total: summary(rs.map((r) => r.total)) })
    }
    if (url.pathname === '/fan') {
      const n = q('n', 6), wait = q('wait', 200), mode = url.searchParams.get('mode') ?? 'late'
      const t0 = Date.now()
      const headers: number[] = [], reads: number[] = []
      await Promise.all(Array.from({ length: n }, async () => {
        const r = await env.SELF.fetch(`https://self/leaf?wait=${wait}&mode=${mode}&per=${q('per', 1)}&bytes=${q('bytes', 65536)}`)
        headers.push(Date.now() - t0)
        const body = await r.text()
        if (mode === 'r2') for (const x of JSON.parse(body) as { ttfb: number }[]) reads.push(x.ttfb)
      }))
      return Response.json({ colo, n, wait, mode, wall: Date.now() - t0, headersAt: summary(headers), leafReadTtfb: reads.length ? summary(reads) : null })
    }
    if (url.pathname === '/do') {
      const n = q('n', 6), wait = q('wait', 200)
      const t0 = Date.now()
      const done: number[] = []
      await Promise.all(Array.from({ length: n }, async (_, i) => { await env.WAITER.get(env.WAITER.idFromName(`w${i}`)).wait(wait); done.push(Date.now() - t0) }))
      return Response.json({ colo, n, wait, wall: Date.now() - t0, doneAt: summary(done) })
    }
    if (url.pathname === '/doread' || url.pathname === '/pubread') { // leaves that are Durable Objects, or separate top-level requests to this Worker's public URL
      const n = q('n', 6), per = q('per', 1), bytes = q('bytes', 65536)
      const t0 = Date.now(), reads: number[] = []
      let failed = 0
      await Promise.all(Array.from({ length: n }, async (_, i) => {
        try {
          const rs = url.pathname === '/doread'
            ? await env.WAITER.get(env.WAITER.idFromName(`w${i}`)).read(per, bytes)
            : ((await (await fetch(`${url.origin}/leafpub?per=${per}&bytes=${bytes}`, { headers: { 'x-key': env.KEY } })).json()) as { ttfb: number }[])
          for (const x of rs) reads.push(x.ttfb)
        } catch { failed++ }
      }))
      return Response.json({ colo, n, per, bytes, failed, wall: Date.now() - t0, leafReadTtfb: reads.length ? summary(reads) : null })
    }
    if (url.pathname === '/leafpub') return Response.json(await Promise.all(Array.from({ length: q('per', 1) }, () => rangeRead(env, q('bytes', 65536)))))
    if (url.pathname === '/latency') {
      const n = Math.min(300, q('n', 100)), bytes = q('bytes', 65536), hedge = q('hedge', 0)
      const ttfb: number[] = [], total: number[] = []
      let hedged = 0
      for (let i = 0; i < n; i++) {
        if (!hedge) { const r = await rangeRead(env, bytes); ttfb.push(r.ttfb); total.push(r.total); continue }
        const t0 = Date.now()
        const first = rangeRead(env, bytes)
        const winner = await Promise.race([first, scheduler.wait(hedge).then(() => null)])
        if (winner) { total.push(winner.total); continue }
        hedged++
        await Promise.race([first, rangeRead(env, bytes)])
        total.push(Date.now() - t0)
      }
      return Response.json({ colo, n, bytes, hedge, hedged, ttfb: ttfb.length ? summary(ttfb) : null, total: summary(total) })
    }
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
