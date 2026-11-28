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

/// The bytes a metrics evaluation holds, counted as each structure is made and refused BEFORE
/// the one that would pass `max` is built (`Limits::max_bytes`; design/reviews/
/// signals-end-to-end-r2.md R2-M2): every series' accumulator (a value per point, a histogram's
/// buckets per point as they appear, an exact sum's partials as they grow), every output series
/// (one per quantile or histogram bucket, every point included), and the series arithmetic
/// between metrics queries makes. The charges are at or above what the structures take on a 64-bit
/// target (they take less on wasm32); what is freed is released, so `used` follows what is held
/// and `peak` is its high-water mark.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Meter {
    pub max: u64,
    pub used: u64,
    pub peak: u64,
}

impl Meter {
    pub fn new(max: u64) -> Meter {
        Meter { max, used: 0, peak: 0 }
    }
    /// Charge `n` bytes for `what` before it is made: refused, with nothing charged, when they
    /// would pass `max`.
    pub fn charge(&mut self, n: u64, what: &'static str) -> Result<(), Error> {
        let next = self.used.saturating_add(n);
        if next > self.max {
            return Err(Error::Memory { what, max: self.max, used: next });
        }
        self.used = next;
        self.peak = self.peak.max(next);
        Ok(())
    }
    pub fn release(&mut self, n: u64) {
        self.used = self.used.saturating_sub(n);
    }
}

/// Bytes charged per point of each accumulator (`Acc`), per label, per series entry, and per
/// value of an output series.
const COUNT_POINT: u64 = 8;
const SUM_POINT: u64 = std::mem::size_of::<ExactSum>() as u64 + 1;
const MINMAX_POINT: u64 = 8;
const AVG_POINT: u64 = std::mem::size_of::<ExactSum>() as u64 + 8;
const HIST_POINT: u64 = std::mem::size_of::<Vec<(u32, u64)>>() as u64;
const HIST_BUCKET: u64 = std::mem::size_of::<(u32, u64)>() as u64;
const LABEL: u64 = 96;
const SERIES: u64 = 192;
const VALUE: u64 = 8;

fn val_bytes(v: &Val) -> u64 {
    match v {
        Val::Str(s) => s.len() as u64,
        _ => 0,
    }
}

