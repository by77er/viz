//! Text conversions LogQL inherits from Go: string literal unquoting (Go's quoted string
//! syntax, as `strconv.Unquote` documents it), Go duration strings (`time.ParseDuration`),
//! Prometheus duration literals, and human-readable byte sizes.

/// Unquote a Go double-quoted string literal (`"…"`, quotes included) or a raw string
/// (`` `…` ``).
pub fn unquote_go(s: &str) -> Result<String, String> {
    if let Some(inner) = s.strip_prefix('`').and_then(|x| x.strip_suffix('`')) {
        return Ok(inner.replace('\r', ""));
    }
    let inner = s
        .strip_prefix('"')
        .and_then(|x| x.strip_suffix('"'))
        .ok_or_else(|| "invalid syntax".to_string())?;
    let mut out: Vec<u8> = Vec::with_capacity(inner.len());
    let mut it = inner.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\\' {
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            continue;
        }
        let e = it.next().ok_or_else(|| "invalid syntax".to_string())?;
        let simple = match e {
            'a' => Some(7u8),
            'b' => Some(8),
            'f' => Some(12),
            'n' => Some(b'\n'),
            'r' => Some(b'\r'),
            't' => Some(b'\t'),
            'v' => Some(11),
            '\\' => Some(b'\\'),
            '"' => Some(b'"'),
            _ => None,
        };
        if let Some(b) = simple {
            out.push(b);
            continue;
        }
        match e {
            'x' => {
                let h: String = (0..2).filter_map(|_| it.next()).collect();
                let v = u8::from_str_radix(&h, 16).map_err(|_| "invalid syntax".to_string())?;
                if h.len() != 2 {
                    return Err("invalid syntax".into());
                }
                out.push(v);
            }
            '0'..='7' => {
                let mut o = String::from(e);
                for _ in 0..2 {
                    o.push(it.next().ok_or_else(|| "invalid syntax".to_string())?);
                }
                let v = u32::from_str_radix(&o, 8).map_err(|_| "invalid syntax".to_string())?;
                if v > 255 {
                    return Err("invalid syntax".into());
                }
                out.push(v as u8);
            }
            'u' | 'U' => {
                let len = if e == 'u' { 4 } else { 8 };
                let h: String = (0..len).filter_map(|_| it.next()).collect();
                if h.len() != len {
                    return Err("invalid syntax".into());
                }
                let v = u32::from_str_radix(&h, 16).map_err(|_| "invalid syntax".to_string())?;
                let ch = char::from_u32(v).ok_or_else(|| "invalid syntax".to_string())?;
                let mut buf = [0u8; 4];
                out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
            _ => return Err("invalid syntax".into()),
        }
    }
    String::from_utf8(out).map_err(|_| "invalid UTF-8 in string".to_string())
}

