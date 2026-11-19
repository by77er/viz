/** End to end for the span and log tables, every publish whole: `test/e2e-signals.ts`, dumped into `export/signals/`. */
import { describe, it } from 'vitest'
import { signalsEndToEnd } from './e2e-signals'

describe('end to end with real span and log files and a real ledger', () => {
  it('publishes the span and log tables over four stages and dumps them for PyIceberg and DuckDB', () => signalsEndToEnd('signals', false))
})
