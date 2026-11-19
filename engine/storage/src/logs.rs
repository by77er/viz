//! Flush for logs: a sealed segment's log-record batches (`VZB1` signal 3) become `logs`
//! files, one per UTC day of `ts`, laid out as `contracts/LOGS.md` states.
use crate::json::labels_to_json;
use crate::otel::{self, LogRow, LogStream};
use crate::otelpq::{
    ba, col, cut_groups, day_of_ns, fba, foot, json_str, perr, props, schema, write_group, Leaf, Levels, SResult, SignalError, SignalFile, SignalTable,
    SignalWriteOptions, LINE_CHUNK_BYTES, LINE_PAGE_CUT_BYTES, NS_PER_DAY,
};
use crate::tokens::{TokenFilterBuilder, TOKEN_FILTER_META};
use parquet::file::metadata::{KeyValue, SortingColumn};
use parquet::file::properties::EnabledStatistics;
use parquet::file::writer::SerializedFileWriter;

pub(crate) const LOGS_SCHEMA: &str = "message logs {
  required binary service_name (UTF8);
  required int64 stream_id;
  required int64 ts;
  required binary labels (UTF8);
  required binary line (UTF8);
  required group metadata (MAP) { repeated group key_value { required binary key (UTF8); required binary value (UTF8); } }
  optional int64 observed_ts;
  optional int32 severity_number;
  optional binary severity_text (UTF8);
  optional fixed_len_byte_array(16) trace_id;
  optional fixed_len_byte_array(8) span_id;
  optional int32 flags;
}";

/// The stream label whose value is the `service_name` column.
pub const SERVICE_NAME_LABEL: &str = "service_name";
/// The index fragment lists the file's streams only up to these bounds.
pub const FRAGMENT_MAX_STREAMS: usize = 256;
pub const FRAGMENT_MAX_LABEL_BYTES: usize = 16 * 1024;

fn logs_props(opts: &SignalWriteOptions) -> std::sync::Arc<parquet::file::properties::WriterProperties> {
    use EnabledStatistics::None as NoStats;
    let cols = vec![
        col(&["service_name"]).dict(),
        col(&["stream_id"]).delta(),
        col(&["ts"]).delta(),
        col(&["labels"]).dict().stats(NoStats),
        col(&["line"]).plain().stats(NoStats).page_bytes(LINE_PAGE_CUT_BYTES),
        col(&["metadata", "key_value", "key"]).dict().stats(NoStats),
        col(&["metadata", "key_value", "value"]).dict().stats(NoStats),
        col(&["observed_ts"]).delta(),
        col(&["severity_number"]).dict(),
        col(&["severity_text"]).dict(),
        col(&["trace_id"]).plain().bloom(),
        col(&["span_id"]).plain(),
        col(&["flags"]).dict(),
    ];
    let sorting = (0..3).map(|column_idx| SortingColumn { column_idx, descending: false, nulls_first: true }).collect();
    props(cols, sorting, opts)
}

pub(crate) struct StreamInfo<'a> {
    pub stream: &'a LogStream<&'a str>,
    pub service: &'a str,
    pub labels: String,
    pub label_bytes: usize,
}

pub(crate) struct RowRef<'a> {
    pub row: &'a LogRow<&'a str>,
    pub stream: usize,
    pub day: i64,
}

/// Turn a sealed segment's log batches (in sequence order) into Parquet files, one per UTC
/// day of `ts`, days ascending.
///
/// * Rows are sorted by `service_name`, `stream_id`, `ts`, `line`, `metadata`.
/// * Rows equal on `(stream_id, ts, line, metadata)` are one row: the later one (later batch,
///   later in its batch) supplies the other columns.
pub fn encode_logs(batches: &[&[u8]]) -> SResult<Vec<SignalFile>> {
    encode_logs_with(batches, &SignalWriteOptions::default())
}

