//! Property tests over random data and a pool of queries.
//!
//! 1. `query_range` equals an instant query at every step.
//! 2. Results do not depend on the order in which the source returns series.
//! 3. Splitting a time range into two `query_range` calls and concatenating
//!    equals one call.

use std::collections::BTreeMap;

use proptest::prelude::*;
use viz_promql::*;

/// Queries without `@ start()` / `@ end()`, whose meaning depends on the
/// query range by definition.
const QUERIES: &[&str] = &[
    "m",
    "m offset 30s",
    "m offset -45s",
    "m @ 100",
    r#"m{job="x"}"#,
    r#"m{inst=~"0|1"}"#,
    r#"{__name__=~"m|n", job!="y"}"#,
    "rate(m[1m])",
    "rate(m[90s] offset 20s)",
    "increase(m[2m])",
    "delta(m[1m])",
    "irate(m[1m])",
    "idelta(m[1m])",
    "resets(m[2m])",
    "changes(m[2m])",
    "deriv(m[2m])",
    "predict_linear(m[2m], 60)",
    "avg_over_time(m[1m])",
    "sum_over_time(m[1m])",
    "min_over_time(m[1m])",
    "max_over_time(m[1m])",
    "count_over_time(m[1m])",
    "last_over_time(m[1m])",
    "first_over_time(m[1m])",
    "stddev_over_time(m[1m])",
    "stdvar_over_time(m[1m])",
    "quantile_over_time(0.7, m[1m])",
    "present_over_time(m[1m])",
    "absent_over_time(m[20s])",
    r#"absent(m{job="x", inst="0"})"#,
    "sum(m)",
    "sum by (job) (m)",
    "sum without (inst) (m)",
    "avg by (job) (m)",
    "min by (inst) (m)",
    "max(m)",
    "count by (job) (m)",
    "group by (job) (m)",
    "stddev by (job) (m)",
    "stdvar(m)",
    "quantile by (job) (0.3, m)",
    "topk(2, m)",
    "bottomk by (job) (1, m)",
    r#"count_values("v", m)"#,
    "m + n",
    "m - on(job, inst) n",
    "m / ignoring(extra) n",
    "m * on(job) group_left sum by (job) (n)",
    "sum by (job) (n) + on(job) group_right m",
    "m < n",
    "m > bool n",
    "m == 3",
    "2 < bool m",
    "m and n",
    "m or n",
    "m unless n",
    "m and on(job) n",
    "m % 3 ^ 2",
    "-m",
    "abs(m - 5)",
    "ceil(m / 3)",
    "floor(m / 3)",
    "round(m, 5)",
    "clamp(m, 2, 6)",
    "clamp_min(m, 3)",
    "clamp_max(m, 3)",
    "exp(m / 10)",
    "ln(m)",
    "log2(m)",
    "log10(m)",
    "sqrt(m)",
    "sgn(m - 4)",
    "scalar(sum(m))",
    "vector(time())",
    "time()",
    "timestamp(m)",
    "timestamp(m offset 30s)",
    "m * scalar(count(n))",
    r#"label_replace(m, "dst", "$1-x", "job", "(.*)")"#,
    r#"label_join(m, "dst", "/", "job", "inst")"#,
    "sort(m)",
    "sort_desc(m)",
    "histogram_quantile(0.5, sum by (le) (h))",
    "histogram_quantile(0.9, rate(h[2m]))",
    "max_over_time(rate(m[1m])[3m:30s])",
    "sum_over_time(m[2m:45s] offset 15s)",
    "avg_over_time(sum by (job) (m)[90s:20s])",
    "rate(m[1m]) / rate(n[1m])",
    "sum(rate(m[1m])) by (job) > 0.01",
    "1 + 2 * 3",
    "day_of_week()",
    "hour(vector(time()))",
];

#[derive(Debug, Clone)]
struct Data {
    series: Vec<Series>,
}

fn value_strategy() -> impl Strategy<Value = f64> {
    prop_oneof![
        8 => (0i32..12).prop_map(|v| v as f64),
        3 => (-500i32..500).prop_map(|v| v as f64 / 7.0),
        1 => Just(f64::NAN),
        1 => Just(stale_nan()),
        1 => Just(0.0),
    ]
}

