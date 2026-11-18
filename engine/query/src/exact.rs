//! Exact, order-independent sums of `f64` values, for aggregations whose result must not
//! depend on how the input is split or ordered.
//!
//! A float sum computed one value at a time depends on the order of the values (Prometheus
//! uses Neumaier's compensated sum, which is accurate but still order dependent). Split
//! execution adds values in a different order than one evaluation over all series, so
//! `sum`, `avg`, `stddev` and `stdvar` are computed here EXACTLY: every finite `f64` is an
//! integer multiple of 2^-1074, so a sum of them is an integer in those units, kept as a
//! big integer, and rounded to the nearest `f64` (ties to even) once, at the end. Adding
//! is associative and commutative, so any split, in any order, gives the same bits.
//!
//! Infinities and NaN follow IEEE 754 as a sequential sum would: any NaN, or both
//! infinities, give NaN; otherwise one infinity gives that infinity. An exact sum that is
//! zero is `+0`. (A sequential sum can overflow to infinity on the way and stay there where
//! the exact sum is finite: `MAX + MAX - MAX` is `MAX` here.)
//!
//! Sizes: a sum of finite values spans at most 2,098 bits (34 words); a sum of squares
//! 4,196 bits (67 words). Words below the lowest non-zero one are not stored, so the
//! typical sum (values within a few powers of two) is two or three words.

use std::cmp::Ordering;

/// A non-negative big integer: `words` little-endian, the first one at word index `lo`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Big {
    lo: u32,
    words: Vec<u64>,
}

/// Words a big integer may span: sums of squares need 67, products in `variance` 134.
const MAX_WORDS: usize = 160;

impl Big {
    /// `(index of the first stored word, the words)`, for encoding.
    pub fn parts(&self) -> (u32, &[u64]) {
        (self.lo, &self.words)
    }

    /// The inverse of [`Big::parts`]; `None` if the number would be wider than any sum can be.
    pub fn from_parts(lo: u32, words: Vec<u64>) -> Option<Big> {
        (lo as usize + words.len() <= MAX_WORDS).then_some(Big { lo, words })
    }

    pub fn is_zero(&self) -> bool {
        self.words.iter().all(|w| *w == 0)
    }

    fn word(&self, i: usize) -> u64 {
        let lo = self.lo as usize;
        if i < lo {
            0
        } else {
            self.words.get(i - lo).copied().unwrap_or(0)
        }
    }

    /// Highest word index + 1 (0 for zero).
    fn top(&self) -> usize {
        let mut n = self.words.len();
        while n > 0 && self.words[n - 1] == 0 {
            n -= 1;
        }
        if n == 0 {
            0
        } else {
            self.lo as usize + n
        }
    }

    /// Make word index `i` addressable.
    fn reach(&mut self, i: usize) {
        if self.words.is_empty() {
            self.lo = i as u32;
            self.words.push(0);
            return;
        }
        let lo = self.lo as usize;
        if i < lo {
            let mut w = vec![0u64; lo - i];
            w.extend_from_slice(&self.words);
            self.words = w;
            self.lo = i as u32;
        } else if i >= lo + self.words.len() {
            self.words.resize(i - lo + 1, 0);
        }
    }

    /// Add `v << bit`.
    pub fn add_shifted(&mut self, v: u128, bit: usize) {
        if v == 0 {
            return;
        }
        let (i, b) = (bit / 64, bit % 64);
        // v < 2^128 shifted by less than 64 bits spans at most three words.
        let low = v << b;
        let high = if b == 0 { 0 } else { (v >> (128 - b)) as u64 };
        let chunks = [low as u64, (low >> 64) as u64, high];
        let mut carry = 0u64;
        let mut k = 0;
        while k < 3 || carry != 0 {
            let c = if k < 3 { chunks[k] } else { 0 };
            if c != 0 || carry != 0 {
                self.reach(i + k);
                let idx = i + k - self.lo as usize;
                let (s1, o1) = self.words[idx].overflowing_add(c);
                let (s2, o2) = s1.overflowing_add(carry);
                self.words[idx] = s2;
                carry = o1 as u64 + o2 as u64;
            }
            k += 1;
        }
    }

    /// `self += other`.
    pub fn add(&mut self, other: &Big) {
        for (k, w) in other.words.iter().enumerate() {
            if *w != 0 {
                self.add_shifted(*w as u128, (other.lo as usize + k) * 64);
            }
        }
    }

