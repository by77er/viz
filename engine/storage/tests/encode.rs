mod common;
use common::*;
use parquet::basic::{Compression, ConvertedType, Encoding, Repetition, Type as PhysicalType};
use parquet::column::page::Page;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::file::statistics::Statistics;
use proptest::prelude::*;
use viz_storage::batch::{Row, SeriesDef, STALE_NAN_BITS};
use viz_storage::{encode_segment, encode_segment_with, EncodedFile, Error, FileIndex, Table, WriteOptions, MAX_ROW_GROUP_ROWS};

fn open(bytes: &[u8]) -> SerializedFileReader<bytes::Bytes> {
    SerializedFileReader::new(bytes::Bytes::copy_from_slice(bytes)).unwrap()
}

fn i64_stats(s: Option<&Statistics>) -> (i64, i64) {
    match s {
        Some(Statistics::Int64(s)) => (*s.min_opt().unwrap(), *s.max_opt().unwrap()),
        other => panic!("no int64 statistics: {other:?}"),
    }
}
fn str_stats(s: Option<&Statistics>) -> (String, String) {
    match s {
        Some(Statistics::ByteArray(s)) => {
            assert!(s.min_is_exact() && s.max_is_exact());
            (s.min_opt().unwrap().as_utf8().unwrap().to_string(), s.max_opt().unwrap().as_utf8().unwrap().to_string())
        }
        other => panic!("no byte array statistics: {other:?}"),
    }
}

