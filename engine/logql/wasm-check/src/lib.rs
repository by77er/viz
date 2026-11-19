//! A minimal C ABI over viz-logql, used only to measure the module (size, imports,
//! instantiation) and to run a query in Node. Request (UTF-8 text):
//!
//! ```text
//! <query>\n<start_ns> <end_ns> <step_ns> <limit> <instant 0|1>\n
//! <k=v,k=v>\t<ts_ns>\t<line>\n   (one row per line; rows of one stream must be consecutive)
//! ```
//!
//! Response: the `data` JSON, or `{"status":"error",...}`.

use viz_logql::{error_json, query_instant, query_range, Direction, LogRow, LogStream, MemSource, Options};

#[no_mangle]
pub extern "C" fn viz_logql_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `cap` must come from `viz_logql_alloc` or a response of `viz_logql_query`.
#[no_mangle]
pub unsafe extern "C" fn viz_logql_free(ptr: *mut u8, cap: usize) {
    drop(Vec::from_raw_parts(ptr, 0, cap.max(1)));
}

fn run(req: &str) -> Result<String, String> {
    let mut lines = req.split('\n');
    let query = lines.next().ok_or("no query")?;
    let nums: Vec<i64> = lines.next().ok_or("no window")?.split(' ').map(|x| x.parse().unwrap_or(0)).collect();
    if nums.len() != 5 {
        return Err("bad window".into());
    }
    let mut streams: Vec<LogStream> = Vec::new();
    for l in lines {
        let mut parts = l.splitn(3, '\t');
        let (Some(lbs), Some(ts), Some(line)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let labels: Vec<(String, String)> =
            lbs.split(',').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let row = LogRow { ts_ns: ts.parse().unwrap_or(0), line: line.to_string(), metadata: vec![] };
        match streams.last_mut() {
            Some(s) if s.labels == labels => s.rows.push(row),
            _ => streams.push(LogStream { labels, rows: vec![row] }),
        }
    }
    let src = MemSource::new(streams);
    let opts = Options { limit: nums[3] as u32, direction: Direction::Forward, ..Options::default() };
    let r = if nums[4] == 1 { query_instant(&src, query, nums[1], &opts) } else { query_range(&src, query, nums[0], nums[1], nums[2], &opts) };
    r.map(|r| r.data_json()).map_err(|e| error_json(&e))
}

/// Run a request; returns `(ptr << 32) | len` of the response, which the caller frees with
/// `viz_logql_free(ptr, len)`.
///
/// # Safety
/// `ptr..ptr+len` must be a readable buffer.
#[no_mangle]
pub unsafe extern "C" fn viz_logql_query(ptr: *const u8, len: usize) -> u64 {
    let req = std::slice::from_raw_parts(ptr, len);
    let out = match std::str::from_utf8(req) {
        Ok(s) => run(s).unwrap_or_else(|e| e),
        Err(_) => "{\"status\":\"error\",\"error\":\"request is not UTF-8\"}".to_string(),
    };
    let mut bytes = out.into_bytes();
    bytes.shrink_to_fit();
    let (p, l) = (bytes.as_mut_ptr(), bytes.len());
    std::mem::forget(bytes);
    ((p as u64) << 32) | l as u64
}
