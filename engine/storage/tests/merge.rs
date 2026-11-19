mod common;
use common::*;
use proptest::prelude::*;
use std::collections::BTreeMap;
use viz_storage::{encode_segment, encode_segment_with, merge_files, merge_files_with, Error, FileIndex, Table, WriteOptions};

/// Write a `metric_samples` file with the parquet crate directly, default settings
/// (v1 pages, PLAIN/dictionary, no snappy), rows exactly as given.
fn raw_samples(rows: &[(&str, i64, i64, f64)]) -> Vec<u8> {
    use parquet::column::writer::ColumnWriter;
    use parquet::data_type::ByteArray;
    use parquet::file::writer::SerializedFileWriter;
    use parquet::schema::parser::parse_message_type;
    let schema = std::sync::Arc::new(
        parse_message_type("message schema { required binary metric_name (UTF8); required int64 series_id; required int64 ts; required double value; }").unwrap(),
    );
    let mut w = SerializedFileWriter::new(Vec::new(), schema, Default::default()).unwrap();
    let mut rg = w.next_row_group().unwrap();
    let mut col = 0;
    while let Some(mut cw) = rg.next_column().unwrap() {
        match cw.untyped() {
            ColumnWriter::ByteArrayColumnWriter(c) => {
                c.write_batch(&rows.iter().map(|r| ByteArray::from(r.0)).collect::<Vec<_>>(), None, None).unwrap();
            }
            ColumnWriter::Int64ColumnWriter(c) => {
                c.write_batch(&rows.iter().map(|r| if col == 1 { r.1 } else { r.2 }).collect::<Vec<_>>(), None, None).unwrap();
            }
            ColumnWriter::DoubleColumnWriter(c) => {
                c.write_batch(&rows.iter().map(|r| r.3).collect::<Vec<_>>(), None, None).unwrap();
            }
            _ => unreachable!(),
        }
        cw.close().unwrap();
        col += 1;
    }
    rg.close().unwrap();
    w.finish().unwrap();
    std::mem::take(w.inner_mut())
}

#[test]
fn later_input_wins_and_output_is_sorted() {
    let a = raw_samples(&[("a", 1, MID, 1.0), ("a", 1, MID + 1, 1.0), ("b", 2, MID, 1.0)]);
    let b = raw_samples(&[("a", 1, MID + 1, 2.0), ("a", 3, MID, 2.0), ("b", 2, MID, 2.0), ("b", 2, MID, 2.5)]);
    let c = raw_samples(&[("a", 0, MID + 7, 3.0), ("b", 2, MID, 3.0)]);
    let rows = |f: &viz_storage::EncodedFile| read_samples(&f.bytes).into_iter().map(|r| (r.0, r.1, r.2 - MID, f64::from_bits(r.3))).collect::<Vec<_>>();
    let s = |n: &str| n.to_string();

    let out = merge_files(Table::MetricSamples, &[&a, &b, &c]).unwrap();
    assert_eq!(rows(&out), vec![(s("a"), 0, 7, 3.0), (s("a"), 1, 0, 1.0), (s("a"), 1, 1, 2.0), (s("a"), 3, 0, 2.0), (s("b"), 2, 0, 3.0)]);
    assert_eq!((out.table, out.day.as_str(), out.rows, out.min_ts, out.max_ts), (Table::MetricSamples, DAY1, 5, MID, MID + 7));

    let out = merge_files(Table::MetricSamples, &[&c, &b, &a]).unwrap();
    assert_eq!(rows(&out), vec![(s("a"), 0, 7, 3.0), (s("a"), 1, 0, 1.0), (s("a"), 1, 1, 1.0), (s("a"), 3, 0, 2.0), (s("b"), 2, 0, 1.0)]);

    // Within one input the later row wins.
    let out = merge_files(Table::MetricSamples, &[&b]).unwrap();
    assert_eq!(rows(&out), vec![(s("a"), 1, 1, 2.0), (s("a"), 3, 0, 2.0), (s("b"), 2, 0, 2.5)]);
}

#[test]
fn merge_errors() {
    let ok = raw_samples(&[("a", 1, MID, 1.0)]);
    let other_day = raw_samples(&[("a", 1, MID - 1, 1.0)]);
    assert_eq!(merge_files(Table::MetricSamples, &[&ok, &other_day]).unwrap_err(), Error::MixedDays { first: DAY0.into(), other: DAY1.into() });
    for (bad, row) in [
        (raw_samples(&[("b", 1, MID, 1.0), ("a", 1, MID, 1.0)]), 1),
        (raw_samples(&[("a", 1, MID, 1.0), ("a", 2, MID, 1.0), ("a", 1, MID + 1, 1.0)]), 2),
        (raw_samples(&[("a", 1, MID + 1, 1.0), ("a", 1, MID, 1.0)]), 1),
    ] {
        assert_eq!(merge_files(Table::MetricSamples, &[&ok, &bad]).unwrap_err(), Error::Unsorted { index: 1, row });
    }
    assert_eq!(merge_files(Table::MetricSamples, &[]).unwrap_err(), Error::Empty);
    assert_eq!(merge_files(Table::MetricSeries, &[]).unwrap_err(), Error::Empty);
    assert_eq!(merge_files(Table::MetricSamples, &[&raw_samples(&[])]).unwrap_err(), Error::Empty);
    assert!(matches!(merge_files(Table::MetricSamples, &[&ok, b"junk"]), Err(Error::Parquet { index: Some(1), .. })));
    assert!(matches!(merge_files(Table::MetricSeries, &[&ok]), Err(Error::Schema { index: 0, .. })));
}

