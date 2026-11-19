//! A minimal C ABI over the whole engine, for size measurement and the no-glue load
//! proof (`tools/wasm_check.mjs`). No imports: the host only reads and writes memory.
//!
//! Buffers: the host allocates with `viz_alloc`, writes, calls, and frees with
//! `viz_free`. Every call returns `(ptr << 32) | len` of a result buffer the host must
//! free. Times are `i64` Unix milliseconds (BigInt in JavaScript).
//!
//! A *blob list* is `u32 n` then `n` times `u32 len, bytes` (little-endian). A scan
//! input is three blob lists in a row: series files, sample files, tail batches.
//!
//! Query calls return JSON: `{"status":"success","data":…}` or
//! `{"status":"error","errorType":"…","error":"…"}`.
//! `viz_encode_segment` and `viz_merge_files` return a status byte (0 ok, 1 error), then
//! a blob list of files each prefixed in its blob by one table byte (0 samples, 1
//! series), or the error message.
use viz_query::{QueryError, ScanInput};
use viz_storage::Table;

#[no_mangle]
pub extern "C" fn viz_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from `viz_alloc(len)` or from a result of this module.
#[no_mangle]
pub unsafe extern "C" fn viz_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len != 0 {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

fn give(v: Vec<u8>) -> u64 {
    // A boxed slice has capacity == length, which is what `viz_free` rebuilds.
    let b = v.into_boxed_slice();
    let len = b.len();
    if len == 0 {
        return 0;
    }
    let p = Box::into_raw(b) as *mut u8;
    ((p as u64) << 32) | len as u64
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

fn blob_list<'a>(buf: &'a [u8], pos: &mut usize) -> Result<Vec<&'a [u8]>, QueryError> {
    let bad = || QueryError::bad_data("malformed input buffer");
    let u32_at = |p: usize| -> Result<usize, QueryError> {
        let b = buf.get(p..p + 4).ok_or_else(bad)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let n = u32_at(*pos)?;
    *pos += 4;
    let mut out = Vec::new();
    for _ in 0..n {
        let len = u32_at(*pos)?;
        *pos += 4;
        out.push(buf.get(*pos..pos.checked_add(len).ok_or_else(bad)?).ok_or_else(bad)?);
        *pos += len;
    }
    Ok(out)
}

fn scan_input(buf: &[u8]) -> Result<ScanInput<'_>, QueryError> {
    let mut pos = 0;
    let series_files = blob_list(buf, &mut pos)?;
    let sample_files = blob_list(buf, &mut pos)?;
    let tail_batches = blob_list(buf, &mut pos)?;
    Ok(ScanInput { series_files, sample_files, tail_batches })
}

fn text(b: &[u8]) -> Result<&str, QueryError> {
    std::str::from_utf8(b).map_err(|_| QueryError::bad_data("query is not valid UTF-8"))
}

fn respond(r: Result<String, QueryError>) -> u64 {
    give(match r {
        Ok(data) => format!("{{\"status\":\"success\",\"data\":{data}}}").into_bytes(),
        Err(e) => e.to_json().into_bytes(),
    })
}

/// # Safety
/// Pointers and lengths must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn viz_query_range(input: *const u8, input_len: usize, q: *const u8, q_len: usize, start_ms: i64, end_ms: i64, step_ms: i64) -> u64 {
    respond((|| viz_query::query_range(&scan_input(bytes(input, input_len))?, text(bytes(q, q_len))?, start_ms, end_ms, step_ms))())
}

/// # Safety
/// Pointers and lengths must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn viz_query_instant(input: *const u8, input_len: usize, q: *const u8, q_len: usize, time_ms: i64) -> u64 {
    respond((|| viz_query::query_instant(&scan_input(bytes(input, input_len))?, text(bytes(q, q_len))?, time_ms))())
}

/// # Safety
/// Pointers and lengths must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn viz_plan(q: *const u8, q_len: usize, start_ms: i64, end_ms: i64, step_ms: i64) -> u64 {
    respond((|| viz_query::to_json(&viz_query::plan(text(bytes(q, q_len))?, start_ms, end_ms, step_ms)?))())
}

