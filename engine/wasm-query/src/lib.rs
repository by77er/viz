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
//! | `viz_q_scan_rows` | `u32 n_files, str index*, u32 n_ranges, (i64 min_ts, i64 max_ts, u32 n_matchers, matcher*)*` | `u64[n_files]`: an upper bound on the rows the ranges decode from each file. 0 = the file provably holds nothing the ranges read (skip it); `u64::MAX` = the fragment does not parse (unknown: read the file) |
//! | `viz_q_split_plan` | `limits, str query` | JSON `{"split":true,"fragments":n,"without":[…]}` or `{"split":false,"reason":"…"}` (`viz_query::split_plan`) |
//! | `viz_q_extract` | `key, u32 part, u32 parts, ranges, u32 n, str* (series files), u32 m, str* (sample files, precedence order; whole or sparse)` | `u64 rows, u64 series, u64 strays` (ABI 3: the part's series outside its id range), `u64 foreign` (ABI 5: series in its id range whose key is another part's), then a `VZB1` batch (empty: no rows) |
//! | `viz_q_split_tails` | `key, u32 parts, ranges, u32 n, str* (tail batches, in order)` | per part: `u32 n`, then `str*` (its batches, in order) |
//! | `viz_q_gather_new` | `u64 samples, u64 series, u64 step_points (the leaf's budget), ranges` | `u32 handle` of a gathering session kept in the module |
//! | `viz_q_gather_add` | `u32 handle, u32 rank, str batch` | `u8 aborted, u64 samples, u64 series` held so far |
//! | `viz_q_gather_eval` | `u32 handle, limits, u8 kind (0 range, 1 instant), i64 start, i64 end, i64 step, u32 fragments, str query` | the leaf's answer (`viz_query::split::LeafOutput`); the session is freed |
//! | `viz_q_gather_free` | `u32 handle` | empty; frees an abandoned session (no error if it is gone) |
//! | `viz_q_merge` | `limits, u8 kind, i64 start, i64 end, i64 step, str query, u32 n, str* (leaf answers)` | as `viz_q_query_range` |
//! | `viz_q_card_part` | `i64 start, i64 end, u32 part, u32 parts, u64 max_series, u64 max_pairs, u32 n, str* (series files), u32 m, str* (tail batches)` | a cardinality summary (`viz_query::cardinality::Summary`) |
//! | `viz_q_card_report` | `u64 max_series, u64 max_pairs, u32 limit, i64 start, i64 end, i64 lookback_start, u32 n, str* (summaries)` | `u32 n`, the `/status/tsdb` JSON (n bytes), then the `/status/cardinality` JSON |
//! | `viz_q_file_plan` | `u64 gap, ranges, u32 n, str* (index fragments)` | JSON `[plan, …]`, one per fragment: how to read each file by name and time (`viz_query::file_plan`) |
//! | `viz_q_sample_plan` | `u64 gap, u8 has_part, [key, u32 part, u32 parts], ranges (the reads), u32 n, str* (series files, whole or sparse), u32 m, str* (sample files' index fragments), u32 k, u32* (per sample file, the index of its series file; u32::MAX: unknown; k = 0: no pairs)` | `u32 n`, JSON `{"series":n,"files":[plan, …]}` (n bytes), then the carrier batch (`VZB1`; empty: none): the matchers resolved against the series files, how to read each sample file, and the selected series to evaluate with instead of the series files (`viz_query::sample_plan`) |
//! | `viz_q_part_plan` | `u64 gap, u32 part, u32 parts, ranges, u32 n, str* (sample files' index fragments)` | JSON `[plan, …]`: one split part's row groups by its `series_id` range, from the fragments alone (`viz_query::part_plan`) |
//! | `viz_q_meta_part` | `u8 kind (0 label names, 1 label values, 2 series), limits, i64 min_ts, i64 max_ts, u32 part, u32 parts, str label (values; empty otherwise), u32 n, str* (match[]), scan` | ABI 4: `u32 k`, then per `match[]` set for names and values (one for series) `u32 n, i64 series_id[n]`: the series listed in this part, then the JSON of `viz_q_label_names` / `_label_values` / `_series` over the series of part `part` of `parts` by `series_id` (`viz_query::MetaPart`) |
//! | `viz_q_tq_plan` | `u8 kind (0 search, 1 metrics range, 2 metrics instant), i64 start_ns, i64 end_ns, i64 step_ns, str query` | ABI 6. JSON `{"complete":bool,"lo":"ns","hi":"ns"}` (search: the trace window; metrics: also `spanLocal`, and the request as Tempo's frontend aligns it, `start`, `end`, `step`): whether every span of a candidate trace must be read, and the span starts the query reads |
//! | `viz_q_tq_file_plan` | `u64 gap, u8 table (0 spans, 1 trace_index), i64 lo_ns, i64 hi_ns, u8 has_id, [16 bytes trace id], u32 k, (i64 lo_ns, i64 hi_ns)*k, u32 n, str* (index fragments)` | JSON `[plan, …]`: row groups by time overlap (and trace id range); with `k` > 0 ranges (ABI 8), only row groups that also overlap one of them; with an id (ABI 9), each plan's `bloom`: the chosen groups' `trace_id` bloom filters the fragment names, `[[offset, length], …]` |
//! | `viz_q_tq_probe` | as `viz_q_tq_file_plan` (`has_id` 1), then `u32 n, str*` (bloom containers: per fragment, the sparse file container of the ranges its plan's `bloom` listed; empty for none) | ABI 9 (D81). JSON `[plan, …]`: `viz_q_tq_file_plan`'s, without the row groups whose `trace_id` bloom filter says the id is not there |
//! | `viz_q_tq_extent` | `i64 lo_ns, i64 hi_ns, u8 has_id, [id], i64 bound_lo, i64 bound_hi, u64 max_bytes, u32 n, str* (trace_index files), u32 m, str* (span tail batches)` | JSON `{"traces":n,"lo":"ns","hi":"ns","hours":[h,…],"ranges":[["ns","ns"],…]}`: the traces overlapping the window (or the one id), their hull, `spans` hours and (ABI 8) the ranges their pieces cover (at most 256), counting only fragments that overlap the bound and tail spans that start in it; all cut to it (ABI 7). Holds the window's traces and the ids of the traces after it, not every trace of the bound (ABI 8) |
//! | `viz_q_tq_search` | `u64 max_spans, u64 max_bytes, i64 bound_lo, i64 bound_hi, u32 limit, u32 spss, i64 start_ns, i64 end_ns, str query, u32 n, str* (spans files, precedence order), u32 m, str* (tail batches)` | `u64 spans decoded, u64 traces`, then Tempo's `/api/search` body |
//! | `viz_q_tq_metrics` | `u64 max_spans, u64 max_bytes, i64 bound_lo, i64 bound_hi, u64 max_series, u64 max_points, u8 instant, i64 start_ns, i64 end_ns, i64 step_ns, str query, files, tails` | as search: Tempo's `/api/metrics/query_range` (or `/query`) body |
//! | `viz_q_tq_trace` | `u8 version (1, 2), [16 bytes trace id], u64 max_spans, u64 max_bytes, i64 bound_lo, i64 bound_hi, files, tails` | `u8 found, u64 spans decoded`, then the trace as OTLP JSON (`{"batches":[…]}`, v2 `{"trace":{…}}`) when found; `max_spans` counts the trace's spans only (ABI 8) |
//! | `viz_q_tq_tags` | `u8 version, str scope, i64 lo_ns, i64 hi_ns, u32 limit, u64 max_spans, u64 max_bytes, files, tails` | Tempo's tag names body (v1 `tagNames`, v2 `scopes`) |
//! | `viz_q_tq_tag_values` | `u8 version, str tag, str q, i64 lo_ns, i64 hi_ns, u32 limit, u64 max_spans, u64 max_bytes, files, tails` | Tempo's tag values body (v1 strings, v2 `{type, value}`) |
//! | `viz_q_lq_plan` | `u8 kind (0 range, 1 instant), i64 start_ns, i64 end_ns, i64 step_ns, str query` | JSON `{"metric":bool,"selectors":[{"matchers":[…],"start":"ns","end":"ns"}]}` (`viz_logql::selectors`; half-open) |
//! | `viz_q_lq_file_plan` | `u64 gap, u32 n, (i64 start_ns, i64 end_ns, u32 n_matchers, matcher*)*, u32 m, str* (index fragments)` | JSON `[plan, …]`: row groups by time and stream list |
//! | `viz_q_lq_query` | `u64 max_rows, u64 max_bytes, u64 max_series, u64 max_steps, u32 limit, u8 direction (0 backward, 1 forward), u8 kind (0 range, 1 instant), i64 start_ns, i64 end_ns, i64 step_ns, str query, files, tails` | `u64 rows decoded`, then Loki's `data` object |
//! | `viz_q_lq_labels` | `u8 kind (0 names, 1 values, 2 series), str name, i64 start_ns, i64 end_ns, u64 max_bytes, u32 n, str* (stream selectors), u32 k, str* (fragments with stream lists), files (without), tails` | Loki's `data` array; `max_bytes` (ABI 8) bounds what it reads, keeps and answers |
//! | `viz_q_abi_version` | (no request) | returns 9 |
//!
//! Every span and log operation reads files that are whole or sparse (a row group whose
//! first column chunk is not held is skipped) and `VZB1` batches of signal 2 (spans) or 3
//! (log records); a batch of another signal is an `internal` error. `max_spans` and
//! `max_rows` bound the rows held (ABI 7: a span outside the bound, or a log row no selector
//! reads, is not counted; ABI 8: nor a span of another trace than trace by ID's, nor one a tag
//! call keeps only the row key of); `max_bytes` bounds the bytes of what is held, of what the
//! evaluation derives from it (ABI 8: series, buckets, label sets, tag values, extents) and of
//! the answer, each charged before it is made, as the engine counts them (`sigfiles::Mem`;
//! limit name `max_decoded_bytes`). Past any of them,
//! an `execution` error with the limit's name. `bound_lo`/`bound_hi` (traces, ABI 7): a span
//! whose start lies outside them is not part of the call's data, dropped before de-duplication.
//! Trace ids cross as 16 raw bytes; nanosecond times as `i64`, and as decimal strings in JSON.
//!
//! `key` is `u32 n, str*`: the labels left out of the split key (`viz_query::SplitKey`).
//! A `plan` is `{"rows":n|null,"read":"skip"|"whole"|[[offset,length],…]}`: `rows` bounds the
//! rows the reads decode from the file (`null`: the fragment does not parse); `read` says
//! to skip it, read it whole, or range-read those byte ranges (footer and row groups) and
//! pass them on as a sparse file container (`viz_storage::sparse`, magic `VZS1`).
//! Any file of a `scan` may be such a container.
//! `ranges` is `u32 n, (i64 min_ts, i64 max_ts, u32 n_matchers, matcher*)*`.

