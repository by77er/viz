//! File pruning from index fragments: skipping a file never changes a result, and the
//! rule does skip files (so the property is not vacuous).
mod common;

use common::*;
use proptest::prelude::*;
use viz_promql::{MatchOp, Matcher};
use viz_query::{files_needed, plan, scan_rows, FetchRange, Limits, Options};
use viz_storage::{encode_segment_with, EncodedFile, ScanInput, Table, WriteOptions};

/// Every batch flushed as its own segment (many small files), the last `tail` batches
/// also in the tail.
fn flush_each(batches: &[Vec<u8>], row_group_rows: usize) -> Vec<EncodedFile> {
    let opts = WriteOptions { max_row_group_rows: row_group_rows };
    batches.iter().flat_map(|b| encode_segment_with(&[b.as_slice()], &opts).expect("flush")).collect()
}

fn input<'a>(files: &'a [EncodedFile], keep: Option<&[bool]>, tail: &'a [Vec<u8>]) -> ScanInput<'a> {
    let pick = |t: Table| -> Vec<&'a [u8]> {
        files.iter().enumerate().filter(|(i, f)| f.table == t && keep.is_none_or(|k| k[*i])).map(|(_, f)| f.bytes.as_slice()).collect()
    };
    ScanInput { series_files: pick(Table::MetricSeries), sample_files: pick(Table::MetricSamples), tail_batches: tail.iter().map(|b| b.as_slice()).collect() }
}

fn needed(files: &[EncodedFile], ranges: &[FetchRange]) -> Vec<bool> {
    let idx: Vec<&str> = files.iter().map(|f| f.index.as_str()).collect();
    files_needed(&idx, ranges)
}

fn range(i: &ScanInput<'_>, q: &str, start: i64, end: i64, step: i64) -> Result<String, String> {
    let opts = Options { limits: Limits::unlimited(), ..Options::default() };
    viz_query::query_range_with(i, q, start, end, step, &opts).map(|r| viz_query::to_json(&r.matrix).unwrap()).map_err(|e| e.message)
}

fn instant(i: &ScanInput<'_>, q: &str, t: i64) -> Result<String, String> {
    let opts = Options { limits: Limits::unlimited(), ..Options::default() };
    viz_query::query_instant_with(i, q, t, &opts).map(|r| viz_query::to_json(&r.value).unwrap()).map_err(|e| e.message)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(32), failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn skipping_files_never_changes_a_result(
        h in history_strategy(),
        rg in prop_oneof![1usize..7, Just(100_000usize)],
        tail_back in 0usize..3,
        start in (T0 - 20_000)..(T0 + 400_000),
        nsteps in 1i64..8,
        step in prop_oneof![Just(15_000i64), 1_000i64..120_000],
    ) {
        let end = start + (nsteps - 1) * step;
        let b = h.encoded();
        let files = flush_each(&b, rg);
        let tail = &b[b.len().saturating_sub(tail_back)..];
        let all = input(&files, None, tail);
        for q in QUERIES {
            if let Ok(ranges) = plan(q, start, end, step) {
                let keep = needed(&files, &ranges);
                prop_assert_eq!(range(&input(&files, Some(&keep), tail), q, start, end, step), range(&all, q, start, end, step), "range query {}", q);
                // The row bound really bounds what one read of each range loads from the lake.
                let idx: Vec<&str> = files.iter().filter(|f| f.table == Table::MetricSamples).map(|f| f.index.as_str()).collect();
                let bound: u64 = scan_rows(&idx, &ranges).into_iter().map(|r| r.unwrap()).sum();
                let lake = input(&files, None, &[]);
                let mut loaded = 0u64;
                for r in &ranges {
                    let ms: Vec<viz_storage::Matcher> = r.matchers.iter().map(viz_query::to_storage_matcher).collect();
                    loaded += viz_storage::select(&lake, &ms, r.min_ts, r.max_ts).unwrap().iter().map(|s| s.ts.len() as u64).sum::<u64>();
                }
                prop_assert!(loaded <= bound, "query {}: loaded {} samples, bound {}", q, loaded, bound);
            }
            if let Ok(ranges) = plan(q, end, end, 1) {
                let keep = needed(&files, &ranges);
                prop_assert_eq!(instant(&input(&files, Some(&keep), tail), q, end), instant(&all, q, end), "instant query {}", q);
            }
        }
    }
}

fn name(v: &str) -> Vec<Matcher> {
    vec![Matcher::new("__name__", MatchOp::Eq, v)]
}

