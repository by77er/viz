//! The cardinality report: how many series a tenant has in a time range, by metric and
//! by label, and how many of them are new. Read from `metric_series` files
//! (`crate::catalog`, no sample is decoded) and the series tables of tail batches.
//!
//! **Counting is exact, with caps.** Series are de-duplicated by `series_id`, label pairs
//! and per-metric label values by their text. Memory is bounded by two caps: distinct
//! series seen (in the range and in the look-back window before it), and distinct label
//! pairs plus distinct (metric, label, value) triples. A report that would exceed a cap
//! is refused with an `execution` error naming it, never approximated. Below the caps the
//! error is zero.
//!
//! **What "in the range" means.** A `metric_series` row says a series has samples between
//! `min_ts` and `max_ts` in one file. A series is in `[start, end]` if some row (or tail
//! row) overlaps it. A series whose samples in a file straddle the range without one
//! inside it counts as in the range (files are ten-minute flush units or hours, so this
//! is at most one file's span at either edge).
//!
//! **Created ("churn").** A series in the range is *created* in it if its first sample
//! seen is at or after `start`. Files are read from `start - lookback`, so "first seen"
//! means first within the look-back window: a series that existed before the window and
//! paused through all of it counts as created.
//!
//! **Split.** Like split execution, a part owns the series whose `series_id` falls in its
//! key range ([`crate::split::SplitKey`] with nothing left out), so parts are disjoint in
//! series: per-metric counts and per-pair counts add; distinct label pairs and triples
//! are unions. [`State`] holds one part's per-series data; [`Summary`] is what it
//! sends (no per-series data); [`Summary::merge`] combines parts; [`Summary::report`]
//! renders both JSON answers.
use crate::agg::{In, Out};
use crate::catalog;
use crate::error::QueryError;
use crate::split::SplitKey;
use std::collections::{BTreeMap, HashMap, HashSet};
use viz_storage::batch;

/// Bounds on one report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    /// Distinct series seen (in the range or in the look-back window).
    pub max_series: u64,
    /// Distinct label pairs plus distinct (metric, label, value) triples.
    pub max_pairs: u64,
}

impl Default for Caps {
    fn default() -> Self {
        Caps { max_series: 1_000_000, max_pairs: 2_000_000 }
    }
}

fn cap_error(what: &str, max: u64, reached: u64) -> QueryError {
    QueryError {
        error_type: crate::ErrorType::Execution,
        message: format!("cardinality report exceeded limit {what}: {reached} counted, the limit is {max}. Narrow the time range."),
        limit: None,
    }
}

/// One part's data while files are read.
pub struct State {
    start: i64,
    end: i64,
    part: u32,
    parts: u32,
    caps: Caps,
    /// series_id -> (first sample seen, metric index once the series is in the range).
    series: HashMap<i64, (i64, u32)>,
    metrics: Vec<String>,
    metric_ix: HashMap<String, u32>,
    pairs: Vec<(String, String)>,
    pair_ix: HashMap<(String, String), u32>,
    pair_series: Vec<u64>,
    triples: HashSet<(u32, u32)>,
    min_time: i64,
    max_time: i64,
}

impl State {
    pub fn new(start: i64, end: i64, part: u32, parts: u32, caps: Caps) -> State {
        State {
            start,
            end,
            part,
            parts: parts.max(1),
            caps,
            series: HashMap::new(),
            metrics: Vec::new(),
            metric_ix: HashMap::new(),
            pairs: Vec::new(),
            pair_ix: HashMap::new(),
            pair_series: Vec::new(),
            triples: HashSet::new(),
            min_time: i64::MAX,
            max_time: i64::MIN,
        }
    }

    fn mine(&self, series_id: i64) -> bool {
        SplitKey::part_of(series_id as u64, self.parts) == self.part
    }

    fn pair(&mut self, name: &str, value: &str) -> u32 {
        if let Some(i) = self.pair_ix.get(&(name.to_string(), value.to_string())) {
            return *i;
        }
        let i = self.pairs.len() as u32;
        self.pairs.push((name.to_string(), value.to_string()));
        self.pair_series.push(0);
        self.pair_ix.insert((name.to_string(), value.to_string()), i);
        i
    }

