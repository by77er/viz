//! Experiment behind the series-level pruning layout (contracts/TABLES.md, DECISIONS D33):
//! how large should row groups and data pages be, and is a column index worth writing?
//!
//!   CARGO_TARGET_DIR=... cargo run --release --example layout -- [series...]
//!
//! One ten-minute flush unit of one metric `x{job, namespace, pod}` (20 namespaces, one
//! `pod` per series, counters every 60 s: 10 samples a series) is encoded under several
//! layouts. For each layout and each read shape it reports what a reader that uses the
//! index fragment would fetch (row groups `RowGroupIndex::may_hold` keeps, their byte
//! ranges plus the footer, joined when less than 64 KiB apart) and how long `select` takes
//! to decode that sparse file (median of 5, the series handed over in a carrier batch so
//! that only the sample file's decode is timed). Every layout must give identical rows
//! for every shape before anything is printed.
//!
//! Shapes: one series; a 1/20 selection scattered over the id space (`namespace="ns-03"`);
//! one part of seven of a split (a contiguous seventh of the `series_id` space); the whole
//! metric.
use std::time::Instant;
use viz_storage::batch::{self, Row, SeriesDef};
use viz_storage::{encode_segment_with, select, sparse, EncodedFile, FileIndex, MatchOp, Matcher, ScanInput, Table, WriteOptions};

const T0: i64 = 1_763_467_200_000; // 2025-11-18T12:00:00Z
const GAP: u64 = 64 << 10;

fn labels(i: usize) -> Vec<(String, String)> {
    vec![
        ("__name__".into(), "x".into()),
        ("job".into(), format!("job-{:02}", i % 10)),
        ("namespace".into(), format!("ns-{:02}", (i / 3) % 20)),
        ("pod".into(), format!("pod-{i:07}")),
    ]
}

fn batches(n: usize) -> Vec<Vec<u8>> {
    // One batch per scrape, as a shard would seal them.
    let defs: Vec<SeriesDef> = (0..n).map(|i| SeriesDef::new(labels(i))).collect();
    (0..10)
        .map(|k| {
            let rows: Vec<Row> = (0..n).map(|i| Row::new(i as u32, T0 + k * 60_000 + (i as i64 % 997), (k as f64) * 3.0 + (i % 7) as f64)).collect();
            batch::encode(&defs, &rows).unwrap()
        })
        .collect()
}

struct Shape {
    name: &'static str,
    /// Series wanted, by series_id (sorted) and their labels.
    ids: Vec<i64>,
    defs: Vec<SeriesDef>,
}

fn shapes(n: usize) -> Vec<Shape> {
    let all: Vec<(i64, Vec<(String, String)>)> = (0..n).map(|i| (batch::series_id(&labels(i)), labels(i))).collect();
    let make = |name: &'static str, keep: &dyn Fn(usize, i64) -> bool| {
        let mut v: Vec<(i64, Vec<(String, String)>)> = all.iter().enumerate().filter(|(i, (id, _))| keep(*i, *id)).map(|(_, x)| x.clone()).collect();
        v.sort_by_key(|x| x.0);
        Shape { name, ids: v.iter().map(|x| x.0).collect(), defs: v.into_iter().map(|(_, l)| SeriesDef::new(l)).collect() }
    };
    // Part 3 of 7 of the u64 key space (the split key is the series_id as u64).
    let part = |id: i64| (((id as u64) as u128 * 7) >> 64) as u32 == 3;
    vec![
        make("one series", &|i, _| i == n / 2),
        make("1/20 scattered", &|i, _| (i / 3) % 20 == 3),
        make("split part 3/7", &|_, id| part(id)),
        make("whole metric", &|_, _| true),
    ]
}

