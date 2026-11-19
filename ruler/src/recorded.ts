/**
 * Where recording rules' samples go in production: viz-ingest's `RecordedSamples` entrypoint
 * over the `SINK` service binding (contracts/ingest.ts, D45). The binding is the credential, so
 * no key goes with the call; the tenant is the explicit first argument, the Ruler object's own
 * (from its name, which the HTTP API derived from a credential).
 *
 * What the entrypoint answers, and what the ruler does with it:
 *
 * - **Resolves**: every sample of every batch is durably appended (what a 204 from Remote Write
 *   means). The tick goes on.
 * - **Rejects with a refusal word** (`RECORDED_SAMPLES_REFUSALS`, the start of the message):
 *   `unauthorized`, `invalid` and `series_limit` are reported at once, since the same call would
 *   be refused again; `too_large` splits the call in two by whole batches and sends both halves,
 *   down to single batches (a batch is never split: its id names one rule at one time, and a sink
 *   may remember ids), and a batch too large alone is reported like `invalid`; `backpressure`,
 *   `overloaded` and `unavailable` are retried by the tick, after the hint the message carries.
 * - **Rejects with anything else**: the entrypoint did not answer by its contract. Either the
 *   viz-ingest release serving this call does not have it (a rollback of viz-ingest below the
 *   release that added it, or a deploy still propagating: contracts/COMPATIBILITY.md §1.1), or
 *   the platform failed the call. Nothing is known to be written and re-sending is harmless, so
 *   the same samples go through Remote Write over `INGEST` with the shard's service key, the path
 *   of the release before this one (D52). Without `INGEST`, the failure is retried like
 *   `unavailable`.
 *
 * Re-sending is harmless on both paths: a sample is identified by its series and timestamp, and
 * the write path keeps one value per (series, timestamp).
 */
import { RECORDED_SAMPLES_REFUSALS, RECORDED_SAMPLES_RETRYABLE, type RecordedSamplesRefusal, type RecordedSamplesRpc } from '../../contracts/ingest'
import type { SampleBatch, Sink } from '../contracts-proposal/rules.v2'
import { errorText } from './evaluator'

/** A failed sink write that says how the tick should treat it. Other errors are retried, as before. */
export class SinkError extends Error {
  constructor(
    message: string,
    /** False: the same call would fail the same way; report it without retrying. */
    readonly retryable: boolean,
    /** How long to wait before retrying, from the callee's hint; 0 = at once. */
    readonly retryAfterMs = 0,
  ) {
    super(message)
    this.name = 'SinkError'
  }
}

/** The refusal a rejection's message starts with (contracts/ingest.ts), or null when it starts with none. */
export function refusalOf(message: string): RecordedSamplesRefusal | null {
  for (const r of RECORDED_SAMPLES_REFUSALS) if (message.startsWith(`${r}: `)) return r
  return null
}

/** The wait a refusal asks for: its message's `retry after <n> ms`, else 0. */
export function retryHintMs(message: string): number {
  const m = /retry after (\d{1,9}) ms/.exec(message)
  return m ? Number(m[1]) : 0
}

/**
 * The sink over the entrypoint. `fallback` is Remote Write (`remote.ts`), used only when the
 * entrypoint does not answer by its contract; `warn` says so in the Worker's log (the message is
 * the runtime's or the callee's, never a key).
 */
export function recordedSamplesSink(binding: RecordedSamplesRpc, tenant: string, fallback: Sink | null, warn: (line: string) => void = (l) => console.warn(l)): Sink {
  const send = async (batches: SampleBatch[]): Promise<void> => {
    let message: string
    try {
      await binding.write(tenant, batches)
      return
    } catch (e) {
      message = errorText(e)
    }
    const refusal = refusalOf(message)
    if (refusal === null) {
      if (!fallback) throw new SinkError(`the ingest service's RecordedSamples entrypoint did not answer: ${message}`, true)
      warn(`ruler: recorded samples of ${tenant} sent by Remote Write: the RecordedSamples entrypoint did not answer by its contract (${message.slice(0, 200)})`)
      try {
        await fallback.write(batches)
      } catch (e) {
        throw new SinkError(`the RecordedSamples entrypoint did not answer (${message.slice(0, 200)}), and Remote Write failed: ${errorText(e)}`, true)
      }
      return
    }
    if (refusal === 'too_large' && batches.length > 1) {
      // Both halves are sent, so one batch that is too large alone does not keep the others
      // out; the first failure is the call's.
      const half = Math.ceil(batches.length / 2)
      let first: unknown = null
      for (const part of [batches.slice(0, half), batches.slice(half)]) {
        try {
          await send(part)
        } catch (e) {
          first ??= e
        }
      }
      if (first !== null) throw first
      return
    }
    throw new SinkError(message, RECORDED_SAMPLES_RETRYABLE.includes(refusal), retryHintMs(message))
  }
  return {
    async write(batches) {
      if (!batches.some((b) => b.samples.length > 0)) return
      await send(batches)
    },
  }
}
