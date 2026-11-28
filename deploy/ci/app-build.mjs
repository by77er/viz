#!/usr/bin/env node
// CI, in app/ after `npm run build`: reads the build by app/serve.json's rules, exactly as the deploy
// reads it before staging it for viz-gateway (deploy/lib/app.mjs readServe, readBuild; D74). A file
// serve.json does not cover, a content type it does not name, a document that asks for something
// the build does not hold, or a rule in serve.json the gateway does not serve by, fails here.
//
//   node ../deploy/ci/app-build.mjs [dist]        (from app/)
import { join, resolve } from 'node:path'
import { APP_VAR, VAR_MAX_BYTES, appFilesVar, appVar, appWorker, headersFile, readBuild, readServe } from '../lib/app.mjs'
import { DEPLOY_DIR, REPO_ROOT, readJson } from '../lib/common.mjs'

try {
  const { app } = appWorker(readJson(join(DEPLOY_DIR, 'workers.json')))
  const serve = readServe(join(REPO_ROOT, app.serve))
  const dist = resolve(process.argv[2] ?? 'dist')
  const build = readBuild(dist, serve)
  const doc = Buffer.byteLength(appVar(serve, build))
  headersFile(serve)
  appFilesVar(build, [])
  console.log(`${dist}: build ${build.hash.slice(0, 12)}: index.html and ${build.files.length} files, ${build.files.reduce((n, f) => n + f.bytes, 0)} bytes; servable by ${app.serve} (${serve.documents.length} documents); ${APP_VAR} would be ${doc} of ${VAR_MAX_BYTES} bytes`)
  for (const f of build.files) console.log(`  ${f.path} ${f.bytes}`)
} catch (e) {
  console.error(`app-build: ${e.message}`)
  process.exit(1)
}
