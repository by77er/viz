//! `viz-promql`: a PromQL evaluator with no I/O, no async, no clock and no
//! randomness, so the same code runs natively, as WASM in a Worker, and in a
//! deterministic simulator.
//!
//! Parsing is delegated to `promql-parser`. Data comes in through
//! [`SeriesSource`]; results go out as [`Matrix`] / [`Value`], which
//! serialise to the `data` object of the Prometheus HTTP API.
//!
//! ```
//! use viz_promql::{query_range, MemSource, Series};
//! let src = MemSource::from_series(vec![Series {
//!     labels: vec![("__name__".into(), "up".into())],
//!     ts: vec![0, 15_000, 30_000],
//!     values: vec![1.0, 1.0, 0.0],
//! }]);
//! let m = query_range(&src, "up == 0", 0, 30_000, 15_000).unwrap();
//! assert_eq!(serde_json::to_string(&m).unwrap(),
//!     r#"{"resultType":"matrix","result":[{"metric":{"__name__":"up"},"values":[[30,"0"]]}]}"#);
//! ```

mod api;
mod eval;
mod functions;
pub mod promqltest;
mod types;

use promql_parser::parser::Expr;

pub use api::{Matrix, MatrixSeries, SelectorInfo, Value, VectorSample};
pub use eval::EvalOptions;
pub use functions::almost_equal;
pub use types::{
    compile_anchored, format_float, is_stale_nan, stale_nan, CompiledMatcher, Error, MatchOp, Matcher, MemSource,
    Series, SeriesSource, NAME_LABEL, STALE_NAN_BITS,
};

use eval::{Evaluator, SeriesV, Steps, Val};
use types::is_metadata_label;

pub(crate) fn parse(query: &str) -> Result<Expr, Error> {
    guard_durations(query)?;
    promql_parser::parser::parse(query).map_err(Error::Parse)
}

/// `promql-parser` 0.11 panics (`Duration::from_secs_f64`) when a bare
/// number that is infinite, NaN or enormous is used as a duration, as in
/// `m[1e400]` or `m offset Inf`. A panic aborts a WASM isolate, so such
/// queries are rejected here, from the parser's own token stream, before
/// the parser sees them.
fn guard_durations(query: &str) -> Result<(), Error> {
    use lrpar::{Lexeme, Lexer, NonStreamingLexer};
    use promql_parser::parser::token::{T_ADD, T_COLON, T_LEFT_BRACKET, T_NUMBER, T_OFFSET, T_SUB};
    // Durations beyond this many seconds (about 30 million years) are refused.
    const MAX_SECONDS: f64 = 1e15;
    let Ok(lexer) = promql_parser::parser::lex::lexer(query) else {
        return Ok(()); // The parser reports lexical errors itself.
    };
    let (mut prev, mut prev2) = (u16::MAX, u16::MAX);
    for lexeme in lexer.iter() {
        let Ok(lexeme) = lexeme else { return Ok(()) };
        let id = lexeme.tok_id();
        let in_duration_position = matches!(prev, T_LEFT_BRACKET | T_COLON | T_OFFSET)
            || (matches!(prev, T_ADD | T_SUB) && prev2 == T_OFFSET);
        if id == T_NUMBER && in_duration_position {
            let text = lexer.span_str(lexeme.span()).to_ascii_lowercase().replace('_', "");
            let value = match text.strip_prefix("0x") {
                Some(hex) => u64::from_str_radix(hex, 16).map(|v| v as f64).unwrap_or(f64::INFINITY),
                None => text.parse::<f64>().unwrap_or(f64::NAN),
            };
            if !(0.0..=MAX_SECONDS).contains(&value) {
                return Err(Error::Parse(format!("duration {text:?} is out of range")));
            }
        }
        prev2 = prev;
        prev = id;
    }
    Ok(())
}

fn check_range(start_ms: i64, end_ms: i64, step_ms: i64, opts: &EvalOptions) -> Result<Steps, Error> {
    if step_ms > 0 && end_ms >= start_ms && end_ms.checked_sub(start_ms).map(|d| d / step_ms) .is_none_or(|n| n as u128 + 1 > opts.max_steps as u128) {
        return Err(Error::Eval(format!(
            "exceeded maximum resolution of {} points per timeseries. Try decreasing the query resolution (?step=XX)",
            opts.max_steps
        )));
    }
    if step_ms <= 0 {
        return Err(Error::Eval("zero or negative query resolution step widths are not accepted".into()));
    }
    if end_ms < start_ms {
        return Err(Error::Eval("end timestamp must not be before start time".into()));
    }
    Ok(Steps { start: start_ms, end: end_ms, step: step_ms })
}

