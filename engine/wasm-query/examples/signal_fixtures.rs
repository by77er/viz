//! Fixtures for the query Worker's trace and log tests (`query/test/signals.test.ts`), and their
//! expected answers from the engines' IN-MEMORY sources.
//!
//!   cargo run --release --example signal_fixtures -- CORPUS OUT.json SEED
//!
//! CORPUS is what `edge/scripts/otel-corpus.mjs` writes (`VZB1` signal 2 and 3 batches made by
//! edge's own decoders from OTLP and Loki push requests). This tool
//!
//! 1. keeps the batches in order and cuts each signal's into flush units: the first 70 % in
//!    three contiguous units, each flushed with the stage-1 encoders (`viz_storage::encode_spans`,
//!    `encode_logs`) into the files a flush would write; the rest stay tail;
//! 2. decodes EVERY batch straight into the engines' in-memory sources (`viz_traceql::MemSource`,
//!    `viz_logql::MemSource`), duplicates resolved (the later batch wins), with no Parquet and
//!    none of the read path's code (`src/sigfiles.rs` and friends are not used here);
//! 3. writes the cases the test sends over HTTP, each with the answer the in-memory engines
//!    give (and, for trace by ID, tags and labels, an answer built here from the decoded rows).
//!
//! Deterministic for a corpus. The output is test input, not committed (`query/.gitignore`).
use serde_json::{json, Value as J};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use viz_storage::otel::{decode_logs, decode_spans, Value};
use viz_storage::{encode_logs, encode_spans, SignalFile};
use viz_traceql::{AttrValue, Kind, RangeRequest, SearchRequest, Status};

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (RFC 4648), written here for the oracle.
fn b64(data: &[u8]) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = u32::from_be_bytes([0, data[i], data[i + 1], data[i + 2]]);
        for s in [18, 12, 6, 0] {
            out.push(B64[((n >> s) & 63) as usize] as char);
        }
        i += 3;
    }
    let rest = &data[i..];
    if rest.len() == 1 {
        let n = (rest[0] as u32) << 16;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push_str("==");
    } else if rest.len() == 2 {
        let n = (rest[0] as u32) << 16 | (rest[1] as u32) << 8;
        for s in [18, 12, 6] {
            out.push(B64[((n >> s) & 63) as usize] as char);
        }
        out.push('=');
    }
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn files_json(files: &[SignalFile]) -> Vec<J> {
    files
        .iter()
        .map(|f| json!({"table": f.table.as_str(), "day": f.day, "hour": f.hour, "rows": f.rows, "minNs": f.min_ts.to_string(), "maxNs": f.max_ts.to_string(), "index": f.index, "bytes": b64(&f.bytes)}))
        .collect()
}

/// Batches cut into flush units (70 % in three contiguous units) and the tail.
fn units(n: usize) -> (Vec<(usize, usize)>, usize) {
    let lake = (n * 7 / 10).max(1).min(n);
    let per = lake.div_ceil(3).max(1);
    let mut out = Vec::new();
    let mut at = 0;
    while at < lake {
        let hi = (at + per).min(lake);
        out.push((at, hi));
        at = hi;
    }
    (out, lake)
}

// ───────────────────────────── traces, in memory ─────────────────────────────

