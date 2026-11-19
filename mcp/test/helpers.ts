import { env } from 'cloudflare:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createWorker as createControlWorker } from '../../control/src/index'
import type { Tenant } from '../../control/src/tenant'
import k8s from '../../dashboard/examples/k8s-node-overview.json'
import red from '../../dashboard/examples/service-red.json'
import ingest from '../../dashboard/examples/viz-ingest-pipeline.json'
import { type Deps, createWorker, clearAuthCache, clearNamesCache } from '../src/index'
import { httpControlClient, httpMonitorsClient, httpQueryClient, type Fetcher } from '../src/clients'
import { NOW, NOW_MS, standardTelemetry } from './fake/data'
import { type FakeProm, type FakeRuler, type PromOptions, fakeProm, fakeRuler } from './fake/services'

export { env, NOW, NOW_MS }
export const EXAMPLES: Record<string, any> = { service_red: red, k8s_node_overview: k8s, viz_ingest_pipeline: ingest }
export const BASE = 'https://agent.vis.bitcru.sh'
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext

// ---- the real control plane, in-process ----

const control = createControlWorker()
export const controlFetcher: Fetcher = { fetch: (req) => control.fetch!(req as never, env as never, ctx) as Promise<Response> }
export const stubOf = (tenant: string): DurableObjectStub<Tenant> => env.TENANT.get(env.TENANT.idFromName(tenant))

let counter = 0
const run = Math.random().toString(36).slice(2, 7)

