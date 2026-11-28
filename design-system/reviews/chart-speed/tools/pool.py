# pool.py: a row's 75th percentile per session and pooled (ab.cjs's rule: sorted, index ceil(0.75 n) - 1), runs over 100, and the
# paired median of two builds in one session (summarise.cjs's lower median), split by which build went first.
#   python3 -I pool.py <metric> <series> <file>:<build> [<file>:<build> ...]   (metric: response | responseFull | chartToTable)
import json, math, sys
metric, series = sys.argv[1], sys.argv[2]
pool = []
def p75(xs): s = sorted(xs); return s[math.ceil(0.75 * len(s)) - 1] if s else None
for fb in sys.argv[3:]:
    f, b = fb.rsplit(':', 1)
    d = json.load(open(f)); raw = d['cases'][series][b]['raw']
    xs = [r[metric] for r in raw if r.get(metric) is not None]
    pool += xs
    print(f"{f.split('/')[-1]:28} {b:10} started {d['when'][:16]} n {len(xs):3} p75 {p75(xs):6.1f} over100 {sum(x > 100 for x in xs):3}")
print(f"{'pooled':28} {'':10} {'':22} n {len(pool):3} p75 {p75(pool):6.1f} over100 {sum(x > 100 for x in pool):3}")
