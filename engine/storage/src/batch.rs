//! The `VZB1` batch format (contracts/BATCH.md): decode, encode, `series_id`.
//!
//! Decoding borrows from the input and never panics: any byte string either decodes or
//! returns a [`BatchError`]. Decoding is strict, so for every input that decodes,
//! `encode(decode(bytes)) == bytes`.
//!
//! Checks performed, in order: magic, header length, signal, flags, reserved, the
//! both-or-neither-empty rule, then each series entry (bounds, UTF-8, non-empty name and
//! value, the label limits, no NUL byte, strictly ascending names, `__name__` present),
//! padding bytes, column bounds, trailing bytes, every row's series index, and finally
//! every row's timestamp (0 to 253,402,300,799,999). The 1 MiB size cap of a stored batch
//! is the shard's to enforce (`Shard.append` answers `too_large`); it is not checked here.
//!
//! `series_id` is *not* recomputed on decode: the contract says only `edge` computes it
//! and everything downstream trusts it. [`Batch::series_ids_consistent`] is there for tools.

pub use crate::error::BatchError;

/// The four magic bytes.
pub const MAGIC: [u8; 4] = *b"VZB1";
/// `signal` value for metrics.
pub const SIGNAL_METRICS: u8 = 1;
/// Bits of the Prometheus staleness marker NaN.
pub const STALE_NAN_BITS: u64 = 0x7ff0_0000_0000_0002;
/// The label that holds the metric name.
pub const NAME_LABEL: &str = "__name__";

/// Label limits of contracts/BATCH.md.
pub const MAX_LABELS: u32 = 128;
pub const MAX_LABEL_NAME_BYTES: usize = 1024;
pub const MAX_LABEL_VALUE_BYTES: usize = 8192;
/// Timestamps are Unix milliseconds in the years 1970 to 9999, so a UTC day is `YYYY-MM-DD`.
pub const MIN_TS: i64 = 0;
pub const MAX_TS: i64 = 253_402_300_799_999;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a 64 over `name 0x00 value 0x00` for each label, as a signed integer.
///
/// `labels` must already be sorted by name with empty-valued labels removed; this function
/// hashes exactly what it is given, in the order given.
pub fn series_id<N: AsRef<str>, V: AsRef<str>>(labels: &[(N, V)]) -> i64 {
    let mut h = FNV_OFFSET;
    let mut eat = |bytes: &[u8]| {
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(FNV_PRIME);
        }
        h ^= 0;
        h = h.wrapping_mul(FNV_PRIME);
    };
    for (n, v) in labels {
        eat(n.as_ref().as_bytes());
        eat(v.as_ref().as_bytes());
    }
    h as i64
}

/// One series table entry, borrowing from the batch bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Series<'a> {
    pub series_id: i64,
    /// Sorted by name, names unique, values non-empty, includes `__name__`.
    pub labels: Vec<(&'a str, &'a str)>,
    name_at: u32,
}

impl<'a> Series<'a> {
    /// The value of `__name__`.
    pub fn metric_name(&self) -> &'a str {
        self.labels[self.name_at as usize].1
    }
}

/// A decoded batch. Rows are in arrival order.
#[derive(Debug, Clone)]
pub struct Batch<'a> {
    series: Vec<Series<'a>>,
    n_rows: usize,
    idx: &'a [u8],
    ts: &'a [u8],
    val: &'a [u8],
}

impl<'a> Batch<'a> {
    pub fn n_rows(&self) -> usize {
        self.n_rows
    }
    pub fn series(&self) -> &[Series<'a>] {
        &self.series
    }
    /// Index into [`Batch::series`] for row `i`. Always in range. Panics if `i >= n_rows`.
    #[inline]
    pub fn series_idx(&self, i: usize) -> u32 {
        u32::from_le_bytes(self.idx[i * 4..i * 4 + 4].try_into().unwrap())
    }
    /// Unix milliseconds of row `i`.
    #[inline]
    pub fn ts(&self, i: usize) -> i64 {
        i64::from_le_bytes(self.ts[i * 8..i * 8 + 8].try_into().unwrap())
    }
    /// The raw IEEE 754 bits of row `i`'s value.
    #[inline]
    pub fn value_bits(&self, i: usize) -> u64 {
        u64::from_le_bytes(self.val[i * 8..i * 8 + 8].try_into().unwrap())
    }
    #[inline]
    pub fn value(&self, i: usize) -> f64 {
        f64::from_bits(self.value_bits(i))
    }
    /// True if every entry's `series_id` equals [`series_id`] of its labels.
    pub fn series_ids_consistent(&self) -> bool {
        self.series.iter().all(|s| series_id(&s.labels) == s.series_id)
    }
}

