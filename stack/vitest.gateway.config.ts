import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

/**
 * The public path end to end (test/gateway/): viz-gateway in front of viz-ingest and viz-query,
 * one script (test/gateway/wrangler.jsonc). Run by `npm test` after the write path's own suite
 * (vitest.config.ts, which leaves test/gateway/ out).
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/gateway/wrangler.jsonc' } })],
  test: { include: ['test/gateway/**/*.test.ts'], testTimeout: 300_000, hookTimeout: 120_000, maxWorkers: 2 },
})
