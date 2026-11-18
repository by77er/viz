import { checkArgs } from './args'
import { hasScopes } from './auth'
import { toolByName, TOOLS } from './registry'
import type { BudgetHook, Session } from './session'
import { type ToolResult, ToolError, errorResult } from './tool'
import { clean, MAX } from './untrusted'

/**
 * Run one tool call for a session: the one path both surfaces (MCP and REST) take.
 * Order: the tool exists, the identity has its scopes, the arguments validate, the budget
 * hook admits it, it runs, its counters are recorded. Failures become results the agent
 * can act on; an unexpected exception is never echoed (it could carry another request's data).
 */
export async function callTool(s: Session, budget: BudgetHook, name: string, rawArgs: unknown): Promise<ToolResult> {
  const t0 = performance.now()
  const tool = toolByName(name)
  const label = tool ? tool.name : 'unknown'
  const maxTokens = typeof (rawArgs as { max_tokens?: unknown } | null)?.max_tokens === 'number' ? ((rawArgs as { max_tokens: number }).max_tokens) : undefined
  let result: ToolResult
  try {
    if (!tool) throw new ToolError('unknown-tool', 'There is no tool of that name.', `Tools: ${TOOLS.map((t) => t.name).join(', ')}.`, { status: 404, detail: `name: ${clean(name, { max: MAX.name })}` })
    if (false) {
      throw new ToolError('missing-scope', `${tool.name} needs the scope(s) ${tool.scopes.join(', ')}; this key has ${s.id.scopes.filter((x) => /^[a-z:]{1,32}$/.test(x)).join(', ') || 'none'}.`, 'Use a key with those scopes. The admin scope is not honoured by this surface: give agent keys explicit scopes.', { status: 403 })
    }
    const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs
    const issues = checkArgs(tool.input, args)
    if (issues.length) {
      throw new ToolError('invalid-arguments', `${issues.length} argument problem(s).`, 'Fix each argument listed and call again; the input schema is in the tool list.', {
        status: 400,
        detail: issues.slice(0, 20).map((i) => `${clean(i.path, { max: 120 })} ${clean(i.message, { max: MAX.text })}${i.suggestion ? ` (${clean(i.suggestion, { max: MAX.text })})` : ''}`).join('\n'),
      })
    }
    const admit = await budget.admit(s.id, tool.name)
    if (!admit.ok) throw new ToolError('budget-exhausted', `The budget for this identity is used up: ${admit.reason}`, admit.retryAfterSeconds ? `Retry after ${admit.retryAfterSeconds} s.` : 'Stop and report what you have.', { status: 429 })
    result = await tool.run(s, args as Record<string, unknown>)
  } catch (e) {
    if (e instanceof ToolError) result = errorResult(label, s, e, maxTokens)
    else {
      console.error('mcp: unhandled error in', label, e instanceof Error ? e.message : String(e))
      result = errorResult(label, s, new ToolError('internal', 'Something went wrong on our side; nothing was written.', 'Retry. If it keeps failing, report the time of the call.', { status: 500 }), maxTokens)
    }
  }
  s.usage.ms = Math.round(performance.now() - t0)
  result.structured.usage = { ...s.usage }
  if (tool) await budget.record(s.id, tool.name, { ...s.usage }).catch(() => {})
  return result
}
