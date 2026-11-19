//! Spans and logs: the `VZB1` signal 2 and 3 batches, flush to `spans`, `trace_index` and
//! `logs` files, and reading them back (contracts/BATCH.md, TRACES.md, LOGS.md).
mod otelgen;

use otelgen::*;
use parquet::file::reader::{FileReader, SerializedFileReader};
use proptest::prelude::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use viz_storage::otel::{self, Attr, LogRow, LogStream, SignalBatchError, Span, SpanEntry, Value};
use viz_storage::{
    encode_logs, encode_logs_with, encode_spans, encode_spans_with, merge_fragments, read_logs, read_spans, read_trace_index, Fragment, SignalTable,
    SignalWriteOptions, NS_PER_DAY, NS_PER_HOUR,
};

fn small(rows: usize) -> SignalWriteOptions {
    SignalWriteOptions { max_row_group_rows: rows, max_row_group_bytes: 16 << 20, page_rows: 3 }
}

// ───────────────────────────── batches ─────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig { cases: 200, ..ProptestConfig::default() })]

    #[test]
    fn span_batches_round_trip(b in arb_span_batch()) {
        let bytes = otel::encode_spans(&b.entries, &b.rows).unwrap();
        prop_assert_eq!(bytes.len() % 8, 0);
        let d = otel::decode_spans(&bytes).unwrap();
        prop_assert_eq!(d.entries.len(), b.entries.len());
        for (x, y) in d.entries.iter().zip(&b.entries) {
            prop_assert_eq!(x.resource_fp, y.resource_fp);
            prop_assert_eq!(owned_attrs(&x.resource), y.resource.clone());
            prop_assert_eq!(x.scope_name, y.scope_name.as_str());
            prop_assert_eq!(x.scope_attrs, y.scope_attrs.as_str());
        }
        prop_assert_eq!(d.rows.iter().map(owned_span).collect::<Vec<_>>(), b.rows.clone());
        // Strict decoding: what decodes re-encodes to the same bytes.
        prop_assert_eq!(otel::encode_spans(&d.entries, &d.rows).unwrap(), bytes);
    }

    #[test]
    fn log_batches_round_trip(b in arb_log_batch()) {
        let bytes = otel::encode_logs(&b.streams, &b.rows).unwrap();
        prop_assert_eq!(bytes.len() % 8, 0);
        let d = otel::decode_logs(&bytes).unwrap();
        prop_assert_eq!(d.streams.iter().map(owned_stream).collect::<Vec<_>>(), b.streams.clone());
        prop_assert_eq!(d.rows.iter().map(owned_log).collect::<Vec<_>>(), b.rows.clone());
        prop_assert_eq!(otel::encode_logs(&d.streams, &d.rows).unwrap(), bytes);
    }

    /// Damaged batches are refused, never a panic.
    #[test]
    fn damaged_batches_never_panic(b in arb_span_batch(), l in arb_log_batch(), at in any::<prop::sample::Index>(), x in 1u8..=255) {
        for bytes in [otel::encode_spans(&b.entries, &b.rows).unwrap(), otel::encode_logs(&l.streams, &l.rows).unwrap()] {
            let mut m = bytes.clone();
            let i = at.index(m.len());
            m[i] ^= x;
            let _ = otel::decode_spans(&m);
            let _ = otel::decode_logs(&m);
            for cut in [i, m.len() / 2, m.len().saturating_sub(1)] {
                prop_assert!(otel::decode_spans(&bytes[..cut]).is_err() || cut == bytes.len());
                let _ = otel::decode_logs(&bytes[..cut]);
            }
        }
    }
}

#[test]
fn every_proper_prefix_is_refused() {
    let b = fixed_span_batch();
    let bytes = otel::encode_spans(&b.entries, &b.rows).unwrap();
    for n in 0..bytes.len() {
        assert!(otel::decode_spans(&bytes[..n]).is_err(), "prefix {n}");
    }
    let l = fixed_log_batch();
    let bytes = otel::encode_logs(&l.streams, &l.rows).unwrap();
    for n in 0..bytes.len() {
        assert!(otel::decode_logs(&bytes[..n]).is_err(), "prefix {n}");
    }
}

fn span_err(f: impl FnOnce(&mut SpanBatchDef)) -> SignalBatchError {
    let mut b = fixed_span_batch();
    f(&mut b);
    // Encoding validates by decoding: the error is the decoder's.
    otel::encode_spans(&b.entries, &b.rows).unwrap_err()
}

fn log_err(f: impl FnOnce(&mut LogBatchDef)) -> SignalBatchError {
    let mut b = fixed_log_batch();
    f(&mut b);
    otel::encode_logs(&b.streams, &b.rows).unwrap_err()
}

