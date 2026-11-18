//! Writes a flush file pair plus the expected checksums to `target/hyparquet-check/` so
//! that `tools/hyparquet_check.mjs` (a different Parquet implementation, in JavaScript)
//! can read the same bytes and compare. The checksums here are computed from the test's
//! own input rows, not by reading the file back.
mod common;
use common::*;
use std::collections::BTreeMap;
use viz_storage::batch::{Row, STALE_NAN_BITS};
use viz_storage::{encode_segment, Table};

#[test]
fn export_files_for_independent_reader() {
    let mut series = Vec::new();
    for m in ["http_requests_total", "up", "process_cpu_seconds_total", "näme\"quoted", "go_goroutines"] {
        for i in 0..8 {
            series.push(labels(&[("__name__", m), ("instance", &format!("host-{i}:9100")), ("job", if i % 2 == 0 { "api" } else { "db" })]));
        }
    }
    // 130,000 arrivals in two batches, shuffled by a fixed LCG, with duplicates and NaNs.
    let mut state = 0x9e3779b97f4a7c15u64;
    let mut next = || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        state >> 33
    };
    let mut batches = Vec::new();
    let mut truth: BTreeMap<(String, i64, i64), u64> = BTreeMap::new();
    for _ in 0..2 {
        let rows: Vec<Row> = (0..65_000)
            .map(|_| {
                let s = (next() % 40) as u32;
                let ts = MID + (next() % 4000) as i64 * 15_000 % 86_400_000;
                let bits = match next() % 50 {
                    0 => STALE_NAN_BITS,
                    1 => 0x7ff8_0000_0000_0001,
                    _ => ((next() % 1_000_000) as f64 / 7.0).to_bits(),
                };
                Row { series_idx: s, ts, value_bits: bits }
            })
            .collect();
        for r in &rows {
            let d = &series[r.series_idx as usize];
            truth.insert((d.labels[0].1.clone(), d.series_id, r.ts), r.value_bits);
        }
        batches.push(viz_storage::batch::encode(&series, &rows).unwrap());
    }
    let files = encode_segment(&[&batches[0], &batches[1]]).unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!((files[0].table, files[1].table), (Table::MetricSamples, Table::MetricSeries));
    assert_eq!(files[0].rows as usize, truth.len());

    let (mut sid_sum, mut ts_sum, mut xor, mut nans, mut stale, mut name_bytes) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    for ((name, sid, ts), bits) in &truth {
        sid_sum = sid_sum.wrapping_add(*sid as u64);
        ts_sum = ts_sum.wrapping_add(*ts as u64);
        name_bytes += name.len() as u64;
        if f64::from_bits(*bits).is_nan() {
            nans += 1;
            stale += (*bits == STALE_NAN_BITS) as u64;
        } else {
            xor ^= bits;
        }
    }
    let first = truth.iter().next().unwrap();
    let mut label_bytes = 0u64;
    let mut series_sid_sum = 0u64;
    let mut seen = std::collections::BTreeSet::new();
    for (name, sid, _) in truth.keys() {
        if seen.insert(*sid) {
            let d = series.iter().find(|d| d.series_id == *sid).unwrap();
            assert_eq!(&d.labels[0].1, name);
            label_bytes += viz_storage::json::labels_to_json(&d.labels).len() as u64;
            series_sid_sum = series_sid_sum.wrapping_add(*sid as u64);
        }
    }
    assert_eq!(files[1].rows as usize, seen.len());

    let expected = format!(
        "{{\"samples\":{{\"rows\":{},\"series_id_sum\":\"{}\",\"ts_sum\":\"{}\",\"value_xor\":\"{:016x}\",\"nan_count\":{},\"stale_count\":{},\"name_bytes\":{},\"first_name\":{:?},\"first_ts\":\"{}\",\"row_groups\":{}}},\"series\":{{\"rows\":{},\"series_id_sum\":\"{}\",\"label_bytes\":{}}}}}",
        truth.len(), sid_sum, ts_sum, xor, nans, stale, name_bytes, first.0 .0, first.0 .2,
        viz_storage::FileIndex::from_json(&files[0].index).unwrap().row_groups.len(),
        seen.len(), series_sid_sum, label_bytes,
    );
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("hyparquet-check");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("metric_samples.parquet"), &files[0].bytes).unwrap();
    std::fs::write(dir.join("metric_series.parquet"), &files[1].bytes).unwrap();
    std::fs::write(dir.join("expected.json"), &expected).unwrap();
    println!("hyparquet-check expected: {expected}");
}
