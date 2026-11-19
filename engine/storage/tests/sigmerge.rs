//! Compaction of the span and log tables (contracts/TRACES.md and LOGS.md, "Compaction") and the
//! `logs` token filter (LOGS.md §6).
//!
//! Every property generates flush units (each a list of batches, flushed together as flush
//! does), merges each partition's files in unit order, and requires:
//!
//! * the merged rows, read back, equal a reference computed from the batches alone (duplicates
//!   resolved: within a unit the later row, across units the later unit);
//! * the merged bytes equal one flush of a batch holding exactly the reference rows (so sort
//!   order, row groups, pages, statistics and fragment are flush's); `logs` without the filter;
//! * merging in two steps (some inputs first, then the rest with that output) gives the same
//!   bytes as one merge;
//! * `logs`: the filter lists exactly the tokens of each row group, computed here by a
//!   tokenizer of its own; `may_match` never says no to a row group holding a matching line.
mod otelgen;

use otelgen::*;
use parquet::file::reader::{FileReader, SerializedFileReader};
use proptest::prelude::*;
use std::collections::{BTreeMap, BTreeSet};
use viz_storage::otel::{self, LogRow, LogStream, Span, SpanEntry, Value};
use viz_storage::tokens::{self, literal_tokens, token_filter_location, TokenFilter, TokenFilterBuilder};
use viz_storage::{
    encode_logs_with, encode_spans_with, merge_signal_files_shared, read_logs, read_logs_row_groups, read_spans, read_trace_index, Fragment, SignalFile,
    SignalMergeOptions, SignalTable, SignalWriteOptions, NS_PER_DAY, NS_PER_HOUR,
};

fn small(rows: usize) -> SignalWriteOptions {
    SignalWriteOptions { max_row_group_rows: rows, max_row_group_bytes: 16 << 20, page_rows: 3 }
}

fn merge(table: SignalTable, files: &[&SignalFile], write: &SignalWriteOptions, token_filter: bool) -> SignalFile {
    let inputs: Vec<bytes::Bytes> = files.iter().map(|f| bytes::Bytes::from(f.bytes.clone())).collect();
    merge_signal_files_shared(table, &inputs, &SignalMergeOptions { write: write.clone(), token_filter, ..Default::default() }).unwrap()
}

/// Merge `files` in two steps (the first `cut` of them, then that output with the rest).
fn merge_twice(table: SignalTable, files: &[&SignalFile], cut: usize, write: &SignalWriteOptions, token_filter: bool) -> SignalFile {
    let cut = cut.clamp(1, files.len());
    let first = merge(table, &files[..cut], write, token_filter);
    let mut rest: Vec<&SignalFile> = vec![&first];
    rest.extend(&files[cut..]);
    merge(table, &rest, write, token_filter)
}

// ───────────────────────────── spans ─────────────────────────────

type SpanKey = ([u8; 16], [u8; 8]);

/// A unit's spans as flush keeps them: the later row wins per (trace_id, span_id).
fn unit_spans(unit: &[SpanBatchDef]) -> BTreeMap<SpanKey, (Span<String>, SpanEntry<String>)> {
    let mut m = BTreeMap::new();
    for b in unit {
        for r in &b.rows {
            m.insert((r.trace_id, r.span_id), (r.clone(), b.entries[r.entry as usize].clone()));
        }
    }
    m
}

fn flush_spans(unit: &[SpanBatchDef], o: &SignalWriteOptions) -> Vec<SignalFile> {
    let bytes: Vec<Vec<u8>> = unit.iter().map(|b| otel::encode_spans(&b.entries, &b.rows).unwrap()).collect();
    encode_spans_with(&bytes.iter().map(Vec::as_slice).collect::<Vec<_>>(), o).unwrap()
}

/// One batch holding exactly these spans (one entry per row).
fn span_batch(rows: &[(Span<String>, SpanEntry<String>)]) -> Vec<u8> {
    let entries: Vec<SpanEntry<String>> = rows.iter().map(|(_, e)| e.clone()).collect();
    let spans: Vec<Span<String>> = rows.iter().enumerate().map(|(i, (s, _))| Span { entry: i as u32, ..s.clone() }).collect();
    otel::encode_spans(&entries, &spans).unwrap()
}

fn json(s: &str) -> serde_like::J {
    serde_like::parse(s)
}

