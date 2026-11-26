// Drives the spike Worker (worker.ts) from outside: starts one job at a time and waits for its
// result, which the Worker's driver object writes to R2.
//
//   S11_URL=https://… S11_KEYFILE=/path/key node driver.mjs [--out DIR] job '{"op":"fill",…}'
//   … driver.mjs status [G0|R16|…]      logStatus of a ledger (a replica starts a rebuild: careful)
//   … driver.mjs log                    the tenant's ledger log in R2, by incarnation
//   … driver.mjs list PREFIX            object count and bytes under a prefix
//   … driver.mjs purge [PREFIX]         delete every object (under PREFIX), repeatedly until empty
//
// The key (the Worker's secret) is read from S11_KEYFILE and only ever sent in the x-key header.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const URL_ = process.env.S11_URL
const KEY = readFileSync(process.env.S11_KEYFILE, 'utf8').trim()
if (!URL_ || !KEY) throw new Error('S11_URL and S11_KEYFILE')
const args = process.argv.slice(2)
let out = '.'
if (args[0] === '--out') {
  out = args[1]
  args.splice(0, 2)
}
mkdirSync(out, { recursive: true })

async function call(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${URL_}${path}`, { method, headers: { 'x-key': KEY, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
      const text = await r.text()
      return { status: r.status, json: text ? JSON.parse(text) : null }
    } catch (e) {
      if (attempt >= 4) throw e
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)))
    }
  }
}

const [cmd, ...rest] = args
if (cmd === 'job') {
  const job = JSON.parse(rest[0])
  const t0 = Date.now()
  const s = await call('POST', '/job', job)
  if (s.status !== 200) throw new Error(`start: ${s.status} ${JSON.stringify(s.json)}`)
  const id = s.json.id
  console.error(`${new Date().toISOString()} job ${id} started`)
  const limitMs = Number(process.env.S11_WAIT_MS ?? 20 * 60_000)
  for (;;) {
    await new Promise((res) => setTimeout(res, 3000))
    const r = await call('GET', `/result?id=${encodeURIComponent(id)}`)
    if (r.status === 200) {
      const file = join(out, `${id}.json`)
      writeFileSync(file, JSON.stringify({ ...r.json, outsideMs: Date.now() - t0 }, null, 1) + '\n')
      const o = r.json.out ?? {}
      const brief = Object.fromEntries(Object.entries(o).filter(([k]) => !['timeline', 'batches', 'probes', 'ops', 'ckptOps', 'opTimeline', 'log', 'result'].includes(k)))
      console.log(JSON.stringify({ id, file, ...brief }, null, 1).slice(0, 4000))
      break
    }
    if (Date.now() - t0 > limitMs) throw new Error(`no result for ${id} after ${limitMs} ms`)
  }
} else if (cmd === 'status') {
  console.log(JSON.stringify((await call('GET', `/status?gen=${rest[0] ?? 'G0'}`)).json, null, 1))
} else if (cmd === 'log') {
  console.log(JSON.stringify((await call('GET', '/log')).json, null, 1))
} else if (cmd === 'list') {
  console.log(JSON.stringify((await call('GET', `/list?prefix=${encodeURIComponent(rest[0] ?? '')}`)).json))
} else if (cmd === 'purge') {
  let total = 0
  for (let i = 0; i < 200; i++) {
    const r = await call('POST', `/purge?prefix=${encodeURIComponent(rest[0] ?? '')}`)
    if (r.status !== 200) throw new Error(`purge: ${r.status} ${JSON.stringify(r.json)}`)
    total += r.json.deleted
    if (r.json.empty) break
  }
  console.log(JSON.stringify({ deleted: total }))
} else {
  throw new Error(`unknown command ${cmd}`)
}
