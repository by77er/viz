//! Runs the upstream Prometheus `promqltest` corpus (testdata/upstream/*.test).
//!
//! `cargo test --test upstream -- --nocapture` prints the per-file table.
//! Set `VIZ_PROMQL_VERBOSE=1` to also print every failed and skipped case.
//! Failures must match `testdata/known_failures*.txt` and skips must match
//! `testdata/expected_skips.txt` exactly.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use viz_promql::promqltest::{run_script, upstream_options, Outcome, SkipReason};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata")
}

#[test]
fn upstream_corpus() {
    run(upstream_options(), "known_failures.txt");
}

/// The same corpus with the engine's default options (delayed name removal
/// off, which is what production uses). The upstream expectations were
/// written for delayed name removal, so the cases that depend on it are
/// listed in `known_failures_default_options.txt`.
#[test]
fn upstream_corpus_default_options() {
    let mut o = upstream_options();
    o.delayed_name_removal = false;
    run(o, "known_failures_default_options.txt");
}

fn run(opts: viz_promql::EvalOptions, known_file: &str) {
    let verbose = std::env::var("VIZ_PROMQL_VERBOSE").is_ok();
    let mut files: Vec<PathBuf> = fs::read_dir(dir().join("upstream"))
        .expect("testdata/upstream")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "test"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no upstream test files found");

    let known: BTreeSet<String> = fs::read_to_string(dir().join(known_file))
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.split_whitespace().next().unwrap().to_string())
        .collect();

    // Every skipped case is pinned too, so a regression that turns a passing
    // case into a "skipped" one cannot go unnoticed.
    let expected_skips: BTreeSet<String> = fs::read_to_string(dir().join("expected_skips.txt"))
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.split_whitespace().next().unwrap().to_string())
        .collect();
    let mut skips: BTreeSet<String> = BTreeSet::new();
    let mut skip_lines = String::new();
    let mut failures: BTreeSet<String> = BTreeSet::new();
    let mut detail = String::new();
    let (mut tp, mut tf, mut ts, mut tph) = (0, 0, 0, 0);
    println!("{:<28} {:>6} {:>6} {:>7}   (skipped: native-histogram / unsupported / parser)", "file", "passed", "failed", "skipped");
    for p in &files {
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        let text = fs::read_to_string(p).unwrap();
        let rep = run_script(&text, &opts).unwrap_or_else(|e| panic!("{name}: script error: {e}"));
        tph += rep.passed_touching_histograms();
        println!(
            "{:<28} {:>6} {:>6} {:>7}   ({} / {} / {})   passed-with-histogram-series-absent: {}",
            name,
            rep.passed(),
            rep.failed(),
            rep.skipped(),
            rep.skipped_for(SkipReason::NativeHistogram),
            rep.skipped_for(SkipReason::Unsupported),
            rep.skipped_for(SkipReason::Parser),
            rep.passed_touching_histograms()
        );
        tp += rep.passed();
        tf += rep.failed();
        ts += rep.skipped();
        for c in &rep.cases {
            match &c.outcome {
                Outcome::Failed(m) => {
                    failures.insert(format!("{name}:{}", c.line));
                    detail.push_str(&format!("FAIL {name}:{} {}\n     {m}\n", c.line, c.expr));
                }
                Outcome::Skipped(r, m) => {
                    skips.insert(format!("{name}:{}", c.line));
                    skip_lines.push_str(&format!("{name}:{} {r:?} {}\n", c.line, c.expr));
                    if verbose {
                        detail.push_str(&format!("SKIP {name}:{} [{r:?}] {} -- {m}\n", c.line, c.expr));
                    }
                }
                _ => {}
            }
        }
    }
    println!("{:<28} {:>6} {:>6} {:>7}   passed-with-histogram-series-absent: {}", "TOTAL", tp, tf, ts, tph);
    if verbose {
        println!("{detail}");
    }
    if std::env::var("VIZ_PROMQL_WRITE_SKIPS").is_ok() {
        let header = "# Upstream cases that are skipped, with the reason. Generated with VIZ_PROMQL_WRITE_SKIPS=1; checked by tests/upstream.rs.\n";
        fs::write(dir().join("expected_skips.txt"), format!("{header}{skip_lines}")).unwrap();
    } else {
        let new_skips: Vec<&String> = skips.difference(&expected_skips).collect();
        let gone: Vec<&String> = expected_skips.difference(&skips).collect();
        assert!(new_skips.is_empty(), "cases newly skipped (not in testdata/expected_skips.txt): {new_skips:?}");
        assert!(gone.is_empty(), "cases in testdata/expected_skips.txt are no longer skipped; regenerate it: {gone:?}");
    }
    let unexpected: Vec<&String> = failures.difference(&known).collect();
    let fixed: Vec<&String> = known.difference(&failures).collect();
    assert!(
        unexpected.is_empty(),
        "cases failing that are not listed in testdata/{known_file}: {unexpected:?}\n{detail}"
    );
    assert!(fixed.is_empty(), "cases listed in testdata/{known_file} now pass; remove them: {fixed:?}");
}
