import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Tests run against `wrangler.test.jsonc`: the same classes as production, subclassed in
// `test/harness.ts` so the evaluator, sink, clock and outbound fetch are scriptable fakes.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  test: { testTimeout: 120_000 },
})
