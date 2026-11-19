#!/usr/bin/env python3
"""Mutation check: break one behaviour at a time, run the tests, expect them to fail.

    python3 tools/mutants.py                 # every mutant (from engine/storage)
    python3 tools/mutants.py pruning         # only mutants whose name contains "pruning"
    python3 tools/mutants.py sigmerge tokens # compaction of spans and logs, the token filter
    VIZ_MUTANTS_DIR=<dir> python3 …          # where the scratch copy goes

NOTHING IN THE SHARED TREE IS WRITTEN (AGENTS.md, "Tests must have teeth": others commit and
snapshot the tree while this runs). The crate is copied to a scratch directory first (no
`target/`), mutants are applied to the copy, and the copy builds in its own target
directory. Each mutant is a literal text replacement in one source file, restored after
its run. A mutant may name the test targets that cover it (`--test pruning`); otherwise the
whole suite runs. Prints KILLED (tests failed, good), SURVIVED or NOBUILD per mutant and
exits 1 if any survived, did not build, or a pattern no longer matches the source exactly once.
At the end the shared tree's copies of the mutated files are compared with their state at
the start.
"""
import hashlib, os, shutil, subprocess, sys, tempfile

SHARED = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # read, never written
base = os.environ.get("VIZ_MUTANTS_DIR")
if base:
    os.makedirs(base, exist_ok=True)
