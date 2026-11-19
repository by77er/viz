/**
 * The publisher's re-base at the ledger's state limit (README, "Memory and time of a re-base").
 * Measured here, in local workerd: the test, the publisher, SQLite and a simulated R2 in one
 * process, on a shared machine (times move ±2× with its load; the load is printed).
 *
 * The log is written directly with the contract's encoders, S4-shaped (ledger/bench: keys of
 * about 130 characters, a version-1 index fragment of three row groups, about 500 characters),
 * so that a size N has the ledger's estimated state N × (key + fragment + 448 bytes): 300,000
 * files is about the 300 MiB limit. Incarnation 1 is a base of N files at version 1000, a segment
 * adding one unit (two files), and a checkpoint at 1001 of the variant's format:
 *
 *   base     no checkpoint: the re-base streams the base line of the first segment
 *   one      a format-1 checkpoint (one object, one base line), as the ledger writes for ≤ 1 MiB
 *   parts    a format-2 checkpoint: a manifest and parts of ≤ 1 MiB, as the ledger writes above
 *   before   the base log, published by the frozen publisher from before this change (bench/before/)
 *
 * Steps: `first` (the tenant's first publication: N + 2 files added), `rebase` (incarnation 2,
 * the same files plus a unit, with a checkpoint of the same format: a re-base that changes
 * little), `more` (one unit read from the cursor), `resync` (the publisher's SQLite lost:
 * rebuilt from R2). Every after-variant prints a SHA-256 of every Iceberg object it wrote: the
 * same for every variant (fixed ids and clock), or the comparison fails.
 *
 *   BENCH_SIZES=8000,32000 BENCH_VARIANTS=parts,base,one,before npm run bench
 *   RSS_LOG=rss.log node ../ledger/bench/rss.mjs -- npm run bench     (resident memory, 100 ms)
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_CHECKPOINT_PART_MAX_BYTES,
  encodeLedgerCheckpointManifest,
  encodeLedgerCheckpointPart,
  ledgerCheckpointKey,
  ledgerCheckpointPartKey,
  ledgerSegmentKey,
  type LiveFile,
  type Table,
} from '../../contracts/ledger'
import type { BenchPublisher, PublisherBefore } from './worker'

const E = env as unknown as {
  PUBLISHER: DurableObjectNamespace<BenchPublisher>
  PUBLISHER_BEFORE: DurableObjectNamespace<PublisherBefore>
  BUCKET: R2Bucket
  BENCH_SIZES: string
  BENCH_VARIANTS: string
  BENCH_STEPS: string
}
type Variant = 'base' | 'one' | 'parts' | 'before'
const SIZES = (E.BENCH_SIZES || '8000').split(',').map((n) => 60 * Math.ceil(Number(n) / 60))
const VARIANTS = (E.BENCH_VARIANTS || 'parts,base,one').split(',') as Variant[]
const STEPS = new Set((E.BENCH_STEPS || 'first,rebase,more,resync').split(','))
const T = 'acme'
const CELL = 'cell-bench'
const DAY = 86_400_000
const DAY0 = Date.UTC(2026, 9, 20)
const DAYS = 30
const INDEX = JSON.stringify({ v: 1, rg: [0, 1, 2].map((g) => ({ rows: 100_000, off: 4 + g * 4_000_000, len: 4_000_000, min_name: 'http_requests_total', max_name: 'process_cpu_seconds_total', min_ts: 1795000000000, max_ts: 1795003600000 })) })
const enc = new TextEncoder()
const phase = (name: string, extra: Record<string, unknown> = {}) => console.log(`PHASE ${Date.now()} ${name} ${JSON.stringify(extra)}`)
const dayOf = (d: number) => new Date(DAY0 + d * DAY).toISOString().slice(0, 10)

/** The k-th of N base files, in key order: samples before series, days ascending, names ascending. */
function fileAt(n: number, k: number): LiveFile {
  const half = n / 2
  const table: Table = k < half ? 'metric_samples' : 'metric_series'
  const j = k % half
  const perDay = half / DAYS
  const d = Math.floor(j / perDay)
  const day = dayOf(d)
  const name = `L0-${String(j).padStart(7, '0')}-pool_b_${j % 8}-${1000 + (j % 8)}-${String(j + 3).padStart(7, '0')}-${((j * 2654435761) >>> 0).toString(16).padStart(8, '0')}`
  return {
    table, day, key: `cell-0/data/${table}/tenant=${T}/day=${day}/${name}.parquet`,
    bytes: 8_000_000, rows: 300_000, minTs: DAY0 + d * DAY, maxTs: DAY0 + d * DAY + 86_399_000, level: 0, index: INDEX, precedence: k, precedenceLow: k,
  }
}

