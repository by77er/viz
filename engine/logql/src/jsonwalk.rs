//! The `json` and `unpack` parsers walk a line as a stream of object members, so that the
//! members before a syntax error are still extracted, and report the error in the words
//! Loki's documentation and responses use for `__error_details__`. The error wording was
//! observed by running Loki (see CLEANROOM.md); the parsing rules are RFC 8259's, with
//! the leniencies observed there (a trailing comma before `}` is accepted).

use crate::json::{JsonPath, PathPart};

pub const E_OBJ: &str = "Value looks like object, but can't find closing '}' symbol";
pub const E_ARR: &str = "Value is array, but can't find closing ']' symbol";
pub const E_MAL: &str = "Malformed JSON error";
pub const E_UNK: &str = "Unknown value type";
pub const E_STR: &str = "Value is string, but can't find closing '\"' symbol";
pub const E_UNPACK: &str = "expecting json object(6), but it is not";

const MAX_DEPTH: usize = 128;

struct W<'a> {
    s: &'a str,
    b: &'a [u8],
    i: usize,
}

enum Scalar<'a> {
    Str(std::borrow::Cow<'a, str>),
    Raw(&'a str),
    Null,
    Obj,
    Arr,
}

impl<'a> W<'a> {
    fn new(s: &'a str) -> Self {
        W { s, b: s.as_bytes(), i: 0 }
    }
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    /// A key: an unterminated key is "malformed".
    fn key(&mut self) -> Result<std::borrow::Cow<'a, str>, &'static str> {
        self.string().map_err(|_| E_MAL)
    }

    fn string(&mut self) -> Result<std::borrow::Cow<'a, str>, &'static str> {
        let mut r = crate::json::Reader::with_pos(self.s, self.i);
        let v = r.string().map_err(|e| if e.contains("unterminated") { E_STR } else { E_MAL })?;
        self.i = r.pos();
        Ok(v)
    }

    /// Skip any value. `Err` with the kind of failure.
    fn skip_value(&mut self, depth: usize) -> Result<(), &'static str> {
        if depth > MAX_DEPTH {
            return Err(E_MAL);
        }
        self.ws();
        match self.peek() {
            None => Err(E_OBJ),
            Some(b'"') => self.string().map(|_| ()),
            Some(b'{') => {
                self.i += 1;
                loop {
                    self.ws();
                    match self.peek() {
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(());
                        }
                        Some(b'"') => {}
                        _ => return Err(E_OBJ),
                    }
                    self.key()?;
                    self.ws();
                    if self.peek() != Some(b':') {
                        return Err(E_MAL);
                    }
                    self.i += 1;
                    self.skip_value(depth + 1)?;
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(());
                        }
                        None => return Err(E_OBJ),
                        _ => return Err(E_MAL),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                loop {
                    self.ws();
                    match self.peek() {
                        Some(b']') => {
                            self.i += 1;
                            return Ok(());
                        }
                        None => return Err(E_ARR),
                        _ => {}
                    }
                    self.skip_value(depth + 1)?;
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(());
                        }
                        None => return Err(E_ARR),
                        _ => return Err(E_MAL),
                    }
                }
            }
            Some(_) => self.scalar_raw().map(|_| ()),
        }
    }

    /// true/false/null/number, as written.
    fn scalar_raw(&mut self) -> Result<&'a str, &'static str> {
        let s = self.i;
        let rest = &self.s[s..];
        for w in ["true", "false", "null"] {
            if rest.starts_with(w) {
                self.i += w.len();
                return Ok(&self.s[s..self.i]);
            }
        }
        let c = self.peek().unwrap_or(0);
        if c == b'-' || c.is_ascii_digit() {
            while self.i < self.b.len() && matches!(self.b[self.i], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E') {
                self.i += 1;
            }
            return Ok(&self.s[s..self.i]);
        }
        Err(E_UNK)
    }

    fn value(&mut self) -> Result<Scalar<'a>, &'static str> {
        self.ws();
        match self.peek() {
            None => Err(E_OBJ),
            Some(b'"') => Ok(Scalar::Str(self.string()?)),
            Some(b'{') => Ok(Scalar::Obj),
            Some(b'[') => {
                self.skip_value(0)?;
                Ok(Scalar::Arr)
            }
            Some(_) => {
                let r = self.scalar_raw()?;
                Ok(if r == "null" { Scalar::Null } else { Scalar::Raw(r) })
            }
        }
    }

    /// Walk the members of the object at `self.i` (which is `{`), calling `f` with each
    /// flattened key and scalar value.
    fn object(&mut self, prefix: &str, depth: usize, f: &mut dyn FnMut(&str, String)) -> Result<(), &'static str> {
        if depth > MAX_DEPTH {
            return Err(E_MAL);
        }
        self.i += 1;
        loop {
            self.ws();
            match self.peek() {
                Some(b'}') => {
                    self.i += 1;
                    return Ok(());
                }
                Some(b'"') => {}
                _ => return Err(E_OBJ),
            }
            let key = self.key()?;
            self.ws();
            if self.peek() != Some(b':') {
                return Err(E_MAL);
            }
            self.i += 1;
            // A key that is empty or only whitespace adds no segment to the flattened name.
            let full = if key.trim().is_empty() {
                prefix.to_string()
            } else if prefix.is_empty() {
                key.to_string()
            } else {
                format!("{prefix}_{key}")
            };
            match self.value()? {
                Scalar::Str(v) => {
                    if !full.is_empty() {
                        f(&full, v.into_owned());
                    }
                }
                Scalar::Raw(r) => {
                    if !full.is_empty() {
                        f(&full, r.to_string());
                    }
                }
                Scalar::Null | Scalar::Arr => {}
                Scalar::Obj => self.object(&full, depth + 1, f)?,
            }
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(());
                }
                None => return Err(E_ARR),
                _ => return Err(E_MAL),
            }
        }
    }
}

