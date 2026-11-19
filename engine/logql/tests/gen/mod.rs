//! Generated log data and LogQL queries for the differential run and property tests.
//! Deterministic: everything comes from a seeded generator.
#![allow(dead_code)]

use serde_json::{json, Value};

/// SplitMix64.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    pub fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len() as u64) as usize]
    }
    pub fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

pub const T0: i64 = 1_700_000_000_000_000_000;
pub const S: i64 = 1_000_000_000;

const APPS: &[&str] = &["api", "web", "db", "worker"];
const LEVELS: &[&str] = &["debug", "info", "warn", "error"];
const MSGS: &[&str] = &[
    "request served",
    "connection timeout",
    "failed to connect",
    "cache miss",
    "héllo wörld ✓",
    "user logged in",
    "retrying request",
    "disk 90% full",
    "panic: nil pointer",
    "GET /api/v1/items",
];
const DURS: &[&str] = &["12ms", "250ms", "1.5s", "3s", "100us", "2m", "abc", "75ms", "1h"];
const SIZES: &[&str] = &["12B", "1KB", "1.5KiB", "20MB", "512", "3KiB", "12XB", "800kB"];
const USERS: &[&str] = &["u0", "u1", "u2", "u3", "u4", "admin", "ü-ser"];
const MALFORMED: &[&str] = &[
    r#"{"level":"warn", broken}"#,
    r#"{"level":tru}"#,
    r#"{"level" "warn"}"#,
    r#"{"level":"warn","msg":"cut"#,
    r#"[1,2,3]"#,
    r#"{"_entry":"inner level=error msg=packed","pod":"p1","n":5}"#,
    r#"not json at all"#,
    r#"{"a":{"b":"#,
];

fn ip(rng: &mut Rng) -> String {
    match rng.below(4) {
        0 => format!("10.0.{}.{}", rng.below(4), rng.below(255)),
        1 => format!("192.168.1.{}", rng.below(8)),
        2 => format!("172.16.{}.{}", rng.below(3), rng.below(255)),
        _ => "2001:db8::".to_string() + &rng.below(99).to_string(),
    }
}

fn line(rng: &mut Rng) -> String {
    let lvl = *rng.pick(LEVELS);
    let msg = *rng.pick(MSGS);
    let status = *rng.pick(&[200, 200, 201, 204, 301, 400, 404, 500, 503]);
    match rng.below(8) {
        0 | 1 => format!(
            "level={lvl} msg=\"{msg}\" status={status} latency={} bytes={} user={} ip={}{}",
            rng.pick(DURS),
            rng.pick(SIZES),
            rng.pick(USERS),
            ip(rng),
            if rng.chance(20) { " standalone empty=" } else { "" }
        ),
        2 | 3 => {
            let mut v = json!({
                "level": lvl, "msg": msg, "status": status,
                "latency_ms": (rng.below(5000) as f64) / 10.0,
                "user": {"id": rng.below(10), "name": rng.pick(USERS), "geo": {"country": rng.pick(&["NZ", "DE", "BR"])}},
                "tags": ["a", "b"], "ok": rng.chance(50), "size": rng.pick(SIZES), "dur": rng.pick(DURS),
            });
            if rng.chance(30) {
                v["app"] = json!("shadow");
            }
            if rng.chance(20) {
                v["nothing"] = Value::Null;
            }
            v.to_string()
        }
        4 => format!("{msg} code={status} from {} ✓ {}", ip(rng), lvl.to_uppercase()),
        5 => format!(
            "\u{1b}[{}m{}\u{1b}[0m {msg} status={status} \u{1b}[1;34mlatency={}\u{1b}[m",
            rng.pick(&["31", "32", "33", "1;31"]),
            lvl.to_uppercase(),
            rng.pick(DURS)
        ),
        6 => MALFORMED[rng.below(MALFORMED.len() as u64) as usize].to_string(),
        _ => format!(
            "{} - - [10/Jun/2021:09:14:29 +0000] \"{} /api/v{}/items HTTP/1.1\" {status} {} \"-\" \"{}\"",
            ip(rng),
            rng.pick(&["GET", "POST", "PUT"]),
            rng.below(3),
            rng.below(5000),
            rng.pick(&["curl/7.68.0", "Go-http-client/2.0", "Mozilla/5.0"])
        ),
    }
}

