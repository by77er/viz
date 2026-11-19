//! The label set of one log entry while it moves through a pipeline: stream labels,
//! structured metadata and labels extracted by parsers, plus the error labels.

pub const ERROR: &str = "__error__";
pub const ERROR_DETAILS: &str = "__error_details__";

pub const ERR_JSON: &str = "JSONParserErr";
pub const ERR_LOGFMT: &str = "LogfmtParserErr";
pub const ERR_LABEL_FILTER: &str = "LabelFilterErr";
pub const ERR_TEMPLATE: &str = "TemplateFormatErr";
pub const ERR_SAMPLE: &str = "SampleExtractionErr";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cat {
    Stream,
    Meta,
    Parsed,
}

#[derive(Debug, Clone, Default)]
pub struct LabelSet {
    items: Vec<(String, String, Cat)>,
}

impl LabelSet {
    pub fn new(stream: &[(String, String)], meta: &[(String, String)]) -> LabelSet {
        let mut items: Vec<(String, String, Cat)> = Vec::with_capacity(stream.len() + meta.len() + 4);
        for (k, v) in stream {
            items.push((k.clone(), v.clone(), Cat::Stream));
        }
        for (k, v) in meta {
            if !items.iter().any(|(n, _, _)| n == k) {
                items.push((k.clone(), v.clone(), Cat::Meta));
            }
        }
        LabelSet { items }
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.items.iter().find(|(n, _, _)| n == name).map(|(_, v, _)| v.as_str())
    }

    pub fn has(&self, name: &str) -> bool {
        self.items.iter().any(|(n, _, _)| n == name)
    }

    pub fn set(&mut self, name: &str, value: String, cat: Cat) {
        match self.items.iter_mut().find(|(n, _, _)| n == name) {
            Some(slot) => slot.1 = value,
            None => self.items.push((name.to_string(), value, cat)),
        }
    }

    pub fn remove(&mut self, name: &str) {
        self.items.retain(|(n, _, _)| n != name);
    }

    pub fn retain(&mut self, mut f: impl FnMut(&str, &str) -> bool) {
        self.items.retain(|(n, v, _)| f(n, v));
    }

    /// Add a label extracted by a parser: a name that is already a stream label or
    /// structured metadata gets the suffix `_extracted`; a name already extracted keeps its
    /// first value.
    pub fn add_parsed(&mut self, name: &str, value: &str) {
        let mut name = std::borrow::Cow::Borrowed(name);
        if let Some((_, _, cat)) = self.items.iter().find(|(n, _, _)| n == name.as_ref()) {
            if *cat == Cat::Parsed {
                return;
            }
            name = std::borrow::Cow::Owned(format!("{name}_extracted"));
            if self.has(&name) {
                return;
            }
        }
        self.items.push((name.into_owned(), value.to_string(), Cat::Parsed));
    }

    /// Set the error labels unless an error is already set (the first error wins).
    pub fn set_error(&mut self, err: &str, details: Option<&str>) {
        if self.has(ERROR) {
            return;
        }
        self.items.push((ERROR.to_string(), err.to_string(), Cat::Parsed));
        if let Some(d) = details {
            self.items.push((ERROR_DETAILS.to_string(), d.to_string(), Cat::Parsed));
        }
    }

    pub fn has_error(&self) -> bool {
        self.has(ERROR)
    }

    /// The labels as sorted pairs.
    pub fn sorted(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self.items.iter().map(|(n, v, _)| (n.clone(), v.clone())).collect();
        v.sort();
        v
    }
}

/// Make an extracted key a valid label name: every character other than ASCII letters,
/// digits, `_` and `:` becomes `_`, and a leading digit gets a `_` prefix. Empty stays empty.
pub fn sanitize(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 1);
    for (i, c) in key.chars().enumerate() {
        if i == 0 && c.is_ascii_digit() {
            out.push('_');
        }
        if c.is_ascii_alphanumeric() || c == '_' || c == ':' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    out
}

/// `{a="1", b="2"}` with Go-quoted values, as Loki prints a label set in messages.
pub fn label_string(labels: &[(String, String)]) -> String {
    let parts: Vec<String> = labels.iter().map(|(k, v)| format!("{k}={}", crate::template::gofmt::go_quote(v))).collect();
    format!("{{{}}}", parts.join(", "))
}