    /// One series with samples between `min_ts` and `max_ts`. `labels` is only called
    /// for a series seen in the range for the first time.
    fn see(&mut self, series_id: i64, min_ts: i64, max_ts: i64, labels: &mut dyn FnMut() -> Result<Vec<(String, String)>, QueryError>) -> Result<(), QueryError> {
        if !self.mine(series_id) {
            return Ok(());
        }
        let in_range = min_ts <= self.end && max_ts >= self.start;
        let fresh = !self.series.contains_key(&series_id);
        if fresh && self.series.len() as u64 >= self.caps.max_series {
            return Err(cap_error("max_series", self.caps.max_series, self.series.len() as u64 + 1));
        }
        let entry = self.series.entry(series_id).or_insert((min_ts, u32::MAX));
        entry.0 = entry.0.min(min_ts);
        if !in_range {
            return Ok(());
        }
        self.min_time = self.min_time.min(min_ts.max(self.start));
        self.max_time = self.max_time.max(max_ts.min(self.end));
        if entry.1 != u32::MAX {
            return Ok(());
        }
        let l = labels()?;
        let name = l.iter().find(|(k, _)| k == batch::NAME_LABEL).map(|(_, v)| v.clone()).unwrap_or_default();
        let m = match self.metric_ix.get(&name) {
            Some(m) => *m,
            None => {
                let m = self.metrics.len() as u32;
                self.metrics.push(name.clone());
                self.metric_ix.insert(name, m);
                m
            }
        };
        if let Some(e) = self.series.get_mut(&series_id) {
            e.1 = m;
        }
        for (k, v) in &l {
            let p = self.pair(k, v);
            self.pair_series[p as usize] += 1;
            if k != batch::NAME_LABEL {
                self.triples.insert((m, p));
            }
        }
        let used = (self.pairs.len() + self.triples.len()) as u64;
        if used > self.caps.max_pairs {
            return Err(cap_error("max_pairs", self.caps.max_pairs, used));
        }
        Ok(())
    }

    /// Read one `metric_series` file (`file` is its index, for messages).
    pub fn add_series_file(&mut self, bytes: &[u8], file: usize) -> Result<(), QueryError> {
        let all = |_: &[u8], _: &[u8]| true;
        let any = |_: &[u8]| true;
        let mut rows: Vec<(i64, i64, i64, Vec<u8>)> = Vec::new();
        catalog::for_each_series(bytes, file, &all, &any, &mut |row| {
            rows.push((row.series_id, row.min_ts, row.max_ts, row.labels_json.to_vec()));
            Ok(())
        })?;
        for (id, lo, hi, json) in rows {
            self.see(id, lo, hi, &mut || catalog::parse_labels(&json))?;
        }
        Ok(())
    }

    /// Read the series of one tail batch, with the span of their rows in it.
    pub fn add_tail_batch(&mut self, bytes: &[u8], index: usize) -> Result<(), QueryError> {
        let b = batch::decode(bytes).map_err(|e| QueryError::internal(format!("tail batch {index}: {e}")))?;
        let mut span: Vec<(i64, i64)> = vec![(i64::MAX, i64::MIN); b.series().len()];
        for i in 0..b.n_rows() {
            let s = &mut span[b.series_idx(i) as usize];
            let t = b.ts(i);
            s.0 = s.0.min(t);
            s.1 = s.1.max(t);
        }
        for (s, (lo, hi)) in b.series().iter().zip(span) {
            if lo > hi {
                continue;
            }
            let labels = s.labels.clone();
            self.see(s.series_id, lo, hi, &mut || Ok(labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect()))?;
        }
        Ok(())
    }

    /// What this part sends: no per-series data.
    pub fn summary(&self) -> Summary {
        let mut metrics: Vec<(String, u64, u64)> = self.metrics.iter().map(|m| (m.clone(), 0, 0)).collect();
        for (first, m) in self.series.values() {
            if *m != u32::MAX {
                let e = &mut metrics[*m as usize];
                e.1 += 1;
                if *first >= self.start {
                    e.2 += 1;
                }
            }
        }
        let mut triples: Vec<(u32, u32)> = self.triples.iter().copied().collect();
        triples.sort_unstable();
        Summary {
            metrics,
            pairs: self.pairs.iter().cloned().zip(self.pair_series.iter().copied()).collect(),
            triples,
            time: (self.min_time <= self.max_time).then_some((self.min_time, self.max_time)),
        }
    }
}

