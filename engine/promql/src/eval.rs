//! The evaluator. Follows the structure of Prometheus' `promql/engine.go`:
//! every node is evaluated for all steps at once ("matrix at a time"), an
//! instant query being a range query with one step.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use promql_parser::label::Matchers;
use promql_parser::parser::token::{self, TokenType};
use promql_parser::parser::{
    AggregateExpr, AtModifier, BinaryExpr, Call, Expr, LabelModifier, MatrixSelector, Offset, SubqueryExpr,
    VectorMatchCardinality, VectorSelector,
};

use crate::functions::{self as f, Window};
use crate::types::*;

/// Engine settings. `Default` gives Prometheus' defaults.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EvalOptions {
    /// How far back an instant selector looks for a sample. Default 5 minutes.
    pub lookback_delta_ms: i64,
    /// Prometheus' `promql-delayed-name-removal` feature: keep `__name__`
    /// until the end of evaluation instead of dropping it at each function.
    /// Off by default, as in Prometheus. The upstream test corpus runs with it on.
    pub delayed_name_removal: bool,
    /// Resolution of a subquery written without one (`[5m:]`). Prometheus
    /// uses the global evaluation interval; default 1 minute.
    pub subquery_default_step_ms: i64,
}

impl Default for EvalOptions {
    fn default() -> Self {
        EvalOptions { lookback_delta_ms: 300_000, delayed_name_removal: false, subquery_default_step_ms: 60_000 }
    }
}

/// Evaluation timestamps: `start, start+step, ... <= end`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Steps {
    pub start: i64,
    pub end: i64,
    pub step: i64,
}

impl Steps {
    pub fn n(&self) -> usize {
        if self.end < self.start {
            0
        } else {
            ((self.end - self.start) / self.step) as usize + 1
        }
    }
    pub fn ts(&self, i: usize) -> i64 {
        self.start + i as i64 * self.step
    }
    pub fn last(&self) -> i64 {
        self.ts(self.n().saturating_sub(1))
    }
}

/// One output series: a value (or none) per step.
#[derive(Debug, Clone)]
pub(crate) struct SeriesV {
    pub labels: Labels,
    /// Set when `__name__` must be removed at the end (delayed name removal).
    pub drop_name: bool,
    pub vals: Vec<Option<f64>>,
}

/// One series of a range vector.
#[derive(Debug, Clone)]
pub(crate) struct RSeries {
    pub labels: Labels,
    pub drop_name: bool,
    pub ts: Vec<i64>,
    pub vals: Vec<f64>,
}

/// A range vector: samples plus the rule that maps a step to its window.
pub(crate) struct RangeVec {
    pub series: Vec<RSeries>,
    pub range: i64,
    pub offset: i64,
    pub at: Option<i64>,
}

impl RangeVec {
    /// Inclusive right edge of the window for evaluation time `ts`.
    pub fn window_end(&self, ts: i64) -> i64 {
        self.at.unwrap_or(ts) - self.offset
    }
}

pub(crate) enum Val {
    Scalar(Vec<f64>),
    Vector(Vec<SeriesV>),
    Str(String),
}

pub(crate) fn offset_ms(o: &Option<Offset>) -> i64 {
    match o {
        None => 0,
        Some(Offset::Pos(d)) => d.as_millis() as i64,
        Some(Offset::Neg(d)) => -(d.as_millis() as i64),
    }
}

pub(crate) fn dur_ms(d: &Duration) -> i64 {
    d.as_millis() as i64
}

pub(crate) fn convert_matchers(name: &Option<String>, m: &Matchers) -> Result<Vec<Matcher>, Error> {
    if !m.or_matchers.is_empty() {
        return Err(Error::Unsupported("`or` inside label matchers".into()));
    }
    let mut out = Vec::new();
    if let Some(n) = name {
        out.push(Matcher::new(NAME_LABEL, MatchOp::Eq, n.clone()));
    }
    for x in &m.matchers {
        use promql_parser::label::MatchOp as P;
        let op = match &x.op {
            P::Equal => MatchOp::Eq,
            P::NotEqual => MatchOp::Ne,
            P::Re(_) => MatchOp::Re,
            P::NotRe(_) => MatchOp::Nre,
        };
        out.push(Matcher::new(x.name.clone(), op, x.value.clone()));
    }
    Ok(out)
}

fn unwrap_paren(e: &Expr) -> &Expr {
    let mut e = e;
    while let Expr::Paren(p) = e {
        e = &p.expr;
    }
    e
}

fn dup_err() -> Error {
    Error::Eval("vector cannot contain metrics with the same labelset".into())
}

fn fmt_labels(l: &[(String, String)]) -> String {
    let name = label_get(l, NAME_LABEL);
    let rest: Vec<String> = l.iter().filter(|(n, _)| n != NAME_LABEL).map(|(n, v)| format!("{n}={v:?}")).collect();
    format!("{name}{{{}}}", rest.join(", "))
}

/// Collects per-step results into series, as `rangeEval` does.
struct OutBuilder {
    nsteps: usize,
    no_merge: bool,
    idx: HashMap<Labels, usize>,
    out: Vec<SeriesV>,
}

impl OutBuilder {
    fn new(nsteps: usize, delayed: bool) -> Self {
        // An instant query with delayed name removal defers the duplicate
        // check to the end of the evaluation.
        OutBuilder { nsteps, no_merge: nsteps == 1 && delayed, idx: HashMap::new(), out: Vec::new() }
    }

    fn push(&mut self, step: usize, labels: &Labels, drop_name: bool, v: f64) -> Result<(), Error> {
        if !self.no_merge {
            if let Some(&i) = self.idx.get(labels) {
                if self.out[i].vals[step].is_some() {
                    return Err(dup_err());
                }
                self.out[i].vals[step] = Some(v);
                return Ok(());
            }
            self.idx.insert(labels.clone(), self.out.len());
        }
        let mut vals = vec![None; self.nsteps];
        vals[step] = Some(v);
        self.out.push(SeriesV { labels: labels.clone(), drop_name, vals });
        Ok(())
    }
}

pub(crate) struct Evaluator<'a> {
    pub src: &'a dyn SeriesSource,
    pub opts: EvalOptions,
    /// Start and end of the top-level query, for `@ start()` / `@ end()`.
    pub q_start: i64,
    pub q_end: i64,
}

pub(crate) fn at_ms(at: &Option<AtModifier>, q_start: i64, q_end: i64) -> Option<i64> {
    match at {
        None => None,
        Some(AtModifier::Start) => Some(q_start),
        Some(AtModifier::End) => Some(q_end),
        Some(AtModifier::At(t)) => Some(match t.duration_since(UNIX_EPOCH) {
            Ok(d) => (d.as_secs_f64() * 1000.0).round() as i64,
            Err(e) => -((e.duration().as_secs_f64() * 1000.0).round() as i64),
        }),
    }
}

/// Timestamps of the inner evaluation of a subquery, and the range vector
/// geometry, shared by the evaluator and by `selectors()`.
pub(crate) fn subquery_steps(sq: &SubqueryExpr, outer: Steps, opts: &EvalOptions, q_start: i64, q_end: i64) -> Steps {
    let offset = offset_ms(&sq.offset);
    let range = dur_ms(&sq.range);
    let interval = sq.step.as_ref().map(dur_ms).filter(|s| *s > 0).unwrap_or(opts.subquery_default_step_ms);
    let (first_end, last_end) = match at_ms(&sq.at, q_start, q_end) {
        Some(a) => (a - offset, a - offset),
        None => (outer.start - offset, outer.last() - offset),
    };
    // First multiple of the interval strictly after the left edge.
    let left = first_end - range;
    let mut start = interval * left.div_euclid(interval);
    if start <= left {
        start += interval;
    }
    Steps { start, end: last_end, step: interval }
}