/// The selectors of `query` and the inclusive sample range each one reads
/// when the query is evaluated from `start_ms` to `end_ms` every `step_ms`
/// (pass `start_ms == end_ms` for an instant query). Ranges already include
/// range-vector windows, the lookback delta, `offset`, `@` and subquery
/// geometry, and are exactly what `query_range` asks the source for.
pub fn selectors(query: &str, start_ms: i64, end_ms: i64, step_ms: i64) -> Result<Vec<SelectorInfo>, Error> {
    selectors_with(query, start_ms, end_ms, step_ms, &EvalOptions::default())
}

/// [`selectors`] with explicit engine options.
pub fn selectors_with(
    query: &str,
    start_ms: i64,
    end_ms: i64,
    step_ms: i64,
    opts: &EvalOptions,
) -> Result<Vec<SelectorInfo>, Error> {
    let expr = parse(query)?;
    let steps = check_range(start_ms, end_ms, if start_ms == end_ms { step_ms.max(1) } else { step_ms }, opts)?;
    let mut out = Vec::new();
    walk_selectors(&expr, steps, opts, start_ms, end_ms, &mut out)?;
    Ok(out)
}

fn walk_selectors(
    e: &Expr,
    steps: Steps,
    opts: &EvalOptions,
    qs: i64,
    qe: i64,
    out: &mut Vec<SelectorInfo>,
) -> Result<(), Error> {
    if steps.n() == 0 {
        return Ok(());
    }
    match e {
        Expr::VectorSelector(vs) => {
            let (min, max) = eval::selector_range(vs, None, steps, opts, qs, qe);
            out.push(SelectorInfo { matchers: eval::convert_matchers(&vs.name, &vs.matchers)?, min_ts_ms: min, max_ts_ms: max });
        }
        Expr::MatrixSelector(ms) => {
            let (min, max) = eval::selector_range(&ms.vs, Some(eval::dur_ms(&ms.range)), steps, opts, qs, qe);
            out.push(SelectorInfo {
                matchers: eval::convert_matchers(&ms.vs.name, &ms.vs.matchers)?,
                min_ts_ms: min,
                max_ts_ms: max,
            });
        }
        Expr::Subquery(sq) => {
            let inner = eval::subquery_steps(sq, steps, opts, qs, qe);
            walk_selectors(&sq.expr, inner, opts, qs, qe, out)?;
        }
        Expr::Paren(p) => walk_selectors(&p.expr, steps, opts, qs, qe, out)?,
        Expr::Unary(u) => walk_selectors(&u.expr, steps, opts, qs, qe, out)?,
        Expr::Binary(b) => {
            walk_selectors(&b.lhs, steps, opts, qs, qe, out)?;
            walk_selectors(&b.rhs, steps, opts, qs, qe, out)?;
        }
        Expr::Aggregate(a) => {
            if let Some(p) = &a.param {
                walk_selectors(p, steps, opts, qs, qe, out)?;
            }
            walk_selectors(&a.expr, steps, opts, qs, qe, out)?;
        }
        Expr::Call(c) => {
            for a in &c.args.args {
                walk_selectors(a, steps, opts, qs, qe, out)?;
            }
        }
        Expr::NumberLiteral(_) | Expr::StringLiteral(_) => {}
        Expr::Extension(_) => return Err(Error::Unsupported("extension expression".into())),
    }
    Ok(())
}

/// Evaluate `query` at `start_ms, start_ms + step_ms, ... <= end_ms`.
/// Equivalent to an instant query at every step.
pub fn query_range(
    source: &dyn SeriesSource,
    query: &str,
    start_ms: i64,
    end_ms: i64,
    step_ms: i64,
) -> Result<Matrix, Error> {
    query_range_with(source, query, start_ms, end_ms, step_ms, &EvalOptions::default())
}

/// [`query_range`] with explicit engine options.
pub fn query_range_with(
    source: &dyn SeriesSource,
    query: &str,
    start_ms: i64,
    end_ms: i64,
    step_ms: i64,
    opts: &EvalOptions,
) -> Result<Matrix, Error> {
    let expr = parse(query)?;
    range_expr(source, &expr, start_ms, end_ms, step_ms, opts)
}

/// Evaluate `query` at one point in time.
pub fn query_instant(source: &dyn SeriesSource, query: &str, time_ms: i64) -> Result<Value, Error> {
    query_instant_with(source, query, time_ms, &EvalOptions::default())
}

