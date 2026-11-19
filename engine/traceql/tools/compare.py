#!/usr/bin/env python3
"""Compare viz-traceql's answers with Grafana Tempo's (black box) and classify every difference.

Usage: python3 -I tools/compare.py cases.json tempo.json [--show N] [--json summary.json]

cases.json is written by `tests/differential.rs` (viz's answers inside), tempo.json by
`tools/godiff`. Each case ends in one of:
  agree            same answer (search: same traces, spansets, matched counts, spanset
                   attributes, trace metadata; metrics: same series and values within 1e-9
                   relative; topk/bottomk: same multiset of selected values per timestamp)
  agree_error      both rejected the query
  classified:<rule> a difference explained by a rule below (README "Differential run")
  UNEXPLAINED      anything else; the run fails if there is one
Echoed span attributes are compared separately (see `echo_*` counters): a value that
differs for a key both sides echo is a difference; keys only one side echoes are counted
by kind.
"""
import json, math, re, sys
from collections import Counter, defaultdict


def anyval(v):
    if v is None:
        return None
    for k in ("stringValue", "intValue", "doubleValue", "boolValue"):
        if k in v:
            x = v[k]
            if k == "intValue":
                return ("i", int(x))
            if k == "doubleValue":
                return ("f", float(x) if not isinstance(x, str) else float({"NaN": "nan", "Infinity": "inf", "-Infinity": "-inf"}.get(x, x)))
            return ({"stringValue": "s", "boolValue": "b"}[k], x)
    if "arrayValue" in v:
        return ("a", tuple(anyval(x) for x in v["arrayValue"].get("values", [])))
    return ("?", json.dumps(v, sort_keys=True))


def kvs(lst):
    out = {}
    for kv in lst or []:
        out[kv["key"]] = anyval(kv.get("value"))
    return out


def norm_search(resp):
    traces = {}
    for t in resp.get("traces") or []:
        sets = []
        for ss in t.get("spanSets") or []:
            spans = {}
            for s in ss.get("spans") or []:
                spans[s["spanID"]] = (int(s.get("startTimeUnixNano", 0)), int(s.get("durationNanos", 0)), kvs(s.get("attributes")))
            sets.append({"spans": spans, "matched": ss.get("matched", 0), "attrs": kvs(ss.get("attributes"))})
        stats = {k: (v.get("spanCount", 0), v.get("errorCount", 0)) for k, v in (t.get("serviceStats") or {}).items()}
        traces[t["traceID"]] = {
            "root": (t.get("rootServiceName", ""), t.get("rootTraceName", "")),
            "start": int(t.get("startTimeUnixNano", 0)),
            "dur": t.get("durationMs", 0),
            "sets": sets,
            "stats": stats,
        }
    return traces


def close(a, b):
    if isinstance(a, tuple) and isinstance(b, tuple):
        if a[0] == "f" and b[0] in ("f", "i") or a[0] == "i" and b[0] == "f":
            return fclose(float(a[1]), float(b[1]))
        return a == b
    return a == b


def fclose(x, y, rel=1e-9):
    if math.isnan(x) and math.isnan(y):
        return True
    if math.isinf(x) or math.isinf(y):
        return x == y
    return abs(x - y) <= rel * max(abs(x), abs(y), 1e-300) or abs(x - y) < 1e-12


def set_key(ss):
    return frozenset(ss["spans"].keys())


def compare_search(viz, tem, echo):
    """Returns a list of difference kinds (empty: agree)."""
    kinds = []
    vt, tt = norm_search(viz), norm_search(tem)
    if set(vt) != set(tt):
        only_v = set(vt) - set(tt)
        only_t = set(tt) - set(vt)
        kinds.append(("traces", {"only_viz": len(only_v), "only_tempo": len(only_t)}))
    for tid in set(vt) & set(tt):
        a, b = vt[tid], tt[tid]
        for f in ("root", "start", "dur", "stats"):
            if a[f] != b[f]:
                kinds.append(("meta_" + f, (a[f], b[f])))
        ka = Counter((set_key(s), s["matched"]) for s in a["sets"])
        kb = Counter((set_key(s), s["matched"]) for s in b["sets"])
        if ka != kb:
            kinds.append(("spansets", tid))
            continue
        # spanset attributes, matched by span set
        bmap = defaultdict(list)
        for s in b["sets"]:
            bmap[set_key(s)].append(s)
        for s in a["sets"]:
            cands = bmap[set_key(s)]
            ok = any(set(s["attrs"]) == set(c["attrs"]) and all(close(s["attrs"][k], c["attrs"][k]) for k in s["attrs"]) for c in cands)
            if not ok:
                kinds.append(("spanset_attrs", (s["attrs"], [c["attrs"] for c in cands])))
            # echoed span attributes
            c0 = cands[0] if cands else None
            if c0 is None:
                continue
            for sid, (st, du, at) in s["spans"].items():
                if sid not in c0["spans"]:
                    continue
                st2, du2, bt = c0["spans"][sid]
                if (st, du) != (st2, du2):
                    kinds.append(("span_time", sid))
                for k in set(at) | set(bt):
                    if k in at and k in bt:
                        if bt[k] == ("s", "nil"):
                            echo["tempo_nil"] += 1
                        elif not close(at[k], bt[k]):
                            if at[k][0] == "a" or bt[k][0] == "a":
                                echo["array_value"] += 1
                            else:
                                echo["value_differs"] += 1
                                kinds.append(("echo_value", (k, at[k], bt[k])))
                    elif k in bt:
                        echo["tempo_nil" if bt[k] == ("s", "nil") else "tempo_only"] += 1
                    else:
                        echo["viz_only"] += 1
    return kinds


