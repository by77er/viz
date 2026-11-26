//! `VZB1` signals 2 (spans) and 3 (log records): `contracts/BATCH.md`, "Rules common to
//! signals 2 and 3", "Spans, signal 2", "Log records, signal 3".
//!
//! [`decode_spans`] and [`decode_logs`] borrow from the input, validate everything the
//! contract states and never panic: any byte string either decodes or returns a
//! [`SignalBatchError`]. Decoding is strict, so for every input that decodes,
//! [`encode_spans`] / [`encode_logs`] of the result gives the same bytes (tested).
//!
//! `resource_fp` and `stream_id` are not recomputed on decode: only `edge` computes them and
//! everything downstream trusts them, as for `series_id`. [`stream_id`] is here for tools
//! and tests; it is [`crate::batch::series_id`].
use std::fmt;

/// `signal` of a span batch.
pub const SIGNAL_SPANS: u8 = 2;
/// `signal` of a log-record batch.
pub const SIGNAL_LOGS: u8 = 3;

/// Attribute limits (`contracts/BATCH.md`, "Typed attribute list").
pub const MAX_ATTRS: usize = 128;
pub const MAX_ATTR_KEY_BYTES: usize = 1024;
pub const MAX_ATTR_VALUE_BYTES: usize = 65_536;
/// Span fields.
pub const MAX_SPAN_STRING_BYTES: usize = 8192;
pub const MAX_EVENTS: usize = 128;
pub const MAX_LINKS: usize = 128;
pub const MAX_SPAN_ROW_BYTES: usize = 262_144;
pub const MAX_SPAN_ENTRY_BYTES: usize = 262_144;
/// Bytes a span row occupies besides its variable data: fixed columns and six offsets.
pub const SPAN_ROW_FIXED_BYTES: usize = 70 + 6 * 4;
/// Log fields.
pub const MAX_STREAM_LABELS: usize = 32;
pub const MAX_LABEL_NAME_BYTES: usize = 1024;
pub const MAX_LABEL_VALUE_BYTES: usize = 8192;
pub const MAX_LINE_BYTES: usize = 262_144;
pub const MAX_SEVERITY_TEXT_BYTES: usize = 1024;
pub const MAX_METADATA: usize = 128;
pub const MAX_METADATA_BYTES: usize = 65_536;

/// Why a signal-2 or signal-3 batch was rejected. Offsets are from the start of the batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalBatchError {
    BadMagic,
    Truncated { what: &'static str, needed: u64, len: u64 },
    /// `signal` is not the one the decoder reads.
    UnsupportedSignal(u8),
    BadFlags(u8),
    BadReserved(u16),
    EmptyMismatch { n_rows: u32, n_entries: u32 },
    NonZeroPadding { offset: u64 },
    TrailingBytes { expected: u64, len: u64 },
    EntryOutOfRange { row: u32, index: u32, n_entries: u32 },
    /// Any other rule of the contract, with where and what.
    Invalid(String),
    /// (encode only) a value does not fit the format (more than `u32::MAX` rows, a field
    /// longer than its length prefix allows).
    TooLarge(&'static str),
}

impl fmt::Display for SignalBatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use SignalBatchError::*;
        match self {
            BadMagic => write!(f, "bad magic: not a VZB1 batch"),
            Truncated { what, needed, len } => write!(f, "truncated: {what} needs {needed} bytes, batch has {len}"),
            UnsupportedSignal(s) => write!(f, "unexpected signal {s}"),
            BadFlags(x) => write!(f, "flags must be 0, got {x}"),
            BadReserved(x) => write!(f, "reserved must be 0, got {x}"),
            EmptyMismatch { n_rows, n_entries } => write!(f, "n_rows={n_rows} and n_entries={n_entries}: both or neither must be 0"),
            NonZeroPadding { offset } => write!(f, "non-zero padding byte at offset {offset}"),
            TrailingBytes { expected, len } => write!(f, "trailing bytes: batch ends at {expected}, input has {len}"),
            EntryOutOfRange { row, index, n_entries } => write!(f, "row {row}: entry index {index} out of range (n_entries={n_entries})"),
            Invalid(m) => write!(f, "{m}"),
            TooLarge(what) => write!(f, "{what} does not fit the batch format"),
        }
    }
}
impl std::error::Error for SignalBatchError {}

type R<T> = Result<T, SignalBatchError>;

fn invalid<T>(m: String) -> R<T> {
    Err(SignalBatchError::Invalid(m))
}

// ───────────────────────────── the logical model ─────────────────────────────

/// A typed attribute value. `S` is `&str` when decoded from a batch, `String` when owned.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Value<S> {
    Str(S),
    Int(i64),
    /// The IEEE 754 bits as received (NaN payloads included).
    Double(u64),
    Bool(bool),
    /// Canonical OTLP JSON of an array, key-value list, bytes or empty AnyValue.
    Other(S),
}

impl<S: AsRef<str>> Value<S> {
    pub fn to_owned_value(&self) -> Value<String> {
        match self {
            Value::Str(s) => Value::Str(s.as_ref().to_string()),
            Value::Int(i) => Value::Int(*i),
            Value::Double(b) => Value::Double(*b),
            Value::Bool(b) => Value::Bool(*b),
            Value::Other(s) => Value::Other(s.as_ref().to_string()),
        }
    }
    fn type_code(&self) -> u8 {
        match self {
            Value::Str(_) => 1,
            Value::Int(_) => 2,
            Value::Double(_) => 3,
            Value::Bool(_) => 4,
            Value::Other(_) => 5,
        }
    }
}

