import { WorkerEntrypoint } from 'cloudflare:workers'
import { RECORDED_SAMPLES_CALLERS, type RecordedSamplesProps, type RecordedSamplesRefusal, type RecordedSamplesRpc } from '../../contracts/ingest'
import { TENANT_ID } from '../../contracts/ledger'
import type { SampleBatch } from '../../contracts/rules'
import { Collector } from './batch'
import { HttpError } from './errors'
import { type Limits, limitsFrom } from './limits'
import { type RouteEnv, appendAll, refuseEarly } from './route'

/**
 * Recorded samples from the ruler, over a service binding (contracts/ingest.ts, D45).
 *
 * The same path as a Remote Write request after its body is decoded: the same `Collector`
 * (label rules, accept window, limits), the same routing and appends. What differs is who the
 * caller is and where the tenant comes from: the binding (its `props.caller`) instead of an
 * API key, and the explicit, validated `tenant` argument instead of the key's record.
 *
 * Unlike Remote Write, a call with any invalid sample writes nothing: the ruler produced all
 * of them, so one bad value is a bug to report, not a sender's data to keep half of.
 */

export interface RecordedEnv extends RouteEnv {
  INGEST_LIMITS?: string
}

/** A refusal: the message starts with the refusal word (contracts/ingest.ts). */
export class RecordedSamplesError extends Error {
  constructor(
    readonly refusal: RecordedSamplesRefusal,
    detail: string,
  ) {
    super(`${refusal}: ${detail}`)
    this.name = 'RecordedSamplesError'
  }
}

