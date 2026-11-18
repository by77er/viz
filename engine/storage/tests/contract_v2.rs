//! Checks for the rules contracts/BATCH.md and contracts/TABLES.md state explicitly since
//! their v2 revision: strict decoding, later-row-wins inside a batch on every path,
//! canonical JSON, and the 100,000-row cap on every file this crate writes.
mod common;
use common::*;
use parquet::file::reader::{FileReader, SerializedFileReader};
use viz_storage::batch::{decode, encode, Row, SeriesDef, MAX_TS};
use viz_storage::{encode_segment, merge_files, select, BatchError, Error, FileIndex, MatchOp, Matcher, ScanInput, Table, MAX_ROW_GROUP_ROWS};

/// Build a batch by hand, bypassing `encode` (which validates), from raw label bytes.
fn raw(entries: &[&[(&[u8], &[u8])]], rows: &[(u32, i64)]) -> Vec<u8> {
    let mut b = b"VZB1\x01\x00\x00\x00".to_vec();
    b.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    b.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (i, labels) in entries.iter().enumerate() {
        b.extend_from_slice(&(i as i64).to_le_bytes());
        b.extend_from_slice(&(labels.len() as u32).to_le_bytes());
        for (n, v) in labels.iter() {
            b.extend_from_slice(&(n.len() as u16).to_le_bytes());
            b.extend_from_slice(n);
            b.extend_from_slice(&(v.len() as u16).to_le_bytes());
            b.extend_from_slice(v);
        }
    }
    b.resize(b.len().div_ceil(8) * 8, 0);
    for (s, _) in rows {
        b.extend_from_slice(&s.to_le_bytes());
    }
    b.resize(b.len().div_ceil(8) * 8, 0);
    for (_, t) in rows {
        b.extend_from_slice(&t.to_le_bytes());
    }
    for _ in rows {
        b.extend_from_slice(&1.0f64.to_le_bytes());
    }
    b
}

#[test]
fn decode_enforces_the_label_rules_of_the_contract() {
    let name: (&[u8], &[u8]) = (b"__name__", b"m");
    let one = |labels: &[(&[u8], &[u8])]| decode(&raw(&[labels], &[(0, MID)])).map(|_| ());

    // NUL in a name or a value.
    assert_eq!(one(&[name, (b"a\0b", b"v")]), Err(BatchError::NulInLabel { series: 0 }));
    assert_eq!(one(&[name, (b"a", b"v\0")]), Err(BatchError::NulInLabel { series: 0 }));
    assert_eq!(one(&[(b"__name__", b"\0")]), Err(BatchError::NulInLabel { series: 0 }));

    // Name at most 1,024 bytes, value at most 8,192 bytes.
    let n1024 = vec![b'n'; 1024];
    let n1025 = vec![b'n'; 1025];
    let v8192 = vec![b'v'; 8192];
    let v8193 = vec![b'v'; 8193];
    assert_eq!(one(&[name, (&n1024, &v8192)]), Ok(()));
    assert_eq!(one(&[name, (&n1025, b"v")]), Err(BatchError::LabelTooLong { series: 0 }));
    assert_eq!(one(&[name, (b"k", &v8193)]), Err(BatchError::LabelTooLong { series: 0 }));

    // At most 128 labels.
    let names: Vec<Vec<u8>> = (0..128).map(|i| format!("l{i:03}").into_bytes()).collect();
    let mut labels: Vec<(&[u8], &[u8])> = vec![name];
    labels.extend(names.iter().take(127).map(|n| (n.as_slice(), b"v".as_slice())));
    assert_eq!(one(&labels), Ok(()));
    labels.push((&names[127], b"v"));
    assert_eq!(one(&labels), Err(BatchError::TooManyLabels { series: 0, n_labels: 129 }));

    // Sorted means UTF-8 byte order: U+FFFF (EF BF BF) sorts before U+10000 (F0 90 80 80),
    // although UTF-16 code units order them the other way round.
    let bmp = "\u{ffff}".as_bytes();
    let astral = "\u{10000}".as_bytes();
    assert_eq!(one(&[name, (bmp, b"1"), (astral, b"2")]), Ok(()));
    assert_eq!(one(&[name, (astral, b"2"), (bmp, b"1")]), Err(BatchError::UnsortedLabels { series: 0 }));

    // `encode` applies the same rules.
    let def = |extra: (&str, &str)| SeriesDef::new([("__name__".to_string(), "m".to_string()), (extra.0.to_string(), extra.1.to_string())]);
    assert_eq!(encode(&[def(("a\0", "v"))], &[Row::new(0, MID, 1.0)]).unwrap_err(), BatchError::NulInLabel { series: 0 });
    assert_eq!(encode(&[def((&"n".repeat(1025), "v"))], &[Row::new(0, MID, 1.0)]).unwrap_err(), BatchError::LabelTooLong { series: 0 });
}

