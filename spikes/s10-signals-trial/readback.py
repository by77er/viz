#!/usr/bin/env python3
"""Read the publisher's `spans`, `trace_index` and `logs` tables, as committed on Cloudflare, with
readers viz did not write: PyIceberg plans and reads each tenant's rows through the table's
metadata, manifest list and manifests; pyarrow and DuckDB then read the same data files directly.

Input: a local copy of the stage bucket's keys (driver.mjs `fetch`): `cell-0/iceberg/<table>/...`
and the tenants' data files. The metadata names `s3://viz-s10-lake/...`; `LocalIO` maps that prefix
onto the copy (nothing is rewritten). Expected rows per tenant and table come from what the trial
sent and was acknowledged (`--expect tenant:table=N`, repeatable).

  python3 -I readback.py <copy dir> [--prefix s3://viz-s10-lake/] [--expect s10-q:spans=47402 ...]

Exit 0 only if every expectation holds and the three readers agree file by file.
"""
import argparse
import json
import os
import sys

import duckdb
import pyarrow.parquet as pq
from pyiceberg.expressions import EqualTo
from pyiceberg.io.pyarrow import PyArrowFileIO
from pyiceberg.table import StaticTable

ROOT = None
PREFIX = None


class LocalIO(PyArrowFileIO):
    """PyArrowFileIO with the bucket's prefix mapped onto the local copy. PyIceberg imports this
    class by name (`readback.LocalIO`), a module of its own: the mapping comes from the environment."""

    def _map(self, location):
        root, prefix = os.environ["READBACK_ROOT"], os.environ["READBACK_PREFIX"]
        if location.startswith(prefix):
            return "file://" + os.path.join(root, location[len(prefix):])
        return location

    def new_input(self, location):
        return super().new_input(self._map(location))

    def new_output(self, location):
        return super().new_output(self._map(location))


def latest_metadata(table):
    d = os.path.join(ROOT, "cell-0", "iceberg", table, "metadata")
    versions = [f for f in os.listdir(d) if f.startswith("v") and f.endswith(".metadata.json")]
    return os.path.join(d, max(versions, key=lambda f: int(f[1:].split(".")[0])))


def main():
    global ROOT, PREFIX
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--prefix", default="s3://viz-s10-lake/")
    ap.add_argument("--expect", action="append", default=[])
    ap.add_argument("--tenants", default="")
    a = ap.parse_args()
    ROOT, PREFIX = os.path.abspath(a.root), a.prefix
    os.environ["READBACK_ROOT"], os.environ["READBACK_PREFIX"] = ROOT, PREFIX
    expect = {}
    for e in a.expect:
        k, n = e.split("=")
        expect[k] = int(n)
    tenants = sorted({k.split(":")[0] for k in expect} | set(filter(None, a.tenants.split(","))))
    failures = []
    out = {}
    con = duckdb.connect()
    for table in ["spans", "trace_index", "logs"]:
        meta = latest_metadata(table)
        tbl = StaticTable.from_metadata("file://" + meta, properties={"py-io-impl": "readback.LocalIO"})
        snap = tbl.current_snapshot()
        out[table] = {"metadata": os.path.basename(meta), "snapshot": snap.snapshot_id if snap else None, "summary": dict(snap.summary.additional_properties) if snap else {}, "tenants": {}}
        for t in tenants:
            scan = tbl.scan(row_filter=EqualTo("tenant", t))
            files = [task.file.file_path for task in scan.plan_files()]
            rows = scan.to_arrow()
            local = [os.path.join(ROOT, f[len(PREFIX):]) for f in files]
            missing = [f for f in local if not os.path.exists(f)]
            if missing:
                failures.append(f"{table} {t}: {len(missing)} planned files not in the copy")
                continue
            direct = sum(pq.ParquetFile(f).metadata.num_rows for f in local)
            duck = con.execute("SELECT count(*) FROM read_parquet(?)", [local]).fetchone()[0] if local else 0
            tenants_seen = set(rows.column("tenant").to_pylist()) if rows.num_rows else set()
            rec = {"files": len(files), "pyiceberg_rows": rows.num_rows, "pyarrow_rows": direct, "duckdb_rows": duck, "tenant_column": sorted(tenants_seen)}
            if not (rows.num_rows == direct == duck):
                failures.append(f"{table} {t}: readers disagree {rec}")
            if tenants_seen - {t}:
                failures.append(f"{table} {t}: rows of other tenants {tenants_seen - {t}}")
            key = f"{t}:{table}"
            if key in expect:
                rec["expected"] = expect[key]
                if rows.num_rows != expect[key]:
                    failures.append(f"{key}: {rows.num_rows} rows, expected {expect[key]}")
            out[table]["tenants"][t] = rec
            print(f"{table:12} {t:12} files {len(files):3}  pyiceberg {rows.num_rows:7}  pyarrow {direct:7}  duckdb {duck:7}" + (f"  expected {expect[key]}" if key in expect else ""))
    print(json.dumps({"failures": failures}, indent=1))
    with open(os.path.join(ROOT, "readback.json"), "w") as f:
        json.dump(out, f, indent=1)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
