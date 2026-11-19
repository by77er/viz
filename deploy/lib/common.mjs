// Shared helpers for the deploy scripts. No dependencies beyond Node 22.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEPLOY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = resolve(DEPLOY_DIR, '..')
export const GENERATED_DIR = join(DEPLOY_DIR, 'generated')

/**
 * JSONC → value: line and block comments and trailing commas removed, strings untouched.
 * The same dialect wrangler accepts in wrangler.jsonc.
 */
export function parseJsonc(text, where = 'JSONC') {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) throw new Error(`${where}: unterminated block comment`)
      i = end + 2
    } else {
      out += c
      i++
    }
  }
  // Trailing commas: a comma followed only by whitespace before } or ].
  let clean = ''
  for (let k = 0; k < out.length; k++) {
    const c = out[k]
    if (c === '"') {
      let j = k + 1
      while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1
      clean += out.slice(k, j + 1)
      k = j
      continue
    }
    if (c === ',') {
      let j = k + 1
      while (j < out.length && /\s/.test(out[j])) j++
      if (out[j] === '}' || out[j] === ']') continue
    }
    clean += c
  }
  try {
    return JSON.parse(clean)
  } catch (e) {
    throw new Error(`${where}: ${e.message}`)
  }
}

export const readJsonc = (path) => parseJsonc(readFileSync(path, 'utf8'), path)
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Production names are `viz-…`; a stage's are `viz-<stage>-…`. */
export function stagedName(name, stage) {
  if (!name.startsWith('viz-')) throw new Error(`refusing a resource not named viz-…: ${name}`)
  return stage ? `viz-${stage}-${name.slice(4)}` : name
}

/**
 * Words that appear in production resource names. A stage named after one of them would give
 * names that overlap production's (stage `flush` → `viz-flush-ingest`, next to `viz-flush-dlq`).
 */
const RESERVED_STAGES = new Set(['ingest', 'query', 'control', 'gateway', 'ruler', 'publisher', 'mcp', 'config', 'lake', 'flush', 'maint', 'edge', 'stack', 'spike', 'production', 'prod', 'main'])

export function checkStage(stage) {
  if (stage === undefined || stage === null) return
  if (!/^[a-z][a-z0-9]{1,15}$/.test(stage)) throw new Error(`stage must match [a-z][a-z0-9]{1,15}: ${stage}`)
  if (RESERVED_STAGES.has(stage)) throw new Error(`stage name "${stage}" would collide with production resource names`)
}

/** `--name value`, `--flag`, positional. */
export function parseArgs(argv, { flags = [], options = [] } = {}) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s)
      if (flags.includes(k)) out[k] = true
      else if (options.includes(k)) {
        const v = inline !== undefined ? inline : argv[++i]
        if (v === undefined) throw new Error(`--${k} needs a value`)
        out[k] = v
      } else throw new Error(`unknown option --${k}`)
    } else out._.push(a)
  }
  return out
}

export const targetName = (stage) => (stage ? `stage-${stage}` : 'production')

export function log(...args) {
  console.error(...args)
}

/** A short identifier of the release a version was built from: the git SHA in CI. */
export function releaseId() {
  return process.env.VIZ_RELEASE_SHA || process.env.GITHUB_SHA || `local-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`
}
