#!/usr/bin/env node
// The end-to-end fixture of test/signals.e2e.test.ts: the requests of an OTLP corpus
// (edge/scripts/otel-corpus.mjs `--requests`) as sent, in order, with the cases and in-memory
// answers of the same corpus's fixture (examples/signal_fixtures.rs), and without its batches and
// files (the test makes those through the write path; a module reaches the test runner in one
// message of at most 32 MiB).
//
//   node tools/pack-requests.mjs CORPUS SEED_FIXTURE.json OUT.json
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, fixture, out] = process.argv.slice(2)
if (!dir || !fixture || !out) {
  console.error('usage: node tools/pack-requests.mjs CORPUS SEED_FIXTURE.json OUT.json')
  process.exit(2)
}
const index = JSON.parse(readFileSync(join(dir, 'requests', 'index.json'), 'utf8'))
const requests = index.map((r) => ({ path: r.path, contentType: r.contentType, ...(r.contentEncoding ? { contentEncoding: r.contentEncoding } : {}), body: readFileSync(join(dir, 'requests', r.file)).toString('base64') }))
const fx = JSON.parse(readFileSync(fixture, 'utf8'))
writeFileSync(out, JSON.stringify({ seed: fx.seed, counts: fx.counts, cases: fx.cases, nowMs: Number(readFileSync(join(dir, 'requests', 'now_ms'), 'utf8').trim()), requests }))
console.log(`${out}: ${requests.length} requests, ${fx.cases.length} cases`)