/// One attribute: key and typed value.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Attr<S> {
    pub key: S,
    pub value: Value<S>,
}

impl<S: AsRef<str>> Attr<S> {
    pub fn to_owned_attr(&self) -> Attr<String> {
        Attr { key: self.key.as_ref().to_string(), value: self.value.to_owned_value() }
    }
}

/// A span event. `attrs` is a canonical OTLP JSON key-value list (`[]` when none).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Event<S> {
    pub time_unix_nano: i64,
    pub name: S,
    pub attrs: S,
}

/// A span link. `attrs` is a canonical OTLP JSON key-value list (`[]` when none).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Link<S> {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub trace_state: S,
    pub attrs: S,
}

/// One entry of a span batch: a (resource, instrumentation scope) pair.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SpanEntry<S> {
    pub resource_fp: i64,
    /// Sorted by key (UTF-8 bytes), keys unique.
    pub resource: Vec<Attr<S>>,
    pub scope_name: S,
    pub scope_version: S,
    /// Canonical OTLP JSON key-value list, or `""` when the scope has no attributes.
    pub scope_attrs: S,
}

/// One span row.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Span<S> {
    pub entry: u32,
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    /// All zero: no parent.
    pub parent_span_id: [u8; 8],
    pub start: i64,
    pub end: i64,
    pub flags: u32,
    /// Dropped attributes, events, links counts.
    pub dropped: [u32; 3],
    pub kind: u8,
    pub status: u8,
    pub name: S,
    pub trace_state: S,
    pub status_message: S,
    /// Sorted by key (UTF-8 bytes), keys unique.
    pub attrs: Vec<Attr<S>>,
    pub events: Vec<Event<S>>,
    pub links: Vec<Link<S>>,
}

impl<S> Span<S> {
    pub fn parent(&self) -> Option<[u8; 8]> {
        (self.parent_span_id != [0; 8]).then_some(self.parent_span_id)
    }
}

/// A decoded span batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpanBatch<'a> {
    pub entries: Vec<SpanEntry<&'a str>>,
    pub rows: Vec<Span<&'a str>>,
}

/// One stream of a log batch.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LogStream<S> {
    pub stream_id: i64,
    /// Sorted by name (UTF-8 bytes), names unique, values non-empty.
    pub labels: Vec<(S, S)>,
}

/// One log-record row.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LogRow<S> {
    pub entry: u32,
    pub ts: i64,
    /// 0: absent.
    pub observed_ts: i64,
    /// All zero: absent.
    pub trace_id: [u8; 16],
    /// All zero: absent.
    pub span_id: [u8; 8],
    /// 0: absent.
    pub flags: u32,
    /// 0: absent; else 1 to 24.
    pub severity_number: u8,
    pub line: S,
    /// `""`: absent.
    pub severity_text: S,
    /// Sorted by name (UTF-8 bytes), names unique, values non-empty.
    pub metadata: Vec<(S, S)>,
}

/// A decoded log batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogBatch<'a> {
    pub streams: Vec<LogStream<&'a str>>,
    pub rows: Vec<LogRow<&'a str>>,
}

/// `stream_id` of a label set: exactly [`crate::batch::series_id`] (`contracts/LOGS.md`).
/// `labels` must already be sorted by name with empty values removed.
pub fn stream_id<N: AsRef<str>, V: AsRef<str>>(labels: &[(N, V)]) -> i64 {
    crate::batch::series_id(labels)
}

