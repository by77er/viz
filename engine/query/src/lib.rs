//! # viz-query
//!
//! The query half of `contracts/engine.ts`: PromQL (`viz-promql`) evaluated over lake
//! Parquet files and shard tail batches (`viz-storage`), with limits and a fetch plan.
//!
//! No I/O, no clock, no randomness: every function is a pure function of its arguments,
//! so the crate runs unchanged as WASM in a Worker, natively, and in a simulator.
//! Nothing panics on input; errors carry a Prometheus `errorType` ([`ErrorType`]).
//!
//! | Function | Purpose |
//! |---|---|
//! | [`plan`] | what to fetch (matchers and time ranges) before evaluating |
//! | [`selectors`] | the raw per-selector ranges `plan` is built from |
//! | [`query_range`], [`query_instant`] | evaluate; return the Prometheus `data` object as JSON |
//! | [`query_range_with`], [`query_instant_with`] | the same, typed, with [`Options`] and [`Stats`] |
//! | [`label_names`], [`label_values`], [`series`] | metadata endpoints |
//! | [`parse_selector`] | a `match[]` string to matchers |
//! | [`files_needed`], [`scan_rows`] | which files a plan can skip, and how many rows it decodes from the others, from the ledger's index fragments |
//! | [`file_plan`], [`sample_plan`] | which byte ranges of each file to read: by name and time from the fragments, or by series once the matchers are resolved against the series files |
//! | [`StorageSource`] | the `viz_promql::SeriesSource` over a `viz_storage::ScanInput` |
//!
//! Division of labour between the three crates is documented on [`source`].
//!
//! Units: every time that goes in is Unix **milliseconds** as `i64`. Results serialise
//! timestamps as Prometheus does, Unix **seconds**; that conversion happens once, in
//! `viz-promql`'s serialiser.

pub mod agg;
pub mod cardinality;
pub mod catalog;
mod error;
pub mod exact;
mod limits;
mod meta;
mod plan;
mod prune;
pub mod source;
pub mod split;

pub use error::{ErrorType, Limit, QueryError};
pub use limits::{estimate_depth, Limits};
pub use meta::{label_names, label_names_with, label_values, label_values_with, series, series_with, Labels};
pub use plan::{plan, plan_with, FetchRange};
pub use prune::{file_plan, files_needed, part_plan, part_sids, sample_plan, scan_rows, FilePlan, FileRead, PartFilter, ReadPlan, RANGE_GAP};
pub use source::{to_storage_matcher, Stats, StorageSource};
pub use split::{split_plan, SplitKey, SplitPlan};
pub use viz_promql::{EvalOptions, MatchOp, Matcher, Matrix, SelectorInfo, SeriesSource, Value};
pub use viz_storage::ScanInput;

use promql_parser::parser::Expr;
use serde::Serialize;

/// Everything that configures a query.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Options {
    pub limits: Limits,
    /// PromQL engine options: lookback delta, delayed name removal, default subquery
    /// step, maximum steps.
    pub eval: EvalOptions,
}

/// A range query's result.
#[derive(Debug, Clone, PartialEq)]
pub struct RangeResult {
    pub matrix: Matrix,
    pub stats: Stats,
}

/// An instant query's result.
#[derive(Debug, Clone, PartialEq)]
pub struct InstantResult {
    pub value: Value,
    pub stats: Stats,
}

/// Serialise a result (`Matrix`, `Value`, `Vec<SelectorInfo>`, `Vec<FetchRange>`,
/// `Vec<String>`) to JSON. For `Matrix` and `Value` this is the `data` object of a
/// Prometheus API response.
pub fn to_json<T: Serialize + ?Sized>(v: &T) -> Result<String, QueryError> {
    serde_json::to_string(v).map_err(|e| QueryError::internal(format!("serialising the result: {e}")))
}