fn series_strategy(name: &'static str, labels: Vec<(&'static str, &'static str)>, counter: bool) -> impl Strategy<Value = Series> {
    // Irregular sample spacing between 1s and 70s over roughly ten minutes.
    proptest::collection::vec((1_000i64..70_000, value_strategy(), 0u8..10), 0..40).prop_map(move |pts| {
        let mut l: Vec<(String, String)> = labels.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        l.push(("__name__".into(), name.into()));
        l.sort();
        let mut t = -30_000i64;
        let mut acc = 0.0;
        let (mut ts, mut values) = (vec![], vec![]);
        for (gap, v, reset) in pts {
            t += gap;
            ts.push(t);
            if counter && !v.is_nan() {
                // A counter that occasionally resets.
                if reset == 0 {
                    acc = 0.0;
                }
                acc += v.abs();
                values.push(acc);
            } else {
                values.push(v);
            }
        }
        Series { labels: l, ts, values }
    })
}

fn data_strategy() -> impl Strategy<Value = Data> {
    let mut specs: Vec<BoxedStrategy<Series>> = vec![];
    for (job, inst) in [("x", "0"), ("x", "1"), ("y", "0"), ("y", "2")] {
        specs.push(series_strategy("m", vec![("job", job), ("inst", inst)], false).boxed());
        specs.push(series_strategy("n", vec![("job", job), ("inst", inst)], true).boxed());
    }
    specs.push(series_strategy("n", vec![("job", "x"), ("inst", "0"), ("extra", "e")], true).boxed());
    for le in ["0.1", "1", "5", "+Inf"] {
        specs.push(series_strategy("h", vec![("le", le)], true).boxed());
    }
    // Each series is present or not.
    (specs, proptest::collection::vec(any::<bool>(), 13)).prop_map(|(series, keep)| Data {
        series: series.into_iter().zip(keep).filter(|(s, k)| *k || s.labels.iter().any(|(_, v)| v == "h")).map(|(s, _)| s).collect(),
    })
}

type Key = Vec<(String, String)>;

fn bits(v: f64) -> u64 {
    // All NaNs produced by arithmetic are equivalent for comparison purposes.
    if v.is_nan() {
        u64::MAX
    } else {
        v.to_bits()
    }
}

fn matrix_map(m: &Matrix) -> BTreeMap<Key, Vec<(i64, u64)>> {
    m.series.iter().map(|s| (s.metric.clone(), s.points.iter().map(|(t, v)| (*t, bits(*v))).collect())).collect()
}

/// Rebuild a matrix-shaped map from one instant query per step.
fn instants(src: &MemSource, q: &str, start: i64, end: i64, step: i64) -> Result<BTreeMap<Key, Vec<(i64, u64)>>, Error> {
    let mut out: BTreeMap<Key, Vec<(i64, u64)>> = BTreeMap::new();
    let mut t = start;
    while t <= end {
        match query_instant(src, q, t)? {
            Value::Vector(v) => {
                for s in v {
                    out.entry(s.metric).or_default().push((t, bits(s.value)));
                }
            }
            Value::Scalar { value, .. } => out.entry(vec![]).or_default().push((t, bits(value))),
            other => panic!("unexpected result {other:?}"),
        }
        t += step;
    }
    Ok(out)
}