/// The `[min, max]` sample range a selector needs for the given steps.
pub(crate) fn selector_range(
    vs: &VectorSelector,
    range: Option<i64>,
    steps: Steps,
    opts: &EvalOptions,
    q_start: i64,
    q_end: i64,
) -> (i64, i64) {
    let offset = offset_ms(&vs.offset);
    let (first, last) = match at_ms(&vs.at, q_start, q_end) {
        Some(a) => (a - offset, a - offset),
        None => (steps.start - offset, steps.last() - offset),
    };
    let back = range.unwrap_or(opts.lookback_delta_ms);
    // Windows are left-open: (ref - back, ref].
    (first - back + 1, last)
}

struct AggGroup {
    seen: bool,
    value: f64,
    mean: f64,
    c: f64,
    count: f64,
    incremental: bool,
    heap: Vec<f64>,
}

impl<'a> Evaluator<'a> {
    fn delayed(&self) -> bool {
        self.opts.delayed_name_removal
    }

    /// Labels after an operation that changes what the value means.
    fn drop_name(&self, l: &Labels) -> Labels {
        if self.delayed() || !l.iter().any(|(n, _)| is_metadata_label(n)) {
            l.clone()
        } else {
            Arc::new(l.iter().filter(|(n, _)| !is_metadata_label(n)).cloned().collect())
        }
    }

    /// Merge series that ended up with equal label sets; error if they
    /// collide at a step.
    fn merge_dups(&self, v: Vec<SeriesV>, nsteps: usize) -> Result<Vec<SeriesV>, Error> {
        let no_merge = nsteps == 1 && self.delayed();
        let mut idx: HashMap<Labels, usize> = HashMap::new();
        let mut out: Vec<SeriesV> = Vec::with_capacity(v.len());
        for s in v {
            if s.vals.iter().all(|x| x.is_none()) {
                continue;
            }
            if no_merge {
                out.push(s);
                continue;
            }
            match idx.get(&s.labels) {
                None => {
                    idx.insert(s.labels.clone(), out.len());
                    out.push(s);
                }
                Some(&i) => {
                    for (k, x) in s.vals.iter().enumerate() {
                        if x.is_some() {
                            if out[i].vals[k].is_some() {
                                return Err(dup_err());
                            }
                            out[i].vals[k] = *x;
                        }
                    }
                }
            }
        }
        Ok(out)
    }

    pub fn eval(&self, expr: &Expr, steps: Steps) -> Result<Val, Error> {
        let n = steps.n();
        match expr {
            Expr::NumberLiteral(x) => Ok(Val::Scalar(vec![x.val; n])),
            Expr::StringLiteral(s) => Ok(Val::Str(s.val.clone())),
            Expr::Paren(p) => self.eval(&p.expr, steps),
            Expr::VectorSelector(vs) => {
                let pts = self.select_points(vs, steps)?;
                Ok(Val::Vector(
                    pts.into_iter()
                        .map(|(labels, p)| SeriesV {
                            labels,
                            drop_name: false,
                            vals: p.into_iter().map(|x| x.map(|(_, v)| v)).collect(),
                        })
                        .collect(),
                ))
            }
            Expr::MatrixSelector(_) | Expr::Subquery(_) => {
                Err(Error::Eval("range vector is only allowed as a function argument or at the top level of an instant query".into()))
            }
            Expr::Unary(u) => match self.eval(&u.expr, steps)? {
                Val::Scalar(v) => Ok(Val::Scalar(v.into_iter().map(|x| -x).collect())),
                Val::Vector(v) => {
                    let out = v
                        .into_iter()
                        .map(|s| SeriesV {
                            labels: self.drop_name(&s.labels),
                            drop_name: true,
                            vals: s.vals.into_iter().map(|x| x.map(|x| -x)).collect(),
                        })
                        .collect();
                    Ok(Val::Vector(self.merge_dups(out, n)?))
                }
                Val::Str(_) => Err(Error::Eval("unary expression only allowed on scalar or instant vector".into())),
            },
            Expr::Binary(b) => self.eval_binary(b, steps),
            Expr::Aggregate(a) => self.eval_aggregate(a, steps),
            Expr::Call(c) => self.eval_call(c, steps),
            Expr::Extension(_) => Err(Error::Unsupported("extension expression".into())),
        }
    }

    fn eval_scalar(&self, e: &Expr, steps: Steps) -> Result<Vec<f64>, Error> {
        match self.eval(e, steps)? {
            Val::Scalar(v) => Ok(v),
            _ => Err(Error::Eval("expected a scalar argument".into())),
        }
    }

    fn eval_vector(&self, e: &Expr, steps: Steps) -> Result<Vec<SeriesV>, Error> {
        match self.eval(e, steps)? {
            Val::Vector(v) => Ok(v),
            _ => Err(Error::Eval("expected an instant vector argument".into())),
        }
    }

    fn string_arg(e: &Expr) -> Result<String, Error> {
        match unwrap_paren(e) {
            Expr::StringLiteral(s) => Ok(s.val.clone()),
            _ => Err(Error::Eval("expected a string argument".into())),
        }
    }

    fn select_sorted(&self, matchers: &[Matcher], min: i64, max: i64) -> Result<Vec<Series>, Error> {
        let mut series = self.src.select(matchers, min, max)?;
        for s in &mut series {
            if !s.labels.windows(2).all(|w| w[0].0 < w[1].0) {
                s.labels.sort();
            }
        }
        // Sorting makes results independent of the order the source returns.
        series.sort_by(|a, b| a.labels.cmp(&b.labels));
        Ok(series)
    }

    /// Instant vector selection: per series and step, the newest sample in
    /// `(ref - lookback, ref]`, unless it is a staleness marker.
    fn select_points(&self, vs: &VectorSelector, steps: Steps) -> Result<Vec<(Labels, Vec<Option<(i64, f64)>>)>, Error> {
        let n = steps.n();
        if n == 0 {
            return Ok(vec![]);
        }
        let matchers = convert_matchers(&vs.name, &vs.matchers)?;
        let (min, max) = selector_range(vs, None, steps, &self.opts, self.q_start, self.q_end);
        let series = self.select_sorted(&matchers, min, max)?;
        let offset = offset_ms(&vs.offset);
        let at = at_ms(&vs.at, self.q_start, self.q_end);
        let lookback = self.opts.lookback_delta_ms;
        let mut out = Vec::with_capacity(series.len());
        for s in series {
            let pick = |r: i64| -> Option<(i64, f64)> {
                let i = s.ts.partition_point(|&t| t <= r);
                if i == 0 {
                    return None;
                }
                let (t, v) = (s.ts[i - 1], s.values[i - 1]);
                if t <= r - lookback || is_stale_nan(v) {
                    return None;
                }
                Some((t, v))
            };
            let pts: Vec<Option<(i64, f64)>> = match at {
                Some(a) => vec![pick(a - offset); n],
                None => (0..n).map(|i| pick(steps.ts(i) - offset)).collect(),
            };
            if pts.iter().any(|p| p.is_some()) {
                out.push((Arc::new(s.labels), pts));
            }
        }
        Ok(out)
    }

