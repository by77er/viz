//! Generators and helpers for the span and log tests: random batches with every attribute
//! type, Unicode, empty values, duplicates, and timestamps around hour and day boundaries.
#![allow(dead_code)]
use proptest::prelude::*;
use std::collections::BTreeMap;
use viz_storage::otel::{self, Attr, Event, Link, LogRow, LogStream, Span, SpanEntry, Value};

/// 2023-11-15T00:00:00Z in nanoseconds.
pub const MIDNIGHT: i64 = 1_700_006_400_000_000_000;

#[derive(Debug, Clone)]
pub struct SpanBatchDef {
    pub entries: Vec<SpanEntry<String>>,
    pub rows: Vec<Span<String>>,
}

#[derive(Debug, Clone)]
pub struct LogBatchDef {
    pub streams: Vec<LogStream<String>>,
    pub rows: Vec<LogRow<String>>,
}

pub fn owned_attrs(a: &[Attr<&str>]) -> Vec<Attr<String>> {
    a.iter().map(|x| x.to_owned_attr()).collect()
}

pub fn owned_span(s: &Span<&str>) -> Span<String> {
    Span {
        entry: s.entry,
        trace_id: s.trace_id,
        span_id: s.span_id,
        parent_span_id: s.parent_span_id,
        start: s.start,
        end: s.end,
        flags: s.flags,
        dropped: s.dropped,
        kind: s.kind,
        status: s.status,
        name: s.name.to_string(),
        trace_state: s.trace_state.to_string(),
        status_message: s.status_message.to_string(),
        attrs: owned_attrs(&s.attrs),
        events: s.events.iter().map(|e| Event { time_unix_nano: e.time_unix_nano, name: e.name.to_string(), attrs: e.attrs.to_string() }).collect(),
        links: s.links.iter().map(|l| Link { trace_id: l.trace_id, span_id: l.span_id, trace_state: l.trace_state.to_string(), attrs: l.attrs.to_string() }).collect(),
    }
}

pub fn owned_stream(s: &LogStream<&str>) -> LogStream<String> {
    LogStream { stream_id: s.stream_id, labels: s.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect() }
}

pub fn owned_log(r: &LogRow<&str>) -> LogRow<String> {
    LogRow {
        entry: r.entry,
        ts: r.ts,
        observed_ts: r.observed_ts,
        trace_id: r.trace_id,
        span_id: r.span_id,
        flags: r.flags,
        severity_number: r.severity_number,
        line: r.line.to_string(),
        severity_text: r.severity_text.to_string(),
        metadata: r.metadata.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect(),
    }
}

/// Sort by key (UTF-8 bytes) and keep the last of duplicate keys, as `edge` does.
pub fn sorted(attrs: Vec<Attr<String>>) -> Vec<Attr<String>> {
    let mut m: BTreeMap<String, Value<String>> = BTreeMap::new();
    for a in attrs {
        m.insert(a.key, a.value);
    }
    m.into_iter().map(|(key, value)| Attr { key, value }).collect()
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// FNV-1a 64 with 128-bit arithmetic, a second implementation of `series_id`'s function.
pub fn py_fnv(labels: &[(&str, &str)]) -> i64 {
    let mut h: u128 = 0xcbf29ce484222325;
    for (n, v) in labels {
        for b in n.bytes().chain([0]).chain(v.bytes()).chain([0]) {
            h ^= b as u128;
            h = (h * 0x100000001b3) % (1u128 << 64);
        }
    }
    h as u64 as i64
}

/// Strings: empty, short ASCII, Unicode (astral included), control characters.
pub fn arb_text() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => Just(String::new()),
        5 => "[a-z]{1,8}",
        3 => "\\PC{1,10}",
        1 => "[\\x00-\\x1f\"\\\\é€😀\u{e000}\u{ffff}]{1,6}",
    ]
}

const KEYS: &[&str] = &[
    "service.name",
    "service.namespace",
    "deployment.environment",
    "deployment.environment.name",
    "k8s.namespace.name",
    "k8s.pod.name",
    "cloud.region",
    "http.request.method",
    "http.response.status_code",
    "http.route",
    "db.system.name",
    "rpc.service",
    "error.type",
    "a",
    "b.c",
    "é",
    "😀",
    "\u{ffff}",
    "\u{10000}",
];

