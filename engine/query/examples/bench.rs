//! Native micro-benchmark: a simple timed loop (not criterion).
//!
//!   CARGO_TARGET_DIR=$PWD/target cargo run --release --example bench
//!
//! `sum by (job) (rate(http_requests_total[5m]))` over one hour at a 15 s step for 2,000
//! series whose samples are in Parquet. Reports wall time (min / median / max over the
//! runs), where it goes, and peak heap (a counting global allocator) and peak RSS.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;
use viz_promql::{MemSource, Series, SeriesSource};
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

const SERIES: usize = 2_000;
const JOBS: usize = 20;
/// 2023-11-15T06:00:00Z: the whole run is inside one UTC day.
const T0: i64 = 1_700_006_400_000 + 6 * 3_600_000;
const SCRAPE: i64 = 15_000;
/// One hour of steps plus the five minutes the first window reaches back.
const SCRAPES: i64 = 65 * 4 + 1;
const QUERY: &str = "sum by (job) (rate(http_requests_total[5m]))";

fn timed<T>(runs: usize, mut f: impl FnMut() -> T) -> (f64, f64, f64, usize) {
    let mut ms = Vec::new();
    let mut peak = 0;
    for _ in 0..runs {
        let base = LIVE.load(Relaxed);
        PEAK.store(base, Relaxed);
        let t = Instant::now();
        let out = f();
        ms.push(t.elapsed().as_secs_f64() * 1e3);
        peak = peak.max(PEAK.load(Relaxed) - base);
        drop(out);
    }
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (ms[0], ms[ms.len() / 2], ms[ms.len() - 1], peak)
}

fn report(what: &str, r: (f64, f64, f64, usize)) {
    println!("{what:<58} min {:>7.2} ms  median {:>7.2} ms  max {:>7.2} ms  peak heap {:>6.1} MiB", r.0, r.1, r.2, r.3 as f64 / 1048576.0);
}

