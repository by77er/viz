//! Aggregations whose result does not depend on how their input is split or ordered.
//!
//! Every aggregation the query service evaluates (`sum`, `avg`, `count`, `group`, `min`,
//! `max`, `stddev`, `stdvar`, `topk`, `bottomk`, `count_values`) goes through here, in
//! one place as in split execution, so that both give the same bytes:
//!
//! 1. [`partial`] turns an aggregation's evaluated input (`viz_promql::AggregateInput`)
//!    into a [`Partial`]: per output group and step, a state that holds everything the
//!    result needs and nothing about input order.
//! 2. [`Partial::merge`] combines the partials of disjoint sets of series. It is
//!    associative and commutative, and `merge(partial(A), partial(B)) == partial(A ∪ B)`
//!    for disjoint `A` and `B` (tested as a property in `tests/split.rs`).
//! 3. [`finish`] turns a partial into the aggregation's output vector.
//!
//! [`Canonical`] is the `viz_promql::EvalHooks` that evaluates every aggregation as
//! `finish(partial(input))`; one-place evaluation in this crate uses it.
//!
//! | Operator | State per group and step | Merge | Exact because |
//! |---|---|---|---|
//! | `sum` | exact sum (`exact::ExactSum`) | add | integer arithmetic, rounded once |
//! | `avg` | count and exact sum | add both | the same; the mean is computed from the merged sum |
//! | `count`, `group`, `count_values` | count | add | integers |
//! | `min`, `max` | the extreme so far | the extreme of both | a total order (NaN only if all are NaN; on equal values `-0` beats `+0` for `min`, `+0` for `max`) |
//! | `stddev`, `stdvar` | count, exact sum, exact sum of squares | add | `(nΣx² − (Σx)²)/n²` in integers, rounded once |
//! | `topk`, `bottomk` | the best `k` (value, series) of the split | union, then the best `k` | the ranking is a total order (NaN last, ties by label set), and a series in the global best `k` is in its own split's best `k`: the series that rank before it in its split are a subset of those that rank before it overall, fewer than `k` |
//!
//! What differs from Prometheus (and from `viz-promql` without this hook): sums are exact
//! instead of compensated (they can differ in the last bit; Prometheus' own result depends
//! on its storage order); `stddev`/`stdvar` are exact instead of Welford's running
//! formula; the output of an aggregation is in label order instead of first-seen order
//! (Prometheus' order is its storage order, unspecified); `min`/`max` break the tie
//! between `-0` and `+0` by sign instead of by order. Aggregations under delayed name
//! removal are left to `viz-promql`.

use crate::exact::{Big, ExactSum, ExactVariance, Special};
use std::collections::BTreeMap;
use std::sync::Arc;
use viz_promql::{format_float, AggregateInput, AggregateParam, EvalHooks, NAME_LABEL};

/// A label set: pairs sorted by name.
pub type LabelSet = Vec<(String, String)>;

/// The aggregation operators that decompose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AggOp {
    Sum,
    Avg,
    Count,
    Group,
    Min,
    Max,
    Stddev,
    Stdvar,
    TopK,
    BottomK,
    CountValues,
}

const OPS: [(AggOp, &str); 11] = [
    (AggOp::Sum, "sum"),
    (AggOp::Avg, "avg"),
    (AggOp::Count, "count"),
    (AggOp::Group, "group"),
    (AggOp::Min, "min"),
    (AggOp::Max, "max"),
    (AggOp::Stddev, "stddev"),
    (AggOp::Stdvar, "stdvar"),
    (AggOp::TopK, "topk"),
    (AggOp::BottomK, "bottomk"),
    (AggOp::CountValues, "count_values"),
];

impl AggOp {
    /// The operator as PromQL spells it; `None` for one that does not decompose
    /// (`quantile`, `limitk`, `limit_ratio`).
    pub fn parse(op: &str) -> Option<AggOp> {
        OPS.iter().find(|(_, n)| *n == op).map(|(o, _)| *o)
    }
    pub fn name(self) -> &'static str {
        OPS.iter().find(|(o, _)| *o == self).map(|(_, n)| *n).unwrap_or("?")
    }
    fn code(self) -> u8 {
        OPS.iter().position(|(o, _)| *o == self).unwrap_or(0) as u8
    }
    fn from_code(c: u8) -> Option<AggOp> {
        OPS.get(c as usize).map(|(o, _)| *o)
    }
    fn ranked(self) -> bool {
        matches!(self, AggOp::TopK | AggOp::BottomK)
    }
}

