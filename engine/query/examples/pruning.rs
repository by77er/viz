//! The counterfactual's "after" side (query/CARDINALITY.md, "Series-level pruning"): the
//! same five query shapes over the same files as `examples/pruning_before.rs`, planned and
//! read as the query Worker does since 2026-11-19, and compared with the answers the
//! "before" run wrote, byte for byte.
//!
//!   cargo run --release --example pruning -- BEFORE_DIR 10000 100000
//!
//! Per shape: the Worker's plan (fragments by name and time, then, when that does not fit
//! one place and a matcher selects by more than the name, the matchers resolved against the
//! series files and only the row groups holding a selected series read), the reads it
//! issues (each byte range is one GET) and their bytes, the rounds of reads, the scan bound,
//! the series estimate, the engine's one-place work (planning included) and the answer.
//! Then, for the shapes the Worker splits: what its readers read, before (every part reads
//! every file whole) and now (each part its `series_id` range of each sample file).
//! Native x86-64, one thread; not WASM, not Cloudflare.
mod pruning_common;
use pruning_common::*;
use viz_query::{file_plan, part_plan, plan, sample_plan, selectors, FilePlan, FileRead, Limits, Options, ScanInput, RANGE_GAP};
use viz_storage::sparse;

#[global_allocator]
static A: Counting = Counting;

fn cut(bytes: &[u8], p: &FilePlan) -> Option<Vec<u8>> {
    match &p.read {
        FileRead::Skip => None,
        FileRead::Whole => Some(bytes.to_vec()),
        FileRead::Ranges(r) => Some(sparse::cut(bytes, r)),
    }
}

