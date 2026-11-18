// Mutation check: break one behaviour at a time, run the suite, expect it to FAIL, restore.
//   node scripts/mutants.mjs [substring of a mutant's name]
// A mutant is [name, [[file, from, to], ...]]; every replacement must apply or the mutant counts as not killed.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const INVOKE_TENANT_CHECK = "if (this.tenant === '' || id.tenant !== this.tenant) throw new Problem(401, 'unauthenticated', 'The credential is not usable.', 'Use a key of a provisioned tenant.')"
const FROM_QUERY = [
  ['src/index.ts', "    if (url.searchParams.has('tenant')) throw tenantNotAccepted('query string')\n", ''],
  ['src/index.ts', 'env.TENANT.get(env.TENANT.idFromName(identity.tenant))', "env.TENANT.get(env.TENANT.idFromName(url.searchParams.get('tenant') ?? identity.tenant))"],
]

const mutants = [
  // ---- the ten the task names ----
  ['tenant taken from a request parameter (?tenant=)', FROM_QUERY],
  ['tenant taken from a request parameter, and the Tenant object trusting what it is told', [
    ...FROM_QUERY,
    ['src/index.ts', 'await rpc.invoke(identity, match.route.op as OpName, input)', "await rpc.invoke({ ...identity, tenant: url.searchParams.get('tenant') ?? identity.tenant }, match.route.op as OpName, input)"],
    ['src/tenant.ts', INVOKE_TENANT_CHECK, ''],
    ['src/tenant.ts', 'if (id.keyId !== undefined) {', 'if (false) {'],
  ]],
  ['secret stored in clear', [['src/ops-keys.ts', 't.tenant, keyId, id, sha256Hex(secret))', 't.tenant, keyId, id, secret)']]],
  ['list returning the stored secret material', [['src/ops-keys.ts', '    prefix: `viz_${row.key_id}`,', "    prefix: `viz_${row.key_id}`,\n    secretSha256: t.one<{ s: string }>('SELECT secret_sha256 AS s FROM key_secrets WHERE tenant = ? AND key_id = ?', t.tenant, row.key_id)?.s ?? null,"]]],
  ['base-revision check skipped on patch', [['src/ops-dashboards.ts',
    "  if (base !== dash.revision) throw staleProblem(t, dash, base)\n  const before = specAt(t, dash.id, dash.head)\n  const r = applyPatch(before, ops, { baseRevision: base })",
    "  const before = specAt(t, dash.id, dash.head)\n  const r = applyPatch(before, ops, { baseRevision: dash.revision })"]]],
  ['apply without the apply scope', [['src/routes.ts', "'proposals.apply', D_APPLY)", "'proposals.apply', D_WRITE)"]]],
  ['agent self-apply allowed', [['src/ops-proposals.ts', "if (c.id.kind === 'agent' && own && !general(t).agentsMayApply) {", 'if (false) {']]],
  ['proposal applied against a moved dashboard without the rebase check', [['src/ops-proposals.ts', 'if (ev.needsRebase) {', 'if (false) {']]],
  ['mutation not atomic with its audit row: a failure part-way, then a retry, leaves a change with no entry', [
    ['src/tenant.ts', 'const result = this.ctx.storage.transactionSync(() => {\n        const audits', 'const result = (() => {\n        const audits'],
    ['src/tenant.ts', "        return r\n      })\n      return { result, committed: true, queued }", "        return r\n      })()\n      return { result, committed: true, queued }"],
  ]],
  ['KV written before the transaction commits', [['src/tenant.ts',
    "    this.run('INSERT INTO outbox (tenant, kv_key, value, expiration, created_at) VALUES (?, ?, ?, ?, ?)'",
    "    if (value !== null) void this.kv.put(kvKey, JSON.stringify(value)).catch(() => {})\n    this.run('INSERT INTO outbox (tenant, kv_key, value, expiration, created_at) VALUES (?, ?, ?, ?, ?)'"]]],
  ['soft-deleted dashboard still listed', [['src/ops-dashboards.ts', "'deleted_at IS NOT NULL' : 'deleted_at IS NULL'", "'deleted_at IS NOT NULL' : '1 = 1'"]]],
  // ---- further ones ----
  ['dry run commits', [['src/tenant.ts', '        if (c.dryRun) throw new Rollback(r)\n', '']]],
  ['a mutation without an audit row (owner change), structural guard removed', [
    ['src/tenant.ts', "        if (written !== 1) throw new Error(`${written} audit rows for one mutation`)\n", ''],
    ['src/ops-dashboards.ts', "  t.audit(c.actor, c.now, 'dashboard.owner', 'dashboard', dash.id, { owner: dash.owner }, { owner })\n", ''],
  ]],
  ['disabled key still accepted by the Tenant object', [['src/tenant.ts', 'WHERE s.tenant = ? AND s.key_id = ? AND k.disabled = 0', 'WHERE s.tenant = ? AND s.key_id = ?']]],
  ['disabled key published to KV as enabled', [['src/ops-keys.ts', 'scopes: JSON.parse(row.scopes) as string[], disabled: row.disabled === 1 }\n    t.publish', 'scopes: JSON.parse(row.scopes) as string[], disabled: false }\n    t.publish']]],
  ['old secret kept in KV after a rotation without overlap', [['src/ops-keys.ts', "t.all<{ key_id: string }>('SELECT key_id FROM key_secrets WHERE tenant = ? AND key = ?', t.tenant, row.id)) t.publish(`key:${s.key_id}`, null, c.now)\n    t.run('DELETE FROM key_secrets WHERE tenant = ? AND key = ?', t.tenant, row.id)\n    bumpRevocation", "[] as { key_id: string }[]) t.publish(`key:${s.key_id}`, null, c.now)\n    t.run('DELETE FROM key_secrets WHERE tenant = ? AND key = ?', t.tenant, row.id)\n    bumpRevocation"]]],
  ['revocation generation not bumped on disable', [['src/ops-keys.ts', '    if (disabled) bumpRevocation(t, c.now)\n', '']]],
  ['key deleted without its name as confirmation', [['src/ops-keys.ts', 'if (confirm !== row.name) {', 'if (false) {']]],
  ['last admin key may be disabled or deleted', [['src/ops-keys.ts', 'if (others.length === 0) {', 'if (false) {']]],
  ['usage accepted for another tenant', [['src/tenant.ts', "if (this.tenant === '' || tenant !== this.tenant) return { accepted: 0, unknown: batch.length }", '']]],
  ['rebase check ignores edits made underneath (only failing ops count)', [['src/ops-proposals.ts', 'const conflicts = [...new Set(underneath.filter((u) => mine.some((m) => overlaps(m, u.prefix))).map((u) => u.path))]', 'const conflicts: string[] = []']]],
  ['expired proposal can still be applied', [['src/ops-proposals.ts', "(row.status === 'open' && row.expires_at <= now ? 'expired' : row.status)", '(now > 0 ? row.status : row.status)']]],
  ['partial apply applies every change', [['src/ops-proposals.ts', 'chosen = all.filter((ch) => (b.changes as string[]).includes(ch.name))', 'chosen = all']]],
  ['proposer not recorded on the applied revision', [['src/ops-proposals.ts', "{ kind: 'apply', message, proposal: row.id, proposedBy: by }", "{ kind: 'apply', message, proposal: row.id }"]]],
  ['an agent with the apply scope may write directly', [['src/ops-dashboards.ts', "return c.id.kind !== 'agent' || general(t).agentsMayApply", 'return true']]],
  ['If-Match ignored', [['src/ops-dashboards.ts', 'const fromHeader = c.input.ifMatch', 'const fromHeader = undefined as string | undefined']]],
  ['revision cap not enforced', [['src/ops-dashboards.ts', 'if (number > t.caps.maxRevisionsPerDashboard) {', 'if (false) {']]],
  ['tenant byte cap not enforced', [['src/ops-dashboards.ts', 'if (used + adding > t.caps.maxTenantBytes) {', 'if (false) {']]],
  ['pool epoch not bumped when spread grows', [['src/ops-settings.ts', 'epoch: spread === before.spread ? before.epoch : before.epoch + 1', 'epoch: before.epoch']]],
  ['pool slot-count change not refused', [['src/ops-settings.ts', "  if (slots !== before.slots) throw unsupported('the number of slots')\n", '']]],
  ['shortening retention needs no confirmation', [['src/ops-settings.ts', 'if (shorter.length && !confirmShorter) {', 'if (false) {']]],
  ['a statement that does not name the tenant', [['src/ops-audit.ts', "FROM audit WHERE tenant = ? AND id = ?`, t.tenant, c.input.params.entry!)", "FROM audit WHERE id = ?`, c.input.params.entry!)"]]],
  ['alarm left set when there is nothing to do', [['src/tenant.ts', ': this.ctx.storage.deleteAlarm()', ': Promise.resolve()']]],
  ['CORS answers any origin', [['src/index.ts', 'if (!origin || !allowed.includes(origin)) return', 'if (!origin) return']]],
  ['a route without documentation', [['src/openapi.ts', "  'GET /audit/{entry}': { summary: 'One audit entry', scopes: ADMIN, ok: [200, 'The entry', ref('AuditEntry')], errors: [404] },\n", '']]],
]

