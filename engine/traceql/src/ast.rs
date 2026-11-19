//! The syntax tree of a TraceQL query after parsing and validation.

use crate::data::{Kind, Status};

/// Byte offset into the query text.
pub type Pos = usize;

/// A literal value.
#[derive(Clone, Debug, PartialEq)]
pub enum Static {
    Nil,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    /// Nanoseconds.
    Duration(i64),
    Status(Status),
    Kind(Kind),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Scope {
    /// `.name`: span attributes first, then resource attributes.
    None,
    Span,
    Resource,
    Event,
    Link,
    Instrumentation,
}

impl Scope {
    pub fn prefix(self) -> &'static str {
        match self {
            Scope::None => "",
            Scope::Span => "span",
            Scope::Resource => "resource",
            Scope::Event => "event",
            Scope::Link => "link",
            Scope::Instrumentation => "instrumentation",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Intrinsic {
    Name,
    Status,
    StatusMessage,
    Duration,
    Kind,
    SpanId,
    ParentId,
    ChildCount,
    TraceDuration,
    TraceRootName,
    TraceRootService,
    TraceId,
    EventName,
    EventTimeSinceStart,
    LinkSpanId,
    LinkTraceId,
    InstrumentationName,
    InstrumentationVersion,
}

/// The static type of an expression, for validation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Type {
    Nil,
    Bool,
    Int,
    Float,
    Duration,
    Str,
    Status,
    Kind,
    /// An attribute: its type is known only per span.
    Attribute,
}

impl Type {
    pub fn numeric(self) -> bool {
        matches!(self, Type::Int | Type::Float | Type::Duration | Type::Attribute)
    }
}

impl Intrinsic {
    pub fn typ(self) -> Type {
        match self {
            Intrinsic::Name
            | Intrinsic::StatusMessage
            | Intrinsic::SpanId
            | Intrinsic::ParentId
            | Intrinsic::TraceRootName
            | Intrinsic::TraceRootService
            | Intrinsic::TraceId
            | Intrinsic::EventName
            | Intrinsic::LinkSpanId
            | Intrinsic::LinkTraceId
            | Intrinsic::InstrumentationName
            | Intrinsic::InstrumentationVersion => Type::Str,
            Intrinsic::Status => Type::Status,
            Intrinsic::Kind => Type::Kind,
            Intrinsic::Duration | Intrinsic::TraceDuration | Intrinsic::EventTimeSinceStart => Type::Duration,
            Intrinsic::ChildCount => Type::Int,
        }
    }
    /// Whether evaluating it needs every span of the trace (or `trace_index`).
    pub fn needs_trace(self) -> bool {
        matches!(
            self,
            Intrinsic::TraceDuration | Intrinsic::TraceRootName | Intrinsic::TraceRootService | Intrinsic::ChildCount
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
    Re,
    NRe,
    And,
    Or,
}

impl BinOp {
    pub fn is_arith(self) -> bool {
        matches!(self, BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod | BinOp::Pow)
    }
    pub fn is_cmp(self) -> bool {
        matches!(self, BinOp::Eq | BinOp::Neq | BinOp::Lt | BinOp::Lte | BinOp::Gt | BinOp::Gte)
    }
    pub fn text(self) -> &'static str {
        match self {
            BinOp::Add => "+",
            BinOp::Sub => "-",
            BinOp::Mul => "*",
            BinOp::Div => "/",
            BinOp::Mod => "%",
            BinOp::Pow => "^",
            BinOp::Eq => "=",
            BinOp::Neq => "!=",
            BinOp::Lt => "<",
            BinOp::Lte => "<=",
            BinOp::Gt => ">",
            BinOp::Gte => ">=",
            BinOp::Re => "=~",
            BinOp::NRe => "!~",
            BinOp::And => "&&",
            BinOp::Or => "||",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnOp {
    Neg,
    Not,
}

/// An expression evaluated per span (inside `{ }`, and as the argument of aggregates,
/// `by()`, `select()` and metrics functions).
#[derive(Clone, Debug, PartialEq)]
pub enum FieldExpr {
    Static(Static),
    /// An attribute and the text it was written as (`span.http.method`, `.foo`).
    Attr { scope: Scope, name: String },
    /// An intrinsic and the text it was written as (`span:status`, `status`).
    Intrinsic(Intrinsic, String),
    Unary(UnOp, Box<FieldExpr>),
    Binary(BinOp, Box<FieldExpr>, Box<FieldExpr>),
    /// A compiled regex comparison: `lhs =~ "re"` (negated for `!~`).
    Regex { lhs: Box<FieldExpr>, re: Box<regex::Regex>, negated: bool, text: String },
}

impl FieldExpr {
    /// True if it reads anything from the span (as opposed to a constant).
    pub fn references_span(&self) -> bool {
        match self {
            FieldExpr::Static(_) => false,
            FieldExpr::Attr { .. } | FieldExpr::Intrinsic(..) => true,
            FieldExpr::Unary(_, e) => e.references_span(),
            FieldExpr::Binary(_, a, b) => a.references_span() || b.references_span(),
            FieldExpr::Regex { lhs, .. } => lhs.references_span(),
        }
    }
    pub fn visit(&self, f: &mut dyn FnMut(&FieldExpr)) {
        f(self);
        match self {
            FieldExpr::Unary(_, e) => e.visit(f),
            FieldExpr::Binary(_, a, b) => {
                a.visit(f);
                b.visit(f);
            }
            FieldExpr::Regex { lhs, .. } => lhs.visit(f),
            _ => {}
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SpansetOp {
    And,
    Or,
    Child,
    Parent,
    Descendant,
    Ancestor,
    Sibling,
    NotChild,
    NotParent,
    NotDescendant,
    NotAncestor,
    NotSibling,
    UnionChild,
    UnionParent,
    UnionDescendant,
    UnionAncestor,
    UnionSibling,
}

impl SpansetOp {
    pub fn is_structural(self) -> bool {
        !matches!(self, SpansetOp::And | SpansetOp::Or)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AggOp {
    Count,
    Avg,
    Min,
    Max,
    Sum,
}

impl AggOp {
    pub fn name(self) -> &'static str {
        match self {
            AggOp::Count => "count",
            AggOp::Avg => "avg",
            AggOp::Min => "min",
            AggOp::Max => "max",
            AggOp::Sum => "sum",
        }
    }
}

/// One element of a spanset pipeline.
#[derive(Clone, Debug, PartialEq)]
pub enum Stage {
    /// `{ expr }`
    Filter(FieldExpr),
    /// `lhs op rhs` between spanset expressions or wrapped pipelines.
    Op(SpansetOp, Box<Stage>, Box<Stage>),
    /// `( a | b | ... )`
    Pipeline(Vec<Stage>),
    /// `agg(expr) op constant`
    ScalarFilter { agg: AggOp, arg: Option<FieldExpr>, op: BinOp, value: Static },
    By(Vec<FieldExpr>),
    Coalesce,
    Select(Vec<FieldExpr>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum MetricsFn {
    Rate,
    CountOverTime,
    MinOverTime(FieldExpr),
    MaxOverTime(FieldExpr),
    AvgOverTime(FieldExpr),
    SumOverTime(FieldExpr),
    QuantileOverTime(FieldExpr, Vec<f64>),
    HistogramOverTime(FieldExpr),
}

impl MetricsFn {
    pub fn name(&self) -> &'static str {
        match self {
            MetricsFn::Rate => "rate",
            MetricsFn::CountOverTime => "count_over_time",
            MetricsFn::MinOverTime(_) => "min_over_time",
            MetricsFn::MaxOverTime(_) => "max_over_time",
            MetricsFn::AvgOverTime(_) => "avg_over_time",
            MetricsFn::SumOverTime(_) => "sum_over_time",
            MetricsFn::QuantileOverTime(..) => "quantile_over_time",
            MetricsFn::HistogramOverTime(_) => "histogram_over_time",
        }
    }
    pub fn arg(&self) -> Option<&FieldExpr> {
        match self {
            MetricsFn::Rate | MetricsFn::CountOverTime => None,
            MetricsFn::MinOverTime(e)
            | MetricsFn::MaxOverTime(e)
            | MetricsFn::AvgOverTime(e)
            | MetricsFn::SumOverTime(e)
            | MetricsFn::HistogramOverTime(e)
            | MetricsFn::QuantileOverTime(e, _) => Some(e),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SecondStage {
    TopK(u32),
    BottomK(u32),
    /// Keep the points where `value op threshold`.
    Filter(BinOp, f64),
}

#[derive(Clone, Debug, PartialEq)]
pub enum MetricsExpr {
    /// `pipeline | fn() by (...)`, then second stages.
    Query { pipeline: Vec<Stage>, func: MetricsFn, by: Vec<FieldExpr>, second: Vec<SecondStage> },
    Scalar(f64),
    Math { op: BinOp, lhs: Box<MetricsExpr>, rhs: Box<MetricsExpr>, second: Vec<SecondStage> },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Query {
    Search(Vec<Stage>),
    Metrics(MetricsExpr),
}

#[derive(Clone, Debug, PartialEq)]
pub struct RootExpr {
    pub query: Query,
    pub hints: Vec<(String, Static)>,
}
