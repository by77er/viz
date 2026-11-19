//! The syntax tree of a LogQL query.

pub use viz_promql::{MatchOp, Matcher};

/// A parsed query: a log query (returns log lines) or a metric query (returns samples).
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Log(LogExpr),
    Metric(MetricExpr),
}

/// `{selector} | pipeline`.
#[derive(Debug, Clone, PartialEq)]
pub struct LogExpr {
    pub matchers: Vec<Matcher>,
    pub stages: Vec<Stage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineFilterOp {
    /// `|=`
    Contains,
    /// `!=`
    NotContains,
    /// `|~`
    Match,
    /// `!~`
    NotMatch,
    /// `|>`
    Pattern,
    /// `!>`
    NotPattern,
}

impl LineFilterOp {
    pub fn negated(self) -> bool {
        matches!(self, LineFilterOp::NotContains | LineFilterOp::NotMatch | LineFilterOp::NotPattern)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            LineFilterOp::Contains => "|=",
            LineFilterOp::NotContains => "!=",
            LineFilterOp::Match => "|~",
            LineFilterOp::NotMatch => "!~",
            LineFilterOp::Pattern => "|>",
            LineFilterOp::NotPattern => "!>",
        }
    }
}

/// The argument of a line filter.
#[derive(Debug, Clone, PartialEq)]
pub enum FilterArg {
    Str(String),
    /// `ip("…")`
    Ip(String),
}

/// One line filter: an operator and its arguments, chained with `or` (`|= "a" or "b"`).
#[derive(Debug, Clone, PartialEq)]
pub struct LineFilter {
    pub op: LineFilterOp,
    pub args: Vec<FilterArg>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CmpOp {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
}

impl CmpOp {
    pub fn as_str(self) -> &'static str {
        match self {
            CmpOp::Eq => "==",
            CmpOp::Ne => "!=",
            CmpOp::Gt => ">",
            CmpOp::Ge => ">=",
            CmpOp::Lt => "<",
            CmpOp::Le => "<=",
        }
    }
    pub fn apply(self, a: f64, b: f64) -> bool {
        match self {
            CmpOp::Eq => a == b,
            CmpOp::Ne => a != b,
            CmpOp::Gt => a > b,
            CmpOp::Ge => a >= b,
            CmpOp::Lt => a < b,
            CmpOp::Le => a <= b,
        }
    }
}

/// A label filter expression: predicates joined with `and` / `or`.
#[derive(Debug, Clone, PartialEq)]
pub enum LabelFilter {
    /// String matcher (`=`, `!=`, `=~`, `!~` against a string).
    Matcher(Matcher),
    /// Numeric comparison (`status >= 400`).
    Number { name: String, op: CmpOp, value: f64 },
    /// Duration comparison (`latency > 250ms`), in nanoseconds.
    Duration { name: String, op: CmpOp, value: i64 },
    /// Byte-size comparison (`size > 20KB`), in bytes.
    Bytes { name: String, op: CmpOp, value: f64 },
    /// `addr = ip("…")` (`eq` true) or `addr != ip("…")`.
    Ip { name: String, eq: bool, pattern: String },
    And(Box<LabelFilter>, Box<LabelFilter>),
    Or(Box<LabelFilter>, Box<LabelFilter>),
}

/// `dst=src` (rename) or `dst="{{template}}"`.
#[derive(Debug, Clone, PartialEq)]
pub enum LabelFmt {
    Rename { dst: String, src: String },
    Template { dst: String, template: String },
}

