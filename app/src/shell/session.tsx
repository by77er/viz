import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PromApiError, PromClient } from '../api/client'
import type { Identity } from '../api/types'

/**
 * Sign-in: a viz API key, checked with control's `GET /api/v1/control/whoami` and kept for the
 * life of the tab.
 *
 * - The key lives in this module's memory and in `sessionStorage` (so a reload keeps the
 *   person signed in; closing the tab forgets it). It is never in `localStorage`, a cookie, a
 *   URL, a query key or a log line, and it is sent only as an `Authorization` header to the
 *   API the page was served with.
 * - The page shows data only once the API has said who the key is, or cannot be asked.
 */

/** Where the key is kept: `sessionStorage`, this tab only. */
export const KEY_STORE = 'viz.key'
/** Where the app before this one kept the API address and a bearer token, for good: removed on start. */
const LEGACY_STORE = 'viz.settings'
/** The scope the query API checks (edge/src/auth.ts, `authenticate(…, 'read')`). */
export const READ_SCOPE = 'read'

export type Session =
  /** Asking the API who the key is; nothing is shown yet. */
  | { status: 'checking' }
  /**
   * Signed in. `identity` is null when the API could not say who the key is: it has no
   * sign-in at all (`unchecked: 'no-control'`, HTTP 404: a Prometheus-compatible API that is
   * not viz), or it did not answer (`unchecked: 'no-answer'`) and the key from this tab is
   * used as it is; each query then says whether the key is accepted.
   */
  | { status: 'in'; identity: Identity | null; unchecked?: 'no-control' | 'no-answer' }
  /** Not signed in, and why the sign-in form is on screen. */
  | { status: 'out'; reason: SignedOutReason; detail?: string }

export type SignedOutReason =
  /** No key in this tab. */
  | 'none'
  /** The API does not accept the key this tab had (or one a query was sent with). */
  | 'refused'
  /** The person signed out. */
  | 'left'
  /** No key in this tab, and the API could not be asked whether one is needed. */
  | 'no-answer'

/** What asking `whoami` came to: the identity, or the HTTP status (0 when nothing answered). */
export type WhoamiOutcome = { identity: Identity } | { status: number; message: string }

/**
 * What the session is after `whoami` was asked with the key this tab holds (possibly none).
 * Pure: the rules of who gets in.
 */
export function sessionAfter(hasKey: boolean, outcome: WhoamiOutcome): Session {
  if ('identity' in outcome) return { status: 'in', identity: outcome.identity }
  const { status, message } = outcome
  // The API says the key is no good (or that one is needed): the form, and the reason.
  if (status === 401 || status === 403) return { status: 'out', reason: hasKey ? 'refused' : 'none' }
  // An API with no control plane has no keys to sign in with.
  if (status === 404) return { status: 'in', identity: null, unchecked: 'no-control' }
  // Nothing usable came back. With a key from this tab, carry on: a query will say if the key
  // is refused. Without one, there is nothing to carry on with.
  return hasKey ? { status: 'in', identity: null, unchecked: 'no-answer' } : { status: 'out', reason: 'no-answer', detail: message }
}

export type SignInResult =
  | { ok: true }
  /** `field`: the key itself is the problem (say so at the field); `notice`: the key could not be checked. */
  | { ok: false; where: 'field' | 'notice'; message: string }

/** What a key typed into the form comes to. Pure. */
export function signInResult(outcome: WhoamiOutcome): SignInResult {
  if ('identity' in outcome) {
    if (outcome.identity.scopes.includes(READ_SCOPE)) return { ok: true }
    const scopes = outcome.identity.scopes
    return {
      ok: false,
      where: 'field',
      message: `This key is valid for ${outcome.identity.tenant} but cannot read metrics: it has ${scopes.length ? `the ${scopes.join(', ')} scope${scopes.length === 1 ? '' : 's'}` : 'no scopes'}, and Explore needs read. Use a key with the read scope.`,
    }
  }
  const { status, message } = outcome
  if (status === 401 || status === 403) {
    return { ok: false, where: 'field', message: `The API did not accept this key (HTTP ${status}). It may be mistyped, cut short, disabled or expired. Paste the whole key: viz_, the key's id, and its secret.` }
  }
  if (status === 404) return { ok: false, where: 'notice', message: 'This API has no sign-in (HTTP 404 from /api/v1/control/whoami), so the key could not be checked.' }
  return { ok: false, where: 'notice', message: status === 0 ? `The key could not be checked: ${message}. Nothing was stored.` : `The key could not be checked: the API answered HTTP ${status}. Nothing was stored.` }
}