const OTHERS: &[&str] = &[
    "{}",
    "{\"arrayValue\":{}}",
    "{\"arrayValue\":{\"values\":[{\"stringValue\":\"a\"},{\"stringValue\":\"b\"}]}}",
    "{\"arrayValue\":{\"values\":[{\"intValue\":\"-1\"},{\"intValue\":\"9007199254740993\"}]}}",
    "{\"kvlistValue\":{\"values\":[{\"key\":\"k\",\"value\":{\"boolValue\":true}}]}}",
    "{\"bytesValue\":\"AAEC/w==\"}",
    "{\"arrayValue\":{\"values\":[{\"doubleValue\":\"NaN\"},{\"stringValue\":\"x\\\"}]\"}]}}",
];

pub fn arb_value() -> impl Strategy<Value = Value<String>> {
    prop_oneof![
        4 => arb_text().prop_map(Value::Str),
        2 => any::<i64>().prop_map(Value::Int),
        1 => prop_oneof![Just(i64::MIN), Just(i64::MAX), Just(0i64)].prop_map(Value::Int),
        2 => any::<u64>().prop_map(Value::Double),
        1 => prop_oneof![Just(0x7ff0_0000_0000_0002u64), Just(f64::NAN.to_bits()), Just((-0.0f64).to_bits()), Just(f64::INFINITY.to_bits())].prop_map(Value::Double),
        2 => any::<bool>().prop_map(Value::Bool),
        2 => prop::sample::select(OTHERS).prop_map(|s| Value::Other(s.to_string())),
    ]
}

pub fn arb_attrs(max: usize) -> impl Strategy<Value = Vec<Attr<String>>> {
    prop::collection::vec((prop_oneof![3 => prop::sample::select(KEYS).prop_map(str::to_string), 1 => "\\PC{1,6}"], arb_value()), 0..max)
        .prop_map(|v| sorted(v.into_iter().map(|(key, value)| Attr { key, value }).collect()))
}

fn arb_json_list() -> impl Strategy<Value = String> {
    prop_oneof![Just("[]".to_string()), Just("[{\"key\":\"e\",\"value\":{\"stringValue\":\"é\"}}]".to_string())]
}

fn nz16(b: u8) -> [u8; 16] {
    let mut x = [0u8; 16];
    x[0] = 0x40;
    x[15] = b;
    x
}

pub fn arb_entry() -> impl Strategy<Value = SpanEntry<String>> {
    (any::<i64>(), arb_attrs(6), prop_oneof![Just(String::new()), "[a-z/]{1,10}"], prop_oneof![Just(String::new()), "[0-9.]{1,5}"], prop_oneof![
        3 => Just(String::new()),
        1 => Just("[{\"key\":\"scope.attr\",\"value\":{\"intValue\":\"7\"}}]".to_string())
    ])
        .prop_map(|(resource_fp, resource, scope_name, scope_version, scope_attrs)| SpanEntry { resource_fp, resource, scope_name, scope_version, scope_attrs })
}

/// A span. Trace and span ids come from small pools so duplicates and many-span traces
/// are common; starts straddle an hour and a day boundary.
pub fn arb_span(n_entries: u32) -> impl Strategy<Value = Span<String>> {
    (
        (0..n_entries, 1u8..5, 1u8..9, prop_oneof![2 => Just(0u8), 3 => 1u8..9], -2 * 3_600_000_000_000i64..2 * 3_600_000_000_000, prop_oneof![Just(0i64), 0..10_000_000_000i64]),
        (prop_oneof![Just(0u32), any::<u32>()], prop::array::uniform3(prop_oneof![3 => Just(0u32), 1 => any::<u32>()]), 0u8..6, 0u8..3),
        (prop_oneof![2 => Just(String::new()), 2 => "[A-Z /{}]{1,12}", 1 => "\\PC{1,8}"], arb_text(), arb_text(), arb_attrs(7)),
        (prop::collection::vec((0..10_000_000_000i64, arb_text(), arb_json_list()), 0..3), prop::collection::vec((1u8..9, 1u8..9, arb_text(), arb_json_list()), 0..3)),
    )
        .prop_map(|((entry, t, s, p, off, dur), (flags, dropped, kind, status), (name, trace_state, status_message, attrs), (events, links))| Span {
            entry,
            trace_id: nz16(t),
            span_id: [s, 0, 0, 0, 0, 0, 0, 1],
            parent_span_id: if p == 0 { [0; 8] } else { [p, 0, 0, 0, 0, 0, 0, 1] },
            start: MIDNIGHT + off,
            end: MIDNIGHT + off + dur,
            flags,
            dropped,
            kind,
            status,
            name,
            trace_state,
            status_message,
            attrs,
            events: events.into_iter().map(|(time_unix_nano, name, attrs)| Event { time_unix_nano, name, attrs }).collect(),
            links: links.into_iter().map(|(t, s, trace_state, attrs)| Link { trace_id: nz16(t), span_id: [s; 8], trace_state, attrs }).collect(),
        })
}

