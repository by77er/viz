// What each Durable Object class's storage schema is in this checkout (contracts/schema.ts
// `SchemaSpec`), for release records and the rollback check (contracts/COMPATIBILITY.md §6).
//
// The specs are TypeScript in the components. They are read without running any Worker:
// esbuild (wrangler's own dependency) bundles a small entry that re-exports exactly the specs
// deploy/workers.json names (`"schemas": {"Ledger": "ledger/src/ledger.ts#LEDGER_SCHEMA"}`),
// tree-shaken, with platform modules (`cloudflare:*`, `.wasm`, `node:*`) left external; the
// bundle is evaluated in a Node `vm` context whose `require` answers those with empty stubs.
// A spec module that does anything at load time beyond defining values fails here, loudly.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import vm from 'node:vm'
import { DEPLOY_DIR, REPO_ROOT } from './common.mjs'

const require = createRequire(join(DEPLOY_DIR, 'package.json'))

/** `"ledger/src/ledger.ts#LEDGER_SCHEMA"` → `{ module, name }`. */
export function parseSource(ref, where) {
  const m = /^([A-Za-z0-9_./-]+\.ts)#([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref ?? '')
  if (!m || m[1].includes('..')) throw new Error(`${where}: a source is "<path from the repository root>.ts#<EXPORT>", got ${JSON.stringify(ref)}`)
  return { module: m[1], name: m[2] }
}

/** Every `{ worker, class, module, name }` the plan declares, for the Workers in `workers`. */
export function schemaSources(workers) {
  const out = []
  for (const w of workers) for (const [cls, ref] of Object.entries(w.schemas ?? {})) out.push({ worker: w.name, class: cls, ...parseSource(ref, `deploy/workers.json ${w.name} schemas.${cls}`) })
  return out
}

/**
 * The values of exported constants, read from the sources without running any Worker (the
 * mechanism above): `refs` is `[{ module, name }]`, the result `[value]` in the same order, and
 * `extra` names more `{ module, name }` exports to return by name (e.g. contracts/schema.ts's
 * `schemaRelease`). lib/formats.mjs reads the `FORMATS` maps and read lists with it.
 */
export function evaluateExports(refs, extra = []) {
  if (refs.length === 0 && extra.length === 0) return { values: [], extra: {} }
  const { buildSync } = require('esbuild')
  const lines = refs.map((s, i) => `export { ${s.name} as value${i} } from ${JSON.stringify(join(REPO_ROOT, s.module))}`)
  for (const e of extra) lines.push(`export { ${e.name} } from ${JSON.stringify(join(REPO_ROOT, e.module))}`)
  let code
  try {
    const out = buildSync({
      stdin: { contents: lines.join('\n'), resolveDir: REPO_ROOT, loader: 'ts', sourcefile: 'schemas-entry.ts' },
      bundle: true, write: false, format: 'cjs', platform: 'neutral', target: 'es2022', logLevel: 'silent',
      external: ['cloudflare:*', '*.wasm', 'node:*'],
    })
    code = out.outputFiles[0].text
  } catch (e) {
    throw new Error(`reading component sources (${refs.concat(extra).map((r) => `${r.module}#${r.name}`).join(', ')}): ${(e.errors ?? []).map((x) => `${x.location?.file ?? ''}:${x.location?.line ?? ''} ${x.text}`).join('; ') || e.message}`)
  }
  const stub = { DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, WorkflowEntrypoint: class {}, env: {} }
  const module = { exports: {} }
  const sandbox = {
    module, exports: module.exports,
    require: (id) => (id.startsWith('cloudflare:') ? stub : id.endsWith('.wasm') ? {} : id.startsWith('node:') ? {} : (() => { throw new Error(`unexpected import ${id}`) })()),
    TextEncoder, TextDecoder, URL, crypto: globalThis.crypto, console, setTimeout, clearTimeout, structuredClone, atob, btoa,
  }
  vm.runInNewContext(code, sandbox, { filename: 'schemas-bundle.js', timeout: 10_000 })
  const m = module.exports
  return { values: refs.map((_, i) => m[`value${i}`]), extra: Object.fromEntries(extra.map((e) => [e.name, m[e.name]])) }
}

/**
 * Load the specs. Returns, per source, `{ class, component, latest, compat, migrations:
 * [{version, readableFrom, name}] }`, checked by contracts/schema.ts's own `checkSpec`.
 */
export function readSchemas(sources) {
  if (sources.length === 0) return []
  const { values, extra } = evaluateExports(sources, [{ module: 'contracts/schema.ts', name: 'schemaRelease' }])
  const m = { schemaRelease: extra.schemaRelease }
  return sources.map((s, i) => {
    const spec = values[i]
    if (!spec || !Array.isArray(spec.migrations)) throw new Error(`${s.module} does not export a SchemaSpec named ${s.name}`)
    const rel = m.schemaRelease(spec) // runs checkSpec: versions 1..n, readableFrom in range
    return {
      worker: s.worker,
      class: s.class,
      component: rel.component,
      latest: rel.latest,
      compat: rel.compat,
      migrations: spec.migrations.map((x) => ({ version: x.version, readableFrom: x.readableFrom, name: x.name })),
    }
  })
}

export const SCHEMAS_VAR = 'VIZ_SCHEMAS'
export const SCHEMAS_VAR_VERSION = 1

/** The migration that set a spec's `compat`: the first whose `readableFrom` equals it. */
export const compatBy = (s) => {
  const m = s.migrations.find((x) => x.readableFrom === s.compat)
  return m ? `${m.version}: ${m.name}` : null
}

/**
 * The var every version of a Worker carries (`VIZ_SCHEMAS`): what that version's code knows of
 * each class it defines. Read back from Cloudflare by later deploys and by rollbacks, so the
 * check never depends on a release record's artifact still existing.
 */
export function schemasVar(list) {
  const classes = {}
  for (const s of list) classes[s.component] = { latest: s.latest, compat: s.compat, by: compatBy(s) }
  return JSON.stringify({ v: SCHEMAS_VAR_VERSION, classes })
}

/**
 * `VIZ_SCHEMAS` of a version as Cloudflare returns it (GET …/versions/{id}: `resources.bindings`,
 * plain_text vars carry `text`). Null if the version has none or one of a version this code
 * does not read (it is then treated as unknown, never guessed).
 */
export function schemasOfVersion(version) {
  const bindings = version?.resources?.bindings ?? version?.bindings ?? []
  const b = bindings.find((x) => x?.name === SCHEMAS_VAR && (x.type === 'plain_text' || x.type === 'json'))
  if (!b) return null
  let v
  try {
    v = typeof b.text === 'string' ? JSON.parse(b.text) : b.json
  } catch {
    return null
  }
  if (!v || v.v !== SCHEMAS_VAR_VERSION || typeof v.classes !== 'object' || v.classes === null) return null
  return v.classes
}
