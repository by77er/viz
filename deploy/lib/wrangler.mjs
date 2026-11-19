// Runs the wrangler pinned in deploy/package.json and reads its structured output
// (WRANGLER_OUTPUT_FILE_PATH: one JSON object per line, e.g. {"type":"version-upload",
// "version_id":…}). Secrets go in on stdin only.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEPLOY_DIR } from './common.mjs'

export const WRANGLER = join(DEPLOY_DIR, 'node_modules', '.bin', 'wrangler')

/**
 * Forced on every run that hands wrangler something on stdin (a secret: `versions secret put`,
 * bootstrap's `secret put`), whatever the deploy's own environment says. Wrangler 4.164.0 writes
 * every log level, request bodies included, to a debug log file (`~/.config/.wrangler/logs/`, or
 * WRANGLER_LOG_PATH) unless WRANGLER_WRITE_LOGS is false, and redacts bodies only while
 * WRANGLER_LOG_SANITIZE is true: with sanitising off, the secret's PATCH body was in that file
 * (review of D53, m-10, reproduced with the real wrangler).
 */
export const SECRET_RUN_ENV = Object.freeze({ WRANGLER_LOG_SANITIZE: 'true', WRANGLER_WRITE_LOGS: 'false' })

/** The pinned wrangler, unless VIZ_WRANGLER_BIN names another (the tests' fake: test/secrets.test.mjs). */
const wranglerBin = () => process.env.VIZ_WRANGLER_BIN || WRANGLER

/**
 * Run wrangler. Its output is passed through to stderr (prefixed), so CI logs show it; it is
 * also returned. `input` is written to stdin and never logged.
 */
export function wrangler(args, { input, quiet = false, label = 'wrangler' } = {}) {
  const bin = wranglerBin()
  if (!existsSync(bin)) throw new Error(`${bin} not found: run npm ci in deploy/`)
  const dir = mkdtempSync(join(tmpdir(), 'viz-wrangler-'))
  const outFile = join(dir, 'output.jsonl')
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: DEPLOY_DIR,
      env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outFile, WRANGLER_SEND_METRICS: 'false', CI: process.env.CI ?? 'true', FORCE_COLOR: '0', ...(input !== undefined ? SECRET_RUN_ENV : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    const relay = (chunk) => {
      const s = chunk.toString()
      out += s
      if (!quiet) for (const line of s.split('\n')) if (line.trim() && !/Proxy environment variables detected/.test(line)) process.stderr.write(`  [${label}] ${line}\n`)
    }
    child.stdout.on('data', relay)
    child.stderr.on('data', relay)
    child.on('error', reject)
    child.on('close', (code) => {
      let entries = []
      try {
        entries = existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      if (code === 0) resolve({ out, entries })
      else {
        const err = new Error(`wrangler ${args[0]} ${args[1] ?? ''} exited ${code}`)
        err.out = out
        err.entries = entries
        reject(err)
      }
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** The version id wrangler reported, from the output file, else from its text. */
export function versionIdFrom({ entries, out }, type) {
  const e = entries.find((x) => x.type === type && x.version_id)
  if (e) return e.version_id
  const m = /(?:Worker Version ID|Current Version ID):\s*([0-9a-f-]{36})/i.exec(out)
  if (m) return m[1]
  throw new Error(`could not find the version id in wrangler's output (${type})`)
}
