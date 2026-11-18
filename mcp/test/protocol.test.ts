import { beforeAll, describe, expect, it } from 'vitest'
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BASE, type Harness, harness, makeKey, mcpClient, newTenant, reset, rpc, telemetry, createDashboard, example, type TestTenant } from './helpers'
import { TOOLS } from '../src/registry'

/**
 * Protocol conformance for the methods this server implements, with both official clients
 * (SDK v1 1.32.2 speaking the 2025 revisions, SDK v2 2.4.0 speaking 2026-07-28) and with raw
 * JSON-RPC for the cases a client library would never send.
 */

let h: Harness
let t: TestTenant
let key: string

beforeAll(async () => {
  reset()
  h = harness()
  t = await newTenant('proto')
  telemetry(h, t.tenant)
  key = (await makeKey(t.admin, ['read', 'dashboards:read', 'dashboards:write'], { kind: 'agent', name: 'proto agent' })).key
  await createDashboard(t.admin, example('service_red'))
})

const init = (version = '2025-06-18', id: number | string = 1) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'raw', version: '1' } } })
const legacyHeaders = (v = '2025-06-18') => ({ 'MCP-Protocol-Version': v })

describe('2025-era (stateless legacy) over raw JSON-RPC', () => {
  it('initialize negotiates a supported revision and advertises tools, resources and prompts', async () => {
    for (const v of ['2025-11-25', '2025-06-18', '2025-03-26']) {
      const r = await rpc(h, key, init(v))
      expect(r.status).toBe(200)
      expect(r.body.jsonrpc).toBe('2.0')
      expect(r.body.id).toBe(1)
      expect(r.body.result.protocolVersion).toBe(v)
      expect(r.body.result.serverInfo.name).toBe('viz')
      expect(Object.keys(r.body.result.capabilities).sort()).toEqual(expect.arrayContaining(['prompts', 'resources', 'tools']))
      expect(r.body.result.instructions).toMatch(/viz-data/)
      expect(r.headers.get('mcp-session-id')).toBeNull() // stateless: no session
    }
  })

  it('an unknown revision is answered with one the server supports', async () => {
    const r = await rpc(h, key, init('1999-01-01'))
    expect(r.status).toBe(200)
    expect(['2025-11-25', '2025-06-18', '2025-03-26']).toContain(r.body.result.protocolVersion)
  })

  it('notifications/initialized is accepted with 202 and no body', async () => {
    const r = await rpc(h, key, { jsonrpc: '2.0', method: 'notifications/initialized' }, legacyHeaders())
    expect(r.status).toBe(202)
  })

  it('ping answers an empty result', async () => {
    const r = await rpc(h, key, { jsonrpc: '2.0', id: 7, method: 'ping' }, legacyHeaders())
    expect(r.body).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  it('tools/list: the tools this key may call, in a fixed order, each with an object input schema and annotations', async () => {
    const a = await rpc(h, key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, legacyHeaders())
    const b = await rpc(h, key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, legacyHeaders())
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body)) // byte-stable for one identity
    const names = a.body.result.tools.map((x: any) => x.name)
    const expected = TOOLS.filter((x) => x.scopes.every((s) => ['read', 'dashboards:read', 'dashboards:write'].includes(s))).map((x) => x.name)
    expect(names).toEqual(expected)
    expect(names).not.toContain('list_monitors') // needs monitors:read
    for (const tool of a.body.result.tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(typeof tool.description).toBe('string')
      expect(tool.annotations.readOnlyHint).toBe(tool.name !== 'write_dashboard' && tool.name !== 'annotate')
      if (tool.name !== 'annotate') expect(tool.inputSchema.properties.max_tokens.type).toBe('integer')
    }
  })

  it('tools/call returns text content and structured content', async () => {
    const r = await rpc(h, key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_schema', arguments: { kind: 'stat', max_tokens: 400 } } }, legacyHeaders())
    expect(r.status).toBe(200)
    const res = r.body.result
    expect(res.isError).toBe(false)
    expect(res.content[0].type).toBe('text')
    expect(res.content[0].text.length).toBeLessThanOrEqual(1600)
    expect(res.structuredContent.tool).toBe('get_schema')
    expect(res.structuredContent.truncated).toBe(true)
    expect(typeof res.structuredContent.cursor).toBe('string')
  })

  it('a tool error is a result with isError, not a protocol error', async () => {
    const r = await rpc(h, key, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'describe_metric', arguments: { name: 'no_such_metric_total' } } }, legacyHeaders())
    expect(r.body.result.isError).toBe(true)
    expect(r.body.result.structuredContent.error.code).toBe('unknown-metric')
  })

  it('bad arguments come back as a tool error naming each argument, with a suggestion', async () => {
    const r = await rpc(h, key, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'query', arguments: { exprr: 'up' } } }, legacyHeaders())
    expect(r.body.result.isError).toBe(true)
    expect(r.body.result.structuredContent.error.code).toBe('invalid-arguments')
    expect(r.body.result.content[0].text).toMatch(/\/exprr is not a known argument \(did you mean "expr"\?\)/)
    expect(r.body.result.content[0].text).toMatch(/\/expr is required/)
  })

  it('a tool this key may not call is not offered and cannot be called', async () => {
    const r = await rpc(h, key, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_monitors', arguments: {} } }, legacyHeaders())
    expect(r.body.error ?? r.body.result?.isError).toBeTruthy()
  })

  it('resources/list, resources/templates/list and resources/read', async () => {
    const list = await rpc(h, key, { jsonrpc: '2.0', id: 8, method: 'resources/list' }, legacyHeaders())
    expect(list.body.result.resources.map((x: any) => x.uri)).toEqual(['viz://schema/dashboard/v1', 'viz://catalog/panels', 'viz://docs/promql'])
    const tmpl = await rpc(h, key, { jsonrpc: '2.0', id: 9, method: 'resources/templates/list' }, legacyHeaders())
    expect(tmpl.body.result.resourceTemplates[0].uriTemplate).toBe('viz://dashboards/{id}')
    const schema = await rpc(h, key, { jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'viz://schema/dashboard/v1' } }, legacyHeaders())
    const doc = JSON.parse(schema.body.result.contents[0].text)
    expect(doc.$schema).toMatch(/2020-12/)
    const dash = await rpc(h, key, { jsonrpc: '2.0', id: 11, method: 'resources/read', params: { uri: 'viz://dashboards/service_red' } }, legacyHeaders())
    expect(dash.body.result.contents[0].text).toMatch(/get_dashboard: view outline/)
  })

  it('prompts/list and prompts/get', async () => {
    const list = await rpc(h, key, { jsonrpc: '2.0', id: 12, method: 'prompts/list' }, legacyHeaders())
    expect(list.body.result.prompts.map((x: any) => x.name)).toEqual(['investigate-service', 'build-service-dashboard', 'review-dashboard'])
    const got = await rpc(h, key, { jsonrpc: '2.0', id: 13, method: 'prompts/get', params: { name: 'investigate-service', arguments: { service: 'checkout' } } }, legacyHeaders())
    expect(got.body.result.messages[0].role).toBe('user')
    expect(got.body.result.messages[0].content.text).toMatch(/search_telemetry/)
    expect(got.body.result.messages[0].content.text).toMatch(/```viz-data [0-9a-f]{8}\nservice: checkout\n```/)
  })

  it('an unknown method is -32601', async () => {
    const r = await rpc(h, key, { jsonrpc: '2.0', id: 14, method: 'no/such/method' }, legacyHeaders())
    expect(r.body.error.code).toBe(-32601)
  })

  it('malformed JSON is a parse error (-32700)', async () => {
    const r = await rpc(h, key, '{"jsonrpc": "2.0", "id": 1, "method": "ping"', legacyHeaders())
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe(-32700)
  })

  it('a message that is not JSON-RPC is an invalid request (-32600)', async () => {
    const r = await rpc(h, key, { id: 1, method: 'ping' }, legacyHeaders())
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect([-32600, -32700]).toContain(r.body.error.code)
  })

  it('GET and DELETE are 405: stateless, no stream and no session', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await h.fetch(new Request(`${BASE}/mcp`, { method, headers: { Authorization: `Bearer ${key}` } }))
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('POST')
    }
  })

  it('no credential, a wrong one, or a revoked one: 401 with WWW-Authenticate and no tenant data', async () => {
    for (const k of [null, 'viz_nope_nopenopenope', key.slice(0, -1) + (key.endsWith('a') ? 'b' : 'a')]) {
      const r = await rpc(h, k, init())
      expect(r.status).toBe(401)
      expect(r.headers.get('WWW-Authenticate')).toMatch(/^Bearer /)
      expect(r.body.error.code).toBe(-32001)
    }
  })

  it('a browser origin that is not allowed is refused (DNS-rebinding protection)', async () => {
    const r = await rpc(h, key, init(), { Origin: 'https://evil.example' })
    expect(r.status).toBe(403)
  })
})

