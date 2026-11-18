#!/usr/bin/env node
// Creates the first API key of a tenant on a deployed viz, with no long-lived admin secret.
//
//   node deploy/bootstrap.mjs --tenant <id> [--stage S] [--url https://…]
//                             [--key-file <path>] [--smoke-key-file <path>]
//
// 1. Generates a one-time token here (32 random bytes). Only its SHA-256 leaves this machine
//    as configuration: the Worker secret VIZ_BOOTSTRAP on the gateway holds
//    {tenant, tokenSha256, expiresAt (10 minutes)}, set with `wrangler secret put` reading
//    stdin (never a command line, never a log).
// 2. POST /api/v1/bootstrap with the token as a bearer credential. The gateway calls control's
//    Tenant.provision for the tenant named in the secret, which refuses a tenant that already
//    has a key.
// 3. Deletes the secret (always, also on failure) and checks that it is gone.
// 4. Prints the admin key ONCE to this terminal (stdout), or writes it to --key-file (mode
//    0600) instead. With --smoke-key-file it also creates a key with the write and read
//    scopes named "smoke" (for SMOKE_KEY) and writes it there; that one is never printed.
import { randomBytes, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { deleteSecret, listSecrets } from './lib/cf.mjs'
import { checkStage, log, parseArgs } from './lib/common.mjs'
import { wrangler } from './lib/wrangler.mjs'
import { loadManifest } from './release.mjs'
import { publicUrl } from './smoke.mjs'

const SECRET = 'VIZ_BOOTSTRAP'
const WINDOW_MS = 10 * 60_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function post(url, token) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'viz-bootstrap/1' } })
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  } catch (e) {
    return { status: 0, body: null, error: e.cause?.code ?? e.message }
  }
}

async function removeSecret(gateway) {
  try {
    await wrangler(['secret', 'delete', SECRET, '--name', gateway], { input: 'y\n', label: 'secret delete', quiet: true })
  } catch {
    // Fall back to the API; checked below either way.
    await deleteSecret(gateway, SECRET).catch(() => {})
  }
  const left = (await listSecrets(gateway)).some((s) => s.name === SECRET)
  if (left) throw new Error(`the secret ${SECRET} is still set on ${gateway}: delete it now with "npx wrangler secret delete ${SECRET} --name ${gateway}"`)
  log(`bootstrap: secret ${SECRET} deleted from ${gateway}`)
}

export async function bootstrap({ tenant, stage, url, keyFile, smokeKeyFile }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenant ?? '')) throw new Error('--tenant must match [A-Za-z0-9_-]{1,64}')
  const manifest = loadManifest(stage)
  const gateway = manifest.workers.find((w) => w.public).name
  const base = url ?? (await publicUrl(stage))
  const token = randomBytes(32).toString('base64url')
  const secret = JSON.stringify({ tenant, tokenSha256: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + WINDOW_MS })

  log(`bootstrap: setting the one-time secret on ${gateway} (valid 10 minutes)`)
  await wrangler(['secret', 'put', SECRET, '--name', gateway], { input: secret, label: 'secret put', quiet: true })
  let result
  try {
    // The new version (with the secret) takes a moment to reach every location; until then
    // the endpoint is the ordinary 404.
    const deadline = Date.now() + 90_000
    for (;;) {
      result = await post(`${base}/api/v1/bootstrap`, token)
      if (result.status !== 404 && result.status !== 0) break
      if (Date.now() > deadline) break
      await sleep(3000)
    }
  } finally {
    await removeSecret(gateway)
  }
  if (result.status === 409) throw new Error(`tenant ${tenant} already has keys: nothing was created. Create further keys through /api/v1/control/keys.`)
  if (result.status !== 201 || !result.body?.key) throw new Error(`bootstrap failed: ${result.status} ${JSON.stringify(result.body ?? result.error ?? '')}`)
  const admin = result.body.key

  if (keyFile) {
    writeFileSync(keyFile, admin + '\n', { mode: 0o600 })
    log(`bootstrap: admin key for ${tenant} written to ${keyFile} (mode 0600)`)
  } else {
    log(`bootstrap: the first admin key of tenant ${tenant}, shown once (store it now; it cannot be shown again):`)
    console.log(admin)
  }

  if (smokeKeyFile) {
    // A key that can write and read: what the deploy's smoke test uses as SMOKE_KEY.
    let res
    const deadline = Date.now() + 90_000
    for (;;) {
      res = await fetch(`${base}/api/v1/control/keys`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'smoke', scopes: ['write', 'read'], kind: 'key' }),
      })
      // control authenticates through KV, which can lag the key's creation for a few seconds.
      if (res.status !== 401 || Date.now() > deadline) break
      await sleep(5000)
    }
    const body = await res.json().catch(() => null)
    if (res.status !== 201 || !body?.secret) throw new Error(`creating the smoke key failed: ${res.status} ${body?.code ?? ''}`)
    writeFileSync(smokeKeyFile, body.secret + '\n', { mode: 0o600 })
    log(`bootstrap: key "smoke" (write, read) written to ${smokeKeyFile} (mode 0600)`)
  }
  return { tenant, keyId: result.body.keyId }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { options: ['tenant', 'stage', 'url', 'key-file', 'smoke-key-file'] })
    checkStage(args.stage)
    await bootstrap({ tenant: args.tenant, stage: args.stage, url: args.url, keyFile: args['key-file'], smokeKeyFile: args['smoke-key-file'] })
  } catch (e) {
    log(`bootstrap: ${e.message}`)
    process.exit(1)
  }
}
