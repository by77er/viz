//! Limits: each one fires with an `execution` error naming the limit and the number
//! reached, a query exactly at the limit succeeds, and nothing is ever truncated.
mod common;

use common::*;
use promql_parser::parser::Expr;
use proptest::prelude::*;
use viz_query::{estimate_depth, ErrorType, Limit, Limits, Options, QueryError};

const T: i64 = MID - 60_000;

/// Four series `m{i="0".."3"}` with 9 samples each (every 15 s over two minutes), half in
/// Parquet, the rest in the tail with one overlapping batch.
fn stored() -> Stored {
    let names = ["0", "1", "2", "3"];
    let sets: Vec<[(&str, &str); 2]> = names.iter().map(|i| [("__name__", "m"), ("i", *i)]).collect();
    let mut rows: Vec<(&[(&str, &str)], i64, f64)> = Vec::new();
    for k in 0..9i64 {
        for s in &sets {
            rows.push((&s[..], T + k * 15_000, k as f64));
        }
    }
    let b = History::from_rows(&rows).cut(&[8, 16, 24]).encoded();
    store(&b, &Layout { flushed: 3, tail_from: 2, segment_cuts: vec![1], row_group_rows: 5, compact: false })
}

fn run(q: &str, limits: Limits) -> Result<viz_query::RangeResult, QueryError> {
    // Nine steps, T .. T+120s every 15 s.
    viz_query::query_range_with(&stored().input(), q, T, T + 120_000, 15_000, &Options { limits, ..Options::default() })
}

