//! Generated trace data and TraceQL queries, shared by the property tests and the
//! differential exporter. Deterministic: everything comes from a seeded xorshift generator.
#![allow(dead_code)]

use viz_traceql::{AttrValue, Event, Kind, Link, Span, Status, Trace};

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }
    pub fn chance(&mut self, p: f64) -> bool {
        (self.next() % 1_000_000) as f64 / 1_000_000.0 < p
    }
    pub fn pick<'a, T>(&mut self, v: &'a [T]) -> &'a T {
        &v[self.below(v.len() as u64) as usize]
    }
}

pub const BASE: u64 = 1_700_000_000_000_000_000;
pub const WINDOW_S: u64 = 600;

pub const SERVICES: [&str; 7] = ["frontend", "cart", "checkout", "db", "cache", "auth", "payments"];
pub const NAMES: [&str; 8] = ["GET /", "POST /cart", "query", "SELECT", "cache.get", "auth.check", "charge", "render"];
pub const STR_VALUES: [&str; 6] = ["a", "b", "prod", "staging", "GET", "with space"];
pub const EVENT_NAMES: [&str; 3] = ["exception", "log", "retry"];

/// The type of each attribute key in a dataset. In "mixed" datasets some keys carry
/// values of more than one type.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum T {
    Str,
    Int,
    Float,
    Bool,
    StrArr,
    IntArr,
}

pub fn span_keys(mixed: bool) -> Vec<(&'static str, T)> {
    let mut v = vec![
        ("http.method", T::Str),
        ("http.route", T::Str),
        ("http.status_code", T::Int),
        ("n", T::Int),
        ("retries", T::Int),
        ("ratio", T::Float),
        ("f", T::Float),
        ("cached", T::Bool),
        ("tags", T::StrArr),
        ("codes", T::IntArr),
    ];
    if mixed {
        v.push(("mix", T::Int));
    }
    v
}

pub const RES_KEYS: [(&str, T); 3] = [("env", T::Str), ("region", T::Str), ("rint", T::Int)];

pub struct Opts {
    pub traces: usize,
    pub max_spans: usize,
    /// Allow several root spans and dangling parents.
    pub odd_shapes: bool,
    /// Keys whose values change type between spans.
    pub mixed: bool,
    /// Span ids may begin with a zero nibble.
    pub zero_ids: bool,
}

fn id8(r: &mut Rng, zero_ok: bool) -> [u8; 8] {
    loop {
        let v = r.next().to_be_bytes();
        if v.iter().all(|b| *b == 0) {
            continue;
        }
        if !zero_ok && v[0] < 0x10 {
            continue;
        }
        return v;
    }
}

fn id16(r: &mut Rng) -> [u8; 16] {
    let mut out = [0u8; 16];
    loop {
        out[..8].copy_from_slice(&r.next().to_be_bytes());
        out[8..].copy_from_slice(&r.next().to_be_bytes());
        if out[0] >= 0x10 {
            return out;
        }
    }
}

fn float_value(r: &mut Rng) -> f64 {
    match r.below(40) {
        0 => return f64::NAN,
        1 => return f64::INFINITY,
        2 => return f64::NEG_INFINITY,
        _ => {}
    }
    match r.below(12) {
        0 => 0.0,
        1 => -0.0,
        2 => 0.5,
        3 => 1.5,
        4 => -2.25,
        5 => 1e300,
        6 => f64::MIN_POSITIVE,
        7 => (r.below(1000) as f64) / 8.0,
        8 => 100.0,
        9 => 3.0,
        _ => (r.below(10_000) as f64) / 100.0,
    }
}

fn int_value(r: &mut Rng) -> i64 {
    match r.below(12) {
        0 => 0,
        1 => -1,
        2 => i64::MAX,
        3 => i64::MIN,
        4 => 200,
        5 => 404,
        6 => 500,
        _ => r.below(10) as i64,
    }
}

fn value(r: &mut Rng, t: T) -> AttrValue {
    match t {
        T::Str => AttrValue::Str(r.pick(&STR_VALUES).to_string()),
        T::Int => AttrValue::Int(int_value(r)),
        T::Float => AttrValue::Float(float_value(r)),
        T::Bool => AttrValue::Bool(r.chance(0.5)),
        T::StrArr => AttrValue::StrArray((0..r.below(4)).map(|_| r.pick(&STR_VALUES).to_string()).collect()),
        T::IntArr => AttrValue::IntArray((0..r.below(4)).map(|_| int_value(r)).collect()),
    }
}