/// The state of one group at one step.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Sum(ExactSum),
    Avg(u64, ExactSum),
    /// `count`, `group`, `count_values`.
    Count(u64),
    /// `min`, `max`.
    Extreme(f64),
    /// `stddev`, `stdvar`.
    Var(ExactVariance),
}

/// `min` of two values as one sequential pass would give it in any order: NaN only if
/// both are NaN; between `-0` and `+0`, `-0`.
fn canon_min(a: f64, b: f64) -> f64 {
    if a.is_nan() {
        b
    } else if b.is_nan() || a < b {
        a
    } else if b < a {
        b
    } else if a.is_sign_negative() {
        a
    } else {
        b
    }
}

/// `max`, likewise; between `-0` and `+0`, `+0`.
fn canon_max(a: f64, b: f64) -> f64 {
    if a.is_nan() {
        b
    } else if b.is_nan() || a > b {
        a
    } else if b > a {
        b
    } else if a.is_sign_positive() {
        a
    } else {
        b
    }
}

impl Cell {
    fn new(op: AggOp) -> Cell {
        match op {
            AggOp::Sum => Cell::Sum(ExactSum::default()),
            AggOp::Avg => Cell::Avg(0, ExactSum::default()),
            AggOp::Min | AggOp::Max => Cell::Extreme(f64::NAN),
            AggOp::Stddev | AggOp::Stdvar => Cell::Var(ExactVariance::default()),
            _ => Cell::Count(0),
        }
    }

    fn add(&mut self, op: AggOp, x: f64, first: bool) {
        match self {
            Cell::Sum(s) => s.add(x),
            Cell::Avg(n, s) => {
                *n += 1;
                s.add(x)
            }
            Cell::Count(n) => *n += 1,
            Cell::Extreme(v) => {
                *v = if first {
                    x
                } else if op == AggOp::Min {
                    canon_min(*v, x)
                } else {
                    canon_max(*v, x)
                }
            }
            Cell::Var(v) => v.add(x),
        }
    }

    fn merge(&mut self, op: AggOp, o: &Cell) -> Result<(), String> {
        match (self, o) {
            (Cell::Sum(a), Cell::Sum(b)) => a.merge(b),
            (Cell::Avg(n, a), Cell::Avg(m, b)) => {
                *n += m;
                a.merge(b)
            }
            (Cell::Count(n), Cell::Count(m)) => *n += m,
            (Cell::Extreme(a), Cell::Extreme(b)) => *a = if op == AggOp::Min { canon_min(*a, *b) } else { canon_max(*a, *b) },
            (Cell::Var(a), Cell::Var(b)) => a.merge(b),
            _ => return Err("partials of different aggregations".into()),
        }
        Ok(())
    }

    fn value(&self, op: AggOp) -> f64 {
        match self {
            Cell::Sum(s) => s.value(),
            Cell::Avg(n, s) => s.mean(*n),
            Cell::Count(n) => {
                if op == AggOp::Group {
                    1.0
                } else {
                    *n as f64
                }
            }
            Cell::Extreme(v) => *v,
            Cell::Var(v) => {
                let var = v.variance();
                if op == AggOp::Stddev {
                    var.sqrt()
                } else {
                    var
                }
            }
        }
    }
}

/// A candidate of `topk`/`bottomk`: its value and its series' labels.
pub type Candidate = (f64, Arc<LabelSet>);

/// The state of one aggregation over a set of series, for every output group and step.
#[derive(Debug, Clone, PartialEq)]
pub struct Partial {
    pub op: AggOp,
    /// Number of steps.
    pub n: usize,
    /// `topk`/`bottomk`: `k` at each step, as the evaluator converts it (`param as i64`).
    pub k: Vec<i64>,
    /// Everything but `topk`/`bottomk`: group labels -> state per step.
    pub groups: BTreeMap<LabelSet, Vec<Option<Cell>>>,
    /// `topk`/`bottomk`: group labels -> per step, the best candidates (at most `k`).
    pub ranked: BTreeMap<LabelSet, Vec<Vec<Candidate>>>,
}

