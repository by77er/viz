//! Parquet plumbing for the span and log tables (`contracts/TRACES.md`,
//! `contracts/LOGS.md`): file types, writer settings, nested-column levels and the row-group
//! writer. Separate from `pq.rs` so that the metrics files stay byte-identical.
use crate::otel::SignalBatchError;
use parquet::basic::{Compression, Encoding};
use parquet::column::writer::ColumnWriter;
use parquet::data_type::{ByteArray, FixedLenByteArray};
use parquet::file::metadata::SortingColumn;
use parquet::file::properties::{EnabledStatistics, WriterProperties, WriterPropertiesBuilder, WriterVersion};
use parquet::file::writer::SerializedFileWriter;
use parquet::schema::types::{ColumnPath, Type};
use std::fmt;
use std::sync::Arc;

/// Which table a span or log file belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SignalTable {
    Spans,
    TraceIndex,
    Logs,
}

impl SignalTable {
    /// The table name used in object keys and in the ledger.
    pub fn as_str(self) -> &'static str {
        match self {
            SignalTable::Spans => "spans",
            SignalTable::TraceIndex => "trace_index",
            SignalTable::Logs => "logs",
        }
    }
}

/// One Parquet file of the span or log tables.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalFile {
    pub table: SignalTable,
    /// UTC day, `YYYY-MM-DD`: of `start_time` (spans), `min_start_unix_nano` (trace_index),
    /// `ts` (logs).
    pub day: String,
    /// `spans` only: the hour of the day (0 to 23) of every row's start time.
    pub hour: Option<u8>,
    pub bytes: Vec<u8>,
    pub rows: u64,
    /// Nanoseconds: smallest and largest `start_unix_nano` (spans), smallest
    /// `min_start_unix_nano` and largest `max_end_unix_nano` (trace_index), `ts` (logs).
    pub min_ts: i64,
    pub max_ts: i64,
    /// The index fragment, compact JSON (`contracts/TRACES.md` / `LOGS.md`).
    pub index: String,
}

/// Errors of the span and log encoders and readers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalError {
    /// `batches[index]` is not a valid batch of the signal.
    Batch { index: usize, error: SignalBatchError },
    /// The Parquet library failed, or a file does not read as the table it was passed as.
    Parquet(String),
    /// A compaction merge's inputs cannot be merged: none, no rows, not sorted, or rows of more
    /// than one partition (an hour of `spans`, a day of `trace_index` and `logs`).
    Merge(String),
}

impl fmt::Display for SignalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SignalError::Batch { index, error } => write!(f, "batch {index}: {error}"),
            SignalError::Parquet(m) => write!(f, "parquet: {m}"),
            SignalError::Merge(m) => write!(f, "merge: {m}"),
        }
    }
}
impl std::error::Error for SignalError {}

pub type SResult<T> = Result<T, SignalError>;

pub(crate) fn perr(e: parquet::errors::ParquetError) -> SignalError {
    SignalError::Parquet(e.to_string())
}

/// Row-group cap in rows (`contracts/TRACES.md`, `LOGS.md`).
pub const SIGNAL_ROW_GROUP_ROWS: usize = 100_000;
/// Row-group cap in data bytes, as the contracts count them.
pub const SIGNAL_ROW_GROUP_BYTES: usize = 16 << 20;
/// `line` pages: the writer cuts a page once it holds this many encoded bytes, and adds at
/// most [`LINE_CHUNK_BYTES`] at a time, so no page exceeds 1 MiB (`contracts/LOGS.md` §4).
pub const LINE_PAGE_CUT_BYTES: usize = 786_432 - 16;
pub const LINE_CHUNK_BYTES: usize = 262_148;

/// Writer settings; the default is the contracts' layout.
#[derive(Debug, Clone)]
pub struct SignalWriteOptions {
    pub max_row_group_rows: usize,
    pub max_row_group_bytes: usize,
    pub page_rows: usize,
}

impl Default for SignalWriteOptions {
    fn default() -> Self {
        SignalWriteOptions { max_row_group_rows: SIGNAL_ROW_GROUP_ROWS, max_row_group_bytes: SIGNAL_ROW_GROUP_BYTES, page_rows: crate::PAGE_ROWS }
    }
}

