#!/usr/bin/env node
// The requests of an OTLP corpus (edge/scripts/otel-corpus.mjs `--requests`) as one JSON file for
// test/signals.e2e.test.ts: [{ path, contentType, contentEncoding?, body (base64) }], in order,
// and the clock the corpus was decoded with.
//
//   node tools/pack-requests.mjs CORPUS OUT.json
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, out] = process.argv.slice(2)
if (!dir || !out) {
  console.error('usage: node tools/pack-requests.mjs CORPUS OUT.json')
  process.exit(2)
}
const index = JSON.parse(readFileSync(join(dir, 'requests', 'index.json'), 'utf8'))
const requests = index.map((r) => ({ path: r.path, contentType: r.contentType, ...(r.contentEncoding ? { contentEncoding: r.contentEncoding } : {}), body: readFileSync(join(dir, 'requests', r.file)).toString('base64') }))
writeFileSync(out, JSON.stringify({ nowMs: Number(readFileSync(join(dir, 'requests', 'now_ms'), 'utf8').trim()), requests }))
console.log(`${out}: ${requests.length} requests`)
