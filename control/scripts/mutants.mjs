// Mutation check: break one behaviour at a time, run the suite, expect it to FAIL, restore.
//   node scripts/mutants.mjs [substring of a mutant's name]
// A mutant is [name, [[file, from, to], ...]]; every replacement must apply or the mutant counts as not killed.
//
// It edits the sources in place (here and in ../contracts), so run it from control/ in a COPY
// of the repository outside any git work tree (AGENTS.md: a mutant caught in a commit ships).
// The copy needs control/ (with node_modules), contracts/, edge/src, shard/src, ruler/src,
// mcp/src and dashboard/{src,examples,schema,package.json}. It refuses to run in a work tree.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

try {
  execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' })
  console.error('Refusing to mutate sources inside a git work tree. Copy the tree first (see the header of this file).')
  process.exit(2)
} catch {
  // Not a work tree (or no git): a copy. Go on.
}

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
  // ---- versioned storage and formats (contracts/COMPATIBILITY.md); the runner is shared, so its mutants run here ----
  ['versioned: runner: storage a newer release wrote is opened although it is not readable (refusal removed)', [['../contracts/schema.ts', '    if (row.compat > known) {', '    if (false) {']]],
  ['versioned: runner: newer storage that IS readable is refused (compat ignored)', [['../contracts/schema.ts', '    if (row.compat > known) {', '    if (row.version > known) {']]],
  ['versioned: runner: opening newer, readable storage lowers its version', [['../contracts/schema.ts', "    // Newer, but declared readable by this code: open it as it is. Never lower the version.\n    return { status: 'ok', component: spec.component, version: row.version, compat: row.compat, known, migrated: [], adopted: false }\n", '']]],
  ['versioned: runner: migrations not in one transaction (a failing step leaves half a migration)', [
    ['../contracts/schema.ts', '  storage.transactionSync(() => {\n    sql.exec(\n      `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE}', '  ;(() => {\n    sql.exec(\n      `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE}'],
    ['../contracts/schema.ts', '      now,\n    )\n  })\n  return {', '      now,\n    )\n  })()\n  return {'],
  ]],
  ['versioned: runner: the new version is not recorded (every open migrates again)', [['../contracts/schema.ts', '      spec.component,\n      known,\n      compat,', '      spec.component,\n      Math.max(1, from),\n      compat,']]],
  ['versioned: Tenant serves storage a newer release wrote (its refusal ignored)', [['src/tenant.ts', '  refusal(): SchemaTooNew | null {\n    return refusalOf(this.schema)', '  refusal(): SchemaTooNew | null {\n    return null']]],
  ['versioned: a refusing Tenant lets its alarm lapse (the newer release would lose its deadlines)', [['src/tenant.ts', '      await this.ctx.storage.setAlarm(Date.now() + refused.retryAfterMs)\n      return\n    }\n    if (this.tenant', '      return\n    }\n    if (this.tenant']]],
  ['versioned: a released migration edited in place (version 1 no longer creates the append-only trigger)', [['src/schema.ts', "CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;\n", '']]],
  ['versioned: the KV key record edge reads changes shape without a format version', [['src/ops-keys.ts', 'const record = { tenant: t.tenant, secretSha256: s.secret_sha256,', 'const record = { v: 1, tenant: t.tenant, secretSha256: s.secret_sha256,']]],
  ['versioned: the list cursor encoding changes without a format version', [['src/util.ts', "return btoa(JSON.stringify(position)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')", "return btoa(JSON.stringify(position)).replace(/\\+/g, '-').replace(/\\//g, '_')"]]],
  // ---- scopes for other services, whoami, proposals that create a dashboard, schema version 2 ----
  ['creation: an agent may apply a proposal that creates a dashboard', [['src/ops-proposals.ts', "  if (!mayApply(t, c)) {\n    throw new Problem(403, 'agents-may-not-apply', 'An agent may not apply a proposal that creates", "  if (false) {\n    throw new Problem(403, 'agents-may-not-apply', 'An agent may not apply a proposal that creates"]]],
  ['creation: the proposed spec is not validated', [['src/ops-proposals.ts', 'return proposeCreation(t, c, mustValidate(b.spec), message)', 'return proposeCreation(t, c, b.spec as Dashboard, message)']]],
  ['creation: the stored spec is not validated again when applied', [['src/ops-proposals.ts', 'const spec = mustValidate(JSON.parse(row.spec))', 'const spec = JSON.parse(row.spec) as Dashboard']]],
  ['creation: a retry stores a second proposal (idempotency removed)', [['src/ops-proposals.ts', 'if (same && isCreation(same)) throw new NoChange(', 'if (false) throw new NoChange(']]],
  ['creation: an id held by a live dashboard is not checked', [['src/ops-dashboards.ts', "  if (holder === 'live') {", '  if (false) {']]],
  ['creation: a row an older release rewrote into a change is still read as a creation', [['src/ops-proposals.ts', '=> row.base_number === 0 && row.spec !== null', '=> row.spec !== null']]],
  ['creation: purging a dashboard deletes an open proposal to create one under its id', [['src/ops-dashboards.ts', " AND NOT (base_number = 0 AND spec IS NOT NULL AND status = 'open')\"", '"']]],
  ['scopes: control cannot issue the ruler\'s scopes', [['src/routes.ts', ", 'monitors:read', 'monitors:write', 'monitors:ack'] as const", '] as const']]],
  ['scopes: a monitors scope opens the dashboards API', [['src/routes.ts', "const D_READ: readonly Scope[] = ['admin', 'dashboards:read', 'dashboards:write', 'dashboards:apply']", "const D_READ: readonly Scope[] = ['admin', 'dashboards:read', 'dashboards:write', 'dashboards:apply', 'monitors:read']"]]],
  ['whoami: mayApply ignores the tenant setting (agents with the scope always may)', [['src/tenant.ts', 'mayApply: mayApply(t, c) } })', "mayApply: c.id.scopes.includes('dashboards:apply') || c.id.scopes.includes('admin') } })"]]],
  ['versioned: migration 2 declared forward-only (readableFrom 2)', [['src/schema.ts', "      readableFrom: 1,\n      up: (sql) => {\n        if (!columnsOf", "      readableFrom: 2,\n      up: (sql) => {\n        if (!columnsOf"]]],
  ['versioned: released migration 2 edited in place (the column is not added)', [['src/schema.ts', "if (!columnsOf(sql, 'proposals').has('spec')) sql.exec(V2)", 'void columnsOf']]],
  ['health: /healthz is not served (or needs a credential)', [['src/index.ts', "      if (pathname === '/healthz') return health(req, env)\n", '']]],
  // 59–65: the service surface (contracts/control.ts) and the notification settings it serves.
  ['service: notificationTarget answers for any tenant (the tenant check dropped)', [['src/tenant.ts', "    if (this.tenant === '' || tenant !== this.tenant) return { v: 1, status: 'not_provisioned' }\n    return notificationTarget(this)", "    if (this.tenant === '') return { v: 1, status: 'not_provisioned' }\n    return notificationTarget(this)"]]],
  ['service: serviceKey issues for any tenant (the tenant check dropped)', [['src/tenant.ts', "    if (this.tenant === '' || tenant !== this.tenant) return { v: 1, status: 'not_provisioned' }\n    if (!Object.hasOwn(SERVICE_KEYS, service))", "    if (this.tenant === '') return { v: 1, status: 'not_provisioned' }\n    if (!Object.hasOwn(SERVICE_KEYS, service))"]]],
  ['service: the webhook secret is stored in the settings value (so reads and the audit log carry it)', [['src/ops-settings.ts', 'return { value: { email: email as string[], webhookUrl, webhookFormat: format, sendResolved: o.sendResolved !== false, webhookSecretSetAt: setAt }, secret }', 'return { value: { email: email as string[], webhookUrl, webhookFormat: format, sendResolved: o.sendResolved !== false, webhookSecretSetAt: setAt, ...(typeof secret === \'string\' ? { webhookSecret: secret } : {}) } as NotificationsValue, secret }']]],
  ['service: a webhook secret follows the webhook to a new URL', [['src/ops-settings.ts', '} else if (webhookUrl !== null && webhookUrl === before.webhookUrl && before.webhookSecretSetAt !== null) {', '} else if (webhookUrl !== null && before.webhookSecretSetAt !== null) {']]],
  ['service: a service key a person disabled is replaced (access the tenant withdrew comes back)', [['src/ops-keys.ts', "  if (row && row.disabled === 1) return { v: 1, status: 'disabled', name }\n", '']]],
  ['service: a rotation keeps the previous secret live', [['src/ops-keys.ts', "  t.run('DELETE FROM key_secrets WHERE tenant = ? AND key = ?', t.tenant, row.id)\n  bumpRevocation(t, now)\n  const { keyId, secret } = mint()", "  bumpRevocation(t, now)\n  const { keyId, secret } = mint()"]]],
  ['service: a person may create a key under the reserved service: prefix', [['src/ops-keys.ts', '  if (name.startsWith(SERVICE_KEY_PREFIX)) {', '  if (name.startsWith(SERVICE_KEY_PREFIX) && false) {']]],
  // 66–90: OAuth for agents (D44, contracts/oauth.ts)
  ['oauth: a grant holds scopes its approver\'s key does not', [['src/ops-oauth.ts', 'const granted = wanted.filter((s) => mine.has(s))', 'const granted = wanted']]],
  ['oauth: admin stands for every grantable scope', [['src/oauth.ts', '  if (out.has(\'admin\')) for (const s of ADMIN_IMPLIES) out.add(s)', '  if (out.has(\'admin\')) for (const s of OAUTH_SCOPES) out.add(s)']]],
  ['oauth: an agent key may approve', [['src/ops-oauth.ts', "  if (c.id.kind === 'agent') throw new Problem(403, 'approver-not-a-person',", "  if (false) throw new Problem(403, 'approver-not-a-person',"]]],
  ['oauth: approving needs only dashboards:write, not admin', [['src/routes.ts', "r('POST', '/oauth/approve', 'oauth.approve', ADMIN)", "r('POST', '/oauth/approve', 'oauth.approve', D_WRITE)"]]],
  ['oauth: the PKCE verifier is not checked at the token endpoint', [['src/ops-oauth.ts', '    if (!pkceMatches(req.code_verifier!, row.challenge))', '    if (false)']]],
  ['oauth: plain PKCE (or none) accepted at /oauth/authorize', [['src/oauth-http.ts', "  if (q.get('code_challenge_method') !== 'S256') return back(", "  if (false) return back("]]],
  ['oauth: a used code is accepted again', [['src/ops-oauth.ts', '    if (row.used_at !== null) {\n      // A code used twice', '    if (false) {\n      // A code used twice']]],
  ['oauth: code reuse refused but what it issued not revoked', [['src/ops-oauth.ts', "      if (g) revokeGrant(t, g, SYSTEM, now, 'code-reuse')\n", '']]],
  ['oauth: refresh tokens not rotated (a used one stays valid)', [['src/ops-oauth.ts', "    t.run('UPDATE oauth_tokens SET rotated_at = ? WHERE tenant = ? AND hash = ?', now, t.tenant, hash)\n", '']]],
  ['oauth: refresh token reuse refused but the grant not revoked', [['src/ops-oauth.ts', "      if (g) revokeGrant(t, g, SYSTEM, now, 'refresh-reuse')\n", '']]],
  ['oauth: redirect URI matched as a prefix at /oauth/authorize (open redirect)', [['src/oauth-http.ts', 'if (redirectUri === null || !reg.uris.includes(redirectUri))', 'if (redirectUri === null || !reg.uris.some((u) => redirectUri.startsWith(u)))']]],
  ['oauth: redirect URI not checked at the token endpoint', [['src/ops-oauth.ts', "    if (req.redirect_uri !== row.redirect_uri) return", '    if (false) return']]],
  ['oauth: an error is redirected to the client\'s callback automatically (302)', [['src/oauth-http.ts', "  return page(400, `viz: the application asked for something this server does not grant.", "  return Response.redirect(link, 302) ?? page(400, `viz: the application asked for something this server does not grant."]]],
  ['oauth: the client id\'s signature is not checked (tampered or forged registrations accepted)', [['src/oauth.ts', "  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), mac, utf8(m[1]!))", '  const ok = mac.length === 32']]],
  ['oauth: an unapproved registration never expires', [['src/ops-oauth.ts', '    if (c.now - reg.iat * 1000 > OAUTH_LIFETIMES.unboundRegistrationSeconds * 1000) {', '    if (false) {']]],
  ['oauth: an expired access token is accepted', [['src/ops-oauth.ts', "  if (row.expires_at <= now) return inactive('expired')", '']]],
  ['oauth: the audience is not checked (a token for another resource is accepted)', [['src/ops-oauth.ts', "  if (!sameResource(resource, g.resource)) return inactive('audience')", '']]],
  ['oauth: revoking a grant leaves its tokens', [['src/ops-oauth.ts', "  t.run('DELETE FROM oauth_tokens WHERE tenant = ? AND grant_id = ?', t.tenant, g.id)\n", '']]],
  ['oauth: revoking a grant leaves its key (live in KV for the data path)', [['src/ops-oauth.ts', '  if (keyOf(t, g)) dropKey(t, g.key!, now)\n', '']]],
  ['oauth: a suspended grant (its key disabled) still works at the resource', [['src/ops-oauth.ts', "  if (k.disabled === 1 || a === 'disabled') return inactive('suspended')", "  if (a === 'disabled') return inactive('suspended')"]]],
  ['oauth: introspection answers for another tenant\'s object (tenant check dropped)', [['src/tenant.ts', "    if (this.tenant === '' || tenant !== this.tenant) return { v: 1, status: 'not_provisioned' }\n    const kind = typeof token === 'string' ? parseCredential(token) : null", "    if (this.tenant === '') return { v: 1, status: 'not_provisioned' }\n    const kind = typeof token === 'string' ? parseCredential(token) : null"]]],
  ['oauth: the token endpoint takes the tenant from a form field', [['src/oauth-http.ts', 'const r = await tenantStub(env, cred.tenant).oauthToken(cred.tenant, request)', 'const r = await tenantStub(env, form.tenant ?? cred.tenant).oauthToken(form.tenant ?? cred.tenant, request)']]],
  ['oauth: a code is stored in clear, not hashed', [['src/ops-oauth.ts', '    t.tenant, hashCredential(p.code), p.grantId, req.code_challenge,', '    t.tenant, p.code, p.grantId, req.code_challenge,'], ['src/ops-oauth.ts', "  const hash = hashCredential(req.code)\n  const gone = 'The authorization code", "  const hash = req.code\n  const gone = 'The authorization code"]]],
  ['oauth: an error body repeats the presented code', [['src/ops-oauth.ts', "  const gone = 'The authorization code is unknown, expired or already used.'", "  const gone = `The authorization code ${req.code} is unknown, expired or already used.`"]]],
  ['oauth: a code nobody exchanged leaves its grant (and key) live', [['src/ops-oauth.ts', "  for (const g of open('id IN (SELECT grant_id FROM oauth_codes WHERE tenant = ? AND used_at IS NULL AND expires_at <= ?)', t.tenant, now)) revokeGrant(t, g, SYSTEM, now, 'not-exchanged')\n", '']]],
  ['oauth: a grant\'s key can be rotated through the keys API (its sealed copies go stale)', [['src/ops-keys.ts', "  guardGrantKey(row, 'rotated')\n", '']]],
  ['oauth: introspection ignores the approver\'s key (a grant outlives it, or works while it is disabled)', [['src/ops-oauth.ts', '  const a = approver(t, cur, now)', "  const a = 'live' as 'live' | 'disabled' | 'gone'"]]],
  ['oauth: a credential naming an unprovisioned tenant creates storage for it (the object migrates on construction)', [['src/tenant.ts', '      if (empty) {\n        this.unopened = true', '      if (false) {\n        this.unopened = true']]],
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
  let noResult = false
  let detail = ''
  if (applied) {
    try {
      // The generated document must follow its source, as it would in a real change.
      if (edits.some(([file]) => file === 'src/openapi.ts')) execSync('node scripts/gen-openapi.mjs', { stdio: 'pipe' })
      execSync('npx vitest run --maxWorkers=2', { stdio: 'pipe', timeout: 900_000, env: { ...process.env, NO_COLOR: '1' } })
    } catch (e) {
      const out = String(e.stdout ?? '') + String(e.stderr ?? '')
      const tests = /Tests\s+(\d+) failed/.exec(out)
      const files = [...new Set([...out.matchAll(/FAIL\s+(test\/[a-z]+\.test\.ts)/g)].map((m) => m[1].replace('test/', '').replace('.test.ts', '')))]
      // Only a test that ran and failed kills a mutant. A suite that crashed, hung or was
      // killed gave no result: reported as such and counted as not killed (rerun it).
      if (tests) {
        failed = true
        detail = `${tests[1]} failed: ${files.join(', ')}`
      } else noResult = true
    }
  }
  for (const [file, text] of originals) writeFileSync(file, text)
  if (edits.some(([file]) => file === 'src/openapi.ts')) execSync('node scripts/gen-openapi.mjs', { stdio: 'pipe' })
  if (!applied) {
    console.log(`NOT APPLIED  ${name}`)
    survived++
  } else if (noResult) {
    console.log(`NO RESULT    ${name}  (the suite did not finish; rerun)`)
    survived++
  } else if (failed) console.log(`killed       ${name}  [${detail}]`)
  else {
    console.log(`SURVIVED     ${name}`)
    survived++
  }
}
console.log(`\n${n - survived} of ${n} mutants killed`)
process.exit(survived ? 1 : 0)
