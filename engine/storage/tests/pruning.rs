//! Series-level pruning (contracts/TABLES.md, "Reading part of a file"): the index
//! fragment's series bounds and footer location, the sparse file container, and reads
//! that skip row groups and pages. Pruning must never change an answer (I14), and files
//! written before the change must read as before.
mod common;

use bytes::Bytes;
use common::*;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::file::serialized_reader::ReadOptionsBuilder;
use proptest::prelude::*;
use std::collections::BTreeMap;
use viz_storage::batch::{self, Row, SeriesDef};
use viz_storage::{
    encode_segment_with, merge_files, merge_files_with, select, select_with, sparse, EncodedFile, FileIndex, Matcher, ScanInput, SelectOptions,
    Table, WriteOptions,
};

const ALL: (i64, i64) = (0, batch::MAX_TS);
const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/v1-2026-11-18");

fn golden(name: &str) -> Vec<u8> {
    std::fs::read(format!("{GOLDEN}/{name}")).unwrap()
}

/// The files of `tests/golden/v1-2026-11-18` were written by the writer as of 2026-11-18
/// (`examples/golden_v1.rs` in a copy of that tree) from these batches.
fn golden_segments() -> Vec<Vec<Vec<u8>>> {
    let t0: i64 = 1_763_467_200_000;
    let mut defs = Vec::new();
    for m in ["a_total", "b_seconds", "c_bytes"] {
        for i in 0..40 {
            defs.push(SeriesDef::new(vec![("__name__", m.to_string()), ("job", format!("j{}", i % 3)), ("pod", format!("p{i:03}"))]));
        }
    }
    let mk = |k: i64, salt: f64| {
        let rows: Vec<Row> = (0..defs.len()).map(|i| Row::new(i as u32, t0 + k * 15_000 + (i as i64 % 7), k as f64 * 2.0 + i as f64 + salt)).collect();
        batch::encode(&defs, &rows).unwrap()
    };
    vec![(0..4).map(|k| mk(k, 0.0)).collect(), (3..8).map(|k| mk(k, 0.5)).collect()]
}

/// `(series_id of the first row, of the last row)` per row group, read with the record API.
fn first_last_sids(bytes: &[u8]) -> Vec<(i64, i64)> {
    let r = SerializedFileReader::new(Bytes::copy_from_slice(bytes)).unwrap();
    let mut out = Vec::new();
    let mut at = 0usize;
    let rows: Vec<i64> = r
        .get_row_iter(None)
        .unwrap()
        .map(|row| {
            use parquet::record::RowAccessor;
            row.unwrap().get_long(1).unwrap()
        })
        .collect();
    for g in 0..r.num_row_groups() {
        let n = r.metadata().row_group(g).num_rows() as usize;
        out.push((rows[at], rows[at + n - 1]));
        at += n;
    }
    out
}

/// Strip `"sid":[..]` and `"foot":[..]` from a fragment: what a 2026-11-18 writer wrote.
fn without_new_fields(index: &str) -> String {
    let mut s = String::new();
    let mut rest = index;
    while let Some(i) = rest.find(",\"sid\":[").or_else(|| rest.find(",\"foot\":[")) {
        s.push_str(&rest[..i]);
        let j = i + rest[i..].find(']').unwrap() + 1;
        rest = &rest[j..];
    }
    s.push_str(rest);
    s
}