/// The fragment's row groups against the file's footer; `foot` and (logs) `tok` against the file.
fn check_fragment(f: &SignalFile) -> Result<serde_like::J, TestCaseError> {
    let j = json(&f.index);
    prop_assert_eq!(j.get("v").int(), 1);
    let md = SerializedFileReader::new(bytes::Bytes::from(f.bytes.clone())).unwrap().metadata().clone();
    let rg = j.get("rg").arr();
    prop_assert_eq!(rg.len(), md.num_row_groups());
    let mut total = 0;
    let mut last_end = 0;
    for (g, e) in rg.iter().enumerate() {
        let cols = md.row_group(g).columns();
        let off = cols.iter().map(|c| c.byte_range().0).min().unwrap();
        let end = cols.iter().map(|c| c.byte_range().0 + c.byte_range().1).max().unwrap();
        prop_assert_eq!(e.get("off").int() as u64, off);
        prop_assert_eq!(e.get("len").int() as u64, end - off);
        prop_assert_eq!(e.get("rows").int(), md.row_group(g).num_rows());
        total += md.row_group(g).num_rows();
        last_end = end;
    }
    prop_assert_eq!(total as u64, f.rows);
    let foot = j.get("foot").arr();
    prop_assert_eq!((foot[0].int() + foot[1].int()) as usize, f.bytes.len());
    match j.opt("tok") {
        Some(t) => {
            let t = t.arr();
            let (o, l) = (t[0].int() as u64, t[1].int() as u64);
            prop_assert!(o >= last_end, "the filter lies after the last row group");
            prop_assert_eq!(foot[0].int() as u64, o + l, "foot starts where the filter ends");
            prop_assert_eq!(token_filter_location(&f.bytes), Some((o, l)));
        }
        None => {
            prop_assert_eq!(foot[0].int() as u64, last_end);
            prop_assert_eq!(token_filter_location(&f.bytes), None);
        }
    }
    Ok(j)
}

fn check_spans_merge(units: &[Vec<SpanBatchDef>], rg: usize, cut: usize) -> Result<(), TestCaseError> {
    let o = small(rg);
    let flushed: Vec<Vec<SignalFile>> = units.iter().map(|u| flush_spans(u, &o)).collect();
    let kept: Vec<_> = units.iter().map(|u| unit_spans(u)).collect();
    let hours: BTreeSet<i64> = kept.iter().flat_map(|m| m.values().map(|(s, _)| s.start.div_euclid(NS_PER_HOUR))).collect();
    for h in hours {
        let inputs: Vec<&SignalFile> = flushed.iter().flatten().filter(|f| f.table == SignalTable::Spans && f.min_ts.div_euclid(NS_PER_HOUR) == h).collect();
        let mut reference: BTreeMap<SpanKey, (Span<String>, SpanEntry<String>)> = BTreeMap::new();
        for m in &kept {
            for (k, v) in m.iter().filter(|(_, (s, _))| s.start.div_euclid(NS_PER_HOUR) == h) {
                reference.insert(*k, v.clone());
            }
        }
        let out = merge(SignalTable::Spans, &inputs, &o, true);
        prop_assert_eq!(out.hour, Some(h.rem_euclid(24) as u8));
        prop_assert_eq!(out.rows as usize, reference.len());
        // Every reference row, read back, with its later version.
        let back = read_spans(&out.bytes).unwrap();
        prop_assert_eq!(back.len(), reference.len());
        for r in &back {
            let (s, e) = &reference[&(r.trace_id, r.span_id)];
            prop_assert_eq!((r.start_unix_nano, r.end_unix_nano, &r.span_name, &r.attrs, &r.resource), (s.start, s.end, &s.name, &s.attrs, &e.resource));
            prop_assert_eq!((&r.events, &r.links, r.resource_fp), (&s.events, &s.links, e.resource_fp));
        }
        // Byte for byte one flush of exactly those rows.
        let rows: Vec<_> = reference.values().cloned().collect();
        let one = encode_spans_with(&[&span_batch(&rows)], &o).unwrap();
        let want = one.iter().find(|f| f.table == SignalTable::Spans).unwrap();
        prop_assert!(out.bytes == want.bytes, "hour {h}: merged bytes differ from a flush of the same rows");
        prop_assert_eq!(&out.index, &want.index);
        prop_assert_eq!((out.min_ts, out.max_ts, &out.day), (want.min_ts, want.max_ts, &want.day));
        check_fragment(&out)?;
        // In two steps, the same bytes.
        prop_assert!(merge_twice(SignalTable::Spans, &inputs, cut, &o, true).bytes == out.bytes, "two-step merge differs");
    }
    Ok(())
}

// ───────────────────────────── trace_index ─────────────────────────────

fn service_of(e: &SpanEntry<String>) -> Option<String> {
    e.resource.iter().find(|a| a.key == "service.name").and_then(|a| match &a.value {
        Value::Str(s) => Some(s.clone()),
        _ => None,
    })
}

/// A unit's fragments, from its kept spans (TRACES.md, independently of the crate).
fn unit_fragments(spans: &BTreeMap<SpanKey, (Span<String>, SpanEntry<String>)>) -> Vec<Fragment> {
    let mut by: BTreeMap<[u8; 16], Vec<&(Span<String>, SpanEntry<String>)>> = BTreeMap::new();
    for v in spans.values() {
        by.entry(v.0.trace_id).or_default().push(v);
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
            Fragment {
                trace_id: t,
                min_start: v.iter().map(|(s, _)| s.start).min().unwrap(),
                max_end: v.iter().map(|(s, _)| s.end).max().unwrap(),
                span_count: v.len() as i32,
                error_count: v.iter().filter(|(s, _)| s.status == 2).count() as i32,
                root: root.map(|(s, e)| (service_of(e), s.name.clone(), s.start, s.span_id)),
                services: svc.into_values().collect(),
                services_truncated: false,
                hours: v.iter().map(|(s, _)| s.start.div_euclid(NS_PER_HOUR) as i32).collect::<BTreeSet<_>>().into_iter().collect(),
            }
        })
        .collect()
}

