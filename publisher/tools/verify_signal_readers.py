#!/usr/bin/env python3
"""Read the span and log tables (`spans`, `trace_index`, `logs`) with PyIceberg and DuckDB.

Input: `export/signals/`, written by `test/e2e-signals.test.ts` (`npm test`): the tables' metadata,
the tenants' Parquet files (real ones, from viz's write path: test/fixtures/signals.json), the
publisher's copy of the ledger logs, and `expected.json`: for each of four stages, each table's
snapshot and each tenant's live files in the ledger's precedence order. The URIs in the metadata
are `file://` URIs of the dumped files (nothing is rewritten).

For each table and stage, reached by time travel from the final metadata and again by opening that
stage's own vN.metadata.json, and for each reader (PyIceberg 0.12, DuckDB 2.0 `iceberg_scan`):

  1. the data files the reader plans or scans are exactly the ledgers' live files;
  2. every row of every file, every column (nested maps, lists of structs, lists of ints, fixed
     ids, the timestamptz), equals what pyarrow reads from that Parquet file directly (no Iceberg),
     file by file; `tenant` (and `day`) from the partition tuple, never null;
  3. a SHA-256 over every row of the table (all columns, sorted) is the same from both readers and
     from the files;
  4. `tenant = X` returns exactly X's rows and plans or reads only X's files;
  5. pruning by partition: `spans` by hour (`start_time` in one UTC hour: only that hour's files,
     exactly its rows), `trace_index` and `logs` by `day`.

Then it writes what each reader read, per file, as the logical rows contracts/TRACES.md and
LOGS.md define (`readback/<stage>/<reader>/<table>.jsonl`, and `readback/files.json`: each tenant's
files in precedence order), for `tools/signals-check` (Rust): viz's own readers (engine/storage)
read the same files and must give the same rows, and the TraceQL and LogQL engines must give the
same answers over both.

One reader difference is known and counted, not hidden: PyIceberg 0.12 returns an empty list where
a file holds a null list (`events`, `links` of a span without them; shown on a table PyIceberg
wrote itself, so it is the reader's); DuckDB and pyarrow return null. Rows are compared exactly,
and once more with that one difference allowed, and the number of such values is printed.

Usage: verify_signal_readers.py <export/signals dir> [--expected path]
(`--expected` reads what each stage must contain from another file, for a teeth check; then no
read-back is written.)
Exit status 0 only if every check passed.
"""
import argparse
import calendar
import datetime
import hashlib
import json
import os
import re
import struct
import sys
from collections import defaultdict

import duckdb
import pyarrow
import pyarrow.parquet as pq
import pyiceberg
from pyiceberg.expressions import And, EqualTo, GreaterThanOrEqual, LessThan
from pyiceberg.io.pyarrow import ArrowScan
from pyiceberg.table import StaticTable

TABLES = ["spans", "trace_index", "logs"]
failures = []
checks = defaultdict(int)
notes = defaultdict(int)


def check(reader, what, ok, detail=""):
    checks[(reader, what)] += 1
    if not ok:
        failures.append(f"{reader}: {what}: {detail}")
        print(f"  FAIL {reader}: {what}: {detail}")


# ───────────────────────────── canonical values, by Iceberg type ─────────────────────────────


def micros(v):
    if v is None:
        return None
    if isinstance(v, int):
        return v
    return calendar.timegm(v.utctimetuple()) * 1_000_000 + v.microsecond


def canon(v, t, lenient):
    """A JSON-able value, directed by the Iceberg type `t` (a string or a nested type object).

    Maps (PyIceberg: a list of pairs; DuckDB: a dict) become lists of pairs in the file's order;
    structs, dicts keyed by field name; bytes, hex; doubles, their bits; timestamps, microseconds.
    With `lenient`, a null list reads as an empty one (the PyIceberg difference above).
    """
    if isinstance(t, dict):
        if t["type"] == "list":
            if v is None:
                return [] if lenient else None
            return [canon(x, t["element"], lenient) for x in v]
        if v is None:
            return None
        if t["type"] == "map":
            pairs = list(v.items()) if isinstance(v, dict) else [tuple(x) if not isinstance(x, dict) else (x["key"], x["value"]) for x in v]
            return [[canon(k, t["key"], lenient), canon(x, t["value"], lenient)] for k, x in pairs]
        return {f["name"]: canon(v[f["name"]], f["type"], lenient) for f in t["fields"]}
    if v is None:
        return None
    if t in ("fixed[16]", "fixed[8]", "binary"):
        return bytes(v).hex()
    if t == "double":
        return struct.pack("<d", v).hex()
    if t == "timestamptz":
        return micros(v)
    if t == "date":
        return v.isoformat() if isinstance(v, datetime.date) else v
    if t == "boolean":
        return bool(v)
    return v