/// [`encode_logs`] with explicit writer settings.
pub fn encode_logs_with(batches: &[&[u8]], opts: &SignalWriteOptions) -> SResult<Vec<SignalFile>> {
    let decoded: Vec<otel::LogBatch<'_>> =
        batches.iter().enumerate().map(|(index, b)| otel::decode_logs(b).map_err(|error| SignalError::Batch { index, error })).collect::<SResult<_>>()?;
    let mut streams: Vec<StreamInfo<'_>> = Vec::new();
    let mut rows: Vec<RowRef<'_>> = Vec::new();
    for b in &decoded {
        let base = streams.len();
        for s in &b.streams {
            let service = s.labels.iter().find(|(n, _)| *n == SERVICE_NAME_LABEL).map_or("", |(_, v)| v);
            let label_bytes = s.labels.iter().map(|(n, v)| n.len() + v.len()).sum();
            streams.push(StreamInfo { stream: s, service, labels: labels_to_json(&s.labels), label_bytes });
        }
        for r in &b.rows {
            rows.push(RowRef { row: r, stream: base + r.entry as usize, day: r.ts.div_euclid(NS_PER_DAY) });
        }
    }
    // Stable: equal keys keep arrival order, so the last of a run is the latest row.
    fn md<'a>(r: &LogRow<&'a str>) -> Vec<(&'a [u8], &'a [u8])> {
        r.metadata.iter().map(|(n, v)| (n.as_bytes(), v.as_bytes())).collect()
    }
    rows.sort_by(|a, b| {
        let (sa, sb) = (&streams[a.stream], &streams[b.stream]);
        (a.day, sa.service.as_bytes(), sa.stream.stream_id, a.row.ts, a.row.line.as_bytes())
            .cmp(&(b.day, sb.service.as_bytes(), sb.stream.stream_id, b.row.ts, b.row.line.as_bytes()))
            .then_with(|| md(a.row).cmp(&md(b.row)))
    });
    let same = |a: &RowRef<'_>, b: &RowRef<'_>| {
        streams[a.stream].stream.stream_id == streams[b.stream].stream.stream_id
            && a.row.ts == b.row.ts
            && a.row.line == b.row.line
            && a.row.metadata == b.row.metadata
    };
    let mut kept: Vec<RowRef<'_>> = Vec::with_capacity(rows.len());
    let n = rows.len();
    let mut it = rows.into_iter().peekable();
    while let Some(r) = it.next() {
        if it.peek().is_some_and(|next| same(&r, next)) {
            continue; // a later arrival of the same row follows
        }
        kept.push(r);
    }
    debug_assert!(kept.len() <= n);

    let mut out = Vec::new();
    let mut start = 0;
    while start < kept.len() {
        let day = kept[start].day;
        let mut end = start;
        while end < kept.len() && kept[end].day == day {
            end += 1;
        }
        out.push(write_logs_file(&kept[start..end], &streams, opts)?);
        start = end;
    }
    Ok(out)
}

/// The weight of one log row for the row-group byte cap (`contracts/LOGS.md` §4).
pub(crate) fn log_weight(row: &LogRow<&str>, label_bytes: usize) -> usize {
    64 + row.line.len() + row.severity_text.len() + row.metadata.iter().map(|(n, v)| n.len() + v.len()).sum::<usize>() + label_bytes
}

fn write_logs_file(rows: &[RowRef<'_>], streams: &[StreamInfo<'_>], opts: &SignalWriteOptions) -> SResult<SignalFile> {
    let weights: Vec<usize> = rows.iter().map(|r| log_weight(r.row, streams[r.stream].label_bytes)).collect();
    let mut w = LogsFileWriter::new(opts, false)?;
    for (a, b) in cut_groups(&weights, opts) {
        w.group(&rows[a..b], streams)?;
    }
    w.finish()
}

/// A `logs` file written one row group at a time: flush hands it the groups `cut_groups` makes
/// of a whole segment, compaction (`sigmerge.rs`) the groups it fills while it merges. The bytes
/// depend only on the rows and where the groups are cut; `tokens` adds the token filter
/// (`contracts/LOGS.md` §6), which only compaction writes.
pub(crate) struct LogsFileWriter {
    w: SerializedFileWriter<Vec<u8>>,
    index: String,
    groups_end: u64,
    min_ts: i64,
    max_ts: i64,
    rows: u64,
    groups: usize,
    first_ts: Option<i64>,
    /// Streams of the file in order: (stream_id, labels, min ts, max ts, first rg, last rg).
    file_streams: Vec<(i64, String, i64, i64, usize, usize)>,
    tokens: Option<TokenFilterBuilder>,
}