    fn cmp_mag(&self, other: &Big) -> Ordering {
        let n = self.top().max(other.top());
        for i in (0..n).rev() {
            match self.word(i).cmp(&other.word(i)) {
                Ordering::Equal => continue,
                o => return o,
            }
        }
        Ordering::Equal
    }

    /// `self - other`, for `self >= other`.
    fn sub(&self, other: &Big) -> Big {
        let n = self.top();
        let lo = (self.lo.min(other.lo)) as usize;
        let mut out = Vec::with_capacity(n.saturating_sub(lo));
        let mut borrow = 0u64;
        for i in lo..n {
            let (d1, b1) = self.word(i).overflowing_sub(other.word(i));
            let (d2, b2) = d1.overflowing_sub(borrow);
            out.push(d2);
            borrow = (b1 as u64) + (b2 as u64);
        }
        Big { lo: lo as u32, words: out }
    }

    /// `self * m` for a small factor.
    fn mul_small(&self, m: u64) -> Big {
        let mut out = Big { lo: self.lo, words: Vec::with_capacity(self.words.len() + 1) };
        let mut carry = 0u128;
        for w in &self.words {
            let p = *w as u128 * m as u128 + carry;
            out.words.push(p as u64);
            carry = p >> 64;
        }
        if carry != 0 {
            out.words.push(carry as u64);
        }
        out
    }

    /// `self * self`.
    fn square(&self) -> Big {
        let n = self.words.len();
        let mut acc = vec![0u64; 2 * n + 1];
        for i in 0..n {
            let mut carry = 0u128;
            for j in 0..n {
                let t = self.words[i] as u128 * self.words[j] as u128 + acc[i + j] as u128 + carry;
                acc[i + j] = t as u64;
                carry = t >> 64;
            }
            let mut k = i + n;
            while carry != 0 {
                let t = acc[k] as u128 + carry;
                acc[k] = t as u64;
                carry = t >> 64;
                k += 1;
            }
        }
        Big { lo: 2 * self.lo, words: acc }
    }

    /// `(self / d, self % d != 0)`.
    fn div_small(&self, d: u64) -> (Big, bool) {
        let top = self.top();
        if top == 0 {
            return (Big::default(), false);
        }
        // Divide the whole number including the implicit zero words below `lo`: those
        // contribute to the quotient once a remainder is carried into them.
        let mut q = vec![0u64; top];
        let mut rem = 0u128;
        for i in (0..top).rev() {
            let cur = (rem << 64) | self.word(i) as u128;
            q[i] = (cur / d as u128) as u64;
            rem = cur % d as u128;
        }
        (Big { lo: 0, words: q }, rem != 0)
    }

    /// Bit `k` of the number.
    fn bit(&self, k: usize) -> bool {
        (self.word(k / 64) >> (k % 64)) & 1 == 1
    }

    /// Any bit below `k` set.
    fn any_below(&self, k: usize) -> bool {
        let (w, b) = (k / 64, k % 64);
        for i in self.lo as usize..w.min(self.top()) {
            if self.word(i) != 0 {
                return true;
            }
        }
        b > 0 && (self.word(w) & ((1u64 << b) - 1)) != 0
    }

    /// Index of the highest set bit, `None` for zero.
    fn high_bit(&self) -> Option<usize> {
        let t = self.top();
        if t == 0 {
            return None;
        }
        let w = self.word(t - 1);
        Some((t - 1) * 64 + 63 - w.leading_zeros() as usize)
    }

    /// Bits `[from, from + n)` as an integer, `n <= 64`.
    fn bits(&self, from: usize, n: usize) -> u64 {
        let (w, b) = (from / 64, from % 64);
        let lo = self.word(w) as u128 | (self.word(w + 1) as u128) << 64;
        let v = (lo >> b) as u64;
        if n == 64 {
            v
        } else {
            v & ((1u64 << n) - 1)
        }
    }

    /// The value `self * 2^exp` (plus something positive and smaller than one unit of the
    /// last place when `sticky`), rounded to the nearest `f64`, ties to even.
    pub fn to_f64(&self, exp: i64, sticky: bool) -> f64 {
        let Some(t) = self.high_bit() else { return 0.0 };
        // The value's binary exponent is t + exp. Normal results keep 53 bits; subnormal
        // ones are on the grid of 2^-1074.
        let t = t as i64;
        let keep_from = if t + exp >= -1022 { t - 52 } else { -1074 - exp };
        if keep_from <= 0 {
            // Exact: shift left.
            let m = self.bits(0, 64) << (-keep_from) as u32;
            return compose(m, exp + keep_from);
        }
        let k = keep_from as usize;
        // Bits above `t` are zero, so this is the kept part whatever its width.
        let mut m = self.bits(k, 53);
        let guard = self.bit(k - 1);
        let rest = sticky || self.any_below(k - 1);
        if guard && (rest || m & 1 == 1) {
            m += 1;
        }
        compose(m, exp + keep_from)
    }
}

