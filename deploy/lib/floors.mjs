// Rollback floors that a writer's switch raises (design/DECISIONS.md D69; D64's rollout rule, widened
// by the review of traces and logs, M-4; contracts/COMPATIBILITY.md §3.3, §6). In
// deploy/workers.json `rollback_floors`:
//
//   { "name": "signal-data", "writer": "viz-ingest", "var": "INGEST_SIGNALS", "why": "…",
//     "floors": {
//       "viz-publisher": { "schema": "publisher.Publisher", "at_least": 4, "why": "D64 …" },
//       "viz-query":     { "evidence": ["query/src/shards.ts#checkSignal"], "why": "D62 …" },
//       "viz-ingest":    { "evidence": ["janitor/src/janitor.ts#DEFAULT_SIGNAL_DAYS"], "why": "D63 …" } } }
//
// reads: once a version of `writer` whose `var` names anything has existed, the deployment may hold
// data that only code at or above each listed Worker's floor can handle, so none of them may serve
// below its floor again. Whether a version is at or above its floor:
//
// - `schema` + `at_least`: its storage schema version (VIZ_SCHEMAS, D46), which every version since
//   D46 carries and every record names, so versions and records from before this check are judged
//   with no new data. The publisher's migration 4 shipped with D64's reader of the span and log
//   tables; every later publisher (D67's migration 5 included, additive) reads them. Pinned against
//   the frozen releases in publisher/test/ (deploy/test/configure.test.mjs).
// - `evidence`: the Worker has no schema that marks the floor (viz-query keeps no storage; D63
//   changed no schema of viz-ingest's). configure.mjs checks that each named export exists in the
//   source being deployed and then stamps every version of the Worker with `VIZ_FLOORS` naming the
//   rule; a version without the stamp (from before this check, or from a commit that does not
//   declare the floor) is below it. Fail closed: the cost is that a release with this check must
//   have served before the switch can go on.
//
// What is refused (release.mjs; deploy/README.md, "Rollback floors"):
// - a release whose `writer` sets `var`, unless every listed Worker, in this release and as it
//   serves now (what an automatic rollback, or phase 2's restore after a failed promotion, puts
//   back without asking), is at or above its floor. Any older release is reached only through
//   `release.mjs rollback`, which refuses it from the moment that writer version is uploaded;
// - a release in which a listed Worker is below its floor while any version of `writer` that
//   Cloudflare keeps sets `var` (redeploying older code: turning the switch off leaves the data);
// - a rollback, of the whole release or of any Workers its record names (the others keep what
//   serves), that would leave a listed Worker below its floor while any kept version of `writer`
//   sets `var`, the restored and the serving ones included.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, stagedName } from './common.mjs'
import { parseSource, schemasOfVersion } from './schemas.mjs'

export const FLOORS_VAR = 'VIZ_FLOORS'
export const FLOORS_VAR_VERSION = 1
const RULE_KEYS = new Set(['$comment', 'name', 'writer', 'var', 'why', 'floors'])
const FLOOR_KEYS = new Set(['$comment', 'schema', 'at_least', 'evidence', 'why'])

/**
 * The rules of deploy/workers.json `rollback_floors`, checked, with the deployed (staged) Worker
 * names: `[{ name, writer, var, why, floors: [{ worker, canonical, schema?, atLeast?, evidence?, why }] }]`.
 */
