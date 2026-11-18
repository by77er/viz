//! Result types and their serialisation to the Prometheus HTTP API `data` shape.

use serde::ser::{SerializeMap, SerializeSeq, SerializeStruct, SerializeTuple};
use serde::{Serialize, Serializer};

use crate::types::{format_float, Matcher};

/// One series of a matrix result.
#[derive(Debug, Clone, PartialEq)]
pub struct MatrixSeries {
    /// Sorted label pairs.
    pub metric: Vec<(String, String)>,
    /// `(timestamp_ms, value)`, ascending.
    pub points: Vec<(i64, f64)>,
}

/// Result of a range query. Series are sorted by label set.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Matrix {
    pub series: Vec<MatrixSeries>,
}

/// One sample of an instant vector result.
#[derive(Debug, Clone, PartialEq)]
pub struct VectorSample {
    pub metric: Vec<(String, String)>,
    pub t_ms: i64,
    pub value: f64,
}

/// Result of an instant query.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Vector(Vec<VectorSample>),
    Scalar { t_ms: i64, value: f64 },
    String { t_ms: i64, value: String },
    /// A range vector at the top level of an instant query (`m[5m]`).
    Matrix(Matrix),
}

/// A selector of a query and the sample range it will read.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectorInfo {
    pub matchers: Vec<Matcher>,
    /// Inclusive, Unix ms.
    pub min_ts_ms: i64,
    /// Inclusive, Unix ms.
    pub max_ts_ms: i64,
    /// Number of evaluation steps of the (sub)query this selector belongs to. The
    /// evaluator materialises one cell per returned series per step for the selector, so
    /// `series x steps` is the memory a caller can bound before evaluating. Not serialised.
    pub steps: usize,
}

struct Metric<'a>(&'a [(String, String)]);

impl Serialize for Metric<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

/// Unix seconds. Whole seconds are written as integers, as Prometheus does.
struct Ts(i64);

impl Serialize for Ts {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if self.0 % 1000 == 0 {
            s.serialize_i64(self.0 / 1000)
        } else {
            s.serialize_f64(self.0 as f64 / 1000.0)
        }
    }
}

struct Point(i64, f64);

impl Serialize for Point {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut t = s.serialize_tuple(2)?;
        t.serialize_element(&Ts(self.0))?;
        t.serialize_element(&format_float(self.1))?;
        t.end()
    }
}

struct Points<'a>(&'a [(i64, f64)]);

impl Serialize for Points<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(self.0.len()))?;
        for (t, v) in self.0 {
            seq.serialize_element(&Point(*t, *v))?;
        }
        seq.end()
    }
}

impl Serialize for MatrixSeries {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("MatrixSeries", 2)?;
        st.serialize_field("metric", &Metric(&self.metric))?;
        st.serialize_field("values", &Points(&self.points))?;
        st.end()
    }
}

impl Serialize for Matrix {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("Matrix", 2)?;
        st.serialize_field("resultType", "matrix")?;
        st.serialize_field("result", &self.series)?;
        st.end()
    }
}

impl Serialize for VectorSample {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("VectorSample", 2)?;
        st.serialize_field("metric", &Metric(&self.metric))?;
        st.serialize_field("value", &Point(self.t_ms, self.value))?;
        st.end()
    }
}

struct StrPoint<'a>(i64, &'a str);

impl Serialize for StrPoint<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut t = s.serialize_tuple(2)?;
        t.serialize_element(&Ts(self.0))?;
        t.serialize_element(self.1)?;
        t.end()
    }
}

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if let Value::Matrix(m) = self {
            return m.serialize(s);
        }
        let mut st = s.serialize_struct("Value", 2)?;
        match self {
            Value::Vector(v) => {
                st.serialize_field("resultType", "vector")?;
                st.serialize_field("result", v)?;
            }
            Value::Scalar { t_ms, value } => {
                st.serialize_field("resultType", "scalar")?;
                st.serialize_field("result", &Point(*t_ms, *value))?;
            }
            Value::String { t_ms, value } => {
                st.serialize_field("resultType", "string")?;
                st.serialize_field("result", &StrPoint(*t_ms, value))?;
            }
            Value::Matrix(_) => {}
        }
        st.end()
    }
}

impl Serialize for Matcher {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("Matcher", 3)?;
        st.serialize_field("name", &self.name)?;
        st.serialize_field("op", self.op.as_str())?;
        st.serialize_field("value", &self.value)?;
        st.end()
    }
}

impl Serialize for SelectorInfo {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("SelectorInfo", 3)?;
        st.serialize_field("matchers", &self.matchers)?;
        st.serialize_field("minTs", &self.min_ts_ms)?;
        st.serialize_field("maxTs", &self.max_ts_ms)?;
        st.end()
    }
}
