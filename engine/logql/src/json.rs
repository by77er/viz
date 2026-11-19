//! A small JSON reader for the `json` and `unpack` parsers and the `fromJson` template
//! function (RFC 8259). It keeps the source text of every value, because LogQL extracts
//! numbers as written and objects and arrays as their JSON text.

use std::borrow::Cow;

/// Maximum nesting depth of a document read here (`fromJson`); deeper documents are
/// reported as invalid instead of risking the stack (reading, converting, printing and
/// dropping the value each recurse once per level; a WASM isolate has a 1 MiB stack).
pub const MAX_DEPTH: usize = 128;

#[derive(Debug, Clone, PartialEq)]
pub enum JValue<'a> {
    Null,
    Bool(bool),
    /// A number, as written.
    Num(&'a str),
    Str(Cow<'a, str>),
    /// Elements and the array's source text.
    Arr(Vec<JValue<'a>>, &'a str),
    /// Members in document order (duplicates kept) and the object's source text.
    Obj(Vec<(Cow<'a, str>, JValue<'a>)>, &'a str),
}

impl<'a> JValue<'a> {
    /// The value as a label value: strings unescaped, other scalars as written, `null` as
    /// the empty string, arrays and objects as their source text.
    pub fn label_value(&self) -> String {
        match self {
            JValue::Null => String::new(),
            JValue::Bool(b) => b.to_string(),
            JValue::Num(n) => n.to_string(),
            JValue::Str(s) => s.to_string(),
            JValue::Arr(_, raw) | JValue::Obj(_, raw) => raw.to_string(),
        }
    }
}

pub struct Reader<'a> {
    s: &'a str,
    b: &'a [u8],
    i: usize,
}

pub fn parse(s: &str) -> Result<JValue<'_>, String> {
    let mut r = Reader { s, b: s.as_bytes(), i: 0 };
    r.ws();
    let v = r.value(0)?;
    r.ws();
    if r.i != r.b.len() {
        return Err(format!("unexpected character at offset {}", r.i));
    }
    Ok(v)
}

impl<'a> Reader<'a> {
    /// A reader positioned at byte `i` of `s`.
    pub fn with_pos(s: &'a str, i: usize) -> Self {
        Reader { s, b: s.as_bytes(), i }
    }

