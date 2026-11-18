//! # viz-engine-wasm-query
//!
//! A plain C ABI over `viz-query` for `wasm32-unknown-unknown`: the read path's module.
//! The TypeScript binding in `js/` is the only intended caller; together they implement
//! the query half of `contracts/engine.ts` (`selectors`/plan, `queryRange`,
//! `queryInstant`, `select`), the metadata calls and file pruning.
//!
//! No I/O, no clock, no imports: the module instantiates with an empty import object.
//! Malformed input comes back as an error result, never as a trap: every byte of a
//! request is bounds-checked before use.
//!
//! ## Calling convention (the same as `engine/wasm`)
//!
//! All integers little-endian. The caller owns request memory, the callee owns results.
//!
//! * `viz_alloc(len) -> ptr`, `viz_free(ptr, len)`: the module's allocator.
//! * Every operation takes `(ptr, len)` of one request buffer and returns a pointer to a
//!   **result**: `u32 total_len, u32 status, payload`. `total_len` counts the 8 header
//!   bytes. The caller frees it with `viz_free(ptr, total_len)`.
//! * `status` 0 is success. Any other status is an error and the payload is
//!   `u32 limit_len, limit name, u64 limit_max, u64 limit_reached, message (UTF-8, the rest)`;
//!   `limit_len` is 0 unless a limit was exceeded. Statuses:
//!   1 `bad_data`, 2 `execution`, 3 `unsupported`, 4 `internal`, 5 a malformed request
//!   buffer (a bug in the binding, not in the query).
//!
//! Building blocks of requests:
//!
//! * `str`: `u32 len, bytes`.
//! * `limits`: seven `u64`: `max_samples, max_series, max_output_points,
//!   max_step_points, max_query_bytes, max_depth, max_steps`. Passed with every call
//!   that evaluates or parses; nothing is read from module state.
//! * `scan`: `u32 n_series_files, u32 n_sample_files, u32 n_tail_batches`, then each
//!   series file, sample file and tail batch as `str`.
//! * `matcher`: `u8 op (0 '=', 1 '!=', 2 '=~', 3 '!~'), str name, str value`.
//!
//! Times are `i64` Unix milliseconds. Sample values never cross as numbers: query
//! results carry them as Prometheus-formatted strings inside JSON, `viz_q_select`
//! as raw `f64` bits.
//!
//! | Operation | Request | Ok payload |
//! |---|---|---|
//! | `viz_q_plan` | `limits, i64 start, i64 end, i64 step, str query` | JSON `[{"matchers":[{"name","op","value"}],"minTs","maxTs"}]`: merged, clamped fetch ranges |
//! | `viz_q_selectors` | the same | JSON, one entry per selector (`contracts/engine.ts` `selectors`) |
//! | `viz_q_query_range` | `limits, i64 start, i64 end, i64 step, str query, scan` | `u64 selects, u64 series, u64 samples, u64 output_points`, then the JSON `data` object |
//! | `viz_q_query_instant` | `limits, i64 time, str query, scan` | the same |
//! | `viz_q_select` | `i64 min_ts, i64 max_ts, u32 n_matchers, matcher*, scan` | as `viz_select` of `engine/wasm`: `u32 n_series`, per series `u32 n_labels, (str name, str value)*, u32 n_samples`, zero padding to a multiple of 8 from the payload start, `f64 ts[n]`, `f64 value[n]` |
//! | `viz_q_parse_selectors` | `u32 n, str*` (`match[]` strings) | JSON `[[matcher,…],…]` |
//! | `viz_q_label_names` | `limits, i64 min_ts, i64 max_ts, u32 n, str* (match[]; none = every series), scan` | JSON `["name",…]`, sorted, unique |
//! | `viz_q_label_values` | `limits, i64 min_ts, i64 max_ts, str label, u32 n, str*, scan` | JSON `["value",…]` |
//! | `viz_q_series` | `limits, i64 min_ts, i64 max_ts, u32 n, str*, scan` | JSON `[{"label":"value",…},…]` |
//! | `viz_q_files_needed` | `u32 n_files, str index*, u32 n_ranges, (i64 min_ts, i64 max_ts, u32 n_matchers, matcher*)*` | `u8[n_files]`: 1 = fetch, 0 = provably holds nothing the ranges read |
//! | `viz_q_abi_version` | (no request) | returns 1 |

use std::collections::BTreeSet;
use viz_query::{EvalOptions, FetchRange, Limits, MatchOp, Matcher, Options, QueryError, ScanInput, Stats};

pub const ABI_VERSION: u32 = 1;
const OK: u32 = 0;
const MALFORMED: u32 = 5;

#[no_mangle]
pub extern "C" fn viz_q_abi_version() -> u32 {
    ABI_VERSION
}