/// Everything TABLES.md says about a file that can be checked from the outside, plus
/// the index fragment against the real footer. Returns the number of row groups.
fn check_file(f: &EncodedFile, cap: usize) -> usize {
    let r = open(&f.bytes);
    let md = r.metadata();
    let schema = md.file_metadata().schema_descr();
    let want: &[(&str, PhysicalType)] = match f.table {
        Table::MetricSamples => {
            &[("metric_name", PhysicalType::BYTE_ARRAY), ("series_id", PhysicalType::INT64), ("ts", PhysicalType::INT64), ("value", PhysicalType::DOUBLE)]
        }
        Table::MetricSeries => &[
            ("metric_name", PhysicalType::BYTE_ARRAY),
            ("series_id", PhysicalType::INT64),
            ("labels", PhysicalType::BYTE_ARRAY),
            ("min_ts", PhysicalType::INT64),
            ("max_ts", PhysicalType::INT64),
        ],
    };
    assert_eq!(schema.num_columns(), want.len());
    for (i, (name, t)) in want.iter().enumerate() {
        let c = schema.column(i);
        assert_eq!((c.name(), c.physical_type()), (*name, *t));
        assert_eq!(c.self_type().get_basic_info().repetition(), Repetition::REQUIRED);
        if *t == PhysicalType::BYTE_ARRAY {
            assert_eq!(c.converted_type(), ConvertedType::UTF8);
        }
    }
    assert_eq!(md.file_metadata().num_rows() as u64, f.rows);

    let index = FileIndex::from_json(&f.index).unwrap();
    assert_eq!(index.to_json(), f.index, "index JSON is canonical");
    assert_eq!(index.row_groups.len(), md.num_row_groups());
    let (ts_lo_col, ts_hi_col) = match f.table {
        Table::MetricSamples => (2, 2),
        Table::MetricSeries => (3, 4),
    };
    let (mut file_min, mut file_max, mut rows) = (i64::MAX, i64::MIN, 0u64);
    for (g, ix) in index.row_groups.iter().enumerate() {
        let rg = md.row_group(g);
        assert!(rg.num_rows() as usize <= cap, "row group {g} has {} rows", rg.num_rows());
        assert!(rg.num_rows() > 0);
        let sorting: Vec<(i32, bool)> = rg.sorting_columns().expect("sorting columns declared").iter().map(|c| (c.column_idx, c.descending)).collect();
        assert_eq!(sorting, match f.table {
            Table::MetricSamples => vec![(0, false), (1, false), (2, false)],
            Table::MetricSeries => vec![(0, false), (1, false)],
        });
        assert_eq!(ix.rows, rg.num_rows() as u64);
        // Offsets: the fragment must point at exactly the bytes of this row group's chunks.
        let start = rg.columns().iter().map(|c| c.byte_range().0).min().unwrap();
        let len: u64 = rg.columns().iter().map(|c| c.byte_range().1).sum();
        assert_eq!((ix.offset, ix.length), (start, len));
        assert_eq!(len, rg.compressed_size() as u64);
        let mut at = start;
        for c in rg.columns() {
            assert_eq!(c.byte_range().0, at, "column chunks are contiguous");
            at += c.byte_range().1;
            assert_eq!(c.compression(), Compression::SNAPPY);
        }
        assert_eq!((ix.min_name.clone(), ix.max_name.clone()), str_stats(rg.column(0).statistics()));
        assert_eq!(ix.min_ts, i64_stats(rg.column(ts_lo_col).statistics()).0);
        assert_eq!(ix.max_ts, i64_stats(rg.column(ts_hi_col).statistics()).1);
        file_min = file_min.min(ix.min_ts);
        file_max = file_max.max(ix.max_ts);
        rows += ix.rows;

        // Encodings.
        let enc = |c: usize| rg.column(c).encodings().collect::<Vec<_>>();
        assert!(enc(0).contains(&Encoding::RLE_DICTIONARY), "metric_name: {:?}", enc(0));
        assert!(rg.column(0).dictionary_page_offset().is_some());
        assert!(enc(1).contains(&Encoding::DELTA_BINARY_PACKED) && !enc(1).contains(&Encoding::PLAIN), "{:?}", enc(1));
        match f.table {
            Table::MetricSamples => {
                assert!(enc(2).contains(&Encoding::DELTA_BINARY_PACKED) && !enc(2).contains(&Encoding::PLAIN));
                assert!(enc(3).contains(&Encoding::BYTE_STREAM_SPLIT) && !enc(3).contains(&Encoding::PLAIN), "{:?}", enc(3));
            }
            Table::MetricSeries => {
                assert!(enc(3).contains(&Encoding::DELTA_BINARY_PACKED) && enc(4).contains(&Encoding::DELTA_BINARY_PACKED));
            }
        }
        // Format v2 data pages.
        let rgr = r.get_row_group(g).unwrap();
        for c in 0..want.len() {
            for page in rgr.get_column_page_reader(c).unwrap() {
                match page.unwrap() {
                    Page::DataPageV2 { .. } | Page::DictionaryPage { .. } => {}
                    Page::DataPage { .. } => panic!("v1 data page in column {c}"),
                }
            }
        }
    }
    assert_eq!((rows, file_min, file_max), (f.rows, f.min_ts, f.max_ts));
    assert_eq!(viz_storage::day::day_string(f.min_ts), f.day);
    assert_eq!(viz_storage::day::day_string(f.max_ts), f.day);

    // Data: sort order, uniqueness, and statistics that bound the data exactly.
    let mut g_start = 0usize;
    match f.table {
        Table::MetricSamples => {
            let data = read_samples(&f.bytes);
            assert_eq!(data.len() as u64, f.rows);
            for w in data.windows(2) {
                assert!((w[0].0.as_bytes(), w[0].1, w[0].2) < (w[1].0.as_bytes(), w[1].1, w[1].2), "sorted and unique: {:?} {:?}", w[0], w[1]);
            }
            let mut seen = std::collections::HashSet::new();
            assert!(data.iter().all(|r| seen.insert((r.1, r.2))), "(series_id, ts) unique");
            for g in 0..md.num_row_groups() {
                let rg = md.row_group(g);
                let rows = &data[g_start..g_start + rg.num_rows() as usize];
                g_start += rows.len();
                let (nlo, nhi) = str_stats(rg.column(0).statistics());
                assert_eq!(nlo.as_bytes(), rows.iter().map(|r| r.0.as_bytes()).min().unwrap());
                assert_eq!(nhi.as_bytes(), rows.iter().map(|r| r.0.as_bytes()).max().unwrap());
                assert_eq!(i64_stats(rg.column(1).statistics()), (rows.iter().map(|r| r.1).min().unwrap(), rows.iter().map(|r| r.1).max().unwrap()));
                assert_eq!(i64_stats(rg.column(2).statistics()), (rows.iter().map(|r| r.2).min().unwrap(), rows.iter().map(|r| r.2).max().unwrap()));
                if let Some(Statistics::Double(s)) = rg.column(3).statistics() {
                    if let (Some(lo), Some(hi)) = (s.min_opt(), s.max_opt()) {
                        for v in rows.iter().map(|r| f64::from_bits(r.3)).filter(|v| !v.is_nan()) {
                            assert!(*lo <= v && v <= *hi, "value {v} outside [{lo}, {hi}]");
                        }
                    }
                }
            }
        }
        Table::MetricSeries => {
            let data = read_series(&f.bytes);
            assert_eq!(data.len() as u64, f.rows);
            for w in data.windows(2) {
                assert!((w[0].0.as_bytes(), w[0].1) < (w[1].0.as_bytes(), w[1].1), "sorted and unique");
            }
            for g in 0..md.num_row_groups() {
                let rg = md.row_group(g);
                let rows = &data[g_start..g_start + rg.num_rows() as usize];
                g_start += rows.len();
                let (nlo, nhi) = str_stats(rg.column(0).statistics());
                assert_eq!((nlo.as_str(), nhi.as_str()), (rows[0].0.as_str(), rows[rows.len() - 1].0.as_str()));
                assert_eq!(i64_stats(rg.column(3).statistics()).0, rows.iter().map(|r| r.3).min().unwrap());
                assert_eq!(i64_stats(rg.column(4).statistics()).1, rows.iter().map(|r| r.4).max().unwrap());
            }
            for r in &data {
                assert!(r.3 <= r.4);
                let l = viz_storage::json::parse_labels(&r.2).unwrap();
                assert_eq!(viz_storage::json::labels_to_json(&l), r.2, "labels JSON is canonical");
                assert_eq!(l.iter().find(|(n, _)| n == "__name__").unwrap().1, r.0);
                assert_eq!(viz_storage::batch::series_id(&l), r.1);
            }
        }
    }
    md.num_row_groups()
}

