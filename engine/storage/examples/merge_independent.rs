//! Compaction outputs for independent readers (AGENTS.md, "Independent readers"):
//!
//!   cargo run --release --example merge_independent -- DIR [CASES] [SEED]
//!   python3 -I tools/merge_independent_check.py DIR
//!
//! Writes CASES random cases (default 40). Each case is a few flush units of span and log batches
//! (random attributes of every type, NaN, -0 and infinities, Unicode, duplicates within and across
//! units, starts across an hour and a day boundary), flushed one unit at a time, then every
//! partition merged as compaction merges it (`spans` per hour, `trace_index` and `logs` per day,
//! inputs in unit order). DIR/manifest.json lists each output with its inputs in precedence order
//! and its index fragment; the Python check reads inputs and outputs with PyArrow and DuckDB and
//! computes what the output must hold from the inputs itself.
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use viz_storage::otel::{self, Attr, Event, Link, LogRow, LogStream, Span, SpanEntry, Value};
use viz_storage::{encode_logs_with, encode_spans_with, merge_signal_files_shared, SignalFile, SignalMergeOptions, SignalTable, SignalWriteOptions, NS_PER_DAY, NS_PER_HOUR};

/// 2023-11-15T00:00:00Z.
const MIDNIGHT: i64 = 1_700_006_400_000_000_000;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn int(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    fn chance(&mut self, p: f64) -> bool {
        (self.next() % 1_000_000) as f64 / 1e6 < p
    }
    fn pick<'a, T>(&mut self, v: &'a [T]) -> &'a T {
        &v[self.int(v.len() as u64) as usize]
    }
}

const WORDS: &[&str] = &["GET", "POST", "/api/users", "timeout", "error:", "connection", "refused", "naïve", "café", "日本語テキスト", "😀ok", "id", "x", "level=info", "msg=\"done\"", "Bearer"];

fn text(r: &mut Rng, words: usize) -> String {
    let mut s = String::new();
    for k in 0..words {
        if k > 0 {
            s.push(*r.pick(&[' ', '/', '=', ',', '-', '_']));
        }
        if r.chance(0.3) {
            s.push_str(&format!("req{:x}", r.int(1 << 24)));
        } else {
            s.push_str(r.pick(WORDS));
        }
    }
    s
}

fn value(r: &mut Rng) -> Value<String> {
    match r.int(8) {
        0 | 1 => Value::Str(text(r, 1 + r.int(3) as usize)),
        2 => Value::Int(r.next() as i64 >> r.int(60)),
        3 => Value::Double(*r.pick(&[f64::NAN.to_bits(), (-0.0f64).to_bits(), f64::INFINITY.to_bits(), f64::NEG_INFINITY.to_bits(), 1.5f64.to_bits(), (r.next() >> 2) ^ 0x3ff0_0000_0000_0000])),
        4 => Value::Bool(r.chance(0.5)),
        5 => Value::Other("{\"arrayValue\":{\"values\":[{\"stringValue\":\"a\"},{\"stringValue\":\"b\"}]}}".into()),
        _ => Value::Str(String::new()),
    }
}

fn attrs(r: &mut Rng, n: usize, keys: &[&str]) -> Vec<Attr<String>> {
    let mut m: BTreeMap<String, Value<String>> = BTreeMap::new();
    for _ in 0..n {
        let k = if r.chance(0.5) { r.pick(keys).to_string() } else { format!("k.{}", r.int(12)) };
        let v = match (k.as_str(), r.int(4)) {
            ("http.response.status_code", 0..=2) => Value::Int(200 + r.int(300) as i64),
            (_, _) => value(r),
        };
        m.insert(k, v);
    }
    m.into_iter().map(|(key, value)| Attr { key, value }).collect()
}

