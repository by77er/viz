//! Encode throughput and output size for spans and log lines (engine/storage/README.md,
//! "Measurements").
//!
//!   cargo run --release --example otel_bench -- [million] [segment] [runs]
//!   cargo run --release --example otel_bench -- merge [inputs] [rows] [runs] [OUTDIR]
//!
//! `merge` (compaction, `merge_signal_files`): `inputs` flush units of `rows` spans and of `rows`
//! log lines each, flushed one unit at a time; then the units' files of one hour of `spans`, of
//! one day of `trace_index` and of `logs` merged as compaction merges them (inputs in unit order),
//! timed alone (min of `runs`). Prints input and output bytes, the token filter's bytes, rows in
//! and out, and throughput. With OUTDIR, writes the inputs there for
//! `engine/wasm/tools/measure_signal_merge.mjs` (the same merges in WASM, with peak memory).
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
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

/// Counts heap bytes in use and their peak, to report a merge's peak memory natively.
struct Counting;
static NOW: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let n = NOW.fetch_add(l.size(), Relaxed) + l.size();
            PEAK.fetch_max(n, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        NOW.fetch_sub(l.size(), Relaxed);
    }
}
#[global_allocator]
static A: Counting = Counting;
use viz_storage::otel::{self, Attr, Event, Link, LogRow, LogStream, Span, SpanEntry, Value};
use viz_storage::{encode_logs, encode_spans, merge_signal_files_shared, SignalMergeOptions, SignalTable};

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

fn merge_bench(args: &[String]) {
    let inputs: usize = args.get(2).map_or(8, |x| x.parse().unwrap());
    let rows: usize = args.get(3).map_or(25_000, |x| x.parse().unwrap());
    let runs: usize = args.get(4).map_or(3, |x| x.parse().unwrap());
    let out_dir = args.get(5);
    let entries = span_entries();
    let streams = log_streams();
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    let mut files: Vec<(SignalTable, Vec<u8>)> = Vec::new();
    for _ in 0..inputs {
        let sb = span_batches(&mut r, &entries, rows);
        let lb = log_batches(&mut r, &streams, rows);
        let spans = encode_spans(&sb.iter().map(Vec::as_slice).collect::<Vec<_>>()).unwrap();
        // The hour with most spans (the generator spreads starts over one hour from T0, 400 s past an hour).
        let hour = spans.iter().filter(|f| f.table == SignalTable::Spans).max_by_key(|f| f.rows).unwrap().hour;
        for f in spans {
            if f.table == SignalTable::TraceIndex || f.hour == hour {
                files.push((f.table, f.bytes));
            }
        }
        for f in encode_logs(&lb.iter().map(Vec::as_slice).collect::<Vec<_>>()).unwrap() {
            files.push((SignalTable::Logs, f.bytes));
        }
    }
    if let Some(d) = out_dir {
        std::fs::create_dir_all(d).unwrap();
        let mut k = std::collections::HashMap::new();
        for (t, b) in &files {
            let n = k.entry(t.as_str()).or_insert(0);
            std::fs::write(format!("{d}/{}-{n:02}.parquet", t.as_str()), b).unwrap();
            *n += 1;
        }
    }
    for table in [SignalTable::Spans, SignalTable::TraceIndex, SignalTable::Logs] {
        let ins: Vec<bytes::Bytes> = files.iter().filter(|(t, _)| *t == table).map(|(_, b)| bytes::Bytes::from(b.clone())).collect();
        let in_bytes: usize = ins.iter().map(|b| b.len()).sum();
        let rows_in: i64 = ins
            .iter()
            .map(|b| {
                use parquet::file::reader::FileReader;
                parquet::file::reader::SerializedFileReader::new(b.clone()).unwrap().metadata().file_metadata().num_rows()
            })
            .sum();
        let mut times = Vec::new();
        let mut out = None;
        let cap: usize = std::env::var("MERGE_RG_BYTES").ok().map_or(viz_storage::MERGE_ROW_GROUP_BYTES, |v| v.parse().unwrap());
        let opts = SignalMergeOptions { write: viz_storage::SignalWriteOptions { max_row_group_bytes: cap, ..Default::default() }, ..Default::default() };
        let mut peak = 0;
        for _ in 0..runs {
            drop(out.take());
            let base = NOW.load(Relaxed);
            PEAK.store(base, Relaxed);
            let t = Instant::now();
            out = Some(merge_signal_files_shared(table, &ins, &opts).unwrap());
            times.push(t.elapsed().as_secs_f64());
            // Heap the merge added at its peak, plus the inputs it was handed (held throughout).
            peak = PEAK.load(Relaxed) - base + in_bytes;
        }
        let out = out.unwrap();
        let plain = merge_signal_files_shared(table, &ins, &SignalMergeOptions { token_filter: false, ..opts.clone() }).unwrap();
        if table == SignalTable::Logs {
            // What the filter saves a search for one request id (`|= "request_id=… "`): row groups kept.
            let (o, l) = viz_storage::tokens::token_filter_location(&out.bytes).unwrap();
            let f = viz_storage::tokens::TokenFilter::parse(&out.bytes[o as usize..(o + l) as usize]).unwrap();
            let rows = viz_storage::read_logs(&out.bytes).unwrap();
            let (mut kept, mut n) = (0usize, 0usize);
            for r in rows.iter().step_by(rows.len() / 50 + 1) {
                let Some(id) = r.line.split("request_id=").nth(1).and_then(|x| x.split(' ').next()) else { continue };
                let q = vec![vec![format!("request_id={id} ")]];
                kept += (0..f.n_row_groups()).filter(|g| f.may_match(*g, &q)).count();
                n += 1;
            }
            println!("logs: a search for one request id keeps {:.2} of {} row groups on average ({n} ids; {} distinct tokens)", kept as f64 / n as f64, f.n_row_groups(), f.n_tokens());
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let filter = out.bytes.len() - plain.bytes.len();
        println!(
            "{}: {} inputs, {:.2} MB in ({} rows), out {:.2} MB ({} rows, {} row groups){}; peak heap {:.1} MB with the inputs; merge {:.2} s (min of {runs}; all {}): {:.1} MB/s of input, {:.0} k rows/s",
            table.as_str(),
            ins.len(),
            in_bytes as f64 / 1e6,
            rows_in,
            out.bytes.len() as f64 / 1e6,
            out.rows,
            out.index.matches("\"rows\"").count(),
            if table == SignalTable::Logs { format!(", of which token filter {:.2} MB ({:.1}% of the file)", filter as f64 / 1e6, 100.0 * filter as f64 / out.bytes.len() as f64) } else { String::new() },
            peak as f64 / 1048576.0,
            times[0],
            times.iter().map(|t| format!("{t:.2}")).collect::<Vec<_>>().join(", "),
            in_bytes as f64 / 1e6 / times[0],
            out.rows as f64 / 1e3 / times[0],
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("merge") {
        return merge_bench(&args);
    }
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
