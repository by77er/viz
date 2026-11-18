//! Parquet plumbing shared by flush, select and merge: schemas, writer settings, the
//! row-group index fragment, and column readers. Uses the `parquet` crate's low-level
//! (non-Arrow) API.
use crate::error::{Error, Result};
use crate::json;
use bytes::Bytes;
use parquet::basic::{Compression, ConvertedType, Encoding, Repetition, Type as PhysicalType};
use parquet::column::reader::get_typed_column_reader;
use parquet::column::writer::ColumnWriter;
use parquet::data_type::{ByteArray, DataType};
use parquet::errors::ParquetError;
use parquet::file::metadata::SortingColumn;
use parquet::file::properties::{EnabledStatistics, WriterProperties, WriterVersion};
use parquet::file::reader::{FileReader, RowGroupReader, SerializedFileReader};
use parquet::file::writer::SerializedFileWriter;
use parquet::schema::types::{ColumnPath, Type};
use std::sync::Arc;

/// Row-group cap for flush files (contracts/TABLES.md).
pub const MAX_ROW_GROUP_ROWS: usize = 100_000;

/// Which metrics table a file belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Table {
    MetricSamples,
    MetricSeries,
}

impl Table {
    /// The name used in object keys and in the ledger (`metric_samples` / `metric_series`).
    pub fn as_str(self) -> &'static str {
        match self {
            Table::MetricSamples => "metric_samples",
            Table::MetricSeries => "metric_series",
        }
    }
    fn columns(self) -> &'static [(&'static str, PhysicalType)] {
        match self {
            Table::MetricSamples => &[
                ("metric_name", PhysicalType::BYTE_ARRAY),
                ("series_id", PhysicalType::INT64),
                ("ts", PhysicalType::INT64),
                ("value", PhysicalType::DOUBLE),
            ],
            Table::MetricSeries => &[
                ("metric_name", PhysicalType::BYTE_ARRAY),
                ("series_id", PhysicalType::INT64),
                ("labels", PhysicalType::BYTE_ARRAY),
                ("min_ts", PhysicalType::INT64),
                ("max_ts", PhysicalType::INT64),
            ],
        }
    }
}

/// One Parquet file produced by [`crate::encode_segment`] or [`crate::merge_files`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedFile {
    pub table: Table,
    /// UTC day, `YYYY-MM-DD`.
    pub day: String,
    /// The complete Parquet file.
    pub bytes: Vec<u8>,
    /// Number of rows.
    pub rows: u64,
    /// Smallest and largest sample time in the file (for `metric_series`: over the
    /// `min_ts` / `max_ts` columns).
    pub min_ts: i64,
    pub max_ts: i64,
    /// Row-group index fragment, compact JSON; see [`FileIndex`].
    pub index: String,
}

/// Writer settings. The default is the contract's 100,000-row cap.
#[derive(Debug, Clone)]
pub struct WriteOptions {
    /// Maximum rows per row group. Values below 1 are treated as 1.
    pub max_row_group_rows: usize,
}

impl Default for WriteOptions {
    fn default() -> Self {
        WriteOptions { max_row_group_rows: MAX_ROW_GROUP_ROWS }
    }
}

/// One row group in an index fragment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowGroupIndex {
    pub rows: u64,
    /// Byte offset of the row group's first page in the file, and the total compressed
    /// length of its column chunks (they are contiguous).
    pub offset: u64,
    pub length: u64,
    /// Exact smallest / largest `metric_name` in the row group (byte order).
    pub min_name: String,
    pub max_name: String,
    /// Exact smallest / largest `ts` (for `metric_series`: min of `min_ts`, max of `max_ts`).
    pub min_ts: i64,
    pub max_ts: i64,
}

/// The index fragment stored with a file's ledger row.
///
/// JSON form: `{"v":1,"rg":[{"rows":N,"off":N,"len":N,"min_name":"..","max_name":"..","min_ts":N,"max_ts":N},..]}`
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileIndex {
    pub row_groups: Vec<RowGroupIndex>,
}