/// Whether a stream-label or metadata name follows the rule `[A-Za-z_][A-Za-z0-9_]*`.
pub fn valid_label_name(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty() && (b[0].is_ascii_alphabetic() || b[0] == b'_') && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

// ───────────────────────────── reading ─────────────────────────────

struct Cur<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Cur<'a> {
    fn take(&mut self, n: u64, what: &'static str) -> R<&'a [u8]> {
        let len = self.b.len() as u64;
        let end = self.at as u64 + n;
        if end > len {
            return Err(SignalBatchError::Truncated { what, needed: end, len });
        }
        let s = &self.b[self.at..end as usize];
        self.at = end as usize;
        Ok(s)
    }
    fn u16(&mut self, what: &'static str) -> R<u16> {
        Ok(u16::from_le_bytes(self.take(2, what)?.try_into().unwrap()))
    }
    fn u32(&mut self, what: &'static str) -> R<u32> {
        Ok(u32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }
    fn i64(&mut self, what: &'static str) -> R<i64> {
        Ok(i64::from_le_bytes(self.take(8, what)?.try_into().unwrap()))
    }
    fn align8(&mut self) -> R<()> {
        let n = (8 - self.at % 8) % 8;
        let start = self.at;
        let p = self.take(n as u64, "padding")?;
        match p.iter().position(|b| *b != 0) {
            Some(i) => Err(SignalBatchError::NonZeroPadding { offset: (start + i) as u64 }),
            None => Ok(()),
        }
    }
    /// A fixed-width column of `n` values of `width` bytes.
    fn fixed(&mut self, n: usize, width: usize, what: &'static str) -> R<&'a [u8]> {
        self.align8()?;
        self.take((n as u64) * width as u64, what)
    }
    /// A variable-length column: offsets and data, checked.
    fn var(&mut self, n: usize, what: &'static str) -> R<VarCol<'a>> {
        self.align8()?;
        let off = self.take(4 * (n as u64 + 1), what)?;
        let at = |i: usize| u32::from_le_bytes(off[4 * i..4 * i + 4].try_into().unwrap()) as usize;
        if at(0) != 0 {
            return invalid(format!("{what}: first offset is {}, not 0", at(0)));
        }
        for i in 0..n {
            if at(i + 1) < at(i) {
                return invalid(format!("{what}: offset of row {} decreases", i + 1));
            }
        }
        self.align8()?;
        let data = self.take(at(n) as u64, what)?;
        Ok(VarCol { off, data })
    }
    fn str(&mut self, n: u64, what: &'static str) -> R<&'a str> {
        let b = self.take(n, what)?;
        std::str::from_utf8(b).map_err(|_| SignalBatchError::Invalid(format!("{what} is not UTF-8")))
    }
    fn header(&mut self, signal: u8) -> R<(u32, u32)> {
        let bytes = self.b;
        let head = bytes.len().min(4);
        if bytes[..head] != crate::batch::MAGIC[..head] {
            return Err(SignalBatchError::BadMagic);
        }
        let h = self.take(16, "header")?;
        if h[4] != signal {
            return Err(SignalBatchError::UnsupportedSignal(h[4]));
        }
        if h[5] != 0 {
            return Err(SignalBatchError::BadFlags(h[5]));
        }
        let reserved = u16::from_le_bytes([h[6], h[7]]);
        if reserved != 0 {
            return Err(SignalBatchError::BadReserved(reserved));
        }
        let n_rows = u32::from_le_bytes(h[8..12].try_into().unwrap());
        let n_entries = u32::from_le_bytes(h[12..16].try_into().unwrap());
        if (n_rows == 0) != (n_entries == 0) {
            return Err(SignalBatchError::EmptyMismatch { n_rows, n_entries });
        }
        Ok((n_rows, n_entries))
    }
    fn end(&mut self) -> R<()> {
        self.align8()?;
        if self.at != self.b.len() {
            return Err(SignalBatchError::TrailingBytes { expected: self.at as u64, len: self.b.len() as u64 });
        }
        Ok(())
    }
}

struct VarCol<'a> {
    off: &'a [u8],
    data: &'a [u8],
}

impl<'a> VarCol<'a> {
    fn get(&self, i: usize) -> &'a [u8] {
        let at = |i: usize| u32::from_le_bytes(self.off[4 * i..4 * i + 4].try_into().unwrap()) as usize;
        &self.data[at(i)..at(i + 1)]
    }
}

fn utf8<'a>(b: &'a [u8], what: &dyn Fn() -> String) -> R<&'a str> {
    std::str::from_utf8(b).map_err(|_| SignalBatchError::Invalid(format!("{} is not UTF-8", what())))
}

/// Parse a typed attribute list that must fill `b` exactly.
fn parse_attrs<'a>(b: &'a [u8], ctx: &dyn Fn() -> String) -> R<Vec<Attr<&'a str>>> {
    let mut c = Cur { b, at: 0 };
    let bad = |m: &str| SignalBatchError::Invalid(format!("{}: {m}", ctx()));
    let n = c.u16("attribute count").map_err(|_| bad("truncated attribute count"))? as usize;
    if n > MAX_ATTRS {
        return Err(bad(&format!("{n} attributes, at most {MAX_ATTRS}")));
    }
    let mut out: Vec<Attr<&str>> = Vec::with_capacity(n);
    for _ in 0..n {
        let kl = c.u16("key").map_err(|_| bad("truncated"))? as u64;
        let key = c.str(kl, "attribute key").map_err(|_| bad("key truncated or not UTF-8"))?;
        if key.is_empty() || key.len() > MAX_ATTR_KEY_BYTES {
            return Err(bad("key empty or over 1,024 bytes"));
        }
        if let Some(prev) = out.last() {
            if prev.key.as_bytes() >= key.as_bytes() {
                return Err(bad("keys not sorted or not unique"));
            }
        }
        let t = c.take(1, "type").map_err(|_| bad("truncated"))?[0];
        let value = match t {
            1 | 5 => {
                let l = c.u32("value").map_err(|_| bad("truncated"))? as u64;
                if l as usize > MAX_ATTR_VALUE_BYTES {
                    return Err(bad("value over 65,536 bytes"));
                }
                let s = c.str(l, "value").map_err(|_| bad("value truncated or not UTF-8"))?;
                if t == 1 {
                    Value::Str(s)
                } else {
                    if s.is_empty() {
                        return Err(bad("empty \"other\" value"));
                    }
                    Value::Other(s)
                }
            }
            2 => Value::Int(c.i64("value").map_err(|_| bad("truncated"))?),
            3 => Value::Double(c.i64("value").map_err(|_| bad("truncated"))? as u64),
            4 => match c.take(1, "value").map_err(|_| bad("truncated"))?[0] {
                0 => Value::Bool(false),
                1 => Value::Bool(true),
                x => return Err(bad(&format!("bool value {x}"))),
            },
            x => return Err(bad(&format!("unknown attribute type {x}"))),
        };
        out.push(Attr { key, value });
    }
    if c.at != b.len() {
        return Err(bad("trailing bytes after the attribute list"));
    }
    Ok(out)
}

