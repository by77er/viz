//! Go's regular expressions (RE2 syntax, Go's `regexp` package) on Rust's `regex` crate.
//!
//! TraceQL and LogQL both define their regular expressions as Go's, and Tempo and Loki compile
//! them with Go's `regexp`. Both engines are linear-time with nearly the same syntax, but they
//! differ in places that change answers or acceptance. [`translate`] parses a Go pattern,
//! refuses what Go refuses, and writes a Rust pattern that matches what Go matches:
//!
//! - `\d \w \s \b \B` (and `\D \W \S`) are ASCII-only in Go, Unicode-aware in Rust: they become
//!   explicit ASCII classes. Go's `\s` is `[\t\n\f\r ]` (no `\v`).
//! - Go-only syntax is translated: `\Q…\E`, octal escapes (`\101`, `\0`), escaped punctuation
//!   that Rust reads differently (`\<` and `\>` are literals in Go, word boundaries in Rust), a
//!   `{` that does not start a valid repetition (a literal in Go: `x{,5}`, `a\b{start}`),
//!   `[`, `&&`, `~~` and `--` inside a class (literals in Go; nesting and set operations in
//!   Rust), repeated and cancelled flags (`(?ii)`, `(?i-i)`), an empty flag group `(?)`, a
//!   repetition after an empty construct (`a(?i)*` repeats `a`), repeated assertions (`^*`),
//!   and surrogate code points (`\x{D800}` matches U+FFFD in Go).
//! - Syntax Rust accepts and Go refuses is refused: flags other than `i m s U`, `\u`/`\U`/`\e`
//!   and other unknown escapes, a single-digit octal (`\1`, a back-reference), stacked
//!   repetitions (`a**`, `x{2}{3}`, `x*??`), counts above 1000 including nested counts whose
//!   product exceeds 1000 (`(?:a{10}){101}`), an invalid POSIX class name, `\Q` or `\b` inside a
//!   class, a range ending in a class (`[a-\d]`), and unbalanced parentheses (which must not
//!   become valid when a caller wraps the pattern in an anchoring group).
//! - Unicode classes (`\pL`, `\p{Greek}`, `\P…`) are not translated: Go and Rust differ in the
//!   names they accept and in what a script name means (Rust's `\p{Greek}` is the Script
//!   Extensions property), so [`Error::Unsupported`] is returned rather than a different match.
//!
//! The rules come from Go's `regexp/syntax` documentation and from black-box runs of Go's
//! `regexp` and of Tempo v3.1.1 (`README.md`, `CLEANROOM.md`). The translator is a single
//! left-to-right pass with an explicit stack (no recursion over the pattern) and linear time.

use regex::{Regex, RegexBuilder};
use std::fmt;

/// Why a pattern was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// Go refuses the pattern, or it does not compile within the limits.
    Invalid(String),
    /// Valid in Go but not translated (Unicode classes).
    Unsupported(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Invalid(m) | Error::Unsupported(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for Error {}

impl From<Error> for String {
    fn from(e: Error) -> String {
        e.to_string()
    }
}

/// Go's bound on counted repetitions: `x{n,m}` with `n` or `m` above it, or nested counts whose
/// product is above it, are refused.
pub const MAX_REPEAT: u32 = 1000;

/// How often one atom may be wrapped to repeat it again (`a*(?i)*(?i)*…`): each wrap nests it a
/// level deeper, and Go refuses nesting deeper than about 1000 (observed: 999 stacked stars
/// accepted, 1000 refused). The `regex` crate's nesting limit refuses such patterns far
/// earlier; this bounds the translator's own work (each wrap moves the atom's text).
const MAX_WRAPS: u32 = 1000;

const DIGIT: &str = "0-9";
const WORD: &str = "0-9A-Za-z_";
const SPACE: &str = "\\t\\n\\x0C\\r ";
/// The ASCII classes Go accepts as `[:name:]` (Rust accepts the same names).
const POSIX: [&str; 14] =
    ["alnum", "alpha", "ascii", "blank", "cntrl", "digit", "graph", "lower", "print", "punct", "space", "upper", "word", "xdigit"];
/// A class that matches nothing (a class item made only of surrogate code points).
const NOTHING: &str = "[^\\x{0}-\\x{10FFFF}]";

/// Translates a Go regular expression into Rust `regex` syntax with the same meaning.
///
/// With `names`, named groups keep their names (`(?P<n>…)`; Go's `(?<n>…)` too); without, every
/// group is a plain capture, which suits callers that only match (Go accepts names Rust does
/// not, such as `1` or a repeated name).
pub fn translate(p: &str, names: bool) -> Result<String, Error> {
    Translator::new(p, names).run()
}

/// How [`compile`] places the translated pattern.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wrap {
    /// As written: unanchored, `.` does not match `\n` (Go's defaults).
    Plain,
    /// Unanchored, `.` matches `\n`: `(?s:…)`.
    DotNl,
    /// Fully anchored, `.` matches `\n`: `^(?s:…)$`, as TraceQL's `=~` and label matchers.
    Anchored,
}

/// Limits the compiled regex is built with (the `regex` crate's builder options).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Compiled program size.
    pub size: usize,
    /// Lazy-DFA cache.
    pub dfa_size: usize,
    /// Nesting, as the `regex` parser counts it in the final pattern (wrapping included).
    pub nest: u32,
}