fn main() {
    // ---- data: 2,000 counters in 20 jobs, scraped every 15 s, increments from an LCG.
    let defs: Vec<SeriesDef> = (0..SERIES)
        .map(|i| {
            SeriesDef::new([
                ("__name__".to_string(), "http_requests_total".to_string()),
                ("job".to_string(), format!("job{:02}", i % JOBS)),
                ("instance".to_string(), format!("10.0.{}.{}:9100", i / 250, i % 250)),
                ("code".to_string(), if i % 7 == 0 { "500" } else { "200" }.to_string()),
            ])
        })
        .collect();
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut totals = vec![0f64; SERIES];
    let mut rows = Vec::with_capacity(SERIES * SCRAPES as usize);
    for k in 0..SCRAPES {
        for (i, total) in totals.iter_mut().enumerate() {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            *total += ((state >> 33) % 50) as f64;
            rows.push(Row::new(i as u32, T0 + k * SCRAPE + (i as i64 % 1000), *total));
        }
    }
    // Batches of at most 1 MiB, as shards store them.
    let batches: Vec<Vec<u8>> = rows.chunks(30_000).map(|c| batch::encode(&defs, c).unwrap()).collect();
    assert!(batches.iter().all(|b| b.len() <= 1 << 20));
    let refs: Vec<&[u8]> = batches.iter().map(|b| b.as_slice()).collect();
    let t = Instant::now();
    let files = viz_storage::encode_segment(&refs).unwrap();
    let flush_ms = t.elapsed().as_secs_f64() * 1e3;
    let samples: Vec<&[u8]> = files.iter().filter(|f| f.table == viz_storage::Table::MetricSamples).map(|f| f.bytes.as_slice()).collect();
    let series: Vec<&[u8]> = files.iter().filter(|f| f.table == viz_storage::Table::MetricSeries).map(|f| f.bytes.as_slice()).collect();
    let lake = ScanInput { series_files: series.clone(), sample_files: samples.clone(), tail_batches: vec![] };
    let tail = ScanInput { series_files: vec![], sample_files: vec![], tail_batches: refs.clone() };
    println!(
        "data: {} series, {} samples ({} scrapes), {} batches ({:.1} MiB); flushed in {:.0} ms to {} sample file(s) of {:.2} MiB and {} series file(s) of {:.2} MiB",
        SERIES,
        rows.len(),
        SCRAPES,
        batches.len(),
        batches.iter().map(|b| b.len()).sum::<usize>() as f64 / 1048576.0,
        flush_ms,
        samples.len(),
        samples.iter().map(|f| f.len()).sum::<usize>() as f64 / 1048576.0,
        series.len(),
        series.iter().map(|f| f.len()).sum::<usize>() as f64 / 1048576.0,
    );

    let (start, end, step) = (T0 + 300_000, T0 + 3_900_000, 15_000);
    let opts = Options { limits: Limits::default(), ..Options::default() };
    println!("query: {QUERY}   [{start}, {end}] step {step} ms = {} steps\n", (end - start) / step + 1);

    // ---- the whole query, as a Worker would call it (defaults limits on).
    let first = Instant::now();
    let r = viz_query::query_range_with(&lake, QUERY, start, end, step, &opts).unwrap();
    println!("first call (builds the parser's tables): {:.2} ms", first.elapsed().as_secs_f64() * 1e3);
    println!("stats: {:?}; result: {} series\n", r.stats, r.matrix.series.len());
    assert_eq!(r.matrix.series.len(), JOBS);
    let json = viz_query::to_json(&r.matrix).unwrap();
    let runs = 15;
    report("query_range, data in Parquet (the benchmark)", timed(runs, || viz_query::query_range(&lake, QUERY, start, end, step).unwrap()));

    // ---- where the time goes.
    let sel = viz_query::selectors(QUERY, start, end, step).unwrap().remove(0);
    let ms: Vec<viz_storage::Matcher> = sel.matchers.iter().map(viz_query::to_storage_matcher).collect();
    report("  viz_storage::select from Parquet", timed(runs, || viz_storage::select(&lake, &ms, sel.min_ts_ms, sel.max_ts_ms).unwrap()));
    let loaded = viz_storage::select(&lake, &ms, sel.min_ts_ms, sel.max_ts_ms).unwrap();
    let mem = MemSource::from_series(loaded.into_iter().map(|s| Series { labels: s.labels, ts: s.ts, values: s.values }).collect());
    struct Borrowed<'a>(&'a MemSource);
    impl SeriesSource for Borrowed<'_> {
        fn select(&self, _: &[viz_promql::Matcher], _: i64, _: i64) -> Result<Vec<Series>, viz_promql::Error> {
            Ok(self.0.series().to_vec()) // a memcpy of the samples, no matching
        }
    }
    report("  viz-promql evaluation over preloaded series", timed(runs, || viz_promql::query_range(&Borrowed(&mem), QUERY, start, end, step).unwrap()));
    report("  parse + plan (viz_query::plan)", timed(runs, || viz_query::plan(QUERY, start, end, step).unwrap()));
    report("  serialise the matrix to JSON", timed(runs, || viz_query::to_json(&r.matrix).unwrap()));
    println!("  (result JSON: {} bytes)\n", json.len());

    // ---- for comparison: the same rows in the tail, and storage-location invariance.
    report("query_range, same rows in tail batches", timed(runs, || viz_query::query_range(&tail, QUERY, start, end, step).unwrap()));
    assert_eq!(viz_query::query_range(&tail, QUERY, start, end, step).unwrap(), json, "tail and lake agree");

    let hwm = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM")).map(|l| l.split_whitespace().nth(1).unwrap_or("?").to_string()));
    println!(
        "\npeak RSS of this process (VmHWM, includes the generated rows, batches and files held for the whole run): {} kB",
        hwm.unwrap_or_else(|| "n/a".into())
    );
    println!("inputs held while querying: Parquet {:.2} MiB", (samples.iter().chain(&series).map(|f| f.len()).sum::<usize>()) as f64 / 1048576.0);
}
