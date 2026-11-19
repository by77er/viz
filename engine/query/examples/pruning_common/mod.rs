//! Shared by `examples/pruning.rs` (this tree) and `examples/pruning_before.rs` (which also
//! builds against the tree as of 2026-11-18, before series-level pruning): the workload, the
//! query shapes, the timing helpers and the query Worker's planning rules as of 2026-11-18.
//! Uses only API that existed then.
#![allow(dead_code)]
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;
use viz_query::FetchRange;
use viz_storage::batch::{self, Row, SeriesDef};
use viz_storage::{encode_segment, EncodedFile, Table};

pub struct Counting;
pub static LIVE: AtomicUsize = AtomicUsize::new(0);
pub static PEAK: AtomicUsize = AtomicUsize::new(0);

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

/// CPU time of this thread in ns (`/proc/thread-self/schedstat`, Linux), or 0.
pub fn cpu_ns() -> u64 {
    std::fs::read_to_string("/proc/thread-self/schedstat").ok().and_then(|s| s.split_whitespace().next()?.parse().ok()).unwrap_or(0)
}

pub fn loadavg() -> String {
    std::fs::read_to_string("/proc/loadavg").map(|s| s.split_whitespace().take(3).collect::<Vec<_>>().join(" ")).unwrap_or_else(|_| "?".into())
}

/// One measured call: (result, wall ms, CPU ms, peak heap above the live heap before it).
pub fn measure<T>(f: impl FnOnce() -> T) -> (T, f64, f64, usize) {
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let (c0, t0) = (cpu_ns(), Instant::now());
    let out = f();
    let wall = t0.elapsed().as_secs_f64() * 1e3;
    let cpu = (cpu_ns() - c0) as f64 / 1e6;
    (out, wall, cpu, PEAK.load(Relaxed).saturating_sub(base))
}

/// `runs` calls; the median wall and CPU ms, the largest peak, the last result.
pub fn measure_n<T>(runs: usize, mut f: impl FnMut() -> T) -> (T, f64, f64, usize) {
    let (mut walls, mut cpus, mut peak, mut last) = (Vec::new(), Vec::new(), 0, None);
    for _ in 0..runs {
        let (out, w, c, p) = measure(&mut f);
        walls.push(w);
        cpus.push(c);
        peak = peak.max(p);
        last = Some(out);
    }
    walls.sort_by(|a, b| a.partial_cmp(b).unwrap());
    cpus.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (last.unwrap(), walls[walls.len() / 2], cpus[cpus.len() / 2], peak)
}

pub fn mib(b: u64) -> f64 {
    b as f64 / 1048576.0
}

/// 2023-11-15T06:00:00Z: the hour and its lookback lie in one UTC day.
pub const DAY0: i64 = 1_700_006_400_000 + 6 * 3_600_000;
pub const SCRAPE: i64 = 60_000;
pub const UNIT: i64 = 600_000;
/// Series per batch: 3,000 x 10 rows and their labels stay under the batch cap of 1 MiB.
const BATCH_SERIES: usize = 3_000;
pub const METRIC: &str = "x";

pub fn labels(i: usize) -> Vec<(String, String)> {
    vec![
        ("__name__".into(), METRIC.into()),
        ("job".into(), format!("job-{:02}", i % 20)),
        ("namespace".into(), format!("ns-{:02}", (i / 7) % 20)),
        ("pod".into(), format!("pod-{i:07}")),
    ]
}

/// The pod a one-series query asks for: the first from the middle of the pods whose
/// `series_id` lies in the middle half of the id order, so its row group is not the one
/// next to the footer (which a range read could join to the footer's read).
pub fn one_pod(n: usize) -> String {
    let i = (n / 2..n).find(|i| batch::series_id(&labels(*i)).unsigned_abs() < 1 << 61).unwrap_or(n / 2);
    format!("pod-{i:07}")
}

