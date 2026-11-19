// Worker secrets the deploy generates itself (design/DECISIONS.md D53; deploy/README.md, "Worker
// secrets the deploy generates"). Today one: viz-control's OAUTH_CLIENT_KEY.
//
// - Made here with a CSPRNG only when the version a release would promote does not already carry
//   it. Every upload inherits the secrets of the version before it, so once made it stays across
//   deploys; it is replaced only when a deploy is told to (VIZ_ROTATE_SECRETS / --rotate-secret).
// - Handed to wrangler on stdin (`wrangler versions secret put`), as bootstrap.mjs hands over
//   VIZ_BOOTSTRAP: never on a command line, in the environment, in a log or in a file. Only
//   names are listed, compared or recorded; wrangler's output is scrubbed before it is shown.
// - Where in a release: `versions secret put` makes a new version from the NEWEST version plus
//   the secret, and deploys nothing. Right after phase 1 uploads the Worker, the newest version
//   is this release's upload (checked), so the keyed version is this release's code and config,
//   serving nothing until phase 2 promotes it instead of the upload. A Worker that goes out with
//   `wrangler deploy` in phase 2 (new, or applying a Durable Object migration) gets the same on
//   the version it just deployed, then `versions deploy` of the keyed one, before the next
//   Worker is promoted.
// - Fail closed: if the Worker has the secret now (a version serving now, or a version uploaded
//   after the one serving, as a rollback leaves behind) but the version this release would promote
//   does not carry it, nothing is generated and nothing is promoted: a new value would invalidate
//   every registered OAuth client.
// - Rollbacks (measured on Cloudflare, 2026-11-19, spike S9): a secret belongs to each version, so
//   a rollback to a version without the key serves without it until the next deploy, and Cloudflare
//   refuses (10220) a rollback to a version whose value differs. `release.mjs rollback` refuses both
//   up front, before any Worker is moved (`secretRollbackProblems`).
import { randomBytes } from 'node:crypto'

export const GENERATED_SECRETS = [
  {
    worker: 'viz-control',
    name: 'OAUTH_CLIENT_KEY',
    bytes: 32,
    why: 'signs the OAuth client registrations of MCP clients (HMAC-SHA-256; control/src/oauth.ts, D44). Without it /oauth/register answers 503; replacing it invalidates every registered client',
  },
]

export const ROTATE_ENV = 'VIZ_ROTATE_SECRETS'

/**
 * The var every version a run uploads carries (`wrangler versions upload --var`), a value unique to
 * that run (review of D53, m-11). `versions secret put` builds the keyed version from whatever
 * version is newest when Cloudflare applies it, with that version's vars: the keyed version's
 * VIZ_DEPLOY_RUN says whose upload the key went on.
 */
export const RUN_VAR = 'VIZ_DEPLOY_RUN'

/** A refusal: nothing was promoted, and nothing will be until a person decides (exit 3). */
export class SecretRefused extends Error {}

/** `bytes` random bytes from the CSPRNG, base64url (32 bytes: 43 characters). */
export function generateSecretValue(bytes) {
  if (!Number.isInteger(bytes) || bytes < 32) throw new Error(`a generated secret needs at least 32 random bytes, not ${bytes}`)
  return randomBytes(bytes).toString('base64url')
}

/** Names of the secrets a version carries, from the version API's bindings. Never a value. */
export function secretNamesOf(version) {
  const bindings = version?.resources?.bindings ?? version?.bindings ?? []
  return bindings.filter((b) => b && (b.type === 'secret_text' || b.type === 'secret_key')).map((b) => b.name)
}

const plainVar = (version, name) => (version?.resources?.bindings ?? version?.bindings ?? []).find((b) => b?.type === 'plain_text' && b.name === name)?.text ?? null

const annotation = (v, key) => v?.annotations?.[key] ?? v?.metadata?.annotations?.[key] ?? null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * How long a read of a version just created is retried while Cloudflare does not show it yet
 * (measured on Cloudflare, S9: 2 of 16 such reads failed, a 404 and a version without the secret
 * just put, both on a Worker about a minute old; later reads saw it after 193-368 ms). Backoff from
 * 250 ms, doubling, for at most this long in all. VIZ_FRESH_READ_MS sets it (the tests shorten it).
 */
export const FRESH_READ_MS = 10_000
const freshBudget = () => {
  const n = Number(process.env.VIZ_FRESH_READ_MS)
  return Number.isFinite(n) && n >= 0 ? n : FRESH_READ_MS
}

