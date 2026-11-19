//! The public API: result shapes and units, error types, metadata calls, de-duplication
//! and label handling across the lake/tail boundary.
mod common;

use common::*;
use viz_promql::{MatchOp, Matcher};
use viz_query::{ErrorType, Limits};

const T: i64 = MID - 60_000;
const S: i64 = T / 1000;

/// Two `http` series (labels given out of order on purpose) and one `up`, every 15 s for
/// two minutes across midnight. `http` counts up by 1 or 2 per sample.
fn history() -> History {
    let a: &[(&str, &str)] = &[("job", "api"), ("__name__", "http"), ("code", "200")];
    let b: &[(&str, &str)] = &[("zone", "z"), ("code", "500"), ("job", "api"), ("__name__", "http")];
    let u: &[(&str, &str)] = &[("__name__", "up"), ("job", "db")];
    let mut rows: Vec<(&[(&str, &str)], i64, f64)> = Vec::new();
    for i in 0..9i64 {
        rows.push((a, T + i * 15_000, i as f64));
        rows.push((b, T + i * 15_000, 2.0 * i as f64));
        rows.push((u, T + i * 15_000, 1.0));
    }
    History::from_rows(&rows).cut(&[6, 12, 18])
}

fn both() -> Vec<(&'static str, Stored)> {
    let b = history().encoded();
    vec![
        ("lake", store(&b, &Layout::all_lake(b.len()))),
        ("tail", store(&b, &Layout::all_tail())),
        ("split", store(&b, &Layout { flushed: 3, tail_from: 2, segment_cuts: vec![1], row_group_rows: 4, compact: false })),
    ]
}

