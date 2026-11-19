//! A subset of Go's `text/template`, implemented from the package documentation, with the
//! functions the LogQL template documentation lists. Used by `line_format` and
//! `label_format`.
//!
//! Supported: text and actions with `{{-`/`-}}` trimming, comments, pipelines with `|`,
//! fields (`.a`, `.a.b`), `.`, variables (`$`, `$x`, `$x := …`, `$x = …`), literals
//! (strings, raw strings, characters, numbers, `true`, `false`, `nil`), parenthesised
//! pipelines, `if`/`else if`/`else`, `range` (with `else`, `break`, `continue`), `with`
//! (with `else`). Not supported (refused as `Unsupported`): `define`, `template`, `block`,
//! the `call` function.

pub mod funcs;
pub mod gofmt;
pub mod gotime;
pub mod value;

use std::rc::Rc;
pub use value::V;

#[derive(Debug, Clone, PartialEq)]
pub enum TemplateError {
    Parse(String),
    Unsupported(String),
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TemplateError::Parse(m) | TemplateError::Unsupported(m) => f.write_str(m),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Arg {
    Dot,
    /// `.a.b`; `pos` of the error context is that of the second segment when chained.
    Field(Vec<String>),
    Var(String, Vec<String>),
    Func(String),
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    Nil,
    Pipe(Box<Pipe>, Vec<String>),
}

#[derive(Debug, Clone, PartialEq)]
struct Cmd {
    args: Vec<Arg>,
    pos: usize,
    text: String,
}

#[derive(Debug, Clone, PartialEq)]
struct Pipe {
    decl: Vec<String>,
    assign: bool,
    cmds: Vec<Cmd>,
}

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Text(String),
    Action(Pipe),
    If(Pipe, Vec<Node>, Vec<Node>),
    Range(Pipe, Vec<Node>, Vec<Node>),
    With(Pipe, Vec<Node>, Vec<Node>),
    Break,
    Continue,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Template {
    nodes: Vec<Node>,
    src: String,
    /// True when the template has no actions: its output is the text itself.
    pub constant: bool,
}

// ---------- lexing of actions ----------

#[derive(Debug, Clone, PartialEq)]
enum T {
    Dot,
    /// A field; `true` when it directly follows the previous operand (`.a.b`, `$x.f`).
    Field(String, bool),
    Var(String),
    Ident(String),
    Str(String),
    Char(i64),
    Num(String),
    LParen,
    RParen,
    Pipe,
    Declare,
    Assign,
    Comma,
}

fn lex_action(src: &str, base: usize) -> Result<Vec<(T, usize)>, String> {
    let b = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let pos = base + i;
        match c {
            b' ' | b'\t' | b'\r' | b'\n' => i += 1,
            b'(' => {
                out.push((T::LParen, pos));
                i += 1;
            }
            b')' => {
                out.push((T::RParen, pos));
                i += 1;
            }
            b'|' => {
                out.push((T::Pipe, pos));
                i += 1;
            }
            b',' => {
                out.push((T::Comma, pos));
                i += 1;
            }
            b':' if b.get(i + 1) == Some(&b'=') => {
                out.push((T::Declare, pos));
                i += 2;
            }
            b'=' => {
                out.push((T::Assign, pos));
                i += 1;
            }
            b'.' if !b.get(i + 1).is_some_and(|x| x.is_ascii_alphanumeric() || *x == b'_') => {
                if b.get(i + 1).is_some_and(|x| x.is_ascii_digit()) {
                    let (t, n) = lex_num(&src[i..])?;
                    out.push((t, pos));
                    i += n;
                } else {
                    out.push((T::Dot, pos));
                    i += 1;
                }
            }
            b'.' if b.get(i + 1).is_some_and(|x| x.is_ascii_digit()) => {
                let (t, n) = lex_num(&src[i..])?;
                out.push((t, pos));
                i += n;
            }
            b'.' => {
                let s = i + 1;
                let mut j = s;
                while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] >= 0x80) {
                    j += 1;
                }
                let attached = i > 0 && matches!(out.last(), Some((T::Field(..) | T::Var(_) | T::RParen, _))) && !b[i - 1].is_ascii_whitespace();
                out.push((T::Field(src[s..j].to_string(), attached), pos));
                i = j;
            }
            b'$' => {
                let s = i + 1;
                let mut j = s;
                while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                    j += 1;
                }
                out.push((T::Var(format!("${}", &src[s..j])), pos));
                i = j;
            }
            b'"' | b'`' => {
                let q = c;
                let mut j = i + 1;
                while j < b.len() && b[j] != q {
                    if q == b'"' && b[j] == b'\\' {
                        j += 1;
                    }
                    j += 1;
                }
                if j >= b.len() {
                    return Err("unterminated quoted string".into());
                }
                let raw = &src[i..=j];
                let s = crate::text::unquote_go(raw).map_err(|e| format!("{e}: {raw}"))?;
                out.push((T::Str(s), pos));
                i = j + 1;
            }
            b'\'' => {
                let mut j = i + 1;
                while j < b.len() && b[j] != b'\'' {
                    if b[j] == b'\\' {
                        j += 1;
                    }
                    j += 1;
                }
                if j >= b.len() {
                    return Err("unterminated character constant".into());
                }
                let inner = &src[i + 1..j];
                let s = crate::text::unquote_go(&format!("\"{}\"", inner.replace('"', "\\\""))).map_err(|e| e.to_string())?;
                let mut cs = s.chars();
                let ch = cs.next().ok_or("empty character constant")?;
                if cs.next().is_some() {
                    return Err(format!("malformed character constant: '{inner}'"));
                }
                out.push((T::Char(ch as i64), pos));
                i = j + 1;
            }
            b'-' | b'+' | b'0'..=b'9' => {
                let (t, n) = lex_num(&src[i..])?;
                out.push((t, pos));
                i += n;
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let mut j = i;
                while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                    j += 1;
                }
                out.push((T::Ident(src[i..j].to_string()), pos));
                i = j;
            }
            _ => return Err(format!("unexpected {:?} in command", src[i..].chars().next().unwrap_or(' '))),
        }
    }
    Ok(out)
}

