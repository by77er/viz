// FROZEN: publisher/src/avro.ts as committed at 9292abb, the release before the publisher read the span and
// log tables: release N-1 of test/signals.test.ts (COMPATIBILITY.md §6). Not used in production; do not edit.
/**
 * A small Avro object-container-file codec, written for the Workers runtime: no `eval`, no
 * `new Function`, no Node APIs. It is schema-driven (it walks the schema for every datum),
 * which is slower than generated code and fast enough for manifests.
 *
 * Supported: null, boolean, int, long, float, double, bytes, string, record, array, map,
 * union. Logical types are carried in the schema and ignored by the codec (a `date` is an
 * int). Not supported: enum, fixed, named-type references, schema resolution: a file is
 * decoded with the schema in its own header.
 *
 * Codecs: `null` and `deflate` (raw DEFLATE, RFC 1951, through CompressionStream).
 *
 * Values: `long` is a JS number and must be a safe integer. `bytes` is a Uint8Array. A union
 * takes its `null` branch for `null`/`undefined` and otherwise the first non-null branch
 * (every union in the Iceberg metadata schemas is `[null, T]`).
 */

export type AvroSchema =
  | string
  | AvroSchema[]
  | { type: 'record'; name: string; fields: AvroField[]; [k: string]: unknown }
  | { type: 'array'; items: AvroSchema; [k: string]: unknown }
  | { type: 'map'; values: AvroSchema; [k: string]: unknown }
  | { type: string; [k: string]: unknown }

export interface AvroField {
  name: string
  type: AvroSchema
  [k: string]: unknown
}

export type AvroCodec = 'null' | 'deflate'

const MAGIC = new Uint8Array([0x4f, 0x62, 0x6a, 0x01]) // "Obj\x01"
const utf8 = new TextEncoder()
const utf8d = new TextDecoder('utf-8', { fatal: true })

// ───────────────────────────── encoding ─────────────────────────────

class Out {
  private buf = new Uint8Array(4096)
  private n = 0

  private room(extra: number): void {
    if (this.n + extra <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.n + extra) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.n))
    this.buf = next
  }
  byte(b: number): void {
    this.room(1)
    this.buf[this.n++] = b
  }
  raw(b: Uint8Array): void {
    this.room(b.length)
    this.buf.set(b, this.n)
    this.n += b.length
  }
  /** Zig-zag varint. Exact for every safe integer. */
  long(v: number): void {
    if (!Number.isSafeInteger(v)) throw new Error(`avro: ${v} is not a safe integer`)
    if (v >= -0x40000000 && v < 0x40000000) {
      let z = ((v << 1) ^ (v >> 31)) >>> 0
      while (z > 0x7f) {
        this.byte((z & 0x7f) | 0x80)
        z >>>= 7
      }
      this.byte(z)
      return
    }
    let z = v >= 0 ? BigInt(v) * 2n : BigInt(v) * -2n - 1n
    while (z > 0x7fn) {
      this.byte(Number(z & 0x7fn) | 0x80)
      z >>= 7n
    }
    this.byte(Number(z))
  }
  bytes(b: Uint8Array): void {
    this.long(b.length)
    this.raw(b)
  }
  string(s: string): void {
    this.bytes(utf8.encode(s))
  }
  double(v: number): void {
    this.room(8)
    new DataView(this.buf.buffer, this.buf.byteOffset + this.n, 8).setFloat64(0, v, true)
    this.n += 8
  }
  float(v: number): void {
    this.room(4)
    new DataView(this.buf.buffer, this.buf.byteOffset + this.n, 4).setFloat32(0, v, true)
    this.n += 4
  }
  get length(): number {
    return this.n
  }
  take(): Uint8Array {
    const out = this.buf.slice(0, this.n)
    this.n = 0
    return out
  }
}

const typeName = (s: AvroSchema): string => (typeof s === 'string' ? s : Array.isArray(s) ? 'union' : (s.type as string))

