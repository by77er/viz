import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { APP_VAR, appVar, readBuild, readServe } from './lib/app.mjs'

// The gateway's tests run in workerd against gateway/wrangler.test.jsonc. The deploy
// scripts' own tests are plain Node (`node --test test/`).
//
// The web app (D74): the test Worker gets VIZ_APP exactly as deploy/configure.mjs would give it,
// made by the same code (lib/app.mjs) from the real app/serve.json, read now, and a small fixture
// build. gateway/test/app.test.ts reads serve.json too and holds the Worker to it.
const at = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const serve = readServe(at('../app/serve.json'))
const app = appVar(serve, readBuild(at('./test/fixtures/app-build'), serve))

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './gateway/wrangler.test.jsonc' }, miniflare: { bindings: { [APP_VAR]: app } } })],
  test: { include: ['gateway/test/**/*.test.ts', 'stage/*.test.ts'], testTimeout: 60_000, maxWorkers: 2 },
})
