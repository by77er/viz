import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The dev and preview servers proxy /api to the mock backend (or whatever VIZ_API_TARGET
// points at), so the app's "same origin" API address works as it does behind the gateway.
const apiTarget = process.env.VIZ_API_TARGET ?? 'http://127.0.0.1:8821'
const proxy = { '/api': { target: apiTarget, changeOrigin: true } }

// The design system's generated bundle (tokens, components, fonts, the chart and the press
// script). main.tsx imports viz.css from here and charts/systemChart.ts the two scripts; Vite
// copies the two WOFF2 files into the build, so the app serves everything itself.
// `npm run design-system` generates the directory; dev and build make sure it is there
// (scripts/ensure-design-system.mjs).
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

/**
 * The stored theme has to be applied before first paint, which takes a script that blocks the
 * parser. The page's content security policy allows scripts from its own origin only
 * (README, "Needed changes in deploy/"), so it cannot be inline: the build emits
 * src/theme-init.js as an asset with a content hash, cached like every other asset, and puts
 * its tag first in the head. The dev server serves the source file.
 */
function themeScript(): Plugin {
  const file = fileURLToPath(new URL('./src/theme-init.js', import.meta.url))
  return {
    name: 'viz-theme-script',
    buildStart() {
      if (this.meta.watchMode) return
      this.emitFile({ type: 'asset', name: 'theme.js', source: readFileSync(file, 'utf8') })
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const built = ctx.bundle && Object.keys(ctx.bundle).find((f) => /(^|\/)theme-[^/]+\.js$/.test(f))
        if (ctx.bundle && !built) throw new Error('the theme script was not emitted')
        const src = built ? `/${built}` : '/src/theme-init.js'
        return [{ tag: 'script', attrs: { src }, injectTo: 'head-prepend' }]
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), preloadSans(), themeScript()],
  server: { port: 8820, strictPort: true, proxy, fs: { allow: ['.', designSystem] } },
  preview: { port: 8820, strictPort: true, proxy },
  build: { target: 'es2022', sourcemap: false },
  // At most two workers: the machine is shared (AGENTS.md, "Shared machine").
  test: { environment: 'node', include: ['src/**/*.test.ts', 'mock/**/*.test.ts'], maxWorkers: 2 },
})