#[test]
fn series_merge_unions_ranges_and_takes_later_labels() {
    let up: &[(&str, &str)] = &[("__name__", "up")];
    let cpu: &[(&str, &str)] = &[("__name__", "cpu"), ("job", "j")];
    let f = |rows: &[(&[(&str, &str)], i64, f64)]| encode_segment(&[&batch_of(rows).bytes()]).unwrap().remove(1).bytes;
    let a = f(&[(up, MID + 10, 1.0), (up, MID + 20, 1.0)]);
    let b = f(&[(up, MID + 5, 1.0), (cpu, MID + 30, 1.0)]);
    let c = f(&[(up, MID + 15, 1.0), (cpu, MID + 40, 1.0)]);
    let out = merge_files(Table::MetricSeries, &[&a, &b, &c]).unwrap();
    let rows: Vec<(String, i64, i64)> = read_series(&out.bytes).into_iter().map(|r| (r.2, r.3 - MID, r.4 - MID)).collect();
    assert_eq!(rows, vec![(r#"{"__name__":"cpu","job":"j"}"#.to_string(), 30, 40), (r#"{"__name__":"up"}"#.to_string(), 5, 20)]);
    assert_eq!((out.rows, out.min_ts, out.max_ts, out.day.as_str()), (2, MID + 5, MID + 40, DAY1));
    let other_day = f(&[(up, MID - 5, 1.0)]);
    assert!(matches!(merge_files(Table::MetricSeries, &[&a, &other_day]), Err(Error::MixedDays { .. })));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    /// Flush batches one segment each, merge each day's files: the result is exactly the
    /// de-duplicated union (later wins), in sort order, at any row-group size, and equals
    /// what one flush of all the batches would have written.
    #[test]
    fn merge_is_the_deduplicated_union(batches in arb_batches(6), cap_in in 1usize..6, cap_out in 1usize..6, groups in proptest::collection::vec(any::<bool>(), 6)) {
        let bytes: Vec<Vec<u8>> = batches.iter().map(|b| b.bytes()).collect();
        let mut by_day: BTreeMap<String, (Vec<Vec<u8>>, Vec<Vec<u8>>)> = BTreeMap::new();
        let mut seg: Vec<&[u8]> = Vec::new();
        for (i, b) in bytes.iter().enumerate() {
            seg.push(b);
            if groups[i] || i + 1 == bytes.len() {
                for f in encode_segment_with(&seg, &WriteOptions { max_row_group_rows: cap_in }).unwrap() {
                    let e = by_day.entry(f.day.clone()).or_default();
                    match f.table { Table::MetricSamples => e.0.push(f.bytes), Table::MetricSeries => e.1.push(f.bytes) }
                }
                seg.clear();
            }
        }
        let all: Vec<&[u8]> = bytes.iter().map(|b| b.as_slice()).collect();
        let single = encode_segment(&all).unwrap();
        let want = reference_samples(&batches);
        prop_assert_eq!(by_day.len(), want.len());
        for (((day, (samples, series)), (day_no, want_rows)), one) in by_day.iter().zip(&want).zip(single.chunks(2)) {
            prop_assert_eq!(day, &viz_storage::day::format_day(*day_no));
            let opts = WriteOptions { max_row_group_rows: cap_out };
            let s: Vec<&[u8]> = samples.iter().map(|v| v.as_slice()).collect();
            let out = merge_files_with(Table::MetricSamples, &s, &opts).unwrap();
            let got = read_samples(&out.bytes);
            prop_assert_eq!(&got, want_rows);
            prop_assert_eq!(&out.day, day);
            prop_assert_eq!(out.rows as usize, got.len());
            prop_assert_eq!(out.min_ts, got.iter().map(|r| r.2).min().unwrap());
            prop_assert_eq!(out.max_ts, got.iter().map(|r| r.2).max().unwrap());
            let ix = FileIndex::from_json(&out.index).unwrap();
            prop_assert!(ix.row_groups.iter().all(|g| g.rows as usize <= cap_out));
            prop_assert_eq!(ix.row_groups.iter().map(|g| g.rows).sum::<u64>(), out.rows);
            // Index fragment agrees with the rows in each group.
            let mut at = 0;
            for g in &ix.row_groups {
                let rows = &got[at..at + g.rows as usize];
                at += rows.len();
                prop_assert_eq!(g.min_name.as_str(), rows[0].0.as_str());
                prop_assert_eq!(g.max_name.as_str(), rows[rows.len() - 1].0.as_str());
                prop_assert_eq!(g.min_ts, rows.iter().map(|r| r.2).min().unwrap());
                prop_assert_eq!(g.max_ts, rows.iter().map(|r| r.2).max().unwrap());
            }
            // Merging again changes nothing (idempotent), and with default options the
            // merged file is byte-identical to a single flush of everything.
            let again = merge_files_with(Table::MetricSamples, &[&out.bytes], &opts).unwrap();
            prop_assert_eq!(&again, &out);
            prop_assert_eq!(&merge_files(Table::MetricSamples, &s).unwrap(), &one[0]);

            let r: Vec<&[u8]> = series.iter().map(|v| v.as_slice()).collect();
            let merged_series = merge_files(Table::MetricSeries, &r).unwrap();
            prop_assert_eq!(&merged_series, &one[1]);
            prop_assert_eq!(read_series(&merge_files_with(Table::MetricSeries, &r, &opts).unwrap().bytes), read_series(&one[1].bytes));
        }
    }
}
