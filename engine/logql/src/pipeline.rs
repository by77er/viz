//! Compiled log pipelines: line filters, parsers, label filters, formatters and label
//! stages, applied to one entry at a time.

use std::borrow::Cow;

use regex::Regex;

use crate::ast::*;
use crate::error::Error;
use crate::ip::IpMatcher;
use crate::json::JsonPath;
use crate::labels::*;
use crate::pattern::Pattern;
use crate::template::{Ctx, Template};
use crate::text::{parse_bytes, parse_go_duration};

// ---------- conversions and their Go error messages ----------

/// `strconv.ParseFloat` of a label value, with Go's error text.
pub fn parse_float_label(v: &str) -> Result<f64, String> {
    if let Some(f) = crate::text::go_parse_float(v) {
        return Ok(f);
    }
    let q = crate::template::gofmt::go_quote(v);
    // A well-formed number that overflows is "out of range" in Go.
    if v.parse::<f64>().is_ok_and(|f| f.is_infinite()) && !v.to_ascii_lowercase().contains("inf") {
        return Err(format!("strconv.ParseFloat: parsing {q}: value out of range"));
    }
    Err(format!("strconv.ParseFloat: parsing {q}: invalid syntax"))
}

/// The error `time.ParseDuration` returns for `s` (call only when parsing failed).
pub fn go_duration_error(s: &str) -> String {
    let q = crate::template::gofmt::go_quote(s);
    let invalid = format!("time: invalid duration {q}");
    let mut rest = s.strip_prefix(['-', '+']).unwrap_or(s);
    if rest.is_empty() {
        return invalid;
    }
    while !rest.is_empty() {
        let c = rest.as_bytes()[0];
        if !(c == b'.' || c.is_ascii_digit()) {
            return invalid;
        }
        let d = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
        rest = &rest[d..];
        let mut post = false;
        if let Some(r) = rest.strip_prefix('.') {
            let f = r.bytes().take_while(|b| b.is_ascii_digit()).count();
            post = f > 0;
            rest = &r[f..];
        }
        if d == 0 && !post {
            return invalid;
        }
        let u = rest.find(|c: char| c == '.' || c.is_ascii_digit()).unwrap_or(rest.len());
        if u == 0 {
            return format!("time: missing unit in duration {q}");
        }
        let unit = &rest[..u];
        if !matches!(unit, "ns" | "us" | "µs" | "μs" | "ms" | "s" | "m" | "h") {
            return format!("time: unknown unit {} in duration {q}", crate::template::gofmt::go_quote(unit));
        }
        rest = &rest[u..];
    }
    invalid
}

/// The error go-humanize's `ParseBytes` returns for `s` (call only when parsing failed).
pub fn bytes_error(s: &str) -> String {
    let digits = s.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',').count();
    let num: String = s.chars().take(digits).filter(|c| *c != ',').collect();
    if crate::text::go_parse_float(&num).is_none() {
        return format!("strconv.ParseFloat: parsing {}: invalid syntax", crate::template::gofmt::go_quote(&num));
    }
    let unit: String = s.chars().skip(digits).collect::<String>().trim().to_ascii_lowercase();
    let known = ["", "b", "k", "kb", "m", "mb", "g", "gb", "t", "tb", "p", "pb", "e", "eb", "ki", "kib", "mi", "mib", "gi", "gib", "ti", "tib", "pi", "pib", "ei", "eib"];
    if known.contains(&unit.as_str()) {
        return format!("too large: {s}");
    }
    format!("unhandled size name: {unit}")
}

pub fn check_regexp_parser(re: &str) -> Result<(), String> {
    let r = crate::goregex::compile_plain(re).map_err(|e| format!("invalid regex {re:?}: {e}"))?;
    if !r.capture_names().flatten().any(|_| true) {
        return Err("at least one named capture must be supplied".into());
    }
    for n in r.capture_names().flatten() {
        if !crate::parser::valid_label_name(n) {
            return Err(format!("invalid extracted label name {n:?}"));
        }
    }
    Ok(())
}

