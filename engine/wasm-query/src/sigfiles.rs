//! Reading the span and log tables (`contracts/TRACES.md`, `contracts/LOGS.md`) and their
//! tail batches (`contracts/BATCH.md`, signals 2 and 3) for the read path: index fragments
//! and the file plans made from them, the Parquet readers (row group by row group, through
//! the `parquet` crate's record API, over a whole file or a sparse file container), and the
//! batch decoders. Everything here rebuilds the LOGICAL view the contracts describe; what
//! the engines see never depends on which keys were promoted or where a row lives.
//!
//! Records are owned and complete (every column of the contract), so that one reader serves
//! TraceQL (which wants the engine's `Span`), trace by ID (which wants every OTLP field) and
//! LogQL (`LogRow` plus the columns that become structured metadata).
use crate::{Fail, Res};
use bytes::Bytes;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::{Field, Row};
use serde_json::Value as J;
use viz_query::{FilePlan, FileRead, QueryError};
use viz_storage::otel::{Attr, Event, Link, Value};
use viz_storage::sparse::Source;

// ───────────────────────────── index fragments ─────────────────────────────

/// One row group of a span, `trace_index` or log fragment.
#[derive(Debug, Clone, Default)]
pub(crate) struct Rg {
    pub rows: u64,
    pub off: u64,
    pub len: u64,
    pub min_ts: i64,
    pub max_ts: i64,
    pub min_name: Option<String>,
    pub max_name: Option<String>,
    pub min_tid: Option<[u8; 16]>,
    pub max_tid: Option<[u8; 16]>,
}

/// A stream of a log file's fragment (`contracts/LOGS.md` §5).
#[derive(Debug, Clone)]
pub(crate) struct FragStream {
    pub labels: Vec<(String, String)>,
    pub min_ts: i64,
    pub max_ts: i64,
    pub first_rg: usize,
    pub last_rg: usize,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Frag {
    pub rg: Vec<Rg>,
    pub foot: Option<(u64, u64)>,
    pub streams: Option<Vec<FragStream>>,
}

pub(crate) fn unhex16(s: &str) -> Option<[u8; 16]> {
    let b = s.as_bytes();
    if b.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, o) in out.iter_mut().enumerate() {
        let hi = (b[2 * i] as char).to_digit(16)?;
        let lo = (b[2 * i + 1] as char).to_digit(16)?;
        *o = (hi * 16 + lo) as u8;
    }
    Some(out)
}

pub(crate) fn hex(b: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(2 * b.len());
    for x in b {
        s.push(D[(x >> 4) as usize] as char);
        s.push(D[(x & 15) as usize] as char);
    }
    s
}

impl Frag {
    /// Parse a fragment of any of the three tables. `None` when it is not one (the file is
    /// then read whole: a fragment that does not parse never prunes).
    pub fn parse(text: &str) -> Option<Frag> {
        let v: J = serde_json::from_str(text).ok()?;
        if v.get("v")?.as_i64()? != 1 {
            return None;
        }
        let mut rg = Vec::new();
        for g in v.get("rg")?.as_array()? {
            let tid = |k: &str| g.get(k).and_then(J::as_str).and_then(unhex16);
            rg.push(Rg {
                rows: g.get("rows")?.as_u64()?,
                off: g.get("off")?.as_u64()?,
                len: g.get("len")?.as_u64()?,
                min_ts: g.get("min_ts")?.as_i64()?,
                max_ts: g.get("max_ts")?.as_i64()?,
                min_name: g.get("min_name").and_then(J::as_str).map(str::to_string),
                max_name: g.get("max_name").and_then(J::as_str).map(str::to_string),
                min_tid: tid("min_tid"),
                max_tid: tid("max_tid"),
            });
        }
        let foot = v.get("foot").and_then(J::as_array).and_then(|f| Some((f.first()?.as_u64()?, f.get(1)?.as_u64()?)));
        let streams = match v.get("streams") {
            None => None,
            Some(list) => {
                let mut out = Vec::new();
                for s in list.as_array()? {
                    let s = s.as_array()?;
                    let labels = viz_storage::json::parse_labels(s.get(1)?.as_str()?).ok()?;
                    out.push(FragStream {
                        labels,
                        min_ts: s.get(2)?.as_i64()?,
                        max_ts: s.get(3)?.as_i64()?,
                        first_rg: s.get(4)?.as_u64()? as usize,
                        last_rg: s.get(5)?.as_u64()? as usize,
                    });
                }
                Some(out)
            }
        };
        Some(Frag { rg, foot, streams })
    }

