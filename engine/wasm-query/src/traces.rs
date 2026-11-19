//! TraceQL over the `spans` and `trace_index` tables and span tail batches: the operations
//! behind Tempo's HTTP API in the query Worker (search, metrics, trace by ID, tag names and
//! values). The engine is `viz-traceql`; it reads through its documented seam, a
//! `SpanSource` of traces with complete summaries (`MemSource` over the spans read here).
//!
//! Rows are de-duplicated on `(trace_id, span_id)`, the later winning: files in the order
//! given (ascending precedence, `contracts/ledger.ts` `LiveFile`), then tail batches in
//! order (`contracts/BATCH.md`, signal 2, "Row key"). A trace's summary is computed from
//! every span of it that was read (`TraceSummary::from_spans`), never from `trace_index`
//! counts (which over-count spans retried into another unit, `contracts/TRACES.md`): the
//! index fragments only say which hours and which time hull to read.
use crate::sigfiles::{self, Mem, Resources, Seen, SpanRec, Take};
use crate::{Fail, Req, Res};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::rc::Rc;
use std::sync::Arc;
use viz_query::QueryError;
use viz_storage::otel::{Attr, Value};
use viz_traceql::ast::{Intrinsic, Query, Scope};
use viz_traceql::{AttrValue, Column, Kind, MemSource, RangeRequest, SearchRequest, Status, Trace};

type Key = ([u8; 16], [u8; 8]);

/// A TraceQL error as the binding types it: parse and validation errors are `bad_data`.
pub(crate) fn tq_err(e: viz_traceql::Error) -> Fail {
    Fail::Query(match e {
        viz_traceql::Error::Parse { .. } | viz_traceql::Error::Validation { .. } => QueryError::bad_data(e.to_string()),
        viz_traceql::Error::Unsupported(m) => QueryError::unsupported(m),
        viz_traceql::Error::Eval(m) => QueryError::execution(m),
        viz_traceql::Error::Source(m) => QueryError::internal(m),
        // Mapped to `max_decoded_bytes` where the budget is known (`do_tq_metrics`).
        e @ viz_traceql::Error::Memory { .. } => QueryError::execution(e.to_string()),
    })
}

// ───────────────────────────── values ─────────────────────────────

fn dbl(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) if s == "NaN" => Some(f64::NAN),
        serde_json::Value::String(s) if s == "Infinity" => Some(f64::INFINITY),
        serde_json::Value::String(s) if s == "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

/// The engine's value of a canonical OTLP JSON `AnyValue` (`contracts/TRACES.md`, "Logical
/// view"): scalars typed, an array of one scalar type the engine's typed array (an empty
/// array an empty string array), anything else kept as JSON (`Other`).
fn any_to_av(raw: &str) -> AttrValue {
    use serde_json::Value as J;
    let Ok(v) = serde_json::from_str::<J>(raw) else { return AttrValue::Other(raw.to_string()) };
    if let Some(s) = v.get("stringValue").and_then(J::as_str) {
        return AttrValue::Str(s.to_string());
    }
    if let Some(i) = v.get("intValue").and_then(J::as_str).and_then(|s| s.parse().ok()) {
        return AttrValue::Int(i);
    }
    if let Some(d) = v.get("doubleValue").and_then(dbl) {
        return AttrValue::Float(d);
    }
    if let Some(b) = v.get("boolValue").and_then(J::as_bool) {
        return AttrValue::Bool(b);
    }
    if let Some(a) = v.get("arrayValue") {
        let items: Vec<J> = a.get("values").and_then(J::as_array).cloned().unwrap_or_default();
        let all = |k: &str| items.iter().all(|x| x.get(k).is_some());
        if items.is_empty() {
            return AttrValue::StrArray(Vec::new());
        }
        if all("stringValue") {
            if let Some(v) = items.iter().map(|x| x["stringValue"].as_str().map(str::to_string)).collect() {
                return AttrValue::StrArray(v);
            }
        }
        if all("intValue") {
            if let Some(v) = items.iter().map(|x| x["intValue"].as_str().and_then(|s| s.parse().ok())).collect() {
                return AttrValue::IntArray(v);
            }
        }
        if all("doubleValue") {
            if let Some(v) = items.iter().map(|x| dbl(&x["doubleValue"])).collect() {
                return AttrValue::FloatArray(v);
            }
        }
        if all("boolValue") {
            if let Some(v) = items.iter().map(|x| x["boolValue"].as_bool()).collect() {
                return AttrValue::BoolArray(v);
            }
        }
    }
    AttrValue::Other(raw.to_string())
}

fn av(v: &Value<String>) -> AttrValue {
    match v {
        Value::Str(s) => AttrValue::Str(s.clone()),
        Value::Int(i) => AttrValue::Int(*i),
        Value::Double(b) => AttrValue::Float(f64::from_bits(*b)),
        Value::Bool(b) => AttrValue::Bool(*b),
        Value::Other(o) => any_to_av(o),
    }
}

fn kv_list(raw: &str) -> Res<Vec<(String, AttrValue)>> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sigfiles::kv_texts(raw)?.into_iter().map(|(k, v)| (k, any_to_av(&v))).collect())
}

/// The engine's form of each distinct resource of a call, made once (keyed by the record's
/// shared copy, which [`Resources`] keeps alive for the call) and charged once.
#[derive(Default)]
pub(crate) struct EngineResources(HashMap<*const Vec<Attr<String>>, Arc<viz_traceql::data::Attrs>>);

impl EngineResources {
    fn get(&mut self, r: &Rc<Vec<Attr<String>>>, mem: &mut Mem) -> Res<Arc<viz_traceql::data::Attrs>> {
        if let Some(x) = self.0.get(&Rc::as_ptr(r)) {
            return Ok(Arc::clone(x));
        }
        mem.charge(64 + sigfiles::attrs_bytes(r))?;
        let x: Arc<viz_traceql::data::Attrs> = Arc::new(r.iter().map(|a| (a.key.clone(), av(&a.value))).collect());
        self.0.insert(Rc::as_ptr(r), Arc::clone(&x));
        Ok(x)
    }
}

/// The engine's span (`viz_traceql::Span`, the logical view) of a record.
pub(crate) fn engine_span(r: &SpanRec, resources: &mut EngineResources, mem: &mut Mem) -> Res<viz_traceql::Span> {
    Ok(viz_traceql::Span {
        span_id: r.span_id,
        parent_span_id: r.parent,
        name: r.name.clone(),
        kind: Kind::from_otlp(r.kind as i32),
        status: Status::from_otlp(r.status as i32),
        status_message: r.status_message.clone(),
        start_unix_nano: r.start as u64,
        end_unix_nano: r.end as u64,
        resource: resources.get(&r.resource, mem)?,
        attrs: r.attrs.iter().map(|a| (a.key.clone(), av(&a.value))).collect(),
        scope_name: r.scope_name.clone(),
        scope_version: r.scope_version.clone(),
        scope_attrs: kv_list(&r.scope_attrs)?,
        events: r.events.iter().map(|e| Ok(viz_traceql::Event { time_unix_nano: e.time_unix_nano as u64, name: e.name.clone(), attrs: kv_list(&e.attrs)? })).collect::<Res<_>>()?,
        links: r.links.iter().map(|l| Ok(viz_traceql::Link { trace_id: l.trace_id, span_id: l.span_id, trace_state: l.trace_state.clone(), attrs: kv_list(&l.attrs)? })).collect::<Res<_>>()?,
    })
}

// ───────────────────────────── reading ─────────────────────────────

