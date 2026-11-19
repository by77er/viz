//! A recursive-descent parser for LogQL, written from the documentation. Validation that
//! needs the whole tree (selectors that match everything, unwrap rules, grouping rules)
//! runs after parsing, in `validate`.

use crate::ast::*;
use crate::error::Error;
use crate::lexer::{lex, parse_error, Tok, Token};
use crate::text::{parse_bytes, parse_go_duration};

pub fn parse(src: &str) -> Result<Expr, Error> {
    let toks = lex(src)?;
    let mut p = Parser { src, toks, i: 0, depth: 0 };
    let e = p.expr(0)?;
    if p.peek() != &Tok::Eof {
        return Err(p.err_here(format!("syntax error: unexpected {}", p.peek().describe())));
    }
    let e = match e {
        Node::Log(l, _) => Expr::Log(l),
        Node::Metric(m, _) => Expr::Metric(m),
    };
    validate(src, &e)?;
    Ok(e)
}

/// Maximum nesting depth of parentheses and sub-expressions; deeper queries are refused
/// rather than risking the stack.
const MAX_DEPTH: usize = 200;

enum Node {
    Log(LogExpr, usize),
    Metric(MetricExpr, usize),
}

struct Parser<'a> {
    src: &'a str,
    toks: Vec<Token>,
    i: usize,
    depth: usize,
}

/// Words the grammar reserves, refused as label names in selectors and label filters.
const RESERVED: &[&str] = &["by", "without", "bool", "on", "ignoring", "group_left", "group_right", "offset", "and", "or", "unless"];

const STAGE_KEYWORDS: &[&str] = &[
    "json", "logfmt", "regexp", "pattern", "unpack", "line_format", "label_format", "decolorize", "drop", "keep", "unwrap",
];

