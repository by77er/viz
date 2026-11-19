// node --test deploy/test/: the release plan (migration gate) and the acknowledgement parser.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAcks, planRelease } from '../release.mjs'

const manifest = {
  release: 'sha1',
  order: ['viz-ingest', 'viz-control', 'viz-query', 'viz-gateway'],
  workers: [
    { name: 'viz-ingest', canonical: 'viz-ingest', component: 'stack', config: 'x', migrationTags: ['v1', 'v2'], migrationTag: 'v2' },
    { name: 'viz-control', canonical: 'viz-control', component: 'control', config: 'x', migrationTags: ['v1'], migrationTag: 'v1' },
    { name: 'viz-query', canonical: 'viz-query', component: 'query', config: 'x', migrationTags: ['v1'], migrationTag: 'v1' },
    { name: 'viz-gateway', canonical: 'viz-gateway', component: 'deploy/gateway', config: 'x', migrationTags: [], migrationTag: null },
  ],
}
const live = (o = {}) => ({
  'viz-ingest': { exists: true, migrationTag: 'v1' },
  'viz-control': { exists: true, migrationTag: 'v1' },
  'viz-query': { exists: true, migrationTag: 'v1' },
  'viz-gateway': { exists: true, migrationTag: null },
  ...o,
})

test('a release with a new migration is refused without an acknowledgement, before anything happens', () => {
  const p = planRelease(manifest, live(), parseAcks(''))
  assert.equal(p.problems.length, 1)
  assert.match(p.problems[0], /viz-ingest.*v1 → v2.*Migration: viz-ingest@v2/)
  assert.deepEqual(p.migrations.map((s) => s.name), ['viz-ingest'])
})

test('the acknowledgement must name the Worker and the tag', () => {
  assert.equal(planRelease(manifest, live(), parseAcks('Migration: viz-ingest@v2')).problems.length, 0)
  assert.equal(planRelease(manifest, live(), parseAcks('Migration: viz-ingest@v3')).problems.length, 1)
  assert.equal(planRelease(manifest, live(), parseAcks('Migration: viz-query@v2')).problems.length, 1)
  assert.equal(planRelease(manifest, live(), parseAcks('viz-ingest v2')).problems.length, 1)
})

test('Workers with no pending migration are uploaded then promoted; migrating or new ones go out with wrangler deploy', () => {
  const p = planRelease(manifest, live({ 'viz-gateway': { exists: false, migrationTag: null } }), parseAcks('viz-ingest@v2'))
  assert.deepEqual(Object.fromEntries(p.steps.map((s) => [s.name, s.via])), { 'viz-ingest': 'deploy', 'viz-control': 'versions', 'viz-query': 'versions', 'viz-gateway': 'deploy' })
  assert.deepEqual(p.steps.map((s) => s.name), manifest.order)
})

test('a first deploy migrates every Durable Object Worker from nothing', () => {
  const none = Object.fromEntries(manifest.order.map((n) => [n, { exists: false, migrationTag: null }]))
  const p = planRelease(manifest, none, parseAcks(''))
  assert.deepEqual(p.migrations.map((s) => `${s.name} ${s.migration.from}→${s.migration.to}`), ['viz-ingest null→v2', 'viz-control null→v1', 'viz-query null→v1'])
  assert.equal(p.problems.length, 3)
  assert.equal(planRelease(manifest, none, parseAcks('viz-ingest@v2, viz-control@v1; viz-query@v1')).problems.length, 0)
})

test('a config that dropped a migration already applied is refused', () => {
  const p = planRelease(manifest, live({ 'viz-control': { exists: true, migrationTag: 'v7' } }), parseAcks('viz-ingest@v2 viz-control@v1'))
  assert.match(p.problems.join('\n'), /v7 is not in control\/wrangler.jsonc/)
})

test('acknowledgements are read from trailers and dispatch inputs alike', () => {
  const text = 'Fix a thing\n\nMigration: viz-ingest@v2\nMigration: viz-query@v3\n viz-control@v1,viz-gateway@x.y'
  assert.deepEqual([...parseAcks(text)].sort(), ['viz-control@v1', 'viz-gateway@x.y', 'viz-ingest@v2', 'viz-query@v3'])
  assert.equal(parseAcks('email me at someone@viz-ingest.example').size, 0)
})