/// Fragments of one trace merged as TRACES.md says, at most 64 services (written here, not the crate's).
fn merged(frags: &[Fragment]) -> Fragment {
    let mut svc: BTreeMap<Vec<u8>, (String, i32, i32)> = BTreeMap::new();
    for f in frags {
        for (n, s, e) in &f.services {
            let x = svc.entry(n.as_bytes().to_vec()).or_insert((n.clone(), 0, 0));
            x.1 += s;
            x.2 += e;
        }
    }
    let mut services: Vec<(String, i32, i32)> = svc.into_values().collect();
    let mut truncated = frags.iter().any(|f| f.services_truncated);
    if services.len() > 64 {
        services.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.as_bytes().cmp(b.0.as_bytes())));
        services.truncate(64);
        services.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        truncated = true;
    }
    Fragment {
        trace_id: frags[0].trace_id,
        min_start: frags.iter().map(|f| f.min_start).min().unwrap(),
        max_end: frags.iter().map(|f| f.max_end).max().unwrap(),
        span_count: frags.iter().map(|f| f.span_count).sum(),
        error_count: frags.iter().map(|f| f.error_count).sum(),
        // The earliest root, then the smaller span id; on a tie (one span in two units), the later fragment's.
        root: frags.iter().rev().filter_map(|f| f.root.clone()).min_by_key(|r| (r.2, r.3)),
        services,
        services_truncated: truncated,
        hours: frags.iter().flat_map(|f| f.hours.iter().copied()).collect::<BTreeSet<_>>().into_iter().collect(),
    }
}

fn check_index_merge(units: &[Vec<SpanBatchDef>], rg: usize, cut: usize) -> Result<(), TestCaseError> {
    let o = small(rg);
    let flushed: Vec<Vec<SignalFile>> = units.iter().map(|u| flush_spans(u, &o)).collect();
    let frags: Vec<Vec<Fragment>> = units.iter().map(|u| unit_fragments(&unit_spans(u))).collect();
    let days: BTreeSet<i64> = frags.iter().flatten().map(|f| f.min_start.div_euclid(NS_PER_DAY)).collect();
    for d in days {
        let inputs: Vec<&SignalFile> = flushed.iter().flatten().filter(|f| f.table == SignalTable::TraceIndex && f.day == viz_storage::day_of_ns(d * NS_PER_DAY)).collect();
        let mut by: BTreeMap<[u8; 16], Vec<Fragment>> = BTreeMap::new();
        for f in frags.iter().flatten().filter(|f| f.min_start.div_euclid(NS_PER_DAY) == d) {
            by.entry(f.trace_id).or_default().push(f.clone());
        }
        let reference: Vec<Fragment> = by.values().map(|v| merged(v)).collect();
        let out = merge(SignalTable::TraceIndex, &inputs, &o, true);
        prop_assert_eq!(&read_trace_index(&out.bytes).unwrap(), &reference);
        let j = check_fragment(&out)?;
        let mut at = 0;
        for e in j.get("rg").arr() {
            let n = e.get("rows").int() as usize;
            prop_assert_eq!(e.get("min_tid").str(), hex(&reference[at].trace_id));
            prop_assert_eq!(e.get("max_tid").str(), hex(&reference[at + n - 1].trace_id));
            at += n;
        }
        prop_assert!(merge_twice(SignalTable::TraceIndex, &inputs, cut, &o, true).bytes == out.bytes, "two-step merge differs");
    }
    Ok(())
}

// ───────────────────────────── logs ─────────────────────────────

type LogKey = (i64, i64, String, Vec<(String, String)>);

/// A unit's rows as flush keeps them: one per row key, the later row's other columns.
fn unit_logs(unit: &[LogBatchDef]) -> BTreeMap<LogKey, (LogRow<String>, LogStream<String>)> {
    let mut m = BTreeMap::new();
    for b in unit {
        for r in &b.rows {
            let s = &b.streams[r.entry as usize];
            m.insert((s.stream_id, r.ts, r.line.clone(), r.metadata.clone()), (r.clone(), s.clone()));
        }
    }
    m
}

fn flush_logs(unit: &[LogBatchDef], o: &SignalWriteOptions) -> Vec<SignalFile> {
    let bytes: Vec<Vec<u8>> = unit.iter().map(|b| otel::encode_logs(&b.streams, &b.rows).unwrap()).collect();
    encode_logs_with(&bytes.iter().map(Vec::as_slice).collect::<Vec<_>>(), o).unwrap()
}

fn log_batch(rows: &[(LogRow<String>, LogStream<String>)]) -> Vec<u8> {
    let streams: Vec<LogStream<String>> = rows.iter().map(|(_, s)| s.clone()).collect();
    let rows: Vec<LogRow<String>> = rows.iter().enumerate().map(|(i, (r, _))| LogRow { entry: i as u32, ..r.clone() }).collect();
    otel::encode_logs(&streams, &rows).unwrap()
}

/// The token rule of LOGS.md §6, written over characters (the crate works over bytes).
pub fn ref_tokens(text: &str) -> BTreeSet<Vec<u8>> {
    let mut out = BTreeSet::new();
    let mut run = String::new();
    for ch in text.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphanumeric() || !ch.is_ascii() {
            run.push(ch);
            continue;
        }
        if run.len() >= 4 {
            let mut t = String::new();
            for c in run.chars() {
                if t.len() + c.len_utf8() > 64 {
                    break;
                }
                t.push(c.to_ascii_lowercase());
            }
            out.insert(t.into_bytes());
        }
        run.clear();
    }
    out
}

