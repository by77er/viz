//! Evaluation of spanset pipelines over one trace at a time.
//!
//! A query is evaluated per trace. The pipeline starts with one spanset holding every span
//! the source returned for the trace; each stage maps a list of spansets to a list of
//! spansets. The trace is a result if the final list is non-empty.

use std::borrow::Cow;
use std::collections::HashMap;

use crate::ast::*;
use crate::data::{attr, AttrValue, Event, Link, Span, Trace};
use crate::value::{arith, compare, go_duration, hex, hex_trimmed, regex_match, typed_match, Val};

/// One spanset: indices into the trace's spans, and the attributes the pipeline attached
/// (`count()`, `by(...)`).
#[derive(Clone, Debug, Default)]
pub struct Spanset {
    pub spans: Vec<usize>,
    pub attrs: Vec<(String, Val<'static>)>,
}

/// Per-trace structure, computed lazily: parent index of each span (by span id), and which
/// spans are connected to a root. Structural operators consider connected spans only: a
/// span whose parent is missing from the trace, and its descendants, take no part in them
/// (Tempo's observed behaviour; README, "Differential run").
pub struct TraceCtx<'a> {
    pub trace: &'a Trace,
    parent: Option<Vec<Option<usize>>>,
    connected: Option<Vec<bool>>,
    child_count: Option<Vec<i64>>,
}

impl<'a> TraceCtx<'a> {
    pub fn new(trace: &'a Trace) -> TraceCtx<'a> {
        TraceCtx { trace, parent: None, connected: None, child_count: None }
    }

    fn parents(&mut self) -> &Vec<Option<usize>> {
        if self.parent.is_none() {
            let spans = &self.trace.spans;
            let mut idx: HashMap<[u8; 8], usize> = HashMap::with_capacity(spans.len());
            for (i, s) in spans.iter().enumerate() {
                idx.entry(s.span_id).or_insert(i);
            }
            let p = spans.iter().map(|s| s.parent_span_id.and_then(|p| idx.get(&p).copied())).collect();
            self.parent = Some(p);
        }
        self.parent.as_ref().map_or_else(|| unreachable_empty(), |p| p)
    }

    fn connected(&mut self) -> Vec<bool> {
        if self.connected.is_none() {
            let parents = self.parents().clone();
            let spans = &self.trace.spans;
            let n = spans.len();
            // 0 unknown, 1 connected, 2 not connected; resolved iteratively (no recursion).
            let mut state = vec![0u8; n];
            for start in 0..n {
                if state[start] != 0 {
                    continue;
                }
                let mut path = Vec::new();
                let mut cur = start;
                let verdict = loop {
                    if state[cur] != 0 {
                        break state[cur];
                    }
                    if spans[cur].parent_span_id.is_none() {
                        break 1;
                    }
                    match parents[cur] {
                        None => break 2,
                        Some(p) => {
                            if path.len() > n {
                                break 2; // a cycle
                            }
                            path.push(cur);
                            cur = p;
                        }
                    }
                };
                if state[cur] == 0 {
                    state[cur] = verdict;
                }
                for p in path {
                    state[p] = verdict;
                }
                state[start] = if state[start] == 0 { verdict } else { state[start] };
            }
            self.connected = Some(state.into_iter().map(|s| s == 1).collect());
        }
        self.connected.clone().unwrap_or_default()
    }

    fn child_counts(&mut self) -> &Vec<i64> {
        if self.child_count.is_none() {
            let parents = self.parents().clone();
            let mut c = vec![0i64; parents.len()];
            for p in parents.into_iter().flatten() {
                c[p] += 1;
            }
            self.child_count = Some(c);
        }
        self.child_count.as_ref().map_or_else(|| unreachable_empty_i(), |c| c)
    }
}

fn unreachable_empty() -> &'static Vec<Option<usize>> {
    static EMPTY: Vec<Option<usize>> = Vec::new();
    &EMPTY
}
fn unreachable_empty_i() -> &'static Vec<i64> {
    static EMPTY: Vec<i64> = Vec::new();
    &EMPTY
}

/// The event and link a field expression is evaluated against.
#[derive(Clone, Copy, Default)]
struct Binding<'a> {
    event: Option<&'a Event>,
    link: Option<&'a Link>,
}