fn assert_limit(r: Result<viz_query::RangeResult, QueryError>, limit: Limit, max: u64, reached: u64) {
    let e = r.expect_err("the limit must fire");
    assert_eq!(e.error_type, ErrorType::Execution, "{e}");
    assert_eq!(e.limit, Some((limit, max, reached)), "{e}");
    assert!(e.message.contains(limit.as_str()), "the message names the limit: {e}");
    assert!(e.message.contains(&reached.to_string()), "the message gives the number reached: {e}");
    assert!(e.message.contains(&max.to_string()), "the message gives the limit: {e}");
    assert!(e.to_json().contains(r#""errorType":"execution""#));
}

#[test]
fn baseline_reads_what_the_tests_below_assume() {
    let r = run("m", Limits::default()).unwrap();
    assert_eq!((r.stats.selects, r.stats.series, r.stats.samples, r.stats.output_points), (1, 4, 36, 36));
    let r = run("sum(m) + sum(m offset 15s)", Limits::default()).unwrap();
    assert_eq!((r.stats.selects, r.stats.series, r.stats.samples, r.stats.output_points), (2, 8, 68, 8));
}

#[test]
fn max_samples() {
    assert!(run("m", Limits { max_samples: 36, ..Limits::default() }).is_ok());
    assert_limit(run("m", Limits { max_samples: 35, ..Limits::default() }), Limit::MaxSamples, 35, 36);
    // The budget is for the whole query: the second selector takes it over the edge.
    assert!(run("sum(m) + sum(m offset 15s)", Limits { max_samples: 68, ..Limits::default() }).is_ok());
    assert_limit(run("sum(m) + sum(m offset 15s)", Limits { max_samples: 67, ..Limits::default() }), Limit::MaxSamples, 67, 68);
    assert_limit(run("sum(m)", Limits { max_samples: 0, ..Limits::default() }), Limit::MaxSamples, 0, 36);
    // A query that loads nothing is not affected.
    assert!(run("vector(1)", Limits { max_samples: 0, max_series: 0, ..Limits::default() }).is_ok());
    // Duplicates between lake and tail are counted once: 36, not 44 (see stored()).
    assert_eq!(run("m", Limits::unlimited()).unwrap().stats.samples, 36);
}

#[test]
fn max_series() {
    assert!(run("m", Limits { max_series: 4, ..Limits::default() }).is_ok());
    assert_limit(run("m", Limits { max_series: 3, ..Limits::default() }), Limit::MaxSeries, 3, 4);
    assert!(run(r#"m{i=~"0|1|2"}"#, Limits { max_series: 3, ..Limits::default() }).is_ok());
    assert!(run("count(m) + count(m)", Limits { max_series: 8, ..Limits::default() }).is_ok());
    assert_limit(run("count(m) + count(m)", Limits { max_series: 7, ..Limits::default() }), Limit::MaxSeries, 7, 8);
}

#[test]
fn max_output_points() {
    assert!(run("m", Limits { max_output_points: 36, ..Limits::default() }).is_ok());
    assert_limit(run("m", Limits { max_output_points: 35, ..Limits::default() }), Limit::MaxOutputPoints, 35, 36);
    // An aggregation's output is what counts, not its input.
    assert!(run("sum(m)", Limits { max_output_points: 9, ..Limits::default() }).is_ok());
    assert_limit(run("sum(m)", Limits { max_output_points: 8, ..Limits::default() }), Limit::MaxOutputPoints, 8, 9);
    // Scalars count too, and so do instant results.
    assert_limit(run("time()", Limits { max_output_points: 8, ..Limits::default() }), Limit::MaxOutputPoints, 8, 9);
    let s = stored();
    let at = |q: &str, max: u64| {
        viz_query::query_instant_with(&s.input(), q, T + 60_000, &Options { limits: Limits { max_output_points: max, ..Limits::default() }, ..Options::default() })
            .map(|r| r.stats.output_points)
            .map_err(|e| e.limit)
    };
    assert_eq!(at("m", 4), Ok(4));
    assert_eq!(at("m", 3), Err(Some((Limit::MaxOutputPoints, 3, 4))));
    assert_eq!(at("m[30s]", 8), Ok(8));
    assert_eq!(at("m[30s]", 7), Err(Some((Limit::MaxOutputPoints, 7, 8))));
    assert_eq!(at("1", 1), Ok(1));
    assert_eq!(at("1", 0), Err(Some((Limit::MaxOutputPoints, 0, 1))));
}

#[test]
fn max_step_points() {
    // 4 series x 9 steps.
    assert!(run("sum(m)", Limits { max_step_points: 36, ..Limits::default() }).is_ok());
    assert_limit(run("sum(m)", Limits { max_step_points: 35, ..Limits::default() }), Limit::MaxStepPoints, 35, 36);
    // A subquery has its own, finer step grid: (T-60s, T+120s] every 5 s is 36 steps.
    let q = "max_over_time(sum(m)[1m:5s])";
    assert!(run(q, Limits { max_step_points: 4 * 36, ..Limits::default() }).is_ok());
    assert_limit(run(q, Limits { max_step_points: 4 * 36 - 1, ..Limits::default() }), Limit::MaxStepPoints, 4 * 36 - 1, 4 * 36);
    // Per selector, not summed.
    assert!(run("sum(m) + sum(m)", Limits { max_step_points: 36, ..Limits::default() }).is_ok());
}

#[test]
fn max_query_bytes() {
    let q = "m + m"; // 5 bytes
    assert!(run(q, Limits { max_query_bytes: 5, ..Limits::default() }).is_ok());
    assert_limit(run(q, Limits { max_query_bytes: 4, ..Limits::default() }), Limit::MaxQueryBytes, 4, 5);
    let long = format!("m{}", " ".repeat(16 * 1024));
    assert!(run(&long[..16 * 1024], Limits::default()).is_ok());
    assert_limit(run(&long, Limits::default()), Limit::MaxQueryBytes, 16 * 1024, 16 * 1024 + 1);
}

#[test]
fn max_depth() {
    // ((m)) is three levels: two groups and the top level.
    assert_eq!(estimate_depth("((m))", u64::MAX), 3);
    assert!(run("((m))", Limits { max_depth: 3, ..Limits::default() }).is_ok());
    assert_limit(run("((m))", Limits { max_depth: 2, ..Limits::default() }), Limit::MaxDepth, 2, 3);
    assert_eq!(estimate_depth("m + m + m", u64::MAX), 3);
    assert!(run("m + m + m", Limits { max_depth: 3, ..Limits::default() }).is_ok());
    assert_limit(run("m + m + m", Limits { max_depth: 2, ..Limits::default() }), Limit::MaxDepth, 2, 3);
    // Operators and brackets inside strings and comments do not count.
    assert_eq!(estimate_depth(r#"label_replace(m, "a", "((((+-", "b", "((.*))") # ((((("#, u64::MAX), 2);
    assert_eq!(estimate_depth("m{a='(((', b=`\\(((`}", u64::MAX), 4);
    // Every guarded entry point refuses, before parsing.
    let tight = Options { limits: Limits { max_depth: 2, ..Limits::default() }, ..Options::default() };
    let s = stored();
    assert!(viz_query::query_instant_with(&s.input(), "((m))", T, &tight).unwrap_err().limit.is_some());
    assert!(viz_query::selectors_with("((m))", T, T, 1, &tight).unwrap_err().limit.is_some());
    assert!(viz_query::plan_with("((m))", T, T, 1, &tight).unwrap_err().limit.is_some());
}

/// Queries nested far beyond anything the parser or evaluator could recurse through are
/// refused from the text alone. Run on a 256 KiB stack: reaching the parser with any of
/// these would overflow it.
#[test]
fn pathological_nesting_is_refused_without_recursing() {
    let n = 7_000;
    let queries = vec![
        format!("{}m{}", "(".repeat(n), ")".repeat(n)),
        format!("{}m", "-".repeat(n)),
        format!("{}m", "- ".repeat(n)),
        format!("m{}", " + m".repeat(n / 2)),
        format!("m{}", "^m".repeat(n)),
        format!("{}m{}", "abs(".repeat(n / 4), ")".repeat(n / 4)),
        format!("{}m", "(".repeat(n)), // unbalanced
        format!("m{}", " and m".repeat(n / 3)),
        format!("m{}", " OR m".repeat(n / 3)),
        format!("{}m[1m]{})", "sum_over_time(".repeat(600), ")[1m:]".repeat(599)),
    ];
    std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(move || {
            for q in &queries {
                assert!(q.len() <= 16 * 1024, "the query must get past max_query_bytes to test the depth guard");
                let e = run(q, Limits::default()).expect_err("must be refused");
                assert_eq!(e.error_type, ErrorType::Execution);
                assert!(matches!(e.limit, Some((Limit::MaxDepth, 100, reached)) if reached > 100), "{:?}", e.limit);
                assert!(viz_query::parse_selector(q).unwrap_err().limit.is_some());
                assert!(viz_query::plan(q, T, T, 1).unwrap_err().limit.is_some());
            }
        })
        .unwrap()
        .join()
        .unwrap();
}

/// A query at the default depth limit parses and evaluates. In an optimised build it
/// must fit 1 MiB, the stack of a `wasm32-unknown-unknown` module (the module itself is
/// measured by `tools/wasm_check.mjs`: about ten times that depth fits). An unoptimised
/// build has far larger frames (nested function calls need between 1 and 2 MiB at depth
/// 100), so there the test allows 4 MiB.
#[test]
fn a_query_at_the_depth_limit_fits_the_stack() {
    let stack = if cfg!(debug_assertions) { 4 } else { 1 } * 1024 * 1024;
    let queries = vec![
        format!("{}m{}", "(".repeat(99), ")".repeat(99)),
        format!("m{}", " + m".repeat(99)),
        format!("{}m", "-".repeat(99)),
        format!("{}m{}", "abs(".repeat(99), ")".repeat(99)),
        format!("{}m{}", "sum(".repeat(99), ")".repeat(99)),
        format!("{}m[1m]{}", "max_over_time(".repeat(49), ")[1m:15s]".repeat(48) + ")"),
    ];
    std::thread::Builder::new()
        .stack_size(stack)
        .spawn(move || {
            for q in &queries {
                let d = estimate_depth(q, u64::MAX);
                assert!((98..=100).contains(&d), "{q}: depth {d}");
                let r = run(q, Limits { max_step_points: u64::MAX, max_samples: u64::MAX, max_series: u64::MAX, ..Limits::default() });
                assert!(r.is_ok(), "{q}: {:?}", r.err());
            }
        })
        .unwrap()
        .join()
        .unwrap();
}

fn ast_depth(e: &Expr) -> u64 {
    1 + match e {
        Expr::Paren(p) => ast_depth(&p.expr),
        Expr::Unary(u) => ast_depth(&u.expr),
        Expr::Binary(b) => ast_depth(&b.lhs).max(ast_depth(&b.rhs)),
        Expr::Aggregate(a) => ast_depth(&a.expr).max(a.param.as_ref().map_or(0, |p| ast_depth(p))),
        Expr::Subquery(s) => ast_depth(&s.expr),
        Expr::Call(c) => c.args.args.iter().map(|a| ast_depth(a)).max().unwrap_or(0),
        _ => 0,
    }
}

/// Random expressions built from the query pool with every nesting construct.
fn expr_strategy() -> impl Strategy<Value = String> {
    let leaf = (0..QUERIES.len()).prop_map(|i| QUERIES[i].to_string()).prop_filter("valid", |q| *q != "m +");
    leaf.prop_recursive(6, 40, 3, |inner| {
        prop_oneof![
            inner.clone().prop_map(|e| format!("({e})")),
            inner.clone().prop_map(|e| format!("-{e}")),
            inner.clone().prop_map(|e| format!("- -({e})")),
            inner.clone().prop_map(|e| format!("abs({e})")),
            inner.clone().prop_map(|e| format!("sum by (job) ({e})")),
            inner.clone().prop_map(|e| format!("topk(2, {e})")),
            inner.clone().prop_map(|e| format!("max_over_time(({e})[2m:30s])")),
            inner.clone().prop_map(|e| format!("clamp({e}, 1, 2 + 3 * 4)")),
            inner.clone().prop_map(|e| format!("{e} > bool 1")),
            (inner.clone(), inner.clone()).prop_map(|(a, b)| format!("{a} + {b}")),
            (inner.clone(), inner.clone()).prop_map(|(a, b)| format!("({a}) and on(job) ({b})")),
            (inner.clone(), inner.clone(), inner.clone()).prop_map(|(a, b, c)| format!("({a}) ^ ({b}) ^ ({c})")),
            (inner.clone(), inner).prop_map(|(a, b)| format!("({a}) atan2 ({b}) or vector(1)")),
        ]
    })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 600, failure_persistence: None, ..ProptestConfig::default() })]

    /// The guard is sound: the estimate is never below the real depth of the syntax tree,
    /// for anything the parser accepts.
    #[test]
    fn estimated_depth_bounds_the_syntax_tree(q in expr_strategy()) {
        let Ok(ast) = promql_parser::parser::parse(&q) else { return Ok(()) };
        let (real, est) = (ast_depth(&ast), estimate_depth(&q, u64::MAX));
        prop_assert!(est >= real, "{}: estimated {} but the tree is {} deep", q, est, real);
        // Stopping early never reports a value at or below the threshold wrongly.
        let stop = real / 2;
        prop_assert!(estimate_depth(&q, stop) > stop || est <= stop);
    }
}
