import { describe, expect, it } from 'vitest'
import { readAvro, writeAvro, type AvroSchema } from '../src/avro'

const schema = {
  type: 'record',
  name: 'r',
  fields: [
    { name: 'i', type: 'int' },
    { name: 'l', type: 'long' },
    { name: 's', type: 'string' },
    { name: 'b', type: ['null', 'bytes'], default: null },
    { name: 'd', type: 'double' },
    { name: 'flag', type: 'boolean' },
    { name: 'list', type: ['null', { type: 'array', items: 'long' }], default: null },
    { name: 'nested', type: { type: 'record', name: 'n', fields: [{ name: 'x', type: ['null', 'string'], default: null }] } },
    { name: 'pairs', type: { type: 'array', items: { type: 'record', name: 'kv', fields: [{ name: 'key', type: 'int' }, { name: 'value', type: 'bytes' }] } } },
  ],
} as unknown as AvroSchema

const record = (i: number) => ({
  i: i % 2 === 0 ? i : -i,
  l: [0, 1, -1, 63, 64, -64, -65, 2 ** 31, -(2 ** 31) - 1, 2 ** 40 + i, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1_794_268_800_000][i % 13] as number,
  s: `name-${i}-é-日本`,
  b: i % 3 === 0 ? null : new Uint8Array([i & 255, 0, 255]),
  d: i * 1.5,
  flag: i % 2 === 0,
  list: i % 4 === 0 ? null : [i, i + 1, -i],
  nested: { x: i % 5 === 0 ? null : `x${i}` },
  pairs: [{ key: i, value: new Uint8Array([1, 2, 3]) }],
})

describe('avro object container files', () => {
  for (const codec of ['null', 'deflate'] as const) {
    it(`round-trips records across block boundaries with the ${codec} codec`, async () => {
      const records = Array.from({ length: 4501 }, (_, i) => record(i))
      const file = await writeAvro(schema, records, { 'format-version': '2', note: 'héllo' }, codec)
      const back = await readAvro(file)
      expect(back.metadata['avro.codec']).toBe(codec)
      expect(back.metadata['format-version']).toBe('2')
      expect(back.metadata.note).toBe('héllo')
      expect(back.schema).toEqual(schema)
      expect(back.records.length).toBe(records.length)
      expect(back.records).toEqual(records)
    })
  }

  it('writes an empty file that reads back empty', async () => {
    const back = await readAvro(await writeAvro(schema, [], {}, 'deflate'))
    expect(back.records).toEqual([])
  })

  it('compresses with deflate', async () => {
    const records = Array.from({ length: 2000 }, (_, i) => record(i))
    const plain = await writeAvro(schema, records, {}, 'null')
    const packed = await writeAvro(schema, records, {}, 'deflate')
    expect(packed.length).toBeLessThan(plain.length / 2)
  })

  it('refuses a long that is not a safe integer and a missing required field', async () => {
    await expect(writeAvro(schema, [{ ...record(1), l: 2 ** 60 }], {})).rejects.toThrow(/safe integer/)
    await expect(writeAvro(schema, [{ ...record(1), s: undefined }], {})).rejects.toThrow(/must be a string/)
  })

  it('refuses a corrupted file', async () => {
    const file = await writeAvro(schema, [record(1), record(2)], {}, 'null')
    file[file.length - 1] = (file[file.length - 1] as number) ^ 0xff // last byte of the sync marker
    await expect(readAvro(file)).rejects.toThrow(/sync marker/)
    await expect(readAvro(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(/not an object container/)
  })
})
