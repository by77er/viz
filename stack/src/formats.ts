/**
 * What the stack's maintenance code writes that another release reads, with the version it
 * writes now (contracts/COMPATIBILITY.md §3.1). Each is pinned by
 * `test/golden/formats/<format>.v<N>.json` (`test/golden.test.ts`).
 */
export const FORMATS = {
  /** A maintenance-queue message: `{"v":1,"tenant":…,"wrote"?:true}` (`MAINT_MESSAGE_VERSION`). An absent `v` is 1. */
  'queue.maint': 1,
  /** The metadata of the KV marker `maint:<tenant>`: `{v, due, orphansAt, sweep, retention?}` (`MAINT_MARKER_VERSION`). An absent `v` is 1. */
  'kv.maint-marker': 1,
} as const