/** Reads `id` of `worker` until `ready(info)`, retrying within the budget; returns the last answer. */
export async function readFresh(api, worker, id, ready = (info) => Boolean(info)) {
  const budget = freshBudget()
  let waited = 0
  let delay = 250
  for (;;) {
    const info = await api.versionInfo(worker, id)
    if (ready(info) || waited >= budget) return info
    const d = Math.min(delay, budget - waited)
    await sleep(d)
    waited += d
    delay *= 2
  }
}

/** Replaces every occurrence of `value` in `text`. */
export const scrub = (text, value) => (value ? String(text ?? '').split(value).join('[redacted]') : String(text ?? ''))

/** The generated secrets of a manifest's Workers, with the Worker's deployed (staged) name. */
export function secretsOfManifest(manifest) {
  const out = []
  for (const name of manifest.order) {
    const w = manifest.workers.find((x) => x.name === name)
    for (const s of GENERATED_SECRETS) if (s.worker === (w?.canonical ?? name)) out.push({ ...s, worker: name, canonical: s.worker })
  }
  return out
}

/** Secret names asked to be replaced: "OAUTH_CLIENT_KEY", space or comma separated. */
export function parseRotate(text) {
  return new Set(String(text ?? '').split(/[\s,;]+/).filter(Boolean))
}

/** A name asked to be rotated that this release does not generate is refused, not ignored. */
export function rotateProblems(rotate, specs) {
  return [...rotate].filter((n) => !specs.some((s) => s.name === n)).map((n) => `${ROTATE_ENV} names ${n}, which is not a secret this deploy generates (${specs.map((s) => s.name).join(', ') || 'none in this release'}): nothing was changed`)
}

/**
 * What the account holds now, by name only: for each generated secret, whether a version serving
 * now or a version newer than every serving one carries it. Read before phase 1. `api`: {
 * versionInfo, listVersions } (lib/cf.mjs).
 *
 * The newer versions are what a rollback leaves behind: after a rollback across the release that
 * created the key, the serving version may not have it while the release that made it is still
 * among the versions (review of D53, m-9). An upload that then does not inherit it is refused
 * instead of silently given a new key. Normally no version is newer than the serving one (one API
 * call to list); after a rollback, one call per newer version, at most the 100 Cloudflare keeps.
 * The Worker's secret list is not read: measured on Cloudflare (S9), it names the newest version's
 * secrets, which the scan of newer versions already covers, and it says nothing of what serves.
 * A serving version that cannot be read stops the release (unknown, never taken as "not set"); one
 * whose number is unknown makes every other version count as newer.
 */
export async function secretsNow(specs, live, api) {
  const out = []
  for (const spec of specs) {
    const now = live[spec.worker]
    if (!now?.exists) {
      out.push({ ...spec, exists: false, known: false, seenIn: [] })
      continue
    }
    const seenIn = []
    const servingIds = new Set((now.versions ?? []).map((v) => v.version_id))
    let newestServing = -Infinity
    for (const v of now.versions ?? []) {
      const info = await api.versionInfo(spec.worker, v.version_id)
      if (!info) throw new Error(`${spec.worker}: serving version ${v.version_id} could not be read, so whether ${spec.name} is set is unknown; nothing was changed`)
      if (secretNamesOf(info).includes(spec.name)) seenIn.push(`serving version ${v.version_id}`)
      if (Number.isFinite(info.number)) newestServing = Math.max(newestServing, info.number)
    }
    for (const v of await api.listVersions(spec.worker)) {
      if (servingIds.has(v.id) || (Number.isFinite(v.number) && v.number <= newestServing)) continue
      if (secretNamesOf(await api.versionInfo(spec.worker, v.id)).includes(spec.name)) seenIn.push(`version ${v.id} (number ${v.number}), newer than the one serving: a rollback left it`)
    }
    out.push({ ...spec, exists: true, known: seenIn.length > 0, seenIn })
  }
  return out
}

/** What the deploy will do with each generated secret, for the plan. Pure. */
export function planSecrets(now, rotate, steps) {
  return now.map((n) => {
    const step = steps.find((s) => s.name === n.worker)
    const when = step?.via === 'deploy' ? 'right after its wrangler deploy in phase 2, before the next Worker is promoted' : 'on the version uploaded in phase 1, before anything is promoted'
    const how = `${n.bytes} random bytes, handed to wrangler on stdin`
    let action
    let line
    if (rotate.has(n.name) && n.known) {
      action = 'rotate'
      line = `secret ${n.name} on ${n.worker}: set; REPLACED as asked (${ROTATE_ENV}) ${when} (${how}). Every registered OAuth client must register again`
    } else if (n.known) {
      action = 'keep'
      line = `secret ${n.name} on ${n.worker}: set (${n.seenIn.join(', ')}); kept: the new version inherits it`
    } else {
      action = 'create'
      line = `secret ${n.name} on ${n.worker}: not set${n.exists ? '' : ' (new Worker)'}; would be created ${when} (${how})`
    }
    return { worker: n.worker, name: n.name, action, line }
  })
}