fn lex_num(s: &str) -> Result<(T, usize), String> {
    let b = s.as_bytes();
    let mut j = 0;
    if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
        j += 1;
    }
    while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'.' || b[j] == b'_' || ((b[j] == b'+' || b[j] == b'-') && j > 0 && matches!(b[j - 1], b'e' | b'E' | b'p' | b'P'))) {
        j += 1;
    }
    if j == 0 || (j == 1 && (b[0] == b'+' || b[0] == b'-')) {
        return Err(format!("bad number syntax: {:?}", &s[..j.max(1)]));
    }
    Ok((T::Num(s[..j].to_string()), j))
}

fn number(text: &str) -> Result<Arg, String> {
    let t = text.replace('_', "");
    let (neg, body) = match t.strip_prefix('-') {
        Some(r) => (true, r.to_string()),
        None => (false, t.trim_start_matches('+').to_string()),
    };
    let lower = body.to_ascii_lowercase();
    let int = if let Some(h) = lower.strip_prefix("0x") {
        i64::from_str_radix(h, 16).ok()
    } else if let Some(o) = lower.strip_prefix("0o") {
        i64::from_str_radix(o, 8).ok()
    } else if let Some(bn) = lower.strip_prefix("0b") {
        i64::from_str_radix(bn, 2).ok()
    } else if lower.len() > 1 && lower.starts_with('0') && lower.bytes().all(|c| c.is_ascii_digit()) {
        i64::from_str_radix(&lower[1..], 8).ok()
    } else {
        lower.parse::<i64>().ok()
    };
    if let Some(v) = int {
        return Ok(Arg::Int(if neg { -v } else { v }));
    }
    match lower.parse::<f64>() {
        Ok(v) if !lower.starts_with("in") && !lower.starts_with("na") => Ok(Arg::Float(if neg { -v } else { v })),
        _ => Err(format!("bad number syntax: {text:?}")),
    }
}

// ---------- parsing ----------

struct P<'a> {
    toks: Vec<(T, usize)>,
    i: usize,
    src: &'a str,
}