    /// The byte ranges for these row groups and the footer, joined when less than `gap`
    /// apart (as `viz_storage::FileIndex::byte_ranges`); `None` without a footer location.
    fn byte_ranges(&self, groups: &[usize], gap: u64) -> Option<Vec<(u64, u64)>> {
        let foot = self.foot?;
        let mut r: Vec<(u64, u64)> = groups.iter().filter_map(|g| self.rg.get(*g)).map(|g| (g.off, g.len)).collect();
        r.push(foot);
        r.sort_unstable();
        let mut out: Vec<(u64, u64)> = Vec::with_capacity(r.len());
        for (o, l) in r {
            match out.last_mut() {
                Some((po, pl)) if o <= (*po + *pl).saturating_add(gap) => {
                    let end = (*po + *pl).max(o + l);
                    *pl = end - *po;
                }
                _ => out.push((o, l)),
            }
        }
        Some(out)
    }

    /// How to read the file for these row groups: skip it, read it whole (the ranges would
    /// cover half of it, or there is no footer location), or range-read. `rows` is the rows of
    /// the row groups chosen.
    pub fn decide(&self, groups: &[usize], gap: u64) -> FilePlan {
        let rows: u64 = groups.iter().filter_map(|g| self.rg.get(*g)).map(|g| g.rows).sum();
        if groups.is_empty() {
            return FilePlan { read: FileRead::Skip, rows: Some(0) };
        }
        let read = match self.byte_ranges(groups, gap) {
            Some(r) => {
                let size = self.foot.map_or(0, |(o, l)| o + l);
                let held: u64 = r.iter().map(|x| x.1).sum();
                if held.saturating_mul(2) >= size {
                    FileRead::Whole
                } else {
                    FileRead::Ranges(r)
                }
            }
            None => FileRead::Whole,
        };
        FilePlan { read, rows: Some(rows) }
    }
}

/// A fragment that does not parse: read the file whole; its rows are unknown.
pub(crate) fn unknown() -> FilePlan {
    FilePlan { read: FileRead::Whole, rows: None }
}

// ───────────────────────────── opening files ─────────────────────────────

pub(crate) fn internal(what: &str, e: impl std::fmt::Display) -> Fail {
    Fail::Query(QueryError::internal(format!("{what}: {e}")))
}

/// A file as the engine was handed it: whole, or a sparse file container of the ranges a
/// file plan read. `table` and `leaves` check that it is a file of the table it was passed as.
pub(crate) struct Opened {
    pub reader: SerializedFileReader<Source>,
    src: Source,
}

pub(crate) fn open(bytes: &[u8], table: &str, leaves: usize) -> Res<Opened> {
    let src = Source::from_bytes(Bytes::copy_from_slice(bytes), None).map_err(|e| internal(table, e))?;
    let reader = SerializedFileReader::new(src.clone()).map_err(|e| internal(table, e))?;
    let d = reader.metadata().file_metadata().schema_descr();
    if d.root_schema().name() != table || d.num_columns() != leaves {
        return Err(internal(table, format!("not a {table} file: schema {} with {} columns", d.root_schema().name(), d.num_columns())));
    }
    Ok(Opened { reader, src })
}

