// Writes openapi.json from src/openapi.ts.   node scripts/gen-openapi.mjs
import { writeFileSync } from 'node:fs'
import { buildOpenApi } from '../src/openapi.ts'

writeFileSync(new URL('../openapi.json', import.meta.url), JSON.stringify(buildOpenApi(), null, 2) + '\n')
console.log('wrote openapi.json')
