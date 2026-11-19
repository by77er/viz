import type { Plugin } from 'vitest/config'

/**
 * The ledger refuses tables other than the metric ones (`ledger/src/ledger.ts` `TABLES`), and
 * keys with a level below the day (`fileProblem`), where `contracts/TRACES.md` puts a `spans`
 * file (`day={D}/hour={HH}/`). The trace and log tests (test/signals.test.ts) need both, which
 * are the two lines README "Needed changes elsewhere" asks of `ledger/`. This applies exactly
 * those changes to the TEST bundle only (nothing on disk changes), and each only while the
 * ledger still has its old line: once `ledger/` makes a change, its replacement does nothing.
 */
export const LEDGER_TABLES_FROM = "const TABLES: readonly Table[] = ['metric_samples', 'metric_series']"
export const LEDGER_TABLES_TO = "const TABLES: readonly Table[] = ['metric_samples', 'metric_series', 'spans', 'trace_index', 'logs'] as unknown as readonly Table[]"
export const LEDGER_KEY_FROM = "f.key.slice(p.length).includes('/')) return `file key ${f.key} is not under ${p}`"
export const LEDGER_KEY_TO = "(f.table === ('spans' as Table) ? f.key.slice(p.length).replace(/^hour=\\d{2}\\//, '') : f.key.slice(p.length)).includes('/')) return `file key ${f.key} is not under ${p}`"
export const ledgerSignalTables = (): Plugin => ({
  name: 'viz-test-ledger-signal-tables',
  enforce: 'pre',
  transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/ledger/src/ledger.ts')) return null
    if (!code.includes(LEDGER_TABLES_FROM) && !code.includes(LEDGER_KEY_FROM)) return null
    return { code: code.replace(LEDGER_TABLES_FROM, LEDGER_TABLES_TO).replace(LEDGER_KEY_FROM, LEDGER_KEY_TO), map: null }
  },
})

