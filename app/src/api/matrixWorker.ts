/**
 * A dedicated worker that fetches a range query and reads it into typed arrays (api/matrix.ts)
 * off the main thread. The main thread gets the Float64Arrays by transfer (no copy) and the
 * body's text for the raw JSON form. Anything that is not a successful matrix comes back as
 * the response's status, headers and text, and the main thread reports it exactly as it
 * reports any other answer (api/client.ts).
 */
import { MatrixParser, NotAMatrix } from './matrix'

export interface WorkerRequest {
  id: number
  url: string
  headers: [string, string][]
  body: string
}
export interface WorkerAbort {
  id: number
  abort: true
}

export type WorkerReply =
  | { id: number; kind: 'matrix'; status: number; headers: [string, string][]; text: string; series: { metric: Record<string, string>; times: Float64Array; values: Float64Array; range: [number, number] | null; json: string | null }[]; warnings: string[]; infos: string[]; fast: boolean }
  | { id: number; kind: 'response'; status: number; statusText: string; headers: [string, string][]; text: string }
  | { id: number; kind: 'error'; name: string; message: string }

const scope = self as unknown as { onmessage: ((e: MessageEvent<WorkerRequest | WorkerAbort>) => void) | null; postMessage: (m: WorkerReply, transfer?: Transferable[]) => void }
const controllers = new Map<number, AbortController>()

scope.onmessage = (e) => {
  const m = e.data
  if ('abort' in m) {
    controllers.get(m.id)?.abort()
    return
  }
  void run(m)
}

async function run(m: WorkerRequest): Promise<void> {
  const ac = new AbortController()
  controllers.set(m.id, ac)
  try {
    const res = await fetch(m.url, { method: 'POST', headers: m.headers, body: m.body, signal: ac.signal })
    const headers = [...res.headers] as [string, string][]
    if (!res.ok || !res.body) {
      scope.postMessage({ id: m.id, kind: 'response', status: res.status, statusText: res.statusText, headers, text: await res.text() })
      return
    }
    const parser = new MatrixParser()
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(value)
    }
    try {
      const mx = parser.finish()
      const series = mx.series.map((s) => ({ metric: s.metric, times: s.times, values: s.values, range: s.valuesRange, json: s.valuesRange ? null : s.valuesText() }))
      const transfer: Transferable[] = []
      for (const s of series) transfer.push(s.times.buffer as ArrayBuffer, s.values.buffer as ArrayBuffer)
      scope.postMessage({ id: m.id, kind: 'matrix', status: res.status, headers, text: mx.text, series, warnings: mx.warnings, infos: mx.infos, fast: mx.fast }, [...new Set(transfer)])
    } catch (err) {
      if (!(err instanceof NotAMatrix)) throw err
      scope.postMessage({ id: m.id, kind: 'response', status: res.status, statusText: res.statusText, headers, text: parser.received() })
    }
  } catch (err) {
    const e = err as { name?: string; message?: string }
    scope.postMessage({ id: m.id, kind: 'error', name: e?.name ?? 'Error', message: e?.message ?? String(err) })
  } finally {
    controllers.delete(m.id)
  }
}
