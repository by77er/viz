//! The `logs` token filter (`contracts/LOGS.md` §6): what a token is, the `VZT1` bytes a
//! compaction output carries between its last row group and its footer, a reader for them, and
//! the tokens a query's required literal implies.
//!
//! The filter is advisory. A reader that cannot parse it, or finds it inconsistent, reads the
//! row group; [`TokenFilter::may_match`] answers `true` whenever it is unsure.

/// The filter's magic.
pub const TOKEN_FILTER_MAGIC: &[u8; 4] = b"VZT1";
/// Key of the footer key-value metadata entry that repeats the filter's place, `"{off},{len}"`.
pub const TOKEN_FILTER_META: &str = "viz.token_filter";
/// A run shorter than this is not a token.
pub const MIN_TOKEN_BYTES: usize = 4;
/// A longer run is cut to its first this many bytes, at a character boundary.
pub const MAX_TOKEN_BYTES: usize = 64;
/// Tokens per block of the filter.
pub const BLOCK_TOKENS: usize = 16;
/// The writer leaves the filter out of a file with more distinct tokens than this (the builder
/// holds about 12 bytes a token besides the tokens, so at most about 15 MB with them).
pub const MAX_FILTER_TOKENS: usize = 1 << 19;
const HEADER: usize = 20;

/// ASCII letters and digits, and every byte of a non-ASCII character.
#[inline]
fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b >= 0x80
}

/// A maximal run cut to at most [`MAX_TOKEN_BYTES`], at a character boundary.
#[inline]
fn cut(run: &[u8]) -> &[u8] {
    if run.len() <= MAX_TOKEN_BYTES {
        return run;
    }
    let mut n = MAX_TOKEN_BYTES;
    while n > 0 && (run[n] & 0xC0) == 0x80 {
        n -= 1;
    }
    &run[..n]
}

/// The maximal runs of token bytes of `b`: `(start, end)`.
fn runs(b: &[u8]) -> impl Iterator<Item = (usize, usize)> + '_ {
    let mut i = 0;
    std::iter::from_fn(move || {
        while i < b.len() && !is_token_byte(b[i]) {
            i += 1;
        }
        if i >= b.len() {
            return None;
        }
        let start = i;
        while i < b.len() && is_token_byte(b[i]) {
            i += 1;
        }
        Some((start, i))
    })
}

/// Calls `f` with every token of `text` in order (repeats included): its maximal runs of ASCII
/// letters, ASCII digits and non-ASCII characters of at least 4 bytes, ASCII-lowercased and cut
/// to 64 bytes at a character boundary.
pub fn for_each_token(text: &str, mut f: impl FnMut(&[u8])) {
    let b = text.as_bytes();
    let mut buf = [0u8; MAX_TOKEN_BYTES];
    for (s, e) in runs(b) {
        if e - s < MIN_TOKEN_BYTES {
            continue;
        }
        let t = cut(&b[s..e]);
        for (o, x) in buf.iter_mut().zip(t) {
            *o = x.to_ascii_lowercase();
        }
        f(&buf[..t.len()]);
    }
}

/// The distinct tokens of `text`, sorted by bytes.
pub fn tokens(text: &str) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    for_each_token(text, |t| out.push(t.to_vec()));
    out.sort();
    out.dedup();
    out
}

/// The tokens a literal implies (`contracts/LOGS.md` §6): its runs that have a non-token
/// character on both sides within the literal, as tokens. A line containing the literal has
/// each of them as a token; the first and last runs may be parts of longer runs of the line.
pub fn literal_tokens(literal: &str) -> Vec<Vec<u8>> {
    let b = literal.as_bytes();
    let mut out = Vec::new();
    for (s, e) in runs(b) {
        if s == 0 || e == b.len() || e - s < MIN_TOKEN_BYTES {
            continue;
        }
        out.push(cut(&b[s..e]).iter().map(u8::to_ascii_lowercase).collect());
    }
    out.sort();
    out.dedup();
    out
}

