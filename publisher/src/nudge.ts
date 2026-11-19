/**
 * How the rest of viz tells the publisher that a tenant's ledger changed (design/DECISIONS.md
 * D31). The caller is the maintenance run (`stack/src/maintain.ts`), which every flush that
 * changed something already causes, and which itself makes the ledger's other changes
 * (compaction, retention). Nothing on the ingest or flush path calls the publisher (D15).
 */

/** What `nudge` needs of the publisher's namespace: the cell's object and its `notify`. */
export interface PublisherNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { notify(tenants: string[]): Promise<void> }
}

/** How long a nudge may hold its caller. `notify` is one SQLite write; this is for a publisher that is overloaded or gone. */
export const NUDGE_TIMEOUT_MS = 2_000

/**
 * Tell the cell's publisher these tenants changed. Best effort and bounded: it never throws and
 * never waits longer than `timeoutMs`, whatever the publisher does (slow, refusing during a
 * deploy, missing). Returns false when the nudge may not have been recorded; the caller then
 * makes sure it is sent again later (the maintenance run marks the tenant due in an hour, so the
 * hourly cron runs it again). A nudge that is recorded after its timeout is harmless: publishing
 * a tenant with nothing new writes nothing.
 */
export async function nudge(ns: PublisherNamespace | undefined, cell: string, tenants: string[], timeoutMs = NUDGE_TIMEOUT_MS): Promise<boolean> {
  if (tenants.length === 0) return true
  if (!ns) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const call = ns.get(ns.idFromName(cell)).notify(tenants).then(
      () => true,
      () => false,
    )
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    return await Promise.race([call, late])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