    fn matrix_selector(&self, ms: &MatrixSelector, steps: Steps) -> Result<RangeVec, Error> {
        let vs = &ms.vs;
        let range = dur_ms(&ms.range);
        let offset = offset_ms(&vs.offset);
        let at = at_ms(&vs.at, self.q_start, self.q_end);
        if steps.n() == 0 {
            return Ok(RangeVec { series: vec![], range, offset, at });
        }
        let matchers = convert_matchers(&vs.name, &vs.matchers)?;
        let (min, max) = selector_range(vs, Some(range), steps, &self.opts, self.q_start, self.q_end);
        let series = self.select_sorted(&matchers, min, max)?;
        let series = series
            .into_iter()
            .map(|s| {
                // Staleness markers never appear inside a range vector.
                let mut ts = Vec::with_capacity(s.ts.len());
                let mut vals = Vec::with_capacity(s.ts.len());
                for (t, v) in s.ts.iter().zip(s.values.iter()) {
                    if !is_stale_nan(*v) {
                        ts.push(*t);
                        vals.push(*v);
                    }
                }
                RSeries { labels: Arc::new(s.labels), drop_name: false, ts, vals }
            })
            .collect();
        Ok(RangeVec { series, range, offset, at })
    }

    fn subquery(&self, sq: &SubqueryExpr, steps: Steps) -> Result<RangeVec, Error> {
        let inner = subquery_steps(sq, steps, &self.opts, self.q_start, self.q_end);
        let range = dur_ms(&sq.range);
        let offset = offset_ms(&sq.offset);
        let at = at_ms(&sq.at, self.q_start, self.q_end);
        if steps.n() == 0 || inner.n() == 0 {
            return Ok(RangeVec { series: vec![], range, offset, at });
        }
        let v = match self.eval(&sq.expr, inner)? {
            Val::Vector(v) => v,
            Val::Scalar(vals) => {
                vec![SeriesV { labels: Arc::new(vec![]), drop_name: false, vals: vals.into_iter().map(Some).collect() }]
            }
            Val::Str(_) => return Err(Error::Eval("subquery is only allowed on instant vector".into())),
        };
        let series = v
            .into_iter()
            .map(|s| {
                let mut ts = Vec::new();
                let mut vals = Vec::new();
                for (i, x) in s.vals.iter().enumerate() {
                    if let Some(x) = x {
                        ts.push(inner.ts(i));
                        vals.push(*x);
                    }
                }
                RSeries { labels: s.labels, drop_name: s.drop_name, ts, vals }
            })
            .collect();
        Ok(RangeVec { series, range, offset, at })
    }

    pub fn range_vector(&self, e: &Expr, steps: Steps) -> Result<RangeVec, Error> {
        match unwrap_paren(e) {
            Expr::MatrixSelector(ms) => self.matrix_selector(ms, steps),
            Expr::Subquery(sq) => self.subquery(sq, steps),
            _ => Err(Error::Eval("expected a range vector argument".into())),
        }
    }

    // ---------------------------------------------------------------- calls

