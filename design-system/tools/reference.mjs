// Builds dist/reference.html: every component preview in both themes on one page, for review and screenshots.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
const root = new URL('..', import.meta.url).pathname
const css = readFileSync(root + 'dist/viz.css', 'utf8')
const order = ['Cover', 'Nav', 'Button', 'Field', 'Segmented', 'Query', 'Tabs', 'Menu', 'Tooltip', 'Dialog', 'Table', 'Status', 'Stat', 'Panel', 'Banner', 'Progress', 'Empty']
const names = order.filter((n) => existsSync(`${root}project/components/${n}/preview.html`))
const body = (n) => { const h = readFileSync(`${root}project/components/${n}/preview.html`, 'utf8'); const style = (h.match(/<style>([\s\S]*?)<\/style>/g) ?? []).join(''); return { style, inner: h.slice(h.indexOf('<body'), h.lastIndexOf('</body>')).replace(/<body[^>]*>/, '') } }
const col = (th) => `<div data-theme="${th}" class="vz side">${names.map((n) => { const b = body(n); return `<section><h2 class="vz-label">${n}</h2><div class="${n === 'Cover' ? 'coverwrap' : 'ex'}">${b.inner}</div></section>` }).join('')}</div>`
const extra = names.map((n) => body(n).style).join('').replace(/<\/?style>/g, '').replace(/html,body\{margin:0\}|body\{padding:24px\}/g, '')
writeFileSync(root + 'dist/reference.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>viz reference</title><style>${css}
body{margin:0}.sheet{display:grid;grid-template-columns:1fr 1fr}.side{padding:32px;display:flex;flex-direction:column;gap:32px;min-width:0}
.side section{display:flex;flex-direction:column;gap:12px}.side h2{margin:0}.side section>div{min-width:0}.coverwrap{overflow:hidden}.coverwrap>.cover{zoom:.62}@media (max-width:900px){.coverwrap>.cover{zoom:.36}}
@media (max-width:900px){.sheet{grid-template-columns:1fr}}
${extra}</style></head><body><div class="sheet">${col('light')}${col('dark')}</div></body></html>`)
console.log('wrote dist/reference.html')