fn fixture() -> Vec<EncodedFile> {
    // Two segments: metrics a and c early, metric e late.
    let early = History::from_rows(&[(&[("__name__", "a")], T0, 1.0), (&[("__name__", "c")], T0 + 1000, 2.0)]);
    let late = History::from_rows(&[(&[("__name__", "e")], T0 + 60_000, 3.0)]);
    let mut files = flush_each(&early.encoded(), 100_000);
    files.extend(flush_each(&late.encoded(), 100_000));
    files
}

#[test]
fn files_are_skipped_by_time_and_by_name_and_only_then() {
    let files = fixture();
    let tables: Vec<Table> = files.iter().map(|f| f.table).collect();
    assert_eq!(files.len(), 4, "{tables:?}");
    let early: Vec<bool> = files.iter().map(|f| f.max_ts < T0 + 60_000).collect();
    let all = vec![true; 4];
    let none = vec![false; 4];
    let late: Vec<bool> = early.iter().map(|x| !x).collect();
    let r = |m: Vec<Matcher>, lo: i64, hi: i64| vec![FetchRange { matchers: m, min_ts: lo, max_ts: hi }];

    // Time: inclusive at both ends.
    assert_eq!(needed(&files, &r(vec![], 0, i64::MAX)), all);
    assert_eq!(needed(&files, &r(vec![], T0 + 1001, T0 + 59_999)), none);
    assert_eq!(needed(&files, &r(vec![], T0 + 1000, T0 + 59_999)), early);
    assert_eq!(needed(&files, &r(vec![], T0 + 1001, T0 + 60_000)), late);
    assert_eq!(needed(&files, &r(vec![], 0, T0 - 1)), none);
    assert_eq!(needed(&files, &r(vec![], T0 + 60_001, i64::MAX)), none);
    // Name equality: outside [min_name, max_name] is skipped, the bounds are not, and a
    // name between them that the file does not hold is kept (statistics are a range).
    assert_eq!(needed(&files, &r(name("a"), 0, i64::MAX)), early);
    assert_eq!(needed(&files, &r(name("c"), 0, i64::MAX)), early);
    assert_eq!(needed(&files, &r(name("b"), 0, i64::MAX)), early);
    assert_eq!(needed(&files, &r(name("e"), 0, i64::MAX)), late);
    assert_eq!(needed(&files, &r(name("d"), 0, i64::MAX)), none);
    assert_eq!(needed(&files, &r(name("f"), 0, i64::MAX)), none);
    // Name and time together.
    assert_eq!(needed(&files, &r(name("e"), 0, T0 + 1000)), none);
    // Anything but an equality on __name__ prunes nothing.
    for m in [
        vec![Matcher::new("__name__", MatchOp::Re, "zzz")],
        vec![Matcher::new("__name__", MatchOp::Ne, "a")],
        vec![Matcher::new("__name__", MatchOp::Nre, "a")],
        vec![Matcher::new("job", MatchOp::Eq, "zzz")],
    ] {
        assert_eq!(needed(&files, &r(m, 0, i64::MAX)), all);
    }
    // Several ranges: a file is needed if any range needs it.
    let two = vec![FetchRange { matchers: name("a"), min_ts: 0, max_ts: i64::MAX }, FetchRange { matchers: name("e"), min_ts: 0, max_ts: i64::MAX }];
    assert_eq!(needed(&files, &two), all);
    // Rows: each row group once per range that may read it.
    let idx: Vec<&str> = files.iter().map(|f| f.index.as_str()).collect();
    let rows: Vec<u64> = files.iter().map(|f| f.rows).collect();
    assert_eq!(scan_rows(&idx, &r(vec![], 0, i64::MAX)), rows.iter().map(|n| Some(*n)).collect::<Vec<_>>());
    assert_eq!(scan_rows(&idx, &[r(name("a"), 0, i64::MAX), r(vec![], 0, i64::MAX)].concat()), rows.iter().zip(&early).map(|(n, e)| Some(if *e { 2 * n } else { *n })).collect::<Vec<_>>());
    // No ranges (a query with no selector): nothing to fetch.
    assert_eq!(needed(&files, &[]), none);
}

#[test]
fn a_fragment_that_does_not_parse_keeps_its_file() {
    let r = [FetchRange { matchers: name("zzz"), min_ts: 0, max_ts: 0 }];
    assert_eq!(files_needed(&["", "{", "{\"v\":2,\"rg\":[]}", "not json"], &r), [true, true, true, true]);
    assert_eq!(scan_rows(&["", "{\"v\":1,\"rg\":[]}"], &r), [None, Some(0)]);
    // A file with no row groups holds no rows.
    assert_eq!(files_needed(&["{\"v\":1,\"rg\":[]}"], &r), [false]);
}