impl<'a> Parser<'a> {
    fn peek(&self) -> &Tok {
        &self.toks[self.i].tok
    }
    fn peek_at(&self, k: usize) -> &Tok {
        &self.toks[(self.i + k).min(self.toks.len() - 1)].tok
    }
    fn pos(&self) -> usize {
        self.toks[self.i].pos
    }
    fn next(&mut self) -> Tok {
        let t = self.toks[self.i].tok.clone();
        if self.i < self.toks.len() - 1 {
            self.i += 1;
        }
        t
    }
    fn err_here(&self, msg: impl Into<String>) -> Error {
        parse_error(self.src, self.pos(), msg)
    }
    fn err_at(&self, pos: usize, msg: impl Into<String>) -> Error {
        parse_error(self.src, pos, msg)
    }
    fn unexpected(&self) -> Error {
        self.err_here(format!("syntax error: unexpected {}", self.peek().describe()))
    }
    fn expect(&mut self, t: Tok) -> Result<(), Error> {
        if *self.peek() == t {
            self.next();
            Ok(())
        } else {
            Err(self.err_here(format!("syntax error: unexpected {}, expecting {}", self.peek().describe(), t.describe())))
        }
    }
    fn is_ident(&self, s: &str) -> bool {
        matches!(self.peek(), Tok::Ident(x) if x == s)
    }
    fn ident(&mut self) -> Result<String, Error> {
        match self.peek().clone() {
            Tok::Ident(s) => {
                self.next();
                Ok(s)
            }
            _ => Err(self.err_here(format!("syntax error: unexpected {}, expecting IDENTIFIER", self.peek().describe()))),
        }
    }
    fn string(&mut self) -> Result<String, Error> {
        match self.peek().clone() {
            Tok::Str(s) => {
                self.next();
                Ok(s)
            }
            _ => Err(self.err_here(format!("syntax error: unexpected {}, expecting STRING", self.peek().describe()))),
        }
    }
    fn enter(&mut self) -> Result<(), Error> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.err_here(format!("query nested more than {MAX_DEPTH} levels deep")));
        }
        Ok(())
    }

    // ---- expressions ----

    fn binop(&self) -> Option<BinOp> {
        Some(match self.peek() {
            Tok::Ident(s) if s == "or" => BinOp::Or,
            Tok::Ident(s) if s == "and" => BinOp::And,
            Tok::Ident(s) if s == "unless" => BinOp::Unless,
            Tok::Add => BinOp::Add,
            Tok::Sub => BinOp::Sub,
            Tok::Mul => BinOp::Mul,
            Tok::Div => BinOp::Div,
            Tok::Mod => BinOp::Mod,
            Tok::Pow => BinOp::Pow,
            Tok::EqEq => BinOp::Eq,
            Tok::Neq => BinOp::Ne,
            Tok::Gt => BinOp::Gt,
            Tok::Gte => BinOp::Ge,
            Tok::Lt => BinOp::Lt,
            Tok::Lte => BinOp::Le,
            _ => return None,
        })
    }

    fn expr(&mut self, min_prec: u8) -> Result<Node, Error> {
        self.enter()?;
        let mut lhs = self.unary()?;
        while let Some(op) = self.binop() {
            let prec = op.precedence();
            if prec < min_prec {
                break;
            }
            let op_pos = self.pos();
            self.next();
            let mut bool_mod = false;
            if self.is_ident("bool") {
                self.next();
                bool_mod = true;
            }
            let mut matching = VectorMatching::default();
            if self.is_ident("on") || self.is_ident("ignoring") {
                let on = self.is_ident("on");
                self.next();
                matching.on = Some((on, self.label_list()?));
                if self.is_ident("group_left") || self.is_ident("group_right") {
                    let left = self.is_ident("group_left");
                    self.next();
                    let labels = if *self.peek() == Tok::LParen { self.label_list()? } else { Vec::new() };
                    matching.group = Some((left, labels));
                }
            }
            // `^` is right-associative, everything else left-associative.
            let next_min = if op == BinOp::Pow { prec } else { prec + 1 };
            let rhs = self.expr(next_min)?;
            let (l, lpos) = self.metric(lhs, "binary operation")?;
            let (r, _) = self.metric(rhs, "binary operation")?;
            if matching.group.is_some() && op.is_set() {
                return Err(self.err_at(op_pos, format!("syntax error: no grouping allowed for \"{}\" operation", op.as_str())));
            }
            if op.is_set() && (l.is_scalar() || r.is_scalar()) {
                return Err(self.err_at(op_pos, format!("syntax error: set operator \"{}\" not allowed in binary scalar expression", op.as_str())));
            }
            lhs = Node::Metric(MetricExpr::Binary { op, lhs: Box::new(l), rhs: Box::new(r), bool_mod, matching }, lpos);
        }
        self.depth -= 1;
        Ok(lhs)
    }

    fn metric(&self, n: Node, ctx: &str) -> Result<(MetricExpr, usize), Error> {
        match n {
            Node::Metric(m, p) => Ok((m, p)),
            Node::Log(_, p) => Err(self.err_at(p, format!("syntax error: unexpected log query in {ctx}"))),
        }
    }

    fn unary(&mut self) -> Result<Node, Error> {
        let pos = self.pos();
        match self.peek() {
            // A sign is only accepted on a number literal.
            Tok::Sub | Tok::Add => {
                let neg = *self.peek() == Tok::Sub;
                self.next();
                if let Tok::Number(v, _) = self.peek().clone() {
                    self.next();
                    return Ok(Node::Metric(MetricExpr::Literal(if neg { -v } else { v }), pos));
                }
                Err(self.err_here(format!("syntax error: unexpected {}, expecting NUMBER", self.peek().describe())))
            }
            _ => self.primary(),
        }
    }

    fn primary(&mut self) -> Result<Node, Error> {
        let pos = self.pos();
        match self.peek().clone() {
            Tok::Number(v, _) => {
                self.next();
                Ok(Node::Metric(MetricExpr::Literal(v), pos))
            }
            Tok::LParen => {
                self.next();
                let inner = self.expr(0)?;
                self.expect(Tok::RParen)?;
                Ok(inner)
            }
            Tok::LBrace => Ok(Node::Log(self.log_expr()?, pos)),
            Tok::Ident(name) => {
                if let Some(op) = RangeOp::from_name(&name) {
                    if *self.peek_at(1) == Tok::LParen {
                        return Ok(Node::Metric(self.range_agg(op)?, pos));
                    }
                }
                if let Some(op) = VecOp::from_name(&name) {
                    return Ok(Node::Metric(self.vector_agg(op)?, pos));
                }
                match name.as_str() {
                    "vector" => {
                        self.next();
                        self.expect(Tok::LParen)?;
                        let v = match self.next() {
                            Tok::Number(v, _) => v,
                            other => return Err(self.err_at(self.toks[self.i - 1].pos, format!("syntax error: unexpected {}, expecting NUMBER", other.describe()))),
                        };
                        self.expect(Tok::RParen)?;
                        Ok(Node::Metric(MetricExpr::VectorLit(v), pos))
                    }
                    "label_replace" => {
                        self.next();
                        self.expect(Tok::LParen)?;
                        let inner = self.expr(0)?;
                        let (inner, _) = self.metric(inner, "label_replace")?;
                        self.expect(Tok::Comma)?;
                        let dst = self.string()?;
                        self.expect(Tok::Comma)?;
                        let replacement = self.string()?;
                        self.expect(Tok::Comma)?;
                        let src = self.string()?;
                        self.expect(Tok::Comma)?;
                        let regex_pos = self.pos();
                        let regex = self.string()?;
                        self.expect(Tok::RParen)?;
                        crate::goregex::compile_anchored(&regex)
                            .map_err(|e| self.err_at(regex_pos, format!("invalid regex in label_replace: {e}")))?;
                        Ok(Node::Metric(MetricExpr::LabelReplace { inner: Box::new(inner), dst, replacement, src, regex }, pos))
                    }
                    "approx_topk" => Err(Error::Unsupported("approx_topk (probabilistic aggregation) is not implemented".into())),
                    "variants" => Err(Error::Unsupported("variants(...) of (...) (multi-variant queries) is not implemented".into())),
                    _ => Err(self.unexpected()),
                }
            }
            _ => Err(self.unexpected()),
        }
    }

    fn signed_number(&mut self) -> Result<f64, Error> {
        let neg = if *self.peek() == Tok::Sub {
            self.next();
            true
        } else {
            if *self.peek() == Tok::Add {
                self.next();
            }
            false
        };
        match self.peek().clone() {
            Tok::Number(v, _) => {
                self.next();
                Ok(if neg { -v } else { v })
            }
            _ => Err(self.err_here(format!("syntax error: unexpected {}, expecting NUMBER", self.peek().describe()))),
        }
    }

    fn label_list(&mut self) -> Result<Vec<String>, Error> {
        self.expect(Tok::LParen)?;
        let mut out = Vec::new();
        if *self.peek() == Tok::RParen {
            self.next();
            return Ok(out);
        }
        loop {
            out.push(self.ident()?);
            match self.peek() {
                Tok::Comma => {
                    self.next();
                    if *self.peek() == Tok::RParen {
                        self.next();
                        break;
                    }
                }
                Tok::RParen => {
                    self.next();
                    break;
                }
                _ => return Err(self.unexpected()),
            }
        }
        Ok(out)
    }

    fn grouping(&mut self) -> Result<Option<Grouping>, Error> {
        if self.is_ident("by") || self.is_ident("without") {
            let without = self.is_ident("without");
            self.next();
            let labels = self.label_list()?;
            return Ok(Some(Grouping { without, labels }));
        }
        Ok(None)
    }

    fn vector_agg(&mut self, op: VecOp) -> Result<MetricExpr, Error> {
        let pos = self.pos();
        self.next();
        let before = self.grouping()?;
        self.expect(Tok::LParen)?;
        let mut param = None;
        if matches!(op, VecOp::Topk | VecOp::Bottomk) {
            let ppos = self.pos();
            let v = self.signed_number()?;
            if v.fract() != 0.0 || v < 1.0 || v > i64::MAX as f64 {
                return Err(self.err_at(ppos, format!("syntax error: invalid parameter {v} for {}: must be a positive integer", op.name())));
            }
            param = Some(v);
            self.expect(Tok::Comma)?;
        }
        let inner = self.expr(0)?;
        let (inner, _) = self.metric(inner, op.name())?;
        self.expect(Tok::RParen)?;
        let after = self.grouping()?;
        if before.is_some() && after.is_some() {
            return Err(self.err_at(pos, "syntax error: grouping given twice"));
        }
        let grouping = before.or(after);
        if matches!(op, VecOp::Sort | VecOp::SortDesc) && grouping.is_some() {
            return Err(self.err_at(pos, format!("syntax error: {} does not take a grouping", op.name())));
        }
        if inner.is_scalar() {
            return Err(self.err_at(pos, format!("syntax error: {} expects a vector, got a scalar", op.name())));
        }
        Ok(MetricExpr::Vector { op, param, inner: Box::new(inner), grouping })
    }

    fn range_agg(&mut self, op: RangeOp) -> Result<MetricExpr, Error> {
        let pos = self.pos();
        self.next();
        self.expect(Tok::LParen)?;
        let mut param = None;
        if op == RangeOp::QuantileOverTime {
            param = Some(self.signed_number()?);
            self.expect(Tok::Comma)?;
        }
        let range = self.log_range()?;
        self.expect(Tok::RParen)?;
        let grouping = self.grouping()?;
        if grouping.is_some() && matches!(op, RangeOp::SumOverTime | RangeOp::Rate | RangeOp::RateCounter | RangeOp::AbsentOverTime) {
            // The documentation lists these as not supporting grouping.
            if range.unwrap.is_some() || op != RangeOp::Rate {
                return Err(self.err_at(pos, format!("syntax error: grouping not allowed for {} aggregation", op.name())));
            }
        }
        if grouping.is_some() && range.unwrap.is_none() {
            return Err(self.err_at(pos, format!("syntax error: grouping not allowed for {} aggregation", op.name())));
        }
        if op.needs_unwrap() && range.unwrap.is_none() {
            return Err(self.err_at(pos, format!("invalid aggregation {} without unwrap", op.name())));
        }
        if op.log_only() && range.unwrap.is_some() {
            return Err(self.err_at(pos, format!("invalid aggregation {} with unwrap", op.name())));
        }
        Ok(MetricExpr::Range { op, param, range, grouping })
    }

    fn range_duration(&mut self) -> Result<i64, Error> {
        let pos = self.pos();
        let d = match self.next() {
            Tok::Unit(t) => crate::text::parse_prom_duration(&t).ok_or_else(|| self.err_at(pos, format!("syntax error: invalid duration {t:?}")))?,
            Tok::Number(v, t) if v == 0.0 => {
                let _ = t;
                0
            }
            other => return Err(self.err_at(pos, format!("syntax error: unexpected {}, expecting DURATION", other.describe()))),
        };
        Ok(d)
    }

    fn log_range(&mut self) -> Result<LogRange, Error> {
        self.enter()?;
        let mut paren = 0;
        while *self.peek() == Tok::LParen {
            self.next();
            paren += 1;
        }
        let sel_pos = self.pos();
        let matchers = self.selector()?;
        let mut range = None;
        if *self.peek() == Tok::LBracket {
            self.next();
            range = Some(self.range_duration()?);
            self.expect(Tok::RBracket)?;
        }
        let (stages, unwrap) = self.stages(true)?;
        for _ in 0..paren {
            self.expect(Tok::RParen)?;
        }
        if range.is_none() {
            if *self.peek() != Tok::LBracket {
                return Err(self.err_here(format!("syntax error: unexpected {}, expecting [", self.peek().describe())));
            }
            self.next();
            range = Some(self.range_duration()?);
            self.expect(Tok::RBracket)?;
        }
        let mut offset_ns = 0;
        if self.is_ident("offset") {
            self.next();
            let neg = if *self.peek() == Tok::Sub {
                self.next();
                true
            } else {
                false
            };
            let d = self.range_duration()?;
            offset_ns = if neg { -d } else { d };
        }
        let range_ns = range.unwrap_or(0);
        if range_ns < 0 {
            return Err(self.err_at(sel_pos, "syntax error: range must not be negative"));
        }
        self.depth -= 1;
        Ok(LogRange { log: LogExpr { matchers, stages }, unwrap, range_ns, offset_ns })
    }

    fn log_expr(&mut self) -> Result<LogExpr, Error> {
        let matchers = self.selector()?;
        let (stages, unwrap) = self.stages(false)?;
        debug_assert!(unwrap.is_none());
        Ok(LogExpr { matchers, stages })
    }

    fn selector(&mut self) -> Result<Vec<Matcher>, Error> {
        self.expect(Tok::LBrace)?;
        let mut out = Vec::new();
        loop {
            if *self.peek() == Tok::RBrace {
                self.next();
                break;
            }
            if let Tok::Ident(w) = self.peek() {
                if RESERVED.contains(&w.as_str()) {
                    return Err(self.err_here(format!("syntax error: unexpected {w}, expecting IDENTIFIER or }}")));
                }
            }
            let name = self.ident()?;
            let op_pos = self.pos();
            let op = match self.next() {
                Tok::Eq => MatchOp::Eq,
                Tok::Neq => MatchOp::Ne,
                Tok::Re => MatchOp::Re,
                Tok::Nre => MatchOp::Nre,
                other => return Err(self.err_at(op_pos, format!("syntax error: unexpected {}, expecting = or != or =~ or !~", other.describe()))),
            };
            let vpos = self.pos();
            let value = self.string()?;
            if matches!(op, MatchOp::Re | MatchOp::Nre) {
                crate::goregex::compile_anchored(&value).map_err(|e| self.err_at(vpos, format!("invalid regex {value:?}: {e}")))?;
            }
            out.push(Matcher::new(name, op, value));
            match self.peek() {
                Tok::Comma => {
                    self.next();
                }
                Tok::RBrace => {}
                _ => return Err(self.unexpected()),
            }
        }
        if out.is_empty() {
            return Err(self.err_here("syntax error: unexpected }, expecting IDENTIFIER"));
        }
        Ok(out)
    }

    // ---- pipeline ----

    fn stages(&mut self, allow_unwrap: bool) -> Result<(Vec<Stage>, Option<Unwrap>), Error> {
        let mut stages = Vec::new();
        loop {
            let op = match self.peek() {
                Tok::PipeExact => Some(LineFilterOp::Contains),
                Tok::Neq => Some(LineFilterOp::NotContains),
                Tok::PipeMatch => Some(LineFilterOp::Match),
                Tok::Nre => Some(LineFilterOp::NotMatch),
                Tok::PipePattern => Some(LineFilterOp::Pattern),
                Tok::NotPattern => Some(LineFilterOp::NotPattern),
                _ => None,
            };
            if let Some(op) = op {
                self.next();
                stages.push(Stage::LineFilter(self.line_filter(op)?));
                continue;
            }
            if *self.peek() != Tok::Pipe {
                return Ok((stages, None));
            }
            let pipe_pos = self.pos();
            self.next();
            let kw = match self.peek() {
                Tok::Ident(s) if STAGE_KEYWORDS.contains(&s.as_str()) => Some(s.clone()),
                _ => None,
            };
            let Some(kw) = kw else {
                stages.push(Stage::LabelFilter(self.label_filter()?));
                continue;
            };
            let kw_pos = self.pos();
            self.next();
            let stage = match kw.as_str() {
                "json" => Stage::Json(self.extraction_params(true)?),
                "logfmt" => {
                    let (mut strict, mut keep_empty) = (false, false);
                    while let Tok::Flag(f) = self.peek().clone() {
                        match f.as_str() {
                            "--strict" => strict = true,
                            "--keep-empty" => keep_empty = true,
                            _ => return Err(self.err_here(format!("syntax error: invalid logfmt flag {f}"))),
                        }
                        self.next();
                    }
                    Stage::Logfmt { strict, keep_empty, params: self.extraction_params(false)? }
                }
                "regexp" => {
                    let p = self.pos();
                    let re = self.string()?;
                    crate::pipeline::check_regexp_parser(&re).map_err(|e| self.err_at(p, e))?;
                    Stage::Regexp(re)
                }
                "pattern" => {
                    let p = self.pos();
                    let pat = self.string()?;
                    crate::pattern::Pattern::parse(&pat, true).map_err(|e| self.err_at(p, e))?;
                    Stage::Pattern(pat)
                }
                "unpack" => Stage::Unpack,
                "decolorize" => Stage::Decolorize,
                "line_format" => {
                    let p = self.pos();
                    let t = self.string()?;
                    crate::template::Template::parse(&t).map_err(|e| match e {
                        crate::template::TemplateError::Unsupported(m) => Error::Unsupported(m),
                        e => self.err_at(p, format!("invalid line template: {e}")),
                    })?;
                    Stage::LineFormat(t)
                }
                "label_format" => Stage::LabelFormat(self.label_format()?),
                "drop" => Stage::Drop(self.names_or_matchers()?),
                "keep" => Stage::Keep(self.names_or_matchers()?),
                "unwrap" => {
                    if !allow_unwrap {
                        return Err(self.err_at(kw_pos, "syntax error: unexpected unwrap in a log query"));
                    }
                    let unwrap = self.unwrap()?;
                    return Ok((stages, Some(unwrap)));
                }
                _ => return Err(self.err_at(pipe_pos, "syntax error")),
            };
            stages.push(stage);
        }
    }

    fn line_filter(&mut self, op: LineFilterOp) -> Result<LineFilter, Error> {
        let mut args = vec![self.filter_arg(op)?];
        // `|= "a" or "b"`: alternatives of the same operator.
        while self.is_ident("or") && (matches!(self.peek_at(1), Tok::Str(_)) || matches!(self.peek_at(1), Tok::Ident(s) if s == "ip")) {
            self.next();
            args.push(self.filter_arg(op)?);
        }
        Ok(LineFilter { op, args })
    }

    fn filter_arg(&mut self, op: LineFilterOp) -> Result<FilterArg, Error> {
        let pos = self.pos();
        if self.is_ident("ip") {
            self.next();
            self.expect(Tok::LParen)?;
            let p = self.string()?;
            self.expect(Tok::RParen)?;
            if !matches!(op, LineFilterOp::Contains | LineFilterOp::NotContains) {
                return Err(self.err_at(pos, "syntax error: ip() line filters only support |= and !="));
            }
            crate::ip::IpMatcher::parse(&p).map_err(|e| self.err_at(pos, e))?;
            return Ok(FilterArg::Ip(p));
        }
        let s = self.string()?;
        match op {
            // Line-filter regexes are compiled when the query runs (Loki's parser accepts
            // `|~ "error\\"` and fails at execution).
            LineFilterOp::Match | LineFilterOp::NotMatch => {}
            LineFilterOp::Pattern | LineFilterOp::NotPattern => {
                crate::pattern::Pattern::parse(&s, false).map_err(|e| self.err_at(pos, e))?;
            }
            _ => {}
        }
        Ok(FilterArg::Str(s))
    }

    fn extraction_params(&mut self, json: bool) -> Result<Vec<(String, String)>, Error> {
        let mut out = Vec::new();
        if !matches!(self.peek(), Tok::Ident(_)) {
            return Ok(out);
        }
        loop {
            let pos = self.pos();
            let name = self.ident()?;
            let expr = if *self.peek() == Tok::Eq {
                self.next();
                self.string()?
            } else {
                name.clone()
            };
            if json {
                crate::json::JsonPath::parse(&expr).map_err(|e| self.err_at(pos, e))?;
            }
            out.push((name, expr));
            if *self.peek() == Tok::Comma {
                self.next();
                continue;
            }
            break;
        }
        Ok(out)
    }

    fn label_format(&mut self) -> Result<Vec<LabelFmt>, Error> {
        let mut out: Vec<LabelFmt> = Vec::new();
        loop {
            let pos = self.pos();
            let dst = self.ident()?;
            self.expect(Tok::Eq)?;
            let item = match self.peek().clone() {
                Tok::Ident(src) => {
                    self.next();
                    LabelFmt::Rename { dst: dst.clone(), src }
                }
                Tok::Str(t) => {
                    let tp = self.pos();
                    self.next();
                    crate::template::Template::parse(&t).map_err(|e| match e {
                        crate::template::TemplateError::Unsupported(m) => Error::Unsupported(m),
                        e => self.err_at(tp, format!("invalid label template: {e}")),
                    })?;
                    LabelFmt::Template { dst: dst.clone(), template: t }
                }
                _ => return Err(self.unexpected()),
            };
            if out.iter().any(|f| match f {
                LabelFmt::Rename { dst: d, .. } | LabelFmt::Template { dst: d, .. } => *d == dst,
            }) {
                return Err(self.err_at(pos, format!("syntax error: multiple label name '{dst}' in the same format")));
            }
            out.push(item);
            if *self.peek() == Tok::Comma {
                self.next();
                continue;
            }
            break;
        }
        Ok(out)
    }

    fn names_or_matchers(&mut self) -> Result<Vec<NameOrMatcher>, Error> {
        let mut out = Vec::new();
        loop {
            let name = self.ident()?;
            let op = match self.peek() {
                Tok::Eq => Some(MatchOp::Eq),
                Tok::Neq => Some(MatchOp::Ne),
                Tok::Re => Some(MatchOp::Re),
                Tok::Nre => Some(MatchOp::Nre),
                _ => None,
            };
            if let Some(op) = op {
                self.next();
                let vpos = self.pos();
                let v = self.string()?;
                if matches!(op, MatchOp::Re | MatchOp::Nre) {
                    crate::goregex::compile_anchored(&v).map_err(|e| self.err_at(vpos, format!("invalid regex {v:?}: {e}")))?;
                }
                out.push(NameOrMatcher::Matcher(Matcher::new(name, op, v)));
            } else {
                out.push(NameOrMatcher::Name(name));
            }
            if *self.peek() == Tok::Comma {
                self.next();
                continue;
            }
            break;
        }
        Ok(out)
    }

    fn unwrap(&mut self) -> Result<Unwrap, Error> {
        let name = self.ident()?;
        let (label, conv) = if *self.peek() == Tok::LParen {
            let conv = match name.as_str() {
                "duration" | "duration_seconds" => UnwrapConv::Duration,
                "bytes" => UnwrapConv::Bytes,
                _ => return Err(self.err_here(format!("syntax error: unknown conversion function {name}"))),
            };
            self.next();
            let l = self.ident()?;
            self.expect(Tok::RParen)?;
            (l, conv)
        } else {
            (name, UnwrapConv::None)
        };
        let mut post_filters = Vec::new();
        while *self.peek() == Tok::Pipe {
            let is_stage = matches!(self.peek_at(1), Tok::Ident(s) if STAGE_KEYWORDS.contains(&s.as_str()));
            if is_stage {
                return Err(self.err_at(self.toks[self.i + 1].pos, "syntax error: only label filters are allowed after unwrap"));
            }
            self.next();
            post_filters.push(self.label_filter()?);
        }
        if matches!(self.peek(), Tok::PipeExact | Tok::PipeMatch | Tok::PipePattern | Tok::NotPattern | Tok::Neq | Tok::Nre) {
            return Err(self.err_here("syntax error: only label filters are allowed after unwrap"));
        }
        Ok(Unwrap { label, conv, post_filters })
    }

    // ---- label filters ----

    fn label_filter(&mut self) -> Result<LabelFilter, Error> {
        self.enter()?;
        let mut left = self.label_filter_term()?;
        loop {
            let and = if self.is_ident("and") || *self.peek() == Tok::Comma {
                self.next();
                true
            } else if self.is_ident("or") {
                self.next();
                false
            } else if (matches!(self.peek(), Tok::Ident(_)) && is_comparison(self.peek_at(1))) || *self.peek() == Tok::LParen {
                true // a space: `a > 1 b = "x"`
            } else {
                break;
            };
            let right = self.label_filter_term()?;
            left = if and { LabelFilter::And(Box::new(left), Box::new(right)) } else { LabelFilter::Or(Box::new(left), Box::new(right)) };
        }
        self.depth -= 1;
        Ok(left)
    }

    fn label_filter_term(&mut self) -> Result<LabelFilter, Error> {
        if *self.peek() == Tok::LParen {
            self.next();
            let f = self.label_filter()?;
            self.expect(Tok::RParen)?;
            return Ok(f);
        }
        if let Tok::Ident(w) = self.peek() {
            if RESERVED.contains(&w.as_str()) {
                return Err(self.err_here(format!("syntax error: unexpected {w}")));
            }
        }
        let name = self.ident()?;
        let op_pos = self.pos();
        let op_tok = self.next();
        let (cmp, str_op) = match op_tok {
            Tok::Eq => (Some(CmpOp::Eq), Some(MatchOp::Eq)),
            Tok::EqEq => (Some(CmpOp::Eq), None),
            Tok::Neq => (Some(CmpOp::Ne), Some(MatchOp::Ne)),
            Tok::Re => (None, Some(MatchOp::Re)),
            Tok::Nre => (None, Some(MatchOp::Nre)),
            Tok::Gt => (Some(CmpOp::Gt), None),
            Tok::Gte => (Some(CmpOp::Ge), None),
            Tok::Lt => (Some(CmpOp::Lt), None),
            Tok::Lte => (Some(CmpOp::Le), None),
            other => return Err(self.err_at(op_pos, format!("syntax error: unexpected {}, expecting a comparison operator", other.describe()))),
        };
        let vpos = self.pos();
        match self.peek().clone() {
            Tok::Str(v) => {
                let Some(op) = str_op else {
                    return Err(self.err_at(vpos, "syntax error: unexpected STRING, expecting NUMBER or DURATION or BYTES"));
                };
                self.next();
                if matches!(op, MatchOp::Re | MatchOp::Nre) {
                    crate::goregex::compile_anchored(&v).map_err(|e| self.err_at(vpos, format!("invalid regex {v:?}: {e}")))?;
                }
                Ok(LabelFilter::Matcher(Matcher::new(name, op, v)))
            }
            Tok::Ident(f) if f == "ip" => {
                let eq = match op_tok_kind(str_op, cmp) {
                    Some(e) => e,
                    None => return Err(self.err_at(op_pos, "syntax error: ip() label filters only support = and !=")),
                };
                self.next();
                self.expect(Tok::LParen)?;
                let ppos = self.pos();
                let pattern = self.string()?;
                self.expect(Tok::RParen)?;
                crate::ip::IpMatcher::parse(&pattern).map_err(|e| self.err_at(ppos, e))?;
                Ok(LabelFilter::Ip { name, eq, pattern })
            }
            Tok::Number(..) | Tok::Sub | Tok::Add => {
                let Some(op) = cmp else { return Err(self.unexpected()) };
                let v = self.signed_number()?;
                Ok(LabelFilter::Number { name, op, value: v })
            }
            Tok::Unit(t) => {
                let Some(op) = cmp else { return Err(self.unexpected()) };
                self.next();
                if let Some(d) = parse_go_duration(&t).or_else(|| crate::text::parse_prom_duration(&t)) {
                    return Ok(LabelFilter::Duration { name, op, value: d });
                }
                if let Some(b) = parse_bytes(&t) {
                    return Ok(LabelFilter::Bytes { name, op, value: b });
                }
                Err(self.err_at(vpos, format!("syntax error: invalid duration or bytes {t:?}")))
            }
            _ => Err(self.unexpected()),
        }
    }
}

