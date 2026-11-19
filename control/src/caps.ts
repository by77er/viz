/** Size caps. A dashboard spec is small, so revisions are stored whole; these keep that true. */
export interface Caps {
  /** One spec, as UTF-8 JSON. A SQLite value in a Durable Object is capped at 2 MB. */
  maxSpecBytes: number
  maxRevisionsPerDashboard: number
  /** Revisions plus proposals, summed over the tenant. */
  maxTenantBytes: number
  maxDashboards: number
  maxKeys: number
  maxOpenProposalsPerDashboard: number
  maxOpsPerRequest: number
}

export const DEFAULT_CAPS: Caps = {
  maxSpecBytes: 256 * 1024,
  maxRevisionsPerDashboard: 500,
  maxTenantBytes: 64 * 1024 * 1024,
  maxDashboards: 2_000,
  maxKeys: 200,
  maxOpenProposalsPerDashboard: 50,
  maxOpsPerRequest: 500,
}

/** `CONTROL_CAPS` (JSON) may override any field with a positive integer; anything else is ignored. */
export function capsFrom(json: string | undefined): Caps {
  const out = { ...DEFAULT_CAPS }
  if (!json) return out
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    for (const k of Object.keys(out) as (keyof Caps)[]) {
      const v = o[k]
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v
    }
  } catch {
    // unreadable configuration keeps the defaults
  }
  return out
}

export const PROPOSAL_TTL_DAYS = 30
export const DELETED_RETENTION_DAYS = 30
export const DAY_MS = 86_400_000