/// `a` ranks strictly before `b` (the evaluator's rule: NaN last, ties to the smaller
/// label set).
fn better(top: bool, a: &Candidate, b: &Candidate) -> bool {
    match (a.0.is_nan(), b.0.is_nan()) {
        (true, true) => a.1 < b.1,
        (true, false) => false,
        (false, true) => true,
        _ => {
            if a.0 == b.0 {
                a.1 < b.1
            } else if top {
                a.0 > b.0
            } else {
                a.0 < b.0
            }
        }
    }
}

fn rank(top: bool, list: &mut Vec<Candidate>, k: i64) {
    list.sort_by(|a, b| {
        if better(top, a, b) {
            std::cmp::Ordering::Less
        } else if better(top, b, a) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    list.truncate(k.max(0) as usize);
}

/// The group of a series, as the evaluator computes it.
pub fn group_labels(labels: &[(String, String)], grouping: &[String], without: bool) -> LabelSet {
    if without {
        labels.iter().filter(|(k, _)| k != NAME_LABEL && !grouping.iter().any(|g| g == k)).cloned().collect()
    } else {
        labels.iter().filter(|(k, _)| grouping.iter().any(|g| g == k)).cloned().collect()
    }
}

fn set_label(l: &[(String, String)], name: &str, value: &str) -> LabelSet {
    let mut out: LabelSet = l.iter().filter(|(k, _)| k != name).cloned().collect();
    if !value.is_empty() {
        out.push((name.to_string(), value.to_string()));
        out.sort();
    }
    out
}

impl Partial {
    fn empty(op: AggOp, n: usize) -> Partial {
        Partial { op, n, k: Vec::new(), groups: BTreeMap::new(), ranked: BTreeMap::new() }
    }

    /// Fold `o` (the partial of a disjoint set of series) into `self`.
    pub fn merge(&mut self, o: Partial) -> Result<(), String> {
        if o.op != self.op || o.n != self.n || o.k != self.k {
            return Err(format!("cannot merge a partial of {} over {} steps into one of {} over {}", o.op.name(), o.n, self.op.name(), self.n));
        }
        let op = self.op;
        for (g, cells) in o.groups {
            match self.groups.get_mut(&g) {
                None => {
                    self.groups.insert(g, cells);
                }
                Some(mine) => {
                    for (m, c) in mine.iter_mut().zip(cells) {
                        match (m.as_mut(), c) {
                            (_, None) => {}
                            (None, Some(c)) => *m = Some(c),
                            (Some(m), Some(c)) => m.merge(op, &c)?,
                        }
                    }
                }
            }
        }
        let top = op == AggOp::TopK;
        for (g, steps) in o.ranked {
            match self.ranked.get_mut(&g) {
                None => {
                    self.ranked.insert(g, steps);
                }
                Some(mine) => {
                    for (i, (m, c)) in mine.iter_mut().zip(steps).enumerate() {
                        m.extend(c);
                        rank(top, m, self.k.get(i).copied().unwrap_or(0));
                    }
                }
            }
        }
        Ok(())
    }
}

/// The partial state of an aggregation over its evaluated input. `Ok(None)` for an
/// operator that does not decompose. Errors are the evaluator's, in its order.
pub fn partial(input: &AggregateInput<'_>) -> Result<Option<Partial>, viz_promql::Error> {
    let Some(op) = AggOp::parse(input.op) else { return Ok(None) };
    let n = input.n;
    let v = input.series;
    if op == AggOp::CountValues {
        let AggregateParam::Label(value_label) = input.param else { return Ok(None) };
        let mut p = Partial::empty(op, n);
        for s in v {
            for (i, x) in s.vals.iter().enumerate() {
                let Some(x) = x else { continue };
                let g = group_labels(&set_label(&s.labels, value_label, &format_float(*x)), input.grouping, input.without);
                let cells = p.groups.entry(g).or_insert_with(|| vec![None; n]);
                match &mut cells[i] {
                    Some(Cell::Count(c)) => *c += 1,
                    other => *other = Some(Cell::Count(1)),
                }
            }
        }
        return Ok(Some(p));
    }
    if op.ranked() {
        let AggregateParam::Scalar(param) = input.param else { return Ok(None) };
        let mut p = Partial::empty(op, n);
        // The evaluator's checks, in its order.
        if n == 0 || param.iter().all(|k| *k < 1.0) {
            p.k = vec![0; n];
            return Ok(Some(p));
        }
        if param.iter().any(|k| k.is_nan()) {
            return Err(viz_promql::Error::Eval("Parameter value is NaN".into()));
        }
        if let Some(k) = param.iter().find(|k| **k <= i64::MIN as f64) {
            return Err(viz_promql::Error::Eval(format!("Scalar value {k} underflows int64")));
        }
        if let Some(k) = param.iter().find(|k| **k >= i64::MAX as f64) {
            return Err(viz_promql::Error::Eval(format!("Scalar value {k} overflows int64")));
        }
        p.k = param.iter().map(|k| *k as i64).collect();
        let top = op == AggOp::TopK;
        let labels: Vec<Arc<LabelSet>> = v.iter().map(|s| Arc::new(s.labels.as_ref().clone())).collect();
        for (si, s) in v.iter().enumerate() {
            let g = group_labels(&s.labels, input.grouping, input.without);
            let steps = p.ranked.entry(g).or_insert_with(|| vec![Vec::new(); n]);
            for (i, x) in s.vals.iter().enumerate() {
                if let Some(x) = x {
                    if p.k[i] >= 1 {
                        steps[i].push((*x, labels[si].clone()));
                    }
                }
            }
        }
        for steps in p.ranked.values_mut() {
            for (i, list) in steps.iter_mut().enumerate() {
                rank(top, list, p.k[i]);
            }
        }
        p.ranked.retain(|_, steps| steps.iter().any(|l| !l.is_empty()));
        return Ok(Some(p));
    }
    let mut p = Partial::empty(op, n);
    for s in v {
        let g = group_labels(&s.labels, input.grouping, input.without);
        let cells = p.groups.entry(g).or_insert_with(|| vec![None; n]);
        for (i, x) in s.vals.iter().enumerate() {
            let Some(x) = x else { continue };
            match &mut cells[i] {
                Some(c) => c.add(op, *x, false),
                slot => {
                    let mut c = Cell::new(op);
                    c.add(op, *x, true);
                    *slot = Some(c);
                }
            }
        }
    }
    p.groups.retain(|_, cells| cells.iter().any(|c| c.is_some()));
    Ok(Some(p))
}

/// The aggregation's output vector: groups (or, for `topk`/`bottomk`, the selected
/// series) in label order; for an instant `topk`/`bottomk`, groups in label order and the
/// series of each group in rank order.
pub fn finish(p: &Partial) -> Vec<viz_promql::SeriesV> {
    let n = p.n;
    if !p.op.ranked() {
        return p
            .groups
            .iter()
            .filter(|(_, cells)| cells.iter().any(|c| c.is_some()))
            .map(|(g, cells)| viz_promql::SeriesV {
                labels: Arc::new(g.clone()),
                drop_name: false,
                vals: cells.iter().map(|c| c.as_ref().map(|c| c.value(p.op))).collect(),
            })
            .collect();
    }
    let top = p.op == AggOp::TopK;
    let mut chosen: BTreeMap<Arc<LabelSet>, Vec<Option<f64>>> = BTreeMap::new();
    let mut order: Vec<Arc<LabelSet>> = Vec::new();
    for steps in p.ranked.values() {
        for (i, list) in steps.iter().enumerate() {
            let mut list = list.clone();
            rank(top, &mut list, p.k.get(i).copied().unwrap_or(0));
            for (x, labels) in list {
                if n == 1 {
                    order.push(labels.clone());
                }
                chosen.entry(labels).or_insert_with(|| vec![None; n])[i] = Some(x);
            }
        }
    }
    let make = |labels: Arc<LabelSet>, vals: Vec<Option<f64>>| viz_promql::SeriesV { labels, drop_name: false, vals };
    if n == 1 {
        order.into_iter().map(|l| {
            let vals = chosen.get(&l).cloned().unwrap_or_default();
            make(l, vals)
        }).collect()
    } else {
        chosen.into_iter().map(|(l, v)| make(l, v)).collect()
    }
}

/// The `viz_promql::EvalHooks` of one-place evaluation: every decomposable aggregation is
/// `finish(partial(input))`.
pub struct Canonical;

impl EvalHooks for Canonical {
    fn aggregate(&self, input: &AggregateInput<'_>) -> Option<Result<Vec<viz_promql::SeriesV>, viz_promql::Error>> {
        if input.delayed_name_removal {
            return None;
        }
        match partial(input) {
            Ok(Some(p)) => Some(Ok(finish(&p))),
            Ok(None) => None,
            Err(e) => Some(Err(e)),
        }
    }
}

// ───────────────────────────── binary encoding ─────────────────────────────

/// A little writer for the partial encoding: LEB128 varints, raw `f64` bits, strings
/// with a length.
#[derive(Default)]
pub struct Out(pub Vec<u8>);

impl Out {
    pub fn var(&mut self, mut v: u64) {
        while v >= 0x80 {
            self.0.push((v as u8) | 0x80);
            v >>= 7;
        }
        self.0.push(v as u8);
    }
    pub fn zig(&mut self, v: i64) {
        self.var(((v << 1) ^ (v >> 63)) as u64)
    }
    pub fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_bits().to_le_bytes());
    }
    pub fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    pub fn str(&mut self, s: &str) {
        self.var(s.len() as u64);
        self.0.extend_from_slice(s.as_bytes());
    }
    pub fn bytes(&mut self, b: &[u8]) {
        self.var(b.len() as u64);
        self.0.extend_from_slice(b);
    }
    pub fn labels(&mut self, l: &[(String, String)]) {
        self.var(l.len() as u64);
        for (k, v) in l {
            self.str(k);
            self.str(v);
        }
    }
    fn big(&mut self, b: &Big) {
        let (lo, words) = b.parts();
        self.var(lo as u64);
        self.var(words.len() as u64);
        for w in words {
            self.0.extend_from_slice(&w.to_le_bytes());
        }
    }
    fn sum(&mut self, s: &ExactSum) {
        self.u8(s.special.nan as u8 | (s.special.pos_inf as u8) << 1 | (s.special.neg_inf as u8) << 2);
        self.big(&s.pos);
        self.big(&s.neg);
    }
}