#[test]
fn the_fragment_carries_series_bounds_and_where_the_footer_is() {
    let segs = golden_segments();
    let refs: Vec<&[u8]> = segs[0].iter().map(|b| &b[..]).collect();
    for f in encode_segment_with(&refs, &WriteOptions { max_row_group_rows: 50, ..Default::default() }).unwrap() {
        let idx = FileIndex::from_json(&f.index).unwrap();
        assert_eq!(FileIndex::from_json(&idx.to_json()).unwrap(), idx, "round trip");
        assert_eq!(idx.to_json(), f.index);
        let truth = first_last_sids(&f.bytes);
        assert_eq!(idx.row_groups.iter().map(|g| g.sid.unwrap()).collect::<Vec<_>>(), truth, "{:?}", f.table);
        // The footer region starts where the last row group ends and runs to the end of
        // the file; it holds the footer metadata and the closing length and magic.
        let (off, len) = idx.foot.unwrap();
        let last = idx.row_groups.last().unwrap();
        assert_eq!(off, last.offset + last.length);
        assert_eq!(off + len, f.bytes.len() as u64);
        let n = f.bytes.len();
        assert_eq!(&f.bytes[n - 4..], b"PAR1");
        let meta = u32::from_le_bytes(f.bytes[n - 8..n - 4].try_into().unwrap()) as u64;
        assert!(len >= meta + 8, "the metadata ({meta} bytes) lies inside the footer region ({len})");
        // Reading only the footer region opens the file: nothing before it is needed.
        let only_foot = sparse::cut(&f.bytes, &[(off, len)]);
        let input = match f.table {
            Table::MetricSamples => ScanInput { sample_files: vec![&only_foot[..]], ..Default::default() },
            Table::MetricSeries => ScanInput { series_files: vec![&only_foot[..]], ..Default::default() },
        };
        assert!(select(&input, &[], ALL.0, ALL.1).unwrap().is_empty(), "every row group was left out, so nothing is read");
    }
}

#[test]
fn the_parquet_bytes_are_those_the_previous_writer_wrote() {
    // The layout did not change (DECISIONS D41): the same batches give byte-identical
    // files, and the fragment differs only by the two added fields.
    let opts = WriteOptions { max_row_group_rows: 50, ..Default::default() };
    let mut samples = Vec::new();
    let mut series = Vec::new();
    for (si, seg) in golden_segments().iter().enumerate() {
        let refs: Vec<&[u8]> = seg.iter().map(|b| &b[..]).collect();
        for f in encode_segment_with(&refs, &opts).unwrap() {
            let name = format!("seg{si}-{}", f.table.as_str());
            assert_eq!(f.bytes, golden(&format!("{name}.parquet")), "{name}");
            assert_eq!(without_new_fields(&f.index), String::from_utf8(golden(&format!("{name}.index.json"))).unwrap(), "{name}");
            match f.table {
                Table::MetricSamples => samples.push(f.bytes),
                Table::MetricSeries => series.push(f.bytes),
            }
        }
    }
    for (table, inputs) in [(Table::MetricSamples, &samples), (Table::MetricSeries, &series)] {
        let refs: Vec<&[u8]> = inputs.iter().map(|b| &b[..]).collect();
        let m = merge_files(table, &refs).unwrap();
        let name = format!("merged-{}", table.as_str());
        assert_eq!(m.bytes, golden(&format!("{name}.parquet")), "{name}");
        assert_eq!(without_new_fields(&m.index), String::from_utf8(golden(&format!("{name}.index.json"))).unwrap());
    }
}

