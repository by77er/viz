import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

/** Where `test/independent.test.ts` leaves responses for the readers in `tools/promcheck`. Not committed. */
const CAPTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.capture')

// Tests run against `wrangler.test.jsonc`: the same classes as production, subclassed in
// `test/harness.ts` so the evaluator, sink, clock and outbound fetch are scriptable fakes.
// `CAPTURE` is a service binding answered here, in Node, so a test inside workerd can hand
// a file to the host (workerd has no file system).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        serviceBindings: {
          CAPTURE: async (request: Request) => {
            const name = new URL(request.url).pathname.slice(1)
            if (!/^(api|rulefile)\/[A-Za-z0-9._-]+$/.test(name)) return new Response('bad capture name', { status: 400 })
            const path = join(CAPTURE_DIR, name)
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, await request.text())
            return new Response('ok')
          },
        },
      },
    }),
  ],
  test: { testTimeout: 120_000 },
})
