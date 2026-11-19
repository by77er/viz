//! Exports generated data sets and queries, with viz's answers, for the black-box
//! differential run against Grafana Tempo (`tools/godiff`, `tools/compare.py`).
//!
//! ```text
//! VIZ_DIFF_OUT=/tmp/cases.json VIZ_DIFF_SEED=1 VIZ_DIFF_DATASETS=20 VIZ_DIFF_QUERIES=60 \
//!   cargo test --release --test differential -- --ignored --nocapture
//! ```

mod common;

use common::*;
use std::collections::HashMap;
use std::fmt::Write;
use viz_traceql::{query_range, search, AttrValue, MemSource, RangeRequest, SearchRequest, Trace};

fn esc(s: &str) -> String {
    let mut o = String::new();
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(o, "\\u{:04x}", c as u32);
            }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn f64s(v: f64) -> String {
    format!("{v:?}")
}

fn attrs_json(a: &[(String, AttrValue)]) -> String {
    let items: Vec<String> = a
        .iter()
        .map(|(k, v)| {
            let (t, val, arr): (&str, String, Vec<String>) = match v {
                AttrValue::Str(s) => ("str", s.clone(), vec![]),
                AttrValue::Int(i) => ("int", i.to_string(), vec![]),
                AttrValue::Float(f) => ("float", f64s(*f), vec![]),
                AttrValue::Bool(b) => ("bool", b.to_string(), vec![]),
                AttrValue::StrArray(x) => ("str_array", String::new(), x.clone()),
                AttrValue::IntArray(x) => ("int_array", String::new(), x.iter().map(|v| v.to_string()).collect()),
                AttrValue::FloatArray(x) => ("float_array", String::new(), x.iter().map(|v| f64s(*v)).collect()),
                AttrValue::BoolArray(x) => ("bool_array", String::new(), x.iter().map(|v| v.to_string()).collect()),
                AttrValue::Other(_) => ("str", String::new(), vec![]),
            };
            if t.ends_with("_array") {
                format!("{{\"key\":{},\"type\":\"{t}\",\"array\":[{}]}}", esc(k), arr.iter().map(|x| esc(x)).collect::<Vec<_>>().join(","))
            } else {
                format!("{{\"key\":{},\"type\":\"{t}\",\"value\":{}}}", esc(k), esc(&val))
            }
        })
        .collect();
    format!("[{}]", items.join(","))
}

fn dataset_json(traces: &[Trace]) -> String {
    let mut res: Vec<String> = Vec::new();
    let mut res_idx: HashMap<String, usize> = HashMap::new();
    let mut scopes: Vec<String> = Vec::new();
    let mut scope_idx: HashMap<String, usize> = HashMap::new();
    let mut spans = Vec::new();
    for t in traces {
        for s in &t.spans {
            let rj = attrs_json(&s.resource);
            let ri = *res_idx.entry(rj.clone()).or_insert_with(|| {
                res.push(rj.clone());
                res.len() - 1
            });
            let sj = format!("{{\"name\":{},\"version\":{},\"attrs\":{}}}", esc(&s.scope_name), esc(&s.scope_version), attrs_json(&s.scope_attrs));
            let si = *scope_idx.entry(sj.clone()).or_insert_with(|| {
                scopes.push(sj.clone());
                scopes.len() - 1
            });
            let events: Vec<String> = s
                .events
                .iter()
                .map(|e| format!("{{\"time\":\"{}\",\"name\":{},\"attrs\":{}}}", e.time_unix_nano, esc(&e.name), attrs_json(&e.attrs)))
                .collect();
            let links: Vec<String> = s
                .links
                .iter()
                .map(|l| {
                    format!(
                        "{{\"trace_id\":\"{}\",\"span_id\":\"{}\",\"trace_state\":{},\"attrs\":{}}}",
                        hex(&l.trace_id),
                        hex(&l.span_id),
                        esc(&l.trace_state),
                        attrs_json(&l.attrs)
                    )
                })
                .collect();
            spans.push(format!(
                "{{\"trace_id\":\"{}\",\"span_id\":\"{}\",\"parent_span_id\":\"{}\",\"name\":{},\"kind\":{},\"status_code\":{},\"status_message\":{},\"start\":\"{}\",\"end\":\"{}\",\"resource\":{},\"scope\":{},\"attrs\":{},\"events\":[{}],\"links\":[{}]}}",
                hex(&t.trace_id),
                hex(&s.span_id),
                s.parent_span_id.map(|p| hex(&p)).unwrap_or_default(),
                esc(&s.name),
                s.kind as i32,
                s.status as i32,
                esc(&s.status_message),
                s.start_unix_nano,
                s.end_unix_nano,
                ri,
                si,
                attrs_json(&s.attrs),
                events.join(","),
                links.join(",")
            ));
        }
    }
    format!("{{\"resources\":[{}],\"scopes\":[{}],\"spans\":[{}]}}", res.join(","), scopes.join(","), spans.join(","))
}