ROOT = os.path.join(tempfile.mkdtemp(prefix="viz-storage-mutants-", dir=base), "storage")
shutil.copytree(SHARED, ROOT, ignore=shutil.ignore_patterns("target", "target-*"))
print(f"scratch copy: {ROOT}", flush=True)
PRUNING = ["--test", "pruning"]
OTEL = ["--test", "otel"]
SIGMERGE = ["--test", "sigmerge"]
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
     "let t = ts[k];\n                        if t >= min_ts && t <= max_ts {", "let t = ts[k];\n                        if true {"),
    ("select drops the ts range filter on tail rows", "src/select.rs",
     "let t = b.ts(i);\n                if t >= min_ts && t <= max_ts {", "let t = b.ts(i);\n                if true {"),
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
     "if !(MIN_TS..=MAX_TS).contains(&t) {", "if t < MIN_TS {"),
    ("v2: batch decode accepts negative timestamps", "src/batch.rs",
     "pub const MIN_TS: i64 = 0;", "pub const MIN_TS: i64 = i64::MIN;"),
    ("v2: earlier row wins inside one batch (select, tail)", "src/select.rs",
     "if i + 1 < rows.len() && rows[i + 1].0 == *t {", "if i + 1 < rows.len() && rows[i + 1].0 == *t && false {"),
    ("v2: canonical JSON escapes control characters in upper-case hex", "src/json.rs",
     "out.push(char::from_digit((c as u32) & 15, 16).unwrap());", "out.push(char::from_digit((c as u32) & 15, 16).unwrap().to_ascii_uppercase());"),
    # series-level pruning (2026-11-19): the predicate, the index writer, partial reads
    ("pruning: may_hold's lower series bound is off by one", "src/pq.rs",
     "            if name == lo_name {\n                lo = first;", "            if name == lo_name {\n                lo = first.saturating_add(1);", PRUNING),
    ("pruning: may_hold ignores the upper series bound", "src/pq.rs",
     "            if name == hi_name {\n                hi = last;", "            if name == hi_name {\n                hi = i64::MAX;", PRUNING),
    ("pruning: may_hold trusts statistics that contradict the sort order", "src/pq.rs",
     "            if lo > hi {\n                return true;", "            if lo > hi {\n                return false;", PRUNING),
    ("pruning: may_hold misses an interval that ends exactly at the bound", "src/pq.rs",
     "sids.partition_point(|(_, b)| *b < lo)", "sids.partition_point(|(_, b)| *b <= lo)", PRUNING),
    ("pruning: may_hold ignores the name range", "src/pq.rs",
     "        if name < lo_name || name > hi_name {\n            return false;", "        if name < lo_name {\n            return false;", PRUNING),
    ("pruning: index writer records the first series_id as the last", "src/pq.rs",
     "sid: Some((sids[0], sids[n - 1])),", "sid: Some((sids[0], sids[0])),", PRUNING),
    ("pruning: index writer's footer offset is one byte late", "src/pq.rs",
     ".map(|g| g.offset + g.length).max().unwrap_or(4);", ".map(|g| g.offset + g.length + 1).max().unwrap_or(4);", PRUNING),
    ("pruning: index writer's footer length is one byte short", "src/pq.rs",
     "(bytes.len() as u64).saturating_sub(end)", "(bytes.len() as u64).saturating_sub(end + 1)", PRUNING),
    ("pruning: byte ranges leave out the footer", "src/pq.rs",
     "        r.push(foot);\n", "", PRUNING),
    ("pruning: byte ranges join ranges one byte too far apart", "src/pq.rs",
     "Some((po, pl)) if o <= (*po + *pl).saturating_add(gap) => {", "Some((po, pl)) if o <= (*po + *pl).saturating_add(gap + 1) => {", PRUNING),
    ("pruning: select maps rows of a later span to the wrong place", "src/select.rs",
     "base += spans[span].1 - spans[span].0;", "base += spans[span].1;", PRUNING),
    ("pruning: select reads a row group that was not fetched", "src/select.rs",
     "                if !src.has_row_group(md) {\n                    continue;\n                }\n                if opts.prune_row_groups {", "                if opts.prune_row_groups {", PRUNING),
    ("pruning: select skips a row group that was fetched", "src/select.rs",
     "                if !src.has_row_group(md) {\n                    continue;\n                }\n                if opts.prune_row_groups {", "                if !src.has_row_group(md) || g % 2 == 1 {\n                    continue;\n                }\n                if opts.prune_row_groups {", PRUNING),
    ("pruning: the run reader skips one row too few", "src/pq.rs",
     "        pos = b;\n    }\n    Ok(())", "        pos = b.saturating_sub(1);\n    }\n    Ok(())", PRUNING),
    ("pruning: a sparse container's segment is held one byte longer than it is", "src/sparse.rs",
     "(end <= s.0 + s.1.len() as u64).then_some(s)", "(end <= s.0 + s.1.len() as u64 + 1).then_some(s)", PRUNING),
    # spans and logs (2026-11-19): signals 2 and 3, the spans / trace_index / logs encoders
    ("otel: spans sorted by span_name before service_name", "src/spans.rs",
     "(a.hour, sa.map(str::as_bytes), a.span.name.as_bytes(), a.span.start, a.span.trace_id, a.span.span_id).cmp(&(\n            b.hour,\n            sb.map(str::as_bytes),\n            b.span.name.as_bytes(),",
     "(a.hour, a.span.name.as_bytes(), sa.map(str::as_bytes), a.span.start, a.span.trace_id, a.span.span_id).cmp(&(\n            b.hour,\n            b.span.name.as_bytes(),\n            sb.map(str::as_bytes),", OTEL),
    ("otel: logs sorted by stream_id before service_name", "src/logs.rs",
     "(a.day, sa.service.as_bytes(), sa.stream.stream_id, a.row.ts, a.row.line.as_bytes())\n            .cmp(&(b.day, sb.service.as_bytes(), sb.stream.stream_id,",
     "(a.day, sa.stream.stream_id, sa.service.as_bytes(), a.row.ts, a.row.line.as_bytes())\n            .cmp(&(b.day, sb.stream.stream_id, sb.service.as_bytes(),", OTEL),
    ("otel: a residual bool attribute dropped", "src/spans.rs",
     "Value::Bool(v) => out.b.push((a.key, *v)),", "Value::Bool(_) => {}", OTEL),
    ("otel: a non-string service.name dropped instead of kept residual", "src/spans.rs",
     "                if let Value::Str(v) = a.value {\n                    out.service = Some(v);\n                    continue;\n                }",
     "                if let Value::Str(v) = a.value {\n                    out.service = Some(v);\n                }\n                continue;", OTEL),
    ("otel: the earlier of duplicate spans wins", "src/spans.rs",
     "last.insert(key(s), (bi, ri));", "last.entry(key(s)).or_insert((bi, ri));", OTEL),
    ("otel: duplicate log rows kept", "src/logs.rs",
     "if it.peek().is_some_and(|next| same(&r, next)) {", "if false && it.peek().is_some_and(|next| same(&r, next)) {", OTEL),
    ("otel: spans partitioned by two-hour windows", "src/spans.rs",
     "hour: s.start.div_euclid(NS_PER_HOUR) });", "hour: s.start.div_euclid(2 * NS_PER_HOUR) });", OTEL),
    ("otel: trace_index takes the latest root, not the earliest", "src/spans.rs",
     "(s.start, s.span_id) < (x.span.start, x.span.span_id)", "(s.start, s.span_id) > (x.span.start, x.span.span_id)", OTEL),
    ("otel: trace_index error count counts every span", "src/spans.rs",
     "let err = (s.status == 2) as i32;", "let err = (s.status != 0) as i32;", OTEL),
    ("otel: span flags written even when zero", "src/spans.rs",
     "opt_i32(g.iter().map(|r| (r.span.flags != 0).then_some(r.span.flags as i32))),", "opt_i32(g.iter().map(|r| Some(r.span.flags as i32))),", OTEL),
    ("otel: span fragment min_dur over starts", "src/spans.rs",
     "let dmin = g.iter().map(|r| r.span.end - r.span.start).min().unwrap();", "let dmin = g.iter().map(|r| r.span.start).min().unwrap();", OTEL),
    ("otel: log fragment sid last = first", "src/logs.rs",
     "            st(&g[0]).stream.stream_id,\n            st(&g[g.len() - 1]).stream.stream_id\n", "            st(&g[0]).stream.stream_id,\n            st(&g[0]).stream.stream_id\n", OTEL),
    ("otel: log fragment stream's last row group not advanced", "src/logs.rs",
     "                    s.5 = gi;\n", "", OTEL),
    ("otel: line pages may exceed 1 MiB (chunks of 1 MiB)", "src/otelpq.rs",
     "pub const LINE_CHUNK_BYTES: usize = 262_148;", "pub const LINE_CHUNK_BYTES: usize = 1 << 20;", OTEL),
    ("otel: stream_id hashed differently from series_id (labels reversed)", "src/otel.rs",
     "    crate::batch::series_id(labels)\n", "    let mut l: Vec<(&str, &str)> = labels.iter().map(|(n, v)| (n.as_ref(), v.as_ref())).collect();\n    l.reverse();\n    crate::batch::series_id(&l)\n", OTEL),
    ("otel: decode accepts an all-zero trace_id", "src/otel.rs",
     "if t == [0; 16] || s == [0; 8] {", "if s == [0; 8] {", OTEL),
    ("otel: decode accepts unsorted attributes", "src/otel.rs",
     "if prev.key.as_bytes() >= key.as_bytes() {", "if prev.key.as_bytes() == key.as_bytes() {", OTEL),
    # compaction of spans and logs, and the token filter (2026-11-19)
    ("sigmerge: a span merged across hours (the merge takes two hours' rows)", "src/sigmerge.rs",
     "        if *hour.get_or_insert(h) != h {\n            return merr(\"spans inputs hold rows of more than one hour\");", "        if false {\n            return merr(\"spans inputs hold rows of more than one hour\");", SIGMERGE),
    ("sigmerge: a lost row in a logs merge (rows differing only in metadata taken for one)", "src/sigmerge.rs",
     "a.stream_id == b.stream_id && a.ts == b.ts && a.line == b.line && a.metadata == b.metadata", "a.stream_id == b.stream_id && a.ts == b.ts && a.line == b.line", SIGMERGE),
    ("sigmerge: a lost row in a logs merge (the last row never written)", "src/sigmerge.rs",
     "    let Some(p) = pending else { return merr(\"logs inputs hold no rows\") };\n    emit(p, &mut group, &mut writer)?;", "    let Some(p) = pending else { return merr(\"logs inputs hold no rows\") };\n    if group.is_empty() {\n        emit(p, &mut group, &mut writer)?;\n    }", SIGMERGE),
    ("sigmerge: the earlier input wins a duplicate span", "src/sigmerge.rs",
     "    seen.sort_unstable();\n", "    seen.sort_unstable_by(|a, b| a.0.cmp(&b.0).then((b.1, b.2).cmp(&(a.1, a.2))));\n", SIGMERGE),
    ("sigmerge: the earlier input wins a duplicate log row", "src/sigmerge.rs",
     "            Some(p) if !same_log(&p, &x) => emit(p, &mut group, &mut writer)?,\n            _ => {}\n        }\n        pending = Some(x);", "            Some(p) if !same_log(&p, &x) => emit(p, &mut group, &mut writer)?,\n            Some(p) => {\n                pending = Some(p);\n                continue;\n            }\n            _ => {}\n        }\n        pending = Some(x);", SIGMERGE),
    ("sigmerge: trace_index fragments of one trace not merged (the first kept)", "src/sigmerge.rs",
     "        let mut f = merge_fragments(&run).unwrap();", "        let mut f = run.last().unwrap().clone();", SIGMERGE),
    ("sigmerge: trace_index keeps more than 64 services", "src/sigmerge.rs",
     "        if f.services.len() > MAX_INDEX_SERVICES {", "        if f.services.len() > MAX_INDEX_SERVICES + 100 {", SIGMERGE),
    ("tokens: a token filter that misses 4-byte tokens", "src/tokens.rs",
     "        if e - s < MIN_TOKEN_BYTES {\n            continue;\n        }\n        let t = cut(&b[s..e]);", "        if e - s <= MIN_TOKEN_BYTES {\n            continue;\n        }\n        let t = cut(&b[s..e]);", SIGMERGE),
    ("tokens: a token filter that misses the metadata values' tokens", "src/logs.rs",
     "                for (_, v) in &r.row.metadata {\n                    t.add_text(gi, v);\n                }\n", "", SIGMERGE),
    ("tokens: a token filter that misses a row group's tokens (the last row of each group)", "src/logs.rs",
     "        for r in g {\n            let id = streams[r.stream].stream.stream_id;", "        for r in &g[..g.len() - 1] {\n            let id = streams[r.stream].stream.stream_id;", SIGMERGE),
    ("tokens: a literal implies its edge runs (prunes a group holding a longer run)", "src/tokens.rs",
     "        if s == 0 || e == b.len() || e - s < MIN_TOKEN_BYTES {", "        if e - s < MIN_TOKEN_BYTES {", SIGMERGE),
    ("tokens: the filter's bitsets one row group off", "src/tokens.rs",
     "        self.bits[k * self.stride + rg / 8] |= 1 << (rg % 8);\n        self.slots[i] = k as u32 + 1;", "        self.bits[k * self.stride + (rg + 1) / 8] |= 1 << ((rg + 1) % 8);\n        self.slots[i] = k as u32 + 1;", SIGMERGE),
    ("tokens: foot starts at the last row group even with a filter", "src/logs.rs",
     "            Some((o, l)) => foot(o + l, file_len),", "            Some(_) => foot(self.groups_end, file_len),", SIGMERGE),
]

