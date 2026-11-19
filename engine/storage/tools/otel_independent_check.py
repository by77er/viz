#!/usr/bin/env python3
"""Independent readers for the span and log tables (AGENTS.md, "Independent readers").

Reads every file `readback` wrote (OUT/manifest.json, OUT/files/*.parquet) with PyArrow and
with DuckDB, neither of which shares code with the Rust `parquet` crate, and checks:

  1. every column of every file reads in both, with the contract's schema (names, physical
     and logical types, repetition);
  2. physical rules: row-group caps, sort order, hour and day partitions, promoted columns
     holding exactly their keys with the column's type, the residual maps never holding a
     key that belongs in a column, nulls where the contract says null;
  3. the index fragment against the file (row groups, rows, offsets, lengths, names, times,
     `sid`, `streams`, `foot`);
  4. the logical rows rebuilt here (promoted columns and residual maps merged, the "other"
     JSON split back into keys, duplicates across units resolved with the later unit winning)
     equal the generator's expected rows (OUT/spans.jsonl, OUT/logs.jsonl) exactly, doubles
     by their bits (PyArrow);
  5. each unit's trace_index rows equal what that unit's spans say (recomputed here);
  6. DuckDB's rows equal PyArrow's, column by column (doubles as numbers, NaN as NaN).

    python3 -m venv /tmp/v && /tmp/v/bin/pip install pyarrow duckdb
    /tmp/v/bin/python -I tools/otel_independent_check.py OUT
"""
import json
import math
import os
import struct
import sys
from collections import defaultdict

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

OUT = sys.argv[1]
checks = 0
failures = []


def check(what, ok, detail=""):
    global checks
    checks += 1
    if not ok:
        failures.append(f"{what} {detail}"[:600])


def ub(s):
    return s.encode("utf-8")


PROMOTED_RESOURCE = [("service_name", "service.name"), ("r_service_namespace", "service.namespace"),
                     ("r_deployment_environment", "deployment.environment.name"), ("r_k8s_namespace_name", "k8s.namespace.name"),
                     ("r_k8s_pod_name", "k8s.pod.name"), ("r_cloud_region", "cloud.region")]
PROMOTED_SPAN = [("s_http_request_method", "http.request.method", "s"), ("s_http_response_status_code", "http.response.status_code", "i"),
                 ("s_http_route", "http.route", "s"), ("s_db_system_name", "db.system.name", "s"), ("s_rpc_service", "rpc.service", "s"),
                 ("s_error_type", "error.type", "s")]

SPANS_SCHEMA = {
    "trace_id": "fixed_size_binary[16]", "span_id": "fixed_size_binary[8]", "parent_span_id": "fixed_size_binary[8]", "trace_state": "string",
    "flags": "int32", "start_unix_nano": "int64", "end_unix_nano": "int64", "duration_nano": "int64", "start_time": "timestamp[us, tz=UTC]",
    "service_name": "string", "span_name": "string", "span_kind": "int32", "status_code": "int32", "status_message": "string",
    "scope_name": "string", "scope_version": "string", "resource_fp": "int64",
}
NOT_NULL_SPANS = {"trace_id", "span_id", "start_unix_nano", "end_unix_nano", "duration_nano", "start_time", "span_name", "span_kind", "status_code", "resource_fp"}


def dbits(x):
    return format(struct.unpack("<Q", struct.pack("<d", x))[0], "x")


def other_items(cell):
    """The `_other` cell: [{"key":K,"value":V},...] -> [(K, canonical text of V)]."""
    if cell is None:
        return []
    items = json.loads(cell)
    # Re-serialise each value as canonical OTLP JSON would be: the generator wrote it with
    # JSON.stringify, which these settings reproduce for the values in the corpus.
    out = []
    # Cut the raw text so that number formatting is never re-done.
    text = cell
    pos = 1
    for it in items:
        key_json = json.dumps(it["key"], ensure_ascii=False, separators=(",", ":"))
        head = '{"key":' + key_json + ',"value":'
        check("other cell layout", text.startswith(head, pos), cell[:100])
        pos += len(head)
        depth, i, in_str = 0, pos, False
        while True:
            c = text[i]
            if in_str:
                if c == "\\":
                    i += 1
                elif c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c in "{[":
                depth += 1
            elif c in "}]":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        out.append((it["key"], text[pos:i + 1]))
        pos = i + 2 + 1  # closing brace of the entry, then a comma or the closing bracket
    return out