// ---------- ANSI escape sequences ----------

/// Remove ANSI escape sequences: CSI (`ESC [` … final byte, or C1 `0x9B`), OSC (`ESC ]` …
/// `BEL` or `ESC \`), character-set designations (`ESC (` and similar plus one character)
/// and other two-byte escapes.
pub fn decolorize(line: &str) -> Cow<'_, str> {
    if !line.contains('\u{1b}') && !line.contains('\u{9b}') {
        return Cow::Borrowed(line);
    }
    let cs: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        let csi_start = if c == '\u{1b}' && cs.get(i + 1) == Some(&'[') {
            Some(i + 2)
        } else if c == '\u{9b}' {
            Some(i + 1)
        } else {
            None
        };
        if let Some(mut j) = csi_start {
            while j < cs.len() && ('\u{30}'..='\u{3f}').contains(&cs[j]) {
                j += 1;
            }
            while j < cs.len() && ('\u{20}'..='\u{2f}').contains(&cs[j]) {
                j += 1;
            }
            if j < cs.len() && ('\u{40}'..='\u{7e}').contains(&cs[j]) {
                i = j + 1;
                continue;
            }
            out.push(c);
            i += 1;
            continue;
        }
        if c == '\u{1b}' {
            match cs.get(i + 1) {
                Some(']') => {
                    let mut j = i + 2;
                    let mut end = None;
                    while j < cs.len() {
                        if cs[j] == '\u{7}' {
                            end = Some(j + 1);
                            break;
                        }
                        if cs[j] == '\u{1b}' && cs.get(j + 1) == Some(&'\\') {
                            end = Some(j + 2);
                            break;
                        }
                        j += 1;
                    }
                    if let Some(e) = end {
                        i = e;
                        continue;
                    }
                }
                Some('(' | ')' | '*' | '+' | '#') if i + 2 < cs.len() => {
                    i += 3;
                    continue;
                }
                Some(n) if ('\u{40}'..='\u{5f}').contains(n) => {
                    i += 2;
                    continue;
                }
                _ => {}
            }
        }
        out.push(c);
        i += 1;
    }
    Cow::Owned(out)
}

// ---------- line filters ----------

#[derive(Debug, Clone)]
enum Needle {
    Sub(String),
    Re(Regex),
    Pat(Pattern),
    Ip(IpMatcher),
}

impl Needle {
    fn hit(&self, line: &str) -> bool {
        match self {
            Needle::Sub(s) => line.contains(s.as_str()),
            Needle::Re(r) => r.is_match(line),
            Needle::Pat(p) => pattern_filter_matches(p, line),
            Needle::Ip(m) => m.matches_line(line),
        }
    }
}

/// `|>`: the pattern's first literal may occur anywhere; each capture runs to the next
/// occurrence of the literal after it; a pattern ending in a literal must end the line.
pub fn pattern_filter_matches(p: &Pattern, line: &str) -> bool {
    p.filter_matches(line)
}

#[derive(Debug, Clone)]
pub struct CLineFilter {
    negated: bool,
    needles: Vec<Needle>,
}

impl CLineFilter {
    pub fn compile(f: &LineFilter) -> Result<CLineFilter, Error> {
        let mut needles = Vec::new();
        for a in &f.args {
            needles.push(match (a, f.op) {
                (FilterArg::Ip(p), _) => Needle::Ip(IpMatcher::parse(p).map_err(Error::Eval)?),
                (FilterArg::Str(s), LineFilterOp::Contains | LineFilterOp::NotContains) => Needle::Sub(s.clone()),
                (FilterArg::Str(s), LineFilterOp::Match | LineFilterOp::NotMatch) => {
                    Needle::Re(crate::goregex::compile_unanchored(s, true).map_err(Error::Eval)?)
                }
                (FilterArg::Str(s), _) => Needle::Pat(Pattern::parse(s, false).map_err(Error::Eval)?),
            });
        }
        Ok(CLineFilter { negated: f.op.negated(), needles })
    }

    pub fn keep(&self, line: &str) -> bool {
        let any = self.needles.iter().any(|n| n.hit(line));
        any != self.negated
    }
}

