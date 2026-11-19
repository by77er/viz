//! A split part's readers may read the SERIES files by the part's `series_id` range
//! (`part_plan` over their fragments), as they read the sample files (query/ README, "Split
//! parts read their id range of the series files"). The property that makes it exact: if no
//! part reports a foreign series (`Extract::foreign`), every part's extract equals its extract
//! from the series files read by name and time. And a series whose key is not its id is seen
//! as foreign by the part its id is in, whichever way the files were read.
mod common;

use common::*;
use proptest::prelude::*;
use viz_query::split::{extract, SplitPlan};
use viz_query::{file_plan, part_plan, plan, split_plan, FilePlan, FileRead, Options, RANGE_GAP};
use viz_storage::sparse;

fn cut(bytes: &[u8], p: &FilePlan) -> Option<Vec<u8>> {
    match &p.read {
        FileRead::Skip => None,
        FileRead::Whole => Some(bytes.to_vec()),
        FileRead::Ranges(r) => Some(sparse::cut(bytes, r)),
    }
}

const QUERIES: &[&str] = &[
    "sum by (job) (rate(n[5m]))",
    "count by (job) (m)",
    "sum(h_bucket)",
    "max by (inst) (n)",
    "sum by (le) (increase(h_bucket[2m]))",
];

/// Every part's extract with the series files read by name and time, and by the part's id
/// range; the second's foreign counts.
fn both(stored: &Stored, q: &str, parts: u32) -> Option<(Vec<viz_query::split::Extract>, Vec<viz_query::split::Extract>)> {
    let (start, end) = (T0, T0 + 600_000);
    let ranges = plan(q, start, end, 60_000).ok()?;
    let SplitPlan::Split { key, .. } = split_plan(q, &Options::default()) else { return None };
    let s_idx: Vec<&str> = stored.series_index.iter().map(|s| s.as_str()).collect();
    let by_name = file_plan(&s_idx, &ranges, RANGE_GAP);
    let samples: Vec<&[u8]> = stored.sample_files.iter().map(|b| &b[..]).collect();
    let (mut a, mut b) = (Vec::new(), Vec::new());
    for part in 0..parts {
        let by_part = part_plan(&s_idx, &ranges, part, parts, RANGE_GAP);
        let whole: Vec<Vec<u8>> = stored.series_files.iter().zip(&by_name).filter_map(|(f, p)| cut(f, p)).collect();
        let ranged: Vec<Vec<u8>> = stored.series_files.iter().zip(&by_part).filter_map(|(f, p)| cut(f, p)).collect();
        let w: Vec<&[u8]> = whole.iter().map(|x| &x[..]).collect();
        let r: Vec<&[u8]> = ranged.iter().map(|x| &x[..]).collect();
        a.push(extract(&w, &samples, &key, part, parts, &ranges).unwrap());
        b.push(extract(&r, &samples, &key, part, parts, &ranges).unwrap());
    }
    Some((a, b))
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(48), failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn with_no_foreign_series_the_id_range_of_the_series_files_changes_no_extract(
        h in history_strategy(),
        mut layout in layout_strategy(),
        parts in 1u32..9,
        q in prop::sample::select(QUERIES),
    ) {
        // Everything in the lake: the extract reads files only (the tail is cut elsewhere).
        layout.tail_from = layout.flushed.max(h.batches.len());
        layout.flushed = h.batches.len();
        let stored = store(&h.encoded(), &layout);
        if let Some((whole, ranged)) = both(&stored, q, parts) {
            let foreign: u64 = ranged.iter().map(|e| e.foreign).sum();
            // This pool carries no label a key leaves out: nothing is foreign, so all must agree.
            prop_assert_eq!(foreign, 0);
            for (part, (w, r)) in whole.iter().zip(&ranged).enumerate() {
                prop_assert_eq!(&w.batch, &r.batch, "part {} of {}", part, parts);
                prop_assert_eq!((w.rows, w.series), (r.rows, r.series));
            }
        }
    }
}

