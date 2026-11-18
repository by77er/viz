//! `viz_promql::SeriesSource` over a `viz_storage::ScanInput`.
//!
//! This is the whole seam between the two crates, and it is deliberately thin. Who owns
//! what (so that nothing is done twice and nothing is left out):
//!
//! | Concern | Owner | What the adapter does |
//! |---|---|---|
//! | Matchers (`=`, `!=`, `=~`, `!~`; missing label is `""`; regexes anchored `^(?s:…)$`) | `viz-storage::select` | Translates the operator enum, nothing else. The evaluator never re-applies a matcher. |
//! | `__name__` | An ordinary label in storage. `viz-promql` turns `metric{…}` into a `__name__="metric"` matcher and decides when the name is dropped from results. | Passes it through. |
//! | Label order | `viz-storage` returns labels sorted by name in UTF-8 byte order (the batch contract). The evaluator checks and would sort; it never has to. | Nothing. |
//! | Series order | The evaluator sorts by label set; storage's order is irrelevant. | Nothing. |
//! | Time range | Both sides use inclusive `[min, max]` in Unix milliseconds as `i64`. The evaluator computes the range (lookback, range, offset, `@`, subquery steps). | Passes the two numbers through unchanged. |
//! | Timestamp units | Milliseconds as `i64` from the batch to the evaluator's result. Only `viz-promql`'s serialiser converts to Prometheus' float seconds. | Nothing. |
//! | De-duplication on `(series, ts)`, tail over lake, later over earlier | `viz-storage::select`, once. | Nothing; it hands the vectors over without copying. |
//! | Staleness markers | Storage keeps the bits `0x7ff0000000000002`; the evaluator interprets them (ends a series for instant selectors, is skipped in range vectors). | Moves the `Vec<f64>`; no arithmetic touches a value. |
//! | Limits | This adapter (samples, series, step points) and [`crate::Limits::check_query`]. | Counts what storage returned. |
use crate::error::{Limit, QueryError};
use crate::limits::Limits;
use std::cell::{Cell, RefCell};
use viz_promql::{MatchOp, Matcher, SelectorInfo, Series, SeriesSource};
use viz_storage::ScanInput;

/// What a query read. Returned with every result (DESIGN §6.5, cost visibility).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Stats {
    /// Calls the evaluator made to storage (one per selector per (sub)query).
    pub selects: u64,
    /// Series storage returned, summed over the calls.
    pub series: u64,
    /// Samples storage returned, summed over the calls.
    pub samples: u64,
    /// Points in the result.
    pub output_points: u64,
}

/// Translate a PromQL matcher into a storage matcher. The two enums mean the same thing.
pub fn to_storage_matcher(m: &Matcher) -> viz_storage::Matcher {
    let op = match m.op {
        MatchOp::Eq => viz_storage::MatchOp::Eq,
        MatchOp::Ne => viz_storage::MatchOp::Ne,
        MatchOp::Re => viz_storage::MatchOp::Re,
        MatchOp::Nre => viz_storage::MatchOp::NotRe,
    };
    viz_storage::Matcher { name: m.name.clone(), op, value: m.value.clone() }
}

/// A [`SeriesSource`] that reads lake files and tail batches through
/// `viz_storage::select`, and enforces [`Limits`] on what comes back.
///
/// One instance serves one query: the counters accumulate over its `select` calls.
pub struct StorageSource<'a> {
    input: &'a ScanInput<'a>,
    limits: Limits,
    /// Step count per selector, from `viz_promql::selectors`, for `max_step_points`.
    plan: Vec<SelectorInfo>,
    /// Steps assumed for a `select` call that is not in the plan.
    default_steps: u64,
    selects: Cell<u64>,
    series: Cell<u64>,
    samples: Cell<u64>,
    /// The precise error behind an `Error::Source` returned to the evaluator.
    failure: RefCell<Option<QueryError>>,
}

impl<'a> StorageSource<'a> {
    /// A source with no step information: `max_step_points` is checked as if every
    /// selector were evaluated at one step.
    pub fn new(input: &'a ScanInput<'a>, limits: Limits) -> StorageSource<'a> {
        StorageSource::with_plan(input, limits, Vec::new(), 1)
    }

    /// A source for a query whose selectors are `plan` (from `viz_promql::selectors`).
    pub fn with_plan(input: &'a ScanInput<'a>, limits: Limits, plan: Vec<SelectorInfo>, default_steps: u64) -> StorageSource<'a> {
        StorageSource {
            input,
            limits,
            plan,
            default_steps,
            selects: Cell::new(0),
            series: Cell::new(0),
            samples: Cell::new(0),
            failure: RefCell::new(None),
        }
    }

    /// Counters so far (`output_points` is filled in by the query functions).
    pub fn stats(&self) -> Stats {
        Stats { selects: self.selects.get(), series: self.series.get(), samples: self.samples.get(), output_points: 0 }
    }

    /// The error that made the last failing `select` fail, if any.
    pub fn take_failure(&self) -> Option<QueryError> {
        self.failure.borrow_mut().take()
    }

    fn fail(&self, e: QueryError) -> viz_promql::Error {
        let msg = e.message.clone();
        *self.failure.borrow_mut() = Some(e);
        viz_promql::Error::Source(msg)
    }

    fn steps_for(&self, matchers: &[Matcher], min: i64, max: i64) -> u64 {
        self.plan
            .iter()
            .filter(|s| s.min_ts_ms == min && s.max_ts_ms == max && s.matchers == matchers)
            .map(|s| s.steps as u64)
            .max()
            .unwrap_or(self.default_steps)
    }
}

impl SeriesSource for StorageSource<'_> {
    fn select(&self, matchers: &[Matcher], min_ts_ms: i64, max_ts_ms: i64) -> Result<Vec<Series>, viz_promql::Error> {
        let ms: Vec<viz_storage::Matcher> = matchers.iter().map(to_storage_matcher).collect();
        let found = viz_storage::select(self.input, &ms, min_ts_ms, max_ts_ms).map_err(|e| self.fail(QueryError::from_storage(e)))?;

        self.selects.set(self.selects.get() + 1);
        let series = self.series.get().saturating_add(found.len() as u64);
        self.series.set(series);
        if series > self.limits.max_series {
            return Err(self.fail(QueryError::limit(Limit::MaxSeries, self.limits.max_series, series, "series loaded")));
        }
        let n: u64 = found.iter().map(|s| s.ts.len() as u64).sum();
        let samples = self.samples.get().saturating_add(n);
        self.samples.set(samples);
        if samples >= self.limits.max_samples {
            return Err(self.fail(QueryError::limit(Limit::MaxSamples, self.limits.max_samples, samples, "samples loaded")));
        }
        let cells = (found.len() as u64).saturating_mul(self.steps_for(matchers, min_ts_ms, max_ts_ms));
        if cells > self.limits.max_step_points {
            return Err(self.fail(QueryError::limit(
                Limit::MaxStepPoints,
                self.limits.max_step_points,
                cells,
                "step points (series x steps) for one selector",
            )));
        }
        // Same shape on both sides: the vectors move, no sample is copied or touched.
        Ok(found.into_iter().map(|s| Series { labels: s.labels, ts: s.ts, values: s.values }).collect())
    }
}
