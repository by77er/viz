//! Shared test support: generators, an in-memory reference model, and readers that go
//! through the `parquet` crate's record API (a different code path from the engine's
//! column readers).
#![allow(dead_code)]
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::RowAccessor;
use proptest::prelude::*;
use std::collections::BTreeMap;
use viz_storage::batch::{self, Row, SeriesDef, STALE_NAN_BITS};
use viz_storage::{MatchOp, Matcher};

/// 2023-11-15T00:00:00Z.
pub const MID: i64 = 1_700_006_400_000;
pub const DAY0: &str = "2023-11-14";
pub const DAY1: &str = "2023-11-15";

pub type Labels = Vec<(String, String)>;

#[derive(Debug, Clone)]
pub struct GenBatch {
    pub series: Vec<SeriesDef>,
    pub rows: Vec<Row>,
}

impl GenBatch {
    pub fn bytes(&self) -> Vec<u8> {
        batch::encode(&self.series, &self.rows).expect("generated batch is valid")
    }
}

pub fn labels(pairs: &[(&str, &str)]) -> SeriesDef {
    SeriesDef::new(pairs.iter().map(|(n, v)| (n.to_string(), v.to_string())))
}

/// A batch from `(labels, ts, value)` triples in arrival order.
pub fn batch_of(rows: &[(&[(&str, &str)], i64, f64)]) -> GenBatch {
    let mut series: Vec<SeriesDef> = Vec::new();
    let mut out = Vec::new();
    for (l, ts, v) in rows {
        let def = labels(l);
        let idx = match series.iter().position(|s| *s == def) {
            Some(i) => i,
            None => {
                series.push(def);
                series.len() - 1
            }
        };
        out.push(Row::new(idx as u32, *ts, *v));
    }
    GenBatch { series, rows: out }
}

pub const METRICS: [&str; 4] = ["up", "cpu", "cpu_total", "p"];
pub const JOBS: [&str; 3] = ["", "a", "ab"];
pub const INSTANCES: [&str; 2] = ["", "i1"];
pub const TS: [i64; 8] = [MID - 3000, MID - 2000, MID - 1000, MID - 1, MID, MID + 1, MID + 1000, MID + 2000];

fn pool() -> Vec<SeriesDef> {
    let mut v = Vec::new();
    for m in METRICS {
        for j in JOBS {
            for i in INSTANCES {
                v.push(labels(&[("__name__", m), ("job", j), ("instance", i)]));
            }
        }
    }
    v
}

fn arb_value() -> impl Strategy<Value = u64> {
    prop_oneof![
        any::<u64>(),
        Just(STALE_NAN_BITS),
        (0u32..5).prop_map(|i| (i as f64).to_bits()),
        Just(f64::NAN.to_bits()),
        Just((-0.0f64).to_bits()),
    ]
}

/// A batch over a small pool of series and timestamps, so duplicates are common. The
/// series table is in random order and may list series that have no rows.
pub fn arb_batch() -> impl Strategy<Value = GenBatch> {
    (
        proptest::collection::vec((0usize..24, 0usize..TS.len(), arb_value()), 1..25),
        proptest::collection::vec(0usize..24, 0..3),
    )
        .prop_map(|(rows, extra)| {
            let pool = pool();
            let mut series: Vec<SeriesDef> = Vec::new();
            let slot = |p: usize, series: &mut Vec<SeriesDef>| match series.iter().position(|s| *s == pool[p]) {
                Some(i) => i,
                None => {
                    series.push(pool[p].clone());
                    series.len() - 1
                }
            };
            for p in extra {
                slot(p, &mut series);
            }
            let rows = rows
                .into_iter()
                .map(|(p, t, bits)| Row { series_idx: slot(p, &mut series) as u32, ts: TS[t], value_bits: bits })
                .collect();
            GenBatch { series, rows }
        })
}

pub fn arb_batches(max: usize) -> impl Strategy<Value = Vec<GenBatch>> {
    proptest::collection::vec(arb_batch(), 0..=max)
}

/// Regular expressions paired with a hand-written predicate saying what a fully
/// anchored match means, so the reference does not depend on a regex engine.
pub const REGEXES: [(&str, fn(&str) -> bool); 11] = [
    ("a|b", |v| v == "a" || v == "b"),
    ("cpu.*", |v| v.starts_with("cpu")),
    (".*", |_| true),
    (".+", |v| !v.is_empty()),
    ("", |v| v.is_empty()),
    ("i[12]", |v| v == "i1" || v == "i2"),
    ("a", |v| v == "a"),
    ("up|cpu_total", |v| v == "up" || v == "cpu_total"),
    (".*total", |v| v.ends_with("total")),
    ("p", |v| v == "p"),
    ("c|", |v| v == "c" || v.is_empty()),
];

#[derive(Debug, Clone)]
pub struct RefMatcher {
    pub m: Matcher,
    regex: Option<usize>,
}

