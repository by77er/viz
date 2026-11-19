//! Printing values the way Go's `fmt` package documents it, for template output and
//! `printf`: `%v` of each kind, `Sprint` spacing, and the verbs `%s %v %d %f %F %e %E %g
//! %G %q %x %X %o %b %c %t %%` with flags `-+# 0`, width and precision.

use super::value::V;

/// `strconv.FormatFloat(f, 'g', -1, 64)` as `%v` prints a float: the shortest digits that
/// round-trip, in exponent form when the decimal exponent is < -4 or >= 6 (Go uses
/// precision 6 for that decision when printing the shortest form).
pub fn float_v(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "+Inf".into() } else { "-Inf".into() };
    }
    if f == 0.0 {
        return if f.is_sign_negative() { "-0".into() } else { "0".into() };
    }
    // Shortest round-trip digits via Rust's `{:e}` (also shortest).
    let e = format!("{:e}", f);
    let (mant, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let neg = mant.starts_with('-');
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    if exp < -4 || exp >= 6 {
        let mut s = String::new();
        if neg {
            s.push('-');
        }
        s.push_str(&digits[..1]);
        if digits.len() > 1 {
            s.push('.');
            s.push_str(&digits[1..]);
        }
        s.push('e');
        s.push(if exp < 0 { '-' } else { '+' });
        let a = exp.unsigned_abs();
        if a < 10 {
            s.push('0');
        }
        s.push_str(&a.to_string());
        return s;
    }
    let mut s = String::new();
    if neg {
        s.push('-');
    }
    let dp = exp + 1; // digits before the decimal point
    if dp <= 0 {
        s.push_str("0.");
        for _ in 0..(-dp) {
            s.push('0');
        }
        s.push_str(&digits);
    } else if dp as usize >= digits.len() {
        s.push_str(&digits);
        for _ in 0..(dp as usize - digits.len()) {
            s.push('0');
        }
    } else {
        s.push_str(&digits[..dp as usize]);
        s.push('.');
        s.push_str(&digits[dp as usize..]);
    }
    s
}

/// `%v` of a value.
pub fn value_v(v: &V) -> String {
    match v {
        V::Str(s) => s.to_string(),
        V::Int(i) => i.to_string(),
        V::Float(f) => float_v(*f),
        V::Bool(b) => b.to_string(),
        V::Nil => "<nil>".into(),
        V::NoValue => "<no value>".into(),
        V::Time(t) => super::gotime::time_string(*t),
        V::List(l) => {
            let parts: Vec<String> = l.iter().map(value_v).collect();
            format!("[{}]", parts.join(" "))
        }
        V::Map(m) => {
            let parts: Vec<String> = m.iter().map(|(k, v)| format!("{k}:{}", value_v(v))).collect();
            format!("map[{}]", parts.join(" "))
        }
    }
}

/// `fmt.Sprint`: operands joined, with a space between two operands when neither is a string.
pub fn sprint(args: &[V]) -> String {
    let mut out = String::new();
    for (i, a) in args.iter().enumerate() {
        if i > 0 && !matches!(a, V::Str(_)) && !matches!(args[i - 1], V::Str(_)) {
            out.push(' ');
        }
        out.push_str(&value_v(a));
    }
    out
}

/// `fmt.Sprintln` without the trailing newline: operands always separated by spaces.
pub fn sprintln(args: &[V]) -> String {
    let parts: Vec<String> = args.iter().map(value_v).collect();
    parts.join(" ") + "\n"
}

