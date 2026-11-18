import { describe, expect, it } from 'vitest'
import published from '../openapi.json'
import { buildOpenApi } from '../src/openapi'
import { PREFIX, ROUTES, SCOPES } from '../src/routes'
import { get, newTenant } from './helpers'

const doc = published as any
const documented = Object.entries(doc.paths as Record<string, Record<string, any>>).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, path, op })))

describe('OpenAPI', () => {
  it('openapi.json is what src/openapi.ts generates (run `npm run gen:openapi` if this fails)', () => {
    expect(doc).toEqual(buildOpenApi())
    expect(doc.openapi).toBe('3.1.0')
  })

  it('every route is documented and everything documented is a route', () => {
    const routes = ROUTES.map((r) => `${r.method} ${PREFIX}${r.path}`).sort()
    const docs = documented.map((d) => d.key).sort()
    expect(docs.filter((d) => !routes.includes(d)), 'documented but not a route').toEqual([])
    expect(routes.filter((r) => !docs.includes(r)), 'a route without documentation').toEqual([])
    expect(new Set(routes).size).toBe(routes.length)
  })

  it('scopes, path parameters, dryRun and error responses in the document match the handlers', () => {
    for (const r of ROUTES) {
      const op = doc.paths[`${PREFIX}${r.path}`][r.method.toLowerCase()]
      expect([...op['x-scopes']].sort(), `${r.method} ${r.path} scopes`).toEqual([...r.scopes].sort())
      expect(op.security).toEqual([{ apiKey: op['x-scopes'] }])
      const inPath = (op.parameters ?? []).filter((p: any) => p.in === 'path').map((p: any) => p.name)
      expect(inPath, `${r.method} ${r.path} parameters`).toEqual([...r.path.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]))
      // no operation takes a tenant, anywhere
      for (const p of op.parameters ?? []) expect(p.name.toLowerCase()).not.toContain('tenant')
      expect(Object.keys(op.requestBody?.content['application/json'].schema.properties ?? {})).not.toContain('tenant')
      // every mutation documents dryRun; no read does
      const bodyProps = Object.keys(op.requestBody?.content['application/json'].schema.properties ?? {})
      expect(bodyProps.includes('dryRun'), `${r.method} ${r.path} dryRun`).toBe(r.mutation)
      for (const status of ['400', '401', '403']) expect(op.responses[status].content['application/problem+json'].schema.$ref).toBe('#/components/schemas/Problem')
      expect(Object.keys(op.responses).some((s) => s.startsWith('2'))).toBe(true)
      expect(op.summary.length).toBeGreaterThan(5)
    }
    expect(doc.components.schemas.Scope.enum).toEqual([...SCOPES])
    // every $ref resolves
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/[A-Za-z]+/g) ?? []
    for (const ref of refs) expect(doc.components.schemas[ref.split('/').pop()!], ref).toBeDefined()
    for (const f of ['code', 'detail', 'fix']) expect(doc.components.schemas.Problem.required).toContain(f)
  })

  it('is served, without a credential, at /api/v1/control/openapi.json', async () => {
    const res = await get(null, '/openapi.json')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(doc)
    // and real responses have the documented required fields
    const t = await newTenant()
    const who = await get(t.admin, '/whoami')
    for (const f of doc.components.schemas.Identity.required) expect(who.body[f], f).toBeDefined()
    const keys = await get(t.admin, '/keys')
    for (const f of doc.components.schemas.Key.required) expect(keys.body.items[0][f], f).not.toBeUndefined()
    const problem = await get(t.admin, '/keys/nope')
    for (const f of doc.components.schemas.Problem.required) expect(problem.body[f], f).toBeDefined()
    const audit = await get(t.admin, '/audit')
    for (const f of doc.components.schemas.AuditEntry.required) expect(audit.body.items[0][f], f).toBeDefined()
    const settings = await get(t.admin, '/settings/limits')
    for (const f of doc.components.schemas.Setting.required) expect(settings.body[f], f).not.toBeUndefined()
  })
})
