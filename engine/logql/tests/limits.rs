//! Pathological nesting and sizes: every input below must come back as an error (or a
//! result), never a stack overflow or panic (`engine/AGENTS.md`: never panic on input; a
//! panic or overflow aborts a WASM isolate). The same inputs run in WASM through
//! `wasm-check/limits.mjs`. Queries at the limits must still evaluate.

use viz_logql::*;

const S: i64 = 1_000_000_000;
const DEEP: usize = 20_000;

fn src(lines: &[&str]) -> MemSource {
    MemSource::new(vec![LogStream {
        labels: vec![("app".into(), "a".into())],
        rows: lines.iter().enumerate().map(|(i, l)| LogRow { ts_ns: (i as i64 + 1) * S, line: l.to_string(), metadata: vec![] }).collect(),
    }])
}

fn opts() -> Options {
    Options { limit: 100, direction: Direction::Forward, ..Options::default() }
}

fn run(q: &str) -> Result<QueryResult, Error> {
    query_range(&src(&["a=1 x=2", r#"{"a":"1"}"#]), q, 0, 10 * S, S, &opts())
}

fn assert_too_deep(q: &str) {
    match run(q) {
        Err(Error::Parse { msg, .. }) => assert!(msg.contains("nested more than"), "{msg}"),
        other => panic!("expected a nesting error for a query of {} bytes, got {other:?}", q.len()),
    }
    assert!(selectors(q, 0, 10 * S, S).is_err());
}

#[test]
fn query_nesting_is_bounded() {
    let parens = |n: usize, inner: &str| format!("{}{inner}{}", "(".repeat(n), ")".repeat(n));
    assert_too_deep(&parens(DEEP, "1"));
    assert_too_deep(&parens(DEEP, r#"count_over_time({app="a"}[1m])"#));
    assert_too_deep(&format!("{}{}", "sum(".repeat(DEEP), r#"count_over_time({app="a"}[1m])"#.to_string() + &")".repeat(DEEP)));
    assert_too_deep(&format!("{}{}", "label_replace(".repeat(DEEP), r#"vector(1)"#.to_string() + &r#", "a", "b", "c", "d")"#.repeat(DEEP)));
    assert_too_deep(&vec!["1"; DEEP].join(" + "));
    assert_too_deep(&vec!["2"; DEEP].join(" ^ "));
    assert_too_deep(&vec![r#"count_over_time({app="a"}[1m])"#; 5_000].join(" or "));
    assert_too_deep(&format!(r#"count_over_time({{app="a"}}[1m]) {}"#, "> bool 1 ".repeat(DEEP)));
    assert_too_deep(&format!(r#"{{app="a"}} | logfmt | {}"#, parens(DEEP, r#"a="1""#)));
    assert_too_deep(&format!(r#"{{app="a"}} | logfmt | {}"#, vec![r#"a="1""#; DEEP].join(" and ")));
    assert_too_deep(&format!(r#"{{app="a"}} | logfmt | {}"#, vec![r#"a > 0"#; DEEP].join(", ")));
    assert_too_deep(&format!(r#"sum_over_time({{app="a"}} | logfmt | unwrap a | {} [1m])"#, vec![r#"a > 0"#; DEEP].join(" or ")));
    // Shallow recursion, tall tree: chains at every level of parentheses.
    let mut q = r#"count_over_time({app="a"}[1m])"#.to_string();
    for _ in 0..90 {
        q = format!("({q}) + 1 + 1 + 1");
    }
    assert_too_deep(&q);
    let mut f = r#"a="1""#.to_string();
    for _ in 0..90 {
        f = format!(r#"({f}) and a="1" and a="1""#);
    }
    assert_too_deep(&format!(r#"{{app="a"}} | logfmt | {f}"#));
}

#[test]
fn queries_at_the_limit_evaluate() {
    // Just inside the limit: nested parentheses, a long chain, nested aggregations.
    let n = parser_limit() - 2;
    let q = format!("{}{}{}", "(".repeat(n), r#"count_over_time({app="a"}[1m])"#, ")".repeat(n));
    run(&q).unwrap();
    let q = vec![r#"count_over_time({app="a"}[1m])"#; n].join(" + ");
    let r = run(&q).unwrap();
    assert!(r.data_json().contains(&format!("\"{}\"", n * 2)), "{}", r.data_json().get(..200).unwrap_or(""));
    let q = format!("{}{}{}", "sum(".repeat(n - 1), r#"count_over_time({app="a"}[1m])"#, ")".repeat(n - 1));
    run(&q).unwrap();
    let q = format!(r#"{{app="a"}} | logfmt | {}"#, vec![r#"a > 0"#; n].join(" and "));
    assert_eq!(run(&q).unwrap().stats.returned, 1);
    let q = format!(r#"{{app="a"}} | logfmt | {}"#, format!("{}{}{}", "(".repeat(n), r#"a="1""#, ")".repeat(n)));
    assert_eq!(run(&q).unwrap().stats.returned, 1);
}

fn parser_limit() -> usize {
    // The documented limit (src/parser.rs MAX_DEPTH); asserted here so a change is noticed.
    let ok = format!("{}1{}", "(".repeat(98), ")".repeat(98));
    assert!(parse(&ok).is_ok());
    let bad = format!("{}1{}", "(".repeat(101), ")".repeat(101));
    assert!(parse(&bad).is_err());
    100
}

fn template_query(t: &str) -> String {
    format!("{{app=\"a\"}} | logfmt | line_format `{t}`")
}

#[test]
fn template_nesting_is_bounded() {
    let too_deep = |t: &str| match run(&template_query(t)) {
        Err(Error::Parse { msg, .. }) => assert!(msg.contains("template nested more than"), "{msg}"),
        other => panic!("expected a template nesting error, got {other:?}"),
    };
    too_deep(&format!("{}x{}", "{{if .a}}".repeat(DEEP), "{{end}}".repeat(DEEP)));
    too_deep(&format!("{}x{}", "{{with .a}}".repeat(DEEP), "{{end}}".repeat(DEEP)));
    too_deep(&format!("{}x{}", "{{range $i := .a}}".repeat(DEEP), "{{end}}".repeat(DEEP)));
    too_deep(&format!("{{{{if .a}}}}{}{{{{end}}}}", "{{else if .b}}".repeat(DEEP)));
    too_deep(&format!("{{{{ {}1{} }}}}", "(".repeat(DEEP), ")".repeat(DEEP)));
    too_deep(&format!("{{{{ {}.a{} }}}}", "(print ".repeat(DEEP), ")".repeat(DEEP)));
    // Label templates use the same parser.
    assert!(run(&format!("{{app=\"a\"}} | label_format x=`{}x{}`", "{{if .a}}".repeat(DEEP), "{{end}}".repeat(DEEP))).is_err());
    // At the limit a template still runs.
    let n = 99;
    let r = run(&template_query(&format!("{}y{}", "{{if .a}}".repeat(n), "{{end}}".repeat(n)))).unwrap();
    assert!(r.data_json().contains(r#""y""#), "{}", r.data_json());
    let r = run(&template_query(&format!("{{{{ {}.a{} }}}}", "(print ".repeat(n - 1), ")".repeat(n - 1)))).unwrap();
    assert!(r.data_json().contains(r#""1""#), "{}", r.data_json());
}

#[test]
fn deep_json_lines_are_parser_errors() {
    let arrays = "[".repeat(200_000);
    let objects = r#"{"a":"#.repeat(100_000);
    let closed = format!("{}1{}", r#"{"a":"#.repeat(200), "}".repeat(200));
    let s = src(&[&arrays, &objects, &closed]);
    for q in [
        r#"{app="a"} | json"#,
        r#"{app="a"} | json x="a.a.a""#,
        r#"{app="a"} | unpack"#,
        r#"{app="a"} | line_format "{{ fromJson __line__ }}""#,
        r#"{app="a"} | line_format "{{ len (fromJson __line__) }}""#,
    ] {
        let r = query_range(&s, q, 0, 10 * S, S, &opts()).unwrap_or_else(|e| panic!("{q}: {e}"));
        assert_eq!(r.stats.returned, 3, "{q}");
    }
    let r = query_range(&s, r#"{app="a"} | json"#, 0, 10 * S, S, &opts()).unwrap();
    // Too deep is "Malformed JSON error"; the array line is not an object at all.
    assert!(r.data_json().contains("Malformed JSON error"), "{}", r.data_json().get(..300).unwrap_or(""));
}

#[test]
fn pathological_regexes_are_errors() {
    let nested = format!("{}a{}", "(".repeat(DEEP), ")".repeat(DEEP));
    let huge = "a{1000}{1000}{1000}";
    for re in [&nested, huge] {
        // Line filters compile at execution; matchers and regexp at parse time.
        assert!(run(&format!(r#"{{app="a"}} |~ `{re}`"#)).is_err(), "line filter {}", &re[..20.min(re.len())]);
        assert!(run(&format!(r#"{{app=~`{re}`}}"#)).is_err());
        assert!(run(&format!(r#"{{app="a"}} | logfmt | a=~`{re}`"#)).is_err());
        assert!(run(&format!(r#"{{app="a"}} | regexp `(?P<x>{re})`"#)).is_err());
        assert!(run(&format!(r#"{{app="a"}} | line_format `{{{{ regexReplaceAll "{re}" __line__ "x" }}}}`"#)).map(|r| r.data_json().contains("TemplateFormatErr")).unwrap_or(true));
    }
}
