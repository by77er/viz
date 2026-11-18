//! Not the real WASM binding (a separate crate will wrap the API). This cdylib only links
//! every public entry point behind a C ABI so that
//! `cargo build --release --target wasm32-unknown-unknown --example wasm_probe`
//! yields a `.wasm` whose size reflects the whole storage engine, and so a host can smoke
//! test it. Input framing: a sequence of `u32 length, bytes` items.
use viz_storage::{encode_segment, merge_files, select, MatchOp, Matcher, ScanInput, Table};

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(8));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

fn items(buf: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut at = 0;
    while at + 4 <= buf.len() {
        let n = u32::from_le_bytes(buf[at..at + 4].try_into().unwrap()) as usize;
        at += 4;
        if at + n > buf.len() {
            break;
        }
        out.push(&buf[at..at + n]);
        at += n;
    }
    out
}

/// Flush the framed batches; returns total Parquet bytes produced, or -1 on error.
#[no_mangle]
pub unsafe extern "C" fn probe_encode(ptr: *const u8, len: usize) -> i64 {
    let buf = std::slice::from_raw_parts(ptr, len);
    match encode_segment(&items(buf)) {
        Ok(files) => files.iter().map(|f| f.bytes.len() as i64).sum(),
        Err(_) => -1,
    }
}

/// Flush the framed batches, compact, and select `name =~ regex` over lake + the same
/// batches as tail. Returns the number of samples selected, or -1 on error.
#[no_mangle]
pub unsafe extern "C" fn probe_roundtrip(ptr: *const u8, len: usize, re: *const u8, re_len: usize, min_ts: i64, max_ts: i64) -> i64 {
    let buf = std::slice::from_raw_parts(ptr, len);
    let Ok(re) = std::str::from_utf8(std::slice::from_raw_parts(re, re_len)) else { return -1 };
    let batches = items(buf);
    let run = || -> viz_storage::Result<i64> {
        let files = encode_segment(&batches)?;
        let mut input = ScanInput::default();
        let mut merged = Vec::new();
        for f in &files {
            merged.push(merge_files(f.table, &[&f.bytes])?);
        }
        for f in &merged {
            match f.table {
                Table::MetricSamples => input.sample_files.push(&f.bytes),
                Table::MetricSeries => input.series_files.push(&f.bytes),
            }
        }
        input.tail_batches = batches.clone();
        let out = select(&input, &[Matcher::new("__name__", MatchOp::Re, re)], min_ts, max_ts)?;
        Ok(out.iter().map(|s| s.ts.len() as i64).sum())
    };
    run().unwrap_or(-1)
}
