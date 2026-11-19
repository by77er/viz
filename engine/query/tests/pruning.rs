//! Series-level pruning and the series-only read (query/CARDINALITY.md, items 2 and 3).
//!
//! - `the_sample_plan_never_changes_a_result` (I14): every query of the pool, over the
//!   files read as `sample_plan` and `file_plan` say (skipped, whole, or as sparse files of
//!   the planned ranges), gives the same JSON and the same statistics as over whole files;
//!   and a split part's extract over its planned files is byte-identical.
//! - `label_calls_list_exactly_the_series_in_the_window_per_file` (I17): the label calls
//!   equal a reference computed from the write history and the layout alone (which file
//!   holds which rows), in every placement; and they always include the series a query
//!   over the window would see.
//! - Directed tests: pruning really prunes (a one-series read of a large file fetches a
//!   fraction of it), the fragment of an older file falls back to whole reads, a part's
//!   plan is its key range.
mod common;

use common::*;
use proptest::prelude::*;
use std::collections::{BTreeMap, BTreeSet};
use viz_promql::{MatchOp, Matcher};
use viz_query::split::{self, SplitPlan};
use viz_query::{file_plan, plan, sample_plan, selectors, FilePlan, FileRead, Limits, Options, PartFilter, ScanInput, SplitKey};
use viz_storage::{batch, encode_segment_with, sparse, FileIndex, WriteOptions};

fn cut(file: &[u8], p: &FilePlan) -> Option<Vec<u8>> {
    match &p.read {
        FileRead::Skip => None,
        FileRead::Whole => Some(file.to_vec()),
        FileRead::Ranges(r) => Some(sparse::cut(file, r)),
    }
}

/// The input a caller following the plans would hand the engine.
fn planned(s: &Stored, series: &[FilePlan], samples: &[FilePlan]) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let a = s.series_files.iter().zip(series).filter_map(|(f, p)| cut(f, p)).collect();
    let b = s.sample_files.iter().zip(samples).filter_map(|(f, p)| cut(f, p)).collect();
    (a, b)
}

fn input<'a>(series: &'a [Vec<u8>], samples: &'a [Vec<u8>], tail: &'a [Vec<u8>]) -> ScanInput<'a> {
    ScanInput {
        series_files: series.iter().map(|f| f.as_slice()).collect(),
        sample_files: samples.iter().map(|f| f.as_slice()).collect(),
        tail_batches: tail.iter().map(|f| f.as_slice()).collect(),
    }
}

fn idx(v: &[String]) -> Vec<&str> {
    v.iter().map(|s| s.as_str()).collect()
}