#[test]
fn decode_enforces_the_timestamp_range() {
    let name: &[(&[u8], &[u8])] = &[(b"__name__", b"m")];
    assert!(decode(&raw(&[name], &[(0, 0), (0, MAX_TS)])).is_ok());
    assert_eq!(MAX_TS, 253_402_300_799_999);
    assert_eq!(viz_storage::day::day_string(MAX_TS), "9999-12-31");
    assert_eq!(viz_storage::day::day_string(0), "1970-01-01");
    assert_eq!(decode(&raw(&[name], &[(0, 5), (0, -1)])).unwrap_err(), BatchError::TimestampOutOfRange { row: 1, ts: -1 });
    assert_eq!(decode(&raw(&[name], &[(0, MAX_TS + 1)])).unwrap_err(), BatchError::TimestampOutOfRange { row: 0, ts: MAX_TS + 1 });
    assert!(matches!(decode(&raw(&[name], &[(0, i64::MIN)])), Err(BatchError::TimestampOutOfRange { .. })));
    assert!(matches!(decode(&raw(&[name], &[(0, i64::MAX)])), Err(BatchError::TimestampOutOfRange { .. })));
    // So no entry point can produce a day that is not YYYY-MM-DD.
    let bad = raw(&[name], &[(0, MAX_TS + 1)]);
    assert!(matches!(encode_segment(&[&bad]), Err(Error::Batch { index: 0, .. })));
    let input = ScanInput { tail_batches: vec![&bad], ..Default::default() };
    assert!(matches!(select(&input, &[], 0, i64::MAX), Err(Error::Batch { .. })));
}

#[test]
fn the_empty_batch_is_valid_and_contributes_nothing() {
    let empty = encode(&[], &[]).unwrap();
    assert_eq!(empty.len(), 16);
    assert_eq!(decode(&empty).unwrap().n_rows(), 0);
    assert!(encode_segment(&[&empty]).unwrap().is_empty());
    let up: &[(&str, &str)] = &[("__name__", "up")];
    let b = batch_of(&[(up, MID, 1.0)]).bytes();
    assert_eq!(encode_segment(&[&empty, &b, &empty]).unwrap(), encode_segment(&[&b]).unwrap());
    let input = ScanInput { tail_batches: vec![&empty, &b, &empty], ..Default::default() };
    assert_eq!(select(&input, &[], 0, i64::MAX).unwrap().len(), 1);
}