struct Cur<'a> {
    b: &'a [u8],
    at: usize,
}
impl<'a> Cur<'a> {
    fn take(&mut self, n: u64, what: &'static str) -> Result<&'a [u8], BatchError> {
        let len = self.b.len() as u64;
        let end = self.at as u64 + n; // at <= len <= usize::MAX and n <= 2^35: no overflow in u64
        if end > len {
            return Err(BatchError::Truncated { what, needed: end, len });
        }
        let s = &self.b[self.at..end as usize];
        self.at = end as usize;
        Ok(s)
    }
    fn u16(&mut self, what: &'static str) -> Result<u16, BatchError> {
        Ok(u16::from_le_bytes(self.take(2, what)?.try_into().unwrap()))
    }
    fn u32(&mut self, what: &'static str) -> Result<u32, BatchError> {
        Ok(u32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }
    fn i64(&mut self, what: &'static str) -> Result<i64, BatchError> {
        Ok(i64::from_le_bytes(self.take(8, what)?.try_into().unwrap()))
    }
    fn pad8(&mut self) -> Result<(), BatchError> {
        let n = (8 - self.at % 8) % 8;
        let start = self.at;
        let p = self.take(n as u64, "padding")?;
        match p.iter().position(|b| *b != 0) {
            Some(i) => Err(BatchError::NonZeroPadding { offset: (start + i) as u64 }),
            None => Ok(()),
        }
    }
}

/// Decode and validate one batch.
pub fn decode(bytes: &[u8]) -> Result<Batch<'_>, BatchError> {
    let head = bytes.len().min(4);
    if bytes[..head] != MAGIC[..head] {
        return Err(BatchError::BadMagic);
    }
    let mut c = Cur { b: bytes, at: 0 };
    let hdr = c.take(16, "header")?;
    if hdr[4] != SIGNAL_METRICS {
        return Err(BatchError::UnsupportedSignal(hdr[4]));
    }
    if hdr[5] != 0 {
        return Err(BatchError::BadFlags(hdr[5]));
    }
    let reserved = u16::from_le_bytes([hdr[6], hdr[7]]);
    if reserved != 0 {
        return Err(BatchError::BadReserved(reserved));
    }
    let n_rows = u32::from_le_bytes(hdr[8..12].try_into().unwrap());
    let n_series = u32::from_le_bytes(hdr[12..16].try_into().unwrap());
    if (n_rows == 0) != (n_series == 0) {
        return Err(BatchError::EmptyMismatch { n_rows, n_series });
    }

    // An entry is at least 12 bytes, so never reserve more than the input could hold.
    let mut series = Vec::with_capacity((n_series as usize).min(bytes.len() / 12));
    for si in 0..n_series {
        let series_id = c.i64("series_id")?;
        let n_labels = c.u32("n_labels")?;
        if n_labels > MAX_LABELS {
            return Err(BatchError::TooManyLabels { series: si, n_labels });
        }
        let mut labels: Vec<(&str, &str)> = Vec::with_capacity((n_labels as usize).min(64));
        let mut name_at = None;
        for li in 0..n_labels {
            let nl = c.u16("label name length")?;
            let name = c.take(nl as u64, "label name")?;
            let vl = c.u16("label value length")?;
            let value = c.take(vl as u64, "label value")?;
            if name.len() > MAX_LABEL_NAME_BYTES || value.len() > MAX_LABEL_VALUE_BYTES {
                return Err(BatchError::LabelTooLong { series: si });
            }
            if name.contains(&0) || value.contains(&0) {
                return Err(BatchError::NulInLabel { series: si });
            }
            let name = std::str::from_utf8(name).map_err(|_| BatchError::InvalidUtf8 { series: si })?;
            let value = std::str::from_utf8(value).map_err(|_| BatchError::InvalidUtf8 { series: si })?;
            if name.is_empty() {
                return Err(BatchError::EmptyLabelName { series: si });
            }
            if value.is_empty() {
                return Err(BatchError::EmptyLabelValue { series: si });
            }
            if let Some((prev, _)) = labels.last() {
                match prev.as_bytes().cmp(name.as_bytes()) {
                    std::cmp::Ordering::Less => {}
                    std::cmp::Ordering::Equal => return Err(BatchError::DuplicateLabel { series: si }),
                    std::cmp::Ordering::Greater => return Err(BatchError::UnsortedLabels { series: si }),
                }
            }
            if name == NAME_LABEL {
                name_at = Some(li);
            }
            labels.push((name, value));
        }
        let name_at = name_at.ok_or(BatchError::MissingName { series: si })?;
        series.push(Series { series_id, labels, name_at });
    }

    c.pad8()?;
    let idx = c.take(4 * n_rows as u64, "series_idx column")?;
    c.pad8()?;
    let ts = c.take(8 * n_rows as u64, "ts column")?;
    let val = c.take(8 * n_rows as u64, "value column")?;
    if c.at != bytes.len() {
        return Err(BatchError::TrailingBytes { expected: c.at as u64, len: bytes.len() as u64 });
    }
    for (row, ch) in idx.chunks_exact(4).enumerate() {
        let index = u32::from_le_bytes(ch.try_into().unwrap());
        if index >= n_series {
            return Err(BatchError::SeriesIndexOutOfRange { row: row as u32, index, n_series });
        }
    }
    for (row, ch) in ts.chunks_exact(8).enumerate() {
        let t = i64::from_le_bytes(ch.try_into().unwrap());
        if !(MIN_TS..=MAX_TS).contains(&t) {
            return Err(BatchError::TimestampOutOfRange { row: row as u32, ts: t });
        }
    }
    Ok(Batch { series, n_rows: n_rows as usize, idx, ts, val })
}

/// An owned series table entry, for encoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeriesDef {
    pub series_id: i64,
    pub labels: Vec<(String, String)>,
}