fn check_filter(out: &SignalFile, literals: &[String]) -> Result<(), TestCaseError> {
    let j = check_fragment(out)?;
    let t = j.get("tok").arr();
    let (o, l) = (t[0].int() as usize, t[1].int() as usize);
    let filter = TokenFilter::parse(&out.bytes[o..o + l]).unwrap();
    let n_rg = j.get("rg").arr().len();
    prop_assert_eq!(filter.n_row_groups(), n_rg);
    // Exactly the tokens of each row group's lines and metadata values.
    let mut want: BTreeMap<Vec<u8>, Vec<usize>> = BTreeMap::new();
    let mut lines: Vec<Vec<String>> = Vec::new();
    for g in 0..n_rg {
        let rows = read_logs_row_groups(&out.bytes, &[g]).unwrap();
        let mut toks = BTreeSet::new();
        for r in &rows {
            toks.extend(ref_tokens(&r.line));
            for (_, v) in &r.metadata {
                toks.extend(ref_tokens(v));
            }
        }
        for t in toks {
            want.entry(t).or_default().push(g);
        }
        lines.push(rows.into_iter().map(|r| r.line).collect());
    }
    let got: BTreeMap<Vec<u8>, Vec<usize>> = filter.entries().unwrap().into_iter().collect();
    prop_assert_eq!(&got, &want);
    for (tok, gs) in &want {
        for g in 0..n_rg {
            prop_assert_eq!(filter.has(tok, g).unwrap(), gs.contains(&g));
        }
    }
    // No row group holding a matching line is ever skipped; one is skipped exactly when a token
    // the literal implies is missing from it.
    for lit in literals {
        let implied = literal_tokens(lit);
        for (g, ls) in lines.iter().enumerate() {
            let may = filter.may_match(g, &[vec![lit.clone()]]);
            if ls.iter().any(|x| x.contains(lit.as_str())) {
                prop_assert!(may, "row group {g} holds {lit:?} but the filter would skip it");
            }
            prop_assert_eq!(may, implied.iter().all(|t| want.get(t).is_some_and(|gs| gs.contains(&g))), "literal {:?}", lit);
        }
    }
    Ok(())
}

/// Literals to try: pieces of the lines (whole, and cut at character boundaries) and a few others.
fn literals_of(units: &[Vec<LogBatchDef>], picks: &[(usize, usize, usize)]) -> Vec<String> {
    let lines: Vec<&String> = units.iter().flatten().flat_map(|b| b.rows.iter().map(|r| &r.line)).filter(|l| !l.is_empty()).collect();
    let mut out = vec!["error: boom".to_string(), " boom ".into(), "msg=\"x\"".into(), "nope nothing here".into(), " info ".into()];
    for &(i, a, b) in picks {
        if lines.is_empty() {
            break;
        }
        let l = lines[i % lines.len()];
        let cs: Vec<(usize, char)> = l.char_indices().collect();
        let (x, y) = (a % (cs.len() + 1), b % (cs.len() + 1));
        let (x, y) = (x.min(y), x.max(y));
        let at = |k: usize| if k < cs.len() { cs[k].0 } else { l.len() };
        out.push(l[at(x)..at(y)].to_string());
        out.push(l.clone());
    }
    out
}