/// What one call may decode and hold, and which spans are part of its data.
///
/// * `bound`: a span whose start lies outside `[lo, hi]` (nanoseconds) is not part of the
///   data. It is dropped as it is read, BEFORE de-duplication, so that what the call sees does
///   not depend on which files or row groups outside the bound were read (pruning on or off):
///   design/DECISIONS.md D62, a found trace's spans within the query's margin.
/// * `only`: trace by ID's trace; a span of any other trace is not part of the data either
///   (it is read, to find the trace's, and passed over before it is decoded).
/// * `max_spans`: spans HELD, the tail's included; `spans` counts them (ABI 8: a span of another
///   trace, or one a call keeps only the row key of, is not counted; review r2 R2-M4).
/// * `mem`: the bytes of what is held ([`Mem`]); `resources`: one copy per distinct resource.
/// * `decoded`: every span read, the dropped ones included (reported, not limited).
pub(crate) struct Budget {
    pub max_spans: u64,
    pub spans: u64,
    pub decoded: u64,
    pub bound: (i64, i64),
    pub only: Option<[u8; 16]>,
    pub mem: Mem,
    pub res: Resources,
    pub engine_res: EngineResources,
    /// What the refusal of `max_spans` advises.
    pub help: &'static str,
}

const ALL_TIME: (i64, i64) = (i64::MIN, i64::MAX);

impl Budget {
    pub fn new(max_spans: u64, max_bytes: u64, bound: (i64, i64)) -> Budget {
        Budget { max_spans, spans: 0, decoded: 0, bound, only: None, mem: Mem::new(max_bytes), res: Resources::default(), engine_res: EngineResources::default(), help: "Narrow the time range." }
    }
    /// `u64 max_spans, u64 max_bytes, i64 bound_lo, i64 bound_hi` (ABI 7).
    fn read(r: &mut Req<'_>) -> Res<Budget> {
        let (max_spans, max_bytes) = (r.u64("max_spans")?, r.u64("max_bytes")?);
        let (lo, hi) = (r.i64("bound_lo")?, r.i64("bound_hi")?);
        if lo > hi {
            return Err(Fail::Malformed(format!("bound [{lo}, {hi}] is empty")));
        }
        Ok(Budget::new(max_spans, max_bytes, (lo, hi)))
    }
    /// What a refusal advises, for `max_spans` and `max_decoded_bytes` alike.
    fn advise(&mut self, help: &'static str) {
        self.help = help;
        self.mem.help = help;
    }
}

fn take(max_spans: u64, spans: &mut u64, help: &str) -> Res<()> {
    *spans += 1;
    if *spans > max_spans {
        return Err(Fail::Limit("max_spans", max_spans, *spans, format!("query exceeded limit max_spans: it would hold more than {max_spans} spans, the limit is {max_spans}. {help}")));
    }
    Ok(())
}

/// Bytes charged per row key a call keeps without its span (a later copy that hides an earlier
/// one), with its share of the map that holds it.
const KEY_BYTES: u64 = 64;

/// Every span of the files (in the order given) and then the tail batches that is part of the
/// call's data (inside the bound, of the trace asked for), to `visit`: whole when `want` says
/// so (then counted against `max_spans` and charged), else only its row key.
fn each_span(files: &[&[u8]], tails: &[&[u8]], budget: &mut Budget, want: impl Fn(i64) -> bool, mut visit: impl FnMut(Seen, &mut Mem, &mut EngineResources) -> Res<()>) -> Res<()> {
    let (lo, hi) = budget.bound;
    let only = budget.only;
    let classify = move |t: &[u8; 16], start: i64| {
        if start < lo || start > hi || only.is_some_and(|x| x != *t) {
            Take::Skip
        } else if want(start) {
            Take::Full
        } else {
            Take::Key
        }
    };
    let Budget { max_spans, spans, decoded, mem, res, engine_res, help, .. } = budget;
    let (max_spans, help) = (*max_spans, *help);
    let mut on = |x: Seen, mem: &mut Mem| -> Res<()> {
        if let Seen::Span(r) = &x {
            take(max_spans, spans, help)?;
            mem.charge(sigfiles::span_bytes(r))?;
        } else {
            mem.charge(KEY_BYTES)?;
        }
        visit(x, mem, engine_res)
    };
    for f in files {
        *decoded += sigfiles::read_spans(f, res, mem, &classify, &mut on)?;
    }
    for b in tails {
        *decoded += sigfiles::batch_spans(b, res, mem, &classify, &mut on)?;
    }
    Ok(())
}

/// The latest copy of each row key (files in the order given, then the tail), as a map from the
/// key to its slot; a key whose latest copy is not wanted hides the earlier ones.
struct Latest<T> {
    index: HashMap<Key, u32>,
    kept: Vec<Option<(T, u64)>>,
}

const HIDDEN: u32 = u32::MAX;

impl<T> Latest<T> {
    fn new() -> Latest<T> {
        Latest { index: HashMap::new(), kept: Vec::new() }
    }
    /// `v` is the value and what it was charged (released if a later copy replaces it).
    fn put(&mut self, k: Key, v: Option<(T, u64)>, mem: &mut Mem) {
        match self.index.get(&k).copied() {
            Some(i) if i != HIDDEN => {
                if let Some((_, c)) = self.kept[i as usize].take() {
                    mem.release(c);
                }
                match v {
                    Some(v) => self.kept[i as usize] = Some(v),
                    None => {
                        self.index.insert(k, HIDDEN);
                    }
                }
            }
            _ => {
                let slot = match v {
                    Some(v) => {
                        self.kept.push(Some(v));
                        (self.kept.len() - 1) as u32
                    }
                    None => HIDDEN,
                };
                self.index.insert(k, slot);
            }
        }
    }
    fn values(self) -> impl Iterator<Item = T> {
        self.kept.into_iter().flatten().map(|x| x.0)
    }
}

/// The spans read, de-duplicated (later wins), as records: those `want` keeps by start.
fn latest_records(files: &[&[u8]], tails: &[&[u8]], budget: &mut Budget, want: impl Fn(i64) -> bool) -> Res<Vec<SpanRec>> {
    let mut by: Latest<SpanRec> = Latest::new();
    each_span(files, tails, budget, want, |x, mem, _| {
        match x {
            Seen::Key(t, s) => by.put((t, s), None, mem),
            Seen::Span(r) => {
                let c = sigfiles::span_bytes(&r);
                by.put((r.trace_id, r.span_id), Some((r, c)), mem)
            }
        }
        Ok(())
    })?;
    Ok(by.values().collect())
}

/// Traces of the spans read (later row wins), each with its spans in `(start, span_id)` order
/// and its summary computed from them; traces in `trace_id` order. With `window`, only spans
/// whose start lies in `(lo, hi]` are kept (a metrics query whose plan is span-local).
pub(crate) fn traces(files: &[&[u8]], tails: &[&[u8]], budget: &mut Budget, window: Option<(u64, u64)>) -> Res<Vec<Trace>> {
    let mut by: Latest<viz_traceql::Span> = Latest::new();
    let want = move |start: i64| window.is_none_or(|(lo, hi)| (start as u64) > lo && (start as u64) <= hi);
    each_span(files, tails, budget, want, |x, mem, engine_res| {
        match x {
            Seen::Key(t, s) => by.put((t, s), None, mem),
            Seen::Span(r) => {
                let c = sigfiles::span_bytes(&r);
                let k = (r.trace_id, r.span_id);
                by.put(k, Some((engine_span(&r, engine_res, mem)?, c)), mem);
            }
        }
        Ok(())
    })?;
    let mut ids: Vec<([u8; 16], u32)> = by.index.iter().filter(|(_, i)| **i != HIDDEN).map(|((t, _), i)| (*t, *i)).collect();
    ids.sort_unstable();
    let mut slots = by.kept;
    let mut grouped: BTreeMap<[u8; 16], Vec<viz_traceql::Span>> = BTreeMap::new();
    for (t, i) in ids {
        if let Some((s, _)) = slots[i as usize].take() {
            grouped.entry(t).or_default().push(s);
        }
    }
    Ok(grouped
        .into_iter()
        .map(|(t, mut v)| {
            v.sort_by(|a, b| (a.start_unix_nano, a.span_id).cmp(&(b.start_unix_nano, b.span_id)));
            Trace::new(t, v)
        })
        .collect())
}