/// `strconv.Quote`.
pub fn go_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{7}' => out.push_str("\\a"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\u{b}' => out.push_str("\\v"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c if c == '\u{FFFD}' => out.push_str("\\ufffd"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

struct Spec {
    minus: bool,
    plus: bool,
    sharp: bool,
    space: bool,
    zero: bool,
    width: Option<usize>,
    prec: Option<usize>,
}

fn pad(s: String, sp: &Spec, numeric: bool) -> String {
    let Some(w) = sp.width else { return s };
    let len = s.chars().count();
    if len >= w {
        return s;
    }
    let n = w - len;
    if sp.minus {
        return s + &" ".repeat(n);
    }
    if sp.zero && numeric {
        // Zeros go after the sign.
        let (sign, rest) = if s.starts_with(['-', '+', ' ']) { s.split_at(1) } else { ("", s.as_str()) };
        return format!("{sign}{}{rest}", "0".repeat(n));
    }
    " ".repeat(n) + &s
}

fn sign(s: String, neg: bool, sp: &Spec) -> String {
    if neg {
        format!("-{s}")
    } else if sp.plus {
        format!("+{s}")
    } else if sp.space {
        format!(" {s}")
    } else {
        s
    }
}

fn fmt_exp(f: f64, prec: usize, upper: bool) -> String {
    let s = format!("{:.*e}", prec, f.abs());
    let (m, e) = s.split_once('e').unwrap_or((&s, "0"));
    let e: i32 = e.parse().unwrap_or(0);
    let es = format!("{}{}{:02}", if upper { 'E' } else { 'e' }, if e < 0 { '-' } else { '+' }, e.unsigned_abs());
    format!("{m}{es}")
}

fn fmt_float(f: f64, verb: char, sp: &Spec) -> String {
    if f.is_nan() || f.is_infinite() {
        let s = if f.is_nan() { "NaN".to_string() } else if f > 0.0 { if sp.plus { "+Inf".into() } else { "Inf".into() } } else { "-Inf".into() };
        return pad(s, &Spec { zero: false, ..*sp }, false);
    }
    let neg = f.is_sign_negative() && f != 0.0;
    let body = match verb {
        'f' | 'F' => format!("{:.*}", sp.prec.unwrap_or(6), f.abs()),
        'e' | 'E' => fmt_exp(f, sp.prec.unwrap_or(6), verb == 'E'),
        _ => match sp.prec {
            None => float_v(f.abs()),
            Some(p) => {
                let p = p.max(1);
                let exp = if f == 0.0 { 0 } else { f.abs().log10().floor() as i32 };
                if exp < -4 || exp >= p as i32 {
                    let s = fmt_exp(f, p - 1, verb == 'G');
                    trim_exp_zeros(&s)
                } else {
                    let decimals = (p as i32 - 1 - exp).max(0) as usize;
                    let s = format!("{:.*}", decimals, f.abs());
                    if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s }
                }
            }
        },
    };
    pad(sign(body, neg, sp), sp, true)
}

fn trim_exp_zeros(s: &str) -> String {
    let (m, e) = s.split_once(['e', 'E']).unwrap_or((s, ""));
    let m = if m.contains('.') { m.trim_end_matches('0').trim_end_matches('.') } else { m };
    let ech = if s.contains('E') { 'E' } else { 'e' };
    format!("{m}{ech}{e}")
}

fn fmt_int(i: i128, verb: char, sp: &Spec) -> String {
    let neg = i < 0;
    let a = i.unsigned_abs();
    let mut body = match verb {
        'x' => format!("{a:x}"),
        'X' => format!("{a:X}"),
        'o' => format!("{a:o}"),
        'b' => format!("{a:b}"),
        _ => a.to_string(),
    };
    if let Some(p) = sp.prec {
        while body.len() < p {
            body.insert(0, '0');
        }
    }
    if sp.sharp {
        match verb {
            'x' => body.insert_str(0, "0x"),
            'X' => body.insert_str(0, "0X"),
            'o' => body.insert(0, '0'),
            _ => {}
        }
    }
    pad(sign(body, neg, sp), &Spec { zero: sp.zero && sp.prec.is_none(), ..*sp }, true)
}

/// `fmt.Sprintf` for the verbs listed in the module comment.
pub fn sprintf(format: &str, args: &[V]) -> String {
    let mut out = String::new();
    let cs: Vec<char> = format.chars().collect();
    let mut i = 0;
    let mut ai = 0;
    while i < cs.len() {
        if cs[i] != '%' {
            out.push(cs[i]);
            i += 1;
            continue;
        }
        i += 1;
        let mut sp = Spec { minus: false, plus: false, sharp: false, space: false, zero: false, width: None, prec: None };
        while i < cs.len() {
            match cs[i] {
                '-' => sp.minus = true,
                '+' => sp.plus = true,
                '#' => sp.sharp = true,
                ' ' => sp.space = true,
                '0' => sp.zero = !sp.minus,
                _ => break,
            }
            i += 1;
        }
        let num = |i: &mut usize| -> Option<usize> {
            let s = *i;
            while *i < cs.len() && cs[*i].is_ascii_digit() {
                *i += 1;
            }
            if *i > s {
                cs[s..*i].iter().collect::<String>().parse().ok()
            } else {
                None
            }
        };
        sp.width = num(&mut i);
        if i < cs.len() && cs[i] == '.' {
            i += 1;
            sp.prec = Some(num(&mut i).unwrap_or(0));
        }
        let Some(&verb) = cs.get(i) else {
            out.push_str("%!(NOVERB)");
            break;
        };
        i += 1;
        if verb == '%' {
            out.push('%');
            continue;
        }
        let Some(arg) = args.get(ai) else {
            out.push_str(&format!("%!{verb}(MISSING)"));
            continue;
        };
        ai += 1;
        let s = match (verb, arg) {
            ('v', _) | ('s', V::Str(_)) => {
                let mut s = value_v(arg);
                if verb == 's' {
                    if let Some(p) = sp.prec {
                        s = s.chars().take(p).collect();
                    }
                }
                if let (V::Float(f), 'v') = (arg, verb) {
                    fmt_float(*f, 'g', &sp)
                } else if let (V::Int(n), 'v') = (arg, verb) {
                    fmt_int(*n as i128, 'd', &sp)
                } else {
                    pad(s, &sp, false)
                }
            }
            ('s', V::Int(_) | V::Float(_) | V::Bool(_)) => format!("%!s({})", type_and_value(arg)),
            ('s', _) => {
                let mut s = value_v(arg);
                if let Some(p) = sp.prec {
                    s = s.chars().take(p).collect();
                }
                pad(s, &sp, false)
            }
            ('d' | 'x' | 'X' | 'o' | 'b', V::Int(n)) => fmt_int(*n as i128, verb, &sp),
            ('x' | 'X', V::Str(s)) => {
                let h: String = s.bytes().map(|b| if verb == 'x' { format!("{b:02x}") } else { format!("{b:02X}") }).collect();
                pad(h, &sp, false)
            }
            ('f' | 'F' | 'e' | 'E' | 'g' | 'G', V::Float(f)) => fmt_float(*f, verb, &sp),
            ('q', V::Str(s)) => pad(go_quote(s), &sp, false),
            ('t', V::Bool(b)) => pad(b.to_string(), &sp, false),
            ('c', V::Int(n)) => pad(char::from_u32(*n as u32).unwrap_or('\u{FFFD}').to_string(), &sp, false),
            _ => format!("%!{verb}({})", type_and_value(arg)),
        };
        out.push_str(&s);
    }
    if ai < args.len() {
        let extra: Vec<String> = args[ai..].iter().map(type_and_value).collect();
        out.push_str(&format!("%!(EXTRA {})", extra.join(", ")));
    }
    out
}

fn type_and_value(v: &V) -> String {
    let t = match v {
        V::Str(_) => "string",
        V::Int(_) => "int64",
        V::Float(_) => "float64",
        V::Bool(_) => "bool",
        V::Time(_) => "time.Time",
        V::Nil | V::NoValue => return "<nil>".into(),
        V::List(_) => "[]interface {}",
        V::Map(_) => "map[string]interface {}",
    };
    format!("{t}={}", value_v(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_print_like_go() {
        assert_eq!(float_v(3.5), "3.5");
        assert_eq!(float_v(1e6), "1e+06");
        assert_eq!(float_v(123456.0), "123456");
        assert_eq!(float_v(1234567.0), "1.234567e+06");
        assert_eq!(float_v(0.0001), "0.0001");
        assert_eq!(float_v(0.00001), "1e-05");
        assert_eq!(float_v(124.0), "124");
        assert_eq!(float_v(-2.5), "-2.5");
    }

    #[test]
    fn printf_verbs() {
        let s = |x: &str| V::Str(x.into());
        assert_eq!(sprintf("The IP address was %s", &[s("1.2.3.4")]), "The IP address was 1.2.3.4");
        assert_eq!(sprintf("%-5.5s|", &[s("GETTING")]), "GETTI|");
        assert_eq!(sprintf("%15.15s", &[s("abc")]), "            abc");
        assert_eq!(sprintf("%05d %x %.2f %v", &[V::Int(42), V::Int(255), V::Float(3.14159), V::Float(2.0)]), "00042 ff 3.14 2");
        assert_eq!(sprintf("%d", &[s("x")]), "%!d(string=x)");
        assert_eq!(sprintf("%q", &[s("a\"b")]), "\"a\\\"b\"");
        assert_eq!(sprintf("%s %s", &[s("a")]), "a %!s(MISSING)");
        assert_eq!(sprintf("%e", &[V::Float(1234.5)]), "1.234500e+03");
    }
}
