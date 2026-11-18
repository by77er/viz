//! File pruning from the ledger's index fragments (`viz_storage::FileIndex`).
//!
//! A query Worker gets the live files of a time range from the ledger, each with its
//! index fragment. Before fetching anything it asks here which files the fetch plan can
//! possibly read. The engine owns the fragment's format, so the decision lives here.
use crate::plan::FetchRange;
use viz_promql::{MatchOp, NAME_LABEL};
use viz_storage::FileIndex;

/// For each index fragment (one per file, of either table): `true` if the file may hold
/// a row some range of the plan reads, `false` if it provably holds none and need not
/// be fetched.
///
/// A row group can contribute to a range only if its time span overlaps the range and,
/// when the range has an equality matcher on `__name__`, the name lies within the row
/// group's `[min_name, max_name]` (both exact, byte order). A file is skipped only when
/// no row group can contribute to any range. Everything else keeps the file: other
/// matcher kinds are not used, and a fragment that does not parse is kept (a file is
/// never skipped on a guess).
///
/// The same rule is sound for `metric_series` files: a series with a sample in the
/// range in this file has a row whose `[min_ts, max_ts]` covers that sample, so the
/// series row group overlaps whenever the sample row group does.
///
/// Guarantee (tested as `skipping_files_never_changes_a_result`): evaluating over only
/// the files marked `true` gives the same result as evaluating over all of them.
pub fn files_needed(indexes: &[&str], ranges: &[FetchRange]) -> Vec<bool> {
    scan_rows(indexes, ranges).into_iter().map(|rows| rows != Some(0)).collect()
}

/// For each index fragment: an upper bound on the rows a read of `ranges` decodes from
/// the file, or `None` if the fragment does not parse (the bound is then unknown and the
/// file must be read). `Some(0)` is exactly the "skip" of [`files_needed`].
///
/// The bound is the row count of every row group that may contribute to a range, summed
/// over the ranges (a row group two ranges touch is decoded once for each). For a
/// `metric_samples` file this bounds the samples a query can load from it, so a caller
/// can refuse a query that would decode too much BEFORE fetching anything: the limits on
/// loaded samples only fire once a selector's samples are in memory.
pub fn scan_rows(indexes: &[&str], ranges: &[FetchRange]) -> Vec<Option<u64>> {
    // The name each range is pinned to, if any. Two different equalities match nothing,
    // but that is the evaluator's business; here either may be used.
    let names: Vec<Option<&str>> = ranges
        .iter()
        .map(|r| r.matchers.iter().find(|m| m.name == NAME_LABEL && m.op == MatchOp::Eq).map(|m| m.value.as_str()))
        .collect();
    indexes
        .iter()
        .map(|text| {
            let index = FileIndex::from_json(text).ok()?;
            let mut rows = 0u64;
            for g in &index.row_groups {
                for (r, name) in ranges.iter().zip(&names) {
                    if g.min_ts <= r.max_ts
                        && g.max_ts >= r.min_ts
                        && name.is_none_or(|n| n.as_bytes() >= g.min_name.as_bytes() && n.as_bytes() <= g.max_name.as_bytes())
                    {
                        rows = rows.saturating_add(g.rows);
                    }
                }
            }
            Some(rows)
        })
        .collect()
}
