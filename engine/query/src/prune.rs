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
    // The name each range is pinned to, if any. Two different equalities match nothing,
    // but that is the evaluator's business; here either may be used.
    let names: Vec<Option<&str>> = ranges
        .iter()
        .map(|r| r.matchers.iter().find(|m| m.name == NAME_LABEL && m.op == MatchOp::Eq).map(|m| m.value.as_str()))
        .collect();
    indexes
        .iter()
        .map(|text| {
            let Ok(index) = FileIndex::from_json(text) else { return true };
            index.row_groups.iter().any(|g| {
                ranges.iter().zip(&names).any(|(r, name)| {
                    g.min_ts <= r.max_ts
                        && g.max_ts >= r.min_ts
                        && name.is_none_or(|n| n.as_bytes() >= g.min_name.as_bytes() && n.as_bytes() <= g.max_name.as_bytes())
                })
            })
        })
        .collect()
}
