#!/usr/bin/env python3
"""Read the managed catalog's tables with PyIceberg and DuckDB and compare them with the
R2-native publication of the same data.

R2-native side: the publisher's end-to-end export (`publisher/export/`, written by its
`npm test`), each stage's own `vN.metadata.json` opened with PyIceberg's StaticTable. Managed
side: the tables `cell_0.metric_samples` and `cell_0.metric_series` that `run.mjs publish` committed
to Basin Catalog, each stage read by snapshot id through the REST catalog, by PyIceberg
(RestCatalog) and by DuckDB (ATTACH ... TYPE ICEBERG). The hash is the publisher's own
(`publisher/tools/verify_readers.py`, `content_hash`: SHA-256 over every row, all columns, sorted).

Also checks the bench tables: each contention and unknown-outcome table has exactly the rows of
the commits the run says landed (every append adds one 120-row file), so a duplicate or lost
append would show in an engine viz did not write.

Usage: readers.py --catalog-uri URI --warehouse NAME   (token in S8_CATALOG_TOKEN, never printed)
       readers.py --native-only                         (the R2-native half alone)
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(REPO, "publisher", "tools"))
from verify_readers import DATA_COLUMNS, content_hash  # noqa: E402  the publisher's hash, not a copy

import duckdb  # noqa: E402
from pyiceberg.table import StaticTable  # noqa: E402

TABLES = ["metric_samples", "metric_series"]
failures = []


def check(what, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {what}{(': ' + detail) if detail else ''}")
    if not ok:
        failures.append(what)


def native_hashes():
    export = os.path.join(REPO, "publisher", "export")
    expected = json.load(open(os.path.join(export, "expected.json")))
    out = {}
    for cp in expected["checkpoints"]:
        for table in TABLES:
            c = cp["tables"][table]
            meta = os.path.join(export, "cell-0", "iceberg", table, "metadata", f"v{c['metadataVersion']}.metadata.json")
            arrow = StaticTable.from_metadata("file://" + meta).scan(snapshot_id=c["snapshotId"]).to_arrow()
            cols = ["tenant", "day"] + DATA_COLUMNS[table]
            out[(table, cp["name"])] = content_hash(zip(*[arrow.column(x).to_pylist() for x in cols]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog-uri")
    ap.add_argument("--warehouse")
    ap.add_argument("--native-only", action="store_true")
    args = ap.parse_args()

    native = native_hashes()
    print("R2-native publication (publisher/export), content hash per table and stage:")
    for (table, stage), (h, n) in native.items():
        print(f"  {table:15} {stage:10} {n:5} rows  {h[:12]}")
    if args.native_only:
        return

    token = os.environ["S8_CATALOG_TOKEN"]
    publish = json.load(open(os.path.join(HERE, "results", "publish.json")))
    from pyiceberg.catalog.rest import RestCatalog

    cat = RestCatalog(name="s8", uri=args.catalog_uri, warehouse=args.warehouse, token=token)
    con = duckdb.connect()
    for ext in ("iceberg", "httpfs"):
        con.execute(f"LOAD {ext}")
    con.execute("CREATE SECRET s8 (TYPE ICEBERG, TOKEN $t)".replace("$t", "'" + token.replace("'", "''") + "'"))
    con.execute(f"ATTACH '{args.warehouse}' AS s8 (TYPE ICEBERG, ENDPOINT '{args.catalog_uri}')")
    rows = []
    for stage in publish["stages"]:
        for table in TABLES:
            sid = stage["tables"][table]["snapshotId"]
            cols = ["tenant", "day"] + DATA_COLUMNS[table]
            t = cat.load_table(("cell_0", table))
            arrow = t.scan(snapshot_id=sid).to_arrow()
            hp = content_hash(zip(*[arrow.column(x).to_pylist() for x in cols]))
            hd = content_hash(con.execute(f"SELECT {', '.join(cols)} FROM s8.cell_0.{table} AT (VERSION => {sid})").fetchall())
            hn = native[(table, stage["name"])]
            print(f"{table} @{stage['name']} (managed snapshot {sid}):")
            check("PyIceberg (REST) == DuckDB (REST)", hp == hd, f"{hp[0][:12]}/{hp[1]} vs {hd[0][:12]}/{hd[1]}")
            check("managed == R2-native publication of the same data", hp == hn, f"{hp[0][:12]}/{hp[1]} vs {hn[0][:12]}/{hn[1]}")
            rows.append({"table": table, "stage": stage["name"], "rows": hp[1], "managed": hp[0], "duckdb": hd[0], "native": hn[0]})

    # Bench tables: rows equal 120 x the commits that landed.
    for fname, tables in (("contend.json", None), ("unknown.json", ["unknown_alone", "unknown_interfere"])):
        path = os.path.join(HERE, "results", fname)
        if not os.path.exists(path):
            continue
        res = json.load(open(path))
        if fname == "contend.json":
            pairs = [(r["name"], r["verify"]["files"]) for r in res["runs"] if r["catalog"] == "rest"]
        else:
            pairs = [(n, res[n]["verify"]["files"]) for n in tables]
        for name, files in pairs:
            n_py = cat.load_table(("bench", name)).scan().to_arrow().num_rows
            n_dk = con.execute(f"SELECT count(*) FROM s8.bench.{name}").fetchone()[0]
            check(f"bench.{name}: rows = 120 x {files} landed appends (PyIceberg {n_py}, DuckDB {n_dk})", n_py == n_dk == 120 * files)

    json.dump({"hashes": rows, "failures": failures}, open(os.path.join(HERE, "results", "readers.json"), "w"), indent=2)
    print(f"\n{len(failures)} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