#[test]
fn files_and_fragments_of_the_previous_writer_read_as_before() {
    // Fragments without `sid` and `foot` parse; a reader then knows only the name range
    // and reads the whole file.
    for name in ["seg0-metric_samples", "seg1-metric_samples", "seg0-metric_series", "merged-metric_samples", "merged-metric_series"] {
        let idx = FileIndex::from_json(&String::from_utf8(golden(&format!("{name}.index.json"))).unwrap()).unwrap();
        assert!(idx.foot.is_none() && idx.row_groups.iter().all(|g| g.sid.is_none()), "{name}");
        assert_eq!(idx.byte_ranges(&[0], 0), None, "{name}: no footer location, so the whole file");
        for g in &idx.row_groups {
            for n in ["a_total", "b_seconds", "c_bytes", "d"] {
                let in_range = n >= g.min_name.as_str() && n <= g.max_name.as_str();
                assert_eq!(g.may_hold(n.as_bytes(), &[(i64::MIN, i64::MIN)]), in_range, "{name}: name range only");
            }
        }
    }
    // The files read back to exactly what was written (the later segment wins at k = 3),
    // through flush files and through the merged pair, and merge with files of today.
    let segs = golden_segments();
    let gen: Vec<GenBatch> = segs.iter().flatten().map(|b| decode_gen(b)).collect();
    let want = reference_select(&gen, &[], ALL.0, ALL.1);
    let s0 = golden("seg0-metric_samples.parquet");
    let s1 = golden("seg1-metric_samples.parquet");
    let r0 = golden("seg0-metric_series.parquet");
    let r1 = golden("seg1-metric_series.parquet");
    let input = ScanInput { series_files: vec![&r0, &r1], sample_files: vec![&s0, &s1], tail_batches: vec![] };
    assert_eq!(normalize(select(&input, &[], ALL.0, ALL.1).unwrap()), want);
    let ms = golden("merged-metric_samples.parquet");
    let mr = golden("merged-metric_series.parquet");
    let input = ScanInput { series_files: vec![&mr], sample_files: vec![&ms], tail_batches: vec![] };
    assert_eq!(normalize(select(&input, &[], ALL.0, ALL.1).unwrap()), want);
    // An old file and a new one merge; the output carries the new fragment.
    let refs: Vec<&[u8]> = segs[1].iter().map(|b| &b[..]).collect();
    let new = encode_segment_with(&refs, &WriteOptions::default()).unwrap();
    let m = merge_files(Table::MetricSamples, &[&s0, &new[0].bytes]).unwrap();
    let idx = FileIndex::from_json(&m.index).unwrap();
    assert!(idx.foot.is_some() && idx.row_groups.iter().all(|g| g.sid.is_some()));
    let input = ScanInput { series_files: vec![&r0, &new[1].bytes], sample_files: vec![&m.bytes], tail_batches: vec![] };
    assert_eq!(normalize(select(&input, &[], ALL.0, ALL.1).unwrap()), want);
}

fn decode_gen(bytes: &[u8]) -> GenBatch {
    let b = batch::decode(bytes).unwrap();
    let series = b.series().iter().map(|s| SeriesDef::new(s.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())))).collect();
    let rows = (0..b.n_rows()).map(|i| Row { series_idx: b.series_idx(i), ts: b.ts(i), value_bits: b.value_bits(i) }).collect();
    GenBatch { series, rows }
}