/// One flush unit of `n` series, ten scrapes from `t0`: a samples file and a series file.
pub fn unit(n: usize, t0: i64, k0: usize) -> (EncodedFile, EncodedFile) {
    let mut batches = Vec::new();
    let mut lo = 0;
    while lo < n {
        let hi = (lo + BATCH_SERIES).min(n);
        let defs: Vec<SeriesDef> = (lo..hi).map(|i| SeriesDef::new(labels(i))).collect();
        let mut rows = Vec::with_capacity((hi - lo) * 10);
        for s in 0..10 {
            for (j, i) in (lo..hi).enumerate() {
                // A counter growing by 0 to 9 a scrape (deterministic), so files compress like counters.
                let k = (k0 + s) as u64;
                let v = (k * 4) as f64 + ((i as u64 * 2_654_435_761 + k * 40_503) % 10) as f64;
                rows.push(Row::new(j as u32, t0 + s as i64 * SCRAPE, v));
            }
        }
        batches.push(batch::encode(&defs, &rows).unwrap());
        lo = hi;
    }
    let refs: Vec<&[u8]> = batches.iter().map(|b| &b[..]).collect();
    let mut files = encode_segment(&refs).unwrap();
    let series = files.pop().unwrap();
    let samples = files.pop().unwrap();
    assert_eq!((samples.table, series.table), (Table::MetricSamples, Table::MetricSeries));
    (samples, series)
}

/// The query shapes, over `[end - span, end]` at a 60 s step.
pub struct Shape {
    pub name: &'static str,
    pub kind: Kind,
}

pub enum Kind {
    Range(String),
    LabelValues { label: &'static str, matchers: Vec<viz_query::Matcher> },
    Series(Vec<viz_query::Matcher>),
}

pub fn shapes(n: usize) -> Vec<Shape> {
    use viz_query::{MatchOp, Matcher};
    vec![
        Shape { name: "one series", kind: Kind::Range(format!("rate({METRIC}{{pod=\"{}\"}}[5m])", one_pod(n))) },
        Shape { name: "selective aggregate", kind: Kind::Range(format!("sum by (pod) (rate({METRIC}{{namespace=\"ns-03\"}}[5m]))")) },
        Shape { name: "full-metric aggregate", kind: Kind::Range(format!("sum by (job) (rate({METRIC}[5m]))")) },
        Shape { name: "label values", kind: Kind::LabelValues { label: "pod", matchers: vec![Matcher::new("__name__", MatchOp::Eq, METRIC)] } },
        Shape {
            name: "/series one",
            kind: Kind::Series(vec![Matcher::new("__name__", MatchOp::Eq, METRIC), Matcher::new("pod", MatchOp::Eq, one_pod(n))]),
        },
    ]
}

/// The query Worker's `seriesEstimate` for files of one shard (2026-11-18): the largest
/// sum of rows over files overlapping one file in time.
pub fn series_estimate(files: &[(i64, i64, u64)]) -> u64 {
    let mut most = 0;
    for f in files {
        let sum: u64 = files.iter().filter(|g| g.0 <= f.1 && g.1 >= f.0).map(|g| g.2).sum();
        most = most.max(sum);
    }
    most
}

/// The Worker's verdict before fetching (query/src/coordinator.ts with its default limits):
/// refused, one place, or split over L leaves.
pub fn verdict(decomposes: bool, scan: u64, series: u64, bytes: u64, files: usize) -> String {
    const MAX_SCAN: u64 = 3_000_000;
    const MAX_FETCH: u64 = 16 << 20;
    const MAX_FILES: usize = 2_000;
    const SPLIT_SAMPLES: u64 = 1_500_000;
    const SPLIT_SERIES: u64 = 15_000;
    if decomposes {
        if scan > SPLIT_SAMPLES || series > SPLIT_SERIES || bytes > MAX_FETCH || files > MAX_FILES {
            let l = 2u64.max(scan.div_ceil(1_500_000)).max(series.div_ceil(15_000)).min(32);
            return format!("split, {l} leaves");
        }
        return "one place".into();
    }
    if scan > MAX_SCAN {
        return "refused (max_scan_samples)".into();
    }
    if bytes > MAX_FETCH {
        return "refused (max_fetch_bytes)".into();
    }
    "one place".into()
}

/// GETs the Worker issues for a whole object: one, or one per 16 MiB above that (`MAX_PART_BYTES`).
pub fn whole_gets(size: usize) -> usize {
    size.div_ceil(16 << 20).max(1)
}

pub fn ranges_of(sel: Vec<viz_query::SelectorInfo>) -> Vec<FetchRange> {
    sel.into_iter().map(|s| FetchRange { matchers: s.matchers, min_ts: s.min_ts_ms, max_ts: s.max_ts_ms }).collect()
}
