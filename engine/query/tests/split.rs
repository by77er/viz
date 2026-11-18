//! Split execution (`viz_query::split`): evaluating a query over leaves that each hold a
//! disjoint set of series, then merging, gives exactly what one place gives.
//!
//! - `split_equals_one_place`: for random write histories laid out in random lake/tail
//!   placements, every query of the shared pool and of an aggregation-heavy pool, as range
//!   and instant query, at 1, 2, 7, 32 or a random number of parts, with the lake read by
//!   readers in random groups and their extracts arriving in reverse order: the merged
//!   result is byte-identical to one-place evaluation (or the same error), and so are the
//!   query's statistics.
//! - `partials_merge_exactly`: `merge(partial(A), partial(B)) == partial(A ∪ B)` for random
//!   vectors (signed zeros, NaN, infinities, huge and tiny values) and every decomposable
//!   operator, with and without `by`/`without`, in any order; and through the encoding.
//! - the decomposition rules, the fallback, the leaf budget and the limit replay.
mod common;

use common::*;
use proptest::prelude::*;
use std::sync::Arc;
use viz_query::split::{self, Gathered, Grid, LeafBudget, LeafOutput, SplitKey, SplitPlan};
use viz_query::{split_plan, EvalOptions, Limits, Options};

/// Aggregation-heavy queries over the common pool's series (`m` gauges, `n` counters,
/// `h_bucket` histograms).
const AGG_QUERIES: &[&str] = &[
    "sum(rate(n[1m]))",
    "sum by (job) (rate(n[1m]))",
    "sum without (inst) (increase(n[2m]))",
    "avg by (job) (m)",
    "avg without (job) (rate(n[1m]))",
    "count(m)",
    "count by (inst) (rate(n[1m]))",
    "min(m)",
    "max by (job) (m * 2)",
    "group(n)",
    "group by (inst) (m > 3)",
    "stddev(m)",
    "stdvar by (job) (rate(n[90s]))",
    "stddev without (inst) (m)",
    "topk(3, rate(n[1m]))",
    "bottomk by (job) (2, m)",
    "topk by (inst) (1, -m)",
    r#"count_values("v", round(m))"#,
    r#"count_values by (job) ("v", m)"#,
    "sum(rate(n[1m])) / sum(rate(m[1m]))",
    "sum by (job) (rate(n[1m])) / on (job) count by (job) (n)",
    "histogram_quantile(0.9, sum by (le) (rate(h_bucket[2m])))",
    "histogram_quantile(0.5, sum by (job, le) (increase(h_bucket[90s])))",
    "quantile(0.5, sum by (inst) (m))",
    "sum(sum by (job, inst) (m))",
    "max(avg by (job) (m)) - min(avg by (job) (m))",
    r#"sum by (job) (label_replace(m, "inst", "all", "inst", ".*"))"#,
    r#"sum by (dst) (label_join(rate(n[1m]), "dst", "-", "job", "inst"))"#,
    r#"sum(rate({__name__=~"m|n"}[1m]))"#,
    r#"count by (job) ({__name__=~"m|n"} * 2)"#,
    "sum by (job) (m @ end())",
    "sum(m offset 30s)",
    "count(timestamp(m))",
    "sum(max_over_time(rate(n[1m])[2m:30s]))",
    "sort_desc(sum by (job) (m))",
    "scalar(sum(m)) * 2",
    "sum(m) + sum(n)",
    "topk(2, sum by (inst) (rate(n[1m])))",
    "sum by (job) (clamp_min(m, 3))",
    "absent(sum(m))",
    "sum(m) > bool 3",
    "stddev(rate(n[1m])) / avg(rate(n[1m]))",
    "count(count by (job) (m))",
    "topk(time() - 1700006398, m)",
    "avg(last_over_time(m[1m]))",
    "max without () (m)",
];

