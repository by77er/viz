//! Split execution (DESIGN §6.2): leaves evaluate the inner part of a query over a
//! disjoint set of series and return partial aggregates; the coordinator merges them and
//! finishes the evaluation. The result is identical, byte for byte, to evaluating the
//! whole query in one place (`crate::query_range_with`), which uses the same
//! order-independent aggregations (`crate::agg`).
//!
//! ## What runs where
//!
//! A **fragment** is an aggregation node whose operator decomposes (`sum`, `avg`,
//! `count`, `group`, `min`, `max`, `stddev`, `stdvar`, `topk`, `bottomk`,
//! `count_values`), which is not inside a subquery (it is evaluated on the query's own
//! steps), and whose argument is **series-local**: the value it gives each series depends
//! only on that series' own samples. Series-local is: one selector (instant or inside a
//! range function), range functions (`rate`, `increase`, `irate`, `delta`, `*_over_time`
//! except `absent_over_time`, `deriv`, `predict_linear`, ..., also over a subquery whose
//! inner expression is series-local), element-wise functions (`abs`, `round`, `clamp`,
//! `timestamp`, date functions with an argument, ...), `label_replace`, `label_join`,
//! `sort`, unary minus, and binary operators against a scalar that reads no data
//! (number literals, `time()`, `pi()` and arithmetic of them).
//!
//! The query is split when every selector in it is inside a fragment. The leaves
//! evaluate each fragment (the aggregation over their own series) into a
//! `crate::agg::Partial`; everything above the fragments (binary operators between
//! aggregates, `histogram_quantile` over `sum by (le)`, `quantile` or another aggregation
//! of aggregates, `scalar`, `sort`, ...) runs at the coordinator over the merged
//! fragments. Anything else (a selector outside every aggregation, `quantile` or
//! `absent` over raw series, a binary operator between two vectors inside an
//! aggregation, an aggregation inside a subquery, delayed name removal) is evaluated in
//! one place, and [`split_plan`] says why.
//!
//! ## The split key
//!
//! Every series belongs to exactly one part, so every sample of a series reaches exactly
//! one leaf and per-series functions see the whole series. The key of a series is the
//! FNV-1a hash of its labels without the labels in `SplitKey::without` (which is exactly
//! its `series_id` when it carries none of them); part `j` of `L` owns the keys in
//! `[j * 2^64 / L, (j + 1) * 2^64 / L)`: contiguous key ranges.
//!
//! `without` holds the labels the fragments' inner expressions may change: the target of
//! `label_replace`/`label_join`, and `__name__`, `__type__`, `__unit__` when they are
//! dropped (`__name__` only when the selector does not pin it with `=`). Two series can
//! only end up with the same labels inside a fragment (the evaluator's "same labelset"
//! merge or error) if they agree on every label outside `without`, so such series always
//! share a leaf and the leaf's evaluator merges or refuses them exactly as one place does.
//!
//! ## Data flow (the query Worker does the I/O)
//!
//! 1. Readers ([`extract`]) take a group of files (sample files with the series files that
//!    describe them, in precedence order) and return, as one `VZB1` batch, the rows of the
//!    plan's ranges that belong to one part. They find the part's series from the
//!    `metric_series` files first (`crate::catalog`) and hand `viz_storage::select` only
//!    those, so they decode only the part's samples. A file is read by every part that
//!    needs it: that is the cost of splitting by series over files that are cut by time.
//! 2. The coordinator splits the shard tails by part ([`split_tails`]).
//! 3. A leaf gathers its extracts and tail batches ([`Gathered`]): per series, samples in
//!    precedence order (a later file wins, any tail batch wins over the lake), the same
//!    rule as `viz_storage::select`, so a `rate` window that straddles lake and tail sees
//!    one ordered, de-duplicated stream (I17). Gathering stops as soon as the leaf holds
//!    more samples or series than its budget.
//! 4. The leaf evaluates its fragments ([`leaf_evaluate`]) and returns their partials with
//!    the series and samples each `select` loaded.
//! 5. The coordinator ([`merge_range`], [`merge_instant`]) replays the query's limits on
//!    the summed counts in the order one-place evaluation checks them, merges the
//!    partials, and evaluates the rest of the query with the fragments replaced by their
//!    merged values.
use crate::agg::{self, AggOp, In, LabelSet, Out, Partial};
use crate::catalog;
use crate::error::{ErrorType, Limit, QueryError};
use crate::plan::FetchRange;
use crate::{InstantResult, Options, RangeResult, Stats};
use promql_parser::label::MatchOp as PMatchOp;
use promql_parser::parser::{AggregateExpr, Expr, VectorSelector};
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use viz_promql::{CompiledMatcher, EvalHooks, Matcher, Series, SeriesSource, SeriesV, Value, NAME_LABEL};
use viz_storage::batch::{self, Row, SeriesDef, MAX_TS, MIN_TS};

// ───────────────────────────────── plan ─────────────────────────────────

/// Which part a series belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SplitKey {
    /// Labels left out of the key hash (sorted, unique).
    pub without: Vec<String>,
}

impl SplitKey {
    /// The key of a series: FNV-1a over its labels without `without` (its `series_id`
    /// when it has none of them).
    pub fn key<N: AsRef<str>, V: AsRef<str>>(&self, labels: &[(N, V)]) -> u64 {
        if self.without.is_empty() || !labels.iter().any(|(n, _)| self.without.iter().any(|w| w == n.as_ref())) {
            return batch::series_id(labels) as u64;
        }
        let kept: Vec<(&str, &str)> =
            labels.iter().filter(|(n, _)| !self.without.iter().any(|w| w == n.as_ref())).map(|(n, v)| (n.as_ref(), v.as_ref())).collect();
        batch::series_id(&kept) as u64
    }

    /// The part of `parts` that owns `key`: contiguous ranges of the key space.
    pub fn part_of(key: u64, parts: u32) -> u32 {
        ((key as u128 * parts as u128) >> 64) as u32
    }

    pub fn part<N: AsRef<str>, V: AsRef<str>>(&self, labels: &[(N, V)], parts: u32) -> u32 {
        Self::part_of(self.key(labels), parts)
    }
}

