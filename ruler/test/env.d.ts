declare namespace Cloudflare {
  interface Env {
    RULER: DurableObjectNamespace<import('./harness').TestRuler>
    NOTIFIER: DurableObjectNamespace<import('./harness').TestNotifier>
    RULER_INDEX: DurableObjectNamespace<import('./harness').TestRulerIndex>
    CONFIG: KVNamespace
    /** Node-side sink for files the independent readers check (vitest.config.ts). */
    CAPTURE: Fetcher
  }
}

declare module '*?raw' {
  const text: string
  export default text
}
