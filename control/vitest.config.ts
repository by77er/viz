import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  // At most two workers: the machine is shared (AGENTS.md).
  test: { testTimeout: 60_000, maxWorkers: 2 },
})
