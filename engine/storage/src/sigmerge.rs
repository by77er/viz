//! Compaction of the span and log tables (`contracts/TRACES.md` and `LOGS.md`, "Compaction"):
//! several files of one table and one partition become one file, written by the same writers
//! flush uses, one row group at a time.
//!
//! * `spans`: the files of ONE hour. Rows equal on `(trace_id, span_id)` are one row: the later
//!   input wins, and within one input the later row (a first pass over the two id columns
//!   finds the winners). Sorted as flush sorts.
//! * `trace_index`: the files of ONE day. The rows of one `trace_id` become one row
//!   ([`merge_fragments`], then at most 64 services by the contract's rule).
//! * `logs`: the files of ONE day. Rows equal on `(stream_id, ts, line, metadata)` are one row,
//!   the later input's (adjacent in the merged order, as in flush). The output carries the token
//!   filter unless `token_filter` is off.
//!
//! Inputs are given lowest precedence first, as for metrics (`contracts/ledger.ts` `LiveFile`).
//! Each input is read row by row through the record API (a page at a time per column), so the
//! merge holds the inputs as given, one output row group decoded, the output written so far and
//! (logs) the token filter being built.
use crate::logs::{log_weight, LogsFileWriter, RowRef as LogRef, StreamInfo};
use crate::otel::{LogRow, LogStream, Span, SpanEntry};
use crate::otelpq::{perr, SResult, SignalError, SignalFile, SignalTable, SignalWriteOptions, NS_PER_DAY, NS_PER_HOUR};
use crate::otelread::{fragment_record, log_record, open, span_record, LOGS_LEAVES, SPANS_LEAVES, TRACE_INDEX_LEAVES};
use crate::spans::{fragment_weight, merge_fragments, span_weight, EntryInfo, Fragment, IndexFileWriter, RowRef as SpanRef, SpansFileWriter, MAX_INDEX_SERVICES};
use crate::tokens::MAX_FILTER_TOKENS;
use bytes::Bytes;
use parquet::file::reader::FileReader;
use parquet::record::reader::RowIter;
use parquet::record::Row;
use std::cmp::Ordering;
use std::rc::Rc;

/// How a merge writes its output.
#[derive(Debug, Clone)]
pub struct SignalMergeOptions {
    pub write: SignalWriteOptions,
    /// `logs` only: write the token filter (`contracts/LOGS.md` §6). On by default; off gives the
    /// bytes a flush of the same rows would give.
    pub token_filter: bool,
    /// `logs` only: no filter for a file with more distinct tokens than this (the contract's
    /// bound, [`MAX_FILTER_TOKENS`], by default; tests lower it).
    pub token_filter_max_tokens: usize,
}

impl Default for SignalMergeOptions {
    fn default() -> Self {
        SignalMergeOptions { write: SignalWriteOptions::default(), token_filter: true, token_filter_max_tokens: MAX_FILTER_TOKENS }
    }
}

fn merr<T>(m: impl Into<String>) -> SResult<T> {
    Err(SignalError::Merge(m.into()))
}

/// Merge files of one table and one partition (an hour of `spans`, a day of `trace_index` or
/// `logs`) into one, inputs lowest precedence first. The inputs are copied once.
pub fn merge_signal_files(table: SignalTable, inputs: &[&[u8]]) -> SResult<SignalFile> {
    let shared: Vec<Bytes> = inputs.iter().map(|b| Bytes::copy_from_slice(b)).collect();
    merge_signal_files_shared(table, &shared, &SignalMergeOptions::default())
}

/// [`merge_signal_files`] over inputs the caller already holds, with explicit options.
pub fn merge_signal_files_shared(table: SignalTable, inputs: &[Bytes], opts: &SignalMergeOptions) -> SResult<SignalFile> {
    if inputs.is_empty() {
        return merr("no input files");
    }
    let capacity = inputs.iter().map(Bytes::len).sum();
    let out = match table {
        SignalTable::Spans => merge_spans(inputs, opts, capacity)?,
        SignalTable::TraceIndex => merge_trace_index(inputs, opts, capacity)?,
        SignalTable::Logs => merge_logs(inputs, opts, capacity)?,
    };
    Ok(out)
}

