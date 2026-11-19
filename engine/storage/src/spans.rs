//! Flush for spans: a sealed segment's span batches (`VZB1` signal 2) become `spans` files,
//! one per hour of start time, and `trace_index` files, one per day, laid out as
//! `contracts/TRACES.md` states.
use crate::otel::{self, Attr, Span, SpanEntry, Value};
use crate::otelpq::{
    ba, col, cut_groups, fba, foot, hex, json_str, perr, props, schema, write_group, Leaf, Levels, SResult, SignalError, SignalFile, SignalTable,
    SignalWriteOptions, NS_PER_HOUR,
};
use crate::util::IdHasher;
use parquet::data_type::ByteArray;
use parquet::file::metadata::SortingColumn;
use parquet::file::properties::EnabledStatistics;
use parquet::file::writer::SerializedFileWriter;
use std::collections::HashMap;
use std::hash::BuildHasherDefault;

type FastMap<K, V> = HashMap<K, V, BuildHasherDefault<IdHasher>>;

/// Promoted resource attributes: (column, key). All strings.
pub const PROMOTED_RESOURCE: [(&str, &str); 5] = [
    ("r_service_namespace", "service.namespace"),
    ("r_deployment_environment", "deployment.environment.name"),
    ("r_k8s_namespace_name", "k8s.namespace.name"),
    ("r_k8s_pod_name", "k8s.pod.name"),
    ("r_cloud_region", "cloud.region"),
];
/// Promoted span attributes: (column, key, is_int).
pub const PROMOTED_SPAN: [(&str, &str, bool); 6] = [
    ("s_http_request_method", "http.request.method", false),
    ("s_http_response_status_code", "http.response.status_code", true),
    ("s_http_route", "http.route", false),
    ("s_db_system_name", "db.system.name", false),
    ("s_rpc_service", "rpc.service", false),
    ("s_error_type", "error.type", false),
];
/// The resource key of the `service_name` column.
pub const SERVICE_NAME_KEY: &str = "service.name";
/// At most this many services in a `trace_index` row.
pub const MAX_INDEX_SERVICES: usize = 64;

const MAP: &str = "(MAP) { repeated group key_value { required binary key (UTF8); required";

fn spans_schema() -> String {
    let mut s = String::from(
        "message spans {
  required fixed_len_byte_array(16) trace_id;
  required fixed_len_byte_array(8) span_id;
  optional fixed_len_byte_array(8) parent_span_id;
  optional binary trace_state (UTF8);
  optional int32 flags;
  required int64 start_unix_nano;
  required int64 end_unix_nano;
  required int64 duration_nano;
  required int64 start_time (TIMESTAMP(MICROS,true));
  optional binary service_name (UTF8);
  required binary span_name (UTF8);
  required int32 span_kind;
  required int32 status_code;
  optional binary status_message (UTF8);
  optional binary scope_name (UTF8);
  optional binary scope_version (UTF8);
  required int64 resource_fp;
",
    );
    for (c, _) in PROMOTED_RESOURCE {
        s.push_str(&format!("  optional binary {c} (UTF8);\n"));
    }
    for (c, _, int) in PROMOTED_SPAN {
        if int {
            s.push_str(&format!("  optional int64 {c};\n"));
        } else {
            s.push_str(&format!("  optional binary {c} (UTF8);\n"));
        }
    }
    for scope in ["resource", "span"] {
        s.push_str(&format!("  optional group {scope}_attrs_str {MAP} binary value (UTF8); }} }}\n"));
        s.push_str(&format!("  optional group {scope}_attrs_int {MAP} int64 value; }} }}\n"));
        s.push_str(&format!("  optional group {scope}_attrs_dbl {MAP} double value; }} }}\n"));
        s.push_str(&format!("  optional group {scope}_attrs_bool {MAP} boolean value; }} }}\n"));
        s.push_str(&format!("  optional binary {scope}_attrs_other (UTF8);\n"));
    }
    s.push_str(
        "  optional binary scope_attrs (UTF8);
  optional group events (LIST) { repeated group list { required group element {
    required int64 time_unix_nano; required binary name (UTF8); required binary attrs (UTF8); } } }
  optional group links (LIST) { repeated group list { required group element {
    required fixed_len_byte_array(16) trace_id; required fixed_len_byte_array(8) span_id;
    required binary trace_state (UTF8); required binary attrs (UTF8); } } }
  optional int32 dropped_attributes_count;
  optional int32 dropped_events_count;
  optional int32 dropped_links_count;
}",
    );
    s
}

