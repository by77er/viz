//! The metadata calls of the Prometheus HTTP API that storage can answer:
//! `/api/v1/labels`, `/api/v1/label/<name>/values`, `/api/v1/series`.
//!
//! **A series-only read** (query/CARDINALITY.md, item 3): series come from the
//! `metric_series` files (`crate::catalog`) and the tail batches' series tables, never from
//! sample files, so these calls cost what the series files cost whatever the samples are.
//! Sample files in the input are ignored.
//!
//! **"In the range" is decided per file** (contracts/TABLES.md, `metric_series`): a series
//! is listed if one of its series-file rows has `[min_ts, max_ts]` overlapping
//! `[min_ts, max_ts]` of the call, or one of its tail rows lies in it, as Prometheus decides
//! per block. A series whose samples in one file all fall outside the window, some before
//! it and some after, is therefore listed; a query over the same window would not see it.
//! (Before 2026-11-19 these calls loaded samples and listed exactly the series with a sample
//! in the window.)
//!
//! Limits: `max_series` bounds the distinct series listed (an `execution` error names it).
//! No samples are loaded, so `max_samples` does not apply.
use crate::catalog;
use crate::error::{Limit, QueryError};
use crate::limits::Limits;
use std::collections::{BTreeSet, HashMap};
use viz_promql::{CompiledMatcher, MatchOp, Matcher, NAME_LABEL};
use viz_storage::ScanInput;

/// A label set: pairs sorted by name (UTF-8 byte order), including `__name__`.
pub type Labels = Vec<(String, String)>;

