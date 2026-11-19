/**
 * End to end for the span and log tables with stage 4's re-base in steps (README, "Re-bases and rebuilds
 * in steps"): `test/e2e-signals.ts`, dumped into `export/signals-steps/`, for PyIceberg and DuckDB to read
 * tables whose re-based files are in manifests written ahead of the commit that lists them.
 */
import { describe, it } from 'vitest'
import { signalsEndToEnd } from './e2e-signals'

describe('end to end with real span and log files and a real ledger, a re-base in steps', () => {
  it('publishes the span and log tables over four stages, the last re-base in steps, and dumps them for PyIceberg and DuckDB', () => signalsEndToEnd('signals-steps', true))
})
