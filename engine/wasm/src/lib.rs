//! # viz-engine-wasm
//!
//! A plain C ABI over `viz-storage`, for `wasm32-unknown-unknown`. The TypeScript binding
//! in `js/` is the only intended caller; together they implement the storage half of
//! `contracts/engine.ts` (`encodeSegment`, `select`).
//!
//! Like every engine crate this does no I/O. Malformed input comes back as an error
//! result, never as a trap: every byte of a request is bounds-checked before use.
//!
//! ## Calling convention
//!
//! All integers little-endian. The caller owns request memory, the callee owns results.
//!
//! * `viz_alloc(len) -> ptr`, `viz_free(ptr, len)`: the module's allocator. A request is
//!   written by the caller into a `viz_alloc`ed buffer and freed by the caller afterwards.
//! * Every operation takes `(ptr, len)` of one request buffer and returns a pointer to a
//!   **result**: `u32 total_len, u32 status, payload`. `total_len` counts the 8 header
//!   bytes; `status` is 0 (ok) or 1 (error, payload is a UTF-8 message). The caller frees
//!   it with `viz_free(ptr, total_len)`.
//!
//! ### `viz_encode_segment`
//!
//! Request: `u32 n_batches`, then per batch `u32 len, bytes`.
//!
//! Ok payload: `u32 n_files`, then per file
//! `u8 table (0 = metric_samples, 1 = metric_series), u8[3] zero, u64 rows, i64 min_ts,
//! i64 max_ts, u32 day_len, day, u32 index_len, index, u32 bytes_len, bytes`.
//!
//! ### `viz_select`
//!
//! Request: `i64 min_ts, i64 max_ts, u32 n_series_files, u32 n_sample_files,
//! u32 n_tail_batches, u32 n_matchers`, then each series file, sample file and tail batch
//! as `u32 len, bytes`, then each matcher as
//! `u8 op (0 '=', 1 '!=', 2 '=~', 3 '!~'), u32 name_len, name, u32 value_len, value`.
//!
//! Ok payload: `u32 n_series`, then per series `u32 n_labels`, per label
//! `u32 len, name, u32 len, value`, then `u32 n_samples`, zero padding to a multiple of 8
//! (from the start of the payload), `f64 ts[n_samples]` (Unix milliseconds; exact, every
//! stored timestamp is far below 2^53), `f64 value[n_samples]` (raw bits, never passed
//! through arithmetic).
//!
//! ### `viz_merge_files`
//!
//! Compaction: several files of ONE table and one tenant-day become one file
//! (`viz_storage::merge_files`). Inputs are given lowest precedence first: on a duplicate
//! key the row of the later input wins.
//!
//! Request: `u8 table (0 = metric_samples, 1 = metric_series), u8[3] zero, u32 n_inputs`,
//! then each input file as `u32 len, bytes`.
//!
//! Ok payload: `u8 table, u8[3] zero, u64 rows, i64 min_ts, i64 max_ts, u32 day_len, day,
//! u32 index_len, index, u32 file_ptr, u32 file_len, u32 file_cap`. The file itself is NOT
//! in the payload: it stays in the buffer the writer filled, at `file_ptr`. The caller
//! copies `file_len` bytes from there and releases it with `viz_free_file(file_ptr,
//! file_cap)`. So the output exists once in linear memory, and the inputs once (they are
//! read in place from the request). Peak is about inputs + output + one decoded row group
//! per input; see the README for measurements.
//!
//! ### `viz_abi_version`
//!
//! Returns 2 (1 had no `viz_merge_files`). The binding refuses a module that answers
//! anything else.

use viz_storage::{encode_segment, merge_files_shared, select, EncodedFile, MatchOp, Matcher, ScanInput, SeriesData, Table, WriteOptions};

pub const ABI_VERSION: u32 = 2;
const OK: u32 = 0;
const ERR: u32 = 1;

#[no_mangle]
pub extern "C" fn viz_abi_version() -> u32 {
    ABI_VERSION
}

/// Allocate `len` bytes (alignment 8). Never returns null for `len > 0` unless memory is
/// exhausted, in which case the module traps.
#[no_mangle]
pub extern "C" fn viz_alloc(len: usize) -> *mut u8 {
    let Ok(layout) = std::alloc::Layout::from_size_align(len.max(1), 8) else { return std::ptr::null_mut() };
    // SAFETY: the layout has a non-zero size.
    let p = unsafe { std::alloc::alloc(layout) };
    if p.is_null() {
        std::alloc::handle_alloc_error(layout);
    }
    p
}

/// Free a buffer from `viz_alloc` or a result buffer. `len` must be the allocated length.
///
/// # Safety
/// `ptr` must come from this module with exactly this `len`, and not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn viz_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    if let Ok(layout) = std::alloc::Layout::from_size_align(len.max(1), 8) {
        std::alloc::dealloc(ptr, layout);
    }
}