/// Every distinct series (by label set) that matches at least one of `sets` and is in
/// `[min_ts, max_ts]` as decided per file, in label order. `max_series` bounds how many.
pub fn listed(input: &ScanInput<'_>, sets: &[&[Matcher]], min_ts: i64, max_ts: i64, limits: &Limits) -> Result<Vec<Labels>, QueryError> {
    let compiled: Vec<Vec<CompiledMatcher>> =
        sets.iter().map(|s| s.iter().map(|m| m.compile()).collect::<Result<Vec<_>, _>>()).collect::<Result<_, _>>().map_err(QueryError::from_promql)?;
    // Names, when every set pins `__name__` with `=`: row groups of other names are not read.
    let names: Option<BTreeSet<Vec<u8>>> = sets
        .iter()
        .map(|s| s.iter().find(|m| m.name == NAME_LABEL && m.op == MatchOp::Eq).map(|m| m.value.as_bytes().to_vec()))
        .collect();
    let want = |n: &[u8]| names.as_ref().is_none_or(|s| s.contains(n));
    // (Statistics with min above max are a broken file: keep the group, never panic.)
    let want_range = |lo: &[u8], hi: &[u8]| lo > hi || names.as_ref().is_none_or(|s| s.range(lo.to_vec()..=hi.to_vec()).next().is_some());
    let matches = |l: &Labels| compiled.iter().any(|ms| ms.iter().all(|m| m.matches(l)));

    // series_id -> index in `matched` if its labels match (None: they do not), parsed once.
    let mut seen: HashMap<i64, Option<u32>> = HashMap::new();
    let mut matched: Vec<(Labels, bool)> = Vec::new(); // (labels, listed)
    let mut count = 0u64;
    let mut list = |slot: u32, matched: &mut Vec<(Labels, bool)>| -> Result<(), QueryError> {
        let e = &mut matched[slot as usize];
        if !e.1 {
            e.1 = true;
            count += 1;
            if count > limits.max_series {
                return Err(QueryError::limit(Limit::MaxSeries, limits.max_series, count, "series listed"));
            }
        }
        Ok(())
    };
    for (fi, f) in input.series_files.iter().enumerate() {
        catalog::for_each_series(f, fi, &want_range, &want, &mut |row| {
            if row.min_ts > max_ts || row.max_ts < min_ts {
                return Ok(()); // not in the window in this file
            }
            let slot = match seen.get(&row.series_id) {
                Some(s) => *s,
                None => {
                    let l = catalog::parse_labels(row.labels_json)?;
                    let s = matches(&l).then(|| {
                        matched.push((l, false));
                        (matched.len() - 1) as u32
                    });
                    seen.insert(row.series_id, s);
                    s
                }
            };
            match slot {
                Some(i) => list(i, &mut matched),
                None => Ok(()),
            }
        })?;
    }
    for (bi, bytes) in input.tail_batches.iter().enumerate() {
        let b = viz_storage::batch::decode(bytes).map_err(|e| QueryError::internal(format!("tail batch {bi}: {e}")))?;
        let mut in_window = vec![false; b.series().len()];
        for i in 0..b.n_rows() {
            let t = b.ts(i);
            if t >= min_ts && t <= max_ts {
                in_window[b.series_idx(i) as usize] = true;
            }
        }
        for (s, hit) in b.series().iter().zip(in_window) {
            if !hit {
                continue;
            }
            let slot = match seen.get(&s.series_id) {
                Some(x) => *x,
                None => {
                    let l: Labels = s.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
                    let x = matches(&l).then(|| {
                        matched.push((l, false));
                        (matched.len() - 1) as u32
                    });
                    seen.insert(s.series_id, x);
                    x
                }
            };
            if let Some(i) = slot {
                list(i, &mut matched)?;
            }
        }
    }
    let mut out: Vec<Labels> = matched.into_iter().filter(|(_, l)| *l).map(|(l, _)| l).collect();
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// Names of all labels (sorted, unique) on series that match `matchers` (none: every
/// series) and are in `[min_ts, max_ts]` (per file, see the module documentation).
pub fn label_names(input: &ScanInput<'_>, matchers: &[Matcher], min_ts: i64, max_ts: i64) -> Result<Vec<String>, QueryError> {
    label_names_with(input, matchers, min_ts, max_ts, &Limits::default())
}

/// [`label_names`] with explicit limits.
pub fn label_names_with(input: &ScanInput<'_>, matchers: &[Matcher], min_ts: i64, max_ts: i64, limits: &Limits) -> Result<Vec<String>, QueryError> {
    let mut names = BTreeSet::new();
    for l in listed(input, &[matchers], min_ts, max_ts, limits)? {
        names.extend(l.into_iter().map(|(n, _)| n));
    }
    Ok(names.into_iter().collect())
}

/// Values of label `name` (sorted, unique) on series that match `matchers` (none: every
/// series) and are in `[min_ts, max_ts]`. Series without the label contribute nothing.
pub fn label_values(input: &ScanInput<'_>, name: &str, matchers: &[Matcher], min_ts: i64, max_ts: i64) -> Result<Vec<String>, QueryError> {
    label_values_with(input, name, matchers, min_ts, max_ts, &Limits::default())
}

/// [`label_values`] with explicit limits.
pub fn label_values_with(
    input: &ScanInput<'_>,
    name: &str,
    matchers: &[Matcher],
    min_ts: i64,
    max_ts: i64,
    limits: &Limits,
) -> Result<Vec<String>, QueryError> {
    let mut values = BTreeSet::new();
    for l in listed(input, &[matchers], min_ts, max_ts, limits)? {
        values.extend(l.into_iter().filter(|(n, _)| n == name).map(|(_, v)| v));
    }
    Ok(values.into_iter().collect())
}

/// Label sets (sorted, unique) of the series that match at least one of `matcher_sets`
/// and are in `[min_ts, max_ts]`. As in Prometheus, at least one set is required and every
/// set needs a matcher that does not match the empty string (`bad_data` otherwise).
pub fn series(input: &ScanInput<'_>, matcher_sets: &[Vec<Matcher>], min_ts: i64, max_ts: i64) -> Result<Vec<Labels>, QueryError> {
    series_with(input, matcher_sets, min_ts, max_ts, &Limits::default())
}

/// [`series`] with explicit limits (`max_series` applies to the union of the sets).
pub fn series_with(input: &ScanInput<'_>, matcher_sets: &[Vec<Matcher>], min_ts: i64, max_ts: i64, limits: &Limits) -> Result<Vec<Labels>, QueryError> {
    if matcher_sets.is_empty() {
        return Err(QueryError::bad_data("no match[] parameter provided"));
    }
    for set in matcher_sets {
        check_selective(set)?;
    }
    let sets: Vec<&[Matcher]> = matcher_sets.iter().map(|s| s.as_slice()).collect();
    listed(input, &sets, min_ts, max_ts, limits)
}

/// Prometheus refuses a selector whose matchers all match the empty string (`{}`,
/// `{a=""}`, `{a=~".*"}`): it would select every series.
pub(crate) fn check_selective(set: &[Matcher]) -> Result<(), QueryError> {
    let mut selective = false;
    for m in set {
        let matches_empty = match m.op {
            MatchOp::Eq => m.value.is_empty(),
            MatchOp::Ne => !m.value.is_empty(),
            MatchOp::Re | MatchOp::Nre => {
                let re = viz_promql::compile_anchored(&m.value).map_err(QueryError::from_promql)?;
                re.is_match("") == (m.op == MatchOp::Re)
            }
        };
        selective |= !matches_empty;
    }
    if selective {
        Ok(())
    } else {
        Err(QueryError::bad_data("match[] must contain at least one non-empty matcher"))
    }
}
