//! Behaviour of the public API on a small hand-made trace set. Most expected answers here
//! are what Grafana Tempo v3.1.1 returned for the same data when probed as a black box
//! (README, "Differential run"); the others follow the documentation.

use viz_traceql::*;

const S: u64 = 1_700_000_000_000_000_000;
const MS: u64 = 1_000_000;

fn a(k: &str, v: AttrValue) -> (String, AttrValue) {
    (k.to_string(), v)
}
fn s(v: &str) -> AttrValue {
    AttrValue::Str(v.into())
}

fn res(svc: Option<&str>) -> Vec<(String, AttrValue)> {
    let mut r = vec![a("env", s("prod"))];
    if let Some(x) = svc {
        r.push(a("service.name", s(x)));
    }
    r
}

#[allow(clippy::too_many_arguments)]
fn span(id: u8, parent: Option<u8>, name: &str, svc: Option<&str>, kind: Kind, status: Status, start_ms: u64, dur_ms: u64, attrs: Vec<(String, AttrValue)>) -> Span {
    Span {
        span_id: [id; 8],
        parent_span_id: parent.map(|p| [p; 8]),
        name: name.into(),
        kind,
        status,
        start_unix_nano: S + start_ms * MS,
        end_unix_nano: S + (start_ms + dur_ms) * MS,
        resource: res(svc),
        attrs,
        scope_name: "lib".into(),
        scope_version: "1.0".into(),
        ..Default::default()
    }
}

/// Trace A: a1 (root, frontend) -> a2 (backend, error) -> a3 (db); a1 -> a4 (backend).
/// Trace B: b1 (root) -> b2. Trace D: d1 (root) -> d2; d3 has a missing parent -> d4.
fn data() -> Vec<Trace> {
    let mut a2 = span(0xa2, Some(0xa1), "db", Some("backend"), Kind::Client, Status::Error, 10, 500, vec![a("foo", s("baz")), a("n", AttrValue::Int(5)), a("f", AttrValue::Float(2.5))]);
    a2.status_message = "boom".into();
    a2.events = vec![
        Event { time_unix_nano: S + 15 * MS, name: "exception".into(), attrs: vec![a("ev", AttrValue::Int(1))] },
        Event { time_unix_nano: S + 20 * MS, name: "log".into(), attrs: vec![a("ev", AttrValue::Int(2))] },
    ];
    let ta = Trace::new(
        [0x0a; 16],
        vec![
            span(0xa1, None, "GET /", Some("frontend"), Kind::Server, Status::Unset, 0, 1000, vec![
                a("http.status_code", AttrValue::Int(200)),
                a("foo", s("bar")),
                a("b", AttrValue::Bool(true)),
                a("f", AttrValue::Float(1.5)),
                a("arr", AttrValue::StrArray(vec!["x".into(), "y".into()])),
                a("n", AttrValue::Int(3)),
            ]),
            a2,
            span(0xa3, Some(0xa2), "query", Some("db"), Kind::Internal, Status::Ok, 20, 200, vec![a("n", AttrValue::Int(7))]),
            span(0xa4, Some(0xa1), "cache", Some("backend"), Kind::Client, Status::Unset, 600, 50, vec![a("foo", s("bar")), a("n", AttrValue::Float(4.5))]),
        ],
    );
    let tb = Trace::new(
        [0x0b; 16],
        vec![
            span(0xb1, None, "POST /", Some("frontend"), Kind::Server, Status::Error, 5000, 300, vec![a("http.status_code", s("200"))]),
            span(0xb2, Some(0xb1), "db", Some("backend"), Kind::Client, Status::Unset, 5100, 100, vec![a("foo", s("bar"))]),
        ],
    );
    let td = Trace::new(
        [0x0d; 16],
        vec![
            span(0xd1, None, "droot", Some("frontend"), Kind::Server, Status::Unset, 12000, 100, vec![a("n", AttrValue::Int(1))]),
            span(0xd2, Some(0xd1), "dchild", Some("backend"), Kind::Client, Status::Unset, 12010, 10, vec![a("n", AttrValue::Int(2))]),
            span(0xd3, Some(0xee), "dorphan", Some("backend"), Kind::Client, Status::Unset, 12020, 10, vec![a("n", AttrValue::Int(3))]),
            span(0xd4, Some(0xd3), "dorphanchild", None, Kind::Internal, Status::Unset, 12030, 10, vec![a("n", AttrValue::Int(4))]),
        ],
    );
    vec![ta, tb, td]
}

