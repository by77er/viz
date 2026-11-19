mod common;
use common::*;
use proptest::prelude::*;
use viz_storage::{
    encode_segment, encode_segment_with, merge_files_with, select, select_with, EncodedFile, Error, MatchOp, Matcher, ScanInput, SelectOptions, Table,
    WriteOptions,
};

/// Lake files in admission order.
#[derive(Default)]
struct Lake {
    samples: Vec<Vec<u8>>,
    series: Vec<Vec<u8>>,
}

impl Lake {
    fn add(&mut self, files: Vec<EncodedFile>) {
        for f in files {
            match f.table {
                Table::MetricSamples => self.samples.push(f.bytes),
                Table::MetricSeries => self.series.push(f.bytes),
            }
        }
    }
    fn input<'a>(&'a self, tail: &'a [Vec<u8>]) -> ScanInput<'a> {
        ScanInput {
            series_files: self.series.iter().map(|v| v.as_slice()).collect(),
            sample_files: self.samples.iter().map(|v| v.as_slice()).collect(),
            tail_batches: tail.iter().map(|v| v.as_slice()).collect(),
        }
    }
}

fn flush(batches: &[GenBatch]) -> Vec<EncodedFile> {
    let bytes: Vec<Vec<u8>> = batches.iter().map(|b| b.bytes()).collect();
    encode_segment(&bytes.iter().map(|b| b.as_slice()).collect::<Vec<_>>()).unwrap()
}

fn m(name: &str, op: MatchOp, value: &str) -> Matcher {
    Matcher::new(name, op, value)
}

const ALL: (i64, i64) = (i64::MIN, i64::MAX);

/// Names of the metrics selected, for compact assertions.
fn names(input: &ScanInput<'_>, matchers: &[Matcher]) -> Vec<String> {
    let mut v: Vec<String> = select(input, matchers, ALL.0, ALL.1)
        .unwrap()
        .into_iter()
        .map(|s| s.labels.iter().map(|(n, v)| if n == "__name__" { v.clone() } else { format!("{n}={v}") }).collect::<Vec<_>>().join(","))
        .collect();
    v.sort();
    v
}

fn fixture() -> Vec<GenBatch> {
    vec![batch_of(&[
        (&[("__name__", "up"), ("job", "api")], MID, 1.0),
        (&[("__name__", "up"), ("job", "db")], MID, 1.0),
        (&[("__name__", "up")], MID, 1.0),
        (&[("__name__", "cpu"), ("job", "api")], MID, 1.0),
        (&[("__name__", "cpu_total"), ("job", "api"), ("env", "p")], MID, 1.0),
    ])]
}