impl LogsFileWriter {
    pub(crate) fn new(opts: &SignalWriteOptions, token_filter: bool) -> SResult<LogsFileWriter> {
        Ok(LogsFileWriter {
            w: SerializedFileWriter::new(Vec::new(), schema(LOGS_SCHEMA), logs_props(opts)).map_err(perr)?,
            index: String::from("{\"v\":1,\"rg\":["),
            groups_end: 4,
            min_ts: i64::MAX,
            max_ts: i64::MIN,
            rows: 0,
            groups: 0,
            first_ts: None,
            file_streams: Vec::new(),
            tokens: token_filter.then(TokenFilterBuilder::new),
        })
    }

    pub(crate) fn rows(&self) -> u64 {
        self.rows
    }

    /// Write one row group (non-empty, rows in the file's order).
    pub(crate) fn group(&mut self, g: &[RowRef<'_>], streams: &[StreamInfo<'_>]) -> SResult<()> {
        let gi = self.groups;
        let st = |r: &RowRef<'_>| &streams[r.stream];
        let opt_i64 = |f: &dyn Fn(&LogRow<&str>) -> Option<i64>| {
            let v: Vec<i64> = g.iter().filter_map(|r| f(r.row)).collect();
            Leaf::I64(v, Levels::optional(g.iter().map(|r| f(r.row).is_some())))
        };
        let opt_i32 = |f: &dyn Fn(&LogRow<&str>) -> Option<i32>| {
            let v: Vec<i32> = g.iter().filter_map(|r| f(r.row)).collect();
            Leaf::I32(v, Levels::optional(g.iter().map(|r| f(r.row).is_some())))
        };
        let md = Levels::repeated(g.iter().map(|r| Some(r.row.metadata.len())), false);
        let tid = |r: &LogRow<&str>| (r.trace_id != [0; 16]).then_some(r.trace_id);
        let sid = |r: &LogRow<&str>| (r.span_id != [0; 8]).then_some(r.span_id);
        let leaves = vec![
            Leaf::Bytes(g.iter().map(|r| ba(st(r).service)).collect(), Levels::none()),
            Leaf::I64(g.iter().map(|r| st(r).stream.stream_id).collect(), Levels::none()),
            Leaf::I64(g.iter().map(|r| r.row.ts).collect(), Levels::none()),
            Leaf::Bytes(g.iter().map(|r| ba(&st(r).labels)).collect(), Levels::none()),
            Leaf::BytesChunked(g.iter().map(|r| ba(r.row.line)).collect(), LINE_CHUNK_BYTES),
            Leaf::Bytes(g.iter().flat_map(|r| r.row.metadata.iter().map(|(n, _)| ba(n))).collect(), md.clone()),
            Leaf::Bytes(g.iter().flat_map(|r| r.row.metadata.iter().map(|(_, v)| ba(v))).collect(), md),
            opt_i64(&|r| (r.observed_ts != 0).then_some(r.observed_ts)),
            opt_i32(&|r| (r.severity_number != 0).then_some(r.severity_number as i32)),
            {
                let v = g.iter().filter(|r| !r.row.severity_text.is_empty()).map(|r| ba(r.row.severity_text)).collect();
                Leaf::Bytes(v, Levels::optional(g.iter().map(|r| !r.row.severity_text.is_empty())))
            },
            Leaf::Fixed(g.iter().filter_map(|r| tid(r.row)).map(|t| fba(&t)).collect(), Levels::optional(g.iter().map(|r| tid(r.row).is_some()))),
            Leaf::Fixed(g.iter().filter_map(|r| sid(r.row)).map(|t| fba(&t)).collect(), Levels::optional(g.iter().map(|r| sid(r.row).is_some()))),
            opt_i32(&|r| (r.flags != 0).then_some(r.flags as i32)),
        ];
        let (off, len) = write_group(&mut self.w, leaves)?;
        self.groups_end = off + len;
        let gmin = g.iter().map(|r| r.row.ts).min().unwrap();
        let gmax = g.iter().map(|r| r.row.ts).max().unwrap();
        self.min_ts = self.min_ts.min(gmin);
        self.max_ts = self.max_ts.max(gmax);
        self.first_ts.get_or_insert(g[0].row.ts);
        self.rows += g.len() as u64;
        for r in g {
            let id = streams[r.stream].stream.stream_id;
            match self.file_streams.last_mut() {
                Some(s) if s.0 == id && s.1 == streams[r.stream].labels => {
                    s.2 = s.2.min(r.row.ts);
                    s.3 = s.3.max(r.row.ts);
                    s.5 = gi;
                }
                _ => self.file_streams.push((id, streams[r.stream].labels.clone(), r.row.ts, r.row.ts, gi, gi)),
            }
            if let Some(t) = self.tokens.as_mut() {
                t.add_text(gi, r.row.line);
                for (_, v) in &r.row.metadata {
                    t.add_text(gi, v);
                }
            }
        }
        if gi > 0 {
            self.index.push(',');
        }
        self.index.push_str(&format!("{{\"rows\":{},\"off\":{off},\"len\":{len},\"min_name\":", g.len()));
        json_str(&mut self.index, st(&g[0]).service);
        self.index.push_str(",\"max_name\":");
        json_str(&mut self.index, st(&g[g.len() - 1]).service);
        self.index.push_str(&format!(
            ",\"min_ts\":{gmin},\"max_ts\":{gmax},\"sid\":[{},{}]}}",
            st(&g[0]).stream.stream_id,
            st(&g[g.len() - 1]).stream.stream_id
        ));
        self.groups += 1;
        Ok(())
    }