// ---------- label filters ----------

#[derive(Debug, Clone)]
pub struct StrMatcher {
    pub name: String,
    op: MatchOp,
    value: String,
    re: Option<Regex>,
}

impl StrMatcher {
    pub fn compile(m: &Matcher) -> Result<StrMatcher, Error> {
        let re = match m.op {
            MatchOp::Re | MatchOp::Nre => Some(crate::goregex::compile_anchored(&m.value).map_err(Error::Eval)?),
            _ => None,
        };
        Ok(StrMatcher { name: m.name.clone(), op: m.op, value: m.value.clone(), re })
    }
    pub fn matches(&self, v: &str) -> bool {
        match self.op {
            MatchOp::Eq => v == self.value,
            MatchOp::Ne => v != self.value,
            MatchOp::Re => self.re.as_ref().is_some_and(|r| r.is_match(v)),
            MatchOp::Nre => !self.re.as_ref().is_some_and(|r| r.is_match(v)),
        }
    }
}

#[derive(Debug, Clone)]
enum CLabelFilter {
    Str(StrMatcher),
    Num(String, CmpOp, f64),
    Dur(String, CmpOp, i64),
    Bytes(String, CmpOp, f64),
    Ip(String, bool, IpMatcher),
    And(Box<CLabelFilter>, Box<CLabelFilter>),
    Or(Box<CLabelFilter>, Box<CLabelFilter>),
}

impl CLabelFilter {
    fn compile(f: &LabelFilter) -> Result<CLabelFilter, Error> {
        Ok(match f {
            LabelFilter::Matcher(m) => CLabelFilter::Str(StrMatcher::compile(m)?),
            LabelFilter::Number { name, op, value } => CLabelFilter::Num(name.clone(), *op, *value),
            LabelFilter::Duration { name, op, value } => CLabelFilter::Dur(name.clone(), *op, *value),
            LabelFilter::Bytes { name, op, value } => CLabelFilter::Bytes(name.clone(), *op, *value),
            LabelFilter::Ip { name, eq, pattern } => CLabelFilter::Ip(name.clone(), *eq, IpMatcher::parse(pattern).map_err(Error::Eval)?),
            LabelFilter::And(a, b) => CLabelFilter::And(Box::new(Self::compile(a)?), Box::new(Self::compile(b)?)),
            LabelFilter::Or(a, b) => CLabelFilter::Or(Box::new(Self::compile(a)?), Box::new(Self::compile(b)?)),
        })
    }

    /// Does the entry pass? A value that does not convert passes with `LabelFilterErr`.
    fn eval(&self, labels: &mut LabelSet) -> bool {
        fn typed<T>(labels: &mut LabelSet, name: &str, conv: impl Fn(&str) -> Result<T, String>, test: impl Fn(T) -> bool) -> bool {
            let Some(v) = labels.get(name) else { return false };
            match conv(v) {
                Ok(x) => test(x),
                Err(details) => {
                    labels.set_error(ERR_LABEL_FILTER, Some(&details));
                    true
                }
            }
        }
        match self {
            CLabelFilter::Str(m) => m.matches(labels.get(&m.name).unwrap_or("")),
            CLabelFilter::Num(n, op, v) => typed(labels, n, parse_float_label, |x| op.apply(x, *v)),
            CLabelFilter::Dur(n, op, v) => {
                typed(labels, n, |s| parse_go_duration(s).ok_or_else(|| go_duration_error(s)), |x| op.apply(x as f64, *v as f64))
            }
            CLabelFilter::Bytes(n, op, v) => typed(labels, n, |s| parse_bytes(s).ok_or_else(|| bytes_error(s)), |x| op.apply(x, *v)),
            // An entry that already carries an error passes; otherwise the label's value is
            // searched for addresses as a line is (observed in Loki).
            CLabelFilter::Ip(n, eq, m) => {
                if labels.has_error() {
                    return true;
                }
                match labels.get(n) {
                    None => false,
                    Some(v) => m.matches_line(v) == *eq,
                }
            }
            CLabelFilter::And(a, b) => a.eval(labels) && b.eval(labels),
            CLabelFilter::Or(a, b) => a.eval(labels) || b.eval(labels),
        }
    }
}

