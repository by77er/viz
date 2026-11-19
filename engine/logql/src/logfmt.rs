//! The `logfmt` parser: `key=value` pairs separated by whitespace, values optionally
//! double-quoted. Without `--strict` a malformed pair is skipped and scanning continues;
//! with it, scanning stops at the first malformed pair with an error. Pairs with an empty
//! value and standalone keys are dropped unless `--keep-empty` is given.

pub struct Pair<'a> {
    pub key: &'a str,
    pub value: std::borrow::Cow<'a, str>,
    /// `key` alone (no `=`) or `key=` with nothing after it.
    pub empty: bool,
}

/// Scan a line. Returns the pairs found and, in strict mode, the error that stopped the scan
/// (`logfmt syntax error at pos N : …`, with `N` counted from 1).
pub fn scan(line: &str, strict: bool) -> (Vec<Pair<'_>>, Option<String>) {
    let b = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let n = b.len();
    let ws = |c: u8| c <= b' ';
    let err = |pos: usize, msg: &str| Some(format!("logfmt syntax error at pos {} : {msg}", pos + 1));
    'outer: while i < n {
        while i < n && ws(b[i]) {
            i += 1;
        }
        if i >= n {
            break;
        }
        // Key.
        let ks = i;
        while i < n && !ws(b[i]) && b[i] != b'=' && b[i] != b'"' {
            i += 1;
        }
        if i < n && b[i] == b'"' {
            if strict {
                return (out, err(i, "unexpected '\"'"));
            }
            skip_token(b, &mut i);
            continue;
        }
        if i == ks {
            // A key cannot start with '='.
            if strict {
                return (out, err(i, "unexpected '='"));
            }
            skip_token(b, &mut i);
            continue;
        }
        let key = &line[ks..i];
        if i >= n || ws(b[i]) {
            out.push(Pair { key, value: "".into(), empty: true });
            continue;
        }
        // b[i] == '='
        i += 1;
        if i >= n || ws(b[i]) {
            out.push(Pair { key, value: "".into(), empty: true });
            continue;
        }
        if b[i] == b'"' {
            let vs = i;
            i += 1;
            let mut escaped = false;
            while i < n {
                if escaped {
                    escaped = false;
                } else if b[i] == b'\\' {
                    escaped = true;
                } else if b[i] == b'"' {
                    break;
                }
                i += 1;
            }
            if i >= n {
                if strict {
                    return (out, err(n, "unterminated quoted value"));
                }
                break 'outer;
            }
            i += 1;
            let raw = &line[vs..i];
            if i < n && !ws(b[i]) {
                if strict {
                    return (out, err(i, &format!("unexpected '{}'", b[i] as char)));
                }
                skip_token(b, &mut i);
                continue;
            }
            match unquote(raw) {
                Some(v) => {
                    let empty = v.is_empty();
                    out.push(Pair { key, value: v.into(), empty });
                }
                None => {
                    if strict {
                        return (out, err(vs, "invalid quoted value"));
                    }
                }
            }
            continue;
        }
        let vs = i;
        while i < n && !ws(b[i]) {
            if b[i] == b'=' || b[i] == b'"' {
                if strict {
                    return (out, err(i, &format!("unexpected '{}'", b[i] as char)));
                }
                skip_token(b, &mut i);
                continue 'outer;
            }
            i += 1;
        }
        out.push(Pair { key, value: line[vs..i].into(), empty: false });
    }
    (out, None)
}

fn skip_token(b: &[u8], i: &mut usize) {
    while *i < b.len() && b[*i] > b' ' {
        *i += 1;
    }
}

/// Unquote a double-quoted value with JSON-style escapes.
fn unquote(raw: &str) -> Option<String> {
    let inner = &raw[1..raw.len() - 1];
    if !inner.contains('\\') {
        return Some(inner.to_string());
    }
    let mut out = String::with_capacity(inner.len());
    let mut it = inner.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next()? {
            '"' => out.push('"'),
            '\\' => out.push('\\'),
            '/' => out.push('/'),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'u' => {
                let h: String = (0..4).filter_map(|_| it.next()).collect();
                let v = u32::from_str_radix(&h, 16).ok()?;
                out.push(char::from_u32(v).unwrap_or('\u{FFFD}'));
            }
            _ => return None,
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(line: &str, strict: bool) -> (Vec<(String, String)>, Option<String>) {
        let (p, e) = scan(line, strict);
        (p.into_iter().filter(|p| !p.empty).map(|p| (p.key.to_string(), p.value.into_owned())).collect(), e)
    }

    #[test]
    fn documented_and_observed_lines() {
        let (k, e) = keys(r#"at=info method=GET path=/ host=grafana.net fwd="124.133.124.161" service=8ms status=200"#, false);
        assert!(e.is_none());
        assert_eq!(k.len(), 7);
        assert_eq!(k[4], ("fwd".into(), "124.133.124.161".into()));
        let (k, e) = keys("a=b c=d =x e=f", true);
        assert_eq!(k.len(), 2);
        assert_eq!(e.unwrap(), "logfmt syntax error at pos 9 : unexpected '='");
        let (k, _) = keys("a=b c=d =x e=f", false);
        assert_eq!(k.len(), 3);
        let (_, e) = keys("k=\"unterminated v=1", true);
        assert_eq!(e.unwrap(), "logfmt syntax error at pos 20 : unterminated quoted value");
        let (_, e) = keys(r#"{"a":"b"}"#, true);
        assert_eq!(e.unwrap(), "logfmt syntax error at pos 2 : unexpected '\"'");
    }
}
