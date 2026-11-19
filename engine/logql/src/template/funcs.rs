//! Template functions: Go's built-ins (`and`, `or`, `not`, `len`, `index`, `slice`,
//! `print`, `printf`, `println`, `html`, `js`, `urlquery`, `eq`, `ne`, `lt`, `le`, `gt`,
//! `ge`) and the functions listed in the LogQL template-functions documentation.

use std::rc::Rc;

use super::gofmt::{self, sprint, sprintf, sprintln};
use super::gotime;
use super::value::V;

pub enum CallError {
    /// A message used as is (wrong argument count or type).
    Msg(String),
    /// The function itself failed: reported as `error calling <name>: <msg>`.
    Calling(String),
}

pub struct FnCtx<'a> {
    pub line: &'a str,
    pub ts_ns: i64,
    pub now_ns: Option<i64>,
}

const NAMES: &[&str] = &[
    // Go built-ins
    "and", "or", "not", "len", "index", "slice", "print", "printf", "println", "html", "js", "urlquery", "eq", "ne", "lt", "le", "gt", "ge",
    // LogQL
    "__line__", "__timestamp__", "date", "duration", "duration_seconds", "now", "toDate", "toDateInZone", "unixEpoch", "unixEpochMillis",
    "unixEpochNanos", "unixToTime", "alignLeft", "alignRight", "b64enc", "b64dec", "bytes", "default", "fromJson", "lower", "indent",
    "nindent", "repeat", "replace", "substr", "title", "trim", "trimAll", "trimPrefix", "trimSuffix", "trunc", "upper", "urlencode",
    "urldecode", "contains", "hasPrefix", "hasSuffix", "add", "addf", "ceil", "div", "divf", "float64", "floor", "int", "max", "maxf",
    "min", "minf", "mul", "mulf", "mod", "round", "sub", "subf", "count", "regexReplaceAll", "regexReplaceAllLiteral",
];

pub fn exists(name: &str) -> bool {
    NAMES.contains(&name)
}

fn type_of(v: &V) -> &'static str {
    match v {
        V::Str(_) => "string",
        V::Int(_) => "int",
        V::Float(_) => "float64",
        V::Bool(_) => "bool",
        V::Time(_) => "time.Time",
        V::Nil | V::NoValue => "nil",
        V::List(_) => "[]interface {}",
        V::Map(_) => "map[string]interface {}",
    }
}

fn want(name: &str, args: &[V], n: usize) -> Result<(), CallError> {
    if args.len() != n {
        return Err(CallError::Msg(format!("wrong number of args for {name}: want {n} got {}", args.len())));
    }
    Ok(())
}

fn want_at_least(name: &str, args: &[V], n: usize) -> Result<(), CallError> {
    if args.len() < n {
        return Err(CallError::Msg(format!("wrong number of args for {name}: want at least {n} got {}", args.len())));
    }
    Ok(())
}

fn s(v: &V) -> Result<&str, CallError> {
    match v {
        V::Str(x) => Ok(x),
        other => Err(CallError::Msg(format!("wrong type for value; expected string; got {}", type_of(other)))),
    }
}

fn int(v: &V) -> Result<i64, CallError> {
    match v {
        V::Int(i) => Ok(*i),
        V::Float(f) if f.fract() == 0.0 => Ok(*f as i64),
        other => Err(CallError::Msg(format!("wrong type for value; expected int; got {}", type_of(other)))),
    }
}

fn time(v: &V) -> Result<i128, CallError> {
    match v {
        V::Time(t) => Ok(*t),
        other => Err(CallError::Msg(format!("wrong type for value; expected time.Time; got {}", type_of(other)))),
    }
}

/// Integer conversion of the numeric helpers: integers as is, floats truncated, strings
/// parsed as integers (with `0x`/`0o`/`0b` prefixes; a zero fraction such as `3.0` is
/// accepted), anything unparsable is 0.
pub fn to_i64(v: &V) -> i64 {
    match v {
        V::Int(i) => *i,
        V::Float(f) => {
            if f.is_nan() {
                0
            } else {
                *f as i64
            }
        }
        V::Bool(b) => *b as i64,
        V::Str(x) => parse_int_cast(x).unwrap_or(0),
        _ => 0,
    }
}