fn check_logs_merge(units: &[Vec<LogBatchDef>], rg: usize, cut: usize, picks: &[(usize, usize, usize)]) -> Result<(), TestCaseError> {
    let o = small(rg);
    let flushed: Vec<Vec<SignalFile>> = units.iter().map(|u| flush_logs(u, &o)).collect();
    let kept: Vec<_> = units.iter().map(|u| unit_logs(u)).collect();
    let days: BTreeSet<i64> = kept.iter().flat_map(|m| m.values().map(|(r, _)| r.ts.div_euclid(NS_PER_DAY))).collect();
    let literals = literals_of(units, picks);
    for d in days {
        let inputs: Vec<&SignalFile> = flushed.iter().flatten().filter(|f| f.day == viz_storage::day_of_ns(d * NS_PER_DAY)).collect();
        let mut reference: BTreeMap<LogKey, (LogRow<String>, LogStream<String>)> = BTreeMap::new();
        for m in &kept {
            for (k, v) in m.iter().filter(|(_, (r, _))| r.ts.div_euclid(NS_PER_DAY) == d) {
                reference.insert(k.clone(), v.clone());
            }
        }
        let plain = merge(SignalTable::Logs, &inputs, &o, false);
        let rows: Vec<_> = reference.values().cloned().collect();
        let one = encode_logs_with(&[&log_batch(&rows)], &o).unwrap();
        prop_assert_eq!(one.len(), 1);
        prop_assert!(plain.bytes == one[0].bytes, "day {d}: merged bytes (no filter) differ from a flush of the same rows");
        prop_assert_eq!(&plain.index, &one[0].index);
        // Read back: every reference row with its later version.
        let back = read_logs(&plain.bytes).unwrap();
        prop_assert_eq!(back.len(), reference.len());
        for r in &back {
            let (x, s) = &reference[&(r.stream_id, r.ts, r.line.clone(), r.metadata.clone())];
            prop_assert_eq!(&r.labels, &s.labels);
            prop_assert_eq!((r.observed_ts.unwrap_or(0), r.severity_number.unwrap_or(0) as u8, r.severity_text.clone().unwrap_or_default()), (x.observed_ts, x.severity_number, x.severity_text.clone()));
            prop_assert_eq!((r.trace_id.unwrap_or([0; 16]), r.span_id.unwrap_or([0; 8]), r.flags.map_or(0, |f| f as u32)), (x.trace_id, x.span_id, x.flags));
        }
        // With the filter: the same rows and row groups, and the filter.
        let out = merge(SignalTable::Logs, &inputs, &o, true);
        prop_assert_eq!(read_logs(&out.bytes).unwrap(), back);
        let (jp, jo) = (json(&plain.index), json(&out.index));
        prop_assert_eq!(jp.get("rg").arr().iter().map(|e| e.get("rows").int()).collect::<Vec<_>>(), jo.get("rg").arr().iter().map(|e| e.get("rows").int()).collect::<Vec<_>>());
        check_filter(&out, &literals)?;
        prop_assert!(merge_twice(SignalTable::Logs, &inputs, cut, &o, true).bytes == out.bytes, "two-step merge differs");
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 120, ..ProptestConfig::default() })]

    #[test]
    fn spans_merge_per_hour_into_the_deduplicated_union(units in prop::collection::vec(prop::collection::vec(arb_span_batch(), 1..3), 1..5), rg in 1usize..6, cut in 1usize..5) {
        check_spans_merge(&units, rg, cut)?;
    }

    #[test]
    fn trace_index_merges_fragments_per_day(units in prop::collection::vec(prop::collection::vec(arb_span_batch(), 1..3), 1..5), rg in 1usize..6, cut in 1usize..5) {
        check_index_merge(&units, rg, cut)?;
    }

    #[test]
    fn logs_merge_per_day_into_the_deduplicated_union_with_its_token_filter(
        units in prop::collection::vec(prop::collection::vec(arb_log_batch(), 1..3), 1..5), rg in 1usize..6, cut in 1usize..5,
        picks in prop::collection::vec((0usize..1000, 0usize..40, 0usize..40), 0..8),
    ) {
        check_logs_merge(&units, rg, cut, &picks)?;
    }

    /// Default row groups: the merged bytes are one flush's (spans and logs), with every option at the contract's values.
    #[test]
    fn default_layout_merges_are_one_flush(s in prop::collection::vec(prop::collection::vec(arb_span_batch(), 1..3), 2..4), l in prop::collection::vec(prop::collection::vec(arb_log_batch(), 1..3), 2..4)) {
        let o = SignalWriteOptions::default();
        let flushed: Vec<SignalFile> = s.iter().flat_map(|u| flush_spans(u, &o)).filter(|f| f.table == SignalTable::Spans).collect();
        let kept: Vec<_> = s.iter().map(|u| unit_spans(u)).collect();
        for h in flushed.iter().map(|f| f.min_ts.div_euclid(NS_PER_HOUR)).collect::<BTreeSet<_>>() {
            let inputs: Vec<&SignalFile> = flushed.iter().filter(|f| f.min_ts.div_euclid(NS_PER_HOUR) == h).collect();
            let mut reference = BTreeMap::new();
            for m in &kept {
                reference.extend(m.iter().filter(|(_, (x, _))| x.start.div_euclid(NS_PER_HOUR) == h).map(|(k, v)| (*k, v.clone())));
            }
            let rows: Vec<_> = reference.into_values().collect();
            let want = encode_spans_with(&[&span_batch(&rows)], &o).unwrap().into_iter().find(|f| f.table == SignalTable::Spans).unwrap();
            prop_assert!(merge(SignalTable::Spans, &inputs, &o, true).bytes == want.bytes);
        }
        let flushed: Vec<SignalFile> = l.iter().flat_map(|u| flush_logs(u, &o)).collect();
        let kept: Vec<_> = l.iter().map(|u| unit_logs(u)).collect();
        for day in flushed.iter().map(|f| f.day.clone()).collect::<BTreeSet<_>>() {
            let inputs: Vec<&SignalFile> = flushed.iter().filter(|f| f.day == day).collect();
            let mut reference = BTreeMap::new();
            for m in &kept {
                reference.extend(m.iter().filter(|(_, (r, _))| viz_storage::day_of_ns(r.ts) == day).map(|(k, v)| (k.clone(), v.clone())));
            }
            let rows: Vec<_> = reference.into_values().collect();
            prop_assert!(merge(SignalTable::Logs, &inputs, &o, false).bytes == encode_logs_with(&[&log_batch(&rows)], &o).unwrap()[0].bytes);
        }
    }
}

// ───────────────────────────── fixed cases ─────────────────────────────

/// `contracts/LOGS.md` §2, to write a file by hand.
const LOGS_SCHEMA: &str = "message logs {
  required binary service_name (UTF8);
  required int64 stream_id;
  required int64 ts;
  required binary labels (UTF8);
  required binary line (UTF8);
  required group metadata (MAP) { repeated group key_value { required binary key (UTF8); required binary value (UTF8); } }
  optional int64 observed_ts;
  optional int32 severity_number;
  optional binary severity_text (UTF8);
  optional fixed_len_byte_array(16) trace_id;
  optional fixed_len_byte_array(8) span_id;
  optional int32 flags;
}";