def logical_attrs(row, scope):
    """Promoted columns + residual maps -> sorted [[key, type, value]] (TRACES.md, Logical view)."""
    out = []
    promoted = PROMOTED_RESOURCE if scope == "resource" else [(c, k) for c, k, _ in PROMOTED_SPAN]
    for col, key in promoted:
        v = row[col]
        if v is not None:
            out.append([key, "i" if isinstance(v, int) else "s", str(v)])
    for k, v in row[f"{scope}_attrs_str"] or []:
        out.append([k, "s", v])
    for k, v in row[f"{scope}_attrs_int"] or []:
        out.append([k, "i", str(v)])
    for k, v in row[f"{scope}_attrs_dbl"] or []:
        out.append([k, "d", dbits(v)])
    for k, v in row[f"{scope}_attrs_bool"] or []:
        out.append([k, "b", "true" if v else "false"])
    for k, v in other_items(row[f"{scope}_attrs_other"]):
        out.append([k, "o", v])
    out.sort(key=lambda t: ub(t[0]))
    keys = [t[0] for t in out]
    check(f"{scope} attribute keys unique", len(keys) == len(set(keys)), str(keys))
    return out


def physical_span_rules(row):
    # A promoted key never also sits in a residual map with the column's type.
    for col, key in PROMOTED_RESOURCE:
        res = {k for k, _ in (row["resource_attrs_str"] or [])}
        check("promoted resource key not residual", key not in res, key)
    for col, key, t in PROMOTED_SPAN:
        m = row["span_attrs_int" if t == "i" else "span_attrs_str"] or []
        check("promoted span key not residual", key not in {k for k, _ in m}, key)
    for c in ("trace_state", "status_message", "scope_name", "scope_version", "scope_attrs"):
        check(f"{c} null when empty", row[c] != "", c)
    for c in ("flags", "dropped_attributes_count", "dropped_events_count", "dropped_links_count"):
        check(f"{c} null when zero", row[c] != 0, c)
    check("events null when none", row["events"] != [], "")
    check("links null when none", row["links"] != [], "")
    check("duration", row["duration_nano"] == row["end_unix_nano"] - row["start_unix_nano"])
    check("end >= start", row["end_unix_nano"] >= row["start_unix_nano"])


def span_json(row):
    return {
        "trace_id": row["trace_id"].hex(), "span_id": row["span_id"].hex(),
        "parent_span_id": None if row["parent_span_id"] is None else row["parent_span_id"].hex(),
        "trace_state": row["trace_state"] or "", "flags": (row["flags"] or 0) & 0xFFFFFFFF,
        "start": str(row["start_unix_nano"]), "end": str(row["end_unix_nano"]), "kind": row["span_kind"], "status": row["status_code"],
        "status_message": row["status_message"] or "", "name": row["span_name"], "resource_fp": str(row["resource_fp"]),
        "resource": logical_attrs(row, "resource"), "attrs": logical_attrs(row, "span"),
        "scope_name": row["scope_name"] or "", "scope_version": row["scope_version"] or "", "scope_attrs": row["scope_attrs"] or "",
        "events": [[str(e["time_unix_nano"]), e["name"], e["attrs"]] for e in (row["events"] or [])],
        "links": [[l["trace_id"].hex(), l["span_id"].hex(), l["trace_state"], l["attrs"]] for l in (row["links"] or [])],
        "dropped": [row["dropped_attributes_count"] or 0, row["dropped_events_count"] or 0, row["dropped_links_count"] or 0],
    }


def as_rows(table):
    """PyArrow table -> list of dicts, maps as lists of (key, value) pairs."""
    cols = {}
    for name in table.column_names:
        col = table.column(name)
        if pa.types.is_map(col.type):
            cols[name] = [None if m is None else [(k, v) for k, v in m] for m in col.to_pylist()]
        elif pa.types.is_timestamp(col.type):
            cols[name] = col.cast(pa.int64()).to_pylist()
        else:
            cols[name] = col.to_pylist()
    return [dict(zip(cols, vals)) for vals in zip(*cols.values())]


