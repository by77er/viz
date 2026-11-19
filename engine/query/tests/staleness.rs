//! Staleness markers across the storage boundary.
//!
//! Storage keeps the marker's bits; the evaluator interprets them. What Prometheus does
//! (`promql/engine.go`, v3.8): an instant selector returns nothing for a series whose
//! newest sample in the lookback window is a marker; a range vector skips markers; a
//! plain NaN is an ordinary value; a later sample revives the series.
mod common;

use common::*;

/// Samples at T, T+15 s and T+30 s (the last one exactly at UTC midnight, so it is in the
/// second day's file), then whatever `after` holds.
const T: i64 = MID - 30_000;
const S: i64 = T / 1000; // T in Unix seconds, as results print it

fn history(after: &[(i64, f64)]) -> History {
    let up: &[(&str, &str)] = &[("__name__", "up"), ("job", "a")];
    let mut rows: Vec<(&[(&str, &str)], i64, f64)> = vec![(up, T, 1.0), (up, T + 15_000, 1.0), (up, T + 30_000, 1.0)];
    for (t, v) in after {
        rows.push((up, *t, *v));
    }
    // One write per batch, so the marker can be placed on either side of the boundary.
    let n = rows.len();
    History::from_rows(&rows).cut(&(1..n).collect::<Vec<_>>())
}

/// The placements that matter: where the marker (the 4th write) lives relative to the
/// samples before it.
fn placements(h: &History) -> Vec<(&'static str, Stored)> {
    let b = h.encoded();
    let n = b.len();
    let lake = |flushed: usize, tail_from: usize, row_group_rows: usize, compact: bool| {
        store(&b, &Layout { flushed, tail_from, segment_cuts: vec![2], row_group_rows, compact })
    };
    vec![
        ("marker in the tail, samples in the tail", store(&b, &Layout::all_tail())),
        ("marker in the tail, samples in Parquet", lake(3, 3, 100_000, false)),
        ("marker in a Parquet file, nothing in the tail", store(&b, &Layout::all_lake(n))),
        ("marker in a Parquet file with 1-row row groups, compacted", lake(n, n, 1, true)),
        ("marker in a Parquet file and again in the tail", lake(n, 3, 2, false)),
        ("marker in a Parquet file, later writes in the tail", lake(4, 4, 100_000, false)),
    ]
}

fn instant(s: &Stored, q: &str, t: i64) -> String {
    viz_query::query_instant(&s.input(), q, t).unwrap_or_else(|e| panic!("{q}: {e}"))
}

fn range(s: &Stored, q: &str, start: i64, end: i64, step: i64) -> String {
    viz_query::query_range(&s.input(), q, start, end, step).unwrap_or_else(|e| panic!("{q}: {e}"))
}

const EMPTY_VECTOR: &str = r#"{"resultType":"vector","result":[]}"#;

