/// <reference path="../../engine/wasm/js/wasm.d.ts" />
/**
 * Compaction of the span and log tables (contracts/TRACES.md and LOGS.md, "Compaction"), in
 * workerd against the real Shard, Ledger, flush and janitor, with D30's rules:
 *
 *   - spans merge per hour (never across one), trace_index and logs per day, by the metric
 *     policy, into keys of the contracts; a reader (hyparquet, sharing no code with viz) sees
 *     the same rows before and after; every output carries its inputs record;
 *   - D30's safety cases for these tables: a crash after PUT (the retry adopts the object), two
 *     steps at once (one `replace`, nothing deleted), retention during a step (`conflict`, the
 *     output left; the sweep keeps it until an input is purged, then deletes it), a sweep between
 *     an adopting step's PUT and its replace (nothing deleted);
 *   - an engine without `mergeSignalFiles` leaves the span and log tables alone.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { parquetMetadata, parquetReadObjects } from '../../bench/node_modules/hyparquet/src/index.js'
import type { Engine } from '../../contracts/engine'
import { type LiveFile, type SignalTable, dataKeyPrefix } from '../../contracts/ledger'
import { encodeLogBatch, encodeSpanBatch, id } from '../../engine/wasm/test/signal'
import { DAY_MS, T0, dataKeys, flushSettled, ledgerStub, liveKeys, sha256Hex, shardStub } from '../../flush/test/helpers'
import { type JanitorEnv, purgeTenant, sweepOrphans } from '../../janitor/src/janitor'
import type { Shard } from '../../shard/src/shard'
import { COMPACTION_INPUTS_META, type StepResult, compactStep, compactTenant, decodeCompactionInputs, engine } from '../src/index'

const HOUR = 3_600_000
const NS = 1_000_000n
/** A policy clock at which T0's hour is quiet but its day still open, and one at which it is closed. */
const QUIET = T0 + 30 * 60_000
const CLOSED = T0 + 2 * DAY_MS
const janitorEnv = env as unknown as JanitorEnv

let n = 0
function signalStream(signal: 'traces' | 'logs', prefix: string) {
  const id = `${prefix}-${Date.now().toString(36)}-${n++}`
  const tenant = `cs-${id}`
  const shardName = `pool-${id}/${signal}/0`
  return { tenant, shardName, shard: shardStub(shardName), ledger: ledgerStub(tenant) }
}

async function append(shard: DurableObjectStub<Shard>, tenant: string, payload: Uint8Array): Promise<void> {
  const rows = new DataView(payload.buffer, payload.byteOffset).getUint32(8, true)
  const r = await shard.append({ tenant, epoch: 1, fingerprint: await sha256Hex(payload), payload, rows })
  if (r.status !== 'ok') throw new Error(`append: ${JSON.stringify(r)}`)
}

/**
 * Segment `i` of a trace stream: trace `i` (a root and a child) and span `i` of trace 99, which
 * every segment adds to, so the trace_index merge joins fragments; segment 1 also re-sends
 * segment 0's root under a later name (the later write must win). Starts at `at(i)` ms.
 */
const spanSegment = (i: number, at: number) => {
  const start = BigInt(at) * NS
  const rows = [
    { entry: 0, traceId: id(16, i + 1), spanId: id(8, 1), start, end: start + 1_000n, name: `root ${i}`, kind: 2 },
    { entry: 0, traceId: id(16, i + 1), spanId: id(8, 2), parentSpanId: id(8, 1), start: start + 10n, end: start + 20n, name: 'child', status: 2 },
    { entry: 0, traceId: id(16, 99), spanId: id(8, i + 1), start: start + 5n, end: start + 6n, name: `part ${i}` },
  ]
  if (i === 1) rows.push({ entry: 0, traceId: id(16, 1), spanId: id(8, 1), start: BigInt(T0) * NS, end: BigInt(T0) * NS + 1_000n, name: 'root 0 (again)', kind: 2 })
  return encodeSpanBatch([{ resourceFp: BigInt(i % 2), resource: [['service.name', { s: `svc-${i % 2}` }]] }], rows)
}

/** Segment `i` of a log stream; segment 1 repeats a row of segment 0 (one row, the later wins). */
const logSegment = (i: number, at: number) => {
  const ts = BigInt(at) * NS
  const rows = [
    { entry: 0, ts, line: `GET /api/users/${i} took 12ms`, metadata: [['user', `u${i}`]] as [string, string][] },
    { entry: 0, ts: ts + 1n, line: `error: connection refused ${i}`, severity: 17 },
  ]
  if (i === 1) rows.push({ entry: 0, ts: BigInt(T0) * NS, line: 'GET /api/users/0 took 12ms', metadata: [['user', 'u0']], severity: 9 } as never)
  return encodeLogBatch([{ labels: { service_name: 'api', env: 'prod' } }], rows)
}

