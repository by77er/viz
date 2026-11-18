//! Fetch planning: what a caller must fetch before a query can be evaluated.
use crate::error::QueryError;
use crate::Options;
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use viz_promql::Matcher;
use viz_storage::batch::{MAX_TS, MIN_TS};

/// One thing to fetch: every sample of every series matching all `matchers` with
/// `min_ts <= ts <= max_ts` (inclusive, Unix milliseconds). Serialises as
/// `{"matchers":[{"name","op","value"}],"minTs":…,"maxTs":…}`, the shape of `selectors`
/// in `contracts/engine.ts`.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchRange {
    pub matchers: Vec<Matcher>,
    pub min_ts: i64,
    pub max_ts: i64,
}

impl Serialize for FetchRange {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("FetchRange", 3)?;
        st.serialize_field("matchers", &self.matchers)?;
        st.serialize_field("minTs", &self.min_ts)?;
        st.serialize_field("maxTs", &self.max_ts)?;
        st.end()
    }
}

/// The fetch plan of a range query: the ranges of [`crate::selectors`], clamped to the
/// timestamps storage can hold (`0..=253402300799999`), with ranges of the same matcher
/// set merged when they overlap or touch. Ranges of one matcher set that are apart (for
/// example `m` and `m offset 1d`) stay separate, so nothing in between is fetched.
///
/// Guarantee (tested as `plan_is_sound`): evaluating the query over only the samples
/// inside these ranges gives the same result as evaluating it over everything. Pass
/// `start_ms == end_ms` (any positive step) for an instant query.
pub fn plan(query: &str, start_ms: i64, end_ms: i64, step_ms: i64) -> Result<Vec<FetchRange>, QueryError> {
    plan_with(query, start_ms, end_ms, step_ms, &Options::default())
}

/// [`plan`] with explicit options. Use the same options for the query itself.
pub fn plan_with(query: &str, start_ms: i64, end_ms: i64, step_ms: i64, opts: &Options) -> Result<Vec<FetchRange>, QueryError> {
    let sels = crate::selectors_with(query, start_ms, end_ms, step_ms, opts)?;
    // Insertion-ordered groups; a query has a handful of selectors, so a scan is fine.
    let mut groups: Vec<(Vec<Matcher>, Vec<(i64, i64)>)> = Vec::new();
    for s in sels {
        let (lo, hi) = (s.min_ts_ms.max(MIN_TS), s.max_ts_ms.min(MAX_TS));
        if lo > hi {
            continue; // Entirely outside what storage can hold: nothing to fetch.
        }
        match groups.iter_mut().find(|g| g.0 == s.matchers) {
            Some(g) => g.1.push((lo, hi)),
            None => groups.push((s.matchers, vec![(lo, hi)])),
        }
    }
    let mut out = Vec::new();
    for (matchers, mut ranges) in groups {
        ranges.sort_unstable();
        let mut cur = ranges[0];
        for &(lo, hi) in &ranges[1..] {
            if lo <= cur.1.saturating_add(1) {
                cur.1 = cur.1.max(hi);
            } else {
                out.push(FetchRange { matchers: matchers.clone(), min_ts: cur.0, max_ts: cur.1 });
                cur = (lo, hi);
            }
        }
        out.push(FetchRange { matchers, min_ts: cur.0, max_ts: cur.1 });
    }
    Ok(out)
}
