/**
 * A small JSON Schema interpreter for the keyword subset `schema.ts` uses.
 *
 * Why not Ajv: Ajv compiles schemas with `new Function`, which Workers
 * forbid; its standalone mode needs a build step and produces terse errors
 * ("must NOT have additional properties") that would have to be rewritten
 * anyway. This interpreter walks the schema at runtime (no code generation),
 * is about 250 lines, and writes errors for an LLM: JSON Pointer, plain
 * message, and a suggestion. Ajv is a dev dependency only, used in a
 * differential test to check that this interpreter and a reference
 * implementation accept and reject the same documents.
 */
import { canonicalJson, closest, hasOwn, isObject, listOf, pointer, slugId } from './json.ts'
import { ENUM_ALIASES, ID_PATTERN, type JsonSchema } from './schema.ts'
import type { Issue } from './types.ts'

type S = Record<string, unknown>

const regexCache = new Map<string, RegExp>()
function regex(p: string): RegExp {
  let r = regexCache.get(p)
  if (!r) regexCache.set(p, (r = new RegExp(p, 'u')))
  return r
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

function typeMatches(t: string, v: unknown): boolean {
  const actual = typeOf(v)
  return actual === t || (t === 'number' && actual === 'integer')
}

function show(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > 60 ? s.slice(0, 57) + '…' : s
}

export function derefSchema(root: JsonSchema, s: S): S {
  let cur = s
  for (let i = 0; i < 16 && typeof cur.$ref === 'string'; i++) {
    const name = cur.$ref.replace('#/$defs/', '')
    const defs = root.$defs as Record<string, S> | undefined
    const next = defs?.[name]
    if (!next) throw new Error(`unresolvable $ref ${cur.$ref}`)
    cur = next
  }
  return cur
}

/** The valid option a wrong value most plausibly meant: a known alias, else the nearest spelling. */
function nearest(value: unknown, options: string[]): string | undefined {
  if (typeof value !== 'string') return undefined
  const alias = ENUM_ALIASES[value.toLowerCase()]
  if (alias !== undefined && Object.prototype.hasOwnProperty.call(ENUM_ALIASES, value.toLowerCase()) && options.includes(alias)) return alias
  return closest(value, options)
}

/** What a schema accepts, in a few words; used in "expected …" messages. */
function describe(root: JsonSchema, schema: S): string {
  const s = derefSchema(root, schema)
  if ('const' in s) return show(s.const)
  if (Array.isArray(s.enum)) return 'one of ' + listOf(s.enum.map(String))
  if (Array.isArray(s.oneOf)) {
    const kinds = discriminators(root, s.oneOf as S[])
    if (kinds) return 'an object with kind ' + listOf(kinds.values.map(String))
    return [...new Set((s.oneOf as S[]).map((b) => String(derefSchema(root, b).type ?? 'value')))].join(' or ')
  }
  if (typeof s.description === 'string') return `${s.type ?? 'value'} (${s.description})`
  return String(s.type ?? 'value')
}

/** If every object branch of a oneOf carries `kind: {const}`, the list of those constants. */
function discriminators(root: JsonSchema, branches: S[]): { values: unknown[]; byValue: Map<unknown, S> } | null {
  const byValue = new Map<unknown, S>()
  for (const b of branches) {
    const s = derefSchema(root, b)
    if (s.type !== 'object') continue
    const kind = (s.properties as Record<string, S> | undefined)?.kind
    if (kind && 'const' in kind) byValue.set(kind.const, s)
  }
  return byValue.size ? { values: [...byValue.keys()], byValue } : null
}

export function validateAgainst(root: JsonSchema, schema: S, value: unknown, path: (string | number)[] = [], out: Issue[] = []): Issue[] {
  const s = derefSchema(root, schema)
  const at = pointer(path)

  if (Array.isArray(s.oneOf)) {
    oneOf(root, s.oneOf as S[], value, path, out)
    return out
  }
  if ('const' in s && value !== s.const) {
    out.push({ path: at, code: 'const', message: `Expected ${show(s.const)}, got ${show(value)}.`, suggestion: `Set it to ${show(s.const)}.` })
    return out
  }
  if (Array.isArray(s.enum) && !s.enum.includes(value)) {
    const options = s.enum.map(String)
    const near = nearest(value, options)
    out.push({
      path: at,
      code: 'enum',
      message: `${show(value)} is not an allowed value.`,
      suggestion: near ? `Did you mean ${JSON.stringify(near)}? Allowed: ${listOf(options, 24)}.` : `Allowed: ${listOf(options, 24)}.`,
    })
    return out
  }
  if (typeof s.type === 'string' && !typeMatches(s.type, value)) {
    out.push({ path: at, code: 'type', message: `Expected ${s.type}, got ${typeOf(value)} (${show(value)}).`, suggestion: `Provide ${describe(root, s)}.` })
    return out
  }

  if (typeof value === 'string') {
    const len = [...value].length
    if (typeof s.minLength === 'number' && len < s.minLength) {
      out.push({ path: at, code: 'min-length', message: `String is ${len === 0 ? 'empty' : `${len} characters`}; at least ${s.minLength} required.`, suggestion: typeof s.description === 'string' ? `Write: ${s.description}` : 'Provide a non-empty string.' })
    }
    if (typeof s.maxLength === 'number' && len > s.maxLength) {
      out.push({ path: at, code: 'max-length', message: `String is ${len} characters; at most ${s.maxLength} allowed.`, suggestion: `Shorten it to ${s.maxLength} characters or fewer.` })
    }
    if (typeof s.pattern === 'string' && !regex(s.pattern).test(value)) {
      const suggestion =
        s.pattern === ID_PATTERN
          ? `Ids are a lowercase letter followed by lowercase letters, digits or "_" (max 48). Try ${JSON.stringify(slugId(value))}.`
          : typeof s.description === 'string'
            ? `Expected: ${s.description}`
            : `Must match ${s.pattern}.`
      out.push({ path: at, code: 'pattern', message: `${show(value)} has the wrong format.`, suggestion })
    }
  } else if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) {
      out.push({ path: at, code: 'minimum', message: `${value} is below the minimum ${s.minimum}.`, suggestion: `Use a value ≥ ${s.minimum}.` })
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      out.push({ path: at, code: 'maximum', message: `${value} is above the maximum ${s.maximum}.`, suggestion: `Use a value ≤ ${s.maximum}.` })
    }
  } else if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      out.push({ path: at, code: 'min-items', message: `Array has ${value.length} items; at least ${s.minItems} required.`, suggestion: `Add at least ${s.minItems - value.length} item(s).` })
    }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      out.push({ path: at, code: 'max-items', message: `Array has ${value.length} items; at most ${s.maxItems} allowed.`, suggestion: `Remove ${value.length - s.maxItems} item(s).` })
    }
    if (s.uniqueItems === true) {
      const seen = new Map<string, number>()
      value.forEach((item, i) => {
        const key = canonicalJson(item)
        const first = seen.get(key)
        if (first !== undefined) {
          out.push({ path: pointer([...path, i]), code: 'unique-items', message: `Duplicate of item ${first}: ${show(item)}.`, suggestion: 'Remove the duplicate.' })
        } else seen.set(key, i)
      })
    }
    if (isObject(s.items)) value.forEach((item, i) => validateAgainst(root, s.items as S, item, [...path, i], out))
  } else if (isObject(value)) {
    const props = (s.properties ?? {}) as Record<string, S>
    const keys = Object.keys(value)
    for (const req of (s.required as string[] | undefined) ?? []) {
      if (!hasOwn(value, req)) {
        const ps = props[req]
        out.push({
          path: at,
          code: 'required',
          message: `Missing required property ${JSON.stringify(req)}.`,
          suggestion: `Add ${JSON.stringify(req)}: ${ps ? describe(root, ps) : 'a value'}.`,
        })
      }
    }
    if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) {
      out.push({ path: at, code: 'max-properties', message: `Object has ${keys.length} entries; at most ${s.maxProperties} allowed.`, suggestion: `Remove ${keys.length - s.maxProperties} entr(ies), or split the dashboard.` })
    }
    if (typeof s.minProperties === 'number' && keys.length < s.minProperties) {
      out.push({ path: at, code: 'min-properties', message: `Object has ${keys.length} entries; at least ${s.minProperties} required.`, suggestion: 'Add an entry.' })
    }
    const addl = s.additionalProperties
    for (const k of keys) {
      if (hasOwn(props, k)) {
        validateAgainst(root, props[k]!, value[k], [...path, k], out)
        continue
      }
      if (addl === false) {
        const free = Object.keys(props).filter((p) => !hasOwn(value, p))
        const near = closest(k, free) ?? closest(k, Object.keys(props))
        out.push({
          path: pointer([...path, k]),
          code: 'unknown-key',
          message: `Unknown property ${JSON.stringify(k)}. Unknown properties are errors, not ignored.`,
          suggestion: near ? `Did you mean ${JSON.stringify(near)}? Allowed keys: ${listOf(Object.keys(props), 24)}.` : `Remove it. Allowed keys: ${listOf(Object.keys(props), 24)}.`,
        })
        continue
      }
      if (isObject(s.propertyNames)) {
        const keyIssues = validateAgainst(root, s.propertyNames as S, k, [...path, k], [])
        for (const e of keyIssues) out.push({ ...e, code: 'invalid-key', message: `Key ${JSON.stringify(k)} is not a valid id.` })
      }
      if (isObject(addl)) validateAgainst(root, addl as S, value[k], [...path, k], out)
    }
  }
  return out
}

