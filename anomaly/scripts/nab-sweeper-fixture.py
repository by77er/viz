"""Score toy cases with NAB's own nab/sweeper.py (stdlib only), for test/nab-scorer.test.ts.

  python3 -I scripts/nab-sweeper-fixture.py bench/data/nab/src test/fixtures/nab-sweeper.json

The first argument is the directory holding NAB's sweeper.py (fetched by bench/fetch-nab.sh).
"""
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location('sweeper', sys.argv[1] + '/sweeper.py')
sw = importlib.util.module_from_spec(spec); spec.loader.exec_module(sw)
profiles = {
  'standard': {'tpWeight': 1.0, 'fnWeight': 1.0, 'fpWeight': 0.11},
  'reward_low_FP_rate': {'tpWeight': 1.0, 'fnWeight': 1.0, 'fpWeight': 0.22},
  'reward_low_FN_rate': {'tpWeight': 1.0, 'fnWeight': 2.0, 'fpWeight': 0.11},
}
def case(name, n, windows, detections, threshold=0.5):
    ts = list(range(n))  # sweeper only needs equality and order of timestamps
    scores = [0.0] * n
    for i, v in detections: scores[i] = v
    wl = [(ts[a], ts[b]) for a, b in windows]
    out = {'name': name, 'n': n, 'windows': windows, 'scores': scores, 'threshold': threshold, 'results': {}}
    for p, cm in profiles.items():
        s = sw.Sweeper(probationPercent=0.15, costMatrix=cm)
        per_row, row = s.scoreDataSet(ts, scores, list(wl), name, threshold)
        rows = s.calcScoreByThreshold(s.calcSweepScore(ts, scores, list(wl), name))
        best = sorted(rows, key=lambda r: r.score, reverse=True)[0]
        out['results'][p] = {'score': row.score, 'tp': row.tp, 'fp': row.fp, 'fn': row.fn, 'tn': row.tn,
                             'rowScores': per_row, 'bestThreshold': best.threshold, 'bestScore': best.score}
    return out
cases = [
  case('early_tp', 100, [[60, 69]], [(60, 1.0)]),
  case('mid_tp_and_fps', 100, [[60, 69]], [(65, 0.9), (20, 0.8), (72, 0.7), (95, 0.6)]),
  case('two_windows_one_missed', 200, [[40, 59], [140, 159]], [(45, 0.8), (50, 0.9), (100, 0.75), (165, 0.95)]),
  case('window_in_probation', 100, [[5, 20]], [(18, 1.0), (30, 0.4)]),
  case('graded_scores', 300, [[100, 129], [200, 229]], [(i, (i % 17) / 17.0) for i in range(0, 300, 3)], threshold=0.6),
]
json.dump({'source': 'NAB nab/sweeper.py (master, fetched 2026-11-18)', 'cases': cases}, open(sys.argv[2], 'w'))
print('ok', len(cases))
