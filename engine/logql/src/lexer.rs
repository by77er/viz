//! Tokens of LogQL, written from the LogQL documentation (query, log queries, metric
//! queries). Positions are byte offsets into the query text; errors report line and
//! column from them.

use crate::error::Error;
use crate::text::unquote_go;

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    LBrace,
    RBrace,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    /// `=`
    Eq,
    /// `!=`
    Neq,
    /// `=~`
    Re,
    /// `!~`
    Nre,
    /// `|=`
    PipeExact,
    /// `|~`
    PipeMatch,
    /// `|>`
    PipePattern,
    /// `!>`
    NotPattern,
    /// `|`
    Pipe,
    /// `==`
    EqEq,
    Gt,
    Gte,
    Lt,
    Lte,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    /// A name: label names, keywords and function names alike; the parser decides.
    Ident(String),
    /// A string literal, already unquoted.
    Str(String),
    /// A number literal and its text.
    Number(f64, String),
    /// A literal with a duration or byte-size suffix (`5m`, `1h30m`, `20KB`), as written.
    Unit(String),
    /// `--strict`, `--keep-empty`.
    Flag(String),
    Eof,
}

impl Tok {
    pub fn describe(&self) -> String {
        match self {
            Tok::Ident(s) => format!("IDENTIFIER {s:?}"),
            Tok::Str(s) => format!("STRING {s:?}"),
            Tok::Number(_, t) => format!("NUMBER {t}"),
            Tok::Unit(t) => format!("DURATION or BYTES {t}"),
            Tok::Flag(f) => format!("flag {f}"),
            Tok::Eof => "end of input".to_string(),
            other => format!("{:?}", symbol(other)),
        }
    }
}

fn symbol(t: &Tok) -> &'static str {
    match t {
        Tok::LBrace => "{",
        Tok::RBrace => "}",
        Tok::LParen => "(",
        Tok::RParen => ")",
        Tok::LBracket => "[",
        Tok::RBracket => "]",
        Tok::Comma => ",",
        Tok::Eq => "=",
        Tok::Neq => "!=",
        Tok::Re => "=~",
        Tok::Nre => "!~",
        Tok::PipeExact => "|=",
        Tok::PipeMatch => "|~",
        Tok::PipePattern => "|>",
        Tok::NotPattern => "!>",
        Tok::Pipe => "|",
        Tok::EqEq => "==",
        Tok::Gt => ">",
        Tok::Gte => ">=",
        Tok::Lt => "<",
        Tok::Lte => "<=",
        Tok::Add => "+",
        Tok::Sub => "-",
        Tok::Mul => "*",
        Tok::Div => "/",
        Tok::Mod => "%",
        Tok::Pow => "^",
        _ => "?",
    }
}

#[derive(Debug, Clone)]
pub struct Token {
    pub tok: Tok,
    /// Byte offset of the first character.
    pub pos: usize,
}

