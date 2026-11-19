//! Query limits. `viz-promql` bounds only the number of steps; a serverless engine needs
//! every dimension of a query bounded, and an over-limit query must fail, never return a
//! truncated result.
use crate::error::{Limit, QueryError};

/// Bounds on one query. Exceeding any of them is an `execution` error that names the
/// limit and the number reached ([`QueryError::limit`]); nothing is ever truncated.
///
/// All counts are taken after storage has merged and de-duplicated, so whether a query
/// is over a limit does not depend on where its rows are stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Samples loaded from storage, summed over every selector of the query (a selector
    /// evaluated by two subqueries counts twice; a staleness marker is a sample).
    pub max_samples: u64,
    /// Series loaded from storage, summed over every selector of the query.
    pub max_series: u64,
    /// Points in the result: the sum of `values` lengths of a matrix, the number of
    /// samples of a vector, 1 for a scalar or string.
    pub max_output_points: u64,
    /// For any one selector: series returned by storage times the evaluation steps of the
    /// (sub)query it belongs to. The evaluator materialises that grid (24 bytes a cell),
    /// so this is what bounds its memory on `many series x many steps` queries whose
    /// output is small, such as `sum(m)`.
    pub max_step_points: u64,
    /// Length of the query text in bytes.
    pub max_query_bytes: u64,
    /// Nesting depth of the expression: an upper bound on the depth of the syntax tree,
    /// computed from the text before parsing (see [`estimate_depth`]). The parser's
    /// checks and the evaluator recurse once per level, so this bounds stack use.
    pub max_depth: u64,
}

impl Default for Limits {
    /// Sized for a 128 MB isolate: 2 M samples are 32 MB, 1 M step points 24 MB.
    fn default() -> Self {
        Limits {
            max_samples: 2_000_000,
            max_series: 20_000,
            max_output_points: 500_000,
            max_step_points: 1_000_000,
            max_query_bytes: 16 * 1024,
            max_depth: 100,
        }
    }
}

impl Limits {
    /// No limit in any dimension (tests and trusted native callers).
    pub fn unlimited() -> Limits {
        Limits {
            max_samples: u64::MAX,
            max_series: u64::MAX,
            max_output_points: u64::MAX,
            max_step_points: u64::MAX,
            max_query_bytes: u64::MAX,
            max_depth: u64::MAX,
        }
    }

    /// The complexity guard: checks the query text against `max_query_bytes` and
    /// `max_depth`. Runs before the parser sees the query.
    pub fn check_query(&self, query: &str) -> Result<(), QueryError> {
        if query.len() as u64 > self.max_query_bytes {
            return Err(QueryError::limit(Limit::MaxQueryBytes, self.max_query_bytes, query.len() as u64, "bytes of query text"));
        }
        let depth = estimate_depth(query, self.max_depth);
        if depth > self.max_depth {
            return Err(QueryError::limit(Limit::MaxDepth, self.max_depth, depth, "levels of nesting (brackets and operators)"));
        }
        Ok(())
    }
}

/// An upper bound on the depth of the syntax tree of `query`, from one pass over its
/// characters with no recursion.
///
/// Every bracket group (`(…)`, `[…]`, `{…}`) contributes one level plus one level for
/// each operator character or operator word (`and`, `or`, `unless`, `atan2`) directly
/// inside it, plus the deepest group nested in it; a closing `]` counts as an operator
/// of the enclosing group, because a subquery wraps what precedes it. Strings and
/// comments are skipped. The bound is deliberately loose (a two-character operator
/// counts twice, operators in different arguments of one call add up): `a + b + c` is 3
/// where the tree is 3 deep, `f(a + b, c + d)` is 4 where the tree is 3 deep.
///
/// Stops early and returns a value above `stop_above` once the bound is known to exceed it.
pub fn estimate_depth(query: &str, stop_above: u64) -> u64 {
    // One entry per open group: (operators directly inside, deepest closed child).
    let mut stack: Vec<(u64, u64)> = vec![(0, 0)];
    let b = query.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        match c {
            b'"' | b'\'' => {
                i += 1;
                while i < b.len() && b[i] != c {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'`' => {
                i += 1;
                while i < b.len() && b[i] != b'`' {
                    i += 1;
                }
            }
            b'#' => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'(' | b'[' | b'{' => {
                stack.push((0, 0));
                if stack.len() as u64 > stop_above {
                    return stack.len() as u64;
                }
            }
            b')' | b']' | b'}' => {
                if stack.len() > 1 {
                    let (ops, child) = stack.pop().unwrap_or((0, 0));
                    let depth = 1 + ops + child;
                    if let Some(top) = stack.last_mut() {
                        top.1 = top.1.max(depth);
                        if c == b']' {
                            top.0 += 1;
                        }
                    }
                }
            }
            b'+' | b'-' | b'*' | b'/' | b'%' | b'^' | b'=' | b'!' | b'<' | b'>' | b'~' => {
                if let Some(top) = stack.last_mut() {
                    top.0 += 1;
                }
            }
            _ if c.is_ascii_alphabetic() || c == b'_' => {
                let st = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b':' || b[i] == b'.') {
                    i += 1;
                }
                let w = &b[st..i];
                if [&b"and"[..], b"or", b"unless", b"atan2"].iter().any(|k| w.eq_ignore_ascii_case(k)) {
                    if let Some(top) = stack.last_mut() {
                        top.0 += 1;
                    }
                }
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    // Fold whatever is still open (unbalanced brackets are a parse error later).
    let mut child = 0u64;
    while let Some((ops, c)) = stack.pop() {
        child = 1 + ops + c.max(child);
        if child > stop_above {
            return child;
        }
    }
    child
}