impl P<'_> {
    fn peek(&self) -> Option<&T> {
        self.toks.get(self.i).map(|t| &t.0)
    }
    fn pos(&self) -> usize {
        self.toks.get(self.i).map(|t| t.1).unwrap_or(self.src.len())
    }

    fn pipeline(&mut self, allow_decl: bool, range_decl: bool) -> Result<Pipe, String> {
        let mut decl = Vec::new();
        let mut assign = false;
        // `$x :=`, `$x =`, `$i, $x :=`
        if allow_decl {
            let save = self.i;
            let mut vars = Vec::new();
            while let Some(T::Var(v)) = self.peek().cloned() {
                self.i += 1;
                vars.push(v);
                match self.peek() {
                    Some(T::Comma) if range_decl && vars.len() == 1 => {
                        self.i += 1;
                        continue;
                    }
                    Some(T::Declare) => {
                        self.i += 1;
                        decl = vars.clone();
                        break;
                    }
                    Some(T::Assign) => {
                        self.i += 1;
                        decl = vars.clone();
                        assign = true;
                        break;
                    }
                    _ => {
                        self.i = save;
                        vars.clear();
                        break;
                    }
                }
            }
        }
        let mut cmds = Vec::new();
        loop {
            cmds.push(self.command()?);
            match self.peek() {
                Some(T::Pipe) => {
                    self.i += 1;
                }
                _ => break,
            }
        }
        Ok(Pipe { decl, assign, cmds })
    }

    fn command(&mut self) -> Result<Cmd, String> {
        let pos = self.pos();
        let mut args = Vec::new();
        let mut texts = Vec::new();
        loop {
            match self.peek() {
                None | Some(T::Pipe) | Some(T::RParen) => break,
                _ => {}
            }
            let (a, t) = self.operand()?;
            args.push(a);
            texts.push(t);
        }
        if args.is_empty() {
            return Err("missing value for command".into());
        }
        Ok(Cmd { args, pos, text: texts.join(" ") })
    }

    fn fields(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        while let Some(T::Field(f, true)) = self.peek().cloned() {
            out.push(f);
            self.i += 1;
        }
        out
    }

    fn operand(&mut self) -> Result<(Arg, String), String> {
        let Some((t, _)) = self.toks.get(self.i).cloned() else {
            return Err("unexpected end of action".into());
        };
        self.i += 1;
        let r = match t {
            T::Dot => (Arg::Dot, ".".to_string()),
            T::Field(f, _) => {
                let mut fs = vec![f];
                fs.extend(self.fields());
                let text = fs.iter().map(|f| format!(".{f}")).collect::<String>();
                (Arg::Field(fs), text)
            }
            T::Var(v) => {
                let fs = self.fields();
                let text = format!("{v}{}", fs.iter().map(|f| format!(".{f}")).collect::<String>());
                (Arg::Var(v, fs), text)
            }
            T::Ident(id) => match id.as_str() {
                "true" => (Arg::Bool(true), id),
                "false" => (Arg::Bool(false), id),
                "nil" => (Arg::Nil, id),
                "define" | "template" | "block" | "call" => return Err(format!("unsupported:{id}")),
                "if" | "else" | "end" | "range" | "with" | "break" | "continue" => return Err(format!("unexpected {id} in operand")),
                _ => {
                    if !funcs::exists(&id) {
                        return Err(format!("function {id:?} not defined"));
                    }
                    (Arg::Func(id.clone()), id)
                }
            },
            T::Str(s) => {
                let text = gofmt::go_quote(&s);
                (Arg::Str(s), text)
            }
            T::Char(c) => (Arg::Int(c), format!("{c}")),
            T::Num(n) => (number(&n)?, n),
            T::LParen => {
                let p = self.pipeline(true, false)?;
                if self.peek() != Some(&T::RParen) {
                    return Err("unclosed left paren".into());
                }
                self.i += 1;
                let fs = self.fields();
                let inner: Vec<String> = p.cmds.iter().map(|c| c.text.clone()).collect();
                let text = format!("({}){}", inner.join(" | "), fs.iter().map(|f| format!(".{f}")).collect::<String>());
                (Arg::Pipe(Box::new(p), fs), text)
            }
            other => return Err(format!("unexpected {other:?} in operand")),
        };
        Ok(r)
    }
}

enum Item {
    Text(String),
    /// Action tokens.
    Action(Vec<(T, usize)>),
}

