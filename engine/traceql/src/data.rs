//! The span data the engine evaluates: the logical view of `contracts/TRACES.md`.
//!
//! A storage reader hands the engine traces, each with its spans and a [`TraceSummary`]
//! (the merged `trace_index` row). Promoted columns are invisible here: resource attributes
//! include `service.name` and every other promoted key, as one typed list.

use crate::plan::ReadPlan;
use crate::Error;

/// An attribute value, typed as OTLP types it.
#[derive(Clone, Debug, PartialEq)]
pub enum AttrValue {
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    StrArray(Vec<String>),
    IntArray(Vec<i64>),
    FloatArray(Vec<f64>),
    BoolArray(Vec<bool>),
    /// Bytes, key-value lists and mixed arrays: kept as canonical OTLP JSON. TraceQL cannot
    /// compare them; they read as absent in conditions.
    Other(String),
}

pub type Attrs = Vec<(String, AttrValue)>;

/// A span's resource attributes, shared by every span of one resource: a reader holds each
/// distinct resource once, however many spans carry it (a resource is often kilobytes, and a
/// file holds few of them).
pub type Resource = std::sync::Arc<Attrs>;

/// Look up a key in a typed attribute list. If the key occurs twice, the last value wins
/// (`contracts/TRACES.md`).
pub fn attr<'a>(attrs: &'a [(String, AttrValue)], key: &str) -> Option<&'a AttrValue> {
    attrs.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Event {
    pub time_unix_nano: u64,
    pub name: String,
    pub attrs: Attrs,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Link {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub trace_state: String,
    pub attrs: Attrs,
}

/// OTLP span kind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    #[default]
    Unspecified = 0,
    Internal = 1,
    Server = 2,
    Client = 3,
    Producer = 4,
    Consumer = 5,
}

impl Kind {
    pub fn from_otlp(v: i32) -> Kind {
        match v {
            1 => Kind::Internal,
            2 => Kind::Server,
            3 => Kind::Client,
            4 => Kind::Producer,
            5 => Kind::Consumer,
            _ => Kind::Unspecified,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Kind::Unspecified => "unspecified",
            Kind::Internal => "internal",
            Kind::Server => "server",
            Kind::Client => "client",
            Kind::Producer => "producer",
            Kind::Consumer => "consumer",
        }
    }
}

/// OTLP status code.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Status {
    #[default]
    Unset = 0,
    Ok = 1,
    Error = 2,
}

impl Status {
    pub fn from_otlp(v: i32) -> Status {
        match v {
            1 => Status::Ok,
            2 => Status::Error,
            _ => Status::Unset,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Status::Unset => "unset",
            Status::Ok => "ok",
            Status::Error => "error",
        }
    }
}

/// One span, as `contracts/TRACES.md` "Logical view" describes it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Span {
    pub span_id: [u8; 8],
    /// `None` for a root span (OTLP's empty or all-zero parent id).
    pub parent_span_id: Option<[u8; 8]>,
    pub name: String,
    pub kind: Kind,
    pub status: Status,
    pub status_message: String,
    pub start_unix_nano: u64,
    pub end_unix_nano: u64,
    /// Resource attributes, `service.name` included; shared between the spans of one resource.
    pub resource: Resource,
    pub attrs: Attrs,
    pub scope_name: String,
    pub scope_version: String,
    pub scope_attrs: Attrs,
    pub events: Vec<Event>,
    pub links: Vec<Link>,
}

impl Span {
    pub fn duration(&self) -> u64 {
        self.end_unix_nano.saturating_sub(self.start_unix_nano)
    }
    pub fn service_name(&self) -> Option<&str> {
        match attr(&self.resource, "service.name") {
            Some(AttrValue::Str(s)) => Some(s),
            _ => None,
        }
    }
}

/// Per-service counts of a trace (`trace_index.services`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ServiceStats {
    pub service: String,
    pub span_count: u32,
    pub error_count: u32,
}

