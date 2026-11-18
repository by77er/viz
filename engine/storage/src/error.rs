//! Error types. Every public function returns these instead of panicking.
use std::fmt;

/// Why a `VZB1` batch was rejected. Offsets are byte offsets from the start of the batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchError {
    /// The first four bytes are not `VZB1` (or the input is shorter than four bytes and
    /// what is there is not a prefix of the magic).
    BadMagic,
    /// The input ends before the named field is complete.
    Truncated { what: &'static str, needed: u64, len: u64 },
    /// `signal` is not 1 (metrics).
    UnsupportedSignal(u8),
    /// `flags` is not 0.
    BadFlags(u8),
    /// `reserved` is not 0.
    BadReserved(u16),
    /// `n_rows` is 0 but `n_series` is not, or the other way round.
    EmptyMismatch { n_rows: u32, n_series: u32 },
    /// A padding byte is not zero.
    NonZeroPadding { offset: u64 },
    /// Bytes remain after the value column.
    TrailingBytes { expected: u64, len: u64 },
    /// A row's `series_idx` is not below `n_series`.
    SeriesIndexOutOfRange { row: u32, index: u32, n_series: u32 },
    /// Labels of a series entry are not in ascending byte order of name.
    UnsortedLabels { series: u32 },
    /// A label name occurs twice in one series entry.
    DuplicateLabel { series: u32 },
    /// A series entry has no `__name__` label.
    MissingName { series: u32 },
    /// A label name is empty.
    EmptyLabelName { series: u32 },
    /// A label value is empty (empty-valued labels must be dropped before encoding).
    EmptyLabelValue { series: u32 },
    /// A label name or value is not valid UTF-8.
    InvalidUtf8 { series: u32 },
    /// A label name or value contains a NUL byte (it would make the `series_id` input ambiguous).
    NulInLabel { series: u32 },
    /// A series entry has more than 128 labels.
    TooManyLabels { series: u32, n_labels: u32 },
    /// A label name is longer than 1,024 bytes or a value longer than 8,192 bytes (on
    /// encode: also anything that does not fit the format's `u16` length).
    LabelTooLong { series: u32 },
    /// A row's timestamp is outside 0..=253,402,300,799,999 (years 1970 to 9999).
    TimestampOutOfRange { row: u32, ts: i64 },
    /// (encode only) more than `u32::MAX` rows or series.
    TooLarge,
}

impl fmt::Display for BatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use BatchError::*;
        match self {
            BadMagic => write!(f, "bad magic: not a VZB1 batch"),
            Truncated { what, needed, len } => {
                write!(f, "truncated: {what} needs {needed} bytes, batch has {len}")
            }
            UnsupportedSignal(s) => write!(f, "unsupported signal {s}"),
            BadFlags(x) => write!(f, "flags must be 0, got {x}"),
            BadReserved(x) => write!(f, "reserved must be 0, got {x}"),
            EmptyMismatch { n_rows, n_series } => {
                write!(f, "n_rows={n_rows} and n_series={n_series}: both or neither must be 0")
            }
            NonZeroPadding { offset } => write!(f, "non-zero padding byte at offset {offset}"),
            TrailingBytes { expected, len } => {
                write!(f, "trailing bytes: batch ends at {expected}, input has {len}")
            }
            SeriesIndexOutOfRange { row, index, n_series } => {
                write!(f, "row {row}: series index {index} out of range (n_series={n_series})")
            }
            UnsortedLabels { series } => write!(f, "series {series}: labels not sorted by name"),
            DuplicateLabel { series } => write!(f, "series {series}: duplicate label name"),
            MissingName { series } => write!(f, "series {series}: missing __name__"),
            EmptyLabelName { series } => write!(f, "series {series}: empty label name"),
            EmptyLabelValue { series } => write!(f, "series {series}: empty label value"),
            InvalidUtf8 { series } => write!(f, "series {series}: label is not valid UTF-8"),
            NulInLabel { series } => write!(f, "series {series}: NUL byte in a label"),
            TooManyLabels { series, n_labels } => write!(f, "series {series}: {n_labels} labels, at most 128 allowed"),
            LabelTooLong { series } => write!(f, "series {series}: label name over 1024 bytes or value over 8192 bytes"),
            TimestampOutOfRange { row, ts } => write!(f, "row {row}: timestamp {ts} outside 0..=253402300799999"),
            TooLarge => write!(f, "too many rows or series for one batch"),
        }
    }
}
impl std::error::Error for BatchError {}

/// Errors from the storage engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// `batches[index]` is not a valid `VZB1` batch.
    Batch { index: usize, error: BatchError },
    /// The Parquet library rejected `files[index]` (or failed to write).
    Parquet { index: Option<usize>, message: String },
    /// A Parquet file does not have the schema of the table it was passed as.
    Schema { index: usize, message: String },
    /// A matcher is invalid (bad regular expression).
    Matcher { name: String, message: String },
    /// `merge_files`: an input is not sorted in its table's sort order.
    Unsorted { index: usize, row: u64 },
    /// `merge_files`: the inputs span more than one UTC day.
    MixedDays { first: String, other: String },
    /// `merge_files`: no input rows.
    Empty,
    /// A `labels` cell or an index fragment is not the JSON this crate writes.
    Json(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Batch { index, error } => write!(f, "batch {index}: {error}"),
            Error::Parquet { index: Some(i), message } => write!(f, "parquet file {i}: {message}"),
            Error::Parquet { index: None, message } => write!(f, "parquet: {message}"),
            Error::Schema { index, message } => write!(f, "parquet file {index}: schema: {message}"),
            Error::Matcher { name, message } => write!(f, "matcher on {name:?}: {message}"),
            Error::Unsorted { index, row } => write!(f, "merge input {index} is not sorted at row {row}"),
            Error::MixedDays { first, other } => write!(f, "merge inputs span days {first} and {other}"),
            Error::Empty => write!(f, "merge has no input rows"),
            Error::Json(m) => write!(f, "json: {m}"),
        }
    }
}
impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;
