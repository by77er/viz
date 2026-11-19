//! Encode throughput and output size for spans and log lines (engine/storage/README.md,
//! "Measurements").
//!
//!   cargo run --release --example otel_bench -- [million] [segment] [runs]
//!
//! Generates synthetic data deterministically (a fixed xorshift seed), builds VZB1 signal 2
//! and 3 batches of at most 1 MiB with `otel::encode_spans` / `encode_logs`, and times only
//! `encode_spans` / `encode_logs` (the flush), one segment of `segment` rows at a time, so
//! memory stays at one segment. Prints rows, input batch bytes, output Parquet bytes and the
//! encode time, per million rows.
//!
//! The generator, per span: one of 20 services x 5 instances (resource: service.name,
//! service.namespace, service.instance.id, deployment.environment.name, k8s.pod.name,
//! host.name), one of 200 span names, kind and status (8% errors), a random 16-byte trace id
//! shared by ~12 spans, a log-uniform duration from 1 µs to 10 s, start times spread over one
//! hour, attributes http.request.method, http.response.status_code (int), http.route (one of
//! 50), user.id (random, high cardinality), a double, a bool and, on 30%, a db.statement of
//! 40-200 bytes; 10% have an exception event, 2% a link. Per log line: one of 50 streams
//! (service_name, namespace, pod), a logfmt line of 80-260 bytes with a random request id and
//! a duration, 2-4 metadata entries (level, user, http_route), 30% with trace and span ids,
//! severity number and text.
use std::time::Instant;
use viz_storage::otel::{self, Attr, Event, Link, LogRow, LogStream, Span, SpanEntry, Value};
use viz_storage::{encode_logs, encode_spans};

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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let million: f64 = args.get(1).map_or(1.0, |x| x.parse().unwrap());
    let segment: usize = args.get(2).map_or(20_000, |x| x.parse().unwrap());
    let runs: usize = args.get(3).map_or(3, |x| x.parse().unwrap());
    let total = (million * 1e6) as usize;
    let entries = span_entries();
    let streams = log_streams();
    for kind in ["spans", "logs"] {
        let mut times = Vec::new();
        let (mut rows, mut input, mut output, mut files) = (0u64, 0u64, 0u64, 0u64);
        for run in 0..runs {
            let mut r = Rng(0x9e37_79b9_7f4a_7c15);
            let (mut t, mut done) = (0f64, 0usize);
            let (mut rr, mut ii, mut oo, mut ff) = (0u64, 0u64, 0u64, 0u64);
            while done < total {
                let n = segment.min(total - done);
                let batches = if kind == "spans" { span_batches(&mut r, &entries, n) } else { log_batches(&mut r, &streams, n) };
                let refs: Vec<&[u8]> = batches.iter().map(Vec::as_slice).collect();
                let start = Instant::now();
                let out = if kind == "spans" { encode_spans(&refs).unwrap() } else { encode_logs(&refs).unwrap() };
                t += start.elapsed().as_secs_f64();
                ii += batches.iter().map(|b| b.len() as u64).sum::<u64>();
                oo += out.iter().map(|f| f.bytes.len() as u64).sum::<u64>();
                rr += out.iter().filter(|f| f.table != viz_storage::SignalTable::TraceIndex).map(|f| f.rows).sum::<u64>();
                ff += out.len() as u64;
                done += n;
            }
            times.push(t);
            if run == 0 {
                (rows, input, output, files) = (rr, ii, oo, ff);
            }
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let per_m = 1e6 / rows as f64;
        println!(
            "{kind}: rows {rows} in {} segments of {segment} ({files} files); input batches {:.1} MB, Parquet {:.1} MB; per million rows: input {:.1} MB, output {:.1} MB, encode {:.2} s (min of {runs}; all: {})",
            total.div_ceil(segment),
            input as f64 / 1e6,
            output as f64 / 1e6,
            input as f64 / 1e6 * per_m,
            output as f64 / 1e6 * per_m,
            times[0] * per_m,
            times.iter().map(|t| format!("{:.2}", t * per_m)).collect::<Vec<_>>().join(", ")
        );
    }
}