mod logs;
mod sigfiles;
#[cfg(test)]
mod sigtests;
mod traces;

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use viz_query::split::{self, Gathered, Grid, LeafBudget, LeafOutput};
use viz_query::{EvalOptions, FetchRange, FileRead, Limits, MatchOp, Matcher, Options, PartFilter, QueryError, ScanInput, SplitKey, SplitPlan, Stats};

pub const ABI_VERSION: u32 = 9;
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
    /// A limit of the span and log operations (`max_spans`, `max_rows`): an `execution`
    /// error naming it, its value and the number reached, and the message.
    Limit(&'static str, u64, u64, String),
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
    fn ranges(&mut self) -> Res<Vec<FetchRange>> {
        let n = self.u32("n_ranges")?;
        let mut out = Vec::with_capacity((n as usize).min(self.b.len() / 20));
        for _ in 0..n {
            let (min_ts, max_ts) = (self.i64("min_ts")?, self.i64("max_ts")?);
            out.push(FetchRange { matchers: self.matchers()?, min_ts, max_ts });
        }
        Ok(out)
    }
    fn key(&mut self) -> Res<SplitKey> {
        let mut without: Vec<String> = self.strs("split key label")?.into_iter().map(String::from).collect();
        without.sort();
        without.dedup();
        Ok(SplitKey { without })
    }
    fn files(&mut self, what: &str) -> Res<Vec<&'a [u8]>> {
        let n = self.u32(what)?;
        self.items(n, what)
    }
    fn grid(&mut self) -> Res<Grid> {
        let kind = self.u8("kind")?;
        let (start, end, step) = (self.i64("start")?, self.i64("end")?, self.i64("step")?);
        match kind {
            0 => Ok(Grid::Range { start, end, step }),
            1 => Ok(Grid::Instant { time: start }),
            k => Err(Fail::Malformed(format!("unknown query kind {k}"))),
        }
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
                Fail::Limit(name, max, reached, m) => {
                    let mut out = Vec::with_capacity(20 + m.len());
                    out.extend_from_slice(&(name.len() as u32).to_le_bytes());
                    out.extend_from_slice(name.as_bytes());
                    out.extend_from_slice(&max.to_le_bytes());
                    out.extend_from_slice(&reached.to_le_bytes());
                    out.extend_from_slice(m.as_bytes());
                    return result(2, &out);
                }
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

/// One part of a label call over leaves: what the call lists of that part's series, with the
/// ids of the series listed (per `match[]` set for names and values, as their caps count), so
/// that a part's files can be listed in several calls and counted exactly together.
fn do_meta_part(mut r: Req<'_>) -> Res<Vec<u8>> {
    let kind = r.u8("kind")?;
    let opts = r.limits()?;
    let (min_ts, max_ts) = (r.i64("min_ts")?, r.i64("max_ts")?);
    let (part, parts) = (r.u32("part")?, r.u32("parts")?);
    let name = r.str("label name")?;
    let sets = parse_sets(&r.strs("selector")?)?;
    let input = r.scan()?;
    r.end()?;
    if parts == 0 || part >= parts {
        return Err(Fail::Malformed(format!("part {part} of {parts}")));
    }
    let p = Some(viz_query::MetaPart { part, parts });
    let mut ids: Vec<Vec<i64>> = Vec::new();
    let json = match kind {
        0 | 1 => {
            let sets = if sets.is_empty() { vec![Vec::new()] } else { sets };
            let mut all = BTreeSet::new();
            for set in &sets {
                let (v, n) = if kind == 0 {
                    viz_query::label_names_part(&input, set, min_ts, max_ts, &opts.limits, p)?
                } else {
                    viz_query::label_values_part(&input, name, set, min_ts, max_ts, &opts.limits, p)?
                };
                ids.push(n);
                all.extend(v);
            }
            viz_query::to_json(&all.into_iter().collect::<Vec<String>>())?
        }
        2 => {
            let (v, n) = viz_query::series_part(&input, &sets, min_ts, max_ts, &opts.limits, p)?;
            ids.push(n);
            viz_query::labels_to_json(&v)
        }
        k => return Err(Fail::Malformed(format!("meta kind {k}"))),
    };
    let mut out = Vec::with_capacity(4 + ids.iter().map(|x| 4 + 8 * x.len()).sum::<usize>() + json.len());
    out.extend_from_slice(&(ids.len() as u32).to_le_bytes());
    for set in ids {
        out.extend_from_slice(&(set.len() as u32).to_le_bytes());
        for id in set {
            out.extend_from_slice(&id.to_le_bytes());
        }
    }
    out.extend_from_slice(json.as_bytes());
    Ok(out)
}

fn do_scan_rows(mut r: Req<'_>) -> Res<Vec<u8>> {
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
    Ok(viz_query::scan_rows(&indexes, &ranges).into_iter().flat_map(|r| r.unwrap_or(u64::MAX).to_le_bytes()).collect())
}

fn plan_json(p: &viz_query::FilePlan) -> serde_json::Value {
    let read = match &p.read {
        FileRead::Skip => serde_json::json!("skip"),
        FileRead::Whole => serde_json::json!("whole"),
        FileRead::Ranges(r) => serde_json::json!(r.iter().map(|(o, l)| [*o, *l]).collect::<Vec<_>>()),
    };
    serde_json::json!({"rows": p.rows, "read": read})
}

fn index_texts<'a>(raw: &[&'a [u8]]) -> Vec<&'a str> {
    // A fragment that is not UTF-8 cannot be parsed either: "" keeps the file whole.
    raw.iter().map(|b| std::str::from_utf8(b).unwrap_or("")).collect()
}

