#!/usr/bin/env python3
"""Mutation check: break one behaviour at a time, run the test suite, expect it to fail.

    python3 tools/mutants.py            # from engine/storage

Each mutant is a literal text replacement in one source file. The file is restored after
each run (and on interrupt). Prints KILLED (tests failed, good) or SURVIVED per mutant and
exits 1 if any survived or a pattern no longer matches the source.
"""
import os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MUTANTS = [
    ("earlier batch wins on duplicates in flush", "src/encode.rs",
     "for (b, map) in decoded.iter().zip(&local) {\n        for i in 0..b.n_rows() {",
     "for (b, map) in decoded.iter().zip(&local).rev() {\n        for i in 0..b.n_rows() {"),
    ("flush sorts by (series_id, metric_name) instead of (metric_name, series_id)", "src/encode.rs",
     "(a.metric_name().as_bytes(), a.series_id).cmp(&(b.metric_name().as_bytes(), b.series_id))",
     "(a.series_id, a.metric_name().as_bytes()).cmp(&(b.series_id, b.metric_name().as_bytes()))"),
    ("flush quiets NaN payloads", "src/encode.rs",
     "chunk.iter().map(|r| f64::from_bits(r.bits)).collect()",
     "chunk.iter().map(|r| f64::from_bits(r.bits) + 0.0).collect()"),
    ("day boundary truncates toward zero instead of flooring", "src/day.rs",
     "ts_ms.div_euclid(MS_PER_DAY)", "ts_ms / MS_PER_DAY"),
    ("row-group cap is 100,001", "src/pq.rs",
     "pub const MAX_ROW_GROUP_ROWS: usize = 100_000;", "pub const MAX_ROW_GROUP_ROWS: usize = 100_001;"),
    ("index fragment min_ts is wrong (takes the max)", "src/pq.rs",
     "let min_ts = lo.iter().copied().min().unwrap_or(0);", "let min_ts = lo.iter().copied().max().unwrap_or(0);"),
    ("index fragment row-group offset is off by one", "src/pq.rs",
     "            offset,\n            length: end - offset,", "            offset: offset + 1,\n            length: end - offset,"),
    ("select drops the ts range filter on lake rows", "src/select.rs",
     "if ts[k] >= min_ts && ts[k] <= max_ts {", "if true {"),
    ("select drops the ts range filter on tail rows", "src/select.rs",
     "if t >= min_ts && t <= max_ts {", "if true {"),
    ("regex matchers are not anchored", "src/select.rs",
     '"^(?s:{})$"', '"(?s:{})"'),
    ("missing label does not compare as the empty string", "src/select.rs",
     '.map_or("", |(_, v)| v.as_ref());', '.map_or("\\u{0}", |(_, v)| v.as_ref());'),
    ("lake wins over tail / earlier wins on duplicate ts in select", "src/select.rs",
     "if i + 1 < rows.len() && rows[i + 1].0 == *t {", "if i > 0 && rows[i - 1].0 == *t {"),
    ("ts pruning of sample row groups is off by one", "src/select.rs",
     "if hi < min_ts || lo > max_ts {", "if hi <= min_ts || lo > max_ts {"),
    ("metric_name pruning of series row groups is off by one", "src/select.rs",
     "if want.as_bytes() < lo || want.as_bytes() > hi {", "if want.as_bytes() <= lo || want.as_bytes() > hi {"),
    ("series_id pruning of sample row groups ignores the upper bound", "src/select.rs",
     "i == sorted.len() || sorted[i].borrow() > hi", "i == sorted.len() || sorted[i].borrow() >= hi"),
    ("merge: earlier input wins on duplicates", "src/merge.rs",
     "(self.name.data(), self.sid, self.ts, self.input, self.row)",
     "(self.name.data(), self.sid, self.ts, usize::MAX - self.input, self.row)"),
    ("merge: duplicates are not removed", "src/merge.rs",
     "if !next.as_ref().is_some_and(|h| h.same_sample(&p)) {", "if true {"),
    ("merge of series keeps the later min_ts instead of the smallest", "src/merge.rs",
     "omin[k] = omin[k].min(r.min_ts);", "omin[k] = r.min_ts;"),
    ("batch decode accepts series index == n_series", "src/batch.rs",
     "if index >= n_series {", "if index > n_series {"),
    ("batch decode does not require sorted labels", "src/batch.rs",
     "std::cmp::Ordering::Greater => return Err(BatchError::UnsortedLabels { series: si }),",
     "std::cmp::Ordering::Greater => {}"),
    ("series_id omits the 0x00 separators", "src/batch.rs",
     "        h ^= 0;\n        h = h.wrapping_mul(FNV_PRIME);\n", ""),
    # contracts v2
    ("v2: batch decode accepts a NUL byte in a label", "src/batch.rs",
     "if name.contains(&0) || value.contains(&0) {", "if false {"),
    ("v2: batch decode accepts 129 labels", "src/batch.rs",
     "if n_labels > MAX_LABELS {", "if n_labels > MAX_LABELS + 1 {"),
    ("v2: batch decode accepts over-long label values", "src/batch.rs",
     "if name.len() > MAX_LABEL_NAME_BYTES || value.len() > MAX_LABEL_VALUE_BYTES {", "if name.len() > MAX_LABEL_NAME_BYTES {"),
    ("v2: batch decode accepts timestamps after year 9999", "src/batch.rs",
     "pub const MAX_TS: i64 = 253_402_300_799_999;", "pub const MAX_TS: i64 = i64::MAX;"),
    ("v2: batch decode accepts negative timestamps", "src/batch.rs",
     "pub const MIN_TS: i64 = 0;", "pub const MIN_TS: i64 = i64::MIN;"),
    ("v2: earlier row wins inside one batch (select, tail)", "src/select.rs",
     "if i + 1 < rows.len() && rows[i + 1].0 == *t {", "if i + 1 < rows.len() && rows[i + 1].0 == *t && false {"),
    ("v2: canonical JSON escapes control characters in upper-case hex", "src/json.rs",
     "out.push(char::from_digit((c as u32) & 15, 16).unwrap());", "out.push(char::from_digit((c as u32) & 15, 16).unwrap().to_ascii_uppercase());"),
]

