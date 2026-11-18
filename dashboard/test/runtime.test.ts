import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { root } from './helpers.ts'

const sources = readdirSync(root + 'src').filter((f) => f.endsWith('.ts'))

describe('runs where Workers run', () => {
  it('src has no eval, no Function constructor, no Node or DOM globals, no imports outside src', () => {
    for (const f of sources) {
      const code = readFileSync(root + 'src/' + f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      expect(code, f).not.toMatch(/\beval\s*\(|new\s+Function\b|\bFunction\s*\(/)
      expect(code, f).not.toMatch(/\b(process|Buffer|require|window|document|navigator|__dirname|structuredClone)\b\s*[.(\[]/)
      for (const m of code.matchAll(/from\s+'([^']+)'/g)) expect(m[1], f).toMatch(/^\.\/[a-z-]+\.ts$/)
    }
    const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8')) as { dependencies?: object }
    expect(pkg.dependencies ?? {}).toEqual({})
  })

  it('the whole API works with code generation from strings disabled (as in workerd)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'viz-dashboard-'))
    const script = join(dir, 'run.mjs')
    writeFileSync(
      script,
      `import { readFileSync, readdirSync } from 'node:fs'
import * as m from ${JSON.stringify(root + 'src/index.ts')}
let threw = false
try { new Function('return 1')() } catch { threw = true }
if (!threw) throw new Error('flag not active')
const dir = ${JSON.stringify(root + 'examples/')}
let n = 0
for (const f of readdirSync(dir)) {
  const spec = JSON.parse(readFileSync(dir + f, 'utf8'))
  if (!m.validate(spec).ok || m.lint(spec).length) throw new Error('validate/lint ' + f)
  if (m.validate({ ...spec, panels: { x: { kind: 'statt' } } }).ok) throw new Error('should reject')
  const rev = m.revisionOf(spec)
  const p = m.applyPatch(spec, [{ op: 'replace', path: '/metadata/title', value: 'T' }], { baseRevision: rev })
  if (!p.ok || m.diff(spec, p.spec).length !== 1) throw new Error('patch ' + f)
  const r = m.resolve(spec)
  const d = m.digestDashboard(r, {})
  if (!m.renderDigest(d, { format: 'markdown', maxTokens: 200 }).truncated) throw new Error('digest ' + f)
  n++
}
if (m.fromGrafana({ title: 'x', panels: [{ type: 'stat', title: 'a', targets: [{ expr: 'up' }] }] }).errors.length) throw new Error('grafana')
if (m.getSchema('stat').schema.title !== 'viz.dashboard/v1 StatPanel') throw new Error('schema')
console.log('ok ' + n)
`,
    )
    const out = execFileSync(process.execPath, ['--disallow-code-generation-from-strings', '--no-warnings', script], { encoding: 'utf8' })
    expect(out.trim()).toBe('ok 3')
  })
})