/// The reader for [`Out`]. Every read is bounds-checked; malformed input is an error.
pub struct In<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> In<'a> {
    pub fn new(b: &'a [u8]) -> In<'a> {
        In { b, at: 0 }
    }
    pub fn done(&self) -> bool {
        self.at == self.b.len()
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(n).filter(|e| *e <= self.b.len()).ok_or("truncated partial")?;
        let s = &self.b[self.at..end];
        self.at = end;
        Ok(s)
    }
    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    pub fn var(&mut self) -> Result<u64, String> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let b = self.u8()?;
            v |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err("varint too long".into())
    }
    /// A count that must be backed by at least `min_bytes` bytes per item.
    pub fn count(&mut self, min_bytes: usize) -> Result<usize, String> {
        let n = self.var()? as usize;
        if n.saturating_mul(min_bytes.max(1)) > self.b.len() - self.at {
            return Err("count larger than the data".into());
        }
        Ok(n)
    }
    pub fn zig(&mut self) -> Result<i64, String> {
        let v = self.var()?;
        Ok((v >> 1) as i64 ^ -((v & 1) as i64))
    }
    pub fn f64(&mut self) -> Result<f64, String> {
        let b = self.take(8)?;
        Ok(f64::from_bits(u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])))
    }
    pub fn str(&mut self) -> Result<String, String> {
        let n = self.count(1)?;
        String::from_utf8(self.take(n)?.to_vec()).map_err(|_| "string is not UTF-8".into())
    }
    pub fn bytes(&mut self) -> Result<&'a [u8], String> {
        let n = self.count(1)?;
        self.take(n)
    }
    pub fn labels(&mut self) -> Result<LabelSet, String> {
        let n = self.count(2)?;
        (0..n).map(|_| Ok((self.str()?, self.str()?))).collect()
    }
    fn big(&mut self) -> Result<Big, String> {
        let lo = self.var()?;
        let n = self.count(8)?;
        let mut words = Vec::with_capacity(n);
        for _ in 0..n {
            let b = self.take(8)?;
            words.push(u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]));
        }
        Big::from_parts(u32::try_from(lo).map_err(|_| "bad big integer")?, words).ok_or_else(|| "big integer out of range".into())
    }
    fn sum(&mut self) -> Result<ExactSum, String> {
        let f = self.u8()?;
        let special = Special { nan: f & 1 != 0, pos_inf: f & 2 != 0, neg_inf: f & 4 != 0 };
        Ok(ExactSum { pos: self.big()?, neg: self.big()?, special })
    }
}

