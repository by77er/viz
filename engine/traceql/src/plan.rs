//! What a query reads: the read plan handed to storage so it can prune
//! (`contracts/TRACES.md`, "Reads").
//!
//! Every part of a plan is conservative: a source may ignore any of it and return more, and
//! the result is the same. `tests/props.rs` checks that pruning on and off agree.

use crate::ast::*;
use crate::data::{Span, Trace};
use crate::eval::{span_matches, TraceCtx};

/// A column the query reads: an intrinsic, or an attribute by scope and key
/// (`Scope::None` means span attributes, then resource attributes).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Column {
    Intrinsic(Intrinsic),
    Attr(Scope, String),
}

/// A predicate. As a span predicate (`ReadPlan::span_filter`) it is evaluated on one span;
/// as a trace predicate (`ReadPlan::trace_filter`) `Filter(e)` means "some span of the
/// trace matches `e`" and `And`/`Or` combine those existential tests.
#[derive(Clone, Debug, PartialEq)]
pub enum Pred {
    True,
    /// A spanset filter expression, exactly as the query writes it.
    Filter(FieldExpr),
    And(Vec<Pred>),
    Or(Vec<Pred>),
}

impl Pred {
    fn and(a: Pred, b: Pred) -> Pred {
        match (a, b) {
            (Pred::True, x) | (x, Pred::True) => x,
            (a, b) => Pred::And(vec![a, b]),
        }
    }
    fn or(a: Pred, b: Pred) -> Pred {
        match (a, b) {
            (Pred::True, _) | (_, Pred::True) => Pred::True,
            (a, b) => Pred::Or(vec![a, b]),
        }
    }
    /// Evaluates the predicate on a span of a trace.
    pub fn eval(&self, ctx: &mut TraceCtx, i: usize) -> bool {
        match self {
            Pred::True => true,
            Pred::Filter(e) => span_matches(e, ctx, i),
            Pred::And(v) => v.iter().all(|p| p.eval(ctx, i)),
            Pred::Or(v) => v.iter().any(|p| p.eval(ctx, i)),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReadPlan {
    /// Search: traces overlapping `[start, end]` (Unix ns; 0 and `u64::MAX` when unbounded).
    pub trace_window: (u64, u64),
    /// Metrics: only spans starting in `(start, end]` contribute.
    pub span_window: Option<(u64, u64)>,
    /// Whether the span window may drop spans (true when no stage looks at other spans).
    pub span_local: bool,
    pub columns: Vec<Column>,
    /// Spans failing it can be dropped (unless `full_traces`).
    pub span_filter: Pred,
    /// A trace without any span passing it can be dropped.
    pub trace_filter: Pred,
    /// Evaluation needs every span of a candidate trace.
    pub full_traces: bool,
}

impl ReadPlan {
    /// Whether a trace can contribute: it overlaps the search window, has a span in the
    /// metrics window, and satisfies the trace predicate, where `Filter(e)` means "some span
    /// matches e", `And` means all of the parts hold (on possibly different spans), `Or` any.
    pub fn trace_may_match(&self, t: &Trace) -> bool {
        let (ws, we) = self.trace_window;
        if t.summary.end_unix_nano < ws || t.summary.start_unix_nano > we {
            return false;
        }
        if let Some((s, e)) = self.span_window {
            if !t.spans.iter().any(|x| x.start_unix_nano > s && x.start_unix_nano <= e) {
                return false;
            }
        }
        let mut ctx = TraceCtx::new(t);
        trace_ok(&self.trace_filter, &mut ctx)
    }

    pub fn span_may_match(&self, t: &Trace, s: &Span) -> bool {
        if self.full_traces {
            return true;
        }
        if let (Some((ws, we)), true) = (self.span_window, self.span_local) {
            if s.start_unix_nano <= ws || s.start_unix_nano > we {
                return false;
            }
        }
        let Some(i) = t.spans.iter().position(|x| std::ptr::eq(x, s)) else { return true };
        let mut ctx = TraceCtx::new(t);
        self.span_filter.eval(&mut ctx, i)
    }
}

fn trace_ok(p: &Pred, ctx: &mut TraceCtx) -> bool {
    match p {
        Pred::True => true,
        Pred::Filter(e) => (0..ctx.trace.spans.len()).any(|i| span_matches(e, ctx, i)),
        Pred::And(v) => v.iter().all(|q| trace_ok(q, ctx)),
        Pred::Or(v) => v.iter().any(|q| trace_ok(q, ctx)),
    }
}

pub(crate) fn columns_of(e: &FieldExpr, out: &mut Vec<Column>) {
    e.visit(&mut |x| match x {
        FieldExpr::Attr { scope, name } => out.push(Column::Attr(*scope, name.clone())),
        FieldExpr::Intrinsic(i, _) => out.push(Column::Intrinsic(*i)),
        _ => {}
    });
}

fn stage_columns(st: &Stage, out: &mut Vec<Column>) {
    match st {
        Stage::Filter(e) => columns_of(e, out),
        Stage::Op(_, a, b) => {
            stage_columns(a, out);
            stage_columns(b, out);
        }
        Stage::Pipeline(v) => v.iter().for_each(|s| stage_columns(s, out)),
        Stage::ScalarFilter { arg, .. } => {
            if let Some(e) = arg {
                columns_of(e, out)
            }
        }
        Stage::By(v) | Stage::Select(v) => v.iter().for_each(|e| columns_of(e, out)),
        Stage::Coalesce => {}
    }
}

fn needs_full(st: &Stage) -> bool {
    let mut full = false;
    let mut cols = Vec::new();
    stage_columns(st, &mut cols);
    if cols.contains(&Column::Intrinsic(Intrinsic::ChildCount)) {
        full = true;
    }
    fn structural(st: &Stage) -> bool {
        match st {
            Stage::Op(op, a, b) => op.is_structural() || structural(a) || structural(b),
            Stage::Pipeline(v) => v.iter().any(structural),
            _ => false,
        }
    }
    full || structural(st)
}

fn span_local(st: &Stage) -> bool {
    match st {
        Stage::Filter(_) | Stage::By(_) | Stage::Select(_) | Stage::Coalesce => true,
        Stage::Pipeline(v) => v.iter().all(span_local),
        Stage::Op(..) | Stage::ScalarFilter { .. } => false,
    }
}

/// (span predicate, trace predicate) of the spans the first stage can keep.
fn first_need(stages: &[Stage]) -> (Pred, Pred) {
    match stages.first() {
        None => (Pred::True, Pred::True),
        Some(st) => need(st),
    }
}

fn need(st: &Stage) -> (Pred, Pred) {
    match st {
        Stage::Filter(e) => (Pred::Filter(e.clone()), Pred::Filter(e.clone())),
        Stage::Pipeline(v) => first_need(v),
        Stage::Op(op, a, b) => {
            let (sa, ta) = need(a);
            let (sb, tb) = need(b);
            let span = Pred::or(sa, sb);
            let trace = match op {
                SpansetOp::Or => Pred::or(ta, tb),
                SpansetOp::NotChild
                | SpansetOp::NotParent
                | SpansetOp::NotDescendant
                | SpansetOp::NotAncestor
                | SpansetOp::NotSibling => tb,
                _ => Pred::and(ta, tb),
            };
            (span, trace)
        }
        _ => (Pred::True, Pred::True),
    }
}

/// The plan of a search pipeline.
pub fn search_plan(stages: &[Stage], window: (u64, u64)) -> ReadPlan {
    let mut columns = Vec::new();
    stages.iter().for_each(|s| stage_columns(s, &mut columns));
    columns.sort();
    columns.dedup();
    let full = stages.iter().any(needs_full);
    let (span_filter, trace_filter) = first_need(stages);
    ReadPlan {
        trace_window: window,
        span_window: None,
        span_local: stages.iter().all(span_local),
        columns,
        span_filter: if full { Pred::True } else { span_filter },
        trace_filter,
        full_traces: full,
    }
}

/// The plan of a metrics expression over `(start, end]`.
pub fn metrics_plan(m: &MetricsExpr, start: u64, end: u64) -> ReadPlan {
    let mut columns = Vec::new();
    let mut full = false;
    let mut local = true;
    let mut span = None::<Pred>;
    let mut trace = None::<Pred>;
    fn walk(
        m: &MetricsExpr,
        columns: &mut Vec<Column>,
        full: &mut bool,
        local: &mut bool,
        span: &mut Option<Pred>,
        trace: &mut Option<Pred>,
    ) {
        match m {
            MetricsExpr::Query { pipeline, func, by, .. } => {
                pipeline.iter().for_each(|s| stage_columns(s, columns));
                if let Some(e) = func.arg() {
                    columns_of(e, columns);
                }
                by.iter().for_each(|e| columns_of(e, columns));
                *full |= pipeline.iter().any(needs_full)
                    || by.iter().chain(func.arg()).any(|e| {
                        let mut c = Vec::new();
                        columns_of(e, &mut c);
                        c.contains(&Column::Intrinsic(Intrinsic::ChildCount))
                    });
                *local &= pipeline.iter().all(span_local);
                let (s, t) = first_need(pipeline);
                *span = Some(match span.take() {
                    None => s,
                    Some(p) => Pred::or(p, s),
                });
                *trace = Some(match trace.take() {
                    None => t,
                    Some(p) => Pred::or(p, t),
                });
            }
            MetricsExpr::Math { lhs, rhs, .. } => {
                walk(lhs, columns, full, local, span, trace);
                walk(rhs, columns, full, local, span, trace);
            }
            MetricsExpr::Scalar(_) => {}
        }
    }
    walk(m, &mut columns, &mut full, &mut local, &mut span, &mut trace);
    columns.sort();
    columns.dedup();
    let span = span.unwrap_or(Pred::True);
    ReadPlan {
        trace_window: (0, u64::MAX),
        span_window: Some((start, end)),
        span_local: local && !full,
        columns,
        span_filter: if full { Pred::True } else { span },
        trace_filter: trace.unwrap_or(Pred::True),
        full_traces: full,
    }
}