/// The mergeable result of one part (or of several merged).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Summary {
    /// (metric name, series in the range, of which created in the range)
    pub metrics: Vec<(String, u64, u64)>,
    /// ((label, value), series in the range carrying it)
    pub pairs: Vec<((String, String), u64)>,
    /// (index into `metrics`, index into `pairs`): the metric has a series with that pair
    /// (`__name__` excluded).
    pub triples: Vec<(u32, u32)>,
    /// First and last sample time seen in the range, clamped to it.
    pub time: Option<(i64, i64)>,
}

impl Summary {
    pub fn encode(&self) -> Vec<u8> {
        let mut o = Out::default();
        o.0.extend_from_slice(b"VZC1");
        o.var(self.metrics.len() as u64);
        for (m, s, c) in &self.metrics {
            o.str(m);
            o.var(*s);
            o.var(*c);
        }
        o.var(self.pairs.len() as u64);
        for ((k, v), s) in &self.pairs {
            o.str(k);
            o.str(v);
            o.var(*s);
        }
        o.var(self.triples.len() as u64);
        for (m, p) in &self.triples {
            o.var(*m as u64);
            o.var(*p as u64);
        }
        match self.time {
            Some((a, b)) => {
                o.u8(1);
                o.zig(a);
                o.zig(b);
            }
            None => o.u8(0),
        }
        o.0
    }

    pub fn decode(bytes: &[u8]) -> Result<Summary, QueryError> {
        let bad = |m: String| QueryError::internal(format!("cardinality summary: {m}"));
        if bytes.len() < 4 || &bytes[..4] != b"VZC1" {
            return Err(bad("not a summary".into()));
        }
        let mut r = In::new(&bytes[4..]);
        let mut s = Summary::default();
        for _ in 0..r.count(3).map_err(bad)? {
            s.metrics.push((r.str().map_err(bad)?, r.var().map_err(bad)?, r.var().map_err(bad)?));
        }
        for _ in 0..r.count(3).map_err(bad)? {
            s.pairs.push(((r.str().map_err(bad)?, r.str().map_err(bad)?), r.var().map_err(bad)?));
        }
        for _ in 0..r.count(2).map_err(bad)? {
            let (m, p) = (r.var().map_err(bad)?, r.var().map_err(bad)?);
            if m as usize >= s.metrics.len() || p as usize >= s.pairs.len() {
                return Err(bad("index out of range".into()));
            }
            s.triples.push((m as u32, p as u32));
        }
        if r.u8().map_err(bad)? == 1 {
            s.time = Some((r.zig().map_err(bad)?, r.zig().map_err(bad)?));
        }
        if !r.done() {
            return Err(bad("trailing bytes".into()));
        }
        Ok(s)
    }

    /// Combine with the summary of a part that holds other series.
    pub fn merge(&mut self, o: &Summary, caps: Caps) -> Result<(), QueryError> {
        let mut mix: HashMap<String, usize> = self.metrics.iter().enumerate().map(|(i, m)| (m.0.clone(), i)).collect();
        let mut pix: HashMap<(String, String), usize> = self.pairs.iter().enumerate().map(|(i, p)| (p.0.clone(), i)).collect();
        let mut mmap = Vec::with_capacity(o.metrics.len());
        for (m, s, c) in &o.metrics {
            let i = *mix.entry(m.clone()).or_insert_with(|| {
                self.metrics.push((m.clone(), 0, 0));
                self.metrics.len() - 1
            });
            self.metrics[i].1 += s;
            self.metrics[i].2 += c;
            mmap.push(i as u32);
        }
        let mut pmap = Vec::with_capacity(o.pairs.len());
        for (p, s) in &o.pairs {
            let i = *pix.entry(p.clone()).or_insert_with(|| {
                self.pairs.push((p.clone(), 0));
                self.pairs.len() - 1
            });
            self.pairs[i].1 += s;
            pmap.push(i as u32);
        }
        let mut t: HashSet<(u32, u32)> = self.triples.iter().copied().collect();
        for (m, p) in &o.triples {
            t.insert((mmap[*m as usize], pmap[*p as usize]));
        }
        self.triples = t.into_iter().collect();
        self.triples.sort_unstable();
        let used = (self.pairs.len() + self.triples.len()) as u64;
        if used > caps.max_pairs {
            return Err(cap_error("max_pairs", caps.max_pairs, used));
        }
        self.time = match (self.time, o.time) {
            (Some(a), Some(b)) => Some((a.0.min(b.0), a.1.max(b.1))),
            (a, b) => a.or(b),
        };
        Ok(())
    }