fn uses_scope(e: &FieldExpr, event: bool) -> bool {
    let mut found = false;
    e.visit(&mut |x| match x {
        FieldExpr::Attr { scope: Scope::Event, .. } if event => found = true,
        FieldExpr::Attr { scope: Scope::Link, .. } if !event => found = true,
        FieldExpr::Intrinsic(Intrinsic::EventName | Intrinsic::EventTimeSinceStart, _) if event => found = true,
        FieldExpr::Intrinsic(Intrinsic::LinkSpanId | Intrinsic::LinkTraceId, _) if !event => found = true,
        _ => {}
    });
    found
}

/// Is the span matched by the filter? Event- and link-scoped fields are evaluated per event
/// (and link): the span matches if one event makes the whole expression true.
pub fn span_matches(e: &FieldExpr, ctx: &mut TraceCtx, i: usize) -> bool {
    let trace = ctx.trace;
    let span = &trace.spans[i];
    let ev = uses_scope(e, true);
    let lk = uses_scope(e, false);
    let events: Vec<Option<&Event>> =
        if ev && !span.events.is_empty() { span.events.iter().map(Some).collect() } else { vec![None] };
    let links: Vec<Option<&Link>> =
        if lk && !span.links.is_empty() { span.links.iter().map(Some).collect() } else { vec![None] };
    for e1 in &events {
        for l1 in &links {
            let b = Binding { event: *e1, link: *l1 };
            if matches!(eval(e, ctx, i, b), Val::Bool(true)) {
                return true;
            }
        }
    }
    false
}

/// The value of a field expression for a span (first event and link bound, if any).
pub fn field_value<'a, 't: 'a>(e: &'a FieldExpr, ctx: &mut TraceCtx<'t>, i: usize) -> Val<'a> {
    let trace: &'t Trace = ctx.trace;
    let span = &trace.spans[i];
    let b = Binding { event: span.events.first(), link: span.links.first() };
    eval(e, ctx, i, b)
}

fn lookup<'a>(span: &'a Span, scope: Scope, name: &str, b: Binding<'a>) -> Option<&'a AttrValue> {
    match scope {
        Scope::Span => attr(&span.attrs, name),
        Scope::Resource => attr(&span.resource, name),
        Scope::Event => b.event.and_then(|e| attr(&e.attrs, name)),
        Scope::Link => b.link.and_then(|l| attr(&l.attrs, name)),
        Scope::Instrumentation => attr(&span.scope_attrs, name),
        Scope::None => attr(&span.attrs, name).or_else(|| attr(&span.resource, name)),
    }
}

static EMPTY_STR: AttrValue = AttrValue::Str(String::new());

fn attr_val<'a>(span: &'a Span, scope: Scope, name: &str, b: Binding<'a>) -> Val<'a> {
    match lookup(span, scope, name, b) {
        Some(v) => Val::from_attr(v),
        // `resource.service.name` always exists in Tempo: an absent one reads as "".
        None if name == "service.name" && matches!(scope, Scope::Resource | Scope::None) => Val::from_attr(&EMPTY_STR),
        None => Val::Nil,
    }
}

/// For `attr op literal`: the attribute's value, preferring (for `.name`) a scope whose
/// value has the literal's type.
fn attr_for_literal<'a>(span: &'a Span, scope: Scope, name: &str, lit: &Val, b: Binding<'a>) -> Val<'a> {
    if scope == Scope::None && !lit.is_nil() {
        let s = attr(&span.attrs, name).map(Val::from_attr);
        let r = attr(&span.resource, name).map(Val::from_attr);
        for v in [s, r].into_iter().flatten() {
            if same_kind(&v, lit) {
                return v;
            }
        }
    }
    attr_val(span, scope, name, b)
}

fn same_kind(v: &Val, lit: &Val) -> bool {
    let k = |x: &Val| match x {
        Val::Int(_) => 1,
        Val::Float(_) => 2,
        Val::Str(_) => 3,
        Val::Bool(_) => 4,
        _ => 0,
    };
    match v {
        Val::Arr(a) => {
            let ek = match a {
                AttrValue::IntArray(_) => 1,
                AttrValue::FloatArray(_) => 2,
                AttrValue::StrArray(_) => 3,
                AttrValue::BoolArray(_) => 4,
                _ => 0,
            };
            ek != 0 && ek == k(lit)
        }
        _ => k(v) != 0 && k(v) == k(lit),
    }
}

