//! Evaluation: log queries (streams) and metric queries (range aggregations over log
//! ranges, then vector operations evaluated by viz-promql's evaluator).

use std::collections::HashMap;
use std::sync::Arc;

use viz_promql::{EvalHooks, EvalOptions, SeriesV};

use crate::ast::*;
use crate::error::Error;
use crate::labels::{label_string, LabelSet, ERROR, ERR_SAMPLE};
use crate::pipeline::{unwrap_value, Pipeline, PostFilters};
use crate::source::{LogSource, SelectRequest};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Forward,
    Backward,
}

/// Query options. `Default` gives Loki's HTTP API defaults.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Options {
    /// Maximum number of log entries a log query returns. Default 100.
    pub limit: u32,
    /// Order of log entries. Default backward (newest first).
    pub direction: Direction,
    /// Maximum steps of a range query. Default 11 000.
    pub max_steps: usize,
    /// The caller's clock, for the `now` template function (the engine has none).
    pub now_ns: Option<i64>,
    /// Maximum number of series a metric query may hold at once. Default 500 000.
    pub max_series: usize,
    /// Bytes the evaluation may hold beyond its source's rows: the label sets its pipeline
    /// makes (stream keys of a log query, series of a metric query), the entries a log query
    /// keeps, a metric query's samples and points, and what the vector operations make, counted
    /// as each is made ([`Meter`]); past it `Error::Memory`, before the thing is built.
    /// Default: no limit.
    pub max_bytes: u64,
}

impl Default for Options {
    fn default() -> Self {
        Options { limit: 100, direction: Direction::Backward, max_steps: 11_000, now_ns: None, max_series: 500_000, max_bytes: u64::MAX }
    }
}

/// The bytes an evaluation holds, counted as each structure is made and refused BEFORE the one
/// that would pass `max` is built (`Options::max_bytes`; design/reviews/signals-end-to-end-r2.md
/// R2-M2: label sets from `regexp` and `label_format` were held uncounted). The charges are at
/// or above what the structures take on a 64-bit target; what is let go is released.
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

/// Bytes charged for a label set held (its vector, and per label its two strings and their
/// headers).
pub(crate) fn labels_bytes(l: &[(String, String)]) -> u64 {
    32 + l.iter().map(|(k, v)| 56 + (k.len() + v.len()) as u64).sum::<u64>()
}
/// Per entry a log query keeps (its tuple, and room for the vector to double), plus its line.
const ENTRY: u64 = 96;
/// Per sample of a metric query's series (`(i64, f64)`, and room to double).
const SAMPLE: u64 = 32;
/// Per point of a range aggregation's output (`Option<f64>`).
const POINT: u64 = 16;
/// Per series or key (map entry, vector header).
const SLOT: u64 = 64;