impl Opened {
    /// The row groups whose bytes were fetched. A row group the caller left out (its first
    /// column chunk is not held) is skipped: the file plan said it holds nothing the read
    /// needs. Any other byte a read reaches and does not have fails the read.
    pub fn held_groups(&self) -> Vec<usize> {
        let md = self.reader.metadata();
        (0..md.num_row_groups())
            .filter(|&i| {
                md.row_group(i).columns().first().is_some_and(|c| {
                    let (o, l) = c.byte_range();
                    self.src.has(o, l)
                })
            })
            .collect()
    }

    /// Visit the rows of row group `g`, one at a time (never the whole group as rows).
    pub fn rows(&self, g: usize, table: &str, mut visit: impl FnMut(&Row) -> Res<()>) -> Res<()> {
        let rg = self.reader.get_row_group(g).map_err(|e| internal(table, e))?;
        for row in rg.get_row_iter(None).map_err(|e| internal(table, e))? {
            visit(&row.map_err(|e| internal(table, e))?)?;
        }
        Ok(())
    }
}

// ───────────────────────────── record fields ─────────────────────────────

fn bad<T>(m: impl Into<String>) -> Res<T> {
    Err(Fail::Query(QueryError::internal(m.into())))
}

fn get<'a>(row: &'a Row, name: &str) -> Res<&'a Field> {
    match row.get_column_iter().find(|(n, _)| n.as_str() == name) {
        Some((_, f)) => Ok(f),
        None => bad(format!("missing column {name}")),
    }
}
fn s(f: &Field, what: &str) -> Res<String> {
    match f {
        Field::Str(v) => Ok(v.clone()),
        _ => bad(format!("{what}: expected a string")),
    }
}
fn os(f: &Field, what: &str) -> Res<Option<String>> {
    match f {
        Field::Null => Ok(None),
        _ => s(f, what).map(Some),
    }
}
fn l(f: &Field, what: &str) -> Res<i64> {
    match f {
        Field::Long(v) => Ok(*v),
        Field::TimestampMicros(v) => Ok(*v),
        _ => bad(format!("{what}: expected an int64")),
    }
}
fn ol(f: &Field, what: &str) -> Res<Option<i64>> {
    match f {
        Field::Null => Ok(None),
        _ => l(f, what).map(Some),
    }
}
fn i(f: &Field, what: &str) -> Res<i32> {
    match f {
        Field::Int(v) => Ok(*v),
        _ => bad(format!("{what}: expected an int32")),
    }
}
fn oi(f: &Field, what: &str) -> Res<Option<i32>> {
    match f {
        Field::Null => Ok(None),
        _ => i(f, what).map(Some),
    }
}
fn fixed<const N: usize>(f: &Field, what: &str) -> Res<[u8; N]> {
    match f {
        Field::Bytes(b) if b.len() == N => {
            let mut out = [0u8; N];
            out.copy_from_slice(b.data());
            Ok(out)
        }
        _ => bad(format!("{what}: expected {N} bytes")),
    }
}
fn ofixed<const N: usize>(f: &Field, what: &str) -> Res<Option<[u8; N]>> {
    match f {
        Field::Null => Ok(None),
        _ => fixed::<N>(f, what).map(Some),
    }
}
fn list<'a>(f: &'a Field, what: &str) -> Res<&'a [Field]> {
    match f {
        Field::Null => Ok(&[]),
        Field::ListInternal(l) => Ok(l.elements()),
        _ => bad(format!("{what}: expected a list")),
    }
}
fn group<'a>(f: &'a Field, what: &str) -> Res<&'a Row> {
    match f {
        Field::Group(r) => Ok(r),
        _ => bad(format!("{what}: expected a struct")),
    }
}
fn map<'a>(f: &'a Field, what: &str) -> Res<Vec<(String, &'a Field)>> {
    match f {
        Field::Null => Ok(Vec::new()),
        Field::MapInternal(m) => m.entries().iter().map(|(k, v)| Ok((s(k, what)?, v))).collect(),
        _ => bad(format!("{what}: expected a map")),
    }
}

