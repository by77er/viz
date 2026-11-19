// Rollback floors that a writer's switch raises (design/DECISIONS.md D69; D64's rollout rule;
// contracts/COMPATIBILITY.md §3.3, §6). deploy/workers.json `rollback_floors`:
//
//   { "name": "signal-tables", "writer": "viz-ingest", "var": "INGEST_SIGNALS",
//     "reader": "viz-publisher", "schema": "publisher.Publisher", "at_least": 4, "why": "…" }
//
// reads: once a version of `writer` whose `var` names anything has existed, the ledger's log may
// hold changes only a `reader` at or above the floor can read, so no `reader` below it may serve
// again. The floor is the reader's storage schema version (`schema` ≥ `at_least`): every version
// since D46 carries it in VIZ_SCHEMAS and every record in `schemas`, so versions and records from
// before this check are judged with no new data. For the publisher, migration 4 shipped with D64's
// reader of the span and log tables, and every later publisher (D67's migration 5 included) reads
// them (pinned against the frozen releases in publisher/test/: deploy/test/configure.test.mjs).
//
// What is refused (release.mjs; deploy/README.md, "Rollback floors"):
// - a release whose `writer` sets `var`, unless this release's `reader` and the one serving now
//   (what an automatic rollback, or phase 2's restore after a failed promotion, puts back without
//   asking) are at or above the floor. Any older release is reached only through `release.mjs
//   rollback`, which refuses it from the moment that writer version is uploaded (below);
// - a release whose `reader` is below the floor while any version of `writer` Cloudflare keeps
//   sets `var` (redeploying older code: turning the flag off does not unstick the log, D64 step 3);
// - a rollback (of the whole release, or of any subset of Workers its record names) that would
//   leave a `reader` below the floor serving while any version of `writer` Cloudflare keeps sets
//   `var`, the restored one and the serving one included.
import { stagedName } from './common.mjs'
import { schemasOfVersion } from './schemas.mjs'

const RULE_KEYS = new Set(['$comment', 'name', 'writer', 'var', 'reader', 'schema', 'at_least', 'why'])

/** The rules of deploy/workers.json `rollback_floors`, checked, with the deployed (staged) Worker names. */
export function floorRules(plan, stage) {
  const rules = plan.rollback_floors ?? []
  if (!Array.isArray(rules)) throw new Error('deploy/workers.json rollback_floors: a list of rules')
  return rules.map((r, i) => {
    const where = `deploy/workers.json rollback_floors[${i}]`
    if (typeof r !== 'object' || r === null) throw new Error(`${where}: a rule object`)
    for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) throw new Error(`${where}: "${k}" is not a rule field`)
    for (const k of ['name', 'writer', 'var', 'reader', 'schema', 'why']) if (typeof r[k] !== 'string' || r[k] === '') throw new Error(`${where}: "${k}" must be a non-empty string`)
    if (!/^[A-Z][A-Z0-9_]*$/.test(r.var)) throw new Error(`${where}: var ${r.var} is not a variable name`)
    if (!Number.isInteger(r.at_least) || r.at_least < 2) throw new Error(`${where}: at_least must be a schema version from 2 (every reader knows 1)`)
    for (const k of ['writer', 'reader']) if (!plan.workers.some((w) => w.name === r[k])) throw new Error(`${where}: ${k} ${r[k]} is not a Worker in deploy/workers.json`)
    const reader = plan.workers.find((w) => w.name === r.reader)
    if (!Object.keys(reader.schemas ?? {}).length) throw new Error(`${where}: reader ${r.reader} declares no schemas, so its floor cannot be read`)
    return { name: r.name, writer: stagedName(r.writer, stage), var: r.var, reader: stagedName(r.reader, stage), schema: r.schema, atLeast: r.at_least, why: r.why }
  })
}

/**
 * What a value of the switch names: comma-separated, trimmed, non-empty. Any name counts, also one
 * the writer does not know today (`INGEST_SIGNALS=metrics2`): the check fails closed.
 */
export const namesIn = (value) => String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean)

const plainVar = (version, name) => (version?.resources?.bindings ?? version?.bindings ?? []).find((b) => b?.type === 'plain_text' && b.name === name)?.text ?? null
const annotation = (v, key) => v?.annotations?.[key] ?? v?.metadata?.annotations?.[key] ?? null
const at = (n) => (n === null || n === undefined ? 'no schema version (it declares none, or more than one version serves)' : `schema ${n}`)

/**
 * The newest version of the rule's writer that Cloudflare keeps and whose var names anything, or
 * null: `{ versionId, number, release, value }`. One list call, and one read per version until
 * one is found (at most the 100 Cloudflare keeps). `api`: { listVersions, versionInfo }.
 */
export async function switchSeen(rule, api) {
  for (const v of await api.listVersions(rule.writer)) {
    const info = await api.versionInfo(rule.writer, v.id)
    const value = plainVar(info, rule.var)
    if (namesIn(value).length > 0) return { versionId: v.id, number: v.number ?? info?.number ?? null, release: annotation(info, 'workers/tag'), value }
  }
  return null
}

/**
 * Deploy-time problems of one rule. Pure. `s`: { value (the writer's var in this release, or
 * null), readerNew (this release's reader schema version, or null), readerExists, readerServing
 * (the serving reader's, or null), seen (switchSeen's answer, or undefined when not looked up) }.
 */
