import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  // bench/ has its own config (`npm run bench`).
  test: { exclude: ['bench/**', 'node_modules/**'] },
})