def tests_fail():
    """Returns (status, failing test names); status is 'pass', 'fail' or 'nobuild'."""
    env = dict(os.environ, CARGO_TARGET_DIR=os.path.join(ROOT, "target"))
    p = subprocess.run(["cargo", "test", "--tests", "--no-fail-fast"], cwd=ROOT, env=env, capture_output=True, text=True)
    if "could not compile" in p.stderr:
        return "nobuild", []
    failed = sorted({l.split()[1] for l in p.stdout.splitlines() if l.startswith("test ") and l.rstrip().endswith("FAILED")})
    if p.returncode == 0:
        return "pass", []
    return "fail", failed or ["(test binary aborted)"]

def main():
    only = sys.argv[1:]
    status, which = tests_fail()
    print(f"baseline (no mutation): {status}", flush=True)
    if status != "pass":
        print("the unmutated suite must pass first:", which)
        sys.exit(2)
    bad = 0
    for name, rel, old, new in MUTANTS:
        if only and not any(o in name for o in only):
            continue
        path = os.path.join(ROOT, rel)
        src = open(path).read()
        if src.count(old) != 1:
            print(f"STALE     {name}: pattern occurs {src.count(old)} times in {rel}")
            bad += 1
            continue
        try:
            open(path, "w").write(src.replace(old, new))
            status, which = tests_fail()
        finally:
            open(path, "w").write(src)
        label = {"fail": "KILLED  ", "pass": "SURVIVED", "nobuild": "NOBUILD "}[status]
        print(f"{label}  {name}  [{rel}]" + (f"  failing: {', '.join(which)}" if which else ""), flush=True)
        bad += 0 if status == "fail" else 1
    sys.exit(1 if bad else 0)

main()