fn id16(b: &[u8], i: usize) -> [u8; 16] {
    b[16 * i..16 * i + 16].try_into().unwrap()
}
fn id8(b: &[u8], i: usize) -> [u8; 8] {
    b[8 * i..8 * i + 8].try_into().unwrap()
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(b[4 * i..4 * i + 4].try_into().unwrap())
}
fn i64_at(b: &[u8], i: usize) -> i64 {
    i64::from_le_bytes(b[8 * i..8 * i + 8].try_into().unwrap())
}

/// Decode and validate one span batch (signal 2).
pub fn decode_spans(bytes: &[u8]) -> R<SpanBatch<'_>> {
    let mut c = Cur { b: bytes, at: 0 };
    let (n_rows, n_entries) = c.header(SIGNAL_SPANS)?;
    let mut entries = Vec::with_capacity((n_entries as usize).min(bytes.len() / 16));
    for e in 0..n_entries {
        let start = c.at;
        let resource_fp = c.i64("resource_fp")?;
        let ctx = move || format!("entry {e}: resource");
        let res_start = c.at;
        // The attribute list's length is known only by walking it: parse from here to the end
        // and let the parser stop exactly where the list ends.
        let (resource, used) = parse_attrs_prefix(&bytes[res_start..], &ctx)?;
        c.at = res_start + used;
        let l = c.u16("scope_name length")? as u64;
        let scope_name = c.str(l, "scope_name")?;
        let l = c.u16("scope_version length")? as u64;
        let scope_version = c.str(l, "scope_version")?;
        let l = c.u32("scope_attrs length")? as u64;
        let scope_attrs = c.str(l, "scope_attrs")?;
        if scope_name.len() > MAX_SPAN_STRING_BYTES || scope_version.len() > MAX_SPAN_STRING_BYTES {
            return invalid(format!("entry {e}: scope name or version over 8,192 bytes"));
        }
        if c.at - start > MAX_SPAN_ENTRY_BYTES {
            return invalid(format!("entry {e}: {} bytes, at most {MAX_SPAN_ENTRY_BYTES}", c.at - start));
        }
        entries.push(SpanEntry { resource_fp, resource, scope_name, scope_version, scope_attrs });
    }
    let n = n_rows as usize;
    let entry = c.fixed(n, 4, "entry column")?;
    let trace_id = c.fixed(n, 16, "trace_id column")?;
    let span_id = c.fixed(n, 8, "span_id column")?;
    let parent = c.fixed(n, 8, "parent_span_id column")?;
    let start = c.fixed(n, 8, "start column")?;
    let end = c.fixed(n, 8, "end column")?;
    let flags = c.fixed(n, 4, "flags column")?;
    let dropped = c.fixed(n, 12, "dropped column")?;
    let kind = c.fixed(n, 1, "kind column")?;
    let status = c.fixed(n, 1, "status column")?;
    let name = c.var(n, "name column")?;
    let trace_state = c.var(n, "trace_state column")?;
    let status_message = c.var(n, "status_message column")?;
    let attrs = c.var(n, "attrs column")?;
    let events = c.var(n, "events column")?;
    let links = c.var(n, "links column")?;
    c.end()?;

    let mut rows = Vec::with_capacity(n);
    for i in 0..n {
        let row = i as u32;
        let e = u32_at(entry, i);
        if e >= n_entries {
            return Err(SignalBatchError::EntryOutOfRange { row, index: e, n_entries });
        }
        let t = id16(trace_id, i);
        let s = id8(span_id, i);
        if t == [0; 16] || s == [0; 8] {
            return invalid(format!("row {row}: all-zero trace_id or span_id"));
        }
        let (st, en) = (i64_at(start, i), i64_at(end, i));
        if st < 0 || en < st {
            return invalid(format!("row {row}: start {st} and end {en} (start must be >= 0 and end >= start)"));
        }
        if kind[i] > 5 || status[i] > 2 {
            return invalid(format!("row {row}: kind {} or status {} out of range", kind[i], status[i]));
        }
        let (nm, ts, sm) = (name.get(i), trace_state.get(i), status_message.get(i));
        if nm.len() > MAX_SPAN_STRING_BYTES || ts.len() > MAX_SPAN_STRING_BYTES || sm.len() > MAX_SPAN_STRING_BYTES {
            return invalid(format!("row {row}: name, trace_state or status_message over 8,192 bytes"));
        }
        let var_bytes = nm.len() + ts.len() + sm.len() + attrs.get(i).len() + events.get(i).len() + links.get(i).len();
        if SPAN_ROW_FIXED_BYTES + var_bytes > MAX_SPAN_ROW_BYTES {
            return invalid(format!("row {row}: {} bytes, at most {MAX_SPAN_ROW_BYTES}", SPAN_ROW_FIXED_BYTES + var_bytes));
        }
        let ctx = move || format!("row {row}: attrs");
        let d = |k: usize| u32::from_le_bytes(dropped[12 * i + 4 * k..12 * i + 4 * k + 4].try_into().unwrap());
        rows.push(Span {
            entry: e,
            trace_id: t,
            span_id: s,
            parent_span_id: id8(parent, i),
            start: st,
            end: en,
            flags: u32_at(flags, i),
            dropped: [d(0), d(1), d(2)],
            kind: kind[i],
            status: status[i],
            name: utf8(nm, &|| format!("row {row}: name"))?,
            trace_state: utf8(ts, &|| format!("row {row}: trace_state"))?,
            status_message: utf8(sm, &|| format!("row {row}: status_message"))?,
            attrs: parse_attrs(attrs.get(i), &ctx)?,
            events: parse_events(events.get(i), row)?,
            links: parse_links(links.get(i), row)?,
        });
    }
    Ok(SpanBatch { entries, rows })
}

