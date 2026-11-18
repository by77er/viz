//! Runner for the Prometheus `promqltest` script format
//! (`load` / `clear` / `eval instant at` / `eval range from..to step`,
//! `expect fail|ordered|string|range vector`, series descriptions with `_`,
//! `stale` and `a+bxN` expansions).
//!
//! Like the upstream runner, every instant case is additionally re-run with
//! all selectors pinned by `@` at five other evaluation times, and as the
//! middle step of a range query.
//!
//! Differences from upstream: `expect warn|info|no_warn|no_info` lines are
//! parsed and ignored (this engine does not produce annotations), and cases
//! that touch native histograms or `Unsupported` features are reported as
//! skipped instead of failing.

use std::cell::Cell;
use std::time::{Duration, UNIX_EPOCH};

use promql_parser::parser::{AtModifier, Expr};

use crate::functions::almost_equal;
use crate::types::*;
use crate::{instant_expr, range_expr, EvalOptions, Matrix, Value};

const EPSILON: f64 = 0.000001;

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Passed,
    Failed(String),
    /// Not counted as pass or fail; the string says why.
    Skipped(SkipReason, String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The case loads, selects or expects native histograms.
    NativeHistogram,
    /// The engine returned `Error::Unsupported`.
    Unsupported,
    /// `promql-parser` rejects a query the Go parser accepts.
    Parser,
}

#[derive(Debug, Clone)]
pub struct CaseResult {
    /// 1-based line of the `eval` command.
    pub line: usize,
    pub expr: String,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, Default)]
pub struct Report {
    pub cases: Vec<CaseResult>,
}

impl Report {
    pub fn passed(&self) -> usize {
        self.cases.iter().filter(|c| c.outcome == Outcome::Passed).count()
    }
    pub fn failed(&self) -> usize {
        self.cases.iter().filter(|c| matches!(c.outcome, Outcome::Failed(_))).count()
    }
    pub fn skipped(&self) -> usize {
        self.cases.iter().filter(|c| matches!(c.outcome, Outcome::Skipped(..))).count()
    }
    pub fn skipped_for(&self, r: SkipReason) -> usize {
        self.cases.iter().filter(|c| matches!(&c.outcome, Outcome::Skipped(x, _) if *x == r)).count()
    }
}

/// Engine options the upstream test engine uses: delayed name removal on,
/// 5m lookback, 1m default subquery resolution.
pub fn upstream_options() -> EvalOptions {
    EvalOptions { lookback_delta_ms: 300_000, delayed_name_removal: true, subquery_default_step_ms: 60_000 }
}

/// Storage for a script: float samples, plus the label sets of series that
/// hold native histograms, so cases that would read them can be skipped.
#[derive(Default)]
struct TestSource {
    mem: MemSource,
    /// (labels, timestamps of the histogram samples)
    tainted: Vec<(Vec<(String, String)>, Vec<i64>)>,
    hit: Cell<bool>,
}

