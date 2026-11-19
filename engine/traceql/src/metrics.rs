//! TraceQL metrics: `rate`, `count_over_time`, `{min,max,avg,sum}_over_time`,
//! `quantile_over_time`, `histogram_over_time`, `by`, `topk`/`bottomk`, comparisons and
//! arithmetic between metrics queries.
//!
//! Time grid (Tempo's observed behaviour): a range query has the points `k·step` (multiples
//! of the step in Unix time) from the first one after `start` to the first one at or after
//! `end`; the point `t` covers span start times in `(t − step, t]`, and only spans with
//! `start < ts ≤ end` count. An instant query is one point at `end` covering `(start, end]`.
//!
//! Every sum is exact (Shewchuk partials, rounded once), so results do not depend on the
//! order in which the source returns traces.

use std::collections::HashMap;

use crate::ast::*;
use crate::data::{SpanSource, Trace};
use crate::eval::{expr_text, group_value, run_pipeline, Spanset, TraceCtx};
use crate::plan::ReadPlan;
use crate::value::Val;
use crate::Error;

/// A metrics request over `(start, end]` with a step, all in Unix nanoseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RangeRequest {
    pub start_unix_nano: u64,
    pub end_unix_nano: u64,
    pub step_nano: u64,
    /// One point at `end` covering the whole range (Tempo's `/api/metrics/query`).
    pub instant: bool,
}

impl RangeRequest {
    pub fn range(start_unix_nano: u64, end_unix_nano: u64, step_nano: u64) -> RangeRequest {
        RangeRequest { start_unix_nano, end_unix_nano, step_nano, instant: false }
    }
    pub fn instant(start_unix_nano: u64, end_unix_nano: u64) -> RangeRequest {
        RangeRequest { start_unix_nano, end_unix_nano, step_nano: end_unix_nano.saturating_sub(start_unix_nano), instant: true }
    }
    fn base(&self) -> u64 {
        self.start_unix_nano / self.step_nano
    }
    pub fn points(&self) -> u64 {
        if self.step_nano == 0 || self.end_unix_nano <= self.start_unix_nano {
            return 0;
        }
        if self.instant {
            return 1;
        }
        self.end_unix_nano.div_ceil(self.step_nano) - self.base()
    }
    /// Point index for a span start time, if it counts.
    pub fn index(&self, ts: u64) -> Option<usize> {
        if ts <= self.start_unix_nano || ts > self.end_unix_nano || self.step_nano == 0 {
            return None;
        }
        if self.instant {
            return Some(0);
        }
        let k = ts.div_ceil(self.step_nano) - self.base() - 1;
        usize::try_from(k).ok()
    }
    pub fn timestamp_ms(&self, k: usize) -> i64 {
        if self.instant {
            return (self.end_unix_nano / 1_000_000) as i64;
        }
        let t = (self.base() as i128 + k as i128 + 1) * self.step_nano as i128;
        (t / 1_000_000) as i64
    }
    /// The seconds `rate()` divides by.
    pub fn step_seconds(&self) -> f64 {
        self.step_nano as f64 / 1e9
    }
}

/// One output series: labels and one value per point (NaN: no sample).
#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    pub labels: Vec<(String, Val<'static>)>,
    pub values: Vec<f64>,
}

/// Exact floating-point sum (Shewchuk's algorithm, as in Python's `math.fsum`).
#[derive(Clone, Debug, Default)]
pub struct ExactSum {
    partials: Vec<f64>,
    special: f64,
    has_special: bool,
}

