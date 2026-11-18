export {}

declare module 'vitest' {
  export interface ProvidedContext {
    /** A local HTTP sink that writes what it is sent under `exportDir` (test/global-setup.ts). */
    exportUrl: string
    exportDir: string
  }
}