fn do_file_plan(mut r: Req<'_>) -> Res<Vec<u8>> {
    let gap = r.u64("gap")?;
    let ranges = r.ranges()?;
    let raw = r.files("index fragment")?;
    r.end()?;
    let plans = viz_query::file_plan(&index_texts(&raw), &ranges, gap);
    Ok(serde_json::Value::Array(plans.iter().map(plan_json).collect()).to_string().into_bytes())
}

fn do_part_plan(mut r: Req<'_>) -> Res<Vec<u8>> {
    let gap = r.u64("gap")?;
    let (part, parts) = (r.u32("part")?, r.u32("parts")?);
    let ranges = r.ranges()?;
    let raw = r.files("index fragment")?;
    r.end()?;
    if parts == 0 || part >= parts {
        return Err(Fail::Malformed(format!("part {part} of {parts}")));
    }
    let plans = viz_query::part_plan(&index_texts(&raw), &ranges, part, parts, gap);
    Ok(serde_json::Value::Array(plans.iter().map(plan_json).collect()).to_string().into_bytes())
}

fn do_sample_plan(mut r: Req<'_>) -> Res<Vec<u8>> {
    let gap = r.u64("gap")?;
    let part = match r.u8("has_part")? {
        0 => None,
        1 => Some((r.key()?, r.u32("part")?, r.u32("parts")?)),
        x => return Err(Fail::Malformed(format!("has_part is {x}"))),
    };
    let ranges = r.ranges()?;
    let series = r.files("series file")?;
    let raw = r.files("index fragment")?;
    let n_pairs = r.u32("n_pairs")?;
    let mut pairs: Vec<Option<usize>> = Vec::with_capacity((n_pairs as usize).min(r.b.len() / 4));
    for _ in 0..n_pairs {
        let p = r.u32("pair")?;
        pairs.push((p != u32::MAX).then_some(p as usize));
    }
    r.end()?;
    if let Some((_, part, parts)) = &part {
        if *parts == 0 || part >= parts {
            return Err(Fail::Malformed(format!("part {part} of {parts}")));
        }
    }
    let filter = part.as_ref().map(|(key, part, parts)| PartFilter { key, part: *part, parts: *parts });
    let p = viz_query::sample_plan(&series, &index_texts(&raw), &ranges, filter, (n_pairs > 0).then_some(&pairs[..]), gap)?;
    let v = serde_json::json!({"series": p.series, "files": p.files.iter().map(plan_json).collect::<Vec<_>>()}).to_string();
    let carrier = p.carrier.unwrap_or_default();
    let mut out = Vec::with_capacity(4 + v.len() + carrier.len());
    out.extend_from_slice(&(v.len() as u32).to_le_bytes());
    out.extend_from_slice(v.as_bytes());
    out.extend_from_slice(&carrier);
    Ok(out)
}

