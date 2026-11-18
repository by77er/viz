//! Storage-location invariance: a query's result is the same wherever its rows live.
//!
//! For random write histories (duplicates, staleness markers, two UTC days) and every
//! query of the pool, `query_range` and `query_instant` must give identical output
//! (a) with every row in Parquet files, (b) with every row in tail batches, (c) split
//! between them with an overlap, in several segments, with small row groups, optionally
//! compacted, (d) with the lake cut into several files per day, and (e) all of those
//! must equal `viz-promql` evaluating the same history from its in-memory source.
mod common;

use common::*;
use proptest::prelude::*;
use proptest::strategy::ValueTree;
use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};
use viz_promql::EvalOptions;
use viz_query::{Limits, Options};

type Outcome = Result<String, (&'static str, String)>;

fn opts() -> Options {
    Options { limits: Limits::unlimited(), eval: EvalOptions::default() }
}

fn reference_error(e: viz_promql::Error) -> (&'static str, String) {
    match e {
        viz_promql::Error::Parse(m) => ("bad_data", format!("parse error: {m}")),
        viz_promql::Error::Unsupported(m) => ("unsupported", m),
        viz_promql::Error::Eval(m) => ("execution", m),
        viz_promql::Error::Source(m) => ("internal", m),
    }
}

fn range_stored(s: &Stored, q: &str, start: i64, end: i64, step: i64) -> (Outcome, Option<viz_query::Stats>) {
    match viz_query::query_range_with(&s.input(), q, start, end, step, &opts()) {
        Ok(r) => (Ok(viz_query::to_json(&r.matrix).unwrap()), Some(r.stats)),
        Err(e) => (Err((e.error_type.as_str(), e.message)), None),
    }
}

fn instant_stored(s: &Stored, q: &str, t: i64) -> (Outcome, Option<viz_query::Stats>) {
    match viz_query::query_instant_with(&s.input(), q, t, &opts()) {
        Ok(r) => (Ok(viz_query::to_json(&r.value).unwrap()), Some(r.stats)),
        Err(e) => (Err((e.error_type.as_str(), e.message)), None),
    }
}

fn layouts(h: &History, random: &Layout, lake_only: &Layout) -> Vec<(&'static str, Stored)> {
    let b = h.encoded();
    let n = b.len();
    vec![
        ("(a) all in Parquet", store(&b, &Layout::all_lake(n))),
        ("(b) all in the tail", store(&b, &Layout::all_tail())),
        ("(c) split with overlap", store(&b, random)),
        ("(d) lake in several files and days", store(&b, &Layout { flushed: n, tail_from: n, ..lake_only.clone() })),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(48), failure_persistence: None, ..ProptestConfig::default() })]

    /// Every query of the pool, as a range query and as an instant query.
    #[test]
    fn results_do_not_depend_on_where_rows_live(
        h in history_strategy(),
        random in layout_strategy(),
        lake_only in layout_strategy(),
        start in (T0 - 20_000)..(T0 + 400_000),
        nsteps in 1i64..10,
        step in prop_oneof![Just(15_000i64), Just(60_000), 1_000i64..120_000],
    ) {
        let end = start + (nsteps - 1) * step + step / 3;
        let mem = h.mem();
        let stored = layouts(&h, &random, &lake_only);
        for q in QUERIES {
            let want: Outcome = viz_promql::query_range(&mem, q, start, end, step)
                .map(|m| serde_json_string(&m))
                .map_err(reference_error);
            let mut first: Option<viz_query::Stats> = None;
            for (name, s) in &stored {
                let (got, stats) = range_stored(s, q, start, end, step);
                prop_assert_eq!(&got, &want, "range query {} [{}, {}] step {}: {} differs from the in-memory reference", q, start, end, step, name);
                // What a query read is location-independent too.
                if let Some(f) = first {
                    prop_assert_eq!(stats, Some(f), "stats of {} differ in {}", q, name);
                }
                first = first.or(stats);
            }
            let at = end;
            let want: Outcome = viz_promql::query_instant(&mem, q, at).map(|v| serde_json_string(&v)).map_err(reference_error);
            for (name, s) in &stored {
                let (got, _) = instant_stored(s, q, at);
                prop_assert_eq!(&got, &want, "instant query {} at {}: {} differs from the in-memory reference", q, at, name);
            }
        }
    }

    /// The raw series storage hands to the evaluator are the reference's series, bit for
    /// bit (staleness markers included), for every selector range of every pool query.
    #[test]
    fn source_returns_the_reference_series(
        h in history_strategy(),
        random in layout_strategy(),
        lake_only in layout_strategy(),
        start in (T0 - 20_000)..(T0 + 400_000),
        step in 5_000i64..90_000,
    ) {
        use viz_promql::SeriesSource;
        let mem = h.mem();
        let stored = layouts(&h, &random, &lake_only);
        let bits = |v: Vec<viz_promql::Series>| -> Vec<(Labels, Vec<i64>, Vec<u64>)> {
            let mut v: Vec<_> = v.into_iter().map(|s| (s.labels, s.ts, s.values.iter().map(|x| x.to_bits()).collect())).collect();
            v.sort();
            v
        };
        for q in QUERIES {
            let Ok(sels) = viz_promql::selectors(q, start, start + 4 * step, step) else { continue };
            for sel in sels {
                let want = bits(mem.select(&sel.matchers, sel.min_ts_ms, sel.max_ts_ms).unwrap());
                for (name, s) in &stored {
                    let input = s.input();
                    let src = viz_query::StorageSource::new(&input, Limits::unlimited());
                    let got = bits(src.select(&sel.matchers, sel.min_ts_ms, sel.max_ts_ms).unwrap());
                    prop_assert_eq!(&got, &want, "selector of {} in {}", q, name);
                }
            }
        }
    }
}

