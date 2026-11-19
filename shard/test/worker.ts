/**
 * The test script (wrangler.test.jsonc): the shard as src/index.ts exports it, with the tenant
 * ledger in the same script as in viz-ingest (D57: the shard registers its streams with it),
 * and the release before D57 of both (bench/prereg/, ledger/bench/prereg/) for the rollback and
 * skew tests. Production deploys stack/.
 */
export * from '../src/index'
export { default, Shard } from '../src/index'
export { Ledger } from '../../ledger/src/ledger'
/** The shard release before D57, on its own namespace (frozen: bench/prereg/shard.ts). */
export { Shard as ShardPrereg } from '../bench/prereg/shard'
/** The ledger release before D57: no `logged`, no `loggedIncarnation` (frozen: ledger/bench/prereg/ledger.ts). */
export { Ledger as LedgerPrereg } from '../../ledger/bench/prereg/ledger'
