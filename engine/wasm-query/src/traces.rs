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
use crate::sigfiles::{self, Mem, Resources, SpanRec};
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
/// * `max_spans`: spans held (inside the bound), the tail's included; `spans` counts them.
/// * `mem`: the bytes of what is held ([`Mem`]); `resources`: one copy per distinct resource.
/// * `decoded`: every span read, the dropped ones included (reported, not limited).
pub(crate) struct Budget {
    pub max_spans: u64,
    pub spans: u64,
    pub decoded: u64,
    pub bound: (i64, i64),
    pub mem: Mem,
    pub res: Resources,
    pub engine_res: EngineResources,
}

const ALL_TIME: (i64, i64) = (i64::MIN, i64::MAX);

impl Budget {
    pub fn new(max_spans: u64, max_bytes: u64, bound: (i64, i64)) -> Budget {
        Budget { max_spans, spans: 0, decoded: 0, bound, mem: Mem::new(max_bytes), res: Resources::default(), engine_res: EngineResources::default() }
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
}

fn take(max_spans: u64, spans: &mut u64) -> Res<()> {
    *spans += 1;
    if *spans > max_spans {
        return Err(Fail::Limit("max_spans", max_spans, *spans, format!("query exceeded limit max_spans: more than {max_spans} spans decoded, the limit is {max_spans}. Narrow the time range.")));
    }
    Ok(())
}

/// Every span of the files (in the order given) and then the tail batches that lies inside the
/// bound, to `visit`, each counted against `max_spans` and charged to the memory budget.
fn each_span(files: &[&[u8]], tails: &[&[u8]], budget: &mut Budget, mut visit: impl FnMut(SpanRec, &mut Mem, &mut EngineResources) -> Res<()>) -> Res<()> {
    let (lo, hi) = budget.bound;
    let keep = move |start: i64| start >= lo && start <= hi;
    let Budget { max_spans, spans, decoded, mem, res, engine_res, .. } = budget;
    let max_spans = *max_spans;
    for f in files {
        *decoded += sigfiles::read_spans(f, res, mem, keep, |r, mem| {
            take(max_spans, spans)?;
            mem.charge(sigfiles::span_bytes(&r))?;
            visit(r, mem, engine_res)
        })?;
    }
    for b in tails {
        *decoded += sigfiles::batch_spans(b, res, mem, keep, |r, mem| {
            take(max_spans, spans)?;
            mem.charge(sigfiles::span_bytes(&r))?;
            visit(r, mem, engine_res)
        })?;
    }
    Ok(())
}

/// The spans read, de-duplicated (later wins), as records.
fn latest_records(files: &[&[u8]], tails: &[&[u8]], budget: &mut Budget, want: impl Fn(&SpanRec) -> bool) -> Res<Vec<SpanRec>> {
    let mut by: HashMap<Key, Option<SpanRec>> = HashMap::new();
    each_span(files, tails, budget, |r, _, _| {
        let k = (r.trace_id, r.span_id);
        // The later row wins whether or not it is wanted: an unwanted later copy hides an earlier one.
        by.insert(k, want(&r).then_some(r));
        Ok(())
    })?;
    Ok(by.into_values().flatten().collect())
}

/// Traces of the spans read (later row wins), each with its spans in `(start, span_id)` order
/// and its summary computed from them; traces in `trace_id` order. With `window`, only spans
/// whose start lies in `(lo, hi]` are kept (a metrics query whose plan is span-local).
pub(crate) fn traces(files: &[&[u8]], tails: &[&[u8]], budget: &mut Budget, window: Option<(u64, u64)>) -> Res<Vec<Trace>> {
    let mut by: HashMap<Key, Option<viz_traceql::Span>> = HashMap::new();
    each_span(files, tails, budget, |r, mem, engine_res| {
        let k = (r.trace_id, r.span_id);
        let keep = window.is_none_or(|(lo, hi)| (r.start as u64) > lo && (r.start as u64) <= hi);
        by.insert(k, if keep { Some(engine_span(&r, engine_res, mem)?) } else { None });
        Ok(())
    })?;
    let mut grouped: BTreeMap<[u8; 16], Vec<viz_traceql::Span>> = BTreeMap::new();
    for ((t, _), s) in by {
        if let Some(s) = s {
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
/// whose trace id range holds the id.
pub(crate) fn do_tq_file_plan(mut r: Req<'_>) -> Res<Vec<u8>> {
    let gap = r.u64("gap")?;
    let table = r.u8("table")?;
    let (lo, hi) = (r.i64("lo")?, r.i64("hi")?);
    let id = read_id(&mut r)?;
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
                    let time = g.max_ts >= lo && g.min_ts <= hi;
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

/// `viz_q_tq_extent`: the traces whose extent overlaps `[lo, hi]` (or the one trace `id`),
/// from `trace_index` fragments merged per trace and the spans of the tail: how many, the
/// hull of their extents, and the `spans` hours that hold them (`contracts/TRACES.md`,
/// `trace_index.hours`). Only what lies inside `bound` counts (ABI 7): a fragment that does not
/// overlap it is passed over, a tail span whose start is outside it too, and the hull and hours
/// are cut to it, as the span calls cut the data to the same bound ([`Budget`]). So the
/// traces found and the spans the planner reads for them do not depend on which files or row
/// groups outside the bound were read, and every span of a found trace that starts inside the
/// bound is read: the planner reads the `spans` files of the hull (D62).
pub(crate) fn do_tq_extent(mut r: Req<'_>) -> Res<Vec<u8>> {
    let (lo, hi) = (r.i64("lo")?, r.i64("hi")?);
    let id = read_id(&mut r)?;
    let (blo, bhi) = (r.i64("bound_lo")?, r.i64("bound_hi")?);
    let index = r.files("trace_index file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    if blo > bhi {
        return Err(Fail::Malformed(format!("bound [{blo}, {bhi}] is empty")));
    }
    const HOUR: i64 = 3_600_000_000_000;
    let hour_in = |h: i32| {
        let start = (h as i64).saturating_mul(HOUR);
        start.saturating_add(HOUR - 1) >= blo && start <= bhi
    };
    let mut ext: HashMap<[u8; 16], (i64, i64, BTreeSet<i32>)> = HashMap::new();
    // `a` is the earliest start (cut to the bound) and `b` the latest end of what is added.
    let mut add = |t: [u8; 16], a: i64, b: i64, hours: &mut dyn Iterator<Item = i32>| {
        if id.is_some_and(|x| x != t) {
            return;
        }
        let a = a.max(blo);
        let e = ext.entry(t).or_insert((a, b, BTreeSet::new()));
        e.0 = e.0.min(a);
        e.1 = e.1.max(b);
        e.2.extend(hours.filter(|h| hour_in(*h)));
    };
    for f in &index {
        sigfiles::read_trace_index(f, |g| {
            // A fragment overlaps the bound when some span of it may start inside it.
            if g.max_end >= blo && g.min_start <= bhi {
                add(g.trace_id, g.min_start, g.max_end, &mut g.hours.iter().copied());
            }
            Ok(())
        })?;
    }
    for b in &tails {
        sigfiles::batch_span_times(b, |t, start, end| {
            if start >= blo && start <= bhi {
                add(t, start, end, &mut std::iter::once(start.div_euclid(HOUR) as i32));
            }
            Ok(())
        })?;
    }
    let (mut n, mut hull, mut hours) = (0u64, (i64::MAX, i64::MIN), BTreeSet::new());
    for (_, (a, b, h)) in ext {
        if id.is_none() && (b < lo || a > hi) {
            continue;
        }
        n += 1;
        hull = (hull.0.min(a), hull.1.max(b));
        hours.extend(h);
    }
    let mut out = serde_json::json!({"traces": n, "hours": hours.into_iter().collect::<Vec<_>>()});
    if n > 0 {
        // The planner reads spans by start: none of the data starts after the bound.
        out["lo"] = hull.0.to_string().into();
        out["hi"] = hull.1.min(bhi).max(hull.0).to_string().into();
    }
    Ok(out.to_string().into_bytes())
}

// ───────────────────────────── search and metrics ─────────────────────────────

/// `u64 spans decoded, u64 traces`, then the body; the body is charged to the budget first.
fn counts(budget: &mut Budget, traces: usize, json: String) -> Res<Vec<u8>> {
    budget.mem.charge_answer(json.len() as u64)?;
    let mut out = Vec::with_capacity(16 + json.len());
    out.extend_from_slice(&budget.decoded.to_le_bytes());
    out.extend_from_slice(&(traces as u64).to_le_bytes());
    out.extend_from_slice(json.as_bytes());
    Ok(out)
}

/// `viz_q_tq_search`: Tempo's `/api/search` body for a TraceQL query over the files and the tail.
pub(crate) fn do_tq_search(mut r: Req<'_>) -> Res<Vec<u8>> {
    let mut budget = Budget::read(&mut r)?;
    let (limit, spss) = (r.u32("limit")?, r.u32("spss")?);
    let (start, end) = (r.i64("start")?, r.i64("end")?);
    let q = r.str("query")?;
    let files = r.files("spans file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    // Refuse a bad query before reading anything.
    viz_traceql::parse(q).map_err(tq_err)?;
    let ts = traces(&files, &tails, &mut budget, None)?;
    let n = ts.len();
    let req = SearchRequest { limit, spans_per_spanset: spss, start_unix_nano: start.max(0) as u64, end_unix_nano: end.max(0) as u64 };
    let out = viz_traceql::search(&MemSource::new(ts), q, &req).map_err(tq_err)?;
    counts(&mut budget, n, out.to_json())
}

/// Bytes charged per point of a TraceQL metrics series (its accumulator: a count, an exact
/// sum and a count, or a min or max; a histogram's buckets are not counted: README, "Memory").
const METRIC_POINT_BYTES: u64 = 48;

/// `viz_q_tq_metrics`: Tempo's `/api/metrics/query_range` (or `/query`, `instant`) body.
/// The request is used as given: the caller aligns it (`viz_q_tq_plan`). The series a query
/// may make are bounded by what the memory budget leaves once the spans are held: a series
/// holds one accumulator per point.
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
    let window = if local { p.span_window } else { None };
    let ts = traces(&files, &tails, &mut budget, window)?;
    let n = ts.len();
    let points = req.points().max(1);
    let fit = usize::try_from(budget.mem.left() / points.saturating_mul(METRIC_POINT_BYTES)).unwrap_or(usize::MAX).max(1);
    let limits = viz_traceql::Limits { max_series: max_series.min(fit), max_points };
    let out = viz_traceql::query_range_with(&MemSource::new(ts), q, &req, &limits).map_err(|e| {
        let series = matches!(&e, viz_traceql::Error::Eval(m) if m.starts_with("the query produces more than"));
        if series && fit < max_series {
            // The series did not fit the memory left, before the series cap.
            Fail::Limit(
                "max_decoded_bytes",
                budget.mem.max,
                budget.mem.used.saturating_add((fit as u64 + 1).saturating_mul(points).saturating_mul(METRIC_POINT_BYTES)),
                format!("query exceeded limit max_decoded_bytes: more than {fit} series of {points} points do not fit what the limit ({} bytes) leaves once the spans are held. Narrow the time range, use a longer step, or group by fewer values.", budget.mem.max),
            )
        } else {
            tq_err(e)
        }
    })?;
    counts(&mut budget, n, out.to_json())
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

pub(crate) fn esc(s: &str, out: &mut String) {
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

fn any_json(v: &Value<String>, out: &mut String) {
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

fn attrs_json(attrs: &[viz_storage::otel::Attr<String>], out: &mut String) {
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

fn span_json(s: &SpanRec, out: &mut String) {
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
/// the order their first span appears. The text is charged to `mem` as it grows
/// ([`Mem::charge_answer`]): refused once it passes the budget, at most one span's text later.
pub(crate) fn trace_json(spans: &[SpanRec], mem: &mut Mem) -> Res<String> {
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
    let mut out = String::from("{\"batches\":[");
    for (i, (r, scopes)) in res.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        // A resource's attributes are written once per batch.
        let at = out.len();
        out.push_str("{\"resource\":{");
        if !r.is_empty() {
            out.push_str("\"attributes\":");
            attrs_json(r, &mut out);
        }
        mem.charge_answer((out.len() - at) as u64)?;
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
                // Charged as written: past the budget by at most one span's text.
                let at = out.len();
                span_json(s, &mut out);
                mem.charge_answer((out.len() - at) as u64)?;
            }
            out.push_str("]}");
        }
        out.push_str("]}");
    }
    out.push_str("]}");
    Ok(out)
}

/// `viz_q_tq_trace`: one trace by ID: `u8 found`, `u64 spans decoded`, then Tempo's v1 body
/// (`{"batches":[…]}`) or v2 body (`{"trace":{"batches":[…]}}`); nothing after the counts when
/// no span of the trace was read.
pub(crate) fn do_tq_trace(mut r: Req<'_>) -> Res<Vec<u8>> {
    let version = r.u8("version")?;
    let mut id = [0u8; 16];
    id.copy_from_slice(r.take(16, "trace id")?);
    let mut budget = Budget::read(&mut r)?;
    let files = r.files("spans file")?;
    let tails = r.files("tail batch")?;
    r.end()?;
    let mut spans = latest_records(&files, &tails, &mut budget, |s| s.trace_id == id)?;
    spans.sort_by(|a, b| (a.start, a.span_id).cmp(&(b.start, b.span_id)));
    let mut out = vec![(!spans.is_empty()) as u8];
    out.extend_from_slice(&budget.decoded.to_le_bytes());
    if !spans.is_empty() {
        let body = trace_json(&spans, &mut budget.mem)?;
        let body = if version == 2 { format!("{{\"trace\":{body}}}") } else { body };
        out.extend_from_slice(body.as_bytes());
    }
    Ok(out)
}

// ───────────────────────────── tags ─────────────────────────────

/// The intrinsic tag names, as Tempo's documentation of `/api/v2/search/tags` lists them.
const INTRINSICS: [&str; 20] = [
    "duration", "event:name", "event:timeSinceStart", "instrumentation:name", "instrumentation:version", "kind", "name", "rootName", "rootServiceName", "span:duration", "span:kind", "span:name",
    "span:status", "span:statusMessage", "status", "statusMessage", "trace:duration", "trace:rootName", "trace:rootService", "traceDuration",
];
const SCOPES: [&str; 6] = ["resource", "span", "intrinsic", "event", "link", "instrumentation"];

fn in_window(s: &SpanRec, lo: i64, hi: i64) -> bool {
    s.start >= lo && s.start <= hi
}

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
    let spans = latest_records(&files, &tails, &mut budget, |s| in_window(s, lo, hi))?;
    let mut names: BTreeMap<&str, BTreeSet<String>> = SCOPES.iter().map(|s| (*s, BTreeSet::new())).collect();
    names.get_mut("intrinsic").unwrap().extend(INTRINSICS.iter().map(|s| s.to_string()));
    for s in &spans {
        names.get_mut("resource").unwrap().extend(s.resource.iter().map(|a| a.key.clone()));
        names.get_mut("span").unwrap().extend(s.attrs.iter().map(|a| a.key.clone()));
        for e in &s.events {
            names.get_mut("event").unwrap().extend(sigfiles::kv_texts(&e.attrs)?.into_iter().map(|x| x.0));
        }
        for l in &s.links {
            names.get_mut("link").unwrap().extend(sigfiles::kv_texts(&l.attrs)?.into_iter().map(|x| x.0));
        }
        if !s.scope_attrs.is_empty() {
            names.get_mut("instrumentation").unwrap().extend(sigfiles::kv_texts(&s.scope_attrs)?.into_iter().map(|x| x.0));
        }
    }
    let cut = |set: &BTreeSet<String>| -> Vec<String> { set.iter().take(if limit == 0 { usize::MAX } else { limit }).cloned().collect() };
    let json = if version == 1 {
        let wanted: Vec<&str> = if scope.is_empty() { vec!["resource", "span"] } else { vec![scope.as_str()] };
        let mut all = BTreeSet::new();
        for w in wanted {
            all.extend(names[w].iter().cloned());
        }
        serde_json::json!({"tagNames": cut(&all), "metrics": {}})
    } else {
        let list: Vec<serde_json::Value> = SCOPES
            .iter()
            .filter(|s| if scope.is_empty() { !names[**s].is_empty() } else { **s == scope })
            .map(|s| serde_json::json!({"name": s, "tags": cut(&names[*s])}))
            .collect();
        serde_json::json!({"scopes": list, "metrics": {}})
    };
    let json = json.to_string();
    budget.mem.charge_answer(json.len() as u64)?;
    Ok(json.into_bytes())
}

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
    let recs = latest_records(&files, &tails, &mut budget, |s| in_window(s, lo, hi))?;
    let mut grouped: BTreeMap<[u8; 16], Vec<viz_traceql::Span>> = BTreeMap::new();
    // Each record is let go as its engine span is made, so the two are not held whole at once.
    for s in recs {
        let span = engine_span(&s, &mut budget.engine_res, &mut budget.mem)?;
        grouped.entry(s.trace_id).or_default().push(span);
    }
    let mut values: BTreeSet<(&'static str, String)> = BTreeSet::new();
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
            let mut put = |v: &AttrValue| {
                if let Some(x) = typed(v) {
                    values.insert(x);
                }
            };
            match &tag {
                Tag::Name => put(&AttrValue::Str(s.name.clone())),
                Tag::StatusMessage => put(&AttrValue::Str(s.status_message.clone())),
                Tag::Status => {
                    values.insert(("keyword", s.status.name().to_string()));
                }
                Tag::Kind => {
                    values.insert(("keyword", s.kind.name().to_string()));
                }
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
        }
    }
    let take = if limit == 0 { usize::MAX } else { limit };
    let json = if version == 1 {
        let v: Vec<String> = values.into_iter().filter(|(t, _)| *t == "string").map(|(_, v)| v).collect::<BTreeSet<_>>().into_iter().take(take).collect();
        serde_json::json!({"tagValues": v, "metrics": {}})
    } else {
        let v: Vec<serde_json::Value> = values.into_iter().take(take).map(|(t, v)| serde_json::json!({"type": t, "value": v})).collect();
        serde_json::json!({"tagValues": v, "metrics": {}})
    };
    let json = json.to_string();
    budget.mem.charge_answer(json.len() as u64)?;
    Ok(json.into_bytes())
}