/// JSON for the result of [`series`]: an array of `{"label":"value",…}` objects.
pub fn labels_to_json(sets: &[Labels]) -> String {
    let mut out = String::from("[");
    for (i, l) in sets.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&viz_storage::json::labels_to_json(l));
    }
    out.push(']');
    out
}

/// Range-query parameters are the request's, so a bad one is `bad_data` (as in the
/// Prometheus HTTP API), with Prometheus' wording.
pub(crate) fn check_range(start_ms: i64, end_ms: i64, step_ms: i64, opts: &Options) -> Result<u64, QueryError> {
    if end_ms < start_ms {
        return Err(QueryError::bad_data("end timestamp must not be before start time"));
    }
    if step_ms <= 0 {
        return Err(QueryError::bad_data("zero or negative query resolution step widths are not accepted. Try a positive integer"));
    }
    let steps = ((end_ms as i128 - start_ms as i128) / step_ms as i128 + 1) as u128;
    if steps > opts.eval.max_steps as u128 {
        return Err(QueryError::bad_data(format!(
            "exceeded maximum resolution of {} points per timeseries. Try decreasing the query resolution (?step=XX)",
            opts.eval.max_steps
        )));
    }
    Ok(steps as u64)
}

/// The selectors of `query` and the inclusive sample range each reads when the query is
/// evaluated from `start_ms` to `end_ms` every `step_ms` (`start_ms == end_ms` for an
/// instant query). Exactly the `select` calls evaluation will make. [`plan`] is the
/// merged, clamped form a fetcher wants.
pub fn selectors(query: &str, start_ms: i64, end_ms: i64, step_ms: i64) -> Result<Vec<SelectorInfo>, QueryError> {
    selectors_with(query, start_ms, end_ms, step_ms, &Options::default())
}

/// [`selectors`] with explicit options.
pub fn selectors_with(query: &str, start_ms: i64, end_ms: i64, step_ms: i64, opts: &Options) -> Result<Vec<SelectorInfo>, QueryError> {
    opts.limits.check_query(query)?;
    let step_ms = if start_ms == end_ms { step_ms.max(1) } else { step_ms };
    check_range(start_ms, end_ms, step_ms, opts)?;
    viz_promql::selectors_with(query, start_ms, end_ms, step_ms, &opts.eval).map_err(QueryError::from_promql)
}

/// Prometheus `query_range` over `input`: the `data` object of the HTTP API response as
/// JSON (`{"resultType":"matrix","result":[…]}`), with default [`Options`].
pub fn query_range(input: &ScanInput<'_>, query: &str, start_ms: i64, end_ms: i64, step_ms: i64) -> Result<String, QueryError> {
    to_json(&query_range_with(input, query, start_ms, end_ms, step_ms, &Options::default())?.matrix)
}

/// [`query_range`], typed, with explicit options and the read statistics.
pub fn query_range_with(
    input: &ScanInput<'_>,
    query: &str,
    start_ms: i64,
    end_ms: i64,
    step_ms: i64,
    opts: &Options,
) -> Result<RangeResult, QueryError> {
    opts.limits.check_query(query)?;
    let steps = check_range(start_ms, end_ms, step_ms, opts)?;
    let sels = viz_promql::selectors_with(query, start_ms, end_ms, step_ms, &opts.eval).map_err(QueryError::from_promql)?;
    let src = StorageSource::with_plan(input, opts.limits, sels, steps);
    let expr = viz_promql::parse_query(query).map_err(QueryError::from_promql)?;
    let matrix = viz_promql::query_range_expr(&src, &expr, start_ms, end_ms, step_ms, &opts.eval, Some(&agg::Canonical))
        .map_err(|e| src.take_failure().unwrap_or_else(|| QueryError::from_promql(e)))?;
    let points: u64 = matrix.series.iter().map(|s| s.points.len() as u64).sum();
    let stats = finish(&src, points, opts)?;
    Ok(RangeResult { matrix, stats })
}