#[test]
fn empty_input_gives_no_files() {
    assert_eq!(encode_segment(&[]).unwrap(), vec![]);
    let empty = viz_storage::batch::encode(&[], &[]).unwrap();
    assert_eq!(encode_segment(&[&empty, &empty]).unwrap(), vec![]);
}

#[test]
fn bad_batch_is_reported_with_its_position() {
    let good = batch_of(&[(&[("__name__", "up")], MID, 1.0)]).bytes();
    match encode_segment(&[&good, b"nope"]) {
        Err(Error::Batch { index: 1, error: viz_storage::BatchError::BadMagic }) => {}
        other => panic!("{other:?}"),
    }
}

#[test]
fn row_group_cap_and_file_properties_at_scale() {
    // 250,001 samples in one day: 5 metrics x 10 series, written in reverse arrival order.
    let mut series = Vec::new();
    for m in ["zeta", "alpha", "mid", "Beta", "alpha_total"] {
        for i in 0..10 {
            series.push(labels(&[("__name__", m), ("instance", &format!("i{i}")), ("job", "j")]));
        }
    }
    let n = 250_001usize;
    let rows: Vec<Row> = (0..n).rev().map(|k| Row::new((k % 50) as u32, MID + (k / 50) as i64 * 10, k as f64 * 0.5)).collect();
    let bytes = viz_storage::batch::encode(&series, &rows).unwrap();
    let files = encode_segment(&[&bytes]).unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!((files[0].table, files[1].table), (Table::MetricSamples, Table::MetricSeries));
    assert_eq!(files[0].rows, n as u64);
    assert_eq!(files[1].rows, 50);
    assert_eq!(check_file(&files[0], MAX_ROW_GROUP_ROWS), 3);
    assert_eq!(check_file(&files[1], MAX_ROW_GROUP_ROWS), 1);
    let ix = FileIndex::from_json(&files[0].index).unwrap();
    assert_eq!(ix.row_groups.iter().map(|g| g.rows).collect::<Vec<_>>(), vec![100_000, 100_000, 50_001]);
    assert_eq!(ix.row_groups[0].min_name, "Beta"); // byte order: uppercase first
    assert_eq!(ix.row_groups[2].max_name, "zeta");
    println!("250,001 samples -> {} bytes samples, {} bytes series", files[0].bytes.len(), files[1].bytes.len());
}

