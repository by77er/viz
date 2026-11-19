import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // The ledger writes its change log in the background, 200 ms after a commit by default
      // (contracts/LEDGER-LOG.md, "Drain"). Here it drains only when a test asks (`drain()`,
      // or `flushSettled` in flush/test/helpers.ts), as in ledger/'s own suite, so what one
      // flush run sees of the logged watermark does not depend on timing.
      miniflare: { bindings: { LEDGER_DRAIN_DELAY_MS: '60000' } },
    }),
  ],
  // Integration tests in workerd, on a machine shared with other suites (AGENTS.md).
  test: { testTimeout: 60_000 },
})
