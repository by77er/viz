"""Fixtures from independent implementations, for test/stl.test.ts and test/pelt.test.ts.

  python3 -m venv .venv && .venv/bin/pip install statsmodels==0.15.0 ruptures==1.1.10
  .venv/bin/python scripts/make-fixtures.py

statsmodels' STL (a port of Cleveland's stl.f) and ruptures' Pelt (l2 cost) are run on
deterministic synthetic series; inputs and outputs are written to test/fixtures/*.json.
"""
import json, math, sys
import numpy as np
import statsmodels
import ruptures as rpt
from statsmodels.tsa.seasonal import STL

out = sys.argv[1] if len(sys.argv) > 1 else 'test/fixtures'
rng = np.random.default_rng(20261118)

def series(n, period, trend, noise, outliers):
    t = np.arange(n)
    y = 10 + trend * t + 3 * np.sin(2 * np.pi * t / period) + 1.5 * np.cos(4 * np.pi * t / period) + noise * rng.standard_normal(n)
    for i, v in outliers:
        y[i] += v
    return y

cases = []
for name, n, period, kw in [
    ('p24_robust', 240, 24, dict(robust=True)),
    ('p24_plain', 240, 24, dict(robust=False)),
    ('p12_robust_s13', 144, 12, dict(robust=True, seasonal=13)),
    ('p7_plain_short', 21, 7, dict(robust=False)),
]:
    y = series(n, period, 0.02, 0.5, [(n // 3, 15.0), (2 * n // 3, -12.0)])
    res = STL(y, period=period, **kw).fit()
    cases.append(dict(name=name, period=period, options=kw, y=y.tolist(), seasonal=np.asarray(res.seasonal).tolist(),
                      trend=np.asarray(res.trend).tolist(), resid=np.asarray(res.resid).tolist(), weights=np.asarray(res.weights).tolist()))
json.dump(dict(source=f'statsmodels {statsmodels.__version__} STL', cases=cases), open(f'{out}/stl.json', 'w'))

pcases = []
for name, segs, sigma, min_size, pen_sigma2 in [
    ('three_shifts', [(80, 0.0), (60, 4.0), (100, 1.0), (60, -3.0)], 1.0, 5, None),
    ('small_shift_noisy', [(150, 0.0), (150, 1.2)], 1.0, 5, None),
    ('no_change', [(300, 5.0)], 2.0, 5, None),
    ('custom_penalty', [(50, 0.0), (50, 2.0), (50, 0.0)], 1.0, 3, 30.0),
]:
    x = np.concatenate([m + sigma * rng.standard_normal(k) for k, m in segs])
    n = len(x)
    pen = pen_sigma2 if pen_sigma2 is not None else 2 * math.log(n)
    # ruptures' l2 cost is the raw sum of squares; our cost is divided by sigma^2, so pass pen*sigma^2
    algo = rpt.Pelt(model='l2', min_size=min_size, jump=1).fit(x.reshape(-1, 1))
    bkps = algo.predict(pen=pen * sigma * sigma)
    pcases.append(dict(name=name, x=x.tolist(), sigma=sigma, minSegment=min_size, penalty=pen, breakpoints=bkps))
json.dump(dict(source=f'ruptures {rpt.__version__} Pelt(model=l2, jump=1)', cases=pcases), open(f'{out}/pelt.json', 'w'))
print('ok', len(cases), len(pcases))