/// `| json` without parameters: every scalar member, nested keys joined with `_`, arrays
/// and nulls skipped. Returns the members extracted (raw keys) and the error, if any.
pub fn flatten(line: &str) -> (Vec<(String, String)>, Option<&'static str>) {
    let mut out = Vec::new();
    let mut w = W::new(line);
    w.ws();
    if w.peek() != Some(b'{') {
        return (out, Some(E_OBJ));
    }
    let r = w.object("", 0, &mut |k, v| out.push((k.to_string(), v)));
    (out, r.err())
}

/// `| unpack`: the string members of a top-level object; `_entry` replaces the line.
/// Labels are only produced when the object has a string `_entry`.
pub fn unpack(line: &str) -> Result<Option<(Vec<(String, String)>, String)>, &'static str> {
    if line.is_empty() {
        return Ok(None);
    }
    let mut w = W::new(line);
    if w.peek() != Some(b'{') {
        return Err(E_UNPACK);
    }
    w.i += 1;
    let mut labels = Vec::new();
    let mut entry: Option<String> = None;
    let mut entry_bad = false;
    loop {
        w.ws();
        match w.peek() {
            Some(b'}') => break,
            Some(b'"') => {}
            _ => return Err(E_OBJ),
        }
        let key = w.key()?;
        w.ws();
        if w.peek() != Some(b':') {
            return Err(E_MAL);
        }
        w.i += 1;
        w.ws();
        if w.peek() == Some(b'"') {
            let v = w.string()?;
            if key == "_entry" {
                entry = Some(v.into_owned());
            } else if !key.is_empty() {
                labels.push((key.into_owned(), v.into_owned()));
            }
        } else {
            if key == "_entry" {
                entry_bad = true;
            }
            w.skip_value(0)?;
        }
        w.ws();
        match w.peek() {
            Some(b',') => w.i += 1,
            Some(b'}') => break,
            None => return Err(E_ARR),
            _ => return Err(E_MAL),
        }
    }
    if entry_bad {
        return Ok(None);
    }
    Ok(entry.map(|e| (labels, e)))
}