const only = process.argv[2]
let survived = 0
let n = 0
for (const [name, edits] of mutants) {
  if (only && !name.includes(only)) continue
  n++
  const originals = new Map()
  let applied = true
  for (const [file, from, to] of edits) {
    const current = originals.has(file) ? readFileSync(file, 'utf8') : (originals.set(file, readFileSync(file, 'utf8')), originals.get(file))
    if (!current.includes(from)) {
      applied = false
      break
    }
    writeFileSync(file, current.replace(from, to))
  }
  let failed = false
  let detail = ''
  if (applied) {
    try {
      // The generated document must follow its source, as it would in a real change.
      if (edits.some(([file]) => file === 'src/openapi.ts')) execSync('node scripts/gen-openapi.mjs', { stdio: 'pipe' })
      execSync('npx vitest run', { stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
    } catch (e) {
      failed = true
      const out = String(e.stdout ?? '') + String(e.stderr ?? '')
      const tests = /Tests\s+(\d+) failed/.exec(out)
      const files = [...new Set([...out.matchAll(/FAIL\s+(test\/[a-z]+\.test\.ts)/g)].map((m) => m[1].replace('test/', '').replace('.test.ts', '')))]
      detail = tests ? `${tests[1]} failed: ${files.join(', ')}` : 'suite did not run'
    }
  }
  for (const [file, text] of originals) writeFileSync(file, text)
  if (edits.some(([file]) => file === 'src/openapi.ts')) execSync('node scripts/gen-openapi.mjs', { stdio: 'pipe' })
  if (!applied) {
    console.log(`NOT APPLIED  ${name}`)
    survived++
  } else if (failed) console.log(`killed       ${name}  [${detail}]`)
  else {
    console.log(`SURVIVED     ${name}`)
    survived++
  }
}
console.log(`\n${n - survived} of ${n} mutants killed`)
process.exit(survived ? 1 : 0)