describe('2025-era with the official SDK v1 client (1.32.2)', () => {
  it('connects, lists and calls tools, reads resources, gets prompts, pings', async () => {
    const client = new V1Client({ name: 'v1', version: '1' })
    const transport = new V1Transport(new URL(`${BASE}/mcp`), { fetch: (u: any, i: any) => { const r = new Request(u, i); const hd = new Headers(r.headers); hd.set('Authorization', `Bearer ${key}`); return h.fetch(new Request(r, { headers: hd })) } })
    await client.connect(transport)
    expect(client.getServerVersion()?.name).toBe('viz')
    await client.ping()
    const tools = await client.listTools()
    expect(tools.tools.length).toBeGreaterThan(5)
    const r = (await client.callTool({ name: 'search_telemetry', arguments: { q: 'http requests' } })) as any
    expect(r.isError).toBe(false)
    expect(r.content[0].text).toMatch(/http_server_requests_total/)
    expect((await client.listResources()).resources.length).toBe(3)
    expect((await client.readResource({ uri: 'viz://catalog/panels' })).contents[0]!.mimeType).toBe('application/json')
    expect((await client.listPrompts()).prompts.length).toBe(3)
    expect((await client.getPrompt({ name: 'review-dashboard', arguments: { id: 'service_red' } })).messages.length).toBe(1)
    await client.close()
  })
})

