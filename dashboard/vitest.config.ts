import { defineConfig } from 'vitest/config'
// At most two workers: the machine is shared (AGENTS.md).
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node', maxWorkers: 2 } })
