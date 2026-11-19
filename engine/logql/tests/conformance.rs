//! Conformance against Loki's own test tables, used only as a behavioural oracle: "this
//! query is accepted / rejected" and "this stage over this line and these labels gives this
//! line and these labels". The tables are fetched at test time by `tools/oracle/fetch.sh`
//! into the git-ignored `testdata/loki-oracle/` (Loki is AGPL-3.0; nothing of it is
//! committed). Without that file the test reports itself skipped and passes.
//!
//! Every case is passed, failed or skipped (with a reason). Known failures are pinned, with
//! their explanation, in `tests/conformance_known_failures.txt`; the test fails if a case
//! fails that is not listed, or a listed case passes (so the list stays true).
//!
//! `cargo test --test conformance -- --nocapture`

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use viz_logql::{parse, query_range, Data, Direction, Error, Expr, LogRow, LogStream, MemSource, Options};

const S: i64 = 1_000_000_000;
const SEL: &str = "__oracle_stream__";

fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn labels(v: &Value) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = match v {
        Value::Object(m) => m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect(),
        _ => Vec::new(),
    };
    out.sort();
    out
}

enum Outcome {
    Pass,
    Fail(String),
    Skip(String),
}

/// Run `pipeline` over one entry; returns the result labels (without the selector label)
/// and line, `None` when the entry is filtered out.
fn run(pipeline: &str, lbs: &[(String, String)], meta: &[(String, String)], line: &str, ts: i64) -> Result<Option<(Vec<(String, String)>, String)>, Error> {
    let mut stream_labels: Vec<(String, String)> = lbs.iter().filter(|(_, v)| !v.is_empty()).cloned().collect();
    stream_labels.push((SEL.into(), "1".into()));
    let src = MemSource::new(vec![LogStream { labels: stream_labels, rows: vec![LogRow { ts_ns: ts, line: line.into(), metadata: meta.to_vec() }] }]);
    let q = format!("{{{SEL}=\"1\"}} {pipeline}");
    // The caller's clock, for `now` (the engine has none).
    let opts = Options { limit: 1000, direction: Direction::Forward, now_ns: Some(1_700_000_000 * S), ..Options::default() };
    let r = query_range(&src, &q, ts, ts + 1, S, &opts)?;
    let Data::Streams(s) = r.data else { unreachable!() };
    Ok(s.into_iter().next().map(|s| (s.labels.into_iter().filter(|(k, _)| k != SEL).collect(), s.entries[0].1.clone())))
}

fn check(pipeline: &str, c: &Value, lbs_key: &str, want_key: &str, line_key: &str, want_line_key: Option<&str>) -> Outcome {
    let lbs = labels(&c[lbs_key]);
    if lbs.iter().any(|(_, v)| v.is_empty()) {
        return Outcome::Skip("an input label has an empty value, which a stream cannot carry (contracts/LOGS.md)".into());
    }
    let meta = labels(c.get("structuredMetadata").unwrap_or(&Value::Null));
    let line = c[line_key].as_str().unwrap_or("");
    let ts = c.get("ts").and_then(|t| t.as_i64()).unwrap_or(S);
    let got = match run(pipeline, &lbs, &meta, line, ts) {
        Ok(g) => g,
        Err(Error::Unsupported(m)) => return Outcome::Skip(format!("unsupported: {m}")),
        Err(e) => return Outcome::Fail(format!("error: {e}")),
    };
    let Some((got_labels, got_line)) = got else { return Outcome::Fail("entry filtered out".into()) };
    if !c[want_key].is_null() {
        let want = labels(&c[want_key]);
        // Loki's builder drops empty-valued labels from the expected sets; compare without them
        // only when the expectation has none.
        if got_labels != want {
            return Outcome::Fail(format!("labels {got_labels:?} want {want:?}"));
        }
    }
    if let Some(k) = want_line_key {
        let want = c[k].as_str().unwrap_or("");
        if got_line != want {
            return Outcome::Fail(format!("line {got_line:?} want {want:?}"));
        }
    }
    Outcome::Pass
}

fn parse_case(c: &Value, kind: &str) -> Outcome {
    let q = c["in"].as_str().unwrap_or("");
    let want_err = c["err"].as_bool().unwrap_or(false);
    let got = parse(q);
    let rejected = match (&got, kind) {
        (Err(Error::Unsupported(m)), _) => return Outcome::Skip(format!("unsupported: {m}")),
        (Err(_), _) => true,
        (Ok(Expr::Log(_)), "parse_sample") => true,
        (Ok(Expr::Metric(_)), "parse_log") => true,
        _ => false,
    };
    if rejected == want_err {
        Outcome::Pass
    } else if want_err {
        Outcome::Fail("accepted; Loki rejects".into())
    } else {
        Outcome::Fail(format!("rejected ({}); Loki accepts", got.err().map(|e| e.to_string()).unwrap_or_default()))
    }
}

fn label_format_stage(v: &Value) -> Option<String> {
    let mut parts = Vec::new();
    for f in v["label_format"].as_array()? {
        if let Some(r) = f.get("rename") {
            parts.push(format!("{}={}", r[0].as_str()?, r[1].as_str()?));
        } else if let Some(t) = f.get("template") {
            parts.push(format!("{}={}", t[0].as_str()?, quote(t[1].as_str()?)));
        }
    }
    Some(format!("| label_format {}", parts.join(", ")))
}

fn extraction(exprs: &Value) -> Option<String> {
    let parts: Option<Vec<String>> =
        exprs.as_array()?.iter().map(|e| Some(format!("{}={}", e[0].as_str()?, quote(e[1].as_str()?)))).collect();
    Some(parts?.join(", "))
}

