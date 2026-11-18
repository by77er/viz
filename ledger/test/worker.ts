// The test (and benchmark) script: the ledger and the frozen as-built ledger side by side.
export { Ledger } from '../src/ledger'
export { Ledger as LedgerAsBuilt } from '../bench/asbuilt/ledger'

export default {
  fetch: () => new Response('viz ledger (tests)'),
} satisfies ExportedHandler