#[test]
fn span_decoder_refuses_each_rule() {
    let msg = |e: SignalBatchError| e.to_string();
    assert!(msg(span_err(|b| b.rows[0].trace_id = [0; 16])).contains("all-zero trace_id"));
    assert!(msg(span_err(|b| b.rows[0].span_id = [0; 8])).contains("all-zero"));
    assert!(msg(span_err(|b| b.rows[0].end = b.rows[0].start - 1)).contains("end"));
    assert!(msg(span_err(|b| b.rows[0].start = -1)).contains("start"));
    assert!(msg(span_err(|b| b.rows[0].kind = 6)).contains("kind"));
    assert!(msg(span_err(|b| b.rows[0].status = 3)).contains("status"));
    assert!(msg(span_err(|b| b.rows[0].name = "x".repeat(8193))).contains("8,192"));
    assert!(msg(span_err(|b| b.rows[0].attrs.reverse())).contains("not sorted"));
    assert!(msg(span_err(|b| b.rows[0].attrs[1].key = b.rows[0].attrs[0].key.clone())).contains("not sorted or not unique"));
    assert!(msg(span_err(|b| b.rows[0].attrs.insert(0, Attr { key: String::new(), value: Value::Bool(true) }))).contains("key empty"));
    assert!(msg(span_err(|b| b.rows[0].attrs[0].value = Value::Other(String::new()))).contains("empty \"other\""));
    assert!(msg(span_err(|b| b.rows[0].attrs[0].value = Value::Str("v".repeat(65_537)))).contains("65,536"));
    assert!(msg(span_err(|b| b.rows[0].attrs = (0..129).map(|k| Attr { key: format!("k{k:03}"), value: Value::Int(k) }).collect())).contains("129 attributes"));
    assert!(msg(span_err(|b| b.rows[0].events[0].time_unix_nano = -5)).contains("negative time"));
    assert!(msg(span_err(|b| b.rows[0].events[0].attrs = String::new())).contains("empty attrs"));
    assert!(msg(span_err(|b| b.rows[0].links[0].attrs = String::new())).contains("empty attrs"));
    assert!(msg(span_err(|b| {
        let e = b.rows[0].events[0].clone();
        b.rows[0].events = vec![e; 129];
    }))
    .contains("129 events"));
    assert!(msg(span_err(|b| b.rows[0].attrs = (0..8).map(|k| Attr { key: format!("k{k}"), value: Value::Str("v".repeat(40_000)) }).collect())).contains("at most 262144"));
    assert!(matches!(span_err(|b| b.rows[0].entry = 9), SignalBatchError::EntryOutOfRange { index: 9, .. }));
    assert!(msg(span_err(|b| b.entries[0].resource = (0..7).map(|k| Attr { key: format!("k{k}"), value: Value::Str("v".repeat(40_000)) }).collect()))
        .contains("at most 262144"));

    // Header and padding rules, on bytes.
    let b = fixed_span_batch();
    let good = otel::encode_spans(&b.entries, &b.rows).unwrap();
    let with = |i: usize, v: u8| {
        let mut x = good.clone();
        x[i] = v;
        otel::decode_spans(&x).unwrap_err()
    };
    assert_eq!(with(0, b'X'), SignalBatchError::BadMagic);
    assert_eq!(with(4, 1), SignalBatchError::UnsupportedSignal(1));
    assert_eq!(with(5, 1), SignalBatchError::BadFlags(1));
    assert_eq!(with(6, 1), SignalBatchError::BadReserved(1));
    let mut longer = good.clone();
    longer.extend_from_slice(&[0; 8]);
    assert!(matches!(otel::decode_spans(&longer), Err(SignalBatchError::TrailingBytes { .. })));
    // A metrics batch and a log batch are not span batches.
    assert_eq!(otel::decode_spans(&otel::encode_logs(&fixed_log_batch().streams, &fixed_log_batch().rows).unwrap()).unwrap_err(), SignalBatchError::UnsupportedSignal(3));
    assert_eq!(otel::decode_logs(&good).unwrap_err(), SignalBatchError::UnsupportedSignal(2));
    // The empty batch is valid and contributes nothing.
    let empty = otel::encode_spans::<String>(&[], &[]).unwrap();
    assert_eq!(empty.len(), 16 + 8 * 6);
    assert!(encode_spans(&[&empty]).unwrap().is_empty());
}

#[test]
fn log_decoder_refuses_each_rule() {
    let msg = |e: SignalBatchError| e.to_string();
    assert!(msg(log_err(|b| b.streams[0].labels[0].0 = "1bad".into())).contains("label-name rule"));
    assert!(msg(log_err(|b| b.streams[0].labels[0].0 = "a.b".into())).contains("label-name rule"));
    assert!(msg(log_err(|b| b.streams[0].labels[0].1 = String::new())).contains("empty"));
    assert!(msg(log_err(|b| b.streams[0].labels[0].1 = "a\0b".into())).contains("NUL"));
    assert!(msg(log_err(|b| b.streams[0].labels.reverse())).contains("not sorted"));
    assert!(msg(log_err(|b| b.streams[0].labels = (0..33).map(|k| (format!("l{k:02}"), "v".into())).collect())).contains("33 labels"));
    assert!(msg(log_err(|b| b.rows[0].line = "x".repeat(262_145))).contains("at most 262144"));
    assert!(msg(log_err(|b| b.rows[0].severity_number = 25)).contains("severity_number 25"));
    assert!(msg(log_err(|b| b.rows[0].severity_text = "x".repeat(1025))).contains("1,024"));
    assert!(msg(log_err(|b| b.rows[0].ts = -1)).contains("negative"));
    assert!(msg(log_err(|b| b.rows[0].metadata = vec![("b".into(), "1".into()), ("a".into(), "2".into())])).contains("not sorted"));
    assert!(msg(log_err(|b| b.rows[0].metadata = vec![("ok".into(), String::new())])).contains("empty"));
    assert!(msg(log_err(|b| b.rows[0].metadata = (0..129).map(|k| (format!("m{k:03}"), "v".into())).collect())).contains("129 entries"));
    assert!(msg(log_err(|b| b.rows[0].metadata = (0..9).map(|k| (format!("m{k}"), "v".repeat(8000))).collect())).contains("at most 65536"));
    assert!(matches!(log_err(|b| b.rows[0].entry = 5), SignalBatchError::EntryOutOfRange { index: 5, .. }));
}

/// Every limit is accepted at its bound.
#[test]
fn maximal_values_are_accepted_and_read_back() {
    let mut b = fixed_span_batch();
    let big = "é".repeat(4096); // 8,192 bytes
    b.rows[0].name = big.clone();
    b.rows[0].trace_state = big.clone();
    b.rows[0].status_message = "s".repeat(8192);
    b.entries[0].scope_name = big.clone();
    b.rows[0].attrs = vec![
        Attr { key: "k".repeat(1024), value: Value::Str("v".repeat(65_536)) },
        Attr { key: "z".into(), value: Value::Other(format!("{{\"stringValue\":\"{}\"}}", "o".repeat(65_536 - 18))) },
    ];
    b.rows[0].events = (0..128).map(|k| otel::Event { time_unix_nano: k, name: format!("e{k}"), attrs: "[]".into() }).collect();
    b.rows[0].links = (0..128).map(|k| otel::Link { trace_id: [k as u8 + 1; 16], span_id: [2; 8], trace_state: String::new(), attrs: "[]".into() }).collect();
    let bytes = otel::encode_spans(&b.entries, &b.rows).unwrap();
    let files = encode_spans(&[&bytes]).unwrap();
    let back: Vec<_> = files.iter().filter(|f| f.table == SignalTable::Spans).flat_map(|f| read_spans(&f.bytes).unwrap()).collect();
    let r = back.iter().find(|r| r.span_id == b.rows[0].span_id).unwrap();
    assert_eq!(r.span_name, big);
    assert_eq!(r.attrs, b.rows[0].attrs);
    assert_eq!(r.events.len(), 128);
    assert_eq!(r.links.len(), 128);

    let mut l = fixed_log_batch();
    l.rows[0].line = "€".repeat(87_381) + "x"; // 262,144 bytes
    l.rows[0].severity_text = "S".repeat(1024);
    l.rows[0].metadata = (0..128).map(|k| (format!("m{k:03}"), "v".repeat(508))).collect(); // 65,536 bytes
    l.streams[0].labels = (0..32).map(|k| (format!("l{k:02}"), "x".repeat(if k == 0 { 8192 } else { 1 }))).collect();
    l.streams[0].stream_id = otel::stream_id(&l.streams[0].labels);
    let bytes = otel::encode_logs(&l.streams, &l.rows).unwrap();
    assert!(bytes.len() < 1 << 20, "a maximal row and its stream fit one batch: {}", bytes.len());
    let files = encode_logs(&[&bytes]).unwrap();
    let back: Vec<_> = files.iter().flat_map(|f| read_logs(&f.bytes).unwrap()).collect();
    assert!(back.iter().any(|r| r.line == l.rows[0].line && r.metadata.len() == 128 && r.labels.len() == 32));
}

