//! Each rule of the translation, with the answers Go's `regexp` (Go 1.24, standard library, run
//! as a black box) and Tempo v3.1.1 (black box, `engine/traceql/testdata/regex_dialect.json`)
//! gave. Patterns are compiled fully anchored, as TraceQL and label matchers use them.

use viz_goregex::{compile, compile_anchored, compile_plain, compile_unanchored, translate, Error, Limits, Wrap};

fn anchored(p: &str) -> Result<regex::Regex, Error> {
    compile(p, Wrap::Anchored, false, &Limits::default())
}

/// `p` compiles, matches every string in `yes` and none in `no`.
#[track_caller]
fn matches(p: &str, yes: &[&str], no: &[&str]) {
    let re = anchored(p).unwrap_or_else(|e| panic!("{p:?} refused: {e}"));
    for s in yes {
        assert!(re.is_match(s), "{p:?} should match {s:?}");
    }
    for s in no {
        assert!(!re.is_match(s), "{p:?} should not match {s:?}");
    }
}

#[track_caller]
fn refused(p: &str) {
    match anchored(p) {
        Err(Error::Invalid(_)) => {}
        other => panic!("{p:?}: Go refuses it, got {other:?}"),
    }
}

#[test]
fn perl_classes_and_word_boundaries_are_ascii() {
    matches(r"\w+", &["abc_123", "K"], &["é", "日本", "\u{212A}", "ſ"]);
    matches(r"\d", &["7"], &["\u{661}"]);
    matches(r"\s", &[" ", "\t", "\n", "\u{c}", "\r"], &["\u{b}", "\u{a0}", "\u{2003}"]);
    matches(r"\S", &["\u{b}", "\u{a0}"], &[" "]);
    matches(r"[\w-]+", &["a-b"], &["aé"]);
    matches(r"[^\D]", &["5"], &["a"]);
    matches(r".*\bfoo\b.*", &["foo bar", "éfooé"], &["afoob"]);
    matches(r".*\Bfoo\B.*", &["afoob"], &["éfooé"]);
    // (?i) folds the ASCII class as Go does: K (Kelvin) and ſ fold to k and s.
    matches(r"(?i)\w", &["\u{212A}", "ſ", "k"], &["é", "ß"]);
    matches(r"(?i)\W", &["é"], &["\u{212A}", "ſ"]);
    matches(r"[[:space:]]", &["\u{b}"], &["\u{a0}"]);
}

#[test]
fn case_folding_is_simple_folding() {
    matches("(?i)k", &["k", "K", "\u{212A}"], &[]);
    matches("(?i)σ", &["σ", "ς", "Σ"], &[]);
    matches("(?i)ß", &["ẞ"], &["ss"]);
    matches("(?i)i", &["I"], &["İ", "ı"]);
    // A flag lasts to the end of its group, across alternatives.
    matches("a(?i)b|c", &["aB", "C"], &["AB"]);
    matches("a(?i:b)|c", &["aB"], &["C"]);
}

#[test]
fn go_only_escapes_and_literals() {
    matches(r"\Qa.b\E+", &["a.bb"], &["axb"]);
    matches(r"\Qa)", &["a)"], &["a"]); // unterminated: literal to the end, wrapping stays sound
    matches(r"\Q\E", &[""], &["a"]);
    matches(r"\101\0\x41\x{41}", &["A\0AA"], &[]);
    matches(r"\08", &["\x008"], &[]);
    matches(r"\17", &["\u{f}"], &[]);
    matches(r"[\101-\103]+", &["ABC"], &["D"]);
    matches(r"\<a\>", &["<a>"], &["a"]);
    matches(r"\_\%\#\ ", &["_%# "], &[]);
    matches(r"x{,5}", &["x{,5}"], &["xxxxx", ""]);
    matches(r"x{01}", &["x{01}"], &["x"]);
    matches(r"a\b{start}", &["a{start}"], &["a"]);
    matches(r"a{,}", &["a{,}"], &[]);
    matches("{", &["{"], &[]);
    matches("}", &["}"], &[]);
    matches(r"[a&&b]", &["&", "a"], &[]);
    matches(r"[a~~b]", &["~"], &[]);
    matches(r"[--a]", &["-", "A", "a"], &["b"]);
    matches(r"[\d-z]", &["-", "5", "z"], &["y"]);
    matches(r"[[:alpha:]-z]", &["-", "q"], &["5"]);
    matches(r"[[a]", &["["], &["]"]);
    matches(r"[[:a]", &["[", ":", "a"], &[]);
    matches(r"[]a]", &["]"], &["b"]);
    matches(r"[^]a]", &["b"], &["]"]);
}

