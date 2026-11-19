import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      // The ledger drains when a test asks (`drain()`, `mirror`), not by itself 200 ms after a
      // commit, so segment boundaries are the same on every run (the golden fixtures depend on
      // them). A checkpoint every 3 segments puts `ckpt-` objects beside the segments of most
      // tests: the publisher must never read them.
      miniflare: { bindings: { LEDGER_DRAIN_DELAY_MS: '60000', LEDGER_CHECKPOINT_EVERY: '3' } },
    }),
  ],
  test: {
    // The benchmark (bench/) has its own configuration: vitest.bench.config.ts.
    include: ['test/**/*.test.ts'],
    // A shared machine (AGENTS.md): at most two test workers.
    maxWorkers: 2,
    // Runs in Node: a local sink that the end-to-end test dumps the simulated bucket into.
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 120_000,
  },
})