fn is_id(i: Intrinsic) -> bool {
    matches!(i, Intrinsic::SpanId | Intrinsic::ParentId | Intrinsic::TraceId | Intrinsic::LinkSpanId | Intrinsic::LinkTraceId)
}

fn eval<'a, 't: 'a>(e: &'a FieldExpr, ctx: &mut TraceCtx<'t>, i: usize, b: Binding<'t>) -> Val<'a> {
    let trace: &'t Trace = ctx.trace;
    match e {
        FieldExpr::Static(s) => Val::from_static(s),
        FieldExpr::Attr { scope, name } => attr_val(&trace.spans[i], *scope, name, b),
        FieldExpr::Intrinsic(intr, _) => intrinsic(*intr, ctx, i, b),
        FieldExpr::Unary(UnOp::Neg, x) => match eval(x, ctx, i, b) {
            Val::Int(v) => v.checked_neg().map_or(Val::Nil, Val::Int),
            Val::Float(v) => Val::Float(-v),
            Val::Duration(v) => v.checked_neg().map_or(Val::Nil, Val::Duration),
            _ => Val::Nil,
        },
        FieldExpr::Unary(UnOp::Not, x) => match eval(x, ctx, i, b) {
            Val::Bool(v) => Val::Bool(!v),
            _ => Val::Nil,
        },
        FieldExpr::Regex { lhs, re, negated, .. } => {
            let v = eval(lhs, ctx, i, b);
            Val::Bool(regex_match(&v, re, *negated))
        }
        FieldExpr::Binary(op, l, r) => match op {
            BinOp::And => {
                let a = matches!(eval(l, ctx, i, b), Val::Bool(true));
                Val::Bool(a && matches!(eval(r, ctx, i, b), Val::Bool(true)))
            }
            BinOp::Or => {
                let a = matches!(eval(l, ctx, i, b), Val::Bool(true));
                Val::Bool(a || matches!(eval(r, ctx, i, b), Val::Bool(true)))
            }
            op if op.is_arith() => {
                let x = eval(l, ctx, i, b);
                let y = eval(r, ctx, i, b);
                arith(*op, &x, &y)
            }
            op => {
                // attribute op literal: typed (see value.rs).
                match (&**l, &**r) {
                    (FieldExpr::Attr { scope, name }, FieldExpr::Static(s)) => {
                        let lit = Val::from_static(s);
                        let v = attr_for_literal(&trace.spans[i], *scope, name, &lit, b);
                        return Val::Bool(typed_match(&v, *op, &lit));
                    }
                    (FieldExpr::Static(s), FieldExpr::Attr { scope, name }) => {
                        let lit = Val::from_static(s);
                        let v = attr_for_literal(&trace.spans[i], *scope, name, &lit, b);
                        return Val::Bool(typed_match(&v, flip(*op), &lit));
                    }
                    (FieldExpr::Intrinsic(intr, _), FieldExpr::Static(Static::Str(s)))
                    | (FieldExpr::Static(Static::Str(s)), FieldExpr::Intrinsic(intr, _))
                        if is_id(*intr) && matches!(op, BinOp::Eq | BinOp::Neq) =>
                    {
                        let v = intrinsic(*intr, ctx, i, b);
                        let Val::Str(id) = v else { return Val::Bool(false) };
                        let eq = id.trim_start_matches('0').eq_ignore_ascii_case(s.trim_start_matches('0'));
                        return Val::Bool(if *op == BinOp::Eq { eq } else { !eq });
                    }
                    _ => {}
                }
                let x = eval(l, ctx, i, b);
                let y = eval(r, ctx, i, b);
                Val::Bool(compare(&x, *op, &y))
            }
        },
    }
}

fn flip(op: BinOp) -> BinOp {
    match op {
        BinOp::Lt => BinOp::Gt,
        BinOp::Lte => BinOp::Gte,
        BinOp::Gt => BinOp::Lt,
        BinOp::Gte => BinOp::Lte,
        o => o,
    }
}

