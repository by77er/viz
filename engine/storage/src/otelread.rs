//! Readers for the `spans`, `trace_index` and `logs` files, through the `parquet` crate's
//! record API (a different code path from the column writers in `spans.rs` and `logs.rs`).
//! They rebuild the logical view `contracts/TRACES.md` and `LOGS.md` describe: promoted
//! columns and residual maps become one typed list again. Whole files, whole rows: for
//! tests, tools and small reads; the query path's reader (stage 2) is not this.
use crate::otel::{Attr, Event, Link, Value};
use crate::otelpq::{perr, SResult, SignalError};
use crate::spans::{Fragment, PROMOTED_RESOURCE, PROMOTED_SPAN, SERVICE_NAME_KEY};
use bytes::Bytes;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::{Field, Row};

/// One `spans` row, logical view plus the physical columns a check may want.
#[derive(Debug, Clone, PartialEq)]
pub struct SpanRecord {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub parent_span_id: Option<[u8; 8]>,
    pub trace_state: Option<String>,
    pub flags: Option<i32>,
    pub start_unix_nano: i64,
    pub end_unix_nano: i64,
    pub duration_nano: i64,
    pub start_time_us: i64,
    pub service_name: Option<String>,
    pub span_name: String,
    pub span_kind: i32,
    pub status_code: i32,
    pub status_message: Option<String>,
    pub scope_name: Option<String>,
    pub scope_version: Option<String>,
    pub resource_fp: i64,
    /// Every resource attribute (promoted ones included), sorted by key.
    pub resource: Vec<Attr<String>>,
    /// Every span attribute (promoted ones included), sorted by key.
    pub attrs: Vec<Attr<String>>,
    pub scope_attrs: Option<String>,
    pub events: Vec<Event<String>>,
    pub links: Vec<Link<String>>,
    pub dropped: [Option<i32>; 3],
}

/// One `logs` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogRecord {
    pub service_name: String,
    pub stream_id: i64,
    pub ts: i64,
    /// The `labels` cell as stored (canonical JSON).
    pub labels_json: String,
    /// The same, parsed, sorted by name.
    pub labels: Vec<(String, String)>,
    pub line: String,
    pub metadata: Vec<(String, String)>,
    pub observed_ts: Option<i64>,
    pub severity_number: Option<i32>,
    pub severity_text: Option<String>,
    pub trace_id: Option<[u8; 16]>,
    pub span_id: Option<[u8; 8]>,
    pub flags: Option<i32>,
}

fn bad<T>(m: impl Into<String>) -> SResult<T> {
    Err(SignalError::Parquet(m.into()))
}

fn rows(bytes: &[u8], table: &str, leaves: usize) -> SResult<Vec<Row>> {
    rows_of(bytes, table, leaves, None)
}

/// Rows of the whole file, or of the row groups `groups` (in the order given).
fn rows_of(bytes: &[u8], table: &str, leaves: usize, groups: Option<&[usize]>) -> SResult<Vec<Row>> {
    let r = SerializedFileReader::new(Bytes::copy_from_slice(bytes)).map_err(perr)?;
    let d = r.metadata().file_metadata().schema_descr();
    if d.root_schema().name() != table || d.num_columns() != leaves {
        return bad(format!("not a {table} file: schema {} with {} columns", d.root_schema().name(), d.num_columns()));
    }
    match groups {
        None => r.get_row_iter(None).map_err(perr)?.map(|x| x.map_err(perr)).collect(),
        Some(gs) => {
            let mut out = Vec::new();
            for &g in gs {
                if g >= r.num_row_groups() {
                    return bad(format!("row group {g} of {}", r.num_row_groups()));
                }
                let rg = r.get_row_group(g).map_err(perr)?;
                for x in rg.get_row_iter(None).map_err(perr)? {
                    out.push(x.map_err(perr)?);
                }
            }
            Ok(out)
        }
    }
}

fn get<'a>(row: &'a Row, name: &str) -> SResult<&'a Field> {
    match row.get_column_iter().find(|(n, _)| n.as_str() == name) {
        Some((_, f)) => Ok(f),
        None => bad(format!("missing column {name}")),
    }
}