/// Within ONE batch, the later row wins for a duplicate `(series_id, ts)`: in flush, in a
/// tail read, in a tail read over a lake file, and after a merge.
#[test]
fn later_row_wins_inside_a_batch_everywhere() {
    let up: &[(&str, &str)] = &[("__name__", "up"), ("job", "a")];
    let other: &[(&str, &str)] = &[("__name__", "up"), ("job", "b")];
    // Three rows for (up{job=a}, MID): 1, then 2, then 3, with other rows in between.
    let b = batch_of(&[(up, MID, 1.0), (other, MID, 10.0), (up, MID, 2.0), (up, MID + 1, 7.0), (up, MID, 3.0), (other, MID, 20.0)]).bytes();
    let want = vec![(MID, 3.0f64.to_bits()), (MID + 1, 7.0f64.to_bits())];
    let m = [Matcher::new("job", MatchOp::Eq, "a")];
    let pick = |input: &ScanInput<'_>| normalize(select(input, &m, 0, i64::MAX).unwrap()).remove(0).1;

    // flush
    let files = encode_segment(&[&b]).unwrap();
    let rows: Vec<(i64, u64)> = read_samples(&files[0].bytes).into_iter().filter(|r| r.1 == labels(up).series_id).map(|r| (r.2, r.3)).collect();
    assert_eq!(rows, want);
    assert_eq!(files[0].rows, 3); // two for job=a, one for job=b

    // tail only
    assert_eq!(pick(&ScanInput { tail_batches: vec![&b], ..Default::default() }), want);
    // lake only
    let lake = ScanInput { sample_files: vec![&files[0].bytes], series_files: vec![&files[1].bytes], ..Default::default() };
    assert_eq!(pick(&lake), want);
    // lake + the same batch still in the tail (flushed but not yet discarded): no double count
    let both = ScanInput { sample_files: vec![&files[0].bytes], series_files: vec![&files[1].bytes], tail_batches: vec![&b] };
    assert_eq!(pick(&both), want);
    let total: usize = select(&both, &[], 0, i64::MAX).unwrap().iter().map(|s| s.ts.len()).sum();
    assert_eq!(total, 3);

    // A later batch whose own last row for the key differs wins over the lake, and merge keeps that.
    let b2 = batch_of(&[(up, MID, 4.0), (up, MID, 5.0)]).bytes();
    let files2 = encode_segment(&[&b2]).unwrap();
    let merged = merge_files(Table::MetricSamples, &[&files[0].bytes, &files2[0].bytes]).unwrap();
    let rows: Vec<(i64, u64)> = read_samples(&merged.bytes).into_iter().filter(|r| r.1 == labels(up).series_id).map(|r| (r.2, r.3)).collect();
    assert_eq!(rows, vec![(MID, 5.0f64.to_bits()), (MID + 1, 7.0f64.to_bits())]);
    let with_tail = ScanInput { sample_files: vec![&files[0].bytes], series_files: vec![&files[1].bytes], tail_batches: vec![&b2] };
    assert_eq!(pick(&with_tail), vec![(MID, 5.0f64.to_bits()), (MID + 1, 7.0f64.to_bits())]);
}

/// TABLES.md "Canonical JSON": no whitespace, keys in UTF-8 byte order, RFC 8785 string
/// escaping. Checked on the bytes of the `labels` column.
#[test]
fn labels_are_canonical_json() {
    let tricky: &[(&str, &str)] = &[
        ("\u{10000}", "astral"),
        ("\u{ffff}", "bmp"),
        ("\u{e000}", "private"),
        ("__name__", "m"),
        ("ctl", "\u{8}\u{9}\u{a}\u{c}\u{d}\u{1}\u{1f}"),
        ("esc", "\"\\/"),
        ("raw", "\u{7f}\u{80}é\u{2028}\u{2029}😀<>&"),
    ];
    let b = batch_of(&[(tricky, MID, 1.0)]).bytes();
    let files = encode_segment(&[&b]).unwrap();
    let got = read_series(&files[1].bytes).remove(0).2;
    let want = concat!(
        "{",
        "\"__name__\":\"m\",",
        "\"ctl\":\"\\b\\t\\n\\f\\r\\u0001\\u001f\",",
        "\"esc\":\"\\\"\\\\/\",",
        "\"raw\":\"\u{7f}\u{80}é\u{2028}\u{2029}😀<>&\",",
        "\"\u{e000}\":\"private\",",
        "\"\u{ffff}\":\"bmp\",",
        "\"\u{10000}\":\"astral\"",
        "}"
    );
    assert_eq!(got, want);
    // RFC 8785 itself (UTF-16 code-unit order) would put the astral key before U+E000.
    let utf16 = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    assert!(utf16("\u{10000}") < utf16("\u{e000}"));
    assert!("\u{10000}".as_bytes() > "\u{e000}".as_bytes());
    // It parses back to the same labels, and survives a merge and a select unchanged.
    let parsed = viz_storage::json::parse_labels(&got).unwrap();
    let mut sorted: Vec<(String, String)> = tricky.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
    sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    assert_eq!(parsed, sorted);
    let merged = merge_files(Table::MetricSeries, &[&files[1].bytes]).unwrap();
    assert_eq!(read_series(&merged.bytes).remove(0).2, want);
    let lake = ScanInput { sample_files: vec![&files[0].bytes], series_files: vec![&files[1].bytes], ..Default::default() };
    assert_eq!(select(&lake, &[], 0, i64::MAX).unwrap()[0].labels, sorted);
}