impl SeriesDef {
    /// Canonicalise labels the way `edge` does (drop empty values, sort by name) and
    /// compute the `series_id`. Duplicate names and a missing `__name__` are left for
    /// [`encode`] to reject.
    pub fn new<N: Into<String>, V: Into<String>>(labels: impl IntoIterator<Item = (N, V)>) -> SeriesDef {
        let mut labels: Vec<(String, String)> =
            labels.into_iter().map(|(n, v)| (n.into(), v.into())).filter(|(_, v)| !v.is_empty()).collect();
        labels.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        SeriesDef { series_id: series_id(&labels), labels }
    }
}

/// An owned row, for encoding.
#[derive(Debug, Clone, Copy)]
pub struct Row {
    pub series_idx: u32,
    pub ts: i64,
    /// Raw IEEE 754 bits, so NaN payloads cannot be disturbed on the way in.
    pub value_bits: u64,
}

impl Row {
    pub fn new(series_idx: u32, ts: i64, value: f64) -> Row {
        Row { series_idx, ts, value_bits: value.to_bits() }
    }
}

/// Encode a batch. The result is validated with [`decode`], so anything `encode` returns
/// decodes, and the same rules apply (sorted unique labels, `__name__`, indexes in range).
/// `series_id` values are written as given.
pub fn encode(series: &[SeriesDef], rows: &[Row]) -> Result<Vec<u8>, BatchError> {
    let n_rows = u32::try_from(rows.len()).map_err(|_| BatchError::TooLarge)?;
    let n_series = u32::try_from(series.len()).map_err(|_| BatchError::TooLarge)?;
    let mut out = Vec::with_capacity(32 + series.len() * 64 + rows.len() * 20);
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&[SIGNAL_METRICS, 0, 0, 0]);
    out.extend_from_slice(&n_rows.to_le_bytes());
    out.extend_from_slice(&n_series.to_le_bytes());
    for (si, s) in series.iter().enumerate() {
        let si = si as u32;
        out.extend_from_slice(&s.series_id.to_le_bytes());
        let n_labels = u32::try_from(s.labels.len()).map_err(|_| BatchError::TooLarge)?;
        out.extend_from_slice(&n_labels.to_le_bytes());
        for (n, v) in &s.labels {
            for part in [n, v] {
                let l = u16::try_from(part.len()).map_err(|_| BatchError::LabelTooLong { series: si })?;
                out.extend_from_slice(&l.to_le_bytes());
                out.extend_from_slice(part.as_bytes());
            }
        }
    }
    let pad = |out: &mut Vec<u8>| out.resize(out.len().div_ceil(8) * 8, 0);
    pad(&mut out);
    for r in rows {
        out.extend_from_slice(&r.series_idx.to_le_bytes());
    }
    pad(&mut out);
    for r in rows {
        out.extend_from_slice(&r.ts.to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.value_bits.to_le_bytes());
    }
    decode(&out)?;
    Ok(out)
}