def check_fragment_common(f, md, path):
    ix = json.loads(f["index"])
    check("fragment version", ix["v"] == 1, path)
    check("fragment row groups", len(ix["rg"]) == md.num_row_groups, path)
    last_end = 4
    for g, e in enumerate(ix["rg"]):
        rg = md.row_group(g)
        check("rg rows", e["rows"] == rg.num_rows, path)
        check("rg cap", rg.num_rows <= 100_000, path)
        starts, ends = [], []
        for c in range(rg.num_columns):
            col = rg.column(c)
            start = col.dictionary_page_offset if col.has_dictionary_page else col.data_page_offset
            starts.append(start)
            ends.append(start + col.total_compressed_size)
        check("rg off", e["off"] == min(starts), f"{path} {e['off']} {min(starts)}")
        check("rg len", e["len"] == max(ends) - min(starts), path)
        last_end = max(last_end, max(ends))
    size = os.path.getsize(os.path.join(OUT, path))
    check("foot", ix["foot"] == [last_end, size - last_end], f"{path} {ix['foot']} {last_end} {size}")
    return ix


def duck_rows(path, cols):
    """DuckDB's reading of a file, normalised to the PyArrow shapes compared below."""
    con = duckdb.connect()
    sel = []
    for c, kind in cols:
        if kind == "map":
            sel.append(f"map_keys({c}) AS {c}__k, map_values({c}) AS {c}__v, {c} IS NULL AS {c}__null")
        elif kind == "ts":
            sel.append(f"epoch_us({c}) AS {c}")
        else:
            sel.append(c)
    rel = con.execute(f"SELECT {', '.join(sel)} FROM read_parquet('{os.path.join(OUT, path)}')")
    names = [d[0] for d in rel.description]
    out = []
    for vals in rel.fetchall():
        r = dict(zip(names, vals))
        row = {}
        for c, kind in cols:
            if kind == "map":
                row[c] = None if r[f"{c}__null"] else list(zip(r[f"{c}__k"], r[f"{c}__v"]))
            else:
                row[c] = r[c]
        out.append(row)
    con.close()
    return out