/// End (exclusive) of the JSON string starting at `at`.
fn string_end(b: &[u8], at: usize) -> Res<usize> {
    if b.get(at) != Some(&b'"') {
        return bad("expected a string");
    }
    let mut k = at + 1;
    while k < b.len() {
        match b[k] {
            b'\\' => k += 2,
            b'"' => return Ok(k + 1),
            _ => k += 1,
        }
    }
    bad("unterminated string")
}

/// End (exclusive) of the JSON object or array starting at `at`.
fn value_end(b: &[u8], at: usize) -> Res<usize> {
    let mut depth = 0i32;
    let mut k = at;
    while k < b.len() {
        match b[k] {
            b'"' => {
                k = string_end(b, k)?;
                continue;
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(k + 1);
                }
            }
            _ => {}
        }
        k += 1;
    }
    bad("unterminated value")
}

/// A canonical OTLP JSON key-value list (`[{"key":K,"value":V},…]`) as `(key, V's text)`,
/// V cut out of the text as it is (so its bytes stay canonical).
pub(crate) fn kv_texts(json: &str) -> Res<Vec<(String, String)>> {
    let b = json.as_bytes();
    let mut out = Vec::new();
    if b.first() != Some(&b'[') || b.last() != Some(&b']') {
        return bad("attributes: not a list");
    }
    let mut at = 1usize;
    while at < b.len() - 1 {
        if b[at] == b',' {
            at += 1;
        }
        let head = "{\"key\":";
        if !json[at..].starts_with(head) {
            return bad("attributes: bad entry");
        }
        at += head.len();
        let key_end = string_end(b, at)?;
        let key: String = serde_json::from_str(&json[at..key_end]).map_err(|e| internal("attribute key", e))?;
        at = key_end;
        let mid = ",\"value\":";
        if !json[at..].starts_with(mid) {
            return bad("attributes: bad entry");
        }
        at += mid.len();
        let v_end = value_end(b, at)?;
        out.push((key, json[at..v_end].to_string()));
        at = v_end;
        if b.get(at) != Some(&b'}') {
            return bad("attributes: bad entry end");
        }
        at += 1;
    }
    Ok(out)
}

/// Promoted columns and the five residual maps of one scope, as one list sorted by key
/// (`contracts/TRACES.md`, "Logical view").
fn logical(row: &Row, scope: &str, promoted: &[(&str, &str)], what: &str) -> Res<Vec<Attr<String>>> {
    let mut out: Vec<Attr<String>> = Vec::new();
    for (column, key) in promoted {
        match get(row, column)? {
            Field::Null => {}
            Field::Str(v) => out.push(Attr { key: key.to_string(), value: Value::Str(v.clone()) }),
            Field::Long(v) => out.push(Attr { key: key.to_string(), value: Value::Int(*v) }),
            _ => return bad(format!("{column}: unexpected value")),
        }
    }
    for (k, v) in map(get(row, &format!("{scope}_attrs_str"))?, what)? {
        out.push(Attr { key: k, value: Value::Str(s(v, what)?) });
    }
    for (k, v) in map(get(row, &format!("{scope}_attrs_int"))?, what)? {
        out.push(Attr { key: k, value: Value::Int(l(v, what)?) });
    }
    for (k, v) in map(get(row, &format!("{scope}_attrs_dbl"))?, what)? {
        match v {
            Field::Double(d) => out.push(Attr { key: k, value: Value::Double(d.to_bits()) }),
            _ => return bad(format!("{what}: expected a double")),
        }
    }
    for (k, v) in map(get(row, &format!("{scope}_attrs_bool"))?, what)? {
        match v {
            Field::Bool(b) => out.push(Attr { key: k, value: Value::Bool(*b) }),
            _ => return bad(format!("{what}: expected a bool")),
        }
    }
    if let Some(o) = os(get(row, &format!("{scope}_attrs_other"))?, what)? {
        for (k, v) in kv_texts(&o)? {
            out.push(Attr { key: k, value: Value::Other(v) });
        }
    }
    out.sort_by(|a, b| a.key.as_bytes().cmp(b.key.as_bytes()));
    Ok(out)
}

