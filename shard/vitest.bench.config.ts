import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// `npm run bench`: shard saturation, as built vs early refusal + group commit (bench/README.md). Not part of `npm test`.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.bench.jsonc' }, miniflare: { bindings: { BENCH: process.env.BENCH ?? '' } } })],
  test: { include: ['bench/**/*.bench.test.ts'], testTimeout: 1_800_000, maxWorkers: 1 },
})