/// `| json name="path"`: the value at `path`, `Ok(None)` when absent. Objects and arrays
/// come back as their text, strings unescaped, `null` as `""`.
pub fn get(line: &str, path: &JsonPath) -> Result<Option<String>, &'static str> {
    let mut w = W::new(line);
    for (n, part) in path.0.iter().enumerate() {
        w.ws();
        match part {
            PathPart::Key(k) => {
                if w.peek() != Some(b'{') {
                    return Ok(None);
                }
                w.i += 1;
                loop {
                    w.ws();
                    match w.peek() {
                        Some(b'"') => {}
                        _ => return Ok(None),
                    }
                    let key = match w.string() {
                        Ok(k) => k,
                        Err(_) => return Ok(None),
                    };
                    w.ws();
                    if w.peek() != Some(b':') {
                        return Ok(None);
                    }
                    w.i += 1;
                    if key == *k {
                        break;
                    }
                    if w.skip_value(0).is_err() {
                        return Ok(None);
                    }
                    w.ws();
                    match w.peek() {
                        Some(b',') => w.i += 1,
                        _ => return Ok(None),
                    }
                }
            }
            PathPart::Index(idx) => {
                if w.peek() != Some(b'[') {
                    return Ok(None);
                }
                w.i += 1;
                let mut k = 0;
                loop {
                    w.ws();
                    if w.peek() == Some(b']') || w.peek().is_none() {
                        return Ok(None);
                    }
                    if k == *idx {
                        break;
                    }
                    if w.skip_value(0).is_err() {
                        return Ok(None);
                    }
                    w.ws();
                    match w.peek() {
                        Some(b',') => w.i += 1,
                        _ => return Ok(None),
                    }
                    k += 1;
                }
            }
        }
        let _ = n;
    }
    w.ws();
    let start = w.i;
    match w.peek() {
        Some(b'"') => Ok(Some(w.string()?.into_owned())),
        Some(b'{') | Some(b'[') => {
            w.skip_value(0)?;
            Ok(Some(line[start..w.i].to_string()))
        }
        None => Err(E_OBJ),
        Some(_) => {
            let r = w.scalar_raw()?;
            Ok(Some(if r == "null" { String::new() } else { r.to_string() }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flatten_observed_lines() {
        let (l, e) = flatten(r#"{"a":"b", invalid}"#);
        assert_eq!(l, vec![("a".to_string(), "b".to_string())]);
        assert_eq!(e, Some(E_OBJ));
        assert_eq!(flatten(r#"{"a":tru}"#).1, Some(E_UNK));
        assert_eq!(flatten(r#"{"a" "b"}"#).1, Some(E_MAL));
        assert_eq!(flatten(r#"{"a":"b""#).1, Some(E_ARR));
        assert_eq!(flatten(r#"{"a":{"b":"#).1, Some(E_OBJ));
        assert_eq!(flatten(r#"{"a":1,}"#), (vec![("a".to_string(), "1".to_string())], None));
        assert_eq!(flatten("zzz").1, Some(E_OBJ));
        let (l, e) = flatten(r#"{"n":{"a":{"b":"c"}},"arr":[1,{"x":2}],"z":null,"f":1.0}"#);
        assert!(e.is_none());
        assert_eq!(l, vec![("n_a_b".to_string(), "c".to_string()), ("f".to_string(), "1.0".to_string())]);
    }

    #[test]
    fn unpack_observed_lines() {
        assert_eq!(unpack(r#"{"a":"b"}"#), Ok(None));
        assert_eq!(unpack(r#"{"a":"b","_entry":1}"#), Ok(None));
        assert_eq!(unpack(r#"{"a":"b","_entry":"x","n":5}"#), Ok(Some((vec![("a".into(), "b".into())], "x".into()))));
        assert_eq!(unpack(" {}"), Err(E_UNPACK));
        assert_eq!(unpack(""), Ok(None));
    }

    #[test]
    fn get_paths() {
        let p = |s: &str| JsonPath::parse(s).unwrap();
        let line = r#"{"a":"x\ty","b":[{"c":"d"}],"e":{"f":null,"g":false}}"#;
        assert_eq!(get(line, &p("b[0].c")), Ok(Some("d".into())));
        assert_eq!(get(line, &p("e")), Ok(Some(r#"{"f":null,"g":false}"#.into())));
        assert_eq!(get(line, &p("e.f")), Ok(Some("".into())));
        assert_eq!(get(line, &p("zz")), Ok(None));
        assert_eq!(get(r#"{"a":tru}"#, &p("a")), Err(E_UNK));
    }
}
