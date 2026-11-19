import { createApi, type ApiEnv } from './http'
import { sweep } from './registry'
import type { RulerEnv } from './ruler'
import { stageExpired } from './util'

export { Ruler, DEFAULT_RULER_CONFIG, type RulerEnv } from './ruler'
export { Notifier } from './notifier'
export { RulerIndex, sweep } from './registry'
export { createApi, ROUTES, type ApiEnv } from './http'
export { classify, maxWindowMs } from './classify'
export { parseRuleFile } from './rules'
export { importRuleFile, exportRuleFile } from './rulefile'
export { parseYaml, toYaml } from './yaml'
export { runBacktest } from './backtest'
export { batchFromSingle, permissiveValidator } from './evaluator'
export { verifySignature } from './signature'
export { parseTemplate, expandTemplate } from './template'
export * from '../contracts-proposal/rules.v2'

const api = createApi()

type Env = ApiEnv & RulerEnv

/**
 * Bindings the deployed Worker cannot work without. The engine is `QUERY` (HTTP) or an
 * `EVALUATOR` (RPC); recording rules' sink is `SINK` (viz-ingest's entrypoint) or, in a config
 * from before it, `INGEST` (Remote Write).
 */
const REQUIRED: (keyof Env)[] = ['CONFIG', 'RULER', 'NOTIFIER', 'RULER_INDEX', 'TENANT']

/**
 * `GET /healthz`, without a credential (the gateway asks it through its service binding and
 * never forwards the path): 200 `ok` when the Worker runs with the bindings it needs, 503
 * naming the missing ones. It calls no Durable Object and no service: without a credential
 * there is no tenant to ask, as in viz-control's and viz-query's health routes.
 */
export function health(req: Request, env: Env): Response {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD' } })
  const missing: string[] = REQUIRED.filter((b) => !env[b])
  if (!env.QUERY && !env.EVALUATOR) missing.push('QUERY')
  if (!env.SINK && !env.INGEST) missing.push('SINK')
  const body = missing.length === 0 ? 'ok\n' : `missing binding: ${missing.join(', ')}\n`
  return new Response(req.method === 'HEAD' ? null : body, { status: missing.length === 0 ? 200 : 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
}

export default {
  fetch: (req, env) => (new URL(req.url).pathname === '/healthz' ? health(req, env) : api.fetch(req, env)),
  /** The sweeper: a Cron Trigger re-arms rulers whose alarm was lost. A staged trial stops at its deadline. */
  scheduled: async (_event, env, ctx) => {
    if (stageExpired(env.VIZ_STAGE_EXPIRES_AT, Date.now())) return
    ctx.waitUntil(sweep(env))
  },
} satisfies ExportedHandler<Env>
