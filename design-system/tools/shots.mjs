// Before/after images for design review.
//   node tools/shots.mjs capture <url> <outDir> [name]     -> <name>-{light,dark}-{1440,400}.png
//   node tools/shots.mjs compare <beforeDir> <afterDir> <outDir>  -> one labelled side-by-side PNG per image name
// Capture "before" from the base branch and "after" from the change, with the same data and state.
import { readdirSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const [cmd, a, b, c] = process.argv.slice(2)
const browser = await chromium.launch()
if (cmd === 'capture') {
  mkdirSync(b, { recursive: true })
  for (const theme of ['light', 'dark']) for (const width of [1440, 400]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: theme })
    await page.goto(a.includes('://') ? a : 'file://' + resolve(a), { waitUntil: 'networkidle' })
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.evaluate(() => document.fonts.ready)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (overflow > 0) console.log(`WARN ${theme} ${width}: page scrolls sideways by ${overflow}px`)
    await page.screenshot({ path: join(b, `${c ?? 'view'}-${theme}-${width}.png`), fullPage: true })
    await page.close()
  }
} else if (cmd === 'compare') {
  mkdirSync(c, { recursive: true })
  const uri = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64')
  for (const f of readdirSync(b).filter((x) => x.endsWith('.png'))) {
    let before
    try { before = uri(join(a, f)) } catch { before = null }
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
    await page.setContent(`<body style="margin:0;padding:24px;background:#fff;font:14px Georgia,serif;color:#111"><div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start">
      <div><div style="margin-bottom:8px">Before · ${f}</div>${before ? `<img src="${before}" style="width:100%;border:1px solid #e4e4e4">` : '<div style="padding:48px;border:1px solid #e4e4e4">New view: nothing to compare.</div>'}</div>
      <div><div style="margin-bottom:8px">After · ${f}</div><img src="${uri(join(b, f))}" style="width:100%;border:1px solid #e4e4e4"></div></div></body>`)
    await page.screenshot({ path: join(c, f), fullPage: true })
    await page.close()
  }
} else console.log('usage: shots.mjs capture <url> <outDir> [name] | compare <beforeDir> <afterDir> <outDir>')
await browser.close()
