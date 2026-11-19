// Format versions (contracts/COMPATIBILITY.md §3.1, §6; design/DECISIONS.md D69): for each Worker,
// the version of each format its code WRITES and the versions it READS, for release records, the
// forward-only marking and the rollback check, as lib/schemas.mjs does for storage schemas (D46).
//
// Read from the component sources deploy/workers.json names, without running any Worker (the
// esbuild + vm reader of lib/schemas.mjs):
//
//   "formats": {
//     "writes":   ["ruler/src/schema.ts#FORMATS"],             { format: version } maps (COMPATIBILITY §3.1)
//     "reads":    ["janitor/src/formats.ts#READS"],            { format: [versions] } maps
//     "reads_of": { "store.anomaly-state": "ruler/src/schema.ts#ANOMALY_STATE_READS" }   one format's [versions], or one version
//     "reads_v1": { "kv.pool": "edge/src/route.ts: the pool map of every write" }        read with no version list in the code
//   }
//
// - Every deployed Worker has a `formats` block, also one that reads and writes nothing (`{}` with a
//   `$comment`): the block says COMPLETELY what the Worker reads (review of D69, M-1 (c)). A format
//   it does not list, it does not read. configure.mjs refuses a deployed Worker without one.
// - A Worker reads a format it writes at the version it writes, unless a read list says more
//   (§3.3 applied to the release itself: every release that may still be running reads what it
//   writes). A read list that leaves out the version the Worker writes is refused at configure.
// - Two read lists for one format in one Worker: the Worker reads what both read (intersection).
// - `reads_v1`: a format the Worker's code reads without a version list or constant of its own
//   (control's KV records, which edge, shard routing and query read "without checking a version
//   yet", control/src/schema.ts): taken to read version 1 only (§3.1, "absent means 1"). Each entry
//   says where; deploy/README.md, "Contract issues", lists them.
// - `FORMATS` entries named `read.…` (the publisher's) are versions of formats ANOTHER component
//   writes, as their reader declares them; that writer declares no format of that name, so nothing
//   could ever be judged against them. They are not recorded.
//
// Each class's record lives in three places, as schemas do: the manifest (per Worker), the release
// record (`formats: { <worker>: { <format>: { writes, reads } } }`, with `formatsComplete: true`) and
// every version's `VIZ_FORMATS` var (`complete: true`), so a rollback reads what each newer version
// wrote from Cloudflare itself. Readers are judged per Worker (`readsOf`):
// - a Worker that declares nothing (a version without `VIZ_FORMATS`, a record without its entry) is
//   taken to read version 1 of EVERY format: the code from before format versions reads version 1;
// - a declaration from before it was complete (a `VIZ_FORMATS` without `complete`, a record without
//   `formatsComplete`: D69's, which left out edge's and query's reads of control's records) is taken
//   to read version 1 of every format it does not list (`ANY`);
// - a complete declaration reads exactly what it lists.
import { evaluateExports, parseSource } from './schemas.mjs'

export const FORMATS_VAR = 'VIZ_FORMATS'
export const FORMATS_VAR_VERSION = 1
const READ_PREFIX = 'read.'
const SOURCE_KEYS = new Set(['$comment', 'writes', 'reads', 'reads_of', 'reads_v1'])
/** The entry of an incomplete declaration that stands for every format it does not list: version 1. */
export const ANY = '*'
const V1 = Object.freeze({ writes: null, reads: Object.freeze([1]) })
const FORMAT_NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/

const isVersion = (n) => Number.isInteger(n) && n >= 1
const isVersionList = (a) => Array.isArray(a) && a.length > 0 && a.every(isVersion)
const sorted = (a) => [...new Set(a)].sort((x, y) => x - y)

