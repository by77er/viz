//! High cardinality, measured natively: what one metric with N series costs to store, to
//! count (the cardinality report) and to query, for one ten-minute flush unit.
//!
//!   CARGO_TARGET_DIR=$PWD/target cargo run --release --example cardinality -- 10000 100000 1000000
//!
//! Native x86-64, release profile, one thread: NOT WASM and NOT Cloudflare. Every figure
//! is one call of a function the Worker calls through `engine/wasm-query` (the same crate
//! behind a C ABI). Peak heap is a counting global allocator's high-water mark above what
//! was live before the call: the inputs (files, batches) are not in it. Times are wall
//! times on a shared machine; read the load average printed with them.
//!
//! Workload: `http_requests_total{code, instance, job}`, 20 jobs, one `instance` per series
//! (the label that makes the cardinality), counters scraped every 60 s for ten minutes (ten
//! samples a series). The series are spread over S shards of at most 125,000 series (one
//! sample file and one series file per shard: one flush unit), as a tenant's series are
//! spread over its slots.
//!
//! Per N it prints:
//!   files    bytes per sample and per series in Parquet
//!   report   the cardinality report: one place over every series file; L parts (each
//!            reads every series file and keeps its key range), their summaries, the merge
//!   query    sum by (job)(rate(http_requests_total[5m])), step 60 s, over the unit: one
//!            place with the default limits, one place with the limits lifted (the cost of
//!            what the limits prevent), and split over L parts (readers, leaf, merge)
//!   labels   /api/v1/label/instance/values?match[]=http_requests_total over the unit
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;
use viz_query::cardinality::{Caps, State, Summary};
use viz_query::split::{self, Gathered, Grid, LeafBudget, LeafOutput, SplitPlan};
use viz_query::{Limits, Options, ScanInput};
use viz_storage::batch::{self, Row, SeriesDef};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let live = LIVE.fetch_add(l.size(), Relaxed) + l.size();
            PEAK.fetch_max(live, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Relaxed);
        System.dealloc(p, l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = System.realloc(p, l, new);
        if !q.is_null() {
            if new >= l.size() {
                let live = LIVE.fetch_add(new - l.size(), Relaxed) + (new - l.size());
                PEAK.fetch_max(live, Relaxed);
            } else {
                LIVE.fetch_sub(l.size() - new, Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;

const JOBS: usize = 20;
const SHARD_SERIES: usize = 125_000;
/// Series per batch: 3,000 x 10 rows and their labels stay under the batch cap of 1 MiB.
const BATCH_SERIES: usize = 3_000;
/// 2023-11-15T06:00:00Z: inside one UTC day.
const T0: i64 = 1_700_006_400_000 + 6 * 3_600_000;
const SCRAPE: i64 = 60_000;
const SCRAPES: i64 = 10;
const QUERY: &str = "sum by (job) (rate(http_requests_total[5m]))";
/// What the query Worker's defaults give a split query (query/src/config.ts).
const MAX_QUERY_SAMPLES: u64 = 64_000_000;
const MAX_QUERY_SERIES: u64 = 640_000;

fn mib(b: usize) -> f64 {
    b as f64 / 1048576.0
}

/// One call: wall ms and peak heap above what was live before it.
fn once<T>(f: impl FnOnce() -> T) -> (T, f64, usize) {
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let t = Instant::now();
    let out = f();
    let ms = t.elapsed().as_secs_f64() * 1e3;
    (out, ms, PEAK.load(Relaxed).saturating_sub(base))
}

/// `runs` calls: (min, median, max) ms and the largest peak heap; the last result.
fn timed<T>(runs: usize, mut f: impl FnMut() -> T) -> (T, [f64; 3], usize) {
    let mut ms = Vec::new();
    let mut peak = 0;
    let mut last = None;
    for _ in 0..runs {
        let (out, t, p) = once(&mut f);
        ms.push(t);
        peak = peak.max(p);
        last = Some(out);
    }
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (last.unwrap(), [ms[0], ms[ms.len() / 2], ms[ms.len() - 1]], peak)
}

fn fmt_ms(t: [f64; 3]) -> String {
    if (t[2] - t[0]).abs() < 1e-9 {
        format!("{:.1} ms", t[0])
    } else {
        format!("{:.1} / {:.1} / {:.1} ms", t[0], t[1], t[2])
    }
}

fn loadavg() -> String {
    std::fs::read_to_string("/proc/loadavg").map(|s| s.split_whitespace().take(3).collect::<Vec<_>>().join(" ")).unwrap_or_else(|_| "?".into())
}

fn share(total: u64, n: u64, j: u64) -> u64 {
    total / n + if j < total % n { 1 } else { 0 }
}

struct Unit {
    series_files: Vec<Vec<u8>>,
    sample_files: Vec<Vec<u8>>,
    samples: usize,
}

/// One flush unit of `n` series over `ceil(n / 125,000)` shards.
fn generate(n: usize) -> Unit {
    let shards = n.div_ceil(SHARD_SERIES);
    let mut unit = Unit { series_files: Vec::new(), sample_files: Vec::new(), samples: 0 };
    let mut state = 0x2545_f491_4f6c_dd1du64;
    for s in 0..shards {
        let mine: Vec<usize> = (s..n).step_by(shards).collect();
        let mut batches: Vec<Vec<u8>> = Vec::new();
        for chunk in mine.chunks(BATCH_SERIES) {
            let defs: Vec<SeriesDef> = chunk
                .iter()
                .map(|&i| {
                    SeriesDef::new([
                        ("__name__".to_string(), "http_requests_total".to_string()),
                        ("code".to_string(), if i % 7 == 0 { "500" } else { "200" }.to_string()),
                        ("instance".to_string(), format!("10.{}.{}.{}:9100", i >> 16, (i >> 8) & 255, i & 255)),
                        ("job".to_string(), format!("job{:02}", i % JOBS)),
                    ])
                })
                .collect();
            let mut rows = Vec::with_capacity(chunk.len() * SCRAPES as usize);
            let mut totals = vec![0f64; chunk.len()];
            for k in 0..SCRAPES {
                for (j, &i) in chunk.iter().enumerate() {
                    state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    totals[j] += ((state >> 33) % 50) as f64;
                    rows.push(Row::new(j as u32, T0 + k * SCRAPE + (i as i64 % 1000), totals[j]));
                }
            }
            unit.samples += rows.len();
            let b = batch::encode(&defs, &rows).unwrap();
            assert!(b.len() <= 1 << 20, "batch of {} bytes", b.len());
            batches.push(b);
        }
        let refs: Vec<&[u8]> = batches.iter().map(|b| b.as_slice()).collect();
        for f in viz_storage::encode_segment(&refs).unwrap() {
            match f.table {
                viz_storage::Table::MetricSeries => unit.series_files.push(f.bytes),
                viz_storage::Table::MetricSamples => unit.sample_files.push(f.bytes),
                _ => {}
            }
        }
    }
    unit
}

fn report_section(n: usize, unit: &Unit, runs: usize) {
    let series: Vec<&[u8]> = unit.series_files.iter().map(|f| f.as_slice()).collect();
    let (start, end) = (T0, T0 + SCRAPES * SCRAPE - 1);
    let lifted = Caps { max_series: u64::MAX, max_pairs: u64::MAX };

    // One place, default caps (what the Worker does when the series files fit one place).
    let (r, t, peak) = once(|| {
        let mut st = State::new(start, end, 0, 1, Caps::default());
        for (i, f) in series.iter().enumerate() {
            st.add_series_file(f, i)?;
        }
        Ok::<_, viz_query::QueryError>(st.summary())
    });
    match r {
        Ok(s) => println!("report  one place, default caps: {:.1} ms, peak heap {:.1} MiB, summary {:.2} MiB", t, mib(peak), mib(s.encode().len())),
        Err(e) => println!("report  one place, default caps: REFUSED after {:.1} ms (peak heap {:.1} MiB): {}", t, mib(peak), e.message),
    }

    // One place, caps lifted: what counting costs.
    let (s, t, peak) = timed(runs, || {
        let mut st = State::new(start, end, 0, 1, lifted);
        for (i, f) in series.iter().enumerate() {
            st.add_series_file(f, i).unwrap();
        }
        st.summary()
    });
    let enc = s.encode();
    let ((tsdb, viz), tr, pr) = once(|| s.report(10, start, end, start, lifted));
    println!(
        "report  one place, caps lifted: count {} (peak heap {:.1} MiB); summary {:.2} MiB ({} pairs, {} triples); render top 10: {:.1} ms, peak heap {:.1} MiB; /status/tsdb {} B, /status/cardinality {} B",
        fmt_ms(t),
        mib(peak),
        mib(enc.len()),
        s.pairs.len(),
        s.triples.len(),
        tr,
        mib(pr),
        tsdb.len(),
        viz.len()
    );
    assert!(tsdb.contains(&format!("\"numSeries\":{n}")), "the report counts every series");

    // Over parts: each part reads every series file and keeps its key range.
    for parts in [8u32, 32] {
        if n < 100_000 && parts == 32 {
            continue;
        }
        let mut sums = Vec::new();
        let (mut tmax, mut tsum, mut pmax, mut bmax) = (0f64, 0f64, 0usize, 0usize);
        for j in 0..parts {
            let (s, t, p) = once(|| {
                let mut st = State::new(start, end, j, parts, Caps::default());
                for (i, f) in series.iter().enumerate() {
                    st.add_series_file(f, i).unwrap();
                }
                st.summary().encode()
            });
            tmax = tmax.max(t);
            tsum += t;
            pmax = pmax.max(p);
            bmax = bmax.max(s.len());
            sums.push(s);
        }
        // The coordinator: decode and merge every part's summary, then render.
        let (merged, tm, pm) = once(|| {
            let mut all = Summary::default();
            for p in &sums {
                if let Err(e) = all.merge(&Summary::decode(p).unwrap(), Caps::default()) {
                    return Err(e);
                }
            }
            Ok(all.report(10, start, end, start, Caps::default()))
        });
        let total: usize = sums.iter().map(|s| s.len()).sum();
        let outcome = match merged {
            Ok((tsdb, _)) => {
                assert!(tsdb.contains(&format!("\"numSeries\":{n}")));
                "answers".to_string()
            }
            Err(e) => format!("REFUSED: {}", e.message),
        };
        println!(
            "report  {parts} parts, default caps: per part {:.1} ms max ({:.0} ms all parts), peak heap {:.1} MiB max, summary {:.2} MiB max ({:.2} MiB over RPC); merge + render at the coordinator {:.1} ms, peak heap {:.1} MiB: {outcome}",
            tmax,
            tsum,
            mib(pmax),
            mib(bmax),
            mib(total),
            tm,
            mib(pm)
        );
    }
}

fn query_section(n: usize, unit: &Unit, runs: usize) {
    let series: Vec<&[u8]> = unit.series_files.iter().map(|f| f.as_slice()).collect();
    let samples: Vec<&[u8]> = unit.sample_files.iter().map(|f| f.as_slice()).collect();
    let lake = ScanInput { series_files: series.clone(), sample_files: samples.clone(), tail_batches: vec![] };
    let (start, end, step) = (T0 + 5 * SCRAPE, T0 + (SCRAPES - 1) * SCRAPE, SCRAPE);
    let defaults = Options::default();

    let (r, t, peak) = once(|| viz_query::query_range_with(&lake, QUERY, start, end, step, &defaults));
    match r {
        Ok(r) => println!("query   one place, default limits: {:.1} ms, peak heap {:.1} MiB, {} samples of {} series loaded", t, mib(peak), r.stats.samples, r.stats.series),
        Err(e) => println!("query   one place, default limits: REFUSED after {:.1} ms (peak heap {:.1} MiB): {}", t, mib(peak), e.message),
    }
    let lifted = Options { limits: Limits::unlimited(), ..Options::default() };
    let (r, t, peak) = timed(runs, || viz_query::query_range_with(&lake, QUERY, start, end, step, &lifted).unwrap());
    assert_eq!(r.matrix.series.len(), JOBS);
    let reference = viz_query::to_json(&r.matrix).unwrap();
    println!("query   one place, limits lifted: {} , peak heap {:.1} MiB, {} samples of {} series", fmt_ms(t), mib(peak), r.stats.samples, r.stats.series);

    // What the Worker would decide (query/src/coordinator.ts): split only above
    // splitAboveSamples (1.5 M) of scan bound; leaves from samples alone.
    let scan = unit.samples as u64;
    let by_samples = if scan > 1_500_000 { (scan as f64 / 1_500_000.0).ceil().max(2.0) as u64 } else { 1 };
    let by_series = (n as f64 / 15_000.0).ceil().max(1.0) as u64;
    println!(
        "query   the Worker's choice: scan bound {scan} samples -> {} (leaves from samples: {by_samples}); leaves the series need at 15,000 a leaf: {by_series}",
        if by_samples == 1 { "one place" } else { "split" }
    );

    let SplitPlan::Split { fragments, key } = viz_query::split_plan(QUERY, &defaults) else { panic!("the query splits") };
    let ranges = viz_query::plan(QUERY, start, end, step).unwrap();
    for parts in [by_series.clamp(2, 32) as u32, 32] {
        if parts == 32 && by_series >= 32 && n < 1_000_000 {
            continue;
        }
        let q_samples = MAX_QUERY_SAMPLES.min(parts as u64 * 2_000_000);
        let q_series = MAX_QUERY_SERIES.min(parts as u64 * 20_000);
        // Reader groups: at most six reads, so three (series, samples) file pairs.
        let groups: Vec<(Vec<&[u8]>, Vec<&[u8]>)> = series.chunks(3).zip(samples.chunks(3)).map(|(a, b)| (a.to_vec(), b.to_vec())).collect();
        let (mut reader_max, mut reader_all, mut reader_peak, mut extract_bytes) = (0f64, 0f64, 0usize, 0usize);
        let (mut leaf_max, mut leaf_peak, mut held_max, mut series_max, mut out_bytes) = (0f64, 0usize, 0u64, 0u64, 0usize);
        let mut outputs = Vec::new();
        let mut aborted = 0;
        for j in 0..parts {
            let mut extracts = Vec::new();
            for (s, f) in &groups {
                let (ex, t, p) = once(|| split::extract(s, f, &key, j, parts, &ranges).unwrap());
                reader_max = reader_max.max(t);
                reader_all += t;
                reader_peak = reader_peak.max(p);
                extract_bytes += ex.batch.len();
                extracts.push(ex.batch);
            }
            let budget = LeafBudget { samples: share(q_samples, parts as u64, j as u64), series: share(q_series, parts as u64, j as u64), step_points: 1_000_000 };
            let (out, t, p) = once(|| {
                let mut g = Gathered::new(&ranges, budget).unwrap();
                for (rank, b) in extracts.iter().enumerate() {
                    g.add(b, rank as u32).unwrap();
                }
                let (held, ser) = g.counts();
                (split::leaf_evaluate(&g, QUERY, Grid::Range { start, end, step }, &defaults, fragments).encode(), held, ser)
            });
            leaf_max = leaf_max.max(t);
            leaf_peak = leaf_peak.max(p);
            held_max = held_max.max(out.1);
            series_max = series_max.max(out.2);
            out_bytes += out.0.len();
            let o = LeafOutput::decode(&out.0).unwrap();
            if o.aborted.is_some() {
                aborted += 1;
            }
            outputs.push(o);
        }
        let limits = Limits { max_samples: q_samples, max_series: q_series, max_step_points: parts as u64 * 1_000_000, ..Limits::default() };
        let (merged, tm, pm) = once(|| split::merge_range(QUERY, start, end, step, &Options { limits, ..Options::default() }, &outputs));
        let outcome = match merged {
            Ok(m) => {
                assert_eq!(viz_query::to_json(&m.matrix).unwrap(), reference, "split equals one place");
                "answers, identical to one place".to_string()
            }
            Err(e) => format!("REFUSED: {}", e.message),
        };
        println!(
            "query   {parts} parts: readers {} calls, {:.1} ms max per call, {:.0} ms all calls, peak heap {:.1} MiB max, extracts {:.2} MiB over RPC; leaf (gather + evaluate) {:.1} ms max, peak heap {:.1} MiB max, holds at most {held_max} samples of {series_max} series, {aborted} stopped at its share; answers {:.1} KiB; merge {:.1} ms, peak heap {:.1} MiB: {outcome}",
            groups.len() * parts as usize,
            reader_max,
            reader_all,
            mib(reader_peak),
            mib(extract_bytes),
            leaf_max,
            mib(leaf_peak),
            out_bytes as f64 / 1024.0,
            tm,
            mib(pm)
        );
    }

    // The label endpoint Grafana's variable queries use.
    let m = viz_query::parse_selector("http_requests_total").unwrap();
    let (r, t, peak) = once(|| viz_query::label_values(&lake, "instance", &m, T0, T0 + SCRAPES * SCRAPE));
    match r {
        Ok(v) => println!("labels  label/instance/values, default limits: {:.1} ms, peak heap {:.1} MiB, {} values", t, mib(peak), v.len()),
        Err(e) => println!("labels  label/instance/values, default limits: REFUSED after {:.1} ms (peak heap {:.1} MiB): {}", t, mib(peak), e.message),
    }
}

fn main() {
    let ns: Vec<usize> = std::env::args().skip(1).map(|a| a.parse().expect("a number of series")).collect();
    let ns = if ns.is_empty() { vec![10_000, 100_000, 1_000_000] } else { ns };
    println!("native x86-64 release, one thread; load average at start {}", loadavg());
    for n in ns {
        let runs = if n <= 10_000 { 5 } else if n <= 100_000 { 3 } else { 1 };
        println!("\n== {n} series, one ten-minute flush unit at a 60 s scrape (load average {}) ==", loadavg());
        let (unit, t, _) = once(|| generate(n));
        let sb: usize = unit.series_files.iter().map(|f| f.len()).sum();
        let pb: usize = unit.sample_files.iter().map(|f| f.len()).sum();
        println!(
            "files   {} shard(s): {} samples; sample files {:.2} MiB ({:.2} B a sample), series files {:.2} MiB ({:.1} B a series); generated and flushed in {:.0} ms",
            unit.series_files.len(),
            unit.samples,
            mib(pb),
            pb as f64 / unit.samples as f64,
            mib(sb),
            sb as f64 / n as f64,
            t
        );
        report_section(n, &unit, runs);
        query_section(n, &unit, runs);
        let hwm = std::fs::read_to_string("/proc/self/status").ok().and_then(|s| s.lines().find(|l| l.starts_with("VmHWM")).map(|l| l.to_string()));
        println!("process {} (load average {})", hwm.unwrap_or_default(), loadavg());
    }
}
