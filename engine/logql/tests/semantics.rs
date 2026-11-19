//! Semantics pinned from black-box observation of Loki v3.7.10 (probe queries; see README
//! "Verification"), one assertion per rule, on small hand-made data.

use viz_logql::*;

const S: i64 = 1_000_000_000;

fn src(streams: &[(&[(&str, &str)], &[(i64, &str)])]) -> MemSource {
    MemSource::new(
        streams
            .iter()
            .map(|(l, rows)| LogStream {
                labels: l.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
                rows: rows.iter().map(|(t, line)| LogRow { ts_ns: *t, line: line.to_string(), metadata: vec![] }).collect(),
            })
            .collect(),
    )
}

fn opts() -> Options {
    Options { limit: 1000, direction: Direction::Forward, ..Options::default() }
}

/// Log query result as `labels => [lines]`, streams sorted.
fn logs(s: &MemSource, q: &str) -> Vec<(String, Vec<String>)> {
    let r = query_range(s, q, 0, 100 * S, S, &opts()).unwrap_or_else(|e| panic!("{q}: {e}"));
    let Data::Streams(st) = r.data else { panic!() };
    st.into_iter()
        .map(|s| (s.labels.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(","), s.entries.into_iter().map(|e| e.1).collect()))
        .collect()
}

/// Metric range result as `labels => [(t_seconds, value)]`.
fn matrix(s: &MemSource, q: &str, start: i64, end: i64, step: i64) -> Vec<(String, Vec<(i64, f64)>)> {
    let r = query_range(s, q, start, end, step, &opts()).unwrap_or_else(|e| panic!("{q}: {e}"));
    let Data::Matrix(m) = r.data else { panic!() };
    m.into_iter()
        .map(|s| (s.labels.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(","), s.points.into_iter().map(|(t, v)| (t / S, v)).collect()))
        .collect()
}