/// Queries that must be evaluated in one place, with a word of the reason.
const NOT_SPLIT: &[(&str, &str)] = &[
    ("rate(n[1m])", "outside any aggregation"),
    ("m", "outside any aggregation"),
    ("quantile(0.5, m)", "`quantile` does not decompose"),
    ("sum(m + n)", "two vectors"),
    ("sum(m) / m", "outside"),
    ("max_over_time(sum(m)[1m:15s])", "subquery"),
    ("sum(absent(m))", "depends on other series"),
    ("topk(scalar(m), m)", "reads data"),
    ("sum(m and n)", "set operator"),
    ("1 + 1", "no selector"),
    ("sum(m)[1m:15s]", "range vector"),
    ("sum(m offset 1m) + rate(n[1m])", "outside"),
    ("limitk(1, m)", "does not decompose"),
];

fn opts() -> Options {
    Options { limits: Limits::unlimited(), eval: EvalOptions::default() }
}

type Outcome = Result<String, (&'static str, String)>;

fn one_place(s: &Stored, q: &str, grid: Grid, o: &Options) -> (Outcome, Option<viz_query::Stats>) {
    let r = match grid {
        Grid::Range { start, end, step } => viz_query::query_range_with(&s.input(), q, start, end, step, o).map(|r| (viz_query::to_json(&r.matrix).unwrap(), r.stats)),
        Grid::Instant { time } => viz_query::query_instant_with(&s.input(), q, time, o).map(|r| (viz_query::to_json(&r.value).unwrap(), r.stats)),
    };
    match r {
        Ok((j, st)) => (Ok(j), Some(st)),
        Err(e) => (Err((e.error_type.as_str(), e.message)), None),
    }
}

fn bounds(grid: Grid) -> (i64, i64, i64) {
    match grid {
        Grid::Range { start, end, step } => (start, end, step),
        Grid::Instant { time } => (time, time, 1),
    }
}

/// The whole pipeline in one process: readers over `groups` contiguous groups of sample
/// files (every group with all series files), extracts arriving in reverse order, tails
/// split by part, one leaf per part, answers through their encoding, then the merge.
fn distributed(s: &Stored, q: &str, grid: Grid, parts: u32, groups: usize, o: &Options, budget: LeafBudget) -> (Outcome, Option<viz_query::Stats>) {
    let SplitPlan::Split { fragments, key } = split_plan(q, o) else { panic!("{q} must split") };
    let (start, end, step) = bounds(grid);
    let ranges = viz_query::plan_with(q, start, end, step, o).unwrap();
    let series: Vec<&[u8]> = s.series_files.iter().map(|f| f.as_slice()).collect();
    let samples: Vec<&[u8]> = s.sample_files.iter().map(|f| f.as_slice()).collect();
    let per = samples.len().div_ceil(groups.max(1)).max(1);
    let chunks: Vec<&[&[u8]]> = samples.chunks(per).collect();
    let tails: Vec<&[u8]> = s.tail.iter().map(|f| f.as_slice()).collect();
    let cut = split::split_tails(&tails, &key, parts, &ranges).unwrap();
    let mut outputs = Vec::new();
    for part in 0..parts {
        let mut g = Gathered::new(&ranges, budget).unwrap();
        for (gi, chunk) in chunks.iter().enumerate().rev() {
            let ex = split::extract(&series, chunk, &key, part, parts, &ranges).unwrap();
            g.add(&ex.batch, gi as u32).unwrap();
        }
        for (ti, t) in cut[part as usize].iter().enumerate() {
            g.add(t, (chunks.len() + ti) as u32).unwrap();
        }
        let out = split::leaf_evaluate(&g, q, grid, o, fragments);
        outputs.push(LeafOutput::decode(&out.encode()).unwrap());
    }
    let r = match grid {
        Grid::Range { start, end, step } => split::merge_range(q, start, end, step, o, &outputs).map(|r| (viz_query::to_json(&r.matrix).unwrap(), r.stats)),
        Grid::Instant { time } => split::merge_instant(q, time, o, &outputs).map(|r| (viz_query::to_json(&r.value).unwrap(), r.stats)),
    };
    match r {
        Ok((j, st)) => (Ok(j), Some(st)),
        Err(e) => (Err((e.error_type.as_str(), e.message)), None),
    }
}

const UNLIMITED: LeafBudget = LeafBudget { samples: u64::MAX, series: u64::MAX, step_points: u64::MAX };

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(24), failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn split_equals_one_place(
        h in history_strategy(),
        layout in layout_strategy(),
        parts in prop_oneof![Just(1u32), Just(2), Just(7), Just(32), 3u32..12],
        groups in 1usize..5,
        start in (T0 - 20_000)..(T0 + 400_000),
        nsteps in 1i64..8,
        step in prop_oneof![Just(15_000i64), Just(60_000), 1_000i64..120_000],
    ) {
        let end = start + (nsteps - 1) * step + step / 3;
        let s = store(&h.encoded(), &layout);
        let o = opts();
        let mut split = 0;
        for q in QUERIES.iter().chain(AGG_QUERIES) {
            for grid in [Grid::Range { start, end, step }, Grid::Instant { time: end }] {
                let (want, want_stats) = one_place(&s, q, grid, &o);
                if let SplitPlan::Split { .. } = split_plan(q, &o) {
                    split += 1;
                    let (got, got_stats) = distributed(&s, q, grid, parts, groups, &o, UNLIMITED);
                    prop_assert_eq!(&got, &want, "{} {:?} over {} parts", q, grid, parts);
                    prop_assert_eq!(got_stats, want_stats, "statistics of {} {:?}", q, grid);
                }
            }
        }
        prop_assert!(split >= 100, "only {} evaluations split", split);
    }
}

