"""Test-strength check: apply one semantic mutation at a time, run the three test suites, restore the file.

Usage: python3 tools/mutate.py [index ...]   (needs CARGO_TARGET_DIR-independent cargo; run from anywhere)
"""
import subprocess, sys, re, os, shutil
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env=dict(os.environ, CARGO_TARGET_DIR=ROOT+'/target')
MUTS=[
 ("range window closed on the left", 'src/eval.rs',
  '                let lo = s.ts.partition_point(|&t| t <= start);\n                let hi = s.ts.partition_point(|&t| t <= e);\n                if hi <= lo {\n                    continue;\n                }\n                let w = Window',
  '                let lo = s.ts.partition_point(|&t| t < start);\n                let hi = s.ts.partition_point(|&t| t <= e);\n                if hi <= lo {\n                    continue;\n                }\n                let w = Window'),
 ("no extrapolation in rate/increase/delta", 'src/functions.rs',
  'let mut factor = (sampled_interval + duration_to_start + duration_to_end) / sampled_interval;',
  'let mut factor = 1.0; let _ = (duration_to_start, duration_to_end);'),
 ("staleness markers ignored by instant selectors", 'src/eval.rs',
  'if t <= r.saturating_sub(lookback) || is_stale_nan(v) {', 'if t <= r.saturating_sub(lookback) {'),
 ("lookback 4m instead of 5m", 'src/eval.rs',
  'let lookback = self.opts.lookback_delta_ms;', 'let lookback = self.opts.lookback_delta_ms - 60_000;'),
 ("__name__ kept after rate and other range functions", 'src/eval.rs',
  'let keep_name = name == "last_over_time" || name == "first_over_time";', 'let keep_name = true;'),
 ("`without` keeps the listed labels (only drops the name)", 'src/eval.rs',
  'labels.iter().filter(|(k, _)| k != NAME_LABEL && !grouping.iter().any(|g| g == k)).cloned().collect(),',
  'labels.iter().filter(|(k, _)| k != NAME_LABEL).cloned().collect(),'),
 ("counter resets not compensated in rate", 'src/functions.rs',
  '            if v < prev {\n                result += prev;\n            }', '            if v < prev {\n                result += 0.0;\n            }'),
 ("one-to-one matching accepts duplicate right-hand series", 'src/eval.rs',
  '                if one_at[sig].0 == i {', '                if false && one_at[sig].0 == i {'),
 ("offset sign flipped", 'src/eval.rs',
  '        Some(Offset::Pos(d)) => d.as_millis() as i64,\n        Some(Offset::Neg(d)) => -(d.as_millis() as i64),',
  '        Some(Offset::Pos(d)) => -(d.as_millis() as i64),\n        Some(Offset::Neg(d)) => d.as_millis() as i64,'),
 ("subquery steps aligned to the outer start instead of absolute multiples", 'src/eval.rs',
  '    let mut start = interval.saturating_mul(left.div_euclid(interval));\n    if start <= left {\n        start = start.saturating_add(interval);\n    }',
  '    let start = left.saturating_add(interval);'),
 ("comparison without bool keeps non-matching samples", 'src/eval.rs',
  '                if keep {\n                    vals[i] = Some(value);\n                }', '                vals[i] = Some(value); let _ = keep;'),
 ("@ modifier ignored on instant selectors", 'src/eval.rs',
  '                Some(a) => vec![pick(a.saturating_sub(offset)); n],', '                Some(_) => (0..n).map(|i| pick(steps.ts(i).saturating_sub(offset))).collect(),'),
 ("many-to-one without group_left accepted silently", 'src/eval.rs',
  '                } else if one_to_one {', '                } else if false && one_to_one {'),
 ("group_left does not copy the listed labels", 'src/eval.rs',
  '                            if !v.is_empty() {\n                                l.push((ln.clone(), v));\n                            }',
  '                            let _ = v;'),
 ("`and` behaves like `unless`", 'src/eval.rs',
  'let want = id == token::T_LAND;', 'let want = id != token::T_LAND;'),
 ("topk ignores `by` grouping", 'src/eval.rs',
  '                        per_group[series_group[si]].push((x, si));', '                        per_group[0].push((x, si));'),
]
only = [int(x) for x in sys.argv[1:]]
for idx,(name,f,old,new) in enumerate(MUTS):
    if only and idx not in only: continue
    path=os.path.join(ROOT,f)
    orig=open(path).read()
    assert orig.count(old)==1, (name, orig.count(old))
    open(path,'w').write(orig.replace(old,new))
    try:
        res=[]
        for t in ['upstream','api','props']:
            p=subprocess.run(['cargo','test','--test',t,'--','--nocapture'],cwd=ROOT,env=env,capture_output=True,text=True)
            out=p.stdout+p.stderr
            if 'could not compile' in out:
                res.append(f'{t}: COMPILE ERROR'); print(out[-1500:]); continue
            if t=='upstream':
                tot=[l for l in out.splitlines() if l.startswith('TOTAL')]
                # last TOTAL row printed is unordered between the two tests; take max failed and min passed
                rows=[l.split() for l in tot]
                nf=max(int(r[2]) for r in rows) if rows else '?'
                npass=min(int(r[1]) for r in rows) if rows else '?'
                res.append(f'upstream: {"FAIL" if p.returncode else "pass"} (passed {npass}, failed {nf}; baseline 930-935 / 1-6)')
            else:
                failed=re.findall(r'^test (\S+) \.\.\. FAILED',out,re.M)
                res.append(f'{t}: {"FAIL "+",".join(failed) if p.returncode else "pass"}')
        print(f'[{idx}] {name}\n     '+' | '.join(res),flush=True)
    finally:
        open(path,'w').write(orig)