    fn eval_call(&self, c: &Call, steps: Steps) -> Result<Val, Error> {
        let name = c.func.name;
        let args: Vec<&Expr> = c.args.args.iter().map(|a| a.as_ref()).collect();
        let n = steps.n();

        let simple = |fun: &dyn Fn(f64) -> f64| -> Result<Val, Error> {
            let v = self.eval_vector(args[0], steps)?;
            self.map_values(v, n, |_, x| Some(fun(x)))
        };

        match name {
            // ---- range-vector functions
            "rate" | "increase" | "delta" | "irate" | "idelta" | "resets" | "changes" | "avg_over_time"
            | "sum_over_time" | "min_over_time" | "max_over_time" | "count_over_time" | "last_over_time"
            | "first_over_time" | "stddev_over_time" | "stdvar_over_time" | "quantile_over_time"
            | "present_over_time" | "mad_over_time" | "ts_of_min_over_time" | "ts_of_max_over_time"
            | "ts_of_first_over_time" | "ts_of_last_over_time" | "deriv" | "predict_linear"
            | "double_exponential_smoothing" | "absent_over_time" => self.eval_range_fn(name, &args, steps),

            // ---- element-wise math
            "abs" => simple(&f64::abs),
            "ceil" => simple(&f64::ceil),
            "floor" => simple(&f64::floor),
            "exp" => simple(&f64::exp),
            "sqrt" => simple(&f64::sqrt),
            "ln" => simple(&f64::ln),
            "log2" => simple(&f64::log2),
            "log10" => simple(&f64::log10),
            "sin" => simple(&f64::sin),
            "cos" => simple(&f64::cos),
            "tan" => simple(&f64::tan),
            "asin" => simple(&f64::asin),
            "acos" => simple(&f64::acos),
            "atan" => simple(&f64::atan),
            "sinh" => simple(&f64::sinh),
            "cosh" => simple(&f64::cosh),
            "tanh" => simple(&f64::tanh),
            "asinh" => simple(&f64::asinh),
            "acosh" => simple(&f64::acosh),
            "atanh" => simple(&f64::atanh),
            "rad" => simple(&|x| x * std::f64::consts::PI / 180.0),
            "deg" => simple(&|x| x * 180.0 / std::f64::consts::PI),
            "sgn" => simple(&|x| {
                if x < 0.0 {
                    -1.0
                } else if x > 0.0 {
                    1.0
                } else {
                    x
                }
            }),
            "round" => {
                let v = self.eval_vector(args[0], steps)?;
                let nearest = if args.len() >= 2 { self.eval_scalar(args[1], steps)? } else { vec![1.0; n] };
                self.map_values(v, n, |i, x| {
                    let inv = 1.0 / nearest[i];
                    Some((x * inv + 0.5).floor() / inv)
                })
            }
            "clamp" => {
                let v = self.eval_vector(args[0], steps)?;
                let lo = self.eval_scalar(args[1], steps)?;
                let hi = self.eval_scalar(args[2], steps)?;
                self.map_values(v, n, |i, x| if hi[i] < lo[i] { None } else { Some(go_max(lo[i], go_min(hi[i], x))) })
            }
            "clamp_min" => {
                let v = self.eval_vector(args[0], steps)?;
                let lo = self.eval_scalar(args[1], steps)?;
                self.map_values(v, n, |i, x| Some(go_max(lo[i], x)))
            }
            "clamp_max" => {
                let v = self.eval_vector(args[0], steps)?;
                let hi = self.eval_scalar(args[1], steps)?;
                self.map_values(v, n, |i, x| Some(go_min(hi[i], x)))
            }

            // ---- scalar / vector plumbing
            "time" => Ok(Val::Scalar((0..n).map(|i| steps.ts(i) as f64 / 1000.0).collect())),
            "pi" => Ok(Val::Scalar(vec![std::f64::consts::PI; n])),
            "scalar" => {
                let v = self.eval_vector(args[0], steps)?;
                let mut out = vec![f64::NAN; n];
                for (i, o) in out.iter_mut().enumerate() {
                    let mut found = None;
                    let mut many = false;
                    for s in &v {
                        if let Some(x) = s.vals[i] {
                            if found.is_some() {
                                many = true;
                                break;
                            }
                            found = Some(x);
                        }
                    }
                    if let (Some(x), false) = (found, many) {
                        *o = x;
                    }
                }
                Ok(Val::Scalar(out))
            }
            "vector" => {
                let s = self.eval_scalar(args[0], steps)?;
                if n == 0 {
                    return Ok(Val::Vector(vec![]));
                }
                Ok(Val::Vector(vec![SeriesV {
                    labels: Arc::new(vec![]),
                    drop_name: false,
                    vals: s.into_iter().map(Some).collect(),
                }]))
            }
            "timestamp" => {
                if let Expr::VectorSelector(vs) = unwrap_paren(args[0]) {
                    // The timestamp of the selected sample, not of the step.
                    let pts = self.select_points(vs, steps)?;
                    let out = pts
                        .into_iter()
                        .map(|(labels, p)| SeriesV {
                            labels: self.drop_name(&labels),
                            drop_name: true,
                            vals: p.into_iter().map(|x| x.map(|(t, _)| t as f64 / 1000.0)).collect(),
                        })
                        .collect();
                    return Ok(Val::Vector(self.merge_dups(out, n)?));
                }
                let v = self.eval_vector(args[0], steps)?;
                self.map_values(v, n, |i, _| Some(steps.ts(i) as f64 / 1000.0))
            }
            "absent" => {
                let v = self.eval_vector(args[0], steps)?;
                let vals: Vec<Option<f64>> =
                    (0..n).map(|i| if v.iter().any(|s| s.vals[i].is_some()) { None } else { Some(1.0) }).collect();
                if vals.iter().all(|x| x.is_none()) {
                    return Ok(Val::Vector(vec![]));
                }
                Ok(Val::Vector(vec![SeriesV { labels: absent_labels(args[0])?, drop_name: false, vals }]))
            }
            "sort" | "sort_desc" => {
                let mut v = self.eval_vector(args[0], steps)?;
                if n == 1 {
                    let desc = name == "sort_desc";
                    v.retain(|s| s.vals[0].is_some());
                    v.sort_by(|a, b| {
                        let (x, y) = (a.vals[0].unwrap_or(f64::NAN), b.vals[0].unwrap_or(f64::NAN));
                        cmp_nan_last(x, y, desc)
                    });
                }
                Ok(Val::Vector(v))
            }
            "sort_by_label" | "sort_by_label_desc" => {
                let mut v = self.eval_vector(args[0], steps)?;
                let lbls: Vec<String> = args[1..].iter().map(|a| Self::string_arg(a)).collect::<Result<_, _>>()?;
                let desc = name == "sort_by_label_desc";
                if n == 1 {
                    v.sort_by(|a, b| {
                        use std::cmp::Ordering::*;
                        for l in &lbls {
                            let (x, y) = (label_get(&a.labels, l), label_get(&b.labels, l));
                            if x == y {
                                continue;
                            }
                            let less = f::natural_less(x, y);
                            return if less != desc { Less } else { Greater };
                        }
                        let c = a.labels.cmp(&b.labels);
                        if desc {
                            c.reverse()
                        } else {
                            c
                        }
                    });
                }
                Ok(Val::Vector(v))
            }
            "label_replace" => {
                let mut v = self.eval_vector(args[0], steps)?;
                let dst = Self::string_arg(args[1])?;
                let repl = Self::string_arg(args[2])?;
                let src = Self::string_arg(args[3])?;
                let re_s = Self::string_arg(args[4])?;
                let re = regex::Regex::new(&format!("^(?s:{re_s})$"))
                    .map_err(|_| Error::Eval(format!("invalid regular expression in label_replace(): {re_s}")))?;
                if dst.is_empty() {
                    return Err(Error::Eval(format!("invalid destination label name in label_replace(): {dst}")));
                }
                for s in v.iter_mut() {
                    let src_val = label_get(&s.labels, &src).to_string();
                    if let Some(caps) = re.captures(&src_val) {
                        let mut res = String::new();
                        caps.expand(&repl, &mut res);
                        s.labels = set_label(&s.labels, &dst, &res);
                        if dst == NAME_LABEL {
                            s.drop_name = false;
                        }
                    }
                }
                check_unique(&v)?;
                Ok(Val::Vector(v))
            }
            "label_join" => {
                let mut v = self.eval_vector(args[0], steps)?;
                let dst = Self::string_arg(args[1])?;
                let sep = Self::string_arg(args[2])?;
                let srcs: Vec<String> = args[3..].iter().map(|a| Self::string_arg(a)).collect::<Result<_, _>>()?;
                if srcs.iter().any(|s| s.is_empty()) {
                    return Err(Error::Eval("invalid source label name in label_join()".into()));
                }
                if dst.is_empty() {
                    return Err(Error::Eval(format!("invalid destination label name in label_join(): {dst}")));
                }
                for s in v.iter_mut() {
                    let joined: Vec<&str> = srcs.iter().map(|l| label_get(&s.labels, l)).collect();
                    let joined = joined.join(&sep);
                    s.labels = set_label(&s.labels, &dst, &joined);
                    if dst == NAME_LABEL {
                        s.drop_name = false;
                    }
                }
                check_unique(&v)?;
                Ok(Val::Vector(v))
            }
            "histogram_quantile" => {
                let q = self.eval_scalar(args[0], steps)?;
                let v = self.eval_vector(args[1], steps)?;
                self.histogram_quantile(&q, v, n)
            }
            "days_in_month" | "day_of_month" | "day_of_week" | "day_of_year" | "hour" | "minute" | "month" | "year" => {
                let fun = |secs: f64| -> f64 {
                    let c = f::civil_from_unix(secs as i64);
                    match name {
                        "days_in_month" => f::days_in_month(c.year, c.month) as f64,
                        "day_of_month" => c.day as f64,
                        "day_of_week" => c.weekday as f64,
                        "day_of_year" => c.yday as f64,
                        "hour" => c.hour as f64,
                        "minute" => c.minute as f64,
                        "month" => c.month as f64,
                        _ => c.year as f64,
                    }
                };
                if args.is_empty() {
                    if n == 0 {
                        return Ok(Val::Vector(vec![]));
                    }
                    return Ok(Val::Vector(vec![SeriesV {
                        labels: Arc::new(vec![]),
                        drop_name: false,
                        vals: (0..n).map(|i| Some(fun((steps.ts(i).div_euclid(1000)) as f64))).collect(),
                    }]));
                }
                let v = self.eval_vector(args[0], steps)?;
                self.map_values(v, n, |_, x| Some(fun(x)))
            }
            other => Err(Error::Unsupported(format!("function {other}()"))),
        }
    }

    /// Apply a per-sample function; the metric name is dropped.
    fn map_values(&self, v: Vec<SeriesV>, n: usize, fun: impl Fn(usize, f64) -> Option<f64>) -> Result<Val, Error> {
        let out = v
            .into_iter()
            .map(|s| SeriesV {
                labels: self.drop_name(&s.labels),
                drop_name: true,
                vals: s.vals.iter().enumerate().map(|(i, x)| x.and_then(|x| fun(i, x))).collect(),
            })
            .collect();
        Ok(Val::Vector(self.merge_dups(out, n)?))
    }