impl Default for Limits {
    /// 16 MiB compiled, the `regex` crate's own defaults otherwise (2 MiB cache, 250 levels).
    fn default() -> Limits {
        Limits { size: 16 << 20, dfa_size: 2 << 20, nest: 250 }
    }
}

/// Translates `p` ([`translate`]), wraps it, and compiles it within `limits`.
pub fn compile(p: &str, wrap: Wrap, names: bool, limits: &Limits) -> Result<Regex, Error> {
    let t = translate(p, names)?;
    let full = match wrap {
        Wrap::Plain => t,
        Wrap::DotNl => format!("(?s:{t})"),
        Wrap::Anchored => format!("^(?s:{t})$"),
    };
    RegexBuilder::new(&full)
        .size_limit(limits.size)
        .dfa_size_limit(limits.dfa_size)
        .nest_limit(limits.nest)
        .build()
        .map_err(|e| {
            // The last line names the problem; the lines above quote the translated pattern.
            let s = e.to_string();
            Error::Invalid(s.lines().last().unwrap_or(&s).trim().to_string())
        })
}

/// Fully anchored, `.` matching a newline, as label matchers are (`^(?s:re)$`); names kept;
/// default limits. (LogQL's matchers and label filters.)
pub fn compile_anchored(p: &str) -> Result<Regex, String> {
    Ok(compile(p, Wrap::Anchored, true, &Limits::default())?)
}

/// Unanchored, as line filters and template functions use them; with `dot_nl`, `.` matches a
/// newline too. Names kept; default limits.
pub fn compile_unanchored(p: &str, dot_nl: bool) -> Result<Regex, String> {
    Ok(compile(p, if dot_nl { Wrap::DotNl } else { Wrap::Plain }, true, &Limits::default())?)
}

/// Unanchored with Go's default flags, names kept (LogQL's `regexp` parser and templates).
pub fn compile_plain(p: &str) -> Result<Regex, String> {
    Ok(compile(p, Wrap::Plain, true, &Limits::default())?)
}

/// The last atom written at the current level, which a repetition operator applies to.
struct Atom {
    /// Byte offset in the output where it starts.
    start: usize,
    /// The largest product of counted repetitions on any path inside it (Go's bound).
    product: u32,
    /// A repetition operator has been applied to it.
    repeated: bool,
    /// An empty-width assertion (`^ $ \A \z \b \B`), which Rust repeats only inside a group.
    assertion: bool,
    /// Times it has been wrapped in a group to be repeated again.
    wraps: u32,
}

/// An open group.
struct Frame {
    start: usize,
    /// Largest `Atom::product` among the group's finished atoms, all branches.
    product: u32,
}

