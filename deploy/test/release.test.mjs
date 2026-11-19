// node --test deploy/test/: the release plan (migration gate) and the acknowledgement parser.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forwardOnlyReasons, parseAcks, planRelease, rollback, schemaRollbackProblems, schemasOfManifest } from '../release.mjs'

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

// ───────────────────────────── schema versions: forward-only and rollback ─────────────────────────────

const LEDGER_MIGRATIONS = [
  { version: 1, readableFrom: 1, name: 'the schema as it stood when versioning began' },
  { version: 2, readableFrom: 2, name: 'the change log in segments' },
]
/** A manifest of viz-ingest (Shard, Ledger) and viz-control (Tenant) with the given ledger migrations. */
const withSchemas = (ledgerMigrations, tenantMigrations = [{ version: 1, readableFrom: 1, name: 't1' }]) => {
  const spec = (component, migrations) => ({ component, latest: migrations.length, compat: Math.max(...migrations.map((m) => m.readableFrom)), migrations })
  return {
    release: 'sha-new',
    order: ['viz-ingest', 'viz-control'],
    workers: [
      { name: 'viz-ingest', canonical: 'viz-ingest', migrationTags: ['v1'], migrationTag: 'v1', schemas: [spec('shard.Shard', [{ version: 1, readableFrom: 1, name: 's1' }]), spec('ledger.Ledger', ledgerMigrations)] },
      { name: 'viz-control', canonical: 'viz-control', migrationTags: ['v1'], migrationTag: 'v1', schemas: [spec('control.Tenant', tenantMigrations)] },
    ],
  }
}
const serving = (ledger, extra = {}) => ({
  'viz-ingest': { exists: true, migrationTag: 'v1', schemas: ledger === undefined ? null : { 'shard.Shard': { latest: 1, compat: 1 }, 'ledger.Ledger': ledger } },
  'viz-control': { exists: true, migrationTag: 'v1', schemas: { 'control.Tenant': { latest: 1, compat: 1 } } },
  ...extra,
})

test('a release is forward-only when a migration in it has readableFrom above what the serving release knows, and says which and why', () => {
  const m = withSchemas(LEDGER_MIGRATIONS)
  const f = forwardOnlyReasons(m, serving({ latest: 1, compat: 1 }))
  assert.equal(f.length, 1)
  assert.deepEqual({ ...f[0], why: undefined }, { worker: 'viz-ingest', kind: 'schema', component: 'ledger.Ledger', previousKnows: 1, previousDeclared: true, latest: 2, compat: 2, migrations: [LEDGER_MIGRATIONS[1]], why: undefined })
  assert.match(f[0].why, /ledger\.Ledger: migration 2 \("the change log in segments"\) has readableFrom 2, above version 1/)
  // The serving release already knows version 2: not forward-only.
  assert.deepEqual(forwardOnlyReasons(m, serving({ latest: 2, compat: 2 })), [])
  // An additive migration (readableFrom 1) is not forward-only: the previous release stays a rollback target.
  assert.deepEqual(forwardOnlyReasons(withSchemas([...LEDGER_MIGRATIONS.slice(0, 1), { version: 2, readableFrom: 1, name: 'additive' }]), serving({ latest: 1, compat: 1 })), [])
  // A serving version that declares nothing (from before schema records) is taken to know version 1.
  const undeclared = forwardOnlyReasons(m, serving(undefined))
  assert.equal(undeclared.length, 1)
  assert.equal(undeclared[0].previousDeclared, false)
  // A first deploy has nothing older to roll back to.
  assert.deepEqual(forwardOnlyReasons(m, { 'viz-ingest': { exists: false }, 'viz-control': { exists: false } }), [])
  // A class lifecycle change on an existing Worker is forward-only too.
  const lifecycle = forwardOnlyReasons({ ...m, workers: m.workers.map((w) => (w.name === 'viz-control' ? { ...w, migrationTag: 'v2', migrationTags: ['v1', 'v2'] } : w)) }, serving({ latest: 2, compat: 2 }))
  assert.deepEqual(lifecycle.map((x) => [x.worker, x.kind, x.from, x.to]), [['viz-control', 'lifecycle', 'v1', 'v2']])
})

