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
        Err(Fail::Limit("max_decoded_bytes", _, _, m)) => assert!(m.contains("series of"), "{m}"),
        other => panic!("expected max_decoded_bytes, got ok={}", other.is_ok()),
    }
    assert!(run(traces::do_tq_metrics, w(BIG)).is_ok());
}