fn gets(p: &FilePlan) -> usize {
    match &p.read {
        FileRead::Skip => 0,
        FileRead::Whole => 1,
        FileRead::Ranges(r) => r.len(),
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let before = args.next().expect("BEFORE_DIR");
    let ns: Vec<usize> = args.map(|a| a.parse().unwrap()).collect();
    let mut differ = 0;
    for n in ns {
        let units = if n >= 1_000_000 { 1 } else { 7 };
        let end = DAY0 + units as i64 * UNIT - SCRAPE;
        let start = if units == 1 { DAY0 + 5 * SCRAPE } else { end - 3_600_000 };
        let files: Vec<_> = (0..units).map(|u| unit(n, DAY0 + u as i64 * UNIT, u * 10)).collect();
        let s_idx: Vec<&str> = files.iter().map(|(_, s)| s.index.as_str()).collect();
        let m_idx: Vec<&str> = files.iter().map(|(m, _)| m.index.as_str()).collect();
        println!("\n## {n} series, {units} ten-minute units, query window {} min (load {})", (end - start) / 60_000, loadavg());
        println!("| shape | the Worker's plan (now) | files read | GETs | rounds | bytes | scan bound | series estimate | engine, one place: wall / CPU ms, peak heap | answer | same as before |");
        println!("|---|---|---:|---:|---:|---:|---:|---:|---|---|---|");
        let mut split_rows = Vec::new();
        for shape in shapes(n) {
            let (ranges, reads, decomposes, meta) = match &shape.kind {
                Kind::Range(q) => (plan(q, start, end, SCRAPE).unwrap(), ranges_of(selectors(q, start, end, SCRAPE).unwrap()), q.starts_with("sum"), false),
                Kind::LabelValues { matchers, .. } | Kind::Series(matchers) => {
                    let r = vec![viz_query::FetchRange { matchers: matchers.clone(), min_ts: start, max_ts: end }];
                    (r.clone(), r, false, true)
                }
            };
            // Round 1 plans: from the fragments, by name and time.
            let sp = file_plan(&s_idx, &ranges, RANGE_GAP);
            let mp = file_plan(&m_idx, &ranges, RANGE_GAP);
            let series: Vec<Vec<u8>> = files.iter().zip(&sp).filter_map(|((_, s), p)| cut(&s.bytes, p)).collect();
            let series_bytes: u64 = files.iter().zip(&sp).map(|((_, s), p)| p.bytes(s.bytes.len() as u64)).sum();
            let series_gets: usize = sp.iter().map(gets).sum();
            let scan0: u64 = viz_query::scan_rows(&m_idx, &reads).iter().map(|r| r.unwrap()).sum();
            let est0 = series_estimate(&files.iter().zip(viz_query::scan_rows(&s_idx, &reads)).filter(|(_, r)| r.unwrap() > 0).map(|((_, s), r)| (s.min_ts, s.max_ts, r.unwrap())).collect::<Vec<_>>());
            let sample_bytes0: u64 = files.iter().zip(&mp).map(|((m, _), p)| p.bytes(m.bytes.len() as u64)).sum();
            let resolvable = reads.iter().any(|r| r.matchers.iter().any(|m| !(m.name == "__name__" && m.op == viz_query::MatchOp::Eq)));
            let over = verdict(decomposes, scan0, est0, series_bytes + sample_bytes0, series.len() + files.len()) != "one place";
            let (v, n_files, n_gets, rounds, bytes, scan, est, answer, wall, cpu, peak);
            if meta {
                // The label calls: series files only.
                let input = ScanInput { series_files: series.iter().map(|b| &b[..]).collect(), sample_files: vec![], tail_batches: vec![] };
                let lim = Limits { max_series: 200_000, ..Limits::default() };
                let r = measure_n(3, || match &shape.kind {
                    Kind::LabelValues { label, matchers } => viz_query::label_values_with(&input, label, matchers, start, end, &lim).map(|v| viz_query::to_json(&v).unwrap()).map_err(|e| e.message),
                    Kind::Series(m) => viz_query::series_with(&input, &[m.clone()], start, end, &lim).map(|v| viz_query::labels_to_json(&v)).map_err(|e| e.message),
                    Kind::Range(_) => unreachable!(),
                });
                (answer, wall, cpu, peak) = r;
                v = if series_bytes > 16 << 20 { "refused (max_fetch_bytes)".to_string() } else { "one place, series files only".to_string() };
                (n_files, n_gets, rounds, bytes, scan, est) = (series.len(), series_gets, 1, series_bytes, 0, 0);
            } else {
                let Kind::Range(q) = &shape.kind else { unreachable!() };
                let resolve = over && resolvable && series_bytes <= 16 << 20;
                // The engine's work: planning (when resolved) and one-place evaluation over the reads.
                let r = measure_n(3, || {
                    let (mplans, scan, est) = if resolve {
                        let s: Vec<&[u8]> = series.iter().map(|b| &b[..]).collect();
                        let rp = sample_plan(&s, &m_idx, &reads, None, RANGE_GAP).unwrap();
                        let scan: u64 = rp.files.iter().map(|f| f.rows.unwrap()).sum();
                        (rp.files, scan, rp.series)
                    } else {
                        (mp.clone(), scan0, est0)
                    };
                    let samples: Vec<Vec<u8>> = files.iter().zip(&mplans).filter_map(|((m, _), p)| cut(&m.bytes, p)).collect();
                    let input = ScanInput { series_files: series.iter().map(|b| &b[..]).collect(), sample_files: samples.iter().map(|b| &b[..]).collect(), tail_batches: vec![] };
                    let a = viz_query::query_range_with(&input, q, start, end, SCRAPE, &Options::default()).map(|r| viz_query::to_json(&r.matrix).unwrap()).map_err(|e| e.message);
                    (a, mplans, scan, est)
                });
                let ((a, mplans, s, e), w, c, p) = r;
                (answer, wall, cpu, peak) = (a, w, c, p);
                let sb: u64 = files.iter().zip(&mplans).map(|((m, _), p)| p.bytes(m.bytes.len() as u64)).sum();
                let kept = mplans.iter().filter(|p| p.read != FileRead::Skip).count();
                bytes = series_bytes + sb;
                v = format!("{}{}", verdict(decomposes, s, e, bytes, series.len() + kept), if resolve { ", series resolved" } else { "" });
                (n_files, n_gets, rounds, scan, est) = (series.len() + kept, series_gets + mplans.iter().map(gets).sum::<usize>(), if resolve { 2 } else { 1 }, s, e);
                if v.starts_with("split") {
                    split_rows.push((shape.name, ranges.clone(), v.clone(), q.clone(), scan0, est0));
                }
            }
            let text = match &answer {
                Ok(j) => j.clone(),
                Err(e) => format!("ERROR {e}"),
            };
            let path = format!("{before}/{n}-{}.txt", shape.name.replace(['/', ' '], "_"));
            let same = match std::fs::read_to_string(&path) {
                Ok(b) if b == text => "identical".to_string(),
                Ok(_) => {
                    differ += 1;
                    "**DIFFERENT**".to_string()
                }
                Err(_) => "(no before run)".to_string(),
            };
            let short = match &answer {
                Ok(j) => format!("{} B", j.len()),
                Err(e) => e.chars().take(70).collect(),
            };
            println!(
                "| {} | {v} | {n_files} | {n_gets} | {rounds} | {:.2} MiB | {scan} | {est} | {wall:.0} / {cpu:.0} ms, {:.1} MiB | {short} | {same} |",
                shape.name,
                mib(bytes),
                mib(peak as u64)
            );
        }
        // What split readers read: before, every part read every file whole; now each part
        // reads the series files by name and time and its id range of each sample file.
        if !split_rows.is_empty() {
            println!("\n| shape (split) | leaves before / now | reader GETs before | bytes before | reader GETs now | bytes now |");
            println!("|---|---|---:|---:|---:|---:|");
        }
        for (name, ranges, v, _q, scan0, est0) in split_rows {
            let l_before = 2u64.max(scan0.div_ceil(1_500_000)).max(est0.div_ceil(15_000)).min(32) as u32;
            let l_now: u32 = v.split(", ").next().unwrap().trim_start_matches("split").trim().trim_end_matches(" leaves").parse().unwrap_or(l_before);
            let whole: u64 = files.iter().map(|(m, s)| (m.bytes.len() + s.bytes.len()) as u64).sum();
            let before_gets = l_before as usize * 2 * files.len();
            let before_bytes = l_before as u64 * whole;
            let sp = file_plan(&s_idx, &ranges, RANGE_GAP);
            let (mut g, mut b) = (0usize, 0u64);
            for part in 0..l_now {
                let pp = part_plan(&m_idx, &ranges, part, l_now, RANGE_GAP);
                for (i, (m, s)) in files.iter().enumerate() {
                    g += gets(&sp[i]) + gets(&pp[i]);
                    b += sp[i].bytes(s.bytes.len() as u64) + pp[i].bytes(m.bytes.len() as u64);
                }
            }
            println!("| {name} | {l_before} / {l_now} | {before_gets} | {:.1} MiB | {g} | {:.1} MiB |", mib(before_bytes), mib(b));
        }
        println!("(load after: {})", loadavg());
    }
    if differ > 0 {
        eprintln!("{differ} answers differ from the before run");
        std::process::exit(1);
    }
}
