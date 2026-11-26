use std::fmt;

/// Every error the engine returns. `Unsupported` is returned for anything not
/// implemented, never a wrong answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// The query text is not valid LogQL, or fails validation. `line` and `col` count from 1.
    Parse { msg: String, line: usize, col: usize },
    /// Valid LogQL that this engine does not implement.
    Unsupported(String),
    /// Evaluation failed (for example a metric query whose samples carry `__error__`).
    Eval(String),
    /// A limit was exceeded.
    Limit(String),
    /// The log source failed.
    Source(String),
    /// What the evaluation would hold passes `Options::max_bytes` (`eval::Meter`): refused
    /// before `what` was made, with the bytes it would have held.
    Memory { what: &'static str, max: u64, used: u64 },
}

impl Error {
    /// The Loki/Prometheus API `errorType` this error maps to.
    pub fn error_type(&self) -> &'static str {
        match self {
            Error::Parse { .. } => "bad_data",
            Error::Unsupported(_) => "unsupported",
            Error::Eval(_) | Error::Limit(_) | Error::Memory { .. } => "execution",
            Error::Source(_) => "internal",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Parse { msg, line, col } => write!(f, "parse error at line {line}, col {col}: {msg}"),
            Error::Unsupported(m) => write!(f, "unsupported: {m}"),
            Error::Eval(m) => write!(f, "{m}"),
            Error::Limit(m) => write!(f, "limit exceeded: {m}"),
            Error::Source(m) => write!(f, "source: {m}"),
            Error::Memory { what, max, used } => write!(f, "the query's {what} would hold {used} bytes, more than the {max} it may hold"),
        }
    }
}

impl std::error::Error for Error {}

impl From<viz_promql::Error> for Error {
    fn from(e: viz_promql::Error) -> Self {
        match e {
            viz_promql::Error::Unsupported(m) => Error::Unsupported(m),
            other => Error::Eval(other.to_string()),
        }
    }
}
