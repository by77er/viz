import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      // The drain runs when a test asks (`drain()`, `runDurableObjectAlarm`), not on its own
      // 200 ms after a commit; `test/segments.test.ts` checks the default timing separately.
      miniflare: { bindings: { LEDGER_DRAIN_DELAY_MS: '60000' } },
    }),
  ],
  // bench/ has its own config (`npm run bench`).
  // The machine is shared: the rebuild tests take 1–3 s alone and over 20 s while other
  // suites run (measured 2026-11-19, load average 12 on four cores), so the default 5 s
  // limit fails them for the machine's sake, not the code's.
  test: { exclude: ['bench/**', 'node_modules/**'], testTimeout: 60_000 },
})
