//! The fetch plan: exact ranges, and soundness (the plan fetches everything the query
//! reads) over random data and the whole query pool.
mod common;

use common::*;
use proptest::prelude::*;
use viz_promql::{MatchOp, Matcher, Series};
use viz_query::{plan, FetchRange, Limits, Options};

fn name(v: &str) -> Vec<Matcher> {
    vec![Matcher::new("__name__", MatchOp::Eq, v)]
}

fn fr(m: Vec<Matcher>, min_ts: i64, max_ts: i64) -> FetchRange {
    FetchRange { matchers: m, min_ts, max_ts }
}

const H: i64 = 3_600_000;

#[test]
fn ranges_are_exact() {
    let (s, e, step) = (10 * H, 11 * H, 15_000);
    // Instant selector: the lookback window is left-open, (start - 5m, end].
    assert_eq!(plan("m", s, e, step).unwrap(), [fr(name("m"), s - 300_000 + 1, e)]);
    // Range selector: (start - range, end].
    assert_eq!(plan("rate(m[1m])", s, e, step).unwrap(), [fr(name("m"), s - 60_000 + 1, e)]);
    // The last step is what counts, not `end`: 10:00:00 .. 10:00:50 every 20 s ends at :40.
    assert_eq!(plan("rate(m[1m])", s, s + 50_000, 20_000).unwrap(), [fr(name("m"), s - 60_000 + 1, s + 40_000)]);
    // offset moves the window; @ pins it.
    assert_eq!(plan("m offset 1h", s, e, step).unwrap(), [fr(name("m"), s - H - 300_000 + 1, e - H)]);
    assert_eq!(plan("m offset -10m", s, e, step).unwrap(), [fr(name("m"), s + 600_000 - 300_000 + 1, e + 600_000)]);
    assert_eq!(plan("sum_over_time(m[2m] @ 7200)", s, e, step).unwrap(), [fr(name("m"), 2 * H - 120_000 + 1, 2 * H)]);
    assert_eq!(plan("m @ end()", s, e, step).unwrap(), [fr(name("m"), e - 300_000 + 1, e)]);
    // An instant query.
    assert_eq!(plan("rate(m[5m])", e, e, 1).unwrap(), [fr(name("m"), e - 300_000 + 1, e)]);
    // No selector, nothing to fetch.
    assert_eq!(plan("1 + time()", s, e, step).unwrap(), []);
}

#[test]
fn ranges_of_one_matcher_set_merge_only_when_they_meet() {
    let (s, e, step) = (10 * H, 11 * H, 15_000);
    // The same selector twice: one fetch.
    assert_eq!(plan("m / m", s, e, step).unwrap(), [fr(name("m"), s - 300_000 + 1, e)]);
    // Overlapping windows: the union.
    assert_eq!(plan("rate(m[10m]) / m offset 30m", s, e, step).unwrap(), [fr(name("m"), s - 1_800_000 - 300_000 + 1, e)]);
    // Touching windows (one ends at X, the next starts at X + 1) merge too.
    assert_eq!(plan("m + m offset 1h5m", e, e, 1).unwrap().len(), 2);
    assert_eq!(plan("m + m offset 5m", e, e, 1).unwrap(), [fr(name("m"), e - 600_000 + 1, e)]);
    // A day apart: two fetches, and the day in between is not fetched.
    assert_eq!(
        plan("m - m offset 1d", 30 * H, 31 * H, step).unwrap(),
        [fr(name("m"), 6 * H - 300_000 + 1, 7 * H), fr(name("m"), 30 * H - 300_000 + 1, 31 * H)]
    );
    // Different matchers never merge, and keep the order of the query.
    assert_eq!(plan("n + m", s, e, step).unwrap(), [fr(name("n"), s - 300_000 + 1, e), fr(name("m"), s - 300_000 + 1, e)]);
    // Subquery: inner steps are absolute multiples of 30 s in (start - 3m, end], each
    // reading a 1 m window.
    assert_eq!(
        plan("max_over_time(rate(m[1m])[3m:30s])", s + 7_000, e + 7_000, step).unwrap(),
        [fr(name("m"), s - 180_000 + 30_000 - 60_000 + 1, e)]
    );
}

#[test]
fn ranges_are_clamped_to_what_storage_can_hold() {
    // Timestamps below 0 cannot exist, so the plan never asks for them.
    assert_eq!(plan("m", 0, 60_000, 15_000).unwrap(), [fr(name("m"), 0, 60_000)]);
    assert_eq!(plan("m offset 1h", 0, 60_000, 15_000).unwrap(), []);
    assert_eq!(plan("m offset 1h + n", 0, 60_000, 15_000).unwrap(), [fr(name("n"), 0, 60_000)]);
    let max = viz_storage::batch::MAX_TS;
    assert_eq!(plan("m offset -1h", max - 1000, max, 1000).unwrap(), []);
    assert_eq!(plan("m", max, max, 1).unwrap(), [fr(name("m"), max - 300_000 + 1, max)]);
    // A non-default lookback changes the plan.
    let opts = Options { eval: viz_promql::EvalOptions { lookback_delta_ms: 60_000, ..Default::default() }, ..Options::default() };
    assert_eq!(viz_query::plan_with("m", H, H, 1, &opts).unwrap(), [fr(name("m"), H - 60_000 + 1, H)]);
}