/** `n` sealed segments of one signal stream, flushed: n units. */
async function flushed(signal: 'traces' | 'logs', prefix: string, count: number, at: (i: number) => number = (i) => T0 + i * 60_000) {
  const s = signalStream(signal, prefix)
  for (let i = 0; i < count; i++) {
    await append(s.shard, s.tenant, signal === 'traces' ? spanSegment(i, at(i)) : logSegment(i, at(i)))
    await s.shard.seal(s.tenant)
  }
  const r = await flushSettled(env, engine, s.tenant, s.shardName)
  expect(r).toMatchObject({ status: 'ok', awaitingLog: false })
  return s
}

const plan = async (l: DurableObjectStub<import('../../ledger/src/ledger').Ledger>, table: SignalTable): Promise<LiveFile[]> =>
  (await l.plan({ table, minTs: 0, maxTs: Number.MAX_SAFE_INTEGER })).files
const objectRows = async (key: string) => parquetReadObjects({ file: await (await env.BUCKET.get(key))!.arrayBuffer() })
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/**
 * What a reader of the tenant's live files sees (hyparquet), files in precedence order, the later
 * winning on a row key: spans by (trace, span), log rows by (stream, ts, line, metadata); and per
 * trace the merged extent and span count of its trace_index rows.
 */
async function reader(l: DurableObjectStub<import('../../ledger/src/ledger').Ledger>) {
  const spans = new Map<string, string>()
  for (const f of await plan(l, 'spans')) for (const r of await objectRows(f.key)) spans.set(`${hex(r.trace_id as Uint8Array)}/${hex(r.span_id as Uint8Array)}`, `${r.span_name} @${r.start_unix_nano} ${r.status_code}`)
  const logs = new Map<string, string>()
  for (const f of await plan(l, 'logs')) for (const r of await objectRows(f.key)) logs.set(`${r.stream_id}|${r.ts}|${r.line}|${JSON.stringify(r.metadata)}`, `sev ${r.severity_number ?? 0}`)
  const traces = new Map<string, [bigint, bigint, number]>()
  for (const f of await plan(l, 'trace_index')) {
    for (const r of await objectRows(f.key)) {
      const k = hex(r.trace_id as Uint8Array)
      const x = traces.get(k) ?? [r.min_start_unix_nano as bigint, r.max_end_unix_nano as bigint, 0]
      traces.set(k, [x[0] < (r.min_start_unix_nano as bigint) ? x[0] : (r.min_start_unix_nano as bigint), x[1] > (r.max_end_unix_nano as bigint) ? x[1] : (r.max_end_unix_nano as bigint), x[2] + (r.span_count as number)])
    }
  }
  const sorted = (m: Map<string, unknown>) => [...m].map(([k, v]) => `${k} ${String(v)}`).sort()
  return { spans: sorted(spans), logs: sorted(logs), traces: sorted(traces) }
}

const exists = async (keys: string[]) => (await Promise.all(keys.map((k) => env.BUCKET.head(k)))).map((o) => o !== null)

