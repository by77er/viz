//! Native benchmark: generated traces in a MemSource, timed search and metrics queries.
//!
//! `cargo run --release --example bench -- [traces] [repeats]` (defaults 20000, 5).
//! Prints the median wall time per query with pruning off and on, and spans per second.

#[path = "../tests/common/mod.rs"]
mod common;

use common::*;
use std::time::Instant;
use viz_traceql::*;

fn rss_mb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM")).and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok()))
        .map_or(0, |kb| kb / 1024)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(20_000);
    let reps: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(5);
    let t = Instant::now();
    let mut data = Vec::new();
    for chunk in 0..(n / 1000).max(1) {
        data.extend(dataset(chunk as u64, &Opts { traces: 1000.min(n), max_spans: 20, odd_shapes: false, mixed: false, zero_ids: false, extremes: false }));
    }
    let spans: usize = data.iter().map(|t| t.spans.len()).sum();
    println!("generated {} traces, {} spans in {:.1}s; peak RSS {} MB", data.len(), spans, t.elapsed().as_secs_f64(), rss_mb());
    let full = MemSource::new(data.clone());
    let pruned = MemSource::new(data).pruning(true);
    let start = BASE;
    let end = BASE + (WINDOW_S + 5) * 1_000_000_000;
    let searches = [
        r#"{ resource.service.name = "db" && span.http.status_code >= 500 }"#,
        r#"{ span.http.method = "GET" } && { status = error }"#,
        r#"{ resource.service.name = "frontend" } >> { status = error }"#,
        r#"{ } | by(resource.service.name) | count() > 3"#,
        r#"{ name =~ "GET.*|POST.*" && duration > 1s }"#,
    ];
    let metrics = [
        r#"{ } | rate() by (resource.service.name)"#,
        r#"{ status = error } | count_over_time() by (name)"#,
        r#"{ } | quantile_over_time(duration, 0.5, 0.99) by (resource.service.name)"#,
        r#"{ } | histogram_over_time(duration)"#,
        r#"({ status = error } | rate()) / ({ } | rate())"#,
    ];
    let median = |mut v: Vec<f64>| {
        v.sort_by(|a, b| a.total_cmp(b));
        v[v.len() / 2]
    };
    println!("{:<75} {:>10} {:>10} {:>12}", "query", "off ms", "on ms", "Mspans/s off");
    for q in searches {
        let mut times = [Vec::new(), Vec::new()];
        for _ in 0..reps {
            for (i, src) in [&full, &pruned].into_iter().enumerate() {
                let t = Instant::now();
                let r = search(src, q, &SearchRequest::default()).expect("search");
                std::hint::black_box(r.to_json());
                times[i].push(t.elapsed().as_secs_f64() * 1e3);
            }
        }
        let (off, on) = (median(times[0].clone()), median(times[1].clone()));
        println!("{:<75} {:>10.1} {:>10.1} {:>12.2}", q, off, on, spans as f64 / off / 1e3);
    }
    for q in metrics {
        let req = RangeRequest::range(start, end, 30_000_000_000);
        let mut times = [Vec::new(), Vec::new()];
        for _ in 0..reps {
            for (i, src) in [&full, &pruned].into_iter().enumerate() {
                let t = Instant::now();
                let r = query_range(src, q, &req).expect("metrics");
                std::hint::black_box(r.to_json());
                times[i].push(t.elapsed().as_secs_f64() * 1e3);
            }
        }
        let (off, on) = (median(times[0].clone()), median(times[1].clone()));
        println!("{:<75} {:>10.1} {:>10.1} {:>12.2}", q, off, on, spans as f64 / off / 1e3);
    }
    println!("peak RSS {} MB", rss_mb());
}
