/**
 * The test script's main module: the janitor's own (src/index.ts: the real Shard and Ledger
 * classes) plus the publisher with its test seams (a movable clock), so the tests of the
 * deletion gate run against the real `Publisher.safeToDelete` (bound as TEST_PUBLISHER; a test
 * passes it as `PUBLISHER`, so the other tests keep today's behaviour: no publisher).
 */
export * from '../src/index'
export { default } from '../src/index'
export { TestPublisher } from '../../publisher/test/worker'
