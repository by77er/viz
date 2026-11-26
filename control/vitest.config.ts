import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { experimental_readRawConfig } from 'wrangler'

/**
 * The Worker's own wrangler.jsonc, less its `ratelimits` (D70): the deploy declares the six OAuth
 * limiters there with production limits and placeholder namespace ids, and the plugin would bind them
 * in every test file (it merges bindings by name, so they cannot be unset below). The tests want them
 * absent unless a test puts its own in place (test/ratelimit*.test.ts, with the small RL_TEST_*
 * limits below), as a deployment without the bindings runs. Everything else is read from the file as
 * it is. Written to `.wrangler/test/wrangler.json` (git-ignored), which no release reads.
 */
function testWranglerConfig(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const { rawConfig } = experimental_readRawConfig({ config: join(here, 'wrangler.jsonc') })
  const { ratelimits: _ratelimits, ...rest } = rawConfig as Record<string, unknown>
  // In this checkout's .wrangler/ (git-ignored), not node_modules, which a scratch copy may share by link.
  const out = join(here, '.wrangler', 'test', 'wrangler.json')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ ...rest, main: resolve(here, String(rest.main)) }, null, 2))
  return out
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: testWranglerConfig() },
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
        // The tests put them in place of the OAUTH_RL_* bindings (test/ratelimit*.test.ts); every other
        // test runs without them, as a deployment without the bindings does (each check fails open).
        // The tenant fuses are 4 times the per-credential limits, as in production they are many
        // times them (25 at introspection, 1,200 at the token endpoint): one credential cannot spend one.
        ratelimits: {
          RL_TEST_SOURCE: { namespace_id: '9001', simple: { limit: 5, period: 60 } },
          RL_TEST_SOURCE_48: { namespace_id: '9007', simple: { limit: 8, period: 60 } },
          RL_TEST_CREDENTIAL: { namespace_id: '9002', simple: { limit: 3, period: 60 } },
          RL_TEST_TENANT: { namespace_id: '9003', simple: { limit: 12, period: 60 } },
          RL_TEST_BEARER: { namespace_id: '9004', simple: { limit: 3, period: 60 } },
          RL_TEST_BEARER_TENANT: { namespace_id: '9005', simple: { limit: 12, period: 60 } },
          // A 10 s window, to see a limit reset within a test.
          RL_TEST_10S: { namespace_id: '9006', simple: { limit: 2, period: 10 } },
        },
      },
    }),
  ],
  // At most two workers: the machine is shared (AGENTS.md).
  test: { testTimeout: 60_000, maxWorkers: 2 },
})
