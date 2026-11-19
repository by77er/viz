/**
 * The previous release's Worker-side checks of a code or token, frozen: what control did before the
 * review of D70 (commit 3cbabb8, `contracts/oauth.ts` `OAUTH_CREDENTIAL`, `CREDENTIAL_TAG` and
 * `parseCredential`; `control/src/oauth.ts` `tagOf`, `credentialTagValid` and `mintCredential`):
 * the same computations, with the constants inlined so that a later change to the contract cannot
 * move them, and without the key cache and the constant-time comparison, which change nothing a
 * test can see. A credential this passes, the previous release's token endpoint, revocation and
 * introspection hand to the tenant's object, which finds it by the SHA-256 of the whole string; the
 * agent surface of that release recognises it by `parseCredential` alone (mcp/src/auth.ts
 * `presentedOAuth`). test/ratelimit-review.test.ts uses it to show that the credentials this
 * release issues (layout 2) are still served by a Worker of the previous release (rollback, or a
 * gradual deployment that runs both).
 */
const OAUTH_CREDENTIAL = /^(vzc|vza|vzr)1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9]{43})$/
const CREDENTIAL_TAG = { randomChars: 27, tagChars: 16, salt: 'viz.oauth.credential-tag/v1' } as const
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const utf8 = (s: string) => new TextEncoder().encode(s)

export function previousParseCredential(s: string): { kind: 'code' | 'access' | 'refresh'; tenant: string } | null {
  const m = OAUTH_CREDENTIAL.exec(s)
  if (!m) return null
  const kind = m[1] === 'vzc' ? 'code' : m[1] === 'vza' ? 'access' : 'refresh'
  return { kind, tenant: m[2]! }
}

async function tagOf(secret: string, body: string): Promise<string> {
  const ikm = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: utf8(CREDENTIAL_TAG.salt), info: new Uint8Array() }, ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(body)))
  let out = ''
  for (let i = 0; i < CREDENTIAL_TAG.tagChars; i++) out += B62[mac[i]! % 62]
  return out
}

export async function previousCredentialTagValid(secret: string | null, credential: unknown): Promise<boolean> {
  if (secret === null || typeof credential !== 'string' || !OAUTH_CREDENTIAL.test(credential)) return false
  const cut = credential.length - CREDENTIAL_TAG.tagChars
  return (await tagOf(secret, credential.slice(0, cut))) === credential.slice(cut)
}

/** What the previous release minted: 27 random characters, then the tag (layout 1). */
export async function previousMintCredential(kind: 'code' | 'access' | 'refresh', tenant: string, secret: string): Promise<string> {
  const prefix = { code: 'vzc1', access: 'vza1', refresh: 'vzr1' }[kind]
  let random = ''
  while (random.length < CREDENTIAL_TAG.randomChars) {
    const b = crypto.getRandomValues(new Uint8Array(1))[0]!
    if (b < 248) random += B62[b % 62]
  }
  const body = `${prefix}.${tenant}.${random}`
  return body + (await tagOf(secret, body))
}