#[test]
fn splits_days_at_utc_midnight() {
    let up: &[(&str, &str)] = &[("__name__", "up")];
    let b = batch_of(&[(up, MID, 2.0), (up, MID - 1, 1.0), (up, MID + 86_400_000, 3.0), (up, MID + 86_399_999, 2.5), (up, 86_399_999, 0.1), (up, 0, 0.2), (up, 253_402_300_799_999, 0.3)]);
    let files = encode_segment(&[&b.bytes()]).unwrap();
    let got: Vec<(Table, &str, u64, i64, i64)> = files.iter().map(|f| (f.table, f.day.as_str(), f.rows, f.min_ts, f.max_ts)).collect();
    let (s, m) = (Table::MetricSamples, Table::MetricSeries);
    assert_eq!(
        got,
        vec![
            (s, "1970-01-01", 2, 0, 86_399_999),
            (m, "1970-01-01", 1, 0, 86_399_999),
            (s, DAY0, 1, MID - 1, MID - 1),
            (m, DAY0, 1, MID - 1, MID - 1),
            (s, DAY1, 2, MID, MID + 86_399_999),
            (m, DAY1, 1, MID, MID + 86_399_999),
            (s, "2023-11-16", 1, MID + 86_400_000, MID + 86_400_000),
            (m, "2023-11-16", 1, MID + 86_400_000, MID + 86_400_000),
            (s, "9999-12-31", 1, 253_402_300_799_999, 253_402_300_799_999),
            (m, "9999-12-31", 1, 253_402_300_799_999, 253_402_300_799_999),
        ]
    );
    for f in &files {
        check_file(f, MAX_ROW_GROUP_ROWS);
    }
    // The series row carries the per-file (per-day) time range.
    assert_eq!(read_series(&files[5].bytes)[0].3, MID);
    assert_eq!(read_series(&files[5].bytes)[0].4, MID + 86_399_999);
}

#[test]
fn day_strings() {
    use viz_storage::day::{day_string, format_day};
    assert_eq!(format_day(0), "1970-01-01");
    assert_eq!(format_day(11_016), "2000-02-29");
    assert_eq!(format_day(19_782), "2024-02-29");
    assert_eq!(format_day(19_783), "2024-03-01");
    assert_eq!(format_day(-1), "1969-12-31");
    assert_eq!(format_day(-719_528), "0000-01-01");
    assert_eq!(day_string(1_700_000_000_000), DAY0);
    assert_eq!(day_string(253_402_300_799_999), "9999-12-31");
    // Flooring, not truncation, below the epoch (no batch can carry such a timestamp any
    // more, but the function is public and must not be wrong there).
    assert_eq!(day_string(-1), "1969-12-31");
    assert_eq!(day_string(-86_400_000), "1969-12-31");
    assert_eq!(day_string(-86_400_001), "1969-12-30");
    // Out of the four-digit range: still a string, never a panic.
    assert_eq!(day_string(253_402_300_800_000), "+10000-01-01");
    assert!(day_string(i64::MIN).starts_with('-'));
    assert!(day_string(i64::MAX).starts_with('+'));
}

