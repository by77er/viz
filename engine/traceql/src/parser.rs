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
    if src.len() > MAX_QUERY_BYTES {
        return Err(Error::Validation { pos: 0, line: 1, col: 1, msg: format!("query longer than {MAX_QUERY_BYTES} bytes") });
    }
    let toks = lex(src)?;
    let mut p = Parser { src, toks, i: 0, depth: 0 };
    if matches!(p.peek(), Tok::Eof) {
        return Err(p.err_here("empty query"));
    }
    let node = p.pipeline()?;
    let mut hints = Vec::new();
    if p.peek_ident("with") {
        p.next();
        hints = p.hints()?;
    }
    if !matches!(p.peek(), Tok::Eof) {
        return Err(p.err_here(format!("unexpected {}", describe(p.peek()))));
    }
    let query = p.convert(node)?;
    Ok(RootExpr { query, hints })
}

/// Longest accepted query text. Deeper nesting than [`MAX_DEPTH`] is refused too, so that
/// recursion cannot exhaust the stack (a stack overflow aborts a WASM isolate).
pub const MAX_QUERY_BYTES: usize = 128 * 1024;
pub const MAX_DEPTH: usize = 200;

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
    depth: usize,
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
    fn err_at(&self, pos: usize, msg: impl Into<String>) -> Error {
        Error::parse(self.src, pos, msg)
    }
    fn err_here(&self, msg: impl Into<String>) -> Error {
        self.err_at(self.pos(), msg)
    }
    fn verr(&self, pos: usize, msg: impl Into<String>) -> Error {
        Error::validation(self.src, pos, msg)
    }
    fn expect(&mut self, t: Tok, what: &str) -> Result<(), Error> {
        if *self.peek() == t {
            self.next();
            Ok(())
        } else {
            Err(self.err_here(format!("expected {what}, found {}", describe(self.peek()))))
        }
    }
    fn enter(&mut self) -> Result<(), Error> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.verr(self.pos(), format!("query nested deeper than {MAX_DEPTH} levels")));
        }
        Ok(())
    }

    // ---------------------------------------------------------------- top level

    fn pipeline(&mut self) -> Result<Node, Error> {
        self.enter()?;
        let start = self.pos();
        let mut elems = vec![self.element()?];
        while matches!(self.peek(), Tok::Pipe) {
            self.next();
            elems.push(self.element()?);
        }
        self.depth -= 1;
        Ok(if elems.len() == 1 { elems.pop().unwrap_or(Node::Coalesce(start)) } else { Node::Pipe(elems, start) })
    }

    fn element(&mut self) -> Result<Node, Error> {
        let start = self.pos();
        let lhs = self.binary(0)?;
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
            let rhs = self.binary(0)?;
            if matches!(self.peek(), Tok::Eq | Tok::Neq | Tok::Lt | Tok::Lte | Tok::Gt | Tok::Gte) {
                return Err(self.err_here("comparisons cannot be chained"));
            }
            return Ok(Node::Cmp(op, Box::new(lhs), Box::new(rhs), start));
        }
        Ok(lhs)
    }

    /// Spanset operators and arithmetic between pipelines, by precedence: every spanset
    /// operator (`&&`, `||` and the structural ones) shares one level and is
    /// left-associative, as Tempo evaluates them (`{a} || {b} && {c}` is `({a} || {b}) && {c}`);
    /// then `+ -` < `* / %` < `^`.
    fn binary(&mut self, min: u8) -> Result<Node, Error> {
        self.enter()?;
        let mut lhs = self.atom()?;
        loop {
            let pos = self.pos();
            let (prec, op): (u8, Option<Result<SpansetOp, BinOp>>) = match self.peek() {
                Tok::OrOr => (3, Some(Ok(SpansetOp::Or))),
                Tok::AndAnd => (3, Some(Ok(SpansetOp::And))),
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
            let rhs = self.binary(next_min)?;
            lhs = match op {
                Ok(s) => Node::Spanset(s, Box::new(lhs), Box::new(rhs), pos),
                Err(m) => Node::Math(m, Box::new(lhs), Box::new(rhs), pos),
            };
        }
        self.depth -= 1;
        Ok(lhs)
    }

    fn atom(&mut self) -> Result<Node, Error> {
        let start = self.pos();
        match self.next() {
            Tok::LBrace => {
                if matches!(self.peek(), Tok::RBrace) {
                    self.next();
                    return Ok(Node::Filter(FieldExpr::Static(Static::Bool(true)), start));
                }
                let e = self.field_or()?;
                self.expect(Tok::RBrace, "'}'")?;
                Ok(Node::Filter(e, start))
            }
            Tok::LParen => {
                let n = self.pipeline()?;
                self.expect(Tok::RParen, "')'")?;
                Ok(Node::Paren(Box::new(n), start))
            }
            Tok::Int(v) => Ok(Node::Num(Static::Int(self.int_value(v, false, start)?), start)),
            Tok::Float(v) => Ok(Node::Num(Static::Float(v), start)),
            Tok::Duration(v) => Ok(Node::Num(Static::Duration(v), start)),
            Tok::Minus => {
                if let Tok::Int(v) = self.peek().clone() {
                    self.next();
                    return Ok(Node::Num(Static::Int(self.int_value(v, true, start)?), start));
                }
                if let Tok::Float(v) = self.peek().clone() {
                    self.next();
                    return Ok(Node::Num(Static::Float(-v), start));
                }
                if let Tok::Duration(v) = self.peek().clone() {
                    self.next();
                    return Ok(Node::Num(Static::Duration(-v), start));
                }
                let n = self.atom()?;
                Ok(Node::Neg(Box::new(n), start))
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

    fn call(&mut self, name: String, start: usize) -> Result<Node, Error> {
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
                return Ok(Node::Agg(op, None, start));
            }
            if op == AggOp::Count {
                return Err(self.err_at(start, "count() takes no argument"));
            }
            let arg_pos = self.pos();
            let e = self.field_or()?;
            self.expect(Tok::RParen, "')'")?;
            // The argument must be numeric (a parse error in Tempo) and read the span.
            let t = self.check(&e)?;
            if !t.numeric() {
                return Err(self.err_at(arg_pos, format!("{name}() needs a numeric argument")));
            }
            if !e.references_span() {
                return Err(self.verr(arg_pos, format!("the argument of {name}() must read the span")));
            }
            return Ok(Node::Agg(op, Some(e), start));
        }
        match name.as_str() {
            "by" => {
                let list = self.field_list(start, "by")?;
                if list.len() > 1 {
                    return Err(self.err_at(start, "by() in a spanset pipeline takes one expression"));
                }
                for e in &list {
                    self.check(e)?;
                    if !e.references_span() {
                        return Err(self.verr(start, "by() expressions must read the span"));
                    }
                }
                Ok(Node::By(list, start))
            }
            "coalesce" => {
                self.expect(Tok::RParen, "')'")?;
                Ok(Node::Coalesce(start))
            }
            "select" => {
                let list = self.field_list(start, "select")?;
                for e in &list {
                    if !matches!(e, FieldExpr::Attr { .. } | FieldExpr::Intrinsic(..)) {
                        return Err(self.err_at(start, "select() takes attributes and intrinsics only"));
                    }
                }
                Ok(Node::Select(list, start))
            }
            "rate" | "count_over_time" => {
                self.expect(Tok::RParen, "')'")?;
                let by = self.metrics_by()?;
                let f = if name == "rate" { MetricsFn::Rate } else { MetricsFn::CountOverTime };
                Ok(Node::Metrics(f, by, start))
            }
            "min_over_time" | "max_over_time" | "avg_over_time" | "sum_over_time" | "histogram_over_time" => {
                let arg_pos = self.pos();
                let e = self.field_or()?;
                self.expect(Tok::RParen, "')'")?;
                let t = self.check(&e)?;
                if !t.numeric() || !e.references_span() {
                    return Err(self.verr(arg_pos, format!("{name}() needs a numeric expression that reads the span")));
                }
                let by = self.metrics_by()?;
                let f = match name.as_str() {
                    "min_over_time" => MetricsFn::MinOverTime(e),
                    "max_over_time" => MetricsFn::MaxOverTime(e),
                    "avg_over_time" => MetricsFn::AvgOverTime(e),
                    "sum_over_time" => MetricsFn::SumOverTime(e),
                    _ => MetricsFn::HistogramOverTime(e),
                };
                Ok(Node::Metrics(f, by, start))
            }
            "quantile_over_time" => {
                let arg_pos = self.pos();
                let e = self.field_or()?;
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
                let by = self.metrics_by()?;
                Ok(Node::Metrics(MetricsFn::QuantileOverTime(e, qs), by, start))
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
                Ok(if name == "topk" { Node::TopK(k, start) } else { Node::BottomK(k, start) })
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
                Ok(Node::Compare(start))
            }
            _ => Err(self.err_at(start, format!("unknown function {name}()"))),
        }
    }

    fn field_list(&mut self, start: usize, what: &str) -> Result<Vec<FieldExpr>, Error> {
        if matches!(self.peek(), Tok::RParen) {
            return Err(self.err_at(start, format!("{what}() needs at least one argument")));
        }
        let mut out = vec![self.field_or()?];
        while matches!(self.peek(), Tok::Comma) {
            self.next();
            out.push(self.field_or()?);
        }
        self.expect(Tok::RParen, "')'")?;
        Ok(out)
    }

    fn metrics_by(&mut self) -> Result<Vec<FieldExpr>, Error> {
        if !self.peek_ident("by") || !matches!(self.peek2(), Tok::LParen) {
            return Ok(Vec::new());
        }
        let start = self.pos();
        self.next();
        self.next();
        let list = self.field_list(start, "by")?;
        for e in &list {
            self.check(e)?;
            if !e.references_span() {
                return Err(self.verr(start, "by() expressions must read the span"));
            }
        }
        Ok(list)
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

    fn field_or(&mut self) -> Result<FieldExpr, Error> {
        self.enter()?;
        let mut lhs = self.field_and()?;
        while matches!(self.peek(), Tok::OrOr) {
            self.next();
            let rhs = self.field_and()?;
            lhs = FieldExpr::Binary(BinOp::Or, Box::new(lhs), Box::new(rhs));
        }
        self.depth -= 1;
        Ok(lhs)
    }

    fn field_and(&mut self) -> Result<FieldExpr, Error> {
        let mut lhs = self.field_cmp()?;
        while matches!(self.peek(), Tok::AndAnd) {
            self.next();
            let rhs = self.field_cmp()?;
            lhs = FieldExpr::Binary(BinOp::And, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn field_cmp(&mut self) -> Result<FieldExpr, Error> {
        let mut lhs = self.field_add()?;
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
            let rhs = self.field_add()?;
            lhs = if matches!(op, BinOp::Re | BinOp::NRe) {
                let FieldExpr::Static(Static::Str(text)) = rhs else {
                    return Err(self.verr(pos, "the right side of a regex match must be a string"));
                };
                let re = regex::RegexBuilder::new(&format!("^(?s:{text})$"))
                    .size_limit(1 << 20)
                    .build()
                    .map_err(|e| self.verr(pos, format!("invalid regex {text:?}: {e}")))?;
                FieldExpr::Regex { lhs: Box::new(lhs), re: Box::new(Re(re)), negated: op == BinOp::NRe, text }
            } else {
                FieldExpr::Binary(op, Box::new(lhs), Box::new(rhs))
            };
        }
        Ok(lhs)
    }

    fn field_add(&mut self) -> Result<FieldExpr, Error> {
        let mut lhs = self.field_mul()?;
        loop {
            let op = match self.peek() {
                Tok::Plus => BinOp::Add,
                Tok::Minus => BinOp::Sub,
                _ => break,
            };
            self.next();
            let rhs = self.field_mul()?;
            lhs = FieldExpr::Binary(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn field_mul(&mut self) -> Result<FieldExpr, Error> {
        let mut lhs = self.field_pow()?;
        loop {
            let op = match self.peek() {
                Tok::Star => BinOp::Mul,
                Tok::Slash => BinOp::Div,
                Tok::Percent => BinOp::Mod,
                _ => break,
            };
            self.next();
            let rhs = self.field_pow()?;
            lhs = FieldExpr::Binary(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn field_pow(&mut self) -> Result<FieldExpr, Error> {
        let lhs = self.field_unary()?;
        if matches!(self.peek(), Tok::Caret) {
            self.next();
            self.enter()?;
            let rhs = self.field_pow()?;
            self.depth -= 1;
            return Ok(FieldExpr::Binary(BinOp::Pow, Box::new(lhs), Box::new(rhs)));
        }
        Ok(lhs)
    }

    fn field_unary(&mut self) -> Result<FieldExpr, Error> {
        match self.peek() {
            Tok::Minus => {
                self.next();
                self.enter()?;
                let e = match self.peek().clone() {
                    Tok::Int(v) => {
                        let p = self.pos();
                        self.next();
                        FieldExpr::Static(Static::Int(self.int_value(v, true, p)?))
                    }
                    Tok::Float(v) => {
                        self.next();
                        FieldExpr::Static(Static::Float(-v))
                    }
                    Tok::Duration(v) => {
                        self.next();
                        FieldExpr::Static(Static::Duration(-v))
                    }
                    _ => FieldExpr::Unary(UnOp::Neg, Box::new(self.field_unary()?)),
                };
                self.depth -= 1;
                Ok(e)
            }
            Tok::Not => {
                self.next();
                self.enter()?;
                let e = FieldExpr::Unary(UnOp::Not, Box::new(self.field_unary()?));
                self.depth -= 1;
                Ok(e)
            }
            _ => self.field_primary(),
        }
    }

    fn field_primary(&mut self) -> Result<FieldExpr, Error> {
        let start = self.pos();
        match self.next() {
            Tok::LParen => {
                let e = self.field_or()?;
                self.expect(Tok::RParen, "')'")?;
                Ok(e)
            }
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
                "nestedSetLeft" | "nestedSetRight" | "nestedSetParent" => {
                    Err(Error::unsupported(format!("the undocumented intrinsic {w}")))
                }
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
        if b.spanset_like() {
            return Err(self.err_at(p, "cannot compare an aggregate with a spanset"));
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
                let l = self.metrics(*a)?;
                let r = self.metrics(*b)?;
                if is_compare(&l) || is_compare(&r) {
                    return Err(self.verr(p, "compare() cannot be used in arithmetic"));
                }
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

fn strip_cmp(n: &Node) -> &Node {
    match n {
        Node::Cmp(_, a, _, _) => a,
        other => other,
    }
}

fn is_compare(_m: &MetricsExpr) -> bool {
    false
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