export function floorRules(plan, stage) {
  const rules = plan.rollback_floors ?? []
  if (!Array.isArray(rules)) throw new Error('deploy/workers.json rollback_floors: a list of rules')
  const names = new Set()
  return rules.map((r, i) => {
    const where = `deploy/workers.json rollback_floors[${i}]`
    if (typeof r !== 'object' || r === null) throw new Error(`${where}: a rule object`)
    for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) throw new Error(`${where}: "${k}" is not a rule field`)
    for (const k of ['name', 'writer', 'var', 'why']) if (typeof r[k] !== 'string' || r[k] === '') throw new Error(`${where}: "${k}" must be a non-empty string`)
    if (!/^[a-z][a-z0-9-]*$/.test(r.name) || names.has(r.name)) throw new Error(`${where}: name ${r.name} must be a unique lower-case word`)
    names.add(r.name)
    if (!/^[A-Z][A-Z0-9_]*$/.test(r.var)) throw new Error(`${where}: var ${r.var} is not a variable name`)
    if (!plan.workers.some((w) => w.name === r.writer)) throw new Error(`${where}: writer ${r.writer} is not a Worker in deploy/workers.json`)
    if (typeof r.floors !== 'object' || r.floors === null || Object.keys(r.floors).length === 0) throw new Error(`${where}: floors names at least one Worker`)
    const floors = Object.entries(r.floors).map(([worker, f]) => {
      const at = `${where}.floors.${worker}`
      const w = plan.workers.find((x) => x.name === worker)
      if (!w) throw new Error(`${at}: not a Worker in deploy/workers.json`)
      for (const k of Object.keys(f ?? {})) if (!FLOOR_KEYS.has(k)) throw new Error(`${at}: "${k}" is not a floor field`)
      if (typeof f.why !== 'string' || f.why === '') throw new Error(`${at}: "why" must say what an older version does with the data`)
      if ((f.schema === undefined) === (f.evidence === undefined)) throw new Error(`${at}: a floor is either a schema version ("schema", "at_least") or "evidence"`)
      if (f.schema !== undefined) {
        if (typeof f.schema !== 'string' || !Number.isInteger(f.at_least) || f.at_least < 2) throw new Error(`${at}: "schema" names a SchemaSpec component and "at_least" a version from 2 (every reader knows 1)`)
        if (!Object.keys(w.schemas ?? {}).length) throw new Error(`${at}: ${worker} declares no schemas`)
        return { worker: stagedName(worker, stage), canonical: worker, schema: f.schema, atLeast: f.at_least, why: f.why }
      }
      if (!Array.isArray(f.evidence) || f.evidence.length === 0) throw new Error(`${at}: "evidence" lists exports ("<path>.ts#<EXPORT>") the code at the floor has`)
      return { worker: stagedName(worker, stage), canonical: worker, evidence: f.evidence.map((e) => parseSource(e, `${at}.evidence`)), why: f.why }
    })
    return { name: r.name, writer: stagedName(r.writer, stage), var: r.var, why: r.why, floors }
  })
}

/**
 * For configure.mjs: the rules a Worker's code is stamped at or above (its evidence floors), after
 * checking that every export named as evidence exists. `exportedNames(file)` is configure.mjs's
 * reader of a module's exports. Throws on missing evidence: a declaration that the code does not
 * bear out is fixed, not deployed.
 */
export function stampedFloors(rules, canonical, exportedNames) {
  const out = []
  for (const rule of rules) {
    const f = rule.floors.find((x) => x.canonical === canonical && x.evidence)
    if (!f) continue
    for (const e of f.evidence) {
      const file = join(REPO_ROOT, e.module)
      if (!existsSync(file) || !exportedNames(file).has(e.name)) {
        throw new Error(`deploy/workers.json rollback_floors ${rule.name}: ${canonical} is declared at or above its floor on the evidence of ${e.module}#${e.name}, which ${existsSync(file) ? 'does not export it' : 'does not exist'}. Fix the declaration, or the code`)
      }
    }
    out.push(rule.name)
  }
  return out
}

/** The var a version carries when its code is at or above evidence floors: `VIZ_FLOORS`. */
export const floorsVar = (names) => JSON.stringify({ v: FLOORS_VAR_VERSION, at: [...names].sort() })

/** `VIZ_FLOORS` of a version as Cloudflare returns it: the rule names, or null (none, or unreadable: below every evidence floor). */
export function floorsOfVersion(version) {
  const b = (version?.resources?.bindings ?? version?.bindings ?? []).find((x) => x?.name === FLOORS_VAR && x.type === 'plain_text')
  if (!b) return null
  try {
    const v = JSON.parse(b.text)
    return v?.v === FLOORS_VAR_VERSION && Array.isArray(v.at) && v.at.every((x) => typeof x === 'string') ? v.at : null
  } catch {
    return null
  }
}