describe('2026-07-28 with the official SDK v2 client (2.4.0)', () => {
  it('discovers, lists and calls tools, resources and prompts without a session', async () => {
    const client = await mcpClient(h, key)
    expect(client.getServerVersion()?.name).toBe('viz')
    const tools = await client.listTools()
    expect(tools.tools.map((x) => x.name)).toContain('read_dashboard')
    const r = (await client.callTool({ name: 'validate_query', arguments: { expr: 'sum(rate(http_server_requests_total[5m]))' } })) as any
    expect(r.isError).toBe(false)
    expect(r.structuredContent.valid).toBe(true)
    const res = await client.listResources()
    expect(res.resources.map((x) => x.uri)).toContain('viz://catalog/panels')
    const read = await client.readResource({ uri: 'viz://docs/promql' })
    expect((read.contents[0] as any).text).toMatch(/PromQL on viz/)
    const prompts = await client.listPrompts()
    expect(prompts.prompts.length).toBe(3)
    const p = await client.getPrompt({ name: 'build-service-dashboard', arguments: { service: 'checkout' } })
    expect((p.messages[0]!.content as any).text).toMatch(/write_dashboard/)
    await client.close()
  })

  it('a missing required prompt argument is an error', async () => {
    const client = await mcpClient(h, key)
    await expect(client.getPrompt({ name: 'review-dashboard', arguments: {} })).rejects.toThrow()
    await client.close()
  })
})
