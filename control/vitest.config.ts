import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Test-only signing key for OAuth client registrations (production sets OAUTH_CLIENT_KEY as a Worker secret).
      miniflare: { bindings: { OAUTH_CLIENT_KEY: 'test-only-oauth-registration-signing-key-not-a-secret' } },
    }),
  ],
  // At most two workers: the machine is shared (AGENTS.md).
  test: { testTimeout: 60_000, maxWorkers: 2 },
})