// ───────────────────────────── plan ─────────────────────────────

fn trace_level(c: &Column) -> bool {
    matches!(c, Column::Intrinsic(Intrinsic::TraceDuration | Intrinsic::TraceRootName | Intrinsic::TraceRootService))
}

/// `viz_q_tq_plan`: what a query needs read, from its text alone.
pub(crate) fn do_tq_plan(mut r: Req<'_>) -> Res<Vec<u8>> {
    let kind = r.u8("kind")?;
    let (start, end, step) = (r.i64("start")?, r.i64("end")?, r.i64("step")?);
    let q = r.str("query")?;
    r.end()?;
    let root = viz_traceql::parse(q).map_err(tq_err)?;
    let metrics = matches!(root.query, Query::Metrics(_));
    let (start, end, step) = (start.max(0) as u64, end.max(0) as u64, step.max(0) as u64);
    let out = match kind {
        0 => {
            if metrics {
                return Err(Fail::Query(QueryError::bad_data("a metrics query cannot be run as a search; use /api/metrics/query_range")));
            }
            let p = viz_traceql::plan(q, start, end).map_err(tq_err)?;
            serde_json::json!({"complete": true, "lo": p.trace_window.0.to_string(), "hi": p.trace_window.1.min(i64::MAX as u64).to_string()})
        }
        1 | 2 => {
            if !metrics {
                return Err(Fail::Query(QueryError::bad_data("not a metrics query: add a metrics function such as | rate()")));
            }
            if end <= start {
                return Err(Fail::Query(QueryError::bad_data("end must be after start")));
            }
            let req = if kind == 1 {
                if step == 0 {
                    return Err(Fail::Query(QueryError::bad_data("step must be positive")));
                }
                viz_traceql::align_request(&RangeRequest::range(start, end, step))
            } else {
                RangeRequest::instant(start, end)
            };
            let p = viz_traceql::plan(q, req.start_unix_nano, req.end_unix_nano).map_err(tq_err)?;
            let complete = p.full_traces || !p.span_local || p.columns.iter().any(trace_level);
            let (lo, hi) = p.span_window.unwrap_or((req.start_unix_nano, req.end_unix_nano));
            serde_json::json!({
                "complete": complete, "spanLocal": !complete,
                "lo": (lo + 1).to_string(), "hi": hi.to_string(),
                "start": req.start_unix_nano.to_string(), "end": req.end_unix_nano.to_string(), "step": req.step_nano.to_string(),
            })
        }
        k => return Err(Fail::Malformed(format!("unknown kind {k}"))),
    };
    Ok(out.to_string().into_bytes())
}

// ───────────────────────────── file plans ─────────────────────────────

/// `viz_q_tq_file_plan`: per fragment, the row groups of a `spans` file whose span starts
/// overlap `[lo, hi]`, or of a `trace_index` file whose fragments overlap it and (with an id)
/// whose trace id range holds the id. With `ranges` (ABI 8; none: all of `[lo, hi]`), a row group
/// must also overlap one of them: the ranges `viz_q_tq_extent` gave, so that a trace query reads
/// the flush units its traces' pieces lie in, not every unit of their hull.
pub(crate) fn do_tq_file_plan(mut r: Req<'_>) -> Res<Vec<u8>> {
    let gap = r.u64("gap")?;
    let table = r.u8("table")?;
    let (lo, hi) = (r.i64("lo")?, r.i64("hi")?);
    let id = read_id(&mut r)?;
    let n = r.u32("n_ranges")?;
    let mut ranges: Vec<(i64, i64)> = Vec::with_capacity((n as usize).min(4096));
    for _ in 0..n {
        ranges.push((r.i64("range lo")?, r.i64("range hi")?));
    }
    ranges.sort_unstable();
    let raw = r.files("index fragment")?;
    r.end()?;
    if table > 1 {
        return Err(Fail::Malformed(format!("unknown table {table}")));
    }
    let plans: Vec<serde_json::Value> = raw
        .iter()
        .map(|b| {
            let Some(f) = std::str::from_utf8(b).ok().and_then(sigfiles::Frag::parse) else { return crate::plan_json(&sigfiles::unknown()) };
            let groups: Vec<usize> = f
                .rg
                .iter()
                .enumerate()
                .filter(|(_, g)| {
                    let time = g.max_ts >= lo && g.min_ts <= hi && (ranges.is_empty() || in_ranges(&ranges, g.min_ts, g.max_ts));
                    let tid = match (table, id) {
                        (1, Some(id)) => g.min_tid.is_none_or(|a| a <= id) && g.max_tid.is_none_or(|b| id <= b),
                        _ => true,
                    };
                    time && tid
                })
                .map(|(i, _)| i)
                .collect();
            crate::plan_json(&f.decide(&groups, gap))
        })
        .collect();
    Ok(serde_json::Value::Array(plans).to_string().into_bytes())
}

/// Whether `[a, b]` overlaps one of `ranges` (sorted by start, disjoint).
fn in_ranges(ranges: &[(i64, i64)], a: i64, b: i64) -> bool {
    // The last range that starts at or before `b`, and those before it while they may still end
    // at or after `a`: disjoint and sorted, so only the last one can.
    let k = ranges.partition_point(|x| x.0 <= b);
    k > 0 && ranges[k - 1].1 >= a
}

fn read_id(r: &mut Req<'_>) -> Res<Option<[u8; 16]>> {
    Ok(match r.u8("has_id")? {
        0 => None,
        1 => {
            let mut id = [0u8; 16];
            id.copy_from_slice(r.take(16, "trace id")?);
            Some(id)
        }
        x => return Err(Fail::Malformed(format!("has_id is {x}"))),
    })
}

// ───────────────────────────── extents ─────────────────────────────

/// Bytes charged per trace id a pass holds (16 bytes in a hash set, with its growth), per tail
/// piece held for the passes, per range before they are merged, and per hour in the answer.
const ID_BYTES: u64 = 64;
const PIECE_BYTES: u64 = 48;
const RANGE_BYTES: u64 = 32;
const HOUR_BYTES: u64 = 32;
/// At most this many ranges are returned; beyond it the closest are joined (a superset).
const MAX_RANGES: usize = 256;
const HOUR: i64 = 3_600_000_000_000;