fn parse_int_cast(x: &str) -> Option<i64> {
    let t = x.trim_end_matches(|_| false);
    let t = match t.split_once('.') {
        Some((a, b)) if !a.is_empty() && b.bytes().all(|c| c == b'0') => a,
        _ => t,
    };
    let (neg, body) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let lower = body.to_ascii_lowercase();
    let v = if let Some(h) = lower.strip_prefix("0x") {
        i64::from_str_radix(h, 16).ok()?
    } else if let Some(o) = lower.strip_prefix("0o") {
        i64::from_str_radix(o, 8).ok()?
    } else if let Some(bn) = lower.strip_prefix("0b") {
        i64::from_str_radix(bn, 2).ok()?
    } else if lower.len() > 1 && lower.starts_with('0') {
        i64::from_str_radix(&lower[1..], 8).ok()?
    } else {
        if lower.is_empty() || !lower.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        lower.parse::<i64>().ok()?
    };
    Some(if neg { -v } else { v })
}

pub fn to_f64(v: &V) -> f64 {
    match v {
        V::Int(i) => *i as f64,
        V::Float(f) => *f,
        V::Bool(b) => *b as i64 as f64,
        V::Str(x) => crate::text::go_parse_float(x).unwrap_or(0.0),
        _ => 0.0,
    }
}

fn str_v(x: impl Into<String>) -> V {
    V::Str(x.into())
}