/// The rows of one input, in file order, converted by `conv`.
struct Cursor<T> {
    rows: RowIter<'static>,
    head: Option<T>,
    input: usize,
    ordinal: u64,
}

/// Values the record reader decodes at a time per column. Its default (1024) costs about 40 KB
/// per column per open input (2.3 MB for a `spans` file); a k-way merge holds every input open.
const READ_BATCH: usize = 64;

fn rows_of(bytes: &Bytes, table: &str, leaves: usize) -> SResult<RowIter<'static>> {
    Ok(RowIter::from_file_into(Box::new(open(bytes.clone(), table, leaves)?)).with_batch_size(READ_BATCH))
}

fn next_row(rows: &mut RowIter<'static>) -> SResult<Option<Row>> {
    rows.next().transpose().map_err(perr)
}

/// The cursor whose head is smallest by `cmp`, the earlier input first on a tie.
fn smallest<T>(cursors: &[Cursor<T>], cmp: impl Fn(&T, &T) -> Ordering) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, c) in cursors.iter().enumerate() {
        let Some(h) = &c.head else { continue };
        match best {
            Some(b) if cmp(h, cursors[b].head.as_ref().unwrap()) != Ordering::Less => {}
            _ => best = Some(i),
        }
    }
    best
}

/// Rows cut into row groups as `otelpq::cut_groups` cuts them, one row at a time.
struct Cutter {
    max_rows: usize,
    max_bytes: usize,
    rows: usize,
    bytes: usize,
}

impl Cutter {
    fn new(o: &SignalWriteOptions) -> Cutter {
        Cutter { max_rows: o.max_row_group_rows.max(1), max_bytes: o.max_row_group_bytes, rows: 0, bytes: 0 }
    }
    /// Whether a row of weight `w` starts a new group; then counts it.
    fn starts_group(&mut self, w: usize) -> bool {
        let cut = self.rows > 0 && (self.rows >= self.max_rows || self.bytes + w > self.max_bytes);
        if cut {
            self.rows = 0;
            self.bytes = 0;
        }
        self.rows += 1;
        self.bytes += w;
        cut
    }
}

// ───────────────────────────── spans ─────────────────────────────

struct SpanIn {
    span: Span<String>,
    entry: SpanEntry<String>,
    service: Option<String>,
}

fn span_in(r: &Row) -> SResult<SpanIn> {
    let x = span_record(r)?;
    let d = |v: Option<i32>| v.map_or(0, |v| v as u32);
    Ok(SpanIn {
        span: Span {
            entry: 0,
            trace_id: x.trace_id,
            span_id: x.span_id,
            parent_span_id: x.parent_span_id.unwrap_or([0; 8]),
            start: x.start_unix_nano,
            end: x.end_unix_nano,
            flags: d(x.flags),
            dropped: [d(x.dropped[0]), d(x.dropped[1]), d(x.dropped[2])],
            kind: x.span_kind as u8,
            status: x.status_code as u8,
            name: x.span_name,
            trace_state: x.trace_state.unwrap_or_default(),
            status_message: x.status_message.unwrap_or_default(),
            attrs: x.attrs,
            events: x.events,
            links: x.links,
        },
        entry: SpanEntry {
            resource_fp: x.resource_fp,
            resource: x.resource,
            scope_name: x.scope_name.unwrap_or_default(),
            scope_version: x.scope_version.unwrap_or_default(),
            scope_attrs: x.scope_attrs.unwrap_or_default(),
        },
        service: x.service_name,
    })
}