/// Run the same assertions with the data in the lake, in the tail, and in both.
fn everywhere(batches: &[GenBatch], check: impl Fn(&ScanInput<'_>)) {
    let tail: Vec<Vec<u8>> = batches.iter().map(|b| b.bytes()).collect();
    let mut lake = Lake::default();
    lake.add(flush(batches));
    check(&lake.input(&[]));
    check(&Lake::default().input(&tail));
    check(&lake.input(&tail));
}

#[test]
fn matcher_semantics() {
    everywhere(&fixture(), |i| {
        assert_eq!(names(i, &[]), ["cpu,job=api", "cpu_total,env=p,job=api", "up", "up,job=api", "up,job=db"]);
        assert_eq!(names(i, &[m("__name__", MatchOp::Eq, "up")]), ["up", "up,job=api", "up,job=db"]);
        assert_eq!(names(i, &[m("__name__", MatchOp::Eq, "u")]), [] as [&str; 0]);
        assert_eq!(names(i, &[m("__name__", MatchOp::Ne, "up")]), ["cpu,job=api", "cpu_total,env=p,job=api"]);
        // Conjunction.
        assert_eq!(names(i, &[m("__name__", MatchOp::Eq, "up"), m("job", MatchOp::Eq, "api")]), ["up,job=api"]);
        // A missing label is the empty string.
        assert_eq!(names(i, &[m("job", MatchOp::Eq, "")]), ["up"]);
        assert_eq!(names(i, &[m("job", MatchOp::Ne, "")]), ["cpu,job=api", "cpu_total,env=p,job=api", "up,job=api", "up,job=db"]);
        assert_eq!(names(i, &[m("nope", MatchOp::Eq, "")]).len(), 5);
        assert_eq!(names(i, &[m("nope", MatchOp::Ne, "")]).len(), 0);
        assert_eq!(names(i, &[m("job", MatchOp::Re, "")]), ["up"]);
        assert_eq!(names(i, &[m("job", MatchOp::Re, ".*")]).len(), 5);
        assert_eq!(names(i, &[m("job", MatchOp::Re, ".+")]).len(), 4);
        assert_eq!(names(i, &[m("job", MatchOp::NotRe, ".+")]), ["up"]);
        assert_eq!(names(i, &[m("env", MatchOp::NotRe, "p")]).len(), 4);
        // Regexes are anchored at both ends.
        assert_eq!(names(i, &[m("__name__", MatchOp::Re, "cpu")]), ["cpu,job=api"]);
        assert_eq!(names(i, &[m("__name__", MatchOp::Re, "p")]), [] as [&str; 0]);
        assert_eq!(names(i, &[m("__name__", MatchOp::Re, "u")]), [] as [&str; 0]);
        assert_eq!(names(i, &[m("__name__", MatchOp::Re, "cpu.*")]), ["cpu,job=api", "cpu_total,env=p,job=api"]);
        assert_eq!(names(i, &[m("__name__", MatchOp::Re, ".*_total")]), ["cpu_total,env=p,job=api"]);
        // Alternation is anchored as a whole, not just its first or last branch.
        assert_eq!(names(i, &[m("__name__", MatchOp::Re, "u|cpu")]), ["cpu,job=api"]);
        assert_eq!(names(i, &[m("job", MatchOp::Re, "a|db")]), ["up,job=db"]);
        assert_eq!(names(i, &[m("job", MatchOp::NotRe, "api|d")]), ["up", "up,job=db"]);
        assert_eq!(names(i, &[m("__name__", MatchOp::NotRe, "c")]).len(), 5);
        // Bad regex is an error, not a panic or an empty result.
        match select(i, &[m("job", MatchOp::Re, "(")], 0, 1) {
            Err(Error::Matcher { name, .. }) => assert_eq!(name, "job"),
            other => panic!("{other:?}"),
        }
    });
}

#[test]
fn dot_matches_newline_like_prometheus() {
    let b = [batch_of(&[(&[("__name__", "m"), ("msg", "a\nb")], MID, 1.0)])];
    everywhere(&b, |i| {
        assert_eq!(names(i, &[m("msg", MatchOp::Re, "a.b")]).len(), 1);
        assert_eq!(names(i, &[m("msg", MatchOp::Re, "a")]).len(), 0);
    });
}

#[test]
fn time_range_is_inclusive_and_filters_rows_and_series() {
    let up: &[(&str, &str)] = &[("__name__", "up")];
    let b = [batch_of(&[(up, 100, 1.0), (up, 200, 2.0), (up, 300, 3.0), (&[("__name__", "late")], 900, 9.0)])];
    everywhere(&b, |i| {
        let ts = |lo, hi| select(i, &[], lo, hi).unwrap().into_iter().map(|s| (s.labels[0].1.clone(), s.ts)).collect::<Vec<_>>();
        assert_eq!(ts(100, 300), vec![("up".to_string(), vec![100, 200, 300])]);
        assert_eq!(ts(101, 299), vec![("up".to_string(), vec![200])]);
        assert_eq!(ts(200, 200), vec![("up".to_string(), vec![200])]);
        assert_eq!(ts(201, 299), vec![]);
        assert_eq!(ts(300, 100), vec![]); // empty range
        assert_eq!(ts(300, 900), vec![("late".to_string(), vec![900]), ("up".to_string(), vec![300])]);
        assert_eq!(ts(i64::MIN, 99), vec![]);
    });
}

#[test]
fn precedence_tail_over_lake_and_later_over_earlier() {
    let up: &[(&str, &str)] = &[("__name__", "up")];
    let b0 = batch_of(&[(up, 1, 10.0), (up, 2, 10.0), (up, 3, 10.0), (up, 4, 10.0)]);
    let b1 = batch_of(&[(up, 2, 20.0), (up, 3, 20.0), (up, 4, 20.0)]);
    let b2 = batch_of(&[(up, 3, 30.0), (up, 4, 30.0)]);
    let b3 = batch_of(&[(up, 4, 40.0), (up, 4, 41.0)]);
    let vals = |i: &ScanInput<'_>| select(i, &[], ALL.0, ALL.1).unwrap()[0].values.clone();

    // Two lake files (later file wins), two tail batches (later wins, and tail beats lake).
    let mut lake = Lake::default();
    lake.add(flush(&[b0.clone()]));
    lake.add(flush(&[b1.clone()]));
    let tail = vec![b2.bytes(), b3.bytes()];
    assert_eq!(vals(&lake.input(&tail)), vec![10.0, 20.0, 30.0, 41.0]);
    assert_eq!(vals(&lake.input(&[])), vec![10.0, 20.0, 20.0, 20.0]);

    // Lake file order is the precedence, not time or value.
    let mut rev = Lake::default();
    rev.add(flush(&[b1.clone()]));
    rev.add(flush(&[b0.clone()]));
    assert_eq!(vals(&rev.input(&[])), vec![10.0, 10.0, 10.0, 10.0]);

    // The tail wins even when the lake file was flushed from later batches.
    let mut late = Lake::default();
    late.add(flush(&[b3.clone()]));
    assert_eq!(vals(&late.input(&[b0.bytes()])), vec![10.0, 10.0, 10.0, 10.0]);

    // Tail batch order.
    assert_eq!(vals(&Lake::default().input(&[b1.bytes(), b0.bytes()])), vec![10.0, 10.0, 10.0, 10.0]);
    assert_eq!(vals(&Lake::default().input(&[b0.bytes(), b1.bytes()])), vec![10.0, 20.0, 20.0, 20.0]);
}

#[test]
fn nan_bits_survive_select_from_lake_and_tail() {
    let b = [GenBatch {
        series: vec![labels(&[("__name__", "m")])],
        rows: vec![
            viz_storage::batch::Row { series_idx: 0, ts: 1, value_bits: viz_storage::batch::STALE_NAN_BITS },
            viz_storage::batch::Row { series_idx: 0, ts: 2, value_bits: 0xfff8_0000_dead_beef },
        ],
    }];
    everywhere(&b, |i| {
        let out = select(i, &[], ALL.0, ALL.1).unwrap();
        assert_eq!(out[0].values.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), vec![viz_storage::batch::STALE_NAN_BITS, 0xfff8_0000_dead_beef]);
    });
}