    /// Both answers: Prometheus' `/api/v1/status/tsdb` `data` object and viz's
    /// `/api/v1/status/cardinality` `data` object, each list cut to `limit` entries
    /// (largest first, ties by name).
    pub fn report(&self, limit: usize, start: i64, end: i64, lookback_start: i64, caps: Caps) -> (String, String) {
        use serde_json::{json, Value as J};
        let top = |mut v: Vec<(String, u64)>| -> Vec<(String, u64)> {
            v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            v.truncate(limit);
            v
        };
        let stat = |v: Vec<(String, u64)>| -> J { J::Array(v.into_iter().map(|(name, value)| json!({"name": name, "value": value})).collect()) };
        let num_series: u64 = self.metrics.iter().map(|m| m.1).sum();
        let created: u64 = self.metrics.iter().map(|m| m.2).sum();
        let mut by_name: BTreeMap<&str, (u64, u64)> = BTreeMap::new();
        for ((k, v), _) in &self.pairs {
            let e = by_name.entry(k).or_default();
            e.0 += 1;
            e.1 += v.len() as u64;
        }
        let metric_series = top(self.metrics.iter().map(|m| (m.0.clone(), m.1)).filter(|m| m.1 > 0).collect());
        let value_counts = top(by_name.iter().map(|(k, v)| (k.to_string(), v.0)).collect());
        let bytes = top(by_name.iter().map(|(k, v)| (k.to_string(), v.1)).collect());
        let pairs = top(self.pairs.iter().filter(|p| p.1 > 0).map(|((k, v), s)| (format!("{k}={v}"), *s)).collect());
        let tsdb = json!({
            "headStats": {
                "numSeries": num_series,
                "numLabelPairs": self.pairs.len(),
                "chunkCount": J::Null,
                "minTime": self.time.map(|t| t.0),
                "maxTime": self.time.map(|t| t.1),
            },
            "seriesCountByMetricName": stat(metric_series.clone()),
            "labelValueCountByLabelName": stat(value_counts.clone()),
            "memoryInBytesByLabelName": stat(bytes),
            "seriesCountByLabelValuePair": stat(pairs),
        });
        // Per metric: distinct values of each label.
        let mut per_metric: HashMap<u32, BTreeMap<&str, u64>> = HashMap::new();
        for (m, p) in &self.triples {
            *per_metric.entry(*m).or_default().entry(self.pairs[*p as usize].0 .0.as_str()).or_default() += 1;
        }
        let mix: HashMap<&str, usize> = self.metrics.iter().enumerate().map(|(i, m)| (m.0.as_str(), i)).collect();
        let metrics: Vec<J> = metric_series
            .iter()
            .map(|(name, series)| {
                let i = mix[name.as_str()];
                let labels = top(per_metric.get(&(i as u32)).map(|l| l.iter().map(|(k, v)| (k.to_string(), *v)).collect()).unwrap_or_default());
                json!({
                    "name": name,
                    "series": series,
                    "created": self.metrics[i].2,
                    "labels": labels.into_iter().map(|(k, v)| json!({"name": k, "values": v})).collect::<Vec<_>>(),
                })
            })
            .collect();
        let created_top = top(self.metrics.iter().filter(|m| m.2 > 0).map(|m| (m.0.clone(), m.2)).collect());
        let names: Vec<J> = value_counts
            .iter()
            .map(|(k, v)| json!({"name": k, "values": v, "bytes": by_name.get(k.as_str()).map(|e| e.1).unwrap_or(0)}))
            .collect();
        let mut pair_list: Vec<&((String, String), u64)> = self.pairs.iter().filter(|p| p.1 > 0).collect();
        pair_list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        pair_list.truncate(limit);
        let viz = json!({
            "start": start,
            "end": end,
            "lookbackStart": lookback_start,
            "numSeries": num_series,
            "numLabelPairs": self.pairs.len(),
            "seriesCreated": created,
            "minTime": self.time.map(|t| t.0),
            "maxTime": self.time.map(|t| t.1),
            "metrics": metrics,
            "labelNames": names,
            "labelPairs": pair_list.into_iter().map(|((k, v), s)| json!({"name": k, "value": v, "series": s})).collect::<Vec<_>>(),
            "createdByMetric": created_top.into_iter().map(|(k, v)| json!({"name": k, "created": v})).collect::<Vec<_>>(),
            "counting": {"method": "exact", "maxSeries": caps.max_series, "maxPairs": caps.max_pairs},
        });
        (tsdb.to_string(), viz.to_string())
    }
}
