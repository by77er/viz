// Replays a recorded counterexample (results/bfs/<name>.json) step by step against another
// configuration, and says where and why it stops: the first step that configuration does not
// allow, what it allows instead, and whether any property fails on the way.
//
//   node bfs/replay.ts                 the replays below; writes results/REPLAY.md
//   node bfs/replay.ts <trace> <cfg>   one recorded trace against one experiment's configuration
//
// A step is matched by its exact label. Where the label differs only in an answer (the text
// after " = " or after a comma: `replace(X) = conflict, output deleted` vs `replace(X) =
// conflict`), the replay takes the configuration's step and says so ("substituted"). A step the
// configuration does not allow at all is skipped and reported ("skipped"); the replay goes on,
// so the rest of the trace shows whether the outcome changes.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Cfg, type St, PROPS, SAFETY, init, successors } from './model.ts'
import { AMENDED, D30, IMPL_V1, E, R1, R2, R3, R4 } from './run.ts'

const here = dirname(fileURLToPath(import.meta.url))

interface Outcome {
  trace: string
  against: string
  steps: { n: number; label: string; how: 'exact' | 'substituted' | 'skipped'; took?: string; instead?: string[]; failing: string[] }[]
  finalFailing: string[]
}

const stem = (l: string) => l.replace(/ = .*$/, '').replace(/,.*$/, '').replace(/ \([^()]*\)$/, '')
/** `loose` (replays with a `prefix` only): a drain PUT matches any bounds, a tail read any incarnation and watermark. */
const looseStem = (l: string) => stem(l).replace(/^(ledger( t\d)? drain: PUT segment) .*$/, '$1').replace(/^(query: tailRead\(s\d+), .*$/, '$1')

export interface ReplayOpts {
  /** Steps the configuration needs before the recorded trace can start (e.g. a registration), replayed first. */
  prefix?: string[]
}

export function replay(trace0: string[], c: Cfg, traceName: string, against: string, o: ReplayOpts = {}): Outcome {
  let frontier: St[] = [init(c)]
  const steps: Outcome['steps'] = []
  const trace = [...(o.prefix ?? []), ...trace0]
  const st = o.prefix ? looseStem : stem
  trace.forEach((label, i) => {
    const exact: St[] = []
    const near: { l: string; s: St }[] = []
    const avail = new Set<string>()
    for (const s of frontier) {
      successors(c, s, (l, ns) => {
        avail.add(l)
        if (l === label) exact.push(ns)
        else if (st(l) === st(label)) near.push({ l, s: ns })
      })
    }
    const dedup = (xs: St[]) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()]
    let how: 'exact' | 'substituted' | 'skipped'
    let took: string | undefined
    if (exact.length) { frontier = dedup(exact); how = 'exact' }
    else if (near.length) { frontier = dedup(near.map((x) => x.s)); how = 'substituted'; took = [...new Set(near.map((x) => x.l))].join(' | ') }
    else how = 'skipped'
    const failing = SAFETY.filter((p) => frontier.some((s) => !PROPS[p]!.holds(c, s)))
    steps.push({ n: i + 1, label: i < (o.prefix?.length ?? 0) ? `${label} [prefix: needed by this configuration]` : label, how, took, instead: how === 'skipped' ? [...avail].filter((l) => stem(l).split(/[ (]/)[0] === stem(label).split(/[ (]/)[0]).slice(0, 6) : undefined, failing })
  })
  return { trace: traceName, against, steps, finalFailing: steps.at(-1)?.failing ?? [] }
}

/** Without the stepwise sweep, purge and start, so the recorded traces' labels still apply. */
const ATOMIC: Partial<Cfg> = { sweepSteps: false, purgeSteps: false, startSteps: false }
const REG_COMMITTED = ['registerStream(s0, inc 1)']
const REG_LOGGED = ['registerStream(s0, inc 1)', 'ledger drain: PUT segment v1..v1', 'ledger drain: delete outbox rows v1..v1, advance logged', 'registration logged -> s0 accepts writes']
const REPLAYS: [string, string, Cfg, ReplayOpts?][] = [
  ['F13_impl_comp_adopts_old_output', 'F13 bounds, D30 (atomic sweep, no age floor)', { ...IMPL_V1, ...D30, ...ATOMIC, maxComp: 1 }],
  ['F14_impl_comp_conflict_delete', 'F14 bounds, D30 (atomic sweep, no age floor)', { ...IMPL_V1, ...D30, ...ATOMIC, maxSend: 1, maxJobs: 1, maxQ: 0, maxComp: 1, maxCJobs: 2, maxExp: 1, maxLL: 1 }],
  ['F15_sweeper_trusts_unlogged_registration', 'F15 bounds, D30 (atomic sweep, no age floor)', { ...AMENDED, ...D30, ...ATOMIC, maxSL: 1, maxLL: 1 }],
  ['IMPL_PLANNED_fixed', 'IMPL_PLANNED_fixed bounds, segment log as built (atomic start)', { ...E.find((e) => e.name === 'LOG_as_built')!.cfg, startSteps: false }],
  ['F6b_impl_now', 'F6(b) bounds with R1 (registration committed before writes), the registration put first', { ...E.find((e) => e.name === 'F6b_impl_now')!.cfg, ...R1 }, { prefix: REG_COMMITTED }],
  ['F6b_impl_now', 'F6(b) bounds with R2 (registration logged before writes), the registration put first', { ...E.find((e) => e.name === 'F6b_impl_now')!.cfg, ...R2 }, { prefix: REG_LOGGED }],
  ['F6b_impl_now', 'F6(b) bounds with R3 (logged before writes; coordinator settles), the registration put first', { ...E.find((e) => e.name === 'F6b_impl_now')!.cfg, ...R3 }, { prefix: REG_LOGGED }],
  ['F6b_impl_now', 'F6(b) bounds with R4 (committed before writes; coordinator re-checks), the registration put first', { ...E.find((e) => e.name === 'F6b_impl_now')!.cfg, ...R4 }, { prefix: REG_COMMITTED }],
  ['R1_safety', 'R1_safety\'s bounds with R4 (R1 + the coordinator re-check)', { ...E.find((e) => e.name === 'R1_safety')!.cfg, ...R4 }],
]

function show(o: Outcome): string[] {
  const md = [`### \`${o.trace}\` against ${o.against}`, '']
  for (const s of o.steps) {
    const tag = s.how === 'exact' ? '' : s.how === 'substituted' ? ` — **substituted**: ${s.took}` : ` — **skipped: not allowed here**${s.instead?.length ? ` (allowed instead: ${s.instead.join('; ')})` : ''}`
    md.push(`${s.n}. ${s.label}${tag}${s.failing.length ? ` — fails ${s.failing.join(', ')}` : ''}`)
  }
  const dev = o.steps.filter((s) => s.how !== 'exact')
  md.push('', dev.length
    ? `Deviations: ${dev.map((s) => `step ${s.n} ${s.how}`).join(', ')}. Properties failing after the last step: ${o.finalFailing.join(', ') || 'none'}.`
    : `Every step is allowed as recorded. Properties failing after the last step: ${o.finalFailing.join(', ') || 'none'}.`, '')
  return md
}

const isMain = process.argv[1]?.endsWith('replay.ts') ?? false
if (isMain) {
  const [t, cname] = process.argv.slice(2)
  const list: [string, string, Cfg, ReplayOpts?][] = t && cname ? [[t, cname, E.find((e) => e.name === cname)!.cfg]] : REPLAYS
  const md = ['# Recorded counterexamples replayed against other configurations (generated by bfs/replay.ts; do not edit)', '']
  for (const [name, against, c, opts] of list) {
    const rec = JSON.parse(readFileSync(join(here, '..', 'results', 'bfs', `${name}.json`), 'utf8')) as { trace: string[] }
    const o = replay(rec.trace, c, name, against, opts)
    const out = show(o)
    console.log(out.join('\n'))
    md.push(...out)
  }
  if (!(t && cname)) writeFileSync(join(here, '..', 'results', 'REPLAY.md'), md.join('\n'))
}