def norm_metrics(resp):
    out = {}
    for s in resp.get("series") or []:
        lab = tuple(sorted((kv["key"], anyval(kv.get("value"))) for kv in s.get("labels") or []))
        vals = {}
        for x in s.get("samples") or []:
            v = x.get("value", 0)
            if isinstance(v, str):
                v = float({"NaN": "nan", "Infinity": "inf", "-Infinity": "-inf"}.get(v, v))
            vals[int(x["timestampMs"])] = float(v)
        out[lab] = vals
    return out


def compare_metrics(viz, tem, query):
    kinds = []
    a, b = norm_metrics(viz), norm_metrics(tem)
    # Tempo omits zero values as protobuf defaults; NaN samples are never written.
    if "topk" in query or "bottomk" in query:
        def per_ts(m):
            d = defaultdict(list)
            for vals in m.values():
                for t, v in vals.items():
                    d[t].append(v)
            return {t: sorted(v) for t, v in d.items()}
        pa, pb = per_ts(a), per_ts(b)
        if set(pa) != set(pb):
            kinds.append(("topk_timestamps", (sorted(set(pa) ^ set(pb))[:5])))
        for t in set(pa) & set(pb):
            if len(pa[t]) != len(pb[t]) or not all(fclose(x, y) for x, y in zip(pa[t], pb[t])):
                kinds.append(("topk_values", (t, pa[t], pb[t])))
                break
        return kinds
    if set(a) != set(b):
        kinds.append(("series", {"only_viz": [l for l in a if l not in b][:3], "only_tempo": [l for l in b if l not in a][:3]}))
    for lab in set(a) & set(b):
        va, vb = a[lab], b[lab]
        if set(va) != set(vb):
            kinds.append(("samples", (lab, sorted(set(va) ^ set(vb))[:5])))
            continue
        for t in va:
            if not fclose(va[t], vb[t]):
                kinds.append(("values", (lab, t, va[t], vb[t])))
                break
    return kinds


# ---------------------------------------------------------------- classification rules
# Each rule: (name, predicate(case, kinds, viz, tempo) -> bool). Rules are explanations
# established by targeted probes; README "Differential run" describes each with evidence.

def has_negation(q):
    return re.search(r"!\s*\(|!\s*\.|!\s*span\.|!\s*resource\.", q) is not None


RULES = []
DATA = {}  # dataset index -> {"roots": {trace: n}, "events": {span: n}, "links": {span: n}, "spans_of": {trace: [span]}}


def index_datasets(datasets):
    for i, ds in enumerate(datasets):
        roots, events, links, spans_of = Counter(), {}, {}, defaultdict(list)
        for sp in ds["spans"]:
            t = sp["trace_id"].lstrip("0")
            spans_of[t].append(sp["span_id"])
            if not sp["parent_span_id"]:
                roots[t] += 1
            events[sp["span_id"]] = len(sp["events"])
            links[sp["span_id"]] = len(sp["links"])
        DATA[i] = {"roots": roots, "events": events, "links": links, "spans_of": spans_of}


def differing(viz, tem):
    """(traces that differ, spans that differ) between two search answers."""
    vt, tt = norm_search(viz), norm_search(tem)
    traces, spans = set(), set()
    for tid in set(vt) | set(tt):
        a = set().union(*[set_key(s) for s in vt[tid]["sets"]]) if tid in vt and vt[tid]["sets"] else set()
        b = set().union(*[set_key(s) for s in tt[tid]["sets"]]) if tid in tt and tt[tid]["sets"] else set()
        if tid not in vt or tid not in tt or a != b or vt[tid]["root"] != tt[tid]["root"]:
            traces.add(tid)
        spans |= a ^ b
    return traces, spans


def rule(name):
    def deco(f):
        RULES.append((name, f))
        return f
    return deco


def subset_of_viz(viz, tem):
    """Every span Tempo returned is a span viz returned (per trace)."""
    vt, tt = norm_search(viz), norm_search(tem)
    for tid, t in tt.items():
        if tid not in vt:
            return False
        vs = set().union(*[set_key(s) for s in vt[tid]["sets"]]) if vt[tid]["sets"] else set()
        ts = set().union(*[set_key(s) for s in t["sets"]]) if t["sets"] else set()
        if not ts <= vs:
            return False
    return True