/** Every `{ worker, kind, module, name, format? }` the plan declares under `formats`. */
export function formatSources(workers) {
  const out = []
  for (const w of workers) {
    const f = w.formats
    if (f === undefined) continue
    const where = `deploy/workers.json ${w.name} formats`
    if (typeof f !== 'object' || f === null || Array.isArray(f)) throw new Error(`${where}: must be { "writes": [...], "reads": [...], "reads_of": {...} }`)
    for (const k of Object.keys(f)) if (!SOURCE_KEYS.has(k)) throw new Error(`${where}: "${k}" is not one of writes, reads, reads_of`)
    for (const k of ['writes', 'reads']) {
      if (f[k] !== undefined && !Array.isArray(f[k])) throw new Error(`${where}.${k}: a list of "<path>.ts#<EXPORT>"`)
      for (const ref of f[k] ?? []) out.push({ worker: w.name, kind: k, ...parseSource(ref, `${where}.${k}`) })
    }
    if (f.reads_of !== undefined && (typeof f.reads_of !== 'object' || f.reads_of === null || Array.isArray(f.reads_of))) throw new Error(`${where}.reads_of: { "<format>": "<path>.ts#<EXPORT>" }`)
    for (const [format, ref] of Object.entries(f.reads_of ?? {})) {
      if (!FORMAT_NAME.test(format)) throw new Error(`${where}.reads_of: ${JSON.stringify(format)} is not a format name`)
      out.push({ worker: w.name, kind: 'reads_of', format, ...parseSource(ref, `${where}.reads_of.${format}`) })
    }
    if (f.reads_v1 !== undefined && (typeof f.reads_v1 !== 'object' || f.reads_v1 === null || Array.isArray(f.reads_v1))) throw new Error(`${where}.reads_v1: { "<format>": "where the code reads it" }`)
    for (const [format, why] of Object.entries(f.reads_v1 ?? {})) {
      if (format === '$comment') continue
      if (!FORMAT_NAME.test(format)) throw new Error(`${where}.reads_v1: ${JSON.stringify(format)} is not a format name`)
      if (typeof why !== 'string' || why === '') throw new Error(`${where}.reads_v1.${format}: say where the code reads it`)
      out.push({ worker: w.name, kind: 'reads_v1', format, why })
    }
  }
  return out
}

/**
 * The formats each Worker writes and reads, from the sources: `[{ worker, format, writes, reads }]`
 * (writes null for a format the Worker only reads), sorted by Worker then format. Refuses what it
 * cannot read as a version, a format two components of one Worker write at different versions, and
 * a Worker that writes a version it does not read.
 */
