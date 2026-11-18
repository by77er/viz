/**
 * Active-series metering for one stream: how many distinct `series_id`s were seen in a
 * sliding window, and which ids of a batch are new to it.
 *
 * The window is two rotating buckets of `windowMs / 2` each, so "active" means seen in
 * the last `windowMs / 2` to `windowMs` milliseconds. Each bucket is
 *
 *   exact    a set of ids, while it holds at most `exactMax` of them; or
 *   sketch   a HyperLogLog (4,096 one-byte registers, 4 KB, standard error
 *            1.04 / sqrt(4096) = 1.6%) for the COUNT, plus a Bloom filter for MEMBERSHIP.
 *
 * Why a Bloom filter next to the HyperLogLog: a limit that refuses only NEW series has to
 * answer "have I seen this id?", and a HyperLogLog cannot. The only thing it can say is
 * "this id would raise a register", which at n ids in m registers is true for about m/n
 * of the new ids (0.4% at one million): 99.6% of new series would pass as "existing" once
 * the limit is reached. The Bloom filter answers it with a false-positive rate near 1%
 * at 10 bits per id, and an id it wrongly calls existing sets no new bit, so the filter
 * does not fill up while a tenant is at its limit.
 *
 * No clock and no storage in this file: the caller passes `now` and persists `save()`.
 */

export const HLL_REGISTERS = 4096
const HLL_BITS = 12
const BLOOM_HASHES = 7
const MIN_BLOOM_BITS = 1 << 17 // 16 KB
const MAX_BLOOM_BITS = 1 << 23 // 1 MB: a Durable Object SQLite value may be 2 MB

function fmix32(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * Two well-mixed 32-bit hashes of a 64-bit id given as its low and high halves. Series ids
 * are themselves hashes, but nothing here relies on that: every input bit reaches both
 * outputs through two rounds of the murmur3 finaliser.
 */
export function hashId(lo: number, hi: number): [number, number] {
  const a = fmix32(lo ^ fmix32(hi ^ 0x9e3779b9))
  const b = fmix32(hi ^ fmix32(lo ^ 0x7f4a7c15) ^ a)
  return [a, b]
}

/** HyperLogLog estimate from registers (Flajolet et al. 2007, with linear counting for small counts). */
export function hllEstimate(reg: Uint8Array): number {
  const m = reg.length
  let sum = 0
  let zeros = 0
  for (let i = 0; i < m; i++) {
    const r = reg[i]!
    sum += 2 ** -r
    if (r === 0) zeros++
  }
  const alpha = 0.7213 / (1 + 1.079 / m)
  const raw = (alpha * m * m) / sum
  if (raw <= 2.5 * m && zeros > 0) return Math.round(m * Math.log(m / zeros))
  return Math.round(raw)
}

function hllAdd(reg: Uint8Array, h1: number, h2: number): boolean {
  const j = h1 >>> (32 - HLL_BITS)
  const rank = Math.clz32(h2) + 1
  if (rank > reg[j]!) {
    reg[j] = rank
    return true
  }
  return false
}

function bloomHas(bits: Uint8Array, h1: number, h2: number): boolean {
  const mask = bits.length * 8 - 1
  const step = h2 | 1
  let p = h1
  for (let i = 0; i < BLOOM_HASHES; i++) {
    const b = p & mask
    if ((bits[b >>> 3]! & (1 << (b & 7))) === 0) return false
    p = (p + step) | 0
  }
  return true
}

function bloomAdd(bits: Uint8Array, h1: number, h2: number): void {
  const mask = bits.length * 8 - 1
  const step = h2 | 1
  let p = h1
  for (let i = 0; i < BLOOM_HASHES; i++) {
    const b = p & mask
    bits[b >>> 3]! |= 1 << (b & 7)
    p = (p + step) | 0
  }
}

/** Bloom size for `expected` ids at about 10 bits each: a power of two between 16 KB and 1 MB. */
export function bloomBitsFor(expected: number): number {
  let bits = MIN_BLOOM_BITS
  while (bits < MAX_BLOOM_BITS && bits < expected * 10) bits *= 2
  return bits
}

const halves = (id: bigint): [number, number] => [Number(BigInt.asUintN(32, id)), Number(BigInt.asUintN(32, id >> 32n))]

class Bucket {
  exact: Set<bigint> | null = new Set()
  hll: Uint8Array | null = null
  bloom: Uint8Array | null = null

  has(id: bigint, h1: number, h2: number): boolean {
    return this.exact ? this.exact.has(id) : bloomHas(this.bloom!, h1, h2)
  }

  add(id: bigint, h1: number, h2: number): void {
    if (this.exact) this.exact.add(id)
    else {
      hllAdd(this.hll!, h1, h2)
      bloomAdd(this.bloom!, h1, h2)
    }
  }

  /** Switch from the exact set to the sketch, carrying every id over. */
  promote(bloomBits: number): void {
    const ids = this.exact!
    this.exact = null
    this.hll = new Uint8Array(HLL_REGISTERS)
    this.bloom = new Uint8Array(bloomBits / 8)
    for (const id of ids) {
      const [lo, hi] = halves(id)
      const [h1, h2] = hashId(lo, hi)
      this.add(id, h1, h2)
    }
  }

  /** Fold this bucket into HyperLogLog registers. */
  into(reg: Uint8Array): void {
    if (this.hll) {
      for (let i = 0; i < reg.length; i++) if (this.hll[i]! > reg[i]!) reg[i] = this.hll[i]!
    } else {
      for (const id of this.exact!) {
        const [lo, hi] = halves(id)
        const [h1, h2] = hashId(lo, hi)
        hllAdd(reg, h1, h2)
      }
    }
  }

  /** `u8 kind`, then for exact the ids (i64 LE), for a sketch the registers and the Bloom bits. */
  save(): Uint8Array {
    if (this.exact) {
      const out = new Uint8Array(8 + 8 * this.exact.size)
      const view = new DataView(out.buffer)
      let p = 8
      for (const id of this.exact) {
        view.setBigInt64(p, id, true)
        p += 8
      }
      return out
    }
    const out = new Uint8Array(8 + HLL_REGISTERS + this.bloom!.length)
    out[0] = 1
    out.set(this.hll!, 8)
    out.set(this.bloom!, 8 + HLL_REGISTERS)
    return out
  }

  static load(bytes: Uint8Array): Bucket {
    const b = new Bucket()
    if (bytes[0] === 1) {
      b.exact = null
      b.hll = bytes.slice(8, 8 + HLL_REGISTERS)
      b.bloom = bytes.slice(8 + HLL_REGISTERS)
    } else {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let p = 8; p + 8 <= bytes.byteLength; p += 8) b.exact!.add(view.getBigInt64(p, true))
    }
    return b
  }
}

