import { OAUTH_DEFAULT_SCOPES } from '../../contracts/oauth'

/**
 * This Worker as an OAuth 2.1 protected resource (MCP 2026-07-28, "Authorization"; RFC 9728;
 * RFC 6750 §3; decision D44). The authorization server is the control plane, at the same public
 * origin.
 *
 *   GET /.well-known/oauth-protected-resource/mcp   protected resource metadata (RFC 9728 §3.1, path form)
 *   GET /.well-known/oauth-protected-resource       the same document (the MCP fallback order's second URI)
 *
 * 401s from /mcp carry `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` (and
 * `error="invalid_token"` when a credential was sent); a tool call whose scopes the token lacks
 * is 403 with `error="insufficient_scope"` and the scopes it needs, so a client can step up.
 */

export const DEFAULT_PUBLIC_URL = 'https://vis.bitcru.sh'
export const PRM_PATHS = new Set(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'])

export interface ResourceConfig {
  /** The authorization server (control), = the public origin. */
  issuer: string
  /** This resource's canonical URI: what tokens must be issued for (their audience). */
  resource: string
  metadataUrl: string
}

export function resourceConfig(env: { PUBLIC_URL?: string }): ResourceConfig {
  const origin = (env.PUBLIC_URL?.trim() || DEFAULT_PUBLIC_URL).replace(/\/+$/, '')
  return { issuer: origin, resource: `${origin}/mcp`, metadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp` }
}

export function protectedResourceMetadata(cfg: ResourceConfig): Record<string, unknown> {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    // MCP: the smallest set that is useful; more is asked for by step-up (403 insufficient_scope).
    scopes_supported: [...OAUTH_DEFAULT_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'viz',
  }
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
  'Access-Control-Max-Age': '600',
}

export function servePrm(req: Request, cfg: ResourceConfig): Response {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS', ...CORS } })
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(protectedResourceMetadata(cfg)), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...CORS } })
}

/** A quoted-string for an auth-param: no quote or backslash or control character inside (RFC 9110 §11.2). */
const q = (s: string): string => `"${s.replace(/[\\"\u0000-\u001f\u007f]/g, ' ')}"`

/**
 * `WWW-Authenticate` for a 401 from /mcp. Without a credential: no error (RFC 6750 §3.1), the
 * metadata URL and the scopes to start with. With one that failed: `invalid_token` too.
 */
export function challenge401(cfg: ResourceConfig, presented: boolean, description?: string): string {
  const parts = [`realm="viz"`, `resource_metadata=${q(cfg.metadataUrl)}`, `scope=${q(OAUTH_DEFAULT_SCOPES.join(' '))}`]
  if (presented) parts.push('error="invalid_token"', ...(description ? [`error_description=${q(description)}`] : []))
  return `Bearer ${parts.join(', ')}`
}

/** `WWW-Authenticate` for a 403: the scopes this operation needs, all at once (MCP "Runtime Insufficient Scope Errors"). */
export function challenge403(cfg: ResourceConfig, scopes: readonly string[], description: string): string {
  return `Bearer error="insufficient_scope", scope=${q(scopes.join(' '))}, resource_metadata=${q(cfg.metadataUrl)}, error_description=${q(description)}`
}
