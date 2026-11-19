/**
 * The OpenAPI 3.1 description of the control API, written by hand next to the handlers.
 * `npm run gen:openapi` writes it to `openapi.json`; `test/openapi.test.ts` fails if that
 * file is out of date, if a route in `routes.ts` is not described here, if something
 * described here is not a route, or if the scopes or path parameters disagree.
 *
 * No imports and only erasable TypeScript, so Node runs this file directly.
 */
type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Schema = { [k: string]: Json }

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` })
const str = (description?: string): Schema => (description ? { type: 'string', description } : { type: 'string' })
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: 'null' }] })
const arr = (items: Schema): Schema => ({ type: 'array', items })
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}) })
const time = (description?: string): Schema => ({ type: 'string', format: 'date-time', ...(description ? { description } : {}) })
const dryRun: Schema = { type: 'boolean', description: 'Run everything, report exactly what would happen, change nothing. The response carries "dryRun": true.' }

const schemas: Record<string, Schema> = {
  Problem: {
    ...obj(
      {
        type: str(),
        title: str(),
        status: { type: 'integer' },
        code: str('Stable machine-readable code, e.g. stale-revision, needs-rebase, self-apply, missing-scope.'),
        detail: str('What went wrong, in a sentence.'),
        fix: str('What the caller should do next.'),
      },
      ['type', 'title', 'status', 'code', 'detail', 'fix'],
    ),
    description: 'RFC 9457 problem details. Some codes add fields: stale-revision adds currentRevision, currentNumber, changedUnderneath, revisionsSince; invalid-dashboard adds errors; needs-rebase adds review.',
    additionalProperties: true,
  },
  Actor: obj({ subject: str('e.g. key:k_…'), kind: { enum: ['user', 'agent', 'key', 'system'] }, name: nullable(str()) }, ['subject', 'kind', 'name']),
  Identity: obj(
    {
      tenant: str(),
      subject: str(),
      kind: { enum: ['user', 'agent', 'key'] },
      name: nullable(str()),
      scopes: arr(ref('Scope')),
      mayApply: { type: 'boolean', description: 'Whether this caller\'s direct dashboard writes (create, patch, revert, delete, restore, owner, and applying a proposal that creates a dashboard) take effect, rather than being refused or turned into a proposal. False without dashboards:apply (or admin), and for an agent while the tenant\'s agentsMayApply is false.' },
    },
    ['tenant', 'subject', 'kind', 'scopes', 'mayApply'],
  ),
  Scope: {
    enum: ['admin', 'dashboards:read', 'dashboards:write', 'dashboards:apply', 'write', 'read', 'monitors:read', 'monitors:write', 'monitors:ack'],
    description: 'admin and dashboards:* are checked by this API; write and read by ingest and the query service; monitors:* by the ruler. Each service checks its own scopes; any scope reaches GET /whoami here.',
  },
  Key: obj(
    {
      id: str(),
      name: str(),
      kind: { enum: ['key', 'agent'] },
      scopes: arr(ref('Scope')),
      prefix: str('viz_<keyId>: the public part of the key. The secret is never returned after creation.'),
      createdAt: time(),
      createdBy: ref('Actor'),
      expiresAt: nullable(time()),
      expired: { type: 'boolean' },
      disabled: { type: 'boolean' },
      rotatedAt: nullable(time()),
      previousSecretValidUntil: nullable(time('Set while a rotated-out secret is still inside its overlap.')),
      lastUsedAt: nullable(time('Null until the data path reports usage for this key.')),
      samples24h: nullable({ type: 'integer', description: 'Samples written with this key in the last 24 h, to the hour. Null until usage is reported.' }),
    },
    ['id', 'name', 'kind', 'scopes', 'prefix', 'createdAt', 'createdBy', 'disabled', 'lastUsedAt', 'samples24h'],
  ),
  KeyWithSecret: obj({ key: ref('Key'), secret: nullable(str('The full key, viz_<keyId>_<secret>. Shown in this response only; null in a dry run.')), shownOnce: { type: 'boolean' }, kv: ref('KvState') }, ['key', 'secret']),
  KvState: { enum: ['published', 'pending'], description: 'Whether the change has been written to KV for the data path. "pending" is retried within 30 s.' },
  Dashboard: obj(
    {
      id: str(),
      name: str('The dashboard title.'),
      intent: str('What it answers.'),
      tags: arr(str()),
      owner: nullable(str()),
      panels: { type: 'integer' },
      revision: str('Content hash of the current spec; use it as baseRevision or If-Match.'),
      number: { type: 'integer', description: 'Revision number, counting from 1.' },
      createdAt: time(),
      createdBy: ref('Actor'),
      lastChangedAt: time(),
      lastChangedBy: ref('Actor'),
      state: nullable({ type: 'object', description: 'From thresholds evaluated on data. Null unless the deployment wires the state hook.' }),
      deletedAt: time(),
      restorableUntil: time(),
    },
    ['id', 'name', 'intent', 'tags', 'owner', 'panels', 'revision', 'number', 'lastChangedAt', 'lastChangedBy', 'state'],
  ),
  Issue: obj({ path: str('JSON Pointer'), code: str(), message: str(), suggestion: str() }, ['path', 'code', 'message']),
  PatchOp: { type: 'object', description: 'One RFC 6902 operation.', properties: { op: { enum: ['add', 'remove', 'replace', 'move', 'copy', 'test'] }, path: str(), from: str(), value: {} }, required: ['op', 'path'] },
  Change: obj({ name: str('Unique within the proposal; a reviewer accepts changes by name.'), reason: str('Why; shown next to the diff.'), ops: arr(ref('PatchOp')) }, ['name', 'reason', 'ops']),
  WriteResult: obj(
    {
      outcome: { enum: ['applied', 'unchanged', 'proposed'] },
      dashboard: ref('Dashboard'),
      number: { type: 'integer' },
      revision: str(),
      previousRevision: str(),
      summary: arr(str('One line per change, in words.')),
      lint: arr(ref('Issue')),
      dryRun: { type: 'boolean' },
    },
    ['summary'],
  ),
  Revision: obj(
    {
      number: { type: 'integer' },
      revision: str(),
      at: time(),
      by: ref('Actor'),
      message: str(),
      kind: { enum: ['create', 'patch', 'revert', 'apply'] },
      summary: arr(str()),
      proposal: nullable(str()),
      proposedBy: nullable(ref('Actor')),
      revertedTo: nullable({ type: 'integer' }),
      bytes: { type: 'integer' },
      spec: { type: 'object', description: 'viz.dashboard/v1 (only on GET of one revision).' },
    },
    ['number', 'revision', 'at', 'by', 'message', 'kind', 'summary'],
  ),
  Proposal: obj(
    {
      id: str(),
      kind: { enum: ['patch', 'create'], description: 'patch: named changes to an existing dashboard. create: a whole new dashboard, applied whole; baseRevision is "" and baseNumber 0, changes is empty.' },
      dashboard: str('The dashboard changed, or for kind create the id of the dashboard it creates.'),
      status: { enum: ['open', 'applied', 'declined', 'expired'] },
      message: str(),
      by: ref('Actor'),
      editedBy: arr(ref('Actor')),
      createdAt: time(),
      expiresAt: time(),
      baseRevision: str(),
      baseNumber: { type: 'integer' },
      changes: arr({ type: 'object', description: 'A Change; in lists, "ops" is the number of operations.' }),
      resolvedAt: nullable(time()),
      resolvedBy: nullable(ref('Actor')),
      declineReason: nullable(str()),
      appliedNumber: nullable({ type: 'integer' }),
      appliedChanges: nullable(arr(str())),
      spec: { type: 'object', description: 'Kind create, when one proposal is shown: the proposed viz.dashboard/v1 spec.' },
    },
    ['id', 'kind', 'dashboard', 'status', 'message', 'by', 'createdAt', 'expiresAt', 'baseRevision', 'baseNumber', 'changes'],
  ),
  Review: obj(
    {
      kind: { enum: ['create'], description: 'Present for a proposal that creates a dashboard.' },
      current: nullable(obj({ revision: str(), number: { type: 'integer' } })),
      exists: { type: 'boolean', description: 'Kind create: a dashboard (live or deleted) holds the id now, so it cannot be applied.' },
      moved: { type: 'boolean', description: 'The dashboard has changed since the proposal\'s base revision.' },
      needsRebase: { type: 'boolean', description: 'It moved and the changes no longer fit: an op fails, the result is invalid, or a change touches something edited since.' },
      reasons: arr(str()),
      changes: arr(obj({ name: str(), applies: { type: 'boolean' }, error: str(), conflicts: arr(str()), summary: arr(str()) })),
      summary: arr(str('The diff against the CURRENT revision, in words.')),
      result: nullable(obj({ revision: str(), number: { type: 'integer' }, lint: arr(ref('Issue')) })),
      errors: arr(ref('Issue')),
    },
    ['current', 'moved', 'needsRebase', 'summary'],
  ),
  ProposalResult: obj({ outcome: { enum: ['proposed', 'edited', 'unchanged'] }, proposal: ref('Proposal'), review: ref('Review'), dryRun: { type: 'boolean' } }, ['outcome', 'proposal', 'review']),
  Setting: obj(
    {
      section: { enum: ['general', 'retention', 'limits', 'pool', 'notifications'] },
      version: { type: 'integer', description: '0 when never set.' },
      value: nullable({ type: 'object' }),
      effective: nullable({ type: 'object', description: 'What applies: the value, or the default when never set.' }),
      updatedAt: nullable(time()),
      updatedBy: nullable(ref('Actor')),
      publishedTo: nullable(str('The KV key the data path reads, if any.')),
    },
    ['section', 'version', 'value', 'effective'],
  ),
  OAuthScope: { enum: ['read', 'dashboards:read', 'dashboards:write', 'dashboards:apply', 'monitors:read'], description: 'The scopes an OAuth grant may hold (contracts/oauth.ts OAUTH_SCOPES): those the agent surface checks. Never admin, write, monitors:write or monitors:ack.' },
  OAuthGrant: obj(
    {
      id: str(),
      status: { enum: ['live', 'suspended', 'revoked', 'expired'], description: 'suspended: its key is disabled, so the resource refuses its tokens until the key is enabled again.' },
      client: obj({ name: str('The application\'s own name for itself; not verified.'), redirectUris: arr(str()), registeredAt: time() }, ['name', 'redirectUris', 'registeredAt']),
      scopes: arr(ref('OAuthScope')),
      resource: str('The audience: the resource its tokens are for (the MCP endpoint).'),
      approvedBy: ref('Actor'),
      createdAt: time(),
      expiresAt: time('The grant ends then, whatever happens.'),
      lastUsedAt: nullable(time('Last code exchange or refresh.')),
      key: nullable(obj({ id: str(), name: str('oauth:<grantId>') }, ['id', 'name'])),
      revokedAt: nullable(time()),
      revokedBy: nullable(ref('Actor')),
      revokeReason: nullable(str('person, client, code-reuse, refresh-reuse, wrong-client, not-exchanged, idle, approver-gone or expired.')),
    },
    ['id', 'status', 'client', 'scopes', 'resource', 'approvedBy', 'createdAt', 'expiresAt', 'lastUsedAt', 'key', 'revokedAt', 'revokeReason'],
  ),
  AuditEntry: obj(
    {
      id: str(),
      at: time(),
      by: ref('Actor'),
      action: str('e.g. key.create, dashboard.patch, proposal.apply, settings.retention'),
      target: obj({ type: str(), id: str() }),
      before: nullable({}),
      after: nullable({}),
    },
    ['id', 'at', 'by', 'action', 'target'],
  ),
}

interface OpDoc {
  summary: string
  description?: string
  scopes: string[]
  query?: Record<string, string>
  ifMatch?: boolean
  body?: Schema
  ok: [status: number, description: string, schema: Schema]
  errors?: number[]
}

const ANY = ['admin', 'dashboards:read', 'dashboards:write', 'dashboards:apply', 'write', 'read', 'monitors:read', 'monitors:write', 'monitors:ack']
const ADMIN = ['admin']
const D_READ = ['admin', 'dashboards:read', 'dashboards:write', 'dashboards:apply']
const D_WRITE = ['admin', 'dashboards:write', 'dashboards:apply']
const D_APPLY = ['admin', 'dashboards:apply']
const page = (item: Schema, extra: Record<string, Schema> = {}): Schema => obj({ items: arr(item), next: nullable(str('Opaque cursor for the next page; null on the last.')), ...extra }, ['items', 'next'])
const PAGING = { limit: '1 to 200, default 50.', cursor: 'The "next" of the previous page.' }

const operations: Record<string, OpDoc> = {
  'GET /whoami': { summary: 'Who the credential is', description: 'Tenant, subject, kind, name, scopes, and mayApply: whether direct dashboard writes by this caller take effect.', scopes: ANY, ok: [200, 'The caller', ref('Identity')] },

  'GET /keys': { summary: 'List API keys', description: 'Never includes a secret. lastUsedAt and samples24h are null until the data path reports usage.', scopes: ADMIN, query: PAGING, ok: [200, 'Keys, oldest first', page(ref('Key'))] },
  'POST /keys': {
    summary: 'Create an API key',
    description: 'The full key is in this response and nowhere else, ever. Only the SHA-256 of its secret is stored.',
    scopes: ADMIN,
    body: obj({ name: str(), scopes: arr(ref('Scope')), kind: { enum: ['key', 'agent'], description: 'agent: changes made with this key are shown as made by an agent, and it cannot apply its own proposals.' }, expiresAt: time(), dryRun }, ['name', 'scopes']),
    ok: [201, 'Created', ref('KeyWithSecret')],
    errors: [409, 422],
  },
  'GET /keys/{key}': { summary: 'One API key', scopes: ADMIN, ok: [200, 'The key', obj({ key: ref('Key') })], errors: [404] },
  'POST /keys/{key}/disable': { summary: 'Disable a key', description: 'Takes effect on this API at once; on the data path within the bound stated in the README (edge cache plus KV propagation).', scopes: ADMIN, body: obj({ dryRun }), ok: [200, 'Disabled', obj({ key: ref('Key'), kv: ref('KvState') })], errors: [404, 409] },
  'POST /keys/{key}/enable': { summary: 'Enable a key', scopes: ADMIN, body: obj({ dryRun }), ok: [200, 'Enabled', obj({ key: ref('Key'), kv: ref('KvState') })], errors: [404] },
  'POST /keys/{key}/rotate': {
    summary: 'Rotate a key\'s secret',
    description: 'Returns a new full key once. The old secret stays valid for overlapSeconds (0, the default, ends it now).',
    scopes: ADMIN,
    body: obj({ overlapSeconds: { type: 'integer', description: '0, or 60 to 604800.' }, dryRun }),
    ok: [200, 'Rotated', ref('KeyWithSecret')],
    errors: [404, 422],
  },
  'DELETE /keys/{key}': {
    summary: 'Delete a key',
    description: 'Needs the key\'s exact name repeated as confirmation, in the body or as ?confirmName=.',
    scopes: ADMIN,
    query: { confirmName: 'The key\'s exact name.', dryRun: 'true to only report.' },
    body: obj({ confirmName: str(), dryRun }),
    ok: [200, 'Deleted', obj({ deleted: str(), kv: ref('KvState') })],
    errors: [404, 409, 422],
  },

  'GET /dashboards': {
    summary: 'List or search dashboards',
    scopes: D_READ,
    query: { q: 'Matches name, id, intent, owner and tags.', tag: 'Exact tag.', owner: 'Exact owner.', deleted: 'true: only deleted dashboards that can still be restored.', ...PAGING },
    ok: [200, 'Dashboards, by id', page(ref('Dashboard'), { total: { type: 'integer' } })],
  },
  'POST /dashboards': {
    summary: 'Create a dashboard',
    description: 'The spec is validated and linted. Validation errors refuse the write; lint warnings are returned. Writing needs the right to apply; a dry run needs only dashboards:write.',
    scopes: D_WRITE,
    body: obj({ spec: { type: 'object', description: 'viz.dashboard/v1' }, owner: str(), message: str(), dryRun }, ['spec']),
    ok: [201, 'Created', ref('WriteResult')],
    errors: [403, 409, 413, 422],
  },
  'GET /dashboards/{dashboard}': {
    summary: 'Read a dashboard',
    description: 'The ETag is the revision.',
    scopes: D_READ,
    query: { view: 'spec (default), outline, or resolved.', revision: 'A revision number; default the current one.', 'var.{name}': 'With view=resolved: a value for variable {name}; repeat for several.' },
    ok: [200, 'The dashboard', obj({ dashboard: ref('Dashboard'), number: { type: 'integer' }, revision: str(), current: { type: 'boolean' }, view: str(), spec: { type: 'object' }, outline: { type: 'object' }, resolved: { type: 'object' } })],
    errors: [404],
  },
  'PATCH /dashboards/{dashboard}': {
    summary: 'Patch a dashboard, or propose the patch',
    description: 'RFC 6902 ops against baseRevision (or If-Match). A stale base is 409 stale-revision with the current revision and what changed underneath. A caller who may not apply directly (no dashboards:apply, or an agent while agentsMayApply is false), or who sends "propose": true, gets a proposal instead: 202.',
    scopes: D_WRITE,
    ifMatch: true,
    body: obj({ ops: arr(ref('PatchOp')), baseRevision: str(), message: str(), propose: { type: 'boolean' }, dryRun }, ['ops']),
    ok: [200, 'Applied (or unchanged). 202 with a ProposalResult when it became a proposal.', { anyOf: [ref('WriteResult'), ref('ProposalResult')] }],
    errors: [404, 409, 413, 422, 428],
  },
  'DELETE /dashboards/{dashboard}': { summary: 'Delete a dashboard (restorable for 30 days)', scopes: D_APPLY, ifMatch: true, query: { dryRun: 'true to only report.' }, body: obj({ baseRevision: str(), dryRun }), ok: [200, 'Deleted', obj({ deleted: str(), restorableUntil: time() })], errors: [403, 404, 409] },
  'POST /dashboards/{dashboard}/restore': { summary: 'Restore a deleted dashboard', scopes: D_APPLY, body: obj({ dryRun }), ok: [200, 'Restored', obj({ dashboard: ref('Dashboard') })], errors: [403, 404, 409] },
  'PUT /dashboards/{dashboard}/owner': { summary: 'Set a dashboard\'s owner', scopes: D_APPLY, body: obj({ owner: nullable(str()), dryRun }, ['owner']), ok: [200, 'Set', obj({ outcome: str(), dashboard: ref('Dashboard') })], errors: [403, 404, 422] },
  'GET /dashboards/{dashboard}/revisions': { summary: 'List a dashboard\'s revisions', scopes: D_READ, query: PAGING, ok: [200, 'Revisions, newest first', page(ref('Revision'), { current: { type: 'integer' } })], errors: [404] },
  'GET /dashboards/{dashboard}/revisions/{number}': { summary: 'One revision, with its spec', scopes: D_READ, ok: [200, 'The revision', ref('Revision')], errors: [404] },
  'POST /dashboards/{dashboard}/revisions/{number}/revert': {
    summary: 'Revert to a revision',
    description: 'Creates a new revision whose content is that of {number}; history is never rewritten.',
    scopes: D_APPLY,
    ifMatch: true,
    body: obj({ baseRevision: str(), message: str(), dryRun }),
    ok: [200, 'Reverted (or unchanged)', ref('WriteResult')],
    errors: [403, 404, 409, 422, 428],
  },
  'POST /dashboards/{dashboard}/proposals': {
    summary: 'Propose a change',
    description: 'Named changes, each a group of ops with a reason, against baseRevision. Nothing changes until it is applied.',
    scopes: D_WRITE,
    ifMatch: true,
    body: obj({ message: str(), baseRevision: str(), changes: arr(ref('Change')), ops: arr(ref('PatchOp')), reason: str(), dryRun }, ['message']),
    ok: [202, 'Stored', ref('ProposalResult')],
    errors: [404, 409, 413, 422, 428],
  },

  'GET /proposals': { summary: 'List proposals', scopes: D_READ, query: { status: 'open (default), applied, declined, expired or all.', dashboard: 'Only this dashboard (or, for kind create, the id it would create).', ...PAGING }, ok: [200, 'Proposals, newest first', page(ref('Proposal'))] },
  'POST /proposals': {
    summary: 'Propose a new dashboard',
    description: 'A whole viz.dashboard/v1 spec for a person to review and apply. It is validated (422 invalid-dashboard with each error) and its id must be free (409 dashboard-exists or dashboard-deleted). Nothing is created until it is applied, which needs the right to create dashboards directly (see whoami mayApply). The same caller sending the same spec again while its proposal is open gets that proposal back: 200, outcome "unchanged", nothing written.',
    scopes: D_WRITE,
    body: obj({ spec: { type: 'object', description: 'viz.dashboard/v1' }, message: str('Why, for the reviewer.'), dryRun }, ['spec', 'message']),
    ok: [202, 'Stored. 200 with outcome "unchanged" when this caller already has the same proposal open.', ref('ProposalResult')],
    errors: [409, 413, 422],
  },
  'GET /proposals/{proposal}': {
    summary: 'One proposal, reviewed against the current revision',
    description: 'For an open proposal, "review" is recomputed against the dashboard as it is now.',
    scopes: D_READ,
    ok: [200, 'The proposal', obj({ proposal: ref('Proposal'), review: nullable(ref('Review')), dashboard: ref('Dashboard') }, ['proposal', 'review'])],
    errors: [404],
  },
  'PUT /proposals/{proposal}': {
    summary: 'Edit an open proposal',
    description: 'Replaces its changes with ones that apply to the current revision, which also rebases it; for a proposal of kind create, replaces its spec (same id). The proposer, or anyone who may apply.',
    scopes: D_WRITE,
    body: obj({ message: str(), changes: arr(ref('Change')), ops: arr(ref('PatchOp')), reason: str(), spec: { type: 'object', description: 'Kind create only: the whole new spec.' }, dryRun }),
    ok: [200, 'Edited', ref('ProposalResult')],
    errors: [403, 404, 409, 422],
  },
  'POST /proposals/{proposal}/apply': {
    summary: 'Apply a proposal, whole or in part',
    description: 'Creates a normal revision attributed to the caller, with the proposer recorded. "changes" selects a subset by name. Refused with 409 needs-rebase when the dashboard moved and the changes no longer fit, and with 403 self-apply for an agent applying its own proposal unless agentsMayApply is true. A proposal of kind create is applied whole (no "changes", no base revision) and makes revision 1 of the new dashboard; it needs the right to create dashboards directly, so an agent is refused with 403 agents-may-not-apply unless agentsMayApply is true, and 409 dashboard-exists when the id was taken meanwhile. Applying twice is 409 proposal-closed, with appliedNumber.',
    scopes: D_APPLY,
    ifMatch: true,
    body: obj({ changes: arr(str()), message: str(), baseRevision: str('The revision the reviewer looked at; refused if it is no longer current.'), dryRun }),
    ok: [200, 'Applied', ref('WriteResult')],
    errors: [403, 404, 409, 422],
  },
  'POST /proposals/{proposal}/decline': { summary: 'Decline a proposal', description: 'With a reason. The proposer may withdraw their own.', scopes: D_WRITE, body: obj({ reason: str(), dryRun }, ['reason']), ok: [200, 'Declined', obj({ outcome: str(), proposal: ref('Proposal') })], errors: [403, 404, 409, 422] },

  'GET /settings': { summary: 'All settings sections', scopes: ADMIN, ok: [200, 'Sections', obj({ items: arr(ref('Setting')) })] },
  'GET /settings/{section}': { summary: 'One settings section', scopes: ADMIN, ok: [200, 'The section', ref('Setting')], errors: [404] },
  'PUT /settings/{section}': {
    summary: 'Replace a settings section',
    description: 'general: {agentsMayApply, proposalTtlDays}. The value replaces the stored one, and a field left out returns to its default. retention: {metric_samples_days, metric_5m_days, metric_1h_days, log_days, trace_days}; any change that shortens what is kept needs confirmShorter, including a field left out whose default is shorter (log_days and trace_days default to 30 days) and a rollup tier left out. limits: {active_series, samples_per_second, query_max_series, query_max_samples, query_timeout_seconds, query_max_range_days, query_concurrency}. pool: {pool, slots, spread}; the pool is the dedicated pool of the tenant, tenant/<id> with _ written -, or the shared pool, and must be one the data path accepts (no _, at most 120 characters, not ending in /traces or /logs); only a first map or a larger spread is accepted, and the epoch is bumped. notifications: {email, webhookUrl, webhookFormat (alertmanager|json), sendResolved, webhookSecret (write-only: never returned; null removes it; left out it is kept while webhookUrl is unchanged)}; the response shows webhookSecretSetAt instead of the secret. The ruler notifier sends to webhookUrl as its receiver viz:default (contracts/control.ts); email is stored, not acted on.',
    scopes: ADMIN,
    body: obj({ value: { type: 'object' }, version: { type: 'integer', description: 'If sent, the write is refused unless this is the current version.' }, confirmShorter: { type: 'boolean' }, dryRun }, ['value']),
    ok: [200, 'Applied (or unchanged)', { allOf: [ref('Setting'), obj({ outcome: str(), kv: ref('KvState') })] }],
    errors: [404, 409, 422],
  },

  'GET /audit': {
    summary: 'Query the audit log',
    description: 'Every mutation, once: who, when, what, before and after. Append-only; there is no route that changes it.',
    scopes: ADMIN,
    query: { action: 'Exact action.', targetType: 'key, dashboard, proposal, setting or tenant.', targetId: 'Exact id.', subject: 'Exact subject.', kind: 'user, agent, key or system.', since: 'RFC 3339, inclusive.', until: 'RFC 3339, exclusive.', ...PAGING },
    ok: [200, 'Entries, newest first', page(ref('AuditEntry'))],
  },
  'GET /audit/{entry}': { summary: 'One audit entry', scopes: ADMIN, ok: [200, 'The entry', ref('AuditEntry')], errors: [404] },

  'POST /oauth/approve': {
    summary: 'Approve an application\'s OAuth request (the consent step)',
    description:
      'The page at /oauth/authorize shows what an application (an MCP client) asks for and a "request" handle. A person approves it here, with a key of kind "key" holding admin (an agent key is refused with 403 approver-not-a-person). The grant holds the scopes asked for (or the subset in "scopes") that the approving key itself holds; admin counts for the dashboards scopes. The answer\'s "redirect" is the application\'s callback with the code, state and iss: open it in the browser that started the connection, within codeExpiresAt. dryRun: true shows exactly what would be granted and issues no code. Bounds per tenant: 50 clients, 50 live grants, 20 approvals an hour (429), and a key per grant counts against the key cap.',
    scopes: ADMIN,
    body: obj({ request: str('The handle from /oauth/authorize.'), scopes: arr(ref('OAuthScope')), dryRun }, ['request']),
    ok: [
      201,
      'Approved. The redirect is shown in this response only; null in a dry run.',
      obj(
        { outcome: str(), grant: ref('OAuthGrant'), withheld: arr(ref('OAuthScope')), returnsTo: obj({ host: str(), uri: str() }), warnings: arr(str()), redirect: nullable(str('The callback with code, state and iss.')), codeExpiresAt: time(), shownOnce: { type: 'boolean' }, kv: ref('KvState') },
        ['outcome', 'grant', 'withheld', 'returnsTo', 'warnings', 'redirect'],
      ),
    ],
    errors: [403, 409, 422, 429],
  },
  'GET /oauth/grants': { summary: 'List OAuth grants', description: 'What applications may act on this tenant, with which scopes, approved by whom. No credential is ever returned.', scopes: ADMIN, query: { status: 'live (default; includes suspended) or all.', ...PAGING }, ok: [200, 'Grants, oldest first', page(ref('OAuthGrant'))] },
  'GET /oauth/grants/{grant}': { summary: 'One OAuth grant', scopes: ADMIN, ok: [200, 'The grant', obj({ grant: ref('OAuthGrant') }, ['grant'])], errors: [404] },
  'POST /oauth/grants/{grant}/revoke': {
    summary: 'Revoke an OAuth grant',
    description: 'Ends it now: its tokens and code are deleted and its key removed (from KV too). The resource refuses its tokens from the next request. Revoking an ended grant changes nothing (outcome "unchanged").',
    scopes: ADMIN,
    body: obj({ dryRun }),
    ok: [200, 'Revoked, or unchanged', obj({ outcome: str(), grant: ref('OAuthGrant'), kv: ref('KvState') }, ['outcome', 'grant'])],
    errors: [404],
  },
}

const problem = (description: string): Json => ({ description, content: { 'application/problem+json': { schema: ref('Problem') } } })
const ERRORS: Record<number, string> = {
  400: 'Malformed request (bad JSON, cursor, limit, If-Match), or a tenant was named in the request',
  401: 'Missing, unknown, disabled or expired credential',
  403: 'The credential lacks the scope, or the action is not allowed for this identity',
  404: 'No such resource in the caller\'s tenant',
  409: 'Conflict: stale revision or version, needs rebase, closed proposal, or a limit reached',
  413: 'Too large',
  422: 'Not valid: the body, the dashboard or the setting',
  428: 'baseRevision or If-Match is required',
  429: 'Too many approvals in the last hour; retry after Retry-After seconds',
  503: 'The tenant is held by a newer release during a deployment or rollback (code schema-too-new); nothing was changed. Retry after Retry-After seconds',
}

export function buildOpenApi(): Json {
  const paths: Record<string, Record<string, Json>> = {}
  for (const [key, doc] of Object.entries(operations)) {
    const [method, path] = key.split(' ') as [string, string]
    const parameters: Json[] = []
    for (const m of path.matchAll(/\{([a-z]+)\}/g)) parameters.push({ name: m[1]!, in: 'path', required: true, schema: { type: 'string' } })
    for (const [name, description] of Object.entries(doc.query ?? {})) parameters.push({ name, in: 'query', required: false, description, schema: { type: 'string' } })
    if (doc.ifMatch) parameters.push({ name: 'If-Match', in: 'header', required: false, description: 'The revision (ETag) this write is based on; an alternative to baseRevision.', schema: { type: 'string' } })
    const responses: Record<string, Json> = { [String(doc.ok[0])]: { description: doc.ok[1], content: { 'application/json': { schema: doc.ok[2] } } } }
    for (const status of [...new Set([400, 401, 403, 503, ...(doc.errors ?? [])])].sort()) responses[String(status)] = problem(ERRORS[status]!)
    ;(paths[`/api/v1/control${path}`] ??= {})[method.toLowerCase()] = {
      operationId: key.replace(/[^A-Za-z0-9]+/g, '_').replace(/_$/, ''),
      summary: doc.summary,
      ...(doc.description ? { description: doc.description } : {}),
      security: [{ apiKey: doc.scopes }],
      'x-scopes': doc.scopes,
      ...(parameters.length ? { parameters } : {}),
      ...(doc.body ? { requestBody: { required: (doc.body.required as Json[] | undefined)?.length ? true : false, content: { 'application/json': { schema: doc.body } } } } : {}),
      responses,
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'viz tenant control plane',
      version: '1.0.0',
      description:
        'Keys, dashboards and their revisions, proposed changes, settings and the audit log of one tenant. The tenant is always the one the credential belongs to: no path, query or body takes a tenant, and a request that names one is refused. Errors are problem details with a "code" and a "fix". Every write accepts "dryRun": true. Lists page with an opaque "next" cursor.',
    },
    servers: [{ url: 'https://vis.bitcru.sh' }],
    paths,
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer viz_<keyId>_<secret>. The scopes listed per operation are alternatives: any one is enough.' } },
      schemas,
    },
  }
}