/** A key as it is shown after sign-in: its public part, `viz_<keyId>`, never the secret. */
export function keyPrefix(key: string): string {
  const m = /^(viz_[A-Za-z0-9]+)_/.exec(key)
  return m ? `${m[1]}_…` : '…'
}

function readKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORE) ?? ''
  } catch {
    return ''
  }
}
function writeKey(key: string): void {
  try {
    if (key) sessionStorage.setItem(KEY_STORE, key)
    else sessionStorage.removeItem(KEY_STORE)
  } catch {
    // Storage is not available (private mode, a policy): the key stays in memory for this page.
  }
}
function forgetLegacy(): void {
  try {
    localStorage.removeItem(LEGACY_STORE)
  } catch {
    // Nothing to forget.
  }
}

/** The API's address. Empty: the origin the page was served from, which is how viz serves it. A build can set another for development. */
const BASE_URL = (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? ''

async function ask(client: PromClient, signal?: AbortSignal): Promise<WhoamiOutcome> {
  try {
    return { identity: await client.whoami({ signal }) }
  } catch (e) {
    if (e instanceof PromApiError) return { status: e.status, message: e.message }
    throw e
  }
}

interface SessionContextValue {
  session: Session
  /** The client every request goes through: it carries the key. */
  client: PromClient
  /** Changes whenever the key does; safe in query keys (the key itself never is). */
  connectionId: string
  /** Whether this tab holds a key. */
  hasKey: boolean
  /** The public part of the key in use, or "" without one. */
  keyLabel: string
  /** Checks a key with the API and, if it can read, keeps it for this tab. */
  signIn: (key: string) => Promise<SignInResult>
  /** Forgets the key. `refused`: a query was answered 401 with it. */
  signOut: (reason?: 'left' | 'refused') => void
  /** Asks again who the key is (after the API did not answer). */
  recheck: () => void
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children, onChange }: { children: ReactNode; onChange?: () => void }) {
  const [key, setKey] = useState(() => {
    forgetLegacy()
    return readKey()
  })
  const [version, setVersion] = useState(0)
  const [session, setSession] = useState<Session>({ status: 'checking' })
  const client = useMemo(() => new PromClient({ baseUrl: BASE_URL, token: key }), [key])
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // On start, and again when asked: who is this tab's key? (Without a key the answer says
  // whether the API needs one: the development mock does not.)
  const [checkId, setCheckId] = useState(0)
  const checked = useRef(-1)
  useEffect(() => {
    if (checked.current === checkId) return
    checked.current = checkId
    const first = new PromClient({ baseUrl: BASE_URL, token: readKey() })
    const hasKey = readKey() !== ''
    void ask(first).then((outcome) => {
      const next = sessionAfter(hasKey, outcome)
      if (next.status === 'out' && hasKey) {
        writeKey('')
        setKey('')
        setVersion((v) => v + 1)
      }
      setSession(next)
    })
  }, [checkId])

  const signIn = useCallback(async (typed: string): Promise<SignInResult> => {
    const candidate = typed.trim()
    if (candidate === '') return { ok: false, where: 'field', message: 'Paste an API key: viz_, the key\'s id, and its secret.' }
    const outcome = await ask(new PromClient({ baseUrl: BASE_URL, token: candidate }))
    const result = signInResult(outcome)
    if (result.ok && 'identity' in outcome) {
      writeKey(candidate)
      setKey(candidate)
      setVersion((v) => v + 1)
      setSession({ status: 'in', identity: outcome.identity })
    }
    return result
  }, [])

  const signOut = useCallback((reason: 'left' | 'refused' = 'left') => {
    writeKey('')
    setKey('')
    setVersion((v) => v + 1)
    setSession({ status: 'out', reason })
    // Whatever was fetched with the key goes with it.
    onChangeRef.current?.()
  }, [])

  const recheck = useCallback(() => {
    setSession({ status: 'checking' })
    setCheckId((n) => n + 1)
  }, [])

  const value = useMemo<SessionContextValue>(
    () => ({ session, client, connectionId: `${BASE_URL}#${version}`, hasKey: key !== '', keyLabel: key ? keyPrefix(key) : '', signIn, signOut, recheck }),
    [session, client, version, key, signIn, signOut, recheck],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const v = useContext(SessionContext)
  if (!v) throw new Error('useSession outside SessionProvider')
  return v
}
