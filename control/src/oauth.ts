import {
  ADMIN_IMPLIES,
  BASE62,
  CLIENT_ID,
  CREDENTIAL_LAYOUT,
  CREDENTIAL_PREFIX,
  CREDENTIAL_TAG,
  type ClientRegistration,
  type CredentialKind,
  OAUTH_CREDENTIAL,
  OAUTH_DEFAULT_SCOPES,
  OAUTH_LIFETIMES,
  OAUTH_LIMITS,
  OAUTH_SCOPES,
  type OAuthScope,
  credentialExpiresAt,
} from '../../contracts/oauth'
import { sha256Hex } from '../../dashboard/src/index.ts'
import { B62, randomId } from './util'

/**
 * OAuth building blocks for the control plane (contracts/oauth.ts, decision D44): where the
 * server and its one resource are, credentials and their hashes, sealing the grant key's secret
 * under a credential, signed client registrations, PKCE, scopes, redirect URIs, and the
 * authorization request a person approves.
 *
 * Nothing here logs, and no error message it builds contains a credential.
 */

export const DEFAULT_PUBLIC_URL = 'https://vis.bitcru.sh'

export interface OAuthEnv {
  /** The public origin (the gateway's), e.g. https://vis.bitcru.sh: the issuer, and the base of the resource `/mcp`. */
  PUBLIC_URL?: string
  /** Worker secret (wrangler secret put): signs client registrations. Absent or shorter than 32 characters: registration is off. */
  OAUTH_CLIENT_KEY?: string
}

export interface OAuthConfig {
  issuer: string
  /** The one resource tokens are issued for: the agent surface's MCP endpoint. */
  resource: string
  clientKey: string | null
}

export function oauthConfig(env: OAuthEnv): OAuthConfig {
  const issuer = (env.PUBLIC_URL?.trim() || DEFAULT_PUBLIC_URL).replace(/\/+$/, '')
  const key = typeof env.OAUTH_CLIENT_KEY === 'string' && env.OAUTH_CLIENT_KEY.length >= 32 ? env.OAUTH_CLIENT_KEY : null
  return { issuer, resource: `${issuer}/mcp`, clientKey: key }
}

/**
 * RFC 8707 / MCP "Canonical Server URI": absolute, no fragment, no query. Scheme and host compare
 * without case (the specification asks servers to accept upper case there); the path compares
 * exactly, without a trailing slash. Null when `s` is not a usable resource identifier.
 */
export function canonicalResource(s: string): string | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 512 || s.includes('#')) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.search || u.username || u.password || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null
  // URL lowercases scheme and host; the path is taken as written in `s`, minus one trailing slash.
  const raw = s.slice(s.indexOf('//') + 2)
  const slash = raw.indexOf('/')
  const path = slash < 0 ? '' : raw.slice(slash).replace(/\/$/, '')
  return `${u.protocol}//${u.host}${path}`
}

export const sameResource = (a: string, b: string): boolean => {
  const x = canonicalResource(a)
  return x !== null && x === canonicalResource(b)
}

// ---- bytes ----

const enc = new TextEncoder()
export const utf8 = (s: string): Uint8Array<ArrayBuffer> => enc.encode(s) as Uint8Array<ArrayBuffer>

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  return out
}

/** Equal-length strings compared without an early exit. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ---- credentials ----

/**
 * The key credential tags are made with (contracts/oauth.ts `CREDENTIAL_TAG`): HKDF-SHA-256 of
 * `OAUTH_CLIENT_KEY` with its own salt, so it is not the key that signs registrations. Derived once
 * per isolate and secret; a pure function of the secret, not state.
 */
const tagKeys = new Map<string, Promise<CryptoKey>>()
function tagKey(secret: string): Promise<CryptoKey> {
  let k = tagKeys.get(secret)
  if (!k) {
    if (tagKeys.size >= 4) tagKeys.clear()
    k = (async () => {
      const ikm = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey'])
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: utf8(CREDENTIAL_TAG.salt), info: new Uint8Array() }, ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
    })()
    k.catch(() => tagKeys.delete(secret))
    tagKeys.set(secret, k)
  }
  return k
}