fn span_batch(r: &mut Rng, base: i64) -> (Vec<SpanEntry<String>>, Vec<Span<String>>) {
    let n_entries = 1 + r.int(3) as usize;
    let res_keys = ["service.name", "service.namespace", "deployment.environment.name", "k8s.pod.name", "cloud.region", "host.name"];
    let entries: Vec<SpanEntry<String>> = (0..n_entries)
        .map(|_| {
            let mut resource = attrs(r, r.int(5) as usize, &res_keys);
            if r.chance(0.8) {
                resource.retain(|a| a.key != "service.name");
                resource.push(Attr { key: "service.name".into(), value: Value::Str(format!("svc-{}", r.int(4))) });
                resource.sort_by(|a, b| a.key.as_bytes().cmp(b.key.as_bytes()));
            }
            SpanEntry {
                resource_fp: r.next() as i64,
                resource,
                scope_name: if r.chance(0.5) { "lib".into() } else { String::new() },
                scope_version: if r.chance(0.3) { "1.2".into() } else { String::new() },
                scope_attrs: if r.chance(0.2) { "[{\"key\":\"s\",\"value\":{\"intValue\":\"7\"}}]".into() } else { String::new() },
            }
        })
        .collect();
    let span_keys = ["http.request.method", "http.response.status_code", "http.route", "db.system.name", "rpc.service", "error.type"];
    let rows = (0..1 + r.int(30))
        .map(|_| {
            let start = base + r.int(2 * NS_PER_HOUR as u64) as i64 - NS_PER_HOUR / 2;
            let mut t = [0u8; 16];
            t[0] = 1 + r.int(6) as u8;
            t[15] = 1;
            Span {
                entry: r.int(n_entries as u64) as u32,
                trace_id: t,
                span_id: [1 + r.int(20) as u8, 0, 0, 0, 0, 0, 0, 1],
                parent_span_id: if r.chance(0.3) { [0; 8] } else { [1 + r.int(20) as u8, 0, 0, 0, 0, 0, 0, 1] },
                start,
                end: start + r.int(5_000_000_000) as i64,
                flags: if r.chance(0.5) { 0 } else { r.next() as u32 },
                dropped: [r.int(2) as u32, 0, r.int(2) as u32 * 7],
                kind: r.int(6) as u8,
                status: r.int(3) as u8,
                name: format!("op {}", r.int(6)),
                trace_state: if r.chance(0.2) { "k=v".into() } else { String::new() },
                status_message: if r.chance(0.2) { text(r, 2) } else { String::new() },
                attrs: attrs(r, r.int(7) as usize, &span_keys),
                events: (0..r.int(3)).map(|k| Event { time_unix_nano: start + k as i64, name: text(r, 1), attrs: "[]".into() }).collect(),
                links: (0..r.int(2)).map(|_| Link { trace_id: [9; 16], span_id: [8; 8], trace_state: String::new(), attrs: "[{\"key\":\"l\",\"value\":{\"boolValue\":true}}]".into() }).collect(),
            }
        })
        .collect();
    (entries, rows)
}