fn fnv(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for x in b {
        h ^= *x as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Builds one file's filter while its row groups are written: every distinct token once, its
/// bytes in 1 MiB chunks that never move, an open-addressing table over them (at most 3/4 full)
/// and a bitset of the row groups that have it, one byte per 8 row groups. About 12 bytes a
/// token besides the token's own bytes.
pub struct TokenFilterBuilder {
    chunks: Vec<Vec<u8>>,
    /// Token i: its chunk (high 12 bits) and offset in it (low 20 bits).
    at: Vec<u32>,
    lens: Vec<u8>,
    /// Bytes per token in `bits`.
    stride: usize,
    bits: Vec<u8>,
    /// 0 empty, else token index + 1.
    slots: Vec<u32>,
    max_tokens: usize,
    overflow: bool,
}

const ARENA_CHUNK: usize = 1 << 20;

impl Default for TokenFilterBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl TokenFilterBuilder {
    pub fn new() -> TokenFilterBuilder {
        Self::with_max_tokens(MAX_FILTER_TOKENS)
    }

    /// A builder that gives up (no filter) past `max_tokens` distinct tokens.
    pub fn with_max_tokens(max_tokens: usize) -> TokenFilterBuilder {
        TokenFilterBuilder { chunks: Vec::new(), at: Vec::new(), lens: Vec::new(), stride: 1, bits: Vec::new(), slots: vec![0; 1024], max_tokens, overflow: false }
    }

    /// Distinct tokens so far (0 once the bound was passed).
    pub fn len(&self) -> usize {
        self.at.len()
    }

    pub fn is_empty(&self) -> bool {
        self.at.is_empty()
    }

    /// Whether the bound was passed: [`finish`](Self::finish) then gives no filter.
    pub fn overflowed(&self) -> bool {
        self.overflow
    }

    fn token(&self, i: usize) -> &[u8] {
        let (c, o) = ((self.at[i] >> 20) as usize, (self.at[i] & (ARENA_CHUNK as u32 - 1)) as usize);
        &self.chunks[c][o..o + self.lens[i] as usize]
    }

    /// The tokens of `text` are in row group `rg`.
    pub fn add_text(&mut self, rg: usize, text: &str) {
        if self.overflow {
            return;
        }
        for_each_token(text, |t| self.add(rg, t));
    }

    /// Token `t` (already a token: lowercased and cut) is in row group `rg`.
    pub fn add(&mut self, rg: usize, t: &[u8]) {
        if self.overflow {
            return;
        }
        if rg >= self.stride * 8 {
            self.widen(rg / 8 + 1);
        }
        let mask = self.slots.len() - 1;
        let mut i = fnv(t) as usize & mask;
        loop {
            match self.slots[i] {
                0 => break,
                s => {
                    let k = s as usize - 1;
                    if self.token(k) == t {
                        self.bits[k * self.stride + rg / 8] |= 1 << (rg % 8);
                        return;
                    }
                    i = (i + 1) & mask;
                }
            }
        }
        if self.at.len() >= self.max_tokens || self.chunks.len() >= 1 << 12 {
            // Past the bound: free everything; the file gets no filter.
            *self = TokenFilterBuilder { chunks: Vec::new(), at: Vec::new(), lens: Vec::new(), stride: 1, bits: Vec::new(), slots: vec![0; 1], max_tokens: self.max_tokens, overflow: true };
            return;
        }
        if self.chunks.last().is_none_or(|c| c.len() + t.len() > ARENA_CHUNK) {
            self.chunks.push(Vec::with_capacity(ARENA_CHUNK));
        }
        let c = self.chunks.len() - 1;
        let chunk = &mut self.chunks[c];
        self.at.push(((c as u32) << 20) | chunk.len() as u32);
        chunk.extend_from_slice(t);
        self.lens.push(t.len() as u8);
        let k = self.at.len() - 1;
        self.bits.resize(self.bits.len() + self.stride, 0);
        self.bits[k * self.stride + rg / 8] |= 1 << (rg % 8);
        self.slots[i] = k as u32 + 1;
        if self.at.len() * 4 > self.slots.len() * 3 {
            self.rehash();
        }
    }

    fn widen(&mut self, stride: usize) {
        let mut bits = vec![0u8; self.at.len() * stride];
        for k in 0..self.at.len() {
            bits[k * stride..k * stride + self.stride].copy_from_slice(&self.bits[k * self.stride..(k + 1) * self.stride]);
        }
        self.bits = bits;
        self.stride = stride;
    }

    fn rehash(&mut self) {
        let n = self.slots.len() * 2;
        self.slots = vec![0u32; 0];
        let mut slots = vec![0u32; n];
        for k in 0..self.at.len() {
            let mut i = fnv(self.token(k)) as usize & (n - 1);
            while slots[i] != 0 {
                i = (i + 1) & (n - 1);
            }
            slots[i] = k as u32 + 1;
        }
        self.slots = slots;
    }

    /// The filter's bytes for a file of `n_row_groups` row groups, or `None` past the bound.
    pub fn finish(self, n_row_groups: usize) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        self.write(n_row_groups, &mut out).expect("writing to a Vec does not fail").map(|_| out)
    }

    /// Write the filter's bytes to `w` in pieces of at most 64 KiB (so a writer never holds the
    /// whole filter twice): its length, or `None` past the bound (nothing written).
    pub fn write(mut self, n_row_groups: usize, w: &mut dyn std::io::Write) -> std::io::Result<Option<usize>> {
        if self.overflow {
            return Ok(None);
        }
        self.slots = Vec::new();
        let n = self.at.len();
        let mut order: Vec<u32> = (0..n as u32).collect();
        order.sort_unstable_by(|a, b| self.token(*a as usize).cmp(self.token(*b as usize)));
        let shared = |j: usize| -> usize {
            if j % BLOCK_TOKENS == 0 {
                0
            } else {
                let (p, t) = (self.token(order[j - 1] as usize), self.token(order[j] as usize));
                p.iter().zip(t).take_while(|(a, b)| a == b).count()
            }
        };
        // Block offsets first: the sizes of the encoded tokens.
        let n_blocks = n.div_ceil(BLOCK_TOKENS);
        let stride = n_row_groups.div_ceil(8);
        let mut offs: Vec<u8> = Vec::with_capacity(4 * n_blocks);
        let mut at = 0usize;
        for j in 0..n {
            if j % BLOCK_TOKENS == 0 {
                offs.extend_from_slice(&(at as u32).to_le_bytes());
            }
            at += 2 + self.lens[order[j] as usize] as usize - shared(j);
        }
        let total = HEADER + offs.len() + at + n * stride;
        let mut buf: Vec<u8> = Vec::with_capacity(64 << 10);
        buf.extend_from_slice(TOKEN_FILTER_MAGIC);
        for v in [n_row_groups as u32, n as u32, n_blocks as u32, 0] {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        w.write_all(&buf)?;
        w.write_all(&offs)?;
        drop(offs);
        buf.clear();
        for j in 0..n {
            let t = self.token(order[j] as usize);
            let s = shared(j);
            buf.push(s as u8);
            buf.push((t.len() - s) as u8);
            buf.extend_from_slice(&t[s..]);
            if buf.len() > (64 << 10) - 130 {
                w.write_all(&buf)?;
                buf.clear();
            }
        }
        for &k in &order {
            let row = &self.bits[k as usize * self.stride..(k as usize + 1) * self.stride];
            let take = stride.min(row.len());
            buf.extend_from_slice(&row[..take]);
            buf.extend(std::iter::repeat_n(0u8, stride - take));
            if buf.len() > (64 << 10) - stride {
                w.write_all(&buf)?;
                buf.clear();
            }
        }
        w.write_all(&buf)?;
        Ok(Some(total))
    }
}

/// A parsed filter, borrowing its bytes.
#[derive(Debug, Clone, Copy)]
pub struct TokenFilter<'a> {
    n_row_groups: usize,
    n_tokens: usize,
    block_off: &'a [u8],
    blocks: &'a [u8],
    bits: &'a [u8],
    stride: usize,
}

fn u32_at(b: &[u8], at: usize) -> usize {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap()) as usize
}

