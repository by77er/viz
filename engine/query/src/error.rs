//! Errors, classified the way the Prometheus HTTP API classifies them.
use std::fmt;

/// The `errorType` of a Prometheus API error response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorType {
    /// The request is wrong: the query does not parse, a matcher's regular expression is
    /// invalid, the time range or step is invalid. HTTP 400 in Prometheus.
    BadData,
    /// The query is valid but could not be evaluated: a PromQL evaluation error (for
    /// example many-to-many matching) or a limit of this engine was exceeded. HTTP 422.
    Execution,
    /// Valid PromQL that this engine does not implement. Never a wrong answer instead.
    /// (Not a Prometheus error type; an HTTP layer would answer 422 or 501.)
    Unsupported,
    /// The data handed to the engine is broken (a corrupt Parquet file or `VZB1` batch).
    /// Not the caller's query; HTTP 500 in Prometheus.
    Internal,
}

impl ErrorType {
    /// The string used in the `errorType` field.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorType::BadData => "bad_data",
            ErrorType::Execution => "execution",
            ErrorType::Unsupported => "unsupported",
            ErrorType::Internal => "internal",
        }
    }
}

/// Which limit a query ran into. See [`crate::Limits`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Limit {
    MaxSamples,
    MaxSeries,
    MaxOutputPoints,
    MaxStepPoints,
    MaxQueryBytes,
    MaxDepth,
}

impl Limit {
    /// The name of the field of [`crate::Limits`], as it appears in error messages.
    pub fn as_str(self) -> &'static str {
        match self {
            Limit::MaxSamples => "max_samples",
            Limit::MaxSeries => "max_series",
            Limit::MaxOutputPoints => "max_output_points",
            Limit::MaxStepPoints => "max_step_points",
            Limit::MaxQueryBytes => "max_query_bytes",
            Limit::MaxDepth => "max_depth",
        }
    }
}

/// An error of this crate. `Display` prints the message only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryError {
    pub error_type: ErrorType,
    pub message: String,
    /// Set when a limit was exceeded: which one, the limit, and the number reached.
    pub limit: Option<(Limit, u64, u64)>,
}

impl QueryError {
    pub fn bad_data(m: impl Into<String>) -> QueryError {
        QueryError { error_type: ErrorType::BadData, message: m.into(), limit: None }
    }
    pub fn execution(m: impl Into<String>) -> QueryError {
        QueryError { error_type: ErrorType::Execution, message: m.into(), limit: None }
    }
    pub fn unsupported(m: impl Into<String>) -> QueryError {
        QueryError { error_type: ErrorType::Unsupported, message: m.into(), limit: None }
    }
    pub fn internal(m: impl Into<String>) -> QueryError {
        QueryError { error_type: ErrorType::Internal, message: m.into(), limit: None }
    }

    /// A limit was exceeded: an `execution` error naming the limit, the number reached
    /// and what was being counted.
    pub fn limit(limit: Limit, max: u64, reached: u64, what: &str) -> QueryError {
        QueryError {
            error_type: ErrorType::Execution,
            message: format!("query exceeded limit {}: {reached} {what}, the limit is {max}", limit.as_str()),
            limit: Some((limit, max, reached)),
        }
    }

    /// The body of a Prometheus API error response:
    /// `{"status":"error","errorType":"…","error":"…"}`.
    pub fn to_json(&self) -> String {
        let mut out = String::from("{\"status\":\"error\",\"errorType\":\"");
        out.push_str(self.error_type.as_str());
        out.push_str("\",\"error\":");
        out.push_str(&serde_json::to_string(&self.message).unwrap_or_else(|_| "\"\"".into()));
        out.push('}');
        out
    }

    pub(crate) fn from_promql(e: viz_promql::Error) -> QueryError {
        match e {
            viz_promql::Error::Parse(m) => QueryError::bad_data(format!("parse error: {m}")),
            viz_promql::Error::Unsupported(m) => QueryError::unsupported(m),
            viz_promql::Error::Eval(m) => QueryError::execution(m),
            // A source failure that did not come through `StorageSource` (which records
            // its own, precise error).
            viz_promql::Error::Source(m) => QueryError::internal(m),
        }
    }

    pub(crate) fn from_storage(e: viz_storage::Error) -> QueryError {
        match e {
            viz_storage::Error::Matcher { name, message } => {
                QueryError::bad_data(format!("invalid regular expression in matcher on {name:?}: {message}"))
            }
            other => QueryError::internal(format!("storage: {other}")),
        }
    }
}

impl fmt::Display for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for QueryError {}