function encode(o: Out, s: AvroSchema, v: unknown, path: string): void {
  if (Array.isArray(s)) {
    const isNull = v === null || v === undefined
    const i = s.findIndex((b) => (typeName(b) === 'null') === isNull)
    if (i < 0) throw new Error(`avro: no union branch for ${path}`)
    o.long(i)
    encode(o, s[i] as AvroSchema, v, path)
    return
  }
  switch (typeName(s)) {
    case 'null':
      return
    case 'boolean':
      if (typeof v !== 'boolean') throw new Error(`avro: ${path} must be a boolean`)
      o.byte(v ? 1 : 0)
      return
    case 'int':
    case 'long':
      if (typeof v !== 'number') throw new Error(`avro: ${path} must be a number`)
      o.long(v)
      return
    case 'float':
      o.float(v as number)
      return
    case 'double':
      o.double(v as number)
      return
    case 'bytes':
      if (!(v instanceof Uint8Array)) throw new Error(`avro: ${path} must be a Uint8Array`)
      o.bytes(v)
      return
    case 'string':
      if (typeof v !== 'string') throw new Error(`avro: ${path} must be a string`)
      o.string(v)
      return
    case 'record': {
      const rec = v as Record<string, unknown>
      if (typeof rec !== 'object' || rec === null) throw new Error(`avro: ${path} must be an object`)
      for (const f of (s as { fields: AvroField[] }).fields) encode(o, f.type, rec[f.name], `${path}.${f.name}`)
      return
    }
    case 'array': {
      const items = v as unknown[]
      if (!Array.isArray(items)) throw new Error(`avro: ${path} must be an array`)
      if (items.length > 0) {
        o.long(items.length)
        const it = (s as { items: AvroSchema }).items
        for (let i = 0; i < items.length; i++) encode(o, it, items[i], `${path}[${i}]`)
      }
      o.long(0)
      return
    }
    case 'map': {
      const entries = Object.entries(v as Record<string, unknown>)
      if (entries.length > 0) {
        o.long(entries.length)
        for (const [k, x] of entries) {
          o.string(k)
          encode(o, (s as { values: AvroSchema }).values, x, `${path}.${k}`)
        }
      }
      o.long(0)
      return
    }
    default:
      throw new Error(`avro: unsupported type ${typeName(s)} at ${path}`)
  }
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>))
  return new Uint8Array(await out.arrayBuffer())
}

/** Records per block. A block is the unit of compression and of a reader's memory. */
const BLOCK_RECORDS = 2000

/**
 * Write an Avro object container file. `metadata` is added to the header next to
 * `avro.schema` and `avro.codec`. `records` is iterated once and encoded as it comes, a block
 * of `BLOCK_RECORDS` at a time, so a generator need not hold them all.
 */
export async function writeAvro(
  schema: AvroSchema,
  records: Iterable<unknown>,
  metadata: Record<string, string>,
  codec: AvroCodec = 'deflate',
  /** The 16-byte sync marker; random unless given (a writer that must repeat its bytes passes one). */
  sync: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): Promise<Uint8Array> {
  if (sync.length !== 16) throw new Error('avro: a sync marker is 16 bytes')
  const o = new Out()
  o.raw(MAGIC)
  const meta: [string, string][] = [['avro.schema', JSON.stringify(schema)], ['avro.codec', codec], ...Object.entries(metadata)]
  o.long(meta.length)
  for (const [k, v] of meta) {
    o.string(k)
    o.bytes(utf8.encode(v))
  }
  o.long(0)
  o.raw(sync)
  const parts: Uint8Array[] = [o.take()]
  const block = new Out()
  let count = 0
  const flush = async () => {
    let data = block.take()
    if (codec === 'deflate') data = await pipe(data, new CompressionStream('deflate-raw'))
    o.long(count)
    o.long(data.length)
    parts.push(o.take(), data, sync)
    count = 0
  }
  for (const r of records) {
    encode(block, schema, r, '$')
    if (++count === BLOCK_RECORDS) await flush()
  }
  if (count > 0) await flush()
  const total = parts.reduce((n, p) => n + p.length, 0)
  const file = new Uint8Array(total)
  let n = 0
  for (const p of parts) {
    file.set(p, n)
    n += p.length
  }
  return file
}

// ───────────────────────────── decoding ─────────────────────────────