/** A rollback target's record, as release.mjs writes it. */
const recordOfRelease = (release, manifest, versions) => ({
  kind: 'release',
  release,
  target: 'stage-citest',
  stage: 'citest',
  schemas: schemasOfManifest(manifest),
  workers: manifest.order.map((name) => ({ name, versionId: versions[name], migrationTag: 'v1', versions: [{ version_id: versions[name], percentage: 100 }] })),
})

test('a rollback may not cross a forward-only release: it refuses, naming the release and the migration', () => {
  const a = recordOfRelease('sha-a', withSchemas(LEDGER_MIGRATIONS.slice(0, 1)), { 'viz-ingest': 'ia', 'viz-control': 'ca' })
  const ranB = { worker: 'viz-ingest', versionId: 'ib', release: 'sha-b', schemas: { 'shard.Shard': { latest: 1, compat: 1 }, 'ledger.Ledger': { latest: 2, compat: 2, by: '2: the change log in segments' } } }
  const p = schemaRollbackProblems(a, [ranB])
  assert.equal(p.length, 1)
  assert.match(p[0], /^ledger\.Ledger: release sha-b \(viz-ingest version ib\) ran schema version 2, readable from 2, and sha-a knows only up to 1: that release is forward-only \(migration 2: the change log in segments\)/)
  // To a release that knows version 2: allowed.
  const b = recordOfRelease('sha-b', withSchemas(LEDGER_MIGRATIONS), { 'viz-ingest': 'ib', 'viz-control': 'cb' })
  assert.deepEqual(schemaRollbackProblems(b, [{ ...ranB, versionId: 'ic', release: 'sha-c', schemas: { 'ledger.Ledger': { latest: 3, compat: 2 } } }]), [])
  // Additive releases since (compat at or below what the target knows): allowed.
  assert.deepEqual(schemaRollbackProblems(a, [{ ...ranB, schemas: { 'ledger.Ledger': { latest: 2, compat: 1 } } }]), [])
  // A newer version that declares nothing, or a record from before schema records: refused, never guessed.
  assert.match(schemaRollbackProblems(a, [{ ...ranB, schemas: null }])[0], /does not declare its schema versions/)
  assert.match(schemaRollbackProblems({ ...a, schemas: undefined }, [])[0], /has no schema versions/)
})

test('crossing is judged by everything that ran since the target, not by what serves now (A → B → C, back to B, then to A)', () => {
  // B adds an additive migration 2; C adds migration 3 with readableFrom 2. C is not forward-only
  // against B, but storage C migrated cannot be opened by A, even after a rollback to B.
  const a = recordOfRelease('sha-a', withSchemas(LEDGER_MIGRATIONS.slice(0, 1)), { 'viz-ingest': 'ia', 'viz-control': 'ca' })
  const ranSinceA = [
    { worker: 'viz-ingest', versionId: 'ib', release: 'sha-b', schemas: { 'ledger.Ledger': { latest: 2, compat: 1 } } },
    { worker: 'viz-ingest', versionId: 'ic', release: 'sha-c', schemas: { 'ledger.Ledger': { latest: 3, compat: 2, by: '3: c' } } },
  ]
  assert.match(schemaRollbackProblems(a, ranSinceA).join('\n'), /release sha-c .* sha-a knows only up to 1/)
})