    pub fn pos(&self) -> usize {
        self.i
    }

    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Result<JValue<'a>, String> {
        if depth > MAX_DEPTH {
            return Err("document nested too deeply".into());
        }
        match self.b.get(self.i) {
            None => Err("unexpected end of input".into()),
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => Ok(JValue::Str(self.string()?)),
            Some(b't') => self.lit("true", JValue::Bool(true)),
            Some(b'f') => self.lit("false", JValue::Bool(false)),
            Some(b'n') => self.lit("null", JValue::Null),
            Some(c) if *c == b'-' || c.is_ascii_digit() => self.number(),
            Some(_) => Err(format!("unexpected character at offset {}", self.i)),
        }
    }

    fn lit(&mut self, w: &str, v: JValue<'a>) -> Result<JValue<'a>, String> {
        if self.s[self.i..].starts_with(w) {
            self.i += w.len();
            Ok(v)
        } else {
            Err(format!("invalid literal at offset {}", self.i))
        }
    }

    fn number(&mut self) -> Result<JValue<'a>, String> {
        let start = self.i;
        if self.b[self.i] == b'-' {
            self.i += 1;
        }
        let digits = |r: &mut Self| {
            let s = r.i;
            while r.i < r.b.len() && r.b[r.i].is_ascii_digit() {
                r.i += 1;
            }
            r.i - s
        };
        let int_start = self.i;
        let n = digits(self);
        if n == 0 || (n > 1 && self.b[int_start] == b'0') {
            return Err(format!("invalid number at offset {start}"));
        }
        if self.b.get(self.i) == Some(&b'.') {
            self.i += 1;
            if digits(self) == 0 {
                return Err(format!("invalid number at offset {start}"));
            }
        }
        if matches!(self.b.get(self.i), Some(b'e') | Some(b'E')) {
            self.i += 1;
            if matches!(self.b.get(self.i), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            if digits(self) == 0 {
                return Err(format!("invalid number at offset {start}"));
            }
        }
        Ok(JValue::Num(&self.s[start..self.i]))
    }

    pub fn string(&mut self) -> Result<Cow<'a, str>, String> {
        // self.b[self.i] == '"'
        self.i += 1;
        let start = self.i;
        // Fast path: no escapes.
        while self.i < self.b.len() {
            match self.b[self.i] {
                b'"' => {
                    let s = &self.s[start..self.i];
                    self.i += 1;
                    return Ok(Cow::Borrowed(s));
                }
                b'\\' => break,
                c if c < 0x20 => return Err(format!("control character in string at offset {}", self.i)),
                _ => self.i += 1,
            }
        }
        let mut out = String::from(&self.s[start..self.i]);
        while self.i < self.b.len() {
            let c = self.b[self.i];
            match c {
                b'"' => {
                    self.i += 1;
                    return Ok(Cow::Owned(out));
                }
                b'\\' => {
                    let e = *self.b.get(self.i + 1).ok_or("unterminated string")?;
                    self.i += 2;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let cp = self.hex4()?;
                            if (0xD800..0xDC00).contains(&cp) {
                                // A high surrogate: pair it with a following low one.
                                if self.s[self.i..].starts_with("\\u") {
                                    let save = self.i;
                                    self.i += 2;
                                    let lo = self.hex4()?;
                                    if (0xDC00..0xE000).contains(&lo) {
                                        let v = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                        out.push(char::from_u32(v).unwrap_or('\u{FFFD}'));
                                        continue;
                                    }
                                    self.i = save;
                                }
                                out.push('\u{FFFD}');
                            } else {
                                out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                            }
                        }
                        _ => return Err(format!("invalid escape at offset {}", self.i - 2)),
                    }
                }
                c if c < 0x20 => return Err(format!("control character in string at offset {}", self.i)),
                _ => {
                    // Copy one UTF-8 character.
                    let ch_len = utf8_len(c);
                    let end = (self.i + ch_len).min(self.b.len());
                    out.push_str(&self.s[self.i..end]);
                    self.i = end;
                }
            }
        }
        Err("unterminated string".into())
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let h = self.s.get(self.i..self.i + 4).ok_or("invalid unicode escape")?;
        let v = u32::from_str_radix(h, 16).map_err(|_| "invalid unicode escape".to_string())?;
        self.i += 4;
        Ok(v)
    }

    fn array(&mut self, depth: usize) -> Result<JValue<'a>, String> {
        let start = self.i;
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(JValue::Arr(items, &self.s[start..self.i]));
        }
        loop {
            self.ws();
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(JValue::Arr(items, &self.s[start..self.i]));
                }
                _ => return Err(format!("expected , or ] at offset {}", self.i)),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<JValue<'a>, String> {
        let start = self.i;
        self.i += 1;
        let mut members = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(JValue::Obj(members, &self.s[start..self.i]));
        }
        loop {
            self.ws();
            if self.b.get(self.i) != Some(&b'"') {
                return Err(format!("expected a key at offset {}", self.i));
            }
            let k = self.string()?;
            self.ws();
            if self.b.get(self.i) != Some(&b':') {
                return Err(format!("expected : at offset {}", self.i));
            }
            self.i += 1;
            self.ws();
            let v = self.value(depth + 1)?;
            members.push((k, v));
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(JValue::Obj(members, &self.s[start..self.i]));
                }
                _ => return Err(format!("expected , or }} at offset {}", self.i)),
            }
        }
    }
}

