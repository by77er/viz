//! The stage-2 end-to-end read-back (stack/README.md, "Traces and logs end to end"): the files
//! the REAL write path made of an OTLP corpus (edge → shard → flush → ledger, in workerd: the
//! stack test `test/signals.test.ts` driven by `tools/signals_readback.mjs`), read back by
//! viz-storage's readers and through the engines' read seams.
//!
//!   signals-readback CORPUS EXPORT [COMPACTED]
//!
//! COMPACTED (optional) is a second export of the same tenant's live files after compaction ran
//! to the end (contracts/TRACES.md and LOGS.md, "Compaction"): checked the same way (each file is
//! a unit of its own, ranked by its precedence), except that a merged `trace_index` file is not
//! compared with spans of its own unit; instead every trace's merged fragments must equal those of
//! EXPORT, and every TraceQL and LogQL answer must be byte-identical to the one over EXPORT (and
//! LogQL's again with row groups pruned by the outputs' token filters, LOGS.md §6).
//!
//! CORPUS is what `edge/scripts/otel-corpus.mjs … --requests` wrote (the requests that were sent,
//! the batches edge's decoders make of them, and the expected logical rows computed by the
//! generator from its model). EXPORT holds the ledger's live `spans`, `trace_index` and `logs`
//! files after the stack flushed everything, and `manifest.json`: each file with its table, day,
//! hour, flush unit and the ledger's precedence (units listed in precedence order).
//!
//! The checks are engine/storage/readback's (this file started as a copy of it, Apache-2.0, same
//! repository), with its step 1 (flushing the batches itself) replaced by reading what the stack
//! flushed:
//!
//! 1. every edge batch of the corpus decodes strictly and re-encodes to the same bytes;
//! 2. every file read back with viz-storage's readers, duplicates resolved across units by the
//!    ledger's precedence, equals the expected rows exactly;
//! 3. each unit's `trace_index` equals what its spans say, and merged fragments equal summaries
//!    computed from every span (over-counting only where a span is in two units);
//! 4. TraceQL and LogQL queries through the engines' read seams (`SpanSource`, `LogSource`) over
//!    the files give byte-identical JSON to the engines' in-memory sources built from the
//!    expected rows; the log source over files with pruning by index fragment on and off.
//!
//! Exit status 0 only if every check passed. A test tool, never shipped.
use serde_json::{json, Value as J};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use viz_logql::{LogSource, MatchOp};
use viz_storage::otel::Value;
use viz_storage::{merge_fragments, read_logs, read_logs_row_groups, read_spans, read_trace_index, Fragment, LogRecord, SignalFile, SignalTable, SpanRecord};
use viz_traceql::{AttrValue, Kind, Status};

#[derive(Default)]
struct Report {
    checks: u64,
    failures: Vec<String>,
}