const TRACE_INDEX_SCHEMA: &str = "message trace_index {
  required fixed_len_byte_array(16) trace_id;
  required int64 min_start_unix_nano;
  required int64 max_end_unix_nano;
  required int32 span_count;
  required int32 error_count;
  optional binary root_service_name (UTF8);
  optional binary root_span_name (UTF8);
  optional int64 root_start_unix_nano;
  optional fixed_len_byte_array(8) root_span_id;
  required group services (LIST) { repeated group list { required group element {
    required binary name (UTF8); required int32 spans; required int32 errors; } } }
  required boolean services_truncated;
  required group hours (LIST) { repeated group list { required int32 element; } }
}";

/// Leaf indexes of the declared sort keys in the `spans` schema.
const LEAF_START: i32 = 5;
const LEAF_SERVICE: i32 = 9;
const LEAF_NAME: i32 = 10;

fn spans_props(opts: &SignalWriteOptions) -> std::sync::Arc<parquet::file::properties::WriterProperties> {
    use EnabledStatistics::{None as NoStats, Page};
    let mut cols = vec![
        col(&["trace_id"]).plain().bloom(),
        col(&["span_id"]).plain(),
        col(&["parent_span_id"]).plain(),
        col(&["trace_state"]).dict(),
        col(&["flags"]).dict(),
        col(&["start_unix_nano"]).delta().stats(Page),
        col(&["end_unix_nano"]).delta(),
        col(&["duration_nano"]).delta().stats(Page),
        col(&["start_time"]).delta(),
        col(&["service_name"]).dict().stats(Page),
        col(&["span_name"]).dict().stats(Page),
        col(&["span_kind"]).dict(),
        col(&["status_code"]).dict(),
        col(&["status_message"]).dict(),
        col(&["scope_name"]).dict(),
        col(&["scope_version"]).dict(),
        col(&["resource_fp"]).delta(),
        col(&["scope_attrs"]).dict().stats(NoStats),
    ];
    for (c, _) in PROMOTED_RESOURCE {
        cols.push(col(&[c]).dict());
    }
    for (c, _, int) in PROMOTED_SPAN {
        cols.push(if int { col(&[c]).delta() } else { col(&[c]).dict() });
    }
    for scope in ["resource", "span"] {
        let res = scope == "resource";
        for t in ["str", "int", "dbl", "bool"] {
            let m = format!("{scope}_attrs_{t}");
            cols.push(col(&[&m, "key_value", "key"]).dict().stats(NoStats));
            let v = col(&[&m, "key_value", "value"]).stats(NoStats);
            cols.push(match t {
                "str" if res => v.dict(),
                "int" => v.delta(),
                _ => v.plain(),
            });
        }
        let o = format!("{scope}_attrs_other");
        cols.push(if res { col(&[&o]).dict().stats(NoStats) } else { col(&[&o]).plain().stats(NoStats) });
    }
    for f in ["time_unix_nano", "name", "attrs"] {
        let c = col(&["events", "list", "element", f]).stats(NoStats);
        cols.push(if f == "time_unix_nano" { c.delta() } else { c.plain() });
    }
    for f in ["trace_id", "span_id", "trace_state", "attrs"] {
        cols.push(col(&["links", "list", "element", f]).plain().stats(NoStats));
    }
    let sorting = vec![
        SortingColumn { column_idx: LEAF_SERVICE, descending: false, nulls_first: true },
        SortingColumn { column_idx: LEAF_NAME, descending: false, nulls_first: true },
        SortingColumn { column_idx: LEAF_START, descending: false, nulls_first: true },
    ];
    props(cols, sorting, opts)
}

fn trace_index_props(opts: &SignalWriteOptions) -> std::sync::Arc<parquet::file::properties::WriterProperties> {
    use EnabledStatistics::Page;
    let cols = vec![
        col(&["trace_id"]).plain().stats(Page),
        col(&["min_start_unix_nano"]).delta().stats(Page),
        col(&["max_end_unix_nano"]).delta().stats(Page),
        col(&["root_service_name"]).dict(),
        col(&["root_span_name"]).dict(),
        col(&["root_start_unix_nano"]).delta(),
        col(&["root_span_id"]).plain(),
        col(&["services", "list", "element", "name"]).dict(),
    ];
    props(cols, vec![SortingColumn { column_idx: 0, descending: false, nulls_first: true }], opts)
}