struct Translator<'a> {
    src: &'a str,
    cs: Vec<char>,
    i: usize,
    out: String,
    names: bool,
    /// Open groups; the first is the whole pattern.
    frames: Vec<Frame>,
    last: Option<Atom>,
    /// The previous token was a repetition operator (another one is an error in Go).
    just_repeated: bool,
    /// A flag group `(?i)` read since the last atom. It is written before the next atom, so
    /// that a repetition after it can still apply to the atom before it (`a(?i)*`).
    pending_flags: String,
    /// Position of the next `:]` at or after `posix_from` (a monotone search: linear time).
    posix_from: usize,
    posix_next: Option<usize>,
}

fn invalid(msg: impl Into<String>) -> Error {
    Error::Invalid(msg.into())
}

impl<'a> Translator<'a> {
    fn new(src: &'a str, names: bool) -> Translator<'a> {
        Translator {
            src,
            cs: src.chars().collect(),
            i: 0,
            out: String::with_capacity(src.len() + 16),
            names,
            frames: vec![Frame { start: 0, product: 0 }],
            last: None,
            just_repeated: false,
            pending_flags: String::new(),
            posix_from: 0,
            posix_next: None,
        }
    }

    fn text(&self, from: usize, to: usize) -> String {
        self.cs[from..to.min(self.cs.len())].iter().collect()
    }

    fn run(mut self) -> Result<String, Error> {
        while let Some(&c) = self.cs.get(self.i) {
            match c {
                '\\' => self.escape()?,
                '[' => self.class()?,
                '(' => self.open()?,
                ')' => self.close()?,
                '|' => {
                    self.flush_flags();
                    self.finish_atom();
                    self.out.push('|');
                    self.just_repeated = false;
                    self.i += 1;
                }
                '*' | '+' | '?' => self.repeat(c.to_string(), 1, None)?,
                '{' => match self.parse_repeat(self.i) {
                    Some((min, max, len)) => {
                        let op = match max {
                            Some(m) if m == min => format!("{{{min}}}"),
                            Some(m) => format!("{{{min},{m}}}"),
                            None => format!("{{{min},}}"),
                        };
                        self.repeat(op, len, Some((min, max)))?;
                    }
                    None => {
                        self.literal('{' as u32);
                        self.i += 1;
                    }
                },
                '.' => {
                    self.atom(".", false);
                    self.i += 1;
                }
                '^' | '$' => {
                    self.atom(if c == '^' { "^" } else { "$" }, true);
                    self.i += 1;
                }
                _ => {
                    self.literal(c as u32);
                    self.i += 1;
                }
            }
        }
        self.flush_flags();
        if self.frames.len() > 1 {
            return Err(invalid(format!("missing closing ): `{}`", self.src)));
        }
        Ok(self.out)
    }

    fn flush_flags(&mut self) {
        if !self.pending_flags.is_empty() {
            self.out.push_str(&self.pending_flags);
            self.pending_flags.clear();
        }
    }

    /// The current atom can no longer be repeated: fold it into its group's bound.
    fn finish_atom(&mut self) {
        if let Some(a) = self.last.take() {
            let f = self.frames.last_mut().expect("root frame");
            f.product = f.product.max(a.product);
        }
    }

    fn atom(&mut self, text: &str, assertion: bool) {
        self.flush_flags();
        self.finish_atom();
        let start = self.out.len();
        self.out.push_str(text);
        self.last = Some(Atom { start, product: 1, repeated: false, assertion, wraps: 0 });
        self.just_repeated = false;
    }

    /// A literal code point. Surrogates match U+FFFD, as in Go.
    fn literal(&mut self, v: u32) {
        let text = match char::from_u32(v) {
            Some(c) => regex::escape(c.encode_utf8(&mut [0; 4])),
            None => "\\x{FFFD}".to_string(),
        };
        self.atom(&text, false);
    }

    /// `*`, `+`, `?` or a counted repetition (`counted`), `len` characters long, optionally
    /// followed by `?` (non-greedy).
    fn repeat(&mut self, op: String, len: usize, counted: Option<(u32, Option<u32>)>) -> Result<(), Error> {
        let mut end = self.i + len;
        let lazy = self.cs.get(end) == Some(&'?');
        if lazy {
            end += 1;
        }
        let shown = self.text(self.i, end);
        if self.just_repeated {
            return Err(invalid(format!("invalid nested repetition operator: `{shown}`")));
        }
        let Some(mut a) = self.last.take() else {
            return Err(invalid(format!("missing argument to repetition operator: `{shown}`")));
        };
        if let Some((min, max)) = counted {
            if min > MAX_REPEAT || max.is_some_and(|m| m > MAX_REPEAT || m < min) {
                return Err(invalid(format!("invalid repeat count: `{shown}`")));
            }
            // Go bounds the copies a counted repetition makes of what it contains, nested
            // counts multiplied, at 1000 (checked when either bound is 2 or more). `x{0}` makes
            // none; an unbounded `x{n,}` counts `n`.
            let m = max.unwrap_or(min);
            if max == Some(0) {
                a.product = 1;
            } else if m > 0 {
                if (min >= 2 || m >= 2) && u64::from(m) * u64::from(a.product) > u64::from(MAX_REPEAT) {
                    return Err(invalid(format!("invalid repeat count: `{shown}`")));
                }
                a.product = (m * a.product).min(MAX_REPEAT);
            }
        }
        if a.repeated || a.assertion {
            // Go repeats a repetition when something empty stands between them (`a*(?i)*`),
            // and repeats assertions (`^*`); Rust needs a group for both.
            if a.wraps >= MAX_WRAPS {
                return Err(invalid(format!("expression nests too deeply: `{}`", self.src)));
            }
            a.wraps += 1;
            self.out.insert_str(a.start, "(?:");
            self.out.push(')');
        }
        self.out.push_str(&op);
        if lazy {
            self.out.push('?');
        }
        a.repeated = true;
        a.assertion = false;
        self.last = Some(a);
        self.just_repeated = true;
        self.i = end;
        Ok(())
    }

    /// `{n}`, `{n,}` or `{n,m}` at `i`: (min, max, length). Anything else (`{`, `{,5}`, `{x}`,
    /// a leading zero such as `{01}`) is not a repetition, and Go reads the `{` as a literal.
    fn parse_repeat(&self, i: usize) -> Option<(u32, Option<u32>, usize)> {
        let mut k = i + 1;
        let min = self.parse_int(&mut k)?;
        let max = if self.cs.get(k) == Some(&',') {
            k += 1;
            if self.cs.get(k) == Some(&'}') {
                None
            } else {
                Some(self.parse_int(&mut k)?)
            }
        } else {
            Some(min)
        };
        if self.cs.get(k) != Some(&'}') {
            return None;
        }
        Some((min, max, k + 1 - i))
    }

    /// Decimal digits without a leading zero; values past the bound saturate (and are
    /// refused by the caller, as Go refuses them).
    fn parse_int(&self, k: &mut usize) -> Option<u32> {
        let start = *k;
        let mut v: u32 = 0;
        while let Some(d) = self.cs.get(*k).and_then(|c| c.to_digit(10)) {
            v = (v * 10 + d).min(MAX_REPEAT + 1);
            *k += 1;
        }
        let n = *k - start;
        if n == 0 || (n > 1 && self.cs[start] == '0') {
            return None;
        }
        Some(v)
    }

    // ------------------------------------------------------------------ groups

    fn begin_group(&mut self, text: &str) {
        self.flush_flags();
        self.finish_atom();
        let start = self.out.len();
        self.out.push_str(text);
        self.frames.push(Frame { start, product: 0 });
        self.just_repeated = false;
    }

    fn open(&mut self) -> Result<(), Error> {
        let i = self.i;
        if self.cs.get(i + 1) != Some(&'?') {
            self.begin_group("(");
            self.i += 1;
            return Ok(());
        }
        match self.cs.get(i + 2) {
            Some('P') if self.cs.get(i + 3) == Some(&'<') => self.named(i + 4),
            Some('<') if !matches!(self.cs.get(i + 3), Some('=' | '!')) => self.named(i + 3),
            _ => self.flags(i + 2),
        }
    }

    /// A named group whose name starts at `from`.
    fn named(&mut self, from: usize) -> Result<(), Error> {
        let mut k = from;
        while let Some(&c) = self.cs.get(k) {
            if c == '>' {
                break;
            }
            k += 1;
        }
        let name = self.text(from, k);
        if k >= self.cs.len() || name.is_empty() || !name.chars().all(|c| c == '_' || c.is_ascii_alphanumeric()) {
            return Err(invalid(format!("invalid named capture: `{}`", self.text(self.i, k + 1))));
        }
        let text = if self.names { format!("(?P<{name}>") } else { "(".to_string() };
        self.begin_group(&text);
        self.i = k + 1;
        Ok(())
    }

    /// `(?flags)` or `(?flags:` with the flags starting at `from`. Go accepts `i m s U`, at
    /// most one `-`, which must be followed by a flag; later mentions win (`(?i-i)` clears).
    fn flags(&mut self, from: usize) -> Result<(), Error> {
        const NAMES: [char; 4] = ['i', 'm', 's', 'U'];
        let (mut set, mut clear) = ([false; 4], [false; 4]);
        let (mut negated, mut saw) = (false, false);
        let mut k = from;
        loop {
            let Some(&c) = self.cs.get(k) else {
                return Err(invalid(format!("missing closing ): `{}`", self.src)));
            };
            k += 1;
            if let Some(f) = NAMES.iter().position(|&n| n == c) {
                if negated {
                    clear[f] = true;
                    set[f] = false;
                } else {
                    set[f] = true;
                    clear[f] = false;
                }
                saw = true;
                continue;
            }
            match c {
                '-' if !negated => {
                    negated = true;
                    saw = false;
                }
                ':' | ')' if !(negated && !saw) => {
                    let on: String = (0..4).filter(|&f| set[f]).map(|f| NAMES[f]).collect();
                    let off: String = (0..4).filter(|&f| clear[f]).map(|f| NAMES[f]).collect();
                    let flags = if off.is_empty() { on } else { format!("{on}-{off}") };
                    if c == ':' {
                        self.begin_group(&format!("(?{flags}:"));
                    } else {
                        if !flags.is_empty() {
                            self.pending_flags.push_str(&format!("(?{flags})"));
                        }
                        self.just_repeated = false;
                    }
                    self.i = k;
                    return Ok(());
                }
                _ => return Err(invalid(format!("invalid or unsupported Perl syntax: `{}`", self.text(self.i, k)))),
            }
        }
    }

    fn close(&mut self) -> Result<(), Error> {
        if self.frames.len() == 1 {
            return Err(invalid(format!("unexpected ): `{}`", self.src)));
        }
        self.flush_flags();
        self.finish_atom();
        let f = self.frames.pop().expect("an open group");
        self.out.push(')');
        self.last = Some(Atom { start: f.start, product: f.product.max(1), repeated: false, assertion: false, wraps: 0 });
        self.just_repeated = false;
        self.i += 1;
        Ok(())
    }

    // ------------------------------------------------------------------ escapes

    /// An escape outside a class, at `i`.
    fn escape(&mut self) -> Result<(), Error> {
        let i = self.i;
        let Some(&e) = self.cs.get(i + 1) else {
            return Err(invalid("trailing backslash at end of expression"));
        };
        match e {
            'd' | 'D' | 'w' | 'W' | 's' | 'S' => {
                let body = perl_body(e);
                let text = if e.is_ascii_lowercase() { format!("[{body}]") } else { format!("[^{body}]") };
                self.atom(&text, false);
                self.i += 2;
            }
            'b' | 'B' | 'A' | 'z' => {
                let text = match e {
                    'b' => "(?-u:\\b)",
                    'B' => "(?-u:\\B)",
                    'A' => "\\A",
                    _ => "\\z",
                };
                self.atom(text, true);
                self.i += 2;
            }
            'p' | 'P' => return Err(unicode_class(&self.text(i, i + 3))),
            'Q' => {
                // Literal text up to the first `\E`, or to the end.
                let mut k = i + 2;
                while k < self.cs.len() {
                    if self.cs[k] == '\\' && self.cs.get(k + 1) == Some(&'E') {
                        break;
                    }
                    k += 1;
                }
                for j in i + 2..k {
                    self.literal(self.cs[j] as u32);
                }
                self.just_repeated = false;
                self.i = (k + 2).min(self.cs.len());
            }
            _ => {
                let (v, len) = self.escape_char(i)?;
                self.literal(v);
                self.i += len;
            }
        }
        Ok(())
    }

    /// An escape that stands for one code point, at `i` (the backslash): (code point, length).
    fn escape_char(&self, i: usize) -> Result<(u32, usize), Error> {
        let Some(&e) = self.cs.get(i + 1) else {
            return Err(invalid("trailing backslash at end of expression"));
        };
        let bad = || invalid(format!("invalid escape sequence: `\\{e}`"));
        let octal = |k: usize| self.cs.get(k).and_then(|c| c.to_digit(8));
        Ok(match e {
            // A single non-zero digit is a back-reference, which Go does not support.
            '1'..='7' if octal(i + 2).is_none() => return Err(bad()),
            '0'..='7' => {
                let mut v = e.to_digit(8).unwrap_or(0);
                let mut k = i + 2;
                while k < i + 4 {
                    let Some(d) = octal(k) else { break };
                    v = v * 8 + d;
                    k += 1;
                }
                (v, k - i)
            }
            'x' => {
                let hex = |k: usize| self.cs.get(k).and_then(|c| c.to_digit(16));
                if self.cs.get(i + 2) == Some(&'{') {
                    let (mut v, mut k, mut n) = (0u32, i + 3, 0);
                    loop {
                        match self.cs.get(k) {
                            Some('}') if n > 0 => break,
                            _ => {}
                        }
                        let d = hex(k).ok_or_else(|| invalid(format!("invalid escape sequence: `{}`", self.text(i, k + 1))))?;
                        v = v * 16 + d;
                        if v > 0x10FFFF {
                            return Err(invalid(format!("invalid escape sequence: `{}`", self.text(i, k + 1))));
                        }
                        n += 1;
                        k += 1;
                    }
                    (v, k + 1 - i)
                } else {
                    match (hex(i + 2), hex(i + 3)) {
                        (Some(a), Some(b)) => (a * 16 + b, 4),
                        _ => return Err(invalid(format!("invalid escape sequence: `{}`", self.text(i, i + 4)))),
                    }
                }
            }
            'a' => (0x07, 2),
            'f' => (0x0C, 2),
            't' => (0x09, 2),
            'n' => (0x0A, 2),
            'r' => (0x0D, 2),
            'v' => (0x0B, 2),
            // Any other escaped ASCII character that is not a letter or digit is itself.
            c if c.is_ascii() && !c.is_ascii_alphanumeric() => (c as u32, 2),
            _ => return Err(bad()),
        })
    }

    // ------------------------------------------------------------------ classes

    /// The next `:]` at or after `from`.
    fn posix_close(&mut self, from: usize) -> Option<usize> {
        if self.posix_next.is_some_and(|j| j >= from) {
            return self.posix_next;
        }
        let mut k = from.max(self.posix_from);
        self.posix_next = None;
        while k + 1 < self.cs.len() {
            if self.cs[k] == ':' && self.cs[k + 1] == ']' {
                self.posix_next = Some(k);
                break;
            }
            k += 1;
        }
        self.posix_from = k;
        self.posix_next
    }

    fn class(&mut self) -> Result<(), Error> {
        let open = self.i;
        let mut i = open + 1;
        let mut text = String::from("[");
        let negated = self.cs.get(i) == Some(&'^');
        if negated {
            text.push('^');
            i += 1;
        }
        let mut first = true;
        loop {
            let Some(&c) = self.cs.get(i) else {
                return Err(invalid(format!("missing closing ]: `{}`", self.text(open, i))));
            };
            // `]` first in the class is a literal.
            if c == ']' && !first {
                i += 1;
                break;
            }
            first = false;
            if c == '[' && self.cs.get(i + 1) == Some(&':') && i + 2 < self.cs.len() {
                // `[:name:]`, up to the next `:]`; Go refuses a name it does not know.
                if let Some(j) = self.posix_close(i + 2) {
                    let name = self.text(i + 2, j);
                    if !POSIX.contains(&name.strip_prefix('^').unwrap_or(&name)) {
                        return Err(invalid(format!("invalid character class range: `{}`", self.text(i, j + 2))));
                    }
                    text.push_str(&format!("[:{name}:]"));
                    i = j + 2;
                    continue;
                }
            }
            if c == '\\' {
                match self.cs.get(i + 1) {
                    Some(&e @ ('d' | 'D' | 'w' | 'W' | 's' | 'S')) => {
                        let body = perl_body(e);
                        if e.is_ascii_lowercase() {
                            text.push_str(body);
                        } else {
                            text.push_str(&format!("[^{body}]"));
                        }
                        i += 2;
                        continue;
                    }
                    Some('p' | 'P') => return Err(unicode_class(&self.text(i, i + 3))),
                    _ => {}
                }
            }
            // A character, or a range `lo-hi` (a `-` before the closing `]` is a literal).
            let from = i;
            let (lo, len) = self.class_char(i)?;
            i += len;
            let mut hi = lo;
            if self.cs.get(i) == Some(&'-') && self.cs.get(i + 1).is_some_and(|&d| d != ']') {
                let (h, len) = self.class_char(i + 1)?;
                if h < lo {
                    return Err(invalid(format!("invalid character class range: `{}`", self.text(from, i + 1 + len))));
                }
                hi = h;
                i += 1 + len;
            }
            push_range(&mut text, lo, hi, negated);
        }
        text.push(']');
        self.atom(&text, false);
        self.i = i;
        Ok(())
    }

    fn class_char(&self, i: usize) -> Result<(u32, usize), Error> {
        if self.cs[i] == '\\' {
            self.escape_char(i)
        } else {
            Ok((self.cs[i] as u32, 1))
        }
    }
}

fn perl_body(e: char) -> &'static str {
    match e.to_ascii_lowercase() {
        'd' => DIGIT,
        'w' => WORD,
        _ => SPACE,
    }
}

