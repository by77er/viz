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
    let w = W::default().u64(1_000_000).u64(max_bytes).i64(bound.0).i64(bound.1).u32(100).u32(100).i64(T0 - 5 * MIN).i64(T0 + 10 * MIN).item(q.as_bytes()).files(files).files(tails);
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
        w.u64(1_000_000).u64(max).i64(ALL.0).i64(ALL.1).files(&[]).files(&[b.clone()])
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
    let w = |max_bytes: u64| W::default().u64(1_000_000).u64(max_bytes).i64(ALL.0).i64(ALL.1).u64(10_000).u64(11_000).u8(0).i64(T0 - MIN).i64(T0 + 10_000 * 1_000_000_000).i64(1_000_000_000).item(b"{ } | count_over_time() by (name)").files(&[]).files(std::slice::from_ref(&b));
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

/// `viz_q_tq_metrics` over `files` for 11,000 points over a day (the review's request).
fn metrics(files: &[Vec<u8>], q: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
    let step = 7_854_000_000i64;
    let start = T0 - 12 * 60 * MIN;
    let w = W::default().u64(18_000).u64(max_bytes).i64(ALL.0).i64(ALL.1).u64(10_000).u64(11_000).u8(0).i64(start).i64(start + 10_999 * step).i64(step).item(q.as_bytes()).files(files).files(&[]);
    run(traces::do_tq_metrics, w)
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
    let (r, held) = peak(|| metrics(&files, "{ } | histogram_over_time(duration) by (span.g)", BUDGET));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // One group of a few buckets fits and answers.
    let small = grouped(1, 4);
    let (ok, held) = peak(|| metrics(&small, "{ } | histogram_over_time(duration) by (span.g)", BUDGET));
    assert!(ok.is_ok(), "{ok:?}");
    assert!(held <= BUDGET + SLACK, "held {held}");
}

#[test]
fn r2_m2_one_series_per_quantile_is_charged_when_its_group_is_made() {
    // 100 quantiles x 8 groups x 11,000 points (869.8 MiB before).
    let files = grouped(8, 60);
    let qs: Vec<String> = (1..=100).map(|i| format!("{:.4}", i as f64 / 101.0)).collect();
    let q = format!("{{ }} | quantile_over_time(duration, {}) by (span.g)", qs.join(", "));
    let (r, held) = peak(|| metrics(&files, &q, BUDGET));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // Three quantiles of the same data answer.
    let (ok, held) = peak(|| metrics(&files, "{ } | quantile_over_time(duration, .5, .9, .99) by (span.g)", BUDGET));
    assert!(ok.is_ok(), "{ok:?}");
    assert!(held <= BUDGET + SLACK, "held {held}");
}

#[test]
fn r2_m2_a_metric_answer_is_charged_before_it_is_written() {
    // 60 groups x 11,000 points of rate(): series fit, the answer (about 33 MB of text, four
    // copies) does not; refused before it is written (65 MiB before).
    let files = grouped(60, 1);
    let (r, held) = peak(|| metrics(&files, "{ } | rate() by (span.g)", BUDGET));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
}

#[test]
fn r2_m2_tag_values_are_charged_as_the_set_grows() {
    // 500 spans with their own 60 KB value (107.7 MiB before).
    let rows: Vec<_> = (1..=500u64).map(|i| (id16(i), [1u8; 8], None, T0 + i as i64 * 1_000_000, T0 + i as i64 * 1_000_000 + 1000, vec![("blob".to_string(), format!("{i}{}", "x".repeat(60_000)))])).collect();
    let files: Vec<Vec<u8>> = rows.chunks(10).flat_map(|c| span_files(&spans_of(c)).0.into_iter().map(|f| f.bytes)).collect();
    let call = |max: u64| {
        let w = W::default().u8(2).item(b"span.blob").item(b"").i64(T0).i64(T0 + 60 * MIN).u32(0).u64(18_000).u64(max).files(&files).files(&[]);
        run(traces::do_tq_tag_values, w)
    };
    let (r, held) = peak(|| call(BUDGET));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // A third of them answer.
    let files: Vec<Vec<u8>> = files[..17].to_vec();
    let w = W::default().u8(2).item(b"span.blob").item(b"").i64(T0).i64(T0 + 60 * MIN).u32(0).u64(18_000).u64(BUDGET).files(&files).files(&[]);
    let (ok, held) = peak(|| run(traces::do_tq_tag_values, w));
    assert!(ok.is_ok(), "{ok:?}");
    assert!(held <= BUDGET + SLACK, "held {held}");
}

