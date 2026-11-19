/**
 * What this component writes that another release reads, with the version it writes now
 * (contracts/COMPATIBILITY.md §3.1). Each is pinned by `test/golden/formats/<format>.v<N>.json`
 * (`test/golden.test.ts`); old versions' files stay, and the readers still read them.
 */
export const FORMATS = {
  /** A flush-queue message the sweep sends: `{"v":1,"tenant":…,"shard":…}` (`FLUSH_MESSAGE_VERSION`). An absent `v` is 1. */
  'queue.flush': 1,
  /** A dead-letter object: v2 `{"v":2,"letters":[DeadLetter…]}`, one per invocation; v1 (no `v`) was one `DeadLetter` per object and is still read. */
  'r2.dead-letters': 2,
  /** A flush file's object key (contracts/TABLES.md), including its content hash: a derived identifier (§3.4). */
  'key.flush-file': 1,
} as const

/** Formats this component reads and the versions it reads (refusing any other). */
export const READS = {
  'queue.flush': [1],
  'r2.dead-letters': [1, 2],
} as const