fn run(i: &ScanInput<'_>, q: &str, start: i64, end: i64, step: i64) -> Result<(String, viz_query::Stats), String> {
    let opts = Options { limits: Limits::unlimited(), ..Options::default() };
    viz_query::query_range_with(i, q, start, end, step, &opts).map(|r| (viz_query::to_json(&r.matrix).unwrap(), r.stats)).map_err(|e| e.message)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(32), failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn the_sample_plan_never_changes_a_result(
        h in history_strategy(),
        layout in layout_strategy(),
        start in (T0 - 20_000)..(T0 + 400_000),
        nsteps in 1i64..8,
        step in prop_oneof![Just(15_000i64), 1_000i64..120_000],
        gap in prop_oneof![Just(0u64), Just(64u64), Just(1u64 << 16)],
    ) {
        let end = start + (nsteps - 1) * step;
        let b = h.encoded();
        let s = store(&b, &layout);
        let whole = s.input();
        for q in QUERIES {
            let (Ok(ranges), Ok(reads)) = (plan(q, start, end, step), selectors(q, start, end, step)) else { continue };
            let reads: Vec<viz_query::FetchRange> = reads.into_iter().map(|r| viz_query::FetchRange { matchers: r.matchers, min_ts: r.min_ts_ms, max_ts: r.max_ts_ms }).collect();
            let series_plan = file_plan(&idx(&s.series_index), &ranges, gap);
            let sp = sample_plan(&whole.series_files, &idx(&s.sample_index), &reads, None, gap).unwrap();
            let (series, samples) = planned(&s, &series_plan, &sp.files);
            let got = run(&input(&series, &samples, &s.tail), q, start, end, step);
            let want = run(&whole, q, start, end, step);
            prop_assert_eq!(got, want, "query {}", q);
            // The bound still bounds: what select loads from the lake never exceeds the rows planned.
            let rows: u64 = sp.files.iter().map(|f| f.rows.unwrap()).sum();
            let lake_only = input(&series, &samples, &[]);
            if let Ok((_, st)) = run(&lake_only, q, start, end, step) {
                prop_assert!(st.samples <= rows, "query {}: loaded {} > planned {}", q, st.samples, rows);
            }

            // A split part's extract over its own planned files is what it is over all of them.
            if let SplitPlan::Split { key, .. } = viz_query::split_plan(q, &Options::default()) {
                for parts in [1u32, 3] {
                    for part in 0..parts {
                        let pf = PartFilter { key: &key, part, parts };
                        let pp = sample_plan(&whole.series_files, &idx(&s.sample_index), &ranges, Some(pf), gap).unwrap();
                        let (_, mine) = planned(&s, &series_plan, &pp.files);
                        let mine: Vec<&[u8]> = mine.iter().map(|f| f.as_slice()).collect();
                        let a = split::extract(&whole.series_files, &mine, &key, part, parts, &ranges).unwrap();
                        let b = split::extract(&whole.series_files, &whole.sample_files, &key, part, parts, &ranges).unwrap();
                        prop_assert_eq!(a, b, "query {}, part {} of {}", q, part, parts);
                    }
                }
            }
        }
    }

    #[test]
    fn label_calls_list_exactly_the_series_in_the_window_per_file(
        h in history_strategy(),
        layout in layout_strategy(),
        lo in (T0 - 20_000)..(T0 + 700_000),
        len in prop_oneof![0i64..1_000, 0i64..200_000, Just(10_000_000i64)],
    ) {
        let hi = lo + len;
        let b = h.encoded();
        let s = store(&b, &layout);
        let want = per_file_reference(&b, &layout, lo, hi);
        // A query over the window would see these: they must always be listed.
        let exact: BTreeSet<Labels> = h.reference().into_iter().filter(|x| x.ts.iter().any(|t| *t >= lo && *t <= hi)).map(|x| x.labels).collect();
        prop_assert!(exact.is_subset(&want), "the reference itself");
        let m = |n: &str, op: MatchOp, v: &str| Matcher::new(n, op, v);
        for matchers in [
            vec![],
            vec![m("__name__", MatchOp::Eq, "n")],
            vec![m("job", MatchOp::Eq, "x")],
            vec![m("__name__", MatchOp::Re, "m|h_bucket"), m("le", MatchOp::Ne, "1")],
        ] {
            let ok = |l: &Labels| matchers.iter().all(|mm| mm.compile().unwrap().matches(l));
            let w: Vec<Labels> = want.iter().filter(|l| ok(l)).cloned().collect();
            if !matchers.is_empty() {
                let got = viz_query::series(&s.input(), &[matchers.clone()], lo, hi).unwrap();
                prop_assert_eq!(&got, &w, "series {:?}", matchers);
            }
            let names: BTreeSet<String> = w.iter().flat_map(|l| l.iter().map(|(n, _)| n.clone())).collect();
            prop_assert_eq!(viz_query::label_names(&s.input(), &matchers, lo, hi).unwrap(), names.into_iter().collect::<Vec<_>>());
            let jobs: BTreeSet<String> = w.iter().flat_map(|l| l.iter().filter(|(n, _)| n == "job").map(|(_, v)| v.clone())).collect();
            prop_assert_eq!(viz_query::label_values(&s.input(), "job", &matchers, lo, hi).unwrap(), jobs.into_iter().collect::<Vec<_>>());
        }
        // The sample files are never read: the answers are the same without them.
        let no_samples = ScanInput { sample_files: vec![], ..s.input() };
        prop_assert_eq!(viz_query::label_names(&no_samples, &[], lo, hi).unwrap(), viz_query::label_names(&s.input(), &[], lo, hi).unwrap());
    }
}

