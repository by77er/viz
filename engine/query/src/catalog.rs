//! A series-only read of `metric_series` files (contracts/TABLES.md): one row per series
//! present in a file, with its labels and the first and last sample time in that file.
//!
//! `viz-storage` has no series-only read (its `select` returns samples too), and it is
//! being changed by another engineer, so this reader lives here and reads the table as
//! the contract defines it: an independent reader of the format. It is used by
//!
//! - the leaves of split execution, to find the series of their split before any sample
//!   is decoded, and
//! - the cardinality report (`crate::cardinality`), which never needs samples.
//!
//! Row groups are decoded one at a time; a row group whose `metric_name` statistics
//! exclude every wanted name is skipped, and so is one the caller did not fetch (a file
//! may be a sparse file container, `viz_storage::sparse`).
use crate::error::QueryError;
use bytes::Bytes;
use parquet::basic::Type as PhysicalType;
use parquet::column::reader::get_typed_column_reader;
use parquet::data_type::{ByteArray, ByteArrayType, DataType, Int64Type};
use parquet::file::reader::{FileReader, RowGroupReader};
use parquet::file::statistics::Statistics;

const COLUMNS: [(&str, PhysicalType); 5] = [
    ("metric_name", PhysicalType::BYTE_ARRAY),
    ("series_id", PhysicalType::INT64),
    ("labels", PhysicalType::BYTE_ARRAY),
    ("min_ts", PhysicalType::INT64),
    ("max_ts", PhysicalType::INT64),
];

/// One row of a `metric_series` file.
#[derive(Debug, Clone, Copy)]
pub struct SeriesRow<'a> {
    pub metric_name: &'a [u8],
    pub series_id: i64,
    /// Canonical JSON object of all labels including `__name__`.
    pub labels_json: &'a [u8],
    pub min_ts: i64,
    pub max_ts: i64,
}

fn perr(file: usize) -> impl Fn(parquet::errors::ParquetError) -> QueryError {
    move |e| QueryError::internal(format!("metric_series file {file}: {e}"))
}

fn read_col<T: DataType>(rg: &dyn RowGroupReader, col: usize, n: usize, file: usize, out: &mut Vec<T::T>) -> Result<(), QueryError> {
    out.clear();
    out.reserve(n.min(1 << 20));
    let mut r = get_typed_column_reader::<T>(rg.get_column_reader(col).map_err(perr(file))?);
    while out.len() < n {
        let (got, _, _) = r.read_records(n - out.len(), None, None, out).map_err(perr(file))?;
        if got == 0 {
            break;
        }
    }
    if out.len() != n {
        return Err(QueryError::internal(format!("metric_series file {file}: column {col}: expected {n} values, read {}", out.len())));
    }
    Ok(())
}

/// Call `f` for every row of the `metric_series` file `bytes` (index `file` in error
/// messages) whose metric name `want` accepts. `want` is also asked about each row
/// group's `[min_name, max_name]` (`want_range`), so groups that hold no wanted name are
/// not decoded.
pub fn for_each_series(
    bytes: &[u8],
    file: usize,
    want_range: &dyn Fn(&[u8], &[u8]) -> bool,
    want: &dyn Fn(&[u8]) -> bool,
    f: &mut dyn FnMut(SeriesRow<'_>) -> Result<(), QueryError>,
) -> Result<(), QueryError> {
    let src = viz_storage::sparse::Source::from_bytes(Bytes::copy_from_slice(bytes), Some(file)).map_err(|e| QueryError::internal(format!("metric_series file {file}: {e}")))?;
    let r = viz_storage::sparse::reader(src.clone()).map_err(perr(file))?;
    let descr = r.metadata().file_metadata().schema_descr();
    if descr.num_columns() != COLUMNS.len() {
        return Err(QueryError::internal(format!("metric_series file {file}: {} columns, the table has {}", descr.num_columns(), COLUMNS.len())));
    }
    for (i, (name, t)) in COLUMNS.iter().enumerate() {
        let c = descr.column(i);
        if c.name() != *name || c.physical_type() != *t || c.max_def_level() != 0 || c.max_rep_level() != 0 {
            return Err(QueryError::internal(format!("metric_series file {file}: column {i} is not required {name}")));
        }
    }
    let (mut names, mut sids, mut labels, mut lo, mut hi) = (Vec::<ByteArray>::new(), Vec::<i64>::new(), Vec::<ByteArray>::new(), Vec::<i64>::new(), Vec::<i64>::new());
    for g in 0..r.num_row_groups() {
        let md = r.metadata().row_group(g);
        if !src.has_row_group(md) {
            continue; // not fetched: it holds no series the caller needs
        }
        if let Some(Statistics::ByteArray(st)) = md.column(0).statistics() {
            if let (Some(a), Some(b)) = (st.min_opt(), st.max_opt()) {
                if !want_range(a.data(), b.data()) {
                    continue;
                }
            }
        }
        let n = usize::try_from(md.num_rows()).map_err(|_| QueryError::internal(format!("metric_series file {file}: negative row count")))?;
        let rg = r.get_row_group(g).map_err(perr(file))?;
        read_col::<ByteArrayType>(&*rg, 0, n, file, &mut names)?;
        if !names.iter().any(|x| want(x.data())) {
            continue;
        }
        read_col::<Int64Type>(&*rg, 1, n, file, &mut sids)?;
        read_col::<ByteArrayType>(&*rg, 2, n, file, &mut labels)?;
        read_col::<Int64Type>(&*rg, 3, n, file, &mut lo)?;
        read_col::<Int64Type>(&*rg, 4, n, file, &mut hi)?;
        for i in 0..n {
            if want(names[i].data()) {
                f(SeriesRow { metric_name: names[i].data(), series_id: sids[i], labels_json: labels[i].data(), min_ts: lo[i], max_ts: hi[i] })?;
            }
        }
    }
    Ok(())
}

/// Parse a row's labels (canonical JSON, keys sorted).
pub fn parse_labels(json: &[u8]) -> Result<Vec<(String, String)>, QueryError> {
    let text = std::str::from_utf8(json).map_err(|_| QueryError::internal("metric_series labels are not UTF-8"))?;
    viz_storage::json::parse_labels(text).map_err(|e| QueryError::internal(format!("metric_series labels: {e}")))
}