// ---------- stages ----------

#[derive(Debug, Clone)]
enum LabelFmtC {
    Rename { dst: String, src: String },
    Template { dst: String, t: Template },
}

#[derive(Debug, Clone)]
enum NameM {
    Name(String),
    M(StrMatcher),
}

#[derive(Debug, Clone)]
enum CStage {
    Line(CLineFilter),
    Label(CLabelFilter),
    Json(Option<Vec<(String, JsonPath)>>),
    Logfmt { strict: bool, keep_empty: bool, params: Vec<(String, String)> },
    Regexp(Regex, Vec<String>),
    Pattern(Pattern),
    Unpack,
    LineFormat(Template),
    LabelFormat(Vec<LabelFmtC>),
    Decolorize,
    Drop(Vec<NameM>),
    Keep(Vec<NameM>),
}

/// A compiled pipeline.
#[derive(Debug, Clone)]
pub struct Pipeline {
    stages: Vec<CStage>,
    pub now_ns: Option<i64>,
}

fn template(t: &str) -> Result<Template, Error> {
    Template::parse(t).map_err(|e| match e {
        crate::template::TemplateError::Unsupported(m) => Error::Unsupported(m),
        crate::template::TemplateError::Parse(m) => Error::Eval(m),
    })
}

fn names(items: &[NameOrMatcher]) -> Result<Vec<NameM>, Error> {
    items
        .iter()
        .map(|i| match i {
            NameOrMatcher::Name(n) => Ok(NameM::Name(n.clone())),
            NameOrMatcher::Matcher(m) => Ok(NameM::M(StrMatcher::compile(m)?)),
        })
        .collect()
}

fn is_error_filter(s: &Stage) -> bool {
    matches!(s, Stage::LabelFilter(LabelFilter::Matcher(m)) if m.name == ERROR)
}

/// Within each run of consecutive label-filter stages, filters on `__error__` run last
/// (observed in Loki: `| __error__="" | status > 0` drops lines whose `status` does not
/// convert, as `| status > 0 | __error__=""` does).
pub fn order_stages(stages: &[Stage]) -> Vec<&Stage> {
    let mut out: Vec<&Stage> = Vec::with_capacity(stages.len());
    let mut i = 0;
    while i < stages.len() {
        if !matches!(stages[i], Stage::LabelFilter(_)) {
            out.push(&stages[i]);
            i += 1;
            continue;
        }
        let mut j = i;
        while j < stages.len() && matches!(stages[j], Stage::LabelFilter(_)) {
            j += 1;
        }
        out.extend(stages[i..j].iter().filter(|s| !is_error_filter(s)));
        out.extend(stages[i..j].iter().filter(|s| is_error_filter(s)));
        i = j;
    }
    out
}

impl Pipeline {
    pub fn compile(stages: &[Stage]) -> Result<Pipeline, Error> {
        let mut out = Vec::with_capacity(stages.len());
        for s in order_stages(stages) {
            out.push(match s {
                Stage::LineFilter(f) => CStage::Line(CLineFilter::compile(f)?),
                Stage::LabelFilter(f) => CStage::Label(CLabelFilter::compile(f)?),
                Stage::Json(params) => {
                    if params.is_empty() {
                        CStage::Json(None)
                    } else {
                        let mut ps = Vec::new();
                        for (n, e) in params {
                            ps.push((n.clone(), JsonPath::parse(e).map_err(Error::Eval)?));
                        }
                        CStage::Json(Some(ps))
                    }
                }
                Stage::Logfmt { strict, keep_empty, params } => CStage::Logfmt { strict: *strict, keep_empty: *keep_empty, params: params.clone() },
                Stage::Regexp(re) => {
                    let r = crate::goregex::compile_plain(re).map_err(Error::Eval)?;
                    let names = r.capture_names().map(|n| n.unwrap_or("").to_string()).collect();
                    CStage::Regexp(r, names)
                }
                Stage::Pattern(p) => CStage::Pattern(Pattern::parse(p, true).map_err(Error::Eval)?),
                Stage::Unpack => CStage::Unpack,
                Stage::LineFormat(t) => CStage::LineFormat(template(t)?),
                Stage::LabelFormat(fs) => {
                    let mut c = Vec::new();
                    for f in fs {
                        c.push(match f {
                            LabelFmt::Rename { dst, src } => LabelFmtC::Rename { dst: dst.clone(), src: src.clone() },
                            LabelFmt::Template { dst, template: t } => LabelFmtC::Template { dst: dst.clone(), t: template(t)? },
                        });
                    }
                    CStage::LabelFormat(c)
                }
                Stage::Decolorize => CStage::Decolorize,
                Stage::Drop(items) => CStage::Drop(names(items)?),
                Stage::Keep(items) => CStage::Keep(names(items)?),
            });
        }
        Ok(Pipeline { stages: out, now_ns: None })
    }