#[test]
fn later_batch_wins_on_duplicates() {
    let up: &[(&str, &str)] = &[("__name__", "up")];
    let b0 = batch_of(&[(up, MID, 1.0), (up, MID + 1, 10.0), (up, MID + 2, 100.0)]);
    let b1 = batch_of(&[(up, MID + 1, 20.0), (up, MID, 2.0), (up, MID, 3.0)]); // within a batch the later row wins
    let b2 = batch_of(&[(up, MID + 1, 30.0)]);
    let files = encode_segment(&[&b0.bytes(), &b1.bytes(), &b2.bytes()]).unwrap();
    let rows: Vec<(i64, f64)> = read_samples(&files[0].bytes).into_iter().map(|r| (r.2, f64::from_bits(r.3))).collect();
    assert_eq!(rows, vec![(MID, 3.0), (MID + 1, 30.0), (MID + 2, 100.0)]);
    // Reversing the batch order reverses the winner.
    let files = encode_segment(&[&b2.bytes(), &b1.bytes(), &b0.bytes()]).unwrap();
    let rows: Vec<(i64, f64)> = read_samples(&files[0].bytes).into_iter().map(|r| (r.2, f64::from_bits(r.3))).collect();
    assert_eq!(rows, vec![(MID, 1.0), (MID + 1, 10.0), (MID + 2, 100.0)]);
}

#[test]
fn nan_payload_bits_are_preserved() {
    let specials: [u64; 9] = [
        STALE_NAN_BITS,
        0x7ff8_0000_0000_0001, // quiet NaN, the "normal" Prometheus NaN
        0x7ff0_0000_0000_0001, // signalling NaN
        0xfff8_0000_dead_beef, // negative quiet NaN with payload
        0x7fff_ffff_ffff_ffff,
        (-0.0f64).to_bits(),
        f64::INFINITY.to_bits(),
        f64::NEG_INFINITY.to_bits(),
        1.5f64.to_bits(),
    ];
    let s = vec![labels(&[("__name__", "m")])];
    let rows: Vec<Row> = specials.iter().enumerate().map(|(i, b)| Row { series_idx: 0, ts: MID + i as i64, value_bits: *b }).collect();
    let bytes = viz_storage::batch::encode(&s, &rows).unwrap();
    let files = encode_segment(&[&bytes]).unwrap();
    check_file(&files[0], MAX_ROW_GROUP_ROWS);
    let got: Vec<u64> = read_samples(&files[0].bytes).into_iter().map(|r| r.3).collect();
    assert_eq!(got, specials);
    // And an all-NaN column still writes and reads.
    let rows: Vec<Row> = (0..5).map(|i| Row { series_idx: 0, ts: MID + i, value_bits: STALE_NAN_BITS }).collect();
    let files = encode_segment(&[&viz_storage::batch::encode(&s, &rows).unwrap()]).unwrap();
    assert!(read_samples(&files[0].bytes).iter().all(|r| r.3 == STALE_NAN_BITS));
}

#[test]
fn series_file_has_canonical_labels_and_per_file_ranges() {
    let tricky: &[(&str, &str)] = &[("__name__", "m\"q"), ("path", "C:\\x\n\u{1}\u{7f}é😀"), ("Z", "1"), ("a", "2")];
    let b = batch_of(&[(tricky, MID + 5, 1.0), (&[("__name__", "a"), ("job", "j")], MID + 9, 1.0), (tricky, MID + 1, 1.0), (tricky, MID + 3, 1.0)]);
    let files = encode_segment(&[&b.bytes()]).unwrap();
    check_file(&files[1], MAX_ROW_GROUP_ROWS);
    let rows = read_series(&files[1].bytes);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].2, r#"{"__name__":"a","job":"j"}"#);
    assert_eq!((rows[0].3, rows[0].4), (MID + 9, MID + 9));
    assert_eq!(rows[1].0, "m\"q");
    assert_eq!(rows[1].2, "{\"Z\":\"1\",\"__name__\":\"m\\\"q\",\"a\":\"2\",\"path\":\"C:\\\\x\\n\\u0001\u{7f}é😀\"}");
    assert_eq!((rows[1].3, rows[1].4), (MID + 1, MID + 5));
    // The index fragment survives names that need escaping.
    let ix = FileIndex::from_json(&files[1].index).unwrap();
    assert_eq!((ix.row_groups[0].min_name.as_str(), ix.row_groups[0].max_name.as_str()), ("a", "m\"q"));
}

