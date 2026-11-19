/**
 * The ingest Worker's service surface: what other viz Workers ask viz-ingest for over a
 * service binding, never over HTTP. (Senders use the HTTP API: Remote Write, OTLP.)
 *
 * Added 2026-11-19 (decision D45). One entrypoint so far:
 *
 *   RecordedSamples.write  the ruler's recording-rule output, written to the tenant's shards
 *                          exactly as a Remote Write request would be, without an API key
 *
 * How a caller is authenticated. The entrypoint is a named `WorkerEntrypoint` export of the
 * ingest Worker. Only a Worker of this account whose deployed config has a service binding
 * naming it can call it; a request from the internet reaches only the default export's
 * `fetch`, and the gateway binds only the default entrypoint. The binding also carries the
 * caller's name in its `props`, which only the binding's own config sets:
 *
 *   { "binding": "SINK", "service": "viz-ingest", "entrypoint": "RecordedSamples",
 *     "props": { "caller": "viz-ruler" } }
 *
 * The entrypoint refuses (`unauthorized`) any call whose `ctx.props.caller` is not in
 * `RECORDED_SAMPLES_CALLERS`. So the binding is the credential: there is no API key to store,
 * issue, rotate or leak.
 *
 * Where the tenant comes from. It is the explicit first argument, which only a holder of that
 * binding can supply. The caller takes it from its own binding context (a Ruler object's name,
 * which its HTTP API derived from a credential), never from a request body. The entrypoint
 * validates it against `TENANT_ID` and requires every batch id to start with `<tenant>/`
 * (`SampleBatch.id` is `<tenant>/<shard>/<group>/<rule key>@<time>`, contracts/rules.ts), so a
 * caller that mixed up tenants is refused instead of writing one tenant's samples to another.
 *
 * Results (the same promise as `Sink.write` in contracts/rules.ts, with the tenant first):
 *
 * - **Resolves** only when every sample of every batch is durably appended to the tenant's
 *   shards: what a 204 from Remote Write means.
 * - **Rejects** otherwise. Nothing is promised about what was written; sending the same batches
 *   again is safe, because a sample is identified by its series and timestamp and the write
 *   path keeps one value per (series, timestamp). The error's message starts with one of
 *   `RECORDED_SAMPLES_REFUSALS` and `: ` (only the message survives an RPC boundary reliably):
 *
 *   | Refusal | Meaning | Retry? |
 *   |---|---|---|
 *   | `unauthorized` | the binding does not name an allowed caller | no |
 *   | `invalid` | a bad tenant, a batch of another tenant, or a sample the HTTP API would reject (labels, value, timestamp outside the accept window); **nothing** was written | no |
 *   | `series_limit` | new series over the tenant's active-series limit; samples of existing series were written | no |
 *   | `too_large` | more series or samples than one request may carry; nothing was written | split |
 *   | `backpressure` | a shard's buffer is full | yes, after the hint |
 *   | `overloaded` | a shard sheds load | yes, after the hint |
 *   | `unavailable` | a shard or the pool map cannot be reached or read | yes |
 *
 * A caller must treat any other message, and any rejection at all, as "not written".
 *
 * Values are Prometheus' text form (`RecordedSample.value`): a decimal, `+Inf` (or `Inf`),
 * `-Inf`, `NaN`. Anything else is `invalid`. Labels follow contracts/BATCH.md (a `__name__`,
 * byte limits, no NUL, UTF-8), as for Remote Write.
 *
 * Versions: 1. The arguments are `SampleBatch` as contracts/rules.ts defines it; an unknown
 * optional field is ignored (contracts/COMPATIBILITY.md §3.2). A new optional argument or field
 * is added only once every ingest release that may run reads it (callee first, §3.3).
 */

import type { SampleBatch } from './rules'

/** The named export of the ingest Worker that serves recorded samples. */
export const RECORDED_SAMPLES_ENTRYPOINT = 'RecordedSamples'

/** Callers allowed to write recorded samples: the value of `props.caller` on their binding. */
export const RECORDED_SAMPLES_CALLERS: readonly string[] = ['viz-ruler']

/** What a caller's service binding carries in `props`. */
export interface RecordedSamplesProps {
  caller: string
}

/** The first word of a rejection's message. */
export const RECORDED_SAMPLES_REFUSALS = ['unauthorized', 'invalid', 'series_limit', 'too_large', 'backpressure', 'overloaded', 'unavailable'] as const
export type RecordedSamplesRefusal = (typeof RECORDED_SAMPLES_REFUSALS)[number]

/** Refusals after which the same call may succeed. */
export const RECORDED_SAMPLES_RETRYABLE: readonly RecordedSamplesRefusal[] = ['backpressure', 'overloaded', 'unavailable']

export interface RecordedSamplesRpc {
  /** See above: resolves only when everything is durably appended; rejects with a refusal otherwise. */
  write(tenant: string, batches: SampleBatch[]): Promise<void>
}
