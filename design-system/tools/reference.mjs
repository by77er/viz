// Builds dist/reference.html: every component preview in both themes on one page, for review and screenshots.
// A component missing from `order` is appended, so a new component cannot be left out of the reference by accident.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
const root = new URL('..', import.meta.url).pathname
const css = readFileSync(root + 'dist/viz.css', 'utf8')
const order = ['Cover', 'Nav', 'PageHeader', 'Section', 'Button', 'Controls', 'Field', 'Segmented', 'Query', 'Tabs', 'Menu', 'Tooltip', 'Dialog', 'Secret', 'Table', 'Status', 'Number', 'Stat', 'KeyValue', 'Timeline', 'Panel', 'Chart', 'Waterfall', 'Log', 'Banner', 'Notice', 'Progress', 'Empty', 'FirstRun', 'Claim', 'Changes']
const found = readdirSync(root + 'project/components').filter((n) => existsSync(`${root}project/components/${n}/preview.html`))
const names = [...order.filter((n) => found.includes(n)), ...found.filter((n) => !order.includes(n))]
const body = (n) => { const h = readFileSync(`${root}project/components/${n}/preview.html`, 'utf8'); const style = (h.match(/<style>([\s\S]*?)<\/style>/g) ?? []).join(''); const scripts = h.match(/<script>[\s\S]*?<\/script>/g) ?? []; return { style, scripts, inner: h.slice(h.indexOf('<body'), h.lastIndexOf('</body>')).replace(/<body[^>]*>/, '').replace(/<script>[\s\S]*?<\/script>/g, '') } }
// Preview scripts run once for the whole page, after both columns exist; each must find its elements with querySelectorAll.
const scripts = [...new Set(names.flatMap((n) => body(n).scripts))].join('\n')
const col = (th) => `<div data-theme="${th}" class="vz side">${names.map((n) => { const b = body(n); return `<section><h2 class="vz-label">${n}</h2><div class="${n === 'Cover' ? 'coverwrap' : 'ex'}">${b.inner}</div></section>` }).join('')}</div>`
const extra = names.map((n) => body(n).style).join('').replace(/<\/?style>/g, '').replace(/html,body\{margin:0\}|body\{padding:[^}]*\}/g, '')
writeFileSync(root + 'dist/reference.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>viz reference</title><style>${css}
body{margin:0}.sheet{display:grid;grid-template-columns:1fr 1fr}.side{padding:32px;display:flex;flex-direction:column;gap:32px;min-width:0}
.side section{display:flex;flex-direction:column;gap:12px}.side h2{margin:0}.side section>div{min-width:0}.coverwrap{overflow:hidden}.coverwrap>.cover{zoom:.62}@media (max-width:900px){.coverwrap>.cover{zoom:.36}}
@media (max-width:900px){.sheet{grid-template-columns:1fr}}
${extra}</style></head><body><div class="sheet">${col('light')}${col('dark')}</div>${scripts}</body></html>`)
console.log('wrote dist/reference.html')