fn env(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[test]
#[ignore]
fn export_differential_cases() {
    let out = std::env::var("VIZ_DIFF_OUT").unwrap_or_else(|_| "/tmp/viz-traceql-cases.json".into());
    let seed = env("VIZ_DIFF_SEED", 1);
    let ndatasets = env("VIZ_DIFF_DATASETS", 20);
    let nq = env("VIZ_DIFF_QUERIES", 60);
    let quirks = env("VIZ_DIFF_QUIRKS", 0) == 1;
    let mut datasets = Vec::new();
    let mut cases = Vec::new();
    let mut id = 0;
    for d in 0..ndatasets {
        let o = Opts {
            traces: 10 + (d as usize * 7) % 50,
            max_spans: if d % 5 == 0 { 120 } else { 25 },
            odd_shapes: d % 3 == 1,
            mixed: quirks && d % 4 == 0,
            zero_ids: quirks && d % 4 == 2,
        };
        let data = dataset(seed * 1000 + d, &o);
        datasets.push(dataset_json(&data));
        let src = MemSource::new(data.clone());
        let mut g = QGen { r: Rng::new(seed * 7919 + d), data: &data, mixed: o.mixed, quirks, depth: env("VIZ_DIFF_DEPTH", 0) as u32 };
        for qi in 0..nq {
            let metrics = qi % 3 == 2;
            if !metrics {
                let q = g.search_query();
                let req = SearchRequest { limit: 100_000, spans_per_spanset: 100_000, start_unix_nano: 0, end_unix_nano: 0 };
                let viz = match search(&src, &q, &req) {
                    Ok(r) => r.to_json(),
                    Err(e) => format!("{{\"error\":{}}}", esc(&e.to_string())),
                };
                cases.push(format!(
                    "{{\"id\":{id},\"dataset\":{d},\"kind\":\"search\",\"query\":{},\"limit\":100000,\"spss\":100000,\"viz\":{viz}}}",
                    esc(&q)
                ));
            } else {
                let q = g.metrics_query();
                let (step, end_extra) = match g.r.below(4) {
                    0 => (30_000_000_000u64, 0u64),
                    1 => (7_000_000_000, 3_000_000_000),
                    2 => (60_000_000_000, 0),
                    _ => (600_000_000_000 + 3_000_000_000, 0),
                };
                let start = BASE;
                let end = BASE + (WINDOW_S + 5) * 1_000_000_000 + end_extra;
                let instant = step > 600_000_000_000;
                let req = if instant { RangeRequest::instant(start, end) } else { RangeRequest::range(start, end, step) };
                let viz = match query_range(&src, &q, &req) {
                    Ok(r) => r.to_json(),
                    Err(e) => format!("{{\"error\":{}}}", esc(&e.to_string())),
                };
                cases.push(format!(
                    "{{\"id\":{id},\"dataset\":{d},\"kind\":\"{}\",\"query\":{},\"start\":{},\"end\":{},\"step\":{},\"viz\":{viz}}}",
                    if instant { "instant" } else { "range" },
                    esc(&q),
                    req.start_unix_nano,
                    req.end_unix_nano,
                    req.step_nano
                ));
            }
            id += 1;
        }
    }
    let body = format!("{{\"datasets\":[{}],\"cases\":[{}]}}", datasets.join(","), cases.join(","));
    std::fs::write(&out, body).expect("write cases");
    eprintln!("wrote {} datasets, {} cases to {out}", ndatasets, id);
}