fn split(src: &str) -> Result<Vec<Item>, String> {
    let mut items = Vec::new();
    let mut rest = 0;
    let mut text = String::new();
    while rest < src.len() {
        let Some(open) = src[rest..].find("{{") else {
            text.push_str(&src[rest..]);
            break;
        };
        let open = rest + open;
        text.push_str(&src[rest..open]);
        let mut body_start = open + 2;
        // `{{- ` trims whitespace before.
        if src[body_start..].starts_with('-') && src[body_start + 1..].starts_with([' ', '\t', '\r', '\n']) {
            text = text.trim_end_matches([' ', '\t', '\r', '\n']).to_string();
            body_start += 1;
        }
        let Some(close_rel) = find_close(&src[body_start..]) else {
            return Err("unclosed action".into());
        };
        let close = body_start + close_rel;
        let mut body_end = close;
        let mut trim_after = false;
        if close >= 2 && src[..close].ends_with('-') && src[..close - 1].ends_with([' ', '\t', '\r', '\n']) && close - 1 >= body_start {
            body_end = close - 1;
            trim_after = true;
        }
        if !text.is_empty() {
            items.push(Item::Text(std::mem::take(&mut text)));
        }
        let body = &src[body_start..body_end];
        let trimmed = body.trim_start();
        if trimmed.starts_with("/*") {
            if !body.trim_end().ends_with("*/") {
                return Err("comment ends before closing delimiter".into());
            }
        } else {
            let toks = lex_action(body, body_start)?;
            items.push(Item::Action(toks));
        }
        rest = close + 2;
        if trim_after {
            let t = src[rest..].len() - src[rest..].trim_start_matches([' ', '\t', '\r', '\n']).len();
            rest += t;
        }
    }
    if !text.is_empty() {
        items.push(Item::Text(text));
    }
    Ok(items)
}

/// Find `}}` that closes an action, skipping quoted strings.
fn find_close(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        match b[i] {
            b'"' | b'`' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    if q != b'`' && b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i += 1;
            }
            b'}' if b[i + 1] == b'}' => return Some(i),
            _ => i += 1,
        }
    }
    None
}

struct Builder<'a> {
    items: Vec<Item>,
    i: usize,
    src: &'a str,
    range_depth: usize,
}

enum End {
    Eof,
    End,
    Else(Vec<(T, usize)>),
}

impl Builder<'_> {
    fn list(&mut self) -> Result<(Vec<Node>, End), TemplateError> {
        let mut out = Vec::new();
        while self.i < self.items.len() {
            let item = std::mem::replace(&mut self.items[self.i], Item::Text(String::new()));
            self.i += 1;
            match item {
                Item::Text(t) => out.push(Node::Text(t)),
                Item::Action(toks) => {
                    let kw = match toks.first() {
                        Some((T::Ident(k), _)) => k.clone(),
                        _ => String::new(),
                    };
                    match kw.as_str() {
                        "end" => return Ok((out, End::End)),
                        "else" => return Ok((out, End::Else(toks[1..].to_vec()))),
                        "if" | "with" | "range" => {
                            let node = self.control(&kw, toks[1..].to_vec())?;
                            out.push(node);
                        }
                        "break" | "continue" => {
                            if self.range_depth == 0 {
                                return Err(TemplateError::Parse(format!("{{{{{kw}}}}} outside {{{{range}}}}")));
                            }
                            out.push(if kw == "break" { Node::Break } else { Node::Continue });
                        }
                        "define" | "template" | "block" => {
                            return Err(TemplateError::Unsupported(format!("template action {kw:?} is not supported")));
                        }
                        _ => {
                            let mut p = P { toks, i: 0, src: self.src };
                            let pipe = p.pipeline(true, false).map_err(map_err)?;
                            if p.i != p.toks.len() {
                                return Err(TemplateError::Parse("unexpected token in action".into()));
                            }
                            out.push(Node::Action(pipe));
                        }
                    }
                }
            }
        }
        Ok((out, End::Eof))
    }

    fn control(&mut self, kw: &str, toks: Vec<(T, usize)>) -> Result<Node, TemplateError> {
        let mut p = P { toks, i: 0, src: self.src };
        let pipe = p.pipeline(true, kw == "range").map_err(map_err)?;
        if p.i != p.toks.len() {
            return Err(TemplateError::Parse(format!("unexpected token in {kw}")));
        }
        if kw == "range" {
            self.range_depth += 1;
        }
        let (body, end) = self.list()?;
        if kw == "range" {
            self.range_depth -= 1;
        }
        let else_list = match end {
            End::Eof => return Err(TemplateError::Parse(format!("unexpected EOF in {kw}"))),
            End::End => Vec::new(),
            End::Else(rest) => {
                if let Some((T::Ident(k), _)) = rest.first() {
                    if (k == "if" && kw == "if") || (k == "with" && kw == "with") {
                        // `else if` / `else with`: a nested control that consumes the `end`.
                        let nested = self.control(k, rest[1..].to_vec())?;
                        vec![nested]
                    } else {
                        return Err(TemplateError::Parse("unexpected token after else".into()));
                    }
                } else if !rest.is_empty() {
                    return Err(TemplateError::Parse("unexpected token after else".into()));
                } else {
                    let (l, e) = self.list()?;
                    match e {
                        End::End => l,
                        _ => return Err(TemplateError::Parse(format!("expected end after else in {kw}"))),
                    }
                }
            }
        };
        Ok(match kw {
            "if" => Node::If(pipe, body, else_list),
            "with" => Node::With(pipe, body, else_list),
            _ => Node::Range(pipe, body, else_list),
        })
    }
}