fn span_view(s: &Span<String>) -> Span<&str> {
    Span {
        entry: 0,
        trace_id: s.trace_id,
        span_id: s.span_id,
        parent_span_id: s.parent_span_id,
        start: s.start,
        end: s.end,
        flags: s.flags,
        dropped: s.dropped,
        kind: s.kind,
        status: s.status,
        name: &s.name,
        trace_state: &s.trace_state,
        status_message: &s.status_message,
        attrs: s.attrs.iter().map(|a| crate::otel::Attr { key: a.key.as_str(), value: view_value(&a.value) }).collect(),
        events: s.events.iter().map(|e| crate::otel::Event { time_unix_nano: e.time_unix_nano, name: e.name.as_str(), attrs: e.attrs.as_str() }).collect(),
        links: s
            .links
            .iter()
            .map(|l| crate::otel::Link { trace_id: l.trace_id, span_id: l.span_id, trace_state: l.trace_state.as_str(), attrs: l.attrs.as_str() })
            .collect(),
    }
}

fn view_value(v: &crate::otel::Value<String>) -> crate::otel::Value<&str> {
    use crate::otel::Value;
    match v {
        Value::Str(s) => Value::Str(s.as_str()),
        Value::Int(i) => Value::Int(*i),
        Value::Double(b) => Value::Double(*b),
        Value::Bool(b) => Value::Bool(*b),
        Value::Other(s) => Value::Other(s.as_str()),
    }
}

fn entry_view(e: &SpanEntry<String>) -> SpanEntry<&str> {
    SpanEntry {
        resource_fp: e.resource_fp,
        resource: e.resource.iter().map(|a| crate::otel::Attr { key: a.key.as_str(), value: view_value(&a.value) }).collect(),
        scope_name: &e.scope_name,
        scope_version: &e.scope_version,
        scope_attrs: &e.scope_attrs,
    }
}

/// The sort order of `spans` (`service_name` nulls first, `span_name`, start, ids).
fn span_order(a: &SpanIn, b: &SpanIn) -> Ordering {
    (a.service.as_deref().map(str::as_bytes), a.span.name.as_bytes(), a.span.start, a.span.trace_id, a.span.span_id).cmp(&(
        b.service.as_deref().map(str::as_bytes),
        b.span.name.as_bytes(),
        b.span.start,
        b.span.trace_id,
        b.span.span_id,
    ))
}

fn write_span_group(w: &mut SpansFileWriter, g: &[SpanIn], hour: i64) -> SResult<()> {
    let entries: Vec<SpanEntry<&str>> = g.iter().map(|x| entry_view(&x.entry)).collect();
    let spans: Vec<Span<&str>> = g.iter().map(|x| span_view(&x.span)).collect();
    let infos: Vec<EntryInfo<'_>> = entries.iter().map(EntryInfo::of).collect();
    let refs: Vec<SpanRef<'_>> = spans.iter().enumerate().map(|(i, s)| SpanRef { span: s, info: i, hour }).collect();
    w.group(&refs, &infos)
}