fn duration(r: &mut Rng) -> u64 {
    match r.below(10) {
        0 => 0,
        1 => 1,
        2 => 2,
        3 => 1 << (10 + r.below(20)),
        4 => 1_000_000 * (1 + r.below(10)),
        _ => r.below(3_000_000_000),
    }
}

/// A resource: its attributes. Index 0 has no `service.name`.
pub fn resources(r: &mut Rng) -> Vec<Vec<(String, AttrValue)>> {
    let mut out = vec![vec![("env".to_string(), AttrValue::Str("prod".into()))]];
    for s in SERVICES {
        let mut a = vec![("service.name".to_string(), AttrValue::Str(s.to_string()))];
        for (k, t) in RES_KEYS {
            if r.chance(0.6) {
                a.push((k.to_string(), value(r, t)));
            }
        }
        out.push(a);
    }
    out
}

pub const SCOPES: [(&str, &str); 3] = [("lib.http", "1.2.0"), ("lib.db", "0.9"), ("", "")];

pub fn dataset(seed: u64, o: &Opts) -> Vec<Trace> {
    let mut r = Rng::new(seed);
    let res = resources(&mut r);
    let keys = span_keys(o.mixed);
    let mut traces = Vec::with_capacity(o.traces);
    let mut all_ids: Vec<([u8; 16], [u8; 8])> = Vec::new();
    for _ in 0..o.traces {
        let tid = id16(&mut r);
        let n = 1 + r.below(o.max_spans as u64) as usize;
        let shape = r.below(4); // 0 chain, 1 wide, 2 random tree, 3 mixed
        let t0 = BASE + r.below(WINDOW_S) * 1_000_000_000 + r.below(1_000_000_000);
        let mut spans: Vec<Span> = Vec::with_capacity(n);
        let mut ids: Vec<[u8; 8]> = Vec::new();
        for i in 0..n {
            let mut sid = id8(&mut r, o.zero_ids);
            while ids.contains(&sid) {
                sid = id8(&mut r, o.zero_ids);
            }
            let parent = if i == 0 {
                None
            } else {
                let p = match shape {
                    0 => i - 1,
                    1 => 0,
                    2 => r.below(i as u64) as usize,
                    _ => {
                        if r.chance(0.5) {
                            i - 1
                        } else {
                            r.below(i as u64) as usize
                        }
                    }
                };
                Some(ids[p])
            };
            let parent = if o.odd_shapes && i > 0 && r.chance(0.05) {
                if r.chance(0.5) {
                    None
                } else {
                    Some(id8(&mut r, false))
                }
            } else {
                parent
            };
            ids.push(sid);
            let resource = res[if r.chance(0.04) { 0 } else { 1 + r.below(SERVICES.len() as u64) as usize }].clone();
            let mut attrs = Vec::new();
            for (k, t) in &keys {
                if r.chance(0.45) {
                    let t = if *k == "mix" && r.chance(0.5) { T::Float } else { *t };
                    attrs.push((k.to_string(), value(&mut r, t)));
                }
            }
            let start = t0 + r.below(2_000_000_000);
            let dur = duration(&mut r);
            let mut events = Vec::new();
            for _ in 0..r.below(3) {
                let mut ea = Vec::new();
                if r.chance(0.5) {
                    ea.push(("exception.message".to_string(), AttrValue::Str(r.pick(&STR_VALUES).to_string())));
                }
                if r.chance(0.5) {
                    ea.push(("ev".to_string(), AttrValue::Int(r.below(4) as i64)));
                }
                events.push(Event {
                    time_unix_nano: start + r.below(dur.max(1)),
                    name: r.pick(&EVENT_NAMES).to_string(),
                    attrs: ea,
                });
            }
            let mut links = Vec::new();
            if r.chance(0.1) && !all_ids.is_empty() {
                let (lt, ls) = *r.pick(&all_ids);
                links.push(Link {
                    trace_id: lt,
                    span_id: ls,
                    trace_state: String::new(),
                    attrs: vec![("lk".to_string(), AttrValue::Str(r.pick(&STR_VALUES).to_string()))],
                });
            }
            let (sn, sv) = *r.pick(&SCOPES);
            let status = Status::from_otlp(r.below(3) as i32);
            spans.push(Span {
                span_id: sid,
                parent_span_id: parent,
                name: r.pick(&NAMES).to_string(),
                kind: Kind::from_otlp(r.below(6) as i32),
                status,
                status_message: if status == Status::Error && r.chance(0.5) { "boom".into() } else { String::new() },
                start_unix_nano: start,
                end_unix_nano: start + dur,
                resource,
                attrs,
                scope_name: sn.to_string(),
                scope_version: sv.to_string(),
                scope_attrs: if sn.is_empty() { Vec::new() } else { vec![("lang".to_string(), AttrValue::Str("rust".into()))] },
                events,
                links,
            });
        }
        for s in &spans {
            all_ids.push((tid, s.span_id));
        }
        traces.push(Trace::new(tid, spans));
    }
    traces
}

