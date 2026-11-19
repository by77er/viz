// Shared by the tests that drive release.mjs end to end (secrets.test.mjs, release-checks.test.mjs):
// a fake Cloudflare account. lib/wrangler.mjs runs test/fake-wrangler.mjs as a real child process
// (VIZ_WRANGLER_BIN points at a wrapper written here), and `fetch` is stubbed to answer the
// Cloudflare API from the same state file. Nothing here reaches Cloudflare: the token is a dummy
// and any request the fake does not know is answered 400.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEPLOY_DIR } from '../lib/common.mjs'

/**
 * Installs the fake: writes the wrangler wrapper under `tmp`, points the deploy at it and at the
 * state file, stubs `fetch`. Returns { statePath, writeState, readState, restore }.
 */
export function installFakeAccount(tmp) {
  const statePath = join(tmp, 'state.json')
  const bin = join(tmp, 'wrangler')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(DEPLOY_DIR, 'test', 'fake-wrangler.mjs')}" "$@"\n`)
  chmodSync(bin, 0o755)
  const writeState = (s) => writeFileSync(statePath, JSON.stringify(s))
  const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))

  /** The Cloudflare API, as much of it as release.mjs reads, answered from the fake's state. */
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const state = readState()
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 })
    const notFound = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10007, message: 'not found' }] }), { status: 404 })
    const path = u.pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, '')
    const m = /^\/workers\/scripts(?:\/([^/]+)(?:\/(deployments|versions|secrets)(?:\/([^/]+))?)?)?$/.exec(path)
    if (u.hostname !== 'api.cloudflare.com' || method !== 'GET' || !m) return new Response(JSON.stringify({ success: false, errors: [{ code: 0, message: `fake API: no ${method} ${path}` }] }), { status: 400 })
    const [, name, sub, id] = m
    if (!name) return ok(Object.entries(state.workers).map(([n, w]) => ({ id: n, migration_tag: w.migrationTag ?? undefined })))
    const w = state.workers[decodeURIComponent(name)]
    if (!w) return notFound()
    const version = (vid) => w.versions.find((v) => v.id === vid)
    const shown = (v, hide = null) => ({
      id: v.id,
      number: v.number,
      annotations: { 'workers/tag': v.tag, ...(v.message ? { 'workers/message': v.message } : {}) },
      // Secrets are listed by name and type only, as Cloudflare does.
      // A var whose value is not a string is a JSON var, as Cloudflare shows it.
      resources: { bindings: [...Object.entries(v.vars).map(([n, x]) => (typeof x === 'string' ? { type: 'plain_text', name: n, text: x } : { type: 'json', name: n, json: x })), ...Object.keys(v.secrets).filter((n) => n !== hide).map((n) => ({ type: 'secret_text', name: n }))] },
    })
    if (sub === 'deployments') return ok({ deployments: [{ id: 'd1', created_on: '2026-11-19T00:00:00Z', versions: w.deployment }] })
    if (sub === 'versions' && id) {
      const v = version(id)
      if (!v) return notFound()
      // A version just created is sometimes not seen yet (measured on Cloudflare, S9): a 404, or without the secret just put.
      if (v.lag > 0) {
        v.lag--
        writeState(state)
        return notFound()
      }
      if (v.secretLag > 0) {
        v.secretLag--
        writeState(state)
        return ok(shown(v, v.lagSecret))
      }
      return ok(shown(v))
    }
    if (sub === 'versions') return ok({ items: [...w.versions].reverse().map((v) => ({ id: v.id, number: v.number })) })
    // The script's secret list names the NEWEST version's secrets, not the serving one's (measured on Cloudflare, S9).
    if (sub === 'secrets') return ok(Object.keys(w.versions.at(-1)?.secrets ?? {}).map((n) => ({ name: n, type: 'secret_text' })))
    return notFound()
  }

  const savedEnv = { ...process.env }
  process.env.VIZ_WRANGLER_BIN = bin
  process.env.VIZ_FAKE_WRANGLER_STATE = statePath
  process.env.CLOUDFLARE_ACCOUNT_ID = 'fake-account'
  process.env.CLOUDFLARE_API_TOKEN = 'fake-token-not-a-credential'
  delete process.env.GITHUB_STEP_SUMMARY
  delete process.env.VIZ_ROTATE_SECRETS
  const restore = () => {
    globalThis.fetch = realFetch
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
    Object.assign(process.env, savedEnv)
  }
  return { statePath, writeState, readState, restore }
}

/** Runs `fn` with everything it logs captured (console and stderr, where wrangler's output is relayed). */
export async function captured(fn) {
  const out = []
  const saved = { write: process.stderr.write, log: console.log, error: console.error }
  process.stderr.write = (chunk, ...rest) => {
    out.push(String(chunk))
    const cb = rest.find((x) => typeof x === 'function')
    if (cb) cb()
    return true
  }
  console.log = (...a) => out.push(a.join(' '))
  console.error = (...a) => out.push(a.join(' '))
  try {
    return { result: await fn(), log: out.join('\n') }
  } catch (error) {
    return { error, log: out.join('\n') }
  } finally {
    Object.assign(process.stderr, { write: saved.write })
    console.log = saved.log
    console.error = saved.error
  }
}

export const cmd = (call) => call.argv.join(' ')
export const callsLike = (state, prefix) => state.calls.filter((c) => cmd(c).startsWith(prefix))
export const serving = (state, name) => state.workers[name].versions.find((v) => v.id === state.workers[name].deployment[0].version_id)
export const promotions = (state) => state.calls.filter((c) => (c.argv[0] === 'versions' && c.argv[1] === 'deploy') || c.argv[0] === 'triggers' || (c.argv[0] === 'deploy' && !c.argv.includes('--dry-run')))
