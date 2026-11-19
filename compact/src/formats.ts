/**
 * What this component writes that another release reads, with the version it writes now
 * (contracts/COMPATIBILITY.md §3.1). Each is pinned by `test/golden/formats/<format>.v<N>.json`
 * (`test/golden.test.ts`); old versions' files stay, and the readers still read them.
 */
export const FORMATS = {
  /** A compaction output's object key (contracts/TABLES.md): `inputs16` and the content hash are derived identifiers (§3.4). */
  'key.compaction-output': 1,
  /** The R2 custom metadata `viz-inputs` of a compaction output: `{"v":1,"inputs":[…]}`. Read by the orphan sweep (janitor/). */
  'r2.compaction-inputs': 1,
} as const