#[test]
fn windows_are_left_open_right_closed_and_rate_divides_by_the_range() {
    let s = src(&[(&[("app", "a")], &[(S, "x"), (2 * S, "x"), (2 * S + 1, "x"), (3 * S, "x")])]);
    // (t-1s, t]: t=2 holds 2s only; t=3 holds 2s+1ns and 3s.
    assert_eq!(matrix(&s, r#"count_over_time({app="a"}[1s])"#, S, 3 * S, S), vec![("app=a".into(), vec![(1, 1.0), (2, 1.0), (3, 2.0)])]);
    assert_eq!(matrix(&s, r#"rate({app="a"}[2s])"#, 3 * S, 3 * S, S), vec![("app=a".into(), vec![(3, 1.5)])]);
    assert_eq!(matrix(&s, r#"bytes_rate({app="a"}[2s])"#, 3 * S, 3 * S, S), vec![("app=a".into(), vec![(3, 1.5)])]);
    // offset moves the window back.
    assert_eq!(matrix(&s, r#"count_over_time({app="a"}[1s] offset 1s)"#, 3 * S, 3 * S, S), vec![("app=a".into(), vec![(3, 1.0)])]);
}

#[test]
fn unwrap_conversions_grouping_and_label_removal() {
    let s = src(&[
        (&[("app", "a")], &[(S, "v=1 d=1.5s b=1KiB"), (2 * S, "v=3 d=500ms b=2KB"), (3 * S, "v=x")]),
        (&[("app", "b")], &[(2 * S, "v=10")]),
    ]);
    assert_eq!(
        matrix(&s, r#"sum_over_time({app="a"} | logfmt | unwrap d | __error__="" [5s])"#, 2 * S, 2 * S, S).len(),
        0,
        "d is not a plain number: every sample is an error and is filtered"
    );
    assert_eq!(matrix(&s, r#"sum_over_time({app="a"} | logfmt | unwrap duration(d) | __error__="" [5s])"#, 2 * S, 2 * S, S)[0].1, vec![(2, 1.5)]);
    assert_eq!(
        matrix(&s, r#"sum_over_time({app="a"} | logfmt | unwrap bytes(b) | __error__="" [5s])"#, 2 * S, 2 * S, S).iter().map(|x| x.1[0].1).sum::<f64>(),
        3024.0
    );
    // The unwrapped label leaves the series labels.
    let m = matrix(&s, r#"max_over_time({app="a"} | logfmt | keep app, v | unwrap v | __error__="" [5s])"#, 2 * S, 2 * S, S);
    assert_eq!(m, vec![("app=a".into(), vec![(2, 3.0)])]);
    // by/without on the range aggregation pool samples of all series in a group.
    let m = matrix(&s, r#"avg_over_time({app=~"a|b"} | logfmt | keep app, v | unwrap v | __error__="" [5s]) without (app)"#, 2 * S, 2 * S, S);
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].0, "");
    assert!((m[0].1[0].1 - 14.0 / 3.0).abs() < 1e-12, "{m:?}");
    let m = matrix(&s, r#"avg_over_time({app=~"a|b"} | logfmt | keep app, v | unwrap v | __error__="" [5s]) by (app)"#, 2 * S, 2 * S, S);
    assert_eq!(m, vec![("app=a".into(), vec![(2, 2.0)]), ("app=b".into(), vec![(2, 10.0)])]);
    // A conversion error fails the query unless filtered.
    assert!(query_range(&s, r#"sum_over_time({app="a"} | logfmt | unwrap v [5s])"#, 3 * S, 3 * S, S, &opts()).is_err());
}

#[test]
fn rate_counter_compensates_resets() {
    let s = src(&[(&[("app", "b")], &[(S, "v=10"), (3 * S, "v=20"), (4 * S, "v=5")])]);
    // Increase 10 + (5 - 20 + 20) = 15 over a 5 s range, extended as observed in Loki.
    let m = matrix(&s, r#"rate_counter({app="b"} | logfmt | unwrap v [5s])"#, 4 * S, 4 * S, S);
    assert!((m[0].1[0].1 - 3.000005).abs() < 1e-12, "{m:?}");
}

#[test]
fn absent_over_time_labels_come_from_equality_matchers() {
    let s = src(&[(&[("app", "a")], &[(S, "x")])]);
    let m = matrix(&s, r#"absent_over_time({app="c", env="p", x=~"y"}[1s])"#, S, S, S);
    assert_eq!(m, vec![("app=c,env=p".into(), vec![(1, 1.0)])]);
}

#[test]
fn parsers_sanitise_collide_and_keep_the_first_value() {
    let s = src(&[(&[("app", "a")], &[(S, r#"{"1abc":"e","a.b-c":"d","app":"x","n":null,"arr":[1],"x":{"y":2},"k":"v","k":"w"}"#)])]);
    assert_eq!(logs(&s, r#"{app="a"} | json"#)[0].0, "_1abc=e,a_b_c=d,app=a,app_extracted=x,k=v,x_y=2");
    let s = src(&[(&[("app", "a")], &[(S, "a=1 empty= standalone 2001:db8::1=x")])]);
    assert_eq!(logs(&s, r#"{app="a"} | logfmt"#)[0].0, "_2001_db8__1=x,a=1,app=a");
    assert_eq!(logs(&s, r#"{app="a"} | logfmt --keep-empty"#)[0].0, "_2001_db8__1=x,a=1,app=a,empty=,standalone=");
}

#[test]
fn errors_first_wins_and_error_filters_run_last() {
    let s = src(&[(&[("app", "a")], &[(S, "a=1 b=2"), (2 * S, "a=x b=3"), (3 * S, "not json")])]);
    // The JSON error stays; the label filter does not overwrite it.
    let r = logs(&s, r#"{app="a"} | json | logfmt | a > 0"#);
    assert!(r.iter().all(|(l, _)| !l.contains("LabelFilterErr")), "{r:?}");
    // A value that does not convert keeps the line with LabelFilterErr...
    assert!(logs(&s, r#"{app="a"} | logfmt | a > 0"#).iter().any(|(l, _)| l.contains("__error__=LabelFilterErr")));
    // ...and an __error__ filter written before it still removes it.
    assert_eq!(logs(&s, r#"{app="a"} | logfmt | __error__="" | a > 0"#), vec![("a=1,app=a,b=2".into(), vec!["a=1 b=2".to_string()])]);
    // An absent label fails a numeric predicate.
    assert_eq!(logs(&s, r#"{app="a"} | logfmt | zz > 0"#).len(), 0);
}

#[test]
fn line_filters_patterns_ip_and_decolorize() {
    let s = src(&[(&[("app", "a")], &[(S, "a ERROR"), (2 * S, "ERROR b"), (3 * S, "a ERROR b"), (4 * S, "\u{1b}[31mERROR\u{1b}[0m 10.0.0.1"), (5 * S, "93.180.71.3")])]);
    let lines = |q: &str| logs(&s, q).into_iter().flat_map(|x| x.1).collect::<Vec<_>>();
    assert_eq!(lines(r#"{app="a"} |> "<_>ERROR<_>""#), vec!["a ERROR b", "\u{1b}[31mERROR\u{1b}[0m 10.0.0.1"]);
    assert_eq!(lines(r#"{app="a"} != "a" or "9""#), vec!["ERROR b", "\u{1b}[31mERROR\u{1b}[0m 10.0.0.1"]);
    assert_eq!(lines(r#"{app="a"} |= ip("3.180.71.3")"#).len(), 0);
    assert_eq!(lines(r#"{app="a"} |= ip("10.0.0.0/8")"#).len(), 1);
    // A line filter after decolorize sees the coloured line.
    assert_eq!(lines(r#"{app="a"} | decolorize |= "\u001b""#), vec!["ERROR 10.0.0.1"]);
    // `^E` is tested against the line before decolorize: only the uncoloured line matches.
    assert_eq!(lines(r#"{app="a"} | decolorize |~ "^E""#), vec!["ERROR b"]);
}

#[test]
fn templates_missing_labels_and_errors() {
    let s = src(&[(&[("app", "a")], &[(S, "a=1"), (2 * S, "a=x")])]);
    let r = logs(&s, r#"{app="a"} | logfmt | line_format "[{{.missing}}|{{.a}}|{{ div 10 .a }}]""#);
    assert_eq!(r[1].1, vec!["[|1|10]"]);
    assert!(r[0].0.contains("__error__=TemplateFormatErr"));
    assert_eq!(r[0].1, vec!["a=x"], "the line is unchanged on error");
}

#[test]
fn log_query_order_limit_and_bounds() {
    let s = src(&[(&[("app", "b")], &[(S, "b1"), (2 * S, "b2")]), (&[("app", "a")], &[(2 * S, "a2"), (3 * S, "a3")])]);
    let r = query_range(&s, r#"{app=~"a|b"}"#, S, 3 * S, S, &Options { limit: 2, direction: Direction::Forward, ..Options::default() }).unwrap();
    // [1s, 3s): b1, then the tie at 2s goes to the smaller label set (app=a).
    assert_eq!(r.data_json().matches("\"a2\"").count() + r.data_json().matches("\"b1\"").count(), 2, "{}", r.data_json());
    let r = query_range(&s, r#"{app=~"a|b"}"#, S, 4 * S, S, &Options { limit: 1, direction: Direction::Backward, ..Options::default() }).unwrap();
    assert!(r.data_json().contains("\"a3\""), "{}", r.data_json());
    // Backward, a tie at the limit also goes to the smaller label set.
    let r = query_range(&s, r#"{app=~"a|b"}"#, S, 3 * S, S, &Options { limit: 1, direction: Direction::Backward, ..Options::default() }).unwrap();
    assert!(r.data_json().contains("\"a2\""), "{}", r.data_json());
}

#[test]
fn pushdown_never_includes_negative_filters() {
    let s = selectors(r#"{a="b"} != "x" |~ "y" !> "<_>z" |= ip("1.2.3.4") |= "w""#, 0, 1, 1).unwrap();
    assert_eq!(s[0].required, vec![vec!["w".to_string()]]);
}