fn query_strategy() -> impl Strategy<Value = &'static str> {
    (0..QUERIES.len()).prop_map(|i| QUERIES[i])
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn range_equals_repeated_instant(
        data in data_strategy(),
        q in query_strategy(),
        start in -20_000i64..400_000,
        nsteps in 1i64..12,
        step in prop_oneof![Just(15_000i64), Just(60_000), 1_000i64..120_000],
    ) {
        let src = MemSource::from_series(data.series);
        let end = start + (nsteps - 1) * step + step / 3;
        let range = query_range(&src, q, start, end, step);
        let inst = instants(&src, q, start, end, step);
        match (range, inst) {
            (Ok(r), Ok(i)) => prop_assert_eq!(matrix_map(&r), i, "query {}", q),
            (Err(a), Err(_)) => prop_assert!(matches!(a, Error::Eval(_)), "query {}: {:?}", q, a),
            (r, i) => prop_assert!(false, "query {}: range {:?} but instants {:?}", q, r.map(|_| ()), i.map(|_| ())),
        }
    }

    #[test]
    fn independent_of_source_order(
        data in data_strategy(),
        q in query_strategy(),
        seed in any::<u64>(),
        start in -20_000i64..400_000,
        step in 5_000i64..90_000,
    ) {
        let a = MemSource::from_series(data.series.clone());
        let mut shuffled = data.series;
        // Deterministic Fisher-Yates driven by the seed.
        let mut x = seed | 1;
        for i in (1..shuffled.len()).rev() {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            shuffled.swap(i, (x % (i as u64 + 1)) as usize);
        }
        let b = MemSource::from_series(shuffled);
        let end = start + 6 * step;
        let (ra, rb) = (query_range(&a, q, start, end, step), query_range(&b, q, start, end, step));
        match (ra, rb) {
            (Ok(x), Ok(y)) => prop_assert_eq!(serde_json::to_string(&x).unwrap(), serde_json::to_string(&y).unwrap(), "query {}", q),
            (Err(x), Err(y)) => prop_assert_eq!(std::mem::discriminant(&x), std::mem::discriminant(&y)),
            _ => prop_assert!(false, "query {}: one order failed, the other did not", q),
        }
        // Instant results too, including the order of the returned vector.
        let (ia, ib) = (query_instant(&a, q, start), query_instant(&b, q, start));
        match (ia, ib) {
            (Ok(x), Ok(y)) => prop_assert_eq!(serde_json::to_string(&x).unwrap(), serde_json::to_string(&y).unwrap(), "query {}", q),
            (Err(x), Err(y)) => prop_assert_eq!(std::mem::discriminant(&x), std::mem::discriminant(&y)),
            _ => prop_assert!(false, "query {}: one order failed, the other did not", q),
        }
    }

    #[test]
    fn split_range_concatenates(
        data in data_strategy(),
        q in query_strategy(),
        start in -20_000i64..400_000,
        step in 5_000i64..90_000,
        left_steps in 1i64..6,
        right_steps in 1i64..6,
    ) {
        let src = MemSource::from_series(data.series);
        let mid = start + (left_steps - 1) * step;
        let end = mid + right_steps * step;
        let whole = query_range(&src, q, start, end, step);
        let left = query_range(&src, q, start, mid, step);
        let right = query_range(&src, q, mid + step, end, step);
        match (whole, left, right) {
            (Ok(w), Ok(l), Ok(r)) => {
                let mut joined = matrix_map(&l);
                for (k, mut pts) in matrix_map(&r) {
                    joined.entry(k).or_default().append(&mut pts);
                }
                prop_assert_eq!(matrix_map(&w), joined, "query {}", q);
            }
            (Err(_), l, r) => prop_assert!(l.is_err() || r.is_err(), "query {}: whole failed but both halves passed", q),
            (Ok(_), l, r) => prop_assert!(false, "query {}: whole passed but a half failed: {:?} {:?}", q, l.err(), r.err()),
        }
    }
}

/// Guards against the properties above passing vacuously: every query in the
/// pool must evaluate without error and return data on generated inputs.
#[test]
fn query_pool_is_live() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;
    let mut runner = TestRunner::deterministic();
    let mut non_empty = vec![0usize; QUERIES.len()];
    let mut errors = vec![0usize; QUERIES.len()];
    let rounds = 40;
    for _ in 0..rounds {
        let data = data_strategy().new_tree(&mut runner).unwrap().current();
        let src = MemSource::from_series(data.series);
        for (i, q) in QUERIES.iter().enumerate() {
            match query_range(&src, q, 0, 600_000, 30_000) {
                Ok(m) => {
                    if m.series.iter().any(|s| !s.points.is_empty()) {
                        non_empty[i] += 1;
                    }
                }
                Err(Error::Eval(_)) => errors[i] += 1,
                Err(e) => panic!("query {q} is not usable in the pool: {e:?}"),
            }
        }
    }
    for (i, q) in QUERIES.iter().enumerate() {
        assert!(non_empty[i] * 4 >= rounds, "query {q} returned data in only {}/{rounds} rounds ({} errors)", non_empty[i], errors[i]);
    }
}

/// Arbitrary recombinations of query fragments either evaluate or return an
/// error; they never panic.
mod no_panic {
    use super::*;

    const TOKENS: &[&str] = &[
        "m", "n", "h", "(", ")", "[1m]", "[5m:30s]", "[90s:]", "+", "-", "*", "/", "%", "^", "==", "!=", ">", "<",
        "bool", "and", "or", "unless", "on(job)", "ignoring(inst)", "group_left", "group_right(extra)", "sum", "avg",
        "topk", "quantile", "count_values", "by (job)", "without (inst)", "rate", "increase", "delta", "irate",
        "avg_over_time", "quantile_over_time", "predict_linear", "histogram_quantile", "label_replace", "abs",
        "clamp", "scalar", "vector", "time()", "timestamp", "absent", "sort", ",", "1", "0", "-1", "0.5", "NaN",
        "Inf", "1e400", "\"v\"", "\"(.*)\"", "\"$1\"", "offset 1m", "offset -5m", "@ 100", "@ start()", "@ end()",
        "@ -9e18", "{job=\"x\"}", "{job=~\"x|y\"}", "{__name__=~\".+\"}", "day_of_month", "round",
    ];

