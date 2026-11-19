// hyparquet (pure JavaScript, no code shared with viz) is installed for the benchmarks; the
// signal tests read compaction outputs with it.
declare module '*/hyparquet/src/index.js' {
  export function parquetMetadata(file: ArrayBuffer): { num_rows: bigint; row_groups: unknown[]; created_by?: string; key_value_metadata?: { key: string; value?: string }[] }
  export function parquetReadObjects(options: { file: ArrayBuffer }): Promise<Record<string, any>[]>
}
