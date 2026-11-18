// Mutation check for the automatic write path: break one property at a time in the source,
// run the tests that should notice, expect them to FAIL, restore the source.
//   node scripts/mutants.mjs [part] [substring of a mutant name]      (from stack/)
// Parts: trigger, compaction, deletion, limit. Paths are relative to the repository root.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const T = {
  shardTrigger: ['shard', 'npx vitest run test/trigger.test.ts'],
  shardSeries: ['shard', 'npx vitest run test/series.test.ts'],
  consumer: ['flush', 'npx vitest run test/consumer.test.ts'],
  triggers: ['stack', 'npx vitest run test/triggers.test.ts'],
  compact: ['compact', 'npx vitest run test/compact.test.ts'],
  property: ['stack', 'npx vitest run test/compaction.property.test.ts'],
  ledger: ['ledger', 'npx vitest run test/tombstone.test.ts'],
  janitor: ['janitor', 'npx vitest run'],
  edge: ['edge', 'npx vitest run test/limit.test.ts'],
}

const mutants = [
  // ── Part 1: flush triggering ──
  ['trigger', 'a seal writes no notification', 'shard/src/shard.ts', T.shardTrigger,
    "    sql.exec(`INSERT INTO notify (tenant, due) VALUES (?, ?) ON CONFLICT (tenant) DO UPDATE SET due = excluded.due`, tenant, now)\n", ''],
  ['trigger', 'a notification that could not be sent is dropped', 'shard/src/shard.ts', T.shardTrigger,
    "        sql.exec(`UPDATE notify SET due = ? WHERE tenant = ? AND due = ?`, now + this.cfg.notifyRetryMs, tenant, r.due)", "        sql.exec(`DELETE FROM notify WHERE tenant = ? AND due = ?`, tenant, r.due)"],
  ['trigger', 'a seal on age (alarm) is not announced', 'shard/src/shard.ts', T.shardTrigger,
    "    // 4. Seals made above, and anything a previous attempt could not send.\n    await this.deliver()\n", ''],
  ['trigger', 'the shard never removes its pending marker', 'shard/src/shard.ts', T.shardTrigger,
    "      else this.setMarked(false)", "      else await this.env.CONFIG.put(key, '{}')"],
  ['trigger', 'the pending marker is not written at a seal', 'shard/src/shard.ts', T.shardTrigger,
    "        await this.env.CONFIG.put(pendingMarkerKey(name), JSON.stringify({ since: now }))\n        this.setMarked(true)", "        this.setMarked(true)"],
  ['trigger', 'pendingTenants lists recorded segments too', 'shard/src/shard.ts', T.shardTrigger,
    "SELECT COUNT(*) AS n, MIN(sealed_at) AS oldest FROM segment WHERE tenant = ? AND recorded_at IS NULL", "SELECT COUNT(*) AS n, MIN(sealed_at) AS oldest FROM segment WHERE tenant = ?"],
  ['trigger', 'the sweep enqueues when idle (asks every shard of every pool map)', 'flush/src/sweep.ts', T.triggers,
    "const shards = opts.full ? [", "const shards = true ? ["],
  ['trigger', 'the sweep ignores how long a segment has been pending', 'flush/src/sweep.ts', T.consumer,
    ".pendingTenants(olderThanMs)", ".pendingTenants(0)"],
  ['trigger', 'a failed flush is acknowledged', 'flush/src/consumer.ts', T.consumer,
    "      if (m === carrier) m.retry({ delaySeconds: retryDelaySeconds(m.attempts) })\n      else m.ack()", "      m.ack()"],
  ['trigger', 'admitted-but-unlogged is acknowledged as done', 'flush/src/consumer.ts', T.consumer,
    "      else if (result.awaitingLog) outcome.why = 'awaiting_log'\n", ''],
  ['trigger', 'every message of a failed group is retried (the group multiplies)', 'flush/src/consumer.ts', T.consumer,
    "      if (m === carrier) m.retry(", "      if (carrier) m.retry("],
  ['trigger', 'a message that is not {tenant, shard} is acknowledged without a dead letter', 'flush/src/consumer.ts', T.consumer,
    "        await dead({ queue: batch.queue, id: m.id, attempts: m.attempts, at: Date.now(), reason: 'not a {tenant, shard} message', body: m.body })\n", ''],
  ['trigger', 'the cron enqueues maintenance for tenants that are not due', 'stack/src/maintain.ts', T.triggers,
    "if (TENANT_ID.test(tenant) && (k.metadata?.due ?? 0) <= now) enqueued.push(tenant)", "if (TENANT_ID.test(tenant)) enqueued.push(tenant)"],
  ['trigger', 'a flush does not ask for maintenance', 'stack/src/maintain.ts', T.triggers,
    "  await env.MAINT_QUEUE.send({ tenant: result.tenant })\n}", "}"],

  // ── Part 2: compaction ──
  ['compaction', 'samples and series swapped in two replaces (not paired)', 'compact/src/compact.ts', T.compact,
    "  const r = await ledger.replace({ remove: summary.inputs, add: outputs })",
    "  await ledger.replace({ remove: inSamples.map((f) => f.key), add: outputs.slice(0, 1) })\n  const r = await ledger.replace({ remove: inSeries.map((f) => f.key), add: outputs.slice(1) })"],
  ['compaction', 'series inputs left live after the merge', 'compact/src/compact.ts', T.compact,
    "  const r = await ledger.replace({ remove: summary.inputs, add: outputs })", "  const r = await ledger.replace({ remove: inSamples.map((f) => f.key), add: outputs })"],
  ['compaction', 'the series file is not merged: the first input is reused', 'compact/src/compact.ts', T.property,
    "    const out = engine.mergeFiles(table, await fetchAll(env.BUCKET, files.map((f) => f.key)))",
    "    const all = await fetchAll(env.BUCKET, files.map((f) => f.key))\n    const out = engine.mergeFiles(table, table === 'metric_series' ? all.slice(0, 1) : all)"],
  ['compaction', 'only the first two sample inputs are merged (rows lost)', 'compact/src/compact.ts', T.property,
    "    const out = engine.mergeFiles(table, await fetchAll(env.BUCKET, files.map((f) => f.key)))",
    "    const all = await fetchAll(env.BUCKET, files.map((f) => f.key))\n    const out = engine.mergeFiles(table, table === 'metric_samples' ? all.slice(0, 2) : all)"],
  ['compaction', 'outputs of a conflicted merge are left behind', 'compact/src/compact.ts', T.compact,
    "  if (discarded.length > 0) await env.BUCKET.delete(discarded)\n", ''],
  ['compaction', 'conflict reported as merged', 'compact/src/compact.ts', T.compact,
    "  if (r.status === 'ok') return { status: 'merged', job: summary, version: r.version, outputs, put }", "  if (r.status !== 'invalid') return { status: 'merged', job: summary, version: 0, outputs, put }"],
  ['compaction', 'the step deadline is not checked before replace', 'compact/src/compact.ts', T.compact,
    "  if (Date.now() - started > policy.maxStepMs) {", "  if (false) {"],
  ['compaction', 'the row-count check is dropped', 'compact/src/compact.ts', T.compact,
    "    if (out.rows > total || out.rows < largest || out.day !== job.day || out.table !== table) {", "    if (false) {"],
  ['compaction', 'a day is treated as closed before it ends', 'compact/src/compact.ts', T.compact,
    "    const closesAt = dayStart(day) + DAY_MS + policy.closeAfterMs", "    const closesAt = dayStart(day)"],
  ['compaction', 'the budget on pairs per merge is ignored', 'compact/src/compact.ts', T.compact,
    "    if (into.length >= policy.maxInputPairs) break\n", ''],
  ['compaction', 'output keys do not carry the content hash', 'compact/src/compact.ts', T.compact,
    "inputs16, sha256Hex: hex(digest) })", "inputs16, sha256Hex: '0'.repeat(64) })"],
  ['compaction', 'the engine keeps the earlier input on a duplicate (series, ts)', 'engine/storage/src/merge.rs', ['engine/storage', 'CARGO_TARGET_DIR=$PWD/target cargo test --test merge'],
    "        (self.name.data(), self.sid, self.ts, self.input, self.row)", "        (self.name.data(), self.sid, self.ts, usize::MAX - self.input, self.row)"],

  // ── Part 3: retention and physical deletion ──
  ['deletion', 'deletable before the removal is logged', 'ledger/src/ledger.ts', T.ledger,
    "         WHERE t.version < ? AND t.at <= ? AND NOT EXISTS", "         WHERE t.version < ? + 1000000 AND t.at <= ? AND NOT EXISTS"],
  ['deletion', 'deletable before the removal is logged (seen by the janitor)', 'ledger/src/ledger.ts', T.janitor,
    "         WHERE t.version < ? AND t.at <= ? AND NOT EXISTS", "         WHERE t.version < ? + 1000000 AND t.at <= ? AND NOT EXISTS"],
  ['deletion', 'deletable inside the grace', 'ledger/src/ledger.ts', T.janitor,
    "this.firstUnlogged(), Date.now() - req.minAgeMs, limit,", "this.firstUnlogged(), Date.now(), limit,"],
  ['deletion', 'a live key is deletable', 'ledger/src/ledger.ts', T.ledger,
    " AND NOT EXISTS (SELECT 1 FROM file f WHERE f.key = t.key)", ''],
  ['deletion', 'the janitor deletes every tombstone without asking what is deletable', 'janitor/src/janitor.ts', T.janitor,
    "    const keys = batch.tombstones.map((t) => t.key)", "    const keys = (await ledger.removedSince(0)).map((t) => t.key)"],
  ['deletion', 'expire records no tombstone', 'ledger/src/ledger.ts', T.janitor,
    "      this.bury(removed.map((key) => ({ key, table: req.table })))\n", ''],
  ['deletion', 'replace records no tombstone', 'ledger/src/ledger.ts', T.janitor,
    "      this.bury(remove.map((key) => ({ key, table: this.liveFile(key)!.table })))\n", ''],
  ['deletion', 'the orphan sweep ignores pending units', 'janitor/src/janitor.ts', T.janitor,
    "  return w.incarnation === Number(inc) && w.seq >= Number(seqHi) ? 'dead' : 'pending_unit'", "  return 'dead'"],
  ['deletion', 'the orphan sweep takes an unknown stream for a dead one', 'janitor/src/janitor.ts', T.janitor,
    "  if (!w) return 'unknown_stream'", "  if (!w) return 'dead'"],
  ['deletion', 'the orphan sweep judges by the committed watermark', 'ledger/src/ledger.ts', T.janitor,
    "      .exec(`SELECT shard, incarnation, logged FROM stream ORDER BY shard`)\n      .toArray()\n      .map((r): Watermark => ({ shard: r.shard as string, incarnation: r.incarnation as number, seq: r.logged as number }))\n    return { live, tombstoned, logged }",
    "      .exec(`SELECT shard, incarnation, watermark AS logged FROM stream ORDER BY shard`)\n      .toArray()\n      .map((r): Watermark => ({ shard: r.shard as string, incarnation: r.incarnation as number, seq: r.logged as number }))\n    return { live, tombstoned, logged }"],
  ['deletion', 'the orphan sweep deletes live and tombstoned objects', 'janitor/src/janitor.ts', T.janitor,
    "      if (known.has(o.key)) continue\n", ''],
  ['deletion', 'a compaction output is an orphan as soon as a flush file would be', 'janitor/src/janitor.ts', T.janitor,
    "  const compactGraceMs = Math.max(graceMs, 2 * (opts.maxCompactStepMs ?? DEFAULT_POLICY.maxStepMs))", "  const compactGraceMs = graceMs"],
  ['deletion', 'series files are not expired', 'janitor/src/janitor.ts', T.janitor,
    "  const series = await ledger.expire({ table: 'metric_series', beforeDay })", "  const series = { removed: [] as string[] }"],
  ['deletion', 'retention keeps one day too few', 'janitor/src/janitor.ts', T.janitor,
    "new Date(now - policy.metric_samples_days * DAY_MS)", "new Date(now - (policy.metric_samples_days - 1) * DAY_MS)"],
  ['deletion', 'an unreadable retention record means one day', 'janitor/src/janitor.ts', T.janitor,
    "  } catch {\n    // fall through\n  }\n  return DEFAULT_RETENTION", "  } catch {\n    // fall through\n  }\n  return { metric_samples_days: 1 }"],

  // ── Part 4: active-series limit ──
  ['limit', 'the limit refuses existing series', 'shard/src/sketch.ts', T.shardSeries,
    "      if (!this.cur.has(id, h1, h2) && !this.prev.has(id, h1, h2)) fresh.push(id)", "      fresh.push(id)"],
  ['limit', 'the limit refuses existing series (seen through edge)', 'shard/src/sketch.ts', T.edge,
    "      if (!this.cur.has(id, h1, h2) && !this.prev.has(id, h1, h2)) fresh.push(id)", "      fresh.push(id)"],
  ['limit', 'the limit is not enforced', 'shard/src/shard.ts', T.shardSeries,
    "        if (fresh.length > room) {", "        if (false) {"],
  ['limit', 'a refused batch is counted anyway', 'shard/src/shard.ts', T.shardSeries,
    "        const { current, fresh } = metered.w.check(req.seriesIds)", "        const { current, fresh } = metered.w.check(req.seriesIds)\n        metered.w.add(req.seriesIds, req.seriesLimit)"],
  ['limit', 'every new series of the batch is refused, not only those that do not fit', 'shard/src/shard.ts', T.shardSeries,
    "refused: BigInt64Array.from(fresh.slice(room)) }", "refused: BigInt64Array.from(fresh) }"],
  ['limit', 'series ids are not checked against the batch header', 'shard/src/shard.ts', T.shardSeries,
    "      if (header !== req.seriesIds.length) {", "      if (false) {"],
  ['limit', 'the window never forgets (no rotation)', 'shard/src/sketch.ts', T.shardSeries,
    "    if (index <= this.index) return false", "    if (index <= this.index + 1e9) return false"],
  ['limit', 'above the threshold nothing is known (membership always false)', 'shard/src/sketch.ts', T.shardSeries,
    "    return this.exact ? this.exact.has(id) : bloomHas(this.bloom!, h1, h2)", "    return this.exact ? this.exact.has(id) : false"],
  ['limit', 'the sketch estimate uses the wrong constant', 'shard/src/sketch.ts', T.shardSeries,
    "  const alpha = 0.7213 / (1 + 1.079 / m)", "  const alpha = 0.8 / (1 + 1.079 / m)"],
  ['limit', 'the series window is saved on every append', 'shard/src/shard.ts', T.shardSeries,
    "      metered.dirtySince ??= now\n", "      metered.dirtySince ??= now\n      for (const [bucket, data] of metered.w.save()) sql.exec(`INSERT OR REPLACE INTO series_window (tenant, bucket, data) VALUES (?, ?, ?)`, req.tenant, bucket, data)\n"],
  ['limit', 'edge does not leave the refused series out', 'edge/src/route.ts', T.edge,
    "    for (let i = 0; i < c.nSeries; i++) if (refused.has(c.seriesId(i))) skip[i] = 1\n", ''],
  ['limit', 'edge answers 204 although series were refused', 'edge/src/index.ts', T.edge,
    "  if (outcome.limited) {\n    const also", "  if (false) {\n    const also"],
  ['limit', 'edge sends the whole limit to every shard (no share)', 'edge/src/route.ts', T.edge,
    "Math.ceil(limit / tenantSlots(map, tenant).length)", "limit"],
  ['limit', 'an unreadable limits record means no limit', 'edge/src/route.ts', T.edge,
    "      if (typeof n === 'number' && Number.isInteger(n) && n >= 0) limit = n\n    } catch {", "      if (typeof n === 'number' && Number.isInteger(n) && n >= 0) limit = n\n      else limit = Infinity\n    } catch {"],
  ['limit', 'OTLP partial_success does not count the refused points', 'edge/src/index.ts', T.edge,
    "exportResponse(json, c.rejectedTotal + (l?.rows ?? 0), message)", "exportResponse(json, c.rejectedTotal, message)"],
  ['limit', 'edge sends no series ids', 'edge/src/route.ts', T.edge,
    "seriesIds: b.seriesIds, seriesLimit })", "seriesLimit })"],
]

