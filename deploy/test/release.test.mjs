// node --test deploy/test/: the release plan (migration gate) and the acknowledgement parser.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { atFloor, deployFloorProblems, floorRules, floorsOfVersion, namesIn, rollbackFloorProblems } from '../lib/floors.mjs'
import { ANY, formatsOfVersion, formatsVar, readsOf } from '../lib/formats.mjs'
import { formatRollbackProblems, formatsOfManifest, forwardOnlyReasons, parseAcks, planRelease, restrictRecord, rollback, schemaRollbackProblems, schemasOfManifest } from '../release.mjs'

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

// ───────────────────────────── format versions (D69; review of D60, m-13) ─────────────────────────────

const ran = (release, formats, worker = 'viz-ruler') => ({ worker, versionId: `v-${release}`, release, formats })

test('formats: the target must read every version written since it; what it reads comes from its record, and nothing declared means version 1', () => {
  const reader = { release: 'sha-b', formats: { 'viz-ruler': { 'store.anomaly-state': { writes: 1, reads: [1, 2] } } } }
  const before = { release: 'sha-a', formats: { 'viz-ruler': { 'store.anomaly-state': { writes: 1, reads: [1] } } } }
  const wrote2 = ran('sha-c', { 'store.anomaly-state': { writes: 2, reads: [1, 2] } })
  assert.deepEqual(formatRollbackProblems(reader, [wrote2]), [])
  const p = formatRollbackProblems(before, [wrote2])
  assert.equal(p.length, 1)
  assert.match(p[0], /^store\.anomaly-state: release sha-c \(viz-ruler version v-sha-c\) wrote version 2, and sha-a reads only 1\. /)
  // Version 1 written since: fine for both.
  assert.deepEqual(formatRollbackProblems(before, [ran('sha-b', { 'store.anomaly-state': { writes: 1, reads: [1, 2] } })]), [])
  // A record from before format versions: reads version 1 of every format, and says why.
  assert.deepEqual(formatRollbackProblems({ release: 'sha-old' }, [ran('sha-b', { 'store.anomaly-state': { writes: 1, reads: [1, 2] } })]), [])
  assert.match(formatRollbackProblems({ release: 'sha-old' }, [wrote2])[0], /sha-old reads only 1 \(its record predates format versions/)
  // A format the target does not declare (added since): version 1 passes, 2 does not.
  assert.deepEqual(formatRollbackProblems(reader, [ran('sha-c', { 'new.format': { writes: 1, reads: [1] } })]), [])
  assert.equal(formatRollbackProblems(reader, [ran('sha-c', { 'new.format': { writes: 2, reads: [2] } })]).length, 1)
  // A format only read (writes null) is never judged as written.
  assert.deepEqual(formatRollbackProblems(before, [ran('sha-c', { 'kv.settings': { writes: null, reads: [1, 2] } })]), [])
  // A newer version that declares no formats: unknown, refused.
  assert.match(formatRollbackProblems(reader, [ran('sha-x', null)])[0], /does not declare its format versions/)
})

test('formats: what a release reads is what every Worker of it that reads the format reads; one that declares nothing reads version 1 of every format (review of D69, M-1 (c))', () => {
  const two = { 'viz-ingest': { 'r2.compaction-inputs': { writes: 1, reads: [1, 2] } }, 'viz-query': { 'r2.compaction-inputs': { writes: null, reads: [1] } } }
  assert.deepEqual(readsOf(two, 'r2.compaction-inputs'), [1])
  assert.deepEqual(readsOf({ 'viz-ingest': two['viz-ingest'] }, 'r2.compaction-inputs'), [1, 2])
  // Complete declarations that do not list a format: nothing reads it.
  assert.equal(readsOf(two, 'not.declared'), null)
  // A Worker that declares nothing (viz-query before it declared what it reads) reads version 1 of everything.
  assert.deepEqual(readsOf({ 'viz-ingest': two['viz-ingest'], 'viz-query': null }, 'r2.compaction-inputs'), [1])
  assert.deepEqual(readsOf({ 'viz-ingest': two['viz-ingest'], 'viz-query': null }, 'not.declared'), [1])
  // An incomplete declaration (D69's var, without `complete`) reads version 1 of what it does not list.
  assert.deepEqual(readsOf({ 'viz-ingest': two['viz-ingest'], 'viz-query': { [ANY]: { writes: null, reads: [1] } } }, 'r2.compaction-inputs'), [1])
  assert.deepEqual(readsOf({ 'viz-ingest': { ...two['viz-ingest'], [ANY]: { writes: null, reads: [1] } } }, 'r2.compaction-inputs'), [1, 2])
  // A whole record from before format versions: version 1.
  assert.deepEqual(readsOf(null, 'anything'), [1])
  // The manifest records a Worker that declares none as reading nothing ({}), and leaves out one with no declaration.
  assert.deepEqual(formatsOfManifest({ order: ['a', 'b', 'c'], workers: [{ name: 'a', formats: [] }, { name: 'b', formats: null }, { name: 'c', formats: [{ format: 'x.y', writes: 1, reads: [1] }] }] }), { a: {}, c: { 'x.y': { writes: 1, reads: [1] } } })
})

test('formats rollback (review of D69, M-1): only the Workers restored read; one the record restores without an entry reads version 1 of everything; the Workers left out are judged as they wrote and write', () => {
  const rec = (workers, formats, complete = true) => ({ release: 'sha-a', workers: workers.map((name) => ({ name, versionId: `${name}-a` })), formats, formatsComplete: complete })
  const formats = { 'viz-ingest': { 'kv.settings': { writes: null, reads: [1] } }, 'viz-control': { 'kv.settings': { writes: 1, reads: [1] } } }
  const control2 = { worker: 'viz-control', versionId: 'c-c', release: 'sha-c', formats: { 'kv.settings': { writes: 2, reads: [1, 2] } } }
  // The whole record: control's own newer version wrote 2, which the restored ingest and control do not read.
  assert.equal(formatRollbackProblems(rec(['viz-ingest', 'viz-control'], formats), [control2]).length, 1)
  // Control left out: its record entry is no reader; what it wrote and writes is judged against the restored ingest.
  const leftOut = formatRollbackProblems(rec(['viz-ingest'], formats), [], { left: [{ ...control2, serving: true }] })
  assert.equal(leftOut.length, 1)
  assert.match(leftOut[0], /^kv\.settings: viz-control is left serving by this rollback .*version c-c \(release sha-c, serving now\) writes version 2, and sha-a reads only 1\. What it wrote, and keeps writing, would be unreadable/)
  // Left out and writing what the restored Workers read: allowed. An older kept version that wrote 2 is judged too.
  assert.deepEqual(formatRollbackProblems(rec(['viz-ingest'], formats), [], { left: [{ ...control2, formats: { 'kv.settings': { writes: 1, reads: [1, 2] } }, serving: true }] }), [])
  assert.equal(formatRollbackProblems(rec(['viz-ingest'], formats), [], { left: [{ ...control2, serving: false }] }).length, 1)
  // The record entry of a Worker left out is not a reader: control's a-entry reads 1 only, and is not asked.
  assert.deepEqual(formatRollbackProblems(rec(['viz-ingest'], { ...formats, 'viz-ingest': { 'kv.settings': { writes: null, reads: [1, 2] } } }), [], { left: [{ ...control2, serving: true }] }), [])
  // A left-out version that declares nothing is unknown: refused.
  assert.match(formatRollbackProblems(rec(['viz-ingest'], formats), [], { left: [{ ...control2, formats: null }] })[0], /^viz-control: this rollback leaves it serving .* does not declare its format versions/)
  // A restored Worker the record has no entry for (viz-query in a record from D69) reads version 1 of every format.
  const q = formatRollbackProblems(rec(['viz-ingest', 'viz-query'], { 'viz-ingest': { 'kv.settings': { writes: null, reads: [1, 2] } } }), [control2])
  assert.equal(q.length, 1)
  assert.match(q[0], /sha-a reads only 1 \(viz-query has no format versions in that record: taken to read version 1 of every format\)/)
  // The same, every Worker declaring completely, nothing reads version 1 only: allowed.
  assert.deepEqual(formatRollbackProblems(rec(['viz-ingest', 'viz-query'], { 'viz-ingest': { 'kv.settings': { writes: null, reads: [1, 2] } }, 'viz-query': {} }), [control2]), [])
  // A record from before declarations were complete: an entry reads version 1 of what it does not list.
  assert.equal(formatRollbackProblems(rec(['viz-ingest', 'viz-query'], { 'viz-ingest': { 'kv.settings': { writes: null, reads: [1, 2] } }, 'viz-query': {} }, false), [control2]).length, 1)
})

test('formats: --only restricts the record to the Workers named (production or deployed names); an unknown name is refused', () => {
  const full = { release: 'sha-a', workers: [{ name: 'viz-t-query' }, { name: 'viz-t-control' }, { name: 'viz-t-ingest' }] }
  assert.equal(restrictRecord(full, '', 't'), full)
  assert.deepEqual(restrictRecord(full, 'viz-query, viz-t-ingest', 't').workers.map((w) => w.name), ['viz-t-query', 'viz-t-ingest'])
  assert.throws(() => restrictRecord(full, 'viz-nothing', 't'), /--only names viz-t-nothing, which the record of sha-a does not have/)
})

test('formats: a release writing a version the serving release does not read is forward-only, by format; a serving release that declares nothing reads version 1', () => {
  const m = { order: ['viz-ruler'], workers: [{ name: 'viz-ruler', migrationTag: null, schemas: [], formats: [{ format: 'store.anomaly-state', writes: 2, reads: [1, 2] }, { format: 'id.hashes', writes: 1, reads: [1] }] }] }
  const live = (formats) => ({ 'viz-ruler': { exists: true, migrationTag: null, schemas: null, formats } })
  assert.deepEqual(forwardOnlyReasons(m, live({ 'store.anomaly-state': { writes: 1, reads: [1, 2] } })), [])
  const f = forwardOnlyReasons(m, live({ 'store.anomaly-state': { writes: 1, reads: [1] } }))
  assert.deepEqual(f.map((x) => [x.worker, x.kind, x.format, x.writes, x.previousReads, x.previousDeclared]), [['viz-ruler', 'format', 'store.anomaly-state', 2, [1], true]])
  const undeclared = forwardOnlyReasons(m, live(null))
  assert.deepEqual(undeclared.map((x) => [x.format, x.previousDeclared]), [['store.anomaly-state', false]])
  // Every Worker serving counts, not only those this release declares the format for (review of D69, M-1 (c)): another
  // Worker that declares nothing reads version 1 of it; one that declares completely without it does not read it.
  const others = (formats) => ({ ...live({ 'store.anomaly-state': { writes: 1, reads: [1, 2] } }), 'viz-query': { exists: true, formats } })
  assert.deepEqual(forwardOnlyReasons(m, others(null)).map((x) => [x.format, x.previousReads, x.previousDeclared]), [['store.anomaly-state', [1], false]])
  assert.match(forwardOnlyReasons(m, others(null))[0].why, /\(viz-query declares no format versions: taken to read version 1\)/)
  assert.deepEqual(forwardOnlyReasons(m, others({})), [])
  assert.equal(forwardOnlyReasons(m, others({ [ANY]: { writes: null, reads: [1] } })).length, 1)
  // Nothing older runs: a first deploy is never forward-only.
  assert.deepEqual(forwardOnlyReasons(m, { 'viz-ruler': { exists: false } }), [])
})

test('formats: VIZ_FORMATS is read back as written, and anything else is unknown; one from before complete declarations reads version 1 of what it does not list', () => {
  const v = (text) => ({ resources: { bindings: [{ type: 'plain_text', name: 'VIZ_FORMATS', text }] } })
  const map = { 'store.anomaly-state': { writes: 2, reads: [1, 2] }, 'kv.settings': { writes: null, reads: [1] } }
  assert.deepEqual(formatsOfVersion(v(formatsVar(Object.entries(map).map(([format, f]) => ({ format, ...f }))))), map)
  assert.deepEqual(formatsOfVersion(v('{"v":1,"complete":true,"formats":{}}')), {})
  // D69's var (no `complete`): incomplete.
  assert.deepEqual(formatsOfVersion(v('{"v":1,"formats":{"store.anomaly-state":{"w":2,"r":[1,2]},"kv.settings":{"w":null,"r":[1]}}}')), { ...map, [ANY]: { writes: null, reads: [1] } })
  for (const bad of ['{"v":2,"formats":{}}', 'nope', '{"v":1,"formats":{"x":{"w":0,"r":[1]}}}', '{"v":1,"formats":{"x":{"w":1,"r":[]}}}', '{"v":1,"complete":true,"formats":{"*":{"w":null,"r":[1]}}}']) assert.equal(formatsOfVersion(v(bad)), null, bad)
  assert.equal(formatsOfVersion({ resources: { bindings: [] } }), null)
})

// ───────────────────────────── rollback floors (D64, D69; review of traces and logs, M-4) ─────────────────────────────

const plan = JSON.parse((await import('node:fs')).readFileSync(new URL('../workers.json', import.meta.url), 'utf8'))
const [SIGNALS] = floorRules(plan, undefined)
const floor = (w) => SIGNALS.floors.find((f) => f.worker === w)
const code = ({ publisher = 5, stamped = true } = {}) => ({ schemas: { 'publisher.Publisher': { latest: publisher } }, floors: stamped ? ['signal-data'] : null })

test('floors: workers.json puts INGEST_SIGNALS under a floor for viz-publisher (schema 4), viz-query and viz-ingest (stamped)', () => {
  assert.equal(SIGNALS.writer, 'viz-ingest')
  assert.equal(SIGNALS.var, 'INGEST_SIGNALS')
  assert.deepEqual(SIGNALS.floors.map((f) => [f.worker, f.schema ?? null, f.atLeast ?? null, Boolean(f.evidence)]), [['viz-publisher', 'publisher.Publisher', 4, false], ['viz-query', null, null, true], ['viz-ingest', null, null, true]])
  assert.equal(atFloor(SIGNALS, floor('viz-publisher'), code({ publisher: 4 })), true)
  assert.equal(atFloor(SIGNALS, floor('viz-publisher'), code({ publisher: 3 })), false)
  assert.equal(atFloor(SIGNALS, floor('viz-publisher'), { schemas: null }), false)
  assert.equal(atFloor(SIGNALS, floor('viz-query'), code()), true)
  assert.equal(atFloor(SIGNALS, floor('viz-query'), code({ stamped: false })), false)
  // Staged names follow the stage.
  assert.deepEqual(floorRules(plan, 'trial')[0].floors.map((f) => f.worker), ['viz-trial-publisher', 'viz-trial-query', 'viz-trial-ingest'])
  // What a value of the switch names: anything, fail closed.
  assert.deepEqual(namesIn(' traces , logs,'), ['traces', 'logs'])
  assert.deepEqual(namesIn('metrics2'), ['metrics2'])
  assert.deepEqual(namesIn(''), [])
  assert.deepEqual(namesIn(null), [])
  assert.deepEqual(floorsOfVersion({ resources: { bindings: [{ type: 'plain_text', name: 'VIZ_FLOORS', text: '{"v":1,"at":["signal-data"]}' }] } }), ['signal-data'])
  assert.equal(floorsOfVersion({ resources: { bindings: [{ type: 'plain_text', name: 'VIZ_FLOORS', text: '{"v":2,"at":["signal-data"]}' }] } }), null)
})

test('floors: a malformed rule is refused, not half-applied', () => {
  const rule = (r) => ({ ...plan, rollback_floors: [{ ...plan.rollback_floors[0], ...r }] })
  assert.throws(() => floorRules(rule({ writer: 'viz-nothing' }), undefined), /writer viz-nothing is not a Worker/)
  assert.throws(() => floorRules(rule({ var: 'lower' }), undefined), /not a variable name/)
  assert.throws(() => floorRules(rule({ floors: {} }), undefined), /at least one Worker/)
  assert.throws(() => floorRules(rule({ floors: { 'viz-query': { why: 'x' } } }), undefined), /either a schema version .* or "evidence"/)
  assert.throws(() => floorRules(rule({ floors: { 'viz-query': { schema: 'q.Q', at_least: 2, why: 'x' } } }), undefined), /declares no schemas/)
  assert.throws(() => floorRules(rule({ floors: { 'viz-publisher': { schema: 'publisher.Publisher', at_least: 1, why: 'x' } } }), undefined), /from 2/)
})

test('floors: deploy-time rule, pure: the switch needs every Worker at its floor here and serving; with it off, history decides', () => {
  const workers = (now, serving) => SIGNALS.floors.map((f) => ({ floor: f, now: now(f.worker), serving: serving(f.worker) }))
  const at = () => code()
  assert.deepEqual(deployFloorProblems(SIGNALS, { value: 'traces', workers: workers(at, at) }), [])
  assert.equal(deployFloorProblems(SIGNALS, { value: 'traces', workers: workers(at, (w) => (w === 'viz-query' ? code({ stamped: false }) : code())) }).length, 1)
  // A Worker that does not exist yet (first deploy) has nothing to roll back to.
  assert.deepEqual(deployFloorProblems(SIGNALS, { value: 'traces', workers: workers(at, () => null) }), [])
  assert.equal(deployFloorProblems(SIGNALS, { value: 'traces', workers: workers((w) => (w === 'viz-publisher' ? code({ publisher: 3 }) : code()), () => null) }).length, 1)
  // Off, below a floor: refused only when a kept writer version had it on.
  const below = workers((w) => (w === 'viz-ingest' ? code({ stamped: false }) : code()), at)
  assert.deepEqual(deployFloorProblems(SIGNALS, { value: null, workers: below, seen: null }), [])
  assert.match(deployFloorProblems(SIGNALS, { value: null, workers: below, seen: { versionId: 'i9', release: 'sha-on', value: 'logs' } })[0], /^viz-ingest: this release is below its floor .* viz-ingest version i9 \(release sha-on\) set INGEST_SIGNALS=logs/)
})

test('floors: rollback rule, pure: refused for each Worker it would leave below its floor, only once the switch was seen', () => {
  const w = (worker, c, restored = true) => ({ floor: floor(worker), code: c, versionId: `${worker}-v`, release: 'sha-t', restored })
  const seen = { versionId: 'i2', release: 'sha-on', value: 'traces' }
  assert.deepEqual(rollbackFloorProblems(SIGNALS, { workers: [w('viz-publisher', code({ publisher: 3 }))], seen: null }), [])
  const p = rollbackFloorProblems(SIGNALS, { workers: [w('viz-publisher', code({ publisher: 3 })), w('viz-query', code({ stamped: false }), false), w('viz-ingest', code())], seen })
  assert.equal(p.length, 2)
  assert.match(p[0], /^viz-publisher: this rollback would restore version viz-publisher-v .*schema 3, floor 4/)
  assert.match(p[1], /^viz-query: this rollback would leave serving version viz-query-v/)
})