/// `viz_q_tq_extent`: the traces whose extent overlaps `[lo, hi]` (or the one trace `id`), from
/// `trace_index` fragments and the spans of the tail: how many, the hull of their extents, the
/// `spans` hours that hold them (`contracts/TRACES.md`, `trace_index.hours`), and (ABI 8) the
/// ranges their pieces cover. A piece is a fragment that overlaps `bound`, or a tail span that
/// starts in it (ABI 7): nothing outside the bound counts, and the hull, hours and ranges are cut
/// to it, as the span calls cut the data to the same bound ([`Budget`]). So the traces found and
/// the spans the planner reads for them do not depend on which files or row groups outside the
/// bound were read, and every span of a found trace that starts inside the bound starts inside
/// one of the ranges: it lies within its own unit's fragment, a piece (D62).
///
/// A trace is found when its extent, merged over all its pieces, overlaps the window: when a
/// piece overlaps the window, or when it has a piece wholly before the window and one wholly
/// after it. The call does not hold every trace of the bound (review r2, R2-M3a: an extent per
/// trace of the window plus 4 h refused a one-minute search at about 10 traces/s). It reads the
/// pieces in passes, reading only the columns it needs:
///   1. the ids of the traces with a piece in the window, and of those with a piece after it;
///   2. a trace with a piece before the window and one after it, none in it, is found too; the
///      ids after the window are let go;
///   3. the hull, hours and ranges of the found traces' pieces.
/// What it holds is the found traces' ids, and while pass 2 runs, the ids of the traces with a
/// piece in the margin AFTER the window (none for a window that ends now), each charged.
pub(crate) fn do_tq_extent(mut r: Req<'_>) -> Res<Vec<u8>> {
    let (lo, hi) = (r.i64("lo")?, r.i64("hi")?);
    let id = read_id(&mut r)?;
    let (blo, bhi) = (r.i64("bound_lo")?, r.i64("bound_hi")?);
    let mut mem = Mem::new(r.u64("max_bytes")?);
    let index = r.files("trace_index file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    if blo > bhi {
        return Err(Fail::Malformed(format!("bound [{blo}, {bhi}] is empty")));
    }
    let hour_in = |h: i32| {
        let start = (h as i64).saturating_mul(HOUR);
        start.saturating_add(HOUR - 1) >= blo && start <= bhi
    };
    let in_bound = |a: i64, b: i64| b >= blo && a <= bhi;
    // The tail's pieces inside the bound, held once for the passes (a tail is at most
    // `maxFetchBytes`, and its batches are decoded once rather than once a pass).
    mem.stage = "the unflushed spans it reads";
    let mut tail: Vec<([u8; 16], i64, i64)> = Vec::new();
    for b in &tails {
        sigfiles::batch_span_times(b, |t, start, end| {
            if start >= blo && start <= bhi && id.is_none_or(|x| x == t) {
                mem.charge(PIECE_BYTES)?;
                tail.push((t, start, end));
            }
            Ok(())
        })?;
    }
    // Pass 1 (by id: the trace has a piece). `found`: a piece overlaps the window; `after`: a
    // piece lies wholly after it.
    let mut found: std::collections::HashSet<[u8; 16]> = std::collections::HashSet::new();
    let mut after: std::collections::HashSet<[u8; 16]> = std::collections::HashSet::new();
    {
        let mut pass1 = |t: [u8; 16], a: i64, b: i64, mem: &mut Mem| -> Res<()> {
            if !in_bound(a, b) || id.is_some_and(|x| x != t) {
                return Ok(());
            }
            if id.is_some() || (b >= lo && a <= hi) {
                if !found.contains(&t) {
                    mem.help = WINDOW_HELP;
                    mem.charge_for("the traces of the window", ID_BYTES)?;
                    found.insert(t);
                }
            } else if a > hi && !after.contains(&t) {
                mem.help = MARGIN_HELP;
                mem.charge_for("the ids of the traces in the margin after the window", ID_BYTES)?;
                after.insert(t);
            }
            Ok(())
        };
        for f in &index {
            sigfiles::read_trace_extents(f, false, |t, a, b, _| pass1(t, a, b, &mut mem))?;
        }
        for &(t, a, b) in &tail {
            pass1(t, a, b, &mut mem)?;
        }
    }
    // Pass 2: a trace with a piece wholly before the window and one wholly after it.
    if !after.is_empty() {
        let mut straddle: Vec<[u8; 16]> = Vec::new();
        mem.help = MARGIN_HELP;
        let mut pass2 = |t: [u8; 16], a: i64, b: i64, mem: &mut Mem| -> Res<()> {
            if in_bound(a, b) && b < lo && !found.contains(&t) && after.remove(&t) {
                mem.charge_for("the traces that straddle the window", ID_BYTES)?;
                straddle.push(t);
            }
            Ok(())
        };
        for f in &index {
            sigfiles::read_trace_extents(f, false, |t, a, b, _| pass2(t, a, b, &mut mem))?;
        }
        for &(t, a, b) in &tail {
            pass2(t, a, b, &mut mem)?;
        }
        mem.release(ID_BYTES * (after.len() + straddle.len()) as u64);
        drop(after);
        for t in straddle {
            found.insert(t);
        }
    }
    // Pass 3: hull, hours and ranges of the found traces' pieces, cut to the bound.
    mem.stage = "the ranges of the traces found";
    mem.help = "Narrow the time range.";
    let (mut hull, mut hours, mut ranges) = ((i64::MAX, i64::MIN), BTreeSet::new(), Vec::new());
    let mut pass3 = |t: [u8; 16], a: i64, b: i64, hs: &mut dyn Iterator<Item = i32>, mem: &mut Mem| -> Res<()> {
        if !in_bound(a, b) || !found.contains(&t) {
            return Ok(());
        }
        let (a, b) = (a.max(blo), b.min(bhi).max(a.max(blo)));
        hull = (hull.0.min(a), hull.1.max(b));
        for h in hs.filter(|h| hour_in(*h)) {
            if !hours.contains(&h) {
                mem.charge(HOUR_BYTES)?;
                hours.insert(h);
            }
        }
        mem.charge(RANGE_BYTES)?;
        ranges.push((a, b));
        if ranges.len() >= 8192 {
            let before = ranges.len();
            merge(&mut ranges, MAX_RANGES);
            mem.release(RANGE_BYTES * (before - ranges.len()) as u64);
        }
        Ok(())
    };
    if !found.is_empty() {
        for f in &index {
            sigfiles::read_trace_extents(f, true, |t, a, b, hs| pass3(t, a, b, &mut hs.iter().copied(), &mut mem))?;
        }
        for &(t, a, b) in &tail {
            pass3(t, a, b, &mut std::iter::once(a.div_euclid(HOUR) as i32), &mut mem)?;
        }
    }
    merge(&mut ranges, MAX_RANGES);
    let n = found.len() as u64;
    let mut out = serde_json::json!({"traces": n, "hours": hours.into_iter().collect::<Vec<_>>()});
    if n > 0 && hull.0 <= hull.1 {
        // The planner reads spans by start: none of the data starts after the bound.
        out["lo"] = hull.0.to_string().into();
        out["hi"] = hull.1.min(bhi).max(hull.0).to_string().into();
        out["ranges"] = ranges.iter().map(|(a, b)| serde_json::json!([a.to_string(), b.to_string()])).collect::<Vec<_>>().into();
    }
    Ok(out.to_string().into_bytes())
}

/// What a refusal while the window's traces are held advises.
const WINDOW_HELP: &str = "Narrow the time range: every trace with a span in the window is held.";
/// What a refusal while the margin's traces are held advises (review r2, R2-m5).
const MARGIN_HELP: &str = "The traces with a span up to traceMarginMs after the window are held to find those that straddle it: a shorter window does not reduce them, a window that ends nearer the present does, and so does a smaller traceMarginMs (the operator's limit).";

