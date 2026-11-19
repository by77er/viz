//! Recursive-descent / precedence-climbing parser and validator for TraceQL, written from
//! Tempo's public documentation. Which queries are accepted, rejected or unsupported is
//! checked against Tempo's own list of examples (`tests/conformance.rs`).
//!
//! The top level of TraceQL mixes three languages (spanset expressions, scalar filters and
//! metrics arithmetic) that share tokens: `>` is a structural operator between spansets and
//! a comparison after a metrics function. The parser first builds a neutral [`Node`] tree,
//! deciding `>`/`<` by what stands on their left, and then converts it to a typed
//! [`RootExpr`], which is where most validation happens.

use crate::ast::*;
use crate::data::{Kind, Status};
use crate::lexer::{lex, Tok, Token};
use crate::Error;

pub fn parse(src: &str) -> Result<RootExpr, Error> {
    parse_measured(src).map(|(root, _)| root)
}

/// The deepest nesting a query reaches as [`MAX_DEPTH`] counts it: the larger of the
/// parser's recursion depth and the height of the syntax tree. A query whose nesting is at
/// most `MAX_DEPTH` is not refused for depth. Used to measure real queries against the
/// limit (README, "Limits").
pub fn nesting(src: &str) -> Result<usize, Error> {
    parse_measured(src).map(|(_, peak)| peak)
}

fn parse_measured(src: &str) -> Result<(RootExpr, usize), Error> {
    if src.len() > MAX_QUERY_BYTES {
        return Err(Error::Validation { pos: 0, line: 1, col: 1, msg: format!("query longer than {MAX_QUERY_BYTES} bytes") });
    }
    let toks = lex(src)?;
    let mut p = Parser { src, toks, i: 0, depth: 0, regexes: 0, peak: std::cell::Cell::new(0) };
    if matches!(p.peek(), Tok::Eof) {
        return Err(p.err_here("empty query"));
    }
    let (node, _) = p.pipeline()?;
    let mut hints = Vec::new();
    if p.peek_ident("with") {
        p.next();
        hints = p.hints()?;
    }
    if !matches!(p.peek(), Tok::Eof) {
        return Err(p.err_here(format!("unexpected {}", describe(p.peek()))));
    }
    let query = p.convert(node)?;
    Ok((RootExpr { query, hints }, p.peak.get()))
}

/// Longest accepted query text.
pub const MAX_QUERY_BYTES: usize = 128 * 1024;

/// Deepest accepted nesting. Two things are bounded by it, so that no recursion over a query
/// can exhaust the stack (a stack overflow aborts a WASM isolate; it is not an error):
///
/// - the parser's own recursion, counted on the way down: braces, unary operators, the right
///   operand of `^`, each precedence level entered, and parentheses (two levels each,
///   since each recurses through several functions);
/// - the height of the syntax tree it builds, counted on the way up. A chain such as
///   `a && b && c` or `{ } >> { } >> { }` is parsed by a loop but builds a tree one level
///   deeper per operator, and every later pass (validation, conversion, planning,
///   evaluation, and dropping the tree) recurses over that height.
///
/// So a query refused here never reaches a recursive pass, and one accepted needs at most
/// `MAX_DEPTH` frames of each pass. `tests/limits.rs` runs queries at the limit on a bounded
/// stack, and `tools/wasm-probe/check.mjs` runs them in the WASM build, where the costliest
/// needs under 128 KiB of V8's stack and of the module's own (README, Verification, 7).
pub const MAX_DEPTH: usize = 100;

/// Most regular expressions in one query, and the limits each is compiled with: nesting
/// (as the regex parser counts it in the pattern: each group, repetition, alternation and
/// concatenation is a level; the regex compiler recurses over it), compiled size and
/// lazy-DFA cache. A regex compiled at the size limit was measured to hold about 1.3 MiB,
/// so a query's regexes hold at most about 26 MiB of a 128 MB isolate (16 x 1.3 MiB, plus
/// 16 x 256 KiB of cache), whatever the query text. 1 MiB still compiles `\w{20}` (Unicode
/// classes are large).
pub const MAX_REGEXES: usize = 16;
pub const REGEX_NEST_LIMIT: u32 = 64;
pub const REGEX_SIZE_LIMIT: usize = 1 << 20;
pub const REGEX_DFA_SIZE_LIMIT: usize = 256 * 1024;

/// A parsed piece and the height of its syntax tree.
type Hp<T> = Result<(T, usize), Error>;

#[derive(Clone, Debug)]
enum Node {
    Filter(FieldExpr, usize),
    Paren(Box<Node>, usize),
    Num(Static, usize),
    Spanset(SpansetOp, Box<Node>, Box<Node>, usize),
    Math(BinOp, Box<Node>, Box<Node>, usize),
    Neg(Box<Node>, usize),
    Pipe(Vec<Node>, usize),
    Agg(AggOp, Option<FieldExpr>, usize),
    Cmp(BinOp, Box<Node>, Box<Node>, usize),
    By(Vec<FieldExpr>, usize),
    Coalesce(usize),
    Select(Vec<FieldExpr>, usize),
    Metrics(MetricsFn, Vec<FieldExpr>, usize),
    TopK(u32, usize),
    BottomK(u32, usize),
    Compare(usize),
}

impl Node {
    fn pos(&self) -> usize {
        match self {
            Node::Filter(_, p)
            | Node::Paren(_, p)
            | Node::Num(_, p)
            | Node::Spanset(_, _, _, p)
            | Node::Math(_, _, _, p)
            | Node::Neg(_, p)
            | Node::Pipe(_, p)
            | Node::Agg(_, _, p)
            | Node::Cmp(_, _, _, p)
            | Node::By(_, p)
            | Node::Coalesce(p)
            | Node::Select(_, p)
            | Node::Metrics(_, _, p)
            | Node::TopK(_, p)
            | Node::BottomK(_, p)
            | Node::Compare(p) => *p,
        }
    }
    /// Produces spansets (so `>`/`<` after it are structural operators).
    fn spanset_like(&self) -> bool {
        match self {
            Node::Filter(..) | Node::Spanset(..) => true,
            Node::Paren(n, _) => n.spanset_like() || n.is_spanset_pipeline(),
            _ => false,
        }
    }
    fn is_spanset_pipeline(&self) -> bool {
        match self {
            Node::Pipe(v, _) => v.last().is_some_and(|l| {
                l.spanset_like()
                    || matches!(l, Node::By(..) | Node::Coalesce(..) | Node::Select(..))
                    || matches!(l, Node::Cmp(_, a, _, _) if matches!(**a, Node::Agg(..)))
            }),
            _ => false,
        }
    }
    fn contains_metrics(&self) -> bool {
        match self {
            Node::Metrics(..) | Node::Compare(..) | Node::TopK(..) | Node::BottomK(..) => true,
            Node::Paren(n, _) | Node::Neg(n, _) => n.contains_metrics(),
            Node::Math(_, a, b, _) | Node::Cmp(_, a, b, _) | Node::Spanset(_, a, b, _) => {
                a.contains_metrics() || b.contains_metrics()
            }
            Node::Pipe(v, _) => v.iter().any(|n| n.contains_metrics()),
            _ => false,
        }
    }
    /// A wrapped pipeline whose last element is a bare aggregate: `({ } | count())`.
    fn is_scalar_pipeline(&self) -> bool {
        match self {
            Node::Paren(n, _) => n.is_scalar_pipeline(),
            Node::Pipe(v, _) => matches!(v.last(), Some(Node::Agg(..))),
            Node::Math(_, a, b, _) => a.is_scalar_pipeline() || b.is_scalar_pipeline() || a.has_agg() || b.has_agg(),
            _ => false,
        }
    }
    fn has_agg(&self) -> bool {
        match self {
            Node::Agg(..) => true,
            Node::Paren(n, _) | Node::Neg(n, _) => n.has_agg(),
            Node::Math(_, a, b, _) => a.has_agg() || b.has_agg(),
            Node::Pipe(v, _) => matches!(v.last(), Some(Node::Agg(..))),
            _ => false,
        }
    }
}