def row_json(r, fields, lenient):
    return json.dumps([canon(r[f["name"]], f["type"], lenient) for f in fields], ensure_ascii=False, separators=(",", ":"))


def content_hash(lines):
    h = hashlib.sha256()
    for line in sorted(lines):
        h.update(line.encode())
        h.update(b"\n")
    return h.hexdigest()


# ───────────────────────────── the logical rows (contracts/TRACES.md, LOGS.md) ─────────────────────────────

PROMOTED_RES = [("service_name", "service.name"), ("r_service_namespace", "service.namespace"), ("r_deployment_environment", "deployment.environment.name"),
                ("r_k8s_namespace_name", "k8s.namespace.name"), ("r_k8s_pod_name", "k8s.pod.name"), ("r_cloud_region", "cloud.region")]
PROMOTED_SPAN = [("s_http_request_method", "http.request.method"), ("s_http_response_status_code", "http.response.status_code"), ("s_http_route", "http.route"),
                 ("s_db_system_name", "db.system.name"), ("s_rpc_service", "rpc.service"), ("s_error_type", "error.type")]


def pairs(v):
    if v is None:
        return []
    if isinstance(v, dict):
        return list(v.items())
    return [tuple(x) for x in v]


def other_list(text):
    """`[{"key":K,"value":V},...]` (canonical OTLP JSON) as (key, V's text) pairs: V cut out by bracket matching."""
    out = []
    i = 1
    if not (text.startswith("[") and text.endswith("]")):
        raise ValueError("other attributes: not a list")
    dec = json.JSONDecoder()
    while i < len(text) - 1:
        if text[i] == ",":
            i += 1
        assert text.startswith('{"key":', i)
        i += len('{"key":')
        key, end = dec.raw_decode(text, i)
        i = end
        assert text.startswith(',"value":', i)
        i += len(',"value":')
        depth, j = 0, i
        while True:
            c = text[j]
            if c == '"':
                _, j = dec.raw_decode(text, j)
                continue
            if c in "{[":
                depth += 1
            elif c in "}]":
                depth -= 1
                if depth == 0:
                    j += 1
                    break
            j += 1
        out.append((key, text[i:j]))
        i = j
        assert text[i] == "}"
        i += 1
    return out


def logical_attrs(r, scope, promoted):
    out = []
    for col, key in promoted:
        v = r[col]
        if v is None:
            continue
        out.append([key, "s", v] if isinstance(v, str) else [key, "i", str(v)])
    for k, v in pairs(r[f"{scope}_attrs_str"]):
        out.append([k, "s", v])
    for k, v in pairs(r[f"{scope}_attrs_int"]):
        out.append([k, "i", str(v)])
    for k, v in pairs(r[f"{scope}_attrs_dbl"]):
        out.append([k, "d", format(struct.unpack("<Q", struct.pack("<d", v))[0], "x")])
    for k, v in pairs(r[f"{scope}_attrs_bool"]):
        out.append([k, "b", "true" if v else "false"])
    if r[f"{scope}_attrs_other"] is not None:
        for k, v in other_list(r[f"{scope}_attrs_other"]):
            out.append([k, "o", v])
    out.sort(key=lambda a: a[0].encode())
    return out


def hx(b):
    return None if b is None else bytes(b).hex()