fn intrinsic<'a, 't: 'a>(intr: Intrinsic, ctx: &mut TraceCtx<'t>, i: usize, b: Binding<'t>) -> Val<'a> {
    let trace: &'t Trace = ctx.trace;
    let span = &trace.spans[i];
    match intr {
        Intrinsic::Name => Val::Str(Cow::Borrowed(&span.name)),
        Intrinsic::Status => Val::Status(span.status),
        Intrinsic::StatusMessage => Val::Str(Cow::Borrowed(&span.status_message)),
        Intrinsic::Duration => Val::Duration(i64::try_from(span.duration()).unwrap_or(i64::MAX)),
        Intrinsic::Kind => Val::Kind(span.kind),
        Intrinsic::SpanId => Val::Str(Cow::Owned(hex(&span.span_id))),
        Intrinsic::ParentId => Val::Str(Cow::Owned(hex(&span.parent_span_id.unwrap_or([0; 8])))),
        Intrinsic::ChildCount => Val::Int(ctx.child_counts().get(i).copied().unwrap_or(0)),
        Intrinsic::TraceDuration => {
            let s = &trace.summary;
            Val::Duration(i64::try_from(s.end_unix_nano.saturating_sub(s.start_unix_nano)).unwrap_or(i64::MAX))
        }
        Intrinsic::TraceRootName => match &trace.summary.root {
            Some((_, n)) => Val::Str(Cow::Borrowed(n)),
            None => Val::Nil,
        },
        Intrinsic::TraceRootService => match &trace.summary.root {
            Some((s, _)) => Val::Str(Cow::Borrowed(s.as_deref().unwrap_or(""))),
            None => Val::Nil,
        },
        Intrinsic::TraceId => Val::Str(Cow::Owned(hex(&trace.trace_id))),
        Intrinsic::EventName => b.event.map_or(Val::Nil, |e| Val::Str(Cow::Borrowed(&e.name))),
        Intrinsic::EventTimeSinceStart => b.event.map_or(Val::Nil, |e| {
            Val::Duration((e.time_unix_nano as i128 - span.start_unix_nano as i128).clamp(i64::MIN as i128, i64::MAX as i128) as i64)
        }),
        Intrinsic::LinkSpanId => b.link.map_or(Val::Nil, |l| Val::Str(Cow::Owned(hex(&l.span_id)))),
        Intrinsic::LinkTraceId => b.link.map_or(Val::Nil, |l| Val::Str(Cow::Owned(hex_trimmed(&l.trace_id)))),
        Intrinsic::InstrumentationName => Val::Str(Cow::Borrowed(&span.scope_name)),
        Intrinsic::InstrumentationVersion => Val::Str(Cow::Borrowed(&span.scope_version)),
    }
}

// ------------------------------------------------------------------ pipelines

pub fn run_pipeline(stages: &[Stage], ctx: &mut TraceCtx, input: Vec<Spanset>) -> Vec<Spanset> {
    let mut sets = input;
    for st in stages {
        if sets.is_empty() {
            break;
        }
        sets = run_stage(st, ctx, sets);
    }
    sets
}