fn do_split_plan(mut r: Req<'_>) -> Res<Vec<u8>> {
    let opts = r.limits()?;
    let q = r.str("query")?;
    r.end()?;
    let v = match viz_query::split_plan(q, &opts) {
        SplitPlan::Split { fragments, key } => serde_json::json!({"split": true, "fragments": fragments, "without": key.without}),
        SplitPlan::Single { reason } => serde_json::json!({"split": false, "reason": reason}),
    };
    Ok(v.to_string().into_bytes())
}

fn do_extract(mut r: Req<'_>) -> Res<Vec<u8>> {
    let key = r.key()?;
    let (part, parts) = (r.u32("part")?, r.u32("parts")?);
    let ranges = r.ranges()?;
    let series = r.files("series file")?;
    let samples = r.files("sample file")?;
    r.end()?;
    if parts == 0 || part >= parts {
        return Err(Fail::Malformed(format!("part {part} of {parts}")));
    }
    let ex = split::extract(&series, &samples, &key, part, parts, &ranges)?;
    let mut out = Vec::with_capacity(24 + ex.batch.len());
    out.extend_from_slice(&ex.rows.to_le_bytes());
    out.extend_from_slice(&ex.series.to_le_bytes());
    out.extend_from_slice(&ex.strays.to_le_bytes());
    out.extend_from_slice(&ex.foreign.to_le_bytes());
    out.extend_from_slice(&ex.batch);
    Ok(out)
}

