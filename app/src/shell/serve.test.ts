import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * serve.json tells the gateway which paths are the app's documents. A route the router has
 * and the list lacks would be the gateway's JSON 404 on a reload or a shared link, so the two
 * are compared here: every route in src/router.tsx, and the index, is a document.
 */
describe('what the gateway serves (serve.json)', () => {
  const serve = JSON.parse(readFileSync(new URL('../../serve.json', import.meta.url), 'utf8')) as { documents: string[]; headers: Record<string, Record<string, string>> }
  const router = readFileSync(new URL('../router.tsx', import.meta.url), 'utf8')
  it('lists every route of the router as a document', () => {
    const routes = [...router.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]!)
    expect(routes.length).toBeGreaterThanOrEqual(4)
    expect([...serve.documents].sort()).toEqual([...routes].sort())
  })
  it('the policy allows scripts, styles, fonts and requests from the page\'s own origin only, and no inline script', () => {
    const csp = serve.headers.document!['Content-Security-Policy']!
    const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(' ')]))
    expect(directives['default-src']).toBe("'none'")
    expect(directives['script-src']).toBe("'self'")
    expect(directives['connect-src']).toBe("'self'")
    expect(directives['frame-ancestors']).toBe("'none'")
    expect(directives['form-action']).toBe("'none'")
    expect(csp).not.toMatch(/unsafe-eval|\*|https?:|data:/)
    // The one allowance: inline styles. The query editor (CodeMirror) writes its styles as <style> elements and the design system's chart
    // writes its legend's column widths as style attributes; neither can carry a nonce from a static file. Scripts have no such allowance.
    expect(csp.match(/unsafe-inline/g)).toHaveLength(1)
    expect(directives['style-src']).toBe("'self' 'unsafe-inline'")
  })
  it('the document is revalidated on every load and hashed assets are kept for good', () => {
    expect(serve.headers.document!['Cache-Control']).toBe('no-cache')
    expect(serve.headers.asset!['Cache-Control']).toBe('public, max-age=31536000, immutable')
  })
})