export interface SeriesCheck {
  /** Distinct series active in the window before this batch (exact, or the sketch's estimate). */
  current: number
  /** Ids of the batch that are not active in the window, in batch order. */
  fresh: bigint[]
}

export class SeriesWindow {
  private cur = new Bucket()
  private prev = new Bucket()
  /** Index of the current bucket: `floor(now / bucketMs)`. */
  private index: number
  /** `|cur ∪ prev|` while both buckets are exact. */
  private union = 0
  /** Cached estimate while a bucket is a sketch; null when it must be recomputed. */
  private estimate: number | null = null
  private readonly bucketMs: number

  constructor(windowMs: number, private readonly exactMax: number, now: number) {
    this.bucketMs = Math.max(1, Math.floor(windowMs / 2))
    this.index = Math.floor(now / this.bucketMs)
  }

  /** Move the window to `now`: a bucket older than the previous one is dropped. */
  rotate(now: number): boolean {
    const index = Math.floor(now / this.bucketMs)
    if (index <= this.index) return false
    this.prev = index === this.index + 1 ? this.cur : new Bucket()
    this.cur = new Bucket()
    this.index = index
    this.union = this.prev.exact ? this.prev.exact.size : 0
    this.estimate = null
    return true
  }

  get exact(): boolean {
    return this.cur.exact !== null && this.prev.exact !== null
  }

  count(): number {
    if (this.exact) return this.union
    if (this.estimate === null) {
      const reg = new Uint8Array(HLL_REGISTERS)
      this.cur.into(reg)
      this.prev.into(reg)
      this.estimate = hllEstimate(reg)
    }
    return this.estimate
  }

  /** Which ids are new to the window. Changes nothing. */
  check(ids: BigInt64Array): SeriesCheck {
    const fresh: bigint[] = []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!
      const [lo, hi] = halves(id)
      const [h1, h2] = hashId(lo, hi)
      if (!this.cur.has(id, h1, h2) && !this.prev.has(id, h1, h2)) fresh.push(id)
    }
    return { current: this.count(), fresh }
  }

  /** Record every id of an accepted batch in the current bucket. `expected` sizes a new Bloom filter. */
  add(ids: BigInt64Array, expected: number): void {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!
      const [lo, hi] = halves(id)
      const [h1, h2] = hashId(lo, hi)
      if (this.cur.has(id, h1, h2)) continue
      const inPrev = this.prev.has(id, h1, h2)
      this.cur.add(id, h1, h2)
      if (!inPrev) {
        this.union++
        this.estimate = null
      }
      if (this.cur.exact && this.cur.exact.size > this.exactMax) {
        this.cur.promote(bloomBitsFor(Math.max(expected, 16 * this.exactMax)))
        this.estimate = null
      }
    }
  }

  /** The two buckets as `[bucket index, bytes]`, for the shard to store. */
  save(): [number, Uint8Array][] {
    return [
      [this.index - 1, this.prev.save()],
      [this.index, this.cur.save()],
    ]
  }

  /** Rebuild from stored buckets. Buckets that have left the window at `now` are ignored. */
  static load(windowMs: number, exactMax: number, now: number, stored: [number, Uint8Array][]): SeriesWindow {
    const w = new SeriesWindow(windowMs, exactMax, now)
    for (const [index, bytes] of stored) {
      if (index === w.index) w.cur = Bucket.load(bytes)
      else if (index === w.index - 1) w.prev = Bucket.load(bytes)
    }
    if (w.exact) {
      w.union = w.prev.exact!.size
      for (const id of w.cur.exact!) if (!w.prev.exact!.has(id)) w.union++
    }
    return w
  }
}