class In {
  private at = 0
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.at >= this.buf.length
  }
  byte(): number {
    if (this.at >= this.buf.length) throw new Error('avro: unexpected end of data')
    return this.buf[this.at++] as number
  }
  raw(n: number): Uint8Array {
    if (n < 0 || this.at + n > this.buf.length) throw new Error('avro: unexpected end of data')
    const out = this.buf.subarray(this.at, this.at + n)
    this.at += n
    return out
  }
  long(): number {
    let z = 0n
    let shift = 0n
    for (;;) {
      const b = this.byte()
      z |= BigInt(b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7n
      if (shift > 63n) throw new Error('avro: varint too long')
    }
    const v = (z & 1n) === 0n ? z >> 1n : -(z >> 1n) - 1n
    const n = Number(v)
    if (!Number.isSafeInteger(n)) throw new Error('avro: long outside the safe integer range')
    return n
  }
  bytes(): Uint8Array {
    return this.raw(this.long()).slice()
  }
  string(): string {
    return utf8d.decode(this.raw(this.long()))
  }
  double(): number {
    const b = this.raw(8)
    return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true)
  }
  float(): number {
    const b = this.raw(4)
    return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true)
  }
}

function decode(i: In, s: AvroSchema): unknown {
  if (Array.isArray(s)) {
    const branch = s[i.long()]
    if (branch === undefined) throw new Error('avro: union branch out of range')
    return decode(i, branch)
  }
  switch (typeName(s)) {
    case 'null':
      return null
    case 'boolean':
      return i.byte() !== 0
    case 'int':
    case 'long':
      return i.long()
    case 'float':
      return i.float()
    case 'double':
      return i.double()
    case 'bytes':
      return i.bytes()
    case 'string':
      return i.string()
    case 'record': {
      const rec: Record<string, unknown> = {}
      for (const f of (s as { fields: AvroField[] }).fields) rec[f.name] = decode(i, f.type)
      return rec
    }
    case 'array': {
      const out: unknown[] = []
      for (;;) {
        let n = i.long()
        if (n === 0) break
        if (n < 0) {
          n = -n
          i.long() // block size in bytes, unused
        }
        for (let k = 0; k < n; k++) out.push(decode(i, (s as { items: AvroSchema }).items))
      }
      return out
    }
    case 'map': {
      const out: Record<string, unknown> = {}
      for (;;) {
        let n = i.long()
        if (n === 0) break
        if (n < 0) {
          n = -n
          i.long()
        }
        for (let k = 0; k < n; k++) {
          const key = i.string()
          out[key] = decode(i, (s as { values: AvroSchema }).values)
        }
      }
      return out
    }
    default:
      throw new Error(`avro: unsupported type ${typeName(s)}`)
  }
}

export interface AvroFile<T> {
  schema: AvroSchema
  metadata: Record<string, string>
  records: T[]
}

/** Read an Avro object container file written with the `null` or `deflate` codec. */
/** Read an Avro object container file. With `onRecord`, each record goes to it as its block is decoded and none are kept (`records` is empty). */
export async function readAvro<T = Record<string, unknown>>(file: Uint8Array, onRecord?: (record: T) => void): Promise<AvroFile<T>> {
  const i = new In(file)
  const magic = i.raw(4)
  if (magic.some((b, k) => b !== MAGIC[k])) throw new Error('avro: not an object container file')
  const metadata: Record<string, string> = {}
  for (;;) {
    let n = i.long()
    if (n === 0) break
    if (n < 0) {
      n = -n
      i.long()
    }
    for (let k = 0; k < n; k++) {
      const key = i.string()
      metadata[key] = utf8d.decode(i.bytes())
    }
  }
  const schemaText = metadata['avro.schema']
  if (!schemaText) throw new Error('avro: header has no schema')
  const schema = JSON.parse(schemaText) as AvroSchema
  const codec = metadata['avro.codec'] ?? 'null'
  if (codec !== 'null' && codec !== 'deflate') throw new Error(`avro: unsupported codec ${codec}`)
  const sync = i.raw(16).slice()
  const records: T[] = []
  while (!i.done) {
    const count = i.long()
    let data = i.raw(i.long())
    if (codec === 'deflate') data = await pipe(data.slice(), new DecompressionStream('deflate-raw'))
    const marker = i.raw(16)
    if (marker.some((b, k) => b !== sync[k])) throw new Error('avro: bad sync marker')
    const block = new In(data)
    for (let k = 0; k < count; k++) {
      const r = decode(block, schema) as T
      if (onRecord) onRecord(r)
      else records.push(r)
    }
    if (!block.done) throw new Error('avro: block has trailing bytes')
  }
  return { schema, metadata, records }
}