struct Parser<'a> {
    src: &'a str,
    toks: Vec<Token>,
    i: usize,
    /// Current recursion depth (see [`MAX_DEPTH`]).
    depth: usize,
    /// Regexes compiled so far (see [`MAX_REGEXES`]).
    regexes: usize,
    /// Deepest recursion or tree height seen (see [`nesting`]).
    peak: std::cell::Cell<usize>,
}

fn describe(t: &Tok) -> String {
    match t {
        Tok::Eof => "end of query".into(),
        Tok::Ident(s) => format!("identifier {s:?}"),
        Tok::Int(v) => format!("number {v}"),
        Tok::Float(v) => format!("number {v}"),
        Tok::Str(s) => format!("string {s:?}"),
        Tok::Duration(_) => "duration".into(),
        Tok::Attr(_, s, n) => format!("attribute {s}.{n}"),
        Tok::Intrinsic(s, n) => format!("{s}:{n}"),
        other => format!("{other:?}"),
    }
}

const AGGS: [(&str, AggOp); 5] =
    [("count", AggOp::Count), ("avg", AggOp::Avg), ("min", AggOp::Min), ("max", AggOp::Max), ("sum", AggOp::Sum)];

impl<'a> Parser<'a> {
    fn peek(&self) -> &Tok {
        &self.toks[self.i.min(self.toks.len() - 1)].tok
    }
    fn peek2(&self) -> &Tok {
        &self.toks[(self.i + 1).min(self.toks.len() - 1)].tok
    }
    fn pos(&self) -> usize {
        self.toks[self.i.min(self.toks.len() - 1)].pos
    }
    fn next(&mut self) -> Tok {
        let t = self.peek().clone();
        if self.i < self.toks.len() - 1 {
            self.i += 1;
        }
        t
    }
    fn peek_ident(&self, s: &str) -> bool {
        matches!(self.peek(), Tok::Ident(x) if x == s)
    }
    // Building errors, compiling regexes and parsing function calls are kept out of line
    // (`#[inline(never)]`), so that the functions the parser recurses through keep small
    // stack frames: a level of nesting costs a few hundred bytes of stack, not kilobytes.

    #[cold]
    #[inline(never)]
    fn err_at(&self, pos: usize, msg: impl Into<String>) -> Error {
        Error::parse(self.src, pos, msg)
    }
    #[cold]
    #[inline(never)]
    fn err_here(&self, msg: impl Into<String>) -> Error {
        self.err_at(self.pos(), msg)
    }
    #[cold]
    #[inline(never)]
    fn verr(&self, pos: usize, msg: impl Into<String>) -> Error {
        Error::validation(self.src, pos, msg)
    }
    fn expect(&mut self, t: Tok, what: &str) -> Result<(), Error> {
        if *self.peek() == t {
            self.next();
            Ok(())
        } else {
            Err(self.expected(what))
        }
    }
    #[cold]
    #[inline(never)]
    fn expected(&self, what: &str) -> Error {
        self.err_here(format!("expected {what}, found {}", describe(self.peek())))
    }
    #[cold]
    #[inline(never)]
    fn too_deep(&self, pos: usize) -> Error {
        self.verr(pos, format!("query nested deeper than {MAX_DEPTH} levels (parentheses, operators and chained terms all count)"))
    }
    /// One level of parser recursion down; [`Parser::leave`] goes back up.
    fn enter(&mut self) -> Result<(), Error> {
        self.depth += 1;
        self.peak.set(self.peak.get().max(self.depth));
        if self.depth > MAX_DEPTH {
            return Err(self.too_deep(self.pos()));
        }
        Ok(())
    }
    fn leave(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }
    /// The height of a new node over children at most `h` high.
    fn grow(&self, h: usize, pos: usize) -> Result<usize, Error> {
        let h = h + 1;
        self.peak.set(self.peak.get().max(h));
        if h > MAX_DEPTH {
            return Err(self.too_deep(pos));
        }
        Ok(h)
    }

    // ---------------------------------------------------------------- top level

    fn pipeline(&mut self) -> Hp<Node> {
        self.enter()?;
        let start = self.pos();
        let (first, mut h) = self.element()?;
        let mut elems = vec![first];
        while matches!(self.peek(), Tok::Pipe) {
            self.next();
            let (e, he) = self.element()?;
            h = h.max(he);
            elems.push(e);
        }
        self.leave();
        if elems.len() == 1 {
            return Ok((elems.pop().unwrap_or(Node::Coalesce(start)), h));
        }
        Ok((Node::Pipe(elems, start), self.grow(h, start)?))
    }

    fn element(&mut self) -> Hp<Node> {
        let start = self.pos();
        let (lhs, hl) = self.binary(0)?;
        let op = match self.peek() {
            Tok::Eq => Some(BinOp::Eq),
            Tok::Neq => Some(BinOp::Neq),
            Tok::Lt => Some(BinOp::Lt),
            Tok::Lte => Some(BinOp::Lte),
            Tok::Gt => Some(BinOp::Gt),
            Tok::Gte => Some(BinOp::Gte),
            _ => None,
        };
        if let Some(op) = op {
            self.next();
            let (rhs, hr) = self.binary(0)?;
            if matches!(self.peek(), Tok::Eq | Tok::Neq | Tok::Lt | Tok::Lte | Tok::Gt | Tok::Gte) {
                return Err(self.err_here("comparisons cannot be chained"));
            }
            let h = self.grow(hl.max(hr), start)?;
            return Ok((Node::Cmp(op, Box::new(lhs), Box::new(rhs), start), h));
        }
        Ok((lhs, hl))
    }