#[test]
fn a_marker_ends_the_series_exactly_at_its_timestamp() {
    let h = history(&[(T + 45_000, stale())]);
    for (name, s) in placements(&h) {
        // One millisecond before the marker the last real sample is still returned...
        assert_eq!(
            instant(&s, "up", T + 44_999),
            format!(r#"{{"resultType":"vector","result":[{{"metric":{{"__name__":"up","job":"a"}},"value":[{}.999,"1"]}}]}}"#, S + 44),
            "{name}"
        );
        // ...at the marker's own timestamp the series is gone, and it stays gone although
        // the sample at T+30s is well inside the five-minute lookback.
        for t in [T + 45_000, T + 45_001, T + 60_000, T + 300_000] {
            assert_eq!(instant(&s, "up", t), EMPTY_VECTOR, "{name} at {t}");
        }
        // A range query stops at the last step before the marker: exactly three points.
        assert_eq!(
            range(&s, "up", T, T + 120_000, 15_000),
            format!(
                r#"{{"resultType":"matrix","result":[{{"metric":{{"__name__":"up","job":"a"}},"values":[[{},"1"],[{},"1"],[{},"1"]]}}]}}"#,
                S,
                S + 15,
                S + 30
            ),
            "{name}"
        );
        // Range vectors skip the marker: the window (T, T+60s] holds two real samples.
        assert_eq!(
            instant(&s, "count_over_time(up[1m])", T + 60_000),
            format!(r#"{{"resultType":"vector","result":[{{"metric":{{"job":"a"}},"value":[{},"2"]}}]}}"#, S + 60),
            "{name}"
        );
        // The marker is a sample to storage (it is what was written), never to a result.
        let m = instant(&s, "up[2m]", T + 60_000);
        assert!(!m.contains("NaN"), "{name}: {m}");
        assert_eq!(m.matches("\"1\"").count(), 3, "{name}: {m}");
    }
}

#[test]
fn without_the_marker_the_series_lives_for_the_lookback() {
    // The control: the same data with no marker is visible until T+30s+5m (exclusive).
    let h = history(&[]);
    for (name, s) in placements(&h) {
        assert_ne!(instant(&s, "up", T + 60_000), EMPTY_VECTOR, "{name}");
        assert_ne!(instant(&s, "up", T + 30_000 + 299_999), EMPTY_VECTOR, "{name}");
        assert_eq!(instant(&s, "up", T + 30_000 + 300_000), EMPTY_VECTOR, "{name}");
    }
}

#[test]
fn a_later_sample_revives_the_series_and_plain_nan_is_a_value() {
    let h = history(&[(T + 45_000, stale()), (T + 75_000, 7.0), (T + 90_000, f64::NAN)]);
    for (name, s) in placements(&h) {
        assert_eq!(
            range(&s, "up", T + 30_000, T + 105_000, 15_000),
            format!(
                r#"{{"resultType":"matrix","result":[{{"metric":{{"__name__":"up","job":"a"}},"values":[[{},"1"],[{},"7"],[{},"NaN"],[{},"NaN"]]}}]}}"#,
                S + 30,
                S + 75,
                S + 90,
                S + 105
            ),
            "{name}"
        );
    }
}

#[test]
fn a_marker_overwritten_in_the_tail_is_not_a_marker_and_vice_versa() {
    // De-duplication decides which value a timestamp has before staleness is looked at:
    // the lake says "stale at T+45s", a later tail write to the same timestamp says 5.
    let h = history(&[(T + 45_000, stale()), (T + 45_000, 5.0)]);
    let b = h.encoded();
    let revived = store(&b, &Layout { flushed: 4, tail_from: 4, segment_cuts: vec![], row_group_rows: 100_000, compact: false });
    assert!(instant(&revived, "up", T + 45_000).contains(r#""5"]"#));
    // And the other way round: the lake holds 5, the tail's later write is the marker.
    let h = history(&[(T + 45_000, 5.0), (T + 45_000, stale())]);
    let b = h.encoded();
    let ended = store(&b, &Layout { flushed: 4, tail_from: 4, segment_cuts: vec![], row_group_rows: 100_000, compact: false });
    assert_eq!(instant(&ended, "up", T + 45_000), EMPTY_VECTOR);
    // With both in the lake the later batch wins there too.
    let ended = store(&b, &Layout::all_lake(b.len()));
    assert_eq!(instant(&ended, "up", T + 45_000), EMPTY_VECTOR);
}

#[test]
fn the_source_hands_the_marker_bits_over_untouched() {
    use viz_promql::{MatchOp, Matcher, SeriesSource};
    let h = history(&[(T + 45_000, stale())]);
    for (name, s) in placements(&h) {
        let input = s.input();
        let src = viz_query::StorageSource::new(&input, viz_query::Limits::default());
        let got = src.select(&[Matcher::new("__name__", MatchOp::Eq, "up")], T + 45_000, T + 45_000).unwrap();
        assert_eq!(got.len(), 1, "{name}");
        assert_eq!(got[0].ts, vec![T + 45_000], "{name}");
        assert_eq!(got[0].values[0].to_bits(), 0x7ff0_0000_0000_0002, "{name}");
    }
}
