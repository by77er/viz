/**
 * Evaluator plumbing: the adapter from the single-call form to the batch form, and the
 * permissive stand-in for save-time PromQL validation.
 */
import type { BatchEvaluator, EvalRequest, EvalResult, Evaluator, Validator } from '../contracts-proposal/rules.v2'

export function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500)
}

/**
 * A `BatchEvaluator` over an `Evaluator` that takes one expression per call.
 *
 * Requests run one after another, in order, which is what a caller that depended on the
 * single-call form saw. A request that throws fails alone. When `signal` aborts, the request
 * in flight and every later one fail with the abort reason and the results gathered so far
 * are returned at once.
 */
export function batchFromSingle(single: Evaluator): BatchEvaluator {
  return {
    async evaluate(requests: EvalRequest[], opts?: { signal?: AbortSignal }): Promise<EvalResult[]> {
      const signal = opts?.signal
      let onAbort: (() => void) | undefined
      const aborted = new Promise<never>((_, reject) => {
        if (!signal) return
        if (signal.aborted) return reject(signal.reason)
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      aborted.catch(() => {})
      const out: EvalResult[] = []
      try {
        for (const r of requests) {
          const started = Date.now()
          try {
            if (signal?.aborted) throw signal.reason
            const result = await Promise.race([single.instant(r.promql, r.timeMs), aborted])
            out.push({ id: r.id, ok: true, result, durationMs: Date.now() - started })
          } catch (e) {
            out.push({ id: r.id, ok: false, error: errorText(e), durationMs: Date.now() - started })
          }
        }
      } finally {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      }
      return out
    },
  }
}

/**
 * Stands in for the engine's validator until its binding exists. It accepts every
 * non-empty expression and reports no selectors, so a syntactically wrong expression is
 * still found only at its first evaluation (`health: err` with the engine's message).
 */
export const permissiveValidator: Validator = {
  async check(promql) {
    if (promql.trim() === '') return { ok: false, errors: [{ message: 'expression is empty', fix: 'Give the PromQL expression to evaluate.' }], selectors: [] }
    return { ok: true, errors: [], selectors: [] }
  },
}