async function tagOf(secret: string, body: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await tagKey(secret), utf8(body)))
  let out = ''
  for (let i = 0; i < CREDENTIAL_TAG.tagChars; i++) out += B62[mac[i]! % 62]
  return out
}

/** Layout 2's expiry characters for `expiresAtMs`: whole minutes since the epoch, rounded up, so never earlier than the object's expiry (contracts/oauth.ts `CREDENTIAL_LAYOUT`). */
export function expiryChars(expiresAtMs: number): string {
  const { expiryEpochMs, expiryUnitMs, expiryChars: n } = CREDENTIAL_LAYOUT
  // Out of range (before the epoch, or after 2054): the nearest end; past the far end the Worker never refuses it early.
  let v = Math.min(62 ** n - 1, Math.max(0, Math.ceil((expiresAtMs - expiryEpochMs) / expiryUnitMs)))
  let out = ''
  for (let i = 0; i < n; i++) {
    out = BASE62[v % 62] + out
    v = Math.floor(v / 62)
  }
  return out
}

/** A kind's lifetime from issue (contracts/oauth.ts `OAUTH_LIFETIMES`), in ms. */
export const lifetimeMs = (kind: CredentialKind): number =>
  (kind === 'code' ? OAUTH_LIFETIMES.codeSeconds : kind === 'access' ? OAUTH_LIFETIMES.accessSeconds : OAUTH_LIFETIMES.refreshSeconds) * 1000

/**
 * A new code, access token or refresh token for `tenant`, expiring at `expiresAtMs` (what the
 * tenant's object stores for it; by default the kind's lifetime from now):
 * `<prefix>.<tenant>.<body 27><tag 16>` (contracts/oauth.ts), the body in layout 2 (`e`, the expiry,
 * 22 random characters). `secret`: `OAUTH_CLIENT_KEY`, which the tag is made with. `layout: 1`
 * makes the body the previous release made (27 random characters), for the tests that serve such
 * credentials.
 */
export async function mintCredential(kind: CredentialKind, tenant: string, secret: string, expiresAtMs: number = Date.now() + lifetimeMs(kind), layout: 1 | 2 = 2): Promise<string> {
  const inner = layout === 1 ? randomId(CREDENTIAL_TAG.randomChars) : `${CREDENTIAL_LAYOUT.marker}${expiryChars(expiresAtMs)}${randomId(CREDENTIAL_LAYOUT.randomChars)}`
  const body = `${CREDENTIAL_PREFIX[kind]}.${tenant}.${inner}`
  return body + (await tagOf(secret, body))
}

/** How long after a credential's encoded expiry the Worker still lets it through: the Worker's clock may run ahead of the object's that minted it. */
export const EXPIRY_GRACE_MS = 60_000

/**
 * Whether a credential is past the expiry its layout 2 body carries (plus `EXPIRY_GRACE_MS`): the
 * tenant's object refuses it too, so the Worker may refuse it first, without counting it against
 * any limit or asking any object (D70). False for layout 1, which carries no expiry. Only for a
 * credential whose tag `credentialTagValid` accepted: the tag covers the expiry.
 */
export function credentialExpired(credential: string, now: number = Date.now()): boolean {
  const at = credentialExpiresAt(credential)
  return at !== null && at + EXPIRY_GRACE_MS <= now
}

/**
 * Whether `credential` carries the tag this deployment makes: checked in the Worker before a
 * tenant's object is asked, so a made-up credential costs the object nothing (review of D44,
 * M-2). True does not mean valid: only the tenant's object knows that. False without a key.
 */
export async function credentialTagValid(secret: string | null, credential: unknown): Promise<boolean> {
  if (secret === null || typeof credential !== 'string' || !OAUTH_CREDENTIAL.test(credential)) return false
  const cut = credential.length - CREDENTIAL_TAG.tagChars
  return sameString(await tagOf(secret, credential.slice(0, cut)), credential.slice(cut))
}

