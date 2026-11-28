import { type Outcome, type Plan, type RouteEnv, type Signal, poolMap, probePlan, signalMap } from './route'

/**
 * Refusing a body before it is decoded when its answer is already known (D77; S10: "A 429 costs
 * edge a full decode"). Senders retry the same bytes after a 429 (Prometheus, the OpenTelemetry
 * Collector's exporters, S10's driver), so this isolate remembers, for a body it decoded and
 * refused with 429, which batches it routed to which shards. When the same body comes back:
 *
 * - before the `Retry-After` it was given has passed: 429 with what is left of it, at once;
 * - after: each shard is asked whether it would take those batches now, holding nothing
 *   (`Shard.reserve` with `hold: false`, one call per shard, all at once). Refused: 429 with the
 *   shards' own `Retry-After`. Otherwise the body is decoded and appended as any other.
 *
 * So a refusal before decoding is never longer than a shard's own `Retry-After` and never rests on
 * anything but a shard's answer for exactly those batches; nothing is accepted that was not
 * appended. A body is hashed only while its tenant was refused (for this signal) in the last
 * minute in this isolate: other tenants' requests pay nothing. Memory of this isolate only: a
 * retry that reaches another isolate is decoded there once. What that buys is measured in
 * `spikes/s15-ingest-atomic/README.md`.
 */

/** A tenant refused for a signal is "suspect" this long: its bodies are hashed so their refusals can be remembered. */
const SUSPECT_MS = 60_000
/** A refused body is remembered this long after its last refusal. */
const REMEMBER_MS = 5 * 60_000
const MAX_SUSPECTS = 10_000
const MAX_BODIES = 1_000

const suspects = new Map<string, number>()
const bodies = new Map<string, { plan: Plan; until: number; expires: number }>()

/** Tests; also harmless in production. */
export function clearEarly(): void {
  suspects.clear()
  bodies.clear()
}

const suspectKey = (tenant: string, signal: Signal): string => `${signal}\u0000${tenant}`

/**
 * The key a body is remembered by, or null when its tenant has not been refused recently (then it
 * is not hashed at all). `parts` are what besides the bytes decides how they decode: the path,
 * content type and encoding.
 */
export async function bodyKey(tenant: string, signal: Signal, parts: readonly string[], wire: Uint8Array): Promise<string | null> {
  const sk = suspectKey(tenant, signal)
  const t = suspects.get(sk)
  if (t === undefined) return null
  if (t <= Date.now()) {
    suspects.delete(sk)
    return null
  }
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', wire as Uint8Array<ArrayBuffer>))
  let hex = ''
  for (const x of d) hex += (x < 16 ? '0' : '') + x.toString(16)
  return `${sk}\u0000${parts.join('\u0000')}\u0000${hex}`
}

/** A refusal for a body this isolate remembers as refused, if it would still be refused; null: decode it. */
export async function refuseKnown(env: RouteEnv, tenant: string, signal: Signal, key: string | null): Promise<Exclude<Outcome, { status: 'ok' | 'unavailable' }> | null> {
  if (key === null) return null
  const e = bodies.get(key)
  if (!e) return null
  const now = Date.now()
  if (e.expires <= now) {
    bodies.delete(key)
    return null
  }
  // Still being refused: the tenant stays suspect, so its bodies go on being hashed.
  suspects.set(suspectKey(tenant, signal), now + SUSPECT_MS)
  if (now < e.until) return { status: 'backpressure', retryAfterMs: e.until - now }
  const map = signalMap(await poolMap(env, tenant), signal)
  // Routed with another map: the batches would go elsewhere. Decode.
  if (map.pool !== e.plan.pool || map.epoch !== e.plan.epoch) {
    bodies.delete(key)
    return null
  }
  let full = 0
  let overload = 0
  for (const r of await probePlan(env, map, tenant, e.plan)) {
    if (r.status !== 'backpressure') continue
    if (r.scope === 'overload' || r.scope === 'registering') overload = Math.max(overload, r.retryAfterMs, 1)
    else full = Math.max(full, r.retryAfterMs, 1)
  }
  if (overload > 0) return { status: 'overloaded', retryAfterMs: Math.max(overload, full) }
  if (full === 0) return null
  e.until = now + full
  e.expires = now + REMEMBER_MS
  return { status: 'backpressure', retryAfterMs: full }
}

/** Learn from a request's outcome: a 429 marks its tenant suspect and remembers its body (if hashed); an acceptance forgets it. */
export function noteOutcome(tenant: string, signal: Signal, key: string | null, outcome: Outcome): void {
  const now = Date.now()
  if (outcome.status === 'backpressure') {
    if (suspects.size >= MAX_SUSPECTS) suspects.clear()
    suspects.set(suspectKey(tenant, signal), now + SUSPECT_MS)
    if (key !== null && outcome.plan) {
      bodies.delete(key)
      if (bodies.size >= MAX_BODIES) bodies.delete(bodies.keys().next().value!)
      bodies.set(key, { plan: outcome.plan, until: now + outcome.retryAfterMs, expires: now + REMEMBER_MS })
    }
  } else if (key !== null && outcome.status === 'ok') {
    bodies.delete(key)
  }
}