/// Matched span ids (first byte) per trace, sorted, for a search.
fn matched(q: &str) -> Vec<(u8, Vec<u8>)> {
    let src = MemSource::new(data());
    let r = search(&src, q, &SearchRequest { limit: 100, spans_per_spanset: 100, ..Default::default() }).unwrap_or_else(|e| panic!("{q}: {e}"));
    let mut out: Vec<(u8, Vec<u8>)> = r
        .traces
        .iter()
        .map(|t| {
            let mut ids: Vec<u8> = t.spansets.iter().flat_map(|ss| ss.spans.iter().map(|sp| u8::from_str_radix(&sp.span_id[..2], 16).unwrap())).collect();
            ids.sort();
            ids.dedup();
            (u8::from_str_radix(&format!("{:0>32}", t.trace_id)[..2], 16).unwrap(), ids)
        })
        .collect();
    out.sort();
    out
}

fn ids(q: &str) -> Vec<u8> {
    let mut v: Vec<u8> = matched(q).into_iter().flat_map(|(_, s)| s).collect();
    v.sort();
    v
}

#[test]
fn filters_compare_typed_values() {
    assert_eq!(ids(r#"{ .foo = "bar" }"#), vec![0xa1, 0xa4, 0xb2]);
    assert_eq!(ids(r#"{ .foo != "bar" }"#), vec![0xa2], "a missing attribute fails !=");
    assert_eq!(ids(r#"{ span.foo != nil }"#), vec![0xa1, 0xa2, 0xa4, 0xb2]);
    assert_eq!(ids(r#"{ span.missing = nil }"#).len(), 10, "= nil holds for every span without the key");
    assert_eq!(ids(r#"{ .b }"#), vec![0xa1], "a bare boolean attribute");
    assert_eq!(ids(r#"{ .foo }"#), Vec::<u8>::new(), "a bare non-boolean is false");
    assert_eq!(ids(r#"{ .http.status_code = 200 }"#), vec![0xa1]);
    assert_eq!(ids(r#"{ .http.status_code = "200" }"#), vec![0xb1], "strings and ints never compare equal");
    // Numbers compare by value across int and float (Tempo's evaluator).
    assert_eq!(ids(r#"{ .n > 4 }"#), vec![0xa2, 0xa3, 0xa4]);
    assert_eq!(ids(r#"{ .n + 0 > 4 }"#), vec![0xa2, 0xa3, 0xa4]);
    assert_eq!(ids(r#"{ .n / 2 = 2 }"#), vec![0xa2, 0xd4], "integer division truncates");
    assert_eq!(ids(r#"{ .n % 2 = 1 }"#), vec![0xa1, 0xa2, 0xa3, 0xd1, 0xd3]);
    assert_eq!(ids(r#"{ -.n = -5 }"#), vec![0xa2]);
    assert_eq!(ids(r#"{ .n > .f }"#), vec![0xa1, 0xa2]);
    assert_eq!(ids(r#"{ duration > 200ms }"#), vec![0xa1, 0xa2, 0xb1]);
    assert_eq!(ids(r#"{ duration / 2 > 100ms }"#), vec![0xa1, 0xa2, 0xb1]);
}

#[test]
fn regex_is_anchored_and_arrays_match_elements() {
    assert_eq!(ids(r#"{ name =~ "GET" }"#), Vec::<u8>::new(), "fully anchored");
    assert_eq!(ids(r#"{ name =~ "GET.*" }"#), vec![0xa1]);
    assert_eq!(ids(r#"{ name !~ "d.*" }"#), vec![0xa1, 0xa3, 0xa4, 0xb1]);
    assert_eq!(ids(r#"{ .arr = "x" }"#), vec![0xa1]);
    assert_eq!(ids(r#"{ .arr =~ "x|q" }"#), vec![0xa1]);
    assert_eq!(ids(r#"{ .arr != "x" }"#), Vec::<u8>::new(), "!= on an array: no element equal");
    assert_eq!(ids(r#"{ .arr != "z" }"#), vec![0xa1]);
    assert_eq!(ids(r#"{ .arr > "a" }"#), vec![0xa1]);
}

#[test]
fn intrinsics_and_scopes() {
    assert_eq!(ids("{ status = error }"), vec![0xa2, 0xb1]);
    assert_eq!(ids("{ span:status = error }"), vec![0xa2, 0xb1]);
    assert_eq!(ids("{ kind = client }"), vec![0xa2, 0xa4, 0xb2, 0xd2, 0xd3]);
    assert_eq!(ids(r#"{ statusMessage = "boom" }"#), vec![0xa2]);
    assert_eq!(ids(r#"{ resource.service.name = "backend" }"#), vec![0xa2, 0xa4, 0xb2, 0xd2, 0xd3]);
    assert_eq!(ids(r#"{ resource.service.name = "" }"#), vec![0xd4], "a missing service.name reads as empty");
    assert_eq!(ids(r#"{ .env = "prod" && .n > 4 }"#), vec![0xa2, 0xa3, 0xa4], "unscoped: span, then resource");
    assert_eq!(ids(r#"{ trace:rootName = "GET /" }"#), vec![0xa1, 0xa2, 0xa3, 0xa4]);
    assert_eq!(ids(r#"{ trace:rootService = "frontend" }"#).len(), 10);
    assert_eq!(ids("{ trace:duration > 600ms }"), vec![0xa1, 0xa2, 0xa3, 0xa4]);
    assert_eq!(ids(r#"{ trace:id = "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a" }"#).len(), 4);
    assert_eq!(ids(r#"{ trace:id = "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a" }"#).len(), 4, "ids compare without leading zeros");
    assert_eq!(ids(r#"{ span:id = "a2a2a2a2a2a2a2a2" }"#), vec![0xa2]);
    assert_eq!(ids(r#"{ span:parentID = "a1a1a1a1a1a1a1a1" }"#), vec![0xa2, 0xa4]);
    assert_eq!(ids("{ span:childCount = 2 }"), vec![0xa1]);
    assert_eq!(ids("{ span:childCount = 1 }"), vec![0xa2, 0xb1, 0xd1, 0xd3], "children are counted whether or not the parent is connected");
    assert_eq!(ids(r#"{ event:name = "exception" }"#), vec![0xa2]);
    assert_eq!(ids(r#"{ event:name = "log" && event.ev = 1 }"#), Vec::<u8>::new(), "one event must satisfy the whole filter");
    assert_eq!(ids(r#"{ event:name = "log" && event.ev = 2 }"#), vec![0xa2]);
    assert_eq!(ids(r#"{ event.ev = 2 || name = "nope" }"#), vec![0xa2]);
    assert_eq!(ids("{ event:timeSinceStart > 7ms }"), vec![0xa2]);
    assert_eq!(ids(r#"{ instrumentation:name = "lib" }"#).len(), 10);
}

#[test]
fn and_or_share_one_precedence_level() {
    // Tempo: `a || b && c` is `(a || b) && c` (observed).
    assert_eq!(ids(r#"{ name = "GET /" || name = "db" && kind = client }"#), vec![0xa2, 0xb2]);
    assert_eq!(ids(r#"{ status = error || name = "GET /" && kind = server }"#), vec![0xa1, 0xb1]);
    assert_eq!(ids(r#"{ name = "db" && kind = client || name = "GET /" }"#), vec![0xa1, 0xa2, 0xb2]);
    assert_eq!(ids(r#"{ 1 + 2 * 3 = 7 }"#).len(), 10, "arithmetic precedence is the usual one");
}

#[test]
fn spanset_operators() {
    assert_eq!(matched(r#"{ name = "db" } && { name = "query" }"#), vec![(0x0a, vec![0xa2, 0xa3])]);
    assert_eq!(ids(r#"{ name = "db" } || { name = "cache" }"#), vec![0xa2, 0xa4, 0xb2]);
    assert_eq!(ids(r#"{ name = "GET /" } > { }"#), vec![0xa2, 0xa4]);
    assert_eq!(ids(r#"{ name = "GET /" } >> { }"#), vec![0xa2, 0xa3, 0xa4]);
    assert_eq!(ids(r#"{ name = "query" } < { }"#), vec![0xa2]);
    assert_eq!(ids(r#"{ name = "query" } << { }"#), vec![0xa1, 0xa2]);
    assert_eq!(ids(r#"{ name = "db" } ~ { }"#), vec![0xa4]);
    assert_eq!(ids(r#"{ name = "db" } &~ { }"#), vec![0xa2, 0xa4]);
    assert_eq!(ids(r#"{ name = "GET /" } &> { }"#), vec![0xa1, 0xa2, 0xa4]);
    assert_eq!(ids(r#"{ } &>> { name = "query" }"#), vec![0xa1, 0xa2, 0xa3]);
    assert_eq!(ids(r#"{ } &<< { name = "query" }"#), Vec::<u8>::new());
    assert_eq!(ids(r#"{ name = "GET /" } !> { }"#), vec![0xa1, 0xa3, 0xb1, 0xb2, 0xd1, 0xd2]);
    assert_eq!(ids(r#"{ } !< { }"#), vec![0xa3, 0xa4, 0xb2, 0xd2], "leaves; spans not connected to a root take no part");
    assert_eq!(ids(r#"{ } > { }"#), vec![0xa2, 0xa3, 0xa4, 0xb2, 0xd2]);
    // Precedence: structural operators bind tighter than && and ||.
    assert_eq!(ids(r#"{ } || { name = "nope" } > { }"#).len(), 10);
    assert_eq!(ids(r#"{ name = "GET /" } > { } > { }"#), vec![0xa3], "left-associative");
}

#[test]
fn pipelines_aggregates_by_coalesce_select() {
    let src = MemSource::new(data());
    let run = |q: &str| search(&src, q, &SearchRequest { limit: 100, spans_per_spanset: 100, ..Default::default() }).unwrap();
    let r = run("{ } | count() > 3");
    assert_eq!(r.traces.len(), 2);
    assert!(r.traces.iter().all(|t| t.spansets[0].attributes == vec![("count()".to_string(), value::Val::Int(4))]));
    let r = run("{ } | avg(.n) > 3");
    let a = r.traces.iter().find(|t| t.trace_id.starts_with("a0")).unwrap();
    assert_eq!(a.spansets[0].attributes[0], ("avg(.n)".to_string(), value::Val::Float((3.0 + 5.0 + 7.0 + 4.5) / 4.0)));
    assert_eq!(ids("{ } | max(span:duration) > 900ms"), vec![0xa1, 0xa2, 0xa3, 0xa4]);
    let r = run("{ } | sum(span:duration) > 1s");
    assert_eq!(r.traces[0].spansets[0].attributes[0].0, "sum(duration)", "scoped intrinsics print with their legacy names");
    assert_eq!(ids("{ } | max(.missing) != 3"), Vec::<u8>::new(), "an aggregate over no values fails every comparison");
    let r = run("{ } | by(resource.service.name) | count() > 1");
    let keys: Vec<String> = r.traces.iter().flat_map(|t| t.spansets.iter().map(|s| format!("{:?}", s.attributes))).collect();
    assert!(keys.iter().all(|k| k.contains("by(resource.service.name)") && k.contains("backend")), "{keys:?}");
    assert_eq!(run("{ } | by(resource.service.name) | coalesce()").traces[0].spansets.len(), 1);
    let r = run(r#"{ name = "db" } | select(.foo, span:parentID, status)"#);
    let sp = &r.traces.iter().find(|t| t.trace_id.starts_with("a0")).unwrap().spansets[0].spans[0];
    let keys: Vec<&str> = sp.attributes.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, vec!["foo", "span:parentID", "status"]);
    assert_eq!(ids(r#"{ name = "db" } | { .foo = "bar" }"#), vec![0xb2]);
    assert_eq!(ids("count() > 3"), ids("{ } | count() > 3"));
}

#[test]
fn search_json_has_tempo_shape() {
    let src = MemSource::new(data());
    let r = search(&src, r#"{ status = error }"#, &SearchRequest::default()).unwrap();
    let j: serde_json::Value = serde_json::from_str(&r.to_json()).unwrap();
    let t = &j["traces"].as_array().unwrap().iter().find(|t| t["traceID"] == "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a").expect("trace id without leading zero").clone();
    assert_eq!(t["rootServiceName"], "frontend");
    assert_eq!(t["rootTraceName"], "GET /");
    assert_eq!(t["startTimeUnixNano"], "1700000000000000000");
    assert_eq!(t["durationMs"], 1000);
    assert_eq!(t["spanSet"], t["spanSets"][0]);
    assert_eq!(t["spanSets"][0]["matched"], 1);
    let sp = &t["spanSets"][0]["spans"][0];
    assert_eq!(sp["spanID"], "a2a2a2a2a2a2a2a2");
    assert_eq!(sp["durationNanos"], "500000000");
    assert_eq!(sp["attributes"][0], serde_json::json!({"key": "status", "value": {"stringValue": "error"}}));
    assert_eq!(t["serviceStats"]["backend"], serde_json::json!({"spanCount": 2, "errorCount": 1}));
    assert_eq!(t["serviceStats"]["db"], serde_json::json!({"spanCount": 1}));
    // Most recent first, and limits.
    let r = search(&src, "{ }", &SearchRequest { limit: 2, spans_per_spanset: 1, ..Default::default() }).unwrap();
    assert_eq!(r.traces.len(), 2);
    assert!(r.traces[0].start_unix_nano > r.traces[1].start_unix_nano);
    assert_eq!(r.traces[0].spansets[0].spans.len(), 1);
    assert_eq!(r.traces[0].spansets[0].matched, 4);
    // A time window keeps traces that overlap it.
    let r = search(&src, "{ }", &SearchRequest { start_unix_nano: S + 4_000 * MS, end_unix_nano: S + 6_000 * MS, ..Default::default() }).unwrap();
    assert_eq!(r.traces.len(), 1);
}

fn series(q: &str, req: RangeRequest) -> Vec<(String, Vec<(i64, f64)>)> {
    let src = MemSource::new(data());
    let r = query_range(&src, q, &req).unwrap_or_else(|e| panic!("{q}: {e}"));
    r.series
        .iter()
        .map(|s| {
            let l = s.labels.iter().map(|(k, v)| format!("{k}={v:?}")).collect::<Vec<_>>().join(",");
            let pts = s.values.iter().enumerate().filter(|(_, v)| !v.is_nan()).map(|(k, v)| ((r.request.timestamp_ms(k) - 1_700_000_000_000) / 1000, *v)).collect();
            (l, pts)
        })
        .collect()
}

#[test]
fn metrics_grid_counts_and_rates() {
    let req = RangeRequest::range(S, S + 20_000 * MS, 1_000 * MS);
    let c = series("{ } | count_over_time()", req);
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].0, r#"__name__=Str("count_over_time")"#);
    let nz: Vec<(i64, f64)> = c[0].1.iter().copied().filter(|(_, v)| *v != 0.0).collect();
    // a1 starts exactly at `start` and is excluded; (t - step, t] buckets.
    assert_eq!(nz, vec![(1, 3.0), (5, 1.0), (6, 1.0), (12, 1.0), (13, 3.0)]);
    assert_eq!(c[0].1.len(), 20, "count_over_time returns zeros for empty points");
    // Points are multiples of the step in Unix time, from the first after start.
    let c = series("{ } | count_over_time()", RangeRequest::range(S, S + 20_000 * MS, 3_000 * MS));
    assert_eq!(c[0].1.iter().map(|p| p.0).collect::<Vec<_>>(), vec![1, 4, 7, 10, 13, 16, 19, 22]);
    assert_eq!(c[0].1[0].1, 3.0);
    let r = series("{ } | rate()", RangeRequest::range(S, S + 20_000 * MS, 3_000 * MS));
    assert_eq!(r[0].1[0].1, 1.0);
    let i = series("{ } | rate()", RangeRequest::instant(S, S + 20_000 * MS));
    assert_eq!(i[0].1, vec![(20, 9.0 / 20.0)]);
    let e = series(r#"{ name = "nothing" } | count_over_time()"#, req);
    assert_eq!(e.len(), 1, "count without by returns its series even when empty");
    assert!(series(r#"{ name = "nothing" } | rate() by (.foo)"#, req).is_empty());
}

#[test]
fn metrics_values_and_labels() {
    let req = RangeRequest::range(S, S + 20_000 * MS, 1_000 * MS);
    assert_eq!(series("{ } | sum_over_time(.n)", req)[0].1, vec![(1, 16.5), (12, 1.0), (13, 9.0)]);
    assert_eq!(series("{ } | avg_over_time(.n)", req)[0].1, vec![(1, 5.5), (12, 1.0), (13, 3.0)]);
    assert_eq!(series("{ } | max_over_time(.n)", req)[0].1, vec![(1, 7.0), (12, 1.0), (13, 4.0)]);
    assert_eq!(series("{ } | min_over_time(duration)", req)[0].1[0], (1, 0.05), "durations in seconds");
    let by = series("{ } | count_over_time() by (.foo)", RangeRequest::instant(S, S + 20_000 * MS));
    let labels: Vec<&str> = by.iter().map(|s| s.0.as_str()).collect();
    assert_eq!(labels, vec![r#".foo=Str("bar")"#, r#".foo=Str("baz")"#, r#".foo=Str("nil")"#]);
    let by2 = series("{ } | count_over_time() by (.foo, resource.service.name)", RangeRequest::instant(S, S + 20_000 * MS));
    assert!(by2.iter().any(|s| s.0 == r#"resource.service.name=Str("db")"#), "nil group values are left out: {by2:?}");
    let k = series("{ } | count_over_time() by (span:kind)", RangeRequest::instant(S, S + 20_000 * MS));
    assert!(k.iter().all(|s| s.0.starts_with("kind=")), "{k:?}");
}

#[test]
fn quantiles_and_histograms_use_log2_buckets() {
    use std::collections::HashMap;
    // Tempo's observed answers: four values in the 2^24 bucket.
    let h: HashMap<u32, u64> = [(24, 4)].into_iter().collect();
    assert!((metrics::quantile(0.5, &h) - 2f64.powf(23.5)).abs() < 1e-3);
    assert!((metrics::quantile(0.0, &h) - 2f64.powf(23.25)).abs() < 1e-3);
    assert_eq!(metrics::quantile(1.0, &h), 2f64.powi(24));
    // Interpolation starts at the previous non-empty bucket: {2^26:1, 2^30:2, 2^32:1}.
    let h: HashMap<u32, u64> = [(26, 1), (30, 2), (32, 1)].into_iter().collect();
    assert_eq!(metrics::quantile(0.5, &h), 2f64.powi(28));
    assert_eq!(metrics::quantile(0.75, &h), 2f64.powi(30));
    let req = RangeRequest::instant(S, S + 20_000 * MS);
    let q = series("{ } | quantile_over_time(duration, 0.5)", req);
    assert_eq!(q[0].0, "p=Float(0.5)");
    let hs = series("{ } | histogram_over_time(duration)", req);
    assert!(hs.iter().all(|s| s.0.starts_with("__bucket=Float(")), "{hs:?}");
    let total: f64 = hs.iter().map(|s| s.1[0].1).sum();
    assert_eq!(total, 9.0, "the nine spans after start");
    assert!(series("{ } | quantile_over_time(.f, 0.5)", req).is_empty(), "float values are not counted");
}

#[test]
fn second_stages_and_arithmetic() {
    let req = RangeRequest::range(S, S + 20_000 * MS, 1_000 * MS);
    let t = series("{ } | count_over_time() by (resource.service.name) | topk(1)", req);
    for ts in [1, 5, 13] {
        let at: Vec<f64> = t.iter().filter_map(|s| s.1.iter().find(|p| p.0 == ts).map(|p| p.1)).collect();
        assert_eq!(at.len(), 1, "one series per point at {ts}");
    }
    let f = series("{ } | count_over_time() by (resource.service.name) > 1", req);
    assert_eq!(f, vec![(r#"resource.service.name=Str("backend")"#.to_string(), vec![(1, 2.0), (13, 2.0)])]);
    let d = series(r#"({ } | count_over_time()) / ({ status = error } | count_over_time())"#, req);
    assert_eq!(d[0].0, r#"__name__=Str("(count_over_time / count_over_time)")"#);
    assert_eq!(d[0].1, vec![(1, 3.0), (5, 1.0)], "division by zero is NaN and leaves no sample");
    let s = series("({ } | avg_over_time(.n)) - 1", req);
    assert_eq!(s[0].1, vec![(1, 4.5), (12, 0.0), (13, 2.0)]);
    assert_eq!(series("(1 / 2) + ({ } | count_over_time())", req)[0].1[0], (1, 3.0), "integer constant folding");
}

#[test]
fn errors_have_positions_and_unsupported_is_explicit() {
    match parse("{ .a = 1 } | rate() == 2") {
        Err(Error::Parse { line: 1, col, .. }) => assert!(col > 1),
        other => panic!("{other:?}"),
    }
    match parse("{ status }") {
        Err(Error::Validation { .. }) => {}
        other => panic!("{other:?}"),
    }
    match parse("{\n  .a = 1 &&\n  status > ok }") {
        Err(Error::Validation { .. }) => {}
        other => panic!("{other:?}"),
    }
    match parse("{ .a = \n 1 ") {
        Err(Error::Parse { line: 2, .. }) => {}
        other => panic!("{other:?}"),
    }
    for q in [
        "{ parent.span.a = 1 }",
        "{ nestedSetLeft > 3 }",
        "{ } | compare({ status = error })",
        "{ } | rate() with (extrapolate=true)",
        "min(.a) < max(.b)",
    ] {
        assert!(matches!(parse(q), Err(Error::Unsupported(_))), "{q}");
    }
    let deep = format!("{}{{ .a = 1 }}{}", "(".repeat(300), ")".repeat(300));
    assert!(parse(&deep).is_err(), "nesting depth is limited");
    let src = MemSource::new(data());
    assert!(matches!(
        query_range(&src, "{ } | rate()", &RangeRequest::range(0, 20_000_000 * MS, 1)),
        Err(Error::Eval(_))
    ));
    assert!(matches!(search(&src, "{ } | rate()", &SearchRequest::default()), Err(Error::Eval(_))));
}

#[test]
fn plans_say_what_a_query_reads() {
    let p = plan(r#"{ resource.service.name = "x" && span.http.status_code >= 500 } | rate() by (span:name)"#, S, S + 60_000 * MS).unwrap();
    assert!(p.columns.contains(&Column::Attr(ast::Scope::Resource, "service.name".into())));
    assert!(p.columns.contains(&Column::Attr(ast::Scope::Span, "http.status_code".into())));
    assert!(p.columns.contains(&Column::Intrinsic(ast::Intrinsic::Name)));
    assert!(!p.full_traces);
    assert!(p.span_local);
    assert_eq!(p.span_window, Some((S, S + 60_000 * MS)));
    assert!(matches!(p.span_filter, Pred::Filter(_)));
    let p = plan(r#"{ name = "a" } >> { name = "b" }"#, 0, 0).unwrap();
    assert!(p.full_traces, "structural operators need whole traces");
    assert_eq!(p.span_filter, Pred::True);
    assert!(matches!(p.trace_filter, Pred::And(_)));
    let p = plan(r#"{ name = "a" } !> { name = "b" }"#, 0, 0).unwrap();
    assert!(matches!(p.trace_filter, Pred::Filter(_)), "a negated operator needs only its right side");
    let p = plan("{ span:childCount > 1 }", 0, 0).unwrap();
    assert!(p.full_traces);
}

#[test]
fn align_request_matches_tempo() {
    // Observed with Tempo's AlignRequest: start down to a step multiple and one more step,
    // end up to a step multiple; a one-step range is left alone.
    let r = align_request(&RangeRequest::range(1_700_000_000 * 1_000_000_000, 1_700_000_600 * 1_000_000_000, 60_000_000_000));
    assert_eq!((r.start_unix_nano / 1_000_000_000, r.end_unix_nano / 1_000_000_000), (1_699_999_920, 1_700_000_640));
    let r = align_request(&RangeRequest::range(1_700_000_007 * 1_000_000_000, 1_700_000_067 * 1_000_000_000, 15_000_000_000));
    assert_eq!((r.start_unix_nano / 1_000_000_000, r.end_unix_nano / 1_000_000_000), (1_699_999_980, 1_700_000_070));
    let one = RangeRequest::range(1_699_999_980 * 1_000_000_000, 1_700_000_040 * 1_000_000_000, 60_000_000_000);
    assert_eq!(align_request(&one), one);
}