pub fn arb_span_batch() -> impl Strategy<Value = SpanBatchDef> {
    (1u32..4).prop_flat_map(|n| (prop::collection::vec(arb_entry(), n as usize), prop::collection::vec(arb_span(n), 1..14)).prop_map(|(entries, rows)| SpanBatchDef { entries, rows }))
}

fn arb_name() -> impl Strategy<Value = String> {
    prop_oneof![Just("service_name".to_string()), Just("job".to_string()), Just("instance".to_string()), Just("_x".to_string()), "[a-z_][a-z0-9_]{0,6}"]
}

fn arb_label_value() -> impl Strategy<Value = String> {
    prop_oneof![4 => "[a-z0-9]{1,6}", 2 => "[^\\x00]{1,8}", 1 => Just("é😀\u{e000}".to_string())]
}

fn pairs(v: Vec<(String, String)>) -> Vec<(String, String)> {
    let m: BTreeMap<String, String> = v.into_iter().collect();
    m.into_iter().collect()
}

pub fn arb_stream() -> impl Strategy<Value = LogStream<String>> {
    prop::collection::vec((arb_name(), arb_label_value()), 1..5).prop_map(|v| {
        let labels = pairs(v);
        LogStream { stream_id: otel::stream_id(&labels), labels }
    })
}

pub fn arb_log(n_streams: u32) -> impl Strategy<Value = LogRow<String>> {
    (
        (0..n_streams, prop_oneof![3 => -3i64..3, 1 => -2 * 86_400_000_000_000i64..2 * 86_400_000_000_000], prop_oneof![Just(0i64), 1..i64::MAX]),
        (prop_oneof![Just([0u8; 16]), Just(nz16(9))], prop_oneof![Just([0u8; 8]), Just([3u8; 8])], prop_oneof![Just(0u32), any::<u32>()], 0u8..=24),
        (prop_oneof![3 => prop::sample::select(&["GET /", "error: boom", "", "level=info msg=\"x\""][..]).prop_map(str::to_string), 2 => "\\PC{0,30}", 1 => "[\\x00-\\x7f]{0,10}"], prop_oneof![Just(String::new()), Just("INFO".to_string()), "\\PC{1,4}"]),
        prop::collection::vec((arb_name(), arb_label_value()), 0..4),
    )
        .prop_map(|((entry, ts, observed_ts), (trace_id, span_id, flags, severity_number), (line, severity_text), md)| LogRow {
            entry,
            ts: MIDNIGHT + ts,
            observed_ts,
            trace_id,
            span_id,
            flags,
            severity_number,
            line,
            severity_text,
            metadata: pairs(md),
        })
}

pub fn arb_log_batch() -> impl Strategy<Value = LogBatchDef> {
    (1u32..4).prop_flat_map(|n| (prop::collection::vec(arb_stream(), n as usize), prop::collection::vec(arb_log(n), 1..16)).prop_map(|(streams, rows)| LogBatchDef { streams, rows }))
}