/// Bounds-checked reader over a request buffer.
struct Req<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Req<'a> {
    fn take(&mut self, n: usize, what: &str) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(n).filter(|e| *e <= self.b.len());
        match end {
            Some(end) => {
                let s = &self.b[self.at..end];
                self.at = end;
                Ok(s)
            }
            None => Err(format!("request truncated: {what} needs {n} bytes at offset {}, request has {}", self.at, self.b.len())),
        }
    }
    fn u8(&mut self, what: &str) -> Result<u8, String> {
        Ok(self.take(1, what)?[0])
    }
    fn u32(&mut self, what: &str) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }
    fn i64(&mut self, what: &str) -> Result<i64, String> {
        Ok(i64::from_le_bytes(self.take(8, what)?.try_into().unwrap()))
    }
    fn item(&mut self, what: &str) -> Result<&'a [u8], String> {
        let n = self.u32(what)? as usize;
        self.take(n, what)
    }
    /// `count` items, without trusting `count` for the allocation size.
    fn items(&mut self, count: u32, what: &str) -> Result<Vec<&'a [u8]>, String> {
        let mut v = Vec::with_capacity((count as usize).min(self.b.len() / 4));
        for _ in 0..count {
            v.push(self.item(what)?);
        }
        Ok(v)
    }
    fn end(&self) -> Result<(), String> {
        if self.at == self.b.len() {
            Ok(())
        } else {
            Err(format!("request has {} trailing bytes", self.b.len() - self.at))
        }
    }
}

/// Hand a result to the caller: `u32 total_len, u32 status, payload`, allocated with
/// `viz_alloc` so `viz_free(ptr, total_len)` releases it.
fn result(status: u32, payload_len: usize, fill: impl FnOnce(&mut Vec<u8>)) -> *mut u8 {
    let total = 8 + payload_len;
    if total > u32::MAX as usize {
        // Cannot be described by a u32 length: report an error with an empty message.
        let p = viz_alloc(8);
        // SAFETY: `p` is a fresh allocation of 8 bytes.
        unsafe {
            std::ptr::copy_nonoverlapping(8u32.to_le_bytes().as_ptr(), p, 4);
            std::ptr::copy_nonoverlapping(ERR.to_le_bytes().as_ptr(), p.add(4), 4);
        }
        return p;
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&status.to_le_bytes());
    fill(&mut out);
    debug_assert_eq!(out.len(), total);
    let p = viz_alloc(total);
    // SAFETY: `p` is a fresh allocation of `total` bytes and `out` holds exactly `total`.
    unsafe { std::ptr::copy_nonoverlapping(out.as_ptr(), p, total.min(out.len())) };
    p
}

fn error(message: String) -> *mut u8 {
    result(ERR, message.len(), |out| out.extend_from_slice(message.as_bytes()))
}

/// # Safety
/// `ptr..ptr+len` must be readable (or `len` 0).
unsafe fn request<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

fn encode_payload_len(files: &[EncodedFile]) -> usize {
    4 + files.iter().map(|f| 4 + 24 + 4 + f.day.len() + 4 + f.index.len() + 4 + f.bytes.len()).sum::<usize>()
}

fn do_encode(req: &[u8]) -> Result<Vec<EncodedFile>, String> {
    let mut r = Req { b: req, at: 0 };
    let n = r.u32("n_batches")?;
    let batches = r.items(n, "batch")?;
    r.end()?;
    encode_segment(&batches).map_err(|e| e.to_string())
}

/// See the crate documentation.
///
/// # Safety
/// `ptr..ptr+len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn viz_encode_segment(ptr: *const u8, len: usize) -> *mut u8 {
    match do_encode(request(ptr, len)) {
        Err(m) => error(m),
        Ok(files) => result(OK, encode_payload_len(&files), |out| {
            out.extend_from_slice(&(files.len() as u32).to_le_bytes());
            for f in &files {
                out.extend_from_slice(&[matches!(f.table, Table::MetricSeries) as u8, 0, 0, 0]);
                out.extend_from_slice(&f.rows.to_le_bytes());
                out.extend_from_slice(&f.min_ts.to_le_bytes());
                out.extend_from_slice(&f.max_ts.to_le_bytes());
                for part in [f.day.as_bytes(), f.index.as_bytes(), f.bytes.as_slice()] {
                    out.extend_from_slice(&(part.len() as u32).to_le_bytes());
                    out.extend_from_slice(part);
                }
            }
        }),
    }
}