fn unicode_class(text: &str) -> Error {
    Error::Unsupported(format!("Unicode character classes such as `{text}` are not supported"))
}

/// Writes `lo-hi` into a class, every code point escaped. A string never holds a surrogate,
/// so surrogates are cut out of ranges; but Go matches U+FFFD for a single surrogate in a class
/// that is not negated (`[\x{D800}a]` matches U+FFFD and `a`; `[^\x{D800}a]` matches U+FFFD
/// too; `[\x{D800}-\x{D900}]` matches nothing: observed in Go and Tempo).
fn push_range(text: &mut String, lo: u32, hi: u32, negated: bool) {
    if lo == hi && (0xD800..=0xDFFF).contains(&lo) && !negated {
        text.push_str("\\x{FFFD}");
        return;
    }
    let mut wrote = false;
    for (a, b) in [(lo, hi.min(0xD7FF)), (lo.max(0xE000), hi)] {
        if a <= b {
            if a == b {
                text.push_str(&format!("\\x{{{a:X}}}"));
            } else {
                text.push_str(&format!("\\x{{{a:X}}}-\\x{{{b:X}}}"));
            }
            wrote = true;
        }
    }
    if !wrote {
        text.push_str(NOTHING);
    }
}

#[cfg(test)]
mod tests {
    // Moved from viz-logql's `src/goregex.rs` with the translator.
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
        // Without names every group is a plain capture (names Rust refuses are fine then).
        let r = compile(r"(?P<1>x)(?P<a>y)(?P<a>z)", Wrap::Anchored, false, &Limits::default()).unwrap();
        assert_eq!(r.capture_names().flatten().count(), 0);
        assert!(r.is_match("xyz"));
    }
}
