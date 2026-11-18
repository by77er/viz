//! Runs the upstream Prometheus `promqltest` corpus (testdata/upstream/*.test).
//!
//! `cargo test --test upstream -- --nocapture` prints the per-file table.
//! Set `VIZ_PROMQL_VERBOSE=1` to also print every failed and skipped case.

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

    let mut failures: BTreeSet<String> = BTreeSet::new();
    let mut detail = String::new();
    let (mut tp, mut tf, mut ts) = (0, 0, 0);
    println!("{:<28} {:>6} {:>6} {:>7}   (skipped: native-histogram / unsupported / parser)", "file", "passed", "failed", "skipped");
    for p in &files {
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        let text = fs::read_to_string(p).unwrap();
        let rep = run_script(&text, &opts).unwrap_or_else(|e| panic!("{name}: script error: {e}"));
        println!(
            "{:<28} {:>6} {:>6} {:>7}   ({} / {} / {})",
            name,
            rep.passed(),
            rep.failed(),
            rep.skipped(),
            rep.skipped_for(SkipReason::NativeHistogram),
            rep.skipped_for(SkipReason::Unsupported),
            rep.skipped_for(SkipReason::Parser)
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
                Outcome::Skipped(r, m) if verbose => {
                    detail.push_str(&format!("SKIP {name}:{} [{r:?}] {} -- {m}\n", c.line, c.expr));
                }
                _ => {}
            }
        }
    }
    println!("{:<28} {:>6} {:>6} {:>7}", "TOTAL", tp, tf, ts);
    if verbose {
        println!("{detail}");
    }
    let unexpected: Vec<&String> = failures.difference(&known).collect();
    let fixed: Vec<&String> = known.difference(&failures).collect();
    assert!(
        unexpected.is_empty(),
        "cases failing that are not listed in testdata/{known_file}: {unexpected:?}\n{detail}"
    );
    assert!(fixed.is_empty(), "cases listed in testdata/{known_file} now pass; remove them: {fixed:?}");
}