// ───────────────────────────── spans flush ─────────────────────────────

/// What the files must hold: the batches' rows, later row winning per (trace_id, span_id).
fn span_reference(batches: &[SpanBatchDef]) -> BTreeMap<([u8; 16], [u8; 8]), (Span<String>, SpanEntry<String>)> {
    let mut m = BTreeMap::new();
    for b in batches {
        for r in &b.rows {
            m.insert((r.trace_id, r.span_id), (r.clone(), b.entries[r.entry as usize].clone()));
        }
    }
    m
}

fn service_of(e: &SpanEntry<String>) -> Option<String> {
    e.resource.iter().find(|a| a.key == "service.name").and_then(|a| match &a.value {
        Value::Str(s) => Some(s.clone()),
        _ => None,
    })
}

/// trace_index rows computed from the reference, independently of `spans.rs`.
fn index_reference(spans: &[(Span<String>, SpanEntry<String>)]) -> Vec<Fragment> {
    let mut by: BTreeMap<[u8; 16], Vec<&(Span<String>, SpanEntry<String>)>> = BTreeMap::new();
    for s in spans {
        by.entry(s.0.trace_id).or_default().push(s);
    }
    by.into_iter()
        .map(|(t, v)| {
            let root = v.iter().filter(|(s, _)| s.parent_span_id == [0; 8]).min_by_key(|(s, _)| (s.start, s.span_id));
            let mut svc: BTreeMap<Vec<u8>, (String, i32, i32)> = BTreeMap::new();
            for (s, e) in &v {
                let n = service_of(e).unwrap_or_default();
                let x = svc.entry(n.as_bytes().to_vec()).or_insert((n, 0, 0));
                x.1 += 1;
                x.2 += (s.status == 2) as i32;
            }
            let hours: BTreeSet<i32> = v.iter().map(|(s, _)| s.start.div_euclid(NS_PER_HOUR) as i32).collect();
            Fragment {
                trace_id: t,
                min_start: v.iter().map(|(s, _)| s.start).min().unwrap(),
                max_end: v.iter().map(|(s, _)| s.end).max().unwrap(),
                span_count: v.len() as i32,
                error_count: v.iter().filter(|(s, _)| s.status == 2).count() as i32,
                root: root.map(|(s, e)| (service_of(e), s.name.clone(), s.start, s.span_id)),
                services: svc.into_values().collect(),
                services_truncated: false,
                hours: hours.into_iter().collect(),
            }
        })
        .collect()
}

fn check_span_files(batches: &[SpanBatchDef], rg_rows: usize) -> Result<(), TestCaseError> {
    let bytes: Vec<Vec<u8>> = batches.iter().map(|b| otel::encode_spans(&b.entries, &b.rows).unwrap()).collect();
    let refs: Vec<&[u8]> = bytes.iter().map(Vec::as_slice).collect();
    let files = encode_spans_with(&refs, &small(rg_rows)).unwrap();
    let reference = span_reference(batches);

    let mut seen = Vec::new();
    let mut last_hour = None;
    for f in files.iter().filter(|f| f.table == SignalTable::Spans) {
        let rows = read_spans(&f.bytes).unwrap();
        prop_assert_eq!(rows.len() as u64, f.rows);
        // Hour partitions, ascending.
        let hour = rows[0].start_unix_nano.div_euclid(NS_PER_HOUR);
        prop_assert!(last_hour < Some(hour));
        last_hour = Some(hour);
        prop_assert_eq!(f.hour, Some(hour.rem_euclid(24) as u8));
        prop_assert_eq!(&f.day, &viz_storage::day_of_ns(rows[0].start_unix_nano));
        for r in &rows {
            prop_assert_eq!(r.start_unix_nano.div_euclid(NS_PER_HOUR), hour);
        }
        // Sort order: service_name nulls first, span_name, start, trace_id, span_id.
        for w in rows.windows(2) {
            let k = |r: &viz_storage::SpanRecord| (r.service_name.clone().map(String::into_bytes), r.span_name.clone().into_bytes(), r.start_unix_nano, r.trace_id, r.span_id);
            prop_assert!(k(&w[0]) < k(&w[1]), "rows out of order");
        }
        check_span_fragment(f, &rows)?;
        seen.extend(rows);
    }
    prop_assert_eq!(seen.len(), reference.len());
    for r in &seen {
        let (s, e) = &reference[&(r.trace_id, r.span_id)];
        prop_assert_eq!(r.parent_span_id, (s.parent_span_id != [0; 8]).then_some(s.parent_span_id));
        prop_assert_eq!(r.start_unix_nano, s.start);
        prop_assert_eq!(r.end_unix_nano, s.end);
        prop_assert_eq!(r.duration_nano, s.end - s.start);
        prop_assert_eq!(r.start_time_us, s.start / 1000);
        prop_assert_eq!(&r.span_name, &s.name);
        prop_assert_eq!(r.span_kind, s.kind as i32);
        prop_assert_eq!(r.status_code, s.status as i32);
        prop_assert_eq!(r.trace_state.clone().unwrap_or_default(), s.trace_state.clone());
        prop_assert_eq!(r.status_message.clone().unwrap_or_default(), s.status_message.clone());
        prop_assert_eq!(r.flags, (s.flags != 0).then_some(s.flags as i32));
        prop_assert_eq!(r.dropped, s.dropped.map(|d| (d != 0).then_some(d as i32)));
        prop_assert_eq!(&r.attrs, &s.attrs);
        prop_assert_eq!(&r.resource, &e.resource);
        prop_assert_eq!(r.resource_fp, e.resource_fp);
        prop_assert_eq!(&r.service_name, &service_of(e));
        prop_assert_eq!(r.scope_name.clone().unwrap_or_default(), e.scope_name.clone());
        prop_assert_eq!(r.scope_version.clone().unwrap_or_default(), e.scope_version.clone());
        prop_assert_eq!(r.scope_attrs.clone().unwrap_or_default(), e.scope_attrs.clone());
        prop_assert_eq!(&r.events, &s.events);
        prop_assert_eq!(&r.links, &s.links);
    }

    // trace_index: one row per trace, in the day of its first start, sorted by trace id.
    let mut frags = Vec::new();
    let mut last_day = None;
    for f in files.iter().filter(|f| f.table == SignalTable::TraceIndex) {
        let rows = read_trace_index(&f.bytes).unwrap();
        prop_assert!(last_day < Some(f.day.clone()));
        last_day = Some(f.day.clone());
        for w in rows.windows(2) {
            prop_assert!(w[0].trace_id < w[1].trace_id);
        }
        for r in &rows {
            prop_assert_eq!(&viz_storage::day_of_ns(r.min_start), &f.day);
        }
        check_index_fragment(f, &rows)?;
        frags.extend(rows);
    }
    frags.sort_by_key(|f| f.trace_id);
    let all: Vec<_> = reference.into_values().collect();
    prop_assert_eq!(frags, index_reference(&all));
    Ok(())
}