fn op_tok_kind(str_op: Option<MatchOp>, cmp: Option<CmpOp>) -> Option<bool> {
    match (str_op, cmp) {
        (Some(MatchOp::Eq), _) => Some(true),
        (Some(MatchOp::Ne), _) => Some(false),
        _ => None,
    }
}

fn is_comparison(t: &Tok) -> bool {
    matches!(t, Tok::Eq | Tok::EqEq | Tok::Neq | Tok::Re | Tok::Nre | Tok::Gt | Tok::Gte | Tok::Lt | Tok::Lte)
}

pub fn valid_label_name(s: &str) -> bool {
    let mut it = s.chars();
    match it.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    it.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// ---- validation ----

fn validate(src: &str, e: &Expr) -> Result<(), Error> {
    match e {
        Expr::Log(l) => validate_selector(src, &l.matchers),
        Expr::Metric(m) => {
            let mut ranges = Vec::new();
            m.ranges(&mut ranges);
            for r in ranges {
                validate_selector(src, &r.log.matchers)?;
            }
            Ok(())
        }
    }
}

/// A selector must contain at least one matcher that does not match the empty string, so
/// that it cannot select every stream.
fn validate_selector(src: &str, ms: &[Matcher]) -> Result<(), Error> {
    for m in ms {
        let empty_ok = match m.op {
            MatchOp::Eq => m.value.is_empty(),
            MatchOp::Ne => !m.value.is_empty(),
            MatchOp::Re => crate::goregex::compile_anchored(&m.value).map(|r| r.is_match("")).unwrap_or(true),
            MatchOp::Nre => crate::goregex::compile_anchored(&m.value).map(|r| !r.is_match("")).unwrap_or(true),
        };
        if !empty_ok {
            return Ok(());
        }
    }
    let _ = src;
    Err(Error::Parse {
        msg: "queries require at least one regexp or equality matcher that does not have an empty-compatible value. For instance, app=~\".*\" does not meet this requirement, but app=~\".+\" will".into(),
        line: 0,
        col: 0,
    })
}