test('rollback_to a release before a forward-only one: REFUSED with the reason, and nothing is restored', async () => {
  const a = recordOfRelease('sha-a', withSchemas(LEDGER_MIGRATIONS.slice(0, 1)), { 'viz-ingest': 'ia', 'viz-control': 'ca' })
  const versions = { 'viz-ingest': [{ id: 'ib', number: 2 }, { id: 'ia', number: 1 }], 'viz-control': [{ id: 'cb', number: 2 }, { id: 'ca', number: 1 }] }
  const info = {
    ia: { id: 'ia', number: 1 }, ca: { id: 'ca', number: 1 },
    ib: { id: 'ib', number: 2, annotations: { 'workers/tag': 'sha-b' }, resources: { bindings: [{ type: 'plain_text', name: 'VIZ_SCHEMAS', text: JSON.stringify({ v: 1, classes: { 'shard.Shard': { latest: 1, compat: 1 }, 'ledger.Ledger': { latest: 2, compat: 2, by: '2: the change log in segments' } } }) }] } },
    cb: { id: 'cb', number: 2, annotations: { 'workers/tag': 'sha-b' }, resources: { bindings: [{ type: 'plain_text', name: 'VIZ_SCHEMAS', text: JSON.stringify({ v: 1, classes: { 'control.Tenant': { latest: 1, compat: 1 } } }) }] } },
  }
  const restored = []
  const api = {
    liveState: async (names) => Object.fromEntries(names.map((n) => [n, { exists: true, migrationTag: 'v1', versions: [], release: 'sha-b', schemas: null }])),
    versionInfo: async (_w, id) => info[id] ?? null,
    listVersions: async (w) => versions[w] ?? [], // as lib/cf.mjs answers for a Worker that does not exist
    restore: async (...args) => void restored.push(args),
  }
  const r = await rollback({ stage: 'citest', record: a, reason: 'test', api })
  assert.equal(r.exit, 3)
  assert.equal(restored.length, 0)
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0], /ledger\.Ledger: release sha-b .* forward-only \(migration 2: the change log in segments\)/)
  // The same rollback before B ever ran (no newer versions): allowed, and restored.
  const ok = await rollback({ stage: 'citest', record: a, reason: 'test', api: { ...api, listVersions: async (w) => (versions[w] ?? []).slice(1) } })
  assert.equal(ok.exit, 0)
  assert.equal(restored.length, 1)
})

test('rollback_to after a rollback: a release that ran and was rolled back still counts (A → B → C, back to B, then to A)', async () => {
  const a = recordOfRelease('sha-a', withSchemas(LEDGER_MIGRATIONS.slice(0, 1)), { 'viz-ingest': 'ia', 'viz-control': 'ca' })
  const declare = (classes) => ({ resources: { bindings: [{ type: 'plain_text', name: 'VIZ_SCHEMAS', text: JSON.stringify({ v: 1, classes }) }] } })
  const info = {
    ia: { id: 'ia', number: 1 }, ca: { id: 'ca', number: 1 },
    ib: { id: 'ib', number: 2, annotations: { 'workers/tag': 'sha-b' }, ...declare({ 'ledger.Ledger': { latest: 2, compat: 1, by: '1: x' } }) },
    ic: { id: 'ic', number: 3, annotations: { 'workers/tag': 'sha-c' }, ...declare({ 'ledger.Ledger': { latest: 3, compat: 2, by: '3: c' } }) },
    cb: { id: 'cb', number: 2, annotations: { 'workers/tag': 'sha-b' }, ...declare({ 'control.Tenant': { latest: 1, compat: 1 } }) },
  }
  const restored = []
  const api = {
    // B serves now: C was rolled back.
    liveState: async (names) => Object.fromEntries(names.map((n) => [n, { exists: true, migrationTag: 'v1', versions: [{ version_id: n === 'viz-ingest' ? 'ib' : 'cb', percentage: 100 }], release: 'sha-b', schemas: null }])),
    versionInfo: async (_w, id) => info[id] ?? null,
    listVersions: async (w) => (w === 'viz-ingest' ? [{ id: 'ic', number: 3 }, { id: 'ib', number: 2 }, { id: 'ia', number: 1 }] : [{ id: 'cb', number: 2 }, { id: 'ca', number: 1 }]),
    restore: async (...args) => void restored.push(args),
  }
  const r = await rollback({ stage: 'citest', record: a, reason: 'test', api })
  assert.equal(r.exit, 3)
  assert.equal(restored.length, 0)
  assert.match(r.problems.join('\n'), /release sha-c \(viz-ingest version ic\) ran schema version 3, readable from 2, and sha-a knows only up to 1/)
})
