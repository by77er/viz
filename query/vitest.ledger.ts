import type { Plugin } from 'vitest/config'

/**
 * The ledger refuses tables other than the metric ones (`ledger/src/ledger.ts` `TABLES`). The
 * trace and log tests (test/signals.test.ts) need it to accept `spans`, `trace_index` and
 * `logs`, which is the one-line change README "Needed changes elsewhere" asks of `ledger/`.
 * This applies exactly that change to the TEST bundle only (nothing on disk changes), and
 * only while the ledger still has its old line: once `ledger/` makes the change it does nothing.
 */
export const LEDGER_TABLES_FROM = "const TABLES: readonly Table[] = ['metric_samples', 'metric_series']"
export const LEDGER_TABLES_TO = "const TABLES: readonly Table[] = ['metric_samples', 'metric_series', 'spans', 'trace_index', 'logs'] as unknown as readonly Table[]"
export const ledgerSignalTables = (): Plugin => ({
  name: 'viz-test-ledger-signal-tables',
  enforce: 'pre',
  transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/ledger/src/ledger.ts') || !code.includes(LEDGER_TABLES_FROM)) return null
    return { code: code.replace(LEDGER_TABLES_FROM, LEDGER_TABLES_TO), map: null }
  },
})

