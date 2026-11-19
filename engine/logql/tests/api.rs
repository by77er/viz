//! The public API: result shapes, options, selectors, errors, structured metadata.

use viz_logql::*;

const S: i64 = 1_000_000_000;

fn row(t: i64, line: &str) -> LogRow {
    LogRow { ts_ns: t, line: line.into(), metadata: vec![] }
}

fn src() -> MemSource {
    MemSource::new(vec![
        LogStream {
            labels: vec![("app".into(), "web".into()), ("env".into(), "prod".into())],
            rows: vec![
                row(S, "level=info status=200 latency=12ms"),
                row(2 * S, "level=error status=500 latency=1.5s"),
                LogRow { ts_ns: 3 * S, line: "level=warn status=404 latency=3ms".into(), metadata: vec![("trace_id".into(), "abc".into())] },
            ],
        },
        LogStream { labels: vec![("app".into(), "db".into()), ("env".into(), "prod".into())], rows: vec![row(2 * S, "slow query 10.0.0.1")] },
    ])
}

fn fwd(limit: u32) -> Options {
    Options { limit, direction: Direction::Forward, ..Options::default() }
}

fn data(r: &QueryResult) -> String {
    let j = r.data_json();
    j[..j.find(",\"stats\":").unwrap()].to_string() + "}"
}