impl SeriesSource for TestSource {
    fn select(&self, matchers: &[Matcher], min: i64, max: i64) -> Result<Vec<Series>, Error> {
        if !self.tainted.is_empty() {
            let compiled: Vec<CompiledMatcher> = matchers.iter().map(|m| m.compile()).collect::<Result<_, _>>()?;
            if self.tainted.iter().any(|(l, ts)| ts.iter().any(|t| *t >= min && *t <= max) && compiled.iter().all(|m| m.matches(l))) {
                self.hit.set(true);
            }
        }
        self.mem.select(matchers, min, max)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum SeqVal {
    Val(f64),
    Omitted,
    Hist,
}

/// Parse a Prometheus duration such as `5m`, `1h30m`, `0`, `500ms`.
pub fn parse_duration_ms(s: &str) -> Result<i64, String> {
    let s = s.trim();
    if s == "0" {
        return Ok(0);
    }
    if s.is_empty() {
        return Err("empty duration".into());
    }
    let b = s.as_bytes();
    let mut i = 0;
    let mut total: i64 = 0;
    while i < b.len() {
        let st = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if st == i {
            return Err(format!("not a valid duration string: {s:?}"));
        }
        let n: i64 = s[st..i].parse().map_err(|_| format!("bad duration {s:?}"))?;
        let us = i;
        while i < b.len() && b[i].is_ascii_alphabetic() {
            i += 1;
        }
        let mult = match &s[us..i] {
            "ms" => 1,
            "s" => 1000,
            "m" => 60_000,
            "h" => 3_600_000,
            "d" => 86_400_000,
            "w" => 7 * 86_400_000,
            "y" => 365 * 86_400_000,
            u => return Err(format!("unknown unit {u:?} in duration {s:?}")),
        };
        total += n * mult;
    }
    Ok(total)
}

fn parse_number(s: &str) -> Option<f64> {
    let (neg, body) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    if body.is_empty() {
        return None;
    }
    let lower = body.to_ascii_lowercase();
    let v = if lower == "inf" {
        f64::INFINITY
    } else if lower == "nan" {
        f64::NAN
    } else if let Some(h) = lower.strip_prefix("0x") {
        i64::from_str_radix(h, 16).ok()? as f64
    } else {
        if !body.as_bytes()[0].is_ascii_digit() && body.as_bytes()[0] != b'.' {
            return None;
        }
        body.replace('_', "").parse::<f64>().ok()?
    };
    Some(if neg { -v } else { v })
}

fn unquote(s: &str, quote: char) -> Result<(String, usize), String> {
    // `s` starts just after the opening quote. Returns (value, bytes consumed including closing quote).
    let mut out = String::new();
    let mut chars = s.char_indices();
    while let Some((i, c)) = chars.next() {
        if c == quote {
            return Ok((out, i + c.len_utf8()));
        }
        if c == '\\' && quote != '`' {
            let (_, e) = chars.next().ok_or("dangling escape")?;
            match e {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                '\\' => out.push('\\'),
                '"' => out.push('"'),
                '\'' => out.push('\''),
                'x' | 'u' | 'U' => {
                    let len = match e {
                        'x' => 2,
                        'u' => 4,
                        _ => 8,
                    };
                    let mut hex = String::new();
                    for _ in 0..len {
                        hex.push(chars.next().ok_or("short escape")?.1);
                    }
                    let cp = u32::from_str_radix(&hex, 16).map_err(|_| "bad escape")?;
                    out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                }
                other => {
                    out.push('\\');
                    out.push(other);
                }
            }
        } else {
            out.push(c);
        }
    }
    Err("unterminated string".into())
}

/// Parse `metric{a="b"} 1 2 _ stale 3+1x4` into labels and values.
fn parse_series_desc(line: &str) -> Result<(Vec<(String, String)>, Vec<SeqVal>), String> {
    let line = line.trim();
    let mut labels: Vec<(String, String)> = Vec::new();
    let mut pos = 0;
    let bytes = line.as_bytes();
    // Metric name.
    while pos < bytes.len() && bytes[pos] != b'{' && !bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    if pos > 0 {
        labels.push((NAME_LABEL.to_string(), line[..pos].to_string()));
    }
    if pos < bytes.len() && bytes[pos] == b'{' && !line[pos..].starts_with("{{") {
        pos += 1;
        loop {
            while pos < bytes.len() && (bytes[pos].is_ascii_whitespace() || bytes[pos] == b',') {
                pos += 1;
            }
            if pos >= bytes.len() {
                return Err(format!("unterminated label set in {line:?}"));
            }
            if bytes[pos] == b'}' {
                pos += 1;
                break;
            }
            // Label name, possibly quoted.
            let name;
            let c = bytes[pos] as char;
            if c == '"' || c == '\'' || c == '`' {
                let (v, used) = unquote(&line[pos + 1..], c)?;
                pos += 1 + used;
                name = v;
            } else {
                let st = pos;
                while pos < bytes.len() && !matches!(bytes[pos], b'=' | b',' | b'}') && !bytes[pos].is_ascii_whitespace() {
                    pos += 1;
                }
                name = line[st..pos].to_string();
            }
            while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
                pos += 1;
            }
            if pos < bytes.len() && bytes[pos] == b'=' {
                pos += 1;
                while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
                    pos += 1;
                }
                if pos >= bytes.len() {
                    return Err(format!("missing label value in {line:?}"));
                }
                let q = bytes[pos] as char;
                if q != '"' && q != '\'' && q != '`' {
                    return Err(format!("unquoted label value in {line:?}"));
                }
                let (v, used) = unquote(&line[pos + 1..], q)?;
                pos += 1 + used;
                labels.retain(|(k, _)| *k != name);
                if !v.is_empty() {
                    labels.push((name, v));
                }
            } else {
                // A bare quoted string inside braces is the metric name.
                labels.retain(|(k, _)| k != NAME_LABEL);
                labels.push((NAME_LABEL.to_string(), name));
            }
        }
    }
    labels.sort();