#[cfg(test)]
pub(crate) fn merge_for_test(ranges: &mut Vec<(i64, i64)>, most: usize) {
    merge(ranges, most)
}

/// Sort, join overlapping and touching ranges, and then join the closest until at most `most`
/// remain (each join only widens: every range covers what it covered).
fn merge(ranges: &mut Vec<(i64, i64)>, most: usize) {
    ranges.sort_unstable();
    let mut out: Vec<(i64, i64)> = Vec::with_capacity(ranges.len().min(most * 2));
    for &(a, b) in ranges.iter() {
        match out.last_mut() {
            Some(last) if a <= last.1.saturating_add(1) => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    if out.len() > most {
        // The gaps between neighbours, smallest first: join every gap up to the one that leaves
        // `most` ranges (ties may leave fewer).
        let mut gaps: Vec<i64> = out.windows(2).map(|w| w[1].0 - w[0].1).collect();
        gaps.sort_unstable();
        let cut = gaps[out.len() - most - 1];
        let mut joined: Vec<(i64, i64)> = Vec::with_capacity(most);
        for &(a, b) in &out {
            match joined.last_mut() {
                Some(last) if a - last.1 <= cut => last.1 = last.1.max(b),
                _ => joined.push((a, b)),
            }
        }
        out = joined;
    }
    *ranges = out;
}

// ───────────────────────────── search and metrics ─────────────────────────────

/// `u64 spans decoded, u64 traces`, then the body (charged to the budget before it was written).
fn counts(budget: &Budget, traces: usize, json: String) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + json.len());
    out.extend_from_slice(&budget.decoded.to_le_bytes());
    out.extend_from_slice(&(traces as u64).to_le_bytes());
    out.extend_from_slice(json.as_bytes());
    out
}

/// What a refusal of a search or a whole-trace metrics query advises: the window decides what is
/// held, the query's conditions do not (review r2, R2-m5).
const SEARCH_HELP: &str = "Narrow the time range: every span of every trace that overlaps the window is held (its spans up to traceMarginMs outside the window too), whatever the query's conditions.";

/// `viz_q_tq_search`: Tempo's `/api/search` body for a TraceQL query over the files and the tail.
pub(crate) fn do_tq_search(mut r: Req<'_>) -> Res<Vec<u8>> {
    let mut budget = Budget::read(&mut r)?;
    let (limit, spss) = (r.u32("limit")?, r.u32("spss")?);
    let (start, end) = (r.i64("start")?, r.i64("end")?);
    let q = r.str("query")?;
    let files = r.files("spans file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    budget.advise(SEARCH_HELP);
    // Refuse a bad query before reading anything.
    viz_traceql::parse(q).map_err(tq_err)?;
    let ts = traces(&files, &tails, &mut budget, None)?;
    let n = ts.len();
    let req = SearchRequest { limit, spans_per_spanset: spss, start_unix_nano: start.max(0) as u64, end_unix_nano: end.max(0) as u64 };
    let out = viz_traceql::search(&MemSource::new(ts), q, &req).map_err(tq_err)?;
    // The answer's exact length, charged before it is written.
    budget.mem.help = "Narrow the time range, or lower limit or spss.";
    budget.mem.charge_answer(out.json_len())?;
    Ok(counts(&budget, n, out.to_json()))
}

/// What a TraceQL metrics evaluation was holding when it was refused, as a refusal says it.
fn metrics_stage(what: &str) -> &'static str {
    match what {
        "histogram buckets" => "the histogram buckets it counts at each point",
        "histogram series" => "the histogram's series (one per bucket and group, with every point)",
        "sums" => "the exact sums it keeps",
        _ => "the series it makes (every point of each, one per quantile)",
    }
}

