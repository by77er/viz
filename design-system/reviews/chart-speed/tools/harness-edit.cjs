// Applies the harness change (no DevTools copy of response bodies during timed runs) to ab.cjs or app/e2e/measure.cjs, in place.
//   node harness-edit.cjs <file>
const fs = require('node:fs')
const file = process.argv[2]
let s = fs.readFileSync(file, 'utf8')
const rep = (a, b) => { if (!s.includes(a)) throw new Error(`${file}: not found: ${a.slice(0, 80)}`); s = s.replace(a, b) }
const isAb = s.includes('const BUILDS =')
const HELPER = `/**
 * DevTools keeps no copy of response bodies during timed runs (2026-11-28, design-system/reviews/chart-speed/PR.md).
 * With the Network domain enabled (Playwright enables it for every page, and this script enables it again in its own session for the
 * network shaping), each of those two agents buffers every response body and, when the load finishes, decodes it on the page's main
 * thread for Network.getResponseBody: at 4x CPU about 70 ms for the 200-series body (3.4 MB), between the last byte and the page's next
 * task. A browser without DevTools open does no such work, so a timed run must not either: both agents are enabled with no buffer.
 * Playwright's own session is not a public interface, so if it cannot be reached the run stops (it never measures with the buffers
 * silently), and every run checks afterwards that neither agent holds the query's body (r.bodyCopies: both false).
 * --buffer keeps the buffers, as this script measured until 2026-11-27 (figures taken so are not comparable with later ones).
 */
const BUFFER = process.argv.includes('--buffer')
const NO_BUFFERS = { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }
async function networkWithoutCopies(page, cdp) {
  await cdp.send('Network.enable', BUFFER ? {} : NO_BUFFERS)
  if (BUFFER) return
  let client
  try {
    const impl = page._connection.toImpl(page)
    client = (impl.delegate || impl._delegate)._mainFrameSession._client
  } catch (e) {
    throw new Error(\`cannot reach Playwright's own DevTools session (\${e.message}): its body buffer cannot be turned off; run with --buffer and say so\`)
  }
  await client.send('Network.enable', NO_BUFFERS)
}
/** Whether DevTools (this script's session, and Playwright's) kept a copy of the last query_range body: both false unless --buffer. */
function watchCopies(page, cdp) {
  const w = { id: null, res: null }
  cdp.on('Network.responseReceived', (e) => { if (e.response.url.includes('query_range')) w.id = e.requestId })
  page.on('response', (res) => { if (res.url().includes('query_range')) w.res = res })
  return async () => ({
    devtools: w.id ? await cdp.send('Network.getResponseBody', { requestId: w.id }).then(() => true, () => false) : null,
    playwright: w.res ? await w.res.body().then(() => true, () => false) : null,
  })
}
`
if (isAb) {
  rep("const NOBUFFER = process.argv.includes('--nobuffer')\n", HELPER)
  rep("      // --nobuffer: DevTools keeps no copy of response bodies (neither this session's Network agent nor Playwright's own)\n      if (NOBUFFER) { const impl = page._connection.toImpl(page); await (impl.delegate || impl._delegate)._mainFrameSession._client.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }) } else await cdp.send('Network.enable')\n",
    "      await networkWithoutCopies(page, cdp)\n      const copies = watchCopies(page, cdp)\n")
  rep("${NOBUFFER ? '; DevTools keeps no copy of response bodies' : ''}", "${BUFFER ? '; DevTools buffers response bodies (--buffer, as before 2026-11-28)' : '; DevTools keeps no copy of response bodies'}")
  rep("      const r = { build: B.name,", "      const r = { build: B.name,")
} else {
  rep("const PHONE = process.argv.includes('--phone')\n", "const PHONE = process.argv.includes('--phone')\n" + HELPER)
  rep("      await cdp.send('Network.enable')\n      await cdp.send('Network.emulateNetworkConditions', FAST_4G)", "      await networkWithoutCopies(page, cdp)\n      const copies = watchCopies(page, cdp)\n      await cdp.send('Network.emulateNetworkConditions', FAST_4G)")
  rep("const setup = `Chromium, CPU 4x, Fast 4G, ${PHONE ? '400x800, coarse pointer, touch, device scale 2' : '1440x900, fine pointer'}, fresh context per run`", "const setup = `Chromium, CPU 4x, Fast 4G, ${PHONE ? '400x800, coarse pointer, touch, device scale 2' : '1440x900, fine pointer'}, fresh context per run${BUFFER ? '; DevTools buffers response bodies (--buffer, as before 2026-11-28)' : '; DevTools keeps no copy of response bodies'}`")
}
// After the result's paint is taken: did either agent keep the body?
rep("      r.clsRunAll = shifts.reduce((a, s) => a + s.value, 0)\n", "      r.clsRunAll = shifts.reduce((a, s) => a + s.value, 0)\n      r.bodyCopies = await copies()\n      if (!BUFFER && (r.bodyCopies.devtools || r.bodyCopies.playwright)) throw new Error(`DevTools kept a copy of the body although its buffers are off: ${JSON.stringify(r.bodyCopies)}`)\n")
// the definition of responseFull in the header
rep("//               query_range request) -> the same paint. This one includes decoding and parsing\n//               the body: 3.6 MB of JSON for 200 series.\n",
  "//               query_range request) -> the same paint. This one includes decoding and parsing\n//               the body: 3.6 MB of JSON for 200 series. Since 2026-11-28 DevTools keeps no copy of\n//               the body during these runs (networkWithoutCopies; --buffer for the earlier way):\n//               with its copies this figure carried about 70 ms at 200 series that no browser\n//               without DevTools spends.\n")
fs.writeFileSync(file, s)
console.log('edited', file)
