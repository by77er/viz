/** The measurement harness itself: a repeated start (an HTTP retry) never runs an exercise twice. */
import { runDurableObjectAlarm } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import type { FileEntry } from '../../../contracts/ledger'
import fixture from '../../../publisher/test/fixtures/fixture.json'

it('a job started twice runs once; an alarm that comes again after it finished does nothing', async () => {
  const [key, f] = Object.entries((fixture as unknown as { files: Record<string, { tenant: string; entry: FileEntry; b64: string }> }).files).find(([, x]) => x.entry.table === 'metric_samples')!
  await env.BUCKET.put(key, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)))
  const stub = env.COMMITTER.get(env.COMMITTER.idFromName('job-once'))
  const args = { catalog: 'r2-native', ns: 'bench', name: 'jobs', table: 'metric_samples', n: 2, template: { tenant: f.tenant, entry: f.entry }, run: 'once' }
  expect(await stub.startJob('latency', args)).toEqual({ state: 'pending', started: true })
  expect(await stub.startJob('latency', args)).toEqual({ state: 'pending', started: false })
  expect(await runDurableObjectAlarm(stub)).toBe(true)
  const done = (await stub.jobResult()) as unknown as { state: string; result: { n: number; ids: number[] } }
  expect(done.state).toBe('done')
  expect(done.result.n).toBe(2)
  expect(await stub.startJob('latency', args)).toEqual({ state: 'done', started: false })
  expect(await runDurableObjectAlarm(stub)).toBe(false)
  const v = await env.COMMITTER.get(env.COMMITTER.idFromName('v')).verify({ catalog: 'r2-native', ns: 'bench', name: 'jobs', table: 'metric_samples', intended: done.result.ids })
  expect(v.problems).toEqual([])
  expect(v.chain).toHaveLength(2)
})