fn do_split_tails(mut r: Req<'_>) -> Res<Vec<u8>> {
    let key = r.key()?;
    let parts = r.u32("parts")?;
    let ranges = r.ranges()?;
    let batches = r.files("tail batch")?;
    r.end()?;
    if parts == 0 {
        return Err(Fail::Malformed("zero parts".into()));
    }
    let cut = split::split_tails(&batches, &key, parts, &ranges)?;
    let mut out = Vec::new();
    for list in cut {
        out.extend_from_slice(&(list.len() as u32).to_le_bytes());
        for b in list {
            out.extend_from_slice(&(b.len() as u32).to_le_bytes());
            out.extend_from_slice(&b);
        }
    }
    Ok(out)
}

thread_local! {
    /// Gathering sessions of leaves in flight in this instance: a leaf adds batches as
    /// they arrive and evaluates once all are in. Dropping the instance drops them.
    static SESSIONS: RefCell<(u32, HashMap<u32, Gathered>)> = RefCell::new((0, HashMap::new()));
}

fn do_gather_new(mut r: Req<'_>) -> Res<Vec<u8>> {
    let budget = LeafBudget { samples: r.u64("samples")?, series: r.u64("series")?, step_points: r.u64("step_points")? };
    let ranges = r.ranges()?;
    r.end()?;
    let g = Gathered::new(&ranges, budget)?;
    let h = SESSIONS.with(|s| {
        let mut s = s.borrow_mut();
        s.0 = s.0.wrapping_add(1).max(1);
        let h = s.0;
        s.1.insert(h, g);
        h
    });
    Ok(h.to_le_bytes().to_vec())
}

