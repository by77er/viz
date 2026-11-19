//! Regular expressions follow Tempo's dialect: Go's RE2 syntax, fully anchored, `.` matching
//! a newline. `testdata/regex_dialect.json` lists subject strings, patterns, and the answers
//! Tempo v3.1.1 gave when run as a black box (`tools/probes/regex_dialect.py --record`, which
//! ran every pattern in four query forms; all four agreed). This test runs the same queries
//! through viz and requires the same answers:
//!
//! - a pattern Tempo accepts matches exactly the subjects Tempo matched, with `=~`, `!~`
//!   (the complement), inside a structural query, and through a pruned search;
//! - a pattern Tempo rejects is rejected (`Error::Parse`, `Validation` or `Unsupported`);
//! - Unicode classes (`\p{…}`, `\P{…}`), which Tempo supports and viz does not, are
//!   refused with `Error::Unsupported`, never answered differently (README, Not implemented).

use serde_json::Value;
use viz_traceql::*;

const S: u64 = 1_700_000_000_000_000_000;

fn span(id: u64, parent: Option<u64>, name: String, attrs: Vec<(String, AttrValue)>) -> Span {
    Span {
        span_id: id.to_be_bytes(),
        parent_span_id: parent.map(|p| p.to_be_bytes()),
        name,
        start_unix_nano: S,
        end_unix_nano: S + 1_000_000,
        resource: vec![("service.name".into(), AttrValue::Str("regex".into()))],
        attrs,
        ..Default::default()
    }
}

/// The probe's trace: a root and one child per subject, carrying it as `span.s`. Span `i + 1`
/// holds subject `i`; span 0 is the root.
fn trace(subjects: &[String]) -> Trace {
    let mut spans = vec![span(0xFFFF, None, "root".into(), vec![])];
    for (i, s) in subjects.iter().enumerate() {
        spans.push(span(i as u64 + 1, Some(0xFFFF), format!("s{i}"), vec![("s".into(), AttrValue::Str(s.clone()))]));
    }
    Trace::new([0x5e; 16], spans)
}

/// Subjects matched by a query: span indices minus the root, as subject indices.
fn matched(q: &str, t: &Trace) -> Result<Vec<usize>, Error> {
    let sets = matching_spansets(q, t)?;
    let mut out: Vec<usize> = sets.into_iter().flatten().filter(|&i| i > 0).map(|i| i - 1).collect();
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

fn is_unicode_class(p: &str) -> bool {
    // `\p` or `\P` as an escape (not an escaped backslash followed by `p`).
    let b = p.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'\\' {
            if b[i + 1] == b'p' || b[i + 1] == b'P' {
                return true;
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    false
}

#[test]
fn regexes_answer_as_tempo_does() {
    let text = include_str!("../testdata/regex_dialect.json");
    let spec: Value = serde_json::from_str(text).expect("regex_dialect.json");
    let subjects: Vec<String> =
        spec["subjects"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
    let t = trace(&subjects);
    let src = MemSource::new(vec![t.clone()]).pruning(true);
    let all: Vec<usize> = (0..subjects.len()).collect();
    let mut failures = Vec::new();
    let (mut accepted, mut rejected, mut unsupported) = (0, 0, 0);
    for case in spec["cases"].as_array().unwrap() {
        let p = case["pattern"].as_str().unwrap();
        assert!(case.get("tempo_forms").is_none(), "{p:?}: Tempo's query forms disagree; this test assumes they agree");
        let plain = format!("{{ span.s =~ `{p}` }}");
        let got = matched(&plain, &t);
        if is_unicode_class(p) {
            unsupported += 1;
            if !matches!(got, Err(Error::Unsupported(_))) {
                failures.push(format!("{p:?}: Unicode class, expected Unsupported, got {got:?}"));
            }
            continue;
        }
        match &case["tempo"] {
            Value::Object(e) => {
                rejected += 1;
                match got {
                    Err(Error::Parse { .. } | Error::Validation { .. } | Error::Unsupported(_)) => {}
                    other => failures.push(format!("{p:?}: Tempo rejects it ({}), viz gave {other:?}", e["error"])),
                }
            }
            Value::Array(want) => {
                accepted += 1;
                let want: Vec<usize> = want.iter().map(|v| v.as_u64().unwrap() as usize).collect();
                let show = |v: &[usize]| v.iter().map(|&i| subjects[i].chars().take(12).collect::<String>()).collect::<Vec<_>>();
                match got {
                    Ok(g) if g == want => {}
                    Ok(g) => {
                        failures.push(format!("{p:?}: Tempo matched {:?}, viz {:?}", show(&want), show(&g)));
                        continue;
                    }
                    Err(e) => {
                        failures.push(format!("{p:?}: Tempo matched {:?}, viz refused: {e}", show(&want)));
                        continue;
                    }
                }
                // `!~` matches the complement (every subject is a string).
                let comp: Vec<usize> = all.iter().copied().filter(|i| !want.contains(i)).collect();
                match matched(&format!("{{ span.s !~ `{p}` }}"), &t) {
                    Ok(g) if g == comp => {}
                    other => failures.push(format!("{p:?}: !~ gave {other:?}")),
                }
                // Inside a structural query, and through a search whose plan prunes.
                match matched(&format!("{{ name = \"root\" }} > {{ span.s =~ `{p}` }}"), &t) {
                    Ok(g) if g == want => {}
                    other => failures.push(format!("{p:?}: structural form gave {other:?}")),
                }
                let r = search(&src, &plain, &SearchRequest::default()).map(|r| r.traces.len());
                if r != Ok(usize::from(!want.is_empty())) {
                    failures.push(format!("{p:?}: pruned search returned {r:?} traces"));
                }
            }
            other => panic!("{p:?}: no recorded answer: {other}"),
        }
    }
    println!("{accepted} patterns Tempo accepts, {rejected} it rejects, {unsupported} Unicode classes (Unsupported here)");
    assert!(accepted > 100 && rejected > 40, "the case file is smaller than expected");
    assert!(failures.is_empty(), "{} of {} patterns differ from Tempo:\n{}", failures.len(), accepted + rejected + unsupported, failures.join("\n"));
}
