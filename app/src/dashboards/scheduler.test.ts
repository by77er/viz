import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Limiter, Loader, MAX_IN_FLIGHT, type PanelOutcome, type PanelRequest } from './scheduler'

/** A request that settles when the test says so, and records whether it was started and whether it was told to stop. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  const d = {
    started: false,
    aborted: false,
    resolve,
    reject,
    /** Honours the abort signal, as `fetch` does. */
    run: (signal: AbortSignal) => {
      d.started = true
      signal.addEventListener('abort', () => {
        d.aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      })
      return promise
    },
    /** Ignores the abort signal: an answer that arrives although nobody waits for it. */
    deaf: (signal: AbortSignal) => {
      d.started = true
      signal.addEventListener('abort', () => (d.aborted = true))
      return promise
    },
  }
  return d
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('Limiter: at most six requests in flight', () => {
  it('the limit of a page is six', () => {
    expect(MAX_IN_FLIGHT).toBe(6)
    expect(new Limiter().max).toBe(6)
  })

  it('starts six of twenty, and one more each time one ends, in the order asked', async () => {
    const limiter = new Limiter()
    const signal = new AbortController().signal
    const tasks = Array.from({ length: 20 }, () => deferred<number>())
    const done = tasks.map((t, i) => limiter.run(t.run, signal).then(() => i))
    expect(tasks.filter((t) => t.started)).toHaveLength(6)
    expect(limiter.inFlight).toBe(6)
    expect(limiter.queued).toBe(14)
    tasks[2]!.resolve(0)
    await tick()
    expect(tasks.map((t) => t.started).indexOf(false)).toBe(7)
    expect(limiter.inFlight).toBe(6)
    for (const t of tasks) t.resolve(0)
    expect(await Promise.all(done)).toEqual(tasks.map((_, i) => i))
    expect(limiter.peak).toBe(6)
    expect(limiter.inFlight).toBe(0)
  })

  it('a failure frees its place like an answer', async () => {
    const limiter = new Limiter(2)
    const signal = new AbortController().signal
    const [a, b, c] = [deferred<number>(), deferred<number>(), deferred<number>()]
    const ra = limiter.run(a.run, signal).catch((e: Error) => e.message)
    void limiter.run(b.run, signal)
    void limiter.run(c.run, signal)
    expect(c.started).toBe(false)
    a.reject(new Error('refused'))
    expect(await ra).toBe('refused')
    await tick()
    expect(c.started).toBe(true)
    expect(limiter.peak).toBe(2)
  })

  it('a request cancelled while it waits is never sent', async () => {
    const limiter = new Limiter(1)
    const first = deferred<number>()
    const second = deferred<number>()
    const controller = new AbortController()
    void limiter.run(first.run, new AbortController().signal)
    const waiting = limiter.run(second.run, controller.signal).catch((e: Error) => e.name)
    controller.abort()
    expect(await waiting).toBe('AbortError')
    first.resolve(1)
    await tick()
    expect(second.started).toBe(false)
    expect(limiter.queued).toBe(0)
  })

  it('never more than the limit, whatever the order requests end in (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 40 }), async (max, order) => {
        const limiter = new Limiter(max)
        const signal = new AbortController().signal
        const tasks = order.map(() => deferred<number>())
        const all = Promise.allSettled(tasks.map((t) => limiter.run(t.run, signal)))
        const pending = new Set(tasks)
        for (const pick of order) {
          expect(limiter.inFlight).toBeLessThanOrEqual(max)
          const started = [...pending].filter((t) => t.started)
          if (started.length === 0) break
          const t = started[pick % started.length]!
          pending.delete(t)
          if (pick % 3 === 0) t.reject(new Error('x'))
          else t.resolve(1)
          await tick()
        }
        for (const t of pending) t.resolve(1)
        await all
        expect(limiter.peak).toBeLessThanOrEqual(max)
        expect(limiter.inFlight).toBe(0)
      }),
      { numRuns: 60 },
    )
  })
})