// ───────────────────────────── spans ─────────────────────────────

/// One span, every column of `contracts/TRACES.md` in its logical form.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SpanRec {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub parent: Option<[u8; 8]>,
    pub trace_state: String,
    pub flags: u32,
    pub start: i64,
    pub end: i64,
    pub name: String,
    pub kind: u8,
    pub status: u8,
    pub status_message: String,
    /// Every resource attribute (promoted ones included), sorted by key.
    pub resource: Vec<Attr<String>>,
    pub scope_name: String,
    pub scope_version: String,
    /// Canonical OTLP JSON key-value list, `""` when none.
    pub scope_attrs: String,
    pub attrs: Vec<Attr<String>>,
    pub events: Vec<Event<String>>,
    pub links: Vec<Link<String>>,
    pub dropped: [u32; 3],
}

/// Columns of a `spans` file (flush files; the nested-set columns of `TRACES.md` are not written).
pub(crate) const SPANS_LEAVES: usize = 57;
pub(crate) const TRACE_INDEX_LEAVES: usize = 14;
pub(crate) const LOGS_LEAVES: usize = 13;

fn span_from_row(r: &Row) -> Res<SpanRec> {
    let mut promoted_res: Vec<(&str, &str)> = vec![("service_name", "service.name")];
    promoted_res.extend(viz_storage::PROMOTED_RESOURCE.iter().copied());
    let promoted_span: Vec<(&str, &str)> = viz_storage::PROMOTED_SPAN.iter().map(|(c, k, _)| (*c, *k)).collect();
    let events = list(get(r, "events")?, "events")?
        .iter()
        .map(|e| {
            let g = group(e, "event")?;
            Ok(Event { time_unix_nano: l(get(g, "time_unix_nano")?, "event time")?, name: s(get(g, "name")?, "event name")?, attrs: s(get(g, "attrs")?, "event attrs")? })
        })
        .collect::<Res<Vec<_>>>()?;
    let links = list(get(r, "links")?, "links")?
        .iter()
        .map(|e| {
            let g = group(e, "link")?;
            Ok(Link {
                trace_id: fixed::<16>(get(g, "trace_id")?, "link trace_id")?,
                span_id: fixed::<8>(get(g, "span_id")?, "link span_id")?,
                trace_state: s(get(g, "trace_state")?, "link trace_state")?,
                attrs: s(get(g, "attrs")?, "link attrs")?,
            })
        })
        .collect::<Res<Vec<_>>>()?;
    let count = |c: &str| -> Res<u32> { Ok(oi(get(r, c)?, c)?.unwrap_or(0) as u32) };
    Ok(SpanRec {
        trace_id: fixed::<16>(get(r, "trace_id")?, "trace_id")?,
        span_id: fixed::<8>(get(r, "span_id")?, "span_id")?,
        parent: ofixed::<8>(get(r, "parent_span_id")?, "parent_span_id")?,
        trace_state: os(get(r, "trace_state")?, "trace_state")?.unwrap_or_default(),
        flags: oi(get(r, "flags")?, "flags")?.unwrap_or(0) as u32,
        start: l(get(r, "start_unix_nano")?, "start")?,
        end: l(get(r, "end_unix_nano")?, "end")?,
        name: s(get(r, "span_name")?, "span_name")?,
        kind: i(get(r, "span_kind")?, "span_kind")? as u8,
        status: i(get(r, "status_code")?, "status_code")? as u8,
        status_message: os(get(r, "status_message")?, "status_message")?.unwrap_or_default(),
        resource: logical(r, "resource", &promoted_res, "resource attributes")?,
        scope_name: os(get(r, "scope_name")?, "scope_name")?.unwrap_or_default(),
        scope_version: os(get(r, "scope_version")?, "scope_version")?.unwrap_or_default(),
        scope_attrs: os(get(r, "scope_attrs")?, "scope_attrs")?.unwrap_or_default(),
        attrs: logical(r, "span", &promoted_span, "span attributes")?,
        events,
        links,
        dropped: [count("dropped_attributes_count")?, count("dropped_events_count")?, count("dropped_links_count")?],
    })
}

