import { SCHEMA_KINDS, formatNumber, getSchema } from '../../../dashboard/src/index.ts'
import { CURSOR_ARG, MAX_TOKENS_ARG, isoOf } from '../args'
import type { MonitorView } from '../clients'
import { budgetOf, type Item } from '../page'
import type { Session } from '../session'
import { type ToolDef, ToolError, pagedResult } from '../tool'
import { cell, clean, cleanDeep, cleanLabels, MAX } from '../untrusted'
import { cursorOf } from './common'

/** JSON split into line groups of at most `size` characters: pages concatenate back to the exact text. */
export function jsonItems(prefix: string, value: unknown, size = 1200): Item[] {
  const lines = JSON.stringify(value, null, 1).split('\n')
  const items: Item[] = []
  let buf = ''
  const flush = () => {
    if (buf) items.push({ key: `${prefix}${items.length}`, text: buf, data: { part: items.length, text: buf } })
    buf = ''
  }
  for (const l of lines) {
    if (buf.length + l.length + 1 > size) flush()
    buf += l + '\n'
  }
  flush()
  return items
}

// ---- get_schema ----

export const getSchemaTool: ToolDef = {
  name: 'get_schema',
  title: 'Get the dashboard schema',
  description: `The viz.dashboard/v1 JSON Schema, or the slice for one part (${SCHEMA_KINDS.join(', ')}), with one valid example, the panel catalog, the units and the built-in variables. Read the slice you need before writing (the whole schema is about 3,500 tokens; a panel kind is about 500). Also available as the resources viz://schema/dashboard/v1 and viz://catalog/panels.`,
  scopes: [],
  defaultTokens: 2000,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: [...SCHEMA_KINDS], default: 'dashboard', description: 'Which part.' },
      max_tokens: MAX_TOKENS_ARG(2000),
      cursor: CURSOR_ARG,
    },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    const kind = (args.kind as (typeof SCHEMA_KINDS)[number] | undefined) ?? 'dashboard'
    const slice = getSchema(kind)
    const items = jsonItems('schema', { schema: slice.schema, example: slice.example, units: slice.units, builtins: slice.builtins, catalog: slice.catalog })
    return pagedResult({
      tool: this.name,
      s,
      args,
      maxTokens: budgetOf(args.max_tokens, this.defaultTokens),
      header: `get_schema: ${kind}; JSON in ${items.length} part(s); concatenate the parts in order to get the whole document.\n`,
      items,
      offset: c?.o ?? 0,
      meta: { kind, kinds: slice.kinds },
    })
  },
}

// ---- monitors (the ruler) ----

const STATE_ORDER: Record<string, number> = { firing: 0, pending: 1, error: 2, no_data: 3, unknown: 4, ok: 5 }
const MONITOR_ID = '^[A-Za-z0-9_:.-]{1,200}$'

function needRuler(s: Session) {
  if (!s.monitors) throw new ToolError('not-available-yet', 'Monitors are not connected to this deployment (no ruler binding).', 'Ask the operator to bind RULER.', { status: 501 })
  return s.monitors
}

function monitorData(m: MonitorView): Record<string, unknown> {
  return {
    id: clean(m.id, { max: MAX.name }),
    name: clean(m.name, { max: MAX.title }),
    state: stateOf(m.state),
    value: typeof m.value === 'number' ? m.value : null,
    firingSince: m.firingSince,
    thresholdText: m.thresholdText === null ? null : clean(m.thresholdText, { max: MAX.text }),
    expr: clean(m.expr, { kind: 'expr', max: MAX.long }),
    description: m.description ? clean(m.description, { max: MAX.text }) : null,
    message: m.message ? clean(m.message, { max: MAX.text }) : null,
    // A runbook link is configuration a person wrote; it is shown defanged and never followed.
    runbook: m.runbookUrl ? clean(m.runbookUrl, { max: MAX.text }) : null,
    owner: m.owner ? clean(m.owner, { max: 80 }) : null,
    labels: m.labels ? cleanLabels(m.labels) : {},
    annotations: m.annotations ? cleanLabels(m.annotations) : {},
    health: m.health ?? null,
    lastError: m.lastError ? clean(m.lastError, { max: MAX.error }) : null,
    lastEvaluationMs: m.lastEvaluationMs ?? null,
    silencedUntil: m.silencedUntil ?? null,
    acknowledged: m.acknowledged ? { by: clean(m.acknowledged.by, { max: 80 }), at: m.acknowledged.at } : null,
    alerts: (m.alerts ?? []).length,
  }
}

