#!/usr/bin/env python3
"""Independent readers for the series-level pruning change (AGENTS.md, "Independent readers").

Reads the files `examples/independent.rs` wrote with PyArrow and with DuckDB (neither shares
code with the Rust `parquet` crate) and checks, per file:

  1. PyArrow returns exactly the expected rows (value bits compared: NaN payloads, staleness
     markers);
  2. DuckDB returns the same rows (values compared as numbers, NaN as NaN: DuckDB has no
     bit-level access to a DOUBLE);
  3. the index fragment agrees with the file: row groups, rows, offsets and lengths, names,
     times, and `sid` = the series_id of each row group's first and last row; `foot` = from
     the end of the last row group to the end of the file;
  4. a range read as contracts/TABLES.md describes it (the rule re-implemented here): for 25
     series, a buffer holding only the footer region and the row groups the fragment says can
     hold the series (zeros elsewhere) gives PyArrow exactly that series' expected rows, and
     no row group left out holds one of its rows.

    python3 -m venv /tmp/v && /tmp/v/bin/pip install pyarrow duckdb numpy
    cargo run --release --example independent -- DIR && /tmp/v/bin/python tools/independent_check.py DIR
"""
import io
import json
import math
import os
import random
import struct
import sys

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

d = sys.argv[1]
failures = 0
checks = 0


def check(what, ok, detail=""):
    global failures, checks
    checks += 1
    if not ok:
        failures += 1
        print(f"FAIL {what} {detail}")


def expected(name):
    rows = []
    with open(os.path.join(d, name + ".rows.tsv")) as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if "samples" in name:
                rows.append((p[0], int(p[1]), int(p[2]), int(p[3])))
            else:
                rows.append((p[0], int(p[1]), p[2], int(p[3]), int(p[4])))
    return rows


def arrow_rows(t, samples):
    cols = [t.column(c) for c in t.column_names]
    if samples:
        bits = cols[3].to_numpy().view(np.uint64)
        return [(n, s, ts, int(b)) for n, s, ts, b in zip(cols[0].to_pylist(), cols[1].to_pylist(), cols[2].to_pylist(), bits)]
    return list(zip(*[c.to_pylist() for c in cols]))


def as_number(b):
    return struct.unpack("<d", struct.pack("<Q", b))[0]


names = sorted(f[: -len(".parquet")] for f in os.listdir(d) if f.endswith(".parquet"))
for name in names:
    path = os.path.join(d, name + ".parquet")
    samples = "samples" in name
    want = expected(name)
    raw = open(path, "rb").read()
    # 1. PyArrow, bit for bit, in file order.
    t = pq.read_table(path)
    got = arrow_rows(t, samples)
    check(f"{name}: PyArrow rows", got == want, f"{len(got)} rows, want {len(want)}")
    # 2. DuckDB.
    con = duckdb.connect()
    order = "metric_name, series_id, ts" if samples else "metric_name, series_id"
    drows = con.execute(f"SELECT * FROM read_parquet('{path}') ORDER BY {order}").fetchall()
    if samples:
        same = len(drows) == len(want) and all(
            (a[0], a[1], a[2]) == (b[0], b[1], b[2]) and ((math.isnan(a[3]) and math.isnan(as_number(b[3]))) or a[3] == as_number(b[3])) for a, b in zip(drows, want)
        )
    else:
        same = [tuple(r) for r in drows] == want
    check(f"{name}: DuckDB rows", same, f"{len(drows)} rows")
    # 3. The fragment against the file.
    idx = json.load(open(os.path.join(d, name + ".index.json")))
    pf = pq.ParquetFile(path)
    md = pf.metadata
    check(f"{name}: row groups", md.num_row_groups == len(idx["rg"]), f"{md.num_row_groups} vs {len(idx['rg'])}")
    end = 0
    for i, g in enumerate(idx["rg"]):
        rg = md.row_group(i)
        starts = [rg.column(c).dictionary_page_offset if rg.column(c).has_dictionary_page else rg.column(c).data_page_offset for c in range(rg.num_columns)]
        size = sum(rg.column(c).total_compressed_size for c in range(rg.num_columns))
        sids = pf.read_row_group(i, columns=["series_id"]).column(0).to_pylist()
        nm = pf.read_row_group(i, columns=["metric_name"]).column(0).to_pylist()
        tcols = ["ts"] if samples else ["min_ts", "max_ts"]
        tv = [x for c in tcols for x in pf.read_row_group(i, columns=[c]).column(0).to_pylist()]
        check(
            f"{name}: rg {i}",
            g["rows"] == rg.num_rows and g["off"] == min(starts) and g["len"] == size and g["sid"] == [sids[0], sids[-1]] and g["min_name"] == min(nm) and g["max_name"] == max(nm) and g["min_ts"] == min(tv) and g["max_ts"] == max(tv),
            json.dumps(g)[:200],
        )
        check(f"{name}: rg {i} has an offset index", all(rg.column(c).has_offset_index for c in range(rg.num_columns)))
        end = max(end, g["off"] + g["len"])
    check(f"{name}: foot", idx["foot"] == [end, len(raw) - end] and raw[-4:] == b"PAR1", f"{idx['foot']} vs [{end}, {len(raw) - end}]")
    # 4. Range reads, by the contract's rule.
    if samples:
        rnd = random.Random(name)
        keys = sorted({(r[0], r[1]) for r in want})
        for n, s in rnd.sample(keys, 25):
            keep = []
            for i, g in enumerate(idx["rg"]):
                lo, hi = g["min_name"], g["max_name"]
                if not (lo <= n <= hi):
                    continue
                if n == lo and s < g["sid"][0]:
                    continue
                if n == hi and s > g["sid"][1]:
                    continue
                keep.append(i)
            buf = bytearray(len(raw))
            for o, l in [(idx["rg"][i]["off"], idx["rg"][i]["len"]) for i in keep] + [tuple(idx["foot"])]:
                buf[o : o + l] = raw[o : o + l]
            part = pq.ParquetFile(io.BytesIO(bytes(buf)))
            rows = []
            for i in keep:
                rows += [r for r in arrow_rows(part.read_row_group(i), True) if r[0] == n and r[1] == s]
            check(f"{name}: range read of {n}/{s}", rows == [r for r in want if r[0] == n and r[1] == s], f"row groups {keep}")
            left = [i for i in range(md.num_row_groups) if i not in keep]
            check(f"{name}: no row group left out holds {n}/{s}", not any(r[0] == n and r[1] == s for i in left for r in arrow_rows(pf.read_row_group(i), True)))

print(f"{checks - failures} of {checks} checks pass ({len(names)} files; PyArrow {pa.__version__}, DuckDB {duckdb.__version__})")
sys.exit(1 if failures else 0)