impl FileIndex {
    pub fn to_json(&self) -> String {
        let mut s = String::from("{\"v\":1,\"rg\":[");
        for (i, g) in self.row_groups.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!("{{\"rows\":{},\"off\":{},\"len\":{},\"min_name\":", g.rows, g.offset, g.length));
            json::write_string(&mut s, &g.min_name);
            s.push_str(",\"max_name\":");
            json::write_string(&mut s, &g.max_name);
            s.push_str(&format!(",\"min_ts\":{},\"max_ts\":{}}}", g.min_ts, g.max_ts));
        }
        s.push_str("]}");
        s
    }

    pub fn from_json(s: &str) -> Result<FileIndex> {
        let bad = |m: &str| Error::Json(format!("index fragment: {m}"));
        let v = json::parse(s)?;
        if v.get("v") != Some(&json::Value::Int(1)) {
            return Err(bad("unsupported version"));
        }
        let Some(json::Value::Array(rg)) = v.get("rg") else { return Err(bad("missing rg")) };
        let int = |g: &json::Value, k: &str| match g.get(k) {
            Some(json::Value::Int(i)) => Ok(*i),
            _ => Err(bad(k)),
        };
        let uint = |g: &json::Value, k: &str| int(g, k).and_then(|i| u64::try_from(i).map_err(|_| bad(k)));
        let text = |g: &json::Value, k: &str| match g.get(k) {
            Some(json::Value::String(s)) => Ok(s.clone()),
            _ => Err(bad(k)),
        };
        let mut row_groups = Vec::with_capacity(rg.len());
        for g in rg {
            row_groups.push(RowGroupIndex {
                rows: uint(g, "rows")?,
                offset: uint(g, "off")?,
                length: uint(g, "len")?,
                min_name: text(g, "min_name")?,
                max_name: text(g, "max_name")?,
                min_ts: int(g, "min_ts")?,
                max_ts: int(g, "max_ts")?,
            });
        }
        Ok(FileIndex { row_groups })
    }
}

pub(crate) fn perr(index: Option<usize>) -> impl Fn(ParquetError) -> Error {
    move |e| Error::Parquet { index, message: e.to_string() }
}

fn schema(table: Table) -> Arc<Type> {
    let fields = table
        .columns()
        .iter()
        .map(|(name, t)| {
            let mut b = Type::primitive_type_builder(name, *t).with_repetition(Repetition::REQUIRED);
            if *t == PhysicalType::BYTE_ARRAY {
                b = b.with_converted_type(ConvertedType::UTF8);
            }
            Arc::new(b.build().expect("static schema"))
        })
        .collect();
    Arc::new(Type::group_type_builder("schema").with_fields(fields).build().expect("static schema"))
}

fn props(table: Table) -> Arc<WriterProperties> {
    let delta = |b: parquet::file::properties::WriterPropertiesBuilder, col: &str| {
        b.set_column_dictionary_enabled(ColumnPath::from(col), false)
            .set_column_encoding(ColumnPath::from(col), Encoding::DELTA_BINARY_PACKED)
    };
    let mut b = WriterProperties::builder()
        .set_writer_version(WriterVersion::PARQUET_2_0)
        .set_compression(Compression::SNAPPY)
        .set_statistics_enabled(EnabledStatistics::Chunk)
        // Exact min/max in the footer, so they can be compared with the index fragment.
        .set_statistics_truncate_length(None)
        .set_data_page_size_limit(256 * 1024)
        .set_created_by("viz-storage".to_string())
        // Declare the sort order in every row group, for readers that can use it.
        .set_sorting_columns(Some(
            (0..match table {
                Table::MetricSamples => 3,
                Table::MetricSeries => 2,
            })
                .map(|column_idx| SortingColumn { column_idx, descending: false, nulls_first: false })
                .collect(),
        ))
        .set_column_dictionary_enabled(ColumnPath::from("metric_name"), true);
    b = delta(b, "series_id");
    match table {
        Table::MetricSamples => {
            b = delta(b, "ts")
                .set_column_dictionary_enabled(ColumnPath::from("value"), false)
                .set_column_encoding(ColumnPath::from("value"), Encoding::BYTE_STREAM_SPLIT);
        }
        Table::MetricSeries => {
            b = delta(delta(b, "min_ts"), "max_ts")
                // One distinct value per row: a dictionary would only add bytes.
                .set_column_dictionary_enabled(ColumnPath::from("labels"), false)
                .set_column_encoding(ColumnPath::from("labels"), Encoding::PLAIN);
        }
    }
    Arc::new(b.build())
}