/**
 * What a value of the switch names: comma-separated, trimmed, non-empty. Any name counts, also one
 * the writer does not know today (`INGEST_SIGNALS=metrics2`): the check fails closed.
 */
export const namesIn = (value) => String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean)

const plainVar = (version, name) => (version?.resources?.bindings ?? version?.bindings ?? []).find((b) => b?.type === 'plain_text' && b.name === name)?.text ?? null
const annotation = (v, key) => v?.annotations?.[key] ?? v?.metadata?.annotations?.[key] ?? null

/**
 * Whether code is at or above one Worker's floor of a rule. `code`: { schemas: { component:
 * { latest } } | null, floors: [rule names] | null } (from a version's vars, or a manifest Worker).
 */
export function atFloor(rule, floor, code) {
  if (floor.schema !== undefined) {
    const n = code?.schemas?.[floor.schema]?.latest
    return Number.isInteger(n) && n >= floor.atLeast
  }
  return Array.isArray(code?.floors) && code.floors.includes(rule.name)
}

/** How a Worker's code stands against its floor, for messages. */
export function describeFloor(rule, floor, code) {
  if (floor.schema !== undefined) {
    const n = code?.schemas?.[floor.schema]?.latest
    return `${floor.schema} ${Number.isInteger(n) ? `schema ${n}` : 'with no schema version (it declares none, or more than one version serves)'}, floor ${floor.atLeast}`
  }
  return `${atFloor(rule, floor, code) ? 'stamped' : `not stamped (no ${FLOORS_VAR} naming ${rule.name}: from before this check, or from code that does not declare the floor)`} at the floor of ${rule.name}`
}

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
 * null), workers: [{ floor, now (code of this release), serving (code serving now, or null when
 * the Worker does not exist yet) }], seen (switchSeen's answer, or undefined when not looked up) }.
 */
export function deployFloorProblems(rule, s) {
  const problems = []
  const label = `${rule.name}: ${rule.why}`
  if (namesIn(s.value).length > 0) {
    for (const w of s.workers) {
      if (!atFloor(rule, w.floor, w.now)) {
        problems.push(`${rule.writer}: this release sets ${rule.var}=${s.value}, and its own ${w.floor.worker} is below its floor (${describeFloor(rule, w.floor, w.now)}; ${w.floor.why}) (${label}). Release ${w.floor.worker} at or above it without the switch first.`)
      }
      if (w.serving && !atFloor(rule, w.floor, w.serving)) {
        problems.push(`${rule.writer}: this release sets ${rule.var}=${s.value}, and the ${w.floor.worker} serving now is below its floor (${describeFloor(rule, w.floor, w.serving)}; ${w.floor.why}). That is what an automatic rollback of this release would put back. Deploy ${w.floor.worker} at or above its floor without the switch first, let it serve, then set ${rule.var} (design/DECISIONS.md D64, D69).`)
      }
    }
  } else if (s.seen) {
    for (const w of s.workers) {
      if (atFloor(rule, w.floor, w.now)) continue
      problems.push(`${w.floor.worker}: this release is below its floor (${describeFloor(rule, w.floor, w.now)}; ${w.floor.why}), and ${rule.writer} version ${s.seen.versionId} (release ${s.seen.release ?? 'unknown'}) set ${rule.var}=${s.seen.value}: what it let in stays whatever the switch says now (${label}). Deploy ${w.floor.worker} at or above its floor.`)
    }
  }
  return problems
}

/**
 * Rollback problems of one rule. Pure. `s`: { workers: [{ floor, code, versionId, release,
 * restored }] (what the rollback would leave serving), seen (switchSeen's answer) }.
 */
export function rollbackFloorProblems(rule, s) {
  if (!s.seen) return []
  return s.workers
    .filter((w) => !atFloor(rule, w.floor, w.code))
    .map(
      (w) =>
        `${w.floor.worker}: this rollback would ${w.restored ? 'restore' : 'leave serving'} version ${w.versionId ?? '(unknown)'} (release ${w.release ?? 'unknown'}), below its floor (${describeFloor(rule, w.floor, w.code)}; ${w.floor.why}), ` +
        `and ${rule.writer} version ${s.seen.versionId} (release ${s.seen.release ?? 'unknown'}) set ${rule.var}=${s.seen.value}: the data it let in may already be there (${rule.name}: ${rule.why}). ` +
        `Roll back to a release whose ${w.floor.worker} is at or above its floor, or fix forward.`,
    )
}

/** A manifest Worker's code, as atFloor reads it. */
const codeOfManifest = (w) => ({ schemas: Object.fromEntries((w.schemas ?? []).map((s) => [s.component, { latest: s.latest }])), floors: w.floors ?? [] })

/**
 * Every rule's deploy-time problems for a manifest against what serves now (`live`, with each
 * Worker's `schemas` and `floors`). `varsOf(worker)` gives a manifest Worker's generated vars. The
 * writer's history is read only when the switch is off here and a Worker of this release is below
 * its floor (never, normally). Returns { problems, seen: [per rule, for the record] }.
 */
export async function floorDeployProblems(rules, manifest, live, api, varsOf) {
  const problems = []
  const seen = []
  for (const rule of rules) {
    const workers = rule.floors
      .filter((f) => manifest.order.includes(f.worker))
      .map((floor) => {
        const now = manifest.workers.find((w) => w.name === floor.worker)
        const l = live[floor.worker]
        return { floor, now: codeOfManifest(now), serving: l?.exists ? { schemas: l.schemas, floors: l.floors } : null }
      })
    const value = manifest.order.includes(rule.writer) ? (varsOf(manifest.workers.find((w) => w.name === rule.writer))?.[rule.var] ?? null) : null
    const s = { value, workers }
    if (namesIn(value).length === 0 && workers.some((w) => !atFloor(rule, w.floor, w.now))) s.seen = await switchSeen(rule, api)
    problems.push(...deployFloorProblems(rule, s))
    seen.push({
      name: rule.name,
      writer: rule.writer,
      var: rule.var,
      value,
      on: namesIn(value).length > 0,
      workers: workers.map((w) => ({ worker: w.floor.worker, atFloor: atFloor(rule, w.floor, w.now), servingAtFloor: w.serving ? atFloor(rule, w.floor, w.serving) : null })),
    })
  }
  return { problems, seen }
}

/**
 * Every rule's problems for a rollback to `target` (a release record), with `now` the live state
 * of every Worker a rule names. A Worker the record does not name keeps the version serving now.
 */
export async function floorRollbackProblems(rules, target, now, api) {
  const problems = []
  for (const rule of rules) {
    const workers = []
    for (const floor of rule.floors) {
      const restored = target.workers.find((w) => w.name === floor.worker)
      if (restored) {
        const info = restored.versionId ? await api.versionInfo(floor.worker, restored.versionId) : null
        const fromRecord = floor.schema !== undefined && target.schemas?.[floor.schema]?.worker === floor.worker ? { [floor.schema]: target.schemas[floor.schema] } : null
        workers.push({ floor, code: { schemas: schemasOfVersion(info) ?? fromRecord, floors: floorsOfVersion(info) }, versionId: restored.versionId, release: annotation(info, 'workers/tag') ?? restored.release ?? target.release, restored: true })
      } else {
        const l = now[floor.worker]
        if (!l?.exists) continue // not in this deployment
        workers.push({ floor, code: { schemas: l.schemas, floors: l.floors }, versionId: l.versions?.length === 1 ? l.versions[0].version_id : null, release: l.release, restored: false })
      }
    }
    if (workers.every((w) => atFloor(rule, w.floor, w.code))) continue
    problems.push(...rollbackFloorProblems(rule, { workers, seen: await switchSeen(rule, api) }))
  }
  return problems
}
