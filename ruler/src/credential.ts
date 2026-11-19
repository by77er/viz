/**
 * The ruler's service key for one tenant rule shard (contracts/control.ts `serviceKey`).
 *
 * The query API and Remote Write authenticate with an API key and take the tenant from it
 * (never from a request). A rule tick has no caller to borrow a credential from, so the ruler
 * holds a key of its own, issued by the tenant's control plane (decision D39): an ordinary key
 * named `service:viz-ruler/<shard>` with the scopes the contract fixes (`read`, `write`),
 * listed among the tenant's keys, which a person can disable (access withdrawn: nothing is
 * issued again until it is enabled) or delete (a reset). The tenant is the Ruler object's
 * own, from its name; the key is bound to it by control, and every service that checks it
 * takes the tenant from the key.
 *
 * Stored in the Ruler's SQLite (`meta`, k `service_key`), the only copy in clear; never
 * logged, never returned by any RPC or HTTP response, never exported with a group.
 *
 * When to ask control again:
 *   - no key stored;
 *   - the key was refused (401) and was issued more than `PROPAGATION_GRACE_MS` ago, so KV
 *     propagation is not the reason, and the last request to control was more than
 *     `REISSUE_MIN_INTERVAL_MS` ago (each request rotates the key and writes an audit entry).
 * Concurrent callers share one request.
 */
import type { ServiceKeyResult } from '../../contracts/control'
import { CONTROL_SERVICE_VERSION } from '../../contracts/control'
import type { CredentialSource } from './engine'
import { errorText } from './evaluator'

/** A key's KV record can take a minute or more to reach every location (control/README.md). */
export const PROPAGATION_GRACE_MS = 3 * 60_000
export const REISSUE_MIN_INTERVAL_MS = 5 * 60_000

export interface StoredKey {
  key: string
  keyId: string
  issuedAt: number
}

export interface CredentialHost {
  now(): number
  /** The stored key, or null. */
  load(): StoredKey | null
  /** Store (or forget, with null) the key, durably, before it is used. */
  save(k: StoredKey | null): void
  /** Ask the tenant's control plane. Rejects when it cannot be reached. */
  issue(): Promise<ServiceKeyResult>
}

export class ServiceCredential implements CredentialSource {
  private pending: Promise<string> | null = null
  /** The key that was refused, if it should be replaced at the next `get`. */
  private refused: string | null = null
  private lastIssueAt = -Infinity
  private lastError: string | null = null

  constructor(private readonly host: CredentialHost) {}

  get(): Promise<string> {
    const stored = this.host.load()
    const now = this.host.now()
    const stale = stored !== null && this.refused === stored.key && now - stored.issuedAt >= PROPAGATION_GRACE_MS
    if (stored && !stale) return Promise.resolve(stored.key)
    if (stored && stale && now - this.lastIssueAt < REISSUE_MIN_INTERVAL_MS) return Promise.resolve(stored.key)
    if (!stored && this.lastError !== null && now - this.lastIssueAt < REISSUE_MIN_INTERVAL_MS / 10) return Promise.reject(new Error(this.lastError))
    this.pending ??= this.issue().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  rejected(key: string): void {
    this.refused = key
  }

  private async issue(): Promise<string> {
    this.lastIssueAt = this.host.now()
    let r: ServiceKeyResult
    try {
      r = await this.host.issue()
    } catch (e) {
      throw this.fail(`the control plane could not be reached for the ruler's service key: ${errorText(e)}`)
    }
    if (!r || (r as { v?: unknown }).v !== undefined && (r as { v?: unknown }).v !== CONTROL_SERVICE_VERSION) {
      throw this.fail(`the control plane answered a service-key result of version ${String((r as { v?: unknown })?.v)}, which this release does not read`)
    }
    switch (r.status) {
      case 'ok':
        // Our own clock, the one `get` compares with (control's `issuedAt` is its clock).
        this.host.save({ key: r.key, keyId: r.keyId, issuedAt: this.host.now() })
        this.refused = null
        this.lastError = null
        return r.key
      case 'disabled':
        // Withdrawn by a person: forget the old key too, so nothing keeps using a dead one.
        this.host.save(null)
        throw this.fail(`the tenant disabled the ruler's service key (${r.name}) in the control plane; enable it to resume evaluation`)
      case 'not_provisioned':
        throw this.fail('the tenant is not provisioned in the control plane')
      case 'invalid':
        throw this.fail(`the control plane refused to issue the ruler's service key: ${r.message}`)
      case 'schema_too_new':
        throw this.fail('the control plane is held by a newer release; retrying')
      default:
        throw this.fail(`the control plane answered ${JSON.stringify((r as { status?: unknown }).status)}, which this release does not read`)
    }
  }

  private fail(message: string): Error {
    this.lastError = message
    return new Error(message)
  }
}
