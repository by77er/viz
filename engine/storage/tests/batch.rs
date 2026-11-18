mod common;
use proptest::prelude::*;
use viz_storage::batch::{self, decode, encode, series_id, BatchError, Row, SeriesDef};

fn sample() -> (Vec<SeriesDef>, Vec<Row>) {
    let s = vec![
        common::labels(&[("__name__", "up"), ("job", "api"), ("instance", "a:1")]),
        common::labels(&[("__name__", "cpu")]),
    ];
    let r = vec![Row::new(0, 1000, 1.0), Row::new(1, 1000, 2.5), Row::new(0, 2000, f64::from_bits(batch::STALE_NAN_BITS))];
    (s, r)
}

#[test]
fn series_id_matches_known_fnv1a_vectors() {
    // FNV-1a 64 reference values: "" -> offset basis, "a" -> 0xaf63dc4c8601ec8c.
    let none: [(&str, &str); 0] = [];
    assert_eq!(series_id(&none) as u64, 0xcbf29ce484222325);
    // Computed independently (python): fnv1a64(b"__name__\0up\0") and with a second label.
    assert_eq!(series_id(&[("__name__", "up")]) as u64, fnv(b"__name__\0up\0"));
    assert_eq!(series_id(&[("__name__", "up"), ("job", "api")]) as u64, fnv(b"__name__\0up\0job\0api\0"));
    assert_eq!(series_id(&[("__name__", "up")]) as u64, 0xafd3_0857_48e6_c5d5_u64, "pinned value (python)");
    // The separator matters: ("ab","c") and ("a","bc") differ.
    assert_ne!(series_id(&[("ab", "c")]), series_id(&[("a", "bc")]));
}

/// A second, deliberately naive FNV-1a 64.
fn fnv(bytes: &[u8]) -> u64 {
    let mut h: u128 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u128;
        h = (h * 0x100000001b3) % (1u128 << 64);
    }
    h as u64
}

#[test]
fn layout_is_exactly_the_contract() {
    let s = vec![SeriesDef { series_id: -2, labels: vec![("__name__".into(), "m".into())] }];
    let bytes = encode(&s, &[Row { series_idx: 0, ts: 7, value_bits: 0x7ff0000000000002 }]).unwrap();
    let mut want = Vec::new();
    want.extend_from_slice(b"VZB1");
    want.extend_from_slice(&[1, 0, 0, 0]);
    want.extend_from_slice(&1u32.to_le_bytes()); // n_rows
    want.extend_from_slice(&1u32.to_le_bytes()); // n_series
    want.extend_from_slice(&(-2i64).to_le_bytes());
    want.extend_from_slice(&1u32.to_le_bytes());
    want.extend_from_slice(&8u16.to_le_bytes());
    want.extend_from_slice(b"__name__");
    want.extend_from_slice(&1u16.to_le_bytes());
    want.extend_from_slice(b"m");
    assert_eq!(want.len(), 41);
    want.extend_from_slice(&[0; 7]); // pad to 48
    want.extend_from_slice(&0u32.to_le_bytes()); // series_idx
    want.extend_from_slice(&[0; 4]); // pad to 56
    want.extend_from_slice(&7i64.to_le_bytes());
    want.extend_from_slice(&0x7ff0000000000002u64.to_le_bytes());
    assert_eq!(bytes, want);
}

#[test]
fn round_trip_fixed() {
    let (s, r) = sample();
    let bytes = encode(&s, &r).unwrap();
    let b = decode(&bytes).unwrap();
    assert_eq!(b.n_rows(), 3);
    assert_eq!(b.series().len(), 2);
    assert_eq!(b.series()[0].metric_name(), "up");
    assert_eq!(b.series()[0].labels, vec![("__name__", "up"), ("instance", "a:1"), ("job", "api")]);
    assert_eq!(b.series()[0].series_id, s[0].series_id);
    assert!(b.series_ids_consistent());
    assert_eq!((b.series_idx(2), b.ts(2), b.value_bits(2)), (0, 2000, batch::STALE_NAN_BITS));
    assert!(b.value(2).is_nan());
}

#[test]
fn empty_batch_round_trips() {
    let bytes = encode(&[], &[]).unwrap();
    assert_eq!(bytes.len(), 16);
    let b = decode(&bytes).unwrap();
    assert_eq!((b.n_rows(), b.series().len()), (0, 0));
}

#[test]
fn series_def_new_canonicalises() {
    let d = SeriesDef::new([("job", "x"), ("__name__", "m"), ("empty", "")]);
    assert_eq!(d.labels, vec![("__name__".to_string(), "m".to_string()), ("job".to_string(), "x".to_string())]);
    assert_eq!(d.series_id, series_id(&[("__name__", "m"), ("job", "x")]));
}

