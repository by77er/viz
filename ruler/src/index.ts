export { Ruler, DEFAULT_RULER_CONFIG, type RulerEnv } from './ruler'
export { Notifier } from './notifier'
export { classify, maxWindowMs } from './classify'
export { parseRuleFile } from './rules'
export { parseTemplate, expandTemplate } from './template'
export * from '../contracts-proposal/rules'

export default {
  fetch: () => new Response('viz ruler'),
} satisfies ExportedHandler