/// Parse an attribute list at the start of `b`; return it and the bytes it took.
fn parse_attrs_prefix<'a>(b: &'a [u8], ctx: &dyn Fn() -> String) -> R<(Vec<Attr<&'a str>>, usize)> {
    // Walk the list to find its length, then parse exactly that slice.
    let bad = || SignalBatchError::Invalid(format!("{}: truncated attribute list", ctx()));
    let mut c = Cur { b, at: 0 };
    let n = c.u16("n").map_err(|_| bad())? as usize;
    if n > MAX_ATTRS {
        return invalid(format!("{}: {n} attributes, at most {MAX_ATTRS}", ctx()));
    }
    for _ in 0..n {
        let kl = c.u16("k").map_err(|_| bad())? as u64;
        c.take(kl, "k").map_err(|_| bad())?;
        let t = c.take(1, "t").map_err(|_| bad())?[0];
        match t {
            1 | 5 => {
                let l = c.u32("l").map_err(|_| bad())? as u64;
                c.take(l, "v").map_err(|_| bad())?;
            }
            2 | 3 => {
                c.take(8, "v").map_err(|_| bad())?;
            }
            4 => {
                c.take(1, "v").map_err(|_| bad())?;
            }
            x => return invalid(format!("{}: unknown attribute type {x}", ctx())),
        }
    }
    Ok((parse_attrs(&b[..c.at], ctx)?, c.at))
}

fn parse_events<'a>(b: &'a [u8], row: u32) -> R<Vec<Event<&'a str>>> {
    let mut c = Cur { b, at: 0 };
    let bad = |m: &str| SignalBatchError::Invalid(format!("row {row}: events: {m}"));
    let n = c.u16("events").map_err(|_| bad("truncated"))? as usize;
    if n > MAX_EVENTS {
        return Err(bad(&format!("{n} events, at most {MAX_EVENTS}")));
    }
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let time_unix_nano = c.i64("time").map_err(|_| bad("truncated"))?;
        if time_unix_nano < 0 {
            return Err(bad("negative time"));
        }
        let l = c.u16("name").map_err(|_| bad("truncated"))? as u64;
        let name = c.str(l, "name").map_err(|_| bad("name truncated or not UTF-8"))?;
        if name.len() > MAX_SPAN_STRING_BYTES {
            return Err(bad("name over 8,192 bytes"));
        }
        let l = c.u32("attrs").map_err(|_| bad("truncated"))? as u64;
        let attrs = c.str(l, "attrs").map_err(|_| bad("attrs truncated or not UTF-8"))?;
        if attrs.is_empty() {
            return Err(bad("empty attrs (an event without attributes has \"[]\")"));
        }
        out.push(Event { time_unix_nano, name, attrs });
    }
    if c.at != b.len() {
        return Err(bad("trailing bytes"));
    }
    Ok(out)
}

fn parse_links<'a>(b: &'a [u8], row: u32) -> R<Vec<Link<&'a str>>> {
    let mut c = Cur { b, at: 0 };
    let bad = |m: &str| SignalBatchError::Invalid(format!("row {row}: links: {m}"));
    let n = c.u16("links").map_err(|_| bad("truncated"))? as usize;
    if n > MAX_LINKS {
        return Err(bad(&format!("{n} links, at most {MAX_LINKS}")));
    }
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let trace_id: [u8; 16] = c.take(16, "trace_id").map_err(|_| bad("truncated"))?.try_into().unwrap();
        let span_id: [u8; 8] = c.take(8, "span_id").map_err(|_| bad("truncated"))?.try_into().unwrap();
        let l = c.u16("trace_state").map_err(|_| bad("truncated"))? as u64;
        let trace_state = c.str(l, "trace_state").map_err(|_| bad("trace_state truncated or not UTF-8"))?;
        if trace_state.len() > MAX_SPAN_STRING_BYTES {
            return Err(bad("trace_state over 8,192 bytes"));
        }
        let l = c.u32("attrs").map_err(|_| bad("truncated"))? as u64;
        let attrs = c.str(l, "attrs").map_err(|_| bad("attrs truncated or not UTF-8"))?;
        if attrs.is_empty() {
            return Err(bad("empty attrs (a link without attributes has \"[]\")"));
        }
        out.push(Link { trace_id, span_id, trace_state, attrs });
    }
    if c.at != b.len() {
        return Err(bad("trailing bytes"));
    }
    Ok(out)
}

