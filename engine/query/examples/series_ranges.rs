//! Does it pay for a split part's readers to range-read the SERIES files by the part's
//! `series_id` range, as they do the sample files? (query/CARDINALITY.md "What is left" 2;
//! query/README.md "Split parts and the series files".)
//!
//!   cargo run -j 2 --release --example series_ranges -- 100000 1000000
//!
//! The workload of `examples/pruning.rs` (`x{job, namespace, pod}`, counters every 60 s; an
//! hour in seven ten-minute units below 1,000,000 series, one unit at 1,000,000), the
//! full-metric aggregate `sum by (job)(rate(x[5m]))` over the parts the Worker would use (7 at
//! 100,000, 32 at 1,000,000). For every part, both ways on the same files:
//!
//!   now        series files by name and time (`file_plan`), sample files by the part's id
//!              range (`part_plan`), then `extract`;
//!   proposal   series files by the part's id range too (`part_plan` over their fragments).
//!
//! The extracts must be identical (no series of this workload carries a label the split key
//! leaves out; in general a part reading only its id range of the series files cannot see a
//! series of its part whose id lies elsewhere, which is why this is measured before it is
//! built). Native x86-64, one thread, CPU of the parts in series; not WASM, not Cloudflare.
mod pruning_common;
use pruning_common::*;
use viz_query::{file_plan, part_plan, plan, FilePlan, FileRead, Options, RANGE_GAP};
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

fn gets(p: &FilePlan, size: usize) -> usize {
    match &p.read {
        FileRead::Skip => 0,
        FileRead::Whole => whole_gets(size),
        FileRead::Ranges(r) => r.iter().map(|x| whole_gets(x.1 as usize)).sum(),
    }
}

fn main() {
    let ns: Vec<usize> = std::env::args().skip(1).map(|a| a.parse().unwrap()).collect();
    for n in ns {
        let units = if n >= 1_000_000 { 1 } else { 7 };
        let end = DAY0 + units as i64 * UNIT - SCRAPE;
        let start = if units == 1 { DAY0 + 5 * SCRAPE } else { end - 3_600_000 };
        let files: Vec<_> = (0..units).map(|u| unit(n, DAY0 + u as i64 * UNIT, u * 10)).collect();
        let s_idx: Vec<&str> = files.iter().map(|(_, s)| s.index.as_str()).collect();
        let m_idx: Vec<&str> = files.iter().map(|(m, _)| m.index.as_str()).collect();
        let q = "sum by (job) (rate(x[5m]))";
        let ranges = plan(q, start, end, SCRAPE).unwrap();
        let viz_query::split::SplitPlan::Split { key, .. } = viz_query::split_plan(q, &Options::default()) else { panic!("does not split") };
        let parts: u32 = if n >= 1_000_000 { 32 } else { 7 };
        let groups: Vec<usize> = files.iter().map(|(_, s)| s.index.matches("\"rows\"").count()).collect();
        println!(
            "\n## {n} series, {units} unit(s), {parts} parts; series files: {} of {:.2} MiB in all, {:?} row groups each (load {})",
            files.len(),
            mib(files.iter().map(|(_, s)| s.bytes.len() as u64).sum()),
            groups,
            loadavg()
        );
        println!("| way | series-file GETs | series-file bytes | sample-file bytes | CPU, all parts | peak heap | extract rows | same |");
        println!("|---|---:|---:|---:|---:|---:|---:|---|");
        let mut first: Option<(u64, u64)> = None;
        for (way, by_part) in [("now: series files by name and time", false), ("proposal: series files by id range", true)] {
            let ((digest, sg, sb, mb), _wall, cpu, peak) = measure(|| {
                let (mut all, mut sg, mut sb, mut mb) = (Vec::new(), 0usize, 0u64, 0u64);
                for part in 0..parts {
                    let sp = if by_part { part_plan(&s_idx, &ranges, part, parts, RANGE_GAP) } else { file_plan(&s_idx, &ranges, RANGE_GAP) };
                    let pp = part_plan(&m_idx, &ranges, part, parts, RANGE_GAP);
                    let ser: Vec<Vec<u8>> = files.iter().zip(&sp).filter_map(|((_, s), p)| cut(&s.bytes, p)).collect();
                    let sam: Vec<Vec<u8>> = files.iter().zip(&pp).filter_map(|((m, _), p)| cut(&m.bytes, p)).collect();
                    for (i, (m, s)) in files.iter().enumerate() {
                        sg += gets(&sp[i], s.bytes.len());
                        sb += sp[i].bytes(s.bytes.len() as u64);
                        mb += pp[i].bytes(m.bytes.len() as u64);
                    }
                    let sref: Vec<&[u8]> = ser.iter().map(|b| &b[..]).collect();
                    let mref: Vec<&[u8]> = sam.iter().map(|b| &b[..]).collect();
                    let ex = viz_query::split::extract(&sref, &mref, &key, part, parts, &ranges).unwrap();
                    assert_eq!(ex.strays, 0, "no series of this workload is a stray");
                    all.push(ex.batch);
                }
                (rows_digest(&all), sg, sb, mb)
            });
            let same = match first {
                None => {
                    first = Some(digest);
                    "(reference)".to_string()
                }
                Some(d) if d == digest => "identical rows".to_string(),
                Some(_) => "**DIFFERENT ROWS**".to_string(),
            };
            println!("| {way} | {sg} | {:.1} MiB | {:.1} MiB | {cpu:.0} ms | {:.1} MiB | {} | {same} |", mib(sb), mib(mb), mib(peak as u64), digest.0);
        }
        println!("(load after: {})", loadavg());
    }
}