fn s(f: &Field, what: &str) -> SResult<String> {
    match f {
        Field::Str(v) => Ok(v.clone()),
        _ => bad(format!("{what}: expected a string, got {f:?}")),
    }
}
fn os(f: &Field, what: &str) -> SResult<Option<String>> {
    match f {
        Field::Null => Ok(None),
        _ => s(f, what).map(Some),
    }
}
fn l(f: &Field, what: &str) -> SResult<i64> {
    match f {
        Field::Long(v) => Ok(*v),
        Field::TimestampMicros(v) => Ok(*v),
        _ => bad(format!("{what}: expected an int64, got {f:?}")),
    }
}
fn ol(f: &Field, what: &str) -> SResult<Option<i64>> {
    match f {
        Field::Null => Ok(None),
        _ => l(f, what).map(Some),
    }
}
fn i(f: &Field, what: &str) -> SResult<i32> {
    match f {
        Field::Int(v) => Ok(*v),
        _ => bad(format!("{what}: expected an int32, got {f:?}")),
    }
}
fn oi(f: &Field, what: &str) -> SResult<Option<i32>> {
    match f {
        Field::Null => Ok(None),
        _ => i(f, what).map(Some),
    }
}
fn fixed<const N: usize>(f: &Field, what: &str) -> SResult<[u8; N]> {
    match f {
        Field::Bytes(b) if b.len() == N => Ok(b.data().try_into().unwrap()),
        _ => bad(format!("{what}: expected {N} bytes, got {f:?}")),
    }
}
fn ofixed<const N: usize>(f: &Field, what: &str) -> SResult<Option<[u8; N]>> {
    match f {
        Field::Null => Ok(None),
        _ => fixed::<N>(f, what).map(Some),
    }
}
fn list<'a>(f: &'a Field, what: &str) -> SResult<&'a [Field]> {
    match f {
        Field::Null => Ok(&[]),
        Field::ListInternal(l) => Ok(l.elements()),
        _ => bad(format!("{what}: expected a list, got {f:?}")),
    }
}
fn group<'a>(f: &'a Field, what: &str) -> SResult<&'a Row> {
    match f {
        Field::Group(r) => Ok(r),
        _ => bad(format!("{what}: expected a struct, got {f:?}")),
    }
}
/// A map's entries as (key, value field), in file order; null and empty are both empty.
fn map<'a>(f: &'a Field, what: &str) -> SResult<Vec<(String, &'a Field)>> {
    match f {
        Field::Null => Ok(Vec::new()),
        Field::MapInternal(m) => m.entries().iter().map(|(k, v)| Ok((s(k, what)?, v))).collect(),
        _ => bad(format!("{what}: expected a map, got {f:?}")),
    }
}

/// Parse a canonical OTLP JSON key-value list of "other" values back into `(key, value
/// JSON)` pairs.
fn other_list(json: &str) -> SResult<Vec<(String, String)>> {
    // The list is `[{"key":K,"value":V},…]` with V a canonical JSON object. Parse with the
    // crate's JSON reader for the keys, and cut V out of the text by bracket matching.
    let b = json.as_bytes();
    let mut out = Vec::new();
    let mut at = 1usize;
    if b.first() != Some(&b'[') || b.last() != Some(&b']') {
        return bad("other attributes: not a list");
    }
    while at < b.len() - 1 {
        if b[at] == b',' {
            at += 1;
        }
        let head = "{\"key\":";
        if !json[at..].starts_with(head) {
            return bad("other attributes: bad entry");
        }
        at += head.len();
        let key_end = string_end(b, at)?;
        let key = match crate::json::parse(&json[at..key_end])? {
            crate::json::Value::String(k) => k,
            _ => return bad("other attributes: bad key"),
        };
        at = key_end;
        let mid = ",\"value\":";
        if !json[at..].starts_with(mid) {
            return bad("other attributes: bad entry");
        }
        at += mid.len();
        let v_end = value_end(b, at)?;
        out.push((key, json[at..v_end].to_string()));
        at = v_end;
        if b.get(at) != Some(&b'}') {
            return bad("other attributes: bad entry end");
        }
        at += 1;
    }
    Ok(out)
}

impl From<crate::error::Error> for SignalError {
    fn from(e: crate::error::Error) -> Self {
        SignalError::Parquet(e.to_string())
    }
}