fn merge_spans(inputs: &[Bytes], opts: &SignalMergeOptions, capacity: usize) -> SResult<SignalFile> {
    // Pass 1: the last occurrence of every (trace_id, span_id), by input then row: every id
    // with where it was read, sorted, the last of each id kept (32 bytes a row, sized once).
    let ids = parquet::schema::parser::parse_message_type(
        "message spans { required fixed_len_byte_array(16) trace_id; required fixed_len_byte_array(8) span_id; }",
    )
    .map_err(perr)?;
    let total: usize = inputs.iter().map(|b| open(b.clone(), "spans", SPANS_LEAVES).map(|r| r.metadata().file_metadata().num_rows().max(0) as usize)).sum::<SResult<usize>>()?;
    let mut seen: Vec<([u8; 24], u32, u32)> = Vec::with_capacity(total);
    for (i, b) in inputs.iter().enumerate() {
        let mut rows = rows_of(b, "spans", SPANS_LEAVES)?.project(Some(ids.clone())).map_err(perr)?.with_batch_size(READ_BATCH);
        let mut k = 0u32;
        while let Some(r) = next_row(&mut rows)? {
            let mut key = [0u8; 24];
            for (name, f) in r.get_column_iter() {
                let parquet::record::Field::Bytes(v) = f else { return merr("spans: an id is not bytes") };
                match (name.as_str(), v.len()) {
                    ("trace_id", 16) => key[..16].copy_from_slice(v.data()),
                    ("span_id", 8) => key[16..].copy_from_slice(v.data()),
                    _ => return merr("spans: an id has the wrong length"),
                }
            }
            seen.push((key, i as u32, k));
            k += 1;
        }
    }
    seen.sort_unstable();
    // The last of each id (sorted by input, then row, within the id).
    let mut w = 0;
    for j in 0..seen.len() {
        if j + 1 < seen.len() && seen[j + 1].0 == seen[j].0 {
            continue;
        }
        seen[w] = seen[j];
        w += 1;
    }
    seen.truncate(w);
    let winners = Winners(seen);
    // Pass 2: the k-way merge, keeping winners only. Every row read is of one hour, the
    // output's (a row another input wins is checked too: the inputs are one partition).
    let mut hour: Option<i64> = None;
    let mut cursors: Vec<Cursor<SpanIn>> = Vec::with_capacity(inputs.len());
    for (i, b) in inputs.iter().enumerate() {
        let mut c = Cursor { rows: rows_of(b, "spans", SPANS_LEAVES)?, head: None, input: i, ordinal: 0 };
        seek_span(&mut c, None, &winners, &mut hour)?;
        cursors.push(c);
    }
    let mut writer: Option<SpansFileWriter> = None;
    let mut cutter = Cutter::new(&opts.write);
    let mut group: Vec<SpanIn> = Vec::new();
    while let Some(i) = smallest(&cursors, span_order) {
        let c = &mut cursors[i];
        let x = c.head.take().unwrap();
        seek_span(c, Some(&x), &winners, &mut hour)?;
        let h = x.span.start.div_euclid(NS_PER_HOUR);
        if writer.is_none() {
            writer = Some(SpansFileWriter::with_capacity(h, &opts.write, capacity)?);
        }
        let w = {
            let e = entry_view(&x.entry);
            let s = span_view(&x.span);
            let infos = [EntryInfo::of(&e)];
            span_weight(&SpanRef { span: &s, info: 0, hour: h }, &infos)
        };
        if cutter.starts_group(w) {
            write_span_group(writer.as_mut().unwrap(), &group, h)?;
            group.clear();
        }
        group.push(x);
    }
    let (Some(h), Some(mut w)) = (hour, writer) else { return merr("spans inputs hold no rows") };
    write_span_group(&mut w, &group, h)?;
    w.finish()
}

/// Where each (trace_id, span_id) is kept: (id, input, row), sorted by id.
struct Winners(Vec<([u8; 24], u32, u32)>);

impl Winners {
    fn wins(&self, key: &[u8; 24], input: usize, row: u64) -> bool {
        self.0.binary_search_by(|x| x.0.cmp(key)).is_ok_and(|i| (self.0[i].1 as usize, self.0[i].2 as u64) == (input, row))
    }
}

/// Move cursor `c` (its head taken, `prev` the row it held) to its next winning row, checking
/// that every row it reads sorts after the one before it.
fn seek_span(c: &mut Cursor<SpanIn>, prev: Option<&SpanIn>, winners: &Winners, hour: &mut Option<i64>) -> SResult<()> {
    let mut skipped: Option<SpanIn> = None;
    loop {
        let Some(r) = next_row(&mut c.rows)? else { return Ok(()) };
        let x = span_in(&r)?;
        let h = x.span.start.div_euclid(NS_PER_HOUR);
        if *hour.get_or_insert(h) != h {
            return merr("spans inputs hold rows of more than one hour");
        }
        let k = c.ordinal;
        c.ordinal += 1;
        if skipped.as_ref().or(prev).is_some_and(|p| span_order(p, &x) != Ordering::Less) {
            return merr(format!("spans input {} is not sorted at row {k}", c.input));
        }
        let mut key = [0u8; 24];
        key[..16].copy_from_slice(&x.span.trace_id);
        key[16..].copy_from_slice(&x.span.span_id);
        if winners.wins(&key, c.input, k) {
            c.head = Some(x);
            return Ok(());
        }
        skipped = Some(x);
    }
}

