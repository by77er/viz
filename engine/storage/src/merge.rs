//! Compaction: merge the files of one tenant-day into one sorted, de-duplicated file.
use crate::day::{day_number, format_day};
use crate::error::{Error, Result};
use crate::pq::{self, EncodedFile, FileWriter, Group, Reader, Table, WriteOptions};
use bytes::Bytes;
use parquet::data_type::{ByteArray, ByteArrayType, DoubleType, Int64Type};
use parquet::file::reader::FileReader;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

/// Merge several files of one table and one tenant-day into one file with the same
/// schema, sort order and encodings, and a fresh index fragment.
///
/// `metric_samples`: a streaming k-way merge on `(metric_name, series_id, ts)`, holding
/// one row group per input in memory. Rows with the same `(metric_name, series_id, ts)`
/// collapse to one; the row from the later input wins (within one input, the later row).
/// The output is exactly the de-duplicated union of the inputs.
///
/// `metric_series`: rows with the same `(metric_name, series_id)` collapse to one, with
/// `labels` from the later input, the smallest `min_ts` and the largest `max_ts`.
///
/// Errors: [`Error::Unsorted`] if an input is not in sort order, [`Error::MixedDays`] if
/// the rows span more than one UTC day, [`Error::Empty`] if there are no rows at all.
pub fn merge_files(table: Table, inputs: &[&[u8]]) -> Result<EncodedFile> {
    merge_files_with(table, inputs, &WriteOptions::default())
}

/// [`merge_files`] with explicit writer settings.
pub fn merge_files_with(table: Table, inputs: &[&[u8]], opts: &WriteOptions) -> Result<EncodedFile> {
    let shared: Vec<Bytes> = inputs.iter().map(|f| Bytes::copy_from_slice(f)).collect();
    merge_files_shared(table, &shared, opts)
}

/// [`merge_files_with`] over inputs the caller already holds as `Bytes`: nothing is
/// copied, which matters when the inputs are a large share of the memory there is (WASM).
pub fn merge_files_shared(table: Table, inputs: &[Bytes], opts: &WriteOptions) -> Result<EncodedFile> {
    let cap = opts.max_row_group_rows.max(1);
    match table {
        Table::MetricSamples => merge_samples(inputs, cap, opts),
        Table::MetricSeries => merge_series(inputs, cap, opts),
    }
}

/// Tracks that every row seen is in one UTC day.
struct DayCheck(Option<i64>);
impl DayCheck {
    fn see(&mut self, ts: i64) -> Result<()> {
        let d = day_number(ts);
        match self.0 {
            None => self.0 = Some(d),
            Some(first) if first != d => return Err(Error::MixedDays { first: format_day(first), other: format_day(d) }),
            _ => {}
        }
        Ok(())
    }
    fn day(&self) -> Result<String> {
        self.0.map(format_day).ok_or(Error::Empty)
    }
}

/// One input file, read a row group at a time.
struct Cursor {
    index: usize,
    reader: Reader,
    next_group: usize,
    names: Vec<ByteArray>,
    sid: Vec<i64>,
    ts: Vec<i64>,
    val: Vec<f64>,
    pos: usize,
    row: u64,
    prev: Option<(ByteArray, i64, i64)>,
}

impl Cursor {
    /// Make `pos` point at a row, loading the next non-empty row group if needed.
    /// Returns false at end of file.
    fn fill(&mut self) -> Result<bool> {
        while self.pos >= self.sid.len() {
            if self.next_group >= self.reader.num_row_groups() {
                return Ok(false);
            }
            let g = self.next_group;
            self.next_group += 1;
            let n = pq::group_rows(&self.reader, g, self.index)?;
            let rg = self.reader.get_row_group(g).map_err(pq::perr(Some(self.index)))?;
            pq::read_col::<ByteArrayType>(&*rg, 0, n, self.index, &mut self.names)?;
            pq::read_col::<Int64Type>(&*rg, 1, n, self.index, &mut self.sid)?;
            pq::read_col::<Int64Type>(&*rg, 2, n, self.index, &mut self.ts)?;
            pq::read_col::<DoubleType>(&*rg, 3, n, self.index, &mut self.val)?;
            self.pos = 0;
        }
        Ok(true)
    }

    /// Take the current row and check it does not sort before the previous one.
    fn take(&mut self) -> Result<Head> {
        let i = self.pos;
        let h = Head { name: self.names[i].clone(), sid: self.sid[i], ts: self.ts[i], val: self.val[i], input: self.index, row: self.row };
        if let Some((pn, ps, pt)) = &self.prev {
            if (pn.data(), *ps, *pt) > (h.name.data(), h.sid, h.ts) {
                return Err(Error::Unsorted { index: self.index, row: self.row });
            }
        }
        self.prev = Some((h.name.clone(), h.sid, h.ts));
        self.pos += 1;
        self.row += 1;
        Ok(h)
    }
}

/// The next row of one input, ordered for a min-heap: smallest key first, and among
/// equal keys the earlier input (then earlier row) first, so the winner is popped last.
struct Head {
    name: ByteArray,
    sid: i64,
    ts: i64,
    val: f64,
    input: usize,
    row: u64,
}