/// Check a label or metadata list: sorted, unique, the name rule, non-empty values, limits.
fn check_pairs(pairs: &[(&str, &str)], max: usize, what: &dyn Fn() -> String) -> R<()> {
    if pairs.len() > max {
        return invalid(format!("{}: {} entries, at most {max}", what(), pairs.len()));
    }
    for (k, (n, v)) in pairs.iter().enumerate() {
        if !valid_label_name(n) || n.len() > MAX_LABEL_NAME_BYTES {
            return invalid(format!("{}: name {n:?} breaks the label-name rule", what()));
        }
        if v.is_empty() || v.len() > MAX_LABEL_VALUE_BYTES || v.as_bytes().contains(&0) {
            return invalid(format!("{}: value of {n:?} empty, over 8,192 bytes or with a NUL byte", what()));
        }
        if k > 0 && pairs[k - 1].0.as_bytes() >= n.as_bytes() {
            return invalid(format!("{}: names not sorted or not unique", what()));
        }
    }
    Ok(())
}

fn parse_pairs<'a>(c: &mut Cur<'a>, n: usize, what: &dyn Fn() -> String) -> R<Vec<(&'a str, &'a str)>> {
    let mut out = Vec::with_capacity(n.min(256));
    for _ in 0..n {
        let l = c.u16("name length").map_err(|_| SignalBatchError::Invalid(format!("{}: truncated", what())))? as u64;
        let name = c.str(l, "name").map_err(|_| SignalBatchError::Invalid(format!("{}: name truncated or not UTF-8", what())))?;
        let l = c.u16("value length").map_err(|_| SignalBatchError::Invalid(format!("{}: truncated", what())))? as u64;
        let value = c.str(l, "value").map_err(|_| SignalBatchError::Invalid(format!("{}: value truncated or not UTF-8", what())))?;
        out.push((name, value));
    }
    Ok(out)
}

/// Decode and validate one log-record batch (signal 3).
pub fn decode_logs(bytes: &[u8]) -> R<LogBatch<'_>> {
    let mut c = Cur { b: bytes, at: 0 };
    let (n_rows, n_entries) = c.header(SIGNAL_LOGS)?;
    let mut streams = Vec::with_capacity((n_entries as usize).min(bytes.len() / 12));
    for e in 0..n_entries {
        let stream_id = c.i64("stream_id")?;
        let n = c.u32("n_labels")? as usize;
        let what = move || format!("stream {e}: labels");
        if n > MAX_STREAM_LABELS {
            return invalid(format!("stream {e}: {n} labels, at most {MAX_STREAM_LABELS}"));
        }
        let labels = parse_pairs(&mut c, n, &what)?;
        check_pairs(&labels, MAX_STREAM_LABELS, &what)?;
        streams.push(LogStream { stream_id, labels });
    }
    let n = n_rows as usize;
    let entry = c.fixed(n, 4, "entry column")?;
    let ts = c.fixed(n, 8, "ts column")?;
    let observed = c.fixed(n, 8, "observed_ts column")?;
    let trace_id = c.fixed(n, 16, "trace_id column")?;
    let span_id = c.fixed(n, 8, "span_id column")?;
    let flags = c.fixed(n, 4, "flags column")?;
    let severity = c.fixed(n, 1, "severity_number column")?;
    let line = c.var(n, "line column")?;
    let sevtext = c.var(n, "severity_text column")?;
    let metadata = c.var(n, "metadata column")?;
    c.end()?;

    let mut rows = Vec::with_capacity(n);
    for i in 0..n {
        let row = i as u32;
        let e = u32_at(entry, i);
        if e >= n_entries {
            return Err(SignalBatchError::EntryOutOfRange { row, index: e, n_entries });
        }
        let (t, o) = (i64_at(ts, i), i64_at(observed, i));
        if t < 0 || o < 0 {
            return invalid(format!("row {row}: negative ts or observed_ts"));
        }
        if severity[i] > 24 {
            return invalid(format!("row {row}: severity_number {} over 24", severity[i]));
        }
        let l = line.get(i);
        if l.len() > MAX_LINE_BYTES {
            return invalid(format!("row {row}: line of {} bytes, at most {MAX_LINE_BYTES}", l.len()));
        }
        let st = sevtext.get(i);
        if st.len() > MAX_SEVERITY_TEXT_BYTES {
            return invalid(format!("row {row}: severity_text over 1,024 bytes"));
        }
        let mb = metadata.get(i);
        let mut mc = Cur { b: mb, at: 0 };
        let what = move || format!("row {row}: metadata");
        let m = mc.u16("metadata count").map_err(|_| SignalBatchError::Invalid(format!("row {row}: metadata truncated")))? as usize;
        let md = parse_pairs(&mut mc, m, &what)?;
        if mc.at != mb.len() {
            return invalid(format!("row {row}: metadata: trailing bytes"));
        }
        check_pairs(&md, MAX_METADATA, &what)?;
        let total: usize = md.iter().map(|(n, v)| n.len() + v.len()).sum();
        if total > MAX_METADATA_BYTES {
            return invalid(format!("row {row}: metadata of {total} bytes, at most {MAX_METADATA_BYTES}"));
        }
        rows.push(LogRow {
            entry: e,
            ts: t,
            observed_ts: o,
            trace_id: id16(trace_id, i),
            span_id: id8(span_id, i),
            flags: u32_at(flags, i),
            severity_number: severity[i],
            line: utf8(l, &|| format!("row {row}: line"))?,
            severity_text: utf8(st, &|| format!("row {row}: severity_text"))?,
            metadata: md,
        });
    }
    Ok(LogBatch { streams, rows })
}

