//! Property tests (metamorphic): results must not depend on things that should not matter.
//! Data and queries come from the same generator as the differential run (`tests/gen`),
//! seeded by proptest. `PROPTEST_CASES` scales the number of seeds (default 64 here).

mod gen;

use std::cell::RefCell;

use proptest::prelude::*;
use serde_json::Value;
use viz_logql::*;

fn source(ds: &Value) -> Vec<LogStream> {
    ds.as_array()
        .unwrap()
        .iter()
        .map(|s| LogStream {
            labels: s["labels"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect(),
            rows: s["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| LogRow { ts_ns: e["ts"].as_str().unwrap().parse().unwrap(), line: e["line"].as_str().unwrap().to_string(), metadata: vec![] })
                .collect(),
        })
        .collect()
}

fn run(src: &dyn LogSource, q: &str, instant: bool, (start, end, step): (i64, i64, i64), opts: &Options) -> Result<String, String> {
    let r = if instant { query_instant(src, q, end, opts) } else { query_range(src, q, start, end, step, opts) };
    match r {
        Ok(r) => {
            // Compare the result without the statistics (they count rows read, which pruning
            // changes by design).
            let j = r.data_json();
            Ok(j[..j.find(",\"stats\":").unwrap_or(j.len())].to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn cases(seed: u64) -> (Vec<LogStream>, Vec<(String, String, bool, (i64, i64, i64))>) {
    let mut rng = gen::Rng::new(seed);
    let ds = gen::dataset(&mut rng);
    let qs = gen::queries(&mut rng).into_iter().map(|(f, q, i)| (f, q, i, gen::window(&mut rng, i))).collect();
    (source(&ds), qs)
}

fn opts() -> Options {
    Options { limit: 1000, direction: Direction::Forward, ..Options::default() }
}

/// A source that records what it is asked for.
struct Recording<'a> {
    inner: &'a MemSource,
    calls: RefCell<Vec<(Vec<Matcher>, i64, i64, Vec<Vec<String>>)>>,
}

impl LogSource for Recording<'_> {
    fn select(&self, req: &SelectRequest<'_>, visit: &mut dyn FnMut(&[(String, String)], &LogRow)) -> Result<(), Error> {
        self.calls.borrow_mut().push((req.matchers.to_vec(), req.start_ns, req.end_ns, req.required.to_vec()));
        self.inner.select(req, visit)
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(64), ..ProptestConfig::default() })]

    /// Pruning rows by the `required` clauses (as a token filter would) changes nothing.
    #[test]
    fn pruning_on_off_identical(seed in any::<u64>()) {
        let (streams, qs) = cases(seed);
        let plain = MemSource::new(streams.clone());
        let mut pruned = MemSource::new(streams);
        pruned.prune = true;
        for (_, q, instant, w) in &qs {
            prop_assert_eq!(run(&plain, q, *instant, *w, &opts()), run(&pruned, q, *instant, *w, &opts()), "query {}", q);
        }
    }

    /// Rows that share a timestamp may arrive in any order: metric results are unchanged, and
    /// log results hold the same entries.
    #[test]
    fn row_order_within_a_timestamp(seed in any::<u64>()) {
        let (mut streams, qs) = cases(seed);
        // Give every second row the timestamp of the row before it, then reverse each run
        // of equal timestamps.
        for s in &mut streams {
            for i in (1..s.rows.len()).step_by(2) {
                s.rows[i].ts_ns = s.rows[i - 1].ts_ns;
            }
        }
        let a = MemSource::new(streams.clone());
        for s in &mut streams {
            let mut i = 0;
            while i < s.rows.len() {
                let mut j = i;
                while j < s.rows.len() && s.rows[j].ts_ns == s.rows[i].ts_ns {
                    j += 1;
                }
                s.rows[i..j].reverse();
                i = j;
            }
        }
        let b = MemSource::new(streams);
        for (feature, q, instant, w) in &qs {
            let (ra, rb) = (run(&a, q, *instant, *w, &opts()), run(&b, q, *instant, *w, &opts()));
            if ra.is_err() && rb.is_err() {
                continue; // which failing row is reported first depends on the order
            }
            if feature == "log" {
                let norm = |r: Result<String, String>| -> Result<Vec<String>, String> {
                    let v: Value = serde_json::from_str(&r?).map_err(|e| e.to_string()).or_else(|_| Ok::<Value, String>(Value::Null))?;
                    let mut out: Vec<String> = Vec::new();
                    if let Some(res) = v.get("result").and_then(|r| r.as_array()) {
                        for s in res {
                            for e in s["values"].as_array().unwrap() {
                                out.push(format!("{}|{}|{}", s["stream"], e[0], e[1]));
                            }
                        }
                    }
                    out.sort();
                    Ok(out)
                };
                prop_assert_eq!(norm(ra.map(|s| s + "}")), norm(rb.map(|s| s + "}")), "query {}", q);
            } else {
                prop_assert_eq!(ra, rb, "query {}", q);
            }
        }
    }

    /// A metric range query split at a step into two adjacent range queries gives the same
    /// points as the whole.
    #[test]
    fn split_range_concatenates(seed in any::<u64>()) {
        let (streams, qs) = cases(seed);
        let src = MemSource::new(streams);
        for (feature, q, instant, (start, end, step)) in &qs {
            if feature == "log" || *instant {
                continue;
            }
            let n = (end - start) / step;
            if n < 2 {
                continue;
            }
            let mid = start + (n / 2) * step;
            let whole = query_range(&src, q, *start, *end, *step, &opts());
            let left = query_range(&src, q, *start, mid, *step, &opts());
            let right = query_range(&src, q, mid + step, *end, *step, &opts());
            match (whole, left, right) {
                (Ok(w), Ok(l), Ok(r)) => {
                    let pts = |d: &Data| -> Vec<(Vec<(String, String)>, i64, u64)> {
                        let mut v = Vec::new();
                        if let Data::Matrix(m) = d {
                            for s in m {
                                for (t, x) in &s.points {
                                    v.push((s.labels.clone(), *t, x.to_bits()));
                                }
                            }
                        }
                        v.sort();
                        v
                    };
                    let mut lr = pts(&l.data);
                    lr.extend(pts(&r.data));
                    lr.sort();
                    let wp = pts(&w.data);
                    // Same series and steps; values equal up to 1e-12 relative (an aggregation
                    // over `or` may combine its inputs in another order when a series has no
                    // points in one half).
                    prop_assert_eq!(wp.len(), lr.len(), "query {}", q);
                    for (a, b) in wp.iter().zip(lr.iter()) {
                        let (x, y) = (f64::from_bits(a.2), f64::from_bits(b.2));
                        prop_assert!(a.0 == b.0 && a.1 == b.1, "query {}: {:?} vs {:?}", q, a, b);
                        prop_assert!(a.2 == b.2 || (x - y).abs() <= 1e-12 * x.abs().max(y.abs()), "query {}: {} vs {}", q, x, y);
                    }
                }
                (Err(_), Err(_), _) | (Err(_), _, Err(_)) => {}
                (w, l, r) => prop_assert!(w.is_err() == (l.is_err() || r.is_err()), "query {}: {:?} {:?} {:?}", q, w.err(), l.err(), r.err()),
            }
        }
    }

    /// A range query equals one instant query per step.
    #[test]
    fn range_equals_repeated_instant(seed in any::<u64>()) {
        let (streams, qs) = cases(seed);
        let src = MemSource::new(streams);
        for (feature, q, instant, (start, end, step)) in qs.iter().take(18) {
            if feature == "log" || *instant || q.contains("sort") {
                continue;
            }
            let Ok(r) = query_range(&src, q, *start, *end, *step, &opts()) else { continue };
            let Data::Matrix(m) = r.data else { continue };
            let mut t = *start;
            while t <= *end {
                let inst = query_instant(&src, q, t, &opts());
                let mut want: Vec<(Vec<(String, String)>, u64)> = m.iter().filter_map(|s| s.points.iter().find(|p| p.0 == t).map(|p| (s.labels.clone(), p.1.to_bits()))).collect();
                want.sort();
                let mut got: Vec<(Vec<(String, String)>, u64)> = match inst.map(|r| r.data) {
                    Ok(Data::Vector(v)) => v.into_iter().map(|(l, _, x)| (l, x.to_bits())).collect(),
                    Ok(Data::Scalar(_, x)) => vec![(vec![], x.to_bits())],
                    other => return Err(TestCaseError::fail(format!("query {q}: {other:?}"))),
                };
                got.sort();
                prop_assert_eq!(&got, &want, "query {} at {}", q, t);
                t += step;
            }
        }
    }

    /// Evaluation reads exactly what `selectors()` reports, in order.
    #[test]
    fn evaluator_reads_what_selectors_reports(seed in any::<u64>()) {
        let (streams, qs) = cases(seed);
        let mem = MemSource::new(streams);
        for (_, q, instant, (start, end, step)) in &qs {
            let rec = Recording { inner: &mem, calls: RefCell::new(Vec::new()) };
            let (s, e) = if *instant { (*end, *end) } else { (*start, *end) };
            let r = if *instant { query_instant(&rec, q, *end, &opts()) } else { query_range(&rec, q, s, e, *step, &opts()) };
            let Ok(sel) = selectors(q, s, e, *step) else { continue };
            if r.is_err() {
                continue; // an evaluation error may stop before every selector is read
            }
            let want: Vec<_> = sel.into_iter().map(|x| (x.matchers, x.start_ns, x.end_ns, x.required)).collect();
            prop_assert_eq!(rec.calls.into_inner(), want, "query {}", q);
        }
    }

    /// Random tokens spliced into valid queries never panic.
    #[test]
    fn token_soup_never_panics(seed in any::<u64>(), cut in 0usize..200, junk in prop::sample::select(vec![
        "{", "}", "(", ")", "[", "]", "|", "|=", "!~", "\"", "`", "by", "without", "unwrap", "[5m]", "offset", "-", "1e400",
        "{{", "}}", "{{ range }}", "<_>", "<a><b>", ",", "or", "and", "json", "logfmt --strict", "\\", "#", "ip(\"", "0x", "999999999999999999999d",
    ])) {
        let (streams, qs) = cases(seed);
        let src = MemSource::new(streams);
        for (_, q, _, (start, end, step)) in qs.iter().take(6) {
            let at = cut.min(q.len());
            let at = (0..=at).rev().find(|i| q.is_char_boundary(*i)).unwrap_or(0);
            let bad = format!("{}{}{}", &q[..at], junk, &q[at..]);
            let _ = query_range(&src, &bad, *start, *end, *step, &opts());
            let _ = selectors(&bad, *start, *end, *step);
        }
    }
}

/// The generator's queries evaluate and mostly return data, so the properties are not vacuous.
#[test]
fn query_pool_is_live() {
    let mut ok = 0;
    let mut nonempty = 0;
    let mut total = 0;
    for seed in 0..20 {
        let (streams, qs) = cases(seed);
        let src = MemSource::new(streams);
        for (_, q, instant, w) in &qs {
            total += 1;
            if let Ok(s) = run(&src, q, *instant, *w, &opts()) {
                ok += 1;
                if !s.contains("\"result\":[]") {
                    nonempty += 1;
                }
            }
        }
    }
    eprintln!("{total} queries: {ok} evaluate, {nonempty} return data");
    assert!(ok * 10 >= total * 8, "{ok} of {total} evaluate");
    assert!(nonempty * 10 >= total * 4, "{nonempty} of {total} return data");
}
