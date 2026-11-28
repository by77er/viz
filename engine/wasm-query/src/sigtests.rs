//! Tests of the span and log calls' bounds (ABI 7): the trace bound (D62, review M-1) and the
//! decoded-bytes budget with shared resources (review M-2). Files are written by
//! `viz_storage`'s flush encoders from `VZB1` batches made here; calls go through the request
//! layout the JavaScript binding writes.
use crate::{logs, traces, Fail, Req};
use viz_storage::otel::{self, Attr, LogRow, LogStream, Span, SpanEntry, Value};

const MIN: i64 = 60_000_000_000;
/// 2026-11-19T09:00:00Z.
const T0: i64 = 1_795_078_800_000_000_000;

/// A request as `js/index.ts` writes it.
#[derive(Default)]
struct W(Vec<u8>);
impl W {
    fn u8(mut self, v: u8) -> W {
        self.0.push(v);
        self
    }
    fn u32(mut self, v: u32) -> W {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u64(mut self, v: u64) -> W {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn i64(mut self, v: i64) -> W {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn item(mut self, b: &[u8]) -> W {
        self.0.extend_from_slice(&(b.len() as u32).to_le_bytes());
        self.0.extend_from_slice(b);
        self
    }
    fn files(self, list: &[Vec<u8>]) -> W {
        let mut w = self.u32(list.len() as u32);
        for f in list {
            w = w.item(f);
        }
        w
    }
}

fn run(f: fn(Req<'_>) -> Result<Vec<u8>, Fail>, w: W) -> Result<Vec<u8>, String> {
    f(Req { b: &w.0, at: 0 }).map_err(|e| match e {
        Fail::Query(q) => format!("{:?}: {}", q.error_type, q.message),
        Fail::Malformed(m) => format!("malformed: {m}"),
        Fail::Limit(name, ..) => format!("limit {name}"),
    })
}

fn tid(c: u8) -> [u8; 16] {
    [c; 16]
}

struct Sp {
    trace: u8,
    span: u8,
    parent: u8,
    name: &'static str,
    from: i64,
    to: i64,
}

/// One `VZB1` span batch: every span with `resource` (and `attrs`, per span).
fn batch(spans: &[Sp], resource: &[(&str, String)], attrs: impl Fn(usize) -> Vec<(String, String)>) -> Vec<u8> {
    let mut res: Vec<Attr<String>> = resource.iter().map(|(k, v)| Attr { key: k.to_string(), value: Value::Str(v.clone()) }).collect();
    res.sort_by(|a, b| a.key.cmp(&b.key));
    let entry = SpanEntry { resource_fp: 7, resource: res, scope_name: String::new(), scope_version: String::new(), scope_attrs: String::new() };
    let rows: Vec<Span<String>> = spans
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let mut a: Vec<Attr<String>> = attrs(i).into_iter().map(|(k, v)| Attr { key: k, value: Value::Str(v) }).collect();
            a.sort_by(|x, y| x.key.cmp(&y.key));
            Span {
                entry: 0,
                trace_id: tid(s.trace),
                span_id: [s.span; 8],
                parent_span_id: if s.parent == 0 { [0; 8] } else { [s.parent; 8] },
                start: T0 + s.from * MIN,
                end: T0 + s.to * MIN,
                flags: 0,
                dropped: [0; 3],
                kind: 2,
                status: 0,
                name: s.name.to_string(),
                trace_state: String::new(),
                status_message: String::new(),
                attrs: a,
                events: Vec::new(),
                links: Vec::new(),
            }
        })
        .collect();
    otel::encode_spans(&[entry], &rows).expect("batch")
}

fn api() -> Vec<(&'static str, String)> {
    vec![("service.name", "api".to_string())]
}

/// The `spans` and `trace_index` files of one flush unit.
fn unit(spans: &[Sp]) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let b = batch(spans, &api(), |_| Vec::new());
    let files = viz_storage::encode_spans(&[&b]).expect("encode");
    let (mut s, mut t) = (Vec::new(), Vec::new());
    for f in files {
        match f.table {
            viz_storage::SignalTable::Spans => s.push(f.bytes),
            _ => t.push(f.bytes),
        }
    }
    (s, t)
}

fn search(files: &[Vec<u8>], tails: &[Vec<u8>], q: &str, bound: (i64, i64), max_bytes: u64) -> Result<String, String> {
    let w = W::default().u64(1_000_000).u64(max_bytes).i64(bound.0).i64(bound.1).u32(0).u32(100).u32(100).i64(T0 - 5 * MIN).i64(T0 + 10 * MIN).item(q.as_bytes()).files(files).files(tails);
    run(traces::do_tq_search, w).map(|b| String::from_utf8(b[16..].to_vec()).unwrap())
}

fn extent(index: &[Vec<u8>], tails: &[Vec<u8>], bound: (i64, i64)) -> serde_json::Value {
    let w = W::default().i64(T0 - 5 * MIN).i64(T0 + 10 * MIN).u8(0).i64(bound.0).i64(bound.1).u64(BIG).files(index).files(tails);
    serde_json::from_slice(&run(traces::do_tq_extent, w).expect("extent")).unwrap()
}

const BOUND: (i64, i64) = (T0 - 125 * MIN, T0 + 130 * MIN);
const ALL: (i64, i64) = (i64::MIN, i64::MAX);
const BIG: u64 = 1 << 40;

#[test]
fn a_span_outside_the_bound_is_dropped_before_de_duplication_whatever_else_is_read() {
    // The same span twice: in unit 1 inside the bound, again in unit 2 with a start far outside it.
    let (s1, _) = unit(&[Sp { trace: 0xa, span: 1, parent: 0, name: "root", from: 0, to: 5 }]);
    let (s2, _) = unit(&[Sp { trace: 0xa, span: 1, parent: 0, name: "moved", from: 600, to: 601 }]);
    let only = search(&s1, &[], "{ }", BOUND, BIG).unwrap();
    let both = search(&[s1.clone(), s2.clone()].concat(), &[], "{ }", BOUND, BIG).unwrap();
    // Whether unit 2's file was read (pruning off) or not (pruning on), the answer is the same:
    // the copy outside the bound is not part of the data, so it does not hide the one inside.
    assert_eq!(only, both);
    assert!(only.contains("\"rootTraceName\":\"root\""), "{only}");
    // Without a bound the later copy wins, and the trace lies outside the window.
    let all = search(&[s1, s2].concat(), &[], "{ }", ALL, BIG).unwrap();
    assert!(all.starts_with("{\"traces\":[]"), "{all}");
}

#[test]
fn extents_count_only_what_lies_inside_the_bound_and_find_a_trace_whose_pieces_straddle_the_window() {
    // d: 08:30–08:35 and 09:40–09:45 in two units: neither piece overlaps 08:55–09:10, the
    // trace does. e: a root at 09:00 and a child at 12:00, beyond the bound (11:10).
    let (_, t1) = unit(&[Sp { trace: 0xd, span: 1, parent: 0, name: "d1", from: -30, to: -25 }]);
    let (_, t2) = unit(&[Sp { trace: 0xd, span: 2, parent: 1, name: "d2", from: 40, to: 45 }]);
    let (_, t3) = unit(&[Sp { trace: 0xe, span: 3, parent: 0, name: "e1", from: 0, to: 1 }]);
    let (_, t4) = unit(&[Sp { trace: 0xe, span: 4, parent: 3, name: "e2", from: 180, to: 181 }]);
    let index = [t1, t2, t3, t4].concat();
    let e = extent(&index, &[], BOUND);
    assert_eq!(e["traces"], 2, "{e}");
    assert_eq!(e["lo"], (T0 - 30 * MIN).to_string());
    // e's child is passed over: the hull ends at d's end, not at 12:01.
    assert_eq!(e["hi"], (T0 + 45 * MIN).to_string());
    let hours: Vec<i64> = e["hours"].as_array().unwrap().iter().map(|h| h.as_i64().unwrap()).collect();
    assert!(!hours.contains(&((T0 + 180 * MIN) / 3_600_000_000_000)), "{e}");
    // A tail span outside the bound is passed over too; one inside it extends the hull.
    let tail_out = batch(&[Sp { trace: 0xd, span: 9, parent: 1, name: "late", from: 600, to: 601 }], &api(), |_| Vec::new());
    let tail_in = batch(&[Sp { trace: 0xd, span: 8, parent: 1, name: "later", from: 100, to: 101 }], &api(), |_| Vec::new());
    assert_eq!(extent(&index, &[tail_out.clone()], BOUND)["hi"], (T0 + 45 * MIN).to_string());
    assert_eq!(extent(&index, &[tail_out, tail_in], BOUND)["hi"], (T0 + 101 * MIN).to_string());
    // A hull that would pass the bound's end is cut to it (spans are planned by start), and one
    // whose fragment starts before the bound starts at the bound.
    let (_, t5) = unit(&[Sp { trace: 0xf, span: 5, parent: 0, name: "long", from: 0, to: 600 }]);
    assert_eq!(extent(&t5, &[], BOUND)["hi"], BOUND.1.to_string());
    let (_, t6) = unit(&[Sp { trace: 0xb, span: 6, parent: 0, name: "early", from: -140, to: -139 }, Sp { trace: 0xb, span: 7, parent: 6, name: "in", from: 0, to: 1 }]);
    assert_eq!(extent(&t6, &[], BOUND)["lo"], BOUND.0.to_string());
}

#[test]
fn a_resource_is_held_once_however_many_spans_carry_it() {
    // 1,000 spans with a 180 KB resource: 176 MiB of WASM memory before (review M-2).
    let fat: Vec<(&str, String)> = vec![("service.name", "api".into()), ("blob0", "x".repeat(60_000)), ("blob1", "y".repeat(60_000)), ("blob2", "z".repeat(60_000))];
    let spans: Vec<Sp> = (0..1000).map(|i| Sp { trace: (i % 200) as u8 + 1, span: (i / 200) as u8 + 1, parent: 0, name: "op", from: 0, to: 1 }).collect();
    let b = batch(&spans, &fat, |_| Vec::new());
    let files: Vec<Vec<u8>> = viz_storage::encode_spans(&[&b]).unwrap().into_iter().filter(|f| f.table == viz_storage::SignalTable::Spans).map(|f| f.bytes).collect();
    // Held once: well under 4 MiB, from the files and from the tail alike.
    search(&files, &[], "{ }", ALL, 4 << 20).expect("files");
    search(&[], &[b.clone()], "{ }", ALL, 4 << 20).expect("tail");
    // Each span with its own 60 KB attribute: nothing to share, refused before 1,000 are held.
    let own = batch(&spans, &api(), |i| vec![("blob".to_string(), format!("{}{i}", "w".repeat(60_000)))]);
    assert_eq!(search(&[], &[own], "{ }", ALL, 16 << 20), Err("limit max_decoded_bytes".into()));
}

#[test]
fn trace_by_id_charges_its_answer_as_it_is_written() {
    let spans: Vec<Sp> = (0..200).map(|i| Sp { trace: 0xa, span: i as u8 + 1, parent: 0, name: "op", from: 0, to: 1 }).collect();
    let b = batch(&spans, &api(), |i| vec![("blob".to_string(), format!("{}{i}", "v".repeat(20_000)))]);
    // `u8 version, [16 bytes id], u64 max_spans, u64 max_bytes, i64 bound_lo, i64 bound_hi, files, tails`.
    let req = |max: u64| {
        let mut w = W::default().u8(1);
        w.0.extend_from_slice(&tid(0xa));
        w.u64(1_000_000).u64(max).i64(ALL.0).i64(ALL.1).u32(0).files(&[]).files(&[b.clone()])
    };
    let ok = run(traces::do_tq_trace, req(BIG)).unwrap();
    assert_eq!(ok[0], 1);
    // Room for the spans (about 4 MB) but not for the answer charged four times over (16 MB).
    assert_eq!(run(traces::do_tq_trace, req(10 << 20)), Err("limit max_decoded_bytes".into()));
}

fn log_batch(lines: &[String]) -> Vec<u8> {
    let labels = vec![("job".to_string(), "a".to_string())];
    let streams = vec![LogStream { stream_id: otel::stream_id(&labels), labels }];
    let rows: Vec<LogRow<String>> = lines
        .iter()
        .enumerate()
        .map(|(i, l)| LogRow { entry: 0, ts: T0 + i as i64, observed_ts: 0, trace_id: [0; 16], span_id: [0; 8], flags: 0, severity_number: 0, line: l.clone(), severity_text: String::new(), metadata: Vec::new() })
        .collect();
    otel::encode_logs(&streams, &rows).expect("log batch")
}

fn log_query(tails: &[Vec<u8>], q: &str, max_rows: u64, max_bytes: u64, limit: u32) -> Result<Vec<u8>, String> {
    let w = W::default().u64(max_rows).u64(max_bytes).u64(10_000).u64(11_000).u32(limit).u8(0).u8(0).i64(T0).i64(T0 + 60 * MIN).i64(60_000_000_000).item(q.as_bytes()).files(&[]).files(tails);
    run(logs::do_lq_query, w)
}

#[test]
fn log_rows_and_answers_are_charged_and_refused_past_the_budget() {
    // 400 lines of 200 KB (review M-2: 158 MiB of WASM memory and a 19 MiB answer before).
    let fat: Vec<String> = (0..400).map(|i| format!("{}{i}", "x".repeat(200_000))).collect();
    assert_eq!(log_query(&[log_batch(&fat)], "{job=\"a\"}", 1_000_000, 40 << 20, 100), Err("limit max_decoded_bytes".into()));
    // Fifty of them fit as rows (10 MB), and with their answer once (20 MB), but not with it
    // charged four times (50 MB): the answer's copies count.
    assert_eq!(log_query(&[log_batch(&fat[..50])], "{job=\"a\"}", 1_000_000, 24 << 20, 50), Err("limit max_decoded_bytes".into()));
    assert!(log_query(&[log_batch(&fat[..50])], "{job=\"a\"}", 1_000_000, 24 << 20, 1).is_ok());
    // Rows no selector reads are not held, so they cost neither rows nor bytes.
    assert!(log_query(&[log_batch(&fat)], "{job=\"b\"}", 1, 1 << 20, 100).is_ok());
}

#[test]
fn a_metric_query_whose_series_do_not_fit_the_budget_is_refused_by_it() {
    // 2,000 streams' worth of series over 11,000 steps cannot fit 8 MiB; under a large budget
    // the same query answers.
    let lines: Vec<String> = (0..2000).map(|i| format!("user={i}")).collect();
    let b = log_batch(&lines);
    let w = |max_bytes: u64| W::default().u64(1_000_000).u64(max_bytes).u64(100_000).u64(11_000).u32(100).u8(0).u8(0).i64(T0).i64(T0 + 10_000 * 1_000_000_000).i64(1_000_000_000).item(b"sum by (user) (count_over_time({job=\"a\"} | logfmt [1m]))").files(&[]).files(std::slice::from_ref(&b));
    // Refused before the series are made (not only when the answer is charged after them).
    let r = w(8 << 20);
    match logs::do_lq_query(Req { b: &r.0, at: 0 }) {
        Err(Fail::Limit("max_decoded_bytes", _, _, m)) => assert!(m.contains("series of 10001 steps do not fit"), "{m}"),
        other => panic!("expected max_decoded_bytes, got {}", other.is_ok()),
    }
    assert!(run(logs::do_lq_query, w(BIG)).is_ok());
}

#[test]
fn the_budget_holds_exactly_its_limit() {
    let mut m = crate::sigfiles::Mem::new(1000);
    assert!(m.charge(999).is_ok());
    assert!(m.charge(1).is_ok());
    assert_eq!(m.left(), 0);
    assert!(matches!(m.charge(1), Err(Fail::Limit("max_decoded_bytes", 1000, 1001, _))));
    let mut a = crate::sigfiles::Mem::new(400);
    assert!(a.charge_answer(100).is_ok());
    assert!(a.charge_answer(1).is_err());
}

#[test]
fn extents_are_charged_to_the_budget_by_trace_not_by_row_cap() {
    // 3,000 traces in one unit: 3,000 fragments, far more than a small row cap would allow, held
    // in well under 1 MiB; refused only when the budget cannot hold their entries.
    let spans: Vec<Sp> = (0..3000).map(|i| Sp { trace: 1, span: 1, parent: 0, name: "op", from: i % 10, to: i % 10 + 1 }).collect();
    let mut b = batch(&spans, &api(), |_| Vec::new());
    // Distinct trace ids: rewrite each row's id (byte 0 and 1 of the id vary).
    let decoded = otel::decode_spans(&b).unwrap();
    let mut rows: Vec<Span<String>> = decoded.rows.iter().map(|r| Span { entry: r.entry, trace_id: r.trace_id, span_id: r.span_id, parent_span_id: r.parent_span_id, start: r.start, end: r.end, flags: 0, dropped: [0; 3], kind: r.kind, status: r.status, name: r.name.to_string(), trace_state: String::new(), status_message: String::new(), attrs: Vec::new(), events: Vec::new(), links: Vec::new() }).collect();
    for (i, r) in rows.iter_mut().enumerate() {
        r.trace_id[0] = (i / 256) as u8 + 1;
        r.trace_id[1] = (i % 256) as u8;
    }
    let entries: Vec<SpanEntry<String>> = decoded.entries.iter().map(|e| SpanEntry { resource_fp: e.resource_fp, resource: e.resource.iter().map(Attr::to_owned_attr).collect(), scope_name: String::new(), scope_version: String::new(), scope_attrs: String::new() }).collect();
    b = otel::encode_spans(&entries, &rows).unwrap();
    let index: Vec<Vec<u8>> = viz_storage::encode_spans(&[&b]).unwrap().into_iter().filter(|f| f.table != viz_storage::SignalTable::Spans).map(|f| f.bytes).collect();
    let call = |max: u64| run(traces::do_tq_extent, W::default().i64(T0 - 5 * MIN).i64(T0 + 10 * MIN).u8(0).i64(BOUND.0).i64(BOUND.1).u64(max).files(&index).files(&[]));
    let ok: serde_json::Value = serde_json::from_slice(&call(1 << 20).expect("fits")).unwrap();
    assert_eq!(ok["traces"], 3000);
    assert_eq!(call(100_000), Err("limit max_decoded_bytes".into()));
}

#[test]
fn a_trace_metric_query_whose_series_do_not_fit_the_budget_is_refused_by_it() {
    let names: Vec<&'static str> = (0..500).map(|i| &*Box::leak(format!("op-{i}").into_boxed_str())).collect();
    let spans: Vec<Sp> = (0..500).map(|i| Sp { trace: (i % 200) as u8 + 1, span: (i / 200) as u8 + 1, parent: 0, name: names[i], from: 0, to: 1 }).collect();
    let b = batch(&spans, &api(), |_| Vec::new());
    // `u64 max_spans, u64 max_bytes, i64 bound_lo, i64 bound_hi, u64 max_series, u64 max_points, u8 instant, i64 start, i64 end, i64 step, str, files, tails`.
    let w = |max_bytes: u64| W::default().u64(1_000_000).u64(max_bytes).i64(ALL.0).i64(ALL.1).u32(0).u64(10_000).u64(11_000).u8(0).i64(T0 - MIN).i64(T0 + 10_000 * 1_000_000_000).i64(1_000_000_000).item(b"{ } | count_over_time() by (name)").files(&[]).files(std::slice::from_ref(&b));
    let r = w(8 << 20);
    match traces::do_tq_metrics(Req { b: &r.0, at: 0 }) {
        Err(Fail::Limit("max_decoded_bytes", _, _, m)) => assert!(m.contains("the series it makes"), "{m}"),
        other => panic!("expected max_decoded_bytes, got ok={}", other.is_ok()),
    }
    assert!(run(traces::do_tq_metrics, w(BIG)).is_ok());
}


// ───────────── review r2 (design/reviews/signals-end-to-end-r2.md): what a call holds peaks within its budget ─────────────
//
// The heap of this test binary is counted per thread (`Counting`), so each case measures the
// most the call held at once, on the 64-bit target (structures are smaller on wasm32). A charge
// that is missing, or made after the structure it pays for, lets the peak pass the budget by the
// structure's size, which is what these assert against.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct Counting;
thread_local! {
    static NOW: Cell<i64> = const { Cell::new(0) };
    static PEAK: Cell<i64> = const { Cell::new(0) };
}
fn count(n: i64) {
    let _ = NOW.try_with(|c| {
        let v = c.get() + n;
        c.set(v);
        let _ = PEAK.try_with(|p| {
            if v > p.get() {
                p.set(v)
            }
        });
    });
}
// SAFETY: every call is forwarded to the system allocator unchanged; only sizes are counted.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            count(l.size() as i64);
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(l) };
        if !p.is_null() {
            count(l.size() as i64);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        count(-(l.size() as i64));
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, new) };
        if !q.is_null() {
            // A move holds both blocks for a moment.
            count(new as i64);
            count(-(l.size() as i64));
        }
        q
    }
}
#[global_allocator]
static HEAP: Counting = Counting;

