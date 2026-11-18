import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The dev and preview servers proxy /api to the mock backend (or whatever VIZ_API_TARGET
// points at), so the app's default "same origin" base URL works without CORS.
const apiTarget = process.env.VIZ_API_TARGET ?? 'http://127.0.0.1:8821'
const proxy = { '/api': { target: apiTarget, changeOrigin: true } }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 8820, strictPort: true, proxy },
  preview: { port: 8820, strictPort: true, proxy },
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'mock/**/*.test.ts'] },
})
