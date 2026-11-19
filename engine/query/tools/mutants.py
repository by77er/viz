#!/usr/bin/env python3
"""Mutation check for viz-query: apply one source change at a time, run the test suite,
restore the file, and report which tests failed.

    python3 tools/mutants.py            # all mutants
    python3 tools/mutants.py 3 7        # only these
    VIZ_MUTANTS_DIR=<dir> python3 …     # where the scratch tree goes

A mutant is KILLED if at least one test fails, SURVIVED if the suite passes, and a BUILD
ERROR is reported separately (it proves nothing). The unmutated suite is run first.
Property tests run with VIZ_PROPTEST_CASES=8 to keep a run short; the corpus test is
left out unless a mutant names it. engine/storage is never mutated here (it is another
component's source); storage-side faults are emulated in the adapter.

NOTHING IN THE SHARED TREE IS WRITTEN (AGENTS.md, "Tests must have teeth": others commit
and snapshot the tree while this runs, and a mutant applied in place once reached a pull
request). The script copies `engine/query` and `engine/promql` (the crates mutants touch)
into a scratch tree, links `engine/storage` there, builds in the scratch tree's own
target directory, and mutates only the copies. `VIZ_MUTANTS_DIR` chooses where the
scratch tree goes (default: a new temporary directory). At the end it compares the shared
tree's copies of the mutated files with their state at the start.
"""
import hashlib, os, re, shutil, subprocess, sys, tempfile

SHARED = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # read, never written
ENGINE = os.path.dirname(SHARED)


def scratch_tree():
    base = os.environ.get("VIZ_MUTANTS_DIR")
    if base:
        os.makedirs(base, exist_ok=True)
    top = tempfile.mkdtemp(prefix="viz-query-mutants-", dir=base)
    ignore = shutil.ignore_patterns("target", "target-*")
    for crate in ("query", "promql"):
        shutil.copytree(os.path.join(ENGINE, crate), os.path.join(top, "engine", crate), ignore=ignore, symlinks=True)
    os.symlink(os.path.join(ENGINE, "storage"), os.path.join(top, "engine", "storage"))
    return top


# Set by `setup()`, never at import: importing this module (to read MUTANTS) copies nothing.
TOP = ROOT = SRC = PROMQL = None
ENV = None


def setup():
    global TOP, ROOT, SRC, PROMQL, ENV
    TOP = scratch_tree()
    ROOT = os.path.join(TOP, "engine", "query")
    SRC = os.path.join(ROOT, "src")
    PROMQL = os.path.join(ROOT, "..", "promql", "src")
    ENV = dict(os.environ, CARGO_TARGET_DIR=os.path.join(TOP, "target"), VIZ_PROPTEST_CASES="8")
SELECT = "let found = viz_storage::select(self.input, &ms, min_ts_ms, max_ts_ms).map_err(|e| self.fail(QueryError::from_storage(e)))?;"
HANDOVER = "Ok(found.into_iter().map(|s| Series { labels: s.labels, ts: s.ts, values: s.values }).collect())"

PRUNING = ["--test", "pruning"]