describe('compaction of spans, trace_index and logs', () => {
  it('merges an open hour of spans and of trace_index, then of logs, into keys of the contracts; a reader sees the same rows', async () => {
    const t = await flushed('traces', 'open', 4)
    const before = await reader(t.ledger)
    expect(before.spans).toHaveLength(4 * 3)
    expect(before.spans.find((x) => x.startsWith(`${'01'.repeat(16)}/${'01'.repeat(8)}`))).toContain('root 0 (again)')
    const inputs = { spans: await plan(t.ledger, 'spans'), trace_index: await plan(t.ledger, 'trace_index') }
    expect(inputs.spans).toHaveLength(4)

    // The metric tables are empty: the step takes spans first.
    const r = await compactStep(env, engine, t.tenant, { now: QUIET })
    expect(r).toMatchObject({ status: 'merged', job: { table: 'spans', level: 1, hour: 12, why: 'l0_count' } })
    if (r.status !== 'merged') return
    const [out] = r.outputs
    expect(out!.key).toMatch(new RegExp(`^${dataKeyPrefix('cell-0', 'spans', t.tenant, '2026-11-18', 12)}L1-h12-[0-9a-f]{16}-[0-9a-f]{8}\\.parquet$`))
    const bytes = new Uint8Array(await (await env.BUCKET.get(out!.key))!.arrayBuffer())
    expect(out!.key.slice(-16, -8)).toBe((await sha256Hex(bytes)).slice(0, 8))
    expect(out!.rows).toBe(12)
    const meta = (await env.BUCKET.head(out!.key))!.customMetadata?.[COMPACTION_INPUTS_META]
    expect(await decodeCompactionInputs(out!.key, meta)).toEqual({ inputs: inputs.spans.map((f) => f.key).sort() })
    expect((await plan(t.ledger, 'spans')).map((f) => f.key)).toEqual([out!.key])

    // Then trace_index: trace 99's four fragments become one row with four spans.
    const r2 = await compactStep(env, engine, t.tenant, { now: QUIET })
    expect(r2).toMatchObject({ status: 'merged', job: { table: 'trace_index', level: 1, hour: 12 } })
    if (r2.status !== 'merged') return
    expect(r2.outputs[0]!.key).toMatch(/\/data\/trace_index\/tenant=[^/]+\/day=2026-11-18\/L1-h12-[0-9a-f]{16}-[0-9a-f]{8}\.parquet$/)
    const rows = await objectRows(r2.outputs[0]!.key)
    expect(rows.find((x) => hex(x.trace_id as Uint8Array) === '63'.repeat(16))!.span_count).toBe(4)
    expect(await compactStep(env, engine, t.tenant, { now: QUIET })).toMatchObject({ status: 'idle' })
    expect(await reader(t.ledger)).toEqual(before)

    // Logs: the repeated row once, with the later severity; the output has its token filter.
    const l = await flushed('logs', 'open-logs', 4)
    const logsBefore = await reader(l.ledger)
    expect(logsBefore.logs).toHaveLength(8)
    const r3 = await compactStep(env, engine, l.tenant, { now: QUIET })
    expect(r3).toMatchObject({ status: 'merged', job: { table: 'logs', level: 1, hour: 12 } })
    if (r3.status !== 'merged') return
    expect(r3.outputs[0]!.key).toMatch(/\/data\/logs\/tenant=[^/]+\/day=2026-11-18\/L1-h12-[0-9a-f]{16}-[0-9a-f]{8}\.parquet$/)
    expect(r3.outputs[0]!.rows).toBe(8)
    expect(await reader(l.ledger)).toEqual(logsBefore)
    const tok = JSON.parse(r3.outputs[0]!.index).tok as [number, number]
    const file = await (await env.BUCKET.get(r3.outputs[0]!.key))!.arrayBuffer()
    const kv = (parquetMetadata(file).key_value_metadata ?? []).find((x: { key: string }) => x.key === 'viz.token_filter')
    expect(kv?.value).toBe(`${tok[0]},${tok[1]}`)
    expect(new TextDecoder().decode(new Uint8Array(file, tok[0], 4))).toBe('VZT1')
  })

  it('a closed day: spans become one level-2 file per hour, trace_index and logs one per day; the rows never change', async () => {
    // Spans over three hours of one day, and logs, each four units.
    const at = (i: number) => T0 + (i % 3) * HOUR + i * 1000
    const t = await flushed('traces', 'closed', 4, at)
    const l = await flushed('logs', 'closed-logs', 4, at)
    for (const s of [t, l]) {
      const before = await reader(s.ledger)
      const run = await compactTenant(env, engine, s.tenant, { now: CLOSED, maxSteps: 20 })
      expect(run.more).toBe(false)
      expect(run.steps.every((x) => x.status === 'merged' || x.status === 'idle')).toBe(true)
      expect(await reader(s.ledger)).toEqual(before)
    }
    const spans = await plan(t.ledger, 'spans')
    expect(spans.map((f) => [f.level, /\/hour=(\d\d)\/L2-h(\d\d)-/.exec(f.key)?.slice(1)])).toEqual([12, 13, 14].map((h) => [2, [String(h), String(h)]]))
    expect((await plan(t.ledger, 'trace_index')).map((f) => [f.level, /\/L2-d-/.test(f.key)])).toEqual([[2, true]])
    expect((await plan(l.ledger, 'logs')).map((f) => [f.level, /\/L2-d-/.test(f.key)])).toEqual([[2, true]])
  })

  it('an engine without mergeSignalFiles leaves the span and log tables alone', async () => {
    const t = await flushed('traces', 'noengine', 4)
    const metricsOnly: Engine = { ...engine, mergeSignalFiles: undefined } as unknown as Engine
    expect(await compactStep(env, metricsOnly, t.tenant, { now: QUIET })).toMatchObject({ status: 'idle' })
    expect(await plan(t.ledger, 'spans')).toHaveLength(4)
  })
})

