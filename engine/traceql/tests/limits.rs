//! Pathological nesting and regexes: every query either runs or is refused with an error,
//! and none may exhaust the stack.
//!
//! A stack overflow is not a panic. Natively it aborts the whole test process ("has
//! overflowed its stack"); in WebAssembly it traps the instance. So these tests run each
//! query on a thread with a bounded stack ([`STACK`]), through every entry point: `parse`,
//! `plan`, `search`, `matching_spansets`, `query_range`, `query_instant` and the JSON
//! writers. A regression shows as this test binary dying. `tools/wasm-probe/check.mjs` runs
//! the same shapes in the WASM build. README, Verification, section 7, has the measurements.
//!
//! `PROPTEST_CASES` sets the number of cases of each property (default 48).

#[path = "common/shapes.rs"]
mod shapes;

use proptest::prelude::{prop_assert, proptest, ProptestConfig};
use shapes::{fill, FLAT, NESTED};
use viz_traceql::*;

/// Stack for every query here. Debug frames are 5 to 10 times larger than release ones: at
/// the limit the costliest shape (a 200-term `rate() + rate() + ...`) needs 2.6 MiB in the
/// debug build and 280 KiB in the release build, natively.
/// A query that escaped the limits recurses thousands of levels and overflows either.
const STACK: usize = if cfg!(debug_assertions) { 4 << 20 } else { 512 << 10 };

const S: u64 = 1_700_000_000_000_000_000;
const MS: u64 = 1_000_000;
const END: u64 = S + 10_000 * MS;

fn cases() -> u32 {
    std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(48)
}

/// Runs `f` on a thread with a [`STACK`]-byte stack. An overflow aborts the process.
fn bounded_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    match std::thread::Builder::new().stack_size(STACK).spawn(f).map(|h| h.join()) {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => panic!("the query thread panicked"),
        Err(e) => panic!("cannot start a thread: {e}"),
    }
}

/// A three-span chain, root -> child -> grandchild, every span with `a = 1`.
fn trace() -> Trace {
    let span = |id: u8, parent: Option<u8>| Span {
        span_id: [id; 8],
        parent_span_id: parent.map(|p| [p; 8]),
        name: format!("s{id}"),
        start_unix_nano: S + id as u64 * MS,
        end_unix_nano: S + (id as u64 + 10) * MS,
        resource: vec![("service.name".into(), AttrValue::Str("svc".into()))],
        attrs: vec![("a".into(), AttrValue::Int(1))],
        ..Default::default()
    };
    Trace::new([7; 16], vec![span(1, None), span(2, Some(1)), span(3, Some(2))])
}

/// Every entry point on `q`; the first error, or how many results it produced.
fn run_all(q: &str) -> Result<usize, Error> {
    let root = parse(q)?;
    plan(q, S, END)?;
    let src = MemSource::new(vec![trace()]);
    match root.query {
        ast::Query::Search(_) => {
            let req = SearchRequest { start_unix_nano: S, end_unix_nano: END, ..Default::default() };
            let r = search(&src, q, &req)?;
            let _ = r.to_json();
            matching_spansets(q, &trace())?;
            Ok(r.traces.len())
        }
        ast::Query::Metrics(_) => {
            let r = query_range(&src, q, &RangeRequest::range(S, END, 1_000 * MS))?;
            let _ = r.to_json();
            let i = query_instant(&src, q, S, END)?;
            let _ = i.to_json();
            Ok(r.series.len())
        }
    }
}

fn is_depth_error(r: &Result<usize, Error>) -> bool {
    matches!(r, Err(Error::Validation { msg, .. }) if msg.contains("nested deeper than"))
}

