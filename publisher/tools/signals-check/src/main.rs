//! The publisher's span and log tables, read back by readers viz did not write, against viz's own
//! readers and engines (publisher/README.md, "Independent readers: the span and log tables").
//!
//!   signals-check EXPORT
//!
//! EXPORT is `publisher/export/signals/` after `test/e2e-signals.test.ts` (the tables, the real
//! Parquet files they reference, `expected.json`) and `tools/verify_signal_readers.py` (which
//! wrote `readback/<stage>/<reader>/<table>.jsonl`: every row PyIceberg and DuckDB read, file by
//! file, as the logical rows contracts/TRACES.md and LOGS.md define). For every stage, reader and
//! tenant:
//!
//! 1. each live file read with viz-storage's readers (`read_spans`, `read_trace_index`,
//!    `read_logs`) gives exactly the rows the reader read from that file (as multisets);
//! 2. duplicates resolved across files by the ledger's precedence (later wins) on both sides, the
//!    TraceQL queries through viz-traceql over the reader's rows give byte-identical JSON to the
//!    same queries over viz's rows (and with the engine's pruning on); the LogQL queries through
//!    viz-logql over the reader's rows give byte-identical JSON to the same queries over the files
//!    through `LogSource` (with pruning by index fragment on and off).
//!
//! The span, log and engine code below is stack/tools/signals-readback's (Apache-2.0, this
//! repository), which started as a copy of engine/storage/readback; only `main` and the per-file
//! comparison are new. Exit status 0 only if every check passed. A test tool, never shipped.
use serde_json::{json, Value as J};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use viz_logql::{LogSource, MatchOp};
use viz_storage::otel::Value;
use viz_storage::{read_logs, read_logs_row_groups, read_spans, read_trace_index, Fragment, LogRecord, SpanRecord};
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

fn fragment_json(f: &Fragment) -> J {
    json!({
        "trace_id": hex(&f.trace_id), "min_start": f.min_start.to_string(), "max_end": f.max_end.to_string(),
        "span_count": f.span_count, "error_count": f.error_count,
        "root": f.root.as_ref().map(|(svc, name, start, id)| json!([svc, name, start.to_string(), hex(id)])),
        "services": f.services.iter().map(|(n, s, e)| json!([n, s, e])).collect::<Vec<_>>(),
        "services_truncated": f.services_truncated, "hours": f.hours,
    })
}