/** The ruler's state, as one of the known words; anything else is "unknown". */
const stateOf = (x: unknown): string => (typeof x === 'string' && x in STATE_ORDER ? x : 'unknown')
const num = (x: unknown): string => (typeof x === 'number' ? formatNumber(x) : '-')

const since = (ms: number | null | undefined): string => (typeof ms === 'number' && Number.isFinite(ms) ? isoOf(Math.floor(ms / 1000)) : '-')

export const listMonitors: ToolDef = {
  name: 'list_monitors',
  title: 'List monitors',
  description: 'The tenant\'s monitors with their state (firing, pending, error, no_data, unknown, ok), firing ones first: name, condition, current value, since when, health and last error, silenced or acknowledged. filter "attention" lists only those that need a look.',
  scopes: ['monitors:read'],
  defaultTokens: 1000,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    properties: { filter: { type: 'string', enum: ['all', 'attention', 'silenced'], default: 'all' }, max_tokens: MAX_TOKENS_ARG(1000), cursor: CURSOR_ARG },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    const ruler = needRuler(s)
    s.usage.upstreamCalls++
    const r = await ruler.list((args.filter as 'all' | undefined) ?? 'all')
    if (!r.ok) throw new ToolError('ruler-failed', `The ruler did not list the monitors (HTTP ${r.status}).`, r.status === 401 || r.status === 403 ? 'Use a key with the monitors:read scope.' : 'Retry in a moment.', { status: r.status === 401 || r.status === 403 ? r.status : 502, detail: `error: ${clean(r.error, { max: MAX.error })}` })
    const list = [...(r.data.monitors ?? [])].sort((a, b) => STATE_ORDER[stateOf(a.state)]! - STATE_ORDER[stateOf(b.state)]! || String(a.name).localeCompare(String(b.name)))
    const counts: Record<string, number> = {}
    for (const m of list) counts[stateOf(m.state)] = (counts[stateOf(m.state)] ?? 0) + 1
    const items: Item[] = list.map((m) => ({
      key: String(m.id),
      text: `[${stateOf(m.state).toUpperCase()}] ${cell(m.name, MAX.title)} (${cell(m.id, MAX.name)}) | ${m.thresholdText ? cell(m.thresholdText, 120) : clean(m.expr, { kind: 'expr', max: 160 })} | value ${num(m.value)} | since ${since(m.firingSince)} | health ${cell(m.health ?? '-', 10)}${m.lastError ? ` (${cell(m.lastError, 160)})` : ''}${m.silencedUntil ? ` | silenced until ${since(m.silencedUntil)}` : ''}${m.acknowledged ? ' | acknowledged' : ''}\n`,
      data: monitorData(m),
    }))
    return pagedResult({
      tool: this.name,
      s,
      args,
      maxTokens: budgetOf(args.max_tokens, this.defaultTokens),
      header: `list_monitors: ${list.length} monitor(s): ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}.\n`,
      items,
      offset: c?.o ?? 0,
      meta: { counts },
    })
  },
}