fn one_log_file(rows: &[(i64, &str)], labels: &[(&str, &str)]) -> SignalFile {
    let labels: Vec<(String, String)> = labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
    let streams = vec![LogStream { stream_id: otel::stream_id(&labels), labels }];
    let rows: Vec<LogRow<String>> = rows.iter().map(|(ts, l)| log_row(0, *ts, l)).collect();
    let b = otel::encode_logs(&streams, &rows).unwrap();
    viz_storage::encode_logs(&[&b]).unwrap().remove(0)
}

#[test]
fn merges_refuse_what_they_cannot_merge() {
    let msg = |t: SignalTable, files: &[&SignalFile]| {
        let inputs: Vec<bytes::Bytes> = files.iter().map(|f| bytes::Bytes::from(f.bytes.clone())).collect();
        merge_signal_files_shared(t, &inputs, &SignalMergeOptions::default()).unwrap_err().to_string()
    };
    let a = one_log_file(&[(MIDNIGHT, "a")], &[("job", "x")]);
    let b = one_log_file(&[(MIDNIGHT - 1, "b")], &[("job", "x")]);
    assert!(msg(SignalTable::Logs, &[&a, &b]).contains("more than one day"));
    assert!(merge_signal_files_shared(SignalTable::Logs, &[], &SignalMergeOptions::default()).unwrap_err().to_string().contains("no input"));
    // A file of another table.
    assert!(msg(SignalTable::Spans, &[&a]).contains("not a spans file"));
    let sb = fixed_span_batch();
    let mut late = sb.clone();
    for r in late.rows.iter_mut() {
        r.start += NS_PER_HOUR;
        r.end += NS_PER_HOUR;
    }
    let s1 = flush_spans(&[sb], &SignalWriteOptions::default());
    let s2 = flush_spans(&[late], &SignalWriteOptions::default());
    let sp = |v: &[SignalFile]| v.iter().find(|f| f.table == SignalTable::Spans).unwrap().clone();
    assert!(msg(SignalTable::Spans, &[&sp(&s1), &sp(&s2)]).contains("more than one hour"));
    assert!(msg(SignalTable::TraceIndex, &[&sp(&s1)]).contains("not a trace_index file"));
    // An input that is not sorted (written here by hand in reverse order) is refused, never merged.
    let unsorted = {
        use parquet::data_type::{ByteArray, ByteArrayType, Int64Type};
        let schema = std::sync::Arc::new(parquet::schema::parser::parse_message_type(LOGS_SCHEMA).unwrap());
        let mut w = parquet::file::writer::SerializedFileWriter::new(Vec::new(), schema, Default::default()).unwrap();
        let mut rg = w.next_row_group().unwrap();
        let lbl = "{\"job\":\"x\"}";
        let sid = otel::stream_id(&[("job", "x")]);
        let cols: Vec<Box<dyn Fn(&mut parquet::file::writer::SerializedColumnWriter<'_>)>> = vec![
            Box::new(|c| c.typed::<ByteArrayType>().write_batch(&[ByteArray::from(""), ByteArray::from("")], None, None).map(|_| ()).unwrap()),
            Box::new(move |c| c.typed::<Int64Type>().write_batch(&[sid, sid], None, None).map(|_| ()).unwrap()),
            Box::new(|c| c.typed::<Int64Type>().write_batch(&[MIDNIGHT + 5, MIDNIGHT + 1], None, None).map(|_| ()).unwrap()),
            Box::new(move |c| c.typed::<ByteArrayType>().write_batch(&[ByteArray::from(lbl), ByteArray::from(lbl)], None, None).map(|_| ()).unwrap()),
            Box::new(|c| c.typed::<ByteArrayType>().write_batch(&[ByteArray::from("later"), ByteArray::from("earlier")], None, None).map(|_| ()).unwrap()),
            Box::new(|c| c.typed::<ByteArrayType>().write_batch(&[], Some(&[0, 0]), Some(&[0, 0])).map(|_| ()).unwrap()),
            Box::new(|c| c.typed::<ByteArrayType>().write_batch(&[], Some(&[0, 0]), Some(&[0, 0])).map(|_| ()).unwrap()),
        ];
        let mut k = 0;
        while let Some(mut c) = rg.next_column().unwrap() {
            if k < cols.len() {
                cols[k](&mut c);
            } else {
                // The optional columns: two nulls each.
                match c.untyped() {
                    parquet::column::writer::ColumnWriter::Int64ColumnWriter(x) => x.write_batch(&[], Some(&[0, 0]), None).map(|_| ()).unwrap(),
                    parquet::column::writer::ColumnWriter::Int32ColumnWriter(x) => x.write_batch(&[], Some(&[0, 0]), None).map(|_| ()).unwrap(),
                    parquet::column::writer::ColumnWriter::ByteArrayColumnWriter(x) => x.write_batch(&[], Some(&[0, 0]), None).map(|_| ()).unwrap(),
                    parquet::column::writer::ColumnWriter::FixedLenByteArrayColumnWriter(x) => x.write_batch(&[], Some(&[0, 0]), None).map(|_| ()).unwrap(),
                    _ => unreachable!(),
                }
            }
            c.close().unwrap();
            k += 1;
        }
        rg.close().unwrap();
        w.into_inner().unwrap()
    };
    let inputs = [bytes::Bytes::from(unsorted)];
    let e = merge_signal_files_shared(SignalTable::Logs, &inputs, &SignalMergeOptions::default()).unwrap_err().to_string();
    assert!(e.contains("not sorted"), "{e}");
}

