# pair.py <file> <series> <buildA> <buildB>: paired (B less A) median per metric, quicker count, split by which went first
import json, sys
f, n, A, B = sys.argv[1:5]
d = json.load(open(f)); c = d['cases'][n]; a, b = c[A]['raw'], c[B]['raw']
order = [x['name'] for x in d['builds']]
med = lambda xs: sorted(xs)[(len(xs) - 1) // 2] if xs else None
for k in ['response', 'responseFull', 'chartToTable']:
    ds = [(i, b[i][k] - a[i][k]) for i in range(min(len(a), len(b))) if a[i].get(k) is not None and b[i].get(k) is not None]
    # ab.cjs alternates: run i even -> builds in listed order, odd -> reversed
    first_listed = [x for i, x in ds if i % 2 == 0]; first_rev = [x for i, x in ds if i % 2 == 1]
    v = [x for _, x in ds]
    print(f"{n} {k:13} {B} less {A}: median {med(v):+.0f}, quicker in {sum(x < 0 for x in v)} of {len(v)}; {order[0]} first {med(first_listed):+.0f}, {order[1]} first {med(first_rev):+.0f}")