/// A data set: streams with random labels (one high-cardinality label) and lines of mixed
/// shapes, timestamps unique within a stream.
pub fn dataset(rng: &mut Rng) -> Value {
    let n = 3 + rng.below(8);
    let mut streams = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for i in 0..n {
        let app = *rng.pick(APPS);
        let env = *rng.pick(&["prod", "dev"]);
        let mut labels = json!({"app": app, "env": env, "pod": format!("{app}-{:x}", rng.next() % 4096 + i)});
        if rng.chance(30) {
            labels["level"] = json!(*rng.pick(LEVELS));
        }
        if rng.chance(30) {
            labels["namespace"] = json!(*rng.pick(&["ns1", "ns2"]));
        }
        let key = labels.to_string();
        if !seen.insert(key) {
            continue;
        }
        let count = 10 + rng.below(60);
        let mut ts = T0 + rng.below(30) as i64 * S + rng.below(S as u64) as i64;
        let mut entries = Vec::new();
        for _ in 0..count {
            ts += 1 + rng.below(20 * S as u64) as i64;
            entries.push(json!({"ts": ts.to_string(), "line": line(rng)}));
        }
        streams.push(json!({"labels": labels, "entries": entries}));
    }
    Value::Array(streams)
}

fn selector(rng: &mut Rng) -> String {
    let a = *rng.pick(APPS);
    let b = *rng.pick(APPS);
    match rng.below(7) {
        0 => format!("{{app=\"{a}\"}}"),
        1 => format!("{{app=~\"{a}|{b}\"}}"),
        2 => format!("{{app!=\"{a}\", env=\"prod\"}}"),
        3 => "{env=~\"p.*\", app!~\"w.*\"}".into(),
        4 => format!("{{pod=~\"{a}-.*\"}}"),
        5 => "{env=~\".+\"}".into(),
        _ => format!("{{app=\"{a}\", level=~\"(warn|error)\"}}"),
    }
}

fn line_filter(rng: &mut Rng) -> String {
    rng.pick(&[
        r#"|= "error""#,
        r#"!= "debug""#,
        r#"|~ "(?i)err""#,
        r#"!~ "time.*out""#,
        r#"|= "status" or "code""#,
        r#"!= "cache" or "disk""#,
        r#"|> "<_>status=<_>""#,
        r#"!> "<_>ERROR<_>""#,
        r#"|= ip("10.0.0.0/8")"#,
        r#"!= ip("192.168.1.0-192.168.1.3")"#,
        r#"|~ `\d{3}`"#,
        r#"|= "ü""#,
        r#"|> "<_> - - <_>""#,
    ])
    .to_string()
}

fn parser(rng: &mut Rng) -> String {
    rng.pick(&[
        "| json",
        "| logfmt",
        "| logfmt --strict",
        "| logfmt --keep-empty",
        r#"| json level, s="status", u="user.name""#,
        r#"| json t="tags[0]", c="user.geo.country", m="msg""#,
        r#"| logfmt lvl="level", status"#,
        r#"| regexp "(?P<key>\\w+)=(?P<val>\\S+)""#,
        r#"| pattern "<ip> - - <_> \"<method> <path> <_>\" <status> <size> <_>""#,
        "| unpack",
        "| json | line_format \"{{.msg}}\" | logfmt",
    ])
    .to_string()
}

fn label_filter(rng: &mut Rng) -> String {
    rng.pick(&[
        r#"| level="error""#,
        "| status >= 400",
        "| latency > 100ms",
        "| bytes > 1KB",
        r#"| __error__="""#,
        r#"| status >= 400 or level="warn""#,
        r#"| ip = ip("10.0.0.0/8")"#,
        r#"| user =~ "u[0-3]""#,
        "| status != 200, status < 500",
        r#"| (level="info" or level="debug") and status == 200"#,
        "| latency_ms > 100.5",
        r#"| __error__!="JSONParserErr""#,
    ])
    .to_string()
}