/// Every span of the held row groups of a `spans` file, in file order, to `visit`.
pub(crate) fn read_spans(bytes: &[u8], mut visit: impl FnMut(SpanRec) -> Res<()>) -> Res<u64> {
    let f = open(bytes, "spans", SPANS_LEAVES)?;
    let mut n = 0u64;
    for g in f.held_groups() {
        f.rows(g, "spans", |r| {
            n += 1;
            visit(span_from_row(r)?)
        })?;
    }
    Ok(n)
}

/// The spans of a `VZB1` signal-2 batch, in row order.
pub(crate) fn batch_spans(bytes: &[u8], mut visit: impl FnMut(SpanRec) -> Res<()>) -> Res<u64> {
    let b = viz_storage::otel::decode_spans(bytes).map_err(|e| internal("span batch", e))?;
    for r in &b.rows {
        let e = b.entries.get(r.entry as usize).ok_or_else(|| internal("span batch", "entry out of range"))?;
        visit(SpanRec {
            trace_id: r.trace_id,
            span_id: r.span_id,
            parent: r.parent(),
            trace_state: r.trace_state.to_string(),
            flags: r.flags,
            start: r.start,
            end: r.end,
            name: r.name.to_string(),
            kind: r.kind,
            status: r.status,
            status_message: r.status_message.to_string(),
            resource: e.resource.iter().map(Attr::to_owned_attr).collect(),
            scope_name: e.scope_name.to_string(),
            scope_version: e.scope_version.to_string(),
            scope_attrs: e.scope_attrs.to_string(),
            attrs: r.attrs.iter().map(Attr::to_owned_attr).collect(),
            events: r.events.iter().map(|x| Event { time_unix_nano: x.time_unix_nano, name: x.name.to_string(), attrs: x.attrs.to_string() }).collect(),
            links: r.links.iter().map(|x| Link { trace_id: x.trace_id, span_id: x.span_id, trace_state: x.trace_state.to_string(), attrs: x.attrs.to_string() }).collect(),
            dropped: r.dropped,
        })?;
    }
    Ok(b.rows.len() as u64)
}

/// Every `trace_index` row (fragment) of the held row groups, to `visit`.
pub(crate) fn read_trace_index(bytes: &[u8], mut visit: impl FnMut(viz_storage::Fragment) -> Res<()>) -> Res<u64> {
    let f = open(bytes, "trace_index", TRACE_INDEX_LEAVES)?;
    let mut n = 0u64;
    for g in f.held_groups() {
        f.rows(g, "trace_index", |r| {
            n += 1;
            let root = match os(get(r, "root_span_name")?, "root_span_name")? {
                None => None,
                Some(name) => Some((
                    os(get(r, "root_service_name")?, "root_service_name")?,
                    name,
                    l(get(r, "root_start_unix_nano")?, "root_start")?,
                    fixed::<8>(get(r, "root_span_id")?, "root_span_id")?,
                )),
            };
            let services = list(get(r, "services")?, "services")?
                .iter()
                .map(|e| {
                    let g = group(e, "service")?;
                    Ok((s(get(g, "name")?, "service name")?, i(get(g, "spans")?, "spans")?, i(get(g, "errors")?, "errors")?))
                })
                .collect::<Res<Vec<_>>>()?;
            let hours = list(get(r, "hours")?, "hours")?.iter().map(|h| i(h, "hour")).collect::<Res<Vec<_>>>()?;
            visit(viz_storage::Fragment {
                trace_id: fixed::<16>(get(r, "trace_id")?, "trace_id")?,
                min_start: l(get(r, "min_start_unix_nano")?, "min_start")?,
                max_end: l(get(r, "max_end_unix_nano")?, "max_end")?,
                span_count: i(get(r, "span_count")?, "span_count")?,
                error_count: i(get(r, "error_count")?, "error_count")?,
                root,
                services,
                services_truncated: matches!(get(r, "services_truncated")?, Field::Bool(true)),
                hours,
            })
        })?;
    }
    Ok(n)
}