#[test]
fn malformed_new_fields_make_the_fragment_unreadable() {
    let base = r#"{"v":1,"rg":[{"rows":1,"off":4,"len":10,"min_name":"a","max_name":"a","min_ts":0,"max_ts":0SID}]FOOT}"#;
    let ok = |sid: &str, foot: &str| FileIndex::from_json(&base.replace("SID", sid).replace("FOOT", foot));
    assert!(ok("", "").is_ok());
    assert_eq!(ok(r#","sid":[-9223372036854775808,9223372036854775807]"#, r#","foot":[14,30]"#).unwrap().row_groups[0].sid, Some((i64::MIN, i64::MAX)));
    for (sid, foot) in [
        (r#","sid":[1]"#, ""),
        (r#","sid":[1,2,3]"#, ""),
        (r#","sid":"1,2""#, ""),
        (r#","sid":[1,"2"]"#, ""),
        ("", r#","foot":[-1,3]"#),
        ("", r#","foot":[1]"#),
        ("", r#","foot":[1,-1]"#),
        ("", r#","foot":[18446744073709551615,1]"#),
        ("", r#","foot":{"off":1}"#),
    ] {
        assert!(ok(sid, foot).is_err(), "{sid} {foot}");
    }
}

#[test]
fn may_hold_follows_the_sort_order_exactly() {
    let g = |min: &str, max: &str, sid: Option<(i64, i64)>| viz_storage::RowGroupIndex {
        rows: 1, offset: 4, length: 1, min_name: min.into(), max_name: max.into(), min_ts: 0, max_ts: 0, sid,
    };
    // One name: only sids in [first, last].
    let one = g("m", "m", Some((-5, 7)));
    assert!(one.may_hold(b"m", &[(-5, -5)]) && one.may_hold(b"m", &[(7, 7)]) && one.may_hold(b"m", &[(-100, -5)]) && one.may_hold(b"m", &[(7, 100)]));
    assert!(!one.may_hold(b"m", &[(-6, -6)]) && !one.may_hold(b"m", &[(8, 8)]) && !one.may_hold(b"m", &[(-9, -6), (8, 9)]));
    assert!(one.may_hold(b"m", &[(-9, -6), (0, 0), (8, 9)]));
    assert!(!one.may_hold(b"l", &[(0, 0)]) && !one.may_hold(b"n", &[(0, 0)]));
    // Spanning names a..c: a from `first` up, c up to `last`, every sid of b.
    let span = g("a", "c", Some((10, -10)));
    assert!(span.may_hold(b"a", &[(10, 10)]) && !span.may_hold(b"a", &[(9, 9)]) && span.may_hold(b"a", &[(i64::MAX, i64::MAX)]));
    assert!(span.may_hold(b"c", &[(-10, -10)]) && !span.may_hold(b"c", &[(-9, -9)]) && span.may_hold(b"c", &[(i64::MIN, i64::MIN)]));
    assert!(span.may_hold(b"b", &[(i64::MIN, i64::MIN)]) && span.may_hold(b"b", &[(0, 0)]) && span.may_hold(b"bb", &[(5, 5)]));
    assert!(!span.may_hold(b"c\0", &[(i64::MIN, i64::MAX)]) && !span.may_hold(b"", &[(i64::MIN, i64::MAX)]));
    assert!(!span.may_hold(b"b", &[]), "nothing wanted");
    // Statistics that contradict the sort order prove nothing.
    assert!(g("m", "m", Some((7, -5))).may_hold(b"m", &[(100, 100)]));
    // An older fragment: the name range only.
    assert!(g("m", "m", None).may_hold(b"m", &[(i64::MIN, i64::MIN)]));
}

#[test]
fn byte_ranges_join_close_ranges_and_always_hold_the_footer() {
    let rg = |offset: u64, length: u64| viz_storage::RowGroupIndex {
        rows: 1, offset, length, min_name: "a".into(), max_name: "a".into(), min_ts: 0, max_ts: 0, sid: Some((0, 0)),
    };
    let idx = FileIndex { row_groups: vec![rg(4, 100), rg(104, 100), rg(204, 100), rg(1000, 50)], foot: Some((1050, 30)) };
    assert_eq!(idx.byte_ranges(&[], 0), Some(vec![(1050, 30)]));
    assert_eq!(idx.byte_ranges(&[0, 2], 0), Some(vec![(4, 100), (204, 100), (1050, 30)]));
    assert_eq!(idx.byte_ranges(&[0, 1], 0), Some(vec![(4, 200), (1050, 30)]), "adjacent row groups are one read");
    assert_eq!(idx.byte_ranges(&[0, 2], 100), Some(vec![(4, 300), (1050, 30)]), "a gap of 100 is read through");
    assert_eq!(idx.byte_ranges(&[3], 0), Some(vec![(1000, 80)]), "the last row group runs into the footer");
    assert_eq!(idx.byte_ranges(&[2], 746), Some(vec![(204, 876)]), "a gap of exactly 746 is read through");
    assert_eq!(idx.byte_ranges(&[2], 745), Some(vec![(204, 100), (1050, 30)]));
    assert_eq!(idx.byte_ranges(&[9], 0), Some(vec![(1050, 30)]), "a row group that does not exist adds nothing");
}

#[test]
fn the_sparse_container_is_checked() {
    let file: Vec<u8> = (0..100u8).collect();
    let c = sparse::cut(&file, &[(0, 10), (50, 10), (90, 10)]);
    let s = sparse::Source::from_bytes(Bytes::from(c.clone()), None).unwrap();
    assert!(s.has(0, 10) && s.has(55, 5) && s.has(90, 10) && s.has(100, 0));
    assert!(!s.has(5, 10) && !s.has(45, 10) && !s.has(60, 1) && !s.has(95, 6));
    assert_eq!(s.held(), 30);
    assert_eq!(parquet::file::reader::ChunkReader::get_bytes(&s, 52, 3).unwrap().as_ref(), &[52, 53, 54]);
    assert!(parquet::file::reader::ChunkReader::get_bytes(&s, 58, 3).is_err());
    // Every malformation is an error, never a panic.
    let bad = |segs: &[(u64, u64)], len: u64, data: usize| {
        let mut v = b"VZS1".to_vec();
        v.extend_from_slice(&len.to_le_bytes());
        v.extend_from_slice(&(segs.len() as u32).to_le_bytes());
        for (o, l) in segs {
            v.extend_from_slice(&o.to_le_bytes());
            v.extend_from_slice(&l.to_le_bytes());
        }
        v.extend(std::iter::repeat_n(0u8, data));
        sparse::Source::from_bytes(Bytes::from(v), Some(3))
    };
    assert!(bad(&[(0, 10)], 100, 10).is_ok());
    assert!(bad(&[(0, 10)], 100, 9).is_err(), "short");
    assert!(bad(&[(0, 10)], 100, 11).is_err(), "trailing bytes");
    assert!(bad(&[(95, 10)], 100, 10).is_err(), "past the end");
    assert!(bad(&[(10, 10), (15, 10)], 100, 20).is_err(), "overlap");
    assert!(bad(&[(50, 10), (10, 10)], 100, 20).is_err(), "unsorted");
    assert!(bad(&[(u64::MAX, 2)], 100, 2).is_err(), "overflow");
    assert!(bad(&[(0, u64::MAX)], u64::MAX, 0).is_err(), "longer than the container");
    for cut in 0..c.len() {
        let _ = sparse::Source::from_bytes(Bytes::copy_from_slice(&c[..cut]), None); // no panic on any prefix
    }
    // A whole Parquet file is its own source.
    assert_eq!(sparse::Source::from_bytes(Bytes::from_static(b"PAR1...."), None).unwrap().held(), 8);
}

// ───────────────────────────── the property (I14, I17) ─────────────────────────────

struct File {
    bytes: Vec<u8>,
    index: FileIndex,
}

#[derive(Default)]
struct Lake {
    samples: Vec<File>,
    series: Vec<File>,
}

impl Lake {
    fn add(&mut self, files: Vec<EncodedFile>) {
        for f in files {
            let file = File { index: FileIndex::from_json(&f.index).unwrap(), bytes: f.bytes };
            match f.table {
                Table::MetricSamples => self.samples.push(file),
                Table::MetricSeries => self.series.push(file),
            }
        }
    }
}

/// Wanted keys: per metric name, the sorted sids of the series a read selects.
type Wanted = BTreeMap<Vec<u8>, Vec<(i64, i64)>>;

fn wanted_of(batches: &[GenBatch], matchers: &[RefMatcher]) -> Wanted {
    let mut w: BTreeMap<Vec<u8>, Vec<i64>> = BTreeMap::new();
    let all = reference_select(batches, matchers, ALL.0, ALL.1);
    for (labels, _) in all {
        let name = labels.iter().find(|(n, _)| n == "__name__").unwrap().1.as_bytes().to_vec();
        w.entry(name).or_default().push(batch::series_id(&labels));
    }
    w.into_iter()
        .map(|(n, mut ids)| {
            ids.sort_unstable();
            ids.dedup();
            (n, ids.into_iter().map(|i| (i, i)).collect())
        })
        .collect()
}

/// What a planner would fetch of `f`: the row groups that overlap the time range and may
/// hold a wanted key (for series files: any time), with the footer, joined over `gap`.
fn plan(f: &File, wanted: &Wanted, time: Option<(i64, i64)>, gap: u64) -> Vec<(u64, u64)> {
    let groups: Vec<usize> = (0..f.index.row_groups.len())
        .filter(|g| {
            let rg = &f.index.row_groups[*g];
            time.is_none_or(|(lo, hi)| rg.overlaps(lo, hi)) && wanted.iter().any(|(n, iv)| rg.may_hold(n, iv))
        })
        .collect();
    f.index.byte_ranges(&groups, gap).unwrap()
}

/// Narrow `ranges` of a sample file further: inside each row group kept, keep the
/// `series_id` chunk and only the pages of `ts` and `value` that hold a wanted row. A read
/// that decoded a page it did not need would fail on the missing bytes.
fn pages_only(bytes: &[u8], ranges: &[(u64, u64)], wanted: &Wanted, foot: (u64, u64)) -> Vec<(u64, u64)> {
    let r = SerializedFileReader::new_with_options(Bytes::copy_from_slice(bytes), ReadOptionsBuilder::new().with_page_index().build()).unwrap();
    let md = r.metadata();
    let offsets = md.page_index().expect("the offset index is written");
    let ids: std::collections::HashSet<i64> = wanted.values().flatten().map(|(a, _)| *a).collect();
    let mut out = vec![foot];
    for g in 0..r.num_row_groups() {
        let rg = md.row_group(g);
        let (o, l) = rg.column(1).byte_range();
        if !ranges.iter().any(|(ro, rl)| o >= *ro && o + l <= ro + rl) {
            continue; // left out by the row-group plan
        }
        out.push((o, l));
        // Which rows of this row group are wanted?
        let mut sids: Vec<i64> = Vec::new();
        let rgr = r.get_row_group(g).unwrap();
        let mut cr = parquet::column::reader::get_typed_column_reader::<parquet::data_type::Int64Type>(rgr.get_column_reader(1).unwrap());
        let n = rg.num_rows() as usize;
        while sids.len() < n {
            let (got, _, _) = cr.read_records(n - sids.len(), None, None, &mut sids).unwrap();
            assert!(got > 0);
        }
        for col in [2usize, 3] {
            let locs = offsets.offset_index(g, col).expect("an offset index per column").page_locations();
            for (p, loc) in locs.iter().enumerate() {
                let first = loc.first_row_index as usize;
                let end = locs.get(p + 1).map_or(n, |x| x.first_row_index as usize);
                if sids[first..end].iter().any(|s| ids.contains(s)) {
                    out.push((loc.offset as u64, loc.compressed_page_size as u64));
                }
            }
        }
    }
    // The union, as sorted disjoint ranges.
    out.sort_unstable();
    let mut joined: Vec<(u64, u64)> = Vec::new();
    for (o, l) in out {
        match joined.last_mut() {
            Some((po, pl)) if o <= *po + *pl => *pl = (*po + *pl).max(o + l) - *po,
            _ => joined.push((o, l)),
        }
    }
    joined
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    /// I14 and I17 for reads of part of a file. The lake of `select_is_location_invariant`
    /// (flushed in arbitrary segments, row groups of 1 to 6 rows, pages of 1 to 4 rows,
    /// optionally compacted, a tail that may overlap it), read four ways that must all give
    /// the reference answer: whole files with pruning on and off; sparse files holding only
    /// the footer and the row groups `may_hold` keeps for the selected series (joined over
    /// a random gap), series files cut the same way; and sample files narrowed further to
    /// the pages that hold a selected row, which `select` can only read if it skips the rest.
    #[test]
    fn reading_part_of_a_file_changes_nothing(
        batches in arb_batches(7),
        k_sel in any::<prop::sample::Index>(),
        j_sel in any::<prop::sample::Index>(),
        cuts in proptest::collection::vec(any::<bool>(), 7),
        cap in 1usize..7,
        page_rows in 1usize..5,
        compact in any::<bool>(),
        matchers in proptest::collection::vec(arb_matcher(), 0..3),
        lo in 0usize..TS.len(),
        hi in 0usize..TS.len(),
        full_range in any::<bool>(),
        gap in prop_oneof![Just(0u64), Just(40), Just(1 << 16)],
    ) {
        let n = batches.len();
        let k = k_sel.index(n + 1);
        let j = j_sel.index(k + 1);
        let (min_ts, max_ts) = if full_range { ALL } else { (TS[lo] - (lo % 2) as i64, TS[hi] + (hi % 2) as i64) };
        let bytes: Vec<Vec<u8>> = batches.iter().map(|b| b.bytes()).collect();
        let opts = WriteOptions { max_row_group_rows: cap, page_rows, ..Default::default() };

        let mut lake = Lake::default();
        let mut by_day: BTreeMap<String, (Vec<Vec<u8>>, Vec<Vec<u8>>)> = Default::default();
        let mut seg: Vec<&[u8]> = Vec::new();
        for i in 0..k {
            seg.push(&bytes[i]);
            if cuts[i] || i + 1 == k {
                let files = encode_segment_with(&seg, &opts).unwrap();
                seg.clear();
                if compact {
                    for f in files {
                        let e = by_day.entry(f.day.clone()).or_default();
                        match f.table { Table::MetricSamples => e.0.push(f.bytes), Table::MetricSeries => e.1.push(f.bytes) }
                    }
                } else {
                    lake.add(files);
                }
            }
        }
        for (_, (samples, series)) in by_day {
            let s: Vec<&[u8]> = samples.iter().map(|v| v.as_slice()).collect();
            let r: Vec<&[u8]> = series.iter().map(|v| v.as_slice()).collect();
            lake.add(vec![merge_files_with(Table::MetricSamples, &s, &opts).unwrap(), merge_files_with(Table::MetricSeries, &r, &opts).unwrap()]);
        }

        let ms: Vec<Matcher> = matchers.iter().map(|m| m.m.clone()).collect();
        let want = reference_select(&batches, &matchers, min_ts, max_ts);
        let tail: Vec<&[u8]> = bytes[j..].iter().map(|b| &b[..]).collect();
        let whole = ScanInput {
            series_files: lake.series.iter().map(|f| &f.bytes[..]).collect(),
            sample_files: lake.samples.iter().map(|f| &f.bytes[..]).collect(),
            tail_batches: tail.clone(),
        };
        for prune in [true, false] {
            let got = select_with(&whole, &ms, min_ts, max_ts, &SelectOptions { prune_row_groups: prune }).unwrap();
            prop_assert_eq!(&normalize(got), &want, "whole files, pruning {}", prune);
        }

        // The planner's keys come from the series the matchers select (in the lake: a
        // tail-only series has no rows in a file).
        let wanted = wanted_of(&batches[..k], &matchers);
        let series_cut: Vec<Vec<u8>> = lake.series.iter().map(|f| sparse::cut(&f.bytes, &plan(f, &wanted, None, gap))).collect();
        let sample_ranges: Vec<Vec<(u64, u64)>> = lake.samples.iter().map(|f| plan(f, &wanted, Some((min_ts, max_ts)), gap)).collect();
        let samples_cut: Vec<Vec<u8>> = lake.samples.iter().zip(&sample_ranges).map(|(f, r)| sparse::cut(&f.bytes, r)).collect();
        let pages_cut: Vec<Vec<u8>> =
            lake.samples.iter().zip(&sample_ranges).map(|(f, r)| sparse::cut(&f.bytes, &pages_only(&f.bytes, r, &wanted, f.index.foot.unwrap()))).collect();
        for (what, samples) in [("row groups", &samples_cut), ("pages", &pages_cut)] {
            let input = ScanInput {
                series_files: series_cut.iter().map(|b| &b[..]).collect(),
                sample_files: samples.iter().map(|b| &b[..]).collect(),
                tail_batches: tail.clone(),
            };
            let got = select(&input, &ms, min_ts, max_ts);
            prop_assert!(got.is_ok(), "sparse {}: {:?}; sample ranges {:?}; series {:?}", what, got.err(), sample_ranges,
                lake.series.iter().map(|f| (f.bytes.len(), plan(f, &wanted, None, gap))).collect::<Vec<_>>());
            prop_assert_eq!(&normalize(got.unwrap()), &want, "sparse {}", what);
        }
    }
}