/// The merged `trace_index` row of a trace: values that describe the whole trace.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TraceSummary {
    pub start_unix_nano: u64,
    pub end_unix_nano: u64,
    /// The root span's service and name, when the trace has a root span.
    pub root: Option<(Option<String>, String)>,
    pub services: Vec<ServiceStats>,
}

impl TraceSummary {
    /// Computes the summary from every span of a trace, with the rules of
    /// `contracts/TRACES.md` (`trace_index`, "Merging fragments").
    pub fn from_spans(spans: &[Span]) -> TraceSummary {
        let mut s = TraceSummary { start_unix_nano: u64::MAX, ..Default::default() };
        let mut root: Option<&Span> = None;
        for sp in spans {
            s.start_unix_nano = s.start_unix_nano.min(sp.start_unix_nano);
            s.end_unix_nano = s.end_unix_nano.max(sp.end_unix_nano);
            if sp.parent_span_id.is_none() {
                root = match root {
                    Some(r) if (r.start_unix_nano, r.span_id) <= (sp.start_unix_nano, sp.span_id) => Some(r),
                    _ => Some(sp),
                };
            }
            let svc = sp.service_name().unwrap_or("").to_string();
            match s.services.iter_mut().find(|x| x.service == svc) {
                Some(x) => {
                    x.span_count += 1;
                    x.error_count += (sp.status == Status::Error) as u32;
                }
                None => s.services.push(ServiceStats {
                    service: svc,
                    span_count: 1,
                    error_count: (sp.status == Status::Error) as u32,
                }),
            }
        }
        if spans.is_empty() {
            s.start_unix_nano = 0;
        }
        s.services.sort_by(|a, b| a.service.cmp(&b.service));
        s.root = root.map(|r| (r.service_name().map(str::to_string), r.name.clone()));
        s
    }
}

/// One trace: its id, its summary, and its spans (all of them, or those a read plan kept).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Trace {
    pub trace_id: [u8; 16],
    pub summary: TraceSummary,
    pub spans: Vec<Span>,
}

impl Trace {
    /// A trace with its summary computed from `spans`.
    pub fn new(trace_id: [u8; 16], spans: Vec<Span>) -> Trace {
        Trace { trace_id, summary: TraceSummary::from_spans(&spans), spans }
    }
}

/// The only data-access seam. A source returns, for a plan, every trace that may hold a
/// span the plan's trace predicate admits, with at least every span its span predicate
/// admits (all spans when `plan.full_traces`). It may return more: the plan is an
/// optimisation, never a filter the engine relies on. Each trace is returned once, with its
/// complete summary. Order does not matter.
pub trait SpanSource {
    fn traces(&self, plan: &ReadPlan, visit: &mut dyn FnMut(&Trace) -> Result<(), Error>) -> Result<(), Error>;
}

/// An in-memory source. With `prune` on it applies the plan the way storage would (trace
/// predicate, span predicate, time range) so tests can check that pruning never changes a
/// result.
#[derive(Clone, Debug, Default)]
pub struct MemSource {
    pub traces: Vec<Trace>,
    pub prune: bool,
}

impl MemSource {
    pub fn new(traces: Vec<Trace>) -> MemSource {
        MemSource { traces, prune: false }
    }
    pub fn pruning(mut self, on: bool) -> MemSource {
        self.prune = on;
        self
    }
}

impl SpanSource for MemSource {
    fn traces(&self, plan: &ReadPlan, visit: &mut dyn FnMut(&Trace) -> Result<(), Error>) -> Result<(), Error> {
        for t in &self.traces {
            if !self.prune {
                visit(t)?;
                continue;
            }
            if !plan.trace_may_match(t) {
                continue;
            }
            if plan.full_traces {
                visit(t)?;
            } else {
                let spans: Vec<Span> = (0..t.spans.len()).filter(|&i| plan.span_may_match(t, i)).map(|i| t.spans[i].clone()).collect();
                if spans.is_empty() {
                    continue;
                }
                visit(&Trace { trace_id: t.trace_id, summary: t.summary.clone(), spans })?;
            }
        }
        Ok(())
    }
}
