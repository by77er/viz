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
//!
//! **Parts** (query/ "label endpoints over leaves", 2026-11-19): a listing can be restricted to
//! the series whose `series_id` (unsigned) falls in one part of a split ([`MetaPart`], the
//! same parts as the cardinality report's). Parts are disjoint in series, so their listings
//! union to the whole and the counts of series listed add up to the whole's count.
use crate::catalog;
use crate::error::{Limit, QueryError};
use crate::limits::Limits;
use crate::split::SplitKey;
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use viz_promql::{CompiledMatcher, MatchOp, Matcher, NAME_LABEL};
use viz_storage::ScanInput;

/// A label set: pairs sorted by name (UTF-8 byte order), including `__name__`.
pub type Labels = Vec<(String, String)>;

/// Part `part` of `parts` of a listing: the series whose `series_id`, read as an unsigned
/// integer, falls in that part's key range (`SplitKey::part_of`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetaPart {
    pub part: u32,
    pub parts: u32,
}

impl MetaPart {
    fn holds(&self, series_id: i64) -> bool {
        SplitKey::part_of(series_id as u64, self.parts.max(1)) == self.part
    }
}

/// Every distinct series (by label set) that matches at least one of `sets` and is in
/// `[min_ts, max_ts]` as decided per file, in label order (`max_series` bounds how many),
/// keeping of each listed series only what `keep` makes of its labels (the
/// label calls keep names, or one value), so a large listing holds little. Results are
/// sorted and de-duplicated after `keep`; `max_series` counts series before it. With `part`,
/// only that part's series; the second value is how many series were listed.
fn listed_as(
    input: &ScanInput<'_>,
    sets: &[&[Matcher]],
    min_ts: i64,
    max_ts: i64,
    limits: &Limits,
    keep: &dyn Fn(Labels) -> Labels,
    part: Option<MetaPart>,
) -> Result<(Vec<Labels>, u64), QueryError> {
    let mine = |id: i64| part.is_none_or(|p| p.holds(id));
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

    // series_id -> index in `matched` if its labels match (None: they do not), parsed once;
    // a row group's labels are decoded only if it holds an id not seen yet.
    let seen: RefCell<HashMap<i64, Option<u32>>> = RefCell::new(HashMap::new());
    let labels_for = |sids: &[i64]| {
        let s = seen.borrow();
        sids.iter().any(|x| mine(*x) && !s.contains_key(x))
    };
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
        catalog::for_each_series_with(f, fi, &want_range, &want, &labels_for, &mut |row| {
            if row.min_ts > max_ts || row.max_ts < min_ts || !mine(row.series_id) {
                return Ok(()); // not in the window in this file, or another part's
            }
            let known = seen.borrow().get(&row.series_id).copied();
            let slot = match known {
                Some(s) => s,
                None => {
                    let l = catalog::parse_labels(row.labels_json)?;
                    let s = matches(&l).then(|| {
                        matched.push((keep(l), false));
                        (matched.len() - 1) as u32
                    });
                    seen.borrow_mut().insert(row.series_id, s);
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
            if !hit || !mine(s.series_id) {
                continue;
            }
            let known = seen.borrow().get(&s.series_id).copied();
            let slot = match known {
                Some(x) => x,
                None => {
                    let l: Labels = s.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
                    let x = matches(&l).then(|| {
                        matched.push((keep(l), false));
                        (matched.len() - 1) as u32
                    });
                    seen.borrow_mut().insert(s.series_id, x);
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
    Ok((out, count))
}

/// Names of all labels (sorted, unique) on series that match `matchers` (none: every
/// series) and are in `[min_ts, max_ts]` (per file, see the module documentation).
pub fn label_names(input: &ScanInput<'_>, matchers: &[Matcher], min_ts: i64, max_ts: i64) -> Result<Vec<String>, QueryError> {
    label_names_with(input, matchers, min_ts, max_ts, &Limits::default())
}

/// [`label_names`] with explicit limits.
pub fn label_names_with(input: &ScanInput<'_>, matchers: &[Matcher], min_ts: i64, max_ts: i64, limits: &Limits) -> Result<Vec<String>, QueryError> {
    Ok(label_names_part(input, matchers, min_ts, max_ts, limits, None)?.0)
}

/// [`label_names_with`] over one part's series (none: every series), with how many series were listed.
pub fn label_names_part(input: &ScanInput<'_>, matchers: &[Matcher], min_ts: i64, max_ts: i64, limits: &Limits, part: Option<MetaPart>) -> Result<(Vec<String>, u64), QueryError> {
    let mut names = BTreeSet::new();
    let keep = |l: Labels| l.into_iter().map(|(n, _)| (n, String::new())).collect();
    let (listed, count) = listed_as(input, &[matchers], min_ts, max_ts, limits, &keep, part)?;
    for l in listed {
        names.extend(l.into_iter().map(|(n, _)| n));
    }
    Ok((names.into_iter().collect(), count))
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
    Ok(label_values_part(input, name, matchers, min_ts, max_ts, limits, None)?.0)
}

/// [`label_values_with`] over one part's series (none: every series), with how many series were listed.
pub fn label_values_part(
    input: &ScanInput<'_>,
    name: &str,
    matchers: &[Matcher],
    min_ts: i64,
    max_ts: i64,
    limits: &Limits,
    part: Option<MetaPart>,
) -> Result<(Vec<String>, u64), QueryError> {
    let mut values = BTreeSet::new();
    let keep = |l: Labels| l.into_iter().filter(|(n, _)| n == name).collect();
    let (listed, count) = listed_as(input, &[matchers], min_ts, max_ts, limits, &keep, part)?;
    for l in listed {
        values.extend(l.into_iter().map(|(_, v)| v));
    }
    Ok((values.into_iter().collect(), count))
}

/// Label sets (sorted, unique) of the series that match at least one of `matcher_sets`
/// and are in `[min_ts, max_ts]`. As in Prometheus, at least one set is required and every
/// set needs a matcher that does not match the empty string (`bad_data` otherwise).
pub fn series(input: &ScanInput<'_>, matcher_sets: &[Vec<Matcher>], min_ts: i64, max_ts: i64) -> Result<Vec<Labels>, QueryError> {
    series_with(input, matcher_sets, min_ts, max_ts, &Limits::default())
}

/// [`series`] with explicit limits (`max_series` applies to the union of the sets).
pub fn series_with(input: &ScanInput<'_>, matcher_sets: &[Vec<Matcher>], min_ts: i64, max_ts: i64, limits: &Limits) -> Result<Vec<Labels>, QueryError> {
    Ok(series_part(input, matcher_sets, min_ts, max_ts, limits, None)?.0)
}

/// [`series_with`] over one part's series (none: every series), with how many were listed.
pub fn series_part(input: &ScanInput<'_>, matcher_sets: &[Vec<Matcher>], min_ts: i64, max_ts: i64, limits: &Limits, part: Option<MetaPart>) -> Result<(Vec<Labels>, u64), QueryError> {
    if matcher_sets.is_empty() {
        return Err(QueryError::bad_data("no match[] parameter provided"));
    }
    for set in matcher_sets {
        check_selective(set)?;
    }
    let sets: Vec<&[Matcher]> = matcher_sets.iter().map(|s| s.as_slice()).collect();
    listed_as(input, &sets, min_ts, max_ts, limits, &|l| l, part)
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
