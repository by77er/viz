#!/usr/bin/env node
/**
 * Runs the official MCP conformance suite (@modelcontextprotocol/conformance) against this
 * server under `wrangler dev`, locally (miniflare; nothing touches a Cloudflare account).
 * Port 8921. Starts and stops only the processes it starts itself.
 *
 *   node scripts/conformance.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8921
const state = mkdtempSync(join(tmpdir(), 'viz-mcp-conformance-'))
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }
delete env.CLOUDFLARE_API_TOKEN // local only: never authenticate to the account
delete env.CLOUDFLARE_ACCOUNT_ID

// Its own process group, so that stopping it stops wrangler and workerd too, not only npx.
const dev = spawn('npx', ['wrangler', 'dev', '--config', 'test/conformance/wrangler.jsonc', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, '--log-level', 'warn'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
let log = ''
dev.stdout.on('data', (d) => (log += d))
dev.stderr.on('data', (d) => (log += d))

async function ready() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('wrangler dev did not start:\n' + log.slice(-3000))
}

let code = 0
try {
  await ready()
  const out = process.env.CONFORMANCE_OUT ?? join(state, 'results')
  try {
    const text = execFileSync('npx', ['conformance', 'server', '--url', `http://127.0.0.1:${PORT}/mcp`, '--suite', 'all', '-o', out], { cwd: root, env, encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(text)
  } catch (e) {
    console.log(e.stdout ?? '')
    console.log(e.stderr ?? '')
    code = 1
  }
  // Every failed check with its reason, so expected failures (fixtures this server does not
  // have) can be told from real ones.
  const { readdirSync, readFileSync, existsSync } = await import('node:fs')
  if (existsSync(out)) {
    for (const dir of readdirSync(out).sort()) {
      const f = join(out, dir, 'checks.json')
      if (!existsSync(f)) continue
      for (const c of JSON.parse(readFileSync(f, 'utf8'))) {
        if (c.status !== 'SUCCESS' && c.status !== 'INFO') console.log(`${dir.replace(/^server-/, '').replace(/-\d{4}-.*$/, '')}\t${c.status}\t${c.name ?? c.id}\t${String(c.errorMessage ?? c.description ?? '').slice(0, 220)}`)
      }
    }
  }
} finally {
  try {
    process.kill(-dev.pid, 'SIGTERM')
  } catch {}
  await new Promise((r) => setTimeout(r, 2000))
  try {
    process.kill(-dev.pid, 'SIGKILL')
  } catch {}
  rmSync(state, { recursive: true, force: true })
}
process.exit(code)
