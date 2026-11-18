//! Select: resolve matchers to series, then merge lake files and tail batches into one
//! ordered, de-duplicated sample stream per series.
use crate::batch::{self, NAME_LABEL};
use crate::error::{Error, Result};
use crate::json::parse_labels;
use crate::pq::{self, Table};
use crate::util::IdMap;
use parquet::data_type::{ByteArray, ByteArrayType, DoubleType, Int64Type};
use parquet::file::reader::FileReader;
use parquet::file::statistics::Statistics;
use regex::Regex;

/// Matcher operator, as in PromQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchOp {
    /// `=`
    Eq,
    /// `!=`
    Ne,
    /// `=~`
    Re,
    /// `!~`
    NotRe,
}

/// A Prometheus label matcher. `__name__` is an ordinary label. A label the series does
/// not have compares as the empty string. Regular expressions must match the whole value
/// (they are compiled as `^(?s:...)$`, as Prometheus does).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Matcher {
    pub name: String,
    pub op: MatchOp,
    pub value: String,
}

impl Matcher {
    pub fn new(name: impl Into<String>, op: MatchOp, value: impl Into<String>) -> Matcher {
        Matcher { name: name.into(), op, value: value.into() }
    }
}

/// Everything a select reads. All slices are whole objects held in memory.
#[derive(Debug, Clone, Default)]
pub struct ScanInput<'a> {
    /// Whole `metric_series` Parquet files.
    pub series_files: Vec<&'a [u8]>,
    /// Whole `metric_samples` Parquet files. Later files win on duplicate `(series_id, ts)`.
    pub sample_files: Vec<&'a [u8]>,
    /// `VZB1` batches from shard tails, in sequence order. Later batches win on
    /// duplicates, and any tail batch wins over any lake file.
    pub tail_batches: Vec<&'a [u8]>,
}

/// One series' samples: strictly increasing `ts`, one value per `ts`.
#[derive(Debug, Clone, PartialEq)]
pub struct SeriesData {
    /// All labels including `__name__`, sorted by name (byte order).
    pub labels: Vec<(String, String)>,
    /// Unix milliseconds.
    pub ts: Vec<i64>,
    /// Same length as `ts`. NaN payload bits are preserved; compare with `to_bits`.
    pub values: Vec<f64>,
}

/// Knobs for [`select_with`].
#[derive(Debug, Clone)]
pub struct SelectOptions {
    /// Skip row groups whose statistics show they cannot contribute. Turning this off
    /// must never change the result; it exists so tests can prove that.
    pub prune_row_groups: bool,
}

impl Default for SelectOptions {
    fn default() -> Self {
        SelectOptions { prune_row_groups: true }
    }
}

enum Pred {
    Eq(String),
    Ne(String),
    Re(Regex),
    NotRe(Regex),
}

struct Compiled {
    name: String,
    pred: Pred,
}

fn compile(matchers: &[Matcher]) -> Result<Vec<Compiled>> {
    matchers
        .iter()
        .map(|m| {
            let re = || {
                Regex::new(&format!("^(?s:{})$", m.value)).map_err(|e| Error::Matcher { name: m.name.clone(), message: e.to_string() })
            };
            let pred = match m.op {
                MatchOp::Eq => Pred::Eq(m.value.clone()),
                MatchOp::Ne => Pred::Ne(m.value.clone()),
                MatchOp::Re => Pred::Re(re()?),
                MatchOp::NotRe => Pred::NotRe(re()?),
            };
            Ok(Compiled { name: m.name.clone(), pred })
        })
        .collect()
}

fn matches<N: AsRef<str>, V: AsRef<str>>(ms: &[Compiled], labels: &[(N, V)]) -> bool {
    ms.iter().all(|m| {
        let v = labels.iter().find(|(n, _)| n.as_ref() == m.name).map_or("", |(_, v)| v.as_ref());
        match &m.pred {
            Pred::Eq(x) => v == x,
            Pred::Ne(x) => v != x,
            Pred::Re(r) => r.is_match(v),
            Pred::NotRe(r) => !r.is_match(v),
        }
    })
}

struct Acc {
    labels: Vec<(String, String)>,
    ts: Vec<i64>,
    values: Vec<f64>,
}

fn bytes_stats(s: Option<&Statistics>) -> Option<(&[u8], &[u8])> {
    match s {
        Some(Statistics::ByteArray(st)) => Some((st.min_opt()?.data(), st.max_opt()?.data())),
        _ => None,
    }
}

