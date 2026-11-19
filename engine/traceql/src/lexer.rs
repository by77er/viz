//! Hand-written lexer for TraceQL, written from Tempo's public language documentation.
//!
//! Some tokens are context-dependent in the language: `>`/`<`/`!~` are comparisons inside
//! `{ }` and structural operators between spansets. The lexer emits one token for each and
//! the parser decides.

use crate::Error;

#[derive(Clone, Debug, PartialEq)]
pub enum Tok {
    LBrace,
    RBrace,
    LParen,
    RParen,
    Comma,
    Pipe,
    AndAnd,
    OrOr,
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
    Re,
    /// `!~`: negated regex inside a filter, not-sibling between spansets.
    NRe,
    Not,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    /// `>>`
    Desc,
    /// `<<`
    Anc,
    /// `~`
    Tilde,
    /// `&>>` `&<<` `&>` `&<` `&~`
    UDesc,
    UAnc,
    UChild,
    UParent,
    USibling,
    /// `!>>` `!<<` `!>` `!<`
    NDesc,
    NAnc,
    NChild,
    NParent,
    /// An integer literal's magnitude (a leading `-` is a separate token).
    Int(u64),
    Float(f64),
    /// Nanoseconds.
    Duration(i64),
    Str(String),
    Ident(String),
    /// `scope.name`, `.name`, `parent.scope.name`: (parent, scope, name). `scope` is "" when
    /// unscoped.
    Attr(bool, String, String),
    /// `scope:name`
    Intrinsic(String, String),
    Eof,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    pub tok: Tok,
    pub pos: usize,
    pub end: usize,
}

pub const SCOPES: [&str; 5] = ["span", "resource", "event", "link", "instrumentation"];

/// Characters that end an unquoted attribute name (besides whitespace).
fn attr_terminal(c: char) -> bool {
    matches!(
        c,
        '{' | '}' | '(' | ')' | '=' | '~' | '!' | '<' | '>' | '&' | '|' | '^' | ',' | '"' | '+' | '-' | '*' | '/'
            | '%'
    ) || c.is_whitespace()
}

pub fn lex(src: &str) -> Result<Vec<Token>, Error> {
    let mut lx = Lexer { src, pos: 0, out: Vec::new() };
    lx.run()?;
    Ok(lx.out)
}

struct Lexer<'a> {
    src: &'a str,
    pos: usize,
    out: Vec<Token>,
}

impl<'a> Lexer<'a> {
    fn peek(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }
    fn peek_at(&self, n: usize) -> Option<char> {
        self.src[self.pos..].chars().nth(n)
    }
    fn starts(&self, s: &str) -> bool {
        self.src[self.pos..].starts_with(s)
    }
    fn push(&mut self, tok: Tok, start: usize) {
        self.out.push(Token { tok, pos: start, end: self.pos });
    }
    fn err(&self, pos: usize, msg: impl Into<String>) -> Error {
        Error::parse(self.src, pos, msg)
    }