fn log_batch(r: &mut Rng, base: i64) -> (Vec<LogStream<String>>, Vec<LogRow<String>>) {
    let n_streams = 1 + r.int(3) as usize;
    let streams: Vec<LogStream<String>> = (0..n_streams)
        .map(|_| {
            let mut m: BTreeMap<String, String> = BTreeMap::new();
            if r.chance(0.8) {
                m.insert("service_name".into(), format!("svc-{}", r.int(3)));
            }
            m.insert("job".into(), r.pick(&["api", "worker", "é😀"]).to_string());
            if r.chance(0.4) {
                m.insert("env".into(), "prod".into());
            }
            let labels: Vec<(String, String)> = m.into_iter().collect();
            LogStream { stream_id: otel::stream_id(&labels), labels }
        })
        .collect();
    let rows = (0..1 + r.int(40))
        .map(|_| {
            let mut md: BTreeMap<String, String> = BTreeMap::new();
            for _ in 0..r.int(3) {
                md.insert(r.pick(&["user", "trace_id", "pod", "level"]).to_string(), text(r, 1 + r.int(2) as usize));
            }
            LogRow {
                entry: r.int(n_streams as u64) as u32,
                ts: base + r.int(4) as i64 - 2 + if r.chance(0.3) { r.int(2 * NS_PER_DAY as u64) as i64 - NS_PER_DAY } else { 0 },
                observed_ts: if r.chance(0.5) { 0 } else { base + 7 },
                trace_id: if r.chance(0.3) { [3; 16] } else { [0; 16] },
                span_id: if r.chance(0.3) { [4; 8] } else { [0; 8] },
                flags: if r.chance(0.7) { 0 } else { 1 },
                severity_number: r.int(25) as u8,
                line: if r.chance(0.1) { String::new() } else { text(r, 1 + r.int(8) as usize) },
                severity_text: if r.chance(0.5) { "INFO".into() } else { String::new() },
                metadata: md.into_iter().filter(|(_, v)| !v.is_empty()).collect(),
            }
        })
        .collect();
    (streams, rows)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = Path::new(args.get(1).expect("usage: merge_independent DIR [CASES] [SEED]"));
    let cases: usize = args.get(2).map_or(40, |s| s.parse().unwrap());
    let mut r = Rng(args.get(3).map_or(20261119, |s| s.parse().unwrap()) | 1);
    let _ = fs::remove_dir_all(dir);
    fs::create_dir_all(dir).unwrap();
    let mut manifest = Vec::new();
    let mut n_files = 0usize;
    for case in 0..cases {
        let opts = if r.chance(0.5) { SignalWriteOptions::default() } else { SignalWriteOptions { max_row_group_rows: 1 + r.int(12) as usize, max_row_group_bytes: 16 << 20, page_rows: 1 + r.int(5) as usize } };
        let base = MIDNIGHT + if r.chance(0.5) { 0 } else { NS_PER_HOUR * (1 + r.int(5) as i64) };
        let mut units: Vec<Vec<SignalFile>> = Vec::new();
        for _ in 0..2 + r.int(4) {
            let sb: Vec<Vec<u8>> = (0..1 + r.int(3))
                .map(|_| {
                    let (e, s) = span_batch(&mut r, base);
                    otel::encode_spans(&e, &s).unwrap()
                })
                .collect();
            let lb: Vec<Vec<u8>> = (0..1 + r.int(3))
                .map(|_| {
                    let (s, l) = log_batch(&mut r, base);
                    otel::encode_logs(&s, &l).unwrap()
                })
                .collect();
            let mut files = encode_spans_with(&sb.iter().map(Vec::as_slice).collect::<Vec<_>>(), &opts).unwrap();
            files.extend(encode_logs_with(&lb.iter().map(Vec::as_slice).collect::<Vec<_>>(), &opts).unwrap());
            units.push(files);
        }
        let cdir = dir.join(format!("case-{case:03}"));
        fs::create_dir_all(&cdir).unwrap();
        let mut write = |f: &SignalFile, name: String| -> String {
            let rel = format!("case-{case:03}/{name}");
            fs::write(dir.join(&rel), &f.bytes).unwrap();
            n_files += 1;
            rel
        };
        // Partitions, then their inputs in unit (precedence) order.
        let mut parts: BTreeMap<(u8, String, Option<u8>), Vec<(usize, &SignalFile)>> = BTreeMap::new();
        for (u, files) in units.iter().enumerate() {
            for f in files {
                let t = match f.table {
                    SignalTable::Spans => 0,
                    SignalTable::TraceIndex => 1,
                    SignalTable::Logs => 2,
                };
                parts.entry((t, f.day.clone(), f.hour)).or_default().push((u, f));
            }
        }
        for ((t, day, hour), inputs) in parts {
            let table = [SignalTable::Spans, SignalTable::TraceIndex, SignalTable::Logs][t as usize];
            let shared: Vec<bytes::Bytes> = inputs.iter().map(|(_, f)| bytes::Bytes::from(f.bytes.clone())).collect();
            let out = merge_signal_files_shared(table, &shared, &SignalMergeOptions { write: opts.clone(), ..Default::default() }).unwrap();
            let tag = format!("{}-{day}-{}", table.as_str(), hour.map_or("d".to_string(), |h| format!("h{h:02}")));
            let ins: Vec<String> = inputs.iter().map(|(u, f)| write(f, format!("in-{tag}-u{u}.parquet"))).collect();
            let path = write(&out, format!("out-{tag}.parquet"));
            manifest.push(serde_like_json(table.as_str(), &path, &ins, &out, &opts));
        }
        let _ = (NS_PER_DAY, cdir);
    }
    fs::write(dir.join("manifest.json"), format!("[\n{}\n]\n", manifest.join(",\n"))).unwrap();
    println!("{{\"cases\":{cases},\"outputs\":{},\"files\":{n_files}}}", manifest.len());
}

fn esc(s: &str) -> String {
    let mut o = String::new();
    viz_storage::json::write_string(&mut o, s);
    o
}

fn serde_like_json(table: &str, path: &str, inputs: &[String], out: &SignalFile, o: &SignalWriteOptions) -> String {
    format!(
        "{{\"table\":{},\"path\":{},\"inputs\":[{}],\"rows\":{},\"day\":{},\"hour\":{},\"index\":{},\"max_rg_rows\":{}}}",
        esc(table),
        esc(path),
        inputs.iter().map(|s| esc(s)).collect::<Vec<_>>().join(","),
        out.rows,
        esc(&out.day),
        out.hour.map_or("null".to_string(), |h| h.to_string()),
        esc(&out.index),
        o.max_row_group_rows
    )
}