    fn eval_range_fn(&self, name: &str, args: &[&Expr], steps: Steps) -> Result<Val, Error> {
        let n = steps.n();
        // Which argument is the range vector, and the scalar parameters.
        let (rv_idx, scalar_idx): (usize, Vec<usize>) = match name {
            "quantile_over_time" => (1, vec![0]),
            "predict_linear" => (0, vec![1]),
            "double_exponential_smoothing" => (0, vec![1, 2]),
            _ => (0, vec![]),
        };
        let params: Vec<Vec<f64>> =
            scalar_idx.iter().map(|&i| self.eval_scalar(args[i], steps)).collect::<Result<_, _>>()?;
        let rv = self.range_vector(args[rv_idx], steps)?;

        if name == "double_exponential_smoothing" {
            for i in 0..n {
                let (sf, tf) = (params[0][i], params[1][i]);
                if sf <= 0.0 || sf >= 1.0 {
                    return Err(Error::Eval(format!("invalid smoothing factor. Expected: 0 < sf < 1, got: {sf}")));
                }
                if tf <= 0.0 || tf >= 1.0 {
                    return Err(Error::Eval(format!("invalid trend factor. Expected: 0 < tf < 1, got: {tf}")));
                }
            }
        }

        let kernel = |w: &Window, i: usize| -> Option<f64> {
            match name {
                "rate" => f::extrapolated_rate(w, true, true),
                "increase" => f::extrapolated_rate(w, true, false),
                "delta" => f::extrapolated_rate(w, false, false),
                "irate" => f::instant_value(w, true),
                "idelta" => f::instant_value(w, false),
                "resets" => Some(f::resets(w)),
                "changes" => Some(f::changes(w)),
                "avg_over_time" => Some(f::avg_over_time(w.vals)),
                "sum_over_time" => Some(f::sum_over_time(w.vals)),
                "min_over_time" => Some(f::compare_over_time(w, |c, cur| c < cur || cur.is_nan()).0),
                "max_over_time" => Some(f::compare_over_time(w, |c, cur| c > cur || cur.is_nan()).0),
                "ts_of_min_over_time" => {
                    Some(f::compare_over_time(w, |c, cur| c <= cur || cur.is_nan()).1 as f64 / 1000.0)
                }
                "ts_of_max_over_time" => {
                    Some(f::compare_over_time(w, |c, cur| c >= cur || cur.is_nan()).1 as f64 / 1000.0)
                }
                "ts_of_first_over_time" => Some(w.ts[0] as f64 / 1000.0),
                "ts_of_last_over_time" => Some(w.ts[w.ts.len() - 1] as f64 / 1000.0),
                "count_over_time" => Some(w.vals.len() as f64),
                "last_over_time" => Some(w.vals[w.vals.len() - 1]),
                "first_over_time" => Some(w.vals[0]),
                "stdvar_over_time" => Some(f::variance_over_time(w.vals)),
                "stddev_over_time" => Some(f::variance_over_time(w.vals).sqrt()),
                "quantile_over_time" => Some(f::quantile(params[0][i], &mut w.vals.to_vec())),
                "mad_over_time" => Some(f::mad_over_time(w.vals)),
                "present_over_time" => Some(1.0),
                "deriv" => {
                    if w.vals.len() < 2 {
                        None
                    } else {
                        Some(f::linear_regression(w.ts, w.vals, w.ts[0]).0)
                    }
                }
                "predict_linear" => {
                    if w.vals.len() < 2 {
                        None
                    } else {
                        let (slope, intercept) = f::linear_regression(w.ts, w.vals, w.eval_ts);
                        Some(slope * params[0][i] + intercept)
                    }
                }
                "double_exponential_smoothing" => f::double_exponential_smoothing(w.vals, params[0][i], params[1][i]),
                _ => None,
            }
        };

        if name == "absent_over_time" {
            let mut vals = vec![Some(1.0); n];
            for s in &rv.series {
                for (i, slot) in vals.iter_mut().enumerate() {
                    let e = rv.window_end(steps.ts(i));
                    let lo = s.ts.partition_point(|&t| t <= e - rv.range);
                    let hi = s.ts.partition_point(|&t| t <= e);
                    if hi > lo {
                        *slot = None;
                    }
                }
            }
            if vals.iter().all(|x| x.is_none()) {
                return Ok(Val::Vector(vec![]));
            }
            return Ok(Val::Vector(vec![SeriesV { labels: absent_labels(args[0])?, drop_name: true, vals }]));
        }

        // first/last_over_time behave like a selector and keep the name.
        let keep_name = name == "last_over_time" || name == "first_over_time";
        let mut out = Vec::with_capacity(rv.series.len());
        for s in &rv.series {
            let mut vals = vec![None; n];
            let mut any = false;
            for (i, slot) in vals.iter_mut().enumerate() {
                let ts = steps.ts(i);
                let e = rv.window_end(ts);
                let start = e - rv.range;
                // Left-open, right-closed: (start, e].
                let lo = s.ts.partition_point(|&t| t <= start);
                let hi = s.ts.partition_point(|&t| t <= e);
                if hi <= lo {
                    continue;
                }
                let w = Window { ts: &s.ts[lo..hi], vals: &s.vals[lo..hi], range_start: start, range_end: e, eval_ts: ts };
                if let Some(v) = kernel(&w, i) {
                    *slot = Some(v);
                    any = true;
                }
            }
            if any {
                let (labels, drop_name) =
                    if keep_name { (s.labels.clone(), s.drop_name) } else { (self.drop_name(&s.labels), true) };
                out.push(SeriesV { labels, drop_name, vals });
            }
        }
        if !self.delayed() {
            check_unique(&out)?;
        }
        Ok(Val::Vector(out))
    }

    fn histogram_quantile(&self, q: &[f64], v: Vec<SeriesV>, n: usize) -> Result<Val, Error> {
        // Per input series: bucket upper bound and the histogram it belongs to.
        struct Group {
            labels: Labels,
        }
        let mut groups: Vec<Group> = Vec::new();
        let mut gidx: HashMap<Vec<(String, String)>, usize> = HashMap::new();
        let mut series_info: Vec<Option<(f64, usize)>> = Vec::with_capacity(v.len());
        for s in &v {
            let le = label_get(&s.labels, "le");
            let ub = match parse_go_float(le) {
                Some(x) => x,
                None => {
                    series_info.push(None);
                    continue;
                }
            };
            let sig: Vec<(String, String)> = s.labels.iter().filter(|(n, _)| n != "le").cloned().collect();
            let g = match gidx.get(&sig) {
                Some(&g) => g,
                None => {
                    let labels: Labels = if self.delayed() {
                        Arc::new(sig.clone())
                    } else {
                        Arc::new(sig.iter().filter(|(n, _)| !is_metadata_label(n)).cloned().collect())
                    };
                    groups.push(Group { labels });
                    gidx.insert(sig, groups.len() - 1);
                    groups.len() - 1
                }
            };
            series_info.push(Some((ub, g)));
        }
        let mut out = OutBuilder::new(n, self.delayed());
        let mut buckets: Vec<Vec<(f64, f64)>> = vec![Vec::new(); groups.len()];
        for i in 0..n {
            for b in buckets.iter_mut() {
                b.clear();
            }
            for (si, s) in v.iter().enumerate() {
                if let (Some(x), Some((ub, g))) = (s.vals[i], series_info[si]) {
                    buckets[g].push((ub, x));
                }
            }
            for (g, b) in buckets.iter_mut().enumerate() {
                if !b.is_empty() {
                    let r = f::bucket_quantile(q[i], b);
                    out.push(i, &groups[g].labels, true, r)?;
                }
            }
        }
        Ok(Val::Vector(out.out))
    }

    // ------------------------------------------------------------- binary

    fn eval_binary(&self, b: &BinaryExpr, steps: Steps) -> Result<Val, Error> {
        let n = steps.n();
        let op = b.op;
        let return_bool = b.modifier.as_ref().is_some_and(|m| m.return_bool);
        if let Some(m) = &b.modifier {
            if m.fill_values.lhs.is_some() || m.fill_values.rhs.is_some() {
                return Err(Error::Unsupported("fill() / fill_left() / fill_right() modifiers".into()));
            }
        }
        let l = self.eval(&b.lhs, steps)?;
        let r = self.eval(&b.rhs, steps)?;
        match (l, r) {
            (Val::Scalar(a), Val::Scalar(c)) => {
                let mut out = Vec::with_capacity(n);
                for i in 0..n {
                    out.push(scalar_binop(op, a[i], c[i])?);
                }
                Ok(Val::Scalar(out))
            }
            (Val::Vector(v), Val::Scalar(s)) => self.vector_scalar(op, v, &s, false, return_bool, n),
            (Val::Scalar(s), Val::Vector(v)) => self.vector_scalar(op, v, &s, true, return_bool, n),
            (Val::Vector(lv), Val::Vector(rv)) => self.vector_vector(b, lv, rv, n),
            _ => Err(Error::Eval("binary expression must contain only scalar and instant vector types".into())),
        }
    }