impl Report {
    fn check(&mut self, ok: bool, what: impl FnOnce() -> String) {
        self.checks += 1;
        if !ok && self.failures.len() < 50 {
            self.failures.push(what());
        } else if !ok {
            self.failures.push(String::new());
        }
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex<const N: usize>(s: &str) -> [u8; N] {
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: signals-readback CORPUS EXPORT [COMPACTED]");
        std::process::exit(2);
    }
    let corpus = Path::new(&args[1]);
    let export = Path::new(&args[2]);
    let compacted = args.get(3).map(Path::new);
    let mut names: Vec<_> = fs::read_dir(corpus.join("batches")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    let load = |prefix: &str| -> Vec<Vec<u8>> { names.iter().filter(|n| n.starts_with(prefix)).map(|n| fs::read(corpus.join("batches").join(n)).unwrap()).collect() };
    let (span_batches, log_batches) = (load("spans-"), load("logs-"));

    let mut rep = Report::default();
    // Edge's batches decode strictly here and re-encode to the same bytes.
    for b in &span_batches {
        let d = viz_storage::otel::decode_spans(b);
        rep.check(d.as_ref().is_ok_and(|d| viz_storage::otel::encode_spans(&d.entries, &d.rows).as_deref() == Ok(b.as_slice())), || format!("span batch does not round-trip: {:?}", d.err()));
    }
    for b in &log_batches {
        let d = viz_storage::otel::decode_logs(b);
        rep.check(d.as_ref().is_ok_and(|d| viz_storage::otel::encode_logs(&d.streams, &d.rows).as_deref() == Ok(b.as_slice())), || format!("log batch does not round-trip: {:?}", d.err()));
    }
    let expected_spans = jsonl(&corpus.join("expected").join("spans.jsonl"));
    let expected_logs = jsonl(&corpus.join("expected").join("logs.jsonl"));
    let flushed = check_export(&mut rep, export, &expected_spans, &expected_logs, false);
    let mut summary = flushed.summary.clone();
    summary["batches"] = json!({"spans": span_batches.len(), "logs": log_batches.len()});
    if let Some(dir) = compacted {
        let after = check_export(&mut rep, dir, &expected_spans, &expected_logs, true);
        // Before and after compaction: the same answer to every query, the same merged fragments.
        let same = |a: &[String], b: &[String]| a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x == y);
        rep.check(same(&flushed.traceql, &after.traceql), || "TraceQL answers differ before and after compaction".into());
        rep.check(same(&flushed.logql, &after.logql), || "LogQL answers differ before and after compaction".into());
        let identical_tq = flushed.traceql.iter().zip(&after.traceql).filter(|(a, b)| a == b).count();
        let identical_lq = flushed.logql.iter().zip(&after.logql).filter(|(a, b)| a == b).count();
        let mut frag_diff = 0;
        for (t, f) in &flushed.fragments {
            let ok = after.fragments.get(t) == Some(f);
            frag_diff += !ok as usize;
            rep.check(ok, || format!("trace {}: merged fragments {:?} before compaction, {:?} after", hex(t), f, after.fragments.get(t)));
        }
        rep.check(after.fragments.len() == flushed.fragments.len(), || format!("{} traces in trace_index before compaction, {} after", flushed.fragments.len(), after.fragments.len()));
        summary["compacted"] = after.summary;
        summary["before_vs_after"] = json!({
            "traceql_identical": identical_tq, "traceql_of": flushed.traceql.len(),
            "logql_identical": identical_lq, "logql_of": flushed.logql.len(),
            "traces": flushed.fragments.len(), "merged_fragments_differing": frag_diff,
        });
    }
    summary["checks"] = json!(rep.checks);
    summary["failures"] = json!(rep.failures.len());
    println!("{summary}");
    for f in rep.failures.iter().filter(|f| !f.is_empty()) {
        println!("FAIL {f}");
    }
    std::process::exit(if rep.failures.is_empty() { 0 } else { 1 });
}

/// What one export holds, for comparing two of them.
struct Checked {
    summary: J,
    traceql: Vec<String>,
    logql: Vec<String>,
    /// Every trace's `trace_index` rows merged (in precedence order).
    fragments: BTreeMap<[u8; 16], Fragment>,
}

/// The checks of the module documentation over one export. `compacted`: its files are
/// compaction outputs (no per-unit `trace_index` check).
fn check_export(rep: &mut Report, export: &Path, expected_spans: &[J], expected_logs: &[J], compacted: bool) -> Checked {
    // 1. The units the stack's flush wrote, in the ledger's precedence order.
    let manifest: Vec<J> = serde_json::from_str(&fs::read_to_string(export.join("manifest.json")).unwrap()).unwrap();
    let mut by_unit: BTreeMap<u64, Vec<SignalFile>> = BTreeMap::new();
    for m in &manifest {
        let table = match m["table"].as_str().unwrap() {
            "spans" => SignalTable::Spans,
            "trace_index" => SignalTable::TraceIndex,
            "logs" => SignalTable::Logs,
            other => panic!("unknown table {other}"),
        };
        let f = SignalFile {
            table,
            day: m["day"].as_str().unwrap().to_string(),
            hour: m["hour"].as_u64().map(|h| h as u8),
            bytes: fs::read(export.join(m["path"].as_str().unwrap())).unwrap(),
            rows: m["rows"].as_u64().unwrap(),
            min_ts: 0,
            max_ts: 0,
            index: m["index"].as_str().unwrap().to_string(),
        };
        // `unit`: the flush unit's rank in the ledger's precedence order (the manifest's writer
        // ranks units by the ledger version that admitted them).
        by_unit.entry(m["unit"].as_u64().unwrap()).or_default().push(f);
    }
    let units = by_unit.len();
    let (span_units, log_units): (Vec<Vec<SignalFile>>, Vec<Vec<SignalFile>>) = by_unit.into_values().partition(|u| u.iter().all(|f| f.table != SignalTable::Logs));
    let encode_ms = 0u128;

    // 2 and 3. Spans and trace_index.
    let read_units: Vec<Vec<SpanRecord>> = span_units.iter().map(|u| u.iter().filter(|f| f.table == SignalTable::Spans).flat_map(|f| read_spans(&f.bytes).unwrap()).collect()).collect();
    let spans = check_spans(rep, expected_spans, &read_units);
    let index_stats = if compacted { json!("not per unit: merged files") } else { check_trace_index(rep, &span_units, &read_units, &spans) };
    let mut fragments: BTreeMap<[u8; 16], Vec<Fragment>> = BTreeMap::new();
    for u in &span_units {
        for f in u.iter().filter(|f| f.table == SignalTable::TraceIndex) {
            for x in read_trace_index(&f.bytes).unwrap() {
                fragments.entry(x.trace_id).or_default().push(x);
            }
        }
    }
    // Later units first: a root claimed by two fragments (a span in two units) is the later one's,
    // as compaction merges it (contracts/TRACES.md, "Compaction").
    let fragments: BTreeMap<[u8; 16], Fragment> = fragments.into_iter().map(|(t, mut v)| {
        v.reverse();
        (t, merge_fragments(&v).unwrap())
    }).collect();

    // 2. Logs.
    let log_files: Vec<(Vec<u8>, String)> = log_units.iter().flatten().map(|f| (f.bytes.clone(), f.index.clone())).collect();
    let logs = check_logs(rep, expected_logs, &log_units);

    // 4. Engines.
    let (tq, traceql_answers) = traceql(rep, expected_spans, &spans);
    let (lq, logql_answers) = logql(rep, expected_logs, &log_files);
    let _ = logs;

    let files: usize = span_units.iter().chain(&log_units).map(Vec::len).sum();
    let summary = json!({
        "units": units, "files": files, "encode_ms": encode_ms as u64,
        "spans": spans.len(), "logs": expected_logs.len(),
        "trace_index": index_stats, "traceql": tq, "logql": lq,
    });
    Checked { summary, traceql: traceql_answers, logql: logql_answers, fragments }
}

fn jsonl(p: &Path) -> Vec<J> {
    fs::read_to_string(p).unwrap().lines().filter(|l| !l.is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

// ───────────────────────────── spans ─────────────────────────────

fn typed_json(attrs: &[viz_storage::otel::Attr<String>]) -> J {
    J::Array(
        attrs
            .iter()
            .map(|a| match &a.value {
                Value::Str(s) => json!([a.key, "s", s]),
                Value::Int(i) => json!([a.key, "i", i.to_string()]),
                Value::Double(b) => json!([a.key, "d", format!("{b:x}")]),
                Value::Bool(b) => json!([a.key, "b", b.to_string()]),
                Value::Other(o) => json!([a.key, "o", o]),
            })
            .collect(),
    )
}

fn span_json(r: &SpanRecord) -> J {
    json!({
        "trace_id": hex(&r.trace_id), "span_id": hex(&r.span_id), "parent_span_id": r.parent_span_id.map(|p| hex(&p)),
        "trace_state": r.trace_state.clone().unwrap_or_default(), "flags": r.flags.map_or(0, |f| f as u32),
        "start": r.start_unix_nano.to_string(), "end": r.end_unix_nano.to_string(), "kind": r.span_kind, "status": r.status_code,
        "status_message": r.status_message.clone().unwrap_or_default(), "name": r.span_name,
        "resource_fp": r.resource_fp.to_string(), "resource": typed_json(&r.resource), "attrs": typed_json(&r.attrs),
        "scope_name": r.scope_name.clone().unwrap_or_default(), "scope_version": r.scope_version.clone().unwrap_or_default(),
        "scope_attrs": r.scope_attrs.clone().unwrap_or_default(),
        "events": r.events.iter().map(|e| json!([e.time_unix_nano.to_string(), e.name, e.attrs])).collect::<Vec<_>>(),
        "links": r.links.iter().map(|l| json!([hex(&l.trace_id), hex(&l.span_id), l.trace_state, l.attrs])).collect::<Vec<_>>(),
        "dropped": r.dropped.iter().map(|d| d.unwrap_or(0)).collect::<Vec<_>>(),
    })
}

/// Rows of every unit, later unit winning on (trace_id, span_id); checked against `expected`.
fn check_spans(rep: &mut Report, expected: &[J], units: &[Vec<SpanRecord>]) -> Vec<SpanRecord> {
    let mut by: BTreeMap<([u8; 16], [u8; 8]), SpanRecord> = BTreeMap::new();
    for u in units {
        let mut seen = BTreeSet::new();
        for r in u {
            rep.check(seen.insert((r.trace_id, r.span_id)), || format!("span {} twice in one unit", hex(&r.span_id)));
            rep.check(r.duration_nano == r.end_unix_nano - r.start_unix_nano, || "duration".into());
            rep.check(r.start_time_us == r.start_unix_nano.div_euclid(1000), || "start_time".into());
            let svc = r.resource.iter().find(|a| a.key == "service.name").and_then(|a| if let Value::Str(s) = &a.value { Some(s.clone()) } else { None });
            rep.check(r.service_name == svc, || "service_name column".into());
            by.insert((r.trace_id, r.span_id), r.clone());
        }
    }
    let want: HashMap<String, &J> = expected.iter().map(|j| (format!("{}/{}", j["trace_id"].as_str().unwrap(), j["span_id"].as_str().unwrap()), j)).collect();
    rep.check(by.len() == want.len(), || format!("{} spans read, {} expected", by.len(), want.len()));
    for r in by.values() {
        let got = span_json(r);
        let k = format!("{}/{}", hex(&r.trace_id), hex(&r.span_id));
        match want.get(&k) {
            Some(w) => rep.check(&got == *w, || format!("span {k}: read {got} expected {w}")),
            None => rep.check(false, || format!("span {k} read but not expected")),
        }
    }
    by.into_values().collect()
}

/// `trace_index` fragments recomputed from spans (contracts/TRACES.md), independently of `spans.rs`.
fn fragments_of(spans: &[&SpanRecord]) -> Vec<Fragment> {
    let mut by: BTreeMap<[u8; 16], Vec<&SpanRecord>> = BTreeMap::new();
    for s in spans {
        by.entry(s.trace_id).or_default().push(s);
    }
    by.into_iter()
        .map(|(t, v)| {
            let root = v.iter().filter(|s| s.parent_span_id.is_none()).min_by_key(|s| (s.start_unix_nano, s.span_id));
            let mut svc: BTreeMap<Vec<u8>, (String, i32, i32)> = BTreeMap::new();
            for s in &v {
                let n = s.service_name.clone().unwrap_or_default();
                let e = svc.entry(n.as_bytes().to_vec()).or_insert((n, 0, 0));
                e.1 += 1;
                e.2 += (s.status_code == 2) as i32;
            }
            let mut services: Vec<(String, i32, i32)> = svc.into_values().collect();
            let truncated = services.len() > 64;
            if truncated {
                services.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.as_bytes().cmp(b.0.as_bytes())));
                services.truncate(64);
                services.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            }
            let hours: BTreeSet<i32> = v.iter().map(|s| s.start_unix_nano.div_euclid(3_600_000_000_000) as i32).collect();
            Fragment {
                trace_id: t,
                min_start: v.iter().map(|s| s.start_unix_nano).min().unwrap(),
                max_end: v.iter().map(|s| s.end_unix_nano).max().unwrap(),
                span_count: v.len() as i32,
                error_count: v.iter().filter(|s| s.status_code == 2).count() as i32,
                root: root.map(|s| (s.service_name.clone(), s.span_name.clone(), s.start_unix_nano, s.span_id)),
                services,
                services_truncated: truncated,
                hours: hours.into_iter().collect(),
            }
        })
        .collect()
}

fn check_trace_index(rep: &mut Report, units: &[Vec<SignalFile>], spans: &[Vec<SpanRecord>], all: &[SpanRecord]) -> J {
    let mut per_trace: HashMap<[u8; 16], Vec<Fragment>> = HashMap::new();
    let mut unit_of: HashMap<([u8; 16], [u8; 8]), BTreeSet<usize>> = HashMap::new();
    for (u, files) in units.iter().enumerate() {
        let mut got: Vec<Fragment> = files.iter().filter(|f| f.table == SignalTable::TraceIndex).flat_map(|f| read_trace_index(&f.bytes).unwrap()).collect();
        got.sort_by_key(|f| f.trace_id);
        let want = fragments_of(&spans[u].iter().collect::<Vec<_>>());
        rep.check(got == want, || format!("unit {u}: trace_index differs from its spans ({} vs {} rows)", got.len(), want.len()));
        for f in got {
            per_trace.entry(f.trace_id).or_default().push(f);
        }
        for s in &spans[u] {
            unit_of.entry((s.trace_id, s.span_id)).or_default().insert(u);
        }
    }
    // Merged fragments against one fragment of every (deduplicated) span.
    let truth = fragments_of(&all.iter().collect::<Vec<_>>());
    let (mut equal, mut differ_dup, mut differ_other) = (0, 0, 0);
    for t in &truth {
        let merged = merge_fragments(&per_trace[&t.trace_id]).unwrap();
        if &merged == t {
            equal += 1;
        } else if all.iter().any(|s| s.trace_id == t.trace_id && unit_of[&(s.trace_id, s.span_id)].len() > 1) {
            // A span stored in two units (a retry split differently) is counted in both fragments.
            differ_dup += 1;
            rep.check(merged.span_count > t.span_count, || "a duplicate should only over-count".into());
        } else {
            differ_other += 1;
            rep.check(false, || format!("trace {}: merged fragments {merged:?} differ from its spans {t:?}", hex(&t.trace_id)));
        }
    }
    json!({"traces": truth.len(), "merged_equal": equal, "merged_overcount_by_cross_unit_duplicates": differ_dup, "merged_wrong": differ_other})
}

// ───────────────────────────── logs ─────────────────────────────

fn log_json(r: &LogRecord) -> J {
    json!({
        "stream_id": r.stream_id.to_string(), "labels": r.labels, "ts": r.ts.to_string(), "observed_ts": r.observed_ts.unwrap_or(0).to_string(),
        "trace_id": r.trace_id.map_or("0".repeat(32), |t| hex(&t)), "span_id": r.span_id.map_or("0".repeat(16), |t| hex(&t)),
        "flags": r.flags.map_or(0, |f| f as u32), "severity_number": r.severity_number.unwrap_or(0), "severity_text": r.severity_text.clone().unwrap_or_default(),
        "line": r.line, "metadata": r.metadata,
    })
}

fn log_key(j: &J) -> String {
    serde_json::to_string(&json!([j["stream_id"], j["ts"], j["line"], j["metadata"]])).unwrap()
}

fn check_logs(rep: &mut Report, expected: &[J], units: &[Vec<SignalFile>]) -> usize {
    let mut by: BTreeMap<String, J> = BTreeMap::new();
    for files in units {
        for f in files {
            let rows = read_logs(&f.bytes).unwrap();
            for w in rows.windows(2) {
                let k = |r: &LogRecord| (r.service_name.clone().into_bytes(), r.stream_id, r.ts, r.line.clone().into_bytes(), r.metadata.clone());
                rep.check(k(&w[0]) < k(&w[1]), || format!("logs out of order or duplicated in {}", f.day));
            }
            for r in rows {
                rep.check(r.service_name == r.labels.iter().find(|(n, _)| n == "service_name").map_or(String::new(), |(_, v)| v.clone()), || "service_name column".into());
                rep.check(viz_storage::json::labels_to_json(&r.labels) == r.labels_json, || "labels cell".into());
                rep.check(viz_storage::otel::stream_id(&r.labels) == r.stream_id, || "stream_id".into());
                let j = log_json(&r);
                by.insert(log_key(&j), j);
            }
        }
    }
    let want: HashMap<String, &J> = expected.iter().map(|j| (log_key(j), j)).collect();
    rep.check(by.len() == want.len(), || format!("{} log rows read, {} expected", by.len(), want.len()));
    for (k, got) in &by {
        match want.get(k) {
            Some(w) => rep.check(got == *w, || format!("log row: read {got} expected {w}")),
            None => rep.check(false, || format!("log row {k} read but not expected")),
        }
    }
    by.len()
}

// ───────────────────────────── TraceQL ─────────────────────────────

/// The engine's value of an "other" (canonical OTLP JSON): homogeneous arrays become typed
/// arrays (contracts/TRACES.md, "Logical view"), anything else stays JSON.
fn other_to_av(raw: &str) -> AttrValue {
    let v: J = serde_json::from_str(raw).unwrap();
    any_to_av(&v, raw)
}

fn dbl(v: &J) -> Option<f64> {
    match v {
        J::Number(n) => n.as_f64(),
        J::String(s) if s == "NaN" => Some(f64::NAN),
        J::String(s) if s == "Infinity" => Some(f64::INFINITY),
        J::String(s) if s == "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

fn any_to_av(v: &J, raw: &str) -> AttrValue {
    if let Some(s) = v.get("stringValue").and_then(J::as_str) {
        return AttrValue::Str(s.to_string());
    }
    if let Some(s) = v.get("intValue").and_then(J::as_str) {
        return AttrValue::Int(s.parse().unwrap());
    }
    if let Some(d) = v.get("doubleValue").and_then(dbl) {
        return AttrValue::Float(d);
    }
    if let Some(b) = v.get("boolValue").and_then(J::as_bool) {
        return AttrValue::Bool(b);
    }
    if let Some(a) = v.get("arrayValue") {
        let items: Vec<J> = a.get("values").and_then(J::as_array).cloned().unwrap_or_default();
        let all = |k: &str| items.iter().all(|x| x.get(k).is_some());
        if items.is_empty() {
            return AttrValue::StrArray(Vec::new());
        }
        if all("stringValue") {
            return AttrValue::StrArray(items.iter().map(|x| x["stringValue"].as_str().unwrap().to_string()).collect());
        }
        if all("intValue") {
            return AttrValue::IntArray(items.iter().map(|x| x["intValue"].as_str().unwrap().parse().unwrap()).collect());
        }
        if all("doubleValue") {
            return AttrValue::FloatArray(items.iter().map(|x| dbl(&x["doubleValue"]).unwrap()).collect());
        }
        if all("boolValue") {
            return AttrValue::BoolArray(items.iter().map(|x| x["boolValue"].as_bool().unwrap()).collect());
        }
    }
    AttrValue::Other(raw.to_string())
}

fn kv_list(raw: &str) -> Vec<(String, AttrValue)> {
    if raw.is_empty() {
        return Vec::new();
    }
    let v: J = serde_json::from_str(raw).unwrap();
    v.as_array().unwrap().iter().map(|kv| (kv["key"].as_str().unwrap().to_string(), any_to_av(&kv["value"], &kv["value"].to_string()))).collect()
}

fn av(v: &Value<String>) -> AttrValue {
    match v {
        Value::Str(s) => AttrValue::Str(s.clone()),
        Value::Int(i) => AttrValue::Int(*i),
        Value::Double(b) => AttrValue::Float(f64::from_bits(*b)),
        Value::Bool(b) => AttrValue::Bool(*b),
        Value::Other(o) => other_to_av(o),
    }
}

/// The engine's span from a row read from Parquet.
fn tspan_from_record(r: &SpanRecord) -> viz_traceql::Span {
    viz_traceql::Span {
        span_id: r.span_id,
        parent_span_id: r.parent_span_id,
        name: r.span_name.clone(),
        kind: Kind::from_otlp(r.span_kind),
        status: Status::from_otlp(r.status_code),
        status_message: r.status_message.clone().unwrap_or_default(),
        start_unix_nano: r.start_unix_nano as u64,
        end_unix_nano: r.end_unix_nano as u64,
        resource: r.resource.iter().map(|a| (a.key.clone(), av(&a.value))).collect(),
        attrs: r.attrs.iter().map(|a| (a.key.clone(), av(&a.value))).collect(),
        scope_name: r.scope_name.clone().unwrap_or_default(),
        scope_version: r.scope_version.clone().unwrap_or_default(),
        scope_attrs: kv_list(r.scope_attrs.as_deref().unwrap_or("")),
        events: r.events.iter().map(|e| viz_traceql::Event { time_unix_nano: e.time_unix_nano as u64, name: e.name.clone(), attrs: kv_list(&e.attrs) }).collect(),
        links: r.links.iter().map(|l| viz_traceql::Link { trace_id: l.trace_id, span_id: l.span_id, trace_state: l.trace_state.clone(), attrs: kv_list(&l.attrs) }).collect(),
    }
}

fn typed_from_json(j: &J) -> Vec<(String, AttrValue)> {
    j.as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let (k, ty, v) = (t[0].as_str().unwrap(), t[1].as_str().unwrap(), t[2].as_str().unwrap());
            let val = match ty {
                "s" => AttrValue::Str(v.to_string()),
                "i" => AttrValue::Int(v.parse().unwrap()),
                "d" => AttrValue::Float(f64::from_bits(u64::from_str_radix(v, 16).unwrap())),
                "b" => AttrValue::Bool(v == "true"),
                _ => other_to_av(v),
            };
            (k.to_string(), val)
        })
        .collect()
}

/// The engine's span from an expected row (the generator's model), by another path.
fn tspan_from_json(j: &J) -> ([u8; 16], viz_traceql::Span) {
    let s = |k: &str| j[k].as_str().unwrap().to_string();
    let n = |k: &str| j[k].as_i64().unwrap() as i32;
    (
        unhex::<16>(&s("trace_id")),
        viz_traceql::Span {
            span_id: unhex::<8>(&s("span_id")),
            parent_span_id: j["parent_span_id"].as_str().map(unhex::<8>),
            name: s("name"),
            kind: Kind::from_otlp(n("kind")),
            status: Status::from_otlp(n("status")),
            status_message: s("status_message"),
            start_unix_nano: s("start").parse().unwrap(),
            end_unix_nano: s("end").parse().unwrap(),
            resource: typed_from_json(&j["resource"]),
            attrs: typed_from_json(&j["attrs"]),
            scope_name: s("scope_name"),
            scope_version: s("scope_version"),
            scope_attrs: kv_list(&s("scope_attrs")),
            events: j["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| viz_traceql::Event { time_unix_nano: e[0].as_str().unwrap().parse().unwrap(), name: e[1].as_str().unwrap().into(), attrs: kv_list(e[2].as_str().unwrap()) })
                .collect(),
            links: j["links"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| viz_traceql::Link { trace_id: unhex::<16>(l[0].as_str().unwrap()), span_id: unhex::<8>(l[1].as_str().unwrap()), trace_state: l[2].as_str().unwrap().into(), attrs: kv_list(l[3].as_str().unwrap()) })
                .collect(),
        },
    )
}

fn traces(spans: Vec<([u8; 16], viz_traceql::Span)>) -> Vec<viz_traceql::Trace> {
    let mut by: BTreeMap<[u8; 16], Vec<viz_traceql::Span>> = BTreeMap::new();
    for (t, s) in spans {
        by.entry(t).or_default().push(s);
    }
    by.into_iter()
        .map(|(t, mut v)| {
            v.sort_by_key(|s| (s.start_unix_nano, s.span_id));
            viz_traceql::Trace::new(t, v)
        })
        .collect()
}

const TRACEQL_SEARCH: &[&str] = &[
    "{ }",
    "{ status = error }",
    "{ resource.service.name = \"checkout\" }",
    "{ resource.service.name = \"Zürich-svc\" && kind = client }",
    "{ span.http.response.status_code >= 500 }",
    "{ .http.request.method = \"GET\" && duration > 50ms }",
    "{ name =~ \"GET .*\" }",
    "{ kind = server } >> { kind = client }",
    "{ resource.service.name = \"frontend\" } > { status = error }",
    "{ } | count() > 3",
    "{ resource.deployment.environment.name = \"prod\" } | avg(duration) > 10ms",
    "{ span.db.system.name != nil }",
    "{ event:name = \"exception\" }",
    "{ link:traceID != nil }",
    "{ span.retry = true }",
    "{ span.viz.clamped_end = true }",
    "{ resource.service.name = \"\" }",
    "{ span.http.route = \"/ünïcode\" } | select(resource.k8s.pod.name, span.error.type)",
    "{ span:childCount > 2 }",
    "{ trace:rootService = \"frontend\" && trace:duration > 1s }",
    "{ span.error.type = \"Bad état\" } | by(resource.service.name) | count() > 0",
    "{ instrumentation:name = \"io.opentelemetry.db\" && instrumentation.scope.k = 7 }",
    "{ resource.process.pid = 4242 }",
    "{ span.team != nil }",
];
const TRACEQL_METRICS: &[&str] = &[
    "{ } | rate() by (resource.service.name)",
    "{ status = error } | count_over_time() by (span.error.type)",
    "{ } | quantile_over_time(duration, .5, .9, .99) by (span.http.route)",
    "{ kind = server } | avg_over_time(span.http.response.status_code) by (resource.service.name)",
    "{ } | histogram_over_time(duration)",
    "{ span.http.response.status_code >= 400 } | rate() by (span.http.response.status_code) | topk(3)",
];

fn traceql(rep: &mut Report, expected: &[J], read: &[SpanRecord]) -> (J, Vec<String>) {
    let mem = viz_traceql::MemSource::new(traces(expected.iter().map(tspan_from_json).collect()));
    let files = traces(read.iter().map(|r| (r.trace_id, tspan_from_record(r))).collect());
    let file_src = viz_traceql::MemSource::new(files.clone());
    let pruned = viz_traceql::MemSource::new(files).pruning(true);
    let starts = read.iter().map(|r| r.start_unix_nano as u64);
    let (lo, hi) = (starts.clone().min().unwrap(), starts.max().unwrap());
    let step = 60_000_000_000u64;
    let (start, end) = (lo / step * step, (hi / step + 2) * step);
    let req = viz_traceql::SearchRequest { limit: 1_000_000, spans_per_spanset: 1_000, start_unix_nano: 0, end_unix_nano: 0 };
    let (mut nonempty, mut equal) = (0, 0);
    let mut answers = Vec::new();
    // Statistics count what the source returned, which pruning changes by design; the
    // engine's own pruning tests compare without them too.
    let search = |src: &viz_traceql::MemSource, q: &str, stats: bool| {
        let r = viz_traceql::search(src, q, &req).unwrap_or_else(|e| panic!("{q}: {e:?}"));
        if stats { r.to_json() } else { viz_traceql::SearchResponse { stats: Default::default(), ..r }.to_json() }
    };
    let range = viz_traceql::RangeRequest::range(start, end, step);
    let metrics = |src: &viz_traceql::MemSource, q: &str, stats: bool| {
        let r = viz_traceql::query_range(src, q, &range).unwrap_or_else(|e| panic!("{q}: {e:?}"));
        if stats { r.to_json() } else { viz_traceql::MetricsResponse { stats: Default::default(), ..r }.to_json() }
    };
    for (q, metric) in TRACEQL_SEARCH.iter().map(|q| (q, false)).chain(TRACEQL_METRICS.iter().map(|q| (q, true))) {
        let run = |src: &viz_traceql::MemSource, stats: bool| if metric { metrics(src, q, stats) } else { search(src, q, stats) };
        let a = run(&mem, true);
        let b = run(&file_src, true);
        rep.check(a == b, || format!("TraceQL {q} (files): {} vs {} bytes", a.len(), b.len()));
        answers.push(b.clone());
        let (a0, c0) = (run(&mem, false), run(&pruned, false));
        rep.check(a0 == c0, || format!("TraceQL {q} (files, pruned): {} vs {} bytes", a0.len(), c0.len()));
        equal += (a == b) as u32 + (a0 == c0) as u32;
        nonempty += if metric { a.contains("\"samples\"") } else { !a.contains("\"traces\":[]") } as u32;
    }
    (json!({"queries": TRACEQL_SEARCH.len() + TRACEQL_METRICS.len(), "answers_compared": 2 * (TRACEQL_SEARCH.len() + TRACEQL_METRICS.len()), "identical": equal, "nonempty": nonempty}), answers)
}

// ───────────────────────────── LogQL ─────────────────────────────

/// What LogQL sees as a row's structured metadata (contracts/LOGS.md §3).
fn logql_metadata(md: &[(String, String)], trace_id: Option<String>, span_id: Option<String>, sev_text: Option<String>, sev: Option<i32>, observed: Option<i64>, flags: Option<i32>) -> Vec<(String, String)> {
    let mut m: BTreeMap<String, String> = BTreeMap::new();
    let mut put = |k: &str, v: Option<String>| {
        if let Some(v) = v {
            m.insert(k.to_string(), v);
        }
    };
    put("trace_id", trace_id);
    put("span_id", span_id);
    put("severity_text", sev_text);
    put("severity_number", sev.map(|x| x.to_string()));
    put("observed_timestamp", observed.map(|x| x.to_string()));
    put("flags", flags.map(|x| (x as u32).to_string()));
    for (k, v) in md {
        m.insert(k.clone(), v.clone());
    }
    let mut out: Vec<(String, String)> = m.into_iter().collect();
    out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    out
}

fn stream_rows_sorted(mut rows: Vec<viz_logql::LogRow>) -> Vec<viz_logql::LogRow> {
    rows.sort_by(|a, b| (a.ts_ns, a.line.as_bytes()).cmp(&(b.ts_ns, b.line.as_bytes())).then_with(|| a.metadata.cmp(&b.metadata)));
    rows
}

fn mem_logs(expected: &[J]) -> viz_logql::MemSource {
    let mut by: BTreeMap<Vec<(String, String)>, Vec<viz_logql::LogRow>> = BTreeMap::new();
    for j in expected {
        let labels: Vec<(String, String)> = serde_json::from_value(j["labels"].clone()).unwrap();
        let md: Vec<(String, String)> = serde_json::from_value(j["metadata"].clone()).unwrap();
        let s = |k: &str| j[k].as_str().unwrap().to_string();
        let tid = s("trace_id");
        let sid = s("span_id");
        let st = s("severity_text");
        let sev = j["severity_number"].as_i64().unwrap() as i32;
        let obs: i64 = s("observed_ts").parse().unwrap();
        let fl = j["flags"].as_i64().unwrap() as i32;
        let metadata = logql_metadata(
            &md,
            (tid != "0".repeat(32)).then_some(tid),
            (sid != "0".repeat(16)).then_some(sid),
            (!st.is_empty()).then_some(st),
            (sev != 0).then_some(sev),
            (obs != 0).then_some(obs),
            (fl != 0).then_some(fl),
        );
        by.entry(labels).or_default().push(viz_logql::LogRow { ts_ns: s("ts").parse().unwrap(), line: s("line"), metadata });
    }
    viz_logql::MemSource::new(by.into_iter().map(|(labels, rows)| viz_logql::LogStream { labels, rows: stream_rows_sorted(rows) }).collect())
}

/// A `LogSource` over `logs` files: reads the row groups a select needs (with pruning, those
/// the index fragment says can hold a matching stream in the time range), resolves
/// duplicates across files (the later file wins) and hands each stream's rows over in
/// `(ts, line)` order.
struct FileLogs {
    files: Vec<(Vec<u8>, String)>,
    prune: bool,
    /// Also skip row groups the file's token filter rules out for the request's `required`
    /// clauses (contracts/LOGS.md §6), when its fragment says where the filter is (`tok`).
    tokens: bool,
    groups_read: std::cell::Cell<u64>,
    groups_total: std::cell::Cell<u64>,
    groups_skipped_by_tokens: std::cell::Cell<u64>,
}

fn matches(ms: &[viz_logql::Matcher], labels: &[(String, String)]) -> Option<bool> {
    for m in ms {
        let v = labels.iter().find(|(n, _)| *n == m.name).map_or("", |(_, v)| v.as_str());
        let ok = match m.op {
            MatchOp::Eq => v == m.value,
            MatchOp::Ne => v != m.value,
            MatchOp::Re | MatchOp::Nre => {
                let re = regex::Regex::new(&format!("^(?s:{})$", m.value)).ok()?;
                re.is_match(v) == (m.op == MatchOp::Re)
            }
        };
        if !ok {
            return Some(false);
        }
    }
    Some(true)
}

impl FileLogs {
    fn new(files: &[(Vec<u8>, String)], prune: bool, tokens: bool) -> FileLogs {
        FileLogs { files: files.to_vec(), prune, tokens, groups_read: 0.into(), groups_total: 0.into(), groups_skipped_by_tokens: 0.into() }
    }

    fn groups(&self, bytes: &[u8], index: &str, req: &viz_logql::SelectRequest<'_>) -> Vec<usize> {
        let keep = self.groups_by_fragment(index, req);
        let ix: J = serde_json::from_str(index).unwrap();
        match ix.get("tok").and_then(J::as_array) {
            Some(t) if self.tokens && !req.required.is_empty() => {
                let (o, l) = (t[0].as_u64().unwrap() as usize, t[1].as_u64().unwrap() as usize);
                let Ok(filter) = viz_storage::tokens::TokenFilter::parse(&bytes[o..o + l]) else { return keep };
                let out: Vec<usize> = keep.iter().copied().filter(|g| filter.may_match(*g, req.required)).collect();
                self.groups_skipped_by_tokens.set(self.groups_skipped_by_tokens.get() + (keep.len() - out.len()) as u64);
                out
            }
            _ => keep,
        }
    }

    fn groups_by_fragment(&self, index: &str, req: &viz_logql::SelectRequest<'_>) -> Vec<usize> {
        let ix: J = serde_json::from_str(index).unwrap();
        let rg = ix["rg"].as_array().unwrap();
        self.groups_total.set(self.groups_total.get() + rg.len() as u64);
        if !self.prune {
            return (0..rg.len()).collect();
        }
        let overlaps = |lo: i64, hi: i64| hi >= req.start_ns && lo < req.end_ns;
        let mut keep = BTreeSet::new();
        match ix.get("streams").and_then(J::as_array) {
            Some(streams) => {
                for s in streams {
                    let labels: BTreeMap<String, String> = serde_json::from_str(s[1].as_str().unwrap()).unwrap();
                    let labels: Vec<(String, String)> = labels.into_iter().collect();
                    let (lo, hi) = (s[2].as_i64().unwrap(), s[3].as_i64().unwrap());
                    if matches(req.matchers, &labels) != Some(false) && overlaps(lo, hi) {
                        keep.extend(s[4].as_u64().unwrap() as usize..=s[5].as_u64().unwrap() as usize);
                    }
                }
            }
            None => {
                for (i, g) in rg.iter().enumerate() {
                    if overlaps(g["min_ts"].as_i64().unwrap(), g["max_ts"].as_i64().unwrap()) {
                        keep.insert(i);
                    }
                }
            }
        }
        keep.into_iter().collect()
    }
}

impl LogSource for FileLogs {
    fn select(&self, req: &viz_logql::SelectRequest<'_>, visit: &mut dyn FnMut(&[(String, String)], &viz_logql::LogRow)) -> Result<(), viz_logql::Error> {
        // (stream_id, ts, line, metadata) → (labels, row): later files overwrite earlier ones.
        let mut rows: HashMap<(i64, i64, String, Vec<(String, String)>), (Vec<(String, String)>, viz_logql::LogRow)> = HashMap::new();
        for (bytes, index) in &self.files {
            let groups = self.groups(bytes, index, req);
            self.groups_read.set(self.groups_read.get() + groups.len() as u64);
            if groups.is_empty() {
                continue;
            }
            for r in read_logs_row_groups(bytes, &groups).map_err(|e| viz_logql::Error::Source(e.to_string()))? {
                let metadata = logql_metadata(&r.metadata, r.trace_id.map(|t| hex(&t)), r.span_id.map(|t| hex(&t)), r.severity_text.clone(), r.severity_number, r.observed_ts, r.flags);
                rows.insert((r.stream_id, r.ts, r.line.clone(), r.metadata.clone()), (r.labels.clone(), viz_logql::LogRow { ts_ns: r.ts, line: r.line, metadata }));
            }
        }
        let mut by: BTreeMap<Vec<(String, String)>, Vec<viz_logql::LogRow>> = BTreeMap::new();
        for (_, (labels, row)) in rows {
            if row.ts_ns >= req.start_ns && row.ts_ns < req.end_ns {
                by.entry(labels).or_default().push(row);
            }
        }
        for (labels, rs) in by {
            for r in stream_rows_sorted(rs) {
                visit(&labels, &r);
            }
        }
        Ok(())
    }
}

const LOGQL_LOGS: &[&str] = &[
    "{service_name=\"checkout\"}",
    "{job=~\"nginx|worker\"} |= \"error\"",
    "{service_name=~\".+\"} | logfmt | status >= 500",
    "{job=\"worker\"} | json | level=\"error\"",
    "{service_name=\"payment\"} | trace_id != \"\"",
    "{env=\"prod\"} | user=\"7\"",
    "{service_name=\"unknown_service\"}",
    "{deployment_environment_name=\"prod\"} | severity_text=\"ERROR\"",
    "{service_name=~\"cart|frontend\"} | severity_text=\"RETRIED\"",
    "{job=\"Zürich\"} != \"GET\"",
    "{service_name=~\".+\"} | http_route=\"/ünïcode\"",
    "{service_name=~\".+\"} | user_tier=\"gold\" | line_format \"{{.user_id}} {{.http_route}}\"",
    // Literals with tokens strictly inside them, which a token filter can prune by (LOGS.md §6).
    "{service_name=~\".+\"} |= \"error: connection refused\"",
    "{job=~\".+\"} |= \"level=error msg=\"",
    "{service_name=~\".+\"} |= \" starting worker\"",
];
const LOGQL_METRICS: &[&str] = &[
    "count_over_time({service_name=~\".+\"}[5m])",
    "sum by (service_name) (rate({service_name=~\".+\"} |= \"GET\" [1m]))",
    "sum by (level) (count_over_time({job=~\".+\"} | logfmt [10m]))",
    "topk(3, sum by (job) (bytes_over_time({job=~\".+\"}[30m])))",
    "sum(count_over_time({service_name=~\".+\"} | severity_number=\"17\" [1h]))",
    "avg_over_time({service_name=~\".+\"} | logfmt | unwrap duration(duration) [15m]) by (service_name)",
    "sum by (service_name) (count_over_time({service_name=~\".+\"} |= \" status=500 \" [10m]))",
];

fn logql(rep: &mut Report, expected: &[J], files: &[(Vec<u8>, String)]) -> (J, Vec<String>) {
    let mem = mem_logs(expected);
    let full = FileLogs::new(files, false, false);
    let pruned = FileLogs::new(files, true, false);
    let tokens = FileLogs::new(files, true, true);
    let with_filters = files.iter().filter(|(_, ix)| ix.contains("\"tok\":[")).count();
    let mut answers = Vec::new();
    let ts: Vec<i64> = expected.iter().map(|j| j["ts"].as_str().unwrap().parse().unwrap()).collect();
    let step = 60_000_000_000i64;
    let (start, end) = (ts.iter().min().unwrap() / step * step, (ts.iter().max().unwrap() / step + 2) * step);
    let opts = viz_logql::Options { limit: 1_000_000, direction: viz_logql::Direction::Forward, ..Default::default() };
    let (mut equal, mut nonempty) = (0, 0);
    for q in LOGQL_LOGS.iter().chain(LOGQL_METRICS) {
        let a = viz_logql::query_range(&mem, q, start, end, step, &opts).unwrap_or_else(|e| panic!("{q}: {e:?}")).data_json();
        for (name, src) in [("files", &full), ("files, pruned", &pruned), ("files, pruned and token filters", &tokens)] {
            let b = viz_logql::query_range(src, q, start, end, step, &opts).unwrap_or_else(|e| panic!("{q}: {e:?}")).data_json();
            rep.check(a == b, || format!("LogQL {q} ({name}): {} vs {} bytes", a.len(), b.len()));
            equal += (a == b) as u32;
            if name == "files" {
                answers.push(b);
            }
        }
        nonempty += !a.contains("\"result\":[]") as u32;
    }
    (
        json!({
            "queries": LOGQL_LOGS.len() + LOGQL_METRICS.len(), "answers_compared": 3 * (LOGQL_LOGS.len() + LOGQL_METRICS.len()), "identical": equal, "nonempty": nonempty,
            "row_groups_read": {"unpruned": full.groups_read.get(), "pruned": pruned.groups_read.get(), "pruned_and_token_filters": tokens.groups_read.get(), "skipped_by_token_filters": tokens.groups_skipped_by_tokens.get(), "of": pruned.groups_total.get()},
            "files_with_token_filters": with_filters,
        }),
        answers,
    )
}