fn map_err(e: String) -> TemplateError {
    match e.strip_prefix("unsupported:") {
        Some(f) => TemplateError::Unsupported(format!("template function or action {f:?} is not supported")),
        None => TemplateError::Parse(e),
    }
}

impl Template {
    pub fn parse(src: &str) -> Result<Template, TemplateError> {
        let items = split(src).map_err(TemplateError::Parse)?;
        let constant = items.iter().all(|i| matches!(i, Item::Text(_)));
        let mut b = Builder { items, i: 0, src, range_depth: 0 };
        let (nodes, end) = b.list()?;
        match end {
            End::Eof => {}
            End::End => return Err(TemplateError::Parse("unexpected {{end}}".into())),
            End::Else(_) => return Err(TemplateError::Parse("unexpected {{else}}".into())),
        }
        // Variables must be declared before use.
        let mut scope = vec!["$".to_string()];
        check_vars(&nodes, &mut scope)?;
        Ok(Template { nodes, src: src.to_string(), constant })
    }

    /// The output of a template without actions.
    pub fn render_constant(&self) -> String {
        self.nodes
            .iter()
            .map(|n| match n {
                Node::Text(t) => t.as_str(),
                _ => "",
            })
            .collect()
    }

    /// Execute with `data` as the root map. `name` is used in error messages (`line`,
    /// `label`).
    pub fn execute(&self, name: &str, ctx: &Ctx<'_>) -> Result<String, String> {
        let mut ex = Exec { ctx, vars: vec![("$".to_string(), V::Nil)], out: String::new(), name, src: &self.src, steps: 0 };
        match ex.list(&self.nodes, &Dotv::Root) {
            Ok(_) => Ok(ex.out),
            Err(e) => Err(e),
        }
    }
}

fn check_vars(nodes: &[Node], scope: &mut Vec<String>) -> Result<(), TemplateError> {
    fn pipe(p: &Pipe, scope: &mut Vec<String>) -> Result<(), TemplateError> {
        for c in &p.cmds {
            for a in &c.args {
                arg(a, scope)?;
            }
        }
        if !p.assign {
            scope.extend(p.decl.iter().cloned());
        } else {
            for d in &p.decl {
                if !scope.contains(d) {
                    return Err(TemplateError::Parse(format!("undefined variable {d:?}")));
                }
            }
        }
        Ok(())
    }
    fn arg(a: &Arg, scope: &mut Vec<String>) -> Result<(), TemplateError> {
        match a {
            Arg::Var(v, _) if !scope.contains(v) => Err(TemplateError::Parse(format!("undefined variable {v:?}"))),
            Arg::Pipe(p, _) => pipe(p, scope),
            _ => Ok(()),
        }
    }
    for n in nodes {
        match n {
            Node::Action(p) => pipe(p, scope)?,
            Node::If(p, a, b) | Node::With(p, a, b) | Node::Range(p, a, b) => {
                let mark = scope.len();
                pipe(p, scope)?;
                check_vars(a, scope)?;
                check_vars(b, scope)?;
                scope.truncate(mark);
            }
            _ => {}
        }
    }
    Ok(())
}

// ---------- execution ----------

/// What a template can see: the entry's labels, line and timestamp, and the caller's clock.
pub struct Ctx<'a> {
    pub labels: &'a dyn Fn(&str) -> Option<String>,
    pub line: &'a str,
    pub ts_ns: i64,
    pub now_ns: Option<i64>,
}

