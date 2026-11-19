import { runDurableObjectAlarm } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import type { PromVector } from '../../contracts/engine'
import type { RulerConfig, RulerLimits } from '../contracts-proposal/rules'
import { tenantWorld, world, T0, type TestNotifier, type TestRuler } from './harness'

export const MIN = 60_000

let n = 0
/** A tenant nobody has used yet. */
export const newTenant = (prefix = 't') => `${prefix}${n++}-${Math.random().toString(36).slice(2, 8)}`

export const rulerStub = (tenant: string, shard = '0') => env.RULER.get(env.RULER.idFromName(`${tenant}/${shard}`))
export const notifierStub = (tenant: string) => env.NOTIFIER.get(env.NOTIFIER.idFromName(tenant))

/** `vec([{ instance: 'a' }, 1], ...)` */
export function vec(...series: [Record<string, string>, number | string][]): PromVector {
  return { resultType: 'vector', result: series.map(([metric, v]) => ({ metric, value: [0, String(v)] })) }
}

export type ConfigPatch = Partial<Omit<RulerConfig, 'limits'>> & { limits?: Partial<RulerLimits> }

/** A fresh tenant with a ruler on shard 0; the dead-man's switch is off unless asked for. */
export async function setup(patch: ConfigPatch = {}, tenant = newTenant()) {
  world.now = T0
  const stub = rulerStub(tenant)
  const r = await stub.configure(tenant, { deadman: false, ...patch })
  expect(r.status).toBe('ok')
  return { tenant, stub, w: tenantWorld(tenant), notifier: notifierStub(tenant) }
}

export const ok = <T extends { status: string }>(r: T): Extract<T, { status: 'ok' }> => {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r as Extract<T, { status: 'ok' }>
}

/** Move the clock to `at` and run the object's alarm, which must be armed. */
export async function alarmAt(stub: DurableObjectStub<TestRuler> | DurableObjectStub<TestNotifier>, at: number): Promise<void> {
  world.now = at
  expect(await runDurableObjectAlarm(stub)).toBe(true)
}

/** Run the ruler at its next scheduled deadline and return that time. */
export async function nextTick(stub: DurableObjectStub<TestRuler>, tenant: string): Promise<number> {
  const h = ok(await stub.health(tenant))
  if (h.alarmAtMs === null) throw new Error('no alarm armed')
  await alarmAt(stub, Math.max(h.alarmAtMs, world.now))
  return world.now
}

/** Run the notifier's alarm if one is due at or before `at`; returns whether it ran. */
export async function notifierAt(stub: DurableObjectStub<TestNotifier>, tenant: string, at: number): Promise<boolean> {
  world.now = at
  const h = ok(await stub.health(tenant))
  if (h.alarmAtMs === null || h.alarmAtMs > at) return false
  expect(await runDurableObjectAlarm(stub)).toBe(true)
  return true
}

/** Step the notifier through every alarm it arms up to `until`, at the times it asked for. */
export async function runNotifierUntil(stub: DurableObjectStub<TestNotifier>, tenant: string, until: number): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    const h = ok(await stub.health(tenant))
    if (h.alarmAtMs === null || h.alarmAtMs > until) break
    world.now = Math.max(world.now, h.alarmAtMs)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
  }
  world.now = Math.max(world.now, until)
}

export const alertsOf = async (stub: DurableObjectStub<TestRuler>, tenant: string, rule?: string) =>
  ok(await stub.rules(tenant)).rules.filter((r) => rule === undefined || r.name === rule).flatMap((r) => r.alerts)

export const sqlWrites = async (stub: DurableObjectStub<TestRuler>, tenant: string) => ok(await stub.health(tenant)).counters.sqlRowsWritten

/**
 * The range queries made for `query` (from `rangeCalls`), and a check that they are windows that
 * partition [from, to] at `step` exactly: in order, contiguous, without a gap or an overlap.
 */
export function expectWindows(calls: [string, number, number, number][], query: string, from: number, to: number, step: number): [number, number][] {
  const ws = calls.filter((c) => c[0] === query).map((c) => [c[1], c[2], c[3]] as const)
  expect(ws.length, `range queries for ${query}`).toBeGreaterThan(0)
  expect(ws.every((w) => w[2] === step)).toBe(true)
  expect(ws[0]![0]).toBe(from)
  expect(ws.at(-1)![1]).toBe(to)
  for (let i = 1; i < ws.length; i++) expect(ws[i]![0], `window ${i} starts one step after window ${i - 1} ends`).toBe(ws[i - 1]![1] + step)
  return ws.map((w) => [w[0], w[1]])
}
