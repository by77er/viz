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
//     "reads_of": { "store.anomaly-state": "ruler/src/schema.ts#ANOMALY_STATE_READS" }   one format's [versions]
//   }
//
// - A Worker reads a format it writes at the version it writes, unless a read list says more
//   (§3.3 applied to the release itself: every release that may still be running reads what it
//   writes). A read list that leaves out the version the Worker writes is refused at configure.
// - Two read lists for one format in one Worker: the Worker reads what both read (intersection).
// - `FORMATS` entries named `read.…` (the publisher's) are versions of formats ANOTHER component
//   writes, as their reader declares them; that writer declares no format of that name, so nothing
//   could ever be judged against them. They are not recorded.
//
// Each class's record lives in three places, as schemas do: the manifest (per Worker), the release
// record (`formats: { <worker>: { <format>: { writes, reads } } }`) and every version's
// `VIZ_FORMATS` var, so a rollback reads what each newer version wrote from Cloudflare itself.
import { evaluateExports, parseSource } from './schemas.mjs'

export const FORMATS_VAR = 'VIZ_FORMATS'
export const FORMATS_VAR_VERSION = 1
const READ_PREFIX = 'read.'
const SOURCE_KEYS = new Set(['$comment', 'writes', 'reads', 'reads_of'])

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
    for (const [format, ref] of Object.entries(f.reads_of ?? {})) out.push({ worker: w.name, kind: 'reads_of', format, ...parseSource(ref, `${where}.reads_of.${format}`) })
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
  const values = evaluateExports(sources).values.map((v, i) => {
    if (v === undefined) throw new Error(`${sources[i].module} does not export ${sources[i].name}`)
    return JSON.parse(JSON.stringify(v))
  })
  const byWorker = new Map()
  const entry = (worker, format) => {
    if (!byWorker.has(worker)) byWorker.set(worker, new Map())
    const m = byWorker.get(worker)
    if (!m.has(format)) m.set(format, { writes: null, writtenBy: null, reads: null })
    return m.get(format)
  }
  const readList = (worker, format, list, where) => {
    if (!isVersionList(list)) throw new Error(`${where}: ${format} must list the versions read (integers from 1), got ${JSON.stringify(list)}`)
    const e = entry(worker, format)
    e.reads = e.reads === null ? sorted(list) : e.reads.filter((x) => list.includes(x))
  }
  sources.forEach((s, i) => {
    const v = values[i]
    const where = `${s.module}#${s.name} (${s.worker})`
    if (s.kind === 'reads_of') return readList(s.worker, s.format, v, where)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${where}: not a { format: ${s.kind === 'writes' ? 'version' : '[versions]'} } map`)
    for (const [format, x] of Object.entries(v)) {
      if (s.kind === 'reads') {
        readList(s.worker, format, x, where)
        continue
      }
      if (format.startsWith(READ_PREFIX)) continue
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

/** The var every version of a Worker carries (`VIZ_FORMATS`): what that version's code writes and reads. */
export function formatsVar(list) {
  const formats = {}
  for (const f of [...list].sort((a, b) => a.format.localeCompare(b.format))) formats[f.format] = { w: f.writes, r: f.reads }
  return JSON.stringify({ v: FORMATS_VAR_VERSION, formats })
}

/**
 * `VIZ_FORMATS` of a version as Cloudflare returns it: `{ <format>: { writes, reads } }`, or null
 * when the version has none, or one this code cannot read (unknown, never guessed).
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
    if (!x || !(x.w === null || isVersion(x.w)) || !isVersionList(x.r)) return null
    out[format] = { writes: x.w, reads: x.r }
  }
  return out
}

/** `{ <format>: { writes, reads } }` of one Worker's list. */
export const formatsMap = (list) => Object.fromEntries(list.map((f) => [f.format, { writes: f.writes, reads: f.reads }]))

/**
 * The versions of `format` a release reads, from its record's `formats` (`{ worker: { format:
 * { writes, reads } } }`): what every Worker of it that declares the format reads. A release that
 * declares nothing about the format (a record from before format versions, or a format added
 * since) is taken to read version 1 only: the code from before a format carried a version reads
 * version 1 of it (contracts/COMPATIBILITY.md §3.1, "absent means 1"; §6, Bootstrapping), and
 * fewer versions read only ever means more refusals.
 */
export function readsOf(formatsByWorker, format) {
  let reads = null
  for (const formats of Object.values(formatsByWorker ?? {})) {
    const f = formats?.[format]
    if (!f) continue
    reads = reads === null ? sorted(f.reads) : reads.filter((x) => f.reads.includes(x))
  }
  return reads ?? [1]
}
