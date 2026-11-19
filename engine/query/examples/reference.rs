//! Expected results for the query Worker's end-to-end tests (`query/test`).
//!
//! Reads a workload (per tenant: series and the samples written, in write order) and a
//! table of PromQL queries, evaluates every query with `viz-promql` over its IN-MEMORY
//! source, and prints the Prometheus API envelope each query must produce. Nothing here
//! touches `viz-storage`, Parquet, batches, WASM or HTTP: this is the reference the read
//! path is compared with.
//!
//!   cargo run --release --example reference -- workload.json > expected.json
//!
//! Workload: `{"tenants":{"<name>":[{"labels":{..},"samples":[[ts_ms, value],..]}]},
//! "queries":[{"id","kind":"range"|"instant","query","start","end","step","time"}]}`.
//! A value is a decimal number as a JSON string ("12.5"), a JSON number, or one of the
//! strings "stale", "NaN", "+Inf", "-Inf". A
//! later sample of the same series and timestamp replaces an earlier one.
use serde_json::{json, Map, Value as J};
use viz_promql::{Error, MemSource, Series, STALE_NAN_BITS};

fn value(v: &J) -> f64 {
    match v {
        J::String(s) => match s.as_str() {
            "stale" => f64::from_bits(STALE_NAN_BITS),
            "NaN" => f64::NAN,
            "+Inf" => f64::INFINITY,
            "-Inf" => f64::NEG_INFINITY,
            // A decimal number as text: parsed by Rust's correctly rounded parser. (JSON
            // numbers go through serde_json's fast path, which can be one ULP off for
            // 17-digit values; the generator therefore sends every number as text.)
            other => other.parse::<f64>().unwrap_or_else(|_| panic!("unknown value {other:?}")),
        },
        other => other.as_f64().expect("a sample value is a number"),
    }
}

fn source(series: &J) -> MemSource {
    let mut mem = MemSource::new();
    for s in series.as_array().expect("a tenant is an array of series") {
        let labels: Vec<(String, String)> =
            s["labels"].as_object().expect("labels").iter().filter(|(_, v)| v.as_str() != Some("")).map(|(n, v)| (n.clone(), v.as_str().expect("label value").to_string())).collect();
        let samples = s["samples"].as_array().expect("samples");
        let ts = samples.iter().map(|p| p[0].as_i64().expect("ts")).collect();
        let values = samples.iter().map(|p| value(&p[1])).collect();
        mem.add(Series { labels, ts, values });
    }
    mem
}

fn envelope(r: Result<J, Error>) -> J {
    match r {
        Ok(data) => json!({"status": "success", "data": data}),
        Err(e) => {
            let (t, m) = match e {
                Error::Parse(m) => ("bad_data", format!("parse error: {m}")),
                Error::Unsupported(m) => ("unsupported", m),
                Error::Eval(m) => ("execution", m),
                Error::Source(m) => ("internal", m),
            };
            json!({"status": "error", "errorType": t, "error": m})
        }
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: reference <workload.json>");
    let w: J = serde_json::from_str(&std::fs::read_to_string(path).expect("read workload")).expect("workload is JSON");
    // The query service's aggregations are order-independent (`viz_query::agg`): exact
    // sums, groups in label order. The reference uses the same.
    let opts = viz_promql::EvalOptions::default();
    let mut out = Map::new();
    for (tenant, series) in w["tenants"].as_object().expect("tenants") {
        let mem = source(series);
        let mut results = Map::new();
        for q in w["queries"].as_array().expect("queries") {
            let text = q["query"].as_str().expect("query");
            let int = |k: &str| q[k].as_i64().unwrap_or_else(|| panic!("{k} must be an integer"));
            let r = if q["kind"] == "range" {
                viz_query::reference_range(&mem, text, int("start"), int("end"), int("step"), &opts).map(|m| serde_json::to_value(&m).expect("json"))
            } else {
                viz_query::reference_instant(&mem, text, int("time"), &opts).map(|v| serde_json::to_value(&v).expect("json"))
            };
            results.insert(q["id"].as_str().expect("id").to_string(), envelope(r));
        }
        out.insert(tenant.clone(), J::Object(results));
    }
    println!("{}", serde_json::to_string(&J::Object(out)).expect("json"));
}
