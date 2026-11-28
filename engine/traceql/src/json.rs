//! Tempo HTTP API JSON: the `/api/search` response and the `/api/metrics/query_range` and
//! `/api/metrics/query` responses, in the protobuf-JSON form Tempo's own types use (64-bit
//! integers as strings, `AnyValue` objects for attribute values, empty fields omitted).
//! The differential harness decodes this output with Tempo's protobuf types (strict, unknown
//! fields rejected), an independent reader.

use crate::eval::format_float;
use crate::metrics::{RangeRequest, Series};
use crate::value::{go_duration, Val};
use crate::{SearchResponse, Stats};

/// Where the writers below put text: a `String`, or a counter of the bytes they would write
/// (`Len`), so that a caller can charge an answer's exact length before it is written.
pub trait Sink {
    fn push_str(&mut self, s: &str);
    fn push(&mut self, c: char);
}

impl Sink for String {
    fn push_str(&mut self, s: &str) {
        String::push_str(self, s)
    }
    fn push(&mut self, c: char) {
        String::push(self, c)
    }
}

/// Counts the bytes a writer would produce, without holding them.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Len(pub u64);

impl Sink for Len {
    fn push_str(&mut self, s: &str) {
        self.0 += s.len() as u64;
    }
    fn push(&mut self, c: char) {
        self.0 += c.len_utf8() as u64;
    }
}

pub fn escape<S: Sink>(s: &str, out: &mut S) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn double<S: Sink>(v: f64, out: &mut S) {
    if v.is_nan() {
        out.push_str("\"NaN\"");
    } else if v.is_infinite() {
        out.push_str(if v > 0.0 { "\"Infinity\"" } else { "\"-Infinity\"" });
    } else {
        out.push_str(&format_float(v));
    }
}

/// An OTLP `AnyValue` object.
pub fn any_value<S: Sink>(v: &Val, out: &mut S) {
    match v {
        Val::Nil => out.push_str("{\"stringValue\":\"nil\"}"),
        Val::Bool(b) => out.push_str(if *b { "{\"boolValue\":true}" } else { "{\"boolValue\":false}" }),
        Val::Int(i) => {
            out.push_str("{\"intValue\":\"");
            out.push_str(&i.to_string());
            out.push_str("\"}");
        }
        Val::Float(f) => {
            out.push_str("{\"doubleValue\":");
            double(*f, out);
            out.push('}');
        }
        Val::Str(s) => {
            out.push_str("{\"stringValue\":");
            escape(s, out);
            out.push('}');
        }
        Val::Duration(d) => {
            out.push_str("{\"stringValue\":");
            escape(&go_duration(*d), out);
            out.push('}');
        }
        Val::Status(s) => {
            out.push_str("{\"stringValue\":\"");
            out.push_str(s.name());
            out.push_str("\"}");
        }
        Val::Kind(k) => {
            out.push_str("{\"stringValue\":\"");
            out.push_str(k.name());
            out.push_str("\"}");
        }
        Val::Arr(a) => {
            use crate::data::AttrValue;
            out.push_str("{\"arrayValue\":{\"values\":[");
            let mut first = true;
            let mut sep = |out: &mut S| {
                if !first {
                    out.push(',');
                }
                first = false;
            };
            match a {
                AttrValue::StrArray(x) => x.iter().for_each(|s| {
                    sep(out);
                    any_value(&Val::Str(s.as_str().into()), out)
                }),
                AttrValue::IntArray(x) => x.iter().for_each(|s| {
                    sep(out);
                    any_value(&Val::Int(*s), out)
                }),
                AttrValue::FloatArray(x) => x.iter().for_each(|s| {
                    sep(out);
                    any_value(&Val::Float(*s), out)
                }),
                AttrValue::BoolArray(x) => x.iter().for_each(|s| {
                    sep(out);
                    any_value(&Val::Bool(*s), out)
                }),
                _ => {}
            }
            out.push_str("]}}");
        }
    }
}

fn key_values<S: Sink>(kvs: &[(String, Val)], out: &mut S) {
    out.push('[');
    for (i, (k, v)) in kvs.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"key\":");
        escape(k, out);
        out.push_str(",\"value\":");
        any_value(v, out);
        out.push('}');
    }
    out.push(']');
}