function refuse(refusal: RecordedSamplesRefusal, detail: string): never {
  throw new RecordedSamplesError(refusal, detail)
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** Prometheus' text form of a sample value; null for anything else. */
export function parsePromValue(text: unknown): number | null {
  if (typeof text !== 'string') return null
  if (text === '+Inf' || text === 'Inf') return Infinity
  if (text === '-Inf') return -Infinity
  if (text === 'NaN') return NaN
  if (!DECIMAL.test(text)) return null
  const v = Number(text)
  return Number.isNaN(v) ? null : v
}

const enc = new TextEncoder()

/**
 * Feed batches into a collector. Labels are written into one scratch buffer with the four
 * offsets per label `Collector.addSeries` takes, so they go through exactly the validation
 * Remote Write's labels go through. Returns a description of the first malformed sample, or
 * null; samples the collector itself rejects are counted in it.
 */
export function collectRecorded(tenant: string, batches: unknown, c: Collector): string | null {
  if (!Array.isArray(batches)) return 'batches must be a list'
  const prefix = `${tenant}/`
  let offs = new Int32Array(4 * (c.limits.maxLabelsPerSeries + 1))
  for (const b of batches as SampleBatch[]) {
    if (typeof b !== 'object' || b === null) return 'a batch is not an object'
    if (typeof b.id !== 'string' || !b.id.startsWith(prefix)) return `batch ${JSON.stringify(String(b.id).slice(0, 80))} is not one of tenant ${tenant}'s`
    if (!Array.isArray(b.samples)) return `batch ${b.id}: samples must be a list`
    for (const s of b.samples) {
      if (typeof s !== 'object' || s === null || typeof s.labels !== 'object' || s.labels === null || Array.isArray(s.labels)) return `batch ${b.id}: a sample without labels`
      if (typeof s.timeMs !== 'number' || !Number.isSafeInteger(s.timeMs)) return `batch ${b.id}: timeMs must be an integer of milliseconds`
      const value = parsePromValue(s.value)
      if (value === null) return `batch ${b.id}: value ${JSON.stringify(String(s.value).slice(0, 40))} is not a Prometheus sample value`
      const entries = Object.entries(s.labels)
      if (entries.some(([, v]) => typeof v !== 'string')) return `batch ${b.id}: label values must be strings`
      // One slot past the limit is kept so the collector sees (and rejects) too many labels.
      const n = Math.min(entries.length, c.limits.maxLabelsPerSeries + 1)
      if (offs.length < 4 * n) offs = new Int32Array(4 * n)
      const parts = entries.slice(0, n).map(([k, v]) => [enc.encode(k), enc.encode(v as string)] as const)
      const buf = new Uint8Array(parts.reduce((a, [k, v]) => a + k.length + v.length, 0))
      let p = 0
      parts.forEach(([k, v], i) => {
        offs[4 * i] = p
        buf.set(k, p)
        p += k.length
        offs[4 * i + 1] = offs[4 * i + 2] = p
        buf.set(v, p)
        p += v.length
        offs[4 * i + 3] = p
      })
      const series = c.addSeries(buf, offs, n)
      if (series < 0) c.reject(-series, 1)
      else c.addSampleNumber(series, s.timeMs, value)
    }
  }
  return null
}

/**
 * Write recorded samples for `tenant`. Resolves only when every sample is durably appended;
 * otherwise throws a `RecordedSamplesError` (contracts/ingest.ts). Exported for the
 * entrypoint and its tests.
 */
export async function writeRecorded(env: RecordedEnv, caller: unknown, tenant: unknown, batches: unknown, now = Date.now()): Promise<void> {
  // The binding is the credential: only a binding whose config names an allowed caller.
  if (typeof caller !== 'string' || !RECORDED_SAMPLES_CALLERS.includes(caller)) refuse('unauthorized', 'this service binding does not name a caller allowed to write recorded samples')
  if (typeof tenant !== 'string' || !TENANT_ID.test(tenant)) refuse('invalid', 'tenant id must match [A-Za-z0-9_-]{1,64}')
  const t = tenant as string
  let limits: Limits
  try {
    limits = limitsFrom(env.INGEST_LIMITS)
  } catch (e) {
    return refuse('unavailable', e instanceof Error ? e.message : String(e))
  }
  const early = await refuseEarly(env, t, now)
  if (early) refuse('overloaded', `ingest shard is overloaded; retry after ${early.retryAfterMs} ms`)
  const c = new Collector(limits, now)
  let malformed: string | null
  try {
    malformed = collectRecorded(t, batches, c)
  } catch (e) {
    // The collector's request limits (series, samples per call).
    if (e instanceof HttpError && e.status === 413) return refuse('too_large', e.message)
    throw e
  }
  if (malformed) refuse('invalid', `${malformed}; nothing was written`)
  if (c.rejectedTotal > 0) refuse('invalid', `rejected ${c.rejectedTotal} of ${c.received} samples (${c.rejectionSummary()}); nothing was written`)
  if (c.nRows === 0) return
  let outcome: Awaited<ReturnType<typeof appendAll>>
  try {
    outcome = await appendAll(env, t, c)
  } catch (e) {
    if (e instanceof HttpError) return refuse(e.status === 413 ? 'too_large' : 'unavailable', e.message)
    return refuse('unavailable', e instanceof Error ? e.message : String(e))
  }
  if (outcome.status === 'backpressure') refuse('backpressure', `ingest buffer is full; retry after ${outcome.retryAfterMs} ms`)
  if (outcome.status === 'overloaded') refuse('overloaded', `ingest shard is overloaded; retry after ${outcome.retryAfterMs} ms`)
  if (outcome.status !== 'ok') refuse('unavailable', `${outcome.reason}; retry`)
  const ok = outcome as Extract<typeof outcome, { status: 'ok' }>
  if (ok.limited) {
    refuse('series_limit', `the tenant's limit is ${ok.limited.limit} active series; ${ok.limited.series} new series with ${ok.limited.rows} samples refused, ${ok.rows} samples of existing series written`)
  }
}

/**
 * The entrypoint (contracts/ingest.ts `RECORDED_SAMPLES_ENTRYPOINT`). Exported by the ingest
 * Worker's main module; reachable only through a service binding that names it.
 */
export class RecordedSamples extends WorkerEntrypoint<RecordedEnv> implements RecordedSamplesRpc {
  async write(tenant: string, batches: SampleBatch[]): Promise<void> {
    const props = (this.ctx as { props?: Partial<RecordedSamplesProps> }).props
    await writeRecorded(this.env, props?.caller, tenant, batches)
  }
}