    /// Spanset operators and arithmetic between pipelines, by precedence (Tempo's, as
    /// observed): `&&` and `||` share the lowest level, left-associative
    /// (`{a} || {b} && {c}` is `({a} || {b}) && {c}`); the structural operators bind tighter
    /// (`{a} || {b} > {c}` is `{a} || ({b} > {c})`) and are left-associative among
    /// themselves; then `+ -` < `* / %` < `^`.
    fn binary(&mut self, min: u8) -> Hp<Node> {
        self.enter()?;
        let (mut lhs, mut h) = self.atom()?;
        loop {
            let pos = self.pos();
            let (prec, op): (u8, Option<Result<SpansetOp, BinOp>>) = match self.peek() {
                Tok::OrOr => (2, Some(Ok(SpansetOp::Or))),
                Tok::AndAnd => (2, Some(Ok(SpansetOp::And))),
                Tok::Desc => (3, Some(Ok(SpansetOp::Descendant))),
                Tok::Anc => (3, Some(Ok(SpansetOp::Ancestor))),
                Tok::Gt if lhs.spanset_like() => (3, Some(Ok(SpansetOp::Child))),
                Tok::Lt if lhs.spanset_like() => (3, Some(Ok(SpansetOp::Parent))),
                Tok::Tilde => (3, Some(Ok(SpansetOp::Sibling))),
                Tok::NDesc => (3, Some(Ok(SpansetOp::NotDescendant))),
                Tok::NAnc => (3, Some(Ok(SpansetOp::NotAncestor))),
                Tok::NChild => (3, Some(Ok(SpansetOp::NotChild))),
                Tok::NParent => (3, Some(Ok(SpansetOp::NotParent))),
                Tok::NRe => (3, Some(Ok(SpansetOp::NotSibling))),
                Tok::UDesc => (3, Some(Ok(SpansetOp::UnionDescendant))),
                Tok::UAnc => (3, Some(Ok(SpansetOp::UnionAncestor))),
                Tok::UChild => (3, Some(Ok(SpansetOp::UnionChild))),
                Tok::UParent => (3, Some(Ok(SpansetOp::UnionParent))),
                Tok::USibling => (3, Some(Ok(SpansetOp::UnionSibling))),
                Tok::Plus => (4, Some(Err(BinOp::Add))),
                Tok::Minus => (4, Some(Err(BinOp::Sub))),
                Tok::Star => (5, Some(Err(BinOp::Mul))),
                Tok::Slash => (5, Some(Err(BinOp::Div))),
                Tok::Percent => (5, Some(Err(BinOp::Mod))),
                Tok::Caret => (6, Some(Err(BinOp::Pow))),
                _ => (0, None),
            };
            let Some(op) = op else { break };
            if prec <= min && !(prec == 6 && min == 6) {
                break;
            }
            self.next();
            let next_min = if prec == 6 { 5 } else { prec };
            let (rhs, hr) = self.binary(next_min)?;
            h = self.grow(h.max(hr), pos)?;
            lhs = match op {
                Ok(s) => Node::Spanset(s, Box::new(lhs), Box::new(rhs), pos),
                Err(m) => Node::Math(m, Box::new(lhs), Box::new(rhs), pos),
            };
        }
        self.leave();
        Ok((lhs, h))
    }

    fn atom(&mut self) -> Hp<Node> {
        let start = self.pos();
        match self.next() {
            Tok::LBrace => {
                if matches!(self.peek(), Tok::RBrace) {
                    self.next();
                    return Ok((Node::Filter(FieldExpr::Static(Static::Bool(true)), start), 2));
                }
                let (e, he) = self.field_or()?;
                self.expect(Tok::RBrace, "'}'")?;
                Ok((Node::Filter(e, start), self.grow(he, start)?))
            }
            Tok::LParen => {
                let (n, hn) = self.pipeline()?;
                self.expect(Tok::RParen, "')'")?;
                Ok((Node::Paren(Box::new(n), start), self.grow(hn, start)?))
            }
            Tok::Int(v) => Ok((Node::Num(Static::Int(self.int_value(v, false, start)?), start), 1)),
            Tok::Float(v) => Ok((Node::Num(Static::Float(v), start), 1)),
            Tok::Duration(v) => Ok((Node::Num(Static::Duration(v), start), 1)),
            Tok::Minus => {
                if let Tok::Int(v) = self.peek().clone() {
                    self.next();
                    return Ok((Node::Num(Static::Int(self.int_value(v, true, start)?), start), 1));
                }
                if let Tok::Float(v) = self.peek().clone() {
                    self.next();
                    return Ok((Node::Num(Static::Float(-v), start), 1));
                }
                if let Tok::Duration(v) = self.peek().clone() {
                    self.next();
                    return Ok((Node::Num(Static::Duration(-v), start), 1));
                }
                // `- - - x` recurses once per sign.
                self.enter()?;
                let (n, hn) = self.atom()?;
                self.leave();
                Ok((Node::Neg(Box::new(n), start), self.grow(hn, start)?))
            }
            Tok::Ident(name) => self.call(name, start),
            other => Err(self.err_at(start, format!("unexpected {}", describe(&other)))),
        }
    }

    fn int_value(&self, v: u64, neg: bool, pos: usize) -> Result<i64, Error> {
        if v > i64::MAX as u64 {
            return Err(self.err_at(pos, "integer out of range"));
        }
        Ok(if neg { -(v as i64) } else { v as i64 })
    }

    #[inline(never)]
    fn call(&mut self, name: String, start: usize) -> Hp<Node> {
        if !matches!(self.peek(), Tok::LParen) {
            return Err(self.err_at(start, format!("unexpected identifier {name:?}")));
        }
        self.next();
        if let Some((_, op)) = AGGS.iter().find(|(n, _)| *n == name) {
            let op = *op;
            if matches!(self.peek(), Tok::RParen) {
                self.next();
                if op != AggOp::Count {
                    return Err(self.err_at(start, format!("{name}() needs an argument")));
                }
                return Ok((Node::Agg(op, None, start), 1));
            }
            if op == AggOp::Count {
                return Err(self.err_at(start, "count() takes no argument"));
            }
            let arg_pos = self.pos();
            let (e, he) = self.field_or()?;
            self.expect(Tok::RParen, "')'")?;
            // A string, status or kind argument is a syntax error in Tempo; a boolean one is
            // rejected by validation. Whether it reads the span is checked with the filter.
            let t = self.check(&e)?;
            if t == Type::Bool {
                return Err(self.verr(arg_pos, format!("{name}() needs a numeric argument")));
            }
            if !t.numeric() {
                return Err(self.err_at(arg_pos, format!("{name}() needs a numeric argument")));
            }
            return Ok((Node::Agg(op, Some(e), start), self.grow(he, start)?));
        }
        match name.as_str() {
            "by" => {
                let (list, h) = self.field_list(start, "by")?;
                if list.len() > 1 {
                    return Err(self.err_at(start, "by() in a spanset pipeline takes one expression"));
                }
                for e in &list {
                    self.check(e)?;
                    if !e.references_span() {
                        return Err(self.verr(start, "by() expressions must read the span"));
                    }
                }
                Ok((Node::By(list, start), self.grow(h, start)?))
            }
            "coalesce" => {
                self.expect(Tok::RParen, "')'")?;
                Ok((Node::Coalesce(start), 1))
            }
            "select" => {
                let (list, h) = self.field_list(start, "select")?;
                for e in &list {
                    if !matches!(e, FieldExpr::Attr { .. } | FieldExpr::Intrinsic(..)) {
                        return Err(self.err_at(start, "select() takes attributes and intrinsics only"));
                    }
                }
                Ok((Node::Select(list, start), self.grow(h, start)?))
            }
            "rate" | "count_over_time" => {
                self.expect(Tok::RParen, "')'")?;
                let (by, hb) = self.metrics_by()?;
                let f = if name == "rate" { MetricsFn::Rate } else { MetricsFn::CountOverTime };
                Ok((Node::Metrics(f, by, start), self.grow(hb, start)?))
            }
            "min_over_time" | "max_over_time" | "avg_over_time" | "sum_over_time" | "histogram_over_time" => {
                let arg_pos = self.pos();
                let (e, he) = self.field_or()?;
                self.expect(Tok::RParen, "')'")?;
                let t = self.check(&e)?;
                if !t.numeric() || !e.references_span() {
                    return Err(self.verr(arg_pos, format!("{name}() needs a numeric expression that reads the span")));
                }
                let (by, hb) = self.metrics_by()?;
                let f = match name.as_str() {
                    "min_over_time" => MetricsFn::MinOverTime(e),
                    "max_over_time" => MetricsFn::MaxOverTime(e),
                    "avg_over_time" => MetricsFn::AvgOverTime(e),
                    "sum_over_time" => MetricsFn::SumOverTime(e),
                    _ => MetricsFn::HistogramOverTime(e),
                };
                Ok((Node::Metrics(f, by, start), self.grow(he.max(hb), start)?))
            }
            "quantile_over_time" => {
                let arg_pos = self.pos();
                let (e, he) = self.field_or()?;
                let t = self.check(&e)?;
                if !t.numeric() || !e.references_span() {
                    return Err(self.verr(arg_pos, "quantile_over_time() needs a numeric expression that reads the span"));
                }
                let mut qs = Vec::new();
                while matches!(self.peek(), Tok::Comma) {
                    self.next();
                    let qp = self.pos();
                    let q = match self.next() {
                        Tok::Int(v) => v as f64,
                        Tok::Float(v) => v,
                        other => return Err(self.err_at(qp, format!("expected a quantile, found {}", describe(&other)))),
                    };
                    qs.push(q);
                }
                self.expect(Tok::RParen, "')'")?;
                if qs.is_empty() {
                    return Err(self.err_at(start, "quantile_over_time() needs at least one quantile"));
                }
                let (by, hb) = self.metrics_by()?;
                Ok((Node::Metrics(MetricsFn::QuantileOverTime(e, qs), by, start), self.grow(he.max(hb), start)?))
            }
            "topk" | "bottomk" => {
                let kp = self.pos();
                let k = match self.next() {
                    Tok::Int(v) => v,
                    other => return Err(self.err_at(kp, format!("expected a count, found {}", describe(&other)))),
                };
                self.expect(Tok::RParen, "')'")?;
                if k == 0 {
                    return Err(self.verr(kp, format!("{name}() needs a count above zero")));
                }
                let k = u32::try_from(k).map_err(|_| self.err_at(kp, "count out of range"))?;
                Ok((if name == "topk" { Node::TopK(k, start) } else { Node::BottomK(k, start) }, 1))
            }
            "compare" => {
                // Parsed so that its misuse is reported like Tempo does; evaluating it is unsupported.
                let mut depth = 1usize;
                while depth > 0 {
                    match self.next() {
                        Tok::LParen => depth += 1,
                        Tok::RParen => depth -= 1,
                        Tok::Eof => return Err(self.err_here("expected ')'")),
                        _ => {}
                    }
                }
                let _ = self.metrics_by()?;
                Ok((Node::Compare(start), 1))
            }
            _ => Err(self.err_at(start, format!("unknown function {name}()"))),
        }
    }

