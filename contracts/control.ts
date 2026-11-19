/**
 * The control plane's service surface: what other viz Workers ask a tenant's `Tenant` object
 * (control/) for, over its Durable Object binding (by `script_name`), never over HTTP.
 *
 * Added 2026-11-19 for the ruler (decision D39). Two questions only:
 *
 *   notificationTarget  where the tenant's alerts go by default: the webhook a person set in
 *                       control's `notifications` settings, with its signing secret
 *   serviceKey          an API key the ruler acts with on the tenant's behalf (query reads,
 *                       Remote Write of recorded series), owned and revocable by the tenant
 *
 * Conventions (as in `rules.ts`):
 * - Every call takes the tenant first. The caller takes it from its own binding context (the
 *   name of the object it runs in, which was derived from a credential), never from a request
 *   body. A `Tenant` object bound to another tenant, or not provisioned, answers
 *   `not_provisioned` and changes nothing.
 * - Nothing here throws for bad input: results are discriminated on `status`.
 * - Every result carries `v` (contracts/COMPATIBILITY.md §3.1). A caller that meets a `v` it
 *   does not know refuses the result (keeps what it had) rather than guessing.
 * - `schema_too_new`: the object's storage belongs to a newer release; retry after `retryAfterMs`.
 *
 * Secrets in these results (the webhook secret, the service key) are for the caller's own
 * storage and outbound requests only: never logged, never returned by any API, never put in a
 * notification body.
 *
 * Versions: 1.
 *
 * The OAuth RPCs on the same object (token, revocation, introspection for the agent surface)
 * are in `oauth.ts`.
 */

import type { SchemaTooNew } from './schema'

/** The version of every result below. */
export const CONTROL_SERVICE_VERSION = 1

/** Body formats a webhook can be sent in (`rules.ts` `WebhookConfig.format`, contract version 3). */
export type WebhookFormat = 'alertmanager' | 'json'

/**
 * The tenant's default notification destination, as set through control
 * (`PUT /api/v1/control/settings/notifications`). The ruler's notifier offers it as the
 * reserved receiver `CONTROL_RECEIVER` (`rules.ts`).
 */
export interface NotificationTarget {
  /** https only. May carry a credential in its path or query: treat the whole URL as secret. */
  url: string
  format: WebhookFormat
  /** Also notify when alerts resolve. */
  sendResolved: boolean
  /** Shared secret for `X-Viz-Signature` (`rules.ts`), or null for unsigned requests. */
  secret: string | null
}

export type NotificationTargetResult =
  | {
      v: 1
      status: 'ok'
      /** The `notifications` section's version: a caller keeps a copy and replaces it only by a newer one. */
      version: number
      /** Null: no webhook is set; nothing is sent to the default receiver. */
      target: NotificationTarget | null
    }
  | { v: 1; status: 'not_provisioned' }
  | SchemaTooNew

/**
 * Services that may hold a service key, and the scopes each gets. The scopes are fixed here,
 * not chosen by the caller.
 */
export const SERVICE_KEYS = {
  /** Rule evaluation reads through the query API (`read`); recording rules write their series through Remote Write (`write`). */
  'viz-ruler': { scopes: ['read', 'write'] },
} as const

export type ServiceName = keyof typeof SERVICE_KEYS

/**
 * Service keys are ordinary API keys named `service:<service>/<instance>` (for the ruler, the
 * instance is the rule shard number). The prefix is reserved: a person cannot create a key
 * with it, but can see, disable and delete one like any other key. Disabled = the tenant has
 * withdrawn that service's access, and no new key is issued until it is enabled again;
 * deleted = a reset, and the next request issues a new key.
 */
export const SERVICE_KEY_PREFIX = 'service:'

/** `[0-9]{1,4}`: a rule shard number. */
export const SERVICE_INSTANCE = /^[0-9]{1,4}$/

export type ServiceKeyResult =
  | {
      v: 1
      status: 'ok'
      /** `viz_<keyId>_<secret>`. The only copy: it is not stored in clear anywhere but by the caller. */
      key: string
      keyId: string
      name: string
      scopes: string[]
      /** When it was issued (Unix ms). Its KV record may take up to a minute or more to reach every location. */
      issuedAt: number
    }
  /** A person disabled this service's key: nothing was issued. */
  | { v: 1; status: 'disabled'; name: string }
  | { v: 1; status: 'not_provisioned' }
  /** Unknown service or a malformed instance; nothing was changed. */
  | { v: 1; status: 'invalid'; message: string }
  | SchemaTooNew

export interface TenantServiceRpc {
  notificationTarget(tenant: string): Promise<NotificationTargetResult>
  /**
   * Issue a key for `service` instance `instance`: create it, or rotate it (the previous secret
   * ends at once, so only one is ever live). One audit entry, `key.service`. Call it when the
   * caller has no key, or its key is refused and old enough that KV propagation is not the
   * reason: every call is a rotation.
   */
  serviceKey(tenant: string, service: ServiceName, instance: string): Promise<ServiceKeyResult>
}