/// `viz_q_tq_metrics`: Tempo's `/api/metrics/query_range` (or `/query`, `instant`) body.
/// The request is used as given: the caller aligns it (`viz_q_tq_plan`). What the evaluation
/// makes (every series' accumulator, histogram buckets and output series, one per quantile or
/// bucket) is charged as it is made, against what the budget leaves once the spans are held
/// (`viz_traceql::metrics::Meter`, ABI 8; review r2 R2-M2: before, only points were charged, 48
/// bytes each, and a histogram's buckets not at all), and the answer before it is written.
pub(crate) fn do_tq_metrics(mut r: Req<'_>) -> Res<Vec<u8>> {
    let mut budget = Budget::read(&mut r)?;
    let max_series = usize::try_from(r.u64("max_series")?).unwrap_or(usize::MAX);
    let max_points = r.u64("max_points")?;
    let instant = r.u8("instant")? == 1;
    let (start, end, step) = (r.i64("start")?.max(0) as u64, r.i64("end")?.max(0) as u64, r.i64("step")?.max(0) as u64);
    let q = r.str("query")?;
    let files = r.files("spans file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    let req = if instant { RangeRequest::instant(start, end) } else { RangeRequest::range(start, end, step) };
    let p = viz_traceql::plan(q, req.start_unix_nano, req.end_unix_nano).map_err(tq_err)?;
    // A span-local plan is evaluated over the spans that start in the window only (what the
    // engine's own pruning drops, `ReadPlan::span_may_match`), after de-duplication.
    let local = !(p.full_traces || !p.span_local || p.columns.iter().any(trace_level));
    budget.advise(if local { "Narrow the time range." } else { SEARCH_HELP });
    let window = if local { p.span_window } else { None };
    let ts = traces(&files, &tails, &mut budget, window)?;
    let n = ts.len();
    let limits = viz_traceql::Limits { max_series, max_points, max_bytes: budget.mem.left() };
    let out = viz_traceql::query_range_with(&MemSource::new(ts), q, &req, &limits).map_err(|e| match e {
        viz_traceql::Error::Memory { what, used, .. } => {
            budget.mem.stage = metrics_stage(what);
            budget.mem.help = "Use a longer step, group by fewer values, ask for fewer quantiles, or narrow the time range.";
            budget.mem.refusal(budget.mem.used.saturating_add(used))
        }
        e => tq_err(e),
    })?;
    // The series returned stay held while the answer is written: their charge, then the answer's
    // exact length, before it is written.
    budget.mem.help = "Use a longer step, group by fewer values, or narrow the time range.";
    budget.mem.charge_for("the series it makes", out.held_bytes)?;
    budget.mem.charge_answer(out.json_len())?;
    Ok(counts(&budget, n, out.to_json()))
}

// ───────────────────────────── trace by ID ─────────────────────────────

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            if k <= c.len() {
                s.push(B64[(n >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// Where the trace writers put text: a `String`, or a count of the bytes they would write, so
/// that each span's text is charged before it is written ([`trace_json`]).
pub(crate) trait Out {
    fn push_str(&mut self, s: &str);
    fn push(&mut self, c: char);
}
impl Out for String {
    fn push_str(&mut self, s: &str) {
        String::push_str(self, s)
    }
    fn push(&mut self, c: char) {
        String::push(self, c)
    }
}
/// A count of bytes written.
struct Len(u64);
impl Out for Len {
    fn push_str(&mut self, s: &str) {
        self.0 += s.len() as u64;
    }
    fn push(&mut self, c: char) {
        self.0 += c.len_utf8() as u64;
    }
}

pub(crate) fn esc<O: Out>(s: &str, out: &mut O) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// ECMAScript `Number.prototype.toString` of a finite double (the form canonical OTLP JSON
/// uses, `contracts/BATCH.md`), from Rust's shortest round-trip digits.
fn js_number(v: f64) -> String {
    if v == 0.0 {
        return "0".into();
    }
    let e = format!("{:e}", v.abs());
    let (mant, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    let sign = if v < 0.0 { "-" } else { "" };
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e < 0 { format!("e-{}", -e) } else { format!("e+{e}") };
        if k == 1 {
            format!("{digits}{es}")
        } else {
            format!("{}.{}{es}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

fn any_json<O: Out>(v: &Value<String>, out: &mut O) {
    match v {
        Value::Str(s) => {
            out.push_str("{\"stringValue\":");
            esc(s, out);
            out.push('}');
        }
        Value::Int(i) => out.push_str(&format!("{{\"intValue\":\"{i}\"}}")),
        Value::Double(b) => {
            let d = f64::from_bits(*b);
            let t = if d.is_nan() {
                "\"NaN\"".to_string()
            } else if d.is_infinite() {
                if d > 0.0 { "\"Infinity\"" } else { "\"-Infinity\"" }.to_string()
            } else {
                js_number(d)
            };
            out.push_str(&format!("{{\"doubleValue\":{t}}}"));
        }
        Value::Bool(b) => out.push_str(&format!("{{\"boolValue\":{b}}}")),
        // Already canonical OTLP JSON of the AnyValue.
        Value::Other(o) => out.push_str(o),
    }
}

fn attrs_json<O: Out>(attrs: &[viz_storage::otel::Attr<String>], out: &mut O) {
    out.push('[');
    for (i, a) in attrs.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"key\":");
        esc(&a.key, out);
        out.push_str(",\"value\":");
        any_json(&a.value, out);
        out.push('}');
    }
    out.push(']');
}

const KINDS: [&str; 6] = ["SPAN_KIND_UNSPECIFIED", "SPAN_KIND_INTERNAL", "SPAN_KIND_SERVER", "SPAN_KIND_CLIENT", "SPAN_KIND_PRODUCER", "SPAN_KIND_CONSUMER"];
const STATUSES: [&str; 3] = ["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"];

fn span_json<O: Out>(s: &SpanRec, out: &mut O) {
    out.push_str(&format!("{{\"traceId\":\"{}\",\"spanId\":\"{}\"", base64(&s.trace_id), base64(&s.span_id)));
    if !s.trace_state.is_empty() {
        out.push_str(",\"traceState\":");
        esc(&s.trace_state, out);
    }
    if let Some(p) = s.parent {
        out.push_str(&format!(",\"parentSpanId\":\"{}\"", base64(&p)));
    }
    if s.flags != 0 {
        out.push_str(&format!(",\"flags\":{}", s.flags));
    }
    out.push_str(",\"name\":");
    esc(&s.name, out);
    out.push_str(&format!(",\"kind\":\"{}\"", KINDS.get(s.kind as usize).unwrap_or(&KINDS[0])));
    out.push_str(&format!(",\"startTimeUnixNano\":\"{}\",\"endTimeUnixNano\":\"{}\"", s.start, s.end));
    if !s.attrs.is_empty() {
        out.push_str(",\"attributes\":");
        attrs_json(&s.attrs, out);
    }
    if s.dropped[0] != 0 {
        out.push_str(&format!(",\"droppedAttributesCount\":{}", s.dropped[0]));
    }
    if !s.events.is_empty() {
        out.push_str(",\"events\":[");
        for (i, e) in s.events.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!("{{\"timeUnixNano\":\"{}\",\"name\":", e.time_unix_nano));
            esc(&e.name, out);
            if e.attrs != "[]" && !e.attrs.is_empty() {
                out.push_str(",\"attributes\":");
                out.push_str(&e.attrs);
            }
            out.push('}');
        }
        out.push(']');
    }
    if s.dropped[1] != 0 {
        out.push_str(&format!(",\"droppedEventsCount\":{}", s.dropped[1]));
    }
    if !s.links.is_empty() {
        out.push_str(",\"links\":[");
        for (i, l) in s.links.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!("{{\"traceId\":\"{}\",\"spanId\":\"{}\"", base64(&l.trace_id), base64(&l.span_id)));
            if !l.trace_state.is_empty() {
                out.push_str(",\"traceState\":");
                esc(&l.trace_state, out);
            }
            if l.attrs != "[]" && !l.attrs.is_empty() {
                out.push_str(",\"attributes\":");
                out.push_str(&l.attrs);
            }
            out.push('}');
        }
        out.push(']');
    }
    if s.dropped[2] != 0 {
        out.push_str(&format!(",\"droppedLinksCount\":{}", s.dropped[2]));
    }
    out.push_str(",\"status\":{");
    let mut parts = Vec::new();
    if !s.status_message.is_empty() {
        let mut m = String::new();
        esc(&s.status_message, &mut m);
        parts.push(format!("\"message\":{m}"));
    }
    if s.status != 0 {
        parts.push(format!("\"code\":\"{}\"", STATUSES.get(s.status as usize).unwrap_or(&STATUSES[0])));
    }
    out.push_str(&parts.join(","));
    out.push_str("}}");
}

/// A trace as OTLP JSON in the protobuf JSON mapping Tempo answers with: resource spans as
/// `batches`, ids in base64, enums by name, 64-bit integers as strings, empty fields left out.
/// Spans in `(start, span_id)` order, grouped by resource and then instrumentation scope in
/// the order their first span appears. Each piece of the text (a resource's attributes, a
/// span) is charged to `mem` before it is written ([`Mem::charge_answer`], its exact length
/// counted first): refused before the text passes the budget (ABI 8; before, after one span).
pub(crate) fn trace_json(spans: &[SpanRec], mem: &mut Mem, wrap: &str) -> Res<String> {
    let mut res: Vec<(&[viz_storage::otel::Attr<String>], Vec<((&str, &str, &str), Vec<&SpanRec>)>)> = Vec::new();
    for s in spans {
        let ri = match res.iter().position(|(r, _)| std::ptr::eq(*r, s.resource.as_slice()) || *r == s.resource.as_slice()) {
            Some(i) => i,
            None => {
                res.push((&s.resource, Vec::new()));
                res.len() - 1
            }
        };
        let scope = (s.scope_name.as_str(), s.scope_version.as_str(), s.scope_attrs.as_str());
        let scopes = &mut res[ri].1;
        match scopes.iter_mut().find(|(k, _)| *k == scope) {
            Some((_, v)) => v.push(s),
            None => scopes.push((scope, vec![s])),
        }
    }
    let mut out = String::from(wrap);
    out.push_str("{\"batches\":[");
    for (i, (r, scopes)) in res.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        // A resource's attributes are written once per batch.
        let mut len = Len(13);
        if !r.is_empty() {
            len.push_str("\"attributes\":");
            attrs_json(r, &mut len);
        }
        mem.charge_answer(len.0)?;
        out.push_str("{\"resource\":{");
        if !r.is_empty() {
            out.push_str("\"attributes\":");
            attrs_json(r, &mut out);
        }
        out.push_str("},\"scopeSpans\":[");
        for (j, ((name, version, attrs), list)) in scopes.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str("{\"scope\":{");
            let mut parts = Vec::new();
            if !name.is_empty() {
                let mut x = String::new();
                esc(name, &mut x);
                parts.push(format!("\"name\":{x}"));
            }
            if !version.is_empty() {
                let mut x = String::new();
                esc(version, &mut x);
                parts.push(format!("\"version\":{x}"));
            }
            if !attrs.is_empty() && *attrs != "[]" {
                parts.push(format!("\"attributes\":{attrs}"));
            }
            out.push_str(&parts.join(","));
            out.push_str("},\"spans\":[");
            for (k, s) in list.iter().enumerate() {
                if k > 0 {
                    out.push(',');
                }
                // Charged before it is written.
                let mut len = Len(0);
                span_json(s, &mut len);
                mem.charge_answer(len.0)?;
                span_json(s, &mut out);
            }
            out.push_str("]}");
        }
        out.push_str("]}");
    }
    out.push_str("]}");
    if !wrap.is_empty() {
        out.push('}');
    }
    Ok(out)
}

/// `viz_q_tq_trace`: one trace by ID: `u8 found`, `u64 spans decoded`, then Tempo's v1 body
/// (`{"batches":[…]}`) or v2 body (`{"trace":{"batches":[…]}}`); nothing after the counts when
/// no span of the trace was read. Only the trace's own spans are part of the data (ABI 8; review
/// r2 R2-M4a): a span of another trace in the same row group is read to find the trace's and
/// passed over before it is decoded, so it is neither held nor counted against `max_spans`.
pub(crate) fn do_tq_trace(mut r: Req<'_>) -> Res<Vec<u8>> {
    let version = r.u8("version")?;
    let mut id = [0u8; 16];
    id.copy_from_slice(r.take(16, "trace id")?);
    let mut budget = Budget::read(&mut r)?;
    let files = r.files("spans file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    budget.only = Some(id);
    budget.advise(TRACE_HELP);
    let mut spans = latest_records(&files, &tails, &mut budget, |_| true)?;
    spans.sort_by(|a, b| (a.start, a.span_id).cmp(&(b.start, b.span_id)));
    let mut out = vec![(!spans.is_empty()) as u8];
    out.extend_from_slice(&budget.decoded.to_le_bytes());
    if !spans.is_empty() {
        let body = trace_json(&spans, &mut budget.mem, if version == 2 { "{\"trace\":" } else { "" })?;
        drop(spans);
        out.extend_from_slice(body.as_bytes());
    }
    Ok(out)
}

/// What a refusal of trace by ID advises: only the trace's own spans are held.
const TRACE_HELP: &str = "The trace's own spans and its answer take more than this: it cannot be answered in one place. With start and end, only its spans within traceMarginMs of them are read.";

// ───────────────────────────── tags ─────────────────────────────

/// The intrinsic tag names, as Tempo's documentation of `/api/v2/search/tags` lists them.
const INTRINSICS: [&str; 20] = [
    "duration", "event:name", "event:timeSinceStart", "instrumentation:name", "instrumentation:version", "kind", "name", "rootName", "rootServiceName", "span:duration", "span:kind", "span:name",
    "span:status", "span:statusMessage", "status", "statusMessage", "trace:duration", "trace:rootName", "trace:rootService", "traceDuration",
];
const SCOPES: [&str; 6] = ["resource", "span", "intrinsic", "event", "link", "instrumentation"];

/// `viz_q_tq_tags`: tag names of the spans that start in `[lo, hi]`. Version 1:
/// `{"tagNames":[…]}` (no scope: resource and span); version 2: `{"scopes":[{"name","tags"}…]}`
/// (no scope: every scope that has a tag). Sorted by UTF-8 bytes, at most `limit` per scope (0: all).
pub(crate) fn do_tq_tags(mut r: Req<'_>) -> Res<Vec<u8>> {
    let version = r.u8("version")?;
    let scope = r.str("scope")?.to_string();
    let (lo, hi) = (r.i64("lo")?, r.i64("hi")?);
    let limit = r.u32("limit")? as usize;
    let mut budget = Budget::new(r.u64("max_spans")?, r.u64("max_bytes")?, ALL_TIME);
    let files = r.files("spans file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    if !scope.is_empty() && !SCOPES.contains(&scope.as_str()) {
        return Err(Fail::Query(QueryError::bad_data(format!("unknown scope {scope:?}: one of resource, span, intrinsic, event, link, instrumentation"))));
    }
    budget.advise("Narrow the time range.");
    let spans = latest_records(&files, &tails, &mut budget, |start| start >= lo && start <= hi)?;
    // Each name is charged when it is first kept.
    budget.mem.stage = "the tag names it lists";
    let mut names: BTreeMap<&str, BTreeSet<String>> = SCOPES.iter().map(|s| (*s, BTreeSet::new())).collect();
    names.get_mut("intrinsic").unwrap().extend(INTRINSICS.iter().map(|s| s.to_string()));
    let mem = &mut budget.mem;
    let mut put = |scope: &str, name: String, mem: &mut Mem| -> Res<()> {
        let set = names.get_mut(scope).expect("a scope");
        if !set.contains(&name) {
            mem.charge(KEPT + name.len() as u64)?;
            set.insert(name);
        }
        Ok(())
    };
    for s in &spans {
        for a in s.resource.iter() {
            put("resource", a.key.clone(), mem)?;
        }
        for a in &s.attrs {
            put("span", a.key.clone(), mem)?;
        }
        for e in &s.events {
            for (k, _) in sigfiles::kv_texts(&e.attrs)? {
                put("event", k, mem)?;
            }
        }
        for l in &s.links {
            for (k, _) in sigfiles::kv_texts(&l.attrs)? {
                put("link", k, mem)?;
            }
        }
        if !s.scope_attrs.is_empty() {
            for (k, _) in sigfiles::kv_texts(&s.scope_attrs)? {
                put("instrumentation", k, mem)?;
            }
        }
    }
    drop(spans);
    let take = if limit == 0 { usize::MAX } else { limit };
    // The answer (`serde_json`'s form: keys in order), its exact length charged before it is written.
    let list = |out: &mut String, set: &mut dyn Iterator<Item = &String>| {
        out.push('[');
        for (i, x) in set.take(take).enumerate() {
            if i > 0 {
                out.push(',');
            }
            sigfiles::json_str(x, out);
        }
        out.push(']');
    };
    let list_len = |set: &mut dyn Iterator<Item = &String>| -> u64 { 2 + set.take(take).map(|x| 1 + sigfiles::json_str_len(x)).sum::<u64>() };
    if version == 1 {
        let wanted: Vec<&str> = if scope.is_empty() { vec!["resource", "span"] } else { vec![scope.as_str()] };
        let mut all: BTreeSet<&String> = BTreeSet::new();
        for w in wanted {
            all.extend(names[w].iter());
        }
        let len = 27 + list_len(&mut all.iter().copied());
        budget.mem.charge_answer(len)?;
        let mut out = String::with_capacity(len as usize);
        out.push_str("{\"metrics\":{},\"tagNames\":");
        list(&mut out, &mut all.iter().copied());
        out.push('}');
        Ok(out.into_bytes())
    } else {
        let chosen: Vec<&str> = SCOPES.iter().copied().filter(|s| if scope.is_empty() { !names[*s].is_empty() } else { *s == scope }).collect();
        let len = 25 + chosen.iter().map(|s| 21 + s.len() as u64 + list_len(&mut names[*s].iter())).sum::<u64>();
        budget.mem.charge_answer(len)?;
        let mut out = String::with_capacity(len as usize);
        out.push_str("{\"metrics\":{},\"scopes\":[");
        for (i, s) in chosen.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"name\":");
            sigfiles::json_str(s, &mut out);
            out.push_str(",\"tags\":");
            list(&mut out, &mut names[*s].iter());
            out.push('}');
        }
        out.push_str("]}");
        Ok(out.into_bytes())
    }
}