/// Residual attributes of one scope, split by type, and its promoted values.
#[derive(Default)]
struct Split<'a> {
    promoted_str: Vec<Option<&'a str>>,
    promoted_int: Option<i64>,
    service: Option<&'a str>,
    s: Vec<(&'a str, &'a str)>,
    i: Vec<(&'a str, i64)>,
    d: Vec<(&'a str, u64)>,
    b: Vec<(&'a str, bool)>,
    other: Option<String>,
}

/// The canonical OTLP JSON key-value list of `other` attributes (already sorted).
fn other_json(items: &[(&str, &str)]) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    let mut s = String::from("[");
    for (k, (key, v)) in items.iter().enumerate() {
        if k > 0 {
            s.push(',');
        }
        s.push_str("{\"key\":");
        json_str(&mut s, key);
        s.push_str(",\"value\":");
        s.push_str(v);
        s.push('}');
    }
    s.push(']');
    Some(s)
}

/// Split one attribute list into promoted columns and residual maps. `resource`: the list
/// is a resource's (promoted keys of `PROMOTED_RESOURCE` and `service.name`), else a span's.
fn split<'a>(attrs: &[Attr<&'a str>], resource: bool) -> Split<'a> {
    let mut out = Split { promoted_str: vec![None; if resource { PROMOTED_RESOURCE.len() } else { PROMOTED_SPAN.len() }], ..Default::default() };
    let mut other: Vec<(&str, &str)> = Vec::new();
    'next: for a in attrs {
        if resource {
            if a.key == SERVICE_NAME_KEY {
                if let Value::Str(v) = a.value {
                    out.service = Some(v);
                    continue;
                }
            }
            for (k, (_, key)) in PROMOTED_RESOURCE.iter().enumerate() {
                if a.key == *key {
                    if let Value::Str(v) = a.value {
                        out.promoted_str[k] = Some(v);
                        continue 'next;
                    }
                }
            }
        } else {
            for (k, (_, key, int)) in PROMOTED_SPAN.iter().enumerate() {
                if a.key == *key {
                    match (a.value.clone(), int) {
                        (Value::Str(v), false) => {
                            out.promoted_str[k] = Some(v);
                            continue 'next;
                        }
                        (Value::Int(v), true) => {
                            out.promoted_int = Some(v);
                            continue 'next;
                        }
                        _ => {}
                    }
                }
            }
        }
        match &a.value {
            Value::Str(v) => out.s.push((a.key, v)),
            Value::Int(v) => out.i.push((a.key, *v)),
            Value::Double(v) => out.d.push((a.key, *v)),
            Value::Bool(v) => out.b.push((a.key, *v)),
            Value::Other(v) => other.push((a.key, v)),
        }
    }
    out.other = other_json(&other);
    out
}

struct EntryInfo<'a> {
    entry: &'a SpanEntry<&'a str>,
    split: Split<'a>,
    bytes: usize,
}

/// One row with what sorting and writing need.
struct RowRef<'a> {
    span: &'a Span<&'a str>,
    info: usize,
    hour: i64,
}

/// Turn a sealed segment's span batches (in sequence order) into Parquet files: `spans`
/// files, one per hour of start time in ascending order, then `trace_index` files, one per
/// day of the fragments' first start, in ascending order.
///
/// * `(trace_id, span_id)` is unique in the output; among duplicates the later row (later
///   batch, later in its batch) wins.
/// * `spans` rows are sorted by `service_name` (nulls first), `span_name`, `start`,
///   `trace_id`, `span_id`; `trace_index` rows by `trace_id`.
/// * One `trace_index` row per trace present (a fragment of this unit), naming the hours of
///   the `spans` files that hold its spans.
pub fn encode_spans(batches: &[&[u8]]) -> SResult<Vec<SignalFile>> {
    encode_spans_with(batches, &SignalWriteOptions::default())
}