fn case(kind: &str, c: &Value) -> Vec<(String, Outcome)> {
    let one = |o: Outcome| vec![(String::new(), o)];
    match kind {
        "parse" | "parse_sample" | "parse_log" => one(parse_case(c, kind)),
        "json" => one(check("| json", c, "lbs", "want", "line", None)),
        "json_expr" => match extraction(&c["expressions"]) {
            Some(e) => one(check(&format!("| json {e}"), c, "lbs", "want", "line", None)),
            None => one(Outcome::Skip("expressions not plain data".into())),
        },
        "regexp" => match c["parser"]["regexp"].as_str() {
            Some(re) => one(check(&format!("| regexp {}", quote(re)), c, "lbs", "want", "line", None)),
            None => one(Outcome::Skip("parser not plain data".into())),
        },
        "logfmt" => {
            let mut out = vec![("non-strict".to_string(), check("| logfmt", c, "lbs", "want", "line", None))];
            // An empty `wantStrict` means "the same as `want`".
            if c["wantStrict"].as_object().is_some_and(|o| !o.is_empty()) {
                out.push(("strict".to_string(), check("| logfmt --strict", c, "lbs", "wantStrict", "line", None)));
            }
            out
        }
        "logfmt_keep_empty" => {
            let p = if c["keepEmpty"].as_bool().unwrap_or(false) { "| logfmt --keep-empty" } else { "| logfmt" };
            one(check(p, c, "lbs", "want", "line", None))
        }
        "logfmt_expr" => match extraction(&c["expressions"]) {
            Some(e) => one(check(&format!("| logfmt {e}"), c, "lbs", "want", "line", None)),
            None => one(Outcome::Skip("expressions not plain data".into())),
        },
        "unpack" => one(check("| unpack", c, "lbs", "wantLbs", "line", Some("wantLine"))),
        "pattern" => one(check(&format!("| pattern {}", quote(c["pattern"].as_str().unwrap_or(""))), c, "lbs", "want", "line", None)),
        "line_format" => {
            let t = c["fmter"]["line_format"].as_str().unwrap_or("");
            one(check(&format!("| line_format {}", quote(t)), c, "lbs", "wantLbs", "in", Some("want")))
        }
        "label_format" if c["fmter"].to_string().contains("__line__") || c["fmter"].to_string().contains("__timestamp__") => {
            one(Outcome::Skip("the case's line and timestamp are set in the test body, not in the table".into()))
        }
        "label_format" => match label_format_stage(&c["fmter"]) {
            Some(st) => one(check(&st, c, "in", "want", "__no_line__", None)),
            None => one(Outcome::Skip("formatter not plain data".into())),
        },
        _ => one(Outcome::Skip(format!("unknown kind {kind}"))),
    }
}

#[test]
fn loki_test_tables() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/loki-oracle/cases.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        eprintln!("SKIPPED: {path} is absent; run tools/oracle/fetch.sh to fetch Loki's test tables");
        return;
    };
    let tables: Value = serde_json::from_str(&text).unwrap();
    let known_text = include_str!("conformance_known_failures.txt");
    let known: BTreeSet<String> =
        known_text.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#')).map(|l| l.split(" #").next().unwrap().trim().to_string()).collect();
    let mut totals: BTreeMap<String, (u32, u32, u32, u32)> = BTreeMap::new();
    let mut unexpected = Vec::new();
    let mut seen_failures = BTreeSet::new();
    for t in tables.as_array().unwrap() {
        let kind = t["kind"].as_str().unwrap();
        let table = t["table"].as_str().unwrap().to_string();
        let e = totals.entry(table.clone()).or_default();
        e.3 += t["skipped"].as_array().map(|a| a.len()).unwrap_or(0) as u32;
        for c in t["cases"].as_array().unwrap() {
            for (variant, o) in case(kind, c) {
                let id = format!("{table}:{}{}", c["src_line"], if variant.is_empty() { String::new() } else { format!(":{variant}") });
                match o {
                    Outcome::Pass => {
                        e.0 += 1;
                        if known.contains(&id) {
                            unexpected.push(format!("{id} passes but is listed as a known failure"));
                        }
                    }
                    Outcome::Fail(why) => {
                        e.1 += 1;
                        seen_failures.insert(id.clone());
                        if !known.contains(&id) {
                            let what = c.get("in").or(c.get("name")).cloned().unwrap_or(Value::Null);
                            unexpected.push(format!("{id} {what}: {why}"));
                        }
                    }
                    Outcome::Skip(why) => {
                        e.2 += 1;
                        eprintln!("skip {id}: {why}");
                    }
                }
            }
        }
    }
    let (mut p, mut f, mut s, mut x) = (0, 0, 0, 0);
    eprintln!("{:<45} {:>6} {:>6} {:>6} {:>12}", "table", "pass", "fail", "skip", "not-extracted");
    for (t, (a, b, c, d)) in &totals {
        eprintln!("{t:<45} {a:>6} {b:>6} {c:>6} {d:>12}");
        p += a;
        f += b;
        s += c;
        x += d;
    }
    eprintln!("{:<45} {p:>6} {f:>6} {s:>6} {x:>12}", "TOTAL");
    for k in &known {
        if !seen_failures.contains(k) && !unexpected.iter().any(|u| u.starts_with(k.as_str())) {
            unexpected.push(format!("{k} is listed as a known failure but did not fail"));
        }
    }
    assert!(unexpected.is_empty(), "unexpected conformance results:\n{}", unexpected.join("\n"));
}