fn dbl(v: &J) -> Option<f64> {
    match v {
        J::Number(n) => n.as_f64(),
        J::String(s) if s == "NaN" => Some(f64::NAN),
        J::String(s) if s == "Infinity" => Some(f64::INFINITY),
        J::String(s) if s == "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

fn any_to_av(raw: &str) -> AttrValue {
    let v: J = serde_json::from_str(raw).unwrap();
    if let Some(s) = v.get("stringValue").and_then(J::as_str) {
        return AttrValue::Str(s.into());
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
            return AttrValue::StrArray(vec![]);
        }
        if all("stringValue") {
            return AttrValue::StrArray(items.iter().map(|x| x["stringValue"].as_str().unwrap().into()).collect());
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
    AttrValue::Other(raw.into())
}

fn av(v: &Value<&str>) -> AttrValue {
    match v {
        Value::Str(s) => AttrValue::Str(s.to_string()),
        Value::Int(i) => AttrValue::Int(*i),
        Value::Double(b) => AttrValue::Float(f64::from_bits(*b)),
        Value::Bool(b) => AttrValue::Bool(*b),
        Value::Other(o) => any_to_av(o),
    }
}

fn kv(raw: &str) -> Vec<(String, AttrValue)> {
    if raw.is_empty() {
        return vec![];
    }
    let v: J = serde_json::from_str(raw).unwrap();
    v.as_array().unwrap().iter().map(|e| (e["key"].as_str().unwrap().to_string(), any_to_av(&e["value"].to_string()))).collect()
}

/// One span as decoded from a batch, owned, with what trace by ID prints.
#[derive(Clone)]
struct Rec {
    trace_id: [u8; 16],
    span: viz_traceql::Span,
    raw: J,
    resource: J,
    scope: J,
}

fn any_json(v: &Value<&str>) -> J {
    match v {
        Value::Str(s) => json!({"stringValue": s}),
        Value::Int(i) => json!({"intValue": i.to_string()}),
        Value::Double(b) => {
            let d = f64::from_bits(*b);
            if d.is_nan() {
                json!({"doubleValue": "NaN"})
            } else if d.is_infinite() {
                json!({"doubleValue": if d > 0.0 { "Infinity" } else { "-Infinity" }})
            } else {
                json!({"doubleValue": d})
            }
        }
        Value::Bool(b) => json!({"boolValue": b}),
        Value::Other(o) => serde_json::from_str(o).unwrap(),
    }
}

fn attrs_json(a: &[viz_storage::otel::Attr<&str>]) -> J {
    J::Array(a.iter().map(|x| json!({"key": x.key, "value": any_json(&x.value)})).collect())
}

fn spans_of(batches: &[Vec<u8>]) -> Vec<Rec> {
    let mut by: HashMap<([u8; 16], [u8; 8]), Rec> = HashMap::new();
    for b in batches {
        let d = decode_spans(b).unwrap();
        for r in &d.rows {
            let e = &d.entries[r.entry as usize];
            let span = viz_traceql::Span {
                span_id: r.span_id,
                parent_span_id: r.parent(),
                name: r.name.to_string(),
                kind: Kind::from_otlp(r.kind as i32),
                status: Status::from_otlp(r.status as i32),
                status_message: r.status_message.to_string(),
                start_unix_nano: r.start as u64,
                end_unix_nano: r.end as u64,
                resource: e.resource.iter().map(|a| (a.key.to_string(), av(&a.value))).collect::<Vec<_>>().into(),
                attrs: r.attrs.iter().map(|a| (a.key.to_string(), av(&a.value))).collect(),
                scope_name: e.scope_name.to_string(),
                scope_version: e.scope_version.to_string(),
                scope_attrs: kv(e.scope_attrs),
                events: r.events.iter().map(|x| viz_traceql::Event { time_unix_nano: x.time_unix_nano as u64, name: x.name.to_string(), attrs: kv(x.attrs) }).collect(),
                links: r.links.iter().map(|x| viz_traceql::Link { trace_id: x.trace_id, span_id: x.span_id, trace_state: x.trace_state.to_string(), attrs: kv(x.attrs) }).collect(),
            };
            // The span as OTLP JSON, every rule written out here: empty fields left out.
            let mut o = serde_json::Map::new();
            o.insert("traceId".into(), b64(&r.trace_id).into());
            o.insert("spanId".into(), b64(&r.span_id).into());
            if !r.trace_state.is_empty() {
                o.insert("traceState".into(), r.trace_state.into());
            }
            if let Some(p) = r.parent() {
                o.insert("parentSpanId".into(), b64(&p).into());
            }
            if r.flags != 0 {
                o.insert("flags".into(), r.flags.into());
            }
            o.insert("name".into(), r.name.into());
            let kinds = ["SPAN_KIND_UNSPECIFIED", "SPAN_KIND_INTERNAL", "SPAN_KIND_SERVER", "SPAN_KIND_CLIENT", "SPAN_KIND_PRODUCER", "SPAN_KIND_CONSUMER"];
            o.insert("kind".into(), kinds[r.kind as usize].into());
            o.insert("startTimeUnixNano".into(), r.start.to_string().into());
            o.insert("endTimeUnixNano".into(), r.end.to_string().into());
            if !r.attrs.is_empty() {
                o.insert("attributes".into(), attrs_json(&r.attrs));
            }
            if r.dropped[0] != 0 {
                o.insert("droppedAttributesCount".into(), r.dropped[0].into());
            }
            if !r.events.is_empty() {
                let ev: Vec<J> = r
                    .events
                    .iter()
                    .map(|x| {
                        let mut m = json!({"timeUnixNano": x.time_unix_nano.to_string(), "name": x.name});
                        let a: J = serde_json::from_str(x.attrs).unwrap();
                        if a.as_array().is_some_and(|v| !v.is_empty()) {
                            m["attributes"] = a;
                        }
                        m
                    })
                    .collect();
                o.insert("events".into(), J::Array(ev));
            }
            if r.dropped[1] != 0 {
                o.insert("droppedEventsCount".into(), r.dropped[1].into());
            }
            if !r.links.is_empty() {
                let ls: Vec<J> = r
                    .links
                    .iter()
                    .map(|x| {
                        let mut m = json!({"traceId": b64(&x.trace_id), "spanId": b64(&x.span_id)});
                        if !x.trace_state.is_empty() {
                            m["traceState"] = x.trace_state.into();
                        }
                        let a: J = serde_json::from_str(x.attrs).unwrap();
                        if a.as_array().is_some_and(|v| !v.is_empty()) {
                            m["attributes"] = a;
                        }
                        m
                    })
                    .collect();
                o.insert("links".into(), J::Array(ls));
            }
            if r.dropped[2] != 0 {
                o.insert("droppedLinksCount".into(), r.dropped[2].into());
            }
            let mut st = serde_json::Map::new();
            if !r.status_message.is_empty() {
                st.insert("message".into(), r.status_message.into());
            }
            if r.status != 0 {
                st.insert("code".into(), ["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"][r.status as usize].into());
            }
            o.insert("status".into(), J::Object(st));
            let resource = if e.resource.is_empty() { json!({}) } else { json!({"attributes": attrs_json(&e.resource)}) };
            let mut scope = serde_json::Map::new();
            if !e.scope_name.is_empty() {
                scope.insert("name".into(), e.scope_name.into());
            }
            if !e.scope_version.is_empty() {
                scope.insert("version".into(), e.scope_version.into());
            }
            if !e.scope_attrs.is_empty() && e.scope_attrs != "[]" {
                scope.insert("attributes".into(), serde_json::from_str(e.scope_attrs).unwrap());
            }
            by.insert((r.trace_id, r.span_id), Rec { trace_id: r.trace_id, span, raw: J::Object(o), resource, scope: J::Object(scope) });
        }
    }
    let mut v: Vec<Rec> = by.into_values().collect();
    v.sort_by(|a, b| (a.trace_id, a.span.start_unix_nano, a.span.span_id).cmp(&(b.trace_id, b.span.start_unix_nano, b.span.span_id)));
    v
}

fn mem_traces(recs: &[Rec], keep: impl Fn(&Rec) -> bool) -> Vec<viz_traceql::Trace> {
    let mut by: BTreeMap<[u8; 16], Vec<viz_traceql::Span>> = BTreeMap::new();
    for r in recs.iter().filter(|r| keep(r)) {
        by.entry(r.trace_id).or_default().push(r.span.clone());
    }
    by.into_iter()
        .map(|(t, mut v)| {
            v.sort_by(|a, b| (a.start_unix_nano, a.span_id).cmp(&(b.start_unix_nano, b.span_id)));
            viz_traceql::Trace::new(t, v)
        })
        .collect()
}

/// Tempo's body with its `metrics` (what was inspected, which pruning changes) left out.
fn without_metrics(s: &str) -> String {
    let at = s.rfind(",\"metrics\":{").expect("metrics");
    let end = at + s[at..].find('}').unwrap() + 1;
    format!("{}{}", &s[..at], &s[end..])
}

fn trace_json(recs: &[Rec], id: [u8; 16]) -> Option<J> {
    let mut spans: Vec<&Rec> = recs.iter().filter(|r| r.trace_id == id).collect();
    if spans.is_empty() {
        return None;
    }
    spans.sort_by(|a, b| (a.span.start_unix_nano, a.span.span_id).cmp(&(b.span.start_unix_nano, b.span.span_id)));
    let mut batches: Vec<(J, Vec<(J, Vec<J>)>)> = Vec::new();
    for s in spans {
        let bi = match batches.iter().position(|(r, _)| *r == s.resource) {
            Some(i) => i,
            None => {
                batches.push((s.resource.clone(), vec![]));
                batches.len() - 1
            }
        };
        let scopes = &mut batches[bi].1;
        match scopes.iter_mut().find(|(k, _)| *k == s.scope) {
            Some((_, v)) => v.push(s.raw.clone()),
            None => scopes.push((s.scope.clone(), vec![s.raw.clone()])),
        }
    }
    Some(json!({"batches": batches.into_iter().map(|(r, sc)| json!({"resource": r, "scopeSpans": sc.into_iter().map(|(s, v)| json!({"scope": s, "spans": v})).collect::<Vec<_>>()})).collect::<Vec<_>>()}))
}

// ───────────────────────────── logs, in memory ─────────────────────────────

struct LogRec {
    labels: Vec<(String, String)>,
    ts: i64,
    row: viz_logql::LogRow,
    raw_md: Vec<(String, String)>,
}

fn logs_of(batches: &[Vec<u8>]) -> Vec<LogRec> {
    let mut by: HashMap<(i64, i64, String, Vec<(String, String)>), LogRec> = HashMap::new();
    for b in batches {
        let d = decode_logs(b).unwrap();
        for r in &d.rows {
            let st = &d.streams[r.entry as usize];
            let raw_md: Vec<(String, String)> = r.metadata.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            let mut m: BTreeMap<String, String> = BTreeMap::new();
            if r.trace_id != [0; 16] {
                m.insert("trace_id".into(), hex(&r.trace_id));
            }
            if r.span_id != [0; 8] {
                m.insert("span_id".into(), hex(&r.span_id));
            }
            if !r.severity_text.is_empty() {
                m.insert("severity_text".into(), r.severity_text.into());
            }
            if r.severity_number != 0 {
                m.insert("severity_number".into(), r.severity_number.to_string());
            }
            if r.observed_ts != 0 {
                m.insert("observed_timestamp".into(), r.observed_ts.to_string());
            }
            if r.flags != 0 {
                m.insert("flags".into(), r.flags.to_string());
            }
            for (k, v) in &raw_md {
                m.insert(k.clone(), v.clone());
            }
            let labels: Vec<(String, String)> = st.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
            by.insert(
                (st.stream_id, r.ts, r.line.to_string(), raw_md.clone()),
                LogRec { labels, ts: r.ts, row: viz_logql::LogRow { ts_ns: r.ts, line: r.line.to_string(), metadata: m.into_iter().collect() }, raw_md },
            );
        }
    }
    by.into_values().collect()
}

fn mem_logs(recs: &[LogRec]) -> viz_logql::MemSource {
    let mut by: BTreeMap<Vec<(String, String)>, Vec<(Vec<(String, String)>, viz_logql::LogRow)>> = BTreeMap::new();
    for r in recs {
        by.entry(r.labels.clone()).or_default().push((r.raw_md.clone(), r.row.clone()));
    }
    viz_logql::MemSource::new(
        by.into_iter()
            .map(|(labels, mut rows)| {
                rows.sort_by(|a, b| (a.1.ts_ns, a.1.line.as_bytes()).cmp(&(b.1.ts_ns, b.1.line.as_bytes())).then_with(|| a.0.cmp(&b.0)));
                viz_logql::LogStream { labels, rows: rows.into_iter().map(|x| x.1).collect() }
            })
            .collect(),
    )
}

// ───────────────────────────── cases ─────────────────────────────

const SEARCHES: &[&str] = &[
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
    "{ span:childCount > 2 }",
    "{ trace:rootService = \"frontend\" && trace:duration > 1s }",
    "{ span.error.type = \"Bad état\" } | by(resource.service.name) | count() > 0",
    "{ instrumentation:name = \"io.opentelemetry.db\" && instrumentation.scope.k = 7 }",
    "{ resource.process.pid = 4242 }",
];
const METRICS: &[&str] = &[
    "{ } | rate() by (resource.service.name)",
    "{ status = error } | count_over_time() by (span.error.type)",
    "{ } | quantile_over_time(duration, .5, .9, .99) by (span.http.route)",
    "{ kind = server } | avg_over_time(span.http.response.status_code) by (resource.service.name)",
    "{ } | histogram_over_time(duration)",
    "{ span.http.response.status_code >= 400 } | rate() by (span.http.response.status_code) | topk(3)",
    "{ kind = server } >> { status = error } | count_over_time()",
    "{ trace:duration > 1s } | count_over_time() by (resource.service.name)",
];
const LOG_QUERIES: &[&str] = &[
    "{service_name=\"checkout\"}",
    "{job=~\"nginx|worker\"} |= \"error\"",
    "{service_name=~\".+\"} | logfmt | status >= 500",
    "{job=\"worker\"} | json | level=\"error\"",
    "{service_name=\"payment\"} | trace_id != \"\"",
    "{env=\"prod\"} | user=\"7\"",
    "{service_name=\"unknown_service\"}",
    "{deployment_environment_name=\"prod\"} | severity_text=\"ERROR\"",
    "{job=\"Zürich\"} != \"GET\"",
    "{service_name=~\".+\"} | http_route=\"/ünïcode\"",
];
const LOG_METRICS: &[&str] = &[
    "count_over_time({service_name=~\".+\"}[5m])",
    "sum by (service_name) (rate({service_name=~\".+\"} |= \"GET\" [1m]))",
    "sum by (level) (count_over_time({job=~\".+\"} | logfmt [10m]))",
    "topk(3, sum by (job) (bytes_over_time({job=~\".+\"}[30m])))",
    "sum(count_over_time({service_name=~\".+\"} | severity_number=\"17\" [1h]))",
];

fn case(id: String, path: &str, params: Vec<(&str, String)>, status: u16, body: J, compare: &str) -> J {
    json!({"id": id, "path": path, "params": params.into_iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(), "status": status, "body": body, "compare": compare})
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: signal_fixtures CORPUS OUT.json SEED");
        std::process::exit(2);
    }
    let corpus = Path::new(&args[1]);
    let seed: u64 = args[3].parse().unwrap();
    let mut names: Vec<_> = fs::read_dir(corpus.join("batches")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    let load = |p: &str| -> Vec<Vec<u8>> { names.iter().filter(|n| n.starts_with(p)).map(|n| fs::read(corpus.join("batches").join(n)).unwrap()).collect() };
    let (sb, lb) = (load("spans-"), load("logs-"));

    let flush = |bs: &[Vec<u8>], spans: bool| -> (Vec<J>, usize) {
        let (us, lake) = units(bs.len());
        let out = us
            .iter()
            .map(|&(a, b)| {
                let refs: Vec<&[u8]> = bs[a..b].iter().map(Vec::as_slice).collect();
                let files = if spans { encode_spans(&refs).unwrap() } else { encode_logs(&refs).unwrap() };
                json!({"seqLo": a + 1, "seqHi": b, "files": files_json(&files)})
            })
            .collect();
        (out, lake)
    };
    let (span_units, span_lake) = flush(&sb, true);
    let (log_units, log_lake) = flush(&lb, false);

    let recs = spans_of(&sb);
    let logs = logs_of(&lb);
    let (smin, smax) = (recs.iter().map(|r| r.span.start_unix_nano).min().unwrap(), recs.iter().map(|r| r.span.end_unix_nano).max().unwrap());
    let (lmin, lmax) = (logs.iter().map(|r| r.ts).min().unwrap(), logs.iter().map(|r| r.ts).max().unwrap());
    let sec = 1_000_000_000u64;
    let all = (smin / sec - 1, smax / sec + 2);
    let mid = ((smin / sec + smax / sec) / 2 - 1800, (smin / sec + smax / sec) / 2 + 1800);
    let mut cases = Vec::new();

    // ── Tempo search ──
    let mem = viz_traceql::MemSource::new(mem_traces(&recs, |_| true));
    for (wi, (ws, we)) in [all, mid].into_iter().enumerate() {
        for (i, q) in SEARCHES.iter().enumerate() {
            let (limit, spss) = if i % 3 == 0 { (1000, 1000) } else { (5, 2) };
            let req = SearchRequest { limit, spans_per_spanset: spss, start_unix_nano: ws * sec, end_unix_nano: we * sec };
            let r = viz_traceql::search(&mem, q, &req).unwrap();
            let params = vec![("q", q.to_string()), ("start", ws.to_string()), ("end", we.to_string()), ("limit", limit.to_string()), ("spss", spss.to_string())];
            cases.push(case(format!("search/{wi}/{i}"), "/api/search", params, 200, without_metrics(&r.to_json()).into(), "tempo"));
        }
    }
    // ── Tempo metrics ──
    let limits = viz_traceql::Limits { max_series: 10_000, max_points: 11_000, max_bytes: u64::MAX };
    for (i, q) in METRICS.iter().enumerate() {
        let req = viz_traceql::align_request(&RangeRequest::range(all.0 * sec, all.1 * sec, 60 * sec));
        let r = viz_traceql::query_range_with(&mem, q, &req, &limits).unwrap();
        let params = vec![("q", q.to_string()), ("start", all.0.to_string()), ("end", all.1.to_string()), ("step", "60s".to_string())];
        cases.push(case(format!("metrics/{i}"), "/api/metrics/query_range", params, 200, without_metrics(&r.to_json()).into(), "tempo"));
        let inst = RangeRequest::instant(mid.0 * sec, mid.1 * sec);
        let r = viz_traceql::query_range_with(&mem, q, &inst, &limits).unwrap();
        let params = vec![("q", q.to_string()), ("start", mid.0.to_string()), ("end", mid.1.to_string())];
        cases.push(case(format!("metrics-instant/{i}"), "/api/metrics/query", params, 200, without_metrics(&r.to_json()).into(), "tempo"));
    }
    // ── trace by ID: every trace of a few kinds, and one that does not exist ──
    let ids: BTreeSet<[u8; 16]> = recs.iter().map(|r| r.trace_id).collect();
    let ids: Vec<[u8; 16]> = ids.into_iter().collect();
    let step = (ids.len() / 12).max(1);
    for (k, id) in ids.iter().step_by(step).enumerate() {
        let body = trace_json(&recs, *id).unwrap();
        cases.push(case(format!("trace/{k}"), &format!("/api/traces/{}", hex(id)), vec![], 200, body.clone(), "json"));
        cases.push(case(format!("trace-v2/{k}"), &format!("/api/v2/traces/{}", hex(id)), vec![("start", all.0.to_string()), ("end", all.1.to_string())], 200, json!({"trace": body}), "json"));
    }
    let missing = [0x5au8; 16];
    cases.push(case("trace/missing".into(), &format!("/api/traces/{}", hex(&missing)), vec![], 404, J::Null, "status"));
    // ── tags and tag values over the mid window ──
    let (lo, hi) = (mid.0 * sec, mid.1 * sec);
    let in_win: Vec<&Rec> = recs.iter().filter(|r| r.span.start_unix_nano >= lo && r.span.start_unix_nano <= hi).collect();
    let keys = |f: &dyn Fn(&Rec) -> Vec<String>| -> BTreeSet<String> { in_win.iter().flat_map(|r| f(r)).collect() };
    let res_keys = keys(&|r| r.span.resource.iter().map(|x| x.0.clone()).collect());
    let span_keys = keys(&|r| r.span.attrs.iter().map(|x| x.0.clone()).collect());
    let event_keys = keys(&|r| r.span.events.iter().flat_map(|e| e.attrs.iter().map(|x| x.0.clone())).collect());
    let link_keys = keys(&|r| r.span.links.iter().flat_map(|e| e.attrs.iter().map(|x| x.0.clone())).collect());
    let scope_keys = keys(&|r| r.span.scope_attrs.iter().map(|x| x.0.clone()).collect());
    let intrinsic: Vec<&str> = vec![
        "duration", "event:name", "event:timeSinceStart", "instrumentation:name", "instrumentation:version", "kind", "name", "rootName", "rootServiceName", "span:duration", "span:kind", "span:name",
        "span:status", "span:statusMessage", "status", "statusMessage", "trace:duration", "trace:rootName", "trace:rootService", "traceDuration",
    ];
    let win = vec![("start", mid.0.to_string()), ("end", mid.1.to_string())];
    let rs: BTreeSet<String> = res_keys.union(&span_keys).cloned().collect();
    cases.push(case("tags/v1".into(), "/api/search/tags", win.clone(), 200, json!({"tagNames": rs, "metrics": {}}), "json"));
    let mut p = win.clone();
    p.push(("scope", "resource".into()));
    cases.push(case("tags/v1-resource".into(), "/api/search/tags", p, 200, json!({"tagNames": res_keys, "metrics": {}}), "json"));
    let mut scopes = vec![];
    for (name, set) in [("resource", &res_keys), ("span", &span_keys)] {
        if !set.is_empty() {
            scopes.push(json!({"name": name, "tags": set}));
        }
    }
    scopes.push(json!({"name": "intrinsic", "tags": intrinsic}));
    for (name, set) in [("event", &event_keys), ("link", &link_keys), ("instrumentation", &scope_keys)] {
        if !set.is_empty() {
            scopes.push(json!({"name": name, "tags": set}));
        }
    }
    cases.push(case("tags/v2".into(), "/api/v2/search/tags", win.clone(), 200, json!({"scopes": scopes, "metrics": {}}), "json"));
    let typed = |v: &AttrValue| -> Option<(&'static str, String)> {
        match v {
            AttrValue::Str(s) => Some(("string", s.clone())),
            AttrValue::Int(i) => Some(("int", i.to_string())),
            AttrValue::Bool(b) => Some(("bool", b.to_string())),
            _ => None,
        }
    };
    let attr_of = |l: &[(String, AttrValue)], k: &str| l.iter().rev().find(|x| x.0 == k).map(|x| x.1.clone());
    // v1 service.name: strings of span and resource attributes with that key.
    let v1: BTreeSet<String> = in_win.iter().flat_map(|r| [attr_of(&r.span.attrs, "service.name"), attr_of(&r.span.resource, "service.name")]).flatten().filter_map(|v| if let AttrValue::Str(s) = v { Some(s) } else { None }).collect();
    cases.push(case("tag-values/v1".into(), "/api/search/tag/service.name/values", win.clone(), 200, json!({"tagValues": v1, "metrics": {}}), "json"));
    for (k, (tag, f)) in [
        ("resource.service.name", Box::new(|r: &Rec| attr_of(&r.span.resource, "service.name").and_then(|v| typed(&v)).into_iter().collect::<Vec<_>>()) as Box<dyn Fn(&Rec) -> Vec<(&'static str, String)>>),
        ("span.http.response.status_code", Box::new(|r: &Rec| attr_of(&r.span.attrs, "http.response.status_code").and_then(|v| typed(&v)).into_iter().collect())),
        ("name", Box::new(|r: &Rec| vec![("string", r.span.name.clone())])),
        ("status", Box::new(|r: &Rec| vec![("keyword", r.span.status.name().to_string())])),
    ]
    .into_iter()
    .enumerate()
    {
        let set: BTreeSet<(&'static str, String)> = in_win.iter().flat_map(|r| f(r)).collect();
        let body = json!({"tagValues": set.into_iter().map(|(t, v)| json!({"type": t, "value": v})).collect::<Vec<_>>(), "metrics": {}});
        cases.push(case(format!("tag-values/v2/{k}"), &format!("/api/v2/search/tag/{tag}/values"), win.clone(), 200, body, "json"));
    }
    // ── Loki ──
    let lmem = mem_logs(&logs);
    let lstep = 60_000_000_000i64;
    let (ls, le) = ((lmin / lstep) * lstep, (lmax / lstep + 2) * lstep);
    for (i, q) in LOG_QUERIES.iter().enumerate() {
        for (dir, d) in [("forward", viz_logql::Direction::Forward), ("backward", viz_logql::Direction::Backward)] {
            let limit = if i % 2 == 0 { 5000 } else { 7 };
            let opts = viz_logql::Options { limit, direction: d, max_steps: 11_000, max_series: 20_000, now_ns: None, max_bytes: u64::MAX };
            let r = viz_logql::query_range(&lmem, q, ls, le, lstep, &opts).unwrap();
            let params = vec![("query", q.to_string()), ("start", ls.to_string()), ("end", le.to_string()), ("limit", limit.to_string()), ("direction", dir.to_string())];
            cases.push(case(format!("loki/{i}/{dir}"), "/loki/api/v1/query_range", params, 200, r.data_json().into(), "text-data"));
        }
    }
    for (i, q) in LOG_METRICS.iter().enumerate() {
        let opts = viz_logql::Options { limit: 100, direction: viz_logql::Direction::Backward, max_steps: 11_000, max_series: 20_000, now_ns: None, max_bytes: u64::MAX };
        let r = viz_logql::query_range(&lmem, q, ls, le, lstep, &opts).unwrap();
        let params = vec![("query", q.to_string()), ("start", ls.to_string()), ("end", le.to_string()), ("step", "60".to_string())];
        cases.push(case(format!("loki-metric/{i}"), "/loki/api/v1/query_range", params, 200, r.data_json().into(), "text-data"));
        let t = (ls + le) / 2;
        let r = viz_logql::query_instant(&lmem, q, t, &opts).unwrap();
        cases.push(case(format!("loki-instant/{i}"), "/loki/api/v1/query", vec![("query", q.to_string()), ("time", t.to_string())], 200, r.data_json().into(), "text-data"));
    }
    // Labels over all the data (a fragment's stream counts by its first-to-last span; over all of it that is exact).
    let lwin = vec![("start", (ls).to_string()), ("end", (le).to_string())];
    let streams: BTreeSet<Vec<(String, String)>> = logs.iter().map(|r| r.labels.clone()).collect();
    let names: BTreeSet<String> = streams.iter().flat_map(|s| s.iter().map(|x| x.0.clone())).collect();
    cases.push(case("loki-labels".into(), "/loki/api/v1/labels", lwin.clone(), 200, json!({"status": "success", "data": names}), "json"));
    for name in ["service_name", "job"] {
        let vals: BTreeSet<String> = streams.iter().filter_map(|s| s.iter().find(|x| x.0 == name).map(|x| x.1.clone())).collect();
        cases.push(case(format!("loki-values/{name}"), &format!("/loki/api/v1/label/{name}/values"), lwin.clone(), 200, json!({"status": "success", "data": vals}), "json"));
    }
    let mut p = lwin.clone();
    p.push(("query", "{job=~\"nginx|worker\"}".into()));
    let vals: BTreeSet<String> = streams.iter().filter(|s| s.iter().any(|x| x.0 == "job" && (x.1 == "nginx" || x.1 == "worker"))).flat_map(|s| s.iter().map(|x| x.0.clone())).collect();
    cases.push(case("loki-labels/query".into(), "/loki/api/v1/labels", p, 200, json!({"status": "success", "data": vals}), "json"));
    let mut p = lwin.clone();
    p.push(("match[]", "{service_name=\"checkout\"}".into()));
    p.push(("match[]", "{job=\"worker\"}".into()));
    let series: Vec<J> = streams
        .iter()
        .filter(|s| s.iter().any(|x| (x.0 == "service_name" && x.1 == "checkout") || (x.0 == "job" && x.1 == "worker")))
        .map(|s| J::Object(s.iter().map(|(k, v)| (k.clone(), J::String(v.clone()))).collect()))
        .collect();
    cases.push(case("loki-series".into(), "/loki/api/v1/series", p, 200, json!({"status": "success", "data": series}), "json"));

    let out = json!({
        "seed": seed,
        "spans": {"batches": sb.iter().map(|b| b64(b)).collect::<Vec<_>>(), "units": span_units, "lake": span_lake},
        "logs": {"batches": lb.iter().map(|b| b64(b)).collect::<Vec<_>>(), "units": log_units, "lake": log_lake},
        "counts": {"spans": recs.len(), "traces": ids.len(), "logs": logs.len()},
        "cases": cases,
    });
    fs::write(&args[2], serde_json::to_string(&out).unwrap()).unwrap();
    eprintln!("{}: {} spans in {} traces, {} log rows, {} cases", args[2], recs.len(), ids.len(), logs.len(), out["cases"].as_array().unwrap().len());
}