    /// Comma-separated field expressions up to `)`, and the height of the highest.
    fn field_list(&mut self, start: usize, what: &str) -> Hp<Vec<FieldExpr>> {
        if matches!(self.peek(), Tok::RParen) {
            return Err(self.err_at(start, format!("{what}() needs at least one argument")));
        }
        let (first, mut h) = self.field_or()?;
        let mut out = vec![first];
        while matches!(self.peek(), Tok::Comma) {
            self.next();
            let (e, he) = self.field_or()?;
            h = h.max(he);
            out.push(e);
        }
        self.expect(Tok::RParen, "')'")?;
        Ok((out, h))
    }

    fn metrics_by(&mut self) -> Hp<Vec<FieldExpr>> {
        if !self.peek_ident("by") || !matches!(self.peek2(), Tok::LParen) {
            return Ok((Vec::new(), 0));
        }
        let start = self.pos();
        self.next();
        self.next();
        let (list, h) = self.field_list(start, "by")?;
        for e in &list {
            self.check(e)?;
            if !e.references_span() {
                return Err(self.verr(start, "by() expressions must read the span"));
            }
        }
        Ok((list, h))
    }

    fn hints(&mut self) -> Result<Vec<(String, Static)>, Error> {
        self.expect(Tok::LParen, "'(' after with")?;
        let mut out = Vec::new();
        loop {
            let kp = self.pos();
            let key = match self.next() {
                Tok::Ident(k) => k,
                other => return Err(self.err_at(kp, format!("expected a hint name, found {}", describe(&other)))),
            };
            self.expect(Tok::Eq, "'='")?;
            let vp = self.pos();
            let neg = if matches!(self.peek(), Tok::Minus) {
                self.next();
                true
            } else {
                false
            };
            let v = match self.next() {
                Tok::Int(v) => Static::Int(self.int_value(v, neg, vp)?),
                Tok::Float(v) => Static::Float(if neg { -v } else { v }),
                Tok::Duration(v) => Static::Duration(if neg { -v } else { v }),
                Tok::Str(s) if !neg => Static::Str(s),
                Tok::Ident(s) if !neg && s == "true" => Static::Bool(true),
                Tok::Ident(s) if !neg && s == "false" => Static::Bool(false),
                other => return Err(self.err_at(vp, format!("invalid hint value {}", describe(&other)))),
            };
            out.push((key, v));
            match self.next() {
                Tok::Comma => continue,
                Tok::RParen => break,
                other => return Err(self.err_at(self.pos(), format!("expected ',' or ')', found {}", describe(&other)))),
            }
        }
        Ok(out)
    }

    // ---------------------------------------------------------------- field expressions

    /// `&&` and `||` share one precedence level and associate to the left, as Tempo
    /// evaluates them: `{ a || b && c }` is `{ (a || b) && c }` (README, "Differential run").
    fn field_or(&mut self) -> Hp<FieldExpr> {
        self.enter()?;
        let (mut lhs, mut h) = self.field_cmp()?;
        loop {
            let op = match self.peek() {
                Tok::OrOr => BinOp::Or,
                Tok::AndAnd => BinOp::And,
                _ => break,
            };
            let pos = self.pos();
            self.next();
            let (rhs, hr) = self.field_cmp()?;
            h = self.grow(h.max(hr), pos)?;
            lhs = FieldExpr::Binary(op, Box::new(lhs), Box::new(rhs));
        }
        self.leave();
        Ok((lhs, h))
    }

    fn field_cmp(&mut self) -> Hp<FieldExpr> {
        let (mut lhs, mut h) = self.field_add()?;
        loop {
            let op = match self.peek() {
                Tok::Eq => BinOp::Eq,
                Tok::Neq => BinOp::Neq,
                Tok::Lt => BinOp::Lt,
                Tok::Lte => BinOp::Lte,
                Tok::Gt => BinOp::Gt,
                Tok::Gte => BinOp::Gte,
                Tok::Re => BinOp::Re,
                Tok::NRe => BinOp::NRe,
                _ => break,
            };
            let pos = self.pos();
            self.next();
            let (rhs, hr) = self.field_add()?;
            h = self.grow(h.max(hr), pos)?;
            lhs = if matches!(op, BinOp::Re | BinOp::NRe) {
                let FieldExpr::Static(Static::Str(text)) = rhs else {
                    return Err(self.verr(pos, "the right side of a regex match must be a string"));
                };
                let re = self.regex(&text, pos)?;
                FieldExpr::Regex { lhs: Box::new(lhs), re: Box::new(Re(re)), negated: op == BinOp::NRe, text }
            } else {
                FieldExpr::Binary(op, Box::new(lhs), Box::new(rhs))
            };
        }
        Ok((lhs, h))
    }

    /// Compiles the pattern of `=~` / `!~` within the limits of [`MAX_REGEXES`]. TraceQL's
    /// regexes are Go's (Tempo's documentation and observed behaviour: `\w`, `\d`, `\s`, `\b`
    /// ASCII-only, `\Q…\E`, octal escapes, Go's errors), fully anchored with `.` matching a
    /// newline (`^(?s:…)$`, observed); `viz_goregex` translates them. Unicode classes are
    /// Unsupported. Group names are dropped: matching does not use them.
    #[inline(never)]
    fn regex(&mut self, text: &str, pos: usize) -> Result<regex::Regex, Error> {
        self.regexes += 1;
        if self.regexes > MAX_REGEXES {
            return Err(self.verr(pos, format!("more than {MAX_REGEXES} regular expressions in one query")));
        }
        // The anchoring `^(?s:…)$` adds two levels (a concatenation and a group) to the
        // nesting the regex parser counts in the translated pattern.
        let limits = viz_goregex::Limits { size: REGEX_SIZE_LIMIT, dfa_size: REGEX_DFA_SIZE_LIMIT, nest: REGEX_NEST_LIMIT + 2 };
        viz_goregex::compile(text, viz_goregex::Wrap::Anchored, false, &limits).map_err(|e| match e {
            viz_goregex::Error::Unsupported(m) => Error::Unsupported(format!("regex {text:?}: {m}")),
            viz_goregex::Error::Invalid(m) => self.verr(pos, format!("invalid regex {text:?}: {m}")),
        })
    }