enum Dotv {
    Root,
    Val(V),
}

enum Flow {
    Normal,
    Break,
    Continue,
}

/// Upper bound on loop iterations and function calls per execution, so a template cannot
/// run unbounded on a crafted input.
const MAX_STEPS: usize = 1_000_000;

struct Exec<'a, 'c> {
    ctx: &'a Ctx<'c>,
    vars: Vec<(String, V)>,
    out: String,
    name: &'a str,
    src: &'a str,
    steps: usize,
}

impl Exec<'_, '_> {
    fn err_at(&self, pos: usize, text: &str, msg: &str) -> String {
        let before = &self.src[..pos.min(self.src.len())];
        let line = 1 + before.matches('\n').count();
        let col = pos - before.rfind('\n').map(|i| i + 1).unwrap_or(0);
        let ctx = if text.chars().count() > 20 { format!("{}...", text.chars().take(20).collect::<String>()) } else { text.to_string() };
        format!("template: {n}:{line}:{col}: executing \"{n}\" at <{ctx}>: {msg}", n = self.name)
    }

    fn step(&mut self) -> Result<(), String> {
        self.steps += 1;
        if self.steps > MAX_STEPS {
            return Err(format!("template: {}: execution exceeded {MAX_STEPS} steps", self.name));
        }
        Ok(())
    }

    fn list(&mut self, nodes: &[Node], dot: &Dotv) -> Result<Flow, String> {
        for n in nodes {
            match n {
                Node::Text(t) => self.out.push_str(t),
                Node::Action(p) => {
                    let v = self.pipe(p, dot)?;
                    if p.decl.is_empty() {
                        self.print(&v);
                    }
                }
                Node::If(p, a, b) => {
                    let mark = self.vars.len();
                    let v = self.pipe(p, dot)?;
                    let f = if v.truthy() { self.list(a, dot)? } else { self.list(b, dot)? };
                    self.vars.truncate(mark);
                    if !matches!(f, Flow::Normal) {
                        return Ok(f);
                    }
                }
                Node::With(p, a, b) => {
                    let mark = self.vars.len();
                    let v = self.pipe(p, dot)?;
                    let f = if v.truthy() { self.list(a, &Dotv::Val(v))? } else { self.list(b, dot)? };
                    self.vars.truncate(mark);
                    if !matches!(f, Flow::Normal) {
                        return Ok(f);
                    }
                }
                Node::Range(p, a, b) => {
                    let mark = self.vars.len();
                    // The declared variables are bound per element, not to the pipeline value.
                    let decl = p.decl.clone();
                    let inner = Pipe { decl: Vec::new(), assign: false, cmds: p.cmds.clone() };
                    let v = self.pipe(&inner, dot)?;
                    let elems: Vec<(V, V)> = match &v {
                        V::List(l) => l.iter().enumerate().map(|(i, x)| (V::Int(i as i64), x.clone())).collect(),
                        V::Map(m) => m.iter().map(|(k, x)| (V::Str(k.clone()), x.clone())).collect(),
                        V::Int(n) => (0..*n).map(|i| (V::Int(i), V::Int(i))).collect(),
                        V::Nil | V::NoValue => Vec::new(),
                        other => {
                            let c = &p.cmds[0];
                            return Err(self.err_at(c.pos, &c.text, &format!("range can't iterate over {}", gofmt::value_v(other))));
                        }
                    };
                    if elems.is_empty() {
                        self.list(b, dot)?;
                    }
                    for (k, x) in elems {
                        self.step()?;
                        let m2 = self.vars.len();
                        match decl.len() {
                            1 => self.vars.push((decl[0].clone(), x.clone())),
                            2 => {
                                self.vars.push((decl[0].clone(), k));
                                self.vars.push((decl[1].clone(), x.clone()));
                            }
                            _ => {}
                        }
                        let f = self.list(a, &Dotv::Val(x))?;
                        self.vars.truncate(m2);
                        if matches!(f, Flow::Break) {
                            break;
                        }
                    }
                    self.vars.truncate(mark);
                }
                Node::Break => return Ok(Flow::Break),
                Node::Continue => return Ok(Flow::Continue),
            }
        }
        Ok(Flow::Normal)
    }