/// The columns of one row group to write.
pub(crate) enum Group<'a> {
    Samples { names: &'a [ByteArray], series_id: &'a [i64], ts: &'a [i64], value: &'a [f64] },
    Series { names: &'a [ByteArray], series_id: &'a [i64], labels: &'a [ByteArray], min_ts: &'a [i64], max_ts: &'a [i64] },
}

/// Writes one file row group by row group and builds its index fragment.
/// Callers pass rows already in the table's sort order.
pub(crate) struct FileWriter {
    table: Table,
    w: SerializedFileWriter<Vec<u8>>,
    index: FileIndex,
    rows: u64,
    min_ts: i64,
    max_ts: i64,
}

impl FileWriter {
    pub fn new(table: Table) -> Result<FileWriter> {
        FileWriter::with_capacity(table, 0)
    }

    /// A writer whose output buffer starts with room for `capacity` bytes, so a caller
    /// that knows roughly how large the file will be avoids the buffer doubling (and
    /// existing twice while it does).
    pub fn with_capacity(table: Table, capacity: usize) -> Result<FileWriter> {
        let w = SerializedFileWriter::new(Vec::with_capacity(capacity), schema(table), props(table)).map_err(perr(None))?;
        Ok(FileWriter { table, w, index: FileIndex::default(), rows: 0, min_ts: i64::MAX, max_ts: i64::MIN })
    }

    pub fn rows(&self) -> u64 {
        self.rows
    }

    /// Write one non-empty row group.
    pub fn write_group(&mut self, g: Group<'_>) -> Result<()> {
        let e = perr(None);
        let (names, lo, hi) = match &g {
            Group::Samples { names, ts, .. } => (*names, *ts, *ts),
            Group::Series { names, min_ts, max_ts, .. } => (*names, *min_ts, *max_ts),
        };
        let n = names.len();
        if n == 0 {
            return Ok(());
        }
        let (i64_cols, bytes_cols): ([&[i64]; 3], [&[ByteArray]; 2]) = match &g {
            Group::Samples { names, series_id, ts, .. } => ([series_id, ts, &[]], [names, &[]]),
            Group::Series { names, series_id, labels, min_ts, max_ts } => ([series_id, min_ts, max_ts], [names, labels]),
        };
        let mut rg = self.w.next_row_group().map_err(&e)?;
        let (mut ni, mut nb) = (0, 0);
        while let Some(mut cw) = rg.next_column().map_err(&e)? {
            match cw.untyped() {
                ColumnWriter::ByteArrayColumnWriter(c) => {
                    c.write_batch(bytes_cols[nb], None, None).map_err(&e)?;
                    nb += 1;
                }
                ColumnWriter::Int64ColumnWriter(c) => {
                    c.write_batch(i64_cols[ni], None, None).map_err(&e)?;
                    ni += 1;
                }
                ColumnWriter::DoubleColumnWriter(c) => match &g {
                    Group::Samples { value, .. } => {
                        c.write_batch(value, None, None).map_err(&e)?;
                    }
                    Group::Series { .. } => unreachable!("metric_series has no double column"),
                },
                _ => unreachable!("schema has only byte array, int64 and double columns"),
            }
            cw.close().map_err(&e)?;
        }
        let md = rg.close().map_err(&e)?;
        let offset = md.columns().iter().map(|c| c.byte_range().0).min().unwrap_or(0);
        let end = md.columns().iter().map(|c| c.byte_range().0 + c.byte_range().1).max().unwrap_or(0);
        let name = |b: &ByteArray| {
            std::str::from_utf8(b.data()).map(str::to_owned).map_err(|_| Error::Parquet { index: None, message: "metric_name is not UTF-8".into() })
        };
        let min_ts = lo.iter().copied().min().unwrap_or(0);
        let max_ts = hi.iter().copied().max().unwrap_or(0);
        self.index.row_groups.push(RowGroupIndex {
            rows: n as u64,
            offset,
            length: end - offset,
            // Rows arrive sorted by metric_name first, so the ends are the extremes.
            min_name: name(&names[0])?,
            max_name: name(&names[n - 1])?,
            min_ts,
            max_ts,
        });
        self.rows += n as u64;
        self.min_ts = self.min_ts.min(min_ts);
        self.max_ts = self.max_ts.max(max_ts);
        Ok(())
    }

