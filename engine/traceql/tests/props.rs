//! Metamorphic properties over generated traces and queries (`tests/common`).
//!
//! `PROPTEST_CASES` sets the number of cases (default 48 per property).

mod common;

use common::*;
use proptest::prelude::{prop_assert, prop_assert_eq, proptest, ProptestConfig};
use std::collections::BTreeMap;
use viz_traceql::*;

fn cases() -> u32 {
    std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(48)
}

fn gen_data(seed: u64, odd: bool) -> Vec<Trace> {
    dataset(seed, &Opts { traces: 12 + (seed % 9) as usize, max_spans: 20, odd_shapes: odd, mixed: false, zero_ids: false, extremes: seed % 2 == 0 })
}

fn queries(seed: u64, data: &[Trace], n: usize, metrics: bool) -> Vec<String> {
    let mut g = QGen { r: Rng::new(seed ^ 0x5eed), data, mixed: false, quirks: true, depth: 1 };
    (0..n).map(|_| if metrics { g.metrics_query() } else { g.search_query() }).collect()
}

fn big() -> SearchRequest {
    SearchRequest { limit: 100_000, spans_per_spanset: 100_000, start_unix_nano: 0, end_unix_nano: 0 }
}

fn search_json(src: &MemSource, q: &str, req: &SearchRequest) -> String {
    match search(src, q, req) {
        // Statistics count what the source returned, which pruning changes by design.
        Ok(r) => SearchResponse { stats: Stats::default(), ..r }.to_json(),
        Err(e) => format!("error: {e}"),
    }
}

fn range_json(src: &MemSource, q: &str, req: &RangeRequest) -> String {
    match query_range(src, q, req) {
        Ok(r) => MetricsResponse { stats: Stats::default(), ..r }.to_json(),
        Err(e) => format!("error: {e}"),
    }
}

/// Shuffles trace order and span order inside each trace (Fisher-Yates with the test rng).
fn shuffled(data: &[Trace], seed: u64) -> Vec<Trace> {
    let mut r = Rng::new(seed);
    let mut out: Vec<Trace> = data.to_vec();
    for t in out.iter_mut() {
        for i in (1..t.spans.len()).rev() {
            let j = r.below(i as u64 + 1) as usize;
            t.spans.swap(i, j);
        }
    }
    for i in (1..out.len()).rev() {
        let j = r.below(i as u64 + 1) as usize;
        out.swap(i, j);
    }
    out
}

