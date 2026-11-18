//! Small shared helpers.
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Hasher for `series_id` keys. The ids are already 64-bit hashes; one multiply-and-fold
/// is enough to spread them over the table and avoids SipHash on the hot path. It needs
/// no random seed, which keeps the crate deterministic.
#[derive(Default, Clone, Copy)]
pub struct IdHasher(u64);

impl Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 ^ *b as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    fn write_i64(&mut self, i: i64) {
        let x = (i as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        self.0 = x ^ (x >> 32);
    }
}

/// Map keyed by `series_id`.
pub type IdMap<V> = HashMap<i64, V, BuildHasherDefault<IdHasher>>;
