//! viz-traceql: a clean-room TraceQL engine. Parses and validates TraceQL, plans what a
//! query reads (so storage can prune), and evaluates search and metrics queries over a
//! span source shaped like `contracts/TRACES.md`, producing Tempo's HTTP API JSON.
//!
//! No I/O, no clock, no randomness: the caller passes data and times in.
//! See `README.md` for what is implemented and how it was checked, and `CLEANROOM.md` for
//! how it was written.

pub mod ast;
pub mod data;
mod eval;
mod json;
mod lexer;
pub mod metrics;
mod parser;
pub mod plan;
pub mod value;

use ast::{FieldExpr, Query, RootExpr, Stage, Static};
pub use data::{AttrValue, Event, Kind, Link, MemSource, ServiceStats, Span, SpanSource, Status, Trace, TraceSummary};
use eval::{echo_key, field_value, run_pipeline, Spanset, TraceCtx};
pub use metrics::RangeRequest;
pub use parser::{MAX_DEPTH, MAX_QUERY_BYTES, MAX_REGEXES, REGEX_DFA_SIZE_LIMIT, REGEX_NEST_LIMIT, REGEX_SIZE_LIMIT};
pub use plan::{Column, Pred, ReadPlan};
use value::{hex, hex_trimmed, Val};

/// Errors. `Parse` and `Validation` carry a byte offset and a 1-based line and column.
#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    /// The text is not TraceQL.
    Parse { pos: usize, line: usize, col: usize, msg: String },
    /// Valid syntax that TraceQL rejects (operand types, missing aggregate argument, ...).
    Validation { pos: usize, line: usize, col: usize, msg: String },
    /// A feature this engine does not implement. Never a wrong answer instead.
    Unsupported(String),
    /// Evaluation failed (limits, bad request ranges).
    Eval(String),
    /// The span source failed.
    Source(String),
}

impl Error {
    fn position(src: &str, pos: usize) -> (usize, usize) {
        let pos = pos.min(src.len());
        let before = &src[..floor_char(src, pos)];
        let line = before.matches('\n').count() + 1;
        let col = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
        (line, col)
    }
    pub(crate) fn parse(src: &str, pos: usize, msg: impl Into<String>) -> Error {
        let (line, col) = Error::position(src, pos);
        Error::Parse { pos, line, col, msg: msg.into() }
    }
    pub(crate) fn validation(src: &str, pos: usize, msg: impl Into<String>) -> Error {
        let (line, col) = Error::position(src, pos);
        Error::Validation { pos, line, col, msg: msg.into() }
    }
    pub(crate) fn unsupported(what: impl Into<String>) -> Error {
        Error::Unsupported(format!("not supported: {}", what.into()))
    }
}

fn floor_char(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Parse { line, col, msg, .. } => write!(f, "parse error at line {line}, col {col}: {msg}"),
            Error::Validation { line, col, msg, .. } => write!(f, "invalid query at line {line}, col {col}: {msg}"),
            Error::Unsupported(m) => write!(f, "{m}"),
            Error::Eval(m) => write!(f, "evaluation error: {m}"),
            Error::Source(m) => write!(f, "span source error: {m}"),
        }
    }
}

impl std::error::Error for Error {}

/// Parses and validates a query. Unsupported features are reported here, before any data
/// is read.
pub fn parse(query: &str) -> Result<RootExpr, Error> {
    let root = parser::parse(query)?;
    if root_fields(&root).iter().any(|e| matches!(e, FieldExpr::Intrinsic(ast::Intrinsic::NestedSet, _))) {
        return Err(Error::unsupported("the undocumented nestedSetLeft/nestedSetRight/nestedSetParent intrinsics"));
    }
    for (k, v) in &root.hints {
        if k == "extrapolate" && *v == Static::Bool(true) {
            return Err(Error::unsupported("with(extrapolate=true): sampling weights are not stored yet"));
        }
    }
    Ok(root)
}

