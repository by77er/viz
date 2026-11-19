// node --test deploy/test/: the CI matrix skips what a checkout lacks.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { REPO_ROOT } from '../lib/common.mjs'
import { RUST, TS, matrix } from '../ci/matrix.mjs'

function fakeCheckout(dirs) {
  const root = mkdtempSync(join(tmpdir(), 'viz-matrix-'))
  for (const d of dirs) {
    mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, d, 'package.json'), '{}')
    writeFileSync(join(root, d, 'package-lock.json'), '{}')
  }
  return root
}

test('a checkout without app/ and design-system/ skips them and excludes nothing from query', () => {
  const root = fakeCheckout([...TS.map((c) => c.dir).filter((d) => d !== 'app' && d !== 'design-system'), 'bench'])
  for (const c of RUST) {
    mkdirSync(join(root, c), { recursive: true })
    writeFileSync(join(root, c, 'Cargo.toml'), '')
  }
  try {
    const m = matrix(root)
    const dirs = m.ts.map((t) => t.dir)
    assert.ok(!dirs.includes('app') && !dirs.includes('design-system'))
    assert.ok(dirs.includes('query') && dirs.includes('stack') && dirs.includes('deploy'))
    assert.equal(m.ts.find((t) => t.dir === 'query').exclude, '')
    assert.equal(m.ts.find((t) => t.dir === 'stack').exclude, '')
    assert.equal(m.ts.find((t) => t.dir === 'stack').install, 'bench')
    assert.match(m.notices.join('\n'), /app: not in this checkout/)
    assert.doesNotMatch(m.notices.join('\n'), /query\/test\/http.test.ts/)
    assert.deepEqual(m.rust, RUST)
    // Without bench/, stack's end-to-end test (hyparquet from bench/node_modules) is excluded.
    rmSync(join(root, 'bench'), { recursive: true })
    assert.equal(matrix(root).ts.find((t) => t.dir === 'stack').exclude, 'test/e2e.test.ts')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('with app/ and design-system/ present nothing is excluded; app needs design-system', () => {
  const root = fakeCheckout(TS.map((c) => c.dir))
  mkdirSync(join(root, 'app/src/api'), { recursive: true })
  writeFileSync(join(root, 'app/src/api/client.ts'), '')
  try {
    const m = matrix(root)
    assert.ok(m.ts.some((t) => t.dir === 'app'))
    assert.equal(m.ts.find((t) => t.dir === 'query').exclude, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  const noDs = fakeCheckout(TS.map((c) => c.dir).filter((d) => d !== 'design-system'))
  try {
    assert.ok(!matrix(noDs).ts.some((t) => t.dir === 'app'))
  } finally {
    rmSync(noDs, { recursive: true, force: true })
  }
})

test('every optional exclusion still has its reason: the test file still imports what it needs', () => {
  for (const c of TS) {
    for (const o of c.optional ?? []) {
      assert.ok(o.imports, `${c.dir}/${o.file}: an optional exclusion must name the import that justifies it`)
      const text = readFileSync(join(REPO_ROOT, c.dir, o.file), 'utf8')
      assert.ok(text.includes(o.imports), `${c.dir}/${o.file} no longer contains "${o.imports}": drop the exclusion so the file runs in CI`)
    }
  }
})