#[test]
fn streams_shape_limit_and_direction() {
    let r = query_range(&src(), r#"{env="prod"}"#, 0, 10 * S, S, &fwd(2)).unwrap();
    assert_eq!(
        data(&r),
        r#"{"resultType":"streams","result":[{"stream":{"app":"db","env":"prod"},"values":[["2000000000","slow query 10.0.0.1"]]},{"stream":{"app":"web","env":"prod"},"values":[["1000000000","level=info status=200 latency=12ms"]]}]}"#
    );
    let r = query_range(&src(), r#"{app="web"}"#, 0, 10 * S, S, &Options { limit: 1, ..Options::default() }).unwrap();
    // Backward is the default: newest first. Structured metadata is part of the labels.
    assert_eq!(
        data(&r),
        r#"{"resultType":"streams","result":[{"stream":{"app":"web","env":"prod","trace_id":"abc"},"values":[["3000000000","level=warn status=404 latency=3ms"]]}]}"#
    );
    // Start inclusive, end exclusive.
    let r = query_range(&src(), r#"{app="web"}"#, S, 3 * S, S, &fwd(10)).unwrap();
    assert_eq!(r.stats.returned, 2);
    assert!(r.data_json().contains(r#""stats":{"summary":"#));
}

#[test]
fn structured_metadata_filters_and_drop() {
    let r = query_range(&src(), r#"{app="web"} | trace_id="abc""#, 0, 10 * S, S, &fwd(10)).unwrap();
    assert_eq!(r.stats.returned, 1);
    let r = query_range(&src(), r#"{app="web"} | drop trace_id"#, 0, 10 * S, S, &fwd(10)).unwrap();
    assert!(!data(&r).contains("trace_id"));
    // A parser extracting a key that is structured metadata gets `_extracted`.
    let s = MemSource::new(vec![LogStream {
        labels: vec![("app".into(), "a".into())],
        rows: vec![LogRow { ts_ns: S, line: "trace_id=x".into(), metadata: vec![("trace_id".into(), "abc".into())] }],
    }]);
    let r = query_range(&s, r#"{app="a"} | logfmt"#, 0, 10 * S, S, &fwd(10)).unwrap();
    assert!(data(&r).contains(r#""trace_id":"abc","trace_id_extracted":"x""#), "{}", data(&r));
}

#[test]
fn metric_shapes() {
    let r = query_range(&src(), r#"sum by (app) (count_over_time({env="prod"}[2s]))"#, S, 3 * S, S, &fwd(100)).unwrap();
    assert_eq!(
        data(&r),
        r#"{"resultType":"matrix","result":[{"metric":{"app":"db"},"values":[[2,"1"],[3,"1"]]},{"metric":{"app":"web"},"values":[[1,"1"],[2,"2"],[3,"2"]]}]}"#
    );
    let r = query_instant(&src(), r#"max_over_time({app="web"} | logfmt | unwrap duration(latency) [5s]) by (app)"#, 3 * S, &fwd(100)).unwrap();
    assert_eq!(data(&r), r#"{"resultType":"vector","result":[{"metric":{"app":"web"},"value":[3,"1.5"]}]}"#);
    let r = query_instant(&src(), "1 + 2 * 3", 1_500_000_000, &fwd(100)).unwrap();
    assert_eq!(data(&r), r#"{"resultType":"scalar","result":[1.5,"7"]}"#);
    let r = query_range(&src(), "vector(2) > 1", 0, 2 * S, S, &fwd(100)).unwrap();
    assert_eq!(data(&r), r#"{"resultType":"matrix","result":[{"metric":{},"values":[[0,"2"],[1,"2"],[2,"2"]]}]}"#);
    let r = query_instant(&src(), r#"absent_over_time({app="nope", env="x"}[1m])"#, S, &fwd(100)).unwrap();
    assert_eq!(data(&r), r#"{"resultType":"vector","result":[{"metric":{"app":"nope","env":"x"},"value":[1,"1"]}]}"#);
}

#[test]
fn selectors_report_ranges_and_required_literals() {
    let s = selectors(r#"count_over_time({app="web"} |= "error" |> "<_> status=<_>" | logfmt | line_format "x" |= "late" [5m] offset 1m)"#, 600 * S, 900 * S, 60 * S).unwrap();
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].start_ns, 600 * S - 60 * S - 300 * S + 1);
    assert_eq!(s[0].end_ns, 900 * S - 60 * S + 1);
    // Literals after line_format are not pushed down.
    assert_eq!(s[0].required, vec![vec!["error".to_string()], vec![" status=".to_string()]]);
    assert_eq!(s[0].line_filters.len(), 2);
    let s = selectors(r#"{app="web"} |= "a" or "b" != "c""#, 0, 10, 1).unwrap();
    assert_eq!(s[0].required, vec![vec!["a".to_string(), "b".to_string()]]);
    assert_eq!((s[0].start_ns, s[0].end_ns), (0, 10));
    let s = selectors(r#"rate({a="1"}[1m]) / rate({b="2"}[5m])"#, 0, 0, 1).unwrap();
    assert_eq!(s.len(), 2);
}

#[test]
fn errors_are_typed_with_positions() {
    let e = parse(r#"{app="web"} |= "x" | foo >"#).unwrap_err();
    assert!(matches!(e, Error::Parse { line: 1, col: 27, .. }), "{e:?}");
    let e = parse("{app=\"web\"}\n| json | x > \"a\"").unwrap_err();
    assert!(matches!(e, Error::Parse { line: 2, .. }), "{e:?}");
    assert_eq!(e.error_type(), "bad_data");
    assert!(matches!(parse(r#"{app=~".*"}"#), Err(Error::Parse { .. })));
    assert!(matches!(parse(r#"approx_topk(2, rate({a="b"}[1m]))"#), Err(Error::Unsupported(_))));
    assert!(matches!(parse(r#"{a="b"} | line_format "{{ template \"x\" }}""#), Err(Error::Parse { .. }) | Err(Error::Unsupported(_))));
    assert!(matches!(parse(r#"count_over_time({a="b"}[5m]) by (x)"#), Err(Error::Parse { .. })));
    assert!(matches!(parse(r#"sum_over_time({a="b"}[5m])"#), Err(Error::Parse { .. })));
    assert!(matches!(parse(r#"-count_over_time({a="b"}[5m])"#), Err(Error::Parse { .. })));
    // A log query is not an instant query.
    assert!(query_instant(&src(), r#"{app="web"}"#, S, &fwd(10)).is_err());
    // A metric query whose samples carry errors fails.
    let e = query_range(&src(), r#"count_over_time({env="prod"} | json [5s])"#, 0, 5 * S, S, &fwd(10)).unwrap_err();
    assert!(e.to_string().starts_with("pipeline error: 'JSONParserErr'"), "{e}");
    // Steps are bounded.
    let e = query_range(&src(), r#"count_over_time({app="web"}[1m])"#, 0, 20_000 * S, S, &fwd(10)).unwrap_err();
    assert!(e.to_string().contains("maximum resolution"), "{e}");
    assert!(error_json(&e).starts_with(r#"{"status":"error","errorType":"bad_data""#));
}

#[test]
fn now_comes_from_the_caller() {
    let q = r#"{app="db"} | line_format "{{ unixEpoch now }}""#;
    let r = query_range(&src(), q, 0, 10 * S, S, &fwd(10)).unwrap();
    assert!(data(&r).contains("TemplateFormatErr"), "{}", data(&r));
    let r = query_range(&src(), q, 0, 10 * S, S, &Options { now_ns: Some(42 * S), ..fwd(10) }).unwrap();
    assert!(data(&r).contains(r#""42""#), "{}", data(&r));
}

#[test]
fn deep_nesting_is_refused_not_a_stack_overflow() {
    let q = "(".repeat(5000) + "1" + &")".repeat(5000);
    assert!(parse(&q).is_err());
    let q = format!(r#"{{a="b"}} | {}x="1"{}"#, "(".repeat(5000), ")".repeat(5000));
    assert!(parse(&q).is_err());
}
