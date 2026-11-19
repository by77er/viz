# Black-box probe of Tempo's regular expressions (=~ and !~), through tools/godiff.
#
#   VIZ_TQ_WORK=$SCRATCH python3 -I tools/probes/regex_dialect.py testdata/regex_dialect.json [--record]
#
# The case file lists subject strings and patterns. One trace is built: a root span named
# "root" and one child per subject, carrying it as the span attribute `s`. Every pattern is
# run in four forms, so that both Tempo's storage-side and evaluator-side matching are seen:
#   plain   { span.s =~ `P` }
#   or      { span.s =~ `P` || span.zz = 1 }       (a disjunction the evaluator re-checks)
#   struct  { name = "root" } > { span.s =~ `P` }  (structural: evaluated per span)
#   neg     { span.s !~ `P` }                      (must be the complement of plain)
# Patterns are written as backtick strings, so the query text holds them unescaped.
#
# Without --record it prints, per pattern, the subjects Tempo matched and any disagreement
# between the forms. With --record it writes Tempo's answer of the plain form into the case
# file ("tempo": matched subject indices, or {"error": message}), and the other forms only
# where they differ ("tempo_forms"). tests/regex_dialect.rs checks viz against that record.
import json, os, subprocess, sys

SCR = os.environ['VIZ_TQ_WORK']  # a scratch directory holding bin/godiff and probe/
S = 1_700_000_000_000_000_000
TRACE = "5e" * 16
ROOT = "%016x" % 0xFFFF

path = sys.argv[1]
record = '--record' in sys.argv
spec = json.load(open(path, encoding='utf-8'))
subjects = spec['subjects']

res = [[{"key": "service.name", "type": "str", "value": "regex"}]]
scopes = [{"name": "", "version": "", "attrs": []}]


def span(sid, parent, name, attrs):
    return {"trace_id": TRACE, "span_id": sid, "parent_span_id": parent, "name": name, "kind": 2,
            "status_code": 0, "status_message": "", "start": str(S), "end": str(S + 1_000_000),
            "resource": 0, "scope": 0, "attrs": attrs, "events": [], "links": []}


spans = [span(ROOT, "", "root", [])]
for i, s in enumerate(subjects):
    spans.append(span("%016x" % (i + 1), ROOT, "s%d" % i, [{"key": "s", "type": "str", "value": s}]))

FORMS = {
    "plain": "{ span.s =~ `%s` }",
    "or": "{ span.s =~ `%s` || span.zz = 1 }",
    "struct": "{ name = \"root\" } > { span.s =~ `%s` }",
    "neg": "{ span.s !~ `%s` }",
}
cases = []
for ci, c in enumerate(spec['cases']):
    assert '`' not in c['pattern'], c['pattern']
    for f, tmpl in FORMS.items():
        cases.append({"id": len(cases), "dataset": 0, "kind": "search", "query": tmpl % c['pattern'],
                      "limit": 100, "spss": 100000, "_case": ci, "_form": f})

os.makedirs(SCR + '/probe', exist_ok=True)
json.dump({"datasets": [{"resources": res, "scopes": scopes, "spans": spans}],
           "cases": [{k: v for k, v in c.items() if not k.startswith('_')} for c in cases]},
          open(SCR + '/probe/regex_cases.json', 'w'))
subprocess.run([SCR + '/bin/godiff', '-cases', SCR + '/probe/regex_cases.json', '-out', SCR + '/probe/regex_out.json'],
               check=True, stderr=subprocess.DEVNULL)
outs = json.load(open(SCR + '/probe/regex_out.json'))


def answer(o):
    if o.get('error'):
        return {"error": o['error']}
    got = set()
    for tr in o['tempo'].get('traces', []):
        for ss in tr.get('spanSets', []):
            for sp in ss.get('spans', []):
                k = int(sp['spanID'], 16)
                if k != 0xFFFF:
                    got.add(k - 1)
    return sorted(got)


per = {}
for c, o in zip(cases, outs):
    per.setdefault(c['_case'], {})[c['_form']] = answer(o)

disagree = 0
for ci, c in enumerate(spec['cases']):
    a = per[ci]
    plain = a['plain']
    forms = {}
    for f in ('or', 'struct'):
        if a[f] != plain:
            forms[f] = a[f]
    if isinstance(plain, list):
        comp = sorted(set(range(len(subjects))) - set(plain))
        if a['neg'] != comp:
            forms['neg'] = a['neg']
    elif a['neg'] != plain:
        forms['neg'] = a['neg']
    if forms:
        disagree += 1
    shown = plain if isinstance(plain, dict) else [subjects[i] if len(subjects[i]) < 20 else subjects[i][:8] + '...' for i in plain]
    print(f"{c['pattern']!r:28} {json.dumps(shown, ensure_ascii=True)[:300]}" + (f"   FORMS DIFFER: {json.dumps(forms)[:300]}" if forms else ''))
    if record:
        c['tempo'] = plain
        if forms:
            c['tempo_forms'] = forms
        else:
            c.pop('tempo_forms', None)
print(f"{len(spec['cases'])} patterns, {len(cases)} queries; forms disagree on {disagree} patterns")
if record:
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(spec, fh, ensure_ascii=False, indent=1)
        fh.write('\n')
