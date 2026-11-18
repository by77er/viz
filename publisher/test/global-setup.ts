/**
 * Runs in Node, outside workerd. The tests cannot write files, so the end-to-end test
 * sends the simulated bucket here, object by object, and this writes each one under
 * `publisher/export/` with the same relative layout as in the bucket.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import type { TestProject } from 'vitest/node'

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = resolve(import.meta.dirname, '..', 'export')
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '')
      const target = resolve(dir, rel)
      if (req.method === 'DELETE' && target.startsWith(dir + sep)) {
        // Clears one subtree, so a run never mixes with the dump of an earlier one.
        rmSync(target, { recursive: true, force: true })
      } else if (req.method === 'PUT' && target.startsWith(dir + sep)) {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, Buffer.concat(chunks))
      } else {
        res.statusCode = 400
      }
      res.end()
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  project.provide('exportUrl', `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  project.provide('exportDir', join(dir))
  return () => new Promise<void>((ok) => server.close(() => ok()))
}
