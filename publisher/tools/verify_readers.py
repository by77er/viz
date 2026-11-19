#!/usr/bin/env python3
"""Read the publisher's Iceberg tables with PyIceberg and DuckDB and compare with the ledgers.

Input: the directory written by the end-to-end test (`npm test` fills `publisher/export/`):
the simulated bucket's `cell-0/` prefix with the same relative layout, and `expected.json`,
which lists, for each stage of the test, the snapshot id each table was at and the live data
files of each tenant according to the Ledger objects.

Nothing is rewritten: the publisher in that test was configured with
`locationPrefix = file://<export dir>`, so the absolute URIs in metadata.json, the manifest
lists and the manifests are the real locations of the dumped files.

What a row of data must be is taken from `test/fixtures/fixture.json`: per-file row counts and
sums computed by the fixture generator from its synthetic rows, not from the Parquet files.

Checks, for each table, each stage (by time travel from the final metadata, and again by
opening that stage's own vN.metadata.json), each reader:
  1. the data files the reader plans to scan are exactly the ledgers' live files;
  2. rows per (tenant, day) equal the fixture's;
  3. checksums per (tenant, day) equal the fixture's
     (samples: sum(ts), sum(value); series: sum(min_ts), sum(max_ts));
  4. `tenant = X` returns only X's rows, all of them, and the reader's scan touches only
     X's files (PyIceberg: plan_files; DuckDB: the files named by EXPLAIN ANALYZE);
  5. `day = D` likewise;
  6. a content hash over every row (all columns, sorted) is identical from PyIceberg, from
     DuckDB, and from the ledgers' live Parquet files read directly with pyarrow (no Iceberg).

Usage: verify_readers.py <export dir> [--fixture path] [--expected path]
(`--expected` reads what each stage must contain from another file: the teeth check uses a
copy with one file removed, outside the export.)
Exit status 0 only if every check passed.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys
from collections import defaultdict

import duckdb
import pyarrow
import pyarrow.compute as pc
import pyarrow.parquet as pq
import pyiceberg
from pyiceberg.expressions import EqualTo
from pyiceberg.table import StaticTable

SUMS = {"metric_samples": ("ts", "value"), "metric_series": ("min_ts", "max_ts")}
DATA_COLUMNS = {"metric_samples": ["metric_name", "series_id", "ts", "value"], "metric_series": ["metric_name", "series_id", "labels", "min_ts", "max_ts"]}
hashes = []


def content_hash(rows):
    """SHA-256 over every row, all columns, sorted: (tenant, day, data columns...). Floats by repr."""
    canon = sorted(json.dumps([v.isoformat() if isinstance(v, datetime.date) else (repr(v) if isinstance(v, float) else v) for v in r]) for r in rows)
    h = hashlib.sha256()
    for line in canon:
        h.update(line.encode())
        h.update(b"\n")
    return h.hexdigest(), len(canon)


def hash_pyiceberg(metadata_path, snapshot_id, table):
    arrow = StaticTable.from_metadata("file://" + metadata_path).scan(snapshot_id=snapshot_id).to_arrow()
    cols = ["tenant", "day"] + DATA_COLUMNS[table]
    return content_hash(zip(*[arrow.column(c).to_pylist() for c in cols]))


def hash_duckdb(con, source, snapshot_id, table):
    snap = f", snapshot_from_id = {snapshot_id}" if snapshot_id is not None else ""
    cols = ", ".join(["tenant", "day"] + DATA_COLUMNS[table])
    return content_hash(con.execute(f"SELECT {cols} FROM iceberg_scan('{source}'{snap})").fetchall())


def hash_direct(root, fixture, keys, table):
    """The ledgers' live files read as plain Parquet; tenant and day from the ledger's entry (they are not in the files)."""
    rows = []
    for k in keys:
        f = fixture["files"][k]
        t = pq.read_table(os.path.join(root, k))
        day = datetime.date.fromisoformat(f["entry"]["day"])
        for r in zip(*[t.column(c).to_pylist() for c in DATA_COLUMNS[table]]):
            rows.append((f["tenant"], day, *r))
    return content_hash(rows)

failures = []
checks = defaultdict(int)


def check(reader, what, ok, detail=""):
    checks[(reader, what)] += 1
    if not ok:
        failures.append(f"{reader}: {what}: {detail}")
        print(f"  FAIL {reader}: {what}: {detail}")


def expected_groups(fixture, keys):
    """(tenant, day) -> [rows, sumA, sumB] from the fixture model."""
    out = defaultdict(lambda: [0, 0, 0])
    for k in keys:
        f = fixture["files"][k]
        g = out[(f["tenant"], f["entry"]["day"])]
        g[0] += f["stats"]["rows"]
        g[1] += f["stats"]["sumA"]
        g[2] += f["stats"]["sumB"]
    return {k: tuple(v) for k, v in out.items()}


def groups_from_arrow(table, a, b):
    out = defaultdict(lambda: [0, 0, 0])
    tenants = table.column("tenant").to_pylist()
    days = table.column("day").to_pylist()
    xs = table.column(a).to_pylist()
    ys = table.column(b).to_pylist()
    for t, d, x, y in zip(tenants, days, xs, ys):
        g = out[(t, d.isoformat() if d is not None else None)]
        g[0] += 1
        g[1] += int(x)
        g[2] += int(y)
    return {k: tuple(v) for k, v in out.items()}


def pyiceberg_checks(label, metadata_path, snapshot_id, table, exp_keys, exp_groups, prefix, tenants, days):
    r = f"pyiceberg {label}"
    a, b = SUMS[table]
    t = StaticTable.from_metadata("file://" + metadata_path)
    scan = t.scan(snapshot_id=snapshot_id)
    planned = sorted(task.file.file_path for task in scan.plan_files())
    check(r, "data files equal the ledgers' live sets", planned == sorted(prefix + "/" + k for k in exp_keys),
          f"{len(planned)} planned, {len(exp_keys)} expected")
    arrow = scan.to_arrow()
    check(r, "rows and checksums per tenant and day", groups_from_arrow(arrow, a, b) == exp_groups,
          f"got {sorted(groups_from_arrow(arrow, a, b).items())[:3]}...")
    check(r, "no null partition column", arrow.column("tenant").null_count == 0 and arrow.column("day").null_count == 0)
    for tenant in tenants:
        s = t.scan(snapshot_id=snapshot_id, row_filter=EqualTo("tenant", tenant))
        files = sorted(task.file.file_path for task in s.plan_files())
        want = sorted(prefix + "/" + k for k in exp_keys if f"/tenant={tenant}/" in k)
        check(r, "tenant filter prunes to that tenant's files", files == want and len(files) < len(planned),
              f"{tenant}: scanned {len(files)} of {len(planned)}, expected {len(want)}")
        got = groups_from_arrow(s.to_arrow(), a, b)
        check(r, "tenant filter returns exactly that tenant's rows", got == {k: v for k, v in exp_groups.items() if k[0] == tenant}, tenant)
    for day in days:
        s = t.scan(snapshot_id=snapshot_id, row_filter=EqualTo("day", day))
        files = sorted(task.file.file_path for task in s.plan_files())
        want = sorted(prefix + "/" + k for k in exp_keys if f"/day={day}/" in k)
        check(r, "day filter prunes to that day's files", files == want, f"{day}: scanned {len(files)}, expected {len(want)}")
        got = groups_from_arrow(s.to_arrow(), a, b)
        check(r, "day filter returns exactly that day's rows", got == {k: v for k, v in exp_groups.items() if k[1] == day}, day)
    return len(planned), arrow.num_rows


def duck_scanned_files(con, sql):
    """How many Parquet files a query opened, and which, from EXPLAIN ANALYZE's scan operator.

    The names are None when DuckDB abbreviates a long list.
    """
    plan = con.execute("EXPLAIN ANALYZE " + sql).fetchall()[0][1]
    m = re.search(r"Total Files Read:\s*(\d+)", plan)
    names = None
    block = re.search(r"Filename\(s\):\s*│\s*\n│\s*(.*?)\s*│\s*\n", plan)
    if block and "..." not in block.group(1):
        names = sorted(x.strip() for x in block.group(1).split(",") if x.strip())
    return (int(m.group(1)) if m else None), names


def duckdb_checks(con, label, source, snapshot_id, table, exp_keys, exp_groups, prefix, tenants, days):
    r = f"duckdb {label}"
    a, b = SUMS[table]
    snap = f", snapshot_from_id = {snapshot_id}" if snapshot_id is not None else ""
    scan = f"iceberg_scan('{source}'{snap})"
    # The files the scan reads, from DuckDB's virtual `filename` column.
    files = sorted(row[0] for row in con.execute(f"SELECT DISTINCT filename FROM {scan}").fetchall())
    check(r, "data files equal the ledgers' live sets", files == sorted(prefix + "/" + k for k in exp_keys),
          f"{len(files)} scanned, {len(exp_keys)} expected")
    rows = con.execute(f"SELECT tenant, day, count(*), sum({a})::HUGEINT, sum({b})::HUGEINT FROM {scan} GROUP BY ALL").fetchall()
    got = {(t, d.isoformat() if d else None): (n, int(x), int(y)) for t, d, n, x, y in rows}
    check(r, "rows and checksums per tenant and day", got == exp_groups, f"got {sorted(got.items())[:3]}...")
    for tenant in tenants:
        sql = f"SELECT tenant, day, count(*), sum({a})::HUGEINT, sum({b})::HUGEINT FROM {scan} WHERE tenant = '{tenant}' GROUP BY ALL"
        got = {(t, d.isoformat()): (n, int(x), int(y)) for t, d, n, x, y in con.execute(sql).fetchall()}
        check(r, "tenant filter returns exactly that tenant's rows", got == {k: v for k, v in exp_groups.items() if k[0] == tenant}, tenant)
        want = len([k for k in exp_keys if f"/tenant={tenant}/" in k])
        n, names = duck_scanned_files(con, f"SELECT count(*) FROM {scan} WHERE tenant = '{tenant}'")
        mine = names is None or all(f"/tenant={tenant}/" in x for x in names)
        check(r, "tenant filter prunes to that tenant's files", n == want and want < len(exp_keys) and mine, f"{tenant}: read {n} files, expected {want} of {len(exp_keys)}")
    for day in days:
        sql = f"SELECT tenant, day, count(*), sum({a})::HUGEINT, sum({b})::HUGEINT FROM {scan} WHERE day = DATE '{day}' GROUP BY ALL"
        got = {(t, d.isoformat()): (n, int(x), int(y)) for t, d, n, x, y in con.execute(sql).fetchall()}
        check(r, "day filter returns exactly that day's rows", got == {k: v for k, v in exp_groups.items() if k[1] == day}, day)
        want = len([k for k in exp_keys if f"/day={day}/" in k])
        n, names = duck_scanned_files(con, f"SELECT count(*) FROM {scan} WHERE day = DATE '{day}'")
        mine = names is None or all(f"/day={day}/" in x for x in names)
        check(r, "day filter prunes to that day's files", n == want and mine, f"{day}: read {n} files, expected {want}")
    return len(files), sum(g[0] for g in got.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("export_dir")
    ap.add_argument("--fixture", default=os.path.join(os.path.dirname(__file__), "..", "test", "fixtures", "fixture.json"))
    ap.add_argument("--expected", default=None)
    args = ap.parse_args()
    root = os.path.abspath(args.export_dir)
    expected = json.load(open(args.expected or os.path.join(root, "expected.json")))
    fixture = json.load(open(args.fixture))
    prefix = expected["locationPrefix"]
    if prefix != "file://" + root:
        sys.exit(f"the export was written for {prefix}, but it is at {root}: the URIs in the metadata would not resolve")

    con = duckdb.connect()
    con.execute("LOAD iceberg")
    ext = dict(con.execute("SELECT extension_name, extension_version FROM duckdb_extensions() WHERE extension_name IN ('iceberg', 'avro')").fetchall())
    print(f"readers: pyiceberg {pyiceberg.__version__} (pyarrow {pyarrow.__version__}), duckdb {duckdb.__version__} (iceberg extension {ext.get('iceberg')}, avro extension {ext.get('avro')})")
    print(f"export: {root} ({expected['objects']} objects)\n")

    for table, info in expected["tables"].items():
        final = os.path.join(root, info["metadata"])
        last = expected["checkpoints"][-1]
        for cp in expected["checkpoints"]:
            c = cp["tables"][table]
            keys = [k for ks in c["files"].values() for k in ks]
            groups = expected_groups(fixture, keys)
            own = os.path.join(root, os.path.dirname(info["metadata"]), f"v{c['metadataVersion']}.metadata.json")
            current = cp is last
            # (a) time travel from the final metadata to this stage's snapshot
            label = f"{table} @{cp['name']} ({'current snapshot' if current else 'time travel'})"
            nf, nr = pyiceberg_checks(label, final, c["snapshotId"], table, keys, groups, prefix, expected["tenants"], expected["days"])
            df, dr = duckdb_checks(con, label, final, None if current else c["snapshotId"], table, keys, groups, prefix, expected["tenants"], expected["days"])
            print(f"{label}: {nf} files, {nr} rows (pyiceberg); {df} files (duckdb)")
            # (6) every row, all columns: the two readers and the Parquet files themselves agree.
            hp = hash_pyiceberg(final, c["snapshotId"], table)
            hd = hash_duckdb(con, final, None if current else c["snapshotId"], table)
            hf = hash_direct(root, fixture, keys, table)
            check("content", "row hash: pyiceberg == duckdb == the live Parquet files", hp == hd == hf, f"{label}: {hp[0][:12]}/{hp[1]} {hd[0][:12]}/{hd[1]} {hf[0][:12]}/{hf[1]}")
            hashes.append((table, cp["name"], hp[1], hp[0], hd[0] == hp[0], hf[0] == hp[0]))
            # (b) the metadata file of that stage, opened on its own
            label = f"{table} @{cp['name']} (v{c['metadataVersion']}.metadata.json)"
            pyiceberg_checks(label, own, None, table, keys, groups, prefix, expected["tenants"], expected["days"])
            duckdb_checks(con, label, own, None, table, keys, groups, prefix, expected["tenants"], expected["days"])
        # (c) DuckDB finds the current metadata from version-hint.text, given only the table directory
        table_dir = os.path.dirname(os.path.dirname(final))
        c = last["tables"][table]
        keys = [k for ks in c["files"].values() for k in ks]
        duckdb_checks(con, f"{table} (table directory, via version-hint.text)", table_dir, None, table, keys, expected_groups(fixture, keys), prefix, expected["tenants"], expected["days"])
        # (d) DuckDB's view of the manifests of the current snapshot
        rows = con.execute(f"SELECT file_path, status, record_count FROM iceberg_metadata('{final}')").fetchall()
        live = sorted(p for p, s, _ in rows if s != "DELETED")
        check(f"duckdb {table} iceberg_metadata", "live manifest entries equal the ledgers' live sets", live == sorted(prefix + "/" + k for k in keys), f"{len(live)} vs {len(keys)}")
        check(f"duckdb {table} iceberg_metadata", "record counts equal the fixture's", all(n == fixture["files"][p[len(prefix) + 1:]]["stats"]["rows"] for p, s, n in rows), "")
        # (e) the schema both readers report
        cols = [(r[0], r[1]) for r in con.execute(f"DESCRIBE SELECT * FROM iceberg_scan('{final}')").fetchall()]
        print(f"{table}: duckdb columns {cols}")
        print(f"{table}: pyiceberg schema {[(f.name, str(f.field_type), 'required' if f.required else 'optional') for f in StaticTable.from_metadata('file://' + final).schema().fields]}\n")

    # Known reader problem, probed in its own connection because it invalidates the database.
    probe = duckdb.connect()
    probe.execute("LOAD iceberg")
    table0 = next(iter(expected["tables"]))
    try:
        probe.execute(f"SELECT metric_name, filename FROM iceberg_scan('{os.path.join(root, expected['tables'][table0]['metadata'])}', filename = true) LIMIT 1").fetchall()
        print("duckdb: iceberg_scan(..., filename = true) works")
    except Exception as e:  # noqa: BLE001
        print("duckdb: iceberg_scan(..., filename = true) FAILS on these tables (the virtual column `filename`, without the option, works): " + str(e).splitlines()[0])

    print("content hashes (sha256 over every row, all columns, sorted), per table and stage:")
    for table, stage, n, h, duck_same, files_same in hashes:
        print(f"  {table:15} {stage:10} {n:5} rows  {h}  duckdb {'same' if duck_same else 'DIFFERENT'}  parquet {'same' if files_same else 'DIFFERENT'}")
    total = sum(checks.values())
    by_reader = defaultdict(int)
    for (reader, _), n in checks.items():
        by_reader[reader.split(" ")[0]] += n
    print(f"checks run: {total} ({dict(by_reader)}); failed: {len(failures)}")
    by_kind = defaultdict(int)
    for (reader, what), n in checks.items():
        by_kind[(reader.split(' ')[0], what)] += n
    for (reader, what), n in sorted(by_kind.items()):
        print(f"  {reader:9} {n:4}  {what}")
    if failures:
        print("\nFAILED:")
        for f in failures:
            print("  " + f)
        sys.exit(1)
    print("\nall reader checks passed")


if __name__ == "__main__":
    main()