fn json(s: &str) -> serde_like::J {
    serde_like::parse(s)
}

fn check_span_fragment(f: &viz_storage::SignalFile, rows: &[viz_storage::SpanRecord]) -> Result<(), TestCaseError> {
    let j = json(&f.index);
    prop_assert_eq!(j.get("v").int(), 1);
    let md = SerializedFileReader::new(bytes::Bytes::from(f.bytes.clone())).unwrap().metadata().clone();
    let rg = j.get("rg").arr();
    prop_assert_eq!(rg.len(), md.num_row_groups());
    let mut at = 0usize;
    for (g, e) in rg.iter().enumerate() {
        let n = e.get("rows").int() as usize;
        let part = &rows[at..at + n];
        at += n;
        prop_assert_eq!(n as i64, md.row_group(g).num_rows());
        let cols = md.row_group(g).columns();
        let off = cols.iter().map(|c| c.byte_range().0).min().unwrap();
        let end = cols.iter().map(|c| c.byte_range().0 + c.byte_range().1).max().unwrap();
        prop_assert_eq!(e.get("off").int() as u64, off);
        prop_assert_eq!(e.get("len").int() as u64, end - off);
        prop_assert_eq!(e.get("min_name").str(), part[0].service_name.clone().unwrap_or_default());
        prop_assert_eq!(e.get("max_name").str(), part[n - 1].service_name.clone().unwrap_or_default());
        prop_assert_eq!(e.get("min_ts").int(), part.iter().map(|r| r.start_unix_nano).min().unwrap());
        prop_assert_eq!(e.get("max_ts").int(), part.iter().map(|r| r.start_unix_nano).max().unwrap());
        prop_assert_eq!(e.get("min_dur").int(), part.iter().map(|r| r.duration_nano).min().unwrap());
        prop_assert_eq!(e.get("max_dur").int(), part.iter().map(|r| r.duration_nano).max().unwrap());
    }
    prop_assert_eq!(at, rows.len());
    let foot = j.get("foot").arr();
    let last = md.row_groups().iter().map(|g| g.columns().iter().map(|c| c.byte_range().0 + c.byte_range().1).max().unwrap()).max().unwrap();
    prop_assert_eq!(foot[0].int() as u64, last);
    prop_assert_eq!((foot[0].int() + foot[1].int()) as usize, f.bytes.len());
    Ok(())
}

fn check_index_fragment(f: &viz_storage::SignalFile, rows: &[Fragment]) -> Result<(), TestCaseError> {
    let j = json(&f.index);
    let mut at = 0usize;
    for e in j.get("rg").arr() {
        let n = e.get("rows").int() as usize;
        let part = &rows[at..at + n];
        at += n;
        prop_assert_eq!(e.get("min_tid").str(), hex(&part[0].trace_id));
        prop_assert_eq!(e.get("max_tid").str(), hex(&part[n - 1].trace_id));
        prop_assert_eq!(e.get("min_ts").int(), part.iter().map(|r| r.min_start).min().unwrap());
        prop_assert_eq!(e.get("max_ts").int(), part.iter().map(|r| r.max_end).max().unwrap());
    }
    prop_assert_eq!(at, rows.len());
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 150, ..ProptestConfig::default() })]

    /// Decode, flush, read back: every span with every attribute, the later duplicate
    /// winning, in the contract's order and partitions, with fragments that agree.
    #[test]
    fn spans_flush_and_read_back(batches in prop::collection::vec(arb_span_batch(), 1..4), rg in 1usize..6) {
        check_span_files(&batches, rg)?;
    }

    #[test]
    fn logs_flush_and_read_back(batches in prop::collection::vec(arb_log_batch(), 1..4), rg in 1usize..6) {
        check_log_files(&batches, rg)?;
    }

    /// The same rows, split into batches differently, give the same bytes (no duplicates).
    #[test]
    fn flush_is_deterministic(b in arb_span_batch(), l in arb_log_batch(), cut in 0usize..20) {
        let b = dedup_spans(b);
        let one = otel::encode_spans(&b.entries, &b.rows).unwrap();
        let cut = cut.min(b.rows.len());
        let (x, y) = (SpanBatchDef { entries: b.entries.clone(), rows: b.rows[..cut].to_vec() }, SpanBatchDef { entries: b.entries.clone(), rows: b.rows[cut..].to_vec() });
        let two: Vec<Vec<u8>> = [x, y].iter().filter(|p| !p.rows.is_empty()).map(|p| otel::encode_spans(&p.entries, &p.rows).unwrap()).collect();
        let a = encode_spans(&[&one]).unwrap();
        let c = encode_spans(&two.iter().map(Vec::as_slice).collect::<Vec<_>>()).unwrap();
        prop_assert_eq!(a, c);

        let l = dedup_logs(l);
        let one = otel::encode_logs(&l.streams, &l.rows).unwrap();
        let cut = cut.min(l.rows.len());
        let parts = [&l.rows[..cut], &l.rows[cut..]];
        let two: Vec<Vec<u8>> = parts.iter().filter(|p| !p.is_empty()).map(|p| otel::encode_logs(&l.streams, p).unwrap()).collect();
        prop_assert_eq!(encode_logs(&[&one]).unwrap(), encode_logs(&two.iter().map(Vec::as_slice).collect::<Vec<_>>()).unwrap());
    }
}