def span_logical(r):
    return {
        "trace_id": hx(r["trace_id"]), "span_id": hx(r["span_id"]), "parent_span_id": hx(r["parent_span_id"]),
        "trace_state": r["trace_state"] or "", "flags": 0 if r["flags"] is None else r["flags"] & 0xFFFFFFFF,
        "start": str(r["start_unix_nano"]), "end": str(r["end_unix_nano"]), "kind": r["span_kind"], "status": r["status_code"],
        "status_message": r["status_message"] or "", "name": r["span_name"],
        "resource_fp": str(r["resource_fp"]), "resource": logical_attrs(r, "resource", PROMOTED_RES), "attrs": logical_attrs(r, "span", PROMOTED_SPAN),
        "scope_name": r["scope_name"] or "", "scope_version": r["scope_version"] or "", "scope_attrs": r["scope_attrs"] or "",
        "events": [[str(e["time_unix_nano"]), e["name"], e["attrs"]] for e in (r["events"] or [])],
        "links": [[hx(x["trace_id"]), hx(x["span_id"]), x["trace_state"], x["attrs"]] for x in (r["links"] or [])],
        "dropped": [r["dropped_attributes_count"] or 0, r["dropped_events_count"] or 0, r["dropped_links_count"] or 0],
    }


def fragment_logical(r):
    root = None if r["root_span_name"] is None else [r["root_service_name"], r["root_span_name"], str(r["root_start_unix_nano"]), hx(r["root_span_id"])]
    return {
        "trace_id": hx(r["trace_id"]), "min_start": str(r["min_start_unix_nano"]), "max_end": str(r["max_end_unix_nano"]),
        "span_count": r["span_count"], "error_count": r["error_count"], "root": root,
        "services": [[s["name"], s["spans"], s["errors"]] for s in r["services"]], "services_truncated": bool(r["services_truncated"]), "hours": list(r["hours"]),
    }


def log_logical(r):
    labels = sorted(json.loads(r["labels"]).items(), key=lambda kv: kv[0].encode())
    return {
        "stream_id": str(r["stream_id"]), "labels": [list(x) for x in labels], "ts": str(r["ts"]), "observed_ts": str(r["observed_ts"] or 0),
        "trace_id": hx(r["trace_id"]) or "0" * 32, "span_id": hx(r["span_id"]) or "0" * 16, "flags": 0 if r["flags"] is None else r["flags"] & 0xFFFFFFFF,
        "severity_number": r["severity_number"] or 0, "severity_text": r["severity_text"] or "", "line": r["line"], "metadata": [list(x) for x in pairs(r["metadata"])],
    }


LOGICAL = {"spans": span_logical, "trace_index": fragment_logical, "logs": log_logical}


# ───────────────────────────── the readers ─────────────────────────────


def schema_of(meta_path):
    meta = json.load(open(meta_path))
    s = next(x for x in meta["schemas"] if x["schema-id"] == meta["current-schema-id"])
    return s["fields"]


def pyiceberg_rows_by_file(meta_path, snapshot_id, row_filter=None):
    """{file path: [rows as dicts]}, each file read on its own through PyIceberg's ArrowScan (name mapping, projection, partition values)."""
    tbl = StaticTable.from_metadata("file://" + meta_path)
    scan = tbl.scan(snapshot_id=snapshot_id, row_filter=row_filter) if row_filter is not None else tbl.scan(snapshot_id=snapshot_id)
    out = {}
    for task in scan.plan_files():
        arrow = ArrowScan(tbl.metadata, tbl.io, scan.projection(), scan.row_filter, scan.case_sensitive, scan.limit).to_table([task])
        out[task.file.file_path] = arrow.to_pylist()
    return out


def duck_select(fields):
    # A timestamptz as microseconds: DuckDB's Python conversion of TIMESTAMPTZ needs pytz, which is not installed here.
    return ", ".join(f'epoch_us("{f["name"]}") AS "{f["name"]}"' if f["type"] == "timestamptz" else f'"{f["name"]}"' for f in fields)


def duck_rows_by_file(con, scan, fields, where=""):
    names = [f["name"] for f in fields]
    out = defaultdict(list)
    for row in con.execute(f"SELECT filename, {duck_select(fields)} FROM {scan} {where}").fetchall():
        out[row[0]].append(dict(zip(names, row[1:])))
    return out


def duck_scanned_files(con, sql):
    """How many Parquet files a query opened, from EXPLAIN ANALYZE's scan operator."""
    plan = con.execute("EXPLAIN ANALYZE " + sql).fetchall()[0][1]
    m = re.search(r"Total Files Read:\s*(\d+)", plan)
    return int(m.group(1)) if m else None


def direct_rows(root, key):
    return pq.read_table(os.path.join(root, key)).to_pylist()