/// End (exclusive) of the JSON string starting at `at`.
fn string_end(b: &[u8], at: usize) -> SResult<usize> {
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
fn value_end(b: &[u8], at: usize) -> SResult<usize> {
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

/// Merge promoted columns and the five residual maps of one scope into one sorted list.
fn logical(row: &Row, scope: &str, promoted: &[(&str, &str)], what: &str) -> SResult<Vec<Attr<String>>> {
    let mut out: Vec<Attr<String>> = Vec::new();
    for (column, key) in promoted {
        match get(row, column)? {
            Field::Null => {}
            Field::Str(v) => out.push(Attr { key: key.to_string(), value: Value::Str(v.clone()) }),
            Field::Long(v) => out.push(Attr { key: key.to_string(), value: Value::Int(*v) }),
            f => return bad(format!("{column}: unexpected {f:?}")),
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
        for (k, v) in other_list(&o)? {
            out.push(Attr { key: k, value: Value::Other(v) });
        }
    }
    out.sort_by(|a, b| a.key.as_bytes().cmp(b.key.as_bytes()));
    for w in out.windows(2) {
        if w[0].key == w[1].key {
            return bad(format!("{what}: key {:?} twice", w[0].key));
        }
    }
    Ok(out)
}

/// Read every row of a `spans` file, in file order.
pub fn read_spans(bytes: &[u8]) -> SResult<Vec<SpanRecord>> {
    let leaves = 57;
    let mut promoted_res: Vec<(&str, &str)> = vec![("service_name", SERVICE_NAME_KEY)];
    promoted_res.extend(PROMOTED_RESOURCE.iter().copied());
    let promoted_span: Vec<(&str, &str)> = PROMOTED_SPAN.iter().map(|(c, k, _)| (*c, *k)).collect();
    rows(bytes, "spans", leaves)?
        .iter()
        .map(|r| {
            let events = list(get(r, "events")?, "events")?
                .iter()
                .map(|e| {
                    let g = group(e, "event")?;
                    Ok(Event { time_unix_nano: l(get(g, "time_unix_nano")?, "event time")?, name: s(get(g, "name")?, "event name")?, attrs: s(get(g, "attrs")?, "event attrs")? })
                })
                .collect::<SResult<Vec<_>>>()?;
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
                .collect::<SResult<Vec<_>>>()?;
            Ok(SpanRecord {
                trace_id: fixed::<16>(get(r, "trace_id")?, "trace_id")?,
                span_id: fixed::<8>(get(r, "span_id")?, "span_id")?,
                parent_span_id: ofixed::<8>(get(r, "parent_span_id")?, "parent_span_id")?,
                trace_state: os(get(r, "trace_state")?, "trace_state")?,
                flags: oi(get(r, "flags")?, "flags")?,
                start_unix_nano: l(get(r, "start_unix_nano")?, "start")?,
                end_unix_nano: l(get(r, "end_unix_nano")?, "end")?,
                duration_nano: l(get(r, "duration_nano")?, "duration")?,
                start_time_us: l(get(r, "start_time")?, "start_time")?,
                service_name: os(get(r, "service_name")?, "service_name")?,
                span_name: s(get(r, "span_name")?, "span_name")?,
                span_kind: i(get(r, "span_kind")?, "span_kind")?,
                status_code: i(get(r, "status_code")?, "status_code")?,
                status_message: os(get(r, "status_message")?, "status_message")?,
                scope_name: os(get(r, "scope_name")?, "scope_name")?,
                scope_version: os(get(r, "scope_version")?, "scope_version")?,
                resource_fp: l(get(r, "resource_fp")?, "resource_fp")?,
                resource: logical(r, "resource", &promoted_res, "resource attributes")?,
                attrs: logical(r, "span", &promoted_span, "span attributes")?,
                scope_attrs: os(get(r, "scope_attrs")?, "scope_attrs")?,
                events,
                links,
                dropped: [
                    oi(get(r, "dropped_attributes_count")?, "dropped")?,
                    oi(get(r, "dropped_events_count")?, "dropped")?,
                    oi(get(r, "dropped_links_count")?, "dropped")?,
                ],
            })
        })
        .collect()
}

/// Read every row of a `trace_index` file, in file order.
pub fn read_trace_index(bytes: &[u8]) -> SResult<Vec<Fragment>> {
    rows(bytes, "trace_index", 14)?
        .iter()
        .map(|r| {
            let root_name = os(get(r, "root_span_name")?, "root_span_name")?;
            let root = match root_name {
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
                .collect::<SResult<Vec<_>>>()?;
            let hours = list(get(r, "hours")?, "hours")?.iter().map(|h| i(h, "hour")).collect::<SResult<Vec<_>>>()?;
            Ok(Fragment {
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
        })
        .collect()
}

/// Read every row of a `logs` file, in file order.
pub fn read_logs(bytes: &[u8]) -> SResult<Vec<LogRecord>> {
    logs_from(rows(bytes, "logs", 13)?)
}

/// Read the rows of row groups `groups` of a `logs` file (a reader that pruned by the index
/// fragment), in the order given.
pub fn read_logs_row_groups(bytes: &[u8], groups: &[usize]) -> SResult<Vec<LogRecord>> {
    logs_from(rows_of(bytes, "logs", 13, Some(groups))?)
}

fn logs_from(rows: Vec<Row>) -> SResult<Vec<LogRecord>> {
    rows
        .iter()
        .map(|r| {
            let labels_json = s(get(r, "labels")?, "labels")?;
            let labels = crate::json::parse_labels(&labels_json)?;
            let metadata = map(get(r, "metadata")?, "metadata")?.into_iter().map(|(k, v)| Ok((k, s(v, "metadata value")?))).collect::<SResult<Vec<_>>>()?;
            Ok(LogRecord {
                service_name: s(get(r, "service_name")?, "service_name")?,
                stream_id: l(get(r, "stream_id")?, "stream_id")?,
                ts: l(get(r, "ts")?, "ts")?,
                labels_json,
                labels,
                line: s(get(r, "line")?, "line")?,
                metadata,
                observed_ts: ol(get(r, "observed_ts")?, "observed_ts")?,
                severity_number: oi(get(r, "severity_number")?, "severity_number")?,
                severity_text: os(get(r, "severity_text")?, "severity_text")?,
                trace_id: ofixed::<16>(get(r, "trace_id")?, "trace_id")?,
                span_id: ofixed::<8>(get(r, "span_id")?, "span_id")?,
                flags: oi(get(r, "flags")?, "flags")?,
            })
        })
        .collect()
}