fn run_stage(st: &Stage, ctx: &mut TraceCtx, input: Vec<Spanset>) -> Vec<Spanset> {
    match st {
        Stage::Filter(e) => {
            let mut out = Vec::with_capacity(input.len());
            for mut ss in input {
                ss.spans.retain(|&i| span_matches(e, ctx, i));
                if !ss.spans.is_empty() {
                    out.push(ss);
                }
            }
            out
        }
        Stage::Pipeline(stages) => run_pipeline(stages, ctx, input),
        Stage::Op(op, l, r) => {
            let mut out = Vec::new();
            for ss in input {
                let ls = run_stage(l, ctx, vec![ss.clone()]);
                let rs = run_stage(r, ctx, vec![ss]);
                if let Some(s) = spanset_op(*op, ctx, &ls, &rs) {
                    out.push(s);
                }
            }
            out
        }
        Stage::ScalarFilter { agg, arg, op, value } => {
            let lit = Val::from_static(value);
            let mut out = Vec::new();
            for mut ss in input {
                let v = aggregate(*agg, arg.as_ref(), ctx, &ss.spans);
                if compare(&v, *op, &lit) {
                    let key = format!("{}({})", agg.name(), arg.as_ref().map(expr_text).unwrap_or_default());
                    set_attr(&mut ss.attrs, key, v.into_owned());
                    out.push(ss);
                }
            }
            out
        }
        Stage::By(exprs) => {
            let mut out = Vec::new();
            for ss in input {
                let mut groups: Vec<(Vec<Val<'static>>, Vec<usize>)> = Vec::new();
                for &i in &ss.spans {
                    let key: Vec<Val<'static>> = exprs.iter().map(|e| group_value(e, ctx, i)).collect();
                    match groups.iter_mut().find(|(k, _)| vals_equal(k, &key)) {
                        Some((_, v)) => v.push(i),
                        None => groups.push((key, vec![i])),
                    }
                }
                for (key, spans) in groups {
                    let mut attrs = ss.attrs.clone();
                    for (e, v) in exprs.iter().zip(key) {
                        set_attr(&mut attrs, format!("by({})", expr_text(e)), v);
                    }
                    out.push(Spanset { spans, attrs });
                }
            }
            out
        }
        Stage::Coalesce => {
            let mut all = Vec::new();
            for ss in input {
                for i in ss.spans {
                    if !all.contains(&i) {
                        all.push(i);
                    }
                }
            }
            if all.is_empty() {
                Vec::new()
            } else {
                vec![Spanset { spans: all, attrs: Vec::new() }]
            }
        }
        Stage::Select(_) => input,
    }
}

fn set_attr(attrs: &mut Vec<(String, Val<'static>)>, key: String, v: Val<'static>) {
    match attrs.iter_mut().find(|(k, _)| *k == key) {
        Some(slot) => slot.1 = v,
        None => attrs.push((key, v)),
    }
}

fn vals_equal(a: &[Val], b: &[Val]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| match (x, y) {
            (Val::Float(p), Val::Float(q)) => p.to_bits() == q.to_bits(),
            _ => x == y,
        })
}

/// The value a span groups under in `by()` (arrays and other values group as nil).
pub fn group_value(e: &FieldExpr, ctx: &mut TraceCtx, i: usize) -> Val<'static> {
    let v = match e {
        // A boolean expression groups spans where it is false or undefined together.
        FieldExpr::Binary(op, ..) if op.is_cmp() || matches!(op, BinOp::And | BinOp::Or) => {
            Val::Bool(span_matches(e, ctx, i))
        }
        FieldExpr::Regex { .. } => Val::Bool(span_matches(e, ctx, i)),
        _ => field_value(e, ctx, i).into_owned(),
    };
    v
}

fn spanset_op(op: SpansetOp, ctx: &mut TraceCtx, ls: &[Spanset], rs: &[Spanset]) -> Option<Spanset> {
    let union = |sets: &[Spanset]| {
        let mut v: Vec<usize> = Vec::new();
        for s in sets {
            for &i in &s.spans {
                if !v.contains(&i) {
                    v.push(i);
                }
            }
        }
        v
    };
    let l = union(ls);
    let r = union(rs);
    let spans: Vec<usize> = match op {
        SpansetOp::And => {
            if l.is_empty() || r.is_empty() {
                return None;
            }
            let mut v = l;
            for i in r {
                if !v.contains(&i) {
                    v.push(i);
                }
            }
            v
        }
        SpansetOp::Or => {
            let mut v = l;
            for i in r {
                if !v.contains(&i) {
                    v.push(i);
                }
            }
            v
        }
        _ => structural(op, ctx, &l, &r),
    };
    if spans.is_empty() {
        None
    } else {
        Some(Spanset { spans, attrs: Vec::new() })
    }
}

