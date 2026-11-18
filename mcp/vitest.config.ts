import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Tests run in workerd against wrangler.test.jsonc (see the comment there).
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  test: { include: ['test/*.test.ts'], testTimeout: 120_000, hookTimeout: 60_000 },
})