    fn field_add(&mut self) -> Hp<FieldExpr> {
        let (mut lhs, mut h) = self.field_mul()?;
        loop {
            let op = match self.peek() {
                Tok::Plus => BinOp::Add,
                Tok::Minus => BinOp::Sub,
                _ => break,
            };
            let pos = self.pos();
            self.next();
            let (rhs, hr) = self.field_mul()?;
            h = self.grow(h.max(hr), pos)?;
            lhs = FieldExpr::Binary(op, Box::new(lhs), Box::new(rhs));
        }
        Ok((lhs, h))
    }

    fn field_mul(&mut self) -> Hp<FieldExpr> {
        let (mut lhs, mut h) = self.field_pow()?;
        loop {
            let op = match self.peek() {
                Tok::Star => BinOp::Mul,
                Tok::Slash => BinOp::Div,
                Tok::Percent => BinOp::Mod,
                _ => break,
            };
            let pos = self.pos();
            self.next();
            let (rhs, hr) = self.field_pow()?;
            h = self.grow(h.max(hr), pos)?;
            lhs = FieldExpr::Binary(op, Box::new(lhs), Box::new(rhs));
        }
        Ok((lhs, h))
    }

    fn field_pow(&mut self) -> Hp<FieldExpr> {
        let (lhs, hl) = self.field_unary()?;
        if matches!(self.peek(), Tok::Caret) {
            let pos = self.pos();
            self.next();
            self.enter()?;
            let (rhs, hr) = self.field_pow()?;
            self.leave();
            let h = self.grow(hl.max(hr), pos)?;
            return Ok((FieldExpr::Binary(BinOp::Pow, Box::new(lhs), Box::new(rhs)), h));
        }
        Ok((lhs, hl))
    }

    fn field_unary(&mut self) -> Hp<FieldExpr> {
        let start = self.pos();
        match self.peek() {
            Tok::Minus => {
                self.next();
                self.enter()?;
                let e = match self.peek().clone() {
                    Tok::Int(v) => {
                        let p = self.pos();
                        self.next();
                        (FieldExpr::Static(Static::Int(self.int_value(v, true, p)?)), 1)
                    }
                    Tok::Float(v) => {
                        self.next();
                        (FieldExpr::Static(Static::Float(-v)), 1)
                    }
                    Tok::Duration(v) => {
                        self.next();
                        (FieldExpr::Static(Static::Duration(-v)), 1)
                    }
                    _ => {
                        let (x, hx) = self.field_unary()?;
                        (FieldExpr::Unary(UnOp::Neg, Box::new(x)), self.grow(hx, start)?)
                    }
                };
                self.leave();
                Ok(e)
            }
            Tok::Not => {
                self.next();
                self.enter()?;
                let (x, hx) = self.field_unary()?;
                self.leave();
                Ok((FieldExpr::Unary(UnOp::Not, Box::new(x)), self.grow(hx, start)?))
            }
            _ => self.field_primary(),
        }
    }

    fn field_primary(&mut self) -> Hp<FieldExpr> {
        if matches!(self.peek(), Tok::LParen) {
            // Parentheses add no node, but recurse through all seven precedence functions:
            // they count two levels here (with `field_or`'s), as spanset parentheses do.
            self.next();
            self.enter()?;
            let (e, h) = self.field_or()?;
            self.leave();
            self.expect(Tok::RParen, "')'")?;
            return Ok((e, h));
        }
        let start = self.pos();
        Ok((self.field_leaf(start)?, 1))
    }

    #[inline(never)]
    fn field_leaf(&mut self, start: usize) -> Result<FieldExpr, Error> {
        match self.next() {
            Tok::Int(v) => Ok(FieldExpr::Static(Static::Int(self.int_value(v, false, start)?))),
            Tok::Float(v) => Ok(FieldExpr::Static(Static::Float(v))),
            Tok::Duration(v) => Ok(FieldExpr::Static(Static::Duration(v))),
            Tok::Str(s) => Ok(FieldExpr::Static(Static::Str(s))),
            Tok::Attr(parent, scope, name) => {
                if parent {
                    return Err(Error::unsupported("the parent. scope"));
                }
                let scope = match scope.as_str() {
                    "" => Scope::None,
                    "span" => Scope::Span,
                    "resource" => Scope::Resource,
                    "event" => Scope::Event,
                    "link" => Scope::Link,
                    _ => Scope::Instrumentation,
                };
                Ok(FieldExpr::Attr { scope, name })
            }
            Tok::Intrinsic(scope, name) => {
                let i = match (scope.as_str(), name.as_str()) {
                    ("span", "name") => Intrinsic::Name,
                    ("span", "status") => Intrinsic::Status,
                    ("span", "statusMessage") => Intrinsic::StatusMessage,
                    ("span", "duration") => Intrinsic::Duration,
                    ("span", "kind") => Intrinsic::Kind,
                    ("span", "id") => Intrinsic::SpanId,
                    ("span", "parentID") => Intrinsic::ParentId,
                    ("span", "childCount") => Intrinsic::ChildCount,
                    ("trace", "duration") => Intrinsic::TraceDuration,
                    ("trace", "rootName") => Intrinsic::TraceRootName,
                    ("trace", "rootService") => Intrinsic::TraceRootService,
                    ("trace", "id") => Intrinsic::TraceId,
                    ("event", "name") => Intrinsic::EventName,
                    ("event", "timeSinceStart") => Intrinsic::EventTimeSinceStart,
                    ("link", "spanID") => Intrinsic::LinkSpanId,
                    ("link", "traceID") => Intrinsic::LinkTraceId,
                    ("instrumentation", "name") => Intrinsic::InstrumentationName,
                    ("instrumentation", "version") => Intrinsic::InstrumentationVersion,
                    _ => return Err(self.err_at(start, format!("unknown intrinsic {scope}:{name}"))),
                };
                Ok(FieldExpr::Intrinsic(i, format!("{scope}:{name}")))
            }
            Tok::Ident(w) => match w.as_str() {
                "true" => Ok(FieldExpr::Static(Static::Bool(true))),
                "false" => Ok(FieldExpr::Static(Static::Bool(false))),
                "nil" => Ok(FieldExpr::Static(Static::Nil)),
                "ok" => Ok(FieldExpr::Static(Static::Status(Status::Ok))),
                "error" => Ok(FieldExpr::Static(Static::Status(Status::Error))),
                "unset" => Ok(FieldExpr::Static(Static::Status(Status::Unset))),
                "unspecified" => Ok(FieldExpr::Static(Static::Kind(Kind::Unspecified))),
                "internal" => Ok(FieldExpr::Static(Static::Kind(Kind::Internal))),
                "server" => Ok(FieldExpr::Static(Static::Kind(Kind::Server))),
                "client" => Ok(FieldExpr::Static(Static::Kind(Kind::Client))),
                "producer" => Ok(FieldExpr::Static(Static::Kind(Kind::Producer))),
                "consumer" => Ok(FieldExpr::Static(Static::Kind(Kind::Consumer))),
                "minInt" => Ok(FieldExpr::Static(Static::Int(i64::MIN))),
                "maxInt" => Ok(FieldExpr::Static(Static::Int(i64::MAX))),
                "name" => Ok(FieldExpr::Intrinsic(Intrinsic::Name, w)),
                "status" => Ok(FieldExpr::Intrinsic(Intrinsic::Status, w)),
                "statusMessage" => Ok(FieldExpr::Intrinsic(Intrinsic::StatusMessage, w)),
                "duration" => Ok(FieldExpr::Intrinsic(Intrinsic::Duration, w)),
                "kind" => Ok(FieldExpr::Intrinsic(Intrinsic::Kind, w)),
                "traceDuration" => Ok(FieldExpr::Intrinsic(Intrinsic::TraceDuration, w)),
                "rootName" => Ok(FieldExpr::Intrinsic(Intrinsic::TraceRootName, w)),
                "rootServiceName" => Ok(FieldExpr::Intrinsic(Intrinsic::TraceRootService, w)),
                "parent" => Err(Error::unsupported("the parent intrinsic")),
                "nestedSetLeft" | "nestedSetRight" | "nestedSetParent" => Ok(FieldExpr::Intrinsic(Intrinsic::NestedSet, w)),
                _ => Err(self.err_at(start, format!("unknown identifier {w:?} (attributes start with '.' or a scope)"))),
            },
            other => Err(self.err_at(start, format!("unexpected {}", describe(&other)))),
        }
    }

