//! Data model shared by the evaluator and by `SeriesSource` implementations.

use std::fmt;
use std::sync::Arc;

use regex::Regex;

/// The metric name label.
pub const NAME_LABEL: &str = "__name__";

/// Bit pattern of the Prometheus staleness marker. It is a NaN, but a specific
/// one: any layer that canonicalises NaN payloads destroys it.
pub const STALE_NAN_BITS: u64 = 0x7ff0_0000_0000_0002;

/// The staleness marker as an `f64`.
pub fn stale_nan() -> f64 {
    f64::from_bits(STALE_NAN_BITS)
}

/// True if `v` is exactly the staleness marker (not just any NaN).
pub fn is_stale_nan(v: f64) -> bool {
    v.to_bits() == STALE_NAN_BITS
}

/// Errors returned by parsing, planning and evaluation.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// The query text was rejected by the parser.
    Parse(String),
    /// The query is valid PromQL but uses something this engine does not
    /// implement. Returned instead of a wrong answer.
    Unsupported(String),
    /// The query is valid and supported but failed during evaluation, with
    /// the same wording Prometheus uses where practical (for example
    /// duplicate series in one-to-one matching).
    Eval(String),
    /// The `SeriesSource` failed.
    Source(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Parse(m) => write!(f, "parse error: {m}"),
            Error::Unsupported(m) => write!(f, "unsupported: {m}"),
            Error::Eval(m) => write!(f, "{m}"),
            Error::Source(m) => write!(f, "source error: {m}"),
        }
    }
}

impl std::error::Error for Error {}

/// Label matcher operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MatchOp {
    /// `=`
    Eq,
    /// `!=`
    Ne,
    /// `=~` (regex, fully anchored)
    Re,
    /// `!~` (regex, fully anchored)
    Nre,
}

impl MatchOp {
    /// The PromQL spelling, which is also the `op` string of `contracts/engine.ts`.
    pub fn as_str(&self) -> &'static str {
        match self {
            MatchOp::Eq => "=",
            MatchOp::Ne => "!=",
            MatchOp::Re => "=~",
            MatchOp::Nre => "!~",
        }
    }
}

/// A Prometheus label matcher.
///
/// Semantics every `SeriesSource` must honour:
/// * a label that is absent from a series has the value `""`;
/// * `Re`/`Nre` patterns are fully anchored (`^(?:value)$`), with `.`
///   matching newlines, as in Prometheus.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Matcher {
    pub name: String,
    pub op: MatchOp,
    pub value: String,
}

impl Matcher {
    pub fn new(name: impl Into<String>, op: MatchOp, value: impl Into<String>) -> Self {
        Matcher { name: name.into(), op, value: value.into() }
    }

    /// Compile into a form that can be applied to many series.
    pub fn compile(&self) -> Result<CompiledMatcher, Error> {
        let re = match self.op {
            MatchOp::Re | MatchOp::Nre => Some(compile_anchored(&self.value)?),
            _ => None,
        };
        Ok(CompiledMatcher { name: self.name.clone(), op: self.op, value: self.value.clone(), re })
    }
}

/// Compile a PromQL regex with Prometheus anchoring.
pub fn compile_anchored(pattern: &str) -> Result<Regex, Error> {
    Regex::new(&format!("^(?s:{pattern})$"))
        .map_err(|e| Error::Parse(format!("invalid regular expression {pattern:?}: {e}")))
}

/// A matcher with its regex compiled. Helper for `SeriesSource` implementations.
#[derive(Debug, Clone)]
pub struct CompiledMatcher {
    pub name: String,
    pub op: MatchOp,
    pub value: String,
    re: Option<Regex>,
}

impl CompiledMatcher {
    /// Does this matcher accept the given label value (`""` for a missing label)?
    pub fn matches_value(&self, v: &str) -> bool {
        match self.op {
            MatchOp::Eq => v == self.value,
            MatchOp::Ne => v != self.value,
            MatchOp::Re => self.re.as_ref().is_some_and(|r| r.is_match(v)),
            MatchOp::Nre => !self.re.as_ref().is_some_and(|r| r.is_match(v)),
        }
    }

    /// Does this matcher accept a series with these (sorted) labels?
    pub fn matches(&self, labels: &[(String, String)]) -> bool {
        let v = labels.iter().find(|(n, _)| *n == self.name).map(|(_, v)| v.as_str()).unwrap_or("");
        self.matches_value(v)
    }
}

/// One series as handed over by a `SeriesSource`.
#[derive(Debug, Clone, PartialEq)]
pub struct Series {
    /// Label pairs sorted by name, unique names, including `__name__`.
    pub labels: Vec<(String, String)>,
    /// Sample timestamps in Unix milliseconds, strictly ascending.
    pub ts: Vec<i64>,
    /// Sample values, same length as `ts`. Staleness markers are passed
    /// through as `STALE_NAN_BITS`; the evaluator interprets them.
    pub values: Vec<f64>,
}