describe('Loader: what reaches a panel', () => {
  function setup(max = 6) {
    const delivered: { panel: string; outcome: PanelOutcome<string>; generation: number }[] = []
    const limiter = new Limiter(max)
    const loader = new Loader<string>(limiter, (panel, outcome, generation) => delivered.push({ panel, outcome, generation }))
    return { delivered, limiter, loader }
  }
  const panel = (id: string, ...queries: [string, (s: AbortSignal) => Promise<string>][]): PanelRequest<string> => ({ panel: id, queries: queries.map(([qid, run]) => ({ id: qid, run })) })

  it('a panel is delivered once every query it names has answered, by query id', async () => {
    const { delivered, loader } = setup()
    const [a, b] = [deferred<string>(), deferred<string>()]
    loader.load([panel('p', ['qa', a.run], ['qb', b.run])])
    a.resolve('A')
    await tick()
    expect(delivered).toEqual([])
    b.resolve('B')
    await tick()
    expect(delivered).toEqual([{ panel: 'p', outcome: { status: 'done', data: { qa: 'A', qb: 'B' } }, generation: 1 }])
  })

  it('one panel\'s failure is that panel\'s outcome; the others are delivered as if it had not happened', async () => {
    const { delivered, loader } = setup()
    const [good, bad, late] = [deferred<string>(), deferred<string>(), deferred<string>()]
    loader.load([panel('good', ['q', good.run]), panel('bad', ['q', bad.run]), panel('late', ['q', late.run])])
    bad.reject(new Error('422 unsupported'))
    await tick()
    good.resolve('G')
    late.resolve('L')
    await tick()
    const by = Object.fromEntries(delivered.map((d) => [d.panel, d.outcome]))
    expect(by.good).toEqual({ status: 'done', data: { q: 'G' } })
    expect(by.late).toEqual({ status: 'done', data: { q: 'L' } })
    expect(by.bad).toMatchObject({ status: 'error' })
    expect(((by.bad as { error: Error }).error).message).toBe('422 unsupported')
    expect(delivered).toHaveLength(3)
  })

  it('a query that throws before it is sent fails its panel only', async () => {
    const { delivered, loader } = setup()
    const ok = deferred<string>()
    loader.load([panel('thrower', ['q', () => { throw new Error('not sent') }]), panel('ok', ['q', ok.run])])
    ok.resolve('fine')
    await tick()
    expect(delivered.find((d) => d.panel === 'ok')!.outcome).toEqual({ status: 'done', data: { q: 'fine' } })
    expect(delivered.find((d) => d.panel === 'thrower')!.outcome.status).toBe('error')
  })

  it('a new load aborts the requests of the one before it, and never sends the ones still waiting', async () => {
    const { loader, limiter } = setup(2)
    const old = [deferred<string>(), deferred<string>(), deferred<string>()]
    loader.load(old.map((d, i) => panel(`p${i}`, ['q', d.run])))
    expect(old.map((d) => d.started)).toEqual([true, true, false])
    const next = deferred<string>()
    loader.load([panel('p0', ['q', next.run])])
    await tick()
    expect(old.map((d) => d.aborted)).toEqual([true, true, false])
    expect(old[2]!.started).toBe(false)
    expect(next.started).toBe(true)
    expect(limiter.inFlight).toBe(1)
  })

  it('a superseded answer is never delivered, even when its request ignored the abort and answers after the new one', async () => {
    const { delivered, loader } = setup()
    const stale = deferred<string>()
    const fresh = deferred<string>()
    loader.load([panel('p', ['q', stale.deaf])])
    loader.load([panel('p', ['q', fresh.deaf])])
    fresh.resolve('new range')
    await tick()
    stale.resolve('old range')
    await tick()
    expect(delivered.map((d) => d.outcome)).toEqual([{ status: 'done', data: { q: 'new range' } }])
    expect(delivered[0]!.generation).toBe(2)
  })

  it('a superseded failure is not delivered either', async () => {
    const { delivered, loader } = setup()
    const stale = deferred<string>()
    loader.load([panel('p', ['q', stale.deaf])])
    loader.load([])
    stale.reject(new Error('late failure'))
    await tick()
    expect(delivered).toEqual([])
  })

  it('answers in any order: only the last load of each panel is delivered (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.array(fc.nat(), { minLength: 1, maxLength: 12 }), async (loads, order) => {
        const { delivered, loader } = setup()
        const made: ReturnType<typeof deferred<string>>[] = []
        for (let g = 1; g <= loads; g++) {
          const d = deferred<string>()
          made.push(d)
          loader.load([panel('p', ['q', d.deaf])])
        }
        const left = made.map((d, i) => ({ d, i }))
        for (const pick of order) {
          if (left.length === 0) break
          const [{ d, i }] = left.splice(pick % left.length, 1) as [{ d: (typeof made)[number]; i: number }]
          d.resolve(`load ${i + 1}`)
          await tick()
        }
        for (const { d, i } of left) d.resolve(`load ${i + 1}`)
        await tick()
        expect(delivered.map((x) => x.outcome)).toEqual([{ status: 'done', data: { q: `load ${loads}` } }])
      }),
      { numRuns: 40 },
    )
  })

  it('leaving the view aborts what is in flight and delivers nothing afterwards', async () => {
    const { delivered, loader } = setup()
    const [a, b] = [deferred<string>(), deferred<string>()]
    loader.load([panel('a', ['q', a.run]), panel('b', ['q', b.deaf])])
    loader.cancel()
    b.resolve('too late')
    await tick()
    expect(a.aborted).toBe(true)
    expect(b.aborted).toBe(true)
    expect(delivered).toEqual([])
    expect(loader.signal).toBeNull()
  })

  it('a panel\'s own cancellation is delivered as that panel\'s error; the load goes on', async () => {
    const { delivered, loader } = setup()
    const own = new AbortController()
    const [a, b] = [deferred<string>(), deferred<string>()]
    loader.load([{ ...panel('a', ['q', a.run]), signal: own.signal }, panel('b', ['q', b.run])])
    own.abort('cancelled')
    await tick()
    expect(delivered.map((d) => [d.panel, d.outcome.status])).toEqual([['a', 'error']])
    b.resolve('B')
    await tick()
    expect(delivered.find((d) => d.panel === 'b')!.outcome).toEqual({ status: 'done', data: { q: 'B' } })
  })

  it('a dashboard of twenty panels of two queries has six requests in flight at most, and every panel is delivered', async () => {
    const { delivered, loader, limiter } = setup()
    let inFlight = 0
    let most = 0
    const run = async () => {
      inFlight++
      most = Math.max(most, inFlight)
      await tick()
      inFlight--
      return 'ok'
    }
    loader.load(Array.from({ length: 20 }, (_, i) => panel(`p${i}`, ['a', run], ['b', run])))
    for (let i = 0; i < 40 && delivered.length < 20; i++) await tick()
    expect(most).toBe(6)
    expect(limiter.peak).toBe(6)
    expect(delivered).toHaveLength(20)
  })
})
