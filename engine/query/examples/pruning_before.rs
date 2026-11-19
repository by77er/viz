//! The counterfactual's "before" side (query/CARDINALITY.md, "Series-level pruning"):
//! the query Worker's plan and the engine's work for five query shapes as the read path did
//! them on 2026-11-18, before series-level pruning: whole files, pruned by name and time
//! only, label calls through `select`. Uses only API that existed then, so it builds
//! against that tree (run it there for the true "before") and against this one.
//!
//!   cargo run --release --example pruning_before -- OUT_DIR 10000 100000
//!
//! Writes each shape's answer to OUT_DIR/<n>-<shape>.txt for `examples/pruning.rs` to
//! compare byte for byte. Native x86-64, one thread; not WASM, not Cloudflare.
mod pruning_common;
use pruning_common::*;
use viz_query::{files_needed, plan, scan_rows, selectors, Limits, Options, ScanInput};

#[global_allocator]
static A: Counting = Counting;

fn opts_default() -> Options {
    Options::default()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let out = args.next().expect("OUT_DIR");
    std::fs::create_dir_all(&out).unwrap();
    let ns: Vec<usize> = args.map(|a| a.parse().unwrap()).collect();
    for n in ns {
        let units = if n >= 1_000_000 { 1 } else { 7 };
        let end = DAY0 + units as i64 * UNIT - SCRAPE;
        let start = if units == 1 { DAY0 + 5 * SCRAPE } else { end - 3_600_000 };
        let files: Vec<_> = (0..units).map(|u| unit(n, DAY0 + u as i64 * UNIT, u * 10)).collect();
        println!("\n## {n} series, {units} ten-minute units, query window {} min (load {})", (end - start) / 60_000, loadavg());
        println!("| shape | the Worker's plan (2026-11-18) | files read | GETs | bytes | scan bound | series estimate | engine, one place: wall / CPU ms, peak heap | answer |");
        println!("|---|---|---:|---:|---:|---:|---:|---|---|");
        for shape in shapes(n) {
            let (ranges, reads, decomposes) = match &shape.kind {
                Kind::Range(q) => (plan(q, start, end, SCRAPE).unwrap(), ranges_of(selectors(q, start, end, SCRAPE).unwrap()), q.starts_with("sum")),
                Kind::LabelValues { matchers, .. } | Kind::Series(matchers) => {
                    let r = vec![viz_query::FetchRange { matchers: matchers.clone(), min_ts: start, max_ts: end }];
                    (r.clone(), r, false)
                }
            };
            let s_idx: Vec<&str> = files.iter().map(|(_, s)| s.index.as_str()).collect();
            let m_idx: Vec<&str> = files.iter().map(|(m, _)| m.index.as_str()).collect();
            let keep_s = files_needed(&s_idx, &ranges);
            let keep_m = files_needed(&m_idx, &ranges);
            let series: Vec<&[u8]> = files.iter().zip(&keep_s).filter(|(_, k)| **k).map(|((_, s), _)| &s.bytes[..]).collect();
            let samples: Vec<&[u8]> = files.iter().zip(&keep_m).filter(|(_, k)| **k).map(|((m, _), _)| &m.bytes[..]).collect();
            let rows = scan_rows(&m_idx, &reads);
            let scan: u64 = rows.iter().zip(&keep_m).filter(|(_, k)| **k).map(|(r, _)| r.unwrap()).sum();
            let s_rows = scan_rows(&s_idx, &reads);
            let est = series_estimate(&files.iter().zip(&s_rows).filter(|(_, r)| r.unwrap() > 0).map(|((_, s), r)| (s.min_ts, s.max_ts, r.unwrap())).collect::<Vec<_>>());
            let bytes: u64 = series.iter().chain(&samples).map(|b| b.len() as u64).sum();
            let n_files = series.len() + samples.len();
            let n_gets: usize = series.iter().chain(&samples).map(|b| whole_gets(b.len())).sum();
            let v = verdict(decomposes, scan, est, bytes, n_files);
            let input = ScanInput { series_files: series.clone(), sample_files: samples.clone(), tail_batches: vec![] };
            let eval = |limits: Limits| match &shape.kind {
                Kind::Range(q) => viz_query::query_range_with(&input, q, start, end, SCRAPE, &Options { limits, ..Options::default() }).map(|r| viz_query::to_json(&r.matrix).unwrap()).map_err(|e| e.message),
                Kind::LabelValues { label, matchers } => viz_query::label_values_with(&input, label, matchers, start, end, &limits).map(|v| viz_query::to_json(&v).unwrap()).map_err(|e| e.message),
                Kind::Series(m) => viz_query::series_with(&input, &[m.clone()], start, end, &limits).map(|v| viz_query::labels_to_json(&v)).map_err(|e| e.message),
            };
            // The outcome with the engine's default limits (timed), and the answer with the
            // limits lifted, for the comparison (not at 1,000,000 series for the whole metric:
            // one place cannot hold it, before or after).
            let (answer, wall, cpu, peak) = measure_n(3, || eval(Limits::default()));
            let text = if n >= 1_000_000 && matches!(shape.kind, Kind::Range(ref q) if q.contains("by (job)")) {
                "SKIPPED".to_string()
            } else {
                match eval(Limits::unlimited()) {
                    Ok(j) => j,
                    Err(e) => format!("ERROR {e}"),
                }
            };
            std::fs::write(format!("{out}/{n}-{}.txt", shape.name.replace(['/', ' '], "_")), &text).unwrap();
            // A split's readers: every part extracts its rows from every file, whole.
            if let (Some(l), Kind::Range(q)) = (leaves_of(&v), &shape.kind) {
                if let viz_query::split::SplitPlan::Split { key, .. } = viz_query::split_plan(q, &opts_default()) {
                    let ((digest, rows), _, cpu, peak) = measure(|| {
                        let mut all = Vec::new();
                        for part in 0..l {
                            all.push(viz_query::split::extract(&series, &samples, &key, part, l, &ranges).unwrap().batch);
                        }
                        (rows_digest(&all), all.iter().map(|b| b.len()).sum::<usize>())
                    });
                    std::fs::write(format!("{out}/{n}-{}-extracts.txt", shape.name.replace(['/', ' '], "_")), format!("{digest:?}")).unwrap();
                    println!("|   readers of {} over {l} parts | every part reads every file whole | | {} | {:.1} MiB | | | CPU {cpu:.0} ms (all parts), peak heap {:.1} MiB, extracts {:.1} MiB | {} rows | |", shape.name, l as usize * n_gets, mib(l as u64 * bytes), mib(peak as u64), mib(rows as u64), digest.0);
                }
            }
            let short = match &answer {
                Ok(j) => format!("{} B", j.len()),
                Err(e) => e.chars().take(70).collect(),
            };
            println!(
                "| {} | {v} | {n_files} | {n_gets} | {:.2} MiB | {scan} | {est} | {wall:.0} / {cpu:.0} ms, {:.1} MiB | {short} |",
                shape.name,
                mib(bytes),
                mib(peak as u64)
            );
        }
        println!("(load after: {})", loadavg());
    }
}
