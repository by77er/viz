import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Tests run in workerd against wrangler.test.jsonc (see the comment there).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      // Test-only signing key for control's OAuth client registrations (production: a Worker secret of viz-control).
      miniflare: { bindings: { OAUTH_CLIENT_KEY: 'test-only-oauth-registration-signing-key-not-a-secret' } },
    }),
  ],
  // At most two workers: the machine is shared (AGENTS.md).
  test: { include: ['test/*.test.ts'], testTimeout: 120_000, hookTimeout: 60_000, maxWorkers: 2 },
})