MUTANTS = [
    ("tail data dropped", "source.rs", SELECT,
     SELECT.replace("self.input,", "&ScanInput { tail_batches: vec![], ..self.input.clone() },")),
    ("lake data dropped", "source.rs", SELECT,
     SELECT.replace("self.input,", "&ScanInput { series_files: vec![], sample_files: vec![], ..self.input.clone() },")),
    ("range end off by one (max_ts - 1)", "source.rs", SELECT, SELECT.replace("max_ts_ms)", "max_ts_ms - 1)")),
    ("range start off by one (min_ts + 1)", "source.rs", SELECT, SELECT.replace("min_ts_ms,", "min_ts_ms + 1,")),
    ("staleness markers from Parquet ignored (dropped when the input has lake files)", "source.rs", HANDOVER,
     "let lake = !self.input.sample_files.is_empty(); Ok(found.into_iter().map(|s| { let keep: Vec<bool> = s.values.iter().map(|v| !(lake && v.to_bits() == 0x7ff0_0000_0000_0002)).collect(); let mut i = 0; let mut ts = s.ts; ts.retain(|_| { i += 1; keep[i - 1] }); let mut j = 0; let mut values = s.values; values.retain(|_| { j += 1; keep[j - 1] }); Series { labels: s.labels, ts, values } }).collect())"),
    ("NaN payloads canonicalised on the way to the evaluator (marker becomes a plain NaN)", "source.rs", HANDOVER,
     HANDOVER.replace("values: s.values", "values: s.values.into_iter().map(|v| if v.is_nan() { f64::NAN } else { v }).collect()")),
    ("no de-duplication between lake and tail (each read separately, results appended)", "source.rs", SELECT,
     "let mut found = viz_storage::select(&ScanInput { tail_batches: vec![], ..self.input.clone() }, &ms, min_ts_ms, max_ts_ms).map_err(|e| self.fail(QueryError::from_storage(e)))?; found.extend(viz_storage::select(&ScanInput { series_files: vec![], sample_files: vec![], ..self.input.clone() }, &ms, min_ts_ms, max_ts_ms).map_err(|e| self.fail(QueryError::from_storage(e)))?);"),
    ("wrong unit: sample timestamps handed over in seconds", "source.rs", HANDOVER,
     HANDOVER.replace("ts: s.ts", "ts: s.ts.into_iter().map(|t| t / 1000).collect()")),
    ("wrong unit: JSON timestamps left in milliseconds (viz-promql serialiser)", "PROMQL/api.rs",
     "            s.serialize_i64(self.0 / 1000)", "            s.serialize_i64(self.0)"),
    ("max_samples does not fire", "source.rs", "if samples > self.limits.max_samples {", "if false && samples > self.limits.max_samples {"),
    ("max_samples counted per selector instead of per query", "source.rs",
     "let samples = self.samples.get().saturating_add(n);", "let samples = n;"),
    ("max_samples fires one early (>=)", "source.rs", "if samples > self.limits.max_samples {", "if samples >= self.limits.max_samples {"),
    ("max_series does not fire", "source.rs", "if series > self.limits.max_series {", "if false && series > self.limits.max_series {"),
    ("max_step_points does not fire", "source.rs", "if cells > self.limits.max_step_points {", "if false && cells > self.limits.max_step_points {"),
    ("max_step_points ignores subquery step grids (always the outer step count)", "source.rs",
     ".unwrap_or(self.default_steps)", ".map(|_| self.default_steps).unwrap_or(self.default_steps)"),
    ("max_output_points does not fire", "lib.rs", "if points > opts.limits.max_output_points {", "if false && points > opts.limits.max_output_points {"),
    ("max_query_bytes does not fire", "limits.rs", "if query.len() as u64 > self.max_query_bytes {", "if false && query.len() as u64 > self.max_query_bytes {"),
    ("max_depth does not fire", "limits.rs", "if depth > self.max_depth {", "if false && depth > self.max_depth {"),
    ("depth estimate ignores operators", "limits.rs",
     "b'+' | b'-' | b'*' | b'/' | b'%' | b'^' | b'=' | b'!' | b'<' | b'>' | b'~' => {\n                if let Some(top) = stack.last_mut() {\n                    top.0 += 1;",
     "b'+' | b'-' | b'*' | b'/' | b'%' | b'^' | b'=' | b'!' | b'<' | b'>' | b'~' => {\n                if let Some(top) = stack.last_mut() {\n                    top.0 += 0;"),
    ("depth estimate forgets closed groups (only currently open brackets count)", "limits.rs",
     "top.1 = top.1.max(depth);", "top.1 = top.1.max(depth.min(1));"),
    ("plan: range end one millisecond short", "plan.rs",
     "let (lo, hi) = (s.min_ts_ms.max(MIN_TS), s.max_ts_ms.min(MAX_TS));", "let (lo, hi) = (s.min_ts_ms.max(MIN_TS), s.max_ts_ms.min(MAX_TS) - 1);"),
    ("plan: range start one millisecond late", "plan.rs",
     "let (lo, hi) = (s.min_ts_ms.max(MIN_TS), s.max_ts_ms.min(MAX_TS));", "let (lo, hi) = (s.min_ts_ms.max(MIN_TS) + 1, s.max_ts_ms.min(MAX_TS));"),
    ("plan: keeps only the first range of a matcher set", "plan.rs",
     "Some(g) => g.1.push((lo, hi)),", "Some(_) => {}"),
    ("plan: merges ranges that are apart (fetches the gap)", "plan.rs", "if lo <= cur.1.saturating_add(1) {", "if true {"),
    ("plan: not clamped to storable timestamps", "plan.rs",
     "let (lo, hi) = (s.min_ts_ms.max(MIN_TS), s.max_ts_ms.min(MAX_TS));", "let (lo, hi) = (s.min_ts_ms, s.max_ts_ms);"),
    ("parse errors reported as execution errors", "error.rs",
     'viz_promql::Error::Parse(m) => QueryError::bad_data(format!("parse error: {m}")),',
     'viz_promql::Error::Parse(m) => QueryError::execution(format!("parse error: {m}")),'),
    ("unsupported reported as execution", "error.rs",
     "viz_promql::Error::Unsupported(m) => QueryError::unsupported(m),", "viz_promql::Error::Unsupported(m) => QueryError::execution(m),"),
    ("limit error loses its cause (plain source error instead of the recorded one)", "lib.rs",
     "    let matrix = viz_promql::query_range_expr(&src, &expr, start_ms, end_ms, step_ms, &opts.eval, Some(&agg::Canonical))\n        .map_err(|e| src.take_failure().unwrap_or_else(|| QueryError::from_promql(e)))?;",
     "    let matrix = viz_promql::query_range_expr(&src, &expr, start_ms, end_ms, step_ms, &opts.eval, Some(&agg::Canonical))\n        .map_err(QueryError::from_promql)?;"),
    ("label_values ignores the matchers", "meta.rs",
     "    for l in load(matchers, min_ts, max_ts, &src)? {\n        values.extend(", "    for l in load(&[], min_ts, max_ts, &src)? {\n        values.extend("),
    ("series() accepts a matcher set that matches everything", "meta.rs", "    if selective {\n        Ok(())", "    if selective || true {\n        Ok(())"),
    ("matcher operator mistranslated (!~ becomes =~)", "source.rs",
     "MatchOp::Nre => viz_storage::MatchOp::NotRe,", "MatchOp::Nre => viz_storage::MatchOp::Re,"),
    # ---- split execution (src/split.rs, src/agg.rs, src/exact.rs, src/cardinality.rs)
    ("split by file, not by series: a reader keeps every series of its files", "split.rs",
     "let keep = key.part(&labels, parts) == part && !filter.intervals(&labels).is_empty();",
     "let keep = !filter.intervals(&labels).is_empty();"),
    ("topk/bottomk merged with k one too small", "agg.rs",
     "rank(top, m, self.k.get(i).copied().unwrap_or(0));", "rank(top, m, self.k.get(i).copied().unwrap_or(0) - 1);"),
    ("avg merged as the mean of the parts' means", "agg.rs",
     "            (Cell::Avg(n, a), Cell::Avg(m, b)) => {\n                *n += m;\n                a.merge(b)\n            }",
     "            (Cell::Avg(n, a), Cell::Avg(m, b)) => {\n                let (x, y) = (a.mean(*n), b.mean(*m));\n                *a = ExactSum::default();\n                a.add(x);\n                a.add(y);\n                *n = 2;\n            }"),
    ("a binary operation between two vectors is distributed anyway", "split.rs",
     '                return Err("a binary operation between two vectors (or a scalar that reads data) matches series against each other".into());',
     "                &b.lhs"),
    ("merge order dependence: min keeps whichever came first between -0 and +0", "agg.rs",
     "    } else if a.is_sign_negative() {\n        a\n    } else {\n        b\n    }\n}\n\n/// `max`, likewise",
     "    } else {\n        a\n    }\n}\n\n/// `max`, likewise"),
    ("merge order dependence: sums of parts added as floats", "agg.rs",
     "            (Cell::Sum(a), Cell::Sum(b)) => a.merge(b),",
     "            (Cell::Sum(a), Cell::Sum(b)) => {\n                let v = a.value() + b.value();\n                *a = ExactSum::default();\n                a.add(v)\n            }"),
    ("a leaf lets the batch that arrives last win, not the one of higher precedence", "split.rs",
     "if rank >= g.rank[k] {", "if true {"),
    ("the coordinator does not replay max_samples on the summed counts", "split.rs",
     "            if samples > opts.limits.max_samples {", "            if false && samples > opts.limits.max_samples {"),
    ("a leaf's budget is not enforced while gathering", "split.rs",
     "            if self.samples > self.budget.samples {", "            if false && self.samples > self.budget.samples {"),
    ("exact sum rounded as truncation (no round-to-nearest)", "exact.rs",
     "        if guard && (rest || m & 1 == 1) {", "        if false && guard && (rest || m & 1 == 1) {"),
    # Series-level pruning and the series-only read (2026-11-19). A fifth element names the
    # test targets that cover the mutant; the others run TESTS.
    ("pruning: a part's plan keeps the other parts' series", "prune.rs",
     "=> SplitKey::part_of(row.series_id as u64, p.parts) == p.part,", "=> SplitKey::part_of(row.series_id as u64, p.parts) != p.part,", PRUNING),
    ("pruning: a series that carries a `without` label is placed by its id, not its key", "prune.rs",
     "let carries = |json: &[u8]| needles.iter().any(|n| json.windows(n.len()).any(|w| w == &n[..]));",
     "let carries = |json: &[u8]| needles.is_empty() && json.is_empty();", PRUNING),
    ("pruning: a read without a name keeps a row group only if it may hold every wanted name", "prune.rs",
     "g.overlaps(r.min_ts, r.max_ts) && w.iter().any(|(n, iv)| g.may_hold(n, iv))", "g.overlaps(r.min_ts, r.max_ts) && w.iter().all(|(n, iv)| g.may_hold(n, iv))", PRUNING),
    ("pruning: part_sids' upper end runs into the next part", "prune.rs",
     "let hi = (first(part + 1) - 1) as u64;", "let hi = first(part + 1) as u64;", PRUNING),
    ("pruning: a part's id-range plan reads the next part's range", "prune.rs",
     "    let sids = part_sids(part, parts);", "    let sids = part_sids((part + 1) % parts, parts);", PRUNING),
    ("pruning: the carrier's rows sit inside a read's range", "prune.rs",
     "let rows: Vec<Row> = (0..selected.len()).map(|i| Row::new(i as u32, nowhere, 0.0)).collect();",
     "let rows: Vec<Row> = (0..selected.len()).map(|i| Row::new(i as u32, reads[0].min_ts.max(0), 0.0)).collect();", PRUNING),
    ("series-only read: a file's row is in the window one millisecond late", "meta.rs",
     "if row.min_ts > max_ts || row.max_ts < min_ts {", "if row.min_ts >= max_ts || row.max_ts < min_ts {", PRUNING),
    ("series-only read: a tail row at the window's start is not in it", "meta.rs",
     "            if t >= min_ts && t <= max_ts {\n                in_window", "            if t > min_ts && t <= max_ts {\n                in_window", PRUNING),
    ("series-only read: the tail is not read", "meta.rs",
     "    for (bi, bytes) in input.tail_batches.iter().enumerate() {", "    for (bi, bytes) in input.tail_batches.iter().enumerate().take(0) {", PRUNING),
    ("series-only read: max_series does not fire", "meta.rs",
     "            if count > limits.max_series {", "            if false && count > limits.max_series {", PRUNING),
]


