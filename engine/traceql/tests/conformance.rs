//! Conformance against Grafana Tempo's own list of TraceQL examples, used only as a
//! behavioural oracle: which queries Tempo accepts, rejects while parsing, rejects while
//! validating, or reports as unsupported. The file is fetched at test time by
//! `tools/fetch_tempo_tests.sh` into `testdata/upstream/` (git-ignored, never committed;
//! Tempo is AGPL-3.0). Without it the test reports that it was skipped.
//!
//! `cargo test --test conformance -- --nocapture` prints the table in README.md.

use viz_traceql::{parse, Error};

/// Parses the YAML subset of the example file: top-level `name:` sections and
/// `  - 'query'` / `  - "query"` items.
fn load(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut section = String::new();
    for line in text.lines() {
        if !line.starts_with(' ') && line.ends_with(':') && !line.starts_with('#') {
            section = line.trim_end_matches(':').to_string();
            continue;
        }
        let t = line.trim_start();
        let Some(item) = t.strip_prefix("- ") else { continue };
        let item = item.trim();
        let q = if let Some(rest) = item.strip_prefix('\'') {
            // single-quoted: '' is a quote; anything after the closing quote is a comment
            let mut s = String::new();
            let mut chars = rest.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\'' {
                    if chars.peek() == Some(&'\'') {
                        chars.next();
                        s.push('\'');
                        continue;
                    }
                    break;
                }
                s.push(c);
            }
            s
        } else if let Some(rest) = item.strip_prefix('"') {
            let mut s = String::new();
            let mut chars = rest.chars();
            while let Some(c) = chars.next() {
                match c {
                    '"' => break,
                    '\\' => match chars.next() {
                        Some('n') => s.push('\n'),
                        Some('t') => s.push('\t'),
                        Some('r') => s.push('\r'),
                        Some('"') => s.push('"'),
                        Some('\\') => s.push('\\'),
                        Some(o) => {
                            s.push('\\');
                            s.push(o)
                        }
                        None => {}
                    },
                    c => s.push(c),
                }
            }
            s
        } else {
            continue;
        };
        out.push((section.clone(), q));
    }
    out
}

fn kind(r: &Result<viz_traceql::ast::RootExpr, Error>) -> &'static str {
    match r {
        Ok(_) => "ok",
        Err(Error::Parse { .. }) => "parse",
        Err(Error::Validation { .. }) => "validation",
        Err(Error::Unsupported(_)) => "unsupported",
        Err(_) => "other",
    }
}

#[test]
fn tempo_examples() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/upstream/test_examples.yaml");
    let Ok(text) = std::fs::read_to_string(path) else {
        eprintln!("SKIPPED: {path} not found; run tools/fetch_tempo_tests.sh");
        return;
    };
    let cases = load(&text);
    assert!(cases.len() > 300, "the example file parsed to only {} queries", cases.len());
    // (section, outcome) -> count; failures listed.
    let mut table: std::collections::BTreeMap<(String, &'static str), usize> = Default::default();
    let mut failures = Vec::new();
    let mut unsupported_valid = Vec::new();
    for (section, q) in &cases {
        let r = parse(q);
        let k = kind(&r);
        *table.entry((section.clone(), k)).or_default() += 1;
        let pass = match section.as_str() {
            "valid" => k == "ok" || k == "unsupported",
            "parse_fails" | "validate_fails" => k == "parse" || k == "validation" || k == "unsupported",
            "unsupported" => k != "ok",
            _ => true,
        };
        if std::env::var("VIZ_SHOW").is_ok() && ((section == "parse_fails" && k != "parse") || (section == "validate_fails" && k != "validation") || (section == "unsupported" && k != "unsupported")) {
            println!("CATEGORY [{section}] {q:?} -> {k}: {}", r.as_ref().err().map(|e| e.to_string()).unwrap_or_default());
        }
        if section == "valid" && k == "unsupported" {
            unsupported_valid.push(format!("{q:?}: {}", r.as_ref().err().map(|e| e.to_string()).unwrap_or_default()));
        }
        if section != "dump" && !pass {
            failures.push(format!("[{section}] {q:?} -> {k}: {:?}", r.err()));
        }
    }
    println!("\nsection          outcome       count");
    for ((s, k), n) in &table {
        println!("{s:<16} {k:<12} {n:>6}");
    }
    println!("\nvalid in Tempo, Unsupported here ({}):", unsupported_valid.len());
    for u in &unsupported_valid {
        println!("  {u}");
    }
    println!("\nfailures ({}):", failures.len());
    for f in &failures {
        println!("  {f}");
    }
    let expected_failures: Vec<&str> = include_str!("../testdata/conformance_known_failures.txt")
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .collect();
    let mut unexpected: Vec<&String> = failures.iter().filter(|f| !expected_failures.iter().any(|e| f.starts_with(e))).collect();
    unexpected.sort();
    assert!(unexpected.is_empty(), "unexpected conformance failures:\n{unexpected:#?}");
}