/// Line and column (both from 1, column in characters) of byte offset `pos`.
pub fn line_col(src: &str, pos: usize) -> (usize, usize) {
    let mut line = 1;
    let mut col = 1;
    for (i, c) in src.char_indices() {
        if i >= pos {
            break;
        }
        if c == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

pub fn parse_error(src: &str, pos: usize, msg: impl Into<String>) -> Error {
    let (line, col) = line_col(src, pos);
    Error::Parse { msg: msg.into(), line, col }
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == ':'
}

/// Units accepted after a number: Go/Prometheus duration units and byte-size units.
const UNIT_CHARS: &[char] = &['n', 's', 'u', 'µ', 'm', 'h', 'd', 'w', 'y', 'k', 'K', 'M', 'G', 'T', 'P', 'E', 'B', 'i', 'b'];

pub fn lex(src: &str) -> Result<Vec<Token>, Error> {
    let bytes: Vec<(usize, char)> = src.char_indices().collect();
    let n = bytes.len();
    let mut out = Vec::new();
    let mut i = 0;
    let at = |k: usize| -> Option<char> { bytes.get(k).map(|x| x.1) };
    while i < n {
        let (pos, c) = bytes[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '#' {
            while i < n && bytes[i].1 != '\n' {
                i += 1;
            }
            continue;
        }
        let two = |a: char, b: char| c == a && at(i + 1) == Some(b);
        let (tok, len) = if two('|', '=') {
            (Tok::PipeExact, 2)
        } else if two('|', '~') {
            (Tok::PipeMatch, 2)
        } else if two('|', '>') {
            (Tok::PipePattern, 2)
        } else if two('!', '>') {
            (Tok::NotPattern, 2)
        } else if two('!', '=') {
            (Tok::Neq, 2)
        } else if two('!', '~') {
            (Tok::Nre, 2)
        } else if two('=', '~') {
            (Tok::Re, 2)
        } else if two('=', '=') {
            (Tok::EqEq, 2)
        } else if two('>', '=') {
            (Tok::Gte, 2)
        } else if two('<', '=') {
            (Tok::Lte, 2)
        } else if two('-', '-') && at(i + 2).is_some_and(is_ident_start) {
            let mut j = i + 2;
            while j < n && (is_ident_char(bytes[j].1) || bytes[j].1 == '-') {
                j += 1;
            }
            let text: String = bytes[i..j].iter().map(|x| x.1).collect();
            out.push(Token { tok: Tok::Flag(text), pos });
            i = j;
            continue;
        } else {
            let t = match c {
                '{' => Tok::LBrace,
                '}' => Tok::RBrace,
                '(' => Tok::LParen,
                ')' => Tok::RParen,
                '[' => Tok::LBracket,
                ']' => Tok::RBracket,
                ',' => Tok::Comma,
                '=' => Tok::Eq,
                '|' => Tok::Pipe,
                '>' => Tok::Gt,
                '<' => Tok::Lt,
                '+' => Tok::Add,
                '-' => Tok::Sub,
                '*' => Tok::Mul,
                '/' => Tok::Div,
                '%' => Tok::Mod,
                '^' => Tok::Pow,
                '"' | '`' => {
                    let (s, j) = lex_string(src, &bytes, i)?;
                    out.push(Token { tok: Tok::Str(s), pos });
                    i = j;
                    continue;
                }
                c if c.is_ascii_digit() || (c == '.' && at(i + 1).is_some_and(|d| d.is_ascii_digit())) => {
                    let j = lex_number(&bytes, i);
                    let text: String = bytes[i..j].iter().map(|x| x.1).collect();
                    // A unit suffix makes it a duration or byte size: `5m`, `1h30m`, `20KB`, `1.5KiB`.
                    if j < n && UNIT_CHARS.contains(&bytes[j].1) {
                        let mut k = j;
                        while k < n && (bytes[k].1.is_ascii_alphanumeric() || bytes[k].1 == '.' || bytes[k].1 == 'µ') {
                            k += 1;
                        }
                        let text: String = bytes[i..k].iter().map(|x| x.1).collect();
                        out.push(Token { tok: Tok::Unit(text), pos });
                        i = k;
                        continue;
                    }
                    if j < n && is_ident_char(bytes[j].1) {
                        return Err(parse_error(src, pos, format!("syntax error: unexpected character in number {text:?}")));
                    }
                    let v = parse_number(&text).ok_or_else(|| parse_error(src, pos, format!("syntax error: invalid number {text:?}")))?;
                    out.push(Token { tok: Tok::Number(v, text), pos });
                    i = j;
                    continue;
                }
                c if is_ident_start(c) => {
                    let mut j = i;
                    while j < n && is_ident_char(bytes[j].1) {
                        j += 1;
                    }
                    let text: String = bytes[i..j].iter().map(|x| x.1).collect();
                    out.push(Token { tok: Tok::Ident(text), pos });
                    i = j;
                    continue;
                }
                other => return Err(parse_error(src, pos, format!("syntax error: unexpected character {other:?}"))),
            };
            (t, 1)
        };
        out.push(Token { tok, pos });
        i += len;
    }
    out.push(Token { tok: Tok::Eof, pos: src.len() });
    Ok(out)
}

fn lex_number(bytes: &[(usize, char)], start: usize) -> usize {
    let n = bytes.len();
    let mut j = start;
    if bytes[j].1 == '0' && j + 1 < n && (bytes[j + 1].1 == 'x' || bytes[j + 1].1 == 'X') {
        j += 2;
        while j < n && bytes[j].1.is_ascii_hexdigit() {
            j += 1;
        }
        return j;
    }
    while j < n && bytes[j].1.is_ascii_digit() {
        j += 1;
    }
    if j < n && bytes[j].1 == '.' {
        j += 1;
        while j < n && bytes[j].1.is_ascii_digit() {
            j += 1;
        }
    }
    // Exponent: only when followed by digits (so `1e` is not swallowed).
    if j < n && (bytes[j].1 == 'e' || bytes[j].1 == 'E') {
        let mut k = j + 1;
        if k < n && (bytes[k].1 == '+' || bytes[k].1 == '-') {
            k += 1;
        }
        if k < n && bytes[k].1.is_ascii_digit() {
            while k < n && bytes[k].1.is_ascii_digit() {
                k += 1;
            }
            j = k;
        }
    }
    j
}

pub fn parse_number(text: &str) -> Option<f64> {
    if let Some(h) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return u64::from_str_radix(h, 16).ok().map(|v| v as f64);
    }
    text.parse::<f64>().ok()
}

fn lex_string(src: &str, bytes: &[(usize, char)], start: usize) -> Result<(String, usize), Error> {
    let quote = bytes[start].1;
    let n = bytes.len();
    let mut j = start + 1;
    if quote == '`' {
        while j < n && bytes[j].1 != '`' {
            j += 1;
        }
        if j >= n {
            return Err(parse_error(src, bytes[start].0, "syntax error: unterminated raw string"));
        }
        let s: String = bytes[start + 1..j].iter().map(|x| x.1).collect();
        return Ok((s, j + 1));
    }
    while j < n {
        match bytes[j].1 {
            '\\' => j += 2,
            '"' => break,
            '\n' => return Err(parse_error(src, bytes[start].0, "syntax error: newline in string")),
            _ => j += 1,
        }
    }
    if j >= n {
        return Err(parse_error(src, bytes[start].0, "syntax error: unterminated quoted string"));
    }
    let raw = &src[bytes[start].0..bytes[j].0 + 1];
    let s = unquote_go(raw).map_err(|e| parse_error(src, bytes[start].0, format!("syntax error: {e}")))?;
    Ok((s, j + 1))
}