/// How a query is executed.
#[derive(Debug, Clone, PartialEq)]
pub enum SplitPlan {
    /// In one place, and why it cannot be split.
    Single { reason: String },
    /// Over leaves: `fragments` aggregations are evaluated there, split by `key`.
    Split { fragments: usize, key: SplitKey },
}

const RANGE_FNS: &[&str] = &[
    "rate", "increase", "delta", "irate", "idelta", "resets", "changes", "avg_over_time", "sum_over_time", "min_over_time", "max_over_time",
    "count_over_time", "last_over_time", "first_over_time", "stddev_over_time", "stdvar_over_time", "quantile_over_time", "present_over_time",
    "mad_over_time", "ts_of_min_over_time", "ts_of_max_over_time", "ts_of_first_over_time", "ts_of_last_over_time", "deriv", "predict_linear",
    "double_exponential_smoothing",
];

const ELEMENTWISE: &[&str] = &[
    "abs", "ceil", "floor", "exp", "sqrt", "ln", "log2", "log10", "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh", "asinh",
    "acosh", "atanh", "rad", "deg", "sgn", "round", "clamp", "clamp_min", "clamp_max", "timestamp", "days_in_month", "day_of_month", "day_of_week",
    "day_of_year", "hour", "minute", "month", "year",
];

fn unparen(e: &Expr) -> &Expr {
    let mut e = e;
    while let Expr::Paren(p) = e {
        e = &p.expr;
    }
    e
}

/// A scalar that reads no data: number literals, `time()`, `pi()`, and arithmetic of them.
fn data_free_scalar(e: &Expr) -> bool {
    match e {
        Expr::NumberLiteral(_) => true,
        Expr::Paren(p) => data_free_scalar(&p.expr),
        Expr::Unary(u) => data_free_scalar(&u.expr),
        Expr::Binary(b) => !b.op.is_set_operator() && data_free_scalar(&b.lhs) && data_free_scalar(&b.rhs),
        Expr::Call(c) => matches!(c.func.name, "time" | "pi") && c.args.args.is_empty(),
        _ => false,
    }
}

/// What a series-local expression does to labels.
#[derive(Default)]
struct Local {
    /// Labels it may set or remove (`label_replace`/`label_join` targets).
    set: BTreeSet<String>,
    /// It drops the metric name (and `__type__`, `__unit__`) somewhere.
    dropped: bool,
    /// The selector pins `__name__` with `=`.
    pinned: bool,
}

fn pinned(vs: &VectorSelector) -> bool {
    vs.name.is_some() || vs.matchers.matchers.iter().any(|m| m.name == NAME_LABEL && matches!(m.op, PMatchOp::Equal))
}

fn selector_local(vs: &VectorSelector) -> Result<Local, String> {
    if !vs.matchers.or_matchers.is_empty() {
        return Err("`or` inside a label matcher list".into());
    }
    Ok(Local { pinned: pinned(vs), ..Local::default() })
}

/// Is `e` an instant vector whose value for each series depends only on that series?
fn series_local(e: &Expr) -> Result<Local, String> {
    match e {
        Expr::Paren(p) => series_local(&p.expr),
        Expr::VectorSelector(vs) => selector_local(vs),
        Expr::Unary(u) => {
            let mut l = series_local(&u.expr)?;
            l.dropped = true;
            Ok(l)
        }
        Expr::Binary(b) => {
            if b.op.is_set_operator() {
                return Err(format!("the set operator `{}` matches series against each other", b.op));
            }
            if b.modifier.as_ref().is_some_and(|m| m.fill_values.lhs.is_some() || m.fill_values.rhs.is_some()) {
                return Err("fill modifiers".into());
            }
            let side = if data_free_scalar(&b.lhs) {
                &b.rhs
            } else if data_free_scalar(&b.rhs) {
                &b.lhs
            } else {
                return Err("a binary operation between two vectors (or a scalar that reads data) matches series against each other".into());
            };
            let mut l = series_local(side)?;
            let return_bool = b.modifier.as_ref().is_some_and(|m| m.return_bool);
            if !b.op.is_comparison_operator() || return_bool {
                l.dropped = true;
            }
            Ok(l)
        }
        Expr::Call(c) => {
            let name = c.func.name;
            let args: Vec<&Expr> = c.args.args.iter().map(|a| a.as_ref()).collect();
            if RANGE_FNS.contains(&name) {
                let m = if name == "quantile_over_time" { 1 } else { 0 };
                for (i, a) in args.iter().enumerate() {
                    if i != m && !data_free_scalar(a) {
                        return Err(format!("a parameter of `{name}` reads data"));
                    }
                }
                let mut l = match args.get(m).map(|a| unparen(a)) {
                    Some(Expr::MatrixSelector(ms)) => selector_local(&ms.vs)?,
                    Some(Expr::Subquery(sq)) => series_local(&sq.expr)?,
                    _ => return Err(format!("`{name}` without a range selector")),
                };
                if name != "last_over_time" && name != "first_over_time" {
                    l.dropped = true;
                }
                Ok(l)
            } else if ELEMENTWISE.contains(&name) {
                let Some(first) = args.first() else { return Err(format!("`{name}()` without an argument reads no series")) };
                for a in &args[1..] {
                    if !data_free_scalar(a) {
                        return Err(format!("a parameter of `{name}` reads data"));
                    }
                }
                let mut l = series_local(first)?;
                l.dropped = true;
                Ok(l)
            } else if name == "label_replace" || name == "label_join" {
                let Some(first) = args.first() else { return Err(format!("`{name}` without arguments")) };
                let mut l = series_local(first)?;
                for a in &args[1..] {
                    if !matches!(unparen(a), Expr::StringLiteral(_)) {
                        return Err(format!("a parameter of `{name}` is not a string literal"));
                    }
                }
                match args.get(1).map(|a| unparen(a)) {
                    Some(Expr::StringLiteral(s)) => {
                        l.set.insert(s.val.clone());
                    }
                    _ => return Err(format!("`{name}` without a target label")),
                }
                Ok(l)
            } else if name == "sort" || name == "sort_desc" {
                match args.first() {
                    Some(a) => series_local(a),
                    None => Err(format!("`{name}` without an argument")),
                }
            } else {
                Err(format!("`{name}` depends on other series"))
            }
        }
        Expr::Aggregate(a) => Err(format!("an aggregation (`{}`) inside an aggregation is split at the inner one", a.op)),
        Expr::Subquery(_) | Expr::MatrixSelector(_) => Err("a range vector where an instant vector is expected".into()),
        _ => Err("not an instant vector of series".into()),
    }
}

