//! LogQL regular expressions use Go's RE2 syntax. This module translates the parts of it
//! whose meaning differs in Rust's `regex` crate before compiling: Go's `\d`, `\w`, `\s`
//! and `\b` are ASCII-only (Rust's are Unicode-aware), and Go accepts `\Q…\E` literal
//! quoting and octal escapes, which Rust does not. Everything else is passed through;
//! both are linear-time engines with the same core syntax.

use regex::Regex;

const DIGIT: &str = "0-9";
const WORD: &str = "0-9A-Za-z_";
const SPACE: &str = "\\t\\n\\x0C\\r ";

/// Translate a Go regular expression into Rust `regex` syntax.
pub fn translate(p: &str) -> Result<String, String> {
    let cs: Vec<char> = p.chars().collect();
    let mut out = String::with_capacity(p.len() + 16);
    let mut i = 0;
    let mut in_class = false;
    let mut class_start = false;
    while i < cs.len() {
        let c = cs[i];
        if c == '\\' {
            let Some(&e) = cs.get(i + 1) else {
                return Err("trailing backslash at end of expression".into());
            };
            i += 2;
            match e {
                'd' | 'w' | 's' => {
                    let body = match e {
                        'd' => DIGIT,
                        'w' => WORD,
                        _ => SPACE,
                    };
                    if in_class {
                        out.push_str(body);
                    } else {
                        out.push('[');
                        out.push_str(body);
                        out.push(']');
                    }
                }
                'D' | 'W' | 'S' => {
                    let body = match e {
                        'D' => DIGIT,
                        'W' => WORD,
                        _ => SPACE,
                    };
                    out.push_str("[^");
                    out.push_str(body);
                    out.push(']');
                }
                'b' if !in_class => out.push_str("(?-u:\\b)"),
                'B' if !in_class => out.push_str("(?-u:\\B)"),
                'Q' => {
                    // Literal text up to `\E` or the end.
                    let mut lit = String::new();
                    while i < cs.len() {
                        if cs[i] == '\\' && cs.get(i + 1) == Some(&'E') {
                            i += 2;
                            break;
                        }
                        lit.push(cs[i]);
                        i += 1;
                    }
                    for ch in lit.chars() {
                        if in_class {
                            if matches!(ch, '\\' | ']' | '[' | '^' | '-' | '&' | '~') {
                                out.push('\\');
                            }
                            out.push(ch);
                        } else {
                            out.push_str(&regex::escape(&ch.to_string()));
                        }
                    }
                }
                'E' => {}
                '0'..='7' => {
                    // Octal: up to three digits.
                    let mut v = e.to_digit(8).unwrap_or(0);
                    let mut k = 0;
                    while k < 2 && i < cs.len() && cs[i].is_digit(8) {
                        v = v * 8 + cs[i].to_digit(8).unwrap_or(0);
                        i += 1;
                        k += 1;
                    }
                    out.push_str(&format!("\\x{{{v:X}}}"));
                }
                'x' | 'p' | 'P' => {
                    out.push('\\');
                    out.push(e);
                    // Copy a braced argument verbatim.
                    if cs.get(i) == Some(&'{') {
                        while i < cs.len() {
                            out.push(cs[i]);
                            i += 1;
                            if cs[i - 1] == '}' {
                                break;
                            }
                        }
                    }
                }
                _ => {
                    out.push('\\');
                    out.push(e);
                }
            }
            class_start = false;
            continue;
        }
        if in_class {
            if c == '[' && cs.get(i + 1) == Some(&':') {
                // POSIX class `[:alpha:]`: copy through the closing `:]`.
                let rest: String = cs[i..].iter().collect();
                if let Some(end) = rest.find(":]") {
                    out.push_str(&rest[..end + 2]);
                    i += rest[..end + 2].chars().count();
                    class_start = false;
                    continue;
                }
            }
            if c == ']' && !class_start {
                in_class = false;
                out.push(']');
                i += 1;
                continue;
            }
            // Characters Rust treats as class set operators or nested classes, literal in Go.
            if matches!(c, '[' | '&' | '~') || (c == '-' && cs.get(i + 1) == Some(&'-')) {
                out.push('\\');
                out.push(c);
                i += 1;
                class_start = false;
                continue;
            }
            if c == '^' && class_start && out.ends_with('[') {
                out.push('^');
                i += 1;
                continue; // still at the class start: a following `]` is literal
            }
            out.push(c);
            class_start = false;
            i += 1;
            continue;
        }
        if c == '[' {
            in_class = true;
            class_start = true;
            out.push('[');
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    Ok(out)
}

fn build(p: &str) -> Result<Regex, String> {
    regex::RegexBuilder::new(p).size_limit(16 << 20).build().map_err(|e| {
        let s = e.to_string();
        s.lines().last().unwrap_or(&s).trim().to_string()
    })
}

/// Fully anchored, as label matchers are (`^(?:re)$`). `.` matches a newline (`(?s)`),
/// as in the Prometheus label matchers Loki uses.
pub fn compile_anchored(p: &str) -> Result<Regex, String> {
    build(&format!("^(?s:{})$", translate(p)?))
}

/// Unanchored, as line filters and template functions use them. With `dot_nl`, `.`
/// matches a newline too (line filters, per the documentation).
pub fn compile_unanchored(p: &str, dot_nl: bool) -> Result<Regex, String> {
    let t = translate(p)?;
    if dot_nl {
        build(&format!("(?s:{t})"))
    } else {
        build(&t)
    }
}

/// Unanchored, Go's default flags, keeping capture group names (regexp parser, templates).
pub fn compile_plain(p: &str) -> Result<Regex, String> {
    build(&translate(p)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_classes() {
        let r = compile_plain(r"^\w+$").unwrap();
        assert!(r.is_match("abc_1"));
        assert!(!r.is_match("é"));
        let r = compile_plain(r"^[\w-]+$").unwrap();
        assert!(r.is_match("a-b"));
        assert!(!r.is_match("aé"));
        let r = compile_plain(r"\bfoo\b").unwrap();
        assert!(r.is_match("a foo b"));
        let r = compile_plain(r"^\d\D\s\S$").unwrap();
        assert!(r.is_match("1a b"));
        assert!(!r.is_match("١a b"));
    }

    #[test]
    fn go_only_syntax() {
        let r = compile_plain(r"\Qa.b\E+").unwrap();
        assert!(r.is_match("a.bb"));
        assert!(!r.is_match("axb"));
        let r = compile_plain(r"\101").unwrap();
        assert!(r.is_match("A"));
        let r = compile_plain(r"[[:alpha:]]+[a&&]").unwrap();
        assert!(r.is_match("ab&"));
        let r = compile_plain(r"[]a]").unwrap();
        assert!(r.is_match("]"));
        let r = compile_plain(r"[^]a]").unwrap();
        assert!(r.is_match("b"));
        assert!(!r.is_match("]"));
    }

    #[test]
    fn named_groups() {
        let r = compile_plain(r"(?P<a>\w+) (?<b>.*)").unwrap();
        let names: Vec<_> = r.capture_names().flatten().collect();
        assert_eq!(names, vec!["a", "b"]);
    }
}