/** What is stored of a credential: the hex SHA-256 of the whole string. */
export const hashCredential = (credential: string): string => sha256Hex(credential)

// ---- sealing the grant key's secret under a credential ----

const SEAL_SALT = utf8('viz.oauth.seal/v1')

async function sealKey(credential: string, usage: KeyUsage): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', utf8(credential), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SEAL_SALT, info: new Uint8Array() }, ikm, { name: 'AES-GCM', length: 256 }, false, [usage])
}

/**
 * `s1.<base64url(iv ‖ ciphertext ‖ tag)>`: AES-256-GCM under a key derived (HKDF-SHA-256) from
 * the credential, with `aad` (tenant and grant) authenticated, so a sealed value moved to another
 * grant's row does not open. Format `oauth.sealed` version 1.
 */
export async function seal(credential: string, plaintext: string, aad: string, iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(12))): Promise<string> {
  const key = await sealKey(credential, 'encrypt')
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, utf8(plaintext)))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv)
  out.set(ct, iv.length)
  return `s1.${b64url(out)}`
}

/** The plaintext, or null when the credential, the aad or the value is not the one sealed. */
export async function unseal(credential: string, sealed: string, aad: string): Promise<string | null> {
  if (!sealed.startsWith('s1.')) return null
  const bytes = fromB64url(sealed.slice(3))
  if (!bytes || bytes.length < 12 + 16) return null
  try {
    const key = await sealKey(credential, 'decrypt')
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: utf8(aad) }, key, bytes.slice(12))
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

export const sealAad = (tenant: string, grant: string): string => `${tenant}/${grant}`

// ---- signed client registrations (format id.oauth-client, version 1) ----

async function hmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

export async function signRegistration(secret: string, reg: ClientRegistration): Promise<string> {
  const payload = b64url(utf8(JSON.stringify(reg)))
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), utf8(payload)))
  return `vzk1.${payload}.${b64url(mac)}`
}

/** The registration a client id carries, if its signature holds under `secret`. Age is not checked here. */
export async function verifyClientId(secret: string | null, clientId: string): Promise<ClientRegistration | null> {
  if (secret === null || typeof clientId !== 'string') return null
  const m = CLIENT_ID.exec(clientId)
  if (!m) return null
  const mac = fromB64url(m[2]!)
  if (!mac || mac.length !== 32) return null
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), mac, utf8(m[1]!))
  if (!ok) return null
  const raw = fromB64url(m[1]!)
  if (!raw) return null
  let r: Partial<ClientRegistration>
  try {
    r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as Partial<ClientRegistration>
  } catch {
    return null
  }
  if (r.v !== 1 || typeof r.n !== 'string' || !Number.isSafeInteger(r.iat) || typeof r.name !== 'string') return null
  if (!Array.isArray(r.uris) || r.uris.length === 0 || !r.uris.every((u) => typeof u === 'string' && redirectProblem(u) === null)) return null
  return { v: 1, n: r.n, iat: r.iat!, name: r.name, uris: r.uris }
}

// ---- redirect URIs ----

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/