export const getMonitor: ToolDef = {
  name: 'get_monitor',
  title: 'Get a monitor',
  description: 'One monitor in full: condition and expression, state and value, health and last error, labels and annotations (the runbook link is shown defanged and never followed), each active alert with its labels and value, and its recent history of transitions and notifications.',
  scopes: ['monitors:read'],
  defaultTokens: 1000,
  readOnly: true,
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', pattern: MONITOR_ID, description: 'Monitor id from list_monitors, e.g. "mon_0123456789abcdef".' }, max_tokens: MAX_TOKENS_ARG(1000), cursor: CURSOR_ARG },
  },
  async run(s, args) {
    const c = cursorOf(this.name, args)
    const ruler = needRuler(s)
    s.usage.upstreamCalls++
    const r = await ruler.get(String(args.id))
    if (!r.ok) throw new ToolError(r.status === 404 ? 'not-found' : 'ruler-failed', r.status === 404 ? 'No such monitor.' : `The ruler did not answer (HTTP ${r.status}).`, r.status === 404 ? 'Use an id from list_monitors; ids of other tenants never resolve.' : 'Retry in a moment.', { status: r.status === 404 || r.status === 401 || r.status === 403 ? r.status : 502, detail: `error: ${clean(r.error, { max: MAX.error })}` })
    const m = r.data.monitor
    const d = monitorData(m)
    const items: Item[] = [
      ...(m.alerts ?? []).map((a, i) => ({ key: `a${i}`, text: `alert [${a.state === 'firing' ? 'FIRING' : 'PENDING'}] value ${num(a.value)} active since ${since(a.activeAt)} labels ${Object.entries(a.labels).map(([k, v]) => `${cell(k, MAX.name)}=${JSON.stringify(cell(v))}`).join(',')}\n`, data: { state: a.state === 'firing' ? 'firing' : 'pending', value: typeof a.value === 'number' ? a.value : null, activeAt: a.activeAt, firingSince: a.firingSince, labels: cleanLabels(a.labels) } })),
      ...(r.data.history?.entries ?? []).slice(-50).reverse().map((h, i) => ({ key: `h${i}`, text: `history ${since(h.at)} ${cell(h.kind ?? 'event', 30)} ${cell(JSON.stringify(Object.fromEntries(Object.entries(h).filter(([k]) => k !== 'at' && k !== 'kind'))), 240)}\n`, data: cleanDeep(h, MAX.text) })),
    ]
    const prelude =
      c ? '' :
        `name: ${cell(m.name, MAX.title)}\nstate: ${stateOf(m.state)}; value ${num(m.value)}; firing since ${since(m.firingSince)}; health ${cell(m.health ?? '-', 10)}\n` +
        `condition: ${m.thresholdText ? cell(m.thresholdText, MAX.text) : '-'}\nexpr: ${clean(m.expr, { kind: 'expr', max: MAX.long })}\n` +
        (m.description ? `description: ${cell(m.description)}\n` : '') +
        (m.lastError ? `last error: ${cell(m.lastError, MAX.error)}\n` : '') +
        (m.runbookUrl ? `runbook (not a link): ${cell(m.runbookUrl)}\n` : '') +
        (Object.keys(m.annotations ?? {}).length ? `annotations: ${Object.entries(m.annotations!).map(([k, v]) => `${cell(k, MAX.name)}=${JSON.stringify(cell(v))}`).join(', ')}\n` : '')
    return pagedResult({
      tool: this.name,
      s,
      args,
      maxTokens: budgetOf(args.max_tokens, this.defaultTokens),
      header: `get_monitor: ${(m.alerts ?? []).length} active alert(s), ${(r.data.history?.entries ?? []).length} history entr(ies)${r.data.history?.dropped ? `, ${r.data.history.dropped} older dropped` : ''}.\n`,
      items,
      offset: c?.o ?? 0,
      prelude,
      meta: { state: stateOf(m.state) },
      data: { monitor: d },
    })
  },
}

// ---- annotate ----

export const annotate: ToolDef = {
  name: 'annotate',
  title: 'Annotate a timeline',
  description: 'Add a note at a time (a deploy, an incident, a finding). Not available yet: viz has no annotation store, so this always refuses and writes nothing. Put a finding in a proposal\'s message or reason instead.',
  scopes: ['dashboards:write'],
  defaultTokens: 300,
  readOnly: false,
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 2000, description: 'The note.' },
      time: { type: ['string', 'number'], maxLength: 64, description: 'When; default now.' },
      dashboard: { type: 'string', maxLength: 48, description: 'Dashboard id to scope the note to.' },
      max_tokens: MAX_TOKENS_ARG(300),
    },
  },
  async run() {
    throw new ToolError('not-available-yet', 'Annotations are not available yet: there is no annotation store, and nothing was written.', 'Record the note in a proposal (write_dashboard mode "propose", in "message" or a change\'s "reason"), or in a text panel.', { status: 501 })
  },
}