impl<'a> TokenFilter<'a> {
    /// Check the header and the sizes; tokens are checked as they are read.
    pub fn parse(b: &'a [u8]) -> Result<TokenFilter<'a>, String> {
        if b.len() < HEADER || &b[..4] != TOKEN_FILTER_MAGIC {
            return Err("not a VZT1 token filter".into());
        }
        let (n_rg, n, n_blocks) = (u32_at(b, 4), u32_at(b, 8), u32_at(b, 12));
        if u32_at(b, 16) != 0 {
            return Err("reserved field is not 0".into());
        }
        if n_blocks != n.div_ceil(BLOCK_TOKENS) {
            return Err(format!("{n_blocks} blocks for {n} tokens"));
        }
        let stride = n_rg.div_ceil(8);
        let bits_len = n.checked_mul(stride).ok_or("bitsets overflow")?;
        let head = HEADER + 4 * n_blocks;
        if head.checked_add(bits_len).is_none_or(|x| x > b.len()) {
            return Err("filter shorter than its tables".into());
        }
        let blocks = &b[head..b.len() - bits_len];
        let block_off = &b[HEADER..head];
        let mut last = None;
        for k in 0..n_blocks {
            let o = u32_at(block_off, 4 * k);
            if (k == 0 && o != 0) || last.is_some_and(|l| o <= l) || o >= blocks.len() {
                return Err(format!("block offset {k} out of order or range"));
            }
            last = Some(o);
        }
        if n == 0 && !blocks.is_empty() {
            return Err("blocks without tokens".into());
        }
        Ok(TokenFilter { n_row_groups: n_rg, n_tokens: n, block_off, blocks, bits: &b[b.len() - bits_len..], stride })
    }

    pub fn n_row_groups(&self) -> usize {
        self.n_row_groups
    }

    pub fn n_tokens(&self) -> usize {
        self.n_tokens
    }

    fn block_end(&self, k: usize) -> usize {
        if k + 1 < self.block_off.len() / 4 {
            u32_at(self.block_off, 4 * (k + 1))
        } else {
            self.blocks.len()
        }
    }

    /// The tokens of block `k` with their indexes, checked (prefix lengths, bounds, order).
    fn block(&self, k: usize) -> Result<Vec<(usize, Vec<u8>)>, String> {
        let (mut at, end) = (u32_at(self.block_off, 4 * k), self.block_end(k));
        let first = k * BLOCK_TOKENS;
        let count = BLOCK_TOKENS.min(self.n_tokens - first);
        let mut out: Vec<(usize, Vec<u8>)> = Vec::with_capacity(count);
        for j in 0..count {
            if at + 2 > end {
                return Err(format!("block {k} truncated"));
            }
            let (shared, suffix) = (self.blocks[at] as usize, self.blocks[at + 1] as usize);
            at += 2;
            if at + suffix > end || (j == 0 && shared != 0) || out.last().is_some_and(|p| shared > p.1.len()) || shared + suffix > MAX_TOKEN_BYTES {
                return Err(format!("block {k}: bad token {j}"));
            }
            let mut t = out.last().map_or(Vec::new(), |p| p.1[..shared].to_vec());
            t.extend_from_slice(&self.blocks[at..at + suffix]);
            at += suffix;
            if out.last().is_some_and(|p| p.1 >= t) {
                return Err(format!("block {k}: tokens out of order"));
            }
            out.push((first + j, t));
        }
        if at != end {
            return Err(format!("block {k} has {} trailing bytes", end - at));
        }
        Ok(out)
    }

    /// The row-group bitset of `token`, or `None` when no row group has it.
    pub fn lookup(&self, token: &[u8]) -> Result<Option<&'a [u8]>, String> {
        let n_blocks = self.block_off.len() / 4;
        if n_blocks == 0 {
            return Ok(None);
        }
        // The last block whose first token is <= `token`.
        let first = |k: usize| -> Result<&'a [u8], String> {
            let at = u32_at(self.block_off, 4 * k);
            let end = self.block_end(k);
            if at + 2 > end || self.blocks[at] != 0 || at + 2 + self.blocks[at + 1] as usize > end {
                return Err(format!("block {k}: bad first token"));
            }
            Ok(&self.blocks[at + 2..at + 2 + self.blocks[at + 1] as usize])
        };
        let (mut lo, mut hi) = (0usize, n_blocks);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if first(mid)? <= token {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo == 0 {
            return Ok(None);
        }
        for (i, t) in self.block(lo - 1)? {
            if t.as_slice() == token {
                return Ok(Some(&self.bits[i * self.stride..(i + 1) * self.stride]));
            }
        }
        Ok(None)
    }