/** Why `u` may not be a redirect URI (MCP: https or localhost; OAuth 2.1: absolute, no fragment), or null. */
export function redirectProblem(u: string): string | null {
  if (typeof u !== 'string' || u.length === 0 || u.length > OAUTH_LIMITS.redirectUriLength) return `must be 1 to ${OAUTH_LIMITS.redirectUriLength} characters`
  if (/[\s\\<>"`{}|^\u0000-\u001f\u007f-\u009f]/.test(u)) return 'must not contain spaces, backslashes, quotes or control characters'
  // Shown to a person on the consent page: ASCII only, so no bidirectional or invisible character
  // can make it read as something else (review of D44, m-3). Other characters are percent-encoded,
  // and an IDN host is written as punycode.
  if (/[^\x20-\x7e]/.test(u)) return 'must be ASCII: percent-encode other characters, and write an internationalised host as punycode (xn--…)'
  if (u.includes('#')) return 'must not have a fragment'
  let url: URL
  try {
    url = new URL(u)
  } catch {
    return 'is not an absolute URL'
  }
  if (url.username || url.password) return 'must not carry user information'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && LOOPBACK.test(url.hostname)) return null
  return 'must use https, or http on localhost, 127.0.0.1 or [::1]'
}

export const isLoopback = (u: string): boolean => {
  try {
    return LOOPBACK.test(new URL(u).hostname)
  } catch {
    return false
  }
}

/** The client's callback with parameters added (any it already has are kept). */
export function callback(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.append(k, v)
  return url.href
}

// ---- scopes ----

const KNOWN = new Set<string>(OAUTH_SCOPES)

/**
 * A `scope` parameter: space-separated, every one known. Empty or absent: the default (read
 * only). `offline_access` is accepted and dropped: refresh tokens are always issued.
 */
export function parseScope(raw: string | undefined | null): { ok: OAuthScope[] } | { unknown: string[] } {
  const words = (raw ?? '').split(' ').filter((w) => w !== '' && w !== 'offline_access')
  if (words.length === 0) return { ok: [...OAUTH_DEFAULT_SCOPES] }
  const unknown = words.filter((w) => !KNOWN.has(w))
  if (unknown.length) return { unknown: [...new Set(unknown)].map((w) => w.slice(0, 40)) }
  // In OAUTH_SCOPES order, once each.
  return { ok: OAUTH_SCOPES.filter((s) => words.includes(s)) }
}

/** What an approver's key may hand on: its own scopes, plus the dashboards scopes `admin` stands for in control. */
export function approverScopes(scopes: readonly string[]): Set<string> {
  const out = new Set(scopes)
  if (out.has('admin')) for (const s of ADMIN_IMPLIES) out.add(s)
  return out
}

// ---- PKCE ----

/** base64url(SHA-256) without padding: exactly 43 characters. */
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/
/** RFC 7636 §4.1. */
export const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (typeof verifier !== 'string' || !CODE_VERIFIER.test(verifier) || !CODE_CHALLENGE.test(challenge)) return false
  return sameString(b64url(hexToBytes(sha256Hex(verifier))), challenge)
}

// ---- the authorization request a person approves (format oauth.request, version 1) ----

export interface AuthzRequest {
  v: 1
  client_id: string
  redirect_uri: string
  scope: OAuthScope[]
  code_challenge: string
  state: string | null
  resource: string
}

export const encodeRequest = (r: AuthzRequest): string => b64url(utf8(JSON.stringify(r)))

/** Shape only. Everything in it is checked again by whoever acts on it. */
export function decodeRequest(handle: unknown): AuthzRequest | null {
  if (typeof handle !== 'string' || handle.length > 8_192) return null
  const raw = fromB64url(handle.trim())
  if (!raw) return null
  try {
    const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as Partial<AuthzRequest>
    if (r.v !== 1 || typeof r.client_id !== 'string' || typeof r.redirect_uri !== 'string' || typeof r.code_challenge !== 'string' || typeof r.resource !== 'string') return null
    if (!Array.isArray(r.scope) || !r.scope.every((s) => KNOWN.has(s as string))) return null
    if (r.state !== null && (typeof r.state !== 'string' || r.state.length > OAUTH_LIMITS.stateLength)) return null
    if (!CODE_CHALLENGE.test(r.code_challenge) || redirectProblem(r.redirect_uri) !== null) return null
    return { v: 1, client_id: r.client_id, redirect_uri: r.redirect_uri, scope: r.scope as OAuthScope[], code_challenge: r.code_challenge, state: r.state ?? null, resource: r.resource }
  } catch {
    return null
  }
}

/** Untrusted text from a client (its name), made safe to show as one line: control and invisible characters dropped, cut. */
export function displayName(s: string): string {
  const one = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim()
  return one.length > OAUTH_LIMITS.clientNameLength ? `${one.slice(0, OAUTH_LIMITS.clientNameLength)}…` : one || 'unnamed application'
}