// ───────────────────────────── logs ─────────────────────────────

/// One log record, every column of `contracts/LOGS.md` §2.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LogRec {
    pub stream_id: i64,
    /// Shared by every row of the stream (read once per distinct `labels` text or batch entry).
    pub labels: std::rc::Rc<Vec<(String, String)>>,
    pub ts: i64,
    pub line: String,
    pub metadata: Vec<(String, String)>,
    pub observed_ts: Option<i64>,
    pub severity_number: Option<i32>,
    pub severity_text: Option<String>,
    pub trace_id: Option<[u8; 16]>,
    pub span_id: Option<[u8; 8]>,
    pub flags: Option<u32>,
}

impl LogRec {
    /// What LogQL sees as the row's structured metadata (`contracts/LOGS.md` §3): `metadata`,
    /// plus the OTLP columns that are present under their names; a `metadata` key wins; sorted.
    pub fn logql_metadata(&self) -> Vec<(String, String)> {
        let mut m: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
        if let Some(t) = self.trace_id {
            m.insert("trace_id".into(), hex(&t));
        }
        if let Some(t) = self.span_id {
            m.insert("span_id".into(), hex(&t));
        }
        if let Some(t) = &self.severity_text {
            m.insert("severity_text".into(), t.clone());
        }
        if let Some(n) = self.severity_number {
            m.insert("severity_number".into(), n.to_string());
        }
        if let Some(o) = self.observed_ts {
            m.insert("observed_timestamp".into(), o.to_string());
        }
        if let Some(f) = self.flags {
            m.insert("flags".into(), f.to_string());
        }
        for (k, v) in &self.metadata {
            m.insert(k.clone(), v.clone());
        }
        // BTreeMap order is byte order for `String` keys.
        m.into_iter().collect()
    }
}

/// Every record of the held row groups of a `logs` file, in file order, to `visit`.
pub(crate) fn read_logs(bytes: &[u8], mut visit: impl FnMut(LogRec) -> Res<()>) -> Res<u64> {
    let f = open(bytes, "logs", LOGS_LEAVES)?;
    let mut n = 0u64;
    // A row group stores each stream's labels once (dictionary); parse each distinct text once.
    let mut last: (String, std::rc::Rc<Vec<(String, String)>>) = (String::new(), std::rc::Rc::new(Vec::new()));
    for g in f.held_groups() {
        f.rows(g, "logs", |r| {
            n += 1;
            let text = s(get(r, "labels")?, "labels")?;
            if text != last.0 {
                let parsed = viz_storage::json::parse_labels(&text).map_err(|e| internal("labels", e))?;
                last = (text, std::rc::Rc::new(parsed));
            }
            let metadata = map(get(r, "metadata")?, "metadata")?.into_iter().map(|(k, v)| Ok((k, s(v, "metadata value")?))).collect::<Res<Vec<_>>>()?;
            visit(LogRec {
                stream_id: l(get(r, "stream_id")?, "stream_id")?,
                labels: std::rc::Rc::clone(&last.1),
                ts: l(get(r, "ts")?, "ts")?,
                line: s(get(r, "line")?, "line")?,
                metadata,
                observed_ts: ol(get(r, "observed_ts")?, "observed_ts")?,
                severity_number: oi(get(r, "severity_number")?, "severity_number")?,
                severity_text: os(get(r, "severity_text")?, "severity_text")?,
                trace_id: ofixed::<16>(get(r, "trace_id")?, "trace_id")?,
                span_id: ofixed::<8>(get(r, "span_id")?, "span_id")?,
                flags: oi(get(r, "flags")?, "flags")?.map(|x| x as u32),
            })
        })?;
    }
    Ok(n)
}