impl ExactSum {
    pub fn add(&mut self, mut x: f64) {
        if !x.is_finite() {
            self.special = if self.has_special { self.special + x } else { x };
            self.has_special = true;
            return;
        }
        let mut i = 0;
        for j in 0..self.partials.len() {
            let mut y = self.partials[j];
            if x.abs() < y.abs() {
                std::mem::swap(&mut x, &mut y);
            }
            let hi = x + y;
            let lo = y - (hi - x);
            if lo != 0.0 {
                self.partials[i] = lo;
                i += 1;
            }
            x = hi;
        }
        self.partials.truncate(i);
        if !x.is_finite() {
            // Overflow of a partial: fall back to the plain sum's infinity.
            self.special = if self.has_special { self.special + x } else { x };
            self.has_special = true;
            self.partials.clear();
            return;
        }
        self.partials.push(x);
    }
    pub fn value(&self) -> f64 {
        if self.has_special {
            return self.special;
        }
        let p = &self.partials;
        if p.is_empty() {
            return 0.0;
        }
        let mut n = p.len() - 1;
        let mut hi = p[n];
        let mut lo = 0.0;
        while n > 0 {
            n -= 1;
            let x = hi;
            let y = p[n];
            hi = x + y;
            let yr = hi - x;
            lo = y - yr;
            if lo != 0.0 {
                break;
            }
        }
        if n > 0 && ((lo < 0.0 && p[n - 1] < 0.0) || (lo > 0.0 && p[n - 1] > 0.0)) {
            let y = lo * 2.0;
            let x = hi + y;
            let yr = x - hi;
            if y == yr {
                hi = x;
            }
        }
        hi
    }
}

#[derive(Clone, Debug)]
enum Acc {
    Count(Vec<u64>),
    Sum(Vec<ExactSum>, Vec<bool>),
    Min(Vec<f64>),
    Max(Vec<f64>),
    Avg(Vec<ExactSum>, Vec<u64>),
    /// Per point: log2 exponent -> count.
    Hist(Vec<HashMap<u32, u64>>),
}

/// Value of a span for a metrics function: durations in seconds.
fn metric_value(v: &Val) -> Option<f64> {
    match v {
        Val::Int(x) => Some(*x as f64),
        Val::Float(x) => Some(*x),
        Val::Duration(x) => Some(*x as f64 / 1e9),
        _ => None,
    }
}

/// Log2 bucket of a value for quantiles and histograms: integers (durations in
/// nanoseconds) of at least 2 go to the bucket `2^ceil(log2 v)`; floats and smaller values
/// are not counted (observed behaviour; README).
fn bucket(v: &Val) -> Option<u32> {
    let x = match v {
        Val::Int(x) | Val::Duration(x) => *x,
        _ => return None,
    };
    if x < 2 {
        return None;
    }
    // Through f64, as Tempo does: 2^53 + 1 is 2^53 and lands in that bucket.
    let e = (x as f64).log2().ceil();
    Some(e as u32)
}

fn is_duration(e: &FieldExpr) -> bool {
    match e {
        FieldExpr::Intrinsic(i, _) => i.typ() == Type::Duration,
        FieldExpr::Binary(op, a, b) if op.is_arith() => is_duration(a) || is_duration(b),
        FieldExpr::Unary(UnOp::Neg, x) => is_duration(x),
        _ => false,
    }
}

/// Quantile from log2 buckets: rank `ceil(p·N)` clamped to `[1, N]`, then exponential
/// interpolation inside the bucket that holds it.
pub fn quantile(p: f64, hist: &HashMap<u32, u64>) -> f64 {
    let total: u64 = hist.values().sum();
    if total == 0 {
        return 0.0;
    }
    let mut keys: Vec<u32> = hist.keys().copied().collect();
    keys.sort_unstable();
    let mut rank = (p * total as f64).ceil();
    if rank.is_nan() || rank < 1.0 {
        rank = 1.0;
    }
    if rank > total as f64 {
        rank = total as f64;
    }
    let mut cum = 0u64;
    for k in keys {
        let c = hist.get(&k).copied().unwrap_or(0);
        if (cum + c) as f64 >= rank {
            let frac = (rank - cum as f64) / c as f64;
            return 2f64.powf(k as f64 - 1.0 + frac);
        }
        cum += c;
    }
    0.0
}