/// Can this aggregation be a fragment? `Ok` gives the labels its argument may change.
fn fragment(a: &AggregateExpr) -> Result<BTreeSet<String>, String> {
    let name = a.op.to_string();
    let Some(op) = AggOp::parse(&name) else { return Err(format!("`{name}` does not decompose")) };
    match op {
        AggOp::TopK | AggOp::BottomK => match &a.param {
            Some(p) if data_free_scalar(p) => {}
            _ => return Err(format!("the parameter of `{name}` reads data")),
        },
        AggOp::CountValues => match a.param.as_deref().map(unparen) {
            Some(Expr::StringLiteral(s)) if !s.val.is_empty() && !s.val.contains('\u{fffd}') => {}
            _ => return Err("`count_values` without a valid label name".into()),
        },
        _ => {}
    }
    let l = series_local(&a.expr)?;
    let mut x = l.set;
    if l.dropped {
        x.insert("__type__".into());
        x.insert("__unit__".into());
        if !l.pinned {
            x.insert(NAME_LABEL.into());
        }
    }
    Ok(x)
}

struct Analysis<'a> {
    fragments: Vec<&'a Expr>,
    without: BTreeSet<String>,
    rejected: Option<String>,
    uncovered: Option<String>,
}

/// Visit in evaluation order (binary operands left first, an aggregation's parameter
/// before its argument, call arguments in order). True if every selector below is
/// inside a fragment.
fn visit<'a>(e: &'a Expr, in_subquery: bool, a: &mut Analysis<'a>) -> bool {
    match e {
        Expr::Aggregate(agg) => {
            if in_subquery {
                a.rejected.get_or_insert_with(|| "an aggregation inside a subquery is evaluated on the subquery's steps".into());
            } else {
                match fragment(agg) {
                    Ok(x) => {
                        a.fragments.push(e);
                        a.without.extend(x);
                        return true;
                    }
                    Err(why) => {
                        a.rejected.get_or_insert(why);
                    }
                }
            }
            let mut ok = true;
            if let Some(p) = &agg.param {
                ok &= visit(p, in_subquery, a);
            }
            ok &= visit(&agg.expr, in_subquery, a);
            ok
        }
        Expr::VectorSelector(_) | Expr::MatrixSelector(_) => {
            let why = a.rejected.clone().unwrap_or_else(|| "a selector outside any aggregation".into());
            a.uncovered.get_or_insert(why);
            false
        }
        Expr::Subquery(sq) => visit(&sq.expr, true, a),
        Expr::Paren(p) => visit(&p.expr, in_subquery, a),
        Expr::Unary(u) => visit(&u.expr, in_subquery, a),
        Expr::Binary(b) => {
            let l = visit(&b.lhs, in_subquery, a);
            let r = visit(&b.rhs, in_subquery, a);
            l && r
        }
        Expr::Call(c) => {
            let mut ok = true;
            for x in &c.args.args {
                ok &= visit(x, in_subquery, a);
            }
            ok
        }
        Expr::NumberLiteral(_) | Expr::StringLiteral(_) => true,
        Expr::Extension(_) => {
            a.uncovered.get_or_insert("an extension expression".into());
            false
        }
    }
}

/// The fragments of a parsed query in evaluation order and the split key, or why the
/// query is evaluated in one place.
pub fn fragments<'a>(root: &'a Expr, opts: &Options) -> Result<(Vec<&'a Expr>, SplitKey), String> {
    if opts.eval.delayed_name_removal {
        return Err("delayed name removal".into());
    }
    if matches!(unparen(root), Expr::MatrixSelector(_) | Expr::Subquery(_)) {
        return Err("a range vector at the top level".into());
    }
    let mut a = Analysis { fragments: Vec::new(), without: BTreeSet::new(), rejected: None, uncovered: None };
    let covered = visit(root, false, &mut a);
    if !covered {
        return Err(a.uncovered.or(a.rejected).unwrap_or_else(|| "not decomposable".into()));
    }
    if a.fragments.is_empty() {
        return Err(a.rejected.unwrap_or_else(|| "no selector: nothing to split".into()));
    }
    Ok((a.fragments, SplitKey { without: a.without.into_iter().collect() }))
}

/// How `query` is executed: split over leaves, or in one place and why. Parse errors and
/// limits on the query text are reported by evaluating it (in one place).
pub fn split_plan(query: &str, opts: &Options) -> SplitPlan {
    if let Err(e) = opts.limits.check_query(query) {
        return SplitPlan::Single { reason: e.message };
    }
    let root = match viz_promql::parse_query(query) {
        Ok(r) => r,
        Err(e) => return SplitPlan::Single { reason: format!("{e}") },
    };
    match fragments(&root, opts) {
        Ok((f, key)) => SplitPlan::Split { fragments: f.len(), key },
        Err(reason) => SplitPlan::Single { reason },
    }
}

// ─────────────────────────── ranges and matchers ───────────────────────────

/// The plan's ranges with compiled matchers: which samples of a series a split needs.
struct RangeFilter {
    ranges: Vec<(Vec<CompiledMatcher>, i64, i64)>,
}

impl RangeFilter {
    fn new(ranges: &[FetchRange]) -> Result<RangeFilter, QueryError> {
        let mut out = Vec::with_capacity(ranges.len());
        for r in ranges {
            let ms = r.matchers.iter().map(|m| m.compile()).collect::<Result<Vec<_>, _>>().map_err(QueryError::from_promql)?;
            out.push((ms, r.min_ts, r.max_ts));
        }
        Ok(RangeFilter { ranges: out })
    }

    /// The time ranges of the ranges whose matchers the series matches.
    fn intervals(&self, labels: &[(String, String)]) -> Vec<(i64, i64)> {
        self.ranges.iter().filter(|(ms, _, _)| ms.iter().all(|m| m.matches(labels))).map(|(_, lo, hi)| (*lo, *hi)).collect()
    }
}

fn within(iv: &[(i64, i64)], t: i64) -> bool {
    iv.iter().any(|(lo, hi)| t >= *lo && t <= *hi)
}