/// The most `f` held at once on this thread's heap, beyond what was held before it.
fn peak<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let start = NOW.with(|c| c.get());
    PEAK.with(|p| p.set(start));
    let r = f();
    (r, (PEAK.with(|p| p.get()) - start).max(0) as u64)
}

const MIB: u64 = 1 << 20;
/// The budget the cases run under: the Worker's default (`maxDecodedBytes`).
const BUDGET: u64 = 32 * MIB;
/// What a call may hold beyond its budget and its inputs: one file's copy while it is opened,
/// the Parquet reader's pages, one row and one value before they are charged (a stated constant,
/// README "Memory").
const SLACK: u64 = 8 * MIB;

fn limit_name(r: &Result<Vec<u8>, String>) -> &str {
    match r {
        Ok(_) => "ok",
        Err(e) => e.as_str(),
    }
}

/// A span batch from `(trace, span, parent, start, end, attrs)`.
fn spans_of(rows: &[([u8; 16], [u8; 8], Option<[u8; 8]>, i64, i64, Vec<(String, String)>)]) -> Vec<u8> {
    let mut res: Vec<Attr<String>> = api().iter().map(|(k, v)| Attr { key: k.to_string(), value: Value::Str(v.clone()) }).collect();
    res.sort_by(|a, b| a.key.cmp(&b.key));
    let entry = SpanEntry { resource_fp: 7, resource: res, scope_name: String::new(), scope_version: String::new(), scope_attrs: String::new() };
    let rows: Vec<Span<String>> = rows
        .iter()
        .map(|(t, s, p, a, b, attrs)| {
            let mut at: Vec<Attr<String>> = attrs.iter().map(|(k, v)| Attr { key: k.clone(), value: Value::Str(v.clone()) }).collect();
            at.sort_by(|x, y| x.key.cmp(&y.key));
            Span { entry: 0, trace_id: *t, span_id: *s, parent_span_id: p.unwrap_or([0; 8]), start: *a, end: *b, flags: 0, dropped: [0; 3], kind: 2, status: 0, name: "op".into(), trace_state: String::new(), status_message: String::new(), attrs: at, events: Vec::new(), links: Vec::new() }
        })
        .collect();
    otel::encode_spans(&[entry], &rows).expect("batch")
}