    pub fn finish(mut self, day: String) -> Result<EncodedFile> {
        self.w.finish().map_err(perr(None))?;
        let bytes = std::mem::take(self.w.inner_mut());
        Ok(EncodedFile {
            table: self.table,
            day,
            bytes,
            rows: self.rows,
            min_ts: self.min_ts,
            max_ts: self.max_ts,
            index: self.index.to_json(),
        })
    }
}

pub(crate) type Reader = SerializedFileReader<Bytes>;

/// Open a whole file held in memory and check it has `table`'s schema.
pub(crate) fn open(bytes: &[u8], table: Table, index: usize) -> Result<Reader> {
    open_shared(Bytes::copy_from_slice(bytes), table, index)
}

/// [`open`] without the copy, for a caller that already holds the file as `Bytes`.
pub(crate) fn open_shared(bytes: Bytes, table: Table, index: usize) -> Result<Reader> {
    let r = SerializedFileReader::new(bytes).map_err(perr(Some(index)))?;
    let descr = r.metadata().file_metadata().schema_descr();
    let want = table.columns();
    if descr.num_columns() != want.len() {
        return Err(Error::Schema { index, message: format!("{} has {} columns, file has {}", table.as_str(), want.len(), descr.num_columns()) });
    }
    for (i, (name, t)) in want.iter().enumerate() {
        let c = descr.column(i);
        if c.name() != *name || c.physical_type() != *t || c.max_def_level() != 0 || c.max_rep_level() != 0 {
            return Err(Error::Schema { index, message: format!("column {i} is not required {name}") });
        }
    }
    Ok(r)
}

/// Read all `n` values of column `col` of a row group into `out` (cleared first).
pub(crate) fn read_col<T: DataType>(rg: &dyn RowGroupReader, col: usize, n: usize, index: usize, out: &mut Vec<T::T>) -> Result<()> {
    let e = perr(Some(index));
    out.clear();
    out.reserve(n.min(1 << 20));
    let mut r = get_typed_column_reader::<T>(rg.get_column_reader(col).map_err(&e)?);
    while out.len() < n {
        let (got, _, _) = r.read_records(n - out.len(), None, None, out).map_err(&e)?;
        if got == 0 {
            break;
        }
    }
    if out.len() != n {
        return Err(Error::Parquet { index: Some(index), message: format!("column {col}: expected {n} values, read {}", out.len()) });
    }
    Ok(())
}

/// Rows in row group `g`, as a `usize`.
pub(crate) fn group_rows(r: &Reader, g: usize, index: usize) -> Result<usize> {
    usize::try_from(r.metadata().row_group(g).num_rows())
        .map_err(|_| Error::Parquet { index: Some(index), message: "negative row count".into() })
}
