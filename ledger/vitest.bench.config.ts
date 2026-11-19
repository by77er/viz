import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// `npm run bench`: the ledger admission and rebuild benchmarks (bench/README.md). Not part of `npm test`.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.bench.jsonc' }, miniflare: { bindings: { BENCH: process.env.BENCH ?? '', BENCH_SIZES: process.env.BENCH_SIZES ?? '', BENCH_VARIANTS: process.env.BENCH_VARIANTS ?? '' } } })],
  test: { include: ['bench/**/*.bench.test.ts'], testTimeout: 1_800_000, maxWorkers: 1 },
})