// ───────────────────────────── trace_index ─────────────────────────────

fn merge_trace_index(inputs: &[Bytes], opts: &SignalMergeOptions, capacity: usize) -> SResult<SignalFile> {
    let first_day: std::cell::RefCell<Option<i64>> = std::cell::RefCell::new(None);
    let mut cursors: Vec<Cursor<Fragment>> = Vec::with_capacity(inputs.len());
    let next = |c: &mut Cursor<Fragment>, prev: Option<&Fragment>| -> SResult<()> {
        if let Some(r) = next_row(&mut c.rows)? {
            let f = fragment_record(&r)?;
            let d = f.min_start.div_euclid(NS_PER_DAY);
            if *first_day.borrow_mut().get_or_insert(d) != d {
                return merr("trace_index inputs hold rows of more than one day");
            }
            if prev.is_some_and(|p| p.trace_id >= f.trace_id) {
                return merr(format!("trace_index input {} is not sorted at row {}", c.input, c.ordinal));
            }
            c.ordinal += 1;
            c.head = Some(f);
        }
        Ok(())
    };
    for (i, b) in inputs.iter().enumerate() {
        let mut c = Cursor { rows: rows_of(b, "trace_index", TRACE_INDEX_LEAVES)?, head: None, input: i, ordinal: 0 };
        next(&mut c, None)?;
        cursors.push(c);
    }
    let mut day: Option<i64> = None;
    let mut writer: Option<IndexFileWriter> = None;
    let mut cutter = Cutter::new(&opts.write);
    let mut group: Vec<Fragment> = Vec::new();
    while let Some(i) = smallest(&cursors, |a, b| a.trace_id.cmp(&b.trace_id)) {
        let id = cursors[i].head.as_ref().unwrap().trace_id;
        let mut run = Vec::new();
        for c in cursors.iter_mut() {
            if c.head.as_ref().is_some_and(|h| h.trace_id == id) {
                let f = c.head.take().unwrap();
                next(c, Some(&f))?;
                run.push(f);
            }
        }
        // Later inputs first: when two fragments claim the same root span (a span stored by two
        // units), `merge_fragments` keeps the first claim, which is then the later input's.
        run.reverse();
        let mut f = merge_fragments(&run).unwrap();
        if f.services.len() > MAX_INDEX_SERVICES {
            f.services.sort_by(|x, y| y.1.cmp(&x.1).then(x.0.as_bytes().cmp(y.0.as_bytes())));
            f.services.truncate(MAX_INDEX_SERVICES);
            f.services.sort_by(|x, y| x.0.as_bytes().cmp(y.0.as_bytes()));
            f.services_truncated = true;
        }
        let d = f.min_start.div_euclid(NS_PER_DAY);
        match day {
            None => {
                day = Some(d);
                writer = Some(IndexFileWriter::with_capacity(d, &opts.write, capacity)?);
            }
            Some(o) if o != d => return merr("trace_index inputs hold rows of more than one day"),
            _ => {}
        }
        if cutter.starts_group(fragment_weight(&f)) {
            writer.as_mut().unwrap().group(&group)?;
            group.clear();
        }
        group.push(f);
    }
    let Some(mut w) = writer else { return merr("trace_index inputs hold no rows") };
    w.group(&group)?;
    w.finish()
}

