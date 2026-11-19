/**
 * The janitor writes no format of its own (it only deletes objects and asks the ledger).
 * It READS these, refusing any version it does not list (contracts/COMPATIBILITY.md §3.2):
 * an unreadable retention record expires nothing, and a compaction output whose inputs record
 * it cannot read is never deleted. `test/golden.test.ts` reads each writer's golden files.
 */
export const FORMATS = {} as const

export const READS = {
  /** `retention:<tenant>`, written by control/ (`control/test/golden/formats/kv.settings.v1.json`). */
  'kv.settings': [1],
  /** A compaction output's `viz-inputs` metadata, written by compact/ (`compact/test/golden/formats/r2.compaction-inputs.v1.json`). */
  'r2.compaction-inputs': [1],
} as const