/// Allocate `len` bytes (alignment 8). Traps only when memory is exhausted.
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

/// What can go wrong in a call: the query's own error, or a request buffer that does not
/// follow the layout above.
enum Fail {
    Query(QueryError),
    Malformed(String),
}

impl From<QueryError> for Fail {
    fn from(e: QueryError) -> Fail {
        Fail::Query(e)
    }
}

type Res<T> = Result<T, Fail>;

/// Bounds-checked reader over a request buffer.
struct Req<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Req<'a> {
    fn take(&mut self, n: usize, what: &str) -> Res<&'a [u8]> {
        match self.at.checked_add(n).filter(|e| *e <= self.b.len()) {
            Some(end) => {
                let s = &self.b[self.at..end];
                self.at = end;
                Ok(s)
            }
            None => Err(Fail::Malformed(format!("request truncated: {what} needs {n} bytes at offset {}, request has {}", self.at, self.b.len()))),
        }
    }
    fn u8(&mut self, what: &str) -> Res<u8> {
        Ok(self.take(1, what)?[0])
    }
    fn u32(&mut self, what: &str) -> Res<u32> {
        let b = self.take(4, what)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self, what: &str) -> Res<u64> {
        let b = self.take(8, what)?;
        Ok(u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }
    fn i64(&mut self, what: &str) -> Res<i64> {
        Ok(self.u64(what)? as i64)
    }
    fn item(&mut self, what: &str) -> Res<&'a [u8]> {
        let n = self.u32(what)? as usize;
        self.take(n, what)
    }
    fn str(&mut self, what: &str) -> Res<&'a str> {
        // Text that is not UTF-8 is the request's fault (a query, a label name).
        std::str::from_utf8(self.item(what)?).map_err(|_| Fail::Query(QueryError::bad_data(format!("{what} is not valid UTF-8"))))
    }
    /// `count` items, without trusting `count` for the allocation size.
    fn items(&mut self, count: u32, what: &str) -> Res<Vec<&'a [u8]>> {
        let mut v = Vec::with_capacity((count as usize).min(self.b.len() / 4));
        for _ in 0..count {
            v.push(self.item(what)?);
        }
        Ok(v)
    }
    fn strs(&mut self, what: &str) -> Res<Vec<&'a str>> {
        let n = self.u32(what)?;
        let mut v = Vec::with_capacity((n as usize).min(self.b.len() / 4));
        for _ in 0..n {
            v.push(self.str(what)?);
        }
        Ok(v)
    }
    fn limits(&mut self) -> Res<Options> {
        let limits = Limits {
            max_samples: self.u64("max_samples")?,
            max_series: self.u64("max_series")?,
            max_output_points: self.u64("max_output_points")?,
            max_step_points: self.u64("max_step_points")?,
            max_query_bytes: self.u64("max_query_bytes")?,
            max_depth: self.u64("max_depth")?,
        };
        let max_steps = usize::try_from(self.u64("max_steps")?).unwrap_or(usize::MAX);
        Ok(Options { limits, eval: EvalOptions { max_steps, ..EvalOptions::default() } })
    }
    fn scan(&mut self) -> Res<ScanInput<'a>> {
        let (a, b, c) = (self.u32("n_series_files")?, self.u32("n_sample_files")?, self.u32("n_tail_batches")?);
        Ok(ScanInput { series_files: self.items(a, "series file")?, sample_files: self.items(b, "sample file")?, tail_batches: self.items(c, "tail batch")? })
    }
    fn matchers(&mut self) -> Res<Vec<Matcher>> {
        let n = self.u32("n_matchers")?;
        let mut v = Vec::with_capacity((n as usize).min(self.b.len() / 9));
        for _ in 0..n {
            let op = match self.u8("matcher op")? {
                0 => MatchOp::Eq,
                1 => MatchOp::Ne,
                2 => MatchOp::Re,
                3 => MatchOp::Nre,
                other => return Err(Fail::Malformed(format!("unknown matcher operator {other}"))),
            };
            v.push(Matcher::new(self.str("matcher name")?, op, self.str("matcher value")?));
        }
        Ok(v)
    }
    fn end(&self) -> Res<()> {
        if self.at == self.b.len() {
            Ok(())
        } else {
            Err(Fail::Malformed(format!("request has {} trailing bytes", self.b.len() - self.at)))
        }
    }
}

/// Hand a result to the caller: `u32 total_len, u32 status, payload`.
fn result(status: u32, payload: &[u8]) -> *mut u8 {
    let (status, payload) = if payload.len() > u32::MAX as usize - 8 { (4, &b"\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0result larger than 4 GiB"[..]) } else { (status, payload) };
    let total = 8 + payload.len();
    let p = viz_alloc(total);
    // SAFETY: `p` is a fresh allocation of `total` bytes.
    unsafe {
        std::ptr::copy_nonoverlapping((total as u32).to_le_bytes().as_ptr(), p, 4);
        std::ptr::copy_nonoverlapping(status.to_le_bytes().as_ptr(), p.add(4), 4);
        std::ptr::copy_nonoverlapping(payload.as_ptr(), p.add(8), payload.len());
    }
    p
}

