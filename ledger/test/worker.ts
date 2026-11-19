// The test (and benchmark) script: the ledger and the frozen as-built ledger side by side.
import { Ledger } from '../src/ledger'
export { Ledger }
export { Ledger as LedgerAsBuilt } from '../bench/asbuilt/ledger'
/** The release before checkpoints in parts (bench/before/): an older reader of this release's log. */
export { Ledger as LedgerBefore } from '../bench/before/ledger'
/** The release before registration before writes (bench/prereg/, D57): run on the SAME storage as the ledger's, as a rollback would (test/registration.test.ts). */
export { Ledger as LedgerPrereg } from '../bench/prereg/ledger'
/** The ledger again, under another namespace: same tenant names, separate storage. */
export class LedgerReplica extends Ledger {}

export default {
  fetch: () => new Response('viz ledger (tests)'),
} satisfies ExportedHandler