/// `m * 2^q` as an `f64`, where `m <= 2^53` and the result is on the `f64` grid.
fn compose(mut m: u64, mut q: i64) -> f64 {
    if m == 0 {
        return 0.0;
    }
    while m >= 1 << 53 {
        // Only reached by rounding up to 2^53, so no bit is lost.
        m >>= 1;
        q += 1;
    }
    while m < 1 << 52 && q > -1074 {
        m <<= 1;
        q -= 1;
    }
    if m < 1 << 52 {
        // Subnormal: q == -1074 and the bits are the mantissa.
        return f64::from_bits(m);
    }
    let e = q + 1075; // biased exponent of m * 2^q with m in [2^52, 2^53)
    if e >= 2047 {
        return f64::INFINITY;
    }
    f64::from_bits(((e as u64) << 52) | (m - (1 << 52)))
}

/// `(mantissa, shift)` of a finite non-zero `|x|`: `|x| = mantissa * 2^(shift - 1074)`.
fn decompose(x: f64) -> (u64, usize) {
    let bits = x.to_bits() & !(1u64 << 63);
    let e = (bits >> 52) as usize;
    let f = bits & ((1u64 << 52) - 1);
    if e == 0 {
        (f, 0)
    } else {
        (f | (1u64 << 52), e - 1)
    }
}

/// Infinities and NaN seen by an accumulator.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Special {
    pub nan: bool,
    pub pos_inf: bool,
    pub neg_inf: bool,
}

impl Special {
    fn merge(&mut self, o: Special) {
        self.nan |= o.nan;
        self.pos_inf |= o.pos_inf;
        self.neg_inf |= o.neg_inf;
    }
    /// The IEEE result of a sum that met these, or `None` if only finite values were added.
    fn result(&self) -> Option<f64> {
        if self.nan || (self.pos_inf && self.neg_inf) {
            Some(f64::NAN)
        } else if self.pos_inf {
            Some(f64::INFINITY)
        } else if self.neg_inf {
            Some(f64::NEG_INFINITY)
        } else {
            None
        }
    }
    fn any(&self) -> bool {
        self.nan || self.pos_inf || self.neg_inf
    }
}

/// The exact sum of `f64` values, in units of 2^-1074, as a positive and a negative part.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExactSum {
    pub pos: Big,
    pub neg: Big,
    pub special: Special,
}

impl ExactSum {
    pub fn add(&mut self, x: f64) {
        if x.is_nan() {
            self.special.nan = true;
        } else if x.is_infinite() {
            if x > 0.0 {
                self.special.pos_inf = true;
            } else {
                self.special.neg_inf = true;
            }
        } else if x != 0.0 {
            let (m, s) = decompose(x);
            if x > 0.0 {
                self.pos.add_shifted(m as u128, s);
            } else {
                self.neg.add_shifted(m as u128, s);
            }
        }
    }

    pub fn merge(&mut self, o: &ExactSum) {
        self.pos.add(&o.pos);
        self.neg.add(&o.neg);
        self.special.merge(o.special);
    }

    /// The finite part as `(negative, magnitude)`.
    fn finite(&self) -> (bool, Big) {
        match self.pos.cmp_mag(&self.neg) {
            Ordering::Less => (true, self.neg.sub(&self.pos)),
            _ => (false, self.pos.sub(&self.neg)),
        }
    }

    /// The sum, correctly rounded. An exact zero is `+0`.
    pub fn value(&self) -> f64 {
        if let Some(v) = self.special.result() {
            return v;
        }
        let (neg, mag) = self.finite();
        let v = mag.to_f64(-1074, false);
        if neg {
            -v
        } else {
            v
        }
    }

    /// The mean of `n` values: the correctly rounded sum divided by `n`; if the rounded sum
    /// overflows, the sum is scaled down by 2^64 first (exactly) and the quotient scaled
    /// back, so a mean of large finite values stays finite.
    pub fn mean(&self, n: u64) -> f64 {
        if let Some(v) = self.special.result() {
            return v;
        }
        let (neg, mag) = self.finite();
        let s = mag.to_f64(-1074, false);
        let v = if s.is_finite() { s / n as f64 } else { mag.to_f64(-1074 - 64, false) / n as f64 * 18446744073709551616.0 };
        if neg {
            -v
        } else {
            v
        }
    }
}