#[test]
fn bad_inputs_are_errors() {
    let good = fixture();
    let files = flush(&good);
    let (samples, series) = (&files[0].bytes, &files[1].bytes);
    let run = |i: ScanInput<'_>| select(&i, &[], ALL.0, ALL.1);
    assert!(matches!(run(ScanInput { series_files: vec![b"garbage"], ..Default::default() }), Err(Error::Parquet { index: Some(0), .. })));
    assert!(matches!(run(ScanInput { series_files: vec![series], sample_files: vec![&samples[..samples.len() / 2]], ..Default::default() }), Err(Error::Parquet { .. })));
    // Files passed in the wrong slot are a schema error.
    assert!(matches!(run(ScanInput { series_files: vec![samples], ..Default::default() }), Err(Error::Schema { index: 0, .. })));
    assert!(matches!(run(ScanInput { series_files: vec![series], sample_files: vec![series], ..Default::default() }), Err(Error::Schema { .. })));
    assert!(matches!(run(ScanInput { tail_batches: vec![&good[0].bytes(), b"VZB1"], ..Default::default() }), Err(Error::Batch { index: 1, .. })));
    assert_eq!(run(ScanInput::default()).unwrap(), vec![]);
}

#[test]
fn many_row_groups_and_metrics_prune_consistently() {
    // 40 metrics x 5 series x 30 points, 64-row groups: most groups are prunable for a
    // one-metric query, and the answer must not change.
    let mut rows = Vec::new();
    let names: Vec<String> = (0..40).map(|i| format!("metric_{i:02}")).collect();
    let insts: Vec<String> = (0..5).map(|i| format!("i{i}")).collect();
    for (mi, n) in names.iter().enumerate() {
        for (ii, inst) in insts.iter().enumerate() {
            for p in 0..30 {
                rows.push((vec![("__name__", n.as_str()), ("instance", inst.as_str())], MID + p * 1000, (mi * 1000 + ii * 100) as f64 + p as f64));
            }
        }
    }
    let rows_ref: Vec<(&[(&str, &str)], i64, f64)> = rows.iter().map(|(l, t, v)| (l.as_slice(), *t, *v)).collect();
    let b = batch_of(&rows_ref);
    let files = encode_segment_with(&[&b.bytes()], &WriteOptions { max_row_group_rows: 64, ..Default::default() }).unwrap();
    let mut lake = Lake::default();
    lake.add(files);
    let input = lake.input(&[]);
    for matchers in [
        vec![m("__name__", MatchOp::Eq, "metric_17")],
        vec![m("__name__", MatchOp::Re, "metric_1[0-3]"), m("instance", MatchOp::Ne, "i0")],
        vec![m("instance", MatchOp::Eq, "i4")],
        vec![m("__name__", MatchOp::Eq, "metric_99")],
    ] {
        for (lo, hi) in [ALL, (MID + 5000, MID + 7000), (MID + 29_000, MID + 40_000), (0, 5)] {
            let a = select_with(&input, &matchers, lo, hi, &SelectOptions { prune_row_groups: true }).unwrap();
            let b2 = select_with(&input, &matchers, lo, hi, &SelectOptions { prune_row_groups: false }).unwrap();
            assert_eq!(normalize(a.clone()), normalize(b2));
            let want = reference_select(&[b.clone()], &[], lo, hi)
                .into_iter()
                .filter(|(l, _)| select(&Lake::default().input(&[b.bytes()]), &matchers, ALL.0, ALL.1).unwrap().iter().any(|s| &s.labels == l))
                .collect::<Vec<_>>();
            assert_eq!(normalize(a), want);
        }
    }
    let one = select(&input, &[m("__name__", MatchOp::Eq, "metric_17")], MID + 5000, MID + 7000).unwrap();
    assert_eq!(one.len(), 5);
    assert!(one.iter().all(|s| s.ts == vec![MID + 5000, MID + 6000, MID + 7000]));
    assert_eq!(one[2].values, vec![17_205.0, 17_206.0, 17_207.0]);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(600))]

    /// Storage-location invariance. Batches 0..n in sequence order; the first `k` are
    /// flushed to the lake (cut into segments at arbitrary points, with arbitrary
    /// row-group sizes, optionally compacted per day), and the tail holds batches `j..n`
    /// for some `j <= k` (so it may overlap what is already flushed, as a shard's
    /// retained segments do). Every arrangement must give exactly the reference answer,
    /// with and without row-group pruning.
    #[test]
    fn select_is_location_invariant(
        batches in arb_batches(7),
        k_sel in any::<prop::sample::Index>(),
        j_sel in any::<prop::sample::Index>(),
        cuts in proptest::collection::vec(any::<bool>(), 7),
        cap in 1usize..7,
        compact in any::<bool>(),
        matchers in proptest::collection::vec(arb_matcher(), 0..3),
        lo in 0usize..TS.len(),
        hi in 0usize..TS.len(),
        full_range in any::<bool>(),
    ) {
        let n = batches.len();
        let k = k_sel.index(n + 1);
        let j = j_sel.index(k + 1);
        let (min_ts, max_ts) = if full_range { ALL } else { (TS[lo] - (lo % 2) as i64, TS[hi] + (hi % 2) as i64) };
        let bytes: Vec<Vec<u8>> = batches.iter().map(|b| b.bytes()).collect();
        let opts = WriteOptions { max_row_group_rows: cap, ..Default::default() };

        let mut lake = Lake::default();
        let mut by_day: std::collections::BTreeMap<String, (Vec<Vec<u8>>, Vec<Vec<u8>>)> = Default::default();
        let mut seg: Vec<&[u8]> = Vec::new();
        for i in 0..k {
            seg.push(&bytes[i]);
            if cuts[i] || i + 1 == k {
                let files = encode_segment_with(&seg, &opts).unwrap();
                seg.clear();
                if compact {
                    for f in files {
                        let e = by_day.entry(f.day.clone()).or_default();
                        match f.table { Table::MetricSamples => e.0.push(f.bytes), Table::MetricSeries => e.1.push(f.bytes) }
                    }
                } else {
                    lake.add(files);
                }
            }
        }
        for (_, (samples, series)) in by_day {
            let s: Vec<&[u8]> = samples.iter().map(|v| v.as_slice()).collect();
            let r: Vec<&[u8]> = series.iter().map(|v| v.as_slice()).collect();
            lake.add(vec![merge_files_with(Table::MetricSamples, &s, &opts).unwrap(), merge_files_with(Table::MetricSeries, &r, &opts).unwrap()]);
        }

        let ms: Vec<Matcher> = matchers.iter().map(|m| m.m.clone()).collect();
        let want = reference_select(&batches, &matchers, min_ts, max_ts);

        let split = lake.input(&bytes[j..]);
        let pruned = select_with(&split, &ms, min_ts, max_ts, &SelectOptions { prune_row_groups: true }).unwrap();
        let unpruned = select_with(&split, &ms, min_ts, max_ts, &SelectOptions { prune_row_groups: false }).unwrap();
        prop_assert_eq!(&normalize(pruned), &want, "lake[0..{}) + tail[{}..{})", k, j, n);
        prop_assert_eq!(&normalize(unpruned), &want, "unpruned");

        // The two extremes: everything in the tail, and (when k == n) everything in the lake.
        let all_tail = Lake::default();
        prop_assert_eq!(&normalize(select(&all_tail.input(&bytes), &ms, min_ts, max_ts).unwrap()), &want, "all tail");
        if k == n {
            prop_assert_eq!(&normalize(select(&lake.input(&[]), &ms, min_ts, max_ts).unwrap()), &want, "all lake");
        }
    }
}
