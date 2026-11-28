import { env } from 'cloudflare:workers'
import type { FlushEnv } from '../src/flush'

/**
 * An `env` whose R2 bucket and Durable Object stubs time every call, optionally delayed first
 * by a latency model: the profile (profile.prof.ts) and the throughput tests (throughput.test.ts).
 */
export interface Latency {
  put: number
  get: number
  head: number
  ledger: number
  addUnit: number
  shard: number
}
export const NONE: Latency = { put: 0, get: 0, head: 0, ledger: 0, addUnit: 0, shard: 0 }
export const S10: Latency = { put: 335, get: 207, head: 100, ledger: 32, addUnit: 47, shard: 32 }

export interface Op {
  op: string
  start: number
  ms: number
  inFlightR2: number
  /** R2: the key; a stub call: nothing. */
  arg?: string
}
/** A call's first argument as the ops log shows it: a key, or a unit's `seqLo`. */
const argOf = (a: unknown): string => (typeof a === 'object' && a !== null && 'seqLo' in a ? `seqLo=${(a as { seqLo: number }).seqLo}` : String(a))
export const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

/** `env` with every R2 and Durable Object call timed (and delayed by `lat`). */
export function instrumented(lat: Latency, ops: Op[], t0: number, extra: (op: string, args: unknown[]) => number = () => 0): FlushEnv & { peakR2: () => number } {
  let r2 = 0
  let peak = 0
  const timed = async <T>(op: string, delay: number, f: () => Promise<T>, isR2 = false, args: unknown[] = []): Promise<T> => {
    const start = performance.now()
    if (isR2) peak = Math.max(peak, ++r2)
    try {
      await sleep(delay + extra(op, args))
      return await f()
    } finally {
      if (isR2) r2--
      ops.push({ op, start: start - t0, ms: performance.now() - start, inFlightR2: r2, ...(args.length > 0 ? { arg: argOf(args[0]) } : {}) })
    }
  }
  const b = env.BUCKET
  const bucket = {
    put: (k: string, v: never, o?: never) => timed('r2.put', lat.put, () => b.put(k, v, o), true, [k]),
    head: (k: string) => timed('r2.head', lat.head, () => b.head(k), true),
    get: (k: string, o?: never) => timed('r2.get', lat.get, () => b.get(k, o), true),
    list: (o?: never) => timed('r2.list', lat.get, () => b.list(o), true),
  } as unknown as R2Bucket
  const wrapNs = <T extends Rpc.DurableObjectBranded | undefined>(ns: DurableObjectNamespace<T>, name: string, delay: (m: string) => number): DurableObjectNamespace<T> =>
    ({
      idFromName: (n: string) => ns.idFromName(n),
      get: (id: DurableObjectId) => {
        const stub = ns.get(id) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
        return new Proxy(stub, { get: (s, p: string) => (...a: unknown[]) => timed(`${name}.${p}`, delay(p), () => s[p]!(...a), false, a) })
      },
    }) as unknown as DurableObjectNamespace<T>
  return {
    SHARD: wrapNs(env.SHARD, 'shard', () => lat.shard),
    LEDGER: wrapNs(env.LEDGER, 'ledger', (m) => (m === 'addUnit' ? lat.addUnit : lat.ledger)),
    BUCKET: bucket,
    CELL: env.CELL,
    peakR2: () => peak,
  }
}