/// The reader's rows of one file, and viz's, as sorted JSON texts (a multiset).
fn same_rows(rep: &mut Report, what: &str, mut a: Vec<String>, mut b: Vec<String>) -> bool {
    a.sort();
    b.sort();
    let ok = a == b;
    rep.check(ok, || {
        let first = a.iter().zip(&b).find(|(x, y)| x != y).map(|(x, y)| format!("\n    reader {x}\n    viz    {y}")).unwrap_or_default();
        format!("{what}: {} rows read, {} by viz-storage{first}", a.len(), b.len())
    });
    ok
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: signals-check EXPORT");
        std::process::exit(2);
    }
    let export = Path::new(&args[1]);
    let expected: J = serde_json::from_str(&fs::read_to_string(export.join("expected.json")).unwrap()).unwrap();
    let tenants: Vec<String> = expected["tenants"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
    let files = expected["files"].as_object().unwrap();
    let bytes_of = |key: &str| fs::read(export.join(key)).unwrap_or_else(|e| panic!("{key}: {e}"));
    let mut rep = Report::default();
    let mut out = Vec::new();
    for cp in expected["checkpoints"].as_array().unwrap() {
        let stage = cp["name"].as_str().unwrap();
        let order = |table: &str, tenant: &str| -> Vec<String> { cp["tables"][table]["files"][tenant].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_string()).collect() };
        for reader in ["pyiceberg", "duckdb"] {
            // reader rows, by file
            let mut got: HashMap<(String, String), Vec<J>> = HashMap::new();
            for table in ["spans", "trace_index", "logs"] {
                for line in jsonl(&export.join("readback").join(stage).join(reader).join(format!("{table}.jsonl"))) {
                    got.entry((table.to_string(), line["file"].as_str().unwrap().to_string())).or_default().push(line["row"].clone());
                }
            }
            for tenant in &tenants {
                let what = |t: &str, k: &str| format!("{stage}/{reader}/{tenant}: {t} {}", k.rsplit('/').next().unwrap_or(k));
                // 1. Per file, the reader's rows against viz-storage's.
                let mut viz_spans: BTreeMap<([u8; 16], [u8; 8]), SpanRecord> = BTreeMap::new();
                let mut their_spans: BTreeMap<(String, String), J> = BTreeMap::new();
                for k in order("spans", tenant) {
                    let rows = read_spans(&bytes_of(&k)).unwrap();
                    let theirs = got.get(&("spans".into(), k.clone())).cloned().unwrap_or_default();
                    same_rows(&mut rep, &what("spans", &k), theirs.iter().map(|j| j.to_string()).collect(), rows.iter().map(|r| span_json(r).to_string()).collect());
                    // Later files (in precedence order) win a duplicate, on both sides.
                    for r in rows {
                        viz_spans.insert((r.trace_id, r.span_id), r);
                    }
                    for j in theirs {
                        their_spans.insert((j["trace_id"].as_str().unwrap().to_string(), j["span_id"].as_str().unwrap().to_string()), j);
                    }
                }
                for k in order("trace_index", tenant) {
                    let rows = read_trace_index(&bytes_of(&k)).unwrap();
                    let theirs = got.get(&("trace_index".into(), k.clone())).cloned().unwrap_or_default();
                    same_rows(&mut rep, &what("trace_index", &k), theirs.iter().map(|j| j.to_string()).collect(), rows.iter().map(|f| fragment_json(f).to_string()).collect());
                }
                let mut their_logs: BTreeMap<String, J> = BTreeMap::new();
                let mut log_files: Vec<(Vec<u8>, String)> = Vec::new();
                for k in order("logs", tenant) {
                    let b = bytes_of(&k);
                    let rows = read_logs(&b).unwrap();
                    let theirs = got.get(&("logs".into(), k.clone())).cloned().unwrap_or_default();
                    same_rows(&mut rep, &what("logs", &k), theirs.iter().map(|j| j.to_string()).collect(), rows.iter().map(|r| log_json(r).to_string()).collect());
                    for j in theirs {
                        their_logs.insert(log_key(&j), j);
                    }
                    log_files.push((b, files[&k]["index"].as_str().unwrap().to_string()));
                }
                // 2. The engines over both.
                let spans: Vec<SpanRecord> = viz_spans.into_values().collect();
                let theirs: Vec<J> = their_spans.into_values().collect();
                rep.check(spans.len() == theirs.len(), || format!("{stage}/{reader}/{tenant}: {} spans after duplicates, viz {}", theirs.len(), spans.len()));
                let tq = if spans.is_empty() { json!(null) } else { traceql(&mut rep, &theirs, &spans) };
                let logs: Vec<J> = their_logs.into_values().collect();
                let lq = if logs.is_empty() { json!(null) } else { logql(&mut rep, &logs, &log_files) };
                out.push(json!({"stage": stage, "reader": reader, "tenant": tenant, "spans": spans.len(), "logs": logs.len(), "traceql": tq, "logql": lq}));
            }
        }
    }
    let identical = |k: &str| out.iter().map(|o| o[k]["identical"].as_u64().unwrap_or(0)).sum::<u64>();
    let compared = |k: &str| out.iter().map(|o| o[k]["answers_compared"].as_u64().unwrap_or(0)).sum::<u64>();
    let nonempty = |k: &str| out.iter().map(|o| o[k]["nonempty"].as_u64().unwrap_or(0)).sum::<u64>();
    println!(
        "{}",
        json!({
            "runs": out.len(), "traceql": {"compared": compared("traceql"), "identical": identical("traceql"), "nonempty": nonempty("traceql")},
            "logql": {"compared": compared("logql"), "identical": identical("logql"), "nonempty": nonempty("logql")},
            "checks": rep.checks, "failures": rep.failures.len(),
        })
    );
    for o in &out {
        println!("{o}");
    }
    for f in rep.failures.iter().filter(|f| !f.is_empty()) {
        println!("FAIL {f}");
    }
    std::process::exit(if rep.failures.is_empty() { 0 } else { 1 });
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

