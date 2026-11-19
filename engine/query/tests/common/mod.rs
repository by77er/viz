//! Shared test support: a pool of series, random write histories, the ways a history can
//! be laid out in storage, and an in-memory reference.
#![allow(dead_code)]
use proptest::prelude::*;
use viz_promql::{MemSource, Series};
use viz_storage::batch::{self, Row, SeriesDef};
use viz_storage::{encode_segment_with, merge_files_with, EncodedFile, ScanInput, Table, WriteOptions};

/// 2023-11-15T00:00:00Z. Generated data straddles it, so the lake always has two days.
pub const MID: i64 = 1_700_006_400_000;
/// First possible sample time: five minutes before midnight.
pub const T0: i64 = MID - 300_000;

pub type Labels = Vec<(String, String)>;

/// Number of proptest cases: `default`, or `VIZ_PROPTEST_CASES` when set (the mutation
/// script lowers it; a soak run raises it).
pub fn cases(default: u32) -> u32 {
    std::env::var("VIZ_PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

pub fn labels(pairs: &[(&str, &str)]) -> Labels {
    let mut l: Labels = pairs.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
    l.sort();
    l
}

pub fn stale() -> f64 {
    f64::from_bits(batch::STALE_NAN_BITS)
}

/// One acknowledged write. A later write to the same `(series, ts)` replaces an earlier one.
#[derive(Debug, Clone, PartialEq)]
pub struct Write {
    pub series: usize,
    pub ts: i64,
    pub value: f64,
}

/// A write history: the series pool and batches of writes in sequence order.
#[derive(Debug, Clone)]
pub struct History {
    pub pool: Vec<Labels>,
    pub batches: Vec<Vec<Write>>,
}

impl History {
    pub fn from_rows(rows: &[(&[(&str, &str)], i64, f64)]) -> History {
        let mut pool: Vec<Labels> = Vec::new();
        let mut writes = Vec::new();
        for (l, ts, v) in rows {
            let l = labels(l);
            let series = pool.iter().position(|p| *p == l).unwrap_or_else(|| {
                pool.push(l);
                pool.len() - 1
            });
            writes.push(Write { series, ts: *ts, value: *v });
        }
        History { pool, batches: vec![writes] }
    }

    /// Cut the single batch of a history into batches after the given row counts.
    pub fn cut(mut self, at: &[usize]) -> History {
        let all: Vec<Write> = self.batches.concat();
        let mut out = Vec::new();
        let mut prev = 0;
        for &a in at {
            out.push(all[prev..a].to_vec());
            prev = a;
        }
        out.push(all[prev..].to_vec());
        self.batches = out;
        self
    }

    /// The `VZB1` bytes of every batch (empty batches are skipped: they are never sent).
    pub fn encoded(&self) -> Vec<Vec<u8>> {
        self.batches.iter().filter(|b| !b.is_empty()).map(|b| encode_batch(&self.pool, b)).collect()
    }

    /// What the history means: per series, the last write of each timestamp, ascending.
    pub fn reference(&self) -> Vec<Series> {
        let mut maps: Vec<std::collections::BTreeMap<i64, f64>> = vec![Default::default(); self.pool.len()];
        for w in self.batches.iter().flatten() {
            maps[w.series].insert(w.ts, w.value);
        }
        self.pool
            .iter()
            .zip(maps)
            .filter(|(_, m)| !m.is_empty())
            .map(|(l, m)| Series { labels: l.clone(), ts: m.keys().copied().collect(), values: m.values().copied().collect() })
            .collect()
    }

    pub fn mem(&self) -> MemSource {
        MemSource::from_series(self.reference())
    }
}

pub fn encode_batch(pool: &[Labels], writes: &[Write]) -> Vec<u8> {
    let mut defs: Vec<SeriesDef> = Vec::new();
    let mut map: Vec<Option<u32>> = vec![None; pool.len()];
    let mut rows = Vec::with_capacity(writes.len());
    for w in writes {
        let idx = *map[w.series].get_or_insert_with(|| {
            defs.push(SeriesDef::new(pool[w.series].iter().cloned()));
            (defs.len() - 1) as u32
        });
        rows.push(Row::new(idx, w.ts, w.value));
    }
    batch::encode(&defs, &rows).expect("generated batch is valid")
}

/// Batches from series, one batch of at most `rows_per_batch` rows at a time, in time order.
pub fn series_to_batches(series: &[Series], rows_per_batch: usize) -> Vec<Vec<u8>> {
    let pool: Vec<Labels> = series.iter().map(|s| s.labels.clone()).collect();
    let mut writes: Vec<Write> = Vec::new();
    for (i, s) in series.iter().enumerate() {
        for (t, v) in s.ts.iter().zip(&s.values) {
            writes.push(Write { series: i, ts: *t, value: *v });
        }
    }
    writes.sort_by_key(|w| (w.ts, w.series));
    writes.chunks(rows_per_batch.max(1)).map(|c| encode_batch(&pool, c)).collect()
}

/// Bytes laid out in storage: what a `ScanInput` borrows from.
#[derive(Debug, Clone, Default)]
pub struct Stored {
    pub series_files: Vec<Vec<u8>>,
    pub sample_files: Vec<Vec<u8>>,
    pub tail: Vec<Vec<u8>>,
    /// The index fragments of `series_files` and `sample_files`, in the same order.
    pub series_index: Vec<String>,
    pub sample_index: Vec<String>,
}

impl Stored {
    pub fn input(&self) -> ScanInput<'_> {
        ScanInput {
            series_files: self.series_files.iter().map(|f| f.as_slice()).collect(),
            sample_files: self.sample_files.iter().map(|f| f.as_slice()).collect(),
            tail_batches: self.tail.iter().map(|f| f.as_slice()).collect(),
        }
    }

    fn add_files(&mut self, files: Vec<EncodedFile>) {
        for f in files {
            match f.table {
                Table::MetricSamples => {
                    self.sample_files.push(f.bytes);
                    self.sample_index.push(f.index);
                }
                Table::MetricSeries => {
                    self.series_files.push(f.bytes);
                    self.series_index.push(f.index);
                }
            }
        }
    }
}

/// How a history's batches are placed.
#[derive(Debug, Clone)]
pub struct Layout {
    /// Batches `[0, flushed)` are in the lake.
    pub flushed: usize,
    /// Batches `[tail_from, n)` are in the tail. `tail_from < flushed` gives duplicates.
    pub tail_from: usize,
    /// The flushed batches are cut into segments after these batch counts.
    pub segment_cuts: Vec<usize>,
    /// Rows per row group in the lake files.
    pub row_group_rows: usize,
    /// Compact each day's files into one with `merge_files`.
    pub compact: bool,
}

impl Layout {
    pub fn all_lake(n: usize) -> Layout {
        Layout { flushed: n, tail_from: n, segment_cuts: vec![], row_group_rows: 100_000, compact: false }
    }
    pub fn all_tail() -> Layout {
        Layout { flushed: 0, tail_from: 0, segment_cuts: vec![], row_group_rows: 100_000, compact: false }
    }
}

pub fn store(batches: &[Vec<u8>], layout: &Layout) -> Stored {
    let n = batches.len();
    let flushed = layout.flushed.min(n);
    let mut out = Stored::default();
    let opts = WriteOptions { max_row_group_rows: layout.row_group_rows, ..Default::default() };
    let mut cuts: Vec<usize> = layout.segment_cuts.iter().copied().filter(|c| *c > 0 && *c < flushed).collect();
    cuts.sort_unstable();
    cuts.dedup();
    cuts.push(flushed);
    let mut prev = 0;
    let mut files: Vec<EncodedFile> = Vec::new();
    for c in cuts {
        let seg: Vec<&[u8]> = batches[prev..c].iter().map(|b| b.as_slice()).collect();
        prev = c;
        if !seg.is_empty() {
            files.extend(encode_segment_with(&seg, &opts).expect("flush"));
        }
    }
    if layout.compact {
        let mut days: Vec<String> = files.iter().map(|f| f.day.clone()).collect();
        days.sort();
        days.dedup();
        let mut merged = Vec::new();
        for d in days {
            for table in [Table::MetricSamples, Table::MetricSeries] {
                let ins: Vec<&[u8]> = files.iter().filter(|f| f.day == d && f.table == table).map(|f| f.bytes.as_slice()).collect();
                merged.push(merge_files_with(table, &ins, &opts).expect("merge"));
            }
        }
        files = merged;
    }
    out.add_files(files);
    out.tail = batches[layout.tail_from.min(n)..].to_vec();
    out
}

// ---------------------------------------------------------------- generators

fn value_strategy() -> impl Strategy<Value = f64> {
    prop_oneof![
        8 => (0i32..12).prop_map(|v| v as f64),
        3 => (-500i32..500).prop_map(|v| v as f64 / 7.0),
        1 => Just(f64::NAN),
        2 => Just(stale()),
        1 => Just(0.0),
    ]
}

/// The series pool: gauges `m`, counters `n`, a classic histogram `h_bucket` in two jobs.
pub fn pool() -> Vec<(Labels, bool)> {
    let mut p = Vec::new();
    for (job, inst) in [("x", "0"), ("x", "1"), ("y", "0"), ("y", "2")] {
        p.push((labels(&[("__name__", "m"), ("job", job), ("inst", inst)]), false));
        p.push((labels(&[("__name__", "n"), ("job", job), ("inst", inst)]), true));
    }
    p.push((labels(&[("__name__", "n"), ("job", "x"), ("inst", "0"), ("extra", "e")]), true));
    for job in ["x", "y"] {
        for le in ["0.1", "1", "5", "+Inf"] {
            p.push((labels(&[("__name__", "h_bucket"), ("job", job), ("le", le)]), true));
        }
    }
    p
}

/// A random write history: irregular spacing (1 s to 70 s) from five minutes before
/// midnight, NaNs, staleness markers, counter resets, some timestamps written twice with
/// different values, arrival roughly in time order, cut into 1 to 7 batches.
pub fn history_strategy() -> impl Strategy<Value = History> {
    let pool = pool();
    let n = pool.len();
    let per_series = proptest::collection::vec(proptest::collection::vec((1_000i64..70_000, value_strategy(), 0u8..10), 0..30), n);
    let rewrites = proptest::collection::vec((any::<prop::sample::Index>(), value_strategy(), any::<prop::sample::Index>()), 0..12);
    let jitter = proptest::collection::vec(0i64..40_000, 0..64);
    let cuts = proptest::collection::vec(any::<prop::sample::Index>(), 0..6);
    (per_series, rewrites, jitter, cuts).prop_map(move |(per_series, rewrites, jitter, cuts)| {
        let mut writes: Vec<(i64, Write)> = Vec::new();
        for (si, pts) in per_series.into_iter().enumerate() {
            let counter = pool[si].1;
            let (mut t, mut acc) = (T0, 0.0);
            for (gap, v, reset) in pts {
                t += gap;
                let value = if counter && !v.is_nan() {
                    if reset == 0 {
                        acc = 0.0;
                    }
                    acc += v.abs();
                    acc
                } else {
                    v
                };
                // Arrival order is time order with some jitter, as from concurrent senders.
                let j = jitter.get(writes.len() % jitter.len().max(1)).copied().unwrap_or(0);
                writes.push((t + j, Write { series: si, ts: t, value }));
            }
        }
        writes.sort_by_key(|(k, w)| (*k, w.series));
        let mut writes: Vec<Write> = writes.into_iter().map(|(_, w)| w).collect();
        if !writes.is_empty() {
            for (which, v, at) in rewrites {
                let old = writes[which.index(writes.len())].clone();
                let pos = at.index(writes.len() + 1);
                writes.insert(pos, Write { value: v, ..old });
            }
        }
        let mut at: Vec<usize> = cuts.iter().map(|c| c.index(writes.len() + 1)).collect();
        at.sort_unstable();
        let pool: Vec<Labels> = pool.iter().map(|(l, _)| l.clone()).collect();
        History { pool, batches: vec![writes] }.cut(&at)
    })
}

pub fn layout_strategy() -> impl Strategy<Value = Layout> {
    (0usize..8, 0usize..8, proptest::collection::vec(1usize..7, 0..4), prop_oneof![1usize..7, Just(100_000usize)], any::<bool>()).prop_map(
        |(flushed, back, segment_cuts, row_group_rows, compact)| Layout {
            flushed,
            tail_from: flushed.saturating_sub(back % 4),
            segment_cuts,
            row_group_rows,
            compact,
        },
    )
}

/// At least 60 PromQL queries: selectors, range functions, aggregations, binary
/// operators, offset and `@`, subqueries, `histogram_quantile`, and a few that must fail.
pub const QUERIES: &[&str] = &[
    // selectors
    "m",
    r#"m{job="x"}"#,
    r#"m{inst=~"0|1"}"#,
    r#"m{inst!~"0|1"}"#,
    r#"m{job!="x"}"#,
    r#"{__name__=~"m|n", job!="y"}"#,
    r#"{__name__="n", extra=""}"#,
    r#"{__name__=~".+", le=""}"#,
    // offset and @
    "m offset 30s",
    "m offset -45s",
    "m @ 1700006400",
    "m @ 1700006395.5 offset 20s",
    "m @ start()",
    "n @ end() offset 1m",
    "rate(n[1m] @ 1700006460)",
    "sum_over_time(m[90s] @ end())",
    // range functions
    "rate(n[1m])",
    "rate(n[90s] offset 20s)",
    "increase(n[2m])",
    "delta(m[1m])",
    "irate(n[1m])",
    "idelta(m[1m])",
    "resets(n[2m])",
    "changes(m[2m])",
    "deriv(m[2m])",
    "predict_linear(m[2m], 60)",
    "avg_over_time(m[1m])",
    "sum_over_time(m[1m])",
    "min_over_time(m[1m])",
    "max_over_time(m[1m])",
    "count_over_time(m[1m])",
    "last_over_time(m[1m])",
    "first_over_time(m[1m])",
    "stddev_over_time(m[1m])",
    "stdvar_over_time(m[1m])",
    "quantile_over_time(0.7, m[1m])",
    "present_over_time(m[1m])",
    "absent_over_time(m[20s])",
    r#"absent(m{job="x", inst="0"})"#,
    "timestamp(m)",
    "timestamp(m offset 30s)",
    // aggregations
    "sum(m)",
    "sum by (job) (m)",
    "sum without (inst) (m)",
    "avg by (job) (m)",
    "min by (inst) (m)",
    "max(m)",
    "count by (job) (m)",
    "group by (job) (m)",
    "stddev by (job) (m)",
    "stdvar(m)",
    "quantile by (job) (0.3, m)",
    "topk(2, m)",
    "bottomk by (job) (1, m)",
    r#"count_values("v", m)"#,
    "sum by (job) (rate(n[1m]))",
    "sum(rate(n[1m])) by (job) > 0.01",
    // binary operators
    "m + n",
    "m - on(job, inst) n",
    "m / ignoring(extra) n",
    "m * on(job) group_left sum by (job) (n)",
    "sum by (job) (n) + on(job) group_right m",
    "m < n",
    "m > bool n",
    "m == 3",
    "2 < bool m",
    "m and n",
    "m or n",
    "m unless n",
    "m and on(job) n",
    "m % 3 ^ 2",
    "-m",
    "rate(m[1m]) / rate(n[1m])",
    "m * scalar(count(n))",
    "1 + 2 * 3",
    // functions
    "abs(m - 5)",
    "ceil(m / 3)",
    "round(m, 5)",
    "clamp(m, 2, 6)",
    "exp(m / 10)",
    "ln(m)",
    "sqrt(m)",
    "sgn(m - 4)",
    "scalar(sum(m))",
    "vector(time())",
    "time()",
    r#"label_replace(m, "dst", "$1-x", "job", "(.*)")"#,
    r#"label_join(m, "dst", "/", "job", "inst")"#,
    "sort_desc(m)",
    "day_of_week()",
    "hour(vector(time()))",
    // histogram_quantile
    "histogram_quantile(0.5, sum by (le) (h_bucket))",
    "histogram_quantile(0.9, rate(h_bucket[2m]))",
    "histogram_quantile(0.99, sum by (job, le) (rate(h_bucket[90s])))",
    r#"histogram_quantile(0.5, h_bucket{job="x"} offset 30s)"#,
    // subqueries
    "max_over_time(rate(n[1m])[3m:30s])",
    "sum_over_time(m[2m:45s] offset 15s)",
    "avg_over_time(sum by (job) (m)[90s:20s])",
    "min_over_time(m[2m:])",
    "max_over_time(sum(rate(n[45s]))[2m:15s] @ end())",
    "rate(sum_over_time(n[30s])[2m:10s])",
    "quantile_over_time(0.5, (m + on(job, inst) n)[100s:25s] offset -30s)",
    // errors must be the same errors
    "m + on(job) n",
    "sum(m) by (job) / on(job) group_left m",
    "limitk(1, m)",
    "m +",
];
