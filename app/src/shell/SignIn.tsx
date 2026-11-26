import { useId, useRef, useState } from 'react'
import { useSession, type SignedOutReason } from './session'

/** What is missing, by why the form is on screen (FirstRun: the title says what is missing, the sentence what to do). */
const WORDS: Record<SignedOutReason, { title: string; text: string }> = {
  none: {
    title: 'No API key in this tab',
    text: 'viz shows a tenant\'s metrics to whoever holds one of its API keys. Paste a key that has the read scope.',
  },
  refused: {
    title: 'The API no longer accepts this tab\'s key',
    text: 'It may have been disabled, rotated or expired, and it has been removed from this tab. Paste a key that is valid now.',
  },
  left: {
    title: 'Signed out',
    text: 'The key is gone from this tab. Paste a key to sign in again.',
  },
  'no-answer': {
    title: 'The API did not answer',
    text: 'Whether this page needs an API key could not be asked. Paste a key and sign in, which asks again.',
  },
}

/**
 * Sign-in with a viz API key. The key goes to the API once, as an `Authorization` header, to
 * ask whose it is (control's `whoami`); only a key that can read metrics is kept, in this tab
 * (shell/session.tsx). The field has no name and the form posts nowhere, so the key cannot
 * end up in an address even if the script fails.
 */
export function SignIn({ reason, detail }: { reason: SignedOutReason; detail?: string }) {
  const { signIn, recheck } = useSession()
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ where: 'field' | 'notice'; message: string } | null>(null)
  const words = WORDS[reason]

  const submit = async () => {
    if (busy) return
    setBusy(true)
    const result = await signIn(key)
    // On success this form is gone: the page it stood in for is on screen.
    if (result.ok) return
    setBusy(false)
    setProblem({ where: result.where, message: result.message })
    if (result.where === 'field') input.current?.focus()
  }

  return (
    <div className="vz-page">
      <section className="vz-start" aria-labelledby={`${id}-title`} data-testid="sign-in" data-reason={reason}>
        <h1 className="vz-section-title" id={`${id}-title`}>
          {words.title}
        </h1>
        <p>
          {words.text}
          {reason === 'no-answer' && detail ? ` (${detail})` : ''}
        </p>
        <form
          className="vz-stack"
          method="post"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="vz-field">
            <label className="vz-label" htmlFor={`${id}-key`}>
              API key
            </label>
            <input
              ref={input}
              id={`${id}-key`}
              className="vz-input"
              data-mono=""
              type={show ? 'text' : 'password'}
              value={key}
              onChange={(e) => {
                setKey(e.target.value)
                if (problem?.where === 'field') setProblem(null)
              }}
              aria-invalid={problem?.where === 'field' ? true : undefined}
              aria-describedby={`${id}-help`}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              data-testid="sign-in-key"
            />
            {problem?.where === 'field' ? (
              <span className="vz-help" data-error="" id={`${id}-help`} role="alert" data-testid="sign-in-error">
                <span className="vz-mark" data-state="critical" />
                {problem.message}
              </span>
            ) : (
              <span className="vz-help" id={`${id}-help`}>
                Kept in this tab until you sign out or close it, and sent only to <span className="vz-qty">{window.location.host}</span>, in a request header. It is never
                put in an address, so links you share do not carry it.
              </span>
            )}
          </div>
          <label className="vz-check">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            The key is shown as typed
          </label>
          <div className="vz-notice-group">
            <div className="vz-controls">
              <button type="submit" className="vz-button" data-tone="blue" aria-busy={busy} data-testid="sign-in-submit">
                Sign in
              </button>
              {reason === 'no-answer' && (
                <button type="button" className="vz-button" onClick={recheck} data-testid="sign-in-ask-again">
                  Ask the API again
                </button>
              )}
            </div>
            {problem?.where === 'notice' && (
              <div className="vz-notice" role="alert" data-testid="sign-in-notice">
                <span className="vz-mark" data-state="critical" />
                <p>{problem.message}</p>
                <button type="button" className="vz-button" data-size="sm" data-quiet="" onClick={() => setProblem(null)}>
                  Dismiss
                </button>
              </div>
            )}
          </div>
        </form>
      </section>
    </div>
  )
}
