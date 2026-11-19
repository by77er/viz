// Mutation check for the automatic write path: break one property at a time in the source,
// run the tests that should notice, expect them to FAIL, restore the source.
//   node scripts/mutants.mjs [part] [substring of a mutant name]      (from stack/)
//   MUTANT_FILES=compact/,janitor/ node scripts/mutants.mjs all          only mutants in those files
// Parts: trigger, signals, compaction, precedence, deletion, limit, review, publication, gateway. Paths are
// relative to the root of the tree the script sits in.
//
// AGENTS.md (Evidence): mutants are applied to a COPY of the tree in a scratch area, never in
// place in the shared checkout (a mutant left in place was once captured for main). The script
// refuses to run in a git checkout. Copy the components it touches (and their siblings' sources
// and node_modules links) elsewhere and run this file from the copy.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
if (existsSync(`${ROOT}.git`)) {
  console.error(`mutants: ${ROOT} is a git checkout. Run this on a copy in a scratch directory (AGENTS.md, Evidence).`)
  process.exit(2)
}
// At most two test workers (AGENTS.md, shared machine).
const W = '--maxWorkers=2'
const T = {
  shardTrigger: ['shard', `npx vitest run ${W} test/trigger.test.ts`],
  shardSeries: ['shard', `npx vitest run ${W} test/series.test.ts`],
  consumer: ['flush', `npx vitest run ${W} test/consumer.test.ts`],
  triggers: ['stack', `npx vitest run ${W} test/triggers.test.ts`],
  compact: ['compact', `npx vitest run ${W} test/compact.test.ts`],
  property: ['stack', `npx vitest run ${W} test/compaction.property.test.ts`],
  ledger: ['ledger', `npx vitest run ${W} test/tombstone.test.ts`],
  janitor: ['janitor', `npx vitest run ${W}`],
  edge: ['edge', `npx vitest run ${W} test/limit.test.ts`],
  ledgerPrec: ['ledger', `npx vitest run ${W} test/precedence.test.ts`],
  precedence: ['stack', `npx vitest run ${W} test/precedence.property.test.ts`],
  janitorUnit: ['janitor', `npx vitest run ${W} test/janitor.test.ts`],
  janitorGolden: ['janitor', `npx vitest run ${W} test/golden.test.ts`],
  compactGolden: ['compact', `npx vitest run ${W} test/golden.test.ts`],
  compactSignals: ['compact', `npx vitest run ${W} test/signals.test.ts`],
  flushGolden: ['flush', `npx vitest run ${W} test/golden.test.ts`],
  flushUnit: ['flush', `npx vitest run ${W} test/flush.test.ts`],
  cron: ['stack', `npx vitest run ${W} test/cron.test.ts`],
  stackGolden: ['stack', `npx vitest run ${W} test/golden.test.ts`],
  janitorPub: ['janitor', `npx vitest run ${W} test/publication.test.ts`],
  stackPub: ['stack', `npx vitest run ${W} test/publisher.test.ts`],
  gatewayE2E: ['stack', `npx vitest run -c vitest.gateway.config.ts ${W}`],
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
    "      this.setMarked(false)\n      await this.env.CONFIG.delete(key)\n", "      this.setMarked(false)\n"],
  ['trigger', 'the pending marker is not written at a seal', 'shard/src/shard.ts', T.shardTrigger,
    "        await this.env.CONFIG.put(pendingMarkerKey(name), JSON.stringify({ since: now }))\n        this.setMarked(true)", "        this.setMarked(true)"],
  ['trigger', 'pendingTenants lists recorded segments too', 'shard/src/shard.ts', T.shardTrigger,
    "SELECT COUNT(*) AS n, MIN(sealed_at) AS oldest FROM segment WHERE tenant = ? AND recorded_at IS NULL", "SELECT COUNT(*) AS n, MIN(sealed_at) AS oldest FROM segment WHERE tenant = ?"],
  ['trigger', 'the sweep enqueues when idle (asks every shard of every pool map)', 'flush/src/sweep.ts', T.triggers,
    "const all = opts.full ? [", "const all = true ? ["],
  ['trigger', 'the sweep ignores how long a segment has been pending', 'flush/src/sweep.ts', T.consumer,
    ".pendingTenants(olderThanMs)", ".pendingTenants(0)"],
  ['trigger', 'a failed flush is acknowledged', 'flush/src/consumer.ts', T.consumer,
    "      if (m === carrier) m.retry({ delaySeconds: retryDelaySeconds(m.attempts) })\n      else m.ack()", "      m.ack()"],
  ['trigger', 'admitted-but-unlogged is acknowledged as done', 'flush/src/consumer.ts', T.consumer,
    "      else if (result.awaitingLog) outcome.why = 'awaiting_log'\n", ''],
  ['trigger', 'every message of a failed group is retried (the group multiplies)', 'flush/src/consumer.ts', T.consumer,
    "      if (m === carrier) m.retry(", "      if (carrier) m.retry("],
  ['trigger', 'a message that is not {tenant, shard} is acknowledged without a dead letter', 'flush/src/consumer.ts', T.consumer,
    "      await dead(junk.map((m) => ({ queue: batch.queue, id: m.id, attempts: m.attempts, at, reason: 'not a {tenant, shard} message', body: m.body })))\n", ''],
  ['trigger', 'the cron enqueues maintenance for tenants that are not due', 'stack/src/maintain.ts', T.triggers,
    "      if ((k.metadata?.due ?? 0) <= now) due.push(tenant)", "      due.push(tenant)"],
  ['trigger', 'a flush does not ask for maintenance', 'stack/src/maintain.ts', T.triggers,
    "  await env.MAINT_QUEUE.send({ v: MAINT_MESSAGE_VERSION, tenant: result.tenant, wrote: true })\n}", "}"],
  ['trigger', 'the orphan sweep stays due after a sweep that found nothing (idle tenants wake daily)', 'stack/src/maintain.ts', T.triggers,
    "    sweep = orphans.waitingSince !== undefined && Date.now() - orphans.waitingSince < stalledAfterMs", "    sweep = true"],
  ['trigger', 'S-6: a leftover that waits on the ledger keeps the sweep due for ever', 'stack/src/maintain.ts', ['stack', `npx vitest run ${W} test/cron.test.ts`],
    "    sweep = orphans.waitingSince !== undefined && Date.now() - orphans.waitingSince < stalledAfterMs", "    sweep = orphans.waitingSince !== undefined"],
  ['trigger', 'the maintenance message after a flush does not say it wrote', 'stack/src/maintain.ts', T.triggers,
    "  await env.MAINT_QUEUE.send({ v: MAINT_MESSAGE_VERSION, tenant: result.tenant, wrote: true })", "  await env.MAINT_QUEUE.send({ v: MAINT_MESSAGE_VERSION, tenant: result.tenant })"],
  ['trigger', 'the marker written after a flush does not say the sweep is needed', 'stack/src/maintain.ts', T.triggers,
    "orphansAt: existing?.orphansAt ?? Date.now(), sweep: true })", "orphansAt: existing?.orphansAt ?? Date.now(), sweep: existing?.sweep ?? false })"],
  ['trigger', 'a merge that crashed does not mark the orphan sweep as needed', 'stack/src/maintain.ts', T.triggers,
    "    if (!marker.sweep) await writeMarker(env, tenant, { ...marker, sweep: true }).catch(() => undefined)\n", ''],

  // ── Signals: compaction of spans, trace_index and logs (D30 for the new tables) ──
  ['signals', 'an output deleted by its own step when replace conflicts', 'compact/src/compact.ts', T.compactSignals,
    "  if (r.status === 'conflict') return { status: 'conflict', job: summary, missing: r.missing, blocking: r.blocking ?? [] }\n  throw new Error(`compact: the ledger answered replace with ${JSON.stringify((r as { status?: unknown }).status)}; nothing was swapped, retry`)\n}\n\nexport interface CompactRun",
    "  if (r.status === 'conflict') {\n    await env.BUCKET.delete(output.key)\n    return { status: 'conflict', job: summary, missing: r.missing, blocking: r.blocking ?? [] }\n  }\n  throw new Error(`compact: the ledger answered replace with ${JSON.stringify((r as { status?: unknown }).status)}; nothing was swapped, retry`)\n}\n\nexport interface CompactRun"],
  ['signals', 'an output deleted by its own step when it gives up after its PUT', 'compact/src/compact.ts', T.compactSignals,
    "  await opts.hooks?.afterPut?.([output])\n", "  try {\n    await opts.hooks?.afterPut?.([output])\n  } catch (e) {\n    await env.BUCKET.delete(output.key)\n    throw e\n  }\n"],
  ['signals', 'a span merged across hours: a closed day\'s spans merged as one partition', 'compact/src/compact.ts', T.compactSignals,
    "partitions.set(p.hour, [...(partitions.get(p.hour) ?? []), p])", "partitions.set(undefined, [...(partitions.get(undefined) ?? []), p])"],
  ['signals', 'a spans output keyed as a day file (no hour level)', 'compact/src/compact.ts', T.compactSignals,
    "p.table === 'spans' ? p.hour : undefined)}L${p.level}", "undefined)}L${p.level}"],
  ['signals', 'signal outputs written without their inputs record', 'compact/src/compact.ts', T.compactSignals,
    "  const put = await putFile(env.BUCKET, key, out.bytes, digest, { [COMPACTION_INPUTS_META]: record })", "  const put = await putFile(env.BUCKET, key, out.bytes, digest, {})"],
  ['signals', 'the inputs record of a spans output accepts files of another hour', 'compact/src/compact.ts', T.compactGolden,
    ": [dataKeyPrefix(cell!, table as SignalTable, tenant!, day!, hour === undefined ? undefined : Number(hour))]", ": [dataKeyPrefix(cell!, table as SignalTable, tenant!, day!)]"],
  ['signals', 'signal inputs merged in key order, not precedence', 'compact/src/compact.ts', T.compactSignals,
    "  const ordered = [...job.inputs].sort(byPrecedence).map((u) => u.files[0]!)", "  const ordered = [...job.inputs].sort((a, b) => (a.key < b.key ? 1 : -1)).map((u) => u.files[0]!)"],

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
  ['compaction', 'a conflicted step deletes its outputs (spec F14; replaces "outputs of a conflicted merge are left behind" and its tombstone variant, now intended behaviour)', 'compact/src/compact.ts', T.compact,
    "  if (r.status === 'conflict') return { status: 'conflict', job: summary, missing: r.missing, blocking: r.blocking ?? [] }",
    "  if (r.status === 'conflict') { await env.BUCKET.delete(outputs.map((f) => f.key)); return { status: 'conflict', job: summary, missing: r.missing, blocking: r.blocking ?? [] } }"],
  ['compaction', 'conflict reported as merged', 'compact/src/compact.ts', T.compact,
    "  if (r.status === 'ok') return { status: 'merged', job: summary, version: r.version, outputs, put }", "  if (r.status !== 'invalid') return { status: 'merged', job: summary, version: 0, outputs, put }"],
  ['compaction', 'the step deadline is not checked before replace', 'compact/src/compact.ts', T.compact,
    "  if (Date.now() - started > policy.maxStepMs) {", "  if (false) {"],
  ['compaction', 'the row-count check is dropped', 'compact/src/compact.ts', T.compact,
    "    if (out.rows > total || out.rows < largest || out.day !== job.day || out.table !== table) {", "    if (false) {"],
  ['compaction', 'a day is treated as closed before it ends', 'compact/src/compact.ts', T.compact,
    "    const closesAt = dayStart(day) + DAY_MS + policy.closeAfterMs", "    const closesAt = dayStart(day)"],
  ['compaction', 'the budget on pairs per merge is ignored', 'compact/src/compact.ts', T.compact,
    "j < candidates.length && group.length < policy.maxInputPairs; j++)", "j < candidates.length; j++)"],
  ['compaction', 'output keys do not carry the content hash', 'compact/src/compact.ts', T.compact,
    "inputs16, sha256Hex: hex(digest) })", "inputs16, sha256Hex: '0'.repeat(64) })"],
  ['compaction', 'the engine keeps the earlier input on a duplicate (series, ts)', 'engine/storage/src/merge.rs', ['engine/storage', 'CARGO_TARGET_DIR=$PWD/target cargo test --test merge'],
    "        (self.name.data(), self.sid, self.ts, self.input, self.row)", "        (self.name.data(), self.sid, self.ts, usize::MAX - self.input, self.row)"],

  // ── Compaction: which file wins a duplicate (series, ts) (contracts/ledger.ts `LiveFile`) ──
  ['precedence', 'plan lists files in key (text) order again', 'ledger/src/ledger.ts', T.precedence,
    "ORDER BY prec, key`, req.table, req.minTs, req.maxTs)", "ORDER BY key`, req.table, req.minTs, req.maxTs)"],
  ['precedence', 'plan lists files in key (text) order again (seen by the ledger)', 'ledger/src/ledger.ts', T.ledgerPrec,
    "ORDER BY prec, key`, req.table, req.minTs, req.maxTs)", "ORDER BY key`, req.table, req.minTs, req.maxTs)"],
  ['precedence', 'compaction merges its inputs in key order', 'compact/src/compact.ts', T.precedence,
    "  const ordered = [...job.inputs].sort(byPrecedence)", "  const ordered = [...job.inputs].sort((a, b) => (a.samples.key < b.samples.key ? -1 : 1))"],
  ['precedence', 'a compaction output ranks as new instead of covering its inputs', 'ledger/src/ledger.ts', T.precedence,
    "        : asListed(f, Math.min(...from.map((i) => i.precedenceLow)), Math.max(...from.map((i) => i.precedence)))\n    })\n    const removing",
    "        : asListed(f, next + n, next + n)\n    })\n    const removing"],
  ['precedence', 'flush files of one unit version all rank the same (no position)', 'ledger/src/ledger.ts', T.ledgerPrec,
    "asListed(f, v * PRECEDENCE_PER_VERSION + i, v * PRECEDENCE_PER_VERSION + i)", "asListed(f, v * PRECEDENCE_PER_VERSION, v * PRECEDENCE_PER_VERSION)"],
  ['precedence', 'the ledger admits a merge that jumps over a file overlapping it', 'ledger/src/ledger.ts', T.ledgerPrec,
    "    if (blocking.size > 0) return { status: 'conflict', missing: [], blocking: [...blocking].sort() }\n", ''],
  ['precedence', 'the policy picks groups that jump over a file overlapping them', 'compact/src/compact.ts', T.compact,
    "    if (jumpsOver([...group, p], universe).length > 0) continue\n", ''],
  ['precedence', 'the policy ignores live files without a partner', 'compact/src/compact.ts', T.compact,
    "...strays.filter((x) => x.day === day)]", "]"],
  ['precedence', 'a rebuilt ledger forgets precedence (everything ranks by key)', 'ledger/src/ledger.ts', T.ledgerPrec,
    "      s.files.set(f.key, { ...listed, unit })", "      s.files.set(f.key, { ...listed, precedence: 0, precedenceLow: 0, unit })"],

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
    "      if (gone.length === 0) return null\n      this.bury(gone)\n", "      if (gone.length === 0) return null\n"],
  ['deletion', 'replace records no tombstone', 'ledger/src/ledger.ts', T.janitor,
    "      const gone = inputs.map((f) => ({ key: f.key, table: f.table }))\n      this.bury(gone)\n", "      const gone = inputs.map((f) => ({ key: f.key, table: f.table }))\n"],
  ['deletion', 'the orphan sweep ignores pending units', 'janitor/src/janitor.ts', T.janitor,
    "  return w.incarnation === Number(inc) && w.seq >= Number(seqHi) ? 'dead' : 'pending_unit'", "  return 'dead'"],
  ['deletion', 'the orphan sweep takes an unknown stream for a dead one', 'janitor/src/janitor.ts', T.janitor,
    "  if (!w) return 'unknown_stream'", "  if (!w) return 'dead'"],
  ['deletion', 'the orphan sweep judges by the committed watermark', 'ledger/src/ledger.ts', T.janitor,
    "      .exec(`SELECT shard, incarnation, logged FROM stream ORDER BY shard`)\n      .toArray()\n      .map((r): Watermark => ({ shard: r.shard as string, incarnation: r.incarnation as number, seq: r.logged as number }))\n    return { live, tombstoned, logged }",
    "      .exec(`SELECT shard, incarnation, watermark AS logged FROM stream ORDER BY shard`)\n      .toArray()\n      .map((r): Watermark => ({ shard: r.shard as string, incarnation: r.incarnation as number, seq: r.logged as number }))\n    return { live, tombstoned, logged }"],
  ['deletion', 'the orphan sweep deletes live and tombstoned objects', 'janitor/src/janitor.ts', T.janitor,
    "      if (known.has(o.key)) continue\n", ''],
  ['deletion', 'a compaction output\'s age floor is only the flush files\' grace', 'janitor/src/janitor.ts', T.janitor,
    "  const compactGraceMs = Math.max(graceMs, 2 * (opts.maxCompactStepMs ?? DEFAULT_POLICY.maxStepMs))", "  const compactGraceMs = graceMs"],
  ['deletion', 'series files are not expired', 'janitor/src/janitor.ts', T.janitor,
    "ledger.expire({ tables: ['metric_samples', 'metric_series'], beforeDay })", "ledger.expire({ tables: ['metric_samples'], beforeDay })"],
  ['deletion', 'retention keeps one day too few', 'janitor/src/janitor.ts', T.janitor,
    "  const cutoff = now - policy.metric_samples_days * DAY_MS", "  const cutoff = now - (policy.metric_samples_days - 1) * DAY_MS"],
  ['deletion', 'retention is due at every midnight (idle tenants wake daily)', 'stack/src/maintain.ts', T.triggers,
    "  if (days.length > 0 && expired.keepDays !== null) due.push(Date.parse(`${days[0]}T00:00:00Z`) + (expired.keepDays + 1) * DAY_MS)", "  if (days.length > 0) due.push((Math.floor(now / DAY_MS) + 1) * DAY_MS)"],
  ['deletion', 'retention is due a day before the oldest day expires', 'stack/src/maintain.ts', T.triggers,
    "(expired.keepDays + 1) * DAY_MS)", "expired.keepDays * DAY_MS)"],
  ['deletion', 'an unreadable retention record means one day', 'janitor/src/janitor.ts', T.janitor,
    "  return parseRetention(raw)", "  const p = parseRetention(raw)\n  return p.status === 'ok' ? p : { status: 'ok', policy: { metric_samples_days: 1 }, source: 'default' }"],

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
    "      if (metered.w.add(req.seriesIds, req.seriesLimit ?? 0)) metered.dirtySince ??= now\n", "      if (metered.w.add(req.seriesIds, req.seriesLimit ?? 0)) metered.dirtySince ??= now\n      for (const [bucket, data] of metered.w.save()) sql.exec(`INSERT OR REPLACE INTO series_window (tenant, bucket, data) VALUES (?, ?, ?)`, req.tenant, bucket, data)\n"],
  ['limit', 'edge does not leave the refused series out', 'edge/src/route.ts', T.edge,
    "    for (let i = 0; i < c.nSeries; i++) if (refused.has(c.seriesId(i))) skip[i] = 1\n", ''],
  ['limit', 'edge answers 204 although series were refused', 'edge/src/index.ts', T.edge,
    "  if (outcome.limited) {\n    const also", "  if (false) {\n    const also"],
  ['limit', 'edge sends the whole limit to every shard (no share)', 'edge/src/route.ts', T.edge,
    "Math.ceil(limit / tenantSlots(map, tenant).length)", "limit"],
  ['limit', 'an unreadable limits record means no limit', 'edge/src/route.ts', T.edge,
    "    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) limit = n\n", "    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) limit = n\n    else limit = Infinity\n"],
  ['limit', 'OTLP partial_success does not count the refused points', 'edge/src/index.ts', T.edge,
    "exportResponse(json, c.rejectedTotal + (l?.rows ?? 0), message)", "exportResponse(json, c.rejectedTotal, message)"],
  ['limit', 'edge sends no series ids', 'edge/src/route.ts', T.edge,
    "seriesIds: b.seriesIds, seriesLimit })", "seriesLimit })"],

  // ── Part 6: the review of the completed write path (design/reviews/write-path-completion.md),
  //    the protocol model's F13/F14/F15 (spec/README.md), and contracts/COMPATIBILITY.md ──
  ['review', 'R-1: an unreadable retention record falls back to the default', 'janitor/src/janitor.ts', T.janitorUnit,
    "  return parseRetention(raw)", "  const p = parseRetention(raw)\n  return p.status === 'ok' ? p : { status: 'ok', policy: DEFAULT_RETENTION, source: 'default' }"],
  ['review', 'R-1: no record is refused instead of meaning the default', 'janitor/src/janitor.ts', T.janitorUnit,
    "  if (raw === null) return { status: 'ok', policy: DEFAULT_RETENTION, source: 'default' }", "  if (raw === null) return { status: 'unreadable', reason: 'no record' }"],
  ['review', 'R-1: a retention record of an unknown version is read', 'janitor/src/janitor.ts', T.janitorUnit,
    "  if (v !== RETENTION_RECORD_VERSION) return unreadable(", "  if (false) return unreadable("],
  ['review', 'R-1: a refusal is not written to the marker', 'stack/src/maintain.ts', T.stackGolden,
    ", ...(expired.refused !== undefined ? { retention: expired.refused.slice(0, 200) } : {}) }", " }"],
  ['review', 'R-1: a refused tenant is not looked at again within the hour', 'stack/src/maintain.ts', T.stackGolden,
    "  if (expired.refused !== undefined) due.push(Date.now() + HOUR_MS)\n", ''],
  ['review', 'R-2/F13: the sweep ignores a compaction output\'s inputs (age only)', 'janitor/src/janitor.ts', T.compact,
    "        else if (!d.inputs.some((k) => !present.has(k) && !live.has(k))) out.kept.push({ key: o.key, why: 'inputs_remain' })\n", ''],
  ['review', 'R-2: a tombstoned input whose object is still there counts as gone', 'janitor/src/janitor.ts', T.compact,
    "!present.has(k) && !live.has(k)", "!live.has(k)"],
  ['review', 'R-2: a live input whose object is missing counts as gone', 'janitor/src/janitor.ts', T.janitorUnit,
    "!present.has(k) && !live.has(k)", "!present.has(k)"],
  ['review', 'R-2: the inputs record is not checked against the key', 'compact/src/compact.ts', T.compactGolden,
    "  if ((await inputsHash16(inputs as string[])) !== inputs16) return { unreadable: 'inputs do not hash to the key' }\n", ''],
  ['review', 'R-2: an inputs record of an unknown version is read', 'compact/src/compact.ts', T.janitorGolden,
    "  if (rec.v !== COMPACTION_INPUTS_VERSION) return", "  if (false) return"],
  ['review', 'R-2: inputs outside the output\'s tenant and day are accepted', 'compact/src/compact.ts', T.compactGolden,
    "!inputs.every((k) => typeof k === 'string' && prefixes.some((p) => k.startsWith(p) && !k.slice(p.length).includes('/')))", "!inputs.every((k) => typeof k === 'string')"],
  ['review', 'R-2: outputs are written without their inputs record', 'compact/src/compact.ts', T.compact,
    "{ [COMPACTION_INPUTS_META]: record }", "{}"],
  ['review', 'F14: a replace answer this code does not know is taken for a conflict', 'compact/src/compact.ts', T.compact,
    "  if (r.status === 'conflict') return {", "  if (r.status !== 'ok') return {"],
  ['review', 'F15: a newer incarnation counts before its registration is logged', 'janitor/src/janitor.ts', T.janitorUnit,
    "return w.seq > 0 ? 'dead' : 'pending_unit'", "return 'dead'"],
  ['review', 'F12: flush reads a segment unbound to its incarnation and range', 'flush/src/flush.ts', T.flushUnit,
    "c.shard.readSegment(c.tenant, seg.seqLo, seg.incarnation, seg.seqHi)", "c.shard.readSegment(c.tenant, seg.seqLo)"],
  ['review', 'F12: a refused bound read is not reported as an incarnation change', 'flush/src/flush.ts', T.flushUnit,
    "    if (now?.incarnation !== seg.incarnation) throw new Stop('shard_incarnation_changed',", "    if (false) throw new Stop('shard_incarnation_changed',"],
  ['review', 'R-7: one shard that throws stops the flush sweep', 'flush/src/sweep.ts', T.cron,
    "const answers = await Promise.allSettled(group.map(", "const answers = await Promise.all(group.map("],
  ['review', 'R-7: the maintenance sweep waits on the flush sweep', 'stack/src/index.ts', T.cron,
    "  const [f, m] = await Promise.allSettled([sweepPending(env, { now }), enqueueDue(env, now)])", "  const f0 = await sweepPending(env, { now })\n  const [f, m] = await Promise.allSettled([Promise.resolve(f0), enqueueDue(env, now)])"],
  ['review', 'R-7: no bound on the shards asked per cron', 'flush/src/sweep.ts', T.cron,
    "  const shards = rotation(all, max, opts.now ?? Date.now())", "  const shards = all"],
  ['review', 'R-7: the window of shards never moves on', 'flush/src/sweep.ts', T.cron,
    "  const start = (Math.floor(now / HOUR_MS) * max) % shards.length", "  const start = 0"],
  ['review', 'R-11(b): maintenance after every run, changed or not', 'flush/src/consumer.ts', T.consumer,
    "      if (result.changed || messages.some((m) => m.attempts > 1)) await opts.onFlushed?.(result)", "      await opts.onFlushed?.(result)"],
  ['review', 'R-11(b): a redelivery after a failed request does not ask again', 'flush/src/consumer.ts', T.consumer,
    "      if (result.changed || messages.some((m) => m.attempts > 1)) await opts.onFlushed?.(result)", "      if (result.changed) await opts.onFlushed?.(result)"],
  ['review', 'R-11(b): a run that admitted something and then stopped does not ask', 'flush/src/consumer.ts', T.consumer,
    "      if (result.changed || messages.some((m) => m.attempts > 1)) await opts.onFlushed?.(result)", "      if (result.status === 'ok' && (result.changed || messages.some((m) => m.attempts > 1))) await opts.onFlushed?.(result)"],
  ['review', 'R-11(b): a flush never reports a change', 'flush/src/flush.ts', T.consumer,
    "  out.changed = out.segments.some(", "  out.changed = false && out.segments.some("],
  ['review', 'R-11(c): the marker write is not retried', 'stack/src/maintain.ts', T.cron,
    "      if (attempt >= MARKER_WRITE_ATTEMPTS) throw e", "      throw e"],
  ['review', 'R-11(c): an unchanged marker is written again', 'stack/src/maintain.ts', T.cron,
    "  if (sameMarker(before, after)) return\n", ''],
  ['review', 'R-12: one dead-letter object per message', 'flush/src/consumer.ts', T.consumer,
    "  await env.BUCKET.put(key, JSON.stringify({ v: DEAD_LETTER_OBJECT_VERSION, letters }), { httpMetadata: { contentType: 'application/json' } })",
    "  for (const l of letters) await env.BUCKET.put(`${key}-${l.id}`, JSON.stringify({ v: DEAD_LETTER_OBJECT_VERSION, letters: [l] }), { httpMetadata: { contentType: 'application/json' } })"],
  ['review', 'R-12: a batch whose dead-letter write failed is acknowledged', 'flush/src/consumer.ts', T.consumer,
    "    for (const m of batch.messages) m.retry({ delaySeconds: 60 })", "    for (const m of batch.messages) m.ack()"],
  ['review', 'versions: a flush message of an unknown version is flushed', 'flush/src/consumer.ts', T.consumer,
    "    if (v !== null && v !== FLUSH_MESSAGE_VERSION) {", "    if (false) {"],
  ['review', 'versions: a flush message of an unknown version is dead-lettered', 'flush/src/consumer.ts', T.consumer,
    "      // Written by a release this one does not know: retry; never guess, never dead-letter.\n      m.retry({ delaySeconds: retryDelaySeconds(m.attempts) })", "      junk.push(m)"],
  ['review', 'versions: a maintenance message of an unknown version is run', 'stack/src/maintain.ts', T.cron,
    "    if (isObject && ((body as MaintMessage).v ?? 1) !== MAINT_MESSAGE_VERSION) {", "    if (false) {"],
  ['review', 'versions: a marker of an unknown version is acted on by the run', 'stack/src/maintain.ts', T.stackGolden,
    "  if (v !== MAINT_MARKER_VERSION) return { status: 'unsupported', version: v }\n", ''],
  ['review', 'versions: a marker of an unknown version is acted on by the cron', 'stack/src/maintain.ts', T.stackGolden,
    "      if ((k.metadata?.v ?? 1) !== MAINT_MARKER_VERSION) {", "      if (false) {"],
  ['review', 'versions: a dead-letter object of an unknown version is read as version 1', 'flush/src/consumer.ts', T.flushGolden,
    "      else throw new Error(`dead letters:", "      else if (false) throw new Error(`dead letters:"],
  ['review', 'encoding: the flush message loses its version', 'flush/src/sweep.ts', T.flushGolden,
    "pending.push({ v: FLUSH_MESSAGE_VERSION, tenant: p.tenant, shard })", "pending.push({ tenant: p.tenant, shard })"],
  ['review', 'encoding: the marker loses its version', 'stack/src/maintain.ts', T.stackGolden,
    "    metadata: { v: MAINT_MARKER_VERSION, due: m.due,", "    metadata: { due: m.due,"],
  ['review', 'encoding: inputs16 is hashed with another separator', 'compact/src/compact.ts', T.compactGolden,
    "inputs.join('\\n')", "inputs.join(',')"],
  ['review', 'encoding: a flush file key keeps nine hex digits of its hash', 'flush/src/keys.ts', T.flushGolden,
    "-${p.seqHi}-${p.sha256Hex.slice(0, 8)}.parquet`", "-${p.seqHi}-${p.sha256Hex.slice(0, 9)}.parquet`"],
  // ── The publisher wired in (D34, D15) and deletion gated on publication (DESIGN §5.2, §5.3) ──
  ['publication', 'the deletion gate is ignored: the ledger alone decides', 'janitor/src/janitor.ts', T.janitorPub,
    '    const doomed = (released ? keys.filter((k) => released!.has(k)) : keys).slice(0, want)', '    const doomed = keys.slice(0, want)'],
  ['publication', 'a key the publisher releases is deleted although the ledger does not offer it', 'janitor/src/janitor.ts', T.janitorPub,
    '    const doomed = (released ? keys.filter((k) => released!.has(k)) : keys).slice(0, want)', '    const doomed = (released ? [...new Set([...keys.filter((k) => released!.has(k)), ...released])] : keys).slice(0, want)'],
  ['publication', 'a publisher that cannot answer releases everything (fails open)', 'janitor/src/janitor.ts', T.janitorPub,
    '      const batch = await ledger.deletable({ minAgeMs: graceMs, limit: 1 })\n      return { deleted: [], waiting: batch.waiting + batch.tombstones.length, publisher: why }', '      gate = null'],
  ['publication', "the publisher's answer is awaited without a bound", 'janitor/src/janitor.ts', T.janitorPub,
    '      released = new Set(await within(gate.safeToDelete(tenant), timeoutMs, `the publisher of ${cell}`))', '      released = new Set(await gate.safeToDelete(tenant))'],
  ['publication', 'a held-back head starves the released keys behind it', 'janitor/src/janitor.ts', T.janitorPub,
    '      if (keys.length < limit || limit >= 10_000) break\n      continue', '      break'],
  ['publication', 'what was deleted is not acknowledged to the publisher', 'janitor/src/janitor.ts', T.janitorPub,
    '  const ack = [...deleted]', '  const ack: string[] = []'],
  ['publication', 'maintenance does not nudge the publisher', 'stack/src/maintain.ts', T.stackPub,
    "    nudged = await nudge(env.PUBLISHER, env.CELL || 'cell-0', [tenant], publisherTimeoutMs)\n", '    nudged = true\n'],
  ['publication', 'a nudge that may not have been recorded does not make the tenant due again', 'stack/src/maintain.ts', T.stackPub,
    '    if (!nudged) due.push(Date.now() + HOUR_MS)\n', ''],
  ['publication', 'a deployment without a publisher still nudges (every tenant due hourly)', 'stack/src/maintain.ts', T.stackPub,
    '  if (env.PUBLISHER) {\n    nudged = await nudge(', '  if (true) {\n    nudged = await nudge('],
  ['publication', 'the nudge waits as long as the publisher takes', 'stack/src/maintain.ts', T.stackPub,
    "    nudged = await nudge(env.PUBLISHER, env.CELL || 'cell-0', [tenant], publisherTimeoutMs)", "    nudged = await nudge(env.PUBLISHER, env.CELL || 'cell-0', [tenant], 2 ** 31 - 1)"],
  ['publication', 'maintenance deletes without asking the publisher', 'stack/src/maintain.ts', T.stackPub,
    '  const purged = await purgeTenant(env, tenant, { graceMs: deleteGraceMs, publisherTimeoutMs })', '  const purged = await purgeTenant({ ...env, PUBLISHER: undefined }, tenant, { graceMs: deleteGraceMs, publisherTimeoutMs })'],
  ['publication', 'a removal waiting only for publication is looked at every grace (hourly)', 'stack/src/maintain.ts', T.stackPub,
    '    else due.push(Date.now() + (opts.publicationRecheckMs ?? PUBLICATION_RECHECK_MS))', '    else due.push(Date.now() + Math.max(deleteGraceMs, 60_000))'],
  ['publication', 'the flush path nudges the publisher', 'stack/src/maintain.ts', T.stackPub,
    '  await env.MAINT_QUEUE.send({ v: MAINT_MESSAGE_VERSION, tenant: result.tenant, wrote: true })\n}', "  await nudge(env.PUBLISHER, env.CELL || 'cell-0', [result.tenant])\n  await env.MAINT_QUEUE.send({ v: MAINT_MESSAGE_VERSION, tenant: result.tenant, wrote: true })\n}"],
  ['publication', 'ingest asks the publisher before acknowledging', 'stack/src/index.ts', T.stackPub,
    '  fetch: (req, env) => edge.fetch(req, env),', "  fetch: async (req, env) => ((await (await import('../../publisher/src/nudge')).nudge(env.PUBLISHER, env.CELL || 'cell-0', ['ingest'])), edge.fetch(req, env)),"],
  ['publication', 'the cron nudges the publisher (an idle deployment wakes it hourly)', 'stack/src/index.ts', T.triggers,
    '  const [f, m] = await Promise.allSettled([sweepPending(env, { now }), enqueueDue(env, now)])', "  const [f, m] = await Promise.allSettled([sweepPending(env, { now }), enqueueDue(env, now), import('../../publisher/src/nudge').then((x) => x.nudge(env.PUBLISHER, env.CELL || 'cell-0', ['cron']))])"],
  // ── Traces and logs, stage 3: the public path through the gateway (test/gateway/) ──
  ['gateway', 'gateway: a trace path goes to ingest (OTLP traces and Tempo share /api/traces/…)', 'deploy/gateway/src/index.ts', T.gatewayE2E,
    "if (INGEST_PATHS.has(path) || SIGNAL_INGEST_PATHS.has(path)) return 'ingest'", "if (INGEST_PATHS.has(path) || SIGNAL_INGEST_PATHS.has(path) || path.startsWith('/api/traces/')) return 'ingest'"],
  ['gateway', 'gateway: every /loki/ path goes to ingest (where the push is served)', 'deploy/gateway/src/index.ts', T.gatewayE2E,
    "if (INGEST_PATHS.has(path) || SIGNAL_INGEST_PATHS.has(path)) return 'ingest'", "if (INGEST_PATHS.has(path) || SIGNAL_INGEST_PATHS.has(path) || path.startsWith('/loki/')) return 'ingest'"],
  ['gateway', 'gateway: the span and log ingest paths are not routed', 'deploy/gateway/src/index.ts', T.gatewayE2E,
    "if (INGEST_PATHS.has(path) || SIGNAL_INGEST_PATHS.has(path)) return 'ingest'", "if (INGEST_PATHS.has(path)) return 'ingest'"],
  ['gateway', 'gateway: /api/v1/plan is not routed', 'deploy/gateway/src/index.ts', T.gatewayE2E,
    "'/api/v1/metadata', '/api/v1/plan'])", "'/api/v1/metadata'])"],
  ['gateway', 'edge: a base pool ending in /logs is accepted', 'edge/src/route.ts', T.gatewayE2E,
    '!DERIVED_SIGNALS.some((s) => pool.endsWith(`/${s}`))', "!pool.endsWith('/traces')"],
  ['gateway', 'query: QUERY_SIGNALS ignored on the Loki read paths', 'query/src/index.ts', T.gatewayE2E,
    "if (path.startsWith('/loki/')) return signalEnabled(env, 'logs') ? lokiRoute(path) : null", "if (path.startsWith('/loki/')) return lokiRoute(path)"],
  ['gateway', 'query: QUERY_SIGNALS ignored on the Tempo read paths', 'query/src/index.ts', T.gatewayE2E,
    "return signalEnabled(env, 'traces') ? tempoRoute(path) : null", 'return tempoRoute(path)'],
  ['gateway', 'edge: INGEST_SIGNALS ignored on the span and log ingest paths', 'edge/src/index.ts', T.gatewayE2E,
    'if (signal !== null && signalEnabled(env, signal)) {', 'if (signal !== null) {'],
]

