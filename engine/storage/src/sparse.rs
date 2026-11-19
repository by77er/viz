//! A Parquet file held in part: the byte ranges a reader fetched (the footer and the row
//! groups it needs), each at its offset in the file.
//!
//! The query Worker range-reads files from R2 (`contracts/TABLES.md`, "Reading part of a
//! file") and hands the engine a **sparse file container** instead of the whole object:
//!
//! ```text
//! b"VZS1" | u64 file_len | u32 n | n x (u64 offset, u64 len) | the n segments' bytes, in order
//! ```
//!
//! All integers little-endian. Segments are sorted, do not overlap and lie inside the file;
//! the bytes that follow the table are exactly their concatenation. The container is an
//! in-memory format between the engine and its binding (never stored); its magic is its
//! version. A whole Parquet file (starting with `PAR1`) is accepted anywhere a container is.
//!
//! Readers ([`crate::select`], `viz-query`'s series reader) skip a row group whose bytes are
//! not in the container: the caller left it out because it holds no row the read needs
//! (`FileIndex::row_group_may_hold`). Everything else (the footer, every page of a row
//! group that is read) must be present, or the read fails; it never returns a partial answer.
use crate::error::{Error, Result};
use bytes::{Buf, Bytes};
use parquet::errors::ParquetError;
use parquet::file::metadata::RowGroupMetaData;
use parquet::file::reader::{ChunkReader, Length};
use std::sync::Arc;

/// Magic of a sparse file container.
pub const MAGIC: &[u8; 4] = b"VZS1";

/// The bytes of one file, whole or in segments, as the `parquet` crate's reader wants them.
#[derive(Clone, Debug)]
pub struct Source {
    len: u64,
    /// Sorted by offset, disjoint.
    segs: Arc<Vec<(u64, Bytes)>>,
}

impl Source {
    /// A whole file.
    pub fn whole(bytes: Bytes) -> Source {
        Source { len: bytes.len() as u64, segs: Arc::new(vec![(0, bytes)]) }
    }

    /// A whole Parquet file, or a sparse file container (see the module documentation).
    pub fn from_bytes(bytes: Bytes, index: Option<usize>) -> Result<Source> {
        if bytes.len() < 4 || &bytes[..4] != MAGIC {
            return Ok(Source::whole(bytes));
        }
        let bad = |m: String| Error::Parquet { index, message: format!("sparse file container: {m}") };
        let mut at = 4usize;
        let mut take = |n: usize| -> Result<&[u8]> {
            let end = at.checked_add(n).filter(|e| *e <= bytes.len()).ok_or_else(|| bad(format!("truncated at byte {at}")))?;
            let s = &bytes[at..end];
            at = end;
            Ok(s)
        };
        let u64_at = |b: &[u8]| u64::from_le_bytes(b.try_into().expect("8 bytes"));
        let len = u64_at(take(8)?);
        let n = u32::from_le_bytes(take(4)?.try_into().expect("4 bytes")) as usize;
        let mut table = Vec::with_capacity(n.min(1 << 16));
        let mut prev_end = 0u64;
        for i in 0..n {
            let off = u64_at(take(8)?);
            let l = u64_at(take(8)?);
            let end = off.checked_add(l).ok_or_else(|| bad(format!("segment {i} overflows")))?;
            if end > len {
                return Err(bad(format!("segment {i} ends at {end}, past the file's {len} bytes")));
            }
            if i > 0 && off < prev_end {
                return Err(bad(format!("segment {i} at {off} overlaps or precedes the one before (ending at {prev_end})")));
            }
            prev_end = end;
            table.push((off, l));
        }
        let mut segs = Vec::with_capacity(table.len());
        let mut data = at;
        for (i, (off, l)) in table.into_iter().enumerate() {
            let l = usize::try_from(l).map_err(|_| bad(format!("segment {i} too long")))?;
            let end = data.checked_add(l).filter(|e| *e <= bytes.len()).ok_or_else(|| bad(format!("segment {i}: data truncated")))?;
            segs.push((off, bytes.slice(data..end)));
            data = end;
        }
        if data != bytes.len() {
            return Err(bad(format!("{} bytes after the last segment", bytes.len() - data)));
        }
        Ok(Source { len, segs: Arc::new(segs) })
    }

    /// The segment that holds `[start, start + len)`, if one does.
    fn find(&self, start: u64, len: u64) -> Option<&(u64, Bytes)> {
        let end = start.checked_add(len)?;
        let i = self.segs.partition_point(|(o, _)| *o <= start);
        let s = self.segs.get(i.checked_sub(1)?)?;
        (end <= s.0 + s.1.len() as u64).then_some(s)
    }

    /// Whether every byte of `[start, start + len)` is held.
    pub fn has(&self, start: u64, len: u64) -> bool {
        self.find(start, len).is_some()
    }

    /// Whether every column chunk of a row group is held (the reader may read it).
    pub fn has_row_group(&self, md: &RowGroupMetaData) -> bool {
        md.columns().iter().all(|c| {
            let (o, l) = c.byte_range();
            self.has(o, l)
        })
    }

    /// Bytes held (for accounting).
    pub fn held(&self) -> u64 {
        self.segs.iter().map(|(_, b)| b.len() as u64).sum()
    }
}

impl Length for Source {
    fn len(&self) -> u64 {
        self.len
    }
}

fn not_held(start: u64, len: u64) -> ParquetError {
    ParquetError::General(format!("bytes {start}..{} of the file were not fetched", start.saturating_add(len)))
}

impl ChunkReader for Source {
    type T = bytes::buf::Reader<Bytes>;

    fn get_read(&self, start: u64) -> parquet::errors::Result<Self::T> {
        let (o, b) = self.find(start, 0).ok_or_else(|| not_held(start, 0))?;
        Ok(b.slice((start - o) as usize..).reader())
    }

    fn get_bytes(&self, start: u64, length: usize) -> parquet::errors::Result<Bytes> {
        let (o, b) = self.find(start, length as u64).ok_or_else(|| not_held(start, length as u64))?;
        let at = (start - o) as usize;
        Ok(b.slice(at..at + length))
    }
}

/// Build a sparse file container: `file_len` bytes, of which `segments` (offset, bytes)
/// are held. Segments must be sorted and disjoint; [`Source::from_bytes`] checks.
pub fn encode(file_len: u64, segments: &[(u64, &[u8])]) -> Vec<u8> {
    let data: usize = segments.iter().map(|(_, b)| b.len()).sum();
    let mut out = Vec::with_capacity(16 + 16 * segments.len() + data);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&file_len.to_le_bytes());
    out.extend_from_slice(&(segments.len() as u32).to_le_bytes());
    for (o, b) in segments {
        out.extend_from_slice(&o.to_le_bytes());
        out.extend_from_slice(&(b.len() as u64).to_le_bytes());
    }
    for (_, b) in segments {
        out.extend_from_slice(b);
    }
    out
}

/// The container holding `ranges` (offset, length) of `file`: what a range read of those
/// ranges would hand the engine. For tests and native callers.
pub fn cut(file: &[u8], ranges: &[(u64, u64)]) -> Vec<u8> {
    let segs: Vec<(u64, &[u8])> = ranges.iter().map(|(o, l)| (*o, &file[*o as usize..(*o + *l) as usize])).collect();
    encode(file.len() as u64, &segs)
}