fn formatter(rng: &mut Rng) -> String {
    rng.pick(&[
        r#"| line_format "{{.level}}: {{.msg | upper}}""#,
        r#"| label_format lvl=level"#,
        r#"| label_format x="{{.status}}-{{.app}}""#,
        "| decolorize",
        "| drop pod",
        "| keep app, level, status",
        r#"| line_format "{{ if eq .level \"error\" }}E{{ else }}{{ .level | default \"none\" | title }}{{ end }} {{ __line__ | trunc 12 }}""#,
        r#"| line_format "{{ printf \"%-6s|%5.1f\" .level (addf .latency_ms 0) }}""#,
        r#"| label_format d="{{ div .status 100 }}xx", t="{{ __timestamp__ | unixEpoch }}""#,
        r#"| drop __error__, __error_details__"#,
        r#"| line_format "{{ regexReplaceAll \"[0-9]+\" __line__ \"N\" }}""#,
    ])
    .to_string()
}

/// A log pipeline of up to four stages.
pub fn pipeline(rng: &mut Rng) -> String {
    let mut parts = Vec::new();
    if rng.chance(50) {
        parts.push(line_filter(rng));
    }
    if rng.chance(70) {
        parts.push(parser(rng));
    }
    if rng.chance(50) {
        parts.push(label_filter(rng));
    }
    if rng.chance(40) {
        parts.push(formatter(rng));
    }
    if rng.chance(15) {
        parts.push(line_filter(rng));
    }
    parts.join(" ")
}

fn range(rng: &mut Rng) -> &'static str {
    rng.pick(&["30s", "1m", "2m", "5m", "90s"])
}

fn offset(rng: &mut Rng) -> String {
    if rng.chance(15) {
        format!(" offset {}", rng.pick(&["30s", "1m", "5m"]))
    } else {
        String::new()
    }
}