    fn run(&mut self) -> Result<(), Error> {
        loop {
            while let Some(c) = self.peek() {
                if c.is_whitespace() {
                    self.pos += c.len_utf8();
                } else {
                    break;
                }
            }
            let start = self.pos;
            let Some(c) = self.peek() else {
                self.push(Tok::Eof, start);
                return Ok(());
            };
            // Multi-character operators, longest first.
            const OPS: [(&str, Tok); 30] = [
                ("&>>", Tok::UDesc),
                ("&<<", Tok::UAnc),
                ("!>>", Tok::NDesc),
                ("!<<", Tok::NAnc),
                ("&&", Tok::AndAnd),
                ("||", Tok::OrOr),
                ("&>", Tok::UChild),
                ("&<", Tok::UParent),
                ("&~", Tok::USibling),
                ("!>", Tok::NChild),
                ("!<", Tok::NParent),
                ("!=", Tok::Neq),
                ("!~", Tok::NRe),
                ("=~", Tok::Re),
                (">>", Tok::Desc),
                ("<<", Tok::Anc),
                (">=", Tok::Gte),
                ("<=", Tok::Lte),
                ("{", Tok::LBrace),
                ("}", Tok::RBrace),
                ("(", Tok::LParen),
                (")", Tok::RParen),
                (",", Tok::Comma),
                ("|", Tok::Pipe),
                ("=", Tok::Eq),
                ("<", Tok::Lt),
                (">", Tok::Gt),
                ("!", Tok::Not),
                ("~", Tok::Tilde),
                ("^", Tok::Caret),
            ];
            let mut matched = false;
            for (s, t) in OPS.iter() {
                if self.starts(s) {
                    self.pos += s.len();
                    self.push(t.clone(), start);
                    matched = true;
                    break;
                }
            }
            if matched {
                continue;
            }
            match c {
                '+' => {
                    self.pos += 1;
                    self.push(Tok::Plus, start)
                }
                '-' => {
                    self.pos += 1;
                    self.push(Tok::Minus, start)
                }
                '*' => {
                    self.pos += 1;
                    self.push(Tok::Star, start)
                }
                '/' => {
                    self.pos += 1;
                    self.push(Tok::Slash, start)
                }
                '%' => {
                    self.pos += 1;
                    self.push(Tok::Percent, start)
                }
                '"' | '`' => {
                    let s = self.string(c)?;
                    self.push(Tok::Str(s), start)
                }
                '.' => {
                    if self.peek_at(1).is_some_and(|d| d.is_ascii_digit()) {
                        self.number(start)?;
                    } else {
                        self.pos += 1;
                        let name = self.attr_name(start)?;
                        self.push(Tok::Attr(false, String::new(), name), start);
                    }
                }
                c if c.is_ascii_digit() => self.number(start)?,
                c if c.is_alphabetic() || c == '_' => self.ident(start)?,
                _ => return Err(self.err(start, format!("unexpected character {c:?}"))),
            }
        }
    }