/// Split `weights` (in row order) into consecutive row groups of at most `max_rows` rows and
/// at most `max_bytes` weight (a row heavier than `max_bytes` gets a row group of its own).
pub(crate) fn cut_groups(weights: &[usize], opts: &SignalWriteOptions) -> Vec<(usize, usize)> {
    let max_rows = opts.max_row_group_rows.max(1);
    let mut out = Vec::new();
    let mut start = 0;
    let mut bytes = 0usize;
    for (i, w) in weights.iter().enumerate() {
        if i > start && (i - start >= max_rows || bytes + w > opts.max_row_group_bytes) {
            out.push((start, i));
            start = i;
            bytes = 0;
        }
        bytes += w;
    }
    if start < weights.len() {
        out.push((start, weights.len()));
    }
    out
}

/// Where the span and log writers write: chunks of at most 1 MiB, joined once at the end. A
/// growing `Vec` doubles, holding the old and the new buffer at once (twice the file at its
/// largest); chunks never move, and joining frees each chunk as it is copied.
#[derive(Default)]
pub(crate) struct Sink {
    chunks: Vec<Vec<u8>>,
    len: usize,
}

const SINK_CHUNK_MAX: usize = 1 << 20;

impl std::io::Write for Sink {
    fn write(&mut self, mut buf: &[u8]) -> std::io::Result<usize> {
        let n = buf.len();
        while !buf.is_empty() {
            if self.chunks.last().is_none_or(|c| c.len() == c.capacity()) {
                // 64 KiB first, then as large as what was written so far, up to 1 MiB.
                self.chunks.push(Vec::with_capacity(self.len.clamp(64 << 10, SINK_CHUNK_MAX)));
            }
            let c = self.chunks.last_mut().unwrap();
            let k = (c.capacity() - c.len()).min(buf.len());
            c.extend_from_slice(&buf[..k]);
            buf = &buf[k..];
        }
        self.len += n;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Sink {
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    /// The chunks, in order (a caller that copies them out one by one never holds two copies).
    pub(crate) fn into_chunks(self) -> Vec<Vec<u8>> {
        self.chunks
    }

    /// The bytes in one buffer of exactly their length.
    pub(crate) fn into_bytes(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.len);
        for c in self.chunks {
            out.extend_from_slice(&c);
        }
        out
    }
}

/// Definition and repetition levels of one leaf column (none for a required top-level leaf).
#[derive(Debug, Clone, Default)]
pub(crate) struct Levels {
    pub def: Option<Vec<i16>>,
    pub rep: Option<Vec<i16>>,
}

impl Levels {
    pub fn none() -> Levels {
        Levels::default()
    }
    /// An optional top-level leaf: 1 where present, 0 where null.
    pub fn optional(present: impl Iterator<Item = bool>) -> Levels {
        Levels { def: Some(present.map(|p| p as i16).collect()), rep: None }
    }
    /// The leaves under a list or map: per row, `None` (a null optional group) or the number
    /// of items. `optional`: the outer group is optional (adds one definition level).
    pub fn repeated(counts: impl Iterator<Item = Option<usize>>, optional: bool) -> Levels {
        let base = optional as i16;
        let (mut def, mut rep) = (Vec::new(), Vec::new());
        for c in counts {
            match c {
                None => {
                    def.push(0);
                    rep.push(0);
                }
                Some(0) => {
                    def.push(base);
                    rep.push(0);
                }
                Some(n) => {
                    for k in 0..n {
                        def.push(base + 1);
                        rep.push((k > 0) as i16);
                    }
                }
            }
        }
        Levels { def: Some(def), rep: Some(rep) }
    }
}

/// The values of one leaf column of a row group, with their levels, in schema order.
pub(crate) enum Leaf {
    I32(Vec<i32>, Levels),
    I64(Vec<i64>, Levels),
    F64(Vec<f64>, Levels),
    Bool(Vec<bool>, Levels),
    Bytes(Vec<ByteArray>, Levels),
    /// A required byte-array column written in pieces of at most this many encoded bytes
    /// (`line`), so that pages can be bounded.
    BytesChunked(Vec<ByteArray>, usize),
    Fixed(Vec<FixedLenByteArray>, Levels),
}

/// A string as a Parquet byte array.
pub(crate) fn ba(s: &str) -> ByteArray {
    ByteArray::from(s.as_bytes().to_vec())
}
pub(crate) fn fba(b: &[u8]) -> FixedLenByteArray {
    FixedLenByteArray::from(b.to_vec())
}

/// Write one row group from its leaves, in schema order. Returns the byte range the row
/// group's column chunks occupy.
pub(crate) fn write_group(w: &mut SerializedFileWriter<Sink>, leaves: Vec<Leaf>) -> SResult<(u64, u64)> {
    let mut rg = w.next_row_group().map_err(perr)?;
    let mut it = leaves.into_iter();
    while let Some(mut cw) = rg.next_column().map_err(perr)? {
        let leaf = it.next().ok_or_else(|| SignalError::Parquet("fewer leaves than columns".into()))?;
        let lv = |l: &Levels| (l.def.clone(), l.rep.clone());
        match (cw.untyped(), leaf) {
            (ColumnWriter::Int32ColumnWriter(c), Leaf::I32(v, l)) => {
                let (d, r) = lv(&l);
                c.write_batch(&v, d.as_deref(), r.as_deref()).map_err(perr)?;
            }
            (ColumnWriter::Int64ColumnWriter(c), Leaf::I64(v, l)) => {
                let (d, r) = lv(&l);
                c.write_batch(&v, d.as_deref(), r.as_deref()).map_err(perr)?;
            }
            (ColumnWriter::DoubleColumnWriter(c), Leaf::F64(v, l)) => {
                let (d, r) = lv(&l);
                c.write_batch(&v, d.as_deref(), r.as_deref()).map_err(perr)?;
            }
            (ColumnWriter::BoolColumnWriter(c), Leaf::Bool(v, l)) => {
                let (d, r) = lv(&l);
                c.write_batch(&v, d.as_deref(), r.as_deref()).map_err(perr)?;
            }
            (ColumnWriter::ByteArrayColumnWriter(c), Leaf::Bytes(v, l)) => {
                let (d, r) = lv(&l);
                c.write_batch(&v, d.as_deref(), r.as_deref()).map_err(perr)?;
            }
            (ColumnWriter::ByteArrayColumnWriter(c), Leaf::BytesChunked(v, max)) => {
                let mut start = 0;
                while start < v.len() {
                    let mut end = start;
                    let mut bytes = 0;
                    while end < v.len() && (end == start || bytes + 4 + v[end].len() <= max) {
                        bytes += 4 + v[end].len();
                        end += 1;
                    }
                    c.write_batch(&v[start..end], None, None).map_err(perr)?;
                    start = end;
                }
            }
            (ColumnWriter::FixedLenByteArrayColumnWriter(c), Leaf::Fixed(v, l)) => {
                let (d, r) = lv(&l);
                c.write_batch(&v, d.as_deref(), r.as_deref()).map_err(perr)?;
            }
            _ => return Err(SignalError::Parquet("a leaf does not match its column's type".into())),
        }
        cw.close().map_err(perr)?;
    }
    if it.next().is_some() {
        return Err(SignalError::Parquet("more leaves than columns".into()));
    }
    let md = rg.close().map_err(perr)?;
    let offset = md.columns().iter().map(|c| c.byte_range().0).min().unwrap_or(0);
    let end = md.columns().iter().map(|c| c.byte_range().0 + c.byte_range().1).max().unwrap_or(0);
    Ok((offset, end - offset))
}

/// The byte range of the bloom filter of column `col` in the row group written last, when it
/// has one (`contracts/TRACES.md`, "Index fragments": `bf`). The writer puts each row group's
/// filters right after its column chunks, so this lies between the group and the next one (or,
/// for the last group, at the start of `foot`).
pub(crate) fn last_bloom(w: &SerializedFileWriter<Sink>, col: usize) -> Option<(u64, u64)> {
    let c = w.flushed_row_groups().last()?.columns().get(col)?;
    let (o, l) = (c.bloom_filter_offset()?, c.bloom_filter_length()?);
    (o >= 0 && l > 0).then_some((o as u64, l as u64))
}

pub(crate) fn schema(text: &str) -> Arc<Type> {
    Arc::new(parquet::schema::parser::parse_message_type(text).expect("static schema"))
}

/// A column path from its dotted parts.
pub(crate) fn path(parts: &[&str]) -> ColumnPath {
    ColumnPath::new(parts.iter().map(|s| s.to_string()).collect())
}

/// How one leaf column is written.
pub(crate) struct ColSpec {
    pub path: ColumnPath,
    pub dict: bool,
    pub encoding: Option<Encoding>,
    pub stats: EnabledStatistics,
    pub bloom: bool,
    pub page_bytes: Option<usize>,
}

pub(crate) fn col(parts: &[&str]) -> ColSpec {
    ColSpec { path: path(parts), dict: false, encoding: None, stats: EnabledStatistics::Chunk, bloom: false, page_bytes: None }
}

impl ColSpec {
    pub fn dict(mut self) -> Self {
        self.dict = true;
        self
    }
    pub fn delta(mut self) -> Self {
        self.encoding = Some(Encoding::DELTA_BINARY_PACKED);
        self
    }
    pub fn plain(mut self) -> Self {
        self.encoding = Some(Encoding::PLAIN);
        self
    }
    pub fn stats(mut self, s: EnabledStatistics) -> Self {
        self.stats = s;
        self
    }
    pub fn bloom(mut self) -> Self {
        self.bloom = true;
        self
    }
    pub fn page_bytes(mut self, n: usize) -> Self {
        self.page_bytes = Some(n);
        self
    }
}

/// Writer properties: format v2 pages, snappy, exact statistics, the offset index, the
/// declared sort, and per-column encodings.
pub(crate) fn props(cols: Vec<ColSpec>, sorting: Vec<SortingColumn>, opts: &SignalWriteOptions) -> Arc<WriterProperties> {
    let page_rows = opts.page_rows.max(1);
    let mut b: WriterPropertiesBuilder = WriterProperties::builder()
        .set_writer_version(WriterVersion::PARQUET_2_0)
        .set_compression(Compression::SNAPPY)
        .set_statistics_enabled(EnabledStatistics::Chunk)
        .set_statistics_truncate_length(None)
        .set_data_page_size_limit(256 * 1024)
        .set_data_page_row_count_limit(page_rows)
        .set_write_batch_size(page_rows.min(1024))
        .set_dictionary_enabled(false)
        .set_created_by("viz-storage".to_string())
        .set_sorting_columns(if sorting.is_empty() { None } else { Some(sorting) });
    for c in cols {
        b = b.set_column_dictionary_enabled(c.path.clone(), c.dict);
        if let Some(e) = c.encoding {
            b = b.set_column_encoding(c.path.clone(), e);
        }
        b = b.set_column_statistics_enabled(c.path.clone(), c.stats);
        if c.bloom {
            b = b
                .set_column_bloom_filter_enabled(c.path.clone(), true)
                .set_column_bloom_filter_fpp(c.path.clone(), 0.01)
                .set_column_bloom_filter_max_ndv(c.path.clone(), opts.max_row_group_rows.max(1) as u64);
        }
        if let Some(n) = c.page_bytes {
            b = b.set_column_data_page_size_limit(c.path.clone(), n);
        }
    }
    Arc::new(b.build())
}

/// The index fragment's `foot`: everything after the last row group.
pub(crate) fn foot(groups_end: u64, file_len: usize) -> (u64, u64) {
    (groups_end, (file_len as u64).saturating_sub(groups_end))
}

/// Append a JSON string (canonical escaping, as `json::write_string`).
pub(crate) fn json_str(out: &mut String, s: &str) {
    crate::json::write_string(out, s)
}

pub(crate) fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 * b.len());
    for x in b {
        s.push(char::from_digit((x >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((x & 15) as u32, 16).unwrap());
    }
    s
}

/// Nanoseconds per hour and per day.
pub const NS_PER_HOUR: i64 = 3_600_000_000_000;
pub const NS_PER_DAY: i64 = 86_400_000_000_000;

/// `YYYY-MM-DD` of a Unix-nanosecond timestamp.
pub fn day_of_ns(ts: i64) -> String {
    crate::day::format_day(ts.div_euclid(NS_PER_DAY))
}