/// Series that carry `__type__` (left out of the key of a `rate` under `sum`): the part their
/// id is in sees them as foreign, both ways of reading; and read by id range, a part misses one
/// of its own series that the other reading finds, which is why the coordinator must check.
#[test]
fn a_series_whose_key_is_not_its_id_is_foreign_to_the_part_its_id_is_in() {
    let mut rows: Vec<(Vec<(&str, &str)>, i64, f64)> = Vec::new();
    let names: Vec<String> = (0..4000).map(|i| format!("{i}")).collect();
    for (i, n) in names.iter().enumerate() {
        for k in 0..2 {
            let mut l = vec![("__name__", "c"), ("job", "j"), ("i", n.as_str())];
            if i % 2 == 0 {
                l.push(("__type__", "counter"));
            }
            rows.push((l, T0 + k * 60_000, (k * (i as i64 + 1)) as f64));
        }
    }
    let refs: Vec<(&[(&str, &str)], i64, f64)> = rows.iter().map(|(l, t, v)| (l.as_slice(), *t, *v)).collect();
    let h = History::from_rows(&refs);
    let mut layout = Layout::all_lake(h.batches.len());
    layout.row_group_rows = 500; // eight row groups a file, so a part's id range is one or two of them
    let stored = store(&h.encoded(), &layout);
    let (whole, ranged) = both(&stored, "sum by (job) (rate(c[5m]))", 8).expect("splits");
    let fw: u64 = whole.iter().map(|e| e.foreign).sum();
    let fr: u64 = ranged.iter().map(|e| e.foreign).sum();
    assert!(fw > 0, "some typed series' id is in a part its key is not");
    assert_eq!(fw, fr, "every foreign series is in its own id range, read either way");
    // Read by id range, some part lists fewer series than read by name and time.
    let counts: Vec<(u64, u64, u64, u64)> = whole.iter().zip(&ranged).map(|(w, r)| (w.series, r.series, w.strays, r.foreign)).collect();
    let s_idx: Vec<&str> = stored.series_index.iter().map(|s| s.as_str()).collect();
    let ranges = plan("sum by (job) (rate(c[5m]))", T0, T0 + 600_000, 60_000).unwrap();
    let pp: Vec<String> = (0..8).map(|p| format!("{:?}", part_plan(&s_idx, &ranges, p, 8, RANGE_GAP).iter().map(|x| match &x.read { FileRead::Whole => "whole".to_string(), FileRead::Skip => "skip".into(), FileRead::Ranges(r) => format!("{} ranges", r.len()) }).collect::<Vec<_>>())).collect();
    assert!(whole.iter().zip(&ranged).any(|(w, r)| r.series < w.series), "{counts:?} {pp:?} files {}", stored.series_files.len());
}

/// The same shape with no label the key leaves out: the parts do read ranges of the series
/// files, nothing is foreign, and every extract is the one from the files read by name and time.
#[test]
fn read_by_id_range_the_series_files_give_the_same_extracts() {
    let names: Vec<String> = (0..4000).map(|i| format!("{i}")).collect();
    let mut rows: Vec<(Vec<(&str, &str)>, i64, f64)> = Vec::new();
    for (i, n) in names.iter().enumerate() {
        for k in 0..2 {
            rows.push((vec![("__name__", "c"), ("job", if i % 3 == 0 { "a" } else { "b" }), ("i", n.as_str())], T0 + k * 60_000, (k * (i as i64 + 1)) as f64));
        }
    }
    let refs: Vec<(&[(&str, &str)], i64, f64)> = rows.iter().map(|(l, t, v)| (l.as_slice(), *t, *v)).collect();
    let h = History::from_rows(&refs);
    let mut layout = Layout::all_lake(h.batches.len());
    layout.row_group_rows = 500;
    let stored = store(&h.encoded(), &layout);
    let q = "sum by (job) (rate(c[5m]))";
    let s_idx: Vec<&str> = stored.series_index.iter().map(|s| s.as_str()).collect();
    let ranges = plan(q, T0, T0 + 600_000, 60_000).unwrap();
    assert!((0..8).any(|p| part_plan(&s_idx, &ranges, p, 8, RANGE_GAP).iter().any(|x| matches!(x.read, FileRead::Ranges(_)))), "the parts read ranges");
    let (whole, ranged) = both(&stored, q, 8).expect("splits");
    assert_eq!(ranged.iter().map(|e| e.foreign).sum::<u64>(), 0);
    for (w, r) in whole.iter().zip(&ranged) {
        assert_eq!((&w.batch, w.rows, w.series), (&r.batch, r.rows, r.series));
    }
    assert!(whole.iter().map(|e| e.series).sum::<u64>() == 4000);
}
