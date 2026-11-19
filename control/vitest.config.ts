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
        // Rate Limiting bindings (D70) as miniflare implements them, under test names with small limits.
        // The tests put them in place of the OAUTH_RL_* bindings (test/ratelimit.test.ts); every other
        // test runs without them, as a deployment without the bindings does (each check fails open).
        ratelimits: {
          RL_TEST_SOURCE: { namespace_id: '9001', simple: { limit: 5, period: 60 } },
          RL_TEST_CLIENT: { namespace_id: '9002', simple: { limit: 3, period: 60 } },
          RL_TEST_TENANT: { namespace_id: '9003', simple: { limit: 6, period: 60 } },
          RL_TEST_BEARER: { namespace_id: '9004', simple: { limit: 3, period: 60 } },
          RL_TEST_BEARER_TENANT: { namespace_id: '9005', simple: { limit: 5, period: 60 } },
          // A 10 s window, to see a limit reset within a test.
          RL_TEST_10S: { namespace_id: '9006', simple: { limit: 2, period: 10 } },
        },
      },
    }),
  ],
  // At most two workers: the machine is shared (AGENTS.md).
  test: { testTimeout: 60_000, maxWorkers: 2 },
})