#[test]
fn r2_m2_label_sets_from_regexp_and_label_format_are_charged_as_series_are_made() {
    // 14,000 rows of 2 KB, a series per row whose labels are 14 KB (221.4 MiB before, and 200).
    let lines: Vec<String> = (0..14_000).map(|i| format!("{i:08}{}", "y".repeat(2000))).collect();
    let tails: Vec<Vec<u8>> = lines.chunks(500).map(log_batch).collect();
    let q = r#"count(sum by (x, y, z) (count_over_time({job="a"} | regexp "(?P<x>.+)" | label_format y="{{.x}}{{.x}}", z="{{.y}}{{.y}}" [1h])))"#;
    let call = |max_bytes: u64| {
        let w = W::default().u64(30_000).u64(max_bytes).u64(20_000).u64(11_000).u32(100).u8(0).u8(1).i64(T0 + 60 * MIN).i64(T0 + 60 * MIN).i64(1).item(q.as_bytes()).files(&[]).files(&tails);
        run(logs::do_lq_query, w)
    };
    let (r, held) = peak(|| call(BUDGET));
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

fn labels_call(kind: u8, name: &str, files: &[Vec<u8>], max_bytes: u64) -> Result<Vec<u8>, String> {
    let w = W::default().u8(kind).item(name.as_bytes()).i64(T0 - MIN).i64(T0 + 60 * MIN).u64(max_bytes).u32(1).item(br#"{job="a"}"#).u32(0).files(files).files(&[]);
    run(logs::do_lq_labels, w)
}

#[test]
fn r2_m1_the_label_calls_have_a_budget_and_refuse_past_it_before_they_hold_it() {
    // 300 streams, 3.45 MiB of files: /series held 399 MiB and answered 71 MiB before.
    let files = fat_streams(300);
    let (r, held) = peak(|| labels_call(2, "", &files, BUDGET));
    assert_eq!(limit_name(&r), "limit max_decoded_bytes");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // Names keep only the names: they answer, in little memory, however fat the values.
    let (names, held) = peak(|| labels_call(0, "", &files, BUDGET));
    let names: Vec<String> = serde_json::from_slice(&names.expect("names")).unwrap();
    assert_eq!(names.len(), 32);
    assert!(held <= BUDGET + SLACK, "held {held}");
    // Values of one label: 300 values of 8 KB, a 2.4 MB answer (four times charged) fit.
    let values: Vec<String> = serde_json::from_slice(&labels_call(1, "l0", &files, BUDGET).expect("values")).unwrap();
    assert_eq!(values.len(), 300);
    // A few streams' series answer, as `serde_json` wrote them before.
    let few = fat_streams(20);
    let got = labels_call(2, "", &few, BUDGET).expect("series");
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
    let (r, held) = peak(|| call(BUDGET));
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
    let w = w.u64(18_000).u64(BUDGET).i64(ALL.0).i64(ALL.1).files(&files).files(&[]);
    let (r, held) = peak(|| run(traces::do_tq_trace, w));
    let out = r.expect("found");
    assert_eq!(out[0], 1);
    assert_eq!(u64::from_le_bytes(out[1..9].try_into().unwrap()), 20_000, "every span is read");
    assert!(held <= BUDGET + SLACK, "held {held}");
    // A trace larger than max_spans is still refused, by its own spans, with advice that can help.
    let big: Vec<_> = (1..=40u64).map(|i| (id16(1), (i as u64).to_be_bytes(), None, T0 + i as i64, T0 + i as i64 + 1, Vec::new())).collect();
    let files: Vec<Vec<u8>> = span_files(&spans_of(&big)).0.into_iter().map(|f| f.bytes).collect();
    let mut w = W::default().u8(1);
    w.0.extend_from_slice(&id16(1));
    let w = w.u64(39).u64(BUDGET).i64(ALL.0).i64(ALL.1).files(&files).files(&[]);
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