# ───────────────────────────── one stage of one table ─────────────────────────────


def compare_files(reader, label, got, want_keys, prefix, direct, fields, partition, lenient_only):
    """Rows of each file: the reader's against pyarrow's, strictly (or with the PyIceberg list difference allowed)."""
    data = [f for f in fields if f["name"] not in ("tenant", "day")]
    check(reader, "data files equal the ledgers' live sets", sorted(got) == sorted(prefix + "/" + k for k in want_keys), f"{label}: {len(got)} vs {len(want_keys)}")
    lines = []
    for k in want_keys:
        rows = got.get(prefix + "/" + k, [])
        want = direct[k]
        exact = sorted(row_json(r, data, False) for r in rows) == sorted(row_json(r, data, False) for r in want)
        allowed = sorted(row_json(r, data, True) for r in rows) == sorted(row_json(r, data, True) for r in want)
        if lenient_only:
            check(reader, "every row and column of each file equals pyarrow's (a null list read as empty allowed)", allowed, f"{label}: {k}")
            if not exact and allowed:
                notes[f"{reader.split()[0]}: files whose null lists it read as empty"] += 1
        else:
            check(reader, "every row and column of each file equals pyarrow's, exactly", exact, f"{label}: {k}")
        check(reader, "tenant and partition columns from the partition tuple, never null", all(r["tenant"] == partition[k][0] and ("day" not in r or r["day"] is not None and canon(r["day"], "date", False) == partition[k][1]) for r in rows), f"{label}: {k}")
        lines += [json.dumps([partition[k][0], row_json(r, data, True)], ensure_ascii=False) for r in rows]
    return content_hash(lines), len(lines)