    // Values. Native histogram literals are replaced by a marker first.
    let mut rest = String::new();
    let mut tail = &line[pos..];
    while let Some(i) = tail.find("{{") {
        rest.push_str(&tail[..i]);
        let j = tail[i..].find("}}").ok_or("unterminated histogram")?;
        rest.push('H');
        tail = &tail[i + j + 2..];
    }
    rest.push_str(tail);

    let mut vals = Vec::new();
    for tok in rest.split_whitespace() {
        if tok.contains('H') {
            let n = match tok.rsplit_once('x') {
                Some((_, n)) => n.parse::<usize>().map_err(|_| format!("bad repeat in {tok:?}"))? + 1,
                None => 1,
            };
            vals.extend(std::iter::repeat(SeqVal::Hist).take(n));
            continue;
        }
        if tok == "_" {
            vals.push(SeqVal::Omitted);
            continue;
        }
        if let Some(n) = tok.strip_prefix("_x") {
            let n: usize = n.parse().map_err(|_| format!("bad repeat in {tok:?}"))?;
            vals.extend(std::iter::repeat(SeqVal::Omitted).take(n));
            continue;
        }
        if tok == "stale" {
            vals.push(SeqVal::Val(stale_nan()));
            continue;
        }
        // `0x59` in a series description is "0, repeated 59 more times", not hex.
        let is_repeat = tok.rsplit_once('x').is_some_and(|(l, n)| !l.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
        if !is_repeat {
            let v = parse_number(tok).ok_or_else(|| format!("bad value {tok:?} in {line:?}"))?;
            vals.push(SeqVal::Val(v));
            continue;
        }
        let (left, n) = tok.rsplit_once('x').ok_or_else(|| format!("bad value {tok:?} in {line:?}"))?;
        let n: usize = n.parse().map_err(|_| format!("bad repeat in {tok:?}"))?;
        if left == "stale" {
            vals.extend(std::iter::repeat(SeqVal::Val(stale_nan())).take(n + 1));
            continue;
        }
        if let Some(v) = parse_number(left) {
            vals.extend(std::iter::repeat(SeqVal::Val(v)).take(n + 1));
            continue;
        }
        // a+bxN or a-bxN: split at a sign that is not a leading sign or an exponent sign.
        let lb = left.as_bytes();
        let mut split = None;
        for i in 1..lb.len() {
            if (lb[i] == b'+' || lb[i] == b'-') && !matches!(lb[i - 1], b'e' | b'E') {
                split = Some(i);
                break;
            }
        }
        let i = split.ok_or_else(|| format!("bad value {tok:?} in {line:?}"))?;
        let a = parse_number(&left[..i]).ok_or_else(|| format!("bad value {tok:?}"))?;
        let b = parse_number(&left[i..]).ok_or_else(|| format!("bad value {tok:?}"))?;
        for k in 0..=n {
            vals.push(SeqVal::Val(a + k as f64 * b));
        }
    }
    Ok((labels, vals))
}

#[derive(Debug, Clone)]
enum FailExpect {
    Any,
    Msg(String),
    Regex(String),
}

struct EvalCmd {
    line: usize,
    expr: String,
    /// Instant: `start == end`, `step == 0`.
    is_range: bool,
    start: i64,
    end: i64,
    step: i64,
    eval: i64,
    fail: Option<FailExpect>,
    ordered: bool,
    expect_scalar: Option<f64>,
    expect_string: Option<String>,
    expect_range_vector: bool,
    /// (labels, values, 1-based position)
    expected: Vec<(Vec<(String, String)>, Vec<SeqVal>, usize)>,
    has_hist: bool,
}

fn parse_eval(lines: &[String], i: &mut usize) -> Result<EvalCmd, String> {
    let l = &lines[*i];
    let mut toks = l.split_whitespace();
    let head = toks.next().unwrap_or("");
    let modifier = head.strip_prefix("eval").unwrap_or("").trim_start_matches('_').to_string();
    let kind = toks.next().unwrap_or("");
    // Byte offset just after the n-th whitespace-separated token.
    let after = |count: usize| -> &str {
        let mut rest = l.as_str();
        for _ in 0..count {
            rest = rest.trim_start();
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            rest = &rest[end..];
        }
        rest.trim()
    };
    let mut cmd = EvalCmd {
        line: *i + 1,
        expr: String::new(),
        is_range: false,
        start: 0,
        end: 0,
        step: 0,
        eval: 0,
        fail: None,
        ordered: false,
        expect_scalar: None,
        expect_string: None,
        expect_range_vector: false,
        expected: vec![],
        has_hist: false,
    };
    match kind {
        "instant" => {
            if toks.next() != Some("at") {
                return Err(format!("line {}: expected 'at'", *i + 1));
            }
            let at = toks.next().ok_or("missing time")?;
            let t = parse_duration_ms(at).map_err(|e| format!("line {}: {e}", *i + 1))?;
            cmd.start = t;
            cmd.end = t;
            cmd.eval = t;
            cmd.expr = after(4).to_string();
        }
        "range" => {
            let (f, from, t, to, s, step) = (toks.next(), toks.next(), toks.next(), toks.next(), toks.next(), toks.next());
            if f != Some("from") || t != Some("to") || s != Some("step") {
                return Err(format!("line {}: invalid range eval", *i + 1));
            }
            cmd.is_range = true;
            cmd.start = parse_duration_ms(from.unwrap_or(""))?;
            cmd.end = parse_duration_ms(to.unwrap_or(""))?;
            cmd.step = parse_duration_ms(step.unwrap_or(""))?;
            cmd.expr = after(8).to_string();
        }
        _ => return Err(format!("line {}: invalid evaluation command", *i + 1)),
    }
    match modifier.as_str() {
        "fail" => cmd.fail = Some(FailExpect::Any),
        "ordered" => cmd.ordered = true,
        _ => {}
    }
    let mut j = 1;
    while *i + 1 < lines.len() {
        *i += 1;
        let d = &lines[*i];
        if d.is_empty() {
            *i -= 1;
            break;
        }
        if cmd.fail.is_some() && d.starts_with("expected_fail_message") {
            cmd.fail = Some(FailExpect::Msg(d["expected_fail_message".len()..].trim().to_string()));
            break;
        }
        if cmd.fail.is_some() && d.starts_with("expected_fail_regexp") {
            cmd.fail = Some(FailExpect::Regex(d["expected_fail_regexp".len()..].trim().to_string()));
            break;
        }
        if let Some(rest) = d.strip_prefix("expect range vector") {
            let t: Vec<&str> = rest.split_whitespace().collect();
            if t.len() != 6 || t[0] != "from" || t[2] != "to" || t[4] != "step" {
                return Err(format!("line {}: invalid expect range vector", *i + 1));
            }
            cmd.start = parse_duration_ms(t[1])?;
            cmd.end = parse_duration_ms(t[3])?;
            cmd.step = parse_duration_ms(t[5])?;
            cmd.eval = cmd.end;
            cmd.expect_range_vector = true;
            continue;
        }
        if let Some(rest) = d.strip_prefix("expect string") {
            let rest = rest.trim();
            let q = rest.chars().next().ok_or("expect string needs a quoted literal")?;
            let (s, _) = unquote(&rest[1..], q)?;
            cmd.expect_string = Some(s);
            continue;
        }
        if d.split(' ').next() == Some("expect") || d.split('\t').next() == Some("expect") {
            let rest = d["expect".len()..].trim();
            let (ty, tail) = match rest.find(|c: char| c.is_whitespace()) {
                Some(k) => (&rest[..k], rest[k..].trim()),
                None => (rest, ""),
            };
            match ty {
                "ordered" => cmd.ordered = true,
                "fail" => {
                    cmd.fail = Some(if let Some(m) = tail.strip_prefix("msg:") {
                        FailExpect::Msg(m.trim().to_string())
                    } else if let Some(m) = tail.strip_prefix("regex:") {
                        FailExpect::Regex(m.trim().to_string())
                    } else {
                        FailExpect::Any
                    });
                }
                "warn" | "no_warn" | "info" | "no_info" => {}
                other => return Err(format!("line {}: invalid expect type {other:?}", *i + 1)),
            }
            continue;
        }
        if let Some(v) = parse_number(d) {
            cmd.expect_scalar = Some(v);
            break;
        }
        let (labels, vals) = parse_series_desc(d).map_err(|e| format!("line {}: {e}", *i + 1))?;
        if vals.iter().any(|v| *v == SeqVal::Hist) {
            cmd.has_hist = true;
        }
        if vals.len() > 1 && !cmd.is_range && !cmd.expect_range_vector {
            return Err(format!("line {}: expecting multiple values in instant evaluation not allowed", *i + 1));
        }
        cmd.expected.push((labels, vals, j));
        j += 1;
    }
    Ok(cmd)
}

fn fmt_metric(l: &[(String, String)]) -> String {
    let parts: Vec<String> = l.iter().map(|(k, v)| format!("{k}={v:?}")).collect();
    format!("{{{}}}", parts.join(", "))
}

fn compare_matrix(cmd: &EvalCmd, m: &Matrix) -> Result<(), String> {
    if cmd.ordered {
        return Err("expected ordered result, but query returned a matrix".into());
    }
    if cmd.expect_scalar.is_some() {
        return Err("expected scalar result, but got matrix".into());
    }
    let mut seen = vec![false; cmd.expected.len()];
    for s in &m.series {
        let Some(k) = cmd.expected.iter().position(|e| e.0 == s.metric) else {
            return Err(format!("unexpected metric {} in result, has {:?}", fmt_metric(&s.metric), s.points));
        };
        seen[k] = true;
        let mut exp: Vec<(i64, f64)> = Vec::new();
        for (i, e) in cmd.expected[k].1.iter().enumerate() {
            let ts = cmd.start + i as i64 * cmd.step;
            if ts > cmd.end {
                return Err(format!("expected {} points for {}, but query time range cannot return this many points", cmd.expected[k].1.len(), fmt_metric(&s.metric)));
            }
            if let SeqVal::Val(v) = e {
                exp.push((ts, *v));
            }
        }
        if exp.len() != s.points.len() {
            return Err(format!("expected {} float points for {}, but got {:?}", exp.len(), fmt_metric(&s.metric), s.points));
        }
        for (i, (et, ev)) in exp.iter().enumerate() {
            let (at, av) = s.points[i];
            if *et != at {
                return Err(format!("expected value at index {i} for {} to have timestamp {et}, but it had {at} ({:?})", fmt_metric(&s.metric), s.points));
            }
            if !almost_equal(av, *ev, EPSILON) {
                return Err(format!("expected value at index {i} (t={at}) for {} to be {ev}, but got {av} ({:?})", fmt_metric(&s.metric), s.points));
            }
        }
    }
    for (k, e) in cmd.expected.iter().enumerate() {
        if !seen[k] {
            return Err(format!("expected metric {} not found", fmt_metric(&e.0)));
        }
    }
    Ok(())
}

fn compare_vector(cmd: &EvalCmd, v: &[(Vec<(String, String)>, f64)]) -> Result<(), String> {
    if cmd.expect_scalar.is_some() {
        return Err(format!("expected scalar result, but got vector {v:?}"));
    }
    let mut seen = vec![false; cmd.expected.len()];
    for (pos, (metric, val)) in v.iter().enumerate() {
        let Some(k) = cmd.expected.iter().position(|e| e.0 == *metric) else {
            return Err(format!("unexpected metric {} in result, has value {val}", fmt_metric(metric)));
        };
        let exp = &cmd.expected[k];
        if cmd.ordered && exp.2 != pos + 1 {
            return Err(format!("expected metric {} at position {} but was at {}", fmt_metric(metric), exp.2, pos + 1));
        }
        let ev = match exp.1.first() {
            Some(SeqVal::Val(x)) => *x,
            _ => return Err(format!("no expected float value for {}", fmt_metric(metric))),
        };
        if !almost_equal(ev, *val, EPSILON) {
            return Err(format!("expected {ev} for {} but got {val}", fmt_metric(metric)));
        }
        seen[k] = true;
    }
    for (k, e) in cmd.expected.iter().enumerate() {
        if !seen[k] {
            return Err(format!("expected metric {} with {:?} not found", fmt_metric(&e.0), e.1));
        }
    }
    Ok(())
}

fn compare_value(cmd: &EvalCmd, v: &Value) -> Result<(), String> {
    match v {
        Value::Matrix(m) => compare_matrix(cmd, m),
        Value::Vector(v) => {
            let flat: Vec<(Vec<(String, String)>, f64)> = v.iter().map(|s| (s.metric.clone(), s.value)).collect();
            compare_vector(cmd, &flat)
        }
        Value::Scalar { value, .. } => match cmd.expect_scalar {
            None => Err(format!("expected vector or matrix result, but got scalar {value}")),
            Some(e) if almost_equal(e, *value, EPSILON) => Ok(()),
            Some(e) => Err(format!("expected scalar {e} but got {value}")),
        },
        Value::String { value, .. } => {
            if cmd.expect_string.as_deref() == Some(value.as_str()) {
                Ok(())
            } else {
                Err(format!("expected string {:?} but got {value:?}", cmd.expect_string))
            }
        }
    }
}

fn check_failure(f: &FailExpect, err: &Error) -> Result<(), String> {
    let msg = match err {
        Error::Eval(m) | Error::Parse(m) | Error::Source(m) | Error::Unsupported(m) => m.clone(),
    };
    match f {
        FailExpect::Any => Ok(()),
        FailExpect::Msg(m) => {
            let m = m.trim_matches('"');
            if m == msg {
                Ok(())
            } else {
                Err(format!("expected error {m:?} but got: {msg}"))
            }
        }
        FailExpect::Regex(r) => {
            let r = r.trim_matches('"');
            match regex::Regex::new(r) {
                Ok(re) if re.is_match(&msg) => Ok(()),
                Ok(_) => Err(format!("expected error matching {r:?} but got: {msg}")),
                Err(e) => Err(format!("bad regex in test: {e}")),
            }
        }
    }
}

const AT_UNSAFE: &[&str] = &[
    "days_in_month", "day_of_month", "day_of_week", "day_of_year", "hour", "minute", "month", "year",
    "predict_linear", "time", "timestamp",
];

fn at_of(ts: i64) -> AtModifier {
    AtModifier::At(if ts >= 0 {
        UNIX_EPOCH + Duration::from_millis(ts as u64)
    } else {
        UNIX_EPOCH - Duration::from_millis((-ts) as u64)
    })
}

/// Pin every selector without `@` to `ts`. Returns false if the expression
/// calls a function whose result depends on the evaluation time.
fn pin_at(e: &mut Expr, ts: i64) -> bool {
    match e {
        Expr::VectorSelector(vs) => {
            if vs.at.is_none() {
                vs.at = Some(at_of(ts));
            }
            true
        }
        Expr::MatrixSelector(ms) => {
            if ms.vs.at.is_none() {
                ms.vs.at = Some(at_of(ts));
            }
            true
        }
        Expr::Subquery(sq) => {
            // Selectors inside a pinned subquery are left alone.
            if sq.at.is_none() {
                sq.at = Some(at_of(ts));
            }
            true
        }
        Expr::Paren(p) => pin_at(&mut p.expr, ts),
        Expr::Unary(u) => pin_at(&mut u.expr, ts),
        Expr::Binary(b) => {
            let l = pin_at(&mut b.lhs, ts);
            let r = pin_at(&mut b.rhs, ts);
            l && r
        }
        Expr::Aggregate(a) => {
            let mut ok = pin_at(&mut a.expr, ts);
            if let Some(p) = a.param.as_mut() {
                ok &= pin_at(p, ts);
            }
            ok
        }
        Expr::Call(c) => {
            let mut ok = !AT_UNSAFE.contains(&c.func.name);
            for a in c.args.args.iter_mut() {
                ok &= pin_at(a, ts);
            }
            ok
        }
        _ => true,
    }
}

enum Step {
    Done(Result<(), String>),
    Skip(SkipReason, String),
}

fn run_eval(cmd: &EvalCmd, src: &TestSource, opts: &EvalOptions) -> Outcome {
    if cmd.has_hist {
        return Outcome::Skipped(SkipReason::NativeHistogram, "expected result contains native histograms".into());
    }
    src.hit.set(false);
    let expr = match crate::parse(&cmd.expr) {
        Ok(e) => e,
        Err(e) => {
            // The Go parser accepted this query (the script would not load
            // otherwise), so this is a parser gap, not a query error.
            return Outcome::Skipped(SkipReason::Parser, format!("{e}"));
        }
    };
    let r = if cmd.is_range { run_range(cmd, &expr, src, opts) } else { run_instant(cmd, &expr, src, opts) };
    if src.hit.get() {
        return Outcome::Skipped(SkipReason::NativeHistogram, "query selects a native histogram series".into());
    }
    match r {
        Step::Skip(r, m) => Outcome::Skipped(r, m),
        Step::Done(Ok(())) => Outcome::Passed,
        Step::Done(Err(m)) => Outcome::Failed(m),
    }
}

fn run_range(cmd: &EvalCmd, expr: &Expr, src: &TestSource, opts: &EvalOptions) -> Step {
    match range_expr(src, expr, cmd.start, cmd.end, cmd.step, opts) {
        Err(Error::Unsupported(m)) => Step::Skip(SkipReason::Unsupported, m),
        Err(e) => match &cmd.fail {
            Some(f) => Step::Done(check_failure(f, &e)),
            None => Step::Done(Err(format!("error evaluating query: {e}"))),
        },
        Ok(m) => {
            if cmd.fail.is_some() {
                return Step::Done(Err("expected error evaluating query but got none".into()));
            }
            Step::Done(compare_matrix(cmd, &m))
        }
    }
}

fn run_instant(cmd: &EvalCmd, expr: &Expr, src: &TestSource, opts: &EvalOptions) -> Step {
    let ts = cmd.eval;
    let mut queries: Vec<(Expr, i64, &str)> = vec![(expr.clone(), ts, "")];
    let mut pinned = expr.clone();
    if pin_at(&mut pinned, ts) {
        let times: Vec<i64> = if ts == 0 { vec![-1000, 0, 1000] } else { vec![-10 * ts, 0, ts / 5, ts, 10 * ts] };
        for t in times {
            queries.push((pinned.clone(), t, " (with @ pinned)"));
        }
    }
    for (q, t, what) in &queries {
        let res = match instant_expr(src, q, *t, opts) {
            Err(Error::Unsupported(m)) => return Step::Skip(SkipReason::Unsupported, m),
            Err(e) => {
                return match &cmd.fail {
                    Some(f) => Step::Done(check_failure(f, &e)),
                    None => Step::Done(Err(format!("error evaluating query at {t}{what}: {e}"))),
                }
            }
            Ok(v) => v,
        };
        if cmd.fail.is_some() {
            return Step::Done(Err("expected error evaluating query but got none".into()));
        }
        if let Err(m) = compare_value(cmd, &res) {
            return Step::Done(Err(format!("instant at {t}{what}: {m}")));
        }
        if cmd.expect_range_vector || cmd.expect_string.is_some() {
            continue;
        }
        // The same query as the middle step of a range query.
        let m = match range_expr(src, q, t - 60_000, t + 60_000, 60_000, opts) {
            Err(Error::Unsupported(m)) => return Step::Skip(SkipReason::Unsupported, m),
            Err(e) => return Step::Done(Err(format!("error evaluating query at {t}{what} in range mode: {e}"))),
            Ok(m) => m,
        };
        if cmd.ordered {
            continue;
        }
        let vec: Vec<(Vec<(String, String)>, f64)> = m
            .series
            .iter()
            .filter_map(|s| s.points.iter().find(|p| p.0 == *t).map(|p| (s.metric.clone(), p.1)))
            .collect();
        let r = if matches!(res, Value::Scalar { .. }) {
            match (cmd.expect_scalar, vec.first()) {
                (Some(e), Some((_, v))) if almost_equal(e, *v, EPSILON) => Ok(()),
                (e, v) => Err(format!("expected scalar {e:?} but got {v:?}")),
            }
        } else {
            compare_vector(cmd, &vec)
        };
        if let Err(m) = r {
            return Step::Done(Err(format!("range mode at {t}{what}: {m}")));
        }
    }
    Step::Done(Ok(()))
}

/// Run a whole script. `Err` means the script itself could not be parsed.
pub fn run_script(input: &str, opts: &EvalOptions) -> Result<Report, String> {
    let lines: Vec<String> = input
        .split('\n')
        .map(|l| {
            let l = l.trim();
            if l.starts_with('#') {
                String::new()
            } else {
                l.to_string()
            }
        })
        .collect();
    let mut src = TestSource::default();
    let mut report = Report::default();
    let mut i = 0;
    while i < lines.len() {
        let l = &lines[i];
        if l.is_empty() {
            i += 1;
            continue;
        }
        let head = l.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
        if head == "clear" {
            src = TestSource::default();
        } else if head.starts_with("load") {
            let with_nhcb = head == "load_with_nhcb";
            let gap = parse_duration_ms(l.split_whitespace().nth(1).unwrap_or(""))
                .map_err(|e| format!("line {}: {e}", i + 1))?;
            while i + 1 < lines.len() && !lines[i + 1].is_empty() {
                i += 1;
                let (labels, vals) = parse_series_desc(&lines[i]).map_err(|e| format!("line {}: {e}", i + 1))?;
                let mut ts = Vec::new();
                let mut values = Vec::new();
                let mut hist = Vec::new();
                for (k, v) in vals.iter().enumerate() {
                    match v {
                        SeqVal::Val(x) => {
                            ts.push(k as i64 * gap);
                            values.push(*x);
                        }
                        SeqVal::Omitted => {}
                        SeqVal::Hist => hist.push(k as i64 * gap),
                    }
                }
                if !hist.is_empty() {
                    src.tainted.push((labels.clone(), hist));
                }
                if with_nhcb {
                    // Upstream also stores a native histogram with custom
                    // buckets under the base name; remember it as unreadable.
                    let name = label_get(&labels, NAME_LABEL);
                    if let Some(base) = name.strip_suffix("_bucket") {
                        let mut l: Vec<(String, String)> =
                            labels.iter().filter(|(k, _)| k != "le" && k != NAME_LABEL).cloned().collect();
                        l.push((NAME_LABEL.to_string(), base.to_string()));
                        l.sort();
                        src.tainted.push((l, ts.clone()));
                    }
                }
                src.mem.add(Series { labels, ts, values });
            }
        } else if head.starts_with("eval") {
            let cmd = parse_eval(&lines, &mut i)?;
            let outcome = run_eval(&cmd, &src, opts);
            report.cases.push(CaseResult { line: cmd.line, expr: cmd.expr.clone(), outcome });
        } else {
            return Err(format!("line {}: invalid command {l:?}", i + 1));
        }
        i += 1;
    }
    Ok(report)
}
