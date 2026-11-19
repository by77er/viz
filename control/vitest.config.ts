import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Test-only signing key for OAuth client registrations (production sets OAUTH_CLIENT_KEY as a Worker secret).
      miniflare: {
        bindings: { OAUTH_CLIENT_KEY: 'test-only-oauth-registration-signing-key-not-a-secret' },
        // The OAuthIntrospection entrypoint as callers reach it (contracts/oauth.ts): a service binding
        // naming it, with the caller in props. The agent surface's, another viz Worker's, and one without props.
        serviceBindings: {
          MCP_OAUTH: { name: 'viz-control', entrypoint: 'OAuthIntrospection', props: { caller: 'viz-mcp' } },
          RULER_OAUTH: { name: 'viz-control', entrypoint: 'OAuthIntrospection', props: { caller: 'viz-ruler' } },
          BARE_OAUTH: { name: 'viz-control', entrypoint: 'OAuthIntrospection' },
        },
      },
    }),
  ],
  // At most two workers: the machine is shared (AGENTS.md).
  test: { testTimeout: 60_000, maxWorkers: 2 },
})