/// A timestamp storage can hold that no range covers (for the carrier batch's rows).
pub(crate) fn outside(ranges: &[FetchRange]) -> Option<i64> {
    let covered = |t: i64| ranges.iter().any(|r| t >= r.min_ts && t <= r.max_ts);
    let mut cands = vec![MAX_TS, MIN_TS];
    for r in ranges {
        cands.push(r.max_ts.saturating_add(1));
        cands.push(r.min_ts.saturating_sub(1));
    }
    cands.into_iter().find(|t| (MIN_TS..=MAX_TS).contains(t) && !covered(*t))
}

fn names_of(ranges: &[FetchRange]) -> Option<BTreeSet<Vec<u8>>> {
    let mut names = BTreeSet::new();
    for r in ranges {
        let n = r.matchers.iter().find(|m| m.name == NAME_LABEL && m.op == viz_promql::MatchOp::Eq)?;
        names.insert(n.value.as_bytes().to_vec());
    }
    Some(names)
}

// ───────────────────────────────── readers ─────────────────────────────────

/// What a reader returns for one part.
#[derive(Debug, Clone, PartialEq)]
pub struct Extract {
    /// A `VZB1` batch with the part's rows of the plan's ranges (empty: no rows).
    pub batch: Vec<u8>,
    pub rows: u64,
    pub series: u64,
    /// Series of the part whose `series_id` lies in another part's range (their split key is
    /// not their id: they carry a label of `SplitKey::without`). A reader that read only its
    /// part's id range of the sample files (`crate::part_plan`) may have missed their rows,
    /// and must read what `crate::sample_plan` with the part says and extract again.
    pub strays: u64,
}

/// The rows of part `part` of `parts` in `sample_files` (in precedence order, lowest
/// first) for `ranges`, as one batch. `series_files` must describe every series of the
/// sample files (the files written with them). Only the part's series are handed to
/// `viz_storage::select`, so only their samples are kept in memory.
pub fn extract(series_files: &[&[u8]], sample_files: &[&[u8]], key: &SplitKey, part: u32, parts: u32, ranges: &[FetchRange]) -> Result<Extract, QueryError> {
    let empty = Extract { batch: Vec::new(), rows: 0, series: 0, strays: 0 };
    if ranges.is_empty() || sample_files.is_empty() {
        return Ok(empty);
    }
    let filter = RangeFilter::new(ranges)?;
    let names = names_of(ranges);
    let want = |n: &[u8]| names.as_ref().is_none_or(|s| s.contains(n));
    // (Statistics with min above max are a broken file: keep the group, never panic.)
    let want_range = |lo: &[u8], hi: &[u8]| lo > hi || names.as_ref().is_none_or(|s| s.range(lo.to_vec()..=hi.to_vec()).next().is_some());
    // The part's series that some range may select, by series_id.
    let mut mine: HashMap<i64, LabelSet> = HashMap::new();
    let mut seen: HashMap<i64, bool> = HashMap::new();
    for (fi, f) in series_files.iter().enumerate() {
        catalog::for_each_series(f, fi, &want_range, &want, &mut |row| {
            if seen.contains_key(&row.series_id) {
                return Ok(());
            }
            let labels = catalog::parse_labels(row.labels_json)?;
            let keep = key.part(&labels, parts) == part && !filter.intervals(&labels).is_empty();
            seen.insert(row.series_id, keep);
            if keep {
                mine.insert(row.series_id, labels);
            }
            Ok(())
        })?;
    }
    if mine.is_empty() {
        return Ok(empty);
    }
    let strays = mine.keys().filter(|id| SplitKey::part_of(**id as u64, parts) != part).count() as u64;
    // The carrier: a batch whose series table holds exactly the part's series, so that
    // `select` knows them (and no other) without the series files. Its rows sit at a
    // timestamp no range covers, so `select` never returns them.
    let Some(nowhere) = outside(ranges) else {
        return Err(QueryError::unsupported("split execution: the query's ranges cover every storable timestamp"));
    };
    let mut ids: Vec<i64> = mine.keys().copied().collect();
    ids.sort_unstable();
    let defs: Vec<SeriesDef> = ids.iter().map(|id| SeriesDef { series_id: *id, labels: mine[id].clone() }).collect();
    let rows: Vec<Row> = (0..defs.len()).map(|i| Row::new(i as u32, nowhere, 0.0)).collect();
    let carrier = batch::encode(&defs, &rows).map_err(|e| QueryError::internal(format!("split execution: carrier batch: {e}")))?;
    let input = viz_storage::ScanInput { series_files: Vec::new(), sample_files: sample_files.to_vec(), tail_batches: vec![&carrier[..]] };
    let by_labels: HashMap<&LabelSet, i64> = mine.iter().map(|(id, l)| (l, *id)).collect();

    let mut out_defs: Vec<SeriesDef> = Vec::new();
    let mut slot: HashMap<i64, u32> = HashMap::new();
    let mut out_rows: Vec<Row> = Vec::new();
    for r in ranges {
        let ms: Vec<viz_storage::Matcher> = r.matchers.iter().map(crate::to_storage_matcher).collect();
        let found = viz_storage::select(&input, &ms, r.min_ts, r.max_ts).map_err(QueryError::from_storage)?;
        for s in found {
            let Some(id) = by_labels.get(&s.labels).copied() else { continue };
            let idx = *slot.entry(id).or_insert_with(|| {
                out_defs.push(SeriesDef { series_id: id, labels: s.labels.clone() });
                (out_defs.len() - 1) as u32
            });
            for (t, v) in s.ts.iter().zip(&s.values) {
                if *t != nowhere {
                    out_rows.push(Row { series_idx: idx, ts: *t, value_bits: v.to_bits() });
                }
            }
        }
    }
    if out_rows.is_empty() {
        return Ok(Extract { strays, ..empty });
    }
    let rows = out_rows.len() as u64;
    let series = out_defs.len() as u64;
    let batch = batch::encode(&out_defs, &out_rows).map_err(|e| QueryError::internal(format!("split execution: extract batch: {e}")))?;
    Ok(Extract { batch, rows, series, strays })
}