#[test]
fn flags_and_groups() {
    matches("(?ii)abc", &["ABC"], &[]);
    matches("(?i-i)abc", &["abc"], &["ABC"]);
    matches("(?)abc", &["abc"], &[]);
    matches("(?s-i:a.b)", &["a\nb"], &["A\nb"]);
    matches("(?-s:a.b)", &["a b"], &["a\nb"]);
    matches("a.b", &["a\nb"], &[]); // the anchoring wrapper turns `s` on
    matches("(?P<1>a)(?P<x>b)(?P<x>c)", &["abc"], &[]); // names Go accepts and Rust does not
    matches("(?U)(x+)x", &["xx"], &[]);
    // A repetition after an empty construct repeats the atom before it; assertions repeat.
    matches("a(?i)*", &["", "aaa"], &["A"]);
    matches(r"a*(?i)*", &["", "aa"], &[]);
    matches(r"a*\Q\E*", &["", "aa"], &[]);
    matches("^*$", &[""], &[]);
    matches(r"\b*", &[""], &[]);
    matches("(?:a|ab)(?:b|)", &["ab", "a"], &[]);
    matches("a|ab", &["a", "ab"], &[]);
    // Re-wrapped atoms inside a group that is itself re-wrapped (Go 1.24.7, black box).
    matches("(?:a*(?i)*)*(?i)*", &["", "a", "aaa"], &["A"]);
    matches("x(?:a*(?i)*)*(?i)*", &["x", "xaa"], &["xA"]);
    matches("((a)*(?)*)*(?)*b", &["ab", "aab"], &["a"]);
}

