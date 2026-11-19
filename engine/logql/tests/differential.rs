//! The viz side of the black-box differential run against Loki (`tools/lokidiff`).
//!
//! * `export_cases` (ignored): generates data sets and queries (`tests/gen/mod.rs`),
//!   evaluates every query with viz-logql and writes the case file the harness reads:
//!   `VIZ_DIFF_ROUNDS=40 VIZ_DIFF_OUT=cases.json cargo test --release --test differential export_cases -- --ignored`
//! * `fill_cases` (ignored): reads a case file without viz results (`VIZ_DIFF_IN`), adds
//!   them, writes `VIZ_DIFF_OUT`. Used for hand-written probe files.
//!
//! Then `tools/lokidiff/run.sh run cases.json report.json`.

mod gen;

use serde_json::{json, Value};
use viz_logql::{query_instant, query_range, Direction, LogRow, LogStream, MemSource, Options};

fn dataset(v: &Value) -> MemSource {
    let mut streams = Vec::new();
    for s in v.as_array().unwrap() {
        let mut labels: Vec<(String, String)> =
            s["labels"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
        labels.sort();
        let rows = s["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                let mut metadata: Vec<(String, String)> = e
                    .get("meta")
                    .and_then(|m| m.as_object())
                    .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect())
                    .unwrap_or_default();
                metadata.sort();
                LogRow { ts_ns: e["ts"].as_str().unwrap().parse().unwrap(), line: e["line"].as_str().unwrap().to_string(), metadata }
            })
            .collect();
        streams.push(LogStream { labels, rows });
    }
    MemSource::new(streams)
}

/// Evaluate one case with viz and record the result in the case object.
pub fn run_case(src: &MemSource, c: &mut Value) {
    let q = c["query"].as_str().unwrap().to_string();
    let start: i64 = c["start"].as_str().unwrap().parse().unwrap();
    let end: i64 = c["end"].as_str().unwrap().parse().unwrap();
    let step: i64 = c["step"].as_str().unwrap().parse().unwrap();
    let opts = Options {
        limit: c["limit"].as_u64().unwrap_or(100) as u32,
        direction: if c["direction"].as_str() == Some("backward") { Direction::Backward } else { Direction::Forward },
        ..Options::default()
    };
    let r = if c["instant"].as_bool().unwrap_or(false) { query_instant(src, &q, end, &opts) } else { query_range(src, &q, start, end, step, &opts) };
    match r {
        Ok(r) => {
            c["viz_ok"] = json!(true);
            let data: Value = serde_json::from_str(&r.data_json()).expect("viz writes valid JSON");
            c["viz_data"] = data;
        }
        Err(e) => {
            c["viz_ok"] = json!(false);
            c["viz_err"] = json!(e.to_string());
        }
    }
}

#[test]
#[ignore]
fn fill_cases() {
    let input = std::env::var("VIZ_DIFF_IN").expect("VIZ_DIFF_IN");
    let output = std::env::var("VIZ_DIFF_OUT").expect("VIZ_DIFF_OUT");
    let mut f: Value = serde_json::from_str(&std::fs::read_to_string(input).unwrap()).unwrap();
    let sources: Vec<MemSource> = f["datasets"].as_array().unwrap().iter().map(dataset).collect();
    for c in f["cases"].as_array_mut().unwrap() {
        let ds = c["dataset"].as_u64().unwrap() as usize;
        run_case(&sources[ds], c);
    }
    std::fs::write(output, serde_json::to_string(&f).unwrap()).unwrap();
}

#[test]
#[ignore]
fn export_cases() {
    let output = std::env::var("VIZ_DIFF_OUT").expect("VIZ_DIFF_OUT");
    let rounds: u64 = std::env::var("VIZ_DIFF_ROUNDS").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
    let seed: u64 = std::env::var("VIZ_DIFF_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let mut datasets = Vec::new();
    let mut cases = Vec::new();
    for round in 0..rounds {
        let mut rng = gen::Rng::new(seed.wrapping_mul(1_000_003).wrapping_add(round));
        let ds = gen::dataset(&mut rng);
        let src = dataset(&ds);
        for (feature, q, instant) in gen::queries(&mut rng) {
            let (start, end, step) = gen::window(&mut rng, instant);
            let mut c = json!({
                "id": cases.len(), "dataset": datasets.len(), "query": q, "instant": instant,
                "start": start.to_string(), "end": end.to_string(), "step": step.to_string(),
                "direction": if rng.below(2) == 0 { "forward" } else { "backward" },
                "limit": [5u64, 50, 1000][rng.below(3) as usize], "feature": feature,
            });
            run_case(&src, &mut c);
            cases.push(c);
        }
        datasets.push(ds);
    }
    let n = cases.len();
    std::fs::write(&output, serde_json::to_string(&json!({"datasets": datasets, "cases": cases})).unwrap()).unwrap();
    eprintln!("wrote {n} cases over {rounds} data sets to {output}");
}