/// trace_index fragments merge into what one fragment of every span would say.
#[test]
fn fragments_merge_as_the_contract_says() {
    let mut runner = proptest::test_runner::TestRunner::deterministic();
    for _ in 0..100 {
        let batches = prop::collection::vec(arb_span_batch(), 2..4).new_tree(&mut runner).unwrap().current();
        let mut per_batch: Vec<Fragment> = Vec::new();
        for b in &batches {
            let bytes = otel::encode_spans(&b.entries, &b.rows).unwrap();
            for f in encode_spans(&[&bytes]).unwrap().iter().filter(|f| f.table == SignalTable::TraceIndex) {
                per_batch.extend(read_trace_index(&f.bytes).unwrap());
            }
        }
        // Without duplicates across batches, merging per-batch fragments equals one flush.
        let mut seen = std::collections::HashSet::new();
        let unique = batches.iter().all(|b| b.rows.iter().all(|r| seen.insert((r.trace_id, r.span_id))));
        if !unique {
            continue;
        }
        let all: Vec<Vec<u8>> = batches.iter().map(|b| otel::encode_spans(&b.entries, &b.rows).unwrap()).collect();
        let whole: Vec<Fragment> = encode_spans(&all.iter().map(Vec::as_slice).collect::<Vec<_>>())
            .unwrap()
            .iter()
            .filter(|f| f.table == SignalTable::TraceIndex)
            .flat_map(|f| read_trace_index(&f.bytes).unwrap())
            .collect();
        let mut by: HashMap<[u8; 16], Vec<Fragment>> = HashMap::new();
        for f in per_batch {
            by.entry(f.trace_id).or_default().push(f);
        }
        for w in whole {
            let merged = merge_fragments(&by[&w.trace_id]).unwrap();
            assert_eq!(merged, w);
        }
    }
}

#[test]
fn services_are_capped_at_64_by_spans() {
    let mut entries = Vec::new();
    let mut rows = Vec::new();
    for k in 0..70u32 {
        entries.push(SpanEntry { resource_fp: k as i64, resource: vec![Attr { key: "service.name".into(), value: Value::Str(format!("svc{k:02}")) }], scope_name: String::new(), scope_version: String::new(), scope_attrs: String::new() });
        // svc00..svc05 get 1 span, the others 2: the six with one span are cut.
        for j in 0..(if k < 6 { 1 } else { 2 }) {
            rows.push(span(k, [7; 16], [k as u8 + 1, j + 1, 0, 0, 0, 0, 0, 1], MIDNIGHT));
        }
    }
    let bytes = otel::encode_spans(&entries, &rows).unwrap();
    let files = encode_spans(&[&bytes]).unwrap();
    let idx: Vec<Fragment> = files.iter().filter(|f| f.table == SignalTable::TraceIndex).flat_map(|f| read_trace_index(&f.bytes).unwrap()).collect();
    assert_eq!(idx.len(), 1);
    assert!(idx[0].services_truncated);
    assert_eq!(idx[0].services.len(), 64);
    assert_eq!(idx[0].services[0].0, "svc06");
    assert!(idx[0].services.iter().all(|s| s.1 == 2));
    assert_eq!(idx[0].span_count, 6 + 64 * 2);
}

