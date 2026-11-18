//! The upstream Prometheus `promqltest` corpus (the copy in `../promql/testdata/upstream`)
//! evaluated THROUGH storage: every `load` is turned into `VZB1` batches, part of them
//! flushed to Parquet (several segments, small row groups, one UTC day per file), part
//! left in the tail with an overlap. Each case must have exactly the outcome it has with
//! `viz-promql`'s in-memory source.
//!
//! `cargo test --test corpus -- --nocapture` prints the per-file table.
mod common;

use common::*;
use std::fs;
use std::path::PathBuf;
use viz_promql::promqltest::{run_script, run_script_with_source, upstream_options, Outcome, Report, SkipReason};
use viz_promql::{Error, Matcher, Series, SeriesSource};
use viz_query::{Limits, StorageSource};

/// A `SeriesSource` that owns its files and batches.
struct Owned(Stored);

impl SeriesSource for Owned {
    fn select(&self, matchers: &[Matcher], min: i64, max: i64) -> Result<Vec<Series>, Error> {
        let input = self.0.input();
        StorageSource::new(&input, Limits::unlimited()).select(matchers, min, max)
    }
}

/// Lay the loaded series out in storage. `variant` picks the placement.
fn to_storage(series: &[Series], variant: usize) -> Result<Box<dyn SeriesSource>, String> {
    for s in series {
        if !s.labels.iter().any(|(n, _)| n == "__name__") || s.labels.iter().any(|(_, v)| v.is_empty()) || s.ts.iter().any(|t| *t < 0) {
            return Err(format!("series {:?} cannot be stored in a VZB1 batch", s.labels));
        }
    }
    let b = series_to_batches(series, 37);
    let n = b.len();
    let layout = match variant {
        // Two thirds flushed in three segments with tiny row groups, the tail overlapping one batch.
        0 => Layout { flushed: n * 2 / 3, tail_from: (n * 2 / 3).saturating_sub(1), segment_cuts: vec![n / 5, n / 2], row_group_rows: 13, compact: false },
        // Everything in Parquet, compacted per day.
        1 => Layout { flushed: n, tail_from: n, segment_cuts: vec![n / 3], row_group_rows: 100_000, compact: true },
        // Everything in the tail.
        _ => Layout::all_tail(),
    };
    Ok(Box::new(Owned(store(&b, &layout))))
}

fn counts(r: &Report) -> (usize, usize, usize, usize, usize, usize) {
    (
        r.passed(),
        r.failed(),
        r.skipped(),
        r.skipped_for(SkipReason::NativeHistogram),
        r.skipped_for(SkipReason::Unsupported),
        r.skipped_for(SkipReason::Parser),
    )
}

fn kind(o: &Outcome) -> String {
    match o {
        Outcome::Passed => "passed".into(),
        Outcome::Failed(_) => "failed".into(),
        Outcome::Skipped(r, _) => format!("skipped({r:?})"),
    }
}

#[test]
fn upstream_corpus_through_storage() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../promql/testdata/upstream");
    let mut files: Vec<PathBuf> =
        fs::read_dir(&dir).expect("../promql/testdata/upstream").filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "test")).collect();
    files.sort();
    assert_eq!(files.len(), 13, "the corpus has 13 files");
    let opts = upstream_options();
    let variants = ["lake + tail", "lake, compacted", "tail only"];
    println!("{:<26} | {:^22} | {:^22} | {:^22} | {:^22}", "", "viz-promql (memory)", variants[0], variants[1], variants[2]);
    println!("{:<26} | {:>6} {:>6} {:>7}  | {:>6} {:>6} {:>7}  | {:>6} {:>6} {:>7}  | {:>6} {:>6} {:>7}", "file", "pass", "fail", "skip", "pass", "fail", "skip", "pass", "fail", "skip", "pass", "fail", "skip");
    let mut totals = [(0, 0, 0); 4];
    let mut differences = Vec::new();
    for p in &files {
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        let text = fs::read_to_string(p).unwrap();
        let mem = run_script(&text, &opts).unwrap_or_else(|e| panic!("{name}: {e}"));
        let mut row = format!("{:<26} | {:>6} {:>6} {:>7} ", name, mem.passed(), mem.failed(), mem.skipped());
        totals[0] = (totals[0].0 + mem.passed(), totals[0].1 + mem.failed(), totals[0].2 + mem.skipped());
        for v in 0..3 {
            let got = run_script_with_source(&text, &opts, &|s| to_storage(s, v)).unwrap_or_else(|e| panic!("{name} through storage ({}): {e}", variants[v]));
            row.push_str(&format!(" | {:>6} {:>6} {:>7} ", got.passed(), got.failed(), got.skipped()));
            totals[v + 1] = (totals[v + 1].0 + got.passed(), totals[v + 1].1 + got.failed(), totals[v + 1].2 + got.skipped());
            if counts(&got) != counts(&mem) {
                differences.push(format!("{name} ({}): {:?} through storage, {:?} in memory", variants[v], counts(&got), counts(&mem)));
            }
            // Not only the totals: every single case has the same outcome.
            assert_eq!(got.cases.len(), mem.cases.len(), "{name}");
            for (a, b) in got.cases.iter().zip(&mem.cases) {
                if kind(&a.outcome) != kind(&b.outcome) || a.touched_native_histogram != b.touched_native_histogram {
                    differences.push(format!("{name}:{} ({}) {}: {:?} through storage, {:?} in memory", a.line, variants[v], a.expr, a.outcome, b.outcome));
                }
            }
        }
        println!("{row}");
    }
    let mut row = format!("{:<26}", "TOTAL");
    for t in totals {
        row.push_str(&format!(" | {:>6} {:>6} {:>7} ", t.0, t.1, t.2));
    }
    println!("{row}");
    assert!(differences.is_empty(), "the corpus behaves differently through storage:\n{}", differences.join("\n"));
    // The numbers viz-promql's README reports for this corpus.
    assert_eq!(totals[0], (935, 1, 167), "viz-promql's own numbers changed; update both READMEs");
    for t in &totals[1..] {
        assert_eq!(*t, totals[0]);
    }
}
