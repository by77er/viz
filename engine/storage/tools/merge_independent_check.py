#!/usr/bin/env python3
"""Independent readers for compaction outputs of the span and log tables (AGENTS.md,
"Independent readers"; contracts/TRACES.md and LOGS.md, "Compaction"; LOGS.md §6).

Reads what `cargo run --release --example merge_independent -- DIR` wrote. For every merged
file, with its inputs in precedence order (DIR/manifest.json):

  1. PyArrow reads the inputs and the output whole; what the output must hold is computed HERE
     from the inputs' rows: `spans`, the last input's row per (trace_id, span_id); `logs`, the
     last input's row per (stream_id, ts, line, metadata); `trace_index`, the rows of one trace
     merged (min, max, sums, root by earliest start then smaller id, per-service sums, at most
     64 services by most spans then name, union of hours); in the contract's sort order. The
     output's rows must equal it exactly (doubles by their bits);
  2. the output is one partition, its row groups within the cap, its fragment agrees with the
     footer (offsets, lengths, rows, `foot`, and for `logs` `tok`);
  3. DuckDB reads the output and returns PyArrow's values, column by column;
  4. `logs`: the token filter, found through the footer's `viz.token_filter` and the fragment's
     `tok`, parsed here from the bytes of contracts/LOGS.md §6, lists exactly the tokens of each
     row group's lines and metadata values, tokenized here.

    python3 -I tools/merge_independent_check.py DIR
"""
import json
import math
import os
import struct
import sys
from collections import OrderedDict

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

DIR = sys.argv[1]
checks = 0
failures = []


def check(what, ok, detail=""):
    global checks
    checks += 1
    if not ok:
        failures.append(f"{what} {detail}"[:600])


def bits(x):
    return struct.unpack("<Q", struct.pack("<d", x))[0]


def norm(v):
    """Values compared exactly: floats by their bits, containers element-wise."""
    if isinstance(v, float):
        return ("f", bits(v))
    if isinstance(v, (list, tuple)):
        return tuple(norm(x) for x in v)
    if isinstance(v, dict):
        return tuple(sorted((k, norm(x)) for k, x in v.items()))
    return v


def as_rows(table):
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


def read(path):
    return as_rows(pq.read_table(os.path.join(DIR, path)))


def ub(s):
    return s.encode("utf-8")


# ─────────────────────────── expected rows, from the inputs ───────────────────────────

def expect_spans(inputs):
    by = {}
    for rows in inputs:
        for r in rows:
            by[(r["trace_id"], r["span_id"])] = r
    key = lambda r: (r["service_name"] is not None, ub(r["service_name"] or ""), ub(r["span_name"]), r["start_unix_nano"], r["trace_id"], r["span_id"])
    return sorted(by.values(), key=key)


def md_key(r):
    return tuple((ub(k), ub(v)) for k, v in r["metadata"])


def expect_logs(inputs):
    by = {}
    for rows in inputs:
        for r in rows:
            by[(r["stream_id"], r["ts"], r["line"], tuple(r["metadata"]))] = r
    key = lambda r: (ub(r["service_name"]), r["stream_id"], r["ts"], ub(r["line"]), md_key(r))
    return sorted(by.values(), key=key)


def expect_index(inputs):
    by = OrderedDict()
    for rows in inputs:
        for r in rows:
            by.setdefault(r["trace_id"], []).append(r)
    out = []
    for tid in sorted(by):
        fs = by[tid]
        svc = {}
        for f in fs:
            for s in f["services"]:
                x = svc.setdefault(s["name"], [0, 0])
                x[0] += s["spans"]
                x[1] += s["errors"]
        services = [{"name": n, "spans": v[0], "errors": v[1]} for n, v in svc.items()]
        truncated = any(f["services_truncated"] for f in fs)
        if len(services) > 64:
            services.sort(key=lambda s: (-s["spans"], ub(s["name"])))
            services = services[:64]
            truncated = True
        services.sort(key=lambda s: ub(s["name"]))
        # The earliest root, then the smaller id; on a tie (one span in two units) the later input's.
        roots = [f for f in reversed(fs) if f["root_span_name"] is not None]
        root = min(roots, key=lambda f: (f["root_start_unix_nano"], f["root_span_id"])) if roots else None
        out.append({
            "trace_id": tid,
            "min_start_unix_nano": min(f["min_start_unix_nano"] for f in fs),
            "max_end_unix_nano": max(f["max_end_unix_nano"] for f in fs),
            "span_count": sum(f["span_count"] for f in fs),
            "error_count": sum(f["error_count"] for f in fs),
            "root_service_name": root["root_service_name"] if root else None,
            "root_span_name": root["root_span_name"] if root else None,
            "root_start_unix_nano": root["root_start_unix_nano"] if root else None,
            "root_span_id": root["root_span_id"] if root else None,
            "services": services,
            "services_truncated": truncated,
            "hours": sorted({h for f in fs for h in f["hours"]}),
        })
    return out