/// The records of a `VZB1` signal-3 batch, in row order.
pub(crate) fn batch_logs(bytes: &[u8], mut visit: impl FnMut(LogRec) -> Res<()>) -> Res<u64> {
    let b = viz_storage::otel::decode_logs(bytes).map_err(|e| internal("log batch", e))?;
    let streams: Vec<std::rc::Rc<Vec<(String, String)>>> = b.streams.iter().map(|s| std::rc::Rc::new(s.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect())).collect();
    for r in &b.rows {
        let st = b.streams.get(r.entry as usize).ok_or_else(|| internal("log batch", "entry out of range"))?;
        visit(LogRec {
            stream_id: st.stream_id,
            labels: std::rc::Rc::clone(&streams[r.entry as usize]),
            ts: r.ts,
            line: r.line.to_string(),
            metadata: r.metadata.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            observed_ts: (r.observed_ts != 0).then_some(r.observed_ts),
            severity_number: (r.severity_number != 0).then_some(r.severity_number as i32),
            severity_text: (!r.severity_text.is_empty()).then(|| r.severity_text.to_string()),
            trace_id: (r.trace_id != [0; 16]).then_some(r.trace_id),
            span_id: (r.span_id != [0; 8]).then_some(r.span_id),
            flags: (r.flags != 0).then_some(r.flags),
        })?;
    }
    Ok(b.rows.len() as u64)
}

/// The stream table of a `VZB1` signal-3 batch, and each stream's first and last `ts`
/// (streams without a row in the batch are left out).
pub(crate) fn batch_streams(bytes: &[u8]) -> Res<Vec<(Vec<(String, String)>, i64, i64)>> {
    let b = viz_storage::otel::decode_logs(bytes).map_err(|e| internal("log batch", e))?;
    let mut span: Vec<Option<(i64, i64)>> = vec![None; b.streams.len()];
    for r in &b.rows {
        let e = &mut span[r.entry as usize];
        *e = Some(match e {
            None => (r.ts, r.ts),
            Some((lo, hi)) => ((*lo).min(r.ts), (*hi).max(r.ts)),
        });
    }
    Ok(b.streams
        .iter()
        .zip(span)
        .filter_map(|(s, sp)| sp.map(|(lo, hi)| (s.labels.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect(), lo, hi)))
        .collect())
}

/// Streams of the held row groups of a `logs` file, read from the `labels` and `ts` columns
/// only (for files whose fragment has no stream list): labels with first and last `ts`.
pub(crate) fn file_streams(bytes: &[u8]) -> Res<Vec<(Vec<(String, String)>, i64, i64)>> {
    let f = open(bytes, "logs", LOGS_LEAVES)?;
    let schema = f.reader.metadata().file_metadata().schema_descr();
    let fields: Vec<parquet::schema::types::TypePtr> = schema.root_schema().get_fields().iter().filter(|t| t.name() == "labels" || t.name() == "ts").cloned().collect();
    let projection = parquet::schema::types::Type::group_type_builder("logs").with_fields(fields).build().map_err(|e| internal("logs", e))?;
    let mut by: std::collections::BTreeMap<String, (i64, i64)> = std::collections::BTreeMap::new();
    for g in f.held_groups() {
        let rg = f.reader.get_row_group(g).map_err(|e| internal("logs", e))?;
        for row in rg.get_row_iter(Some(projection.clone())).map_err(|e| internal("logs", e))? {
            let row = row.map_err(|e| internal("logs", e))?;
            let text = s(get(&row, "labels")?, "labels")?;
            let ts = l(get(&row, "ts")?, "ts")?;
            let e = by.entry(text).or_insert((ts, ts));
            e.0 = e.0.min(ts);
            e.1 = e.1.max(ts);
        }
    }
    by.into_iter().map(|(t, (lo, hi))| Ok((viz_storage::json::parse_labels(&t).map_err(|e| internal("labels", e))?, lo, hi))).collect()
}