    fn vector_scalar(
        &self,
        op: TokenType,
        v: Vec<SeriesV>,
        s: &[f64],
        swap: bool,
        return_bool: bool,
        n: usize,
    ) -> Result<Val, Error> {
        if op.is_set_operator() {
            return Err(Error::Eval("set operator not allowed in binary scalar expression".into()));
        }
        let is_cmp = op.is_comparison_operator();
        let drops = changes_schema(op) || return_bool;
        let mut out = Vec::with_capacity(v.len());
        for series in v {
            let mut vals = vec![None; n];
            for i in 0..n {
                let Some(x) = series.vals[i] else { continue };
                let (lf, rf) = if swap { (s[i], x) } else { (x, s[i]) };
                let (mut value, mut keep) = elem_binop(op, lf, rf)?;
                if is_cmp && swap {
                    // The sample value comes from the vector side.
                    value = rf;
                }
                if return_bool {
                    value = if keep { 1.0 } else { 0.0 };
                    keep = true;
                }
                if keep {
                    vals[i] = Some(value);
                }
            }
            let (labels, drop_name) =
                if drops { (self.drop_name(&series.labels), true) } else { (series.labels.clone(), series.drop_name) };
            out.push(SeriesV { labels, drop_name, vals });
        }
        Ok(Val::Vector(self.merge_dups(out, n)?))
    }

    fn vector_vector(&self, b: &BinaryExpr, lv: Vec<SeriesV>, rv: Vec<SeriesV>, n: usize) -> Result<Val, Error> {
        let op = b.op;
        let default_mod = promql_parser::parser::BinModifier::default();
        let m = b.modifier.as_ref().unwrap_or(&default_mod);
        let return_bool = m.return_bool;
        let (on, match_labels): (bool, Vec<String>) = match &m.matching {
            Some(LabelModifier::Include(l)) => (true, l.labels.clone()),
            Some(LabelModifier::Exclude(l)) => (false, l.labels.clone()),
            None => (false, vec![]),
        };
        let match_set: HashSet<&str> = match_labels.iter().map(|s| s.as_str()).collect();

        // Join signatures, interned to integers once per input series.
        let mut intern: HashMap<Vec<(String, String)>, usize> = HashMap::new();
        let mut sig_labels: Vec<Vec<(String, String)>> = Vec::new();
        let mut sig_of = |labels: &Labels| -> usize {
            let sig: Vec<(String, String)> = if on {
                labels.iter().filter(|(k, _)| match_set.contains(k.as_str())).cloned().collect()
            } else {
                labels.iter().filter(|(k, _)| k != NAME_LABEL && !match_set.contains(k.as_str())).cloned().collect()
            };
            if let Some(&i) = intern.get(&sig) {
                return i;
            }
            sig_labels.push(sig.clone());
            intern.insert(sig, sig_labels.len() - 1);
            sig_labels.len() - 1
        };
        let lsig: Vec<usize> = lv.iter().map(|s| sig_of(&s.labels)).collect();
        let rsig: Vec<usize> = rv.iter().map(|s| sig_of(&s.labels)).collect();
        let nsig = sig_labels.len();

        let mut out = OutBuilder::new(n, self.delayed());
        let id = op.id();

        if op.is_set_operator() {
            let mut present = vec![usize::MAX; nsig];
            for i in 0..n {
                // `present[sig] == i` marks signatures seen on the other side at this step.
                if id == token::T_LOR {
                    for (li, s) in lv.iter().enumerate() {
                        if let Some(x) = s.vals[i] {
                            present[lsig[li]] = i;
                            out.push(i, &s.labels, s.drop_name, x)?;
                        }
                    }
                    for (ri, s) in rv.iter().enumerate() {
                        if let Some(x) = s.vals[i] {
                            if present[rsig[ri]] != i {
                                out.push(i, &s.labels, s.drop_name, x)?;
                            }
                        }
                    }
                } else {
                    for (ri, s) in rv.iter().enumerate() {
                        if s.vals[i].is_some() {
                            present[rsig[ri]] = i;
                        }
                    }
                    let want = id == token::T_LAND;
                    for (li, s) in lv.iter().enumerate() {
                        if let Some(x) = s.vals[i] {
                            if (present[lsig[li]] == i) == want {
                                out.push(i, &s.labels, s.drop_name, x)?;
                            }
                        }
                    }
                }
            }
            return Ok(Val::Vector(out.out));
        }

        let (card_one_to_many, include): (bool, Vec<String>) = match &m.card {
            VectorMatchCardinality::OneToOne => (false, vec![]),
            VectorMatchCardinality::ManyToOne(l) => (false, l.labels.clone()),
            VectorMatchCardinality::OneToMany(l) => (true, l.labels.clone()),
            VectorMatchCardinality::ManyToMany => {
                return Err(Error::Eval("many-to-many only allowed for set operators".into()))
            }
        };
        let one_to_one = matches!(m.card, VectorMatchCardinality::OneToOne);
        // "many" is the side whose series survive; "one" is the side that must be unique.
        let (many, one, many_sig, one_sig) =
            if card_one_to_many { (&rv, &lv, &rsig, &lsig) } else { (&lv, &rv, &lsig, &rsig) };

        let mut metric_cache: HashMap<(usize, usize), Labels> = HashMap::new();
        let mut one_at = vec![(usize::MAX, 0usize); nsig]; // sig -> (step, series index)
        let mut matched_step = vec![usize::MAX; nsig];
        let mut matched_metrics: Vec<HashSet<Labels>> = vec![HashSet::new(); nsig];

        for i in 0..n {
            for (oi, s) in one.iter().enumerate() {
                if s.vals[i].is_none() {
                    continue;
                }
                let sig = one_sig[oi];
                if one_at[sig].0 == i {
                    let side = if card_one_to_many { "left" } else { "right" };
                    let dup = &one[one_at[sig].1];
                    let group: Vec<(String, String)> = sig_labels[sig].clone();
                    return Err(Error::Eval(format!(
                        "found duplicate series for the match group {} on the {side} hand-side of the operation: [{}, {}];many-to-many matching not allowed: matching labels must be unique on one side",
                        fmt_labels(&group),
                        fmt_labels(&s.labels),
                        fmt_labels(&dup.labels)
                    )));
                }
                one_at[sig] = (i, oi);
            }
            for (mi, s) in many.iter().enumerate() {
                let Some(mv) = s.vals[i] else { continue };
                let sig = many_sig[mi];
                if one_at[sig].0 != i {
                    continue;
                }
                let oi = one_at[sig].1;
                let ov = one[oi].vals[i].unwrap_or(f64::NAN);
                let (fl, fr) = if card_one_to_many { (ov, mv) } else { (mv, ov) };
                let (mut value, keep) = elem_binop(op, fl, fr)?;
                if return_bool {
                    value = if keep { 1.0 } else { 0.0 };
                } else if !keep {
                    continue;
                }
                let metric = metric_cache
                    .entry((mi, oi))
                    .or_insert_with(|| {
                        let mut l: Vec<(String, String)> = s.labels.as_ref().clone();
                        if changes_schema(op) {
                            l.retain(|(k, _)| !is_metadata_label(k));
                        }
                        if one_to_one {
                            if on {
                                l.retain(|(k, _)| match_set.contains(k.as_str()));
                            } else {
                                l.retain(|(k, _)| !match_set.contains(k.as_str()));
                            }
                        }
                        for ln in &include {
                            let v = label_get(&one[oi].labels, ln).to_string();
                            l.retain(|(k, _)| k != ln);
                            if !v.is_empty() {
                                l.push((ln.clone(), v));
                            }
                        }
                        if !self.delayed() && return_bool {
                            l.retain(|(k, _)| !is_metadata_label(k));
                        }
                        l.sort();
                        Arc::new(l)
                    })
                    .clone();
                if matched_step[sig] != i {
                    matched_step[sig] = i;
                    matched_metrics[sig].clear();
                } else if one_to_one {
                    return Err(Error::Eval(
                        "multiple matches for labels: many-to-one matching must be explicit (group_left/group_right)".into(),
                    ));
                }
                if !one_to_one && !matched_metrics[sig].insert(metric.clone()) {
                    return Err(Error::Eval(
                        "multiple matches for labels: grouping labels must ensure unique matches".into(),
                    ));
                }
                out.push(i, &metric, return_bool, value)?;
            }
        }
        Ok(Val::Vector(out.out))
    }