/// Group names. Go's documentation (pkg.go.dev/regexp/syntax, go1.27.4; `go doc regexp/syntax`,
/// Go 1.24.7) lists `(?P<name>re)` and `(?<name>re)` and the error `invalid named capture`, but
/// not which names are valid; `go doc regexp.Regexp.SubexpIndex` says a name may be used twice.
/// The rest is Go 1.24.7's `regexp` run as a black box (scratch programs, CLEANROOM.md), and
/// Tempo v3.1.1's recorded answers for `(?P<1>a)`, `(?P<a>x)(?P<a>y)`, `(?P<é>a)` and
/// `(?P<a.b>x)` (`engine/traceql/testdata/regex_dialect.json`): a name is one or more of
/// `[A-Za-z0-9_]`, a leading digit included; anything else is refused.
#[test]
fn group_names_are_gos() {
    matches("(?P<1>a)", &["a"], &["1", ""]);
    matches("(?<1>a)(?P<0>b)(?P<123>c)(?P<1a>d)(?P<01>e)", &["abcde"], &[]);
    matches("(?P<_>a)(?P<_1>b)(?P<A_b9>c)(?P<K>d)", &["abcd"], &[]);
    matches("(?P<a>x)(?P<a>y)", &["xy"], &["x"]);
    matches("(?P<a>x)|(?<a>y)", &["x", "y"], &["xy"]);
    matches("(?P<a>b)>", &["b>"], &["b"]);
    matches("(?<a>>b)", &[">b"], &["b"]);
    // The forms that only match drop names, so they accept every name Go accepts.
    assert!(compile_anchored("(?P<1>a)(?P<a>b)(?<a>c)").unwrap().is_match("abc"));
    assert!(compile_unanchored("(?P<9>a)|(?P<9>b)", true).unwrap().is_match("xb"));
    // Refused as Go refuses them, in Go's words (observed).
    for (p, msg) in [
        ("(?P<é>a)", "invalid named capture: `(?P<é>`"),
        ("(?P<\u{661}>a)", "invalid named capture: `(?P<\u{661}>`"), // an Arabic-Indic digit
        ("(?P<a.b>a)", "invalid named capture: `(?P<a.b>`"),
        ("(?P<a b>a)", "invalid named capture: `(?P<a b>`"),
        ("(?P<a-b>a)", "invalid named capture: `(?P<a-b>`"),
        ("(?P<a[0]>x)", "invalid named capture: `(?P<a[0]>`"),
        ("(?P<>a)", "invalid named capture: `(?P<>`"),
        ("(?<>a)", "invalid named capture: `(?<>`"),
        ("(?P<a", "invalid named capture: `(?P<a`"),
        ("x(?P<1", "invalid named capture: `(?P<1`"),
        ("(?P<a)", "invalid named capture: `(?P<a)`"),
        ("(?<a", "invalid named capture: `(?<a`"),
        ("(?<=a)", "invalid named capture: `(?<=a)`"),
        ("(?<!a)", "invalid named capture: `(?<!a)`"),
        ("(?<=a)>b", "invalid named capture: `(?<=a)>`"),
        ("(?P<", "invalid or unsupported Perl syntax: `(?P`"),
        ("(?<", "invalid or unsupported Perl syntax: `(?<`"),
        ("(?P>a)", "invalid or unsupported Perl syntax: `(?P`"),
        ("(?P=a)", "invalid or unsupported Perl syntax: `(?P`"),
        ("(?P<a>", "missing closing ): `(?P<a>`"),
        ("(?P<a>a", "missing closing ): `(?P<a>a`"),
    ] {
        assert_eq!(translate(p, false), Err(Error::Invalid(msg.to_string())), "{p:?}");
        assert_eq!(translate(p, true), Err(Error::Invalid(msg.to_string())), "{p:?}, names kept");
    }
    // Keeping names (LogQL's `regexp` stage and templates), a name Go accepts and Rust cannot
    // hold is Unsupported: not Rust's refusal, and not a different capture.
    for p in ["(?P<1>a)", "(?<1a>a)", "(?P<a>x)(?P<a>y)", "(?P<a>x)|(?<a>y)", "(?P<_>a)(?P<_>b)"] {
        assert!(matches!(translate(p, true), Err(Error::Unsupported(_))), "{p:?}");
        assert!(compile_plain(p).is_err(), "{p:?}");
    }
    let r = compile_plain("(?P<_>a)(?P<a1>b)(?<x9_Z>c)(?P<K>d)").unwrap();
    assert_eq!(r.capture_names().flatten().collect::<Vec<_>>(), vec!["_", "a1", "x9_Z", "K"]);
    // Only a pattern Go accepts can be Unsupported for its names: Go's refusal of a later error
    // comes first.
    for (p, msg) in [
        (r"(?P<1>a)\8", "invalid escape sequence: `\\8`"),
        ("(?P<a>x)(?P<a>y)(", "missing closing ): `(?P<a>x)(?P<a>y)(`"),
        ("(?P<1>a)(?P<é>b)", "invalid named capture: `(?P<é>`"),
    ] {
        assert_eq!(translate(p, true), Err(Error::Invalid(msg.to_string())), "{p:?}");
    }
}

#[test]
fn counted_repetitions_follow_gos_bound() {
    matches("x{1000}", &[&"x".repeat(1000)], &[]);
    matches("x{1000,}", &[&"x".repeat(1001)], &[]);
    matches("(?:a{10}){100}", &[&"a".repeat(1000)], &[]);
    matches("(?:(?:x{2}){3}){166}", &[&"x".repeat(996)], &[]);
    matches("(?:x{1000}){0,1}", &["", &"x".repeat(1000)], &[]);
    matches("(?:x{0}){1000}", &[""], &[]);
    matches("(?:x{2}|y{500}){2}", &["xxxx"], &[]);
    for p in [
        "x{1001}",
        "x{1000,1001}",
        "x{1001,}",
        "a{99999999}",
        "(?:a{10}){101}",
        "(?:a{2,}){600}",
        "(?:a*){1001}",
        "(?:x{2}){501}",
        "(?:(?:x{2}){3}){167}",
        "(?:(?:x{1000}){1}){2}",
        "(?:x{600}){1,2}",
        "(?:x{2}|y{500}){3}",
        "(?:x{2}y{500}){3}",
        "a{2,1}",
    ] {
        refused(p);
    }
}