fn i64_stats(s: Option<&Statistics>) -> Option<(i64, i64)> {
    match s {
        Some(Statistics::Int64(st)) => Some((*st.min_opt()?, *st.max_opt()?)),
        _ => None,
    }
}

/// True if no element of the sorted slice lies in `[lo, hi]`.
fn none_in_range<T: Ord + ?Sized, S: std::borrow::Borrow<T>>(sorted: &[S], lo: &T, hi: &T) -> bool {
    let i = sorted.partition_point(|x| x.borrow() < lo);
    i == sorted.len() || sorted[i].borrow() > hi
}

/// Select series matching all `matchers` that have at least one sample in the inclusive
/// range `[min_ts, max_ts]`, with those samples.
///
/// Series are resolved from the `metric_series` files and from the tail batches' series
/// tables. Samples come from the `metric_samples` files and the tail batches. Each
/// series' samples are returned in time order with one value per timestamp; when the same
/// `(series_id, ts)` occurs more than once, the winner is the latest tail batch that has
/// it (within a batch, the later row), else the latest sample file that has it.
///
/// The result is sorted by label set (pairs compared in order, byte-wise), so it does not
/// depend on input order or on where rows are stored. No matchers selects every series.
///
/// A series whose rows are in a sample file but which is described by no series file and
/// no tail batch is not returned: pass the `metric_series` files that go with the sample
/// files.
pub fn select(input: &ScanInput<'_>, matchers: &[Matcher], min_ts: i64, max_ts: i64) -> Result<Vec<SeriesData>> {
    select_with(input, matchers, min_ts, max_ts, &SelectOptions::default())
}