    // -------------------------------------------------------- aggregation

    fn eval_aggregate(&self, a: &AggregateExpr, steps: Steps) -> Result<Val, Error> {
        let n = steps.n();
        let id = a.op.id();
        let (without, mut grouping): (bool, Vec<String>) = match &a.modifier {
            Some(LabelModifier::Include(l)) => (false, l.labels.clone()),
            Some(LabelModifier::Exclude(l)) => (true, l.labels.clone()),
            None => (false, vec![]),
        };
        grouping.sort();

        let group_labels = |labels: &[(String, String)], grouping: &[String]| -> Labels {
            if without {
                Arc::new(
                    labels.iter().filter(|(k, _)| k != NAME_LABEL && !grouping.iter().any(|g| g == k)).cloned().collect(),
                )
            } else {
                Arc::new(labels.iter().filter(|(k, _)| grouping.iter().any(|g| g == k)).cloned().collect())
            }
        };

        if id == token::T_COUNT_VALUES {
            let value_label = match a.param.as_deref().map(unwrap_paren) {
                Some(Expr::StringLiteral(s)) => s.val.clone(),
                _ => return Err(Error::Eval("count_values expects a string parameter".into())),
            };
            if value_label.is_empty() || value_label.contains('\u{fffd}') {
                return Err(Error::Eval(format!("invalid label name {value_label:?}")));
            }
            if !without {
                grouping.push(value_label.clone());
                grouping.sort();
            }
            let v = self.eval_vector(&a.expr, steps)?;
            let mut out = OutBuilder::new(n, self.delayed());
            for i in 0..n {
                let mut order: Vec<Labels> = Vec::new();
                let mut counts: HashMap<Labels, usize> = HashMap::new();
                for s in &v {
                    let Some(x) = s.vals[i] else { continue };
                    let with_value = set_label(&s.labels, &value_label, &format_float(x));
                    let g = group_labels(&with_value, &grouping);
                    match counts.get_mut(&g) {
                        Some(c) => *c += 1,
                        None => {
                            counts.insert(g.clone(), 1);
                            order.push(g);
                        }
                    }
                }
                for g in order {
                    out.push(i, &g, false, counts[&g] as f64)?;
                }
            }
            return Ok(Val::Vector(out.out));
        }

        let is_k = id == token::T_TOPK || id == token::T_BOTTOMK;
        let needs_param = is_k || id == token::T_QUANTILE;
        if id == token::T_LIMITK || id == token::T_LIMIT_RATIO {
            return Err(Error::Unsupported("limitk / limit_ratio aggregations".into()));
        }
        let param: Vec<f64> = if needs_param {
            match &a.param {
                Some(p) => self.eval_scalar(p, steps)?,
                None => return Err(Error::Eval("aggregation requires a parameter".into())),
            }
        } else {
            vec![]
        };
        let v = self.eval_vector(&a.expr, steps)?;

        // Assign every input series to a group, once.
        let mut gidx: HashMap<Labels, usize> = HashMap::new();
        let mut glabels: Vec<Labels> = Vec::new();
        let series_group: Vec<usize> = v
            .iter()
            .map(|s| {
                let g = group_labels(&s.labels, &grouping);
                *gidx.entry(g.clone()).or_insert_with(|| {
                    glabels.push(g);
                    glabels.len() - 1
                })
            })
            .collect();
        let ng = glabels.len();

        if is_k {
            if n == 0 || param.iter().all(|k| *k < 1.0) {
                return Ok(Val::Vector(vec![]));
            }
            if param.iter().any(|k| k.is_nan()) {
                return Err(Error::Eval("Parameter value is NaN".into()));
            }
            if let Some(k) = param.iter().find(|k| **k <= i64::MIN as f64) {
                return Err(Error::Eval(format!("Scalar value {k} underflows int64")));
            }
            if let Some(k) = param.iter().find(|k| **k >= i64::MAX as f64) {
                return Err(Error::Eval(format!("Scalar value {k} overflows int64")));
            }
            let top = id == token::T_TOPK;
            // `a` ranks strictly before `b`. NaN ranks last; ties go to the
            // smaller label set so the choice does not depend on input order.
            let better = |a: (f64, usize), b: (f64, usize)| -> bool {
                match (a.0.is_nan(), b.0.is_nan()) {
                    (true, true) => v[a.1].labels < v[b.1].labels,
                    (true, false) => false,
                    (false, true) => true,
                    _ => {
                        if a.0 == b.0 {
                            v[a.1].labels < v[b.1].labels
                        } else if top {
                            a.0 > b.0
                        } else {
                            a.0 < b.0
                        }
                    }
                }
            };
            let mut selected: Vec<Vec<Option<f64>>> = vec![vec![]; v.len()];
            let mut instant_order: Vec<usize> = Vec::new();
            for i in 0..n {
                let k = (param[i] as i64).min(v.len() as i64);
                if k < 1 {
                    continue;
                }
                let mut per_group: Vec<Vec<(f64, usize)>> = vec![Vec::new(); ng];
                for (si, s) in v.iter().enumerate() {
                    if let Some(x) = s.vals[i] {
                        per_group[series_group[si]].push((x, si));
                    }
                }
                for g in per_group.iter_mut() {
                    g.sort_by(|a, b| {
                        if better(*a, *b) {
                            std::cmp::Ordering::Less
                        } else if better(*b, *a) {
                            std::cmp::Ordering::Greater
                        } else {
                            std::cmp::Ordering::Equal
                        }
                    });
                    g.truncate(k as usize);
                    for (x, si) in g.iter() {
                        if selected[*si].is_empty() {
                            selected[*si] = vec![None; n];
                        }
                        selected[*si][i] = Some(*x);
                        if n == 1 {
                            instant_order.push(*si);
                        }
                    }
                }
            }
            let order: Vec<usize> =
                if n == 1 { instant_order } else { (0..v.len()).filter(|si| !selected[*si].is_empty()).collect() };
            let out = order
                .into_iter()
                .map(|si| SeriesV {
                    labels: v[si].labels.clone(),
                    drop_name: v[si].drop_name,
                    vals: std::mem::take(&mut selected[si]),
                })
                .collect();
            return Ok(Val::Vector(out));
        }

        let mut out_vals: Vec<Vec<Option<f64>>> = vec![vec![None; n]; ng];
        let mut groups: Vec<AggGroup> = (0..ng)
            .map(|_| AggGroup { seen: false, value: 0.0, mean: 0.0, c: 0.0, count: 0.0, incremental: false, heap: vec![] })
            .collect();
        for i in 0..n {
            for g in groups.iter_mut() {
                g.seen = false;
            }
            for (si, s) in v.iter().enumerate() {
                let Some(x) = s.vals[i] else { continue };
                let g = &mut groups[series_group[si]];
                if !g.seen {
                    g.seen = true;
                    g.value = x;
                    g.mean = x;
                    g.c = 0.0;
                    g.count = 1.0;
                    g.incremental = false;
                    g.heap.clear();
                    match id {
                        token::T_STDVAR | token::T_STDDEV => {
                            g.value = if x.is_nan() || x.is_infinite() { f64::NAN } else { 0.0 };
                        }
                        token::T_QUANTILE => g.heap.push(x),
                        token::T_GROUP => g.value = 1.0,
                        _ => {}
                    }
                    continue;
                }
                match id {
                    token::T_SUM => {
                        (g.value, g.c) = f::kahan_inc(x, g.value, g.c);
                    }
                    token::T_AVG => {
                        g.count += 1.0;
                        let mut direct = false;
                        if !g.incremental {
                            let (nv, nc) = f::kahan_inc(x, g.value, g.c);
                            if !nv.is_infinite() {
                                g.value = nv;
                                g.c = nc;
                                direct = true;
                            } else {
                                g.incremental = true;
                                g.mean = g.value / (g.count - 1.0);
                                g.c /= g.count - 1.0;
                            }
                        }
                        if !direct {
                            let q = (g.count - 1.0) / g.count;
                            (g.mean, g.c) = f::kahan_inc(x / g.count, q * g.mean, q * g.c);
                        }
                    }
                    token::T_GROUP => {}
                    token::T_MAX => {
                        if g.value < x || g.value.is_nan() {
                            g.value = x;
                        }
                    }
                    token::T_MIN => {
                        if g.value > x || g.value.is_nan() {
                            g.value = x;
                        }
                    }
                    token::T_COUNT => g.count += 1.0,
                    token::T_STDVAR | token::T_STDDEV => {
                        g.count += 1.0;
                        let delta = x - g.mean;
                        g.mean += delta / g.count;
                        g.value += delta * (x - g.mean);
                    }
                    token::T_QUANTILE => g.heap.push(x),
                    _ => return Err(Error::Unsupported(format!("aggregation operator {}", a.op))),
                }
            }
            for (gi, g) in groups.iter_mut().enumerate() {
                if !g.seen {
                    continue;
                }
                let value = match id {
                    token::T_AVG => {
                        if g.incremental {
                            g.mean + g.c
                        } else {
                            g.value / g.count + g.c / g.count
                        }
                    }
                    token::T_COUNT => g.count,
                    token::T_STDVAR => g.value / g.count,
                    token::T_STDDEV => (g.value / g.count).sqrt(),
                    token::T_QUANTILE => f::quantile(param[i], &mut g.heap),
                    token::T_SUM => g.value + g.c,
                    token::T_MIN | token::T_MAX | token::T_GROUP => g.value,
                    _ => return Err(Error::Unsupported(format!("aggregation operator {}", a.op))),
                };
                out_vals[gi][i] = Some(value);
            }
        }
        let mut out = Vec::with_capacity(ng);
        for (gi, vals) in out_vals.into_iter().enumerate() {
            if vals.iter().any(|x| x.is_some()) {
                // Mirrors the reference implementation, which takes the flag
                // from the input series at the group's index.
                let drop_name = v.get(gi).is_some_and(|s| s.drop_name);
                out.push(SeriesV { labels: glabels[gi].clone(), drop_name, vals });
            }
        }
        Ok(Val::Vector(out))
    }
}

