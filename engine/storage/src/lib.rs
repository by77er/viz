//! # viz-storage
//!
//! The storage half of the viz engine: `VZB1` batches in, sorted Parquet files out, and
//! reads that merge lake files with shard tails. See `contracts/BATCH.md` and
//! `contracts/TABLES.md`.
//!
//! The crate does no I/O, reads no clock and uses no randomness: every function is a
//! pure function of the bytes it is given, so it behaves the same in WASM, natively and
//! in a deterministic simulator. Malformed input returns an [`Error`]; it does not panic.
//!
//! | Function | Purpose |
//! |---|---|
//! | [`batch::decode`], [`batch::encode`], [`batch::series_id`] | the `VZB1` batch format |
//! | [`encode_segment`] | flush: batches of a sealed segment to per-day Parquet files |
//! | [`select`] | read: matchers to series, lake + tail merged per series |
//! | [`merge_files`] | compaction: several files of a tenant-day into one |
//! | [`otel`] | the `VZB1` span (signal 2) and log-record (signal 3) batches |
//! | [`encode_spans`], [`encode_logs`] | flush of span and log batches to `spans` + `trace_index` and `logs` files (`contracts/TRACES.md`, `LOGS.md`) |
//! | [`read_spans`], [`read_trace_index`], [`read_logs`] | whole-file readers of those tables, for tests and tools |
//! | [`merge_signal_files`] | compaction of `spans` (per hour), `trace_index` and `logs` (per day) |
//! | [`tokens`] | the `logs` token filter: its tokens, builder and reader (`contracts/LOGS.md` §6) |

pub mod batch;
pub mod day;
mod encode;
mod error;
pub mod json;
mod logs;
mod merge;
pub mod otel;
mod otelpq;
mod otelread;
mod pq;
mod select;
mod sigmerge;
pub mod sparse;
mod spans;
pub mod tokens;
mod util;

pub use encode::{encode_segment, encode_segment_with};
pub use error::{BatchError, Error, Result};
pub use merge::{merge_files, merge_files_shared, merge_files_with};
pub use pq::{EncodedFile, FileIndex, RowGroupIndex, Table, WriteOptions, MAX_ROW_GROUP_ROWS, PAGE_ROWS};
pub use select::{select, select_with, MatchOp, Matcher, ScanInput, SelectOptions, SeriesData};
pub use logs::{encode_logs, encode_logs_with, FRAGMENT_MAX_LABEL_BYTES, FRAGMENT_MAX_STREAMS};
pub use otelpq::{day_of_ns, SignalError, SignalFile, SignalTable, SignalWriteOptions, NS_PER_DAY, NS_PER_HOUR, SIGNAL_ROW_GROUP_BYTES, SIGNAL_ROW_GROUP_ROWS};
pub use otelread::{read_logs, read_logs_row_groups, read_spans, read_trace_index, LogRecord, SpanRecord};
pub use sigmerge::{merge_signal_files, merge_signal_files_chunked, merge_signal_files_shared, SignalMergeOptions, MERGE_ROW_GROUP_BYTES};
pub use spans::{encode_spans, encode_spans_with, merge_fragments, Fragment, PROMOTED_RESOURCE, PROMOTED_SPAN};
