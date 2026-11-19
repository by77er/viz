import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { configDefaults, defineConfig } from 'vitest/config'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * For tools/signals_readback.mjs: the requests of an OTLP corpus (edge/scripts/otel-corpus.mjs
 * with `--requests`), read here in Node and handed to test/signals.test.ts as one binding.
 * Absent unless SIGNALS_CORPUS names a corpus directory.
 */
function signalsCorpus(): Record<string, string> {
  const dir = process.env.SIGNALS_CORPUS
  if (!dir || !existsSync(join(dir, 'requests'))) return {}
  const index = JSON.parse(readFileSync(join(dir, 'requests', 'index.json'), 'utf8')) as { file: string; path: string; contentType: string; contentEncoding?: string }[]
  const requests = index.map((r) => ({ ...r, body: readFileSync(join(dir, 'requests', r.file)).toString('base64') }))
  return { SIGNALS_CORPUS_REQUESTS: JSON.stringify(requests), SIGNALS_CORPUS_NOW_MS: readFileSync(join(dir, 'requests', 'now_ms'), 'utf8').trim() }
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      // wrangler.jsonc with the publisher in the script instead of bound by script_name.
      wrangler: { configPath: './wrangler.test.jsonc' },
      // The soak's length and seed, as bindings, so they are read when the test runs
      // (`SOAK_STEPS=3000 npx vitest run test/soak.test.ts`).
      // SOAK_SIGNALS: `off` (the metrics soak as it always ran), `on` (with spans and logs), or both (default).
      miniflare: { bindings: { SOAK_STEPS: process.env.SOAK_STEPS ?? '400', SOAK_SEED: process.env.SOAK_SEED ?? '20261118', SOAK_SIGNALS: process.env.SOAK_SIGNALS ?? 'off,on', ...signalsCorpus() } },
    }),
  ],
  // The suites share four cores with each other and with the soak. test/gateway/ runs in a
  // script of its own (vitest.gateway.config.ts: the gateway, ingest and query together).
  test: { testTimeout: 120_000, exclude: [...configDefaults.exclude, 'test/gateway/**'] },
})