/// The tail batches cut by part: `out[j]` holds, in the input order, one batch per
/// input batch that has rows of part `j` in the plan's ranges (rows outside every range
/// are dropped). Within a batch the row order is kept, so "the later row wins" still holds.
pub fn split_tails(batches: &[&[u8]], key: &SplitKey, parts: u32, ranges: &[FetchRange]) -> Result<Vec<Vec<Vec<u8>>>, QueryError> {
    let filter = RangeFilter::new(ranges)?;
    let mut out: Vec<Vec<Vec<u8>>> = vec![Vec::new(); parts.max(1) as usize];
    for (bi, bytes) in batches.iter().enumerate() {
        let b = batch::decode(bytes).map_err(|e| QueryError::internal(format!("tail batch {bi}: {e}")))?;
        let mut per: Vec<(Vec<SeriesDef>, Vec<Row>, HashMap<u32, u32>)> = (0..parts.max(1)).map(|_| (Vec::new(), Vec::new(), HashMap::new())).collect();
        let info: Vec<(u32, Vec<(i64, i64)>, LabelSet, i64)> = b
            .series()
            .iter()
            .map(|s| {
                let labels: LabelSet = s.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
                (key.part(&labels, parts.max(1)), filter.intervals(&labels), labels, s.series_id)
            })
            .collect();
        for i in 0..b.n_rows() {
            let si = b.series_idx(i);
            let (part, iv, labels, id) = &info[si as usize];
            let t = b.ts(i);
            if !within(iv, t) {
                continue;
            }
            let (defs, rows, map) = &mut per[*part as usize];
            let idx = *map.entry(si).or_insert_with(|| {
                defs.push(SeriesDef { series_id: *id, labels: labels.clone() });
                (defs.len() - 1) as u32
            });
            rows.push(Row { series_idx: idx, ts: t, value_bits: b.value_bits(i) });
        }
        for (j, (defs, rows, _)) in per.into_iter().enumerate() {
            if !rows.is_empty() {
                out[j].push(batch::encode(&defs, &rows).map_err(|e| QueryError::internal(format!("tail batch {bi}: {e}")))?);
            }
        }
    }
    Ok(out)
}

// ───────────────────────────────── leaves ─────────────────────────────────

/// How much one leaf may hold and load: its share of the query's budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeafBudget {
    pub samples: u64,
    pub series: u64,
    pub step_points: u64,
}

struct GSeries {
    labels: LabelSet,
    ts: Vec<i64>,
    vals: Vec<f64>,
    /// Precedence of the source each sample came from (higher wins on equal timestamps).
    rank: Vec<u32>,
}

/// A leaf's data: per series, the samples of the plan's ranges, gathered from extracts
/// and tail batches in any arrival order. Each batch comes with its precedence (`rank`:
/// file groups in precedence order, then tail batches in order); on equal `(series, ts)`
/// the higher rank wins, so the result is what `viz_storage::select` gives over the same
/// sources in precedence order.
pub struct Gathered {
    filter: RangeFilter,
    index: HashMap<i64, usize>,
    series: Vec<GSeries>,
    samples: u64,
    budget: LeafBudget,
    /// Set once the leaf holds more than its budget: which limit, and how many it held.
    pub aborted: Option<(Limit, u64)>,
}

impl Gathered {
    pub fn new(ranges: &[FetchRange], budget: LeafBudget) -> Result<Gathered, QueryError> {
        Ok(Gathered { filter: RangeFilter::new(ranges)?, index: HashMap::new(), series: Vec::new(), samples: 0, budget, aborted: None })
    }

    /// Distinct samples and series held.
    pub fn counts(&self) -> (u64, u64) {
        (self.samples, self.series.len() as u64)
    }

    /// Add a `VZB1` batch (an extract or a tail batch) with precedence `rank`. Stops (and
    /// sets `aborted`) as soon as the leaf holds more than its budget: both counts are
    /// lower bounds of what evaluation would load (every sample held is in some
    /// selector's range), so the leaf's share is certainly exceeded.
    pub fn add(&mut self, bytes: &[u8], rank: u32) -> Result<(), QueryError> {
        if self.aborted.is_some() || bytes.is_empty() {
            return Ok(());
        }
        let b = batch::decode(bytes).map_err(|e| QueryError::internal(format!("split execution: a gathered batch: {e}")))?;
        let mut slots: Vec<Option<(usize, Vec<(i64, i64)>)>> = Vec::with_capacity(b.series().len());
        for s in b.series() {
            let labels: LabelSet = s.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
            let iv = self.filter.intervals(&labels);
            if iv.is_empty() {
                slots.push(None);
                continue;
            }
            let i = match self.index.get(&s.series_id) {
                Some(i) => *i,
                None => {
                    self.series.push(GSeries { labels, ts: Vec::new(), vals: Vec::new(), rank: Vec::new() });
                    self.index.insert(s.series_id, self.series.len() - 1);
                    self.series.len() - 1
                }
            };
            slots.push(Some((i, iv)));
        }
        for r in 0..b.n_rows() {
            let Some((i, iv)) = &slots[b.series_idx(r) as usize] else { continue };
            let t = b.ts(r);
            if !within(iv, t) {
                continue;
            }
            let v = b.value(r);
            let g = &mut self.series[*i];
            if g.ts.last().is_none_or(|last| t > *last) {
                g.ts.push(t);
                g.vals.push(v);
                g.rank.push(rank);
                self.samples += 1;
            } else {
                match g.ts.binary_search(&t) {
                    Ok(k) => {
                        if rank >= g.rank[k] {
                            g.vals[k] = v;
                            g.rank[k] = rank;
                        }
                    }
                    Err(k) => {
                        g.ts.insert(k, t);
                        g.vals.insert(k, v);
                        g.rank.insert(k, rank);
                        self.samples += 1;
                    }
                }
            }
            if self.samples > self.budget.samples {
                self.aborted = Some((Limit::MaxSamples, self.samples));
                return Ok(());
            }
        }
        let series = self.series.iter().filter(|s| !s.ts.is_empty()).count() as u64;
        if series > self.budget.series {
            self.aborted = Some((Limit::MaxSeries, series));
        }
        Ok(())
    }
}

/// `SeriesSource` over a leaf's gathered data, with its budget and per-call counts.
struct GatheredSource<'g> {
    g: &'g Gathered,
    /// The query's selectors, for the step count of a call (as `StorageSource` finds it).
    plan: Vec<viz_promql::SelectorInfo>,
    default_steps: u64,
    budget: LeafBudget,
    /// Per fragment, each `select` call: (series, samples, steps).
    calls: RefCell<Vec<Vec<(u64, u64, u64)>>>,
    current: std::cell::Cell<usize>,
    failure: RefCell<Option<(Limit, u64)>>,
}

