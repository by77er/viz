//! Runtime values and the comparison and arithmetic rules of TraceQL.
//!
//! The rules here were taken from the documentation and, where it is silent, from Tempo's
//! observed behaviour (`README.md`, "Differential run"):
//!
//! - Numbers of different kinds (int, float, duration) compare and combine by value, as
//!   Tempo's evaluator does (`.n * 1.0 > 4`, `.n > .f`). Tempo's storage layer, when it
//!   applies a lone condition itself, compares only values of the literal's type; that
//!   makes Tempo's answer depend on its query plan, and viz does not copy it.
//! - Integer arithmetic stays integral (`5 / 2 = 2`); a float operand makes a float.
//! - A comparison involving a missing value is false; `= nil` / `!= nil` test presence.
//! - Arrays: `=`, `=~` and the orderings hold if any element satisfies them; `!=` and `!~`
//!   hold if no element is equal or matches, as the documentation states.

use std::borrow::Cow;
use std::cmp::Ordering;

use crate::ast::{BinOp, Static};
use crate::data::{AttrValue, Kind, Status};

#[derive(Clone, Debug, PartialEq)]
pub enum Val<'a> {
    Nil,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(Cow<'a, str>),
    Duration(i64),
    Status(Status),
    Kind(Kind),
    /// An array attribute: comparisons look at its elements.
    Arr(&'a AttrValue),
}

impl<'a> Val<'a> {
    pub fn from_static(s: &'a Static) -> Val<'a> {
        match s {
            Static::Nil => Val::Nil,
            Static::Bool(b) => Val::Bool(*b),
            Static::Int(v) => Val::Int(*v),
            Static::Float(v) => Val::Float(*v),
            Static::Str(s) => Val::Str(Cow::Borrowed(s)),
            Static::Duration(v) => Val::Duration(*v),
            Static::Status(s) => Val::Status(*s),
            Static::Kind(k) => Val::Kind(*k),
        }
    }

    pub fn from_attr(v: &'a AttrValue) -> Val<'a> {
        match v {
            AttrValue::Str(s) => Val::Str(Cow::Borrowed(s)),
            AttrValue::Int(i) => Val::Int(*i),
            AttrValue::Float(f) => Val::Float(*f),
            AttrValue::Bool(b) => Val::Bool(*b),
            AttrValue::Other(_) => Val::Nil,
            arr => Val::Arr(arr),
        }
    }

    pub fn is_nil(&self) -> bool {
        matches!(self, Val::Nil)
    }

    /// As a number, for arithmetic and numeric comparison. Durations are nanoseconds.
    pub fn num(&self) -> Option<f64> {
        match self {
            Val::Int(v) | Val::Duration(v) => Some(*v as f64),
            Val::Float(v) => Some(*v),
            _ => None,
        }
    }

    pub fn into_owned(self) -> Val<'static> {
        match self {
            Val::Nil => Val::Nil,
            Val::Bool(b) => Val::Bool(b),
            Val::Int(v) => Val::Int(v),
            Val::Float(v) => Val::Float(v),
            Val::Str(s) => Val::Str(Cow::Owned(s.into_owned())),
            Val::Duration(v) => Val::Duration(v),
            Val::Status(s) => Val::Status(s),
            Val::Kind(k) => Val::Kind(k),
            // Arrays never outlive evaluation; owned copies are only made for grouping keys,
            // where an array groups as absent.
            Val::Arr(_) => Val::Nil,
        }
    }
}

/// Elements of an array attribute as values.
fn elements(v: &AttrValue) -> Vec<Val<'_>> {
    match v {
        AttrValue::StrArray(a) => a.iter().map(|s| Val::Str(Cow::Borrowed(s.as_str()))).collect(),
        AttrValue::IntArray(a) => a.iter().map(|v| Val::Int(*v)).collect(),
        AttrValue::FloatArray(a) => a.iter().map(|v| Val::Float(*v)).collect(),
        AttrValue::BoolArray(a) => a.iter().map(|v| Val::Bool(*v)).collect(),
        _ => Vec::new(),
    }
}

/// Regex match of a value (strings only; for arrays, `=~` holds if an element matches and
/// `!~` if none does).
pub fn regex_match(v: &Val, re: &regex::Regex, negated: bool) -> bool {
    match v {
        Val::Str(s) => re.is_match(s) != negated,
        Val::Arr(a) => {
            let els: Vec<Val> = elements(a).into_iter().filter(|e| matches!(e, Val::Str(_))).collect();
            if els.is_empty() {
                return false;
            }
            let any = els.iter().any(|e| matches!(e, Val::Str(s) if re.is_match(s)));
            if negated {
                !any
            } else {
                any
            }
        }
        _ => false,
    }
}

/// `x = nil` holds when `x` is missing, `x != nil` when it is present; other operators with
/// `nil` never hold.
pub fn nil_test(x: &Val, op: BinOp) -> bool {
    match op {
        BinOp::Eq => x.is_nil(),
        BinOp::Neq => !x.is_nil(),
        _ => false,
    }
}

/// Ordering of two values of compatible kinds; `None` if they cannot be compared.
pub fn order(a: &Val, b: &Val) -> Option<Ordering> {
    match (a, b) {
        (Val::Str(x), Val::Str(y)) => Some(x.as_ref().cmp(y.as_ref())),
        (Val::Bool(x), Val::Bool(y)) => Some(x.cmp(y)),
        (Val::Status(x), Val::Status(y)) => Some(x.cmp(y)),
        (Val::Kind(x), Val::Kind(y)) => Some(x.cmp(y)),
        (Val::Int(x), Val::Int(y)) | (Val::Duration(x), Val::Duration(y)) | (Val::Int(x), Val::Duration(y)) | (Val::Duration(x), Val::Int(y)) => {
            Some(x.cmp(y))
        }
        _ => {
            let x = a.num()?;
            let y = b.num()?;
            x.partial_cmp(&y)
        }
    }
}

/// A computed comparison (operands are values, not a bare attribute against a literal).
/// A missing value fails every comparison; only a literal `nil` tests presence, and that is
/// handled where the literal is visible ([`nil_test`]).
pub fn compare(a: &Val, op: BinOp, b: &Val) -> bool {
    if a.is_nil() || b.is_nil() {
        return false;
    }
    if let Val::Arr(arr) = a {
        let els = elements(arr);
        return match op {
            BinOp::Neq => !els.iter().any(|e| compare(e, BinOp::Eq, b)),
            _ => els.iter().any(|e| compare(e, op, b)),
        };
    }
    if let Val::Arr(_) = b {
        let flipped = match op {
            BinOp::Lt => BinOp::Gt,
            BinOp::Lte => BinOp::Gte,
            BinOp::Gt => BinOp::Lt,
            BinOp::Gte => BinOp::Lte,
            o => o,
        };
        return compare(b, flipped, a);
    }
    let Some(ord) = order(a, b) else {
        // NaN is unequal to every number (IEEE 754), and unordered.
        return op == BinOp::Neq && a.num().is_some() && b.num().is_some();
    };
    match op {
        BinOp::Eq => ord == Ordering::Equal,
        BinOp::Neq => ord != Ordering::Equal,
        BinOp::Lt => ord == Ordering::Less,
        BinOp::Lte => ord != Ordering::Greater,
        BinOp::Gt => ord == Ordering::Greater,
        BinOp::Gte => ord != Ordering::Less,
        _ => false,
    }
}

/// Arithmetic. Integers stay integral (division truncates; division or remainder by zero
/// is nil); any float makes a float; a duration with integers stays a duration.
pub fn arith(op: BinOp, a: &Val, b: &Val) -> Val<'static> {
    let int_like = |v: &Val| matches!(v, Val::Int(_) | Val::Duration(_));
    if int_like(a) && int_like(b) {
        let (Some(x), Some(y)) = (as_i64(a), as_i64(b)) else { return Val::Nil };
        let r = match op {
            BinOp::Add => x.checked_add(y),
            BinOp::Sub => x.checked_sub(y),
            BinOp::Mul => x.checked_mul(y),
            BinOp::Div => {
                if y == 0 {
                    None
                } else {
                    x.checked_div(y)
                }
            }
            BinOp::Mod => {
                if y == 0 {
                    None
                } else {
                    x.checked_rem(y)
                }
            }
            BinOp::Pow => {
                return Val::Float((x as f64).powf(y as f64));
            }
            _ => None,
        };
        let Some(r) = r else { return Val::Nil };
        return if matches!(a, Val::Duration(_)) || matches!(b, Val::Duration(_)) { Val::Duration(r) } else { Val::Int(r) };
    }
    let (Some(x), Some(y)) = (a.num(), b.num()) else { return Val::Nil };
    Val::Float(match op {
        BinOp::Add => x + y,
        BinOp::Sub => x - y,
        BinOp::Mul => x * y,
        BinOp::Div => x / y,
        BinOp::Mod => x % y,
        BinOp::Pow => x.powf(y),
        _ => return Val::Nil,
    })
}