fn finish(r: Res<Vec<u8>>) -> *mut u8 {
    match r {
        Ok(payload) => result(OK, &payload),
        Err(f) => {
            let (status, message, limit) = match f {
                Fail::Malformed(m) => (MALFORMED, m, None),
                Fail::Query(e) => {
                    let status = match e.error_type {
                        viz_query::ErrorType::BadData => 1,
                        viz_query::ErrorType::Execution => 2,
                        viz_query::ErrorType::Unsupported => 3,
                        viz_query::ErrorType::Internal => 4,
                    };
                    (status, e.message, e.limit)
                }
            };
            let mut out = Vec::with_capacity(20 + message.len());
            let (name, max, reached) = limit.map_or(("", 0, 0), |(l, max, reached)| (l.as_str(), max, reached));
            out.extend_from_slice(&(name.len() as u32).to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&max.to_le_bytes());
            out.extend_from_slice(&reached.to_le_bytes());
            out.extend_from_slice(message.as_bytes());
            result(status, &out)
        }
    }
}

/// # Safety
/// `ptr..ptr+len` must be readable (or `len` 0).
unsafe fn request<'a>(ptr: *const u8, len: usize) -> Req<'a> {
    Req { b: if len == 0 || ptr.is_null() { &[] } else { std::slice::from_raw_parts(ptr, len) }, at: 0 }
}

fn with_stats(stats: Stats, json: String) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 + json.len());
    for v in [stats.selects, stats.series, stats.samples, stats.output_points] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(json.as_bytes());
    out
}

fn do_plan(mut r: Req<'_>, merged: bool) -> Res<Vec<u8>> {
    let opts = r.limits()?;
    let (start, end, step) = (r.i64("start")?, r.i64("end")?, r.i64("step")?);
    let q = r.str("query")?;
    r.end()?;
    let json = if merged {
        viz_query::to_json(&viz_query::plan_with(q, start, end, step, &opts)?)?
    } else {
        // The contract's shape: {matchers, minTs, maxTs} per selector, unmerged.
        let raw: Vec<FetchRange> = viz_query::selectors_with(q, start, end, step, &opts)?
            .into_iter()
            .map(|s| FetchRange { matchers: s.matchers, min_ts: s.min_ts_ms, max_ts: s.max_ts_ms })
            .collect();
        viz_query::to_json(&raw)?
    };
    Ok(json.into_bytes())
}

fn do_query_range(mut r: Req<'_>) -> Res<Vec<u8>> {
    let opts = r.limits()?;
    let (start, end, step) = (r.i64("start")?, r.i64("end")?, r.i64("step")?);
    let q = r.str("query")?;
    let input = r.scan()?;
    r.end()?;
    let out = viz_query::query_range_with(&input, q, start, end, step, &opts)?;
    Ok(with_stats(out.stats, viz_query::to_json(&out.matrix)?))
}

fn do_query_instant(mut r: Req<'_>) -> Res<Vec<u8>> {
    let opts = r.limits()?;
    let time = r.i64("time")?;
    let q = r.str("query")?;
    let input = r.scan()?;
    r.end()?;
    let out = viz_query::query_instant_with(&input, q, time, &opts)?;
    Ok(with_stats(out.stats, viz_query::to_json(&out.value)?))
}

fn do_select(mut r: Req<'_>) -> Res<Vec<u8>> {
    let (min_ts, max_ts) = (r.i64("min_ts")?, r.i64("max_ts")?);
    let matchers: Vec<viz_storage::Matcher> = r.matchers()?.iter().map(viz_query::to_storage_matcher).collect();
    let input = r.scan()?;
    r.end()?;
    let series = viz_storage::select(&input, &matchers, min_ts, max_ts).map_err(|e| match e {
        viz_storage::Error::Matcher { name, message } => QueryError::bad_data(format!("invalid regular expression in matcher on {name:?}: {message}")),
        other => QueryError::internal(format!("storage: {other}")),
    })?;
    let mut out = Vec::new();
    out.extend_from_slice(&(series.len() as u32).to_le_bytes());
    for s in &series {
        out.extend_from_slice(&(s.labels.len() as u32).to_le_bytes());
        for (n, v) in &s.labels {
            for t in [n, v] {
                out.extend_from_slice(&(t.len() as u32).to_le_bytes());
                out.extend_from_slice(t.as_bytes());
            }
        }
        out.extend_from_slice(&(s.ts.len() as u32).to_le_bytes());
        out.resize(out.len().next_multiple_of(8), 0);
        for t in &s.ts {
            // Exact: every storable timestamp is far below 2^53.
            out.extend_from_slice(&(*t as f64).to_le_bytes());
        }
        for v in &s.values {
            // The bits, not the number: NaN payloads (staleness markers) survive.
            out.extend_from_slice(&v.to_bits().to_le_bytes());
        }
    }
    Ok(out)
}