fn traceql(rep: &mut Report, expected: &[J], read: &[SpanRecord]) -> J {
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
        let (a0, c0) = (run(&mem, false), run(&pruned, false));
        rep.check(a0 == c0, || format!("TraceQL {q} (files, pruned): {} vs {} bytes", a0.len(), c0.len()));
        equal += (a == b) as u32 + (a0 == c0) as u32;
        nonempty += if metric { a.contains("\"samples\"") } else { !a.contains("\"traces\":[]") } as u32;
    }
    json!({"queries": TRACEQL_SEARCH.len() + TRACEQL_METRICS.len(), "answers_compared": 2 * (TRACEQL_SEARCH.len() + TRACEQL_METRICS.len()), "identical": equal, "nonempty": nonempty})
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
    groups_read: std::cell::Cell<u64>,
    groups_total: std::cell::Cell<u64>,
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
    fn groups(&self, index: &str, req: &viz_logql::SelectRequest<'_>) -> Vec<usize> {
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
            let groups = self.groups(index, req);
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
];
const LOGQL_METRICS: &[&str] = &[
    "count_over_time({service_name=~\".+\"}[5m])",
    "sum by (service_name) (rate({service_name=~\".+\"} |= \"GET\" [1m]))",
    "sum by (level) (count_over_time({job=~\".+\"} | logfmt [10m]))",
    "topk(3, sum by (job) (bytes_over_time({job=~\".+\"}[30m])))",
    "sum(count_over_time({service_name=~\".+\"} | severity_number=\"17\" [1h]))",
    "avg_over_time({service_name=~\".+\"} | logfmt | unwrap duration(duration) [15m]) by (service_name)",
];

fn logql(rep: &mut Report, expected: &[J], files: &[(Vec<u8>, String)]) -> J {
    let mem = mem_logs(expected);
    let full = FileLogs { files: files.to_vec(), prune: false, groups_read: 0.into(), groups_total: 0.into() };
    let pruned = FileLogs { files: files.to_vec(), prune: true, groups_read: 0.into(), groups_total: 0.into() };
    let ts: Vec<i64> = expected.iter().map(|j| j["ts"].as_str().unwrap().parse().unwrap()).collect();
    let step = 60_000_000_000i64;
    let (start, end) = (ts.iter().min().unwrap() / step * step, (ts.iter().max().unwrap() / step + 2) * step);
    let opts = viz_logql::Options { limit: 1_000_000, direction: viz_logql::Direction::Forward, ..Default::default() };
    let (mut equal, mut nonempty) = (0, 0);
    for q in LOGQL_LOGS.iter().chain(LOGQL_METRICS) {
        let a = viz_logql::query_range(&mem, q, start, end, step, &opts).unwrap_or_else(|e| panic!("{q}: {e:?}")).data_json();
        for (name, src) in [("files", &full), ("files, pruned", &pruned)] {
            let b = viz_logql::query_range(src, q, start, end, step, &opts).unwrap_or_else(|e| panic!("{q}: {e:?}")).data_json();
            rep.check(a == b, || format!("LogQL {q} ({name}): {} vs {} bytes", a.len(), b.len()));
            equal += (a == b) as u32;
        }
        nonempty += !a.contains("\"result\":[]") as u32;
    }
    json!({
        "queries": LOGQL_LOGS.len() + LOGQL_METRICS.len(), "answers_compared": 2 * (LOGQL_LOGS.len() + LOGQL_METRICS.len()), "identical": equal, "nonempty": nonempty,
        "row_groups_read": {"unpruned": full.groups_read.get(), "pruned": pruned.groups_read.get(), "of": pruned.groups_total.get()},
    })
}