/** A unit's two series files, on a day after the base's: their keys sort after every base file. */
function unitFiles(u: number): LiveFile[] {
  const day = dayOf(DAYS + u)
  return [0, 1].map((i) => ({
    table: 'metric_series', day, key: `cell-0/data/metric_series/tenant=${T}/day=${day}/L0-unit-${u}-${i}.parquet`,
    bytes: 8_000_000, rows: 300_000, minTs: DAY0 + (DAYS + u) * DAY, maxTs: DAY0 + (DAYS + u) * DAY + 1000, level: 0, index: INDEX, precedence: 1e9 + u * 10 + i, precedenceLow: 1e9 + u * 10 + i,
  }))
}

/** Removed files the state still carries tombstones for: one per 100 files, in key order (all samples). */
function* tombstones(n: number): Generator<{ key: string; table: Table; version: number; at: number }> {
  for (let i = 0; i < n / 100; i++) yield { key: `cell-0/data/metric_samples/tenant=${T}/day=${dayOf(0)}/L0-gone-${String(i).padStart(7, '0')}.parquet`, table: 'metric_samples', version: 900, at: 0 }
}

/** The files of the state: the N base files and the given units', in key order. */
function* state(n: number, units: number[]): Generator<LiveFile> {
  for (let k = 0; k < n; k++) yield fileAt(n, k)
  for (const u of units) yield* unitFiles(u)
}

const watermarks = [{ shard: 'pool/b/0', incarnation: 1000, seq: 1000 }]

/** One object written from pieces, streamed into a PUT of its exact length: never held whole. */
async function putStreamed(key: string, pieces: () => Iterable<string>): Promise<number> {
  let length = 0
  for (const p of pieces()) length += p.length // ASCII: characters are bytes
  const { readable, writable } = new FixedLengthStream(length)
  const put = E.BUCKET.put(key, readable)
  const w = writable.getWriter()
  let buf = ''
  for (const p of pieces()) {
    buf += p
    if (buf.length >= 1 << 16) {
      await w.write(enc.encode(buf))
      buf = ''
    }
  }
  if (buf) await w.write(enc.encode(buf))
  await w.close()
  await put
  return length
}

/** A `base` line (for a base segment or a format-1 checkpoint), in pieces. */
function* baseLine(inc: number, version: number, n: number, units: number[]): Generator<string> {
  yield `{"ledgerIncarnation":${inc},"version":${version},"at":0,"kind":"base","added":[`
  let first = true
  for (const f of state(n, units)) {
    yield `${first ? '' : ','}${JSON.stringify(f)}`
    first = false
  }
  yield `],"removed":[],"watermarks":${JSON.stringify(watermarks)},"tombstones":[`
  first = true
  for (const t of tombstones(n)) {
    yield `${first ? '' : ','}${JSON.stringify(t)}`
    first = false
  }
  yield ']}\n'
}

const header = (kind: string, v: number, inc: number, first: number, last: number) => `${JSON.stringify({ v, kind, tenant: T, ledgerIncarnation: inc, firstVersion: first, lastVersion: last, changes: last - first + 1 })}\n`

async function putUnitSegment(inc: number, version: number, u: number): Promise<void> {
  const change = { ledgerIncarnation: inc, version, at: 0, kind: 'add_unit', added: unitFiles(u), removed: [], watermark: { shard: 'pool/b/0', incarnation: 1000, seq: 1000 + u }, unit: { seqLo: 1000 + u, seqHi: 1000 + u } }
  await E.BUCKET.put(`${CELL}/${ledgerSegmentKey(T, inc, version, version)}`, `${header('viz.ledger.segment', 1, inc, version, version)}${JSON.stringify(change)}\n`)
}

/** A format-2 checkpoint: parts of at most 1 MiB of records (files in key order, then tombstones), then the manifest. */
async function putParts(inc: number, version: number, n: number, units: number[]): Promise<number> {
  const attempt = '0b0b0b0b'
  let lines: string[] = []
  let size = 0
  let parts = 0
  let bytes = 0
  let files = 0
  let tombs = 0
  const flush = async () => {
    if (lines.length === 0) return
    const body = encodeLedgerCheckpointPart(T, inc, version, attempt, parts, lines)
    const put = await E.BUCKET.put(`${CELL}/${ledgerCheckpointPartKey(T, inc, version, attempt, parts)}`, body)
    bytes += put!.size
    parts++
    lines = []
    size = 0
  }
  const add = async (line: string) => {
    if (lines.length > 0 && size + line.length + 1 > LEDGER_CHECKPOINT_PART_MAX_BYTES) await flush()
    lines.push(line)
    size += line.length + 1
  }
  for (const f of state(n, units)) {
    await add(JSON.stringify({ file: f }))
    files++
  }
  for (const t of tombstones(n)) {
    await add(JSON.stringify({ tombstone: t }))
    tombs++
  }
  await flush()
  await E.BUCKET.put(`${CELL}/${ledgerCheckpointKey(T, inc, version)}`, encodeLedgerCheckpointManifest(T, { ledgerIncarnation: inc, version, at: 0, attempt, parts, files, tombstones: tombs, bytes, watermarks, previousIncarnations: [] }))
  return parts
}