/// Prometheus instant `query` at `time_ms` over `input`: the `data` object as JSON. The
/// result type is `vector`, `scalar`, `string`, or `matrix` for a top-level range vector.
pub fn query_instant(input: &ScanInput<'_>, query: &str, time_ms: i64) -> Result<String, QueryError> {
    to_json(&query_instant_with(input, query, time_ms, &Options::default())?.value)
}

/// [`query_instant`], typed, with explicit options and the read statistics.
pub fn query_instant_with(input: &ScanInput<'_>, query: &str, time_ms: i64, opts: &Options) -> Result<InstantResult, QueryError> {
    opts.limits.check_query(query)?;
    let sels = viz_promql::selectors_with(query, time_ms, time_ms, 1, &opts.eval).map_err(QueryError::from_promql)?;
    let src = StorageSource::with_plan(input, opts.limits, sels, 1);
    let expr = viz_promql::parse_query(query).map_err(QueryError::from_promql)?;
    let value = viz_promql::query_instant_expr(&src, &expr, time_ms, &opts.eval, Some(&agg::Canonical))
        .map_err(|e| src.take_failure().unwrap_or_else(|| QueryError::from_promql(e)))?;
    let points = match &value {
        Value::Vector(v) => v.len() as u64,
        Value::Scalar { .. } | Value::String { .. } => 1,
        Value::Matrix(m) => m.series.iter().map(|s| s.points.len() as u64).sum(),
    };
    let stats = finish(&src, points, opts)?;
    Ok(InstantResult { value, stats })
}

fn finish(src: &StorageSource<'_>, points: u64, opts: &Options) -> Result<Stats, QueryError> {
    if points > opts.limits.max_output_points {
        return Err(QueryError::limit(Limit::MaxOutputPoints, opts.limits.max_output_points, points, "points in the result"));
    }
    Ok(Stats { output_points: points, ..src.stats() })
}

/// One-place evaluation of a range query over any `SeriesSource`, with this crate's
/// order-independent aggregations (`agg::Canonical`) and no limits: what
/// [`query_range_with`] computes, without storage. The reference of the tests.
pub fn reference_range(src: &dyn SeriesSource, query: &str, start_ms: i64, end_ms: i64, step_ms: i64, eval: &EvalOptions) -> Result<Matrix, viz_promql::Error> {
    let expr = viz_promql::parse_query(query)?;
    viz_promql::query_range_expr(src, &expr, start_ms, end_ms, step_ms, eval, Some(&agg::Canonical))
}

/// [`reference_range`] for an instant query.
pub fn reference_instant(src: &dyn SeriesSource, query: &str, time_ms: i64, eval: &EvalOptions) -> Result<Value, viz_promql::Error> {
    let expr = viz_promql::parse_query(query)?;
    viz_promql::query_instant_expr(src, &expr, time_ms, eval, Some(&agg::Canonical))
}

/// Parse a series selector such as `up{job="api"}` (a `match[]` parameter) into its
/// matchers. Anything that is not a bare instant selector (an expression, an `offset`,
/// an `@`) is `bad_data`, as is a selector that would match every series.
pub fn parse_selector(selector: &str) -> Result<Vec<Matcher>, QueryError> {
    Limits::default().check_query(selector)?;
    // Goes through viz-promql first: it guards the parser against inputs that panic it.
    let mut sels = viz_promql::selectors(selector, 0, 0, 1).map_err(QueryError::from_promql)?;
    let bare = match promql_parser::parser::parse(selector) {
        Ok(Expr::VectorSelector(vs)) => vs.offset.is_none() && vs.at.is_none(),
        _ => false,
    };
    if !bare || sels.len() != 1 {
        return Err(QueryError::bad_data(format!("{selector:?} is not a series selector")));
    }
    let matchers = sels.remove(0).matchers;
    meta::check_selective(&matchers)?;
    Ok(matchers)
}