impl Partial {
    /// The binary form that leaves send to the coordinator.
    pub fn encode(&self, out: &mut Out) {
        out.u8(self.op.code());
        out.var(self.n as u64);
        out.var(self.k.len() as u64);
        for k in &self.k {
            out.zig(*k);
        }
        if self.op.ranked() {
            // A table of the series that are candidates anywhere, then indexes into it.
            let mut table: BTreeMap<&Arc<LabelSet>, usize> = BTreeMap::new();
            for steps in self.ranked.values() {
                for list in steps {
                    for (_, l) in list {
                        let next = table.len();
                        table.entry(l).or_insert(next);
                    }
                }
            }
            let mut order: Vec<(&&Arc<LabelSet>, &usize)> = table.iter().collect();
            order.sort_by_key(|(_, i)| **i);
            out.var(order.len() as u64);
            for (l, _) in &order {
                out.labels(l);
            }
            out.var(self.ranked.len() as u64);
            for (g, steps) in &self.ranked {
                out.labels(g);
                for list in steps {
                    out.var(list.len() as u64);
                    for (x, l) in list {
                        out.f64(*x);
                        out.var(table[l] as u64);
                    }
                }
            }
            return;
        }
        out.var(self.groups.len() as u64);
        for (g, cells) in &self.groups {
            out.labels(g);
            for c in cells {
                match c {
                    None => out.u8(0),
                    Some(Cell::Sum(s)) => {
                        out.u8(1);
                        out.sum(s)
                    }
                    Some(Cell::Avg(n, s)) => {
                        out.u8(2);
                        out.var(*n);
                        out.sum(s)
                    }
                    Some(Cell::Count(n)) => {
                        out.u8(3);
                        out.var(*n)
                    }
                    Some(Cell::Extreme(v)) => {
                        out.u8(4);
                        out.f64(*v)
                    }
                    Some(Cell::Var(v)) => {
                        out.u8(5);
                        out.var(v.n);
                        out.sum(&v.sum);
                        out.big(&v.sq)
                    }
                }
            }
        }
    }