/// Structural operators over connected spans (see [`TraceCtx`]).
fn structural(op: SpansetOp, ctx: &mut TraceCtx, l: &[usize], r: &[usize]) -> Vec<usize> {
    let connected = ctx.connected();
    let parents = ctx.parents().clone();
    let spans = &ctx.trace.spans;
    let l: Vec<usize> = l.iter().copied().filter(|&i| connected[i]).collect();
    let r: Vec<usize> = r.iter().copied().filter(|&i| connected[i]).collect();
    let mut lset = vec![false; spans.len()];
    for &i in &l {
        lset[i] = true;
    }
    let mut rset = vec![false; spans.len()];
    for &i in &r {
        rset[i] = true;
    }
    let is_ancestor = |a: usize, mut d: usize| -> bool {
        let mut steps = 0;
        while let Some(p) = parents[d] {
            if p == a {
                return true;
            }
            d = p;
            steps += 1;
            if steps > spans.len() {
                return false;
            }
        }
        false
    };
    let sibling = |a: usize, b: usize| -> bool {
        a != b
            && match (spans[a].parent_span_id, spans[b].parent_span_id) {
                (None, None) => true,
                (Some(x), Some(y)) => x == y,
                _ => false,
            }
    };
    // rel(a, b): b relates to a as the operator says ("b is a child of a", ...).
    let rel = |a: usize, b: usize| -> bool {
        match op {
            SpansetOp::Child | SpansetOp::NotChild | SpansetOp::UnionChild => parents[b] == Some(a),
            SpansetOp::Parent | SpansetOp::NotParent | SpansetOp::UnionParent => parents[a] == Some(b),
            SpansetOp::Descendant | SpansetOp::NotDescendant | SpansetOp::UnionDescendant => is_ancestor(a, b),
            SpansetOp::Ancestor | SpansetOp::NotAncestor | SpansetOp::UnionAncestor => is_ancestor(b, a),
            SpansetOp::Sibling | SpansetOp::NotSibling | SpansetOp::UnionSibling => sibling(a, b),
            SpansetOp::And | SpansetOp::Or => false,
        }
    };
    let mut out = Vec::new();
    match op {
        SpansetOp::Child | SpansetOp::Parent | SpansetOp::Descendant | SpansetOp::Ancestor | SpansetOp::Sibling => {
            for &b in &r {
                if l.iter().any(|&a| rel(a, b)) {
                    out.push(b);
                }
            }
        }
        SpansetOp::NotChild | SpansetOp::NotParent | SpansetOp::NotDescendant | SpansetOp::NotAncestor | SpansetOp::NotSibling => {
            for &b in &r {
                if !l.iter().any(|&a| rel(a, b)) {
                    out.push(b);
                }
            }
        }
        _ => {
            let mut used_l = vec![false; spans.len()];
            for &b in &r {
                let mut any = false;
                for &a in &l {
                    if rel(a, b) {
                        any = true;
                        used_l[a] = true;
                    }
                }
                if any {
                    out.push(b);
                }
            }
            for &a in &l {
                if used_l[a] && !out.contains(&a) {
                    out.push(a);
                }
            }
        }
    }
    let _ = (lset, rset);
    out
}

/// The value of an aggregate over a spanset. Values that are not numbers (or are missing)
/// are skipped; `count()` counts spans.
pub fn aggregate(op: AggOp, arg: Option<&FieldExpr>, ctx: &mut TraceCtx, spans: &[usize]) -> Val<'static> {
    if op == AggOp::Count {
        return Val::Int(spans.len() as i64);
    }
    let Some(arg) = arg else { return Val::Nil };
    let mut vals: Vec<Val<'static>> = Vec::new();
    for &i in spans {
        let v = field_value(arg, ctx, i).into_owned();
        if matches!(v, Val::Int(_) | Val::Float(_) | Val::Duration(_)) {
            vals.push(v);
        }
    }
    if vals.is_empty() {
        return Val::Nil;
    }
    let all_int = vals.iter().all(|v| matches!(v, Val::Int(_)));
    let all_dur = vals.iter().all(|v| matches!(v, Val::Duration(_)));
    match op {
        AggOp::Sum => {
            if all_int || all_dur {
                let mut s: i64 = 0;
                for v in &vals {
                    if let Val::Int(x) | Val::Duration(x) = v {
                        s = s.saturating_add(*x);
                    }
                }
                if all_dur {
                    Val::Duration(s)
                } else {
                    Val::Int(s)
                }
            } else {
                Val::Float(vals.iter().filter_map(|v| v.num()).sum())
            }
        }
        AggOp::Avg => {
            let s: f64 = vals.iter().filter_map(|v| v.num()).sum();
            let a = s / vals.len() as f64;
            if all_dur {
                Val::Duration(a as i64)
            } else {
                Val::Float(a)
            }
        }
        AggOp::Min | AggOp::Max => {
            let mut best = vals[0].clone();
            for v in &vals[1..] {
                let better = match crate::value::order(v, &best) {
                    Some(std::cmp::Ordering::Less) => op == AggOp::Min,
                    Some(std::cmp::Ordering::Greater) => op == AggOp::Max,
                    _ => false,
                };
                if better {
                    best = v.clone();
                }
            }
            best
        }
        AggOp::Count => Val::Int(spans.len() as i64),
    }
}

