import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The shard with its tenants' ledgers in one script, as in viz-ingest (D57).
      wrangler: { configPath: './wrangler.test.jsonc' },
      // The ledger logs a change 200 ms after it commits (contracts/LEDGER-LOG.md). Here it
      // logs only when a test asks (`drain()`), so a test decides when a registration becomes
      // logged; the default timing is measured in bench/registration.bench.test.ts.
      miniflare: { bindings: { LEDGER_DRAIN_DELAY_MS: '60000' } },
    }),
  ],
  // bench/ has its own config (`npm run bench`).
  test: { exclude: ['bench/**', 'node_modules/**'], testTimeout: 60_000 },
})