const [part, only] = process.argv.slice(2)
let survived = 0
const tally = {}
for (const [p, name, file, [cwd, cmd], from, to] of mutants) {
  if (part && part !== 'all' && p !== part) continue
  if (only && !name.includes(only)) continue
  const path = ROOT + file
  const original = readFileSync(path, 'utf8')
  tally[p] ??= { killed: 0, survived: 0 }
  if (!original.includes(from)) {
    console.log(`NOT APPLIED  [${p}] ${name} (pattern not found in ${file})`)
    survived++
    tally[p].survived++
    continue
  }
  writeFileSync(path, original.replace(from, to))
  let failed = false
  let detail = ''
  try {
    execSync(cmd, { cwd: ROOT + cwd, stdio: 'pipe', shell: '/bin/bash', env: { ...process.env, NO_COLOR: '1' } })
  } catch (e) {
    failed = true
    const out = String(e.stdout) + String(e.stderr)
    detail = [...out.matchAll(/^\s+(?:×|FAIL) (.+?)(?: \d+ms)?$/gm)].map((m) => m[1]).slice(0, 2).join(' | ') || (out.match(/test .* FAILED|error.*|Error: .*/)?.[0] ?? '')
  } finally {
    writeFileSync(path, original)
  }
  if (!failed) survived++
  tally[p][failed ? 'killed' : 'survived']++
  console.log(`${failed ? 'KILLED  ' : 'SURVIVED'}  [${p}] ${name}${detail ? `  ← ${detail}` : ''}`)
}
console.log(JSON.stringify(tally))
console.log(survived === 0 ? 'all mutants killed' : `${survived} mutant(s) survived`)