// ------------------------------------------------------------------ text of expressions

/// The text Tempo uses for an expression in result keys: `by(resource.service.name)`,
/// `avg(.n)`, `by(.n > 3)`.
pub fn expr_text(e: &FieldExpr) -> String {
    match e {
        FieldExpr::Static(s) => static_text(s),
        FieldExpr::Attr { scope, name } => {
            let n = if needs_quotes(name) { format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\"")) } else { name.clone() };
            match scope {
                Scope::None => format!(".{n}"),
                s => format!("{}.{n}", s.prefix()),
            }
        }
        FieldExpr::Intrinsic(_, text) => text.clone(),
        FieldExpr::Unary(UnOp::Neg, x) => format!("-{}", wrapped(x)),
        FieldExpr::Unary(UnOp::Not, x) => format!("!{}", wrapped(x)),
        FieldExpr::Binary(op, a, b) => format!("{} {} {}", wrapped(a), op.text(), wrapped(b)),
        FieldExpr::Regex { lhs, negated, text, .. } => {
            format!("{} {} {}", wrapped(lhs), if *negated { "!~" } else { "=~" }, static_text(&Static::Str(text.clone())))
        }
    }
}

fn wrapped(e: &FieldExpr) -> String {
    match e {
        FieldExpr::Binary(..) | FieldExpr::Regex { .. } => format!("({})", expr_text(e)),
        _ => expr_text(e),
    }
}

fn needs_quotes(name: &str) -> bool {
    name.chars().any(|c| c.is_whitespace() || "{}()=~!<>&|^,\"+-*/%".contains(c))
}

fn static_text(s: &Static) -> String {
    match s {
        Static::Nil => "nil".into(),
        Static::Bool(b) => b.to_string(),
        Static::Int(v) => v.to_string(),
        Static::Float(v) => format_float(*v),
        Static::Str(s) => format!("{s:?}"),
        Static::Duration(d) => go_duration(*d),
        Static::Status(s) => s.name().into(),
        Static::Kind(k) => k.name().into(),
    }
}

/// Shortest decimal that round-trips, without an exponent (`0.5`, `100`, `1e-9` as `0.000000001`).
pub fn format_float(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "+Inf".into() } else { "-Inf".into() };
    }
    let s = format!("{v}");
    s
}

/// The key under which a referenced field is echoed on result spans, or `None` for fields
/// that have their own place in the result (name, duration, ids, trace-level values).
pub fn echo_key(e: &FieldExpr) -> Option<String> {
    match e {
        FieldExpr::Attr { name, .. } => Some(name.clone()),
        FieldExpr::Intrinsic(i, _) => match i {
            Intrinsic::Status => Some("status".into()),
            Intrinsic::Kind => Some("kind".into()),
            Intrinsic::StatusMessage => Some("statusMessage".into()),
            Intrinsic::ParentId => Some("span:parentID".into()),
            Intrinsic::ChildCount => Some("span:childCount".into()),
            Intrinsic::EventName => Some("event:name".into()),
            Intrinsic::EventTimeSinceStart => Some("event:timeSinceStart".into()),
            Intrinsic::LinkSpanId => Some("link:spanID".into()),
            Intrinsic::LinkTraceId => Some("link:traceID".into()),
            Intrinsic::InstrumentationName => Some("instrumentation:name".into()),
            Intrinsic::InstrumentationVersion => Some("instrumentation:version".into()),
            _ => None,
        },
        _ => None,
    }
}
