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
// below its floor again. "Has existed" is read from the versions Cloudflare keeps (the 100 newest):
// a switch-on version that ages out of them is no longer seen (deploy/README.md, Known risks; review
// of D69, m-1). The switch is seen as a binding of any type with that name: a plain or JSON var,
// and a secret, whose value cannot be read (on) (review of D69, m-2). Whether a version is at or
// above its floor:
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
//   back without asking), is at or above its floor; a listed Worker this release does not deploy
//   is judged as it serves (review of D69, m-3). Any older release is reached only through
//   `release.mjs rollback`, which refuses it from the moment that writer version is uploaded;
// - a release in which one of its own listed Workers is below its floor while any version of
//   `writer` that Cloudflare keeps sets `var` (redeploying older code: turning the switch off leaves
//   the data);
// - a release while the writer's serving or newest version carries `var` as a secret: every upload
//   inherits the newest version's secrets, so the switch would be on whatever the release's config
//   says, and no secret's value can be read (review of D69, m-2);
// - a rollback, of the whole release or of any Workers its record names (the others keep what
//   serves), that would leave a listed Worker below its floor while any kept version of `writer`
//   sets `var`, the restored and the serving ones included.
//
// A rule may say `"serving_below_floor": "forward-only"` (D69 point 6; the `oauth-public` rule, whose
// switch OAUTH_PUBLIC configure sets on every production viz-control): then a release that sets the
// switch while a floor Worker it deploys serves below its floor is not refused but marked
// FORWARD-ONLY for that Worker (kind `floor`): no automatic rollback, no phase-2 restore of it, and a
// rollback to it refused once this release's writer version exists. Without it ("refuse", the
// default, `signal-data`) such a release is refused, and the remedy is a release at the floor without
// the switch, which a switch set on every release cannot have.
//
// Never rename a rule: every version stamped at the old name would read as below the floor of the
// new one (deploy/README.md, Known risks). Add a rule instead.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, stagedName } from './common.mjs'
import { parseSource, schemasOfVersion } from './schemas.mjs'

export const FLOORS_VAR = 'VIZ_FLOORS'
export const FLOORS_VAR_VERSION = 1
const RULE_KEYS = new Set(['$comment', 'name', 'writer', 'var', 'why', 'floors', 'serving_below_floor'])
/** What a release that sets the switch does about a floor Worker serving below its floor: refuse (D69), or go out forward-only for it (D69 point 6). */
const SERVING_BELOW = new Set(['refuse', 'forward-only'])
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
    const servingBelow = r.serving_below_floor ?? 'refuse'
    if (!SERVING_BELOW.has(servingBelow)) throw new Error(`${where}: serving_below_floor is "refuse" (the default) or "forward-only", not ${JSON.stringify(r.serving_below_floor)}`)
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
    return { name: r.name, writer: stagedName(r.writer, stage), var: r.var, why: r.why, servingBelow, floors }
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
 * What a value of the switch names: comma-separated, trimmed, non-empty (a JSON var's list joined;
 * any other JSON value counts as a name). Any name counts, also one the writer does not know today
 * (`INGEST_SIGNALS=metrics2`): the check fails closed.
 */
export const namesIn = (value) => (Array.isArray(value) ? value.join(',') : value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).split(',').map((x) => x.trim()).filter(Boolean)

const annotation = (v, key) => v?.annotations?.[key] ?? v?.metadata?.annotations?.[key] ?? null
const bindingsOf = (version) => version?.resources?.bindings ?? version?.bindings ?? []
const SECRET_TYPES = new Set(['secret_text', 'secret_key'])

/**
 * What a version's binding named `name` says of a switch, or null when it has none: a plain var's
 * text; a JSON var's value as text (a list joined with commas); a secret, whose value the API never
 * shows, as on (`(a secret)`); any other binding of that name as on too (review of D69, m-2).
 */
