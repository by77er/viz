#!/usr/bin/env python3
"""Test-strength check: apply one semantic mutation at a time to a COPY of this crate in a
scratch directory (never to the shared tree), run the suites, and report which caught it.

    MUTATE_DIR=/path/to/scratch python3 -I tools/mutate.py [--loki-cases cases.json --loki loki.json]

Suites: `unit` (cargo test --lib), `api` (tests/api.rs), `semantics` (tests/semantics.rs), `conformance` (tests/conformance.rs,
needs testdata/loki-oracle/cases.json), `props` (tests/props.rs, PROPTEST_CASES=32) and, with
--loki-cases/--loki, `differential`: the case file is re-exported from the mutant with the
same generator seed and rounds and compared with the Loki outputs already recorded for it
(Loki's answers do not depend on viz), with tools/lokidiff/compare.py.
"""
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CRATE = os.path.dirname(HERE)

# (id, description, file, old, new)
MUTANTS = [
    (1, 'range window closed on the left', 'src/eval.rs',
     'let a = samples.partition_point(|x| x.0 <= t.saturating_sub(r.range_ns));',
     'let a = samples.partition_point(|x| x.0 < t.saturating_sub(r.range_ns));'),
    (2, 'rate of a log range not divided by the range', 'src/eval.rs',
     'RangeOp::Rate if !unwrapped => w.len() as f64 / secs,', 'RangeOp::Rate if !unwrapped => w.len() as f64,'),
    (3, 'negated line filters keep matching lines', 'src/pipeline.rs',
     'any != self.negated', 'any'),
    (4, 'a label value that does not convert drops the line', 'src/pipeline.rs',
     'labels.set_error(ERR_LABEL_FILTER, Some(&details));\n                    true', 'labels.set_error(ERR_LABEL_FILTER, Some(&details));\n                    false'),
    (5, 'extracted keys starting with a digit not prefixed', 'src/labels.rs',
     "if i == 0 && c.is_ascii_digit() {", "if false && c.is_ascii_digit() {"),
    (6, 'no _extracted suffix on collision with a stream label', 'src/labels.rs',
     'name = std::borrow::Cow::Owned(format!("{name}_extracted"));', 'return;'),
    (7, 'a later error overwrites the first', 'src/labels.rs',
     'if self.has(ERROR) {\n            return;\n        }', 'self.remove(ERROR);\n        self.remove(ERROR_DETAILS);'),
    (8, 'json parser keeps null members as empty labels', 'src/jsonwalk.rs',
     'Scalar::Null | Scalar::Arr => {}', 'Scalar::Null => f(&full, String::new()),\n                Scalar::Arr => {}'),
    (9, 'logfmt keeps empty values without --keep-empty', 'src/pipeline.rs',
     'if p.empty && !*keep_empty {', 'if false && p.empty && !*keep_empty {'),
    (10, 'unwrapped label kept in the series labels', 'src/eval.rs',
     'ls.remove(&u.label);\n                        v', 'v'),
    (11, 'offset sign flipped', 'src/eval.rs',
     'let t = grid.t(i).saturating_sub(r.offset_ns);\n            let a = samples', 'let t = grid.t(i).saturating_add(r.offset_ns);\n            let a = samples'),
    (12, 'log query end inclusive', 'src/eval.rs',
     'if err.is_some() || row.ts_ns < start || row.ts_ns >= end {', 'if err.is_some() || row.ts_ns < start || row.ts_ns > end {'),
    (13, 'direction ignored (always forward)', 'src/eval.rs',
     'let fwd = opts.direction == Direction::Forward;', 'let fwd = true;'),
    (14, '__error__ filters not moved after the other label filters', 'src/pipeline.rs',
     'out.extend(stages[i..j].iter().filter(|s| !is_error_filter(s)));\n                out.extend(stages[i..j].iter().filter(|s| is_error_filter(s)));',
     'out.extend(stages[i..j].iter());'),
    (15, 'pattern line filter accepts empty captures', 'src/pattern.rs',
     'if end == pos {\n                        return false;\n                    }', ''),
    (16, 'missing label in a template prints <no value>', 'src/template/mod.rs',
     'None => V::Str(String::new()),\n                };\n                rest = r;', 'None => V::NoValue,\n                };\n                rest = r;'),
    (17, 'by and without swapped in range-aggregation grouping', 'src/eval.rs',
     'Some(Grouping { without: false, labels: keep }) => labels.into_iter().filter(|(n, _)| keep.contains(n)).collect(),',
     'Some(Grouping { without: false, labels: keep }) => labels.into_iter().filter(|(n, _)| !keep.contains(n)).collect(),'),
    (18, 'absent_over_time takes labels from regex matchers too', 'src/eval.rs',
     'if m.op == MatchOp::Eq && !labels', 'if m.op != MatchOp::Ne && !labels'),
    (19, 'line filters after decolorize see the decolorized line', 'src/pipeline.rs',
     "match out[barrier..].iter().position(|s| matches!(s, Stage::Decolorize)) {", "match None::<usize> {"),
    (20, 'negated line filters pushed down as required literals', 'src/eval.rs',
     'LineFilterOp::Contains => {\n                    let lits', 'LineFilterOp::Contains | LineFilterOp::NotContains => {\n                    let lits'),
    (21, 'rate_counter ignores counter resets', 'src/eval.rs',
     'if v < prev {\n            increase += prev;\n        }', ''),
    (22, 'equal timestamps in a backward log query tie-broken by descending stream labels', 'src/eval.rs',
     'b.0.cmp(&a.0).then_with(|| keys[a.2].cmp(&keys[b.2])).then(b.1.cmp(&a.1))',
     'b.0.cmp(&a.0).then_with(|| keys[b.2].cmp(&keys[a.2])).then(b.1.cmp(&a.1))'),
]