fn row_groups(bytes: &[u8]) -> Vec<i64> {
    let r = SerializedFileReader::new(bytes::Bytes::copy_from_slice(bytes)).unwrap();
    r.metadata().row_groups().iter().map(|g| g.num_rows()).collect()
}

/// TABLES.md: row groups hold at most 100,000 rows "in flush files and compaction output
/// alike", for every table.
#[test]
fn the_row_group_cap_applies_to_every_file_written() {
    assert_eq!(MAX_ROW_GROUP_ROWS, 100_000);
    // 100,001 series with 2 samples each, in several batches (as edge would send them).
    let n = 100_001usize;
    let mut batches = Vec::new();
    for chunk in (0..n).collect::<Vec<_>>().chunks(20_000) {
        let series: Vec<SeriesDef> = chunk.iter().map(|i| labels(&[("__name__", if i % 2 == 0 { "even" } else { "odd" }), ("i", &i.to_string())])).collect();
        let rows: Vec<Row> = (0..chunk.len() as u32).flat_map(|s| [Row::new(s, MID, 1.0), Row::new(s, MID + 1, 2.0)]).collect();
        batches.push(encode(&series, &rows).unwrap());
    }
    let refs: Vec<&[u8]> = batches.iter().map(|b| b.as_slice()).collect();
    let files = encode_segment(&refs).unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(row_groups(&files[0].bytes), vec![100_000, 100_000, 2]); // samples
    assert_eq!(row_groups(&files[1].bytes), vec![100_000, 1]); // series
    for f in &files {
        let ix = FileIndex::from_json(&f.index).unwrap();
        assert!(ix.row_groups.iter().all(|g| g.rows <= 100_000));
        assert_eq!(ix.row_groups.iter().map(|g| g.rows).sum::<u64>(), f.rows);
    }

    // Compaction output: merge two flushes of the same day.
    let more = {
        let series = vec![labels(&[("__name__", "zzz")])];
        let rows: Vec<Row> = (0..50_000).map(|k| Row::new(0, MID + k, 0.5)).collect();
        encode_segment(&[&encode(&series, &rows).unwrap()]).unwrap()
    };
    let samples = merge_files(Table::MetricSamples, &[&files[0].bytes, &more[0].bytes]).unwrap();
    assert_eq!(samples.rows, 250_002);
    assert_eq!(row_groups(&samples.bytes), vec![100_000, 100_000, 50_002]);
    let series = merge_files(Table::MetricSeries, &[&files[1].bytes, &more[1].bytes]).unwrap();
    assert_eq!(series.rows, 100_002);
    assert_eq!(row_groups(&series.bytes), vec![100_000, 2]);
    // And a select over the merged pair still sees everything.
    let lake = ScanInput { sample_files: vec![&samples.bytes], series_files: vec![&series.bytes], ..Default::default() };
    let out = select(&lake, &[Matcher::new("__name__", MatchOp::Eq, "odd")], 0, i64::MAX).unwrap();
    assert_eq!(out.len(), 50_000);
    assert!(out.iter().all(|s| s.ts == vec![MID, MID + 1]));
}
