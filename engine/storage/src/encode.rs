//! Flush: a sealed segment's batches become sorted Parquet files.
use crate::batch::{self, Batch};
use crate::day::{day_number, format_day};
use crate::error::{Error, Result};
use crate::json::labels_to_json;
use crate::pq::{EncodedFile, FileWriter, Group, Table, WriteOptions};
use crate::util::IdMap;
use parquet::data_type::ByteArray;

/// Turn a sealed segment's batches (in sequence order) into Parquet files: for each UTC
/// day present, one `metric_samples` file followed by one `metric_series` file, days in
/// ascending order.
///
/// * Rows are sorted by `(metric_name, series_id, ts)`, names in byte order.
/// * `(series_id, ts)` is unique in each file. Among duplicates the row from the later
///   batch wins; within one batch the later row (arrival order) wins.
/// * Value bits are written unchanged, so NaN payloads survive.
/// * A series appears in a day's `metric_series` file iff it has a sample that day;
///   `min_ts`/`max_ts` are its first and last sample time in that file.
/// * No batches, or only empty ones, give an empty result.
///
/// If two batches give different labels for one `series_id` (which the contract rules
/// out), the later batch's labels are used for all of that id's rows.
pub fn encode_segment(batches: &[&[u8]]) -> Result<Vec<EncodedFile>> {
    encode_segment_with(batches, &WriteOptions::default())
}

/// [`encode_segment`] with explicit writer settings (tests use small row groups).
pub fn encode_segment_with(batches: &[&[u8]], opts: &WriteOptions) -> Result<Vec<EncodedFile>> {
    let cap = opts.max_row_group_rows.max(1);
    let decoded: Vec<Batch<'_>> = batches
        .iter()
        .enumerate()
        .map(|(index, b)| batch::decode(b).map_err(|error| Error::Batch { index, error }))
        .collect::<Result<_>>()?;

    // Global series table: one entry per series_id, later batches overwrite labels.
    let mut ids: IdMap<u32> = IdMap::default();
    let mut series: Vec<&batch::Series<'_>> = Vec::new();
    let mut local: Vec<Vec<u32>> = Vec::with_capacity(decoded.len());
    for b in &decoded {
        let mut map = Vec::with_capacity(b.series().len());
        for s in b.series() {
            let g = *ids.entry(s.series_id).or_insert_with(|| {
                series.push(s);
                (series.len() - 1) as u32
            });
            series[g as usize] = s;
            map.push(g);
        }
        local.push(map);
    }

    // Rank series in file order: (metric_name, series_id).
    let mut order: Vec<u32> = (0..series.len() as u32).collect();
    order.sort_unstable_by(|a, b| {
        let (a, b) = (series[*a as usize], series[*b as usize]);
        (a.metric_name().as_bytes(), a.series_id).cmp(&(b.metric_name().as_bytes(), b.series_id))
    });
    let mut rank = vec![0u32; series.len()];
    for (r, g) in order.iter().enumerate() {
        rank[*g as usize] = r as u32;
    }

    // Rows in arrival order; the stable sort keeps arrival order among equal keys, so the
    // last of a run of equal (rank, ts) is the one from the latest batch.
    struct R {
        rank: u32,
        ts: i64,
        bits: u64,
    }
    let total: usize = decoded.iter().map(|b| b.n_rows()).sum();
    let mut rows: Vec<R> = Vec::with_capacity(total);
    for (b, map) in decoded.iter().zip(&local) {
        for i in 0..b.n_rows() {
            rows.push(R { rank: rank[map[b.series_idx(i) as usize] as usize], ts: b.ts(i), bits: b.value_bits(i) });
        }
    }
    // ts order implies day order, so (rank, ts) inside a day is also (day, rank, ts) overall.
    rows.sort_by_key(|r| (day_number(r.ts), r.rank, r.ts));
    let mut kept = 0;
    for i in 0..rows.len() {
        if i + 1 < rows.len() && rows[i + 1].rank == rows[i].rank && rows[i + 1].ts == rows[i].ts {
            continue; // a later arrival of the same (series, ts) follows
        }
        rows.swap(kept, i);
        kept += 1;
    }
    rows.truncate(kept);

    let names: Vec<ByteArray> = order.iter().map(|g| ByteArray::from(series[*g as usize].metric_name())).collect();
    let mut out = Vec::new();
    let mut start = 0;
    while start < rows.len() {
        let day = day_number(rows[start].ts);
        let mut end = start;
        while end < rows.len() && day_number(rows[end].ts) == day {
            end += 1;
        }
        let day_rows = &rows[start..end];
        let day_str = format_day(day);

        let mut w = FileWriter::new(Table::MetricSamples, opts)?;
        for chunk in day_rows.chunks(cap) {
            let n: Vec<ByteArray> = chunk.iter().map(|r| names[r.rank as usize].clone()).collect();
            let sid: Vec<i64> = chunk.iter().map(|r| series[order[r.rank as usize] as usize].series_id).collect();
            let ts: Vec<i64> = chunk.iter().map(|r| r.ts).collect();
            let val: Vec<f64> = chunk.iter().map(|r| f64::from_bits(r.bits)).collect();
            w.write_group(Group::Samples { names: &n, series_id: &sid, ts: &ts, value: &val })?;
        }
        out.push(w.finish(day_str.clone())?);

        // One series row per run of equal rank; rows are in ts order within the run.
        let (mut sn, mut ssid, mut slabels, mut smin, mut smax) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut i = 0;
        while i < day_rows.len() {
            let mut j = i;
            while j < day_rows.len() && day_rows[j].rank == day_rows[i].rank {
                j += 1;
            }
            let s = series[order[day_rows[i].rank as usize] as usize];
            sn.push(names[day_rows[i].rank as usize].clone());
            ssid.push(s.series_id);
            slabels.push(ByteArray::from(labels_to_json(&s.labels).into_bytes()));
            smin.push(day_rows[i].ts);
            smax.push(day_rows[j - 1].ts);
            i = j;
        }
        let mut w = FileWriter::new(Table::MetricSeries, opts)?;
        let mut at = 0;
        while at < sn.len() {
            let to = (at + cap).min(sn.len());
            w.write_group(Group::Series {
                names: &sn[at..to],
                series_id: &ssid[at..to],
                labels: &slabels[at..to],
                min_ts: &smin[at..to],
                max_ts: &smax[at..to],
            })?;
            at = to;
        }
        out.push(w.finish(day_str)?);
        start = end;
    }
    Ok(out)
}