/// Promotion: a key goes to its column only with the column's type; the older
/// `deployment.environment` stays residual; non-string `service.name` is residual.
#[test]
fn promoted_columns_hold_exactly_their_keys() {
    let entries = vec![
        SpanEntry {
            resource_fp: 1,
            resource: sorted(vec![
                Attr { key: "service.name".into(), value: Value::Str("api".into()) },
                Attr { key: "deployment.environment".into(), value: Value::Str("old".into()) },
                Attr { key: "deployment.environment.name".into(), value: Value::Str("prod".into()) },
                Attr { key: "k8s.pod.name".into(), value: Value::Int(5) },
                Attr { key: "cloud.region".into(), value: Value::Str("eu".into()) },
            ]),
            scope_name: "lib".into(),
            scope_version: "1".into(),
            scope_attrs: String::new(),
        },
        SpanEntry { resource_fp: 2, resource: vec![Attr { key: "service.name".into(), value: Value::Int(3) }], scope_name: String::new(), scope_version: String::new(), scope_attrs: String::new() },
    ];
    let mut a = span(0, [1; 16], [1; 8], MIDNIGHT);
    a.attrs = sorted(vec![
        Attr { key: "http.response.status_code".into(), value: Value::Int(503) },
        Attr { key: "http.request.method".into(), value: Value::Str("GET".into()) },
        Attr { key: "http.route".into(), value: Value::Int(1) },
        Attr { key: "error.type".into(), value: Value::Str("timeout".into()) },
    ]);
    let mut b = span(1, [1; 16], [2; 8], MIDNIGHT + 1);
    b.attrs = vec![Attr { key: "http.response.status_code".into(), value: Value::Str("200".into()) }];
    let bytes = otel::encode_spans(&entries, &[a.clone(), b.clone()]).unwrap();
    let files = encode_spans(&[&bytes]).unwrap();
    let f = files.iter().find(|f| f.table == SignalTable::Spans).unwrap();
    let r = SerializedFileReader::new(bytes::Bytes::from(f.bytes.clone())).unwrap();
    let rows: Vec<parquet::record::Row> = r.get_row_iter(None).unwrap().map(Result::unwrap).collect();
    let col = |row: &parquet::record::Row, n: &str| row.get_column_iter().find(|(k, _)| k.as_str() == n).unwrap().1.to_string();
    // Row order: null service first (entry 1), then "api".
    assert_eq!(col(&rows[0], "service_name"), "null");
    assert!(col(&rows[0], "resource_attrs_int").contains("service.name"));
    assert_eq!(col(&rows[0], "s_http_response_status_code"), "null");
    assert!(col(&rows[0], "span_attrs_str").contains("http.response.status_code"));
    assert_eq!(col(&rows[1], "service_name"), "\"api\"");
    assert_eq!(col(&rows[1], "r_deployment_environment"), "\"prod\"");
    assert!(col(&rows[1], "resource_attrs_str").contains("deployment.environment"));
    assert!(!col(&rows[1], "resource_attrs_str").contains("prod"));
    assert_eq!(col(&rows[1], "r_k8s_pod_name"), "null");
    assert!(col(&rows[1], "resource_attrs_int").contains("k8s.pod.name"));
    assert_eq!(col(&rows[1], "r_cloud_region"), "\"eu\"");
    assert_eq!(col(&rows[1], "s_http_response_status_code"), "503");
    assert_eq!(col(&rows[1], "s_http_request_method"), "\"GET\"");
    assert_eq!(col(&rows[1], "s_error_type"), "\"timeout\"");
    assert_eq!(col(&rows[1], "s_http_route"), "null");
    assert!(col(&rows[1], "span_attrs_int").contains("http.route"));
    assert_eq!(col(&rows[1], "span_attrs_str"), "null");
    // And the logical view gives every attribute back.
    let back = read_spans(&f.bytes).unwrap();
    assert_eq!(back[1].resource, entries[0].resource);
    assert_eq!(back[1].attrs, a.attrs);
    assert_eq!(back[0].attrs, b.attrs);
}

/// The file properties the contract states.
#[test]
fn span_and_log_files_have_the_contract_layout() {
    let mut runner = proptest::test_runner::TestRunner::deterministic();
    let b = arb_span_batch().new_tree(&mut runner).unwrap().current();
    let bytes = otel::encode_spans(&b.entries, &b.rows).unwrap();
    for f in encode_spans(&[&bytes]).unwrap() {
        let r = SerializedFileReader::new(bytes::Bytes::from(f.bytes.clone())).unwrap();
        let md = r.metadata();
        assert_eq!(md.file_metadata().created_by(), Some("viz-storage"));
        let names: Vec<String> = md.file_metadata().schema_descr().columns().iter().map(|c| c.path().string()).collect();
        for g in md.row_groups() {
            for (k, c) in g.columns().iter().enumerate() {
                assert_eq!(c.compression(), parquet::basic::Compression::SNAPPY, "{}", names[k]);
                assert!(c.offset_index_offset().is_some(), "offset index on {}", names[k]);
            }
            let by = |n: &str| &g.columns()[names.iter().position(|x| x == n).unwrap()];
            if f.table == SignalTable::Spans {
                assert!(by("trace_id").bloom_filter_offset().is_some());
                for n in ["service_name", "span_name", "start_unix_nano", "duration_nano"] {
                    assert!(by(n).column_index_offset().is_some(), "page index on {n}");
                    assert!(by(n).statistics().is_some());
                }
                assert!(by("trace_id").dictionary_page_offset().is_none());
                assert!(by("span_attrs_str.key_value.value").statistics().is_none());
                let sc = g.sorting_columns().unwrap();
                assert_eq!(sc.iter().map(|s| names[s.column_idx as usize].as_str()).collect::<Vec<_>>(), ["service_name", "span_name", "start_unix_nano"]);
                assert!(sc[0].nulls_first);
            } else {
                assert!(by("trace_id").column_index_offset().is_some());
                assert_eq!(names[g.sorting_columns().unwrap()[0].column_idx as usize], "trace_id");
            }
        }
    }
    let l = arb_log_batch().new_tree(&mut runner).unwrap().current();
    let bytes = otel::encode_logs(&l.streams, &l.rows).unwrap();
    for f in encode_logs(&[&bytes]).unwrap() {
        let r = SerializedFileReader::new(bytes::Bytes::from(f.bytes.clone())).unwrap();
        let md = r.metadata();
        let names: Vec<String> = md.file_metadata().schema_descr().columns().iter().map(|c| c.path().string()).collect();
        assert_eq!(
            names,
            ["service_name", "stream_id", "ts", "labels", "line", "metadata.key_value.key", "metadata.key_value.value", "observed_ts", "severity_number", "severity_text", "trace_id", "span_id", "flags"]
        );
        for g in md.row_groups() {
            let by = |n: &str| &g.columns()[names.iter().position(|x| x == n).unwrap()];
            assert!(by("trace_id").bloom_filter_offset().is_some());
            for n in ["service_name", "stream_id", "ts"] {
                assert!(by(n).statistics().is_some(), "{n}");
            }
            for n in ["labels", "line"] {
                assert!(by(n).statistics().is_none(), "{n}");
            }
            assert!(by("line").dictionary_page_offset().is_none());
            assert!(by("labels").dictionary_page_offset().is_some());
            let sc = g.sorting_columns().unwrap();
            assert_eq!(sc.iter().map(|s| names[s.column_idx as usize].as_str()).collect::<Vec<_>>(), ["service_name", "stream_id", "ts"]);
        }
    }
}

// ───────────────────────────── logs flush ─────────────────────────────

