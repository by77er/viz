// Mutation check: break one behaviour at a time, run the suite, expect it to FAIL, restore.
//   node scripts/mutants.mjs [substring of a mutant name]      (from edge/, in a COPY)
//   node scripts/mutants.mjs --check                            only check that every pattern applies
//
// AGENTS.md (Evidence): mutants are applied to a COPY in a scratch area, never in place in the
// shared checkout. The script refuses to run inside a git checkout: copy `contracts/`,
// `shard/` and `edge/` (with links to their node_modules) elsewhere and run it there.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const check = process.argv[2] === '--check'
if (!check && existsSync(`${ROOT}.git`)) {
  console.error(`mutants: ${ROOT} is a git checkout. Run this on a copy in a scratch directory (AGENTS.md, Evidence).`)
  process.exit(2)
}
process.chdir(`${ROOT}edge`)

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
    "if (field === 9) m.rejectPoints('histograms are not supported', points)", 'if (field === 9) {}'],
  ['delta sums stored as if cumulative', 'src/otlp.ts', 'if (sum && temporality !== CUMULATIVE) {', 'if (sum && temporality === 0) {'],
  ['Remote Write 204 despite rejected samples', 'src/index.ts', 'if (c.rejectedTotal > 0) {', 'if (false) {'],
  ['NaN payload lost (value through a JS number)', 'src/batch.ts',
    'for (let i = 0; i < 8; i++) v[p + i] = src[off + i]!',
    'this.valView.setFloat64(p, Number.isNaN(new DataView(src.buffer, src.byteOffset).getFloat64(off, true)) ? NaN : new DataView(src.buffer, src.byteOffset).getFloat64(off, true), true)'],
  ['batches not split under the DO value limit', 'src/batch.ts', 'if (n > 1 && pad8(16 + table) + pad8(4 * n) + 16 * n > maxBatchBytes) break', ''],
  ['decompressed size limit not enforced (snappy)', 'src/snappy.ts', 'if (len > maxLen) throw', 'if (false) throw'],
  ['snappy copy bounds not checked', 'src/snappy.ts', 'if (offset === 0 || offset > op || op + l > len) throw', 'if (false) throw'],
  // contracts v2
  ['labels sorted in JavaScript string order instead of UTF-8 bytes', 'src/batch.ts',
    'const c = cmpBytes(buf, offs[p]!, offs[p + 1]!, offs[o]!, offs[o + 1]!)',
    'const sa = utf8.decode(buf.subarray(offs[p]!, offs[p + 1]!)), sb = utf8.decode(buf.subarray(offs[o]!, offs[o + 1]!))\n        const c = sa < sb ? -1 : sa > sb ? 1 : 0'],
  ['timestamps before 1970 accepted', 'src/batch.ts', 'Math.max(now - limits.acceptBackMs, CONTRACT.minTimestampMs)', 'Math.max(now - limits.acceptBackMs, Number.MIN_SAFE_INTEGER)'],
  ['timestamps after year 9999 accepted', 'src/batch.ts', 'Math.min(now + limits.acceptAheadMs, CONTRACT.maxTimestampMs)', 'Math.min(now + limits.acceptAheadMs, Number.MAX_SAFE_INTEGER)'],
  ['INGEST_LIMITS may loosen the contract label limits', 'src/limits.ts', 'out.maxLabelsPerSeries = Math.min(out.maxLabelsPerSeries, CONTRACT.maxLabelsPerSeries)', ''],
  ['INGEST_LIMITS may raise the batch cap', 'src/limits.ts', 'out.maxBatchBytes = Math.min(out.maxBatchBytes, CONTRACT.maxBatchBytes)', ''],
  ['label set larger than a batch not rejected', 'src/batch.ts', 'if (pad8(16 + bytes) + 8 + 16 > L.maxBatchBytes) return -Reject.SeriesTooLarge', ''],
  ['OTLP point attribute job/instance not renamed', 'src/otlp.ts', "return name === 'job' ? 'exported_job' : name === 'instance' ? 'exported_instance' : name", 'return name'],
  ['too_large from a shard treated as success', 'src/route.ts', "const tooLarge = results.filter((r) => r.status === 'too_large')", 'const tooLarge = [] as typeof results'],
  ['no re-split after too_large', 'src/route.ts', ';({ results, batches } = await attempt(env, map, tenant, c, cap, limit))\n', ''],
  // review fixes, early refusal, compatibility, names (2026-11-19)
  ['R-4: Remote Write answers 429 for new series over the limit', 'src/index.ts',
    "    return text(400, `${limitMessage(outcome.limited)}; ${outcome.rows} samples written${also}`, written)",
    "    return text(429, `${limitMessage(outcome.limited)}; ${outcome.rows} samples written${also}`, { ...written, 'Retry-After': '60' })"],
  ['R-9: a key record with a tenant id outside TENANT_ID authenticates', 'src/auth.ts',
    "  if (typeof r.tenant !== 'string' || !TENANT_ID.test(r.tenant)) return null", "  if (typeof r.tenant !== 'string' || r.tenant === '') return null"],
  ['an overloaded shard is answered 429 (which senders may not retry) instead of 503', 'src/index.ts',
    "    return render(503, 'ingest shard is overloaded; retry the whole request'", "    return render(429, 'ingest shard is overloaded; retry the whole request'"],
  ['an overload refusal does not carry the shard\'s Retry-After', 'src/index.ts',
    "    return render(503, 'ingest shard is overloaded; retry the whole request', { 'Retry-After': retryAfter(outcome.retryAfterMs) })",
    "    return render(503, 'ingest shard is overloaded; retry the whole request', { 'Retry-After': '1' })"],
  ['no early refusal before decoding', 'src/route.ts', '  if (hot.size === 0) return null\n', '  return null\n'],
  ['an overload refusal is not remembered', 'src/route.ts',
    "      if (last.status === 'backpressure' && (last as { scope: string }).scope === 'overload') noteOverload(map, slot, last.retryAfterMs)\n", ''],
  ['a shard status edge does not know counts as stored', 'src/route.ts', "      if (!KNOWN.has(last.status)) return { status: 'error' }\n", ''],
  ['names: a pool map whose pool is outside POOL_NAME is used', 'src/route.ts',
    '  if (!validPoolName(m.pool)) return null', "  if (typeof m.pool !== 'string' || m.pool === '') return null"],
  // the recorded-samples entrypoint (contracts/ingest.ts, D41)
  ['recorded: any service binding may write (caller not checked)', 'src/recorded.ts',
    "  if (typeof caller !== 'string' || !RECORDED_SAMPLES_CALLERS.includes(caller)) refuse(", '  if (false) refuse('],
  ['recorded: the tenant argument is not validated', 'src/recorded.ts',
    "  if (typeof tenant !== 'string' || !TENANT_ID.test(tenant)) refuse(", "  if (typeof tenant !== 'string') refuse("],
  ['recorded: batches of another tenant are accepted', 'src/recorded.ts',
    "if (typeof b.id !== 'string' || !b.id.startsWith(prefix)) return", "if (typeof b.id !== 'string') return"],
  ['recorded: invalid samples are dropped and the rest written', 'src/recorded.ts',
    '  if (c.rejectedTotal > 0) refuse(', '  if (false) refuse('],
  ['recorded: a full buffer resolves (acknowledged, not written)', 'src/recorded.ts',
    "  if (outcome.status === 'backpressure') refuse(", "  if (outcome.status === 'backpressure') return\n  if (false) refuse("],
  ['recorded: new series over the limit resolve', 'src/recorded.ts', '  if (ok.limited) {', '  if (false) {'],
  ['recorded: values parsed with Number() (hex, empty accepted)', 'src/recorded.ts', '  if (!DECIMAL.test(text)) return null\n', ''],
  // decode limits on the metrics paths (review M-3, D71; contracts/BATCH.md "Decode limits"): counted before
  // building, refused at the limit. The development branch has these and the span and log ones.
  ['decode: data point attributes built without the meter and counted afterwards (metrics)', 'src/otlp.ts',
    '        const kv = keyValue(r, view, meter)\n        if (kv) attrs.push(kv)\n        break',
    '        const kv = keyValue(r, view, FREE)\n        if (kv) attrs.push(kv)\n        if (attrs.length > meter.cap) meter.used = meter.cap + 1\n        break'],
  ['decode: array elements built past the limit (the check after the build) (metrics)', 'src/otlp.ts',
    '            const item = anyValue(r, view, depth + 1, meter) ?? null\n            if (ok && !meter.over) {',
    '            const item = anyValue(r, view, depth + 1, meter) ?? null\n            if (items) {'],
  ['decode: the meter is not incremented', 'src/meter.ts', 'return ++this.used <= this.cap', 'return this.used <= this.cap'],
  ['decode: array elements not counted (metrics)', 'src/otlp.ts', '            const ok = meter.take()\n            const item = anyValue(', '            const ok = !meter.over\n            const item = anyValue('],
  ['decode: off by one, an item of exactly the limit refused', 'src/meter.ts', 'return ++this.used <= this.cap', 'return ++this.used < this.cap'],
  ['decode: off by one, an item one over the limit accepted', 'src/meter.ts', 'return this.used > this.cap', 'return this.used > this.cap + 1'],
  ['decode: a value past the limit not read (a malformed body accepted) (metrics)', 'src/otlp.ts',
    '  const end = r.len()\n  let value: unknown\n  while (r.pos < end) {\n    const tag = r.uint32()\n    const keep = !meter.over',
    '  const end = r.len()\n  if (meter.over) {\n    r.pos = end\n    return undefined\n  }\n  let value: unknown\n  while (r.pos < end) {\n    const tag = r.uint32()\n    const keep = !meter.over'],
  ['decode: invalid UTF-8 in a key not built goes unchecked (metrics)', 'src/otlp.ts',
    '      if (keep) key = utf8String(r.buf, r.pos, e)\n      else checkUtf8(r.buf, r.pos, e)', '      if (keep) key = utf8String(r.buf, r.pos, e)'],
  ['decode: overlong three-byte UTF-8 accepted', 'src/pb.ts', 'if (c === 0xe0) lo = 0xa0', 'if (c === 0xe0) lo = 0x80'],
  ['decode: UTF-8 surrogates accepted', 'src/pb.ts', '      else if (c === 0xed) hi = 0x9f\n', ''],
  ['decode: JSON tokens off by one (a body of exactly the limit refused)', 'src/meter.ts', 'if (++n > max) throw', 'if (++n >= max) throw'],
  ['decode: JSON structure inside strings counted', 'src/meter.ts', '    if (c === 0x22) {\n      // Skip the string', '    if (false) {\n      // Skip the string'],
  ['decode: series labels past maxDecodedBytes accepted (metrics)', 'src/batch.ts',
    '    if (start + bytes > L.maxDecodedBytes) throw', '    if (false) throw'],
]

const only = check ? undefined : process.argv[2]
let survived = 0
for (const [name, file, from, to] of mutants) {
  if (only && !name.includes(only)) continue
  const original = readFileSync(file, 'utf8')
  if (!original.includes(from)) {
    console.log(`NOT APPLIED  ${name} (pattern not found in ${file})`)
    survived++
    continue
  }
  if (check) continue
  writeFileSync(file, original.replace(from, to))
  let failed = false
  let detail = ''
  try {
    execSync('npx vitest run --maxWorkers=2', { stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
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
if (check) console.log(survived === 0 ? `all ${mutants.length} patterns apply` : `${survived} pattern(s) do not apply`)
else console.log(survived === 0 ? 'all mutants killed' : `${survived} mutant(s) survived or not applied`)
process.exit(survived === 0 ? 0 : 1)