fn log_range_agg(rng: &mut Rng) -> String {
    let op = *rng.pick(&["count_over_time", "rate", "bytes_over_time", "bytes_rate"]);
    let mut p = pipeline(rng);
    // Parsers set `__error__` on lines they cannot read, which fails a metric query; most
    // generated metric queries filter those out so that their values get compared.
    if !p.contains("__error__") && rng.chance(70) {
        p.push_str(r#" | __error__="""#);
    }
    format!("{op}({} {p} [{}]{})", selector(rng), range(rng), offset(rng))
}

fn unwrap_agg(rng: &mut Rng) -> String {
    let (prefix, unwrap) = rng
        .pick(&[
            ("| logfmt", "| unwrap duration(latency)"),
            ("| logfmt", "| unwrap bytes(bytes)"),
            ("| logfmt", "| unwrap status"),
            ("| json", "| unwrap latency_ms"),
            ("| json", "| unwrap status"),
            ("| json", "| unwrap duration_seconds(dur)"),
        ])
        .to_owned();
    let filt = if rng.chance(85) { r#" | __error__="""# } else { "" };
    let op = *rng.pick(&[
        "sum_over_time",
        "avg_over_time",
        "min_over_time",
        "max_over_time",
        "stddev_over_time",
        "stdvar_over_time",
        "first_over_time",
        "last_over_time",
        "rate",
        "rate_counter",
        "quantile_over_time",
    ]);
    let param = if op == "quantile_over_time" { format!("{}, ", rng.pick(&["0.5", "0.99", "0", "1"])) } else { String::new() };
    let grouping = if !matches!(op, "sum_over_time" | "rate" | "rate_counter") && rng.chance(40) {
        format!(" {} ({})", rng.pick(&["by", "without"]), rng.pick(&["app", "app, env", "pod", "level"]))
    } else {
        String::new()
    };
    let pre = if rng.chance(30) { format!("{} ", label_filter(rng)) } else { String::new() };
    format!("{op}({param}{} {prefix} {pre}{unwrap}{filt} [{}]{}){grouping}", selector(rng), range(rng), offset(rng))
}

fn metric(rng: &mut Rng, depth: u32) -> String {
    let leaf = |rng: &mut Rng| if rng.chance(60) { log_range_agg(rng) } else { unwrap_agg(rng) };
    if depth > 1 {
        return leaf(rng);
    }
    match rng.below(10) {
        0 | 1 => leaf(rng),
        2 | 3 => {
            let op = *rng.pick(&["sum", "avg", "min", "max", "count", "stddev", "stdvar"]);
            let g = rng.pick(&["", " by (app)", " without (pod)", " by (app, env)", " by (level)"]).to_string();
            if rng.chance(50) {
                format!("{op}{g} ({})", metric(rng, depth + 1))
            } else {
                format!("{op}({}){g}", metric(rng, depth + 1))
            }
        }
        4 => format!("{}({}, {})", rng.pick(&["topk", "bottomk"]), 1 + rng.below(3), metric(rng, depth + 1)),
        5 => format!("{}({})", rng.pick(&["sort", "sort_desc"]), metric(rng, depth + 1)),
        6 => {
            let op = *rng.pick(&["+", "-", "*", "/", ">", "<", ">=", "==", "!="]);
            let b = if op.len() == 2 || op == ">" || op == "<" { rng.pick(&["", " bool"]).to_string() } else { String::new() };
            format!("{} {op}{b} {}", metric(rng, depth + 1), rng.pick(&["2", "0.5", "10", "-1"]))
        }
        7 => {
            let op = *rng.pick(&["/", "+", "and", "or", "unless", "*"]);
            let m = rng.pick(&["", " on (app)", " ignoring (pod)"]).to_string();
            let g = if !matches!(op, "and" | "or" | "unless") && m.contains("on") { " group_left" } else { "" };
            let l = format!("sum by (app, pod) ({})", log_range_agg(rng));
            let r = format!("sum by (app) ({})", log_range_agg(rng));
            if op == "and" || op == "or" || op == "unless" {
                format!("{l} {op} {r}")
            } else {
                format!("{l} {op}{m}{g} {r}")
            }
        }
        8 => format!(r#"label_replace({}, "x", "$1-$2", "app", "(\\w)(.*)")"#, metric(rng, depth + 1)),
        _ => format!("{} or vector({})", metric(rng, depth + 1), rng.below(3)),
    }
}

/// `(feature, query, instant)` triples.
pub fn queries(rng: &mut Rng) -> Vec<(String, String, bool)> {
    let mut out = Vec::new();
    for _ in 0..12 {
        out.push(("log".to_string(), format!("{} {}", selector(rng), pipeline(rng)), false));
    }
    for _ in 0..10 {
        let m = metric(rng, 0);
        out.push(("metric".to_string(), m.clone(), false));
        if rng.chance(40) {
            out.push(("metric-instant".to_string(), m, true));
        }
    }
    let scalars = ["1 + 2 * 3", "2 ^ 3 ^ 2", "10 % 3", "1 > 2", "3 >= bool 2", "-1.5 * 2", "vector(4) * 2"];
    if rng.chance(30) {
        out.push(("literal".to_string(), rng.pick(&scalars).to_string(), rng.chance(50)));
    }
    out
}

/// Query window `(start, end, step)`; instant queries use `end`.
pub fn window(rng: &mut Rng, instant: bool) -> (i64, i64, i64) {
    let start = T0 + rng.below(300) as i64 * S + rng.below(1000) as i64 * 1_000_000;
    let end = start + (30 + rng.below(900)) as i64 * S;
    let step = *rng.pick(&[5 * S, 10 * S, 15 * S, 30 * S, 60 * S, 7_500_000_000]);
    if instant {
        (end, end, step)
    } else {
        (start, end, step)
    }
}