    fn print(&mut self, v: &V) {
        match v {
            V::Nil | V::NoValue => self.out.push_str("<no value>"),
            other => self.out.push_str(&gofmt::value_v(other)),
        }
    }

    fn pipe(&mut self, p: &Pipe, dot: &Dotv) -> Result<V, String> {
        let mut val: Option<V> = None;
        for c in &p.cmds {
            val = Some(self.command(c, dot, val)?);
        }
        let v = val.unwrap_or(V::Nil);
        if !p.decl.is_empty() {
            if p.assign {
                for d in &p.decl {
                    if let Some(slot) = self.vars.iter_mut().rev().find(|(n, _)| n == d) {
                        slot.1 = v.clone();
                    }
                }
            } else {
                for d in &p.decl {
                    self.vars.push((d.clone(), v.clone()));
                }
            }
        }
        Ok(v)
    }

    fn dot_value(&self, dot: &Dotv) -> V {
        match dot {
            Dotv::Root => V::Map(Rc::new(Vec::new())),
            Dotv::Val(v) => v.clone(),
        }
    }

    fn command(&mut self, c: &Cmd, dot: &Dotv, final_: Option<V>) -> Result<V, String> {
        self.step()?;
        let first = &c.args[0];
        if let Arg::Func(name) = first {
            let mut args = Vec::with_capacity(c.args.len());
            for a in &c.args[1..] {
                args.push(self.arg(a, dot, c)?);
            }
            if let Some(f) = final_ {
                args.push(f);
            }
            return self.call(name, args, c);
        }
        if c.args.len() > 1 || final_.is_some() {
            if let Arg::Field(fs) = first {
                let text = fs.iter().map(|x| format!(".{x}")).collect::<String>();
                let last = fs.last().map(String::as_str).unwrap_or("");
                return Err(self.err_at(c.pos, &text, &format!("{last} is not a method but has arguments")));
            }
            return Err(self.err_at(c.pos, &c.text, &format!("can't give argument to non-function {}", c.text.split(' ').next().unwrap_or(""))));
        }
        self.arg(first, dot, c)
    }

    fn call(&mut self, name: &str, args: Vec<V>, c: &Cmd) -> Result<V, String> {
        match name {
            "and" | "or" => {
                if args.is_empty() {
                    return Err(self.err_at(c.pos, &c.text, &format!("wrong number of args for {name}: want at least 1 got 0")));
                }
                let and = name == "and";
                for a in &args {
                    if a.truthy() != and {
                        return Ok(a.clone());
                    }
                }
                return Ok(args.last().cloned().unwrap_or(V::Nil));
            }
            _ => {}
        }
        let fc = funcs::FnCtx { line: self.ctx.line, ts_ns: self.ctx.ts_ns, now_ns: self.ctx.now_ns };
        funcs::call(name, &args, &fc).map_err(|e| match e {
            funcs::CallError::Msg(m) => self.err_at(c.pos, name, &m),
            funcs::CallError::Calling(m) => self.err_at(c.pos, &c.text, &format!("error calling {name}: {m}")),
        })
    }

    fn lookup_var(&self, v: &str) -> V {
        if v == "$" {
            return V::Nil; // the root map is handled as `Dotv::Root`
        }
        self.vars.iter().rev().find(|(n, _)| n == v).map(|(_, x)| x.clone()).unwrap_or(V::Nil)
    }

    fn arg(&mut self, a: &Arg, dot: &Dotv, c: &Cmd) -> Result<V, String> {
        Ok(match a {
            Arg::Dot => self.dot_value(dot),
            Arg::Field(fs) => self.fields(dot, fs, c)?,
            Arg::Var(v, fs) => {
                if v == "$" {
                    self.fields(&Dotv::Root, fs, c)?
                } else {
                    let base = self.lookup_var(v);
                    self.fields(&Dotv::Val(base), fs, c)?
                }
            }
            Arg::Func(name) => self.call(name, Vec::new(), c)?,
            Arg::Str(s) => V::Str(s.clone()),
            Arg::Int(i) => V::Int(*i),
            Arg::Float(f) => V::Float(*f),
            Arg::Bool(b) => V::Bool(*b),
            Arg::Nil => V::Nil,
            Arg::Pipe(p, fs) => {
                let mark = self.vars.len();
                let v = self.pipe(p, dot)?;
                self.vars.truncate(mark);
                self.fields(&Dotv::Val(v), fs, c)?
            }
        })
    }