function oneOf(root: JsonSchema, branches: S[], value: unknown, path: (string | number)[], out: Issue[]): void {
  const at = pointer(path)
  const resolved = branches.map((b) => derefSchema(root, b))
  const disc = discriminators(root, branches)

  // Discriminated union: pick the branch by `kind` and report only its errors.
  if (disc && isObject(value) && hasOwn(value, 'kind')) {
    const branch = disc.byValue.get(value.kind)
    if (branch) {
      validateAgainst(root, branch, value, path, out)
      return
    }
    const options = disc.values.map(String)
    const near = nearest(value.kind, options)
    out.push({
      path: pointer([...path, 'kind']),
      code: 'enum',
      message: `${show(value.kind)} is not a known kind here.`,
      suggestion: near ? `Did you mean ${JSON.stringify(near)}? Allowed: ${listOf(options)}.` : `Allowed: ${listOf(options)}.`,
    })
    return
  }

  const typed = resolved.filter((b) => typeof b.type !== 'string' || typeMatches(b.type, value))
  if (typed.length === 0) {
    const types = [...new Set(resolved.map((b) => String(b.type)))]
    out.push({ path: at, code: 'type', message: `Expected ${types.join(' or ')}, got ${typeOf(value)} (${show(value)}).`, suggestion: `Provide ${describe(root, { oneOf: branches })}.` })
    return
  }
  // Undiscriminated: accept if any branch accepts; otherwise report the branch that came closest.
  let best: Issue[] | undefined
  for (const b of typed) {
    const errs = validateAgainst(root, b, value, path, [])
    if (errs.length === 0) return
    if (!best || errs.length < best.length) best = errs
  }
  // Every object branch is discriminated and the value has no `kind` at all.
  if (disc && isObject(value) && typed.every((b) => [...disc.byValue.values()].includes(b))) {
    out.push({ path: at, code: 'required', message: 'Missing required property "kind".', suggestion: `Add "kind": one of ${listOf(disc.values.map(String))}.` })
    return
  }
  out.push(...best!)
}