    /// The token filter (when asked for and within its bound), the footer, the fragment.
    pub(crate) fn finish(mut self) -> SResult<SignalFile> {
        let first_ts = self.first_ts.ok_or_else(|| SignalError::Parquet("a logs file needs at least one row".into()))?;
        let mut tok = None;
        if let Some(filter) = self.tokens.take().and_then(|t| t.finish(self.groups)) {
            let off = self.w.bytes_written() as u64;
            self.w.write_all(&filter).map_err(|e| SignalError::Parquet(e.to_string()))?;
            self.w.append_key_value_metadata(KeyValue::new(TOKEN_FILTER_META.to_string(), format!("{off},{}", filter.len())));
            tok = Some((off, filter.len() as u64));
        }
        self.w.finish().map_err(perr)?;
        let bytes = std::mem::take(self.w.inner_mut());
        let (fo, fl) = match tok {
            Some((o, l)) => foot(o + l, bytes.len()),
            None => foot(self.groups_end, bytes.len()),
        };
        let mut index = self.index;
        index.push_str(&format!("],\"foot\":[{fo},{fl}]"));
        if let Some((o, l)) = tok {
            index.push_str(&format!(",\"tok\":[{o},{l}]"));
        }
        let label_total: usize = self.file_streams.iter().map(|s| s.1.len()).sum();
        if self.file_streams.len() <= FRAGMENT_MAX_STREAMS && label_total <= FRAGMENT_MAX_LABEL_BYTES {
            index.push_str(",\"streams\":[");
            for (k, (id, labels, lo, hi, a, b)) in self.file_streams.iter().enumerate() {
                if k > 0 {
                    index.push(',');
                }
                index.push_str(&format!("[{id},"));
                json_str(&mut index, labels);
                index.push_str(&format!(",{lo},{hi},{a},{b}]"));
            }
            index.push(']');
        }
        index.push('}');
        Ok(SignalFile { table: SignalTable::Logs, day: day_of_ns(first_ts), hour: None, bytes, rows: self.rows, min_ts: self.min_ts, max_ts: self.max_ts, index })
    }
}
