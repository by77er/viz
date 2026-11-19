/**
 * Review S-2: what a checkpoint costs at 8,000, 32,000 and 100,000 live files, before and after
 * the change of 2026-11-19 (checkpoints by log volume, superseded ones deleted, the body written
 * as a string, and a state-size guard on `addUnit`). Measured here, in local workerd: one
 * process for the test, the object and SQLite, on a shared machine (times ±2× with its load).
 * Times are taken around the calls from outside the object (inside it the clock stands still
 * while code runs).
 *
 *   BENCH=checkpoint npm run bench
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { LEDGER_CHECKPOINT_KIND, encodeLedgerSegment } from '../../contracts/ledger'
import { type Ledger, STATE_MAX_BYTES } from '../src/ledger'
import { unitFor } from './worker'

const E = env as unknown as { LEDGER: DurableObjectNamespace<Ledger>; CELL: string; BENCH: string }
const only = (name: string) => E.BENCH === '' || E.BENCH === name
type Inner = {
  stateMaxBytes: number
  checkpointEvery: number
  checkpointByLogBytes: boolean
  stateFromSqlite(): unknown
  baseChange(inc: number, s: unknown): unknown
}
const inner = (i: Ledger) => i as unknown as Inner
const PER_UNIT = 4_000

async function fill(l: DurableObjectStub<Ledger>, tenant: string, files: number, from = 0): Promise<{ admitted: number; full: boolean; seq: number }> {
  let seq = from
  let admitted = 0
  while (admitted < files) {
    const r = await l.addUnit(unitFor(E.CELL, tenant, 0, seq + 1, seq + 1, Math.min(PER_UNIT, files - admitted)))
    if (r.status === 'full') return { admitted, full: true, seq }
    expect(r.status).toBe('ok')
    admitted += Math.min(PER_UNIT, files - admitted)
    seq++
  }
  return { admitted, full: false, seq }
}

describe.skipIf(!only('checkpoint'))('checkpoint cost (review S-2; measured here, workerd)', () => {
  it('8,000, 32,000 and 100,000 live files: one checkpoint before, and what the ledger does now', async () => {
    const rows: Record<string, unknown>[] = []
    for (const files of [8_000, 32_000, 100_000]) {
      const tenant = `ckpt-${files}-${Date.now().toString(36)}`
      const l = E.LEDGER.get(E.LEDGER.idFromName(tenant))
      // The state as the code before the guard let it grow.
      await runInDurableObject(l, (i: Ledger) => { inner(i).stateMaxBytes = Number.MAX_SAFE_INTEGER })
      const { seq } = await fill(l, tenant, files)
      await l.drain()
      const row: Record<string, unknown> = { files, stateBytes: (await l.logStatus()).stateBytes }
      // The synchronous part of a checkpoint as built before: read the state, JSON, body, UTF-8 bytes.
      let t = Date.now()
      const sizes = await runInDurableObject(l, (i: Ledger) => {
        const json = JSON.stringify(inner(i).baseChange(1, inner(i).stateFromSqlite()))
        const body = encodeLedgerSegment(tenant, 1, [{ version: 1, json }], LEDGER_CHECKPOINT_KIND)
        const bytes = new TextEncoder().encode(body)
        return { json: json.length, bytes: bytes.length }
      })
      row.syncBeforeMs = Date.now() - t
      row.checkpointMB = +(sizes.bytes / 1e6).toFixed(1)
      // A drain that writes a checkpoint (every segment) and one that does not.
      await runInDurableObject(l, (i: Ledger) => { inner(i).checkpointEvery = 1; inner(i).checkpointByLogBytes = false })
      await l.addUnit(unitFor(E.CELL, tenant, 0, seq + 1, seq + 1, 2))
      t = Date.now()
      await l.drain()
      row.drainWithCheckpointMs = Date.now() - t
      // Now the default policy: a checkpoint only once the log since the last is as large as it.
      await runInDurableObject(l, (i: Ledger) => { inner(i).checkpointByLogBytes = true })
      await l.addUnit(unitFor(E.CELL, tenant, 0, seq + 2, seq + 2, 2))
      t = Date.now()
      await l.drain()
      row.drainAfterMs = Date.now() - t
      const st = await l.logStatus()
      row.segmentsSinceCheckpoint = st.segmentsSinceCheckpoint
      rows.push(row)
    }
    // With the default limit: where `addUnit` starts answering `full`.
    const tenant = `ckpt-guard-${Date.now().toString(36)}`
    const l = E.LEDGER.get(E.LEDGER.idFromName(tenant))
    const g = await fill(l, tenant, 100_000)
    const st = await l.logStatus()
    rows.push({ guard: true, limitBytes: STATE_MAX_BYTES, admittedFiles: g.admitted, refused: g.full, stateBytes: st.stateBytes })
    console.log(`BENCH ${JSON.stringify(rows)}`)
  })
})