    // ---------------------------------------------------------------- validation

    /// Static type of a field expression; rejects operand types Tempo rejects.
    fn check(&self, e: &FieldExpr) -> Result<Type, Error> {
        let p = 0;
        Ok(match e {
            FieldExpr::Static(s) => match s {
                Static::Nil => Type::Nil,
                Static::Bool(_) => Type::Bool,
                Static::Int(_) => Type::Int,
                Static::Float(_) => Type::Float,
                Static::Str(_) => Type::Str,
                Static::Duration(_) => Type::Duration,
                Static::Status(_) => Type::Status,
                Static::Kind(_) => Type::Kind,
            },
            FieldExpr::Attr { .. } => Type::Attribute,
            FieldExpr::Intrinsic(i, _) => i.typ(),
            FieldExpr::Unary(UnOp::Neg, x) => {
                let t = self.check(x)?;
                if !t.numeric() {
                    return Err(self.verr(p, "unary minus needs a number"));
                }
                t
            }
            FieldExpr::Unary(UnOp::Not, x) => {
                let t = self.check(x)?;
                if !matches!(t, Type::Bool | Type::Attribute) {
                    return Err(self.verr(p, "! needs a boolean"));
                }
                Type::Bool
            }
            FieldExpr::Regex { lhs, .. } => {
                let t = self.check(lhs)?;
                if !matches!(t, Type::Str | Type::Attribute) {
                    return Err(self.verr(p, "a regex match needs a string on the left"));
                }
                Type::Bool
            }
            FieldExpr::Binary(op, a, b) => {
                let ta = self.check(a)?;
                let tb = self.check(b)?;
                match op {
                    BinOp::And | BinOp::Or => {
                        if !matches!(ta, Type::Bool | Type::Attribute) || !matches!(tb, Type::Bool | Type::Attribute) {
                            return Err(self.verr(p, format!("{} needs booleans", op.text())));
                        }
                        Type::Bool
                    }
                    op if op.is_arith() => {
                        if !ta.numeric() || !tb.numeric() {
                            return Err(self.verr(p, format!("{} needs numbers", op.text())));
                        }
                        if ta == Type::Attribute || tb == Type::Attribute {
                            Type::Attribute
                        } else if ta == Type::Float || tb == Type::Float {
                            Type::Float
                        } else if ta == Type::Duration || tb == Type::Duration {
                            Type::Duration
                        } else {
                            Type::Int
                        }
                    }
                    op => {
                        if !comparable(ta, tb, *op) {
                            return Err(self.verr(p, format!("cannot compare {ta:?} with {tb:?} using {}", op.text())));
                        }
                        if (ta == Type::Nil && is_service_name(b)) || (tb == Type::Nil && is_service_name(a)) {
                            return Err(self.verr(p, "resource.service.name cannot be compared with nil"));
                        }
                        Type::Bool
                    }
                }
            }
        })
    }

    fn check_filter(&self, e: &FieldExpr, pos: usize) -> Result<(), Error> {
        let t = self.check(e).map_err(|err| match err {
            Error::Validation { msg, .. } => self.verr(pos, msg),
            other => other,
        })?;
        if !matches!(t, Type::Bool | Type::Attribute) {
            return Err(self.verr(pos, "a spanset filter must evaluate to a boolean"));
        }
        Ok(())
    }

    // ---------------------------------------------------------------- conversion

    fn convert(&self, node: Node) -> Result<Query, Error> {
        if node.contains_metrics() {
            let m = self.metrics(node)?;
            if let MetricsExpr::Scalar(_) = m {
                return Err(self.err_at(0, "a constant expression needs a metrics query"));
            }
            return Ok(Query::Metrics(m));
        }
        Ok(Query::Search(self.stages(node, true)?))
    }

    fn stages(&self, node: Node, top: bool) -> Result<Vec<Stage>, Error> {
        let elems = match node {
            Node::Pipe(v, _) => v,
            other => vec![other],
        };
        let mut out = Vec::new();
        for (i, n) in elems.into_iter().enumerate() {
            if i == 0 && matches!(n, Node::Coalesce(_)) {
                return Err(self.err_at(n.pos(), "a pipeline cannot start with coalesce()"));
            }
            out.push(self.stage(n, top)?);
        }
        Ok(out)
    }

    fn stage(&self, n: Node, top: bool) -> Result<Stage, Error> {
        let _ = top;
        match n {
            Node::Filter(e, p) => {
                self.check_filter(&e, p)?;
                Ok(Stage::Filter(e))
            }
            Node::Spanset(op, a, b, p) => {
                // Both operands are wrapped pipelines `( … | … )`, or neither is.
                if is_wrapped_pipeline(&a) != is_wrapped_pipeline(&b) {
                    return Err(self.err_at(b.pos(), "a spanset operator joins two spanset expressions or two wrapped pipelines"));
                }
                let l = self.spanset_operand(*a, p)?;
                let r = self.spanset_operand(*b, p)?;
                Ok(Stage::Op(op, Box::new(l), Box::new(r)))
            }
            Node::Paren(inner, p) => {
                if inner.is_scalar_pipeline() {
                    return Err(self.err_at(p, "a wrapped pipeline ending in an aggregate needs a comparison"));
                }
                match *inner {
                    Node::Pipe(..) => Ok(Stage::Pipeline(self.stages(*inner, false)?)),
                    other => self.stage(other, false),
                }
            }
            Node::Cmp(op, a, b, p) => self.scalar_filter(op, *a, *b, p),
            Node::Agg(_, _, p) => Err(self.err_at(p, "an aggregate in a pipeline needs a comparison")),
            Node::By(v, _) => Ok(Stage::By(v)),
            Node::Coalesce(_) => Ok(Stage::Coalesce),
            Node::Select(v, _) => Ok(Stage::Select(v)),
            Node::Pipe(v, p) => Ok(Stage::Pipeline(self.stages(Node::Pipe(v, p), false)?)),
            Node::Num(_, p) | Node::Neg(_, p) => Err(self.err_at(p, "a constant is not a pipeline stage")),
            Node::Math(_, a, b, p) => {
                if a.is_scalar_pipeline() || b.is_scalar_pipeline() || a.has_agg() || b.has_agg() {
                    Err(self.err_at(p, "arithmetic on aggregates needs a comparison"))
                } else {
                    Err(self.err_at(p, "arithmetic between spansets is not defined"))
                }
            }
            other => Err(self.err_at(other.pos(), "unexpected metrics stage")),
        }
    }