// ───────────────────────────── writing ─────────────────────────────

struct W {
    out: Vec<u8>,
}

impl W {
    fn header(signal: u8, n_rows: usize, n_entries: usize) -> R<W> {
        let n_rows = u32::try_from(n_rows).map_err(|_| SignalBatchError::TooLarge("row count"))?;
        let n_entries = u32::try_from(n_entries).map_err(|_| SignalBatchError::TooLarge("entry count"))?;
        let mut out = Vec::with_capacity(1024);
        out.extend_from_slice(&crate::batch::MAGIC);
        out.extend_from_slice(&[signal, 0, 0, 0]);
        out.extend_from_slice(&n_rows.to_le_bytes());
        out.extend_from_slice(&n_entries.to_le_bytes());
        Ok(W { out })
    }
    fn pad(&mut self) {
        let n = self.out.len().div_ceil(8) * 8;
        self.out.resize(n, 0);
    }
    fn u16_len(&mut self, n: usize, what: &'static str) -> R<()> {
        let l = u16::try_from(n).map_err(|_| SignalBatchError::TooLarge(what))?;
        self.out.extend_from_slice(&l.to_le_bytes());
        Ok(())
    }
    fn u32_len(&mut self, n: usize, what: &'static str) -> R<()> {
        let l = u32::try_from(n).map_err(|_| SignalBatchError::TooLarge(what))?;
        self.out.extend_from_slice(&l.to_le_bytes());
        Ok(())
    }
    fn var<T>(&mut self, items: &[T], mut f: impl FnMut(&T, &mut Vec<u8>) -> R<()>) -> R<()> {
        self.pad();
        let mut data = Vec::new();
        let mut offs = Vec::with_capacity(items.len() + 1);
        offs.push(0u32);
        for it in items {
            f(it, &mut data)?;
            offs.push(u32::try_from(data.len()).map_err(|_| SignalBatchError::TooLarge("variable-length column"))?);
        }
        for o in offs {
            self.out.extend_from_slice(&o.to_le_bytes());
        }
        self.pad();
        self.out.extend_from_slice(&data);
        Ok(())
    }
}

fn put_u16_len(out: &mut Vec<u8>, n: usize, what: &'static str) -> R<()> {
    out.extend_from_slice(&u16::try_from(n).map_err(|_| SignalBatchError::TooLarge(what))?.to_le_bytes());
    Ok(())
}
fn put_u32_len(out: &mut Vec<u8>, n: usize, what: &'static str) -> R<()> {
    out.extend_from_slice(&u32::try_from(n).map_err(|_| SignalBatchError::TooLarge(what))?.to_le_bytes());
    Ok(())
}

/// Append the typed attribute list encoding of `attrs` (in the order given).
pub fn write_attrs<S: AsRef<str>>(attrs: &[Attr<S>], out: &mut Vec<u8>) -> R<()> {
    put_u16_len(out, attrs.len(), "attribute count")?;
    for a in attrs {
        let k = a.key.as_ref();
        put_u16_len(out, k.len(), "attribute key")?;
        out.extend_from_slice(k.as_bytes());
        out.push(a.value.type_code());
        match &a.value {
            Value::Str(s) | Value::Other(s) => {
                put_u32_len(out, s.as_ref().len(), "attribute value")?;
                out.extend_from_slice(s.as_ref().as_bytes());
            }
            Value::Int(i) => out.extend_from_slice(&i.to_le_bytes()),
            Value::Double(b) => out.extend_from_slice(&b.to_le_bytes()),
            Value::Bool(b) => out.push(*b as u8),
        }
    }
    Ok(())
}