impl SeriesSource for GatheredSource<'_> {
    fn select(&self, matchers: &[Matcher], min: i64, max: i64) -> Result<Vec<Series>, viz_promql::Error> {
        let ms = matchers.iter().map(|m| m.compile()).collect::<Result<Vec<_>, _>>()?;
        let mut out = Vec::new();
        let mut n = 0u64;
        for s in &self.g.series {
            if !ms.iter().all(|m| m.matches(&s.labels)) {
                continue;
            }
            let lo = s.ts.partition_point(|t| *t < min);
            let hi = s.ts.partition_point(|t| *t <= max);
            if hi > lo {
                n += (hi - lo) as u64;
                out.push(Series { labels: s.labels.clone(), ts: s.ts[lo..hi].to_vec(), values: s.vals[lo..hi].to_vec() });
            }
        }
        let steps = self
            .plan
            .iter()
            .filter(|s| s.min_ts_ms == min && s.max_ts_ms == max && s.matchers == matchers)
            .map(|s| s.steps as u64)
            .max()
            .unwrap_or(self.default_steps);
        let mut calls = self.calls.borrow_mut();
        let f = self.current.get();
        if calls.len() <= f {
            calls.resize(f + 1, Vec::new());
        }
        calls[f].push((out.len() as u64, n, steps));
        let series: u64 = calls.iter().flatten().map(|c| c.0).sum();
        let samples: u64 = calls.iter().flatten().map(|c| c.1).sum();
        let fail = if series > self.budget.series {
            Some((Limit::MaxSeries, series))
        } else if samples > self.budget.samples {
            Some((Limit::MaxSamples, samples))
        } else if (out.len() as u64).saturating_mul(steps) > self.budget.step_points {
            Some((Limit::MaxStepPoints, (out.len() as u64).saturating_mul(steps)))
        } else {
            None
        };
        if let Some(f) = fail {
            *self.failure.borrow_mut() = Some(f);
            return Err(viz_promql::Error::Source(format!("the leaf's budget of {} is exceeded", f.0.as_str())));
        }
        Ok(out)
    }
}

/// Captures the partial of one fragment instead of finishing it.
struct Capture<'a> {
    node: &'a AggregateExpr,
    got: RefCell<Option<Partial>>,
}

impl EvalHooks for Capture<'_> {
    fn aggregate(&self, input: &viz_promql::AggregateInput<'_>) -> Option<Result<Vec<SeriesV>, viz_promql::Error>> {
        if !std::ptr::eq(input.expr, self.node) {
            return agg::Canonical.aggregate(input);
        }
        Some(match agg::partial(input) {
            Ok(Some(p)) => {
                *self.got.borrow_mut() = Some(p);
                Ok(Vec::new())
            }
            Ok(None) => Err(viz_promql::Error::Unsupported(format!("split execution: `{}` has no partial form", input.op))),
            Err(e) => Err(e),
        })
    }
}

/// The status of a leaf's answer.
pub const LEAF_OK: u8 = 0;
pub const LEAF_ERROR: u8 = 1;
pub const LEAF_ABORTED: u8 = 2;
const MAGIC: &[u8; 4] = b"VZL1";

/// What a leaf answers, decoded.
#[derive(Debug, Clone, PartialEq)]
pub struct LeafOutput {
    pub status: u8,
    /// Distinct samples and series the leaf held.
    pub gathered: (u64, u64),
    /// Per evaluated fragment, each `select` call it made: (series, samples, steps).
    pub calls: Vec<Vec<(u64, u64, u64)>>,
    /// `LEAF_ERROR`: the evaluation error, and the fragment it occurred in.
    pub error: Option<(QueryError, usize)>,
    /// `LEAF_ABORTED`: the leaf limit exceeded and the count reached.
    pub aborted: Option<(Limit, u64)>,
    /// One partial per evaluated fragment.
    pub partials: Vec<Partial>,
}

fn limit_from(name: &str) -> Option<Limit> {
    [Limit::MaxSamples, Limit::MaxSeries, Limit::MaxStepPoints, Limit::MaxOutputPoints, Limit::MaxQueryBytes, Limit::MaxDepth].into_iter().find(|l| l.as_str() == name)
}

fn error_code(t: ErrorType) -> u8 {
    match t {
        ErrorType::BadData => 1,
        ErrorType::Execution => 2,
        ErrorType::Unsupported => 3,
        ErrorType::Internal => 4,
    }
}

impl LeafOutput {
    /// Binary form. The first 37 bytes are fixed so that a caller can read the status and
    /// counts without decoding the rest: `"VZL1", u8 status, u64 gathered samples, u64
    /// gathered series, u64 loaded samples, u64 loaded series` (little-endian).
    pub fn encode(&self) -> Vec<u8> {
        let mut o = Out(Vec::with_capacity(64));
        o.0.extend_from_slice(MAGIC);
        o.u8(self.status);
        let loaded = self.calls.iter().flatten().fold((0u64, 0u64), |a, c| (a.0 + c.1, a.1 + c.0));
        for v in [self.gathered.0, self.gathered.1, loaded.0, loaded.1] {
            o.0.extend_from_slice(&v.to_le_bytes());
        }
        o.var(self.calls.len() as u64);
        for f in &self.calls {
            o.var(f.len() as u64);
            for (s, n, st) in f {
                o.var(*s);
                o.var(*n);
                o.var(*st);
            }
        }
        match &self.error {
            Some((e, f)) => {
                o.u8(1);
                o.u8(error_code(e.error_type));
                o.str(&e.message);
                match e.limit {
                    Some((l, max, reached)) => {
                        o.u8(1);
                        o.str(l.as_str());
                        o.var(max);
                        o.var(reached);
                    }
                    None => o.u8(0),
                }
                o.var(*f as u64);
            }
            None => o.u8(0),
        }
        match self.aborted {
            Some((l, n)) => {
                o.u8(1);
                o.str(l.as_str());
                o.var(n);
            }
            None => o.u8(0),
        }
        o.var(self.partials.len() as u64);
        for p in &self.partials {
            let mut inner = Out::default();
            p.encode(&mut inner);
            o.bytes(&inner.0);
        }
        o.0
    }

