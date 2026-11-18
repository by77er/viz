//! The two small JSON shapes this crate reads and writes: the canonical `labels` object
//! of `metric_series` and the row-group index fragment. Hand-written to keep the WASM
//! build free of a general JSON dependency.
use crate::error::{Error, Result};

/// Append `s` as a JSON string. Escaping follows RFC 8785: `"` and `\` are escaped,
/// control characters use the short forms where they exist and `\u00xx` otherwise,
/// everything else is written as UTF-8.
pub fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0a}' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\u{0d}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str("\\u00");
                out.push(char::from_digit((c as u32) >> 4, 16).unwrap());
                out.push(char::from_digit((c as u32) & 15, 16).unwrap());
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The canonical JSON object for a label set: keys in the order given (callers pass
/// labels sorted by name in byte order), no whitespace.
pub fn labels_to_json<N: AsRef<str>, V: AsRef<str>>(labels: &[(N, V)]) -> String {
    let mut out = String::with_capacity(2 + labels.iter().map(|(n, v)| n.as_ref().len() + v.as_ref().len() + 6).sum::<usize>());
    out.push('{');
    for (i, (n, v)) in labels.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_string(&mut out, n.as_ref());
        out.push(':');
        write_string(&mut out, v.as_ref());
    }
    out.push('}');
    out
}

/// A parsed JSON value (only what the two shapes need: no floats, booleans or null).
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Object(Vec<(String, Value)>),
    Array(Vec<Value>),
    String(String),
    Int(i64),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

struct P<'a> {
    b: &'a [u8],
    at: usize,
}

fn err<T>(msg: &str, at: usize) -> Result<T> {
    Err(Error::Json(format!("{msg} at byte {at}")))
}

impl<'a> P<'a> {
    fn ws(&mut self) {
        while matches!(self.b.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }
    fn expect(&mut self, c: u8) -> Result<()> {
        if self.b.get(self.at) == Some(&c) {
            self.at += 1;
            Ok(())
        } else {
            err(&format!("expected '{}'", c as char), self.at)
        }
    }
    fn hex4(&mut self) -> Result<u32> {
        let Some(h) = self.b.get(self.at..self.at + 4) else { return err("short \\u escape", self.at) };
        let mut v = 0u32;
        for c in h {
            let Some(d) = (*c as char).to_digit(16) else { return err("bad \\u escape", self.at) };
            v = v * 16 + d;
        }
        self.at += 4;
        Ok(v)
    }
    fn string(&mut self) -> Result<String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let start = self.at;
            while let Some(c) = self.b.get(self.at) {
                if *c == b'"' || *c == b'\\' || *c < 0x20 {
                    break;
                }
                self.at += 1;
            }
            // The input is a &str and we only stop on ASCII bytes, so this slice is valid UTF-8.
            match std::str::from_utf8(&self.b[start..self.at]) {
                Ok(s) => out.push_str(s),
                Err(_) => return err("invalid UTF-8", start),
            }
            match self.b.get(self.at) {
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let Some(e) = self.b.get(self.at) else { return err("unterminated escape", self.at) };
                    self.at += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xd800..0xdc00).contains(&cp) {
                                if self.b.get(self.at..self.at + 2) != Some(b"\\u") {
                                    return err("lone surrogate", self.at);
                                }
                                self.at += 2;
                                let lo = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&lo) {
                                    return err("bad surrogate pair", self.at);
                                }
                                cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                            }
                            match char::from_u32(cp) {
                                Some(c) => out.push(c),
                                None => return err("bad code point", self.at),
                            }
                        }
                        _ => return err("bad escape", self.at - 1),
                    }
                }
                Some(_) => return err("control character in string", self.at),
                None => return err("unterminated string", self.at),
            }
        }
    }
    fn int(&mut self) -> Result<i64> {
        let start = self.at;
        if self.b.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        while matches!(self.b.get(self.at), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        std::str::from_utf8(&self.b[start..self.at])
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .map_or_else(|| err("bad integer", start), Ok)
    }
    fn value(&mut self, depth: u32) -> Result<Value> {
        if depth > 8 {
            return err("nesting too deep", self.at);
        }
        self.ws();
        match self.b.get(self.at) {
            Some(b'{') => {
                self.at += 1;
                let mut m = Vec::new();
                self.ws();
                if self.b.get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Ok(Value::Object(m));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.ws();
                    self.expect(b':')?;
                    let v = self.value(depth + 1)?;
                    m.push((k, v));
                    self.ws();
                    match self.b.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(Value::Object(m));
                        }
                        _ => return err("expected ',' or '}'", self.at),
                    }
                }
            }
            Some(b'[') => {
                self.at += 1;
                let mut a = Vec::new();
                self.ws();
                if self.b.get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Ok(Value::Array(a));
                }
                loop {
                    a.push(self.value(depth + 1)?);
                    self.ws();
                    match self.b.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Value::Array(a));
                        }
                        _ => return err("expected ',' or ']'", self.at),
                    }
                }
            }
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b'-' | b'0'..=b'9') => Ok(Value::Int(self.int()?)),
            _ => err("unexpected token", self.at),
        }
    }
}

/// Parse a JSON document made of objects, arrays, strings and integers.
pub fn parse(s: &str) -> Result<Value> {
    let mut p = P { b: s.as_bytes(), at: 0 };
    let v = p.value(0)?;
    p.ws();
    if p.at != s.len() {
        return err("trailing characters", p.at);
    }
    Ok(v)
}

/// Parse a `labels` cell back into pairs sorted by name (byte order).
pub fn parse_labels(s: &str) -> Result<Vec<(String, String)>> {
    match parse(s)? {
        Value::Object(m) => {
            let mut out = Vec::with_capacity(m.len());
            for (k, v) in m {
                match v {
                    Value::String(v) => out.push((k, v)),
                    _ => return Err(Error::Json("label value is not a string".into())),
                }
            }
            out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            Ok(out)
        }
        _ => Err(Error::Json("labels is not an object".into())),
    }
}
