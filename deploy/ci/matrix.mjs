#!/usr/bin/env node
// The CI matrix, from what is in THIS checkout. A component whose directory is missing (app/
// and design-system/ on main, for now) is left out with a notice instead of failing; a test
// file that needs a missing directory is excluded with a warning that names the reason.
//
//   node deploy/ci/matrix.mjs            → GitHub output lines: ts=<json> rust=<json> wasm=<json> notices=<json>
//   node deploy/ci/matrix.mjs --pretty   → the same, readable
//   node deploy/ci/matrix.mjs --annotations → one GitHub ::notice per component or test left out
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from '../lib/common.mjs'

/**
 * TypeScript components. `wasm`: needs the built engines (artifact `wasm-engines`).
 * `install`: other directories whose node_modules a test imports from. `needs`: directories
 * without which the component cannot run at all. `optional`: test files that import from a
 * directory that may be absent, excluded (tsc and vitest) when it is; `imports` is the text in
 * that file that makes it depend on `needs`, and deploy/test/matrix.test.mjs fails once the file
 * no longer contains it, so an exclusion cannot outlive its reason.
 */
export const TS = [
  { dir: 'shard' },
  { dir: 'edge' },
  { dir: 'ledger' },
  { dir: 'flush', wasm: true },
  { dir: 'compact', wasm: true },
  { dir: 'janitor', wasm: true },
  { dir: 'stack', wasm: true, install: ['bench'], optional: [{ file: 'test/e2e.test.ts', needs: 'bench/package.json', imports: 'bench/node_modules/hyparquet', why: 'imports hyparquet from bench/node_modules' }] },
  { dir: 'query', wasm: true },
  { dir: 'control' },
  { dir: 'dashboard' },
  { dir: 'anomaly' },
  { dir: 'ruler' },
  { dir: 'publisher' },
  { dir: 'mcp' },
  { dir: 'engine/wasm', wasm: true },
  { dir: 'deploy' },
  { dir: 'app', needs: ['design-system'] },
  { dir: 'design-system', commands: ['node tools/check.mjs'] },
]

/** Rust crates: `cargo test -j 2` in each. */
export const RUST = ['engine/storage', 'engine/promql', 'engine/query', 'engine/goregex', 'engine/traceql', 'engine/logql', 'engine/wasm', 'engine/wasm-query']

/** The WASM modules other jobs need, and the scripts that build them. */
export const WASM = [
  { build: 'engine/wasm/build.sh', output: 'engine/wasm/js/viz_engine.wasm' },
  { build: 'engine/wasm-query/build.sh', output: 'engine/wasm-query/js/viz_query.wasm' },
]

export function matrix(root = REPO_ROOT) {
  const has = (p) => existsSync(join(root, p))
  const notices = []
  const ts = []
  for (const c of TS) {
    if (!has(join(c.dir, 'package.json'))) {
      notices.push(`${c.dir}: not in this checkout; skipped`)
      continue
    }
    const missing = (c.needs ?? []).filter((d) => !has(d))
    if (missing.length) {
      notices.push(`${c.dir}: skipped, needs ${missing.join(', ')}, which is not in this checkout`)
      continue
    }
    const exclude = []
    for (const o of c.optional ?? []) {
      if (has(o.needs)) continue
      exclude.push(o.file)
      notices.push(`${c.dir}/${o.file}: excluded because ${o.needs} is not in this checkout (it ${o.why}); see deploy/README.md "Needed changes"`)
    }
    const install = (c.install ?? []).filter((d) => has(join(d, 'package-lock.json')))
    const lock = has(join(c.dir, 'package-lock.json'))
    ts.push({
      dir: c.dir,
      wasm: Boolean(c.wasm),
      install: install.join(' '),
      lockfiles: [lock ? `${c.dir}/package-lock.json` : null, ...install.map((d) => `${d}/package-lock.json`)].filter(Boolean).join('\n') || 'deploy/package-lock.json',
      npm: lock,
      exclude: exclude.join(' '),
      commands: (c.commands ?? []).join(' && '),
    })
  }
  const rust = RUST.filter((d) => {
    if (has(join(d, 'Cargo.toml'))) return true
    notices.push(`${d}: not in this checkout; skipped`)
    return false
  })
  const wasm = WASM.filter((w) => has(w.build))
  return { ts, rust, wasm, notices }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = matrix()
  if (process.argv.includes('--pretty')) console.log(JSON.stringify(m, null, 2))
  else if (process.argv.includes('--annotations')) for (const n of m.notices) console.log(`::notice title=CI: not run in this checkout::${n}`)
  else for (const [k, v] of Object.entries(m)) console.log(`${k}=${JSON.stringify(v)}`)
}
