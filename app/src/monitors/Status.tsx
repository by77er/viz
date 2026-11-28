import { useEffect, useState } from 'react'
import { formatAge } from '../explore/waiting'
import type { StatusWords } from './model'

/** The system's status component: the mark (shape, then colour), and the words in `ink`, times as `vz-qty`. One run of text. */
export function Status({ words, testId }: { words: StatusWords; testId?: string }) {
  return (
    <span className="vz-status" data-state={words.mark || undefined} data-testid={testId}>
      <span>
        {words.parts.map((p, i) =>
          p.qty ? (
            <span key={i} className="vz-qty">
              {p.text}
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </span>
    </span>
  )
}

/** The words of a status as one run of text with its times in `vz-qty`, for a state line or a sentence (the mark is drawn by the caller). */
export function Words({ words }: { words: StatusWords }) {
  return (
    <>
      {words.parts.map((p, i) =>
        p.qty ? (
          <time key={i} className="vz-qty">
            {p.text}
          </time>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

/** "12 s ago", "just now", "14 min ago": how old a time the API gave is, kept current every second. */
export function Ago({ ms }: { ms: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [ms])
  const age = formatAge(Math.max(0, (now - ms) / 1000), ms / 1000, now)
  return (
    <span data-testid="ago">
      {age.n === '' ? age.rest : <span className="vz-qty">{age.n}</span>}
      {age.n === '' ? '' : age.rest}
    </span>
  )
}