impl Head {
    fn key(&self) -> (&[u8], i64, i64, usize, u64) {
        (self.name.data(), self.sid, self.ts, self.input, self.row)
    }
    fn same_sample(&self, o: &Head) -> bool {
        self.sid == o.sid && self.ts == o.ts && self.name.data() == o.name.data()
    }
}
impl PartialEq for Head {
    fn eq(&self, o: &Self) -> bool {
        self.key() == o.key()
    }
}
impl Eq for Head {}
impl PartialOrd for Head {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Head {
    fn cmp(&self, o: &Self) -> Ordering {
        o.key().cmp(&self.key()) // reversed: BinaryHeap is a max-heap
    }
}

fn merge_samples(inputs: &[Bytes], cap: usize, opts: &WriteOptions) -> Result<EncodedFile> {
    let mut cursors = Vec::with_capacity(inputs.len());
    let mut heap = BinaryHeap::with_capacity(inputs.len());
    for (index, f) in inputs.iter().enumerate() {
        let (reader, _) = pq::open_shared(f.clone(), Table::MetricSamples, index)?;
        let mut c = Cursor { index, reader, next_group: 0, names: vec![], sid: vec![], ts: vec![], val: vec![], pos: 0, row: 0, prev: None };
        if c.fill()? {
            heap.push(c.take()?);
        }
        cursors.push(c);
    }

    // The merged file is about as large as its inputs together (smaller if rows repeat).
    let mut w = FileWriter::with_capacity(Table::MetricSamples, inputs.iter().map(|f| f.len()).sum::<usize>() + (64 << 10), opts)?;
    let mut days = DayCheck(None);
    let (mut names, mut sid, mut ts, mut val) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut pending: Option<Head> = None;
    loop {
        let next = heap.pop();
        if let Some(h) = &next {
            let c = &mut cursors[h.input];
            if c.fill()? {
                heap.push(c.take()?);
            }
        }
        // Emit the pending row unless `next` is a later duplicate of it.
        if let Some(p) = pending.take() {
            if !next.as_ref().is_some_and(|h| h.same_sample(&p)) {
                days.see(p.ts)?;
                names.push(p.name);
                sid.push(p.sid);
                ts.push(p.ts);
                val.push(p.val);
                if names.len() == cap {
                    w.write_group(Group::Samples { names: &names, series_id: &sid, ts: &ts, value: &val })?;
                    names.clear();
                    sid.clear();
                    ts.clear();
                    val.clear();
                }
            }
        }
        match next {
            Some(h) => pending = Some(h),
            None => break,
        }
    }
    w.write_group(Group::Samples { names: &names, series_id: &sid, ts: &ts, value: &val })?;
    if w.rows() == 0 {
        return Err(Error::Empty);
    }
    w.finish(days.day()?)
}

fn merge_series(inputs: &[Bytes], cap: usize, opts: &WriteOptions) -> Result<EncodedFile> {
    struct Row {
        name: ByteArray,
        sid: i64,
        labels: ByteArray,
        min_ts: i64,
        max_ts: i64,
    }
    // Series files are small next to sample files, so this merges by a stable sort of the
    // concatenated inputs: equal keys stay in input order, later inputs last.
    let mut rows: Vec<Row> = Vec::new();
    let (mut names, mut sids, mut labels, mut mins, mut maxs) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (index, f) in inputs.iter().enumerate() {
        let (r, _) = pq::open_shared(f.clone(), Table::MetricSeries, index)?;
        let mut row = 0u64;
        let first = rows.len();
        for g in 0..r.num_row_groups() {
            let n = pq::group_rows(&r, g, index)?;
            let rg = r.get_row_group(g).map_err(pq::perr(Some(index)))?;
            pq::read_col::<ByteArrayType>(&*rg, 0, n, index, &mut names)?;
            pq::read_col::<Int64Type>(&*rg, 1, n, index, &mut sids)?;
            pq::read_col::<ByteArrayType>(&*rg, 2, n, index, &mut labels)?;
            pq::read_col::<Int64Type>(&*rg, 3, n, index, &mut mins)?;
            pq::read_col::<Int64Type>(&*rg, 4, n, index, &mut maxs)?;
            for i in 0..n {
                if let Some(p) = rows[first..].last() {
                    if (p.name.data(), p.sid) > (names[i].data(), sids[i]) {
                        return Err(Error::Unsorted { index, row });
                    }
                }
                rows.push(Row { name: names[i].clone(), sid: sids[i], labels: labels[i].clone(), min_ts: mins[i], max_ts: maxs[i] });
                row += 1;
            }
        }
    }
    rows.sort_by(|a, b| (a.name.data(), a.sid).cmp(&(b.name.data(), b.sid)));

    let mut days = DayCheck(None);
    let (mut on, mut os, mut ol, mut omin, mut omax) = (Vec::new(), Vec::new(), Vec::new(), Vec::<i64>::new(), Vec::<i64>::new());
    for r in rows {
        days.see(r.min_ts)?;
        days.see(r.max_ts)?;
        let dup = on.last().is_some_and(|n: &ByteArray| n.data() == r.name.data()) && os.last() == Some(&r.sid);
        if dup {
            let k = on.len() - 1;
            ol[k] = r.labels;
            omin[k] = omin[k].min(r.min_ts);
            omax[k] = omax[k].max(r.max_ts);
        } else {
            on.push(r.name);
            os.push(r.sid);
            ol.push(r.labels);
            omin.push(r.min_ts);
            omax.push(r.max_ts);
        }
    }
    if on.is_empty() {
        return Err(Error::Empty);
    }
    let mut w = FileWriter::new(Table::MetricSeries, opts)?;
    let mut at = 0;
    while at < on.len() {
        let to = (at + cap).min(on.len());
        w.write_group(Group::Series { names: &on[at..to], series_id: &os[at..to], labels: &ol[at..to], min_ts: &omin[at..to], max_ts: &omax[at..to] })?;
        at = to;
    }
    w.finish(days.day()?)
}
