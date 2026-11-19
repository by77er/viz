#!/usr/bin/env python3
"""Compare viz-logql's results (a case file written by the `differential` test) with
Loki's (the report `lokidiff probe` writes for the same case file).

    python3 -I compare.py cases.json loki.json [--show N]

Every mismatch is printed with its class: either a rule from KNOWN below matches (each
rule is a documented, explained difference; see README "Differential run"), or it is
UNEXPLAINED. The exit status is 1 if any mismatch is unexplained.

Comparison rules: streams are compared as a set of label sets, entries in order; matrix and
vector series as sets (by labels), except where the query fixes an order (sort, sort_desc,
topk, bottomk at the top of an instant query). Values agree within 1e-9 relative. For
topk/bottomk, Loki breaks ties between equal values nondeterministically (two runs of the
same query differ), so those queries are compared per step by the multiset of selected
values instead of by series labels.
"""
import json
import math
import re
import sys
from collections import defaultdict

# (class, description, predicate(case, loki_outcome, viz_outcome, detail)) — explained differences.
KNOWN = [
    ('oracle-merged-streams-unsorted',
     "a stage (drop, keep, label_format) merged several source streams into one label set; the oracle's "
     "mock querier returns their entries concatenated, not sorted by time as the HTTP API documents, and "
     "applies the limit to that order. viz returns entries sorted by time",
     lambda c, l, d: d == 'ORACLE_UNSORTED'),
    ('loki-empty-labels-without-label_replace',
     "series carry empty-valued labels (from `logfmt --keep-empty` or absent parser parameters) into "
     "`without (...)` grouping or `label_replace`: Loki groups by the label set with the empty labels "
     "but outputs it without them, so its result holds duplicate label sets (observed: "
     "`sum without (app)` returns two series `{y=\"1\"}`). viz keeps the empty-valued labels and "
     "returns distinct series",
     lambda c, l, d: d is not None and re.search(r'\bwithout\b|label_replace', c['query']) is not None
     and c.get('viz_ok') and any('""' in json.dumps(s.get('metric', {})) or any(v == '' for v in s.get('metric', {}).values())
                                 for s in c['viz_data'].get('result', []) if isinstance(s, dict))),
]


def num(x):
    if isinstance(x, (int, float)):
        return float(x)
    return {'NaN': math.nan, '+Inf': math.inf, 'Inf': math.inf, '-Inf': -math.inf}.get(x) if x in ('NaN', '+Inf', 'Inf', '-Inf') else float(x)


def feq(a, b):
    if math.isnan(a) and math.isnan(b):
        return True
    if a == b:
        return True
    return abs(a - b) <= 1e-9 * max(abs(a), abs(b)) or abs(a - b) < 1e-12


def lkey(m):
    return json.dumps(sorted(m.items()), ensure_ascii=False)


def cmp_points(a, b):
    if len(a) != len(b):
        return f'point count {len(a)} vs {len(b)}'
    for i, (pa, pb) in enumerate(zip(a, b)):
        if abs(num(pa[0]) - num(pb[0])) > 1e-6:
            return f'point {i} time {pa[0]} vs {pb[0]}'
        if not feq(num(pa[1]), num(pb[1])):
            return f'point {i} value {pa[1]} vs {pb[1]}'
    return None


def by_step(series, key):
    steps = defaultdict(list)
    for s in series:
        pts = s['values'] if key == 'values' else [s['value']]
        for t, v in pts:
            steps[round(num(t), 6)].append(num(v))
    return {t: sorted(vs) for t, vs in steps.items()}


def monotone(values, forward):
    ts = [int(v[0]) for v in values]
    return all((a <= b) if forward else (a >= b) for a, b in zip(ts, ts[1:]))