export async function controlCall(key: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await controlFetcher.fetch(new Request(`https://control.internal/api/v1/control${path}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

export interface TestTenant {
  tenant: string
  admin: string
}

/** A fresh tenant with its first admin key, made as an operator would: through the binding. */
export async function newTenant(label = 't'): Promise<TestTenant> {
  const tenant = `${label}-${run}-${++counter}`
  const { key } = await stubOf(tenant).provision(tenant)
  return { tenant, admin: key }
}

export interface Key {
  key: string
  id: string
  keyId: string
}

export async function makeKey(admin: string, scopes: string[], opts: { name?: string; kind?: 'key' | 'agent' } = {}): Promise<Key> {
  const res = await controlCall(admin, 'POST', '/keys', { name: opts.name ?? `key ${++counter}`, scopes, ...(opts.kind ? { kind: opts.kind } : {}) })
  if (res.status !== 201) throw new Error(`makeKey: ${res.status} ${JSON.stringify(res.body)}`)
  const [, keyId] = /^viz_([A-Za-z0-9]+)_/.exec(res.body.secret)!
  return { key: res.body.secret, id: res.body.key.id, keyId: keyId! }
}

export async function setAgentsMayApply(t: TestTenant, value: boolean): Promise<void> {
  const cur = await controlCall(t.admin, 'GET', '/settings/general')
  const res = await controlCall(t.admin, 'PUT', '/settings/general', { value: { ...cur.body.value, agentsMayApply: value } })
  if (res.status !== 200) throw new Error(`settings: ${res.status} ${JSON.stringify(res.body)}`)
}

export function example(name: string, id?: string): any {
  const spec = structuredClone(EXAMPLES[name])
  if (id) spec.metadata.id = id
  return spec
}

export async function createDashboard(key: string, spec: unknown, message?: string): Promise<any> {
  const res = await controlCall(key, 'POST', '/dashboards', { spec, ...(message ? { message } : {}) })
  if (res.status !== 201) throw new Error(`createDashboard: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}

// ---- the agent surface with fakes behind it ----

export interface Harness {
  worker: ExportedHandler<any>
  prom: FakeProm
  ruler: FakeRuler
  fetch(req: Request): Promise<Response>
}

export function harness(opts: { prom?: PromOptions; deps?: Partial<Deps>; env?: Record<string, unknown> } = {}): Harness {
  const prom = fakeProm(() => env.CONFIG, NOW, opts.prom ?? {})
  const ruler = fakeRuler(() => env.CONFIG)
  const worker = createWorker({
    query: (_e, auth) => httpQueryClient(prom.fetcher, auth),
    control: (_e, auth) => httpControlClient(controlFetcher, auth),
    monitors: (_e, auth) => httpMonitorsClient(ruler.fetcher, auth),
    now: () => NOW_MS,
    ...(opts.deps ?? {}),
  })
  const e = { ...env, ...(opts.env ?? {}) }
  return { worker, prom, ruler, fetch: (req) => worker.fetch!(req as never, e as never, ctx) as Promise<Response> }
}

/** Telemetry for a tenant: the standard set, plus whatever the test adds. */
export function telemetry(h: Harness, tenant: string) {
  const s = standardTelemetry(tenant)
  h.prom.storages.set(tenant, s)
  return s
}

export interface CallResult {
  status: number
  text: string
  structured: any
  isError: boolean
}

/** Call a tool through the REST surface. */
export async function rest(h: Harness, key: string, tool: string, args: unknown = {}, headers: Record<string, string> = {}): Promise<CallResult> {
  const res = await h.fetch(new Request(`${BASE}/api/v1/agent/tools/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(args) }))
  const body = (await res.json()) as any
  const { text, ...structured } = body
  return { status: res.status, text: text ?? '', structured, isError: body.ok === false }
}

/** An official MCP client (SDK v2, 2026-07-28 era) connected to the harness in-process. */
export async function mcpClient(h: Harness, key: string | null, opts: { headers?: Record<string, string> } = {}): Promise<Client> {
  const client = new Client({ name: 'viz-mcp-tests', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: (u, i) => {
      const req = new Request(u, i)
      const hd = new Headers(req.headers)
      if (key) hd.set('Authorization', `Bearer ${key}`)
      for (const [k, v] of Object.entries(opts.headers ?? {})) hd.set(k, v)
      return h.fetch(new Request(req, { headers: hd }))
    },
  })
  await client.connect(transport)
  return client
}

/** Call a tool through MCP with the official client. */
export async function mcp(h: Harness, key: string, tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const client = await mcpClient(h, key)
  try {
    const r = (await client.callTool({ name: tool, arguments: args })) as any
    return { status: 200, text: r.content?.[0]?.text ?? '', structured: r.structuredContent, isError: r.isError === true }
  } finally {
    await client.close()
  }
}

/** A raw JSON-RPC POST to /mcp (for protocol edge cases the SDK client would not send). */
export async function rpc(h: Harness, key: string | null, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await h.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }))
  const raw = await res.text()
  // Streamable HTTP may answer with JSON or with an SSE stream; take the JSON-RPC message either way.
  const text = /^(event|data|id|retry):/m.test(raw) && (res.headers.get('Content-Type') ?? '').includes('text/event-stream')
    ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    : raw
  let parsed: any = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed, headers: res.headers, sse: text !== raw } as { status: number; body: any; headers: Headers }
}

export function reset(): void {
  clearAuthCache()
  clearNamesCache()
}

/** Snapshot of a tenant's control-plane state, as its admin sees it. */
export async function snapshot(t: TestTenant): Promise<string> {
  const dashboards = await controlCall(t.admin, 'GET', '/dashboards?limit=200')
  const proposals = await controlCall(t.admin, 'GET', '/proposals?status=all&limit=200')
  const audit = await controlCall(t.admin, 'GET', '/audit?limit=200')
  const revs: unknown[] = []
  for (const d of dashboards.body.items) revs.push((await controlCall(t.admin, 'GET', `/dashboards/${d.id}/revisions?limit=200`)).body)
  return JSON.stringify({ d: dashboards.body.items.map((x: any) => [x.id, x.revision, x.number]), p: proposals.body.items.map((x: any) => [x.id, x.status]), a: audit.body.items.length, revs })
}