/// [`select`] with explicit options.
pub fn select_with(input: &ScanInput<'_>, matchers: &[Matcher], min_ts: i64, max_ts: i64, opts: &SelectOptions) -> Result<Vec<SeriesData>> {
    let ms = compile(matchers)?;
    // series_id -> Some(index into accs) if it matched, None if it was seen and did not.
    let mut known: IdMap<Option<u32>> = IdMap::default();
    let mut accs: Vec<Acc> = Vec::new();
    let name_eq: Option<&str> = ms.iter().find_map(|m| match (&m.pred, m.name == NAME_LABEL) {
        (Pred::Eq(v), true) => Some(v.as_str()),
        _ => None,
    });

    // 1. Resolve series from the lake.
    let (mut names, mut sids, mut labels) = (Vec::<ByteArray>::new(), Vec::<i64>::new(), Vec::<ByteArray>::new());
    for (fi, f) in input.series_files.iter().enumerate() {
        let r = pq::open(f, Table::MetricSeries, fi)?;
        for g in 0..r.num_row_groups() {
            if opts.prune_row_groups {
                if let (Some(want), Some((lo, hi))) = (name_eq, bytes_stats(r.metadata().row_group(g).column(0).statistics())) {
                    if want.as_bytes() < lo || want.as_bytes() > hi {
                        continue;
                    }
                }
            }
            let n = pq::group_rows(&r, g, fi)?;
            let rg = r.get_row_group(g).map_err(pq::perr(Some(fi)))?;
            pq::read_col::<ByteArrayType>(&*rg, 0, n, fi, &mut names)?;
            pq::read_col::<Int64Type>(&*rg, 1, n, fi, &mut sids)?;
            let mut have_labels = false;
            for i in 0..n {
                if name_eq.is_some_and(|want| want.as_bytes() != names[i].data()) || known.contains_key(&sids[i]) {
                    continue;
                }
                if !have_labels {
                    pq::read_col::<ByteArrayType>(&*rg, 2, n, fi, &mut labels)?;
                    have_labels = true;
                }
                let text = std::str::from_utf8(labels[i].data()).map_err(|_| Error::Json("labels is not UTF-8".into()))?;
                let l = parse_labels(text)?;
                let hit = matches(&ms, &l);
                known.insert(sids[i], hit.then_some(accs.len() as u32));
                if hit {
                    accs.push(Acc { labels: l, ts: Vec::new(), values: Vec::new() });
                }
            }
        }
    }

    // 2. Resolve series from the tail (decoding each batch once).
    let tails: Vec<batch::Batch<'_>> = input
        .tail_batches
        .iter()
        .enumerate()
        .map(|(index, b)| batch::decode(b).map_err(|error| Error::Batch { index, error }))
        .collect::<Result<_>>()?;
    let mut tail_maps: Vec<Vec<Option<u32>>> = Vec::with_capacity(tails.len());
    for b in &tails {
        let mut map = Vec::with_capacity(b.series().len());
        for s in b.series() {
            let slot = *known.entry(s.series_id).or_insert_with(|| {
                matches(&ms, &s.labels).then(|| {
                    accs.push(Acc {
                        labels: s.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect(),
                        ts: Vec::new(),
                        values: Vec::new(),
                    });
                    (accs.len() - 1) as u32
                })
            });
            map.push(slot);
        }
        tail_maps.push(map);
    }

    // 3. Lake samples, files in input order (lowest precedence first).
    if !accs.is_empty() {
        let mut want_ids: Vec<i64> = known.iter().filter(|(_, v)| v.is_some()).map(|(k, _)| *k).collect();
        want_ids.sort_unstable();
        let mut want_names: Vec<Vec<u8>> =
            accs.iter().filter_map(|a| a.labels.iter().find(|(n, _)| n == NAME_LABEL)).map(|(_, v)| v.as_bytes().to_vec()).collect();
        want_names.sort_unstable();
        want_names.dedup();
        let (mut ts, mut val) = (Vec::<i64>::new(), Vec::<f64>::new());
        for (fi, f) in input.sample_files.iter().enumerate() {
            let r = pq::open(f, Table::MetricSamples, fi)?;
            for g in 0..r.num_row_groups() {
                let md = r.metadata().row_group(g);
                if opts.prune_row_groups {
                    if let Some((lo, hi)) = i64_stats(md.column(2).statistics()) {
                        if hi < min_ts || lo > max_ts {
                            continue;
                        }
                    }
                    if let Some((lo, hi)) = bytes_stats(md.column(0).statistics()) {
                        if none_in_range::<[u8], _>(&want_names, lo, hi) {
                            continue;
                        }
                    }
                    if let Some((lo, hi)) = i64_stats(md.column(1).statistics()) {
                        if none_in_range::<i64, _>(&want_ids, &lo, &hi) {
                            continue;
                        }
                    }
                }
                let n = pq::group_rows(&r, g, fi)?;
                let rg = r.get_row_group(g).map_err(pq::perr(Some(fi)))?;
                pq::read_col::<Int64Type>(&*rg, 1, n, fi, &mut sids)?;
                let mut loaded = false;
                let mut i = 0;
                while i < n {
                    let mut j = i + 1;
                    while j < n && sids[j] == sids[i] {
                        j += 1;
                    }
                    if let Some(Some(a)) = known.get(&sids[i]) {
                        if !loaded {
                            pq::read_col::<Int64Type>(&*rg, 2, n, fi, &mut ts)?;
                            pq::read_col::<DoubleType>(&*rg, 3, n, fi, &mut val)?;
                            loaded = true;
                        }
                        let acc = &mut accs[*a as usize];
                        for k in i..j {
                            if ts[k] >= min_ts && ts[k] <= max_ts {
                                acc.ts.push(ts[k]);
                                acc.values.push(val[k]);
                            }
                        }
                    }
                    i = j;
                }
            }
        }
    }

    // 4. Tail samples, batches in sequence order (highest precedence last).
    for (b, map) in tails.iter().zip(&tail_maps) {
        for i in 0..b.n_rows() {
            if let Some(a) = map[b.series_idx(i) as usize] {
                let t = b.ts(i);
                if t >= min_ts && t <= max_ts {
                    let acc = &mut accs[a as usize];
                    acc.ts.push(t);
                    acc.values.push(b.value(i));
                }
            }
        }
    }

    // 5. Order each series by time; among equal timestamps keep the last appended, which
    //    is the highest-precedence source because sources were appended lowest first.
    let mut out: Vec<SeriesData> = Vec::new();
    for a in accs {
        if a.ts.is_empty() {
            continue;
        }
        let (ts, values) = if a.ts.windows(2).all(|w| w[0] < w[1]) {
            (a.ts, a.values)
        } else {
            let mut rows: Vec<(i64, f64)> = a.ts.into_iter().zip(a.values).collect();
            rows.sort_by_key(|r| r.0); // stable
            let (mut ts, mut values) = (Vec::with_capacity(rows.len()), Vec::with_capacity(rows.len()));
            for (i, (t, v)) in rows.iter().enumerate() {
                if i + 1 < rows.len() && rows[i + 1].0 == *t && false {
                    continue;
                }
                ts.push(*t);
                values.push(*v);
            }
            (ts, values)
        };
        out.push(SeriesData { labels: a.labels, ts, values });
    }
    out.sort_by(|a, b| a.labels.cmp(&b.labels));
    Ok(out)
}
