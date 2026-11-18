//! Measures how much stack a query of a given nesting depth needs: runs it on a thread
//! with the given stack size (the process aborts if that is too small).
//!   cargo run --release --example stack_probe -- <kind 0..5> <depth> <stack KiB>
use viz_query::{Limits, Options, ScanInput};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (kind, depth, kib): (usize, usize, usize) = (a[1].parse().unwrap(), a[2].parse().unwrap(), a[3].parse().unwrap());
    let n = depth - 1;
    let q = match kind {
        0 => format!("{}m{}", "(".repeat(n), ")".repeat(n)),
        1 => format!("m{}", " + m".repeat(n)),
        2 => format!("{}m", "-".repeat(n)),
        3 => format!("{}m{}", "abs(".repeat(n), ")".repeat(n)),
        4 => format!("{}m{}", "sum(".repeat(n), ")".repeat(n)),
        _ => format!("{}m[1m]{}", "max_over_time(".repeat(n / 2), ")[1m:15s]".repeat(n / 2 - 1) + ")"),
    };
    let r = std::thread::Builder::new()
        .stack_size(kib * 1024)
        .spawn(move || {
            let opts = Options { limits: Limits::unlimited(), ..Options::default() };
            viz_query::query_range_with(&ScanInput::default(), &q, 0, 60_000, 15_000, &opts).map(|r| r.stats.output_points)
        })
        .unwrap()
        .join()
        .unwrap();
    println!("ok {r:?}");
}
