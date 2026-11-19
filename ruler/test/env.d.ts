declare namespace Cloudflare {
  interface Env {
    RULER: DurableObjectNamespace<import('./harness').TestRuler>
    NOTIFIER: DurableObjectNamespace<import('./harness').TestNotifier>
    RULER_INDEX: DurableObjectNamespace<import('./harness').TestRulerIndex>
    CONFIG: KVNamespace
    TENANT: DurableObjectNamespace<import('../../control/src/tenant').Tenant>
    QUERY: Fetcher
    INGEST: Fetcher
    /** viz-ingest's RecordedSamples entrypoint, as production binds it (test/harness.ts `FakeRecordedSamples`). */
    SINK: import('../../contracts/ingest').RecordedSamplesRpc
    /** An ingest release without the entrypoint. */
    OLD_SINK: import('../../contracts/ingest').RecordedSamplesRpc
    /** The entrypoint through a binding naming a caller it does not allow. */
    OTHER_SINK: import('../../contracts/ingest').RecordedSamplesRpc
    /** Node-side sink for files the independent readers check (vitest.config.ts). */
    CAPTURE: Fetcher
  }
}

declare module '*?raw' {
  const text: string
  export default text
}

/** Vite's `import.meta.glob`, used to load golden files that may not exist yet. */
interface ImportMeta {
  glob(pattern: string, options: { eager: true; import: 'default' }): Record<string, unknown>
}