/// [`encode_spans`] with explicit writer settings (tests use small row groups).
pub fn encode_spans_with(batches: &[&[u8]], opts: &SignalWriteOptions) -> SResult<Vec<SignalFile>> {
    let decoded: Vec<otel::SpanBatch<'_>> =
        batches.iter().enumerate().map(|(index, b)| otel::decode_spans(b).map_err(|error| SignalError::Batch { index, error })).collect::<SResult<_>>()?;

    let mut infos: Vec<EntryInfo<'_>> = Vec::new();
    let mut base: Vec<usize> = Vec::with_capacity(decoded.len());
    for b in &decoded {
        base.push(infos.len());
        for e in &b.entries {
            infos.push(EntryInfo { entry: e, split: split(&e.resource, true), bytes: otel::span_entry_bytes(e) });
        }
    }
    // Later rows win: remember the last position of every (trace_id, span_id).
    let mut last: FastMap<[u8; 24], (usize, usize)> = FastMap::default();
    let key = |s: &Span<&str>| {
        let mut k = [0u8; 24];
        k[..16].copy_from_slice(&s.trace_id);
        k[16..].copy_from_slice(&s.span_id);
        k
    };
    for (bi, b) in decoded.iter().enumerate() {
        for (ri, s) in b.rows.iter().enumerate() {
            last.insert(key(s), (bi, ri));
        }
    }
    let mut rows: Vec<RowRef<'_>> = Vec::with_capacity(last.len());
    for (bi, b) in decoded.iter().enumerate() {
        for (ri, s) in b.rows.iter().enumerate() {
            if last.get(&key(s)) == Some(&(bi, ri)) {
                rows.push(RowRef { span: s, info: base[bi] + s.entry as usize, hour: s.start.div_euclid(NS_PER_HOUR) });
            }
        }
    }
    rows.sort_unstable_by(|a, b| {
        let (sa, sb) = (infos[a.info].split.service, infos[b.info].split.service);
        (a.hour, sa.map(str::as_bytes), a.span.name.as_bytes(), a.span.start, a.span.trace_id, a.span.span_id).cmp(&(
            b.hour,
            sb.map(str::as_bytes),
            b.span.name.as_bytes(),
            b.span.start,
            b.span.trace_id,
            b.span.span_id,
        ))
    });

    let mut out = Vec::new();
    let mut start = 0;
    while start < rows.len() {
        let hour = rows[start].hour;
        let mut end = start;
        while end < rows.len() && rows[end].hour == hour {
            end += 1;
        }
        out.push(write_spans_file(&rows[start..end], &infos, hour, opts)?);
        start = end;
    }
    out.extend(write_trace_index(&rows, &infos, opts)?);
    Ok(out)
}

fn opt_str(v: Option<&str>) -> (Option<ByteArray>, bool) {
    match v {
        Some(s) => (Some(ba(s)), true),
        None => (None, false),
    }
}

/// Leaves of a string column that is null when empty.
fn str_or_null<'a>(vals: impl Iterator<Item = &'a str>) -> Leaf {
    let (mut v, mut p) = (Vec::new(), Vec::new());
    for s in vals {
        p.push(!s.is_empty());
        if !s.is_empty() {
            v.push(ba(s));
        }
    }
    Leaf::Bytes(v, Levels::optional(p.into_iter()))
}

fn opt_leaf<'a>(vals: impl Iterator<Item = Option<&'a str>>) -> Leaf {
    let (mut v, mut p) = (Vec::new(), Vec::new());
    for s in vals {
        let (b, present) = opt_str(s);
        p.push(present);
        if let Some(b) = b {
            v.push(b);
        }
    }
    Leaf::Bytes(v, Levels::optional(p.into_iter()))
}

fn opt_i32(vals: impl Iterator<Item = Option<i32>>) -> Leaf {
    let (mut v, mut p) = (Vec::new(), Vec::new());
    for x in vals {
        p.push(x.is_some());
        v.extend(x);
    }
    Leaf::I32(v, Levels::optional(p.into_iter()))
}

