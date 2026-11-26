//! Synthetic span and log files for the query Worker's measurements (`query/test/signals.bench.ts`).
//!
//!   cargo run --release --example signal_bench -- SPANS LOGS OUT.json
//!
//! The generator is `engine/storage/examples/otel_bench.rs`'s (copied: 20 services x 5
//! instances, ~12 spans a trace over one hour, 6-8 attributes a span; logfmt lines of 80-260
//! bytes in 50 streams), deterministic. Each signal's batches are flushed with the stage-1
//! encoders in segments of 20,000 rows (as flush units); the last batch of each stays tail.
//! Writes the files and tail batches as base64, a sample of trace ids, and the time window.
use serde_json::json;
use viz_storage::otel::{self, Attr, Event, Link, LogRow, LogStream, Span, SpanEntry, Value};
use viz_storage::{encode_logs, encode_spans};

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn b64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 4 / 3 + 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            out.push(if k <= c.len() { B64[(n >> (18 - 6 * k) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn bytes<const N: usize>(&mut self) -> [u8; N] {
        let mut b = [0u8; N];
        for x in b.iter_mut() {
            *x = self.next() as u8;
        }
        b[0] |= 1;
        b
    }
}

const T0: i64 = 1_795_000_000_000_000_000;
const MAX_BATCH: usize = 1 << 20;

fn s(x: impl Into<String>) -> Value<String> {
    Value::Str(x.into())
}

fn span_entries() -> Vec<SpanEntry<String>> {
    let mut out = Vec::new();
    for svc in 0..20 {
        for inst in 0..5 {
            let mut resource = vec![
                Attr { key: "deployment.environment.name".into(), value: s(if svc % 3 == 0 { "staging" } else { "prod" }) },
                Attr { key: "host.name".into(), value: s(format!("host-{}", (svc * 5 + inst) % 37)) },
                Attr { key: "k8s.pod.name".into(), value: s(format!("svc-{svc}-7d9f8b6c5-{inst:05}")) },
                Attr { key: "service.instance.id".into(), value: s(format!("svc-{svc}-{inst}")) },
                Attr { key: "service.name".into(), value: s(format!("svc-{svc}")) },
                Attr { key: "service.namespace".into(), value: s("shop") },
            ];
            resource.sort_by(|a, b| a.key.cmp(&b.key));
            out.push(SpanEntry { resource_fp: (svc * 5 + inst) as i64, resource, scope_name: "io.opentelemetry.http".into(), scope_version: "1.30.0".into(), scope_attrs: String::new() });
        }
    }
    out
}

fn span(r: &mut Rng, trace: [u8; 16]) -> Span<String> {
    let start = T0 + r.below(3_600_000_000_000) as i64;
    let dur = 10f64.powf(3.0 + r.below(7000) as f64 / 1000.0) as i64;
    let err = r.below(100) < 8;
    let mut attrs = vec![
        Attr { key: "http.request.method".into(), value: s(["GET", "POST", "PUT", "DELETE"][r.below(4) as usize]) },
        Attr { key: "http.response.status_code".into(), value: Value::Int(if err { 500 } else { [200, 200, 201, 404][r.below(4) as usize] }) },
        Attr { key: "http.route".into(), value: s(format!("/api/v1/resource/{}", r.below(50))) },
        Attr { key: "user.id".into(), value: s(format!("u-{:016x}", r.next())) },
        Attr { key: "sampling.ratio".into(), value: Value::Double((r.below(1000) as f64 / 1000.0).to_bits()) },
        Attr { key: "cache.hit".into(), value: Value::Bool(r.below(2) == 0) },
    ];
    if r.below(10) < 3 {
        attrs.push(Attr { key: "db.statement".into(), value: s(format!("SELECT * FROM t{} WHERE id = {} {}", r.below(20), r.next(), "AND x = 1 ".repeat(r.below(16) as usize))) });
    }
    if err {
        attrs.push(Attr { key: "error.type".into(), value: s("timeout") });
    }
    attrs.sort_by(|a, b| a.key.cmp(&b.key));
    Span {
        entry: 0,
        trace_id: trace,
        span_id: r.bytes(),
        parent_span_id: if r.below(12) == 0 { [0; 8] } else { r.bytes() },
        start,
        end: start + dur,
        flags: 0x101,
        dropped: [0; 3],
        kind: (1 + r.below(3)) as u8,
        status: if err { 2 } else { 0 },
        name: format!("op-{}", r.below(200)),
        trace_state: String::new(),
        status_message: if err { "deadline exceeded".into() } else { String::new() },
        attrs,
        events: if r.below(10) == 0 {
            vec![Event { time_unix_nano: start + 1, name: "exception".into(), attrs: "[{\"key\":\"exception.message\",\"value\":{\"stringValue\":\"boom\"}}]".into() }]
        } else {
            Vec::new()
        },
        links: if r.below(50) == 0 { vec![Link { trace_id: r.bytes(), span_id: r.bytes(), trace_state: String::new(), attrs: "[]".into() }] } else { Vec::new() },
    }
}

/// Batches of at most 1 MiB for `n` spans: rows in arrival order, the entries they use.
fn span_batches(r: &mut Rng, entries: &[SpanEntry<String>], n: usize) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut rows: Vec<Span<String>> = Vec::new();
    let mut trace = r.bytes();
    let flush = |rows: &mut Vec<Span<String>>, out: &mut Vec<Vec<u8>>| {
        let mut used: Vec<u32> = rows.iter().map(|x| x.entry).collect();
        used.sort_unstable();
        used.dedup();
        let local: Vec<SpanEntry<String>> = used.iter().map(|e| entries[*e as usize].clone()).collect();
        for x in rows.iter_mut() {
            x.entry = used.binary_search(&x.entry).unwrap() as u32;
        }
        out.push(otel::encode_spans(&local, rows).unwrap());
        rows.clear();
    };
    let mut bytes = 0;
    for i in 0..n {
        if i % 12 == 0 {
            trace = r.bytes();
        }
        let mut sp = span(r, trace);
        sp.entry = r.below(entries.len() as u64) as u32;
        bytes += 200 + otel::span_var_bytes(&Span { name: sp.name.as_str(), trace_state: "", status_message: sp.status_message.as_str(), attrs: sp.attrs.iter().map(|a| Attr { key: a.key.as_str(), value: match &a.value { Value::Str(x) => Value::Str(x.as_str()), Value::Other(x) => Value::Other(x.as_str()), Value::Int(i) => Value::Int(*i), Value::Double(d) => Value::Double(*d), Value::Bool(b) => Value::Bool(*b) } }).collect(), events: Vec::new(), links: Vec::new(), entry: 0, trace_id: [0; 16], span_id: [0; 8], parent_span_id: [0; 8], start: 0, end: 0, flags: 0, dropped: [0; 3], kind: 0, status: 0 });
        rows.push(sp);
        if bytes > MAX_BATCH / 2 {
            flush(&mut rows, &mut out);
            bytes = 0;
        }
    }
    if !rows.is_empty() {
        flush(&mut rows, &mut out);
    }
    out
}

fn log_streams() -> Vec<LogStream<String>> {
    (0..50)
        .map(|k| {
            let labels = vec![("k8s_namespace_name".to_string(), format!("ns-{}", k % 7)), ("pod".to_string(), format!("app-{k}-5f7c9")), ("service_name".to_string(), format!("app-{}", k % 12))];
            LogStream { stream_id: otel::stream_id(&labels), labels }
        })
        .collect()
}

fn log_batches(r: &mut Rng, streams: &[LogStream<String>], n: usize) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut rows: Vec<LogRow<String>> = Vec::new();
    let mut bytes = 0;
    for _ in 0..n {
        let level = ["info", "info", "info", "warn", "error", "debug"][r.below(6) as usize];
        let line = format!(
            "ts=2026-11-19T07:00:00Z level={level} msg=\"handled request\" request_id={:016x} route=/api/v1/resource/{} status={} duration={}ms{}",
            r.next(),
            r.below(50),
            [200, 201, 404, 500][r.below(4) as usize],
            r.below(2000),
            " extra=padding".repeat(r.below(10) as usize)
        );
        let traced = r.below(10) < 3;
        let mut metadata = vec![("level".to_string(), level.to_string()), ("user".to_string(), format!("u{}", r.below(5000)))];
        if r.below(2) == 0 {
            metadata.push(("http_route".to_string(), format!("/api/v1/resource/{}", r.below(50))));
        }
        metadata.sort();
        bytes += 80 + line.len();
        rows.push(LogRow {
            entry: r.below(streams.len() as u64) as u32,
            ts: T0 + r.below(3_600_000_000_000) as i64,
            observed_ts: 0,
            trace_id: if traced { r.bytes() } else { [0; 16] },
            span_id: if traced { r.bytes() } else { [0; 8] },
            flags: traced as u32,
            severity_number: [9, 9, 9, 13, 17, 5][r.below(6) as usize],
            line,
            severity_text: level.to_uppercase(),
            metadata,
        });
        if bytes > MAX_BATCH / 2 {
            out.push(otel::encode_logs(streams, &rows).unwrap());
            rows.clear();
            bytes = 0;
        }
    }
    if !rows.is_empty() {
        out.push(otel::encode_logs(streams, &rows).unwrap());
    }
    out
}


/// Each signal's files (units of about 20,000 rows) and its tail (the last batch). So that the
/// fixture stays small, each unit stands for ONE sequence number at the shard: the loader appends
/// a one-row placeholder batch per unit (never read: below the units' watermark), then the tail.
fn signal(batches: Vec<Vec<u8>>, spans: bool) -> serde_json::Value {
    let lake = batches.len() - 1;
    let mut units = Vec::new();
    let mut placeholders = Vec::new();
    let mut at = 0;
    let mut rows = 0usize;
    let mut start = 0;
    let count = |b: &[u8]| -> usize { u32::from_le_bytes([b[8], b[9], b[10], b[11]]) as usize };
    while at < lake {
        rows += count(&batches[at]);
        at += 1;
        if rows >= 20_000 || at == lake {
            let refs: Vec<&[u8]> = batches[start..at].iter().map(Vec::as_slice).collect();
            let files = if spans { encode_spans(&refs).unwrap() } else { encode_logs(&refs).unwrap() };
            let seq = units.len() + 1;
            units.push(json!({"seqLo": seq, "seqHi": seq, "files": files.iter().map(|f| json!({"table": f.table.as_str(), "day": f.day, "hour": f.hour, "rows": f.rows, "minNs": f.min_ts.to_string(), "maxNs": f.max_ts.to_string(), "index": f.index, "bytes": b64(&f.bytes)})).collect::<Vec<_>>()}));
            // One row of the unit's first batch, as a batch of its own.
            let first = &batches[start];
            let ph = if spans {
                let d = otel::decode_spans(first).unwrap();
                let mut row = d.rows[0].clone();
                row.entry = 0;
                otel::encode_spans(&d.entries[d.rows[0].entry as usize..=d.rows[0].entry as usize], &[row]).unwrap()
            } else {
                let d = otel::decode_logs(first).unwrap();
                let mut row = d.rows[0].clone();
                row.entry = 0;
                otel::encode_logs(&d.streams[d.rows[0].entry as usize..=d.rows[0].entry as usize], &[row]).unwrap()
            };
            placeholders.push(b64(&ph));
            start = at;
            rows = 0;
        }
    }
    json!({"batches": placeholders.into_iter().chain(std::iter::once(b64(&batches[lake]))).collect::<Vec<_>>(), "units": units, "lake": lake})
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (n_spans, n_logs): (usize, usize) = (args[1].parse().unwrap(), args[2].parse().unwrap());
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    let sb = span_batches(&mut r, &span_entries(), n_spans);
    let lb = log_batches(&mut r, &log_streams(), n_logs);
    // A sample of trace ids, from the lake's and the tail's batches.
    let mut ids = Vec::new();
    for b in sb.iter().step_by((sb.len() / 8).max(1)) {
        let d = otel::decode_spans(b).unwrap();
        ids.push(d.rows[d.rows.len() / 2].trace_id.iter().map(|x| format!("{x:02x}")).collect::<String>());
    }
    let out = json!({"spans": signal(sb, true), "logs": signal(lb, false), "traceIds": ids, "startNs": T0.to_string(), "endNs": (T0 + 3_600_000_000_000 + 20_000_000_000).to_string()});
    std::fs::write(&args[3], serde_json::to_string(&out).unwrap()).unwrap();
}