/**
 * Makes sure `versionId` of `worker` carries every secret in `specs`, creating (or, when asked,
 * replacing) them with `wrangler versions secret put`. Returns the version to promote (a new one
 * when anything was put) and what was done, by name. Throws SecretRefused when generating would
 * replace a secret nobody asked to replace, when the newest version is not `versionId` or does not
 * carry this run's `run` (VIZ_DEPLOY_RUN), or when the keyed version was built on a version of
 * another run (m-11: that run uploaded between the check and the put). `api`: { wrangler,
 * versionInfo, listVersions }.
 */
export async function ensureSecrets({ worker, versionId, specs, now, rotate, release, run, tag, message, api, log = () => {} }) {
  let current = versionId
  // Just created (uploaded, or deployed in phase 2): read until Cloudflare shows it (S9).
  const info = await readFresh(api, worker, current)
  if (!info) throw new Error(`${worker}: version ${current} was not found (after retrying for ${freshBudget()} ms), so its secrets cannot be checked`)
  const carried = secretNamesOf(info)
  const actions = []
  const toPut = []
  for (const spec of specs) {
    const has = carried.includes(spec.name)
    const seen = now.find((n) => n.worker === worker && n.name === spec.name)
    if (rotate.has(spec.name)) toPut.push({ spec, action: has || seen?.known ? 'rotated' : 'created' })
    else if (has) actions.push({ worker, name: spec.name, action: 'kept', versionId: current })
    else if (seen?.known) {
      throw new SecretRefused(
        `${worker}: ${spec.name} is set (${seen.seenIn.join(', ')}), but version ${current}, which this release would promote, does not carry it. ` +
          `A new value would invalidate every registered OAuth client, so none is generated and nothing is promoted. ` +
          `Find out why the upload did not inherit it; to replace it on purpose, deploy again with ${ROTATE_ENV}=${spec.name}.`,
      )
    } else toPut.push({ spec, action: 'created' })
  }
  if (!run) throw new Error(`${worker}: no run id to check the keyed version against`)
  for (const { spec, action } of toPut) {
    // `versions secret put` patches the NEWEST version. It must be this run's upload, or the keyed
    // version could carry code nobody reviewed for this release, or another run's version.
    const newest = (await api.listVersions(worker))[0]?.id ?? null
    if (newest !== current) {
      throw new SecretRefused(`${worker}: the newest version is ${newest ?? '(none)'}, not ${current} which this release made; putting ${spec.name} would build on that one, so nothing is put and nothing is promoted. Is another deploy running?`)
    }
    const base = current === versionId ? info : await api.versionInfo(worker, current)
    if (plainVar(base, RUN_VAR) !== run) {
      throw new SecretRefused(`${worker}: version ${current} carries ${RUN_VAR} ${plainVar(base, RUN_VAR) ?? '(none)'}, not this run's ${run}; nothing is put on it and nothing is promoted (was it uploaded without --var ${RUN_VAR}?)`)
    }
    let value = generateSecretValue(spec.bytes)
    let out
    try {
      const r = await api.wrangler(['versions', 'secret', 'put', spec.name, '--name', worker, '--tag', tag, '--message', `${message}; ${spec.name} ${action}`.slice(0, 100)], { input: value, quiet: true, label: `${worker} secret` })
      out = scrub(r.out, value)
    } catch (e) {
      const tail = scrub(e.out ?? '', value).trim().split('\n').filter(Boolean).slice(-4).join(' | ')
      throw new Error(`${worker}: ${scrub(e.message, value)} while putting ${spec.name}; nothing was promoted${tail ? `. wrangler said: ${tail}` : ''}`)
    } finally {
      value = null
    }
    const m = /Created version ([0-9a-f-]{36})/i.exec(out)
    if (!m) throw new Error(`${worker}: no version id in wrangler's answer to putting ${spec.name}; nothing was promoted`)
    const made = await readFresh(api, worker, m[1], (x) => secretNamesOf(x).includes(spec.name))
    if (!secretNamesOf(made).includes(spec.name)) throw new Error(`${worker}: version ${m[1]} does not list ${spec.name} after it was put (read for ${freshBudget()} ms); nothing was promoted`)
    if (plainVar(made, 'VIZ_RELEASE') !== release) throw new Error(`${worker}: version ${m[1]} carries VIZ_RELEASE ${plainVar(made, 'VIZ_RELEASE')}, not ${release}; it is not this release's, so nothing is promoted`)
    // The put patched whatever version was newest when Cloudflare applied it; its vars are that
    // version's. Another run of the same release that uploaded after the check above has the same
    // VIZ_RELEASE but not this run's VIZ_DEPLOY_RUN (review of D53, m-11).
    if (plainVar(made, RUN_VAR) !== run) {
      throw new SecretRefused(
        `${worker}: ${spec.name} went on version ${m[1]}, built on an upload of another run (${RUN_VAR} ${plainVar(made, RUN_VAR) ?? '(none)'}, this run is ${run}): another deploy uploaded between the check and the put. ` +
          `Nothing is promoted. That version serves nothing, and the other run never promotes it (it promotes its own upload, or refuses because its upload is no longer the newest). Run the deploy again once the other has finished.`,
      )
    }
    log(`  ${worker}: secret ${spec.name} ${action} on new version ${m[1]} (from ${current})`)
    actions.push({ worker, name: spec.name, action, versionId: m[1], from: current })
    current = m[1]
  }
  return { versionId: current, actions }
}

