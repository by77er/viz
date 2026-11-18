export { Ledger } from './ledger'
export type { LedgerBase, LedgerEnv, RebuildResult } from './ledger'

export default {
  fetch: () => new Response('viz ledger'),
} satisfies ExportedHandler