fn stats<S: Sink>(s: &Stats, out: &mut S) {
    out.push_str("\"metrics\":{");
    let mut parts = Vec::new();
    if s.inspected_traces > 0 {
        parts.push(format!("\"inspectedTraces\":{}", s.inspected_traces.min(u32::MAX as u64)));
    }
    if s.inspected_spans > 0 {
        parts.push(format!("\"inspectedSpans\":\"{}\"", s.inspected_spans));
    }
    out.push_str(&parts.join(","));
    out.push('}');
}

pub fn search_json(r: &SearchResponse) -> String {
    let mut out = String::with_capacity(256 + r.traces.len() * 512);
    write_search(r, &mut out);
    out
}

/// The length in bytes of [`search_json`]'s text, without writing it.
pub fn search_json_len(r: &SearchResponse) -> u64 {
    let mut n = Len::default();
    write_search(r, &mut n);
    n.0
}

fn write_search<S: Sink>(r: &SearchResponse, out: &mut S) {
    out.push_str("{\"traces\":[");
    for (ti, t) in r.traces.iter().enumerate() {
        if ti > 0 {
            out.push(',');
        }
        out.push_str("{\"traceID\":");
        escape(&t.trace_id, out);
        if !t.root_service_name.is_empty() {
            out.push_str(",\"rootServiceName\":");
            escape(&t.root_service_name, out);
        }
        if !t.root_trace_name.is_empty() {
            out.push_str(",\"rootTraceName\":");
            escape(&t.root_trace_name, out);
        }
        out.push_str(&format!(",\"startTimeUnixNano\":\"{}\"", t.start_unix_nano));
        if t.duration_ms > 0 {
            out.push_str(&format!(",\"durationMs\":{}", t.duration_ms));
        }
        let spanset = |ss: &crate::SpansetResult, out: &mut S| {
            out.push_str("{\"spans\":[");
            for (si, s) in ss.spans.iter().enumerate() {
                if si > 0 {
                    out.push(',');
                }
                out.push_str("{\"spanID\":");
                escape(&s.span_id, out);
                if !s.name.is_empty() {
                    out.push_str(",\"name\":");
                    escape(&s.name, out);
                }
                out.push_str(&format!(",\"startTimeUnixNano\":\"{}\"", s.start_unix_nano));
                out.push_str(&format!(",\"durationNanos\":\"{}\"", s.duration_nanos));
                if !s.attributes.is_empty() {
                    out.push_str(",\"attributes\":");
                    key_values(&s.attributes, out);
                }
                out.push('}');
            }
            out.push(']');
            out.push_str(&format!(",\"matched\":{}", ss.matched));
            if !ss.attributes.is_empty() {
                out.push_str(",\"attributes\":");
                key_values(&ss.attributes, out);
            }
            out.push('}');
        };
        if let Some(first) = t.spansets.first() {
            out.push_str(",\"spanSet\":");
            spanset(first, out);
        }
        out.push_str(",\"spanSets\":[");
        for (i, ss) in t.spansets.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            spanset(ss, out);
        }
        out.push(']');
        if !t.service_stats.is_empty() {
            out.push_str(",\"serviceStats\":{");
            for (i, s) in t.service_stats.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                escape(&s.service, out);
                out.push_str(&format!(":{{\"spanCount\":{}", s.span_count));
                if s.error_count > 0 {
                    out.push_str(&format!(",\"errorCount\":{}", s.error_count));
                }
                out.push('}');
            }
            out.push('}');
        }
        out.push('}');
    }
    out.push_str("],");
    stats(&r.stats, out);
    out.push('}');
}

pub fn metrics_json(series: &[Series], req: &RangeRequest, st: &Stats) -> String {
    let mut out = String::with_capacity(128 + series.len() * 256);
    write_metrics(series, req, st, &mut out);
    out
}

/// The length in bytes of [`metrics_json`]'s text, without writing it.
pub fn metrics_json_len(series: &[Series], req: &RangeRequest, st: &Stats) -> u64 {
    let mut n = Len::default();
    write_metrics(series, req, st, &mut n);
    n.0
}

fn write_metrics<S: Sink>(series: &[Series], req: &RangeRequest, st: &Stats, out: &mut S) {
    out.push_str("{\"series\":[");
    for (i, s) in series.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"labels\":");
        key_values(&s.labels, out);
        out.push_str(",\"samples\":[");
        let mut first = true;
        for (k, v) in s.values.iter().enumerate() {
            if v.is_nan() {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&format!("{{\"timestampMs\":\"{}\",\"value\":", req.timestamp_ms(k)));
            double(*v, out);
            out.push('}');
        }
        out.push_str("]}");
    }
    out.push_str("],");
    stats(st, out);
    out.push('}');
}