impl RefMatcher {
    fn ok(&self, l: &Labels) -> bool {
        let v = l.iter().find(|(n, _)| *n == self.m.name).map_or("", |(_, v)| v.as_str());
        match self.m.op {
            MatchOp::Eq => v == self.m.value,
            MatchOp::Ne => v != self.m.value,
            MatchOp::Re => REGEXES[self.regex.unwrap()].1(v),
            MatchOp::NotRe => !REGEXES[self.regex.unwrap()].1(v),
        }
    }
}

pub fn arb_matcher() -> impl Strategy<Value = RefMatcher> {
    let name = prop_oneof![Just("__name__"), Just("job"), Just("instance"), Just("missing")];
    let plain = prop_oneof![
        Just(""), Just("up"), Just("cpu"), Just("cpu_total"), Just("p"), Just("a"), Just("ab"), Just("i1"), Just("zzz")
    ];
    (name, 0u8..4, plain, 0usize..REGEXES.len()).prop_map(|(name, op, plain, re)| match op {
        0 => RefMatcher { m: Matcher::new(name, MatchOp::Eq, plain), regex: None },
        1 => RefMatcher { m: Matcher::new(name, MatchOp::Ne, plain), regex: None },
        2 => RefMatcher { m: Matcher::new(name, MatchOp::Re, REGEXES[re].0), regex: Some(re) },
        _ => RefMatcher { m: Matcher::new(name, MatchOp::NotRe, REGEXES[re].0), regex: Some(re) },
    })
}

/// What `select` must return: labels in order, each with `(ts, value bits)` in time order.
pub type Selected = Vec<(Labels, Vec<(i64, u64)>)>;

/// The reference model: replay every row in sequence order into a map (so the last
/// write wins), then filter.
pub fn reference_select(batches: &[GenBatch], matchers: &[RefMatcher], min_ts: i64, max_ts: i64) -> Selected {
    let mut state: BTreeMap<Labels, BTreeMap<i64, u64>> = BTreeMap::new();
    for b in batches {
        for r in &b.rows {
            state.entry(b.series[r.series_idx as usize].labels.clone()).or_default().insert(r.ts, r.value_bits);
        }
    }
    state
        .into_iter()
        .filter(|(l, _)| matchers.iter().all(|m| m.ok(l)))
        .map(|(l, samples)| (l, samples.into_iter().filter(|(t, _)| *t >= min_ts && *t <= max_ts).collect::<Vec<_>>()))
        .filter(|(_, s)| !s.is_empty())
        .collect()
}

pub fn normalize(out: Vec<viz_storage::SeriesData>) -> Selected {
    out.into_iter()
        .map(|s| {
            assert_eq!(s.ts.len(), s.values.len());
            (s.labels, s.ts.into_iter().zip(s.values.into_iter().map(f64::to_bits)).collect())
        })
        .collect()
}

/// `(metric_name, series_id, ts, value bits)` for every row of a `metric_samples` file.
pub fn read_samples(bytes: &[u8]) -> Vec<(String, i64, i64, u64)> {
    let r = SerializedFileReader::new(bytes::Bytes::copy_from_slice(bytes)).unwrap();
    r.get_row_iter(None)
        .unwrap()
        .map(|row| {
            let row = row.unwrap();
            (row.get_string(0).unwrap().clone(), row.get_long(1).unwrap(), row.get_long(2).unwrap(), row.get_double(3).unwrap().to_bits())
        })
        .collect()
}

/// `(metric_name, series_id, labels, min_ts, max_ts)` for every row of a `metric_series` file.
pub fn read_series(bytes: &[u8]) -> Vec<(String, i64, String, i64, i64)> {
    let r = SerializedFileReader::new(bytes::Bytes::copy_from_slice(bytes)).unwrap();
    r.get_row_iter(None)
        .unwrap()
        .map(|row| {
            let row = row.unwrap();
            (
                row.get_string(0).unwrap().clone(),
                row.get_long(1).unwrap(),
                row.get_string(2).unwrap().clone(),
                row.get_long(3).unwrap(),
                row.get_long(4).unwrap(),
            )
        })
        .collect()
}

/// Reference flush: the rows each day's `metric_samples` file must hold, in file order.
pub fn reference_samples(batches: &[GenBatch]) -> BTreeMap<i64, Vec<(String, i64, i64, u64)>> {
    let mut days: BTreeMap<i64, BTreeMap<(String, i64, i64), u64>> = BTreeMap::new();
    for b in batches {
        for r in &b.rows {
            let s = &b.series[r.series_idx as usize];
            let name = s.labels.iter().find(|(n, _)| n == "__name__").unwrap().1.clone();
            days.entry(r.ts.div_euclid(86_400_000)).or_default().insert((name, s.series_id, r.ts), r.value_bits);
        }
    }
    days.into_iter().map(|(d, m)| (d, m.into_iter().map(|((n, s, t), v)| (n, s, t, v)).collect())).collect()
}