/// The partial of an aggregation over the series `v` (labels, values per step).
fn partial_of(q: &str, v: &[viz_promql::SeriesV], n: usize, param: &[f64]) -> viz_query::agg::Partial {
    use viz_promql::{AggregateInput, AggregateParam, Expr};
    let e = viz_promql::parse_query(q).unwrap();
    let Expr::Aggregate(a) = &e else { panic!("{q} is not an aggregation") };
    let op = a.op.to_string();
    let (without, mut grouping): (bool, Vec<String>) = match &a.modifier {
        Some(promql_parser::parser::LabelModifier::Include(l)) => (false, l.labels.clone()),
        Some(promql_parser::parser::LabelModifier::Exclude(l)) => (true, l.labels.clone()),
        None => (false, vec![]),
    };
    if op == "count_values" && !without {
        grouping.push("v".into());
    }
    grouping.sort();
    let p = if op == "count_values" { AggregateParam::Label("v") } else if param.is_empty() { AggregateParam::None } else { AggregateParam::Scalar(param) };
    let input = AggregateInput { expr: a, op: &op, without, grouping: &grouping, param: p, series: v, start: 0, step: 1000, n, delayed_name_removal: false };
    viz_query::agg::partial(&input).unwrap().unwrap()
}

fn tricky() -> impl Strategy<Value = Option<f64>> {
    prop_oneof![
        3 => Just(None),
        4 => (-20i32..20).prop_map(|v| Some(v as f64 / 4.0)),
        2 => any::<f64>().prop_map(Some),
        1 => Just(Some(0.0)),
        1 => Just(Some(-0.0)),
        1 => Just(Some(f64::NAN)),
        1 => Just(Some(f64::INFINITY)),
        1 => Just(Some(f64::NEG_INFINITY)),
        1 => Just(Some(1e300)),
        1 => Just(Some(-1e300)),
        1 => Just(Some(1e-300)),
        1 => Just(Some(5e-324)),
    ]
}