#[test]
fn each_shape_runs_at_its_limit_and_is_refused_one_past_it() {
    let failures = bounded_stack(|| {
        let mut failures = Vec::new();
        for s in NESTED {
            // The boundary, found by trying every n up to just past MAX_DEPTH.
            let mut accepted = 0;
            for n in 1..=MAX_DEPTH + 2 {
                match parse(&(s.make)(n)) {
                    Ok(_) => accepted = n,
                    Err(_) => break,
                }
            }
            if accepted != s.max {
                failures.push(format!("{}: largest accepted n is {accepted}, expected {}", s.name, s.max));
            }
            // Evaluated over every span whatever it matches (an odd number of `!`, or a `>>`
            // chain longer than the trace, matches nothing).
            if let Err(e) = run_all(&(s.make)(s.max)) {
                failures.push(format!("{} at n = {}: {e:?}", s.name, s.max));
            }
            let past = run_all(&(s.make)(s.max + 1));
            if !is_depth_error(&past) {
                failures.push(format!("{} at n = {}: expected the depth error, got {past:?}", s.name, s.max + 1));
            }
        }
        failures
    });
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn far_past_the_limit_is_refused_not_crashed() {
    let failures = bounded_stack(|| {
        let mut failures = Vec::new();
        for s in NESTED {
            let n = fill(s.make, MAX_QUERY_BYTES);
            let q = (s.make)(n);
            let r = run_all(&q);
            if !is_depth_error(&r) {
                failures.push(format!("{} with n = {n} ({} bytes): {r:?}", s.name, q.len()));
            }
        }
        failures
    });
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn long_flat_queries_are_not_nesting() {
    let failures = bounded_stack(|| {
        let mut failures = Vec::new();
        for s in FLAT {
            // As long as the size limit allows, and well past MAX_DEPTH.
            let n = fill(s.make, MAX_QUERY_BYTES).min(5_000);
            assert!(n > MAX_DEPTH * 2, "{}: only {n} repetitions fit", s.name);
            match run_all(&(s.make)(n)) {
                Ok(_) => {}
                Err(e) => failures.push(format!("{} with n = {n}: {e:?}", s.name)),
            }
        }
        failures
    });
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn regexes_are_bounded_in_nesting_size_and_number() {
    bounded_stack(|| {
        let nested = |n: usize| format!("{{ .s =~ \"{}x{}\" }}", "(".repeat(n), ")".repeat(n));
        let nest = REGEX_NEST_LIMIT as usize;
        let mut accepted = 0;
        for n in 1..=nest + 2 {
            if parse(&nested(n)).is_ok() {
                accepted = n;
            }
        }
        assert_eq!(accepted, nest, "a pattern may nest REGEX_NEST_LIMIT groups and no more");
        let err = run_all(&nested(nest + 1)).unwrap_err();
        assert!(matches!(&err, Error::Validation { msg, .. } if msg.contains("invalid regex")), "{err:?}");
        // Far past the limit: refused before the regex compiler recurses.
        let far = nested(fill(nested, MAX_QUERY_BYTES));
        assert!(matches!(run_all(&far), Err(Error::Validation { .. })));

        // Compiled size: refused, not built. `x{100000}` compiles under the regex crate's
        // default limit (10 MiB) but not under REGEX_SIZE_LIMIT.
        let err = run_all(r#"{ .s =~ "x{100000}" }"#).unwrap_err();
        assert!(matches!(&err, Error::Validation { msg, .. } if msg.contains("invalid regex")), "{err:?}");
        // Ordinary patterns, Unicode classes included, fit.
        assert_eq!(run_all(r#"{ name =~ "(?i)\\w+[-_.]\\d{1,4}|s\\d" }"#).unwrap(), 1);
        assert_eq!(run_all(r#"{ name =~ "\\w{2}|\\w{16}" }"#).unwrap(), 1);

        // Number per query.
        let many = |k: usize| format!("{{ {} }}", vec![r#"name =~ "s.*""#; k].join(" && "));
        assert_eq!(run_all(&many(MAX_REGEXES)).unwrap(), 1);
        let err = run_all(&many(MAX_REGEXES + 1)).unwrap_err();
        assert!(matches!(&err, Error::Validation { msg, .. } if msg.contains("regular expressions")), "{err:?}");
    });
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(), ..ProptestConfig::default() })]

    /// Random stacks of nesting constructs, at random depths up to 15 times the limit, never
    /// crash; whatever is accepted also evaluates on the bounded stack. (In a run of 300
    /// cases, 126 were accepted and evaluated and 174 refused for depth.)
    #[test]
    fn random_deep_nesting_never_crashes(
        field in depths(7),
        spanset in depths(7),
        metrics in depths(4),
        to_metrics in proptest::bool::ANY,
    ) {
        let q = deep_query(&field, &spanset, to_metrics.then_some(metrics.as_slice()));
        let r = bounded_stack(move || run_all(&q).map(|_| ()));
        prop_assert!(
            matches!(&r, Ok(()) | Err(Error::Parse { .. } | Error::Validation { .. } | Error::Unsupported(_))),
            "{r:?}"
        );
    }

    /// The same for unbalanced, repeated token patterns: whatever the text, no crash.
    #[test]
    fn repeated_token_soup_never_crashes(unit in proptest::collection::vec(0usize..TOKENS.len(), 1..4), n in 1usize..30_000) {
        let unit: String = unit.iter().map(|&t| TOKENS[t]).collect();
        let n = n.min(MAX_QUERY_BYTES / unit.len().max(1));
        let q = format!("{}{{ }}", unit.repeat(n));
        let r = bounded_stack(move || run_all(&q).map(|_| ()));
        prop_assert!(!matches!(r, Err(Error::Eval(_)) | Err(Error::Source(_))), "{r:?}");
    }
}

/// Nesting lengths: up to 25 (the three together then mostly fit within MAX_DEPTH), up to
/// 70 (around the limit), or up to 3,000 (far past it).
fn depths(kinds: u8) -> impl proptest::strategy::Strategy<Value = Vec<u8>> {
    use proptest::prelude::Strategy;
    proptest::prop_oneof![
        2 => proptest::collection::vec(0..kinds, 0..25),
        1 => proptest::collection::vec(0..kinds, 0..70),
        1 => proptest::collection::vec(0..kinds, 0..3000),
    ]
    .boxed()
}

const TOKENS: &[&str] = &[
    "(", ")", "{ ", "} ", "!", "- ", "+ ", "* ", "^ ", "&& ", "|| ", ">> ", "> ", "~ ", "!< ", "&> ", "| ",
    ".a ", "1 ", "= ", "=~ \"(\" ", "rate() ", "count() ", "by(", "with (", ", ", "nil ", "\"",
];

/// Wraps `.a = 1` in the field constructs listed by `field`, the spanset around it in the
/// constructs listed by `spanset`, and optionally a metrics query in those of `metrics`.
fn deep_query(field: &[u8], spanset: &[u8], metrics: Option<&[u8]>) -> String {
    let mut e = ".a = 1".to_string();
    for &w in field {
        e = match w {
            0 => format!("({e})"),
            1 => format!("!({e})"),
            2 => format!("({e}) && .a = 1"),
            3 => format!(".a = 0 || ({e})"),
            4 => format!("({e}) = true"),
            5 => format!("(- .a{}) < 0 && ({e})", " - .a".repeat(3)),
            _ => format!("(.a ^ 1 ^ 1 = 1) && ({e})"),
        };
        if e.len() > MAX_QUERY_BYTES {
            break;
        }
    }
    let mut s = format!("{{ {e} }}");
    for &w in spanset {
        // Both operands of a spanset operator are wrapped pipelines (TraceQL refuses a mix).
        s = match w {
            0 => format!("({s})"),
            1 => format!("({s} | {{ }}) && ({{ }} | {{ }})"),
            2 => format!("({{ }} | {{ }}) >> ({s} | {{ }})"),
            3 => format!("(({s}) | {{ }})"),
            4 => format!("({s} | {{ }}) ~ ({{ }} | {{ }})"),
            5 => format!("({{ }} | {{ }}) || ({s} | {{ }})"),
            _ => format!("({s}) | by(.a) | coalesce()"),
        };
        if s.len() > MAX_QUERY_BYTES {
            break;
        }
    }
    let Some(metrics) = metrics else { return s };
    let mut m = format!("{s} | rate()");
    for &w in metrics {
        m = match w {
            0 => format!("({m})"),
            1 => format!("({m}) + 1"),
            2 => format!("({m}) > 0"),
            _ => format!("2 * ({m})"),
        };
        if m.len() > MAX_QUERY_BYTES {
            break;
        }
    }
    m
}
