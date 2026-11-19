// check.mjs's own test: the mutant corpus (tools/mutants-corpus.mjs). Every mutant must be caught by the check it names, with every literal
// it plants reported, and every harmless edit must pass. Mutants are applied to copies outside the tree (tools/mutants.mjs).
//   npm test                 the corpus without the rendered audit and the page audit (R, N, X, V, C and H: the 32 X mutants included)
//   VIZ_SLOW=1 npm test      the whole corpus, including the mutants only the rendered audit or tools/audit.mjs can catch
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { corpus, runMutant } from '../mutants.mjs'
const slow = !!process.env.VIZ_SLOW
for (const m of corpus) {
  const skip = !slow && (m.render || m.run === 'audit') ? 'needs a browser: VIZ_SLOW=1' : false
  test(`${m.id}: ${m.what}`, { skip }, () => {
    const r = runMutant(m)
    assert.ok(r.ok, r.expect === 'pass' ? `refused a harmless edit: ${r.first}` : r.got === 'pass' ? 'survived: the check passed' : `caught, but these were not reported: ${r.missing.join(', ')}`)
  })
}
