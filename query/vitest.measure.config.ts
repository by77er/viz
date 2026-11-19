import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { ledgerSignalTables } from './vitest.ledger'

// The local measurements (`npm run measure`; one file: `npm run measure -- test/cardinality.bench.ts`):
// the same one-script composition as the tests, with the production leaf pool size.
export default defineConfig({
  plugins: [ledgerSignalTables(), cloudflareTest({ wrangler: { configPath: './test/wrangler.jsonc' }, miniflare: { bindings: { LEAF_POOL_SIZE: '32' } } })],
  test: { include: ['test/*.bench.ts'], testTimeout: 1_800_000, hookTimeout: 1_800_000 },
})