/** D30 (design/DECISIONS.md) for the span and log tables, as `test/compact.test.ts` shows it for metrics. */
describe('D30 for the span and log tables', () => {
  for (const [signal, table] of [['traces', 'spans'], ['logs', 'logs']] as const) {
    it(`${table}: a step that stops after its PUT is repeated with the same key, adopts the object, and no second object exists`, async () => {
      const t = await flushed(signal, `crash-${table}`, 4)
      const before = await reader(t.ledger)
      let leftover: string[] = []
      await expect(compactStep(env, engine, t.tenant, { now: QUIET, hooks: { afterPut: (o) => { leftover = o.map((f) => f.key); throw new Error('crash after PUT') } } })).rejects.toThrow('crash after PUT')
      expect(await exists(leftover)).toEqual([true])
      expect((await liveKeys(t.ledger)).includes(leftover[0]!)).toBe(false)
      expect(await reader(t.ledger)).toEqual(before)
      // The retry, with a sweep 25 h on between its PUT and its replace (review R-2): nothing deleted.
      let swept: string[] = ['not run']
      const r = await compactStep(env, engine, t.tenant, { now: QUIET, hooks: { afterPut: async () => { swept = (await sweepOrphans(janitorEnv, t.tenant, { now: Date.now() + 25 * HOUR })).deleted } } })
      expect(r).toMatchObject({ status: 'merged', job: { table }, put: ['exists'] })
      expect(swept).toEqual([])
      expect((await dataKeys(t.tenant)).filter((k) => /\/L1-/.test(k))).toEqual(leftover)
      expect(await reader(t.ledger)).toEqual(before)
    })

    it(`${table}: two steps at once leave one output, one replace, and delete nothing`, async () => {
      const t = await flushed(signal, `twice-${table}`, 6)
      const before = await reader(t.ledger)
      const results: StepResult[] = await Promise.all([0, 1, 2].map(() => compactStep(env, engine, t.tenant, { now: QUIET })))
      expect(results.filter((x) => x.status === 'merged')).toHaveLength(1)
      for (const x of results) expect(['merged', 'conflict']).toContain(x.status)
      const outputs = (await dataKeys(t.tenant)).filter((k) => /\/L1-/.test(k))
      expect(outputs).toHaveLength(1)
      expect(await reader(t.ledger)).toEqual(before)
    })

    it(`${table}: retention during a step conflicts; the output is left until an input is gone for good, then the sweep deletes it`, async () => {
      // Three units on an old day and one today: the step merges the old day's (closed) files.
      const t = await flushed(signal, `ret-${table}`, 4, (i) => (i < 3 ? T0 - 3 * DAY_MS + i * 60_000 : T0))
      const live = await liveKeys(t.ledger)
      let outputs: string[] = []
      const tables: SignalTable[] = table === 'spans' ? ['spans', 'trace_index'] : ['logs']
      const r = await compactStep(env, engine, t.tenant, {
        now: T0,
        hooks: {
          afterPut: async (out) => {
            outputs = out.map((f) => f.key)
            expect(await exists(outputs)).toEqual([true])
            await t.ledger.expire({ tables, beforeDay: '2026-11-17' })
          },
        },
      })
      expect(r).toMatchObject({ status: 'conflict', job: { table, day: '2026-11-15', level: 2 } })
      // The step deletes nothing; the expired day does not come back.
      expect(await exists(outputs)).toEqual([true])
      expect(await liveKeys(t.ledger)).toEqual(live.filter((k) => k.includes('day=2026-11-18')))
      // Inputs expired but not purged: kept. Purged: no step can ever list the output, so it goes.
      expect((await sweepOrphans(janitorEnv, t.tenant, { now: Date.now() + 25 * HOUR })).deleted).toEqual([])
      await t.ledger.drain()
      await purgeTenant(janitorEnv, t.tenant, { graceMs: 0 })
      expect((await sweepOrphans(janitorEnv, t.tenant, { now: Date.now() + 25 * HOUR })).deleted).toEqual(outputs)
      expect((await dataKeys(t.tenant)).filter((k) => k.includes('day=2026-11-15'))).toEqual([])
    })
  }

  it('the sweep reads a spans output\'s inputs record under its hour, and refuses one naming another hour\'s files', async () => {
    const t = await flushed('traces', 'hour-rec', 4)
    await expect(compactStep(env, engine, t.tenant, { now: QUIET, hooks: { afterPut: () => { throw new Error('crash') } } })).rejects.toThrow('crash')
    const [out] = (await dataKeys(t.tenant)).filter((k) => /\/L1-/.test(k))
    const meta = (await env.BUCKET.head(out!))!.customMetadata![COMPACTION_INPUTS_META]!
    const d = await decodeCompactionInputs(out!, meta)
    expect('inputs' in d && d.inputs.every((k) => k.includes('/hour=12/'))).toBe(true)
    const moved = meta.replaceAll('/hour=12/', '/hour=13/')
    expect(await decodeCompactionInputs(out!, moved)).toMatchObject({ unreadable: expect.stringMatching(/tenant and day|hash/) })
    // The leftover is kept while its inputs are live, a year on.
    expect((await sweepOrphans(janitorEnv, t.tenant, { now: Date.now() + 365 * DAY_MS })).deleted).toEqual([])
  })
})