fn cmp_basic(a: &V, b: &V) -> Result<std::cmp::Ordering, CallError> {
    use std::cmp::Ordering;
    let r = match (a, b) {
        (V::Str(x), V::Str(y)) => x.cmp(y),
        (V::Int(x), V::Int(y)) => x.cmp(y),
        (V::Float(x), V::Float(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (V::Int(x), V::Float(y)) => (*x as f64).partial_cmp(y).unwrap_or(Ordering::Equal),
        (V::Float(x), V::Int(y)) => x.partial_cmp(&(*y as f64)).unwrap_or(Ordering::Equal),
        (V::Bool(x), V::Bool(y)) => x.cmp(y),
        _ => return Err(CallError::Calling("incompatible types for comparison".into())),
    };
    Ok(r)
}

fn eq_basic(a: &V, b: &V) -> Result<bool, CallError> {
    match (a, b) {
        (V::Nil | V::NoValue, V::Nil | V::NoValue) => Ok(true),
        (V::Int(_) | V::Float(_), V::Float(_) | V::Int(_)) if std::mem::discriminant(a) != std::mem::discriminant(b) => {
            Err(CallError::Calling("incompatible types for comparison".into()))
        }
        (V::Bool(_), V::Bool(_)) | (V::Str(_), V::Str(_)) | (V::Int(_), V::Int(_)) | (V::Float(_), V::Float(_)) => {
            Ok(cmp_basic(a, b)? == std::cmp::Ordering::Equal)
        }
        (V::Time(x), V::Time(y)) => Ok(x == y),
        (V::List(_) | V::Map(_), _) | (_, V::List(_) | V::Map(_)) => Err(CallError::Calling("non-comparable types".into())),
        _ => Err(CallError::Calling("incompatible types for comparison".into())),
    }
}

fn title(x: &str) -> String {
    let mut out = String::with_capacity(x.len());
    let mut prev_sep = true;
    for c in x.chars() {
        if prev_sep {
            out.extend(c.to_uppercase());
        } else {
            out.push(c);
        }
        prev_sep = if c.is_ascii() { !(c.is_ascii_alphanumeric() || c == '_') } else if c.is_alphanumeric() { false } else { c.is_whitespace() };
    }
    out
}

/// Byte-slicing as Go does; a cut inside a UTF-8 sequence keeps the invalid bytes, shown
/// here as U+FFFD.
fn byte_slice(x: &str, a: usize, b: usize) -> String {
    String::from_utf8_lossy(&x.as_bytes()[a..b]).into_owned()
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64enc(x: &[u8]) -> String {
    let mut out = String::with_capacity(x.len().div_ceil(3) * 4);
    for chunk in x.chunks(3) {
        let n = chunk.len();
        let v = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            if k <= n {
                out.push(B64[(v >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn b64dec(x: &str) -> Result<Vec<u8>, String> {
    let b = x.as_bytes();
    if b.len() % 4 != 0 {
        return Err(format!("illegal base64 data at input byte {}", b.len() / 4 * 4));
    }
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    for (ci, chunk) in b.chunks(4).enumerate() {
        let mut v = 0u32;
        let mut pad = 0;
        for (k, &c) in chunk.iter().enumerate() {
            let d = match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' if k >= 2 && ci == b.len() / 4 - 1 => {
                    pad += 1;
                    0
                }
                _ => return Err(format!("illegal base64 data at input byte {}", ci * 4 + k)),
            };
            if pad > 0 && c != b'=' {
                return Err(format!("illegal base64 data at input byte {}", ci * 4 + k));
            }
            v = v << 6 | d as u32;
        }
        let bytes = [(v >> 16) as u8, (v >> 8) as u8, v as u8];
        out.extend_from_slice(&bytes[..3 - pad]);
    }
    Ok(out)
}

fn query_escape(x: &str) -> String {
    let mut out = String::new();
    for b in x.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn query_unescape(x: &str) -> Result<String, String> {
    let b = x.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                let h = x.get(i + 1..i + 3).filter(|h| h.bytes().all(|c| c.is_ascii_hexdigit()));
                let Some(h) = h else {
                    let bad: String = x[i..].chars().take(3).collect();
                    return Err(format!("invalid URL escape {}", gofmt::go_quote(&bad)));
                };
                out.push(u8::from_str_radix(h, 16).unwrap_or(0));
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn html_escape(x: &str) -> String {
    let mut out = String::new();
    for c in x.chars() {
        match c {
            '\0' => out.push('\u{FFFD}'),
            '"' => out.push_str("&#34;"),
            '\'' => out.push_str("&#39;"),
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
    out
}

fn js_escape(x: &str) -> String {
    let mut out = String::new();
    for c in x.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '"' => out.push_str("\\\""),
            '<' => out.push_str("\\u003C"),
            '>' => out.push_str("\\u003E"),
            '&' => out.push_str("\\u0026"),
            '=' => out.push_str("\\u003D"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn regex(p: &str) -> Result<regex::Regex, CallError> {
    crate::goregex::compile_plain(p).map_err(|e| CallError::Calling(format!("error parsing regexp: {e}")))
}

fn unix_to_time(epoch: &str) -> Result<V, CallError> {
    let n: i64 = epoch.parse().map_err(|_| CallError::Calling(format!("strconv.ParseInt: parsing {}: invalid syntax", gofmt::go_quote(epoch))))?;
    let digits = epoch.trim_start_matches('-').len();
    let ns: i128 = match digits {
        0..=5 => n as i128 * 86_400 * 1_000_000_000,
        6..=10 => n as i128 * 1_000_000_000,
        11..=13 => n as i128 * 1_000_000,
        14..=16 => n as i128 * 1_000,
        _ => n as i128,
    };
    Ok(V::Time(ns))
}

fn date_arg(v: &V) -> i128 {
    match v {
        V::Time(t) => *t,
        V::Int(i) => *i as i128 * 1_000_000_000,
        V::Float(f) => *f as i128 * 1_000_000_000,
        _ => 0,
    }
}

fn round(a: f64, places: f64, on: f64) -> f64 {
    let pow = 10f64.powf(places);
    let digit = pow * a;
    let frac = digit.fract();
    let r = if frac >= on { digit.ceil() } else { digit.floor() };
    r / pow
}

pub fn call(name: &str, args: &[V], ctx: &FnCtx<'_>) -> Result<V, CallError> {
    Ok(match name {
        "not" => {
            want(name, args, 1)?;
            V::Bool(!args[0].truthy())
        }
        "len" => {
            want(name, args, 1)?;
            V::Int(match &args[0] {
                V::Str(x) => x.len() as i64,
                V::List(l) => l.len() as i64,
                V::Map(m) => m.len() as i64,
                other => return Err(CallError::Calling(format!("len of type {}", type_of(other)))),
            })
        }
        "index" => {
            want_at_least(name, args, 1)?;
            let mut cur = args[0].clone();
            for k in &args[1..] {
                cur = match (&cur, k) {
                    (V::List(l), V::Int(i)) => match usize::try_from(*i).ok().and_then(|i| l.get(i)) {
                        Some(v) => v.clone(),
                        None => return Err(CallError::Calling(format!("error calling index: index out of range: {i}"))),
                    },
                    (V::Map(m), V::Str(key)) => m.iter().find(|(mk, _)| mk == key).map(|(_, v)| v.clone()).unwrap_or(V::NoValue),
                    (V::Str(x), V::Int(i)) => match usize::try_from(*i).ok().and_then(|i| x.as_bytes().get(i)) {
                        Some(b) => V::Int(*b as i64),
                        None => return Err(CallError::Calling(format!("error calling index: index out of range: {i}"))),
                    },
                    (V::Nil | V::NoValue, _) => return Err(CallError::Calling("index of untyped nil".into())),
                    (c, _) => return Err(CallError::Calling(format!("can't index item of type {}", type_of(c)))),
                };
            }
            cur
        }
        "slice" => {
            want_at_least(name, args, 1)?;
            let ix: Vec<i64> = args[1..].iter().map(to_i64).collect();
            match &args[0] {
                V::Str(x) => {
                    let a = *ix.first().unwrap_or(&0) as usize;
                    let b = ix.get(1).map(|v| *v as usize).unwrap_or(x.len());
                    if a > b || b > x.len() {
                        return Err(CallError::Calling(format!("error calling slice: index out of range: {b}")));
                    }
                    str_v(byte_slice(x, a, b))
                }
                V::List(l) => {
                    let a = *ix.first().unwrap_or(&0) as usize;
                    let b = ix.get(1).map(|v| *v as usize).unwrap_or(l.len());
                    if a > b || b > l.len() {
                        return Err(CallError::Calling(format!("error calling slice: index out of range: {b}")));
                    }
                    V::List(Rc::new(l[a..b].to_vec()))
                }
                other => return Err(CallError::Calling(format!("can't slice item of type {}", type_of(other)))),
            }
        }
        "print" => str_v(sprint(args)),
        "println" => str_v(sprintln(args)),
        "printf" => {
            want_at_least(name, args, 1)?;
            str_v(sprintf(s(&args[0])?, &args[1..]))
        }
        "html" => str_v(html_escape(&sprint(args))),
        "js" => str_v(js_escape(&sprint(args))),
        "urlquery" => str_v(query_escape(&sprint(args))),
        "eq" => {
            want_at_least(name, args, 2)?;
            let mut any = false;
            for b in &args[1..] {
                if eq_basic(&args[0], b)? {
                    any = true;
                }
            }
            V::Bool(any)
        }
        "ne" => {
            want(name, args, 2)?;
            V::Bool(!eq_basic(&args[0], &args[1])?)
        }
        "lt" | "le" | "gt" | "ge" => {
            want(name, args, 2)?;
            let o = cmp_basic(&args[0], &args[1])?;
            use std::cmp::Ordering::*;
            V::Bool(match name {
                "lt" => o == Less,
                "le" => o != Greater,
                "gt" => o == Greater,
                _ => o != Less,
            })
        }
        "__line__" => {
            want(name, args, 0)?;
            str_v(ctx.line)
        }
        "__timestamp__" => {
            want(name, args, 0)?;
            V::Time(ctx.ts_ns as i128)
        }
        "now" => {
            want(name, args, 0)?;
            match ctx.now_ns {
                Some(t) => V::Time(t as i128),
                None => return Err(CallError::Calling("now is not available: the engine has no clock and the caller gave no time".into())),
            }
        }
        "date" => {
            want(name, args, 2)?;
            str_v(gotime::format(date_arg(&args[1]), s(&args[0])?))
        }
        "toDate" => {
            want(name, args, 2)?;
            V::Time(gotime::parse(s(&args[0])?, s(&args[1])?).unwrap_or(-62_135_596_800 * 1_000_000_000))
        }
        "toDateInZone" => {
            want(name, args, 3)?;
            let zone = s(&args[1])?;
            if !matches!(zone, "UTC" | "Local" | "" | "Etc/UTC" | "GMT") {
                return Err(CallError::Calling(format!("time zone {zone:?} is not supported: the engine knows only UTC")));
            }
            V::Time(gotime::parse(s(&args[0])?, s(&args[2])?).unwrap_or(-62_135_596_800 * 1_000_000_000))
        }
        "unixEpoch" => {
            want(name, args, 1)?;
            str_v(time(&args[0])?.div_euclid(1_000_000_000).to_string())
        }
        "unixEpochMillis" => {
            want(name, args, 1)?;
            str_v(time(&args[0])?.div_euclid(1_000_000).to_string())
        }
        "unixEpochNanos" => {
            want(name, args, 1)?;
            str_v(time(&args[0])?.to_string())
        }
        "unixToTime" => {
            want(name, args, 1)?;
            unix_to_time(s(&args[0])?)?
        }
        "duration" | "duration_seconds" => {
            want(name, args, 1)?;
            let x = s(&args[0])?;
            match crate::text::parse_go_duration(x) {
                Some(ns) => V::Float(ns as f64 / 1e9),
                None => return Err(CallError::Calling(crate::pipeline::go_duration_error(x))),
            }
        }
        "bytes" => {
            want(name, args, 1)?;
            let x = s(&args[0])?;
            match crate::text::parse_bytes(x) {
                Some(b) => V::Float(b),
                None => return Err(CallError::Calling(crate::pipeline::bytes_error(x))),
            }
        }
        "alignLeft" | "alignRight" => {
            want(name, args, 2)?;
            let n = int(&args[0])?;
            let x = s(&args[1])?;
            let cs: Vec<char> = x.chars().collect();
            let n = n.max(0) as usize;
            if cs.len() >= n {
                str_v(if name == "alignLeft" { cs[..n].iter().collect::<String>() } else { cs[cs.len() - n..].iter().collect::<String>() })
            } else if name == "alignLeft" {
                str_v(format!("{x}{}", " ".repeat(n - cs.len())))
            } else {
                str_v(format!("{}{x}", " ".repeat(n - cs.len())))
            }
        }
        "b64enc" => {
            want(name, args, 1)?;
            str_v(b64enc(s(&args[0])?.as_bytes()))
        }
        "b64dec" => {
            want(name, args, 1)?;
            match b64dec(s(&args[0])?) {
                Ok(b) => str_v(String::from_utf8_lossy(&b).into_owned()),
                Err(e) => str_v(e),
            }
        }
        "default" => {
            want_at_least(name, args, 1)?;
            match args.get(1) {
                Some(g) if g.truthy() => g.clone(),
                _ => args[0].clone(),
            }
        }
        "fromJson" => {
            want(name, args, 1)?;
            match crate::json::parse(s(&args[0])?) {
                Ok(j) => V::from_json(&j),
                Err(_) => V::Nil,
            }
        }
        "lower" => {
            want(name, args, 1)?;
            str_v(s(&args[0])?.to_lowercase())
        }
        "upper" => {
            want(name, args, 1)?;
            str_v(s(&args[0])?.to_uppercase())
        }
        "title" => {
            want(name, args, 1)?;
            str_v(title(s(&args[0])?))
        }
        "trim" => {
            want(name, args, 1)?;
            str_v(s(&args[0])?.trim())
        }
        "trimAll" => {
            want(name, args, 2)?;
            let cut = s(&args[0])?;
            str_v(s(&args[1])?.trim_matches(|c| cut.contains(c)))
        }
        "trimPrefix" => {
            want(name, args, 2)?;
            let x = s(&args[1])?;
            str_v(x.strip_prefix(s(&args[0])?).unwrap_or(x))
        }
        "trimSuffix" => {
            want(name, args, 2)?;
            let x = s(&args[1])?;
            str_v(x.strip_suffix(s(&args[0])?).unwrap_or(x))
        }
        "indent" | "nindent" => {
            want(name, args, 2)?;
            let pad = " ".repeat(int(&args[0])?.max(0) as usize);
            let body = format!("{pad}{}", s(&args[1])?.replace('\n', &format!("\n{pad}")));
            str_v(if name == "nindent" { format!("\n{body}") } else { body })
        }
        "repeat" => {
            want(name, args, 2)?;
            let n = int(&args[0])?;
            let x = s(&args[1])?;
            if n < 0 {
                return Err(CallError::Calling("strings: negative Repeat count".into()));
            }
            if (n as u128) * (x.len() as u128) > 1 << 20 {
                return Err(CallError::Calling("repeat: result too large".into()));
            }
            str_v(x.repeat(n as usize))
        }
        "replace" => {
            want(name, args, 3)?;
            str_v(s(&args[2])?.replace(s(&args[0])?, s(&args[1])?))
        }
        "substr" => {
            want(name, args, 3)?;
            let (a, b) = (int(&args[0])?, int(&args[1])?);
            let x = s(&args[2])?;
            let len = x.len() as i64;
            if a < 0 {
                let e = b.clamp(0, len);
                if b > len || b < 0 {
                    return Err(CallError::Calling(format!("runtime error: slice bounds out of range [:{b}] with length {len}")));
                }
                str_v(byte_slice(x, 0, e as usize))
            } else if b < 0 || b > len {
                if a > len {
                    return Err(CallError::Calling(format!("runtime error: slice bounds out of range [{a}:{len}]")));
                }
                str_v(byte_slice(x, a as usize, len as usize))
            } else {
                if a > b {
                    return Err(CallError::Calling(format!("runtime error: slice bounds out of range [{a}:{b}]")));
                }
                str_v(byte_slice(x, a as usize, b as usize))
            }
        }
        "trunc" => {
            want(name, args, 2)?;
            let c = int(&args[0])?;
            let x = s(&args[1])?;
            let len = x.len() as i64;
            if c < 0 && len + c > 0 {
                str_v(byte_slice(x, (len + c) as usize, x.len()))
            } else if c >= 0 && len > c {
                str_v(byte_slice(x, 0, c as usize))
            } else {
                str_v(x)
            }
        }
        "urlencode" => {
            want(name, args, 1)?;
            str_v(query_escape(s(&args[0])?))
        }
        "urldecode" => {
            want(name, args, 1)?;
            str_v(query_unescape(s(&args[0])?).map_err(CallError::Calling)?)
        }
        "contains" => {
            want(name, args, 2)?;
            V::Bool(s(&args[1])?.contains(s(&args[0])?))
        }
        "hasPrefix" => {
            want(name, args, 2)?;
            V::Bool(s(&args[1])?.starts_with(s(&args[0])?))
        }
        "hasSuffix" => {
            want(name, args, 2)?;
            V::Bool(s(&args[1])?.ends_with(s(&args[0])?))
        }
        "add" => V::Int(args.iter().map(to_i64).fold(0i64, |a, b| a.wrapping_add(b))),
        "mul" => {
            want_at_least(name, args, 1)?;
            V::Int(args.iter().map(to_i64).fold(1i64, |a, b| a.wrapping_mul(b)))
        }
        "sub" => {
            want(name, args, 2)?;
            V::Int(to_i64(&args[0]).wrapping_sub(to_i64(&args[1])))
        }
        "div" | "mod" => {
            want(name, args, 2)?;
            let (a, b) = (to_i64(&args[0]), to_i64(&args[1]));
            if b == 0 {
                return Err(CallError::Calling("runtime error: integer divide by zero".into()));
            }
            V::Int(if name == "div" { a.wrapping_div(b) } else { a.wrapping_rem(b) })
        }
        "max" | "min" => {
            want_at_least(name, args, 1)?;
            let it = args.iter().map(to_i64);
            V::Int(if name == "max" { it.max().unwrap_or(0) } else { it.min().unwrap_or(0) })
        }
        "addf" => V::Float(args.iter().map(to_f64).sum()),
        "mulf" => {
            want_at_least(name, args, 1)?;
            V::Float(args.iter().map(to_f64).product())
        }
        "subf" | "divf" => {
            want_at_least(name, args, 1)?;
            let mut acc = to_f64(&args[0]);
            for a in &args[1..] {
                let b = to_f64(a);
                acc = if name == "subf" { acc - b } else { acc / b };
            }
            V::Float(acc)
        }
        "maxf" | "minf" => {
            want_at_least(name, args, 1)?;
            let mut acc = to_f64(&args[0]);
            for a in &args[1..] {
                let b = to_f64(a);
                acc = if name == "maxf" { acc.max(b) } else { acc.min(b) };
            }
            V::Float(acc)
        }
        "ceil" => {
            want(name, args, 1)?;
            V::Float(to_f64(&args[0]).ceil())
        }
        "floor" => {
            want(name, args, 1)?;
            V::Float(to_f64(&args[0]).floor())
        }
        "round" => {
            want_at_least(name, args, 2)?;
            let on = args.get(2).map(to_f64).unwrap_or(0.5);
            V::Float(round(to_f64(&args[0]), to_i64(&args[1]) as f64, on))
        }
        "float64" => {
            want(name, args, 1)?;
            V::Float(to_f64(&args[0]))
        }
        "int" => {
            want(name, args, 1)?;
            V::Int(match &args[0] {
                V::Str(x) => parse_int_cast(x).unwrap_or_else(|| crate::text::go_parse_float(x).map(|f| f as i64).unwrap_or(0)),
                other => to_i64(other),
            })
        }
        "count" => {
            want(name, args, 2)?;
            V::Int(regex(s(&args[0])?)?.find_iter(s(&args[1])?).count() as i64)
        }
        "regexReplaceAll" => {
            want(name, args, 3)?;
            let re = regex(s(&args[0])?)?;
            str_v(re.replace_all(s(&args[1])?, s(&args[2])?).into_owned())
        }
        "regexReplaceAllLiteral" => {
            want(name, args, 3)?;
            let re = regex(s(&args[0])?)?;
            str_v(re.replace_all(s(&args[1])?, regex::NoExpand(s(&args[2])?)).into_owned())
        }
        _ => return Err(CallError::Msg(format!("function {name:?} not defined"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(name: &str, args: &[V]) -> String {
        let ctx = FnCtx { line: "", ts_ns: 0, now_ns: None };
        match call(name, args, &ctx) {
            Ok(v) => gofmt::value_v(&v),
            Err(CallError::Msg(m)) | Err(CallError::Calling(m)) => format!("ERR {m}"),
        }
    }
    fn st(x: &str) -> V {
        V::Str(x.into())
    }

    #[test]
    fn documented_examples() {
        assert_eq!(c("alignLeft", &[V::Int(5), st("hello world")]), "hello");
        assert_eq!(c("alignLeft", &[V::Int(5), st("hi")]), "hi   ");
        assert_eq!(c("alignRight", &[V::Int(5), st("hello world")]), "world");
        assert_eq!(c("alignRight", &[V::Int(5), st("hi")]), "   hi");
        assert_eq!(c("default", &[st("-"), st("")]), "-");
        assert_eq!(c("default", &[st("-"), st("foo")]), "foo");
        assert_eq!(c("repeat", &[V::Int(3), st("hello")]), "hellohellohello");
        assert_eq!(c("replace", &[st("hello"), st("world"), st("hello world")]), "world world");
        assert_eq!(c("substr", &[V::Int(0), V::Int(5), st("hello world")]), "hello");
        assert_eq!(c("substr", &[V::Int(6), V::Int(11), st("hello world")]), "world");
        assert_eq!(c("title", &[st("hello world")]), "Hello World");
        assert_eq!(c("trim", &[st("   hello    ")]), "hello");
        assert_eq!(c("trimAll", &[st("$"), st("$5.00")]), "5.00");
        assert_eq!(c("trimPrefix", &[st("-"), st("-hello")]), "hello");
        assert_eq!(c("trimSuffix", &[st("-"), st("hello-")]), "hello");
        assert_eq!(c("trunc", &[V::Int(5), st("hello world")]), "hello");
        assert_eq!(c("trunc", &[V::Int(-5), st("hello world")]), "world");
        assert_eq!(c("add", &[V::Int(3), V::Int(2), V::Int(5)]), "10");
        assert_eq!(c("addf", &[V::Float(3.5), V::Int(2), V::Int(5)]), "10.5");
        assert_eq!(c("ceil", &[V::Float(123.001)]), "124");
        assert_eq!(c("div", &[V::Int(10), V::Int(2)]), "5");
        assert_eq!(c("divf", &[V::Int(10), V::Int(2), V::Int(4)]), "1.25");
        assert_eq!(c("float64", &[st("3.5")]), "3.5");
        assert_eq!(c("floor", &[V::Float(123.9999)]), "123");
        assert_eq!(c("int", &[st("3")]), "3");
        assert_eq!(c("max", &[V::Int(1), V::Int(2), V::Int(3)]), "3");
        assert_eq!(c("maxf", &[V::Int(1), V::Float(2.5), V::Int(3)]), "3");
        assert_eq!(c("min", &[V::Int(1), V::Int(2), V::Int(3)]), "1");
        assert_eq!(c("mul", &[V::Int(5), V::Int(2), V::Int(3)]), "30");
        assert_eq!(c("mulf", &[V::Float(5.5), V::Int(2), V::Float(2.5)]), "27.5");
        assert_eq!(c("mod", &[V::Int(10), V::Int(3)]), "1");
        assert_eq!(c("round", &[V::Float(123.555555), V::Int(3)]), "123.556");
        assert_eq!(c("round", &[V::Float(123.88571428571), V::Int(5), V::Float(0.2)]), "123.88572");
        assert_eq!(c("sub", &[V::Int(5), V::Int(2)]), "3");
        assert_eq!(c("subf", &[V::Float(5.5), V::Int(2), V::Float(1.5)]), "2");
        assert_eq!(c("count", &[st("a|b"), st("abab")]), "4");
        assert_eq!(c("count", &[st("o"), st("foo")]), "2");
        assert_eq!(c("regexReplaceAll", &[st("(a*)bc"), st("aabcx"), st("${1}X")]), "aaXx");
        assert_eq!(c("regexReplaceAllLiteral", &[st("b"), st("abc"), st("$1")]), "a$1c");
        assert_eq!(c("b64enc", &[st("hi")]), "aGk=");
        assert_eq!(c("b64dec", &[st("aGk=")]), "hi");
        assert_eq!(c("urlencode", &[st("a b&c")]), "a+b%26c");
        assert_eq!(c("urldecode", &[st("a%20b")]), "a b");
        assert_eq!(c("unixEpoch", &[V::Time(1_000_000_000)]), "1");
        assert_eq!(c("date", &[st("2006-01-02"), V::Time(0)]), "1970-01-01");
        assert_eq!(c("unixToTime", &[st("1679577215")]), "2023-03-23 13:13:35 +0000 UTC");
        assert_eq!(c("unixToTime", &[st("19500")]), "2023-05-23 00:00:00 +0000 UTC");
        assert_eq!(c("div", &[V::Int(1), V::Int(0)]), "ERR runtime error: integer divide by zero");
        assert_eq!(c("upper", &[V::Int(1)]), "ERR wrong type for value; expected string; got int");
    }
}