fn as_i64(v: &Val) -> Option<i64> {
    match v {
        Val::Int(x) | Val::Duration(x) => Some(*x),
        _ => None,
    }
}

/// Go's `time.Duration.String()` format, which Tempo uses for duration values in results
/// (`437.5ms`, `1s`, `1m30s`, `0s`).
pub fn go_duration(ns: i64) -> String {
    if ns == 0 {
        return "0s".into();
    }
    let neg = ns < 0;
    let u = ns.unsigned_abs();
    let mut out = String::new();
    if u < 1_000_000_000 {
        // Sub-second: ns, µs or ms with a fraction.
        let (unit, div) = if u < 1_000 {
            ("ns", 1u64)
        } else if u < 1_000_000 {
            ("µs", 1_000)
        } else {
            ("ms", 1_000_000)
        };
        out.push_str(&frac(u, div));
        out.push_str(unit);
    } else {
        let h = u / 3_600_000_000_000;
        let rem = u % 3_600_000_000_000;
        let m = rem / 60_000_000_000;
        let s_ns = rem % 60_000_000_000;
        if h > 0 {
            out.push_str(&format!("{h}h"));
        }
        if h > 0 || m > 0 {
            out.push_str(&format!("{m}m"));
        }
        out.push_str(&frac(s_ns, 1_000_000_000));
        out.push('s');
    }
    if neg {
        format!("-{out}")
    } else {
        out
    }
}

fn frac(v: u64, div: u64) -> String {
    let whole = v / div;
    let rest = v % div;
    if rest == 0 {
        return whole.to_string();
    }
    let digits = div.trailing_zeros_dec();
    let mut f = format!("{rest:0width$}", width = digits);
    while f.ends_with('0') {
        f.pop();
    }
    format!("{whole}.{f}")
}

trait DecDigits {
    fn trailing_zeros_dec(self) -> usize;
}

impl DecDigits for u64 {
    fn trailing_zeros_dec(self) -> usize {
        let mut n = self;
        let mut d = 0;
        while n > 1 {
            n /= 10;
            d += 1;
        }
        d
    }
}

/// Lower-case hex.
pub fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

/// Hex without leading zeros, as Tempo prints trace ids.
pub fn hex_trimmed(bytes: &[u8]) -> String {
    let h = hex(bytes);
    h.trim_start_matches('0').to_string()
}