/// Go's `time.ParseDuration`: an optional sign, then one or more decimal numbers with an
/// optional fraction and a unit (`ns`, `us`, `µs`, `μs`, `ms`, `s`, `m`, `h`); `0` alone is
/// allowed. Returns nanoseconds.
pub fn parse_go_duration(s: &str) -> Option<i64> {
    let mut rest = s;
    let mut neg = false;
    if let Some(r) = rest.strip_prefix('-') {
        neg = true;
        rest = r;
    } else if let Some(r) = rest.strip_prefix('+') {
        rest = r;
    }
    if rest == "0" {
        return Some(0);
    }
    if rest.is_empty() {
        return None;
    }
    let mut total: u128 = 0;
    while !rest.is_empty() {
        // Integer part.
        let int_len = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
        let int_part = &rest[..int_len];
        rest = &rest[int_len..];
        let mut frac_part = "";
        if let Some(r) = rest.strip_prefix('.') {
            let fl = r.bytes().take_while(|b| b.is_ascii_digit()).count();
            frac_part = &r[..fl];
            rest = &r[fl..];
            if int_len == 0 && fl == 0 {
                return None;
            }
        } else if int_len == 0 {
            return None;
        }
        let unit_len = rest.char_indices().find(|(_, c)| c.is_ascii_digit() || *c == '.').map(|(i, _)| i).unwrap_or(rest.len());
        let unit = &rest[..unit_len];
        rest = &rest[unit_len..];
        let mult: u128 = match unit {
            "ns" => 1,
            "us" | "µs" | "μs" => 1_000,
            "ms" => 1_000_000,
            "s" => 1_000_000_000,
            "m" => 60_000_000_000,
            "h" => 3_600_000_000_000,
            _ => return None,
        };
        let iv: u128 = if int_part.is_empty() { 0 } else { int_part.parse::<u128>().ok()? };
        let mut v = iv.checked_mul(mult)?;
        if !frac_part.is_empty() {
            // Exact fraction times the unit, truncated, as Go does.
            let mut scale: u128 = 1;
            let mut fv: u128 = 0;
            for d in frac_part.bytes().take(30) {
                fv = fv * 10 + (d - b'0') as u128;
                scale *= 10;
            }
            v = v.checked_add(fv * mult / scale)?;
        }
        total = total.checked_add(v)?;
        if total > i64::MAX as u128 + u128::from(neg) {
            return None;
        }
    }
    let t = total as i128;
    Some(if neg { (-t) as i64 } else { t as i64 })
}

/// A Prometheus duration literal: unit groups `y w d h m s ms` in that order, integers only
/// (`1h30m`, `5m`, `90s`, `1d`). Returns nanoseconds.
pub fn parse_prom_duration(s: &str) -> Option<i64> {
    if s == "0" {
        return Some(0);
    }
    let units: [(&str, u128); 7] = [
        ("y", 365 * 24 * 3_600_000_000_000),
        ("w", 7 * 24 * 3_600_000_000_000),
        ("d", 24 * 3_600_000_000_000),
        ("h", 3_600_000_000_000),
        ("m", 60_000_000_000),
        ("s", 1_000_000_000),
        ("ms", 1_000_000),
    ];
    let mut rest = s;
    let mut next_unit = 0;
    let mut total: u128 = 0;
    if rest.is_empty() {
        return None;
    }
    while !rest.is_empty() {
        let dl = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
        if dl == 0 {
            return None;
        }
        let v: u128 = rest[..dl].parse().ok()?;
        rest = &rest[dl..];
        let ul = rest.bytes().take_while(|b| b.is_ascii_alphabetic()).count();
        let unit = &rest[..ul];
        rest = &rest[ul..];
        let idx = units.iter().position(|(u, _)| *u == unit)?;
        if idx < next_unit {
            return None;
        }
        next_unit = idx + 1;
        total = total.checked_add(v.checked_mul(units[idx].1)?)?;
    }
    i64::try_from(total).ok()
}

/// Human-readable byte sizes as the `go-humanize` library's `ParseBytes` reads them: a
/// decimal number (commas ignored), optional spaces, and an optional unit, case-insensitive:
/// `b`, SI `k kb m mb g gb t tb p pb e eb` (powers of 1000) and IEC `ki kib mi mib …`
/// (powers of 1024).
pub fn parse_bytes(s: &str) -> Option<f64> {
    let digits = s.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',').count();
    let num: String = s.chars().take(digits).filter(|c| *c != ',').collect();
    let f: f64 = go_parse_float(&num)?;
    let rest: String = s.chars().skip(digits).collect();
    let unit = rest.trim().to_ascii_lowercase();
    let m: f64 = match unit.as_str() {
        "" | "b" => 1.0,
        "k" | "kb" => 1e3,
        "m" | "mb" => 1e6,
        "g" | "gb" => 1e9,
        "t" | "tb" => 1e12,
        "p" | "pb" => 1e15,
        "e" | "eb" => 1e18,
        "ki" | "kib" => 1024.0,
        "mi" | "mib" => 1024.0 * 1024.0,
        "gi" | "gib" => 1024.0 * 1024.0 * 1024.0,
        "ti" | "tib" => 1024f64.powi(4),
        "pi" | "pib" => 1024f64.powi(5),
        "ei" | "eib" => 1024f64.powi(6),
        _ => return None,
    };
    let v = f * m;
    if v >= u64::MAX as f64 {
        return None;
    }
    Some((v as u64) as f64)
}