fn raw(n_rows: u32, entries: &[(i64, &[(&[u8], &[u8])])], idx: &[u32], tail_rows: usize) -> Vec<u8> {
    let mut o = Vec::new();
    o.extend_from_slice(b"VZB1");
    o.extend_from_slice(&[1, 0, 0, 0]);
    o.extend_from_slice(&n_rows.to_le_bytes());
    o.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (id, labels) in entries {
        o.extend_from_slice(&id.to_le_bytes());
        o.extend_from_slice(&(labels.len() as u32).to_le_bytes());
        for (n, v) in *labels {
            o.extend_from_slice(&(n.len() as u16).to_le_bytes());
            o.extend_from_slice(n);
            o.extend_from_slice(&(v.len() as u16).to_le_bytes());
            o.extend_from_slice(v);
        }
    }
    o.resize(o.len().div_ceil(8) * 8, 0);
    for i in idx {
        o.extend_from_slice(&i.to_le_bytes());
    }
    o.resize(o.len().div_ceil(8) * 8, 0);
    o.resize(o.len() + 16 * tail_rows, 0);
    o
}

#[test]
fn precise_errors() {
    let (s, r) = sample();
    let good = encode(&s, &r).unwrap();

    assert_eq!(decode(b"").unwrap_err(), BatchError::Truncated { what: "header", needed: 16, len: 0 });
    assert_eq!(decode(b"VZ").unwrap_err(), BatchError::Truncated { what: "header", needed: 16, len: 2 });
    assert_eq!(decode(b"VX").unwrap_err(), BatchError::BadMagic);
    assert_eq!(decode(b"VZB2............").unwrap_err(), BatchError::BadMagic);
    assert_eq!(decode(b"PAR1").unwrap_err(), BatchError::BadMagic);

    let mut b = good.clone();
    b[4] = 2;
    assert_eq!(decode(&b).unwrap_err(), BatchError::UnsupportedSignal(2));
    let mut b = good.clone();
    b[5] = 1;
    assert_eq!(decode(&b).unwrap_err(), BatchError::BadFlags(1));
    let mut b = good.clone();
    b[7] = 1;
    assert_eq!(decode(&b).unwrap_err(), BatchError::BadReserved(256));

    // Both-or-neither empty.
    assert_eq!(decode(&raw(0, &[(1, &[(b"__name__", b"m")])], &[], 0)).unwrap_err(), BatchError::EmptyMismatch { n_rows: 0, n_series: 1 });
    assert_eq!(decode(&raw(1, &[], &[0], 1)).unwrap_err(), BatchError::EmptyMismatch { n_rows: 1, n_series: 0 });

    // Truncation at the value column, and every proper prefix is an error.
    let cut = &good[..good.len() - 1];
    assert_eq!(decode(cut).unwrap_err(), BatchError::Truncated { what: "value column", needed: good.len() as u64, len: cut.len() as u64 });
    for n in 0..good.len() {
        assert!(matches!(decode(&good[..n]), Err(BatchError::Truncated { .. })), "prefix {n}");
    }
    let mut b = good.clone();
    b.push(0);
    assert_eq!(decode(&b).unwrap_err(), BatchError::TrailingBytes { expected: good.len() as u64, len: good.len() as u64 + 1 });

    // Series index out of range (row 1 points at series 2 of 2).
    let name: &[(&[u8], &[u8])] = &[(b"__name__", b"m")];
    assert_eq!(
        decode(&raw(2, &[(1, name), (2, name)], &[1, 2], 2)).unwrap_err(),
        BatchError::SeriesIndexOutOfRange { row: 1, index: 2, n_series: 2 }
    );
    assert!(decode(&raw(2, &[(1, name), (2, name)], &[1, 0], 2)).is_ok());

    // Label rules; the error names the offending entry.
    let e = |labels: &[(&[u8], &[u8])]| decode(&raw(1, &[(1, name), (2, labels)], &[0], 1)).unwrap_err();
    assert_eq!(e(&[(b"job", b"x"), (b"__name__", b"m")]), BatchError::UnsortedLabels { series: 1 });
    assert_eq!(e(&[(b"__name__", b"m"), (b"__name__", b"n")]), BatchError::DuplicateLabel { series: 1 });
    assert_eq!(e(&[(b"job", b"x")]), BatchError::MissingName { series: 1 });
    assert_eq!(e(&[]), BatchError::MissingName { series: 1 });
    assert_eq!(e(&[(b"", b"x"), (b"__name__", b"m")]), BatchError::EmptyLabelName { series: 1 });
    assert_eq!(e(&[(b"__name__", b"m"), (b"job", b"")]), BatchError::EmptyLabelValue { series: 1 });
    assert_eq!(e(&[(b"__name__", b"\xff")]), BatchError::InvalidUtf8 { series: 1 });
    // Byte order, not locale order: "Z" < "__name__" < "a".
    assert!(decode(&raw(1, &[(1, &[(b"Z", b"1"), (b"__name__", b"m"), (b"a", b"1")])], &[0], 1)).is_ok());

    // Non-zero padding after the series table.
    let mut b = raw(1, &[(1, name)], &[0], 1);
    assert_eq!(b.len(), 48 + 8 + 16);
    b[45] = 9;
    assert_eq!(decode(&b).unwrap_err(), BatchError::NonZeroPadding { offset: 45 });
    let mut b = raw(1, &[(1, name)], &[0], 1);
    b[53] = 9; // padding after series_idx
    assert_eq!(decode(&b).unwrap_err(), BatchError::NonZeroPadding { offset: 53 });

    // A huge n_series in a tiny input must fail cleanly, not allocate.
    let mut b = good[..16].to_vec();
    b[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    b[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(matches!(decode(&b), Err(BatchError::Truncated { what: "series_id", .. })));
}

#[test]
fn encode_rejects_what_decode_rejects() {
    let bad = SeriesDef { series_id: 1, labels: vec![("job".into(), "x".into())] };
    assert_eq!(encode(&[bad], &[Row::new(0, 1, 1.0)]).unwrap_err(), BatchError::MissingName { series: 0 });
    let (s, _) = sample();
    assert_eq!(encode(&s, &[Row::new(5, 1, 1.0)]).unwrap_err(), BatchError::SeriesIndexOutOfRange { row: 0, index: 5, n_series: 2 });
    let long = SeriesDef { series_id: 1, labels: vec![("__name__".into(), "x".repeat(70_000))] };
    assert_eq!(encode(&[long], &[Row::new(0, 1, 1.0)]).unwrap_err(), BatchError::LabelTooLong { series: 0 });
    assert_eq!(encode(&s, &[]).unwrap_err(), BatchError::EmptyMismatch { n_rows: 0, n_series: 2 });
}

fn arb_def() -> impl Strategy<Value = SeriesDef> {
    (proptest::collection::btree_map("[a-zA-Z_é]{1,6}", "\\PC{1,8}", 0..5), "\\PC{1,10}", any::<bool>(), any::<i64>()).prop_map(
        |(extra, name, real_id, fake)| {
            let mut d = SeriesDef::new(extra.into_iter().chain([("__name__".to_string(), name)]));
            if !real_id {
                d.series_id = fake; // decode must not care
            }
            d
        },
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    #[test]
    fn round_trip(series in proptest::collection::vec(arb_def(), 1..6),
                  rows in proptest::collection::vec((any::<u32>(), 0i64..=253_402_300_799_999, any::<u64>()), 1..40)) {
        let rows: Vec<Row> = rows.into_iter().map(|(i, ts, bits)| Row { series_idx: i % series.len() as u32, ts, value_bits: bits }).collect();
        let bytes = encode(&series, &rows).unwrap();
        let b = decode(&bytes).unwrap();
        prop_assert_eq!(b.n_rows(), rows.len());
        prop_assert_eq!(b.series().len(), series.len());
        for (got, want) in b.series().iter().zip(&series) {
            prop_assert_eq!(got.series_id, want.series_id);
            let l: Vec<(String, String)> = got.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
            prop_assert_eq!(&l, &want.labels);
        }
        for (i, r) in rows.iter().enumerate() {
            prop_assert_eq!((b.series_idx(i), b.ts(i), b.value_bits(i)), (r.series_idx, r.ts, r.value_bits));
        }
        // Strict decoding makes the encoding canonical.
        let defs: Vec<SeriesDef> = b.series().iter().map(|s| SeriesDef { series_id: s.series_id, labels: s.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect() }).collect();
        prop_assert_eq!(encode(&defs, &rows).unwrap(), bytes);
    }

    #[test]
    fn garbage_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..300)) {
        // Random bytes essentially never start with the magic.
        prop_assert!(decode(&bytes).is_err());
    }

    #[test]
    fn garbage_after_a_valid_header_never_panics(n_rows in 0u32..6, n_series in 0u32..4, body in proptest::collection::vec(any::<u8>(), 0..200), wild in any::<bool>()) {
        let mut b = b"VZB1\x01\x00\x00\x00".to_vec();
        b.extend_from_slice(&(if wild { n_rows.wrapping_mul(0x3fff_ffff) } else { n_rows }).to_le_bytes());
        b.extend_from_slice(&(if wild { n_series.wrapping_mul(0x7fff_fff1) } else { n_series }).to_le_bytes());
        b.extend_from_slice(&body);
        let _ = decode(&b); // Ok or Err, but no panic and no huge allocation
    }

    #[test]
    fn corrupting_a_valid_batch_never_panics(b in common::arb_batch(), at in any::<prop::sample::Index>(), val in any::<u8>(), cut in any::<prop::sample::Index>()) {
        let good = b.bytes();
        let mut flipped = good.clone();
        let i = at.index(flipped.len());
        flipped[i] = val;
        if let Ok(d) = decode(&flipped) {
            // Whatever still decodes must be safe to read in full.
            for r in 0..d.n_rows() {
                let _ = (&d.series()[d.series_idx(r) as usize], d.ts(r), d.value_bits(r));
            }
        }
        let n = cut.index(good.len());
        prop_assert!(decode(&good[..n]).is_err());
        // And the engine entry points surface it as an error.
        prop_assert!(viz_storage::encode_segment(&[&good[..n]]).is_err());
    }
}