    /// Whether row group `rg` has `token`.
    pub fn has(&self, token: &[u8], rg: usize) -> Result<bool, String> {
        if rg >= self.n_row_groups {
            return Err(format!("row group {rg} of {}", self.n_row_groups));
        }
        Ok(self.lookup(token)?.is_some_and(|b| b[rg / 8] & (1 << (rg % 8)) != 0))
    }

    /// Whether row group `rg` may hold a line that satisfies every clause of `required` (each
    /// clause an OR of literals, `contracts/LOGS.md` §6). `false` only when some clause has no
    /// literal that can be present: each of its literals implies a token the row group lacks.
    /// A literal that implies no token, and any doubt about the filter, answer `true`.
    pub fn may_match(&self, rg: usize, required: &[Vec<String>]) -> bool {
        if rg >= self.n_row_groups {
            return true;
        }
        let present = |lit: &str| -> bool { literal_tokens(lit).iter().all(|t| self.has(t, rg).unwrap_or(true)) };
        required.iter().all(|clause| clause.iter().any(|lit| present(lit)))
    }

    /// Every token with the row groups that have it, in order (tests and tools).
    pub fn entries(&self) -> Result<Vec<(Vec<u8>, Vec<usize>)>, String> {
        let mut out = Vec::with_capacity(self.n_tokens);
        for k in 0..self.block_off.len() / 4 {
            for (i, t) in self.block(k)? {
                if out.last().is_some_and(|p: &(Vec<u8>, Vec<usize>)| p.0 >= t) {
                    return Err("tokens out of order across blocks".into());
                }
                let b = &self.bits[i * self.stride..(i + 1) * self.stride];
                out.push((t, (0..self.n_row_groups).filter(|g| b[g / 8] & (1 << (g % 8)) != 0).collect()));
            }
        }
        Ok(out)
    }
}

/// Where a `logs` file's filter is, from its footer metadata (`viz.token_filter`), or `None`.
pub fn token_filter_location(file: &[u8]) -> Option<(u64, u64)> {
    use parquet::file::reader::{FileReader, SerializedFileReader};
    let r = SerializedFileReader::new(bytes::Bytes::copy_from_slice(file)).ok()?;
    let kv = r.metadata().file_metadata().key_value_metadata()?;
    let v = kv.iter().find(|k| k.key == TOKEN_FILTER_META)?.value.as_deref()?;
    let (o, l) = v.split_once(',')?;
    Some((o.parse().ok()?, l.parse().ok()?))
}