fn id16(n: u64) -> [u8; 16] {
    let mut t = [0u8; 16];
    t[8..].copy_from_slice(&n.to_be_bytes());
    t[0] = 1;
    t
}

fn span_files(b: &[u8]) -> (Vec<viz_storage::SignalFile>, Vec<viz_storage::SignalFile>) {
    viz_storage::encode_spans(&[b]).expect("encode").into_iter().partition(|f| f.table == viz_storage::SignalTable::Spans)
}

/// `viz_q_tq_metrics` over `files` for 11,000 points over a day (the review's request), or
/// `points` points of a minute; the request is made before the heap is measured.
fn metrics_req(files: &[Vec<u8>], q: &str, max_bytes: u64, points: Option<i64>) -> W {
    let (step, n) = match points {
        None => (7_854_000_000i64, 11_000),
        Some(n) => (60_000_000_000, n),
    };
    let start = T0 - (n / 2) * step;
    W::default().u64(18_000).u64(max_bytes).i64(ALL.0).i64(ALL.1).u32(0).u64(10_000).u64(11_000).u8(0).i64(start).i64(start + (n - 1) * step).i64(step).item(q.as_bytes()).files(files).files(&[])
}

fn metrics(files: &[Vec<u8>], q: &str, max_bytes: u64) -> (Result<Vec<u8>, String>, u64) {
    let w = metrics_req(files, q, max_bytes, None);
    peak(|| run(traces::do_tq_metrics, w))
}

/// The review's histogram and quantile data: `g` groups of `k` spans whose durations are 2^0 to 2^(k-1) ns.
fn grouped(g: u64, k: u64) -> Vec<Vec<u8>> {
    let mut rows = Vec::new();
    let mut n = 1u64;
    for gi in 0..g {
        for ki in 0..k {
            let s = T0 + n as i64 * 1000;
            rows.push((id16(n), [1u8; 8], None, s, s + (1i64 << ki), vec![("g".to_string(), format!("g{gi}"))]));
            n += 1;
        }
    }
    span_files(&spans_of(&rows)).0.into_iter().map(|f| f.bytes).collect()
}