/// What the query read and returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Stats {
    /// `select` calls made.
    pub selects: u64,
    /// Rows read from the source inside the requested ranges.
    pub lines_processed: u64,
    /// Bytes of those rows' lines.
    pub bytes_processed: u64,
    /// Entries (log queries) or samples (metric queries) after the pipeline.
    pub entries_after_pipeline: u64,
    /// Entries returned (log queries) or points returned (metric queries).
    pub returned: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StreamOut {
    pub labels: Vec<(String, String)>,
    /// `(timestamp_ns, line)`, in the query's direction.
    pub entries: Vec<(i64, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeriesOut {
    pub labels: Vec<(String, String)>,
    /// `(timestamp_ns, value)`, ascending.
    pub points: Vec<(i64, f64)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Data {
    Streams(Vec<StreamOut>),
    Matrix(Vec<SeriesOut>),
    Vector(Vec<(Vec<(String, String)>, i64, f64)>),
    Scalar(i64, f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueryResult {
    pub data: Data,
    pub stats: Stats,
    /// What `data` is charged by the evaluation's meter (`Options::max_bytes`).
    pub held_bytes: u64,
}

/// The evaluation grid: `start + i * step` for `i < n`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Grid {
    pub start: i64,
    pub step: i64,
    pub n: usize,
}

impl Grid {
    pub fn t(&self, i: usize) -> i64 {
        self.start.saturating_add((i as i64).saturating_mul(self.step))
    }
    pub fn last(&self) -> i64 {
        self.t(self.n.saturating_sub(1))
    }
}

// ---------- log queries ----------

pub(crate) fn required_clauses(stages: &[Stage]) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    for s in crate::pipeline::order_stages(stages) {
        match s {
            Stage::LineFilter(f) => match f.op {
                LineFilterOp::Contains => {
                    let lits: Option<Vec<String>> = f
                        .args
                        .iter()
                        .map(|a| match a {
                            FilterArg::Str(s) => Some(s.clone()),
                            FilterArg::Ip(_) => None,
                        })
                        .collect();
                    if let Some(l) = lits {
                        out.push(l);
                    }
                }
                LineFilterOp::Pattern if f.args.len() == 1 => {
                    if let FilterArg::Str(p) = &f.args[0] {
                        if let Ok(p) = crate::pattern::Pattern::parse(p, false) {
                            for l in p.literals() {
                                out.push(vec![l.to_string()]);
                            }
                        }
                    }
                }
                _ => {}
            },
            // Stages that rewrite the line end what can be pushed down.
            Stage::LineFormat(_) | Stage::Unpack | Stage::Decolorize => break,
            _ => {}
        }
    }
    out
}

pub(crate) fn eval_logs(src: &dyn LogSource, e: &LogExpr, start: i64, end: i64, opts: &Options) -> Result<QueryResult, Error> {
    let mut pipeline = Pipeline::compile(&e.stages)?;
    pipeline.now_ns = opts.now_ns;
    let required = required_clauses(&e.stages);
    let mut stats = Stats { selects: 1, ..Stats::default() };
    let limit = opts.limit as usize;
    // What is held beyond the source's rows: every distinct label set an entry was made for
    // (twice: the map's key and the list), and the entries kept (each line a copy).
    let mut meter = Meter::new(opts.max_bytes);
    // Entries: (ts, seq, stream index, line). Kept bounded to about 2 x limit.
    let mut keys: HashMap<Vec<(String, String)>, usize> = HashMap::new();
    let mut key_list: Vec<Vec<(String, String)>> = Vec::new();
    let mut entries: Vec<(i64, u64, usize, String)> = Vec::new();
    let mut seq: u64 = 0;
    let fwd = opts.direction == Direction::Forward;
    let ms = crate::source::compile_matchers(&e.matchers)?;
    let mut err: Option<Error> = None;
    let req = SelectRequest { matchers: &e.matchers, start_ns: start, end_ns: end, required: &required };
    // Entries that share a timestamp are ordered by their stream's labels (ascending in both
    // directions, as observed in Loki), then by arrival (reversed for backward), so that the
    // limit does not depend on the order streams are read in. Entries cut off are released.
    let trim = |entries: &mut Vec<(i64, u64, usize, String)>, keys: &Vec<Vec<(String, String)>>, meter: &mut Meter| {
        entries.sort_by(|a, b| {
            if fwd {
                a.0.cmp(&b.0).then_with(|| keys[a.2].cmp(&keys[b.2])).then(a.1.cmp(&b.1))
            } else {
                b.0.cmp(&a.0).then_with(|| keys[a.2].cmp(&keys[b.2])).then(b.1.cmp(&a.1))
            }
        });
        if entries.len() > limit {
            meter.release(entries[limit..].iter().map(|x| ENTRY + x.3.len() as u64).sum());
        }
        entries.truncate(limit);
    };
    // The slot of a label set, charged when it is first held.
    let mut slot_of = |key: Vec<(String, String)>, keys: &mut HashMap<Vec<(String, String)>, usize>, key_list: &mut Vec<Vec<(String, String)>>, meter: &mut Meter| -> Result<usize, Error> {
        if let Some(i) = keys.get(&key) {
            return Ok(*i);
        }
        meter.charge(SLOT + 2 * labels_bytes(&key), "stream label sets")?;
        let i = key_list.len();
        keys.insert(key.clone(), i);
        key_list.push(key);
        Ok(i)
    };
    let line_only = pipeline.line_only();
    let mut cache: (*const (String, String), usize, bool, Option<usize>) = (std::ptr::null(), 0, false, None);
    src.select(&req, &mut |labels, row| {
        if err.is_some() || row.ts_ns < start || row.ts_ns >= end {
            return;
        }
        if (labels.as_ptr(), labels.len()) != (cache.0, cache.1) {
            cache = (labels.as_ptr(), labels.len(), crate::source::stream_matches(&ms, labels), None);
        }
        if !cache.2 {
            return;
        }
        stats.lines_processed += 1;
        stats.bytes_processed += row.line.len() as u64;
        let (idx, line) = if line_only && row.metadata.is_empty() {
            // Labels pass through unchanged: the stream's slot is computed once.
            if !pipeline.keep_line(&row.line) {
                return;
            }
            stats.entries_after_pipeline += 1;
            if limit == 0 {
                return;
            }
            let idx = match cache.3 {
                Some(i) => i,
                None => match slot_of(labels.to_vec(), &mut keys, &mut key_list, &mut meter) {
                    Ok(i) => {
                        cache.3 = Some(i);
                        i
                    }
                    Err(e) => {
                        err = Some(e);
                        return;
                    }
                },
            };
            (idx, std::borrow::Cow::Borrowed(row.line.as_str()))
        } else {
            let mut ls = LabelSet::new(labels, &row.metadata);
            let Some(line) = pipeline.process(row.ts_ns, &row.line, &mut ls) else { return };
            stats.entries_after_pipeline += 1;
            if limit == 0 {
                return;
            }
            match slot_of(ls.sorted(), &mut keys, &mut key_list, &mut meter) {
                Ok(i) => (i, std::borrow::Cow::Owned(line.into_owned())),
                Err(e) => {
                    err = Some(e);
                    return;
                }
            }
        };
        if let Err(e) = meter.charge(ENTRY + line.len() as u64, "entries") {
            err = Some(e);
            return;
        }
        seq += 1;
        entries.push((row.ts_ns, seq, idx, line.into_owned()));
        if entries.len() >= limit.saturating_mul(2).max(1024) {
            trim(&mut entries, &key_list, &mut meter);
        }
    })?;
    if let Some(e) = err.take() {
        return Err(e);
    }
    trim(&mut entries, &key_list, &mut meter);
    drop(keys);
    let mut streams: Vec<StreamOut> = Vec::new();
    let mut slot: HashMap<usize, usize> = HashMap::new();
    for (ts, _, idx, line) in entries {
        let s = match slot.get(&idx) {
            Some(s) => *s,
            None => {
                // An output stream's labels: a copy, charged before it is made.
                meter.charge(SLOT + labels_bytes(&key_list[idx]), "streams")?;
                streams.push(StreamOut { labels: key_list[idx].clone(), entries: Vec::new() });
                slot.insert(idx, streams.len() - 1);
                streams.len() - 1
            }
        };
        streams[s].entries.push((ts, line));
    }
    streams.sort_by(|a, b| a.labels.cmp(&b.labels));
    stats.returned = streams.iter().map(|s| s.entries.len() as u64).sum();
    Ok(QueryResult { data: Data::Streams(streams), stats, held_bytes: meter.used })
}

// ---------- range aggregations ----------

/// The half-open nanosecond range `[start, end)` a range aggregation reads for a grid.
pub(crate) fn range_bounds(r: &LogRange, grid: &Grid) -> (i64, i64) {
    let lo = grid.start.saturating_sub(r.offset_ns).saturating_sub(r.range_ns).saturating_add(1);
    let hi = grid.last().saturating_sub(r.offset_ns).saturating_add(1);
    (lo, hi)
}

fn group_labels(labels: Vec<(String, String)>, g: &Option<Grouping>) -> Vec<(String, String)> {
    match g {
        None => labels,
        Some(Grouping { without: false, labels: keep }) => labels.into_iter().filter(|(n, _)| keep.contains(n)).collect(),
        Some(Grouping { without: true, labels: drop }) => labels.into_iter().filter(|(n, _)| !drop.contains(n)).collect(),
    }
}

pub(crate) fn pipeline_error(labels: &[(String, String)]) -> Error {
    let err = labels.iter().find(|(n, _)| n == ERROR).map(|(_, v)| v.as_str()).unwrap_or("");
    Error::Eval(format!(
        "pipeline error: '{err}' for series: '{}'.\nUse a label filter to intentionally skip this error. (e.g | __error__!=\"{err}\").\nTo skip all potential errors you can match empty errors.(e.g __error__=\"\")\nThe label filter can also be specified after unwrap. (e.g | unwrap latency | __error__=\"\" )",
        label_string(labels)
    ))
}

/// Prometheus' quantile over a set of values (linear interpolation between ranks).
pub(crate) fn quantile(q: f64, vals: &mut [f64]) -> f64 {
    if vals.is_empty() || q.is_nan() {
        return f64::NAN;
    }
    if q < 0.0 {
        return f64::NEG_INFINITY;
    }
    if q > 1.0 {
        return f64::INFINITY;
    }
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = vals.len() as f64;
    let rank = q * (n - 1.0);
    let lower = rank.floor().max(0.0);
    let upper = (lower + 1.0).min(n - 1.0);
    let w = rank - lower;
    vals[lower as usize] * (1.0 - w) + vals[upper as usize] * w
}

fn mean_var(vals: &[(i64, f64)]) -> (f64, f64) {
    // Welford's algorithm.
    let mut count = 0.0;
    let mut mean = 0.0;
    let mut m2 = 0.0;
    for (_, v) in vals {
        count += 1.0;
        let d = v - mean;
        mean += d / count;
        m2 += d * (v - mean);
    }
    (mean, if count > 0.0 { m2 / count } else { f64::NAN })
}

/// `rate_counter`: the counter's increase over the window (resets compensated) per second
/// of range. Loki (v3.7.10, observed as a black box) extrapolates the sampled interval by the
/// range expressed in milliseconds but added as nanoseconds, so the result is
/// `increase / range * (sampled_ns + range_ms) / sampled_ns`; this reproduces it (see
/// README, "Differences from Loki"). Fewer than two samples give 0.
fn counter_rate(samples: &[(i64, f64)], range_ns: i64) -> f64 {
    if samples.len() < 2 {
        return 0.0;
    }
    let first = samples[0];
    let last = samples[samples.len() - 1];
    let mut increase = last.1 - first.1;
    let mut prev = first.1;
    for &(_, v) in &samples[1..] {
        if v < prev {
            increase += prev;
        }
        prev = v;
    }
    let sampled = (last.0 - first.0) as f64;
    let range_s = range_ns as f64 / 1e9;
    if sampled <= 0.0 {
        return increase / range_s;
    }
    let range_ms = range_ns as f64 / 1e6;
    increase / range_s * ((sampled + range_ms) / sampled)
}

fn aggregate(op: RangeOp, param: Option<f64>, w: &[(i64, f64)], r: &LogRange, unwrapped: bool) -> f64 {
    let secs = r.range_ns as f64 / 1e9;
    let sum = || w.iter().map(|x| x.1).sum::<f64>();
    match op {
        RangeOp::CountOverTime => w.len() as f64,
        RangeOp::Rate if !unwrapped => w.len() as f64 / secs,
        RangeOp::Rate => sum() / secs,
        RangeOp::BytesOverTime => sum(),
        RangeOp::BytesRate => sum() / secs,
        RangeOp::SumOverTime => sum(),
        RangeOp::AvgOverTime => mean_var(w).0,
        RangeOp::MinOverTime => w.iter().map(|x| x.1).fold(f64::NAN, |a, b| if a.is_nan() || b < a { b } else { a }),
        RangeOp::MaxOverTime => w.iter().map(|x| x.1).fold(f64::NAN, |a, b| if a.is_nan() || b > a { b } else { a }),
        RangeOp::StdvarOverTime => mean_var(w).1,
        RangeOp::StddevOverTime => mean_var(w).1.sqrt(),
        RangeOp::QuantileOverTime => {
            let mut v: Vec<f64> = w.iter().map(|x| x.1).collect();
            quantile(param.unwrap_or(f64::NAN), &mut v)
        }
        RangeOp::FirstOverTime => w[0].1,
        RangeOp::LastOverTime => w[w.len() - 1].1,
        RangeOp::RateCounter => counter_rate(w, r.range_ns),
        RangeOp::AbsentOverTime => 1.0,
    }
}

pub(crate) struct RangeCtx<'a> {
    pub src: &'a dyn LogSource,
    pub grid: Grid,
    pub opts: &'a Options,
    pub stats: Stats,
    pub meter: Meter,
}

pub(crate) fn eval_range(
    ctx: &mut RangeCtx<'_>,
    op: RangeOp,
    param: Option<f64>,
    r: &LogRange,
    grouping: &Option<Grouping>,
) -> Result<Vec<SeriesV>, Error> {
    let grid = ctx.grid;
    let mut pipeline = Pipeline::compile(&r.log.stages)?;
    pipeline.now_ns = ctx.opts.now_ns;
    let post = match &r.unwrap {
        Some(u) => Some(PostFilters::compile(&u.post_filters)?),
        None => None,
    };
    let required = required_clauses(&r.log.stages);
    let (lo, hi) = range_bounds(r, &grid);
    let ms = crate::source::compile_matchers(&r.log.matchers)?;
    // Series by label set; `index` maps a label set to its slot. Every label set (the map's
    // key and the series' copy) and every sample is charged before it is held: a pipeline that
    // makes a label set per line (`regexp`, `label_format`) is refused as it grows, not after.
    let mut index: HashMap<Vec<(String, String)>, usize> = HashMap::new();
    let mut series: Vec<(Vec<(String, String)>, Vec<(i64, f64)>)> = Vec::new();
    let mut err: Option<Error> = None;
    let mut meter = ctx.meter;
    let mut key_bytes = 0u64;
    // Per-stream cache: rows of one stream arrive together, so the stream's match and (for
    // pipelines that leave labels alone) its series slot are computed once.
    let line_only = pipeline.line_only() && r.unwrap.is_none();
    let mut cache: (*const (String, String), usize, bool, Option<usize>) = (std::ptr::null(), 0, false, None);
    let mut stats = ctx.stats;
    stats.selects += 1;
    let max_series = ctx.opts.max_series;
    let req = SelectRequest { matchers: &r.log.matchers, start_ns: lo, end_ns: hi, required: &required };
    let unwrapped = r.unwrap.is_some();
    let mut slot = |key: Vec<(String, String)>, series: &mut Vec<(Vec<(String, String)>, Vec<(i64, f64)>)>, meter: &mut Meter| -> Result<usize, Error> {
        if let Some(i) = index.get(&key) {
            return Ok(*i);
        }
        if series.len() >= max_series {
            return Err(Error::Limit(format!("maximum of series ({max_series}) reached for a single query")));
        }
        let b = labels_bytes(&key);
        meter.charge(SLOT + 2 * b, "series label sets")?;
        key_bytes += b;
        index.insert(key.clone(), series.len());
        series.push((key, Vec::new()));
        Ok(series.len() - 1)
    };
    ctx.src.select(&req, &mut |labels, row| {
        if err.is_some() || row.ts_ns < lo || row.ts_ns >= hi {
            return;
        }
        if (labels.as_ptr(), labels.len()) != (cache.0, cache.1) {
            cache = (labels.as_ptr(), labels.len(), crate::source::stream_matches(&ms, labels), None);
        }
        if !cache.2 {
            return;
        }
        stats.lines_processed += 1;
        stats.bytes_processed += row.line.len() as u64;
        if line_only && row.metadata.is_empty() {
            if !pipeline.keep_line(&row.line) {
                return;
            }
            stats.entries_after_pipeline += 1;
            let i = match cache.3 {
                Some(i) => i,
                None => match slot(group_labels(labels.to_vec(), grouping), &mut series, &mut meter) {
                    Ok(i) => {
                        cache.3 = Some(i);
                        i
                    }
                    Err(e) => {
                        err = Some(e);
                        return;
                    }
                },
            };
            if let Err(e) = meter.charge(SAMPLE, "samples") {
                err = Some(e);
                return;
            }
            let value = if matches!(op, RangeOp::BytesOverTime | RangeOp::BytesRate) { row.line.len() as f64 } else { 1.0 };
            series[i].1.push((row.ts_ns, value));
            return;
        }
        let mut ls = LabelSet::new(labels, &row.metadata);
        let Some(line) = pipeline.process(row.ts_ns, &row.line, &mut ls) else { return };
        let value = match (&r.unwrap, op) {
            (None, RangeOp::BytesOverTime | RangeOp::BytesRate) => line.len() as f64,
            (None, _) => 1.0,
            (Some(u), _) => {
                let Some(raw) = ls.get(&u.label).map(str::to_string) else { return };
                match unwrap_value(&raw, u.conv) {
                    Ok(v) => {
                        ls.remove(&u.label);
                        v
                    }
                    Err(details) => {
                        ls.set_error(ERR_SAMPLE, Some(&details));
                        0.0
                    }
                }
            }
        };
        if let Some(p) = &post {
            if !p.keep(&mut ls) {
                return;
            }
        }
        if ls.has_error() {
            err = Some(pipeline_error(&ls.sorted()));
            return;
        }
        stats.entries_after_pipeline += 1;
        match slot(group_labels(ls.sorted(), grouping), &mut series, &mut meter).and_then(|i| meter.charge(SAMPLE, "samples").map(|_| i)) {
            Ok(i) => series[i].1.push((row.ts_ns, value)),
            Err(e) => err = Some(e),
        }
    })?;
    ctx.stats = stats;
    if let Some(e) = err {
        return Err(e);
    }
    // The index's copies of the label sets are let go.
    drop(index);
    meter.release(key_bytes);
    let mut out = Vec::new();
    if op == RangeOp::AbsentOverTime {
        let total: u64 = series.iter().map(|v| v.1.len() as u64).sum();
        meter.charge(8 * total + POINT * grid.n as u64 + SLOT, "points")?;
        ctx.meter = meter;
        let mut all: Vec<i64> = series.iter().flat_map(|v| v.1.iter().map(|x| x.0)).collect();
        all.sort_unstable();
        let mut vals = vec![None; grid.n];
        for (i, slot) in vals.iter_mut().enumerate() {
            let t = grid.t(i).saturating_sub(r.offset_ns);
            let a = all.partition_point(|x| *x <= t.saturating_sub(r.range_ns));
            let b = all.partition_point(|x| *x <= t);
            if a >= b {
                *slot = Some(1.0);
            }
        }
        let mut labels: Vec<(String, String)> = Vec::new();
        for m in &r.log.matchers {
            if m.op == MatchOp::Eq && !labels.iter().any(|(n, _)| *n == m.name) {
                labels.push((m.name.clone(), m.value.clone()));
            }
        }
        labels.sort();
        if vals.iter().any(|v| v.is_some()) {
            out.push(SeriesV { labels: Arc::new(labels), drop_name: false, vals });
        }
        return Ok(out);
    }
    let mut keys = series;
    keys.sort_by(|a, b| a.0.cmp(&b.0));
    for (labels, mut samples) in keys {
        // The series' points, charged before they are made; its samples are let go after.
        meter.charge(POINT * grid.n as u64, "points")?;
        // By time; samples that share a timestamp in a fixed order (by value), so that sums
        // and first/last do not depend on the order rows arrive in.
        samples.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
        let mut vals = vec![None; grid.n];
        let mut any = false;
        for (i, slot) in vals.iter_mut().enumerate() {
            let t = grid.t(i).saturating_sub(r.offset_ns);
            let a = samples.partition_point(|x| x.0 <= t.saturating_sub(r.range_ns));
            let b = samples.partition_point(|x| x.0 <= t);
            if a < b {
                *slot = Some(aggregate(op, param, &samples[a..b], r, unwrapped));
                any = true;
            }
        }
        meter.release(SAMPLE * samples.len() as u64);
        if any {
            out.push(SeriesV { labels: Arc::new(labels), drop_name: false, vals });
        } else {
            meter.release(POINT * grid.n as u64 + SLOT + labels_bytes(&labels));
        }
    }
    ctx.meter = meter;
    Ok(out)
}

// ---------- vector operations through viz-promql ----------

fn prom_num(v: f64) -> String {
    if v.is_nan() {
        "NaN".into()
    } else if v.is_infinite() {
        if v > 0.0 { "Inf".into() } else { "(-Inf)".into() }
    } else if v < 0.0 || (v == 0.0 && v.is_sign_negative()) {
        format!("({v:?})")
    } else {
        format!("{v:?}")
    }
}

fn prom_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn prom_labels(ls: &[String]) -> String {
    ls.join(", ")
}

/// PromQL text for a metric expression whose range aggregations are replaced by the
/// placeholder selectors `__logql_r<i>`, numbered in source order.
pub(crate) fn to_promql(e: &MetricExpr, next: &mut usize) -> Result<String, Error> {
    Ok(match e {
        MetricExpr::Range { .. } => {
            let s = format!("__logql_r{next}");
            *next += 1;
            s
        }
        MetricExpr::Literal(v) => prom_num(*v),
        MetricExpr::VectorLit(v) => format!("vector({})", prom_num(*v)),
        MetricExpr::Vector { op, param, inner, grouping } => {
            let inner = to_promql(inner, next)?;
            match op {
                VecOp::Sort | VecOp::SortDesc => format!("{}({inner})", op.name()),
                _ => {
                    let g = match grouping {
                        None => String::new(),
                        Some(g) => format!(" {} ({})", if g.without { "without" } else { "by" }, prom_labels(&g.labels)),
                    };
                    match param {
                        Some(p) => format!("{}{g} ({}, {inner})", op.name(), prom_num(*p)),
                        None => format!("{}{g} ({inner})", op.name()),
                    }
                }
            }
        }
        MetricExpr::Binary { op, lhs, rhs, bool_mod, matching } => {
            let l = to_promql(lhs, next)?;
            let r = to_promql(rhs, next)?;
            // Between two scalars, LogQL comparisons return 0 or 1 without `bool`.
            let b = op.is_comparison() && (*bool_mod || (lhs.is_scalar() && rhs.is_scalar()));
            let mut m = String::new();
            if b {
                m.push_str(" bool");
            }
            if let Some((on, ls)) = &matching.on {
                m.push_str(&format!(" {}({})", if *on { "on" } else { "ignoring" }, prom_labels(ls)));
            }
            if let Some((left, ls)) = &matching.group {
                m.push_str(&format!(" {}({})", if *left { "group_left" } else { "group_right" }, prom_labels(ls)));
            }
            format!("({l}) {}{m} ({r})", op.as_str())
        }
        MetricExpr::LabelReplace { inner, dst, replacement, src, regex } => {
            let inner = to_promql(inner, next)?;
            // Go regex semantics: translate before handing the pattern to the Rust engine.
            let re = crate::goregex::translate(regex, true).map_err(|e| Error::Eval(e.to_string()))?;
            format!("label_replace({inner}, {}, {}, {}, {})", prom_str(dst), prom_str(replacement), prom_str(src), prom_str(&re))
        }
    })
}

struct Hooks {
    values: Vec<Vec<SeriesV>>,
}

impl EvalHooks for Hooks {
    fn replace(&self, node: &viz_promql::Expr, _s: i64, _e: i64, _st: i64) -> Option<Result<Vec<SeriesV>, viz_promql::Error>> {
        if let viz_promql::Expr::VectorSelector(vs) = node {
            if let Some(i) = vs.name.as_deref().and_then(|n| n.strip_prefix("__logql_r")).and_then(|n| n.parse::<usize>().ok()) {
                return self.values.get(i).map(|v| Ok(v.clone()));
            }
        }
        None
    }
}

pub(crate) fn eval_metric(src: &dyn LogSource, e: &MetricExpr, grid: Grid, instant: bool, opts: &Options) -> Result<QueryResult, Error> {
    let mut ranges: Vec<&MetricExpr> = Vec::new();
    collect_ranges(e, &mut ranges);
    let mut ctx = RangeCtx { src, grid, opts, stats: Stats::default() };
    let mut values = Vec::with_capacity(ranges.len());
    for r in &ranges {
        if let MetricExpr::Range { op, param, range, grouping } = r {
            values.push(eval_range(&mut ctx, *op, *param, range, grouping)?);
        }
    }
    let mut next = 0;
    let text = to_promql(e, &mut next)?;
    let expr = viz_promql::parse_query(&text).map_err(|e| Error::Eval(format!("internal: translated query does not parse: {e}")))?;
    let hooks = Hooks { values };
    let popts = EvalOptions { max_steps: grid.n + 1, ..EvalOptions::default() };
    let empty = viz_promql::MemSource::new();
    let mut stats = ctx.stats;
    let data = if instant {
        match viz_promql::query_instant_expr(&empty, &expr, 0, &popts, Some(&hooks))? {
            viz_promql::Value::Vector(v) => {
                let out: Vec<_> = v.into_iter().map(|s| (s.metric, grid.start, s.value)).collect();
                stats.returned = out.len() as u64;
                Data::Vector(out)
            }
            viz_promql::Value::Scalar { value, .. } => {
                stats.returned = 1;
                Data::Scalar(grid.start, value)
            }
            _ => return Err(Error::Eval("internal: unexpected result type".into())),
        }
    } else {
        let m = viz_promql::query_range_expr(&empty, &expr, 0, grid.n as i64 - 1, 1, &popts, Some(&hooks))?;
        let out: Vec<SeriesOut> = m
            .series
            .into_iter()
            .map(|s| SeriesOut { labels: s.metric, points: s.points.into_iter().map(|(i, v)| (grid.t(i as usize), v)).collect() })
            .collect();
        stats.returned = out.iter().map(|s| s.points.len() as u64).sum();
        Data::Matrix(out)
    };
    Ok(QueryResult { data, stats })
}

pub(crate) fn collect_ranges<'a>(e: &'a MetricExpr, out: &mut Vec<&'a MetricExpr>) {
    match e {
        MetricExpr::Range { .. } => out.push(e),
        MetricExpr::Vector { inner, .. } | MetricExpr::LabelReplace { inner, .. } => collect_ranges(inner, out),
        MetricExpr::Binary { lhs, rhs, .. } => {
            collect_ranges(lhs, out);
            collect_ranges(rhs, out);
        }
        MetricExpr::Literal(_) | MetricExpr::VectorLit(_) => {}
    }
}
