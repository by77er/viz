//! Targeted tests for the public API: JSON shape, selector ranges, and the
//! semantic details the upstream corpus exercises only indirectly.

use std::cell::RefCell;

use viz_promql::*;

fn s(name: &str, labels: &[(&str, &str)], pts: &[(i64, f64)]) -> Series {
    let mut l: Vec<(String, String)> = labels.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    l.push(("__name__".into(), name.into()));
    l.sort();
    Series { labels: l, ts: pts.iter().map(|p| p.0).collect(), values: pts.iter().map(|p| p.1).collect() }
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap()
}

fn vec_of(v: Value) -> Vec<(Vec<(String, String)>, f64)> {
    match v {
        Value::Vector(v) => v.into_iter().map(|x| (x.metric, x.value)).collect(),
        other => panic!("expected vector, got {other:?}"),
    }
}

#[test]
fn json_shapes_match_prometheus_http_api() {
    let src = MemSource::from_series(vec![
        s("up", &[("job", "a")], &[(0, 1.0), (1500, 0.5), (3000, f64::NAN)]),
        s("up", &[("job", "b")], &[(0, f64::INFINITY), (1500, f64::NEG_INFINITY), (3000, 1e21)]),
    ]);
    let m = query_range(&src, "up", 0, 3000, 1500).unwrap();
    assert_eq!(
        json(&m),
        r#"{"resultType":"matrix","result":[{"metric":{"__name__":"up","job":"a"},"values":[[0,"1"],[1.5,"0.5"],[3,"NaN"]]},{"metric":{"__name__":"up","job":"b"},"values":[[0,"+Inf"],[1.5,"-Inf"],[3,"1000000000000000000000"]]}]}"#
    );
    let v = query_instant(&src, r#"up{job="a"}"#, 1500).unwrap();
    assert_eq!(json(&v), r#"{"resultType":"vector","result":[{"metric":{"__name__":"up","job":"a"},"value":[1.5,"0.5"]}]}"#);
    assert_eq!(json(&query_instant(&src, "1/3", 2000).unwrap()), r#"{"resultType":"scalar","result":[2,"0.3333333333333333"]}"#);
    assert_eq!(json(&query_instant(&src, r#""hi""#, 2000).unwrap()), r#"{"resultType":"string","result":[2,"hi"]}"#);
    assert_eq!(
        json(&query_instant(&src, r#"up{job="a"}[2s]"#, 1500).unwrap()),
        r#"{"resultType":"matrix","result":[{"metric":{"__name__":"up","job":"a"},"values":[[0,"1"],[1.5,"0.5"]]}]}"#
    );
    // A scalar range query is one series without labels.
    assert_eq!(json(&query_range(&src, "time()", 1000, 2000, 1000).unwrap()), r#"{"resultType":"matrix","result":[{"metric":{},"values":[[1,"1"],[2,"2"]]}]}"#);
    // Empty results.
    assert_eq!(json(&query_range(&src, "nope", 0, 3000, 1500).unwrap()), r#"{"resultType":"matrix","result":[]}"#);
}

#[test]
fn float_formatting() {
    for (v, want) in [
        (0.1 + 0.2, "0.30000000000000004"),
        (1e-7, "0.0000001"),
        (-0.0, "-0"),
        (123456789.0, "123456789"),
        (f64::NAN, "NaN"),
        (f64::INFINITY, "+Inf"),
        (f64::NEG_INFINITY, "-Inf"),
        (5e-324, &format!("0.{}5", "0".repeat(323))),
    ] {
        assert_eq!(format_float(v), want);
        if !v.is_nan() {
            assert_eq!(want.trim_start_matches('+').replace("Inf", "inf").parse::<f64>().unwrap().to_bits(), v.to_bits());
        }
    }
}

#[test]
fn lookback_is_five_minutes_left_open() {
    let src = MemSource::from_series(vec![s("m", &[], &[(0, 7.0)])]);
    assert_eq!(vec_of(query_instant(&src, "m", 299_999).unwrap()).len(), 1);
    assert_eq!(vec_of(query_instant(&src, "m", 300_000).unwrap()).len(), 0);
    let opts = EvalOptions { lookback_delta_ms: 60_000, ..Default::default() };
    assert_eq!(vec_of(query_instant_with(&src, "m", 59_999, &opts).unwrap()).len(), 1);
    assert_eq!(vec_of(query_instant_with(&src, "m", 60_000, &opts).unwrap()).len(), 0);
}

#[test]
fn staleness_marker_ends_a_series_but_plain_nan_does_not() {
    let src = MemSource::from_series(vec![
        s("m", &[("k", "stale")], &[(0, 1.0), (10_000, stale_nan())]),
        s("m", &[("k", "nan")], &[(0, 1.0), (10_000, f64::NAN)]),
    ]);
    let v = vec_of(query_instant(&src, "m", 20_000).unwrap());
    assert_eq!(v.len(), 1);
    assert_eq!(v[0].0[1].1, "nan");
    assert!(v[0].1.is_nan());
    // Range vectors skip the marker but keep the NaN.
    let v = vec_of(query_instant(&src, "count_over_time(m[1m])", 20_000).unwrap());
    let get = |k: &str| v.iter().find(|x| x.0[0].1 == k).unwrap().1;
    assert_eq!(get("stale"), 1.0);
    assert_eq!(get("nan"), 2.0);
}

#[test]
fn range_windows_are_left_open_right_closed() {
    let src = MemSource::from_series(vec![s("m", &[], &[(0, 1.0), (60_000, 2.0), (120_000, 4.0)])]);
    let v = vec_of(query_instant(&src, "sum_over_time(m[1m])", 120_000).unwrap());
    assert_eq!(v[0].1, 4.0, "sample exactly on the left edge is excluded");
    let v = vec_of(query_instant(&src, "sum_over_time(m[1m1ms])", 120_000).unwrap());
    assert_eq!(v[0].1, 6.0);
}

#[test]
fn rate_extrapolates_and_drops_name() {
    // Samples at 20s, 35s, 50s; window (0s, 60s]. Sampled interval 30s, average gap 15s.
    let src = MemSource::from_series(vec![
        s("c_total", &[("job", "far")], &[(20_000, 100.0), (35_000, 110.0), (50_000, 120.0)]),
        s("c_total", &[("job", "near_zero")], &[(20_000, 2.0), (35_000, 12.0), (50_000, 22.0)]),
    ]);
    let v = vec_of(query_instant(&src, "increase(c_total[1m])", 60_000).unwrap());
    assert_eq!(v[0].0, vec![("job".to_string(), "far".to_string())], "name dropped");
    // Left gap 20s >= 1.1 * 15s, so extrapolate half a gap (7.5s); right gap 10s is used in full.
    assert!((v[0].1 - 20.0 * (30.0 + 7.5 + 10.0) / 30.0).abs() < 1e-9, "{}", v[0].1);
    // A counter is not extrapolated below zero: 2 / (20/30s) = 3s to the left.
    assert!((v[1].1 - 20.0 * (30.0 + 3.0 + 10.0) / 30.0).abs() < 1e-9, "{}", v[1].1);
    let r = vec_of(query_instant(&src, "rate(c_total[1m])", 60_000).unwrap());
    assert!((r[0].1 - v[0].1 / 60.0).abs() < 1e-12);
    // delta() does not apply the zero cap.
    let d = vec_of(query_instant(&src, "delta(c_total[1m])", 60_000).unwrap());
    assert!((d[1].1 - 20.0 * (30.0 + 7.5 + 10.0) / 30.0).abs() < 1e-9, "{}", d[1].1);
    // Counter reset.
    let src = MemSource::from_series(vec![s("c_total", &[], &[(15_000, 5.0), (30_000, 8.0), (45_000, 1.0), (60_000, 4.0)])]);
    let v = vec_of(query_instant(&src, "increase(c_total[1m])", 60_000).unwrap());
    // 3 + (reset: +1) + 3 = 7 over 45s; the left gap of 15s is used in full (zero cap would be 32s).
    assert!((v[0].1 - 7.0 * (45.0 + 15.0) / 45.0).abs() < 1e-9, "{}", v[0].1);
    assert_eq!(vec_of(query_instant(&src, "resets(c_total[1m])", 60_000).unwrap())[0].1, 1.0);
}

#[test]
fn unsupported_features_are_errors_not_wrong_answers() {
    let src = MemSource::new();
    for q in [
        "histogram_count(x)",
        "histogram_sum(x)",
        "histogram_avg(x)",
        "histogram_fraction(0, 1, x)",
        "limitk(1, x)",
        "limit_ratio(0.5, x)",
        "info(x)",
        r#"x{a="b" or c="d"}"#,
        "x + fill(0) y",
    ] {
        match query_instant(&src, q, 0) {
            Err(Error::Unsupported(_)) => {}
            other => panic!("{q}: expected Unsupported, got {other:?}"),
        }
    }
    // The parser rejects the modifiers it does not know.
    assert!(matches!(query_instant(&src, "rate(x[5m] anchored)", 0), Err(Error::Parse(_))));
    assert!(matches!(query_instant(&src, "rate(x[5m] smoothed)", 0), Err(Error::Parse(_))));
}

#[test]
fn mem_source_matcher_semantics() {
    let src = MemSource::from_series(vec![
        s("m", &[("env", "prod"), ("dc", "eu")], &[(0, 1.0)]),
        s("m", &[("env", "production")], &[(0, 2.0)]),
        s("m", &[], &[(0, 3.0)]),
    ]);
    let n = |q: &str| vec_of(query_instant(&src, q, 0).unwrap()).len();
    assert_eq!(n(r#"m{env=~"prod"}"#), 1, "regexes are fully anchored");
    assert_eq!(n(r#"m{env=~"prod.*"}"#), 2);
    assert_eq!(n(r#"m{env=""}"#), 1, "a missing label equals the empty string");
    assert_eq!(n(r#"m{env!=""}"#), 2);
    assert_eq!(n(r#"m{dc!="eu"}"#), 2, "!= matches series without the label");
    assert_eq!(n(r#"m{dc=~".*"}"#), 3);
    assert_eq!(n(r#"m{dc!~"e.|"}"#), 0);
    assert_eq!(n(r#"m{dc=~"e.|"}"#), 3);
}

#[test]
fn selectors_report_ranges() {
    let h = 3_600_000;
    let sel = |q: &str, a: i64, b: i64, st: i64| -> Vec<(String, i64, i64)> {
        selectors(q, a, b, st).unwrap().into_iter().map(|x| (json(&x.matchers), x.min_ts_ms, x.max_ts_ms)).collect()
    };
    // Instant selector: lookback.
    assert_eq!(sel("up", h, 2 * h, 60_000), vec![(r#"[{"name":"__name__","op":"=","value":"up"}]"#.to_string(), h - 300_000 + 1, 2 * h)]);
    // Range + offset.
    let r = sel(r#"rate(http{code=~"5..",job!="x"}[10m] offset 1h)"#, h, 2 * h, 60_000);
    assert_eq!(r[0].1, h - h - 600_000 + 1);
    assert_eq!(r[0].2, 2 * h - h);
    assert!(r[0].0.contains(r#"{"name":"code","op":"=~","value":"5.."}"#) && r[0].0.contains(r#"{"name":"job","op":"!=","value":"x"}"#));
    // @ pins the range; start()/end() resolve to the query bounds.
    assert_eq!(sel("up @ 100", h, 2 * h, 60_000)[0].1, 100_000 - 300_000 + 1);
    assert_eq!(sel("up @ 100", h, 2 * h, 60_000)[0].2, 100_000);
    assert_eq!(sel("up @ end()", h, 2 * h, 60_000)[0].2, 2 * h);
    assert_eq!(sel("sum_over_time(up[1m] @ start())", h, 2 * h, 60_000)[0], (r#"[{"name":"__name__","op":"=","value":"up"}]"#.to_string(), h - 60_000 + 1, h));
    // The last step is what counts, not `end`.
    assert_eq!(sel("up", 0, 100_000, 60_000)[0].2, 60_000);
    // Subquery: inner steps are aligned to the resolution; inner selector needs its own window.
    let r = sel("max_over_time(rate(x[5m])[30m:1m])", h, 2 * h, 60_000);
    assert_eq!(r[0].1, h - 1_800_000 + 60_000 - 300_000 + 1);
    assert_eq!(r[0].2, 2 * h);
    // Both sides of a binary expression, and aggregation parameters, are reported.
    assert_eq!(sel("topk(scalar(k), a) / on() group_left b", 0, 0, 1).len(), 3);
    assert_eq!(serde_json::to_value(&selectors("up", 0, 0, 1).unwrap()).unwrap()[0]["minTs"], -299_999);
}

/// A source that records every call, to prove `selectors()` predicts them.
struct Recording {
    inner: MemSource,
    calls: RefCell<Vec<(String, i64, i64)>>,
}

impl SeriesSource for Recording {
    fn select(&self, m: &[Matcher], min: i64, max: i64) -> Result<Vec<Series>, Error> {
        self.calls.borrow_mut().push((serde_json::to_string(m).unwrap(), min, max));
        self.inner.select(m, min, max)
    }
}

#[test]
fn evaluator_reads_exactly_what_selectors_reports() {
    let pts: Vec<(i64, f64)> = (0..200).map(|i| (i * 30_000, i as f64)).collect();
    let inner = MemSource::from_series(vec![s("a", &[("k", "1")], &pts), s("b", &[("k", "1")], &pts)]);
    for q in [
        "a",
        "rate(a[5m])",
        "a offset 10m + b offset -5m",
        "sum by (k) (rate(a[2m] @ 1200)) / on(k) b @ end()",
        "max_over_time(rate(a[1m])[10m:30s] offset 2m)",
        "avg_over_time((a - b @ start())[7m:] @ 3000)",
        "timestamp(a offset 1m)",
        "absent_over_time(a[3m]) or quantile_over_time(0.5, b[90s])",
        "histogram_quantile(0.9, a)",
        "topk(1, a) and label_replace(b, \"x\", \"$1\", \"k\", \"(.*)\")",
    ] {
        for (start, end, step) in [(1_800_000, 3_600_000, 45_000), (2_000_000, 2_000_000, 1), (0, 600_000, 600_000)] {
            let src = Recording { inner: inner.clone(), calls: RefCell::new(vec![]) };
            if start == end {
                query_instant(&src, q, start).unwrap();
            } else {
                query_range(&src, q, start, end, step).unwrap();
            }
            let predicted: Vec<(String, i64, i64)> = selectors(q, start, end, step)
                .unwrap()
                .into_iter()
                .map(|x| (serde_json::to_string(&x.matchers).unwrap(), x.min_ts_ms, x.max_ts_ms))
                .collect();
            let mut calls = src.calls.into_inner();
            let mut predicted_sorted = predicted.clone();
            calls.sort();
            predicted_sorted.sort();
            assert_eq!(calls, predicted_sorted, "query {q} [{start},{end}] step {step}");
        }
    }
}

#[test]
fn source_may_return_extra_samples_and_unsorted_labels() {
    // A sloppy but contract-conforming source: ignores the time range and
    // returns labels unsorted.
    struct Sloppy;
    impl SeriesSource for Sloppy {
        fn select(&self, _: &[Matcher], _: i64, _: i64) -> Result<Vec<Series>, Error> {
            Ok(vec![Series {
                labels: vec![("z".into(), "1".into()), ("__name__".into(), "m".into())],
                ts: vec![0, 60_000, 120_000, 180_000],
                values: vec![1.0, 2.0, 3.0, 4.0],
            }])
        }
    }
    let v = vec_of(query_instant(&Sloppy, "sum_over_time(m[1m])", 120_000).unwrap());
    assert_eq!(v, vec![(vec![("z".to_string(), "1".to_string())], 3.0)]);
    let v = vec_of(query_instant(&Sloppy, "m", 130_000).unwrap());
    assert_eq!(v[0].0[0].0, "__name__");
    assert_eq!(v[0].1, 3.0);
}

#[test]
fn name_dropping_default_mode() {
    let src = MemSource::from_series(vec![
        s("a", &[("k", "1")], &[(0, 1.0), (60_000, 2.0)]),
        s("b", &[("k", "1")], &[(0, 1.0), (60_000, 2.0)]),
    ]);
    let names = |q: &str| -> Vec<bool> {
        vec_of(query_instant(&src, q, 60_000).unwrap()).iter().map(|x| x.0.iter().any(|(k, _)| k == "__name__")).collect()
    };
    assert_eq!(names("a"), vec![true]);
    assert_eq!(names("a > 0"), vec![true], "filter comparison keeps the name");
    assert_eq!(names("a > bool 0"), vec![false]);
    assert_eq!(names("a + 1"), vec![false]);
    assert_eq!(names("-a"), vec![false]);
    assert_eq!(names("abs(a)"), vec![false]);
    assert_eq!(names("rate(a[2m])"), vec![false]);
    assert_eq!(names("last_over_time(a[2m])"), vec![true]);
    assert_eq!(names("topk(1, a)"), vec![true]);
    assert_eq!(names("sum without (k) (a)"), vec![false]);
    assert_eq!(names("a and b"), vec![true]);
    assert_eq!(names("a * on(k) b"), vec![false]);
    // Dropping the name makes two series collide.
    let e = query_instant(&src, r#"abs({__name__=~"a|b"})"#, 60_000).unwrap_err();
    assert_eq!(e, Error::Eval("vector cannot contain metrics with the same labelset".into()));
    let e = query_range(&src, r#"rate({__name__=~"a|b"}[2m])"#, 0, 60_000, 60_000).unwrap_err();
    assert_eq!(e, Error::Eval("vector cannot contain metrics with the same labelset".into()));
}

#[test]
fn bad_inputs() {
    let src = MemSource::new();
    assert!(matches!(query_range(&src, "up", 0, 10, 0), Err(Error::Eval(_))));
    assert!(matches!(query_range(&src, "up", 10, 0, 1), Err(Error::Eval(_))));
    assert!(matches!(query_range(&src, "up[5m]", 0, 10, 1), Err(Error::Eval(_))));
    assert!(matches!(query_range(&src, "\"s\"", 0, 10, 1), Err(Error::Eval(_))));
    assert!(matches!(query_instant(&src, "sum(", 0), Err(Error::Parse(_))));
    // Numbers the parser would panic on when used as durations.
    for q in ["up[1e400]", "up[Inf]", "up[NaN]", "up offset 1e30", "up offset -Inf", "rate(up[5m:NaN])", "up[0x7fffffffffffffff]", "sum_over_time(up[1e16:1])"] {
        assert!(matches!(query_instant(&src, q, 0), Err(Error::Parse(_))), "{q}");
        assert!(matches!(selectors(q, 0, 0, 1), Err(Error::Parse(_))), "{q}");
    }
    assert!(query_instant(&src, "up[300] offset 60", 0).is_ok());
    assert!(query_instant(&src, "sum_over_time(up[0x12c:0xa])", 0).is_ok());
    // Step and subquery limits instead of unbounded allocation.
    assert!(matches!(query_range(&src, "up", 0, 11_000_000, 1000), Err(Error::Eval(_))));
    assert!(query_range(&src, "up", 0, 10_999_000, 1000).is_ok());
    assert!(matches!(query_range(&src, "up", i64::MIN, i64::MAX, 1), Err(Error::Eval(_))));
    assert!(matches!(query_instant(&src, "sum_over_time(up[10y:1ms])", 0), Err(Error::Eval(_))));
    // Extreme times do not overflow.
    assert!(query_instant(&src, "up @ 9e18 offset 100y", i64::MAX).is_ok());
    assert!(query_instant(&src, "rate(up[100y] @ -9e18)", i64::MIN + 1).is_ok());
    assert!(query_instant(&src, "sum_over_time(up[1h:1h] offset -100y)", i64::MAX - 5).is_ok());
}

#[test]
fn vector_matching_error_cases() {
    let p = [(0i64, 1.0)];
    let src = MemSource::from_series(vec![
        s("l", &[("a", "1"), ("b", "1")], &p),
        s("l", &[("a", "1"), ("b", "2")], &p),
        s("r", &[("a", "1"), ("c", "1")], &p),
        s("r2", &[("a", "1"), ("c", "1")], &p),
        s("r2", &[("a", "1"), ("c", "2")], &p),
        s("one", &[("a", "1"), ("b", "1")], &p),
    ]);
    let err = |q: &str| match query_instant(&src, q, 0) {
        Err(Error::Eval(m)) => m,
        other => panic!("{q}: expected an evaluation error, got {other:?}"),
    };
    // One-to-one: the right side must be unique per match group.
    let m = err("one + on(a) r2");
    assert!(m.starts_with("found duplicate series for the match group {a=\"1\"} on the right hand-side of the operation:"), "{m}");
    assert!(m.ends_with(";many-to-many matching not allowed: matching labels must be unique on one side"), "{m}");
    // One-to-one: several left series matching one right series needs group_left.
    assert_eq!(err("l + on(a) r"), "multiple matches for labels: many-to-one matching must be explicit (group_left/group_right)");
    // group_left: fine with many on the left...
    let v = vec_of(query_instant(&src, "l + on(a) group_left(c) r", 0).unwrap());
    assert_eq!(v.len(), 2);
    assert!(v.iter().all(|x| x.0.contains(&("c".to_string(), "1".to_string())) && x.1 == 2.0), "{v:?}");
    assert!(v.iter().all(|x| !x.0.iter().any(|(k, _)| k == "__name__")));
    // ...but the "one" side must still be unique,
    let m = err("l + on(a) group_left r2");
    assert!(m.contains("on the right hand-side"), "{m}");
    // and group_right mirrors it.
    let m = err("r2 + on(a) group_right l");
    assert!(m.contains("on the left hand-side"), "{m}");
    let v = vec_of(query_instant(&src, "r + on(a) group_right(c) l", 0).unwrap());
    assert_eq!(v.len(), 2);
    assert!(v.iter().all(|x| x.0.contains(&("c".to_string(), "1".to_string()))), "{v:?}");
    // The same holds at every step of a range query, and only at steps where both sides exist.
    assert!(query_range(&src, "one + on(a) r2", 0, 60_000, 30_000).is_err());
    assert!(query_range(&src, "one + on(a) r2", 400_000, 460_000, 30_000).unwrap().series.is_empty());
    // Ignoring: default matching is on all labels except the name.
    assert_eq!(vec_of(query_instant(&src, "l + one", 0).unwrap()).len(), 1);
    // Two left series for one right series once b and c are ignored.
    assert!(matches!(query_instant(&src, "l + ignoring(b, c) r", 0), Err(Error::Eval(_))));
}

#[test]
fn group_left_must_produce_unique_series() {
    let p = [(0i64, 1.0)];
    let src = MemSource::from_series(vec![
        s("l", &[("a", "1"), ("b", "1")], &p),
        s("l", &[("a", "1"), ("b", "2")], &p),
        s("r", &[("a", "1"), ("b", "9")], &p),
    ]);
    // Copying `b` from the right makes both results {a="1", b="9"}.
    match query_instant(&src, "l * on(a) group_left(b) r", 0) {
        Err(Error::Eval(m)) => assert_eq!(m, "multiple matches for labels: grouping labels must ensure unique matches"),
        other => panic!("{other:?}"),
    }
}