fn bits(v: &[viz_promql::SeriesV]) -> Vec<(Vec<(String, String)>, Vec<Option<u64>>)> {
    v.iter().map(|s| (s.labels.as_ref().clone(), s.vals.iter().map(|x| x.map(|x| if x.is_nan() { 1 } else { x.to_bits() })).collect())).collect()
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(256), failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn partials_merge_exactly(
        vals in proptest::collection::vec(proptest::collection::vec(tricky(), 3), 1..24),
        side in proptest::collection::vec(0u8..3, 24),
        which in 0usize..14,
    ) {
        let queries = [
            "sum(x)", "sum by (g) (x)", "avg without (i) (x)", "count by (g) (x)", "group(x)", "min by (g) (x)", "max(x)",
            "stddev by (g) (x)", "stdvar without (g) (x)", "topk(2, x)", "bottomk by (g) (1, x)", r#"count_values("v", x)"#,
            r#"count_values without (i) ("v", x)"#, "topk by (g) (3, x)",
        ];
        let q = queries[which];
        let v: Vec<viz_promql::SeriesV> = vals
            .iter()
            .enumerate()
            .map(|(i, vs)| viz_promql::SeriesV {
                labels: Arc::new(vec![("g".into(), format!("{}", i % 3)), ("i".into(), format!("{i:02}"))]),
                drop_name: false,
                vals: vs.clone(),
            })
            .collect();
        let param = [2.0, 1.0, 3.0];
        let whole = partial_of(q, &v, 3, &param);
        // Three disjoint parts, merged in two different orders and through the encoding.
        let parts: Vec<Vec<viz_promql::SeriesV>> = (0..3u8).map(|p| v.iter().enumerate().filter(|(i, _)| side[*i] == p).map(|(_, s)| s.clone()).collect()).collect();
        let ps: Vec<_> = parts.iter().map(|p| partial_of(q, p, 3, &param)).collect();
        let mut a = ps[0].clone();
        a.merge(ps[1].clone()).unwrap();
        a.merge(ps[2].clone()).unwrap();
        let mut b = ps[2].clone();
        b.merge(ps[0].clone()).unwrap();
        b.merge(ps[1].clone()).unwrap();
        let mut enc = viz_query::agg::Out::default();
        b.encode(&mut enc);
        let b = viz_query::agg::Partial::decode(&mut viz_query::agg::In::new(&enc.0)).unwrap();
        let want = bits(&viz_query::agg::finish(&whole));
        prop_assert_eq!(bits(&viz_query::agg::finish(&a)), want.clone(), "{}", q);
        prop_assert_eq!(bits(&viz_query::agg::finish(&b)), want, "{} (other order, encoded)", q);
    }
}