/// [`query_instant`] with explicit engine options.
pub fn query_instant_with(
    source: &dyn SeriesSource,
    query: &str,
    time_ms: i64,
    opts: &EvalOptions,
) -> Result<Value, Error> {
    let expr = parse(query)?;
    instant_expr(source, &expr, time_ms, opts)
}

/// End of evaluation: apply delayed name removal and reject duplicates.
fn cleanup(mut v: Vec<SeriesV>, opts: &EvalOptions) -> Result<Vec<(Vec<(String, String)>, Vec<Option<f64>>)>, Error> {
    v.retain(|s| s.vals.iter().any(|x| x.is_some()));
    let mut out = Vec::with_capacity(v.len());
    for s in v {
        let labels: Vec<(String, String)> = if opts.delayed_name_removal && s.drop_name {
            s.labels.iter().filter(|(k, _)| !is_metadata_label(k)).cloned().collect()
        } else {
            s.labels.as_ref().clone()
        };
        out.push((labels, s.vals));
    }
    let mut seen = std::collections::HashSet::with_capacity(out.len());
    for (l, _) in &out {
        if !seen.insert(l) {
            return Err(Error::Eval("vector cannot contain metrics with the same labelset".into()));
        }
    }
    Ok(out)
}

pub(crate) fn range_expr(
    source: &dyn SeriesSource,
    expr: &Expr,
    start_ms: i64,
    end_ms: i64,
    step_ms: i64,
    opts: &EvalOptions,
) -> Result<Matrix, Error> {
    let steps = check_range(start_ms, end_ms, step_ms, opts)?;
    let ev = Evaluator { src: source, opts: *opts, q_start: start_ms, q_end: end_ms };
    let series = match ev.eval(expr, steps)? {
        Val::Scalar(v) => vec![MatrixSeries {
            metric: vec![],
            points: v.into_iter().enumerate().map(|(i, x)| (steps.ts(i), x)).collect(),
        }],
        Val::Str(_) => {
            return Err(Error::Eval(
                "invalid expression type \"string\" for range query, must be Scalar or instant Vector".into(),
            ))
        }
        Val::Vector(v) => {
            let mut series: Vec<MatrixSeries> = cleanup(v, opts)?
                .into_iter()
                .map(|(metric, vals)| MatrixSeries {
                    metric,
                    points: vals.into_iter().enumerate().filter_map(|(i, x)| x.map(|x| (steps.ts(i), x))).collect(),
                })
                .collect();
            series.sort_by(|a, b| a.metric.cmp(&b.metric));
            series
        }
    };
    Ok(Matrix { series })
}

pub(crate) fn instant_expr(
    source: &dyn SeriesSource,
    expr: &Expr,
    time_ms: i64,
    opts: &EvalOptions,
) -> Result<Value, Error> {
    let steps = Steps { start: time_ms, end: time_ms, step: 1 };
    let ev = Evaluator { src: source, opts: *opts, q_start: time_ms, q_end: time_ms };
    let mut inner = expr;
    while let Expr::Paren(p) = inner {
        inner = &p.expr;
    }
    if matches!(inner, Expr::MatrixSelector(_) | Expr::Subquery(_)) {
        let rv = ev.range_vector(inner, steps)?;
        let e = rv.window_end(time_ms);
        let mut series = Vec::new();
        for s in rv.series {
            let lo = s.ts.partition_point(|&t| t <= e.saturating_sub(rv.range));
            let hi = s.ts.partition_point(|&t| t <= e);
            if hi <= lo {
                continue;
            }
            let metric: Vec<(String, String)> = if opts.delayed_name_removal && s.drop_name {
                s.labels.iter().filter(|(k, _)| !is_metadata_label(k)).cloned().collect()
            } else {
                s.labels.as_ref().clone()
            };
            series.push(MatrixSeries {
                metric,
                points: s.ts[lo..hi].iter().copied().zip(s.vals[lo..hi].iter().copied()).collect(),
            });
        }
        series.sort_by(|a, b| a.metric.cmp(&b.metric));
        if series.windows(2).any(|w| w[0].metric == w[1].metric) {
            return Err(Error::Eval("vector cannot contain metrics with the same labelset".into()));
        }
        return Ok(Value::Matrix(Matrix { series }));
    }
    Ok(match ev.eval(expr, steps)? {
        Val::Scalar(v) => Value::Scalar { t_ms: time_ms, value: v[0] },
        Val::Str(s) => Value::String { t_ms: time_ms, value: s },
        Val::Vector(v) => Value::Vector(
            cleanup(v, opts)?
                .into_iter()
                .filter_map(|(metric, vals)| vals[0].map(|value| VectorSample { metric, t_ms: time_ms, value }))
                .collect(),
        ),
    })
}