const RANGE: (u64, u64) = (BASE, BASE + (WINDOW_S + 5) * 1_000_000_000);

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(), ..ProptestConfig::default() })]

    /// Results do not depend on the order of traces or of spans within a trace.
    #[test]
    fn span_order_invariance(seed in 0u64..1_000_000) {
        let data = gen_data(seed, seed % 3 == 0);
        let a = MemSource::new(data.clone());
        let b = MemSource::new(shuffled(&data, seed));
        for q in queries(seed, &data, 6, false) {
            prop_assert_eq!(search_json(&a, &q, &big()), search_json(&b, &q, &big()), "{}", q);
        }
        let req = RangeRequest::range(RANGE.0, RANGE.1, 30_000_000_000);
        for q in queries(seed, &data, 6, true) {
            prop_assert_eq!(range_json(&a, &q, &req), range_json(&b, &q, &req), "{}", q);
        }
    }

    /// Storage pruning by the read plan (trace predicate, span predicate, time window) never
    /// changes a result.
    #[test]
    fn pruning_on_off_identical(seed in 0u64..1_000_000) {
        let data = gen_data(seed, seed % 2 == 0);
        let full = MemSource::new(data.clone());
        let pruned = MemSource::new(data.clone()).pruning(true);
        for q in queries(seed, &data, 8, false) {
            prop_assert_eq!(search_json(&full, &q, &big()), search_json(&pruned, &q, &big()), "{}", q);
        }
        let req = RangeRequest::range(RANGE.0 + 100_000_000_000, RANGE.1 - 100_000_000_000, 7_000_000_000);
        for q in queries(seed, &data, 8, true) {
            prop_assert_eq!(range_json(&full, &q, &req), range_json(&pruned, &q, &req), "{}", q);
        }
    }

    /// A range query split at a step boundary into two adjacent ranges gives the same
    /// samples as the whole range.
    #[test]
    fn split_range_merge_equals_whole(seed in 0u64..1_000_000, cut in 1u64..20) {
        let data = gen_data(seed, false);
        let src = MemSource::new(data.clone());
        let step = 30_000_000_000u64;
        let mid = (RANGE.0 / step + cut) * step;
        let samples = |req: &RangeRequest, q: &str| -> Result<BTreeMap<(String, i64), u64>, String> {
            let r = query_range(&src, q, req).map_err(|e| e.to_string())?;
            let mut m = BTreeMap::new();
            for s in &r.series {
                let l = format!("{:?}", s.labels);
                for (k, v) in s.values.iter().enumerate() {
                    // Zeros are left out: a series with no data in one half is absent there,
                    // and it shows zeros only where it exists.
                    if !v.is_nan() && *v != 0.0 {
                        m.insert((l.clone(), r.request.timestamp_ms(k)), v.to_bits());
                    }
                }
            }
            Ok(m)
        };
        for q in queries(seed, &data, 6, true) {
            // Comparisons act per point, so they split too; topk/bottomk choose among the
            // series that exist in the range, which differ between the halves.
            // Arithmetic turns the zeros of a series into other values, and a series exists
            // only in the half that has its data: also left out.
            if q.contains("topk") || q.contains("bottomk") || q.starts_with('(') {
                continue;
            }
            let whole = samples(&RangeRequest::range(RANGE.0, RANGE.1, step), &q);
            let a = samples(&RangeRequest::range(RANGE.0, mid, step), &q);
            let b = samples(&RangeRequest::range(mid, RANGE.1, step), &q);
            match (whole, a, b) {
                (Ok(w), Ok(mut a), Ok(b)) => {
                    a.extend(b);
                    // A series that is empty in one half (no sample) is dropped there; compare
                    // samples, which is what the API returns.
                    prop_assert_eq!(w, a, "{}", q);
                }
                (w, a, b) => prop_assert!(w.is_err() && a.is_err() && b.is_err(), "{}: error in some parts only", q),
            }
        }
    }

    /// `limit` returns the first traces of the unlimited answer (most recent first), and
    /// `spss` cuts spans but not `matched`.
    #[test]
    fn limits_cut_the_unlimited_answer(seed in 0u64..1_000_000, limit in 1u32..6, spss in 1u32..4) {
        let data = gen_data(seed, false);
        let src = MemSource::new(data.clone());
        for q in queries(seed, &data, 4, false) {
            let (Ok(all), Ok(cut)) = (search(&src, &q, &big()), search(&src, &q, &SearchRequest { limit, spans_per_spanset: spss, ..Default::default() })) else { continue };
            prop_assert_eq!(cut.traces.len(), all.traces.len().min(limit as usize));
            for (c, w) in cut.traces.iter().zip(&all.traces) {
                prop_assert_eq!(&c.trace_id, &w.trace_id);
                for (cs, ws) in c.spansets.iter().zip(&w.spansets) {
                    prop_assert_eq!(cs.matched, ws.matched);
                    let ids = |v: &[SpanResult]| v.iter().map(|x| x.span_id.clone()).collect::<Vec<_>>();
                    prop_assert_eq!(ids(&cs.spans), ids(&ws.spans[..cs.spans.len()]));
                    prop_assert!(cs.spans.len() <= spss as usize);
                }
            }
        }
    }

    /// Valid queries with random tokens spliced in, over generated data, return Ok or Err
    /// and never panic (a panic aborts a WASM isolate).
    #[test]
    fn token_soup_never_panics(seed in 0u64..1_000_000, pos in 0usize..200, tok in 0usize..40, n in 1usize..4) {
        const TOKS: [&str; 40] = ["{", "}", "(", ")", "|", "&&", "||", ">>", "<<", "!~", "=~", "!", "-", "+", "*", "/", "%", "^",
            "1e400", "9223372036854775808", "-9223372036854775808", "1h30m", "0.0.0", "\"", "\\", "`", ".", "span.", "event:", "trace:",
            "nil", "count()", "rate()", "by(", "with(", "topk(0)", "quantile_over_time(", "\u{00e9}", ",", "\n"];
        let data = gen_data(seed, true);
        let src = MemSource::new(data.clone());
        let mut qs = queries(seed, &data, 2, false);
        qs.extend(queries(seed, &data, 2, true));
        for q in qs {
            let mut s = q.clone();
            for k in 0..n {
                let mut p = (pos + k * 37) % (s.len() + 1);
                while !s.is_char_boundary(p) { p -= 1; }
                s.insert_str(p, TOKS[(tok + k * 7) % TOKS.len()]);
            }
            let _ = parse(&s);
            let _ = plan(&s, RANGE.0, RANGE.1);
            let _ = search(&src, &s, &big());
            let _ = query_range(&src, &s, &RangeRequest::range(RANGE.0, RANGE.1, 60_000_000_000));
        }
    }
}

/// The generated queries are not vacuous: most parse, and many return data.
#[test]
fn query_pool_is_live() {
    let data = gen_data(7, false);
    let src = MemSource::new(data.clone());
    let qs = queries(7, &data, 300, false);
    let ok: Vec<_> = qs.iter().filter_map(|q| search(&src, q, &big()).ok()).collect();
    let nonempty = ok.iter().filter(|r| !r.traces.is_empty()).count();
    assert!(ok.len() > 200, "{} of 300 search queries parse", ok.len());
    assert!(nonempty > 120, "{nonempty} of 300 search queries return traces");
    let mq = queries(7, &data, 300, true);
    let req = RangeRequest::range(RANGE.0, RANGE.1, 60_000_000_000);
    let mok: Vec<_> = mq.iter().filter_map(|q| query_range(&src, q, &req).ok()).collect();
    let mnonempty = mok.iter().filter(|r| !r.series.is_empty()).count();
    assert!(mok.len() > 200, "{} of 300 metrics queries parse", mok.len());
    assert!(mnonempty > 120, "{mnonempty} of 300 metrics queries return series");
}
