// A minimal Cloudflare REST client for the account in CLOUDFLARE_ACCOUNT_ID. The token is read
// from CLOUDFLARE_API_TOKEN and only ever placed in the Authorization header; errors carry
// Cloudflare's error codes and messages, never request headers.

const BASE = 'https://api.cloudflare.com/client/v4'

export class CfError extends Error {
  constructor(status, path, errors) {
    super(`Cloudflare API ${status} on ${path}: ${(errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ') || 'no detail'}`)
    this.status = status
    this.errors = errors ?? []
  }
}

export function account() {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!id) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set')
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is not set')
  return id
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One API call under /accounts/{id}. Retries 429 and 5xx a few times. Returns the parsed envelope. */
export async function cf(method, path, body, { raw = false, okStatuses = [] } = {}) {
  const url = `${BASE}/accounts/${account()}${path}`
  for (let attempt = 0; ; attempt++) {
    const init = { method, headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } }
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    let res
    try {
      res = await fetch(url, init)
    } catch (e) {
      if (attempt < 4) {
        await sleep(500 * 2 ** attempt)
        continue
      }
      throw new Error(`Cloudflare API unreachable on ${path}: ${e.cause?.code ?? e.message}`)
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(500 * 2 ** attempt)
      continue
    }
    if (raw) return res
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = { success: res.ok, result: text }
    }
    if (okStatuses.includes(res.status)) return { ...json, status: res.status }
    if (!res.ok || json.success === false) throw new CfError(res.status, path, json.errors)
    return { ...json, status: res.status }
  }
}

/** Every page of a list endpoint that pages with `page`/`per_page`. */
export async function cfList(path, perPage = 100) {
  const out = []
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const j = await cf('GET', `${path}${sep}page=${page}&per_page=${perPage}`)
    const items = Array.isArray(j.result) ? j.result : []
    out.push(...items)
    const info = j.result_info
    if (!info || items.length === 0 || (info.total_pages !== undefined ? page >= info.total_pages : items.length < perPage)) break
  }
  return out
}

// ---- Workers ----

export async function listScripts() {
  const j = await cf('GET', '/workers/scripts')
  return j.result ?? []
}

/** `{ exists, migrationTag }` of one script, from the script list (the field is `migration_tag`). */
export async function scriptInfo(name, scripts) {
  const s = (scripts ?? (await listScripts())).find((x) => x.id === name)
  return s ? { exists: true, migrationTag: s.migration_tag ?? null } : { exists: false, migrationTag: null }
}

/** The versions serving a script now: `[{ version_id, percentage }]`, or [] if it has no deployment. */
export async function currentDeployment(name) {
  const j = await cf('GET', `/workers/scripts/${encodeURIComponent(name)}/deployments`, undefined, { okStatuses: [404] })
  if (j.status === 404) return null
  const deployments = j.result?.deployments ?? []
  if (deployments.length === 0) return null
  // Newest first.
  const d = [...deployments].sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)))[0]
  return { id: d.id, createdOn: d.created_on, versions: d.versions ?? [] }
}

/** A version's metadata, including its annotations (`workers/tag`, `workers/message`). */
export async function versionInfo(name, versionId) {
  const j = await cf('GET', `/workers/scripts/${encodeURIComponent(name)}/versions/${versionId}`, undefined, { okStatuses: [404] })
  if (j.status === 404) return null
  return j.result ?? null
}

/** Every version Cloudflare keeps of a script (the 100 most recent): `[{ id, number, metadata, annotations }]`, newest first. */
export async function listVersions(name) {
  const out = []
  for (let page = 1; page <= 10; page++) {
    const j = await cf('GET', `/workers/scripts/${encodeURIComponent(name)}/versions?page=${page}&per_page=100`, undefined, { okStatuses: [404] })
    if (j.status === 404) return out
    const items = j.result?.items ?? (Array.isArray(j.result) ? j.result : [])
    out.push(...items)
    if (items.length < 100) break
  }
  return out.sort((a, b) => (b.number ?? 0) - (a.number ?? 0))
}

export async function deleteScript(name) {
  const j = await cf('DELETE', `/workers/scripts/${encodeURIComponent(name)}?force=true`, undefined, { okStatuses: [404] })
  return j.status !== 404
}

export async function workersSubdomain() {
  const j = await cf('GET', '/workers/subdomain')
  return j.result?.subdomain
}

export async function listCustomDomains() {
  const j = await cf('GET', '/workers/domains')
  return j.result ?? []
}

export async function listSecrets(name) {
  const j = await cf('GET', `/workers/scripts/${encodeURIComponent(name)}/secrets`, undefined, { okStatuses: [404] })
  return j.status === 404 ? [] : (j.result ?? [])
}

export async function deleteSecret(name, secret) {
  const j = await cf('DELETE', `/workers/scripts/${encodeURIComponent(name)}/secrets/${encodeURIComponent(secret)}`, undefined, { okStatuses: [404] })
  return j.status !== 404
}

export async function listDurableObjectNamespaces() {
  return cfList('/workers/durable_objects/namespaces')
}