def tests_fail(targets=None):
    """Returns (status, failing test names); status is 'pass', 'fail' or 'nobuild'."""
    env = dict(os.environ, CARGO_TARGET_DIR=os.path.join(ROOT, "target"))
    which = targets if targets else ["--tests"]
    p = subprocess.run(["cargo", "test", "-j", "2", "--no-fail-fast"] + which + ["--", "--test-threads", "2"], cwd=ROOT, env=env, capture_output=True, text=True)
    if "could not compile" in p.stderr:
        return "nobuild", []
    failed = sorted({l.split()[1] for l in p.stdout.splitlines() if l.startswith("test ") and l.rstrip().endswith("FAILED")})
    if p.returncode == 0:
        return "pass", []
    return "fail", failed or ["(test binary aborted)"]

def digest(rel):
    return hashlib.sha256(open(os.path.join(SHARED, rel), "rb").read()).hexdigest()

def main():
    only = sys.argv[1:]
    chosen = [m for m in MUTANTS if not only or any(o in m[0] for o in only)]
    start = {m[1]: digest(m[1]) for m in chosen}
    targets = sorted({tuple(m[4]) if len(m) > 4 else () for m in chosen})
    for t in targets:
        status, which = tests_fail(list(t))
        print(f"baseline (no mutation) {' '.join(t) or 'all tests'}: {status}", flush=True)
        if status != "pass":
            print("the unmutated suite must pass first:", which)
            sys.exit(2)
    bad = 0
    for m in chosen:
        name, rel, old, new = m[:4]
        path = os.path.join(ROOT, rel)
        src = open(path).read()
        if src.count(old) != 1:
            print(f"STALE     {name}: pattern occurs {src.count(old)} times in {rel}")
            bad += 1
            continue
        try:
            open(path, "w").write(src.replace(old, new))
            status, which = tests_fail(m[4] if len(m) > 4 else None)
        finally:
            open(path, "w").write(src)
        label = {"fail": "KILLED  ", "pass": "SURVIVED", "nobuild": "NOBUILD "}[status]
        print(f"{label}  {name}  [{rel}]" + (f"  failing: {', '.join(which)}" if which else ""), flush=True)
        bad += 0 if status == "fail" else 1
    changed = [rel for rel, h in start.items() if digest(rel) != h]
    print("shared tree untouched" if not changed else f"WARNING: the shared tree's {changed} changed during the run (someone else's edit?)")
    # The copy and its target directory run to gigabytes on a shared disk: delete them.
    shutil.rmtree(os.path.dirname(ROOT), ignore_errors=True)
    print(f"scratch copy {os.path.dirname(ROOT)} deleted")
    sys.exit(1 if bad else 0)

main()