/// The key and value leaves of one map column.
fn map_leaves<'a, T: Clone>(rows: &[&'a [(&'a str, T)]], wrap: impl Fn(Vec<T>, Levels) -> Leaf) -> [Leaf; 2] {
    let counts = || rows.iter().map(|r| if r.is_empty() { None } else { Some(r.len()) });
    let lv = Levels::repeated(counts(), true);
    let keys: Vec<ByteArray> = rows.iter().flat_map(|r| r.iter().map(|(k, _)| ba(k))).collect();
    let vals: Vec<T> = rows.iter().flat_map(|r| r.iter().map(|(_, v)| v.clone())).collect();
    [Leaf::Bytes(keys, lv.clone()), wrap(vals, lv)]
}

fn maps_and_other(splits: &[&Split<'_>]) -> Vec<Leaf> {
    let mut out = Vec::with_capacity(9);
    let s: Vec<&[(&str, &str)]> = splits.iter().map(|x| x.s.as_slice()).collect();
    let [a, b] = map_leaves(&s, |v, l| Leaf::Bytes(v.into_iter().map(ba).collect(), l));
    out.extend([a, b]);
    let i: Vec<&[(&str, i64)]> = splits.iter().map(|x| x.i.as_slice()).collect();
    let [a, b] = map_leaves(&i, Leaf::I64);
    out.extend([a, b]);
    let d: Vec<&[(&str, u64)]> = splits.iter().map(|x| x.d.as_slice()).collect();
    let [a, b] = map_leaves(&d, |v, l| Leaf::F64(v.into_iter().map(f64::from_bits).collect(), l));
    out.extend([a, b]);
    let bo: Vec<&[(&str, bool)]> = splits.iter().map(|x| x.b.as_slice()).collect();
    let [a, b] = map_leaves(&bo, Leaf::Bool);
    out.extend([a, b]);
    out.push(opt_leaf(splits.iter().map(|x| x.other.as_deref())));
    out
}

fn write_spans_file(rows: &[RowRef<'_>], infos: &[EntryInfo<'_>], hour: i64, opts: &SignalWriteOptions) -> SResult<SignalFile> {
    let weights: Vec<usize> = rows.iter().map(|r| 96 + otel::span_var_bytes(r.span) + infos[r.info].bytes).collect();
    let mut w = SerializedFileWriter::new(Vec::new(), schema(&spans_schema()), spans_props(opts)).map_err(perr)?;
    let mut index = String::from("{\"v\":1,\"rg\":[");
    let mut groups_end = 4u64;
    let (mut min_ts, mut max_ts) = (i64::MAX, i64::MIN);
    for (gi, (a, b)) in cut_groups(&weights, opts).into_iter().enumerate() {
        let g = &rows[a..b];
        let span_splits: Vec<Split<'_>> = g.iter().map(|r| split(&r.span.attrs, false)).collect();
        let info = |r: &RowRef<'_>| &infos[r.info];
        let mut leaves = vec![
            Leaf::Fixed(g.iter().map(|r| fba(&r.span.trace_id)).collect(), Levels::none()),
            Leaf::Fixed(g.iter().map(|r| fba(&r.span.span_id)).collect(), Levels::none()),
            {
                let v: Vec<_> = g.iter().filter_map(|r| r.span.parent()).map(|p| fba(&p)).collect();
                Leaf::Fixed(v, Levels::optional(g.iter().map(|r| r.span.parent().is_some())))
            },
            str_or_null(g.iter().map(|r| r.span.trace_state)),
            opt_i32(g.iter().map(|r| (r.span.flags != 0).then_some(r.span.flags as i32))),
            Leaf::I64(g.iter().map(|r| r.span.start).collect(), Levels::none()),
            Leaf::I64(g.iter().map(|r| r.span.end).collect(), Levels::none()),
            Leaf::I64(g.iter().map(|r| r.span.end - r.span.start).collect(), Levels::none()),
            Leaf::I64(g.iter().map(|r| r.span.start.div_euclid(1000)).collect(), Levels::none()),
            opt_leaf(g.iter().map(|r| info(r).split.service)),
            Leaf::Bytes(g.iter().map(|r| ba(r.span.name)).collect(), Levels::none()),
            Leaf::I32(g.iter().map(|r| r.span.kind as i32).collect(), Levels::none()),
            Leaf::I32(g.iter().map(|r| r.span.status as i32).collect(), Levels::none()),
            str_or_null(g.iter().map(|r| r.span.status_message)),
            str_or_null(g.iter().map(|r| info(r).entry.scope_name)),
            str_or_null(g.iter().map(|r| info(r).entry.scope_version)),
            Leaf::I64(g.iter().map(|r| info(r).entry.resource_fp).collect(), Levels::none()),
        ];
        for k in 0..PROMOTED_RESOURCE.len() {
            leaves.push(opt_leaf(g.iter().map(|r| info(r).split.promoted_str[k])));
        }
        for (k, (_, _, int)) in PROMOTED_SPAN.iter().enumerate() {
            if *int {
                let v: Vec<i64> = span_splits.iter().filter_map(|s| s.promoted_int).collect();
                leaves.push(Leaf::I64(v, Levels::optional(span_splits.iter().map(|s| s.promoted_int.is_some()))));
            } else {
                leaves.push(opt_leaf(span_splits.iter().map(|s| s.promoted_str[k])));
            }
        }
        let res: Vec<&Split<'_>> = g.iter().map(|r| &info(r).split).collect();
        leaves.extend(maps_and_other(&res));
        let sp: Vec<&Split<'_>> = span_splits.iter().collect();
        leaves.extend(maps_and_other(&sp));
        leaves.push(str_or_null(g.iter().map(|r| info(r).entry.scope_attrs)));
        // events
        let ev = Levels::repeated(g.iter().map(|r| (!r.span.events.is_empty()).then_some(r.span.events.len())), true);
        leaves.push(Leaf::I64(g.iter().flat_map(|r| r.span.events.iter().map(|e| e.time_unix_nano)).collect(), ev.clone()));
        leaves.push(Leaf::Bytes(g.iter().flat_map(|r| r.span.events.iter().map(|e| ba(e.name))).collect(), ev.clone()));
        leaves.push(Leaf::Bytes(g.iter().flat_map(|r| r.span.events.iter().map(|e| ba(e.attrs))).collect(), ev));
        // links
        let lk = Levels::repeated(g.iter().map(|r| (!r.span.links.is_empty()).then_some(r.span.links.len())), true);
        leaves.push(Leaf::Fixed(g.iter().flat_map(|r| r.span.links.iter().map(|l| fba(&l.trace_id))).collect(), lk.clone()));
        leaves.push(Leaf::Fixed(g.iter().flat_map(|r| r.span.links.iter().map(|l| fba(&l.span_id))).collect(), lk.clone()));
        leaves.push(Leaf::Bytes(g.iter().flat_map(|r| r.span.links.iter().map(|l| ba(l.trace_state))).collect(), lk.clone()));
        leaves.push(Leaf::Bytes(g.iter().flat_map(|r| r.span.links.iter().map(|l| ba(l.attrs))).collect(), lk));
        for k in 0..3 {
            leaves.push(opt_i32(g.iter().map(|r| (r.span.dropped[k] != 0).then_some(r.span.dropped[k] as i32))));
        }
        let (off, len) = write_group(&mut w, leaves)?;
        groups_end = off + len;

        let gmin = g.iter().map(|r| r.span.start).min().unwrap();
        let gmax = g.iter().map(|r| r.span.start).max().unwrap();
        let dmin = g.iter().map(|r| r.span.end - r.span.start).min().unwrap();
        let dmax = g.iter().map(|r| r.span.end - r.span.start).max().unwrap();
        min_ts = min_ts.min(gmin);
        max_ts = max_ts.max(gmax);
        if gi > 0 {
            index.push(',');
        }
        index.push_str(&format!("{{\"rows\":{},\"off\":{off},\"len\":{len},\"min_name\":", g.len()));
        json_str(&mut index, info(&g[0]).split.service.unwrap_or(""));
        index.push_str(",\"max_name\":");
        json_str(&mut index, info(&g[g.len() - 1]).split.service.unwrap_or(""));
        index.push_str(&format!(",\"min_ts\":{gmin},\"max_ts\":{gmax},\"min_dur\":{dmin},\"max_dur\":{dmax}}}"));
    }
    w.finish().map_err(perr)?;
    let bytes = std::mem::take(w.inner_mut());
    let (fo, fl) = foot(groups_end, bytes.len());
    index.push_str(&format!("],\"foot\":[{fo},{fl}]}}"));
    Ok(SignalFile {
        table: SignalTable::Spans,
        day: crate::day::format_day(hour.div_euclid(24)),
        hour: Some(hour.rem_euclid(24) as u8),
        bytes,
        rows: rows.len() as u64,
        min_ts,
        max_ts,
        index,
    })
}

/// One `trace_index` row: a trace's spans in this unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fragment {
    pub trace_id: [u8; 16],
    pub min_start: i64,
    pub max_end: i64,
    pub span_count: i32,
    pub error_count: i32,
    /// The root span, if the fragment has one: its service (if a string), name, start, id.
    pub root: Option<(Option<String>, String, i64, [u8; 8])>,
    /// (service, spans, errors), at most 64, by name.
    pub services: Vec<(String, i32, i32)>,
    pub services_truncated: bool,
    /// Hours since the epoch, ascending, distinct.
    pub hours: Vec<i32>,
}

fn fragments(rows: &[RowRef<'_>], infos: &[EntryInfo<'_>]) -> Vec<Fragment> {
    struct Agg<'a> {
        min_start: i64,
        max_end: i64,
        spans: i32,
        errors: i32,
        root: Option<&'a RowRef<'a>>,
        services: Vec<(&'a str, i32, i32)>,
        hours: Vec<i64>,
    }
    let mut by: FastMap<[u8; 16], Agg<'_>> = FastMap::default();
    let mut order: Vec<[u8; 16]> = Vec::new();
    for r in rows {
        let s = r.span;
        let a = by.entry(s.trace_id).or_insert_with(|| {
            order.push(s.trace_id);
            Agg { min_start: i64::MAX, max_end: i64::MIN, spans: 0, errors: 0, root: None, services: Vec::new(), hours: Vec::new() }
        });
        a.min_start = a.min_start.min(s.start);
        a.max_end = a.max_end.max(s.end);
        a.spans += 1;
        let err = (s.status == 2) as i32;
        a.errors += err;
        if s.parent().is_none() && a.root.is_none_or(|x| (s.start, s.span_id) < (x.span.start, x.span.span_id)) {
            a.root = Some(r);
        }
        let svc = infos[r.info].split.service.unwrap_or("");
        match a.services.iter_mut().find(|x| x.0 == svc) {
            Some(x) => {
                x.1 += 1;
                x.2 += err;
            }
            None => a.services.push((svc, 1, err)),
        }
        if !a.hours.contains(&r.hour) {
            a.hours.push(r.hour);
        }
    }
    order.sort_unstable();
    order
        .into_iter()
        .map(|t| {
            let mut a = by.remove(&t).unwrap();
            let truncated = a.services.len() > MAX_INDEX_SERVICES;
            if truncated {
                a.services.sort_by(|x, y| y.1.cmp(&x.1).then(x.0.as_bytes().cmp(y.0.as_bytes())));
                a.services.truncate(MAX_INDEX_SERVICES);
            }
            a.services.sort_by(|x, y| x.0.as_bytes().cmp(y.0.as_bytes()));
            a.hours.sort_unstable();
            Fragment {
                trace_id: t,
                min_start: a.min_start,
                max_end: a.max_end,
                span_count: a.spans,
                error_count: a.errors,
                root: a.root.map(|r| (infos[r.info].split.service.map(str::to_string), r.span.name.to_string(), r.span.start, r.span.span_id)),
                services: a.services.into_iter().map(|(n, s, e)| (n.to_string(), s, e)).collect(),
                services_truncated: truncated,
                hours: a.hours.into_iter().map(|h| h as i32).collect(),
            }
        })
        .collect()
}

fn write_trace_index(rows: &[RowRef<'_>], infos: &[EntryInfo<'_>], opts: &SignalWriteOptions) -> SResult<Vec<SignalFile>> {
    let mut frags = fragments(rows, infos);
    // By day of the first start, then trace id (the fragments are in trace id order).
    frags.sort_by_key(|f| f.min_start.div_euclid(crate::otelpq::NS_PER_DAY));
    let mut out = Vec::new();
    let mut start = 0;
    while start < frags.len() {
        let day = frags[start].min_start.div_euclid(crate::otelpq::NS_PER_DAY);
        let mut end = start;
        while end < frags.len() && frags[end].min_start.div_euclid(crate::otelpq::NS_PER_DAY) == day {
            end += 1;
        }
        out.push(write_index_file(&frags[start..end], day, opts)?);
        start = end;
    }
    Ok(out)
}

fn write_index_file(frags: &[Fragment], day: i64, opts: &SignalWriteOptions) -> SResult<SignalFile> {
    let weights: Vec<usize> = frags
        .iter()
        .map(|f| 64 + f.root.as_ref().map_or(0, |r| r.0.as_ref().map_or(0, String::len) + r.1.len()) + f.services.iter().map(|s| s.0.len() + 8).sum::<usize>())
        .collect();
    let mut w = SerializedFileWriter::new(Vec::new(), schema(TRACE_INDEX_SCHEMA), trace_index_props(opts)).map_err(perr)?;
    let mut index = String::from("{\"v\":1,\"rg\":[");
    let mut groups_end = 4u64;
    let (mut min_ts, mut max_ts) = (i64::MAX, i64::MIN);
    for (gi, (a, b)) in cut_groups(&weights, opts).into_iter().enumerate() {
        let g = &frags[a..b];
        let svc = Levels::repeated(g.iter().map(|f| Some(f.services.len())), false);
        let hrs = Levels::repeated(g.iter().map(|f| Some(f.hours.len())), false);
        let leaves = vec![
            Leaf::Fixed(g.iter().map(|f| fba(&f.trace_id)).collect(), Levels::none()),
            Leaf::I64(g.iter().map(|f| f.min_start).collect(), Levels::none()),
            Leaf::I64(g.iter().map(|f| f.max_end).collect(), Levels::none()),
            Leaf::I32(g.iter().map(|f| f.span_count).collect(), Levels::none()),
            Leaf::I32(g.iter().map(|f| f.error_count).collect(), Levels::none()),
            opt_leaf(g.iter().map(|f| f.root.as_ref().and_then(|r| r.0.as_deref()))),
            opt_leaf(g.iter().map(|f| f.root.as_ref().map(|r| r.1.as_str()))),
            {
                let v: Vec<i64> = g.iter().filter_map(|f| f.root.as_ref().map(|r| r.2)).collect();
                Leaf::I64(v, Levels::optional(g.iter().map(|f| f.root.is_some())))
            },
            {
                let v = g.iter().filter_map(|f| f.root.as_ref().map(|r| fba(&r.3))).collect();
                Leaf::Fixed(v, Levels::optional(g.iter().map(|f| f.root.is_some())))
            },
            Leaf::Bytes(g.iter().flat_map(|f| f.services.iter().map(|s| ba(&s.0))).collect(), svc.clone()),
            Leaf::I32(g.iter().flat_map(|f| f.services.iter().map(|s| s.1)).collect(), svc.clone()),
            Leaf::I32(g.iter().flat_map(|f| f.services.iter().map(|s| s.2)).collect(), svc),
            Leaf::Bool(g.iter().map(|f| f.services_truncated).collect(), Levels::none()),
            Leaf::I32(g.iter().flat_map(|f| f.hours.iter().copied()).collect(), hrs),
        ];
        let (off, len) = write_group(&mut w, leaves)?;
        groups_end = off + len;
        let gmin = g.iter().map(|f| f.min_start).min().unwrap();
        let gmax = g.iter().map(|f| f.max_end).max().unwrap();
        min_ts = min_ts.min(gmin);
        max_ts = max_ts.max(gmax);
        if gi > 0 {
            index.push(',');
        }
        index.push_str(&format!(
            "{{\"rows\":{},\"off\":{off},\"len\":{len},\"min_tid\":\"{}\",\"max_tid\":\"{}\",\"min_ts\":{gmin},\"max_ts\":{gmax}}}",
            g.len(),
            hex(&g[0].trace_id),
            hex(&g[g.len() - 1].trace_id)
        ));
    }
    w.finish().map_err(perr)?;
    let bytes = std::mem::take(w.inner_mut());
    let (fo, fl) = foot(groups_end, bytes.len());
    index.push_str(&format!("],\"foot\":[{fo},{fl}]}}"));
    Ok(SignalFile { table: SignalTable::TraceIndex, day: crate::day::format_day(day), hour: None, bytes, rows: frags.len() as u64, min_ts, max_ts, index })
}

/// Merge `trace_index` fragments of one trace (`contracts/TRACES.md`, "Merging
/// fragments"): min of starts, max of ends, sums, per-service sums, union of hours; the root
/// from the fragment whose root started first, then has the smaller span id.
pub fn merge_fragments(frags: &[Fragment]) -> Option<Fragment> {
    let first = frags.first()?;
    let mut m = Fragment { services: Vec::new(), hours: Vec::new(), root: None, services_truncated: false, ..first.clone() };
    m.min_start = i64::MAX;
    m.max_end = i64::MIN;
    m.span_count = 0;
    m.error_count = 0;
    for f in frags {
        m.min_start = m.min_start.min(f.min_start);
        m.max_end = m.max_end.max(f.max_end);
        m.span_count += f.span_count;
        m.error_count += f.error_count;
        m.services_truncated |= f.services_truncated;
        if let Some(r) = &f.root {
            if m.root.as_ref().is_none_or(|x| (r.2, r.3) < (x.2, x.3)) {
                m.root = Some(r.clone());
            }
        }
        for (n, s, e) in &f.services {
            match m.services.iter_mut().find(|x| &x.0 == n) {
                Some(x) => {
                    x.1 += s;
                    x.2 += e;
                }
                None => m.services.push((n.clone(), *s, *e)),
            }
        }
        m.hours.extend(&f.hours);
    }
    m.services.sort_by(|x, y| x.0.as_bytes().cmp(y.0.as_bytes()));
    m.hours.sort_unstable();
    m.hours.dedup();
    Some(m)
}
