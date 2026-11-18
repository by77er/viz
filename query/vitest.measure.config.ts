import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// The local measurement (`npm run measure`): the same one-script composition as the
// tests, with the production leaf pool size.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/wrangler.jsonc' }, miniflare: { bindings: { LEAF_POOL_SIZE: '32' } } })],
  test: { include: ['test/measure.bench.ts'], testTimeout: 1_800_000, hookTimeout: 1_800_000 },
})
