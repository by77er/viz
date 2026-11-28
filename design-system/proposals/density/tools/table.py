"""Markdown tables from the measurement JSON of each build. python3 -I table.py <out dir> baseline A B C"""
import json, sys, os
out = sys.argv[1]
labels = sys.argv[2:]
data = {l: json.load(open(os.path.join(out, l, f'{l}-measurements.json'))) for l in labels}
views = ['explore-4', 'explore-36', 'list', 'services', 'red']
layouts = ['1440-fine', '400-coarse']
print('| View | Layout | Build | First data mark, px | Page height, px | Panels fully in first screen | Panels begun in first screen | Data share of first screen | Legend share | Control rows above first panel | Tab stops to first panel | Controls in first screen |')
print('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for v in views:
    for L in layouts:
        for l in labels:
            m = data[l].get(f'{v}/{L}')
            if not m:
                print(f'| {v} | {L} | {l} | not measured | | | | | | | | |'); continue
            tabs = m.get('tabStops')
            print(f"| {v} | {L} | {l} | {m['firstMark']} | {m['pageHeight']} | {m['fullyVisible']} of {m['panels']} | {m['startedVisible']} | {round(m['dataShare']*100)}% | {round(m['legendShare']*100)}% | {m['controlRowsAbove']} | {tabs if tabs is not None else 'n/a'} | {m['controlsInView']} |")
print()
print('Per-panel chrome on "Services overview" (px; median over panels of a kind):')
print()
print('| Layout | Build | Kind | Panel height | Head | Description | Foot (text form, Explore) | Legend | Data (plot / figure / rows) | Chrome share |')
print('|---|---|---|---:|---:|---:|---:|---:|---:|---:|')
import statistics as st
for L in layouts:
    for l in labels:
        m = data[l].get(f'services/{L}')
        if not m: continue
        for kind in ['stat', 'timeseries', 'table']:
            ps = [p for p in m['per'] if p['kind'] == kind]
            if not ps: continue
            med = lambda k: round(st.median([p[k] for p in ps]))
            share = round(100 * st.median([p['chrome'] / p['total'] for p in ps]))
            print(f"| {L} | {l} | {kind} ({len(ps)}) | {med('total')} | {med('head')} | {med('desc')} | {med('foot')} | {med('legend')} | {med('data')} | {share}% |")