/// Where the evaluator gets samples from. The only data-access seam of the crate.
///
/// Contract:
/// * return every series that satisfies *all* `matchers` and has at least one
///   sample with `min_ts_ms <= t <= max_ts_ms` (both inclusive). Returning
///   series with no samples in range is allowed;
/// * samples outside the range may be included (the evaluator re-filters),
///   but every sample inside the range must be present;
/// * within a series, `ts` is strictly ascending and already de-duplicated;
/// * label sets are unique across the returned series and sorted by name;
/// * staleness markers must keep their exact NaN bit pattern;
/// * the order of the returned series does not matter.
///
/// The evaluator calls `select` once per selector per (sub)query evaluation,
/// with the tightest range it needs (lookback, range, offset and `@` already
/// applied). `selectors()` reports the same ranges ahead of time.
pub trait SeriesSource {
    fn select(&self, matchers: &[Matcher], min_ts_ms: i64, max_ts_ms: i64) -> Result<Vec<Series>, Error>;
}

/// In-memory `SeriesSource` for tests and small data sets.
#[derive(Debug, Clone, Default)]
pub struct MemSource {
    series: Vec<Series>,
}

impl MemSource {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build from series. Labels are sorted; samples are sorted by time.
    /// Series with equal label sets are merged, later samples winning on
    /// equal timestamps.
    pub fn from_series(series: Vec<Series>) -> Self {
        let mut s = Self::new();
        for x in series {
            s.add(x);
        }
        s
    }

    /// Add samples, merging into an existing series with the same labels.
    pub fn add(&mut self, mut s: Series) {
        s.labels.sort();
        assert_eq!(s.ts.len(), s.values.len(), "ts and values must have equal length");
        let mut pts: Vec<(i64, f64)> = s.ts.iter().copied().zip(s.values.iter().copied()).collect();
        if let Some(existing) = self.series.iter_mut().find(|e| e.labels == s.labels) {
            let mut all: Vec<(i64, f64)> = existing.ts.iter().copied().zip(existing.values.iter().copied()).collect();
            all.append(&mut pts);
            pts = all;
            normalise(&mut pts);
            existing.ts = pts.iter().map(|p| p.0).collect();
            existing.values = pts.iter().map(|p| p.1).collect();
        } else {
            normalise(&mut pts);
            s.ts = pts.iter().map(|p| p.0).collect();
            s.values = pts.iter().map(|p| p.1).collect();
            self.series.push(s);
        }
    }

    /// All series, in insertion order.
    pub fn series(&self) -> &[Series] {
        &self.series
    }

    /// Reorder the stored series (used by tests that check order independence).
    pub fn permute(&mut self, f: impl FnOnce(&mut Vec<Series>)) {
        f(&mut self.series);
    }
}

/// Stable sort by time, then keep the last sample of each timestamp.
fn normalise(pts: &mut Vec<(i64, f64)>) {
    pts.sort_by_key(|p| p.0);
    let mut out: Vec<(i64, f64)> = Vec::with_capacity(pts.len());
    for p in pts.iter() {
        match out.last_mut() {
            Some(l) if l.0 == p.0 => *l = *p,
            _ => out.push(*p),
        }
    }
    *pts = out;
}

impl SeriesSource for MemSource {
    fn select(&self, matchers: &[Matcher], min_ts_ms: i64, max_ts_ms: i64) -> Result<Vec<Series>, Error> {
        let compiled: Vec<CompiledMatcher> = matchers.iter().map(|m| m.compile()).collect::<Result<_, _>>()?;
        let mut out = Vec::new();
        for s in &self.series {
            if !compiled.iter().all(|m| m.matches(&s.labels)) {
                continue;
            }
            let lo = s.ts.partition_point(|&t| t < min_ts_ms);
            let hi = s.ts.partition_point(|&t| t <= max_ts_ms);
            if lo >= hi {
                continue;
            }
            out.push(Series { labels: s.labels.clone(), ts: s.ts[lo..hi].to_vec(), values: s.values[lo..hi].to_vec() });
        }
        Ok(out)
    }
}

/// Sorted label set shared between evaluation steps.
pub(crate) type Labels = Arc<Vec<(String, String)>>;

pub(crate) fn label_get<'a>(l: &'a [(String, String)], name: &str) -> &'a str {
    l.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str()).unwrap_or("")
}

/// Labels that describe the metric rather than the series: removed whenever
/// an operation changes what the value means.
pub(crate) fn is_metadata_label(name: &str) -> bool {
    name == NAME_LABEL || name == "__type__" || name == "__unit__"
}

/// Format a float the way Prometheus does in API responses and in
/// `count_values`: shortest decimal that round-trips, never an exponent,
/// with `NaN`, `+Inf` and `-Inf` for the specials.
pub fn format_float(v: f64) -> String {
    if v.is_nan() {
        "NaN".to_string()
    } else if v == f64::INFINITY {
        "+Inf".to_string()
    } else if v == f64::NEG_INFINITY {
        "-Inf".to_string()
    } else {
        format!("{v}")
    }
}