/// Bytes charged per tag name or value a tag call keeps (its set's node share and string
/// header), beside the text.
const KEPT: u64 = 64;

/// A typed tag value (`/api/v2/search/tag/<tag>/values`: `{"type","value"}`).
fn typed(v: &AttrValue) -> Option<(&'static str, String)> {
    Some(match v {
        AttrValue::Str(s) => ("string", s.clone()),
        AttrValue::Int(i) => ("int", i.to_string()),
        AttrValue::Float(f) => ("float", if f.is_finite() { js_number(*f) } else { f.to_string() }),
        AttrValue::Bool(b) => ("bool", b.to_string()),
        _ => return None,
    })
}

/// What a tag names: `(scope, key)` of an attribute (`Scope::None`: span, then resource), or an intrinsic.
enum Tag {
    Attr(Scope, String),
    Name,
    Status,
    Kind,
    StatusMessage,
}

fn tag_of(version: u8, t: &str) -> Res<Tag> {
    let intrinsic = |n: &str| match n {
        "name" | "span:name" => Some(Tag::Name),
        "status" | "span:status" => Some(Tag::Status),
        "kind" | "span:kind" => Some(Tag::Kind),
        "statusMessage" | "span:statusMessage" => Some(Tag::StatusMessage),
        _ => None,
    };
    if let Some(i) = intrinsic(t) {
        return Ok(i);
    }
    if version == 1 {
        // `/api/search/tag/<tag>/values`: an attribute name, of a span or its resource.
        return Ok(Tag::Attr(Scope::None, t.to_string()));
    }
    for (p, s) in [(".", Scope::None), ("span.", Scope::Span), ("resource.", Scope::Resource), ("event.", Scope::Event), ("link.", Scope::Link), ("instrumentation.", Scope::Instrumentation)] {
        if let Some(k) = t.strip_prefix(p) {
            if !k.is_empty() {
                let k = k.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(k);
                return Ok(Tag::Attr(s, k.to_string()));
            }
        }
    }
    Err(Fail::Query(QueryError::bad_data(format!("not a TraceQL attribute or supported intrinsic: {t:?}"))))
}

