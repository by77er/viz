/**
 * Golden formats (contracts/COMPATIBILITY.md §3, §5, §8): what the publisher writes for other
 * releases and other engines, and the ledger change it reads. Each file is
 * `test/golden/formats/<format>.v<N>.json`, N = `FORMATS[format]` in `src/schema.ts`.
 *
 * Field ids get one more check that outlives any version bump: across every golden version,
 * a column name keeps its id and an id never names a second column.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  emptyMetadata,
  flattenFields,
  icebergSchema,
  MANIFEST_ENTRY_SCHEMA,
  MANIFEST_LIST_SCHEMA,
  manifestEntrySchema,
  METRIC_TABLE_NAMES,
  SIGNAL_TABLE_NAMES,
  SPANS_MANIFEST_ENTRY_SCHEMA,
  TABLE_NAMES,
  type SchemaField,
} from '../src/iceberg'
import { FORMATS } from '../src/schema'
import { expectGolden, goldenDir } from './golden'
import { addUnit, fresh, keyOf, ledgerVersion, mirror, pairUnit, publisher, readMetadata, segmentsOf } from './helpers'

type Format = keyof typeof FORMATS
const file = (f: Format) => `formats/${f}.v${FORMATS[f]}.json`
const UUID = '00000000-0000-4000-8000-000000000000'
const NOW = 1_700_000_000_000

describe('golden formats', () => {
  it('no format is missing a file, and no file claims a version the code does not', () => {
    const files = goldenDir('formats')
    for (const f of Object.keys(FORMATS) as Format[]) expect(files[`${f}.v${FORMATS[f]}.json`], `test/golden/${file(f)}`).toMatchObject({ format: f, version: FORMATS[f] })
    for (const [name, g] of Object.entries(files)) {
      const { format, version } = g as { format: Format; version: number }
      expect(name).toBe(`${format}.v${version}.json`)
      expect(version).toBeLessThanOrEqual(FORMATS[format])
    }
  })

  it('iceberg.metadata: a new table\'s metadata.json, for both metric tables', () => {
    const tables = Object.fromEntries(METRIC_TABLE_NAMES.map((t) => [t, emptyMetadata(t, `s3://viz-lake/cell-0/iceberg/${t}`, 'cell-0', UUID, NOW)]))
    expectGolden(file('iceberg.metadata'), { format: 'iceberg.metadata', version: FORMATS['iceberg.metadata'], tables })
  })

  it('iceberg.signal-metadata: a new table\'s metadata.json, for the span and log tables', () => {
    const tables = Object.fromEntries(SIGNAL_TABLE_NAMES.map((t) => [t, emptyMetadata(t, `s3://viz-lake/cell-0/iceberg/${t}`, 'cell-0', UUID, NOW)]))
    expectGolden(file('iceberg.signal-metadata'), { format: 'iceberg.signal-metadata', version: FORMATS['iceberg.signal-metadata'], tables })
  })

  it('field ids: in every golden version, a column (nested ones included) keeps its id and an id names one column', () => {
    const ids = new Map<string, Map<number, string>>()
    const versions = Object.values(goldenDir('formats')).filter((g) => ['iceberg.metadata', 'iceberg.signal-metadata'].includes((g as { format: string }).format)) as { tables: Record<string, { schemas: { fields: SchemaField[] }[] }> }[]
    // The code's current ids count as one more version.
    const current = Object.fromEntries(TABLE_NAMES.map((t) => [t, { schemas: [icebergSchema(t) as { fields: SchemaField[] }] }]))
    for (const v of [...versions.map((g) => g.tables), current]) {
      for (const [table, meta] of Object.entries(v)) {
        const byId = ids.get(table) ?? new Map<number, string>()
        ids.set(table, byId)
        for (const s of meta.schemas) {
          for (const [id, name] of flattenFields(s.fields)) {
            const was = byId.get(id)
            expect(was === undefined || was === name, `${table}: field id ${id} named both ${was} and ${name}`).toBe(true)
            byId.set(id, name)
          }
        }
        const names = [...byId.values()]
        expect(new Set(names).size, `${table}: a column name has two ids`).toBe(names.length)
      }
    }
  })

  it('name mapping: for every table, it maps exactly the schema\'s fields that the files hold, nested ones included, each to its id', () => {
    type Mapping = { 'field-id': number; names: string[]; fields?: Mapping[] }
    const flat = (ms: Mapping[], prefix = ''): [number, string][] =>
      ms.flatMap((m) => {
        const name = prefix ? `${prefix}.${m.names[0]}` : m.names[0]!
        return [[m['field-id'], name] as [number, string], ...flat(m.fields ?? [], name)]
      })
    for (const t of TABLE_NAMES) {
      const meta = emptyMetadata(t, `s3://viz-lake/cell-0/iceberg/${t}`, 'cell-0', UUID, NOW)
      const mapping = flat(JSON.parse(meta.properties['schema.name-mapping.default']!) as Mapping[])
      const schema = flattenFields((icebergSchema(t) as { fields: SchemaField[] }).fields).filter(([, n]) => n !== 'tenant' && n !== 'day')
      expect(mapping.sort((a, b) => a[0] - b[0]), t).toEqual(schema.sort((a, b) => a[0] - b[0]))
      expect(Math.max(...schema.map(([id]) => id), ...[meta['last-column-id']]), `${t}: last-column-id`).toBe(meta['last-column-id'])
    }
  })

  it('iceberg.manifest: the Avro schemas of manifests and manifest lists', () => {
    expectGolden(file('iceberg.manifest'), { format: 'iceberg.manifest', version: FORMATS['iceberg.manifest'], entry: MANIFEST_ENTRY_SCHEMA, list: MANIFEST_LIST_SCHEMA })
  })

  it('iceberg.signal-manifest: the Avro schema of a spans manifest; trace_index and logs use the metric tables\' one', () => {
    expectGolden(file('iceberg.signal-manifest'), { format: 'iceberg.signal-manifest', version: FORMATS['iceberg.signal-manifest'], spans: SPANS_MANIFEST_ENTRY_SCHEMA })
    for (const t of TABLE_NAMES) expect(manifestEntrySchema(t), t).toBe(t === 'spans' ? SPANS_MANIFEST_ENTRY_SCHEMA : MANIFEST_ENTRY_SCHEMA)
  })

  it('r2.cursors and read.ledger-change: the cursors object a commit writes, and the change the ledger logs', async () => {
    const { cell, tenant } = fresh()
    const t = tenant('acme')
    await addUnit(t, pairUnit(cell, t, 1, 4))
    await mirror(t, cell)
    await publisher(cell).publish([t])
    const meta = await readMetadata(cell, 'metric_samples')
    const snap = meta.snapshots.find((s) => s['snapshot-id'] === meta['current-snapshot-id'])!
    const raw = await (await env.BUCKET.get(keyOf(snap.summary['viz.ledger-cursors'] as string)))!.text()
    const scrub = (s: string) => s.replaceAll(cell, '<cell>').replaceAll(env.CELL, '<cell>').replaceAll(t, '<tenant>').replace(/"snapshotId":\d+/, '"snapshotId":"<id>"').replace(/"ledgerIncarnation":\d+/g, '"ledgerIncarnation":"<inc>"')
    expectGolden(file('r2.cursors'), { format: 'r2.cursors', version: FORMATS['r2.cursors'], body: scrub(raw) })

    // The change as the ledger logs it: one line of a segment (contracts/LEDGER-LOG.md).
    const { ledgerIncarnation, version } = await ledgerVersion(t)
    const seg = (await segmentsOf(cell, t, ledgerIncarnation)).find((s) => s.first <= version && version <= s.last)!
    const change = (await (await env.BUCKET.get(seg.key))!.text()).split('\n')[1 + version - seg.first]!
    const scrubbed = scrub(change).replace(/"at":\d+/g, '"at":"<ms>"')
    expectGolden(file('read.ledger-change'), { format: 'read.ledger-change', version: FORMATS['read.ledger-change'], addUnit: JSON.parse(scrubbed) })
  })
})