    proptest! {
        #![proptest_config(ProptestConfig { cases: 3000, failure_persistence: None, ..ProptestConfig::default() })]

        #[test]
        fn token_soup_never_panics(
            data in data_strategy(),
            base in query_strategy(),
            extra in proptest::collection::vec((0..TOKENS.len(), 0usize..60), 0..6),
            t in prop_oneof![Just(0i64), Just(i64::MAX), Just(i64::MIN + 1), -100_000i64..700_000],
        ) {
            // Start from a valid query and splice random tokens into it, so
            // that a good share of the results still parse.
            let mut q = base.to_string();
            for (tok, pos) in extra {
                let mut at = pos.min(q.len());
                while !q.is_char_boundary(at) { at -= 1; }
                q.insert_str(at, &format!(" {} ", TOKENS[tok]));
            }
            let src = MemSource::from_series(data.series);
            let _ = query_instant(&src, &q, t);
            let _ = query_range(&src, &q, t.saturating_sub(120_000), t, 30_000);
            let _ = selectors(&q, t.saturating_sub(120_000), t, 30_000);
        }
    }
}

/// Queries used only for the differential run against the Prometheus Go
/// engine (`tools/godiff`): range-dependent modifiers, error cases and edge
/// parameters that the properties above cannot use.
const DIFF_EXTRA: &[&str] = &[
    "m @ start()",
    "m @ end()",
    "rate(m[1m] @ end())",
    "sum_over_time(m[2m:30s] @ start())",
    "max_over_time(m[2m:] @ end() offset 30s)",
    "timestamp(m @ 2100)",
    "timestamp(m @ end())",
    "timestamp(abs(m))",
    r#"abs({__name__=~"m|n"})"#,
    r#"rate({__name__=~"m|n"}[2m])"#,
    r#"-{__name__=~"m|n"}"#,
    r#"last_over_time({__name__=~"m|n"}[2m])"#,
    r#"{__name__=~"m|n"} > 3"#,
    r#"{__name__=~"m|n"} > bool 3"#,
    "m + on(job) n",
    "m + on(job) group_left n",
    "m * on(job) group_left(extra) n",
    "m * on(job, inst) group_left(extra) n",
    "m * ignoring(extra) group_right n",
    "sum by (job) (m) / on(job) group_right(extra) n",
    r#"label_replace(m, "job", "z", "inst", ".*")"#,
    r#"label_replace(m, "__name__", "renamed_$1", "job", "(.)")"#,
    r#"label_replace(rate(m[1m]), "__name__", "r", "", "")"#,
    r#"label_join(m, "inst", "", "missing")"#,
    "quantile(1.5, m)",
    "quantile(-1, m)",
    "quantile by (job) (0.999, n)",
    "quantile_over_time(2, m[1m])",
    "histogram_quantile(NaN, h)",
    "histogram_quantile(-0.5, h)",
    "histogram_quantile(1, h)",
    "histogram_quantile(0.99, rate(h[1m]))",
    "histogram_quantile(0.5, m)",
    "clamp(m, 5, 2)",
    "clamp(m, NaN, 2)",
    "round(m, 0)",
    "round(m / 7, 0.25)",
    "m % 0",
    "m / 0",
    "m ^ -1",
    "m atan2 n",
    "bottomk(0, m)",
    "topk(100, m)",
    "topk(scalar(count(m)) - 1, n)",
    r#"count_values without (inst) ("v", m)"#,
    r#"count_values by (job) ("job", m)"#,
    "sum by (__name__) (m)",
    "sum by (__name__, job) (rate(m[1m]))",
    "count without (__name__) (m)",
    "avg without (job, inst, extra) (n)",
    "predict_linear(m[2m], -30)",
    "deriv(n[3m])",
    "delta(n[2m] offset 1m)",
    "increase(n[45s])",
    "rate(n[10m])",
    "irate(n[3m])",
    "changes(n[5m]) + resets(n[5m])",
    "day_of_year(vector(time()))",
    "days_in_month(vector(time() * 1000))",
    "minute(m * 100)",
    "scalar(m)",
    r#"scalar(m{job="x", inst="0"}) + time()"#,
    r#"absent(m{job="zz", inst=~"a.*", extra!="q"})"#,
    "absent_over_time(nope[1m])",
    r#"absent(sum(m{job="zz"}))"#,
    "vector(1) + on() group_left m",
    "m and on() vector(1)",
    "m unless on(job) n",
    "m or on(inst) n",
    "(m > 5) or (n < 20)",
    "sort_desc(m) + 0",
    "stddev_over_time(n[3m:20s])",
    "avg_over_time(m[5m])",
    "sum_over_time((m > 3)[2m:10s])",
    "min_over_time(rate(n[1m])[5m:1m] offset -1m)",
    "sum(rate(n[2m] offset 3m)) by (job) / sum(rate(n[2m])) by (job)",
    "m == bool n",
    "1 > bool 2",
    "2 ^ 3 ^ 2",
    "-2 ^ 2",
    "5 % -3",
    "time() - m",
    "pi() * m",
    "sgn(m - 5) * exp(1)",
    "ln(-m)",
    "sqrt(-m)",
    "stdvar by (job) (n)",
    "group without (inst) (m)",
    "max by (inst) (m) - min by (inst) (m)",
    "first_over_time(m[90s])",
    "m[2m]",
    "rate(m[1m])[3m:30s]",
];