def compare(q, instant, loki, viz, forward=True):
    if loki['resultType'] != viz['resultType']:
        return f"resultType {loki['resultType']} vs {viz['resultType']}"
    t = loki['resultType']
    lr, vr = loki['result'], viz['result']
    if t == 'streams':
        ml = {lkey(s['stream']): s['values'] for s in lr}
        mv = {lkey(s['stream']): s['values'] for s in vr}
        if not all(monotone(v, forward) for v in ml.values()):
            # Loki's API documents values as sorted by timestamp; the oracle's mock querier
            # concatenates source streams that a stage merged into one label set.
            return 'ORACLE_UNSORTED'
        if set(ml) != set(mv):
            only_l = sorted(set(ml) - set(mv))[:1]
            only_v = sorted(set(mv) - set(ml))[:1]
            return f'stream sets differ ({len(ml)} vs {len(mv)}); only loki: {only_l} only viz: {only_v}'
        for k in ml:
            if ml[k] != mv[k]:
                a, b = ml[k], mv[k]
                if len(a) != len(b):
                    return f'stream {k}: {len(a)} vs {len(b)} entries'
                for i, (x, y) in enumerate(zip(a, b)):
                    if x != y:
                        return f'stream {k} entry {i}: {x!r} vs {y!r}'
        return None
    if t == 'scalar':
        return cmp_points([lr], [vr])
    key = 'values' if t == 'matrix' else 'value'
    if re.search(r'\b(topk|bottomk)\b', q):
        sl, sv = by_step(lr, key), by_step(vr, key)
        if set(sl) != set(sv):
            return f'steps differ: {sorted(set(sl) ^ set(sv))[:3]}'
        for st in sl:
            if len(sl[st]) != len(sv[st]) or not all(feq(a, b) for a, b in zip(sl[st], sv[st])):
                return f'step {st}: values {sl[st]} vs {sv[st]}'
        return None
    if len(lr) != len(vr):
        return f'series count {len(lr)} vs {len(vr)}'
    ordered = t == 'vector' and re.match(r'\s*sort(_desc)?\(', q)
    if not ordered:
        lr = sorted(lr, key=lambda s: lkey(s['metric']))
        vr = sorted(vr, key=lambda s: lkey(s['metric']))
    for a, b in zip(lr, vr):
        if lkey(a['metric']) != lkey(b['metric']):
            if ordered and feq(num(a['value'][1]), num(b['value'][1])):
                continue  # equal values: order between them is unspecified
            return f"labels {lkey(a['metric'])} vs {lkey(b['metric'])}"
        d = cmp_points(a['values'], b['values']) if t == 'matrix' else cmp_points([a['value']], [b['value']])
        if d:
            return lkey(a['metric']) + ': ' + d
    return None


def main():
    cases = json.load(open(sys.argv[1]))['cases']
    loki = {c['id']: c for c in json.load(open(sys.argv[2]))['cases']}
    show = int(sys.argv[sys.argv.index('--show') + 1]) if '--show' in sys.argv else 20
    counts = defaultdict(int)
    by_feature = defaultdict(lambda: defaultdict(int))
    unexplained = []
    classes = defaultdict(int)
    for c in cases:
        l = loki[c['id']]
        lerr = l.get('loki_err')
        if lerr and not c['viz_ok']:
            v = 'both_error'
        elif lerr or not c['viz_ok']:
            v = 'mismatch'
            detail = ('loki error: ' + lerr[:200]) if lerr else ('viz error: ' + c.get('viz_err', '')[:200])
        else:
            detail = compare(c['query'], c['instant'], l['loki'], c['viz_data'], c.get('direction') != 'backward')
            v = 'mismatch' if detail else 'agree'
        if v == 'mismatch':
            cls = None
            for name, _desc, pred in KNOWN:
                if pred(c, l, detail):
                    cls = name
                    break
            if cls:
                classes[cls] += 1
                v = 'explained'
            else:
                unexplained.append((c, detail))
        counts[v] += 1
        by_feature[c['feature']][v] += 1
    print('evaluations:', len(cases), dict(counts))
    for f, d in sorted(by_feature.items()):
        print('  ', f, dict(d))
    for k, n in sorted(classes.items()):
        print('  explained:', k, n)
    for c, d in unexplained[:show]:
        print('UNEXPLAINED', c['id'], ('instant ' if c['instant'] else '') + c['query'], '\n     ', d)
    sys.exit(1 if unexplained else 0)


main()
