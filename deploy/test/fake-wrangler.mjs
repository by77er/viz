// A stand-in for wrangler, for test/secrets.test.mjs only. lib/wrangler.mjs runs it as a real
// child process (VIZ_WRANGLER_BIN points at a wrapper the test writes), so what the deploy puts on
// the command line, in the environment and on stdin is exactly what this process receives.
//
// State lives in the JSON file named by VIZ_FAKE_WRANGLER_STATE, shared with the test's fake
// Cloudflare API: Workers, their versions (vars, secrets), deployments, and a log of every call
// (argv, how many bytes came on stdin, whether any environment variable contained them).
// Models, as wrangler 4.164.0 and Cloudflare do (deploy/README.md cites both):
//   versions upload            a new version from the config and `--var K:V`; secrets inherited from the newest version
//   versions secret put K      a new version = the NEWEST version + K (value from stdin), its vars that version's; deploys nothing
//   versions deploy ID@100%    the deployment becomes ID
//   deploy                     a new version (config vars and `--var K:V`; secrets inherited), deployed at once; creates the Worker
//   deploy --dry-run, triggers deploy: nothing
// Knobs in the state: `failOn` (an argv prefix that fails, echoing its stdin as a careless tool
// would), `inherit: "none"` (uploads inherit no secret), `afterUpload: "foreign"` (another
// version appears right after an upload), `racePut: true` (another run of the same release uploads
// after the deploy's checks and before the put is applied: review of D53, m-11), `ignoreVar: true`
// (`--var` is not applied).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const statePath = process.env.VIZ_FAKE_WRANGLER_STATE
const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const chunks = []
for await (const c of process.stdin) chunks.push(c)
const stdin = Buffer.concat(chunks).toString('utf8')

state.calls.push({
  argv: args,
  stdinLength: stdin.length,
  envHasStdin: stdin.length > 0 && Object.values(process.env).some((v) => typeof v === 'string' && v.includes(stdin)),
  // What decides whether wrangler writes a debug log, and whether it redacts request bodies in it (lib/wrangler.mjs SECRET_RUN_ENV).
  logEnv: { WRANGLER_LOG: process.env.WRANGLER_LOG ?? null, WRANGLER_LOG_SANITIZE: process.env.WRANGLER_LOG_SANITIZE ?? null, WRANGLER_WRITE_LOGS: process.env.WRANGLER_WRITE_LOGS ?? null },
})
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2))
const done = (text) => {
  save()
  process.stdout.write(text + '\n')
  process.exit(0)
}
const fail = (text) => {
  save()
  process.stderr.write(text + '\n')
  process.exit(1)
}
const opt = (k) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : undefined
}
const output = (entry) => {
  if (process.env.WRANGLER_OUTPUT_FILE_PATH) appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify(entry) + '\n')
}
const readConfig = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
const newId = () => {
  state.counter = (state.counter ?? 0) + 1
  return `00000000-0000-4000-8000-${String(state.counter).padStart(12, '0')}`
}
const inherited = (w) => (state.inherit === 'none' ? {} : { ...(w.versions.at(-1)?.secrets ?? {}) })
/** Every `--var K:V` (wrangler splits at the first colon), unless the state says to ignore them. */
const cliVars = () => {
  const out = {}
  if (state.ignoreVar) return out
  args.forEach((a, i) => {
    if (a !== '--var') return
    const [k, ...v] = String(args[i + 1]).split(':')
    out[k] = v.join(':')
  })
  return out
}

const line = args.join(' ')
if (state.failOn && line.startsWith(state.failOn)) {
  state.rejectedStdin = stdin
  fail(`✘ [ERROR] fake wrangler refuses "${state.failOn}" (it was given: ${stdin})`)
}

const [a, b, c] = args
if (a === 'versions' && b === 'upload') {
  const cfg = readConfig(opt('config'))
  const w = state.workers[cfg.name]
  if (!w) fail(`This Worker does not exist on your account. [code: 10007]`)
  const v = { id: newId(), number: (w.versions.at(-1)?.number ?? 0) + 1, tag: opt('tag') ?? null, vars: { ...(cfg.vars ?? {}), ...cliVars() }, secrets: inherited(w) }
  w.versions.push(v)
  if (state.afterUpload === 'foreign') w.versions.push({ id: newId(), number: v.number + 1, tag: 'someone-else', vars: { VIZ_RELEASE: 'someone-else' }, secrets: { ...v.secrets } })
  output({ type: 'version-upload', version_id: v.id })
  done(`Worker Version ID: ${v.id}`)
} else if (a === 'versions' && b === 'secret' && c === 'put') {
  const key = args[3]
  const w = state.workers[opt('name')]
  if (!w || w.versions.length === 0) fail('There are currently no uploaded versions of this Worker. Please upload a version before modifying a secret.')
  if (stdin.length === 0) fail('fake wrangler: an empty secret')
  if (state.racePut) {
    // Another run of the same release: same code and VIZ_RELEASE, its own VIZ_DEPLOY_RUN, uploaded
    // after this run's checks; the PATCH below applies to it, as Cloudflare's "latest" would.
    const last = w.versions.at(-1)
    w.versions.push({ ...structuredClone(last), id: newId(), number: last.number + 1, vars: { ...last.vars, VIZ_DEPLOY_RUN: 'another-run-of-the-same-release' } })
  }
  const latest = w.versions.at(-1)
  const v = { ...structuredClone(latest), id: newId(), number: latest.number + 1, tag: opt('tag') ?? latest.tag, secrets: { ...latest.secrets, [key]: stdin.replace(/\s+$/, '') } }
  w.versions.push(v)
  done(`🌀 Creating the secret for the Worker "${opt('name')}"\n✨ Success! Created version ${v.id} with secret ${key}.\n➡️  To deploy this version with secret ${key} to production traffic use the command "wrangler versions deploy".`)
} else if (a === 'versions' && b === 'deploy') {
  const [id, pct] = c.split('@')
  const name = opt('name') ?? readConfig(opt('config')).name
  const w = state.workers[name]
  if (!w?.versions.some((v) => v.id === id)) fail(`fake wrangler: ${name} has no version ${id}`)
  w.deployment = [{ version_id: id, percentage: Number.parseFloat(pct) }]
  done(`Deployed ${name} version ${id} at ${pct}`)
} else if (a === 'triggers' && b === 'deploy') {
  done('Deployed triggers')
} else if (a === 'deploy' && args.includes('--dry-run')) {
  done('--dry-run: exiting now.')
} else if (a === 'deploy') {
  const cfg = readConfig(opt('config'))
  const w = (state.workers[cfg.name] ??= { migrationTag: null, versions: [], deployment: [] })
  const v = { id: newId(), number: (w.versions.at(-1)?.number ?? 0) + 1, tag: opt('tag') ?? null, vars: { ...(cfg.vars ?? {}), ...cliVars() }, secrets: inherited(w) }
  w.versions.push(v)
  w.deployment = [{ version_id: v.id, percentage: 100 }]
  w.migrationTag = cfg.migrations?.at(-1)?.tag ?? w.migrationTag
  output({ type: 'deploy', version_id: v.id })
  done(`Current Version ID: ${v.id}`)
} else fail(`fake wrangler: unknown command ${line}`)
