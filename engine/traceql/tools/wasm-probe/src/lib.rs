//! A minimal C ABI over viz-traceql, to measure it as a WebAssembly module (size, imports,
//! instantiation, speed). Not the production binding: `engine/wasm-query` shows how engines
//! are exposed to Workers; integrating TraceQL there is listed under "Integration".
//!
//! `viz_tq_alloc(n)` returns a buffer; `viz_tq_run(kind, ptr, len)` takes a request
//! `query \0 n_traces` and answers with a pointer to `u32 len` + JSON. The traces are
//! generated inside the module (no data crosses the boundary in this probe).

use viz_traceql::{query_range, search, AttrValue, Kind, MemSource, RangeRequest, SearchRequest, Span, Status, Trace};

#[no_mangle]
pub extern "C" fn viz_tq_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
/// # Safety
/// `p` must come from `viz_tq_alloc(n)`.
pub unsafe extern "C" fn viz_tq_free(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n));
}

fn data(n: usize) -> Vec<Trace> {
    let mut seed = 0x9e3779b97f4a7c15u64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let services = ["frontend", "cart", "db", "auth"];
    (0..n)
        .map(|t| {
            let spans = (0..10u64)
                .map(|i| {
                    let start = 1_700_000_000_000_000_000 + (t as u64) * 1_000_000_000 + i * 1_000_000;
                    Span {
                        span_id: (next() | 1).to_be_bytes(),
                        parent_span_id: None,
                        name: format!("op{}", next() % 5),
                        kind: Kind::from_otlp((next() % 6) as i32),
                        status: Status::from_otlp((next() % 3) as i32),
                        start_unix_nano: start,
                        end_unix_nano: start + next() % 1_000_000_000,
                        resource: vec![("service.name".into(), AttrValue::Str(services[(next() % 4) as usize].into()))],
                        attrs: vec![
                            ("http.status_code".into(), AttrValue::Int([200, 404, 500][(next() % 3) as usize])),
                            // For the nesting shapes of `check.mjs`, which test `.a = 1`.
                            ("a".into(), AttrValue::Int(1)),
                        ],
                        ..Default::default()
                    }
                })
                .collect::<Vec<_>>();
            let mut spans = spans;
            let root = spans[0].span_id;
            for s in spans.iter_mut().skip(1) {
                s.parent_span_id = Some(root);
            }
            Trace::new([(t as u8) | 0x10; 16], spans)
        })
        .collect()
}

#[no_mangle]
/// # Safety
/// `p..p+n` must be a request written into memory from `viz_tq_alloc`.
pub unsafe extern "C" fn viz_tq_run(kind: u32, p: *const u8, n: usize) -> *mut u8 {
    let req = std::slice::from_raw_parts(p, n);
    let (q, rest) = match req.iter().position(|b| *b == 0) {
        Some(i) => (&req[..i], &req[i + 1..]),
        None => (req, &[][..]),
    };
    let q = String::from_utf8_lossy(q);
    let traces: usize = std::str::from_utf8(rest).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(10);
    let src = MemSource::new(data(traces));
    let out = if kind == 0 {
        match search(&src, &q, &SearchRequest { limit: 20, spans_per_spanset: 3, start_unix_nano: 0, end_unix_nano: 0 }) {
            Ok(r) => r.to_json(),
            Err(e) => format!("{{\"error\":{:?}}}", e.to_string()),
        }
    } else {
        let start = 1_700_000_000_000_000_000u64;
        match query_range(&src, &q, &RangeRequest::range(start, start + (traces as u64 + 1) * 1_000_000_000, 60_000_000_000)) {
            Ok(r) => r.to_json(),
            Err(e) => format!("{{\"error\":{:?}}}", e.to_string()),
        }
    };
    let mut buf = Vec::with_capacity(out.len() + 4);
    buf.extend_from_slice(&(out.len() as u32).to_le_bytes());
    buf.extend_from_slice(out.as_bytes());
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}