export function switchValue(version, name) {
  const b = bindingsOf(version).find((x) => x?.name === name)
  if (!b) return null
  if (b.type === 'plain_text') return b.text ?? null
  if (b.type === 'json') return Array.isArray(b.json) ? b.json.join(',') : typeof b.json === 'string' ? b.json : b.json === null || b.json === undefined ? null : JSON.stringify(b.json)
  return SECRET_TYPES.has(b.type) ? '(a secret)' : `(a ${b.type ?? 'binding'} binding)`
}

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
    const value = switchValue(info, rule.var)
    if (namesIn(value).length > 0) return { versionId: v.id, number: v.number ?? info?.number ?? null, release: annotation(info, 'workers/tag'), value }
  }
  return null
}

/**
 * Deploy-time problems of one rule. Pure. `s`: { value (the writer's var in this release, or
 * null), workers: [{ floor, now (code of this release, or null when this release does not deploy
 * the Worker), serving (code serving now, or null when the Worker does not exist yet) }], seen
 * (switchSeen's answer, or undefined when not looked up), secret (a version of the writer that
 * carries the switch as a secret: { versionId, which }, or null) }.
 */
export function deployFloorProblems(rule, s) {
  const problems = []
  const label = `${rule.name}: ${rule.why}`
  if (s.secret) {
    problems.push(
      `${rule.writer}: ${rule.var} is a secret on its ${s.secret.which} version ${s.secret.versionId}. Every upload inherits the newest version's secrets, so the switch would be on in this release whatever its config says, and a secret's value cannot be read to judge it (review of D69, m-2). ` +
        `Remove the secret (wrangler versions secret delete ${rule.var} --name ${rule.writer}, then deploy again), and set ${rule.var} as a var in a release.`,
    )
  }
  if (namesIn(s.value).length > 0) {
    for (const w of s.workers) {
      if (w.now && !atFloor(rule, w.floor, w.now)) {
        problems.push(`${rule.writer}: this release sets ${rule.var}=${s.value}, and its own ${w.floor.worker} is below its floor (${describeFloor(rule, w.floor, w.now)}; ${w.floor.why}) (${label}). Release ${w.floor.worker} at or above it without the switch first.`)
      }
      if (w.serving && !atFloor(rule, w.floor, w.serving) && !(w.now && rule.servingBelow === 'forward-only')) {
        problems.push(
          w.now
            ? `${rule.writer}: this release sets ${rule.var}=${s.value}, and the ${w.floor.worker} serving now is below its floor (${describeFloor(rule, w.floor, w.serving)}; ${w.floor.why}). That is what an automatic rollback of this release would put back. Deploy ${w.floor.worker} at or above its floor without the switch first, let it serve, then set ${rule.var} (design/DECISIONS.md D64, D69).`
            : `${rule.writer}: this release sets ${rule.var}=${s.value}, and the ${w.floor.worker} serving now, which this release does not deploy, is below its floor (${describeFloor(rule, w.floor, w.serving)}; ${w.floor.why}): it would read what the switch lets in (review of D69, m-3). Deploy ${w.floor.worker} at or above its floor without the switch first, then set ${rule.var}.`,
        )
      }
    }
  } else if (s.seen) {
    for (const w of s.workers) {
      if (!w.now || atFloor(rule, w.floor, w.now)) continue
      problems.push(`${w.floor.worker}: this release is below its floor (${describeFloor(rule, w.floor, w.now)}; ${w.floor.why}), and ${rule.writer} version ${s.seen.versionId} (release ${s.seen.release ?? 'unknown'}) set ${rule.var}=${s.seen.value}: what it let in stays whatever the switch says now (${label}). Deploy ${w.floor.worker} at or above its floor.`)
    }
  }
  return problems
}

/**
 * A rule whose `serving_below_floor` is "forward-only" (D69 point 6): when this release sets the switch
 * and deploys a floor Worker that serves below its floor now, the release goes out FORWARD-ONLY for
 * that Worker (kind `floor`) instead of being refused: deploy.sh does not roll it back, a failed
 * promotion does not put that Worker back, and `release.mjs rollback` refuses the serving version
 * anyway once this release's writer version exists (a kept version with the switch). Pure; `s` as
 * for deployFloorProblems.
 */