fn check_log_files(batches: &[LogBatchDef], rg_rows: usize) -> Result<(), TestCaseError> {
    let bytes: Vec<Vec<u8>> = batches.iter().map(|b| otel::encode_logs(&b.streams, &b.rows).unwrap()).collect();
    let refs: Vec<&[u8]> = bytes.iter().map(Vec::as_slice).collect();
    let files = encode_logs_with(&refs, &small(rg_rows)).unwrap();

    // Reference: replay in arrival order; the later of equal row keys wins.
    let mut m: BTreeMap<(i64, i64, String, Vec<(String, String)>), (LogRow<String>, LogStream<String>)> = BTreeMap::new();
    for b in batches {
        for r in &b.rows {
            let s = &b.streams[r.entry as usize];
            m.insert((s.stream_id, r.ts, r.line.clone(), r.metadata.clone()), (r.clone(), s.clone()));
        }
    }
    let svc = |s: &LogStream<String>| s.labels.iter().find(|(n, _)| n == "service_name").map_or(String::new(), |(_, v)| v.clone());
    let mut want: Vec<(LogRow<String>, LogStream<String>)> = m.into_values().collect();
    want.sort_by(|a, b| {
        let k = |x: &(LogRow<String>, LogStream<String>)| {
            (x.0.ts.div_euclid(NS_PER_DAY), svc(&x.1).into_bytes(), x.1.stream_id, x.0.ts, x.0.line.clone().into_bytes(), x.0.metadata.iter().map(|(n, v)| (n.clone().into_bytes(), v.clone().into_bytes())).collect::<Vec<_>>())
        };
        k(a).cmp(&k(b))
    });

    let mut got = Vec::new();
    let mut last_day = None;
    for f in &files {
        prop_assert_eq!(f.table, SignalTable::Logs);
        let rows = read_logs(&f.bytes).unwrap();
        prop_assert_eq!(rows.len() as u64, f.rows);
        prop_assert!(last_day < Some(f.day.clone()));
        last_day = Some(f.day.clone());
        for r in &rows {
            prop_assert_eq!(&viz_storage::day_of_ns(r.ts), &f.day);
        }
        check_log_fragment(f, &rows)?;
        got.extend(rows);
    }
    prop_assert_eq!(got.len(), want.len());
    for (g, (r, s)) in got.iter().zip(&want) {
        prop_assert_eq!(g.stream_id, s.stream_id);
        prop_assert_eq!(&g.labels, &s.labels);
        prop_assert_eq!(&g.labels_json, &viz_storage::json::labels_to_json(&s.labels));
        prop_assert_eq!(&g.service_name, &svc(s));
        prop_assert_eq!(g.ts, r.ts);
        prop_assert_eq!(&g.line, &r.line);
        prop_assert_eq!(&g.metadata, &r.metadata);
        prop_assert_eq!(g.observed_ts, (r.observed_ts != 0).then_some(r.observed_ts));
        prop_assert_eq!(g.severity_number, (r.severity_number != 0).then_some(r.severity_number as i32));
        prop_assert_eq!(g.severity_text.clone().unwrap_or_default(), r.severity_text.clone());
        prop_assert_eq!(g.trace_id, (r.trace_id != [0; 16]).then_some(r.trace_id));
        prop_assert_eq!(g.span_id, (r.span_id != [0; 8]).then_some(r.span_id));
        prop_assert_eq!(g.flags, (r.flags != 0).then_some(r.flags as i32));
    }
    Ok(())
}

fn check_log_fragment(f: &viz_storage::SignalFile, rows: &[viz_storage::LogRecord]) -> Result<(), TestCaseError> {
    let j = json(&f.index);
    let md = SerializedFileReader::new(bytes::Bytes::from(f.bytes.clone())).unwrap().metadata().clone();
    let mut at = 0usize;
    let mut rg_of = Vec::new();
    for (g, e) in j.get("rg").arr().iter().enumerate() {
        let n = e.get("rows").int() as usize;
        let part = &rows[at..at + n];
        rg_of.extend(std::iter::repeat_n(g, n));
        at += n;
        prop_assert_eq!(n as i64, md.row_group(g).num_rows());
        prop_assert_eq!(e.get("min_name").str(), part[0].service_name.clone());
        prop_assert_eq!(e.get("max_name").str(), part[n - 1].service_name.clone());
        prop_assert_eq!(e.get("min_ts").int(), part.iter().map(|r| r.ts).min().unwrap());
        prop_assert_eq!(e.get("max_ts").int(), part.iter().map(|r| r.ts).max().unwrap());
        let sid = e.get("sid").arr();
        prop_assert_eq!(sid[0].int(), part[0].stream_id);
        prop_assert_eq!(sid[1].int(), part[n - 1].stream_id);
    }
    prop_assert_eq!(at, rows.len());
    // Streams, in file order, with time and row-group ranges.
    let mut want: Vec<(i64, String, i64, i64, usize, usize)> = Vec::new();
    for (k, r) in rows.iter().enumerate() {
        match want.last_mut() {
            Some(w) if w.0 == r.stream_id && w.1 == r.labels_json => {
                w.2 = w.2.min(r.ts);
                w.3 = w.3.max(r.ts);
                w.5 = rg_of[k];
            }
            _ => want.push((r.stream_id, r.labels_json.clone(), r.ts, r.ts, rg_of[k], rg_of[k])),
        }
    }
    let streams = j.opt("streams");
    if want.len() <= viz_storage::FRAGMENT_MAX_STREAMS && want.iter().map(|w| w.1.len()).sum::<usize>() <= viz_storage::FRAGMENT_MAX_LABEL_BYTES {
        let s = streams.expect("streams listed").arr();
        prop_assert_eq!(s.len(), want.len());
        for (x, w) in s.iter().zip(&want) {
            let x = x.arr();
            prop_assert_eq!(x[0].int(), w.0);
            prop_assert_eq!(x[1].str(), w.1.clone());
            prop_assert_eq!((x[2].int(), x[3].int(), x[4].int() as usize, x[5].int() as usize), (w.2, w.3, w.4, w.5));
        }
    } else {
        prop_assert!(streams.is_none());
    }
    Ok(())
}