#[test]
fn what_go_refuses_is_refused() {
    for p in [
        r"\1", r"\8", r"\18", r"[\1]", r"\e", r"\Z", r"\cA", r"\N", r"\C", concat!('\\', "u0041"), r"\U00000041", r"\x4", r"\x{}",
        r"\x{110000}", r"a\Eb", r"\Qa\E\E", r"[\Q]\E]", r"[\Q]", r"[\b]", r"[a-\d]", "[z-a]", "[a--]", "[[:foo:]]",
        "[[:a]b:]", "[[:alpha:]", "[a-[:alpha:]]", "[]", "[^]", "x**", "x{2}{3}", "x*??", "x{2}??", "a++", "a?*", "a{2}*",
        "a{1000}{2}", "(a)*+", "*a", "a|*", "(*)", "(?i)*", r"\Q\E*", "(?x) a", "(?u)abc", "(?i-)abc", "(?-)abc",
        "(?s-:a)", "(?P<a.b>x)", "(?P<>a)", "(?P<é>a)", "(?'n'abc)", "(?P=n)", "(?<=a)", "(?!a)", "a)(b", "a)|(b", ")",
        "(", "\\",
    ] {
        refused(p);
    }
}

#[test]
fn unicode_classes_are_unsupported_not_different() {
    for p in [r"\pL", r"\p{L}", r"\p{Greek}+", r"\PL", r"[\p{Greek}]", r"\pN", r"(?i)\pL", r"\p{greek}"] {
        assert!(matches!(anchored(p), Err(Error::Unsupported(_))), "{p:?}");
    }
    // An escaped backslash before `p` is not a class.
    matches(r"\\p", &["\\p"], &[]);
}

#[test]
fn surrogates_match_as_go_does_for_simple_forms() {
    matches(r"\x{D800}", &["\u{FFFD}"], &["a"]);
    matches(r"[\x{D800}a]", &["\u{FFFD}", "a"], &[]);
    matches(r"[^\x{D800}a]", &["\u{FFFD}", "b"], &["a"]);
    matches(r"[\x{D7FF}-\x{E000}]", &["\u{D7FF}", "\u{E000}"], &["\u{FFFD}"]);
    matches(r"[\x{D800}-\x{D900}]", &[], &["\u{FFFD}", "a"]);
}

#[test]
fn translation_is_linear_and_bounded() {
    // Inputs that made the earlier translator quadratic (each `[:` in a class searched to the
    // end of the pattern for `:]`) or that would re-wrap one atom without end: about 128 KiB
    // each, translated well within a second even unoptimised (measured: README).
    let n = 43 * 1024;
    let posix = format!("[{}]", "[:a".repeat(n));
    let t = std::time::Instant::now();
    assert!(translate(&posix, false).is_ok());
    let wraps = format!("a{}", "*(?i)".repeat(n * 3 / 5));
    assert!(matches!(translate(&wraps, false), Err(Error::Invalid(m)) if m.contains("nests too deeply")));
    // Many atoms each repeated once more are not nesting (Go accepts 1001 `^*`).
    assert!(translate(&"^*".repeat(n), false).is_ok());
    assert!(t.elapsed().as_secs() < 5, "took {:?}", t.elapsed());
    // Plain, unanchored use keeps names (LogQL's `regexp` stage).
    let r = compile_plain(r"(?P<a>\w+) (?<b>.*)").unwrap();
    assert_eq!(r.capture_names().flatten().collect::<Vec<_>>(), vec!["a", "b"]);
}

#[test]
fn rewrapping_costs_linear_time() {
    // Nested groups, each repeated, then repeated again after an empty construct:
    // `((…(a)*(?)*)*(?)*…)`. Each second `*` wraps a whole group in `(?:…)`. Writing that `(?:`
    // at the group's start moved the group's text on every wrap, which is quadratic: about 2 MiB
    // took 9.3 s unoptimised and 1 MiB 1.9 s optimised (README, "Linear time"). Recorded and
    // written once at the end, 2 MiB takes about 0.3 s unoptimised.
    let d = 300_000;
    let p = format!("{}a{}", "(".repeat(d), ")*(?)*".repeat(d));
    let t = std::time::Instant::now();
    let out = translate(&p, false).unwrap();
    let took = t.elapsed();
    // `(` x d `a` `)*(?)*` x d becomes `(?:(` x d `a` `)*)*` x d: one byte more per level.
    assert_eq!(out.len(), p.len() + d);
    assert!(out.starts_with("(?:((?:((?:(") && out.ends_with(")*)*)*)*"), "{}", &out[..40]);
    assert!(took.as_secs_f64() < 3.0, "took {took:?}");
}
