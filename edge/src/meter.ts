import { tooLarge } from './errors'

/**
 * Decode limits, counted while decoding and before anything is materialised
 * (contracts/BATCH.md, "Decode limits"; edge/README.md, "Memory per request").
 *
 * A decoder must never build more than a fixed amount of JavaScript objects for one item,
 * whatever the body's shape: a protobuf `KeyValue` or array element can be two bytes on the
 * wire and fifty in the heap. So every key-value entry and every array element, at any depth,
 * is counted against the item it belongs to before it is built, and an item over the limit
 * is refused: the decoder stops building it, still reads the rest of it to check that the
 * body is well-formed (so a malformed body is still 400), and the collector refuses it with
 * its own reason. The rest of the request is decoded as before.
 */
export const DECODE = {
  /** Key-value entries and array elements, at any depth, in one item. */
  maxValues: 65_536,
} as const

/**
 * What one item has built so far: a span with its events and links, a resource and scope, a
 * log record, a data point, a resource. Decoders `take()` one value before building it.
 */
export class Meter {
  used = 0
  cap: number = DECODE.maxValues

  /** Start an item, with `used` values already counted against it (its resource's, for a scope). */
  reset(used = 0, cap: number = DECODE.maxValues): this {
    this.used = used
    this.cap = cap
    return this
  }

  /** Count one value; false once the item is over its limit (and from then on). */
  take(): boolean {
    return ++this.used <= this.cap
  }

  get over(): boolean {
    return this.used > this.cap
  }
}

/** Always over: decoders given it check the wire of what they read and build nothing. */
export const SKIM: Meter = new Meter().reset(0, -1)

/** Never over: for decoding single values outside a request (tests and tools). */
export const FREE: Meter = new Meter().reset(0, Number.POSITIVE_INFINITY)

/**
 * Refuse (413) a JSON body with more than `max` structural characters (`{`, `[`, `,`, `:`
 * outside strings) before it is parsed. `JSON.parse` builds every value of a body at once,
 * so this is the only point at which a JSON body's object count can be bounded; realistic
 * OTLP and Loki JSON has one structural character per 10 to 35 bytes, hostile JSON one per
 * 1.5 (edge/README.md, "Memory per request").
 */
export function checkJsonTokens(body: Uint8Array, max: number): void {
  let n = 0
  const len = body.length
  for (let i = 0; i < len; i++) {
    const c = body[i]!
    if (c === 0x22) {
      // Skip the string: to its closing quote, past escaped characters.
      for (i++; i < len; i++) {
        const d = body[i]!
        if (d === 0x5c) i++
        else if (d === 0x22) break
      }
    } else if (c === 0x7b || c === 0x5b || c === 0x2c || c === 0x3a) {
      if (++n > max) throw tooLarge(`JSON body with more than ${max} values; send smaller requests`)
    }
  }
}