/// `line` data pages never exceed 1 MiB uncompressed, whatever the lines' sizes.
#[test]
fn line_pages_are_at_most_one_mib() {
    let streams = vec![LogStream { stream_id: otel::stream_id(&[("service_name", "a")]), labels: vec![("service_name".to_string(), "a".to_string())] }];
    let mut rows = Vec::new();
    let sizes = [262_144usize, 1, 200_000, 262_000, 5, 131_072, 262_144, 262_144, 262_143, 70_000, 262_144, 3];
    for k in 0..60 {
        let n = sizes[k % sizes.len()];
        rows.push(log_row(0, MIDNIGHT + k as i64, &"x".repeat(n)));
    }
    let mut batches = Vec::new();
    for chunk in rows.chunks(2) {
        batches.push(otel::encode_logs(&streams, chunk).unwrap());
    }
    let files = encode_logs(&batches.iter().map(Vec::as_slice).collect::<Vec<_>>()).unwrap();
    let mut pages = 0;
    for f in &files {
        let r = SerializedFileReader::new(bytes::Bytes::from(f.bytes.clone())).unwrap();
        for g in 0..r.num_row_groups() {
            let rg = r.get_row_group(g).unwrap();
            let mut pr = rg.get_column_page_reader(4).unwrap();
            while let Some(p) = pr.get_next_page().unwrap() {
                assert!(p.buffer().len() <= 1 << 20, "line page of {} bytes", p.buffer().len());
                pages += 1;
            }
        }
        assert!(read_logs(&f.bytes).unwrap().iter().all(|r| r.line.len() <= 262_144));
    }
    assert!(pages >= 10, "{pages} pages");
}

/// Row groups are cut at the row cap and at the byte cap.
#[test]
fn row_groups_respect_both_caps() {
    let streams = vec![LogStream { stream_id: otel::stream_id(&[("a", "b")]), labels: vec![("a".to_string(), "b".to_string())] }];
    let rows: Vec<_> = (0..40).map(|k| log_row(0, MIDNIGHT + k, &"y".repeat(1000))).collect();
    let bytes = otel::encode_logs(&streams, &rows).unwrap();
    let opts = SignalWriteOptions { max_row_group_rows: 7, max_row_group_bytes: 3 * 1066, page_rows: 20_000 };
    let f = &encode_logs_with(&[&bytes], &opts).unwrap()[0];
    let r = SerializedFileReader::new(bytes::Bytes::from(f.bytes.clone())).unwrap();
    // Each row weighs 64 + 1000 + 2 = 1066: three to a row group.
    let sizes: Vec<i64> = r.metadata().row_groups().iter().map(|g| g.num_rows()).collect();
    assert!(sizes.iter().all(|n| *n == 3 || *n == 1), "{sizes:?}");
    let opts = SignalWriteOptions { max_row_group_rows: 7, max_row_group_bytes: 16 << 20, page_rows: 20_000 };
    let f = &encode_logs_with(&[&bytes], &opts).unwrap()[0];
    let r = SerializedFileReader::new(bytes::Bytes::from(f.bytes.clone())).unwrap();
    let sizes: Vec<i64> = r.metadata().row_groups().iter().map(|g| g.num_rows()).collect();
    assert_eq!(sizes, [7, 7, 7, 7, 7, 5]);
}

/// Split boundaries: an hour and a day boundary in spans, a day boundary in logs.
#[test]
fn partitions_split_at_hour_and_day_boundaries() {
    let e = vec![SpanEntry { resource_fp: 0, resource: Vec::new(), scope_name: String::new(), scope_version: String::new(), scope_attrs: String::new() }];
    let rows: Vec<_> = [MIDNIGHT - 1, MIDNIGHT, MIDNIGHT + NS_PER_HOUR - 1, MIDNIGHT + NS_PER_HOUR].iter().enumerate().map(|(k, t)| span(0, [k as u8 + 1; 16], [1; 8], *t)).collect();
    let bytes = otel::encode_spans(&e, &rows).unwrap();
    let files = encode_spans(&[&bytes]).unwrap();
    let parts: Vec<(SignalTable, String, Option<u8>, u64)> = files.iter().map(|f| (f.table, f.day.clone(), f.hour, f.rows)).collect();
    assert_eq!(
        parts,
        [
            (SignalTable::Spans, "2023-11-14".into(), Some(23), 1),
            (SignalTable::Spans, "2023-11-15".into(), Some(0), 2),
            (SignalTable::Spans, "2023-11-15".into(), Some(1), 1),
            (SignalTable::TraceIndex, "2023-11-14".into(), None, 1),
            (SignalTable::TraceIndex, "2023-11-15".into(), None, 3),
        ]
    );
    let s = vec![LogStream { stream_id: otel::stream_id(&[("a", "b")]), labels: vec![("a".to_string(), "b".to_string())] }];
    let rows = vec![log_row(0, MIDNIGHT - 1, "a"), log_row(0, MIDNIGHT, "b"), log_row(0, 0, "epoch"), log_row(0, i64::MAX, "last")];
    let files = encode_logs(&[&otel::encode_logs(&s, &rows).unwrap()]).unwrap();
    let days: Vec<(String, u64)> = files.iter().map(|f| (f.day.clone(), f.rows)).collect();
    assert_eq!(days, [("1970-01-01".into(), 1), ("2023-11-14".into(), 1), ("2023-11-15".into(), 1), ("2262-04-11".into(), 1)]);
}

/// The fragment omits `streams` past its bounds.
#[test]
fn fragment_stream_list_is_bounded() {
    let streams: Vec<LogStream<String>> = (0..257).map(|k| {
        let labels = vec![("s".to_string(), format!("{k}"))];
        LogStream { stream_id: otel::stream_id(&labels), labels }
    }).collect();
    let rows: Vec<_> = (0..257).map(|k| log_row(k, MIDNIGHT, "x")).collect();
    let f = &encode_logs(&[&otel::encode_logs(&streams, &rows).unwrap()]).unwrap()[0];
    assert!(!f.index.contains("\"streams\""));
    let f = &encode_logs(&[&otel::encode_logs(&streams[..256], &rows[..256]).unwrap()]).unwrap()[0];
    assert!(f.index.contains("\"streams\""));
}

#[test]
fn stream_id_is_series_id() {
    // Computed in Python with arbitrary-precision integers: FNV-1a 64 over
    // b"service_name\0api\0" and b"job\0x\0service_name\0\xc3\xa9\0", as signed.
    let l = [("service_name", "api")];
    assert_eq!(otel::stream_id(&l), viz_storage::batch::series_id(&l));
    assert_eq!(otel::stream_id(&l), 2773401598297507630);
    assert_eq!(otel::stream_id(&[("job", "x"), ("service_name", "é")]), 8990786946435549823);
    assert_eq!(py_fnv(&[("job", "x"), ("service_name", "é")]), 8990786946435549823);
}