    fn spanset_operand(&self, n: Node, p: usize) -> Result<Stage, Error> {
        match n {
            Node::Filter(..) | Node::Spanset(..) => self.stage(n, false),
            Node::Paren(inner, pp) => {
                if inner.is_scalar_pipeline() || matches!(*inner, Node::Agg(..)) {
                    return Err(self.err_at(pp, "a spanset operator needs spansets on both sides"));
                }
                self.stage(Node::Paren(inner, pp), false)
            }
            other => Err(self.err_at(other.pos().max(p), "a spanset operator needs spansets on both sides")),
        }
    }

    fn scalar_filter(&self, op: BinOp, a: Node, b: Node, p: usize) -> Result<Stage, Error> {
        // agg op constant is supported; other shapes are either errors or unsupported.
        let a_agg = a.has_agg() || a.is_scalar_pipeline();
        let b_agg = b.has_agg() || b.is_scalar_pipeline();
        if !a_agg {
            if b_agg {
                return Err(self.err_at(p, "the constant of a scalar filter goes on the right"));
            }
            if a.spanset_like() || b.spanset_like() {
                return Err(self.err_at(p, format!("{} is not an operator between spansets", op.text())));
            }
            return Err(self.err_at(p, "a scalar filter needs an aggregate on the left"));
        }
        if b.spanset_like() || has_bare_spanset(&a) || has_bare_spanset(&b) {
            return Err(self.err_at(p, "cannot combine an aggregate with a spanset"));
        }
        let mut args_ok = true;
        for_each_agg(&a, &mut |arg| args_ok &= arg.map_or(true, |e| e.references_span()));
        for_each_agg(&b, &mut |arg| args_ok &= arg.map_or(true, |e| e.references_span()));
        if !args_ok {
            return Err(self.verr(p, "aggregate arguments must read the span"));
        }
        match a {
            Node::Agg(agg, arg, _) if !b_agg => {
                let value = self.fold_scalar(&b, false)?;
                if let Some(e) = &arg {
                    if !e.references_span() {
                        return Err(self.verr(p, "aggregate arguments must read the span"));
                    }
                }
                Ok(Stage::ScalarFilter { agg, arg, op, value })
            }
            _ => Err(Error::unsupported(
                "scalar filters other than `aggregate op constant` (arithmetic on aggregates, aggregate against aggregate, wrapped scalar pipelines)",
            )),
        }
    }

    /// Folds a constant numeric expression (integer arithmetic stays integral).
    fn fold_scalar(&self, n: &Node, metrics: bool) -> Result<Static, Error> {
        match n {
            Node::Num(s, p) => {
                if metrics && matches!(s, Static::Duration(_)) {
                    return Err(self.err_at(*p, "a duration cannot be an operand of metrics arithmetic"));
                }
                Ok(s.clone())
            }
            Node::Paren(inner, _) => self.fold_scalar(inner, metrics),
            Node::Neg(inner, p) => match self.fold_scalar(inner, metrics)? {
                Static::Int(v) => Ok(Static::Int(v.checked_neg().ok_or_else(|| self.err_at(*p, "integer overflow"))?)),
                Static::Float(v) => Ok(Static::Float(-v)),
                Static::Duration(v) => Ok(Static::Duration(-v)),
                _ => Err(self.err_at(*p, "expected a number")),
            },
            Node::Math(op, a, b, p) => {
                if matches!(op, BinOp::Mod | BinOp::Pow) {
                    return Err(self.err_at(*p, format!("{} is not supported between constants here", op.text())));
                }
                let x = self.fold_scalar(a, true)?;
                let y = self.fold_scalar(b, true)?;
                fold_arith(*op, &x, &y).ok_or_else(|| self.err_at(*p, "invalid constant arithmetic"))
            }
            other => Err(self.err_at(other.pos(), "expected a constant number")),
        }
    }

    fn metrics(&self, n: Node) -> Result<MetricsExpr, Error> {
        match n {
            Node::Pipe(elems, p) => {
                // [spanset stages...] metrics-fn [second stages...]  |  math-head [second stages...]
                let idx = elems.iter().position(|e| matches!(strip_cmp(e), Node::Metrics(..) | Node::Compare(..)));
                let Some(idx) = idx else {
                    // A metrics expression (math, wrapped query) followed by second stages.
                    let mut it = elems.into_iter();
                    let head = it.next().ok_or_else(|| self.err_at(p, "empty pipeline"))?;
                    let mut m = self.metrics(head)?;
                    if matches!(m, MetricsExpr::Scalar(_)) {
                        return Err(self.err_at(p, "second stages need a metrics query"));
                    }
                    for e in it {
                        for st in self.second_stages(e)? {
                            push_second(&mut m, st);
                        }
                    }
                    return Ok(m);
                };
                let mut elems = elems;
                let rest: Vec<Node> = elems.drain(idx + 1..).collect();
                let fnode = elems.pop().ok_or_else(|| self.err_at(p, "empty pipeline"))?;
                let pipeline = if elems.is_empty() {
                    vec![Stage::Filter(FieldExpr::Static(Static::Bool(true)))]
                } else {
                    for e in &elems {
                        if e.contains_metrics() {
                            return Err(self.err_at(e.pos(), "only one metrics function per query"));
                        }
                    }
                    self.stages(Node::Pipe(elems, p), true)?
                };
                let mut second = Vec::new();
                let (func, by) = match fnode {
                    Node::Metrics(f, by, _) => (f, by),
                    Node::Cmp(op, a, b, cp) => match *a {
                        Node::Metrics(f, by, _) => {
                            second.push(SecondStage::Filter(op, self.threshold(&b)?));
                            (f, by)
                        }
                        Node::Compare(_) => return Err(self.verr(cp, "compare() cannot be filtered")),
                        _ => return Err(self.err_at(cp, "expected a metrics function")),
                    },
                    Node::Compare(cp) => {
                        if !rest.is_empty() {
                            return Err(self.verr(cp, "compare() cannot be followed by other stages"));
                        }
                        return Err(Error::unsupported("compare()"));
                    }
                    other => return Err(self.err_at(other.pos(), "expected a metrics function")),
                };
                for e in rest {
                    second.extend(self.second_stages(e)?);
                }
                Ok(MetricsExpr::Query { pipeline, func, by, second })
            }
            Node::Paren(inner, _) => self.metrics(*inner),
            Node::Num(..) | Node::Neg(..) => match self.fold_scalar(&n, true)? {
                Static::Int(v) => Ok(MetricsExpr::Scalar(v as f64)),
                Static::Float(v) => Ok(MetricsExpr::Scalar(v)),
                _ => Err(self.err_at(n.pos(), "expected a number")),
            },
            Node::Math(op, a, b, p) => {
                if matches!(op, BinOp::Mod | BinOp::Pow) {
                    return Err(self.err_at(p, format!("{} is not an operator between metrics queries", op.text())));
                }
                if !a.contains_metrics() && !b.contains_metrics() {
                    // Constant sub-expression: fold with integer semantics.
                    return match self.fold_scalar(&Node::Math(op, a, b, p), true)? {
                        Static::Int(v) => Ok(MetricsExpr::Scalar(v as f64)),
                        Static::Float(v) => Ok(MetricsExpr::Scalar(v)),
                        _ => Err(self.err_at(p, "expected a number")),
                    };
                }
                if contains_compare(&a) || contains_compare(&b) {
                    return Err(self.verr(p, "compare() cannot be used in arithmetic"));
                }
                let l = self.metrics(*a)?;
                let r = self.metrics(*b)?;
                Ok(MetricsExpr::Math { op, lhs: Box::new(l), rhs: Box::new(r), second: Vec::new() })
            }
            Node::Cmp(op, a, b, p) => {
                let mut m = self.metrics(*a)?;
                if matches!(m, MetricsExpr::Scalar(_)) {
                    return Err(self.err_at(p, "a comparison needs a metrics query on the left"));
                }
                push_second(&mut m, SecondStage::Filter(op, self.threshold(&b)?));
                Ok(m)
            }
            Node::Metrics(f, by, _) => Ok(MetricsExpr::Query {
                pipeline: vec![Stage::Filter(FieldExpr::Static(Static::Bool(true)))],
                func: f,
                by,
                second: Vec::new(),
            }),
            Node::Compare(_) => Err(Error::unsupported("compare()")),
            Node::Spanset(_, _, _, p) => Err(self.err_at(p, "spanset operators cannot combine metrics queries")),
            Node::TopK(_, p) | Node::BottomK(_, p) => Err(self.err_at(p, "topk() and bottomk() need a metrics query before them")),
            other => Err(self.err_at(other.pos(), "unexpected stage in a metrics query")),
        }
    }

