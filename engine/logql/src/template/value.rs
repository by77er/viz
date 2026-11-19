//! Values a template computes with.

use std::rc::Rc;

#[derive(Debug, Clone, PartialEq)]
pub enum V {
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    /// Nanoseconds since the Unix epoch, UTC.
    Time(i128),
    Nil,
    /// A missing map key (Go's invalid value, printed `<no value>`).
    NoValue,
    List(Rc<Vec<V>>),
    /// Sorted by key.
    Map(Rc<Vec<(String, V)>>),
}

impl V {
    /// Go's `truth` for `if`, `with`, `and`, `or`, `not`.
    pub fn truthy(&self) -> bool {
        match self {
            V::Str(s) => !s.is_empty(),
            V::Int(i) => *i != 0,
            V::Float(f) => *f != 0.0,
            V::Bool(b) => *b,
            V::Time(_) => true,
            V::Nil | V::NoValue => false,
            V::List(l) => !l.is_empty(),
            V::Map(m) => !m.is_empty(),
        }
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            V::Str(_) => "string",
            V::Int(_) => "int",
            V::Float(_) => "float64",
            V::Bool(_) => "bool",
            V::Time(_) => "time.Time",
            V::Nil => "nil",
            V::NoValue => "<no value>",
            V::List(_) => "[]interface {}",
            V::Map(_) => "map[string]interface {}",
        }
    }

    pub fn from_json(j: &crate::json::JValue<'_>) -> V {
        use crate::json::JValue;
        match j {
            JValue::Null => V::Nil,
            JValue::Bool(b) => V::Bool(*b),
            JValue::Num(n) => V::Float(n.parse().unwrap_or(0.0)),
            JValue::Str(s) => V::Str(s.to_string()),
            JValue::Arr(a, _) => V::List(Rc::new(a.iter().map(V::from_json).collect())),
            JValue::Obj(m, _) => {
                let mut out: Vec<(String, V)> = Vec::with_capacity(m.len());
                for (k, v) in m {
                    // Later duplicates overwrite earlier ones, as decoding into a map does.
                    let v = V::from_json(v);
                    match out.iter_mut().find(|(ok, _)| ok == k) {
                        Some(slot) => slot.1 = v,
                        None => out.push((k.to_string(), v)),
                    }
                }
                out.sort_by(|a, b| a.0.cmp(&b.0));
                V::Map(Rc::new(out))
            }
        }
    }
}