/// One item of `drop` / `keep`: a bare name, or a matcher (`name="value"`).
#[derive(Debug, Clone, PartialEq)]
pub enum NameOrMatcher {
    Name(String),
    Matcher(Matcher),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Stage {
    LineFilter(LineFilter),
    LabelFilter(LabelFilter),
    /// `| json` (no parameters) or `| json a="expr", b`.
    Json(Vec<(String, String)>),
    Logfmt { strict: bool, keep_empty: bool, params: Vec<(String, String)> },
    Regexp(String),
    Pattern(String),
    Unpack,
    LineFormat(String),
    LabelFormat(Vec<LabelFmt>),
    Decolorize,
    Drop(Vec<NameOrMatcher>),
    Keep(Vec<NameOrMatcher>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnwrapConv {
    /// No conversion: the value is parsed as a float.
    None,
    /// `duration(…)` / `duration_seconds(…)`: a Go duration, in seconds.
    Duration,
    /// `bytes(…)`.
    Bytes,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Unwrap {
    pub label: String,
    pub conv: UnwrapConv,
    /// Label filters written after the unwrap (`| unwrap x | __error__=""`).
    pub post_filters: Vec<LabelFilter>,
}

/// The range part of a range aggregation: `{…} | pipeline [| unwrap …] [5m] [offset 1h]`.
#[derive(Debug, Clone, PartialEq)]
pub struct LogRange {
    pub log: LogExpr,
    pub unwrap: Option<Unwrap>,
    pub range_ns: i64,
    pub offset_ns: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeOp {
    Rate,
    RateCounter,
    CountOverTime,
    BytesRate,
    BytesOverTime,
    AbsentOverTime,
    SumOverTime,
    AvgOverTime,
    MinOverTime,
    MaxOverTime,
    StddevOverTime,
    StdvarOverTime,
    QuantileOverTime,
    FirstOverTime,
    LastOverTime,
}

impl RangeOp {
    pub fn from_name(s: &str) -> Option<RangeOp> {
        Some(match s {
            "rate" => RangeOp::Rate,
            "rate_counter" => RangeOp::RateCounter,
            "count_over_time" => RangeOp::CountOverTime,
            "bytes_rate" => RangeOp::BytesRate,
            "bytes_over_time" => RangeOp::BytesOverTime,
            "absent_over_time" => RangeOp::AbsentOverTime,
            "sum_over_time" => RangeOp::SumOverTime,
            "avg_over_time" => RangeOp::AvgOverTime,
            "min_over_time" => RangeOp::MinOverTime,
            "max_over_time" => RangeOp::MaxOverTime,
            "stddev_over_time" => RangeOp::StddevOverTime,
            "stdvar_over_time" => RangeOp::StdvarOverTime,
            "quantile_over_time" => RangeOp::QuantileOverTime,
            "first_over_time" => RangeOp::FirstOverTime,
            "last_over_time" => RangeOp::LastOverTime,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            RangeOp::Rate => "rate",
            RangeOp::RateCounter => "rate_counter",
            RangeOp::CountOverTime => "count_over_time",
            RangeOp::BytesRate => "bytes_rate",
            RangeOp::BytesOverTime => "bytes_over_time",
            RangeOp::AbsentOverTime => "absent_over_time",
            RangeOp::SumOverTime => "sum_over_time",
            RangeOp::AvgOverTime => "avg_over_time",
            RangeOp::MinOverTime => "min_over_time",
            RangeOp::MaxOverTime => "max_over_time",
            RangeOp::StddevOverTime => "stddev_over_time",
            RangeOp::StdvarOverTime => "stdvar_over_time",
            RangeOp::QuantileOverTime => "quantile_over_time",
            RangeOp::FirstOverTime => "first_over_time",
            RangeOp::LastOverTime => "last_over_time",
        }
    }
    /// Functions over log lines (no unwrap allowed).
    pub fn log_only(self) -> bool {
        matches!(self, RangeOp::CountOverTime | RangeOp::BytesRate | RangeOp::BytesOverTime)
    }
    /// Functions that need an unwrapped range.
    pub fn needs_unwrap(self) -> bool {
        matches!(
            self,
            RangeOp::RateCounter
                | RangeOp::SumOverTime
                | RangeOp::AvgOverTime
                | RangeOp::MinOverTime
                | RangeOp::MaxOverTime
                | RangeOp::StddevOverTime
                | RangeOp::StdvarOverTime
                | RangeOp::QuantileOverTime
                | RangeOp::FirstOverTime
                | RangeOp::LastOverTime
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Grouping {
    pub without: bool,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VecOp {
    Sum,
    Avg,
    Min,
    Max,
    Stddev,
    Stdvar,
    Count,
    Topk,
    Bottomk,
    Sort,
    SortDesc,
}

impl VecOp {
    pub fn from_name(s: &str) -> Option<VecOp> {
        Some(match s {
            "sum" => VecOp::Sum,
            "avg" => VecOp::Avg,
            "min" => VecOp::Min,
            "max" => VecOp::Max,
            "stddev" => VecOp::Stddev,
            "stdvar" => VecOp::Stdvar,
            "count" => VecOp::Count,
            "topk" => VecOp::Topk,
            "bottomk" => VecOp::Bottomk,
            "sort" => VecOp::Sort,
            "sort_desc" => VecOp::SortDesc,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            VecOp::Sum => "sum",
            VecOp::Avg => "avg",
            VecOp::Min => "min",
            VecOp::Max => "max",
            VecOp::Stddev => "stddev",
            VecOp::Stdvar => "stdvar",
            VecOp::Count => "count",
            VecOp::Topk => "topk",
            VecOp::Bottomk => "bottomk",
            VecOp::Sort => "sort",
            VecOp::SortDesc => "sort_desc",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Or,
    And,
    Unless,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
}

impl BinOp {
    pub fn as_str(self) -> &'static str {
        match self {
            BinOp::Or => "or",
            BinOp::And => "and",
            BinOp::Unless => "unless",
            BinOp::Add => "+",
            BinOp::Sub => "-",
            BinOp::Mul => "*",
            BinOp::Div => "/",
            BinOp::Mod => "%",
            BinOp::Pow => "^",
            BinOp::Eq => "==",
            BinOp::Ne => "!=",
            BinOp::Gt => ">",
            BinOp::Ge => ">=",
            BinOp::Lt => "<",
            BinOp::Le => "<=",
        }
    }
    pub fn precedence(self) -> u8 {
        match self {
            BinOp::Or => 1,
            BinOp::And | BinOp::Unless => 2,
            BinOp::Eq | BinOp::Ne | BinOp::Gt | BinOp::Ge | BinOp::Lt | BinOp::Le => 3,
            BinOp::Add | BinOp::Sub => 4,
            BinOp::Mul | BinOp::Div | BinOp::Mod => 5,
            BinOp::Pow => 6,
        }
    }
    pub fn is_comparison(self) -> bool {
        matches!(self, BinOp::Eq | BinOp::Ne | BinOp::Gt | BinOp::Ge | BinOp::Lt | BinOp::Le)
    }
    pub fn is_set(self) -> bool {
        matches!(self, BinOp::Or | BinOp::And | BinOp::Unless)
    }
}

/// `on(...)` / `ignoring(...)` and `group_left(...)` / `group_right(...)`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct VectorMatching {
    /// `Some((on, labels))`: `on` when true, `ignoring` when false.
    pub on: Option<(bool, Vec<String>)>,
    /// `Some((left, labels))`: `group_left` when true.
    pub group: Option<(bool, Vec<String>)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MetricExpr {
    Range { op: RangeOp, param: Option<f64>, range: LogRange, grouping: Option<Grouping> },
    Vector { op: VecOp, param: Option<f64>, inner: Box<MetricExpr>, grouping: Option<Grouping> },
    Binary { op: BinOp, lhs: Box<MetricExpr>, rhs: Box<MetricExpr>, bool_mod: bool, matching: VectorMatching },
    Literal(f64),
    /// `vector(s)`
    VectorLit(f64),
    LabelReplace { inner: Box<MetricExpr>, dst: String, replacement: String, src: String, regex: String },
}

impl MetricExpr {
    /// True when the expression is a scalar (literals and arithmetic between them).
    pub fn is_scalar(&self) -> bool {
        match self {
            MetricExpr::Literal(_) => true,
            MetricExpr::Binary { lhs, rhs, .. } => lhs.is_scalar() && rhs.is_scalar(),
            _ => false,
        }
    }

    /// Visit every range aggregation, in source order.
    pub fn ranges<'a>(&'a self, out: &mut Vec<&'a LogRange>) {
        match self {
            MetricExpr::Range { range, .. } => out.push(range),
            MetricExpr::Vector { inner, .. } | MetricExpr::LabelReplace { inner, .. } => inner.ranges(out),
            MetricExpr::Binary { lhs, rhs, .. } => {
                lhs.ranges(out);
                rhs.ranges(out);
            }
            MetricExpr::Literal(_) | MetricExpr::VectorLit(_) => {}
        }
    }
}