#[test]
fn which_queries_split_and_why_not() {
    let o = opts();
    for q in AGG_QUERIES {
        assert!(matches!(split_plan(q, &o), SplitPlan::Split { .. }), "{q} must split: {:?}", split_plan(q, &o));
    }
    for (q, why) in NOT_SPLIT {
        match split_plan(q, &o) {
            SplitPlan::Single { reason } => assert!(reason.contains(why), "{q}: {reason:?} does not say {why:?}"),
            other => panic!("{q} must not split: {other:?}"),
        }
    }
    // The key: series_id ranges unless the argument can change labels.
    let key = |q: &str| match split_plan(q, &o) {
        SplitPlan::Split { key, .. } => key.without,
        other => panic!("{q}: {other:?}"),
    };
    assert_eq!(key("sum(m)"), Vec::<String>::new());
    assert_eq!(key("sum(rate(n[1m]))"), vec!["__type__", "__unit__"]);
    assert_eq!(key(r#"sum(rate({__name__=~"m|n"}[1m]))"#), vec!["__name__", "__type__", "__unit__"]);
    assert_eq!(key(r#"sum(label_replace(m, "inst", "a", "inst", ".*"))"#), vec!["inst"]);
    assert_eq!(key("sum(m) + count(rate(n[1m]))"), vec!["__type__", "__unit__"]);
    assert!(matches!(split_plan("sum(m) / sum(n)", &o), SplitPlan::Split { fragments: 2, .. }));
    // Delayed name removal changes what a fragment's output is: not split.
    let delayed = Options { eval: EvalOptions { delayed_name_removal: true, ..EvalOptions::default() }, ..o };
    assert!(matches!(split_plan("sum(m)", &delayed), SplitPlan::Single { .. }));
    // A key with nothing left out is the series_id; parts are contiguous ranges of it.
    let l = labels(&[("__name__", "m"), ("job", "x")]);
    assert_eq!(SplitKey::default().key(&l), viz_storage::batch::series_id(&l) as u64);
    assert_eq!(SplitKey::part_of(0, 7), 0);
    assert_eq!(SplitKey::part_of(u64::MAX, 7), 6);
    assert_eq!(SplitKey::part_of(1 << 63, 2), 1);
}

/// A fixed history with every series in every placement, for the directed tests.
fn fixed() -> (History, Stored) {
    let mut rows: Vec<(&[(&str, &str)], i64, f64)> = Vec::new();
    let pool: [&[(&str, &str)]; 4] = [
        &[("__name__", "n"), ("job", "x"), ("inst", "0")],
        &[("__name__", "n"), ("job", "x"), ("inst", "1")],
        &[("__name__", "n"), ("job", "y"), ("inst", "0")],
        &[("__name__", "n"), ("job", "y"), ("inst", "2")],
    ];
    for k in 0..40i64 {
        for (i, l) in pool.iter().enumerate() {
            rows.push((l, T0 + k * 15_000, (k * (i as i64 + 1)) as f64));
        }
    }
    let h = History::from_rows(&rows).cut(&[40, 80, 120]);
    let s = store(&h.encoded(), &Layout { flushed: 3, tail_from: 2, segment_cuts: vec![1, 2], row_group_rows: 7, compact: false });
    (h, s)
}

#[test]
fn a_leaf_stops_at_its_budget_and_a_rerun_with_the_rest_is_identical() {
    let (_, s) = fixed();
    let o = opts();
    let q = "sum by (job) (rate(n[1m]))";
    let grid = Grid::Range { start: T0 + 120_000, end: T0 + 500_000, step: 30_000 };
    let (want, _) = one_place(&s, q, grid, &o);
    // Budgets far below a leaf's share: every leaf stops while gathering.
    let tiny = LeafBudget { samples: 10, series: u64::MAX, step_points: u64::MAX };
    let SplitPlan::Split { key, fragments } = split_plan(q, &o) else { panic!() };
    let ranges = viz_query::plan_with(q, T0 + 120_000, T0 + 500_000, 30_000, &o).unwrap();
    let all: Vec<&[u8]> = s.sample_files.iter().map(|f| f.as_slice()).collect();
    let series: Vec<&[u8]> = s.series_files.iter().map(|f| f.as_slice()).collect();
    let tails: Vec<&[u8]> = s.tail.iter().map(|f| f.as_slice()).collect();
    let cut = split::split_tails(&tails, &key, 2, &ranges).unwrap();
    let leaf = |part: u32, budget: LeafBudget| {
        let mut g = Gathered::new(&ranges, budget).unwrap();
        let ex = split::extract(&series, &all, &key, part, 2, &ranges).unwrap();
        g.add(&ex.batch, 0).unwrap();
        for (i, t) in cut[part as usize].iter().enumerate() {
            g.add(t, 1 + i as u32).unwrap();
        }
        split::leaf_evaluate(&g, q, grid, &o, fragments)
    };
    for part in 0..2 {
        let out = leaf(part, tiny);
        assert_eq!(out.status, split::LEAF_ABORTED);
        let (limit, held) = out.aborted.unwrap();
        assert_eq!(limit.as_str(), "max_samples");
        // It stopped while gathering: no more than one batch past the budget.
        assert!(held > 10 && out.calls.is_empty(), "{held} {:?}", out.calls);
        assert!(out.partials.is_empty());
    }
    // The merge refuses to answer from an aborted leaf.
    let outs: Vec<LeafOutput> = (0..2).map(|p| leaf(p, tiny)).collect();
    assert!(split::merge_range(q, T0 + 120_000, T0 + 500_000, 30_000, &o, &outs).is_err());
    // A series budget below what a leaf holds stops it too.
    let evals: Vec<LeafOutput> = (0..2).map(|p| leaf(p, LeafBudget { samples: u64::MAX, series: 1, step_points: u64::MAX })).collect();
    assert!(evals.iter().any(|o| o.status == split::LEAF_ABORTED && o.aborted.unwrap().0.as_str() == "max_series"));
    // Re-run with the rest of the query's budget: identical to one place.
    let outs: Vec<LeafOutput> = (0..2).map(|p| leaf(p, UNLIMITED)).collect();
    let got = split::merge_range(q, T0 + 120_000, T0 + 500_000, 30_000, &o, &outs).map(|r| viz_query::to_json(&r.matrix).unwrap());
    assert_eq!(got.map_err(|e| (e.error_type.as_str(), e.message)), want);
}

#[test]
fn the_query_limits_are_replayed_exactly_on_the_summed_counts() {
    let (_, s) = fixed();
    let q = "sum(rate(n[1m])) + count(n)";
    let grid = Grid::Range { start: T0 + 120_000, end: T0 + 500_000, step: 30_000 };
    let base = opts();
    let (_, stats) = one_place(&s, q, grid, &base);
    let stats = stats.unwrap();
    assert_eq!(stats.selects, 2);
    // Each counted limit exactly at what the query loads, and one below: the same answer,
    // the same error message, in one place and over 3 parts.
    let limits = |f: &dyn Fn(&mut Limits)| {
        let mut l = Limits::unlimited();
        f(&mut l);
        Options { limits: l, ..base }
    };
    let cases: Vec<Options> = vec![
        limits(&|l| l.max_samples = stats.samples),
        limits(&|l| l.max_samples = stats.samples - 1),
        limits(&|l| l.max_samples = stats.samples / 2),
        limits(&|l| l.max_series = stats.series),
        limits(&|l| l.max_series = stats.series - 1),
        limits(&|l| l.max_series = 3),
        limits(&|l| l.max_step_points = 4 * 13),
        limits(&|l| l.max_step_points = 4 * 13 - 1),
        limits(&|l| l.max_output_points = stats.output_points),
        limits(&|l| l.max_output_points = stats.output_points - 1),
    ];
    let mut errors = 0;
    for o in &cases {
        let (want, _) = one_place(&s, q, grid, o);
        let (got, _) = distributed(&s, q, grid, 3, 2, o, UNLIMITED);
        assert_eq!(got, want, "{:?}", o.limits);
        errors += want.is_err() as usize;
    }
    assert_eq!(errors, 6);
}

#[test]
fn results_do_not_depend_on_the_order_extracts_arrive_in() {
    // A sample rewritten in a later file and again in the tail: whatever order a leaf
    // receives its extracts and tail batches in, the highest precedence wins.
    let l: &[(&str, &str)] = &[("__name__", "n"), ("job", "x"), ("inst", "0")];
    let h = History::from_rows(&[(l, T0, 1.0), (l, T0 + 15_000, 2.0), (l, T0, 10.0), (l, T0 + 15_000, 20.0), (l, T0 + 15_000, 200.0), (l, T0 + 30_000, 3.0)]).cut(&[2, 4, 5]);
    let s = store(&h.encoded(), &Layout { flushed: 4, tail_from: 3, segment_cuts: vec![2], row_group_rows: 100_000, compact: false });
    assert_eq!(s.sample_files.len(), 2);
    let o = opts();
    let q = "sum(last_over_time(n[1m]))";
    for t in [T0, T0 + 15_000, T0 + 30_000] {
        let (want, _) = one_place(&s, q, Grid::Instant { time: t }, &o);
        for groups in [1, 2] {
            let (got, _) = distributed(&s, q, Grid::Instant { time: t }, 1, groups, &o, UNLIMITED);
            assert_eq!(got, want, "at {t}, {groups} groups");
        }
    }
    let (want, _) = one_place(&s, q, Grid::Instant { time: T0 + 15_000 }, &o);
    assert!(want.unwrap().contains("\"200\""));
}
