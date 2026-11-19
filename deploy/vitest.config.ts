import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// The gateway's tests run in workerd against gateway/wrangler.test.jsonc. The deploy
// scripts' own tests are plain Node (`node --test test/`).
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './gateway/wrangler.test.jsonc' } })],
  test: { include: ['gateway/test/**/*.test.ts', 'stage/*.test.ts'], testTimeout: 60_000, maxWorkers: 2 },
})