/// Inclusive sid intervals covering `ids` (sorted): one per id.
fn intervals(ids: &[i64]) -> Vec<(i64, i64)> {
    ids.iter().map(|i| (*i, *i)).collect()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let ns: Vec<usize> = std::env::args().skip(1).map(|a| a.parse().unwrap()).collect();
    let ns = if ns.is_empty() { vec![10_000, 100_000] } else { ns };
    let layouts: Vec<(&str, WriteOptions)> = vec![
        ("rg 100k, pages 20k (2026-11-18)", WriteOptions { max_row_group_rows: 100_000, page_rows: 20_000, column_index: false }),
        ("rg 100k, pages 8k", WriteOptions { max_row_group_rows: 100_000, page_rows: 8_192, column_index: false }),
        ("rg 100k, pages 4k", WriteOptions { max_row_group_rows: 100_000, page_rows: 4_096, column_index: false }),
        ("rg 100k, pages 2k", WriteOptions { max_row_group_rows: 100_000, page_rows: 2_048, column_index: false }),
        ("rg 100k, pages 1k", WriteOptions { max_row_group_rows: 100_000, page_rows: 1_024, column_index: false }),
        ("rg 100k, pages 4k, column index", WriteOptions { max_row_group_rows: 100_000, page_rows: 4_096, column_index: true }),
        ("rg 50k, pages 4k", WriteOptions { max_row_group_rows: 50_000, page_rows: 4_096, column_index: false }),
        ("rg 25k, pages 4k", WriteOptions { max_row_group_rows: 25_000, page_rows: 4_096, column_index: false }),
        ("rg 10k, pages 4k", WriteOptions { max_row_group_rows: 10_000, page_rows: 4_096, column_index: false }),
        ("rg 10k, pages 20k", WriteOptions { max_row_group_rows: 10_000, page_rows: 20_000, column_index: false }),
    ];
    for n in ns {
        let bs = batches(n);
        let refs: Vec<&[u8]> = bs.iter().map(|b| &b[..]).collect();
        let shapes = shapes(n);
        println!("\n## {n} series, one ten-minute unit ({} samples)\n", n * 10);
        println!("| layout | samples file | series file | row groups | footer region | fragment | encode ms |");
        println!("|---|---:|---:|---:|---:|---:|---:|");
        let mut results: Vec<Vec<u64>> = Vec::new(); // per shape, a checksum
        let mut rows_out: Vec<String> = Vec::new();
        for (li, (lname, opts)) in layouts.iter().enumerate() {
            let t = Instant::now();
            let files = encode_segment_with(&refs, opts).unwrap();
            let enc_ms = t.elapsed().as_secs_f64() * 1e3;
            let samples: &EncodedFile = files.iter().find(|f| f.table == Table::MetricSamples).unwrap();
            let series: &EncodedFile = files.iter().find(|f| f.table == Table::MetricSeries).unwrap();
            let idx = FileIndex::from_json(&samples.index).unwrap();
            let foot = idx.foot.unwrap();
            println!(
                "| {lname} | {:.2} MiB | {:.2} MiB | {} | {:.1} KiB | {:.1} KiB | {enc_ms:.0} |",
                samples.bytes.len() as f64 / 1048576.0,
                series.bytes.len() as f64 / 1048576.0,
                idx.row_groups.len(),
                foot.1 as f64 / 1024.0,
                samples.index.len() as f64 / 1024.0
            );
            for (si, sh) in shapes.iter().enumerate() {
                let iv = intervals(&sh.ids);
                let groups: Vec<usize> = (0..idx.row_groups.len()).filter(|g| idx.row_groups[*g].may_hold(b"x", &iv)).collect();
                let ranges = idx.byte_ranges(&groups, GAP).unwrap();
                let fetched: u64 = ranges.iter().map(|r| r.1).sum();
                let sparse_file = sparse::cut(&samples.bytes, &ranges);
                // The carrier: the shape's series at a timestamp outside the range.
                let carrier_rows: Vec<Row> = (0..sh.defs.len()).map(|i| Row::new(i as u32, 0, 0.0)).collect();
                let carrier = batch::encode(&sh.defs, &carrier_rows).unwrap();
                let input = ScanInput { series_files: vec![], sample_files: vec![&sparse_file[..]], tail_batches: vec![&carrier[..]] };
                let ms = [Matcher::new("__name__", MatchOp::Eq, "x")];
                let mut times = Vec::new();
                let mut sum = 0u64;
                for _ in 0..5 {
                    let t = Instant::now();
                    let out = select(&input, &ms, T0, T0 + 600_000).unwrap();
                    times.push(t.elapsed().as_secs_f64() * 1e3);
                    sum = out.iter().fold(0u64, |a, s| {
                        s.ts.iter().zip(&s.values).fold(a.wrapping_add(s.ts.len() as u64), |a, (t, v)| a.rotate_left(5) ^ (*t as u64) ^ v.to_bits())
                    });
                }
                if li == 0 {
                    results.push(vec![sum]);
                } else {
                    assert_eq!(results[si][0], sum, "layout {lname}, shape {}: rows differ from the first layout", sh.name);
                }
                rows_out.push(format!(
                    "| {} | {lname} | {} of {} | {} | {:.1} KiB | {:.2} |",
                    sh.name,
                    groups.len(),
                    idx.row_groups.len(),
                    ranges.len(),
                    fetched as f64 / 1024.0,
                    median(times)
                ));
            }
        }
        println!("\n| shape | layout | row groups read | range reads | bytes fetched | select ms (median of 5) |");
        println!("|---|---|---:|---:|---:|---:|");
        let mut sorted = rows_out.clone();
        sorted.sort_by(|a, b| a.split('|').nth(1).cmp(&b.split('|').nth(1)));
        for r in sorted {
            println!("{r}");
        }
        println!("\nAll {} layouts returned identical rows for all {} shapes.", layouts.len(), shapes.len());
    }
}
