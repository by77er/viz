import { callTool } from './dispatch'
import { DASHBOARD_TEMPLATE, PROMPTS, RESOURCES, readResource, renderPrompt, toolsFor } from './registry'
import type { BudgetHook, Session } from './session'
import { ToolError, errorResult } from './tool'
import { INSTRUCTIONS, SERVER_INFO } from './mcp'

/**
 * The same operations as JSON, under /api/v1/agent/… — for programs and for the in-app
 * assistant. One implementation: every route calls the dispatcher the MCP surface calls.
 *
 *   GET  /api/v1/agent                     index: tools (with input schemas), resources, prompts
 *   GET  /api/v1/agent/tools               the tools this credential may call
 *   POST /api/v1/agent/tools/{name}        call one; body = arguments; answer = structured result + "text"
 *   GET  /api/v1/agent/resources           resource list
 *   GET  /api/v1/agent/resources/read?uri= one resource
 *   GET  /api/v1/agent/prompts             prompt list
 *   POST /api/v1/agent/prompts/{name}      body = arguments; answer = { description, messages }
 */
export const REST_PREFIX = '/api/v1/agent'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } })

export function problem(status: number, code: string, detail: string, fix: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ type: `https://vis.bitcru.sh/problems/${code}`, title: code, status, code, detail, fix, ...extra }), { status, headers: { ...JSON_HEADERS, 'Content-Type': 'application/problem+json' } })
}

const MAX_BODY = 1 << 20

async function body(req: Request): Promise<unknown> {
  const text = await req.text()
  if (text.length > MAX_BODY) throw new ToolError('body-too-large', `The body may be at most ${MAX_BODY} bytes.`, 'Send less.', { status: 413 })
  if (!text) return {}
  const type = (req.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') throw new ToolError('not-json', 'The body must be JSON.', 'Send "Content-Type: application/json".', { status: 415 })
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ToolError('bad-json', 'The body is not valid JSON.', 'Send a JSON object of arguments.', { status: 400 })
  }
}

const toolList = (s: Session) => toolsFor(s).map((t) => ({ name: t.name, title: t.title, description: t.description, scopes: t.scopes, readOnly: t.readOnly, inputSchema: t.input }))

export async function serveRest(req: Request, path: string, s: Session, budget: BudgetHook): Promise<Response> {
  try {
    const sub = path.slice(REST_PREFIX.length) || '/'
    if (req.method === 'GET' && (sub === '/' || sub === '')) {
      return json(200, { server: SERVER_INFO, instructions: INSTRUCTIONS, tools: toolList(s), resources: RESOURCES.map(({ scopes: _s, ...r }) => r), resourceTemplates: [{ uriTemplate: DASHBOARD_TEMPLATE, name: 'dashboard' }], prompts: PROMPTS.map(({ render: _r, ...p }) => p) })
    }
    if (sub === '/tools' && req.method === 'GET') return json(200, { tools: toolList(s) })
    const tm = /^\/tools\/([a-z_]{1,40})$/.exec(sub)
    if (tm) {
      if (req.method !== 'POST') return problem(405, 'method-not-allowed', 'Call a tool with POST.', 'POST the arguments as a JSON object.')
      const r = await callTool(s, budget, tm[1]!, await body(req))
      const { error, ...rest } = r.structured
      if (r.isError && error) return json(error.status, { ...rest, error, text: r.text })
      return json(200, { ...r.structured, text: r.text })
    }
    if (sub === '/resources' && req.method === 'GET') return json(200, { resources: RESOURCES.map(({ scopes: _s, ...r }) => r), resourceTemplates: [{ uriTemplate: DASHBOARD_TEMPLATE, name: 'dashboard' }] })
    if (sub === '/resources/read' && req.method === 'GET') {
      const uri = new URL(req.url).searchParams.get('uri') ?? ''
      return json(200, await readResource(s, uri))
    }
    if (sub === '/prompts' && req.method === 'GET') return json(200, { prompts: PROMPTS.map(({ render: _r, ...p }) => p) })
    const pm = /^\/prompts\/([a-z-]{1,40})$/.exec(sub)
    if (pm && req.method === 'POST') {
      const args = await body(req)
      if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new ToolError('invalid-arguments', 'Prompt arguments must be a JSON object.', 'Send {"service": "checkout"}.', { status: 400 })
      const r = renderPrompt(pm[1]!, args as Record<string, unknown>)
      return json(200, { description: r.description, messages: [{ role: 'user', content: { type: 'text', text: r.text } }] })
    }
    return problem(404, 'not-found', 'No such route.', `See GET ${REST_PREFIX} for the tools, resources and prompts.`)
  } catch (e) {
    if (e instanceof ToolError) {
      const r = errorResult('rest', s, e)
      return json(e.opts.status ?? 400, { ...r.structured, text: r.text })
    }
    throw e
  }
}