/// The per-file reference, from the history and the layout only: a series is in the
/// window if, in some lake file (a segment's day, or a compacted day), its rows' first and
/// last timestamps overlap the window, or one of its tail rows lies in it.
fn per_file_reference(batches: &[Vec<u8>], layout: &Layout, lo: i64, hi: i64) -> BTreeSet<Labels> {
    let n = batches.len();
    let flushed = layout.flushed.min(n);
    let mut cuts: Vec<usize> = layout.segment_cuts.iter().copied().filter(|c| *c > 0 && *c < flushed).collect();
    cuts.sort_unstable();
    cuts.dedup();
    cuts.push(flushed);
    // file -> series -> (first, last)
    let mut files: BTreeMap<(usize, i64), BTreeMap<Labels, (i64, i64)>> = BTreeMap::new();
    let mut prev = 0;
    for (si, c) in cuts.iter().enumerate() {
        for bytes in &batches[prev..*c] {
            let b = batch::decode(bytes).unwrap();
            for i in 0..b.n_rows() {
                let t = b.ts(i);
                let l: Labels = b.series()[b.series_idx(i) as usize].labels.iter().map(|(a, v)| (a.to_string(), v.to_string())).collect();
                // A compacted lake has one file per day; otherwise one per segment and day.
                let file = (if layout.compact { 0 } else { si }, t.div_euclid(86_400_000));
                let e = files.entry(file).or_default().entry(l).or_insert((t, t));
                e.0 = e.0.min(t);
                e.1 = e.1.max(t);
            }
        }
        prev = *c;
    }
    let mut out = BTreeSet::new();
    for series in files.values() {
        for (l, (a, b)) in series {
            if *a <= hi && *b >= lo {
                out.insert(l.clone());
            }
        }
    }
    for bytes in &batches[layout.tail_from.min(n)..] {
        let b = batch::decode(bytes).unwrap();
        for i in 0..b.n_rows() {
            if b.ts(i) >= lo && b.ts(i) <= hi {
                out.insert(b.series()[b.series_idx(i) as usize].labels.iter().map(|(a, v)| (a.to_string(), v.to_string())).collect());
            }
        }
    }
    out
}

/// 4,000 series of one metric in one file of 20,000 rows, row groups of 1,000.
fn big() -> (Vec<u8>, String, Vec<u8>, String, Vec<Labels>) {
    let ls: Vec<Labels> = (0..4000).map(|i| labels(&[("__name__", "x"), ("pod", &format!("p{i:05}")), ("ns", &format!("n{}", i % 20))])).collect();
    let pool: Vec<Labels> = ls.clone();
    let mut writes = Vec::new();
    for k in 0..5i64 {
        for i in 0..ls.len() {
            writes.push(Write { series: i, ts: MID + k * 60_000, value: k as f64 });
        }
    }
    let b = encode_batch(&pool, &writes);
    let files = encode_segment_with(&[&b], &WriteOptions { max_row_group_rows: 1000, ..Default::default() }).unwrap();
    (files[0].bytes.clone(), files[0].index.clone(), files[1].bytes.clone(), files[1].index.clone(), ls)
}

#[test]
fn one_series_of_a_large_file_reads_one_row_group_and_the_footer() {
    let (samples, sidx, series, _, _) = big();
    let fi = FileIndex::from_json(&sidx).unwrap();
    assert_eq!(fi.row_groups.len(), 20);
    let reads = vec![viz_query::FetchRange { matchers: vec![Matcher::new("__name__", MatchOp::Eq, "x"), Matcher::new("pod", MatchOp::Eq, "p01234")], min_ts: MID, max_ts: MID + 300_000 }];
    let p = sample_plan(&[&series], &[&sidx], &reads, None, 0).unwrap();
    assert_eq!(p.series, 1);
    let FileRead::Ranges(r) = &p.files[0].read else { panic!("{:?}", p.files[0]) };
    assert_eq!(r.len(), 2, "one row group and the footer: {r:?}");
    assert_eq!(p.files[0].rows, Some(1000));
    assert!(p.files[0].bytes(samples.len() as u64) * 10 < samples.len() as u64, "{} of {} bytes", p.files[0].bytes(samples.len() as u64), samples.len());
    // And it reads back as the whole file does.
    let sp = sparse::cut(&samples, r);
    let a = ScanInput { series_files: vec![&series], sample_files: vec![&sp], tail_batches: vec![] };
    let b = ScanInput { series_files: vec![&series], sample_files: vec![&samples], tail_batches: vec![] };
    let q = r#"x{pod="p01234"}"#;
    assert_eq!(run(&a, q, MID, MID + 240_000, 60_000), run(&b, q, MID, MID + 240_000, 60_000));
    assert!(run(&a, q, MID, MID + 240_000, 60_000).unwrap().0.contains("p01234"));
    // A 1/20 selection is scattered over the id space: every row group, so the whole file.
    let reads = vec![viz_query::FetchRange { matchers: vec![Matcher::new("__name__", MatchOp::Eq, "x"), Matcher::new("ns", MatchOp::Eq, "n3")], min_ts: MID, max_ts: MID + 300_000 }];
    let p = sample_plan(&[&series], &[&sidx], &reads, None, 0).unwrap();
    assert_eq!((p.series, &p.files[0].read, p.files[0].rows), (200, &FileRead::Whole, Some(20_000)));
    // Another metric: nothing. Outside the time: nothing.
    let reads = vec![viz_query::FetchRange { matchers: vec![Matcher::new("__name__", MatchOp::Eq, "y")], min_ts: MID, max_ts: MID + 300_000 }];
    assert_eq!(sample_plan(&[&series], &[&sidx], &reads, None, 0).unwrap().files[0].read, FileRead::Skip);
    let reads = vec![viz_query::FetchRange { matchers: vec![Matcher::new("pod", MatchOp::Eq, "p00001")], min_ts: MID + 300_001, max_ts: MID + 400_000 }];
    let p = sample_plan(&[&series], &[&sidx], &reads, None, 0).unwrap();
    assert_eq!((p.series, &p.files[0].read), (0, &FileRead::Skip));
}

