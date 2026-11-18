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

const dev = spawn('npx', ['wrangler', 'dev', '--config', 'test/conformance/wrangler.jsonc', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, '--log-level', 'warn'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  const out = join(state, 'results')
  try {
    const text = execFileSync('npx', ['conformance', 'server', '--url', `http://127.0.0.1:${PORT}/mcp`, '--suite', 'all', '-o', out], { cwd: root, env, encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(text)
  } catch (e) {
    console.log(e.stdout ?? '')
    console.log(e.stderr ?? '')
    code = 1
  }
} finally {
  dev.kill('SIGTERM')
  rmSync(state, { recursive: true, force: true })
}
process.exit(code)
