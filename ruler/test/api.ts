/** Helpers for driving the HTTP API in tests: API keys in the local KV, and requests. */
import { env } from 'cloudflare:workers'
import type { ApiEnv } from '../src/http'
import { api } from './harness'

let n = 0

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const ALL_SCOPES = ['monitors:read', 'monitors:write', 'monitors:ack']

/** Store a key record the way edge's key store holds it and return the Authorization header for it. */
export async function apiKey(tenant: string, scopes: string[] = ALL_SCOPES, extra: Record<string, unknown> = {}): Promise<{ auth: string; keyId: string; by: string }> {
  const keyId = `k${n++}${Math.random().toString(36).slice(2, 10)}`
  const secret = `s${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  await env.CONFIG.put(`key:${keyId}`, JSON.stringify({ tenant, secretSha256: await sha256Hex(secret), scopes, ...extra }))
  return { auth: `Bearer viz_${keyId}_${secret}`, keyId, by: `key:${keyId}` }
}

export interface Reply {
  status: number
  headers: Headers
  text: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
}

export async function call(auth: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const h: Record<string, string> = { ...headers }
  if (auth !== null) h.Authorization = auth
  let payload: string | undefined
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body)
    h['content-type'] ??= typeof body === 'string' ? 'application/yaml' : 'application/json'
  }
  const res = await api.fetch(new Request(`https://viz.test${path}`, { method, headers: h, body: payload }), env as unknown as ApiEnv)
  const text = new TextDecoder().decode(await res.arrayBuffer())
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    // not JSON (the YAML export)
  }
  return { status: res.status, headers: res.headers, text, json }
}
