//! `viz-logql`: a LogQL engine with no I/O, no async, no clock and no randomness, so the
//! same code runs natively, as WASM in a Worker, and in a deterministic simulator.
//!
//! A clean-room implementation written from Grafana Loki's public documentation and
//! black-box observation of Loki's behaviour (see `CLEANROOM.md`). Data comes in through
//! [`LogSource`] (shaped like `contracts/LOGS.md`); results go out as [`QueryResult`],
//! which serialises to the `data` object of Loki's HTTP API. Vector aggregations, binary
//! operators, `label_replace` and `vector()` are evaluated by `viz-promql`.
//!
//! ```
//! use viz_logql::{query_range, LogRow, LogStream, MemSource, Options};
//! let src = MemSource::new(vec![LogStream {
//!     labels: vec![("app".into(), "web".into())],
//!     rows: vec![LogRow { ts_ns: 1_000_000_000, line: "level=error msg=boom".into(), metadata: vec![] }],
//! }]);
//! let r = query_range(&src, r#"count_over_time({app="web"} |= "error" [1m])"#, 1_000_000_000, 1_000_000_000, 1_000_000_000, &Options::default()).unwrap();
//! assert!(r.data_json().starts_with(r#"{"resultType":"matrix","result":[{"metric":{"app":"web"},"values":[[1,"1"]]}]"#));
//! ```

pub mod ast;
mod error;
mod eval;
mod goregex;
mod ip;
mod json;
mod jsonwalk;
mod labels;
mod lexer;
mod logfmt;
mod output;
mod parser;
mod pattern;
mod pipeline;
mod source;
pub mod template;
mod text;

pub use ast::{Expr, LineFilterOp, Matcher, MatchOp};
pub use error::Error;
pub use eval::{Data, Direction, Options, QueryResult, SeriesOut, Stats, StreamOut};
pub use output::error_json;
pub use source::{LogRow, LogSource, LogStream, MemSource, SelectRequest};

/// Parse and validate a query.
pub fn parse(query: &str) -> Result<Expr, Error> {
    parser::parse(query)
}

fn grid(start_ns: i64, end_ns: i64, step_ns: i64, opts: &Options) -> Result<eval::Grid, Error> {
    if step_ns <= 0 {
        return Err(Error::Parse {
            msg: "zero or negative query resolution step widths are not accepted. Try a positive integer".into(),
            line: 0,
            col: 0,
        });
    }
    if end_ns < start_ns {
        return Err(Error::Parse { msg: "end timestamp must not be before or equal to start time".into(), line: 0, col: 0 });
    }
    let n = ((end_ns as i128 - start_ns as i128) / step_ns as i128) as u128 + 1;
    if n > opts.max_steps as u128 {
        return Err(Error::Parse {
            msg: format!("exceeded maximum resolution of {} points per timeseries. Try increasing the value of the step parameter", opts.max_steps),
            line: 0,
            col: 0,
        });
    }
    Ok(eval::Grid { start: start_ns, step: step_ns, n: n as usize })
}

/// A range query (`/loki/api/v1/query_range`). Log queries return the entries with
/// `start_ns <= ts < end_ns` (at most `opts.limit`, in `opts.direction`); metric queries are
/// evaluated at `start_ns`, `start_ns + step_ns`, … up to `end_ns`.
pub fn query_range(src: &dyn LogSource, query: &str, start_ns: i64, end_ns: i64, step_ns: i64, opts: &Options) -> Result<QueryResult, Error> {
    match parse(query)? {
        Expr::Log(l) => {
            if end_ns < start_ns {
                return Err(Error::Parse { msg: "end timestamp must not be before or equal to start time".into(), line: 0, col: 0 });
            }
            eval::eval_logs(src, &l, start_ns, end_ns, opts)
        }
        Expr::Metric(m) => eval::eval_metric(src, &m, grid(start_ns, end_ns, step_ns, opts)?, false, opts),
    }
}

/// An instant query (`/loki/api/v1/query`). Only metric queries are accepted, as in Loki's
/// HTTP API.
pub fn query_instant(src: &dyn LogSource, query: &str, time_ns: i64, opts: &Options) -> Result<QueryResult, Error> {
    match parse(query)? {
        Expr::Log(_) => Err(Error::Parse {
            msg: "log queries are not supported as an instant query type, please change your query to a range query type".into(),
            line: 0,
            col: 0,
        }),
        Expr::Metric(m) => eval::eval_metric(src, &m, eval::Grid { start: time_ns, step: 1, n: 1 }, true, opts),
    }
}

/// What one selector of a query reads.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectorInfo {
    pub matchers: Vec<Matcher>,
    /// Inclusive, Unix nanoseconds.
    pub start_ns: i64,
    /// Exclusive, Unix nanoseconds.
    pub end_ns: i64,
    /// Every line the query can use contains, for each clause, at least one of its literals
    /// (`contracts/LOGS.md` §6). Storage may prune with it.
    pub required: Vec<Vec<String>>,
    /// The line filters that run before any stage that rewrites the line, in order. A
    /// storage that applies them itself returns exactly the rows the engine keeps.
    pub line_filters: Vec<ast::LineFilter>,
}

/// The selectors of `query` and what each reads when the query is evaluated from
/// `start_ns` to `end_ns` every `step_ns` (log queries ignore `step_ns`; pass
/// `start_ns == end_ns` for an instant metric query). These are exactly the
/// [`SelectRequest`]s evaluation makes, in order.
pub fn selectors(query: &str, start_ns: i64, end_ns: i64, step_ns: i64) -> Result<Vec<SelectorInfo>, Error> {
    let opts = Options { max_steps: usize::MAX, ..Options::default() };
    let pushable = |stages: &[ast::Stage]| -> Vec<ast::LineFilter> {
        let mut out = Vec::new();
        for s in pipeline::order_stages(stages) {
            match s {
                ast::Stage::LineFilter(f) => out.push(f.clone()),
                ast::Stage::LineFormat(_) | ast::Stage::Unpack | ast::Stage::Decolorize => break,
                _ => {}
            }
        }
        out
    };
    match parse(query)? {
        Expr::Log(l) => Ok(vec![SelectorInfo {
            matchers: l.matchers.clone(),
            start_ns,
            end_ns,
            required: eval::required_clauses(&l.stages),
            line_filters: pushable(&l.stages),
        }]),
        Expr::Metric(m) => {
            let g = if start_ns == end_ns { eval::Grid { start: start_ns, step: 1, n: 1 } } else { grid(start_ns, end_ns, step_ns, &opts)? };
            let mut ranges = Vec::new();
            eval::collect_ranges(&m, &mut ranges);
            Ok(ranges
                .into_iter()
                .filter_map(|r| match r {
                    ast::MetricExpr::Range { range, .. } => {
                        let (lo, hi) = eval::range_bounds(range, &g);
                        Some(SelectorInfo {
                            matchers: range.log.matchers.clone(),
                            start_ns: lo,
                            end_ns: hi,
                            required: eval::required_clauses(&range.log.stages),
                            line_filters: pushable(&range.log.stages),
                        })
                    }
                    _ => None,
                })
                .collect())
        }
    }
}