#[test]
fn a_part_reads_its_key_range() {
    let (samples, sidx, series, _, _) = big();
    let ranges = vec![viz_query::FetchRange { matchers: vec![Matcher::new("__name__", MatchOp::Eq, "x")], min_ts: MID, max_ts: MID + 300_000 }];
    let key = SplitKey::default();
    let mut total = 0u64;
    for part in 0..7 {
        let p = sample_plan(&[&series], &[&sidx], &ranges, Some(PartFilter { key: &key, part, parts: 7 }), 0).unwrap();
        let FileRead::Ranges(r) = &p.files[0].read else { panic!("part {part}: {:?}", p.files[0]) };
        // The part's seventh of the ids, plus at most the row groups at its two ends.
        let rows = p.files[0].rows.unwrap();
        assert!(rows <= 20_000 / 7 + 2 * 1000 + 1000, "part {part}: {rows} rows");
        total += r.iter().map(|x| x.1).sum::<u64>();
    }
    assert!(total < 2 * samples.len() as u64, "all seven parts together read {total} bytes of a {}-byte file", samples.len());
}

#[test]
fn an_older_fragment_reads_whole_files_and_a_broken_one_is_kept() {
    let (_, sidx, series, _, _) = big();
    // Strip the 2026-11-19 fields: what a file written before carries.
    let mut old = String::new();
    let mut rest = sidx.as_str();
    while let Some(i) = rest.find(",\"sid\":[").or_else(|| rest.find(",\"foot\":[")) {
        old.push_str(&rest[..i]);
        rest = &rest[i + rest[i..].find(']').unwrap() + 1..];
    }
    old.push_str(rest);
    assert!(!old.contains("sid") && !old.contains("foot"));
    let reads = vec![viz_query::FetchRange { matchers: vec![Matcher::new("pod", MatchOp::Eq, "p01234")], min_ts: MID, max_ts: MID + 300_000 }];
    let p = sample_plan(&[&series], &[&old, "{not json", r#"{"v":2,"rg":[]}"#], &reads, None, 0).unwrap();
    assert_eq!(p.files[0], FilePlan { read: FileRead::Whole, rows: Some(20_000) }, "name and time only: every row group of x");
    assert_eq!(p.files[1], FilePlan { read: FileRead::Whole, rows: None });
    assert_eq!(p.files[2], FilePlan { read: FileRead::Whole, rows: None });
    // file_plan is scan_rows with ranges.
    let fp = file_plan(&[&sidx, &old], &reads, 0);
    assert_eq!(fp.iter().map(|f| f.rows).collect::<Vec<_>>(), viz_query::scan_rows(&[&sidx, &old], &reads));
}

#[test]
fn the_label_calls_never_open_a_sample_file() {
    let (_, _, series, _, ls) = big();
    // A sample "file" that is not Parquet at all: a read of it would fail.
    let junk = b"PAR1 this is not a parquet file".to_vec();
    let i = ScanInput { series_files: vec![&series], sample_files: vec![&junk], tail_batches: vec![] };
    let pods = viz_query::label_values(&i, "pod", &[Matcher::new("ns", MatchOp::Eq, "n7")], MID, MID).unwrap();
    assert_eq!(pods.len(), 200);
    assert_eq!(viz_query::series(&i, &[vec![Matcher::new("pod", MatchOp::Eq, "p00042")]], MID, MID).unwrap(), vec![ls[42].clone()]);
    // max_series bounds what is listed, and says so.
    let e = viz_query::label_values_with(&i, "pod", &[], MID, MID, &Limits { max_series: 3999, ..Limits::default() }).unwrap_err();
    assert_eq!(e.limit, Some((viz_query::Limit::MaxSeries, 3999, 4000)));
    assert_eq!(viz_query::label_values_with(&i, "pod", &[], MID, MID, &Limits { max_series: 4000, ..Limits::default() }).unwrap().len(), 4000);
}
