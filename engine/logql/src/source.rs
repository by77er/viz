//! The read seam between the engine and storage (`contracts/LOGS.md` §7).

use crate::ast::Matcher;
use crate::error::Error;

/// One log record.
#[derive(Debug, Clone, PartialEq)]
pub struct LogRow {
    /// Unix nanoseconds.
    pub ts_ns: i64,
    pub line: String,
    /// Structured metadata, names unique and sorted.
    pub metadata: Vec<(String, String)>,
}

/// A stream: its labels (sorted by name, unique, no empty values) and its rows.
#[derive(Debug, Clone, PartialEq)]
pub struct LogStream {
    pub labels: Vec<(String, String)>,
    pub rows: Vec<LogRow>,
}

/// What the engine reads for one selector.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectRequest<'a> {
    pub matchers: &'a [Matcher],
    /// Inclusive, Unix nanoseconds.
    pub start_ns: i64,
    /// Exclusive, Unix nanoseconds.
    pub end_ns: i64,
    /// Clauses every line the query can use satisfies: for each clause, the line contains at
    /// least one of its literals (case-sensitive, before any stage that rewrites the line).
    /// Storage may skip rows (or row groups) that provably fail a clause. Advisory: the
    /// engine re-applies every filter.
    pub required: &'a [Vec<String>],
}

/// Where the engine gets rows from.
///
/// Contract (`contracts/LOGS.md` §7):
/// * call `visit` for every row whose stream labels satisfy *all* matchers (Prometheus
///   semantics: a missing label equals `""`, regexes fully anchored) and whose timestamp lies
///   in `[start_ns, end_ns)`;
/// * a stream's rows are visited in ascending timestamp order, rows with equal timestamps in
///   storage order; streams may be visited in any order but not interleaved;
/// * rows outside the range, or of streams that do not match, may also be visited (the
///   engine re-filters both); rows that fail a `required` clause may be skipped;
/// * duplicates (same stream, timestamp, line and metadata) are already removed.
pub trait LogSource {
    fn select(&self, req: &SelectRequest<'_>, visit: &mut dyn FnMut(&[(String, String)], &LogRow)) -> Result<(), Error>;
}

/// An in-memory source for tests, benchmarks and small data sets.
#[derive(Debug, Clone, Default)]
pub struct MemSource {
    streams: Vec<LogStream>,
    /// Skip rows that fail `required` clauses (storage-style pruning). Results must not
    /// depend on it.
    pub prune: bool,
}

impl MemSource {
    pub fn new(mut streams: Vec<LogStream>) -> MemSource {
        for s in &mut streams {
            s.labels.sort();
            s.rows.sort_by_key(|r| r.ts_ns);
        }
        MemSource { streams, prune: false }
    }
    pub fn streams(&self) -> &[LogStream] {
        &self.streams
    }
}

pub(crate) fn compile_matchers(ms: &[Matcher]) -> Result<Vec<crate::pipeline::StrMatcher>, Error> {
    ms.iter().map(crate::pipeline::StrMatcher::compile).collect()
}

pub(crate) fn stream_matches(ms: &[crate::pipeline::StrMatcher], labels: &[(String, String)]) -> bool {
    ms.iter().all(|m| m.matches(labels.iter().find(|(n, _)| *n == m.name).map(|(_, v)| v.as_str()).unwrap_or("")))
}

impl LogSource for MemSource {
    fn select(&self, req: &SelectRequest<'_>, visit: &mut dyn FnMut(&[(String, String)], &LogRow)) -> Result<(), Error> {
        let ms = compile_matchers(req.matchers)?;
        for s in &self.streams {
            if !stream_matches(&ms, &s.labels) {
                continue;
            }
            let lo = s.rows.partition_point(|r| r.ts_ns < req.start_ns);
            let hi = s.rows.partition_point(|r| r.ts_ns < req.end_ns);
            for r in &s.rows[lo..hi.max(lo)] {
                if self.prune && !req.required.iter().all(|clause| clause.iter().any(|lit| r.line.contains(lit.as_str()))) {
                    continue;
                }
                visit(&s.labels, r);
            }
        }
        Ok(())
    }
}
