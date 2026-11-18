import { env } from 'cloudflare:workers'
import worker, { clearAuthCache, createWorker, type Hooks } from '../src/index'
import type { Tenant } from '../src/tenant'
import k8s from '../../dashboard/examples/k8s-node-overview.json'
import red from '../../dashboard/examples/service-red.json'
import ingest from '../../dashboard/examples/viz-ingest-pipeline.json'

export const EXAMPLES = { service_red: red, k8s_node_overview: k8s, viz_ingest_pipeline: ingest } as Record<string, unknown>
export const BASE = 'https://vis.bitcru.sh/api/v1/control'

let counter = 0
const run = Math.random().toString(36).slice(2, 8)

export const stubOf = (tenant: string): DurableObjectStub<Tenant> => env.TENANT.get(env.TENANT.idFromName(tenant))

/** A fresh tenant with its first admin key, made the way an operator would: through the binding. */
export async function newTenant(label = 't'): Promise<{ tenant: string; admin: string; adminId: string }> {
  const tenant = `${label}-${run}-${++counter}`
  const { key, id } = await stubOf(tenant).provision(tenant)
  return { tenant, admin: key, adminId: id }
}

export interface Res<T = any> {
  status: number
  body: T
  headers: Headers
  text: string
}

export async function call(key: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, hooks?: Hooks): Promise<Res> {
  const init: RequestInit = { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const w = hooks ? createWorker(hooks) : worker
  const res = await w.fetch!(new Request(BASE + path, init) as never, env as never, {} as ExecutionContext)
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed, headers: res.headers, text }
}

export const get = (key: string | null, path: string, headers?: Record<string, string>) => call(key, 'GET', path, undefined, headers)
export const post = (key: string | null, path: string, body: unknown = {}, headers?: Record<string, string>) => call(key, 'POST', path, body, headers)

/** Create a key through the API and return the full key and its id. */
export async function makeKey(admin: string, scopes: string[], opts: { name?: string; kind?: 'key' | 'agent'; expiresAt?: string } = {}): Promise<{ key: string; id: string; keyId: string; secret: string }> {
  const res = await post(admin, '/keys', { name: opts.name ?? `key ${++counter}`, scopes, ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) })
  if (res.status !== 201) throw new Error(`makeKey: ${res.status} ${res.text}`)
  const [, keyId, secret] = /^viz_([A-Za-z0-9]+)_(.+)$/.exec(res.body.secret)!
  return { key: res.body.secret, id: res.body.key.id, keyId: keyId!, secret: secret! }
}

/** A copy of an example dashboard under a new id. */
export function example(name: keyof typeof EXAMPLES | string = 'service_red', id?: string): any {
  const spec = structuredClone(EXAMPLES[name]) as any
  if (id) spec.metadata.id = id
  return spec
}

export async function createDashboard(key: string, id: string, name = 'service_red', extra: Record<string, unknown> = {}): Promise<Res> {
  const res = await post(key, '/dashboards', { spec: example(name, id), ...extra })
  if (res.status !== 201) throw new Error(`createDashboard: ${res.status} ${res.text}`)
  return res
}

export const kvGet = async (key: string): Promise<any> => {
  const v = await env.CONFIG.get(key)
  return v === null ? null : JSON.parse(v)
}

export async function auditOf(admin: string, query = ''): Promise<any[]> {
  const out: any[] = []
  let cursor: string | null = null
  do {
    const res: Res = await get(admin, `/audit?limit=200${query}${cursor ? `&cursor=${cursor}` : ''}`)
    if (res.status !== 200) throw new Error(`audit: ${res.status} ${res.text}`)
    out.push(...res.body.items)
    cursor = res.body.next
  } while (cursor)
  return out
}

export { clearAuthCache, env }