pub fn span(entry: u32, trace_id: [u8; 16], span_id: [u8; 8], start: i64) -> Span<String> {
    Span {
        entry,
        trace_id,
        span_id,
        parent_span_id: [0; 8],
        start,
        end: start + 1000,
        flags: 0,
        dropped: [0; 3],
        kind: 2,
        status: 0,
        name: "op".into(),
        trace_state: String::new(),
        status_message: String::new(),
        attrs: Vec::new(),
        events: Vec::new(),
        links: Vec::new(),
    }
}

pub fn log_row(entry: u32, ts: i64, line: &str) -> LogRow<String> {
    LogRow { entry, ts, observed_ts: 0, trace_id: [0; 16], span_id: [0; 8], flags: 0, severity_number: 0, line: line.into(), severity_text: String::new(), metadata: Vec::new() }
}

pub fn fixed_span_batch() -> SpanBatchDef {
    let entries = vec![SpanEntry {
        resource_fp: 42,
        resource: sorted(vec![Attr { key: "service.name".into(), value: Value::Str("api".into()) }, Attr { key: "host".into(), value: Value::Int(3) }]),
        scope_name: "lib".into(),
        scope_version: "1.0".into(),
        scope_attrs: String::new(),
    }];
    let mut a = span(0, nz16(1), [1; 8], MIDNIGHT);
    a.attrs = sorted(vec![Attr { key: "a".into(), value: Value::Str("x".into()) }, Attr { key: "b".into(), value: Value::Double(1.5f64.to_bits()) }]);
    a.events = vec![Event { time_unix_nano: MIDNIGHT + 5, name: "log".into(), attrs: "[]".into() }];
    a.links = vec![Link { trace_id: nz16(2), span_id: [2; 8], trace_state: "k=v".into(), attrs: "[]".into() }];
    let mut b = span(0, nz16(1), [2; 8], MIDNIGHT + 10);
    b.parent_span_id = [1; 8];
    SpanBatchDef { entries, rows: vec![a, b] }
}

pub fn fixed_log_batch() -> LogBatchDef {
    let labels = vec![("job".to_string(), "x".to_string()), ("service_name".to_string(), "é".to_string())];
    let streams = vec![LogStream { stream_id: otel::stream_id(&labels), labels }];
    let mut r = log_row(0, MIDNIGHT, "hello");
    r.metadata = vec![("level".into(), "info".into())];
    r.severity_number = 9;
    r.severity_text = "INFO".into();
    LogBatchDef { streams, rows: vec![r, log_row(0, MIDNIGHT + 1, "world")] }
}

/// Keep the first of duplicate (trace_id, span_id) rows only.
pub fn dedup_spans(mut b: SpanBatchDef) -> SpanBatchDef {
    let mut seen = std::collections::HashSet::new();
    b.rows.retain(|r| seen.insert((r.trace_id, r.span_id)));
    b
}

/// Keep the first of rows equal on the log row key only.
pub fn dedup_logs(mut b: LogBatchDef) -> LogBatchDef {
    let mut seen = std::collections::HashSet::new();
    let streams = b.streams.clone();
    b.rows.retain(|r| seen.insert((streams[r.entry as usize].stream_id, r.ts, r.line.clone(), r.metadata.clone())));
    b
}

/// A small JSON accessor over the crate's parser, for index fragments.
pub mod serde_like {
    use viz_storage::json::{parse as p, Value};

    #[derive(Debug, Clone)]
    pub struct J(pub Value);

    pub fn parse(s: &str) -> J {
        J(p(s).expect("index fragment parses"))
    }

    impl J {
        pub fn get(&self, k: &str) -> J {
            J(self.0.get(k).unwrap_or_else(|| panic!("missing {k}")).clone())
        }
        pub fn opt(&self, k: &str) -> Option<J> {
            self.0.get(k).map(|v| J(v.clone()))
        }
        pub fn int(&self) -> i64 {
            match &self.0 {
                Value::Int(i) => *i,
                v => panic!("not an int: {v:?}"),
            }
        }
        pub fn str(&self) -> String {
            match &self.0 {
                Value::String(s) => s.clone(),
                v => panic!("not a string: {v:?}"),
            }
        }
        pub fn arr(&self) -> Vec<J> {
            match &self.0 {
                Value::Array(a) => a.iter().cloned().map(J).collect(),
                v => panic!("not an array: {v:?}"),
            }
        }
    }
}
