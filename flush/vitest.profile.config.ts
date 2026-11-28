import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

/**
 * The profile of D82 (`test/profile.prof.ts`), not part of `npm test`: `npm run profile`.
 * The ledger drains its change log as in production, after a delay: 535 ms here, the default
 * 200 ms plus S10's measured R2 PUT p50 (335 ms), because the ledger's own PUT is not delayed
 * by the profile's latency model.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { LEDGER_DRAIN_DELAY_MS: '535' } },
    }),
  ],
  test: { include: ['test/**/*.prof.ts'], testTimeout: 600_000 },
})
