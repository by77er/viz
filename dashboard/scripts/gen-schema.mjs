// Writes schema/viz.dashboard.v1.schema.json from src/schema.ts.
// Run with: npm run gen:schema   (Node >= 22.18 strips TypeScript types natively)
import { writeFileSync } from 'node:fs'
import { dashboardSchema } from '../src/schema.ts'
const out = new URL('../schema/viz.dashboard.v1.schema.json', import.meta.url)
writeFileSync(out, JSON.stringify(dashboardSchema, null, 2) + '\n')
console.log('wrote', out.pathname)