#[test]
fn trace_index_keeps_64_services_by_the_rule() {
    // Two units of one trace: 40 services each, 16 shared, so 64 + 0 ... 70 services in all.
    let mk = |names: std::ops::Range<usize>, sid0: u8| -> Vec<SpanBatchDef> {
        let entries: Vec<SpanEntry<String>> = names
            .clone()
            .map(|k| SpanEntry {
                resource_fp: k as i64,
                resource: vec![otel::Attr { key: "service.name".into(), value: Value::Str(format!("svc-{k:03}")) }],
                scope_name: String::new(),
                scope_version: String::new(),
                scope_attrs: String::new(),
            })
            .collect();
        let rows: Vec<Span<String>> = (0..entries.len()).map(|i| span(i as u32, [7; 16], [sid0, i as u8 + 1, 0, 0, 0, 0, 0, 1], MIDNIGHT + i as i64)).collect();
        vec![SpanBatchDef { entries, rows }]
    };
    let o = SignalWriteOptions::default();
    let u1 = flush_spans(&mk(0..40, 1), &o);
    let u2 = flush_spans(&mk(30..70, 2), &o);
    let idx = |v: &[SignalFile]| v.iter().find(|f| f.table == SignalTable::TraceIndex).unwrap().clone();
    let (a, b) = (idx(&u1), idx(&u2));
    let out = merge(SignalTable::TraceIndex, &[&a, &b], &o, true);
    let f = read_trace_index(&out.bytes).unwrap();
    assert_eq!(f.len(), 1);
    assert!(f[0].services_truncated);
    assert_eq!(f[0].services.len(), 64);
    assert_eq!(f[0].span_count, 80);
    // svc-030..039 have 2 spans each and come first; then the 54 smallest names of the rest.
    let names: Vec<&str> = f[0].services.iter().map(|s| s.0.as_str()).collect();
    for k in 30..40 {
        assert!(names.contains(&format!("svc-{k:03}").as_str()));
    }
    assert!(names.contains(&"svc-000") && names.contains(&"svc-063") && !names.contains(&"svc-064") && !names.contains(&"svc-069"));
    assert!(names.windows(2).all(|w| w[0] < w[1]));
}

#[test]
fn tokens_follow_the_rule() {
    let t = |s: &str| tokens::tokens(s).into_iter().map(|b| String::from_utf8(b).unwrap()).collect::<Vec<_>>();
    assert_eq!(t("GET /api/Users/42 took 1234ms"), vec!["1234ms", "took", "users"]);
    assert_eq!(t("service_name=checkout-svc"), vec!["checkout", "name", "service"]);
    assert_eq!(t("naïve café über"), vec!["café", "naïve", "über"]);
    assert_eq!(t("abc ab a"), Vec::<String>::new());
    assert_eq!(t("ÉÉ"), vec!["ÉÉ"]); // 4 bytes; non-ASCII is not lowercased
    // Cut to 64 bytes at a character boundary: 63 ASCII bytes then a 2-byte character.
    let long = format!("{}é{}", "a".repeat(63), "b".repeat(10));
    assert_eq!(t(&long), vec!["a".repeat(63)]);
    let exact = "x".repeat(70);
    assert_eq!(t(&exact), vec!["x".repeat(64)]);
    assert_eq!(ref_tokens(&long).into_iter().collect::<Vec<_>>(), tokens::tokens(&long));
    // A literal implies only the runs strictly inside it.
    let lt = |s: &str| literal_tokens(s).into_iter().map(|b| String::from_utf8(b).unwrap()).collect::<Vec<_>>();
    assert_eq!(lt("GET /api/users 200"), vec!["users"]);
    assert_eq!(lt("timeout"), Vec::<String>::new());
    assert_eq!(lt(" Timeout "), vec!["timeout"]);
    assert_eq!(lt("a=Bearer xyz"), vec!["bearer"]);
}