fn utf8_len(b: u8) -> usize {
    match b {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

/// A JSON path expression as the `json` parser's parameters accept them: field access
/// (`a.b`, `a["b"]`) and array access (`list[0]`), in any combination.
#[derive(Debug, Clone, PartialEq)]
pub struct JsonPath(pub Vec<PathPart>);

#[derive(Debug, Clone, PartialEq)]
pub enum PathPart {
    Key(String),
    Index(usize),
}

impl JsonPath {
    pub fn parse(s: &str) -> Result<JsonPath, String> {
        let cs: Vec<char> = s.chars().collect();
        let mut parts = Vec::new();
        let mut i = 0;
        let mut expect_key = true;
        let err = || format!("invalid json expression {s:?}");
        while i < cs.len() {
            match cs[i] {
                '.' => {
                    if expect_key {
                        return Err(err());
                    }
                    i += 1;
                    expect_key = true;
                }
                '[' => {
                    i += 1;
                    if i < cs.len() && cs[i] == '"' {
                        i += 1;
                        let mut k = String::new();
                        while i < cs.len() && cs[i] != '"' {
                            if cs[i] == '\\' && i + 1 < cs.len() {
                                i += 1;
                            }
                            k.push(cs[i]);
                            i += 1;
                        }
                        if i + 1 >= cs.len() || cs[i + 1] != ']' {
                            return Err(err());
                        }
                        i += 2;
                        parts.push(PathPart::Key(k));
                    } else {
                        let mut n = String::new();
                        while i < cs.len() && cs[i].is_ascii_digit() {
                            n.push(cs[i]);
                            i += 1;
                        }
                        if n.is_empty() || i >= cs.len() || cs[i] != ']' {
                            return Err(err());
                        }
                        i += 1;
                        parts.push(PathPart::Index(n.parse().map_err(|_| err())?));
                    }
                    expect_key = false;
                }
                _ => {
                    if !expect_key {
                        return Err(err());
                    }
                    let mut k = String::new();
                    while i < cs.len() && cs[i] != '.' && cs[i] != '[' {
                        k.push(cs[i]);
                        i += 1;
                    }
                    parts.push(PathPart::Key(k));
                    expect_key = false;
                }
            }
        }
        if parts.is_empty() || (expect_key && !parts.is_empty()) {
            return Err(err());
        }
        Ok(JsonPath(parts))
    }

    /// The value at this path, if any. With duplicate keys the first wins.
    #[cfg(test)]
    pub fn get<'v, 'a>(&self, v: &'v JValue<'a>) -> Option<&'v JValue<'a>> {
        let mut cur = v;
        for p in &self.0 {
            cur = match (p, cur) {
                (PathPart::Key(k), JValue::Obj(m, _)) => &m.iter().find(|(mk, _)| mk == k)?.1,
                (PathPart::Index(n), JValue::Arr(a, _)) => a.get(*n)?,
                _ => return None,
            };
        }
        Some(cur)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_values_with_source_text() {
        let v = parse(r#"{"a": {"b": [1, 2.50, "x\u00e9\n"]}, "c": null, "d": true}"#).unwrap();
        let p = JsonPath::parse("a.b[1]").unwrap();
        assert_eq!(p.get(&v).unwrap().label_value(), "2.50");
        let p = JsonPath::parse("a[\"b\"]").unwrap();
        assert_eq!(p.get(&v).unwrap().label_value(), "[1, 2.50, \"x\\u00e9\\n\"]");
        let p = JsonPath::parse("a.b[2]").unwrap();
        assert_eq!(p.get(&v).unwrap().label_value(), "xé\n");
        assert!(JsonPath::parse("a..b").is_err());
        assert!(JsonPath::parse("a[x]").is_err());
    }

    #[test]
    fn rejects_bad_documents() {
        for bad in ["{", "{\"a\":}", "[1,]", "01", "\"\\q\"", "{\"a\":1}x", "tru"] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        let deep = "[".repeat(1000) + &"]".repeat(1000);
        assert!(parse(&deep).is_err());
        assert!(parse(r#""\ud83d\ude00""#).unwrap() == JValue::Str("😀".into()));
    }
}