/// Exact `count`, `sum` and `sum of squares`, for `stdvar` and `stddev`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExactVariance {
    pub n: u64,
    pub sum: ExactSum,
    /// Sum of squares in units of 2^-2148.
    pub sq: Big,
}

impl ExactVariance {
    pub fn add(&mut self, x: f64) {
        self.n += 1;
        self.sum.add(x);
        if x.is_finite() && x != 0.0 {
            let (m, s) = decompose(x);
            self.sq.add_shifted(m as u128 * m as u128, 2 * s);
        }
    }

    pub fn merge(&mut self, o: &ExactVariance) {
        self.n += o.n;
        self.sum.merge(&o.sum);
        self.sq.add(&o.sq);
    }

    /// The population variance `(n Σx² - (Σx)²) / n²`, correctly rounded. NaN if any
    /// value was not finite (as Prometheus' running computation gives).
    pub fn variance(&self) -> f64 {
        if self.sum.special.any() || self.n == 0 {
            return f64::NAN;
        }
        let (_, s) = self.sum.finite();
        let num = self.sq.mul_small(self.n);
        let s2 = s.square();
        // n Σx² >= (Σx)² exactly (Cauchy-Schwarz); guard anyway.
        if num.cmp_mag(&s2) != Ordering::Greater {
            return 0.0;
        }
        let d = num.sub(&s2);
        let (q1, r1) = d.div_small(self.n);
        let (q2, r2) = q1.div_small(self.n);
        q2.to_f64(-2148, r1 || r2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sum(xs: &[f64]) -> f64 {
        let mut s = ExactSum::default();
        for x in xs {
            s.add(*x);
        }
        s.value()
    }

    #[test]
    fn rounding_is_exact_on_known_cases() {
        assert_eq!(sum(&[1e100, 1.0, -1e100]), 1.0);
        assert_eq!(sum(&[0.1; 10]), 1.0);
        assert_eq!(sum(&[0.1, 0.2]), 0.30000000000000004);
        assert_eq!(sum(&[f64::MAX, f64::MAX, -f64::MAX]), f64::MAX);
        assert_eq!(sum(&[f64::MAX, f64::MAX]), f64::INFINITY);
        assert_eq!(sum(&[5e-324, 5e-324]), 1e-323);
        assert_eq!(sum(&[-0.0]), 0.0);
        assert_eq!(sum(&[]), 0.0);
        assert!(sum(&[f64::INFINITY, f64::NEG_INFINITY]).is_nan());
        assert_eq!(sum(&[f64::INFINITY, 1.0]), f64::INFINITY);
        assert_eq!(sum(&[2f64.powi(53), 1.0]), 2f64.powi(53)); // tie to even
        assert_eq!(sum(&[2f64.powi(53), 1.0, 1e-300]), 2f64.powi(53) + 2.0); // sticky
        assert_eq!(sum(&[2f64.powi(53) + 2.0, 1.0]), 2f64.powi(53) + 4.0); // tie to even, up
        assert_eq!(sum(&[1.0, -1e-300]), 1.0);
        assert_eq!(sum(&[1.0, -2f64.powi(-54)]), 1.0); // tie to even
        assert_eq!(sum(&[1.0, -2f64.powi(-54), -1e-300]), 1.0 - 2f64.powi(-53));
        let mut m = ExactSum::default();
        for x in [f64::MAX, f64::MAX, f64::MAX] {
            m.add(x);
        }
        assert_eq!(m.mean(3), f64::MAX);
    }

    #[test]
    fn variance_of_small_integers_is_the_rational_value_rounded() {
        let cases: &[&[f64]] = &[&[1.0, 2.0, 3.0, 4.0], &[5.0], &[1.0, 1.0, 1.0], &[0.0, 1e6, 3.0, -7.0, 11.0], &[-3.0, 3.0]];
        for xs in cases {
            let mut v = ExactVariance::default();
            for x in *xs {
                v.add(*x);
            }
            let n = xs.len() as i128;
            let s: i128 = xs.iter().map(|x| *x as i128).sum();
            let q: i128 = xs.iter().map(|x| (*x as i128) * (*x as i128)).sum();
            let want = (n * q - s * s) as f64 / (n * n) as f64; // both exact in f64 here
            assert_eq!(v.variance(), want, "{xs:?}");
        }
        let mut v = ExactVariance::default();
        v.add(f64::INFINITY);
        assert!(v.variance().is_nan());
    }
}
