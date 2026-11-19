import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      // The drain runs when a test asks (`drain()`, `runDurableObjectAlarm`), not on its own
      // 200 ms after a commit; `test/segments.test.ts` checks the default timing separately.
      miniflare: { bindings: { LEDGER_DRAIN_DELAY_MS: '60000' } },
    }),
  ],
  // bench/ has its own config (`npm run bench`).
  test: { exclude: ['bench/**', 'node_modules/**'] },
})