/// Bytes charged for an output series' labels and its `n` values.
fn series_bytes(labels: &[(String, Val<'static>)], n: usize) -> u64 {
    SERIES + labels.iter().map(|(k, v)| LABEL + k.len() as u64 + val_bytes(v)).sum::<u64>() + VALUE * n as u64
}

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
    /// Per point: (log2 exponent, count), ascending by exponent; and the exponents seen at any
    /// point, ascending (a histogram's output series).
    Hist(Vec<Vec<(u32, u64)>>, Vec<u32>),
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

/// Quantile from log2 buckets (observed behaviour): rank `ceil(p·N)` clamped to `[1, N]`;
/// the bucket that holds it is interpolated exponentially between the previous non-empty
/// bucket's bound (half its own bound for the first one) and its own bound.
pub fn quantile(p: f64, hist: &HashMap<u32, u64>) -> f64 {
    let mut v: Vec<(u32, u64)> = hist.iter().map(|(k, c)| (*k, *c)).collect();
    v.sort_unstable();
    quantile_sorted(p, &v)
}

/// [`quantile`] over buckets sorted by exponent (a point of `Acc::Hist`).
fn quantile_sorted(p: f64, hist: &[(u32, u64)]) -> f64 {
    let total: u64 = hist.iter().map(|x| x.1).sum();
    if total == 0 {
        return 0.0;
    }
    let mut rank = (p * total as f64).ceil();
    if rank.is_nan() || rank < 1.0 {
        rank = 1.0;
    }
    if rank > total as f64 {
        rank = total as f64;
    }
    let mut cum = 0u64;
    let mut prev: Option<f64> = None;
    for &(k, c) in hist {
        let upper = k as f64;
        let lower = prev.unwrap_or(upper - 1.0);
        if (cum + c) as f64 >= rank {
            let frac = (rank - cum as f64) / c as f64;
            return 2f64.powf(lower + frac * (upper - lower));
        }
        cum += c;
        prev = Some(upper);
    }
    0.0
}

/// Add `x` to an exact sum, charging the growth of its partials before it can happen (an add
/// pushes at most one partial). Returns the bytes charged.
fn grow(meter: &mut Meter, s: &mut ExactSum, x: f64) -> Result<u64, Error> {
    let cap = s.partials.capacity();
    let mut more = 0;
    if s.partials.len() == cap {
        more = 8 * cap.max(4) as u64;
        meter.charge(more, "sums")?;
        s.partials.reserve_exact(cap.max(4));
    }
    s.add(x);
    Ok(more)
}

struct Leaf<'q> {
    pipeline: &'q [Stage],
    func: &'q MetricsFn,
    by: &'q [FieldExpr],
    series: HashMap<Vec<GroupKey>, (Vec<Val<'static>>, Acc)>,
    /// What the accumulators and their keys are charged, released when they are let go; the
    /// output series reserved for them stay charged (they become the answer).
    held: u64,
    /// Bytes of the `by` fields' text, a label key of every output series.
    by_text: u64,
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
    /// Bytes an accumulator of `n` points takes when made (before any histogram bucket or sum
    /// partial is added to it).
    fn acc_bytes(&self, n: usize) -> u64 {
        let per = match self.func {
            MetricsFn::Rate | MetricsFn::CountOverTime => COUNT_POINT,
            MetricsFn::SumOverTime(_) => SUM_POINT,
            MetricsFn::MinOverTime(_) | MetricsFn::MaxOverTime(_) => MINMAX_POINT,
            MetricsFn::AvgOverTime(_) => AVG_POINT,
            MetricsFn::QuantileOverTime(..) | MetricsFn::HistogramOverTime(_) => HIST_POINT,
        };
        per.saturating_mul(n as u64)
    }

    fn new_acc(&self, n: usize) -> Acc {
        match self.func {
            MetricsFn::Rate | MetricsFn::CountOverTime => Acc::Count(vec![0; n]),
            MetricsFn::SumOverTime(_) => Acc::Sum(vec![ExactSum::default(); n], vec![false; n]),
            MetricsFn::MinOverTime(_) => Acc::Min(vec![f64::NAN; n]),
            MetricsFn::MaxOverTime(_) => Acc::Max(vec![f64::NAN; n]),
            MetricsFn::AvgOverTime(_) => Acc::Avg(vec![ExactSum::default(); n], vec![0; n]),
            MetricsFn::QuantileOverTime(..) | MetricsFn::HistogramOverTime(_) => Acc::Hist(vec![Vec::new(); n], Vec::new()),
        }
    }

    /// Output series a group's accumulator makes in `finish`, reserved when the group is made:
    /// one, or one per quantile. A histogram makes one per bucket the group sees, each reserved
    /// when the bucket first appears in the group.
    fn outputs(&self) -> usize {
        match self.func {
            MetricsFn::QuantileOverTime(_, qs) => qs.len(),
            MetricsFn::HistogramOverTime(_) => 0,
            _ => 1,
        }
    }

    /// What one output series of a group with these values is charged ([`series_bytes`] of the
    /// labels `finish` gives it, at most one per `by` field and one more, and its `n` values).
    fn output_bytes(&self, vals: &[Val<'static>], n: usize) -> u64 {
        SERIES + (self.by.len() as u64 + 1) * LABEL + 48 + self.by_text + vals.iter().map(val_bytes).sum::<u64>() + VALUE * n as u64
    }

    fn observe(&mut self, trace: &Trace, req: &RangeRequest, n: usize, max_series: usize, meter: &mut Meter) -> Result<(), Error> {
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
                    // The group's key and labels (each value twice) and its accumulator, and the
                    // output series it will make (one per quantile): charged before any is made.
                    let labels_text: u64 = labels.iter().map(|v| 2 * (LABEL + val_bytes(v))).sum();
                    let bytes = SERIES + labels_text + self.acc_bytes(n);
                    let outputs = self.output_bytes(&labels, n).saturating_mul(self.outputs() as u64);
                    meter.charge(bytes.saturating_add(outputs), "series")?;
                    self.held += bytes;
                    let acc = self.new_acc(n);
                    self.series.insert(key.clone(), (labels, acc));
                }
                let arg_val = self.func.arg().map(|e| crate::eval::field_value(e, &mut ctx, i).into_owned());
                let out_bytes = self.output_bytes(self.series.get(&key).map_or(&[][..], |x| &x.0), n);
                let Some((_, acc)) = self.series.get_mut(&key) else { continue };
                match acc {
                    Acc::Count(c) => c[k] += 1,
                    // NaN values are skipped by sums and averages, as Tempo's average and
                    // min/max do (observed); they carry no value.
                    Acc::Sum(s, has) => {
                        if let Some(x) = arg_val.as_ref().and_then(metric_value).filter(|x| !x.is_nan()) {
                            self.held += grow(meter, &mut s[k], x)?;
                            has[k] = true;
                        }
                    }
                    Acc::Min(m) => {
                        // NaN values are skipped, so the result does not depend on order.
                        if let Some(x) = arg_val.as_ref().and_then(metric_value).filter(|x| !x.is_nan()) {
                            // -0.0 is below 0.0 here, so equal zeros do not depend on order.
                            if m[k].is_nan() || x < m[k] || (x == m[k] && x.is_sign_negative() && !m[k].is_sign_negative()) {
                                m[k] = x;
                            }
                        }
                    }
                    Acc::Max(m) => {
                        if let Some(x) = arg_val.as_ref().and_then(metric_value).filter(|x| !x.is_nan()) {
                            if m[k].is_nan() || x > m[k] || (x == m[k] && m[k].is_sign_negative() && !x.is_sign_negative()) {
                                m[k] = x;
                            }
                        }
                    }
                    Acc::Avg(s, c) => {
                        if let Some(x) = arg_val.as_ref().and_then(metric_value).filter(|x| !x.is_nan()) {
                            self.held += grow(meter, &mut s[k], x)?;
                            c[k] += 1;
                        }
                    }
                    Acc::Hist(h, seen) => {
                        if let Some(b) = arg_val.as_ref().and_then(bucket) {
                            // A histogram's output series for a bucket the group has not seen:
                            // every point of it, reserved before the bucket is counted.
                            if matches!(self.func, MetricsFn::HistogramOverTime(_)) {
                                if let Err(j) = seen.binary_search(&b) {
                                    meter.charge(out_bytes + 16, "histogram series")?;
                                    seen.insert(j, b);
                                }
                            }
                            let p = &mut h[k];
                            match p.binary_search_by_key(&b, |x| x.0) {
                                Ok(j) => p[j].1 += 1,
                                Err(j) => {
                                    // A new bucket at this point: charged before the vector grows.
                                    if p.len() == p.capacity() {
                                        let more = HIST_BUCKET * p.capacity().max(2) as u64;
                                        meter.charge(more, "histogram buckets")?;
                                        self.held += more;
                                        p.reserve_exact(p.capacity().max(2));
                                    }
                                    p.insert(j, (b, 1));
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn finish(self, req: &RangeRequest, n: usize, meter: &mut Meter) -> Result<Vec<Series>, Error> {
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
        // Every output series was charged when its group (or, for a histogram, its bucket) was
        // made, so making it here charges nothing more.
        let emit = |out: &mut Vec<Series>, labels: Vec<(String, Val<'static>)>, values: &dyn Fn() -> Vec<f64>| -> Result<(), Error> {
            out.push(Series { labels, values: values() });
            Ok(())
        };
        let scale = match self.func.arg() {
            Some(e) if is_duration(e) => 1e-9,
            _ => 1.0,
        };
        for (_, (vals, acc)) in self.series.iter() {
            let labels = if self.by.is_empty() { name_label(self.func.name()) } else { series_labels(vals) };
            match acc {
                Acc::Count(c) => emit(&mut out, labels, &|| c.iter().map(|&x| if matches!(self.func, MetricsFn::Rate) { x as f64 / step_s } else { x as f64 }).collect())?,
                Acc::Sum(s, has) => emit(&mut out, labels, &|| s.iter().zip(has).map(|(s, h)| if *h { s.value() } else { f64::NAN }).collect())?,
                Acc::Min(m) | Acc::Max(m) => emit(&mut out, labels, &|| m.clone())?,
                Acc::Avg(s, c) => emit(&mut out, labels, &|| s.iter().zip(c).map(|(s, c)| if *c > 0 { s.value() / *c as f64 } else { f64::NAN }).collect())?,
                // A series that never had a countable value is not returned (Tempo returns
                // none for quantiles of a float attribute, for instance).
                Acc::Hist(h, _) if h.iter().all(|b| b.is_empty()) => {}
                Acc::Hist(h, _) => match self.func {
                    MetricsFn::QuantileOverTime(_, qs) => {
                        for q in qs {
                            let mut l = if self.by.is_empty() { Vec::new() } else { by_labels(vals) };
                            l.push(("p".to_string(), Val::Float(*q)));
                            emit(&mut out, l, &|| h.iter().map(|b| quantile_sorted(*q, b) * scale).collect())?;
                        }
                    }
                    _ => {
                        let mut buckets: Vec<u32> = h.iter().flat_map(|b| b.iter().map(|x| x.0)).collect();
                        buckets.sort_unstable();
                        buckets.dedup();
                        for b in buckets {
                            let mut l = if self.by.is_empty() { Vec::new() } else { by_labels(vals) };
                            l.push(("__bucket".to_string(), Val::Float(2f64.powi(b as i32) * scale)));
                            emit(&mut out, l, &|| h.iter().map(|m| m.binary_search_by_key(&b, |x| x.0).map_or(0, |j| m[j].1) as f64).collect())?;
                        }
                    }
                },
            }
        }
        // `count_over_time()` and `rate()` without `by` always return their one series.
        if out.is_empty() && self.by.is_empty() && matches!(self.func, MetricsFn::Rate | MetricsFn::CountOverTime) {
            let labels = name_label(self.func.name());
            meter.charge(series_bytes(&labels, n), "series")?;
            emit(&mut out, labels, &|| vec![0.0; n])?;
        }
        // The accumulators are let go with `self`.
        meter.release(self.held);
        Ok(out)
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
    evaluate_with(src, m, plan, req, max_series, max_points, &mut Meter::new(u64::MAX))
}

/// [`evaluate`] with what it holds counted by `meter` as it is made ([`Meter`]): refused, with
/// `Error::Memory`, before the structure that would pass its `max`. On success `meter.used`
/// is what the series returned are charged.
pub fn evaluate_with(
    src: &dyn SpanSource,
    m: &MetricsExpr,
    plan: &ReadPlan,
    req: &RangeRequest,
    max_series: usize,
    max_points: u64,
    meter: &mut Meter,
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
            MetricsExpr::Query { pipeline, func, by, .. } => {
                let by_text = by.iter().map(|e| expr_text(e).len() as u64).sum();
                Some(Leaf { pipeline, func, by, series: HashMap::new(), held: 0, by_text })
            }
            _ => None,
        })
        .collect();
    let mut stats = crate::Stats::default();
    src.traces(plan, &mut |t: &Trace| {
        stats.inspected_traces += 1;
        stats.inspected_spans += t.spans.len() as u64;
        for leaf in accs.iter_mut() {
            leaf.observe(t, req, n, max_series, meter)?;
        }
        Ok(())
    })?;
    let mut results: Vec<Vec<Series>> = Vec::with_capacity(accs.len());
    for l in accs {
        results.push(l.finish(req, n, meter)?);
    }
    results.reverse();
    let out = combine(m, &mut results, n, meter)?;
    let mut kept = Vec::with_capacity(out.len());
    for s in out {
        if s.values.iter().any(|v| !v.is_nan()) {
            kept.push(s);
        } else {
            meter.release(series_bytes(&s.labels, n));
        }
    }
    kept.sort_by(|a, b| label_sort_key(&a.labels).cmp(&label_sort_key(&b.labels)));
    Ok((kept, stats))
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

fn combine(m: &MetricsExpr, results: &mut Vec<Vec<Series>>, n: usize, meter: &mut Meter) -> Result<Vec<Series>, Error> {
    match m {
        MetricsExpr::Query { second, .. } => {
            let s = results.pop().unwrap_or_default();
            Ok(apply_second(s, second, n, meter))
        }
        MetricsExpr::Scalar(v) => {
            meter.charge(series_bytes(&[], n), "series")?;
            Ok(vec![Series { labels: Vec::new(), values: vec![*v; n] }])
        }
        MetricsExpr::Math { op, lhs, rhs, second } => {
            let l = combine(lhs, results, n, meter)?;
            let r = combine(rhs, results, n, meter)?;
            let out = math(*op, l, r, matches!(**lhs, MetricsExpr::Scalar(_)), matches!(**rhs, MetricsExpr::Scalar(_)), n, meter)?;
            Ok(apply_second(out, second, n, meter))
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

/// Arithmetic between two metrics queries' series. Each series it makes is charged before it
/// is made; its inputs are released when they are let go, at the end.
fn math(op: BinOp, l: Vec<Series>, r: Vec<Series>, l_scalar: bool, r_scalar: bool, n: usize, meter: &mut Meter) -> Result<Vec<Series>, Error> {
    let inputs: u64 = l.iter().chain(r.iter()).map(|s| series_bytes(&s.labels, n)).sum();
    let mut zip = |a: &Series, b: &Series, labels: Vec<(String, Val<'static>)>| -> Result<Series, Error> {
        meter.charge(series_bytes(&labels, n), "series")?;
        Ok(Series { labels, values: a.values.iter().zip(&b.values).map(|(x, y)| binop(op, *x, *y)).collect() })
    };
    let out: Vec<Series> = if r_scalar {
        let s = &r[0];
        l.iter().map(|a| zip(a, s, a.labels.clone())).collect::<Result<_, _>>()?
    } else if l_scalar {
        let s = &l[0];
        r.iter().map(|b| zip(s, b, b.labels.clone())).collect::<Result<_, _>>()?
    } else if l.is_empty() || r.is_empty() {
        Vec::new()
    } else {
        match (unlabeled(&l), unlabeled(&r)) {
            (true, true) => {
                let name = |s: &Series| match s.labels.first() {
                    Some((_, Val::Str(n))) => n.to_string(),
                    _ => String::new(),
                };
                let label = format!("({} {} {})", name(&l[0]), op.text(), name(&r[0]));
                vec![zip(&l[0], &r[0], vec![("__name__".to_string(), Val::Str(label.into()))])?]
            }
            (true, false) => r.iter().map(|b| zip(&l[0], b, b.labels.clone())).collect::<Result<_, _>>()?,
            (false, true) => l.iter().map(|a| zip(a, &r[0], a.labels.clone())).collect::<Result<_, _>>()?,
            (false, false) => {
                let mut out = Vec::new();
                for a in &l {
                    let ka = label_sort_key(&a.labels);
                    if let Some(b) = r.iter().find(|b| label_sort_key(&b.labels) == ka) {
                        out.push(zip(a, b, a.labels.clone())?);
                    }
                }
                out
            }
        }
    };
    drop((l, r));
    meter.release(inputs);
    Ok(out)
}

fn apply_second(mut s: Vec<Series>, second: &[SecondStage], n: usize, meter: &mut Meter) -> Vec<Series> {
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
        s.retain(|x| {
            let keep = x.values.iter().any(|v| !v.is_nan());
            if !keep {
                meter.release(series_bytes(&x.labels, n));
            }
            keep
        });
    }
    s
}