// ───────────────────────────── logs ─────────────────────────────

struct LogIn {
    service: String,
    stream_id: i64,
    ts: i64,
    labels_json: Rc<str>,
    labels: Rc<Vec<(String, String)>>,
    label_bytes: usize,
    line: String,
    metadata: Vec<(String, String)>,
    observed_ts: i64,
    severity_number: u8,
    severity_text: String,
    trace_id: [u8; 16],
    span_id: [u8; 8],
    flags: u32,
}

/// The sort order of `logs` (`service_name`, `stream_id`, `ts`, `line`, `metadata`).
fn log_order(a: &LogIn, b: &LogIn) -> Ordering {
    (a.service.as_bytes(), a.stream_id, a.ts, a.line.as_bytes())
        .cmp(&(b.service.as_bytes(), b.stream_id, b.ts, b.line.as_bytes()))
        .then_with(|| a.metadata.iter().map(|(n, v)| (n.as_bytes(), v.as_bytes())).cmp(b.metadata.iter().map(|(n, v)| (n.as_bytes(), v.as_bytes()))))
}

/// The row key (`contracts/LOGS.md` §4): rows equal on it are one row.
fn same_log(a: &LogIn, b: &LogIn) -> bool {
    a.stream_id == b.stream_id && a.ts == b.ts && a.line == b.line && a.metadata == b.metadata
}

fn log_view(x: &LogIn, entry: u32) -> LogRow<&str> {
    LogRow {
        entry,
        ts: x.ts,
        observed_ts: x.observed_ts,
        trace_id: x.trace_id,
        span_id: x.span_id,
        flags: x.flags,
        severity_number: x.severity_number,
        line: &x.line,
        severity_text: &x.severity_text,
        metadata: x.metadata.iter().map(|(n, v)| (n.as_str(), v.as_str())).collect(),
    }
}

fn write_log_group(w: &mut LogsFileWriter, g: &[LogIn]) -> SResult<()> {
    // One stream per run of rows with the same stream (a stream's rows are contiguous).
    let mut first_of_run: Vec<usize> = Vec::new();
    let mut run_of: Vec<usize> = Vec::with_capacity(g.len());
    for (i, x) in g.iter().enumerate() {
        let new = match first_of_run.last() {
            Some(&f) => g[f].stream_id != x.stream_id || g[f].labels_json != x.labels_json,
            None => true,
        };
        if new {
            first_of_run.push(i);
        }
        run_of.push(first_of_run.len() - 1);
    }
    let streams: Vec<LogStream<&str>> =
        first_of_run.iter().map(|&f| LogStream { stream_id: g[f].stream_id, labels: g[f].labels.iter().map(|(n, v)| (n.as_str(), v.as_str())).collect() }).collect();
    let infos: Vec<StreamInfo<'_>> = first_of_run
        .iter()
        .zip(&streams)
        .map(|(&f, s)| StreamInfo { stream: s, service: &g[f].service, labels: g[f].labels_json.to_string(), label_bytes: g[f].label_bytes })
        .collect();
    let rows: Vec<LogRow<&str>> = g.iter().zip(&run_of).map(|(x, &k)| log_view(x, k as u32)).collect();
    let refs: Vec<LogRef<'_>> = rows.iter().zip(&run_of).map(|(r, &k)| LogRef { row: r, stream: k, day: 0 }).collect();
    w.group(&refs, &infos)
}

/// Take the head of `c` and read its next row.
fn pop_log(c: &mut Cursor<LogIn>, next: &dyn Fn(&mut Cursor<LogIn>, Option<&LogIn>) -> SResult<()>) -> SResult<LogIn> {
    let x = c.head.take().unwrap();
    next(c, Some(&x))?;
    Ok(x)
}

