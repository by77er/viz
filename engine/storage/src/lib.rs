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

pub mod batch;
pub mod day;
mod encode;
mod error;
pub mod json;
mod merge;
mod pq;
mod select;
mod util;

pub use encode::{encode_segment, encode_segment_with};
pub use error::{BatchError, Error, Result};
pub use merge::{merge_files, merge_files_shared, merge_files_with};
pub use pq::{EncodedFile, FileIndex, RowGroupIndex, Table, WriteOptions, MAX_ROW_GROUP_ROWS};
pub use select::{select, select_with, MatchOp, Matcher, ScanInput, SelectOptions, SeriesData};