#[test]
fn range_query_json_times_are_seconds_and_inputs_are_milliseconds() {
    for (name, s) in both() {
        // Start half a second after a sample: output timestamps are fractional seconds.
        let json = viz_query::query_range(&s.input(), r#"http{code="200"}"#, T + 500, T + 30_500, 15_000).unwrap();
        assert_eq!(
            json,
            format!(
                r#"{{"resultType":"matrix","result":[{{"metric":{{"__name__":"http","code":"200","job":"api"}},"values":[[{}.5,"0"],[{}.5,"1"],[{}.5,"2"]]}}]}}"#,
                S,
                S + 15,
                S + 30
            ),
            "{name}"
        );
        // rate(): a per-second rate although every input is in milliseconds. `http`
        // grows by 1 every 15 s, and the window (T, T+60s] holds four samples.
        let r = viz_query::query_range_with(&s.input(), r#"rate(http{code="200"}[1m])"#, T + 60_000, T + 60_000, 1000, &Default::default()).unwrap();
        assert_eq!(r.matrix.series.len(), 1, "{name}");
        // The name is dropped by rate; the remaining labels are sorted by name.
        assert_eq!(r.matrix.series[0].metric, labels(&[("code", "200"), ("job", "api")]), "{name}");
        let (t, v) = r.matrix.series[0].points[0];
        assert_eq!(t, T + 60_000, "{name}: typed results stay in milliseconds");
        assert!((v - 1.0 / 15.0).abs() < 1e-12, "{name}: rate is per second, got {v}");
        assert_eq!(r.stats.selects, 1);
        assert_eq!(r.stats.series, 1);
        assert_eq!(r.stats.samples, 4, "{name}: samples in (T, T+60s]");
        assert_eq!(r.stats.output_points, 1);
    }
}

#[test]
fn labels_come_out_sorted_whatever_order_they_went_in() {
    for (name, s) in both() {
        let json = viz_query::query_instant(&s.input(), r#"http{code="500"}"#, T).unwrap();
        assert_eq!(
            json,
            format!(r#"{{"resultType":"vector","result":[{{"metric":{{"__name__":"http","code":"500","job":"api","zone":"z"}},"value":[{S},"0"]}}]}}"#),
            "{name}"
        );
    }
}

#[test]
fn instant_query_result_types() {
    let (_, s) = both().remove(2);
    let i = s.input();
    assert_eq!(viz_query::query_instant(&i, "1 + 1", T).unwrap(), format!(r#"{{"resultType":"scalar","result":[{S},"2"]}}"#));
    assert_eq!(viz_query::query_instant(&i, r#""hi""#, T).unwrap(), format!(r#"{{"resultType":"string","result":[{S},"hi"]}}"#));
    assert_eq!(
        viz_query::query_instant(&i, "up[30s]", T + 30_000).unwrap(),
        format!(
            r#"{{"resultType":"matrix","result":[{{"metric":{{"__name__":"up","job":"db"}},"values":[[{},"1"],[{},"1"]]}}]}}"#,
            S + 15,
            S + 30
        )
    );
    assert_eq!(
        viz_query::query_instant(&i, "sum(up)", T).unwrap(),
        format!(r#"{{"resultType":"vector","result":[{{"metric":{{}},"value":[{S},"1"]}}]}}"#)
    );
}

#[test]
fn duplicates_between_lake_and_tail_appear_once_and_the_tail_wins() {
    let up: &[(&str, &str)] = &[("__name__", "up")];
    // The lake has 1 at T and T+15s; the tail rewrites T+15s to 9 and adds T+30s.
    let h = History::from_rows(&[(up, T, 1.0), (up, T + 15_000, 1.0), (up, T + 15_000, 9.0), (up, T + 30_000, 3.0)]).cut(&[2]);
    let b = h.encoded();
    let s = store(&b, &Layout { flushed: 1, tail_from: 1, segment_cuts: vec![], row_group_rows: 100_000, compact: false });
    assert_eq!(
        viz_query::query_instant(&s.input(), "up[1m]", T + 30_000).unwrap(),
        format!(r#"{{"resultType":"matrix","result":[{{"metric":{{"__name__":"up"}},"values":[[{},"1"],[{},"9"],[{},"3"]]}}]}}"#, S, S + 15, S + 30)
    );
    // A sum over the window counts the duplicated timestamp once: 1 + 9 + 3.
    let r = viz_query::query_instant_with(&s.input(), "sum_over_time(up[1m])", T + 30_000, &Default::default()).unwrap();
    assert_eq!(viz_query::to_json(&r.value).unwrap(), format!(r#"{{"resultType":"vector","result":[{{"metric":{{}},"value":[{},"13"]}}]}}"#, S + 30));
    assert_eq!(r.stats.samples, 3);
    // The same rows flushed twice into two files and also left in the tail: still three.
    let twice = store(&[b[0].clone(), b[1].clone(), b[0].clone(), b[1].clone()], &Layout {
        flushed: 4,
        tail_from: 2,
        segment_cuts: vec![2],
        row_group_rows: 1,
        compact: false,
    });
    let r = viz_query::query_instant_with(&twice.input(), "sum_over_time(up[1m])", T + 30_000, &Default::default()).unwrap();
    assert_eq!(r.stats.samples, 3);
    assert!(viz_query::to_json(&r.value).unwrap().contains(r#""13"]"#));
}

fn err(s: &Stored, q: &str, start: i64, end: i64, step: i64) -> viz_query::QueryError {
    viz_query::query_range(&s.input(), q, start, end, step).expect_err(q)
}

#[test]
fn errors_carry_prometheus_error_types() {
    let (_, s) = both().remove(2);
    // bad_data: the request is wrong.
    for q in ["http{", "sum(", "", r#"http{code=~"("}"#, "rate(http)", "http[1e400]"] {
        let e = err(&s, q, T, T + 60_000, 15_000);
        assert_eq!(e.error_type, ErrorType::BadData, "{q}: {e}");
        assert!(e.limit.is_none());
    }
    assert_eq!(err(&s, "up", T, T - 1, 1000).message, "end timestamp must not be before start time");
    assert_eq!(err(&s, "up", T, T - 1, 1000).error_type, ErrorType::BadData);
    for step in [0, -5] {
        let e = err(&s, "up", T, T + 1000, step);
        assert_eq!(e.error_type, ErrorType::BadData);
        assert!(e.message.starts_with("zero or negative query resolution step widths are not accepted"), "{e}");
    }
    let e = err(&s, "up", 0, 11_000_000, 1000); // 11 001 steps
    assert_eq!(e.error_type, ErrorType::BadData);
    assert!(e.message.starts_with("exceeded maximum resolution of 11000 points per timeseries"), "{e}");
    assert!(viz_query::query_range(&s.input(), "up", 0, 10_999_000, 1000).is_ok(), "11 000 steps are allowed");
    // The same checks guard selectors() and plan().
    assert_eq!(viz_query::selectors("up", T, T - 1, 1000).unwrap_err().error_type, ErrorType::BadData);
    assert_eq!(viz_query::plan("up", T, T + 1000, 0).unwrap_err().error_type, ErrorType::BadData);
    assert_eq!(viz_query::plan("up +", T, T + 1000, 1000).unwrap_err().error_type, ErrorType::BadData);

    // execution: valid query, evaluation fails. Prometheus' wording passes through.
    let e = err(&s, "http + on(job) http", T, T + 60_000, 15_000);
    assert_eq!(e.error_type, ErrorType::Execution, "{e}");
    assert!(e.message.contains("many-to-many matching not allowed"), "{e}");
    let e = viz_query::query_range(&s.input(), r#""a string""#, T, T, 1000).unwrap_err();
    assert_eq!(e.error_type, ErrorType::Execution, "{e}");

    // unsupported: never a wrong answer.
    for q in ["limitk(1, up)", "histogram_count(up)", "histogram_fraction(0, 1, up)"] {
        let e = err(&s, q, T, T + 60_000, 15_000);
        assert_eq!(e.error_type, ErrorType::Unsupported, "{q}: {e}");
        assert_eq!(viz_query::query_instant(&s.input(), q, T).unwrap_err().error_type, ErrorType::Unsupported);
    }

    // The Prometheus error envelope.
    let e = err(&s, "limitk(1, up)", T, T, 1000);
    let json = e.to_json();
    assert!(json.starts_with(r#"{"status":"error","errorType":"unsupported","error":""#), "{json}");
    let e = viz_query::QueryError::bad_data("a \"quoted\"\nmessage");
    assert_eq!(e.to_json(), r#"{"status":"error","errorType":"bad_data","error":"a \"quoted\"\nmessage"}"#);
}

#[test]
fn broken_storage_is_internal_not_a_wrong_answer() {
    let (_, good) = both().remove(0);
    // A truncated Parquet file.
    let mut s = good.clone();
    let n = s.sample_files[0].len();
    s.sample_files[0].truncate(n / 2);
    let e = err(&s, "up", T, T + 60_000, 15_000);
    assert_eq!(e.error_type, ErrorType::Internal, "{e}");
    assert!(e.message.starts_with("storage: parquet file 0"), "{e}");
    // A series file passed as a sample file.
    let mut s = good.clone();
    s.sample_files[0] = s.series_files[0].clone();
    assert_eq!(err(&s, "up", T, T + 60_000, 15_000).error_type, ErrorType::Internal);
    // A corrupt tail batch.
    let mut s = good.clone();
    s.tail.push(b"VZB1 not a batch".to_vec());
    let e = err(&s, "up", T, T + 60_000, 15_000);
    assert_eq!(e.error_type, ErrorType::Internal, "{e}");
    assert!(e.message.starts_with("storage: batch 0"), "{e}");
    assert_eq!(viz_query::label_names(&s.input(), &[], T, T + 60_000).unwrap_err().error_type, ErrorType::Internal);
    // A query that reads nothing does not touch storage and still works.
    assert!(viz_query::query_range(&s.input(), "1 + 1", T, T, 1000).is_ok());
    // A regular expression storage rejects is the caller's mistake.
    let bad = [Matcher::new("job", MatchOp::Re, "(")];
    assert_eq!(viz_query::label_names(&good.input(), &bad, T, T + 60_000).unwrap_err().error_type, ErrorType::BadData);
}

#[test]
fn metadata_calls() {
    let name = |v: &str| Matcher::new("__name__", MatchOp::Eq, v);
    for (which, s) in both() {
        let i = s.input();
        let (lo, hi) = (T, T + 120_000);
        assert_eq!(viz_query::label_names(&i, &[], lo, hi).unwrap(), ["__name__", "code", "job", "zone"], "{which}");
        assert_eq!(viz_query::label_names(&i, &[name("up")], lo, hi).unwrap(), ["__name__", "job"], "{which}");
        assert_eq!(viz_query::label_names(&i, &[Matcher::new("code", MatchOp::Re, "2..")], lo, hi).unwrap(), ["__name__", "code", "job"]);
        assert_eq!(viz_query::label_values(&i, "job", &[], lo, hi).unwrap(), ["api", "db"], "{which}");
        assert_eq!(viz_query::label_values(&i, "__name__", &[], lo, hi).unwrap(), ["http", "up"], "{which}");
        assert_eq!(viz_query::label_values(&i, "code", &[name("http")], lo, hi).unwrap(), ["200", "500"], "{which}");
        assert_eq!(viz_query::label_values(&i, "code", &[name("up")], lo, hi).unwrap(), Vec::<String>::new(), "{which}");
        assert_eq!(viz_query::label_values(&i, "nope", &[], lo, hi).unwrap(), Vec::<String>::new(), "{which}");
        // Outside the data's time range there is nothing; the range is inclusive.
        assert_eq!(viz_query::label_names(&i, &[], T - 1000, T - 1).unwrap(), Vec::<String>::new(), "{which}");
        assert_eq!(viz_query::label_values(&i, "job", &[], T - 1000, T).unwrap(), ["api", "db"], "{which}");
        assert_eq!(viz_query::label_values(&i, "job", &[], hi, hi + 5).unwrap(), ["api", "db"], "{which}");
        assert_eq!(viz_query::label_values(&i, "job", &[], hi + 1, hi + 5).unwrap(), Vec::<String>::new(), "{which}");

        let sets = vec![vec![name("up")], vec![name("http"), Matcher::new("code", MatchOp::Ne, "500")], vec![name("up")]];
        let got = viz_query::series(&i, &sets, lo, hi).unwrap();
        assert_eq!(got, vec![labels(&[("__name__", "http"), ("code", "200"), ("job", "api")]), labels(&[("__name__", "up"), ("job", "db")])], "{which}");
        assert_eq!(viz_query::labels_to_json(&got), r#"[{"__name__":"http","code":"200","job":"api"},{"__name__":"up","job":"db"}]"#);
        assert_eq!(viz_query::to_json(&viz_query::label_values(&i, "job", &[], lo, hi).unwrap()).unwrap(), r#"["api","db"]"#);

        // Prometheus refuses series() without a selective matcher set.
        for sets in [vec![], vec![vec![]], vec![vec![Matcher::new("job", MatchOp::Re, ".*")]], vec![vec![name("up")], vec![Matcher::new("x", MatchOp::Eq, "")]]] {
            assert_eq!(viz_query::series(&i, &sets, lo, hi).unwrap_err().error_type, ErrorType::BadData, "{sets:?}");
        }
        assert!(viz_query::series(&i, &[vec![Matcher::new("zone", MatchOp::Nre, "z")]], lo, hi).is_err(), "!~ that matches empty");
        assert_eq!(viz_query::series(&i, &[vec![Matcher::new("zone", MatchOp::Ne, "")]], lo, hi).unwrap().len(), 1, "{which}");
    }
}

#[test]
fn parse_selector_accepts_only_series_selectors() {
    assert_eq!(
        viz_query::parse_selector(r#"http{code=~"5..", job!="x"}"#).unwrap(),
        vec![Matcher::new("__name__", MatchOp::Eq, "http"), Matcher::new("code", MatchOp::Re, "5.."), Matcher::new("job", MatchOp::Ne, "x")]
    );
    assert_eq!(viz_query::parse_selector(r#"{__name__=~"a|b"}"#).unwrap(), vec![Matcher::new("__name__", MatchOp::Re, "a|b")]);
    for bad in ["", "sum(up)", "up offset 5m", "up @ 10", "up[5m]", "up + up", "(up)", "{}", r#"{job=~".*"}"#, "up{", "1", "up[1e400]"] {
        let e = viz_query::parse_selector(bad).expect_err(bad);
        assert_eq!(e.error_type, ErrorType::BadData, "{bad}: {e}");
    }
}

#[test]
fn selectors_and_plan_serialise_like_the_contract() {
    let sel = viz_query::selectors(r#"rate(http{code="200"}[1m])"#, 600_000, 900_000, 15_000).unwrap();
    assert_eq!(
        viz_query::to_json(&sel).unwrap(),
        r#"[{"matchers":[{"name":"__name__","op":"=","value":"http"},{"name":"code","op":"=","value":"200"}],"minTs":540001,"maxTs":900000}]"#
    );
    assert_eq!(sel[0].steps, 21);
    let plan = viz_query::plan(r#"rate(http{code="200"}[1m])"#, 600_000, 900_000, 15_000).unwrap();
    assert_eq!(viz_query::to_json(&plan).unwrap(), viz_query::to_json(&sel).unwrap());
}

#[test]
fn metadata_respects_limits() {
    let (_, s) = both().remove(2);
    let i = s.input();
    let tight = Limits { max_series: 2, ..Limits::default() };
    let e = viz_query::label_names_with(&i, &[], T, T + 120_000, &tight).unwrap_err();
    assert_eq!(e.limit, Some((viz_query::Limit::MaxSeries, 2, 3)));
    assert!(viz_query::label_names_with(&i, &[], T, T + 120_000, &Limits { max_series: 3, ..Limits::default() }).is_ok());
    let sets = vec![vec![Matcher::new("__name__", MatchOp::Eq, "up")], vec![Matcher::new("__name__", MatchOp::Eq, "http")]];
    let e = viz_query::series_with(&i, &sets, T, T + 120_000, &tight).unwrap_err();
    assert_eq!(e.limit, Some((viz_query::Limit::MaxSeries, 2, 3)), "the limit applies to the sum over matcher sets");
    let e = viz_query::label_values_with(&i, "job", &[], T, T + 120_000, &Limits { max_samples: 26, ..Limits::default() }).unwrap_err();
    assert_eq!(e.limit, Some((viz_query::Limit::MaxSamples, 26, 27)));
}