    pub fn decode(bytes: &[u8]) -> Result<LeafOutput, QueryError> {
        let bad = |m: String| QueryError::internal(format!("split execution: a leaf's answer: {m}"));
        if bytes.len() < 37 || &bytes[..4] != MAGIC {
            return Err(bad("not a leaf answer".into()));
        }
        let u = |i: usize| u64::from_le_bytes(bytes[5 + 8 * i..13 + 8 * i].try_into().unwrap_or([0; 8]));
        let status = bytes[4];
        let gathered = (u(0), u(1));
        let mut r = In::new(&bytes[37..]);
        let nf = r.count(1).map_err(bad)?;
        let mut calls = Vec::with_capacity(nf);
        for _ in 0..nf {
            let nc = r.count(3).map_err(bad)?;
            let mut f = Vec::with_capacity(nc);
            for _ in 0..nc {
                f.push((r.var().map_err(bad)?, r.var().map_err(bad)?, r.var().map_err(bad)?));
            }
            calls.push(f);
        }
        let error = if r.u8().map_err(bad)? == 1 {
            let t = match r.u8().map_err(bad)? {
                1 => ErrorType::BadData,
                2 => ErrorType::Execution,
                3 => ErrorType::Unsupported,
                _ => ErrorType::Internal,
            };
            let message = r.str().map_err(bad)?;
            let limit = if r.u8().map_err(bad)? == 1 {
                let name = r.str().map_err(bad)?;
                let (max, reached) = (r.var().map_err(bad)?, r.var().map_err(bad)?);
                limit_from(&name).map(|l| (l, max, reached))
            } else {
                None
            };
            let f = r.var().map_err(bad)? as usize;
            Some((QueryError { error_type: t, message, limit }, f))
        } else {
            None
        };
        let aborted = if r.u8().map_err(bad)? == 1 {
            let name = r.str().map_err(bad)?;
            let n = r.var().map_err(bad)?;
            Some((limit_from(&name).ok_or_else(|| bad(format!("unknown limit {name}")))?, n))
        } else {
            None
        };
        let np = r.count(1).map_err(bad)?;
        let mut partials = Vec::with_capacity(np);
        for _ in 0..np {
            let b = r.bytes().map_err(bad)?;
            let mut pr = In::new(b);
            partials.push(Partial::decode(&mut pr).map_err(bad)?);
        }
        if !r.done() {
            return Err(bad("trailing bytes".into()));
        }
        Ok(LeafOutput { status, gathered, calls, error, aborted, partials })
    }
}

/// Where the query is evaluated: a range query, or an instant query at `time`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grid {
    Range { start: i64, end: i64, step: i64 },
    Instant { time: i64 },
}

impl Grid {
    fn bounds(self) -> (i64, i64, i64) {
        match self {
            Grid::Range { start, end, step } => (start, end, step),
            Grid::Instant { time } => (time, time, 1),
        }
    }
}

/// Evaluate a leaf's fragments over its gathered data. Never fails: errors and aborts
/// are part of the answer, which the coordinator weighs against the other leaves'.
pub fn leaf_evaluate(g: &Gathered, query: &str, grid: Grid, opts: &Options, expect_fragments: usize) -> LeafOutput {
    let (samples, series) = g.counts();
    let mut out = LeafOutput { status: LEAF_OK, gathered: (samples, series), calls: Vec::new(), error: None, aborted: None, partials: Vec::new() };
    if let Some(a) = g.aborted {
        out.status = LEAF_ABORTED;
        out.aborted = Some(a);
        return out;
    }
    let fail = |mut out: LeafOutput, e: QueryError, f: usize| {
        out.status = LEAF_ERROR;
        out.error = Some((e, f));
        out
    };
    let root = match viz_promql::parse_query(query) {
        Ok(r) => r,
        Err(e) => return fail(out, QueryError::from_promql(e), 0),
    };
    let frags = match fragments(&root, opts) {
        Ok((f, _)) if f.len() == expect_fragments => f,
        Ok((f, _)) => return fail(out, QueryError::internal(format!("split execution: the leaf finds {} fragments, the coordinator {expect_fragments}", f.len())), 0),
        Err(why) => return fail(out, QueryError::internal(format!("split execution: the leaf cannot split the query: {why}")), 0),
    };
    let (start, end, step) = grid.bounds();
    let sels = match viz_promql::selectors_with(query, start, end, step, &opts.eval) {
        Ok(s) => s,
        Err(e) => return fail(out, QueryError::from_promql(e), 0),
    };
    let src = GatheredSource {
        g,
        plan: sels,
        default_steps: match grid {
            Grid::Range { start, end, step } => ((end - start) / step.max(1) + 1).max(1) as u64,
            Grid::Instant { .. } => 1,
        },
        budget: g.budget,
        calls: RefCell::new(vec![Vec::new(); frags.len()]),
        current: std::cell::Cell::new(0),
        failure: RefCell::new(None),
    };
    for (fi, node) in frags.iter().enumerate() {
        src.current.set(fi);
        let Expr::Aggregate(a) = node else { return fail(out, QueryError::internal("split execution: a fragment is not an aggregation"), fi) };
        let cap = Capture { node: a, got: RefCell::new(None) };
        let r = match grid {
            Grid::Range { start, end, step } => viz_promql::query_range_expr(&src, node, start, end, step, &opts.eval, Some(&cap)).map(|_| ()),
            Grid::Instant { time } => viz_promql::query_instant_expr(&src, node, time, &opts.eval, Some(&cap)).map(|_| ()),
        };
        out.calls = src.calls.borrow().clone();
        if let Err(e) = r {
            if let Some(f) = src.failure.borrow_mut().take() {
                out.status = LEAF_ABORTED;
                out.aborted = Some(f);
                return out;
            }
            return fail(out, QueryError::from_promql(e), fi);
        }
        match cap.got.into_inner() {
            Some(p) => out.partials.push(p),
            None => {
                // The aggregation was not reached (no steps): an empty partial.
                return fail(out, QueryError::internal("split execution: a fragment produced no partial"), fi);
            }
        }
    }
    out
}

// ─────────────────────────────── coordinator ───────────────────────────────