/// `viz_q_tq_tag_values`: values of one tag on the spans that start in `[lo, hi]` (and, with
/// a filter `q`, that match it: Tempo's filtered tag values; a filter that does not parse
/// filters nothing, as Tempo documents). Version 1: `{"tagValues":["…"]}` (string values);
/// version 2: `{"tagValues":[{"type","value"}]}`. Sorted, unique, at most `limit` (0: all).
pub(crate) fn do_tq_tag_values(mut r: Req<'_>) -> Res<Vec<u8>> {
    let version = r.u8("version")?;
    let tag = tag_of(version, r.str("tag")?)?;
    let q = r.str("q")?.to_string();
    let (lo, hi) = (r.i64("lo")?, r.i64("hi")?);
    let limit = r.u32("limit")? as usize;
    let mut budget = Budget::new(r.u64("max_spans")?, r.u64("max_bytes")?, ALL_TIME);
    let files = r.files("spans file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    let filter = (!q.trim().is_empty()).then(|| viz_traceql::parse(&q).ok().filter(|root| matches!(root.query, Query::Search(_))).map(|_| q.clone())).flatten();
    budget.advise("Narrow the time range, or pass a filter (q) that matches fewer spans.");
    let recs = latest_records(&files, &tails, &mut budget, |start| start >= lo && start <= hi)?;
    let mut grouped: BTreeMap<[u8; 16], Vec<viz_traceql::Span>> = BTreeMap::new();
    // Each record is let go as its engine span is made, so the two are not held whole at once.
    for s in recs {
        let span = engine_span(&s, &mut budget.engine_res, &mut budget.mem)?;
        grouped.entry(s.trace_id).or_default().push(span);
    }
    // Each distinct value is charged when it is first kept (ABI 8; review r2 R2-M2: 500 spans
    // with 60 KB values held 107.7 MiB before the answer was charged).
    budget.mem.stage = "the tag values it lists";
    let mut values: BTreeSet<(&'static str, String)> = BTreeSet::new();
    let mut found: Vec<(&'static str, String)> = Vec::new();
    for (t, mut spans) in grouped {
        spans.sort_by(|a, b| (a.start_unix_nano, a.span_id).cmp(&(b.start_unix_nano, b.span_id)));
        let trace = Trace::new(t, spans);
        let chosen: Vec<usize> = match &filter {
            None => (0..trace.spans.len()).collect(),
            Some(q) => {
                let mut v: Vec<usize> = viz_traceql::matching_spansets(q, &trace).map_err(tq_err)?.into_iter().flatten().collect();
                v.sort_unstable();
                v.dedup();
                v
            }
        };
        for i in chosen {
            let s = &trace.spans[i];
            found.clear();
            let mut put = |v: &AttrValue| {
                if let Some(x) = typed(v) {
                    found.push(x);
                }
            };
            match &tag {
                Tag::Name => put(&AttrValue::Str(s.name.clone())),
                Tag::StatusMessage => put(&AttrValue::Str(s.status_message.clone())),
                Tag::Status => found.push(("keyword", s.status.name().to_string())),
                Tag::Kind => found.push(("keyword", s.kind.name().to_string())),
                Tag::Attr(scope, k) => {
                    let get = |list: &[(String, AttrValue)]| viz_traceql::data::attr(list, k).cloned();
                    match scope {
                        Scope::Span => get(&s.attrs).iter().for_each(&mut put),
                        Scope::Resource => get(&s.resource).iter().for_each(&mut put),
                        Scope::None => {
                            get(&s.attrs).iter().for_each(&mut put);
                            get(&s.resource).iter().for_each(&mut put);
                        }
                        Scope::Event => s.events.iter().for_each(|e| get(&e.attrs).iter().for_each(&mut put)),
                        Scope::Link => s.links.iter().for_each(|l| get(&l.attrs).iter().for_each(&mut put)),
                        Scope::Instrumentation => get(&s.scope_attrs).iter().for_each(&mut put),
                    }
                }
            }
            for x in found.drain(..) {
                if !values.contains(&x) {
                    budget.mem.charge(KEPT + x.1.len() as u64)?;
                    values.insert(x);
                }
            }
        }
    }
    let take = if limit == 0 { usize::MAX } else { limit };
    // The answer (`serde_json`'s form, keys in order), its exact length charged before it is written.
    if version == 1 {
        let v: BTreeSet<&String> = values.iter().filter(|(t, _)| *t == "string").map(|(_, v)| v).collect();
        let len = 28 + v.iter().take(take).map(|x| 1 + sigfiles::json_str_len(x)).sum::<u64>();
        budget.mem.charge_answer(len)?;
        let mut out = String::with_capacity(len as usize);
        out.push_str("{\"metrics\":{},\"tagValues\":[");
        for (i, x) in v.iter().take(take).enumerate() {
            if i > 0 {
                out.push(',');
            }
            sigfiles::json_str(x, &mut out);
        }
        out.push_str("]}");
        Ok(out.into_bytes())
    } else {
        let len = 28 + values.iter().take(take).map(|(t, v)| 22 + t.len() as u64 + sigfiles::json_str_len(v)).sum::<u64>();
        budget.mem.charge_answer(len)?;
        let mut out = String::with_capacity(len as usize);
        out.push_str("{\"metrics\":{},\"tagValues\":[");
        for (i, (t, v)) in values.iter().take(take).enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"type\":");
            sigfiles::json_str(t, &mut out);
            out.push_str(",\"value\":");
            sigfiles::json_str(v, &mut out);
            out.push('}');
        }
        out.push_str("]}");
        Ok(out.into_bytes())
    }
}
