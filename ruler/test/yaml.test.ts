/**
 * Rule files as YAML: the subset parser, what it refuses, and round trips.
 *
 * The independent reader is the `yaml` npm package (a dev dependency, not shipped): what
 * viz parses must mean what it means to that parser, and what viz writes must be read back
 * by it to the same data (AGENTS.md, "Independent readers").
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parse as referenceParse } from 'yaml'
import { DEFAULT_RULER_CONFIG } from '../src/ruler'
import { exportRuleFile, importRuleFile, ruleFileDocument } from '../src/rulefile'
import { parseRuleFile } from '../src/rules'
import { core, parseYaml, toYaml, YamlError } from '../src/yaml'
import edgeCases from './fixtures/edge-cases.yaml?raw'
import kubernetesApps from './fixtures/kubernetes-apps.yaml?raw'
import nodeExporter from './fixtures/node-exporter.yaml?raw'
import recording from './fixtures/recording.yaml?raw'

const FIXTURES: Record<string, string> = { 'node-exporter': nodeExporter, 'kubernetes-apps': kubernetesApps, recording, 'edge-cases': edgeCases }

const load = (text: string) => {
  const r = importRuleFile(text)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.file as { groups: { name: string; rules: Record<string, unknown>[] }[] }
}
const normalize = (file: unknown) => {
  const p = parseRuleFile(file, DEFAULT_RULER_CONFIG)
  expect(p.errors).toEqual([])
  return p.groups
}
const refuse = (text: string): YamlError => {
  try {
    parseYaml(text)
  } catch (e) {
    if (e instanceof YamlError) return e
    throw e
  }
  throw new Error(`accepted:\n${text}`)
}

describe('the parser agrees with an independent YAML implementation', () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`${name}: same data as the reference parser`, () => {
      expect(core(parseYaml(text))).toEqual(referenceParse(text))
    })
  }

  it('scalars: plain, quoted, folded over lines, block literal and folded, chomping', () => {
    const text = [
      'plain: a b  c   # comment',
      'folded: one',
      '  two',
      '',
      '  three',
      "single: 'it''s'",
      'double: "a\\tb\\n\\"c\\" \\u00e9 \\x41"',
      'multi: "first',
      '  second\\',
      '  third"',
      'literal: |',
      '  a',
      '   b',
      '',
      '  c',
      'strip: |-',
      '  x',
      '',
      'keep: |+',
      '  y',
      '',
      'folded_block: >',
      '  one',
      '  two',
      '',
      '    indented',
      '  three',
      'indent: |2',
      '    two extra',
      'flow: [a, "b, c", {k: v, n: 1}]',
      'empty:',
      'nulls: [~, null]',
      'numbers: [1, -2, 3.5, 1e3, 0x10, .inf]',
      'bools: [true, False]',
      '"quoted key": v',
      'url: http://x.test:80/a?b=c#d',
      'last: end',
    ].join('\n')
    expect(core(parseYaml(text))).toEqual(referenceParse(text))
    expect(core(parseYaml(text))).toMatchObject({ plain: 'a b  c', folded: 'one two\nthree', single: "it's", strip: 'x', literal: 'a\n b\n\nc\n', empty: null })
  })

  it('sequences may sit at the indentation of their key, and nest', () => {
    const text = 'groups:\n- name: a\n  rules:\n  - record: x\n    expr: y\n  - - nested\n    - list\n- name: b\n  rules: []\n'
    expect(core(parseYaml(text))).toEqual(referenceParse(text))
  })

  it('property: whatever the emitter writes, both parsers read back to the same data', () => {
    const text = fc.oneof(
      fc.string(),
      fc.constantFrom('', ' ', 'true', 'null', '~', '1', '1.5', '-', '- a', 'a: b', 'a #b', '#', '{{ $labels.x }}', "it's", '"q"', 'a\nb', 'a\nb\n', 'a\n\nb', ' lead', 'trail ', '\ttab', 'x\n  y\n', '| pipe', '> gt', '& amp', '* star', '! bang', '% pct', '@ at', '`tick`', '[a]', '{a}', 'a:', ':a', 'é', 'a\r\nb', '0x1f', '.inf', '1e3', 'yes', 'on'),
      fc.array(fc.constantFrom('a', ' ', '\n', ':', '#', '-', '"', "'", '{', '}', '\\', '|', '>', 'é', '0'), { maxLength: 12 }).map((cs) => cs.join('')),
    )
    const leaf = fc.oneof(text, fc.integer(), fc.boolean(), fc.constant(null), fc.double({ noNaN: true, noDefaultInfinity: true }))
    const key = text.filter((k) => k !== '__proto__')
    const tree = fc.letrec((tie) => ({
      node: fc.oneof({ depthSize: 'small' }, leaf, fc.array(tie('node'), { maxLength: 4 }), fc.dictionary(key, tie('node'), { maxKeys: 4 })),
    })).node
    fc.assert(
      fc.property(tree, (value) => {
        const yaml = toYaml(value)
        const ours = core(parseYaml(yaml))
        // -0 and 0 are the same number in YAML.
        const want = JSON.parse(JSON.stringify(value))
        expect(JSON.parse(JSON.stringify(ours))).toEqual(want)
        expect(JSON.parse(JSON.stringify(referenceParse(yaml)))).toEqual(want)
      }),
      { numRuns: 1500 },
    )
  })
})

describe('what the subset refuses, with the line and a fix', () => {
  const cases: [string, string, RegExp, number][] = [
    ['anchors', 'groups:\n  - name: a\n    labels: &common\n      team: x\n', /anchors \(&name\) are not supported/, 3],
    ['aliases', 'a: &x 1\n', /anchors/, 1],
    ['an alias as a value', 'base:\n  team: x\nrule:\n  labels: *base\n', /aliases \(\*name\) are not supported/, 4],
    ['an alias in a list', 'xs:\n  - *one\n', /aliases/, 2],
    ['an anchor in a flow collection', 'xs: [&a 1, *a]\n', /anchors/, 1],
    ['merge keys', 'a:\n  <<: {x: 1}\n  y: 2\n', /merge keys \(<<\) are not supported/, 2],
    ['tags', 'a: !!str 1\n', /tags \(!tag\) are not supported/, 1],
    ['a second document', 'a: 1\n---\nb: 2\n', /second YAML document/, 2],
    ['directives', '%YAML 1.2\n---\na: 1\n', /directives are not supported/, 1],
    ['complex keys', '? a\n: b\n', /complex keys/, 1],
    ['tabs in indentation', 'a:\n\tb: 1\n', /tab is used for indentation/, 2],
    ['duplicate keys', 'a: 1\nb: 2\na: 3\n', /key "a" appears twice/, 3],
    ['flow collections over several lines', 'a: [1,\n  2]\n', /not closed on its line/, 1],
    ['an unclosed quote', 'a: "never\nb: 2\n', /never closed/, 1],
    ['a mapping inside a plain multi-line value', 'a: one\n  b: two\n', /inside a multi-line plain value/, 2],
    ['bad indentation', 'a:\n    b: 1\n  c: 2\n', /indentation does not match|indented/, 3],
  ]
  for (const [what, text, message, line] of cases) {
    it(what, () => {
      const e = refuse(text)
      expect(e.message).toMatch(message)
      expect(e.line).toBe(line)
      expect(e.fix.length).toBeGreaterThan(10)
      // The same refusal reaches a rule-file import as a problem with a place and a fix.
      const r = importRuleFile(text)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0]).toMatchObject({ path: `line ${line}`, fix: e.fix })
    })
  }

  it('the reference parser accepts an anchored file that viz refuses, so the refusal is a choice, not an accident', () => {
    const text = 'groups:\n  - name: a\n    rules:\n      - alert: A\n        expr: up == 0\n        labels: &l {severity: page}\n      - alert: B\n        expr: up == 0\n        labels: *l\n'
    expect((referenceParse(text) as { groups: { rules: { labels: unknown }[] }[] }).groups[0]!.rules[1]!.labels).toEqual({ severity: 'page' })
    expect(importRuleFile(text)).toMatchObject({ ok: false })
  })
})

describe('rule files: import, validate, export, and back', () => {
  it('applies the rule-file schema: every field is a string except limit', () => {
    const file = load(edgeCases)
    const rule = file.groups[0]!.rules[0]!
    expect(rule.expr).toBe('1')
    expect(rule.labels).toEqual({ severity: '1', enabled: 'true', zero: '0', tilde: '~', empty_like: 'null', colon: 'a: b', hash: 'a #b' })
    expect((rule.annotations as Record<string, string>).summary).toBe('tab\tand "quotes" and unicode é')
    expect(file.groups[0]!.rules[2]).toEqual({ alert: 'Watchdog', expr: 'vector(1)', for: '0s', labels: {} })
    expect((load(recording).groups[0] as unknown as { limit: unknown }).limit).toBe(500)
  })

  it('kube-prometheus style: folded descriptions, block expressions and templates arrive intact', () => {
    const groups = normalize(load(nodeExporter))
    expect(groups.map((g) => [g.name, g.rules.length])).toEqual([['node-exporter', 4], ['node-exporter.rules', 3]])
    const first = groups[0]!.rules[0]!
    expect(first).toMatchObject({ kind: 'alert', name: 'NodeFilesystemSpaceFillingUp', forMs: 3_600_000, labels: { severity: 'warning' } })
    expect(first.kind === 'alert' && first.annotations.description).toBe(
      'Filesystem on {{ $labels.device }}, mounted on {{ $labels.mountpoint }}, at {{ $labels.instance }} has only {{ printf "%.2f" $value }}% available space left and is filling up.')
    expect(first.expr.split('\n').length).toBe(8) // the literal block, trailing newline included
    // Two rules with the same alert name and different severity are different rules.
    expect(new Set(groups[0]!.rules.map((r) => r.key)).size).toBe(4)
  })

  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`${name}: import -> save shape -> export -> import gives the same rules; the export is stable and independently readable`, () => {
      const groups = normalize(load(text))
      const out = exportRuleFile(groups, { extensions: true })
      expect(out.dropped).toEqual([])
      const again = normalize(load(out.yaml))
      expect(again).toEqual(groups)
      expect(exportRuleFile(again, { extensions: true }).yaml).toBe(out.yaml)
      // Read back by an implementation viz did not write: the same document viz reads.
      expect(referenceParse(out.yaml)).toEqual(ruleFileDocument(groups, { extensions: true }).file)
      expect(load(out.yaml)).toEqual(ruleFileDocument(groups, { extensions: true }).file)
    })

    it(`${name}: the document itself survives emit -> parse unchanged`, () => {
      const file = load(text)
      expect(load(toYaml(file))).toEqual(file)
    })
  }

  it('viz fields round-trip with extensions and are listed as dropped without them', () => {
    const file = {
      groups: [{
        name: 'g', interval: '30s',
        rules: [{
          alert: 'A', expr: '(q) > 1', for: '5m', no_data: 'alerting', no_data_for: '10m', no_data_expr: 'q',
          monitor: { id: 'mon_0123456789abcdef', owner: 'payments', startInvestigation: true, condition: { query: 'q', op: '>', threshold: 1, unit: 'ms' }, createdAt: 1, createdBy: 'key:a', updatedAt: 2, updatedBy: 'key:b' },
        }],
      }],
    }
    const groups = normalize(file)
    const withExt = exportRuleFile(groups, { extensions: true })
    expect(normalize(load(withExt.yaml))).toEqual(groups)
    const plain = exportRuleFile(groups, { extensions: false })
    expect(plain.dropped).toEqual(['g/A: no_data alerting', 'g/A: monitor mon_0123456789abcdef'])
    expect(plain.yaml).not.toMatch(/no_data|monitor/)
    expect(referenceParse(plain.yaml)).toEqual({ groups: [{ name: 'g', interval: '30s', rules: [{ alert: 'A', expr: '(q) > 1', for: '5m' }] }] })
  })

  it('a template outside the subset is refused at import with the field path, not silently changed', () => {
    const text = 'groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: up == 0\n        annotations:\n          summary: "{{ if $value }}x{{ end }}"\n'
    const p = parseRuleFile(load(text), DEFAULT_RULER_CONFIG)
    expect(p.errors.map((e) => e.path)).toEqual(['groups[0].rules[0].annotations.summary'])
  })

  it('a file that is not a mapping, or has no groups, is a validation problem', () => {
    expect(importRuleFile('- a\n- b\n')).toMatchObject({ ok: false, errors: [{ path: 'groups' }] })
    expect(parseRuleFile(load('groups:\n'), DEFAULT_RULER_CONFIG)).toMatchObject({ groups: [], errors: [] })
    expect(parseRuleFile(load('group: []\n'), DEFAULT_RULER_CONFIG).errors[0]).toMatchObject({ path: 'groups' })
  })
})
