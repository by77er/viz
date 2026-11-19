import { describe, expect, it } from 'vitest'
import { fromGrafana, lint, resolve, validate } from '../src/index.ts'
import { readJson } from './helpers.ts'

const fixture = readJson('test/fixtures/grafana-node-exporter.json')
const { spec, warnings, errors } = fromGrafana(fixture)
const codes = warnings.map((w) => w.code)
const has = (code: string, re: RegExp) => warnings.some((w) => w.code === code && re.test(w.message))

describe('fromGrafana (classic dashboard JSON)', () => {
  it('produces a valid spec', () => {
    expect(errors).toEqual([])
    expect(validate(spec)).toEqual({ ok: true, errors: [] })
  })
  it('maps metadata, time and tags', () => {
    expect(spec.metadata).toEqual({
      id: 'r_ydddl_pwk',
      title: 'Node Exporter / Hosts',
      intent: 'Host health for the API fleet: CPU, memory, disk and network per node. For on-call engineers deciding whether a host is the cause of an incident.',
      tags: ['linux', 'node-exporter', 'sre-team'],
    })
    expect(spec.time).toEqual({ from: 'now-6h', to: 'now', refresh: '1m' })
  })
  it('maps templating to variables, renaming and rewriting references', () => {
    expect(Object.keys(spec.variables!)).toEqual(['job', 'node', 'mount', 'resolution', 'filter'])
    expect(spec.variables!.job).toEqual({ kind: 'query', label: 'Job', query: { lang: 'promql', expr: 'label_values(node_uname_info, job)' }, default: 'node' })
    expect(spec.variables!.node).toEqual({ kind: 'query', label: 'Host', query: { lang: 'promql', expr: 'label_values(node_uname_info{job="$job"}, instance)' }, multi: true, includeAll: true, default: ['*'] })
    expect(spec.variables!.resolution).toEqual({ kind: 'interval', label: 'Resolution', values: ['1m', '5m', '1h'], default: '5m' })
    expect(spec.variables!.filter).toEqual({ kind: 'text', label: 'Filter' })
    expect(has('renamed-variable', /"Node" was renamed to "node"/)).toBe(true)
    expect(has('unsupported-variable', /"DS_PROMETHEUS" of type "datasource"/)).toBe(true)
    expect(has('unsupported-variable', /"Filters" of type "adhoc"/)).toBe(true)
    expect(has('variable-regex', /"Node" filters its values with regex/)).toBe(true)
    expect(has('variable-values', /"resolution".*\$__auto_interval_resolution/)).toBe(true)
  })
  it('a multi variable used with "=" becomes single-valued, with a warning', () => {
    expect(spec.variables!.mount).toEqual({ kind: 'enum', label: 'Mount', values: ['/', '/var', '/data'], default: '/' })
    expect(has('variable-not-multi', /"mount"/)).toBe(true)
  })
  it('maps panels by type', () => {
    expect(Object.fromEntries(Object.entries(spec.panels).map(([id, p]) => [id, p.kind]))).toEqual({
      cpu_busy: 'stat', ram_used: 'stat', notes: 'text', cpu_basic: 'timeseries', memory_basic: 'timeseries',
      disk_space_used: 'table', disk_io_latency: 'heatmap', error_log_rate: 'timeseries',
    })
    expect(spec.panels.cpu_busy).toEqual({
      kind: 'stat',
      title: 'CPU Busy',
      description: 'Share of CPU time not idle across the selected nodes. Above 85% the fleet is saturated.',
      unit: 'ratio',
      queries: ['cpu_busy_a'],
      options: { reduce: 'mean', sparkline: true },
      thresholds: [{ above: 0.7, level: 'warn' }, { above: 0.85, level: 'crit' }],
    })
    expect(spec.panels.cpu_basic).toMatchObject({ unit: 'ratio', options: { stack: true, style: 'area', yMin: 0 }, queries: ['cpu_basic_a'] })
    expect(spec.panels.memory_basic).toMatchObject({ unit: 'bytes', options: { stack: true, style: 'area' }, queries: ['memory_basic_a', 'memory_basic_b'] })
    expect(spec.panels.disk_io_latency).toMatchObject({ kind: 'heatmap', unit: 's' })
    expect(spec.panels.notes).toMatchObject({ kind: 'text', content: expect.stringContaining('## Host health') })
  })
  it('rewrites Grafana variable syntax and globals in queries', () => {
    expect(spec.queries!.cpu_busy_a).toEqual({ lang: 'promql', expr: '1 - avg(rate(node_cpu_seconds_total{job="$job", instance=~"$node", mode="idle"}[$__rate]))' })
    expect(spec.queries!.ram_used_a!.expr).toContain('instance=~"${node}"')
    expect(spec.queries!.memory_basic_a).toEqual({ lang: 'promql', expr: 'node_memory_MemTotal_bytes{job="${job}", instance=~"$node"} - node_memory_MemAvailable_bytes{job="${job}", instance=~"$node"}', legend: 'used {{instance}}' })
    expect(spec.queries!.disk_space_used_a).toMatchObject({ instant: true })
    expect(spec.queries!.disk_io_latency_a!.expr).toContain('[$resolution]')
    expect(spec.queries!.error_log_rate_a).toMatchObject({ lang: 'logql', legend: '{{instance}}' })
    const r = resolve(spec, { variables: { node: ['a:9100', 'b:9100'], job: 'node' } })
    expect(r.issues).toEqual([])
    expect(r.queries.cpu_busy_a!.expr).toBe('1 - avg(rate(node_cpu_seconds_total{job="node", instance=~"a:9100|b:9100", mode="idle"}[5m]))')
  })
  it('maps rows and gridPos to the layout tree', () => {
    expect(spec.layout).toEqual({
      kind: 'rows',
      rows: [
        { title: 'Overview', items: [{ kind: 'grid', columns: 24, items: [
          { panel: 'cpu_busy', x: 0, y: 0, w: 6, h: 5 },
          { panel: 'ram_used', x: 6, y: 0, w: 6, h: 5 },
          { panel: 'notes', x: 18, y: 0, w: 6, h: 5 },
        ] }] },
        { title: 'CPU and memory', items: [{ kind: 'grid', columns: 24, items: [
          { panel: 'cpu_basic', x: 0, y: 0, w: 12, h: 8 },
          { panel: 'memory_basic', x: 12, y: 0, w: 12, h: 8 },
        ] }] },
        { title: 'Disk, network and logs', items: [{ kind: 'grid', columns: 24, items: [
          { panel: 'disk_space_used', x: 0, y: 0, w: 12, h: 8 },
          { panel: 'disk_io_latency', x: 12, y: 0, w: 6, h: 8 },
          { panel: 'error_log_rate', x: 0, y: 8, w: 24, h: 6 },
        ] }] },
      ],
    })
  })
  it('never drops anything silently: every loss is a warning', () => {
    expect(has('unsupported-panel', /"CPU by mode" \(piechart\)/)).toBe(true)
    expect(has('unsupported-panel', /"Kernel errors" \(logs\)/)).toBe(true)
    expect(has('approximated-panel', /"RAM Used" \(gauge\) was imported as a "stat"/)).toBe(true)
    expect(has('thresholds', /"RAM Used".*percentage thresholds/)).toBe(true)
    expect(has('hidden-target', /"CPU Basic".*target B/)).toBe(true)
    expect(has('unsupported-target', /"Disk Space Used".*target C.*cloudwatch/)).toBe(true)
    expect(has('unsupported-target', /"Error log rate".*target B uses \$__interval_ms/)).toBe(true)
    expect(has('unknown-unit', /"Error log rate".*"furlongs"/)).toBe(true)
    expect(has('missing-unit', /"Memory Basic"/)).toBe(false) // unit came from yaxes
    expect(has('dropped-feature', /"CPU Basic".*field overrides/)).toBe(true)
    expect(has('dropped-feature', /"Disk Space Used".*transformations/)).toBe(true)
    expect(has('dropped-feature', /Annotation queries/)).toBe(true)
    expect(has('dropped-feature', /Dashboard links/)).toBe(true)
    expect(has('missing-description', /3 panel\(s\).*: ram_used, memory_basic, disk_io_latency\./)).toBe(true)
    // 13 Grafana panels: 3 rows, 8 imported, 2 unsupported
    expect(Object.keys(spec.panels)).toHaveLength(8)
    expect(codes.filter((c) => c === 'unsupported-panel')).toHaveLength(2)
    // every panel, target and variable in the fixture is either in the spec or named in a warning
    const text = JSON.stringify(spec) + JSON.stringify(warnings)
    for (const title of ['CPU Busy', 'RAM Used', 'CPU by mode', 'Notes', 'CPU Basic', 'Memory Basic', 'Disk Space Used', 'Disk IO latency', 'Kernel errors', 'Error log rate']) expect(text).toContain(title)
    for (const name of ['DS_PROMETHEUS', 'job', 'Node', 'mount', 'resolution', 'filter', 'Filters']) expect(text).toContain(name)
  })
  it('lint points at what the import could not fill in', () => {
    const l = lint(spec)
    expect(l.filter((w) => w.code === 'weak-description').map((w) => w.path)).toEqual(['/panels/ram_used/description', '/panels/memory_basic/description', '/panels/disk_io_latency/description'])
    expect(l.some((w) => w.code === 'stat-without-thresholds' && w.path === '/panels/ram_used')).toBe(true)
    expect(l.some((w) => w.code === 'unused-variable' && w.path === '/variables/filter')).toBe(true)
  })
  it('accepts the { dashboard: … } API envelope and degenerate input', () => {
    expect(fromGrafana({ dashboard: fixture, meta: {} }).spec).toEqual(spec)
    for (const input of [null, {}, [], 'x', { panels: 'nope', templating: { list: [null, 1] } }]) {
      const r = fromGrafana(input)
      expect(r.errors).toEqual([])
      expect(r.spec.metadata.title).toBe('Imported dashboard')
      expect(r.warnings.some((w) => w.code === 'missing-intent')).toBe(true)
    }
  })
  it('a dashboard without rows becomes a single grid; ids stay unique', () => {
    const r = fromGrafana({
      title: 'Flat', uid: '9-flat',
      panels: [
        { type: 'timeseries', title: 'Same', gridPos: { x: 0, y: 3, w: 12, h: 8 }, targets: [{ expr: 'up', refId: 'A' }], fieldConfig: { defaults: { unit: 'short' } } },
        { type: 'timeseries', title: 'Same', gridPos: { x: 12, y: 3, w: 30, h: 8 }, targets: [{ expr: 'up == 0', refId: 'A' }] },
        { type: 'stat', title: '', id: 7, targets: [] },
      ],
    })
    expect(r.errors).toEqual([])
    expect(r.spec.metadata.id).toBe('d_9_flat')
    expect(r.spec.layout).toEqual({ kind: 'grid', columns: 24, items: [{ panel: 'same', x: 0, y: 0, w: 12, h: 8 }, { panel: 'same_2', x: 0, y: 0, w: 24, h: 8 }] })
    expect(Object.keys(r.spec.queries!)).toEqual(['same_a', 'same_2_a'])
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['empty-panel', 'missing-description', 'missing-intent', 'missing-unit'])
  })
})
