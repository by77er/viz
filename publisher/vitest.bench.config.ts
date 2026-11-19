import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// `npm run bench`: the re-base benchmark (bench/rebase.bench.test.ts) and the capped upgrade
// (bench/upgrade.bench.test.ts). Not part of `npm test`.
//   BENCH_SIZES=8000,32000 BENCH_VARIANTS=base,parts,one,before BENCH_STEPS=first,rebase,more,resync npm run bench -- bench/rebase.bench.test.ts
//   BENCH_UPGRADE=8x25000@100000 npm run bench -- bench/upgrade.bench.test.ts
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.bench.jsonc' },
      miniflare: { bindings: { BENCH_SIZES: process.env.BENCH_SIZES ?? '', BENCH_VARIANTS: process.env.BENCH_VARIANTS ?? '', BENCH_STEPS: process.env.BENCH_STEPS ?? '', BENCH_UPGRADE: process.env.BENCH_UPGRADE ?? '', BENCH_FIRST_CAPPED: process.env.BENCH_FIRST_CAPPED ?? '' } },
    }),
  ],
  test: { include: ['bench/**/*.bench.test.ts'], testTimeout: 3_600_000, maxWorkers: 1 },
})