fn merge_logs(inputs: &[Bytes], opts: &SignalMergeOptions, capacity: usize) -> SResult<SignalFile> {
    let first_day: std::cell::RefCell<Option<i64>> = std::cell::RefCell::new(None);
    // Reads the next row of `c` into its head; `prev` is the row it held (taken by the caller).
    let next = |c: &mut Cursor<LogIn>, prev: Option<&LogIn>| -> SResult<()> {
        let Some(r) = next_row(&mut c.rows)? else { return Ok(()) };
        // Parse a stream's labels once: the previous row's are reused when the cell is the same.
        let cached = prev.map(|p| (p.labels_json.as_ref(), &[][..]));
        let x = log_record(&r, cached)?;
        let (labels_json, labels, label_bytes) = match prev {
            Some(p) if *p.labels_json == *x.labels_json => (p.labels_json.clone(), p.labels.clone(), p.label_bytes),
            _ => {
                let lb = x.labels.iter().map(|(n, v)| n.len() + v.len()).sum();
                (Rc::from(x.labels_json.as_str()), Rc::new(x.labels), lb)
            }
        };
        let y = LogIn {
            service: x.service_name,
            stream_id: x.stream_id,
            ts: x.ts,
            labels_json,
            labels,
            label_bytes,
            line: x.line,
            metadata: x.metadata,
            observed_ts: x.observed_ts.unwrap_or(0),
            severity_number: x.severity_number.unwrap_or(0) as u8,
            severity_text: x.severity_text.unwrap_or_default(),
            trace_id: x.trace_id.unwrap_or([0; 16]),
            span_id: x.span_id.unwrap_or([0; 8]),
            flags: x.flags.map_or(0, |f| f as u32),
        };
        let d = y.ts.div_euclid(NS_PER_DAY);
        if *first_day.borrow_mut().get_or_insert(d) != d {
            return merr("logs inputs hold rows of more than one day");
        }
        if prev.is_some_and(|p| log_order(p, &y) == Ordering::Greater) {
            return merr(format!("logs input {} is not sorted at row {}", c.input, c.ordinal));
        }
        c.ordinal += 1;
        c.head = Some(y);
        Ok(())
    };
    let mut cursors: Vec<Cursor<LogIn>> = Vec::with_capacity(inputs.len());
    for (i, b) in inputs.iter().enumerate() {
        let mut c = Cursor { rows: rows_of(b, "logs", LOGS_LEAVES)?, head: None, input: i, ordinal: 0 };
        next(&mut c, None)?;
        cursors.push(c);
    }
    let mut day: Option<i64> = None;
    let mut writer = LogsFileWriter::with_capacity(&opts.write, opts.token_filter.then_some(opts.token_filter_max_tokens), capacity)?;
    let mut cutter = Cutter::new(&opts.write);
    let mut group: Vec<LogIn> = Vec::new();
    // A row is kept unless the next row in the merged order has the same row key (the later
    // input's, or the later row of one input, then wins), exactly as flush keeps them.
    let mut pending: Option<LogIn> = None;
    let mut emit = |x: LogIn, group: &mut Vec<LogIn>, writer: &mut LogsFileWriter| -> SResult<()> {
        let d = x.ts.div_euclid(NS_PER_DAY);
        match day {
            None => day = Some(d),
            Some(o) if o != d => return merr("logs inputs hold rows of more than one day"),
            _ => {}
        }
        let w = log_weight(&log_view(&x, 0), x.label_bytes);
        if cutter.starts_group(w) {
            write_log_group(writer, group)?;
            group.clear();
        }
        group.push(x);
        Ok(())
    };
    while let Some(i) = smallest(&cursors, log_order) {
        let x = pop_log(&mut cursors[i], &next)?;
        match pending.take() {
            Some(p) if !same_log(&p, &x) => emit(p, &mut group, &mut writer)?,
            _ => {}
        }
        pending = Some(x);
    }
    let Some(p) = pending else { return merr("logs inputs hold no rows") };
    emit(p, &mut group, &mut writer)?;
    write_log_group(&mut writer, &group)?;
    writer.finish()
}
