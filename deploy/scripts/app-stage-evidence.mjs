#!/usr/bin/env node
// Writes the entry of a stage deploy into deploy/records/app-stage-evidence.json: the record that a
// stage went before the first production release with the web app (design/DECISIONS.md D74, "would
// change if"; review of D74, M-2; deploy/README.md, "A stage before production").
//
//   node deploy/scripts/app-stage-evidence.mjs --stage <name> --by "<who vouches for it>"
//
// Run it after `deploy/deploy.sh --stage <name>` ended with a passed smoke test, in the same
// checkout. It reads what that run left in deploy/generated/stage-<name>/ (release.json and
// smoke.json; nothing is asked of Cloudflare), refuses a stage that went without the app or whose
// smoke test did not pass with the app checked, computes the serving fingerprint of THIS checkout
// (lib/app.mjs `servingFingerprint`), and writes the entry with the five by-hand checks EMPTY.
// A person then makes checks 6 to 10, writes into each `"result": "pass"` and a note of what was
// seen (the numbers, the command), and commits the file. release.mjs counts an entry only when it
// is complete and its fingerprint is the release's.
//
// What this is: a person's statement, bound to the serving code by a hash. The tool checks its
// shape, not its truth.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appWorker, readServe, servingFingerprint } from '../lib/app.mjs'
import { DEPLOY_DIR, GENERATED_DIR, REPO_ROOT, checkStage, parseArgs, readJson, targetName } from '../lib/common.mjs'
import { APP_STAGE_BY_HAND, APP_STAGE_EVIDENCE } from '../release.mjs'

const WHAT = {
  6: 'Workers requests and asset requests of the stage\'s gateway for a known number of page loads, from Cloudflare\'s analytics API: assets are not billed as Worker requests',
  7: 'a second release that changes a chunk: the first build\'s chunk still answers 200 from the new version, and the release record lists it under kept',
  8: 'release.mjs rollback --only the gateway to the first release (its document and chunks serve again) and to a version without the app (the 404s; the next release\'s carry says why nothing was kept)',
  9: 'raw paths with dot segments and encoded separators against the deployed stage (curl --path-as-is): never a page, never anything but a file of the build',
  10: 'the response headers of a 304 from Cloudflare for an asset and for the document through the edge\'s compression',
}

/** The entry of one stage deploy, from what its run left in generated/; throws when that run is no evidence. */
export function evidenceEntry({ stage, by, generatedDir = GENERATED_DIR, repoRoot = REPO_ROOT, plan = readJson(join(DEPLOY_DIR, 'workers.json')), now = new Date() }) {
  checkStage(stage)
  if (!stage) throw new Error('--stage <name> is needed: the evidence is of a stage deploy')
  if (typeof by !== 'string' || by.trim() === '') throw new Error('--by "<name>" is needed: who vouches for this stage deploy')
  const dir = join(generatedDir, targetName(stage))
  const read = (name) => {
    const file = join(dir, name)
    if (!existsSync(file)) throw new Error(`${file} is missing: run deploy/deploy.sh --stage ${stage} first, in this checkout`)
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  const release = read('release.json')
  const smoke = read('smoke.json')
  const app = (release.app ?? []).find((a) => typeof a.build === 'string')
  if (!app || release.withoutApp === true) throw new Error(`the release of stage ${stage} went without the web app: it is no evidence of how the app is served`)
  if (smoke.ok !== true || smoke.web === 'skipped' || smoke.web?.ok !== true) throw new Error(`the smoke test of stage ${stage} did not pass with the web app checked (${join(dir, 'smoke.json')})`)
  if (smoke.release !== release.release) throw new Error(`the smoke test in ${join(dir, 'smoke.json')} is of release ${smoke.release}, not ${release.release}`)
  const found = appWorker(plan)
  const now_ = servingFingerprint({ repoRoot, serve: readServe(join(repoRoot, found.app.serve)), worker: found.worker })
  if (app.serving && app.serving !== now_.fingerprint) throw new Error(`the serving code changed since stage ${stage} was deployed (its release has fingerprint ${app.serving.slice(0, 12)}, this checkout ${now_.fingerprint.slice(0, 12)}): deploy the stage again from this checkout`)
  return {
    serving: now_.fingerprint,
    parts: now_.parts,
    stage,
    release: release.release,
    deployedAt: release.recordedAt ?? smoke.at,
    build: app.build,
    smoke: { passed: true, app: true, requests: smoke.web.checked, data: smoke.data === 'skipped' ? 'skipped' : smoke.data?.ok === true, at: smoke.at },
    byHand: Object.fromEntries(APP_STAGE_BY_HAND.map((n) => [n, { what: WHAT[n], result: null, note: '' }])),
    by: by.trim(),
    writtenAt: now.toISOString(),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { options: ['stage', 'by'] })
    const entry = evidenceEntry({ stage: args.stage, by: args.by })
    const file = APP_STAGE_EVIDENCE
    const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { v: 1, evidence: [] }
    all.evidence = [...all.evidence.filter((e) => !(e.stage === entry.stage && e.serving === entry.serving)), entry]
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(all, null, 2) + '\n')
    console.error(`wrote the entry of stage ${entry.stage} (release ${entry.release}, serving fingerprint ${entry.serving.slice(0, 12)}) to ${file}.`)
    console.error(`It does NOT count yet: make the by-hand checks ${APP_STAGE_BY_HAND.join(', ')} (deploy/README.md, "A stage before production"), set each "result" to "pass" with a note of what was seen, and commit the file.`)
  } catch (e) {
    console.error(`app-stage-evidence: ${e.message}`)
    process.exit(1)
  }
}
