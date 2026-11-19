//! Files for the independent-reader check of the series-level pruning change
//! (`tools/independent_check.py`, PyArrow and DuckDB): flush files and a compaction output
//! written by this crate, their index fragments, and the rows each must hold, computed from
//! the input batches (not by reading the files back).
//!
//!   cargo run --release --example independent -- OUT_DIR
//!
//! Five metrics x 2,000 series x 30 scrapes (300,000 rows, three row groups of 100,000 in a
//! flush file), arriving in two segments that overlap (the later write wins), NaN payloads
//! and staleness markers included.
use std::collections::BTreeMap;
use std::fmt::Write as _;
use viz_storage::batch::{self, Row, SeriesDef, STALE_NAN_BITS};
use viz_storage::json::labels_to_json;
use viz_storage::{encode_segment, merge_files, EncodedFile, Table};

const T0: i64 = 1_763_467_200_000; // 2025-11-18T12:00:00Z

fn main() {
    let out = std::env::args().nth(1).expect("OUT_DIR");
    std::fs::create_dir_all(&out).unwrap();
    let mut defs = Vec::new();
    for m in ["a_total", "b_seconds", "c_bytes", "d_ratio", "e_count"] {
        for i in 0..2000 {
            defs.push(SeriesDef::new(vec![("__name__".to_string(), m.to_string()), ("job".into(), format!("j{}", i % 7)), ("pod".into(), format!("p{i:05}"))]));
        }
    }
    let value = |i: usize, k: i64, seg: u64| -> u64 {
        match (i * 31 + k as usize) % 97 {
            0 => STALE_NAN_BITS,
            1 => 0x7ff8_0000_0000_0001 + seg,
            _ => ((i as f64) * 1.5 + k as f64 + seg as f64 * 0.25).to_bits(),
        }
    };
    // Segment 0: scrapes 0..20; segment 1: scrapes 15..30 (rewrites 15..20 with other values).
    let mut truth: BTreeMap<(String, i64, i64), u64> = BTreeMap::new();
    let mut segs: Vec<Vec<Vec<u8>>> = Vec::new();
    for (seg, ks) in [(0u64, 0..20i64), (1, 15..30)] {
        let mut batches = Vec::new();
        for k in ks {
            let rows: Vec<Row> = (0..defs.len()).map(|i| Row { series_idx: i as u32, ts: T0 + k * 15_000 + (i as i64 % 5), value_bits: value(i, k, seg) }).collect();
            for (i, r) in rows.iter().enumerate() {
                let name = defs[i].labels[0].1.clone();
                truth.insert((name, defs[i].series_id, r.ts), r.value_bits);
            }
            batches.push(batch::encode(&defs, &rows).unwrap());
        }
        segs.push(batches);
    }
    let mut files: Vec<(String, EncodedFile)> = Vec::new();
    for (si, seg) in segs.iter().enumerate() {
        let refs: Vec<&[u8]> = seg.iter().map(|b| &b[..]).collect();
        for f in encode_segment(&refs).unwrap() {
            files.push((format!("seg{si}-{}", f.table.as_str()), f));
        }
    }
    for table in [Table::MetricSamples, Table::MetricSeries] {
        let ins: Vec<&[u8]> = files.iter().filter(|(_, f)| f.table == table).map(|(_, f)| &f.bytes[..]).collect();
        let m = merge_files(table, &ins).unwrap();
        files.push((format!("merged-{}", table.as_str()), m));
    }
    // Expected rows of each file, from the batches.
    let by_id: BTreeMap<i64, &SeriesDef> = defs.iter().map(|d| (d.series_id, d)).collect();
    let seg_truth = |seg: Option<usize>| -> BTreeMap<(String, i64, i64), u64> {
        let mut t = BTreeMap::new();
        for (si, (_, ks)) in [(0u64, 0..20i64), (1, 15..30)].into_iter().enumerate() {
            if seg.is_some_and(|s| s != si) {
                continue;
            }
            for k in ks {
                for (i, d) in defs.iter().enumerate() {
                    t.insert((d.labels[0].1.clone(), d.series_id, T0 + k * 15_000 + (i as i64 % 5)), value(i, k, si as u64));
                }
            }
        }
        t
    };
    for (name, f) in &files {
        std::fs::write(format!("{out}/{name}.parquet"), &f.bytes).unwrap();
        std::fs::write(format!("{out}/{name}.index.json"), &f.index).unwrap();
        let seg = if name.starts_with("seg0") { Some(0) } else if name.starts_with("seg1") { Some(1) } else { None };
        let rows = if seg.is_none() { truth.clone() } else { seg_truth(seg) };
        let mut tsv = String::new();
        match f.table {
            Table::MetricSamples => {
                for ((n, s, t), v) in &rows {
                    writeln!(tsv, "{n}\t{s}\t{t}\t{v}").unwrap();
                }
            }
            Table::MetricSeries => {
                let mut span: BTreeMap<(String, i64), (i64, i64)> = BTreeMap::new();
                for (n, s, t) in rows.keys() {
                    let e = span.entry((n.clone(), *s)).or_insert((*t, *t));
                    e.0 = e.0.min(*t);
                    e.1 = e.1.max(*t);
                }
                for ((n, s), (lo, hi)) in span {
                    writeln!(tsv, "{n}\t{s}\t{}\t{lo}\t{hi}", labels_to_json(&by_id[&s].labels)).unwrap();
                }
            }
        }
        std::fs::write(format!("{out}/{name}.rows.tsv"), tsv).unwrap();
    }
    println!("{} files in {out}", files.len());
}