/// `strconv.ParseFloat(s, 64)` for the forms that matter here: decimal and exponent
/// notation, `inf`/`infinity`/`nan` in any case with an optional sign, underscores not
/// accepted. Returns `None` where Go returns an error (out-of-range values are an error
/// in Go too, with ±Inf; they are reported as `None`).
pub fn go_parse_float(s: &str) -> Option<f64> {
    if s.is_empty() {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    let body = lower.trim_start_matches(['+', '-']);
    if lower.len() - body.len() > 1 {
        return None;
    }
    match body {
        "inf" | "infinity" => {
            return Some(if lower.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY });
        }
        "nan" => return Some(f64::NAN),
        _ => {}
    }
    if body.starts_with("0x") {
        return None;
    }
    if !body.bytes().all(|b| b.is_ascii_digit() || b == b'.' || b == b'e' || b == b'+' || b == b'-') {
        return None;
    }
    let v: f64 = s.parse().ok()?;
    if v.is_infinite() {
        return None;
    }
    Some(v)
}

/// Go's `strconv.FormatFloat(v, 'f', -1, 64)`: the shortest decimal that round-trips,
/// never an exponent.
pub fn format_float_f(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "+Inf".into() } else { "-Inf".into() };
    }
    viz_promql::format_float(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn go_durations() {
        assert_eq!(parse_go_duration("1.5h"), Some(5_400_000_000_000));
        assert_eq!(parse_go_duration("2h45m"), Some(9_900_000_000_000));
        assert_eq!(parse_go_duration("300ms"), Some(300_000_000));
        assert_eq!(parse_go_duration("0.10ms"), Some(100_000));
        assert_eq!(parse_go_duration("1µs"), Some(1_000));
        assert_eq!(parse_go_duration("-1s"), Some(-1_000_000_000));
        assert_eq!(parse_go_duration("0"), Some(0));
        assert_eq!(parse_go_duration("1"), None);
        assert_eq!(parse_go_duration("1d"), None);
        assert_eq!(parse_go_duration(""), None);
        assert_eq!(parse_go_duration(".s"), None);
    }

    #[test]
    fn prom_durations() {
        assert_eq!(parse_prom_duration("1d"), Some(86_400_000_000_000));
        assert_eq!(parse_prom_duration("1h30m"), Some(5_400_000_000_000));
        assert_eq!(parse_prom_duration("30m1h"), None);
    }

    #[test]
    fn byte_sizes() {
        assert_eq!(parse_bytes("83KB"), Some(83_000.0));
        assert_eq!(parse_bytes("83KiB"), Some(84_992.0));
        assert_eq!(parse_bytes("5 MiB"), Some(5_242_880.0));
        assert_eq!(parse_bytes("1.5KiB"), Some(1536.0));
        assert_eq!(parse_bytes("20B"), Some(20.0));
        assert_eq!(parse_bytes("3k"), Some(3000.0));
        assert_eq!(parse_bytes("1G"), Some(1e9));
        assert_eq!(parse_bytes("12"), Some(12.0));
        assert_eq!(parse_bytes("x"), None);
        assert_eq!(parse_bytes("1XB"), None);
    }

    #[test]
    fn unquote() {
        assert_eq!(unquote_go(r#""a\n\"b\" é \x41 \101""#).unwrap(), "a\n\"b\" é A A");
        assert_eq!(unquote_go("`a\\nb`").unwrap(), "a\\nb");
        assert!(unquote_go(r#""\q""#).is_err());
    }
}