#[test]
fn the_filter_bytes_are_the_contract_s() {
    let mut b = TokenFilterBuilder::new();
    b.add_text(0, "alpha beta");
    b.add_text(2, "alphabet beta");
    let bytes = b.finish(3).unwrap();
    // header: magic, 3 row groups, 3 tokens, 1 block, reserved
    let mut want = b"VZT1".to_vec();
    for v in [3u32, 3, 1, 0] {
        want.extend_from_slice(&v.to_le_bytes());
    }
    want.extend_from_slice(&0u32.to_le_bytes()); // block 0 at 0
    want.extend_from_slice(&[0, 5]);
    want.extend_from_slice(b"alpha");
    want.extend_from_slice(&[5, 3]);
    want.extend_from_slice(b"bet");
    want.extend_from_slice(&[0, 4]);
    want.extend_from_slice(b"beta");
    want.extend_from_slice(&[0b001, 0b100, 0b101]); // alpha in 0; alphabet in 2; beta in 0 and 2
    assert_eq!(bytes, want);
    let f = TokenFilter::parse(&bytes).unwrap();
    assert!(f.has(b"alpha", 0).unwrap() && !f.has(b"alpha", 2).unwrap() && f.has(b"alphabet", 2).unwrap());
    assert!(f.lookup(b"gamma").unwrap().is_none() && f.lookup(b"aaaa").unwrap().is_none() && f.lookup(b"zzzz").unwrap().is_none());
    assert!(!f.may_match(1, &[vec![" beta ".into()]]));
    assert!(f.may_match(1, &[vec!["beta".into()]]), "a literal with no inner token cannot prune");
    assert!(f.may_match(0, &[vec![" beta ".into()], vec![" nope ".into(), " alpha ".into()]]));
    assert!(!f.may_match(2, &[vec![" beta ".into()], vec![" nope ".into(), " alpha ".into()]]));
    // Damaged filters are refused, and a refused filter never prunes.
    for (i, x) in [(0usize, b'X'), (16, 1), (12, 2), (20, 1)] {
        let mut d = bytes.clone();
        d[i] = x;
        assert!(TokenFilter::parse(&d).is_err(), "byte {i}");
    }
    let mut d = bytes.clone();
    d[31] = 6; // the second token sharing 6 bytes of a 5-byte predecessor
    let f = TokenFilter::parse(&d).unwrap();
    assert!(f.entries().is_err() && f.lookup(b"beta").is_err() && f.may_match(1, &[vec![" beta ".into()]]));
    // Many tokens across blocks and more than 64 row groups.
    let mut b = TokenFilterBuilder::new();
    for g in 0..70 {
        for k in 0..40 {
            if (g + k) % 3 == 0 {
                b.add_text(g, &format!("tok{k:04}"));
            }
        }
    }
    let bytes = b.finish(70).unwrap();
    let f = TokenFilter::parse(&bytes).unwrap();
    assert_eq!(f.n_tokens(), 40);
    for g in 0..70 {
        for k in 0..40 {
            assert_eq!(f.has(format!("tok{k:04}").as_bytes(), g).unwrap(), (g + k) % 3 == 0);
        }
    }
    // Past the bound there is no filter.
    let mut b = TokenFilterBuilder::with_max_tokens(3);
    b.add_text(0, "aaaa bbbb cccc");
    assert!(!b.overflowed());
    b.add_text(0, "dddd");
    assert!(b.overflowed() && b.finish(1).is_none());
}

#[test]
fn a_merge_past_the_token_bound_writes_no_filter_and_parquet_readers_still_read_files_with_one() {
    let rows: Vec<(i64, String)> = (0..50).map(|i| (MIDNIGHT + i, format!("request id{i:05} done"))).collect();
    let refs: Vec<(i64, &str)> = rows.iter().map(|(t, l)| (*t, l.as_str())).collect();
    let a = one_log_file(&refs[..25], &[("job", "x")]);
    let b = one_log_file(&refs[25..], &[("job", "x")]);
    let inputs = [bytes::Bytes::from(a.bytes.clone()), bytes::Bytes::from(b.bytes.clone())];
    let capped = merge_signal_files_shared(SignalTable::Logs, &inputs, &SignalMergeOptions { token_filter_max_tokens: 10, ..Default::default() }).unwrap();
    assert!(json(&capped.index).opt("tok").is_none() && token_filter_location(&capped.bytes).is_none());
    let plain = merge_signal_files_shared(SignalTable::Logs, &inputs, &SignalMergeOptions { token_filter: false, ..Default::default() }).unwrap();
    assert_eq!(capped.bytes, plain.bytes);
    let with = merge_signal_files_shared(SignalTable::Logs, &inputs, &SignalMergeOptions::default()).unwrap();
    let (o, l) = token_filter_location(&with.bytes).unwrap();
    let f = TokenFilter::parse(&with.bytes[o as usize..(o + l) as usize]).unwrap();
    assert_eq!(f.n_tokens(), 52); // 50 ids, "request", "done"
    assert_eq!(read_logs(&with.bytes).unwrap(), read_logs(&plain.bytes).unwrap());
}

#[test]
fn a_root_span_stored_by_two_units_takes_the_later_unit_s_fragment() {
    let mk = |name: &str| {
        let mut b = fixed_span_batch();
        b.rows[0].name = name.into();
        flush_spans(&[b], &SignalWriteOptions::default()).into_iter().find(|f| f.table == SignalTable::TraceIndex).unwrap()
    };
    let (a, b) = (mk("first"), mk("second"));
    let o = SignalWriteOptions::default();
    let f = read_trace_index(&merge(SignalTable::TraceIndex, &[&a, &b], &o, true).bytes).unwrap();
    assert_eq!(f[0].root.as_ref().unwrap().1, "second");
    assert_eq!(f[0].span_count, 4, "fragments are summed, not de-duplicated");
    let f = read_trace_index(&merge(SignalTable::TraceIndex, &[&b, &a], &o, true).bytes).unwrap();
    assert_eq!(f[0].root.as_ref().unwrap().1, "first");
}