/// `selector` is a `match[]` string, or empty for every series.
///
/// # Safety
/// Pointers and lengths must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn viz_label_names(input: *const u8, input_len: usize, selector: *const u8, selector_len: usize, min_ts: i64, max_ts: i64) -> u64 {
    respond((|| {
        let sel = text(bytes(selector, selector_len))?;
        let matchers = if sel.is_empty() { Vec::new() } else { viz_query::parse_selector(sel)? };
        viz_query::to_json(&viz_query::label_names(&scan_input(bytes(input, input_len))?, &matchers, min_ts, max_ts)?)
    })())
}

/// # Safety
/// Pointers and lengths must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn viz_label_values(
    input: *const u8,
    input_len: usize,
    name: *const u8,
    name_len: usize,
    selector: *const u8,
    selector_len: usize,
    min_ts: i64,
    max_ts: i64,
) -> u64 {
    respond((|| {
        let sel = text(bytes(selector, selector_len))?;
        let matchers = if sel.is_empty() { Vec::new() } else { viz_query::parse_selector(sel)? };
        viz_query::to_json(&viz_query::label_values(&scan_input(bytes(input, input_len))?, text(bytes(name, name_len))?, &matchers, min_ts, max_ts)?)
    })())
}

/// # Safety
/// Pointers and lengths must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn viz_series(input: *const u8, input_len: usize, selector: *const u8, selector_len: usize, min_ts: i64, max_ts: i64) -> u64 {
    respond((|| {
        let matchers = viz_query::parse_selector(text(bytes(selector, selector_len))?)?;
        Ok(viz_query::labels_to_json(&viz_query::series(&scan_input(bytes(input, input_len))?, &[matchers], min_ts, max_ts)?))
    })())
}

fn files_out(r: Result<Vec<viz_storage::EncodedFile>, String>) -> u64 {
    let mut out = Vec::new();
    match r {
        Ok(files) => {
            out.push(0);
            out.extend_from_slice(&(files.len() as u32).to_le_bytes());
            for f in files {
                out.extend_from_slice(&(f.bytes.len() as u32 + 1).to_le_bytes());
                out.push(if f.table == Table::MetricSamples { 0 } else { 1 });
                out.extend_from_slice(&f.bytes);
            }
        }
        Err(m) => {
            out.push(1);
            out.extend_from_slice(m.as_bytes());
        }
    }
    give(out)
}

/// `batches` is a blob list of `VZB1` batches in sequence order.
///
/// # Safety
/// Pointers and lengths must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn viz_encode_segment(batches: *const u8, len: usize) -> u64 {
    let buf = bytes(batches, len);
    files_out(blob_list(buf, &mut 0).map_err(|e| e.message).and_then(|b| viz_storage::encode_segment(&b).map_err(|e| e.to_string())))
}

/// `table` is 0 for `metric_samples`, 1 for `metric_series`; `files` is a blob list.
///
/// # Safety
/// Pointers and lengths must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn viz_merge_files(files: *const u8, len: usize, table: u32) -> u64 {
    let buf = bytes(files, len);
    let table = if table == 0 { Table::MetricSamples } else { Table::MetricSeries };
    files_out(
        blob_list(buf, &mut 0)
            .map_err(|e| e.message)
            .and_then(|f| viz_storage::merge_files(table, &f).map(|f| vec![f]).map_err(|e| e.to_string())),
    )
}

/// Probe only: evaluate `q` over no data with every limit off, to measure how deep a
/// query the module's stack can take (`tools/wasm_check.mjs`).
///
/// # Safety
/// Pointers and lengths must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn viz_probe_unlimited(q: *const u8, q_len: usize) -> u64 {
    respond((|| {
        let opts = viz_query::Options { limits: viz_query::Limits::unlimited(), ..Default::default() };
        let r = viz_query::query_range_with(&ScanInput::default(), text(bytes(q, q_len))?, 0, 60_000, 15_000, &opts)?;
        viz_query::to_json(&r.matrix)
    })())
}
