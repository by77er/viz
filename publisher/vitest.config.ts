import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  test: {
    // Runs in Node: a local sink that the end-to-end test dumps the simulated bucket into.
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 120_000,
  },
})