def stage_checks(con, root, prefix, expected, table, cp, meta_path, snapshot_id, current, label, direct, fields, out_dir):
    files = cp["tables"][table]["files"]
    keys = [k for ks in files.values() for k in ks]
    meta_files = expected["files"]
    partition = {k: (meta_files[k]["tenant"], meta_files[k]["day"]) for k in keys}
    # 1-3: PyIceberg, DuckDB, the files.
    pi = pyiceberg_rows_by_file(meta_path, snapshot_id)
    hp, n = compare_files(f"pyiceberg {table}", label, pi, keys, prefix, direct, fields, partition, True)
    snap = f", snapshot_from_id = {snapshot_id}" if (snapshot_id is not None and not current) else ""
    scan = f"iceberg_scan('{meta_path}'{snap})"
    dk = duck_rows_by_file(con, scan, fields)
    hd, nd = compare_files(f"duckdb {table}", label, dk, keys, prefix, direct, fields, partition, False)
    data = [f for f in fields if f["name"] not in ("tenant", "day")]
    hf = content_hash([json.dumps([partition[k][0], row_json(r, data, True)], ensure_ascii=False) for k in keys for r in direct[k]])
    check("content", "row hash: pyiceberg == duckdb == the live Parquet files", hp == hd == hf, f"{label}: {hp[:12]} {hd[:12]} {hf[:12]}")
    # 4: tenant.
    for tenant in expected["tenants"]:
        mine = [k for k in keys if meta_files[k]["tenant"] == tenant]
        f = pyiceberg_rows_by_file(meta_path, snapshot_id, EqualTo("tenant", tenant))
        check(f"pyiceberg {table}", "tenant filter plans only that tenant's files", sorted(f) == sorted(prefix + "/" + k for k in mine) and len(mine) < len(keys), f"{label}: {tenant}")
        check(f"pyiceberg {table}", "tenant filter returns exactly that tenant's rows", sum(len(v) for v in f.values()) == sum(len(direct[k]) for k in mine), f"{label}: {tenant}")
        where = f"WHERE tenant = '{tenant}'"
        nrows = con.execute(f"SELECT count(*) FROM {scan} {where}").fetchone()[0]
        check(f"duckdb {table}", "tenant filter returns exactly that tenant's rows", nrows == sum(len(direct[k]) for k in mine), f"{label}: {tenant}")
        nf = duck_scanned_files(con, f"SELECT count(*) FROM {scan} {where}")
        check(f"duckdb {table}", "tenant filter reads only that tenant's files", nf == len(mine), f"{label}: {tenant}: read {nf}, expected {len(mine)} of {len(keys)}")
    # 5: the second partition field.
    if table == "spans":
        hours = sorted({(meta_files[k]["day"], meta_files[k]["hour"]) for k in keys})
        for day, hour in hours:
            lo = datetime.datetime.fromisoformat(f"{day}T{hour:02d}:00:00+00:00")
            hi = lo + datetime.timedelta(hours=1)
            want = [k for k in keys if (meta_files[k]["day"], meta_files[k]["hour"]) == (day, hour)]
            want_rows = sum(1 for k in keys for r in direct[k] if lo <= r["start_time"] < hi)
            f = pyiceberg_rows_by_file(meta_path, snapshot_id, And(GreaterThanOrEqual("start_time", lo.isoformat()), LessThan("start_time", hi.isoformat())))
            check(f"pyiceberg {table}", "an hour of start_time plans only that hour's files", sorted(f) == sorted(prefix + "/" + k for k in want), f"{label}: {day} {hour}: {len(f)} vs {len(want)}")
            check(f"pyiceberg {table}", "an hour of start_time returns exactly its rows", sum(len(v) for v in f.values()) == want_rows, f"{label}: {day} {hour}")
            where = f"WHERE start_time >= TIMESTAMPTZ '{lo.isoformat()}' AND start_time < TIMESTAMPTZ '{hi.isoformat()}'"
            nrows = con.execute(f"SELECT count(*) FROM {scan} {where}").fetchone()[0]
            check(f"duckdb {table}", "an hour of start_time returns exactly its rows", nrows == want_rows, f"{label}: {day} {hour}: {nrows} vs {want_rows}")
            nf = duck_scanned_files(con, f"SELECT count(*) FROM {scan} {where}")
            check(f"duckdb {table}", "an hour of start_time reads only that hour's files", nf == len(want), f"{label}: {day} {hour}: read {nf}, expected {len(want)} of {len(keys)}")
    else:
        for day in sorted({meta_files[k]["day"] for k in keys}):
            want = [k for k in keys if meta_files[k]["day"] == day]
            want_rows = sum(len(direct[k]) for k in want)
            f = pyiceberg_rows_by_file(meta_path, snapshot_id, EqualTo("day", day))
            check(f"pyiceberg {table}", "a day plans only that day's files", sorted(f) == sorted(prefix + "/" + k for k in want), f"{label}: {day}")
            check(f"pyiceberg {table}", "a day returns exactly its rows", sum(len(v) for v in f.values()) == want_rows, f"{label}: {day}")
            where = f"WHERE day = DATE '{day}'"
            nrows = con.execute(f"SELECT count(*) FROM {scan} {where}").fetchone()[0]
            check(f"duckdb {table}", "a day returns exactly its rows", nrows == want_rows, f"{label}: {day}")
            nf = duck_scanned_files(con, f"SELECT count(*) FROM {scan} {where}")
            check(f"duckdb {table}", "a day reads only that day's files", nf == len(want), f"{label}: {day}: read {nf}, expected {len(want)} of {len(keys)}")
    # What each reader read, as logical rows per file, for tools/signals-check.
    if out_dir:
        for reader, got in (("pyiceberg", pi), ("duckdb", dk)):
            d = os.path.join(out_dir, reader)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, f"{table}.jsonl"), "w") as w:
                for k in keys:
                    for r in got.get(prefix + "/" + k, []):
                        w.write(json.dumps({"tenant": meta_files[k]["tenant"], "file": k, "row": LOGICAL[table](r)}, ensure_ascii=False) + "\n")
    return hp, n, nd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("export_dir")
    ap.add_argument("--expected", default=None)
    args = ap.parse_args()
    root = os.path.abspath(args.export_dir)
    expected = json.load(open(args.expected or os.path.join(root, "expected.json")))
    prefix = expected["locationPrefix"]
    if prefix != "file://" + root:
        sys.exit(f"the export was written for {prefix}, but it is at {root}: the URIs in the metadata would not resolve")
    con = duckdb.connect()
    con.execute("LOAD iceberg")
    ext = dict(con.execute("SELECT extension_name, extension_version FROM duckdb_extensions() WHERE extension_name IN ('iceberg', 'avro')").fetchall())
    print(f"readers: pyiceberg {pyiceberg.__version__} (pyarrow {pyarrow.__version__}), duckdb {duckdb.__version__} (iceberg extension {ext.get('iceberg')}, avro extension {ext.get('avro')})")
    print(f"export: {root} ({expected['objects']} objects)\n")
    readback = os.path.join(root, "readback")
    if args.expected is None:
        os.makedirs(readback, exist_ok=True)
        order = {cp["name"]: {t: cp["tables"][t]["files"] for t in TABLES} for cp in expected["checkpoints"]}
        json.dump({"stages": [cp["name"] for cp in expected["checkpoints"]], "files": order}, open(os.path.join(readback, "files.json"), "w"), indent=1)
    hashes = []
    direct = {}
    for table in TABLES:
        info = expected["tables"][table]
        final = os.path.join(root, info["metadata"])
        fields = schema_of(final)
        last = expected["checkpoints"][-1]
        for cp in expected["checkpoints"]:
            c = cp["tables"][table]
            for k in [k for ks in c["files"].values() for k in ks]:
                if k not in direct:
                    direct[k] = direct_rows(root, k)
            own = os.path.join(root, os.path.dirname(info["metadata"]), f"v{c['metadataVersion']}.metadata.json")
            current = cp is last
            label = f"{table} @{cp['name']} ({'current' if current else 'time travel'})"
            # The read-back for tools/signals-check is written only for the export's own expected.json (a teeth check's copy writes none).
            h, n, nd = stage_checks(con, root, prefix, expected, table, cp, final, c["snapshotId"], current, label, direct, fields, os.path.join(readback, cp["name"]) if args.expected is None else None)
            print(f"{label}: {sum(len(v) for v in c['files'].values())} files, {n} rows (pyiceberg), {nd} rows (duckdb), hash {h[:12]}")
            hashes.append((table, cp["name"], n, h))
            label = f"{table} @{cp['name']} (v{c['metadataVersion']}.metadata.json)"
            stage_checks(con, root, prefix, expected, table, cp, own, None, True, label, direct, fields, None)
        # DuckDB finds the current metadata from version-hint.text, given only the table directory.
        table_dir = os.path.dirname(os.path.dirname(final))
        n = con.execute(f"SELECT count(*) FROM iceberg_scan('{table_dir}')").fetchone()[0]
        keys = [k for ks in last["tables"][table]["files"].values() for k in ks]
        check(f"duckdb {table}", "the table directory alone, via version-hint.text, reads the current snapshot", n == sum(len(direct[k]) for k in keys), f"{n}")
        live = sorted(p for p, s in con.execute(f"SELECT file_path, status FROM iceberg_metadata('{final}')").fetchall() if s != "DELETED")
        check(f"duckdb {table}", "iceberg_metadata: live entries equal the ledgers' live sets", live == sorted(prefix + "/" + k for k in keys), f"{len(live)} vs {len(keys)}")
        cols = [(r[0], r[1]) for r in con.execute(f"DESCRIBE SELECT * FROM iceberg_scan('{final}')").fetchall()]
        print(f"{table}: duckdb columns {cols[:4]} ... {cols[-3:]} ({len(cols)})")
        print(f"{table}: pyiceberg schema {len(StaticTable.from_metadata('file://' + final).schema().fields)} top-level fields\n")

    print("content hashes (sha256 over every row, all columns, sorted; the same from PyIceberg, DuckDB and the files):")
    for table, stage, n, h in hashes:
        print(f"  {table:12} {stage:9} {n:5} rows  {h[:12]}")
    for k, v in sorted(notes.items()):
        print(f"known difference: {k}: {v}")
    total = sum(checks.values())
    by_reader = defaultdict(int)
    for (reader, _), n in checks.items():
        by_reader[reader.split(" ")[0]] += n
    print(f"checks run: {total} ({dict(by_reader)}); failed: {len(failures)}")
    by_kind = defaultdict(int)
    for (reader, what), n in checks.items():
        by_kind[(reader.split(" ")[0], what)] += n
    for (reader, what), n in sorted(by_kind.items()):
        print(f"  {reader:9} {n:4}  {what}")
    if failures:
        print("\nFAILED:")
        for f in failures[:60]:
            print("  " + f)
        sys.exit(1)
    print("\nall reader checks passed")


if __name__ == "__main__":
    main()