fn serde_json_string<T: serde::Serialize>(v: &T) -> String {
    viz_query::to_json(v).unwrap()
}

/// The property above would be vacuous if the pool's queries returned nothing. Over 40
/// fixed histories, every query that is not an intended error returns data at least
/// once, and the intended errors are errors.
#[test]
fn query_pool_is_live() {
    assert!(QUERIES.len() >= 60, "the pool must hold at least 60 queries");
    let mut runner = TestRunner::new_with_rng(Config::default(), TestRng::deterministic_rng(RngAlgorithm::ChaCha));
    let mut hit = vec![false; QUERIES.len()];
    let mut err = vec![0usize; QUERIES.len()];
    let mut markers = 0usize;
    for _ in 0..40 {
        let h = history_strategy().new_tree(&mut runner).unwrap().current();
        markers += h.batches.iter().flatten().filter(|w| w.value.to_bits() == viz_storage::batch::STALE_NAN_BITS).count();
        let s = store(&h.encoded(), &Layout { flushed: 3, tail_from: 2, segment_cuts: vec![1], row_group_rows: 5, compact: false });
        for (i, q) in QUERIES.iter().enumerate() {
            match viz_query::query_range_with(&s.input(), q, T0 + 60_000, T0 + 600_000, 30_000, &opts()) {
                Ok(r) => hit[i] |= r.stats.output_points > 0,
                Err(_) => err[i] += 1,
            }
        }
    }
    assert!(markers > 100, "the generator must produce staleness markers, got {markers}");
    let must_fail = ["limitk(1, m)", "m +"];
    // Vector-matching errors depend on the data: they must occur at least once.
    let may_fail = ["m + on(job) n", "sum(m) by (job) / on(job) group_left m"];
    for (i, q) in QUERIES.iter().enumerate() {
        if must_fail.contains(q) {
            assert_eq!(err[i], 40, "{q} must always fail");
        } else if may_fail.contains(q) {
            assert!(err[i] > 0, "{q} never failed");
        } else {
            assert!(hit[i], "{q} never returned data");
        }
    }
}