export function readFormats(sources) {
  if (sources.length === 0) return []
  // JSON round trip: the values come from another realm (the vm), and are plain data anyway.
  const fromCode = sources.filter((s) => s.kind !== 'reads_v1')
  const evaluated = evaluateExports(fromCode).values
  const values = sources.map((s) => {
    if (s.kind === 'reads_v1') return [1]
    const i = fromCode.indexOf(s)
    if (evaluated[i] === undefined) throw new Error(`${s.module} does not export ${s.name}`)
    return JSON.parse(JSON.stringify(evaluated[i]))
  })
  const byWorker = new Map()
  const entry = (worker, format) => {
    if (!byWorker.has(worker)) byWorker.set(worker, new Map())
    const m = byWorker.get(worker)
    if (!m.has(format)) m.set(format, { writes: null, writtenBy: null, reads: null })
    return m.get(format)
  }
  const readList = (worker, format, value, where) => {
    // One version (a reader's constant: edge's KEY_RECORD_VERSION, contracts' CONTROL_SERVICE_VERSION) reads that version only.
    const list = isVersion(value) ? [value] : value
    if (!isVersionList(list)) throw new Error(`${where}: ${format} must list the versions read (integers from 1), got ${JSON.stringify(value)}`)
    const e = entry(worker, format)
    e.reads = e.reads === null ? sorted(list) : e.reads.filter((x) => list.includes(x))
  }
  sources.forEach((s, i) => {
    const v = values[i]
    const where = s.kind === 'reads_v1' ? `deploy/workers.json ${s.worker} formats.reads_v1` : `${s.module}#${s.name} (${s.worker})`
    if (s.kind === 'reads_of' || s.kind === 'reads_v1') return readList(s.worker, s.format, v, where)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${where}: not a { format: ${s.kind === 'writes' ? 'version' : '[versions]'} } map`)
    for (const [format, x] of Object.entries(v)) {
      if (s.kind === 'reads') {
        readList(s.worker, format, x, where)
        continue
      }
      if (format.startsWith(READ_PREFIX)) continue
      if (!FORMAT_NAME.test(format)) throw new Error(`${where}: ${JSON.stringify(format)} is not a format name`)
      if (!isVersion(x)) throw new Error(`${where}: ${format} must be a version (an integer from 1), got ${JSON.stringify(x)}`)
      const e = entry(s.worker, format)
      if (e.writes !== null && e.writes !== x) throw new Error(`${s.worker}: ${format} is written at version ${e.writes} (${e.writtenBy}) and at ${x} (${where}); one Worker writes one version of a format`)
      e.writes = x
      e.writtenBy = where
    }
  })
  const out = []
  for (const [worker, m] of byWorker) {
    for (const [format, e] of [...m].sort(([a], [b]) => a.localeCompare(b))) {
      const reads = e.reads ?? (e.writes !== null ? [e.writes] : null)
      if (!reads || reads.length === 0) throw new Error(`${worker}: the read lists of ${format} have no version in common`)
      if (e.writes !== null && !reads.includes(e.writes)) {
        throw new Error(`${worker}: writes ${format} version ${e.writes} but reads only ${reads.join(', ')}: a release must read what it writes (contracts/COMPATIBILITY.md §3.3)`)
      }
      out.push({ worker, format, writes: e.writes, reads })
    }
  }
  return out
}

/**
 * The var every version of a Worker carries (`VIZ_FORMATS`): what that version's code writes and
 * reads, completely (`complete: true`: a format it does not list, it does not read). A Worker that
 * declares none carries `{"v":1,"complete":true,"formats":{}}`.
 */
export function formatsVar(list) {
  const formats = {}
  for (const f of [...list].sort((a, b) => a.format.localeCompare(b.format))) formats[f.format] = { w: f.writes, r: f.reads }
  return JSON.stringify({ v: FORMATS_VAR_VERSION, complete: true, formats })
}

/**
 * `VIZ_FORMATS` of a version as Cloudflare returns it: `{ <format>: { writes, reads } }`, or null
 * when the version has none, or one this code cannot read (unknown, never guessed). A var without
 * `complete` (D69's) gets `ANY`: version 1 of every format it does not list.
 */
export function formatsOfVersion(version) {
  const bindings = version?.resources?.bindings ?? version?.bindings ?? []
  const b = bindings.find((x) => x?.name === FORMATS_VAR && (x.type === 'plain_text' || x.type === 'json'))
  if (!b) return null
  let v
  try {
    v = typeof b.text === 'string' ? JSON.parse(b.text) : b.json
  } catch {
    return null
  }
  if (!v || v.v !== FORMATS_VAR_VERSION || typeof v.formats !== 'object' || v.formats === null) return null
  const out = {}
  for (const [format, x] of Object.entries(v.formats)) {
    if (format === ANY || !x || !(x.w === null || isVersion(x.w)) || !isVersionList(x.r)) return null
    out[format] = { writes: x.w, reads: x.r }
  }
  if (v.complete !== true) out[ANY] = V1
  return out
}

/** `{ <format>: { writes, reads } }` of one Worker's list. */
export const formatsMap = (list) => Object.fromEntries(list.map((f) => [f.format, { writes: f.writes, reads: f.reads }]))

/**
 * The versions of `format` a release reads, from what each of its Workers declares (`{ worker:
 * { format: { writes, reads } } | null }`: a record's `formats` for the Workers it restores, or the
 * serving versions' `VIZ_FORMATS`): what every Worker that reads the format reads. Per Worker:
 * - null (declares nothing: a version without `VIZ_FORMATS`, a record entry missing) reads version 1
 *   only, of every format: code from before format versions reads version 1 (COMPATIBILITY §3.1
 *   "absent means 1"; §6 Bootstrapping); fewer versions read only ever means more refusals;
 * - a declaration lists the format: what it lists; it does not, but is incomplete (`ANY`): version 1;
 *   it does not and is complete: the Worker does not read the format.
 * `formatsByWorker` itself null (a whole record from before format versions): version 1.
 * Returns null when no Worker reads the format (whatever version was written, nothing here reads it).
 */
export function readsOf(formatsByWorker, format) {
  return readersOf(formatsByWorker, format).reads
}

/** readsOf, and which Workers it took to read version 1 for declaring nothing (`undeclared`) or not listing the format in an incomplete declaration (`implicit`). */
export function readersOf(formatsByWorker, format) {
  if (formatsByWorker === null || formatsByWorker === undefined) return { reads: [1], undeclared: [], implicit: [], whole: true }
  let reads = null
  const undeclared = []
  const implicit = []
  for (const [worker, formats] of Object.entries(formatsByWorker)) {
    let f
    if (formats === null || formats === undefined) {
      f = V1
      undeclared.push(worker)
    } else if (formats[format]) f = formats[format]
    else if (formats[ANY]) {
      f = formats[ANY]
      implicit.push(worker)
    } else continue
    reads = reads === null ? sorted(f.reads) : reads.filter((x) => f.reads.includes(x))
  }
  return { reads, undeclared, implicit, whole: false }
}

/** A record's `formats`, as readers: complete as written when it says so (`formatsComplete`), else each entry also reads version 1 of every format it does not list. */
export function recordReaders(record, workers) {
  const complete = record?.formatsComplete === true
  return Object.fromEntries(workers.map((name) => {
    const f = record?.formats?.[name]
    return [name, f === undefined || f === null ? null : complete || f[ANY] ? f : { ...f, [ANY]: V1 }]
  }))
}