def same_value(a, b):
    if isinstance(a, float) and isinstance(b, float):
        return (math.isnan(a) and math.isnan(b)) or a == b
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(same_value(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same_value(a[k], b[k]) for k in a)
    if isinstance(a, (bytes, bytearray)) or isinstance(b, (bytes, bytearray)):
        return bytes(a) == bytes(b)
    return a == b


def compare_duck(path, arrow_rows, schema):
    cols = []
    for field in schema:
        if pa.types.is_map(field.type):
            cols.append((field.name, "map"))
        elif pa.types.is_timestamp(field.type):
            cols.append((field.name, "ts"))
        else:
            cols.append((field.name, "plain"))
    drows = duck_rows(path, cols)
    check("duckdb row count", len(drows) == len(arrow_rows), path)
    for a, d in zip(arrow_rows, drows):
        for c, kind in cols:
            av = a[c]
            check(f"duckdb {c}", same_value(av, d[c]), f"{path} {str(av)[:80]} {str(d[c])[:80]}")


manifest = json.load(open(os.path.join(OUT, "manifest.json")))
expected_spans = {(j["trace_id"], j["span_id"]): j for j in map(json.loads, open(os.path.join(OUT, "spans.jsonl")))}
expected_logs = [json.loads(l) for l in open(os.path.join(OUT, "logs.jsonl"))]

spans_by_key = {}
spans_by_unit = defaultdict(list)
index_by_unit = defaultdict(list)
logs_by_key = {}
files_read = defaultdict(int)
for f in sorted(manifest, key=lambda f: (f["unit"], f["table"], f["path"])):
    path = f["path"]
    pf = pq.ParquetFile(os.path.join(OUT, path))
    md = pf.metadata
    table = pf.read()
    rows = as_rows(table)
    files_read[f["table"]] += 1
    check("rows", len(rows) == f["rows"], path)
    compare_duck(path, rows, table.schema)
    if f["table"] == "spans":
        for name, t in SPANS_SCHEMA.items():
            check(f"spans {name} type", str(table.schema.field(name).type) == t, f"{name} {table.schema.field(name).type}")
            check(f"spans {name} nullability", table.schema.field(name).nullable == (name not in NOT_NULL_SPANS), name)
        ix = check_fragment_common(f, md, path)
        at = 0
        for e in ix["rg"]:
            part = rows[at:at + e["rows"]]
            at += e["rows"]
            check("min_name", e["min_name"] == (part[0]["service_name"] or ""), path)
            check("max_name", e["max_name"] == (part[-1]["service_name"] or ""), path)
            check("min_ts", e["min_ts"] == min(r["start_unix_nano"] for r in part), path)
            check("max_ts", e["max_ts"] == max(r["start_unix_nano"] for r in part), path)
            check("min_dur", e["min_dur"] == min(r["duration_nano"] for r in part), path)
            check("max_dur", e["max_dur"] == max(r["duration_nano"] for r in part), path)
        key = lambda r: (r["service_name"] is not None, ub(r["service_name"] or ""), ub(r["span_name"]), r["start_unix_nano"], r["trace_id"], r["span_id"])
        check("spans sorted", all(key(a) < key(b) for a, b in zip(rows, rows[1:])), path)
        hours = {r["start_unix_nano"] // 3_600_000_000_000 for r in rows}
        check("one hour per file", len(hours) == 1 and (hours.pop() % 24) == f["hour"], path)
        for r in rows:
            physical_span_rules(r)
            check("start_time", r["start_time"] == r["start_unix_nano"] // 1000, path)
            j = span_json(r)
            spans_by_key[(j["trace_id"], j["span_id"])] = j
            spans_by_unit[f["unit"]].append(j)
    elif f["table"] == "trace_index":
        check_fragment_common(f, md, path)
        check("trace_index sorted", all(a["trace_id"] < b["trace_id"] for a, b in zip(rows, rows[1:])), path)
        for r in rows:
            index_by_unit[f["unit"]].append(r)
    else:
        ix = check_fragment_common(f, md, path)
        check("logs schema", table.column_names == ["service_name", "stream_id", "ts", "labels", "line", "metadata", "observed_ts", "severity_number", "severity_text", "trace_id", "span_id", "flags"], path)
        at = 0
        rg_of = []
        for g, e in enumerate(ix["rg"]):
            part = rows[at:at + e["rows"]]
            rg_of += [g] * e["rows"]
            at += e["rows"]
            check("min_name", e["min_name"] == part[0]["service_name"], path)
            check("max_name", e["max_name"] == part[-1]["service_name"], path)
            check("sid", e["sid"] == [part[0]["stream_id"], part[-1]["stream_id"]], path)
            check("min_ts", e["min_ts"] == min(r["ts"] for r in part), path)
            check("max_ts", e["max_ts"] == max(r["ts"] for r in part), path)
        key = lambda r: (ub(r["service_name"]), r["stream_id"], r["ts"], ub(r["line"]), [(ub(k), ub(v)) for k, v in r["metadata"]])
        check("logs sorted and unique", all(key(a) < key(b) for a, b in zip(rows, rows[1:])), path)
        streams = []
        for k, r in enumerate(rows):
            if streams and streams[-1][0] == r["stream_id"] and streams[-1][1] == r["labels"]:
                s = streams[-1]
                s[2], s[3], s[5] = min(s[2], r["ts"]), max(s[3], r["ts"]), rg_of[k]
            else:
                streams.append([r["stream_id"], r["labels"], r["ts"], r["ts"], rg_of[k], rg_of[k]])
        if len(streams) <= 256 and sum(len(ub(s[1])) for s in streams) <= 16 * 1024:
            check("streams in fragment", ix.get("streams") == streams, path)
        else:
            check("streams left out", "streams" not in ix, path)
        for r in rows:
            labels = json.loads(r["labels"])
            canon = "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + json.dumps(v, ensure_ascii=False) for k, v in sorted(labels.items(), key=lambda kv: ub(kv[0]))) + "}"
            check("labels canonical", r["labels"] == canon, r["labels"][:100])
            check("service_name", r["service_name"] == labels.get("service_name", ""), path)
            for c in ("observed_ts", "severity_number", "severity_text", "flags"):
                check(f"{c} null when absent", r[c] not in (0, ""), c)
            j = {
                "stream_id": str(r["stream_id"]), "labels": sorted(([k, v] for k, v in labels.items()), key=lambda kv: ub(kv[0])), "ts": str(r["ts"]),
                "observed_ts": str(r["observed_ts"] or 0), "trace_id": r["trace_id"].hex() if r["trace_id"] else "0" * 32,
                "span_id": r["span_id"].hex() if r["span_id"] else "0" * 16, "flags": (r["flags"] or 0) & 0xFFFFFFFF,
                "severity_number": r["severity_number"] or 0, "severity_text": r["severity_text"] or "", "line": r["line"],
                "metadata": [[k, v] for k, v in r["metadata"]],
            }
            logs_by_key[json.dumps([j["stream_id"], j["ts"], j["line"], j["metadata"]], ensure_ascii=False)] = j

# 4. Logical rows equal the expected ones.
check("span count", len(spans_by_key) == len(expected_spans), f"{len(spans_by_key)} vs {len(expected_spans)}")
for k, j in spans_by_key.items():
    w = expected_spans.get(k)
    check("span equals expected", w == j, f"{k}\n read {json.dumps(j, ensure_ascii=False)[:300]}\n want {json.dumps(w, ensure_ascii=False)[:300]}")
want_logs = {json.dumps([j["stream_id"], j["ts"], j["line"], j["metadata"]], ensure_ascii=False): j for j in expected_logs}
check("log count", len(logs_by_key) == len(want_logs), f"{len(logs_by_key)} vs {len(want_logs)}")
for k, j in logs_by_key.items():
    check("log equals expected", want_logs.get(k) == j, f"{k[:200]}")

# 5. Each unit's trace_index from its spans.
for unit, spans in spans_by_unit.items():
    by = defaultdict(list)
    for s in spans:
        by[s["trace_id"]].append(s)
    want = {}
    for t, v in by.items():
        roots = sorted((int(s["start"]), s["span_id"], s) for s in v if s["parent_span_id"] is None)
        svc = defaultdict(lambda: [0, 0])
        for s in v:
            name = next((a[2] for a in s["resource"] if a[0] == "service.name" and a[1] == "s"), "")
            svc[name][0] += 1
            svc[name][1] += s["status"] == 2
        root = roots[0][2] if roots else None
        want[t] = {
            "min_start_unix_nano": min(int(s["start"]) for s in v), "max_end_unix_nano": max(int(s["end"]) for s in v),
            "span_count": len(v), "error_count": sum(s["status"] == 2 for s in v),
            "root_service_name": None if root is None else next((a[2] for a in root["resource"] if a[0] == "service.name" and a[1] == "s"), None),
            "root_span_name": None if root is None else root["name"], "root_start_unix_nano": None if root is None else int(root["start"]),
            "root_span_id": None if root is None else root["span_id"],
            "services": [{"name": n, "spans": c[0], "errors": c[1]} for n, c in sorted(svc.items(), key=lambda kv: ub(kv[0]))],
            "services_truncated": False,
            "hours": sorted({int(s["start"]) // 3_600_000_000_000 for s in v}),
        }
    got = {r["trace_id"].hex(): {**{k: r[k] for k in r if k != "trace_id"}, "root_span_id": None if r["root_span_id"] is None else r["root_span_id"].hex()} for r in index_by_unit[unit]}
    check(f"unit {unit} trace_index traces", got.keys() == want.keys())
    for t in want:
        check(f"unit {unit} trace_index row", got.get(t) == want[t], f"{t}\n got {got.get(t)}\n want {want[t]}")

print(json.dumps({"files": dict(files_read), "spans": len(spans_by_key), "logs": len(logs_by_key), "checks": checks, "failures": len(failures),
                  "pyarrow": pa.__version__, "duckdb": duckdb.__version__}))
for f in failures[:40]:
    print("FAIL", f)
sys.exit(1 if failures else 0)