# ─────────────────────────── the token filter, read here ───────────────────────────

def ref_tokens(text):
    out = set()
    run = []
    for ch in text + " ":
        if (ch.isascii() and ch.isalnum()) or not ch.isascii():
            run.append(ch)
            continue
        if len("".join(run).encode()) >= 4:
            t = b""
            for c in run:
                b = c.encode()
                if len(t) + len(b) > 64:
                    break
                t += b.lower() if c.isascii() else b
            out.add(t)
        run = []
    return out


def parse_filter(b):
    check("filter magic", b[:4] == b"VZT1")
    n_rg, n, n_blocks, reserved = struct.unpack_from("<IIII", b, 4)
    check("filter reserved", reserved == 0)
    check("filter blocks", n_blocks == (n + 15) // 16)
    stride = (n_rg + 7) // 8
    offs = struct.unpack_from(f"<{n_blocks}I", b, 20)
    blocks = b[20 + 4 * n_blocks: len(b) - n * stride]
    bitsets = b[len(b) - n * stride:]
    toks = []
    for k in range(n_blocks):
        at = offs[k]
        end = offs[k + 1] if k + 1 < n_blocks else len(blocks)
        prev = b""
        for j in range(min(16, n - 16 * k)):
            shared, suffix = blocks[at], blocks[at + 1]
            check("filter block first token", j > 0 or shared == 0)
            t = prev[:shared] + blocks[at + 2: at + 2 + suffix]
            at += 2 + suffix
            toks.append(t)
            prev = t
        check("filter block end", at == end, f"{at} {end}")
    check("filter tokens sorted and unique", all(a < c for a, c in zip(toks, toks[1:])))
    out = {}
    for i, t in enumerate(toks):
        row = bitsets[i * stride:(i + 1) * stride]
        out[t] = sorted(g for g in range(n_rg) if row[g // 8] >> (g % 8) & 1)
        check("filter bits past the row groups are zero", all(not (row[g // 8] >> (g % 8) & 1) for g in range(n_rg, 8 * stride)))
    return n_rg, out


# ─────────────────────────── DuckDB ───────────────────────────

def duck_rows(path, schema):
    con = duckdb.connect()
    sel, kinds = [], []
    for field in schema:
        c = field.name
        if pa.types.is_map(field.type):
            sel.append(f"map_keys({c}) AS {c}__k, map_values({c}) AS {c}__v, {c} IS NULL AS {c}__null")
            kinds.append((c, "map"))
        elif pa.types.is_timestamp(field.type):
            sel.append(f"epoch_us({c}) AS {c}")
            kinds.append((c, "plain"))
        else:
            sel.append(c)
            kinds.append((c, "plain"))
    rel = con.execute(f"SELECT {', '.join(sel)} FROM read_parquet('{os.path.join(DIR, path)}')")
    names = [d[0] for d in rel.description]
    out = []
    for vals in rel.fetchall():
        r = dict(zip(names, vals))
        row = {}
        for c, kind in kinds:
            row[c] = (None if r[f"{c}__null"] else list(zip(r[f"{c}__k"], r[f"{c}__v"]))) if kind == "map" else r[c]
        out.append(row)
    con.close()
    return out


def same(a, b):
    if isinstance(a, float) and isinstance(b, float):
        return (math.isnan(a) and math.isnan(b)) or a == b
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, (bytes, bytearray)) or isinstance(b, (bytes, bytearray)):
        return bytes(a) == bytes(b)
    return a == b


# ─────────────────────────── the checks ───────────────────────────

manifest = json.load(open(os.path.join(DIR, "manifest.json")))
counts = {"spans": 0, "trace_index": 0, "logs": 0}
filters = 0
for m in manifest:
    table, path = m["table"], m["path"]
    counts[table] += 1
    ins = [read(p) for p in m["inputs"]]
    got = read(path)
    want = {"spans": expect_spans, "logs": expect_logs, "trace_index": expect_index}[table](ins)
    check(f"{table} rows", len(got) == len(want) == m["rows"], f"{path}: {len(got)} {len(want)} {m['rows']}")
    for g, w in zip(got, want):
        gw = {k: g[k] for k in w}
        check(f"{table} row", norm(gw) == norm(w), f"{path}: {str(gw)[:200]} != {str(w)[:200]}")
    # One partition.
    if table == "spans":
        check("one hour", len({r["start_unix_nano"] // 3_600_000_000_000 for r in got}) == 1, path)
    elif table == "logs":
        check("one day", len({r["ts"] // 86_400_000_000_000 for r in got}) == 1, path)
    else:
        check("one day", len({r["min_start_unix_nano"] // 86_400_000_000_000 for r in got}) == 1, path)
    # Row groups and the fragment.
    f = pq.ParquetFile(os.path.join(DIR, path))
    md = f.metadata
    ix = json.loads(m["index"])
    check("fragment row groups", len(ix["rg"]) == md.num_row_groups, path)
    last_end = 4
    for g, e in enumerate(ix["rg"]):
        rg = md.row_group(g)
        check("rg cap", rg.num_rows <= min(100_000, m["max_rg_rows"]), path)
        check("rg rows", e["rows"] == rg.num_rows, path)
        starts, ends = [], []
        for c in range(rg.num_columns):
            col = rg.column(c)
            start = col.dictionary_page_offset if col.has_dictionary_page else col.data_page_offset
            starts.append(start)
            ends.append(start + col.total_compressed_size)
        check("rg off", e["off"] == min(starts), path)
        check("rg len", e["len"] == max(ends) - min(starts), path)
        last_end = max(last_end, max(ends))
    size = os.path.getsize(os.path.join(DIR, path))
    kv = {k.decode(): v.decode() for k, v in (md.metadata or {}).items()}
    if table == "logs":
        check("logs output has a token filter", "tok" in ix and "viz.token_filter" in kv, path)
        off, ln = ix["tok"]
        check("tok = viz.token_filter", kv.get("viz.token_filter") == f"{off},{ln}", path)
        check("filter after the last row group", off >= last_end, path)
        check("foot after the filter", ix["foot"] == [off + ln, size - off - ln], f"{path} {ix['foot']}")
        raw = open(os.path.join(DIR, path), "rb").read()
        n_rg, filt = parse_filter(raw[off:off + ln])
        check("filter row groups", n_rg == md.num_row_groups, path)
        want_tok = {}
        for g in range(md.num_row_groups):
            toks = set()
            for r in as_rows(f.read_row_group(g)):
                toks |= ref_tokens(r["line"])
                for _, v in r["metadata"]:
                    toks |= ref_tokens(v)
            for t in toks:
                want_tok.setdefault(t, []).append(g)
        check("filter tokens", filt == want_tok, f"{path}: {len(filt)} tokens, {len(want_tok)} expected; extra {sorted(set(filt) - set(want_tok))[:5]} missing {sorted(set(want_tok) - set(filt))[:5]}")
        filters += 1
    else:
        check("no token filter", "tok" not in ix and "viz.token_filter" not in kv, path)
        check("foot", ix["foot"] == [last_end, size - last_end], path)
    # DuckDB reads the same values.
    drows = duck_rows(path, pq.read_schema(os.path.join(DIR, path)))
    check("duckdb rows", len(drows) == len(got), path)
    for a, d in zip(got, drows):
        for c in a:
            check(f"duckdb {table}.{c}", same(a[c], d[c]), f"{path} {str(a[c])[:80]} {str(d[c])[:80]}")

print(json.dumps({"outputs": len(manifest), **counts, "token_filters": filters, "checks": checks, "failures": len(failures),
                  "pyarrow": pa.__version__, "duckdb": duckdb.__version__}))
for x in failures[:30]:
    print("FAIL", x)
sys.exit(1 if failures else 0)
