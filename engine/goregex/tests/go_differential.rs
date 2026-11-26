//! Exports generated patterns with this crate's answers, for a differential run against Go's
//! own `regexp` package (`tools/godiff`, Go standard library only). Ignored by default: it
//! needs Go.
//!
//! ```text
//! GOREGEX_DIFF_OUT=$SCRATCH/cases.json GOREGEX_DIFF_SEED=1 GOREGEX_DIFF_N=20000 \
//!   cargo test --release --test go_differential -- --ignored
//! (cd tools/godiff && go run . $SCRATCH/cases.json)
//! ```
//!
//! Each pattern is translated and compiled fully anchored (`^(?s:…)$`, as TraceQL and label
//! matchers use it) and run on every subject. The Go side compiles the pattern alone (does Go
//! accept it?) and then `^(?s:` + pattern + `)$`, and requires the same acceptance and the same
//! matches. Unicode classes, which this crate refuses as Unsupported, are counted, not compared.
//! Each accepted pattern is also compiled keeping names (as LogQL's `regexp` stage does): its
//! group names must be Go's `SubexpNames`, or Unsupported exactly where Go has a name Rust cannot
//! hold (one that starts with a digit, or a repeat).

use viz_goregex::{compile, Error, Limits, Wrap};

/// Pieces patterns are built from: everything the translator treats specially, and text Go
/// and Rust read differently.
const TOKENS: &[&str] = &[
    "a", "b", "A", "x", "é", "K", "\u{212A}", "ſ", "0", "1", "_", " ", "\n", "-", "]", "[", "{", "}", ":", "&", "~", "#", "^", "$",
    ".", "|", "(", ")", "*", "+", "?", "{2}", "{1,3}", "{0,}", "{,2}", "{01}", "{1001}", "{2}?", "*?", "(?:", "(?i)", "(?i:",
    "(?-i)", "(?s)", "(?-s:", "(?m)", "(?U)", "(?P<n>", "(?<m>", "(?x)", "(?ii)", "(?i-i)", "(?)", "(?-)", r"\d", r"\D", r"\w",
    r"\W", r"\s", r"\S", r"\b", r"\B", r"\A", r"\z", r"\Z", r"\Q", r"\E", r"\x41", r"\x{e9}", r"\x{D800}", r"\101", r"\0", r"\1",
    r"\12", r"\8", r"\<", r"\>", r"\_", r"\.", r"\-", r"\[", r"\]", r"\{", r"\a", r"\v", r"\f", r"\t", r"\n", concat!('\\', "u0041"), r"\e",
    r"\pL", r"\\", "[^", "[:alpha:]", "[:^digit:]", "[:foo:]", "&&", "~~", "--", "a-z", "z-a", "a-", "-a", r"\d-", "[a]", "[^a]",
    // Group names: a leading digit, `_`, a repeat (any of these twice), characters Go refuses, an
    // empty name, lookbehind, a name finished by later tokens (`(?<` `a` `>`).
    "(?P<1>", "(?<1a>", "(?P<_>", "(?P<n>", "(?P<é>", "(?P<a.b>", "(?P<>", "(?<=", "(?<!", "(?P=n)", "(?P<", "(?<", ">",
];

/// Subjects every pattern is run on.
const SUBJECTS: &[&str] = &[
    "", "a", "aa", "aaa", "b", "ab", "aB", "A", "AB", "x", "xx", "é", "aé", "K", "\u{212A}", "k", "ſ", "s", "0", "01", "1", "_",
    " ", "\n", "\t", "\u{b}", "\u{c}", "-", "]", "[", "{", "}", "{2}", "a{2}", "a{,2}", "a{01}", ":", "&", "~", "#", "\u{FFFD}",
    "\0", "\u{1}", "\n8", "\u{a}2", "a-z", "<a>", "a.b", "a b", "\\", "e", "\u{7}", "a\nb",
];

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Group openers for closed groups: plain, named (names Go accepts, some Rust cannot hold, and
/// some Go refuses), flag groups and lookbehind.
const OPENERS: &[&str] =
    &["(", "(?:", "(?i:", "(?P<n>", "(?<m>", "(?P<1>", "(?<1a>", "(?P<_>", "(?<x9_Z>", "(?P<n>", "(?P<é>", "(?<=", "(?P<", "(?<"];

fn pattern(r: &mut Rng) -> String {
    let mut p = String::new();
    let n = 1 + r.below(7);
    for _ in 0..n {
        // Mostly tokens; sometimes a whole class built from tokens, so that class syntax is
        // exercised and not only stray brackets; sometimes a closed group, so that groups (named
        // ones above all) are accepted often enough to be compared.
        match r.below(6) {
            0 => {
                p.push('[');
                if r.below(3) == 0 {
                    p.push('^');
                }
                for _ in 0..1 + r.below(4) {
                    p.push_str(TOKENS[r.below(TOKENS.len())]);
                }
                p.push(']');
            }
            1 => {
                p.push_str(OPENERS[r.below(OPENERS.len())]);
                for _ in 0..r.below(3) {
                    p.push_str(TOKENS[r.below(TOKENS.len())]);
                }
                p.push(')');
            }
            _ => p.push_str(TOKENS[r.below(TOKENS.len())]),
        }
    }
    p
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

#[test]
#[ignore]
fn export_go_differential_cases() {
    let out = std::env::var("GOREGEX_DIFF_OUT").expect("GOREGEX_DIFF_OUT");
    let seed: u64 = std::env::var("GOREGEX_DIFF_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let n: usize = std::env::var("GOREGEX_DIFF_N").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000);
    let mut r = Rng(0x9E37_79B9_7F4A_7C15 ^ seed.wrapping_mul(0x2545_F491_4F6C_DD1D));
    let mut cases = Vec::with_capacity(n);
    let mut seen = std::collections::HashSet::new();
    let limits = Limits::default();
    while cases.len() < n {
        let p = pattern(&mut r);
        if !seen.insert(p.clone()) {
            continue;
        }
        let answer = match compile(&p, Wrap::Anchored, false, &limits) {
            Ok(re) => {
                let m: Vec<String> = SUBJECTS.iter().map(|s| if re.is_match(s) { "1" } else { "0" }.to_string()).collect();
                // The group names a caller that keeps them sees (an unnamed group as "").
                let names = match compile(&p, Wrap::Plain, true, &limits) {
                    Ok(r) => {
                        let n: Vec<String> = r.capture_names().skip(1).map(|n| json_str(n.unwrap_or(""))).collect();
                        format!(",\"names\":[{}]", n.join(","))
                    }
                    Err(Error::Unsupported(_)) => ",\"names_unsupported\":true".to_string(),
                    Err(Error::Invalid(e)) => format!(",\"names_error\":{}", json_str(&e)),
                };
                format!("{{\"matches\":\"{}\"{names}}}", m.concat())
            }
            Err(Error::Unsupported(_)) => "{\"unsupported\":true}".to_string(),
            Err(Error::Invalid(e)) => format!("{{\"error\":{}}}", json_str(&e)),
        };
        cases.push(format!("{{\"pattern\":{},\"viz\":{answer}}}", json_str(&p)));
    }
    let subjects: Vec<String> = SUBJECTS.iter().map(|s| json_str(s)).collect();
    let body = format!("{{\"subjects\":[{}],\"cases\":[\n{}\n]}}\n", subjects.join(","), cases.join(",\n"));
    std::fs::write(&out, body).expect("write cases");
    eprintln!("wrote {n} patterns to {out}");
}