TESTS = ["--test", "api", "--test", "invariance", "--test", "limits", "--test", "plan", "--test", "staleness", "--test", "split", "--lib"]


def run(targets=None):
    # -j 2 and two test threads: the machine is shared (AGENTS.md).
    p = subprocess.run(["cargo", "test", "--offline", "--no-fail-fast", "-j", "2"] + (targets or TESTS) + ["--", "--test-threads", "2"], cwd=ROOT, env=ENV, capture_output=True, text=True)
    out = p.stdout + p.stderr
    failed = sorted(set(re.findall(r"^test (\S+) \.\.\. FAILED", out, re.M)))
    build_error = "could not compile" in out
    return p.returncode, failed, build_error


def shared_path(file):
    return os.path.join(ENGINE, "promql", "src", file[len("PROMQL/"):]) if file.startswith("PROMQL/") else os.path.join(SHARED, "src", file)


def fingerprint():
    h = hashlib.sha256()
    for f in sorted({m[1] for m in MUTANTS}):
        h.update(f.encode())
        h.update(open(shared_path(f), "rb").read())
    return h.hexdigest()[:16]


def main():
    only = [int(a) for a in sys.argv[1:]]
    setup()
    print(f"scratch tree: {TOP} (copies of engine/query and engine/promql, a link to engine/storage)")
    before = fingerprint()
    for targets in sorted({tuple(m[4]) if len(m) > 4 else tuple(TESTS) for i, m in enumerate(MUTANTS, 1) if not only or i in only}):
        code, failed, be = run(list(targets))
        if code != 0:
            print("the unmutated suite does not pass:", failed, "(build error)" if be else "")
            sys.exit(2)
    print("unmutated suite: passes\n")
    survived = 0
    for i, m in enumerate(MUTANTS, 1):
        name, file, old, new = m[:4]
        if only and i not in only:
            continue
        path = os.path.join(PROMQL, file[len("PROMQL/"):]) if file.startswith("PROMQL/") else os.path.join(SRC, file)
        original = open(path).read()
        if original.count(old) != 1:
            print(f"{i:>2}. {name}: PATTERN NOT FOUND EXACTLY ONCE in {file} ({original.count(old)})")
            survived += 1
            continue
        try:
            open(path, "w").write(original.replace(old, new))
            code, failed, be = run(m[4] if len(m) > 4 else None)
        finally:
            open(path, "w").write(original)
        if be:
            print(f"{i:>2}. {name}: BUILD ERROR")
            survived += 1
        elif code == 0:
            print(f"{i:>2}. {name}: SURVIVED")
            survived += 1
        else:
            print(f"{i:>2}. {name}: killed by {', '.join(failed)}")
        sys.stdout.flush()
    code, failed, be = run()
    print("\nsource restored; unmutated suite:", "passes" if code == 0 else f"FAILS {failed}")
    print(f"{survived} mutant(s) not killed")
    after = fingerprint()
    print(f"shared tree, files the mutants touch: {before} before, {after} after" + (" (unchanged)" if before == after else " (CHANGED: by someone else; this script writes only to the scratch tree)"))
    sys.exit(1 if survived or code else 0)


if __name__ == "__main__":
    main()
