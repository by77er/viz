import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The dev and preview servers proxy /api to the mock backend (or whatever VIZ_API_TARGET
// points at), so the app's default "same origin" base URL works without CORS.
const apiTarget = process.env.VIZ_API_TARGET ?? 'http://127.0.0.1:8821'
const proxy = { '/api': { target: apiTarget, changeOrigin: true } }

// The design system's generated bundle (tokens, components, fonts). main.tsx imports
// viz.css from here; Vite copies the two WOFF2 files into the build, so the app serves the
// fonts itself. `npm run design-system` (run before dev and build) generates the directory.
const designSystem = fileURLToPath(new URL('../design-system/dist', import.meta.url))
const SANS = 'SchibstedGrotesk-Variable'

/**
 * Puts `<link rel="preload" as="font">` for the sans file into index.html. The file name is
 * hashed by the build, so the link cannot be written by hand; it must be the same URL the
 * stylesheet uses or the font is fetched twice.
 */
function preloadSans(): Plugin {
  return {
    name: 'viz-preload-sans',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const built = ctx.bundle && Object.keys(ctx.bundle).find((f) => f.includes(SANS) && f.endsWith('.woff2'))
        const href = ctx.bundle ? (built ? `/${built}` : null) : `/@fs${designSystem}/fonts/${SANS}.woff2`
        if (!href) throw new Error('the sans font was not emitted: is design-system/dist built?')
        return [{ tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: '', href }, injectTo: 'head-prepend' }]
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), preloadSans()],
  server: { port: 8820, strictPort: true, proxy, fs: { allow: ['.', designSystem] } },
  preview: { port: 8820, strictPort: true, proxy },
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'mock/**/*.test.ts'] },
})