fn do_gather_add(mut r: Req<'_>) -> Res<Vec<u8>> {
    let h = r.u32("handle")?;
    let rank = r.u32("rank")?;
    let b = r.item("batch")?;
    r.end()?;
    SESSIONS.with(|s| {
        let mut s = s.borrow_mut();
        let g = s.1.get_mut(&h).ok_or_else(|| Fail::Malformed(format!("no gathering session {h}")))?;
        g.add(b, rank)?;
        let (samples, series) = g.counts();
        let mut out = vec![g.aborted.is_some() as u8];
        out.extend_from_slice(&samples.to_le_bytes());
        out.extend_from_slice(&series.to_le_bytes());
        Ok(out)
    })
}

fn do_gather_eval(mut r: Req<'_>) -> Res<Vec<u8>> {
    let h = r.u32("handle")?;
    let opts = r.limits()?;
    let grid = r.grid()?;
    let fragments = r.u32("fragments")? as usize;
    let q = r.str("query")?;
    r.end()?;
    let g = SESSIONS.with(|s| s.borrow_mut().1.remove(&h)).ok_or_else(|| Fail::Malformed(format!("no gathering session {h}")))?;
    Ok(split::leaf_evaluate(&g, q, grid, &opts, fragments).encode())
}

fn do_gather_free(mut r: Req<'_>) -> Res<Vec<u8>> {
    let h = r.u32("handle")?;
    r.end()?;
    SESSIONS.with(|s| s.borrow_mut().1.remove(&h));
    Ok(Vec::new())
}