const [part, only] = process.argv.slice(2)
// MUTANT_FILES=compact/,janitor/ runs only the mutants of files under those prefixes.
const files = process.env.MUTANT_FILES ? process.env.MUTANT_FILES.split(',') : null
let survived = 0
const tally = {}
for (const [p, name, file, [cwd, cmd], from, to] of mutants) {
  if (part && part !== 'all' && p !== part) continue
  if (only && !name.includes(only)) continue
  if (files && !files.some((f) => file.startsWith(f))) continue
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
    detail = [...out.matchAll(/^\s+(?:×|FAIL) (.+?)(?: \d+ms)?$/gm)].map((m) => m[1]).slice(0, 2).join(' | ') ||
      [...out.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map((m) => `cargo: ${m[1]}`).slice(0, 2).join(' | ') ||
      (out.match(/error(\[E\d+\])?: .*|Error: .*/)?.[0] ?? '')
  } finally {
    writeFileSync(path, original)
  }
  if (!failed) survived++
  tally[p][failed ? 'killed' : 'survived']++
  console.log(`${failed ? 'KILLED  ' : 'SURVIVED'}  [${p}] ${name}${detail ? `  ← ${detail}` : ''}`)
}
console.log(JSON.stringify(tally))
console.log(survived === 0 ? 'all mutants killed' : `${survived} mutant(s) survived`)