/// Every attribute and intrinsic a query references.
pub fn root_fields(root: &RootExpr) -> Vec<FieldExpr> {
    let mut out = Vec::new();
    fn stage(st: &Stage, out: &mut Vec<FieldExpr>) {
        let mut add = |e: &FieldExpr| {
            e.visit(&mut |x| {
                if matches!(x, FieldExpr::Attr { .. } | FieldExpr::Intrinsic(..)) {
                    out.push(x.clone())
                }
            })
        };
        match st {
            Stage::Filter(e) => add(e),
            Stage::Op(_, a, b) => {
                stage(a, out);
                stage(b, out);
            }
            Stage::Pipeline(v) => v.iter().for_each(|s| stage(s, out)),
            Stage::ScalarFilter { arg, .. } => {
                if let Some(e) = arg {
                    add(e)
                }
            }
            Stage::By(v) | Stage::Select(v) => v.iter().for_each(|e| add(e)),
            Stage::Coalesce => {}
        }
    }
    fn metrics(m: &ast::MetricsExpr, out: &mut Vec<FieldExpr>) {
        match m {
            ast::MetricsExpr::Query { pipeline, func, by, .. } => {
                pipeline.iter().for_each(|s| stage(s, out));
                let mut add = |e: &FieldExpr| {
                    e.visit(&mut |x| {
                        if matches!(x, FieldExpr::Attr { .. } | FieldExpr::Intrinsic(..)) {
                            out.push(x.clone())
                        }
                    })
                };
                if let Some(e) = func.arg() {
                    add(e)
                }
                by.iter().for_each(|e| add(e));
            }
            ast::MetricsExpr::Math { lhs, rhs, .. } => {
                metrics(lhs, out);
                metrics(rhs, out);
            }
            ast::MetricsExpr::Scalar(_) => {}
        }
    }
    match &root.query {
        Query::Search(st) => st.iter().for_each(|s| stage(s, &mut out)),
        Query::Metrics(m) => metrics(m, &mut out),
    }
    out
}

/// Statistics of one evaluation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub inspected_traces: u64,
    pub inspected_spans: u64,
}

/// A search request. Times are Unix nanoseconds; `0`/`0` means no time bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchRequest {
    /// Maximum traces returned (Tempo's `limit`, default 20).
    pub limit: u32,
    /// Maximum spans listed per spanset (Tempo's `spss`, default 3). `matched` still counts all.
    pub spans_per_spanset: u32,
    pub start_unix_nano: u64,
    pub end_unix_nano: u64,
}

