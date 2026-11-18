import { describe, expect, it } from 'vitest'
import { compileConfig, groupKey, groupLabels, inhibitedBy, matchRoutes, silencedBy, compileSilenceMatchers, validateSilence } from '../src/amconfig'
import { classify, maxWindowMs } from '../src/classify'
import { slackPayload, webhookPayload } from '../src/payload'
import { parseRuleFile } from '../src/rules'
import { DEFAULT_RULER_CONFIG } from '../src/ruler'
import { expandTemplate, fmtG, goFloat, parseTemplate } from '../src/template'
import { alignedTick, backoffMs, fingerprint, formatDuration, hash64, parseDuration } from '../src/util'

const M = 60_000
const H = 60 * M

describe('durations and time', () => {
  it('parses Prometheus durations and rejects malformed ones', () => {
    expect(parseDuration('5m')).toBe(5 * M)
    expect(parseDuration('1h30m')).toBe(90 * M)
    expect(parseDuration('1d2h3m4s5ms')).toBe(86_400_000 + 2 * H + 3 * M + 4000 + 5)
    expect(parseDuration('0')).toBe(0)
    expect(parseDuration('1w')).toBe(7 * 86_400_000)
    for (const bad of ['', '5', 'm5', '5m1h', '1.5m', '5 m', '-5m']) expect(parseDuration(bad)).toBeNull()
    expect(formatDuration(90 * M)).toBe('1h30m')
  })

  it('aligns ticks to offset + k * interval and never returns a time after now', () => {
    expect(alignedTick(1000, 60, 7)).toBe(967)
    expect(alignedTick(967, 60, 7)).toBe(967)
    expect(alignedTick(966, 60, 7)).toBe(907)
    for (let now = 0; now < 500; now += 13) {
      const t = alignedTick(now, 60, 7)
      expect(t).toBeLessThanOrEqual(now)
      expect(now - t).toBeLessThan(60)
      expect(((t - 7) % 60 + 60) % 60).toBe(0)
    }
  })

  it('backs off exponentially with jitter that depends only on the seed', () => {
    const a = [1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, 1000, 20_000, 'k1'))
    expect(a).toEqual([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, 1000, 20_000, 'k1')))
    expect(a).not.toEqual([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, 1000, 20_000, 'k2')))
    a.forEach((d, i) => {
      const step = Math.min(20_000, 1000 * 2 ** i)
      expect(d).toBeGreaterThanOrEqual(step / 2)
      expect(d).toBeLessThan(step)
    })
  })

  it('fingerprints a label set independently of key order', () => {
    expect(fingerprint({ a: '1', b: '2' })).toBe(fingerprint({ b: '2', a: '1' }))
    expect(fingerprint({ a: '1', b: '2' })).not.toBe(fingerprint({ a: '12', b: '' }))
    expect(hash64('x')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('templates', () => {
  const data = { labels: { instance: 'web-1', job: 'api', n: '1234567' }, externalLabels: { cluster: 'eu' }, value: 1234567 }
  const expand = (text: string, d = data) => {
    const r = parseTemplate(text)
    if (!r.ok) throw new Error(`${r.error.message} | ${r.error.fix}`)
    return expandTemplate(r.template, d)
  }

  it('expands $labels, $value, $externalLabels and the dotted forms', () => {
    expect(expand('{{ $labels.instance }} of {{$labels.job}} in {{ $externalLabels.cluster }}')).toBe('web-1 of api in eu')
    expect(expand('{{ .Labels.instance }}/{{ .ExternalLabels.cluster }}/{{ .Value }}')).toBe('web-1/eu/1.234567e+06')
    expect(expand('plain text')).toBe('plain text')
    // A label the series does not have expands to nothing (Prometheus sets missingkey=zero).
    expect(expand('[{{ $labels.nope }}]')).toBe('[]')
    // upstream TestAlertingRule uses a string literal action: {{"c"}}ritical
    expect(expand('{{"c"}}ritical')).toBe('critical')
    expect(expand('a  {{- $labels.job -}}  b')).toBe('aapib')
  })

  it('prints $value the way Go prints a float64', () => {
    const cases: [number, string][] = [
      [1, '1'], [0.5, '0.5'], [100000, '100000'], [1e6, '1e+06'], [1234567, '1.234567e+06'], [0.0001, '0.0001'], [0.00001, '1e-05'],
      [1e21, '1e+21'], [-2.5, '-2.5'], [Infinity, '+Inf'], [-Infinity, '-Inf'], [NaN, 'NaN'], [0, '0'], [123456.789, '123456.789'],
    ]
    for (const [v, want] of cases) expect(goFloat(v)).toBe(want)
    expect(fmtG(1234.5678, 4)).toBe('1235')
    expect(fmtG(12345.678, 4)).toBe('1.235e+04')
    expect(fmtG(0.00001234, 4)).toBe('1.234e-05')
    expect(fmtG(100, 4)).toBe('100')
  })

  // Expected outputs are the ones in prometheus/template/template_test.go (fetched 2026-11-18).
  it('humanize family matches the upstream expectations', () => {
    const each = (fn: string, inputs: number[]) => inputs.map((v) => expand(`{{ ${fn} $value }}`, { ...data, value: v })).join(':') + ':'
    expect(each('humanize', [0.0, 1.0, 1234567.0, 0.12])).toBe('0:1:1.235M:120m:')
    expect(each('humanize', [0, -1, 1, 1234567])).toBe('0:-1:1:1.235M:')
    expect(each('humanize1024', [0.0, 1.0, 1048576.0, 0.12])).toBe('0:1:1Mi:0.12:')
    expect(each('humanize1024', [0, -1, 1, 1234567])).toBe('0:-1:1:1.177Mi:')
    expect(each('humanizeDuration', [0, 1, 60, 3600, 86400, 86400 + 3600, -(86400 * 2 + 3600 * 3 + 60 * 4 + 5), 899.99]))
      .toBe('0s:1s:1m 0s:1h 0m 0s:1d 0h 0m 0s:1d 1h 0m 0s:-2d 3h 4m 5s:14m 59s:')
    expect(each('humanizeDuration', [0.1, 0.0001, 0.12345, 60.1, 60.5, 1.2345, 12.345])).toBe('100ms:100us:123.5ms:1m 0s:1m 0s:1.234s:12.35s:')
    expect(each('humanizeDuration', [0, -1, 1, 1234567])).toBe('0s:-1s:1s:14d 6h 56m 7s:')
    expect(each('humanizePercentage', [-0.22222, 0.0, 0.1234567, 1.23456])).toBe('-22.22%:0%:12.35%:123.5%:')
    expect(each('humanizePercentage', [0, -1, 1, 1234567])).toBe('0%:-100%:100%:1.235e+08%:')
    expect(each('humanizeTimestamp', [0, -1, 1, 1234567])).toBe('1970-01-01 00:00:00 +0000 UTC:1969-12-31 23:59:59 +0000 UTC:1970-01-01 00:00:01 +0000 UTC:1970-01-15 06:56:07 +0000 UTC:')
    expect(expand('{{ humanizeTimestamp $value }}', { ...data, value: 1435065584.128 })).toBe('2015-06-23 13:19:44.128 +0000 UTC')
    for (const fn of ['humanize', 'humanize1024', 'humanizeDuration', 'humanizeTimestamp']) {
      expect(each(fn, [Infinity, -Infinity, NaN])).toBe('+Inf:-Inf:NaN:')
    }
  })

  it('supports pipelines, string arguments, printf and case functions', () => {
    expect(expand('{{ $value | humanize }}')).toBe('1.235M')
    expect(expand('{{ $labels.n | humanize }}')).toBe('1.235M')
    expect(expand('{{ printf "%.2f" $value }}')).toBe('1234567.00')
    expect(expand('{{ $value | printf "%.1f%%" }}', { ...data, value: 12.345 })).toBe('12.3%')
    expect(expand('{{ printf "%s has %v (%d, %q, %e, %g)" $labels.instance $value 3 "x" 1500.5 0.5 }}')).toBe('web-1 has 1.234567e+06 (3, "x", 1.500500e+03, 0.5)')
    expect(expand('{{ printf "%5.1f|%-6s|%05d" 3.14159 "ab" 42 }}')).toBe('  3.1|ab    |00042')
    expect(expand('{{ "aa bb CC" | title }}')).toBe('Aa Bb CC') // upstream: Title
    expect(expand('{{ $labels.job | toUpper }}{{ "ABC" | toLower }}')).toBe('APIabc')
  })

  it('turns a runtime failure into the Prometheus error text instead of throwing', () => {
    expect(expand('{{ humanize $labels.instance }}')).toBe(`<error expanding template: can't convert "web-1" to float>`)
  })

  it('rejects everything outside the subset, with a position and a fix', () => {
    const rejected = [
      '{{ if lt $value 80.0 }}critical{{ else }}warning{{ end }}',
      '{{ range $labels }}x{{ end }}',
      '{{ with query "up" }}{{ . | first | value }}{{ end }}',
      '{{ query "up" }}',
      '{{ $externalURL }}',
      '{{ $labels }}',
      '{{ $x := 1 }}',
      '{{ $foo }}',
      '{{ .Foo }}',
      '{{ humanize }}',
      '{{ humanize $value $value }}',
      '{{ $value | $labels.x }}',
      '{{ printf "%x" $value }}',
      '{{ printf "%s %s" $value }}',
      '{{ printf $value }}',
      '{{ (humanize $value) }}',
      '{{ $value',
      '{{ }}',
      '{{ "unterminated }}',
      '{{ safeHtml $value }}',
      '{{ $labels.bad-name }}',
      '{{ constructor }}',
      '{{ __proto__ $value }}',
    ]
    for (const text of rejected) {
      const r = parseTemplate(text)
      expect(r.ok, text).toBe(false)
      if (!r.ok) {
        expect(r.error.message.length, text).toBeGreaterThan(5)
        expect(r.error.fix.length, text).toBeGreaterThan(5)
        expect(r.error.offset).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('classification (design §7)', () => {
  const w = (q: string) => maxWindowMs(q).windowMs

  it('extracts the largest range, subquery range and offset from PromQL text', () => {
    expect(w('up')).toBe(5 * M) // an instant selector reads the lookback window
    expect(w('up == 0')).toBe(5 * M)
    expect(w('rate(http_requests_total[5m])')).toBe(5 * M)
    expect(w('rate(http_requests_total[1m])')).toBe(1 * M) // a range selector replaces the lookback
    expect(w('rate(a[5m]) / rate(b[1h])')).toBe(H)
    expect(w('sum by (job) (rate(a{x="y"}[10m]))')).toBe(10 * M)
    expect(w('sum(rate(a[10m])) by (job)')).toBe(10 * M)
    expect(w('up offset 1h')).toBe(H + 5 * M)
    expect(w('rate(a[5m] offset 1d)')).toBe(86_400_000 + 5 * M)
    expect(w('max_over_time(rate(a[5m])[30m:1m])')).toBe(35 * M) // subquery range adds to the inner window
    expect(w('max_over_time(rate(a[5m])[30m:])')).toBe(35 * M)
    expect(w('max_over_time(rate(a[5m])[1h:5m] offset 2h)')).toBe(3 * H + 5 * M)
    expect(w('avg_over_time(max_over_time(a[10m])[1h:])[6h:]')).toBe(7 * H + 10 * M)
    expect(w('a[1h30m]')).toBe(90 * M)
    expect(w('rate(a[5m]) > on (instance) group_left (team) b')).toBe(5 * M)
    expect(w('a and b[2h] or c unless d')).toBe(2 * H)
    expect(w('histogram_quantile(0.99, sum by (le) (rate(lat_bucket[15m])))')).toBe(15 * M)
    expect(w('vector(1)')).toBe(0)
    expect(w('time() - 3600 > 1e3')).toBe(0)
    expect(w('absent(up{job="x"})')).toBe(5 * M)
    expect(w('up offset -5m')).toBe(5 * M) // a negative offset never shrinks the window
    expect(w('{__name__="up"}[7m]')).toBe(7 * M)
  })

  it('is not fooled by durations and keywords inside strings and matchers', () => {
    expect(w('up{path="/a[1d]/b", note="offset 9d"}')).toBe(5 * M)
    expect(w('label_replace(up, "dst", "$1", "src", "(.*)[1y]")')).toBe(5 * M)
    expect(w("count_over_time({job='x[1w]'}[3m])")).toBe(3 * M)
    expect(w('up # trailing comment [9d]')).toBe(5 * M)
  })

  it('rejects text that cannot be PromQL', () => {
    for (const bad of ['rate(a[5m]', 'a[5x]', 'a[', '"open', 'up{a="b"', 'rate(a[5m]))', '[5m]', 'offset 5m']) {
      expect(() => maxWindowMs(bad), bad).toThrow()
    }
  })

  it('classifies by the configured hot and recent windows', () => {
    const cfg = { hotWindowMs: 10 * M, recentWindowMs: 6 * H, lookbackMs: 5 * M }
    expect(classify('rate(a[5m])', cfg)).toMatchObject({ class: 'tail', windowMs: 5 * M })
    expect(classify('rate(a[10m])', cfg).class).toBe('tail') // boundary: fits exactly
    expect(classify('rate(a[11m])', cfg).class).toBe('recent')
    expect(classify('rate(a[6h])', cfg).class).toBe('recent')
    expect(classify('rate(a[6h] offset 1m)', cfg).class).toBe('rollup')
    expect(classify('avg_over_time(a[30d])', cfg)).toMatchObject({ class: 'rollup', windowMs: 30 * 86_400_000 })
    expect(classify('up @ 1700000000', cfg).class).toBe('rollup') // fixed time: can read anything
    expect(classify('rate(a[5m] @ end())', cfg).class).toBe('tail')
    expect(classify('rate(a[5m])', { ...cfg, hotWindowMs: M }).class).toBe('recent')
    expect(classify('rate(a[5m])', cfg).reason).toMatch(/300000 ms/)
  })
})

describe('rule file validation', () => {
  const cfg = DEFAULT_RULER_CONFIG
  const parse = (doc: unknown) => parseRuleFile(doc, cfg)

  it('accepts the Prometheus rule-file shape and normalizes it', () => {
    const r = parse({
      groups: [
        {
          name: 'example',
          interval: '30s',
          limit: 10,
          labels: { team: 'core' },
          rules: [
            { record: 'job:http_inprogress_requests:sum', expr: 'sum by (job) (http_inprogress_requests)', labels: { tier: 'a' } },
            {
              alert: 'HighRequestLatency',
              expr: 'job:request_latency_seconds:mean5m{job="myjob"} > 0.5',
              for: '10m',
              keep_firing_for: '5m',
              labels: { severity: 'page', team: 'web' },
              annotations: { summary: 'High request latency on {{ $labels.instance }}', value: '{{ $value | humanize }}' },
            },
          ],
        },
      ],
    })
    expect(r.errors).toEqual([])
    const g = r.groups[0]!
    expect(g).toMatchObject({ name: 'example', intervalMs: 30_000, queryOffsetMs: 0, limit: 10 })
    expect(g.rules[0]).toMatchObject({ kind: 'record', name: 'job:http_inprogress_requests:sum', labels: { team: 'core', tier: 'a' }, cost: { class: 'tail' } })
    // group labels are merged in and the rule's own label wins
    expect(g.rules[1]).toMatchObject({ kind: 'alert', forMs: 600_000, keepFiringForMs: 300_000, labels: { severity: 'page', team: 'web' } })
    expect(g.rules[0]!.key).not.toBe(g.rules[1]!.key)
  })

  it('reports every problem with a path and a fix', () => {
    const r = parse({
      groups: [
        {
          name: 'g',
          interval: '1s',
          bogus: 1,
          rules: [
            { alert: 'A', expr: 'up == 0', for: 'soon' },
            { alert: 'B', expr: 'up == 0', annotations: { summary: '{{ if $value }}x{{ end }}' } },
            { alert: 'C', expr: 'rate(x[5m' },
            { record: 'bad name', expr: 'up' },
            { record: 'ok:name', expr: 'up', for: '5m' },
            { alert: 'D', record: 'd', expr: 'up' },
            { expr: 'up' },
            { alert: 'E', expr: '' },
            { alert: 'F', expr: 'up', labels: { 'bad-label': 'x', alertname: 'no', __name__: 'no', sev: '{{ query "up" }}' } },
            { alert: 'G', expr: 'up', keep_firing_for: 5 },
            { alert: 'H', expr: 'up', annotations: { big: 'x'.repeat(5000) } },
            { alert: 'I', expr: 'up' },
            { alert: 'I', expr: 'up' },
          ],
        },
        { name: 'g', rules: [] },
        { name: '', rules: [] },
        { name: 'viz:reserved', rules: [] },
        { name: 'h', rules: 'nope' },
      ],
    })
    const paths = r.errors.map((e) => e.path)
    for (const p of [
      'groups[0].interval', 'groups[0].bogus', 'groups[0].rules[0].for', 'groups[0].rules[1].annotations.summary', 'groups[0].rules[2].expr',
      'groups[0].rules[3].record', 'groups[0].rules[4].for', 'groups[0].rules[5]', 'groups[0].rules[6]', 'groups[0].rules[7].expr',
      'groups[0].rules[8].labels.bad-label', 'groups[0].rules[8].labels.alertname', 'groups[0].rules[8].labels.__name__', 'groups[0].rules[8].labels.sev',
      'groups[0].rules[9].keep_firing_for', 'groups[0].rules[10].annotations.big', 'groups[0].rules[12]',
      'groups[1].name', 'groups[2].name', 'groups[3].name', 'groups[4].rules',
    ]) expect(paths, p).toContain(p)
    for (const e of r.errors) {
      expect(e.message.length).toBeGreaterThan(3)
      expect(e.fix.length).toBeGreaterThan(3)
    }
    expect(parse(null).errors[0]).toMatchObject({ path: 'groups' })
    expect(parse({ groups: [], other: 1 }).errors[0]).toMatchObject({ path: 'other' })
  })

  it('enforces rules-per-group and warns when `for` is shorter than the interval', () => {
    const small = { ...cfg, limits: { ...cfg.limits, maxRulesPerGroup: 2 } }
    const many = { groups: [{ name: 'g', rules: [1, 2, 3].map((i) => ({ alert: `A${i}`, expr: 'up' })) }] }
    expect(parseRuleFile(many, small).errors[0]).toMatchObject({ path: 'groups[0].rules' })
    const r = parse({ groups: [{ name: 'g', interval: '5m', rules: [{ alert: 'A', expr: 'up', for: '1m' }] }] })
    expect(r.errors).toEqual([])
    expect(r.warnings[0]).toMatchObject({ path: 'groups[0].rules[0].for' })
  })
})

describe('notifier config, routing, inhibition, silences (pure)', () => {
  const compile = (c: unknown) => {
    const r = compileConfig(c)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    return r.config
  }
  const base = {
    receivers: [{ name: 'default', webhook_configs: [{ url: 'https://hooks.example/default' }] }, { name: 'db', webhook_configs: [{ url: 'https://hooks.example/db' }] }, { name: 'audit', slack_configs: [{ api_url: 'https://hooks.example/slack' }] }],
  }

  it('routes depth-first: first matching child wins, `continue` keeps going, no match falls back to the parent', () => {
    const cfg = compile({
      ...base,
      route: {
        receiver: 'default',
        group_by: ['alertname'],
        routes: [
          { receiver: 'audit', match: { severity: 'page' }, continue: true },
          { receiver: 'db', match_re: { service: 'mysql|postgres' }, group_by: ['alertname', 'cluster'], routes: [{ receiver: 'audit', matchers: ['env!="prod"'] }] },
          { receiver: 'default', match: { service: 'mysql' } },
        ],
      },
    })
    const rx = (labels: Record<string, string>) => matchRoutes(cfg.root, labels).map((r) => r.receiver)
    expect(rx({ alertname: 'X' })).toEqual(['default'])
    expect(rx({ alertname: 'X', severity: 'page' })).toEqual(['audit']) // continue, but nothing later matched
    expect(rx({ alertname: 'X', severity: 'page', service: 'mysql', env: 'prod' })).toEqual(['audit', 'db'])
    expect(rx({ alertname: 'X', service: 'postgres', env: 'dev' })).toEqual(['audit']) // grandchild
    expect(rx({ alertname: 'X', service: 'mysqlx' })).toEqual(['default']) // regexes are anchored
    // children inherit grouping and timers
    const db = matchRoutes(cfg.root, { service: 'mysql', env: 'prod', cluster: 'c1', alertname: 'X' })[0]!
    expect(db.groupBy).toEqual(['alertname', 'cluster'])
    expect(db.groupWaitMs).toBe(30_000)
    expect(groupKey(db, groupLabels(db, { alertname: 'X', cluster: 'c1', extra: 'e' }))).toBe('{}/{service=~"mysql|postgres"}/1:{alertname="X",cluster="c1"}')
    // an alert lacking a group_by label is grouped without it
    expect(groupLabels(db, { alertname: 'X' })).toEqual({ alertname: 'X' })
  })

  it('rejects broken configs with paths', () => {
    const r = compileConfig({
      route: { receiver: 'nope', match: { a: 'b' }, group_interval: '0s', routes: [{ match_re: { x: '(' }, group_by: ['...', 'a'], bogus: true }] },
      receivers: [{ name: 'a', webhook_configs: [{ url: 'ftp://x' }] }, { name: 'a' }, { name: 'p', pagerduty_configs: [] }],
      inhibit_rules: [{ equal: ['x'] }],
      delivery: { max_attempts: 0 },
      nope: 1,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    const paths = r.errors.map((e) => e.path)
    for (const p of ['route.receiver', 'route.match', 'route.group_interval', 'route.routes[0].match_re.x', 'route.routes[0].group_by', 'route.routes[0].bogus',
      'receivers[0].webhook_configs[0].url', 'receivers[1].name', 'receivers[2].pagerduty_configs', 'inhibit_rules[0].source_match', 'inhibit_rules[0].target_match', 'delivery.max_attempts', 'nope']) {
      expect(paths, p).toContain(p)
    }
  })

  it('inhibits targets that share the `equal` labels with a firing source, and never lets an alert inhibit itself', () => {
    const cfg = compile({ ...base, route: { receiver: 'default' }, inhibit_rules: [{ source_match: { severity: 'critical' }, target_match_re: { severity: 'warning|critical' }, equal: ['cluster'] }] })
    const src = { fingerprint: 's', labels: { alertname: 'Down', severity: 'critical', cluster: 'a' } }
    expect(inhibitedBy(cfg.inhibit, { severity: 'warning', cluster: 'a' }, [src])).toBe('s')
    expect(inhibitedBy(cfg.inhibit, { severity: 'warning', cluster: 'b' }, [src])).toBeNull()
    expect(inhibitedBy(cfg.inhibit, { severity: 'info', cluster: 'a' }, [src])).toBeNull()
    expect(inhibitedBy(cfg.inhibit, { severity: 'warning', cluster: 'a' }, [])).toBeNull()
    // The source matches both sides of the rule: it must not inhibit itself or its peers.
    expect(inhibitedBy(cfg.inhibit, src.labels, [src])).toBeNull()
    // A label missing on both sides counts as equal.
    expect(inhibitedBy(cfg.inhibit, { severity: 'warning' }, [{ fingerprint: 't', labels: { severity: 'critical' } }])).toBe('t')
  })

  it('matches silences by matchers and time window', () => {
    const s = { id: 's1', matchers: compileSilenceMatchers([{ name: 'alertname', value: 'Down', isRegex: false }, { name: 'instance', value: 'web-.*', isRegex: true }]), startsAt: 100, endsAt: 200 }
    const labels = { alertname: 'Down', instance: 'web-1' }
    expect(silencedBy([s], labels, 100)).toEqual(['s1'])
    expect(silencedBy([s], labels, 199)).toEqual(['s1'])
    expect(silencedBy([s], labels, 200)).toEqual([]) // the end is exclusive
    expect(silencedBy([s], labels, 99)).toEqual([])
    expect(silencedBy([s], { alertname: 'Down', instance: 'db-1' }, 150)).toEqual([])
    const neg = { id: 's2', matchers: compileSilenceMatchers([{ name: 'env', value: 'prod', isRegex: false, isEqual: false }]), startsAt: 0, endsAt: 1000 }
    expect(silencedBy([neg], { env: 'dev' }, 5)).toEqual(['s2'])
    expect(silencedBy([neg], { env: 'prod' }, 5)).toEqual([])
    const errs = validateSilence({ matchers: [{ name: 'a', value: '.*', isRegex: true }], startsAt: 10, endsAt: 5, createdBy: '', comment: '' }, 20)
    expect(errs.map((e) => e.path).sort()).toEqual(['comment', 'createdBy', 'endsAt', 'endsAt', 'matchers'])
  })

  it('builds the Alertmanager webhook body (version 4) and a Slack message', () => {
    const g = { groupKey: '{}:{alertname="Down"}', receiver: 'default', groupLabels: { alertname: 'Down' }, externalUrl: 'https://viz.example' }
    const alerts = [
      { fingerprint: 'b', labels: { alertname: 'Down', instance: 'i2', sev: 'p' }, annotations: { summary: 'i2 down', runbook: 'r' }, status: 'resolved' as const, startsAt: 1000, endsAt: 61_000 },
      { fingerprint: 'a', labels: { alertname: 'Down', instance: 'i1', sev: 'p' }, annotations: { summary: 'i1 down', runbook: 'r' }, status: 'firing' as const, startsAt: 2000, endsAt: null },
    ]
    const p = webhookPayload(g, alerts)
    expect(p).toEqual({
      version: '4',
      groupKey: '{}:{alertname="Down"}',
      truncatedAlerts: 0,
      status: 'firing',
      receiver: 'default',
      groupLabels: { alertname: 'Down' },
      commonLabels: { alertname: 'Down', sev: 'p' },
      commonAnnotations: { runbook: 'r' },
      externalURL: 'https://viz.example',
      alerts: [
        { status: 'firing', labels: alerts[1]!.labels, annotations: alerts[1]!.annotations, startsAt: '1970-01-01T00:00:02.000Z', endsAt: '0001-01-01T00:00:00Z', generatorURL: '', fingerprint: 'a' },
        { status: 'resolved', labels: alerts[0]!.labels, annotations: alerts[0]!.annotations, startsAt: '1970-01-01T00:00:01.000Z', endsAt: '1970-01-01T00:01:01.000Z', generatorURL: '', fingerprint: 'b' },
      ],
    })
    expect(webhookPayload(g, alerts, 1)).toMatchObject({ truncatedAlerts: 1, alerts: [{ fingerprint: 'a' }] })
    expect(webhookPayload(g, [alerts[0]!]).status).toBe('resolved')
    const s = slackPayload(g, alerts, '#ops', 5000)
    expect(s).toMatchObject({ channel: '#ops', text: '[FIRING:1] Down', attachments: [{ color: 'danger', title: '[FIRING:1] Down', text: '• i1 down\n✓ i2 down', ts: 5 }] })
    expect(slackPayload(g, [alerts[0]!], null, 0)).toMatchObject({ text: '[RESOLVED] Down', attachments: [{ color: 'good' }] })
  })
})
