//! The metadata calls of the Prometheus HTTP API that storage can answer:
//! `/api/v1/labels`, `/api/v1/label/<name>/values`, `/api/v1/series`.
//!
//! All three go through `viz_storage::select`, so they see exactly the series a query
//! over the same range would see (a series with no sample in `[min_ts, max_ts]` is not
//! listed), merged over lake and tail. Storage has no series-only read yet, so these
//! load the samples too; the limits on series and samples apply.
use crate::error::QueryError;
use crate::limits::Limits;
use crate::source::StorageSource;
use std::collections::BTreeSet;
use viz_promql::{MatchOp, Matcher, SeriesSource};
use viz_storage::ScanInput;

/// A label set: pairs sorted by name (UTF-8 byte order), including `__name__`.
pub type Labels = Vec<(String, String)>;

fn load(matchers: &[Matcher], min_ts: i64, max_ts: i64, src: &StorageSource<'_>) -> Result<Vec<Labels>, QueryError> {
    match src.select(matchers, min_ts, max_ts) {
        Ok(v) => Ok(v.into_iter().map(|s| s.labels).collect()),
        Err(e) => Err(src.take_failure().unwrap_or_else(|| QueryError::from_promql(e))),
    }
}

/// Names of all labels (sorted, unique) on series that match `matchers` (none: every
/// series) and have a sample in `[min_ts, max_ts]`.
pub fn label_names(input: &ScanInput<'_>, matchers: &[Matcher], min_ts: i64, max_ts: i64) -> Result<Vec<String>, QueryError> {
    label_names_with(input, matchers, min_ts, max_ts, &Limits::default())
}

/// [`label_names`] with explicit limits.
pub fn label_names_with(input: &ScanInput<'_>, matchers: &[Matcher], min_ts: i64, max_ts: i64, limits: &Limits) -> Result<Vec<String>, QueryError> {
    let src = StorageSource::new(input, *limits);
    let mut names = BTreeSet::new();
    for l in load(matchers, min_ts, max_ts, &src)? {
        names.extend(l.into_iter().map(|(n, _)| n));
    }
    Ok(names.into_iter().collect())
}

/// Values of label `name` (sorted, unique) on series that match `matchers` (none: every
/// series) and have a sample in `[min_ts, max_ts]`. Series without the label contribute
/// nothing.
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
    let src = StorageSource::new(input, *limits);
    let mut values = BTreeSet::new();
    for l in load(matchers, min_ts, max_ts, &src)? {
        values.extend(l.into_iter().filter(|(n, _)| n == name).map(|(_, v)| v));
    }
    Ok(values.into_iter().collect())
}

/// Label sets (sorted, unique) of the series that match at least one of `matcher_sets`
/// and have a sample in `[min_ts, max_ts]`. As in Prometheus, at least one set is
/// required and every set needs a matcher that does not match the empty string
/// (`bad_data` otherwise).
pub fn series(input: &ScanInput<'_>, matcher_sets: &[Vec<Matcher>], min_ts: i64, max_ts: i64) -> Result<Vec<Labels>, QueryError> {
    series_with(input, matcher_sets, min_ts, max_ts, &Limits::default())
}

/// [`series`] with explicit limits (they apply to the sum over all sets).
pub fn series_with(input: &ScanInput<'_>, matcher_sets: &[Vec<Matcher>], min_ts: i64, max_ts: i64, limits: &Limits) -> Result<Vec<Labels>, QueryError> {
    if matcher_sets.is_empty() {
        return Err(QueryError::bad_data("no match[] parameter provided"));
    }
    for set in matcher_sets {
        check_selective(set)?;
    }
    let src = StorageSource::new(input, *limits);
    let mut out = BTreeSet::new();
    for set in matcher_sets {
        out.extend(load(set, min_ts, max_ts, &src)?);
    }
    Ok(out.into_iter().collect())
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
