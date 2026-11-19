/**
 * The test script's main module (wrangler.test.jsonc): the ingest Worker's own (src/index.ts,
 * the same default export and classes production deploys) plus the publisher with its test
 * seams (a movable clock), bound as TEST_PUBLISHER.
 */
export * from '../src/index'
export { default } from '../src/index'
export { TestPublisher } from '../../publisher/test/worker'