fn go_max(a: f64, b: f64) -> f64 {
    // Go's math.Max: +Inf wins even over NaN.
    if a == f64::INFINITY || b == f64::INFINITY {
        f64::INFINITY
    } else if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn go_min(a: f64, b: f64) -> f64 {
    if a == f64::NEG_INFINITY || b == f64::NEG_INFINITY {
        f64::NEG_INFINITY
    } else if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// Ascending (or descending) by value with NaN always last.
fn cmp_nan_last(x: f64, y: f64, desc: bool) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    match (x.is_nan(), y.is_nan()) {
        (true, true) => Equal,
        (true, false) => Greater,
        (false, true) => Less,
        _ => {
            let c = x.partial_cmp(&y).unwrap_or(Equal);
            if desc {
                c.reverse()
            } else {
                c
            }
        }
    }
}

fn check_unique(v: &[SeriesV]) -> Result<(), Error> {
    let mut seen: HashSet<&Labels> = HashSet::with_capacity(v.len());
    for s in v {
        if !seen.insert(&s.labels) {
            return Err(dup_err());
        }
    }
    Ok(())
}

fn set_label(l: &Labels, name: &str, value: &str) -> Labels {
    let mut out: Vec<(String, String)> = l.iter().filter(|(k, _)| k != name).cloned().collect();
    if !value.is_empty() {
        out.push((name.to_string(), value.to_string()));
        out.sort();
    }
    Arc::new(out)
}

/// Labels of the series `absent()` returns: the equality matchers of the selector.
fn absent_labels(e: &Expr) -> Result<Labels, Error> {
    let vs = match unwrap_paren(e) {
        Expr::VectorSelector(vs) => vs,
        Expr::MatrixSelector(ms) => &ms.vs,
        _ => return Ok(Arc::new(vec![])),
    };
    let mut out: Vec<(String, String)> = Vec::new();
    let mut has: HashSet<&str> = HashSet::new();
    for m in &vs.matchers.matchers {
        if m.name == NAME_LABEL {
            continue;
        }
        let eq = matches!(m.op, promql_parser::label::MatchOp::Equal);
        out.retain(|(k, _)| *k != m.name);
        if eq && !has.contains(m.name.as_str()) {
            if !m.value.is_empty() {
                out.push((m.name.clone(), m.value.clone()));
            }
            has.insert(m.name.as_str());
        }
    }
    out.sort();
    Ok(Arc::new(out))
}

fn parse_go_float(s: &str) -> Option<f64> {
    match s {
        "+Inf" | "Inf" | "+inf" | "inf" => Some(f64::INFINITY),
        "-Inf" | "-inf" => Some(f64::NEG_INFINITY),
        _ => {
            if s.is_empty() || s.chars().any(|c| c.is_whitespace()) {
                return None;
            }
            s.parse::<f64>().ok()
        }
    }
}

fn changes_schema(op: TokenType) -> bool {
    matches!(
        op.id(),
        token::T_ADD | token::T_SUB | token::T_MUL | token::T_DIV | token::T_POW | token::T_MOD | token::T_ATAN2
    )
}

fn scalar_binop(op: TokenType, l: f64, r: f64) -> Result<f64, Error> {
    let b = |x: bool| if x { 1.0 } else { 0.0 };
    Ok(match op.id() {
        token::T_ADD => l + r,
        token::T_SUB => l - r,
        token::T_MUL => l * r,
        token::T_DIV => l / r,
        token::T_POW => l.powf(r),
        token::T_MOD => f::go_mod(l, r),
        token::T_EQLC => b(l == r),
        token::T_NEQ => b(l != r),
        token::T_GTR => b(l > r),
        token::T_LSS => b(l < r),
        token::T_GTE => b(l >= r),
        token::T_LTE => b(l <= r),
        token::T_ATAN2 => l.atan2(r),
        _ => return Err(Error::Eval(format!("operator {op} not allowed for scalar operations"))),
    })
}

/// Value and "keep" flag of one vector element operation.
fn elem_binop(op: TokenType, l: f64, r: f64) -> Result<(f64, bool), Error> {
    Ok(match op.id() {
        token::T_ADD => (l + r, true),
        token::T_SUB => (l - r, true),
        token::T_MUL => (l * r, true),
        token::T_DIV => (l / r, true),
        token::T_POW => (l.powf(r), true),
        token::T_MOD => (f::go_mod(l, r), true),
        token::T_ATAN2 => (l.atan2(r), true),
        token::T_EQLC => (l, l == r),
        token::T_NEQ => (l, l != r),
        token::T_GTR => (l, l > r),
        token::T_LSS => (l, l < r),
        token::T_GTE => (l, l >= r),
        token::T_LTE => (l, l <= r),
        _ => return Err(Error::Eval(format!("operator {op} not allowed for operations between vectors"))),
    })
}