struct Leaf<'q> {
    pipeline: &'q [Stage],
    func: &'q MetricsFn,
    by: &'q [FieldExpr],
    series: HashMap<Vec<GroupKey>, (Vec<Val<'static>>, Acc)>,
}

/// A hashable form of a grouping value.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum GroupKey {
    Nil,
    Bool(bool),
    Int(i64),
    Float(u64),
    Str(String),
    Dur(i64),
    Status(u8),
    Kind(u8),
}

fn group_key(v: &Val) -> GroupKey {
    match v {
        Val::Nil | Val::Arr(_) => GroupKey::Nil,
        Val::Bool(b) => GroupKey::Bool(*b),
        Val::Int(i) => GroupKey::Int(*i),
        Val::Float(f) => GroupKey::Float(f.to_bits()),
        Val::Str(s) => GroupKey::Str(s.to_string()),
        Val::Duration(d) => GroupKey::Dur(*d),
        Val::Status(s) => GroupKey::Status(*s as u8),
        Val::Kind(k) => GroupKey::Kind(*k as u8),
    }
}

impl<'q> Leaf<'q> {
    fn new_acc(&self, n: usize) -> Acc {
        match self.func {
            MetricsFn::Rate | MetricsFn::CountOverTime => Acc::Count(vec![0; n]),
            MetricsFn::SumOverTime(_) => Acc::Sum(vec![ExactSum::default(); n], vec![false; n]),
            MetricsFn::MinOverTime(_) => Acc::Min(vec![f64::NAN; n]),
            MetricsFn::MaxOverTime(_) => Acc::Max(vec![f64::NAN; n]),
            MetricsFn::AvgOverTime(_) => Acc::Avg(vec![ExactSum::default(); n], vec![0; n]),
            MetricsFn::QuantileOverTime(..) | MetricsFn::HistogramOverTime(_) => Acc::Hist(vec![HashMap::new(); n]),
        }
    }

