// Temporary dev-server config for design-review screenshots: the normal config plus a script
// that opens popovers and dialogs when the URL carries #shot=<state> (see shot-inject.js).
//   VIZ_API_TARGET=http://127.0.0.1:8841 npx vite --config e2e/vite.shots.config.ts --port 8840
import { readFileSync } from 'node:fs'
import { mergeConfig, type Plugin } from 'vite'
import base from '../vite.config'

const inject: Plugin = {
  name: 'viz-shot-inject',
  transformIndexHtml: () => [
    { tag: 'script', children: readFileSync(new URL('./shot-inject.js', import.meta.url), 'utf8'), injectTo: 'body' },
  ],
}

export default mergeConfig(base, { plugins: [inject] })