    fn ident(&mut self, start: usize) -> Result<(), Error> {
        while let Some(c) = self.peek() {
            if c.is_alphanumeric() || c == '_' {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
        let word = self.src[start..self.pos].to_string();
        match self.peek() {
            Some('.') if word == "parent" => {
                // parent.<scope>.<name>
                self.pos += 1;
                let s2 = self.pos;
                while let Some(c) = self.peek() {
                    if c.is_alphanumeric() || c == '_' {
                        self.pos += c.len_utf8();
                    } else {
                        break;
                    }
                }
                let scope = self.src[s2..self.pos].to_string();
                if self.peek() == Some('.') && SCOPES.contains(&scope.as_str()) {
                    self.pos += 1;
                    let name = self.attr_name(start)?;
                    self.push(Tok::Attr(true, scope, name), start);
                    Ok(())
                } else {
                    // parent.<name>: an unscoped attribute of the parent span.
                    self.pos = s2;
                    let name = self.attr_name(start)?;
                    self.push(Tok::Attr(true, String::new(), name), start);
                    Ok(())
                }
            }
            Some('.') if SCOPES.contains(&word.as_str()) => {
                self.pos += 1;
                let name = self.attr_name(start)?;
                self.push(Tok::Attr(false, word, name), start);
                Ok(())
            }
            Some(':') if SCOPES.contains(&word.as_str()) || word == "trace" => {
                self.pos += 1;
                let s2 = self.pos;
                while let Some(c) = self.peek() {
                    if c.is_alphanumeric() || c == '_' {
                        self.pos += c.len_utf8();
                    } else {
                        break;
                    }
                }
                let name = self.src[s2..self.pos].to_string();
                if name.is_empty() {
                    return Err(self.err(start, format!("missing intrinsic name after {word}:")));
                }
                self.push(Tok::Intrinsic(word, name), start);
                Ok(())
            }
            _ => {
                self.push(Tok::Ident(word), start);
                Ok(())
            }
        }
    }

    /// An attribute name after `scope.` or `.`: unquoted runs and quoted parts, joined by dots.
    fn attr_name(&mut self, start: usize) -> Result<String, Error> {
        let mut name = String::new();
        loop {
            match self.peek() {
                Some('"') => {
                    let q = self.quoted_attr()?;
                    name.push_str(&q);
                }
                Some(c) if !attr_terminal(c) => {
                    while let Some(c) = self.peek() {
                        if attr_terminal(c) {
                            break;
                        }
                        name.push(c);
                        self.pos += c.len_utf8();
                    }
                }
                _ => break,
            }
            // A quoted part may be followed by `.` and more parts; an unquoted run already
            // consumed its dots.
            if self.peek() == Some('"') && name.ends_with('.') {
                continue;
            }
            break;
        }
        if name.is_empty() {
            return Err(self.err(start, "missing attribute name"));
        }
        Ok(name)
    }

    fn quoted_attr(&mut self) -> Result<String, Error> {
        let start = self.pos;
        self.pos += 1;
        let mut out = String::new();
        loop {
            match self.peek() {
                None => return Err(self.err(start, "unterminated quoted attribute name")),
                Some('"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some('\\') => {
                    self.pos += 1;
                    match self.peek() {
                        Some('"') => out.push('"'),
                        Some('\\') => out.push('\\'),
                        _ => return Err(self.err(self.pos - 1, "only \\\" and \\\\ escapes are allowed in attribute names")),
                    }
                    self.pos += 1;
                }
                Some(c) => {
                    out.push(c);
                    self.pos += c.len_utf8();
                }
            }
        }
    }

    fn string(&mut self, q: char) -> Result<String, Error> {
        let start = self.pos;
        self.pos += 1;
        let mut out = String::new();
        loop {
            let Some(c) = self.peek() else {
                return Err(self.err(start, "unterminated string"));
            };
            self.pos += c.len_utf8();
            if c == q {
                return Ok(out);
            }
            if c == '\\' && q == '"' {
                let Some(e) = self.peek() else {
                    return Err(self.err(start, "unterminated string"));
                };
                self.pos += e.len_utf8();
                match e {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    'a' => out.push('\u{7}'),
                    'b' => out.push('\u{8}'),
                    'f' => out.push('\u{c}'),
                    'v' => out.push('\u{b}'),
                    '\\' => out.push('\\'),
                    '"' => out.push('"'),
                    '\'' => out.push('\''),
                    'x' => {
                        let v = self.hex_digits(2, start)?;
                        // Go's \x escape is a byte; only ASCII is representable in a Rust string.
                        if v > 0x7f {
                            return Err(Error::unsupported("non-ASCII \\x escape in a string"));
                        }
                        out.push(char::from(v as u8));
                    }
                    'u' => out.push(self.code_point(4, start)?),
                    'U' => out.push(self.code_point(8, start)?),
                    '0'..='7' => {
                        let mut v = e.to_digit(8).unwrap_or(0);
                        for _ in 0..2 {
                            match self.peek().and_then(|d| d.to_digit(8)) {
                                Some(d) => {
                                    v = v * 8 + d;
                                    self.pos += 1;
                                }
                                None => return Err(self.err(start, "invalid octal escape")),
                            }
                        }
                        if v > 0x7f {
                            return Err(Error::unsupported("non-ASCII octal escape in a string"));
                        }
                        out.push(char::from(v as u8));
                    }
                    _ => return Err(self.err(self.pos - 2, format!("invalid escape \\{e}"))),
                }
            } else if c == '\n' && q == '"' {
                return Err(self.err(start, "newline in string"));
            } else {
                out.push(c);
            }
        }
    }

    fn hex_digits(&mut self, n: usize, start: usize) -> Result<u32, Error> {
        let mut v = 0u32;
        for _ in 0..n {
            match self.peek().and_then(|d| d.to_digit(16)) {
                Some(d) => {
                    v = v.wrapping_mul(16).wrapping_add(d);
                    self.pos += 1;
                }
                None => return Err(self.err(start, "invalid hex escape")),
            }
        }
        Ok(v)
    }

    fn code_point(&mut self, n: usize, start: usize) -> Result<char, Error> {
        let v = self.hex_digits(n, start)?;
        char::from_u32(v).ok_or_else(|| self.err(start, "invalid unicode escape"))
    }

    fn number(&mut self, start: usize) -> Result<(), Error> {
        let mut is_float = false;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.pos += 1;
        }
        if self.peek() == Some('.') && self.peek_at(1).is_some_and(|c| c.is_ascii_digit()) {
            is_float = true;
            self.pos += 1;
            while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some('e' | 'E'))
            && (self.peek_at(1).is_some_and(|c| c.is_ascii_digit())
                || (matches!(self.peek_at(1), Some('+' | '-')) && self.peek_at(2).is_some_and(|c| c.is_ascii_digit())))
        {
            is_float = true;
            self.pos += 2;
            while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        // Duration units directly after the number: 100ms, 1.5s, 1h30m.
        if self.peek().is_some_and(|c| c.is_alphabetic()) {
            let mut end = self.pos;
            for c in self.src[self.pos..].chars() {
                if c.is_alphanumeric() || c == '.' {
                    end += c.len_utf8();
                } else {
                    break;
                }
            }
            let text = &self.src[start..end];
            match parse_duration(text) {
                Some(ns) => {
                    self.pos = end;
                    self.push(Tok::Duration(ns), start);
                    return Ok(());
                }
                None => return Err(self.err(start, format!("invalid duration {text:?}"))),
            }
        }
        let text = &self.src[start..self.pos];
        if is_float {
            let v: f64 = text.parse().map_err(|_| self.err(start, format!("invalid number {text:?}")))?;
            self.push(Tok::Float(v), start);
        } else {
            match text.parse::<u64>() {
                Ok(v) => self.push(Tok::Int(v), start),
                Err(_) => return Err(self.err(start, format!("integer out of range {text:?}"))),
            }
        }
        Ok(())
    }
}

/// Go-style duration: a sequence of decimal numbers with units, `1h30m`, `1.5s`, `100ms`.
pub fn parse_duration(s: &str) -> Option<i64> {
    let mut rest = s;
    let mut total: f64 = 0.0;
    let mut exact: i128 = 0;
    let mut all_int = true;
    if rest.is_empty() {
        return None;
    }
    while !rest.is_empty() {
        let num_end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
        if num_end == 0 {
            return None;
        }
        let num = &rest[..num_end];
        rest = &rest[num_end..];
        let unit_end = rest.find(|c: char| c.is_ascii_digit() || c == '.').unwrap_or(rest.len());
        let unit = &rest[..unit_end];
        rest = &rest[unit_end..];
        let mult: i128 = match unit {
            "ns" => 1,
            "us" | "µs" | "μs" => 1_000,
            "ms" => 1_000_000,
            "s" => 1_000_000_000,
            "m" => 60_000_000_000,
            "h" => 3_600_000_000_000,
            _ => return None,
        };
        if num.contains('.') {
            all_int = false;
            let v: f64 = num.parse().ok()?;
            total += v * mult as f64;
        } else {
            let v: i128 = num.parse().ok()?;
            exact = exact.checked_add(v.checked_mul(mult)?)?;
            total += (v * mult) as f64;
        }
    }
    if all_int {
        i64::try_from(exact).ok()
    } else {
        let v = total + 0.0;
        if !(v.is_finite()) || v > i64::MAX as f64 {
            return None;
        }
        Some(v as i64)
    }
}
