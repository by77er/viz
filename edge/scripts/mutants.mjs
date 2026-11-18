// Mutation check: break one behaviour at a time, run the suite, expect it to FAIL, restore.
//   node scripts/mutants.mjs
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const mutants = [
  ['tenant taken from a header', 'src/index.ts',
    "const { tenant } = await authenticate(req, env.CONFIG, 'write')\n\n  const contentType",
    "const tenant = req.headers.get('X-Scope-OrgID') ?? (await authenticate(req, env.CONFIG, 'write')).tenant\n\n  const contentType"],
  ['ack before the appends complete', 'src/route.ts',
    'return { results: await Promise.all(pending), batches }',
    "void Promise.all(pending)\n  return { results: [{ status: 'ok', incarnation: 0, seq: 0, duplicate: false }], batches }"],
  ['fingerprint not derived from the batch (random)', 'src/route.ts',
    'const fingerprint = await sha256Hex(b.bytes)', 'const fingerprint = crypto.randomUUID()'],
  ['fingerprint constant per request', 'src/route.ts',
    'const fingerprint = await sha256Hex(b.bytes)', "const fingerprint = await sha256Hex(new Uint8Array(1))"],
  ['wrong routing key (job only)', 'src/batch.ts',
    'this.routes.push(`job=${utf8.decode(buf.subarray(js, je))}\\u0000instance=${utf8.decode(buf.subarray(is, ie))}`)', 'this.routes.push(`job=${utf8.decode(buf.subarray(js, je))}`)'],
  ['routing by series instead of sender', 'src/route.ts',
    'slotOfSeries[i] = slotOfRoute[c.routeOf[i]!]!', 'slotOfSeries[i] = slotFor(map, tenant, c.routes[c.routeOf[i]!]! + i)'],
  ['accept expired timestamps', 'src/batch.ts', 'if (!(ts >= this.minTs)) {', 'if (Number.isNaN(ts)) {'],
  ['accept timestamps far in the future', 'src/batch.ts', 'if (!(ts <= this.maxTs)) {', 'if (Number.isNaN(ts)) {'],
  ['2xx on backpressure', 'src/route.ts',
    "if (retryAfterMs > 0) return { status: 'backpressure', retryAfterMs }", ''],
  ['2xx on shard error', 'src/route.ts',
    "if (results.some((r) => r.status === 'error')) return { status: 'unavailable', reason: 'shard unavailable' }", ''],
  ['no map refetch on stale_epoch', 'src/route.ts',
    'const fresh = await poolMap(env, tenant, true)', 'const fresh = await poolMap(env, tenant, false)'],
  ['stale_epoch ignored (2xx)', 'src/route.ts', "const stale = results.find((r) => r.status === 'stale_epoch')", 'const stale = undefined'],
  ['secret not checked', 'src/auth.ts', 'if (!record || !match || record.disabled)', 'if (!record || record.disabled)'],
  ['disabled keys accepted', 'src/auth.ts', 'if (!record || !match || record.disabled)', 'if (!record || !match)'],
  ['scope not checked', 'src/auth.ts', 'if (!record.scopes.includes(scope))', 'if (false)'],
  ['labels not sorted', 'src/batch.ts', 'if (c < 0) break\n        order[j] = order[j - 1]!\n        j--', 'break'],
  ['empty-valued labels kept', 'src/batch.ts', 'if (valueLen === 0) continue\n      if (nameLen === 0)', 'if (nameLen === 0)'],
  ['series id: missing separator after value', 'src/batch.ts',
    "      {\n        hi = (Math.imul(hi, 435) + (lo << 8) + (((lo >>> 16) * 435 + (((lo & 0xffff) * 435) >>> 16)) >>> 16)) | 0\n        lo = Math.imul(lo, 435)\n      }\n      const nameLen = ne - ns",
    '      const nameLen = ne - ns'],
  ['series id: carry between halves dropped', 'src/batch.ts',
    "hi = (Math.imul(hi, 435) + (lo << 8) + (((lo >>> 16) * 435 + (((lo & 0xffff) * 435) >>> 16)) >>> 16)) | 0\n        lo = Math.imul(lo, 435)\n      }\n      out[p] = (ve - vs) & 255",
    "hi = (Math.imul(hi, 435) + (lo << 8)) | 0\n        lo = Math.imul(lo, 435)\n      }\n      out[p] = (ve - vs) & 255"],
  ['histograms silently dropped (OTLP)', 'src/otlp.ts',
    "if (field === 9) m.rejectPoints('histograms are not supported', points.length)", 'if (field === 9) continue'],
  ['delta sums stored as if cumulative', 'src/otlp.ts', 'if (sum && temporality !== CUMULATIVE) {', 'if (sum && temporality === 0) {'],
  ['Remote Write 204 despite rejected samples', 'src/index.ts', 'if (c.rejectedTotal > 0) {', 'if (false) {'],
  ['NaN payload lost (value through a JS number)', 'src/batch.ts',
    'for (let i = 0; i < 8; i++) v[p + i] = src[off + i]!',
    'this.valView.setFloat64(p, Number.isNaN(new DataView(src.buffer, src.byteOffset).getFloat64(off, true)) ? NaN : new DataView(src.buffer, src.byteOffset).getFloat64(off, true), true)'],
  ['batches not split under the DO value limit', 'src/batch.ts', 'if (n > 1 && pad8(16 + table) + pad8(4 * n) + 16 * n > maxBatchBytes) break', ''],
  ['decompressed size limit not enforced (snappy)', 'src/snappy.ts', 'if (len > maxLen) throw', 'if (false) throw'],
  ['snappy copy bounds not checked', 'src/snappy.ts', 'if (offset === 0 || offset > op || op + l > len) throw', 'if (false) throw'],
]

const only = process.argv[2]
let survived = 0
for (const [name, file, from, to] of mutants) {
  if (only && !name.includes(only)) continue
  const original = readFileSync(file, 'utf8')
  if (!original.includes(from)) {
    console.log(`NOT APPLIED  ${name} (pattern not found in ${file})`)
    survived++
    continue
  }
  writeFileSync(file, original.replace(from, to))
  let failed = false
  let detail = ''
  try {
    execSync('npx vitest run', { stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  } catch (e) {
    failed = true
    const out = String(e.stdout) + String(e.stderr)
    detail = [...out.matchAll(/^\s+× (.+?)(?: \d+ms)?$/gm)].map((m) => m[1]).slice(0, 3).join(' | ') || (out.match(/Error: .*/)?.[0] ?? '')
  } finally {
    writeFileSync(file, original)
  }
  if (!failed) survived++
  console.log(`${failed ? 'KILLED  ' : 'SURVIVED'}  ${name}${detail ? `  ← ${detail}` : ''}`)
}
console.log(survived === 0 ? 'all mutants killed' : `${survived} mutant(s) survived`)
process.exit(survived === 0 ? 0 : 1)
