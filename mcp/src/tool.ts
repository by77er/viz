import type { JsonSchema } from './args'
import type { Scope } from './auth'
import { type Item, budgetOf, charsFor, encodeCursor, page, tokensOf, argsHash } from './page'
import type { Session, Usage } from './session'
import { DATA_NOTICE, fenced } from './untrusted'

/**
 * One tool: its contract (name, description, input schema, scopes) and its run function.
 * The MCP surface and the REST surface both dispatch to `run`; neither has logic of its own.
 */
export interface ToolDef {
  name: string
  title: string
  /** Says what it returns, its units, defaults and limits. Agents read this. */
  description: string
  /** All of these are needed. */
  scopes: readonly Scope[]
  input: JsonSchema
  defaultTokens: number
  /** False only for write_dashboard and annotate. */
  readOnly: boolean
  run(s: Session, args: Record<string, unknown>): Promise<ToolResult>
}

/**
 * What every tool returns. `text` is the compact form for a model (never more than
 * `max_tokens × 4` characters); `structured` is the same result for programs.
 *
 * In `structured`, every string that came from telemetry, a dashboard or another person
 * is under `data` (cleaned like the text); the fields beside it are written by this server.
 */
export interface Envelope {
  tool: string
  ok: boolean
  truncated: boolean
  cursor: string | null
  /** Approximate tokens of `text`. */
  tokens: number
  usage: Usage
  error?: { code: string; message: string; fix: string; status: number }
  [k: string]: unknown
}

export interface ToolResult {
  text: string
  structured: Envelope
  isError: boolean
}

/** A refusal or failure the agent can act on. `message` and `fix` are server-written; `detail` is untrusted and shown fenced. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix: string,
    readonly opts: { status?: number; detail?: string; data?: Record<string, unknown>; meta?: Record<string, unknown> } = {},
  ) {
    super(message)
  }
}

export function errorResult(tool: string, s: Pick<Session, 'usage'>, e: ToolError, maxTokens?: number): ToolResult {
  const budget = charsFor(budgetOf(maxTokens, 1000))
  const head = `Error ${e.code}: ${e.message}\nFix: ${e.fix}\n`
  let text = head
  if (e.opts.detail) {
    const room = Math.max(0, budget - head.length - DATA_NOTICE.length - 40)
    const detail = e.opts.detail.length > room ? e.opts.detail.slice(0, Math.max(0, room - 30)) + '…[cut to fit max_tokens]' : e.opts.detail
    text += DATA_NOTICE + '\n' + fenced(detail)
  }
  if (text.length > budget) text = text.slice(0, budget)
  const status = e.opts.status ?? 400
  return {
    text,
    isError: true,
    structured: {
      tool,
      ok: false,
      truncated: false,
      cursor: null,
      tokens: tokensOf(text),
      usage: { ...s.usage },
      error: { code: e.code, message: e.message, fix: e.fix, status },
      ...(e.opts.meta ?? {}),
      ...(e.opts.data ? { data: e.opts.data } : {}),
    },
  }
}

export interface PagedSpec {
  tool: string
  s: Session
  args: Record<string, unknown>
  maxTokens: number
  /** Trusted header lines. */
  header: string
  items: Item[]
  offset: number
  /** What later pages must reuse (absolute range, revision, ...). */
  pinned?: Record<string, unknown>
  prelude?: string
  footer?: (p: { next: number | null; shown: number; total: number }) => string
  /** Server-written fields of the structured result. */
  meta?: Record<string, unknown>
  /** Untrusted structured fields beside `items`. */
  data?: Record<string, unknown>
}

export function pagedResult(p: PagedSpec): ToolResult {
  const hash = argsHash(p.args)
  const cursorFor = (o: number) => encodeCursor({ t: p.tool, a: hash, o, ...(p.pinned ? { p: p.pinned } : {}) })
  const pg = page({ header: p.header, items: p.items, offset: p.offset, budgetChars: charsFor(p.maxTokens), prelude: p.prelude, footer: p.footer, cursorFor })
  return {
    text: pg.text,
    isError: false,
    structured: {
      tool: p.tool,
      ok: true,
      truncated: pg.truncated,
      cursor: pg.cursor,
      tokens: tokensOf(pg.text),
      usage: { ...p.s.usage },
      shown: pg.shown.length,
      /** An item larger than the whole page was shown cut; raise max_tokens to see it whole. */
      cut: pg.cut,
      total: p.items.length,
      offset: Math.min(p.offset, p.items.length),
      ...(p.meta ?? {}),
      data: { ...(p.data ?? {}), items: pg.shown.map((i) => i.data) },
    },
  }
}