export function deployFloorProblems(rule, s) {
  const problems = []
  const named = namesIn(s.value)
  const below = (n) => !(Number.isInteger(n) && n >= rule.atLeast)
  if (named.length > 0) {
    if (below(s.readerNew)) {
      problems.push(`${rule.writer}: this release sets ${rule.var}=${s.value}, and its own ${rule.reader} is at ${at(s.readerNew)} of ${rule.schema}, below ${rule.atLeast}, the first that can read what that switch makes ${rule.writer} write (${rule.name}: ${rule.why}). Release a ${rule.reader} at ${rule.atLeast} or later without the switch first.`)
    }
    if (s.readerExists && below(s.readerServing)) {
      problems.push(`${rule.writer}: this release sets ${rule.var}=${s.value}, and the ${rule.reader} serving now is at ${at(s.readerServing)} of ${rule.schema}, below ${rule.atLeast}. That is what an automatic rollback of this release would put back, under a log ${rule.reader} could no longer read (${rule.name}: ${rule.why}). Deploy ${rule.reader} at ${rule.atLeast} or later without the switch first, let it serve, then set ${rule.var} (design/DECISIONS.md D64, D69).`)
    }
  } else if (below(s.readerNew) && s.seen) {
    problems.push(`${rule.reader}: this release is at ${at(s.readerNew)} of ${rule.schema}, below ${rule.atLeast}, and ${rule.writer} version ${s.seen.versionId} (release ${s.seen.release ?? 'unknown'}) set ${rule.var}=${s.seen.value}: what it wrote stays in the log whatever the switch says now, and a ${rule.reader} below ${rule.atLeast} cannot read it (${rule.name}: ${rule.why}). Deploy a ${rule.reader} at ${rule.atLeast} or later.`)
  }
  return problems
}

/**
 * Rollback problems of one rule. Pure. `s`: { readerVersionId, readerRelease, readerAt (the
 * schema version of the reader the rollback would leave serving, or null), restored (whether the
 * rollback restores the reader or leaves the serving one), seen (switchSeen's answer) }.
 */
export function rollbackFloorProblems(rule, s) {
  if (Number.isInteger(s.readerAt) && s.readerAt >= rule.atLeast) return []
  if (!s.seen) return []
  return [
    `${rule.reader}: this rollback would ${s.restored ? 'restore' : 'leave serving'} version ${s.readerVersionId ?? '(unknown)'} (release ${s.readerRelease ?? 'unknown'}), at ${at(s.readerAt)} of ${rule.schema}, below ${rule.atLeast}, ` +
      `and ${rule.writer} version ${s.seen.versionId} (release ${s.seen.release ?? 'unknown'}) set ${rule.var}=${s.seen.value}: the log may already hold what only a ${rule.reader} at ${rule.atLeast} or later can read (${rule.name}: ${rule.why}). ` +
      `Roll back to a release whose ${rule.reader} is at ${rule.atLeast} or later, or fix forward.`,
  ]
}

/**
 * Every rule's deploy-time problems for a manifest against what serves now. `varsOf(worker)` gives
 * a manifest Worker's generated vars. The writer's history is read only when this release's reader
 * is below the floor (never, normally). Returns { problems, seen: [per rule, for the record] }.
 */
export async function floorDeployProblems(rules, manifest, live, api, varsOf) {
  const problems = []
  const seen = []
  for (const rule of rules) {
    if (!manifest.order.includes(rule.reader)) {
      seen.push({ name: rule.name, applies: false, why: `${rule.reader} is not deployed here` })
      continue
    }
    const reader = manifest.workers.find((w) => w.name === rule.reader)
    const value = manifest.order.includes(rule.writer) ? (varsOf(manifest.workers.find((w) => w.name === rule.writer))?.[rule.var] ?? null) : null
    const readerNew = (reader.schemas ?? []).find((s) => s.component === rule.schema)?.latest ?? null
    const readerLive = live[rule.reader]
    const s = { value, readerNew, readerExists: Boolean(readerLive?.exists), readerServing: readerLive?.schemas?.[rule.schema]?.latest ?? null }
    if (namesIn(value).length === 0 && !(Number.isInteger(readerNew) && readerNew >= rule.atLeast)) s.seen = await switchSeen(rule, api)
    problems.push(...deployFloorProblems(rule, s))
    seen.push({ name: rule.name, applies: true, writer: rule.writer, var: rule.var, value, on: namesIn(value).length > 0, reader: rule.reader, schema: rule.schema, atLeast: rule.atLeast, readerAt: readerNew, readerServing: s.readerServing })
  }
  return { problems, seen }
}

/**
 * Every rule's problems for a rollback to `target` (a release record), with `now` the live state
 * of the Workers. A Worker the record does not name keeps the version serving now.
 */
export async function floorRollbackProblems(rules, target, now, api) {
  const problems = []
  for (const rule of rules) {
    const restored = target.workers.find((w) => w.name === rule.reader)
    let s
    if (restored) {
      const info = restored.versionId ? await api.versionInfo(rule.reader, restored.versionId) : null
      const fromRecord = target.schemas?.[rule.schema]?.worker === rule.reader ? target.schemas[rule.schema].latest : null
      s = { readerVersionId: restored.versionId, readerRelease: annotation(info, 'workers/tag') ?? restored.release ?? target.release, readerAt: schemasOfVersion(info)?.[rule.schema]?.latest ?? fromRecord ?? null, restored: true }
    } else {
      const live = now[rule.reader]
      if (!live?.exists) continue // no reader in this deployment
      s = { readerVersionId: live.versions?.length === 1 ? live.versions[0].version_id : null, readerRelease: live.release, readerAt: live.schemas?.[rule.schema]?.latest ?? null, restored: false }
    }
    if (Number.isInteger(s.readerAt) && s.readerAt >= rule.atLeast) continue
    s.seen = await switchSeen(rule, api)
    problems.push(...rollbackFloorProblems(rule, s))
  }
  return problems
}