#[test]
fn r2_m2_histogram_series_are_charged_as_each_bucket_appears_and_refused_before_they_are_built() {
    // 8 groups x 60 buckets x 11,000 points (513.7 MiB of WASM memory before, refused after).
    let files = grouped(8, 60);
    let (r, held) = metrics(&files, "{ } | histogram_over_time(duration) by (span.g)", BUDGET);
    eprintln!("PEAK r2_m2_histogram_series_are_charged_as_each_bucket_appears_and_refused_before_they_are_built r: {} bytes, {}", held, limit_name(&r.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // The same data over an hour of minutes answers.
    let w = metrics_req(&files, "{ } | histogram_over_time(duration) by (span.g)", BUDGET, Some(61));
    let (ok, held) = peak(|| run(traces::do_tq_metrics, w));
    eprintln!("PEAK r2_m2_histogram_series_are_charged_as_each_bucket_appears_and_refused_before_they_are_built ok: {} bytes, {}", held, limit_name(&ok.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    assert!(ok.is_ok(), "{ok:?}");
    assert!(held <= BUDGET + SLACK, "held {held}");
}

#[test]
fn r2_m2_one_series_per_quantile_is_charged_when_its_group_is_made() {
    // 100 quantiles x 8 groups x 11,000 points (869.8 MiB before).
    let files = grouped(8, 60);
    let qs: Vec<String> = (1..=100).map(|i| format!("{:.4}", i as f64 / 101.0)).collect();
    let q = format!("{{ }} | quantile_over_time(duration, {}) by (span.g)", qs.join(", "));
    let (r, held) = metrics(&files, &q, BUDGET);
    eprintln!("PEAK r2_m2_one_series_per_quantile_is_charged_when_its_group_is_made r: {} bytes, {}", held, limit_name(&r.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // Three quantiles of the same data over an hour of minutes answer.
    let w = metrics_req(&files, "{ } | quantile_over_time(duration, .5, .9, .99) by (span.g)", BUDGET, Some(61));
    let (ok, held) = peak(|| run(traces::do_tq_metrics, w));
    eprintln!("PEAK r2_m2_one_series_per_quantile_is_charged_when_its_group_is_made ok: {} bytes, {}", held, limit_name(&ok.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    assert!(ok.is_ok(), "{ok:?}");
    assert!(held <= BUDGET + SLACK, "held {held}");
}

#[test]
fn r2_m2_a_metric_answer_is_charged_before_it_is_written() {
    // 60 groups x 11,000 points of rate(): series fit, the answer (about 33 MB of text, four
    // copies) does not; refused before it is written (65 MiB before).
    let files = grouped(60, 1);
    let (r, held) = metrics(&files, "{ } | rate() by (span.g)", BUDGET);
    eprintln!("PEAK r2_m2_a_metric_answer_is_charged_before_it_is_written r: {} bytes, {}", held, limit_name(&r.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
}

#[test]
fn r2_m2_tag_values_are_charged_as_the_set_grows() {
    // 500 spans with their own 60 KB value (107.7 MiB before), all of one trace: the set grows
    // while every span of the trace is still held (with a trace per span, the spans are let go as
    // the set grows, and the set's charge would not change the peak).
    let rows: Vec<_> = (1..=500u64).map(|i| (id16(1), i.to_be_bytes(), None, T0 + i as i64 * 1_000_000, T0 + i as i64 * 1_000_000 + 1000, vec![("blob".to_string(), format!("{i}{}", "x".repeat(60_000)))])).collect();
    let files: Vec<Vec<u8>> = rows.chunks(10).flat_map(|c| span_files(&spans_of(c)).0.into_iter().map(|f| f.bytes)).collect();
    let w = W::default().u8(2).item(b"span.blob").item(b"").i64(T0).i64(T0 + 60 * MIN).u32(0).u64(18_000).u64(BUDGET).files(&files).files(&[]);
    let (r, held) = peak(|| run(traces::do_tq_tag_values, w));
    eprintln!("PEAK r2_m2_tag_values_are_charged_as_the_set_grows r: {} bytes, {}", held, limit_name(&r.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // Fifty of them answer (3 MB held, 3 MB of values, a 12 MB answer charged).
    let files: Vec<Vec<u8>> = files[..5].to_vec();
    let w = W::default().u8(2).item(b"span.blob").item(b"").i64(T0).i64(T0 + 60 * MIN).u32(0).u64(18_000).u64(BUDGET).files(&files).files(&[]);
    let (ok, held) = peak(|| run(traces::do_tq_tag_values, w));
    eprintln!("PEAK r2_m2_tag_values_are_charged_as_the_set_grows ok: {} bytes, {}", held, limit_name(&ok.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    assert!(ok.is_ok(), "{ok:?}");
    assert!(held <= BUDGET + SLACK, "held {held}");
}

#[test]
fn r2_m2_label_sets_from_regexp_and_label_format_are_charged_as_series_are_made() {
    // 14,000 rows of 2 KB, a series per row whose labels are 14 KB (221.4 MiB before, and 200).
    let lines: Vec<String> = (0..14_000).map(|i| format!("{i:08}{}", "y".repeat(2000))).collect();
    let tails: Vec<Vec<u8>> = lines.chunks(500).map(log_batch).collect();
    let q = r#"count(sum by (x, y, z) (count_over_time({job="a"} | regexp "(?P<x>.+)" | label_format y="{{.x}}{{.x}}", z="{{.y}}{{.y}}" [1h])))"#;
    let w = W::default().u64(30_000).u64(BUDGET).u64(20_000).u64(11_000).u32(100).u8(0).u8(1).i64(T0 + 60 * MIN).i64(T0 + 60 * MIN).i64(1).item(q.as_bytes()).files(&[]).files(&tails);
    let (r, held) = peak(|| run(logs::do_lq_query, w));
    eprintln!("PEAK r2_m2_label_sets_from_regexp_and_label_format_are_charged_as_series_are_made r: {} bytes, {}", held, limit_name(&r.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // The same rows grouped by nothing the lines make answer.
    let w = W::default().u64(30_000).u64(BUDGET).u64(20_000).u64(11_000).u32(100).u8(0).u8(1).i64(T0 + 60 * MIN).i64(T0 + 60 * MIN).i64(1).item(br#"sum(count_over_time({job="a"} [1h]))"#).files(&[]).files(&tails);
    assert!(run(logs::do_lq_query, w).is_ok());
}

/// Log streams of 31 labels of 8,000 bytes, one row each (edge's limits allow 32 of 8,000).
fn fat_streams(n: usize) -> Vec<Vec<u8>> {
    let mut files = Vec::new();
    for chunk in (0..n).collect::<Vec<_>>().chunks(20) {
        let streams: Vec<LogStream<String>> = chunk
            .iter()
            .map(|k| {
                let mut labels: Vec<(String, String)> = vec![("job".into(), "a".into())];
                for l in 0..31 {
                    labels.push((format!("l{l}"), format!("{k}-{l}-{}", "x".repeat(8000))));
                }
                labels.sort();
                LogStream { stream_id: otel::stream_id(&labels), labels }
            })
            .collect();
        let rows: Vec<LogRow<String>> = (0..chunk.len()).map(|i| LogRow { entry: i as u32, ts: T0 + i as i64, observed_ts: 0, trace_id: [0; 16], span_id: [0; 8], flags: 0, severity_number: 0, line: "line".into(), severity_text: String::new(), metadata: Vec::new() }).collect();
        let b = otel::encode_logs(&streams, &rows).expect("log batch");
        files.extend(viz_storage::encode_logs(&[&b]).expect("encode").into_iter().map(|f| f.bytes));
    }
    files
}

fn labels_call(kind: u8, name: &str, files: &[Vec<u8>], max_bytes: u64) -> (Result<Vec<u8>, String>, u64) {
    let w = W::default().u8(kind).item(name.as_bytes()).i64(T0 - MIN).i64(T0 + 60 * MIN).u64(max_bytes).u32(1).item(br#"{job="a"}"#).u32(0).files(files).files(&[]);
    peak(|| run(logs::do_lq_labels, w))
}

#[test]
fn r2_m1_the_label_calls_have_a_budget_and_refuse_past_it_before_they_hold_it() {
    // 300 streams, 3.45 MiB of files: /series held 399 MiB and answered 71 MiB before.
    let files = fat_streams(300);
    let (r, held) = labels_call(2, "", &files, BUDGET);
    eprintln!("PEAK r2_m1_the_label_calls_have_a_budget_and_refuse_past_it_before_they_hold_it r: {} bytes, {}", held, limit_name(&r.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // 60 streams: their label sets (15 MB) and one file's texts fit, their answer charged four
    // times (57 MB) does not, and is refused before it is written.
    let sixty = fat_streams(60);
    let (r, held) = labels_call(2, "", &sixty, BUDGET);
    eprintln!("PEAK r2_m1 series of 60: {held} bytes, {}", limit_name(&r));
    match &r {
        Err(m) => assert_eq!(m, "limit max_decoded_bytes"),
        Ok(_) => panic!("60 fat streams answered"),
    }
    let w = W::default().u8(2).item(b"").i64(T0 - MIN).i64(T0 + 60 * MIN).u64(BUDGET).u32(1).item(br#"{job="a"}"#).u32(0).files(&sixty).files(&[]);
    match logs::do_lq_labels(Req { b: &w.0, at: 0 }) {
        Err(Fail::Limit("max_decoded_bytes", _, _, m)) => assert!(m.contains("its answer"), "{m}"),
        _ => panic!("expected max_decoded_bytes"),
    }
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // Names keep only the names: they answer, in little memory, however fat the values.
    let (names, held) = labels_call(0, "", &files, BUDGET);
    eprintln!("PEAK r2_m1_the_label_calls_have_a_budget_and_refuse_past_it_before_they_hold_it names: {} bytes, {}", held, limit_name(&names.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    let names: Vec<String> = serde_json::from_slice(&names.expect("names")).unwrap();
    assert_eq!(names.len(), 32);
    assert!(held <= BUDGET + SLACK, "held {held}");
    // Values of one label: 300 values of 8 KB, a 2.4 MB answer (four times charged) fit.
    let values: Vec<String> = serde_json::from_slice(&labels_call(1, "l0", &files, BUDGET).0.expect("values")).unwrap();
    assert_eq!(values.len(), 300);
    // A few streams' series answer, as `serde_json` wrote them before.
    let few = fat_streams(20);
    let got = labels_call(2, "", &few, BUDGET).0.expect("series");
    let parsed: Vec<serde_json::Map<String, serde_json::Value>> = serde_json::from_slice(&got).unwrap();
    assert_eq!(parsed.len(), 20);
    assert_eq!(serde_json::to_string(&parsed).unwrap().into_bytes(), got);
}

#[test]
fn r2_m3_the_extent_pass_holds_the_window_s_traces_and_the_ids_after_it_not_every_trace_of_the_bound() {
    // Single-span traces at 12 a second, 10-minute units from 08:00 to 12:10; a one-minute window
    // at 10:00 and a 2-hour margin: refused 422 before (an extent per trace of 4 h 1 min).
    let t0 = T0 + 60 * MIN; // 10:00
    let mut index = Vec::new();
    let mut n = 1u64;
    for u in 0..25 {
        let from = t0 - 120 * MIN + u * 10 * MIN;
        let rows: Vec<_> = (0..7200)
            .map(|k| {
                let s = from + k * (10 * MIN / 7200);
                n += 1;
                (id16(n), [1u8; 8], None, s, s + 1_000_000, Vec::new())
            })
            .collect();
        index.extend(span_files(&spans_of(&rows)).1.into_iter().map(|f| f.bytes));
    }
    let bound = (t0 - 120 * MIN, t0 + MIN + 120 * MIN);
    let call = |max: u64| run(traces::do_tq_extent, W::default().i64(t0).i64(t0 + MIN).u8(0).i64(bound.0).i64(bound.1).u64(max).files(&index).files(&[]));
    let w = W::default().i64(t0).i64(t0 + MIN).u8(0).i64(bound.0).i64(bound.1).u64(BUDGET).files(&index).files(&[]);
    let (r, held) = peak(|| run(traces::do_tq_extent, w));
    eprintln!("PEAK r2_m3_the_extent_pass_holds_the_window_s_traces_and_the_ids_after_it_not_every_trace_of_the_bound r: {} bytes, {}", held, limit_name(&r.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    let e: serde_json::Value = serde_json::from_slice(&r.expect("answers")).unwrap();
    // The window's 721 or so traces, found with every piece of the bound read.
    assert!((700..=760).contains(&e["traces"].as_u64().unwrap()), "{e}");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // Under a budget too small for the ids after the window, the refusal says the margin, not the window, is what does not fit.
    let small = call(4 * MIB);
    assert!(small.as_ref().is_err_and(|m| m == "limit max_decoded_bytes"), "{small:?}");
    let w = W::default().i64(t0).i64(t0 + MIN).u8(0).i64(bound.0).i64(bound.1).u64(4 * MIB).files(&index).files(&[]);
    match traces::do_tq_extent(Req { b: &w.0, at: 0 }) {
        Err(Fail::Limit("max_decoded_bytes", _, _, m)) => assert!(m.contains("margin after the window") && m.contains("traceMarginMs") && !m.contains("Narrow the time range"), "{m}"),
        _ => panic!("expected max_decoded_bytes"),
    }
    // A window that ends at the data's end has no trace after it: nothing of the margin is held.
    let end = t0 - 120 * MIN + 25 * 10 * MIN;
    let late = run(traces::do_tq_extent, W::default().i64(end - MIN).i64(end).u8(0).i64(end - MIN - 120 * MIN).i64(end + 120 * MIN).u64(MIB).files(&index).files(&[]));
    assert!(late.is_ok(), "{late:?}");
}

#[test]
fn r2_m3_a_long_trace_adds_the_units_its_pieces_lie_in_not_its_hull() {
    // 5 spans a second in 10-minute units; one trace with a root in the window and a child 1 h
    // 50 min later, in a unit with others' spans (the review: 39,002 rows planned, 422).
    let t0 = T0 + 60 * MIN;
    let (mut spans, mut index) = (Vec::new(), Vec::new());
    let mut n = 10u64;
    let long = id16(1);
    for u in 0..24 {
        let from = t0 - 120 * MIN + u * 10 * MIN;
        let mut rows: Vec<_> = (0..3000)
            .map(|k| {
                let s = from + k * (10 * MIN / 3000);
                n += 1;
                (id16(n), [1u8; 8], None, s, s + 1_000_000, Vec::new())
            })
            .collect();
        if from == t0 {
            rows.push((long, [0xaa; 8], None, t0 + MIN, t0 + 2 * MIN, Vec::new()));
        }
        if from == t0 + 110 * MIN {
            rows.push((long, [0xab; 8], Some([0xaa; 8]), t0 + 110 * MIN, t0 + 111 * MIN, Vec::new()));
        }
        let (s, t) = span_files(&spans_of(&rows));
        spans.extend(s);
        index.extend(t.into_iter().map(|f| f.bytes));
    }
    let window = (t0, t0 + 5 * MIN);
    let bound = (window.0 - 120 * MIN, window.1 + 120 * MIN);
    let e: serde_json::Value = serde_json::from_slice(&run(traces::do_tq_extent, W::default().i64(window.0).i64(window.1).u8(0).i64(bound.0).i64(bound.1).u64(BUDGET).files(&index).files(&[])).unwrap()).unwrap();
    let ranges: Vec<(i64, i64)> = e["ranges"].as_array().unwrap().iter().map(|r| (r[0].as_str().unwrap().parse().unwrap(), r[1].as_str().unwrap().parse().unwrap())).collect();
    // The window's pieces, and the long trace's child: two ranges, the second its child's.
    assert_eq!(ranges.len(), 2, "{e}");
    assert_eq!(ranges[1], (t0 + 110 * MIN, t0 + 111 * MIN));
    assert_eq!(e["hi"], (t0 + 111 * MIN).to_string());
    // Planned by the ranges: the window's units and the child's, not the 11 units of the hull between.
    let plan = |with: &[(i64, i64)]| {
        let mut w = W::default().u64(0).u8(0).i64(e["lo"].as_str().unwrap().parse().unwrap()).i64(e["hi"].as_str().unwrap().parse().unwrap()).u8(0).u32(with.len() as u32);
        for (a, b) in with {
            w = w.i64(*a).i64(*b);
        }
        let idx: Vec<Vec<u8>> = spans.iter().map(|f| f.index.clone().into_bytes()).collect();
        let p: Vec<serde_json::Value> = serde_json::from_slice(&run(traces::do_tq_file_plan, w.files(&idx)).unwrap()).unwrap();
        p.iter().filter(|x| x["read"] != "skip").map(|x| x["rows"].as_u64().unwrap()).sum::<u64>()
    };
    let (by_ranges, by_hull) = (plan(&ranges), plan(&[]));
    assert!(by_ranges <= 3 * 3001, "{by_ranges}");
    assert!(by_hull > 30_000, "{by_hull}");
}

#[test]
fn r2_m4a_trace_by_id_counts_only_the_trace_s_spans() {
    // One flush unit of 20,000 spans is one row group (the README's benchmark unit): refused by
    // max_spans 18,000 before, though the trace has one span.
    let rows: Vec<_> = (1..=20_000u64).map(|i| (id16(i), [1u8; 8], None, T0 + i as i64 * 150_000_000, T0 + i as i64 * 150_000_000 + 1000, Vec::new())).collect();
    let files: Vec<Vec<u8>> = span_files(&spans_of(&rows)).0.into_iter().map(|f| f.bytes).collect();
    assert_eq!(files.len(), 1);
    let mut w = W::default().u8(1);
    w.0.extend_from_slice(&id16(7));
    let w = w.u64(18_000).u64(BUDGET).i64(ALL.0).i64(ALL.1).u32(0).files(&files).files(&[]);
    let (r, held) = peak(|| run(traces::do_tq_trace, w));
    eprintln!("PEAK r2_m4a_trace_by_id_counts_only_the_trace_s_spans r: {} bytes, {}", held, limit_name(&r.as_ref().map(|_| Vec::new()).map_err(|e| e.clone())));
    let out = r.expect("found");
    assert_eq!(out[0], 1);
    assert_eq!(u64::from_le_bytes(out[1..9].try_into().unwrap()), 20_000, "every span is read");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // A trace larger than max_spans is still refused, by its own spans, with advice that can help.
    let big: Vec<_> = (1..=40u64).map(|i| (id16(1), (i as u64).to_be_bytes(), None, T0 + i as i64, T0 + i as i64 + 1, Vec::new())).collect();
    let files: Vec<Vec<u8>> = span_files(&spans_of(&big)).0.into_iter().map(|f| f.bytes).collect();
    let mut w = W::default().u8(1);
    w.0.extend_from_slice(&id16(1));
    let w = w.u64(39).u64(BUDGET).i64(ALL.0).i64(ALL.1).u32(0).files(&files).files(&[]);
    match traces::do_tq_trace(Req { b: &w.0, at: 0 }) {
        Err(Fail::Limit("max_spans", 39, 40, m)) => assert!(m.contains("trace's own spans") && !m.contains("Narrow the time range"), "{m}"),
        _ => panic!("expected max_spans"),
    }
}

#[test]
fn ranges_are_merged_and_joined_closest_first_never_losing_cover() {
    let mut r: Vec<(i64, i64)> = (0..1000).map(|i| (i * 10, i * 10 + 3)).collect();
    r.push((5, 7));
    let all = r.clone();
    traces::merge_for_test(&mut r, 256);
    assert!(r.len() <= 256 && !r.is_empty());
    for (a, b) in all {
        assert!(r.iter().any(|(x, y)| *x <= a && b <= *y), "({a}, {b}) lost");
    }
    let mut t = vec![(0, 5), (6, 9), (20, 30), (25, 26)];
    traces::merge_for_test(&mut t, 256);
    assert_eq!(t, vec![(0, 9), (20, 30)]);
}

#[test]
fn d72_m2_span_local_calls_cut_to_their_window_before_de_duplication() {
    // A span sent with a start inside the window, then re-sent (same ids) with a start 3 h
    // later, in a batch of its own (review of D72, m-2): whether the later batch is read (a shard
    // of the release before, or files planned wider) or skipped (D72), the answer is the same.
    let (t, s) = (id16(0xab), [0xcd; 8]);
    let first = spans_of(&[(t, s, None, T0 + 10 * MIN, T0 + 10 * MIN + 1000, vec![("first.copy".to_string(), "v".to_string())])]);
    let later = spans_of(&[(t, s, None, T0 + 240 * MIN, T0 + 240 * MIN + 1000, vec![("second.copy".to_string(), "v".to_string())])]);
    let (lo, hi) = (T0, T0 + 60 * MIN);
    let tags = |tails: &[Vec<u8>]| run(traces::do_tq_tags, W::default().u8(1).item(b"").i64(lo).i64(hi).u32(0).u64(18_000).u64(BUDGET).files(&[]).files(tails)).map(|b| String::from_utf8(b).unwrap());
    let values = |tails: &[Vec<u8>]| run(traces::do_tq_tag_values, W::default().u8(2).item(b"span.first.copy").item(b"").i64(lo).i64(hi).u32(0).u64(18_000).u64(BUDGET).files(&[]).files(tails)).map(|b| String::from_utf8(b).unwrap());
    let count = |tails: &[Vec<u8>]| {
        let w = W::default().u64(18_000).u64(BUDGET).i64(ALL.0).i64(ALL.1).u32(0).u64(100).u64(1000).u8(1).i64(lo).i64(hi).i64(hi - lo).item(b"{ } | count_over_time()").files(&[]).files(tails);
        run(traces::do_tq_metrics, w).map(|b| String::from_utf8(b[16..].to_vec()).unwrap())
    };
    let both = [first.clone(), later];
    let only = [first];
    assert_eq!(tags(&both), tags(&only));
    assert!(tags(&both).unwrap().contains("first.copy"));
    assert_eq!(values(&both), values(&only));
    assert_eq!(count(&both), count(&only));
    assert!(count(&both).unwrap().contains("\"value\":1"), "{:?}", count(&both));
}

#[test]
fn r2_m3_log_query_lets_go_of_label_sets_no_kept_entry_refers_to() {
    // Structured metadata with a value per line (a trace id) makes each line its own label set.
    // A log query with a limit keeps `limit` entries; it held every label set to the end before,
    // uncounted (measured: 30,000 realistic rows, 36 MiB of WASM against 24 MiB charged).
    let labels = vec![("job".to_string(), "a".to_string())];
    let streams = vec![LogStream { stream_id: otel::stream_id(&labels), labels }];
    let rows: Vec<LogRow<String>> = (0..30_000)
        .map(|i| LogRow { entry: 0, ts: T0 + i as i64, observed_ts: 0, trace_id: [0; 16], span_id: [0; 8], flags: 0, severity_number: 0, line: format!("line {i}"), severity_text: String::new(), metadata: vec![("trace".to_string(), format!("{i:0>200}"))] })
        .collect();
    let b = otel::encode_logs(&streams, &rows).expect("log batch");
    let w = W::default().u64(1_000_000).u64(BUDGET).u64(10_000).u64(11_000).u32(100).u8(0).u8(0).i64(T0).i64(T0 + 60 * MIN).i64(60_000_000_000).item(br#"{job="a"}"#).files(&[]).files(&[b]);
    let (r, held) = peak(|| run(logs::do_lq_query, w));
    eprintln!("PEAK r2_m3_log_query_lets_go_of_label_sets_no_kept_entry_refers_to: {held} bytes, {}", limit_name(&r));
    assert!(r.is_ok(), "{r:?}");
    assert!(held <= BUDGET + SLACK, "held {held}");
}

#[test]
fn r2_m2_tag_names_search_answers_and_kept_log_lines_are_charged_before_they_grow() {
    // Tag names: 400 spans of one trace, each with 120 keys of its own of 500 bytes (27 MB as
    // records): the set of names grows while every record is held, and is refused as it grows.
    let rows: Vec<_> = (1..=400u64).map(|i| (id16(1), i.to_be_bytes(), None, T0 + i as i64 * 1_000_000, T0 + i as i64 * 1_000_000 + 1000, (0..120).map(|k| (format!("{i}-{k}-{}", "k".repeat(490)), "v".to_string())).collect())).collect();
    let files: Vec<Vec<u8>> = rows.chunks(10).flat_map(|c| span_files(&spans_of(c)).0.into_iter().map(|f| f.bytes)).collect();
    let w = W::default().u8(1).item(b"").i64(T0).i64(T0 + 60 * MIN).u32(0).u64(18_000).u64(BUDGET).files(&files).files(&[]);
    let (r, held) = peak(|| run(traces::do_tq_tags, w));
    eprintln!("PEAK r2_m2 tag names: {held} bytes, {}", limit_name(&r));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // A search whose answer echoes a 60 KB attribute of each of 250 spans of one trace: the spans
    // (15 MB) and their results (15 MB) fit, the answer (15 MB, four times) does not, and is
    // refused before it is written; 500 such spans are refused as their results are made.
    for (n, stage) in [(250u64, "its answer"), (500, "the traces and spans its answer lists")] {
    let rows: Vec<_> = (1..=n).map(|i| (id16(1), i.to_be_bytes(), None, T0 + i as i64 * 1_000_000, T0 + i as i64 * 1_000_000 + 1000, vec![("blob".to_string(), format!("{i}{}", "x".repeat(60_000)))])).collect();
    let files: Vec<Vec<u8>> = rows.chunks(10).flat_map(|c| span_files(&spans_of(c)).0.into_iter().map(|f| f.bytes)).collect();
    let q = br#"{ span.blob != "" }"#;
    let w = W::default().u64(18_000).u64(BUDGET).i64(ALL.0).i64(ALL.1).u32(0).u32(20).u32(1000).i64(T0 - 5 * MIN).i64(T0 + 60 * MIN).item(q).files(&files).files(&[]);
    let (r, held) = peak(|| traces::do_tq_search(Req { b: &w.0, at: 0 }));
    eprintln!("PEAK r2_m2 search answer of {n} spans: {held} bytes");
    match r {
        Err(Fail::Limit("max_decoded_bytes", _, _, m)) => assert!(m.contains(stage), "{m}"),
        _ => panic!("expected max_decoded_bytes"),
    }
    assert!(held <= BUDGET + SLACK, "held {held}");
    }
    // A log query keeps up to max(2 x limit, 1024) lines while it reads: 150 lines of 200 KB fit as
    // rows (30 MB), their copies kept for the answer do not.
    let fat: Vec<String> = (0..150).map(|i| format!("{}{i}", "x".repeat(200_000))).collect();
    let b = log_batch(&fat);
    let w = W::default().u64(1_000_000).u64(BUDGET).u64(10_000).u64(11_000).u32(100).u8(0).u8(0).i64(T0).i64(T0 + 60 * MIN).i64(60_000_000_000).item(br#"{job="a"}"#).files(&[]).files(&[b]);
    let (r, held) = peak(|| run(logs::do_lq_query, w));
    eprintln!("PEAK r2_m2 log lines kept: {held} bytes, {}", limit_name(&r));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
}

// ───────────────────────────── D81 ─────────────────────────────

/// A file plan request (`viz_q_tq_file_plan` / `viz_q_tq_probe`), all time, with an id.
fn fq(table: u8, id: Option<&[u8; 16]>, ranges: &[(i64, i64)], lo: i64, hi: i64) -> W {
    let mut w = W::default().u64(0).u8(table).i64(lo).i64(hi);
    match id {
        Some(id) => {
            w = w.u8(1);
            w.0.extend_from_slice(id);
        }
        None => w = w.u8(0),
    }
    w = w.u32(ranges.len() as u32);
    for (a, b) in ranges {
        w = w.i64(*a).i64(*b);
    }
    w
}

fn plans_of(b: Result<Vec<u8>, String>) -> Vec<serde_json::Value> {
    serde_json::from_slice(&b.expect("plan")).unwrap()
}

fn pairs(v: &serde_json::Value) -> Vec<(u64, u64)> {
    v.as_array().map(|a| a.iter().map(|x| (x[0].as_u64().unwrap(), x[1].as_u64().unwrap())).collect()).unwrap_or_default()
}

/// The file as a plan reads it: skipped (None), whole, or its ranges.
fn as_read(file: &[u8], p: &serde_json::Value) -> Option<Vec<u8>> {
    match &p["read"] {
        serde_json::Value::String(s) if s == "skip" => None,
        serde_json::Value::String(_) => Some(file.to_vec()),
        r => Some(viz_storage::sparse::cut(file, &pairs(r))),
    }
}

/// Probe `files` (with their fragments) for `id`: the plans after the bloom filters.
fn probe(table: u8, files: &[viz_storage::SignalFile], id: &[u8; 16]) -> (Vec<serde_json::Value>, Vec<serde_json::Value>) {
    let idx: Vec<Vec<u8>> = files.iter().map(|f| f.index.clone().into_bytes()).collect();
    let first = plans_of(run(traces::do_tq_file_plan, fq(table, Some(id), &[], ALL.0, ALL.1).files(&idx)));
    let blooms: Vec<Vec<u8>> = files.iter().zip(&first).map(|(f, p)| if p["read"] == "skip" { Vec::new() } else { viz_storage::sparse::cut(&f.bytes, &pairs(&p["bloom"])) }).collect();
    let after = plans_of(run(traces::do_tq_probe, fq(table, Some(id), &[], ALL.0, ALL.1).files(&idx).files(&blooms)));
    (first, after)
}

/// A random-looking trace id (splitmix64): ids of one unit spread over the whole id range, as
/// real ones do, so a `trace_index` row group's id range prunes nothing.
fn rid(n: u64) -> [u8; 16] {
    let mix = |mut z: u64| {
        z = z.wrapping_add(0x9e37_79b9_7f4a_7c15);
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    };
    let mut t = [0u8; 16];
    t[..8].copy_from_slice(&mix(n).to_be_bytes());
    t[8..].copy_from_slice(&mix(n ^ 0x5555).to_be_bytes());
    t
}

/// 30 flush units of 400 single-span traces each, every id distinct.
fn units() -> (Vec<viz_storage::SignalFile>, Vec<viz_storage::SignalFile>) {
    let (mut spans, mut index) = (Vec::new(), Vec::new());
    for u in 0..30u64 {
        let rows: Vec<_> = (0..400u64).map(|i| (rid(u * 1000 + i + 1), [1u8; 8], None, T0 + (u * 400 + i) as i64 * 1_000_000, T0 + (u * 400 + i) as i64 * 1_000_000 + 1000, Vec::new())).collect();
        let (s, t) = span_files(&spans_of(&rows));
        spans.extend(s);
        index.extend(t);
    }
    (spans, index)
}

#[test]
fn d81_trace_by_id_keeps_every_row_group_that_holds_the_id_and_few_others() {
    let (spans, index) = units();
    for (table, files) in [(0u8, &spans), (1u8, &index)] {
        let mut kept_others = 0usize;
        let mut probed = 0usize;
        for u in 0..30u64 {
            for i in [0u64, 137, 399] {
                let id = rid(u * 1000 + i + 1);
                let (first, after) = probe(table, files, &id);
                // Every file read lists its filter (one row group per unit).
                assert!(first.iter().all(|p| p["bloom"].as_array().unwrap().len() == (p["read"] != "skip") as usize), "{first:?}");
                for (k, p) in after.iter().enumerate() {
                    let holds = k as u64 == u;
                    if holds {
                        assert_ne!(p["read"], "skip", "table {table}: the unit holding the id was dropped");
                        assert_eq!(p["skipped"], 0);
                    } else if p["read"] != "skip" {
                        kept_others += 1;
                    }
                    probed += 1;
                }
            }
        }
        // 1% filters, sized for the group: a false positive now and then, not every file.
        assert!(kept_others * 20 < probed, "table {table}: {kept_others} of {probed} kept without the id");
        // An id held nowhere: nearly every file is skipped.
        let (_, after) = probe(table, files, &rid(999_999_999));
        assert!(after.iter().filter(|p| p["read"] != "skip").count() <= 3, "{after:?}");
    }
}

#[test]
fn d81_trace_by_id_answers_the_same_from_the_probed_row_groups() {
    let (spans, _) = units();
    let whole: Vec<Vec<u8>> = spans.iter().map(|f| f.bytes.clone()).collect();
    let trace = |files: &[Vec<u8>], id: &[u8; 16]| {
        let mut w = W::default().u8(2);
        w.0.extend_from_slice(id);
        run(traces::do_tq_trace, w.u64(18_000).u64(BUDGET).i64(ALL.0).i64(ALL.1).u32(0).files(files).files(&[])).unwrap()
    };
    for id in [rid(1), rid(5_200), rid(29_400), rid(999_999)] {
        let (_, after) = probe(0, &spans, &id);
        let read: Vec<Vec<u8>> = spans.iter().zip(&after).filter_map(|(f, p)| as_read(&f.bytes, p)).collect();
        let (a, b) = (trace(&whole, &id), trace(&read, &id));
        assert_eq!(a[0], b[0]);
        assert_eq!(&a[9..], &b[9..], "the trace's answer differs");
        assert!(read.len() <= 2, "{} files read", read.len());
    }
}

#[test]
fn d81_a_filter_that_is_not_named_not_read_or_does_not_parse_keeps_its_row_group() {
    let (spans, _) = units();
    let id = rid(999_999_999);
    let idx: Vec<Vec<u8>> = spans.iter().map(|f| f.index.clone().into_bytes()).collect();
    let first = plans_of(run(traces::do_tq_file_plan, fq(0, Some(&id), &[], ALL.0, ALL.1).files(&idx)));
    let count = |after: &[serde_json::Value]| after.iter().filter(|p| p["read"] != "skip").count();
    // No container: nothing is dropped.
    let none: Vec<Vec<u8>> = spans.iter().map(|_| Vec::new()).collect();
    assert_eq!(count(&plans_of(run(traces::do_tq_probe, fq(0, Some(&id), &[], ALL.0, ALL.1).files(&idx).files(&none)))), 30);
    // A container of other bytes (the footer), or a filter whose header is damaged: nothing is dropped.
    let other: Vec<Vec<u8>> = spans.iter().map(|f| viz_storage::sparse::cut(&f.bytes, &[(f.bytes.len() as u64 - 8, 8)])).collect();
    assert_eq!(count(&plans_of(run(traces::do_tq_probe, fq(0, Some(&id), &[], ALL.0, ALL.1).files(&idx).files(&other)))), 30);
    let damaged: Vec<Vec<u8>> = spans
        .iter()
        .zip(&first)
        .map(|(f, p)| {
            let (o, l) = pairs(&p["bloom"])[0];
            let mut b = f.bytes.clone();
            b[o as usize] ^= 0xff;
            viz_storage::sparse::cut(&b, &[(o, l)])
        })
        .collect();
    assert_eq!(count(&plans_of(run(traces::do_tq_probe, fq(0, Some(&id), &[], ALL.0, ALL.1).files(&idx).files(&damaged)))), 30);
    // A fragment without `bf` (a file written before D81): no filter is listed or used.
    let old: Vec<Vec<u8>> = spans.iter().map(|f| strip_bf(&f.index).into_bytes()).collect();
    let p = plans_of(run(traces::do_tq_file_plan, fq(0, Some(&id), &[], ALL.0, ALL.1).files(&old)));
    assert!(p.iter().all(|x| x["bloom"].as_array().unwrap().is_empty()));
    let blooms: Vec<Vec<u8>> = spans.iter().zip(&first).map(|(f, p)| viz_storage::sparse::cut(&f.bytes, &pairs(&p["bloom"]))).collect();
    assert_eq!(count(&plans_of(run(traces::do_tq_probe, fq(0, Some(&id), &[], ALL.0, ALL.1).files(&old).files(&blooms)))), 30);
    // The same fragments with their filters: all 30 are dropped or nearly so.
    assert!(count(&plans_of(run(traces::do_tq_probe, fq(0, Some(&id), &[], ALL.0, ALL.1).files(&idx).files(&blooms)))) <= 3);
}

/// A fragment as a writer before D81 wrote it: no `bf`.
fn strip_bf(index: &str) -> String {
    let mut out = String::new();
    let mut rest = index;
    while let Some(at) = rest.find(",\"bf\":[") {
        out.push_str(&rest[..at]);
        let end = rest[at..].find(']').unwrap();
        rest = &rest[at + end + 1..];
    }
    out.push_str(rest);
    out
}

#[test]
fn d81_a_search_cut_to_its_traces_ranges_answers_the_same_and_holds_only_their_neighbourhood() {
    // Two units of 6,000 spans over ten minutes each; the search window is two seconds of them.
    let mut files = Vec::new();
    let mut idx = Vec::new();
    for u in 0..2i64 {
        let rows: Vec<_> = (0..6000i64).map(|i| (id16((u * 10_000 + i + 1) as u64), [1u8; 8], None, T0 + u * 10 * MIN + i * 100_000_000, T0 + u * 10 * MIN + i * 100_000_000 + 5_000, Vec::new())).collect();
        let (s, t) = span_files(&spans_of(&rows));
        files.extend(s.into_iter().map(|f| f.bytes));
        idx.extend(t.into_iter().map(|f| f.bytes));
    }
    let (lo, hi) = (T0 + 3 * MIN, T0 + 3 * MIN + 2_000_000_000);
    let bound = (lo - 120 * MIN, hi + 120 * MIN);
    let e: serde_json::Value = serde_json::from_slice(&run(traces::do_tq_extent, W::default().i64(lo).i64(hi).u8(0).i64(bound.0).i64(bound.1).u64(BUDGET).files(&idx).files(&[])).unwrap()).unwrap();
    let ranges: Vec<(i64, i64)> = e["ranges"].as_array().unwrap().iter().map(|r| (r[0].as_str().unwrap().parse().unwrap(), r[1].as_str().unwrap().parse().unwrap())).collect();
    assert!(!ranges.is_empty());
    let search = |max_spans: u64, rs: &[(i64, i64)]| {
        let mut w = W::default().u64(max_spans).u64(BUDGET).i64(bound.0).i64(bound.1).u32(rs.len() as u32);
        for (a, b) in rs {
            w = w.i64(*a).i64(*b);
        }
        run(traces::do_tq_search, w.u32(100).u32(3).i64(lo).i64(hi).item(b"{ }").files(&files).files(&[])).map(|b| String::from_utf8(b[16..].to_vec()).unwrap())
    };
    // Tempo's `metrics` (what was inspected) differ by design; the traces must not.
    let traces = |s: String| s[..s.rfind(",\"metrics\":{").unwrap()].to_string();
    let all = traces(search(1_000_000, &[]).unwrap());
    assert!(all.contains("traceID"), "{all}");
    // Without the ranges every span of the units' row groups is held (12,000): refused at 1,000.
    assert_eq!(search(1_000, &[]), Err("limit max_spans".into()));
    // With them only the spans that start inside the found traces' pieces: the same traces.
    assert_eq!(traces(search(1_000, &ranges).unwrap()), all);
}

#[test]
fn d81_certain_rows_are_the_row_groups_wholly_inside_the_range() {
    // One unit, row groups of 100 spans, one span every second for 1,000 s.
    let rows: Vec<_> = (0..1000i64).map(|i| (id16(i as u64 + 1), [1u8; 8], None, T0 + i * 1_000_000_000, T0 + i * 1_000_000_000 + 1, Vec::new())).collect();
    let b = spans_of(&rows);
    let opts = viz_storage::SignalWriteOptions { max_row_group_rows: 100, ..Default::default() };
    let files: Vec<_> = viz_storage::encode_spans_with(&[&b], &opts).unwrap().into_iter().filter(|f| f.table == viz_storage::SignalTable::Spans).collect();
    let idx: Vec<Vec<u8>> = files.iter().map(|f| f.index.clone().into_bytes()).collect();
    let plan = |lo: i64, hi: i64| {
        let p = &plans_of(run(traces::do_tq_file_plan, fq(0, None, &[], lo, hi).files(&idx)))[0];
        (p["rows"].as_u64().unwrap(), p["certain"].as_u64().unwrap())
    };
    let s = 1_000_000_000i64;
    assert_eq!(plan(T0, T0 + 999 * s), (1000, 1000));
    // Seconds 150..=449: groups 1..=4 overlap (400 rows), groups 2 and 3 lie inside (200).
    assert_eq!(plan(T0 + 150 * s, T0 + 449 * s), (400, 200));
    // Two seconds inside one group: 100 rows read, none certain.
    assert_eq!(plan(T0 + 150 * s, T0 + 151 * s), (100, 0));
}

#[test]
fn d81_certain_log_rows_need_the_range_and_every_stream_of_the_group() {
    // S10's blocks C and D: sent together, far apart in time, one row group.
    let labels = vec![("job".to_string(), "a".to_string())];
    let other = vec![("job".to_string(), "b".to_string())];
    let streams = vec![LogStream { stream_id: otel::stream_id(&labels), labels: labels.clone() }, LogStream { stream_id: otel::stream_id(&other), labels: other }];
    let row = |entry: u32, ts: i64| LogRow { entry, ts, observed_ts: 0, trace_id: [0; 16], span_id: [0; 8], flags: 0, severity_number: 0, line: format!("l{ts}"), severity_text: String::new(), metadata: Vec::new() };
    let mut rows: Vec<LogRow<String>> = (0..300).map(|i| row(0, T0 + i)).collect();
    rows.extend((0..300).map(|i| row(0, T0 + 6 * 60 * MIN + i)));
    let b = otel::encode_logs(&streams[..1], &rows).unwrap();
    let files = viz_storage::encode_logs(&[&b]).unwrap();
    assert_eq!(files.len(), 1);
    let idx = vec![files[0].index.clone().into_bytes()];
    let plan = |start: i64, end: i64, job: &str| {
        let w = W::default().u64(0).u32(1).i64(start).i64(end).u32(1).u8(0).item(b"job").item(job.as_bytes()).files(&idx);
        let p = &plans_of(run(logs::do_lq_file_plan, w))[0];
        (p["rows"].as_u64().unwrap(), p["certain"].as_u64().unwrap())
    };
    // Block C's hour: the group straddles it (C and D), so nothing is certain; the engine counts.
    assert_eq!(plan(T0, T0 + 60 * MIN, "a"), (600, 0));
    // Both blocks: certain.
    assert_eq!(plan(T0, T0 + 7 * 60 * MIN, "a"), (600, 600));
    // A selector the group's stream does not match reads nothing.
    assert_eq!(plan(T0, T0 + 7 * 60 * MIN, "b").1, 0);
    // A group with a stream the selector does not admit is not certain (one group, both streams).
    let mut mixed = rows.clone();
    mixed.extend((0..10).map(|i| row(1, T0 + 100 + i)));
    let b = otel::encode_logs(&streams, &mixed).unwrap();
    let files = viz_storage::encode_logs(&[&b]).unwrap();
    let idx = vec![files[0].index.clone().into_bytes()];
    let w = W::default().u64(0).u32(1).i64(T0).i64(T0 + 7 * 60 * MIN).u32(1).u8(0).item(b"job").item(b"a").files(&idx);
    let p = &plans_of(run(logs::do_lq_file_plan, w))[0];
    assert_eq!(p["certain"], 0, "{p}");
}

/// D81's measurement (measured here, native release build, not WASM): S10's realistic shape
/// scaled to one hour at about 700,000 single-span traces, as 66 flush units of 10,500 spans with
/// S10's attributes; the bytes trace by ID fetches without and with the bloom filters (exact, the
/// same in WASM), and the engine's time for each, alternated. Run with
/// `cargo test --release d81_measure -- --ignored --nocapture`.
#[test]
#[ignore]
fn d81_measure_trace_by_id_over_an_hour_of_units() {
    let units: usize = std::env::var("D81_UNITS").ok().and_then(|v| v.parse().ok()).unwrap_or(66);
    let per = 10_500u64;
    let (mut spans, mut index) = (Vec::new(), Vec::new());
    for u in 0..units as u64 {
        let rows: Vec<_> = (0..per)
            .map(|i| {
                let n = u * per + i;
                let t = T0 + (n as i64) * 5_140_000; // 700,000 an hour
                (rid(n + 1), (n + 1).to_be_bytes(), None, t, t + 2_000_000 + (n % 97) as i64 * 1_000_000, vec![("http.route".to_string(), format!("/api/v1/items/{}", n % 50)), ("http.request.method".to_string(), "GET".to_string())])
            })
            .collect();
        let (s, t) = span_files(&spans_of(&rows));
        spans.extend(s);
        index.extend(t);
    }
    let size = |v: &[viz_storage::SignalFile]| v.iter().map(|f| f.bytes.len()).sum::<usize>();
    let bf: Vec<u64> = spans.iter().flat_map(|f| pairs(&serde_json::from_str::<serde_json::Value>(&f.index).unwrap()["rg"].as_array().unwrap().iter().map(|g| g["bf"].clone()).collect::<serde_json::Value>()).into_iter().map(|p| p.1)).collect();
    eprintln!("MEASURE units {units} spans {} B ({} B/span), trace_index {} B ({} B/span); spans bloom per unit {:?} B", size(&spans), size(&spans) as f64 / (units as f64 * per as f64), size(&index), size(&index) as f64 / (units as f64 * per as f64), bf.iter().min().zip(bf.iter().max()));
    let fetched = |files: &[viz_storage::SignalFile], plans: &[serde_json::Value]| -> u64 {
        files
            .iter()
            .zip(plans)
            .map(|(f, p)| match &p["read"] {
                serde_json::Value::String(s) if s == "skip" => 0,
                serde_json::Value::String(_) => f.bytes.len() as u64,
                r => pairs(r).iter().map(|x| x.1).sum(),
            })
            .sum()
    };
    let trace = |files: &[Vec<u8>], id: &[u8; 16]| {
        let mut w = W::default().u8(2);
        w.0.extend_from_slice(id);
        run(traces::do_tq_trace, w.u64(18_000).u64(BUDGET).i64(ALL.0).i64(ALL.1).u32(0).files(files).files(&[])).unwrap()
    };
    for round in 0..3 {
        for with in [false, true] {
            let id = rid((round as u64 * 7919 + 13) % (units as u64 * per) + 1);
            let t0 = std::time::Instant::now();
            let (ti_bytes, sp_bytes, bloom_bytes, sp_read): (u64, u64, u64, Vec<Vec<u8>>);
            if with {
                let (f1, a1) = probe(1, &index, &id);
                let (f2, a2) = probe(0, &spans, &id);
                bloom_bytes = f1.iter().chain(&f2).map(|p| pairs(&p["bloom"]).iter().map(|x| x.1).sum::<u64>()).sum();
                ti_bytes = fetched(&index, &a1);
                sp_bytes = fetched(&spans, &a2);
                sp_read = spans.iter().zip(&a2).filter_map(|(f, p)| as_read(&f.bytes, p)).collect();
            } else {
                let idx1: Vec<Vec<u8>> = index.iter().map(|f| f.index.clone().into_bytes()).collect();
                let p1 = plans_of(run(traces::do_tq_file_plan, fq(1, Some(&id), &[], ALL.0, ALL.1).files(&idx1)));
                let idx0: Vec<Vec<u8>> = spans.iter().map(|f| f.index.clone().into_bytes()).collect();
                let p0 = plans_of(run(traces::do_tq_file_plan, fq(0, None, &[], ALL.0, ALL.1).files(&idx0)));
                bloom_bytes = 0;
                ti_bytes = fetched(&index, &p1);
                sp_bytes = fetched(&spans, &p0);
                sp_read = spans.iter().zip(&p0).filter_map(|(f, p)| as_read(&f.bytes, p)).collect();
            }
            let out = trace(&sp_read, &id);
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(out[0], 1, "found");
            eprintln!("MEASURE round {round} blooms {with}: trace_index {ti_bytes} B, spans {sp_bytes} B, blooms {bloom_bytes} B, total {} B; spans files read {}; plan+probe+trace {ms:.1} ms", ti_bytes + sp_bytes + bloom_bytes, sp_read.len());
        }
    }
}