#[test]
fn series_listed_without_rows_are_not_written() {
    let series = vec![labels(&[("__name__", "ghost")]), labels(&[("__name__", "real")])];
    let bytes = viz_storage::batch::encode(&series, &[Row::new(1, MID, 1.0)]).unwrap();
    let files = encode_segment(&[&bytes]).unwrap();
    assert_eq!(read_series(&files[1].bytes).iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), vec!["real"]);
}

#[test]
fn index_fragment_rejects_other_json() {
    for bad in ["", "{}", "[]", r#"{"v":2,"rg":[]}"#, r#"{"v":1,"rg":[{"rows":1}]}"#, r#"{"v":1,"rg":[]} x"#, r#"{"v":1,"rg":[{"rows":-1,"off":0,"len":0,"min_name":"","max_name":"","min_ts":0,"max_ts":0}]}"#] {
        assert!(FileIndex::from_json(bad).is_err(), "{bad}");
    }
    assert_eq!(FileIndex::from_json(r#"{"v":1,"rg":[]}"#).unwrap().row_groups.len(), 0);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Flush output equals the reference (last write wins, sorted) for any batches, and
    /// every file satisfies the table contract, at any row-group size.
    #[test]
    fn flush_matches_reference(batches in arb_batches(6), cap in 1usize..9) {
        let bytes: Vec<Vec<u8>> = batches.iter().map(|b| b.bytes()).collect();
        let refs: Vec<&[u8]> = bytes.iter().map(|b| b.as_slice()).collect();
        let files = encode_segment_with(&refs, &WriteOptions { max_row_group_rows: cap, ..Default::default() }).unwrap();
        let want = reference_samples(&batches);
        prop_assert_eq!(files.len(), want.len() * 2);
        for (pair, (day, rows)) in files.chunks(2).zip(&want) {
            prop_assert_eq!((pair[0].table, pair[1].table), (Table::MetricSamples, Table::MetricSeries));
            prop_assert_eq!(&pair[0].day, &viz_storage::day::format_day(*day));
            prop_assert_eq!(&pair[1].day, &pair[0].day);
            check_file(&pair[0], cap);
            check_file(&pair[1], cap);
            prop_assert_eq!(&read_samples(&pair[0].bytes), rows);
            // Series rows: exactly the series with samples that day, with their time range.
            let mut want_series: Vec<(String, i64, i64, i64)> = Vec::new();
            for r in rows {
                match want_series.last_mut() {
                    Some(l) if l.1 == r.1 => { l.2 = l.2.min(r.2); l.3 = l.3.max(r.2); }
                    _ => want_series.push((r.0.clone(), r.1, r.2, r.2)),
                }
            }
            let got: Vec<(String, i64, i64, i64)> = read_series(&pair[1].bytes).into_iter().map(|r| (r.0, r.1, r.3, r.4)).collect();
            prop_assert_eq!(got, want_series);
        }
        // Deterministic: same input, same bytes.
        prop_assert_eq!(encode_segment_with(&refs, &WriteOptions { max_row_group_rows: cap, ..Default::default() }).unwrap(), files);
    }
}

#[allow(dead_code)]
fn _unused(_: SeriesDef) {}
