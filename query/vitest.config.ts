import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { ledgerSignalTables } from './vitest.ledger'

// Tests run against test/wrangler.jsonc: ONE script holding the query Worker and its Leaf
// together with edge, Shard, Ledger and Flush, so a test can ingest and then query.
export default defineConfig({
  plugins: [ledgerSignalTables(), cloudflareTest({ wrangler: { configPath: './test/wrangler.jsonc' } })],
  test: { testTimeout: 120_000, hookTimeout: 120_000 },
})
