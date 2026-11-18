import { describe, expect, it } from 'vitest'
import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const factory = () => {
  const s = new McpServer({ name: 'spike', version: '0.0.1' })
  s.registerTool('echo', { description: 'echo', inputSchema: fromJsonSchema({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false }) }, async (args: any) => ({ content: [{ type: 'text', text: `got ${args.x}` }] }))
  return s
}

describe('libraries in workerd', () => {
  it('SDK v2 createMcpHandler + v2 client (modern era)', async () => {
    const h = createMcpHandler(factory)
    const client = new Client({ name: 't', version: '1' })
    const t = new StreamableHTTPClientTransport(new URL('https://x.test/mcp'), { fetch: (u, i) => h.fetch(new Request(u, i)) })
    await client.connect(t)
    const tools = await client.listTools()
    expect(tools.tools.map((x) => x.name)).toEqual(['echo'])
    const r = await client.callTool({ name: 'echo', arguments: { x: 'hi' } })
    expect((r.content as any)[0].text).toBe('got hi')
    console.log('modern protocol', t.protocolVersion, (client as any).getNegotiatedProtocolVersion?.())
  })
  it('SDK v2 createMcpHandler + v1 client (2025 legacy stateless)', async () => {
    const h = createMcpHandler(factory)
    const client = new V1Client({ name: 't', version: '1' })
    const t = new V1Transport(new URL('https://x.test/mcp'), { fetch: (u: any, i: any) => h.fetch(new Request(u, i)) })
    await client.connect(t)
    const tools = await client.listTools()
    expect(tools.tools.map((x) => x.name)).toEqual(['echo'])
    const r = await client.callTool({ name: 'echo', arguments: { x: 'yo' } })
    expect((r.content as any)[0].text).toBe('got yo')
    await client.ping()
  })
  it('agents createMcpHandler (wrapper)', async () => {
    const { createMcpHandler: agentsHandler } = await import('agents/mcp/server')
    const h = agentsHandler(factory)
    const client = new Client({ name: 't', version: '1' })
    const t = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: (u, i) => { const r = new Request(u, i); const hd = new Headers(r.headers); hd.set('Host', 'localhost'); return h(new Request(r, { headers: hd }), {}, { waitUntil() {}, passThroughOnException() {} } as any) } })
    console.log('agents wrapper ok')
    await client.connect(t)
    const tools = await client.listTools()
    expect(tools.tools.map((x) => x.name)).toEqual(['echo'])
  })
})