/// Writes random data sets, queries and this engine's answers as JSON for
/// `tools/godiff`, which re-evaluates them with the Prometheus Go engine.
/// Run with `VIZ_DIFF_OUT=/path/cases.json cargo test --release --test props export_differential_cases -- --ignored`.
#[test]
#[ignore]
fn export_differential_cases() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;
    let out = std::env::var("VIZ_DIFF_OUT").expect("set VIZ_DIFF_OUT");
    let rounds: usize = std::env::var("VIZ_DIFF_ROUNDS").ok().and_then(|s| s.parse().ok()).unwrap_or(120);
    // Shift everything so that all timestamps are positive.
    const BASE: i64 = 2_000_000;
    let mut runner = TestRunner::deterministic();
    let mut cases = Vec::new();
    for round in 0..rounds {
        let data = data_strategy().new_tree(&mut runner).unwrap().current();
        let series: Vec<Series> = data
            .series
            .into_iter()
            .map(|mut s| {
                for t in s.ts.iter_mut() {
                    *t += BASE;
                }
                s
            })
            .collect();
        let src = MemSource::from_series(series.clone());
        let delayed = round % 2 == 1;
        let opts = EvalOptions { delayed_name_removal: delayed, ..Default::default() };
        let (start, step, n) = (BASE + (round as i64 * 7919) % 300_000, [15_000, 30_000, 60_000, 47_000][round % 4], 3 + (round % 9) as i64);
        let end = start + n * step + step / 2;
        let mut queries = Vec::new();
        for q in QUERIES.iter().chain(DIFF_EXTRA.iter()) {
            let is_range_vector = *q == "m[2m]" || *q == "rate(m[1m])[3m:30s]";
            let (ours, err) = if is_range_vector { (serde_json::Value::Null, String::new()) } else {
                match query_range_with(&src, q, start, end, step, &opts) {
                    Ok(m) => (serde_json::to_value(&m).unwrap(), String::new()),
                    Err(e) => (serde_json::Value::Null, format!("{e}")),
                }
            };
            if !is_range_vector {
                queries.push(serde_json::json!({"q": q, "start": start, "end": end, "step": step, "instant": false, "ours": ours, "ours_err": err}));
            }
            let t = start + step * (n / 2);
            let (ours, err) = match query_instant_with(&src, q, t, &opts) {
                Ok(v) => (serde_json::to_value(&v).unwrap(), String::new()),
                Err(e) => (serde_json::Value::Null, format!("{e}")),
            };
            queries.push(serde_json::json!({"q": q, "start": t, "end": t, "step": 0, "instant": true, "ours": ours, "ours_err": err}));
        }
        let series_json: Vec<serde_json::Value> = series
            .iter()
            .map(|s| {
                let labels: BTreeMap<&str, &str> = s.labels.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                let bits: Vec<String> = s.values.iter().map(|v| format!("{:x}", v.to_bits())).collect();
                serde_json::json!({"labels": labels, "ts": s.ts, "bits": bits})
            })
            .collect();
        cases.push(serde_json::json!({"delayed": delayed, "series": series_json, "queries": queries}));
    }
    std::fs::write(&out, serde_json::to_vec(&cases).unwrap()).unwrap();
    println!("wrote {} cases with {} queries each to {out}", cases.len(), 2 * (QUERIES.len() + DIFF_EXTRA.len()) - 2);
}