impl Default for SearchRequest {
    fn default() -> Self {
        SearchRequest { limit: 20, spans_per_spanset: 3, start_unix_nano: 0, end_unix_nano: 0 }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SpanResult {
    pub span_id: String,
    pub name: String,
    pub start_unix_nano: u64,
    pub duration_nanos: u64,
    pub attributes: Vec<(String, Val<'static>)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SpansetResult {
    pub spans: Vec<SpanResult>,
    pub matched: u32,
    pub attributes: Vec<(String, Val<'static>)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TraceResult {
    pub trace_id: String,
    pub root_service_name: String,
    pub root_trace_name: String,
    pub start_unix_nano: u64,
    pub duration_ms: u32,
    pub spansets: Vec<SpansetResult>,
    pub service_stats: Vec<ServiceStats>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SearchResponse {
    pub traces: Vec<TraceResult>,
    pub stats: Stats,
}

impl SearchResponse {
    /// The body of Tempo's `/api/search`.
    pub fn to_json(&self) -> String {
        json::search_json(self)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MetricsResponse {
    pub series: Vec<metrics::Series>,
    pub request: RangeRequest,
    pub stats: Stats,
}

impl MetricsResponse {
    /// The body of Tempo's `/api/metrics/query_range` (and `/api/metrics/query`).
    pub fn to_json(&self) -> String {
        json::metrics_json(&self.series, &self.request, &self.stats)
    }
}

/// Limits for an evaluation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_series: usize,
    pub max_points: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_series: 10_000, max_points: 11_000 }
    }
}

/// What a query reads, without touching data: columns, time range, span and trace
/// predicates, and whether whole traces are needed. For a search, `start`/`end` are the
/// request's window (0/0 for none); for a metrics query, the range.
pub fn plan(query: &str, start_unix_nano: u64, end_unix_nano: u64) -> Result<ReadPlan, Error> {
    let root = parse(query)?;
    Ok(plan_root(&root, start_unix_nano, end_unix_nano))
}

fn search_window(start: u64, end: u64) -> (u64, u64) {
    if start == 0 && end == 0 {
        (0, u64::MAX)
    } else {
        (start, if end == 0 { u64::MAX } else { end })
    }
}

fn plan_root(root: &RootExpr, start: u64, end: u64) -> ReadPlan {
    match &root.query {
        Query::Search(stages) => plan::search_plan(stages, search_window(start, end)),
        Query::Metrics(m) => plan::metrics_plan(m, start, end),
    }
}

/// Runs a search query.
pub fn search(src: &dyn SpanSource, query: &str, req: &SearchRequest) -> Result<SearchResponse, Error> {
    let root = parse(query)?;
    let Query::Search(stages) = &root.query else {
        return Err(Error::Eval("a metrics query cannot be run as a search; use query_range".into()));
    };
    let plan = plan_root(&root, req.start_unix_nano, req.end_unix_nano);
    let window = plan.trace_window;
    let limit = if req.limit == 0 { 20 } else { req.limit as usize };
    let spss = if req.spans_per_spanset == 0 { 3 } else { req.spans_per_spanset as usize };
    let echo = echo_fields(stages);
    let mut found: Vec<TraceResult> = Vec::new();
    let mut stats = Stats::default();
    src.traces(&plan, &mut |t: &Trace| {
        stats.inspected_traces += 1;
        stats.inspected_spans += t.spans.len() as u64;
        if t.summary.end_unix_nano < window.0 || t.summary.start_unix_nano > window.1 {
            return Ok(());
        }
        let mut ctx = TraceCtx::new(t);
        let all = Spanset { spans: (0..t.spans.len()).collect(), attrs: Vec::new() };
        let sets = run_pipeline(stages, &mut ctx, vec![all]);
        if sets.is_empty() {
            return Ok(());
        }
        found.push(trace_result(&mut ctx, sets, &echo, spss));
        if found.len() >= limit.saturating_mul(4).max(64) {
            sort_and_cut(&mut found, limit);
        }
        Ok(())
    })?;
    sort_and_cut(&mut found, limit);
    Ok(SearchResponse { traces: found, stats })
}

/// Most recent first (by trace start), then by trace id, so results do not depend on the
/// order the source returns traces in.
fn sort_and_cut(v: &mut Vec<TraceResult>, limit: usize) {
    v.sort_by(|a, b| b.start_unix_nano.cmp(&a.start_unix_nano).then_with(|| a.trace_id.cmp(&b.trace_id)));
    v.truncate(limit);
}

fn echo_fields(stages: &[Stage]) -> Vec<(String, FieldExpr)> {
    let mut out: Vec<(String, FieldExpr)> = Vec::new();
    let mut add = |e: &FieldExpr| {
        e.visit(&mut |x| {
            if let Some(k) = echo_key(x) {
                if !out.iter().any(|(kk, _)| *kk == k) {
                    out.push((k, x.clone()));
                }
            }
        })
    };
    fn walk(st: &Stage, add: &mut dyn FnMut(&FieldExpr)) {
        match st {
            Stage::Filter(e) => add(e),
            Stage::Op(_, a, b) => {
                walk(a, add);
                walk(b, add);
            }
            Stage::Pipeline(v) => v.iter().for_each(|s| walk(s, add)),
            Stage::ScalarFilter { arg, .. } => {
                if let Some(e) = arg {
                    add(e)
                }
            }
            Stage::By(v) | Stage::Select(v) => v.iter().for_each(|e| add(e)),
            Stage::Coalesce => {}
        }
    }
    stages.iter().for_each(|s| walk(s, &mut add));
    out
}

fn trace_result(ctx: &mut TraceCtx, sets: Vec<Spanset>, echo: &[(String, FieldExpr)], spss: usize) -> TraceResult {
    let t = ctx.trace;
    let mut spansets = Vec::with_capacity(sets.len());
    for ss in sets {
        let mut idx = ss.spans.clone();
        idx.sort_by(|&a, &b| {
            let (x, y) = (&t.spans[a], &t.spans[b]);
            x.start_unix_nano.cmp(&y.start_unix_nano).then_with(|| x.span_id.cmp(&y.span_id))
        });
        let matched = idx.len() as u32;
        let spans = idx
            .into_iter()
            .take(spss)
            .map(|i| {
                let s = &t.spans[i];
                let mut attributes = Vec::new();
                for (k, e) in echo {
                    let v = field_value(e, ctx, i).into_owned();
                    if !v.is_nil() {
                        attributes.push((k.clone(), v));
                    }
                }
                SpanResult {
                    span_id: hex(&s.span_id),
                    name: s.name.clone(),
                    start_unix_nano: s.start_unix_nano,
                    duration_nanos: s.duration(),
                    attributes,
                }
            })
            .collect();
        let attributes = ss.attrs.into_iter().map(|(k, v)| (k, if v.is_nil() { Val::Str("nil".to_string().into()) } else { v })).collect();
        spansets.push(SpansetResult { spans, matched, attributes });
    }
    // Spansets in a fixed order (by their first span, then size, then attributes), so the
    // answer does not depend on the order the source returned spans in.
    spansets.sort_by(|a: &SpansetResult, b: &SpansetResult| {
        let key = |s: &SpansetResult| (s.spans.first().map(|x| (x.start_unix_nano, x.span_id.clone())), s.matched, format!("{:?}", s.attributes));
        key(a).cmp(&key(b))
    });
    let sum = &t.summary;
    let (root_service_name, root_trace_name) = match &sum.root {
        Some((s, n)) => (s.clone().unwrap_or_default(), n.clone()),
        None => (String::new(), String::new()),
    };
    TraceResult {
        trace_id: hex_trimmed(&t.trace_id),
        root_service_name,
        root_trace_name,
        start_unix_nano: sum.start_unix_nano,
        duration_ms: u32::try_from(sum.end_unix_nano.saturating_sub(sum.start_unix_nano) / 1_000_000).unwrap_or(u32::MAX),
        spansets,
        service_stats: sum.services.clone(),
    }
}

/// Runs a metrics query over `(start, end]` at `step` (`RangeRequest`), with default limits.
pub fn query_range(src: &dyn SpanSource, query: &str, req: &RangeRequest) -> Result<MetricsResponse, Error> {
    query_range_with(src, query, req, &Limits::default())
}

pub fn query_range_with(src: &dyn SpanSource, query: &str, req: &RangeRequest, limits: &Limits) -> Result<MetricsResponse, Error> {
    let root = parse(query)?;
    let Query::Metrics(m) = &root.query else {
        return Err(Error::Eval("not a metrics query: add a metrics function such as | rate()".into()));
    };
    let plan = plan_root(&root, req.start_unix_nano, req.end_unix_nano);
    let (series, stats) = metrics::evaluate(src, m, &plan, req, limits.max_series, limits.max_points)?;
    Ok(MetricsResponse { series, request: *req, stats })
}

/// An instant metrics query: one value over `(start, end]`, at `end`.
pub fn query_instant(src: &dyn SpanSource, query: &str, start_unix_nano: u64, end_unix_nano: u64) -> Result<MetricsResponse, Error> {
    query_range(src, query, &RangeRequest::instant(start_unix_nano, end_unix_nano))
}

/// The request alignment Tempo's query frontend applies to range queries (observed by
/// running Tempo; README): the start moves down to a multiple of the step and then one
/// step further back, the end moves up to a multiple of the step. A request whose range is
/// exactly one step (an instant query) is left alone.
pub fn align_request(req: &RangeRequest) -> RangeRequest {
    let s = req.step_nano;
    if s == 0 || req.instant || req.end_unix_nano.saturating_sub(req.start_unix_nano) == s {
        return *req;
    }
    let start = (req.start_unix_nano / s) * s;
    let end = req.end_unix_nano.div_ceil(s).saturating_mul(s);
    RangeRequest { start_unix_nano: start.saturating_sub(s), end_unix_nano: end, step_nano: s, instant: false }
}

/// Evaluates the spanset pipeline of a search query on one trace and returns the matched
/// span indices of each spanset (for tests and for storage-side checks).
pub fn matching_spansets(query: &str, trace: &Trace) -> Result<Vec<Vec<usize>>, Error> {
    let root = parse(query)?;
    let Query::Search(stages) = &root.query else {
        return Err(Error::Eval("not a search query".into()));
    };
    let mut ctx = TraceCtx::new(trace);
    let all = Spanset { spans: (0..trace.spans.len()).collect(), attrs: Vec::new() };
    Ok(run_pipeline(stages, &mut ctx, vec![all]).into_iter().map(|s| s.spans).collect())
}
