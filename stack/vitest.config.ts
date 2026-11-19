import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      // wrangler.jsonc with the publisher in the script instead of bound by script_name.
      wrangler: { configPath: './wrangler.test.jsonc' },
      // The soak's length and seed, as bindings, so they are read when the test runs
      // (`SOAK_STEPS=3000 npx vitest run test/soak.test.ts`).
      miniflare: { bindings: { SOAK_STEPS: process.env.SOAK_STEPS ?? '400', SOAK_SEED: process.env.SOAK_SEED ?? '20261118' } },
    }),
  ],
  // The suites share four cores with each other and with the soak.
  test: { testTimeout: 120_000 },
})