fn do_merge(req: &[u8]) -> Result<EncodedFile, String> {
    let mut r = Req { b: req, at: 0 };
    let table = match r.take(4, "table")? {
        [0, 0, 0, 0] => Table::MetricSamples,
        [1, 0, 0, 0] => Table::MetricSeries,
        other => return Err(format!("unknown table {:?}", other)),
    };
    let n = r.u32("n_inputs")?;
    let inputs = r.items(n, "input file")?;
    r.end()?;
    // SAFETY: the request buffer outlives this call (the caller frees it afterwards), and
    // nothing that borrows from these `Bytes` survives it: the readers and every value
    // read from them are dropped inside `merge_files_shared`, whose result owns its bytes.
    let shared: Vec<bytes::Bytes> =
        inputs.iter().map(|f| bytes::Bytes::from_static(unsafe { std::mem::transmute::<&[u8], &'static [u8]>(*f) })).collect();
    merge_files_shared(table, &shared, &WriteOptions::default()).map_err(|e| e.to_string())
}

/// See the crate documentation.
///
/// # Safety
/// `ptr..ptr+len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn viz_merge_files(ptr: *const u8, len: usize) -> *mut u8 {
    let f = match do_merge(request(ptr, len)) {
        Err(m) => return error(m),
        Ok(f) => f,
    };
    let EncodedFile { table, day, bytes, rows, min_ts, max_ts, index } = f;
    // Leak the file buffer to the caller; `viz_free_file` takes it back.
    let mut file = std::mem::ManuallyDrop::new(bytes);
    let (file_ptr, file_len, file_cap) = (file.as_mut_ptr() as usize, file.len(), file.capacity());
    result(OK, 28 + 4 + day.len() + 4 + index.len() + 12, |out| {
        out.extend_from_slice(&[matches!(table, Table::MetricSeries) as u8, 0, 0, 0]);
        out.extend_from_slice(&rows.to_le_bytes());
        out.extend_from_slice(&min_ts.to_le_bytes());
        out.extend_from_slice(&max_ts.to_le_bytes());
        for part in [day.as_bytes(), index.as_bytes()] {
            out.extend_from_slice(&(part.len() as u32).to_le_bytes());
            out.extend_from_slice(part);
        }
        for v in [file_ptr, file_len, file_cap] {
            out.extend_from_slice(&(v as u32).to_le_bytes());
        }
    })
}

/// Release the file buffer of a `viz_merge_files` result.
///
/// # Safety
/// `ptr` and `cap` must be the `file_ptr` and `file_cap` of one such result, passed once.
#[no_mangle]
pub unsafe extern "C" fn viz_free_file(ptr: *mut u8, cap: usize) {
    if !ptr.is_null() && cap > 0 {
        drop(Vec::from_raw_parts(ptr, 0, cap));
    }
}

fn do_select(req: &[u8]) -> Result<Vec<SeriesData>, String> {
    let mut r = Req { b: req, at: 0 };
    let min_ts = r.i64("min_ts")?;
    let max_ts = r.i64("max_ts")?;
    let (n_series, n_samples, n_tail, n_matchers) = (r.u32("n_series_files")?, r.u32("n_sample_files")?, r.u32("n_tail_batches")?, r.u32("n_matchers")?);
    let input = ScanInput {
        series_files: r.items(n_series, "series file")?,
        sample_files: r.items(n_samples, "sample file")?,
        tail_batches: r.items(n_tail, "tail batch")?,
    };
    let mut matchers = Vec::with_capacity((n_matchers as usize).min(req.len() / 9));
    for _ in 0..n_matchers {
        let op = match r.u8("matcher op")? {
            0 => MatchOp::Eq,
            1 => MatchOp::Ne,
            2 => MatchOp::Re,
            3 => MatchOp::NotRe,
            other => return Err(format!("unknown matcher op {other}")),
        };
        let name = std::str::from_utf8(r.item("matcher name")?).map_err(|_| "matcher name is not UTF-8".to_string())?;
        let value = std::str::from_utf8(r.item("matcher value")?).map_err(|_| "matcher value is not UTF-8".to_string())?;
        matchers.push(Matcher::new(name, op, value));
    }
    r.end()?;
    select(&input, &matchers, min_ts, max_ts).map_err(|e| e.to_string())
}

fn select_payload_len(series: &[SeriesData]) -> usize {
    let mut n = 4usize;
    for s in series {
        n += 4 + s.labels.iter().map(|(k, v)| 8 + k.len() + v.len()).sum::<usize>() + 4;
        n = n.div_ceil(8) * 8 + 16 * s.ts.len();
    }
    n
}

/// See the crate documentation.
///
/// # Safety
/// `ptr..ptr+len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn viz_select(ptr: *const u8, len: usize) -> *mut u8 {
    match do_select(request(ptr, len)) {
        Err(m) => error(m),
        Ok(series) => result(OK, select_payload_len(&series), |out| {
            let base = out.len();
            out.extend_from_slice(&(series.len() as u32).to_le_bytes());
            for s in &series {
                out.extend_from_slice(&(s.labels.len() as u32).to_le_bytes());
                for (k, v) in &s.labels {
                    for part in [k, v] {
                        out.extend_from_slice(&(part.len() as u32).to_le_bytes());
                        out.extend_from_slice(part.as_bytes());
                    }
                }
                out.extend_from_slice(&(s.ts.len() as u32).to_le_bytes());
                let padded = base + (out.len() - base).div_ceil(8) * 8;
                out.resize(padded, 0);
                for t in &s.ts {
                    // Exact: batch decoding bounds every timestamp to 0..=253402300799999 < 2^53.
                    out.extend_from_slice(&(*t as f64).to_le_bytes());
                }
                for v in &s.values {
                    // The bits, not the number: a NaN payload must survive.
                    out.extend_from_slice(&v.to_bits().to_le_bytes());
                }
            }
        }),
    }
}