    /// Run one entry through the pipeline. Returns the (possibly rewritten) line, or `None`
    /// when a filter drops the entry. `labels` is updated in place.
    pub fn process<'l>(&self, ts_ns: i64, line: &'l str, labels: &mut LabelSet) -> Option<Cow<'l, str>> {
        let mut line: Cow<'l, str> = Cow::Borrowed(line);
        for st in &self.stages {
            match st {
                CStage::Line(f) => {
                    if !f.keep(&line) {
                        return None;
                    }
                }
                CStage::Label(f) => {
                    if !f.eval(labels) {
                        return None;
                    }
                }
                CStage::Json(None) => {
                    let (members, err) = crate::jsonwalk::flatten(&line);
                    for (k, v) in members {
                        let k = sanitize(&k);
                        if !k.is_empty() {
                            labels.add_parsed(&k, &v);
                        }
                    }
                    if let Some(e) = err {
                        labels.set_error(ERR_JSON, Some(e));
                    }
                }
                CStage::Json(Some(params)) => {
                    if line.is_empty() {
                        continue;
                    }
                    if !matches!(line.as_bytes()[0], b'{' | b'[' | b'"') {
                        labels.set_error(ERR_JSON, None);
                        continue;
                    }
                    let mut err = None;
                    for (name, path) in params {
                        match crate::jsonwalk::get(&line, path) {
                            Ok(Some(v)) => labels.add_parsed(name, &v),
                            // Absent (or unreadable) values become empty labels, unless a label
                            // of that name already exists.
                            other => {
                                if let Err(e) = other {
                                    err.get_or_insert(e);
                                }
                                if !labels.has(name) {
                                    labels.add_parsed(name, "");
                                }
                            }
                        }
                    }
                    if let Some(e) = err {
                        labels.set_error(ERR_JSON, Some(e));
                    }
                }
                CStage::Logfmt { strict, keep_empty, params } => {
                    let (pairs, err) = crate::logfmt::scan(&line, *strict);
                    if params.is_empty() {
                        for p in &pairs {
                            if p.empty && !*keep_empty {
                                continue;
                            }
                            let k = sanitize(p.key);
                            if !k.is_empty() {
                                labels.add_parsed(&k, &p.value);
                            }
                        }
                    } else {
                        // Requested keys that are absent become empty labels, unless a label of
                        // that name already exists.
                        for (name, key) in params {
                            match pairs.iter().find(|p| p.key == key) {
                                Some(p) => labels.add_parsed(name, &p.value),
                                None => {
                                    if !labels.has(name) {
                                        labels.add_parsed(name, "");
                                    }
                                }
                            }
                        }
                    }
                    if let Some(e) = err {
                        labels.set_error(ERR_LOGFMT, Some(&e));
                    }
                }
                CStage::Regexp(re, names) => {
                    if let Some(caps) = re.captures(&line) {
                        for (i, n) in names.iter().enumerate() {
                            if n.is_empty() {
                                continue;
                            }
                            if let Some(m) = caps.get(i) {
                                labels.add_parsed(n, m.as_str());
                            }
                        }
                    }
                }
                CStage::Pattern(p) => {
                    let caps: Vec<(String, String)> = p.parse_captures(&line).into_iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
                    for (n, v) in caps {
                        labels.add_parsed(&n, &v);
                    }
                }
                CStage::Unpack => match crate::jsonwalk::unpack(&line) {
                    Ok(Some((ls, entry))) => {
                        for (k, v) in ls {
                            let k = sanitize(&k);
                            if !k.is_empty() {
                                labels.add_parsed(&k, &v);
                            }
                        }
                        line = Cow::Owned(entry);
                    }
                    Ok(None) => {}
                    Err(e) => labels.set_error(ERR_JSON, Some(e)),
                },
                CStage::LineFormat(t) => {
                    if t.constant {
                        line = Cow::Owned(t.render_constant());
                        continue;
                    }
                    let get = |n: &str| labels.get(n).map(str::to_string);
                    let ctx = Ctx { labels: &get, line: &line, ts_ns, now_ns: self.now_ns };
                    match t.execute("line", &ctx) {
                        Ok(s) => line = Cow::Owned(s),
                        Err(e) => labels.set_error(ERR_TEMPLATE, Some(&e)),
                    }
                }
                CStage::LabelFormat(fs) => {
                    let snapshot = labels.clone();
                    for f in fs {
                        match f {
                            LabelFmtC::Rename { dst, src } => {
                                if let Some(v) = snapshot.get(src) {
                                    let v = v.to_string();
                                    if dst != src {
                                        labels.remove(src);
                                    }
                                    labels.set(dst, v, Cat::Parsed);
                                }
                            }
                            LabelFmtC::Template { dst, t } => {
                                let get = |n: &str| snapshot.get(n).map(str::to_string);
                                let ctx = Ctx { labels: &get, line: &line, ts_ns, now_ns: self.now_ns };
                                match t.execute("label", &ctx) {
                                    Ok(s) => labels.set(dst, s, Cat::Parsed),
                                    Err(e) => labels.set_error(ERR_TEMPLATE, Some(&e)),
                                }
                            }
                        }
                    }
                }
                CStage::Decolorize => {
                    if let Cow::Owned(s) = decolorize(&line) {
                        line = Cow::Owned(s);
                    }
                }
                CStage::Drop(items) => {
                    labels.retain(|n, v| {
                        !items.iter().any(|i| match i {
                            NameM::Name(x) => x == n,
                            NameM::M(m) => m.name == n && m.matches(v),
                        })
                    });
                }
                CStage::Keep(items) => {
                    labels.retain(|n, v| {
                        n == ERROR
                            || n == ERROR_DETAILS
                            || items.iter().any(|i| match i {
                                NameM::Name(x) => x == n,
                                NameM::M(m) => m.name == n && m.matches(v),
                            })
                    });
                }
            }
        }
        Some(line)
    }
}

/// The value an unwrap stage takes from a label: `None` when the label is absent (the
/// sample is skipped), an error (with Go's message) when it does not convert.
pub fn unwrap_value(v: &str, conv: UnwrapConv) -> Result<f64, String> {
    match conv {
        UnwrapConv::None => parse_float_label(v),
        UnwrapConv::Duration => parse_go_duration(v).map(|ns| ns as f64 / 1e9).ok_or_else(|| go_duration_error(v)),
        UnwrapConv::Bytes => parse_bytes(v).ok_or_else(|| bytes_error(v)),
    }
}

/// Compiled post-unwrap label filters.
#[derive(Debug, Clone)]
pub struct PostFilters(Vec<CLabelFilter>);

impl PostFilters {
    pub fn compile(fs: &[LabelFilter]) -> Result<PostFilters, Error> {
        Ok(PostFilters(fs.iter().map(CLabelFilter::compile).collect::<Result<_, _>>()?))
    }
    pub fn keep(&self, labels: &mut LabelSet) -> bool {
        self.0.iter().all(|f| f.eval(labels))
    }
}