/**
 * Generated secrets a rollback to `target` would take away or change (measured on Cloudflare,
 * 2026-11-19, spike S9). Pure. `targetInfo` maps each Worker of the record to its version as the API
 * returns it; `ran` is every version newer than the target's of those Workers (`{ worker, versionId,
 * release, secrets, message }`); `accept` the names the operator accepts losing.
 *
 * - The target's version does not carry a secret a newer version carries (a rollback across the
 *   release that created it): Cloudflare allows it, and the restored version serves WITHOUT the key
 *   until the next deploy (which takes the newest version's again). Refused unless accepted.
 * - The target's version carries it, but a newer version was made by putting it (`created` or
 *   `rotated`, the message ensureSecrets writes): the values differ, Cloudflare refuses the
 *   rollback (10220), and `wrangler versions deploy` has no way to force it. Refused always, so
 *   that the callers are not rolled back ahead of a viz-control step that fails.
 */
export function secretRollbackProblems({ target, targetInfo, ran, specs, accept = new Set() }) {
  const problems = []
  for (const spec of specs) {
    const own = target.workers.find((w) => w.name === spec.worker)
    if (!own) continue // the record leaves this Worker as it is
    const has = secretNamesOf(targetInfo[spec.worker]).includes(spec.name)
    const since = ran.filter((v) => v.worker === spec.worker)
    if (!has) {
      const carrier = since.find((v) => v.secrets.includes(spec.name))
      if (carrier && !accept.has(spec.name)) {
        problems.push(
          `${spec.worker}: this rollback restores version ${own.versionId}, which does not carry ${spec.name}, and version ${carrier.versionId} (release ${carrier.release ?? 'unknown'}) carries it: it crosses the release that created the key. ` +
            `Measured on Cloudflare (S9): the rollback is allowed and the restored version serves without the key until the next deploy: /oauth/register answers 503, the metadata drops registration_endpoint, every registered client is refused at /oauth/authorize (400 "not registered"), and (read from control's code, not measured) its codes and tokens are refused too. ` +
            `To roll back anyway, accept that with --accept-secret-loss ${spec.name}; the next deploy brings the key back. Or leave ${spec.worker} out of the record.`,
        )
      }
      continue
    }
    const put = since.find((v) => new RegExp(`; ${spec.name} (created|rotated)$`).test(v.message ?? ''))
    if (put) {
      problems.push(
        `${spec.worker}: this rollback restores version ${own.versionId}, whose ${spec.name} differs from the one put since on version ${put.versionId} (release ${put.release ?? 'unknown'}: "${put.message}"): it crosses a rotation. ` +
          `Cloudflare refuses that rollback (10220, "secrets have changed", measured S9) and wrangler versions deploy cannot force it; forced through the API, the old key would serve until the next release took the newest version's again. ` +
          `Nothing was moved. Roll back with a record that leaves ${spec.worker} out (its serving version stays, a callee newer than its callers), or fix forward.`,
      )
    }
  }
  return problems
}

/** What a version tells the rollback check about generated secrets: their names and its message. */
export const secretFacts = (info) => ({ secrets: secretNamesOf(info), message: annotation(info, 'workers/message') })
