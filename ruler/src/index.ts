import { createApi, type ApiEnv } from './http'
import { sweep } from './registry'
import type { RulerEnv } from './ruler'

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

export default {
  fetch: (req, env) => api.fetch(req, env),
  /** The sweeper: a Cron Trigger re-arms rulers whose alarm was lost. */
  scheduled: async (_event, env, ctx) => {
    ctx.waitUntil(sweep(env))
  },
} satisfies ExportedHandler<ApiEnv & RulerEnv>