    fn fields(&self, dot: &Dotv, fs: &[String], c: &Cmd) -> Result<V, String> {
        let mut cur: V;
        let mut rest = fs;
        match dot {
            Dotv::Root => {
                let Some((first, r)) = fs.split_first() else {
                    return Ok(V::Map(Rc::new(Vec::new())));
                };
                cur = match (self.ctx.labels)(first) {
                    Some(v) => V::Str(v),
                    None => V::Str(String::new()),
                };
                rest = r;
            }
            Dotv::Val(v) => cur = v.clone(),
        }
        for f in rest {
            cur = match &cur {
                V::Map(m) => m.iter().find(|(k, _)| k == f).map(|(_, v)| v.clone()).unwrap_or(V::NoValue),
                V::Nil | V::NoValue => {
                    return Err(self.err_at(c.pos, &c.text, &format!("nil pointer evaluating interface {{}}.{f}")));
                }
                other => {
                    // The context is the field chain itself.
                    let pos = field_pos(self.src, c.pos, fs);
                    let text = fs.iter().map(|x| format!(".{x}")).collect::<String>();
                    return Err(self.err_at(pos, &text, &format!("can't evaluate field {f} in type {}", other.type_name())));
                }
            };
        }
        Ok(cur)
    }
}

/// Go reports a chained field (`.a.b`) at the position of its second segment.
fn field_pos(src: &str, cmd_pos: usize, fs: &[String]) -> usize {
    if fs.len() < 2 {
        return cmd_pos;
    }
    let needle = format!(".{}.{}", fs[0], fs[1]);
    match src[cmd_pos.min(src.len())..].find(&needle) {
        Some(off) => cmd_pos + off + fs[0].len() + 1,
        None => cmd_pos,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(t: &str, labels: &[(&str, &str)]) -> Result<String, String> {
        let tpl = Template::parse(t).map_err(|e| e.to_string())?;
        let l = |n: &str| labels.iter().find(|(k, _)| *k == n).map(|(_, v)| v.to_string());
        let ctx = Ctx { labels: &l, line: "the line", ts_ns: 1_000_000_000, now_ns: None };
        tpl.execute("line", &ctx)
    }

    #[test]
    fn basics() {
        assert_eq!(run("[{{.missing}}|{{.level}}]", &[("level", "info")]).unwrap(), "[|info]");
        assert_eq!(run("{{ if eq .a \"1\" }}one{{ else if .b }}b{{ else }}none{{ end }}", &[("b", "x")]).unwrap(), "b");
        assert_eq!(run("{{- \"a\" -}}  {{ \"b\" }}", &[]).unwrap(), "ab");
        assert_eq!(run("{{/* c */}}x", &[]).unwrap(), "x");
        assert_eq!(run("{{ $x := upper .a }}{{ $x }}{{ $x = \"z\" }}{{ $x }}", &[("a", "q")]).unwrap(), "Qz");
        assert_eq!(run("{{ range $i, $x := fromJson \"[1,\\\"a\\\"]\" }}{{$i}}={{$x}};{{ end }}", &[]).unwrap(), "0=1;1=a;");
        assert_eq!(run("{{ with .a }}[{{.}}]{{ else }}none{{ end }}", &[]).unwrap(), "none");
        assert_eq!(run("{{ __line__ | upper }} {{ __timestamp__ | unixEpoch }}", &[]).unwrap(), "THE LINE 1");
    }

    #[test]
    fn errors_like_go() {
        assert_eq!(
            run("{{.a | div 0}}", &[("a", "x")]).unwrap_err(),
            "template: line:1:7: executing \"line\" at <div 0>: error calling div: runtime error: integer divide by zero"
        );
        assert_eq!(
            run("{{ .a.b }}", &[("a", "1")]).unwrap_err(),
            "template: line:1:5: executing \"line\" at <.a.b>: can't evaluate field b in type string"
        );
        assert!(Template::parse("{{ nosuch }}").is_err());
        assert!(matches!(Template::parse("{{ template \"x\" }}"), Err(TemplateError::Unsupported(_))));
        assert!(Template::parse("{{ if .a }}").is_err());
        assert!(Template::parse("{{ $y }}").is_err());
    }
}