// ------------------------------------------------------------------ queries

pub struct QGen<'a> {
    pub r: Rng,
    pub data: &'a [Trace],
    pub mixed: bool,
    /// Generate features where Tempo is known to deviate (negation alone, `^`, arrays with
    /// `!=`); off for the property tests' query pool, on for targeted differential runs.
    pub quirks: bool,
}

impl<'a> QGen<'a> {
    fn some_span(&mut self) -> &'a Span {
        let t = &self.data[self.r.below(self.data.len() as u64) as usize];
        &t.spans[self.r.below(t.spans.len() as u64) as usize]
    }

    fn str_lit(&mut self) -> String {
        format!("{:?}", self.r.pick(&STR_VALUES))
    }

    fn int_lit(&mut self) -> String {
        match self.r.below(6) {
            0 => "200".into(),
            1 => "0".into(),
            2 => "-1".into(),
            3 => "500".into(),
            _ => self.r.below(10).to_string(),
        }
    }

    fn float_lit(&mut self) -> String {
        self.r.pick(&["0.5", "1.5", "0.0", "3.0", "100.0", "-2.25", "50.5"]).to_string()
    }

    fn attr_ref(&mut self, key: &str, resource: bool) -> String {
        let k = if key.contains(' ') || key.contains('-') { format!("{key:?}") } else { key.to_string() };
        if resource {
            match self.r.below(2) {
                0 => format!("resource.{k}"),
                _ => format!(".{k}"),
            }
        } else {
            match self.r.below(3) {
                0 => format!(".{k}"),
                _ => format!("span.{k}"),
            }
        }
    }

    fn cmp_op(&mut self, ordered: bool) -> &'static str {
        if ordered {
            *self.r.pick(&["=", "!=", ">", ">=", "<", "<="])
        } else {
            *self.r.pick(&["=", "!="])
        }
    }

    pub fn condition(&mut self) -> String {
        let keys = span_keys(self.mixed);
        match self.r.below(24) {
            0..=6 => {
                let (k, t) = *self.r.pick(&keys);
                if !self.quirks && matches!(t, T::StrArr | T::IntArr) && self.r.chance(0.7) {
                    return self.condition();
                }
                let a = self.attr_ref(k, false);
                match t {
                    T::Str | T::StrArr => match self.r.below(5) {
                        0 => format!("{a} =~ \"{}.*\"", &self.r.pick(&STR_VALUES)[..1]),
                        1 if self.quirks || t == T::Str => format!("{a} !~ \"a|b\""),
                        2 => format!("{a} != nil"),
                        _ => {
                            let op = if self.quirks || t == T::Str { self.cmp_op(true) } else { "=" };
                            let l = self.str_lit();
                            format!("{a} {op} {l}")
                        }
                    },
                    T::Int | T::IntArr => {
                        let op = if self.quirks || t == T::Int { self.cmp_op(true) } else { ">" };
                        let l = if self.r.chance(0.15) { self.float_lit() } else { self.int_lit() };
                        format!("{a} {op} {l}")
                    }
                    T::Float => {
                        let op = self.cmp_op(true);
                        let l = if self.r.chance(0.15) { self.int_lit() } else { self.float_lit() };
                        format!("{a} {op} {l}")
                    }
                    T::Bool => match self.r.below(3) {
                        0 => a,
                        1 => format!("{a} = true"),
                        _ => format!("{a} != false"),
                    },
                }
            }
            7 => {
                let (k, t) = *self.r.pick(&RES_KEYS);
                let a = self.attr_ref(k, true);
                match t {
                    T::Str => {
                        let l = self.str_lit();
                        format!("{a} = {l}")
                    }
                    _ => {
                        let op = self.cmp_op(true);
                        let l = self.int_lit();
                        format!("{a} {op} {l}")
                    }
                }
            }
            8 => {
                let s = *self.r.pick(&SERVICES);
                let op = *self.r.pick(&["=", "!=", "=~"]);
                if op == "=~" {
                    format!("resource.service.name =~ \"{}.*|db\"", &s[..2])
                } else {
                    format!("resource.service.name {op} {s:?}")
                }
            }
            9 => {
                let n = *self.r.pick(&NAMES);
                let k = *self.r.pick(&["name", "span:name"]);
                let op = self.cmp_op(false);
                format!("{k} {op} {n:?}")
            }
            10 => format!("{} = {}", self.r.pick(&["status", "span:status"]), self.r.pick(&["ok", "error", "unset"])),
            11 => format!("{} {} {}", self.r.pick(&["kind", "span:kind"]), self.cmp_op(false), self.r.pick(&["server", "client", "internal", "producer", "consumer", "unspecified"])),
            12 => format!("{} {} {}", self.r.pick(&["duration", "span:duration"]), self.cmp_op(true), self.r.pick(&["100ms", "1s", "0", "1ns", "500ms", "2.5s", "1024ns"])),
            13 => format!("trace:duration {} {}", self.cmp_op(true), self.r.pick(&["1s", "2s", "100ms"])),
            14 => {
                let t = &self.data[self.r.below(self.data.len() as u64) as usize];
                match self.r.below(4) {
                    0 => format!("trace:rootName = {:?}", t.summary.root.as_ref().map(|x| x.1.clone()).unwrap_or_default()),
                    1 => format!("trace:rootService = {:?}", self.r.pick(&SERVICES)),
                    2 => format!("rootServiceName = {:?}", self.r.pick(&SERVICES)),
                    _ => format!("trace:id = \"{}\"", hex(&t.trace_id)),
                }
            }
            15 => {
                let s = self.some_span();
                if self.r.chance(0.5) {
                    format!("span:id = \"{}\"", hex(&s.span_id))
                } else {
                    format!("span:parentID = \"{}\"", hex(&s.parent_span_id.unwrap_or(s.span_id)))
                }
            }
            16 => format!("span:childCount {} {}", self.cmp_op(true), self.r.below(4)),
            17 => match self.r.below(4) {
                0 => format!("event:name = {:?}", self.r.pick(&EVENT_NAMES)),
                1 => format!("event.ev {} {}", self.cmp_op(true), self.r.below(4)),
                2 => format!("event:name = \"exception\" && event.exception.message = {:?}", self.r.pick(&STR_VALUES)),
                _ => format!("event:timeSinceStart > {}", self.r.pick(&["0", "1ms", "100ms"])),
            },
            18 => match self.r.below(3) {
                0 => format!("link.lk = {:?}", self.r.pick(&STR_VALUES)),
                1 => "link:traceID != nil".to_string(),
                _ => {
                    let s = self.some_span();
                    format!("link:spanID = \"{}\"", hex(&s.span_id))
                }
            },
            19 => match self.r.below(3) {
                0 => format!("instrumentation:name = {:?}", self.r.pick(&SCOPES).0),
                1 => format!("instrumentation:version = {:?}", self.r.pick(&SCOPES).1),
                _ => "instrumentation.lang = \"rust\"".to_string(),
            },
            20 => {
                let k = *self.r.pick(&["n", "retries", "http.status_code", "f"]);
                let a = self.attr_ref(k, false);
                let e = match self.r.below(5) {
                    0 => format!("{a} + 1 > 5"),
                    1 => format!("{a} * 2 = 10"),
                    2 => format!("{a} - {a} = 0"),
                    3 => format!("{a} / 2 >= 1"),
                    _ => format!("{a} % 3 = 1"),
                };
                if self.quirks && self.r.chance(0.2) {
                    format!("{a} ^ 2 > 10")
                } else {
                    e
                }
            }
            21 => format!("statusMessage {} \"boom\"", self.cmp_op(false)),
            22 => {
                let k = span_keys(self.mixed)[self.r.below(4) as usize].0;
                format!("{} = nil", self.attr_ref(k, false))
            }
            _ => format!("duration / 2 > {}", self.r.pick(&["1ms", "100ms"])),
        }
    }

    pub fn filter_expr(&mut self, depth: u32) -> String {
        if depth == 0 || self.r.chance(0.5) {
            return self.condition();
        }
        match self.r.below(5) {
            0 | 1 => format!("{} && {}", self.filter_expr(depth - 1), self.filter_expr(depth - 1)),
            2 => format!("{} || {}", self.filter_expr(depth - 1), self.filter_expr(depth - 1)),
            3 => format!("({} || {}) && {}", self.condition(), self.condition(), self.condition()),
            _ => {
                if self.quirks {
                    format!("!({})", self.condition())
                } else {
                    format!("!({}) && {}", self.condition(), self.condition())
                }
            }
        }
    }

    pub fn filter(&mut self) -> String {
        if self.r.chance(0.08) {
            return "{ }".into();
        }
        format!("{{ {} }}", self.filter_expr(2))
    }

    pub fn spanset_expr(&mut self, depth: u32) -> String {
        if depth == 0 || self.r.chance(0.45) {
            return self.filter();
        }
        let op = *self.r.pick(&[
            "&&", "||", ">>", ">", "<<", "<", "~", "&>>", "&>", "&<<", "&<", "&~", "!>>", "!>", "!<<", "!<", "!~",
        ]);
        let l = self.spanset_expr(depth - 1);
        let r = if self.r.chance(0.2) { format!("({} | count() > 1)", self.filter()) } else { self.filter() };
        format!("{l} {op} {r}")
    }

    fn numeric_field(&mut self) -> String {
        match self.r.below(5) {
            0 => "duration".into(),
            1 => "span:duration".into(),
            2 => self.attr_ref("n", false),
            3 => self.attr_ref("f", false),
            _ => self.attr_ref("http.status_code", false),
        }
    }

    fn group_field(&mut self) -> String {
        match self.r.below(8) {
            0 => "resource.service.name".into(),
            1 => "name".into(),
            2 => "status".into(),
            3 => self.attr_ref("http.method", false),
            4 => self.attr_ref("n", false),
            5 => "span:kind".into(),
            6 => self.attr_ref("cached", false),
            _ => self.attr_ref("env", true),
        }
    }

    pub fn stage(&mut self) -> String {
        match self.r.below(9) {
            0 | 1 => self.filter(),
            2 => format!("count() {} {}", self.cmp_op(true), self.r.below(4)),
            3 => {
                let agg = *self.r.pick(&["avg", "min", "max", "sum"]);
                let f = self.numeric_field();
                let thr = if f.contains("duration") { self.r.pick(&["100ms", "1s", "0"]).to_string() } else { self.r.below(6).to_string() };
                format!("{agg}({f}) {} {thr}", self.cmp_op(true))
            }
            4 => format!("by({})", self.group_field()),
            5 => format!("by({}) | count() > {}", self.group_field(), self.r.below(3)),
            6 => "coalesce()".into(),
            _ => {
                let a = self.group_field();
                let b = self.numeric_field();
                format!("select({a}, {b})")
            }
        }
    }

    pub fn search_query(&mut self) -> String {
        let mut q = self.spanset_expr(2);
        for _ in 0..self.r.below(3) {
            q = format!("{q} | {}", self.stage());
        }
        q
    }

    pub fn metrics_fn(&mut self) -> String {
        let f = match self.r.below(9) {
            0 | 1 => "rate()".to_string(),
            2 => "count_over_time()".to_string(),
            3 => format!("sum_over_time({})", self.numeric_field()),
            4 => format!("min_over_time({})", self.numeric_field()),
            5 => format!("max_over_time({})", self.numeric_field()),
            6 => format!("avg_over_time({})", self.numeric_field()),
            7 => format!("quantile_over_time({}, {})", self.numeric_field(), self.r.pick(&["0.5", "0.9, 0.99", "0, 1", "0.25, 0.5, 0.75"])),
            _ => format!("histogram_over_time({})", self.r.pick(&["duration", ".n", "span.http.status_code"])),
        };
        if self.r.chance(0.6) {
            let n = 1 + self.r.below(2);
            let mut b: Vec<String> = Vec::new();
            for _ in 0..n {
                let g = self.group_field();
                if !b.contains(&g) {
                    b.push(g);
                }
            }
            format!("{f} by ({})", b.join(", "))
        } else {
            f
        }
    }

    pub fn metrics_query(&mut self) -> String {
        let base = |g: &mut QGen| {
            let mut q = g.spanset_expr(1);
            if g.r.chance(0.2) {
                q = format!("{q} | {}", g.stage());
            }
            format!("{q} | {}", g.metrics_fn())
        };
        let mut q = match self.r.below(10) {
            0 => format!("({}) {} ({})", base(self), self.r.pick(&["+", "-", "*", "/"]), base(self)),
            1 => format!("({}) {} {}", base(self), self.r.pick(&["*", "/", "+", "-"]), self.r.pick(&["2", "0.5", "100", "-1"])),
            _ => base(self),
        };
        match self.r.below(6) {
            0 => q = format!("{q} | topk({})", 1 + self.r.below(3)),
            1 => q = format!("{q} | bottomk({})", 1 + self.r.below(3)),
            2 => q = format!("{q} {} {}", self.cmp_op(true), self.r.pick(&["0", "1", "0.5", "2"])),
            _ => {}
        }
        q
    }
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
