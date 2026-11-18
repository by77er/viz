// Builds each screen in screens/*.html into ../dist/flows/<name>.html (viz.css inlined by link) and captures images.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const root = new URL('.', import.meta.url).pathname
const out = root + '../dist/flows/'
mkdirSync(out, { recursive: true }); mkdirSync(root + 'shots', { recursive: true })
const nav = (current) => `<nav class="vz-nav" aria-label="Sections"><span class="vz-nav-name">viz</span>${['Explore', 'Dashboards', 'Monitors', 'Traces', 'Logs'].map((n) => `<a href="#"${n === current ? ' aria-current="page"' : ''}>${n}</a>`).join('')}<span class="grow"></span><a href="#">acme-prod</a><a href="#">Settings</a></nav>`
// Deterministic line data so charts are drawn, not pasted.
const chart = `<script>
function line(id,opt){const svg=document.getElementById(id);if(!svg)return;const W=svg.clientWidth||640,H=opt.h||160,L=40,R=8,T=8,B=20;svg.setAttribute('viewBox','0 0 '+W+' '+H);svg.setAttribute('height',H);
let s=opt.seed||1;const rnd=()=>{s=(s*1664525+1013904223)%4294967296;return s/4294967296};const n=opt.n||60;let g='';
for(let i=0;i<=3;i++){const y=T+(H-T-B)*i/3;g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="var(--'+(i===3?'rule-control':'rule')+')"/><text x="'+(L-6)+'" y="'+(y+4)+'" text-anchor="end" style="font:var(--text-micro)" fill="var(--ink-muted)">'+opt.ticks[i]+'</text>'}
opt.x.forEach((t,i)=>{const x=L+(W-L-R)*i/(opt.x.length-1);g+='<text x="'+x+'" y="'+(H-4)+'" text-anchor="'+(i===0?'start':i===opt.x.length-1?'end':'middle')+'" style="font:var(--text-micro)" fill="var(--ink-muted)">'+t+'</text>'});
opt.series.forEach((se,k)=>{let v=se.base,p='';for(let i=0;i<n;i++){v+=(rnd()-.5)*se.noise;if(se.spike&&i>se.spike[0]&&i<se.spike[1])v=se.base+se.spike[2]+(rnd()-.5)*se.noise;const x=L+(W-L-R)*i/(n-1),y=T+(H-T-B)*(1-Math.max(0,Math.min(1,v)));p+=(i?' ':'')+x.toFixed(1)+','+y.toFixed(1)}
g+='<polyline fill="none" stroke="var(--series-'+(k+1)+')" stroke-width="2" stroke-linejoin="round" points="'+p+'"/>'});
if(opt.threshold!=null){const y=T+(H-T-B)*(1-opt.threshold);g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="var(--ink-muted)" stroke-dasharray="4 4"/>'}
svg.innerHTML=g}
</script>`
const css = `body{margin:0}.grow{flex:1}.page{padding:var(--space-6);display:flex;flex-direction:column;gap:var(--space-6);max-width:1440px}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-4);flex-wrap:wrap}.head h1{margin:0;font:var(--text-title);letter-spacing:var(--text-title-track)}
.sub{color:var(--ink-secondary);margin:var(--space-1) 0 0}.row{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap}.stack{display:flex;flex-direction:column;gap:var(--space-4);min-width:0}
.muted{color:var(--ink-muted)}.two{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:var(--space-8)}.kv{display:grid;grid-template-columns:auto 1fr;gap:var(--space-2) var(--space-4);margin:0}.kv dt{color:var(--ink-secondary)}.kv dd{margin:0}
h2.sec{font:var(--text-heading);letter-spacing:var(--text-heading-track);margin:0}svg.c{display:block;width:100%}
.claim{display:grid;grid-template-columns:auto 1fr;gap:var(--space-2) var(--space-3);padding:var(--space-3) 0;border-top:var(--hairline) solid var(--rule)}.claim p{margin:0}
.diff{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-6)}
@media (max-width:800px){.two,.diff{grid-template-columns:minmax(0,1fr)}.page{padding:var(--space-4)}} /* token-lint-ignore: breakpoint */`
const page = (name, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>viz · ${name}</title><link rel="stylesheet" href="../viz.css"><style>${css}</style>${chart}</head><body class="vz">${body}</body></html>`
const names = []
for (const f of readdirSync(root + 'screens').filter((x) => x.endsWith('.html')).sort()) {
  const src = readFileSync(root + 'screens/' + f, 'utf8')
  const current = (src.match(/<!-- nav: (\w+) -->/) ?? [])[1]
  writeFileSync(out + f, page(f.replace('.html', ''), nav(current) + src))
  names.push(f.replace('.html', ''))
}
console.log('built', names.join(', '))
if (process.argv.includes('--shots')) {
  const { chromium } = createRequire(import.meta.url)('playwright')
  const b = await chromium.launch()
  for (const n of names) for (const [theme, w] of [['light', 1440], ['dark', 1440], ['light', 400]]) {
    const p = await b.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: w === 400 ? 2 : 1, colorScheme: theme })
    await p.goto('file://' + out + n + '.html', { waitUntil: 'networkidle' })
    await p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await p.evaluate(() => document.fonts.ready)
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (over > 0) console.log('OVERFLOW', n, theme, w, over)
    await p.screenshot({ path: `${root}shots/${n}-${theme}-${w}.png`, fullPage: true })
    await p.close()
  }
  await b.close()
}