    /// Read what [`Partial::encode`] wrote.
    pub fn decode(r: &mut In<'_>) -> Result<Partial, String> {
        let op = AggOp::from_code(r.u8()?).ok_or("unknown aggregation in partial")?;
        let n = r.var()? as usize;
        let nk = r.count(1)?;
        let k = (0..nk).map(|_| r.zig()).collect::<Result<Vec<_>, _>>()?;
        let mut p = Partial { op, n, k, groups: BTreeMap::new(), ranked: BTreeMap::new() };
        if op.ranked() {
            let ns = r.count(1)?;
            let table: Vec<Arc<LabelSet>> = (0..ns).map(|_| r.labels().map(Arc::new)).collect::<Result<_, _>>()?;
            let ng = r.count(1)?;
            for _ in 0..ng {
                let g = r.labels()?;
                let mut steps = Vec::with_capacity(n.min(1 << 20));
                for _ in 0..n {
                    let m = r.count(9)?;
                    let mut list = Vec::with_capacity(m);
                    for _ in 0..m {
                        let x = r.f64()?;
                        let i = r.var()? as usize;
                        list.push((x, table.get(i).ok_or("candidate index out of range")?.clone()));
                    }
                    steps.push(list);
                }
                p.ranked.insert(g, steps);
            }
            return Ok(p);
        }
        let ng = r.count(1)?;
        for _ in 0..ng {
            let g = r.labels()?;
            let mut cells = Vec::with_capacity(n.min(1 << 20));
            for _ in 0..n {
                cells.push(match r.u8()? {
                    0 => None,
                    1 => Some(Cell::Sum(r.sum()?)),
                    2 => Some(Cell::Avg(r.var()?, r.sum()?)),
                    3 => Some(Cell::Count(r.var()?)),
                    4 => Some(Cell::Extreme(r.f64()?)),
                    5 => Some(Cell::Var(ExactVariance { n: r.var()?, sum: r.sum()?, sq: r.big()? })),
                    t => return Err(format!("unknown cell kind {t}")),
                });
            }
            p.groups.insert(g, cells);
        }
        Ok(p)
    }
}