    fn threshold(&self, n: &Node) -> Result<f64, Error> {
        if n.contains_metrics() {
            return Err(Error::unsupported("comparing two metrics queries"));
        }
        match n {
            Node::Num(Static::Duration(d), _) => return Ok(*d as f64 / 1e9),
            Node::Neg(inner, _) => {
                if let Node::Num(Static::Duration(d), _) = **inner {
                    return Ok(-(d as f64) / 1e9);
                }
            }
            _ => {}
        }
        match self.fold_scalar(n, true)? {
            Static::Int(v) => Ok(v as f64),
            Static::Float(v) => Ok(v),
            _ => Err(self.err_at(n.pos(), "expected a number")),
        }
    }

    /// `topk(k)`, `bottomk(k)`, or either followed by a comparison (`topk(5) > 10`).
    fn second_stages(&self, n: Node) -> Result<Vec<SecondStage>, Error> {
        match n {
            Node::TopK(k, _) => Ok(vec![SecondStage::TopK(k)]),
            Node::BottomK(k, _) => Ok(vec![SecondStage::BottomK(k)]),
            Node::Cmp(op, a, b, p) => {
                let first = match *a {
                    Node::TopK(k, _) => SecondStage::TopK(k),
                    Node::BottomK(k, _) => SecondStage::BottomK(k),
                    _ => return Err(self.err_at(p, "expected topk() or bottomk()")),
                };
                Ok(vec![first, SecondStage::Filter(op, self.threshold(&b)?)])
            }
            other => Err(self.err_at(other.pos(), "only topk(), bottomk() and comparisons may follow a metrics function")),
        }
    }
}

fn is_wrapped_pipeline(n: &Node) -> bool {
    matches!(n, Node::Paren(x, _) if matches!(**x, Node::Pipe(..)))
}

fn strip_cmp(n: &Node) -> &Node {
    match n {
        Node::Cmp(_, a, _, _) => a,
        other => other,
    }
}

fn contains_compare(n: &Node) -> bool {
    match n {
        Node::Compare(_) => true,
        Node::Paren(x, _) | Node::Neg(x, _) => contains_compare(x),
        Node::Math(_, a, b, _) | Node::Cmp(_, a, b, _) | Node::Spanset(_, a, b, _) => contains_compare(a) || contains_compare(b),
        Node::Pipe(v, _) => v.iter().any(contains_compare),
        _ => false,
    }
}

/// A spanset (not a wrapped scalar pipeline) used as an arithmetic operand.
fn has_bare_spanset(n: &Node) -> bool {
    match n {
        Node::Math(_, a, b, _) => has_bare_spanset(a) || has_bare_spanset(b),
        Node::Paren(x, _) => match &**x {
            Node::Pipe(..) => !x.is_scalar_pipeline() && !matches!(&**x, Node::Pipe(v, _) if v.last().is_some_and(|l| matches!(l, Node::Agg(..)))),
            Node::Agg(..) | Node::Num(..) => false,
            other => has_bare_spanset(other) || other.spanset_like(),
        },
        other => other.spanset_like(),
    }
}

fn for_each_agg(n: &Node, f: &mut dyn FnMut(Option<&FieldExpr>)) {
    match n {
        Node::Agg(_, arg, _) => f(arg.as_ref()),
        Node::Paren(x, _) | Node::Neg(x, _) => for_each_agg(x, f),
        Node::Math(_, a, b, _) | Node::Cmp(_, a, b, _) => {
            for_each_agg(a, f);
            for_each_agg(b, f);
        }
        Node::Pipe(v, _) => {
            if let Some(l) = v.last() {
                for_each_agg(l, f)
            }
        }
        _ => {}
    }
}

fn push_second(m: &mut MetricsExpr, s: SecondStage) {
    match m {
        MetricsExpr::Query { second, .. } | MetricsExpr::Math { second, .. } => second.push(s),
        MetricsExpr::Scalar(_) => {}
    }
}

fn is_service_name(e: &FieldExpr) -> bool {
    matches!(e, FieldExpr::Attr { scope: Scope::Resource, name } if name == "service.name")
}

fn comparable(a: Type, b: Type, op: BinOp) -> bool {
    use Type::*;
    if a == Attribute && b == Attribute {
        return true;
    }
    if a == Nil || b == Nil {
        let other = if a == Nil { b } else { a };
        return matches!(other, Nil | Attribute | Str) && matches!(op, BinOp::Eq | BinOp::Neq);
    }
    if a == Attribute || b == Attribute {
        return true;
    }
    let ordered = matches!(op, BinOp::Lt | BinOp::Lte | BinOp::Gt | BinOp::Gte);
    match (a, b) {
        (x, y) if x.numeric() && y.numeric() => true,
        (Str, Str) => true,
        (Bool, Bool) | (Status, Status) | (Kind, Kind) => !ordered,
        _ => false,
    }
}

/// Constant arithmetic as TraceQL does it: integers stay integers (`1 / 2` is 0), a float
/// operand makes a float. Division by zero is refused.
pub fn fold_arith(op: BinOp, x: &Static, y: &Static) -> Option<Static> {
    match (x, y) {
        (Static::Int(a), Static::Int(b)) => Some(Static::Int(match op {
            BinOp::Add => a.checked_add(*b)?,
            BinOp::Sub => a.checked_sub(*b)?,
            BinOp::Mul => a.checked_mul(*b)?,
            BinOp::Div => {
                if *b == 0 {
                    return None;
                }
                a.checked_div(*b)?
            }
            _ => return None,
        })),
        _ => {
            let a = num(x)?;
            let b = num(y)?;
            Some(Static::Float(match op {
                BinOp::Add => a + b,
                BinOp::Sub => a - b,
                BinOp::Mul => a * b,
                BinOp::Div => a / b,
                _ => return None,
            }))
        }
    }
}

fn num(s: &Static) -> Option<f64> {
    match s {
        Static::Int(v) => Some(*v as f64),
        Static::Float(v) => Some(*v),
        _ => None,
    }
}
