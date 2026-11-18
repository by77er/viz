import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { revisionOf, validate } from '../../dashboard/src/index.ts'
import { call, example, get, newTenant, post } from './helpers'

/**
 * Property: any sequence of patches and reverts keeps a dashboard's history linear and
 * every stored revision valid.
 *
 * Linear: numbers are 1..n with no gap, each revision's content is its predecessor's with
 * that step's change applied (so the parent of n is n-1 and nothing was rewritten), the
 * current revision is the last one, and the hash stored with each revision is the hash of
 * the spec stored with it.
 */
type Step =
  | { kind: 'title'; panel: number; value: string }
  | { kind: 'intent'; value: string }
  | { kind: 'tag'; value: string }
  | { kind: 'untag' }
  | { kind: 'breakIt' }
  | { kind: 'stale'; value: string }
  | { kind: 'revert'; to: number }

const text = fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.replace(/[\u0000-\u001f]/g, ' ').trim() || 'x')
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('title' as const), panel: fc.nat(8), value: text }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('intent' as const), value: text.map((s) => `Answers whether the service is healthy right now. ${s}`) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('tag' as const), value: fc.stringMatching(/^[a-z]{1,8}$/) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'untag' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'breakIt' as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('stale' as const), value: text }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('revert' as const), to: fc.nat(40) }) },
)

describe('property: patch and revert sequences', () => {
  it('keep revision history linear, and every stored revision validates', async () => {
    const t = await newTenant()
    let run = 0
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 14 }), async (steps) => {
        const id = `prop_${++run}`
        const spec = example('service_red', id)
        const panels = Object.keys(spec.panels)
        const created = await post(t.admin, '/dashboards', { spec })
        expect(created.status).toBe(201)
        // the model: what each revision should contain
        const model: any[] = [spec]
        const kinds: string[] = ['create']
        let head: string = created.body.revision
        let first: string = head

        for (const s of steps) {
          const cur = model[model.length - 1]
          if (s.kind === 'revert') {
            const to = (s.to % model.length) + 1
            const res = await post(t.admin, `/dashboards/${id}/revisions/${to}/revert`, { baseRevision: head })
            expect(res.status, res.text).toBe(200)
            if (revisionOf(model[to - 1]) === head) expect(res.body.outcome).toBe('unchanged')
            else {
              expect(res.body).toMatchObject({ outcome: 'applied', number: model.length + 1, revertedTo: to })
              model.push(model[to - 1])
              kinds.push('revert')
              head = res.body.revision
            }
            continue
          }
          let ops: any[]
          const next = structuredClone(cur)
          if (s.kind === 'title') {
            const p = panels[s.panel % panels.length]!
            ops = [{ op: 'replace', path: `/panels/${p}/title`, value: s.value }]
            next.panels[p].title = s.value
          } else if (s.kind === 'intent') {
            ops = [{ op: 'replace', path: '/metadata/intent', value: s.value }]
            next.metadata.intent = s.value
          } else if (s.kind === 'tag') {
            if ((cur.metadata.tags ?? []).includes(s.value)) continue
            ops = cur.metadata.tags ? [{ op: 'add', path: '/metadata/tags/-', value: s.value }] : [{ op: 'add', path: '/metadata/tags', value: [s.value] }]
            next.metadata.tags = [...(cur.metadata.tags ?? []), s.value]
          } else if (s.kind === 'untag') {
            if (!cur.metadata.tags) continue
            ops = [{ op: 'remove', path: '/metadata/tags' }]
            delete next.metadata.tags
          } else if (s.kind === 'breakIt') {
            // a patch that would leave the dashboard invalid: refused, history untouched
            const res = await call(t.admin, 'PATCH', `/dashboards/${id}`, { ops: [{ op: 'remove', path: `/panels/${panels[0]}/title` }], baseRevision: head })
            expect(res.status).toBe(422)
            continue
          } else {
            // a patch against the first revision when the dashboard has moved on: refused
            const res = await call(t.admin, 'PATCH', `/dashboards/${id}`, { ops: [{ op: 'replace', path: '/metadata/title', value: s.value }], baseRevision: first })
            if (first === head) {
              if (res.body.outcome === 'applied') {
                next.metadata.title = s.value
                model.push(next)
                kinds.push('patch')
                head = res.body.revision
              }
            } else expect(res.status).toBe(409)
            continue
          }
          const res = await call(t.admin, 'PATCH', `/dashboards/${id}`, { ops, baseRevision: head })
          expect(res.status, res.text).toBe(200)
          if (revisionOf(next) === head) expect(res.body.outcome).toBe('unchanged')
          else {
            expect(res.body).toMatchObject({ outcome: 'applied', number: model.length + 1, previousRevision: head, revision: revisionOf(next) })
            model.push(next)
            kinds.push('patch')
            head = res.body.revision
          }
        }

        // the stored history is the model: contiguous, in order, valid, hashes right, nothing rewritten
        const listed = (await get(t.admin, `/dashboards/${id}/revisions?limit=200`)).body
        expect(listed.items.map((r: any) => r.number)).toEqual(model.map((_m, i) => model.length - i))
        expect(listed.current).toBe(model.length)
        expect(listed.items.map((r: any) => r.kind).reverse()).toEqual(kinds)
        for (let n = 1; n <= model.length; n++) {
          const stored = (await get(t.admin, `/dashboards/${id}/revisions/${n}`)).body
          expect(stored.spec, `revision ${n}`).toEqual(model[n - 1])
          expect(validate(stored.spec).errors, `revision ${n} validates`).toEqual([])
          expect(stored.revision).toBe(revisionOf(stored.spec))
          expect(stored.current).toBe(n === model.length)
        }
        const now = (await get(t.admin, `/dashboards/${id}`)).body
        expect(now).toMatchObject({ number: model.length, revision: head, current: true })
        expect(now.spec).toEqual(model[model.length - 1])
      }),
      { numRuns: 40 },
    )
    expect(run).toBeGreaterThanOrEqual(40)
  })
})
