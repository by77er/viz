// Spike S0: how is a Durable Object billed when it wakes periodically?
// For each interval there are three objects, each in its own class so usage can be read per namespace:
//   A<n>  wakes itself by alarm every n seconds and does one SQLite write
//   P<n>  a pinger (not measured): wakes by alarm every n seconds and calls B<n>
//   B<n>  is woken only by that request and does one SQLite write
// Every object stops re-arming at a deadline, so nothing here runs forever.
import { DurableObject } from 'cloudflare:workers'

const INTERVALS = [1, 5, 15, 60] as const
type Env = Record<string, DurableObjectNamespace<Base>> & { KEY: string }

class Base extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS s (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`)
  }
  private get(k: string): number | null {
    const r = this.ctx.storage.sql.exec(`SELECT v FROM s WHERE k = ?`, k).toArray()[0]
    return r ? (r.v as number) : null
  }
  private set(k: string, v: number): void {
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO s (k, v) VALUES (?, ?)`, k, v)
  }
  private bump(): void {
    const now = Date.now()
    this.ctx.storage.sql.exec(`INSERT INTO s (k, v) VALUES ('count', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1`)
    if (this.get('first') === null) this.set('first', now)
    this.set('last', now)
  }
  async start(intervalSec: number, deadlineMs: number, target: string | null): Promise<void> {
    this.set('interval', intervalSec)
    this.set('deadline', deadlineMs)
    this.set('pinger', target ? 1 : 0)
    if (target) await this.ctx.storage.put('target', target)
    await this.ctx.storage.setAlarm(Date.now() + intervalSec * 1000)
  }
  async stop(): Promise<void> {
    this.set('deadline', 0)
    await this.ctx.storage.deleteAlarm()
  }
  async ping(): Promise<void> {
    this.bump()
  }
  async alarm(): Promise<void> {
    const deadline = this.get('deadline') ?? 0
    if (Date.now() >= deadline) return
    this.bump()
    await this.ctx.storage.setAlarm(Date.now() + (this.get('interval') ?? 60) * 1000)
    if (this.get('pinger')) {
      const target = (await this.ctx.storage.get<string>('target'))!
      await this.env[target]!.get(this.env[target]!.idFromName('target')).ping()
    }
  }
  async status(): Promise<Record<string, number | null>> {
    return { count: this.get('count'), first: this.get('first'), last: this.get('last'), deadline: this.get('deadline'), alarm: await this.ctx.storage.getAlarm() }
  }
}

export class A1 extends Base {}
export class A5 extends Base {}
export class A15 extends Base {}
export class A60 extends Base {}
export class P1 extends Base {}
export class P5 extends Base {}
export class P15 extends Base {}
export class P60 extends Base {}
export class B1 extends Base {}
export class B5 extends Base {}
export class B15 extends Base {}
export class B60 extends Base {}

const stub = (env: Env, cls: string, name: string) => env[cls]!.get(env[cls]!.idFromName(name))

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (req.headers.get('x-key') !== env.KEY) return new Response('not found', { status: 404 })
    if (url.pathname === '/start') {
      const hours = Math.min(48, Number(url.searchParams.get('hours') ?? 26))
      const deadline = Date.now() + hours * 3600_000
      for (const n of INTERVALS) {
        await stub(env, `A${n}`, 'self').start(n, deadline, null)
        await stub(env, `B${n}`, 'target').stop() // creates it, armed with nothing
        await stub(env, `P${n}`, 'pinger').start(n, deadline, `B${n}`)
      }
      return Response.json({ started: true, deadline })
    }
    if (url.pathname === '/stop') {
      for (const n of INTERVALS) for (const [c, name] of [['A', 'self'], ['P', 'pinger'], ['B', 'target']] as const) await stub(env, `${c}${n}`, name).stop()
      return Response.json({ stopped: true })
    }
    if (url.pathname === '/status') {
      const out: Record<string, unknown> = {}
      for (const n of INTERVALS) for (const [c, name] of [['A', 'self'], ['P', 'pinger'], ['B', 'target']] as const) out[`${c}${n}`] = await stub(env, `${c}${n}`, name).status()
      return Response.json(out)
    }
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