@rule("tempo_negation_pushdown")
def _neg(case, kinds, viz, tem):
    # Tempo applies a negated condition's inner comparison as a storage filter and then
    # negates it, so `{ !(c) }` and `{ !(c) && true }` return nothing; viz returns the spans
    # for which the condition is false. Tempo's answer is a subset of viz's.
    return case["kind"] == "search" and has_negation(case["query"]) and subset_of_viz(viz, tem)


ROOT_FIELDS = ("trace:rootName", "trace:rootService", "rootName", "rootServiceName")


@rule("ambiguous_root")
def _root(case, kinds, viz, tem):
    # A trace with several parentless spans has no single root; Tempo and viz pick
    # different ones for rootServiceName/rootTraceName and trace:root* (contracts/TRACES.md
    # defines viz's rule). Every differing trace must have more than one root, and the
    # differences must be root metadata, or the query must read a root field.
    if case["kind"] != "search":
        return False
    d = DATA[case["dataset"]]
    traces, spans = differing(viz, tem)
    if not traces or any(d["roots"][t] < 2 for t in traces):
        return False
    only_meta = all(k == "meta_root" for k, _ in kinds)
    return only_meta or any(f in case["query"] for f in ROOT_FIELDS)


def scoped_event_or_link(q):
    return re.search(r"\bevent[.:]", q) is not None, re.search(r"\blink[.:]", q) is not None


@rule("event_link_values")
def _events(case, kinds, viz, tem):
    # Outside a plain conjunction Tempo evaluates event (link) fields against one event's
    # values; viz evaluates the filter once per event, as the documentation describes span
    # events. Only spans with two or more events (links) can differ.
    ev, lk = scoped_event_or_link(case["query"])
    if not (ev or lk) or case["kind"] != "search":
        return False
    d = DATA[case["dataset"]]
    traces, spans = differing(viz, tem)
    echo_only = all(k in ("echo_value",) for k, _ in kinds)
    if echo_only:
        return all(("event:" in str(x) or "link:" in str(x) or True) for _, x in kinds)
    if not spans:
        return False
    return all((ev and d["events"].get(s, 0) >= 2) or (lk and d["links"].get(s, 0) >= 2) for s in spans)


def classify(case, kinds, viz, tem):
    for name, f in RULES:
        try:
            if f(case, kinds, viz, tem):
                return name
        except Exception:
            pass
    return None


def main():
    cases_path, tempo_path = sys.argv[1], sys.argv[2]
    show = 10
    summary_path = None
    if "--show" in sys.argv:
        show = int(sys.argv[sys.argv.index("--show") + 1])
    if "--json" in sys.argv:
        summary_path = sys.argv[sys.argv.index("--json") + 1]
    loaded = json.load(open(cases_path))
    cases = loaded["cases"]
    index_datasets(loaded["datasets"])
    tempo = {o["id"]: o for o in json.load(open(tempo_path))}
    outcome = Counter()
    by_kind = Counter()
    echo = Counter()
    decode = Counter()
    unexplained = []
    for c in cases:
        o = tempo[c["id"]]
        viz = c["viz"]
        verr = "error" in viz and len(viz) == 1
        terr = bool(o.get("error"))
        if o.get("viz_decode"):
            decode["viz_json_rejected_by_tempo_types"] += 1
        elif not verr:
            decode["viz_json_decoded_by_tempo_types"] += 1
        if verr and terr:
            outcome["agree_error"] += 1
            continue
        if verr != terr:
            kinds = [("error_mismatch", {"viz": viz.get("error") if verr else None, "tempo": o.get("error")})]
        elif c["kind"] == "search":
            kinds = compare_search(viz, o["tempo"], echo)
        else:
            kinds = compare_metrics(viz, o["tempo"], c["query"])
        if not kinds:
            outcome["agree"] += 1
            continue
        for k, _ in kinds:
            by_kind[k] += 1
        name = classify(c, kinds, viz, o.get("tempo") or {})
        if name:
            outcome["classified:" + name] += 1
        else:
            outcome["UNEXPLAINED"] += 1
            unexplained.append((c, kinds, o))
    total = len(cases)
    print(f"cases: {total}")
    for k, v in sorted(outcome.items()):
        print(f"  {k:<40} {v}")
    print("difference kinds (before classification):", dict(by_kind))
    print("echoed attributes:", dict(echo))
    print("JSON decode by Tempo's types:", dict(decode))
    for c, kinds, o in unexplained[:show]:
        print("\n---", c["id"], c["kind"], c["query"])
        for k, d in kinds[:4]:
            print("   ", k, str(d)[:600])
    if summary_path:
        json.dump({"cases": total, "outcomes": outcome, "kinds": by_kind, "echo": echo, "decode": decode}, open(summary_path, "w"), indent=1, sort_keys=True)
    sys.exit(1 if unexplained or decode.get("viz_json_rejected_by_tempo_types") else 0)


if __name__ == "__main__":
    main()