fn do_merge(mut r: Req<'_>) -> Res<Vec<u8>> {
    let opts = r.limits()?;
    let grid = r.grid()?;
    let q = r.str("query")?;
    let raw = r.files("leaf answer")?;
    r.end()?;
    let outputs = raw.iter().map(|b| LeafOutput::decode(b)).collect::<Result<Vec<_>, _>>()?;
    match grid {
        Grid::Range { start, end, step } => {
            let out = split::merge_range(q, start, end, step, &opts, &outputs)?;
            Ok(with_stats(out.stats, viz_query::to_json(&out.matrix)?))
        }
        Grid::Instant { time } => {
            let out = split::merge_instant(q, time, &opts, &outputs)?;
            Ok(with_stats(out.stats, viz_query::to_json(&out.value)?))
        }
    }
}

fn do_card_part(mut r: Req<'_>) -> Res<Vec<u8>> {
    let (start, end) = (r.i64("start")?, r.i64("end")?);
    let (part, parts) = (r.u32("part")?, r.u32("parts")?);
    let caps = viz_query::cardinality::Caps { max_series: r.u64("max_series")?, max_pairs: r.u64("max_pairs")? };
    let series = r.files("series file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    if parts == 0 || part >= parts {
        return Err(Fail::Malformed(format!("part {part} of {parts}")));
    }
    let mut st = viz_query::cardinality::State::new(start, end, part, parts, caps);
    for (i, f) in series.iter().enumerate() {
        st.add_series_file(f, i)?;
    }
    for (i, b) in tails.iter().enumerate() {
        st.add_tail_batch(b, i)?;
    }
    Ok(st.summary().encode())
}

fn do_card_report(mut r: Req<'_>) -> Res<Vec<u8>> {
    let caps = viz_query::cardinality::Caps { max_series: r.u64("max_series")?, max_pairs: r.u64("max_pairs")? };
    let limit = r.u32("limit")? as usize;
    let (start, end, lookback) = (r.i64("start")?, r.i64("end")?, r.i64("lookback_start")?);
    let parts = r.files("summary")?;
    r.end()?;
    let mut all = viz_query::cardinality::Summary::default();
    for p in parts {
        all.merge(&viz_query::cardinality::Summary::decode(p)?, caps)?;
    }
    let (tsdb, viz) = all.report(limit, start, end, lookback, caps);
    let mut out = Vec::with_capacity(4 + tsdb.len() + viz.len());
    out.extend_from_slice(&(tsdb.len() as u32).to_le_bytes());
    out.extend_from_slice(tsdb.as_bytes());
    out.extend_from_slice(viz.as_bytes());
    Ok(out)
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
export!(viz_q_scan_rows, do_scan_rows);
export!(viz_q_split_plan, do_split_plan);
export!(viz_q_extract, do_extract);
export!(viz_q_split_tails, do_split_tails);
export!(viz_q_gather_new, do_gather_new);
export!(viz_q_gather_add, do_gather_add);
export!(viz_q_gather_eval, do_gather_eval);
export!(viz_q_gather_free, do_gather_free);
export!(viz_q_merge, do_merge);
export!(viz_q_card_part, do_card_part);
export!(viz_q_card_report, do_card_report);
export!(viz_q_file_plan, do_file_plan);
export!(viz_q_sample_plan, do_sample_plan);
export!(viz_q_part_plan, do_part_plan);
export!(viz_q_meta_part, do_meta_part);
// ABI 6: traces and logs (`traces.rs`, `logs.rs`).
export!(viz_q_tq_plan, traces::do_tq_plan);
export!(viz_q_tq_file_plan, traces::do_tq_file_plan);
export!(viz_q_tq_probe, traces::do_tq_probe);
export!(viz_q_tq_extent, traces::do_tq_extent);
export!(viz_q_tq_search, traces::do_tq_search);
export!(viz_q_tq_metrics, traces::do_tq_metrics);
export!(viz_q_tq_trace, traces::do_tq_trace);
export!(viz_q_tq_tags, traces::do_tq_tags);
export!(viz_q_tq_tag_values, traces::do_tq_tag_values);
export!(viz_q_lq_plan, logs::do_lq_plan);
export!(viz_q_lq_file_plan, logs::do_lq_file_plan);
export!(viz_q_lq_query, logs::do_lq_query);
export!(viz_q_lq_labels, logs::do_lq_labels);