/// Encode a span batch. The result is validated with [`decode_spans`], so anything this
/// returns decodes; `resource_fp` values are written as given.
pub fn encode_spans<S: AsRef<str>>(entries: &[SpanEntry<S>], rows: &[Span<S>]) -> R<Vec<u8>> {
    let mut w = W::header(SIGNAL_SPANS, rows.len(), entries.len())?;
    for e in entries {
        w.out.extend_from_slice(&e.resource_fp.to_le_bytes());
        write_attrs(&e.resource, &mut w.out)?;
        w.u16_len(e.scope_name.as_ref().len(), "scope_name")?;
        w.out.extend_from_slice(e.scope_name.as_ref().as_bytes());
        w.u16_len(e.scope_version.as_ref().len(), "scope_version")?;
        w.out.extend_from_slice(e.scope_version.as_ref().as_bytes());
        w.u32_len(e.scope_attrs.as_ref().len(), "scope_attrs")?;
        w.out.extend_from_slice(e.scope_attrs.as_ref().as_bytes());
    }
    let fixed = |w: &mut W, f: &dyn Fn(&Span<S>, &mut Vec<u8>)| {
        w.pad();
        for r in rows {
            f(r, &mut w.out);
        }
    };
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.entry.to_le_bytes()));
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.trace_id));
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.span_id));
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.parent_span_id));
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.start.to_le_bytes()));
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.end.to_le_bytes()));
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.flags.to_le_bytes()));
    fixed(&mut w, &|r, o| {
        for d in r.dropped {
            o.extend_from_slice(&d.to_le_bytes());
        }
    });
    fixed(&mut w, &|r, o| o.push(r.kind));
    fixed(&mut w, &|r, o| o.push(r.status));
    w.var(rows, |r, d| {
        d.extend_from_slice(r.name.as_ref().as_bytes());
        Ok(())
    })?;
    w.var(rows, |r, d| {
        d.extend_from_slice(r.trace_state.as_ref().as_bytes());
        Ok(())
    })?;
    w.var(rows, |r, d| {
        d.extend_from_slice(r.status_message.as_ref().as_bytes());
        Ok(())
    })?;
    w.var(rows, |r, d| write_attrs(&r.attrs, d))?;
    w.var(rows, |r, d| {
        put_u16_len(d, r.events.len(), "event count")?;
        for e in &r.events {
            d.extend_from_slice(&e.time_unix_nano.to_le_bytes());
            put_u16_len(d, e.name.as_ref().len(), "event name")?;
            d.extend_from_slice(e.name.as_ref().as_bytes());
            put_u32_len(d, e.attrs.as_ref().len(), "event attrs")?;
            d.extend_from_slice(e.attrs.as_ref().as_bytes());
        }
        Ok(())
    })?;
    w.var(rows, |r, d| {
        put_u16_len(d, r.links.len(), "link count")?;
        for l in &r.links {
            d.extend_from_slice(&l.trace_id);
            d.extend_from_slice(&l.span_id);
            put_u16_len(d, l.trace_state.as_ref().len(), "link trace_state")?;
            d.extend_from_slice(l.trace_state.as_ref().as_bytes());
            put_u32_len(d, l.attrs.as_ref().len(), "link attrs")?;
            d.extend_from_slice(l.attrs.as_ref().as_bytes());
        }
        Ok(())
    })?;
    w.pad();
    decode_spans(&w.out)?;
    Ok(w.out)
}

fn write_pairs<S: AsRef<str>>(pairs: &[(S, S)], out: &mut Vec<u8>) -> R<()> {
    for (n, v) in pairs {
        put_u16_len(out, n.as_ref().len(), "name")?;
        out.extend_from_slice(n.as_ref().as_bytes());
        put_u16_len(out, v.as_ref().len(), "value")?;
        out.extend_from_slice(v.as_ref().as_bytes());
    }
    Ok(())
}

/// Encode a log-record batch. The result is validated with [`decode_logs`]; `stream_id`
/// values are written as given.
pub fn encode_logs<S: AsRef<str>>(streams: &[LogStream<S>], rows: &[LogRow<S>]) -> R<Vec<u8>> {
    let mut w = W::header(SIGNAL_LOGS, rows.len(), streams.len())?;
    for s in streams {
        w.out.extend_from_slice(&s.stream_id.to_le_bytes());
        w.u32_len(s.labels.len(), "label count")?;
        write_pairs(&s.labels, &mut w.out)?;
    }
    let fixed = |w: &mut W, f: &dyn Fn(&LogRow<S>, &mut Vec<u8>)| {
        w.pad();
        for r in rows {
            f(r, &mut w.out);
        }
    };
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.entry.to_le_bytes()));
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.ts.to_le_bytes()));
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.observed_ts.to_le_bytes()));
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.trace_id));
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.span_id));
    fixed(&mut w, &|r, o| o.extend_from_slice(&r.flags.to_le_bytes()));
    fixed(&mut w, &|r, o| o.push(r.severity_number));
    w.var(rows, |r, d| {
        d.extend_from_slice(r.line.as_ref().as_bytes());
        Ok(())
    })?;
    w.var(rows, |r, d| {
        d.extend_from_slice(r.severity_text.as_ref().as_bytes());
        Ok(())
    })?;
    w.var(rows, |r, d| {
        put_u16_len(d, r.metadata.len(), "metadata count")?;
        write_pairs(&r.metadata, d)
    })?;
    w.pad();
    decode_logs(&w.out)?;
    Ok(w.out)
}

/// Bytes the variable-length values of a span row occupy in its batch.
pub fn span_var_bytes(r: &Span<&str>) -> usize {
    let attrs: usize = 2 + r.attrs.iter().map(attr_bytes).sum::<usize>();
    let events: usize = 2 + r.events.iter().map(|e| 8 + 2 + e.name.len() + 4 + e.attrs.len()).sum::<usize>();
    let links: usize = 2 + r.links.iter().map(|l| 24 + 2 + l.trace_state.len() + 4 + l.attrs.len()).sum::<usize>();
    r.name.len() + r.trace_state.len() + r.status_message.len() + attrs + events + links
}

/// Bytes one attribute occupies in a typed attribute list.
pub fn attr_bytes(a: &Attr<&str>) -> usize {
    2 + a.key.len()
        + 1
        + match &a.value {
            Value::Str(s) | Value::Other(s) => 4 + s.len(),
            Value::Int(_) | Value::Double(_) => 8,
            Value::Bool(_) => 1,
        }
}

/// Bytes a span entry occupies in its batch.
pub fn span_entry_bytes(e: &SpanEntry<&str>) -> usize {
    8 + 2 + e.resource.iter().map(attr_bytes).sum::<usize>() + 2 + e.scope_name.len() + 2 + e.scope_version.len() + 4 + e.scope_attrs.len()
}