/** Incarnation `inc`: its base at `v0` (N files and units `before`), a segment adding unit `u` at v0+1, and the variant's checkpoint at v0+1. */
async function writeIncarnation(variant: Variant, inc: number, v0: number, n: number, before: number[], u: number): Promise<{ objects: number; bytes: number }> {
  const baseBytes = await putStreamed(`${CELL}/${ledgerSegmentKey(T, inc, v0, v0)}`, function* () {
    yield header('viz.ledger.segment', 1, inc, v0, v0)
    yield* baseLine(inc, v0, n, before)
  })
  await putUnitSegment(inc, v0 + 1, u)
  let objects = 2
  if (variant === 'one') {
    await putStreamed(`${CELL}/${ledgerCheckpointKey(T, inc, v0 + 1)}`, function* () {
      yield header('viz.ledger.checkpoint', 1, inc, v0 + 1, v0 + 1)
      yield* baseLine(inc, v0 + 1, n, [...before, u])
    })
    objects++
  } else if (variant === 'parts') objects += 1 + (await putParts(inc, v0 + 1, n, [...before, u]))
  return { objects, bytes: baseBytes }
}

async function wipe(prefix: string): Promise<void> {
  for (;;) {
    const page = await E.BUCKET.list({ prefix, limit: 1000 })
    if (page.objects.length === 0) return
    await E.BUCKET.delete(page.objects.map((o) => o.key))
  }
}

async function digest(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  let cursor: string | undefined
  do {
    const page = await E.BUCKET.list({ prefix: `${CELL}/iceberg/`, cursor })
    for (const o of page.objects) {
      const body = await (await E.BUCKET.get(o.key))!.arrayBuffer()
      out[o.key.slice(CELL.length + 1)] = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

describe('re-base at scale', () => {
  for (const n of SIZES) {
    for (const variant of VARIANTS) {
      it(`${variant}, ${n} files`, async () => {
        const estimate = n * (fileAt(n, 0).key.length + INDEX.length + 448)
        await wipe(`${CELL}/`)
        phase(`${variant}:${n}:write`, { estimateMiB: +(estimate / 2 ** 20).toFixed(1) })
        const log1 = await writeIncarnation(variant === 'before' ? 'base' : variant, 1, 1000, n, [], 1)
        const name = `${CELL}~${variant}-${n}`
        const p = (variant === 'before' ? E.PUBLISHER_BEFORE.get(E.PUBLISHER_BEFORE.idFromName(name)) : E.PUBLISHER.get(E.PUBLISHER.idFromName(name))) as DurableObjectStub<BenchPublisher>
        const result: Record<string, unknown> = { variant, files: n, estimateMiB: +(estimate / 2 ** 20).toFixed(1), baseMB: +(log1.bytes / 1e6).toFixed(1), objects: log1.objects }
        const run = async (step: string, f: () => Promise<{ tenants: { status: string; rebase?: unknown }[]; ops: unknown }>) => {
          phase(`${variant}:${n}:${step}`)
          const t0 = Date.now()
          const r = await f()
          const ms = Date.now() - t0
          phase(`${variant}:${n}:${step}:end`, { ms })
          expect(r.tenants[0]!.status, `${step}: ${JSON.stringify(r.tenants[0])}`).toBe('ok')
          result[step] = { ms, rebase: r.tenants[0]!.rebase, ops: r.ops }
          return r
        }
        if (STEPS.has('first')) {
          await run('first', () => p.publish([T]))
          const files = (await p.status('metric_samples')).files + (await p.status('metric_series')).files
          expect(files).toBe(n + 2)
          if (variant !== 'before') {
            expect(await (p as DurableObjectStub<BenchPublisher>).rows('stage')).toBe(0)
            console.log(`DIGEST ${n} ${variant} first ${JSON.stringify(await digest())}`)
          }
        }
        if (STEPS.has('rebase')) {
          await writeIncarnation(variant === 'before' ? 'base' : variant, 2, 1001, n, [1], 2)
          await run('rebase', () => p.publish([T]))
          expect((await p.status('metric_series')).files).toBe(n / 2 + 4)
        }
        if (STEPS.has('more')) {
          await putUnitSegment(2, 1003, 3)
          await run('more', () => p.publish([T]))
          expect((await p.status('metric_series')).files).toBe(n / 2 + 6)
        }
        if (STEPS.has('resync')) {
          await runInDurableObject(p, async (_i, s) => {
            await s.storage.deleteAll()
          })
          await evictDurableObject(p)
          await run('resync', () => p.publish([T]))
          expect((await p.status('metric_series')).files).toBe(n / 2 + 6)
        }
        console.log(`RESULT ${JSON.stringify(result)}`)
        await wipe(`${CELL}/`)
      })
    }
  }
})