    fn observe(&mut self, trace: &Trace, req: &RangeRequest, n: usize, max_series: usize) -> Result<(), Error> {
        let mut ctx = TraceCtx::new(trace);
        let all = Spanset { spans: (0..trace.spans.len()).collect(), attrs: Vec::new() };
        let sets = run_pipeline(self.pipeline, &mut ctx, vec![all]);
        let mut seen = vec![false; trace.spans.len()];
        for ss in sets {
            for i in ss.spans {
                if seen[i] {
                    continue;
                }
                seen[i] = true;
                let span = &trace.spans[i];
                let Some(k) = req.index(span.start_unix_nano) else { continue };
                let labels: Vec<Val<'static>> = self.by.iter().map(|e| group_value(e, &mut ctx, i)).collect();
                let key: Vec<GroupKey> = labels.iter().map(group_key).collect();
                if !self.series.contains_key(&key) {
                    if self.series.len() >= max_series {
                        return Err(Error::Eval(format!("the query produces more than {max_series} series")));
                    }
                    let acc = self.new_acc(n);
                    self.series.insert(key.clone(), (labels, acc));
                }
                let arg_val = self.func.arg().map(|e| crate::eval::field_value(e, &mut ctx, i).into_owned());
                let Some((_, acc)) = self.series.get_mut(&key) else { continue };
                match acc {
                    Acc::Count(c) => c[k] += 1,
                    Acc::Sum(s, has) => {
                        if let Some(x) = arg_val.as_ref().and_then(metric_value) {
                            s[k].add(x);
                            has[k] = true;
                        }
                    }
                    Acc::Min(m) => {
                        if let Some(x) = arg_val.as_ref().and_then(metric_value) {
                            if m[k].is_nan() || x < m[k] {
                                m[k] = x;
                            }
                        }
                    }
                    Acc::Max(m) => {
                        if let Some(x) = arg_val.as_ref().and_then(metric_value) {
                            if m[k].is_nan() || x > m[k] {
                                m[k] = x;
                            }
                        }
                    }
                    Acc::Avg(s, c) => {
                        if let Some(x) = arg_val.as_ref().and_then(metric_value) {
                            s[k].add(x);
                            c[k] += 1;
                        }
                    }
                    Acc::Hist(h) => {
                        if let Some(b) = arg_val.as_ref().and_then(bucket) {
                            *h[k].entry(b).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn finish(self, req: &RangeRequest, n: usize) -> Vec<Series> {
        let step_s = req.step_seconds();
        let name_label = |name: &str| vec![("__name__".to_string(), Val::Str(name.to_string().into()))];
        // Missing grouping values are left out of the labels; a series left with no label
        // at all is labelled with the first `by` field and `nil` (observed in Tempo).
        let by_labels = |vals: &[Val<'static>]| -> Vec<(String, Val<'static>)> {
            self.by.iter().zip(vals).filter(|(_, v)| !matches!(v, Val::Nil | Val::Arr(_))).map(|(e, v)| (expr_text(e), v.clone())).collect()
        };
        let series_labels = |vals: &[Val<'static>]| -> Vec<(String, Val<'static>)> {
            let l = by_labels(vals);
            if l.is_empty() {
                vec![(expr_text(&self.by[0]), label_value(&Val::Nil))]
            } else {
                l
            }
        };
        let mut out = Vec::new();
        let scale = match self.func.arg() {
            Some(e) if is_duration(e) => 1e-9,
            _ => 1.0,
        };
        for (_, (vals, acc)) in self.series.iter() {
            let labels = if self.by.is_empty() { name_label(self.func.name()) } else { series_labels(vals) };
            match acc {
                Acc::Count(c) => {
                    let values = c
                        .iter()
                        .map(|&x| if matches!(self.func, MetricsFn::Rate) { x as f64 / step_s } else { x as f64 })
                        .collect();
                    out.push(Series { labels, values });
                }
                Acc::Sum(s, has) => out.push(Series {
                    labels,
                    values: s.iter().zip(has).map(|(s, h)| if *h { s.value() } else { f64::NAN }).collect(),
                }),
                Acc::Min(m) | Acc::Max(m) => out.push(Series { labels, values: m.clone() }),
                Acc::Avg(s, c) => out.push(Series {
                    labels,
                    values: s.iter().zip(c).map(|(s, c)| if *c > 0 { s.value() / *c as f64 } else { f64::NAN }).collect(),
                }),
                // A series that never had a countable value is not returned (Tempo returns
                // none for quantiles of a float attribute, for instance).
                Acc::Hist(h) if h.iter().all(|b| b.is_empty()) => {}
                Acc::Hist(h) => match self.func {
                    MetricsFn::QuantileOverTime(_, qs) => {
                        for q in qs {
                            let mut l = if self.by.is_empty() { Vec::new() } else { by_labels(vals) };
                            l.push(("p".to_string(), Val::Float(*q)));
                            let values = h.iter().map(|b| quantile(*q, b) * scale).collect();
                            out.push(Series { labels: l, values });
                        }
                    }
                    _ => {
                        let mut buckets: Vec<u32> = h.iter().flat_map(|b| b.keys().copied()).collect();
                        buckets.sort_unstable();
                        buckets.dedup();
                        for b in buckets {
                            let mut l = if self.by.is_empty() { Vec::new() } else { by_labels(vals) };
                            l.push(("__bucket".to_string(), Val::Float(2f64.powi(b as i32) * scale)));
                            let values = h.iter().map(|m| m.get(&b).copied().unwrap_or(0) as f64).collect();
                            out.push(Series { labels: l, values });
                        }
                    }
                },
            }
        }
        // `count_over_time()` and `rate()` without `by` always return their one series.
        if out.is_empty() && self.by.is_empty() && matches!(self.func, MetricsFn::Rate | MetricsFn::CountOverTime) {
            out.push(Series { labels: name_label(self.func.name()), values: vec![0.0; n] });
        }
        out
    }
}

/// How a grouping value is shown as a label: missing values read `nil` (as Tempo shows them).
fn label_value(v: &Val<'static>) -> Val<'static> {
    match v {
        Val::Nil | Val::Arr(_) => Val::Str("nil".to_string().into()),
        other => other.clone(),
    }
}

fn leaves<'q>(m: &'q MetricsExpr, out: &mut Vec<&'q MetricsExpr>) {
    match m {
        MetricsExpr::Query { .. } => out.push(m),
        MetricsExpr::Math { lhs, rhs, .. } => {
            leaves(lhs, out);
            leaves(rhs, out);
        }
        MetricsExpr::Scalar(_) => {}
    }
}

/// Evaluates a metrics expression. `max_series` bounds the series of any leaf;
/// `max_points` bounds the number of points.
pub fn evaluate(
    src: &dyn SpanSource,
    m: &MetricsExpr,
    plan: &ReadPlan,
    req: &RangeRequest,
    max_series: usize,
    max_points: u64,
) -> Result<(Vec<Series>, crate::Stats), Error> {
    if req.step_nano == 0 {
        return Err(Error::Eval("step must be positive".into()));
    }
    if req.end_unix_nano <= req.start_unix_nano {
        return Err(Error::Eval("end must be after start".into()));
    }
    let n64 = req.points();
    if n64 > max_points {
        return Err(Error::Eval(format!("the range has {n64} points; at most {max_points} are allowed")));
    }
    let n = n64 as usize;
    let mut ls: Vec<&MetricsExpr> = Vec::new();
    leaves(m, &mut ls);
    let mut accs: Vec<Leaf> = ls
        .iter()
        .filter_map(|l| match l {
            MetricsExpr::Query { pipeline, func, by, .. } => Some(Leaf { pipeline, func, by, series: HashMap::new() }),
            _ => None,
        })
        .collect();
    let mut stats = crate::Stats::default();
    src.traces(plan, &mut |t: &Trace| {
        stats.inspected_traces += 1;
        stats.inspected_spans += t.spans.len() as u64;
        for leaf in accs.iter_mut() {
            leaf.observe(t, req, n, max_series)?;
        }
        Ok(())
    })?;
    let mut results: Vec<Vec<Series>> = accs.into_iter().map(|l| l.finish(req, n)).collect();
    results.reverse();
    let out = combine(m, &mut results, n)?;
    let mut out: Vec<Series> = out.into_iter().filter(|s| s.values.iter().any(|v| !v.is_nan())).collect();
    out.sort_by(|a, b| label_sort_key(&a.labels).cmp(&label_sort_key(&b.labels)));
    Ok((out, stats))
}

pub fn label_sort_key(l: &[(String, Val<'static>)]) -> String {
    let mut s = String::new();
    for (k, v) in l {
        s.push_str(k);
        s.push('\u{0}');
        match v {
            Val::Float(f) => s.push_str(&format!("{:020.6}", f)),
            Val::Int(i) => s.push_str(&format!("{:+020}", i)),
            other => s.push_str(&format!("{other:?}")),
        }
        s.push('\u{1}');
    }
    s
}

fn combine(m: &MetricsExpr, results: &mut Vec<Vec<Series>>, n: usize) -> Result<Vec<Series>, Error> {
    match m {
        MetricsExpr::Query { second, .. } => {
            let s = results.pop().unwrap_or_default();
            Ok(apply_second(s, second, n))
        }
        MetricsExpr::Scalar(v) => Ok(vec![Series { labels: Vec::new(), values: vec![*v; n] }]),
        MetricsExpr::Math { op, lhs, rhs, second } => {
            let l = combine(lhs, results, n)?;
            let r = combine(rhs, results, n)?;
            let out = math(*op, l, r, matches!(**lhs, MetricsExpr::Scalar(_)), matches!(**rhs, MetricsExpr::Scalar(_)));
            Ok(apply_second(out, second, n))
        }
    }
}

fn binop(op: BinOp, a: f64, b: f64) -> f64 {
    match op {
        BinOp::Add => a + b,
        BinOp::Sub => a - b,
        BinOp::Mul => a * b,
        BinOp::Div => {
            if b == 0.0 {
                f64::NAN
            } else {
                a / b
            }
        }
        _ => f64::NAN,
    }
}

fn unlabeled(s: &[Series]) -> bool {
    s.len() == 1 && s[0].labels.iter().all(|(k, _)| k == "__name__")
}

fn math(op: BinOp, l: Vec<Series>, r: Vec<Series>, l_scalar: bool, r_scalar: bool) -> Vec<Series> {
    let zip = |a: &Series, b: &Series, labels: Vec<(String, Val<'static>)>| Series {
        labels,
        values: a.values.iter().zip(&b.values).map(|(x, y)| binop(op, *x, *y)).collect(),
    };
    if r_scalar {
        let s = &r[0];
        return l.iter().map(|a| zip(a, s, a.labels.clone())).collect();
    }
    if l_scalar {
        let s = &l[0];
        return r.iter().map(|b| zip(s, b, b.labels.clone())).collect();
    }
    if l.is_empty() || r.is_empty() {
        return Vec::new();
    }
    match (unlabeled(&l), unlabeled(&r)) {
        (true, true) => {
            let name = |s: &Series| match s.labels.first() {
                Some((_, Val::Str(n))) => n.to_string(),
                _ => String::new(),
            };
            let label = format!("({} {} {})", name(&l[0]), op.text(), name(&r[0]));
            vec![zip(&l[0], &r[0], vec![("__name__".to_string(), Val::Str(label.into()))])]
        }
        (true, false) => r.iter().map(|b| zip(&l[0], b, b.labels.clone())).collect(),
        (false, true) => l.iter().map(|a| zip(a, &r[0], a.labels.clone())).collect(),
        (false, false) => {
            let mut out = Vec::new();
            for a in &l {
                let ka = label_sort_key(&a.labels);
                if let Some(b) = r.iter().find(|b| label_sort_key(&b.labels) == ka) {
                    out.push(zip(a, b, a.labels.clone()));
                }
            }
            out
        }
    }
}

fn apply_second(mut s: Vec<Series>, second: &[SecondStage], n: usize) -> Vec<Series> {
    for st in second {
        match st {
            SecondStage::TopK(k) | SecondStage::BottomK(k) => {
                let top = matches!(st, SecondStage::TopK(_));
                let order: Vec<String> = s.iter().map(|x| label_sort_key(&x.labels)).collect();
                for p in 0..n {
                    let mut idx: Vec<usize> = (0..s.len()).filter(|&i| !s[i].values[p].is_nan()).collect();
                    idx.sort_by(|&a, &b| {
                        let (x, y) = (s[a].values[p], s[b].values[p]);
                        let c = if top { y.partial_cmp(&x) } else { x.partial_cmp(&y) };
                        c.unwrap_or(std::cmp::Ordering::Equal).then_with(|| order[a].cmp(&order[b]))
                    });
                    for &i in idx.iter().skip(*k as usize) {
                        s[i].values[p] = f64::NAN;
                    }
                }
            }
            SecondStage::Filter(op, thr) => {
                for x in s.iter_mut() {
                    for v in x.values.iter_mut() {
                        let keep = match op {
                            BinOp::Eq => *v == *thr,
                            BinOp::Neq => *v != *thr,
                            BinOp::Lt => *v < *thr,
                            BinOp::Lte => *v <= *thr,
                            BinOp::Gt => *v > *thr,
                            BinOp::Gte => *v >= *thr,
                            _ => true,
                        };
                        if !keep {
                            *v = f64::NAN;
                        }
                    }
                }
            }
        }
        s.retain(|x| x.values.iter().any(|v| !v.is_nan()));
    }
    s
}