fn parse_sets(selectors: &[&str]) -> Res<Vec<Vec<Matcher>>> {
    Ok(selectors.iter().map(|s| viz_query::parse_selector(s)).collect::<Result<_, _>>()?)
}

fn do_parse_selectors(mut r: Req<'_>) -> Res<Vec<u8>> {
    let sels = r.strs("selector")?;
    r.end()?;
    Ok(viz_query::to_json(&parse_sets(&sels)?)?.into_bytes())
}

/// The union over the `match[]` sets (no sets: every series), as Prometheus does.
fn union(sets: Vec<Vec<Matcher>>, mut one: impl FnMut(&[Matcher]) -> Result<Vec<String>, QueryError>) -> Res<Vec<u8>> {
    let sets = if sets.is_empty() { vec![Vec::new()] } else { sets };
    let mut all = BTreeSet::new();
    for set in &sets {
        all.extend(one(set)?);
    }
    Ok(viz_query::to_json(&all.into_iter().collect::<Vec<String>>())?.into_bytes())
}

fn do_label_names(mut r: Req<'_>) -> Res<Vec<u8>> {
    let opts = r.limits()?;
    let (min_ts, max_ts) = (r.i64("min_ts")?, r.i64("max_ts")?);
    let sets = parse_sets(&r.strs("selector")?)?;
    let input = r.scan()?;
    r.end()?;
    union(sets, |m| viz_query::label_names_with(&input, m, min_ts, max_ts, &opts.limits))
}

fn do_label_values(mut r: Req<'_>) -> Res<Vec<u8>> {
    let opts = r.limits()?;
    let (min_ts, max_ts) = (r.i64("min_ts")?, r.i64("max_ts")?);
    let name = r.str("label name")?;
    let sets = parse_sets(&r.strs("selector")?)?;
    let input = r.scan()?;
    r.end()?;
    union(sets, |m| viz_query::label_values_with(&input, name, m, min_ts, max_ts, &opts.limits))
}

fn do_series(mut r: Req<'_>) -> Res<Vec<u8>> {
    let opts = r.limits()?;
    let (min_ts, max_ts) = (r.i64("min_ts")?, r.i64("max_ts")?);
    let sets = parse_sets(&r.strs("selector")?)?;
    let input = r.scan()?;
    r.end()?;
    Ok(viz_query::labels_to_json(&viz_query::series_with(&input, &sets, min_ts, max_ts, &opts.limits)?).into_bytes())
}

fn do_files_needed(mut r: Req<'_>) -> Res<Vec<u8>> {
    let n = r.u32("n_files")?;
    let raw = r.items(n, "index fragment")?;
    // A fragment that is not UTF-8 cannot be parsed either: "" keeps the file.
    let indexes: Vec<&str> = raw.iter().map(|b| std::str::from_utf8(b).unwrap_or("")).collect();
    let n_ranges = r.u32("n_ranges")?;
    let mut ranges = Vec::with_capacity((n_ranges as usize).min(r.b.len() / 20));
    for _ in 0..n_ranges {
        let (min_ts, max_ts) = (r.i64("min_ts")?, r.i64("max_ts")?);
        ranges.push(FetchRange { matchers: r.matchers()?, min_ts, max_ts });
    }
    r.end()?;
    Ok(viz_query::files_needed(&indexes, &ranges).into_iter().map(u8::from).collect())
}

macro_rules! export {
    ($name:ident, $body:expr) => {
        /// # Safety
        /// `ptr..ptr+len` must be readable (or `len` 0).
        #[no_mangle]
        pub unsafe extern "C" fn $name(ptr: *const u8, len: usize) -> *mut u8 {
            #[allow(clippy::redundant_closure_call)]
            finish($body(request(ptr, len)))
        }
    };
}

export!(viz_q_plan, |r| do_plan(r, true));
export!(viz_q_selectors, |r| do_plan(r, false));
export!(viz_q_query_range, do_query_range);
export!(viz_q_query_instant, do_query_instant);
export!(viz_q_select, do_select);
export!(viz_q_parse_selectors, do_parse_selectors);
export!(viz_q_label_names, do_label_names);
export!(viz_q_label_values, do_label_values);
export!(viz_q_series, do_series);
export!(viz_q_files_needed, do_files_needed);