export function floorForwardOnly(rule, s) {
  if (rule.servingBelow !== 'forward-only' || namesIn(s.value).length === 0) return []
  return s.workers
    .filter((w) => w.now && w.serving && !atFloor(rule, w.floor, w.serving))
    .map((w) => ({
      worker: w.floor.worker,
      kind: 'floor',
      rule: rule.name,
      why: `${rule.name}: this release sets ${rule.var}=${s.value}, and the ${w.floor.worker} serving now is below its floor (${describeFloor(rule, w.floor, w.serving)}; ${w.floor.why}). The release is forward-only for ${w.floor.worker}: nothing puts that version back automatically, and a rollback to it is refused once this release's ${rule.writer} is uploaded (${rule.name}: serving_below_floor forward-only, D69 point 6)`,
    }))
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
 * A version of the rule's writer that carries its switch as a secret, among the serving ones and
 * the newest (what the next upload inherits from): { versionId, which } or null. One list call and
 * at most a read or two per deploy.
 */
export async function switchAsSecret(rule, live, api) {
  const l = live[rule.writer]
  if (!l?.exists) return null
  const ids = [...(l.versions ?? []).map((v) => ({ id: v.version_id, which: 'serving' }))]
  const newest = (await api.listVersions(rule.writer))[0]?.id
  if (newest && !ids.some((x) => x.id === newest)) ids.push({ id: newest, which: 'newest' })
  for (const { id, which } of ids) {
    const b = bindingsOf(await api.versionInfo(rule.writer, id)).find((x) => x?.name === rule.var)
    if (b && SECRET_TYPES.has(b.type)) return { versionId: id, which }
  }
  return null
}

/**
 * Every rule's deploy-time problems for a manifest against what serves now (`live`, with each
 * Worker's `schemas` and `floors`; it must include every floor Worker, also one this release does
 * not deploy). `varsOf(worker)` gives a manifest Worker's generated vars. The writer's history is
 * read only when the switch is off here and a Worker of this release is below its floor (never,
 * normally); its serving and newest versions are read for a secret switch every time. Returns {
 * problems, seen: [per rule, for the record], forwardOnly: [floorForwardOnly's reasons] }.
 */
export async function floorDeployProblems(rules, manifest, live, api, varsOf) {
  const problems = []
  const seen = []
  const forwardOnly = []
  for (const rule of rules) {
    const workers = rule.floors
      .map((floor) => {
        const l = live[floor.worker]
        const serving = l?.exists ? { schemas: l.schemas, floors: l.floors } : null
        // A floor Worker this release does not deploy keeps serving: judged as it serves (m-3).
        if (!manifest.order.includes(floor.worker)) return serving ? { floor, now: null, serving } : null
        return { floor, now: codeOfManifest(manifest.workers.find((w) => w.name === floor.worker)), serving }
      })
      .filter(Boolean)
    const value = manifest.order.includes(rule.writer) ? (varsOf(manifest.workers.find((w) => w.name === rule.writer))?.[rule.var] ?? null) : null
    const s = { value, workers, secret: await switchAsSecret(rule, live, api) }
    if (namesIn(value).length === 0 && workers.some((w) => w.now && !atFloor(rule, w.floor, w.now))) s.seen = await switchSeen(rule, api)
    problems.push(...deployFloorProblems(rule, s))
    forwardOnly.push(...floorForwardOnly(rule, s))
    seen.push({
      name: rule.name,
      writer: rule.writer,
      var: rule.var,
      value,
      on: namesIn(value).length > 0,
      workers: workers.map((w) => ({ worker: w.floor.worker, atFloor: w.now ? atFloor(rule, w.floor, w.now) : null, servingAtFloor: w.serving ? atFloor(rule, w.floor, w.serving) : null })),
    })
  }
  return { problems, seen, forwardOnly }
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