/// Fetch exactly what the plan asks for (through `viz_storage::select`, as a Worker
/// would through the ledger and the shards), and nothing else.
fn fetch(full: &Stored, ranges: &[FetchRange]) -> Vec<Series> {
    let mut mem = viz_promql::MemSource::new();
    for r in ranges {
        let ms: Vec<viz_storage::Matcher> = r.matchers.iter().map(viz_query::to_storage_matcher).collect();
        for s in viz_storage::select(&full.input(), &ms, r.min_ts, r.max_ts).unwrap() {
            mem.add(Series { labels: s.labels, ts: s.ts, values: s.values });
        }
    }
    mem.series().to_vec()
}

fn outcome(s: &Stored, q: &str, start: i64, end: i64, step: i64) -> Result<String, String> {
    let opts = Options { limits: Limits::unlimited(), ..Options::default() };
    viz_query::query_range_with(&s.input(), q, start, end, step, &opts)
        .map(|r| viz_query::to_json(&r.matrix).unwrap())
        .map_err(|e| format!("{}: {}", e.error_type.as_str(), e.message))
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(48), failure_persistence: None, ..ProptestConfig::default() })]

    /// Soundness: for every query of the pool, evaluating over only the data inside the
    /// plan's ranges gives the same result as evaluating over all the data.
    #[test]
    fn plan_is_sound(
        h in history_strategy(),
        layout in layout_strategy(),
        start in (T0 - 20_000)..(T0 + 400_000),
        nsteps in 1i64..10,
        step in prop_oneof![Just(15_000i64), Just(60_000), 1_000i64..120_000],
    ) {
        let end = start + (nsteps - 1) * step + step / 3;
        let full = store(&h.encoded(), &layout);
        for q in QUERIES {
            let Ok(ranges) = plan(q, start, end, step) else {
                prop_assert!(outcome(&full, q, start, end, step).is_err(), "{} has no plan but evaluates", q);
                continue;
            };
            let fetched = fetch(&full, &ranges);
            // What was fetched goes back into storage, half in the lake.
            let b = series_to_batches(&fetched, 7);
            let only = store(&b, &Layout { flushed: b.len() / 2, tail_from: b.len() / 2, segment_cuts: vec![], row_group_rows: 100_000, compact: false });
            prop_assert_eq!(outcome(&only, q, start, end, step), outcome(&full, q, start, end, step), "query {} [{}, {}] step {}", q, start, end, step);
            // The same for the instant form.
            let ranges = plan(q, end, end, 1).unwrap();
            let b = series_to_batches(&fetch(&full, &ranges), 7);
            let only = store(&b, &Layout::all_tail());
            let opts = Options { limits: Limits::unlimited(), ..Options::default() };
            let a = viz_query::query_instant_with(&only.input(), q, end, &opts).map(|r| viz_query::to_json(&r.value).unwrap()).map_err(|e| e.message);
            let c = viz_query::query_instant_with(&full.input(), q, end, &opts).map(|r| viz_query::to_json(&r.value).unwrap()).map_err(|e| e.message);
            prop_assert_eq!(a, c, "instant query {} at {}", q, end);
        }
    }
}

/// The plan is tight at both ends: with a sample exactly on each boundary, fetching one
/// millisecond less on either side changes the result. (So a plan that is off by one
/// towards "less" is caught by `plan_is_sound` only if data sits on the boundary; this
/// test puts it there.)
#[test]
fn both_boundaries_of_a_range_matter() {
    let (start, end, step) = (MID, MID + 60_000, 15_000);
    for q in ["count_over_time(m[1m])", "m", "sum_over_time(m[45s] offset 10s)", "max_over_time(count_over_time(m[20s])[1m:10s])"] {
        let ranges = plan(q, start, end, step).unwrap();
        assert_eq!(ranges.len(), 1, "{q}");
        let (lo, hi) = (ranges[0].min_ts, ranges[0].max_ts);
        // One sample on each boundary.
        let m: &[(&str, &str)] = &[("__name__", "m")];
        let h = History::from_rows(&[(m, lo, 1.0), (m, hi, 3.0)]);
        let full = store(&h.encoded(), &Layout::all_lake(1));
        let want = outcome(&full, q, start, end, step);
        let with = |lo: i64, hi: i64| {
            let got = fetch(&full, &[FetchRange { matchers: ranges[0].matchers.clone(), min_ts: lo, max_ts: hi }]);
            outcome(&store(&series_to_batches(&got, 100), &Layout::all_tail()), q, start, end, step)
        };
        assert_eq!(with(lo, hi), want, "{q}: the plan itself is sufficient");
        assert_ne!(with(lo + 1, hi), want, "{q}: the sample at min_ts is needed");
        assert_ne!(with(lo, hi - 1), want, "{q}: the sample at max_ts is needed");
        // And nothing outside is: samples just outside the range change nothing.
        let h = History::from_rows(&[(m, lo - 1, 100.0), (m, lo, 1.0), (m, hi, 3.0), (m, hi + 1, 200.0)]);
        let wider = store(&h.encoded(), &Layout::all_lake(1));
        assert_eq!(outcome(&wider, q, start, end, step), want, "{q}: samples outside the plan are not read");
    }
}