/// Replaces each fragment by its merged value, and evaluates every other aggregation
/// as one place does.
struct Finish<'a> {
    values: Vec<(&'a Expr, Vec<SeriesV>)>,
}

impl EvalHooks for Finish<'_> {
    fn replace(&self, node: &Expr, _: i64, _: i64, _: i64) -> Option<Result<Vec<SeriesV>, viz_promql::Error>> {
        self.values.iter().find(|(e, _)| std::ptr::eq(*e, node)).map(|(_, v)| Ok(v.clone()))
    }
    fn aggregate(&self, input: &viz_promql::AggregateInput<'_>) -> Option<Result<Vec<SeriesV>, viz_promql::Error>> {
        agg::Canonical.aggregate(input)
    }
}

/// The coordinator holds no data: a selector outside every fragment is a bug, not an
/// empty answer.
struct NoData;

impl SeriesSource for NoData {
    fn select(&self, _: &[Matcher], _: i64, _: i64) -> Result<Vec<Series>, viz_promql::Error> {
        Err(viz_promql::Error::Source("split execution: a selector outside every fragment was evaluated at the coordinator".into()))
    }
}

/// The merged result of the leaves' answers: the query's limits replayed on the summed
/// counts in one-place order, the first error, the merged partials, and the rest of the
/// query evaluated over them. Every answer must be complete (`LEAF_OK` or `LEAF_ERROR`);
/// aborted leaves are the caller's to re-run.
fn merge(query: &str, grid: Grid, opts: &Options, outputs: &[LeafOutput]) -> Result<(Value, Stats), QueryError> {
    opts.limits.check_query(query)?;
    if let Grid::Range { start, end, step } = grid {
        crate::check_range(start, end, step, opts)?;
    }
    let root = viz_promql::parse_query(query).map_err(QueryError::from_promql)?;
    let (frags, _) = fragments(&root, opts).map_err(|why| QueryError::internal(format!("split execution: the query does not split: {why}")))?;
    if outputs.is_empty() {
        return Err(QueryError::internal("split execution: no leaf answered"));
    }
    if let Some(o) = outputs.iter().find(|o| o.status == LEAF_ABORTED) {
        let (l, n) = o.aborted.unwrap_or((Limit::MaxSamples, 0));
        return Err(QueryError::internal(format!("split execution: a leaf stopped at its budget of {} ({n}); re-run it before merging", l.as_str())));
    }
    let (mut series, mut samples) = (0u64, 0u64);
    let mut merged: Vec<Option<Partial>> = vec![None; frags.len()];
    let mut selects = 0u64;
    for f in 0..frags.len() {
        // The selects of fragment f (the same calls on every leaf: they depend on the
        // query, not the data), summed over the leaves, checked as one place checks them.
        let ncalls = outputs.iter().map(|o| o.calls.get(f).map_or(0, |c| c.len())).max().unwrap_or(0);
        for c in 0..ncalls {
            let mut call = (0u64, 0u64, 1u64);
            for o in outputs {
                if let Some(x) = o.calls.get(f).and_then(|cs| cs.get(c)) {
                    call.0 += x.0;
                    call.1 += x.1;
                    call.2 = x.2;
                }
            }
            selects += 1;
            series = series.saturating_add(call.0);
            if series > opts.limits.max_series {
                return Err(QueryError::limit(Limit::MaxSeries, opts.limits.max_series, series, "series loaded"));
            }
            samples = samples.saturating_add(call.1);
            if samples > opts.limits.max_samples {
                return Err(QueryError::limit(Limit::MaxSamples, opts.limits.max_samples, samples, "samples loaded"));
            }
            let cells = call.0.saturating_mul(call.2);
            if cells > opts.limits.max_step_points {
                return Err(QueryError::limit(Limit::MaxStepPoints, opts.limits.max_step_points, cells, "step points (series x steps) for one selector"));
            }
        }
        if let Some((e, _)) = outputs.iter().filter_map(|o| o.error.as_ref()).find(|(_, ef)| *ef == f) {
            return Err(e.clone());
        }
        for o in outputs {
            let p = o.partials.get(f).cloned().ok_or_else(|| QueryError::internal(format!("split execution: a leaf has no partial for fragment {f}")))?;
            match &mut merged[f] {
                None => merged[f] = Some(p),
                Some(m) => m.merge(p).map_err(|e| QueryError::internal(format!("split execution: {e}")))?,
            }
        }
    }
    if let Some((e, _)) = outputs.iter().filter_map(|o| o.error.as_ref()).next() {
        return Err(e.clone());
    }
    let values = frags.iter().zip(merged).map(|(e, p)| (*e, p.map(|p| agg::finish(&p)).unwrap_or_default())).collect();
    let hooks = Finish { values };
    let value = match grid {
        Grid::Range { start, end, step } => Value::Matrix(viz_promql::query_range_expr(&NoData, &root, start, end, step, &opts.eval, Some(&hooks)).map_err(QueryError::from_promql)?),
        Grid::Instant { time } => viz_promql::query_instant_expr(&NoData, &root, time, &opts.eval, Some(&hooks)).map_err(QueryError::from_promql)?,
    };
    let points = match &value {
        Value::Vector(v) => v.len() as u64,
        Value::Scalar { .. } | Value::String { .. } => 1,
        Value::Matrix(m) => m.series.iter().map(|s| s.points.len() as u64).sum(),
    };
    if points > opts.limits.max_output_points {
        return Err(QueryError::limit(Limit::MaxOutputPoints, opts.limits.max_output_points, points, "points in the result"));
    }
    Ok((value, Stats { selects, series, samples, output_points: points }))
}

/// [`merge`] for a range query.
pub fn merge_range(query: &str, start: i64, end: i64, step: i64, opts: &Options, outputs: &[LeafOutput]) -> Result<RangeResult, QueryError> {
    match merge(query, Grid::Range { start, end, step }, opts, outputs)? {
        (Value::Matrix(matrix), stats) => Ok(RangeResult { matrix, stats }),
        _ => Err(QueryError::internal("split execution: a range query gave no matrix")),
    }
}

/// [`merge`] for an instant query.
pub fn merge_instant(query: &str, time: i64, opts: &Options, outputs: &[LeafOutput]) -> Result<InstantResult, QueryError> {
    let (value, stats) = merge(query, Grid::Instant { time }, opts, outputs)?;
    Ok(InstantResult { value, stats })
}