def run(cmd, cwd, env=None, timeout=3600):
    e = dict(os.environ)
    if env:
        e.update(env)
    p = subprocess.run(cmd, cwd=cwd, env=e, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, text=True)
    return p.returncode, p.stdout


def main():
    work = os.environ['MUTATE_DIR']
    loki_cases = sys.argv[sys.argv.index('--loki-cases') + 1] if '--loki-cases' in sys.argv else None
    loki = sys.argv[sys.argv.index('--loki') + 1] if '--loki' in sys.argv else None
    only = [int(x) for x in sys.argv[sys.argv.index('--only') + 1].split(',')] if '--only' in sys.argv else None
    pick = sys.argv[sys.argv.index('--suites') + 1].split(',') if '--suites' in sys.argv else None
    copy = os.path.join(work, 'logql')
    if os.path.exists(copy):
        shutil.rmtree(copy)
    shutil.copytree(CRATE, copy, ignore=shutil.ignore_patterns('target', 'target-*', '*.proptest-regressions', 'wasm-check'))
    promql = os.path.join(work, 'promql')
    if not os.path.exists(promql):
        os.symlink(os.path.join(os.path.dirname(CRATE), 'promql'), promql)
    env = {'CARGO_TARGET_DIR': os.path.join(work, 'target'), 'PROPTEST_CASES': '32', 'CARGO_BUILD_JOBS': '2'}
    suites = [('unit', ['cargo', 'test', '-q', '--lib']), ('api', ['cargo', 'test', '-q', '--test', 'api']),
              ('semantics', ['cargo', 'test', '-q', '--test', 'semantics']),
              ('conformance', ['cargo', 'test', '-q', '--test', 'conformance']),
              ('props', ['cargo', 'test', '-q', '--test', 'props', '--', '--test-threads', '2'])]
    if pick:
        suites = [x for x in suites if x[0] in pick]
    seed_rounds = None
    if loki_cases:
        m = re.search(r'cases(\d+)\.json$', loki_cases)
        seed_rounds = (m.group(1) if m else '7', os.environ.get('MUTATE_ROUNDS', '60'))
    # Baseline: everything must pass on the unmutated copy.
    rows = []
    for mid, desc, path, old, new in MUTANTS:
        if only and mid not in only:
            continue
        f = os.path.join(copy, path)
        src = open(f).read()
        if src.count(old) != 1:
            rows.append((mid, desc, {'error': f'pattern found {src.count(old)} times'}))
            continue
        open(f, 'w').write(src.replace(old, new))
        result = {}
        try:
            for name, cmd in suites:
                code, out = run(cmd, copy, env)
                if 'error[E' in out or 'could not compile' in out:
                    result['build'] = 'mutant does not compile'
                    break
                result[name] = 'caught' if code != 0 else 'not caught'
            if loki_cases and 'build' not in result and (not pick or 'differential' in pick):
                outp = os.path.join(work, 'mutant_cases.json')
                code, out = run(['cargo', 'test', '-q', '--test', 'differential', 'export_cases', '--', '--ignored'], copy,
                                dict(env, VIZ_DIFF_OUT=outp, VIZ_DIFF_SEED=seed_rounds[0], VIZ_DIFF_ROUNDS=seed_rounds[1]))
                code, out = run([sys.executable, '-I', os.path.join(copy, 'tools/lokidiff/compare.py'), outp, loki], copy)
                result['differential'] = 'caught' if code != 0 else 'not caught'
        finally:
            open(f, 'w').write(src)
        rows.append((mid, desc, result))
        print(mid, desc, result, flush=True)
    names = [n for n, _ in suites] + (['differential'] if loki_cases and (not pick or 'differential' in pick) else [])
    print()
    print('| # | mutation | ' + ' | '.join(names) + ' |')
    print('|---:|---|' + '---|' * len(names))
    for mid, desc, r in rows:
        print(f'| {mid} | {desc} | ' + ' | '.join(r.get(n, r.get('build', r.get('error', '')))
                                                    for n in names) + ' |')


main()
